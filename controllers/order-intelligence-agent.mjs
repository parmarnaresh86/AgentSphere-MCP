/**
 * Order Intelligence Agent — backend controller
 * Mounted at /api/order-intelligence by chat-server.mjs
 *
 * Flags open sales orders at risk of stock shortages:
 *  1. Build stock map (onHand vs committed) for all inventory items
 *  2. Identify items where stock is insufficient to cover committed demand
 *  3. Fetch open SOs due within the scan horizon
 *  4. Resolve SO lines → cross-reference against short items
 *  5. Score and rank each order by shortage severity
 *  6. AI advisory summarising top risks and recommended actions
 */

import { Router } from 'express';

const _sessions = new Map();

const SCAN_HORIZON_DAYS = 60;   // SOs due within this window are checked
const MAX_SO_DETAIL     = 60;   // max orders to fetch full lines for

// ── AI helper ─────────────────────────────────────────────────────────────────
async function callAI(aiDeps, messages, systemPrompt, maxTokens = 1024) {
  if (!aiDeps) return '';
  const { AI_PROVIDER, gptChatComplete, azureMessagesCreate } = aiDeps;
  try {
    if (AI_PROVIDER === 'gpt' && process.env.AZURE_GPT_ENDPOINT) {
      const msgs = systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages] : messages;
      const r = await gptChatComplete({ messages: msgs, max_tokens: maxTokens });
      return r.choices?.[0]?.message?.content || '';
    }
    if (AI_PROVIDER === 'azure' && process.env.AZURE_OPENAI_API_KEY) {
      const model = process.env.AZURE_CLAUDE_MODEL || 'claude-3-5-sonnet-20241022';
      const msgs  = systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages] : messages;
      const r = await azureMessagesCreate({ model, messages: msgs, max_tokens: maxTokens });
      return r.content?.[0]?.text || r.choices?.[0]?.message?.content || '';
    }
    if (process.env.ANTHROPIC_API_KEY) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const ant  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const resp = await ant.messages.create({
        model: 'claude-sonnet-4-6', max_tokens: maxTokens,
        system: systemPrompt || undefined, messages,
      });
      return resp.content?.[0]?.text || '';
    }
  } catch (e) {
    console.warn('[OrderIntel/AI] call failed:', e.message);
  }
  return '';
}

// ── DB Direct (ODBC/HANA) reads, Service Layer fallback ─────────────────────
// Same pattern as the other supply-chain agents: resolve every logical field
// against the LIVE column list before building SQL — never guess — and fall
// back to Service Layer on any connection/mapping failure. HANA folds unquoted
// identifiers to uppercase, so identifiers are quoted on HANA only.
function qcol(name, isHana) { return isHana ? `"${name}"` : name; }

const OITM_STOCK_CANDIDATES = {
  itemCode: ['ItemCode'], itemName: ['ItemName'], onHand: ['OnHand'],
  committed: ['IsCommited'], onOrder: ['OnOrder'], invntItem: ['InvntItem'],
};
const ORDR_FIELD_CANDIDATES = {
  docEntry: ['DocEntry'], docNum: ['DocNum'], cardCode: ['CardCode'], cardName: ['CardName'],
  docDueDate: ['DocDueDate'], docTotal: ['DocTotal'], docStatus: ['DocStatus'], cancelled: ['CANCELED', 'Cancelled'],
};
const RDR1_FIELD_CANDIDATES = {
  docEntry: ['DocEntry'], itemCode: ['ItemCode'], openQty: ['OpenQty'], description: ['Dscription'],
};

