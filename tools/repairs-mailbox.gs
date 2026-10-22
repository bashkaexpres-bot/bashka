// Bashka Express — repairs mailbox reader (Google Apps Script)
// Runs inside the repairs@ Google account. Every 10 minutes it sends new PDF / photo invoices
// to the portal, which reads them and puts them in the Maintenance "Review" list. Nothing is auto-approved.
// Setup: Project Settings > Script properties > add INTAKE_SECRET (same value as on Vercel). Then run setup() once.

const ENDPOINT = 'https://bashka-three.vercel.app/api/invoice-intake';
const MAX_BYTES = 3000000;   // larger files: upload them from the portal instead
const MIN_BYTES = 15000;     // skips tiny logos and signature images

function processInbox() {
  const secret = PropertiesService.getScriptProperties().getProperty('INTAKE_SECRET');
  if (!secret) throw new Error('Add the INTAKE_SECRET script property first.');
  const sent = GmailApp.getUserLabelByName('invoice-sent') || GmailApp.createLabel('invoice-sent');
  const problem = GmailApp.getUserLabelByName('invoice-problem') || GmailApp.createLabel('invoice-problem');
  const threads = GmailApp.search('in:inbox has:attachment -label:invoice-sent -label:invoice-problem newer_than:30d', 0, 20);
  threads.forEach(function (th) {
    let ok = 0, fail = 0;
    th.getMessages().forEach(function (m) {
      m.getAttachments({ includeInlineImages: false, includeAttachments: true }).forEach(function (a) {
        const type = a.getContentType(), name = a.getName();
        const good = /^(application\/pdf|image\/(jpeg|png|webp))$/.test(type) || /\.(pdf|jpe?g|png|webp)$/i.test(name);
        if (!good || a.getSize() < MIN_BYTES) return;
        if (a.getSize() > MAX_BYTES) { fail++; return; }
        const res = UrlFetchApp.fetch(ENDPOINT, {
          method: 'post', contentType: 'application/json', muteHttpExceptions: true,
          headers: { 'x-intake-secret': secret },
          payload: JSON.stringify({ filename: name, mime: type, data: Utilities.base64Encode(a.getBytes()), from: m.getFrom(), subject: m.getSubject() })
        });
        if (res.getResponseCode() === 201) ok++; else fail++;
      });
    });
    th.addLabel(fail ? problem : sent);
  });
}

function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('processInbox').timeBased().everyMinutes(10).create();
}
