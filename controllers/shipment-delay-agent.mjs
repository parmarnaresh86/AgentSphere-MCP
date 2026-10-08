/**
 * Shipment Delay Prediction Agent — backend controller
 * Mounted at /api/shipment-delays by chat-server.mjs
 *
 * Predicts which open purchase orders are likely to be delayed by combining:
 *  1. Vendor delay history  — overdue rate, avg days late (last 6 months of POs)
 *  2. Open PO risk scoring  — delay probability per PO based on vendor + urgency
 *  3. Sales order impact    — which customer orders depend on at-risk stock
 *  4. AI risk intelligence  — global shipping factors, seasonal patterns, actions
 */

import { Router } from 'express';

const _sessions = new Map();
const HISTORY_MONTHS = 6;

// ── AI helper ─────────────────────────────────────────────────────────────────
async function callAI(aiDeps, messages, systemPrompt, maxTokens = 1200) {
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
    console.warn('[ShipDelay/AI] call failed:', e.message);
  }
  return '';
}

// ── DB Direct (ODBC/HANA) reads, Service Layer fallback ─────────────────────
// Same pattern as the other supply-chain agents: resolve every logical field
// against the LIVE column list before building SQL — never guess — and fall
// back to Service Layer on any connection/mapping failure. HANA folds unquoted
// identifiers to uppercase, so identifiers are quoted on HANA only.
function qcol(name, isHana) { return isHana ? `"${name}"` : name; }

const OPOR_FIELD_CANDIDATES = {
  docEntry: ['DocEntry'], docNum: ['DocNum'], cardCode: ['CardCode'], cardName: ['CardName'],
  docDate: ['DocDate'], docDueDate: ['DocDueDate'], docStatus: ['DocStatus'],
  docTotal: ['DocTotal'], cancelled: ['CANCELED', 'Cancelled'],
};
const POR1_FIELD_CANDIDATES = { docEntry: ['DocEntry'], itemCode: ['ItemCode'] };
const ORDR_FIELD_CANDIDATES = {
  docEntry: ['DocEntry'], docNum: ['DocNum'], cardCode: ['CardCode'], cardName: ['CardName'],
  docDueDate: ['DocDueDate'], docTotal: ['DocTotal'], docStatus: ['DocStatus'], cancelled: ['CANCELED', 'Cancelled'],
};
const RDR1_FIELD_CANDIDATES = {
  docEntry: ['DocEntry'], itemCode: ['ItemCode'], openQty: ['OpenQty'], description: ['Dscription'],
};

// Fetches OPOR headers. `fromDate` filters DocDate >= fromDate (history window);
// `openOnly` filters DocStatus = 'O'. Normalized to the Service Layer's shape.
async function fetchPOsViaDB(dbDeps, { fromDate, openOnly } = {}) {
  const { getActiveConfig, getActiveType, getTableColumns, resolveFieldMap, tableRef, executeSQL } = dbDeps;
  const cfg    = getActiveConfig();
  const isHana = getActiveType() === 'hana';
  const q      = n => qcol(n, isHana);
  const cols   = await getTableColumns('OPOR');
  const { resolved, missing } = resolveFieldMap(cols, OPOR_FIELD_CANDIDATES);
  if (missing.length) throw new Error(`OPOR field mapping incomplete: ${missing.join(', ')}`);

  const conds = [`${q(resolved.cancelled)} = 'N'`];
  if (fromDate) conds.push(`${q(resolved.docDate)} >= '${fromDate}'`);
  if (openOnly) conds.push(`${q(resolved.docStatus)} = 'O'`);

  const sql = `SELECT ${q(resolved.docEntry)} AS ${q('DocEntry')}, ${q(resolved.docNum)} AS ${q('DocNum')}, ` +
    `${q(resolved.cardCode)} AS ${q('CardCode')}, ${q(resolved.cardName)} AS ${q('CardName')}, ` +
    `${q(resolved.docDate)} AS ${q('DocDate')}, ${q(resolved.docDueDate)} AS ${q('DocDueDate')}, ` +
    `${q(resolved.docTotal)} AS ${q('DocTotal')}, ${q(resolved.docStatus)} AS ${q('Status')} ` +
    `FROM ${tableRef('OPOR', cfg)} WHERE ${conds.join(' AND ')}`;
  const rows = await executeSQL(sql);
  return rows.map(r => ({
    DocEntry: r.DocEntry, DocNum: r.DocNum, CardCode: r.CardCode, CardName: r.CardName,
    DocDate: r.DocDate, DocDueDate: r.DocDueDate, DocTotal: r.DocTotal,
    DocumentStatus: r.Status === 'O' ? 'bost_Open' : 'bost_Close',
  }));
}

