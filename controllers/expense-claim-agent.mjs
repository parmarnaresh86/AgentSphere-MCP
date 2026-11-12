/**
 * Employee Expense Claims — backend for Finance → Employee Expenses. Mounted at /api/expense.
 *
 *  Employee uploads bills (PDF / photo) → OCR (lib/ocr-extract.mjs) → one claim line per bill
 *  (date, merchant, category → expense G/L, amount) → submit → approval templates / stages
 *  (same engine as AP Invoice Processing, plus the claimant's SAP reporting manager) →
 *  finance posts one SAP Journal Entry: Dr expense G/L per line, Cr Employee Reimbursement Payable.
 *
 * Permissions (db.mjs ALL_PERMISSIONS, checked on every request):
 *   expense.claims    create / submit own claims        expense.approvals  approval inbox
 *   expense.all       see every claim, post the JV      expense.master     approval templates
 *   expense.settings  payable G/L, categories, user → SAP employee mapping
 *
 * deps: { requireAuth, printAuth, getActiveSap, gptChatComplete, azureMessagesCreate, AI_PROVIDER, USE_AI,
 *         cacheRepo, getActiveCompanyId, userPermRepo, listPrincipals, roleIdByName }
 */
import { Router } from 'express';
import multer from 'multer';
import { extractPdfText, runVisionExtraction } from '../lib/ocr-extract.mjs';
import { fetchAllPages } from '../lib/copy-doc-flow.mjs';
import {
  EXP_FIELDS, EXP_COND, settingsRepo, employeeMapRepo, claimRepo, receiptRepo, templateRepo, actionRepo,
} from '../lib/expense-store.mjs';

const _upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 20 } });
const MIME_BY_EXT = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

