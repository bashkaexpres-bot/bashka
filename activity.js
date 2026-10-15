'use strict';
const { httpErr, store, requireRole, logActivity, handler, str, cleanTargets } = require('./_lib');

// Managers save the truck list and the target tire pressure for each axle.
module.exports = handler(async (req, res) => {
  if (req.method !== 'PUT') throw httpErr(405, 'method', 'Use PUT.');
  const who = await requireRole(req, 'admin');
  const b = req.body || {};
  const seen = {};
  const trucks = (Array.isArray(b.trucks) ? b.trucks : []).slice(0, 300)
    .map((t) => str(String(t), 20)).filter((t) => t && !seen[t] && (seen[t] = true));
  const targets = {
    tractor: cleanTargets(b.targets && b.targets.tractor),
    straight: cleanTargets(b.targets && b.targets.straight)
  };
  const s = store();
  await s.set('settings', { trucks, targets });
  await s.incr('rev');
  await logActivity(s, who, 'updated fleet setup', { trucks: trucks.length });
  res.status(200).json({ ok: true });
});
