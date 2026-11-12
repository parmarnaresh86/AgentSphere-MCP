/**
 * expense-store.mjs — SQLite persistence for Employee Expense Claims (controllers/expense-claim-agent.mjs).
 *
 * Tables (all CREATE IF NOT EXISTS in hanny.db):
 *   exp_settings          single JSON row (id = 1): payable G/L, category → expense G/L, approval behaviour
 *   exp_employee_map      AgentSphere user → SAP employee (Employee master / OHEM), set by an admin
 *   exp_claims            one expense claim per row (lines + approval state as JSON) → posted as one SAP Journal Entry
 *   exp_receipts          bills attached to a claim (file at data/expense/files/<id>.<ext>) and their OCR result
 *   exp_templates         approval templates (same shape as AP Invoice Processing templates)
 *   exp_approval_actions  approve / reject actions per claim + stage
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../db.mjs';
import { createConditionSet } from './apip-conditions.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const EXP_FILES_DIR = path.join(__dirname, '..', 'data', 'expense', 'files');
try { fs.mkdirSync(EXP_FILES_DIR, { recursive: true }); } catch { /* created lazily on write */ }

// ── Approval rule fields for expense claims (see lib/apip-conditions.mjs for kinds / operators) ──
export const EXP_FIELDS = [
  { key: 'total',      label: 'Claim total',          kind: 'number' },
  { key: 'maxLine',    label: 'Largest bill amount',  kind: 'number' },
  { key: 'billCount',  label: 'Number of bills',      kind: 'number' },
  { key: 'oldestDays', label: 'Oldest bill age (days)', kind: 'number' },
  { key: 'employee',   label: 'Employee',             kind: 'list',  source: 'employees' },
  { key: 'department', label: 'Department',           kind: 'list',  source: 'departments' },
  { key: 'currency',   label: 'Currency',             kind: 'list',  source: 'currencies' },
  { key: 'category',   label: 'Expense category',     kind: 'lines', source: 'categories' },
  { key: 'glAccount',  label: 'Expense G/L account',  kind: 'lines', source: 'glAccounts' },
];
export const EXP_COND = createConditionSet(EXP_FIELDS);

export const DEFAULT_CATEGORIES = ['Travel', 'Lodging', 'Meals', 'Fuel & Mileage', 'Local Conveyance', 'Telephone & Internet',
  'Office Supplies', 'Client Entertainment', 'Training', 'Courier & Postage', 'Medical', 'Other'];

db.exec(`
  CREATE TABLE IF NOT EXISTS exp_settings (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    json       TEXT NOT NULL,
    updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS exp_employee_map (
    company_id   TEXT NOT NULL,
    user_id      TEXT NOT NULL,
    emp_id       INTEGER NOT NULL,
    emp_name     TEXT DEFAULT '',
    department   TEXT DEFAULT '',
    manager_id   INTEGER,
    manager_name TEXT DEFAULT '',
    updated_at   TEXT,
    PRIMARY KEY (company_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS exp_claims (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id      TEXT NOT NULL,
    user_id         TEXT NOT NULL,
    user_name       TEXT DEFAULT '',
    emp_id          INTEGER,
    emp_name        TEXT DEFAULT '',
    department      TEXT DEFAULT '',
    manager_id      INTEGER,
    title           TEXT DEFAULT '',
    purpose         TEXT DEFAULT '',
    currency        TEXT DEFAULT '',
    lines_json      TEXT DEFAULT '[]',
    total           REAL DEFAULT 0,
    status          TEXT DEFAULT 'draft',      -- draft | submitted | approved | rejected | posted
    approval_status TEXT DEFAULT 'DRAFT',      -- DRAFT | PENDING | PARTIAL | APPROVED | REJECTED | NOT_REQUIRED
    approval_json   TEXT,
    template_id     INTEGER,
    submitted_at    TEXT,
    posted_at       TEXT,
    posted_by       TEXT DEFAULT '',
    posting_date    TEXT DEFAULT '',
    sap_trans_id    INTEGER,
    sap_number      INTEGER,
    error           TEXT DEFAULT '',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_exp_claims_user ON exp_claims(company_id, user_id);
  CREATE TABLE IF NOT EXISTS exp_receipts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    claim_id       INTEGER NOT NULL,
    file_name      TEXT DEFAULT '',
    mime           TEXT DEFAULT '',
    ext            TEXT DEFAULT '',
    size           INTEGER DEFAULT 0,
    ocr_status     TEXT DEFAULT 'pending',     -- pending | processing | done | failed
    extracted_json TEXT,
    error          TEXT DEFAULT '',
    created_at     TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_exp_receipts_claim ON exp_receipts(claim_id);
  CREATE TABLE IF NOT EXISTS exp_templates (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    description     TEXT DEFAULT '',
    requestors_json TEXT DEFAULT '[]',
    stages_json     TEXT DEFAULT '[]',
    conditions_json TEXT DEFAULT '{}',
    priority        INTEGER DEFAULT 100,
    created_at      TEXT,
    updated_at      TEXT
  );
  CREATE TABLE IF NOT EXISTS exp_approval_actions (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    claim_id  INTEGER NOT NULL,
    stage_no  INTEGER NOT NULL,
    user_id   TEXT DEFAULT '',
    user_name TEXT DEFAULT '',
    action    TEXT NOT NULL,                   -- approve | reject
    comment   TEXT DEFAULT '',
    at        TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_exp_actions_claim ON exp_approval_actions(claim_id);
`);

