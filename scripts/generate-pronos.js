#!/usr/bin/env node
/*
 * generate-pronos.js (v3.0) — full daily pipeline for Coach Parie
 * ----------------------------------------------------------------
 * Runs once per day at 07:00 Paris from the scheduled Claude agent.
 *
 * Responsibilities:
 *   1. Load existing pronos.json (if any)
 *   2. Update any still-pending pronos from yesterday by fetching their scores
 *      and flipping status to won/lost/void
 *   3. Archive resolved pronos into pronos.history[] (keeps long-term stats)
 *   4. Fetch TODAY's matches (next 24h window) from:
 *        - Flashscore (football — all leagues + built-in odds)
 *        - The Odds API (NBA, UFC/MMA, ATP tennis)
 *   5. Build prono objects with default pick (favorite) and default confidence
 *      but leave `analyse` empty — the Claude agent will fill it afterwards
 *   6. For the top ~10 most interesting football matches, fetch H2H data from
 *      Flashscore and attach it to each prono's `stats.h2h` field so the agent
 *      has real facts to write with
 *   7. Compute coup-de-cœur: the top 10 picks ranked by confidence * edge with
 *      cote >= 1.25, mark them with coup_de_coeur=true and populate a
 *      top-level pronosData.coup_de_coeur array of event_id references
 *   8. Write pronos.json
 *
 * Usage:
 *   ODDS_API_KEY=xxx FLASHSCORE_KEY=xxx node scripts/generate-pronos.js
 *
 * Budget targets (free tiers):
 *   - Flashscore (flashscore4 on RapidAPI): ~12 req/day → ~360/500 per month
 *   - The Odds API: ~3-4 req/day → ~100/500 per month
 */

const fs = require('fs');
const path = require('path');

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const FLASHSCORE_KEY = process.env.FLASHSCORE_KEY;
if (!ODDS_API_KEY) { console.error('ERROR: ODDS_API_KEY env var not set'); process.exit(1); }
if (!FLASHSCORE_KEY) { console.error('ERROR: FLASHSCORE_KEY env var not set'); process.exit(1); }

const ODDS_BASE = 'https://api.the-odds-api.com/v4';
const FS_HOST = 'flashscore4.p.rapidapi.com';
const FS_BASE = `https://${FS_HOST}/api/flashscore/v2`;
const JSON_PATH = path.join(__dirname, '..', 'pronos.json');
const WINDOW_HOURS = 24;
const MAX_COUP_DE_COEUR = 10;
const MIN_COUP_DE_COEUR_COTE = 1.25;

// ---------------------------------------------------------------------------
// League config (football — Flashscore tournaments we care about)
// Matching is done on the `name` + `country_name` fields returned by
// /matches/list (we accept any of the patterns).
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
// Simple fetch helpers with error handling + quota logging
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

