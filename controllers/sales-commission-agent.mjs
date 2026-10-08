/**
 * Sales Commission Agent — mounted at /api/sales-commission-agent
 *
 * Calculates sales-employee commission for a period on one of three bases:
 *   sales        net invoiced revenue (credit memos claw back commission)
 *   collections  cash actually collected against invoices in the period
 *                (net of tax, pro-rata to each invoice)
 *   margin       gross profit on invoiced lines
 * Rate precedence per line: customer rule → sales-employee override →
 * SAP sales-employee commission % (OSLP.Commission) → default rate.
 * A customer rule of 0 excludes that customer. An optional minimum margin
 * excludes low-margin lines from sales/margin-based commission.
 * Rules are saved per company, so they persist between runs.
 */
import { createInsightRouter, AgentDataError, ctxTable, isoDate, addDays, num, round, clamp, fmtAmt } from '../lib/insight-kit.mjs';
import { loadSalesLines, loadSalesEmployees } from '../lib/insight-data.mjs';
import { agentSettingsRepo } from '../lib/insight-store.mjs';

const BASES = ['sales', 'collections', 'margin'];

// KPI drill-through (calc blocks → lib/insight-kit.mjs withKpiDetails).
const SRC = {
  oinv: 'OINV + INV1 — A/R invoices and lines: sales employee, customer, line total, gross-profit base price',
  orin: 'ORIN + RIN1 — A/R credit memos (claw back commission)',
  orct: 'ORCT + RCT2 — incoming payments applied to A/R invoices (amount applied, payment date)',
  vat: 'OINV — invoice total and tax amount (to take collections net of tax)',
  oslp: 'OSLP — sales employees and their commission % in SAP',
  rules: 'Commission rules saved in this agent (customer rules, sales-employee overrides, default rate)',
};

// "CUS001=3; CUS002 = 0, Devraj=2.5" → Map(UPPER key → rate)
function parseRules(text) {
  const map = new Map();
  for (const part of String(text || '').split(/[;,\n]+/)) {
    const m = part.match(/^\s*(.+?)\s*[=:]\s*(-?\d+(?:\.\d+)?)\s*%?\s*$/);
    if (m) map.set(m[1].trim().toUpperCase(), Number(m[2]));
  }
  return map;
}
const fmtRules = map => [...map].map(([k, v]) => `${k}=${v}`).join('; ');

async function loadSapRates(k) {
  if (!(await k.has('OSLP', 'Commission'))) return new Map();
  const rows = await k.run(`SELECT {SlpCode}, {Commission} FROM @OSLP`);
  return new Map(rows.map(r => [String(r.SlpCode), num(r.Commission)]));
}

// Incoming payments applied to A/R invoices in the period, with each
// invoice's net-of-tax ratio so commission is paid on net amounts.
async function loadCollections(k, from, to) {
  await k.need('ORCT', ['DocEntry', 'DocNum', 'DocDate', 'Canceled']);
  await k.need('RCT2', ['DocNum', 'DocEntry', 'InvType', 'SumApplied']);
  await k.need('OINV', ['DocEntry', 'DocNum', 'CardCode', 'CardName', 'SlpCode', 'DocTotal', 'VatSum', 'DocDate']);
  const rows = await k.run(`SELECT T0.{DocNum} AS {PayNum}, T0.{DocDate} AS {PayDate}, T2.{DocNum} AS {InvNum}, T2.{DocDate} AS {InvDate},
      T2.{CardCode} AS {CardCode}, T2.{CardName} AS {CardName}, T2.{SlpCode} AS {SlpCode}, T2.{DocTotal} AS {DocTotal}, T2.{VatSum} AS {VatSum},
      SUM(T1.{SumApplied}) AS {Applied}
    FROM @ORCT T0 INNER JOIN @RCT2 T1 ON T1.{DocNum} = T0.{DocEntry} INNER JOIN @OINV T2 ON T2.{DocEntry} = T1.{DocEntry}
    WHERE T1.{InvType} = '13' AND T0.{Canceled} = 'N' AND T0.{DocDate} >= ${k.lit(from)} AND T0.{DocDate} <= ${k.lit(to)}
    GROUP BY T0.{DocNum}, T0.{DocDate}, T2.{DocNum}, T2.{DocDate}, T2.{CardCode}, T2.{CardName}, T2.{SlpCode}, T2.{DocTotal}, T2.{VatSum}`);
  return rows.map(r => {
    const total = num(r.DocTotal);
    const netRatio = total > 0 ? (total - num(r.VatSum)) / total : 1;
    return { payNum: r.PayNum, payDate: isoDate(r.PayDate), docNum: r.InvNum, invDate: isoDate(r.InvDate), cardCode: r.CardCode, cardName: r.CardName || '',
      slpCode: r.SlpCode, applied: num(r.Applied), net: num(r.Applied) * netRatio };
  });
}