const now = () => new Date().toISOString();
const parse = (s, d) => { if (s == null || s === '') return d; try { return JSON.parse(s); } catch { return d; } };
const str = v => (v == null ? '' : String(v));

// ── Settings ─────────────────────────────────────────────────────────────────
export const DEFAULT_SETTINGS = Object.freeze({
  payableAccount: '',            // credited with the claim total (Employee Reimbursement Payable)
  defaultExpenseAccount: '',     // used when a category has no G/L of its own
  categories: DEFAULT_CATEGORIES.map(name => ({ name, account: '' })),
  approvalRequired: true,        // false → claims can be posted without approval
  autoPostOnApproval: false,     // post the JV as soon as the last stage approves
  memoPrefix: 'Expense claim',   // JE memo: "<prefix> #12 – <employee>"
  maxBillAgeDays: 90,            // warn when a bill is older than this (0 = off)
  ocrEngine: 'ai',
});

export function normalizeSettings(b = {}) {
  const d = DEFAULT_SETTINGS;
  const cats = (Array.isArray(b.categories) ? b.categories : d.categories)
    .map(c => ({ name: str(c?.name).trim().slice(0, 60), account: str(c?.account).trim() }))
    .filter(c => c.name);
  return {
    payableAccount: str(b.payableAccount ?? d.payableAccount).trim(),
    defaultExpenseAccount: str(b.defaultExpenseAccount ?? d.defaultExpenseAccount).trim(),
    categories: cats.length ? cats : d.categories,
    approvalRequired: b.approvalRequired === undefined ? d.approvalRequired : !!b.approvalRequired,
    autoPostOnApproval: !!b.autoPostOnApproval,
    memoPrefix: str(b.memoPrefix ?? d.memoPrefix).trim().slice(0, 30) || d.memoPrefix,
    maxBillAgeDays: Math.max(0, Math.round(Number(b.maxBillAgeDays ?? d.maxBillAgeDays) || 0)),
    ocrEngine: b.ocrEngine === 'text' ? 'text' : 'ai',
  };
}

export const settingsRepo = {
  get() {
    const r = db.prepare(`SELECT json FROM exp_settings WHERE id = 1`).get();
    return normalizeSettings({ ...DEFAULT_SETTINGS, ...parse(r?.json, {}) });
  },
  save(s) {
    const n = normalizeSettings(s);
    db.prepare(`INSERT INTO exp_settings (id, json, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`).run(JSON.stringify(n), now());
    return n;
  },
};

