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

// KPI drill-through (calc blocks → lib/insight-kit.mjs withKpiDetails) and per-check tab descriptions.
const SRC = {
  opdn: 'OPDN — goods receipts PO (GRPO): open = received but not yet A/P invoiced',
  odln: 'ODLN — deliveries: open = delivered but not yet A/R invoiced',
  ordn: 'ORDN — sales returns: open = not yet credited',
  orpd: 'ORPD — goods returns to vendors: open = vendor credit not yet booked',
  orin: 'ORIN — A/R credit memos: total − amount applied',
  orpc: 'ORPC — A/P credit memos: total − amount applied',
  orct: 'ORCT — incoming payments: open (on-account) balance',
  ovpm: 'OVPM — outgoing payments: open (on-account) balance',
  oinv: 'OINV — open A/R invoices: balance',
  opch: 'OPCH — open A/P invoices: balance',
  ojdt: 'OJDT + marketing documents — posting date vs creation date (back-dating)',
  odrf: 'ODRF — open draft documents',
  oitw: 'OITW — stock per warehouse: quantity in stock',
  ofpr: 'OFPR — posting periods: lock status',
};
// key → what the per-check tab shows, its SAP source, and what "Value" means there.
const CHECK_INFO = {
  grpo: { desc: 'Goods received from vendors with no A/P invoice yet — accrue their value as GRNI or post the invoices; oldest first.', src: ['opdn'], value: 'GRPO document total (incl. tax) — basis for the GRNI accrual' },
  delivery: { desc: 'Goods delivered to customers but not yet invoiced — raise the invoices or accrue unbilled revenue; oldest first.', src: ['odln'], value: 'Delivery document total (incl. tax) — unbilled revenue' },
  salesReturn: { desc: 'Customer returns received without an A/R credit memo — credit the customer or close the return.', src: ['ordn'], value: 'Return document total (incl. tax)' },
  purchaseReturn: { desc: 'Goods sent back to vendors with no vendor credit booked — obtain and post the A/P credit memos.', src: ['orpd'], value: 'Goods return document total (incl. tax)' },
  arCredit: { desc: 'Customer credit memos not yet applied to an invoice or refunded — offset them via internal reconciliation.', src: ['orin'], value: 'Unapplied amount = credit memo total − amount already applied' },
  apCredit: { desc: 'Vendor credit memos not yet offset — use them in the next payment run.', src: ['orpc'], value: 'Unapplied amount = credit memo total − amount already applied' },
  receipts: { desc: 'Customer payments posted on account and not matched to invoices — match them; older than 30 days is critical.', src: ['orct'], value: 'Unapplied (on-account) balance of the receipt' },
  payments: { desc: 'Vendor payments posted on account and not matched to invoices — match them or reclassify as advances.', src: ['ovpm'], value: 'Unapplied (on-account) balance of the payment' },
  arReco: { desc: 'Customers who have both open invoices and unapplied credits/cash — run internal reconciliation to offset them.', src: ['oinv', 'orin', 'orct'], value: 'Amount that can be offset = smaller of open invoices and unapplied credit/cash' },
  apReco: { desc: 'Vendors who have both open invoices and unapplied credits/payments — offset them before closing.', src: ['opch', 'orpc', 'ovpm'], value: 'Amount that can be offset = smaller of open invoices and unapplied credit/cash' },
  backdated: { desc: 'Documents dated inside the period but created after it ended — review with the posting user, then lock the period.', src: ['ojdt'], value: 'Document total (journal entries: local-currency total)' },
  drafts: { desc: 'Draft documents dated in the period that were never posted — post or delete them so nothing is left out.', src: ['odrf'], value: 'Draft document total' },
  negStock: { desc: 'Item-warehouse combinations with stock below zero — post the missing receipts before valuing inventory.', src: ['oitw'], value: 'Quantity on hand (negative) — a quantity, not an amount', docNum: 'Item code with negative stock', card: 'Warehouse' },
};
const SEVERITY_RANK ={ CRITICAL: 3, ATTENTION: 2, INFO: 1, OK: 0, 'N/A': -1 };
// Decision table for the explain popup; `hit` only on the rule whose result applied.
const rulesHit = (list, applied) => list.map(([rule, result]) => (result === applied ? { rule, result, hit: true } : { rule, result }));

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
  // criticalRule / valueRule: plain-language text for the "how is this calculated?" popup.
  const add = (key, step, label, rows, { severity = 'ATTENTION', critical, criticalRule, valueRule, action, unit = 'value' } = {}) => {
    const statusRules = st => ({ rules: rulesHit([
      ['Check not available on this database', 'N/A'],
      ['Nothing pending', 'OK'],
      ...(critical ? [[criticalRule, 'CRITICAL']] : []),
      [critical ? 'Other pending items' : 'Any item pending', severity],
    ], st) });
    if (rows === null) { checks.push({ key, step, check: label, status: 'N/A', items: null, value: null, action: 'Not available on this database', explain: { status: statusRules('N/A') } }); return; }
    const withAge = rows.map(r => ({ ...r, age: r.date ? daysBetween(r.date, end) : null }));
    rowsByCheck[key] = withAge.sort((a, z) => (z.age ?? 0) - (a.age ?? 0));
    const value = rows.reduce((s, r) => s + num(r.value), 0);
    const isCritical = critical ? critical(withAge, value) : false;
    const status = rows.length ? (isCritical ? 'CRITICAL' : severity) : 'OK';
    const explain = { status: statusRules(status) };
    if (unit === 'value' && valueRule && rows.length) explain.value = { steps: [{ label: 'Items', value: rows.length },
      { label: 'Total', formula: valueRule, value: round(value) }], note: rows.some(r => /^(GRPO|Delivery|Return|Goods return|Draft)/.test(r.docType || '')) ? 'Uses document totals (incl. tax).' : undefined };
    checks.push({ key, step, check: label, status, items: rows.length,
      value: unit === 'value' ? round(value) : null, oldest: withAge.length ? Math.max(...withAge.map(r => r.age ?? 0)) : null, action: rows.length ? action : 'Nothing pending', explain });
  };
  const olderThanPeriod = rows => rows.some(r => r.date && r.date < start);

  // 1-2 Goods received / delivered but not invoiced
  const grpo = await openDocs(k, 'OPDN', end);
  add('grpo', 1, 'Goods receipts (GRPO) not A/P invoiced', grpo?.map(r => ({ ...r, docType: 'GRPO', detail: 'Received, not invoiced — accrue GRNI' })) ?? null,
    { critical: olderThanPeriod, criticalRule: `Any GRPO dated before ${start} (older than this period)`, valueRule: 'sum of open GRPOs (received, not invoiced) = GRNI to accrue',
      action: 'Post the A/P invoices or book a GRNI accrual; chase vendors for missing invoices' });
  const dln = await openDocs(k, 'ODLN', end);
  add('delivery', 2, 'Deliveries not A/R invoiced', dln?.map(r => ({ ...r, docType: 'Delivery', detail: 'Delivered, not billed — unbilled revenue' })) ?? null,
    { critical: olderThanPeriod, criticalRule: `Any delivery dated before ${start} (older than this period)`, valueRule: 'sum of open deliveries (delivered, not billed) = unbilled revenue',
      action: 'Raise the A/R invoices before closing, or accrue unbilled revenue' });

  // 3-4 Returns awaiting credit memos
  const rdn = await openDocs(k, 'ORDN', end);
  add('salesReturn', 3, 'Sales returns without A/R credit memo', rdn?.map(r => ({ ...r, docType: 'Return', detail: 'Goods back, customer not credited' })) ?? null,
    { valueRule: 'sum of open sales returns', action: 'Issue the A/R credit memos (or close the returns) so revenue and stock agree' });
  const rpd = await openDocs(k, 'ORPD', end);
  add('purchaseReturn', 4, 'Goods returns without A/P credit memo', rpd?.map(r => ({ ...r, docType: 'Goods return', detail: 'Goods sent back, vendor credit not booked' })) ?? null,
    { valueRule: 'sum of open goods returns', action: 'Obtain and post the vendor credit notes' });

  // 5-6 Unapplied credit memos
  const rin = await openDocs(k, 'ORIN', end, { balance: true });
  add('arCredit', 5, 'Open A/R credit memos (unapplied)', rin?.filter(r => r.value > 0.005).map(r => ({ ...r, docType: 'A/R credit memo', detail: 'Credit not applied to an invoice or refunded' })) ?? null,
    { severity: 'ATTENTION', valueRule: 'Σ (credit memo total − amount already applied)', action: 'Apply against open invoices via internal reconciliation, or refund' });
  const rpc = await openDocs(k, 'ORPC', end, { balance: true });
  add('apCredit', 6, 'Open A/P credit memos (unapplied)', rpc?.filter(r => r.value > 0.005).map(r => ({ ...r, docType: 'A/P credit memo', detail: 'Vendor credit not offset' })) ?? null,
    { valueRule: 'Σ (credit memo total − amount already applied)', action: 'Offset against open A/P invoices in the next payment run' });

  // 7-8 Payments on account
  const rct = await onAccount(k, 'ORCT', end);
  add('receipts', 7, 'Incoming payments on account (unapplied)', rct?.map(r => ({ ...r, docType: 'Incoming payment', detail: 'Cash received, not matched to invoices' })) ?? null,
    { critical: rows => rows.some(r => r.age > 30), criticalRule: 'Any receipt unapplied for more than 30 days', valueRule: 'Σ unapplied (on-account) balance',
      action: 'Match receipts to invoices (internal reconciliation); identify unknown remitters' });
  const vpm = await onAccount(k, 'OVPM', end);
  add('payments', 8, 'Outgoing payments on account (unapplied)', vpm?.map(r => ({ ...r, docType: 'Outgoing payment', detail: 'Paid, not matched to vendor invoices' })) ?? null,
    { valueRule: 'Σ unapplied (on-account) balance', action: 'Match to A/P invoices or reclassify as advances' });

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
      explain: { value: { steps: [{ label: 'Open invoices', value: round(inv.get(card).open), detail: `${inv.get(card).n} invoice(s)` },
        { label: 'Unapplied credit / cash', value: round(credit) }],
        result: { label: 'Can be offset = smaller of the two', value: round(Math.min(credit, inv.get(card).open)) } } },
    })).sort((a, z) => z.value - a.value);
  };
  add('arReco', 9, 'Customers to reconcile (open invoices + unapplied credit)', reco(openAr, [rin?.filter(r => r.value > 0), rct], 'Customer'),
    { valueRule: 'Σ per customer: smaller of open invoices and unapplied credit/cash', action: 'Run internal reconciliation (Banking → Reconciliation) to offset' });
  add('apReco', 10, 'Vendors to reconcile (open invoices + unapplied credit)', reco(openAp, [rpc?.filter(r => r.value > 0), vpm], 'Vendor'),
    { valueRule: 'Σ per vendor: smaller of open invoices and unapplied credit/cash', action: 'Offset vendor credits and advances against open invoices' });

  // 11 Back-dated postings (only meaningful once the period has passed)
  let bd = [];
  if (today > end) {
    for (const [t, label] of [['OINV', 'A/R invoice'], ['OPCH', 'A/P invoice'], ['ORIN', 'A/R credit memo'], ['ORPC', 'A/P credit memo'],
      ['ODLN', 'Delivery'], ['OPDN', 'GRPO'], ['ORCT', 'Incoming payment'], ['OVPM', 'Outgoing payment']]) bd.push(...await backdated(k, t, label, end));
    bd.push(...await backdated(k, 'OJDT', 'Journal entry', end, 'RefDate', 'Number', 'LocTotal'));
    bd = bd.filter(r => r.date >= start);
  }
  add('backdated', 11, 'Back-dated postings into the period', today > end ? bd : null,
    { severity: 'CRITICAL', valueRule: 'sum of back-dated document totals', action: 'Review with the posting user; lock the posting period once the close is signed off' });
  if (today <= end) checks[checks.length - 1] = { ...checks[checks.length - 1], status: 'INFO', action: 'Period still open — checked after period end',
    explain: { status: { rules: rulesHit([['Period not yet ended', 'INFO'], ['Nothing back-dated', 'OK'], ['Any document dated in the period but created after it', 'CRITICAL']], 'INFO') } } };
  else checks[checks.length - 1].explain.status.note = `Back-dated = dated ${start} – ${end} but created after ${end}.`;

  // 12 Drafts dated in the period
  let drafts = null;
  if ((await Promise.all(['DocStatus', 'ObjType', 'DocNum', 'DocDate', 'CardCode', 'CardName', 'DocTotal'].map(c => k.has('ODRF', c)))).every(Boolean)) {
    const OBJ = { 13: 'A/R invoice', 14: 'A/R credit memo', 15: 'Delivery', 17: 'Sales order', 18: 'A/P invoice', 19: 'A/P credit memo', 20: 'GRPO', 22: 'Purchase order', 23: 'Quotation', 24: 'Incoming payment', 46: 'Outgoing payment', 30: 'Journal entry' };
    const rows = await k.run(`SELECT {DocNum}, {ObjType}, {CardCode}, {CardName}, {DocDate}, {DocTotal} FROM @ODRF
      WHERE {DocStatus} = 'O' AND {DocDate} >= ${k.lit(start)} AND {DocDate} <= ${k.lit(end)}`);
    drafts = rows.filter(r => [13, 14, 15, 18, 19, 20, 24, 46, 30].includes(Number(r.ObjType)))
      .map(r => ({ docType: `Draft ${OBJ[Number(r.ObjType)] || r.ObjType}`, docNum: r.DocNum, cardCode: r.CardCode || '', cardName: r.CardName || '', date: isoDate(r.DocDate), value: num(r.DocTotal), detail: 'Draft never posted' }));
  }
  add('drafts', 12, 'Unposted drafts dated in the period', drafts, { severity: 'INFO', valueRule: 'sum of draft totals', action: 'Post or delete the drafts so nothing is left out of the period' });

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
    items: null, value: null, oldest: null,
    explain: { status: { rules: rulesHit([['Posting period table not available', 'N/A'], ['Period locked', 'OK'], ['Not locked and the period has ended', 'ATTENTION'], ['Not locked, period still running', 'INFO']],
      period === 'n/a' || !period ? 'N/A' : period.stat === 'Y' ? 'OK' : today > end ? 'ATTENTION' : 'INFO'), note: `Status in SAP: ${statName}.` } },
    action: period && period !== 'n/a' ? `Period ${period.code}: ${statName}${period.stat !== 'Y' && today > end ? ' — lock it after sign-off to stop back-dated postings' : ''}` : 'Posting period table not available' });

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

  const issueCols = [{ key: 'docType', label: 'Type', fmt: 'badge', hint: 'Kind of SAP document (or Customer / Vendor / Stock for summary lines)' },
    { key: 'docNum', label: 'Doc #', hint: 'SAP document number (item code for negative stock)' },
    { key: 'date', label: 'Date', fmt: 'date', hint: 'Document (posting) date' },
    { key: 'age', label: 'Age (d)', fmt: 'int', hint: `Days from the document date to the period end (${end})` },
    { key: 'cardName', label: 'Business partner', sub: 'cardCode', hint: 'Customer or vendor on the document (warehouse for negative stock)' },
    { key: 'value', label: 'Value', fmt: 'amt', strong: true, hint: 'Open amount of the item — see the tab description for what it means per check' },
    { key: 'detail', label: 'Detail', wrap: true, hint: 'Why this item blocks a clean close' }];
  const statusBadge = { OK: 'green', ATTENTION: 'amber', CRITICAL: 'red', INFO: 'blue', 'N/A': 'grey' };
  const createdCol = { key: 'created', label: 'Created', fmt: 'date', hint: `Date the document was actually entered in SAP — after the period end (${end})` };
  const tabFor = (key, label) => {
    const info = CHECK_INFO[key] || {}, chk = checks.find(c => c.key === key);
    const cols = issueCols.map(c => (c.key === 'value' && info.value ? { ...c, hint: info.value }
      : c.key === 'docNum' && info.docNum ? { ...c, hint: info.docNum } : c.key === 'cardName' && info.card ? { ...c, hint: info.card } : c));
    return { key, label: `${label} (${rowsByCheck[key]?.length ?? 0})`, rows: rowsByCheck[key] || [],
      desc: `Step ${chk?.step ?? ''}: ${info.desc || chk?.check || ''}${chk?.status === 'N/A' ? ' (Not available on this database.)' : ''}`,
      columns: key === 'backdated' ? [...cols.slice(0, 3), createdCol, ...cols.slice(4)] : cols };
  };
  const srcOf = key => (CHECK_INFO[key]?.src || []).map(s => SRC[s]);
  const statusCount = st => checks.filter(c => c.status === st).length;
  const oldestOf = key => checks.find(c => c.key === key)?.oldest ?? 0;
  const sumWhere = (key, f) => round((rowsByCheck[key] || []).filter(f).reduce((s, r) => s + num(r.value), 0));
  const largest = key => { const r = (rowsByCheck[key] || []).reduce((m, x) => (!m || Math.abs(x.value) > Math.abs(m.value) ? x : m), null); return r ? `${r.docNum} ${r.cardName}`.trim() : '—'; };

  return {
    kpis: [
      { label: 'Close readiness', value: readiness, fmt: 'pct', tone: readiness >= 90 ? 'good' : readiness >= 60 ? 'warn' : 'bad', hint: 'Checks clear ÷ applicable checks',
        calc: { formula: 'Checks with status OK ÷ applicable checks × 100 (checks that are N/A or informational are excluded).',
          steps: [`Each of the ${checks.length} checklist steps is run for the period ${start} → ${end}.`, 'A check is clear (OK) when nothing is pending.', 'Readiness ≥ 90% is green, ≥ 60% amber, otherwise red.'],
          sources: Object.values(SRC), tab: 'checklist', filter: c => c.status !== 'OK' && c.status !== 'N/A', sortBy: 'value',
          stats: [{ label: 'Checks clear', value: passed, fmt: 'int' }, { label: 'Applicable checks', value: applicable.length, fmt: 'int' },
            { label: 'Critical', value: critical.length, fmt: 'int' }, { label: 'Attention', value: statusCount('ATTENTION'), fmt: 'int' }, { label: 'N/A or info', value: statusCount('N/A') + statusCount('INFO'), fmt: 'int' }] } },
      { label: 'Critical checks', value: critical.length, fmt: 'int', tone: critical.length ? 'bad' : 'good', hint: 'Checks that block the close',
        calc: { formula: 'Count of checklist steps with status CRITICAL.',
          steps: [`Critical when: GRPOs or deliveries dated before ${start} are still open, a receipt is unapplied > 30 days, any back-dated posting, or any negative stock.`, 'Resolve these before signing off the period.'],
          sources: Object.values(SRC), tab: 'checklist', filter: c => c.status === 'CRITICAL', sortBy: 'value', chart: null,
          stats: [{ label: 'Critical', value: critical.length, fmt: 'int' }, { label: 'Critical issue lines', value: issues.filter(i => i.status === 'CRITICAL').length, fmt: 'int' },
            { label: 'Attention checks', value: statusCount('ATTENTION'), fmt: 'int' }] } },
      { label: 'GRNI to accrue', value: val('grpo'), fmt: 'amt', tone: val('grpo') ? 'warn' : 'good', hint: `${cnt('grpo')} GRPOs not invoiced`,
        calc: { formula: `Σ document total of open goods receipts (GRPO) dated on or before ${end} — goods received but not yet invoiced by the vendor.`,
          steps: ['Document totals include tax; accrue the net amount in the G/L.', `GRPOs dated before ${start} make this check CRITICAL.`],
          sources: srcOf('grpo'), tab: 'grpo', sortBy: 'value', chart: null,
          stats: [{ label: 'GRPOs', value: cnt('grpo'), fmt: 'int' }, { label: 'From earlier periods', value: sumWhere('grpo', r => r.date < start), fmt: 'amt' },
            { label: 'This period', value: sumWhere('grpo', r => r.date >= start), fmt: 'amt' }, { label: 'Oldest (days)', value: oldestOf('grpo'), fmt: 'int' }] } },
      { label: 'Unbilled deliveries', value: val('delivery'), fmt: 'amt', tone: val('delivery') ? 'warn' : 'good', hint: `${cnt('delivery')} deliveries`,
        calc: { formula: `Σ document total of open deliveries dated on or before ${end} — shipped to customers but not yet A/R invoiced.`,
          steps: ['Document totals include tax.', `Deliveries dated before ${start} make this check CRITICAL.`],
          sources: srcOf('delivery'), tab: 'delivery', sortBy: 'value', chart: null,
          stats: [{ label: 'Deliveries', value: cnt('delivery'), fmt: 'int' }, { label: 'From earlier periods', value: sumWhere('delivery', r => r.date < start), fmt: 'amt' },
            { label: 'This period', value: sumWhere('delivery', r => r.date >= start), fmt: 'amt' }, { label: 'Oldest (days)', value: oldestOf('delivery'), fmt: 'int' }] } },
      { label: 'Unapplied receipts', value: val('receipts'), fmt: 'amt', tone: val('receipts') ? 'warn' : 'good', hint: 'Customer cash not matched to invoices',
        calc: { formula: `Σ open (on-account) balance of incoming payments dated on or before ${end}.`,
          steps: ['Receipts unapplied for more than 30 days make this check CRITICAL.', 'Match them via internal reconciliation; identify unknown remitters.'],
          sources: srcOf('receipts'), tab: 'receipts', sortBy: 'value', chart: null,
          stats: [{ label: 'Receipts', value: cnt('receipts'), fmt: 'int' }, { label: 'Unapplied > 30 days', value: sumWhere('receipts', r => r.age > 30), fmt: 'amt' },
            { label: 'Customers to reconcile', value: cnt('arReco'), fmt: 'int' }, { label: 'Largest', value: largest('receipts') }] } },
      { label: 'Unapplied credit memos', value: val('arCredit') + val('apCredit'), fmt: 'amt', hint: 'A/R + A/P credit memos not yet applied',
        calc: { formula: 'Σ (credit memo total − amount already applied) for open A/R credit memos + open A/P credit memos.',
          steps: ['A/R credits: apply against open customer invoices or refund.', 'A/P credits: offset against open vendor invoices in the next payment run.'],
          sources: [...srcOf('arCredit'), ...srcOf('apCredit')], tab: 'issues', filter: r => checks.some(c => (c.key === 'arCredit' || c.key === 'apCredit') && c.check === r.check), sortBy: 'value', chart: null,
          stats: [{ label: 'A/R credit memos', value: val('arCredit'), fmt: 'amt' }, { label: 'A/P credit memos', value: val('apCredit'), fmt: 'amt' },
            { label: 'A/R count', value: cnt('arCredit'), fmt: 'int' }, { label: 'A/P count', value: cnt('apCredit'), fmt: 'int' }] } },
      { label: 'Back-dated postings', value: cnt('backdated'), fmt: 'int', tone: cnt('backdated') ? 'bad' : 'good', hint: 'Dated in the period, created after it',
        calc: { formula: `Count of documents dated ${start} – ${end} but created in SAP after ${end}.`,
          steps: ['Covers A/R & A/P invoices and credit memos, deliveries, GRPOs, incoming/outgoing payments and journal entries.', 'Only checked once the period has ended.', 'Lock the posting period after sign-off to prevent this.'],
          sources: [SRC.ojdt, SRC.ofpr], tab: 'backdated', sortBy: 'value', chart: null,
          stats: [{ label: 'Documents', value: cnt('backdated'), fmt: 'int' }, { label: 'Value', value: val('backdated'), fmt: 'amt' },
            { label: 'Journal entries', value: (rowsByCheck.backdated || []).filter(r => r.docType === 'Journal entry').length, fmt: 'int' }, { label: 'Posting period', value: statName }] } },
      { label: 'Negative stock lines', value: cnt('negStock'), fmt: 'int', tone: cnt('negStock') ? 'bad' : 'good', hint: 'Item-warehouses with stock below zero',
        calc: { formula: 'Count of item × warehouse combinations whose quantity in stock is below zero (current stock, not as of the period end).',
          steps: ['Negative stock distorts inventory valuation and cost of goods sold.', 'Post the missing receipts or correct the issues before closing.'],
          sources: srcOf('negStock'), tab: 'negStock', sortBy: 'value', chart: null,
          stats: [{ label: 'Lines', value: cnt('negStock'), fmt: 'int' }, { label: 'Σ negative qty', value: round(sumWhere('negStock', () => true), 2), fmt: 'num' },
            { label: 'Warehouses affected', value: new Set((rowsByCheck.negStock || []).map(r => r.cardCode)).size, fmt: 'int' }] } },
    ],
    chart: { title: 'Pending value by check', type: 'bar', labels: checks.filter(c => c.value).map(c => c.check.replace(/\s*\(.*\)/, '')),
      desc: 'Open value still pending for each checklist step — the tallest bars are the biggest accruals or clean-ups to handle before closing.',
      series: [{ name: 'Value', values: checks.filter(c => c.value).map(c => c.value), color: '#D97706' }] },
    tabs: [
      { key: 'checklist', label: 'Close checklist', rows: checks,
        desc: `The ${checks.length}-step close checklist for ${start} → ${end}: status, how many items are pending and what to do — work top-down, CRITICAL first.`,
        columns: [{ key: 'step', label: '#', fmt: 'int', hint: 'Step number in the close checklist' },
          { key: 'status', label: 'Status', fmt: 'badge', badge: statusBadge, hint: 'OK = nothing pending; ATTENTION / CRITICAL = items to fix; INFO = informational; N/A = not available on this database' },
          { key: 'check', label: 'Check', hint: 'What is being checked' },
          { key: 'items', label: 'Items', fmt: 'int', hint: 'Number of pending documents / lines' },
          { key: 'value', label: 'Value', fmt: 'amt', hint: 'Σ value of the pending items (blank for quantity-only checks)' },
          { key: 'oldest', label: 'Oldest (d)', fmt: 'int', hint: `Age in days of the oldest pending item at period end (${end})` },
          { key: 'action', label: 'Action', wrap: true, hint: 'What to do to clear the check' }] },
      { key: 'issues', label: `All issues (${issues.length})`, rows: issues,
        desc: 'Every pending item from all checks in one list, most severe and largest value first — use it as the close to-do list.',
        columns: [{ key: 'status', label: 'Severity', fmt: 'badge', badge: statusBadge, hint: 'Status of the check the item belongs to' },
          { key: 'check', label: 'Check', wrap: true, hint: 'Checklist step that flagged the item' }, ...issueCols] },
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
