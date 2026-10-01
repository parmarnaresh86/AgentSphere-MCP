/**
 * Vendor Payment Aging Agent — backend controller
 * Mounted at /api/vendor-payment-aging by chat-server.mjs
 *
 * Data source: HANA view VendorPaymentAgingQuery
 * Input params: P_AgingDate (YYYYMMDD), P_AgingBucketSize (integer days)
 */
import { Router } from 'express';
import { executeSQL, isConnected, getActiveType, getActiveConfig } from '../db-connector.mjs';

const _sessions = new Map();
const _pkgCache = new Map(); // db key -> 'sap.xxx' | null, see hanaPackage()

function initSession() {
  return {
    step: 'INIT',
    history: [],
    agingContext: null,
    lastParams: null,
  };
}

function today() { return new Date().toISOString().slice(0, 10); }

function formatDateParam(dateStr) {
  return (dateStr || today()).replace(/-/g, '');
}

function formatDateLiteral(dateStr) {
  return (dateStr || today()).slice(0, 10);
}

function fmtN(n, d = 0) {
  if (n == null || isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

// ── AI helper ─────────────────────────────────────────────────────────────────
async function callAI(aiDeps, messages, systemPrompt, maxTokens = 2048) {
  if (!aiDeps) return '';
  const { AI_PROVIDER, gptChatComplete, azureMessagesCreate } = aiDeps;
  if (AI_PROVIDER === 'gpt' && process.env.AZURE_GPT_ENDPOINT) {
    const msgs = systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages] : messages;
    const r = await gptChatComplete({ messages: msgs, max_tokens: maxTokens });
    return r.choices?.[0]?.message?.content || '';
  }
  if (AI_PROVIDER === 'azure' && process.env.AZURE_OPENAI_API_KEY) {
    const model = process.env.AZURE_CLAUDE_MODEL || 'claude-3-5-sonnet-20241022';
    const msgs = systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages] : messages;
    const r = await azureMessagesCreate({ model, messages: msgs, max_tokens: maxTokens });
    return r.content?.[0]?.text || r.choices?.[0]?.message?.content || '';
  }
  if (process.env.ANTHROPIC_API_KEY) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: maxTokens,
      system: systemPrompt || undefined, messages,
    });
    return resp.content?.[0]?.text || '';
  }
  return '';
}

// ── HANA View caller ──────────────────────────────────────────────────────────
// Semantic-layer package for the active company, e.g. STTL_SD → sap.sttlsd.
// Verified against _SYS_REPO (so a mismatch falls back instead of querying
// another company's views), same convention as financial-reports-agent.mjs.
const _dbKey = () => { const c = getActiveConfig(); return `${getActiveType()}::${c?.database || c?.schema_name || ''}`; };

async function hanaPackage() {
  if (getActiveType() !== 'hana') return null;
  const key = _dbKey();
  if (_pkgCache.has(key)) return _pkgCache.get(key);
  const cfg = getActiveConfig();
  const candidates = [process.env.FIN_HANA_PACKAGE, cfg?.database, cfg?.schema_name]
    .filter(Boolean)
    .map(s => s.startsWith('sap.') ? s : `sap.${String(s).toLowerCase().replace(/[^a-z0-9]/g, '')}`);
  let pkg = null;
  for (const c of [...new Set(candidates)]) {
    try {
      const rows = await executeSQL(`SELECT COUNT(*) AS "N" FROM "_SYS_REPO"."ACTIVE_OBJECT" WHERE "PACKAGE_ID" = '${c.replace(/'/g, "''")}.ap.case' AND "OBJECT_NAME" = 'VendorPaymentAgingQuery'`);
      if (Number(rows[0]?.N || 0) > 0) { pkg = c; break; }
    } catch { /* no _SYS_REPO access — try next candidate */ }
  }
  _pkgCache.set(key, pkg);
  return pkg;
}

// Parameterized calc-view reference: "_SYS_BIC"."{pkg}.{sub}/{name}"(PLACEHOLDER = ('$$Key$$', 'Value'), ...)
function calcViewRef(pkg, sub, name, params = {}) {
  const ph = Object.entries(params).map(([k, v]) => `'PLACEHOLDER' = ('$$${k}$$', '${String(v).replace(/'/g, "''")}')`);
  return `"_SYS_BIC"."${pkg}.${sub}/${name}"${ph.length ? `(${ph.join(', ')})` : ''}`;
}

