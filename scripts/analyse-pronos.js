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

const MODEL = 'claude-sonnet-4-6-20250514';
const JSON_PATH = path.join(__dirname, '..', 'pronos.json');
const API_URL = 'https://api.anthropic.com/v1/messages';

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `Tu es un expert en paris sportifs qui écrit des analyses profondes et factuelles en français pour le site "Le Coach Parie".

RÈGLES POUR LES ANALYSES :
- N'invoque JAMAIS la cote du bookmaker comme raison. Interdit : "favori à 1.48, proba implicite 67%"
- Utilise le champ stats.recent_matches pour extraire des faits réels : forme récente, victoires/défaites, scores, tendances, et H2H quand les deux adversaires apparaissent ensemble
- Complète avec ta connaissance générale : forces, style, entraîneur/coach, contexte de saison, avantage terrain/surface
- Sois spécifique et concret, jamais générique ("en bonne forme" seul ne suffit pas — cite des résultats)
- Écris en FRANÇAIS, 4 à 7 phrases

RÈGLES PAR SPORT :

⚽ FOOTBALL (quand markets contient 1x2/double_chance/over_under/btts/draw_no_bet) :
- Deux équipes offensives → btts.yes ou over_under.2.5.over
- Équipes défensives → over_under.2.5.under ou btts.no
- Favori clair mais nul possible → double_chance.1X (ou X2)
- Gros favori → 1x2.home ou 1x2.away
- Match indécis → préfère btts ou over_under

🎾 TENNIS (quand markets contient over_under en jeux, handicap en jeux, correct_score en sets) :
- Favori écrasant (top 10 vs qualifié) → correct_score "2:0" ou handicap jeux négatif
- Match serré entre joueurs de même niveau → over_under total jeux (ex: "Plus de 22.5 jeux")
- Surface importante : terre battue = rallyes longs = plus de jeux ; gazon = services dominants
- Analyser la forme récente sur la surface actuelle
- pick_category "ou" pour total jeux, "cs" pour score en sets, "1x2" pour vainqueur simple

🏀 NBA (quand markets contient over_under en points, handicap) :
- Analyser le rythme des équipes (pace), back-to-back, blessures majeures, domicile/extérieur
- Total points over/under = le pari le plus fiable en NBA
- Handicap quand l'écart de niveau est clair
- pick_category "ou" pour total points, "1x2" pour vainqueur simple

🥊 MMA/UFC (quand markets contient over_under en rounds) :
- Analyser le style (striker vs grappler), séquence de KO/soumissions, reach, cardio
- Over/under rounds : frappeurs explosifs = under, lutteurs/techniciens = over
- Le H2H est crucial : certains styles s'annulent
- pick_category "ou" pour over/under rounds, "1x2" pour vainqueur simple

RÈGLES GÉNÉRALES :
- Cote RETENUE doit être ≥ 1.25
- confiance ≤ 4 sauf pick vraiment écrasant (5 réservé à l'exceptionnel)

FORMAT DE RÉPONSE : uniquement un JSON valide, sans aucun markdown, sans préambule. Schéma exact :
{
  "analyse": "4-7 phrases en français",
  "pick_category": "1x2" | "dc" | "ou" | "btts" | "dnb" | "cs",
  "pari": "Label français lisible du pari (ex: 'Plus de 22.5 jeux', 'Victoire en 2-0', 'Moins de 4.5 rounds')",
  "cote_retenue": nombre (doit correspondre à une cote du champ markets ou cotes),
  "confiance": entier 1-5,
  "prono": "win-home" | "win-away" | "draw"
}

Pour les picks non-1X2 (ou/btts/dc/cs) : mets prono = "win-home" comme placeholder neutre.
Pour "cs" (correct score / score en sets) : pari = "Victoire en 2-0" ou "Score 2-1" etc.
Pour "ou" en tennis : pari = "Plus de 22.5 jeux" ou "Moins de 20.5 jeux".
Pour "ou" en NBA : pari = "Plus de 215.5 points" ou "Moins de 210.5 points".
Pour "ou" en MMA : pari = "Plus de 4.5 rounds" ou "Moins de 4.5 rounds".`;

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

