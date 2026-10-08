/**
 * Purchasing Agent — backend controller
 * Mounted at /api/purchasing by chat-server.mjs
 *
 * Capabilities:
 *  1. Reorder scan   — items below min stock, suggested quantities + EOQ
 *  2. Supplier risks — overdue POs, late-delivery rate, concentration risk
 *  3. Impact analysis — open SOs / production orders at risk from stock delays
 *  4. AI insights    — summarised advisory with priority actions
 *  5. Chat           — conversational AI on purchasing decisions
 */

import { Router } from 'express';

const _sessions = new Map();

// ── AI helper (mirrors rush-orders.mjs pattern) ───────────────────────────────
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
    console.warn('[Purchasing/AI] call failed:', e.message);
  }
  return '';
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

// ── EOQ calculator ────────────────────────────────────────────────────────────
function calcEOQ(annualDemand, orderingCost = 50, holdingRate = 0.25, unitCost = 1) {
  if (annualDemand <= 0 || unitCost <= 0) return 0;
  return Math.ceil(Math.sqrt((2 * annualDemand * orderingCost) / (holdingRate * unitCost)));
}

// ── "How is this calculated?" popups ─────────────────────────────────────────
// Built from the same variables used to compute each value, so they cannot drift.
const _xf = n => Number(n || 0).toLocaleString('en-GB', { maximumFractionDigits: 2 });

function puReorderExplain({ onHand, minInv, onOrder, shortfall, annualDemand, eoq, suggestedQty, urgency }) {
  const eoqSteps = [
    { label: 'Yearly demand (estimate)', formula: `Minimum stock ${_xf(minInv)} × 12 months`, value: annualDemand },
    { label: 'EOQ', formula: `√(2 × yearly demand ${_xf(annualDemand)} × order cost 50 ÷ (holding rate 25% × unit cost 1)), rounded up`, value: eoq },
  ];
  const half = minInv * 0.5;
  return {
    eoq: {
      title: 'How EOQ (economic order quantity) is calculated',
      steps: eoqSteps,
      note: 'EOQ balances ordering cost against holding cost. Minimum stock is used as a stand-in for monthly demand; order cost 50 and holding rate 25% are fixed assumptions.',
    },
    suggestedQty: {
      title: 'How the suggested quantity is calculated',
      steps: [
        { label: 'Shortfall', formula: `Minimum ${_xf(minInv)} − in stock ${_xf(onHand)} − on order ${_xf(onOrder)} (not below 0)`, value: shortfall },
        ...eoqSteps,
        { label: 'EOQ less on order', formula: `EOQ ${_xf(eoq)} − on order ${_xf(onOrder)}`, value: eoq - onOrder },
      ],
      result: { label: 'Suggested qty = largest of shortfall, EOQ − on order, 1', value: Math.max(0, Math.round(suggestedQty)) },
      rules: [
        { rule: 'Shortfall is the largest', result: 'Order the shortfall', hit: suggestedQty === shortfall && shortfall >= 1 },
        { rule: 'EOQ − on order is the largest', result: 'Order an economic batch', hit: suggestedQty === eoq - onOrder && suggestedQty !== shortfall && suggestedQty >= 1 },
        { rule: 'Both are below 1', result: 'Order the minimum of 1', hit: suggestedQty === 1 && shortfall < 1 && eoq - onOrder < 1 },
      ],
    },
    urgency: {
      title: `Why urgency is ${urgency}`,
      steps: [
        { label: 'In stock', formula: 'Quantity on hand in SAP', value: onHand },
        { label: 'In stock + on order', formula: `${_xf(onHand)} + ${_xf(onOrder)}`, value: onHand + onOrder },
        { label: 'Half of minimum stock', formula: `Minimum ${_xf(minInv)} × 50%`, value: half },
      ],
      rules: [
        { rule: 'Nothing in stock (0 or less)', result: 'CRITICAL', hit: urgency === 'CRITICAL' },
        { rule: 'In stock + on order is below half of the minimum', result: 'HIGH', hit: urgency === 'HIGH' },
        { rule: 'Otherwise (in stock below minimum)', result: 'MEDIUM', hit: urgency === 'MEDIUM' },
      ],
    },
  };
}

