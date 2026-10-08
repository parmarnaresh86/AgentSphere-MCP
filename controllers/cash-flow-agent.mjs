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

// Collection probability by how overdue an A/R invoice already is
// (first band whose "over" the days overdue exceed).
const COLLECT_BANDS = [
  { over: 365, p: 0.1 }, { over: 180, p: 0.3 }, { over: 90, p: 0.6 }, { over: 30, p: 0.85 }, { over: -Infinity, p: 0.95 },
];
const collectBand = daysOverdue => COLLECT_BANDS.find(b => daysOverdue > b.over);
function collectability(daysOverdue) { return collectBand(daysOverdue).p; }
// Decision table for the popup, with the applied band highlighted.
const collectRules = daysOverdue => {
  const hit = collectBand(daysOverdue);
  return COLLECT_BANDS.map((b, i) => ({
    rule: i === 0 ? `More than ${b.over} days overdue`
      : Number.isFinite(b.over) ? `${b.over + 1}–${COLLECT_BANDS[i - 1].over} days overdue`
      : `Not yet due, or up to ${COLLECT_BANDS[i - 1].over} days overdue`,
    result: `${Math.round(b.p * 100)}% expected to be collected`, hit: b === hit,
  }));
};
const SO_CONVERSION = 0.85;   // share of open SO value expected to be invoiced & collected

// KPI drill-through (calc blocks → lib/insight-kit.mjs withKpiDetails).
const SRC = {
  oact: 'OACT — G/L cash & bank accounts (Finanse = Y): current balance',
  oinv: 'OINV — open A/R invoices: balance, due date',
  ordr: 'ORDR + RDR1 — open sales orders: open value, delivery date',
  opch: 'OPCH — open A/P invoices: balance, due date',
  opor: 'OPOR + POR1 — open purchase orders: open value, delivery date',
  hist: 'ORCT + RCT2 + OINV — customer payment history, last 12 months (average days late)',
  octg: 'OCTG — payment terms of customers and vendors',
};
const FLOW_DRILL = [{ key: 'date', label: 'Expected', fmt: 'date' }, { key: 'source', label: 'Source', fmt: 'badge' }, { key: 'docNum', label: 'Doc #' },
  { key: 'partner', label: 'Partner', sub: 'cardCode' }, { key: 'amount', label: 'Open', fmt: 'amt' }, { key: 'weighted', label: 'Forecast', fmt: 'amt' }];
const sumBy = (flows, source) => round(flows.filter(f => f.source === source).reduce((s, f) => s + f.weighted, 0));

// Week status: first matching rule wins.
const STATUS_RULES = [
  { rule: 'Closing balance is below zero', result: 'SHORTFALL', test: w => w.closing < 0 },
  { rule: 'More cash goes out than comes in this week (net is negative)', result: 'DRAWDOWN', test: w => w.net < 0 },
  { rule: 'Otherwise', result: 'OK', test: () => true },
];