const VALID_CATEGORIES = new Set(['1x2', 'dc', 'ou', 'btts', 'dnb', 'cs']);
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

  // ---- Claude picks 2 combos from the top 10 coup-de-cœur ----
  try {
    const combos = await generateCombos(topPicks);
    if (combos && combos.length) {
      data.combos = combos;
      console.log(`  combos: ${combos.length} generated`);
    }
  } catch (e) {
    console.error('  [WARN] combo generation failed:', e.message);
    // Fall back to empty combos — the rest of the pipeline still works
    data.combos = [];
  }

  // ---- Fun page: 2 yolo picks + 1 mega combo ----
  try {
    const funBets = await generateFunBets(allPronos);
    if (funBets) {
      data.fun = funBets;
      console.log(`  fun: ${(funBets.yolo_picks || []).length} yolo picks + ${funBets.mega_combo ? '1 mega combo (' + funBets.mega_combo.total_cote + 'x)' : 'no mega combo'}`);
    }
  } catch (e) {
    console.error('  [WARN] fun bets generation failed:', e.message);
    data.fun = { yolo_picks: [], mega_combo: null };
  }

  data.meta = data.meta || {};
  data.meta.analyses_written_at = new Date().toISOString();
  data.meta.analyses_cost_usd = parseFloat(cost.toFixed(4));

  fs.writeFileSync(JSON_PATH, JSON.stringify(data, null, 2) + '\n');
  console.log(`✓ wrote ${JSON_PATH}`);

  if (errCount > 0 && okCount === 0) {
    process.exit(1); // full failure
  }
}

// ---------------------------------------------------------------------------
// Claude picks 2 curated combos from the top coup-de-cœur picks.
// ---------------------------------------------------------------------------
const COMBO_SYSTEM_PROMPT = `Tu es un tipster sportif expert. À partir d'une liste de 10 pronostics coup-de-cœur du jour, tu proposes DEUX combinés stratégiques différents :

COMBO 1 ("safe") — Le combiné sûr
- 2 ou 3 picks à très haute confiance (⭐4 minimum)
- Préférer des cotes modérées (1.25 à 1.70 par leg)
- Cote totale visée : entre 1.80 et 3.00
- Idéal pour une mise confortable à faible variance

COMBO 2 ("value") — Le combiné value
- 2 ou 3 picks avec un bon ratio value/risque (⭐3 ou ⭐4)
- Peut inclure des cotes un peu plus élevées (1.60 à 2.50 par leg)
- Cote totale visée : entre 3.00 et 8.00
- Une bonne upside pour une mise moindre

RÈGLES STRICTES :
- Un même match ne peut PAS apparaître dans les 2 combos
- Diversifier les sports et les championnats quand c'est possible
- Privilégier les pronostics les plus solidement argumentés
- Le raisonnement doit expliquer POURQUOI ces picks vont bien ensemble (complémentarité, risque équilibré, timing…)

FORMAT DE RÉPONSE : uniquement un JSON valide, aucun markdown, aucun préambule. Schéma :
{
  "combos": [
    {
      "strategy": "safe",
      "label": "Triple sûr du jour",
      "reasoning": "2-3 phrases en français expliquant le choix des 3 legs et pourquoi ils vont ensemble",
      "event_ids": ["id1", "id2", "id3"]
    },
    {
      "strategy": "value",
      "label": "Combo value du jour",
      "reasoning": "2-3 phrases",
      "event_ids": ["id4", "id5"]
    }
  ]
}

Les event_ids doivent correspondre EXACTEMENT à des event_id fournis dans la liste d'entrée.`;

