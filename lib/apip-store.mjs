/**
 * apip-store.mjs — SQLite persistence for the AP Invoice Processing (APIP) module.
 *
 * Tables (all CREATE IF NOT EXISTS in hanny.db):
 *   apip_settings          single JSON row (id = 1)
 *   apip_queue             one row per intake document (file stored at data/apip/files/<id>.pdf)
 *   apip_mail_configs      IMAP mailboxes polled for invoices (password encrypted)
 *   apip_templates         approval templates (requestors / stages / additional settings as JSON)
 *   apip_approval_actions  approve / reject actions per queue item + stage
 *   apip_mappings          learned corrections (vendor name → CardCode, line text → ItemCode / GL)
 * Logs are an in-memory ring buffer (200 entries).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, encryptDbPassword, decryptDbPassword } from '../db.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const APIP_DATA_DIR  = path.join(__dirname, '..', 'data', 'apip');
export const APIP_FILES_DIR = path.join(APIP_DATA_DIR, 'files');
try { fs.mkdirSync(APIP_FILES_DIR, { recursive: true }); } catch { /* created lazily on write */ }

db.exec(`
  CREATE TABLE IF NOT EXISTS apip_settings (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    json       TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS apip_queue (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id        TEXT DEFAULT '',
    file_name         TEXT NOT NULL,
    file_path         TEXT DEFAULT '',
    file_size         INTEGER DEFAULT 0,
    received_at       TEXT NOT NULL,
    source            TEXT NOT NULL,            -- folder | mail | upload
    source_ref        TEXT DEFAULT '',
    original_path     TEXT DEFAULT '',          -- folder intake: path of the original in the input folder
    original_moved    INTEGER DEFAULT 0,
    uploaded_by       TEXT DEFAULT '',
    processing_status TEXT NOT NULL DEFAULT 'pending',
    approval_status   TEXT NOT NULL DEFAULT 'DRAFT',
    error             TEXT DEFAULT '',
    vendor_name       TEXT DEFAULT '',
    card_code         TEXT DEFAULT '',
    invoice_no        TEXT DEFAULT '',
    total             REAL,
    currency          TEXT DEFAULT '',
    sap_doc_entry     INTEGER,
    sap_doc_num       INTEGER,
    sap_is_draft      INTEGER DEFAULT 0,
    extracted_json    TEXT,
    mapped_json       TEXT,
    approval_json     TEXT,                     -- snapshot of the template stages at send time + current stage
    template_id       INTEGER,
    sent_at           TEXT,
    sent_by           TEXT DEFAULT '',
    processed_at      TEXT,
    posted_at         TEXT,
    updated_at        TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_apip_queue_status ON apip_queue(processing_status);
  CREATE INDEX IF NOT EXISTS idx_apip_queue_orig   ON apip_queue(original_path);
  CREATE TABLE IF NOT EXISTS apip_mail_configs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT NOT NULL,
    imap_host      TEXT NOT NULL,
    imap_port      INTEGER DEFAULT 993,
    imap_tls       INTEGER DEFAULT 1,
    user           TEXT NOT NULL,
    password       TEXT DEFAULT '',
    folder         TEXT DEFAULT 'INBOX',
    subject_filter TEXT DEFAULT '',
    poll_sec       INTEGER DEFAULT 120,
    enabled        INTEGER DEFAULT 1,
    last_check     TEXT,
    last_error     TEXT DEFAULT '',
    created_at     TEXT
  );
  CREATE TABLE IF NOT EXISTS apip_templates (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    name                TEXT NOT NULL,
    description         TEXT DEFAULT '',
    requestors_json     TEXT DEFAULT '[]',
    stages_json         TEXT DEFAULT '[]',
    additional_json     TEXT DEFAULT '{}',
    created_at          TEXT,
    updated_at          TEXT
  );
  CREATE TABLE IF NOT EXISTS apip_approval_actions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    queue_id   INTEGER NOT NULL,
    stage_no   INTEGER NOT NULL,
    user_id    TEXT DEFAULT '',
    user_name  TEXT DEFAULT '',
    action     TEXT NOT NULL,                   -- approve | reject
    comment    TEXT DEFAULT '',
    at         TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_apip_actions_q ON apip_approval_actions(queue_id);
  CREATE TABLE IF NOT EXISTS apip_mappings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id  TEXT DEFAULT '',
    kind        TEXT NOT NULL,                  -- vendor | item | gl
    source_key  TEXT NOT NULL,
    target      TEXT NOT NULL,
    target_name TEXT DEFAULT '',
    hits        INTEGER DEFAULT 1,
    updated_at  TEXT,
    UNIQUE (company_id, kind, source_key)
  );
`);

