// Bashka Express — repairs mailbox reader (Google Apps Script)
// Runs inside the repairs@ Google account. Every 10 minutes it sends new PDF / photo invoices
// to the portal, which reads them and puts them in the Maintenance "Review" list. Nothing is auto-approved.
// Setup: Project Settings > Script properties > add INTAKE_SECRET (same value as on Vercel). Then run setup() once.

const ENDPOINT = 'https://bashka-three.vercel.app/api/invoice-intake';
const MAX_BYTES = 3000000;   // larger files: upload them from the portal instead
const MIN_BYTES = 15000;     // skips tiny logos and signature images

// Known shops. Mail from anyone ELSE is still read and goes to Review, but is tagged [NEW SENDER] at the end of the summary so you can check it.
// Use full addresses, or @domain.com for a whole company.
// You can also add more in Project Settings > Script properties > ALLOWED_SENDERS (comma separated), no code change needed.
const ALLOWED_SENDERS = [
  'tstruckandtrailer@gmail.com',
  'ali@bashkaexpress.com',
  'bashkaexpres@gmail.com'
];

function allowedList_() {
  const extra = (PropertiesService.getScriptProperties().getProperty('ALLOWED_SENDERS') || '').split(',');
  return ALLOWED_SENDERS.concat(extra).map(function (x) { return String(x).trim().toLowerCase(); }).filter(Boolean);
}

function senderOk_(from, list) {
  const m = /<([^>]+)>/.exec(from || '');
  const addr = (m ? m[1] : String(from || '')).trim().toLowerCase();
  return list.some(function (a) { return a.charAt(0) === '@' ? addr.slice(-a.length) === a : addr === a; });
}

function processInbox() {
  const secret = PropertiesService.getScriptProperties().getProperty('INTAKE_SECRET');
  if (!secret) throw new Error('Add the INTAKE_SECRET script property first.');
  const sent = GmailApp.getUserLabelByName('invoice-sent') || GmailApp.createLabel('invoice-sent');
  const problem = GmailApp.getUserLabelByName('invoice-problem') || GmailApp.createLabel('invoice-problem');
  const skipped = GmailApp.getUserLabelByName('invoice-skipped') || GmailApp.createLabel('invoice-skipped');
  const allowed = allowedList_();
  const threads = GmailApp.search('in:inbox has:attachment -label:invoice-sent -label:invoice-problem -label:invoice-skipped newer_than:30d', 0, 20);
  threads.forEach(function (th) {
    let ok = 0, fail = 0;
    th.getMessages().forEach(function (m) {
      const known = senderOk_(m.getFrom(), allowed);
      m.getAttachments({ includeInlineImages: true, includeAttachments: true }).forEach(function (a) {
        const type = a.getContentType(), name = a.getName();
        const good = /^(application\/pdf|image\/(jpeg|png|webp))$/.test(type) || /\.(pdf|jpe?g|png|webp)$/i.test(name);
        if (!good || a.getSize() < MIN_BYTES) return;
        if (a.getSize() > MAX_BYTES) { fail++; return; }
        const res = UrlFetchApp.fetch(ENDPOINT, {
          method: 'post', contentType: 'application/json', muteHttpExceptions: true,
          headers: { 'x-intake-secret': secret },
          payload: JSON.stringify({ filename: name, mime: type, data: Utilities.base64Encode(a.getBytes()), from: m.getFrom(), subject: m.getSubject(), known: known })
        });
        if (res.getResponseCode() === 201) ok++; else fail++;
      });
    });
    th.addLabel(fail ? problem : (ok ? sent : skipped)); // skipped = nothing usable was attached
  });
}

// Receipts that arrive as the email itself (Clover, Square, etc.) have no attachment, so the pass above never sees them.
// This pass turns the email text into a PDF and sends it the same way. It only does this for known senders (and @clover.com),
// and only when the email really looks like a receipt (has a dollar amount plus a receipt word). Everything still lands in Review.
const BODY_SENDERS_EXTRA = ['@clover.com'];

function processBodyReceipts() {
  const secret = PropertiesService.getScriptProperties().getProperty('INTAKE_SECRET');
  if (!secret) throw new Error('Add the INTAKE_SECRET script property first.');
  const sent = GmailApp.getUserLabelByName('invoice-sent') || GmailApp.createLabel('invoice-sent');
  const problem = GmailApp.getUserLabelByName('invoice-problem') || GmailApp.createLabel('invoice-problem');
  const skipped = GmailApp.getUserLabelByName('invoice-skipped') || GmailApp.createLabel('invoice-skipped');
  const allowed = allowedList_();
  const bodyAllowed = allowed.concat(BODY_SENDERS_EXTRA);
  const threads = GmailApp.search('in:inbox -has:attachment -label:invoice-sent -label:invoice-problem -label:invoice-skipped newer_than:30d', 0, 20);
  threads.forEach(function (th) {
    let ok = 0, fail = 0;
    th.getMessages().forEach(function (m) {
      if (!senderOk_(m.getFrom(), bodyAllowed)) return;
      const plain = m.getPlainBody() || '';
      if (!(/\$\s?\d[\d,]*\.\d{2}/.test(plain) && /(total|subtotal|invoice|receipt|amount paid|order id|payment id)/i.test(plain))) return;
      let pdf;
      try {
        const html = '<html><body style="font-family:Arial,sans-serif">' + '<p><b>From:</b> ' + String(m.getFrom()).replace(/[<>&]/g, ' ') + '<br><b>Subject:</b> ' + String(m.getSubject()).replace(/[<>&]/g, ' ') + '<br><b>Email date:</b> ' + m.getDate() + '</p>' + m.getBody() + '</body></html>';
        pdf = Utilities.newBlob(html, 'text/html', 'receipt.html').getAs('application/pdf');
      } catch (e) { fail++; return; }
      if (pdf.getBytes().length > MAX_BYTES) { fail++; return; }
      const res = UrlFetchApp.fetch(ENDPOINT, {
        method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        headers: { 'x-intake-secret': secret },
        payload: JSON.stringify({ filename: 'email-receipt.pdf', mime: 'application/pdf', data: Utilities.base64Encode(pdf.getBytes()), from: m.getFrom(), subject: m.getSubject(), known: senderOk_(m.getFrom(), allowed) })
      });
      if (res.getResponseCode() === 201) ok++; else fail++;
    });
    th.addLabel(fail ? problem : (ok ? sent : skipped));
  });
}

function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('processInbox').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('processBodyReceipts').timeBased().everyMinutes(10).create();
}