// Direct HANA SQL over the calculation view — bypasses the Service Layer's
// /sml.svc/ OData proxy entirely, which pages at 20 rows/response and was
// silently truncating the report to the first page (9 vendors instead of the
// real 101). Querying "_SYS_BIC" directly has no such cap.
async function callAgingViewHana(agingDate, bucketSize) {
  if (getActiveType() !== 'hana' || !isConnected()) throw new Error('HANA direct connection unavailable');
  const pkg = await hanaPackage();
  if (!pkg) throw new Error('HANA semantic-layer package not found for VendorPaymentAgingQuery');
  const viewRef = calcViewRef(pkg, 'ap.case', 'VendorPaymentAgingQuery', {
    P_AgingDate:       formatDateLiteral(agingDate),
    P_AgingBucketSize: String(Number(bucketSize) || 30),
  });
  return executeSQL(`SELECT * FROM ${viewRef} LIMIT 500000`);
}

// Service Layer /sml.svc/ fallback (bare EntitySet, paginated via @odata.nextLink)
// — only used if the direct HANA query above isn't available.
async function callAgingViewServiceLayer(sap, agingDate, bucketSize) {
  let path = `/sml.svc/VendorPaymentAgingQueryParameters(P_AgingDate='${formatDateLiteral(agingDate)}',P_AgingBucketSize=${Number(bucketSize) || 30})/VendorPaymentAgingQuery`;
  const all = [];
  while (path) {
    const data = await sap.get(path);
    if (Array.isArray(data.value)) all.push(...data.value);
    const next = data['@odata.nextLink'];
    path = next ? `/sml.svc/${next}` : null;
    if (all.length >= 20000) break;
  }
  return all;
}

// Older namespace-prefixed POST form — last-resort fallback for deployments
// where the view is exposed under a namespace instead of bare.
async function callAgingViewNamespaced(sap, getNamespace, agingDate, bucketSize) {
  const ns = await getNamespace();
  if (!ns) throw new Error('HANA namespace unavailable — set SL_NAMESPACE env var or ensure HANA is reachable');
  const viewPath = `/sml.svc/${ns}.ap.case/VendorPaymentAgingQuery`;
  const data = await sap.post(viewPath, {
    ParamList: [
      { Name: 'P_AgingDate',       Value: formatDateParam(agingDate) },
      { Name: 'P_AgingBucketSize', Value: String(bucketSize || 30)   },
    ],
  });
  return Array.isArray(data.value) ? data.value : [];
}

async function callAgingView(sap, getNamespace, agingDate, bucketSize) {
  try {
    return await callAgingViewHana(agingDate, bucketSize);
  } catch (e) {
    console.warn('[VPAging] HANA direct view failed, falling back to Service Layer:', e.message);
  }
  try {
    return await callAgingViewServiceLayer(sap, agingDate, bucketSize);
  } catch (e) {
    return await callAgingViewNamespaced(sap, getNamespace, agingDate, bucketSize);
  }
}

// ── Row normalisation ─────────────────────────────────────────────────────────
// The view's own AgingBucket is unreliable: docs due up to ~4 days AFTER the
// aging date land in the first overdue bucket ("0-30" carried 247k of Future
// Remit on 2026-10-01). Re-bucket from NumberOfDaysOutstanding (aging date −
// due date), using the same split as the view's OverdueLC/FutureRemitLC:
// days < 0 → Future Remit, 0..size → first bucket, ... 4 buckets, then "N+".
// Amounts/balances are fine as-is (verified = vendor GL balance in JDT1, incl.
// historical aging dates; cancelled and future-posted docs are excluded).
const BUCKETS_N = 4;
const NULLS = new Set(['-NULL-', '']);
const clean = v => (v == null || NULLS.has(String(v)) ? '' : v);

function bucketDefs(size) {
  const defs = [{ bucket: 'Future Remit', order: 0, minDays: null, maxDays: -1 }];
  for (let i = 0; i < BUCKETS_N; i++) {
    const lo = i === 0 ? 0 : i * size + 1, hi = (i + 1) * size;
    defs.push({ bucket: `${lo}-${hi}`, order: i + 1, minDays: lo, maxDays: hi });
  }
  defs.push({ bucket: `${BUCKETS_N * size}+`, order: BUCKETS_N + 1, minDays: BUCKETS_N * size + 1, maxDays: null });
  return defs;
}

function bucketFor(days, size) {
  if (days < 0) return 'Future Remit';
  if (days <= size) return `0-${size}`;
  const i = Math.ceil(days / size) - 1;
  return i >= BUCKETS_N ? `${BUCKETS_N * size}+` : `${i * size + 1}-${(i + 1) * size}`;
}

