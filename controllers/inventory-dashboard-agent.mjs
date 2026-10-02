/**
 * Inventory Dashboard & Reports — mounted at /api/inventory-dashboard
 *
 * SAP B1 style stock reporting straight off the inventory journal (OINM)
 * through DB Direct (MSSQL or HANA). OINM is the source of truth for every
 * quantity and value here — its all-time sum reconciles exactly to OITW
 * OnHand / stock value — so opening, in, out and closing always tie out.
 *
 *   GET  /filters       warehouses, item groups, branches (+ whether branches are enabled)
 *   GET  /items?q=      item code / name lookup for the filter box
 *   POST /report        { report, fromDate, toDate, itemCode, itemName, warehouses[], itemGroups[], branches[], ... }
 *        report = dashboard | stock | transactions | posting | valuation | aging | deadstock | profit
 *   POST /drill         { kind:'profitDocs' | 'itemTrans', itemCode, whsCode?, ...filters }
 *
 * Values: OINM.TransValue is the signed change in stock value (in > 0, out < 0),
 * so In value = positive TransValue, Out value = −negative TransValue. Profit
 * uses the A/R invoice / credit memo lines: revenue = LineTotal after header
 * discount, cost = LineTotal − GrssProfit (SAP's own gross-profit base).
 */
import { Router } from 'express';
import { sqlKit, AgentDataError, isoDate, num, round, todayISO, addDays, daysBetween } from '../lib/insight-kit.mjs';

// ── SAP B1 transaction types (OINM.TransType) ─────────────────────────────────
export const TRANS_NAMES = {
  13: 'A/R Invoice', 14: 'A/R Credit Memo', 15: 'Delivery', 16: 'Sales Return',
  18: 'A/P Invoice', 19: 'A/P Credit Memo', 20: 'Goods Receipt PO', 21: 'Goods Return',
  58: 'Stock Update', 59: 'Goods Receipt', 60: 'Goods Issue', 67: 'Inventory Transfer',
  68: 'Work Instructions', 69: 'Landed Costs', 162: 'Inventory Revaluation', 163: 'A/P Correction Invoice',
  164: 'A/P Correction Reversal', 165: 'A/R Correction Invoice', 166: 'A/R Correction Reversal',
  202: 'Production Order', 203: 'A/R Down Payment', 204: 'A/P Down Payment',
  10000071: 'Inventory Posting', 310000001: 'Opening Balance', 1250000001: 'Transfer Request',
  1470000049: 'Capitalization', 1470000060: 'Capitalization Credit Memo', 1470000065: 'Inventory Counting',
  1470000071: 'Inventory Posting',
};
export const transName = t => TRANS_NAMES[Number(t)] || `Trans. ${t}`;

// Consumption = stock leaving for a customer or production (dead-stock "last used").
const CONSUME_TYPES = [13, 15, 60, 202];
const AGE_BUCKETS = [
  { key: '0-30', max: 30 }, { key: '31-60', max: 60 }, { key: '61-90', max: 90 },
  { key: '91-180', max: 180 }, { key: '181-365', max: 365 }, { key: '>365', max: Infinity },
];
const MAX_TRANS_ROWS = 25000;
const MAX_POSTING_DOCS = 20000;

const lc = s => String(s ?? '').trim();
const firstOfYear = () => `${new Date().getFullYear()}-01-01`;
const keyIW = (i, w) => `${i}\u0001${w}`;

// ── Request → normalised params ───────────────────────────────────────────────
function readParams(body = {}) {
  const arr = v => (Array.isArray(v) ? v : lc(v) ? String(v).split(',') : []).map(lc).filter(Boolean);
  const p = {
    report:     lc(body.report) || 'dashboard',
    fromDate:   isoDate(body.fromDate) || firstOfYear(),
    toDate:     isoDate(body.toDate) || todayISO(),
    itemCode:   lc(body.itemCode),
    itemName:   lc(body.itemName),
    warehouses: arr(body.warehouses),
    itemGroups: arr(body.itemGroups).map(Number).filter(Number.isFinite),
    branches:   arr(body.branches).map(Number).filter(Number.isFinite),
    deadDays:   Math.min(1500, Math.max(30, Math.round(num(body.deadDays) || 180))),
    slowDays:   Math.min(1000, Math.max(15, Math.round(num(body.slowDays) || 90))),
    includeZero: !!body.includeZero,
  };
  if (p.slowDays >= p.deadDays) p.slowDays = Math.max(15, Math.floor(p.deadDays / 2));
  if (p.fromDate > p.toDate) [p.fromDate, p.toDate] = [p.toDate, p.fromDate];
  return p;
}

