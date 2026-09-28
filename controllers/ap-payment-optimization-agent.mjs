/**
 * AP Payment Optimization Agent — mounted at /api/ap-payment-agent
 *
 * Builds a recommended supplier payment run: which open A/P invoices to pay,
 * on which date and for how much, within the cash available (less a reserve).
 * Each invoice is scored on:
 *   overdue days (35)      clear arrears first — late fees, supply holds
 *   early-pay discount (25) only when its annualised return beats the
 *                          cost-of-capital hurdle
 *   due-date proximity (15)
 *   vendor criticality (25) user-flagged priority vendors, or supply
 *                          dependency (share of our open PO value)
 * then cash is allocated greedily by score. Payments are scheduled on the
 * last day that still captures their value (today if overdue, the discount
 * deadline if taking the discount, otherwise the due date) to preserve cash.
 * Read-only: nothing is posted to SAP.
 */
import { createInsightRouter, ctxTable, daysBetween, addDays, num, round, clamp, fmtAmt } from '../lib/insight-kit.mjs';
import {
  loadPartners, loadOpenInvoices, loadOpenDocs, loadPaymentTerms, loadCashDiscounts, loadCashBalance,
  loadApPaymentHistory, summarisePaymentBehaviour, loadInvoicedByPartner, since,
} from '../lib/insight-data.mjs';

const STRATEGIES = {
  balanced:  { overdue: 35, discount: 25, due: 15, vendor: 25 },
  discounts: { overdue: 25, discount: 45, due: 10, vendor: 20 },
  overdue:   { overdue: 55, discount: 15, due: 10, vendor: 20 },
  preserve:  { overdue: 40, discount: 20, due: 10, vendor: 30 },   // + only must-pay items are funded
};

// Best discount still available on payDate: the tier with the fewest days
// whose deadline (doc date + days) has not passed yet.
function discountFor(inv, tiers, payDate) {
  if (!tiers?.length) return null;
  for (const t of tiers) {
    const deadline = addDays(inv.docDate, t.days);
    if (deadline >= payDate) return { pct: t.pct, deadline, days: t.days };
  }
  return null;
}

