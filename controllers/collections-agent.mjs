/**
 * Collections & Receivables Agent — mounted at /api/collections-agent
 *
 * Builds a prioritised collection worklist from open A/R invoices, each
 * customer's historical payment behaviour (ORCT/RCT2), credit exposure (OCRD)
 * and locally logged promises-to-pay, and recommends the next collection step.
 */
import {
  createInsightRouter, AgentDataError, callAI, createSapActivity, ctxTable,
  agingBucket, AGING_BUCKETS, daysBetween, addDays, num, round, clamp, fmtAmt,
} from '../lib/insight-kit.mjs';
import {
  loadPartners, loadOpenInvoices, loadArPaymentHistory, summarisePaymentBehaviour,
  loadIncomingPayments, loadInvoicedByPartner, loadPaymentTerms, termDays, since,
} from '../lib/insight-data.mjs';
import { ptpRepo } from '../lib/insight-store.mjs';

const PTP_GRACE_DAYS = 3;

// KPI drill-through (calc blocks → lib/insight-kit.mjs withKpiDetails).
const SRC = {
  oinv: 'OINV — open A/R invoices (DocStatus O, not cancelled): DocTotal − PaidToDate = balance, DocDueDate',
  sales: 'OINV − ORIN — invoiced sales net of credit memos, last 90 days',
  hist: 'ORCT + RCT2 + OINV — invoices fully paid in the look-back period (days late = pay date − due date)',
  ocrd: 'OCRD — customer master: credit limit, open orders and deliveries balance',
  orct: 'ORCT — incoming payments of the last 180 days',
  ptp: 'Local promise-to-pay log (recorded from the worklist)',
};
const COL = { cust: { key: 'cardName', label: 'Customer', sub: 'cardCode', hint: 'Customer name and SAP business partner code' } };
const PTP_COLS = [COL.cust, { key: 'amount', label: 'Promised', fmt: 'amt', hint: 'Amount the customer promised to pay' },
  { key: 'promiseDate', label: 'Promise date', fmt: 'date', hint: 'Date by which the customer promised to pay' },
  { key: 'paidSince', label: 'Paid since', fmt: 'amt', hint: 'Incoming payments from this customer since the promise was logged (incl. grace days)' },
  { key: 'status', label: 'Status', fmt: 'badge', hint: 'OPEN, KEPT (≥ 98% paid in time) or BROKEN (not paid by promise date + grace)' },
  { key: 'note', label: 'Note', hint: 'Collector’s note recorded with the promise' }];
const OVERDUE_BUCKETS = AGING_BUCKETS.filter(b => b !== 'Current');
const bucketKey = b => `b_${b.replace(/\W/g, '_')}`;

// Evaluates each open promise against actual incoming payments and persists
// the outcome (kept / broken) so collectors see promise reliability.
function evaluatePromises(company, promises, payments, asOf) {
  return promises.map(p => {
    const paid = payments
      .filter(x => x.cardCode === p.card_code && x.date >= p.created_at && x.date <= addDays(p.promise_date, PTP_GRACE_DAYS))
      .reduce((s, x) => s + x.amount, 0);
    let status = p.status;
    if (status === 'open') {
      if (paid >= p.amount * 0.98) status = 'kept';
      else if (asOf > addDays(p.promise_date, PTP_GRACE_DAYS)) status = 'broken';
      if (status !== p.status) ptpRepo.setStatus(company, p.id, status);
    }
    return {
      id: p.id, cardCode: p.card_code, cardName: p.card_name, amount: p.amount, promiseDate: p.promise_date,
      createdAt: p.created_at, note: p.note, paidSince: round(paid), status: status.toUpperCase(),
      daysToPromise: daysBetween(asOf, p.promise_date),
    };
  });
}