async function fetchStockMapViaDB(dbDeps) {
  const { getActiveConfig, getActiveType, getTableColumns, resolveFieldMap, tableRef, executeSQL } = dbDeps;
  const cfg    = getActiveConfig();
  const isHana = getActiveType() === 'hana';
  const q      = n => qcol(n, isHana);
  const cols   = await getTableColumns('OITM');
  const { resolved, missing } = resolveFieldMap(cols, OITM_STOCK_CANDIDATES);
  if (missing.length) throw new Error(`OITM field mapping incomplete: ${missing.join(', ')}`);

  const sql = `SELECT ${q(resolved.itemCode)} AS ${q('ItemCode')}, ${q(resolved.itemName)} AS ${q('ItemName')}, ` +
    `${q(resolved.onHand)} AS ${q('OnHand')}, ${q(resolved.committed)} AS ${q('Committed')}, ${q(resolved.onOrder)} AS ${q('OnOrder')} ` +
    `FROM ${tableRef('OITM', cfg)} WHERE ${q(resolved.invntItem)} = 'Y'`;
  const rows = await executeSQL(sql);

  const map = {};
  for (const r of rows) {
    map[r.ItemCode] = {
      itemCode: r.ItemCode, itemName: r.ItemName || r.ItemCode,
      onHand: Number(r.OnHand || 0), committed: Number(r.Committed || 0), onOrder: Number(r.OnOrder || 0),
    };
  }
  return map;
}

async function fetchOpenSOsInRangeViaDB(dbDeps, { fromDate, toDate }) {
  const { getActiveConfig, getActiveType, getTableColumns, resolveFieldMap, tableRef, executeSQL } = dbDeps;
  const cfg    = getActiveConfig();
  const isHana = getActiveType() === 'hana';
  const q      = n => qcol(n, isHana);
  const cols   = await getTableColumns('ORDR');
  const { resolved, missing } = resolveFieldMap(cols, ORDR_FIELD_CANDIDATES);
  if (missing.length) throw new Error(`ORDR field mapping incomplete: ${missing.join(', ')}`);

  const sql = `SELECT ${q(resolved.docEntry)} AS ${q('DocEntry')}, ${q(resolved.docNum)} AS ${q('DocNum')}, ` +
    `${q(resolved.cardCode)} AS ${q('CardCode')}, ${q(resolved.cardName)} AS ${q('CardName')}, ` +
    `${q(resolved.docDueDate)} AS ${q('DocDueDate')}, ${q(resolved.docTotal)} AS ${q('DocTotal')} ` +
    `FROM ${tableRef('ORDR', cfg)} WHERE ${q(resolved.docStatus)} = 'O' AND ${q(resolved.cancelled)} = 'N' ` +
    `AND ${q(resolved.docDueDate)} >= '${fromDate}' AND ${q(resolved.docDueDate)} <= '${toDate}'`;
  return executeSQL(sql);
}

async function fetchSOLineItemsViaDB(dbDeps, docEntries) {
  const linesByOrder = new Map();
  if (!docEntries.length) return linesByOrder;
  const { getActiveConfig, getActiveType, getTableColumns, resolveFieldMap, tableRef, executeSQL } = dbDeps;
  const cfg    = getActiveConfig();
  const isHana = getActiveType() === 'hana';
  const q      = n => qcol(n, isHana);
  const cols   = await getTableColumns('RDR1');
  const { resolved, missing } = resolveFieldMap(cols, RDR1_FIELD_CANDIDATES);
  if (missing.length) throw new Error(`RDR1 field mapping incomplete: ${missing.join(', ')}`);

  const inList = docEntries.join(',');
  const sql = `SELECT ${q(resolved.docEntry)} AS ${q('DocEntry')}, ${q(resolved.itemCode)} AS ${q('ItemCode')}, ` +
    `${q(resolved.description)} AS ${q('Description')}, ${q(resolved.openQty)} AS ${q('OpenQty')} ` +
    `FROM ${tableRef('RDR1', cfg)} WHERE ${q(resolved.docEntry)} IN (${inList})`;
  const rows = await executeSQL(sql);
  for (const r of rows) {
    if (!linesByOrder.has(r.DocEntry)) linesByOrder.set(r.DocEntry, []);
    linesByOrder.get(r.DocEntry).push({ ItemCode: r.ItemCode, Description: r.Description, OpenQty: r.OpenQty });
  }
  return linesByOrder;
}

// ── Paginated SL fetch ────────────────────────────────────────────────────────
async function fetchAllPaginated(sap, endpoint, params, { pageSize = 50, maxItems = 2000 } = {}) {
  let skip = 0, all = [];
  while (true) {
    const r     = await sap.get(endpoint, { ...params, $top: pageSize, $skip: skip });
    const batch = r.value || [];
    all.push(...batch);
    if (batch.length < pageSize || all.length >= maxItems) break;
    skip += pageSize;
  }
  return all;
}

