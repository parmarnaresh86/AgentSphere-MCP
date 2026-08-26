/**
 * Rush Order Prioritisation Agent — backend controller
 * Mounted at /api/rush-orders by chat-server.mjs
 *
 * Flow:
 *  1. Fetch open sales orders from SAP (ORDR + DocumentLines)
 *  2. Score each order 0-100 (days-left + priority + value + customer-tier)
 *  3. Tag: CRITICAL ≥75 | URGENT ≥55 | MONITOR ≥35 | NORMAL
 *  4. For CRITICAL/URGENT: get AI recommendation (JSON) via Claude
 *  5. Escalation engine: auto-approve OR flag for review
 *  6. Optionally write SAP Activity alert and save JSON report
 */

import { Router }    from 'express';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path          from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── In-memory session store (per-agent chat) ──────────────────────────────────
const _sessions = new Map();
// ── Scan history (last 20 runs) ───────────────────────────────────────────────
const _history  = [];

// ── Default config ────────────────────────────────────────────────────────────
const DEFAULT_CFG = {
  urgentWithinDays:   14,
  criticalWithinDays: 3,
  autoApproveMaxCost: 500,
  maxExpediteCost:    5000,
  vipCustomers:       [],          // CardCode list treated as tier-20
  highTierGroups:     [],          // GroupNum list treated as tier-15
};

// ── Scoring weights (must total ≤ 100) ───────────────────────────────────────
const W_DAYS = 40, W_PRIORITY = 20, W_VALUE = 20, W_TIER = 20;

// ── AI helper (mirrors forecasting.mjs pattern) ──────────────────────────────
async function callAI(aiDeps, messages, systemPrompt, maxTokens = 800) {
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
    console.warn('[RushOrders/AI] call failed:', e.message);
  }
  return '';
}

// ── DB Direct (ODBC/HANA) reads, Service Layer fallback ─────────────────────
// Same pattern as the MRP/Purchasing/Procurement/Production agents: resolve every
// logical field against the LIVE column list before building SQL — never guess —
// and fall back to Service Layer on any connection/mapping failure. HANA folds
// unquoted identifiers to uppercase, so identifiers are quoted on HANA only.
function qcol(name, isHana) { return isHana ? `"${name}"` : name; }

const ORDR_FIELD_CANDIDATES = {
  docEntry: ['DocEntry'], docNum: ['DocNum'], cardCode: ['CardCode'], cardName: ['CardName'],
  docDate: ['DocDate'], docDueDate: ['DocDueDate'], docStatus: ['DocStatus'],
  docTotal: ['DocTotal'], shipToCode: ['ShipToCode'],
};
const RDR1_FIELD_CANDIDATES = {
  docEntry: ['DocEntry'], itemCode: ['ItemCode'], itemName: ['Dscription'],
  openQty: ['OpenQty'], price: ['Price'],
};
const RUSH_STOCK_FIELD_CANDIDATES = {
  itemCode: ['ItemCode'], onHand: ['OnHand'], committed: ['IsCommited'], minInventory: ['MinLevel', 'MinInvntry'],
};
const OCRD_GROUP_CANDIDATES = { cardCode: ['CardCode'], groupNum: ['GroupNum'] };

