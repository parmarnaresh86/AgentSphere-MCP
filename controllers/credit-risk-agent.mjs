/**
 * Credit Risk Agent — mounted at /api/credit-risk-agent
 *
 * Scores every active customer 0-100 (higher = riskier) from overdue share,
 * age of the oldest overdue invoice, historical days-late, credit-limit
 * utilisation (or months of exposure when no limit is set) and new-order
 * exposure while overdue. Grades A-E, recommends terms and a credit limit, and
 * snapshots scores daily (SQLite) so each run shows movement since last time.
 */
import { createInsightRouter, ctxTable, daysBetween, num, round, clamp, fmtAmt } from '../lib/insight-kit.mjs';
import {
  loadPartners, loadOpenInvoices, loadOpenDocs, loadArPaymentHistory, summarisePaymentBehaviour,
  loadInvoicedByPartner, loadPaymentTerms, termDays, since,
} from '../lib/insight-data.mjs';
import { creditSnapRepo } from '../lib/insight-store.mjs';

const GRADES = [
  { grade: 'A', max: 20, label: 'Low risk', rec: 'Normal terms; eligible for a limit increase', factor: 1.5 },
  { grade: 'B', max: 40, label: 'Moderate', rec: 'Normal terms; review quarterly', factor: 1.2 },
  { grade: 'C', max: 60, label: 'Elevated', rec: 'Monitor; require a promise-to-pay before releasing new orders', factor: 1.0 },
  { grade: 'D', max: 80, label: 'High', rec: 'Credit hold on new orders until overdue is cleared', factor: 0.5 },
  { grade: 'E', max: 101, label: 'Severe', rec: 'Stop supply; cash-in-advance only; consider legal recovery', factor: 0 },
];
const gradeOf = score => GRADES.find(g => score < g.max);

// "How is this calculated?" popups for one register row. Uses the same parts,
// grade table and inputs the score/limit were computed from.
function explainRow({ a, bp, b, parts, score, g, util, expMonths, overdueRatio, exposure, sales, avgMonthly, tDays, suggestedLimit, p0, delta }) {
  const pct = v => `${round(v * 100, 1)}%`;
  const scoreParts = [
    { label: 'Overdue share', max: 25, points: parts.overdue, formula: '25 × overdue ÷ outstanding',
      detail: `${fmtAmt(a.overdue)} overdue of ${fmtAmt(a.outstanding)} (${pct(overdueRatio)})` },
    { label: 'Age of oldest overdue', max: 20, points: parts.age, formula: '20 × min(1, days overdue ÷ 120)',
      detail: a.maxDaysOverdue ? `${a.maxDaysOverdue} days overdue` : 'Nothing overdue' },
    { label: 'Pays late (history)', max: 20, points: parts.history,
      formula: b ? '20 × clamp(avg days late ÷ 60, 0, 1)' : 'No payment history: 10 if exposed, else 0',
      detail: b ? `Pays ${b.avgDaysLate} days late on average (${b.paidInvoices} invoices, 12 months)` : 'No paid invoices in the last 12 months' },
    util != null
      ? { label: 'Limit utilisation', max: 20, points: parts.utilisation, formula: '20 × clamp((exposure ÷ limit − 50%) ÷ 50%, 0, 1)',
        detail: `Exposure ${fmtAmt(exposure)} vs limit ${fmtAmt(bp.creditLimit)} (${pct(util)})` }
      : { label: 'Exposure vs sales (no limit)', max: 20, points: parts.utilisation, formula: '20 × clamp((months of exposure − 1) ÷ 2, 0, 1)',
        detail: avgMonthly > 0 ? `Exposure ${fmtAmt(exposure)} = ${round(expMonths, 1)} months of avg sales ${fmtAmt(avgMonthly)}` : 'No sales in 12 months' },
    { label: 'New orders while overdue', max: 15, points: parts.orders, formula: '15 × min(1, overdue share × 2), only if open orders',
      detail: a.openOrders > 0 ? `Open orders ${fmtAmt(a.openOrders)}, overdue share ${pct(overdueRatio)}` : 'No open sales orders' },
  ].map(x => ({ ...x, points: round(x.points, 1) }));
  const gradeRules = GRADES.map((x, i) => ({
    rule: i === 0 ? `Score below ${x.max}` : x.max > 100 ? `Score ${GRADES[i - 1].max} or more` : `Score ${GRADES[i - 1].max}–${x.max - 1}`,
    result: `${x.grade} · ${x.label}`, hit: x.grade === g.grade,
  }));
  const recRules = GRADES.map(x => ({ rule: `Grade ${x.grade}`, result: x.rec, hit: x.grade === g.grade }));
  return {
    score: { title: `Risk score ${score}`, parts: scoreParts, note: 'Higher score = riskier. Grade: A below 20, B below 40, C below 60, D below 80, E 80+.' },
    grade: { title: `Grade ${g.grade} · ${g.label}`, result: { label: 'Risk score', value: score }, rules: gradeRules },
    recommendation: { title: 'Recommendation', result: { label: `Grade ${g.grade} (score ${score})`, value: g.label }, rules: recRules },
    suggestedLimit: {
      title: `Suggested limit ${fmtAmt(suggestedLimit)}`,
      steps: [
        { label: 'Average monthly sales', formula: 'Net sales last 12 months ÷ 12', value: round(avgMonthly), detail: `${fmtAmt(sales)} in 12 months` },
        { label: 'Terms cover', formula: 'Terms days ÷ 30 + 1 month', value: round(tDays / 30 + 1, 2), detail: `${tDays}-day terms` },
        { label: 'Grade factor', formula: 'A 1.5, B 1.2, C 1.0, D 0.5, E 0', value: g.factor, detail: `Grade ${g.grade}` },
      ],
      result: { label: 'Suggested limit (rounded to 1,000)', value: suggestedLimit },
      note: `Current limit ${fmtAmt(bp.creditLimit)}; change ${suggestedLimit - bp.creditLimit >= 0 ? '+' : ''}${fmtAmt(suggestedLimit - bp.creditLimit)}.`,
    },
    atRisk: {
      title: 'Risk-weighted exposure',
      steps: [
        { label: 'Exposure', formula: 'Open invoices + open sales orders + open deliveries', value: round(exposure),
          detail: `${fmtAmt(a.outstanding)} + ${fmtAmt(a.openOrders)} + ${fmtAmt(bp.dnotesBal)}` },
        { label: 'Risk score', formula: '0–100', value: score },
      ],
      result: { label: 'Risk-weighted = exposure × score ÷ 100', value: round(exposure * score / 100) },
    },
    trend: {
      title: 'Trend since last run',
      steps: p0 ? [
        { label: 'Previous score', value: p0.score, detail: `Snapshot ${p0.snap_date}, grade ${p0.grade}` },
        { label: 'Score today', value: score },
        { label: 'Change', formula: 'Today − previous', value: delta },
      ] : [{ label: 'Previous score', value: '—', detail: 'No earlier snapshot for this customer' }],
      rules: [
        { rule: 'No earlier snapshot', result: 'NEW', hit: delta == null },
        { rule: 'Score up 5 or more', result: 'WORSE', hit: delta != null && delta >= 5 },
        { rule: 'Score down 5 or more', result: 'BETTER', hit: delta != null && delta <= -5 },
        { rule: 'Change within ±4', result: 'STABLE', hit: delta != null && delta > -5 && delta < 5 },
      ],
    },
  };
}

