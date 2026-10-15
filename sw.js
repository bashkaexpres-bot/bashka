'use strict';
const crypto = require('crypto');
const { httpErr, store, requireRole, loadUsers, dropUsersCache, pinHash, pinTaken, logActivity, handler, str } = require('./_lib');

async function freshPin() {
  for (let i = 0; i < 50; i++) {
    const pin = String(crypto.randomInt(100000, 1000000));
    if (!(await pinTaken(pin))) return pin;
  }
  throw httpErr(500, 'pin_failed', 'Could not make a PIN. Try again.');
}

function publicUser(u, seen) {
  return { id: u.id, name: u.name, role: u.role, active: !!u.active, created: u.created, lastSeen: seen || null };
}

// Only the owner adds people, resets PINs, changes roles or turns people off.
module.exports = handler(async (req, res) => {
  const who = await requireRole(req, 'owner');
  const s = store();

  if (req.method === 'GET') {
    const users = await loadUsers(s, true);
    const ids = Object.keys(users);
    const seen = ids.length ? await s.mget(ids.map((i) => 'seen:' + i)) : [];
    const people = ids.map((id, i) => publicUser(users[id], Number(seen[i]) || null))
      .sort((a, b) => a.name.localeCompare(b.name));
    return res.status(200).json({ people });
  }

  if (req.method !== 'POST') throw httpErr(405, 'method', 'Use GET or POST.');
  const b = req.body || {};
  const users = await loadUsers(s, true);
  const action = b.action;

  if (action === 'add') {
    const name = str(b.name, 60);
    const role = b.role === 'admin' ? 'admin' : 'team';
    if (!name) throw httpErr(400, 'missing_fields', 'Enter a name.');
    if (Object.keys(users).length >= 100) throw httpErr(400, 'too_many', 'Too many people.');
    if (Object.keys(users).some((i) => users[i].name.toLowerCase() === name.toLowerCase())) {
      throw httpErr(400, 'duplicate', 'Someone with that name is already on the list.');
    }
    const id = 'u' + crypto.randomUUID().replace(/-/g, '').slice(0, 10);
    const pin = await freshPin();
    users[id] = { id, name, role, active: true, pinHash: pinHash(id, pin), created: Date.now() };
    await s.set('users', users);
    dropUsersCache();
    await logActivity(s, who, 'added a person', { person: name, role });
    return res.status(201).json({ person: publicUser(users[id]), pin });
  }

  const u = users[b.id];
  if (!u) throw httpErr(404, 'not_found', 'Person not found.');

  if (action === 'reset') {
    const pin = await freshPin();
    u.pinHash = pinHash(u.id, pin);
    await s.set('users', users);
    dropUsersCache();
    await logActivity(s, who, 'reset a PIN', { person: u.name });
    return res.status(200).json({ person: publicUser(u), pin });
  }

  if (action === 'active') {
    u.active = !!b.active;
    await s.set('users', users);
    dropUsersCache();
    await logActivity(s, who, u.active ? 'turned a person on' : 'turned a person off', { person: u.name });
    return res.status(200).json({ person: publicUser(u) });
  }

  if (action === 'role') {
    u.role = b.role === 'admin' ? 'admin' : 'team';
    await s.set('users', users);
    dropUsersCache();
    await logActivity(s, who, 'changed a role', { person: u.name, role: u.role });
    return res.status(200).json({ person: publicUser(u) });
  }

  throw httpErr(400, 'bad_action', 'Unknown action.');
});