// Collection-action rules, checked top to bottom; the first match wins. Kept as a
// table so the UI can show every rule with the one that applied (click the action).
const ACTION_RULES = [
  { rule: 'Nothing overdue', test: c => c.overdue <= 0,
    out: () => ({ priority: 'NONE', action: 'Not yet due — no action', channel: '—', reason: 'Nothing is overdue' }) },
  { rule: 'A promise-to-pay was broken in the last 90 days', test: c => c.brokenPromises > 0,
    out: () => ({ priority: 'HIGH', action: 'Broken promise: escalate to manager and place account on credit hold', channel: 'Manager call', reason: 'A promise-to-pay was broken in the last 90 days' }) },
  { rule: 'An open promise-to-pay has not reached its date', test: c => c.openPromise && c.openPromise.daysToPromise >= 0, label: 'Wait for the promised payment, then verify receipt',
    out: c => ({ priority: 'LOW', action: `Promise of ${fmtAmt(c.openPromise.amount)} due ${c.openPromise.promiseDate}: wait, then verify receipt`, channel: 'Monitor', reason: 'An open promise-to-pay has not reached its date yet' }) },
  { rule: 'Oldest invoice more than 90 days overdue', test: c => c.maxDaysOverdue > 90,
    out: () => ({ priority: 'HIGH', action: 'Final notice + credit hold; review for legal / collection agency', channel: 'Letter + call', reason: 'Oldest invoice is more than 90 days overdue' }) },
  { rule: 'Oldest invoice more than 60 days overdue', test: c => c.maxDaysOverdue > 60,
    out: () => ({ priority: 'HIGH', action: 'Manager call and formal reminder letter; stop new orders until paid', channel: 'Manager call', reason: 'Oldest invoice is more than 60 days overdue' }) },
  { rule: 'Oldest invoice more than 30 days overdue', test: c => c.maxDaysOverdue > 30,
    out: () => ({ priority: 'MEDIUM', action: 'Phone the customer and obtain a dated promise-to-pay', channel: 'Phone', reason: 'Oldest invoice is more than 30 days overdue' }) },
  { rule: 'Overdue up to 30 days and usually pays more than 15 days late', test: c => c.avgDaysLate > 15,
    out: () => ({ priority: 'MEDIUM', action: 'Send a friendly reminder email with statement', channel: 'Email', reason: 'Overdue up to 30 days, and usually pays more than 15 days late' }) },
  { rule: 'Overdue up to 30 days and usually pays on time', test: () => true,
    out: () => ({ priority: 'LOW', action: 'Send a friendly reminder email with statement', channel: 'Email', reason: 'Overdue up to 30 days, and usually pays on time' }) },
];

function recommend(c) {
  const hit = ACTION_RULES.findIndex(r => r.test(c));
  const rec = ACTION_RULES[hit].out(c);
  const why = {
    title: `Recommended action (${rec.priority})`,
    rules: ACTION_RULES.map((r, i) => {
      const o = i === hit ? rec : r.out({ openPromise: { amount: 0, promiseDate: '' } });
      return { rule: r.rule, result: `${o.priority} — ${r.label || o.action}`, hit: i === hit };
    }),
    note: 'Rules are checked from top to bottom; the first one that matches decides the action and priority.',
  };
  return { ...rec, explain: { action: why, priority: why } };
}

