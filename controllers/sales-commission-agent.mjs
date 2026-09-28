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

  const rateFor = (slpCode, salesperson, cardCode) => {
    if (custRules.has(String(cardCode).toUpperCase())) return { rate: custRules.get(String(cardCode).toUpperCase()), source: 'Customer rule' };
    const byName = slpRules.get(String(salesperson).toUpperCase()) ?? slpRules.get(String(slpCode).toUpperCase());
    if (byName !== undefined) return { rate: byName, source: 'Sales employee override' };
    const sap = sapRates.get(String(slpCode));
    if (sap > 0) return { rate: sap, source: 'SAP sales employee %' };
    return { rate: defaultRatePct, source: 'Default rate' };
  };

  // ── Build commissionable items ─────────────────────────────────────────────
  const detail = [];
  let excludedMargin = 0;
  const lines = await loadSalesLines(k, from, to);
  if (basis === 'collections') {
    for (const c of await loadCollections(k, from, to)) {
      const salesperson = slpNames.get(String(c.slpCode)) || '(none)';
      const { rate, source } = rateFor(c.slpCode, salesperson, c.cardCode);
      detail.push({ salesperson, cardCode: c.cardCode, cardName: c.cardName, docNum: c.docNum, date: c.payDate, ref: `Receipt ${c.payNum}`,
        basisAmount: round(c.net), rate, source, commission: round(c.net * rate / 100), note: `Collected ${fmtAmt(c.applied)} (net ${fmtAmt(c.net)})` });
    }
  } else {
    const byDoc = new Map();
    for (const l of lines) {
      const key = `${l.docType}:${l.docNum}`;
      const d = byDoc.get(key) || { l, revenue: 0, gp: 0, excluded: 0 };
      const lineMargin = l.revenue ? (l.gp / l.revenue) * 100 : 0;
      // Low-margin lines earn nothing. On the margin basis a loss-making line
      // is NOT excluded — its negative GP must still reduce the commission.
      const lowMargin = minMarginPct > 0 && l.sign > 0 && lineMargin < minMarginPct && !(basis === 'margin' && l.gp < 0);
      if (lowMargin) { const amt = basis === 'margin' ? l.gp : l.revenue; d.excluded += amt; excludedMargin += amt; }
      else { d.revenue += l.revenue; d.gp += l.gp; }
      byDoc.set(key, d);
    }
    for (const { l, revenue, gp, excluded } of byDoc.values()) {
      const amount = basis === 'margin' ? gp : revenue;
      const { rate, source } = rateFor(l.slpCode, l.salesperson, l.cardCode);
      detail.push({ salesperson: l.salesperson, cardCode: l.cardCode, cardName: l.cardName, docNum: l.docNum, date: l.date, ref: l.docType,
        basisAmount: round(amount), rate, source, commission: round(amount * rate / 100),
        note: [l.docType === 'Credit memo' ? 'Clawback' : '', excluded ? `${fmtAmt(excluded)} excluded (< ${minMarginPct}% margin)` : ''].filter(Boolean).join('; ') });
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
    const e = bySlp.get(d.salesperson) || { salesperson: d.salesperson, basisAmount: 0, commission: 0, docs: 0, customers: new Set(), sources: new Set(), clawback: 0 };
    e.basisAmount += d.basisAmount; e.commission += d.commission; e.docs++; e.customers.add(d.cardCode); e.sources.add(d.source);
    if (d.ref === 'Credit memo') e.clawback += d.commission;
    bySlp.set(d.salesperson, e);
  }
  const slpRows = [...bySlp.values()].map(e => {
    const pf = perf.get(e.salesperson) || { sales: 0, gp: 0 };
    return { salesperson: e.salesperson, sales: round(pf.sales), gp: round(pf.gp), marginPct: pf.sales ? round((pf.gp / pf.sales) * 100, 1) : null,
      basisAmount: round(e.basisAmount), effectiveRate: e.basisAmount ? round((e.commission / e.basisAmount) * 100, 2) : null,
      commission: round(e.commission), clawback: round(e.clawback), docs: e.docs, customers: e.customers.size, rateSources: [...e.sources].join(', ') };
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

  return {
    paramsOut: { basis, defaultRatePct: String(defaultRatePct), minMarginPct: String(minMarginPct), useSapRates: settings.useSapRates,
      salespersonRates: settings.salespersonRates, customerRules: settings.customerRules, fromDate: from },
    kpis: [
      { label: 'Commission payable', value: total, fmt: 'amt', tone: 'good' },
      { label: `Basis (${basis})`, value: basisTotal, fmt: 'amt' },
      { label: 'Effective rate', value: basisTotal ? (total / basisTotal) * 100 : null, fmt: 'pct' },
      { label: 'Sales employees', value: slpRows.length, fmt: 'int' },
      { label: 'Clawback (credit memos)', value: clawback, fmt: 'amt', tone: clawback ? 'warn' : undefined },
      { label: 'Excluded (low margin)', value: excludedMargin, fmt: 'amt' },
      { label: 'Custom rules', value: custRules.size + slpRules.size, fmt: 'int' },
    ],
    chart: { title: 'Commission by sales employee', type: 'bar', labels: slpRows.map(r => r.salesperson), series: [{ name: 'Commission', values: slpRows.map(r => r.commission) }] },
    tabs: [
      { key: 'slp', label: `By sales employee (${slpRows.length})`, rows: slpRows,
        columns: [{ key: 'salesperson', label: 'Sales employee' }, { key: 'sales', label: 'Net sales', fmt: 'amt' }, { key: 'gp', label: 'Gross profit', fmt: 'amt' },
          { key: 'marginPct', label: 'Margin', fmt: 'pct' }, { key: 'basisAmount', label: 'Commission basis', fmt: 'amt' }, { key: 'effectiveRate', label: 'Rate', fmt: 'pct' },
          { key: 'commission', label: 'Commission', fmt: 'amt', strong: true }, { key: 'clawback', label: 'Clawback', fmt: 'amt' },
          { key: 'docs', label: 'Docs', fmt: 'int' }, { key: 'rateSources', label: 'Rate source', wrap: true }] },
      { key: 'detail', label: `Detail (${detail.length})`, rows: detail,
        columns: [{ key: 'salesperson', label: 'Sales employee' }, { key: 'date', label: 'Date', fmt: 'date' }, { key: 'ref', label: 'Source', fmt: 'badge', badge: { Invoice: 'blue', 'Credit memo': 'amber' } },
          { key: 'docNum', label: 'Invoice #' }, { key: 'cardName', label: 'Customer', sub: 'cardCode' }, { key: 'basisAmount', label: 'Basis', fmt: 'amt' },
          { key: 'rate', label: 'Rate', fmt: 'pct' }, { key: 'source', label: 'Rate from' }, { key: 'commission', label: 'Commission', fmt: 'amt', strong: true }, { key: 'note', label: 'Note', wrap: true }] },
      { key: 'cust', label: `By customer (${custRows.length})`, rows: custRows,
        columns: [{ key: 'cardName', label: 'Customer', sub: 'cardCode' }, { key: 'salespeople', label: 'Sales employee(s)' }, { key: 'basisAmount', label: 'Basis', fmt: 'amt' },
          { key: 'rate', label: 'Rate', fmt: 'pct' }, { key: 'source', label: 'Rate from' }, { key: 'commission', label: 'Commission', fmt: 'amt', strong: true }] },
      { key: 'rules', label: `Rules (${ruleRows.length})`, rows: ruleRows,
        columns: [{ key: 'scope', label: 'Scope', fmt: 'badge', badge: { Customer: 'purple', 'Sales employee': 'blue', 'SAP (OSLP)': 'green', Default: 'grey' } },
          { key: 'key', label: 'Applies to' }, { key: 'rate', label: 'Rate', fmt: 'pct' }, { key: 'used', label: 'Documents matched', fmt: 'int' }] },
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