const now = () => new Date().toISOString();
const parse = (s, dflt) => { if (s == null || s === '') return dflt; try { return JSON.parse(s); } catch { return dflt; } };
const str = v => (v == null ? '' : String(v));

// ── Logs (ring buffer) ────────────────────────────────────────────────────────
const _logs = [];
export function apipLog(level, msg) {
  const entry = { ts: now(), level: String(level || 'INFO').toUpperCase(), msg: String(msg) };
  _logs.push(entry);
  if (_logs.length > 200) _logs.shift();
  const fn = entry.level === 'ERROR' ? console.error : entry.level === 'WARN' ? console.warn : console.log;
  fn(`[APIP][${entry.level}] ${entry.msg}`);
}
export function getLogs() { return [..._logs].reverse(); }

// ── Settings ──────────────────────────────────────────────────────────────────
export const DEFAULT_SETTINGS = Object.freeze({
  inputFolder: '', processedFolder: '', failedFolder: '',
  folderWatchEnabled: false, folderPollSec: 30,
  mailEnabled: false,
  autoProcess: true, autoSendApproval: false,
  approvalRequired: true, postWithoutApproval: false, autoPostOnApproval: false, postAsDraft: false,
  defaultSeries: '', defaultTaxCode: '', defaultWarehouse: '', defaultGlAccount: '', defaultDocType: 'dDocument_Items',
  priceTolerancePct: 5, totalTolerance: 1, duplicateCheck: true,
  ocrEngine: 'ai',
  extraFields: [],
});

const BOOL_KEYS = ['folderWatchEnabled', 'mailEnabled', 'autoProcess', 'autoSendApproval', 'approvalRequired',
  'postWithoutApproval', 'autoPostOnApproval', 'postAsDraft', 'duplicateCheck'];
const NUM_KEYS = ['folderPollSec', 'priceTolerancePct', 'totalTolerance'];
const STR_KEYS = ['inputFolder', 'processedFolder', 'failedFolder', 'defaultSeries', 'defaultTaxCode',
  'defaultWarehouse', 'defaultGlAccount', 'defaultDocType', 'ocrEngine'];

export function normalizeSettings(input = {}) {
  const out = { ...DEFAULT_SETTINGS };
  for (const k of BOOL_KEYS) if (k in input) out[k] = input[k] === true || input[k] === 'true' || input[k] === 1 || input[k] === '1';
  for (const k of NUM_KEYS) if (k in input && input[k] !== '' && input[k] != null && Number.isFinite(Number(input[k]))) out[k] = Number(input[k]);
  for (const k of STR_KEYS) if (k in input && input[k] != null) out[k] = String(input[k]).trim();
  if (!['dDocument_Items', 'dDocument_Service'].includes(out.defaultDocType)) out.defaultDocType = 'dDocument_Items';
  if (!['ai', 'text'].includes(out.ocrEngine)) out.ocrEngine = 'ai';
  out.folderPollSec = Math.max(5, Math.min(3600, Math.round(out.folderPollSec || 30)));
  out.extraFields = Array.isArray(input.extraFields) ? input.extraFields
    .filter(f => f && (f.key || f.sapField))
    .map(f => ({
      key: String(f.key || f.sapField).trim(),
      label: String(f.label || f.key || f.sapField || '').trim(),
      type: ['text', 'number', 'date', 'select'].includes(f.type) ? f.type : 'text',
      ...(Array.isArray(f.options) ? { options: f.options.map(String) } : {}),
      sapField: String(f.sapField || '').trim(),
      required: !!f.required,
    })) : [];
  return out;
}

export const settingsRepo = {
  get() {
    const row = db.prepare(`SELECT json FROM apip_settings WHERE id = 1`).get();
    return normalizeSettings(parse(row?.json, {}));
  },
  save(settings) {
    const s = normalizeSettings(settings);
    db.prepare(`INSERT INTO apip_settings (id, json, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`).run(JSON.stringify(s), now());
    return s;
  },
};

// ── Queue ─────────────────────────────────────────────────────────────────────
export function filePathFor(id) { return path.join(APIP_FILES_DIR, `${id}.pdf`); }

