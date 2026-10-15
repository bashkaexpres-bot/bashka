'use strict';
const { httpErr, store, requireRole, chicagoDay, handler } = require('./_lib');

// Owner only. Everything people did in the last few days, newest first.
module.exports = handler(async (req, res) => {
  if (req.method !== 'GET') throw httpErr(405, 'method', 'Use GET.');
  await requireRole(req, 'owner');
  const s = store();
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 31);
  const keys = [];
  for (let i = 0; i < days; i++) keys.push('act:' + chicagoDay(Date.now() - i * 86400000));
  const lists = await Promise.all(keys.map((k) => s.smembers(k)));
  const entries = [];
  lists.forEach((l) => (l || []).forEach((m) => {
    try { entries.push(typeof m === 'string' ? JSON.parse(m) : m); } catch (e) { /* skip a bad entry */ }
  }));
  entries.sort((a, b) => b.ts - a.ts);
  res.status(200).json({ entries: entries.slice(0, 400) });
});
