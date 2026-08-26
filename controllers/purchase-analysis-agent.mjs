/**
 * Purchase Analysis Dashboard Agent
 * Mounted at /api/purchase-analysis by chat-server.mjs
 *
 * Covers 8 HANA views under sap.me0925sadp.ap.case:
 *   PurchaseAnalysisQuery, PurchaseReturnStatisticsQuery,
 *   AveragePurchasingPriceQuery, OnTimeReceiptStatisticsQuery,
 *   PurchaseAnalysisByDocumentQuery, PurchaseOrderFulfillmentCycleTimeQuery,
 *   PurchaseOrderReceivedOnTimeQuery, VendorBalanceAnalysisQuery
 */
import { Router } from 'express';

const _sessions = new Map();

// ── View registry ─────────────────────────────────────────────────────────────
const VIEWS = {
  purchase:     { path: 'PurchaseAnalysisQuery',                 dateField: 'PostingDate', hasDims: true  },
  returns:      { path: 'PurchaseReturnStatisticsQuery',         dateField: 'PostingDate', hasDims: true  },
  avgprice:     { path: 'AveragePurchasingPriceQuery',           dateField: 'PostingDate', hasDims: true  },
  ontime:       { path: 'OnTimeReceiptStatisticsQuery',          dateField: 'PostingDate', hasDims: false },
  bydoc:        { path: 'PurchaseAnalysisByDocumentQuery',       dateField: 'PostingDate', hasDims: false },
  cycletime:    { path: 'PurchaseOrderFulfillmentCycleTimeQuery',dateField: 'PostingDate', hasDims: false },
  receivedontime:{ path: 'PurchaseOrderReceivedOnTimeQuery',     dateField: 'PostingDate', hasDims: false },
  vendorbalance: { path: 'VendorBalanceAnalysisQuery',           dateField: null,          hasDims: false },
};

// ── Measures per view ─────────────────────────────────────────────────────────
const VIEW_MEASURES = {
  purchase:      ['NetPurchaseAmountLC','QuantityInInventoryUoM','NetPurchaseAmountSC'],
  returns:       ['ReceivedQtyInInventoryUoM','QtyOfReturnFromCurrentGRPO','ReceivedAmountLC','AmtOfReturnFromCurrentGRPOLC','ReturnedQuantityInInventoryUoM','ReturnedAmountLC'],
  avgprice:      ['PurchaseAmountLC','PurchaseQuantityInInventoryUoM','AverageUnitPriceLC'],
  ontime:        ['AdvanceDays','DelayedDays','NumberOfPurchaseOrder','AverageReceiptVarianceDays'],
  bydoc:         ['NetPurchaseAmountLC','AppliedNetPurchaseAmountLC','OpenAmountLC'],
  cycletime:     ['PurchaseOrderFulfillmentDays','AveragePOFulfillmentDays','NumberOfPurchaseOrder'],
  receivedontime:['AmountOfPOReceivedOnTimeLC','TotalPurchaseOrderAmountLC','OnTimeReceiptRateByAmount','NumberOfPOReceivedOnTime','OnTimeReceiptRateByNumber','NumberOfPurchaseOrder'],
  vendorbalance: ['OpenPurchaseOrderBalanceLC','OpenGRPOBalanceLC','AccountPayableBalanceLC'],
};

function today() { return new Date().toISOString().slice(0, 10); }
function firstOfYear() { return `${new Date().getFullYear()}-01-01`; }

