'use strict';
const crypto = require('crypto');
const { httpErr, sb, sameSecret, matchVehicle, extract, mediaFor, handler, toStr } = require('./_invoice');

// Called by the Google script on the repairs@ mailbox: one request per attachment.
// The invoice is always saved for review. Nothing is ever approved automatically.
module.exports = handler(async (req, res) => {
  if (req.method !== 'POST') throw httpErr(405, 'method', 'Use POST.');
  const secret = process.env.INTAKE_SECRET;
  if (!secret) throw httpErr(503, 'not_configured', 'INTAKE_SECRET is not set on the server.');
  if (!sameSecret(req.headers['x-intake-secret'] || '', secret)) throw httpErr(401, 'unauthorized', 'Wrong secret.');
  const b = req.body || {};
  const mime = mediaFor(b.filename, b.mime);
  if (!mime) throw httpErr(415, 'bad_type', 'Only PDF and photo attachments are accepted.');
  const buf = Buffer.from(String(b.data || ''), 'base64');
  if (!buf.length || buf.length > 8 * 1024 * 1024) throw httpErr(413, 'bad_size', 'File is empty or too large.');

  // protect against a flood of mail: at most 60 emailed invoices per day
  const since = new Date(Date.now() - 86400000).toISOString();
  const cr = await sb('/rest/v1/repair_invoices?select=id&source=eq.email&created_at=gte.' + encodeURIComponent(since), { headers: { Prefer: 'count=exact', Range: '0-0' } });
  const total = Number((cr.headers.get('content-range') || '').split('/')[1]) || 0;
  if (total >= 60) throw httpErr(429, 'too_many', 'Daily limit reached.');

  const safe = String(b.filename || 'invoice').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
  const ym = new Date().toISOString().slice(0, 7);
  const path = 'email/' + ym + '/' + crypto.randomUUID() + '-' + safe;
  const up = await sb('/storage/v1/object/receipts/' + path, { method: 'POST', headers: { 'Content-Type': mime }, body: buf });
  if (!up.ok) throw httpErr(502, 'upload_failed', 'Could not save the file.');

  let ex = null, aiNote = null;
  try { ex = await extract(buf, mime); } catch (e) { aiNote = e.message; }
  if (ex && ex.is_repair_invoice === false) {
    // not an invoice (ad, signature image, etc.): keep the file but flag it clearly
    ex.summary = 'Not recognised as a repair invoice. ' + (ex.summary || '');
  }
  const vehicle_id = ex ? await matchVehicle(ex.truck_unit) : null;

  const row = {
    source: 'email', status: 'review', vehicle_id, unit_text: ex ? ex.truck_unit : null,
    vendor: ex && ex.vendor, invoice_number: ex && ex.invoice_number, invoice_date: ex && ex.invoice_date,
    odometer: ex && ex.odometer, subtotal: ex && ex.subtotal, tax: ex && ex.tax, total: ex && ex.total,
    summary: ex ? ex.summary : (aiNote ? 'Could not be read automatically. Fill in by hand.' : null),
    file_path: path, file_name: toStr(b.filename, 200), email_from: toStr(b.from, 300), email_subject: toStr(b.subject, 300),
    ai_confidence: ex ? ex.confidence : null
  };
  const ir = await sb('/rest/v1/repair_invoices', { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify(row) });
  if (!ir.ok) throw httpErr(502, 'save_failed', 'Could not save the invoice record.');
  const inv = (await ir.json())[0];
  if (ex && ex.lines.length) {
    const lr = await sb('/rest/v1/repair_lines', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ex.lines.map((l) => Object.assign({ invoice_id: inv.id }, l))) });
    if (!lr.ok) console.error('lines save failed', await lr.text());
  }
  res.status(201).json({ id: inv.id, read: !!ex });
});
