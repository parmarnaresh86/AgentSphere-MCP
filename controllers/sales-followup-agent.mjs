/**
 * Sales Follow-up Agent — mounted at /api/sales-followup-agent
 *
 * Finds open sales quotations, sales orders and sales opportunities that have
 * gone quiet (no SAP activity / document update), expired or slipped past
 * their dates, prioritises them by value and staleness, and can create a
 * follow-up Activity in SAP or draft a follow-up email.
 */
import { createInsightRouter, callAI, createSapActivity, ctxTable, isoDate, todayISO, daysBetween, addDays, num, round, clamp, fmtAmt } from '../lib/insight-kit.mjs';
import { loadPartners, loadOpenDocs, loadSalesEmployees } from '../lib/insight-data.mjs';

const DOC_TYPE = { quote: '23', order: '17' };

async function loadActivities(k) {
  if (!(await k.has('OCLG', 'CntctDate'))) return { byDoc: new Map(), byCard: new Map(), scheduled: new Map() };
  await k.need('OCLG', ['CardCode', 'CntctDate', 'DocType', 'DocEntry', 'Closed', 'Recontact']);
  const rows = await k.run(`SELECT {CardCode}, {CntctDate}, {DocType}, {DocEntry}, {Closed}, {Recontact} FROM @OCLG`);
  const byDoc = new Map(), byCard = new Map(), scheduled = new Map();
  const later = (m, key, d) => { if (d && (!m.get(key) || d > m.get(key))) m.set(key, d); };
  for (const r of rows) {
    const d = isoDate(r.CntctDate);
    if (r.DocType && r.DocEntry != null && String(r.DocEntry).trim() !== '') later(byDoc, `${String(r.DocType).trim()}:${String(r.DocEntry).trim()}`, d);
    later(byCard, r.CardCode, d);
    if (r.Closed !== 'Y') {
      const next = isoDate(r.Recontact);
      if (next) {
        const key = r.DocType && r.DocEntry != null ? `${String(r.DocType).trim()}:${String(r.DocEntry).trim()}` : `card:${r.CardCode}`;
        if (!scheduled.get(key) || next < scheduled.get(key)) scheduled.set(key, next);
      }
    }
  }
  return { byDoc, byCard, scheduled };
}

async function loadOpportunities(k) {
  const cols = ['OpprId', 'Name', 'CardCode', 'CardName', 'MaxSumLoc', 'PredDate', 'OpenDate', 'SlpCode', 'Status'];
  for (const c of cols) if (!(await k.has('OOPR', c))) return [];
  const rows = await k.run(`SELECT ${cols.map(c => `{${c}}`).join(', ')} FROM @OOPR WHERE {Status} = 'O'`);
  return rows.map(r => ({ id: r.OpprId, name: r.Name || '', cardCode: r.CardCode, cardName: r.CardName || '',
    value: num(r.MaxSumLoc), predDate: isoDate(r.PredDate), openDate: isoDate(r.OpenDate), slpCode: r.SlpCode }));
}

const PRIORITY_BANDS = [{ level: 'HIGH', min: 55 }, { level: 'MEDIUM', min: 30 }, { level: 'LOW', min: -Infinity }];
const priorityParts = (value, maxValue, daysSinceTouch, bonus) => ({
  value: 50 * Math.sqrt(value / Math.max(1, maxValue)), quiet: 30 * Math.min(1, daysSinceTouch / 30), bonus,
});
function priorityOf(value, maxValue, daysSinceTouch, bonus) {
  const p = priorityParts(value, maxValue, daysSinceTouch, bonus);
  const s = p.value + p.quiet + p.bonus;
  return { priorityScore: Math.round(s), priority: PRIORITY_BANDS.find(b => s >= b.min).level };
}

