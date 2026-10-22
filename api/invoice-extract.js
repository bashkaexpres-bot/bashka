'use strict';
const { httpErr, sb, requireStaff, toRecords, extract, mediaFor, handler } = require('./_invoice');

// Portal button "Upload invoice": the file is already in the private receipts bucket; read it and return the fields.
module.exports = handler(async (req, res) => {
  if (req.method !== 'POST') throw httpErr(405, 'method', 'Use POST.');
  await requireStaff(req);
  const path = String((req.body && req.body.path) || '');
  if (!/^uploads\/[a-zA-Z0-9._\/-]{3,200}$/.test(path) || path.indexOf('..') !== -1) throw httpErr(400, 'bad_path', 'Bad file path.');
  const mime = mediaFor(path, null);
  if (!mime) return res.status(200).json({ extraction: null, reason: 'This file type cannot be read automatically. Fill the fields in by hand.' });
  const r = await sb('/storage/v1/object/receipts/' + path.split('/').map(encodeURIComponent).join('/'));
  if (!r.ok) throw httpErr(404, 'not_found', 'Could not find the uploaded file.');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 12 * 1024 * 1024) return res.status(200).json({ extraction: null, reason: 'File is too large to read automatically.' });
  const extraction = await extract(buf, mime);
  const records = extraction ? await toRecords(extraction) : null;
  res.status(200).json({ extraction, records, vehicle_id: records && records[0] ? records[0].vehicle_id : null });
});
