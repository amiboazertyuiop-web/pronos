#!/usr/bin/env node
/*
 * probe-flashscore-odds.js — discover what betting markets Flashscore returns
 * for tennis, basketball and MMA matches.
 * Run via GitHub Actions (workflow_dispatch).
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
    return { error: res.status, body: body.slice(0, 200), remaining };
  }
  return { data: await res.json(), remaining };
}

async function probeOddsForSport(sportId, sportName, filter) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`SPORT: ${sportName} (sport_id=${sportId})`);
  console.log('='.repeat(60));

  // Get today's matches
  const listResult = await fsFetch(`/matches/list?sport_id=${sportId}&day=0`);
  if (listResult.error) {
    console.log(`  list failed: HTTP ${listResult.error}`);
    return;
  }

  const tournaments = Array.isArray(listResult.data) ? listResult.data : [];

  // Find a match that passes the filter
  let targetMatch = null;
  let targetTournament = null;
  for (const t of tournaments) {
    const name = t.full_name || t.name || '';
    if (filter && !filter(name)) continue;
    for (const m of t.matches || []) {
      if (m.odds && m.odds['1']) {
        targetMatch = m;
        targetTournament = name;
        break;
      }
    }
    if (targetMatch) break;
  }

  if (!targetMatch) {
    console.log(`  No match with odds found for filter`);
    return;
  }

  console.log(`\nSelected match: ${targetMatch.home_team?.name} vs ${targetMatch.away_team?.name}`);
  console.log(`Tournament: ${targetTournament}`);
  console.log(`Match ID: ${targetMatch.match_id}`);
  console.log(`Inline odds: 1=${targetMatch.odds['1']} X=${targetMatch.odds['X'] || 'N/A'} 2=${targetMatch.odds['2']}`);

  // Now fetch full odds
  console.log(`\nFetching /matches/odds?match_id=${targetMatch.match_id} ...`);
  const oddsResult = await fsFetch(`/matches/odds?match_id=${targetMatch.match_id}`);
  if (oddsResult.error) {
    console.log(`  odds failed: HTTP ${oddsResult.error}: ${oddsResult.body}`);
    return;
  }

  const bookmakers = Array.isArray(oddsResult.data) ? oddsResult.data : [];
  console.log(`  ${bookmakers.length} bookmakers returned`);

  // Collect all unique bettingType + bettingScope combinations
  const marketTypes = new Map();
  for (const bm of bookmakers) {
    for (const m of bm.odds || []) {
      const key = `${m.bettingType} | ${m.bettingScope}`;
      if (!marketTypes.has(key)) {
        marketTypes.set(key, { count: 0, sampleOdds: [] });
      }
      const entry = marketTypes.get(key);
      entry.count++;
      // Collect sample odds (first 5)
      if (entry.sampleOdds.length < 5) {
        for (const o of (m.odds || []).slice(0, 3)) {
          entry.sampleOdds.push({
            participantId: o.eventParticipantId || null,
            value: o.value,
            selection: o.selection || null,
            handicap: o.handicap?.value || null,
            bothTeamsToScore: o.bothTeamsToScore ?? null,
            name: o.name || null,
          });
        }
      }
    }
  }

  console.log(`\n  AVAILABLE MARKETS (${marketTypes.size} types):`);
  for (const [key, info] of [...marketTypes.entries()].sort()) {
    console.log(`\n  📊 ${key}  (${info.count} bookmakers)`);
    console.log(`     Sample odds:`);
    for (const o of info.sampleOdds.slice(0, 6)) {
      const parts = [];
      if (o.selection) parts.push(`sel=${o.selection}`);
      if (o.handicap) parts.push(`hcap=${o.handicap}`);
      if (o.name) parts.push(`name=${o.name}`);
      if (o.bothTeamsToScore !== null) parts.push(`btts=${o.bothTeamsToScore}`);
      parts.push(`val=${o.value}`);
      if (o.participantId) parts.push(`pid=${o.participantId}`);
      console.log(`       ${parts.join(', ')}`);
    }
  }

  // Also probe H2H
  console.log(`\nFetching /matches/h2h?match_id=${targetMatch.match_id} ...`);
  const h2hResult = await fsFetch(`/matches/h2h?match_id=${targetMatch.match_id}`);
  if (h2hResult.error) {
    console.log(`  h2h failed: HTTP ${h2hResult.error}: ${h2hResult.body}`);
  } else {
    const h2h = Array.isArray(h2hResult.data) ? h2hResult.data : [];
    console.log(`  ${h2h.length} recent matches returned`);
    for (const m of h2h.slice(0, 5)) {
      const date = m.timestamp ? new Date(m.timestamp * 1000).toISOString().slice(0, 10) : '?';
      console.log(`    ${date} ${m.home_team?.name || '?'} ${m.scores?.home ?? '?'}-${m.scores?.away ?? '?'} ${m.away_team?.name || '?'} [${m.tournament_name_short || '?'}]`);
    }
  }

  console.log(`\n  (quota remaining: ${oddsResult.remaining})`);
}

async function main() {
  console.log('=== Probing Flashscore odds for Tennis, Basketball, MMA ===');

  await probeOddsForSport(2, 'Tennis', (name) => /^(ATP|WTA)\s*-\s*SINGLES/i.test(name));
  await probeOddsForSport(3, 'Basketball (NBA)', (name) => /\bNBA\b/.test(name));
  await probeOddsForSport(28, 'MMA/UFC', (name) => /\bUFC\b|\bPFL\b/i.test(name));
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