async function generateCombos(topPicks) {
  if (!topPicks || topPicks.length < 3) return [];

  // Build the compact picks summary for the prompt
  const list = topPicks.map((p) => ({
    event_id: p.event_id,
    match: p.match,
    sport_key: p.sport_key,
    pari: p.pari,
    pick_category: p.pick_category,
    cote: p.cote_retenue,
    confiance: p.confiance,
  }));

  const userPrompt =
    "Voici les 10 coup-de-cœur du jour, propose-moi 2 combinés stratégiques :\n\n" +
    JSON.stringify(list, null, 2);

  console.log('  → calling Claude for 2 combos');
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1200,
      system: COMBO_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const resp = await res.json();
  const text = resp.content && resp.content[0] && resp.content[0].text;
  if (!text) throw new Error('empty combos response');
  const parsed = extractJson(text);
  if (!parsed.combos || !Array.isArray(parsed.combos)) throw new Error('no combos array in response');

  // Enrich each combo with total_cote and leg details pulled from topPicks
  const byId = new Map(topPicks.map((p) => [p.event_id, p]));
  const usedIds = new Set();
  const combos = [];
  for (const c of parsed.combos) {
    if (!Array.isArray(c.event_ids) || c.event_ids.length < 2) continue;
    const legs = [];
    let totalCote = 1;
    let dup = false;
    for (const eid of c.event_ids) {
      if (usedIds.has(eid)) { dup = true; break; }
      const pick = byId.get(eid);
      if (!pick) continue;
      legs.push({
        event_id: pick.event_id,
        match: pick.match,
        pari: pick.pari,
        sport_key: pick.sport_key,
        pick_category: pick.pick_category,
        prono: pick.prono,
        cote: pick.cote_retenue,
        home: pick.home,
        away: pick.away,
        time_display: pick.time_display,
      });
      totalCote *= pick.cote_retenue;
    }
    if (dup || legs.length < 2) continue;
    // Add a human sport label to each leg so the frontend doesn't have to
    // reverse-engineer it from sport_key
    legs.forEach((l) => {
      const k = l.sport_key || '';
      if (k.startsWith('flashscore_football') || k.startsWith('soccer_')) l.sport_label = '⚽ Foot';
      else if (k.startsWith('flashscore_basketball') || k === 'basketball_nba') l.sport_label = '🏀 NBA';
      else if (k.startsWith('flashscore_mma') || k === 'mma_mixed_martial_arts') l.sport_label = '🥊 UFC';
      else if (k.startsWith('flashscore_tennis') || k.startsWith('tennis_')) l.sport_label = '🎾 Tennis';
      else l.sport_label = '🎯 Autre';
      usedIds.add(l.event_id);
    });
    combos.push({
      strategy: c.strategy || 'unknown',
      label: c.label || 'Combiné',
      reasoning: c.reasoning || '',
      legs,
      total_cote: parseFloat(totalCote.toFixed(2)),
    });
  }
  return combos;
}