function fmtN(n, d = 0) {
  if (n == null || isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function initSession() {
  return { step: 'INIT', history: [], dataContext: null, activeView: 'purchase' };
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

// ── HANA direct: query the view's plain-schema copy, bypassing the Service
// Layer's /sml.svc/ proxy entirely — see sales-analysis-agent.mjs for the full
// rationale (some of these calc views can be invalidated independently of the
// Service Layer, so this only helps for the ones actually deployed as a
// working plain view in the company schema; falls back to Service Layer on
// ANY failure, so unmirrored views keep working exactly as before).
async function fetchViewHana(dbDeps, viewKey, fromDate, toDate) {
  const { getActiveConfig, getActiveType, tableRef, executeSQL } = dbDeps;
  const cfg = VIEWS[viewKey];
  const c   = getActiveConfig();
  const isHana = getActiveType() === 'hana';
  const filters = [];
  if (cfg.dateField && fromDate) filters.push(`"${cfg.dateField}" >= '${fromDate}'`);
  if (cfg.dateField && toDate)   filters.push(`"${cfg.dateField}" <= '${toDate}'`);
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const sql = isHana
    ? `SELECT * FROM ${tableRef(cfg.path, c)} ${where} LIMIT 10000`
    : `SELECT TOP 10000 * FROM ${tableRef(cfg.path, c)} ${where}`;
  return executeSQL(sql);
}

// ── Paginated HANA view fetch (Service Layer) ─────────────────────────────────
async function fetchView(sap, dbDeps, getNamespace, viewKey, fromDate, toDate, extraFilter) {
  if (dbDeps?.isConnected?.()) {
    try {
      return await fetchViewHana(dbDeps, viewKey, fromDate, toDate);
    } catch (e) {
      console.warn(`[PurchaseAnalysis] HANA direct view "${viewKey}" failed, falling back to Service Layer:`, e.message);
    }
  }

  const ns = await getNamespace();
  if (!ns) throw new Error('HANA namespace unavailable');

  const cfg = VIEWS[viewKey];
  if (!cfg) throw new Error(`Unknown view: ${viewKey}`);

  const basePath = `/sml.svc/${ns}.ap.case/${cfg.path}`;

  const filters = [];
  if (cfg.dateField && fromDate) filters.push(`${cfg.dateField} ge '${fromDate}'`);
  if (cfg.dateField && toDate)   filters.push(`${cfg.dateField} le '${toDate}'`);
  if (extraFilter)               filters.push(extraFilter);

  const params = {};
  if (filters.length) params.$filter = filters.join(' and ');

  const PAGE = 2000;
  let skip = 0;
  const all = [];

  while (true) {
    let batch;
    try {
      const r = await sap.get(basePath, { ...params, $top: PAGE, $skip: skip });
      batch = Array.isArray(r.value) ? r.value : [];
    } catch (e) {
      console.warn(`[PurchaseAnalysis] fetch ${viewKey} skip=${skip}:`, e.message);
      break;
    }
    all.push(...batch);
    if (batch.length < PAGE || all.length >= 10000) break;
    skip += PAGE;
  }

  return all;
}

// ── Client-side filters ───────────────────────────────────────────────────────
function applyFilters(rows, f = {}) {
  let r = rows;
  if (f.vendor)    { const q = f.vendor.toLowerCase();    r = r.filter(x => (x.BusinessPartnerCode||'').toLowerCase().includes(q) || (x.BusinessPartnerName||'').toLowerCase().includes(q)); }
  if (f.item)      { const q = f.item.toLowerCase();      r = r.filter(x => (x.ItemCode||'').toLowerCase().includes(q) || (x.ItemDescription||'').toLowerCase().includes(q)); }
  if (f.brand)     r = r.filter(x => (x.CogsOcrCod || x.Brand)     === f.brand);
  if (f.subBrand)  r = r.filter(x => (x.CogsOcrCo2 || x.SubBrand)  === f.subBrand);
  if (f.universe)  r = r.filter(x => (x.CogsOcrCo4 || x.Universe)  === f.universe);
  if (f.budget)    r = r.filter(x => (x.CogsOcrCo3 || x.Budget)    === f.budget);
  if (f.branch)    r = r.filter(x => x.BranchCode === f.branch || x.BranchName === f.branch);
  if (f.docType)   r = r.filter(x => x.DocumentTypeCode === f.docType);
  if (f.itemGroup) r = r.filter(x => x.ItemGroup === f.itemGroup);
  return r;
}

// ── Aggregations ──────────────────────────────────────────────────────────────
function aggregateBy(rows, groupField, measures) {
  const map = new Map();
  for (const row of rows) {
    const key = row[groupField] || 'Unknown';
    if (!map.has(key)) {
      const entry = { _key: key, _label: row[groupField] || '—', _count: 0 };
      measures.forEach(m => entry[m] = 0);
      map.set(key, entry);
    }
    const e = map.get(key);
    e._count++;
    measures.forEach(m => { if (row[m] != null) e[m] += Number(row[m] || 0); });
  }
  return Array.from(map.values());
}

function aggregateByPeriod(rows, periodField, measures) {
  return aggregateBy(rows, periodField, measures)
    .sort((a, b) => String(a._key).localeCompare(String(b._key)));
}

function getFilterOptions(rows, viewKey) {
  const opts = {
    vendors:    [...new Set(rows.map(r => r.BusinessPartnerCode).filter(Boolean))].sort(),
    branches:   [...new Set(rows.map(r => r.BranchName).filter(Boolean))].sort(),
    brands:     [...new Set(rows.map(r => r.CogsOcrCod || r.Brand).filter(Boolean))].sort(),
    subBrands:  [...new Set(rows.map(r => r.CogsOcrCo2 || r.SubBrand).filter(Boolean))].sort(),
    universes:  [...new Set(rows.map(r => r.CogsOcrCo4 || r.Universe).filter(Boolean))].sort(),
    budgets:    [...new Set(rows.map(r => r.CogsOcrCo3 || r.Budget).filter(Boolean))].sort(),
    docTypes:   [...new Set(rows.map(r => r.DocumentTypeCode).filter(Boolean))].sort(),
    itemGroups: [...new Set(rows.map(r => r.ItemGroup).filter(Boolean))].sort(),
    periods:    [...new Set(rows.map(r => r.PostingYearAndMonth).filter(Boolean))].sort(),
  };
  if (!VIEWS[viewKey]?.hasDims) { delete opts.brands; delete opts.subBrands; delete opts.universes; delete opts.budgets; }
  return opts;
}

// ── Totals summary ────────────────────────────────────────────────────────────
function calcTotals(rows, measures) {
  const t = { rowCount: rows.length };
  measures.forEach(m => { t[m] = rows.reduce((s, r) => s + Number(r[m] || 0), 0); });
  return t;
}

// ── AI data context builder ───────────────────────────────────────────────────
function buildDataContext(viewKey, rows, totals, byVendor, byPeriod, params) {
  const viewNames = {
    purchase: 'Purchase Analysis', returns: 'Purchase Returns', avgprice: 'Average Purchasing Price',
    ontime: 'On-Time Receipt Statistics', bydoc: 'Purchase Analysis by Document',
    cycletime: 'PO Fulfillment Cycle Time', receivedontime: 'PO Received On Time',
    vendorbalance: 'Vendor Balance Analysis',
  };
  const measures = VIEW_MEASURES[viewKey] || [];
  const topVendors = byVendor.slice(0, 10).map((v, i) => {
    const vals = measures.map(m => `${m}: ${fmtN(v[m])}`).join(', ');
    return `  ${i+1}. ${v._label} — ${vals}`;
  }).join('\n');
  const periodSummary = byPeriod.slice(-12).map(p => {
    const vals = measures.slice(0, 2).map(m => `${m}: ${fmtN(p[m])}`).join(', ');
    return `  ${p._key}: ${vals}`;
  }).join('\n');
  const totalVals = measures.map(m => `${m}: ${fmtN(totals[m])}`).join(', ');

  return `PURCHASE ANALYSIS DASHBOARD — View: ${viewNames[viewKey] || viewKey}
Period: ${params.fromDate} to ${params.toDate}
Total Rows: ${rows.length} | Vendors: ${new Set(rows.map(r => r.BusinessPartnerCode)).size}

TOTALS: ${totalVals}

TOP VENDORS:
${topVendors}

MONTHLY TREND (recent 12):
${periodSummary}`;
}

// ── Router factory ────────────────────────────────────────────────────────────
export function createPurchaseAnalysisRouter(deps) {
  const {
    requireAuth, getActiveSap, getNamespace, gptChatComplete, azureMessagesCreate, AI_PROVIDER, USE_AI,
    isConnected, getActiveType, getActiveConfig, executeSQL, tableRef,
  } = deps;
  const router  = Router();
  const _aiDeps = () => USE_AI ? { AI_PROVIDER, gptChatComplete, azureMessagesCreate } : null;
  const _dbDeps = isConnected ? { isConnected, getActiveType, getActiveConfig, executeSQL, tableRef } : null;

  // ── POST /analyze — fetch & aggregate a view ─────────────────────────────
  router.post('/analyze', requireAuth, async (req, res) => {
    try {
      const sap = getActiveSap();
      const {
        view      = 'purchase',
        fromDate  = firstOfYear(),
        toDate    = today(),
        filters   = {},
        groupBy   = 'vendor',
      } = req.body;

      if (!VIEWS[view]) return res.json({ ok: false, error: `Unknown view: ${view}` });

      const allRows  = await fetchView(sap, _dbDeps, getNamespace, view, fromDate, toDate);
      const filtered = applyFilters(allRows, filters);
      const measures = VIEW_MEASURES[view] || [];
      const totals   = calcTotals(filtered, measures);
      const options  = getFilterOptions(allRows, view);

      // Aggregations
      const byVendor = aggregateBy(filtered, 'BusinessPartnerCode', measures)
        .map(v => ({ ...v, vendorName: filtered.find(r => r.BusinessPartnerCode === v._key)?.BusinessPartnerName || v._key }))
        .sort((a, b) => (b[measures[0]] || 0) - (a[measures[0]] || 0));

      const byItem = filtered[0]?.ItemCode !== undefined
        ? aggregateBy(filtered, 'ItemCode', measures)
            .map(v => ({ ...v, itemName: filtered.find(r => r.ItemCode === v._key)?.ItemDescription || v._key }))
            .sort((a, b) => (b[measures[0]] || 0) - (a[measures[0]] || 0))
        : [];

      const byBrand   = VIEWS[view].hasDims ? aggregateBy(filtered, 'CogsOcrCod', measures) : [];
      const bySubBrand = VIEWS[view].hasDims ? aggregateBy(filtered, 'CogsOcrCo2', measures) : [];
      const byUniverse = VIEWS[view].hasDims ? aggregateBy(filtered, 'CogsOcrCo4', measures) : [];
      const byBranch   = aggregateBy(filtered, 'BranchName', measures);
      const byPeriod   = aggregateByPeriod(filtered, 'PostingYearAndMonth', measures);
      const byDocType  = aggregateBy(filtered, 'DocumentTypeCode', measures);

      let aiInsight = '';
      if (USE_AI && filtered.length > 0) {
        const ctx = buildDataContext(view, filtered, totals, byVendor, byPeriod, { fromDate, toDate });
        aiInsight = await callAI(
          _aiDeps(),
          [{ role: 'user', content: `Analyze this purchase data and give 3-4 actionable insights:\n\n${ctx}` }],
          'You are a procurement analyst. Give concise, actionable insights. Focus on spend trends, vendor performance, and cost opportunities. Use markdown bullets.',
          800,
        );
      }

      res.json({
        ok: true, view, measures,
        totals, options, aiInsight,
        byVendor: byVendor.slice(0, 50),
        byItem:   byItem.slice(0, 50),
        byBrand, bySubBrand, byUniverse, byBranch,
        byPeriod, byDocType,
        rowCount: filtered.length,
        params: { fromDate, toDate, view },
      });
    } catch (e) {
      console.error('[PurchaseAnalysis] /analyze error:', e.message);
      res.json({ ok: false, error: e.message });
    }
  });

  // ── POST /chat — AI conversational interface ─────────────────────────────
  router.post('/chat', requireAuth, async (req, res) => {
    try {
      const { message, sessionId, dataContext, activeView } = req.body;
      const sid = sessionId || `pa_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

      if (!_sessions.has(sid)) _sessions.set(sid, initSession());
      const sess = _sessions.get(sid);
      if (dataContext) sess.dataContext = dataContext;
      if (activeView)  sess.activeView  = activeView;

      const userMsg = (message || '').trim();
      if (userMsg) sess.history.push({ role: 'user', content: userMsg });
      if (sess.history.length > 40) sess.history = sess.history.slice(-40);

      const viewLabels = {
        purchase:'Purchase Analysis',returns:'Returns',avgprice:'Avg Price',
        ontime:'On-Time Receipt',bydoc:'By Document',cycletime:'Cycle Time',
        receivedontime:'Received On Time',vendorbalance:'Vendor Balance',
      };

      let reply = '', quickReplies = [];

      if (!userMsg && sess.step === 'INIT') {
        reply = `## 🛒 Purchase Analysis Dashboard\n\nI can analyze your procurement data across **8 analytical views**:\n\n| View | Purpose |\n|---|---|\n| Purchase Analysis | Spend by vendor, item, brand, period |\n| Returns | Return rates and quantities |\n| Avg Price | Price trends and variance |\n| On-Time Receipt | Supplier delivery performance |\n| By Document | PO/invoice document analysis |\n| Cycle Time | PO fulfillment duration |\n| Received On Time | On-time delivery rates |\n| Vendor Balance | Open PO, GRPO, AP balances |\n\n**Select a tab and click Analyze to load data.** Then ask me anything.`;
        quickReplies = ['Load Purchase Analysis', 'Show top vendors', 'Best performing vendors', 'Analyze by brand'];
        sess.step = 'READY';
      } else if (sess.dataContext) {
        const viewLabel = viewLabels[sess.activeView || 'purchase'] || 'Purchase';
        const systemPrompt = `You are a procurement intelligence analyst for SAP Business One.
You have access to the ${viewLabel} report data below. Answer user questions analytically.
- Use markdown tables when showing vendor/item lists
- Generate OData query examples if asked (format as code blocks)
- The custom dimensions are: Brand (CogsOcrCod), SubBrand (CogsOcrCo2), Budget (CogsOcrCo3), Universe (CogsOcrCo4), CogsCustomer (CogsOcrCo5)
- Format currency amounts with commas
- Be concise and actionable

${sess.dataContext}`;

        reply = await callAI(_aiDeps(), sess.history.slice(-10), systemPrompt, 1400) ||
          'Please load the analysis data first by selecting a tab and clicking Analyze.';
        quickReplies = ['Top 10 vendors by spend','Monthly trend','Brand breakdown','On-time rate','Return analysis','Show OData query'];
      } else {
        reply = 'I don\'t have data loaded yet. Please **select a tab** and click **🔍 Analyze** to load the report. Then I can answer your procurement questions.';
        quickReplies = ['How to load data?', 'What views are available?'];
      }

      if (reply) sess.history.push({ role: 'assistant', content: reply });
      res.json({ ok: true, reply, quickReplies, sessionId: sid, step: sess.step });
    } catch (e) {
      console.error('[PurchaseAnalysis] /chat error:', e.message);
      res.json({ ok: false, error: e.message, reply: `⚠️ ${e.message}`, quickReplies: [], sessionId: req.body?.sessionId });
    }
  });

  return router;
}