// ── Master data (cached per company for 10 minutes) ──────────────────────────
const _master = new Map();
async function loadMaster(k) {
  const hit = _master.get(k.company);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.data;

  await k.need('OITM', ['ItemCode', 'ItemName', 'ItmsGrpCod', 'InvntItem', 'AvgPrice', 'LastPurPrc']);
  const optItem = { uom: await k.has('OITM', 'InvntryUom'), eval: await k.has('OITM', 'EvalSystem') };
  const itemRows = await k.run(`SELECT {ItemCode}, {ItemName}, {ItmsGrpCod}, {AvgPrice}, {LastPurPrc}
    ${optItem.uom ? ', {InvntryUom}' : ''}${optItem.eval ? ', {EvalSystem}' : ''} FROM @OITM WHERE {InvntItem} = 'Y'`);

  const groups = new Map();
  if (await k.has('OITB', 'ItmsGrpNam')) {
    for (const r of await k.run(`SELECT {ItmsGrpCod}, {ItmsGrpNam} FROM @OITB`)) groups.set(Number(r.ItmsGrpCod), r.ItmsGrpNam || String(r.ItmsGrpCod));
  }
  const items = new Map();
  for (const r of itemRows) {
    items.set(r.ItemCode, {
      itemCode: r.ItemCode, itemName: r.ItemName || '', groupCode: Number(r.ItmsGrpCod),
      group: groups.get(Number(r.ItmsGrpCod)) || String(r.ItmsGrpCod ?? ''),
      uom: optItem.uom ? (r.InvntryUom || '') : '', avgPrice: num(r.AvgPrice), lastPurPrice: num(r.LastPurPrc),
      evalMethod: optItem.eval ? ({ A: 'Moving Average', S: 'Standard', F: 'FIFO', B: 'Serial/Batch' }[r.EvalSystem] || r.EvalSystem || '') : '',
    });
  }

  await k.need('OWHS', ['WhsCode', 'WhsName']);
  const whsHasBpl = await k.has('OWHS', 'BPLid');
  const whsRows = await k.run(`SELECT {WhsCode}, {WhsName}${whsHasBpl ? ', {BPLid}' : ''} FROM @OWHS`);

  let branchEnabled = false;
  if (await k.has('OADM', 'MltpBrnchs')) {
    const a = await k.run(`SELECT {MltpBrnchs} FROM @OADM`);
    branchEnabled = a[0]?.MltpBrnchs === 'Y';
  }
  const branches = new Map();
  if (branchEnabled && await k.has('OBPL', 'BPLName')) {
    const hasDisabled = await k.has('OBPL', 'Disabled');
    for (const r of await k.run(`SELECT {BPLId}, {BPLName}${hasDisabled ? ', {Disabled}' : ''} FROM @OBPL`)) {
      if (hasDisabled && r.Disabled === 'Y') continue;
      branches.set(Number(r.BPLId), r.BPLName || String(r.BPLId));
    }
  }
  const warehouses = new Map();
  for (const r of whsRows) {
    const bpl = whsHasBpl && r.BPLid != null ? Number(r.BPLid) : null;
    warehouses.set(r.WhsCode, { whsCode: r.WhsCode, whsName: r.WhsName || '', branchId: bpl, branch: bpl != null ? (branches.get(bpl) || String(bpl)) : '' });
  }

  // OINM is a view on HANA 10 (absent from SYS.TABLE_COLUMNS), so probe one row.
  let oinmCols = new Set();
  try {
    const one = await k.run(`SELECT TOP 1 * FROM @OINM`);
    if (one[0]) oinmCols = new Set(Object.keys(one[0]).map(c => c.toLowerCase()));
  } catch (e) {
    throw new AgentDataError(`The inventory journal (OINM) could not be read on this database: ${e.message}`);
  }
  for (const c of ['itemcode', 'warehouse', 'docdate', 'inqty', 'outqty', 'transtype']) {
    if (oinmCols.size && !oinmCols.has(c)) throw new AgentDataError(`OINM is missing column ${c} on this database.`);
  }

  const data = {
    items, groups, warehouses, branches, branchEnabled,
    oinm: {
      value: oinmCols.has('transvalue'), calcPrice: oinmCols.has('calcprice'), seq: oinmCols.has('transseq'),
      memo: oinmCols.has('jrnlmemo'), card: oinmCols.has('cardcode'), ref: oinmCols.has('base_ref'), entry: oinmCols.has('createdby'),
    },
  };
  _master.set(k.company, { at: Date.now(), data });
  return data;
}

// ── Filter → SQL conditions ───────────────────────────────────────────────────
// Warehouse + branch selections collapse into one warehouse list (branches are
// assigned per warehouse in OWHS.BPLid). Item group / name filters need OITM.
function effectiveWarehouses(p, m) {
  let list = p.warehouses.length ? p.warehouses : null;
  if (m.branchEnabled && p.branches.length) {
    const inBranch = [...m.warehouses.values()].filter(w => p.branches.includes(w.branchId)).map(w => w.whsCode);
    list = list ? list.filter(w => inBranch.includes(w)) : inBranch;
    if (!list.length) list = ['\u0000none'];
  }
  return list;
}

function itemConds(k, p, alias, itemAlias) {
  const c = [];
  if (p.itemCode) {
    const codes = p.itemCode.split(/[,;\s]+/).filter(Boolean);
    if (codes.length > 1) c.push(`${alias}.{ItemCode} IN (${codes.map(k.lit).join(',')})`);
    else c.push(`UPPER(${alias}.{ItemCode}) LIKE ${k.lit(`%${codes[0].toUpperCase()}%`)}`);
  }
  if (itemAlias) {
    if (p.itemName) c.push(`UPPER(${itemAlias}.{ItemName}) LIKE ${k.lit(`%${p.itemName.toUpperCase()}%`)}`);
    if (p.itemGroups.length) c.push(`${itemAlias}.{ItmsGrpCod} IN (${p.itemGroups.join(',')})`);
  }
  return c;
}
const needsItemJoin = p => !!(p.itemName || p.itemGroups.length);

// FROM/WHERE for OINM with all filters; dateCond is an extra SQL condition on T0.DocDate.
function oinmScope(k, p, m, dateCond) {
  const join = needsItemJoin(p) ? ' INNER JOIN @OITM I ON I.{ItemCode} = T0.{ItemCode}' : '';
  const conds = [...itemConds(k, p, 'T0', join ? 'I' : null)];
  const whs = effectiveWarehouses(p, m);
  if (whs) conds.push(`T0.{Warehouse} IN (${whs.map(k.lit).join(',')})`);
  if (dateCond) conds.push(dateCond);
  return `FROM @OINM T0${join}${conds.length ? ` WHERE ${conds.join(' AND ')}` : ''}`;
}
const valExpr = m => (m.oinm.value ? 'T0.{TransValue}' : m.oinm.calcPrice ? '(T0.{InQty} - T0.{OutQty}) * T0.{CalcPrice}' : '0');

// ── Core datasets ─────────────────────────────────────────────────────────────
// Balance (qty + value) per item/warehouse up to and including `asOf` (or before `before`).
async function loadBalances(k, p, m, { before, asOf }) {
  const dc = before ? `T0.{DocDate} < ${k.lit(before)}` : `T0.{DocDate} <= ${k.lit(asOf)}`;
  const rows = await k.run(`SELECT T0.{ItemCode} AS {ItemCode}, T0.{Warehouse} AS {Warehouse},
      SUM(T0.{InQty} - T0.{OutQty}) AS {Qty}, SUM(${valExpr(m)}) AS {Val}
    ${oinmScope(k, p, m, dc)} GROUP BY T0.{ItemCode}, T0.{Warehouse}`);
  const map = new Map();
  for (const r of rows) map.set(keyIW(r.ItemCode, r.Warehouse), { itemCode: r.ItemCode, whsCode: r.Warehouse, qty: num(r.Qty), value: num(r.Val) });
  return map;
}

