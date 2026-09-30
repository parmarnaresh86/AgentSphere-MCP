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
  if (filters.docType)     r = r.filter(x => x.DocumentTypeCode         === filters.docType);
  if (filters.branch)      r = r.filter(x => x.BranchName               === filters.branch);
  if (filters.dimension)   r = r.filter(x => x.BusinessPartnerGroupName === filters.dimension);
  if (filters.agingBucket) r = r.filter(x => x.AgingBucket              === filters.agingBucket);
  if (filters.onlyOverdue) r = r.filter(x => Number(x.OverdueLC || 0)   > 0);
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
  return Array.from(map.values()).sort((a, b) => b.overdue - a.overdue);
}

function aggregateByBucket(rows) {
  const map = new Map();
  for (const row of rows) {
    const bucket = row.AgingBucket || 'Unknown';
    if (!map.has(bucket)) {
      map.set(bucket, {
        bucket,
        balanceDue:  0,
        overdue:     0,
        futureRemit: 0,
        vendorSet:   new Set(),
        docCount:    0,
      });
    }
    const b = map.get(bucket);
    b.balanceDue  += Number(row.AgingBalanceDueLC || 0);
    b.overdue     += Number(row.OverdueLC         || 0);
    b.futureRemit += Number(row.FutureRemitLC     || 0);
    b.vendorSet.add(row.BusinessPartnerCode);
    b.docCount++;
  }
  return Array.from(map.values())
    .map(b => ({ ...b, vendorCount: b.vendorSet.size, vendorSet: undefined }))
    .sort((a, b) => b.balanceDue - a.balanceDue);
}

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

function getFilterOptions(rows) {
  return {
    docTypes:   [...new Set(rows.map(r => r.DocumentTypeCode        ).filter(Boolean))].sort(),
    branches:   [...new Set(rows.map(r => r.BranchName              ).filter(Boolean))].sort(),
    dimensions: [...new Set(rows.map(r => r.BusinessPartnerGroupName).filter(Boolean))].sort(),
    buckets:    [...new Set(rows.map(r => r.AgingBucket             ).filter(Boolean))].sort(),
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
      const { agingDate = today(), bucketSize = 30, filters = {} } = req.body;

      const allRows  = await callAgingView(sap, getNamespace, agingDate, Number(bucketSize));
      const filtered = applyFilters(allRows, filters);
      const vendors  = aggregateByVendor(filtered);
      const buckets  = aggregateByBucket(filtered);
      const dimBreak = aggregateByDimension(filtered);
      const totals   = calcTotals(filtered);
      const options  = getFilterOptions(allRows);

      let aiInsight = '';
      if (USE_AI && vendors.length > 0) {
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
        documents: toDocumentRows(filtered),
        params: { agingDate, bucketSize },
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
      const bucketSize = parseInt(req.query.bucketSize || '30');

      const rows    = await callAgingView(sap, getNamespace, agingDate, bucketSize);
      const options = getFilterOptions(rows);
      res.json({ ok: true, options });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  return router;
}
