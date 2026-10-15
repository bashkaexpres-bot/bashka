'use strict';
const crypto = require('crypto');

function httpErr(status, code, message) {
  const e = new Error(message || code);
  e.status = status;
  e.code = code;
  return e;
}

/* ---------- storage ---------- */
function memoryStore() {
  if (!globalThis.__bxmem) globalThis.__bxmem = { kv: new Map(), sets: new Map() };
  const m = globalThis.__bxmem;
  const clone = (v) => (v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)));
  return {
    get: async (k) => clone(m.kv.get(k)),
    set: async (k, v) => { m.kv.set(k, clone(v)); },
    del: async (k) => { m.kv.delete(k); },
    incr: async (k) => { const n = (Number(m.kv.get(k)) || 0) + 1; m.kv.set(k, n); return n; },
    sadd: async (k, v) => { if (!m.sets.has(k)) m.sets.set(k, new Set()); m.sets.get(k).add(v); },
    srem: async (k, v) => { if (m.sets.has(k)) m.sets.get(k).delete(v); },
    smembers: async (k) => Array.from(m.sets.get(k) || []),
    mget: async (keys) => keys.map((k) => clone(m.kv.get(k)))
  };
}

let redisClient = null;
function upstashStore(r) {
  return {
    get: (k) => r.get(k),
    set: (k, v) => r.set(k, v),
    del: (k) => r.del(k),
    incr: async (k, ttlSec) => {
      const n = await r.incr(k);
      if (ttlSec && n === 1) await r.expire(k, ttlSec);
      return n;
    },
    sadd: (k, v) => r.sadd(k, v),
    srem: (k, v) => r.srem(k, v),
    smembers: (k) => r.smembers(k),
    mget: async (keys) => (keys.length ? r.mget(...keys) : [])
  };
}

function store() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (url && token) {
    if (!redisClient) {
      const { Redis } = require('@upstash/redis');
      redisClient = new Redis({ url, token });
    }
    return upstashStore(redisClient);
  }
  if (process.env.VERCEL) throw httpErr(500, 'no_database', 'Database is not connected yet.');
  return memoryStore();
}

/* ---------- auth ---------- */
function digest(s) { return crypto.createHash('sha256').update(String(s)).digest(); }
function same(a, b) { return crypto.timingSafeEqual(digest(a), digest(b)); }

// Each PIN setting can hold several PINs separated by commas, for example 482913,771204
function pinList(v) {
  return String(v || '').split(',').map((p) => p.trim()).filter(Boolean);
}

// Named people (added by the owner) are kept in one document. Their PINs are stored only as hashes.
let usersCache = null;
async function loadUsers(s, fresh) {
  if (!fresh && usersCache && Date.now() - usersCache.at < 20000) return usersCache.v;
  const v = (await s.get('users')) || {};
  usersCache = { at: Date.now(), v };
  return v;
}
function dropUsersCache() { usersCache = null; }
function pinHash(id, pin) { return crypto.createHash('sha256').update(id + ':' + pin).digest('hex'); }

const RANK = { team: 1, admin: 2, owner: 3 };

// Works out who is signing in: owner, manager or team member, by name when the PIN belongs to a person.
async function identify(pin) {
  const owner = pinList(process.env.OWNER_PIN);
  const admin = pinList(process.env.ADMIN_PIN);
  const team = pinList(process.env.TEAM_PIN);
  const envSet = owner.length + admin.length + team.length > 0;
  pin = pin ? String(pin) : '';
  let found = null;
  const take = (who) => { if (!found || RANK[who.role] > RANK[found.role]) found = who; };
  owner.forEach((p) => { if (same(pin, p)) take({ role: 'owner', id: 'owner', name: 'Owner', named: true }); });
  admin.forEach((p) => { if (same(pin, p)) take({ role: 'admin', id: 'shared-admin', name: 'Manager (shared PIN)', named: false }); });
  team.forEach((p) => { if (same(pin, p)) take({ role: 'team', id: 'shared-team', name: 'Team (shared PIN)', named: false }); });
  if (found) return found;
  const users = await loadUsers(store());
  if (!envSet && !Object.keys(users).length) throw httpErr(500, 'no_pins', 'No PINs are set.');
  if (!pin) return null;
  Object.keys(users).forEach((id) => {
    const u = users[id];
    if (u && u.active && u.pinHash && same(pinHash(u.id, pin), u.pinHash)) {
      take({ role: u.role === 'admin' ? 'admin' : 'team', id: u.id, name: u.name, named: true });
    }
  });
  return found;
}

async function requireRole(req, need) {
  const who = await identify(req.headers['x-pin']);
  if (!who) throw httpErr(401, 'unauthorized', 'Wrong PIN.');
  if (need === 'admin' && RANK[who.role] < RANK.admin) throw httpErr(403, 'forbidden', 'Managers only.');
  if (need === 'owner' && who.role !== 'owner') throw httpErr(403, 'forbidden', 'Owner only.');
  return who;
}

// A PIN must be unique across the shared PINs and every person.
async function pinTaken(pin) {
  const env = pinList(process.env.OWNER_PIN).concat(pinList(process.env.ADMIN_PIN), pinList(process.env.TEAM_PIN));
  if (env.indexOf(pin) !== -1) return true;
  const users = await loadUsers(store(), true);
  return Object.keys(users).some((id) => users[id].pinHash === pinHash(users[id].id, pin));
}

/* ---------- activity log and last seen ---------- */
function chicagoDay(ts) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(ts));
}

// One entry per action. Stored as set members so two people logging at once never overwrite each other.
async function logActivity(s, who, action, detail) {
  try {
    const ts = Date.now();
    await s.sadd('act:' + chicagoDay(ts), JSON.stringify({
      k: crypto.randomUUID().slice(0, 8), ts, who: who.name, role: who.role, action, detail: detail || {}
    }));
  } catch (e) { console.error('activity log failed', e); }
}

const lastTouch = {};
async function touchSeen(s, who) {
  try {
    if (!who || !who.named) return;
    const now = Date.now();
    if (lastTouch[who.id] && now - lastTouch[who.id] < 600000) return;
    lastTouch[who.id] = now;
    await s.set('seen:' + who.id, now);
  } catch (e) { /* last seen is a convenience only */ }
}

/* ---------- helpers ---------- */
function handler(fn) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      await fn(req, res);
    } catch (e) {
      const status = e.status || 500;
      if (!e.status) console.error(e);
      res.status(status).json({ error: e.code || 'server_error', message: e.status ? e.message : 'Server error.' });
    }
  };
}

function validDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

async function loadDocs(s, ids) {
  if (!ids.length) return [];
  const docs = await s.mget(ids.map((i) => 'insp:' + i));
  return docs.filter(Boolean);
}

function str(v, n) { return typeof v === 'string' ? v.trim().slice(0, n) : ''; }
function num(v, lo, hi) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
}

function cleanTargets(t) {
  const out = {};
  ['steer', 'drive', 'trailer'].forEach((k) => {
    const v = num(t && t[k], 30, 150);
    if (v === null) throw httpErr(400, 'bad_targets', 'Target PSI must be between 30 and 150.');
    out[k] = v;
  });
  return out;
}

module.exports = { httpErr, store, requireRole, identify, loadUsers, dropUsersCache, pinHash, pinTaken, logActivity, touchSeen, chicagoDay, handler, validDate, loadDocs, str, num, cleanTargets };