function daysBetween(due, asOf) {
  const d = Date.parse(String(due).slice(0, 10)), a = Date.parse(String(asOf).slice(0, 10));
  return isNaN(d) || isNaN(a) ? 0 : Math.round((a - d) / 86400000);
}

function normalizeRows(rows, agingDate, size) {
  return rows.map(r => {
    const days = r.NumberOfDaysOutstanding != null ? Number(r.NumberOfDaysOutstanding) : daysBetween(r.DueDate, agingDate);
    return {
      ...r,
      BranchName:               clean(r.BranchName),
      BusinessPartnerGroupName: clean(r.BusinessPartnerGroupName),
      SalesEmployeeOrBuyerName: clean(r.SalesEmployeeOrBuyerName),
      NumberOfDaysOutstanding:  days,
      ViewAgingBucket:          r.AgingBucket,
      AgingBucket:              bucketFor(days, size),
    };
  });
}

// ── Client-side filtering ─────────────────────────────────────────────────────
function applyFilters(rows, filters = {}) {
  let r = rows;
  if (filters.vendorSearch) {
    const q = filters.vendorSearch.toLowerCase();
    r = r.filter(x =>
      (x.BusinessPartnerCode || '').toLowerCase().includes(q) ||
      (x.BusinessPartnerName || '').toLowerCase().includes(q)
    );
  }
  // docType: code ('18') or display name ('A/P Invoice')
  if (filters.docType)     r = r.filter(x => x.DocumentTypeCode === filters.docType || x.DocumentTypeDisplayName === filters.docType);
  if (filters.branch)      r = r.filter(x => x.BranchName               === filters.branch);
  if (filters.dimension)   r = r.filter(x => x.BusinessPartnerGroupName === filters.dimension);
  if (filters.agingBucket) r = r.filter(x => x.AgingBucket              === filters.agingBucket);
  // Overdue = due on/before the aging date. Keeps overdue credit memos and
  // payments on account (negative) so the net overdue isn't overstated.
  if (filters.onlyOverdue) r = r.filter(x => x.NumberOfDaysOutstanding >= 0);
  return r;
}

// ── Aggregations ──────────────────────────────────────────────────────────────
function aggregateByVendor(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = row.BusinessPartnerCode || 'UNKNOWN';
    if (!map.has(key)) {
      map.set(key, {
        code:              row.BusinessPartnerCode       || '',
        name:              row.BusinessPartnerName       || '',
        nameAndCode:       row.BusinessPartnerNameAndCode|| '',
        group:             row.BusinessPartnerGroupName  || '',
        branch:            row.BranchName                || '',
        currency:          row.BusinessPartnerCurrency   || 'LC',
        dunningTerm:       row.DunningTermName           || '',
        paymentMethod:     row.PaymentMethodCode         || '',
        originalAmt:       0,
        balanceDue:        0,
        futureRemit:       0,
        overdue:           0,
        maxDaysOutstanding:0,
        buckets:           {},
        docCount:          0,
      });
    }
    const v = map.get(key);
    v.originalAmt        += Number(row.OriginalAmountLC   || 0);
    v.balanceDue         += Number(row.AgingBalanceDueLC  || 0);
    v.futureRemit        += Number(row.FutureRemitLC      || 0);
    v.overdue            += Number(row.OverdueLC          || 0);
    v.maxDaysOutstanding  = Math.max(v.maxDaysOutstanding, Number(row.NumberOfDaysOutstanding || 0));
    const bucket = row.AgingBucket || 'Unknown';
    v.buckets[bucket] = (v.buckets[bucket] || 0) + Number(row.AgingBalanceDueLC || 0);
    v.docCount++;
  }
  // Ratios from totals, never summed per row
  for (const v of map.values()) v.overduePct = pct(v.overdue, v.balanceDue);
  return Array.from(map.values()).sort((a, b) => b.overdue - a.overdue);
}

const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 10000) / 100 : 0);

