/**
 * Sales Analysis Dashboard Agent
 * Mounted at /api/sales-analysis by chat-server.mjs
 *
 * AR HANA views covered (sap.me0925sadp.ar.case):
 *   SalesAnalysisQuery, AverageSellingPriceQuery, BackOrderStatusQuery,
 *   CustomerOpenBalanceVSCreditLimitQuery, OnTimeDeliveryStatisticsQuery,
 *   SalesAnalysisByDocumentQuery
 * (Finance Report / VW_AI_FINANCE_REPORT removed — that view doesn't exist
 * on this deployment.)
 *
 * Brand dimensions: CogsOcrCod→Brand, CogsOcrCo2→SubBrand,
 *   CogsOcrCo3→Budget, CogsOcrCo4→Universe, CogsOcrCo5→CogsCustomer
 */
import { Router } from 'express';

const _sessions = new Map();

// ── View registry ─────────────────────────────────────────────────────────────
const VIEWS = {
  sales:       { path: 'SalesAnalysisQuery',                    area: 'ar', dateField: 'PostingDate', hasDims: true  },
  avgprice:    { path: 'AverageSellingPriceQuery',              area: 'ar', dateField: 'PostingDate', hasDims: true  },
  backorder:   { path: 'BackOrderStatusQuery',                  area: 'ar', dateField: 'PostingDate', hasDims: true  },
  custbalance: { path: 'CustomerOpenBalanceVSCreditLimitQuery', area: 'ar', dateField: null,          hasDims: false },
  ontime:      { path: 'OnTimeDeliveryStatisticsQuery',         area: 'ar', dateField: 'PostingDate', hasDims: true  },
  bydoc:       { path: 'SalesAnalysisByDocumentQuery',          area: 'ar', dateField: 'PostingDate', hasDims: false },
};

const VIEW_MEASURES = {
  sales:       ['NetSalesAmountLC','GrossProfitLC','QuantityInInventoryUoM','GrossProfitMarginBySalesAmount','GrossProfitMarginByBaseAmount'],
  avgprice:    ['NetSalesAmountLC','SalesQuantityInInventoryUoM','AverageNetUnitPriceLC','AverageItemCostLC','GrossProfitPercentage'],
  backorder:   ['OrderedQuantityInInventoryUoM','DeliveredQuantityInInvUoM','OpenQuantityInInventoryUoM','BackOrderPercentage'],
  custbalance: ['OpenSalesOrderBalance','OpenDeliveryBalance','AccountReceivableBalance','CustomerBalanceTotal','CustomerCreditLimit'],
  ontime:      ['NumberOfSalesOrder','DelayedDays','AdvanceDays','AverageDeliveryVarianceDays'],
  bydoc:       ['NetSalesAmountLC','AppliedNetSalesAmountLC','OpenAmountLC','NetSalesAmountSC'],
};

function today()       { return new Date().toISOString().slice(0, 10); }
function firstOfYear() { return `${new Date().getFullYear()}-01-01`; }
function fmtN(n, d=0)  { if (n==null||isNaN(Number(n))) return '—'; return Number(n).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d}); }

function initSession() {
  return { step:'INIT', history:[], dataContext:null, activeView:'sales' };
}

// ── AI helper ─────────────────────────────────────────────────────────────────
async function callAI(aiDeps, messages, systemPrompt, maxTokens=2048) {
  if (!aiDeps) return '';
  const { AI_PROVIDER, gptChatComplete, azureMessagesCreate } = aiDeps;
  if (AI_PROVIDER==='gpt' && process.env.AZURE_GPT_ENDPOINT) {
    const msgs = systemPrompt ? [{role:'system',content:systemPrompt},...messages] : messages;
    const r = await gptChatComplete({messages:msgs,max_tokens:maxTokens});
    return r.choices?.[0]?.message?.content || '';
  }
  if (AI_PROVIDER==='azure' && process.env.AZURE_OPENAI_API_KEY) {
    const model = process.env.AZURE_CLAUDE_MODEL || 'claude-3-5-sonnet-20241022';
    const msgs = systemPrompt ? [{role:'system',content:systemPrompt},...messages] : messages;
    const r = await azureMessagesCreate({model,messages:msgs,max_tokens:maxTokens});
    return r.content?.[0]?.text || r.choices?.[0]?.message?.content || '';
  }
  if (process.env.ANTHROPIC_API_KEY) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({apiKey:process.env.ANTHROPIC_API_KEY});
    const resp = await client.messages.create({
      model:'claude-sonnet-4-6', max_tokens:maxTokens,
      system:systemPrompt||undefined, messages,
    });
    return resp.content?.[0]?.text || '';
  }
  return '';
}