function puSupplierExplain(v) {
  const r1 = v.overdueOrders > 0 && v.overdueRate > 50;
  const r2 = !r1 && (v.overdueRate > 20 || v.spendShare > 40);
  return {
    riskLevel: {
      title: `Why supplier risk is ${v.riskLevel}`,
      steps: [
        { label: 'Open POs', formula: 'Purchase orders still open (last 6 months)', value: v.openOrders },
        { label: 'Overdue POs', formula: 'Open POs past their due date', value: v.overdueOrders },
        { label: 'Overdue rate', formula: `Overdue ${v.overdueOrders} ÷ open ${v.openOrders} × 100`, value: `${v.overdueRate}%` },
        { label: 'Spend share', formula: `Vendor spend ${_xf(v.totalSpend)} ÷ total PO spend × 100`, value: `${v.spendShare}%` },
      ],
      rules: [
        { rule: 'Has overdue POs and overdue rate above 50%', result: 'HIGH', hit: r1 },
        { rule: 'Overdue rate above 20% or spend share above 40%', result: 'MEDIUM', hit: r2 },
        { rule: 'Otherwise', result: 'LOW', hit: !r1 && !r2 },
      ],
    },
  };
}

function puImpactExplain(dueDate, daysLeft, severity, affectedItems = []) {
  return {
    severity: {
      title: `Why severity is ${severity}`,
      steps: [
        { label: 'Due date', formula: 'Sales order delivery date', value: String(dueDate || '').slice(0, 10) },
        { label: 'Days left', formula: 'Due date − today', value: daysLeft },
        { label: 'Short items on the order', formula: affectedItems.slice(0, 5).map(i => `${i.itemCode} ×${_xf(i.openQty)}`).join(', ') || '—', value: affectedItems.length },
      ],
      rules: [
        { rule: 'Due in 3 days or less', result: 'CRITICAL', hit: severity === 'CRITICAL' },
        { rule: 'Due in 4–7 days', result: 'HIGH', hit: severity === 'HIGH' },
        { rule: 'Due in more than 7 days (up to 45)', result: 'MEDIUM', hit: severity === 'MEDIUM' },
      ],
      note: 'An order is listed when it contains an item that is out of stock, critical, or has less stock than is committed.',
    },
  };
}

// ── DB Direct (ODBC/HANA) reads, Service Layer fallback ────────────────────
// Same pattern as the MRP agent: resolve every logical field against the LIVE
// column list before building SQL (never guess a column name), and fall back
// to the Service Layer call on any connection/mapping failure. HANA folds
// unquoted identifiers to uppercase, so identifiers are quoted on HANA only —
// MSSQL is case-insensitive and stays unquoted.
function qcol(name, isHana) { return isHana ? `"${name}"` : name; }

const OITM_REORDER_CANDIDATES = {
  itemCode: ['ItemCode'], itemName: ['ItemName'], onHand: ['OnHand'],
  minInventory: ['MinLevel', 'MinInvntry'], onOrder: ['OnOrder'],
  committed: ['IsCommited'], leadTime: ['LeadTime'], invntItem: ['InvntItem'],
};
const OPOR_SUPPLIER_CANDIDATES = {
  docEntry: ['DocEntry'], docNum: ['DocNum'], cardCode: ['CardCode'], cardName: ['CardName'],
  docDate: ['DocDate'], docDueDate: ['DocDueDate'], docStatus: ['DocStatus'],
  docTotal: ['DocTotal'], cancelled: ['CANCELED', 'Cancelled'],
};
const ORDR_IMPACT_CANDIDATES = {
  docEntry: ['DocEntry'], docNum: ['DocNum'], cardCode: ['CardCode'], cardName: ['CardName'],
  docDueDate: ['DocDueDate'], docTotal: ['DocTotal'], docStatus: ['DocStatus'], cancelled: ['CANCELED', 'Cancelled'],
};
const RDR1_IMPACT_CANDIDATES = {
  docEntry: ['DocEntry'], itemCode: ['ItemCode'], openQty: ['OpenQty'], description: ['Dscription'],
};