async function run(k, p) {
  const asOf = p.asOf;
  const lookbackDays = clamp(num(p.lookbackMonths) || 12, 1, 36) * 30;
  const customers = await loadPartners(k, 'C');
  const terms = await loadPaymentTerms(k);
  const invoices = await loadOpenInvoices(k, 'OINV');
  const behaviour = summarisePaymentBehaviour(await loadArPaymentHistory(k, since(asOf, lookbackDays)));
  const payments = await loadIncomingPayments(k, since(asOf, 180));
  const sales90 = await loadInvoicedByPartner(k, since(asOf, 90));
  const promises = evaluatePromises(k.company, ptpRepo.list(k.company), payments, asOf);

  const search = String(p.search || '').trim().toLowerCase();
  // A code picked from the customer list matches exactly; free text matches code or name.
  const exactCard = search && [...customers.keys()].find(code => code.toLowerCase() === search);
  const fromDate = String(p.fromDate || '').slice(0, 10);
  const toDate = String(p.toDate || '').slice(0, 10);
  const minDays = num(p.minOverdueDays);

  // Invoice level
  const invRows = invoices.map(inv => {
    const daysOverdue = daysBetween(inv.dueDate, asOf);
    return {
      docEntry: inv.docEntry, docNum: inv.docNum, cardCode: inv.cardCode, cardName: inv.cardName,
      docDate: inv.docDate, dueDate: inv.dueDate, total: round(inv.total), balance: round(inv.balance),
      daysOverdue, bucket: agingBucket(daysOverdue),
    };
  }).filter(r => (!search || (exactCard ? r.cardCode === exactCard
      : r.cardCode.toLowerCase().includes(search) || r.cardName.toLowerCase().includes(search)))
    && (!fromDate || r.docDate >= fromDate) && (!toDate || r.docDate <= toDate));

  // Customer level
  const byCard = new Map();
  for (const r of invRows) {
    const c = byCard.get(r.cardCode) || {
      cardCode: r.cardCode, cardName: r.cardName, outstanding: 0, overdue: 0, maxDaysOverdue: 0,
      overdueInvoices: 0, buckets: Object.fromEntries(AGING_BUCKETS.map(b => [b, 0])),
    };
    c.outstanding += r.balance;
    c.buckets[r.bucket] += r.balance;
    if (r.daysOverdue > 0) { c.overdue += r.balance; c.overdueInvoices++; c.maxDaysOverdue = Math.max(c.maxDaysOverdue, r.daysOverdue); }
    byCard.set(r.cardCode, c);
  }
  const maxOverdueAmt = Math.max(1, ...[...byCard.values()].map(c => c.overdue));
  const custRows = [...byCard.values()].map(c => {
    const bp = customers.get(c.cardCode) || {};
    const b = behaviour.get(c.cardCode);
    const mine = promises.filter(x => x.cardCode === c.cardCode);
    const openPromise = mine.filter(x => x.status === 'OPEN').sort((a, z) => a.promiseDate.localeCompare(z.promiseDate))[0] || null;
    const brokenPromises = mine.filter(x => x.status === 'BROKEN' && daysBetween(x.promiseDate, asOf) <= 90).length;
    // Open invoices (not OCRD.Balance, which can lag) + open orders + open deliveries.
    const exposure = c.outstanding + num(bp.ordersBal) + num(bp.dnotesBal);
    const overLimit = bp.creditLimit > 0 && exposure > bp.creditLimit;

    // Each part is kept so the UI can explain the score (click on the Score cell).
    const parts = c.overdue > 0 ? [
      { label: 'Overdue amount', max: 40, points: 40 * Math.sqrt(c.overdue / maxOverdueAmt),
        formula: '40 × √(overdue ÷ largest overdue)', detail: `${fmtAmt(c.overdue)} vs largest ${fmtAmt(maxOverdueAmt)}` },
      { label: 'Oldest overdue age', max: 25, points: 25 * Math.min(1, c.maxDaysOverdue / 120),
        formula: '25 × min(1, days ÷ 120)', detail: `${c.maxDaysOverdue} days overdue` },
      { label: 'Payment history', max: 15, points: b ? 15 * clamp(b.avgDaysLate / 60, 0, 1) : 7,
        formula: b ? '15 × clamp(avg days late ÷ 60, 0, 1)' : 'No payment history: neutral 7',
        detail: b ? `Pays ${b.avgDaysLate} days late on average (${b.paidInvoices} invoices)` : 'No paid invoices in the look-back period' },
      { label: 'Broken promise', max: 10, points: brokenPromises ? 10 : 0,
        formula: '+10 if a promise was broken in the last 90 days', detail: brokenPromises ? `${brokenPromises} broken` : 'None' },
      { label: 'Over credit limit', max: 10, points: overLimit ? 10 : 0,
        formula: '+10 if exposure > credit limit',
        detail: bp.creditLimit > 0 ? `Exposure ${fmtAmt(exposure)} vs limit ${fmtAmt(bp.creditLimit)}` : 'No credit limit set' },
    ] : [];
    const score = parts.reduce((s, x) => s + x.points, 0);
    const row = {
      ...c, outstanding: round(c.outstanding), overdue: round(c.overdue),
      oldestBucket: agingBucket(c.maxDaysOverdue),
      avgDaysLate: b?.avgDaysLate ?? null, onTimeRate: b?.onTimeRate ?? null, paidInvoices: b?.paidInvoices ?? 0,
      creditLimit: bp.creditLimit || 0, exposure: round(exposure), overLimit,
      terms: terms.get(String(bp.groupNum))?.name || '', phone: bp.phone || '', email: bp.email || '', contact: bp.contact || '',
      openPromise, brokenPromises,
      ptp: openPromise ? `${fmtAmt(openPromise.amount)} by ${openPromise.promiseDate}` : (brokenPromises ? `${brokenPromises} broken` : ''),
      score: Math.round(score),
    };
    const rec = recommend(row);
    const scoreBreakdown = {
      parts: parts.map(x => ({ ...x, points: round(x.points, 1) })),
      note: c.overdue > 0 ? 'Higher score = chase first. The list is sorted by score.' : 'Nothing overdue, so the score is 0.',
      priority: rec.priority, priorityReason: rec.reason,
    };
    return { ...row, ...rec, scoreBreakdown };
  })
    .filter(c => c.maxDaysOverdue >= minDays || (minDays <= 0))
    .sort((a, z) => z.score - a.score || z.overdue - a.overdue);

  // Totals
  const totalOut = invRows.reduce((s, r) => s + r.balance, 0);
  const totalOverdue = invRows.filter(r => r.daysOverdue > 0).reduce((s, r) => s + r.balance, 0);
  const over90 = invRows.filter(r => r.daysOverdue > 90).reduce((s, r) => s + r.balance, 0);
  const sales90Total = [...sales90.values()].reduce((s, x) => s + x.total, 0);
  const dso = sales90Total > 0 ? Math.round(totalOut / (sales90Total / 90)) : null;
  const overdueCustomers = custRows.filter(c => c.overdue > 0);
  const weekAhead = addDays(asOf, 7);
  const promisesDue = promises.filter(x => x.status === 'OPEN' && x.promiseDate <= weekAhead);
  const broken = promises.filter(x => x.status === 'BROKEN');

  const bucketRows = AGING_BUCKETS.map(b => {
    const rows = invRows.filter(r => r.bucket === b);
    const amt = rows.reduce((s, r) => s + r.balance, 0);
    return { bucket: b, amount: round(amt), share: totalOut ? round((amt / totalOut) * 100, 1) : 0, customers: new Set(rows.map(r => r.cardCode)).size, invoices: rows.length };
  });

  // Overdue invoices with the balance repeated in its own aging-bucket column.
  const overdueInv = invRows.filter(r => r.daysOverdue > 0).sort((a, z) => z.daysOverdue - a.daysOverdue)
    .map(r => ({ ...r, ...Object.fromEntries(OVERDUE_BUCKETS.map(b => [bucketKey(b), r.bucket === b ? r.balance : null])) }));

  const topOut = [...byCard.values()].sort((a, z) => z.outstanding - a.outstanding).slice(0, 10);

  const top = overdueCustomers[0];
  const insight = overdueCustomers.length
    ? `**${fmtAmt(totalOverdue)} overdue across ${overdueCustomers.length} customers (${totalOut ? Math.round((totalOverdue / totalOut) * 100) : 0}% of receivables).**\n\n` +
      `- ${fmtAmt(over90)} is more than 90 days overdue.\n` +
      `- Highest priority: **${top.cardName}** (${top.cardCode}) — ${fmtAmt(top.overdue)} overdue, oldest ${top.maxDaysOverdue} days. ${top.action}.\n` +
      (dso != null ? `- DSO is **${dso} days** based on the last 90 days of invoicing.\n` : '') +
      (broken.length ? `- ${broken.length} promise(s)-to-pay have been broken.\n` : '') +
      (promisesDue.length ? `- ${promisesDue.length} promise(s) fall due within 7 days — verify receipts.\n` : '')
    : '**No overdue receivables.** All open invoices are within terms.';

  const aiContext = `COLLECTIONS SNAPSHOT as of ${asOf}${search ? ` | Customer filter: ${p.search}` : ''}${fromDate || toDate ? ` | Invoice dates ${fromDate || '…'} to ${toDate || '…'}` : ''}
Outstanding ${fmtAmt(totalOut)} | Overdue ${fmtAmt(totalOverdue)} | >90d ${fmtAmt(over90)} | DSO ${dso ?? 'n/a'} | Overdue customers ${overdueCustomers.length}
AGING: ${bucketRows.map(b => `${b.bucket}=${fmtAmt(b.amount)}`).join(', ')}
PRIORITY WORKLIST (score 0-100, higher = chase first):
${ctxTable(overdueCustomers, [['cardName', 'Customer'], ['cardCode', 'Code'], ['overdue', 'Overdue'], ['maxDaysOverdue', 'MaxDays'], ['avgDaysLate', 'AvgDaysLate'], ['onTimeRate', 'OnTime%'], ['ptp', 'Promise'], ['score', 'Score'], ['action', 'RecommendedAction']], 25)}
PROMISES: ${promises.slice(0, 15).map(x => `${x.cardName} ${fmtAmt(x.amount)} by ${x.promiseDate} [${x.status}]`).join('; ') || 'none'}`;

  const actions = [
    { id: 'email', label: 'Draft email', kind: 'text', endpoint: '/api/collections-agent/draft-email' },
  ];

  return {
    kpis: [
      { label: 'Total receivables', value: totalOut, fmt: 'amt', hint: 'Balance of all open A/R invoices',
        calc: { formula: 'Σ (DocTotal − PaidToDate) over every open, non-cancelled A/R invoice in the filter.',
          steps: ['Read open A/R invoices (DocStatus O, CANCELED N).', 'Balance per invoice = DocTotal − PaidToDate.', 'Apply the customer / posting-date filters, then sum.'],
          sources: [SRC.oinv], rows: [...byCard.values()].map(c => ({ ...c, notDue: round(c.outstanding - c.overdue) })), sortBy: 'outstanding',
          columns: [COL.cust, { key: 'outstanding', label: 'Outstanding', fmt: 'amt', hint: 'Open A/R balance of the customer' },
            { key: 'overdue', label: 'Overdue', fmt: 'amt', hint: 'Part of the balance past its due date' }, { key: 'notDue', label: 'Not yet due', fmt: 'amt', hint: 'Outstanding − overdue' },
            { key: 'maxDaysOverdue', label: 'Oldest (days)', fmt: 'int', hint: 'Days past due of the oldest overdue invoice' }],
          stats: [{ label: 'Open invoices', value: invRows.length, fmt: 'int' }, { label: 'Customers', value: byCard.size, fmt: 'int' },
            { label: 'Not yet due', value: round(totalOut - totalOverdue), fmt: 'amt' }, { label: 'Overdue', value: round(totalOverdue), fmt: 'amt' }] } },
      { label: 'Overdue', value: totalOverdue, fmt: 'amt', tone: totalOverdue > 0 ? 'bad' : 'good', hint: 'Open balance past its due date',
        calc: { formula: 'Σ open balance of A/R invoices where DocDueDate < as-of date.',
          steps: ['Days overdue = as-of date − DocDueDate.', 'Invoices with days overdue > 0 are summed.'], sources: [SRC.oinv], tab: 'invoices', sortBy: 'balance',
          stats: [{ label: 'Overdue invoices', value: overdueInv.length, fmt: 'int' }, { label: 'Customers', value: overdueCustomers.length, fmt: 'int' },
            ...bucketRows.filter(b => b.bucket !== 'Current').map(b => ({ label: `${b.bucket} days`, value: b.amount, fmt: 'amt' }))] } },
      { label: 'Overdue %', value: totalOut ? (totalOverdue / totalOut) * 100 : 0, fmt: 'pct', tone: totalOverdue / (totalOut || 1) > 0.3 ? 'bad' : 'warn', hint: 'Overdue ÷ total receivables',
        calc: { formula: 'Overdue balance ÷ total open receivables × 100. Above 30% is shown red.', sources: [SRC.oinv], tab: 'aging', sortBy: 'amount',
          stats: [{ label: 'Overdue', value: round(totalOverdue), fmt: 'amt' }, { label: 'Total receivables', value: round(totalOut), fmt: 'amt' }, { label: 'Current share', value: bucketRows[0]?.share || 0, fmt: 'pct' }] } },
      { label: 'Over 90 days', value: over90, fmt: 'amt', tone: over90 > 0 ? 'bad' : 'good', hint: 'Balance more than 90 days past due',
        calc: { formula: 'Σ open balance of A/R invoices more than 90 days past DocDueDate (buckets 91-180 and 180+).', sources: [SRC.oinv], tab: 'invoices', sortBy: 'balance', filter: r => r.daysOverdue > 90,
          stats: [{ label: 'Invoices', value: overdueInv.filter(r => r.daysOverdue > 90).length, fmt: 'int' }, { label: '% of overdue', value: totalOverdue ? round((over90 / totalOverdue) * 100, 1) : 0, fmt: 'pct' },
            { label: '91-180 days', value: bucketRows.find(b => b.bucket === '91-180')?.amount || 0, fmt: 'amt' }, { label: '180+ days', value: bucketRows.find(b => b.bucket === '180+')?.amount || 0, fmt: 'amt' }] } },
      { label: 'DSO (days)', value: dso, fmt: 'int', hint: 'Receivables ÷ average daily invoicing over the last 90 days',
        calc: { formula: 'DSO = total receivables ÷ (net invoiced sales of the last 90 days ÷ 90).',
          steps: ['Net sales = A/R invoices − A/R credit memos posted in the last 90 days.', 'Average daily sales = net sales ÷ 90.', 'Shown as “—” when there were no sales in the period.'],
          sources: [SRC.oinv, SRC.sales], tab: 'aging',
          stats: [{ label: 'Total receivables', value: round(totalOut), fmt: 'amt' }, { label: 'Net sales (90 days)', value: round(sales90Total), fmt: 'amt' }, { label: 'Avg daily sales', value: round(sales90Total / 90), fmt: 'amt' }] } },
      { label: 'Customers overdue', value: overdueCustomers.length, fmt: 'int', hint: 'Customers with at least one overdue invoice',
        calc: { formula: 'Count of customers with at least one overdue open invoice (after the minimum-days filter).',
          steps: ['Group overdue invoices by customer.', 'Each customer gets a priority score (overdue amount 40, oldest age 25, history 15, broken promise 10, over limit 10) and a recommended action.'],
          sources: [SRC.oinv, SRC.hist, SRC.ocrd, SRC.ptp], tab: 'worklist', sortBy: 'overdue',
          stats: ['HIGH', 'MEDIUM', 'LOW'].map(pr => ({ label: `${pr} priority`, value: overdueCustomers.filter(c => c.priority === pr).length, fmt: 'int' })) } },
      { label: 'Promises due ≤7d', value: promisesDue.length, fmt: 'int', hint: 'Open promises-to-pay due within 7 days',
        calc: { formula: 'Count of open promises-to-pay whose promise date ≤ as-of date + 7 days.',
          steps: ['Promises are logged by collectors from the worklist.', `A promise is KEPT when incoming payments since it was logged reach 98% of the amount by promise date + ${PTP_GRACE_DAYS} days.`],
          sources: [SRC.ptp, SRC.orct], rows: promisesDue, sortBy: 'amount', columns: PTP_COLS, chart: null,
          stats: [{ label: 'Amount promised', value: round(promisesDue.reduce((s, x) => s + x.amount, 0)), fmt: 'amt' }, { label: 'Paid so far', value: round(promisesDue.reduce((s, x) => s + x.paidSince, 0)), fmt: 'amt' }] } },
      { label: 'Broken promises', value: broken.length, fmt: 'int', tone: broken.length ? 'bad' : 'good', hint: 'Promises not paid by their date',
        calc: { formula: `Count of promises-to-pay not paid (≥ 98% of amount) by promise date + ${PTP_GRACE_DAYS} days grace.`,
          steps: ['Checked on every run against incoming payments of the last 180 days.', 'A broken promise in the last 90 days adds 10 points to the customer’s score and escalates the action.'],
          sources: [SRC.ptp, SRC.orct], rows: broken, sortBy: 'amount', columns: PTP_COLS, chart: null,
          stats: [{ label: 'Amount promised', value: round(broken.reduce((s, x) => s + x.amount, 0)), fmt: 'amt' }, { label: 'Paid against them', value: round(broken.reduce((s, x) => s + x.paidSince, 0)), fmt: 'amt' }, { label: 'Kept promises', value: promises.filter(x => x.status === 'KEPT').length, fmt: 'int' }] } },
    ],
    charts: [
      { title: 'Receivables aging', type: 'bar', labels: bucketRows.map(b => b.bucket), series: [{ name: 'Balance', values: bucketRows.map(b => b.amount) }],
        desc: 'Open receivables by days past due; the further right the money sits, the harder it is to collect.' },
      { title: 'Top 10 outstanding by customer', type: 'bar', horizontal: true, stacked: true,
        desc: 'The ten customers with the largest open balance; the red part of each bar is already overdue.',
        labels: topOut.map(c => c.cardName || c.cardCode),
        series: [{ name: 'Overdue', values: topOut.map(c => round(c.overdue)), color: '#DC2626' },
          { name: 'Not yet due', values: topOut.map(c => round(c.outstanding - c.overdue)), color: '#94A3B8' }] },
    ],
    tabs: [
      { key: 'worklist', label: `Collection worklist (${overdueCustomers.length})`, rowKey: 'cardCode', actions, totals: true,
        rows: overdueCustomers,
        desc: 'Customers with overdue invoices, highest score first; work down the list, record promises-to-pay and send reminders from each row.',
        columns: [
          { key: 'priority', label: 'Priority', fmt: 'badge', hint: 'HIGH / MEDIUM / LOW from the collection rules: broken promise, age of oldest overdue (30/60/90 days), payment habits, open promise' },
          { key: 'cardName', label: 'Customer', sub: 'cardCode', hint: 'Customer name and SAP business partner code' },
          { key: 'overdue', label: 'Overdue', fmt: 'amt', hint: 'Open invoice balance past its due date' },
          { key: 'outstanding', label: 'Outstanding', fmt: 'amt', hint: 'Total open A/R balance (overdue + not yet due)' },
          { key: 'maxDaysOverdue', label: 'Oldest (days)', fmt: 'int', hint: 'Days past due of the oldest overdue invoice' },
          { key: 'avgDaysLate', label: 'Avg days late', fmt: 'int', hint: `Average days paid after due date over the last ${lookbackDays / 30} months` },
          { key: 'onTimeRate', label: 'On-time %', fmt: 'pct', hint: `Share of invoices paid by their due date over the last ${lookbackDays / 30} months` },
          { key: 'ptp', label: 'Promise', hint: 'Open promise-to-pay (amount and date) or number of broken promises' },
          { key: 'score', label: 'Score', fmt: 'score', invert: true, hint: '0-100, higher = chase first: overdue amount 40 + oldest age 25 + payment history 15 + broken promise 10 + over credit limit 10' },
          { key: 'action', label: 'Recommended action', wrap: true, hint: 'Next collection step from the first matching rule (click to see all rules)' },
        ] },
      { key: 'invoices', label: `Overdue invoices (${overdueInv.length})`, totals: true,
        desc: 'Every overdue A/R invoice grouped by customer, with its balance placed in its aging bucket; use it to quote invoice numbers when chasing.',
        // Grouped by customer; each group row totals the balance per aging bucket.
        groupBy: { key: 'cardCode', label: 'cardName', unit: 'invoices', groupUnit: 'customers',
          sum: ['total', 'balance', ...OVERDUE_BUCKETS.map(bucketKey)], max: ['daysOverdue'], sortBy: 'balance' },
        rows: overdueInv,
        columns: [
          { key: 'docNum', label: 'Invoice #', hint: 'SAP document number of the A/R invoice' },
          { key: 'cardName', label: 'Customer', sub: 'cardCode', hint: 'Customer name and SAP business partner code' },
          { key: 'docDate', label: 'Posted', fmt: 'date', hint: 'Posting date of the invoice' },
          { key: 'dueDate', label: 'Due', fmt: 'date', hint: 'Payment due date of the invoice' },
          { key: 'daysOverdue', label: 'Days overdue', fmt: 'int', hint: 'As-of date − due date' },
          { key: 'bucket', label: 'Bucket', fmt: 'badge', hint: 'Aging bucket by days overdue' },
          { key: 'total', label: 'Invoice total', fmt: 'amt', hint: 'Original document total of the invoice' },
          { key: 'balance', label: 'Balance', fmt: 'amt', hint: 'Still unpaid: invoice total − paid to date' },
          ...OVERDUE_BUCKETS.map(b => ({ key: bucketKey(b), label: `${b} days`, fmt: 'amt', hint: `Balance if the invoice is ${b} days overdue` })),
        ] },
      { key: 'aging', label: 'Aging summary', rows: bucketRows, totals: ['amount', 'invoices'],
        desc: 'Open receivables per aging bucket with their share of the total; a growing share in the older buckets signals collection problems.',
        columns: [
          { key: 'bucket', label: 'Bucket', fmt: 'badge', hint: 'Aging bucket by days past due (Current = not yet due)' },
          { key: 'amount', label: 'Balance', fmt: 'amt', hint: 'Open invoice balance in this bucket' },
          { key: 'share', label: 'Share', fmt: 'pct', hint: 'Bucket balance ÷ total receivables' },
          { key: 'customers', label: 'Customers', fmt: 'int', hint: 'Customers with an invoice in this bucket' },
          { key: 'invoices', label: 'Invoices', fmt: 'int', hint: 'Open invoices in this bucket' },
        ] },
    ],
    notes: [
      `Payment behaviour uses invoices fully paid in the last ${lookbackDays / 30} months; promise outcomes are checked against incoming payments with ${PTP_GRACE_DAYS} days' grace.`,
    ],
    insight, aiContext,
  };
}