// Period movements per item/warehouse/transaction type.
async function loadMovements(k, p, m) {
  const v = valExpr(m);
  const dc = `T0.{DocDate} >= ${k.lit(p.fromDate)} AND T0.{DocDate} <= ${k.lit(p.toDate)}`;
  const rows = await k.run(`SELECT T0.{ItemCode} AS {ItemCode}, T0.{Warehouse} AS {Warehouse}, T0.{TransType} AS {TransType},
      SUM(T0.{InQty}) AS {InQ}, SUM(T0.{OutQty}) AS {OutQ},
      SUM(CASE WHEN ${v} > 0 THEN ${v} ELSE 0 END) AS {InV}, SUM(CASE WHEN ${v} < 0 THEN -(${v}) ELSE 0 END) AS {OutV},
      COUNT(*) AS {Cnt}
    ${oinmScope(k, p, m, dc)} GROUP BY T0.{ItemCode}, T0.{Warehouse}, T0.{TransType}`);
  return rows.map(r => ({
    itemCode: r.ItemCode, whsCode: r.Warehouse, type: Number(r.TransType),
    inQty: num(r.InQ), outQty: num(r.OutQ), inVal: num(r.InV), outVal: num(r.OutV), count: num(r.Cnt),
  }));
}

// Daily in/out value + qty for the period (trend chart), by transaction type.
async function loadDailyTrend(k, p, m) {
  const v = valExpr(m);
  const dc = `T0.{DocDate} >= ${k.lit(p.fromDate)} AND T0.{DocDate} <= ${k.lit(p.toDate)}`;
  const rows = await k.run(`SELECT T0.{DocDate} AS {DocDate}, T0.{TransType} AS {TransType},
      SUM(T0.{InQty}) AS {InQ}, SUM(T0.{OutQty}) AS {OutQ},
      SUM(CASE WHEN ${v} > 0 THEN ${v} ELSE 0 END) AS {InV}, SUM(CASE WHEN ${v} < 0 THEN -(${v}) ELSE 0 END) AS {OutV}
    ${oinmScope(k, p, m, dc)} GROUP BY T0.{DocDate}, T0.{TransType}`);
  const months = new Map();
  for (const r of rows) {
    if (Number(r.TransType) === 67) continue;   // transfers net to zero company-wide
    const mo = (isoDate(r.DocDate) || '').slice(0, 7);
    const e = months.get(mo) || { month: mo, inQty: 0, outQty: 0, inVal: 0, outVal: 0 };
    e.inQty += num(r.InQ); e.outQty += num(r.OutQ); e.inVal += num(r.InV); e.outVal += num(r.OutV);
    months.set(mo, e);
  }
  return [...months.values()].sort((a, z) => a.month.localeCompare(z.month)).map(e => ({
    ...e, inQty: round(e.inQty), outQty: round(e.outQty), inVal: round(e.inVal), outVal: round(e.outVal), net: round(e.inVal - e.outVal),
  }));
}

function itemInfo(m, code) {
  return m.items.get(code) || { itemCode: code, itemName: '', group: '(no group)', groupCode: null, uom: '', avgPrice: 0, lastPurPrice: 0, evalMethod: '' };
}
function whsInfo(m, code) { return m.warehouses.get(code) || { whsCode: code, whsName: '', branch: '' }; }

// ── Stock report (opening / in / out / closing) ──────────────────────────────
async function buildStock(k, p, m) {
  const [opening, moves] = await Promise.all([loadBalances(k, p, m, { before: p.fromDate }), loadMovements(k, p, m)]);
  const rows = new Map();
  const ensure = (itemCode, whsCode) => {
    const key = keyIW(itemCode, whsCode);
    if (!rows.has(key)) {
      const it = itemInfo(m, itemCode), w = whsInfo(m, whsCode);
      rows.set(key, {
        itemCode, itemName: it.itemName, group: it.group, groupCode: it.groupCode, uom: it.uom,
        whsCode, whsName: w.whsName, branch: w.branch,
        openQty: 0, openVal: 0, inQty: 0, inVal: 0, outQty: 0, outVal: 0, closeQty: 0, closeVal: 0, trans: [],
      });
    }
    return rows.get(key);
  };
  for (const o of opening.values()) { const r = ensure(o.itemCode, o.whsCode); r.openQty = o.qty; r.openVal = o.value; }
  const types = new Map();
  for (const mv of moves) {
    const r = ensure(mv.itemCode, mv.whsCode);
    r.inQty += mv.inQty; r.outQty += mv.outQty; r.inVal += mv.inVal; r.outVal += mv.outVal;
    r.trans.push({ type: mv.type, name: transName(mv.type), inQty: round(mv.inQty, 3), outQty: round(mv.outQty, 3), inVal: round(mv.inVal), outVal: round(mv.outVal), count: mv.count });
    const t = types.get(mv.type) || { type: mv.type, name: transName(mv.type), inQty: 0, outQty: 0, inVal: 0, outVal: 0, count: 0 };
    t.inQty += mv.inQty; t.outQty += mv.outQty; t.inVal += mv.inVal; t.outVal += mv.outVal; t.count += mv.count;
    types.set(mv.type, t);
  }
  const out = [];
  for (const r of rows.values()) {
    r.closeQty = r.openQty + r.inQty - r.outQty;
    r.closeVal = r.openVal + r.inVal - r.outVal;
    const moved = r.inQty || r.outQty || Math.abs(r.inVal) > 0.005 || Math.abs(r.outVal) > 0.005;
    if (!p.includeZero && !moved && Math.abs(r.openQty) < 1e-6 && Math.abs(r.openVal) < 0.005) continue;
    for (const f of ['openQty', 'inQty', 'outQty', 'closeQty']) r[f] = round(r[f], 3);
    for (const f of ['openVal', 'inVal', 'outVal', 'closeVal']) r[f] = round(r[f]);
    r.trans.sort((a, z) => a.name.localeCompare(z.name));
    out.push(r);
  }
  out.sort((a, z) => a.group.localeCompare(z.group) || a.itemCode.localeCompare(z.itemCode) || a.whsCode.localeCompare(z.whsCode));
  const transTypes = [...types.values()].map(t => ({ ...t, inQty: round(t.inQty, 3), outQty: round(t.outQty, 3), inVal: round(t.inVal), outVal: round(t.outVal) }))
    .sort((a, z) => (z.inVal + z.outVal) - (a.inVal + a.outVal));
  const sum = f => round(out.reduce((s, r) => s + r[f], 0), f.endsWith('Qty') ? 3 : 2);
  const totals = Object.fromEntries(['openQty', 'openVal', 'inQty', 'inVal', 'outQty', 'outVal', 'closeQty', 'closeVal'].map(f => [f, sum(f)]));
  return { rows: out, transTypes, totals };
}