// Public shape (spec queueRow) of a DB row.
export function toQueueRow(r) {
  if (!r) return null;
  return {
    id: r.id, fileName: r.file_name, receivedAt: r.received_at, source: r.source, sourceRef: r.source_ref || '',
    processingStatus: r.processing_status, approvalStatus: r.approval_status, error: r.error || '',
    vendorName: r.vendor_name || '', cardCode: r.card_code || '', invoiceNo: r.invoice_no || '',
    total: r.total == null ? null : Number(r.total), currency: r.currency || '',
    sapDocEntry: r.sap_doc_entry ?? null, sapDocNum: r.sap_doc_num ?? null,
    // additions (not in the spec, harmless for the UI)
    isDraft: !!r.sap_is_draft, sentAt: r.sent_at || null, postedAt: r.posted_at || null, processedAt: r.processed_at || null,
  };
}

const QUEUE_COLS = ['company_id', 'file_name', 'file_path', 'file_size', 'source', 'source_ref', 'original_path', 'original_moved',
  'uploaded_by', 'processing_status', 'approval_status', 'error', 'vendor_name', 'card_code', 'invoice_no', 'total', 'currency',
  'sap_doc_entry', 'sap_doc_num', 'sap_is_draft', 'extracted_json', 'mapped_json', 'approval_json', 'template_id', 'sent_at',
  'sent_by', 'processed_at', 'posted_at'];
const JSON_COLS = new Set(['extracted_json', 'mapped_json', 'approval_json']);

