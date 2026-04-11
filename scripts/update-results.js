#!/usr/bin/env node
/*
 * update-results.js
 * -----------------
 * Reads pronos.json, then for each prono with status="pending" whose match
 * has already started, fetches scores from The Odds API and updates the
 * status to "won" / "lost" / "void".
 *
 * Usage:
 *   ODDS_API_KEY=xxx node scripts/update-results.js
 *
 * Rate cost: 1 API call per sport_key that has at least one pending prono.
 * Scores endpoint: GET /v4/sports/{sport}/scores/?daysFrom=3&apiKey=...
 */

const fs = require('fs');
const path = require('path');

const API_KEY = process.env.ODDS_API_KEY;
if (!API_KEY) {
  console.error('ERROR: ODDS_API_KEY env var not set');
  process.exit(1);
}

const ODDS_BASE = 'https://api.the-odds-api.com/v4';
const JSON_PATH = path.join(__dirname, '..', 'pronos.json');

async function fetchScores(sportKey) {
  const params = new URLSearchParams({
    apiKey: API_KEY,
    daysFrom: '3',
    dateFormat: 'iso',
  });
  const url = `${ODDS_BASE}/sports/${sportKey}/scores/?${params}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status} for ${sportKey}: ${body.slice(0, 200)}`);
  }
  const remaining = res.headers.get('x-requests-remaining');
  if (remaining) console.log(`    quota remaining: ${remaining}`);
  return res.json();
}

function extractScores(event) {
  // Returns { homeScore, awayScore } or null if not completed
  if (!event.completed || !event.scores) return null;
  const out = {};
  for (const s of event.scores) {
    if (s.name === event.home_team) out.home = parseInt(s.score, 10);
    else if (s.name === event.away_team) out.away = parseInt(s.score, 10);
  }
  if (out.home == null || out.away == null) return null;
  return out;
}

function resolveStatus(prono, scores) {
  // For 2-outcome sports, draws shouldn't happen (NBA/MMA/tennis). If they do
  // (tie in MMA), mark as void.
  if (scores.home === scores.away) {
    if (prono.prono === 'draw') return { status: 'won', actual: `${scores.home}-${scores.away}` };
    return { status: 'void', actual: `${scores.home}-${scores.away}` };
  }
  const homeWins = scores.home > scores.away;
  const actualStr = `${scores.home}-${scores.away}`;
  if (prono.prono === 'win-home') {
    return { status: homeWins ? 'won' : 'lost', actual: actualStr };
  }
  if (prono.prono === 'win-away') {
    return { status: homeWins ? 'lost' : 'won', actual: actualStr };
  }
  if (prono.prono === 'draw') {
    return { status: 'lost', actual: actualStr };
  }
  return { status: 'void', actual: actualStr };
}

async function main() {
  console.log('→ Updating pronos.json results');

  const data = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  if (!data.sports) {
    console.error('ERROR: pronos.json has no sports section');
    process.exit(1);
  }

  // Build sport_key → [prono] map for events that are pending AND started
  const now = Date.now();
  const pendingBySport = new Map();
  for (const sport of Object.values(data.sports)) {
    for (const p of sport.pronos || []) {
      if (p.status !== 'pending') continue;
      const commenceMs = new Date(p.commence_time).getTime();
      if (commenceMs > now) continue; // not started yet
      const key = p.sport_key;
      if (!pendingBySport.has(key)) pendingBySport.set(key, []);
      pendingBySport.get(key).push(p);
    }
  }

  if (pendingBySport.size === 0) {
    console.log('  No pending matches to update.');
    return;
  }

  // Fetch scores for each needed sport and update pronos in place
  let updated = 0;
  for (const [sportKey, pronos] of pendingBySport) {
    console.log(`  · ${sportKey} (${pronos.length} pending)`);
    let events;
    try {
      events = await fetchScores(sportKey);
    } catch (err) {
      console.error(`    [WARN] ${err.message}`);
      continue;
    }
    const byId = new Map(events.map((e) => [e.id, e]));

    for (const p of pronos) {
      const event = byId.get(p.event_id);
      if (!event) continue;
      const scores = extractScores(event);
      if (!scores) continue;
      const { status, actual } = resolveStatus(p, scores);
      p.status = status;
      p.actual_score = actual;
      p.actual_result = scores.home > scores.away ? 'home' : scores.home < scores.away ? 'away' : 'draw';
      updated++;
      console.log(`    → ${p.match}: ${actual} (${status})`);
    }
  }

  data.meta = data.meta || {};
  data.meta.last_results_update = new Date().toISOString();

  fs.writeFileSync(JSON_PATH, JSON.stringify(data, null, 2) + '\n');
  console.log(`✓ ${updated} pronos updated, written to ${JSON_PATH}`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