async function fetchOpenOrdersViaDB(dbDeps, { futureCut, warehouse }) {
  const { getActiveConfig, getActiveType, getTableColumns, resolveFieldMap, tableRef, executeSQL } = dbDeps;
  const cfg    = getActiveConfig();
  const isHana = getActiveType() === 'hana';
  const q      = n => qcol(n, isHana);
  const cols   = await getTableColumns('ORDR');
  const { resolved, missing } = resolveFieldMap(cols, ORDR_FIELD_CANDIDATES);
  if (missing.length) throw new Error(`ORDR field mapping incomplete: ${missing.join(', ')}`);

  const esc = s => String(s).replace(/'/g, "''");
  const conds = [`${q(resolved.docStatus)} = 'O'`, `${q(resolved.docDueDate)} <= '${futureCut}'`];
  if (warehouse) conds.push(`${q(resolved.shipToCode)} = '${esc(warehouse)}'`);

  const sql = `SELECT ${q(resolved.docEntry)} AS ${q('DocEntry')}, ${q(resolved.docNum)} AS ${q('DocNum')}, ` +
    `${q(resolved.cardCode)} AS ${q('CardCode')}, ${q(resolved.cardName)} AS ${q('CardName')}, ` +
    `${q(resolved.docDate)} AS ${q('DocDate')}, ${q(resolved.docDueDate)} AS ${q('DocDueDate')}, ` +
    `${q(resolved.docTotal)} AS ${q('DocTotal')} ` +
    `FROM ${tableRef('ORDR', cfg)} WHERE ${conds.join(' AND ')}`;
  const rows = await executeSQL(sql);

  // Normalized to the same shape the Service Layer /Orders response provides.
  return rows.map(r => ({
    DocEntry: r.DocEntry, DocNum: r.DocNum, CardCode: r.CardCode, CardName: r.CardName,
    DocDate: r.DocDate, DocDueDate: r.DocDueDate, DocTotal: r.DocTotal,
    DocumentStatus: 'bost_Open', Priority: '', GroupNum: '',
  }));
}

async function fetchOrderLinesViaDB(dbDeps, docEntries) {
  const { getActiveConfig, getActiveType, getTableColumns, resolveFieldMap, tableRef, executeSQL } = dbDeps;
  const cfg    = getActiveConfig();
  const isHana = getActiveType() === 'hana';
  const q      = n => qcol(n, isHana);
  const cols   = await getTableColumns('RDR1');
  const { resolved, missing } = resolveFieldMap(cols, RDR1_FIELD_CANDIDATES);
  if (missing.length) throw new Error(`RDR1 field mapping incomplete: ${missing.join(', ')}`);

  const linesByOrder = new Map();
  for (let i = 0; i < docEntries.length; i += 200) {
    const chunk  = docEntries.slice(i, i + 200);
    const inList = chunk.join(',');
    const sql = `SELECT ${q(resolved.docEntry)} AS ${q('DocEntry')}, ${q(resolved.itemCode)} AS ${q('ItemCode')}, ` +
      `${q(resolved.itemName)} AS ${q('ItemDescription')}, ${q(resolved.openQty)} AS ${q('OpenQty')}, ${q(resolved.price)} AS ${q('Price')} ` +
      `FROM ${tableRef('RDR1', cfg)} WHERE ${q(resolved.docEntry)} IN (${inList})`;
    const rows = await executeSQL(sql);
    for (const r of rows) {
      if (!linesByOrder.has(r.DocEntry)) linesByOrder.set(r.DocEntry, []);
      linesByOrder.get(r.DocEntry).push({
        ItemCode: r.ItemCode, ItemDescription: r.ItemDescription,
        OpenQty: r.OpenQty, Quantity: r.OpenQty, Price: r.Price,
      });
    }
  }
  return linesByOrder;
}

async function checkStockViaDB(dbDeps, codes) {
  const result = {};
  if (!codes.length) return result;
  const { getActiveConfig, getActiveType, getTableColumns, resolveFieldMap, tableRef, executeSQL } = dbDeps;
  const cfg    = getActiveConfig();
  const isHana = getActiveType() === 'hana';
  const q      = n => qcol(n, isHana);
  const cols   = await getTableColumns('OITM');
  const { resolved, missing } = resolveFieldMap(cols, RUSH_STOCK_FIELD_CANDIDATES);
  if (missing.length) throw new Error(`OITM field mapping incomplete: ${missing.join(', ')}`);

  const esc = s => String(s).replace(/'/g, "''");
  for (let i = 0; i < codes.length; i += 200) {
    const chunk  = codes.slice(i, i + 200);
    const inList = chunk.map(c => `'${esc(c)}'`).join(',');
    const sql = `SELECT ${q(resolved.itemCode)} AS ${q('ItemCode')}, ${q(resolved.onHand)} AS ${q('OnHand')}, ` +
      `${q(resolved.committed)} AS ${q('IsCommited')}, ${q(resolved.minInventory)} AS ${q('MinInventory')} ` +
      `FROM ${tableRef('OITM', cfg)} WHERE ${q(resolved.itemCode)} IN (${inList})`;
    const rows = await executeSQL(sql);
    for (const it of rows) {
      const onHand    = Number(it.OnHand || 0);
      const committed = Number(it.IsCommited || 0);
      result[it.ItemCode] = {
        onHand, committed,
        minStock:  Number(it.MinInventory || 0),
        available: Math.max(0, onHand - committed),
      };
    }
  }
  return result;
}

async function fetchGroupNumsViaDB(dbDeps, cardCodes) {
  const groupByCard = new Map();
  if (!cardCodes.length) return groupByCard;
  const { getActiveConfig, getActiveType, getTableColumns, resolveFieldMap, tableRef, executeSQL } = dbDeps;
  const cfg    = getActiveConfig();
  const isHana = getActiveType() === 'hana';
  const q      = n => qcol(n, isHana);
  const cols   = await getTableColumns('OCRD');
  const { resolved, missing } = resolveFieldMap(cols, OCRD_GROUP_CANDIDATES);
  if (missing.length) throw new Error(`OCRD field mapping incomplete: ${missing.join(', ')}`);

  const esc    = s => String(s).replace(/'/g, "''");
  const inList = cardCodes.map(c => `'${esc(c)}'`).join(',');
  const sql = `SELECT ${q(resolved.cardCode)} AS ${q('CardCode')}, ${q(resolved.groupNum)} AS ${q('GroupNum')} ` +
    `FROM ${tableRef('OCRD', cfg)} WHERE ${q(resolved.cardCode)} IN (${inList})`;
  const rows = await executeSQL(sql);
  for (const r of rows) groupByCard.set(r.CardCode, r.GroupNum);
  return groupByCard;
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

// ── Scoring engine ────────────────────────────────────────────────────────────
function scoreOrder(order, cfg, today = new Date()) {
  let score = 0;

  // Days until due date (40 pts)
  const due      = new Date(order.DocDueDate || order.DocDate || today);
  const daysLeft = Math.ceil((due - today) / 86_400_000);
  if      (daysLeft <= 0)  score += 40;   // Overdue
  else if (daysLeft <= 1)  score += 38;
  else if (daysLeft <= 3)  score += 30;
  else if (daysLeft <= 7)  score += 20;
  else if (daysLeft <= 14) score += 10;

  // SAP Priority field (20 pts)  — SAP stores as string e.g. "Normal","High" or int
  const pRaw = String(order.Priority ?? '').toLowerCase();
  if (/emerg/.test(pRaw) || pRaw === '4')      score += 20;
  else if (/high/.test(pRaw)  || pRaw === '3') score += 15;
  else if (/med/.test(pRaw)   || pRaw === '2') score += 10;
  // Normal/Low = 0

  // Order value (20 pts)
  const val = Number(order.DocTotal || 0);
  if      (val >= 100_000) score += 20;
  else if (val >=  50_000) score += 16;
  else if (val >=  20_000) score += 12;
  else if (val >=   5_000) score +=  7;
  else if (val >=   1_000) score +=  3;

  // Customer tier (20 pts)
  const isVip  = cfg.vipCustomers.includes(order.CardCode);
  const isHigh = cfg.highTierGroups.includes(String(order.GroupNum));
  if      (isVip)  score += 20;
  else if (isHigh) score += 15;
  else             score +=  5;

  return { score: Math.min(100, score), daysLeft };
}

function tagOrder(score) {
  if (score >= 75) return 'CRITICAL';
  if (score >= 55) return 'URGENT';
  if (score >= 35) return 'MONITOR';
  return 'NORMAL';
}

// ── Stock availability check ──────────────────────────────────────────────────
async function checkStock(sap, lines = []) {
  const codes  = [...new Set(lines.map(l => l.ItemCode).filter(Boolean))];
  const result = {};
  const BATCH  = 15;

  for (let i = 0; i < codes.length; i += BATCH) {
    const batch = codes.slice(i, i + BATCH);
    const fExpr = batch.map(c => `ItemCode eq '${c.replace(/'/g, "''")}'`).join(' or ');
    try {
      const r = await sap.get('/Items', {
        $filter: fExpr,
        $select: 'ItemCode,QuantityOnStock,QuantityOrderedByCustomers,MinInventory',
        $top: BATCH,
      });
      for (const it of r.value || []) {
        const onHand    = Number(it.QuantityOnStock            || 0);
        const committed = Number(it.QuantityOrderedByCustomers || 0);
        result[it.ItemCode] = {
          onHand,
          committed,
          minStock:  Number(it.MinInventory || 0),
          available: Math.max(0, onHand - committed),
        };
      }
    } catch (e) {
      console.warn('[RushOrders/Stock] batch failed:', e.message);
    }
  }
  return result;
}

// ── AI recommendation (structured JSON) ──────────────────────────────────────
async function getAIRecommendation(aiDeps, order, stockMap, cfg) {
  const sys = `You are a supply-chain operations AI for SAP Business One.
Return ONLY valid JSON — no markdown fences, no explanation outside the JSON.`;

  const lineSnap = (order.DocumentLines || []).slice(0, 8).map(l => ({
    item:  l.ItemCode,
    desc:  (l.ItemDescription || '').slice(0, 35),
    openQty: l.OpenQty || l.Quantity,
    price:   l.Price,
    stock: stockMap[l.ItemCode] || { available: 0, onHand: 0, committed: 0 },
  }));

  const prompt = `Analyse this rush sales order and return JSON recommendation.

Order: #${order.DocNum}  Customer: ${order.CardName} (${order.CardCode})
Due: ${order.DocDueDate}  Value: ${Number(order.DocTotal || 0).toFixed(2)}
Urgency Score: ${order._score}/100  Tag: ${order._tag}  Days Left: ${order._daysLeft}
Lines: ${JSON.stringify(lineSnap)}
Config: autoApproveThreshold=${cfg.autoApproveMaxCost} maxExpediteCost=${cfg.maxExpediteCost}

Return JSON with exactly these keys:
{
  "recommendation": "APPROVE_EXPEDITE" | "HOLD" | "REVIEW" | "CANCEL",
  "expediteShippingCost": <number>,
  "standardShippingCost": <number>,
  "revenueAtRisk": <number>,
  "marginImpactPct": <number>,
  "escalateTo": "Operations Manager" | "Sales Director" | "CEO" | "None",
  "stockStatus": "AVAILABLE" | "PARTIAL" | "OUT_OF_STOCK",
  "autoApprove": <boolean — true only if expediteShippingCost <= ${cfg.autoApproveMaxCost}>,
  "priorityActions": ["<action 1>", "<action 2>", "<action 3>"],
  "reasoning": "<max 2 sentences>",
  "customerImpact": "<one sentence>"
}`;

  try {
    const raw  = await callAI(aiDeps, [{ role: 'user', content: prompt }], sys, 700);
    const match = raw.match(/\{[\s\S]+\}/);
    if (match) return JSON.parse(match[0]);
  } catch (e) {
    console.warn('[RushOrders/AI] JSON parse failed, using fallback:', e.message);
  }
  return ruleFallback(order, stockMap, cfg);
}

// ── Rule-based fallback (used when AI unavailable/fails) ─────────────────────
function ruleFallback(order, stockMap, cfg) {
  const lines = order.DocumentLines || [];
  const outItems = lines.filter(l => (stockMap[l.ItemCode]?.available || 0) < (l.OpenQty || l.Quantity || 0));

  if (outItems.length > 0) {
    return {
      recommendation: 'HOLD',
      expediteShippingCost: 0, standardShippingCost: 0,
      revenueAtRisk: order.DocTotal,
      marginImpactPct: 0,
      escalateTo: 'Operations Manager',
      stockStatus: outItems.length === lines.length ? 'OUT_OF_STOCK' : 'PARTIAL',
      autoApprove: false,
      priorityActions: [
        'Check alternative warehouses for stock',
        'Contact supplier for emergency replenishment',
        `Notify customer of delay — items: ${outItems.map(l => l.ItemCode).join(', ')}`,
      ],
      reasoning: `${outItems.length} of ${lines.length} line(s) have insufficient stock. Manual review required before expediting.`,
      customerImpact: 'Order cannot be fulfilled as-is — partial or delayed shipment likely.',
    };
  }

  const expediteCost = Math.round(Math.min(Number(order.DocTotal || 0) * 0.025 + 150, cfg.maxExpediteCost));
  const autoApprove  = expediteCost <= cfg.autoApproveMaxCost;

  return {
    recommendation: order._score >= 75 ? 'APPROVE_EXPEDITE' : 'REVIEW',
    expediteShippingCost: expediteCost, standardShippingCost: Math.round(expediteCost * 0.3),
    revenueAtRisk: order.DocTotal,
    marginImpactPct: Number(order.DocTotal) > 0 ? Math.round((expediteCost / Number(order.DocTotal)) * 100 * 10) / 10 : 0,
    escalateTo: order._score >= 85 ? 'Sales Director' : 'Operations Manager',
    stockStatus: 'AVAILABLE',
    autoApprove,
    priorityActions: [
      'Confirm warehouse pick priority',
      'Arrange express carrier booking',
      'Send shipment confirmation to customer',
    ],
    reasoning: `Rule-based analysis: all stock available. Expedite cost ${autoApprove ? 'within' : 'exceeds'} auto-approve threshold.`,
    customerImpact: 'Order can be expedited with same-day/next-day delivery.',
  };
}

// ── Create SAP Activity (alert) ───────────────────────────────────────────────
async function createSAPActivity(sap, order, rec) {
  const today = new Date().toISOString().slice(0, 10);
  try {
    await sap.post('/Activities', {
      CardCode:     order.CardCode,
      ActivityDate: today,
      Subject:      `RUSH ORDER ${order._tag}: #${order.DocNum} — ${rec.recommendation}`,
      Notes:        [
        `Rush Order Alert — Auto-generated by Rush Order Prioritisation Agent`,
        `Order #${order.DocNum} | Customer: ${order.CardName} | Due: ${order.DocDueDate}`,
        `Value: ${Number(order.DocTotal || 0).toFixed(2)} | Score: ${order._score}/100 | Tag: ${order._tag}`,
        ``,
        `AI Recommendation: ${rec.recommendation}`,
        `Expedite Cost: ${rec.expediteShippingCost} | Revenue at Risk: ${rec.revenueAtRisk}`,
        `Stock Status: ${rec.stockStatus} | Escalate To: ${rec.escalateTo}`,
        ``,
        `Priority Actions:`,
        ...(rec.priorityActions || []).map((a, i) => `  ${i + 1}. ${a}`),
        ``,
        `Reasoning: ${rec.reasoning}`,
      ].join('\n'),
      Closed:       'tNO',
      ActivityType: 2,      // Note
      Priority:     'acp_High',
    });
    return true;
  } catch (e) {
    console.warn('[RushOrders/SAP] Activity creation failed:', e.message);
    return false;
  }
}

// ── Report generator ──────────────────────────────────────────────────────────
function saveReport(orders, cfg, dryRun = false) {
  const ts  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = path.join(__dirname, '..', 'reports', 'rush-orders');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const critical  = orders.filter(o => o._tag === 'CRITICAL');
  const urgent    = orders.filter(o => o._tag === 'URGENT');
  const approved  = orders.filter(o => o._aiRec?.autoApprove === true);
  const review    = orders.filter(o => o._aiRec && !o._aiRec.autoApprove && (o._tag === 'CRITICAL' || o._tag === 'URGENT'));
  const totalXCost = orders.reduce((s, o) => s + (Number(o._aiRec?.expediteShippingCost) || 0), 0);
  const revProtect = approved.reduce((s, o) => s + (Number(o.DocTotal) || 0), 0);

  const report = {
    generatedAt:  new Date().toISOString(),
    dryRun,
    config:       cfg,
    summary: {
      totalScanned:     orders.length,
      critical:         critical.length,
      urgent:           urgent.length,
      monitor:          orders.filter(o => o._tag === 'MONITOR').length,
      normal:           orders.filter(o => o._tag === 'NORMAL').length,
      autoApproved:     approved.length,
      requireReview:    review.length,
      totalExpediteCost: Math.round(totalXCost),
      revenueProtected: Math.round(revProtect),
    },
    orders: orders.map(o => ({
      docNum: o.DocNum, docEntry: o.DocEntry,
      cardCode: o.CardCode, cardName: o.CardName,
      docDate: o.DocDate, docDueDate: o.DocDueDate,
      docTotal: o.DocTotal, score: o._score, tag: o._tag, daysLeft: o._daysLeft,
      recommendation:   o._aiRec?.recommendation,
      expediteCost:     o._aiRec?.expediteShippingCost,
      revenueAtRisk:    o._aiRec?.revenueAtRisk,
      escalateTo:       o._aiRec?.escalateTo,
      autoApprove:      o._aiRec?.autoApprove,
      stockStatus:      o._aiRec?.stockStatus,
      activityCreated:  o._activityCreated || false,
    })),
  };

  const file = path.join(dir, `rush-orders-${ts}.json`);
  try { writeFileSync(file, JSON.stringify(report, null, 2)); } catch {}
  return { file, report };
}

// ══════════════════════════════════════════════════════════════════════════════
// EXPORTED CORE SCAN — called by router + main chat handler
// ══════════════════════════════════════════════════════════════════════════════
export async function runRushOrderScan(sap, {
  urgentWithinDays   = 14,
  warehouse,
  vipCustomers       = [],
  highTierGroups     = [],
  autoApproveMaxCost = 500,
  maxExpediteCost    = 5000,
  dryRun             = false,
  createActivities   = false,
  aiDeps             = null,
  dbDeps             = null,
} = {}) {
  const cfg = { urgentWithinDays, autoApproveMaxCost, maxExpediteCost, vipCustomers, highTierGroups };
  const today    = new Date();
  const futureCut = new Date(today.getTime() + urgentWithinDays * 86_400_000).toISOString().slice(0, 10);

  // ── Step 1: Fetch open orders — DB Direct (ODBC/HANA) preferred, Service Layer fallback ──
  let rawOrders;
  let source = 'service-layer';
  if (dbDeps?.isConnected?.()) {
    try {
      rawOrders = await fetchOpenOrdersViaDB(dbDeps, { futureCut, warehouse });
      // Customer tier needs OCRD.GroupNum — only worth the extra query when tiers are configured.
      if (highTierGroups.length && rawOrders.length) {
        const cardCodes = [...new Set(rawOrders.map(o => o.CardCode).filter(Boolean))];
        const groupMap  = await fetchGroupNumsViaDB(dbDeps, cardCodes);
        for (const o of rawOrders) o.GroupNum = groupMap.get(o.CardCode) ?? '';
      }
      source = dbDeps.getActiveType();
    } catch (dbErr) {
      console.warn('[RushOrders] DB Direct failed, falling back to Service Layer:', dbErr.message);
      rawOrders = undefined;
    }
  }
  if (!rawOrders) {
    // minimal params to avoid SAP expand errors
    let filter = `DocumentStatus eq 'bost_Open' and DocDueDate le '${futureCut}'`;
    if (warehouse) filter += ` and ShipToCode eq '${warehouse.replace(/'/g, "''")}'`;
    rawOrders = await fetchAllPaginated(sap, '/Orders', {
      $filter: filter,
    }, { pageSize: 20, maxItems: 500 });
    source = 'service-layer';
  }

  if (rawOrders.length === 0) {
    return {
      orders: [], summary: {
        totalScanned: 0, critical: 0, urgent: 0, monitor: 0, normal: 0,
        autoApproved: 0, requireReview: 0, totalExpediteCost: 0, revenueProtected: 0,
        source,
      },
      message: `No open orders found due within ${urgentWithinDays} days.`,
      scannedAt: today.toISOString(),
    };
  }

  // ── Step 2: Score & tag all orders (sort by score desc) ───────────────────
  const scored = rawOrders.map(o => {
    const { score, daysLeft } = scoreOrder(o, cfg, today);
    return { ...o, _score: score, _tag: tagOrder(score), _daysLeft: daysLeft };
  });
  scored.sort((a, b) => b._score - a._score || new Date(a.DocDueDate) - new Date(b.DocDueDate));

  // ── Step 3: Load lines + stock for CRITICAL + URGENT only ──────────────────
  // DB Direct (ODBC/HANA) preferred, Service Layer fallback.
  const needsAnalysis = scored.filter(o => o._tag === 'CRITICAL' || o._tag === 'URGENT');
  let stockMap = {};
  if (needsAnalysis.length > 0) {
    let linesOk = false;
    if (dbDeps?.isConnected?.()) {
      try {
        const linesByOrder = await fetchOrderLinesViaDB(dbDeps, needsAnalysis.map(o => o.DocEntry));
        for (const order of needsAnalysis) order.DocumentLines = linesByOrder.get(order.DocEntry) || [];
        const allLines = needsAnalysis.flatMap(o => o.DocumentLines);
        stockMap = await checkStockViaDB(dbDeps, [...new Set(allLines.map(l => l.ItemCode).filter(Boolean))]);
        linesOk = true;
      } catch (dbErr) {
        console.warn('[RushOrders] DB Direct (lines/stock) failed, falling back to Service Layer:', dbErr.message);
      }
    }
    if (!linesOk) {
      // Fetch full order individually — the only reliable way to get DocumentLines via Service Layer
      const concurrency = 6;
      let next = 0;
      const workers = Array.from({ length: Math.min(concurrency, needsAnalysis.length) }, async () => {
        while (next < needsAnalysis.length) {
          const order = needsAnalysis[next++];
          try {
            const full = await sap.get(`/Orders(${order.DocEntry})`);
            order.DocumentLines = full.DocumentLines || [];
          } catch {
            order.DocumentLines = [];
          }
        }
      });
      await Promise.all(workers);

      const allLines = needsAnalysis.flatMap(o => o.DocumentLines);
      stockMap = await checkStock(sap, allLines);
    }
  }

  // ── Step 4: AI recommendation + escalation ─────────────────────────────
  for (const order of needsAnalysis) {
    order._aiRec = aiDeps
      ? await getAIRecommendation(aiDeps, order, stockMap, cfg)
      : ruleFallback(order, stockMap, cfg);

    // ── Escalation engine ────────────────────────────────────────────────
    if (!dryRun && createActivities && order._aiRec) {
      order._activityCreated = await createSAPActivity(sap, order, order._aiRec);
    }
  }

  // ── Step 5: Summary ─────────────────────────────────────────────────────
  const all       = scored;
  const critical  = all.filter(o => o._tag === 'CRITICAL');
  const urgent    = all.filter(o => o._tag === 'URGENT');
  const approved  = all.filter(o => o._aiRec?.autoApprove === true);
  const review    = all.filter(o => o._aiRec && !o._aiRec.autoApprove && (o._tag === 'CRITICAL' || o._tag === 'URGENT'));
  const totalXC   = all.reduce((s, o) => s + (Number(o._aiRec?.expediteShippingCost) || 0), 0);
  const revProt   = approved.reduce((s, o) => s + (Number(o.DocTotal) || 0), 0);

  const summary = {
    totalScanned:     all.length,
    critical:         critical.length,
    urgent:           urgent.length,
    monitor:          all.filter(o => o._tag === 'MONITOR').length,
    normal:           all.filter(o => o._tag === 'NORMAL').length,
    autoApproved:     approved.length,
    requireReview:    review.length,
    totalExpediteCost: Math.round(totalXC),
    revenueProtected: Math.round(revProt),
    stockMap,
    scannedAt: today.toISOString(),
    urgentWithinDays,
    dryRun,
    source,
  };

  // Save report
  if (!dryRun) {
    const { report } = saveReport(all, cfg, dryRun);
    _history.unshift({ scannedAt: today.toISOString(), summary: report.summary });
    if (_history.length > 20) _history.length = 20;
  }

  return { orders: all, summary, scannedAt: today.toISOString() };
}

// ── Router factory ────────────────────────────────────────────────────────────
export function createRushOrderRouter(deps) {
  const {
    requireAuth, getActiveSap, AI_PROVIDER, USE_AI, gptChatComplete, azureMessagesCreate,
    isConnected, getActiveType, getActiveConfig, executeSQL, tableRef, getTableColumns, resolveFieldMap,
  } = deps;
  const router  = Router();
  const _aiDeps = () => USE_AI ? { AI_PROVIDER, gptChatComplete, azureMessagesCreate } : null;
  const _dbDeps = isConnected
    ? { isConnected, getActiveType, getActiveConfig, executeSQL, tableRef, getTableColumns, resolveFieldMap }
    : null;

  // GET /api/rush-orders/config
  router.get('/config', requireAuth, (_req, res) => {
    res.json({ ok: true, config: DEFAULT_CFG });
  });

  // POST /api/rush-orders/scan
  router.post('/scan', requireAuth, async (req, res) => {
    try {
      const {
        urgentWithinDays   = 14,
        warehouse,
        vipCustomers       = [],
        highTierGroups     = [],
        autoApproveMaxCost = 500,
        maxExpediteCost    = 5000,
        dryRun             = false,
        createActivities   = false,
        useAI              = true,
      } = req.body || {};

      const result = await runRushOrderScan(getActiveSap(), {
        urgentWithinDays, warehouse, vipCustomers, highTierGroups,
        autoApproveMaxCost, maxExpediteCost, dryRun,
        createActivities,
        aiDeps: useAI ? _aiDeps() : null,
        dbDeps: _dbDeps,
      });
      res.json({ ok: true, ...result });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // POST /api/rush-orders/approve/:docEntry
  router.post('/approve/:docEntry', requireAuth, async (req, res) => {
    try {
      const sap = getActiveSap();
      const { action = 'APPROVE', order, aiRec } = req.body || {};
      const docEntry = Number(req.params.docEntry);

      if (action === 'APPROVE' && aiRec) {
        // Create SAP Activity for this order
        const fakeOrder = { ...(order || {}), DocEntry: docEntry, _activityCreated: false };
        const created = await createSAPActivity(sap, fakeOrder, aiRec);
        res.json({ ok: true, action, activityCreated: created, docEntry });
      } else {
        // HOLD — just record
        res.json({ ok: true, action: 'HOLD', docEntry });
      }
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // GET /api/rush-orders/history
  router.get('/history', requireAuth, (_req, res) => {
    res.json({ ok: true, history: _history });
  });

  // GET /api/rush-orders/report
  router.get('/report', requireAuth, async (req, res) => {
    const dir = path.join(__dirname, '..', 'reports', 'rush-orders');
    if (!existsSync(dir)) return res.json({ ok: true, files: [] });
    try {
      const { readdirSync } = await import('node:fs');
      const files = readdirSync(dir).filter(f => f.endsWith('.json')).sort().reverse().slice(0, 10);
      res.json({ ok: true, files: files.map(f => ({ name: f })) });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // POST /api/rush-orders/chat
  router.post('/chat', requireAuth, async (req, res) => {
    try {
      const { message, sessionId = `ro_${Date.now()}`, context } = req.body;
      if (!message?.trim()) return res.status(400).json({ ok: false, error: 'message required' });
      if (!USE_AI)          return res.json({ ok: true, reply: 'AI not configured.', sessionId });

      const history = _sessions.get(sessionId) || [];
      history.push({ role: 'user', content: message });
      if (history.length > 20) history.splice(0, history.length - 20);
      _sessions.set(sessionId, history);

      const sys = `You are a Rush Order Operations AI for SAP Business One.
Today: ${new Date().toISOString().slice(0, 10)}.
Expertise: order urgency, expedited shipping, stockout risk, customer escalation, cost-benefit analysis.
${context ? `\nCurrent Scan Context:\n${JSON.stringify(context)}` : ''}
Be concise and action-oriented. Reference order numbers and costs. Give specific escalation recommendations.`;

      const reply = await callAI(_aiDeps(), history, sys, 1024);
      history.push({ role: 'assistant', content: reply || 'Unable to process.' });
      res.json({ ok: true, reply: reply || 'Unable to process.', sessionId });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  return router;
}