// Fetches POR1 item codes for a set of PO DocEntries, grouped by order.
async function fetchPOLineItemsViaDB(dbDeps, docEntries) {
  const linesByOrder = new Map();
  if (!docEntries.length) return linesByOrder;
  const { getActiveConfig, getActiveType, getTableColumns, resolveFieldMap, tableRef, executeSQL } = dbDeps;
  const cfg    = getActiveConfig();
  const isHana = getActiveType() === 'hana';
  const q      = n => qcol(n, isHana);
  const cols   = await getTableColumns('POR1');
  const { resolved, missing } = resolveFieldMap(cols, POR1_FIELD_CANDIDATES);
  if (missing.length) throw new Error(`POR1 field mapping incomplete: ${missing.join(', ')}`);

  const inList = docEntries.join(',');
  const sql = `SELECT ${q(resolved.docEntry)} AS ${q('DocEntry')}, ${q(resolved.itemCode)} AS ${q('ItemCode')} ` +
    `FROM ${tableRef('POR1', cfg)} WHERE ${q(resolved.docEntry)} IN (${inList})`;
  const rows = await executeSQL(sql);
  for (const r of rows) {
    if (!linesByOrder.has(r.DocEntry)) linesByOrder.set(r.DocEntry, []);
    linesByOrder.get(r.DocEntry).push({ ItemCode: r.ItemCode });
  }
  return linesByOrder;
}

// Fetches open ORDR headers due within [fromDate, toDate].
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
  const rows = await executeSQL(sql);
  return rows;
}

// Fetches RDR1 lines for a set of SO DocEntries, grouped by order.
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

// ── Step 1: build vendor delay history from recent POs ────────────────────────
// DB Direct (ODBC/HANA) preferred, Service Layer fallback.
// ── "How is this calculated?" popups ─────────────────────────────────────────
// Built from the same variables used to compute each value, so they cannot drift.
function sdVendorSteps(v) {
  return [
    { label: 'Open POs', formula: `Purchase orders still open (last ${HISTORY_MONTHS} months)`, value: v.openPOs },
    { label: 'Overdue POs', formula: 'Open POs past their due date', value: v.overduePOs },
    { label: 'Overdue rate', formula: `Overdue ${v.overduePOs} ÷ open ${v.openPOs} × 100`, value: `${v.overdueRate}%` },
  ];
}

function sdVendorExplain(v) {
  const r = v.overdueRate;
  return {
    reliability: {
      title: `Why the vendor is "${v.reliability}"`,
      steps: sdVendorSteps(v),
      rules: [
        { rule: 'Overdue rate is 0%', result: 'Reliable', hit: r === 0 },
        { rule: 'Overdue rate up to 15%', result: 'Generally On-Time', hit: r > 0 && r <= 15 },
        { rule: 'Overdue rate 16–40%', result: 'Occasionally Late', hit: r > 15 && r <= 40 },
        { rule: 'Overdue rate 41–70%', result: 'Frequently Delayed', hit: r > 40 && r <= 70 },
        { rule: 'Overdue rate above 70%', result: 'Unreliable', hit: r > 70 },
      ],
    },
    riskLevel: {
      title: `Why vendor risk is ${v.riskLevel}`,
      steps: sdVendorSteps(v),
      rules: [
        { rule: 'Overdue rate 50% or more', result: 'HIGH', hit: r >= 50 },
        { rule: 'Overdue rate 20–49%', result: 'MEDIUM', hit: r >= 20 && r < 50 },
        { rule: 'Overdue rate below 20%', result: 'LOW', hit: r < 20 },
      ],
    },
  };
}