// Chronological (Future Remit → oldest) so charts/columns read left to right;
// empty buckets are skipped, as before.
function aggregateByBucket(rows, size) {
  const map = new Map(bucketDefs(size).map(d => [d.bucket, {
    ...d, balanceDue: 0, overdue: 0, futureRemit: 0, vendorSet: new Set(), docCount: 0,
  }]));
  for (const row of rows) {
    const b = map.get(row.AgingBucket);
    if (!b) continue;
    b.balanceDue  += Number(row.AgingBalanceDueLC || 0);
    b.overdue     += Number(row.OverdueLC         || 0);
    b.futureRemit += Number(row.FutureRemitLC     || 0);
    b.vendorSet.add(row.BusinessPartnerCode);
    b.docCount++;
  }
  const total = rows.reduce((s, r) => s + Number(r.AgingBalanceDueLC || 0), 0);
  return Array.from(map.values())
    .filter(b => b.docCount > 0)
    .map(b => ({ ...b, vendorCount: b.vendorSet.size, vendorSet: undefined, pct: pct(b.balanceDue, total) }));
}

// Generic group-by for the extra chart breakdowns
function aggregateBy(rows, keyFn, labelKey) {
  const map = new Map();
  for (const row of rows) {
    const k = keyFn(row) || 'Unassigned';
    if (!map.has(k)) map.set(k, { [labelKey]: k, balanceDue: 0, overdue: 0, futureRemit: 0, vendorSet: new Set(), docCount: 0 });
    const g = map.get(k);
    g.balanceDue  += Number(row.AgingBalanceDueLC || 0);
    g.overdue     += Number(row.OverdueLC         || 0);
    g.futureRemit += Number(row.FutureRemitLC     || 0);
    g.vendorSet.add(row.BusinessPartnerCode);
    g.docCount++;
  }
  return Array.from(map.values()).map(g => ({ ...g, vendorCount: g.vendorSet.size, vendorSet: undefined }));
}

const dueMonth = r => String(r.DueDateSQL || r.DueDate || '').slice(0, 7);

function aggregateByDimension(rows) {
  const map = new Map();
  for (const row of rows) {
    const dim = row.BusinessPartnerGroupName || 'Unassigned';
    if (!map.has(dim)) {
      map.set(dim, { dimension: dim, balanceDue: 0, overdue: 0, futureRemit: 0, vendorSet: new Set() });
    }
    const d = map.get(dim);
    d.balanceDue  += Number(row.AgingBalanceDueLC || 0);
    d.overdue     += Number(row.OverdueLC         || 0);
    d.futureRemit += Number(row.FutureRemitLC     || 0);
    d.vendorSet.add(row.BusinessPartnerCode);
  }
  return Array.from(map.values())
    .map(d => ({ ...d, vendorCount: d.vendorSet.size, vendorSet: undefined }))
    .sort((a, b) => b.balanceDue - a.balanceDue);
}

function calcTotals(rows) {
  const t = rows.reduce((acc, r) => {
    acc.originalAmt += Number(r.OriginalAmountLC  || 0);
    acc.balanceDue  += Number(r.AgingBalanceDueLC || 0);
    acc.futureRemit += Number(r.FutureRemitLC     || 0);
    acc.overdue     += Number(r.OverdueLC         || 0);
    return acc;
  }, { originalAmt: 0, balanceDue: 0, futureRemit: 0, overdue: 0 });

  t.vendorCount = new Set(rows.map(r => r.BusinessPartnerCode).filter(Boolean)).size;
  t.docCount    = rows.length;
  // Added: ratios from totals + invoice vs credit split
  t.overduePct      = pct(t.overdue, t.balanceDue);
  t.futureRemitPct  = pct(t.futureRemit, t.balanceDue);
  t.invoiceBalance  = rows.filter(r => Number(r.AgingBalanceDueLC || 0) > 0).reduce((s, r) => s + Number(r.AgingBalanceDueLC), 0);
  t.creditBalance   = t.balanceDue - t.invoiceBalance;   // open credit memos / payments on account (≤ 0)
  t.overdueVendorCount = new Set(rows.filter(r => Number(r.OverdueLC || 0) > 0).map(r => r.BusinessPartnerCode)).size;
  // Overdue-weighted average days past due (overdue invoices only)
  const od = rows.filter(r => Number(r.OverdueLC || 0) > 0);
  const odAmt = od.reduce((s, r) => s + Number(r.OverdueLC), 0);
  t.avgDaysOverdue = odAmt > 0 ? Math.round(od.reduce((s, r) => s + Number(r.OverdueLC) * r.NumberOfDaysOutstanding, 0) / odAmt) : 0;
  return t;
}

