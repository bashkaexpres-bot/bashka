'use strict';
const { httpErr, sb, requireStaff, handler } = require('./_invoice');
const { sendPush } = require('./_push');

// Portal: right after a job is posted, alert the drivers who could actually accept it.
// Staff only. A job is announced once. The alert never contains pay.
module.exports = handler(async (req, res) => {
  if (req.method !== 'POST') throw httpErr(405, 'method', 'Use POST.');
  await requireStaff(req);
  const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:ali@bashkaexpress.com';
  if (!pub || !priv) throw httpErr(503, 'not_configured', 'Phone alerts are not set up yet (VAPID keys missing in Vercel).');
  const id = String((req.body && req.body.work_id) || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw httpErr(400, 'bad_id', 'Bad job id.');

  const jr = await sb('/rest/v1/open_work?select=id,title,work_date,start_time,end_time,status,push_sent_at&id=eq.' + id);
  const job = jr.ok ? (await jr.json())[0] : null;
  if (!job) throw httpErr(404, 'not_found', 'Job not found.');
  if (job.status !== 'open') throw httpErr(409, 'not_open', 'This job is not open.');
  if (job.push_sent_at) throw httpErr(409, 'already_sent', 'Drivers were already alerted about this job.');

  // claim the send first, so a double click cannot alert twice
  const claim = await sb('/rest/v1/open_work?id=eq.' + id + '&push_sent_at=is.null', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify({ push_sent_at: new Date().toISOString() })
  });
  const claimed = claim.ok ? await claim.json() : [];
  if (!claimed.length) throw httpErr(409, 'already_sent', 'Drivers were already alerted about this job.');

  const sr = await sb('/rest/v1/push_subscriptions?select=id,driver_id,endpoint,p256dh,auth,drivers!inner(status)&drivers.status=eq.active');
  const subs = sr.ok ? await sr.json() : [];

  const when = new Date(job.work_date + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const hm = (t) => { const p = String(t).split(':'); let h = +p[0]; const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return h + ':' + (p[1] || '00') + ' ' + ap; };
  const payload = { title: '📣 New work available', body: String(job.title).slice(0, 80) + ' · ' + when + ' ' + hm(job.start_time) + '-' + hm(job.end_time), tag: 'open-work-' + id, url: '/driver-app.html' };

  const free = new Map(); // driver_id -> can accept?
  const canAccept = async (driverId) => {
    if (free.has(driverId)) return free.get(driverId);
    let ok = true;
    try {
      const r = await sb('/rest/v1/rpc/open_work_conflict', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_driver: driverId, p_date: job.work_date, p_start: job.start_time, p_end: job.end_time, p_exclude: job.id })
      });
      if (r.ok) ok = (await r.json()) === null;
    } catch (e) { ok = true; } // if the check cannot run, alert anyway; the app still blocks the accept
    free.set(driverId, ok);
    return ok;
  };

  let sent = 0, skipped = 0, failed = 0;
  for (const s of subs) {
    if (!(await canAccept(s.driver_id))) { skipped++; continue; }
    const out = await sendPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { subject, publicKey: pub, privateKey: priv });
    if (out.ok) sent++; else failed++;
    if (out.gone) await sb('/rest/v1/push_subscriptions?id=eq.' + s.id, { method: 'DELETE' });
  }
  res.status(200).json({ sent, skipped, failed, subscribed: subs.length });
});