function sdPoExplain({ vs, known, dueDate, daysUntilDue, isOverdue, daysOverdue, urgencyMult, delayProb, risk }) {
  const rateNote = known ? `Vendor's overdue rate (open POs past due ÷ open POs)` : 'No history for this vendor — default 10% used';
  let steps;
  if (isOverdue) {
    steps = [
      { label: 'Days overdue', formula: `Due ${String(dueDate || '').slice(0, 10)} — already past due`, value: daysOverdue },
      { label: 'Delay probability', formula: `90% + ${Math.min(daysOverdue, 30)} day(s) × 0.3% (days capped at 30), max 99%`, value: `${delayProb}%` },
    ];
  } else if (daysUntilDue === null) {
    steps = [
      { label: 'Vendor overdue rate', formula: rateNote, value: `${vs.overdueRate}%` },
      { label: 'Delay probability', formula: `No due date — overdue rate ${vs.overdueRate}% × 0.5`, value: `${delayProb}%` },
    ];
  } else {
    steps = [
      { label: 'Vendor overdue rate', formula: rateNote, value: `${vs.overdueRate}%` },
      { label: 'Days until due', formula: `Due ${String(dueDate || '').slice(0, 10)} − today`, value: daysUntilDue },
      { label: 'Urgency multiplier', formula: '≤2 days ×2.2 · ≤5 ×1.6 · ≤10 ×1.1 · ≤21 ×0.7 · later ×0.4', value: `×${urgencyMult}` },
      { label: 'Delay probability', formula: `${vs.overdueRate}% × ${urgencyMult} + 5% base, max 95%`, value: `${delayProb}%` },
    ];
  }
  const probRules = [
    { rule: 'PO is already overdue', result: '90% + 0.3% per day overdue (max 99%)', hit: isOverdue },
    { rule: 'PO has no due date', result: 'Vendor overdue rate × 0.5', hit: !isOverdue && daysUntilDue === null },
    { rule: 'PO not yet due', result: 'Vendor overdue rate × urgency multiplier + 5% (max 95%)', hit: !isOverdue && daysUntilDue !== null },
  ];
  return {
    delayProb: { title: `How delay probability ${delayProb}% is calculated`, steps, rules: probRules },
    risk: {
      title: `Why PO risk is ${risk}`,
      steps,
      rules: [
        { rule: 'Delay probability 80% or more, or PO already overdue', result: 'CRITICAL', hit: risk === 'CRITICAL' },
        { rule: 'Delay probability 50–79%', result: 'HIGH', hit: risk === 'HIGH' },
        { rule: 'Delay probability 25–49%', result: 'MEDIUM', hit: risk === 'MEDIUM' },
        { rule: 'Delay probability below 25%', result: 'LOW', hit: risk === 'LOW' },
      ],
    },
  };
}

