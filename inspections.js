'use strict';
const { httpErr, store, requireRole, logActivity, handler, validDate, str } = require('./_lib');

// Managers clear an open defect record once the truck is fixed.
module.exports = handler(async (req, res) => {
  if (req.method !== 'POST') throw httpErr(405, 'method', 'Use POST.');
  const who = await requireRole(req, 'admin');
  const b = req.body || {};
  const id = typeof b.id === 'string' && /^[a-zA-Z0-9-]{8,50}$/.test(b.id) ? b.id : '';
  const by = who.named ? who.name : str(b.by, 60);
  const note = str(b.note, 300);
  const date = validDate(b.date);
  if (!id || !by || !note || !date) throw httpErr(400, 'missing_fields', 'Who fixed it and what was fixed are required.');
  const s = store();
  const doc = await s.get('insp:' + id);
  if (!doc) throw httpErr(404, 'not_found', 'Inspection not found.');
  doc.open = false;
  doc.repaired = { by, note, date, ts: Date.now() };
  await s.set('insp:' + id, doc);
  await s.srem('insp:open', id);
  await s.incr('rev');
  await logActivity(s, who, 'marked repaired', { truck: doc.truck, note });
  res.status(200).json({ ok: true });
});