// Popup explanations for a forecast line (Expected date, Prob., Forecast).
function flowExplain({ dateSteps, dateNote, prob, probEx, amount, weighted }) {
  return {
    date: { title: 'Expected payment date', steps: dateSteps, note: dateNote },
    probability: probEx,
    weighted: {
      title: 'Forecast amount',
      steps: [
        { label: 'Open amount', value: amount, detail: fmtAmt(amount) },
        { label: 'Probability', formula: 'see the Prob. column', value: `${Math.round(prob * 100)}%` },
      ],
      result: { label: 'Forecast = open amount × probability', value: weighted },
      note: weighted < amount ? `${fmtAmt(amount - weighted)} is left out as unlikely to be received.` : 'Counted in full.',
    },
  };
}

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

  // Always load the cash G/L accounts so the opening KPI can drill into them.
  const cash = await loadCashBalance(k);
  const glAccounts = cash.list.slice().sort((a, z) => Math.abs(z.balance) - Math.abs(a.balance));
  let opening = p.openingBalance;
  let openingSource = 'entered';
  if (opening === undefined || opening === null || opening === '') {
    opening = cash.balance;
    openingSource = cash.accounts ? `G/L cash accounts (${cash.accounts})` : 'none found — enter opening balance';
  }
  opening = num(opening);

  const lateOf = card => Math.max(0, behaviour.get(card)?.avgDaysLate ?? 0);
  const lateStep = card => {
    const b = behaviour.get(card);
    return { label: '+ Customer\'s average days late', formula: 'weighted average over the last 12 months', value: `${lateOf(card)} days`,
      detail: b ? `Based on ${b.paidInvoices} paid invoices` : 'No payment history — assumed on time' };
  };
  const flows = [];
  const today = { label: 'Not before today', formula: 'a date in the past is moved to today', value: asOf };
  const certain = (title, why) => ({ title, steps: [{ label: 'Probability', value: '100%', detail: why }], note: 'Outgoing payments are treated as certain.' });

  for (const inv of ar) {
    const overdue = daysBetween(inv.dueDate, asOf);
    const raw = addDays(inv.dueDate, lateOf(inv.cardCode));
    let date = raw;
    if (date < asOf) date = asOf;
    const prob = overdue > 0 ? collectability(overdue) : 0.95;
    const amount = round(inv.balance), weighted = round(inv.balance * prob);
    flows.push({ dir: 'in', source: 'A/R invoice', docNum: inv.docNum, partner: inv.cardName, cardCode: inv.cardCode,
      amount, weighted, probability: Math.round(prob * 100), date,
      basis: overdue > 0 ? `${overdue}d overdue` : `due ${inv.dueDate}${lateOf(inv.cardCode) ? ` +${lateOf(inv.cardCode)}d avg late` : ''}`,
      explain: flowExplain({
        dateSteps: [{ label: 'Invoice due date', value: inv.dueDate }, lateStep(inv.cardCode),
          { label: '= Due date + days late', value: raw }, ...(raw < asOf ? [today] : [])],
        dateNote: 'We expect the customer to pay as late as they usually do.',
        prob, amount, weighted,
        probEx: { title: 'Collection probability',
          steps: [{ label: 'Days overdue today', value: Math.max(0, overdue), detail: `Due ${inv.dueDate}, as of ${asOf}` }],
          rules: collectRules(overdue), note: 'The longer an invoice is overdue, the less likely it is to be paid.' },
      }) });
  }
  for (const d of so) {
    if (d.openValue <= 0) continue;
    const delivery = d.dueDate < asOf ? addDays(asOf, 7) : d.dueDate;
    const tDays = termDays(terms, d.groupNum ?? customers.get(d.cardCode)?.groupNum);
    const date = addDays(delivery, tDays + lateOf(d.cardCode));
    const amount = round(d.openValue), weighted = round(d.openValue * SO_CONVERSION);
    flows.push({ dir: 'in', source: 'Sales order', docNum: d.docNum, partner: d.cardName, cardCode: d.cardCode,
      amount, weighted, probability: Math.round(SO_CONVERSION * 100), date,
      basis: `deliver ${delivery} + ${tDays}d terms${lateOf(d.cardCode) ? ` + ${lateOf(d.cardCode)}d late` : ''}`,
      explain: flowExplain({
        dateSteps: [
          { label: 'Expected delivery', formula: 'order delivery date; if already past, today + 7 days', value: delivery, detail: `Order delivery date ${d.dueDate}` },
          { label: '+ Payment terms', value: `${tDays} days` }, lateStep(d.cardCode),
          { label: '= Delivery + terms + days late', value: date }],
        dateNote: 'The order is invoiced on delivery and paid after the payment terms.',
        prob: SO_CONVERSION, amount, weighted,
        probEx: { title: 'Collection probability',
          steps: [{ label: 'Open sales order', formula: 'fixed assumption for all open orders', value: `${Math.round(SO_CONVERSION * 100)}%` }],
          note: 'Share of open order value expected to be delivered, invoiced and collected.' },
      }) });
  }
  for (const inv of ap) {
    const date = inv.dueDate < asOf ? asOf : inv.dueDate;
    const amount = round(inv.balance);
    flows.push({ dir: 'out', source: 'A/P invoice', docNum: inv.docNum, partner: inv.cardName, cardCode: inv.cardCode,
      amount, weighted: amount, probability: 100, date,
      basis: inv.dueDate < asOf ? `${daysBetween(inv.dueDate, asOf)}d overdue — pay now` : `due ${inv.dueDate}`,
      explain: flowExplain({
        dateSteps: [{ label: 'Supplier invoice due date', value: inv.dueDate }, ...(inv.dueDate < asOf ? [{ ...today, detail: 'Already overdue — pay now' }] : [])],
        dateNote: 'Supplier invoices are assumed paid on their due date.',
        prob: 1, amount, weighted: amount, probEx: certain('Payment probability', 'Supplier invoice already received'),
      }) });
  }
  for (const d of po) {
    if (d.openValue <= 0) continue;
    const receipt = d.dueDate < asOf ? addDays(asOf, 7) : d.dueDate;
    const tDays = termDays(terms, d.groupNum ?? vendors.get(d.cardCode)?.groupNum);
    const amount = round(d.openValue);
    flows.push({ dir: 'out', source: 'Purchase order', docNum: d.docNum, partner: d.cardName, cardCode: d.cardCode,
      amount, weighted: amount, probability: 100, date: addDays(receipt, tDays),
      basis: `receive ${receipt} + ${tDays}d terms`,
      explain: flowExplain({
        dateSteps: [
          { label: 'Expected receipt', formula: 'PO delivery date; if already past, today + 7 days', value: receipt, detail: `PO delivery date ${d.dueDate}` },
          { label: '+ Supplier payment terms', value: `${tDays} days` },
          { label: '= Receipt + terms', value: addDays(receipt, tDays) }],
        dateNote: 'Goods are received and then paid after the supplier\'s payment terms.',
        prob: 1, amount, weighted: amount, probEx: certain('Payment probability', 'Open purchase order is expected to be received and paid'),
      }) });
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
    const status = STATUS_RULES.find(r => r.test(w));
    w.status = status.result;
    const steps = [
      { label: 'Opening balance', value: w.opening, detail: w.week === 1 ? `Opening balance (${openingSource})` : `Closing balance of week ${w.week - 1}` },
      { label: '+ A/R invoices in', formula: 'forecast (amount × probability) of invoices expected this week', value: w.arIn },
      { label: '+ Sales orders in', formula: `forecast (${Math.round(SO_CONVERSION * 100)}% of order value) expected this week`, value: w.soIn },
      { label: '− A/P invoices out', formula: 'supplier invoices due this week', value: w.apOut },
      { label: '− Purchase orders out', formula: 'POs to be paid this week', value: w.poOut },
      { label: '= Net (in − out)', value: w.net },
    ];
    w.explain = {
      closing: { title: `Closing balance, week ${w.week}`, steps, result: { label: 'Closing = opening + in − out', value: w.closing } },
      net: { title: `Net cash flow, week ${w.week}`, steps: steps.slice(1, 5), result: { label: 'Net = in − out', value: w.net } },
      status: { title: `Week ${w.week} status`,
        steps: [{ label: 'Net (in − out)', value: w.net }, { label: 'Closing balance', value: w.closing }],
        rules: STATUS_RULES.map(r => ({ rule: r.rule, result: r.result, hit: r === status })) },
    };
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
CASH G/L ACCOUNTS (current book balance, total ${fmtAmt(cash.balance)}):
${ctxTable(glAccounts, [['formatCode', 'Account'], ['acctName', 'Name'], ['balance', 'Balance']], 60)}
WEEKLY:
${ctxTable(wk, [['week', 'Wk'], ['start', 'From'], ['arIn', 'AR in'], ['soIn', 'SO in'], ['apOut', 'AP out'], ['poOut', 'PO out'], ['net', 'Net'], ['closing', 'Closing']], 52)}
TOP INFLOWS:
${ctxTable(inflows, [['source', 'Source'], ['docNum', 'Doc'], ['partner', 'Partner'], ['weighted', 'Expected'], ['date', 'Date'], ['basis', 'Basis']], 12)}
TOP OUTFLOWS:
${ctxTable(outflows, [['source', 'Source'], ['docNum', 'Doc'], ['partner', 'Partner'], ['weighted', 'Amount'], ['date', 'Date'], ['basis', 'Basis']], 12)}`;

  const flowCols = [
    { key: 'week', label: 'Week', fmt: 'int', hint: 'Forecast week (1 = the 7 days starting today) in which this payment is expected.' },
    { key: 'date', label: 'Expected', fmt: 'date', hint: 'Expected payment date: due/delivery date + payment terms + customer’s average days late; past dates move to today.' },
    { key: 'source', label: 'Source', fmt: 'badge', hint: 'Document type behind the cash movement: A/R invoice, sales order, A/P invoice or purchase order.' },
    { key: 'docNum', label: 'Doc #', hint: 'SAP document number of the invoice or order.' },
    { key: 'partner', label: 'Partner', sub: 'cardCode', hint: 'Customer (inflows) or supplier (outflows) with its business-partner code.' },
    { key: 'amount', label: 'Open amount', fmt: 'amt', hint: 'Amount still open on the document (unpaid invoice balance or not-yet-invoiced order value).' },
    { key: 'probability', label: 'Prob.', fmt: 'pct', hint: `Chance the money actually moves: A/R by days overdue (95% → 10%), sales orders ${Math.round(SO_CONVERSION * 100)}%, supplier payments 100%.` },
    { key: 'weighted', label: 'Forecast', fmt: 'amt', hint: 'Forecast = open amount × probability; this is the figure used in the weekly totals.' },
    { key: 'basis', label: 'Basis', wrap: true, hint: 'Short explanation of how the expected date was derived (due date, terms, days late, overdue).' },
  ];

  return {
    kpis: [
      { label: 'Opening balance', value: opening, fmt: 'amt', hint: openingSource, tab: glAccounts.length ? 'glcash' : undefined,
        calc: { formula: openingSource === 'entered' ? 'Opening balance entered in the options above (overrides the G/L).' : 'Σ current book balance of G/L cash & bank accounts (OACT.Finanse = Y).',
          steps: ['Read every G/L account flagged as a cash account in the chart of accounts.', 'Balance = posted debits − credits to date.', 'Type a value in "Opening balance" to override it.'],
          sources: [SRC.oact], tab: 'glcash', sortBy: 'balance', chart: null,
          stats: [{ label: 'Cash accounts', value: glAccounts.length, fmt: 'int' }, { label: 'G/L book balance', value: round(cash.balance), fmt: 'amt' },
            { label: 'Used as opening', value: round(opening), fmt: 'amt' }, { label: 'Negative accounts', value: glAccounts.filter(a => a.balance < 0).length, fmt: 'int' }] } },
      { label: `Inflows (${weeks}w)`, value: totIn, fmt: 'amt', tone: 'good', hint: 'Probability-weighted receipts in the horizon',
        calc: { formula: `Σ forecast receipts dated within ${weeks} weeks: A/R open balance × collection probability + open sales-order value × ${Math.round(SO_CONVERSION * 100)}%.`,
          steps: ['A/R date = due date + customer’s average days late (12 months); past dates move to today.', 'A/R probability: not due / ≤30d overdue 95%, 31–90d 85%, 91–180d 60%, 181–365d 30%, >365d 10%.', 'Sales order date = delivery date (past → today + 7) + payment terms + days late.'],
          sources: [SRC.oinv, SRC.ordr, SRC.hist, SRC.octg], tab: 'inflows', sortBy: 'weighted',
          stats: [{ label: 'From A/R invoices', value: sumBy(inflows, 'A/R invoice'), fmt: 'amt' }, { label: 'From sales orders', value: sumBy(inflows, 'Sales order'), fmt: 'amt' },
            { label: 'Open amount (unweighted)', value: round(inflows.reduce((s, f) => s + f.amount, 0)), fmt: 'amt' }, { label: 'Beyond horizon', value: round(later.in), fmt: 'amt' }] } },
      { label: `Outflows (${weeks}w)`, value: totOut, fmt: 'amt', tone: 'bad', hint: 'Supplier payments due in the horizon',
        calc: { formula: `Σ payments dated within ${weeks} weeks: open A/P invoice balance (on due date) + open purchase-order value (receipt + vendor terms). Counted at 100%.`,
          steps: ['A/P invoices are paid on their due date; overdue ones are paid today.', 'Purchase orders: expected receipt (past → today + 7 days) + vendor payment terms.'],
          sources: [SRC.opch, SRC.opor, SRC.octg], tab: 'outflows', sortBy: 'weighted',
          stats: [{ label: 'To A/P invoices', value: sumBy(outflows, 'A/P invoice'), fmt: 'amt' }, { label: 'To purchase orders', value: sumBy(outflows, 'Purchase order'), fmt: 'amt' },
            { label: 'Overdue A/P (pay now)', value: round(outflows.filter(f => f.source === 'A/P invoice' && f.date === asOf).reduce((s, f) => s + f.weighted, 0)), fmt: 'amt' }, { label: 'Beyond horizon', value: round(later.out), fmt: 'amt' }] } },
      { label: 'Net change', value: totIn - totOut, fmt: 'amt', tone: totIn - totOut >= 0 ? 'good' : 'bad', hint: 'Inflows − outflows',
        calc: { formula: `Net change = forecast inflows − outflows over ${weeks} weeks.`, sources: [SRC.oinv, SRC.ordr, SRC.opch, SRC.opor], tab: 'weekly', sortBy: 'net',
          stats: [{ label: 'Inflows', value: round(totIn), fmt: 'amt' }, { label: 'Outflows', value: round(totOut), fmt: 'amt' },
            { label: 'Weeks net positive', value: wk.filter(w => w.net >= 0).length, fmt: 'int' }, { label: 'Weeks net negative', value: wk.filter(w => w.net < 0).length, fmt: 'int' }] } },
      { label: 'Closing balance', value: bal, fmt: 'amt', tone: bal >= 0 ? 'good' : 'bad', hint: `Balance at the end of week ${weeks}`,
        calc: { formula: 'Closing = opening balance + Σ weekly (inflows − outflows).', steps: ['Each week: closing = previous closing + A/R in + sales orders in − A/P out − POs out.'],
          sources: [SRC.oact, SRC.oinv, SRC.ordr, SRC.opch, SRC.opor], tab: 'weekly', sortBy: 'closing',
          stats: [{ label: 'Opening', value: round(opening), fmt: 'amt' }, { label: '+ Inflows', value: round(totIn), fmt: 'amt' }, { label: '− Outflows', value: round(totOut), fmt: 'amt' }, { label: '= Closing', value: round(bal), fmt: 'amt' }] } },
      { label: `Lowest (wk ${low.week})`, value: low.closing, fmt: 'amt', tone: low.closing >= 0 ? 'good' : 'bad', hint: `${low.start} → ${low.end}`,
        calc: { formula: 'Minimum weekly closing balance across the horizon.', sources: [SRC.oact, SRC.oinv, SRC.ordr, SRC.opch, SRC.opor],
          rows: flows.filter(f => f.week === low.week).sort((a, z) => z.weighted - a.weighted), columns: FLOW_DRILL, sortBy: 'weighted',
          stats: [{ label: 'Week opening', value: low.opening, fmt: 'amt' }, { label: 'Inflow that week', value: low.inflow, fmt: 'amt' }, { label: 'Outflow that week', value: low.outflow, fmt: 'amt' }, { label: 'Net that week', value: low.net, fmt: 'amt' }] } },
      { label: 'Shortfall weeks', value: negWeeks.length, fmt: 'int', tone: negWeeks.length ? 'bad' : 'good', hint: 'Weeks closing below zero',
        calc: { formula: 'Count of weeks whose closing balance is below zero (status SHORTFALL).', steps: ['Status rules, first match wins: closing < 0 → SHORTFALL; net < 0 → DRAWDOWN; otherwise OK.'],
          sources: [SRC.oact, SRC.oinv, SRC.ordr, SRC.opch, SRC.opor], tab: 'weekly', filter: w => w.closing < 0, sortBy: 'closing',
          stats: [{ label: 'SHORTFALL weeks', value: negWeeks.length, fmt: 'int' }, { label: 'DRAWDOWN weeks', value: wk.filter(w => w.status === 'DRAWDOWN').length, fmt: 'int' },
            { label: 'First shortfall week', value: negWeeks[0] ? `W${negWeeks[0].week} (${negWeeks[0].start})` : '—' }, { label: 'Deepest gap', value: Math.min(0, low.closing), fmt: 'amt' }] } },
      { label: 'A/R at risk', value: atRiskAr, fmt: 'amt', tone: 'warn', hint: 'Open receivables discounted as unlikely to be collected',
        calc: { formula: 'Σ (open A/R balance − forecast) = Σ balance × (1 − collection probability) over all open A/R invoices.',
          steps: ['Probability by days overdue: ≤30d 95%, 31–90d 85%, 91–180d 60%, 181–365d 30%, >365d 10%.', 'Included regardless of horizon.'],
          sources: [SRC.oinv], rows: flows.filter(f => f.source === 'A/R invoice' && f.amount > f.weighted).map(f => ({ ...f, atRisk: round(f.amount - f.weighted) })),
          columns: [{ key: 'docNum', label: 'Invoice #' }, { key: 'partner', label: 'Customer', sub: 'cardCode' }, { key: 'basis', label: 'Basis' }, { key: 'amount', label: 'Open', fmt: 'amt' }, { key: 'probability', label: 'Prob.', fmt: 'pct' }, { key: 'atRisk', label: 'At risk', fmt: 'amt' }],
          sortBy: 'atRisk', chart: null,
          stats: [{ label: 'Open A/R', value: round(flows.filter(f => f.source === 'A/R invoice').reduce((s, f) => s + f.amount, 0)), fmt: 'amt' }, { label: 'At risk', value: round(atRiskAr), fmt: 'amt' },
            { label: 'Invoices > 90d overdue', value: ar.filter(i => daysBetween(i.dueDate, asOf) > 90).length, fmt: 'int' }] } },
    ],
    chart: {
      title: 'Weekly cash flow', type: 'bar', labels: wk.map(w => `W${w.week} ${w.start.slice(5)}`),
      desc: 'Green bars are forecast cash in, red bars (below zero) cash out per week; the blue line is the running closing balance — watch for it dipping below zero.',
      series: [
        { name: 'Inflow', values: wk.map(w => w.inflow), color: '#107E3E' },
        { name: 'Outflow', values: wk.map(w => -w.outflow), color: '#BB0000' },
        { name: 'Closing balance', values: wk.map(w => w.closing), type: 'line', color: '#0070F2' },
      ],
    },
    tabs: [
      { key: 'weekly', label: 'Weekly forecast', rows: wk,
        desc: 'One row per week: opening cash, expected receipts and payments, and the resulting closing balance — click a closing or status cell to see the build-up.',
        columns: [
          { key: 'week', label: 'Wk', fmt: 'int', hint: 'Forecast week number (week 1 starts on the as-of date).' },
          { key: 'start', label: 'From', fmt: 'date', hint: 'First day of the week.' }, { key: 'end', label: 'To', fmt: 'date', hint: 'Last day of the week.' },
          { key: 'opening', label: 'Opening', fmt: 'amt', hint: 'Cash at the start of the week = previous week’s closing (week 1 = opening balance).' },
          { key: 'arIn', label: 'A/R in', fmt: 'amt', hint: 'Forecast receipts from open customer invoices = Σ open balance × collection probability.' },
          { key: 'soIn', label: 'Sales orders in', fmt: 'amt', hint: `Forecast receipts from open sales orders = Σ open order value × ${Math.round(SO_CONVERSION * 100)}%.` },
          { key: 'apOut', label: 'A/P out', fmt: 'amt', hint: 'Supplier invoices falling due this week (overdue ones are paid in week 1).' },
          { key: 'poOut', label: 'POs out', fmt: 'amt', hint: 'Open purchase orders expected to be paid this week (receipt date + supplier terms).' },
          { key: 'net', label: 'Net', fmt: 'amt', hint: 'Net = (A/R in + sales orders in) − (A/P out + POs out).' },
          { key: 'closing', label: 'Closing', fmt: 'amt', hint: 'Closing = opening + net; the cash expected at the end of the week.' },
          { key: 'status', label: 'Status', fmt: 'badge', hint: 'SHORTFALL if closing < 0, DRAWDOWN if more goes out than comes in, otherwise OK.' },
        ] },
      { key: 'inflows', label: `Inflows (${inflows.length})`, rows: inflows, columns: flowCols,
        desc: 'Every expected customer receipt inside the horizon, largest first — use it to pick invoices and orders to chase.' },
      { key: 'outflows', label: `Outflows (${outflows.length})`, rows: outflows, columns: flowCols,
        desc: 'Every expected supplier payment inside the horizon, largest first — use it to see which payments or POs could be deferred.' },
      { key: 'glcash', label: `Cash G/L accounts (${glAccounts.length})`, rows: glAccounts,
        desc: 'Cash and bank G/L accounts whose current book balance makes up the opening balance.',
        columns: [
          { key: 'formatCode', label: 'G/L account', hint: 'G/L account code flagged as a cash/bank account in the chart of accounts.' },
          { key: 'acctName', label: 'Account name', wrap: true, hint: 'Name of the cash or bank account.' },
          { key: 'balance', label: 'Balance', fmt: 'amt', hint: 'Current book balance = posted debits − credits to date.' },
        ] },
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