async function buildVendorHistory(sap, dbDeps) {
  const today    = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const histStart= new Date(today.getTime() - HISTORY_MONTHS * 30 * 86400000).toISOString().slice(0, 10);

  let allPOs, source = 'service-layer';
  if (dbDeps?.isConnected?.()) {
    try {
      allPOs = await fetchPOsViaDB(dbDeps, { fromDate: histStart });
      source = dbDeps.getActiveType();
    } catch (dbErr) {
      console.warn('[ShipDelay/history] DB Direct failed, falling back to Service Layer:', dbErr.message);
    }
  }
  if (!allPOs) {
    allPOs = await fetchAllPaginated(sap, '/PurchaseOrders', {
      $filter: `DocDate ge '${histStart}' and Cancelled eq 'tNO'`,
      $select: 'DocEntry,CardCode,CardName,DocDate,DocDueDate,DocumentStatus,DocTotal',
    }, { pageSize: 100, maxItems: 3000 });
    source = 'service-layer';
  }

  const vendorMap = {};
  for (const po of allPOs) {
    const cc = po.CardCode;
    if (!vendorMap[cc]) {
      vendorMap[cc] = {
        cardCode:      cc,
        cardName:      po.CardName || cc,
        totalPOs:      0,
        openPOs:       0,
        overduePOs:    0,
        totalDelayDays:0,
        maxDelayDays:  0,
        totalSpend:    0,
      };
    }
    const v = vendorMap[cc];
    v.totalPOs++;
    v.totalSpend += Number(po.DocTotal || 0);

    if (po.DocumentStatus === 'bost_Open') {
      v.openPOs++;
      if (po.DocDueDate && po.DocDueDate < todayStr) {
        const delayDays = Math.ceil((today - new Date(po.DocDueDate)) / 86400000);
        v.overduePOs++;
        v.totalDelayDays += delayDays;
        v.maxDelayDays = Math.max(v.maxDelayDays, delayDays);
      }
    }
  }

  const list = Object.values(vendorMap);
  const grandSpend = list.reduce((t, v) => t + v.totalSpend, 0);
  list.forEach(v => {
    // Share of all PO value in the look-back window placed with this vendor (%).
    v.spendShare    = grandSpend > 0 ? Math.round(v.totalSpend / grandSpend * 1000) / 10 : 0;
    v.overdueRate   = v.openPOs > 0 ? Math.round(v.overduePOs / v.openPOs * 100) : 0;
    v.avgDelayDays  = v.overduePOs > 0 ? Math.round(v.totalDelayDays / v.overduePOs) : 0;
    v.reliability   = v.overdueRate === 0 ? 'Reliable'
                    : v.overdueRate <= 15  ? 'Generally On-Time'
                    : v.overdueRate <= 40  ? 'Occasionally Late'
                    : v.overdueRate <= 70  ? 'Frequently Delayed'
                    : 'Unreliable';
    v.riskLevel     = v.overdueRate >= 50  ? 'HIGH'
                    : v.overdueRate >= 20  ? 'MEDIUM'
                    : 'LOW';
    v.explain       = sdVendorExplain(v);
  });

  // Return as map (keyed by CardCode) and list
  const map  = Object.fromEntries(list.map(v => [v.cardCode, v]));
  return { map, list: list.sort((a, b) => b.overdueRate - a.overdueRate || b.totalPOs - a.totalPOs), source };
}

// ── Step 2: score all open POs ────────────────────────────────────────────────
// DB Direct (ODBC/HANA) preferred, Service Layer fallback.
async function scoreOpenPOs(sap, vendorMap, dbDeps) {
  const today    = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  let openPOs;
  if (dbDeps?.isConnected?.()) {
    try {
      openPOs = await fetchPOsViaDB(dbDeps, { openOnly: true });
    } catch (dbErr) {
      console.warn('[ShipDelay/openPOs] DB Direct failed, falling back to Service Layer:', dbErr.message);
    }
  }
  if (!openPOs) {
    openPOs = await fetchAllPaginated(sap, '/PurchaseOrders', {
      $filter: `DocumentStatus eq 'bost_Open' and Cancelled eq 'tNO'`,
      $select: 'DocEntry,DocNum,CardCode,CardName,DocDate,DocDueDate,DocTotal',
    }, { pageSize: 100, maxItems: 2000 });
  }

  const scored = openPOs.map(po => {
    const vs          = vendorMap[po.CardCode] || { overdueRate: 10, avgDelayDays: 0, riskLevel: 'LOW', reliability: 'Unknown' };
    const daysUntilDue= po.DocDueDate ? Math.ceil((new Date(po.DocDueDate) - today) / 86400000) : null;
    const isOverdue   = daysUntilDue !== null && daysUntilDue < 0;
    const daysOverdue = isOverdue ? Math.abs(daysUntilDue) : 0;

    // Delay probability: vendor base rate amplified by urgency
    let prob, urgencyMult = null;
    if (isOverdue) {
      prob = Math.min(0.90 + Math.min(daysOverdue, 30) * 0.003, 0.99);
    } else if (daysUntilDue === null) {
      prob = vs.overdueRate / 100 * 0.5;
    } else {
      const urgency = daysUntilDue <= 2  ? 2.2
                    : daysUntilDue <= 5  ? 1.6
                    : daysUntilDue <= 10 ? 1.1
                    : daysUntilDue <= 21 ? 0.7
                    : 0.4;
      urgencyMult = urgency;
      prob = Math.min((vs.overdueRate / 100) * urgency + (isOverdue ? 0 : 0.05), 0.95);
    }

    const delayProb = Math.round(prob * 100);
    const risk = delayProb >= 80 || isOverdue ? 'CRITICAL'
               : delayProb >= 50              ? 'HIGH'
               : delayProb >= 25              ? 'MEDIUM'
               : 'LOW';

    // Calculate PO age (days since created)
    const poAgedays = po.DocDate
      ? Math.ceil((today - new Date(po.DocDate)) / 86400000)
      : null;

    return {
      docNum:            po.DocNum,
      docEntry:          po.DocEntry,
      cardCode:          po.CardCode,
      cardName:          po.CardName,
      docDate:           po.DocDate,
      docDueDate:        po.DocDueDate,
      daysUntilDue,
      isOverdue,
      daysOverdue,
      poAgeDays:         poAgedays,
      docTotal:          Number(po.DocTotal || 0),
      delayProbability:  delayProb,
      risk,
      vendorOverdueRate: vs.overdueRate,
      vendorAvgDelay:    vs.avgDelayDays,
      vendorReliability: vs.reliability,
      explain:           sdPoExplain({ vs, known: !!vendorMap[po.CardCode], dueDate: po.DocDueDate, daysUntilDue, isOverdue, daysOverdue, urgencyMult, delayProb, risk }),
    };
  });

  scored.sort((a, b) => {
    const r = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
    return (r[a.risk] - r[b.risk]) || (a.daysUntilDue ?? 999) - (b.daysUntilDue ?? 999);
  });

  return scored;
}

