'use strict';
const crypto = require('crypto');
const { httpErr, store, requireRole, logActivity, touchSeen, handler, validDate, loadDocs, str, num, cleanTargets } = require('./_lib');

function cleanDoc(b) {
  if (!b || typeof b !== 'object') throw httpErr(400, 'bad_body', 'Missing inspection.');
  const date = validDate(b.date);
  const truck = str(b.truck, 20);
  const inspector = str(b.inspector, 60);
  if (!date || !truck || !inspector) throw httpErr(400, 'missing_fields', 'Truck, inspector and date are required.');
  const ts = Number(b.ts);
  if (!Number.isFinite(ts) || ts < 1e12 || ts > 4e12) throw httpErr(400, 'bad_time', 'Bad time.');

  const items = {};
  Object.keys(b.items || {}).slice(0, 60).forEach((k) => {
    if (/^[a-z0-9_]{1,30}$/.test(k) && (b.items[k] === 'ok' || b.items[k] === 'defect')) items[k] = b.items[k];
  });

  const tires = {};
  Object.keys(b.tires || {}).slice(0, 30).forEach((k) => {
    if (!/^[A-Z0-9-]{1,10}$/.test(k)) return;
    const t = b.tires[k] || {};
    tires[k] = { psi: num(t.psi, 0, 300), tread: num(t.tread, 0, 40), dmg: !!t.dmg };
  });

  const defects = (Array.isArray(b.defects) ? b.defects : []).slice(0, 80).map((d) => ({
    k: d && d.k === 'tire' ? 'tire' : 'item',
    label: str(d && d.label, 120),
    note: str(d && d.note, 300),
    crit: !!(d && d.crit)
  })).filter((d) => d.label);

  const status = defects.some((d) => d.crit) ? 'hold' : defects.length ? 'minor' : 'ready';

  const id = typeof b.id === 'string' && /^[a-zA-Z0-9-]{8,50}$/.test(b.id) ? b.id : crypto.randomUUID();
  return {
    id, date, ts, truck,
    truckType: b.truckType === 'straight' ? 'straight' : 'tractor',
    trailer: str(b.trailer, 20),
    inspector,
    odo: num(b.odo, 0, 5000000),
    items, tires,
    targets: cleanTargets(b.targets),
    notes: str(b.notes, 1000),
    defects, status,
    open: status !== 'ready',
    repaired: null
  };
}

module.exports = handler(async (req, res) => {
  const who = await requireRole(req);
  const s = store();
  await touchSeen(s, who);

  if (req.method === 'GET') {
    const date = validDate(req.query.date);
    if (!date) throw httpErr(400, 'bad_date', 'Give a date as YYYY-MM-DD.');
    const ids = await s.smembers('insp:date:' + date);
    return res.status(200).json({ docs: await loadDocs(s, ids) });
  }

  if (req.method === 'POST') {
    const doc = cleanDoc(req.body);
    // A person signed in with their own PIN is always recorded under their own name.
    if (who.named) { doc.inspector = who.name; doc.byId = who.id; }
    // Sending the same inspection twice (for example after a bad signal) saves it once.
    const existing = await s.get('insp:' + doc.id);
    if (existing) return res.status(200).json({ id: doc.id, duplicate: true });
    await s.set('insp:' + doc.id, doc);
    await s.sadd('insp:date:' + doc.date, doc.id);
    if (doc.open) await s.sadd('insp:open', doc.id);
    await s.incr('rev');
    await logActivity(s, who.named ? who : { name: doc.inspector + ' (shared PIN)', role: who.role }, 'inspected',
      { truck: doc.truck, status: doc.status, defects: doc.defects.length });
    return res.status(201).json({ id: doc.id });
  }

  throw httpErr(405, 'method', 'Use GET or POST.');
});