// ── HANA direct: query the semantic-layer calculation view straight over SQL,
// bypassing the Service Layer's /sml.svc/ OData proxy entirely. These views
// (SalesAnalysisQuery, AverageSellingPriceQuery, etc.) are NOT plain schema
// objects — they only exist under the "_SYS_BIC" catalog package as
// "{namespace}.ar.case/{ViewName}" (confirmed live on STTL_SD via direct SQL).
// Going through Service Layer's /sml.svc/ OData proxy instead caps out at its
// configured page size (as low as 10-20 rows) because SapDirectClient sends no
// Prefer:odata.maxpagesize header — querying the view directly sidesteps that
// entirely. VW_AI_FINANCE_REPORT (`plainView`) is a genuine custom plain-schema
// view, not a semantic-layer object, so it still goes through tableRef().
// Falls back to Service Layer on any failure so it degrades gracefully.
async function fetchViewHana(dbDeps, getNamespace, viewKey, fromDate, toDate) {
  const { getActiveConfig, tableRef, executeSQL } = dbDeps;
  const cfg = VIEWS[viewKey];
  const filters = [];
  if (cfg.dateField && fromDate) filters.push(`"${cfg.dateField}" >= '${fromDate}'`);
  if (cfg.dateField && toDate)   filters.push(`"${cfg.dateField}" <= '${toDate}'`);
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  if (cfg.plainView) {
    const c = getActiveConfig();
    const sql = `SELECT * FROM ${tableRef(cfg.path, c)} ${where} LIMIT 500000`;
    return executeSQL(sql);
  }

  const ns = await getNamespace();
  if (!ns) throw new Error('HANA namespace unavailable for direct view query');
  const viewRef = `"_SYS_BIC"."${ns}.${cfg.area || 'ar'}.case/${cfg.path}"`;
  const sql = `SELECT * FROM ${viewRef} ${where} LIMIT 500000`;
  return executeSQL(sql);
}

// ── Paginated HANA view fetch (Service Layer) ─────────────────────────────────
// SAP B1 SML views are accessed directly at /sml.svc/{ViewName} — no namespace prefix needed.
// (Confirmed working in chat-server.mjs line 624 for SalesAnalysisQuery)
async function fetchView(sap, dbDeps, getNamespace, viewKey, fromDate, toDate) {
  if (dbDeps?.isConnected?.()) {
    try {
      const rows = await fetchViewHana(dbDeps, getNamespace, viewKey, fromDate, toDate);
      return rows;
    } catch (e) {
      console.warn(`[SalesAnalysis] HANA direct view "${viewKey}" failed, falling back to Service Layer:`, e.message);
    }
  }

  const cfg = VIEWS[viewKey];
  if (!cfg) throw new Error(`Unknown view: ${viewKey}`);

  const fullPath = `/sml.svc/${cfg.path}`;
  const filters  = [];
  if (cfg.dateField && fromDate) filters.push(`${cfg.dateField} ge '${fromDate}'`);
  if (cfg.dateField && toDate)   filters.push(`${cfg.dateField} le '${toDate}'`);

  const params = {};
  if (filters.length) params.$filter = filters.join(' and ');

  const PAGE = 2000;
  let skip = 0;
  const all = [];

  while (true) {
    let batch;
    try {
      const r = await sap.get(fullPath, { ...params, $top: PAGE, $skip: skip });
      batch = Array.isArray(r.value) ? r.value : [];
    } catch (e) {
      if (skip === 0) {
        // First page failed — surface the real error instead of returning empty data
        throw new Error(`HANA view "${cfg.path}" not accessible: ${e.message}`);
      }
      console.warn(`[SalesAnalysis] fetch ${viewKey} skip=${skip}:`, e.message);
      break;
    }
    all.push(...batch);
    if (batch.length < PAGE || all.length >= 500000) break;
    skip += PAGE;
  }

  return all;
}

