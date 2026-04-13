#!/usr/bin/env node
/*
 * send-daily-email.js
 * -------------------
 * Sends a morning recap email with the 10 coup-de-coeur picks + 2 combos.
 * Reads pronos.json and posts an HTML email through Resend.
 *
 * Env:
 *   RESEND_API_KEY  (required)
 *   RECAP_EMAIL_TO  (optional, default orange.nicolas76@gmail.com)
 *   RECAP_EMAIL_FROM (optional, default "Coach Parie <onboarding@resend.dev>")
 *
 * Exits 0 on success or when gracefully skipped (no API key, no picks).
 * Exits 1 only on hard failures (HTTP error, malformed JSON).
 */

const fs = require('fs');
const path = require('path');

const API_KEY = process.env.RESEND_API_KEY;
const TO = process.env.RECAP_EMAIL_TO || 'orange.nicolas76@gmail.com';
const FROM = process.env.RECAP_EMAIL_FROM || 'Coach Parie <onboarding@resend.dev>';
const SITE_URL = 'https://amiboazertyuiop-web.github.io/pronos/';
const JSON_PATH = path.join(__dirname, '..', 'pronos.json');

if (!API_KEY) {
  console.log('[email] RESEND_API_KEY not set — skipping');
  process.exit(0);
}

const data = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));

const allPronos = [];
for (const sport of Object.values(data.sports || {})) {
  for (const league of sport.leagues || []) {
    for (const p of league.pronos || []) allPronos.push(p);
  }
}

const cdcIds = Array.isArray(data.coup_de_coeur) ? data.coup_de_coeur : [];
const cdcPicks = cdcIds
  .map((id) => allPronos.find((p) => p.event_id === id))
  .filter(Boolean);
const combos = Array.isArray(data.combos) ? data.combos : [];

if (!cdcPicks.length && !combos.length) {
  console.log('[email] no coup-de-coeur nor combos to send — skipping');
  process.exit(0);
}

const SPORT_LABEL = {
  flashscore_football_epl: '⚽ Premier League',
  flashscore_football_liga: '⚽ Liga',
  flashscore_football_seriea: '⚽ Serie A',
  flashscore_football_bundesliga: '⚽ Bundesliga',
  flashscore_football_ligue1: '⚽ Ligue 1',
  flashscore_football_ucl: '⚽ UCL',
  flashscore_football_uel: '⚽ UEL',
  flashscore_football_uecl: '⚽ UECL',
  flashscore_nba: '🏀 NBA',
  flashscore_ufc: '🥊 UFC',
  flashscore_tennis: '🎾 Tennis',
};
function sportBadge(key) {
  if (!key) return '';
  if (SPORT_LABEL[key]) return SPORT_LABEL[key];
  if (key.includes('football')) return '⚽ Foot';
  if (key.includes('nba') || key.includes('basketball')) return '🏀 NBA';
  if (key.includes('mma') || key.includes('ufc')) return '🥊 UFC';
  if (key.includes('tennis')) return '🎾 Tennis';
  return '🏟️ Sport';
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stars(n) {
  const x = Math.max(0, Math.min(5, parseInt(n || 0, 10)));
  return '⭐'.repeat(x) + '☆'.repeat(5 - x);
}

function pickCard(p, rank) {
  const conf = stars(p.confiance);
  const cote = Number(p.cote_retenue || 0).toFixed(2);
  const analyse = esc(p.analyse || '').slice(0, 420);
  return `
  <tr>
    <td style="padding:14px 16px;background:#ffffff;border-radius:12px;border:1px solid #e8e8ef;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
        <tr>
          <td style="font-size:12px;color:#8a8aa0;letter-spacing:0.05em;">
            #${rank} · ${esc(sportBadge(p.sport_key))} · ${esc(p.time_display || '')}
          </td>
          <td align="right" style="font-size:11px;color:#8a8aa0;">${conf}</td>
        </tr>
        <tr>
          <td colspan="2" style="padding-top:6px;font-weight:700;font-size:15px;color:#1a1a2e;">
            ${esc(p.match || '')}
          </td>
        </tr>
        <tr>
          <td colspan="2" style="padding-top:6px;">
            <span style="display:inline-block;background:#1a1a2e;color:#ffd54a;font-weight:700;font-size:13px;padding:4px 10px;border-radius:6px;">
              ${esc(p.pari || '')} · @${cote}
            </span>
          </td>
        </tr>
        ${analyse ? `<tr><td colspan="2" style="padding-top:8px;font-size:13px;line-height:1.5;color:#454561;">${analyse}${p.analyse && p.analyse.length > 420 ? '…' : ''}</td></tr>` : ''}
      </table>
    </td>
  </tr>
  <tr><td style="height:10px;line-height:10px;">&nbsp;</td></tr>`;
}

function comboCard(c) {
  const safe = c.strategy === 'safe';
  const color = safe ? '#1db954' : '#9b51e0';
  const emoji = safe ? '🟢' : '💎';
  const totalCote = Number(c.total_cote || 0).toFixed(2);
  const legs = (c.legs || [])
    .map(
      (l) => `
      <tr>
        <td style="padding:6px 0;font-size:13px;color:#1a1a2e;">
          ${esc(sportBadge(l.sport_key))} · <b>${esc(l.match || '')}</b><br>
          <span style="color:#454561;">${esc(l.pari || '')}</span>
          <span style="float:right;color:${color};font-weight:700;">@${Number(l.cote || 0).toFixed(2)}</span>
        </td>
      </tr>`
    )
    .join('');
  const reasoning = esc(c.reasoning || '').slice(0, 500);
  return `
  <tr>
    <td style="padding:16px;background:#ffffff;border-radius:12px;border:2px solid ${color};">
      <div style="font-size:12px;color:${color};font-weight:700;letter-spacing:0.08em;">
        ${emoji} ${safe ? 'COMBINÉ SAFE' : 'COMBINÉ VALUE'} · COTE TOTALE @${totalCote}
      </div>
      <div style="padding-top:4px;font-size:16px;font-weight:700;color:#1a1a2e;">
        ${esc(c.label || '')}
      </div>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:8px;border-top:1px solid #eee;">
        ${legs}
      </table>
      ${reasoning ? `<div style="padding-top:10px;font-size:12px;line-height:1.5;color:#454561;font-style:italic;">${reasoning}${c.reasoning && c.reasoning.length > 500 ? '…' : ''}</div>` : ''}
    </td>
  </tr>
  <tr><td style="height:12px;line-height:12px;">&nbsp;</td></tr>`;
}

const today = new Date().toLocaleDateString('fr-FR', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'Europe/Paris',
});