// ── Valuation (as of To Date) ────────────────────────────────────────────────
async function buildValuation(k, p, m) {
  const bal = await loadBalances(k, p, m, { asOf: p.toDate });
  let whsAvg = new Map();
  if (await k.has('OITW', 'AvgPrice')) {
    const whs = effectiveWarehouses(p, m);
    const rows = await k.run(`SELECT {ItemCode}, {WhsCode}, {AvgPrice} FROM @OITW WHERE {OnHand} <> 0${whs ? ` AND {WhsCode} IN (${whs.map(k.lit).join(',')})` : ''}`);
    whsAvg = new Map(rows.map(r => [keyIW(r.ItemCode, r.WhsCode), num(r.AvgPrice)]));
  }
  const out = [];
  for (const b of bal.values()) {
    if (Math.abs(b.qty) < 1e-6 && Math.abs(b.value) < 0.005 && !p.includeZero) continue;
    const it = itemInfo(m, b.itemCode), w = whsInfo(m, b.whsCode);
    const unitCost = b.qty ? b.value / b.qty : 0;
    const curAvg = whsAvg.get(keyIW(b.itemCode, b.whsCode)) || it.avgPrice;
    out.push({
      itemCode: b.itemCode, itemName: it.itemName, group: it.group, uom: it.uom, evalMethod: it.evalMethod,
      whsCode: b.whsCode, whsName: w.whsName, branch: w.branch,
      qty: round(b.qty, 3), bookValue: round(b.value), unitCost: round(unitCost, 4),
      currentAvg: round(curAvg, 4), valueAtCurrentAvg: round(b.qty * curAvg),
      lastPurPrice: round(it.lastPurPrice, 4), valueAtLastPur: round(b.qty * it.lastPurPrice),
      variance: round(b.qty * it.lastPurPrice - b.value),
    });
  }
  out.sort((a, z) => z.bookValue - a.bookValue);
  const t = f => round(out.reduce((s, r) => s + r[f], 0));
  return { rows: out, totals: { qty: round(out.reduce((s, r) => s + r.qty, 0), 3), bookValue: t('bookValue'), valueAtCurrentAvg: t('valueAtCurrentAvg'), valueAtLastPur: t('valueAtLastPur'), variance: t('variance') } };
}

// ── Aging (FIFO on receipts into each warehouse, as of To Date) ──────────────
async function buildAging(k, p, m) {
  const bal = await loadBalances(k, p, m, { asOf: p.toDate });
  const since = addDays(p.toDate, -730);   // older remainder falls into '>365'
  const rec = await k.run(`SELECT T0.{ItemCode} AS {ItemCode}, T0.{Warehouse} AS {Warehouse}, T0.{DocDate} AS {DocDate}, SUM(T0.{InQty}) AS {Qty}
    ${oinmScope(k, p, m, `T0.{InQty} > 0 AND T0.{DocDate} >= ${k.lit(since)} AND T0.{DocDate} <= ${k.lit(p.toDate)}`)}
    GROUP BY T0.{ItemCode}, T0.{Warehouse}, T0.{DocDate}`);
  const receipts = new Map();
  for (const r of rec) {
    const key = keyIW(r.ItemCode, r.Warehouse);
    if (!receipts.has(key)) receipts.set(key, []);
    receipts.get(key).push({ date: isoDate(r.DocDate), qty: num(r.Qty) });
  }
  const out = [];
  for (const [key, b] of bal) {
    if (b.qty <= 1e-6) continue;
    const unit = b.value / b.qty;
    const it = itemInfo(m, b.itemCode), w = whsInfo(m, b.whsCode);
    const row = { itemCode: b.itemCode, itemName: it.itemName, group: it.group, uom: it.uom, whsCode: b.whsCode, whsName: w.whsName, branch: w.branch,
      qty: round(b.qty, 3), value: round(b.value), unitCost: round(unit, 4) };
    AGE_BUCKETS.forEach(bk => { row[`q_${bk.key}`] = 0; row[`v_${bk.key}`] = 0; });
    let left = b.qty, weighted = 0, oldest = null;
    const list = (receipts.get(key) || []).sort((a, z) => z.date.localeCompare(a.date));   // newest first
    for (const r of list) {
      if (left <= 1e-9) break;
      const take = Math.min(left, r.qty);
      const age = daysBetween(r.date, p.toDate);
      const bk = AGE_BUCKETS.find(x => age <= x.max);
      row[`q_${bk.key}`] += take; weighted += take * age; oldest = r.date; left -= take;
    }
    if (left > 1e-9) { row['q_>365'] += left; weighted += left * 731; oldest = `before ${since}`; }   // stock older than the receipts window
    AGE_BUCKETS.forEach(bk => { row[`q_${bk.key}`] = round(row[`q_${bk.key}`], 3); row[`v_${bk.key}`] = round(row[`q_${bk.key}`] * unit); });
    row.avgAgeDays = Math.round(weighted / b.qty);
    row.oldestReceipt = oldest;
    out.push(row);
  }
  out.sort((a, z) => z.value - a.value);
  const buckets = AGE_BUCKETS.map(bk => ({ bucket: bk.key, qty: round(out.reduce((s, r) => s + r[`q_${bk.key}`], 0), 3), value: round(out.reduce((s, r) => s + r[`v_${bk.key}`], 0)) }));
  return { rows: out, buckets, bucketKeys: AGE_BUCKETS.map(b => b.key), totals: { qty: round(out.reduce((s, r) => s + r.qty, 0), 3), value: round(out.reduce((s, r) => s + r.value, 0)) } };
}

