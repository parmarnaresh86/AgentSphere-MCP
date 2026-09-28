/**
 * Month-End Closing Agent — mounted at /api/month-end-agent
 *
 * Runs a close checklist for the period ending on the chosen date and lists
 * every document blocking a clean close:
 *   goods receipts (GRPO) not yet A/P invoiced   → accrue (GRNI)
 *   deliveries not yet A/R invoiced              → unbilled revenue
 *   open sales / purchase returns                → credit memo pending
 *   open A/R and A/P credit memos                → unapplied credits
 *   incoming / outgoing payments on account      → unapplied cash
 *   BPs with open invoices AND open credits/cash → internal reconciliation
 *   documents dated in the period but created after it → back-dated postings
 *   open drafts dated in the period, negative stock, posting-period status
 * Optional checks are skipped (shown as N/A) when their table/column is absent.
 */
import { createInsightRouter, ctxTable, isoDate, daysBetween, num, round, fmtAmt } from '../lib/insight-kit.mjs';

const SEVERITY_RANK = { CRITICAL: 3, ATTENTION: 2, INFO: 1, OK: 0, 'N/A': -1 };

async function openDocs(k, table, end, { balance = false } = {}) {
  const need = ['DocEntry', 'DocNum', 'CardCode', 'CardName', 'DocDate', 'DocTotal', 'DocStatus', 'CANCELED'];
  for (const c of need) if (!(await k.has(table, c))) return null;
  const paid = balance && (await k.has(table, 'PaidToDate'));
  const rows = await k.run(`SELECT {DocEntry}, {DocNum}, {CardCode}, {CardName}, {DocDate}, {DocTotal}${paid ? ', {PaidToDate}' : ''}
    FROM @${table} WHERE {DocStatus} = 'O' AND {CANCELED} = 'N' AND {DocDate} <= ${k.lit(end)}`);
  return rows.map(r => ({ docEntry: r.DocEntry, docNum: r.DocNum, cardCode: r.CardCode, cardName: r.CardName || '', date: isoDate(r.DocDate),
    value: num(r.DocTotal) - (paid ? num(r.PaidToDate) : 0) }));
}

async function onAccount(k, table, end) {
  for (const c of ['DocNum', 'CardCode', 'CardName', 'DocDate', 'OpenBal', 'Canceled']) if (!(await k.has(table, c))) return null;
  const rows = await k.run(`SELECT {DocNum}, {CardCode}, {CardName}, {DocDate}, {OpenBal} FROM @${table}
    WHERE {Canceled} = 'N' AND {OpenBal} > 0 AND {DocDate} <= ${k.lit(end)}`);
  return rows.map(r => ({ docNum: r.DocNum, cardCode: r.CardCode, cardName: r.CardName || '', date: isoDate(r.DocDate), value: num(r.OpenBal) }));
}

async function backdated(k, table, label, end, dateCol = 'DocDate', numCol = 'DocNum', valueCol = 'DocTotal') {
  for (const c of [dateCol, numCol, 'CreateDate']) if (!(await k.has(table, c))) return [];
  const hasCard = await k.has(table, 'CardCode'), hasVal = await k.has(table, valueCol);
  const rows = await k.run(`SELECT {${numCol}} AS {DocNum}, {${dateCol}} AS {DocDate}, {CreateDate}${hasCard ? ', {CardCode}, {CardName}' : ''}${hasVal ? `, {${valueCol}} AS {Val}` : ''}
    FROM @${table} WHERE {${dateCol}} <= ${k.lit(end)} AND {CreateDate} > ${k.lit(end)}`);
  return rows.map(r => ({ docType: label, docNum: r.DocNum, date: isoDate(r.DocDate), created: isoDate(r.CreateDate),
    cardCode: r.CardCode || '', cardName: r.CardName || '', value: num(r.Val), detail: `Dated ${isoDate(r.DocDate)} but created ${isoDate(r.CreateDate)}` }));
}