export const queueRepo = {
  get(id) { return db.prepare(`SELECT * FROM apip_queue WHERE id = ?`).get(Number(id)) || null; },
  getFull(id) {
    const r = this.get(id);
    if (!r) return null;
    return { ...r, extracted: parse(r.extracted_json, null), mapped: parse(r.mapped_json, null), approval: parse(r.approval_json, null) };
  },
  /** Store the PDF and insert a pending row. Returns the raw DB row. */
  create({ buffer, fileName, source, sourceRef = '', originalPath = '', uploadedBy = '', companyId = '', approvalStatus = 'DRAFT' }) {
    const info = db.prepare(`INSERT INTO apip_queue
      (company_id, file_name, received_at, source, source_ref, original_path, uploaded_by, processing_status, approval_status, file_size, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
      .run(str(companyId), str(fileName) || 'invoice.pdf', now(), source, str(sourceRef).slice(0, 500), str(originalPath),
        str(uploadedBy), approvalStatus, buffer?.length || 0, now());
    const id = Number(info.lastInsertRowid);
    const fp = filePathFor(id);
    try {
      fs.mkdirSync(APIP_FILES_DIR, { recursive: true });
      fs.writeFileSync(fp, buffer);
    } catch (e) {
      db.prepare(`DELETE FROM apip_queue WHERE id = ?`).run(id);
      throw new Error(`Could not store file: ${e.message}`);
    }
    db.prepare(`UPDATE apip_queue SET file_path = ? WHERE id = ?`).run(fp, id);
    return this.get(id);
  },
  update(id, fields) {
    const sets = [], args = [];
    for (const [k, v] of Object.entries(fields || {})) {
      if (!QUEUE_COLS.includes(k)) continue;
      sets.push(`${k} = ?`);
      args.push(JSON_COLS.has(k) ? (v == null ? null : JSON.stringify(v)) : (typeof v === 'boolean' ? (v ? 1 : 0) : v));
    }
    if (!sets.length) return this.get(id);
    sets.push('updated_at = ?'); args.push(now());
    db.prepare(`UPDATE apip_queue SET ${sets.join(', ')} WHERE id = ?`).run(...args, Number(id));
    return this.get(id);
  },
  delete(id) {
    const r = this.get(id);
    db.prepare(`DELETE FROM apip_approval_actions WHERE queue_id = ?`).run(Number(id));
    db.prepare(`DELETE FROM apip_queue WHERE id = ?`).run(Number(id));
    try { if (r?.file_path && fs.existsSync(r.file_path)) fs.unlinkSync(r.file_path); } catch { /* ignore */ }
    return r;
  },
  readFile(id) {
    const r = this.get(id);
    const fp = r?.file_path || filePathFor(id);
    return fs.existsSync(fp) ? fs.readFileSync(fp) : null;
  },
  list({ status = '', search = '', tab = '', limit = 1000 } = {}) {
    const where = [], args = [];
    if (tab === 'sent') where.push(`sent_at IS NOT NULL`);
    else if (tab === 'queue') where.push(`sent_at IS NULL`);
    if (status && status !== 'all') {
      where.push(`(processing_status = ? OR approval_status = ?)`);
      args.push(status, String(status).toUpperCase());
    }
    if (search) {
      const like = `%${search}%`;
      where.push(`(file_name LIKE ? OR vendor_name LIKE ? OR card_code LIKE ? OR invoice_no LIKE ? OR source_ref LIKE ? OR CAST(sap_doc_num AS TEXT) LIKE ?)`);
      args.push(like, like, like, like, like, like);
    }
    const sql = `SELECT * FROM apip_queue ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
    return db.prepare(sql).all(...args, Number(limit) || 1000);
  },
  idsByStatus(statuses) {
    const ph = statuses.map(() => '?').join(',');
    return db.prepare(`SELECT id FROM apip_queue WHERE processing_status IN (${ph}) ORDER BY id`).all(...statuses).map(r => r.id);
  },
  /** Folder intake: is this original already queued and not yet moved out of the input folder? */
  hasPendingOriginal(originalPath) {
    return !!db.prepare(`SELECT 1 FROM apip_queue WHERE original_path = ? AND original_moved = 0 LIMIT 1`).get(str(originalPath));
  },
  /** Same vendor + invoice number already posted (other than `exceptId`). */
  findPostedDuplicate(cardCode, invoiceNo, exceptId) {
    if (!cardCode || !invoiceNo) return null;
    return db.prepare(`SELECT * FROM apip_queue WHERE processing_status = 'posted' AND card_code = ? AND lower(trim(invoice_no)) = lower(trim(?)) AND id <> ? LIMIT 1`)
      .get(cardCode, invoiceNo, Number(exceptId) || 0) || null;
  },
  counts() {
    const out = { total: 0, pending: 0, processing: 0, processed: 0, failed: 0, duplicate: 0, posted: 0 };
    for (const r of db.prepare(`SELECT processing_status s, COUNT(*) n FROM apip_queue GROUP BY processing_status`).all()) {
      out.total += r.n;
      if (r.s in out) out[r.s] = r.n;
    }
    return out;
  },
  approvalCounts() {
    const out = { pending: 0, partial: 0, approved: 0, rejected: 0 };
    for (const r of db.prepare(`SELECT approval_status s, COUNT(*) n FROM apip_queue GROUP BY approval_status`).all()) {
      const k = String(r.s || '').toLowerCase();
      if (k in out) out[k] = r.n;
    }
    return out;
  },
  bySource() {
    const out = { folder: 0, mail: 0, upload: 0 };
    for (const r of db.prepare(`SELECT source s, COUNT(*) n FROM apip_queue GROUP BY source`).all()) if (r.s in out) out[r.s] = r.n;
    return out;
  },
  daily(days = 14) {
    const out = [];
    const base = new Date(); base.setUTCHours(0, 0, 0, 0);
    const from = new Date(base.getTime() - (days - 1) * 86400000).toISOString().slice(0, 10);
    const q = (col, extra = '') => Object.fromEntries(db.prepare(
      `SELECT substr(${col}, 1, 10) d, COUNT(*) n FROM apip_queue WHERE ${col} IS NOT NULL AND substr(${col}, 1, 10) >= ? ${extra} GROUP BY d`).all(from).map(r => [r.d, r.n]));
    const rec = q('received_at'), post = q('posted_at'), fail = q('updated_at', `AND processing_status = 'failed'`);
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(base.getTime() - i * 86400000).toISOString().slice(0, 10);
      out.push({ date: d, received: rec[d] || 0, posted: post[d] || 0, failed: fail[d] || 0 });
    }
    return out;
  },
  sentRows() {
    return db.prepare(`SELECT * FROM apip_queue WHERE sent_at IS NOT NULL ORDER BY sent_at DESC`).all()
      .map(r => ({ ...r, approval: parse(r.approval_json, null) }));
  },
};

// ── Approval actions ──────────────────────────────────────────────────────────
export const actionRepo = {
  add({ queueId, stageNo, userId, userName, action, comment }) {
    db.prepare(`INSERT INTO apip_approval_actions (queue_id, stage_no, user_id, user_name, action, comment, at) VALUES (?,?,?,?,?,?,?)`)
      .run(Number(queueId), Number(stageNo), str(userId), str(userName), action, str(comment).slice(0, 1000), now());
  },
  list(queueId) {
    return db.prepare(`SELECT * FROM apip_approval_actions WHERE queue_id = ? ORDER BY id`).all(Number(queueId));
  },
  clear(queueId) { db.prepare(`DELETE FROM apip_approval_actions WHERE queue_id = ?`).run(Number(queueId)); },
};