async function scanReorderItemsViaDB(dbDeps) {
  const { getActiveConfig, getActiveType, getTableColumns, resolveFieldMap, tableRef, executeSQL } = dbDeps;
  const cfg    = getActiveConfig();
  const isHana = getActiveType() === 'hana';
  const q      = n => qcol(n, isHana);
  const cols   = await getTableColumns('OITM');
  const { resolved, missing } = resolveFieldMap(cols, OITM_REORDER_CANDIDATES);
  if (missing.length) throw new Error(`OITM field mapping incomplete: ${missing.join(', ')}`);
  // Preferred vendor = OITM.CardCode, its name from OCRD (optional: older schemas may lack it).
  const { resolved: optV } = resolveFieldMap(cols, { cardCode: ['CardCode'] });
  const t0 = n => `T0.${q(n)}`;
  const sql = `SELECT ${t0(resolved.itemCode)} AS ${q('ItemCode')}, ${t0(resolved.itemName)} AS ${q('ItemName')}, ` +
    `${t0(resolved.onHand)} AS ${q('OnHand')}, ${t0(resolved.minInventory)} AS ${q('MinInventory')}, ` +
    `${t0(resolved.onOrder)} AS ${q('OnOrder')}, ${t0(resolved.committed)} AS ${q('Committed')}, ` +
    `${t0(resolved.leadTime)} AS ${q('LeadTime')}` +
    (optV.cardCode ? `, ${t0(optV.cardCode)} AS ${q('Vendor')}, V.${q('CardName')} AS ${q('VendorName')} ` : ' ') +
    `FROM ${tableRef('OITM', cfg)} T0` +
    (optV.cardCode ? ` LEFT JOIN ${tableRef('OCRD', cfg)} V ON V.${q('CardCode')} = ${t0(optV.cardCode)}` : '') +
    ` WHERE ${t0(resolved.invntItem)} = 'Y' AND ${t0(resolved.minInventory)} > 0`;
  const rows = await executeSQL(sql);
  // Normalized to the same shape scanReorderItems() expects from the Service Layer.
  return rows.map(r => ({
    ItemCode: r.ItemCode, ItemName: r.ItemName,
    QuantityOnStock: r.OnHand, MinInventory: r.MinInventory,
    QuantityOrderedFromVendors: r.OnOrder, QuantityOrderedByCustomers: r.Committed,
    LeadTime: r.LeadTime, Mainsupplier: r.Vendor || '', MainsupplierName: r.VendorName || '',
  }));
}

async function analyzeSupplierRisksViaDB(dbDeps) {
  const { getActiveConfig, getActiveType, getTableColumns, resolveFieldMap, tableRef, executeSQL } = dbDeps;
  const cfg    = getActiveConfig();
  const isHana = getActiveType() === 'hana';
  const q      = n => qcol(n, isHana);
  const cols   = await getTableColumns('OPOR');
  const { resolved, missing } = resolveFieldMap(cols, OPOR_SUPPLIER_CANDIDATES);
  if (missing.length) throw new Error(`OPOR field mapping incomplete: ${missing.join(', ')}`);
  const sixMoAgo = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);
  const sql = `SELECT ${q(resolved.docEntry)} AS ${q('DocEntry')}, ${q(resolved.docNum)} AS ${q('DocNum')}, ` +
    `${q(resolved.cardCode)} AS ${q('CardCode')}, ${q(resolved.cardName)} AS ${q('CardName')}, ` +
    `${q(resolved.docDate)} AS ${q('DocDate')}, ${q(resolved.docDueDate)} AS ${q('DocDueDate')}, ` +
    `${q(resolved.docStatus)} AS ${q('DocStatus')}, ${q(resolved.docTotal)} AS ${q('DocTotal')} ` +
    `FROM ${tableRef('OPOR', cfg)} WHERE ${q(resolved.docDate)} >= '${sixMoAgo}' AND ${q(resolved.cancelled)} = 'N'`;
  const rows = await executeSQL(sql);
  // SQL DocStatus is 'O'/'C'; Service Layer's DocumentStatus is 'bost_Open'/'bost_Close' —
  // normalize here so downstream aggregation logic works unchanged for either source.
  return rows.map(r => ({
    DocEntry: r.DocEntry, DocNum: r.DocNum, CardCode: r.CardCode, CardName: r.CardName,
    DocDate: r.DocDate, DocDueDate: r.DocDueDate, DocTotal: r.DocTotal,
    DocumentStatus: r.DocStatus === 'O' ? 'bost_Open' : 'bost_Close',
  }));
}

