'use strict';
const { httpErr, sb, sameSecret, handler, SUPABASE_URL } = require('./_invoice');
const { buildXlsx } = require('./_xlsx');

// Daily Reports.
//  - Vercel Cron (every night, with CRON_SECRET) builds yesterday's file and saves it in the private "daily-reports" bucket.
//  - A signed-in person WITH the "reports" right can download any day (saved file if it exists, otherwise built live).
// The database enforces who may read the data (report_loads checks the right); this file never trusts the browser.
const ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_NAFw4krk8evjh7Bx0VFD9g_EcuThMES';
const TZ = 'America/Chicago';
const HEAD = ['Date', 'Job #', 'Customer', 'Pickup address', 'Delivery address', 'Scheduled pickup', 'Scheduled delivery', 'Actual pickup', 'Actual delivery', 'Status', 'Driver', 'Truck'];
const WIDTH = [12, 24, 22, 38, 38, 20, 20, 20, 20, 12, 22, 10];

function centralDate(d) { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); }
function fmt(t) {
  if (!t) return '';
  const d = new Date(t); if (isNaN(d)) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(d).map((x) => [x.type, x.value]));
  return p.month + '/' + p.day + '/' + p.year + ' ' + p.hour + ':' + p.minute + ' ' + String(p.dayPeriod || '').toUpperCase();
}
function label(s) { return s === 'in_transit' ? 'In transit' : s ? String(s).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : ''; }

async function loadsFor(day, token) {
  const headers = token
    ? { apikey: ANON_KEY, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
    : null;
  let r;
  if (headers) r = await fetch(SUPABASE_URL + '/rest/v1/rpc/report_loads', { method: 'POST', headers, body: JSON.stringify({ p_day: day }) });
  else r = await sb('/rest/v1/rpc/report_loads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ p_day: day }) });
  if (r.status === 401 || r.status === 403) throw httpErr(403, 'forbidden', 'Only the owner, or someone the owner allows, can open Daily Reports.');
  if (!r.ok) { const t = await r.text(); if (/not allowed/i.test(t)) throw httpErr(403, 'forbidden', 'Only the owner, or someone the owner allows, can open Daily Reports.'); throw httpErr(502, 'db_failed', 'Could not read the loads.'); }
  return r.json();
}

function toFile(day, rows) {
  const data = rows.map((x) => [day, x.job_number, x.customer, x.pickup_address, x.drop_address, fmt(x.scheduled_pickup), fmt(x.scheduled_delivery), fmt(x.actual_pickup), fmt(x.actual_delivery), label(x.status), x.driver, x.truck]);
  return buildXlsx('Loads ' + day, HEAD, data, WIDTH);
}

module.exports = handler(async (req, res) => {
  if (req.method !== 'GET') throw httpErr(405, 'method', 'Use GET.');
  const m = /^Bearer\s+(\S+)$/.exec(String(req.headers.authorization || ''));
  if (!m) throw httpErr(401, 'unauthorized', 'Sign in to the dispatch portal first.');
  const cron = process.env.CRON_SECRET;

  // ---- nightly job
  if (cron && sameSecret(m[1], cron)) {
    const day = centralDate(new Date(Date.now() - 3 * 3600 * 1000)); // the Central day that just ended (job runs around midnight Central)
    const rows = await loadsFor(day, null);
    const file = toFile(day, rows);
    const path = day + '.xlsx';
    const up = await sb('/storage/v1/object/daily-reports/' + path, { method: 'POST', headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'x-upsert': 'true' }, body: file });
    if (!up.ok) throw httpErr(502, 'store_failed', 'Could not save the report file.');
    const rec = await sb('/rest/v1/daily_reports?on_conflict=day', { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ day, row_count: rows.length, file_path: path, created_at: new Date().toISOString() }) });
    if (!rec.ok) throw httpErr(502, 'record_failed', 'Saved the file but could not list it.');
    return res.status(200).json({ ok: true, day, rows: rows.length });
  }

  // ---- a person downloading
  const token = m[1];
  const who = await fetch(SUPABASE_URL + '/auth/v1/user', { headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + token } });
  if (!who.ok) throw httpErr(401, 'unauthorized', 'Sign in to the dispatch portal first.');
  const day = String((req.query && req.query.day) || centralDate(new Date()));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || isNaN(new Date(day + 'T12:00:00Z'))) throw httpErr(400, 'bad_day', 'Use a date like 2026-11-02.');
  const rows = await loadsFor(day, token); // also proves the caller has the right
  let file = null;
  if (day < centralDate(new Date()) && !(req.query && req.query.live)) { // a finished day: prefer the saved end-of-day snapshot (add ?live=1 for a fresh one)
    const g = await sb('/storage/v1/object/daily-reports/' + day + '.xlsx');
    if (g.ok) file = Buffer.from(await g.arrayBuffer());
  }
  if (!file) file = toFile(day, rows);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="Bashka-Loads-' + day + '.xlsx"');
  res.status(200).send(file);
});
