#!/usr/bin/env node
/*
 * recover-yesterday.js — one-shot script to recover resolved matches lost
 * during the v5 migration testing on 2026-04-12.
 *
 * Fetches yesterday's (day=-1) and today's (day=0) FINISHED matches from
 * Flashscore for foot, NBA, UFC, tennis. Creates history entries so that
 * syncBetsWithHistory() in the frontend can resolve pending Supabase bets.
 *
 * Usage:
 *   FLASHSCORE_KEY=xxx node scripts/recover-yesterday.js
 */

const fs = require('fs');
const path = require('path');

const FLASHSCORE_KEY = process.env.FLASHSCORE_KEY;
if (!FLASHSCORE_KEY) { console.error('ERROR: FLASHSCORE_KEY not set'); process.exit(1); }

const FS_HOST = 'flashscore4.p.rapidapi.com';
const FS_BASE = `https://${FS_HOST}/api/flashscore/v2`;
const JSON_PATH = path.join(__dirname, '..', 'pronos.json');

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
  if (remaining) console.log(`  quota remaining: ${remaining}`);
  return res.json();
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Same resolution logic as hourly-refresh.js
function resolveStatus(prono, homeScore, awayScore) {
  const h = homeScore, a = awayScore;
  if (!Number.isFinite(h) || !Number.isFinite(a)) return null;
  const actual = `${h}-${a}`;
  const draw = h === a;
  const homeWins = h > a;
  const actualResult = homeWins ? 'home' : draw ? 'draw' : 'away';
  const wonHome = prono === 'win-home' ? (homeWins ? 'won' : 'lost') : null;
  const wonAway = prono === 'win-away' ? (!homeWins && !draw ? 'won' : 'lost') : null;
  const wonDraw = prono === 'draw' ? (draw ? 'won' : 'lost') : null;
  const status = wonHome || wonAway || wonDraw || 'void';
  return { status, actual_score: actual, actual_result: actualResult };
}

// Sport configs: sportId, sportLabel, leagueLabel, filter, sportKey
const SPORT_CONFIGS = [
  {
    sportId: 1, sportLabel: '⚽ Football', sportKey: 'foot',
    filter: (name) => /^(FRANCE|ENGLAND|SPAIN|ITALY|GERMANY):|Champions League|Europa League|Conference League/i.test(name),
    leagueFromTournament: (name) => {
      if (/FRANCE/i.test(name)) return 'Ligue 1';
      if (/ENGLAND/i.test(name)) return 'Premier League';
      if (/SPAIN/i.test(name)) return 'LaLiga';
      if (/ITALY/i.test(name)) return 'Serie A';
      if (/GERMANY/i.test(name)) return 'Bundesliga';
      if (/Champions/i.test(name)) return 'Champions League';
      if (/Europa League/i.test(name)) return 'Europa League';
      if (/Conference/i.test(name)) return 'Conference League';
      return name;
    },
  },
  {
    sportId: 28, sportLabel: '🥊 MMA', sportKey: 'ufc',
    filter: (name) => /\bUFC\b|\bPFL\b|\bRIZIN\b/i.test(name),
    leagueFromTournament: () => 'UFC / MMA',
  },
  {
    sportId: 3, sportLabel: '🏀 Basketball', sportKey: 'nba',
    filter: (name) => /\bNBA\b/.test(name),
    leagueFromTournament: () => 'NBA',
  },
  {
    sportId: 2, sportLabel: '🎾 Tennis', sportKey: 'tennis',
    filter: (name) => /^(ATP|WTA)\s*-\s*SINGLES/i.test(name),
    leagueFromTournament: (name) => {
      const m = name.match(/^(ATP|WTA)\s*-\s*SINGLES:\s*(.+?)(?:\s*-\s*Qualification)?(?:,.*)?$/i);
      return m ? `${m[1]} ${m[2].trim()}` : name;
    },
  },
];

async function main() {
  console.log('→ recover-yesterday: fetching finished matches from day=-1 and day=0');

  const data = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  data.history = data.history || [];

  // Build a set of matches already in history to avoid duplicates
  const existingMatches = new Set(data.history.map((h) => h.match));
  // Also matches currently in active pronos (don't duplicate)
  for (const sport of Object.values(data.sports || {})) {
    for (const league of sport.leagues || []) {
      for (const p of league.pronos || []) {
        existingMatches.add(p.match);
      }
    }
  }

  let recovered = 0;

  for (const cfg of SPORT_CONFIGS) {
    console.log(`\n--- ${cfg.sportLabel} (sport_id=${cfg.sportId}) ---`);

    let allTournaments = [];
    for (const day of [-1, 0]) {
      try {
        const resp = await fsFetch(`/matches/list?sport_id=${cfg.sportId}&day=${day}`);
        if (Array.isArray(resp)) allTournaments.push(...resp);
      } catch (e) {
        console.error(`  [WARN] day=${day}: ${e.message}`);
      }
      await sleep(600);
    }

    for (const t of allTournaments) {
      const fullName = t.full_name || t.name || '';
      if (!cfg.filter(fullName)) continue;

      for (const m of t.matches || []) {
        // Only finished matches
        if (!m.match_status?.is_finished) continue;
        if (!m.scores || m.scores.home == null || m.scores.away == null) continue;

        const matchName = `${m.home_team?.name} vs ${m.away_team?.name}`;

        // Skip if already in history or active pronos
        if (existingMatches.has(matchName)) continue;

        const homeScore = parseInt(m.scores.home, 10);
        const awayScore = parseInt(m.scores.away, 10);
        if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) continue;

        // Reconstruct a default pick (favorite based on odds)
        const cHome = m.odds?.['1'] || 2;
        const cAway = m.odds?.['2'] || 2;
        let prono, pickName, cote;
        if (cHome <= cAway) {
          prono = 'win-home'; pickName = m.home_team.name; cote = cHome;
        } else {
          prono = 'win-away'; pickName = m.away_team.name; cote = cAway;
        }

        const res = resolveStatus(prono, homeScore, awayScore);
        if (!res) continue;

        const leagueLabel = cfg.leagueFromTournament(fullName);

        data.history.push({
          event_id: m.match_id,
          flashscore_id: m.match_id,
          sport_key: cfg.sportKey,
          commence_time: m.timestamp ? new Date(m.timestamp * 1000).toISOString() : null,
          home: m.home_team.name,
          away: m.away_team.name,
          match: matchName,
          prono,
          pari: `Victoire ${pickName}`,
          cote_retenue: cote,
          cotes: { domicile: cHome, exterieur: cAway },
          pick_category: '1x2',
          confiance: 3,
          status: res.status,
          actual_score: res.actual_score,
          actual_result: res.actual_result,
          sport_label: cfg.sportLabel,
          league_label: leagueLabel,
          archived_at: new Date().toISOString(),
        });

        existingMatches.add(matchName);
        recovered++;
        console.log(`  ✓ ${matchName} ${res.actual_score} → ${res.status} [${leagueLabel}]`);
      }
    }
  }

  // Cap history
  if (data.history.length > 500) data.history.splice(0, data.history.length - 500);

  if (recovered === 0) {
    console.log('\nNo matches to recover.');
    return;
  }

  data.meta = data.meta || {};
  data.meta.last_results_update = new Date().toISOString();

  fs.writeFileSync(JSON_PATH, JSON.stringify(data, null, 2) + '\n');
  console.log(`\n✓ recovered ${recovered} matches into history[]`);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