// ── Step 3: map delayed POs to impacted sales orders ─────────────────────────
// DB Direct (ODBC/HANA) preferred (batched queries instead of one HTTP round-trip
// per PO/SO), Service Layer fallback.
async function findImpactedSOs(sap, atRiskPOs, dbDeps) {
  if (atRiskPOs.length === 0) return [];

  const today    = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const horizon  = new Date(today.getTime() + 60 * 86400000).toISOString().slice(0, 10);
  const criticalPOs = atRiskPOs.filter(p => p.risk === 'CRITICAL' || p.risk === 'HIGH').slice(0, 20);

  if (dbDeps?.isConnected?.()) {
    try {
      return await findImpactedSOsViaDB(dbDeps, criticalPOs, { todayStr, horizon });
    } catch (dbErr) {
      console.warn('[ShipDelay/impact] DB Direct failed, falling back to Service Layer:', dbErr.message);
    }
  }
  return findImpactedSOsViaServiceLayer(sap, criticalPOs, { todayStr, horizon });
}

async function findImpactedSOsViaDB(dbDeps, criticalPOs, { todayStr, horizon }) {
  const today = new Date();
  const poLines = await fetchPOLineItemsViaDB(dbDeps, criticalPOs.map(p => p.docEntry));

  const atRiskItems = new Set();
  const itemToPO = {};
  for (const po of criticalPOs) {
    for (const l of (poLines.get(po.docEntry) || [])) {
      if (!l.ItemCode) continue;
      atRiskItems.add(l.ItemCode);
      if (!itemToPO[l.ItemCode]) itemToPO[l.ItemCode] = [];
      itemToPO[l.ItemCode].push({ poNum: po.docNum, vendor: po.cardName, risk: po.risk, delayProb: po.delayProbability });
    }
  }
  if (atRiskItems.size === 0) return [];

  const openSOs = await fetchOpenSOsInRangeViaDB(dbDeps, { fromDate: todayStr, toDate: horizon });
  if (!openSOs.length) return [];
  const soCheck = openSOs.slice(0, 25);
  const soLinesByOrder = await fetchSOLineItemsViaDB(dbDeps, soCheck.map(s => s.DocEntry));

  const impacted = [];
  for (const so of soCheck) {
    const lines = (soLinesByOrder.get(so.DocEntry) || []).filter(l => atRiskItems.has(l.ItemCode));
    if (lines.length > 0) {
      const daysLeft = so.DocDueDate ? Math.ceil((new Date(so.DocDueDate) - today) / 86400000) : null;
      impacted.push({
        docNum:    so.DocNum,
        cardName:  so.CardName,
        cardCode:  so.CardCode,
        dueDate:   so.DocDueDate,
        daysLeft,
        docTotal:  Number(so.DocTotal || 0),
        atRiskLines: lines.map(l => ({
          itemCode: l.ItemCode,
          desc:     (l.Description || '').slice(0, 40),
          openQty:  Number(l.OpenQty || 0),
          poRisk:   itemToPO[l.ItemCode]?.[0] || null,
        })),
      });
    }
  }
  return impacted.sort((a, b) => (a.daysLeft ?? 999) - (b.daysLeft ?? 999));
}

