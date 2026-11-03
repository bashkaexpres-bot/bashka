'use strict';
const { httpErr, SUPABASE_URL, handler } = require('./_invoice');

// Portal page "DOT Compliance": reads the company's public FMCSA record (QCMobile API).
// The FMCSA web key lives only in the server setting FMCSA_WEBKEY. It is never sent to a browser or written to a log.
const ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_NAFw4krk8evjh7Bx0VFD9g_EcuThMES';
const BASE = 'https://mobile.fmcsa.dot.gov/qc/services';

async function requireAdmin(req) {
  const m = /^Bearer\s+(\S+)$/.exec(String(req.headers.authorization || ''));
  if (!m) throw httpErr(401, 'unauthorized', 'Sign in to the dispatch portal first.');
  const token = m[1];
  const u = await fetch(SUPABASE_URL + '/auth/v1/user', { headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + token } });
  if (!u.ok) throw httpErr(401, 'unauthorized', 'Sign in to the dispatch portal first.');
  const r = await fetch(SUPABASE_URL + '/rest/v1/rpc/get_my_role', {
    method: 'POST', headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: '{}'
  });
  const role = r.ok ? await r.json() : null;
  if (role !== 'admin') throw httpErr(403, 'forbidden', 'Admins only.');
}

async function get(path, key) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(BASE + path + (path.includes('?') ? '&' : '?') + 'webKey=' + encodeURIComponent(key), { signal: ctl.signal, headers: { Accept: 'application/json' } });
    if (r.status === 401 || r.status === 403) return { error: 'FMCSA rejected the web key (check FMCSA_WEBKEY).' };
    if (r.status === 404) return { error: 'Not found at FMCSA.' };
    if (!r.ok) return { error: 'FMCSA answered with status ' + r.status + '.' };
    return { data: await r.json() };
  } catch (e) {
    return { error: e && e.name === 'AbortError' ? 'FMCSA did not answer in time.' : 'Could not reach FMCSA.' };
  } finally { clearTimeout(t); }
}

module.exports = handler(async (req, res) => {
  if (req.method !== 'GET') throw httpErr(405, 'method', 'Use GET.');
  await requireAdmin(req);
  const key = process.env.FMCSA_WEBKEY;
  if (!key) throw httpErr(503, 'not_configured', 'FMCSA_WEBKEY is not set yet. Add it in Vercel (Settings, Environment Variables) and redeploy.');
  const dot = String(process.env.FMCSA_DOT || '1930147').replace(/\D/g, '');
  if (!dot) throw httpErr(500, 'bad_config', 'FMCSA_DOT is not a number.');

  const parts = { carrier: '', basics: '/basics', authority: '/authority', docket: '/docket-numbers', operations: '/operation-classification', cargo: '/cargo-carried' };
  const names = Object.keys(parts);
  const out = await Promise.all(names.map((n) => get('/carriers/' + dot + parts[n], key)));
  const result = { fetched_at: new Date().toISOString(), dot_number: dot, errors: {} };
  names.forEach((n, i) => { if (out[i].error) result.errors[n] = out[i].error; else result[n] = out[i].data; });
  if (result.errors.carrier && !result.carrier) throw httpErr(502, 'fmcsa_failed', result.errors.carrier);
  res.status(200).json(result);
});