// ---------------------------------------------------------------------------
// FUN PAGE: 2 risky singles + 1 mega combo (cote 10 000 – 20 000)
// ---------------------------------------------------------------------------
const FUN_SYSTEM_PROMPT = `Tu es un tipster sportif fun et audacieux. Tu proposes des paris "coup de folie" pour les joueurs qui veulent s'amuser avec une petite mise.

À partir de la liste de TOUS les pronos du jour (avec leurs analyses et marchés), tu dois proposer :

1. DEUX paris simples "YOLO" — des picks individuels à grosse cote (≥ 4.00 chacun).
   Ce sont des outsiders crédibles : pas n'importe quel underdog, mais des situations où l'upset est réaliste.
   Pour chaque pick, écris 2-3 phrases fun et convaincantes en français expliquant pourquoi c'est jouable.

2. UN méga combiné "JACKPOT" — entre 8 et 14 legs, cote totale visée entre 10 000 et 20 000.
   Les legs individuels doivent avoir des cotes entre 1.50 et 3.50 (risque modéré par leg).
   Diversifier les sports et championnats autant que possible.
   Le raisonnement doit être fun, ambitieux mais pas délirant — chaque leg doit être défendable.

RÈGLES :
- Les event_ids doivent correspondre EXACTEMENT à ceux fournis dans la liste
- Le pari de chaque pick doit correspondre à un marché réellement disponible (cotes ou markets)
- N'utilise PAS les mêmes matchs pour les 2 yolo picks
- Écris en FRANÇAIS

FORMAT DE RÉPONSE : uniquement un JSON valide, aucun markdown. Schéma :
{
  "yolo_picks": [
    {
      "event_id": "id1",
      "pari": "Label français du pari",
      "cote": nombre,
      "analyse_fun": "2-3 phrases fun en français"
    },
    {
      "event_id": "id2",
      "pari": "Label français du pari",
      "cote": nombre,
      "analyse_fun": "2-3 phrases fun en français"
    }
  ],
  "mega_combo": {
    "label": "Nom fun du combo",
    "reasoning": "3-4 phrases fun et ambitieuses en français",
    "legs": [
      { "event_id": "id", "pari": "Label du pari", "cote": nombre }
    ]
  }
}`;

async function generateFunBets(allPronos) {
  if (!allPronos || allPronos.length < 10) return null;

  const list = allPronos.map((p) => ({
    event_id: p.event_id,
    match: p.match,
    sport_key: p.sport_key,
    home: p.home,
    away: p.away,
    pari: p.pari,
    pick_category: p.pick_category,
    cote: p.cote_retenue,
    confiance: p.confiance,
    cotes: p.cotes || null,
    markets: p.markets ? Object.keys(p.markets) : null,
  }));

  const userPrompt =
    `Voici les ${list.length} pronos du jour avec leurs cotes. Propose-moi 2 paris YOLO + 1 méga combo JACKPOT :\n\n` +
    JSON.stringify(list, null, 2);

  console.log('  → calling Claude for fun bets (2 yolo + 1 mega combo)');
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      system: FUN_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const resp = await res.json();
  const text = resp.content && resp.content[0] && resp.content[0].text;
  if (!text) throw new Error('empty fun response');
  const parsed = extractJson(text);

  // Build pronos lookup
  const byId = new Map(allPronos.map((p) => [p.event_id, p]));

  // Enrich yolo picks
  const yoloPicks = [];
  for (const y of parsed.yolo_picks || []) {
    const pick = byId.get(y.event_id);
    if (!pick) continue;
    yoloPicks.push({
      event_id: pick.event_id,
      match: pick.match,
      home: pick.home,
      away: pick.away,
      pari: y.pari,
      cote: y.cote || pick.cote_retenue,
      analyse_fun: y.analyse_fun || '',
      sport_key: pick.sport_key,
      time_display: pick.time_display,
    });
  }

  // Enrich mega combo
  let megaCombo = null;
  if (parsed.mega_combo && Array.isArray(parsed.mega_combo.legs)) {
    const legs = [];
    let totalCote = 1;
    for (const leg of parsed.mega_combo.legs) {
      const pick = byId.get(leg.event_id);
      if (!pick) continue;
      const cote = leg.cote || pick.cote_retenue;
      legs.push({
        event_id: pick.event_id,
        match: pick.match,
        home: pick.home,
        away: pick.away,
        pari: leg.pari,
        cote,
        sport_key: pick.sport_key,
        time_display: pick.time_display,
      });
      totalCote *= cote;
    }
    if (legs.length >= 5) {
      megaCombo = {
        label: parsed.mega_combo.label || 'Méga Combo Jackpot',
        reasoning: parsed.mega_combo.reasoning || '',
        legs,
        total_cote: parseFloat(totalCote.toFixed(2)),
      };
    }
  }

  return { yolo_picks: yoloPicks, mega_combo: megaCombo };
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