function templateEmail(c, invoices) {
  const stage = c.maxDaysOverdue > 60 ? 'final' : c.maxDaysOverdue > 30 ? 'second' : 'first';
  const lines = invoices.map(i => `  • Invoice ${i.docNum} dated ${i.docDate}, due ${i.dueDate}: ${fmtAmt(i.balance)} (${i.daysOverdue} days overdue)`).join('\n');
  const opener = {
    first: 'This is a friendly reminder that the following invoice(s) are now past due:',
    second: 'Our records show the following invoice(s) remain unpaid despite our earlier reminder:',
    final: 'Despite previous reminders, the following invoice(s) remain seriously overdue:',
  }[stage];
  const close = {
    first: 'If payment has already been made, please share the remittance details so we can update our records.',
    second: 'Please arrange payment or let us know a firm payment date within the next 3 business days.',
    final: 'Please settle the full amount within 7 days. Otherwise we will have to place the account on hold for new orders and escalate the matter.',
  }[stage];
  return `Subject: ${stage === 'final' ? 'FINAL NOTICE — ' : 'Payment reminder — '}${fmtAmt(c.overdue)} overdue (${c.cardName})

Dear ${c.contact || c.cardName} team,

${opener}

${lines}

Total overdue: ${fmtAmt(c.overdue)}

${close}

Kind regards,
Accounts Receivable`;
}

