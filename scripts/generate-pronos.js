#!/usr/bin/env node
/*
 * generate-pronos.js (v5.0) — full daily pipeline for Coach Parie
 * ----------------------------------------------------------------
 * Runs once per day at 07:00 Paris from GitHub Actions.
 *
 * v5 migration: ALL sports now use Flashscore as the single data source.
 * The Odds API dependency has been fully removed.
 *
 * Responsibilities:
 *   1. Load existing pronos.json (to inherit history[])
 *   2. Fetch TODAY's matches (next 24h window) from Flashscore:
 *        - Football  (sport_id=1)  — all target leagues + built-in odds
 *        - Basketball (sport_id=3) — NBA only
 *        - MMA        (sport_id=28) — UFC, PFL, RIZIN
 *        - Tennis     (sport_id=2)  — ATP + WTA singles
 *   3. Build prono objects with default pick (favorite) and empty `analyse`
 *   4. For foot matches, fetch H2H + all betting markets from Flashscore
 *   5. Compute coup-de-cœur (top 10 picks)
 *   6. Write pronos.json
 *
 * Usage:
 *   FLASHSCORE_KEY=xxx node scripts/generate-pronos.js
 *
 * Budget targets (Flashscore Pro — 1000 req/day):
 *   - Foot:   ~65 req/day (2 list + ~40 h2h + ~40 odds)
 *   - NBA:     2 req/day  (list day=0 + day=1)
 *   - MMA:     2 req/day  (list day=0 + day=1)
 *   - Tennis:  2 req/day  (list day=0 + day=1)
 *   - Total:  ~71 req/day → ~2100/month (well under 30 000)
 */

const fs = require('fs');
const path = require('path');

const FLASHSCORE_KEY = process.env.FLASHSCORE_KEY;
if (!FLASHSCORE_KEY) { console.error('ERROR: FLASHSCORE_KEY env var not set'); process.exit(1); }

const FS_HOST = 'flashscore4.p.rapidapi.com';
const FS_BASE = `https://${FS_HOST}/api/flashscore/v2`;
const JSON_PATH = path.join(__dirname, '..', 'pronos.json');
const WINDOW_HOURS = 24;
const MAX_COUP_DE_COEUR = 10;
const MIN_COUP_DE_COEUR_COTE = 1.25;