async function run(k, p) {
  const asOf = p.asOf;
  const customers = await loadPartners(k, 'C');
  const terms = await loadPaymentTerms(k);
  const invoices = await loadOpenInvoices(k, 'OINV');
  const orders = await loadOpenDocs(k, 'ORDR', 'RDR1');
  const behaviour = summarisePaymentBehaviour(await loadArPaymentHistory(k, since(asOf, 365)));
  const sales12 = await loadInvoicedByPartner(k, since(asOf, 365));
  const prev = creditSnapRepo.previous(k.company, asOf);

  const agg = new Map();
  const get = card => {
    if (!agg.has(card)) agg.set(card, { outstanding: 0, overdue: 0, maxDaysOverdue: 0, openOrders: 0, orderCount: 0 });
    return agg.get(card);
  };
  for (const inv of invoices) {
    const a = get(inv.cardCode);
    const d = daysBetween(inv.dueDate, asOf);
    a.outstanding += inv.balance;
    if (d > 0) { a.overdue += inv.balance; a.maxDaysOverdue = Math.max(a.maxDaysOverdue, d); }
  }
  for (const o of orders) { const a = get(o.cardCode); a.openOrders += o.openValue; a.orderCount++; }
  for (const [card, s] of sales12) if (s.total > 0) get(card);

  const rows = [];
  const partsOf = new Map();   // cardCode → score components (for the Avg risk score drill-through)
  for (const [card, a] of agg) {
    const bp = customers.get(card);
    if (!bp) continue;
    const b = behaviour.get(card);
    const sales = Math.max(0, sales12.get(card)?.total || 0);
    const avgMonthly = sales / 12;
    const exposure = a.outstanding + a.openOrders + bp.dnotesBal;
    if (exposure <= 0 && sales <= 0) continue;
    const overdueRatio = a.outstanding > 0 ? a.overdue / a.outstanding : 0;
    const util = bp.creditLimit > 0 ? exposure / bp.creditLimit : null;
    const expMonths = avgMonthly > 0 ? exposure / avgMonthly : (exposure > 0 ? 99 : 0);

    const parts = {
      overdue: 25 * overdueRatio,
      age: 20 * Math.min(1, a.maxDaysOverdue / 120),
      history: b ? 20 * clamp(b.avgDaysLate / 60, 0, 1) : (exposure > 0 ? 10 : 0),
      utilisation: util != null ? 20 * clamp((util - 0.5) / 0.5, 0, 1) : 20 * clamp((expMonths - 1) / 2, 0, 1),
      orders: a.openOrders > 0 ? 15 * clamp(overdueRatio * 2, 0, 1) : 0,
    };
    const score = Math.round(Object.values(parts).reduce((s, x) => s + x, 0));
    const g = gradeOf(score);
    const tDays = termDays(terms, bp.groupNum);
    const suggestedLimit = Math.round((avgMonthly * (tDays / 30 + 1) * g.factor) / 1000) * 1000;
    const p0 = prev.get(card);
    const delta = p0 ? score - p0.score : null;

    const flags = [];
    if (!bp.creditLimit) flags.push('No limit set');
    if (util != null && util > 1) flags.push(`Over limit ${Math.round(util * 100)}%`);
    if (a.openOrders > 0 && a.maxDaysOverdue > 60) flags.push('Orders open while >60d overdue');
    if (!b && exposure > 0) flags.push('No payment history');
    if (bp.frozen) flags.push('BP frozen');
    if (delta != null && delta >= 10) flags.push(`Worsened +${delta}`);

    partsOf.set(card, parts);
    const driver = Object.entries(parts).sort((x, y) => y[1] - x[1])[0];
    rows.push({
      cardCode: card, cardName: bp.cardName, grade: g.grade, band: g.label, score, delta,
      prevGrade: p0?.grade || '', trend: delta == null ? 'NEW' : delta >= 5 ? 'WORSE' : delta <= -5 ? 'BETTER' : 'STABLE',
      outstanding: round(a.outstanding), overdue: round(a.overdue), overduePct: round(overdueRatio * 100, 1),
      maxDaysOverdue: a.maxDaysOverdue, avgDaysLate: b?.avgDaysLate ?? null, onTimeRate: b?.onTimeRate ?? null,
      openOrders: round(a.openOrders), exposure: round(exposure), atRisk: round(exposure * score / 100), creditLimit: bp.creditLimit,
      utilisation: util != null ? round(util * 100, 1) : null, sales12m: round(sales),
      exposureMonths: expMonths >= 99 ? null : round(expMonths, 1), terms: terms.get(String(bp.groupNum))?.name || `${tDays}d`,
      suggestedLimit, limitChange: suggestedLimit - bp.creditLimit,
      mainDriver: { overdue: 'Overdue share', age: 'Age of overdue', history: 'Pays late', utilisation: util != null ? 'Limit utilisation' : 'Exposure vs sales', orders: 'New orders while overdue' }[driver[0]],
      flags: flags.join(', '), recommendation: g.rec,
      explain: explainRow({ a, bp, b, parts, score, g, util, expMonths, overdueRatio, exposure, sales, avgMonthly, tDays, suggestedLimit, p0, delta }),
    });
  }
  rows.sort((a, z) => z.score - a.score || z.exposure - a.exposure);
  creditSnapRepo.save(k.company, asOf, rows);

  const byGrade = GRADES.map(g => {
    const r = rows.filter(x => x.grade === g.grade);
    return { grade: g.grade, band: g.label, customers: r.length, exposure: round(r.reduce((s, x) => s + x.exposure, 0)), overdue: round(r.reduce((s, x) => s + x.overdue, 0)), recommendation: g.rec };
  });
  const totalExp = rows.reduce((s, r) => s + r.exposure, 0);
  const highRisk = rows.filter(r => r.grade === 'D' || r.grade === 'E');
  const highExp = highRisk.reduce((s, r) => s + r.exposure, 0);
  const worse = rows.filter(r => r.trend === 'WORSE');
  const noLimit = rows.filter(r => !r.creditLimit);
  const ordersAtRisk = rows.filter(r => r.openOrders > 0 && (r.grade === 'D' || r.grade === 'E'));
  // Watchlist ranks by risk-weighted exposure so a tiny account with a high
  // score doesn't outrank a large one that is nearly as risky.
  const watch = rows.filter(r => r.grade === 'D' || r.grade === 'E' || r.trend === 'WORSE').sort((a, z) => z.atRisk - a.atRisk);

  const topRisk = watch[0] || rows[0];
  const insight = `**${highRisk.length} of ${rows.length} active customers are high/severe risk (D/E), holding ${fmtAmt(highExp)} (${totalExp ? Math.round((highExp / totalExp) * 100) : 0}%) of total exposure.**\n\n` +
    (topRisk ? `- Largest risk-weighted exposure: **${topRisk.cardName}** — score ${topRisk.score} (${topRisk.grade}), ${fmtAmt(topRisk.overdue)} overdue, oldest ${topRisk.maxDaysOverdue}d. Driver: ${topRisk.mainDriver}.\n` : '') +
    (ordersAtRisk.length ? `- ${ordersAtRisk.length} D/E customers still have open sales orders worth ${fmtAmt(ordersAtRisk.reduce((s, r) => s + r.openOrders, 0))} — review before delivery.\n` : '') +
    (worse.length ? `- ${worse.length} customers worsened by 5+ points since the last run.\n` : '') +
    (noLimit.length ? `- ${noLimit.length} customers have **no credit limit** set in SAP; the Limit review tab suggests one from 12-month sales and terms.\n` : '');

  const aiContext = `CREDIT RISK REGISTER as of ${asOf}. Score 0-100 (higher = riskier). Grades: ${GRADES.map(g => `${g.grade}<${g.max}`).join(', ')}.
Active customers ${rows.length}, total exposure ${fmtAmt(totalExp)}, D/E exposure ${fmtAmt(highExp)}, worsened ${worse.length}, without limit ${noLimit.length}.
GRADES: ${byGrade.map(g => `${g.grade}: ${g.customers} cust, exp ${fmtAmt(g.exposure)}`).join('; ')}
TOP RISK (by risk-weighted exposure):
${ctxTable(watch.length ? watch : rows, [['cardName', 'Customer'], ['cardCode', 'Code'], ['score', 'Score'], ['grade', 'Gr'], ['delta', 'Δ'], ['atRisk', 'RiskWeighted'], ['overdue', 'Overdue'], ['maxDaysOverdue', 'MaxDays'], ['avgDaysLate', 'AvgLate'], ['exposure', 'Exposure'], ['creditLimit', 'Limit'], ['openOrders', 'OpenSO'], ['mainDriver', 'Driver'], ['flags', 'Flags']], 25)}`;

  const cols = [
    { key: 'grade', label: 'Grade', fmt: 'badge', hint: 'Risk grade from the score: A < 20, B < 40, C < 60, D < 80, E 80+' },
    { key: 'cardName', label: 'Customer', sub: 'cardCode', hint: 'Customer name and SAP business partner code' },
    { key: 'score', label: 'Risk score', fmt: 'score', invert: true, hint: '0-100, higher = riskier: overdue share 25 + age of oldest overdue 20 + days late 20 + limit use 20 + orders while overdue 15' },
    { key: 'trend', label: 'Trend', fmt: 'badge', sub: 'delta', badge: { WORSE: 'red', BETTER: 'green', STABLE: 'grey', NEW: 'blue' }, hint: 'Score change since the previous run: WORSE +5 or more, BETTER −5 or more, NEW = no earlier snapshot' },
    { key: 'exposure', label: 'Exposure', fmt: 'amt', hint: 'Open A/R invoices + open sales orders + delivered-not-invoiced balance' },
    { key: 'atRisk', label: 'Risk-weighted', fmt: 'amt', hint: 'Exposure × risk score ÷ 100 — used to rank the watchlist' },
    { key: 'overdue', label: 'Overdue', fmt: 'amt', hint: 'Open invoice balance already past its due date' },
    { key: 'maxDaysOverdue', label: 'Oldest (d)', fmt: 'int', hint: 'Days past due of the oldest overdue invoice' },
    { key: 'avgDaysLate', label: 'Avg late (d)', fmt: 'int', hint: 'Average days paid after due date over the last 12 months (blank = no payment history)' },
    { key: 'creditLimit', label: 'Limit', fmt: 'amt', hint: 'Credit limit set on the customer in SAP (0 = none)' },
    { key: 'utilisation', label: 'Utilised', fmt: 'pct', hint: 'Exposure ÷ credit limit; blank when no limit is set' },
    { key: 'openOrders', label: 'Open SO', fmt: 'amt', hint: 'Value still to deliver on open sales orders' },
    { key: 'mainDriver', label: 'Main driver', hint: 'Score component contributing the most points' },
    { key: 'flags', label: 'Flags', wrap: true, hint: 'Warnings: no limit, over limit, orders open while 60+ days overdue, no payment history, frozen, worsened 10+' },
    { key: 'recommendation', label: 'Recommendation', wrap: true, hint: 'Credit policy action for this grade' },
  ];

  return {
    kpis: kpiTiles({ rows, byGrade, totalExp, highRisk, highExp, worse, noLimit, ordersAtRisk, partsOf, hasPrev: prev.size > 0, asOf }),
    chart: { title: 'Exposure by risk grade', type: 'bar', labels: byGrade.map(g => `${g.grade} · ${g.band}`),
      desc: 'Total exposure and overdue amount per risk grade; tall bars at D/E mean much of the book sits with risky customers.',
      series: [{ name: 'Exposure', values: byGrade.map(g => g.exposure) }, { name: 'Overdue', values: byGrade.map(g => g.overdue), color: '#BB0000' }] },
    tabs: [
      { key: 'register', label: `Risk register (${rows.length})`, rows, columns: cols,
        desc: 'Every active customer sorted by risk score; review D/E customers for credit hold and open the score for its breakdown.' },
      { key: 'watch', label: `Watchlist (${watch.length})`, rows: watch, columns: cols,
        desc: 'D/E customers plus anyone who worsened since the last run, ranked by risk-weighted exposure — start collections and credit reviews here.' },
      { key: 'limits', label: 'Limit review', rows: rows.filter(r => r.suggestedLimit !== r.creditLimit),
        desc: 'Customers whose SAP credit limit differs from the suggested limit; use it to update limits in the business partner master.',
        columns: [
          { key: 'grade', label: 'Grade', fmt: 'badge', hint: 'Risk grade A (low) to E (severe)' },
          { key: 'cardName', label: 'Customer', sub: 'cardCode', hint: 'Customer name and SAP business partner code' },
          { key: 'sales12m', label: 'Sales 12m', fmt: 'amt', hint: 'Invoiced sales net of credit memos in the last 12 months' },
          { key: 'terms', label: 'Terms', hint: 'Payment terms assigned to the customer in SAP' },
          { key: 'exposure', label: 'Exposure', fmt: 'amt', hint: 'Open invoices + open sales orders + delivered-not-invoiced balance' },
          { key: 'creditLimit', label: 'Current limit', fmt: 'amt', hint: 'Credit limit currently set in SAP (0 = none)' },
          { key: 'suggestedLimit', label: 'Suggested limit', fmt: 'amt', hint: 'Avg monthly sales × (terms days ÷ 30 + 1) × grade factor (A 1.5, B 1.2, C 1.0, D 0.5, E 0), rounded to 1,000' },
          { key: 'limitChange', label: 'Change', fmt: 'amt', hint: 'Suggested limit − current limit (negative = reduce)' },
          { key: 'recommendation', label: 'Recommendation', wrap: true, hint: 'Credit policy action for this grade' },
        ] },
      { key: 'grades', label: 'Grade summary', rows: byGrade,
        desc: 'Customer count, exposure and overdue per grade with the credit policy that applies to each grade.',
        columns: [
          { key: 'grade', label: 'Grade', fmt: 'badge', hint: 'Risk grade A (low) to E (severe)' },
          { key: 'band', label: 'Band', hint: 'Plain-language name of the risk band' },
          { key: 'customers', label: 'Customers', fmt: 'int', hint: 'Number of active customers in this grade' },
          { key: 'exposure', label: 'Exposure', fmt: 'amt', hint: 'Σ exposure (open invoices + open SO + deliveries) of these customers' },
          { key: 'overdue', label: 'Overdue', fmt: 'amt', hint: 'Σ past-due invoice balance of these customers' },
          { key: 'recommendation', label: 'Policy', wrap: true, hint: 'Standard credit action for customers in this grade' },
        ] },
    ],
    notes: [
      'Score weights: overdue share 25, age of oldest overdue 20, historical days-late 20, limit utilisation (or exposure ÷ average monthly sales when no limit) 20, open orders while overdue 15.',
      'Exposure = open A/R invoices + open sales-order value + open deliveries. Suggested limit = average monthly sales × (terms months + 1) × grade factor (A 1.5 … E 0), rounded to 1,000.',
      prev.size ? 'Trend compares with the most recent earlier snapshot.' : 'First run for this company — trends will appear from the next run on a later date.',
    ],
    insight, aiContext,
  };
}