async function analyzeImpactViaDB(dbDeps, reorderItems) {
  const { getActiveConfig, getActiveType, getTableColumns, resolveFieldMap, tableRef, executeSQL } = dbDeps;
  const shortCodes = [...new Set(
    reorderItems.filter(i => i.urgency === 'CRITICAL' || i.onHand < i.committed || i.onHand <= 0).map(i => i.itemCode)
  )];
  if (!shortCodes.length) return { impactedOrders: [], totalChecked: 0, impactedCount: 0, criticalCount: 0, highCount: 0 };

  const cfg    = getActiveConfig();
  const isHana = getActiveType() === 'hana';
  const q      = n => qcol(n, isHana);
  const today    = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const horizon  = new Date(today.getTime() + 45 * 86400000).toISOString().slice(0, 10);

  const hCols = await getTableColumns('ORDR');
  const { resolved: rH, missing: mH } = resolveFieldMap(hCols, ORDR_IMPACT_CANDIDATES);
  if (mH.length) throw new Error(`ORDR field mapping incomplete: ${mH.join(', ')}`);
  const lCols = await getTableColumns('RDR1');
  const { resolved: rL, missing: mL } = resolveFieldMap(lCols, RDR1_IMPACT_CANDIDATES);
  if (mL.length) throw new Error(`RDR1 field mapping incomplete: ${mL.join(', ')}`);

  const esc    = s => String(s).replace(/'/g, "''");
  const inList = shortCodes.map(c => `'${esc(c)}'`).join(',');
  const ordr   = tableRef('ORDR', cfg);
  const rdr1   = tableRef('RDR1', cfg);

  const sql = `SELECT H.${q(rH.docEntry)} AS ${q('DocEntry')}, H.${q(rH.docNum)} AS ${q('DocNum')}, ` +
    `H.${q(rH.cardCode)} AS ${q('CardCode')}, H.${q(rH.cardName)} AS ${q('CardName')}, ` +
    `H.${q(rH.docDueDate)} AS ${q('DocDueDate')}, H.${q(rH.docTotal)} AS ${q('DocTotal')}, ` +
    `L.${q(rL.itemCode)} AS ${q('ItemCode')}, L.${q(rL.description)} AS ${q('Description')}, L.${q(rL.openQty)} AS ${q('OpenQty')} ` +
    `FROM ${ordr} H INNER JOIN ${rdr1} L ON H.${q(rH.docEntry)} = L.${q(rL.docEntry)} ` +
    `WHERE H.${q(rH.docStatus)} = 'O' AND H.${q(rH.cancelled)} = 'N' ` +
    `AND H.${q(rH.docDueDate)} >= '${todayStr}' AND H.${q(rH.docDueDate)} <= '${horizon}' ` +
    `AND L.${q(rL.itemCode)} IN (${inList}) AND L.${q(rL.openQty)} > 0`;

  const rows = await executeSQL(sql);

  const byOrder = new Map();
  for (const r of rows) {
    if (!byOrder.has(r.DocEntry)) {
      byOrder.set(r.DocEntry, {
        docNum: r.DocNum, docEntry: r.DocEntry, cardCode: r.CardCode, cardName: r.CardName,
        docDueDate: r.DocDueDate, docTotal: Number(r.DocTotal || 0), affectedItems: [],
      });
    }
    byOrder.get(r.DocEntry).affectedItems.push({
      itemCode: r.ItemCode, description: String(r.Description || '').slice(0, 45), openQty: Number(r.OpenQty || 0),
    });
  }

  const impacted = [...byOrder.values()].map(o => {
    const daysLeft = Math.ceil((new Date(o.docDueDate) - today) / 86400000);
    const severity = daysLeft <= 3 ? 'CRITICAL' : daysLeft <= 7 ? 'HIGH' : 'MEDIUM';
    return { ...o, daysLeft, severity, explain: puImpactExplain(o.docDueDate, daysLeft, severity, o.affectedItems) };
  }).sort((a, b) => a.daysLeft - b.daysLeft);

  return {
    impactedOrders: impacted,
    totalChecked:   impacted.length, // DB path is pre-scoped to matching lines, unlike the SL path's fixed 40-order scan window
    impactedCount:  impacted.length,
    criticalCount:  impacted.filter(o => o.severity === 'CRITICAL').length,
    highCount:      impacted.filter(o => o.severity === 'HIGH').length,
  };
}

// ── Reorder scan ──────────────────────────────────────────────────────────────
function transformReorderItems(items) {
  const needReorder = items.filter(i => {
    const onHand = Number(i.QuantityOnStock || 0);
    const minInv = Number(i.MinInventory   || 0);
    return minInv > 0 && onHand < minInv;
  });

  return needReorder.map(i => {
    const onHand      = Number(i.QuantityOnStock           || 0);
    const minInv      = Number(i.MinInventory              || 0);
    const onOrder     = Number(i.QuantityOrderedFromVendors|| 0);
    const committed   = Number(i.QuantityOrderedByCustomers|| 0);
    const shortfall   = Math.max(0, minInv - onHand - onOrder);
    // EOQ based on min inventory as proxy for monthly demand × 12; unit cost unknown so use 1
    const annualDemand = minInv * 12;
    const eoq = calcEOQ(annualDemand, 50, 0.25, 1);

    const suggestedQty = Math.max(shortfall, eoq - onOrder, 1);
    const urgency = onHand <= 0
      ? 'CRITICAL'
      : (onHand + onOrder) < minInv * 0.5
        ? 'HIGH'
        : 'MEDIUM';
    const explain = puReorderExplain({ onHand, minInv, onOrder, shortfall, annualDemand, eoq, suggestedQty, urgency });

    return {
      explain,
      itemCode:     i.ItemCode,
      itemName:     i.ItemName,
      onHand,
      minInventory: minInv,
      onOrder,
      committed,
      shortfall,
      suggestedQty: Math.max(0, Math.round(suggestedQty)),
      eoq:          Math.max(0, eoq),
      urgency,
      leadTimeDays: Number(i.LeadTime || 14),
      // Preferred vendor from the item master ("Name (Code)" when the name is known).
      defaultVendor: i.Mainsupplier ? (i.MainsupplierName ? `${i.MainsupplierName} (${i.Mainsupplier})` : i.Mainsupplier) : '',
      vendorCode:   i.Mainsupplier || '',
    };
  }).sort((a, b) => {
    const u = { CRITICAL: 0, HIGH: 1, MEDIUM: 2 };
    return (u[a.urgency] - u[b.urgency]) || (a.onHand - b.onHand);
  });
}

async function scanReorderItems(sap) {
  const items = await fetchAllPaginated(sap, '/Items', {
    $filter: "ItemType eq 'itItems' and InventoryItem eq 'tYES' and Frozen eq 'tNO'",
    $select: 'ItemCode,ItemName,QuantityOnStock,MinInventory,QuantityOrderedFromVendors,QuantityOrderedByCustomers,LeadTime,Mainsupplier',
    $orderby: 'QuantityOnStock asc',
  }, { pageSize: 100, maxItems: 3000 });
  return transformReorderItems(items);
}

// DB Direct preferred, Service Layer fallback (mirrors the MRP agent's pattern).
async function getReorderItems(sap, dbDeps) {
  if (dbDeps?.isConnected?.()) {
    try {
      const rows = await scanReorderItemsViaDB(dbDeps);
      return { items: transformReorderItems(rows), source: dbDeps.getActiveType() };
    } catch (e) {
      console.warn('[Purchasing/reorder] DB Direct failed, falling back to Service Layer:', e.message);
    }
  }
  return { items: await scanReorderItems(sap), source: 'service-layer' };
}

// ── Supplier risk analysis ────────────────────────────────────────────────────
function transformSupplierRisks(pos) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const vendorMap = {};
  for (const po of pos) {
    if (!vendorMap[po.CardCode]) {
      vendorMap[po.CardCode] = {
        cardCode: po.CardCode, cardName: po.CardName || po.CardCode,
        totalOrders: 0, totalSpend: 0,
        openOrders: 0, overdueOrders: 0,
      };
    }
    const v = vendorMap[po.CardCode];
    v.totalOrders++;
    v.totalSpend += Number(po.DocTotal || 0);
    if (po.DocumentStatus === 'bost_Open') {
      v.openOrders++;
      if (po.DocDueDate && po.DocDueDate < todayStr) v.overdueOrders++;
    }
  }

  const vendors    = Object.values(vendorMap);
  const totalSpend = vendors.reduce((s, v) => s + v.totalSpend, 0);

  vendors.forEach(v => {
    v.spendShare  = totalSpend > 0 ? Math.round(v.totalSpend / totalSpend * 1000) / 10 : 0;
    v.overdueRate = v.openOrders > 0 ? Math.round(v.overdueOrders / v.openOrders * 1000) / 10 : 0;
    v.riskLevel   = (v.overdueOrders > 0 && v.overdueRate > 50)
      ? 'HIGH'
      : (v.overdueRate > 20 || v.spendShare > 40)
        ? 'MEDIUM'
        : 'LOW';
    v.explain = puSupplierExplain(v);
  });

  vendors.sort((a, b) => {
    const r = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    return (r[a.riskLevel] - r[b.riskLevel]) || (b.totalSpend - a.totalSpend);
  });

  const top3Share = vendors.slice(0, 3).reduce((s, v) => s + v.spendShare, 0);
  const overduePOs = pos.filter(
    p => p.DocumentStatus === 'bost_Open' && p.DocDueDate && p.DocDueDate < todayStr
  ).length;

  return {
    vendors:         vendors.slice(0, 60),
    totalVendors:    vendors.length,
    highRisk:        vendors.filter(v => v.riskLevel === 'HIGH').length,
    mediumRisk:      vendors.filter(v => v.riskLevel === 'MEDIUM').length,
    overduePOs,
    concentrationPct: Math.round(top3Share * 10) / 10,
  };
}