// ── Step 1: build stock map ───────────────────────────────────────────────────
// DB Direct (ODBC/HANA) preferred, Service Layer fallback.
async function buildStockMap(sap, dbDeps) {
  if (dbDeps?.isConnected?.()) {
    try {
      return await fetchStockMapViaDB(dbDeps);
    } catch (dbErr) {
      console.warn('[OrderIntel/stockMap] DB Direct failed, falling back to Service Layer:', dbErr.message);
    }
  }
  const items = await fetchAllPaginated(sap, '/Items', {
    $filter: "ItemType eq 'itItems' and InventoryItem eq 'tYES' and Frozen eq 'tNO'",
    $select: 'ItemCode,ItemName,QuantityOnStock,QuantityOrderedByCustomers,QuantityOrderedFromVendors',
  }, { pageSize: 200, maxItems: 5000 });

  const map = {};
  for (const i of items) {
    map[i.ItemCode] = {
      itemCode:  i.ItemCode,
      itemName:  i.ItemName || i.ItemCode,
      onHand:    Number(i.QuantityOnStock            || 0),
      committed: Number(i.QuantityOrderedByCustomers || 0),
      onOrder:   Number(i.QuantityOrderedFromVendors || 0),
    };
  }
  return map;
}

// ── "How is this calculated?" popups ─────────────────────────────────────────
// Built from the same variables used to compute each value, so they cannot drift.
const _xf = n => Number(n || 0).toLocaleString('en-GB', { maximumFractionDigits: 2 });

function oiItemExplain(s) {
  return {
    coveragePct: {
      title: 'How item coverage % is calculated',
      steps: [
        { label: 'In stock', formula: 'Quantity on hand in SAP', value: s.onHand },
        { label: 'Committed', formula: 'Quantity reserved by open sales orders', value: s.committed },
        { label: 'Shortage', formula: `Committed ${_xf(s.committed)} − in stock ${_xf(s.onHand)}`, value: s.shortage },
        { label: 'Coverage %', formula: `In stock ${_xf(s.onHand)} ÷ committed ${_xf(s.committed)} × 100`, value: `${s.coveragePct}%` },
      ],
      note: 'An item is "short" when what is in stock is less than what sales orders have committed.',
    },
  };
}

function oiOrderExplain({ shortLines, totalNeeded, totalAvailable, overallCovPct, severity }) {
  const steps = shortLines.slice(0, 8).map(l => ({
    label: l.itemCode,
    detail: l.description || '',
    formula: `Open qty ${_xf(l.openQty)} × item coverage ${l.coveragePct}% (rounded) → available ${_xf(l.available)}`,
    value: `short ${_xf(l.shortage)}`,
  }));
  if (shortLines.length > 8) steps.push({ label: `+${shortLines.length - 8} more`, formula: 'Other short lines on this order', value: '' });
  steps.push(
    { label: 'Total needed', formula: 'Sum of open qty on short lines', value: totalNeeded },
    { label: 'Total available', formula: 'Sum of estimated available qty', value: totalAvailable },
    { label: 'Order coverage %', formula: `Available ${_xf(totalAvailable)} ÷ needed ${_xf(totalNeeded)} × 100`, value: `${overallCovPct}%` },
  );
  const rules = [
    { rule: 'Coverage is 0% (nothing can be shipped)', result: 'CRITICAL', hit: severity === 'CRITICAL' },
    { rule: 'Coverage below 50%', result: 'HIGH', hit: severity === 'HIGH' },
    { rule: 'Coverage 50% or more (but some lines short)', result: 'MEDIUM', hit: severity === 'MEDIUM' },
  ];
  const note = "Each item's coverage = in stock ÷ committed across all open sales orders; it is applied to this order's open qty to estimate what can ship.";
  return {
    coverage: { title: `How coverage ${overallCovPct}% is calculated`, steps, note },
    severity: { title: `Why severity is ${severity}`, steps, rules, note },
  };
}

// ── Step 2: identify globally short items ────────────────────────────────────
function getShortItems(stockMap) {
  const short = {};
  for (const [code, s] of Object.entries(stockMap)) {
    if (s.onHand < s.committed) {
      short[code] = {
        ...s,
        shortage:    s.committed - s.onHand,
        coveragePct: s.committed > 0 ? Math.round(s.onHand / s.committed * 100) : 100,
        affectedSOs: [],   // filled during SO scan
      };
      short[code].explain = oiItemExplain(short[code]);
    }
  }
  return short;
}