// ── KPI tiles with drill-through detail ──────────────────────────────────────
// Each tile carries `detail` for the popup: how it is calculated (formula,
// steps, SAP sources), a data summary (stats + chart + top contributors) and a
// rule-based insight that the /kpi-insight AI route replaces when AI is on.
const SRC = {
  ocrd: 'OCRD — customer master (CardType C): credit limit, open deliveries balance, payment terms group',
  oinv: 'OINV — open A/R invoices (DocStatus O, not cancelled): DocTotal − PaidToDate = balance, DocDueDate',
  ordr: 'ORDR + RDR1 — open sales orders: Σ line OpenSum',
  hist: 'ORCT + RCT2 + OINV — invoices closed by incoming payments in the last 12 months (days late = pay date − due date)',
  sales: 'OINV − ORIN — invoiced sales net of credit memos, last 12 months',
  octg: 'OCTG — payment terms (days) used for the suggested limit',
  snap: 'Local snapshot store — previous run’s score per customer',
};
const PART_LABEL = { overdue: 'Overdue share', age: 'Age of oldest overdue', history: 'Historical days late', utilisation: 'Limit utilisation / exposure', orders: 'New orders while overdue' };
const PART_MAX = { overdue: 25, age: 20, history: 20, utilisation: 20, orders: 15 };