// ── Document-level rows for the per-vendor drill-down popup ────────────────────
function toDocumentRows(rows) {
  return rows.map(r => ({
    vendorCode:      r.BusinessPartnerCode  || '',
    docNumber:       r.BaseDocumentNumber   || '',
    installment:     r.InstallmentNumber    || 1,
    docType:         r.DocumentTypeDisplayName || r.DocumentTypeCode || '',
    postingDate:     r.PostingDate          || '',
    dueDate:         r.DueDate              || '',
    daysOutstanding: Number(r.NumberOfDaysOutstanding || 0),
    bucket:          r.AgingBucket          || '',
    originalAmt:     Number(r.OriginalAmountLC   || 0),
    balanceDue:      Number(r.AgingBalanceDueLC  || 0),
    futureRemit:     Number(r.FutureRemitLC      || 0),
    overdue:         Number(r.OverdueLC          || 0),
  }));
}

function getFilterOptions(rows, size = 30) {
  return {
    // Display names ('A/P Invoice') instead of object codes; the filter accepts both
    docTypes:   [...new Set(rows.map(r => r.DocumentTypeDisplayName || r.DocumentTypeCode).filter(Boolean))].sort(),
    branches:   [...new Set(rows.map(r => r.BranchName              ).filter(Boolean))].sort(),
    dimensions: [...new Set(rows.map(r => r.BusinessPartnerGroupName).filter(Boolean))].sort(),
    buckets:    bucketDefs(size).map(d => d.bucket).filter(b => rows.some(r => r.AgingBucket === b)),
    employees:  [...new Set(rows.map(r => r.SalesEmployeeOrBuyerName).filter(Boolean))].sort(),
  };
}

// ── AI context string ─────────────────────────────────────────────────────────
function buildAiContext(vendors, totals, buckets, dimBreakdown, params) {
  const top = vendors.slice(0, 15);
  const buckStr = buckets.map(b =>
    `  ${b.bucket}: ${fmtN(b.balanceDue)} (${b.vendorCount} vendors, ${b.docCount} docs)`
  ).join('\n');
  const dimStr = dimBreakdown.slice(0, 8).map(d =>
    `  ${d.dimension}: ${fmtN(d.balanceDue)} balance due, ${fmtN(d.overdue)} overdue`
  ).join('\n');
  const topStr = top.map((v, i) =>
    `  ${i+1}. ${v.name} (${v.code}): Balance ${fmtN(v.balanceDue)}, Overdue ${fmtN(v.overdue)}, ${v.maxDaysOutstanding} days max, Group: ${v.group || '-'}`
  ).join('\n');

  return `VENDOR PAYMENT AGING REPORT
As of: ${params.agingDate} | Bucket Size: ${params.bucketSize} days

TOTALS:
  Balance Due:   ${fmtN(totals.balanceDue)}
  Overdue:       ${fmtN(totals.overdue)}
  Future Remit:  ${fmtN(totals.futureRemit)}
  Vendors:       ${totals.vendorCount}
  Documents:     ${totals.docCount}

AGING BUCKETS:
${buckStr}

DIMENSION BREAKDOWN:
${dimStr}

TOP VENDORS BY OVERDUE:
${topStr}`;
}

