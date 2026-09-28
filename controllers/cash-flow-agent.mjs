/**
 * Cash Flow Agent — mounted at /api/cash-flow-agent
 *
 * Week-by-week cash forecast built from:
 *   inflows  = open A/R invoices (due date shifted by each customer's actual
 *              average days-late, weighted by collectability) + open sales
 *              orders (delivery date + payment terms + days-late)
 *   outflows = open A/P invoices (due date) + open purchase orders
 *              (expected receipt + payment terms)
 * Opening balance comes from G/L cash accounts (OACT.Finanse) unless given.
 */
import { createInsightRouter, ctxTable, daysBetween, addDays, num, round, clamp, fmtAmt } from '../lib/insight-kit.mjs';
import {
  loadPartners, loadOpenInvoices, loadOpenDocs, loadArPaymentHistory, summarisePaymentBehaviour,
  loadPaymentTerms, termDays, loadCashBalance, since,
} from '../lib/insight-data.mjs';

// Collection probability by how overdue an A/R invoice already is.
function collectability(daysOverdue) {
  if (daysOverdue > 365) return 0.1;
  if (daysOverdue > 180) return 0.3;
  if (daysOverdue > 90)  return 0.6;
  if (daysOverdue > 30)  return 0.85;
  return 0.95;
}
const SO_CONVERSION = 0.85;   // share of open SO value expected to be invoiced & collected