// Status / recommended follow-up decision tables, evaluated top to bottom (first match wins).
// c = { asOf, scheduledFor, toExpiry | late | slip, age, daysSinceTouch, quoteStale, gap }
const QUOTE_RULES = [
  { rule: () => 'A follow-up is already scheduled in SAP', when: c => c.scheduledFor && c.scheduledFor >= c.asOf,
    status: 'SCHEDULED', bonus: 0, action: c => `Follow-up already scheduled for ${c.scheduledFor}` },
  { rule: () => 'Expired more than 60 days ago', when: c => c.toExpiry < -60,
    status: 'EXPIRED', bonus: 0, action: c => `Expired ${-c.toExpiry}d ago — close as lost (record the loss reason) unless the customer confirms interest` },
  { rule: () => 'Expired up to 60 days ago', when: c => c.toExpiry < 0,
    status: 'EXPIRED', bonus: 10, action: c => `Expired ${-c.toExpiry}d ago — call to revive with a refreshed quote, or close as lost` },
  { rule: () => 'Expires within 3 days', when: c => c.toExpiry <= 3,
    status: 'EXPIRING', bonus: 20, action: c => `Valid for ${c.toExpiry} more day(s) — push for a decision now` },
  { rule: c => `Quote ${c.quoteStale}+ days old and no contact for ${c.gap}+ days`, when: c => c.age >= c.quoteStale && c.daysSinceTouch >= c.gap,
    status: 'FOLLOW UP', bonus: 10, action: c => `No contact for ${c.daysSinceTouch} days — call to confirm decision timeline and objections` },
  { rule: () => 'Otherwise', when: () => true, status: 'OK', bonus: 0, action: () => 'On track' },
];
const ORDER_RULES = [
  { rule: () => 'More than 180 days past delivery date', when: c => c.late > 180,
    status: 'DELAYED', bonus: 5, action: c => `Open ${c.late}d past delivery date — confirm the customer still needs it; otherwise close the order to release stock and credit` },
  { rule: () => 'Delivery date has passed', when: c => c.late > 0,
    status: 'DELAYED', bonus: 20, action: c => `Delivery date passed ${c.late}d ago — give the customer a firm new date` },
  { rule: () => 'A follow-up is already scheduled in SAP', when: c => c.scheduledFor && c.scheduledFor >= c.asOf,
    status: 'SCHEDULED', bonus: 0, action: c => `Follow-up scheduled for ${c.scheduledFor}` },
  { rule: c => `Order 14+ days old and no contact for ${c.gap}+ days`, when: c => c.age >= 14 && c.daysSinceTouch >= c.gap,
    status: 'FOLLOW UP', bonus: 5, action: c => `Open ${c.age} days with no contact for ${c.daysSinceTouch} — confirm delivery schedule` },
  { rule: () => 'Otherwise', when: () => true, status: 'OK', bonus: 0, action: () => 'On track' },
];
const OPP_RULES = [
  { rule: () => 'Expected close slipped more than 180 days', when: c => c.slip > 180,
    status: 'DELAYED', bonus: 20, action: c => `Expected close slipped ${c.slip}d — close as lost or re-open with a new plan` },
  { rule: () => 'Expected close date has passed', when: c => c.slip > 0,
    status: 'DELAYED', bonus: 20, action: c => `Expected close slipped ${c.slip}d — re-qualify and set a new close date` },
  { rule: c => `No contact for ${c.gap}+ days`, when: c => c.daysSinceTouch >= c.gap,
    status: 'FOLLOW UP', bonus: 0, action: c => `No contact for ${c.daysSinceTouch} days — schedule next step` },
  { rule: () => 'Otherwise', when: () => true, status: 'OK', bonus: 0, action: () => 'On track' },
];

// "How is this calculated?" popups for Priority, Status and Recommended follow-up.
function explainFollowup(rules, c, hit, { openValue, maxValue, valueLabel, inputs }) {
  const p = priorityParts(openValue, maxValue, c.daysSinceTouch, hit.bonus);
  const s = p.value + p.quiet + p.bonus;
  const level = PRIORITY_BANDS.find(b => s >= b.min).level;
  const table = rules.map(x => ({ rule: x.rule(c), result: `${x.status}${x.bonus ? ` (+${x.bonus} priority)` : ''}`, hit: x === hit }));
  const decision = { steps: inputs, rules: table, note: 'Rules are checked top to bottom; the first one that matches applies.' };
  return {
    priority: {
      title: `Priority ${level} (score ${Math.round(s)})`,
      parts: [
        { label: 'Value', max: 50, points: round(p.value, 1), formula: `50 × √(value ÷ largest open ${valueLabel})`,
          detail: `${fmtAmt(openValue)} vs largest ${fmtAmt(maxValue)}` },
        { label: 'Days quiet', max: 30, points: round(p.quiet, 1), formula: '30 × min(1, days since last touch ÷ 30)', detail: `${c.daysSinceTouch} days since last touch` },
        { label: 'Status bonus', max: 20, points: p.bonus, formula: 'Extra points set by the status rule', detail: `${hit.status}: ${hit.rule(c)}` },
      ],
      rules: PRIORITY_BANDS.map((b, i) => ({
        rule: i === 0 ? `Score ${b.min} or more` : b.min === -Infinity ? `Score below ${PRIORITY_BANDS[i - 1].min}` : `Score ${b.min}–${PRIORITY_BANDS[i - 1].min - 1}`,
        result: b.level, hit: b.level === level,
      })),
    },
    status: { title: `Status ${hit.status}`, ...decision },
    action: { title: 'Recommended follow-up', ...decision, result: { label: hit.status, value: hit.action(c) } },
  };
}