// ── Router factory ────────────────────────────────────────────────────────────
export function createVendorPaymentAgingRouter(deps) {
  const {
    requireAuth, getActiveSap, getNamespace,
    gptChatComplete, azureMessagesCreate, AI_PROVIDER, USE_AI,
  } = deps;

  const router = Router();
  const _aiDeps = () => USE_AI ? { AI_PROVIDER, gptChatComplete, azureMessagesCreate } : null;

  // ── POST /analyze ─────────────────────────────────────────────────────────
  router.post('/analyze', requireAuth, async (req, res) => {
    try {
      const sap = getActiveSap();
      // skipInsight: background pre-load (no AI call)
      const { agingDate = today(), bucketSize = 30, filters = {}, skipInsight = false } = req.body;
      const size = Math.max(1, parseInt(bucketSize) || 30);

      const allRows  = normalizeRows(await callAgingView(sap, getNamespace, agingDate, size), agingDate, size);
      const filtered = applyFilters(allRows, filters);
      const vendors  = aggregateByVendor(filtered);
      const buckets  = aggregateByBucket(filtered, size);
      const dimBreak = aggregateByDimension(filtered);
      const totals   = calcTotals(filtered);
      const options  = getFilterOptions(allRows, size);
      // Extra breakdowns for charts
      const byDocType  = aggregateBy(filtered, r => r.DocumentTypeDisplayName || r.DocumentTypeCode, 'docType').sort((a, b) => b.balanceDue - a.balanceDue);
      const byDueMonth = aggregateBy(filtered, dueMonth, 'month').sort((a, b) => a.month.localeCompare(b.month));
      const byCurrency = aggregateBy(filtered, r => r.BusinessPartnerCurrency, 'currency').sort((a, b) => b.balanceDue - a.balanceDue);

      let aiInsight = '';
      if (USE_AI && !skipInsight && vendors.length > 0) {
        const ctx = buildAiContext(vendors, totals, buckets, dimBreak, { agingDate, bucketSize });
        aiInsight = await callAI(
          _aiDeps(),
          [{ role: 'user', content: `Analyze this AP aging report and provide 3-4 key actionable insights:\n\n${ctx}` }],
          'You are an accounts payable analyst. Provide concise insights on vendor payment aging. Focus on overdue risk, cash flow impact, and recommended actions. Use markdown bullet points.',
          900,
        );
      }

      res.json({
        ok: true,
        vendors, buckets, dimBreakdown: dimBreak,
        totals, options, aiInsight,
        byDocType, byDueMonth, byCurrency,
        documents: toDocumentRows(filtered),
        params: { agingDate, bucketSize: size },
      });
    } catch (e) {
      console.error('[VPAging] /analyze error:', e.message);
      res.json({ ok: false, error: e.message });
    }
  });

  // ── POST /chat ────────────────────────────────────────────────────────────
  router.post('/chat', requireAuth, async (req, res) => {
    try {
      const { message, sessionId, agingContext } = req.body;
      const sid = sessionId || `vpa_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

      if (!_sessions.has(sid)) _sessions.set(sid, initSession());
      const sess = _sessions.get(sid);

      if (agingContext) sess.agingContext = agingContext;

      const userMsg = (message || '').trim();
      if (userMsg) sess.history.push({ role: 'user', content: userMsg });
      if (sess.history.length > 40) sess.history = sess.history.slice(-40);

      let reply = '';
      let quickReplies = [];

      if (!userMsg && sess.step === 'INIT') {
        reply = `## 📊 Vendor Payment Aging Agent\n\nI can help you analyze your **AP aging report** from SAP B1. I can:\n\n- Summarize overdue balances by aging bucket\n- Identify high-risk vendors with long outstanding amounts\n- Break down aging by dimension (Brand / Sub-Brand / Universal)\n- Filter by branch, document type, or vendor\n- Provide cash flow and payment risk insights\n\n**Set your filters above and click Analyze to get started.**`;
        quickReplies = ['Load today\'s aging', 'Show overdue vendors', 'Top 10 by overdue', 'Analyze by dimension'];
        sess.step = 'READY';
      } else if (sess.agingContext) {
        const systemPrompt = `You are an accounts payable aging analyst for SAP Business One.
Answer the user's question based on the vendor payment aging data below.
Use markdown tables for vendor lists. Format amounts with thousand separators.
Keep responses concise and actionable.

${sess.agingContext}`;

        reply = await callAI(_aiDeps(), sess.history.slice(-10), systemPrompt, 1200) ||
          'I couldn\'t answer that. Try "Show overdue vendors" or "What is the aging bucket breakdown?"';
        quickReplies = ['Top overdue vendors', 'Aging bucket summary', 'Vendors over 90 days', 'Cash flow risk', 'Filter by dimension'];
      } else {
        reply = 'I don\'t have aging data loaded yet. Please set the filters above and click **🔍 Analyze** to load the report, then I can answer your questions.';
        quickReplies = ['How do I load the report?', 'What filters are available?'];
        sess.step = 'NEEDS_DATA';
      }

      if (reply) sess.history.push({ role: 'assistant', content: reply });

      res.json({ ok: true, reply, quickReplies, sessionId: sid, step: sess.step });
    } catch (e) {
      console.error('[VPAging] /chat error:', e.message);
      res.json({ ok: false, error: e.message, reply: `⚠️ Error: ${e.message}`, quickReplies: [], sessionId: req.body?.sessionId });
    }
  });

  // ── GET /options ──────────────────────────────────────────────────────────
  // Returns available filter options without full data fetch
  router.get('/options', requireAuth, async (req, res) => {
    try {
      const sap = getActiveSap();
      const agingDate = req.query.date || today();
      const bucketSize = Math.max(1, parseInt(req.query.bucketSize || '30') || 30);

      const rows    = normalizeRows(await callAgingView(sap, getNamespace, agingDate, bucketSize), agingDate, bucketSize);
      const options = getFilterOptions(rows, bucketSize);
      res.json({ ok: true, options });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  return router;
}
