'use strict';
const { httpErr, store, requireRole, logActivity, handler } = require('./_lib');

// Managers permanently remove one inspection record (for example a test entry).
module.exports = handler(async (req, res) => {
  if (req.method !== 'POST') throw httpErr(405, 'method', 'Use POST.');
  const who = await requireRole(req, 'admin');
  const b = req.body || {};
  const id = typeof b.id === 'string' && /^[a-zA-Z0-9-]{8,50}$/.test(b.id) ? b.id : '';
  if (!id) throw httpErr(400, 'missing_fields', 'Missing inspection id.');
  const s = store();
  const doc = await s.get('insp:' + id);
  if (!doc) throw httpErr(404, 'not_found', 'Inspection not found. It may already be deleted.');
  await s.srem('insp:open', id);
  if (doc.date) await s.srem('insp:date:' + doc.date, id);
  await s.del('insp:' + id);
  await s.incr('rev');
  await logActivity(s, who, 'deleted a record', { truck: doc.truck, date: doc.date, inspector: doc.inspector, status: doc.status });
  res.status(200).json({ ok: true });
});