// ── Core scan ─────────────────────────────────────────────────────────────────
// DB Direct (ODBC/HANA) preferred, Service Layer fallback.
async function scanOrderRisks(sap, dbDeps) {
  const today     = new Date();
  const todayStr  = today.toISOString().slice(0, 10);
  const horizon   = new Date(today.getTime() + SCAN_HORIZON_DAYS * 86400000).toISOString().slice(0, 10);
  const source    = dbDeps?.isConnected?.() ? dbDeps.getActiveType() : 'service-layer';

  const stockMap  = await buildStockMap(sap, dbDeps);
  const shortItems= getShortItems(stockMap);
  const shortSet  = new Set(Object.keys(shortItems));

  if (shortSet.size === 0) {
    return {
      atRiskOrders: [], shortItems: [], summary: {
        totalChecked: 0, atRisk: 0, critical: 0, high: 0,
        valueAtRisk: 0, shortItemCount: 0, source,
      },
    };
  }

  // Fetch open SOs due within horizon — DB Direct preferred, Service Layer fallback.
  let openSOs;
  if (dbDeps?.isConnected?.()) {
    try {
      openSOs = await fetchOpenSOsInRangeViaDB(dbDeps, { fromDate: todayStr, toDate: horizon });
    } catch (dbErr) {
      console.warn('[OrderIntel/openSOs] DB Direct failed, falling back to Service Layer:', dbErr.message);
    }
  }
  if (!openSOs) {
    openSOs = await fetchAllPaginated(sap, '/Orders', {
      $filter: `DocumentStatus eq 'bost_Open' and Cancelled eq 'tNO' and DocDueDate ge '${todayStr}' and DocDueDate le '${horizon}'`,
      $select: 'DocEntry,DocNum,CardCode,CardName,DocDueDate,DocTotal',
    }, { pageSize: 50, maxItems: 300 });
  }

  if (openSOs.length === 0) {
    return {
      atRiskOrders: [], shortItems: Object.values(shortItems), summary: {
        totalChecked: 0, atRisk: 0, critical: 0, high: 0,
        valueAtRisk: 0, shortItemCount: shortSet.size, source,
      },
    };
  }

  // Sort by due date (most urgent first), cap at MAX_SO_DETAIL
  const toCheck = [...openSOs]
    .sort((a, b) => new Date(a.DocDueDate) - new Date(b.DocDueDate))
    .slice(0, MAX_SO_DETAIL);

  // Fetch lines for all toCheck orders — DB Direct does it in one batched query;
  // Service Layer fallback fetches each order's lines individually (concurrency pool).
  let soLinesByOrder;
  if (dbDeps?.isConnected?.()) {
    try {
      soLinesByOrder = await fetchSOLineItemsViaDB(dbDeps, toCheck.map(so => so.DocEntry));
    } catch (dbErr) {
      console.warn('[OrderIntel/lines] DB Direct failed, falling back to Service Layer:', dbErr.message);
    }
  }

  const atRiskOrders = [];

  const processOrder = (so, lines) => {
    const shortLines = [];
    let totalNeeded = 0, totalAvailable = 0;

    for (const line of lines) {
      if (!shortSet.has(line.ItemCode)) continue;
      const openQty = Number(line.OpenQty ?? line.Quantity ?? 0);
      if (openQty <= 0) continue;

      const si  = shortItems[line.ItemCode];
      // Estimate available for this line based on global coverage ratio
      const avail    = Math.max(0, Math.round(openQty * (si.coveragePct / 100)));
      const shortage = openQty - avail;

      shortLines.push({
        itemCode:    line.ItemCode,
        description: (line.ItemDescription || line.Description || si.itemName || '').slice(0, 50),
        openQty,
        available:   avail,
        shortage,
        coveragePct: si.coveragePct,
        onOrder:     si.onOrder,
      });
      totalNeeded    += openQty;
      totalAvailable += avail;

      // Track affected SOs on the short item
      if (!si.affectedSOs.includes(so.DocNum)) si.affectedSOs.push(so.DocNum);
    }

    if (shortLines.length === 0) return;

    const daysLeft       = Math.ceil((new Date(so.DocDueDate) - today) / 86400000);
    const overallCovPct  = totalNeeded > 0 ? Math.round(totalAvailable / totalNeeded * 100) : 100;
    const severity       = overallCovPct === 0 ? 'CRITICAL'
                         : overallCovPct < 50  ? 'HIGH'
                         : 'MEDIUM';

    atRiskOrders.push({
      docNum:          so.DocNum,
      docEntry:        so.DocEntry,
      cardCode:        so.CardCode,
      cardName:        so.CardName,
      docDueDate:      so.DocDueDate,
      daysLeft,
      docTotal:        Number(so.DocTotal || 0),
      shortLines,
      totalNeeded,
      totalAvailable,
      totalShortage:   totalNeeded - totalAvailable,
      overallCovPct,
      severity,
      explain:         oiOrderExplain({ shortLines, totalNeeded, totalAvailable, overallCovPct, severity }),
    });
  };

  if (soLinesByOrder) {
    // DB Direct: lines already fetched in one batched query above.
    for (const so of toCheck) processOrder(so, soLinesByOrder.get(so.DocEntry) || []);
  } else {
    // Service Layer fallback: fetch each order's lines individually (concurrency pool).
    let idx = 0;
    const CONC = 6;
    const workers = Array.from({ length: Math.min(CONC, toCheck.length) }, async () => {
      while (idx < toCheck.length) {
        const so = toCheck[idx++];
        try {
          const full  = await sap.get(`/Orders(${so.DocEntry})`);
          processOrder(so, full.DocumentLines || []);
        } catch (e) {
          console.warn(`[OrderIntel] SO ${so.DocEntry}:`, e.message);
        }
      }
    });
    await Promise.all(workers);
  }

  atRiskOrders.sort((a, b) => {
    const s = { CRITICAL: 0, HIGH: 1, MEDIUM: 2 };
    return (s[a.severity] - s[b.severity]) || (a.daysLeft - b.daysLeft);
  });

  // Sort short items by number of affected SOs desc, then shortage qty
  const shortItemList = Object.values(shortItems)
    .sort((a, b) => (b.affectedSOs.length - a.affectedSOs.length) || (b.shortage - a.shortage));

  const valueAtRisk = atRiskOrders.reduce((s, o) => s + o.docTotal, 0);

  return {
    atRiskOrders,
    shortItems: shortItemList,
    summary: {
      totalChecked:   toCheck.length,
      atRisk:         atRiskOrders.length,
      critical:       atRiskOrders.filter(o => o.severity === 'CRITICAL').length,
      high:           atRiskOrders.filter(o => o.severity === 'HIGH').length,
      valueAtRisk:    Math.round(valueAtRisk),
      shortItemCount: shortSet.size,
      source,
    },
  };
}