// ── Get brand/dim value (handles both raw CogsOcrCod and aliased Brand) ───────
function getDim(row, key) {
  const aliases = {
    brand:       ['CogsOcrCod','Brand'],
    subBrand:    ['CogsOcrCo2','SubBrand'],
    universe:    ['CogsOcrCo4','Universe'],
    budget:      ['CogsOcrCo3','Budget'],
    cogsCustomer:['CogsOcrCo5','CogsCustomer'],
  };
  for (const f of (aliases[key]||[key])) {
    if (row[f] != null && row[f] !== '') return row[f];
  }
  return null;
}

// ── Client-side filters ───────────────────────────────────────────────────────
function applyFilters(rows, f={}) {
  let r = rows;
  if (f.customer)    { const q=f.customer.toLowerCase();    r=r.filter(x=>(x.BusinessPartnerCode||'').toLowerCase().includes(q)||(x.BusinessPartnerName||'').toLowerCase().includes(q)); }
  if (f.item)        { const q=f.item.toLowerCase();        r=r.filter(x=>(x.ItemCode||'').toLowerCase().includes(q)||(x.ItemDescription||'').toLowerCase().includes(q)); }
  if (f.salesPerson) { const q=f.salesPerson.toLowerCase(); r=r.filter(x=>(x.SalesEmployeeOrBuyerName||'').toLowerCase().includes(q)); }
  if (f.brand)       r=r.filter(x=>getDim(x,'brand')===f.brand);
  if (f.subBrand)    r=r.filter(x=>getDim(x,'subBrand')===f.subBrand);
  if (f.universe)    r=r.filter(x=>getDim(x,'universe')===f.universe);
  if (f.budget)      r=r.filter(x=>getDim(x,'budget')===f.budget);
  if (f.branch)      r=r.filter(x=>x.BranchCode===f.branch||x.BranchName===f.branch);
  if (f.territory)   r=r.filter(x=>x.TerritoryName===f.territory||x.BusinessPartnerTerritory===f.territory||x.Territory===f.territory);
  if (f.itemGroup)   r=r.filter(x=>x.ItemGroup===f.itemGroup);
  if (f.docType)     r=r.filter(x=>x.DocumentTypeCode===f.docType);
  return r;
}

// ── Aggregations ──────────────────────────────────────────────────────────────
function aggregateBy(rows, groupField, measures, labelField) {
  const map = new Map();
  for (const row of rows) {
    const key = row[groupField] || 'Unknown';
    if (!map.has(key)) {
      const e = { _key:key, _label:(labelField?row[labelField]:null)||key, _count:0 };
      measures.forEach(m => e[m]=0);
      map.set(key, e);
    }
    const e = map.get(key);
    e._count++;
    measures.forEach(m => { if (row[m]!=null) e[m]+=Number(row[m]||0); });
  }
  return Array.from(map.values());
}

function aggregateByDim(rows, dimKey, measures) {
  const map = new Map();
  for (const row of rows) {
    const key = getDim(row, dimKey) || 'Unassigned';
    if (!map.has(key)) {
      const e = { _key:key, _label:key, _count:0 };
      measures.forEach(m => e[m]=0);
      map.set(key, e);
    }
    const e = map.get(key);
    e._count++;
    measures.forEach(m => { if (row[m]!=null) e[m]+=Number(row[m]||0); });
  }
  return Array.from(map.values());
}