function kpiTiles({ rows, byGrade, totalExp, highRisk, highExp, worse, noLimit, ordersAtRisk, partsOf, hasPrev, asOf }) {
  const sum = (list, f) => list.reduce((s, r) => s + (typeof f === 'function' ? f(r) : r[f] || 0), 0);
  const top = (list, by, n = 15) => [...list].sort((a, z) => (z[by] ?? 0) - (a[by] ?? 0)).slice(0, n);
  const pct = (a, b) => (b ? round((a / b) * 100, 1) : 0);
  const C = {
    cust: { key: 'cardName', label: 'Customer', sub: 'cardCode' }, grade: { key: 'grade', label: 'Grade', fmt: 'badge' },
    score: { key: 'score', label: 'Score', fmt: 'score', invert: true }, exposure: { key: 'exposure', label: 'Exposure', fmt: 'amt' },
    overdue: { key: 'overdue', label: 'Overdue', fmt: 'amt' }, days: { key: 'maxDaysOverdue', label: 'Oldest (d)', fmt: 'int' },
    so: { key: 'openOrders', label: 'Open SO', fmt: 'amt' }, driver: { key: 'mainDriver', label: 'Main driver' },
    share: { key: 'share', label: '% of total', fmt: 'pct' },
  };
  const gradeChart = (title, field, fmtName) => ({ title, type: 'bar', fmt: field === 'customers' ? 'int' : undefined, labels: byGrade.map(g => g.grade),
    series: [{ name: fmtName, values: byGrade.map(g => g[field]) }] });
  const withShare = (list, total) => list.map(r => ({ ...r, share: pct(r.exposure, total) }));

  const outstanding = sum(rows, 'outstanding'), openSO = sum(rows, 'openOrders');
  const deliveries = totalExp - outstanding - openSO;
  const overdueAll = sum(rows, 'overdue');
  const top10Exp = sum(top(rows, 'exposure', 10), 'exposure');
  const avg = rows.length ? sum(rows, 'score') / rows.length : 0;
  const scores = rows.map(r => r.score).sort((a, z) => a - z);
  const median = scores.length ? (scores.length % 2 ? scores[(scores.length - 1) / 2] : (scores[scores.length / 2 - 1] + scores[scores.length / 2]) / 2) : 0;
  const wAvg = totalExp ? sum(rows, r => r.score * r.exposure) / totalExp : 0;
  const better = rows.filter(r => r.trend === 'BETTER'), stable = rows.filter(r => r.trend === 'STABLE'), fresh = rows.filter(r => r.trend === 'NEW');
  const soDE = sum(ordersAtRisk, 'openOrders');
  const partAvg = Object.keys(PART_MAX).map(k => {
    const v = rows.length ? [...partsOf.values()].reduce((s, p) => s + p[k], 0) / rows.length : 0;
    return { component: PART_LABEL[k], max: PART_MAX[k], avgPoints: round(v, 1), share: avg ? round((v / avg) * 100, 1) : 0 };
  });
  const topPart = [...partAvg].sort((a, z) => z.avgPoints - a.avgPoints)[0];
  const t1 = top(rows, 'exposure', 1)[0];
  const de1 = top(highRisk, 'exposure', 1)[0];

  return [
    { label: 'Active customers', value: rows.length, fmt: 'int', hint: 'Customers with exposure or 12-month sales',
      detail: {
        formula: 'Count of customers (OCRD CardType = C) with exposure > 0 OR invoiced sales in the last 12 months > 0.',
        steps: ['Load every open A/R invoice, open sales order and the open deliveries balance per customer.', 'Add customers that had net sales in the last 365 days even if nothing is open today.', 'Drop customers not found in the customer master or with neither exposure nor sales.'],
        sources: [SRC.ocrd, SRC.oinv, SRC.ordr, SRC.sales],
        stats: [
          { label: 'With open exposure', value: rows.filter(r => r.exposure > 0).length, fmt: 'int' },
          { label: 'Sales only (nothing open)', value: rows.filter(r => r.exposure <= 0).length, fmt: 'int' },
          { label: 'With overdue invoices', value: rows.filter(r => r.overdue > 0).length, fmt: 'int' },
          { label: 'With open sales orders', value: rows.filter(r => r.openOrders > 0).length, fmt: 'int' },
        ],
        chart: gradeChart('Customers by risk grade', 'customers', 'Customers'),
        table: { title: 'Largest customers by exposure', columns: [C.cust, C.grade, C.exposure, C.share, C.overdue, C.score], rows: withShare(top(rows, 'exposure'), totalExp) },
        insight: `**${rows.length} active customers; ${rows.filter(r => r.overdue > 0).length} have overdue invoices.**\n\n- Grade mix: ${byGrade.map(g => `${g.grade} ${g.customers}`).join(', ')}.\n- ${highRisk.length} (${pct(highRisk.length, rows.length)}%) are D/E.`,
      } },
    { label: 'Total exposure', value: totalExp, fmt: 'amt', hint: 'Open invoices + open SO + deliveries',
      detail: {
        formula: 'Σ per customer of (open A/R invoice balance + open sales-order value + open deliveries balance).',
        steps: ['Invoice balance = DocTotal − PaidToDate for every open, non-cancelled A/R invoice.', 'Open sales-order value = Σ RDR1.OpenSum on open orders.', 'Deliveries = OCRD.DNotesBal (delivered, not yet invoiced).', 'Summed per customer, then across all active customers.'],
        sources: [SRC.oinv, SRC.ordr, SRC.ocrd],
        stats: [
          { label: 'Open A/R invoices', value: outstanding, fmt: 'amt' }, { label: 'Open sales orders', value: openSO, fmt: 'amt' },
          { label: 'Open deliveries', value: deliveries, fmt: 'amt' }, { label: 'Overdue (in invoices)', value: overdueAll, fmt: 'amt' },
          { label: 'Overdue % of invoices', value: pct(overdueAll, outstanding), fmt: 'pct' }, { label: 'Top-10 concentration', value: pct(top10Exp, totalExp), fmt: 'pct' },
        ],
        chart: { title: 'Exposure composition by grade', type: 'bar', stacked: true, labels: byGrade.map(g => g.grade),
          series: [{ name: 'Overdue', values: byGrade.map(g => g.overdue), color: '#DC2626' }, { name: 'Not overdue', values: byGrade.map(g => round(g.exposure - g.overdue)) }] },
        table: { title: 'Top contributors', columns: [C.cust, C.grade, C.exposure, C.share, C.overdue, C.so], rows: withShare(top(rows, 'exposure'), totalExp) },
        insight: `**Total exposure ${fmtAmt(totalExp)}: ${pct(outstanding, totalExp)}% invoices, ${pct(openSO, totalExp)}% open orders, ${pct(deliveries, totalExp)}% deliveries.**\n\n- Top 10 customers hold ${pct(top10Exp, totalExp)}% of exposure${t1 ? `; largest is **${t1.cardName}** at ${fmtAmt(t1.exposure)}` : ''}.\n- ${pct(overdueAll, outstanding)}% of invoice balance is already overdue (${fmtAmt(overdueAll)}).`,
      } },
    { label: 'High/severe (D/E)', value: highRisk.length, fmt: 'int', tone: highRisk.length ? 'bad' : 'good', hint: 'Score ≥ 60',
      detail: {
        formula: 'Count of customers whose risk score is ≥ 60 (grade D: 60–79, grade E: 80–100).',
        steps: ['Score = overdue share (25) + age of oldest overdue (20) + historical days late (20) + limit utilisation (20) + new orders while overdue (15).', 'Graded A < 20, B < 40, C < 60, D < 80, E ≥ 80.'],
        sources: [SRC.oinv, SRC.ordr, SRC.hist, SRC.ocrd],
        stats: [
          { label: 'Grade D', value: highRisk.filter(r => r.grade === 'D').length, fmt: 'int' }, { label: 'Grade E', value: highRisk.filter(r => r.grade === 'E').length, fmt: 'int' },
          { label: '% of customers', value: pct(highRisk.length, rows.length), fmt: 'pct' }, { label: 'Their overdue', value: sum(highRisk, 'overdue'), fmt: 'amt' },
          { label: 'Avg score (D/E)', value: highRisk.length ? sum(highRisk, 'score') / highRisk.length : 0, fmt: 'int' },
        ],
        chart: gradeChart('Customers by grade', 'customers', 'Customers'),
        table: { title: 'D/E customers by score', columns: [C.cust, C.grade, C.score, C.overdue, C.days, C.driver], rows: top(highRisk, 'score', 25) },
        insight: `**${highRisk.length} customers are D/E.**\n\n` + Object.entries(highRisk.reduce((m, r) => (m[r.mainDriver] = (m[r.mainDriver] || 0) + 1, m), {})).sort((a, z) => z[1] - a[1]).map(([k, v]) => `- ${v} driven mainly by *${k}*`).join('\n'),
      } },
    { label: 'D/E exposure', value: highExp, fmt: 'amt', tone: highExp ? 'bad' : 'good', hint: 'Exposure held by D/E customers',
      detail: {
        formula: 'Σ exposure (open invoices + open SO + deliveries) of customers graded D or E.',
        steps: ['Take the D/E customers from the risk register.', 'Sum their exposure; risk-weighted = exposure × score ÷ 100.'],
        sources: [SRC.oinv, SRC.ordr, SRC.ocrd],
        stats: [
          { label: '% of total exposure', value: pct(highExp, totalExp), fmt: 'pct' }, { label: 'Of which overdue', value: sum(highRisk, 'overdue'), fmt: 'amt' },
          { label: 'Of which open SO', value: sum(highRisk, 'openOrders'), fmt: 'amt' }, { label: 'Risk-weighted', value: sum(highRisk, 'atRisk'), fmt: 'amt' },
        ],
        chart: { title: 'Largest D/E exposures', type: 'bar', horizontal: true, labels: top(highRisk, 'exposure', 10).map(r => r.cardName),
          series: [{ name: 'Exposure', values: top(highRisk, 'exposure', 10).map(r => r.exposure) }, { name: 'Overdue', values: top(highRisk, 'exposure', 10).map(r => r.overdue), color: '#DC2626' }] },
        table: { title: 'D/E customers by exposure', columns: [C.cust, C.grade, C.exposure, C.share, C.overdue, { key: 'atRisk', label: 'Risk-weighted', fmt: 'amt' }], rows: withShare(top(highRisk, 'exposure', 25), totalExp) },
        insight: `**${fmtAmt(highExp)} (${pct(highExp, totalExp)}%) of exposure sits with D/E customers.**\n\n` + (de1 ? `- Largest: **${de1.cardName}** — ${fmtAmt(de1.exposure)}, ${fmtAmt(de1.overdue)} overdue, oldest ${de1.maxDaysOverdue}d.\n` : '') + `- ${fmtAmt(sum(highRisk, 'openOrders'))} of it is open sales orders that can still be held.`,
      } },
    { label: 'Worsened', value: worse.length, fmt: 'int', tone: worse.length ? 'warn' : 'good', hint: 'Score up 5+ points since the previous run',
      detail: {
        formula: 'Count of customers where (today’s score − score in the most recent earlier snapshot) ≥ 5.',
        steps: ['Every run saves each customer’s score by date.', 'Δ ≥ +5 → WORSE, Δ ≤ −5 → BETTER, otherwise STABLE; no earlier snapshot → NEW.'],
        sources: [SRC.snap, SRC.oinv, SRC.hist],
        stats: [
          { label: 'Worse', value: worse.length, fmt: 'int' }, { label: 'Better', value: better.length, fmt: 'int' },
          { label: 'Stable', value: stable.length, fmt: 'int' }, { label: 'New (no history)', value: fresh.length, fmt: 'int' },
        ],
        chart: { title: 'Trend since previous run', type: 'bar', fmt: 'int', labels: ['Worse', 'Stable', 'Better', 'New'],
          series: [{ name: 'Customers', values: [worse.length, stable.length, better.length, fresh.length] }] },
        table: { title: 'Largest deteriorations', columns: [C.cust, { key: 'prevGrade', label: 'Was' }, C.grade, { key: 'delta', label: 'Δ score', fmt: 'int' }, C.overdue, C.driver], rows: top(worse, 'delta', 25) },
        insight: hasPrev ? `**${worse.length} worsened, ${better.length} improved since the last snapshot.**${worse[0] ? `\n\n- Biggest move: **${top(worse, 'delta', 1)[0].cardName}** +${top(worse, 'delta', 1)[0].delta} (driver: ${top(worse, 'delta', 1)[0].mainDriver}).` : ''}` : `**First run for this company (${asOf}) — trends start from the next run on a later date.**`,
      } },
    { label: 'Open SO at D/E', value: soDE, fmt: 'amt', tone: ordersAtRisk.length ? 'bad' : 'good', hint: 'Open orders for D/E customers',
      detail: {
        formula: 'Σ open sales-order value (RDR1.OpenSum) for customers graded D or E.',
        steps: ['Open, non-cancelled sales orders grouped by customer.', 'Kept only where the customer is D/E — these are the orders a credit hold would stop.'],
        sources: [SRC.ordr, SRC.oinv],
        stats: [
          { label: 'Customers', value: ordersAtRisk.length, fmt: 'int' }, { label: 'Open SO (all customers)', value: openSO, fmt: 'amt' },
          { label: '% of all open SO', value: pct(soDE, openSO), fmt: 'pct' }, { label: 'Their overdue', value: sum(ordersAtRisk, 'overdue'), fmt: 'amt' },
        ],
        chart: { title: 'Open SO vs overdue (D/E)', type: 'bar', horizontal: true, labels: top(ordersAtRisk, 'openOrders', 10).map(r => r.cardName),
          series: [{ name: 'Open SO', values: top(ordersAtRisk, 'openOrders', 10).map(r => r.openOrders) }, { name: 'Overdue', values: top(ordersAtRisk, 'openOrders', 10).map(r => r.overdue), color: '#DC2626' }] },
        table: { title: 'Orders to review before delivery', columns: [C.cust, C.grade, C.so, C.overdue, C.days, { key: 'recommendation', label: 'Action', wrap: true }], rows: top(ordersAtRisk, 'openOrders', 25) },
        insight: `**${fmtAmt(soDE)} of open orders (${pct(soDE, openSO)}%) belong to ${ordersAtRisk.length} D/E customers.**\n\n- Hold or require prepayment before delivering these orders.`,
      } },
    { label: 'No credit limit', value: noLimit.length, fmt: 'int', tone: noLimit.length ? 'warn' : 'good', hint: 'Credit limit = 0 in SAP',
      detail: {
        formula: 'Count of active customers whose OCRD.CreditLine is 0 / blank.',
        steps: ['Without a limit SAP cannot block orders, so utilisation is replaced by months of exposure (exposure ÷ avg monthly sales).', 'Suggested limit = avg monthly sales × (terms days ÷ 30 + 1) × grade factor (A 1.5, B 1.2, C 1.0, D 0.5, E 0), rounded to 1,000.'],
        sources: [SRC.ocrd, SRC.sales, SRC.octg],
        stats: [
          { label: '% of customers', value: pct(noLimit.length, rows.length), fmt: 'pct' }, { label: 'Their exposure', value: sum(noLimit, 'exposure'), fmt: 'amt' },
          { label: 'Of which D/E', value: noLimit.filter(r => r.grade === 'D' || r.grade === 'E').length, fmt: 'int' }, { label: 'Σ suggested limits', value: sum(noLimit, 'suggestedLimit'), fmt: 'amt' },
        ],
        chart: { title: 'Customers without a limit, by grade', type: 'bar', fmt: 'int', labels: byGrade.map(g => g.grade), series: [{ name: 'Customers', values: byGrade.map(g => noLimit.filter(r => r.grade === g.grade).length) }] },
        table: { title: 'Largest exposures without a limit', columns: [C.cust, C.grade, C.exposure, { key: 'sales12m', label: 'Sales 12m', fmt: 'amt' }, { key: 'terms', label: 'Terms' }, { key: 'suggestedLimit', label: 'Suggested', fmt: 'amt' }], rows: top(noLimit, 'exposure', 25) },
        insight: `**${noLimit.length} customers carry ${fmtAmt(sum(noLimit, 'exposure'))} of exposure with no limit in SAP.**\n\n- Set the suggested limits (Limit review tab) so SAP can enforce credit checks.`,
      } },
    { label: 'Avg risk score', value: avg, fmt: 'int', hint: '0 = safe, 100 = severe',
      detail: {
        formula: 'Σ customer risk score ÷ number of active customers. Each score is 0–100 from five weighted components.',
        steps: ['Overdue share (25) = overdue ÷ outstanding × 25.', 'Age (20) = min(1, oldest days overdue ÷ 120) × 20.', 'History (20) = avg days late ÷ 60 × 20 (10 if exposed with no history).', 'Utilisation (20) = (exposure ÷ limit − 0.5) ÷ 0.5 × 20; no limit → (months of exposure − 1) ÷ 2 × 20.', 'Orders (15) = min(1, overdue share × 2) × 15 when open orders exist.'],
        sources: [SRC.oinv, SRC.ordr, SRC.hist, SRC.ocrd, SRC.sales],
        stats: [
          { label: 'Median score', value: median, fmt: 'int' }, { label: 'Exposure-weighted avg', value: wAvg, fmt: 'int' },
          { label: 'Lowest', value: scores[0] ?? 0, fmt: 'int' }, { label: 'Highest', value: scores[scores.length - 1] ?? 0, fmt: 'int' },
        ],
        chart: { title: 'Average points by component', type: 'bar', fmt: 'num', horizontal: true, labels: partAvg.map(p => p.component),
          series: [{ name: 'Avg points', values: partAvg.map(p => p.avgPoints) }, { name: 'Max', values: partAvg.map(p => p.max), color: '#94A3B8' }] },
        table: { title: 'Score decomposition', columns: [{ key: 'component', label: 'Component' }, { key: 'max', label: 'Max pts', fmt: 'int' }, { key: 'avgPoints', label: 'Avg pts', fmt: 'num' }, { key: 'share', label: '% of avg score', fmt: 'pct' }], rows: partAvg },
        insight: `**Average score ${Math.round(avg)} (median ${Math.round(median)}); exposure-weighted ${Math.round(wAvg)}.**\n\n- Biggest contributor: *${topPart?.component}* (${topPart?.avgPoints} of ${topPart?.max} pts on average).\n- ${wAvg > avg ? 'Larger accounts are riskier than the average customer.' : 'Larger accounts are safer than the average customer.'}`,
      } },
  ];
}

export function createCreditRiskAgentRouter(deps) {
  return createInsightRouter(deps, {
    slug: 'creditrisk', title: 'Credit Risk Agent',
    persona: 'You are a credit risk analyst for a B2B company using SAP Business One.',
    aiTask: 'Review this customer credit risk register. Explain the biggest risks and why, which customers need credit holds or limit changes, and where open orders are exposed.',
    run,
  });
}
