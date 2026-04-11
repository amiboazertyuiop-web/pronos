#!/usr/bin/env node
/*
 * analyse-pronos.js — fills in analyses + market picks for every prono
 * --------------------------------------------------------------------
 * Reads pronos.json, finds every prono with an empty `analyse` field, sends
 * each one to Claude Haiku 4.5 with its stats + markets context, parses the
 * returned JSON (analyse + pick + confiance) and writes the updated prono
 * back to pronos.json. Run this right after scripts/generate-pronos.js.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/analyse-pronos.js
 *
 * Token budget (Haiku 4.5 @ $1/M input, $5/M output):
 *   - ~2000 input + 300 output per prono
 *   - 55 pronos/run → ~$0.20/run → ~$6/month
 */

const fs = require('fs');
const path = require('path');

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) { console.error('ERROR: ANTHROPIC_API_KEY env var not set'); process.exit(1); }

const MODEL = 'claude-haiku-4-5-20251001';
const JSON_PATH = path.join(__dirname, '..', 'pronos.json');
const API_URL = 'https://api.anthropic.com/v1/messages';

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `Tu es un expert en paris sportifs qui écrit des analyses profondes et factuelles en français pour le site "Le Coach Parie".

RÈGLES POUR LES ANALYSES :
- N'invoque JAMAIS la cote du bookmaker comme raison. Interdit : "favori à 1.48, proba implicite 67%"
- Utilise le champ stats.recent_matches (quand présent) pour extraire des faits réels : forme, victoires/défaites, buts marqués/encaissés, clean sheets, tendances, et H2H quand les deux équipes apparaissent ensemble dans une entrée
- Complète avec ta connaissance générale des équipes/joueurs/combattants : forces, entraîneur, style de jeu, avantage du stade, contexte de saison
- Sois spécifique et concret, jamais générique
- Écris en FRANÇAIS, 4 à 7 phrases

RÈGLES DE SÉLECTION DE MARCHÉ (pour le foot, quand markets est disponible) :
Choisis LE MEILLEUR pari unique parmi tous les marchés :
- Deux équipes offensives en forme → btts.yes ou over_under.2.5.over
- Équipes défensives, 0-0 plausible → over_under.2.5.under ou btts.no
- Favori clair mais nul possible → double_chance.1X (ou X2 pour l'extérieur)
- Gros favori contre équipe faible → 1x2.home ou 1x2.away selon confiance
- Match indécis → préfère btts ou over_under plutôt que 1X2
- Cote RETENUE doit être ≥ 1.25
- confiance ≤ 4 sauf pick vraiment écrasant (5 réservé à l'exceptionnel)

Pour NBA/UFC/Tennis (pas de markets, seulement cotes 1X2) → pick_category reste "1x2".

FORMAT DE RÉPONSE : uniquement un JSON valide, sans aucun markdown, sans préambule. Schéma exact :
{
  "analyse": "4-7 phrases en français",
  "pick_category": "1x2" | "dc" | "ou" | "btts" | "dnb",
  "pari": "Label français lisible du pari",
  "cote_retenue": nombre (doit correspondre à une cote du champ markets ou cotes),
  "confiance": entier 1-5,
  "prono": "win-home" | "win-away" | "draw"
}

Pour les picks non-1X2 (ou/btts/dc) : mets prono = "win-home" comme placeholder neutre (l'UI colore par pick_category, pas par prono).`;