function getFilterOptions(rows, viewKey) {
  const cfg = VIEWS[viewKey];
  const hasDims = cfg?.hasDims;
  const opts = {
    customers:   [...new Set(rows.map(r=>r.BusinessPartnerCode).filter(Boolean))].sort(),
    branches:    [...new Set(rows.map(r=>r.BranchName).filter(Boolean))].sort(),
    territories: [...new Set(rows.map(r=>r.TerritoryName||r.BusinessPartnerTerritory||r.Territory).filter(Boolean))].sort(),
    itemGroups:  [...new Set(rows.map(r=>r.ItemGroup).filter(Boolean))].sort(),
    docTypes:    [...new Set(rows.map(r=>r.DocumentTypeCode).filter(Boolean))].sort(),
    periods:     [...new Set(rows.map(r=>r.PostingYearAndMonth).filter(Boolean))].sort(),
    salesPersons:[...new Set(rows.map(r=>r.SalesEmployeeOrBuyerName).filter(Boolean))].sort(),
  };
  if (hasDims) {
    opts.brands     = [...new Set(rows.map(r=>getDim(r,'brand')).filter(Boolean))].sort();
    opts.subBrands  = [...new Set(rows.map(r=>getDim(r,'subBrand')).filter(Boolean))].sort();
    opts.universes  = [...new Set(rows.map(r=>getDim(r,'universe')).filter(Boolean))].sort();
    opts.budgets    = [...new Set(rows.map(r=>getDim(r,'budget')).filter(Boolean))].sort();
  }
  return opts;
}

function calcTotals(rows, measures) {
  const t = { rowCount:rows.length };
  measures.forEach(m => { t[m]=rows.reduce((s,r)=>s+Number(r[m]||0),0); });
  t.customers = new Set(rows.map(r=>r.BusinessPartnerCode||r.BPCode).filter(Boolean)).size;
  return t;
}

// ── AI context ────────────────────────────────────────────────────────────────
function buildDataContext(viewKey, rows, totals, byCustomer, byPeriod, byBrand, params) {
  const VIEW_LABELS = {
    sales:'Sales Analysis',avgprice:'Average Selling Price',backorder:'Back Order Status',
    custbalance:'Customer Balance vs Credit Limit',ontime:'On-Time Delivery',
    bydoc:'Sales Analysis By Document',
  };
  const measures = VIEW_MEASURES[viewKey]||[];
  const totalStr  = measures.slice(0,4).map(m=>`${m}: ${fmtN(totals[m])}`).join(', ');
  const topCust   = byCustomer.slice(0,10).map((c,i)=>`  ${i+1}. ${c._label||c._key}: ${measures.slice(0,2).map(m=>`${m} ${fmtN(c[m])}`).join(', ')}`).join('\n');
  const trendStr  = byPeriod.slice(-12).map(p=>`  ${p._key}: ${fmtN(p[measures[0]])}`).join('\n');
  const brandStr  = byBrand.slice(0,6).map(b=>`  ${b._label}: ${fmtN(b[measures[0]])}`).join('\n');

  return `SALES ANALYSIS DASHBOARD — View: ${VIEW_LABELS[viewKey]||viewKey}
Period: ${params.fromDate} to ${params.toDate}
Rows: ${rows.length} | Customers: ${totals.customers}

TOTALS: ${totalStr}

TOP CUSTOMERS:
${topCust}

PERIOD TREND (recent 12):
${trendStr}

BRAND BREAKDOWN:
${brandStr}`;
}