async function oddsFetch(pathname) {
  const sep = pathname.includes('?') ? '&' : '?';
  const url = ODDS_BASE + pathname + sep + 'apiKey=' + ODDS_API_KEY;
  const res = await fetch(url);
  const remaining = res.headers.get('x-requests-remaining');
  if (remaining) console.log(`      odds-api remaining: ${remaining}`);
  if (res.status === 404 || res.status === 422) return [];
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Odds API HTTP ${res.status} for ${pathname}: ${body.slice(0, 200)}`);
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

// ---------------------------------------------------------------------------
// FOOT — fetch via Flashscore, group by our target leagues
// ---------------------------------------------------------------------------
async function fetchFootMatches(windowStartMs, windowEndMs) {
  console.log('  · foot via Flashscore');
  // Fetch day=0 and day=1 so we capture the full 24h window
  const [today, tomorrow] = await Promise.all([
    fsFetch('/matches/list?sport_id=1&day=0'),
    fsFetch('/matches/list?sport_id=1&day=1'),
  ]);
  const allTournaments = [...today, ...tomorrow];

  // Deduplicate tournaments by tournament_id but merge their matches
  const tournamentMap = new Map();
  for (const t of allTournaments) {
    const existing = tournamentMap.get(t.tournament_id);
    if (existing) {
      const seenIds = new Set(existing.matches.map((m) => m.match_id));
      for (const m of t.matches) if (!seenIds.has(m.match_id)) existing.matches.push(m);
    } else {
      tournamentMap.set(t.tournament_id, { ...t, matches: [...t.matches] });
    }
  }

  // Group by our league config
  const leaguesOut = [];
  for (const cfg of FOOT_LEAGUES) {
    const matches = [];
    for (const t of tournamentMap.values()) {
      if (!cfg.pattern.test(t.full_name || t.name || '')) continue;
      for (const m of t.matches) {
        if (!m.timestamp) continue;
        const ms = m.timestamp * 1000;
        if (ms < windowStartMs || ms > windowEndMs) continue;
        if (!m.odds || !m.odds['1'] || !m.odds['2']) continue; // require cotes
        if (m.match_status && (m.match_status.is_started || m.match_status.is_finished)) continue;
        matches.push({ raw: m, tournament: t });
      }
    }
    if (!matches.length) continue;

    // Build prono objects
    const pronos = matches.map(({ raw, tournament }) => {
      const cHome = raw.odds['1'];
      const cAway = raw.odds['2'];
      const cDraw = raw.odds['X'];
      // Default pick: favourite (lowest cote). Agent can override.
      let prono, cote, pickName;
      if (cHome <= cAway) {
        prono = 'win-home'; cote = cHome; pickName = raw.home_team.name;
      } else {
        prono = 'win-away'; cote = cAway; pickName = raw.away_team.name;
      }
      return {
        event_id: raw.match_id,
        flashscore_id: raw.match_id,
        home_team_id: raw.home_team.team_id,
        away_team_id: raw.away_team.team_id,
        tournament_id: tournament.tournament_id,
        tournament_url: tournament.tournament_url || '',
        sport_key: 'flashscore_football_' + cfg.key,
        commence_time: new Date(raw.timestamp * 1000).toISOString(),
        time_display: formatTimeFr(raw.timestamp),
        home: raw.home_team.name,
        away: raw.away_team.name,
        match: `${raw.home_team.name} vs ${raw.away_team.name}`,
        prono,
        pari: `Victoire ${pickName}`,
        cote_retenue: cote,
        cotes: { domicile: cHome, nul: cDraw || null, exterieur: cAway },
        analyse: '', // filled by the Claude agent
        confiance: confidenceFromCote(cote),
        featured: cote < 1.35,
        score_prevu: null,
        status: 'pending',
        actual_score: null,
        actual_result: null,
        coup_de_coeur: false,
        stats: null, // filled later for the top picks
      };
    });

    // Sort by kickoff, then by cote (ascending = safest first)
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
// NBA / UFC / TENNIS — fetch via The Odds API (unchanged from v2)
// ---------------------------------------------------------------------------
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function aggregateOddsApiEvent(event) {
  const priceMap = new Map();
  for (const bm of event.bookmakers || []) {
    for (const m of bm.markets || []) {
      if (m.key !== 'h2h') continue;
      for (const o of m.outcomes || []) {
        if (!priceMap.has(o.name)) priceMap.set(o.name, []);
        priceMap.get(o.name).push(o.price);
      }
    }
  }
  const out = {};
  for (const [name, prices] of priceMap) out[name] = parseFloat(median(prices).toFixed(2));
  return out;
}

function pickForOddsApiEvent(event, outcomeCount, sportLabel) {
  const odds = aggregateOddsApiEvent(event);
  const home = event.home_team;
  const away = event.away_team;
  const cHome = odds[home];
  const cAway = odds[away];
  if (!cHome || !cAway) return null;
  let prono, cote, pickName;
  if (cHome <= cAway) { prono = 'win-home'; cote = cHome; pickName = home; }
  else { prono = 'win-away'; cote = cAway; pickName = away; }
  return {
    event_id: event.id,
    flashscore_id: null,
    sport_key: event.sport_key,
    commence_time: event.commence_time,
    time_display: formatTimeFr(Math.floor(new Date(event.commence_time).getTime() / 1000)),
    home, away,
    match: `${home} vs ${away}`,
    prono,
    pari: `Victoire ${pickName}`,
    cote_retenue: cote,
    cotes: { domicile: cHome, exterieur: cAway },
    analyse: '',
    confiance: confidenceFromCote(cote),
    featured: cote < 1.35,
    score_prevu: null,
    status: 'pending',
    actual_score: null,
    actual_result: null,
    coup_de_coeur: false,
    stats: null,
  };
}

async function fetchOddsApiSport(sportKey, windowEndMs) {
  const isoEnd = new Date(windowEndMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const qs = `regions=eu&markets=h2h&oddsFormat=decimal&commenceTimeTo=${encodeURIComponent(isoEnd)}`;
  const events = await oddsFetch(`/sports/${sportKey}/odds/?${qs}`);
  return events;
}

async function fetchNonFoot(windowStartMs, windowEndMs) {
  const result = { nba: null, ufc: null, tennis: null };

  console.log('  · nba via Odds API');
  try {
    const events = await fetchOddsApiSport('basketball_nba', windowEndMs);
    const pronos = events
      .filter((e) => {
        const ms = new Date(e.commence_time).getTime();
        return ms >= windowStartMs && ms <= windowEndMs;
      })
      .map((e) => pickForOddsApiEvent(e, 2, '🏀 NBA'))
      .filter(Boolean);
    pronos.sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time));
    if (pronos.length) {
      result.nba = {
        key: 'nba',
        sport_key: 'basketball_nba',
        label: 'NBA',
        flag: '🏀',
        country: 'USA',
        panel_title: '🏀 NBA',
        panel_meta: 'Matchs des prochaines 24h',
        pronos,
      };
    }
  } catch (e) { console.error('    [WARN]', e.message); }

  console.log('  · ufc via Odds API');
  try {
    const events = await fetchOddsApiSport('mma_mixed_martial_arts', windowEndMs);
    const pronos = events
      .filter((e) => {
        const ms = new Date(e.commence_time).getTime();
        return ms >= windowStartMs && ms <= windowEndMs;
      })
      .map((e) => pickForOddsApiEvent(e, 2, '🥊 UFC'))
      .filter(Boolean);
    pronos.sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time));
    if (pronos.length) {
      result.ufc = {
        key: 'mma',
        sport_key: 'mma_mixed_martial_arts',
        label: 'UFC / MMA',
        flag: '🥊',
        country: 'Mondial',
        panel_title: '🥊 UFC / MMA',
        panel_meta: 'Combats des prochaines 24h',
        pronos,
      };
    }
  } catch (e) { console.error('    [WARN]', e.message); }

  console.log('  · tennis via Odds API (probing active tournaments)');
  const tennisSports = [
    { key: 'montecarlo', sport_key: 'tennis_atp_monte_carlo_masters', label: 'ATP Monte-Carlo', flag: '🇲🇨', country: 'Monaco' },
    { key: 'madrid',     sport_key: 'tennis_atp_madrid_open',         label: 'ATP Madrid',       flag: '🇪🇸', country: 'Espagne' },
    { key: 'rome',       sport_key: 'tennis_atp_rome_masters',        label: 'ATP Rome',         flag: '🇮🇹', country: 'Italie' },
    { key: 'roland',     sport_key: 'tennis_atp_french_open',         label: 'Roland-Garros',    flag: '🇫🇷', country: 'France' },
    { key: 'wimbledon',  sport_key: 'tennis_atp_wimbledon',           label: 'Wimbledon',        flag: '🇬🇧', country: 'Angleterre' },
    { key: 'usopen',     sport_key: 'tennis_atp_us_open',             label: 'US Open',          flag: '🇺🇸', country: 'USA' },
  ];
  for (const tour of tennisSports) {
    try {
      const events = await fetchOddsApiSport(tour.sport_key, windowEndMs);
      const pronos = events
        .filter((e) => {
          const ms = new Date(e.commence_time).getTime();
          return ms >= windowStartMs && ms <= windowEndMs;
        })
        .map((e) => pickForOddsApiEvent(e, 2, '🎾 Tennis'))
        .filter(Boolean);
      if (pronos.length) {
        pronos.sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time));
        result.tennis = {
          key: tour.key,
          sport_key: tour.sport_key,
          label: tour.label,
          flag: tour.flag,
          country: tour.country,
          panel_title: `${tour.flag} ${tour.label}`,
          panel_meta: 'Matchs des prochaines 24h',
          pronos,
        };
        break; // stop at first active tournament
      }
    } catch (e) { /* inactive tournament — skip */ }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Step 2: update status of still-pending pronos from yesterday
// ---------------------------------------------------------------------------
async function updatePendingResults(existing) {
  if (!existing || !existing.sports) return 0;
  const now = Date.now();
  const pendingBySport = new Map();
  for (const sport of Object.values(existing.sports)) {
    for (const league of sport.leagues || []) {
      for (const p of league.pronos || []) {
        if (p.status !== 'pending') continue;
        const ms = new Date(p.commence_time).getTime();
        if (ms > now) continue;
        // Foot: resolve via Flashscore (free once match is in our day range)
        if (p.flashscore_id) {
          try {
            const detail = await fsFetch(`/matches/details?match_id=${p.flashscore_id}`);
            if (detail?.match_status?.is_finished) {
              const hs = detail.scores.home;
              const as = detail.scores.away;
              const homeWins = hs > as;
              const draw = hs === as;
              let status;
              if (draw) status = p.prono === 'draw' ? 'won' : 'lost';
              else if (p.prono === 'win-home') status = homeWins ? 'won' : 'lost';
              else if (p.prono === 'win-away') status = !homeWins ? 'won' : 'lost';
              else status = 'void';
              p.status = status;
              p.actual_score = `${hs}-${as}`;
              p.actual_result = homeWins ? 'home' : draw ? 'draw' : 'away';
              console.log(`    resolved ${p.match}: ${p.actual_score} (${status})`);
            }
          } catch (e) { console.error('    [WARN] foot resolve:', e.message); }
          continue;
        }
        // Non-foot: group by sport_key for one bulk Odds API call
        if (!pendingBySport.has(p.sport_key)) pendingBySport.set(p.sport_key, []);
        pendingBySport.get(p.sport_key).push(p);
      }
    }
  }

  let resolved = 0;
  for (const [sportKey, pronos] of pendingBySport) {
    try {
      const events = await oddsFetch(`/sports/${sportKey}/scores/?daysFrom=3&dateFormat=iso`);
      const byId = new Map(events.map((e) => [e.id, e]));
      for (const p of pronos) {
        const evt = byId.get(p.event_id);
        if (!evt || !evt.completed || !evt.scores) continue;
        const hScore = parseInt(evt.scores.find((s) => s.name === p.home)?.score, 10);
        const aScore = parseInt(evt.scores.find((s) => s.name === p.away)?.score, 10);
        if (Number.isNaN(hScore) || Number.isNaN(aScore)) continue;
        const homeWins = hScore > aScore;
        const draw = hScore === aScore;
        let status;
        if (draw) status = 'void';
        else if (p.prono === 'win-home') status = homeWins ? 'won' : 'lost';
        else if (p.prono === 'win-away') status = !homeWins ? 'won' : 'lost';
        else status = 'void';
        p.status = status;
        p.actual_score = `${hScore}-${aScore}`;
        p.actual_result = homeWins ? 'home' : draw ? 'draw' : 'away';
        resolved++;
        console.log(`    resolved ${p.match}: ${p.actual_score} (${status})`);
      }
    } catch (e) { console.error('    [WARN]', sportKey, e.message); }
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Step 3: archive resolved pronos to history[]
// ---------------------------------------------------------------------------
function archiveResolved(existing) {
  if (!existing || !existing.sports) return { history: [], archived: 0 };
  const history = existing.history || [];
  let archived = 0;
  for (const sport of Object.values(existing.sports)) {
    for (const league of sport.leagues || []) {
      const keep = [];
      for (const p of league.pronos || []) {
        if (p.status === 'won' || p.status === 'lost' || p.status === 'void') {
          history.push({
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
  // Cap history to last 500 entries to keep file size reasonable
  if (history.length > 500) history.splice(0, history.length - 500);
  return { history, archived };
}

// ---------------------------------------------------------------------------
// Step 6 + 7: compute coup-de-cœur (ranking) then enrich foot picks with H2H
// ---------------------------------------------------------------------------
// Selection priority (within cote >= 1.25 filter):
//   1. confidence DESC (safer picks first)
//   2. cote DESC     (within the same confidence tier, higher cote = more value)
// Rationale: the user explicitly asked for a minimum cote of 1.25 so we skip
// ultra-safe picks. Past that, we prefer the higher-confidence tier because
// coup-de-cœur should feel reasonably safe. A conf=4 (cote 1.25-1.50) is far
// better value than a conf=2 (cote 2.00-3.00) for a daily curated list.
function computeCoupDeCoeur(allPronos) {
  const candidates = allPronos
    .filter((p) => p.cote_retenue >= MIN_COUP_DE_COEUR_COTE)
    .sort((a, b) => b.confiance - a.confiance || b.cote_retenue - a.cote_retenue);
  const top = candidates.slice(0, MAX_COUP_DE_COEUR);
  for (const p of top) p.coup_de_coeur = true;
  return top.map((p) => p.event_id);
}

async function enrichCoupDeCoeurFoot(allPronos) {
  // Only enrich foot coup-de-cœur picks — non-foot picks don't have
  // Flashscore data in our setup (NBA/UFC/tennis come from the Odds API).
  const footPicks = allPronos.filter((p) => p.coup_de_coeur && p.flashscore_id);
  for (const p of footPicks) {
    try {
      console.log(`    h2h: ${p.match}`);
      const h2h = await fsFetch(`/matches/h2h?match_id=${p.flashscore_id}`);
      // The Flashscore h2h endpoint actually returns recent matches involving
      // EITHER team (not only head-to-head), which is fine — we use it as a
      // combined form + H2H signal. Keep the 15 most recent entries.
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
      console.error('    [WARN] h2h:', e.message);
    }
  }
  return footPicks.length;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`→ generate-pronos v3 — window: next ${WINDOW_HOURS}h`);
  const now = Date.now();
  const windowEnd = now + WINDOW_HOURS * 60 * 60 * 1000;

  // 1. Load existing
  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8')); } catch {}

  // 2. Update pending results
  let resolvedCount = 0;
  if (existing) {
    console.log('[2] update pending results');
    resolvedCount = await updatePendingResults(existing);
  }

  // 3. Archive resolved
  let history = [];
  let archivedCount = 0;
  if (existing) {
    console.log('[3] archive resolved to history');
    const archived = archiveResolved(existing);
    history = archived.history;
    archivedCount = archived.archived;
    console.log(`    archived ${archivedCount}, history now has ${history.length}`);
  }

  // 4. Fetch new fixtures
  console.log('[4] fetch new fixtures');
  const footLeagues = await fetchFootMatches(now, windowEnd);
  const nonFoot = await fetchNonFoot(now, windowEnd);

  // 5. Build sports structure
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

  // Collect a flat list of all current pronos for enrichment and coup-de-cœur
  const allPronos = [];
  for (const sport of Object.values(sports)) {
    for (const league of sport.leagues) {
      for (const p of league.pronos) allPronos.push(p);
    }
  }
  console.log(`    total pronos: ${allPronos.length}`);

  // 6. Coup-de-cœur selection (before enrichment so we know which to enrich)
  console.log('[6] coup-de-cœur selection');
  const coupDeCoeurIds = computeCoupDeCoeur(allPronos);
  console.log(`    selected ${coupDeCoeurIds.length}`);

  // 7. Enrich coup-de-cœur foot picks with recent matches / H2H
  if (coupDeCoeurIds.length) {
    console.log('[7] enrich foot coup-de-cœur with recent matches');
    const enriched = await enrichCoupDeCoeurFoot(allPronos);
    console.log(`    enriched ${enriched} foot picks`);
  }

  // 8. Write
  const data = {
    meta: {
      generated_at: new Date().toISOString(),
      generator: 'scripts/generate-pronos.js',
      version: '3.0',
      window_hours: WINDOW_HOURS,
      last_results_update: new Date().toISOString(),
      resolved_last_run: resolvedCount,
      archived_last_run: archivedCount,
    },
    sports,
    coup_de_coeur: coupDeCoeurIds,
    history,
  };
  fs.writeFileSync(JSON_PATH, JSON.stringify(data, null, 2) + '\n');
  console.log(`✓ written ${JSON_PATH} (${(JSON.stringify(data).length / 1024).toFixed(1)} KB)`);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
