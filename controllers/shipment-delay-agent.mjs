/**
 * Shipment Delay Prediction Agent — backend controller
 * Mounted at /api/shipment-delays by chat-server.mjs
 *
 * Predicts which open purchase orders are likely to be delayed by combining:
 * All SAP data is read through DB Direct (MSSQL / HANA) — no Service Layer.
 *
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

// ── DB Direct (ODBC/HANA) reads ──────────────────────────────────────────────
// Same pattern as the other supply-chain agents: resolve every logical field
// against the LIVE column list before building SQL — never guess — and fall
// fail loudly on a connection/mapping problem. HANA folds unquoted
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
// `openOnly` filters DocStatus = 'O'. Field names follow SAP's document shape.
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

// ── Step 1: build vendor delay history from recent POs ────────────────────────
// DB Direct (ODBC/HANA) only.
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

  const allPOs = await fetchPOsViaDB(dbDeps, { fromDate: histStart });
  const source = dbDeps.getActiveType();

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
// DB Direct (ODBC/HANA) only.
async function scoreOpenPOs(sap, vendorMap, dbDeps) {
  const today    = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  const openPOs = await fetchPOsViaDB(dbDeps, { openOnly: true });

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
// DB Direct (ODBC/HANA): batched queries for the PO lines, SOs and SO lines.
const SO_IMPACT_DB = { pos: 200, sos: 300 };   // risky POs × open SOs checked
async function findImpactedSOs(sap, atRiskPOs, dbDeps) {
  if (atRiskPOs.length === 0) return [];

  const today    = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const horizon  = new Date(today.getTime() + 60 * 86400000).toISOString().slice(0, 10);
  const riskyPOs = atRiskPOs.filter(p => p.risk === 'CRITICAL' || p.risk === 'HIGH');
  return findImpactedSOsViaDB(dbDeps, riskyPOs.slice(0, SO_IMPACT_DB.pos), { todayStr, horizon });
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
      itemToPO[l.ItemCode].push({ poNum: po.docNum, vendor: po.cardName, risk: po.risk, delayProb: po.delayProbability, poDue: po.docDueDate ? String(po.docDueDate).slice(0, 10) : null, poOverdue: po.isOverdue });
    }
  }
  if (atRiskItems.size === 0) return [];

  const openSOs = await fetchOpenSOsInRangeViaDB(dbDeps, { fromDate: todayStr, toDate: horizon });
  if (!openSOs.length) return [];
  const soCheck = openSOs.slice(0, SO_IMPACT_DB.sos);
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
  const prodImpact = await findImpactedProdOrders(sap, atRisk, dbDeps);

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

  return { scoredPOs, vendorList, impactedSOs: impacted, prodImpact, summary, aiIntelligence };
}

// ── Step 3b: production orders that need components from delayed POs ────────
// Planned / released production orders due within 60 days whose component
// (WOR1) still has quantity to issue and is on a CRITICAL/HIGH open PO line.
// Impact per component:
//   COVERED  — stock on hand (OITM.OnHand, all warehouses) ≥ remaining to issue
//   STOP     — not covered AND the PO is overdue or due after the order's start
//   AT RISK  — not covered, PO due on/before the start but itself at risk
const PROD_HORIZON_DAYS = 60;
const sqlList = vals => [...vals].map(v => `'${String(v).replace(/'/g, "''")}'`).join(',');
function prodImpactLevel({ remaining, onHand, poOverdue, poDue, startDate }) {
  if (onHand != null && onHand >= remaining) return 'COVERED';
  if (poOverdue || (poDue && startDate && String(poDue).slice(0, 10) > String(startDate).slice(0, 10))) return 'STOP';
  return 'AT RISK';
}
async function findImpactedProdOrders(sap, atRiskPOs, dbDeps) {
  if (!atRiskPOs.length) return [];
  const today = new Date();
  const horizon = new Date(today.getTime() + PROD_HORIZON_DAYS * 86400000).toISOString().slice(0, 10);
  const pos = atRiskPOs.filter(p => p.risk === 'CRITICAL' || p.risk === 'HIGH');
  const linkOf = p => ({ poNum: p.docNum, vendor: p.cardName, poDue: p.docDueDate ? String(p.docDueDate).slice(0, 10) : null,
    poOverdue: p.isOverdue, delayProb: p.delayProbability, risk: p.risk });
  const build = (r, itemToPO, stock) => {
    const link = itemToPO.get(r.compItem);
    const remaining = Math.max(0, Number(r.planned || 0) - Number(r.issued || 0));
    const st = stock.get(r.compItem);
    const onHand = st ? st.onHand : null;
    const startDate = r.startDate ? String(r.startDate).slice(0, 10) : null;
    return {
      prodNum: r.docNum, prodEntry: r.docEntry, prodItem: r.prodItem, prodName: String(r.prodName || '').slice(0, 50),
      status: r.status === 'R' || r.status === 'boposReleased' ? 'Released' : 'Planned', prodQty: Number(r.prodQty || 0),
      startDate, dueDate: r.dueDate ? String(r.dueDate).slice(0, 10) : null,
      daysToStart: startDate ? Math.ceil((new Date(startDate) - today) / 86400000) : null,
      compItem: r.compItem, compName: String(st?.name || r.compName || '').slice(0, 50), remaining, onHand,
      ...link, impact: prodImpactLevel({ remaining, onHand, poOverdue: link.poOverdue, poDue: link.poDue, startDate }),
    };
  };
  const rank = { STOP: 0, 'AT RISK': 1, COVERED: 2 };
  const sortRows = rows => rows.sort((a, z) => rank[a.impact] - rank[z.impact] || String(a.startDate).localeCompare(String(z.startDate)));

  const { getActiveConfig, getActiveType, getTableColumns, tableRef, executeSQL } = dbDeps;
  const cfg = getActiveConfig(), q = n => qcol(n, getActiveType() === 'hana');
  for (const [t, cols] of Object.entries({ OWOR: ['DocEntry', 'DocNum', 'ItemCode', 'ProdName', 'PlannedQty', 'Status', 'StartDate', 'DueDate'],
    WOR1: ['DocEntry', 'ItemCode', 'PlannedQty', 'IssuedQty'], POR1: ['DocEntry', 'ItemCode', 'LineStatus'], OITM: ['ItemCode', 'ItemName', 'OnHand'] })) {
    const have = await getTableColumns(t);
    const miss = cols.filter(c => !have.has(c.toLowerCase()));
    if (miss.length) throw new Error(`${t} missing ${miss.join(', ')}`);
  }
  const top = pos.slice(0, 200);
  const byEntry = new Map(top.map(p => [p.docEntry, p]));
  const lines = top.length ? await executeSQL(`SELECT ${q('DocEntry')} AS ${q('DocEntry')}, ${q('ItemCode')} AS ${q('ItemCode')} FROM ${tableRef('POR1', cfg)} ` +
    `WHERE ${q('DocEntry')} IN (${top.map(p => Number(p.docEntry)).join(',')}) AND ${q('LineStatus')} = 'O'`) : [];
  // Item → the most urgent at-risk PO for it (CRITICAL before HIGH, then earliest due).
  const itemToPO = new Map();
  for (const l of lines) {
    const p = byEntry.get(l.DocEntry);
    if (!l.ItemCode || !p) continue;
    const cur = itemToPO.get(l.ItemCode);
    if (!cur || (cur.risk !== 'CRITICAL' && p.risk === 'CRITICAL') || (cur.risk === p.risk && String(p.docDueDate) < String(cur.poDue))) itemToPO.set(l.ItemCode, linkOf(p));
  }
  if (!itemToPO.size) return [];
  const items = [...itemToPO.keys()].slice(0, 500);
  const rows = await executeSQL(`SELECT T0.${q('DocEntry')} AS ${q('DocEntry')}, T0.${q('DocNum')} AS ${q('DocNum')}, T0.${q('ItemCode')} AS ${q('ProdItem')}, ` +
    `T0.${q('ProdName')} AS ${q('ProdName')}, T0.${q('PlannedQty')} AS ${q('ProdQty')}, T0.${q('Status')} AS ${q('Status')}, T0.${q('StartDate')} AS ${q('StartDate')}, ` +
    `T0.${q('DueDate')} AS ${q('DueDate')}, T1.${q('ItemCode')} AS ${q('CompItem')}, T1.${q('PlannedQty')} AS ${q('Planned')}, T1.${q('IssuedQty')} AS ${q('Issued')} ` +
    `FROM ${tableRef('OWOR', cfg)} T0 INNER JOIN ${tableRef('WOR1', cfg)} T1 ON T1.${q('DocEntry')} = T0.${q('DocEntry')} ` +
    `WHERE T0.${q('Status')} IN ('P','R') AND T0.${q('DueDate')} <= '${horizon}' AND T1.${q('ItemCode')} IN (${sqlList(items)}) ` +
    `AND T1.${q('PlannedQty')} > T1.${q('IssuedQty')}`);
  if (!rows.length) return [];
  const comps = new Set(rows.map(r => r.CompItem));
  const stockRows = await executeSQL(`SELECT ${q('ItemCode')} AS ${q('ItemCode')}, ${q('ItemName')} AS ${q('ItemName')}, ${q('OnHand')} AS ${q('OnHand')} ` +
    `FROM ${tableRef('OITM', cfg)} WHERE ${q('ItemCode')} IN (${sqlList(comps)})`);
  const stock = new Map(stockRows.map(s => [s.ItemCode, { onHand: Number(s.OnHand || 0), name: s.ItemName }]));
  return sortRows(rows.map(r => build({ docEntry: r.DocEntry, docNum: r.DocNum, prodItem: r.ProdItem, prodName: r.ProdName, prodQty: r.ProdQty,
    status: r.Status, startDate: r.StartDate, dueDate: r.DueDate, compItem: r.CompItem, planned: r.Planned, issued: r.Issued }, itemToPO, stock)));
}

// ── Actual delivery history (goods receipts against POs) ─────────────────────
// One row per GRPO line copied from a PO line (PDN1.BaseType = 22). Due date =
// PO line ship date, else PO due date. On time = received on or before due.
// Returns null when a required column is missing on this database.
const dayDiff = (a, b) => Math.round((new Date(String(a).slice(0, 10)) - new Date(String(b).slice(0, 10))) / 86400000);
async function fetchReceiptHistoryViaDB(dbDeps, { fromDate, cardCode } = {}) {
  if (!dbDeps?.isConnected?.()) return null;
  const { getActiveConfig, getActiveType, getTableColumns, tableRef, executeSQL } = dbDeps;
  const cfg = getActiveConfig(), isHana = getActiveType() === 'hana', q = n => qcol(n, isHana);
  const need = { OPDN: ['DocEntry', 'DocNum', 'DocDate', 'CardCode', 'CardName', 'CANCELED'],
    PDN1: ['DocEntry', 'BaseType', 'BaseEntry', 'BaseLine', 'ItemCode', 'Dscription', 'Quantity'],
    OPOR: ['DocEntry', 'DocNum', 'DocDate', 'DocDueDate'], POR1: ['DocEntry', 'LineNum', 'ShipDate'] };
  try {
    for (const [t, cols] of Object.entries(need)) {
      const have = await getTableColumns(t);
      const miss = cols.filter(c => !have.has(c.toLowerCase()));
      if (miss.length) { console.warn(`[ShipDelay/history] ${t} missing ${miss.join(', ')}`); return null; }
    }
    const conds = [`T1.${q('BaseType')} = 22`, `T0.${q('CANCELED')} = 'N'`, `T0.${q('DocDate')} >= '${fromDate}'`];
    if (cardCode) conds.push(`T0.${q('CardCode')} = '${String(cardCode).replace(/'/g, "''")}'`);
    const sql = `SELECT T0.${q('DocNum')} AS ${q('GrpoNum')}, T0.${q('DocDate')} AS ${q('RecDate')}, T0.${q('CardCode')} AS ${q('CardCode')}, ` +
      `T0.${q('CardName')} AS ${q('CardName')}, T2.${q('DocNum')} AS ${q('PoNum')}, T2.${q('DocDate')} AS ${q('PoDate')}, ` +
      `T2.${q('DocDueDate')} AS ${q('PoDue')}, T3.${q('ShipDate')} AS ${q('LineDue')}, T1.${q('ItemCode')} AS ${q('ItemCode')}, ` +
      `T1.${q('Dscription')} AS ${q('Descr')}, T1.${q('Quantity')} AS ${q('Qty')} ` +
      `FROM ${tableRef('OPDN', cfg)} T0 INNER JOIN ${tableRef('PDN1', cfg)} T1 ON T1.${q('DocEntry')} = T0.${q('DocEntry')} ` +
      `INNER JOIN ${tableRef('OPOR', cfg)} T2 ON T2.${q('DocEntry')} = T1.${q('BaseEntry')} ` +
      `LEFT JOIN ${tableRef('POR1', cfg)} T3 ON T3.${q('DocEntry')} = T1.${q('BaseEntry')} AND T3.${q('LineNum')} = T1.${q('BaseLine')} ` +
      `WHERE ${conds.join(' AND ')}`;
    const rows = await executeSQL(sql);
    return rows.map(r => {
      const due = r.LineDue || r.PoDue;
      const late = due ? dayDiff(r.RecDate, due) : null;
      return {
        cardCode: r.CardCode, cardName: r.CardName, grpoNum: r.GrpoNum, recDate: String(r.RecDate).slice(0, 10),
        poNum: r.PoNum, poDate: String(r.PoDate).slice(0, 10), dueDate: due ? String(due).slice(0, 10) : null,
        lateDays: late, leadDays: r.PoDate ? dayDiff(r.RecDate, r.PoDate) : null,
        itemCode: r.ItemCode, desc: String(r.Descr || '').slice(0, 60), qty: Number(r.Qty || 0),
        status: late == null ? 'NO DUE DATE' : late <= 0 ? 'ON TIME' : 'LATE',
      };
    });
  } catch (e) {
    console.warn('[ShipDelay/history] receipt history failed:', e.message);
    return null;
  }
}
function summariseReceipts(rows) {
  const dated = rows.filter(r => r.lateDays != null);
  const late = dated.filter(r => r.lateDays > 0);
  const lead = rows.filter(r => r.leadDays != null && r.leadDays >= 0);
  return {
    receiptLines: rows.length,
    onTimeLines:  dated.length - late.length,
    onTimePct:    dated.length ? Math.round(((dated.length - late.length) / dated.length) * 100) : null,
    lateLines:    late.length,
    avgLateDays:  late.length ? Math.round(late.reduce((s, r) => s + r.lateDays, 0) / late.length) : 0,
    maxLateDays:  late.reduce((m, r) => Math.max(m, r.lateDays), 0),
    avgLeadDays:  lead.length ? Math.round(lead.reduce((s, r) => s + r.leadDays, 0) / lead.length) : null,
  };
}

// Open PO lines of one vendor (for the vendor drill-down).
async function fetchVendorOpenLines(sap, dbDeps, cardCode) {
  const code = String(cardCode).replace(/'/g, "''");
  const { getActiveConfig, getActiveType, tableRef, executeSQL } = dbDeps;
  const cfg = getActiveConfig(), q = n => qcol(n, getActiveType() === 'hana');
  const rows = await executeSQL(`SELECT T0.${q('DocNum')} AS ${q('DocNum')}, T0.${q('DocDueDate')} AS ${q('DocDueDate')}, T1.${q('LineNum')} AS ${q('LineNum')}, ` +
    `T1.${q('ItemCode')} AS ${q('ItemCode')}, T1.${q('Dscription')} AS ${q('Descr')}, T1.${q('Quantity')} AS ${q('Qty')}, T1.${q('OpenQty')} AS ${q('OpenQty')}, ` +
    `T1.${q('ShipDate')} AS ${q('ShipDate')}, T1.${q('Price')} AS ${q('Price')} ` +
    `FROM ${tableRef('OPOR', cfg)} T0 INNER JOIN ${tableRef('POR1', cfg)} T1 ON T1.${q('DocEntry')} = T0.${q('DocEntry')} ` +
    `WHERE T0.${q('CardCode')} = '${code}' AND T0.${q('DocStatus')} = 'O' AND T0.${q('CANCELED')} = 'N' AND T1.${q('LineStatus')} = 'O'`);
  return rows.map(r => ({ docNum: r.DocNum, lineNum: r.LineNum, itemCode: r.ItemCode, desc: String(r.Descr || '').slice(0, 60),
    qty: Number(r.Qty || 0), openQty: Number(r.OpenQty || 0), shipDate: String(r.ShipDate || r.DocDueDate || '').slice(0, 10),
    openValue: Math.round(Number(r.OpenQty || 0) * Number(r.Price || 0)) }));
}

// Expediting e-mail: overdue POs first, then at-risk ones, asking for dates.
function followupEmail(vendor, pos, contact) {
  const fa = v => Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const overdue = pos.filter(p => p.isOverdue).sort((a, z) => z.daysOverdue - a.daysOverdue);
  const upcoming = pos.filter(p => !p.isOverdue).sort((a, z) => String(a.docDueDate).localeCompare(String(z.docDueDate)));
  const line = p => `  • PO ${p.docNum} — due ${String(p.docDueDate || '').slice(0, 10)}${p.isOverdue ? ` (${p.daysOverdue} days overdue)` : ''} — value ${fa(p.docTotal)}`;
  const subject = overdue.length
    ? `Delivery follow-up: ${overdue.length} overdue purchase order${overdue.length > 1 ? 's' : ''} — please confirm ship dates`
    : `Delivery confirmation request: ${upcoming.length} upcoming purchase order${upcoming.length > 1 ? 's' : ''}`;
  const body = `Dear ${contact?.name || `${vendor.cardName || vendor.cardCode} team`},

We are reviewing our open purchase orders with you and would appreciate your update on the following:
${overdue.length ? `\nOverdue — please confirm the dispatch date, tracking details and any partial-shipment option:\n${overdue.map(line).join('\n')}\n` : ''}${upcoming.length ? `\nDue soon — please confirm that these will ship on time:\n${upcoming.map(line).join('\n')}\n` : ''}
Kindly reply within 2 business days with a confirmed ship date for each order. If any item cannot be delivered on time, please let us know the earliest possible date so we can plan accordingly.

Thank you for your support.

Best regards,
Purchasing Team`;
  return { to: contact?.email || '', subject, body };
}

// ── Router factory ────────────────────────────────────────────────────────────
export function createShipmentDelayRouter(deps) {
  const {
    requireAuth, AI_PROVIDER, USE_AI, gptChatComplete, azureMessagesCreate,
    isConnected, getActiveType, getActiveConfig, executeSQL, tableRef, getTableColumns, resolveFieldMap, ensureConnected,
  } = deps;
  const router  = Router();
  const _aiDeps = () => USE_AI ? { AI_PROVIDER, gptChatComplete, azureMessagesCreate } : null;
  const _dbDeps = isConnected
    ? { isConnected, getActiveType, getActiveConfig, executeSQL, tableRef, getTableColumns, resolveFieldMap }
    : null;

  // Every route reads SAP through DB Direct only. Reconnect to the saved
  // connection when needed (e.g. after a server restart), else a clear error.
  const DB_REQUIRED = 'Shipment Delays reads SAP data through DB Direct only. Configure a database under Tools → DB Connection, then scan again.';
  async function needDb() {
    if (!isConnected?.() && ensureConnected) { try { await ensureConnected(); } catch (e) { console.warn('[ShipDelay] DB reconnect failed:', e.message); } }
    if (!isConnected?.()) { const e = new Error(DB_REQUIRED); e.status = 400; throw e; }
  }
  const fail = (res, tag, e) => {
    if (!e.status) console.error(`[ShipDelay/${tag}]`, e);
    res.status(e.status || 500).json({ ok: false, error: e.message, dbRequired: e.message === DB_REQUIRED });
  };

  // GET /api/shipment-delays/scan
  router.get('/scan', requireAuth, async (req, res) => {
    try {
      await needDb();
      const result = await runShipmentDelayScan(null, { aiDeps: _aiDeps(), dbDeps: _dbDeps });

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

      // Vendor table: 6-month history + every currently open PO + actual
      // receipt performance (GRPO vs due date, DB Direct only).
      const histStart = new Date(Date.now() - HISTORY_MONTHS * 30 * 86400000).toISOString().slice(0, 10);
      const receipts = await fetchReceiptHistoryViaDB(_dbDeps, { fromDate: histStart });
      const recBy = new Map();
      for (const r of receipts || []) { if (!recBy.has(r.cardCode)) recBy.set(r.cardCode, []); recBy.get(r.cardCode).push(r); }
      const openBy = new Map();
      for (const p of result.scoredPOs) { if (!openBy.has(p.cardCode)) openBy.set(p.cardCode, []); openBy.get(p.cardCode).push(p); }
      const base = new Map(result.vendorList.map(v => [v.cardCode, v]));
      for (const [code, list] of openBy) if (!base.has(code)) base.set(code, { cardCode: code, cardName: list[0].cardName, totalPOs: 0, openPOs: 0, overduePOs: 0, avgDelayDays: 0, maxDelayDays: 0, totalSpend: 0, spendShare: 0, overdueRate: 0, reliability: 'Unknown', riskLevel: 'LOW' });
      const vendors = [...base.values()].map(v => {
        const open = openBy.get(v.cardCode) || [];
        const od = open.filter(p => p.isOverdue);
        const upcoming = open.filter(p => !p.isOverdue && p.docDueDate).sort((a, z) => String(a.docDueDate).localeCompare(String(z.docDueDate)));
        const oldest = od.sort((a, z) => z.daysOverdue - a.daysOverdue)[0];
        const openValue = open.reduce((s, p) => s + p.docTotal, 0);
        const rec = recBy.has(v.cardCode) ? summariseReceipts(recBy.get(v.cardCode)) : null;
        return {
          ...v, vendorCode: v.cardCode, vendorName: v.cardName,
          openNow: open.length, openValue: Math.round(openValue),
          overdueNow: od.length, overdueValue: Math.round(od.reduce((s, p) => s + p.docTotal, 0)),
          atRiskNow: open.filter(p => p.risk === 'CRITICAL' || p.risk === 'HIGH').length,
          weightedProb: openValue ? Math.round(open.reduce((s, p) => s + p.delayProbability * p.docTotal, 0) / openValue) : 0,
          nextDue: upcoming[0] ? { docNum: upcoming[0].docNum, date: String(upcoming[0].docDueDate).slice(0, 10), days: upcoming[0].daysUntilDue } : null,
          oldestOverdue: oldest ? { docNum: oldest.docNum, days: oldest.daysOverdue } : null,
          history: rec,   // null = no DB Direct / no receipts in the window
        };
      }).sort((a, z) => z.overdueValue - a.overdueValue || z.openValue - a.openValue || z.overdueRate - a.overdueRate);

      // Every open PO (slim), for the vendor drill-down and the inbound schedule.
      const allOpenPOs = result.scoredPOs.map(p => ({
        docNum: p.docNum, docEntry: p.docEntry, cardCode: p.cardCode, vendorName: p.cardName, docDate: p.docDate,
        docDueDate: p.docDueDate, daysLeft: p.daysUntilDue, isOverdue: p.isOverdue, daysOverdue: p.daysOverdue,
        docTotal: p.docTotal, delayProbPct: p.delayProbability, riskTag: p.risk,
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
          openQty:      l.openQty ?? null,
          poDue:        l.poRisk?.poDue || null,
          poOverdue:    !!l.poRisk?.poOverdue,
          vendor:       l.poRisk?.vendor || '',
          soDocTotal:   s.docTotal || 0,
        }))
      );

      const summary = {
        totalPOs:        result.summary.totalOpen,
        atRisk:          result.summary.criticalCount + result.summary.highCount + result.summary.mediumCount,
        critical:        result.summary.criticalCount,
        high:            result.summary.highCount,
        impactedSOCount: result.summary.impactedSOCount,
        impactedProdCount: new Set((result.prodImpact || []).filter(r => r.impact !== 'COVERED').map(r => r.prodNum)).size,
        prodStopCount:   new Set((result.prodImpact || []).filter(r => r.impact === 'STOP').map(r => r.prodNum)).size,
        soImpactScope:   'up to 300 SOs × 200 risky POs',
        riskyVendors:    result.vendorList.filter(v => v.riskLevel === 'HIGH').length,
        source:          result.summary.source,
        // Totals over ALL open POs (the PO table lists only MEDIUM+), for the KPI popups.
        lowCount:        result.scoredPOs.filter(p => p.risk === 'LOW').length,
        overdueCount:    result.summary.overdueCount,
        totalValue:      Math.round(result.scoredPOs.reduce((s, p) => s + p.docTotal, 0)),
        overdueValue:    Math.round(result.scoredPOs.filter(p => p.isOverdue).reduce((s, p) => s + p.docTotal, 0)),
        riskValue:       Object.fromEntries(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map(r =>
          [r, Math.round(result.scoredPOs.filter(p => p.risk === r).reduce((s, p) => s + p.docTotal, 0))])),
        vendorsWithOpen: new Set(result.scoredPOs.map(p => p.cardCode)).size,
      };

      summary.receiptHistory = receipts ? 'db' : 'unavailable';
      res.json({ ok: true, atRiskPOs, allOpenPOs, vendors, impactedSOs, prodImpact: result.prodImpact || [], summary, aiAdvisory: result.aiIntelligence });
    } catch (e) { fail(res, 'scan', e); }
  });

  // GET /api/shipment-delays/vendor-history?cardCode=V001&months=12
  // Every goods receipt against a PO for one vendor: due vs received, days late.
  router.get('/vendor-history', requireAuth, async (req, res) => {
    try {
      const cardCode = String(req.query.cardCode || '').trim();
      if (!cardCode) return res.status(400).json({ ok: false, error: 'cardCode required' });
      await needDb();
      const months = Math.min(24, Math.max(1, Number(req.query.months) || 12));
      const from = new Date(Date.now() - months * 30 * 86400000).toISOString().slice(0, 10);
      const rows = await fetchReceiptHistoryViaDB(_dbDeps, { fromDate: from, cardCode });
      if (!rows) return res.json({ ok: true, available: false, cardCode, months, rows: [], monthly: [],
        message: 'Delivery history is not available: the goods-receipt / PO tables (OPDN, PDN1, OPOR, POR1) are missing a required column on this database.' });
      rows.sort((a, z) => z.recDate.localeCompare(a.recDate));
      const byMonth = new Map();
      for (const r of rows) { const m = r.recDate.slice(0, 7); if (!byMonth.has(m)) byMonth.set(m, []); byMonth.get(m).push(r); }
      const monthly = [...byMonth].sort((a, z) => a[0].localeCompare(z[0])).map(([month, list]) => ({ month, ...summariseReceipts(list) }));
      res.json({ ok: true, available: true, cardCode, cardName: rows[0]?.cardName || '', months, from, summary: summariseReceipts(rows), monthly, rows: rows.slice(0, 500) });
    } catch (e) { fail(res, 'vendor-history', e); }
  });

  // GET /api/shipment-delays/vendor-lines?cardCode=V001 — open PO lines of one vendor.
  router.get('/vendor-lines', requireAuth, async (req, res) => {
    try {
      const cardCode = String(req.query.cardCode || '').trim();
      if (!cardCode) return res.status(400).json({ ok: false, error: 'cardCode required' });
      await needDb();
      const lines = await fetchVendorOpenLines(null, _dbDeps, cardCode);
      res.json({ ok: true, cardCode, lines });
    } catch (e) { fail(res, 'vendor-lines', e); }
  });

  // POST /api/shipment-delays/followup-email { cardCode, cardName, pos:[…] }
  // Draft expediting e-mail; the vendor's e-mail / contact person / phone come from OCRD.
  router.post('/followup-email', requireAuth, async (req, res) => {
    try {
      const { cardCode, cardName, pos = [] } = req.body || {};
      if (!cardCode) return res.status(400).json({ ok: false, error: 'cardCode required' });
      await needDb();
      let contact = null;
      try {
        const q = n => qcol(n, getActiveType() === 'hana');
        const [bp] = await executeSQL(`SELECT ${q('E_Mail')} AS ${q('Email')}, ${q('CntctPrsn')} AS ${q('Contact')}, ${q('Phone1')} AS ${q('Phone')} ` +
          `FROM ${tableRef('OCRD', getActiveConfig())} WHERE ${q('CardCode')} = '${String(cardCode).replace(/'/g, "''")}'`);
        if (bp) contact = { email: bp.Email || '', name: bp.Contact || '', phone: bp.Phone || '' };
      } catch (e) { console.warn('[ShipDelay/followup] contact lookup failed:', e.message); }
      const mail = followupEmail({ cardCode, cardName }, pos.slice(0, 40), contact);
      res.json({ ok: true, ...mail, phone: contact?.phone || '' });
    } catch (e) { fail(res, 'followup-email', e); }
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
