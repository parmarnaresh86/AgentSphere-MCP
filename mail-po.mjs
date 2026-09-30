/**
 * mail-po.mjs — Email-to-PO→SO pipeline
 * Monitors a mailbox for incoming emails with PDF attachments,
 * auto-runs the PO parse → customer → credit → ATP → create SO workflow,
 * and replies with the result.
 */
import Imap         from "imap";
import { simpleParser } from "mailparser";
import nodemailer   from "nodemailer";
import { createRequire } from "module";
const _require = createRequire(import.meta.url);
let pdfParse;
try { pdfParse = _require("pdf-parse"); } catch { pdfParse = null; }

// ── Config loaded from process.env ─────────────────────────────────────────
function getMailConfig() {
  return {
    host:     process.env.MAIL_IMAP_HOST   || "",
    port:     parseInt(process.env.MAIL_IMAP_PORT  || "993"),
    tls:      (process.env.MAIL_IMAP_TLS   || "true") !== "false",
    user:     process.env.MAIL_USER        || "",
    password: process.env.MAIL_PASS        || "",
    folder:   process.env.MAIL_FOLDER      || "INBOX",
    smtpHost: process.env.MAIL_SMTP_HOST   || process.env.MAIL_IMAP_HOST || "",
    smtpPort: parseInt(process.env.MAIL_SMTP_PORT  || "587"),
    smtpTls:  (process.env.MAIL_SMTP_TLS   || "false") !== "false",
    pollMs:   parseInt(process.env.MAIL_POLL_MS    || "60000"),
  };
}

// ── State ──────────────────────────────────────────────────────────────────
let _imap      = null;
let _pollTimer = null;
let _running   = false;
let _logs      = [];         // ring buffer — last 100 entries
let _onPdf     = null;       // callback(pdfBuffer, fromEmail, subject) → Promise<{docNum,docEntry,message}>
let _attempted = new Set();  // UIDs the poller already tried — failed ones stay unread for manual review, but aren't retried every poll

function log(level, msg) {
  const entry = { ts: new Date().toISOString(), level, msg };
  _logs.push(entry);
  if (_logs.length > 100) _logs.shift();
  console.log(`[MAIL-PO][${level}] ${msg}`);
}

// ── Public API ─────────────────────────────────────────────────────────────
export function getLogs()    { return [..._logs]; }
export function isRunning()  { return _running; }

export function setOnPdf(fn) { _onPdf = fn; }   // register the workflow callback

export async function start() {
  if (_running) return { ok: false, error: "Already running" };
  const cfg = getMailConfig();
  if (!cfg.host || !cfg.user || !cfg.password) {
    return { ok: false, error: "Mail credentials not configured (MAIL_IMAP_HOST, MAIL_USER, MAIL_PASS)" };
  }
  _running = true;
  log("INFO", `Starting monitor → ${cfg.user}@${cfg.host}:${cfg.port} folder=${cfg.folder}`);
  await _poll();                              // immediate first check
  _pollTimer = setInterval(_poll, cfg.pollMs);
  return { ok: true };
}

export function stop() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  if (_imap) { try { _imap.end(); } catch {} _imap = null; }
  _running = false;
  log("INFO", "Monitor stopped");
  return { ok: true };
}

export async function testConnection() {
  const cfg = getMailConfig();
  return new Promise((resolve) => {
    const imap = new Imap({ user: cfg.user, password: cfg.password, host: cfg.host, port: cfg.port, tls: cfg.tls, tlsOptions: { rejectUnauthorized: false } });
    imap.once("ready",  () => { imap.end(); resolve({ ok: true }); });
    imap.once("error",  (e) => resolve({ ok: false, error: e.message }));
    imap.connect();
  });
}

// ── Poll loop ───────────────────────────────────────────────────────────────
async function _poll() {
  const cfg = getMailConfig();
  try {
    const unseen = await _fetchUnseen(cfg);
    if (unseen.length === 0) { log("DEBUG", "No new purchase order emails today"); return; }
    log("INFO", `Found ${unseen.length} purchase order email(s) today with PDF`);
    for (const mail of unseen) {
      await _processMail(mail, cfg);
    }
  } catch (e) {
    log("ERROR", `Poll failed: ${e.message}`);
  }
}