// ---------------------------------------------------------------------------
// League config (football — Flashscore tournaments we care about)
// ---------------------------------------------------------------------------
const FOOT_LEAGUES = [
  { key: 'ligue1', label: 'Ligue 1',          flag: '🇫🇷', country: 'France',     pattern: /^FRANCE: Ligue 1$/i },
  { key: 'epl',    label: 'Premier League',   flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', country: 'Angleterre', pattern: /^ENGLAND: Premier League$/i },
  { key: 'liga',   label: 'LaLiga',           flag: '🇪🇸', country: 'Espagne',    pattern: /^SPAIN: LaLiga$/i },
  { key: 'seriea', label: 'Serie A',          flag: '🇮🇹', country: 'Italie',     pattern: /^ITALY: Serie A$/i },
  { key: 'bundes', label: 'Bundesliga',       flag: '🇩🇪', country: 'Allemagne',  pattern: /^GERMANY: Bundesliga$/i },
  { key: 'ucl',    label: 'Champions League', flag: '🏆', country: 'Europe',      pattern: /Champions League - (Play Offs|Knockout|Quarter|Semi|Final|Group)/i },
  { key: 'uel',    label: 'Europa League',    flag: '🥈', country: 'Europe',      pattern: /Europa League - (Play Offs|Knockout|Quarter|Semi|Final|Group)/i },
  { key: 'uecl',   label: 'Conference League',flag: '🥉', country: 'Europe',      pattern: /Conference League - (Play Offs|Knockout|Quarter|Semi|Final|Group)/i },
];

// ---------------------------------------------------------------------------
// Non-foot sport config
// ---------------------------------------------------------------------------
const NBA_FILTER = (name) => /\bNBA\b/.test(name);
const UFC_FILTER = (name) => /\bUFC\b|\bPFL\b|\bRIZIN\b|\bBellator\b|\bONE\s+Championship\b/i.test(name);
const TENNIS_FILTER = (name) => /^(ATP|WTA)\s*-\s*SINGLES:/i.test(name);

// ---------------------------------------------------------------------------
// Simple fetch helper with error handling + quota logging
// ---------------------------------------------------------------------------
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
    throw new Error(`Flashscore HTTP ${res.status} for ${pathname}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------
function formatTimeFr(ts) {
  const d = new Date(ts * 1000);
  const days = ['Dim.', 'Lun.', 'Mar.', 'Mer.', 'Jeu.', 'Ven.', 'Sam.'];
  const hh = d.getUTCHours().toString().padStart(2, '0');
  const mm = d.getUTCMinutes().toString().padStart(2, '0');
  return `${days[d.getUTCDay()]} ${hh}h${mm} UTC`;
}

function confidenceFromCote(cote) {
  if (cote < 1.25) return 5;
  if (cote < 1.50) return 4;
  if (cote < 2.00) return 3;
  if (cote < 3.00) return 2;
  return 1;
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ---------------------------------------------------------------------------
// Generic: fetch + deduplicate Flashscore tournaments for a given sport_id
// ---------------------------------------------------------------------------
async function fetchFlashscoreTournaments(sportId) {
  const [today, tomorrow] = await Promise.all([
    fsFetch(`/matches/list?sport_id=${sportId}&day=0`),
    fsFetch(`/matches/list?sport_id=${sportId}&day=1`),
  ]);
  const all = [
    ...(Array.isArray(today) ? today : []),
    ...(Array.isArray(tomorrow) ? tomorrow : []),
  ];

  // Deduplicate tournaments by tournament_id, merge their matches
  const tournamentMap = new Map();
  for (const t of all) {
    const existing = tournamentMap.get(t.tournament_id);
    if (existing) {
      const seenIds = new Set(existing.matches.map((m) => m.match_id));
      for (const m of t.matches) if (!seenIds.has(m.match_id)) existing.matches.push(m);
    } else {
      tournamentMap.set(t.tournament_id, { ...t, matches: [...(t.matches || [])] });
    }
  }
  return tournamentMap;
}

// ---------------------------------------------------------------------------
// Generic: filter matches from tournaments within the 24h window
// ---------------------------------------------------------------------------
function filterMatches(tournamentMap, filter, windowStartMs, windowEndMs) {
  const matches = [];
  for (const t of tournamentMap.values()) {
    const fullName = t.full_name || t.name || '';
    if (!filter(fullName)) continue;
    for (const m of t.matches || []) {
      if (!m.timestamp) continue;
      const ms = m.timestamp * 1000;
      if (ms < windowStartMs || ms > windowEndMs) continue;
      if (!m.odds || !m.odds['1'] || !m.odds['2']) continue;
      if (m.match_status && (m.match_status.is_started || m.match_status.is_finished)) continue;
      matches.push({ raw: m, tournament: t });
    }
  }
  return matches;
}

// ---------------------------------------------------------------------------
// Build a prono object from a Flashscore match (works for any sport)
// ---------------------------------------------------------------------------
function buildProno(raw, tournament, sportKey, flashscoreSportId) {
  const cHome = raw.odds['1'];
  const cAway = raw.odds['2'];
  const cDraw = raw.odds['X'] || null;
  let prono, cote, pickName;
  if (cHome <= cAway) {
    prono = 'win-home'; cote = cHome; pickName = raw.home_team.name;
  } else {
    prono = 'win-away'; cote = cAway; pickName = raw.away_team.name;
  }
  return {
    event_id: raw.match_id,
    flashscore_id: raw.match_id,
    flashscore_sport_id: flashscoreSportId,
    home_team_id: raw.home_team.team_id || null,
    away_team_id: raw.away_team.team_id || null,
    tournament_id: tournament.tournament_id || null,
    tournament_url: tournament.tournament_url || '',
    sport_key: sportKey,
    commence_time: new Date(raw.timestamp * 1000).toISOString(),
    time_display: formatTimeFr(raw.timestamp),
    home: raw.home_team.name,
    away: raw.away_team.name,
    match: `${raw.home_team.name} vs ${raw.away_team.name}`,
    prono,
    pari: `Victoire ${pickName}`,
    cote_retenue: cote,
    cotes: { domicile: cHome, nul: cDraw, exterieur: cAway },
    pick_category: '1x2',
    analyse: '',
    confiance: confidenceFromCote(cote),
    featured: cote < 1.35,
    score_prevu: null,
    status: 'pending',
    actual_score: null,
    actual_result: null,
    coup_de_coeur: false,
    stats: null,
    markets: null,
  };
}

// ---------------------------------------------------------------------------
// FOOT — fetch via Flashscore, group by our target leagues
// ---------------------------------------------------------------------------
async function fetchFootMatches(windowStartMs, windowEndMs) {
  console.log('  · foot via Flashscore (sport_id=1)');
  const tournamentMap = await fetchFlashscoreTournaments(1);

  const leaguesOut = [];
  for (const cfg of FOOT_LEAGUES) {
    const matches = filterMatches(tournamentMap, (name) => cfg.pattern.test(name), windowStartMs, windowEndMs);
    if (!matches.length) continue;

    const pronos = matches.map(({ raw, tournament }) =>
      buildProno(raw, tournament, 'flashscore_football_' + cfg.key, 1)
    );
    pronos.sort((a, b) =>
      new Date(a.commence_time) - new Date(b.commence_time) ||
      a.cote_retenue - b.cote_retenue
    );

    leaguesOut.push({
      key: cfg.key,
      sport_key: 'flashscore_football_' + cfg.key,
      label: cfg.label,
      flag: cfg.flag,
      country: cfg.country,
      panel_title: `${cfg.flag} ${cfg.label} — ${cfg.country}`,
      panel_meta: `Matchs des prochaines 24h`,
      pronos,
    });
  }
  return leaguesOut;
}

// ---------------------------------------------------------------------------
// NBA / UFC / TENNIS — all via Flashscore now (v5 migration)
// ---------------------------------------------------------------------------
async function fetchNonFoot(windowStartMs, windowEndMs) {
  const result = { nba: null, ufc: null, tennis: null };

  // --- NBA (sport_id=3) ---
  console.log('  · nba via Flashscore (sport_id=3)');
  try {
    const tournaments = await fetchFlashscoreTournaments(3);
    const matches = filterMatches(tournaments, NBA_FILTER, windowStartMs, windowEndMs);
    const pronos = matches.map(({ raw, tournament }) =>
      buildProno(raw, tournament, 'flashscore_basketball_nba', 3)
    );
    pronos.sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time));
    console.log(`    found ${pronos.length} NBA matches`);
    if (pronos.length) {
      result.nba = {
        key: 'nba',
        sport_key: 'flashscore_basketball_nba',
        label: 'NBA',
        flag: '🏀',
        country: 'USA',
        panel_title: '🏀 NBA',
        panel_meta: 'Matchs des prochaines 24h',
        pronos,
      };
    }
  } catch (e) { console.error('    [WARN] nba:', e.message); }

  // --- UFC / MMA (sport_id=28) ---
  console.log('  · ufc via Flashscore (sport_id=28)');
  try {
    const tournaments = await fetchFlashscoreTournaments(28);
    const matches = filterMatches(tournaments, UFC_FILTER, windowStartMs, windowEndMs);
    const pronos = matches.map(({ raw, tournament }) =>
      buildProno(raw, tournament, 'flashscore_mma', 28)
    );
    pronos.sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time));
    console.log(`    found ${pronos.length} MMA matches`);
    if (pronos.length) {
      result.ufc = {
        key: 'mma',
        sport_key: 'flashscore_mma',
        label: 'UFC / MMA',
        flag: '🥊',
        country: 'Mondial',
        panel_title: '🥊 UFC / MMA',
        panel_meta: 'Combats des prochaines 24h',
        pronos,
      };
    }
  } catch (e) { console.error('    [WARN] ufc:', e.message); }

  // --- Tennis (sport_id=2) ---
  console.log('  · tennis via Flashscore (sport_id=2)');
  try {
    const tournaments = await fetchFlashscoreTournaments(2);
    const matches = filterMatches(tournaments, TENNIS_FILTER, windowStartMs, windowEndMs);
    const pronos = matches.map(({ raw, tournament }) =>
      buildProno(raw, tournament, 'flashscore_tennis', 2)
    );
    pronos.sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time));
    console.log(`    found ${pronos.length} tennis matches`);
    if (pronos.length) {
      // Extract the most prominent tournament name for the label
      const tournamentCounts = new Map();
      for (const { tournament } of matches) {
        const name = tournament.full_name || tournament.name || '';
        tournamentCounts.set(name, (tournamentCounts.get(name) || 0) + 1);
      }
      let mainTournament = 'Tennis';
      let maxCount = 0;
      for (const [name, count] of tournamentCounts) {
        if (count > maxCount) { maxCount = count; mainTournament = name; }
      }
      // Clean up: "ATP - SINGLES: Monte Carlo (Monaco), clay" → "ATP Monte-Carlo"
      const labelMatch = mainTournament.match(/^(ATP|WTA)\s*-\s*SINGLES:\s*(.+?)(?:\s*-\s*Qualification)?(?:,\s*.+)?$/i);
      const cleanLabel = labelMatch ? `${labelMatch[1]} ${labelMatch[2].trim()}` : mainTournament;

      result.tennis = {
        key: 'tennis',
        sport_key: 'flashscore_tennis',
        label: cleanLabel,
        flag: '🎾',
        country: '',
        panel_title: `🎾 ${cleanLabel}`,
        panel_meta: 'Matchs des prochaines 24h',
        pronos,
      };
    }
  } catch (e) { console.error('    [WARN] tennis:', e.message); }

  return result;
}

// ---------------------------------------------------------------------------
// Note: result resolution and history archiving are now owned exclusively by
// scripts/hourly-refresh.js. The daily run only builds new pronos and
// preserves the existing history[] untouched.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Compute coup-de-cœur (ranking) then enrich foot picks with H2H
// ---------------------------------------------------------------------------
function computeCoupDeCoeur(allPronos) {
  const candidates = allPronos
    .filter((p) => p.cote_retenue >= MIN_COUP_DE_COEUR_COTE)
    .sort((a, b) => b.confiance - a.confiance || b.cote_retenue - a.cote_retenue);
  const top = candidates.slice(0, MAX_COUP_DE_COEUR);
  for (const p of top) p.coup_de_coeur = true;
  return top.map((p) => p.event_id);
}

const MAX_FOOT_ENRICHMENTS = 40;

// ---------------------------------------------------------------------------
// Parse the /matches/odds response into agent-friendly markets structure
// ---------------------------------------------------------------------------
function round2(v) {
  return v && isFinite(v) ? parseFloat(v.toFixed(2)) : null;
}

function parseMarkets(raw, knownHome1X2, knownAway1X2) {
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const partOddsMap = new Map();
  for (const bm of raw) {
    for (const m of bm.odds || []) {
      if (m.bettingType !== 'HOME_DRAW_AWAY' || m.bettingScope !== 'FULL_TIME') continue;
      for (const o of m.odds || []) {
        if (!o.eventParticipantId) continue;
        const v = parseFloat(o.value);
        if (!isFinite(v)) continue;
        if (!partOddsMap.has(o.eventParticipantId)) partOddsMap.set(o.eventParticipantId, []);
        partOddsMap.get(o.eventParticipantId).push(v);
      }
    }
  }
  if (partOddsMap.size < 2) return null;

  let homeId = null, awayId = null;
  let minHomeDist = Infinity, minAwayDist = Infinity;
  for (const [id, vals] of partOddsMap) {
    const med = median(vals);
    if (med == null) continue;
    const dh = Math.abs(med - knownHome1X2);
    const da = Math.abs(med - knownAway1X2);
    if (dh < minHomeDist) { minHomeDist = dh; homeId = id; }
    if (da < minAwayDist) { minAwayDist = da; awayId = id; }
  }
  if (homeId === awayId) {
    const ids = [...partOddsMap.keys()];
    [homeId, awayId] = ids;
  }

  const buckets = {
    h_home: [], h_draw: [], h_away: [],
    dc_1x: [], dc_12: [], dc_x2: [],
    ou: {},
    btts_yes: [], btts_no: [],
    dnb_home: [], dnb_away: [],
  };

  for (const bm of raw) {
    for (const m of bm.odds || []) {
      if (m.bettingScope !== 'FULL_TIME') continue;
      const type = m.bettingType;
      for (const o of m.odds || []) {
        const v = parseFloat(o.value);
        if (!isFinite(v)) continue;

        if (type === 'HOME_DRAW_AWAY') {
          if (o.eventParticipantId === homeId) buckets.h_home.push(v);
          else if (o.eventParticipantId === awayId) buckets.h_away.push(v);
          else if (o.eventParticipantId == null) buckets.h_draw.push(v);
        } else if (type === 'DOUBLE_CHANCE') {
          if (o.eventParticipantId === homeId) buckets.dc_1x.push(v);
          else if (o.eventParticipantId === awayId) buckets.dc_x2.push(v);
          else if (o.eventParticipantId == null) buckets.dc_12.push(v);
        } else if (type === 'OVER_UNDER') {
          const line = o.handicap && o.handicap.value;
          if (!line) continue;
          if (!buckets.ou[line]) buckets.ou[line] = { over: [], under: [] };
          if (o.selection === 'OVER') buckets.ou[line].over.push(v);
          else if (o.selection === 'UNDER') buckets.ou[line].under.push(v);
        } else if (type === 'BOTH_TEAMS_TO_SCORE') {
          if (o.bothTeamsToScore === true) buckets.btts_yes.push(v);
          else if (o.bothTeamsToScore === false) buckets.btts_no.push(v);
        } else if (type === 'DRAW_NO_BET') {
          if (o.eventParticipantId === homeId) buckets.dnb_home.push(v);
          else if (o.eventParticipantId === awayId) buckets.dnb_away.push(v);
        }
      }
    }
  }

  const out = {};
  if (buckets.h_home.length) {
    out['1x2'] = {
      home: round2(median(buckets.h_home)),
      draw: round2(median(buckets.h_draw)),
      away: round2(median(buckets.h_away)),
    };
  }
  if (buckets.dc_1x.length) {
    out.double_chance = {
      '1X': round2(median(buckets.dc_1x)),
      '12': round2(median(buckets.dc_12)),
      'X2': round2(median(buckets.dc_x2)),
    };
  }
  const ou = {};
  for (const line of ['1.5', '2.5', '3.5']) {
    const b = buckets.ou[line];
    if (b && b.over.length && b.under.length) {
      ou[line] = { over: round2(median(b.over)), under: round2(median(b.under)) };
    }
  }
  if (Object.keys(ou).length) out.over_under = ou;
  if (buckets.btts_yes.length) {
    out.btts = { yes: round2(median(buckets.btts_yes)), no: round2(median(buckets.btts_no)) };
  }
  if (buckets.dnb_home.length) {
    out.draw_no_bet = { home: round2(median(buckets.dnb_home)), away: round2(median(buckets.dnb_away)) };
  }
  return out;
}

async function enrichAllFoot(allPronos) {
  const footMatches = allPronos.filter((p) => p.flashscore_id && p.flashscore_sport_id === 1).slice(0, MAX_FOOT_ENRICHMENTS);
  let done = 0;
  for (const p of footMatches) {
    try {
      const h2h = await fsFetch(`/matches/h2h?match_id=${p.flashscore_id}`);
      const recent = Array.isArray(h2h)
        ? h2h.slice(0, 15).map((m) => ({
            timestamp: m.timestamp,
            tournament: m.tournament_name_short || m.tournament_name,
            home: m.home_team?.name,
            away: m.away_team?.name,
            score: `${m.scores?.home}-${m.scores?.away}`,
          }))
        : [];
      p.stats = { recent_matches: recent };
    } catch (e) {
      console.error('    [WARN] h2h:', p.match, '-', e.message);
    }

    try {
      const oddsRaw = await fsFetch(`/matches/odds?match_id=${p.flashscore_id}`);
      const markets = parseMarkets(oddsRaw, p.cotes.domicile, p.cotes.exterieur);
      if (markets) p.markets = markets;
    } catch (e) {
      console.error('    [WARN] odds:', p.match, '-', e.message);
    }

    console.log(`    enriched: ${p.match}`);
    done++;
  }
  return done;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`→ generate-pronos v5 — window: next ${WINDOW_HOURS}h (all Flashscore)`);
  console.log('  (result resolution + archiving is owned by hourly-refresh.js)');
  const now = Date.now();
  const windowEnd = now + WINDOW_HOURS * 60 * 60 * 1000;

  // 1. Load existing (only to inherit history[])
  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8')); } catch {}
  const history = existing && Array.isArray(existing.history) ? existing.history : [];
  console.log(`  carrying over history[] with ${history.length} entries`);

  // 2. Fetch new fixtures
  console.log('[2] fetch new fixtures');
  const footLeagues = await fetchFootMatches(now, windowEnd);
  const nonFoot = await fetchNonFoot(now, windowEnd);

  // 3. Build sports structure
  const sports = {
    foot: {
      key: 'foot',
      label: '⚽ Football',
      badge: 'foot',
      outcome_count: 3,
      disclaimer_html: null,
      leagues: footLeagues,
    },
    nba: {
      key: 'nba',
      label: '🏀 Basketball',
      badge: 'nba',
      outcome_count: 2,
      disclaimer_html: "⚠️ <div>La NBA est difficile à pronostiquer en fin de saison régulière — beaucoup d'équipes gèrent leurs effectifs avant les playoffs. <strong>Bankroll recommandée 30% inférieure au foot.</strong></div>",
      leagues: nonFoot.nba ? [nonFoot.nba] : [],
    },
    ufc: {
      key: 'ufc',
      label: '🥊 MMA',
      badge: 'ufc',
      outcome_count: 2,
      disclaimer_html: "⚠️ <div>L'UFC reste le sport le plus imprévisible — un seul coup peut tout changer. Confiance max 3/5. Ne misez jamais plus de 1-2% de votre bankroll par combat.</div>",
      disclaimer_style: '--orange:var(--red);border-color:rgba(244,63,94,0.25);background:rgba(244,63,94,0.06);',
      leagues: nonFoot.ufc ? [nonFoot.ufc] : [],
    },
    tennis: {
      key: 'tennis',
      label: '🎾 Tennis',
      badge: 'tennis',
      outcome_count: 2,
      disclaimer_html: "✅ <div>Le tennis est l'un des sports les <strong>plus fiables</strong> à pronostiquer : pas d'effet d'équipe, écart de niveau énorme entre têtes de série et qualifiés.</div>",
      disclaimer_style: '--orange:var(--green);border-color:rgba(16,185,129,0.25);background:rgba(16,185,129,0.06);',
      leagues: nonFoot.tennis ? [nonFoot.tennis] : [],
    },
  };

  // Collect flat list for enrichment and coup-de-cœur
  const allPronos = [];
  for (const sport of Object.values(sports)) {
    for (const league of sport.leagues) {
      for (const p of league.pronos) allPronos.push(p);
    }
  }
  console.log(`    total pronos: ${allPronos.length}`);

  // 4. Coup-de-cœur selection
  console.log('[4] coup-de-cœur selection');
  const coupDeCoeurIds = computeCoupDeCoeur(allPronos);
  console.log(`    selected ${coupDeCoeurIds.length}`);

  // 5. Enrich ALL foot matches with H2H + markets
  if (allPronos.length) {
    console.log('[5] enrich foot matches with H2H + markets (up to ' + MAX_FOOT_ENRICHMENTS + ')');
    const enriched = await enrichAllFoot(allPronos);
    console.log(`    enriched ${enriched} foot matches`);
  }

  // 6. Write
  const data = {
    meta: {
      generated_at: new Date().toISOString(),
      generator: 'scripts/generate-pronos.js',
      version: '5.0',
      window_hours: WINDOW_HOURS,
      last_results_update: existing && existing.meta ? existing.meta.last_results_update : null,
    },
    sports,
    coup_de_coeur: coupDeCoeurIds,
    history,
  };
  fs.writeFileSync(JSON_PATH, JSON.stringify(data, null, 2) + '\n');
  console.log(`✓ written ${JSON_PATH} (${(JSON.stringify(data).length / 1024).toFixed(1)} KB)`);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
