#!/usr/bin/env node
/*
 * generate-pronos.js
 * ------------------
 * Fetches upcoming fixtures from The Odds API for the next 3 days
 * and writes a pronos.json at the repo root that index.html consumes.
 *
 * Usage:
 *   ODDS_API_KEY=xxx node scripts/generate-pronos.js
 *
 * Output schema (pronos.json):
 *   {
 *     meta: { generated_at, days_ahead, version, last_results_update },
 *     sports: {
 *       foot|nba|ufc|tennis: {
 *         key, label, panel_title, panel_meta, badge, outcome_count,
 *         pronos: [{
 *           event_id, sport_key, commence_time, time_display,
 *           home, away, match,
 *           prono ("win-home"|"win-away"|"draw"), pari,
 *           cote_retenue, cotes: {domicile, nul?, exterieur},
 *           analyse, confiance (1-5), featured,
 *           status ("pending"|"won"|"lost"|"void"),
 *           actual_score, actual_result
 *         }]
 *       }
 *     }
 *   }
 */

const fs = require('fs');
const path = require('path');

const API_KEY = process.env.ODDS_API_KEY;
if (!API_KEY) {
  console.error('ERROR: ODDS_API_KEY env var not set');
  process.exit(1);
}

const ODDS_BASE = 'https://api.the-odds-api.com/v4';
const DAYS_AHEAD = parseInt(process.env.DAYS_AHEAD || '3', 10);