// ── Fetch unseen emails with PDF attachments (does NOT mark as seen) ─────────
function _fetchUnseen(cfg) {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: cfg.user, password: cfg.password,
      host: cfg.host, port: cfg.port, tls: cfg.tls,
      tlsOptions: { rejectUnauthorized: false },
      authTimeout: 10000, connTimeout: 15000,
    });

    const mails   = [];
    const parsing = [];   // simpleParser is async — wait for all before resolving

    imap.once("ready", () => {
      imap.openBox(cfg.folder, true, (err) => {
        if (err) { imap.end(); return reject(err); }

        const today = new Date(); today.setHours(0, 0, 0, 0);
        imap.search(["UNSEEN", ["SINCE", today], ["SUBJECT", "purchase order"]], (err, uids) => {
          if (err) { imap.end(); return reject(err); }   // keep _attempted on transient errors
          if (!uids?.length) { _attempted.clear(); imap.end(); return resolve([]); }

          // Forget UIDs that are no longer unread; skip ones already attempted
          _attempted = new Set(uids.filter(u => _attempted.has(u)));
          const fresh = uids.filter(u => !_attempted.has(u));
          if (!fresh.length) { imap.end(); return resolve([]); }

          const fetch = imap.fetch(fresh, { bodies: "", markSeen: false });

          fetch.on("message", (msg, seqno) => {
            const chunks = [];
            let uid = null;
            msg.on("body", (stream) => {
              stream.on("data", (chunk) => chunks.push(chunk));
            });
            msg.once("attributes", (attrs) => { uid = attrs.uid; });
            msg.once("end", () => parsing.push((async () => {
              if (uid != null) _attempted.add(uid);   // also covers mails with no PDF — don't re-download them every poll
              try {
                const raw = Buffer.concat(chunks);
                const parsed = await simpleParser(raw);
                const pdfAttachments = (parsed.attachments || []).filter(a =>
                  a.contentType === "application/pdf" ||
                  (a.filename && a.filename.toLowerCase().endsWith(".pdf"))
                );
                if (pdfAttachments.length > 0) {
                  mails.push({
                    seqno, uid,
                    from:    parsed.from?.text || "",
                    subject: parsed.subject    || "",
                    pdfs:    pdfAttachments.map(a => ({ name: a.filename, buffer: a.content })),
                  });
                }
              } catch (e) {
                log("WARN", `Parse error seqno=${seqno}: ${e.message}`);
              }
            })()));
          });

          fetch.once("end", () => { imap.end(); });
        });
      });
    });

    imap.once("error",  reject);
    imap.once("end",    () => Promise.all(parsing).then(() => resolve(mails)));
    imap.connect();
  });
}

// ── Process one email ───────────────────────────────────────────────────────
async function _processMail(mail, cfg) {
  log("INFO", `Processing email from=${mail.from} subject="${mail.subject}" pdfs=${mail.pdfs.length}`);
  if (mail.uid != null) _attempted.add(mail.uid);
  let allPosted = mail.pdfs.length > 0;

  for (const pdf of mail.pdfs) {
    log("INFO", `  PDF: ${pdf.name} (${pdf.buffer.length} bytes)`);
    let resultMsg = "";
    let success   = false;

    try {
      if (!_onPdf) throw new Error("No workflow handler registered");
      const result = await _onPdf(pdf.buffer, pdf.name, mail.from, mail.subject);
      if (result.docNum) {
        success    = true;
        resultMsg  = `✅ Sales Order #${result.docNum} created successfully in SAP B1.\n\nCustomer: ${result.customerName || ""}\nPO Ref: ${result.poNumber || ""}\nTotal: ${result.currency || ""} ${result.total || ""}`;
        log("INFO", `  → SO created: DocNum=${result.docNum}`);
      } else {
        resultMsg = `⚠️ Could not auto-create Sales Order:\n${result.message || result.error || "Unknown error"}`;
        log("WARN", `  → Workflow issue: ${resultMsg}`);
      }
    } catch (e) {
      resultMsg = `❌ Processing error: ${e.message}`;
      log("ERROR", `  → ${e.message}`);
    }

    if (!success) allPosted = false;

    // Reply to sender
    await _sendReply(cfg, mail.from, mail.subject, pdf.name, resultMsg);
  }

  // Only mark read once every PDF in the email became a Sales Order in SAP —
  // anything else stays unread so it keeps showing in the inbox list.
  if (allPosted && mail.uid != null) {
    try { await markSeen(mail.uid); } catch (e) { log("WARN", `  → Could not mark uid=${mail.uid} as read: ${e.message}`); }
  }
}

// ── Mark a single email as read (call only after its SO is posted) ──────────
export function markSeen(uid) {
  const cfg = getMailConfig();
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: cfg.user, password: cfg.password, host: cfg.host, port: cfg.port, tls: cfg.tls,
      tlsOptions: { rejectUnauthorized: false }, authTimeout: 10000, connTimeout: 15000,
    });
    imap.once("ready", () => {
      imap.openBox(cfg.folder, false, (err) => {
        if (err) { imap.end(); return reject(err); }
        imap.addFlags([uid], "\\Seen", (err2) => {
          imap.end();
          if (err2) return reject(err2);
          log("INFO", `Marked uid=${uid} as read`);
          resolve(true);
        });
      });
    });
    imap.once("error", reject);
    imap.connect();
  });
}

// ── Public: send acknowledgment ─────────────────────────────────────────────
export async function sendAcknowledgment(to, originalSubject, body) {
  await _sendReply(getMailConfig(), to, originalSubject, "", body);
}

// ── Helpers: detect PDF in MIME struct ──────────────────────────────────────
function _hasPdfAttachment(struct) {
  if (!struct) return false;
  if (Array.isArray(struct)) return struct.some(_hasPdfAttachment);
  if (struct.type === "application" && struct.subtype === "pdf") return true;
  const fname = (struct.disposition?.params?.filename || struct.params?.name || "").toLowerCase();
  return fname.endsWith(".pdf");
}