// ── AI advisory ───────────────────────────────────────────────────────────────
async function getAIAdvisory(aiDeps, summary, topOrders, topShortItems) {
  const sys = `You are an Order Intelligence AI for SAP Business One.
Return ONLY valid JSON — no markdown fences, no explanation outside the JSON.`;

  const topOrderSnap = topOrders.slice(0, 5).map(o => ({
    soNum: o.docNum, customer: o.cardName, daysLeft: o.daysLeft,
    value: o.docTotal, coverage: o.overallCovPct + '%', severity: o.severity,
    shortItems: o.shortLines.map(l => l.itemCode).join(', '),
  }));

  const topItemSnap = topShortItems.slice(0, 5).map(i => ({
    itemCode: i.itemCode, onHand: i.onHand, committed: i.committed,
    shortage: i.shortage, affectedSOs: i.affectedSOs.length,
  }));

  const prompt = `Analyse this sales order stock shortage situation.

Summary:
- ${summary.totalChecked} open SOs checked (next ${SCAN_HORIZON_DAYS} days)
- ${summary.atRisk} orders at risk: ${summary.critical} CRITICAL, ${summary.high} HIGH
- Value at risk: ${summary.valueAtRisk.toLocaleString()}
- ${summary.shortItemCount} items with insufficient stock
- Today: ${new Date().toISOString().slice(0, 10)}

Top at-risk orders: ${JSON.stringify(topOrderSnap)}
Top bottleneck items: ${JSON.stringify(topItemSnap)}

Return JSON with exactly these keys:
{
  "overallRisk": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
  "headline": "<one sentence summary of the situation>",
  "immediateActions": ["<action 1>", "<action 2>", "<action 3>"],
  "bottleneckItem": "<item code that is blocking the most orders>",
  "bottleneckReason": "<one sentence on why this item is the key risk>",
  "customerImpact": "<one sentence on customer delivery risk>"
}`;

  try {
    const raw   = await callAI(aiDeps, [{ role: 'user', content: prompt }], sys, 600);
    const match = raw.match(/\{[\s\S]+\}/);
    if (match) return JSON.parse(match[0]);
  } catch (e) {
    console.warn('[OrderIntel/AI] advisory parse failed:', e.message);
  }
  return null;
}

