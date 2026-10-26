'use strict';
const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ghrbrwusfyjprxhivxfo.supabase.co';
const ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_NAFw4krk8evjh7Bx0VFD9g_EcuThMES';
const MODEL = process.env.INVOICE_MODEL || 'claude-sonnet-5-5';

function httpErr(status, code, message) { const e = new Error(message || code); e.status = status; e.code = code; return e; }

function service() {
  let k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!k) { // tolerate a mistyped variable name: any variable with SERVICE_ROLE in its name that holds a JWT
    const alt = Object.keys(process.env).find((n) => /SERVICE.?ROLE/i.test(n) && /^eyJ/.test(process.env[n] || ''));
    if (alt) k = process.env[alt];
  }
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

/* Finds the truck (or, failing that, the trailer) from whatever the invoice shows: unit number, VIN, or plate. */
async function matchUnit(unitText) {
  const none = { vehicle_id: null, trailer_id: null };
  const raw = String(unitText || '').trim();
  if (!raw) return none;
  const n = norm(raw);
  if (!n) return none;
  const r = await sb('/rest/v1/vehicles?select=id,unit_number,vehicle_code,vin,plate');
  if (r.ok) {
    const list = await r.json();
    let hit = list.find((v) => norm(v.unit_number) === n || norm(v.vehicle_code) === n);
    if (!hit && n.length >= 6) hit = list.find((v) => v.vin && (norm(v.vin) === n || norm(v.vin).endsWith(n)));
    if (!hit && n.length >= 4) hit = list.find((v) => v.plate && norm(v.plate) === n);
    if (hit) return { vehicle_id: hit.id, trailer_id: null };
  }
  const tr = await sb('/rest/v1/trailers?select=id,unit_number');
  if (tr.ok) {
    const th = (await tr.json()).find((t) => norm(t.unit_number) === n);
    if (th) return { vehicle_id: null, trailer_id: th.id };
  }
  return none;
}
async function matchVehicle(unitText) { return (await matchUnit(unitText)).vehicle_id; }

const CATEGORIES = ['oil_change', 'brakes', 'tires', 'engine', 'transmission', 'electrical', 'suspension', 'cooling', 'exhaust', 'air_system', 'trailer', 'body', 'inspection', 'other'];