export function createCollectionsAgentRouter(deps) {
  return createInsightRouter(deps, {
    slug: 'collections', title: 'Collections & Receivables Agent',
    defaults: { lookbackMonths: 12, minOverdueDays: 0 },
    persona: 'You are a senior credit & collections manager for a company running SAP Business One.',
    aiTask: 'Analyse this receivables and collections data. Identify who to chase first and why, patterns in payment behaviour, promise-to-pay reliability, and concrete collection actions.',
    run,
    extra(router, h) {
      const findCustomer = (req, cardCode) => {
        const last = h.lastFor(req);
        const tab = last?.tabs?.find(t => t.key === 'worklist');
        const c = tab?.rows.find(r => r.cardCode === cardCode);
        const inv = last?.tabs?.find(t => t.key === 'invoices')?.rows.filter(r => r.cardCode === cardCode) || [];
        return { c, inv };
      };

      // Filter-bar pick list: customer master (cached 10 min per company).
      const lookupCache = new Map();
      router.post('/lookups', h.requireAuth, async (req, res) => {
        try {
          const k = h.kit();
          const hit = lookupCache.get(k.company);
          if (hit && Date.now() - hit.at < 600_000) return res.json({ ok: true, ...hit.data });
          const customers = [...(await loadPartners(k, 'C')).values()]
            .map(c => ({ code: c.cardCode, name: c.cardName }))
            .sort((a, b) => (a.name || a.code).localeCompare(b.name || b.code, undefined, { sensitivity: 'base', numeric: true }) || a.code.localeCompare(b.code));
          const data = { customers };
          lookupCache.set(k.company, { at: Date.now(), data });
          res.json({ ok: true, ...data });
        } catch (e) { res.status(e instanceof AgentDataError ? 400 : 500).json({ ok: false, error: e.message }); }
      });

      router.post('/draft-email', h.requireAuth, async (req, res) => {
        const { c, inv } = findCustomer(req, req.body?.row?.cardCode);
        if (!c) return res.status(400).json({ ok: false, error: 'Customer not in the current analysis — re-run Analyze.' });
        const template = templateEmail(c, inv);
        const ai = await callAI(h.aiDeps(), [{ role: 'user', content: `Rewrite this dunning email so it is professional, firm but courteous, and matches the escalation stage. Keep every invoice number and amount exactly as given. Customer payment history: average ${c.avgDaysLate ?? 'unknown'} days late, on-time rate ${c.onTimeRate ?? 'unknown'}%.${c.brokenPromises ? ` They broke ${c.brokenPromises} promise(s) to pay recently.` : ''} Return only the email starting with "Subject:".\n\n${template}` }],
          'You write accounts-receivable collection emails.', 700);
        res.json({ ok: true, title: `Collection email — ${c.cardName}`, text: ai || template, to: c.email });
      });

      router.post('/activity', h.requireAuth, async (req, res) => {
        try {
          const { c, inv } = findCustomer(req, req.body?.row?.cardCode);
          if (!c) return res.status(400).json({ ok: false, error: 'Customer not in the current analysis — re-run Analyze.' });
          const r = await createSapActivity(h.getActiveSap(), {
            cardCode: c.cardCode, kind: 'call',
            subject: `Collection call: ${fmtAmt(c.overdue)} overdue`,
            notes: [`Collections Agent — priority ${c.priority} (score ${c.score})`, `Recommended: ${c.action}`, '',
              ...inv.filter(i => i.daysOverdue > 0).map(i => `Inv ${i.docNum} due ${i.dueDate}: ${fmtAmt(i.balance)} (${i.daysOverdue}d)`)].join('\n'),
          });
          res.json({ ok: true, message: `Activity ${r.activityCode ?? ''} created in SAP for ${c.cardName}. ${r.note || ''}` });
        } catch (e) { res.status(502).json({ ok: false, error: `SAP Service Layer: ${e.message}` }); }
      });

      router.post('/ptp', h.requireAuth, (req, res) => {
        try {
          const { row = {}, values = {} } = req.body || {};
          const amount = num(values.amount);
          const promiseDate = String(values.promiseDate || '').slice(0, 10);
          if (!row.cardCode || amount <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(promiseDate)) {
            return res.status(400).json({ ok: false, error: 'Customer, a positive amount and a promise date are required.' });
          }
          ptpRepo.create(h.kit().company, { cardCode: row.cardCode, cardName: row.cardName || '', amount, promiseDate, note: String(values.note || ''), createdBy: req.user?.username || '' });
          res.json({ ok: true, message: `Promise of ${fmtAmt(amount)} by ${promiseDate} logged for ${row.cardName || row.cardCode}.` });
        } catch (e) { res.status(e instanceof AgentDataError ? 400 : 500).json({ ok: false, error: e.message }); }
      });

      router.post('/ptp/status', h.requireAuth, (req, res) => {
        try {
          const { row = {}, status } = req.body || {};
          if (!['kept', 'broken', 'cancelled', 'open'].includes(status)) return res.status(400).json({ ok: false, error: 'Invalid status' });
          const r = ptpRepo.setStatus(h.kit().company, Number(row.id), status);
          if (!r.changes) return res.status(404).json({ ok: false, error: 'Promise not found' });
          res.json({ ok: true, message: `Promise marked ${status}.` });
        } catch (e) { res.status(e instanceof AgentDataError ? 400 : 500).json({ ok: false, error: e.message }); }
      });
    },
  });
}