// ── GPT-4o tool-calling chat — live SAP/HANA data, not just a static context
// blob, same pattern as the MRP/Procurement/Production agents' chat.
const ORDERINTEL_GPT_TOOLS = [
  { type:"function", function:{ name:"get_at_risk_orders",
    description:"Get open sales orders at risk of stock shortage — severity, coverage %, value, and the short items on each order.",
    parameters:{ type:"object", properties:{
      severity: { type:"string", enum:["CRITICAL","HIGH","MEDIUM","all"], description:"Filter by severity. Default: all" },
      limit:    { type:"integer", description:"Max orders to return (default 20)" },
    } } } },
  { type:"function", function:{ name:"get_short_items",
    description:"Get inventory items with insufficient stock to cover committed demand, ranked by number of affected sales orders.",
    parameters:{ type:"object", properties:{ limit: { type:"integer", description:"Max items to return (default 20)" } } } } },
  { type:"function", function:{ name:"check_item_coverage",
    description:"Check live stock coverage for one specific item — on hand, committed, on order, available.",
    parameters:{ type:"object", properties:{ itemCode:{ type:"string" } }, required:["itemCode"] } } },
  { type:"function", function:{ name:"get_so_detail",
    description:"Get full line-item detail for a specific sales order by document number.",
    parameters:{ type:"object", properties:{ docNum:{ type:"integer" } }, required:["docNum"] } } },
];