// ── User → SAP employee ──────────────────────────────────────────────────────
const mapOut = r => r && ({
  userId: r.user_id, empId: r.emp_id, empName: r.emp_name || '', department: r.department || '',
  managerId: r.manager_id ?? null, managerName: r.manager_name || '', updatedAt: r.updated_at,
});
export const employeeMapRepo = {
  list(cid) { return db.prepare(`SELECT * FROM exp_employee_map WHERE company_id = ? ORDER BY emp_name`).all(cid).map(mapOut); },
  get(cid, userId) { return mapOut(db.prepare(`SELECT * FROM exp_employee_map WHERE company_id = ? AND user_id = ?`).get(cid, String(userId))); },
  /** App users mapped to this SAP employee (used to resolve "reporting manager" approvers). */
  usersForEmp(cid, empId) {
    if (empId == null) return [];
    return db.prepare(`SELECT user_id FROM exp_employee_map WHERE company_id = ? AND emp_id = ?`).all(cid, Number(empId)).map(r => r.user_id);
  },
  set(cid, userId, e) {
    db.prepare(`INSERT INTO exp_employee_map (company_id, user_id, emp_id, emp_name, department, manager_id, manager_name, updated_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(company_id, user_id) DO UPDATE SET emp_id = excluded.emp_id, emp_name = excluded.emp_name,
      department = excluded.department, manager_id = excluded.manager_id, manager_name = excluded.manager_name, updated_at = excluded.updated_at`)
      .run(cid, String(userId), Number(e.empId), str(e.empName), str(e.department), e.managerId == null || e.managerId === '' ? null : Number(e.managerId), str(e.managerName), now());
    return this.get(cid, userId);
  },
  delete(cid, userId) { return db.prepare(`DELETE FROM exp_employee_map WHERE company_id = ? AND user_id = ?`).run(cid, String(userId)).changes; },
};