async function findImpactedSOsViaServiceLayer(sap, criticalPOs, { todayStr, horizon }) {
  const today = new Date();

  // Fetch open SOs due in the next 60 days
  const openSOs = await fetchAllPaginated(sap, '/Orders', {
    $filter: `DocumentStatus eq 'bost_Open' and Cancelled eq 'tNO' and DocDueDate ge '${todayStr}' and DocDueDate le '${horizon}'`,
    $select: 'DocEntry,DocNum,CardCode,CardName,DocDueDate,DocTotal',
  }, { pageSize: 50, maxItems: 200 });

  if (!openSOs.length) return [];

  // Get items from at-risk POs (fetch lines for critical/high risk POs only)
  const atRiskItems = new Set();
  const itemToPO = {};

  let idx = 0;
  const CONC = 4;
  const workers = Array.from({ length: Math.min(CONC, criticalPOs.length) }, async () => {
    while (idx < criticalPOs.length) {
      const po = criticalPOs[idx++];
      try {
        const full  = await sap.get(`/PurchaseOrders(${po.docEntry})`);
        const lines = full.DocumentLines || [];
        for (const l of lines) {
          if (l.ItemCode) {
            atRiskItems.add(l.ItemCode);
            if (!itemToPO[l.ItemCode]) itemToPO[l.ItemCode] = [];
            itemToPO[l.ItemCode].push({ poNum: po.docNum, vendor: po.cardName, risk: po.risk, delayProb: po.delayProbability });
          }
        }
      } catch (e) {
        console.warn(`[ShipDelay/impact] PO ${po.docEntry}:`, e.message);
      }
    }
  });
  await Promise.all(workers);

  if (atRiskItems.size === 0) return [];

  // Check open SOs against at-risk items (sample top 25 most urgent)
  const impacted = [];
  const soCheck  = openSOs.slice(0, 25);
  let soIdx = 0;
  const soWorkers = Array.from({ length: Math.min(4, soCheck.length) }, async () => {
    while (soIdx < soCheck.length) {
      const so = soCheck[soIdx++];
      try {
        const full  = await sap.get(`/Orders(${so.DocEntry})`);
        const lines = (full.DocumentLines || []).filter(l => atRiskItems.has(l.ItemCode));
        if (lines.length > 0) {
          const daysLeft = so.DocDueDate ? Math.ceil((new Date(so.DocDueDate) - today) / 86400000) : null;
          impacted.push({
            docNum:    so.DocNum,
            cardName:  so.CardName,
            cardCode:  so.CardCode,
            dueDate:   so.DocDueDate,
            daysLeft,
            docTotal:  Number(so.DocTotal || 0),
            atRiskLines: lines.map(l => ({
              itemCode: l.ItemCode,
              desc:     (l.ItemDescription || '').slice(0, 40),
              openQty:  Number(l.OpenQty ?? l.Quantity ?? 0),
              poRisk:   itemToPO[l.ItemCode]?.[0] || null,
            })),
          });
        }
      } catch {}
    }
  });
  await Promise.all(soWorkers);

  return impacted.sort((a, b) => (a.daysLeft ?? 999) - (b.daysLeft ?? 999));
}