// ── Dead / slow stock (as of To Date) ────────────────────────────────────────
async function buildDeadStock(k, p, m) {
  const bal = await loadBalances(k, p, m, { asOf: p.toDate });
  const upTo = `T0.{DocDate} <= ${k.lit(p.toDate)}`;
  const [lastUse, lastIn, use] = await Promise.all([
    k.run(`SELECT T0.{ItemCode} AS {ItemCode}, T0.{Warehouse} AS {Warehouse}, MAX(T0.{DocDate}) AS {D}
      ${oinmScope(k, p, m, `${upTo} AND T0.{TransType} IN (${CONSUME_TYPES.join(',')}) AND T0.{OutQty} > 0`)} GROUP BY T0.{ItemCode}, T0.{Warehouse}`),
    k.run(`SELECT T0.{ItemCode} AS {ItemCode}, T0.{Warehouse} AS {Warehouse}, MAX(T0.{DocDate}) AS {D}
      ${oinmScope(k, p, m, `${upTo} AND T0.{InQty} > 0`)} GROUP BY T0.{ItemCode}, T0.{Warehouse}`),
    k.run(`SELECT T0.{ItemCode} AS {ItemCode}, T0.{Warehouse} AS {Warehouse}, SUM(T0.{OutQty}) AS {Q}
      ${oinmScope(k, p, m, `${upTo} AND T0.{DocDate} >= ${k.lit(addDays(p.toDate, -365))} AND T0.{TransType} IN (${CONSUME_TYPES.join(',')})`)} GROUP BY T0.{ItemCode}, T0.{Warehouse}`),
  ]);
  const toMap = (rows, f) => new Map(rows.map(r => [keyIW(r.ItemCode, r.Warehouse), f(r)]));
  const lu = toMap(lastUse, r => isoDate(r.D)), li = toMap(lastIn, r => isoDate(r.D)), u12 = toMap(use, r => num(r.Q));
  const out = [];
  let totalValue = 0;
  for (const [key, b] of bal) {
    if (b.qty <= 1e-6) continue;
    totalValue += b.value;
    const lastUsed = lu.get(key) || null, lastReceipt = li.get(key) || null;
    const idle = lastUsed ? daysBetween(lastUsed, p.toDate) : (lastReceipt ? daysBetween(lastReceipt, p.toDate) : null);
    const status = idle == null || idle >= p.deadDays ? 'DEAD' : idle >= p.slowDays ? 'SLOW' : null;
    if (!status) continue;
    const it = itemInfo(m, b.itemCode), w = whsInfo(m, b.whsCode);
    const used12 = u12.get(key) || 0;
    out.push({
      status, itemCode: b.itemCode, itemName: it.itemName, group: it.group, uom: it.uom, whsCode: b.whsCode, whsName: w.whsName, branch: w.branch,
      qty: round(b.qty, 3), value: round(b.value), lastUsed, lastReceipt, idleDays: idle, neverUsed: !lastUsed,
      used12m: round(used12, 3), coverMonths: used12 > 0 ? round(b.qty / (used12 / 12), 1) : null,
    });
  }
  out.sort((a, z) => z.value - a.value);
  const v = s => round(out.filter(r => r.status === s).reduce((t, r) => t + r.value, 0));
  return { rows: out, totals: { totalValue: round(totalValue), deadValue: v('DEAD'), slowValue: v('SLOW'), deadLines: out.filter(r => r.status === 'DEAD').length, slowLines: out.filter(r => r.status === 'SLOW').length } };
}

// ── Item-wise profit (A/R invoices − credit memos) ───────────────────────────
async function profitScope(k, p, m, head, lines) {
  await k.need(head, ['DocEntry', 'DocDate', 'CANCELED', 'DiscPrcnt', 'CardCode', 'CardName']);
  await k.need(lines, ['DocEntry', 'ItemCode', 'Quantity', 'LineTotal', 'GrssProfit', 'WhsCode']);
  const join = needsItemJoin(p) ? ' INNER JOIN @OITM I ON I.{ItemCode} = T1.{ItemCode}' : '';
  const conds = [`T0.{CANCELED} = 'N'`, `T0.{DocDate} >= ${k.lit(p.fromDate)}`, `T0.{DocDate} <= ${k.lit(p.toDate)}`, `T1.{ItemCode} IS NOT NULL`,
    ...itemConds(k, p, 'T1', join ? 'I' : null)];
  if (p.warehouses.length) conds.push(`T1.{WhsCode} IN (${p.warehouses.map(k.lit).join(',')})`);
  if (m.branchEnabled && p.branches.length && await k.has(head, 'BPLId')) conds.push(`T0.{BPLId} IN (${p.branches.join(',')})`);
  return `FROM @${head} T0 INNER JOIN @${lines} T1 ON T1.{DocEntry} = T0.{DocEntry}${join} WHERE ${conds.join(' AND ')}`;
}
const REV = `T1.{LineTotal} * (100 - COALESCE(T0.{DiscPrcnt}, 0)) / 100`;
const COST = `(T1.{LineTotal} - T1.{GrssProfit})`;

async function buildProfit(k, p, m) {
  const sources = [['OINV', 'INV1', 1]];
  if (await k.has('RIN1', 'GrssProfit')) sources.push(['ORIN', 'RIN1', -1]);
  const byItem = new Map(), byCust = new Map(), byMonth = new Map();
  const add = (map, key, init, sign, r) => {
    const e = map.get(key) || { ...init, qty: 0, revenue: 0, cost: 0, docs: 0 };
    e.qty += sign * num(r.Qty); e.revenue += sign * num(r.Rev); e.cost += sign * num(r.Cost); e.docs += num(r.Docs);
    map.set(key, e);
  };
  for (const [head, lines, sign] of sources) {
    const scope = await profitScope(k, p, m, head, lines);
    const [it, cu, dy] = await Promise.all([
      k.run(`SELECT T1.{ItemCode} AS {ItemCode}, T1.{WhsCode} AS {WhsCode}, SUM(T1.{Quantity}) AS {Qty}, SUM(${REV}) AS {Rev}, SUM(${COST}) AS {Cost}, COUNT(DISTINCT T0.{DocEntry}) AS {Docs}
        ${scope} GROUP BY T1.{ItemCode}, T1.{WhsCode}`),
      k.run(`SELECT T0.{CardCode} AS {CardCode}, MAX(T0.{CardName}) AS {CardName}, SUM(T1.{Quantity}) AS {Qty}, SUM(${REV}) AS {Rev}, SUM(${COST}) AS {Cost}, COUNT(DISTINCT T0.{DocEntry}) AS {Docs}
        ${scope} GROUP BY T0.{CardCode}`),
      k.run(`SELECT T0.{DocDate} AS {DocDate}, SUM(T1.{Quantity}) AS {Qty}, SUM(${REV}) AS {Rev}, SUM(${COST}) AS {Cost}, COUNT(DISTINCT T0.{DocEntry}) AS {Docs}
        ${scope} GROUP BY T0.{DocDate}`),
    ]);
    for (const r of it) {
      const info = itemInfo(m, r.ItemCode), w = whsInfo(m, r.WhsCode);
      add(byItem, keyIW(r.ItemCode, r.WhsCode), { itemCode: r.ItemCode, itemName: info.itemName, group: info.group, uom: info.uom, whsCode: r.WhsCode || '', whsName: w.whsName, branch: w.branch }, sign, r);
    }
    for (const r of cu) add(byCust, r.CardCode, { cardCode: r.CardCode, cardName: r.CardName || '' }, sign, r);
    for (const r of dy) { const mo = (isoDate(r.DocDate) || '').slice(0, 7); add(byMonth, mo, { month: mo }, sign, r); }
  }
  const fin = e => {
    const gp = e.revenue - e.cost;
    return { ...e, qty: round(e.qty, 3), revenue: round(e.revenue), cost: round(e.cost), gp: round(gp),
      marginPct: e.revenue ? round((gp / e.revenue) * 100, 1) : null, unitPrice: e.qty ? round(e.revenue / e.qty, 4) : 0, unitCost: e.qty ? round(e.cost / e.qty, 4) : 0 };
  };
  const rows = [...byItem.values()].map(fin).sort((a, z) => z.gp - a.gp);
  const customers = [...byCust.values()].map(fin).sort((a, z) => z.gp - a.gp);
  const months = [...byMonth.values()].map(fin).sort((a, z) => a.month.localeCompare(z.month));
  const tr = rows.reduce((s, r) => s + r.revenue, 0), tc = rows.reduce((s, r) => s + r.cost, 0);
  return { rows, customers, months, totals: { revenue: round(tr), cost: round(tc), gp: round(tr - tc), marginPct: tr ? round(((tr - tc) / tr) * 100, 1) : null,
    qty: round(rows.reduce((s, r) => s + r.qty, 0), 3), items: new Set(rows.map(r => r.itemCode)).size, lossItems: rows.filter(r => r.gp < 0).length } };
}