// ---------------------------------------------------------------------------
// Sport configuration
// ---------------------------------------------------------------------------
// Each top-level sport has one or more "leagues" (real leagues/tournaments).
// The output pronos.json has the shape sports.<sport>.leagues[] — even sports
// with a single league (NBA, UFC) use this uniform structure so that the
// frontend render code only has one code path to handle.
const SPORT_CONFIG = {
  foot: {
    label: '⚽ Football',
    badge: 'foot',
    outcome_count: 3,
    disclaimer_html: null,
    leagues: [
      { key: 'ligue1', sport_key: 'soccer_france_ligue_one',       label: 'Ligue 1',           flag: '🇫🇷', country: 'France' },
      { key: 'epl',    sport_key: 'soccer_epl',                    label: 'Premier League',    flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', country: 'Angleterre' },
      { key: 'liga',   sport_key: 'soccer_spain_la_liga',          label: 'La Liga',           flag: '🇪🇸', country: 'Espagne' },
      { key: 'seriea', sport_key: 'soccer_italy_serie_a',          label: 'Serie A',           flag: '🇮🇹', country: 'Italie' },
      { key: 'bundes', sport_key: 'soccer_germany_bundesliga',     label: 'Bundesliga',        flag: '🇩🇪', country: 'Allemagne' },
      { key: 'ucl',    sport_key: 'soccer_uefa_champs_league',     label: 'Champions League', flag: '🏆', country: 'Europe' },
      { key: 'uel',    sport_key: 'soccer_uefa_europa_league',     label: 'Europa League',    flag: '🥈', country: 'Europe' },
      { key: 'uecl',   sport_key: 'soccer_uefa_europa_conference_league', label: 'Conference League', flag: '🥉', country: 'Europe' },
    ],
  },
  nba: {
    label: '🏀 Basketball',
    badge: 'nba',
    outcome_count: 2,
    disclaimer_html: '⚠️ <div>La NBA est difficile à pronostiquer en fin de saison régulière — beaucoup d\'équipes gèrent leurs effectifs avant les playoffs. <strong>Bankroll recommandée 30% inférieure au foot.</strong></div>',
    leagues: [
      { key: 'nba', sport_key: 'basketball_nba', label: 'NBA', flag: '🏀', country: 'USA' },
    ],
  },
  ufc: {
    label: '🥊 MMA',
    badge: 'ufc',
    outcome_count: 2,
    disclaimer_html: '⚠️ <div>L\'UFC reste le sport le plus imprévisible — un seul coup peut tout changer. Confiance max 3/5. Ne misez jamais plus de 1-2% de votre bankroll par combat.</div>',
    disclaimer_style: '--orange:var(--red);border-color:rgba(244,63,94,0.25);background:rgba(244,63,94,0.06);',
    leagues: [
      { key: 'mma', sport_key: 'mma_mixed_martial_arts', label: 'UFC / MMA', flag: '🥊', country: 'Mondial' },
    ],
  },
  tennis: {
    label: '🎾 Tennis',
    badge: 'tennis',
    outcome_count: 2,
    disclaimer_html: '✅ <div>Le tennis est l\'un des sports les <strong>plus fiables</strong> à pronostiquer : pas d\'effet d\'équipe, écart de niveau énorme entre têtes de série et qualifiés.</div>',
    disclaimer_style: '--orange:var(--green);border-color:rgba(16,185,129,0.25);background:rgba(16,185,129,0.06);',
    leagues: [
      // The Odds API only exposes tournaments currently in progress — we probe
      // this list and keep every tournament that returns events.
      { key: 'montecarlo', sport_key: 'tennis_atp_monte_carlo_masters', label: 'ATP Monte-Carlo', flag: '🇲🇨', country: 'Monaco' },
      { key: 'madrid',     sport_key: 'tennis_atp_madrid_open',         label: 'ATP Madrid',       flag: '🇪🇸', country: 'Espagne' },
      { key: 'rome',       sport_key: 'tennis_atp_rome_masters',        label: 'ATP Rome',         flag: '🇮🇹', country: 'Italie' },
      { key: 'roland',     sport_key: 'tennis_atp_french_open',         label: 'Roland-Garros',    flag: '🇫🇷', country: 'France' },
      { key: 'wimbledon',  sport_key: 'tennis_atp_wimbledon',           label: 'Wimbledon',        flag: '🇬🇧', country: 'Angleterre' },
      { key: 'usopen',     sport_key: 'tennis_atp_us_open',             label: 'US Open',          flag: '🇺🇸', country: 'USA' },
    ],
  },
};

const MAX_PRONOS_PER_LEAGUE = { foot: 10, nba: 12, ufc: 12, tennis: 10 };

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function toIso(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

async function fetchOdds(sportKey) {
  const until = new Date(Date.now() + (DAYS_AHEAD + 1) * 24 * 60 * 60 * 1000);
  const params = new URLSearchParams({
    apiKey: API_KEY,
    regions: 'eu',
    markets: 'h2h',
    oddsFormat: 'decimal',
    commenceTimeTo: toIso(until),
  });
  const url = `${ODDS_BASE}/sports/${sportKey}/odds/?${params}`;
  const res = await fetch(url);
  if (res.status === 404 || res.status === 422) return []; // sport not active
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status} for ${sportKey}: ${body.slice(0, 200)}`);
  }
  const remaining = res.headers.get('x-requests-remaining');
  if (remaining) console.log(`      quota remaining: ${remaining}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Odds aggregation and pick logic
// ---------------------------------------------------------------------------
function median(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

function aggregateOdds(event) {
  // Collect all h2h prices across bookmakers, return median per outcome name
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
  const result = {};
  for (const [name, prices] of priceMap) {
    result[name] = parseFloat(median(prices).toFixed(2));
  }
  return result;
}

function formatTimeFr(iso) {
  const d = new Date(iso);
  const days = ['Dim.', 'Lun.', 'Mar.', 'Mer.', 'Jeu.', 'Ven.', 'Sam.'];
  const hh = d.getUTCHours().toString().padStart(2, '0');
  const mm = d.getUTCMinutes().toString().padStart(2, '0');
  // Display UTC for consistency across timezones — the site will interpret as UTC
  return `${days[d.getUTCDay()]} ${hh}h${mm} UTC`;
}

function confidenceFromCote(cote) {
  if (cote < 1.25) return 5;
  if (cote < 1.50) return 4;
  if (cote < 2.00) return 3;
  if (cote < 3.00) return 2;
  return 1;
}

function buildAnalyse(pickName, cote) {
  const prob = Math.round(100 / cote);
  if (cote < 1.30) {
    return `${pickName} est un gros favori (cote ${cote.toFixed(2)}, probabilité implicite ~${prob}%). Le marché considère ce résultat comme quasi-acquis — pari à faible variance.`;
  }
  if (cote < 1.70) {
    return `${pickName} favori clair à ${cote.toFixed(2)} (~${prob}% implicite). Pari solide à intégrer dans une sélection sûre.`;
  }
  if (cote < 2.20) {
    return `${pickName} légèrement favori (cote ${cote.toFixed(2)}, ~${prob}% implicite). Match plus ouvert — confiance modérée.`;
  }
  if (cote < 3.00) {
    return `${pickName} à ${cote.toFixed(2)} (~${prob}% implicite). Pari équilibré avec une belle cote — à prendre si tu crois au upset.`;
  }
  return `${pickName} en outsider à ${cote.toFixed(2)}. Pari à haut risque — value possible mais prudence.`;
}

function pickForEvent(event, outcomeCount) {
  const odds = aggregateOdds(event);
  const home = event.home_team;
  const away = event.away_team;
  const cHome = odds[home];
  const cAway = odds[away];
  const cDraw = odds['Draw'];

  if (!cHome || !cAway) return null; // malformed event

  let prono, cote, pickName;

  if (outcomeCount === 3) {
    // 3-outcome (football): normally avoid betting the draw unless it's
    // clearly the lowest cote by a meaningful margin.
    if (cHome <= cAway) {
      prono = 'win-home';
      cote = cHome;
      pickName = home;
    } else {
      prono = 'win-away';
      cote = cAway;
      pickName = away;
    }
  } else {
    // 2-outcome (NBA, UFC, Tennis): pick the lower cote
    if (cHome <= cAway) {
      prono = 'win-home';
      cote = cHome;
      pickName = home;
    } else {
      prono = 'win-away';
      cote = cAway;
      pickName = away;
    }
  }

  const cotes = outcomeCount === 3
    ? { domicile: cHome, nul: cDraw || null, exterieur: cAway }
    : { domicile: cHome, exterieur: cAway };

  return {
    event_id: event.id,
    sport_key: event.sport_key,
    commence_time: event.commence_time,
    time_display: formatTimeFr(event.commence_time),
    home,
    away,
    match: `${home} vs ${away}`,
    prono,
    pari: `Victoire ${pickName}`,
    cote_retenue: cote,
    cotes,
    analyse: buildAnalyse(pickName, cote),
    confiance: confidenceFromCote(cote),
    featured: cote < 1.35,
    score_prevu: null,
    status: 'pending',
    actual_score: null,
    actual_result: null,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function generateForLeague(sportKey, cfg, leagueCfg) {
  let events;
  try {
    console.log(`    · ${leagueCfg.sport_key}`);
    events = await fetchOdds(leagueCfg.sport_key);
  } catch (err) {
    console.error(`      [WARN] ${leagueCfg.sport_key}: ${err.message}`);
    return null;
  }
  if (!events.length) return null; // league inactive (e.g. tennis off-tournament)

  const pronos = events
    .map((e) => pickForEvent(e, cfg.outcome_count))
    .filter(Boolean);
  if (!pronos.length) return null;

  pronos.sort(
    (a, b) =>
      new Date(a.commence_time) - new Date(b.commence_time) ||
      a.cote_retenue - b.cote_retenue
  );
  const limit = MAX_PRONOS_PER_LEAGUE[sportKey] || 10;
  return {
    key: leagueCfg.key,
    sport_key: leagueCfg.sport_key,
    label: leagueCfg.label,
    flag: leagueCfg.flag,
    country: leagueCfg.country,
    panel_title: `${leagueCfg.flag} ${leagueCfg.label}${leagueCfg.country ? ' — ' + leagueCfg.country : ''}`,
    panel_meta: `Matchs à venir · ${DAYS_AHEAD} prochains jours`,
    pronos: pronos.slice(0, limit),
  };
}

async function main() {
  console.log(`→ Generating pronos.json (next ${DAYS_AHEAD} days)`);

  const data = {
    meta: {
      generated_at: new Date().toISOString(),
      generator: 'scripts/generate-pronos.js',
      days_ahead: DAYS_AHEAD,
      version: '2.0',
      last_results_update: null,
    },
    sports: {},
  };

  for (const [sportKey, cfg] of Object.entries(SPORT_CONFIG)) {
    console.log(`  · ${sportKey}`);
    const leagues = [];
    for (const leagueCfg of cfg.leagues) {
      const league = await generateForLeague(sportKey, cfg, leagueCfg);
      if (league) leagues.push(league);
    }
    data.sports[sportKey] = {
      key: sportKey,
      label: cfg.label,
      badge: cfg.badge,
      outcome_count: cfg.outcome_count,
      disclaimer_html: cfg.disclaimer_html || null,
      disclaimer_style: cfg.disclaimer_style || null,
      leagues,
    };
    const totalPronos = leagues.reduce((s, l) => s + l.pronos.length, 0);
    console.log(`    → ${leagues.length} league(s), ${totalPronos} pronos total`);
  }

  // Preserve last_results_update from existing file
  const outPath = path.join(__dirname, '..', 'pronos.json');
  try {
    const existing = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    if (existing?.meta?.last_results_update) {
      data.meta.last_results_update = existing.meta.last_results_update;
    }
  } catch {
    /* first run */
  }

  fs.writeFileSync(outPath, JSON.stringify(data, null, 2) + '\n');
  console.log(`✓ Written ${outPath}`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