const html = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"><title>Coach Parie — ${today}</title></head>
<body style="margin:0;padding:0;background:#f3f3f8;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1a1a2e;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f3f3f8;">
    <tr><td align="center" style="padding:24px 16px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:640px;">
        <tr><td style="padding:16px 4px;">
          <div style="font-size:11px;letter-spacing:0.12em;color:#8a8aa0;">LE COACH PARIE</div>
          <div style="font-size:24px;font-weight:800;color:#1a1a2e;">Récap du ${today}</div>
          <div style="font-size:13px;color:#8a8aa0;padding-top:4px;">
            ${cdcPicks.length} coups de cœur · ${combos.length} combinés
          </div>
        </td></tr>

        ${combos.length ? `
        <tr><td style="padding-top:12px;font-size:13px;font-weight:700;color:#8a8aa0;letter-spacing:0.08em;">🔥 COMBINÉS DU JOUR</td></tr>
        <tr><td style="padding-top:8px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
          ${combos.map(comboCard).join('')}
        </table></td></tr>` : ''}

        ${cdcPicks.length ? `
        <tr><td style="padding-top:16px;font-size:13px;font-weight:700;color:#8a8aa0;letter-spacing:0.08em;">❤️ COUPS DE CŒUR</td></tr>
        <tr><td style="padding-top:8px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
          ${cdcPicks.map((p, i) => pickCard(p, i + 1)).join('')}
        </table></td></tr>` : ''}

        <tr><td align="center" style="padding:24px 0 8px 0;">
          <a href="${SITE_URL}" style="display:inline-block;background:#1a1a2e;color:#ffd54a;font-weight:700;font-size:14px;padding:12px 22px;border-radius:8px;text-decoration:none;">
            Voir sur le site →
          </a>
        </td></tr>
        <tr><td align="center" style="padding:8px 0 24px 0;font-size:11px;color:#8a8aa0;">
          Généré automatiquement chaque matin à 7h · <a href="${SITE_URL}" style="color:#8a8aa0;">coachparie</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

const subject = `🎯 Coach Parie — ${cdcPicks.length} coups de cœur du ${today.split(' ').slice(0, 3).join(' ')}`;

(async () => {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM, to: [TO], subject, html }),
  });
  const body = await res.text();
  if (!res.ok) {
    console.error(`[email] HTTP ${res.status}: ${body}`);
    process.exit(1);
  }
  console.log(`[email] sent to ${TO}: ${body}`);
})().catch((err) => {
  console.error('[email] fatal:', err);
  process.exit(1);
});