async function run(k, p) {
  const payDate = p.asOf;
  const horizon = clamp(Math.round(num(p.horizonDays) || 14), 1, 120);
  const horizonEnd = addDays(payDate, horizon);
  const hurdle = clamp(num(p.hurdleRatePct ?? 12), 0, 200);
  const strategyKey = STRATEGIES[p.strategy] ? p.strategy : 'balanced';
  const W = STRATEGIES[strategyKey];
  const allowPartial = p.allowPartial === true || p.allowPartial === 'yes';
  const priorityVendors = new Set(String(p.priorityVendors || '').split(/[,;\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean));

  const vendors = await loadPartners(k, 'S');
  const terms = await loadPaymentTerms(k);
  const discounts = await loadCashDiscounts(k);
  const invoices = await loadOpenInvoices(k, 'OPCH');
  const openPos = await loadOpenDocs(k, 'OPOR', 'POR1');
  const spend12 = await loadInvoicedByPartner(k, since(payDate, 365), 'OPCH', 'ORPC');
  const history = summarisePaymentBehaviour(await loadApPaymentHistory(k, since(payDate, 365)));

  let cash = p.cashAvailable;
  let cashSource = 'entered';
  if (cash === undefined || cash === null || cash === '') {
    const c = await loadCashBalance(k);
    cash = c.balance;
    cashSource = c.accounts ? `G/L cash & bank accounts (${c.accounts})` : 'none found — enter cash available';
  }
  cash = num(cash);
  const reserve = Math.max(0, num(p.reserve));
  const budget = Math.max(0, cash - reserve);

  // Supply dependency = vendor's share of all open PO value.
  const poByVendor = new Map();
  for (const d of openPos) poByVendor.set(d.cardCode, (poByVendor.get(d.cardCode) || 0) + d.openValue);
  const totalPo = [...poByVendor.values()].reduce((s, x) => s + x, 0) || 1;
  const maxPoShare = Math.max(0.0001, ...[...poByVendor.values()].map(v => v / totalPo));

  const rows = invoices.map(inv => {
    const bp = vendors.get(inv.cardCode) || {};
    const term = terms.get(String(inv.groupNum ?? bp.groupNum));
    const disc = term?.discCode ? discountFor(inv, discounts.get(term.discCode), payDate) : null;
    const daysToDue = daysBetween(payDate, inv.dueDate);
    const overdueDays = Math.max(0, -daysToDue);
    const discAmt = disc ? inv.balance * (disc.pct / 100) : 0;
    // Annualised return of paying early: pct/(1-pct) × 365 / days paid early.
    const earlyDays = disc ? Math.max(1, daysBetween(disc.deadline, inv.dueDate)) : 0;
    const discApr = disc ? (disc.pct / (100 - disc.pct)) * (365 / earlyDays) * 100 : 0;
    const discWorth = disc && discApr >= hurdle;
    const critical = priorityVendors.has(String(inv.cardCode).toUpperCase());
    const poShare = (poByVendor.get(inv.cardCode) || 0) / totalPo;

    const parts = {
      overdue: overdueDays > 0 ? W.overdue * (0.3 + 0.7 * Math.min(1, overdueDays / 60)) : 0,
      discount: discWorth ? W.discount * (0.6 + 0.4 * Math.min(1, discApr / (hurdle * 3 || 36))) : 0,
      due: daysToDue >= 0 && daysToDue <= horizon ? W.due * (1 - daysToDue / (horizon + 1)) : 0,
      vendor: critical ? W.vendor : W.vendor * 0.8 * (poShare / maxPoShare),
    };
    const score = Math.round(Object.values(parts).reduce((s, x) => s + x, 0));
    const inScope = overdueDays > 0 || daysToDue <= horizon || (discWorth && disc.deadline <= horizonEnd);
    const mustPay = overdueDays > 0 || daysToDue <= 3 || (discWorth && disc.deadline <= horizonEnd) || critical && daysToDue <= horizon;
    const scheduled = overdueDays > 0 ? payDate : discWorth ? disc.deadline : inv.dueDate < payDate ? payDate : inv.dueDate;
    const payAmount = discWorth ? inv.balance - discAmt : inv.balance;
    const h = history.get(inv.cardCode);
    const driver = Object.entries(parts).sort((a, z) => z[1] - a[1])[0];

    return {
      docEntry: inv.docEntry, docNum: inv.docNum, cardCode: inv.cardCode, cardName: inv.cardName,
      docDate: inv.docDate, dueDate: inv.dueDate, daysToDue, overdueDays,
      balance: round(inv.balance), payAmount: round(payAmount),
      discountPct: disc?.pct ?? null, discountDeadline: disc?.deadline ?? null, discountAmt: round(discAmt),
      discountApr: disc ? round(discApr, 1) : null, takeDiscount: !!discWorth, beatsHurdle: disc ? (discWorth ? 'YES' : 'NO') : '',
      terms: term?.name || '', critical: critical ? 'YES' : '', poShare: round(poShare * 100, 1),
      openPoValue: round(poByVendor.get(inv.cardCode) || 0), spend12m: round(Math.max(0, spend12.get(inv.cardCode)?.total || 0)),
      ourAvgDaysLate: h?.avgDaysLate ?? null, blocked: inv.payBlocked || bp.frozen,
      blockReason: inv.payBlocked ? 'Payment block on invoice' : bp.frozen ? 'Vendor is frozen/inactive' : '',
      score, inScope, mustPay, scheduled,
      mainReason: overdueDays > 0 ? `${overdueDays}d overdue`
        : discWorth ? `${disc.pct}% discount (${round(discApr, 0)}% p.a.) until ${disc.deadline}`
        : critical ? 'Priority vendor'
        : daysToDue <= horizon ? `Due in ${daysToDue}d`
        : `Due ${inv.dueDate}`,
      driver: { overdue: 'Overdue', discount: 'Discount', due: 'Due soon', vendor: critical ? 'Priority vendor' : 'Supply dependency' }[driver[0]],
    };
  });

  // ── Allocate cash ─────────────────────────────────────────────────────────
  let remaining = budget;
  const order = rows.filter(r => !r.blocked && r.inScope)
    .sort((a, z) => (z.mustPay - a.mustPay) || z.score - a.score || a.scheduled.localeCompare(z.scheduled));
  for (const r of order) {
    if (strategyKey === 'preserve' && !r.mustPay) {
      r.decision = 'DEFER'; r.reason = 'Preserve-cash strategy: not urgent, pay on a later run'; continue;
    }
    if (r.payAmount <= remaining + 0.005) {
      remaining -= r.payAmount;
      r.paid = r.payAmount;
      r.decision = r.takeDiscount ? 'TAKE DISCOUNT' : r.scheduled <= payDate ? 'PAY NOW' : 'PAY ON DUE DATE';
      r.reason = r.mainReason;
    } else if (allowPartial && remaining > 0 && r.mustPay && !r.takeDiscount) {
      r.paid = round(remaining);
      remaining = 0;
      r.decision = 'PART PAY';
      r.reason = `Only ${fmtAmt(r.paid)} of ${fmtAmt(r.payAmount)} fits the budget — pay part and agree a date for the rest`;
    } else {
      r.decision = 'NO CASH';
      r.reason = r.takeDiscount ? `Discount of ${fmtAmt(r.discountAmt)} will be lost — insufficient cash` : 'Insufficient cash — agree a payment date with the vendor';
    }
  }
  for (const r of rows) {
    if (r.decision) continue;
    if (r.blocked) { r.decision = 'HOLD'; r.reason = r.blockReason; }
    else { r.decision = 'LATER'; r.reason = `Due ${r.dueDate} — outside the ${horizon}-day window`; }
  }
  for (const r of rows) r.paid = round(r.paid || 0);

  const selected = rows.filter(r => r.paid > 0).sort((a, z) => a.scheduled.localeCompare(z.scheduled) || z.score - a.score);
  const unpaidInScope = rows.filter(r => ['NO CASH', 'DEFER', 'PART PAY'].includes(r.decision) || (r.decision === 'HOLD' && r.inScope));
  const discountRows = rows.filter(r => r.discountPct != null).sort((a, z) => (z.discountApr || 0) - (a.discountApr || 0));
  const overdueRows = rows.filter(r => r.overdueDays > 0).sort((a, z) => z.overdueDays - a.overdueDays);

  const sum = (list, f) => list.reduce((s, r) => s + num(r[f]), 0);
  const runTotal = sum(selected, 'paid');
  const captured = sum(selected.filter(r => r.decision === 'TAKE DISCOUNT'), 'discountAmt');
  const lost = sum(rows.filter(r => r.takeDiscount && r.decision !== 'TAKE DISCOUNT'), 'discountAmt');
  const overdueTotal = sum(overdueRows, 'balance');
  const overduePaid = sum(overdueRows, 'paid');
  const totalOpen = sum(rows, 'balance');
  const noCash = rows.filter(r => r.decision === 'NO CASH');
  // Unfunded = invoices that got nothing plus the unpaid remainder of part-payments.
  const shortfall = sum(noCash, 'payAmount') + rows.filter(r => r.decision === 'PART PAY').reduce((s, r) => s + r.payAmount - r.paid, 0);
  const n = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

  // Weekly schedule of the recommended run + remaining cash.
  const weeks = Math.max(1, Math.ceil((horizon + 1) / 7));
  const wk = Array.from({ length: weeks }, (_, i) => ({ week: i + 1, from: addDays(payDate, i * 7), to: addDays(payDate, i * 7 + 6), overdue: 0, discount: 0, due: 0, count: 0 }));
  for (const r of selected) {
    const w = wk[Math.min(weeks - 1, Math.floor(daysBetween(payDate, r.scheduled) / 7))];
    w.count++;
    if (r.overdueDays > 0) w.overdue += r.paid; else if (r.decision === 'TAKE DISCOUNT') w.discount += r.paid; else w.due += r.paid;
  }
  let bal = cash;
  for (const w of wk) { w.total = round(w.overdue + w.discount + w.due); bal -= w.total; w.cashAfter = round(bal); for (const f of ['overdue', 'discount', 'due']) w[f] = round(w[f]); }

  // Vendor summary
  const byVendor = new Map();
  for (const r of rows) {
    const v = byVendor.get(r.cardCode) || { cardCode: r.cardCode, cardName: r.cardName, invoices: 0, open: 0, overdue: 0, pay: 0, discount: 0, deferred: 0, critical: r.critical, poShare: r.poShare, ourAvgDaysLate: r.ourAvgDaysLate };
    v.invoices++; v.open += r.balance; if (r.overdueDays > 0) v.overdue += r.balance;
    v.pay += r.paid; if (r.decision === 'TAKE DISCOUNT') v.discount += r.discountAmt;
    if (['NO CASH', 'DEFER', 'PART PAY'].includes(r.decision)) v.deferred += r.payAmount - r.paid;
    byVendor.set(r.cardCode, v);
  }
  const vendorRows = [...byVendor.values()].map(v => ({ ...v, open: round(v.open), overdue: round(v.overdue), pay: round(v.pay), discount: round(v.discount), deferred: round(v.deferred) }))
    .sort((a, z) => z.pay - a.pay || z.overdue - a.overdue);

  const discountsConfigured = discounts.size > 0;
  const insight = `**Recommended payment run: ${fmtAmt(runTotal)} across ${n(selected.length, 'invoice')}${budget > 0 ? ` (${Math.round((runTotal / budget) * 100)}% of the ${fmtAmt(budget)} budget)` : ''}.**\n\n` +
    (budget <= 0 ? `- **No cash is available** after the reserve (cash ${fmtAmt(cash)}, reserve ${fmtAmt(reserve)}). Enter the actual cash available to get a payment run.\n` : '') +
    `- Overdue: ${fmtAmt(overduePaid)} of ${fmtAmt(overdueTotal)} cleared by this run${overdueTotal - overduePaid > 0 ? `; **${fmtAmt(overdueTotal - overduePaid)} stays overdue**` : ''}.\n` +
    (discountsConfigured
      ? `- Early-payment discounts captured: ${fmtAmt(captured)}${lost > 0 ? `; ${fmtAmt(lost)} worth taking is lost for lack of cash` : ''}.\n`
      : '- No cash-discount terms are set up on supplier payment terms, so no early-payment discounts apply.\n') +
    (shortfall > 0 ? `- ${n(noCash.length + rows.filter(r => r.decision === 'PART PAY').length, 'due or overdue invoice')} (${fmtAmt(shortfall)} unfunded) do not fully fit the budget — agree dates with those vendors.\n` : '') +
    (selected[0] ? `- Top priority: **${selected.slice().sort((a, z) => z.score - a.score)[0].cardName}** — ${selected.slice().sort((a, z) => z.score - a.score)[0].mainReason}.\n` : '') +
    (rows.some(r => r.blocked) ? `- ${n(rows.filter(r => r.blocked).length, 'invoice')} on hold (payment block or frozen vendor).\n` : '');

  const aiContext = `A/P PAYMENT RUN for ${payDate}, ${horizon}-day window, strategy ${strategyKey}, hurdle ${hurdle}% p.a., partial payments ${allowPartial ? 'allowed' : 'not allowed'}.
Cash ${fmtAmt(cash)} (${cashSource}), reserve ${fmtAmt(reserve)}, budget ${fmtAmt(budget)}. Open A/P ${fmtAmt(totalOpen)}; overdue ${fmtAmt(overdueTotal)}.
Run ${fmtAmt(runTotal)} (${selected.length} invoices), discounts captured ${fmtAmt(captured)}, lost ${fmtAmt(lost)}, unfunded due/overdue ${fmtAmt(shortfall)}. Priority vendors: ${[...priorityVendors].join(', ') || 'none'}.
PAYMENT RUN:
${ctxTable(selected, [['scheduled', 'PayOn'], ['cardName', 'Vendor'], ['docNum', 'Inv'], ['dueDate', 'Due'], ['paid', 'Pay'], ['discountAmt', 'Disc'], ['score', 'Score'], ['decision', 'Decision'], ['reason', 'Why']], 30)}
NOT FUNDED:
${ctxTable(unpaidInScope, [['cardName', 'Vendor'], ['docNum', 'Inv'], ['dueDate', 'Due'], ['overdueDays', 'Overdue'], ['payAmount', 'Amount'], ['decision', 'Decision']], 20)}
BY VENDOR:
${ctxTable(vendorRows, [['cardName', 'Vendor'], ['open', 'Open'], ['overdue', 'Overdue'], ['pay', 'PayNow'], ['poShare', 'OpenPO%'], ['ourAvgDaysLate', 'WePayLateBy']], 15)}`;

  const invCols = [
    { key: 'decision', label: 'Decision', fmt: 'badge', badge: { 'PAY NOW': 'green', 'TAKE DISCOUNT': 'purple', 'PAY ON DUE DATE': 'blue', 'PART PAY': 'amber', 'NO CASH': 'red', DEFER: 'amber', HOLD: 'grey', LATER: 'grey' } },
    { key: 'scheduled', label: 'Pay on', fmt: 'date' }, { key: 'cardName', label: 'Vendor', sub: 'cardCode' },
    { key: 'docNum', label: 'Invoice #' }, { key: 'dueDate', label: 'Due', fmt: 'date' },
    { key: 'overdueDays', label: 'Overdue (d)', fmt: 'int' }, { key: 'balance', label: 'Balance', fmt: 'amt' },
    { key: 'discountAmt', label: 'Discount', fmt: 'amt' }, { key: 'paid', label: 'Pay', fmt: 'amt', strong: true },
    { key: 'score', label: 'Priority', fmt: 'score', invert: true }, { key: 'critical', label: 'Priority vendor', fmt: 'badge' },
    { key: 'reason', label: 'Why', wrap: true },
  ];

  return {
    kpis: [
      { label: 'Cash available', value: cash, fmt: 'amt', hint: cashSource },
      { label: 'Payment budget', value: budget, fmt: 'amt', hint: `Cash less reserve of ${fmtAmt(reserve)}` },
      { label: 'Recommended run', value: runTotal, fmt: 'amt', tone: 'good' },
      { label: 'Invoices to pay', value: selected.length, fmt: 'int' },
      { label: 'Discounts captured', value: captured, fmt: 'amt', tone: captured ? 'good' : undefined },
      { label: 'Overdue left unpaid', value: overdueTotal - overduePaid, fmt: 'amt', tone: overdueTotal - overduePaid > 0 ? 'bad' : 'good' },
      { label: 'Unfunded due / overdue', value: shortfall, fmt: 'amt', tone: shortfall ? 'bad' : 'good' },
      { label: 'Cash after run', value: cash - runTotal, fmt: 'amt', tone: cash - runTotal >= reserve ? 'good' : 'bad' },
    ],
    chart: {
      title: 'Payment schedule by week', type: 'bar', labels: wk.map(w => `W${w.week} ${w.from.slice(5)}`),
      series: [
        { name: 'Overdue', values: wk.map(w => w.overdue), color: '#DC2626' },
        { name: 'Discount', values: wk.map(w => w.discount), color: '#7C3AED' },
        { name: 'Due', values: wk.map(w => w.due), color: '#2563EB' },
        { name: 'Cash after', values: wk.map(w => w.cashAfter), type: 'line', color: '#059669' },
      ],
    },
    tabs: [
      { key: 'run', label: `Payment run (${selected.length})`, rows: selected, columns: invCols },
      { key: 'unfunded', label: `Not funded (${unpaidInScope.length})`, rows: unpaidInScope.sort((a, z) => z.score - a.score), columns: invCols },
      { key: 'overdue', label: `Overdue (${overdueRows.length})`, rows: overdueRows, columns: invCols },
      { key: 'discounts', label: `Discounts (${discountRows.length})`, rows: discountRows,
        columns: [invCols[0], { key: 'cardName', label: 'Vendor', sub: 'cardCode' }, { key: 'docNum', label: 'Invoice #' },
          { key: 'balance', label: 'Balance', fmt: 'amt' }, { key: 'discountPct', label: 'Discount %', fmt: 'num' },
          { key: 'discountDeadline', label: 'Pay by', fmt: 'date' }, { key: 'dueDate', label: 'Net due', fmt: 'date' },
          { key: 'discountAmt', label: 'Saving', fmt: 'amt', strong: true }, { key: 'discountApr', label: 'Annualised', fmt: 'pct' },
          { key: 'beatsHurdle', label: 'Beats hurdle', fmt: 'badge', badge: { YES: 'green', NO: 'grey' } }] },
      { key: 'schedule', label: 'Weekly schedule', rows: wk,
        columns: [{ key: 'week', label: 'Wk', fmt: 'int' }, { key: 'from', label: 'From', fmt: 'date' }, { key: 'to', label: 'To', fmt: 'date' },
          { key: 'count', label: 'Invoices', fmt: 'int' }, { key: 'overdue', label: 'Overdue', fmt: 'amt' }, { key: 'discount', label: 'Discount', fmt: 'amt' },
          { key: 'due', label: 'Due', fmt: 'amt' }, { key: 'total', label: 'Total', fmt: 'amt', strong: true }, { key: 'cashAfter', label: 'Cash after', fmt: 'amt' }] },
      { key: 'vendors', label: `By vendor (${vendorRows.length})`, rows: vendorRows,
        columns: [{ key: 'cardName', label: 'Vendor', sub: 'cardCode' }, { key: 'invoices', label: 'Invoices', fmt: 'int' },
          { key: 'open', label: 'Open', fmt: 'amt' }, { key: 'overdue', label: 'Overdue', fmt: 'amt' }, { key: 'pay', label: 'Pay in run', fmt: 'amt', strong: true },
          { key: 'discount', label: 'Discount', fmt: 'amt' }, { key: 'deferred', label: 'Not funded', fmt: 'amt' },
          { key: 'poShare', label: 'Open PO share', fmt: 'pct' }, { key: 'ourAvgDaysLate', label: 'We pay late by (d)', fmt: 'int' },
          { key: 'critical', label: 'Priority', fmt: 'badge' }] },
    ],
    notes: [
      `Strategy "${strategyKey}" weights: overdue ${W.overdue}, discount ${W.discount}, due-date ${W.due}, vendor ${W.vendor}. Must-pay items (overdue, due within 3 days, discounts worth taking, priority vendors due in the window) are funded first, then by score.`,
      `A discount is taken only if its annualised return (pct ÷ (100 − pct) × 365 ÷ days paid early) is at least the ${hurdle}% hurdle. Payments are scheduled on the latest date that still captures their value.`,
      `Cash: ${cashSource}. Supply dependency = the vendor's share of all open purchase-order value. Nothing is posted to SAP — use the CSV export to prepare the payment run.`,
      discountsConfigured ? '' : 'No cash-discount tiers (OCDC/CDC1) are linked to supplier payment terms on this company.',
    ].filter(Boolean),
    insight, aiContext,
  };
}

export function createApPaymentOptimizationRouter(deps) {
  return createInsightRouter(deps, {
    slug: 'appayment', title: 'AP Payment Optimization Agent',
    defaults: { horizonDays: 14, hurdleRatePct: 12, strategy: 'balanced', reserve: 0 },
    persona: 'You are a treasury and accounts-payable manager planning supplier payment runs in SAP Business One.',
    aiTask: 'Review this recommended supplier payment run. Explain what is being paid and why, which vendors are left unpaid and the risk of that, discounts worth taking, and how to sequence payments if cash is tight.',
    run,
  });
}