// ── Claims ───────────────────────────────────────────────────────────────────
function claimOut(r) {
  if (!r) return null;
  return {
    id: r.id, companyId: r.company_id, userId: r.user_id, userName: r.user_name || '',
    empId: r.emp_id ?? null, empName: r.emp_name || '', department: r.department || '', managerId: r.manager_id ?? null,
    title: r.title || '', purpose: r.purpose || '', currency: r.currency || '',
    lines: parse(r.lines_json, []), total: Number(r.total) || 0,
    status: r.status, approvalStatus: r.approval_status, approval: parse(r.approval_json, null), templateId: r.template_id ?? null,
    submittedAt: r.submitted_at, postedAt: r.posted_at, postedBy: r.posted_by || '', postingDate: r.posting_date || '',
    sapTransId: r.sap_trans_id ?? null, sapNumber: r.sap_number ?? null, error: r.error || '',
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
const CLAIM_COLS = {
  title: 'title', purpose: 'purpose', currency: 'currency', lines: 'lines_json', total: 'total', status: 'status',
  approvalStatus: 'approval_status', approval: 'approval_json', templateId: 'template_id', submittedAt: 'submitted_at',
  postedAt: 'posted_at', postedBy: 'posted_by', postingDate: 'posting_date', sapTransId: 'sap_trans_id', sapNumber: 'sap_number',
  error: 'error', empId: 'emp_id', empName: 'emp_name', department: 'department', managerId: 'manager_id',
};
export const claimRepo = {
  get(id) { return claimOut(db.prepare(`SELECT * FROM exp_claims WHERE id = ?`).get(Number(id))); },
  create({ companyId, userId, userName, emp, title = '', purpose = '', currency = '' }) {
    const t = now();
    const info = db.prepare(`INSERT INTO exp_claims (company_id, user_id, user_name, emp_id, emp_name, department, manager_id, title, purpose, currency, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(companyId, String(userId), str(userName), emp?.empId ?? null, str(emp?.empName), str(emp?.department),
      emp?.managerId ?? null, str(title), str(purpose), str(currency), t, t);
    return this.get(info.lastInsertRowid);
  },
  update(id, fields) {
    const sets = [], vals = [];
    for (const [k, v] of Object.entries(fields)) {
      const col = CLAIM_COLS[k];
      if (!col) continue;
      sets.push(`${col} = ?`);
      vals.push(col.endsWith('_json') ? (v == null ? null : JSON.stringify(v)) : (v === undefined ? null : v));
    }
    if (!sets.length) return this.get(id);
    db.prepare(`UPDATE exp_claims SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...vals, now(), Number(id));
    return this.get(id);
  },
  delete(id) {
    db.prepare(`DELETE FROM exp_approval_actions WHERE claim_id = ?`).run(Number(id));
    return db.prepare(`DELETE FROM exp_claims WHERE id = ?`).run(Number(id)).changes;
  },
  /** userId = only that user's claims; status filter optional */
  list(cid, { userId = null, status = '', search = '', limit = 500 } = {}) {
    const where = ['company_id = ?'], vals = [cid];
    if (userId != null) { where.push('user_id = ?'); vals.push(String(userId)); }
    if (status) { where.push('status = ?'); vals.push(status); }
    if (search) { where.push(`(title LIKE ? OR emp_name LIKE ? OR user_name LIKE ? OR CAST(id AS TEXT) = ?)`); vals.push(`%${search}%`, `%${search}%`, `%${search}%`, String(search).replace(/^#/, '')); }
    return db.prepare(`SELECT * FROM exp_claims WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...vals, limit).map(claimOut);
  },
  pendingApproval(cid) {
    return db.prepare(`SELECT * FROM exp_claims WHERE company_id = ? AND approval_status IN ('PENDING','PARTIAL') ORDER BY submitted_at`).all(cid).map(claimOut);
  },
};

// ── Receipts (bills) ─────────────────────────────────────────────────────────
const receiptOut = r => r && ({
  id: r.id, claimId: r.claim_id, fileName: r.file_name || '', mime: r.mime || '', size: r.size || 0,
  ocrStatus: r.ocr_status, extracted: parse(r.extracted_json, null), error: r.error || '', createdAt: r.created_at,
});
export const receiptPath = (id, ext) => path.join(EXP_FILES_DIR, `${Number(id)}.${String(ext || 'pdf').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'pdf'}`);
export const receiptRepo = {
  get(id) { return receiptOut(db.prepare(`SELECT * FROM exp_receipts WHERE id = ?`).get(Number(id))); },
  raw(id) { return db.prepare(`SELECT * FROM exp_receipts WHERE id = ?`).get(Number(id)); },
  list(claimId) { return db.prepare(`SELECT * FROM exp_receipts WHERE claim_id = ? ORDER BY id`).all(Number(claimId)).map(receiptOut); },
  create(claimId, { buffer, fileName, mime, ext }) {
    const info = db.prepare(`INSERT INTO exp_receipts (claim_id, file_name, mime, ext, size, created_at) VALUES (?,?,?,?,?,?)`)
      .run(Number(claimId), str(fileName).slice(0, 200), str(mime), str(ext), buffer.length, now());
    fs.writeFileSync(receiptPath(info.lastInsertRowid, ext), buffer);
    return this.get(info.lastInsertRowid);
  },
  update(id, { ocrStatus, extracted, error }) {
    db.prepare(`UPDATE exp_receipts SET ocr_status = COALESCE(?, ocr_status), extracted_json = COALESCE(?, extracted_json), error = COALESCE(?, error) WHERE id = ?`)
      .run(ocrStatus ?? null, extracted === undefined ? null : JSON.stringify(extracted), error ?? null, Number(id));
    return this.get(id);
  },
  readFile(id) {
    const r = this.raw(id);
    if (!r) return null;
    const p = receiptPath(r.id, r.ext);
    return fs.existsSync(p) ? { buffer: fs.readFileSync(p), mime: r.mime || 'application/octet-stream', fileName: r.file_name } : null;
  },
  delete(id) {
    const r = this.raw(id);
    if (!r) return 0;
    try { fs.unlinkSync(receiptPath(r.id, r.ext)); } catch { /* already gone */ }
    return db.prepare(`DELETE FROM exp_receipts WHERE id = ?`).run(Number(id)).changes;
  },
  deleteForClaim(claimId) { for (const r of this.list(claimId)) this.delete(r.id); },
};

// ── Approval templates & actions ─────────────────────────────────────────────
// Approver / requestor principal: { type: 'user' | 'role' | 'manager', id, name }.
// 'manager' = the claimant's reporting manager in the SAP Employee master (resolved through exp_employee_map).
const principal = p => ({ type: ['role', 'manager'].includes(p.type) ? p.type : 'user', id: p.type === 'manager' ? 'manager' : p.id, name: str(p.name) });

export function normalizeTemplate(b = {}) {
  return {
    name: str(b.name).trim(),
    description: str(b.description),
    requestors: (Array.isArray(b.requestors) ? b.requestors : []).filter(p => p && p.id !== '' && p.id != null && p.type !== 'manager').map(principal),
    conditions: EXP_COND.normalizeConditions(b.conditions),
    priority: Number.isFinite(Number(b.priority)) && b.priority !== '' && b.priority != null ? Math.max(1, Math.min(999, Math.round(Number(b.priority)))) : 100,
    stages: (Array.isArray(b.stages) ? b.stages : []).map((s, i) => ({
      name: str(s?.name).trim() || `Stage ${i + 1}`,
      description: str(s?.description),
      conditions: EXP_COND.normalizeConditions(s?.conditions),
      approvalsRequired: Math.max(1, Number(s?.approvalsRequired) || 1),
      rejectorsRequired: Math.max(1, Number(s?.rejectorsRequired) || 1),
      approvers: (Array.isArray(s?.approvers) ? s.approvers : []).filter(p => p && p.id !== '' && p.id != null).map(principal),
    })),
  };
}
const templateOut = r => r && ({
  id: r.id, name: r.name, description: r.description || '', requestors: parse(r.requestors_json, []),
  stages: parse(r.stages_json, []).map(s => ({ ...s, conditions: EXP_COND.normalizeConditions(s.conditions) })),
  conditions: EXP_COND.normalizeConditions(parse(r.conditions_json, {})), priority: r.priority ?? 100,
  createdAt: r.created_at, updatedAt: r.updated_at,
});
export const templateRepo = {
  list() { return db.prepare(`SELECT * FROM exp_templates ORDER BY priority, id`).all().map(templateOut); },
  get(id) { return templateOut(db.prepare(`SELECT * FROM exp_templates WHERE id = ?`).get(Number(id))); },
  create(b) {
    const t = normalizeTemplate(b);
    const info = db.prepare(`INSERT INTO exp_templates (name, description, requestors_json, stages_json, conditions_json, priority, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(t.name, t.description, JSON.stringify(t.requestors), JSON.stringify(t.stages), JSON.stringify(t.conditions), t.priority, now(), now());
    return this.get(info.lastInsertRowid);
  },
  update(id, b) {
    const t = normalizeTemplate(b);
    const n = db.prepare(`UPDATE exp_templates SET name=?, description=?, requestors_json=?, stages_json=?, conditions_json=?, priority=?, updated_at=? WHERE id=?`)
      .run(t.name, t.description, JSON.stringify(t.requestors), JSON.stringify(t.stages), JSON.stringify(t.conditions), t.priority, now(), Number(id)).changes;
    return n ? this.get(id) : null;
  },
  delete(id) { return db.prepare(`DELETE FROM exp_templates WHERE id = ?`).run(Number(id)).changes; },
};

export const actionRepo = {
  add({ claimId, stageNo, userId, userName, action, comment }) {
    db.prepare(`INSERT INTO exp_approval_actions (claim_id, stage_no, user_id, user_name, action, comment, at) VALUES (?,?,?,?,?,?,?)`)
      .run(Number(claimId), Number(stageNo), str(userId), str(userName), action, str(comment).slice(0, 1000), now());
  },
  list(claimId) { return db.prepare(`SELECT * FROM exp_approval_actions WHERE claim_id = ? ORDER BY id`).all(Number(claimId)); },
  clear(claimId) { db.prepare(`DELETE FROM exp_approval_actions WHERE claim_id = ?`).run(Number(claimId)); },
};