// ── Small helpers ─────────────────────────────────────────────────────────────
const num = v => { if (v == null || v === '') return 0; const n = Number(String(v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : 0; };
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const q = s => String(s ?? '').replace(/'/g, "''");
const todayISO = () => new Date().toISOString().slice(0, 10);
const userIdOf = u => String(u?.user_id ?? u?.id ?? '');
const userNameOf = u => u?.full_name || u?.username || '';
const httpErr = (status, msg) => Object.assign(new Error(msg), { status });
const lineId = () => Math.random().toString(36).slice(2, 10);
function withTimeout(p, ms, label) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timed out`)), ms); })]).finally(() => clearTimeout(t));
}
function normDate(s) {
  if (!s) return '';
  const v = String(s).trim();
  let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = v.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (m) { const y = m[3].length === 2 ? `20${m[3]}` : m[3]; return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; }
  const d = new Date(v);                      // "Nov 11, 2026" → local midnight; read local parts (toISOString would shift a day east of UTC)
  return isNaN(d) ? '' : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const daysAgo = iso => { const d = new Date(String(iso) + 'T00:00:00Z'); return isNaN(d) ? 0 : Math.floor((Date.now() - d) / 86400000); };

// ── OCR ───────────────────────────────────────────────────────────────────────
const receiptPrompt = categories => `You read employee expense receipts and bills (hotel, taxi, fuel, meals, tickets, phone, supplies …).
Return ONLY valid JSON (no markdown) with exactly this structure:
{
  "merchant": "string or null — the business that issued the bill",
  "billNo": "string or null — receipt / invoice / ticket number",
  "date": "YYYY-MM-DD or null — date of the expense",
  "currency": "ISO code e.g. USD, INR, EUR, or null",
  "subtotal": 0,
  "tax": 0,
  "tip": 0,
  "total": 0,
  "category": "one of: ${categories.join(', ')}",
  "description": "string — short description of what was bought, max 80 characters",
  "paymentMethod": "string or null — cash, card ending 1234, UPI …"
}
total is the amount actually paid, including tax and tip. Use 0 for numbers you cannot read and null for unknown strings.
Pick the closest category from the list; use "Other" only when none fits.`;

function normalizeReceipt(raw = {}, categories) {
  const r = raw || {};
  const cat = String(r.category || '').trim();
  const match = categories.find(c => c.toLowerCase() === cat.toLowerCase()) || categories.find(c => cat && c.toLowerCase().includes(cat.toLowerCase())) || '';
  const total = num(r.total) || round2(num(r.subtotal) + num(r.tax) + num(r.tip));
  const merchant = r.merchant ? String(r.merchant).trim().slice(0, 100) : null;
  // no category from the AI (or no AI at all) → guess from merchant / description / bill text
  const category = match || guessCategory([merchant, r.description, r._text].filter(Boolean).join('\n'), categories);
  return {
    merchant,
    billNo: r.billNo ? String(r.billNo).trim().slice(0, 60) : null,
    date: normDate(r.date) || null,
    currency: r.currency ? String(r.currency).trim().toUpperCase().slice(0, 3) : null,
    subtotal: num(r.subtotal), tax: num(r.tax), tip: num(r.tip), total,
    category: category || null,
    categoryGuessed: !match && !!category,
    description: r.description ? String(r.description).trim().slice(0, 100) : null,
    paymentMethod: r.paymentMethod ? String(r.paymentMethod).trim().slice(0, 60) : null,
  };
}
// Text-layer reader used when no AI engine answers. PDF text often runs columns together
// ("Sales Tax 8.0%$22.96", "11/10/20268:42 PM"), so amounts are taken as the LAST money value on a line.
function fallbackReceipt(text) {
  const t = String(text || '');
  const lines = t.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const lastAmount = s => { const m = s.match(/\d[\d,]*\.\d{2}(?!\d)/g); return m ? num(m[m.length - 1]) : 0; };
  // first line matching any of the patterns (in order) → its last amount
  const amountOn = (...res) => { for (const re of res) { const l = lines.find(x => re.test(x)); if (l && lastAmount(l)) return lastAmount(l); } return 0; };
  const dateTxt = (t.match(/(?<!\d)(\d{4}-\d{2}-\d{2})/)
    || t.match(/(?<!\d)(\d{1,2}[./-]\d{1,2}[./-](?:\d{4}|\d{2}(?!\d)))/)
    || t.match(/((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})/)
    || t.match(/(?<!\d)(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?,?\s+\d{4})/i) || [])[1];
  // first labelled number on the same line that contains a digit ("RECEIPT" alone above "Invoice SG-2026-3381" must not win)
  const billNo = [...t.matchAll(/(?:receipt|invoice|bill|ticket|check|cheque|order|guest[^\S\n]*check|conto|folio|txn|transaction)[^\S\n]*(?:no\.?|number|#|:)?[^\S\n]*#?[^\S\n]*([A-Za-z0-9][A-Za-z0-9\/\-]{2,})/gi)]
    .map(m => m[1]).find(v => /\d/.test(v)) || null;
  return {
    merchant: lines.find(s => s.length > 3 && /[a-z]/i.test(s)) || null,
    billNo,
    date: normDate(dateTxt) || null,
    total: amountOn(/grand\s*total|total\s*(?:due|paid)|amount\s*(?:due|paid)|net\s*payable/i, /^(?!.*sub\s*-?\s*total).*\btotal\b/i),
    subtotal: amountOn(/sub\s*-?\s*total/i),
    tax: amountOn(/sales\s*tax|\btax\b|\bgst\b|\bvat\b/i),
    tip: amountOn(/\btip\b|gratuity|service\s*charge/i),
    _text: t,
    _fallback: true,
  };
}

// Default category from what the bill says, used when the AI gives none. Only categories that exist in Settings are returned.
const CATEGORY_RULES = [
  ['Meals', /restaurant|grill|caf[eé]|diner|bistro|trattoria|pizzeria|pizza|taqueria|sushi|bento|kitchen|eatery|steakhouse|bakery|coffee|starbucks|server:|table\s*\d|guests?\b|\btip\b|gratuity|breakfast|lunch|dinner|food|bar\b|pub\b/i],
  ['Lodging', /hotel|motel|\binn\b|suites|resort|lodg|marriott|hilton|hyatt|airbnb|room\s*(?:no|charge|rate)|check-?in|check-?out|folio/i],
  ['Local Conveyance', /uber|lyft|taxi|\bcab\b|parking|toll|metro|subway|transit|bus\s*fare|ride/i],
  ['Travel', /airline|airways|flight|boarding|amtrak|\brail\b|train|airfare|baggage|car\s*rental|hertz|avis|enterprise\s*rent/i],
  ['Fuel & Mileage', /fuel|gasoline|diesel|unleaded|gallons?|petrol|\bgas\s*station|shell|exxon|chevron|sunoco|mileage/i],
  ['Telephone & Internet', /wireless|mobile|cellular|verizon|at&t|t-mobile|internet|broadband|data\s*plan|telephone|phone\s*bill/i],
  ['Office Supplies', /staples|office\s*depot|stationery|toner|printer|paper|pens?\b|office\s*suppl/i],
  ['Courier & Postage', /fedex|\bups\b|usps|dhl|courier|postage|shipping|post\s*office/i],
  ['Training', /course|training|seminar|workshop|conference|certification|tuition|registration\s*fee/i],
  ['Medical', /pharmacy|clinic|hospital|medical|doctor|cvs|walgreens|prescription/i],
];
function guessCategory(text, categories) {
  const has = name => categories.find(c => c.toLowerCase() === name.toLowerCase());
  for (const [name, re] of CATEGORY_RULES) if (re.test(text) && has(name)) return has(name);
  return has('Other') || null;
}

// ── Router ────────────────────────────────────────────────────────────────────
export function createExpenseClaimRouter(deps = {}) {
  const { requireAuth, printAuth = requireAuth, getActiveSap, cacheRepo, getActiveCompanyId, userPermRepo, listPrincipals, roleIdByName } = deps;
  const aiDeps = { AI_PROVIDER: deps.AI_PROVIDER, gptChatComplete: deps.gptChatComplete, azureMessagesCreate: deps.azureMessagesCreate, USE_AI: deps.USE_AI };
  const router = Router();
  const cid = () => { try { return getActiveCompanyId() || 'default'; } catch { return 'default'; } };
  const sapNow = () => { try { return getActiveSap(); } catch { return null; } };

  const wrap = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (e) {
      if (!e.status || e.status >= 500) console.error(`[Expense] ${req.method} ${req.originalUrl}:`, e.message);
      if (!res.headersSent) res.status(e.status || 500).json({ ok: false, error: e.message, ...(e.issues ? { issues: e.issues } : {}) });
    }
  };
  const permsOf = user => new Set(userPermRepo.getEffective(user.user_id, user.role));
  const need = (req, key) => { if (!permsOf(req.user).has(key)) throw httpErr(403, 'You do not have permission for this. Ask an administrator (Admin → Roles & Permissions → Finance → Employee Expenses).'); };

  // ── Approval engine (as AP Invoice Processing, plus "reporting manager") ────
  function principalMatches(p, user, claim) {
    if (!p || !user) return false;
    if (p.type === 'manager') return !!claim && claim.managerId != null && employeeMapRepo.usersForEmp(cid(), claim.managerId).includes(userIdOf(user));
    if (p.type === 'role') {
      const rid = roleIdByName(user.role);
      return (rid != null && String(p.id) === String(rid)) || p.name === user.role || String(p.id) === String(user.role);
    }
    return String(p.id) === userIdOf(user) || p.name === user.username || String(p.id) === String(user.username);
  }
  function claimFacts(c) {
    const lines = c.lines || [];
    return {
      total: c.total, maxLine: lines.reduce((m, l) => Math.max(m, num(l.amount)), 0), billCount: lines.length,
      oldestDays: lines.reduce((m, l) => Math.max(m, l.date ? daysAgo(l.date) : 0), 0),
      employee: c.empId != null ? String(c.empId) : '', department: c.department || '', currency: c.currency || '',
      category: lines.map(l => l.category).filter(Boolean), glAccount: lines.map(l => resolvedAccount(l)).filter(Boolean),
    };
  }
  function stagesFor(t, facts) { return (t.stages || []).filter(s => EXP_COND.evalConditions(s.conditions, facts).ok); }
  function matchTemplate(c, requestor) {
    const facts = claimFacts(c);
    const rows = templateRepo.list().map(t => {
      if (!t.stages?.length) return { t, ok: false, why: 'Template has no stages' };
      if (t.requestors?.length && !t.requestors.some(p => principalMatches(p, requestor, c))) return { t, ok: false, why: 'Claimant is not on this template' };
      const r = EXP_COND.evalConditions(t.conditions, facts);
      if (!r.ok) return { t, ok: false, why: `Not met: ${r.failed.join('; ')}` };
      if (!stagesFor(t, facts).length) return { t, ok: false, why: 'No stage applies' };
      return { t, ok: true, reasons: r.reasons };
    });
    const ok = rows.filter(x => x.ok).sort((a, b) => (a.t.priority ?? 100) - (b.t.priority ?? 100) || (b.t.conditions?.rules?.length || 0) - (a.t.conditions?.rules?.length || 0) || a.t.id - b.t.id);
    return { facts, best: ok[0] || null, rejected: rows.filter(x => !x.ok) };
  }
  const stageCounts = (actions, no) => { const a = actions.filter(x => x.stage_no === no); return { approvals: a.filter(x => x.action === 'approve').length, rejections: a.filter(x => x.action === 'reject').length }; };
  function canAct(c, user) {
    const ap = c.approval;
    if (!ap || !['PENDING', 'PARTIAL'].includes(c.approvalStatus)) return false;
    const stage = ap.stages[ap.currentStage - 1];
    if (!stage || !stage.approvers.some(p => principalMatches(p, user, c))) return false;
    if (String(c.userId) === userIdOf(user)) return false;                       // nobody approves their own claim
    return !actionRepo.list(c.id).some(a => a.stage_no === stage.no && a.user_id === userIdOf(user));
  }
  const isApproverAnyStage = (c, user) => !!c.approval?.stages?.some(s => s.approvers.some(p => principalMatches(p, user, c)));
  function approvalView(c) {
    const ap = c.approval;
    if (!ap) return null;
    const actions = actionRepo.list(c.id);
    return {
      templateName: ap.templateName, currentStage: ap.currentStage, matchReasons: ap.matchReasons || [],
      stages: ap.stages.map(s => ({ no: s.no, name: s.name, status: s.status, approvalsRequired: s.approvalsRequired, approvers: s.approvers,
        actions: actions.filter(a => a.stage_no === s.no).map(a => ({ user: a.user_name, action: a.action, comment: a.comment, at: a.at })) })),
    };
  }

  // ── Accounts ────────────────────────────────────────────────────────────────
  const settings = () => settingsRepo.get();
  function resolvedAccount(l, s = settings()) {
    if (l.account) return l.account;
    const cat = s.categories.find(c => c.name === l.category);
    return cat?.account || s.defaultExpenseAccount || '';
  }
  // G/L field text (internal code, format code or "code — name") → { code, name, format } via the Data Sync cache, else SAP.
  async function resolveGl(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;
    const token = raw.split(/\s+[—–-]\s+/)[0].trim();
    const out = a => ({ code: a.AcctCode ?? a.Code, name: a.AcctName ?? a.Name ?? '', format: a.FormatCode || '', postable: (a.Postable ?? a.ActiveAccount ?? 'tYES') !== 'tNO' && (a.Postable ?? 'Y') !== 'N' });
    try {
      if (cacheRepo?.countGLAccounts?.(cid())) {
        const exact = cacheRepo.getGLAccount(cid(), token);
        if (exact) return out(exact);
        const hits = cacheRepo.searchGLAccounts(cid(), token, 0).filter(a => String(a.FormatCode || '').toLowerCase() === token.toLowerCase());
        if (hits.length === 1) return out(hits[0]);
      }
    } catch { /* fall back to SAP */ }
    const sap = sapNow();
    if (!sap) return null;
    try { return out(await withTimeout(sap.get(`/ChartOfAccounts('${q(token)}')`, { $select: 'Code,Name,FormatCode,ActiveAccount' }), 15000, 'G/L lookup')); } catch { /* not an internal code */ }
    try {
      const r = await withTimeout(sap.get('/ChartOfAccounts', { $select: 'Code,Name,FormatCode,ActiveAccount', $filter: `FormatCode eq '${q(token)}'`, $top: 2 }), 15000, 'G/L lookup');
      return r.value?.length === 1 ? out(r.value[0]) : null;
    } catch { return null; }
  }
  async function searchGl(text) {
    try {
      if (cacheRepo?.countGLAccounts?.(cid())) {
        return cacheRepo.searchGLAccounts(cid(), text || '', 40)
          .filter(a => (a.Postable ?? 'tYES') !== 'tNO' && (a.Postable ?? 'Y') !== 'N')
          .map(a => ({ code: a.AcctCode, name: a.AcctName || '', format: a.FormatCode || '' }));
      }
    } catch { /* fall back to SAP */ }
    const sap = sapNow();
    if (!sap) return [];
    const t = q(text || '');
    const r = await withTimeout(sap.get('/ChartOfAccounts', {
      $select: 'Code,Name,FormatCode', $top: 40,
      $filter: `ActiveAccount eq 'tYES'${t ? ` and (contains(Code,'${t}') or contains(Name,'${t}') or contains(FormatCode,'${t}'))` : ''}`,
    }), 20000, 'G/L search');
    return (r.value || []).map(a => ({ code: a.Code, name: a.Name || '', format: a.FormatCode || '' }));
  }

  // ── SAP employees (Employee master) ────────────────────────────────────────
  let _empCache = { at: 0, cid: '', rows: [] };
  async function sapEmployees(force = false) {
    if (!force && _empCache.cid === cid() && Date.now() - _empCache.at < 10 * 60 * 1000) return _empCache.rows;
    const sap = sapNow();
    if (!sap) throw httpErr(503, 'SAP is not connected.');
    const [emps, depts] = await Promise.all([
      fetchAllPages(sap, '/EmployeesInfo', { $select: 'EmployeeID,FirstName,MiddleName,LastName,Department,Manager,eMail,Active,JobTitle' }, 20000),
      sap.get('/Departments', { $select: 'Code,Name' }).then(r => r.value || []).catch(() => []),
    ]);
    const deptName = Object.fromEntries(depts.map(d => [String(d.Code), d.Name]));
    const nameOf = e => [e.FirstName, e.MiddleName, e.LastName].filter(Boolean).join(' ').trim() || `Employee ${e.EmployeeID}`;
    const byId = Object.fromEntries(emps.map(e => [e.EmployeeID, e]));
    const rows = emps.filter(e => e.Active !== 'tNO').map(e => ({
      empId: e.EmployeeID, name: nameOf(e), email: e.eMail || '', jobTitle: e.JobTitle || '',
      department: e.Department != null ? (deptName[String(e.Department)] || String(e.Department)) : '',
      managerId: e.Manager ?? null, managerName: e.Manager != null && byId[e.Manager] ? nameOf(byId[e.Manager]) : '',
    })).sort((a, b) => a.name.localeCompare(b.name));
    _empCache = { at: Date.now(), cid: cid(), rows };
    return rows;
  }

  // ── Claim helpers ──────────────────────────────────────────────────────────
  function access(c, user) {
    const p = permsOf(user), own = String(c.userId) === userIdOf(user);
    const all = p.has('expense.all');
    if (!own && !all && !isApproverAnyStage(c, user)) throw httpErr(404, 'Claim not found');
    const editable = ['draft', 'rejected'].includes(c.status);
    return { own, all, canEdit: (own && editable) || (all && ['draft', 'rejected', 'submitted', 'approved'].includes(c.status) && c.status !== 'posted'), canPost: all };
  }
  function recompute(lines) {
    const clean = (Array.isArray(lines) ? lines : []).map(l => ({
      id: String(l.id || lineId()), receiptId: l.receiptId != null && l.receiptId !== '' ? Number(l.receiptId) : null,
      date: normDate(l.date) || '', merchant: String(l.merchant || '').slice(0, 100), billNo: String(l.billNo || '').slice(0, 60),
      description: String(l.description || '').slice(0, 100), category: String(l.category || '').slice(0, 60),
      account: String(l.account || '').trim(), amount: round2(num(l.amount)), tax: round2(num(l.tax)),
      currency: String(l.currency || '').toUpperCase().slice(0, 3), note: String(l.note || '').slice(0, 200),
    }));
    return { lines: clean, total: round2(clean.reduce((s, l) => s + l.amount, 0)) };
  }
  function claimOutFor(c, user) {
    const a = access(c, user);
    const s = settings();
    return {
      ...c, receipts: receiptRepo.list(c.id),
      lines: c.lines.map(l => ({ ...l, resolvedAccount: resolvedAccount(l, s) })),
      approvalView: approvalView(c), canEdit: a.canEdit, canSubmit: a.own && ['draft', 'rejected'].includes(c.status),
      canDelete: a.own && c.status === 'draft', canApprove: canAct(c, user),
      canPost: a.canPost && c.status !== 'posted' && (c.approvalStatus === 'APPROVED' || c.approvalStatus === 'NOT_REQUIRED' || (!s.approvalRequired && c.status !== 'rejected')),
      isOwner: a.own,
    };
  }

  async function ocrReceipt(rec) {
    const s = settings();
    const categories = s.categories.map(c => c.name);
    const file = receiptRepo.readFile(rec.id);
    if (!file) throw new Error('Bill file is missing');
    receiptRepo.update(rec.id, { ocrStatus: 'processing', error: '' });
    try {
      const isPdf = file.mime === 'application/pdf';
      const text = isPdf ? await extractPdfText(file.buffer).catch(() => '') : '';
      const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
      const aiOn = !!aiDeps.USE_AI || hasAnthropic;
      let raw;
      if (!aiOn) {
        if (!text) throw new Error('No AI engine is configured, and this bill has no text layer to read.');
        raw = fallbackReceipt(text);
      } else {
        // the GPT path can't read PDF images; use the Anthropic SDK when only that can
        const d = (aiDeps.AI_PROVIDER === 'gpt' && isPdf && !text && hasAnthropic) ? { ...aiDeps, USE_AI: false } : aiDeps;
        raw = await runVisionExtraction(s.ocrEngine === 'text' && text ? null : file.buffer, file.mime, text, d, receiptPrompt(categories), fallbackReceipt);
        // Primary engine failed (e.g. wrong AZURE_CLAUDE_MODEL deployment) → retry once on GPT: PDF text layer, or the photo itself.
        const gptOk = aiDeps.gptChatComplete && process.env.AZURE_GPT_ENDPOINT && d.AI_PROVIDER !== 'gpt';
        if ((!raw || raw._fallback) && gptOk && (text || !isPdf)) {
          console.warn(`[Expense] bill ${rec.id}: primary AI extraction failed — retrying with GPT.`);
          const viaGpt = await runVisionExtraction(isPdf ? null : file.buffer, file.mime, text, { ...aiDeps, AI_PROVIDER: 'gpt', USE_AI: true }, receiptPrompt(categories), fallbackReceipt);
          if (viaGpt && !viaGpt._fallback) raw = viaGpt;
        }
      }
      if (!raw) throw new Error('The bill could not be read.');
      const ext = normalizeReceipt(raw, categories);
      receiptRepo.update(rec.id, { ocrStatus: 'done', extracted: ext, error: '' });
      return ext;
    } catch (e) {
      receiptRepo.update(rec.id, { ocrStatus: 'failed', error: e.message.slice(0, 500) });
      throw e;
    }
  }
  const lineFromReceipt = (rec, ext, claimCurrency) => ({
    id: lineId(), receiptId: rec.id, date: ext?.date || '', merchant: ext?.merchant || '', billNo: ext?.billNo || '',
    description: ext?.description || ext?.merchant || rec.fileName, category: ext?.category || '', account: '',
    amount: round2(ext?.total || 0), tax: round2(ext?.tax || 0), currency: ext?.currency || claimCurrency || '', note: '',
  });

  // Issues that block submit / post. level: 'submit' | 'post'
  async function validateClaim(c, level) {
    const s = settings(), issues = [];
    const err = (message, line) => issues.push({ severity: 'error', message, line });
    const warn = (message, line) => issues.push({ severity: 'warning', message, line });
    if (c.empId == null) err('Your login is not linked to an SAP employee. Ask an administrator to map it under Employee Expenses → Settings.');
    if (!c.lines.length) err('Add at least one bill.');
    const busy = receiptRepo.list(c.id).filter(r => ['pending', 'processing'].includes(r.ocrStatus));
    if (busy.length) err(`${busy.length} bill(s) are still being read.`);
    const ccy = new Set(c.lines.map(l => l.currency).filter(Boolean));
    if (ccy.size > 1) warn(`Bills are in more than one currency (${[...ccy].join(', ')}). Amounts are posted as entered, in the company currency.`);
    for (const [i, l] of c.lines.entries()) {
      if (!l.date) err('Bill date is missing.', i);
      else if (l.date > todayISO()) err('Bill date is in the future.', i);
      else if (s.maxBillAgeDays && daysAgo(l.date) > s.maxBillAgeDays) warn(`Bill is ${daysAgo(l.date)} days old (limit ${s.maxBillAgeDays}).`, i);
      if (!(l.amount > 0)) err('Amount must be more than 0.', i);
      if (!l.category) err('Choose an expense category.', i);
      if (level === 'post') {
        const acc = resolvedAccount(l, s);
        if (!acc) err(`No expense G/L for category "${l.category || '?'}". Set it in Settings or on the line.`, i);
        else if (!(await resolveGl(acc))) err(`Expense G/L "${acc}" was not found in SAP.`, i);
      }
    }
    // same bill claimed twice (this user, any other claim that isn't rejected)
    const others = claimRepo.list(c.companyId, { userId: c.userId }).filter(o => o.id !== c.id && o.status !== 'rejected');
    for (const [i, l] of c.lines.entries()) {
      if (!l.billNo && !l.merchant) continue;
      const dup = others.find(o => o.lines.some(x => x.amount === l.amount && x.date === l.date && (l.billNo ? x.billNo === l.billNo : x.merchant === l.merchant)));
      if (dup) warn(`This bill looks the same as one on claim #${dup.id}.`, i);
    }
    if (level === 'post') {
      if (!s.payableAccount) err('Set the Employee Reimbursement Payable G/L in Employee Expenses → Settings.');
      else if (!(await resolveGl(s.payableAccount))) err(`Payable G/L "${s.payableAccount}" was not found in SAP.`);
    }
    return issues;
  }

  async function postClaim(c, user, postingDate) {
    const issues = await validateClaim(c, 'post');
    const errors = issues.filter(i => i.severity === 'error');
    if (errors.length) throw Object.assign(httpErr(400, `${errors.length} problem(s) must be fixed before posting.`), { issues });
    const sap = sapNow();
    if (!sap) throw httpErr(503, 'SAP is not connected.');
    const s = settings();
    const ref = `EXP-${c.id}`;
    const date = normDate(postingDate) || todayISO();
    const payable = await resolveGl(s.payableAccount);
    const debit = [];
    for (const l of c.lines) {
      const gl = await resolveGl(resolvedAccount(l, s));
      debit.push({
        AccountCode: gl.code, ShortName: gl.code, Debit: round2(l.amount), Credit: 0,
        LineMemo: `${l.merchant || l.category} ${l.date}`.trim().slice(0, 50),
        Reference1: ref, Reference2: (l.billNo || '').slice(0, 100),
      });
    }
    const payload = {
      ReferenceDate: date, TaxDate: date, DueDate: date,
      Memo: `${s.memoPrefix} #${c.id} – ${c.empName}`.slice(0, 50),
      Reference: ref, Reference2: String(c.empId ?? ''), Reference3: (c.title || '').slice(0, 27),
      JournalEntryLines: [
        ...debit,
        { AccountCode: payable.code, ShortName: payable.code, Debit: 0, Credit: round2(c.total),
          LineMemo: `${c.empName} (Emp ${c.empId})`.slice(0, 50), Reference1: ref, Reference2: String(c.empId ?? '') },
      ],
    };
    let r;
    try { r = await sap.post('/JournalEntries', payload); }
    catch (e) {
      claimRepo.update(c.id, { error: `SAP: ${e.message}`.slice(0, 1000) });
      const m = String(e.message).match(/"value"\s*:\s*"([^"]+)"/);
      throw httpErr(502, `SAP rejected the journal entry: ${m ? m[1] : e.message}`);
    }
    return claimRepo.update(c.id, {
      status: 'posted', postedAt: new Date().toISOString(), postedBy: userNameOf(user), postingDate: date,
      sapTransId: r?.JdtNum ?? null, sapNumber: r?.Number ?? r?.JdtNum ?? null, error: '',
    });
  }

  function getClaimOr404(id) { const c = claimRepo.get(id); if (!c || c.companyId !== cid()) throw httpErr(404, 'Claim not found'); return c; }

  // ════════════════════════════════════════════════════════════════════════════
  // Routes
  // ════════════════════════════════════════════════════════════════════════════
  router.get('/me', requireAuth, wrap(async (req, res) => {
    const p = permsOf(req.user);
    const s = settings();
    res.json({
      ok: true, user: { id: userIdOf(req.user), name: userNameOf(req.user) },
      employee: employeeMapRepo.get(cid(), userIdOf(req.user)),
      perms: ['expense.claims', 'expense.approvals', 'expense.all', 'expense.master', 'expense.settings'].filter(k => p.has(k)),
      categories: s.categories.map(c => c.name), approvalRequired: s.approvalRequired,
      inbox: claimRepo.pendingApproval(cid()).filter(c => canAct(c, req.user)).length,
    });
  }));

  // ── Claims ──
  router.get('/claims', requireAuth, wrap(async (req, res) => {
    const scope = req.query.scope === 'all' ? 'all' : 'mine';
    if (scope === 'all') need(req, 'expense.all'); else need(req, 'expense.claims');
    const rows = claimRepo.list(cid(), { userId: scope === 'mine' ? userIdOf(req.user) : null, status: String(req.query.status || ''), search: String(req.query.search || '') });
    res.json({ ok: true, rows: rows.map(c => ({ id: c.id, title: c.title, empName: c.empName, userName: c.userName, department: c.department,
      total: c.total, currency: c.currency, bills: c.lines.length, status: c.status, approvalStatus: c.approvalStatus,
      submittedAt: c.submittedAt, postedAt: c.postedAt, sapNumber: c.sapNumber, createdAt: c.createdAt, error: c.error })) });
  }));

  router.post('/claims', requireAuth, wrap(async (req, res) => {
    need(req, 'expense.claims');
    const emp = employeeMapRepo.get(cid(), userIdOf(req.user));
    const c = claimRepo.create({ companyId: cid(), userId: userIdOf(req.user), userName: userNameOf(req.user), emp,
      title: String(req.body?.title || '').slice(0, 100), purpose: String(req.body?.purpose || '').slice(0, 500) });
    res.json({ ok: true, claim: claimOutFor(c, req.user) });
  }));

  router.get('/claims/:id', requireAuth, wrap(async (req, res) => {
    res.json({ ok: true, claim: claimOutFor(getClaimOr404(req.params.id), req.user) });
  }));

  router.put('/claims/:id', requireAuth, wrap(async (req, res) => {
    const c = getClaimOr404(req.params.id);
    if (!access(c, req.user).canEdit) throw httpErr(403, c.status === 'posted' ? 'This claim is already posted.' : 'This claim can no longer be edited.');
    const { lines, total } = recompute(req.body?.lines ?? c.lines);
    const fields = { lines, total };
    if (req.body?.title !== undefined) fields.title = String(req.body.title).slice(0, 100);
    if (req.body?.purpose !== undefined) fields.purpose = String(req.body.purpose).slice(0, 500);
    if (req.body?.currency !== undefined) fields.currency = String(req.body.currency).toUpperCase().slice(0, 3);
    res.json({ ok: true, claim: claimOutFor(claimRepo.update(c.id, fields), req.user) });
  }));

  router.delete('/claims/:id', requireAuth, wrap(async (req, res) => {
    const c = getClaimOr404(req.params.id);
    if (!access(c, req.user).own || c.status !== 'draft') throw httpErr(400, 'Only your own draft claims can be deleted.');
    receiptRepo.deleteForClaim(c.id);
    claimRepo.delete(c.id);
    res.json({ ok: true });
  }));

  // ── Bills ──
  router.post('/claims/:id/receipts', requireAuth, _upload.any(), wrap(async (req, res) => {
    const c = getClaimOr404(req.params.id);
    if (!access(c, req.user).canEdit) throw httpErr(403, 'Bills can only be added while the claim is a draft.');
    const files = (req.files || []).filter(f => f.size);
    if (!files.length) throw httpErr(400, 'Choose at least one PDF or photo of a bill.');
    const added = [];
    for (const f of files) {
      const ext = (String(f.originalname).match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
      const mime = MIME_BY_EXT[ext] || f.mimetype;
      if (!Object.values(MIME_BY_EXT).includes(mime)) throw httpErr(400, `"${f.originalname}" is not a PDF or image.`);
      added.push(receiptRepo.create(c.id, { buffer: f.buffer, fileName: f.originalname, mime, ext: ext || (mime === 'application/pdf' ? 'pdf' : 'jpg') }));
    }
    // Read the bills one by one, then add one claim line per bill
    const fresh = [];
    for (const rec of added) {
      let ext = null;
      try { ext = await ocrReceipt(rec); } catch { /* receipt marked failed; the line is still added for manual entry */ }
      fresh.push(lineFromReceipt(receiptRepo.get(rec.id), ext, c.currency));
    }
    const cur = claimRepo.get(c.id);
    const { lines, total } = recompute([...cur.lines, ...fresh]);
    const currency = cur.currency || fresh.map(l => l.currency).find(Boolean) || '';
    res.json({ ok: true, claim: claimOutFor(claimRepo.update(c.id, { lines, total, currency }), req.user) });
  }));

  router.post('/claims/:id/receipts/:rid/rescan', requireAuth, wrap(async (req, res) => {
    const c = getClaimOr404(req.params.id);
    if (!access(c, req.user).canEdit) throw httpErr(403, 'This claim can no longer be edited.');
    const rec = receiptRepo.get(req.params.rid);
    if (!rec || rec.claimId !== c.id) throw httpErr(404, 'Bill not found');
    const ext = await ocrReceipt(rec);
    const fresh = lineFromReceipt(rec, ext, c.currency);
    const lines = c.lines.map(l => (l.receiptId === rec.id ? { ...fresh, id: l.id, account: l.account, note: l.note } : l));
    res.json({ ok: true, claim: claimOutFor(claimRepo.update(c.id, recompute(lines)), req.user) });
  }));

  router.delete('/claims/:id/receipts/:rid', requireAuth, wrap(async (req, res) => {
    const c = getClaimOr404(req.params.id);
    if (!access(c, req.user).canEdit) throw httpErr(403, 'This claim can no longer be edited.');
    const rec = receiptRepo.get(req.params.rid);
    if (!rec || rec.claimId !== c.id) throw httpErr(404, 'Bill not found');
    receiptRepo.delete(rec.id);
    res.json({ ok: true, claim: claimOutFor(claimRepo.update(c.id, recompute(c.lines.filter(l => l.receiptId !== rec.id))), req.user) });
  }));

  router.get('/receipts/:rid/file', printAuth, wrap(async (req, res) => {
    const rec = receiptRepo.get(req.params.rid);
    if (!rec) throw httpErr(404, 'Bill not found');
    access(getClaimOr404(rec.claimId), req.user);
    const f = receiptRepo.readFile(rec.id);
    if (!f) throw httpErr(404, 'Bill file is missing');
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(f.fileName || 'bill')}"`);
    res.end(f.buffer);
  }));

  // ── Submit / approval ──
  router.post('/claims/:id/validate', requireAuth, wrap(async (req, res) => {
    const c = getClaimOr404(req.params.id);
    const a = access(c, req.user);
    res.json({ ok: true, issues: await validateClaim(c, a.canPost && c.status !== 'draft' ? 'post' : 'submit') });
  }));

  router.post('/claims/:id/submit', requireAuth, wrap(async (req, res) => {
    const c = getClaimOr404(req.params.id);
    if (!access(c, req.user).own) throw httpErr(403, 'Only the employee who created the claim can submit it.');
    if (!['draft', 'rejected'].includes(c.status)) throw httpErr(400, 'This claim has already been submitted.');
    const issues = await validateClaim(c, 'submit');
    if (issues.some(i => i.severity === 'error')) throw Object.assign(httpErr(400, 'Fix the highlighted problems before submitting.'), { issues });
    const s = settings();
    actionRepo.clear(c.id);
    if (!s.approvalRequired) {
      const u = claimRepo.update(c.id, { status: 'approved', approvalStatus: 'NOT_REQUIRED', approval: null, submittedAt: new Date().toISOString(), error: '' });
      return res.json({ ok: true, claim: claimOutFor(u, req.user), message: 'Claim submitted. No approval is needed; finance can post it.' });
    }
    const { facts, best, rejected } = matchTemplate(c, req.user);
    if (!best) throw httpErr(400, `No approval template applies to this claim. Ask finance to set one up under Employee Expenses → Approval Master.${rejected.length ? ' (' + rejected.slice(0, 3).map(x => `"${x.t.name}": ${x.why}`).join(' · ') + ')' : ''}`);
    const stages = stagesFor(best.t, facts);
    // A stage approved only by "reporting manager" needs a manager in SAP who has an AgentSphere login — otherwise the claim would wait forever.
    const managerUsers = c.managerId != null ? employeeMapRepo.usersForEmp(cid(), c.managerId) : [];
    const orphan = stages.find(st => st.approvers.length && st.approvers.every(p => p.type === 'manager') && !managerUsers.length);
    if (orphan) {
      throw httpErr(400, c.managerId == null
        ? `Stage "${orphan.name}" is approved by your reporting manager, but no manager is set for you in the SAP Employee master. Ask HR / finance to set it, or to add another approver to the stage.`
        : `Stage "${orphan.name}" is approved by your reporting manager (SAP employee ${c.managerId}), but that manager has no AgentSphere login linked under Employee Expenses → Settings.`);
    }
    const approval = {
      templateId: best.t.id, templateName: best.t.name, currentStage: 1, matchReasons: best.reasons || [],
      stages: stages.map((st, i) => ({ no: i + 1, name: st.name, approvalsRequired: st.approvalsRequired, rejectorsRequired: st.rejectorsRequired,
        approvers: st.approvers, status: i === 0 ? 'PENDING' : 'WAITING' })),
    };
    const u = claimRepo.update(c.id, { status: 'submitted', approvalStatus: 'PENDING', approval, templateId: best.t.id, submittedAt: new Date().toISOString(), error: '' });
    res.json({ ok: true, claim: claimOutFor(u, req.user), message: `Submitted for approval (${best.t.name}).` });
  }));

  router.get('/approvals', requireAuth, wrap(async (req, res) => {
    need(req, 'expense.approvals');
    const tab = req.query.tab === 'history' ? 'history' : 'mine';
    let rows;
    if (tab === 'mine') rows = claimRepo.pendingApproval(cid()).filter(c => canAct(c, req.user));
    else {
      const me = userIdOf(req.user);
      const ids = new Set(claimRepo.list(cid(), { limit: 1000 }).filter(c => actionRepo.list(c.id).some(a => a.user_id === me)).map(c => c.id));
      rows = claimRepo.list(cid(), { limit: 1000 }).filter(c => ids.has(c.id));
    }
    res.json({ ok: true, rows: rows.map(c => {
      const st = c.approval?.stages?.[(c.approval.currentStage || 1) - 1];
      return { id: c.id, title: c.title, empName: c.empName, department: c.department, total: c.total, currency: c.currency, bills: c.lines.length,
        submittedAt: c.submittedAt, approvalStatus: c.approvalStatus, status: c.status, stageName: st?.name || '', stageNo: st?.no || null, stageCount: c.approval?.stages?.length || 0 };
    }) });
  }));

  for (const action of ['approve', 'reject']) {
    router.post(`/claims/:id/${action}`, requireAuth, wrap(async (req, res) => {
      const c = getClaimOr404(req.params.id);
      if (!canAct(c, req.user)) throw httpErr(403, 'You cannot act on this claim at its current stage.');
      const comment = String(req.body?.comment || '').trim();
      if (action === 'reject' && !comment) throw httpErr(400, 'Give a reason for rejecting the claim.');
      const ap = c.approval, stage = ap.stages[ap.currentStage - 1];
      actionRepo.add({ claimId: c.id, stageNo: stage.no, userId: userIdOf(req.user), userName: userNameOf(req.user), action, comment });
      const { approvals, rejections } = stageCounts(actionRepo.list(c.id), stage.no);
      let approvalStatus = 'PARTIAL', status = 'submitted';
      if (rejections >= stage.rejectorsRequired) { stage.status = 'REJECTED'; approvalStatus = 'REJECTED'; status = 'rejected'; }
      else if (approvals >= stage.approvalsRequired) {
        stage.status = 'APPROVED';
        if (ap.currentStage >= ap.stages.length) { approvalStatus = 'APPROVED'; status = 'approved'; }
        else { ap.currentStage += 1; ap.stages[ap.currentStage - 1].status = 'PENDING'; }
      }
      let u = claimRepo.update(c.id, { approval: ap, approvalStatus, status });
      let message = action === 'approve' ? (status === 'approved' ? 'Claim fully approved.' : 'Approved. Sent to the next stage.') : 'Claim rejected and returned to the employee.';
      if (status === 'approved' && settings().autoPostOnApproval) {
        try { u = await postClaim(u, req.user, todayISO()); message = `Claim approved and posted to SAP (JE ${u.sapNumber}).`; }
        catch (e) { u = claimRepo.update(c.id, { error: `Auto-post failed: ${e.message}`.slice(0, 1000) }); message = `Claim approved, but auto-post failed: ${e.message}`; }
      }
      res.json({ ok: true, claim: claimOutFor(u, req.user), message });
    }));
  }

  router.post('/claims/:id/post', requireAuth, wrap(async (req, res) => {
    need(req, 'expense.all');
    const c = getClaimOr404(req.params.id);
    if (c.status === 'posted') throw httpErr(400, `Already posted (JE ${c.sapNumber}).`);
    const s = settings();
    const approved = c.approvalStatus === 'APPROVED' || c.approvalStatus === 'NOT_REQUIRED';
    if (!approved && (s.approvalRequired || c.status === 'draft' || c.status === 'rejected')) throw httpErr(400, 'Only approved claims can be posted.');
    const u = await postClaim(c, req.user, req.body?.postingDate);
    res.json({ ok: true, claim: claimOutFor(u, req.user), docNum: u.sapNumber, transId: u.sapTransId });
  }));

  // ── Lookups ──
  router.get('/gl-accounts', requireAuth, wrap(async (req, res) => {
    res.json({ ok: true, rows: await searchGl(String(req.query.q || '')) });
  }));

  // ── Settings & employee mapping ──
  router.get('/settings', requireAuth, wrap(async (req, res) => { need(req, 'expense.settings'); res.json({ ok: true, settings: settings() }); }));
  router.put('/settings', requireAuth, wrap(async (req, res) => {
    need(req, 'expense.settings');
    const next = { ...settings(), ...(req.body || {}) };
    for (const [label, acc] of [['Payable G/L', next.payableAccount], ['Default expense G/L', next.defaultExpenseAccount], ...(next.categories || []).map(c => [`G/L for "${c.name}"`, c.account])]) {
      if (acc && !(await resolveGl(acc))) throw httpErr(400, `${label} "${acc}" was not found in SAP.`);
    }
    res.json({ ok: true, settings: settingsRepo.save(next) });
  }));
  router.get('/employees', requireAuth, wrap(async (req, res) => {
    need(req, 'expense.settings');
    res.json({ ok: true, rows: await sapEmployees(req.query.refresh === '1') });
  }));
  router.get('/employee-map', requireAuth, wrap(async (req, res) => {
    need(req, 'expense.settings');
    const map = Object.fromEntries(employeeMapRepo.list(cid()).map(m => [m.userId, m]));
    res.json({ ok: true, rows: listPrincipals().users.map(u => ({ userId: String(u.id), username: u.username, name: u.name, role: u.role, employee: map[String(u.id)] || null })) });
  }));
  router.put('/employee-map/:userId', requireAuth, wrap(async (req, res) => {
    need(req, 'expense.settings');
    const empId = req.body?.empId;
    if (empId === null || empId === '' || empId === undefined) { employeeMapRepo.delete(cid(), req.params.userId); return res.json({ ok: true, employee: null }); }
    const e = (await sapEmployees()).find(x => String(x.empId) === String(empId));
    if (!e) throw httpErr(400, `SAP employee ${empId} was not found (or is inactive).`);
    res.json({ ok: true, employee: employeeMapRepo.set(cid(), req.params.userId, { empId: e.empId, empName: e.name, department: e.department, managerId: e.managerId, managerName: e.managerName }) });
  }));

  // ── Approval templates ──
  router.get('/condition-fields', requireAuth, wrap(async (req, res) => {
    const s = settings();
    const emps = employeeMapRepo.list(cid());
    res.json({ ok: true, fields: EXP_FIELDS, ops: EXP_COND.OPS, sources: {
      employees: emps.map(e => ({ code: String(e.empId), name: e.empName })),
      departments: [...new Set(emps.map(e => e.department).filter(Boolean))].map(d => ({ code: d, name: '' })),
      categories: s.categories.map(c => ({ code: c.name, name: '' })),
      glAccounts: [...new Set([s.defaultExpenseAccount, ...s.categories.map(c => c.account)].filter(Boolean))].map(a => ({ code: a, name: '' })),
      currencies: ['USD', 'INR', 'EUR', 'GBP', 'AED', 'SGD', 'CAD', 'AUD'].map(c => ({ code: c, name: '' })),
    } });
  }));
  router.get('/principals', requireAuth, wrap(async (req, res) => {
    const p = listPrincipals();
    res.json({ ok: true, rows: [
      { type: 'manager', id: 'manager', name: "Employee's reporting manager (SAP)" },
      ...p.users.map(u => ({ type: 'user', id: u.id, name: u.name })),
      ...p.roles.map(r => ({ type: 'role', id: r.id, name: r.name })),
    ] });
  }));
  router.get('/templates', requireAuth, wrap(async (req, res) => {
    need(req, 'expense.master');
    res.json({ ok: true, rows: templateRepo.list().map(t => ({ ...t, conditionsText: EXP_COND.describeConditions(t.conditions),
      stages: t.stages.map(s => ({ ...s, conditionsText: EXP_COND.describeConditions(s.conditions) })) })) });
  }));
  const checkTemplate = b => {
    const t = b || {};
    if (!String(t.name || '').trim()) throw httpErr(400, 'Give the template a name.');
    if (!Array.isArray(t.stages) || !t.stages.length) throw httpErr(400, 'Add at least one stage.');
    t.stages.forEach((s, i) => { if (!s.approvers?.length) throw httpErr(400, `Stage ${i + 1}: add at least one approver.`); });
    const probs = [...EXP_COND.conditionProblems(t.conditions, 'Template rule'), ...t.stages.flatMap((s, i) => EXP_COND.conditionProblems(s.conditions, `Stage ${i + 1} rule`))];
    if (probs.length) throw httpErr(400, probs[0]);
  };
  router.post('/templates', requireAuth, wrap(async (req, res) => { need(req, 'expense.master'); checkTemplate(req.body); res.json({ ok: true, template: templateRepo.create(req.body) }); }));
  router.put('/templates/:id', requireAuth, wrap(async (req, res) => {
    need(req, 'expense.master'); checkTemplate(req.body);
    const t = templateRepo.update(req.params.id, req.body);
    if (!t) throw httpErr(404, 'Template not found');
    res.json({ ok: true, template: t });
  }));
  router.delete('/templates/:id', requireAuth, wrap(async (req, res) => { need(req, 'expense.master'); templateRepo.delete(req.params.id); res.json({ ok: true }); }));

  return router;
}