// ── Transaction level (inventory audit with running balance) ─────────────────
function oinmRowCols(m) {
  return [
    'T0.{TransNum} AS {TransNum}', 'T0.{TransType} AS {TransType}', 'T0.{DocDate} AS {DocDate}',
    'T0.{ItemCode} AS {ItemCode}', 'T0.{Warehouse} AS {Warehouse}', 'T0.{InQty} AS {InQty}', 'T0.{OutQty} AS {OutQty}',
    `${valExpr(m)} AS {Val}`,
    m.oinm.calcPrice ? 'T0.{CalcPrice} AS {CalcPrice}' : null,
    m.oinm.ref ? 'T0.{BASE_REF} AS {BaseRef}' : null,
    m.oinm.entry ? 'T0.{CreatedBy} AS {DocEntry}' : null,
    m.oinm.card ? 'T0.{CardCode} AS {CardCode}' : null, m.oinm.card ? 'T0.{CardName} AS {CardName}' : null,
    m.oinm.memo ? 'T0.{JrnlMemo} AS {JrnlMemo}' : null,
  ].filter(Boolean).join(', ');
}

async function buildTransactions(k, p, m) {
  const dc = `T0.{DocDate} >= ${k.lit(p.fromDate)} AND T0.{DocDate} <= ${k.lit(p.toDate)}`;
  const scope = oinmScope(k, p, m, dc);
  const cnt = await k.run(`SELECT COUNT(*) AS {N} ${scope}`);
  const total = num(cnt[0]?.N);
  const order = m.oinm.seq ? 'T0.{TransSeq}' : 'T0.{TransNum}';
  const rows = await k.run(`SELECT TOP ${MAX_TRANS_ROWS} ${oinmRowCols(m)} ${scope} ORDER BY T0.{ItemCode}, T0.{Warehouse}, T0.{DocDate}, ${order}`);
  const opening = await loadBalances(k, p, m, { before: p.fromDate });
  const groups = new Map();
  for (const r of rows) {
    const key = keyIW(r.ItemCode, r.Warehouse);
    if (!groups.has(key)) {
      const o = opening.get(key) || { qty: 0, value: 0 };
      const it = itemInfo(m, r.ItemCode), w = whsInfo(m, r.Warehouse);
      groups.set(key, { itemCode: r.ItemCode, itemName: it.itemName, group: it.group, uom: it.uom, whsCode: r.Warehouse, whsName: w.whsName,
        openQty: round(o.qty, 3), openVal: round(o.value), inQty: 0, outQty: 0, inVal: 0, outVal: 0, _q: o.qty, _v: o.value, lines: [] });
    }
    const g = groups.get(key);
    const inQ = num(r.InQty), outQ = num(r.OutQty), val = num(r.Val);
    g._q += inQ - outQ; g._v += val;
    g.inQty += inQ; g.outQty += outQ; if (val > 0) g.inVal += val; else g.outVal -= val;
    g.lines.push({
      transNum: r.TransNum, date: isoDate(r.DocDate), type: Number(r.TransType), transName: transName(r.TransType),
      docNum: r.BaseRef ?? '', docEntry: r.DocEntry ?? null, cardCode: r.CardCode || '', cardName: r.CardName || '', memo: r.JrnlMemo || '',
      inQty: round(inQ, 3), outQty: round(outQ, 3), cost: round(num(r.CalcPrice), 4), value: round(val),
      balQty: round(g._q, 3), balVal: round(g._v),
    });
  }
  const out = [...groups.values()].map(({ _q, _v, ...g }) => ({ ...g, inQty: round(g.inQty, 3), outQty: round(g.outQty, 3), inVal: round(g.inVal), outVal: round(g.outVal), closeQty: round(_q, 3), closeVal: round(_v) }));
  return { rows: out, totalRows: total, shownRows: rows.length, truncated: total > rows.length, limit: MAX_TRANS_ROWS };
}