async function run(k, p) {
  const asOf = p.asOf;
  const quoteStale = clamp(num(p.quoteStaleDays) || 7, 1, 180);
  const gap = clamp(num(p.activityGapDays) || 7, 1, 180);
  const [customers, slp, acts] = [await loadPartners(k, 'C'), await loadSalesEmployees(k), await loadActivities(k)];
  const quotes = await loadOpenDocs(k, 'OQUT', 'QUT1');
  const orders = await loadOpenDocs(k, 'ORDR', 'RDR1');
  const opps = await loadOpportunities(k);

  const touchInfo = (kind, d) => {
    const docAct = acts.byDoc.get(`${DOC_TYPE[kind]}:${d.docEntry}`) || null;
    const cardAct = acts.byCard.get(d.cardCode);
    const cardActAfter = cardAct && cardAct >= d.docDate ? cardAct : null;
    const lastTouch = [docAct, cardActAfter, d.updateDate, d.docDate].filter(Boolean).sort().pop();
    const scheduledFor = acts.scheduled.get(`${DOC_TYPE[kind]}:${d.docEntry}`) || acts.scheduled.get(`card:${d.cardCode}`) || null;
    return { lastActivity: docAct || cardActAfter || null, lastTouch, daysSinceTouch: daysBetween(lastTouch, asOf), scheduledFor };
  };
  const base = (kind, d) => {
    const bp = customers.get(d.cardCode) || {};
    return {
      kind, docEntry: d.docEntry, docNum: d.docNum, cardCode: d.cardCode, cardName: d.cardName,
      docDate: d.docDate, dueDate: d.dueDate, openValue: round(d.openValue), age: daysBetween(d.docDate, asOf),
      salesperson: slp.get(String(d.slpCode)) || '', email: bp.email || '', phone: bp.phone || '', contact: bp.contact || '',
      ...touchInfo(kind, d),
    };
  };

  const maxQ = Math.max(1, ...quotes.map(q => q.openValue));
  const quoteRows = quotes.map(q => {
    const r = base('quote', q);
    const toExpiry = daysBetween(asOf, q.dueDate);
    const c = { asOf, scheduledFor: r.scheduledFor, toExpiry, age: r.age, daysSinceTouch: r.daysSinceTouch, quoteStale, gap };
    const hit = QUOTE_RULES.find(x => x.when(c));
    const { status, bonus } = hit, action = hit.action(c);
    return { ...r, validUntil: q.dueDate, toExpiry, status, action, ...priorityOf(r.openValue, maxQ, r.daysSinceTouch, bonus),
      explain: explainFollowup(QUOTE_RULES, c, hit, { openValue: r.openValue, maxValue: maxQ, valueLabel: 'quote', inputs: [
        { label: 'Valid until', value: q.dueDate || '—', detail: toExpiry < 0 ? `Expired ${-toExpiry} days ago` : `${toExpiry} days left` },
        { label: 'Quote age', value: `${r.age} days`, detail: `Quoted ${r.docDate}` },
        { label: 'Days since last touch', value: r.daysSinceTouch, detail: `Last touch ${r.lastTouch}` },
        { label: 'Scheduled follow-up', value: r.scheduledFor || 'None' },
      ] }) };
  });

  const maxO = Math.max(1, ...orders.map(o => o.openValue));
  const orderRows = orders.map(o => {
    const r = base('order', o);
    const late = daysBetween(o.dueDate, asOf);
    const c = { asOf, scheduledFor: r.scheduledFor, late, age: r.age, daysSinceTouch: r.daysSinceTouch, gap };
    const hit = ORDER_RULES.find(x => x.when(c));
    const { status, bonus } = hit, action = hit.action(c);
    return { ...r, deliveryDate: o.dueDate, daysLate: Math.max(0, late), status, action, ...priorityOf(r.openValue, maxO, r.daysSinceTouch, bonus),
      explain: explainFollowup(ORDER_RULES, c, hit, { openValue: r.openValue, maxValue: maxO, valueLabel: 'order', inputs: [
        { label: 'Delivery date', value: o.dueDate || '—', detail: late > 0 ? `${late} days late` : `Due in ${-late} days` },
        { label: 'Order age', value: `${r.age} days`, detail: `Ordered ${r.docDate}` },
        { label: 'Days since last touch', value: r.daysSinceTouch, detail: `Last touch ${r.lastTouch}` },
        { label: 'Scheduled follow-up', value: r.scheduledFor || 'None' },
      ] }) };
  });

  const maxOp = Math.max(1, ...opps.map(o => o.value));
  const oppRows = opps.map(o => {
    const slip = o.predDate ? daysBetween(o.predDate, asOf) : 0;
    const cardAct = acts.byCard.get(o.cardCode);
    const lastTouch = [cardAct && cardAct >= o.openDate ? cardAct : null, o.openDate].filter(Boolean).sort().pop();
    const since = daysBetween(lastTouch, asOf) ?? 0;
    const c = { asOf, slip, daysSinceTouch: since, gap };
    const hit = OPP_RULES.find(x => x.when(c));
    const status = hit.status;
    return {
      kind: 'opportunity', docNum: o.id, name: o.name, cardCode: o.cardCode, cardName: o.cardName, openValue: round(o.value),
      predDate: o.predDate, slipDays: Math.max(0, slip), lastTouch, daysSinceTouch: since,
      salesperson: slp.get(String(o.slpCode)) || '', status,
      action: hit.action(c),
      ...priorityOf(o.value, maxOp, since, hit.bonus),
      explain: explainFollowup(OPP_RULES, c, hit, { openValue: o.value, maxValue: maxOp, valueLabel: 'opportunity', inputs: [
        { label: 'Expected close', value: o.predDate || '—', detail: slip > 0 ? `Slipped ${slip} days` : 'Not yet passed' },
        { label: 'Days since last touch', value: since, detail: `Last touch ${lastTouch}` },
      ] }),
    };
  });

  const needs = r => r.status !== 'OK' && r.status !== 'SCHEDULED';
  const byPriority = (a, z) => z.priorityScore - a.priorityScore;
  const qNeed = quoteRows.filter(needs).sort(byPriority);
  const oNeed = orderRows.filter(needs).sort(byPriority);
  const opNeed = oppRows.filter(needs).sort(byPriority);

  const bySlp = new Map();
  for (const r of [...quoteRows, ...orderRows, ...oppRows]) {
    const key = r.salesperson || '(none)';
    const e = bySlp.get(key) || { salesperson: key, openQuotes: 0, quoteValue: 0, quotesToChase: 0, delayedOrders: 0, delayedValue: 0, opportunities: 0 };
    if (r.kind === 'quote') { e.openQuotes++; e.quoteValue += r.openValue; if (needs(r)) e.quotesToChase++; }
    if (r.kind === 'order' && r.status === 'DELAYED') { e.delayedOrders++; e.delayedValue += r.openValue; }
    if (r.kind === 'opportunity' && needs(r)) e.opportunities++;
    bySlp.set(key, e);
  }
  const slpRows = [...bySlp.values()].map(e => ({ ...e, quoteValue: round(e.quoteValue), delayedValue: round(e.delayedValue) }))
    .sort((a, z) => (z.quotesToChase + z.delayedOrders) - (a.quotesToChase + a.delayedOrders));

  const quoteValueAtRisk = qNeed.reduce((s, r) => s + r.openValue, 0);
  const delayed = orderRows.filter(r => r.status === 'DELAYED');
  const delayedValue = delayed.reduce((s, r) => s + r.openValue, 0);
  const noActivityData = acts.byCard.size === 0;

  const insight = `**${qNeed.length + oNeed.length + opNeed.length} items need follow-up: ${qNeed.length} quotations (${fmtAmt(quoteValueAtRisk)}), ${oNeed.length} sales orders, ${opNeed.length} opportunities.**\n\n` +
    (qNeed[0] ? `- Top quote: **#${qNeed[0].docNum} ${qNeed[0].cardName}** — ${fmtAmt(qNeed[0].openValue)}, ${qNeed[0].action}.\n` : '') +
    (delayed.length ? `- ${delayed.length} sales orders (${fmtAmt(delayedValue)}) are past their delivery date; the oldest is ${Math.max(...delayed.map(d => d.daysLate))} days late.\n` : '') +
    (noActivityData ? '- No SAP Activities are logged on this company, so staleness is measured from the last document update. Creating follow-up activities from this agent will improve tracking.\n' : '');

  const aiContext = `SALES FOLLOW-UP as of ${asOf}. Stale quote rule: age ≥ ${quoteStale}d and no contact ≥ ${gap}d.
Open quotes ${quoteRows.length}, needing follow-up ${qNeed.length} (${fmtAmt(quoteValueAtRisk)}); open SOs ${orderRows.length}, delayed ${delayed.length} (${fmtAmt(delayedValue)}); open opportunities ${oppRows.length}, needing action ${opNeed.length}.
QUOTES TO CHASE:
${ctxTable(qNeed, [['docNum', 'Quote'], ['cardName', 'Customer'], ['openValue', 'Value'], ['age', 'Age'], ['daysSinceTouch', 'NoContactDays'], ['validUntil', 'ValidUntil'], ['status', 'Status'], ['salesperson', 'Slp']], 20)}
SALES ORDERS:
${ctxTable(oNeed, [['docNum', 'SO'], ['cardName', 'Customer'], ['openValue', 'OpenValue'], ['deliveryDate', 'Delivery'], ['daysLate', 'DaysLate'], ['status', 'Status'], ['salesperson', 'Slp']], 20)}
OPPORTUNITIES:
${ctxTable(opNeed, [['docNum', 'Id'], ['name', 'Name'], ['cardName', 'Customer'], ['openValue', 'Value'], ['predDate', 'ExpectedClose'], ['slipDays', 'Slip'], ['status', 'Status']], 10)}
BY SALESPERSON:
${ctxTable(slpRows, [['salesperson', 'Slp'], ['quotesToChase', 'QuotesToChase'], ['delayedOrders', 'DelayedSO'], ['opportunities', 'Opps']], 15)}`;

  const actions = [
    { id: 'email', label: 'Draft email', kind: 'text', endpoint: '/api/sales-followup-agent/draft-email' },
    { id: 'activity', label: 'Create follow-up in SAP', kind: 'post', endpoint: '/api/sales-followup-agent/activity',
      confirm: 'Create a follow-up task Activity in SAP for {cardName} (due in 2 days)?' },
  ];
  const PRIO_HINT = 'HIGH (score ≥ 55), MEDIUM (≥ 30) or LOW. Score = value up to 50 + days quiet up to 30 + status bonus up to 20';
  const common = [
    { key: 'priority', label: 'Priority', fmt: 'badge', hint: PRIO_HINT },
    { key: 'status', label: 'Status', fmt: 'badge', hint: 'Why it needs attention: FOLLOW UP (gone quiet), EXPIRING/EXPIRED (quote validity), DELAYED (date passed)' },
    { key: 'docNum', label: 'Doc #', hint: 'SAP document number of the quotation or sales order' },
    { key: 'cardName', label: 'Customer', sub: 'cardCode', hint: 'Customer name and SAP business partner code' },
    { key: 'openValue', label: 'Open value', fmt: 'amt', hint: 'Value of the lines still open (not yet ordered / delivered)' },
  ];
  const tail = [
    { key: 'lastTouch', label: 'Last touch', fmt: 'date', hint: 'Latest of: SAP activity on the document, customer activity after the document date, or last document update' },
    { key: 'daysSinceTouch', label: 'Quiet (days)', fmt: 'int', hint: 'Days since the last touch' },
    { key: 'salesperson', label: 'Salesperson', hint: 'Sales employee on the document' },
    { key: 'action', label: 'Recommended follow-up', wrap: true, hint: 'Suggested next step from the status rule' },
  ];
  const quoteCols = [...common, { key: 'docDate', label: 'Quoted', fmt: 'date', hint: 'Quotation date' },
    { key: 'validUntil', label: 'Valid until', fmt: 'date', hint: 'Quotation validity date in SAP' }, ...tail];
  const orderCols = [...common, { key: 'deliveryDate', label: 'Delivery date', fmt: 'date', hint: 'Promised delivery date on the sales order' },
    { key: 'daysLate', label: 'Days late', fmt: 'int', hint: 'Days past the delivery date (0 = not yet due)' }, ...tail];
  const SRC = {
    oqut: 'OQUT + QUT1 — open sales quotations: open line value, valid-until date, update date',
    ordr: 'ORDR + RDR1 — open sales orders: open line value, delivery date, update date',
    oopr: 'OOPR — open sales opportunities: potential amount, expected closing date',
    oclg: 'OCLG — SAP activities: last contact date and scheduled follow-ups per document / customer',
    oslp: 'OSLP — sales employees',
  };
  const sumV = list => round(list.reduce((s, r) => s + r.openValue, 0));
  const countSt = (list, st) => list.filter(r => r.status === st).length;
  const expiredQ = quoteRows.filter(r => r.status === 'EXPIRED');

  return {
    kpis: [
      { label: 'Open quotations', value: quoteRows.length, fmt: 'int', hint: 'Sales quotations still open in SAP',
        calc: { formula: 'Count of open, non-cancelled sales quotations with open lines.',
          steps: ['Each quote gets a status from rules checked top to bottom: SCHEDULED, EXPIRED, EXPIRING (≤ 3 days), FOLLOW UP, OK.', `FOLLOW UP = quote ${quoteStale}+ days old and no contact for ${gap}+ days.`],
          sources: [SRC.oqut, SRC.oclg], rows: quoteRows, columns: quoteCols, sortBy: 'openValue', chart: null,
          stats: [{ label: 'Total open value', value: sumV(quoteRows), fmt: 'amt' }, { label: 'Need follow-up', value: qNeed.length, fmt: 'int' },
            { label: 'Follow-up scheduled', value: countSt(quoteRows, 'SCHEDULED'), fmt: 'int' }, { label: 'On track', value: countSt(quoteRows, 'OK'), fmt: 'int' }] } },
      { label: 'Quotes to chase', value: qNeed.length, fmt: 'int', tone: qNeed.length ? 'warn' : 'good', hint: 'Quotes that expired, are expiring or went quiet',
        calc: { formula: `Count of open quotations with status EXPIRED, EXPIRING (≤ 3 days left) or FOLLOW UP (${quoteStale}+ days old, no contact for ${gap}+ days).`,
          steps: ['Quotes with a follow-up already scheduled in SAP are excluded.', 'Last touch = latest SAP activity on the quote or customer, or the quote’s last update.'],
          sources: [SRC.oqut, SRC.oclg], tab: 'quotes', sortBy: 'openValue', chart: null,
          stats: [{ label: 'EXPIRED', value: countSt(qNeed, 'EXPIRED'), fmt: 'int' }, { label: 'EXPIRING', value: countSt(qNeed, 'EXPIRING'), fmt: 'int' },
            { label: 'FOLLOW UP', value: countSt(qNeed, 'FOLLOW UP'), fmt: 'int' }, { label: 'HIGH priority', value: qNeed.filter(r => r.priority === 'HIGH').length, fmt: 'int' }] } },
      { label: 'Quote value at stake', value: quoteValueAtRisk, fmt: 'amt', hint: 'Open value of the quotes to chase',
        calc: { formula: 'Σ open value of quotations with status EXPIRED, EXPIRING or FOLLOW UP.',
          steps: ['Open value = value of quotation lines not yet copied to an order.', 'Expired quotes are included: they can often be revived with a refreshed quote.'],
          sources: [SRC.oqut, SRC.oclg], tab: 'quotes', sortBy: 'openValue', chart: null,
          stats: [{ label: 'All open quotes', value: sumV(quoteRows), fmt: 'amt' }, { label: '% of open quote value', value: sumV(quoteRows) ? round((quoteValueAtRisk / sumV(quoteRows)) * 100, 1) : 0, fmt: 'pct' },
            { label: 'Expired value', value: sumV(qNeed.filter(r => r.status === 'EXPIRED')), fmt: 'amt' }, { label: 'HIGH priority value', value: sumV(qNeed.filter(r => r.priority === 'HIGH')), fmt: 'amt' }] } },
      { label: 'Expired quotes', value: quoteRows.filter(r => r.status === 'EXPIRED').length, fmt: 'int', tone: 'warn', hint: 'Open quotes past their valid-until date',
        calc: { formula: 'Count of open quotations whose valid-until date has passed and no follow-up is scheduled.',
          steps: ['Expired up to 60 days: call to revive with a refreshed quote.', 'Expired over 60 days: close as lost with a loss reason unless the customer confirms interest.'],
          sources: [SRC.oqut, SRC.oclg], tab: 'quotes', filter: r => r.status === 'EXPIRED', sortBy: 'openValue', chart: null,
          stats: [{ label: 'Their open value', value: sumV(expiredQ), fmt: 'amt' }, { label: 'Expired ≤ 60 days', value: expiredQ.filter(r => r.toExpiry >= -60).length, fmt: 'int' },
            { label: 'Expired > 60 days', value: expiredQ.filter(r => r.toExpiry < -60).length, fmt: 'int' }] } },
      { label: 'Open sales orders', value: orderRows.length, fmt: 'int', hint: 'Sales orders with lines still to deliver',
        calc: { formula: 'Count of open, non-cancelled sales orders with open lines.',
          steps: ['Status rules: DELAYED (delivery date passed), SCHEDULED, FOLLOW UP (14+ days old, no contact for ' + gap + '+ days), OK.'],
          sources: [SRC.ordr, SRC.oclg], rows: orderRows, columns: orderCols, sortBy: 'openValue', chart: null,
          stats: [{ label: 'Total open value', value: sumV(orderRows), fmt: 'amt' }, { label: 'Delayed', value: delayed.length, fmt: 'int' },
            { label: 'Need follow-up', value: oNeed.length, fmt: 'int' }, { label: 'On track', value: countSt(orderRows, 'OK'), fmt: 'int' }] } },
      { label: 'Delayed orders', value: delayed.length, fmt: 'int', tone: delayed.length ? 'bad' : 'good', hint: 'Open orders past their delivery date',
        calc: { formula: 'Count of open sales orders whose delivery date is before today.',
          steps: ['Up to 180 days late: give the customer a firm new date.', 'Over 180 days late: confirm the need, otherwise close the order to release stock and credit.'],
          sources: [SRC.ordr], tab: 'orders', filter: r => r.status === 'DELAYED', sortBy: 'openValue', chart: null,
          stats: [{ label: 'Over 180 days late', value: delayed.filter(r => r.daysLate > 180).length, fmt: 'int' }, { label: 'Over 30 days late', value: delayed.filter(r => r.daysLate > 30).length, fmt: 'int' },
            { label: 'Oldest (days late)', value: delayed.length ? Math.max(...delayed.map(d => d.daysLate)) : 0, fmt: 'int' }, { label: 'Customers affected', value: new Set(delayed.map(r => r.cardCode)).size, fmt: 'int' }] } },
      { label: 'Delayed order value', value: delayedValue, fmt: 'amt', tone: delayedValue ? 'bad' : 'good', hint: 'Open value of orders past their delivery date',
        calc: { formula: 'Σ open (undelivered) value of sales orders whose delivery date has passed.',
          sources: [SRC.ordr], tab: 'orders', filter: r => r.status === 'DELAYED', sortBy: 'openValue', chart: null,
          stats: [{ label: 'Delayed orders', value: delayed.length, fmt: 'int' }, { label: '% of open order value', value: sumV(orderRows) ? round((delayedValue / sumV(orderRows)) * 100, 1) : 0, fmt: 'pct' },
            { label: 'Value over 180 days late', value: sumV(delayed.filter(r => r.daysLate > 180)), fmt: 'amt' }] } },
      { label: 'Opportunities to act', value: opNeed.length, fmt: 'int', hint: 'Open opportunities that slipped or went quiet',
        calc: { formula: `Count of open sales opportunities whose expected close date has passed (DELAYED) or with no customer contact for ${gap}+ days (FOLLOW UP).`,
          steps: ['Last touch = latest SAP activity for the customer since the opportunity opened, or the open date.', 'Slipped over 180 days: close as lost or re-open with a new plan.'],
          sources: [SRC.oopr, SRC.oclg], tab: 'opps', sortBy: 'openValue', chart: null,
          stats: [{ label: 'Open opportunities', value: oppRows.length, fmt: 'int' }, { label: 'Potential of those to act on', value: sumV(opNeed), fmt: 'amt' },
            { label: 'DELAYED', value: countSt(opNeed, 'DELAYED'), fmt: 'int' }, { label: 'FOLLOW UP', value: countSt(opNeed, 'FOLLOW UP'), fmt: 'int' }] } },
    ],
    tabs: [
      { key: 'quotes', label: `Quotations (${qNeed.length})`, rows: qNeed, rowKey: 'docEntry', actions,
        desc: 'Quotations that expired, are about to expire or went quiet, highest priority first; draft an email or log a follow-up in SAP from each row.',
        columns: quoteCols },
      { key: 'orders', label: `Sales orders (${oNeed.length})`, rows: oNeed, rowKey: 'docEntry', actions,
        desc: 'Open sales orders that are late or have had no contact, highest priority first; confirm delivery dates with these customers.',
        columns: orderCols },
      { key: 'opps', label: `Opportunities (${opNeed.length})`, rows: opNeed, rowKey: 'docNum',
        actions: [actions[1]],
        desc: 'Open opportunities past their expected close date or without recent contact; re-qualify, set a new date or close as lost.',
        columns: [{ key: 'priority', label: 'Priority', fmt: 'badge', hint: PRIO_HINT },
          { key: 'status', label: 'Status', fmt: 'badge', hint: 'DELAYED = expected close date passed; FOLLOW UP = no recent contact' },
          { key: 'docNum', label: 'Opp #', hint: 'SAP sales opportunity number' }, { key: 'name', label: 'Opportunity', hint: 'Opportunity name in SAP' },
          { key: 'cardName', label: 'Customer', sub: 'cardCode', hint: 'Customer name and SAP business partner code' },
          { key: 'openValue', label: 'Potential', fmt: 'amt', hint: 'Potential amount of the opportunity' },
          { key: 'predDate', label: 'Expected close', fmt: 'date', hint: 'Predicted closing date in SAP' },
          { key: 'slipDays', label: 'Slipped (d)', fmt: 'int', hint: 'Days past the expected close date' }, ...tail] },
      { key: 'slp', label: 'By salesperson', rows: slpRows,
        desc: 'Follow-up workload per salesperson, most items to chase first; use it to assign today’s calls.',
        columns: [{ key: 'salesperson', label: 'Salesperson', hint: 'Sales employee on the documents' },
          { key: 'openQuotes', label: 'Open quotes', fmt: 'int', hint: 'Open quotations owned by this salesperson' },
          { key: 'quoteValue', label: 'Quote value', fmt: 'amt', hint: 'Open value of those quotations' },
          { key: 'quotesToChase', label: 'To chase', fmt: 'int', hint: 'Quotations that are expired, expiring or quiet' },
          { key: 'delayedOrders', label: 'Delayed SOs', fmt: 'int', hint: 'Sales orders past their delivery date' },
          { key: 'delayedValue', label: 'Delayed value', fmt: 'amt', hint: 'Open value of the delayed sales orders' },
          { key: 'opportunities', label: 'Opps to act', fmt: 'int', hint: 'Opportunities that slipped or went quiet' }] },
    ],
    notes: [
      `"Last touch" is the latest of: an SAP Activity on the document, an Activity for the customer after the document date, or the document's last update.`,
      noActivityData ? 'No Activities (OCLG) exist on this company yet.' : '',
    ].filter(Boolean),
    insight, aiContext,
  };
}

