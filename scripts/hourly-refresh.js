#!/usr/bin/env node
/*
 * hourly-refresh.js — lightweight cote + full-result refresh, runs every hour
 * ----------------------------------------------------------------------------
 * Ownership (vs scripts/generate-pronos.js):
 *   - The DAILY run only builds new fixtures + analyses + initial cotes. It
 *     does NOT check results anymore.
 *   - This HOURLY run is the sole owner of result verification and history
 *     archiving. It runs every hour, resolves any prono whose match has
 *     finished (any pick_category: 1x2 / dnb / dc / ou / btts) and archives
 *     it into pronos.json → history[].
 *
 * API usage per run:
 *   - 1 Flashscore call: /matches/list?sport_id=1&day=0  (cotes + foot scores)
 *   - 0..3 Odds API calls: /sports/<sport>/scores/?daysFrom=3 — ONLY if there
 *     are pending non-foot pronos whose kickoff is in the past.
 *
 * Usage:
 *   ODDS_API_KEY=xxx FLASHSCORE_KEY=xxx node scripts/hourly-refresh.js
 *
 * Budget target (free/pro tiers):
 *   - Flashscore: 1 req/run × 24/day × 30 = ~720/month
 *   - Odds API:   ~0-3 req/run × 24/day × 30 ≈ 150-300/month
 */

const fs = require('fs');
const path = require('path');

const FLASHSCORE_KEY = process.env.FLASHSCORE_KEY;
const ODDS_API_KEY = process.env.ODDS_API_KEY;
if (!FLASHSCORE_KEY) { console.error('ERROR: FLASHSCORE_KEY env var not set'); process.exit(1); }
if (!ODDS_API_KEY)   { console.error('ERROR: ODDS_API_KEY env var not set');   process.exit(1); }