async function run(k, p) {
  const to = p.asOf;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(p.fromDate || '') ? p.fromDate : `${to.slice(0, 7)}-01`;
  if (from > to) throw new AgentDataError('From date must be on or before the period end.');

  // Persisted rules: a value sent with the request replaces the saved one;
  // "none" clears it.
  const saved = agentSettingsRepo.get(k.company, 'sales-commission');
  const pick = key => (p[key] !== undefined && p[key] !== '' ? (String(p[key]).trim().toLowerCase() === 'none' ? '' : String(p[key])) : saved[key] ?? '');
  const settings = {
    basis: BASES.includes(p.basis) ? p.basis : saved.basis || 'sales',
    defaultRatePct: p.defaultRatePct !== undefined && p.defaultRatePct !== '' ? num(p.defaultRatePct) : saved.defaultRatePct ?? 2,
    minMarginPct: p.minMarginPct !== undefined && p.minMarginPct !== '' ? num(p.minMarginPct) : saved.minMarginPct ?? 0,
    useSapRates: p.useSapRates ? p.useSapRates : saved.useSapRates || 'yes',
    salespersonRates: pick('salespersonRates'),
    customerRules: pick('customerRules'),
  };
  agentSettingsRepo.set(k.company, 'sales-commission', settings);
  const { basis, defaultRatePct, minMarginPct } = settings;
  const slpRules = parseRules(settings.salespersonRates);
  const custRules = parseRules(settings.customerRules);
  const slpNames = await loadSalesEmployees(k);
  const sapRates = settings.useSapRates === 'yes' ? await loadSapRates(k) : new Map();

  // Rate precedence: the first candidate that is set wins. The full list is
  // returned as `rules` so the UI can show why this rate applied.
  const rateFor = (slpCode, salesperson, cardCode) => {
    const cust = custRules.get(String(cardCode).toUpperCase());
    const byName = slpRules.get(String(salesperson).toUpperCase()) ?? slpRules.get(String(slpCode).toUpperCase());
    const sap = sapRates.get(String(slpCode));
    const cands = [
      { source: 'Customer rule', rate: cust, ok: cust !== undefined, rule: `1. Customer rule for ${cardCode}` },
      { source: 'Sales employee override', rate: byName, ok: byName !== undefined, rule: `2. Override for sales employee ${salesperson}` },
      { source: 'SAP sales employee %', rate: sap, ok: sap > 0,
        rule: `3. Commission % on the sales employee in SAP${settings.useSapRates === 'yes' ? '' : ' (switched off)'}` },
      { source: 'Default rate', rate: defaultRatePct, ok: true, rule: '4. Default rate' },
    ];
    const hit = cands.find(c => c.ok);
    return { rate: hit.rate, source: hit.source,
      rules: cands.map(c => ({ rule: c.rule, result: c.ok ? `${c.rate}%` : 'not set', hit: c === hit })) };
  };
  const basisName = { sales: 'Net sales', collections: 'Collected (net of tax)', margin: 'Gross profit' }[basis];
  const rateEx = (rules, rate) => ({ title: 'Commission rate', rules,
    note: rate === 0 ? 'A rate of 0 means this business earns no commission.' : 'The first rule that is set (top to bottom) gives the rate.' });
  const commEx = (steps, amount, rate, source, commission, note) => ({
    title: 'Commission',
    steps: [...steps, { label: `× Rate`, value: `${rate}%`, detail: `From: ${source}` }],
    result: { label: `Commission = ${basisName.toLowerCase()} × rate`, value: commission },
    note,
  });

  // ── Build commissionable items ─────────────────────────────────────────────
  const detail = [];
  let excludedMargin = 0;
  const lines = await loadSalesLines(k, from, to);
  if (basis === 'collections') {
    for (const c of await loadCollections(k, from, to)) {
      const salesperson = slpNames.get(String(c.slpCode)) || '(none)';
      const { rate, source, rules } = rateFor(c.slpCode, salesperson, c.cardCode);
      const commission = round(c.net * rate / 100);
      const cEx = commEx([
        { label: 'Payment applied to invoice', value: round(c.applied), detail: `Receipt ${c.payNum} on ${c.payDate}` },
        { label: 'Net of tax', formula: 'payment × (invoice total − tax) ÷ invoice total', value: round(c.net) },
      ], c.net, rate, source, commission, 'Commission is paid on cash collected, excluding tax.');
      detail.push({ salesperson, cardCode: c.cardCode, cardName: c.cardName, docNum: c.docNum, date: c.payDate, ref: `Receipt ${c.payNum}`,
        basisAmount: round(c.net), rate, source, commission, note: `Collected ${fmtAmt(c.applied)} (net ${fmtAmt(c.net)})`,
        explain: { commission: cEx, basisAmount: cEx, rate: rateEx(rules, rate) } });
    }
  } else {
    const byDoc = new Map();
    for (const l of lines) {
      const key = `${l.docType}:${l.docNum}`;
      const d = byDoc.get(key) || { l, revenue: 0, gp: 0, excluded: 0, nLines: 0, nExcluded: 0 };
      const lineMargin = l.revenue ? (l.gp / l.revenue) * 100 : 0;
      // Low-margin lines earn nothing. On the margin basis a loss-making line
      // is NOT excluded — its negative GP must still reduce the commission.
      const lowMargin = minMarginPct > 0 && l.sign > 0 && lineMargin < minMarginPct && !(basis === 'margin' && l.gp < 0);
      d.nLines++;
      if (lowMargin) { const amt = basis === 'margin' ? l.gp : l.revenue; d.excluded += amt; excludedMargin += amt; d.nExcluded++; }
      else { d.revenue += l.revenue; d.gp += l.gp; }
      byDoc.set(key, d);
    }
    for (const { l, revenue, gp, excluded, nLines, nExcluded } of byDoc.values()) {
      const amount = basis === 'margin' ? gp : revenue;
      const { rate, source, rules } = rateFor(l.slpCode, l.salesperson, l.cardCode);
      const commission = round(amount * rate / 100);
      const isCm = l.docType === 'Credit memo';
      const cEx = commEx([
        { label: `${basisName} on the ${isCm ? 'credit memo' : 'invoice'}`, formula: `sum of its ${nLines} line(s)`, value: round(amount + excluded) },
        ...(excluded ? [{ label: '− Low-margin lines', formula: `lines under ${minMarginPct}% margin earn nothing`, value: round(excluded), detail: `${nExcluded} line(s) excluded` }] : []),
        { label: '= Commission basis', value: round(amount) },
      ], amount, rate, source, commission,
      isCm ? 'Credit memo: the basis is negative, so commission is clawed back.'
        : basis === 'margin' ? 'Loss-making lines still count, so they reduce the commission.' : '');
      detail.push({ salesperson: l.salesperson, cardCode: l.cardCode, cardName: l.cardName, docNum: l.docNum, date: l.date, ref: l.docType,
        basisAmount: round(amount), rate, source, commission,
        note: [l.docType === 'Credit memo' ? 'Clawback' : '', excluded ? `${fmtAmt(excluded)} excluded (< ${minMarginPct}% margin)` : ''].filter(Boolean).join('; '),
        explain: { commission: cEx, basisAmount: cEx, rate: rateEx(rules, rate) } });
    }
  }
  detail.sort((a, z) => a.salesperson.localeCompare(z.salesperson) || String(a.date).localeCompare(String(z.date)));

  // ── Aggregate ──────────────────────────────────────────────────────────────
  const bySlp = new Map();
  const perf = new Map();
  for (const l of lines) {
    const e = perf.get(l.salesperson) || { sales: 0, gp: 0 };
    e.sales += l.revenue; e.gp += l.gp; perf.set(l.salesperson, e);
  }
  for (const d of detail) {
    const e = bySlp.get(d.salesperson) || { salesperson: d.salesperson, basisAmount: 0, commission: 0, docs: 0, customers: new Set(), sources: new Set(), clawback: 0, bySource: new Map(), cms: 0 };
    e.basisAmount += d.basisAmount; e.commission += d.commission; e.docs++; e.customers.add(d.cardCode); e.sources.add(d.source);
    if (d.ref === 'Credit memo') { e.clawback += d.commission; e.cms++; }
    const g = e.bySource.get(d.source) || { basis: 0, commission: 0, docs: 0, rates: new Set() };
    g.basis += d.basisAmount; g.commission += d.commission; g.docs++; g.rates.add(d.rate); e.bySource.set(d.source, g);
    bySlp.set(d.salesperson, e);
  }
  const slpRows = [...bySlp.values()].map(e => {
    const pf = perf.get(e.salesperson) || { sales: 0, gp: 0 };
    const row = { salesperson: e.salesperson, sales: round(pf.sales), gp: round(pf.gp), marginPct: pf.sales ? round((pf.gp / pf.sales) * 100, 1) : null,
      basisAmount: round(e.basisAmount), effectiveRate: e.basisAmount ? round((e.commission / e.basisAmount) * 100, 2) : null,
      commission: round(e.commission), clawback: round(e.clawback), docs: e.docs, customers: e.customers.size, rateSources: [...e.sources].join(', ') };
    const srcSteps = [...e.bySource].map(([src, g]) => ({ label: src, formula: `basis × ${[...g.rates].map(r => `${r}%`).join(' / ')}`,
      value: round(g.commission), detail: `${g.docs} document(s), basis ${fmtAmt(g.basis)}` }));
    row.explain = {
      commission: { title: 'Commission', steps: srcSteps, result: { label: 'Commission = sum over all documents', value: row.commission },
        note: `Grouped by where the rate came from. ${e.cms ? `Includes ${fmtAmt(Math.abs(row.clawback))} clawed back on ${e.cms} credit memo(s).` : 'See the Detail tab for each document.'}` },
      effectiveRate: row.effectiveRate == null ? undefined : { title: 'Effective rate',
        steps: [{ label: 'Commission', value: row.commission }, { label: `Commission basis (${basisName.toLowerCase()})`, value: row.basisAmount }],
        result: { label: 'Effective rate = commission ÷ basis', value: `${row.effectiveRate}%` },
        note: 'An average across all documents, which may use different rates.' },
      clawback: { title: 'Clawback',
        steps: [{ label: 'Credit memos in the period', value: e.cms }],
        result: { label: 'Clawback = commission on credit memos', value: row.clawback },
        note: 'Credit memos reverse sales, so they reduce commission (shown as a negative amount).' },
    };
    if (!row.explain.effectiveRate) delete row.explain.effectiveRate;
    return row;
  }).sort((a, z) => z.commission - a.commission);
  const byCust = new Map();
  for (const d of detail) {
    const e = byCust.get(d.cardCode) || { cardCode: d.cardCode, cardName: d.cardName, basisAmount: 0, commission: 0, rate: d.rate, source: d.source, salespeople: new Set() };
    e.basisAmount += d.basisAmount; e.commission += d.commission; e.salespeople.add(d.salesperson); byCust.set(d.cardCode, e);
  }
  const custRows = [...byCust.values()].map(e => ({ ...e, basisAmount: round(e.basisAmount), commission: round(e.commission), salespeople: [...e.salespeople].join(', ') })).sort((a, z) => z.commission - a.commission);

  const ruleRows = [
    ...[...custRules].map(([code, rate]) => ({ scope: 'Customer', key: code, rate, used: detail.filter(d => String(d.cardCode).toUpperCase() === code).length })),
    ...[...slpRules].map(([name, rate]) => ({ scope: 'Sales employee', key: name, rate, used: detail.filter(d => d.source === 'Sales employee override' && (d.salesperson.toUpperCase() === name)).length })),
    ...[...sapRates].filter(([, r]) => r > 0).map(([code, rate]) => ({ scope: 'SAP (OSLP)', key: slpNames.get(code) || code, rate, used: detail.filter(d => d.source === 'SAP sales employee %' && d.salesperson === (slpNames.get(code) || code)).length })),
    { scope: 'Default', key: 'All others', rate: defaultRatePct, used: detail.filter(d => d.source === 'Default rate').length },
  ];

  const total = slpRows.reduce((s, r) => s + r.commission, 0);
  const basisTotal = slpRows.reduce((s, r) => s + r.basisAmount, 0);
  const clawback = slpRows.reduce((s, r) => s + r.clawback, 0);
  const noSlp = slpRows.find(r => r.salesperson === '(none)' || /no sales employee/i.test(r.salesperson));
  const unusedRules = ruleRows.filter(r => r.scope !== 'Default' && r.scope !== 'SAP (OSLP)' && r.used === 0);
  const basisLabel = { sales: 'net sales', collections: 'collections (net of tax)', margin: 'gross profit' }[basis];

  const insight = `**Commission payable ${fmtAmt(total)} on ${fmtAmt(basisTotal)} of ${basisLabel}, ${from} → ${to} (effective ${basisTotal ? round((total / basisTotal) * 100, 2) : 0}%).**\n\n` +
    slpRows.slice(0, 5).map(r => `- **${r.salesperson}**: ${fmtAmt(r.commission)} on ${fmtAmt(r.basisAmount)} (${r.effectiveRate ?? 0}%)${r.clawback ? `, incl. ${fmtAmt(r.clawback)} clawback` : ''}.`).join('\n') + '\n' +
    (noSlp && noSlp.basisAmount ? `- ${fmtAmt(noSlp.basisAmount)} of ${basisLabel} has **no sales employee** on the document, earning ${fmtAmt(noSlp.commission)} at the default rate — assign owners or add a rule.\n` : '') +
    (excludedMargin ? `- ${fmtAmt(excludedMargin)} excluded because line margin was below ${minMarginPct}%.\n` : '') +
    (unusedRules.length ? `- ${unusedRules.length} rule(s) applied to no documents this period (no matching sales, or a customer rule took priority): ${unusedRules.map(r => r.key).join(', ')}.\n` : '');

  const aiContext = `SALES COMMISSION ${from} to ${to}. Basis: ${basisLabel}. Default rate ${defaultRatePct}%, min margin ${minMarginPct}%, SAP rates ${settings.useSapRates}.
Rules — customers: ${fmtRules(custRules) || 'none'}; sales employees: ${fmtRules(slpRules) || 'none'}.
Total commission ${fmtAmt(total)} on ${fmtAmt(basisTotal)}; clawback ${fmtAmt(clawback)}; margin-excluded ${fmtAmt(excludedMargin)}.
BY SALES EMPLOYEE:
${ctxTable(slpRows, [['salesperson', 'Slp'], ['sales', 'Sales'], ['gp', 'GP'], ['marginPct', 'GM%'], ['basisAmount', 'Basis'], ['effectiveRate', 'Rate%'], ['commission', 'Commission'], ['clawback', 'Clawback']], 20)}
TOP CUSTOMERS:
${ctxTable(custRows, [['cardName', 'Customer'], ['basisAmount', 'Basis'], ['rate', 'Rate'], ['source', 'Source'], ['commission', 'Commission']], 12)}`;

  const basisStep = {
    sales: 'Net sales = invoice line totals after discounts, less credit memos.',
    collections: 'Collected = incoming payments dated in the period applied to A/R invoices × (invoice total − tax) ÷ invoice total; the sales employee comes from the invoice.',
    margin: 'Gross profit = invoice line totals − cost (gross-profit base price, else item cost) × quantity, less credit memos.',
  }[basis];
  const basisSources = basis === 'collections' ? [SRC.orct, SRC.vat, SRC.rules] : [SRC.oinv, SRC.orin, SRC.rules];
  const slpCol = { key: 'salesperson', label: 'Sales employee', hint: 'Sales employee on the invoice header ("(none)" if not set).' };
  const custCol = { key: 'cardName', label: 'Customer', sub: 'cardCode', hint: 'Customer name with its business-partner code.' };
  const docsCol = { key: 'docs', label: 'Docs', fmt: 'int', hint: basis === 'collections' ? 'Number of payment-to-invoice applications.' : 'Number of invoices and credit memos.' };
  const rateCol = { key: 'rate', label: 'Rate', fmt: 'pct', hint: 'Commission % applied.' };
  const rateFromCol = { key: 'source', label: 'Rate from', hint: 'Which rule gave the rate: customer rule, sales-employee override, SAP sales-employee % or default.' };

  return {
    paramsOut: { basis, defaultRatePct: String(defaultRatePct), minMarginPct: String(minMarginPct), useSapRates: settings.useSapRates,
      salespersonRates: settings.salespersonRates, customerRules: settings.customerRules, fromDate: from },
    kpis: [
      { label: 'Commission payable', value: total, fmt: 'amt', tone: 'good', hint: `Total commission earned in the period on ${basisLabel}`,
        calc: { formula: `Commission = Σ per document: ${basisName.toLowerCase()} × commission rate; rate = customer rule → sales-employee override → SAP sales-employee % → default ${defaultRatePct}%.`,
          steps: [basisStep, 'Credit memos have a negative basis, so they claw commission back.', 'A customer rule of 0% excludes that customer.'],
          sources: basisSources, tab: 'slp', sortBy: 'commission',
          stats: [{ label: 'Commission basis', value: round(basisTotal), fmt: 'amt' }, { label: 'Effective rate', value: basisTotal ? round((total / basisTotal) * 100, 2) : 0, fmt: 'pct' },
            { label: 'Clawback', value: round(clawback), fmt: 'amt' }, { label: 'Top earner', value: slpRows[0] ? `${slpRows[0].salesperson} (${fmtAmt(slpRows[0].commission)})` : '—' }] } },
      { label: `Basis (${basis})`, value: basisTotal, fmt: 'amt', hint: `The amount commission is calculated on: ${basisLabel}`,
        calc: { formula: `Basis = Σ ${basisName.toLowerCase()} per document, ${from} → ${to}.`, steps: [basisStep, ...(basis !== 'collections' && minMarginPct > 0 ? [`Lines under ${minMarginPct}% margin are left out of the basis.`] : [])],
          sources: basisSources, tab: 'detail', sortBy: 'basisAmount',
          stats: [{ label: 'Documents', value: detail.length, fmt: 'int' }, { label: 'Net sales (all lines)', value: round(lines.reduce((s, l) => s + l.revenue, 0)), fmt: 'amt' },
            { label: 'Gross profit (all lines)', value: round(lines.reduce((s, l) => s + l.gp, 0)), fmt: 'amt' }, { label: 'Excluded (low margin)', value: round(excludedMargin), fmt: 'amt' }] } },
      { label: 'Effective rate', value: basisTotal ? (total / basisTotal) * 100 : null, fmt: 'pct', hint: 'Average commission rate actually paid = commission ÷ basis',
        calc: { formula: 'Effective rate = total commission ÷ total commission basis × 100.', steps: ['A blend of all rates used; customer rules and overrides pull it away from the default.'],
          sources: [SRC.rules, SRC.oslp], tab: 'slp', sortBy: 'effectiveRate',
          stats: [{ label: 'Commission', value: round(total), fmt: 'amt' }, { label: 'Basis', value: round(basisTotal), fmt: 'amt' },
            { label: 'Default rate', value: defaultRatePct, fmt: 'pct' }, ...ruleRows.filter(r => r.used).slice(0, 2).map(r => ({ label: `${r.scope}: ${r.key}`, value: r.rate, fmt: 'pct' }))] } },
      { label: 'Sales employees', value: slpRows.length, fmt: 'int', hint: 'Sales employees with commissionable documents in the period',
        calc: { formula: 'Count of distinct sales employees on the commissionable documents (including "(none)" when no employee is set).',
          sources: [SRC.oslp, ...basisSources.slice(0, 1)], tab: 'slp', sortBy: 'commission',
          stats: [{ label: 'With commission > 0', value: slpRows.filter(r => r.commission > 0).length, fmt: 'int' }, { label: 'With clawback', value: slpRows.filter(r => r.clawback).length, fmt: 'int' },
            { label: 'Basis without sales employee', value: noSlp ? noSlp.basisAmount : 0, fmt: 'amt' }] } },
      { label: 'Clawback (credit memos)', value: clawback, fmt: 'amt', tone: clawback ? 'warn' : undefined, hint: 'Commission reversed because sales were credited back',
        calc: { formula: 'Clawback = Σ commission on A/R credit memos in the period (negative basis × rate).',
          steps: [basis === 'collections' ? 'On the collections basis there are no credit-memo clawbacks — commission follows cash received.' : 'Each credit memo uses the same rate rules as an invoice.'],
          sources: [SRC.orin, SRC.rules], tab: 'detail', filter: d => d.ref === 'Credit memo', sortBy: 'commission',
          stats: [{ label: 'Credit memos', value: detail.filter(d => d.ref === 'Credit memo').length, fmt: 'int' },
            { label: 'Credited basis', value: round(detail.filter(d => d.ref === 'Credit memo').reduce((s, d) => s + d.basisAmount, 0)), fmt: 'amt' },
            { label: 'Sales employees affected', value: slpRows.filter(r => r.clawback).length, fmt: 'int' }] } },
      { label: 'Excluded (low margin)', value: excludedMargin, fmt: 'amt', hint: minMarginPct > 0 ? `Basis left out because line margin was under ${minMarginPct}%` : 'No minimum margin set — nothing excluded',
        calc: { formula: minMarginPct > 0 ? `Σ ${basis === 'margin' ? 'gross profit' : 'net sales'} of invoice lines whose margin is under ${minMarginPct}%; these lines earn no commission.` : 'Minimum margin is 0%, so no lines are excluded.',
          steps: ['Does not apply on the collections basis.', 'On the margin basis, loss-making lines are kept so they reduce commission.'],
          sources: [SRC.oinv], tab: 'detail', filter: d => /excluded/.test(d.note || ''), sortBy: 'basisAmount',
          stats: [{ label: 'Minimum margin', value: minMarginPct, fmt: 'pct' }, { label: 'Documents with exclusions', value: detail.filter(d => /excluded/.test(d.note || '')).length, fmt: 'int' },
            { label: 'Commission saved (at default rate)', value: round(excludedMargin * defaultRatePct / 100), fmt: 'amt' }] } },
      { label: 'Custom rules', value: custRules.size + slpRules.size, fmt: 'int', hint: 'Customer rules + sales-employee overrides saved in this agent',
        calc: { formula: 'Count of customer rules + sales-employee rate overrides entered in the options.',
          steps: ['Rules are saved per company and reload automatically.', 'A rule with "Documents matched" = 0 did not apply this period.'],
          sources: [SRC.rules, SRC.oslp], tab: 'rules', sortBy: 'used', chart: null,
          stats: [{ label: 'Customer rules', value: custRules.size, fmt: 'int' }, { label: 'Sales-employee overrides', value: slpRules.size, fmt: 'int' },
            { label: 'Rules unused this period', value: unusedRules.length, fmt: 'int' }, { label: 'Documents at default rate', value: detail.filter(d => d.source === 'Default rate').length, fmt: 'int' }] } },
    ],
    chart: { title: 'Commission by sales employee', type: 'bar', labels: slpRows.map(r => r.salesperson), series: [{ name: 'Commission', values: slpRows.map(r => r.commission) }],
      desc: 'Each bar is the net commission earned by one sales employee in the period (after clawbacks), highest first.' },
    tabs: [
      { key: 'slp', label: `By sales employee (${slpRows.length})`, rows: slpRows,
        desc: 'Commission statement per sales employee with their sales and margin — click Commission or Rate to see how it was built.',
        columns: [slpCol, { key: 'sales', label: 'Net sales', fmt: 'amt', hint: 'Invoiced sales less credit memos in the period, after discounts.' },
          { key: 'gp', label: 'Gross profit', fmt: 'amt', hint: 'Net sales − cost of sales.' },
          { key: 'marginPct', label: 'Margin', fmt: 'pct', hint: 'Gross profit ÷ net sales × 100.' },
          { key: 'basisAmount', label: 'Commission basis', fmt: 'amt', hint: `The amount commission is paid on (${basisLabel}), after any low-margin exclusions.` },
          { key: 'effectiveRate', label: 'Rate', fmt: 'pct', hint: 'Effective rate = commission ÷ commission basis × 100.' },
          { key: 'commission', label: 'Commission', fmt: 'amt', strong: true, hint: 'Σ basis × rate over all documents, after clawbacks.' },
          { key: 'clawback', label: 'Clawback', fmt: 'amt', hint: 'Commission reversed on credit memos (negative).' },
          docsCol, { key: 'rateSources', label: 'Rate source', wrap: true, hint: 'Where the rates came from: customer rule, override, SAP sales-employee % or default.' }] },
      { key: 'detail', label: `Detail (${detail.length})`, rows: detail,
        desc: 'Every document that earned or reversed commission — use it to check a sales employee’s statement line by line.',
        columns: [slpCol, { key: 'date', label: 'Date', fmt: 'date', hint: basis === 'collections' ? 'Payment date.' : 'Document posting date.' },
          { key: 'ref', label: 'Source', fmt: 'badge', badge: { Invoice: 'blue', 'Credit memo': 'amber' }, hint: 'Invoice, credit memo (clawback) or the incoming payment receipt.' },
          { key: 'docNum', label: 'Invoice #', hint: 'SAP document number of the invoice or credit memo.' }, custCol,
          { key: 'basisAmount', label: 'Basis', fmt: 'amt', hint: `Commission basis for this document (${basisLabel}).` },
          rateCol, rateFromCol, { key: 'commission', label: 'Commission', fmt: 'amt', strong: true, hint: 'Commission = basis × rate.' },
          { key: 'note', label: 'Note', wrap: true, hint: 'Clawbacks, low-margin exclusions or collection details.' }] },
      { key: 'cust', label: `By customer (${custRows.length})`, rows: custRows,
        desc: 'Commission paid per customer and the rate used — check that special customer rules are working.',
        columns: [custCol, { key: 'salespeople', label: 'Sales employee(s)', hint: 'Sales employees who earned commission on this customer.' },
          { key: 'basisAmount', label: 'Basis', fmt: 'amt', hint: `Σ commission basis (${basisLabel}) for this customer.` },
          rateCol, rateFromCol, { key: 'commission', label: 'Commission', fmt: 'amt', strong: true, hint: 'Σ commission earned on this customer.' }] },
      { key: 'rules', label: `Rules (${ruleRows.length})`, rows: ruleRows,
        desc: 'All commission rates in force and how many documents each matched — rules with 0 matches did not apply this period.',
        columns: [{ key: 'scope', label: 'Scope', fmt: 'badge', badge: { Customer: 'purple', 'Sales employee': 'blue', 'SAP (OSLP)': 'green', Default: 'grey' }, hint: 'Rule level; precedence is Customer → Sales employee → SAP → Default.' },
          { key: 'key', label: 'Applies to', hint: 'Customer code or sales employee the rule is for.' },
          { key: 'rate', label: 'Rate', fmt: 'pct', hint: 'Commission % for this rule (0 = no commission).' },
          { key: 'used', label: 'Documents matched', fmt: 'int', hint: 'Number of documents in the period where this rule set the rate.' }] },
    ],
    notes: [
      `Rate precedence: customer rule → sales-employee override → SAP sales-employee commission % ${settings.useSapRates === 'yes' ? '(on)' : '(off)'} → default ${defaultRatePct}%. A customer rule of 0 excludes that customer.`,
      basis === 'collections' ? 'Collections basis: incoming payments dated in the period applied to A/R invoices, net of tax pro-rata; the salesperson is taken from the invoice. The minimum-margin rule does not apply on this basis.'
        : `${basis === 'sales' ? 'Net sales' : 'Gross profit'} from A/R invoices less credit memos (credit memos claw back commission)${minMarginPct > 0 ? `; lines under ${minMarginPct}% margin earn no commission` : ''}.`,
      'Rules are saved for this company and reload automatically. Enter "none" in a rules box to clear it. Rule format: CODE=rate; e.g. CUS00001=3; CUS00002=0 or Devraj=2.5.',
    ],
    insight, aiContext,
  };
}

export function createSalesCommissionAgentRouter(deps) {
  return createInsightRouter(deps, {
    slug: 'commission', title: 'Sales Commission Agent',
    persona: 'You are a sales-compensation analyst calculating commissions from SAP Business One data.',
    aiTask: 'Review this commission calculation. Summarise what each sales employee earns and why, flag anomalies (unassigned sales, clawbacks, rules that did not apply, commission on low-margin business), and suggest plan improvements.',
    run,
  });
}