// ── Mail configs ──────────────────────────────────────────────────────────────
function mailOut(r) {
  if (!r) return null;
  return {
    id: r.id, name: r.name, imapHost: r.imap_host, imapPort: r.imap_port, imapTls: !!r.imap_tls, user: r.user,
    folder: r.folder || 'INBOX', subjectFilter: r.subject_filter || '', pollSec: r.poll_sec, enabled: !!r.enabled,
    lastCheck: r.last_check || null, lastError: r.last_error || '', hasPassword: !!r.password,
  };
}
const boolIn = v => (v === true || v === 'true' || v === 1 || v === '1') ? 1 : 0;

export const mailRepo = {
  list() { return db.prepare(`SELECT * FROM apip_mail_configs ORDER BY id`).all().map(mailOut); },
  get(id) { return mailOut(db.prepare(`SELECT * FROM apip_mail_configs WHERE id = ?`).get(Number(id))); },
  /** Internal: includes the decrypted password — never send to the client. */
  getWithSecret(id) {
    const r = db.prepare(`SELECT * FROM apip_mail_configs WHERE id = ?`).get(Number(id));
    if (!r) return null;
    return { ...mailOut(r), password: r.password ? decryptDbPassword(r.password) : '' };
  },
  listEnabledWithSecret() {
    return db.prepare(`SELECT id FROM apip_mail_configs WHERE enabled = 1 ORDER BY id`).all().map(r => this.getWithSecret(r.id));
  },
  create(b) {
    const info = db.prepare(`INSERT INTO apip_mail_configs
      (name, imap_host, imap_port, imap_tls, user, password, folder, subject_filter, poll_sec, enabled, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      str(b.name).trim() || str(b.user), str(b.imapHost).trim(), Number(b.imapPort) || 993, 'imapTls' in b ? boolIn(b.imapTls) : 1,
      str(b.user).trim(), b.password ? encryptDbPassword(String(b.password)) : '', str(b.folder).trim() || 'INBOX',
      str(b.subjectFilter), Math.max(30, Number(b.pollSec) || 120), 'enabled' in b ? boolIn(b.enabled) : 1, now());
    return this.get(info.lastInsertRowid);
  },
  update(id, b) {
    const cur = db.prepare(`SELECT * FROM apip_mail_configs WHERE id = ?`).get(Number(id));
    if (!cur) return null;
    const pick = (k, col, fn = v => v) => (k in b && b[k] !== undefined ? fn(b[k]) : cur[col]);
    db.prepare(`UPDATE apip_mail_configs SET name=?, imap_host=?, imap_port=?, imap_tls=?, user=?, password=?, folder=?,
      subject_filter=?, poll_sec=?, enabled=? WHERE id=?`).run(
      pick('name', 'name', v => str(v).trim()), pick('imapHost', 'imap_host', v => str(v).trim()),
      pick('imapPort', 'imap_port', v => Number(v) || 993), pick('imapTls', 'imap_tls', boolIn),
      pick('user', 'user', v => str(v).trim()),
      b.password ? encryptDbPassword(String(b.password)) : cur.password,
      pick('folder', 'folder', v => str(v).trim() || 'INBOX'), pick('subjectFilter', 'subject_filter', str),
      pick('pollSec', 'poll_sec', v => Math.max(30, Number(v) || 120)), pick('enabled', 'enabled', boolIn), Number(id));
    return this.get(id);
  },
  setStatus(id, { lastCheck, lastError }) {
    db.prepare(`UPDATE apip_mail_configs SET last_check = ?, last_error = ? WHERE id = ?`).run(lastCheck || now(), str(lastError).slice(0, 500), Number(id));
  },
  delete(id) { return db.prepare(`DELETE FROM apip_mail_configs WHERE id = ?`).run(Number(id)).changes; },
};

// ── Approval templates ────────────────────────────────────────────────────────
const principal = p => ({ type: p?.type === 'role' ? 'role' : 'user', id: p?.id ?? '', name: str(p?.name) });

export function normalizeTemplate(b = {}) {
  const add = b.additionalSettings || {};
  return {
    name: str(b.name).trim(),
    description: str(b.description),
    requestors: (Array.isArray(b.requestors) ? b.requestors : []).filter(p => p && p.id !== '' && p.id != null).map(principal),
    additionalSettings: {
      enabled: !!add.enabled,
      deviationPct: Number(add.deviationPct) || 0,
      vendorCodes: (Array.isArray(add.vendorCodes) ? add.vendorCodes : String(add.vendorCodes || '').split(/[,\s]+/))
        .map(s => String(s).trim()).filter(Boolean),
    },
    stages: (Array.isArray(b.stages) ? b.stages : []).map((s, i) => ({
      name: str(s?.name).trim() || `Stage ${i + 1}`,
      description: str(s?.description),
      approvalsRequired: Math.max(1, Number(s?.approvalsRequired) || 1),
      rejectorsRequired: Math.max(1, Number(s?.rejectorsRequired) || 1),
      maxInvoiceTotal: s?.maxInvoiceTotal === '' || s?.maxInvoiceTotal == null ? null : (Number(s.maxInvoiceTotal) || null),
      approvers: (Array.isArray(s?.approvers) ? s.approvers : []).filter(p => p && p.id !== '' && p.id != null).map(principal),
    })),
  };
}

function templateOut(r) {
  if (!r) return null;
  return {
    id: r.id, name: r.name, description: r.description || '',
    requestors: parse(r.requestors_json, []),
    additionalSettings: parse(r.additional_json, { enabled: false, deviationPct: 0, vendorCodes: [] }),
    stages: parse(r.stages_json, []),
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export const templateRepo = {
  list(search = '') {
    const like = `%${search || ''}%`;
    return db.prepare(`SELECT * FROM apip_templates WHERE name LIKE ? OR description LIKE ? ORDER BY id`).all(like, like).map(templateOut);
  },
  get(id) { return templateOut(db.prepare(`SELECT * FROM apip_templates WHERE id = ?`).get(Number(id))); },
  create(b) {
    const t = normalizeTemplate(b);
    const info = db.prepare(`INSERT INTO apip_templates (name, description, requestors_json, stages_json, additional_json, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?)`).run(t.name, t.description, JSON.stringify(t.requestors), JSON.stringify(t.stages),
      JSON.stringify(t.additionalSettings), now(), now());
    return this.get(info.lastInsertRowid);
  },
  update(id, b) {
    const t = normalizeTemplate(b);
    const n = db.prepare(`UPDATE apip_templates SET name=?, description=?, requestors_json=?, stages_json=?, additional_json=?, updated_at=? WHERE id=?`)
      .run(t.name, t.description, JSON.stringify(t.requestors), JSON.stringify(t.stages), JSON.stringify(t.additionalSettings), now(), Number(id)).changes;
    return n ? this.get(id) : null;
  },
  delete(id) { return db.prepare(`DELETE FROM apip_templates WHERE id = ?`).run(Number(id)).changes; },
};

// ── Mapping memory ────────────────────────────────────────────────────────────
export const normText = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 200);

export const mappingRepo = {
  find(companyId, kind, sourceText) {
    const key = normText(sourceText);
    if (!key) return null;
    return db.prepare(`SELECT * FROM apip_mappings WHERE company_id = ? AND kind = ? AND source_key = ?`).get(str(companyId), kind, key) || null;
  },
  learn(companyId, kind, sourceText, target, targetName = '') {
    const key = normText(sourceText);
    if (!key || !target) return;
    db.prepare(`INSERT INTO apip_mappings (company_id, kind, source_key, target, target_name, hits, updated_at) VALUES (?,?,?,?,?,1,?)
      ON CONFLICT(company_id, kind, source_key) DO UPDATE SET target = excluded.target, target_name = excluded.target_name,
      hits = apip_mappings.hits + 1, updated_at = excluded.updated_at`).run(str(companyId), kind, key, String(target), str(targetName), now());
  },
  list(companyId) { return db.prepare(`SELECT * FROM apip_mappings WHERE company_id = ? ORDER BY updated_at DESC`).all(str(companyId)); },
};

// ── Principals (users / roles from db.mjs tables) ─────────────────────────────
export function listPrincipals() {
  let users = [], roles = [];
  try { users = db.prepare(`SELECT id, username, full_name, role FROM users ORDER BY username`).all().map(u => ({ id: u.id, name: u.full_name || u.username, username: u.username, role: u.role })); } catch { /* table missing */ }
  try { roles = db.prepare(`SELECT id, name FROM roles ORDER BY name`).all().map(r => ({ id: r.id, name: r.name })); } catch { /* table missing */ }
  return { users, roles };
}
export function roleIdByName(name) {
  try { return db.prepare(`SELECT id FROM roles WHERE name = ?`).get(String(name || ''))?.id ?? null; } catch { return null; }
}