async function run(k, p) {
  const asOf = p.asOf;
  const weeks = clamp(Math.round(num(p.weeks) || 13), 4, 52);
  const horizonEnd = addDays(asOf, weeks * 7 - 1);

  const customers = await loadPartners(k, 'C');
  const vendors = await loadPartners(k, 'S');
  const terms = await loadPaymentTerms(k);
  const behaviour = summarisePaymentBehaviour(await loadArPaymentHistory(k, since(asOf, 365)));
  const ar = await loadOpenInvoices(k, 'OINV');
  const ap = await loadOpenInvoices(k, 'OPCH');
  const so = await loadOpenDocs(k, 'ORDR', 'RDR1');
  const po = await loadOpenDocs(k, 'OPOR', 'POR1');

  let opening = p.openingBalance;
  let openingSource = 'entered';
  if (opening === undefined || opening === null || opening === '') {
    const cash = await loadCashBalance(k);
    opening = cash.balance;
    openingSource = cash.accounts ? `G/L cash accounts (${cash.accounts})` : 'none found — enter opening balance';
  }
  opening = num(opening);

  const lateOf = card => Math.max(0, behaviour.get(card)?.avgDaysLate ?? 0);
  const flows = [];

  for (const inv of ar) {
    const overdue = daysBetween(inv.dueDate, asOf);
    let date = addDays(inv.dueDate, lateOf(inv.cardCode));
    if (date < asOf) date = asOf;
    const prob = overdue > 0 ? collectability(overdue) : 0.95;
    flows.push({ dir: 'in', source: 'A/R invoice', docNum: inv.docNum, partner: inv.cardName, cardCode: inv.cardCode,
      amount: round(inv.balance), weighted: round(inv.balance * prob), probability: Math.round(prob * 100), date,
      basis: overdue > 0 ? `${overdue}d overdue` : `due ${inv.dueDate}${lateOf(inv.cardCode) ? ` +${lateOf(inv.cardCode)}d avg late` : ''}` });
  }
  for (const d of so) {
    if (d.openValue <= 0) continue;
    const delivery = d.dueDate < asOf ? addDays(asOf, 7) : d.dueDate;
    const tDays = termDays(terms, d.groupNum ?? customers.get(d.cardCode)?.groupNum);
    const date = addDays(delivery, tDays + lateOf(d.cardCode));
    flows.push({ dir: 'in', source: 'Sales order', docNum: d.docNum, partner: d.cardName, cardCode: d.cardCode,
      amount: round(d.openValue), weighted: round(d.openValue * SO_CONVERSION), probability: Math.round(SO_CONVERSION * 100), date,
      basis: `deliver ${delivery} + ${tDays}d terms${lateOf(d.cardCode) ? ` + ${lateOf(d.cardCode)}d late` : ''}` });
  }
  for (const inv of ap) {
    const date = inv.dueDate < asOf ? asOf : inv.dueDate;
    flows.push({ dir: 'out', source: 'A/P invoice', docNum: inv.docNum, partner: inv.cardName, cardCode: inv.cardCode,
      amount: round(inv.balance), weighted: round(inv.balance), probability: 100, date,
      basis: inv.dueDate < asOf ? `${daysBetween(inv.dueDate, asOf)}d overdue — pay now` : `due ${inv.dueDate}` });
  }
  for (const d of po) {
    if (d.openValue <= 0) continue;
    const receipt = d.dueDate < asOf ? addDays(asOf, 7) : d.dueDate;
    const tDays = termDays(terms, d.groupNum ?? vendors.get(d.cardCode)?.groupNum);
    flows.push({ dir: 'out', source: 'Purchase order', docNum: d.docNum, partner: d.cardName, cardCode: d.cardCode,
      amount: round(d.openValue), weighted: round(d.openValue), probability: 100, date: addDays(receipt, tDays),
      basis: `receive ${receipt} + ${tDays}d terms` });
  }

  // Weekly buckets
  const wk = Array.from({ length: weeks }, (_, i) => ({
    week: i + 1, start: addDays(asOf, i * 7), end: addDays(asOf, i * 7 + 6),
    arIn: 0, soIn: 0, apOut: 0, poOut: 0,
  }));
  const later = { in: 0, out: 0 };
  for (const f of flows) {
    const idx = Math.floor(daysBetween(asOf, f.date) / 7);
    f.week = idx < weeks ? idx + 1 : null;
    if (idx >= weeks) { later[f.dir] += f.weighted; continue; }
    const w = wk[idx];
    if (f.source === 'A/R invoice') w.arIn += f.weighted;
    else if (f.source === 'Sales order') w.soIn += f.weighted;
    else if (f.source === 'A/P invoice') w.apOut += f.weighted;
    else w.poOut += f.weighted;
  }
  let bal = opening;
  for (const w of wk) {
    w.opening = round(bal);
    w.inflow = round(w.arIn + w.soIn); w.outflow = round(w.apOut + w.poOut);
    w.net = round(w.inflow - w.outflow);
    bal += w.net;
    w.closing = round(bal);
    for (const key of ['arIn', 'soIn', 'apOut', 'poOut']) w[key] = round(w[key]);
    w.status = w.closing < 0 ? 'SHORTFALL' : w.net < 0 ? 'DRAWDOWN' : 'OK';
  }
  const totIn = wk.reduce((s, w) => s + w.inflow, 0);
  const totOut = wk.reduce((s, w) => s + w.outflow, 0);
  const low = wk.reduce((m, w) => (w.closing < m.closing ? w : m), wk[0]);
  const negWeeks = wk.filter(w => w.closing < 0);
  const atRiskAr = flows.filter(f => f.source === 'A/R invoice').reduce((s, f) => s + (f.amount - f.weighted), 0);

  const inflows = flows.filter(f => f.dir === 'in' && f.week).sort((a, z) => z.weighted - a.weighted);
  const outflows = flows.filter(f => f.dir === 'out' && f.week).sort((a, z) => z.weighted - a.weighted);

  const insight = `**${weeks}-week outlook: ${fmtAmt(totIn)} expected in, ${fmtAmt(totOut)} out — closing ${fmtAmt(bal)} (opening ${fmtAmt(opening)}).**\n\n` +
    `- Lowest projected balance **${fmtAmt(low.closing)}** in week ${low.week} (${low.start} → ${low.end}).\n` +
    (negWeeks.length ? `- **${negWeeks.length} week(s) project a negative balance**, first in week ${negWeeks[0].week}. Accelerate collections or defer payables/POs.\n` : '- No week projects a negative balance.\n') +
    `- ${fmtAmt(atRiskAr)} of receivables is discounted as unlikely to be collected (long overdue).\n` +
    (inflows[0] ? `- Largest inflow: ${inflows[0].source} ${inflows[0].docNum} from ${inflows[0].partner} (${fmtAmt(inflows[0].weighted)}, week ${inflows[0].week}).\n` : '') +
    (outflows[0] ? `- Largest outflow: ${outflows[0].source} ${outflows[0].docNum} to ${outflows[0].partner} (${fmtAmt(outflows[0].weighted)}, week ${outflows[0].week}).\n` : '');

  const aiContext = `CASH FLOW FORECAST from ${asOf}, ${weeks} weeks. Opening ${fmtAmt(opening)} (${openingSource}).
Totals in horizon: inflow ${fmtAmt(totIn)}, outflow ${fmtAmt(totOut)}, closing ${fmtAmt(bal)}. Beyond horizon: in ${fmtAmt(later.in)}, out ${fmtAmt(later.out)}.
A/R discounted for collection risk: ${fmtAmt(atRiskAr)}.
WEEKLY:
${ctxTable(wk, [['week', 'Wk'], ['start', 'From'], ['arIn', 'AR in'], ['soIn', 'SO in'], ['apOut', 'AP out'], ['poOut', 'PO out'], ['net', 'Net'], ['closing', 'Closing']], 52)}
TOP INFLOWS:
${ctxTable(inflows, [['source', 'Source'], ['docNum', 'Doc'], ['partner', 'Partner'], ['weighted', 'Expected'], ['date', 'Date'], ['basis', 'Basis']], 12)}
TOP OUTFLOWS:
${ctxTable(outflows, [['source', 'Source'], ['docNum', 'Doc'], ['partner', 'Partner'], ['weighted', 'Amount'], ['date', 'Date'], ['basis', 'Basis']], 12)}`;

  const flowCols = [
    { key: 'week', label: 'Week', fmt: 'int' }, { key: 'date', label: 'Expected', fmt: 'date' },
    { key: 'source', label: 'Source', fmt: 'badge' }, { key: 'docNum', label: 'Doc #' },
    { key: 'partner', label: 'Partner', sub: 'cardCode' }, { key: 'amount', label: 'Open amount', fmt: 'amt' },
    { key: 'probability', label: 'Prob.', fmt: 'pct' }, { key: 'weighted', label: 'Forecast', fmt: 'amt' },
    { key: 'basis', label: 'Basis', wrap: true },
  ];

  return {
    kpis: [
      { label: 'Opening balance', value: opening, fmt: 'amt', hint: openingSource },
      { label: `Inflows (${weeks}w)`, value: totIn, fmt: 'amt', tone: 'good' },
      { label: `Outflows (${weeks}w)`, value: totOut, fmt: 'amt', tone: 'bad' },
      { label: 'Net change', value: totIn - totOut, fmt: 'amt', tone: totIn - totOut >= 0 ? 'good' : 'bad' },
      { label: 'Closing balance', value: bal, fmt: 'amt', tone: bal >= 0 ? 'good' : 'bad' },
      { label: `Lowest (wk ${low.week})`, value: low.closing, fmt: 'amt', tone: low.closing >= 0 ? 'good' : 'bad' },
      { label: 'Shortfall weeks', value: negWeeks.length, fmt: 'int', tone: negWeeks.length ? 'bad' : 'good' },
      { label: 'A/R at risk', value: atRiskAr, fmt: 'amt', tone: 'warn', hint: 'Open receivables discounted as unlikely to be collected' },
    ],
    chart: {
      title: 'Weekly cash flow', type: 'bar', labels: wk.map(w => `W${w.week} ${w.start.slice(5)}`),
      series: [
        { name: 'Inflow', values: wk.map(w => w.inflow), color: '#107E3E' },
        { name: 'Outflow', values: wk.map(w => -w.outflow), color: '#BB0000' },
        { name: 'Closing balance', values: wk.map(w => w.closing), type: 'line', color: '#0070F2' },
      ],
    },
    tabs: [
      { key: 'weekly', label: 'Weekly forecast', rows: wk,
        columns: [
          { key: 'week', label: 'Wk', fmt: 'int' }, { key: 'start', label: 'From', fmt: 'date' }, { key: 'end', label: 'To', fmt: 'date' },
          { key: 'opening', label: 'Opening', fmt: 'amt' }, { key: 'arIn', label: 'A/R in', fmt: 'amt' }, { key: 'soIn', label: 'Sales orders in', fmt: 'amt' },
          { key: 'apOut', label: 'A/P out', fmt: 'amt' }, { key: 'poOut', label: 'POs out', fmt: 'amt' },
          { key: 'net', label: 'Net', fmt: 'amt' }, { key: 'closing', label: 'Closing', fmt: 'amt' }, { key: 'status', label: 'Status', fmt: 'badge' },
        ] },
      { key: 'inflows', label: `Inflows (${inflows.length})`, rows: inflows, columns: flowCols },
      { key: 'outflows', label: `Outflows (${outflows.length})`, rows: outflows, columns: flowCols },
    ],
    notes: [
      `Opening balance: ${openingSource}. Enter an opening balance above to override.`,
      `A/R timing = due date + the customer's weighted average days-late over the last 12 months; overdue A/R is weighted by collectability (95% → 10% as it ages).`,
      `Open sales orders are assumed ${Math.round(SO_CONVERSION * 100)}% collectable at delivery date + payment terms; open POs are paid at expected receipt + vendor terms. Past-due orders are assumed to ship/arrive in 7 days.`,
      later.in || later.out ? `Beyond the horizon: ${fmtAmt(later.in)} in, ${fmtAmt(later.out)} out (not charted).` : '',
      inflows[0] && totIn > 0 && inflows[0].weighted / totIn > 0.4
        ? `⚠ Concentration: ${inflows[0].source} ${inflows[0].docNum} (${inflows[0].partner}) is ${Math.round((inflows[0].weighted / totIn) * 100)}% of all forecast inflows — verify its value and timing before relying on this forecast.` : '',
    ].filter(Boolean),
    insight, aiContext,
  };
}

export function createCashFlowAgentRouter(deps) {
  return createInsightRouter(deps, {
    slug: 'cashflow', title: 'Cash Flow Agent',
    defaults: { weeks: 13 },
    persona: 'You are a corporate treasurer forecasting short-term liquidity from SAP Business One data.',
    aiTask: 'Review this cash flow forecast. Call out liquidity risk weeks, the biggest drivers, and concrete levers (collections to accelerate, payments/POs to defer) with document numbers.',
    run,
  });
}
