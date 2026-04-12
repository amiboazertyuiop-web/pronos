#!/usr/bin/env node
/*
 * probe-flashscore-sports.js — one-shot script to discover Flashscore sport_ids
 * Run manually via GitHub Actions to find out which sport_ids work for
 * basketball, MMA, tennis, etc.
 */

const FS_HOST = 'flashscore4.p.rapidapi.com';
const FS_BASE = `https://${FS_HOST}/api/flashscore/v2`;
const FLASHSCORE_KEY = process.env.FLASHSCORE_KEY;
if (!FLASHSCORE_KEY) { console.error('ERROR: FLASHSCORE_KEY not set'); process.exit(1); }

async function fsFetch(pathname) {
  const url = FS_BASE + pathname;
  const res = await fetch(url, {
    headers: { 'x-rapidapi-host': FS_HOST, 'x-rapidapi-key': FLASHSCORE_KEY },
  });
  const remaining = res.headers.get('x-ratelimit-requests-remaining');
  if (!res.ok) {
    const body = await res.text();
    return { error: res.status, body: body.slice(0, 150), remaining };
  }
  return { data: await res.json(), remaining };
}

async function main() {
  console.log('=== Probing Flashscore sport_ids 1-15 (day=0) ===\n');

  for (let id = 1; id <= 15; id++) {
    const result = await fsFetch(`/matches/list?sport_id=${id}&day=0`);

    if (result.error) {
      console.log(`sport_id=${id}  →  HTTP ${result.error}: ${result.body}`);
    } else {
      const tournaments = Array.isArray(result.data) ? result.data : [];
      const count = tournaments.length;
      const matchCount = tournaments.reduce((s, t) => s + (t.matches?.length || 0), 0);
      const sample = tournaments.slice(0, 5).map(t => {
        const name = t.full_name || t.name || '?';
        const mc = t.matches?.length || 0;
        // Show a sample match from each tournament
        const firstMatch = t.matches?.[0];
        const matchSample = firstMatch
          ? `  e.g. ${firstMatch.home_team?.name || '?'} vs ${firstMatch.away_team?.name || '?'}`
          : '';
        return `    ${name} (${mc} matches)${matchSample}`;
      });
      console.log(`sport_id=${id}  →  ${count} tournaments, ${matchCount} matches total`);
      if (sample.length) console.log(sample.join('\n'));
    }
    console.log(`    (quota remaining: ${result.remaining})\n`);
  }
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