async function analyzeSupplierRisks(sap) {
  const sixMoAgo = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);
  const pos = await fetchAllPaginated(sap, '/PurchaseOrders', {
    $filter: `DocDate ge '${sixMoAgo}' and Cancelled eq 'tNO'`,
    $select: 'DocEntry,DocNum,CardCode,CardName,DocDate,DocDueDate,DocumentStatus,DocTotal',
  }, { pageSize: 100, maxItems: 2000 });
  return transformSupplierRisks(pos);
}

// DB Direct preferred, Service Layer fallback.
async function getSupplierRisks(sap, dbDeps) {
  if (dbDeps?.isConnected?.()) {
    try {
      const rows = await analyzeSupplierRisksViaDB(dbDeps);
      return { risks: transformSupplierRisks(rows), source: dbDeps.getActiveType() };
    } catch (e) {
      console.warn('[Purchasing/supplier-risk] DB Direct failed, falling back to Service Layer:', e.message);
    }
  }
  return { risks: await analyzeSupplierRisks(sap), source: 'service-layer' };
}

// ── Impact analysis: SOs at risk due to stock shortfalls ─────────────────────
async function analyzeImpactViaServiceLayer(sap, reorderItems) {
  const today    = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const horizon  = new Date(today.getTime() + 45 * 86400000).toISOString().slice(0, 10);

  // Short items = onHand below committed demand or zero
  const shortSet = new Set(
    reorderItems
      .filter(i => i.urgency === 'CRITICAL' || i.onHand < i.committed || i.onHand <= 0)
      .map(i => i.itemCode)
  );

  if (shortSet.size === 0) {
    return { impactedOrders: [], totalChecked: 0, impactedCount: 0, criticalCount: 0, highCount: 0 };
  }

  const openSOs = await fetchAllPaginated(sap, '/Orders', {
    $filter: `DocumentStatus eq 'bost_Open' and Cancelled eq 'tNO' and DocDueDate ge '${todayStr}' and DocDueDate le '${horizon}'`,
    $select: 'DocEntry,DocNum,CardCode,CardName,DocDueDate,DocTotal',
  }, { pageSize: 30, maxItems: 150 });

  const impacted = [];
  const toCheck  = openSOs.slice(0, 40);
  let   idx      = 0;

  const CONC = 5;
  const workers = Array.from({ length: Math.min(CONC, toCheck.length) }, async () => {
    while (idx < toCheck.length) {
      const so = toCheck[idx++];
      try {
        const full  = await sap.get(`/Orders(${so.DocEntry})`);
        const lines = full.DocumentLines || [];
        const affected = lines.filter(
          l => shortSet.has(l.ItemCode) && Number(l.OpenQty ?? l.Quantity ?? 0) > 0
        );
        if (affected.length > 0) {
          const daysLeft = Math.ceil((new Date(so.DocDueDate) - today) / 86400000);
          const severity = daysLeft <= 3 ? 'CRITICAL' : daysLeft <= 7 ? 'HIGH' : 'MEDIUM';
          impacted.push({
            explain:      puImpactExplain(so.DocDueDate, daysLeft, severity,
              affected.map(l => ({ itemCode: l.ItemCode, openQty: Number(l.OpenQty ?? l.Quantity ?? 0) }))),
            docNum:       so.DocNum,
            docEntry:     so.DocEntry,
            cardCode:     so.CardCode,
            cardName:     so.CardName,
            docDueDate:   so.DocDueDate,
            daysLeft,
            docTotal:     Number(so.DocTotal || 0),
            affectedItems: affected.map(l => ({
              itemCode:    l.ItemCode,
              description: (l.ItemDescription || '').slice(0, 45),
              openQty:     Number(l.OpenQty ?? l.Quantity ?? 0),
            })),
            severity,
          });
        }
      } catch (e) {
        console.warn(`[Purchasing/Impact] SO ${so.DocEntry}:`, e.message);
      }
    }
  });
  await Promise.all(workers);

  impacted.sort((a, b) => a.daysLeft - b.daysLeft);

  return {
    impactedOrders: impacted,
    totalChecked:   toCheck.length,
    impactedCount:  impacted.length,
    criticalCount:  impacted.filter(o => o.severity === 'CRITICAL').length,
    highCount:      impacted.filter(o => o.severity === 'HIGH').length,
  };
}