export function createSalesFollowupAgentRouter(deps) {
  return createInsightRouter(deps, {
    slug: 'salesfollowup', title: 'Sales Follow-up Agent',
    defaults: { quoteStaleDays: 7, activityGapDays: 7 },
    persona: 'You are a sales operations manager making sure no deal or order goes quiet in SAP Business One.',
    aiTask: 'Review these stale quotations, delayed sales orders and opportunities. Prioritise who each salesperson should contact today and what to say.',
    run,
    extra(router, h) {
      const findRow = (req, row) => {
        const last = h.lastFor(req);
        for (const t of last?.tabs || []) {
          const r = t.rows.find(x => x.kind === row?.kind && String(x.docNum) === String(row?.docNum));
          if (r) return r;
        }
        return null;
      };

      router.post('/draft-email', h.requireAuth, async (req, res) => {
        const r = findRow(req, req.body?.row);
        if (!r) return res.status(400).json({ ok: false, error: 'Document not in the current analysis — re-run Analyze.' });
        const what = r.kind === 'quote' ? `quotation #${r.docNum} dated ${r.docDate} (value ${fmtAmt(r.openValue)}, valid until ${r.validUntil})`
          : `sales order #${r.docNum} (open value ${fmtAmt(r.openValue)}, delivery date ${r.deliveryDate})`;
        const template = r.kind === 'quote'
          ? `Subject: Following up on our quotation #${r.docNum}\n\nDear ${r.contact || r.cardName} team,\n\nI wanted to follow up on our ${what}. Do you have any questions or need any changes to quantities, pricing or delivery terms?\n\n${r.status === 'EXPIRED' ? 'The quotation validity has lapsed, but we would be glad to refresh it for you. ' : ''}Could you let us know where things stand and when you expect to decide?\n\nKind regards,\n${r.salesperson || 'Sales team'}`
          : `Subject: Update on your order #${r.docNum}\n\nDear ${r.contact || r.cardName} team,\n\nThis is an update on your ${what}. ${r.daysLate ? 'We are sorry that delivery has slipped past the original date. ' : ''}We are confirming the delivery schedule and will share a firm date shortly. Please let us know if your requirement has changed.\n\nKind regards,\n${r.salesperson || 'Sales team'}`;
        const ai = await callAI(h.aiDeps(), [{ role: 'user', content: `Improve this B2B sales follow-up email: warm, specific, short, one clear call to action. Keep document numbers, dates and amounts exactly. Situation: ${r.action}. Return only the email starting with "Subject:".\n\n${template}` }],
          'You write concise B2B sales follow-up emails.', 600);
        res.json({ ok: true, title: `Follow-up email — ${r.cardName}`, text: ai || template, to: r.email });
      });

      router.post('/activity', h.requireAuth, async (req, res) => {
        try {
          const r = findRow(req, req.body?.row);
          if (!r) return res.status(400).json({ ok: false, error: 'Document not in the current analysis — re-run Analyze.' });
          const label = r.kind === 'quote' ? 'Quotation' : r.kind === 'order' ? 'Sales order' : 'Opportunity';
          const out = await createSapActivity(h.getActiveSap(), {
            cardCode: r.cardCode, kind: 'task', dueDate: addDays(todayISO(), 2),
            subject: `Follow up ${label} #${r.docNum} (${fmtAmt(r.openValue)})`,
            notes: `Sales Follow-up Agent — ${r.status} / priority ${r.priority}\n${r.action}\nLast touch ${r.lastTouch} (${r.daysSinceTouch} days quiet).`,
            docType: DOC_TYPE[r.kind], docEntry: r.docEntry,
          });
          res.json({ ok: true, message: `Follow-up activity ${out.activityCode ?? ''} created in SAP for ${r.cardName}. ${out.note || ''}` });
        } catch (e) { res.status(502).json({ ok: false, error: `SAP Service Layer: ${e.message}` }); }
      });
    },
  });
}

