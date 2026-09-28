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

function priorityOf(value, maxValue, daysSinceTouch, bonus) {
  const s = 50 * Math.sqrt(value / Math.max(1, maxValue)) + 30 * Math.min(1, daysSinceTouch / 30) + bonus;
  return { priorityScore: Math.round(s), priority: s >= 55 ? 'HIGH' : s >= 30 ? 'MEDIUM' : 'LOW' };
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
    let status = 'OK', action = 'On track', bonus = 0;
    if (r.scheduledFor && r.scheduledFor >= asOf) { status = 'SCHEDULED'; action = `Follow-up already scheduled for ${r.scheduledFor}`; }
    else if (toExpiry < -60) { status = 'EXPIRED'; action = `Expired ${-toExpiry}d ago — close as lost (record the loss reason) unless the customer confirms interest`; }
    else if (toExpiry < 0) { status = 'EXPIRED'; bonus = 10; action = `Expired ${-toExpiry}d ago — call to revive with a refreshed quote, or close as lost`; }
    else if (toExpiry <= 3) { status = 'EXPIRING'; bonus = 20; action = `Valid for ${toExpiry} more day(s) — push for a decision now`; }
    else if (r.age >= quoteStale && r.daysSinceTouch >= gap) { status = 'FOLLOW UP'; bonus = 10; action = `No contact for ${r.daysSinceTouch} days — call to confirm decision timeline and objections`; }
    return { ...r, validUntil: q.dueDate, toExpiry, status, action, ...priorityOf(r.openValue, maxQ, r.daysSinceTouch, bonus) };
  });

  const maxO = Math.max(1, ...orders.map(o => o.openValue));
  const orderRows = orders.map(o => {
    const r = base('order', o);
    const late = daysBetween(o.dueDate, asOf);
    let status = 'OK', action = 'On track', bonus = 0;
    if (late > 180) { status = 'DELAYED'; bonus = 5; action = `Open ${late}d past delivery date — confirm the customer still needs it; otherwise close the order to release stock and credit`; }
    else if (late > 0) { status = 'DELAYED'; bonus = 20; action = `Delivery date passed ${late}d ago — give the customer a firm new date`; }
    else if (r.scheduledFor && r.scheduledFor >= asOf) { status = 'SCHEDULED'; action = `Follow-up scheduled for ${r.scheduledFor}`; }
    else if (r.age >= 14 && r.daysSinceTouch >= gap) { status = 'FOLLOW UP'; bonus = 5; action = `Open ${r.age} days with no contact for ${r.daysSinceTouch} — confirm delivery schedule`; }
    return { ...r, deliveryDate: o.dueDate, daysLate: Math.max(0, late), status, action, ...priorityOf(r.openValue, maxO, r.daysSinceTouch, bonus) };
  });

  const maxOp = Math.max(1, ...opps.map(o => o.value));
  const oppRows = opps.map(o => {
    const slip = o.predDate ? daysBetween(o.predDate, asOf) : 0;
    const cardAct = acts.byCard.get(o.cardCode);
    const lastTouch = [cardAct && cardAct >= o.openDate ? cardAct : null, o.openDate].filter(Boolean).sort().pop();
    const since = daysBetween(lastTouch, asOf) ?? 0;
    const status = slip > 0 ? 'DELAYED' : since >= gap ? 'FOLLOW UP' : 'OK';
    return {
      kind: 'opportunity', docNum: o.id, name: o.name, cardCode: o.cardCode, cardName: o.cardName, openValue: round(o.value),
      predDate: o.predDate, slipDays: Math.max(0, slip), lastTouch, daysSinceTouch: since,
      salesperson: slp.get(String(o.slpCode)) || '', status,
      action: slip > 180 ? `Expected close slipped ${slip}d — close as lost or re-open with a new plan` : slip > 0 ? `Expected close slipped ${slip}d — re-qualify and set a new close date` : status === 'FOLLOW UP' ? `No contact for ${since} days — schedule next step` : 'On track',
      ...priorityOf(o.value, maxOp, since, slip > 0 ? 20 : 0),
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
  const common = [
    { key: 'priority', label: 'Priority', fmt: 'badge' }, { key: 'status', label: 'Status', fmt: 'badge' },
    { key: 'docNum', label: 'Doc #' }, { key: 'cardName', label: 'Customer', sub: 'cardCode' },
    { key: 'openValue', label: 'Open value', fmt: 'amt' },
  ];
  const tail = [
    { key: 'lastTouch', label: 'Last touch', fmt: 'date' }, { key: 'daysSinceTouch', label: 'Quiet (days)', fmt: 'int' },
    { key: 'salesperson', label: 'Salesperson' }, { key: 'action', label: 'Recommended follow-up', wrap: true },
  ];

  return {
    kpis: [
      { label: 'Open quotations', value: quoteRows.length, fmt: 'int' },
      { label: 'Quotes to chase', value: qNeed.length, fmt: 'int', tone: qNeed.length ? 'warn' : 'good' },
      { label: 'Quote value at stake', value: quoteValueAtRisk, fmt: 'amt' },
      { label: 'Expired quotes', value: quoteRows.filter(r => r.status === 'EXPIRED').length, fmt: 'int', tone: 'warn' },
      { label: 'Open sales orders', value: orderRows.length, fmt: 'int' },
      { label: 'Delayed orders', value: delayed.length, fmt: 'int', tone: delayed.length ? 'bad' : 'good' },
      { label: 'Delayed order value', value: delayedValue, fmt: 'amt', tone: delayedValue ? 'bad' : 'good' },
      { label: 'Opportunities to act', value: opNeed.length, fmt: 'int' },
    ],
    tabs: [
      { key: 'quotes', label: `Quotations (${qNeed.length})`, rows: qNeed, rowKey: 'docEntry', actions,
        columns: [...common, { key: 'docDate', label: 'Quoted', fmt: 'date' }, { key: 'validUntil', label: 'Valid until', fmt: 'date' }, ...tail] },
      { key: 'orders', label: `Sales orders (${oNeed.length})`, rows: oNeed, rowKey: 'docEntry', actions,
        columns: [...common, { key: 'deliveryDate', label: 'Delivery date', fmt: 'date' }, { key: 'daysLate', label: 'Days late', fmt: 'int' }, ...tail] },
      { key: 'opps', label: `Opportunities (${opNeed.length})`, rows: opNeed, rowKey: 'docNum',
        actions: [actions[1]],
        columns: [{ key: 'priority', label: 'Priority', fmt: 'badge' }, { key: 'status', label: 'Status', fmt: 'badge' },
          { key: 'docNum', label: 'Opp #' }, { key: 'name', label: 'Opportunity' }, { key: 'cardName', label: 'Customer', sub: 'cardCode' },
          { key: 'openValue', label: 'Potential', fmt: 'amt' }, { key: 'predDate', label: 'Expected close', fmt: 'date' },
          { key: 'slipDays', label: 'Slipped (d)', fmt: 'int' }, ...tail] },
      { key: 'slp', label: 'By salesperson', rows: slpRows,
        columns: [{ key: 'salesperson', label: 'Salesperson' }, { key: 'openQuotes', label: 'Open quotes', fmt: 'int' },
          { key: 'quoteValue', label: 'Quote value', fmt: 'amt' }, { key: 'quotesToChase', label: 'To chase', fmt: 'int' },
          { key: 'delayedOrders', label: 'Delayed SOs', fmt: 'int' }, { key: 'delayedValue', label: 'Delayed value', fmt: 'amt' },
          { key: 'opportunities', label: 'Opps to act', fmt: 'int' }] },
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