async function run(k, p) {
  const end = p.asOf;
  const start = `${end.slice(0, 7)}-01`;
  const today = new Date().toISOString().slice(0, 10);
  const checks = [];
  const rowsByCheck = {};
  const add = (key, step, label, rows, { severity = 'ATTENTION', critical, action, unit = 'value' } = {}) => {
    if (rows === null) { checks.push({ key, step, check: label, status: 'N/A', items: null, value: null, action: 'Not available on this database' }); return; }
    const withAge = rows.map(r => ({ ...r, age: r.date ? daysBetween(r.date, end) : null }));
    rowsByCheck[key] = withAge.sort((a, z) => (z.age ?? 0) - (a.age ?? 0));
    const value = rows.reduce((s, r) => s + num(r.value), 0);
    const isCritical = critical ? critical(withAge, value) : false;
    checks.push({ key, step, check: label, status: rows.length ? (isCritical ? 'CRITICAL' : severity) : 'OK', items: rows.length,
      value: unit === 'value' ? round(value) : null, oldest: withAge.length ? Math.max(...withAge.map(r => r.age ?? 0)) : null, action: rows.length ? action : 'Nothing pending' });
  };
  const olderThanPeriod = rows => rows.some(r => r.date && r.date < start);

  // 1-2 Goods received / delivered but not invoiced
  const grpo = await openDocs(k, 'OPDN', end);
  add('grpo', 1, 'Goods receipts (GRPO) not A/P invoiced', grpo?.map(r => ({ ...r, docType: 'GRPO', detail: 'Received, not invoiced — accrue GRNI' })) ?? null,
    { critical: olderThanPeriod, action: 'Post the A/P invoices or book a GRNI accrual; chase vendors for missing invoices' });
  const dln = await openDocs(k, 'ODLN', end);
  add('delivery', 2, 'Deliveries not A/R invoiced', dln?.map(r => ({ ...r, docType: 'Delivery', detail: 'Delivered, not billed — unbilled revenue' })) ?? null,
    { critical: olderThanPeriod, action: 'Raise the A/R invoices before closing, or accrue unbilled revenue' });

  // 3-4 Returns awaiting credit memos
  const rdn = await openDocs(k, 'ORDN', end);
  add('salesReturn', 3, 'Sales returns without A/R credit memo', rdn?.map(r => ({ ...r, docType: 'Return', detail: 'Goods back, customer not credited' })) ?? null,
    { action: 'Issue the A/R credit memos (or close the returns) so revenue and stock agree' });
  const rpd = await openDocs(k, 'ORPD', end);
  add('purchaseReturn', 4, 'Goods returns without A/P credit memo', rpd?.map(r => ({ ...r, docType: 'Goods return', detail: 'Goods sent back, vendor credit not booked' })) ?? null,
    { action: 'Obtain and post the vendor credit notes' });

  // 5-6 Unapplied credit memos
  const rin = await openDocs(k, 'ORIN', end, { balance: true });
  add('arCredit', 5, 'Open A/R credit memos (unapplied)', rin?.filter(r => r.value > 0.005).map(r => ({ ...r, docType: 'A/R credit memo', detail: 'Credit not applied to an invoice or refunded' })) ?? null,
    { severity: 'ATTENTION', action: 'Apply against open invoices via internal reconciliation, or refund' });
  const rpc = await openDocs(k, 'ORPC', end, { balance: true });
  add('apCredit', 6, 'Open A/P credit memos (unapplied)', rpc?.filter(r => r.value > 0.005).map(r => ({ ...r, docType: 'A/P credit memo', detail: 'Vendor credit not offset' })) ?? null,
    { action: 'Offset against open A/P invoices in the next payment run' });

  // 7-8 Payments on account
  const rct = await onAccount(k, 'ORCT', end);
  add('receipts', 7, 'Incoming payments on account (unapplied)', rct?.map(r => ({ ...r, docType: 'Incoming payment', detail: 'Cash received, not matched to invoices' })) ?? null,
    { critical: rows => rows.some(r => r.age > 30), action: 'Match receipts to invoices (internal reconciliation); identify unknown remitters' });
  const vpm = await onAccount(k, 'OVPM', end);
  add('payments', 8, 'Outgoing payments on account (unapplied)', vpm?.map(r => ({ ...r, docType: 'Outgoing payment', detail: 'Paid, not matched to vendor invoices' })) ?? null,
    { action: 'Match to A/P invoices or reclassify as advances' });

  // 9-10 Reconciliation candidates: BP has open invoices AND open credits/cash
  const openAr = await openDocs(k, 'OINV', end, { balance: true });
  const openAp = await openDocs(k, 'OPCH', end, { balance: true });
  const reco = (invoices, credits, side) => {
    if (!invoices || credits.every(c => c === null)) return null;
    const inv = new Map();
    for (const r of invoices) if (r.value > 0.005) inv.set(r.cardCode, { cardName: r.cardName, open: (inv.get(r.cardCode)?.open || 0) + r.value, n: (inv.get(r.cardCode)?.n || 0) + 1 });
    const cr = new Map();
    for (const list of credits) for (const r of list || []) cr.set(r.cardCode, (cr.get(r.cardCode) || 0) + r.value);
    return [...cr].filter(([card]) => inv.has(card)).map(([card, credit]) => ({
      docType: side, docNum: '', cardCode: card, cardName: inv.get(card).cardName, date: null,
      value: round(Math.min(credit, inv.get(card).open)), detail: `${inv.get(card).n} open invoice(s) ${fmtAmt(inv.get(card).open)} vs ${fmtAmt(credit)} unapplied credit/cash`,
    })).sort((a, z) => z.value - a.value);
  };
  add('arReco', 9, 'Customers to reconcile (open invoices + unapplied credit)', reco(openAr, [rin?.filter(r => r.value > 0), rct], 'Customer'),
    { action: 'Run internal reconciliation (Banking → Reconciliation) to offset' });
  add('apReco', 10, 'Vendors to reconcile (open invoices + unapplied credit)', reco(openAp, [rpc?.filter(r => r.value > 0), vpm], 'Vendor'),
    { action: 'Offset vendor credits and advances against open invoices' });

  // 11 Back-dated postings (only meaningful once the period has passed)
  let bd = [];
  if (today > end) {
    for (const [t, label] of [['OINV', 'A/R invoice'], ['OPCH', 'A/P invoice'], ['ORIN', 'A/R credit memo'], ['ORPC', 'A/P credit memo'],
      ['ODLN', 'Delivery'], ['OPDN', 'GRPO'], ['ORCT', 'Incoming payment'], ['OVPM', 'Outgoing payment']]) bd.push(...await backdated(k, t, label, end));
    bd.push(...await backdated(k, 'OJDT', 'Journal entry', end, 'RefDate', 'Number', 'LocTotal'));
    bd = bd.filter(r => r.date >= start);
  }
  add('backdated', 11, 'Back-dated postings into the period', today > end ? bd : null,
    { severity: 'CRITICAL', action: 'Review with the posting user; lock the posting period once the close is signed off' });
  if (today <= end) checks[checks.length - 1] = { ...checks[checks.length - 1], status: 'INFO', action: 'Period still open — checked after period end' };

  // 12 Drafts dated in the period
  let drafts = null;
  if ((await Promise.all(['DocStatus', 'ObjType', 'DocNum', 'DocDate', 'CardCode', 'CardName', 'DocTotal'].map(c => k.has('ODRF', c)))).every(Boolean)) {
    const OBJ = { 13: 'A/R invoice', 14: 'A/R credit memo', 15: 'Delivery', 17: 'Sales order', 18: 'A/P invoice', 19: 'A/P credit memo', 20: 'GRPO', 22: 'Purchase order', 23: 'Quotation', 24: 'Incoming payment', 46: 'Outgoing payment', 30: 'Journal entry' };
    const rows = await k.run(`SELECT {DocNum}, {ObjType}, {CardCode}, {CardName}, {DocDate}, {DocTotal} FROM @ODRF
      WHERE {DocStatus} = 'O' AND {DocDate} >= ${k.lit(start)} AND {DocDate} <= ${k.lit(end)}`);
    drafts = rows.filter(r => [13, 14, 15, 18, 19, 20, 24, 46, 30].includes(Number(r.ObjType)))
      .map(r => ({ docType: `Draft ${OBJ[Number(r.ObjType)] || r.ObjType}`, docNum: r.DocNum, cardCode: r.CardCode || '', cardName: r.CardName || '', date: isoDate(r.DocDate), value: num(r.DocTotal), detail: 'Draft never posted' }));
  }
  add('drafts', 12, 'Unposted drafts dated in the period', drafts, { severity: 'INFO', action: 'Post or delete the drafts so nothing is left out of the period' });

  // 13 Negative stock
  let neg = null;
  if (await k.has('OITW', 'OnHand')) {
    const rows = await k.run(`SELECT {ItemCode}, {WhsCode}, {OnHand} FROM @OITW WHERE {OnHand} < 0`);
    neg = rows.map(r => ({ docType: 'Stock', docNum: r.ItemCode, cardCode: r.WhsCode, cardName: `Warehouse ${r.WhsCode}`, date: null, value: num(r.OnHand), detail: `On hand ${num(r.OnHand)} — inventory valuation will be wrong` }));
  }
  add('negStock', 13, 'Items with negative stock', neg, { severity: 'CRITICAL', action: 'Post the missing receipts / correct the issues before valuing inventory', unit: 'qty' });

  // 14 Posting period status
  let period = null;
  for (const c of ['Code', 'F_RefDate', 'T_RefDate', 'PeriodStat']) if (!(await k.has('OFPR', c))) { period = 'n/a'; break; }
  if (period !== 'n/a') {
    const r = await k.run(`SELECT {Code}, {PeriodStat} FROM @OFPR WHERE {F_RefDate} <= ${k.lit(end)} AND {T_RefDate} >= ${k.lit(end)}`);
    period = r[0] ? { code: r[0].Code, stat: String(r[0].PeriodStat || '') } : null;
  }
  const statName = { N: 'Unlocked', Y: 'Locked', C: 'Closing period', U: 'Unlocked except sales' }[period?.stat] || period?.stat || '—';
  checks.push({ key: 'period', step: 14, check: 'Posting period status', status: period === 'n/a' || !period ? 'N/A' : period.stat === 'Y' ? 'OK' : today > end ? 'ATTENTION' : 'INFO',
    items: null, value: null, oldest: null, action: period && period !== 'n/a' ? `Period ${period.code}: ${statName}${period.stat !== 'Y' && today > end ? ' — lock it after sign-off to stop back-dated postings' : ''}` : 'Posting period table not available' });

  // ── Summaries ────────────────────────────────────────────────────────────
  const applicable = checks.filter(c => c.status !== 'N/A' && c.status !== 'INFO');
  const passed = applicable.filter(c => c.status === 'OK').length;
  const readiness = applicable.length ? (passed / applicable.length) * 100 : 100;
  const critical = checks.filter(c => c.status === 'CRITICAL');
  const val = key => checks.find(c => c.key === key)?.value || 0;
  const cnt = key => checks.find(c => c.key === key)?.items || 0;
  const issues = Object.entries(rowsByCheck).flatMap(([key, rows]) => rows.map(r => ({ ...r, check: checks.find(c => c.key === key).check, status: checks.find(c => c.key === key).status, value: round(r.value) })));
  issues.sort((a, z) => SEVERITY_RANK[z.status] - SEVERITY_RANK[a.status] || Math.abs(z.value) - Math.abs(a.value));

  const insight = `**Close readiness for period ending ${end}: ${Math.round(readiness)}% (${passed} of ${applicable.length} checks clear), ${critical.length} critical.**\n\n` +
    checks.filter(c => c.status === 'CRITICAL' || c.status === 'ATTENTION').sort((a, z) => SEVERITY_RANK[z.status] - SEVERITY_RANK[a.status] || (z.value || 0) - (a.value || 0)).slice(0, 7)
      .map(c => `- ${c.status === 'CRITICAL' ? '🔴' : '🟠'} **${c.check}**: ${c.items ?? ''} ${c.value != null ? `(${fmtAmt(c.value)})` : ''}${c.oldest ? `, oldest ${c.oldest}d` : ''} — ${c.action}.`).join('\n') +
    (critical.length || applicable.length !== passed ? '' : '- Every applicable check is clear. ') + '\n' +
    (val('grpo') ? `- GRNI accrual needed: **${fmtAmt(val('grpo'))}**; unbilled revenue: **${fmtAmt(val('delivery'))}**.\n` : '');

  const aiContext = `MONTH-END CLOSE for period ${start} to ${end} (today ${today}). Readiness ${Math.round(readiness)}%, critical ${critical.length}.
CHECKLIST:
${ctxTable(checks, [['step', '#'], ['check', 'Check'], ['status', 'Status'], ['items', 'Items'], ['value', 'Value'], ['oldest', 'OldestDays'], ['action', 'Action']], 20)}
TOP ISSUES:
${ctxTable(issues, [['check', 'Check'], ['docType', 'Type'], ['docNum', 'Doc'], ['cardName', 'BP'], ['date', 'Date'], ['age', 'Age'], ['value', 'Value']], 30)}`;

  const issueCols = [{ key: 'docType', label: 'Type', fmt: 'badge' }, { key: 'docNum', label: 'Doc #' }, { key: 'date', label: 'Date', fmt: 'date' },
    { key: 'age', label: 'Age (d)', fmt: 'int' }, { key: 'cardName', label: 'Business partner', sub: 'cardCode' },
    { key: 'value', label: 'Value', fmt: 'amt', strong: true }, { key: 'detail', label: 'Detail', wrap: true }];
  const statusBadge = { OK: 'green', ATTENTION: 'amber', CRITICAL: 'red', INFO: 'blue', 'N/A': 'grey' };
  const tabFor = (key, label) => ({ key, label: `${label} (${rowsByCheck[key]?.length ?? 0})`, rows: rowsByCheck[key] || [],
    columns: key === 'backdated' ? [...issueCols.slice(0, 3), { key: 'created', label: 'Created', fmt: 'date' }, ...issueCols.slice(4)] : issueCols });

  return {
    kpis: [
      { label: 'Close readiness', value: readiness, fmt: 'pct', tone: readiness >= 90 ? 'good' : readiness >= 60 ? 'warn' : 'bad' },
      { label: 'Critical checks', value: critical.length, fmt: 'int', tone: critical.length ? 'bad' : 'good' },
      { label: 'GRNI to accrue', value: val('grpo'), fmt: 'amt', tone: val('grpo') ? 'warn' : 'good', hint: `${cnt('grpo')} GRPOs not invoiced` },
      { label: 'Unbilled deliveries', value: val('delivery'), fmt: 'amt', tone: val('delivery') ? 'warn' : 'good', hint: `${cnt('delivery')} deliveries` },
      { label: 'Unapplied receipts', value: val('receipts'), fmt: 'amt', tone: val('receipts') ? 'warn' : 'good' },
      { label: 'Unapplied credit memos', value: val('arCredit') + val('apCredit'), fmt: 'amt' },
      { label: 'Back-dated postings', value: cnt('backdated'), fmt: 'int', tone: cnt('backdated') ? 'bad' : 'good' },
      { label: 'Negative stock lines', value: cnt('negStock'), fmt: 'int', tone: cnt('negStock') ? 'bad' : 'good' },
    ],
    chart: { title: 'Pending value by check', type: 'bar', labels: checks.filter(c => c.value).map(c => c.check.replace(/\s*\(.*\)/, '')),
      series: [{ name: 'Value', values: checks.filter(c => c.value).map(c => c.value), color: '#D97706' }] },
    tabs: [
      { key: 'checklist', label: 'Close checklist', rows: checks,
        columns: [{ key: 'step', label: '#', fmt: 'int' }, { key: 'status', label: 'Status', fmt: 'badge', badge: statusBadge }, { key: 'check', label: 'Check' },
          { key: 'items', label: 'Items', fmt: 'int' }, { key: 'value', label: 'Value', fmt: 'amt' }, { key: 'oldest', label: 'Oldest (d)', fmt: 'int' }, { key: 'action', label: 'Action', wrap: true }] },
      { key: 'issues', label: `All issues (${issues.length})`, rows: issues,
        columns: [{ key: 'status', label: 'Severity', fmt: 'badge', badge: statusBadge }, { key: 'check', label: 'Check', wrap: true }, ...issueCols] },
      tabFor('grpo', 'GRPO not invoiced'), tabFor('delivery', 'Unbilled deliveries'),
      tabFor('receipts', 'Unapplied receipts'), tabFor('arCredit', 'A/R credits'), tabFor('apCredit', 'A/P credits'),
      tabFor('arReco', 'Customer reconciliation'), tabFor('apReco', 'Vendor reconciliation'),
      tabFor('salesReturn', 'Sales returns'), tabFor('purchaseReturn', 'Goods returns'), tabFor('payments', 'Unapplied payments'),
      tabFor('backdated', 'Back-dated'), tabFor('drafts', 'Drafts'), tabFor('negStock', 'Negative stock'),
    ],
    notes: [
      `Period ${start} → ${end}. Open documents dated on or before the period end are listed; age = days from document date to period end. Checks marked CRITICAL: items older than this period (GRPO, deliveries), receipts unapplied > 30 days, back-dated postings, negative stock.`,
      'Readiness = checks clear ÷ applicable checks (N/A and informational checks excluded). Nothing is posted to SAP.',
    ],
    insight, aiContext,
  };
}

export function createMonthEndClosingAgentRouter(deps) {
  return createInsightRouter(deps, {
    slug: 'monthend', title: 'Month-End Closing Agent',
    persona: 'You are a financial controller running the month-end close in SAP Business One.',
    aiTask: 'Review this month-end close checklist. Prioritise what must be done before the books can close, estimate the accruals needed, and give a step-by-step close plan with owners (AR, AP, inventory, GL).',
    run,
  });
}
