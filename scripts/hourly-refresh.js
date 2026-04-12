#!/usr/bin/env node
/*
 * hourly-refresh.js v6 — smart cote + result refresh, runs every 15 min
 * ----------------------------------------------------------------------------
 * v6 changes:
 *   - SMART REFRESH: only calls Flashscore for sports that have matches
 *     in progress (kickoff passed, not yet resolved). Zero API calls at night
 *     or when no match is live.
 *   - IN-PROGRESS: marks started-but-not-finished matches as "in_progress"
 *     so the frontend hides them (can't bet anymore). They get resolved and
 *     archived when they finish.
 *   - Odds API legacy fallback removed (no longer needed).
 *
 * API usage per run: 0-7 Flashscore calls (only for sports with live matches).
 *   - 0 calls if no match has started yet or all are resolved
 *   - 1 call per sport with active matches (foot=1, NBA=2, UFC=2, Tennis=2)
 *
 * Usage:
 *   FLASHSCORE_KEY=xxx node scripts/hourly-refresh.js
 */

const fs = require('fs');
const path = require('path');

const FLASHSCORE_KEY = process.env.FLASHSCORE_KEY;
if (!FLASHSCORE_KEY) { console.error('ERROR: FLASHSCORE_KEY env var not set'); process.exit(1); }

const FS_HOST = 'flashscore4.p.rapidapi.com';
const FS_BASE = `https://${FS_HOST}/api/flashscore/v2`;
const JSON_PATH = path.join(__dirname, '..', 'pronos.json');

// Sport key → Flashscore sport_id
const SPORT_ID_MAP = { foot: 1, nba: 3, ufc: 28, tennis: 2 };

// ---------------------------------------------------------------------------
// HTTP helper
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

// ---------------------------------------------------------------------------
// Parse Claude-written `pari` text into structured outcomes
// ---------------------------------------------------------------------------
function inferOuOutcome(pari) {
  if (!pari) return null;
  const p = pari.toLowerCase();
  const m = p.match(/([0-9]+(?:[.,][0-9]+)?)\s*(?:but|jeu|game|point|round|set|manche)/);
  if (!m) {
    const m2 = p.match(/(?:plus|over|moins|under)[^0-9]*([0-9]+(?:[.,][0-9]+)?)/);
    if (!m2) return null;
    const line = parseFloat(m2[1].replace(',', '.'));
    if (!isFinite(line)) return null;
    const hasOver = /\b(plus|over|\+)\b/.test(p);
    const hasUnder = /\b(moins|under|-)\b/.test(p);
    if (hasOver && !hasUnder) return { line, direction: 'over' };
    if (hasUnder && !hasOver) return { line, direction: 'under' };
    return null;
  }
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
  if (/pas de but|aucune\s*équipe|btts.{0,4}no|\bno\b(?!\w)/.test(p)) return { yes: false };
  if (/deux\s*équipes?\s*marquent|les\s*deux\s*marquent|both\s*teams|btts.{0,4}(yes|oui)/.test(p)) return { yes: true };
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
  if (h && p.includes(h + ' ou nul')) return { outcome: '1X' };
  if (a && p.includes('nul ou ' + a)) return { outcome: 'X2' };
  if (h && a && p.includes(h + ' ou ' + a)) return { outcome: '12' };
  return null;
}

// ---------------------------------------------------------------------------
// Resolve a prono given raw home/away scores
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

  if (cat === '1x2') {
    if (draw) return pack(prono.prono === 'draw' ? 'won' : 'lost');
    if (prono.prono === 'win-home') return pack(homeWins ? 'won' : 'lost');
    if (prono.prono === 'win-away') return pack(!homeWins ? 'won' : 'lost');
    return pack('void');
  }
  if (cat === 'dnb') {
    if (draw) return pack('void');
    if (prono.prono === 'win-home') return pack(homeWins ? 'won' : 'lost');
    if (prono.prono === 'win-away') return pack(!homeWins ? 'won' : 'lost');
    return pack('void');
  }
  if (cat === 'ou') {
    const o = inferOuOutcome(prono.pari);
    if (!o) return pack('void');
    const goalsStrictlyOver = total > o.line;
    if (o.direction === 'over')  return pack(goalsStrictlyOver ? 'won' : 'lost');
    if (o.direction === 'under') return pack(!goalsStrictlyOver && total !== o.line ? 'won' : total === o.line ? 'void' : 'lost');
    return pack('void');
  }
  if (cat === 'btts') {
    const o = inferBttsOutcome(prono.pari);
    if (!o) return pack('void');
    const bothScored = h > 0 && a > 0;
    if (o.yes) return pack(bothScored ? 'won' : 'lost');
    return pack(!bothScored ? 'won' : 'lost');
  }
  if (cat === 'dc') {
    let o = inferDcOutcome(prono.pari, prono.home, prono.away);
    if (!o) {
      if (prono.prono === 'win-home') o = { outcome: '1X' };
      else if (prono.prono === 'win-away') o = { outcome: 'X2' };
      else return pack('void');
    }
    if (o.outcome === '1X') return pack(homeWins || draw ? 'won' : 'lost');
    if (o.outcome === 'X2') return pack(!homeWins || draw ? 'won' : 'lost');
    if (o.outcome === '12') return pack(!draw ? 'won' : 'lost');
    return pack('void');
  }
  if (cat === 'cs') {
    const csMatch = prono.pari && prono.pari.match(/(\d)\s*[-:]\s*(\d)/);
    if (!csMatch) return pack('void');
    const expectedHome = parseInt(csMatch[1], 10);
    const expectedAway = parseInt(csMatch[2], 10);
    if (h === expectedHome && a === expectedAway) return pack('won');
    return pack('lost');
  }
  return pack('void');
}

