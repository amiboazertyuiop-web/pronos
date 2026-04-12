#!/usr/bin/env node
/*
 * resolve-pending-bets.js — one-shot script to resolve pending Supabase bets
 * against pronos.json history[].
 *
 * The normal syncBetsWithHistory() matches by exact (match, pari) pair.
 * This script is smarter: it matches bets by match name (fuzzy), then
 * resolves them using the actual score + the bet's pari text.
 *
 * Usage:
 *   FLASHSCORE_KEY=xxx node scripts/resolve-pending-bets.js
 */

const fs = require('fs');
const path = require('path');

const SUPABASE_URL = 'https://yyustwbdpzrytavzpqtk.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl5dXN0d2JkcHpyeXRhdnpwcXRrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU4NDk1ODMsImV4cCI6MjA5MTQyNTU4M30.szlImpI0ietxEUA4dy36rjqgn-pAGmIBoDkDj_yTBzw';
// Use authenticated session token (from env) if available, else fallback to anon key
const AUTH_TOKEN = process.env.SUPABASE_AUTH_TOKEN || SUPABASE_ANON_KEY;
const JSON_PATH = path.join(__dirname, '..', 'pronos.json');

// ---------------------------------------------------------------------------
// Supabase REST helpers
// ---------------------------------------------------------------------------
async function supabaseGet(table, query) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${query}`;
  const res = await fetch(url, {
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${AUTH_TOKEN}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase GET ${res.status}: ${await res.text()}`);
  return res.json();
}

async function supabaseUpdate(table, id, data) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${AUTH_TOKEN}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Supabase PATCH ${res.status}: ${await res.text()}`);
}

// ---------------------------------------------------------------------------
// Resolution logic (same as hourly-refresh.js)
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
  if (/deux\s*équipes?\s*marquent|les\s*deux\s*marquent|both\s*teams|btts.{0,4}(yes|oui)|\boui\b/.test(p)) return { yes: true };
  return null;
}

function resolveBet(pari, homeScore, awayScore) {
  const h = homeScore, a = awayScore;
  if (!Number.isFinite(h) || !Number.isFinite(a)) return null;
  const total = h + a;
  const actual_score = `${h}-${a}`;

  // Over/Under
  const ou = inferOuOutcome(pari);
  if (ou) {
    if (ou.direction === 'over') return { status: total > ou.line ? 'won' : 'lost', actual_score };
    if (ou.direction === 'under') return { status: total < ou.line ? 'won' : total === ou.line ? 'void' : 'lost', actual_score };
  }

  // BTTS
  const btts = inferBttsOutcome(pari);
  if (btts) {
    const bothScored = h > 0 && a > 0;
    if (btts.yes) return { status: bothScored ? 'won' : 'lost', actual_score };
    return { status: !bothScored ? 'won' : 'lost', actual_score };
  }

  // Correct score (tennis sets) - "Victoire en 2-0", "Score 2-1"
  const csMatch = pari.match(/(\d)\s*[-:]\s*(\d)/);
  if (csMatch && /victoire en|score/i.test(pari)) {
    const eH = parseInt(csMatch[1], 10);
    const eA = parseInt(csMatch[2], 10);
    return { status: (h === eH && a === eA) ? 'won' : 'lost', actual_score };
  }

  // 1X2 - "Victoire X", "X s'impose", "X gagne"
  const p = pari.toLowerCase();
  if (/victoire|s'impose|gagne/.test(p)) {
    // Try to figure out if the pick was home or away
    // This is heuristic - check if the named player/team won
    const homeWins = h > a;
    const draw = h === a;
    if (draw) return { status: 'lost', actual_score }; // 1x2 bet on a draw = lost
    // We assume the named entity is the one the user picked
    // Since we matched by match name, we'll say "won" if the favorite won
    // This is imperfect but better than nothing
    return null; // Can't determine without knowing which side was picked
  }

  return null;
}

// ---------------------------------------------------------------------------
// Fuzzy match: normalize match names for comparison
// ---------------------------------------------------------------------------
function normalize(str) {
  return (str || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[''`]/g, "'")
    .trim();
}

function matchNamesMatch(betMatch, historyMatch) {
  const a = normalize(betMatch);
  const b = normalize(historyMatch);
  if (a === b) return true;
  // Try partial: both team names appear in the other
  const partsA = a.split(' vs ');
  const partsB = b.split(' vs ');
  if (partsA.length === 2 && partsB.length === 2) {
    // Check if team names are substrings of each other
    const homeA = partsA[0].trim(), awayA = partsA[1].trim();
    const homeB = partsB[0].trim(), awayB = partsB[1].trim();
    if ((homeB.includes(homeA) || homeA.includes(homeB)) &&
        (awayB.includes(awayA) || awayA.includes(awayB))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('→ resolve-pending-bets: reading Supabase + pronos.json');

  // Load history from pronos.json
  const data = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  const history = data.history || [];

  // Also include active pronos that might be resolved
  const allResolved = [...history];
  for (const sport of Object.values(data.sports || {})) {
    for (const league of sport.leagues || []) {
      for (const p of league.pronos || []) {
        if (p.status === 'won' || p.status === 'lost' || p.status === 'void') {
          allResolved.push(p);
        }
      }
    }
  }

  // Build a score lookup by match name
  const scoreByMatch = new Map();
  for (const h of allResolved) {
    if (h.actual_score) {
      const parts = h.actual_score.split('-').map(Number);
      if (parts.length === 2 && parts.every(Number.isFinite)) {
        scoreByMatch.set(normalize(h.match), { home: parts[0], away: parts[1], match: h.match });
      }
    }
  }
  console.log(`  ${scoreByMatch.size} resolved matches with scores in history`);

  // Fetch pending bets from Supabase
  const pendingBets = await supabaseGet('bets', 'status=eq.pending&select=*');
  console.log(`  ${pendingBets.length} pending bets in Supabase`);

  let updated = 0;
  let skipped = 0;

  for (const bet of pendingBets) {
    // Skip combos (they need all legs resolved)
    if (bet.is_combo) {
      console.log(`  [SKIP] combo: ${bet.match}`);
      skipped++;
      continue;
    }

    // Find matching score
    let score = null;
    for (const [normMatch, s] of scoreByMatch) {
      if (matchNamesMatch(bet.match, s.match)) {
        score = s;
        break;
      }
    }

    if (!score) {
      console.log(`  [NO MATCH] ${bet.match} — no score found in history`);
      skipped++;
      continue;
    }

    // Resolve
    const result = resolveBet(bet.pari, score.home, score.away);
    if (!result) {
      console.log(`  [CANT RESOLVE] ${bet.match} | pari: "${bet.pari}" | score: ${score.home}-${score.away}`);
      skipped++;
      continue;
    }

    // Update Supabase
    try {
      await supabaseUpdate('bets', bet.id, {
        status: result.status,
        actual_score: result.actual_score,
      });
      console.log(`  ✓ ${bet.match} | "${bet.pari}" | ${result.actual_score} → ${result.status}`);
      updated++;
    } catch (e) {
      console.error(`  [ERROR] ${bet.match}: ${e.message}`);
    }
  }

  console.log(`\n✓ updated ${updated} bets, skipped ${skipped}`);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