const TOOL = {
  name: 'record_invoice',
  description: 'Record what is printed on a truck repair or maintenance invoice.',
  input_schema: {
    type: 'object',
    properties: {
      is_repair_invoice: { type: 'boolean', description: 'false only if this is not a repair, rental, parts or maintenance invoice or receipt at all' },
      document_type: { type: 'string', enum: ['invoice', 'estimate', 'quote', 'other'], description: 'What the document calls itself. Use estimate or quote ONLY if the page says so (Estimate, Quote, Proposal, Quotation, Not an invoice, Valid for N days, Pre-authorization). Otherwise invoice.' },
      record_type: { type: 'string', enum: ['repair', 'rental', 'parts', 'wash', 'parking', 'other'], description: 'repair = shop work on a unit (parts and/or labor). rental = a rented truck, trailer or equipment (rental company invoice: daily or weekly rate, mileage, fuel, insurance or damage waiver). parts = a parts, tires or supplies purchase from a store or supplier with no shop labor (a receipt or counter sale). wash = a truck wash, trailer wash or car wash receipt or invoice. parking = truck or trailer parking, yard or lot rental, storage or overnight parking fees. other = any other business expense for the fleet that is not shop work, such as tolls, permits, scale tickets or supplies. If unsure, repair.' },
      vendor: { type: ['string', 'null'], description: 'Shop, rental company or supplier name' },
      invoice_number: { type: ['string', 'null'] },
      invoice_date: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
      subtotal: { type: ['number', 'null'] },
      tax: { type: ['number', 'null'] },
      total: { type: ['number', 'null'] },
      summary: { type: ['string', 'null'], description: 'One or two plain sentences: what was fixed or serviced' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      trucks: {
        type: 'array',
        description: 'One entry per truck, trailer or unit that was worked on. A single-truck invoice has exactly one entry. If one invoice lists work for several units, give each unit its own entry with only its own lines.',
        items: {
          type: 'object',
          properties: {
            truck_unit: { type: ['string', 'null'], description: 'Unit number exactly as printed for this group. If only a VIN, plate or make is shown, give that.' },
            odometer: { type: ['integer', 'null'], description: 'Miles on this unit, if shown' },
            summary: { type: ['string', 'null'], description: 'One or two plain sentences: what was fixed on this unit' },
            subtotal: { type: ['number', 'null'], description: 'Printed subtotal for this unit, if shown' },
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
          required: ['lines']
        }
      }
    },
    required: ['is_repair_invoice', 'confidence', 'trucks']
  }
};

const PROMPT = 'You read truck repair and maintenance invoices for a trucking fleet. Copy only what is printed. Never guess or invent a value: use null when something is not shown. ' +
  'Dates must be YYYY-MM-DD. Amounts are plain numbers. Put each part as kind "part", each labor charge as kind "labor", and shop fees, supplies, disposal, towing or similar as kind "other". ' +
  'Do not put tax in the lines; use the tax field. If the invoice covers several trucks or units, put each one in its own trucks entry with only its own lines, and do not make a line out of a unit subtotal. Copy each unit label exactly as printed. Pick the closest category for every line (oil_change for oil, filters and lube service). ' +
  'Set record_type to rental when a rental company bills for a rented truck, trailer or equipment (put each charge such as rate, mileage, fuel, insurance, taxes and fees as a line with kind "other", and give the rental unit number or plate as truck_unit if shown), to parts when it is a parts, tires or supplies purchase with no shop labor, to wash for a truck wash, trailer wash or similar cleaning charge, to parking for truck or trailer parking, yard, lot or storage fees, to other for any other fleet expense that is not shop work (one line with kind "other" per charge for wash, parking and other), and otherwise to repair. If the page is not a repair, rental, parts, wash, parking or other fleet expense invoice or receipt at all, set is_repair_invoice to false. You must answer by calling the record_invoice tool exactly once, and write nothing else.';

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

const ALIASES = { HINO: '46002' }; // labels the shop uses for a unit that is not its number

function cleanLines(arr) {
  return (Array.isArray(arr) ? arr : []).slice(0, 80).map((l, i) => ({
    sort_order: i,
    kind: ['part', 'labor', 'other'].indexOf(l.kind) !== -1 ? l.kind : 'other',
    category: CATEGORIES.indexOf(l.category) !== -1 ? l.category : 'other',
    description: toStr(l.description, 500) || '(no description)',
    part_number: toStr(l.part_number, 80),
    quantity: toNum(l.quantity), unit_price: toNum(l.unit_price), amount: toNum(l.amount)
  }));
}

function clean(inp) {
  let trucks = (Array.isArray(inp.trucks) ? inp.trucks : []).slice(0, 40).map((t) => {
    const lines = cleanLines(t.lines);
    let unit = toStr(t.truck_unit, 40);
    if (unit && ALIASES[unit.toUpperCase().trim()]) unit = ALIASES[unit.toUpperCase().trim()];
    return {
      truck_unit: unit,
      odometer: toNum(t.odometer) != null ? Math.max(0, Math.round(toNum(t.odometer))) : null,
      summary: toStr(t.summary, 2000), subtotal: toNum(t.subtotal), lines
    };
  }).filter((t) => t.lines.length || t.truck_unit);
  if (!trucks.length) trucks = [{ truck_unit: null, odometer: null, summary: null, subtotal: null, lines: [] }];
  const first = trucks[0];
  return {
    is_repair_invoice: inp.is_repair_invoice !== false,
    record_type: ['repair', 'rental', 'parts', 'wash', 'parking', 'other'].indexOf(inp.record_type) !== -1 ? inp.record_type : 'repair',
    document_type: ['invoice', 'estimate', 'quote', 'other'].indexOf(inp.document_type) !== -1 ? inp.document_type : 'invoice',
    vendor: toStr(inp.vendor, 200), invoice_number: toStr(inp.invoice_number, 80), invoice_date: toDate(inp.invoice_date),
    subtotal: toNum(inp.subtotal), tax: toNum(inp.tax), total: toNum(inp.total),
    summary: toStr(inp.summary, 2000),
    confidence: ['high', 'medium', 'low'].indexOf(inp.confidence) !== -1 ? inp.confidence : 'low',
    trucks,
    // single-truck shortcuts (kept for older callers)
    truck_unit: first.truck_unit, odometer: first.odometer, lines: first.lines
  };
}

/* Turns one reading into one record per truck. A single-truck invoice gives one record, same as before. */
async function toRecords(ex) {
  const multi = ex.trucks.length > 1;
  const est = ex.document_type === 'estimate' || ex.document_type === 'quote' ? '[ESTIMATE] The page says it is an ' + ex.document_type + ', not a final invoice. ' : '';
  const sum = (ls) => Math.round(ls.reduce((a, l) => a + (l.amount || 0), 0) * 100) / 100;
  const out = [];
  for (const t of ex.trucks) {
    const m = ex.record_type === 'rental' ? { vehicle_id: null, trailer_id: null } : await matchUnit(t.truck_unit);
    const lineTotal = sum(t.lines);
    out.push({
      record_type: ex.record_type, vehicle_id: m.vehicle_id, trailer_id: m.trailer_id, unit_text: t.truck_unit, odometer: t.odometer,
      invoice_number: multi && ex.invoice_number ? (ex.invoice_number + ' / ' + (t.truck_unit || '?')).slice(0, 80) : ex.invoice_number,
      subtotal: multi ? lineTotal : ex.subtotal, tax: multi ? null : ex.tax, total: multi ? lineTotal : ex.total,
      summary: est + (multi ? '[1 of ' + ex.trucks.length + ' units on one invoice' + (ex.total != null ? ', whole invoice $' + ex.total.toFixed(2) : '') + ']  ' : '') + (t.summary || ex.summary || ''),
      lines: t.lines
    });
  }
  return out;
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
      model: MODEL, max_tokens: 16000,
      tools: [TOOL], tool_choice: { type: 'auto' },
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

module.exports = { httpErr, sb, requireStaff, sameSecret, matchVehicle, toRecords, extract, mediaFor, handler, toStr, SUPABASE_URL };