// ---------------------------------------------------------------------------
// Index Flashscore list response → Map<match_id, {cotes, status, scores}>
// ---------------------------------------------------------------------------
function indexMatchList(tournaments) {
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
// Update cotes + mark in_progress + resolve finished
// ---------------------------------------------------------------------------
function refreshFromIndex(pronos, byId) {
  let cUpdated = 0, rResolved = 0, rInProgress = 0;

  for (const p of pronos) {
    // Skip already resolved
    if (p.status === 'won' || p.status === 'lost' || p.status === 'void') continue;

    const live = byId.get(p.flashscore_id || p.event_id);
    if (!live) continue;

    // Update cotes (only for pending — not in_progress since you can't bet anymore)
    if (p.status === 'pending' && live.cotes && live.cotes.domicile) {
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
        cUpdated++;
      }
    }

    // Resolve if finished
    if (live.status && live.status.is_finished && live.scores) {
      const res = resolveStatus(p, live.scores);
      if (res) {
        p.status = res.status;
        p.actual_score = res.actual_score;
        p.actual_result = res.actual_result;
        rResolved++;
        console.log(`    resolved ${p.match}: ${res.actual_score} → ${res.status} (${p.pick_category || '1x2'})`);
      }
    }
    // Mark as in_progress if started but not finished
    else if (live.status && (live.status.is_started || live.status.is_in_progress) && p.status === 'pending') {
      p.status = 'in_progress';
      rInProgress++;
    }
  }

  return { cUpdated, rResolved, rInProgress };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`→ refresh v7 ${new Date().toISOString()} (full refresh — all sports every run)`);

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
  let inProgress = 0;
  let apiCalls = 0;
  const now = Date.now();

  // ---------- Process each sport (foot + non-foot unified) ----------
  for (const [sportKey, sport] of Object.entries(data.sports)) {
    const sportId = SPORT_ID_MAP[sportKey];
    if (!sportId) {
      console.log(`  ${sportKey}: unknown sport_id, skipping`);
      continue;
    }

    // Full refresh: always fetch all sports (no smart skip — detects night matches)
    // Collect all non-resolved pronos with flashscore_id
    const activePronos = [];
    for (const league of sport.leagues || []) {
      for (const p of league.pronos || []) {
        if ((p.status === 'pending' || p.status === 'in_progress') && p.flashscore_id) {
          activePronos.push(p);
        }
      }
    }
    if (!activePronos.length) {
      console.log(`  ${sportKey}: no pronos with flashscore_id — skipping`);
      continue;
    }

    console.log(`  ${sportKey}: ${activePronos.length} active pronos — fetching Flashscore`);

    // Fetch: day=0 always, day=-1 for non-foot (yesterday's late matches)
    let listResp = [];
    try {
      if (sportKey === 'foot') {
        const day0 = await fsFetch(`/matches/list?sport_id=${sportId}&day=0`);
        listResp = Array.isArray(day0) ? day0 : [];
        apiCalls++;
      } else {
        const [day0, dayMinus1] = await Promise.all([
          fsFetch(`/matches/list?sport_id=${sportId}&day=0`),
          fsFetch(`/matches/list?sport_id=${sportId}&day=-1`),
        ]);
        listResp = [
          ...(Array.isArray(day0) ? day0 : []),
          ...(Array.isArray(dayMinus1) ? dayMinus1 : []),
        ];
        apiCalls += 2;
      }
    } catch (e) {
      console.error(`  [WARN] ${sportKey} list failed:`, e.message);
      continue;
    }

    const byId = indexMatchList(listResp);
    console.log(`  ${sportKey}: indexed ${byId.size} matches`);

    const fr = refreshFromIndex(activePronos, byId);
    cotesUpdated += fr.cUpdated;
    resolved += fr.rResolved;
    inProgress += fr.rInProgress;
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

  console.log(`  API calls: ${apiCalls} | cotes: ${cotesUpdated} | in_progress: ${inProgress} | resolved: ${resolved} | archived: ${archived}`);

  if (cotesUpdated === 0 && resolved === 0 && inProgress === 0) {
    console.log('✓ nothing changed, skipping write');
    return;
  }

  fs.writeFileSync(JSON_PATH, JSON.stringify(data, null, 2) + '\n');
  console.log(`✓ wrote ${JSON_PATH}`);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
