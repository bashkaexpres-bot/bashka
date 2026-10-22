'use strict';
const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ghrbrwusfyjprxhivxfo.supabase.co';
const ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_NAFw4krk8evjh7Bx0VFD9g_EcuThMES';
const MODEL = process.env.INVOICE_MODEL || 'claude-sonnet-5-5';

function httpErr(status, code, message) { const e = new Error(message || code); e.status = status; e.code = code; return e; }

function service() {
  const k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!k) throw httpErr(500, 'not_configured', 'SUPABASE_SERVICE_ROLE_KEY is not set on the server.');
  return k;
}

async function sb(path, opts) {
  const k = service();
  const r = await fetch(SUPABASE_URL + path, Object.assign({}, opts, {
    headers: Object.assign({ apikey: k, Authorization: 'Bearer ' + k }, (opts && opts.headers) || {})
  }));
  return r;
}

/* Only signed-in dispatch staff (admin or dispatcher) may call the portal endpoint. */
async function requireStaff(req) {
  const m = /^Bearer\s+(\S+)$/.exec(String(req.headers.authorization || ''));
  if (!m) throw httpErr(401, 'unauthorized', 'Sign in to the dispatch portal first.');
  const token = m[1];
  const r = await fetch(SUPABASE_URL + '/auth/v1/user', { headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + token } });
  if (!r.ok) throw httpErr(401, 'unauthorized', 'Sign in to the dispatch portal first.');
  const rr = await fetch(SUPABASE_URL + '/rest/v1/rpc/get_my_role', {
    method: 'POST', headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: '{}'
  });
  const role = rr.ok ? await rr.json() : null;
  if (role !== 'admin' && role !== 'dispatcher') throw httpErr(403, 'forbidden', 'Staff only.');
  return true;
}

function sameSecret(a, b) {
  const h = (s) => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

function norm(v) {
  let t = String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '');
  t = t.replace(/^(UNIT|TRUCK|TRK|T)(?=\d)/, '');
  if (/^0+\d/.test(t)) t = t.replace(/^0+/, '');
  return t;
}

/* Finds the truck in the fleet from whatever the invoice shows (unit number, VIN, or plate). */
async function matchVehicle(unitText) {
  const raw = String(unitText || '').trim();
  if (!raw) return null;
  const r = await sb('/rest/v1/vehicles?select=id,unit_number,vehicle_code,vin,plate');
  if (!r.ok) return null;
  const list = await r.json();
  const n = norm(raw);
  if (!n) return null;
  let hit = list.find((v) => norm(v.unit_number) === n || norm(v.vehicle_code) === n);
  if (!hit && n.length >= 6) hit = list.find((v) => v.vin && (norm(v.vin) === n || (n.length >= 6 && norm(v.vin).endsWith(n))));
  if (!hit && n.length >= 4) hit = list.find((v) => v.plate && norm(v.plate) === n);
  return hit ? hit.id : null;
}

const CATEGORIES = ['oil_change', 'brakes', 'tires', 'engine', 'transmission', 'electrical', 'suspension', 'cooling', 'exhaust', 'air_system', 'trailer', 'body', 'inspection', 'other'];

const TOOL = {
  name: 'record_invoice',
  description: 'Record what is printed on a truck repair or maintenance invoice.',
  input_schema: {
    type: 'object',
    properties: {
      is_repair_invoice: { type: 'boolean', description: 'false if this is not a repair, parts or maintenance invoice or receipt' },
      vendor: { type: ['string', 'null'], description: 'Shop or supplier name' },
      invoice_number: { type: ['string', 'null'] },
      invoice_date: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
      truck_unit: { type: ['string', 'null'], description: 'Truck / unit number as written on the invoice. If only a VIN or plate is shown, give that.' },
      odometer: { type: ['integer', 'null'], description: 'Miles on the truck, if shown' },
      subtotal: { type: ['number', 'null'] },
      tax: { type: ['number', 'null'] },
      total: { type: ['number', 'null'] },
      summary: { type: ['string', 'null'], description: 'One or two plain sentences: what was fixed or serviced' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      lines: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['part', 'labor', 'other'] },
            category: { type: 'string', enum: CATEGORIES },
            description: { type: 'string' },
            part_number: { type: ['string', 'null'] },
            quantity: { type: ['number', 'null'] },
            unit_price: { type: ['number', 'null'] },
            amount: { type: ['number', 'null'] }
          },
          required: ['kind', 'description']
        }
      }
    },
    required: ['is_repair_invoice', 'confidence', 'lines']
  }
};