// ── Step 4: AI risk intelligence with global factors ─────────────────────────
async function getAIIntelligence(aiDeps, summary, topPOs, vendorList) {
  const sys = `You are a Supply Chain Risk AI specializing in global shipment delay prediction.
Today: ${new Date().toISOString().slice(0, 10)}.
You have knowledge of global shipping disruptions, seasonal patterns, port congestion trends, and geopolitical risks up to mid-2025.
Return ONLY valid JSON — no markdown, no text outside the JSON.`;

  const topPOSnap = topPOs.slice(0, 6).map(p => ({
    poNum: p.docNum, vendor: p.cardName, dueDate: p.docDueDate,
    daysUntilDue: p.daysUntilDue, isOverdue: p.isOverdue,
    delayProb: p.delayProbability + '%', risk: p.risk, value: p.docTotal,
  }));

  const topVendorSnap = vendorList.slice(0, 5).map(v => ({
    vendor: v.cardName, overdueRate: v.overdueRate + '%',
    avgDelay: v.avgDelayDays + 'd', openPOs: v.openPOs, reliability: v.reliability,
  }));

  const currentMonth = new Date().toLocaleString('en-US', { month: 'long' });

  const prompt = `Analyse this shipment delay situation and provide AI-powered risk intelligence.

Situation:
- ${summary.totalOpen} open purchase orders
- ${summary.overdueCount} already overdue (${summary.overdueValueK}K value)
- ${summary.criticalCount} CRITICAL + ${summary.highCount} HIGH delay risk
- Overall average vendor delay rate: ${summary.avgOverdueRate}%
- Current month: ${currentMonth}

Top at-risk POs: ${JSON.stringify(topPOSnap)}
Top vendors by delay risk: ${JSON.stringify(topVendorSnap)}

Return JSON with exactly these keys:
{
  "overallRisk": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
  "headline": "<one sentence: current state of shipment risk>",
  "globalFactors": [
    "<global/regional factor currently affecting shipping lanes or supply chains>",
    "<second factor>",
    "<third factor — could be seasonal, geopolitical, or logistics-related>"
  ],
  "seasonalRisk": "<current month seasonal shipping risk — e.g. peak season, Chinese New Year window, year-end congestion>",
  "topRiskVendor": "<vendor name with highest predicted delay risk>",
  "topRiskReason": "<one sentence explaining why this vendor is highest risk>",
  "immediateActions": [
    "<specific action to take today>",
    "<second action>",
    "<third action>"
  ],
  "mitigationTip": "<one strategic tip to reduce future shipment delays>"
}`;

  try {
    const raw   = await callAI(aiDeps, [{ role: 'user', content: prompt }], sys, 800);
    const match = raw.match(/\{[\s\S]+\}/);
    if (match) return JSON.parse(match[0]);
  } catch (e) {
    console.warn('[ShipDelay/AI] intelligence parse failed:', e.message);
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════════════════
// EXPORTED CORE SCAN
// ══════════════════════════════════════════════════════════════════════════════
export async function runShipmentDelayScan(sap, { aiDeps = null, dbDeps = null } = {}) {
  const { map: vendorMap, list: vendorList, source } = await buildVendorHistory(sap, dbDeps);
  const scoredPOs = await scoreOpenPOs(sap, vendorMap, dbDeps);
  const atRisk    = scoredPOs.filter(p => p.risk === 'CRITICAL' || p.risk === 'HIGH');
  const impacted  = await findImpactedSOs(sap, atRisk, dbDeps);

  const overduePos    = scoredPOs.filter(p => p.isOverdue);
  const overdueValue  = overduePos.reduce((s, p) => s + p.docTotal, 0);
  const allOverdueRates = vendorList.filter(v => v.openPOs > 0).map(v => v.overdueRate);
  const avgOverdueRate  = allOverdueRates.length
    ? Math.round(allOverdueRates.reduce((s, r) => s + r, 0) / allOverdueRates.length) : 0;

  const summary = {
    totalOpen:      scoredPOs.length,
    overdueCount:   overduePos.length,
    criticalCount:  scoredPOs.filter(p => p.risk === 'CRITICAL').length,
    highCount:      scoredPOs.filter(p => p.risk === 'HIGH').length,
    mediumCount:    scoredPOs.filter(p => p.risk === 'MEDIUM').length,
    overdueValueK:  Math.round(overdueValue / 1000),
    avgOverdueRate,
    impactedSOCount:impacted.length,
    totalVendors:   vendorList.length,
    source,
  };

  const aiIntelligence = aiDeps
    ? await getAIIntelligence(aiDeps, summary, atRisk, vendorList)
    : null;

  return { scoredPOs, vendorList, impactedSOs: impacted, summary, aiIntelligence };
}

// ── Router factory ────────────────────────────────────────────────────────────
export function createShipmentDelayRouter(deps) {
  const {
    requireAuth, getActiveSap, AI_PROVIDER, USE_AI, gptChatComplete, azureMessagesCreate,
    isConnected, getActiveType, getActiveConfig, executeSQL, tableRef, getTableColumns, resolveFieldMap,
  } = deps;
  const router  = Router();
  const _aiDeps = () => USE_AI ? { AI_PROVIDER, gptChatComplete, azureMessagesCreate } : null;
  const _dbDeps = isConnected
    ? { isConnected, getActiveType, getActiveConfig, executeSQL, tableRef, getTableColumns, resolveFieldMap }
    : null;

  // GET /api/shipment-delays/scan
  router.get('/scan', requireAuth, async (req, res) => {
    try {
      const result = await runShipmentDelayScan(getActiveSap(), { aiDeps: _aiDeps(), dbDeps: _dbDeps });

      // Normalize field names for the frontend
      const atRiskPOs = result.scoredPOs
        .filter(p => p.risk !== 'LOW')
        .map(p => ({
          ...p,
          vendorName:    p.cardName,
          riskTag:       p.risk,
          delayProbPct:  p.delayProbability,
          daysLeft:      p.daysUntilDue,
          tags: [
            p.isOverdue                               ? `${p.daysOverdue}d overdue`  : null,
            p.vendorReliability !== 'Reliable' &&
            p.vendorReliability !== 'Unknown'         ? p.vendorReliability           : null,
          ].filter(Boolean),
        }));

      const vendors = result.vendorList.map(v => ({
        ...v,
        vendorCode: v.cardCode,
        vendorName: v.cardName,
      }));

      // Flatten SO impact to one row per (SO × item) for the table
      const impactedSOs = result.impactedSOs.flatMap(s =>
        (s.atRiskLines || [{ itemCode: '—', desc: '—', poRisk: null }]).map(l => ({
          soNum:        s.docNum,
          customerName: s.cardName,
          soDueDate:    s.dueDate,
          itemCode:     l.itemCode,
          itemDesc:     l.desc || '',
          poNum:        l.poRisk?.poNum  || '—',
          delayProbPct: l.poRisk?.delayProb || 0,
        }))
      );

      const summary = {
        totalPOs:        result.summary.totalOpen,
        atRisk:          result.summary.criticalCount + result.summary.highCount + result.summary.mediumCount,
        critical:        result.summary.criticalCount,
        high:            result.summary.highCount,
        impactedSOCount: result.summary.impactedSOCount,
        riskyVendors:    result.vendorList.filter(v => v.riskLevel === 'HIGH').length,
        source:          result.summary.source,
      };

      res.json({ ok: true, atRiskPOs, vendors, impactedSOs, summary, aiAdvisory: result.aiIntelligence });
    } catch (e) {
      console.error('[ShipDelay/scan]', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /api/shipment-delays/chat
  router.post('/chat', requireAuth, async (req, res) => {
    try {
      const { message, sessionId = `sd_${Date.now()}`, context } = req.body || {};
      if (!message?.trim()) return res.status(400).json({ ok: false, error: 'message required' });
      if (!USE_AI) return res.json({ ok: true, reply: 'AI not configured.', sessionId });

      const history = _sessions.get(sessionId) || [];
      history.push({ role: 'user', content: message });
      if (history.length > 20) history.splice(0, history.length - 20);
      _sessions.set(sessionId, history);

      const sys = `You are a Supply Chain Risk AI specializing in shipment delay prediction for SAP Business One.
Today: ${new Date().toISOString().slice(0, 10)}.
Expertise: vendor reliability analysis, global shipping disruptions, port congestion, seasonal patterns, delay probability modelling, mitigation strategies.
${context ? `\nCurrent Dashboard Context:\n${JSON.stringify(context, null, 2)}` : ''}
Be specific: reference PO numbers, vendor names, delay probabilities, and global risk factors. Give actionable, prioritised recommendations.`;

      const reply = await callAI(_aiDeps(), history, sys, 1024);
      history.push({ role: 'assistant', content: reply || 'Unable to process.' });
      res.json({ ok: true, reply: reply || 'Unable to process.', sessionId });
    } catch (e) {
      console.error('[ShipDelay/chat]', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return router;
}
