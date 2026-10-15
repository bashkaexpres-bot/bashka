'use strict';
const { httpErr, store, requireRole, touchSeen, handler, validDate, loadDocs } = require('./_lib');

// One call returns everything the Today and Log screens need.
// The app sends the revision it already has; if nothing changed, only a tiny reply comes back.
module.exports = handler(async (req, res) => {
  if (req.method !== 'GET') throw httpErr(405, 'method', 'Use GET.');
  const who = await requireRole(req);
  const role = who.role;
  const me = { name: who.name, named: who.named };
  const s = store();
  await touchSeen(s, who);
  const date = validDate(req.query.date);
  const rev = Number(await s.get('rev')) || 0;
  if (req.query.rev && Number(req.query.rev) === rev) {
    return res.status(200).json({ role, me, rev, unchanged: true });
  }
  const [settings, todayIds, openIds] = await Promise.all([
    s.get('settings'),
    date ? s.smembers('insp:date:' + date) : [],
    s.smembers('insp:open')
  ]);
  const [today, open] = await Promise.all([loadDocs(s, todayIds), loadDocs(s, openIds)]);
  res.status(200).json({ role, me, rev, settings: settings || {}, today, open });
});