const PROMPT = 'You read truck repair and maintenance invoices for a trucking fleet. Copy only what is printed. Never guess or invent a value: use null when something is not shown. ' +
  'Dates must be YYYY-MM-DD. Amounts are plain numbers. Put each part as kind "part", each labor charge as kind "labor", and shop fees, supplies, disposal, towing or similar as kind "other". ' +
  'Do not put tax in the lines; use the tax field. Pick the closest category for every line (oil_change for oil, filters and lube service). ' +
  'If the page is not a repair, parts or maintenance invoice, set is_repair_invoice to false. Call record_invoice once.';

const MEDIA = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
function mediaFor(name, mime) {
  const m = String(mime || '').toLowerCase();
  if (Object.values(MEDIA).indexOf(m) !== -1) return m;
  const ext = String(name || '').toLowerCase().split('.').pop();
  return MEDIA[ext] || null;
}

function toNum(v) { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function toDate(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null; }
function toStr(v, n) { v = v == null ? '' : String(v).trim(); return v ? v.slice(0, n) : null; }

function clean(inp) {
  const lines = (Array.isArray(inp.lines) ? inp.lines : []).slice(0, 80).map((l, i) => ({
    sort_order: i,
    kind: ['part', 'labor', 'other'].indexOf(l.kind) !== -1 ? l.kind : 'other',
    category: CATEGORIES.indexOf(l.category) !== -1 ? l.category : 'other',
    description: toStr(l.description, 500) || '(no description)',
    part_number: toStr(l.part_number, 80),
    quantity: toNum(l.quantity), unit_price: toNum(l.unit_price), amount: toNum(l.amount)
  }));
  return {
    is_repair_invoice: inp.is_repair_invoice !== false,
    vendor: toStr(inp.vendor, 200), invoice_number: toStr(inp.invoice_number, 80), invoice_date: toDate(inp.invoice_date),
    truck_unit: toStr(inp.truck_unit, 40),
    odometer: toNum(inp.odometer) != null ? Math.max(0, Math.round(toNum(inp.odometer))) : null,
    subtotal: toNum(inp.subtotal), tax: toNum(inp.tax), total: toNum(inp.total),
    summary: toStr(inp.summary, 2000),
    confidence: ['high', 'medium', 'low'].indexOf(inp.confidence) !== -1 ? inp.confidence : 'low',
    lines
  };
}

/* Sends the file to Claude and returns the cleaned fields. Returns null when it cannot be read automatically. */
async function extract(buffer, mime) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw httpErr(503, 'ai_not_configured', 'ANTHROPIC_API_KEY is not set on the server.');
  const data = buffer.toString('base64');
  const block = mime === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: mime, data } }
    : { type: 'image', source: { type: 'base64', media_type: mime, data } };
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 4096,
      tools: [TOOL], tool_choice: { type: 'tool', name: 'record_invoice' },
      messages: [{ role: 'user', content: [block, { type: 'text', text: PROMPT }] }]
    })
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw httpErr(502, 'ai_failed', 'The invoice reader failed (' + r.status + '). ' + t.slice(0, 200));
  }
  const j = await r.json();
  const tu = (j.content || []).find((c) => c.type === 'tool_use' && c.name === 'record_invoice');
  if (!tu) return null;
  return clean(tu.input || {});
}

function handler(fn) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { await fn(req, res); } catch (e) {
      const status = e.status || 500;
      if (!e.status) console.error(e);
      res.status(status).json({ error: e.code || 'error', message: e.status ? e.message : 'Something went wrong.' });
    }
  };
}

module.exports = { httpErr, sb, requireStaff, sameSecret, matchVehicle, extract, mediaFor, handler, toStr, SUPABASE_URL };
