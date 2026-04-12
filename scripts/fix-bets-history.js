#!/usr/bin/env node
/*
 * fix-bets-history.js — inject targeted history entries that match the exact
 * (match, pari) pairs from Nicolas's pending Supabase bets.
 *
 * This is a one-shot transition fix. In normal operation, the hourly creates
 * history entries with the correct pari from the active pronos.
 */

const fs = require('fs');
const path = require('path');

const FS_HOST = 'flashscore4.p.rapidapi.com';
const FS_BASE = `https://${FS_HOST}/api/flashscore/v2`;
const FLASHSCORE_KEY = process.env.FLASHSCORE_KEY;
if (!FLASHSCORE_KEY) { console.error('ERROR: FLASHSCORE_KEY not set'); process.exit(1); }

const JSON_PATH = path.join(__dirname, '..', 'pronos.json');

async function fsFetch(pathname) {
  const url = FS_BASE + pathname;
  const res = await fetch(url, {
    headers: { 'x-rapidapi-host': FS_HOST, 'x-rapidapi-key': FLASHSCORE_KEY },
  });
  if (!res.ok) return null;
  return res.json();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------------------
function resolveOu(pari, homeScore, awayScore) {
  const p = pari.toLowerCase();
  // Match "X.X buts/jeux/points/rounds" or "plus/moins de X.X"
  let m = p.match(/([0-9]+(?:[.,][0-9]+)?)\s*(?:but|jeu|game|point|round)/);
  if (!m) m = p.match(/(?:plus|over|moins|under)[^0-9]*([0-9]+(?:[.,][0-9]+)?)/);
  if (!m) return null;
  const line = parseFloat(m[1].replace(',', '.'));
  if (!isFinite(line)) return null;
  const total = homeScore + awayScore;
  const isOver = /\b(plus|over|\+)\b/i.test(p);
  const isUnder = /\b(moins|under)\b/i.test(p);
  if (isOver) return total > line ? 'won' : 'lost';
  if (isUnder) return total < line ? 'won' : total === line ? 'void' : 'lost';
  return null;
}

function resolveBtts(pari, homeScore, awayScore) {
  const p = pari.toLowerCase();
  const bothScored = homeScore > 0 && awayScore > 0;
  if (/oui|yes|deux\s*équipes?\s*marquent|les\s*deux\s*marquent/i.test(p)) return bothScored ? 'won' : 'lost';
  if (/non|no|pas de but/i.test(p)) return !bothScored ? 'won' : 'lost';
  return null;
}

function resolveCs(pari, homeScore, awayScore) {
  const m = pari.match(/(\d)\s*[-:]\s*(\d)/);
  if (!m) return null;
  return (homeScore === parseInt(m[1]) && awayScore === parseInt(m[2])) ? 'won' : 'lost';
}

function resolve1x2(pari, home, away, homeScore, awayScore) {
  const p = pari.toLowerCase();
  const h = home.toLowerCase();
  const a = away.toLowerCase();
  const homeWins = homeScore > awayScore;
  const awayWins = awayScore > homeScore;

  // Try to detect who the pick is for
  if (p.includes(a.split(' ')[0].toLowerCase()) || p.includes(a.toLowerCase())) {
    return awayWins ? 'won' : 'lost';
  }
  if (p.includes(h.split(' ')[0].toLowerCase()) || p.includes(h.toLowerCase())) {
    return homeWins ? 'won' : 'lost';
  }
  return null;
}

function resolveBet(pari, home, away, homeScore, awayScore) {
  const p = pari.toLowerCase();

  // Over/Under
  if (/over|under|plus de|moins de|\d+[.,]\d+\s*(but|jeu|point|round)/i.test(p)) {
    return resolveOu(pari, homeScore, awayScore);
  }

  // BTTS
  if (/deux\s*équipes|btts|les\s*deux\s*marquent|marquent.*oui/i.test(p)) {
    return resolveBtts(pari, homeScore, awayScore);
  }

  // Correct score (set betting)
  if (/victoire en \d|score \d/i.test(p)) {
    return resolveCs(pari, homeScore, awayScore);
  }

  // 1X2
  if (/victoire|s'impose|gagne/i.test(p)) {
    return resolve1x2(pari, home, away, homeScore, awayScore);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('→ fix-bets-history: injecting targeted history entries');

  const data = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  data.history = data.history || [];

  // Existing score lookup from history
  const scoreMap = new Map();
  for (const h of data.history) {
    if (h.actual_score && h.match) {
      scoreMap.set(h.match, h.actual_score);
    }
  }

  // Fetch UFC results from day=-2 and day=-1 (the old recovery missed them)
  console.log('\n--- Fetching UFC results (day=-2, -1, 0) ---');
  const ufcMatches = new Map();
  for (const day of [-2, -1, 0]) {
    const resp = await fsFetch(`/matches/list?sport_id=28&day=${day}`);
    if (!resp || !Array.isArray(resp)) continue;
    for (const t of resp) {
      for (const m of t.matches || []) {
        if (m.match_status?.is_finished && m.scores) {
          const name = `${m.home_team?.name} vs ${m.away_team?.name}`;
          ufcMatches.set(name, {
            home: m.home_team?.name,
            away: m.away_team?.name,
            homeScore: parseInt(m.scores.home, 10),
            awayScore: parseInt(m.scores.away, 10),
          });
          console.log(`  UFC found: ${name} ${m.scores.home}-${m.scores.away}`);
        }
      }
    }
    await sleep(600);
  }

  // Nicolas's pending bets that need resolution
  const pendingBets = [
    { match: 'Genoa vs Sassuolo', pari: 'Over 2.5 buts' },
    { match: 'Jiri Prochazka vs Carlos Ulberg', pari: 'Victoire Carlos Ulberg' },
    { match: 'Dominick Reyes vs Johnny Walker', pari: 'Victoire Dominick Reyes' },
    { match: 'Curtis Blaydes vs Josh Hokit', pari: "Curtis Blaydes s'impose" },
    { match: 'Azamat Murzakanov vs Paulo Henrique Costa', pari: 'Victoire Murzakanov' },
    { match: 'Cub Swanson vs Nate Landwehr', pari: 'Victoire Cub Swanson' },
  ];

  // Known scores (from history + manual UFC results from Nicolas)
  const knownScores = {
    'Genoa vs Sassuolo': { home: 'Genoa', away: 'Sassuolo', homeScore: 2, awayScore: 1 },
    // UFC results confirmed manually by Nicolas (Flashscore doesn't keep them past day=-1)
    'Jiri Prochazka vs Carlos Ulberg': { home: 'Jiri Prochazka', away: 'Carlos Ulberg', homeScore: 0, awayScore: 1 },
    'Dominick Reyes vs Johnny Walker': { home: 'Dominick Reyes', away: 'Johnny Walker', homeScore: 1, awayScore: 0 },
    'Curtis Blaydes vs Josh Hokit': { home: 'Curtis Blaydes', away: 'Josh Hokit', homeScore: 0, awayScore: 1 },
    'Azamat Murzakanov vs Paulo Henrique Costa': { home: 'Azamat Murzakanov', away: 'Paulo Henrique Costa', homeScore: 0, awayScore: 1 },
    'Cub Swanson vs Nate Landwehr': { home: 'Cub Swanson', away: 'Nate Landwehr', homeScore: 1, awayScore: 0 },
  };

  // Merge any UFC scores found on Flashscore
  for (const [name, s] of ufcMatches) {
    if (!knownScores[name]) knownScores[name] = s;
  }

  let injected = 0;
  const existingKeys = new Set(data.history.map(h => (h.match || '') + '|' + (h.pari || '')));

  for (const bet of pendingBets) {
    const key = bet.match + '|' + bet.pari;
    if (existingKeys.has(key)) {
      console.log(`  [ALREADY] ${bet.match} | ${bet.pari}`);
      continue;
    }

    // Find score - exact match first, then fuzzy
    let score = knownScores[bet.match];
    if (!score) {
      // Fuzzy: try matching by first word of each team
      const parts = bet.match.split(' vs ');
      if (parts.length === 2) {
        for (const [name, s] of Object.entries(knownScores)) {
          const np = name.split(' vs ');
          if (np.length === 2 &&
              np[0].toLowerCase().includes(parts[0].toLowerCase().split(' ')[0]) &&
              np[1].toLowerCase().includes(parts[1].toLowerCase().split(' ')[0])) {
            score = s;
            break;
          }
        }
        // Also check UFC map with fuzzy
        if (!score) {
          for (const [name, s] of ufcMatches) {
            const np = name.split(' vs ');
            if (np.length === 2 &&
                (np[0].toLowerCase().includes(parts[0].toLowerCase().split(' ')[0]) ||
                 parts[0].toLowerCase().includes(np[0].toLowerCase().split(' ')[0])) &&
                (np[1].toLowerCase().includes(parts[1].toLowerCase().split(' ')[0]) ||
                 parts[1].toLowerCase().includes(np[1].toLowerCase().split(' ')[0]))) {
              score = s;
              break;
            }
          }
        }
      }
    }

    if (!score) {
      console.log(`  [NO SCORE] ${bet.match}`);
      continue;
    }

    const status = resolveBet(bet.pari, score.home, score.away, score.homeScore, score.awayScore);
    if (!status) {
      console.log(`  [CANT RESOLVE] ${bet.match} | "${bet.pari}" | ${score.homeScore}-${score.awayScore}`);
      continue;
    }

    data.history.push({
      match: bet.match,
      pari: bet.pari,
      home: score.home,
      away: score.away,
      status,
      actual_score: `${score.homeScore}-${score.awayScore}`,
      actual_result: score.homeScore > score.awayScore ? 'home' : score.homeScore < score.awayScore ? 'away' : 'draw',
      pick_category: /over|under|plus|moins/i.test(bet.pari) ? 'ou' : /deux.*marquent|btts/i.test(bet.pari) ? 'btts' : '1x2',
      cote_retenue: 1.80,
      confiance: 3,
      sport_label: /prochazka|blaydes|swanson|reyes|murzakanov/i.test(bet.match) ? '🥊 MMA' : '⚽ Football',
      league_label: /prochazka|blaydes|swanson|reyes|murzakanov/i.test(bet.match) ? 'UFC / MMA' : 'Serie A',
      archived_at: new Date().toISOString(),
    });

    existingKeys.add(key);
    injected++;
    console.log(`  ✓ ${bet.match} | "${bet.pari}" | ${score.homeScore}-${score.awayScore} → ${status}`);
  }

  if (injected === 0) {
    console.log('\nNothing to inject.');
    return;
  }

  // Cap history
  if (data.history.length > 500) data.history.splice(0, data.history.length - 500);

  fs.writeFileSync(JSON_PATH, JSON.stringify(data, null, 2) + '\n');
  console.log(`\n✓ injected ${injected} targeted history entries`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