function buildUserPrompt(prono, sportLabel, leagueLabel) {
  const lines = [];
  lines.push(`Sport : ${sportLabel}`);
  if (leagueLabel) lines.push(`Compétition : ${leagueLabel}`);
  lines.push(`Match : ${prono.match}`);
  lines.push(`Coup d'envoi : ${prono.time_display || prono.commence_time}`);
  lines.push('');

  if (prono.markets) {
    lines.push('Marchés disponibles :');
    lines.push(JSON.stringify(prono.markets, null, 2));
    lines.push('');
  } else if (prono.cotes) {
    lines.push('Cotes 1X2 :');
    lines.push(JSON.stringify(prono.cotes, null, 2));
    lines.push('');
  }

  if (prono.stats && Array.isArray(prono.stats.recent_matches) && prono.stats.recent_matches.length) {
    lines.push('Derniers matchs impliquant une des deux équipes (mix forme + H2H, 15 plus récents) :');
    for (const m of prono.stats.recent_matches) {
      const date = m.timestamp ? new Date(m.timestamp * 1000).toISOString().slice(0, 10) : '?';
      lines.push(`- ${date} [${m.tournament || '?'}] ${m.home || '?'} ${m.score || '?'} ${m.away || '?'}`);
    }
    lines.push('');
  }

  lines.push(`Analyse ce match et choisis le meilleur pari. Réponds uniquement par un JSON valide conforme au schéma système.`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// API call + parsing
// ---------------------------------------------------------------------------
async function callClaude(userPrompt) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 800,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

function extractJson(text) {
  // Strip markdown fences if Claude added them (shouldn't but just in case)
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  cleaned = cleaned.trim();
  // Find first { and last } in case there's a preamble
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('no JSON object found in response');
  return JSON.parse(cleaned.slice(start, end + 1));
}

const VALID_CATEGORIES = new Set(['1x2', 'dc', 'ou', 'btts', 'dnb']);
const VALID_PRONOS = new Set(['win-home', 'win-away', 'draw']);

function validateResponse(parsed) {
  if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
  if (!parsed.analyse || typeof parsed.analyse !== 'string') throw new Error('missing analyse');
  if (!VALID_CATEGORIES.has(parsed.pick_category)) throw new Error('invalid pick_category');
  if (!parsed.pari || typeof parsed.pari !== 'string') throw new Error('missing pari');
  if (typeof parsed.cote_retenue !== 'number' || !isFinite(parsed.cote_retenue)) throw new Error('invalid cote_retenue');
  if (!Number.isInteger(parsed.confiance) || parsed.confiance < 1 || parsed.confiance > 5) throw new Error('invalid confiance');
  if (!VALID_PRONOS.has(parsed.prono)) throw new Error('invalid prono');
  return parsed;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('→ analyse-pronos: loading pronos.json');
  const data = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));

  const queue = [];
  for (const [sportKey, sport] of Object.entries(data.sports || {})) {
    const sportLabel = sport.label || sportKey;
    for (const league of sport.leagues || []) {
      for (const p of league.pronos || []) {
        if (!p.analyse || String(p.analyse).trim() === '') {
          queue.push({ p, sportLabel, leagueLabel: league.label });
        }
      }
    }
  }

  if (!queue.length) {
    console.log('  no empty-analyse pronos to process, nothing to do');
    return;
  }
  console.log(`  ${queue.length} pronos to analyse`);

  let okCount = 0, errCount = 0;
  let totalIn = 0, totalOut = 0;

  for (let i = 0; i < queue.length; i++) {
    const { p, sportLabel, leagueLabel } = queue[i];
    const idx = String(i + 1).padStart(2, ' ');
    process.stdout.write(`  [${idx}/${queue.length}] ${p.match.slice(0, 45).padEnd(45)} `);
    try {
      const userPrompt = buildUserPrompt(p, sportLabel, leagueLabel);
      const resp = await callClaude(userPrompt);
      const text = resp.content && resp.content[0] && resp.content[0].text;
      if (!text) throw new Error('empty response text');
      const parsed = validateResponse(extractJson(text));
      // Write back
      p.analyse = parsed.analyse;
      p.pick_category = parsed.pick_category;
      p.pari = parsed.pari;
      p.cote_retenue = parsed.cote_retenue;
      p.confiance = parsed.confiance;
      p.prono = parsed.prono;
      totalIn += resp.usage.input_tokens || 0;
      totalOut += resp.usage.output_tokens || 0;
      okCount++;
      process.stdout.write(`→ ${parsed.pick_category.padEnd(5)} ${String(parsed.cote_retenue).padStart(5)} ⭐${parsed.confiance}\n`);
    } catch (e) {
      errCount++;
      process.stdout.write(`✗ ${e.message.slice(0, 80)}\n`);
    }
    // Small throttle to stay polite with the API
    await new Promise((r) => setTimeout(r, 150));
  }

  const cost = (totalIn / 1_000_000) * 1 + (totalOut / 1_000_000) * 5;
  console.log(`\n✓ ${okCount} analysed, ${errCount} failed`);
  console.log(`  tokens: ${totalIn} in / ${totalOut} out  ≈ $${cost.toFixed(4)} (Haiku 4.5 pricing)`);

  // Recompute coup-de-cœur after the agent may have overridden picks/confidence.
  // Keep the script's initial selection logic: cote >= 1.25, sorted by confiance
  // DESC then cote DESC, top 10.
  const allPronos = [];
  for (const sport of Object.values(data.sports || {})) {
    for (const league of sport.leagues || []) {
      for (const p of league.pronos || []) {
        p.coup_de_coeur = false;
        allPronos.push(p);
      }
    }
  }
  const topPicks = allPronos
    .filter((p) => p.cote_retenue >= 1.25)
    .sort((a, b) => b.confiance - a.confiance || b.cote_retenue - a.cote_retenue)
    .slice(0, 10);
  for (const p of topPicks) p.coup_de_coeur = true;
  data.coup_de_coeur = topPicks.map((p) => p.event_id);
  console.log(`  coup-de-cœur re-selected: ${topPicks.length} picks`);

  data.meta = data.meta || {};
  data.meta.analyses_written_at = new Date().toISOString();
  data.meta.analyses_cost_usd = parseFloat(cost.toFixed(4));

  fs.writeFileSync(JSON_PATH, JSON.stringify(data, null, 2) + '\n');
  console.log(`✓ wrote ${JSON_PATH}`);

  if (errCount > 0 && okCount === 0) {
    process.exit(1); // full failure
  }
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
