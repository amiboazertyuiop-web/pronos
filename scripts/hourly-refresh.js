#!/usr/bin/env node
/*
 * hourly-refresh.js — lightweight cote/score refresh, runs every hour
 * ---------------------------------------------------------------------
 * Spends EXACTLY 1 Flashscore request per run to:
 *   1. Fetch the full foot match list for day=0 (which carries odds.1/2/X +
 *      scores + match status inline for every match of the day)
 *   2. For each pending foot prono in pronos.json:
 *      - Update cotes.domicile / cotes.nul / cotes.exterieur from the fresh
 *        list data
 *      - If pick_category is "1x2", also update cote_retenue so the display
 *        card stays accurate
 *      - For other pick categories (ou/btts/dc/dnb) the cote_retenue stays
 *        at its 7am value — those markets need /matches/odds which we avoid
 *        here to keep the hourly run dirt-cheap. They get refreshed at the
 *        next 7am morning run.
 *   3. Detect finished matches and resolve their status via the scores that
 *      ship inside the same list response. Move resolved pronos to history[].
 *   4. Write pronos.json only if something actually changed.
 *
 * Usage:
 *   FLASHSCORE_KEY=xxx node scripts/hourly-refresh.js
 *
 * Does NOT need ODDS_API_KEY — only uses Flashscore. NBA/UFC/tennis pronos
 * are not refreshed between morning runs (they only move at daily cadence).
 */

const fs = require('fs');
const path = require('path');

const FLASHSCORE_KEY = process.env.FLASHSCORE_KEY;
if (!FLASHSCORE_KEY) { console.error('ERROR: FLASHSCORE_KEY env var not set'); process.exit(1); }

const FS_HOST = 'flashscore4.p.rapidapi.com';
const FS_BASE = `https://${FS_HOST}/api/flashscore/v2`;
const JSON_PATH = path.join(__dirname, '..', 'pronos.json');

async function fsFetch(pathname) {
  const url = FS_BASE + pathname;
  const res = await fetch(url, {
    headers: {
      'x-rapidapi-host': FS_HOST,
      'x-rapidapi-key': FLASHSCORE_KEY,
    },
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
// Build a map: match_id → { cotes, status, scores } from the list response
// ---------------------------------------------------------------------------
function indexListResponse(tournaments) {
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

function resolveStatus(prono, scores) {
  const h = scores.home;
  const a = scores.away;
  if (typeof h !== 'number' || typeof a !== 'number') return null;
  const actual = `${h}-${a}`;
  const draw = h === a;
  const homeWins = h > a;

  // Non-1X2 picks: we can't verify over/under/btts/etc. from a simple
  // home-away score without parsing both teams' goals properly. For now,
  // keep them pending and let the morning run handle them via /matches/details
  // (which exposes richer per-market resolution). Only resolve 1X2/DNB here.
  if (prono.pick_category && prono.pick_category !== '1x2' && prono.pick_category !== 'dnb') {
    return null;
  }

  if (prono.pick_category === 'dnb') {
    if (draw) return { status: 'void', actual_score: actual, actual_result: 'draw' };
    if (prono.prono === 'win-home') return { status: homeWins ? 'won' : 'lost', actual_score: actual, actual_result: homeWins ? 'home' : 'away' };
    if (prono.prono === 'win-away') return { status: !homeWins && !draw ? 'won' : 'lost', actual_score: actual, actual_result: homeWins ? 'home' : 'away' };
  }

  // 1X2
  if (draw) {
    return { status: prono.prono === 'draw' ? 'won' : 'lost', actual_score: actual, actual_result: 'draw' };
  }
  if (prono.prono === 'win-home') return { status: homeWins ? 'won' : 'lost', actual_score: actual, actual_result: homeWins ? 'home' : 'away' };
  if (prono.prono === 'win-away') return { status: !homeWins ? 'won' : 'lost', actual_score: actual, actual_result: homeWins ? 'home' : 'away' };
  if (prono.prono === 'draw') return { status: 'lost', actual_score: actual, actual_result: homeWins ? 'home' : 'away' };
  return null;
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

  if (!data.sports || !data.sports.foot) {
    console.log('  no foot sport in pronos.json, nothing to do');
    return;
  }

  // 1 request total
  const listResp = await fsFetch('/matches/list?sport_id=1&day=0');
  const byId = indexListResponse(listResp);
  console.log(`  indexed ${byId.size} foot matches from list`);

  let cotesUpdated = 0;
  let resolved = 0;

  for (const league of data.sports.foot.leagues || []) {
    for (const p of league.pronos || []) {
      if (p.status !== 'pending') continue;
      const live = byId.get(p.flashscore_id || p.event_id);
      if (!live) continue;

      // Update cotes from the fresh list response
      if (live.cotes && live.cotes.domicile) {
        const oldHome = p.cotes && p.cotes.domicile;
        const oldAway = p.cotes && p.cotes.exterieur;
        const oldDraw = p.cotes && p.cotes.nul;
        const newHome = live.cotes.domicile;
        const newAway = live.cotes.exterieur;
        const newDraw = live.cotes.nul;
        if (oldHome !== newHome || oldAway !== newAway || oldDraw !== newDraw) {
          p.cotes = { domicile: newHome, nul: newDraw, exterieur: newAway };
          // Keep cote_retenue aligned for 1X2 picks only. Other pick_categories
          // need /matches/odds data which we don't have here.
          if (p.pick_category === '1x2' || !p.pick_category) {
            if (p.prono === 'win-home') p.cote_retenue = newHome;
            else if (p.prono === 'win-away') p.cote_retenue = newAway;
            else if (p.prono === 'draw' && newDraw) p.cote_retenue = newDraw;
          } else if (p.pick_category === 'dnb') {
            // Draw-no-bet cote isn't in the list — leave cote_retenue as-is.
          }
          cotesUpdated++;
        }
      }

      // Resolve finished matches
      if (live.status && live.status.is_finished && live.scores) {
        const res = resolveStatus(p, live.scores);
        if (res) {
          p.status = res.status;
          p.actual_score = res.actual_score;
          p.actual_result = res.actual_result;
          resolved++;
          console.log(`  resolved ${p.match}: ${res.actual_score} (${res.status})`);
        }
      }
    }
  }

  // Archive resolved pronos to history[]
  let archived = 0;
  if (resolved > 0) {
    data.history = data.history || [];
    for (const league of data.sports.foot.leagues || []) {
      const keep = [];
      for (const p of league.pronos || []) {
        if (p.status === 'won' || p.status === 'lost' || p.status === 'void') {
          data.history.push({
            ...p,
            sport_label: data.sports.foot.label,
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
    if (data.history.length > 500) data.history.splice(0, data.history.length - 500);
  }

  // Update meta
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
