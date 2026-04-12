#!/usr/bin/env node
/*
 * hourly-refresh.js — lightweight cote + full-result refresh, runs every hour
 * ----------------------------------------------------------------------------
 * Ownership (vs scripts/generate-pronos.js):
 *   - The DAILY run only builds new fixtures + analyses + initial cotes.
 *   - This HOURLY run is the sole owner of result verification and history
 *     archiving.
 *
 * v5 migration: ALL sports now resolved via Flashscore.
 * ODDS_API_KEY is optional — only used as temporary fallback for legacy pronos
 * that were generated before the Flashscore migration (no flashscore_id).
 * Once all old pronos have been resolved or expired, ODDS_API_KEY can be
 * removed entirely.
 *
 * API usage per run:
 *   - 1 Flashscore call: /matches/list?sport_id=1&day=0  (foot)
 *   - 0..6 Flashscore calls: sport_id 3/28/2 × day=0 + day=-1
 *     (only when pending non-foot pronos exist)
 *   - Total: 1-7 Flashscore req/run → max ~168/month extra
 *
 * Usage:
 *   FLASHSCORE_KEY=xxx node scripts/hourly-refresh.js
 *   FLASHSCORE_KEY=xxx ODDS_API_KEY=xxx node scripts/hourly-refresh.js  (with legacy fallback)
 */

const fs = require('fs');
const path = require('path');

const FLASHSCORE_KEY = process.env.FLASHSCORE_KEY;
const ODDS_API_KEY = process.env.ODDS_API_KEY || null; // optional legacy fallback
if (!FLASHSCORE_KEY) { console.error('ERROR: FLASHSCORE_KEY env var not set'); process.exit(1); }

const FS_HOST = 'flashscore4.p.rapidapi.com';
const FS_BASE = `https://${FS_HOST}/api/flashscore/v2`;
const ODDS_BASE = 'https://api.the-odds-api.com/v4';
const JSON_PATH = path.join(__dirname, '..', 'pronos.json');

// Mapping: sport key in pronos.json → Flashscore sport_id
const SPORT_ID_MAP = { nba: 3, ufc: 28, tennis: 2 };

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
  if (!ODDS_API_KEY) return [];
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
// ---------------------------------------------------------------------------
function inferOuOutcome(pari) {
  if (!pari) return null;
  const p = pari.toLowerCase();
  // Match patterns like "Plus de 2.5 buts", "Moins de 22.5 jeux", "Plus de 215.5 points", "Moins de 4.5 rounds"
  const m = p.match(/([0-9]+(?:[.,][0-9]+)?)\s*(?:but|jeu|game|point|round|set|manche)/);
  if (!m) {
    // Fallback: match "plus de X.X" or "moins de X.X" without unit
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
  if (h && p.includes(h + ' ou nul')) return { outcome: '1X' };
  if (a && p.includes('nul ou ' + a)) return { outcome: 'X2' };
  if (h && a && p.includes(h + ' ou ' + a)) return { outcome: '12' };
  return null;
}

// ---------------------------------------------------------------------------
// Resolve a prono given the raw home/away scores.
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

  // --- Correct Score / Set Betting (tennis) ---
  if (cat === 'cs') {
    // Parse expected score from pari: "Victoire en 2-0", "Score 2-1", "2:0" etc.
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
// Works for any sport (foot, basketball, MMA, tennis).
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
// Update cotes + resolve for a set of pronos against a Flashscore index
// ---------------------------------------------------------------------------
function refreshFromIndex(pronos, byId, sportKey) {
  let cUpdated = 0, rResolved = 0;
  for (const p of pronos) {
    if (p.status !== 'pending') continue;
    const live = byId.get(p.flashscore_id || p.event_id);
    if (!live) continue;

    // Update cotes
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
  }
  return { cUpdated, rResolved };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`→ hourly-refresh v5 ${new Date().toISOString()} (all Flashscore)`);

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

  // ---------- FOOT (sport_id=1) ----------
  if (data.sports.foot) {
    let listResp;
    try {
      listResp = await fsFetch('/matches/list?sport_id=1&day=0');
    } catch (e) {
      console.error('  [WARN] foot list failed:', e.message);
      listResp = [];
    }
    const byId = indexMatchList(Array.isArray(listResp) ? listResp : []);
    console.log(`  foot: indexed ${byId.size} matches`);

    const footPronos = [];
    for (const league of data.sports.foot.leagues || []) {
      for (const p of league.pronos || []) footPronos.push(p);
    }
    const fr = refreshFromIndex(footPronos, byId, 'foot');
    cotesUpdated += fr.cUpdated;
    resolved += fr.rResolved;
  }

  // ---------- NON-FOOT via Flashscore ----------
  for (const [sportKey, sportId] of Object.entries(SPORT_ID_MAP)) {
    const sport = data.sports[sportKey];
    if (!sport) continue;

    // Collect pending pronos that have a flashscore_id
    const pendingFS = [];
    for (const league of sport.leagues || []) {
      for (const p of league.pronos || []) {
        if (p.status === 'pending' && p.flashscore_id) pendingFS.push(p);
      }
    }
    if (!pendingFS.length) continue;

    console.log(`  ${sportKey}: ${pendingFS.length} pending with flashscore_id`);

    // Fetch day=0 and day=-1 (to catch yesterday's late matches)
    let listResp = [];
    try {
      const [day0, dayMinus1] = await Promise.all([
        fsFetch(`/matches/list?sport_id=${sportId}&day=0`),
        fsFetch(`/matches/list?sport_id=${sportId}&day=-1`),
      ]);
      listResp = [
        ...(Array.isArray(day0) ? day0 : []),
        ...(Array.isArray(dayMinus1) ? dayMinus1 : []),
      ];
    } catch (e) {
      console.error(`  [WARN] ${sportKey} list failed:`, e.message);
      continue;
    }

    const byId = indexMatchList(listResp);
    console.log(`  ${sportKey}: indexed ${byId.size} matches`);

    const fr = refreshFromIndex(pendingFS, byId, sportKey);
    cotesUpdated += fr.cUpdated;
    resolved += fr.rResolved;
  }

  // ---------- LEGACY FALLBACK: Odds API for old pronos without flashscore_id ----------
  if (ODDS_API_KEY) {
    const legacyGroups = new Map();
    for (const [sportKey, sport] of Object.entries(data.sports)) {
      if (sportKey === 'foot') continue;
      for (const league of sport.leagues || []) {
        for (const p of league.pronos || []) {
          if (p.status !== 'pending') continue;
          if (p.flashscore_id) continue; // already handled above
          const ms = new Date(p.commence_time).getTime();
          if (ms > now) continue;
          if (!p.sport_key) continue;
          if (!legacyGroups.has(p.sport_key)) legacyGroups.set(p.sport_key, []);
          legacyGroups.get(p.sport_key).push(p);
        }
      }
    }

    for (const [sportKey, pronos] of legacyGroups) {
      console.log(`  legacy (odds-api): ${sportKey} has ${pronos.length} pending`);
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
        console.log(`    legacy resolved ${p.match}: ${res.actual_score} → ${res.status}`);
      }
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