const FS_HOST = 'flashscore4.p.rapidapi.com';
const FS_BASE = `https://${FS_HOST}/api/flashscore/v2`;
const ODDS_BASE = 'https://api.the-odds-api.com/v4';
const JSON_PATH = path.join(__dirname, '..', 'pronos.json');

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
async function fsFetch(pathname) {
  const url = FS_BASE + pathname;
  const res = await fetch(url, {
    headers: { 'x-rapidapi-host': FS_HOST, 'x-rapidapi-key': FLASHSCORE_KEY },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Flashscore HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const remaining = res.headers.get('x-ratelimit-requests-remaining');
  if (remaining) console.log(`  flashscore quota remaining: ${remaining}`);
  return res.json();
}

async function oddsFetch(pathname) {
  const sep = pathname.includes('?') ? '&' : '?';
  const url = ODDS_BASE + pathname + sep + 'apiKey=' + ODDS_API_KEY;
  const res = await fetch(url);
  const remaining = res.headers.get('x-requests-remaining');
  if (remaining) console.log(`    odds-api remaining: ${remaining}`);
  if (res.status === 404 || res.status === 422) return [];
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Odds API HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Parse Claude-written `pari` text into a structured outcome.
// Claude is prompted to use these exact French patterns, so matching is
// reasonably robust. Fallback returns null → the resolver returns "void".
// ---------------------------------------------------------------------------
function inferOuOutcome(pari) {
  if (!pari) return null;
  const p = pari.toLowerCase();
  const m = p.match(/([0-9]+(?:[.,][0-9]+)?)\s*but/);
  if (!m) return null;
  const line = parseFloat(m[1].replace(',', '.'));
  if (!isFinite(line)) return null;
  const hasOver = /\b(plus|over|\+)\b/.test(p);
  const hasUnder = /\b(moins|under|-)\b/.test(p);
  if (hasOver && !hasUnder) return { line, direction: 'over' };
  if (hasUnder && !hasOver) return { line, direction: 'under' };
  return null;
}

function inferBttsOutcome(pari) {
  if (!pari) return null;
  const p = pari.toLowerCase();
  // "pas de but des deux équipes" / "aucune équipe ne marque"
  if (/pas de but|aucune\s*équipe|btts.{0,4}no|\bno\b(?!\w)/.test(p)) return { yes: false };
  // "les deux équipes marquent" / "both teams to score" / "btts oui"
  if (/deux\s*équipes\s*marquent|les\s*deux\s*marquent|both\s*teams|btts.{0,4}(yes|oui)/.test(p)) return { yes: true };
  return null;
}

function inferDcOutcome(pari, home, away) {
  if (!pari) return null;
  const p = pari.toLowerCase();
  const h = (home || '').toLowerCase();
  const a = (away || '').toLowerCase();
  if (/\b1x\b/.test(p)) return { outcome: '1X' };
  if (/\bx2\b/.test(p)) return { outcome: 'X2' };
  if (/\b12\b|pas de nul|no draw/.test(p)) return { outcome: '12' };
  // "double chance <home> ou nul"
  if (h && p.includes(h + ' ou nul')) return { outcome: '1X' };
  if (a && p.includes('nul ou ' + a)) return { outcome: 'X2' };
  if (h && a && p.includes(h + ' ou ' + a)) return { outcome: '12' };
  // Fall back on the prono field as a hint (home→1X, away→X2)
  return null;
}

// ---------------------------------------------------------------------------
// Resolve a prono given the raw home/away scores.
// Supports every pick_category: 1x2, dnb, ou, btts, dc.
// Returns { status: 'won'|'lost'|'void', actual_score, actual_result } or null
// when the match isn't resolvable from the given scores.
// ---------------------------------------------------------------------------
function resolveStatus(prono, scores) {
  const h = typeof scores.home === 'number' ? scores.home : parseInt(scores.home, 10);
  const a = typeof scores.away === 'number' ? scores.away : parseInt(scores.away, 10);
  if (!Number.isFinite(h) || !Number.isFinite(a)) return null;

  const actual = `${h}-${a}`;
  const total = h + a;
  const draw = h === a;
  const homeWins = h > a;
  const actualResult = homeWins ? 'home' : draw ? 'draw' : 'away';
  const cat = prono.pick_category || '1x2';

  const pack = (status) => ({ status, actual_score: actual, actual_result: actualResult });

  // --- 1X2 ---
  if (cat === '1x2') {
    if (draw) return pack(prono.prono === 'draw' ? 'won' : 'lost');
    if (prono.prono === 'win-home') return pack(homeWins ? 'won' : 'lost');
    if (prono.prono === 'win-away') return pack(!homeWins ? 'won' : 'lost');
    return pack('void');
  }

  // --- Draw No Bet: same as 1X2 but draw refunded ---
  if (cat === 'dnb') {
    if (draw) return pack('void');
    if (prono.prono === 'win-home') return pack(homeWins ? 'won' : 'lost');
    if (prono.prono === 'win-away') return pack(!homeWins ? 'won' : 'lost');
    return pack('void');
  }

  // --- Over/Under ---
  if (cat === 'ou') {
    const o = inferOuOutcome(prono.pari);
    if (!o) return pack('void');
    const goalsStrictlyOver = total > o.line;
    if (o.direction === 'over')  return pack(goalsStrictlyOver ? 'won' : 'lost');
    if (o.direction === 'under') return pack(!goalsStrictlyOver && total !== o.line ? 'won' : total === o.line ? 'void' : 'lost');
    return pack('void');
  }

  // --- BTTS ---
  if (cat === 'btts') {
    const o = inferBttsOutcome(prono.pari);
    if (!o) return pack('void');
    const bothScored = h > 0 && a > 0;
    if (o.yes) return pack(bothScored ? 'won' : 'lost');
    return pack(!bothScored ? 'won' : 'lost');
  }

  // --- Double Chance ---
  if (cat === 'dc') {
    let o = inferDcOutcome(prono.pari, prono.home, prono.away);
    if (!o) {
      // Fallback via prono field
      if (prono.prono === 'win-home') o = { outcome: '1X' };
      else if (prono.prono === 'win-away') o = { outcome: 'X2' };
      else return pack('void');
    }
    if (o.outcome === '1X') return pack(homeWins || draw ? 'won' : 'lost');
    if (o.outcome === 'X2') return pack(!homeWins || draw ? 'won' : 'lost');
    if (o.outcome === '12') return pack(!draw ? 'won' : 'lost');
    return pack('void');
  }

  return pack('void');
}

// ---------------------------------------------------------------------------
// Foot list → map match_id → { cotes, status, scores }
// ---------------------------------------------------------------------------
function indexFootList(tournaments) {
  const byId = new Map();
  for (const t of tournaments) {
    for (const m of t.matches || []) {
      if (!m.match_id) continue;
      byId.set(m.match_id, {
        cotes: m.odds
          ? {
              domicile: m.odds['1'] || null,
              nul: m.odds['X'] || null,
              exterieur: m.odds['2'] || null,
            }
          : null,
        status: m.match_status || null,
        scores: m.scores || null,
      });
    }
  }
  return byId;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`→ hourly-refresh ${new Date().toISOString()}`);

  let data;
  try {
    data = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  } catch (e) {
    console.error('Cannot read pronos.json — is this the first run?');
    process.exit(1);
  }

  data.sports = data.sports || {};
  data.history = data.history || [];

  let cotesUpdated = 0;
  let resolved = 0;
  const now = Date.now();

  // ---------- FOOT ----------
  // 1 Flashscore list call gives us cotes + scores + statuses for every foot
  // match of the day.
  if (data.sports.foot) {
    let listResp;
    try {
      listResp = await fsFetch('/matches/list?sport_id=1&day=0');
    } catch (e) {
      console.error('  [WARN] foot list failed:', e.message);
      listResp = [];
    }
    const byId = indexFootList(listResp);
    console.log(`  foot: indexed ${byId.size} matches`);

    for (const league of data.sports.foot.leagues || []) {
      for (const p of league.pronos || []) {
        if (p.status !== 'pending') continue;
        const live = byId.get(p.flashscore_id || p.event_id);
        if (!live) continue;

        // Update 1X2 cotes (from list response, free)
        if (live.cotes && live.cotes.domicile) {
          const oldH = p.cotes && p.cotes.domicile;
          const oldA = p.cotes && p.cotes.exterieur;
          const oldD = p.cotes && p.cotes.nul;
          if (oldH !== live.cotes.domicile || oldA !== live.cotes.exterieur || oldD !== live.cotes.nul) {
            p.cotes = { domicile: live.cotes.domicile, nul: live.cotes.nul, exterieur: live.cotes.exterieur };
            if (p.pick_category === '1x2' || !p.pick_category) {
              if (p.prono === 'win-home') p.cote_retenue = live.cotes.domicile;
              else if (p.prono === 'win-away') p.cote_retenue = live.cotes.exterieur;
              else if (p.prono === 'draw' && live.cotes.nul) p.cote_retenue = live.cotes.nul;
            }
            cotesUpdated++;
          }
        }

        // Resolve if finished
        if (live.status && live.status.is_finished && live.scores) {
          const res = resolveStatus(p, live.scores);
          if (res) {
            p.status = res.status;
            p.actual_score = res.actual_score;
            p.actual_result = res.actual_result;
            resolved++;
            console.log(`    resolved ${p.match}: ${res.actual_score} → ${res.status} (${p.pick_category || '1x2'})`);
          }
        }
      }
    }
  }

  // ---------- NBA / UFC / TENNIS (Odds API) ----------
  // Only hit the scores endpoint if there are pending pronos whose kickoff
  // is already in the past — avoids burning quota when nothing is ready.
  const nonFootGroups = new Map();
  for (const [sportKey, sport] of Object.entries(data.sports)) {
    if (sportKey === 'foot') continue;
    for (const league of sport.leagues || []) {
      for (const p of league.pronos || []) {
        if (p.status !== 'pending') continue;
        const ms = new Date(p.commence_time).getTime();
        if (ms > now) continue; // match not started yet
        if (!p.sport_key) continue;
        if (!nonFootGroups.has(p.sport_key)) nonFootGroups.set(p.sport_key, []);
        nonFootGroups.get(p.sport_key).push(p);
      }
    }
  }

  for (const [sportKey, pronos] of nonFootGroups) {
    console.log(`  non-foot: ${sportKey} has ${pronos.length} pending past-kickoff`);
    let events;
    try {
      events = await oddsFetch(`/sports/${sportKey}/scores/?daysFrom=3&dateFormat=iso`);
    } catch (e) {
      console.error(`    [WARN] odds scores failed:`, e.message);
      continue;
    }
    const byId = new Map(events.map((e) => [e.id, e]));
    for (const p of pronos) {
      const evt = byId.get(p.event_id);
      if (!evt || !evt.completed || !evt.scores) continue;
      const hScore = parseInt(evt.scores.find((s) => s.name === p.home)?.score, 10);
      const aScore = parseInt(evt.scores.find((s) => s.name === p.away)?.score, 10);
      const res = resolveStatus(p, { home: hScore, away: aScore });
      if (!res) continue;
      p.status = res.status;
      p.actual_score = res.actual_score;
      p.actual_result = res.actual_result;
      resolved++;
      console.log(`    resolved ${p.match}: ${res.actual_score} → ${res.status} (${p.pick_category || '1x2'})`);
    }
  }

  // ---------- Archive resolved → history[] ----------
  let archived = 0;
  if (resolved > 0) {
    for (const sport of Object.values(data.sports)) {
      for (const league of sport.leagues || []) {
        const keep = [];
        for (const p of league.pronos || []) {
          if (p.status === 'won' || p.status === 'lost' || p.status === 'void') {
            data.history.push({
              ...p,
              sport_label: sport.label,
              league_label: league.label,
              archived_at: new Date().toISOString(),
            });
            archived++;
          } else {
            keep.push(p);
          }
        }
        league.pronos = keep;
      }
    }
    if (data.history.length > 500) data.history.splice(0, data.history.length - 500);
  }

  // ---------- Write ----------
  data.meta = data.meta || {};
  data.meta.last_hourly_refresh = new Date().toISOString();
  if (resolved > 0) data.meta.last_results_update = data.meta.last_hourly_refresh;

  console.log(`  cotes updated: ${cotesUpdated} | resolved: ${resolved} | archived: ${archived}`);

  if (cotesUpdated === 0 && resolved === 0) {
    console.log('✓ nothing changed, skipping write');
    return;
  }

  fs.writeFileSync(JSON_PATH, JSON.stringify(data, null, 2) + '\n');
  console.log(`✓ wrote ${JSON_PATH}`);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
