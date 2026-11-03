'use strict';
// Web Push (RFC 8030 / 8291 / 8292) using only Node's built-in crypto. No extra packages.
const crypto = require('crypto');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s || ''), 'base64url');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// RFC 8291 "aes128gcm" message encryption. opts (salt, asPrivate) exist only so the unit test can use the RFC example.
function encrypt(sub, payload, opts) {
  opts = opts || {};
  const uaPublic = unb64u(sub.keys && sub.keys.p256dh);
  const authSecret = unb64u(sub.keys && sub.keys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length < 8) throw new Error('bad subscription keys');
  const ecdh = crypto.createECDH('prime256v1');
  if (opts.asPrivate) ecdh.setPrivateKey(unb64u(opts.asPrivate)); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPublic);
  const salt = opts.salt ? unb64u(opts.salt) : crypto.randomBytes(16);

  const prkKey = hmac(authSecret, secret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);

  const plain = Buffer.concat([Buffer.from(payload), Buffer.from([2])]); // 0x02 = last record, no padding
  if (plain.length > 4096 - 17) throw new Error('payload too large');
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ct]);
}

// RFC 8292 VAPID: a short-lived signed token that tells the push service the message comes from us.
function vapidAuth(endpoint, subject, publicKey, privateKey) {
  const pub = unb64u(publicKey), d = unb64u(privateKey);
  if (pub.length !== 65 || pub[0] !== 4 || d.length !== 32) throw new Error('bad VAPID keys');
  const key = crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: b64u(d) }, format: 'jwk' });
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + body), { key, dsaEncoding: 'ieee-p1363' });
  return 'vapid t=' + head + '.' + body + '.' + b64u(sig) + ', k=' + b64u(pub);
}

// Returns { ok, status, gone }. gone = the phone removed the subscription, so we should forget it.
async function sendPush(sub, payloadObj, vapid) {
  const url = new URL(sub.endpoint);
  if (url.protocol !== 'https:') return { ok: false, status: 0, gone: false };
  const body = encrypt(sub, JSON.stringify(payloadObj));
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch(sub.endpoint, {
      method: 'POST', signal: ctl.signal,
      headers: {
        Authorization: vapidAuth(sub.endpoint, vapid.subject, vapid.publicKey, vapid.privateKey),
        'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '3600', Urgency: 'high'
      },
      body
    });
    return { ok: r.status >= 200 && r.status < 300, status: r.status, gone: r.status === 404 || r.status === 410 };
  } catch (e) {
    return { ok: false, status: 0, gone: false };
  } finally { clearTimeout(t); }
}

module.exports = { encrypt, vapidAuth, sendPush, b64u, unb64u };