function _getPdfNames(struct) {
  const names = [];
  function walk(s) {
    if (!s) return;
    if (Array.isArray(s)) { s.forEach(walk); return; }
    if (s.type === "application" && s.subtype === "pdf") {
      names.push(s.disposition?.params?.filename || s.params?.name || "attachment.pdf"); return;
    }
    const fname = (s.disposition?.params?.filename || s.params?.name || "").toLowerCase();
    if (fname.endsWith(".pdf")) names.push(s.disposition?.params?.filename || s.params?.name || "file.pdf");
  }
  walk(struct);
  return names;
}

// ── Fetch inbox list (readonly — does NOT mark as seen) ──────────────────────
export function fetchInbox() {
  const cfg = getMailConfig();
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: cfg.user, password: cfg.password, host: cfg.host, port: cfg.port, tls: cfg.tls,
      tlsOptions: { rejectUnauthorized: false }, authTimeout: 10000, connTimeout: 15000,
    });
    const mails = [];
    imap.once("ready", () => {
      imap.openBox(cfg.folder, true, (err) => {
        if (err) { imap.end(); return reject(err); }
        const today = new Date(); today.setHours(0, 0, 0, 0);
        imap.search(["UNSEEN", ["SINCE", today], ["SUBJECT", "purchase order"]], (err2, uids) => {
          if (err2 || !uids?.length) { imap.end(); return resolve([]); }
          const fetch = imap.fetch(uids, { bodies: "HEADER.FIELDS (FROM SUBJECT DATE)", struct: true });
          fetch.on("message", (msg, seqno) => {
            let uid = null, pdfNames = [], headers = { from: "", subject: "", date: "" };
            msg.on("body", (stream) => {
              const chunks = [];
              stream.on("data", d => chunks.push(d));
              stream.once("end", () => {
                const raw = Buffer.concat(chunks).toString("utf8");
                for (const line of raw.split(/\r?\n/)) {
                  if (/^from:/i.test(line))    headers.from    = line.slice(line.indexOf(":")+1).trim();
                  if (/^subject:/i.test(line)) headers.subject = line.slice(line.indexOf(":")+1).trim();
                  if (/^date:/i.test(line))    headers.date    = line.slice(line.indexOf(":")+1).trim();
                }
              });
            });
            msg.once("attributes", (attrs) => {
              uid = attrs.uid;
              pdfNames = _getPdfNames(attrs.struct);
            });
            msg.once("end", () => {
              const hasPdf = pdfNames.length > 0;
              mails.push({ uid, seqno, from: headers.from, subject: headers.subject, date: headers.date, hasPdf, pdfNames });
            });
          });
          fetch.once("end", () => imap.end());
        });
      });
    });
    imap.once("error", reject);
    imap.once("end", () => resolve(mails));
    imap.connect();
  });
}

// ── Fetch single email by UID (readonly — stays unread until SO is posted) ──
export function fetchEmail(uid) {
  const cfg = getMailConfig();
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: cfg.user, password: cfg.password, host: cfg.host, port: cfg.port, tls: cfg.tls,
      tlsOptions: { rejectUnauthorized: false }, authTimeout: 10000, connTimeout: 15000,
    });
    imap.once("ready", () => {
      imap.openBox(cfg.folder, true, (err) => {
        if (err) { imap.end(); return reject(err); }
        const f = imap.fetch([uid], { bodies: "", markSeen: false });
        const allChunks = [];
        f.on("message", (msg) => {
          msg.on("body", (stream) => stream.on("data", d => allChunks.push(d)));
        });
        // Parse AFTER all body data is collected — avoids async race with simpleParser
        f.once("end", () => {
          imap.end();
          simpleParser(Buffer.concat(allChunks))
            .then(parsed => {
              const pdfs = (parsed.attachments || [])
                .filter(a => a.contentType === "application/pdf" || (a.filename||"").toLowerCase().endsWith(".pdf"))
                .map(a => ({ name: a.filename || "attachment.pdf", buffer: a.content }));
              resolve({ uid, from: parsed.from?.text||"", subject: parsed.subject||"", date: parsed.date?.toISOString()||"", text: parsed.text||"", pdfs });
            })
            .catch(reject);
        });
      });
    });
    imap.once("error", reject);
    imap.connect();
  });
}

// ── Send reply email ────────────────────────────────────────────────────────
async function _sendReply(cfg, to, originalSubject, pdfName, body) {
  try {
    const transporter = nodemailer.createTransport({
      host: cfg.smtpHost, port: cfg.smtpPort,
      secure: cfg.smtpTls,
      auth: { user: cfg.user, pass: cfg.password },
      tls: { rejectUnauthorized: false },
    });
    await transporter.sendMail({
      from:    cfg.user,
      to,
      subject: `RE: ${originalSubject} — PO→SO Result`,
      text:    `Your purchase order PDF "${pdfName}" has been processed.\n\n${body}\n\n---\nAgentsphere AI — Automated PO→SO Workflow`,
    });
    log("INFO", `Reply sent to ${to}`);
  } catch (e) {
    log("WARN", `Reply failed: ${e.message}`);
  }
}