async function executeOrderIntelTool(name, args, sap, dbDeps) {
  const esc = s => String(s).replace(/'/g, "''");
  if (name === 'get_at_risk_orders') {
    const limit = Math.min(parseInt(args.limit) || 20, 100);
    const data  = await scanOrderRisks(sap, dbDeps);
    let orders  = data.atRiskOrders;
    if (args.severity && args.severity !== 'all') orders = orders.filter(o => o.severity === args.severity);
    return { orders: orders.slice(0, limit).map(({ explain, ...o }) => o), summary: data.summary, totalMatching: orders.length };
  }
  if (name === 'get_short_items') {
    const limit = Math.min(parseInt(args.limit) || 20, 100);
    const data  = await scanOrderRisks(sap, dbDeps);
    return { shortItems: data.shortItems.slice(0, limit).map(({ explain, ...i }) => i), summary: data.summary };
  }
  if (name === 'check_item_coverage') {
    const it = await sap.get(`/Items('${esc(args.itemCode)}')`, {
      $select: "ItemCode,ItemName,QuantityOnStock,QuantityOrderedByCustomers,QuantityOrderedFromVendors",
    });
    const onHand    = Number(it.QuantityOnStock || 0);
    const committed = Number(it.QuantityOrderedByCustomers || 0);
    return {
      itemCode: it.ItemCode, itemName: it.ItemName, onHand, committed,
      onOrder: Number(it.QuantityOrderedFromVendors || 0),
      available: onHand - committed,
      coveragePct: committed > 0 ? Math.round(onHand / committed * 100) : 100,
    };
  }
  if (name === 'get_so_detail') {
    const r = await sap.get('/Orders', {
      $filter: `DocNum eq ${Number(args.docNum)}`,
      $select: 'DocEntry,DocNum,CardCode,CardName,DocDueDate,DocTotal,DocumentStatus',
      $top: 1,
    });
    const so = (r.value || [])[0];
    if (!so) return { error: `Sales order #${args.docNum} not found` };
    const full = await sap.get(`/Orders(${so.DocEntry})`);
    return {
      docNum: so.DocNum, docEntry: so.DocEntry, cardCode: so.CardCode, cardName: so.CardName,
      docDueDate: so.DocDueDate, docTotal: Number(so.DocTotal || 0), status: so.DocumentStatus,
      lines: (full.DocumentLines || []).map(l => ({
        itemCode: l.ItemCode, description: l.ItemDescription, quantity: l.Quantity, openQty: l.OpenQty, price: l.Price,
      })),
    };
  }
  return { error: `Unknown order-intelligence tool: ${name}` };
}

// ══════════════════════════════════════════════════════════════════════════════
// ROUTER FACTORY
// ══════════════════════════════════════════════════════════════════════════════
export function createOrderIntelligenceRouter(deps) {
  const {
    requireAuth, getActiveSap, AI_PROVIDER, USE_AI, gptChatComplete, azureMessagesCreate,
    isConnected, getActiveType, getActiveConfig, executeSQL, tableRef, getTableColumns, resolveFieldMap,
  } = deps;
  const router  = Router();
  const _aiDeps = () => USE_AI ? { AI_PROVIDER, gptChatComplete, azureMessagesCreate } : null;
  const _dbDeps = isConnected
    ? { isConnected, getActiveType, getActiveConfig, executeSQL, tableRef, getTableColumns, resolveFieldMap }
    : null;

  // GET /api/order-intelligence/scan
  router.get('/scan', requireAuth, async (req, res) => {
    try {
      const data       = await scanOrderRisks(getActiveSap(), _dbDeps);
      const aiAdvisory = _aiDeps()
        ? await getAIAdvisory(_aiDeps(), data.summary, data.atRiskOrders, data.shortItems)
        : null;
      res.json({ ok: true, ...data, aiAdvisory });
    } catch (e) {
      console.error('[OrderIntel/scan]', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /api/order-intelligence/chat — GPT-4o tool-calling agent
  router.post('/chat', requireAuth, async (req, res) => {
    try {
      const { message, sessionId = `oi_${Date.now()}` } = req.body || {};
      if (!message?.trim()) return res.status(400).json({ ok: false, error: 'message required' });
      if (!USE_AI || !gptChatComplete) return res.json({ ok: true, reply: 'AI not configured.', sessionId });

      const sap   = getActiveSap();
      const today = new Date().toISOString().slice(0, 10);

      const history = _sessions.get(sessionId) || [];
      history.push({ role: 'user', content: message });
      if (history.length > 20) history.splice(0, history.length - 20);
      _sessions.set(sessionId, history);

      const systemPrompt = `You are an Order Intelligence AI for SAP Business One.
Today is ${today}. Expertise: stock shortage analysis, sales order fulfilment risk, inventory coverage, customer impact assessment, expediting decisions.
Always call the relevant tool to fetch live data before answering — never guess numbers. Be specific: reference SO numbers, item codes, customer names, and coverage percentages. Give clear, actionable recommendations.`;

      const messages = [{ role:"system", content: systemPrompt }, ...history];
      let response = null;
      for (let i = 0; i < 10; i++) {
        const body = { messages, tools: ORDERINTEL_GPT_TOOLS, tool_choice:"auto", max_tokens:1500, temperature:0.2 };
        const raw = await gptChatComplete(body);
        const choice = raw?.choices?.[0];
        if (!choice) throw new Error('No response from AI');
        const msg = choice.message;
        messages.push(msg);
        if (choice.finish_reason === 'tool_calls' && msg.tool_calls?.length) {
          const toolResults = await Promise.all(msg.tool_calls.map(async tc => {
            let args = {};
            try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
            let result;
            try { result = await executeOrderIntelTool(tc.function.name, args, sap, _dbDeps); }
            catch(e) { result = { error: e.message }; }
            return { role:"tool", tool_call_id: tc.id, content: JSON.stringify(result) };
          }));
          messages.push(...toolResults);
        } else {
          response = msg.content || '';
          break;
        }
      }
      if (!response) response = "Unable to complete that request. Please try again.";
      history.push({ role:"assistant", content: response });
      res.json({ ok: true, reply: response, sessionId });
    } catch (e) {
      console.error('[OrderIntel/chat]', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return router;
}
