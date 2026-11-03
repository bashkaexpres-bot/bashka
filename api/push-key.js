'use strict';
const { httpErr, handler } = require('./_invoice');

// The driver app asks for the PUBLIC half of the notification key. (The private half never leaves the server.)
module.exports = handler(async (req, res) => {
  if (req.method !== 'GET') throw httpErr(405, 'method', 'Use GET.');
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) throw httpErr(503, 'not_configured', 'Phone alerts are not set up yet.');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.status(200).json({ key });
});