// ── Router factory ────────────────────────────────────────────────────────────
export function createSalesAnalysisRouter(deps) {
  const {
    requireAuth, getActiveSap, getNamespace, gptChatComplete, azureMessagesCreate, AI_PROVIDER, USE_AI,
    isConnected, getActiveType, getActiveConfig, executeSQL, tableRef,
  } = deps;
  const router  = Router();
  const _aiDeps = () => USE_AI ? { AI_PROVIDER, gptChatComplete, azureMessagesCreate } : null;
  const _dbDeps = isConnected ? { isConnected, getActiveType, getActiveConfig, executeSQL, tableRef } : null;

  // ── POST /analyze ─────────────────────────────────────────────────────────
  router.post('/analyze', requireAuth, async (req, res) => {
    try {
      const sap = getActiveSap();
      const { view='sales', fromDate=firstOfYear(), toDate=today(), filters={} } = req.body;

      if (!VIEWS[view]) return res.json({ ok:false, error:`Unknown view: ${view}` });

      const allRows  = await fetchView(sap, _dbDeps, getNamespace, view, fromDate, toDate);
      const filtered = applyFilters(allRows, filters);
      const measures = VIEW_MEASURES[view]||[];
      const totals   = calcTotals(filtered, measures);
      const options  = getFilterOptions(allRows, view);

      // Customer/BP aggregation
      const byCustomer = aggregateBy(filtered,'BusinessPartnerCode',measures,'BusinessPartnerName')
        .sort((a,b)=>(b[measures[0]]||0)-(a[measures[0]]||0));

      // Item aggregation (where applicable)
      const byItem = filtered[0]?.ItemCode != null
        ? aggregateBy(filtered,'ItemCode',measures,'ItemDescription')
            .sort((a,b)=>(b[measures[0]]||0)-(a[measures[0]]||0))
        : [];

      // Brand dimensions
      const byBrand     = VIEWS[view].hasDims ? aggregateByDim(filtered,'brand',    measures).sort((a,b)=>(b[measures[0]]||0)-(a[measures[0]]||0)) : [];
      const bySubBrand  = VIEWS[view].hasDims ? aggregateByDim(filtered,'subBrand', measures).sort((a,b)=>(b[measures[0]]||0)-(a[measures[0]]||0)) : [];
      const byUniverse  = VIEWS[view].hasDims ? aggregateByDim(filtered,'universe', measures).sort((a,b)=>(b[measures[0]]||0)-(a[measures[0]]||0)) : [];
      const byBudget    = VIEWS[view].hasDims ? aggregateByDim(filtered,'budget',   measures).sort((a,b)=>(b[measures[0]]||0)-(a[measures[0]]||0)) : [];

      // Territory, Branch, SalesPerson
      const byTerritory  = aggregateBy(filtered,'TerritoryName',measures).sort((a,b)=>(b[measures[0]]||0)-(a[measures[0]]||0));
      const byBranch     = aggregateBy(filtered,'BranchName',   measures).sort((a,b)=>(b[measures[0]]||0)-(a[measures[0]]||0));
      const bySalesPerson= aggregateBy(filtered,'SalesEmployeeOrBuyerName',measures).sort((a,b)=>(b[measures[0]]||0)-(a[measures[0]]||0));

      // Period trend
      const byPeriod = aggregateBy(filtered,'PostingYearAndMonth',measures)
        .sort((a,b)=>String(a._key).localeCompare(String(b._key)));

      let aiInsight = '';
      if (USE_AI && filtered.length > 0) {
        const ctx = buildDataContext(view, filtered, totals, byCustomer, byPeriod, byBrand, { fromDate, toDate });
        aiInsight = await callAI(
          _aiDeps(),
          [{ role:'user', content:`Analyze this sales data and give 3-4 actionable insights:\n\n${ctx}` }],
          'You are a sales & revenue analyst. Give concise actionable insights. Focus on revenue trends, gross profit, customer performance, and growth opportunities. Use markdown bullets.',
          900,
        );
      }

      res.json({
        ok:true, view, measures,
        totals, options, aiInsight,
        byCustomer: byCustomer.slice(0,50),
        byItem:     byItem.slice(0,50),
        byBrand, bySubBrand, byUniverse, byBudget,
        byTerritory, byBranch, bySalesPerson,
        byPeriod,
        rowCount: filtered.length,
        params: { fromDate, toDate, view },
      });
    } catch (e) {
      console.error('[SalesAnalysis] /analyze error:', e.message);
      res.json({ ok:false, error:e.message });
    }
  });

  // ── POST /chat ────────────────────────────────────────────────────────────
  router.post('/chat', requireAuth, async (req, res) => {
    try {
      const { message, sessionId, dataContext, activeView } = req.body;
      const sid = sessionId || `sa_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;

      if (!_sessions.has(sid)) _sessions.set(sid, initSession());
      const sess = _sessions.get(sid);
      if (dataContext)  sess.dataContext = dataContext;
      if (activeView)   sess.activeView  = activeView;

      const userMsg = (message||'').trim();
      if (userMsg) sess.history.push({ role:'user', content:userMsg });
      if (sess.history.length > 40) sess.history = sess.history.slice(-40);

      const VIEW_LABELS = {
        sales:'Sales Analysis',avgprice:'Avg Selling Price',backorder:'Back Order Status',
        custbalance:'Customer Balance',ontime:'On-Time Delivery',bydoc:'By Document',
      };

      let reply='', quickReplies=[];

      if (!userMsg && sess.step==='INIT') {
        reply = `## 📈 Sales Analysis Dashboard\n\nI can analyze your AR/Sales data across **6 analytical views**:\n\n| View | Key Metrics |\n|---|---|\n| **Sales Analysis** | Net Sales, Gross Profit, Margin, Qty |\n| **Avg Selling Price** | Avg Price, Item Cost, GP% |\n| **Back Order Status** | Ordered, Delivered, Open Qty |\n| **Customer Balance** | Open SO, AR Balance, Credit Limit |\n| **On-Time Delivery** | Delayed/Advance Days, SO Count |\n| **By Document** | Net Sales, Applied, Open Amounts |\n\nCustom dimensions: **Brand · Sub-Brand · Universe · Budget · CogsCustomer**\n\n**Select a tab and click Analyze to load data.**`;
        quickReplies = ['Load Sales Analysis','Top customers by revenue','Brand breakdown','Gross profit analysis','Customer credit risk'];
        sess.step = 'READY';
      } else if (sess.dataContext) {
        const vLabel = VIEW_LABELS[sess.activeView||'sales']||'Sales';
        const systemPrompt = `You are a sales & revenue intelligence analyst for SAP Business One.
You have access to the ${vLabel} report data below.

Key dimensions:
- Brand (CogsOcrCod) — product brand segmentation
- SubBrand (CogsOcrCo2) — sub-brand level
- Universe (CogsOcrCo4) — market universe
- Budget (CogsOcrCo3) — budget category
- CogsCustomer (CogsOcrCo5) — customer segment code

Instructions:
- Answer analytically with specific numbers from the data
- Use markdown tables for top-N lists
- When asked for OData queries, return them as \`\`\`http code blocks\`\`\`
- Format currency with commas, percentages with 1 decimal

${sess.dataContext}`;

        reply = await callAI(_aiDeps(), sess.history.slice(-10), systemPrompt, 1400) ||
          'Please load data first by selecting a tab and clicking Analyze.';
        quickReplies = ['Top 10 customers','Gross profit by brand','Monthly revenue trend','Back order risk','Show OData query','Credit limit breaches'];
      } else {
        reply = 'No data loaded yet. **Select a tab** above and click **🔍 Analyze** to load the report.';
        quickReplies = ['What views are available?','How to filter by brand?'];
      }

      if (reply) sess.history.push({ role:'assistant', content:reply });
      res.json({ ok:true, reply, quickReplies, sessionId:sid, step:sess.step });
    } catch (e) {
      console.error('[SalesAnalysis] /chat error:', e.message);
      res.json({ ok:false, error:e.message, reply:`⚠️ ${e.message}`, quickReplies:[], sessionId:req.body?.sessionId });
    }
  });

  return router;
}
