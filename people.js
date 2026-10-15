'use strict';
const { httpErr, store, identify, touchSeen, handler } = require('./_lib');

// Checks a PIN and says who it belongs to. Locks an address out for an hour after 20 wrong tries.
module.exports = handler(async (req, res) => {
  if (req.method !== 'POST') throw httpErr(405, 'method', 'Use POST.');
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const s = store();
  const key = 'fail:' + ip;
  const fails = Number(await s.get(key)) || 0;
  if (fails >= 20) throw httpErr(429, 'too_many', 'Too many wrong PINs. Try again in an hour.');
  const who = await identify(req.headers['x-pin']);
  if (!who) {
    await s.incr(key, 3600);
    throw httpErr(401, 'unauthorized', 'Wrong PIN.');
  }
  await touchSeen(s, who);
  res.status(200).json({ role: who.role, me: { name: who.name, named: who.named } });
});