// DB Direct preferred, Service Layer fallback.
async function getImpactAnalysis(sap, dbDeps, reorderItems) {
  if (dbDeps?.isConnected?.()) {
    try {
      const result = await analyzeImpactViaDB(dbDeps, reorderItems);
      return { ...result, source: dbDeps.getActiveType() };
    } catch (e) {
      console.warn('[Purchasing/impact] DB Direct failed, falling back to Service Layer:', e.message);
    }
  }
  const result = await analyzeImpactViaServiceLayer(sap, reorderItems);
  return { ...result, source: 'service-layer' };
}

// ── AI insights (structured JSON advisory) ───────────────────────────────────
async function getAIInsights(aiDeps, summary) {
  const sys = `You are a Purchasing & Supply Chain AI for SAP Business One.
Return ONLY valid JSON — no markdown fences, no explanation outside the JSON.`;

  const prompt = `Analyse this purchasing situation and return a structured JSON advisory.

Situation:
- Items needing reorder: ${summary.reorderItems} (${summary.critical} CRITICAL zero-stock, ${summary.high} HIGH below 50% min)
- High-risk suppliers: ${summary.highRiskVendors} vendors with overdue open POs
- Overdue purchase orders: ${summary.overduePOs}
- Supply concentration: top 3 vendors = ${summary.concentrationPct}% of spend (${summary.concentrationPct > 60 ? 'DANGEROUS' : summary.concentrationPct > 40 ? 'HIGH' : 'ACCEPTABLE'})
- Sales orders at risk: ${summary.impactedOrders} orders impacted, ${summary.criticalImpact} CRITICAL (due ≤3 days)
- Today: ${new Date().toISOString().slice(0, 10)}

Return JSON with exactly these keys:
{
  "overallRiskLevel": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
  "topPriority": "<single most important action right now — be specific>",
  "immediateActions": ["<action 1>", "<action 2>", "<action 3>"],
  "supplierWarnings": ["<warning 1>", "<warning 2>"],
  "riskSummary": "<2 sentences summarising the overall purchasing risk>",
  "recommendedPOCount": <number of POs to raise today>
}`;

  try {
    const raw   = await callAI(aiDeps, [{ role: 'user', content: prompt }], sys, 700);
    const match = raw.match(/\{[\s\S]+\}/);
    if (match) return JSON.parse(match[0]);
  } catch (e) {
    console.warn('[Purchasing/AI] insights parse failed:', e.message);
  }

  // Rule-based fallback
  return {
    overallRiskLevel:   summary.critical > 0 ? 'CRITICAL' : summary.high > 0 ? 'HIGH' : 'MEDIUM',
    topPriority:        summary.critical > 0
      ? `Raise emergency POs for ${summary.critical} zero-stock items immediately`
      : `Review and action ${summary.reorderItems} items pending reorder`,
    immediateActions: [
      summary.critical > 0 ? `Create POs for ${summary.critical} CRITICAL zero-stock items` : `Review ${summary.high} HIGH urgency reorder items`,
      summary.overduePOs > 0 ? `Chase ${summary.overduePOs} overdue purchase orders` : 'All PO due dates are current',
      summary.impactedOrders > 0 ? `Notify sales team — ${summary.impactedOrders} orders at risk of delay` : 'No sales orders currently at risk',
    ],
    supplierWarnings:   summary.highRiskVendors > 0
      ? [`${summary.highRiskVendors} supplier(s) have overdue open POs — escalate immediately`]
      : ['No critical supplier issues detected'],
    riskSummary: `${summary.reorderItems} items require purchasing attention. ${summary.impactedOrders > 0 ? `${summary.impactedOrders} sales orders may be delayed due to stock shortfalls.` : 'No sales orders are currently impacted.'}`,
    recommendedPOCount: Math.max(summary.critical, Math.ceil(summary.reorderItems / 3)),
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// EXPORTED CORE SCAN
// ══════════════════════════════════════════════════════════════════════════════
export async function runPurchasingScan(sap, { aiDeps = null, dbDeps = null } = {}) {
  const [{ items: reorderItems, source: reorderSource }, { risks: supplierRisks, source: riskSource }] = await Promise.all([
    getReorderItems(sap, dbDeps),
    getSupplierRisks(sap, dbDeps),
  ]);
  // Service Layer items carry only the preferred-vendor code: add the name from the PO history.
  const vendorNames = new Map((supplierRisks.vendors || []).map(v => [v.cardCode, v.cardName]));
  for (const i of reorderItems) {
    if (i.vendorCode && i.defaultVendor === i.vendorCode && vendorNames.get(i.vendorCode)) {
      i.defaultVendor = `${vendorNames.get(i.vendorCode)} (${i.vendorCode})`;
    }
  }

  const impactData = await getImpactAnalysis(sap, dbDeps, reorderItems);

  const summary = {
    reorderItems:     reorderItems.length,
    critical:         reorderItems.filter(i => i.urgency === 'CRITICAL').length,
    high:             reorderItems.filter(i => i.urgency === 'HIGH').length,
    medium:           reorderItems.filter(i => i.urgency === 'MEDIUM').length,
    highRiskVendors:  supplierRisks.highRisk,
    overduePOs:       supplierRisks.overduePOs,
    concentrationPct: supplierRisks.concentrationPct,
    impactedOrders:   impactData.impactedCount,
    criticalImpact:   impactData.criticalCount,
    scannedAt:        new Date().toISOString(),
  };

  const aiInsights = aiDeps ? await getAIInsights(aiDeps, summary) : null;
  const sources = { reorderItems: reorderSource, supplierRisks: riskSource, impactAnalysis: impactData.source };

  return { reorderItems, supplierRisks, impactAnalysis: impactData, summary, aiInsights, sources };
}

// ── Router factory ────────────────────────────────────────────────────────────
export function createPurchasingAgentRouter(deps) {
  const {
    requireAuth, getActiveSap, AI_PROVIDER, USE_AI, gptChatComplete, azureMessagesCreate,
    isConnected, getActiveType, getActiveConfig, executeSQL, tableRef, getTableColumns, resolveFieldMap,
  } = deps;
  const router  = Router();
  const _aiDeps = () => USE_AI ? { AI_PROVIDER, gptChatComplete, azureMessagesCreate } : null;
  const _dbDeps = isConnected
    ? { isConnected, getActiveType, getActiveConfig, executeSQL, tableRef, getTableColumns, resolveFieldMap }
    : null;

  // GET /api/purchasing/scan
  router.get('/scan', requireAuth, async (req, res) => {
    try {
      const result = await runPurchasingScan(getActiveSap(), { aiDeps: _aiDeps(), dbDeps: _dbDeps });
      res.json({ ok: true, ...result });
    } catch (e) {
      console.error('[Purchasing/scan]', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /api/purchasing/chat
  router.post('/chat', requireAuth, async (req, res) => {
    try {
      const { message, sessionId = `pu_${Date.now()}`, context } = req.body || {};
      if (!message?.trim()) return res.status(400).json({ ok: false, error: 'message required' });
      if (!USE_AI) return res.json({ ok: true, reply: 'AI not configured — set ANTHROPIC_API_KEY or Azure credentials.', sessionId });

      const history = _sessions.get(sessionId) || [];
      history.push({ role: 'user', content: message });
      if (history.length > 20) history.splice(0, history.length - 20);
      _sessions.set(sessionId, history);

      const sys = `You are a Purchasing & Supply Chain AI for SAP Business One.
Today: ${new Date().toISOString().slice(0, 10)}.
Expertise: purchase order planning, vendor risk management, inventory replenishment, EOQ analysis, reorder points, supply chain impact, inbound stock delay mitigation.
${context ? `\nCurrent Dashboard Context:\n${JSON.stringify(context, null, 2)}` : ''}
Be concise and action-oriented. Reference specific item codes, vendor names, and document numbers where available. Give clear purchasing recommendations with quantities and priorities.`;

      const reply = await callAI(_aiDeps(), history, sys, 1024);
      history.push({ role: 'assistant', content: reply || 'Unable to process.' });
      res.json({ ok: true, reply: reply || 'Unable to process.', sessionId });
    } catch (e) {
      console.error('[Purchasing/chat]', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return router;
}