// ── Posting list (document level, grouped by transaction type) ───────────────
async function buildPosting(k, p, m) {
  if (!m.oinm.ref) throw new AgentDataError('OINM.BASE_REF is not available on this database, so the posting list cannot be built.');
  const dc = `T0.{DocDate} >= ${k.lit(p.fromDate)} AND T0.{DocDate} <= ${k.lit(p.toDate)}`;
  const v = valExpr(m);
  const extra = [m.oinm.card ? ', T0.{CardCode} AS {CardCode}, T0.{CardName} AS {CardName}' : '', m.oinm.entry ? ', T0.{CreatedBy} AS {DocEntry}' : ''].join('');
  const extraG = [m.oinm.card ? ', T0.{CardCode}, T0.{CardName}' : '', m.oinm.entry ? ', T0.{CreatedBy}' : ''].join('');
  const rows = await k.run(`SELECT TOP ${MAX_POSTING_DOCS + 1} T0.{TransType} AS {TransType}, T0.{BASE_REF} AS {BaseRef}, T0.{DocDate} AS {DocDate}${extra},
      COUNT(*) AS {Lines}, COUNT(DISTINCT T0.{ItemCode}) AS {Items}, SUM(T0.{InQty}) AS {InQ}, SUM(T0.{OutQty}) AS {OutQ},
      SUM(CASE WHEN ${v} > 0 THEN ${v} ELSE 0 END) AS {InV}, SUM(CASE WHEN ${v} < 0 THEN -(${v}) ELSE 0 END) AS {OutV}
    ${oinmScope(k, p, m, dc)} GROUP BY T0.{TransType}, T0.{BASE_REF}, T0.{DocDate}${extraG}
    ORDER BY T0.{DocDate} DESC, T0.{TransType}, T0.{BASE_REF}`);
  const truncated = rows.length > MAX_POSTING_DOCS;
  const docs = rows.slice(0, MAX_POSTING_DOCS).map(r => ({
    type: Number(r.TransType), transName: transName(r.TransType), docNum: r.BaseRef ?? '', docEntry: r.DocEntry ?? null,
    date: isoDate(r.DocDate), cardCode: r.CardCode || '', cardName: r.CardName || '',
    lines: num(r.Lines), items: num(r.Items), inQty: round(num(r.InQ), 3), outQty: round(num(r.OutQ), 3),
    inVal: round(num(r.InV)), outVal: round(num(r.OutV)), net: round(num(r.InV) - num(r.OutV)),
  }));
  const byType = new Map();
  for (const d of docs) {
    const t = byType.get(d.type) || { type: d.type, transName: d.transName, docs: 0, lines: 0, inQty: 0, outQty: 0, inVal: 0, outVal: 0 };
    t.docs++; t.lines += d.lines; t.inQty += d.inQty; t.outQty += d.outQty; t.inVal += d.inVal; t.outVal += d.outVal;
    byType.set(d.type, t);
  }
  const types = [...byType.values()].map(t => ({ ...t, inQty: round(t.inQty, 3), outQty: round(t.outQty, 3), inVal: round(t.inVal), outVal: round(t.outVal), net: round(t.inVal - t.outVal) }))
    .sort((a, z) => z.docs - a.docs);
  return { rows: docs, types, truncated, limit: MAX_POSTING_DOCS };
}

// ── Dashboard: everything at a glance ────────────────────────────────────────
async function buildDashboard(k, p, m) {
  const [stock, trend, aging, dead, profit] = await Promise.all([
    buildStock(k, p, m), loadDailyTrend(k, p, m), buildAging(k, p, m), buildDeadStock(k, p, m),
    buildProfit(k, p, m).catch(e => ({ error: e.message, rows: [], customers: [], months: [], totals: {} })),
  ]);
  const agg = (rows, keyFn, valFn) => {
    const mp = new Map();
    for (const r of rows) mp.set(keyFn(r), (mp.get(keyFn(r)) || 0) + valFn(r));
    return [...mp.entries()].map(([label, value]) => ({ label, value: round(value) })).sort((a, z) => z.value - a.value);
  };
  const itemsWithStock = new Set(stock.rows.filter(r => r.closeQty > 0).map(r => r.itemCode)).size;
  const aged180 = aging.buckets.filter(b => ['181-365', '>365'].includes(b.bucket)).reduce((s, b) => s + b.value, 0);
  const t = stock.totals;
  const turnover = (t.openVal + t.closeVal) > 0 ? round(((profit.totals.cost || 0) / ((t.openVal + t.closeVal) / 2)), 2) : null;
  return {
    kpis: [
      { key: 'openVal', label: 'Opening value', value: t.openVal, fmt: 'amt' },
      { key: 'inVal', label: 'Inward value', value: t.inVal, fmt: 'amt', tone: 'good' },
      { key: 'outVal', label: 'Outward value', value: t.outVal, fmt: 'amt', tone: 'warn' },
      { key: 'closeVal', label: 'Closing value', value: t.closeVal, fmt: 'amt', strong: true },
      { key: 'closeQty', label: 'Closing qty', value: t.closeQty, fmt: 'num' },
      { key: 'items', label: 'Items in stock', value: itemsWithStock, fmt: 'int' },
      { key: 'gp', label: 'Gross profit', value: profit.totals.gp || 0, fmt: 'amt', tone: (profit.totals.gp || 0) < 0 ? 'bad' : 'good', hint: profit.totals.marginPct != null ? `${profit.totals.marginPct}% margin` : '' },
      { key: 'dead', label: 'Dead + slow stock', value: dead.totals.deadValue + dead.totals.slowValue, fmt: 'amt', tone: 'bad', hint: `${dead.totals.deadLines + dead.totals.slowLines} item-whs lines` },
      { key: 'aged', label: 'Aged > 180 days', value: round(aged180), fmt: 'amt', tone: 'warn' },
      { key: 'turn', label: 'Stock turnover', value: turnover, fmt: 'x', hint: 'COGS ÷ average stock value' },
    ],
    charts: {
      trend,
      byGroup: agg(stock.rows, r => r.group || '(no group)', r => r.closeVal).slice(0, 12),
      byWarehouse: agg(stock.rows, r => r.whsCode, r => r.closeVal).slice(0, 15),
      byBranch: m.branchEnabled ? agg(stock.rows, r => r.branch || '(none)', r => r.closeVal) : [],
      transMix: stock.transTypes.slice(0, 12).map(x => ({ label: x.name, inVal: x.inVal, outVal: x.outVal, count: x.count })),
      aging: aging.buckets,
      topItems: agg(stock.rows, r => r.itemCode, r => r.closeVal).slice(0, 10)
        .map(x => ({ ...x, name: itemInfo(m, x.label).itemName })),
      topProfit: [...profit.rows.reduce((acc, r) => {
        const e = acc.get(r.itemCode) || { label: r.itemCode, name: r.itemName, gp: 0, revenue: 0 };
        e.gp += r.gp; e.revenue += r.revenue; acc.set(r.itemCode, e); return acc;
      }, new Map()).values()].map(x => ({ ...x, gp: round(x.gp), revenue: round(x.revenue) })).sort((a, z) => z.gp - a.gp).slice(0, 10),
      profitMonths: profit.months,
      deadSplit: [{ label: 'Dead', value: dead.totals.deadValue }, { label: 'Slow', value: dead.totals.slowValue },
        { label: 'Active', value: round(Math.max(0, dead.totals.totalValue - dead.totals.deadValue - dead.totals.slowValue)) }],
    },
    profitError: profit.error || null,
  };
}

const BUILDERS = {
  dashboard: buildDashboard, stock: buildStock, transactions: buildTransactions, posting: buildPosting,
  valuation: buildValuation, aging: buildAging, deadstock: buildDeadStock, profit: buildProfit,
};

// ── Router ────────────────────────────────────────────────────────────────────
export function createInventoryDashboardRouter(deps) {
  const { requireAuth } = deps;
  const router = Router();
  const dbDeps = {
    isConnected: deps.isConnected, getActiveType: deps.getActiveType, getActiveConfig: deps.getActiveConfig,
    executeSQL: deps.executeSQL, tableRef: deps.tableRef, getTableColumns: deps.getTableColumns,
  };
  const kit = async () => {
    if (deps.ensureConnected) await deps.ensureConnected();
    return sqlKit(dbDeps);
  };
  const fail = (res, e, where) => {
    const known = e instanceof AgentDataError;
    if (!known) console.error(`[InventoryDashboard] ${where} error:`, e);
    res.status(known ? 400 : 500).json({ ok: false, error: e.message });
  };

  router.get('/filters', requireAuth, async (req, res) => {
    try {
      const k = await kit();
      if (req.query.refresh) _master.delete(k.company);
      const m = await loadMaster(k);
      // Company local currency drives number/date formatting on the page (USD → en-US, INR → en-IN).
      const currency = deps.getCompanyCurrency ? await deps.getCompanyCurrency().catch(() => null) : null;
      res.json({
        ok: true, branchEnabled: m.branchEnabled,
        currency: currency ? { code: currency.code, symbol: currency.symbol } : { code: 'USD', symbol: '$' },
        warehouses: [...m.warehouses.values()].sort((a, z) => a.whsCode.localeCompare(z.whsCode)),
        itemGroups: [...m.groups.entries()].map(([code, name]) => ({ code, name })).sort((a, z) => a.name.localeCompare(z.name)),
        branches: [...m.branches.entries()].map(([id, name]) => ({ id, name })),
        itemCount: m.items.size,
        transTypes: TRANS_NAMES,
      });
    } catch (e) { fail(res, e, '/filters'); }
  });

  router.get('/items', requireAuth, async (req, res) => {
    try {
      const k = await kit();
      const m = await loadMaster(k);
      const q = lc(req.query.q).toUpperCase();
      const out = [];
      for (const it of m.items.values()) {
        if (!q || it.itemCode.toUpperCase().includes(q) || it.itemName.toUpperCase().includes(q)) out.push({ itemCode: it.itemCode, itemName: it.itemName, group: it.group });
        if (out.length >= 40) break;
      }
      res.json({ ok: true, items: out });
    } catch (e) { fail(res, e, '/items'); }
  });

  router.post('/report', requireAuth, async (req, res) => {
    const t0 = Date.now();
    try {
      const p = readParams(req.body);
      const build = BUILDERS[p.report];
      if (!build) return res.status(400).json({ ok: false, error: `Unknown report: ${p.report}` });
      const k = await kit();
      const m = await loadMaster(k);
      const data = await build(k, p, m);
      res.json({ ok: true, report: p.report, params: p, branchEnabled: m.branchEnabled, elapsedMs: Date.now() - t0, ...data });
    } catch (e) { fail(res, e, '/report'); }
  });

  // Drill-downs: invoice lines behind an item's profit, or journal lines for one item/warehouse.
  router.post('/drill', requireAuth, async (req, res) => {
    try {
      const p = readParams(req.body);
      const itemCode = lc(req.body.itemCode);
      const whsCode = lc(req.body.whsCode);
      if (!itemCode) return res.status(400).json({ ok: false, error: 'itemCode required' });
      const k = await kit();
      const m = await loadMaster(k);
      const q = { ...p, itemCode: '', itemName: '', itemGroups: [], warehouses: whsCode ? [whsCode] : p.warehouses };

      if (req.body.kind === 'profitDocs') {
        const sources = [['OINV', 'INV1', 1, 'A/R Invoice']];
        if (await k.has('RIN1', 'GrssProfit')) sources.push(['ORIN', 'RIN1', -1, 'A/R Credit Memo']);
        const lines = [];
        for (const [head, ln, sign, label] of sources) {
          const scope = await profitScope(k, q, m, head, ln);
          const rows = await k.run(`SELECT TOP 2000 T0.{DocNum} AS {DocNum}, T0.{DocDate} AS {DocDate}, T0.{CardCode} AS {CardCode}, T0.{CardName} AS {CardName},
              T1.{WhsCode} AS {WhsCode}, T1.{Quantity} AS {Qty}, ${REV} AS {Rev}, ${COST} AS {Cost}
            ${scope} AND T1.{ItemCode} = ${k.lit(itemCode)} ORDER BY T0.{DocDate} DESC`);
          for (const r of rows) {
            const rev = sign * num(r.Rev), cost = sign * num(r.Cost), qty = sign * num(r.Qty);
            lines.push({ docType: label, docNum: r.DocNum, date: isoDate(r.DocDate), cardCode: r.CardCode, cardName: r.CardName || '', whsCode: r.WhsCode || '',
              qty: round(qty, 3), revenue: round(rev), cost: round(cost), gp: round(rev - cost), unitPrice: qty ? round(rev / qty, 4) : 0, marginPct: rev ? round(((rev - cost) / rev) * 100, 1) : null });
          }
        }
        lines.sort((a, z) => String(z.date).localeCompare(String(a.date)));
        return res.json({ ok: true, kind: 'profitDocs', itemCode, lines });
      }

      // itemTrans: journal lines with running balance for one item (optionally one warehouse)
      const tr = await buildTransactions(k, { ...q, itemCode }, m);
      tr.rows = tr.rows.filter(r => r.itemCode === itemCode);
      res.json({ ok: true, kind: 'itemTrans', itemCode, ...tr });
    } catch (e) { fail(res, e, '/drill'); }
  });

  return router;
}
