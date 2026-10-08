/**
 * Supply Chain Demand Forecast Agent — mounted at /api/demand-forecast-agent
 *
 * Automates the Watertech "Demand & Supply Forecast Planning" Excel model
 * (wt/Forcast Model Based On point.xlsx + SOW) on live SAP B1 data:
 *
 *   Actual demand     monthly A/R invoice qty − credit memos (or sales-order qty)
 *   Forecast demand   exponential smoothing per item, Excel FORECAST.ETS style:
 *                     Holt-Winters additive (trend + 12-month season) when there
 *                     are ≥ 24 months, else Holt / simple — picked by AIC —
 *                     with a confidence band and Alpha/Beta/Gamma/MAE/RMSE/
 *                     SMAPE/MASE like FORECAST.ETS.STAT. Manual overrides win.
 *   Forecasted supply open PO quantities by arrival month (line ship date, or a
 *                     "target delivery date" UDF), PO deposit RAG from a UDF
 *   Min inventory     daily forecast demand × lead time × (1 + safety margin %)
 *   Inventory level   on hand + supply − demand forecast, month by month
 *   Required order    lot-for-lot orders (≥ min order qty) that keep the
 *                     projection at or above min inventory, with order-by date
 *   Live pace         month-to-date sales vs this month's plan → FAST / SLOW
 */
import { createInsightRouter, ctxTable, num, round, clamp, fmtAmt, addDays, daysBetween, isoDate, AgentDataError } from '../lib/insight-kit.mjs';
import { loadItems, loadWarehouseStock } from '../lib/insight-data.mjs';
import { agentSettingsRepo } from '../lib/insight-store.mjs';

const SETTINGS_KEY = 'demand-forecast';

// KPI drill-through (calc blocks → lib/insight-kit.mjs withKpiDetails).
const SRC = {
  demand: source => source === 'orders' ? 'ORDR + RDR1 — sales-order quantity by posting month' : 'OINV + INV1 − ORIN + RIN1 — invoiced quantity net of credit memos by posting month',
  oitm: 'OITM — item master: unit cost, lead time, min level, preferred vendor',
  oitw: 'OITM / OITW — on hand, committed and ordered quantity',
  por: 'OPOR + POR1 — open purchase-order lines: open qty, price, arrival date',
  rules: 'Item order rules — minimum order qty and order multiple',
  ovr: 'Local forecast override store (manual months)',
};
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const Z = { 80: 1.2816, 90: 1.6449, 95: 1.96, 99: 2.5758 };

// ── Month keys ('YYYY-MM') ───────────────────────────────────────────────────
const mk = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
function addMonths(key, n) {
  const [y, m] = key.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return mk(Math.floor(t / 12), (t % 12) + 1);
}
const monthLabel = key => `${MON[Number(key.slice(5, 7)) - 1]} ${key.slice(2, 4)}`;
const daysInMonth = key => new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0)).getUTCDate();
const monthRange = (from, n) => Array.from({ length: n }, (_, i) => addMonths(from, i));

// Per-item series from the last run, so a row's chart / override grid opens
// instantly without re-running the whole analysis. Keyed by company + user.
const lastRuns = new Map();
const runKey = (company, req) => `${company}|${String(req?.user?.id ?? req?.user?.username ?? 'anon')}`;

// ── Exponential smoothing (ETS A,Ad,A) ───────────────────────────────────────
// One-step-ahead fit over the whole series; the grid search keeps the lowest
// SSE per model form, then AIC picks between simple / trend / trend+season so
// extra parameters have to earn their place. Trend is lightly damped so a
// 12-month horizon does not run away on a short series.
const PHI = 0.98;
const GRID_A = [0.05, 0.1, 0.2, 0.3, 0.4, 0.6, 0.8];
const GRID_B = [0.001, 0.01, 0.05, 0.1, 0.2, 0.3];
const GRID_G = [0.05, 0.1, 0.2, 0.3, 0.5];

function runEts(y, a, b, g, m, trend, seasonal) {
  const n = y.length;
  let l, t = 0;
  const s = new Array(m).fill(0);
  if (seasonal) {
    const m1 = y.slice(0, m).reduce((x, v) => x + v, 0) / m;
    const m2 = y.slice(m, 2 * m).reduce((x, v) => x + v, 0) / m;
    l = m1; t = trend ? (m2 - m1) / m : 0;
    for (let i = 0; i < m; i++) s[i] = y[i] - m1;
  } else {
    // Level/trend from a least-squares line over the first year (like Excel's
    // ETS start-up), so a short, noisy series still gets a sensible slope.
    const w = Math.min(n, 12), xm = (w - 1) / 2;
    const ym = y.slice(0, w).reduce((x, v) => x + v, 0) / w;
    let sxy = 0, sxx = 0;
    for (let i = 0; i < w; i++) { sxy += (i - xm) * (y[i] - ym); sxx += (i - xm) ** 2; }
    t = trend && sxx > 0 ? sxy / sxx : 0;
    l = trend ? ym - t * xm - t : y[0];
  }
  const fitted = new Array(n).fill(null);
  const start = seasonal ? m : 1;
  let sse = 0, cnt = 0;
  for (let i = 0; i < n; i++) {
    const si = seasonal ? s[i % m] : 0;
    const f = l + (trend ? PHI * t : 0) + si;
    if (i >= start) { fitted[i] = f; sse += (y[i] - f) ** 2; cnt++; }
    const lPrev = l;
    l = a * (y[i] - si) + (1 - a) * (lPrev + (trend ? PHI * t : 0));
    if (trend) t = b * (l - lPrev) + (1 - b) * PHI * t;
    if (seasonal) s[i % m] = g * (y[i] - l) + (1 - g) * si;
  }
  return { sse, cnt, fitted, l, t, s };
}

function fitSeries(y, m = 12) {
  const n = y.length;
  const forms = [{ name: 'Simple', trend: false, seasonal: false, k: 2 }];
  if (n >= 6) forms.push({ name: 'Holt (trend)', trend: true, seasonal: false, k: 4 });
  if (n >= 2 * m) forms.push({ name: 'Holt-Winters', trend: true, seasonal: true, k: 4 + m });
  let best = null;
  for (const f of forms) {
    let bf = null;
    for (const a of GRID_A) for (const b of (f.trend ? GRID_B : [0])) for (const g of (f.seasonal ? GRID_G : [0])) {
      const r = runEts(y, a, b, g, m, f.trend, f.seasonal);
      if (!bf || r.sse < bf.r.sse) bf = { a, b, g, r };
    }
    const N = bf.r.cnt || 1;
    const aic = N * Math.log(Math.max(bf.r.sse, 1e-9) / N) + 2 * f.k;
    if (!best || aic < best.aic) best = { ...f, ...bf, aic };
  }
  const { r, a, b, g } = best;
  const errs = [], sm = [];
  for (let i = 0; i < n; i++) {
    if (r.fitted[i] == null) continue;
    const e = y[i] - r.fitted[i];
    errs.push(e);
    const den = Math.abs(y[i]) + Math.abs(r.fitted[i]);
    if (den > 0) sm.push((2 * Math.abs(e)) / den);
  }
  const mae = errs.length ? errs.reduce((x, e) => x + Math.abs(e), 0) / errs.length : 0;
  const rmse = errs.length ? Math.sqrt(errs.reduce((x, e) => x + e * e, 0) / errs.length) : 0;
  let naive = 0;
  for (let i = 1; i < n; i++) naive += Math.abs(y[i] - y[i - 1]);
  naive = n > 1 ? naive / (n - 1) : 0;
  const forecast = h => {
    let damp = 0;
    for (let j = 1; j <= h; j++) damp += PHI ** j;
    return r.l + (best.trend ? damp * r.t : 0) + (best.seasonal ? r.s[(n - 1 + h) % m] : 0);
  };
  // Prediction variance: σ²·(1 + Σ c_j²), c_j = α(1 + jβ) + γ·[j ≡ 0 mod m].
  const halfWidth = (h, z) => {
    let v = 1;
    for (let j = 1; j < h; j++) {
      const c = a * (1 + (best.trend ? j * b : 0)) + (best.seasonal && j % m === 0 ? g : 0);
      v += c * c;
    }
    return z * rmse * Math.sqrt(v);
  };
  return {
    method: best.name, alpha: a, beta: best.trend ? b : null, gamma: best.seasonal ? g : null,
    mae, rmse, smape: sm.length ? (sm.reduce((x, v) => x + v, 0) / sm.length) * 100 : null,
    mase: naive > 0 ? mae / naive : null, fitted: r.fitted, forecast, halfWidth,
    sumErr: errs.reduce((x, e) => x + e, 0), sumAbsErr: errs.reduce((x, e) => x + Math.abs(e), 0),
  };
}

// Too little history for smoothing: flat average of what there is.
function averageModel(y) {
  const avg = y.length ? y.reduce((a, v) => a + v, 0) / y.length : 0;
  const sd = y.length > 1 ? Math.sqrt(y.reduce((a, v) => a + (v - avg) ** 2, 0) / (y.length - 1)) : avg * 0.5;
  return {
    method: y.length ? 'Average (low data)' : 'No history', alpha: null, beta: null, gamma: null,
    mae: null, rmse: sd, smape: null, mase: null, fitted: y.map(() => null),
    forecast: () => avg, halfWidth: (h, z) => z * sd * Math.sqrt(h), sumErr: 0, sumAbsErr: 0,
  };
}

// ── SAP reads ────────────────────────────────────────────────────────────────
// Monthly qty per item from a marketing document pair, in inventory UoM when
// the line carries InvQty. Returns Map itemCode → Map monthKey → qty.
async function loadMonthlyQty(k, head, lines, from, to, { warehouse, sign = 1, into } = {}) {
  await k.need(head, ['DocEntry', 'DocDate', 'CANCELED']);
  await k.need(lines, ['DocEntry', 'ItemCode', 'Quantity', 'WhsCode']);
  const qty = (await k.has(lines, 'InvQty')) ? 'InvQty' : 'Quantity';
  const rows = await k.run(`SELECT T1.{ItemCode} AS {ItemCode}, YEAR(T0.{DocDate}) AS {Yr}, MONTH(T0.{DocDate}) AS {Mo}, SUM(T1.{${qty}}) AS {Qty}
    FROM @${head} T0 INNER JOIN @${lines} T1 ON T1.{DocEntry} = T0.{DocEntry}
    WHERE T0.{CANCELED} = 'N' AND T0.{DocDate} >= ${k.lit(from)} AND T0.{DocDate} <= ${k.lit(to)} AND T1.{ItemCode} IS NOT NULL
      ${warehouse ? `AND T1.{WhsCode} = ${k.lit(warehouse)}` : ''}
    GROUP BY T1.{ItemCode}, YEAR(T0.{DocDate}), MONTH(T0.{DocDate})`);
  const map = into || new Map();
  for (const r of rows) {
    const key = mk(num(r.Yr), num(r.Mo));
    if (!map.has(r.ItemCode)) map.set(r.ItemCode, new Map());
    const m = map.get(r.ItemCode);
    m.set(key, (m.get(key) || 0) + num(r.Qty) * sign);
  }
  return map;
}

const UDF_RE = /^U_\w{1,50}$/;

// Open PO lines with arrival date and optional deposit / target-delivery UDFs.
async function loadOpenPoLines(k, { warehouse, arrivalField, depositField }) {
  await k.need('OPOR', ['DocEntry', 'DocNum', 'CardCode', 'CardName', 'DocDate', 'DocDueDate', 'DocStatus', 'CANCELED']);
  await k.need('POR1', ['DocEntry', 'LineNum', 'ItemCode', 'OpenQty', 'LineStatus', 'WhsCode', 'Price']);
  const openQty = (await k.has('POR1', 'OpenInvQty')) ? 'OpenInvQty' : 'OpenQty';
  const ship = await k.has('POR1', 'ShipDate');
  const udf = async f => {
    if (!f) return null;
    if (!UDF_RE.test(f)) throw new AgentDataError(`"${f}" is not a UDF name (expected U_…).`);
    if (await k.has('POR1', f)) return `T1.{${f}}`;
    if (await k.has('OPOR', f)) return `T0.{${f}}`;
    throw new AgentDataError(`UDF ${f} was not found on OPOR or POR1.`);
  };
  const arr = await udf(arrivalField), dep = await udf(depositField);
  const rows = await k.run(`SELECT T0.{DocEntry} AS {DocEntry}, T0.{DocNum} AS {DocNum}, T0.{CardCode} AS {CardCode}, T0.{CardName} AS {CardName},
      T0.{DocDate} AS {DocDate}, T0.{DocDueDate} AS {DocDueDate}, T1.{LineNum} AS {LineNum}, T1.{ItemCode} AS {ItemCode},
      T1.{${openQty}} AS {OpenQty}, T1.{Price} AS {Price}${ship ? ', T1.{ShipDate} AS {ShipDate}' : ''}
      ${arr ? `, ${arr} AS {ArrivalUdf}` : ''}${dep ? `, ${dep} AS {DepositUdf}` : ''}
    FROM @OPOR T0 INNER JOIN @POR1 T1 ON T1.{DocEntry} = T0.{DocEntry}
    WHERE T0.{DocStatus} = 'O' AND T0.{CANCELED} = 'N' AND T1.{LineStatus} = 'O' AND T1.{${openQty}} > 0
      ${warehouse ? `AND T1.{WhsCode} = ${k.lit(warehouse)}` : ''}`);
  const iso = isoDate;
  const paidFlag = v => v != null && String(v).trim() !== '' && !/^(n|no|0|false)$/i.test(String(v).trim());
  return {
    usedArrival: arr ? arrivalField : ship ? 'POR1.ShipDate' : 'OPOR.DocDueDate', usedDeposit: dep ? depositField : null,
    lines: rows.map(r => ({
      docEntry: r.DocEntry, docNum: r.DocNum, cardCode: r.CardCode, cardName: r.CardName || '', lineNum: r.LineNum,
      itemCode: r.ItemCode, openQty: num(r.OpenQty), price: num(r.Price), docDate: iso(r.DocDate),
      arrival: (arr && iso(r.ArrivalUdf)) || (ship && iso(r.ShipDate)) || iso(r.DocDueDate) || iso(r.DocDate),
      deposit: dep ? (paidFlag(r.DepositUdf) ? iso(r.DepositUdf) || String(r.DepositUdf).trim() : '') : undefined,
    })),
  };
}

async function loadOrderRules(k) {
  const cols = ['MinOrdrQty', 'OrdrMulti'];
  const have = [];
  for (const c of cols) if (await k.has('OITM', c)) have.push(c);
  if (!have.length) return new Map();
  const rows = await k.run(`SELECT {ItemCode}, ${have.map(c => `{${c}}`).join(', ')} FROM @OITM WHERE {InvntItem} = 'Y'`);
  return new Map(rows.map(r => [r.ItemCode, { minOrder: num(r.MinOrdrQty), multiple: num(r.OrdrMulti) }]));
}

// ── "How is this calculated?" popups ───────────────────────────────────────
// Decision table; `hit` only on the rule whose result applied (keeps JSON small).
const rulesHit = (list, applied) => list.map(([rule, result]) => (result === applied ? { rule, result, hit: true } : { rule, result }));
// Rows are shared by several tabs: give each tab a copy carrying only the explanations
// for its own columns ('col:source' shows explain[source] on column col).
const withExplain = (list, exOf, keys) => list.map(r => {
  const all = exOf.get(r), ex = {};
  if (!all) return r;
  for (const spec of keys) { const [key, src = key] = spec.split(':'); if (all[src]) ex[key] = all[src]; }
  return Object.keys(ex).length ? { ...r, explain: ex } : r;
});

function lotSize(need, rule) {
  let q = Math.max(need, rule?.minOrder || 0);
  if (rule?.multiple > 1) q = Math.ceil(q / rule.multiple) * rule.multiple;
  return Math.ceil(q);
}

// ── Analysis ─────────────────────────────────────────────────────────────────
async function run(k, p, ctx = {}) {
  const asOf = p.asOf;
  const historyMonths = clamp(Math.round(num(p.historyMonths) || 36), 6, 60);
  const horizon = clamp(Math.round(num(p.horizonMonths) || 12), 3, 18);
  const conf = [80, 90, 95, 99].includes(Number(p.confidence)) ? Number(p.confidence) : 95;
  const z = Z[conf];
  const marginPct = clamp(num(p.safetyMarginPct ?? 25), 0, 300);
  const defaultLT = clamp(num(p.defaultLeadTime) || 30, 1, 365);
  const excessMonths = clamp(num(p.excessMonths) || 6, 1, 36);
  const staleDays = clamp(num(p.stalePoDays) || 180, 30, 3650);
  const source = String(p.demandSource || 'invoices') === 'orders' ? 'orders' : 'invoices';
  const warehouse = String(p.warehouse || '').trim();
  const groupFilter = String(p.group || '').trim().toLowerCase();
  // A group picked from the list matches exactly; free text still means "contains".
  const groupMatch = g => { const v = String(g || '').toLowerCase(); return v === groupFilter || v.includes(groupFilter); };
  const focus = String(p.item || '').trim();

  const cur = asOf.slice(0, 7);
  const histStart = addMonths(cur, -historyMonths);
  const histMonths = monthRange(histStart, historyMonths);            // completed months
  const planMonths = monthRange(cur, horizon);                        // cur = month 1
  const dom = Number(asOf.slice(8, 10)), dim = daysInMonth(cur);
  const from = `${histStart}-01`;

  // Demand history (completed months + month-to-date).
  const demand = new Map();
  if (source === 'orders') await loadMonthlyQty(k, 'ORDR', 'RDR1', from, asOf, { warehouse, into: demand });
  else {
    await loadMonthlyQty(k, 'OINV', 'INV1', from, asOf, { warehouse, into: demand });
    if (await k.has('RIN1', 'ItemCode')) await loadMonthlyQty(k, 'ORIN', 'RIN1', from, asOf, { warehouse, sign: -1, into: demand });
  }
  const poHist = await loadMonthlyQty(k, 'OPOR', 'POR1', from, asOf, { warehouse });
  const po = await loadOpenPoLines(k, { warehouse, arrivalField: String(p.arrivalField || '').trim(), depositField: String(p.depositField || '').trim() });
  const items = await loadItems(k);
  const whs = warehouse ? new Map((await loadWarehouseStock(k, { warehouse })).map(r => [r.itemCode, r])) : null;
  const rules = await loadOrderRules(k);
  const overrides = agentSettingsRepo.get(k.company, SETTINGS_KEY).overrides || {};

  const supplyBy = new Map();
  for (const l of po.lines) {
    if (l.arrival && daysBetween(l.arrival, asOf) > staleDays) continue;               // stale: excluded from supply
    const mon = l.arrival && l.arrival.slice(0, 7) > cur ? l.arrival.slice(0, 7) : cur;   // late POs land in the current month
    if (!supplyBy.has(l.itemCode)) supplyBy.set(l.itemCode, new Map());
    const m = supplyBy.get(l.itemCode);
    m.set(mon, (m.get(mon) || 0) + l.openQty);
  }

  const codes = new Set([...demand.keys(), ...supplyBy.keys()]);
  const rows = [];
  const exOf = new Map();   // row → explanations (attached per tab after private fields are stripped)
  for (const code of codes) {
    const it = items.get(code);
    if (!it) continue;                                   // non-inventory lines
    if (groupFilter && !groupMatch(it.group)) continue;
    const dm = demand.get(code) || new Map();
    const full = histMonths.map(mo => Math.max(0, dm.get(mo) || 0));
    const mtd = Math.max(0, dm.get(cur) || 0);
    const firstNz = full.findIndex(v => v > 0);
    const y = firstNz < 0 ? [] : full.slice(firstNz);   // new items: start at first sale
    const model = y.length >= 4 && y.some(v => v > 0) ? fitSeries(y) : averageModel(y);
    const ov = overrides[code] || {};
    const zeroShare = y.length ? y.filter(v => v === 0).length / y.length : 1;

    const fc = planMonths.map((mo, i) => {
      const stat = Math.max(0, model.forecast(i + 1));
      const hw = model.halfWidth(i + 1, z);
      const manual = ov[mo] != null ? num(ov[mo]) : null;
      return { mo, stat, hw, value: manual ?? stat, lower: Math.max(0, (manual ?? stat) - hw), upper: (manual ?? stat) + hw, manual: manual != null };
    });
    const s = warehouse ? whs.get(code) : null;
    const onHand = s ? s.onHand : it.onHand;
    const committed = s ? s.committed : it.committed;
    const unitCost = (s?.avgPrice ?? null) || it.avgPrice || it.lastPurPrice || 0;
    const lt = it.leadTime > 0 ? it.leadTime : defaultLT;
    const horizonDemand = fc.reduce((a, f) => a + f.value, 0);
    const dailyFc = horizonDemand / planMonths.reduce((a, mo) => a + daysInMonth(mo), 0);
    const active = horizonDemand >= 0.5;                 // below this the plan is effectively zero
    if (!active) for (const f of fc) { f.hw = 0; f.lower = 0; f.upper = f.value; }   // dormant: no band
    const minInv = active ? Math.max(it.minLevel || 0, dailyFc * lt * (1 + marginPct / 100)) : 0;
    const sup = supplyBy.get(code) || new Map();

    // Projection with confirmed supply only, then lot-for-lot planned orders.
    let invC = onHand, invP = onHand, firstShort = null, firstBelowMin = null;
    const proj = [], plans = [];
    fc.forEach((f, i) => {
      const d = i === 0 ? Math.max(0, f.value - mtd) : f.value;
      const supply = sup.get(f.mo) || 0;
      invC += supply - d;
      invP += supply - d;
      if (active && invC < -1e-6 && !firstShort) firstShort = f.mo;
      if (active && invC < minInv - 1e-6 && !firstBelowMin) firstBelowMin = f.mo;
      let planned = 0;
      if (active && invP < minInv - 1e-6) {
        const projBefore = invP;
        planned = lotSize(minInv - invP, rules.get(code));
        invP += planned;
        const needBy = i === 0 ? asOf : `${f.mo}-01`;
        const orderBy = addDays(needBy, -lt);
        plans.push({ month: f.mo, qty: planned, needBy, orderBy, lateDays: Math.max(0, daysBetween(orderBy, asOf)), projBefore, minInv });
      }
      proj.push({ mo: f.mo, demand: d, supply, invC, invP, planned });
    });

    const expected = fc[0].value * (dom / dim);
    const pace = expected >= 1 ? (mtd / expected) * 100 : null;
    const paceStatus = pace == null ? 'NO PLAN' : pace > 125 ? 'FAST' : pace < 75 ? 'SLOW' : 'ON PLAN';
    const avgMonthly = horizonDemand / horizon;
    const cover = avgMonthly > 0 ? onHand / avgMonthly : null;
    const lastIdx = histMonths.length - 1;
    const lastActual = full[lastIdx];
    const lastFc = firstNz >= 0 && lastIdx >= firstNz ? model.fitted[lastIdx - firstNz] : null;
    const sumY = y.reduce((a, v) => a + v, 0);

    let status = 'OK';
    if (!active) status = 'NO DEMAND';
    else if (firstShort) status = 'STOCKOUT RISK';
    else if (firstBelowMin) status = 'BELOW MIN';
    else if (cover != null && cover > excessMonths) status = 'EXCESS';
    else if (y.length < 4) status = 'LOW DATA';

    const row = {
      itemCode: code, itemName: it.itemName, group: it.group, vendor: it.prefVendor, status, method: model.method,
      pattern: !y.length ? 'none' : zeroShare >= 0.5 ? 'intermittent' : model.gamma != null ? 'seasonal' : model.beta != null ? 'trend' : 'level',
      historyMonths: y.length, last3Avg: round(full.slice(-3).reduce((a, v) => a + v, 0) / 3, 2), histTotal: round(sumY, 2),
      onHand: round(onHand, 2), committed: round(committed, 2), openPo: round([...sup.values()].reduce((a, v) => a + v, 0), 2),
      leadTime: lt, leadTimeSource: it.leadTime > 0 ? 'item' : 'default', minInv: round(minInv, 2),
      horizonDemand: round(horizonDemand, 2), horizonLower: round(fc.reduce((a, f) => a + f.lower, 0), 2), horizonUpper: round(fc.reduce((a, f) => a + f.upper, 0), 2),
      horizonValue: round(horizonDemand * unitCost), unitCost: round(unitCost, 2), stockValue: round(onHand * unitCost),
      coverMonths: cover != null ? round(cover, 1) : null, firstShort: firstShort ? monthLabel(firstShort) : '', firstBelowMin: firstBelowMin ? monthLabel(firstBelowMin) : '',
      endInv: round(proj[proj.length - 1].invC, 2),
      mtd: round(mtd, 2), planThisMonth: round(fc[0].value, 2), expectedMtd: round(expected, 2), pace: pace != null ? round(pace, 1) : null, paceStatus,
      alpha: model.alpha, beta: model.beta, gamma: model.gamma, mae: model.mae != null ? round(model.mae, 2) : null, rmse: round(model.rmse, 2),
      smape: model.smape != null ? round(model.smape, 1) : null, mase: model.mase != null ? round(model.mase, 2) : null,
      biasPct: sumY > 0 && model.sumAbsErr ? round((model.sumErr / sumY) * 100, 1) : null,
      accuracyPct: sumY > 0 && model.sumAbsErr ? round(Math.max(0, 100 - (model.sumAbsErr / sumY) * 100), 1) : null,
      lastMonthActual: round(lastActual, 2), lastMonthPlan: lastFc != null ? round(Math.max(0, lastFc), 2) : null,
      lastMonthErrPct: lastFc != null && lastActual > 0 ? round(((lastActual - Math.max(0, lastFc)) / lastActual) * 100, 1) : null,
      overrides: Object.keys(ov).length, orderQty: plans.reduce((a, x) => a + x.qty, 0),
      _full: full, _y0: firstNz, _fitted: model.fitted, _fc: fc, _proj: proj, _plans: plans, _poHist: histMonths.map(mo => poHist.get(code)?.get(mo) || 0),
    };
    fc.forEach((f, i) => { row[`f${i}`] = round(f.value, 2); row[`p${i}`] = round(proj[i].invC, 2); });
    row.orderValue = round(row.orderQty * unitCost);
    rows.push(row);

    // Explanations (click a cell) — from the same values used above; attached per tab below.
    const n2 = v => round(v, 2), ltTxt = `${lt} d${it.leadTime > 0 ? '' : ' (default)'}`;
    const ex = {};
    const nHist = y.length;
    // Model bands as fitSeries/averageModel apply them; in the 6+ bands the AIC may still pick a simpler form.
    const band = !nHist ? 0 : nHist < 4 ? 1 : nHist < 6 ? 2 : nHist < 24 ? 3 : 4;
    ex.method = {
      steps: [
        { label: 'History used', value: `${nHist} months`, detail: firstNz >= 0 ? `from first sale, ${monthLabel(histMonths[firstNz])}` : 'no sales in the window' },
        ...(model.alpha != null ? [{ label: 'Alpha (level)', formula: 'weight on the latest month', value: model.alpha }] : []),
        ...(model.beta != null ? [{ label: 'Beta (trend)', formula: 'how fast the trend adapts', value: model.beta }] : []),
        ...(model.gamma != null ? [{ label: 'Gamma (season)', formula: 'how fast the seasonal pattern adapts', value: model.gamma }] : []),
        { label: 'Typical error (RMSE)', formula: model.alpha != null ? 'one-month-ahead fit error' : 'spread of monthly demand', value: n2(model.rmse) },
      ],
      rules: [
        ['No sales in the window', 'No history'],
        ['Under 4 months of history', 'Average (low data)'],
        ['4–5 months', 'Simple smoothing'],
        ['6–23 months', 'Simple or Holt (trend), lowest AIC'],
        ['24+ months', 'Simple, Holt or Holt-Winters (season), lowest AIC'],
      ].map(([rule, result], i) => (i === band ? { rule, result, hit: true } : { rule, result })),
      result: { label: 'Model used', value: model.method },
      note: model.alpha != null ? 'Weights = best fit from a test grid; AIC = fit error plus a penalty for extra parameters.' : undefined,
    };
    const statTotal = fc.reduce((a, x) => a + x.stat, 0), nManual = fc.filter(x => x.manual).length;
    ex.horizonDemand = {
      steps: [{ label: 'Statistical forecast', formula: `sum of ${horizon} monthly forecasts`, value: n2(statTotal) },
        ...(nManual ? [{ label: 'Manual overrides', value: `${nManual} month(s)`, detail: 'replace the statistical value' }] : []),
        { label: `Range (${conf}%)`, formula: `± ${z} × typical error, wider further out`, value: `${n2(row.horizonLower)} – ${n2(row.horizonUpper)}` }],
      result: { label: `${horizon}-month total`, value: n2(horizonDemand) },
    };
    const days = planMonths.reduce((a, mo) => a + daysInMonth(mo), 0);
    ex.minInv = active ? {
      steps: [{ label: 'Daily forecast', formula: `${horizon}-month forecast ÷ ${days} days`, value: round(dailyFc, 3), detail: `${n2(horizonDemand)} units` },
        { label: 'Lead-time demand', formula: 'daily forecast × lead time', value: n2(dailyFc * lt), detail: ltTxt },
        { label: 'Plus safety margin', formula: `× (1 + ${marginPct}%)`, value: n2(dailyFc * lt * (1 + marginPct / 100)) },
        { label: 'SAP min level', value: n2(it.minLevel || 0) }],
      result: { label: 'Min inventory (higher of the two)', value: n2(minInv) },
    } : { note: 'No forecast demand, so min inventory is 0.' };
    ex.p0 = { steps: [{ label: 'On hand', value: n2(onHand) }, { label: '+ PO supply this month', value: n2(proj[0].supply) },
      { label: '− Remaining forecast', formula: 'month forecast − sold so far', value: n2(proj[0].demand), detail: `${n2(fc[0].value)} − ${n2(mtd)}` }],
      result: { label: 'Projected end of month', value: n2(proj[0].invC) } };
    if (firstShort) {
      const upto = proj.findIndex(x => x.mo === firstShort);
      ex.firstShort = { steps: [{ label: 'On hand now', value: n2(onHand) },
        ...proj.slice(0, upto + 1).map(x => ({ label: monthLabel(x.mo), value: n2(x.invC), detail: `+${n2(x.supply)} PO − ${n2(x.demand)} forecast` }))],
        note: 'Each month: previous stock + confirmed PO supply − forecast. First month below 0 = stock-out.' };
    }
    const lowest = Math.min(...proj.map(x => x.invC));
    ex.status = { rules: rulesHit([
      [`${horizon}-month forecast below 0.5 units`, 'NO DEMAND'],
      ['Projected stock goes below 0 (confirmed POs only)', 'STOCKOUT RISK'],
      ['Projected stock goes below min inventory', 'BELOW MIN'],
      [`On hand covers more than ${excessMonths} months of forecast`, 'EXCESS'],
      ['Under 4 months of sales history', 'LOW DATA'],
      ['Otherwise', 'OK'],
    ], status), note: active ? `Lowest projected ${n2(lowest)}${firstShort ? ` (${monthLabel(firstShort)})` : ''}, min inventory ${n2(minInv)}, cover ${cover != null ? round(cover, 1) : '–'} months, history ${nHist} months.` : undefined };
    if (cover != null) ex.coverMonths = { steps: [{ label: 'Avg monthly forecast', formula: `${horizon}-month forecast ÷ ${horizon}`, value: n2(avgMonthly) },
      { label: 'Cover', formula: 'on hand ÷ avg monthly forecast', value: round(cover, 1), detail: `${n2(onHand)} ÷ ${n2(avgMonthly)}` }] };
    if (pace != null) ex.paceStatus = {
      steps: [{ label: 'Plan this month', value: n2(fc[0].value) },
        { label: 'Expected by today', formula: `plan × ${dom} ÷ ${dim} days`, value: n2(expected) },
        { label: 'Actual month-to-date', value: n2(mtd) },
        { label: 'Pace', formula: 'actual ÷ expected', value: `${round(pace, 1)}%` }],
      rules: rulesHit([['Pace above 125%', 'FAST'], ['Pace below 75%', 'SLOW'], ['75% – 125%', 'ON PLAN']], paceStatus),
    };
    if (row.accuracyPct != null) {
      ex.accuracyPct = { steps: [{ label: 'Total actual', value: n2(sumY), detail: `${nHist} months` },
        { label: 'Total absolute error', formula: 'Σ |actual − one-month-ahead forecast|', value: n2(model.sumAbsErr) },
        { label: 'Error % (WAPE)', formula: 'absolute error ÷ actual', value: `${round((model.sumAbsErr / sumY) * 100, 1)}%` }],
        result: { label: 'Accuracy = 100 − error % (min 0)', value: `${row.accuracyPct}%` } };
      ex.biasPct = { steps: [{ label: 'Net error', formula: 'Σ (actual − forecast)', value: n2(model.sumErr) },
        { label: 'Bias', formula: 'net error ÷ total actual', value: `${row.biasPct}%`, detail: `÷ ${n2(sumY)}` }],
        note: '+ = under-forecast (stock-out risk), − = over-forecast (cash tied up).' };
    }
    exOf.set(row, ex);
  }
  if (!rows.length) throw new AgentDataError(`No inventory items with ${source === 'orders' ? 'sales orders' : 'A/R invoices'} or open POs since ${from}${warehouse ? ` in ${warehouse}` : ''}.`);

  // ABC by forecast value over the horizon.
  const byVal = [...rows].sort((a, b) => b.horizonValue - a.horizonValue);
  const totVal = byVal.reduce((a, r) => a + r.horizonValue, 0) || 1;
  let cum = 0;
  for (const r of byVal) { cum += r.horizonValue; r.abc = r.horizonValue <= 0 ? '—' : cum / totVal <= 0.8 ? 'A' : cum / totVal <= 0.95 ? 'B' : 'C'; }

  // ── Procurement recommendations ───────────────────────────────────────────
  const recs = [];
  for (const r of rows) for (const pl of r._plans) {
    const urgency = pl.lateDays > 0 ? 'EXPEDITE' : daysBetween(asOf, pl.orderBy) <= 14 ? 'ORDER NOW' : 'PLANNED';
    const rule = rules.get(r.itemCode);
    // Explanations (click a cell). Later PLANNED orders carry only the qty one, to keep a long list light.
    const explain = { qty: { steps: [
      { label: 'Projected before order', formula: 'stock + PO supply − forecast (incl. earlier orders)', value: round(pl.projBefore, 2) },
      { label: 'Min inventory', value: round(pl.minInv, 2) },
      { label: 'Shortfall', formula: 'min inventory − projected', value: round(pl.minInv - pl.projBefore, 2) },
      { label: 'Order qty', formula: 'shortfall, at least min order qty, rounded up (order multiple)', value: pl.qty,
        detail: rule ? `min order ${rule.minOrder || 0}, multiple ${rule.multiple || 1}` : 'no min order / multiple' }] } };
    if (urgency !== 'PLANNED') {
      explain.orderBy = { steps: [{ label: 'Needed by', value: pl.needBy, detail: pl.needBy === asOf ? 'current month: today' : 'first day of the month' },
        { label: '− Lead time', value: `${r.leadTime} days`, detail: r.leadTimeSource === 'item' ? 'item master' : 'default' }],
        result: { label: 'Order by', value: pl.orderBy } };
      explain.urgency = { rules: rulesHit([['Order-by date already passed', 'EXPEDITE'], ['Order-by date within 14 days', 'ORDER NOW'], ['Later', 'PLANNED']], urgency),
        note: pl.lateDays > 0 ? `Order-by ${pl.orderBy} was ${pl.lateDays} days ago.` : `Order-by ${pl.orderBy} is in ${daysBetween(asOf, pl.orderBy)} days.` };
    }
    recs.push({
      itemCode: r.itemCode, itemName: r.itemName, abc: r.abc, vendor: r.vendor, month: monthLabel(pl.month), qty: pl.qty,
      value: round(pl.qty * r.unitCost), orderBy: pl.orderBy, needBy: pl.needBy, leadTime: r.leadTime, lateDays: pl.lateDays,
      urgency,
      note: pl.lateDays > 0 ? `Order-by date passed ${pl.lateDays}d ago — normal lead time cannot cover ${monthLabel(pl.month)}; expedite or split` : `Arrives for ${monthLabel(pl.month)} if ordered by ${pl.orderBy}`,
      explain,
    });
  }
  const urgRank = { EXPEDITE: 0, 'ORDER NOW': 1, PLANNED: 2 };
  recs.sort((a, b) => urgRank[a.urgency] - urgRank[b.urgency] || a.orderBy.localeCompare(b.orderBy) || b.value - a.value);

  // ── Open PO supply with RAG ───────────────────────────────────────────────
  const poRows = po.lines.filter(l => items.has(l.itemCode)).map(l => {
    const late = l.arrival && l.arrival < asOf;
    return {
      docNum: l.docNum, cardName: l.cardName, cardCode: l.cardCode, itemCode: l.itemCode, itemName: items.get(l.itemCode)?.itemName || '',
      openQty: round(l.openQty, 2), value: round(l.openQty * l.price), arrival: l.arrival, month: l.arrival ? monthLabel(l.arrival.slice(0, 7)) : '',
      arrivalStatus: late && daysBetween(l.arrival, asOf) > staleDays ? 'STALE' : late ? 'LATE' : daysBetween(asOf, l.arrival) <= 30 ? 'DUE 30D' : 'SCHEDULED', daysLate: late ? daysBetween(l.arrival, asOf) : null,
      deposit: l.deposit === undefined ? 'NOT TRACKED' : late ? '—' : l.deposit ? 'PAID' : 'NOT PAID', depositDate: l.deposit || '',
    };
  }).sort((a, b) => String(a.arrival).localeCompare(String(b.arrival)));

  // ── Timeline (focus item in qty, else all items in value) ─────────────────
  const focusRow = focus ? rows.find(r => r.itemCode.toLowerCase() === focus.toLowerCase()) : null;
  if (focus && !focusRow) throw new AgentDataError(`Item ${focus} has no demand or open POs in this window${groupFilter ? ' / group filter' : ''}.`);
  const showHist = histMonths.slice(-Math.min(historyMonths, 24));
  const offset = historyMonths - showHist.length;
  const buildTimeline = (set, w) => {
    const timeline = [];
    showHist.forEach((mo, j) => {
      const i = offset + j;
      let actual = 0, fitted = 0, hasFit = false, supply = 0;
      for (const r of set) {
        actual += r._full[i] * w(r);
        supply += r._poHist[i] * w(r);
        const fi = r._y0 >= 0 ? i - r._y0 : -1;
        const fv = fi >= 0 ? r._fitted[fi] : null;
        if (fv != null) { fitted += Math.max(0, fv) * w(r); hasFit = true; }
      }
      timeline.push({ month: monthLabel(mo), key: mo, phase: 'Actual', actual: round(actual), forecast: hasFit ? round(fitted) : null, lower: null, upper: null, supply: round(supply), inventory: null, planned: null });
    });
    planMonths.forEach((mo, i) => {
      // Item errors are treated as independent, so band half-widths add in quadrature.
      let f = 0, hw2 = 0, supply = 0, inv = 0, planned = 0;
      for (const r of set) {
        f += r._fc[i].value * w(r); hw2 += (r._fc[i].hw * w(r)) ** 2;
        supply += r._proj[i].supply * w(r); inv += r._proj[i].invC * w(r); planned += r._proj[i].planned * w(r);
      }
      timeline.push({ month: monthLabel(mo), key: mo, phase: i === 0 ? 'Current (MTD)' : 'Forecast', actual: i === 0 ? round(set.reduce((a, r) => a + r.mtd * w(r), 0)) : null,
        forecast: round(f), lower: round(Math.max(0, f - Math.sqrt(hw2))), upper: round(f + Math.sqrt(hw2)), supply: round(supply), inventory: round(inv), planned: round(planned) });
    });
    return timeline;
  };
  const chartSpec = (title, timeline, unit = 'qty') => ({
    title, type: 'bar', labels: timeline.map(t => t.month),
    desc: `Bars = actual demand and PO supply per month (${unit}); blue line = forecast with its ${conf}% range (light lines); orange line = projected inventory — watch for it dropping towards zero.`,
    series: [
      { name: 'Actual demand', values: timeline.map(t => t.actual), color: '#0F766E' },
      { name: 'Supply (PO)', values: timeline.map(t => t.supply), color: '#CBD5E1' },
      { name: 'Forecast', type: 'line', values: timeline.map(t => t.forecast), color: '#2563EB' },
      { name: `Lower ${conf}%`, type: 'line', values: timeline.map(t => t.lower), color: '#93C5FD' },
      { name: `Upper ${conf}%`, type: 'line', values: timeline.map(t => t.upper), color: '#93C5FD' },
      { name: 'Projected inventory', type: 'line', values: timeline.map(t => t.inventory), color: '#D97706' },
    ],
  });
  const timeline = focusRow ? buildTimeline([focusRow], () => 1) : buildTimeline(rows, r => r.unitCost);
  const unitWord = focusRow ? 'qty' : 'value';

  // ── KPIs ──────────────────────────────────────────────────────────────────
  const withHist = rows.filter(r => r.accuracyPct != null);
  const sumAbs = withHist.reduce((a, r) => a + (100 - r.accuracyPct) / 100 * r.histTotal * r.unitCost, 0);
  const sumErr = withHist.reduce((a, r) => a + (r.biasPct / 100) * r.histTotal * r.unitCost, 0);
  const sumAct = withHist.reduce((a, r) => a + r.histTotal * r.unitCost, 0) || 1;
  const accuracy = Math.max(0, 100 - (sumAbs / sumAct) * 100), bias = (sumErr / sumAct) * 100;
  const stockouts = rows.filter(r => r.status === 'STOCKOUT RISK');
  const belowMin = rows.filter(r => r.status === 'BELOW MIN');
  const excess = rows.filter(r => r.status === 'EXCESS');
  const nextValue = rows.reduce((a, r) => a + r.f0 * r.unitCost, 0);
  const horizonValue = rows.reduce((a, r) => a + r.horizonValue, 0);
  const poValue = poRows.filter(r => r.arrivalStatus !== 'STALE').reduce((a, r) => a + r.value, 0);
  const recValue = recs.reduce((a, r) => a + r.value, 0);
  const planMtdValue = rows.reduce((a, r) => a + r.expectedMtd * r.unitCost, 0);
  const mtdValue = rows.reduce((a, r) => a + r.mtd * r.unitCost, 0);
  const fast = rows.filter(r => r.paceStatus === 'FAST'), slow = rows.filter(r => r.paceStatus === 'SLOW');
  const latePo = poRows.filter(r => r.arrivalStatus === 'LATE');
  const stalePo = poRows.filter(r => r.arrivalStatus === 'STALE');
  const unpaid = poRows.filter(r => r.deposit === 'NOT PAID');

  // ── Tabs ──────────────────────────────────────────────────────────────────
  const idCols = [{ key: 'itemCode', label: 'Item', sub: 'itemName' },
    { key: 'abc', label: 'ABC', fmt: 'badge', badge: { A: 'purple', B: 'blue', C: 'grey' } }];
  const monthCols = (prefix, strongFirst) => planMonths.map((mo, i) => ({ key: `${prefix}${i}`, label: i === 0 ? `${monthLabel(mo)} (cur)` : monthLabel(mo), fmt: 'num', strong: strongFirst && i === 0 }));
  const STATUS_BADGE = { 'STOCKOUT RISK': 'red', 'BELOW MIN': 'amber', EXCESS: 'purple', 'LOW DATA': 'grey', OK: 'green', 'NO DEMAND': 'grey' };
  const riskRank = { 'STOCKOUT RISK': 0, 'BELOW MIN': 1, 'EXCESS': 2, 'LOW DATA': 3, OK: 4, 'NO DEMAND': 5 };
  const planRows = [...rows].sort((a, b) => b.horizonValue - a.horizonValue);
  const projRows = [...rows].sort((a, b) => riskRank[a.status] - riskRank[b.status] || 'ABC'.indexOf(a.abc) - 'ABC'.indexOf(b.abc) || b.horizonValue - a.horizonValue);
  const paceRows = rows.filter(r => r.paceStatus !== 'NO PLAN').sort((a, b) => Math.abs(100 - (b.pace ?? 100)) * b.planThisMonth * b.unitCost - Math.abs(100 - (a.pace ?? 100)) * a.planThisMonth * a.unitCost);
  const accRows = withHist.concat(rows.filter(r => r.accuracyPct == null)).sort((a, b) => b.histTotal * b.unitCost - a.histTotal * a.unitCost);
  const focusAct = { id: 'chart', label: 'Chart', kind: 'chart', endpoint: '/api/demand-forecast-agent/item', from: 'itemCode' };
  const overrideAct = { id: 'override', label: 'Override', kind: 'grid', load: '/api/demand-forecast-agent/item', endpoint: '/api/demand-forecast-agent/override', refresh: true,
    fields: [{ key: 'month', label: `Month (YYYY-MM, ${planMonths[0]} … ${planMonths[planMonths.length - 1]})`, default: planMonths[1] || planMonths[0] },
      { key: 'qty', label: 'Forecast qty (leave blank to clear that month)' }] };
  const clearAct = { id: 'clear', label: 'Clear overrides', kind: 'post', endpoint: '/api/demand-forecast-agent/override/clear', refresh: true, confirm: 'Remove all manual forecast overrides for {itemCode}?' };

  const tabs = [
    { key: 'plan', label: `Demand plan (${rows.length})`, rows: planRows, actions: [focusAct, overrideAct],
      desc: `Monthly demand forecast per item for the next ${horizon} months, largest plan value first — use Override to replace a month with your own figure.`,
      columns: [...idCols, { key: 'method', label: 'Model', sub: 'pattern' }, { key: 'last3Avg', label: 'Last 3m avg', fmt: 'num' },
        ...monthCols('f', true), { key: 'horizonDemand', label: `${horizon}m total`, fmt: 'num', strong: true },
        { key: 'horizonLower', label: `Low (${conf}%)`, fmt: 'num' }, { key: 'horizonUpper', label: `High (${conf}%)`, fmt: 'num' },
        { key: 'horizonValue', label: 'Plan value', fmt: 'amt' }, { key: 'overrides', label: 'Manual', fmt: 'int', hint: 'Months with a manual forecast override' }] },
    { key: 'projection', label: `Inventory projection (${stockouts.length + belowMin.length} at risk)`, rows: projRows, actions: [focusAct],
      desc: 'Projected stock at the end of each month (on hand + confirmed POs − forecast), riskiest items first — shows when an item runs out or drops below its minimum.',
      columns: [{ key: 'status', label: 'Status', fmt: 'badge', badge: STATUS_BADGE }, ...idCols, { key: 'onHand', label: 'On hand', fmt: 'num' },
        { key: 'committed', label: 'Committed (SO)', fmt: 'num', hint: 'Open sales orders — informational; the projection uses the forecast' },
        { key: 'openPo', label: 'Open PO', fmt: 'num' }, { key: 'minInv', label: 'Min inv.', fmt: 'num', hint: `Daily forecast × lead time × (1 + ${marginPct}%)` },
        ...monthCols('p', false), { key: 'firstShort', label: 'Stock-out' }, { key: 'coverMonths', label: 'Cover (m)', fmt: 'num' },
        { key: 'leadTime', label: 'Lead (d)', fmt: 'int', sub: 'leadTimeSource' }] },
    { key: 'orders', label: `Required orders (${recs.length})`, rows: recs, actions: [focusAct],
      desc: 'Purchase orders needed to keep stock at or above minimum inventory, most urgent first — place EXPEDITE and ORDER NOW lines today.',
      columns: [{ key: 'urgency', label: 'Urgency', fmt: 'badge', badge: { EXPEDITE: 'red', 'ORDER NOW': 'amber', PLANNED: 'blue' } }, ...idCols,
        { key: 'vendor', label: 'Pref. vendor' }, { key: 'month', label: 'Needed in' }, { key: 'qty', label: 'Order qty', fmt: 'num', strong: true },
        { key: 'value', label: 'Value', fmt: 'amt' }, { key: 'orderBy', label: 'Order by', fmt: 'date' }, { key: 'leadTime', label: 'Lead (d)', fmt: 'int' },
        { key: 'note', label: 'Note', wrap: true }] },
    { key: 'supply', label: `Open PO supply (${poRows.length})`, rows: poRows, actions: [focusAct],
      desc: `Open purchase-order lines by expected arrival — LATE lines count as this month’s supply, STALE (over ${staleDays} days late) are excluded; confirm ETAs with vendors.`,
      columns: [{ key: 'arrivalStatus', label: 'Arrival', fmt: 'badge', badge: { STALE: 'grey', LATE: 'red', 'DUE 30D': 'amber', SCHEDULED: 'green' } },
        { key: 'docNum', label: 'PO #' }, { key: 'cardName', label: 'Vendor', sub: 'cardCode' }, { key: 'itemCode', label: 'Item', sub: 'itemName' },
        { key: 'openQty', label: 'Open qty', fmt: 'num' }, { key: 'value', label: 'Value', fmt: 'amt' }, { key: 'arrival', label: 'Arrival date', fmt: 'date' },
        { key: 'daysLate', label: 'Days late', fmt: 'int' },
        { key: 'deposit', label: 'Deposit', fmt: 'badge', sub: 'depositDate', badge: { PAID: 'green', 'NOT PAID': 'red', 'NOT TRACKED': 'grey' } }] },
    { key: 'pace', label: `Live vs plan — ${monthLabel(cur)} (${fast.length} fast / ${slow.length} slow)`, rows: paceRows, actions: [focusAct],
      desc: `Sales so far in ${monthLabel(cur)} versus what the plan expected by day ${dom}, biggest deviations first — FAST items may run short, SLOW items may build stock.`,
      columns: [{ key: 'paceStatus', label: 'Pace', fmt: 'badge', badge: { FAST: 'red', SLOW: 'amber', 'ON PLAN': 'green' } }, ...idCols,
        { key: 'planThisMonth', label: 'Plan (month)', fmt: 'num' }, { key: 'expectedMtd', label: `Expected by day ${dom}`, fmt: 'num' },
        { key: 'mtd', label: 'Actual MTD', fmt: 'num', strong: true }, { key: 'pace', label: 'Pace %', fmt: 'pct' },
        { key: 'onHand', label: 'On hand', fmt: 'num' }, { key: 'status', label: 'Stock status', fmt: 'badge', badge: STATUS_BADGE }] },
    { key: 'accuracy', label: 'Forecast accuracy', rows: accRows, actions: [focusAct, clearAct],
      desc: 'How well the model fitted each item’s past sales (one month ahead), largest sellers first — treat items with low accuracy or large bias with caution.',
      columns: [...idCols, { key: 'method', label: 'Model', sub: 'pattern' }, { key: 'historyMonths', label: 'Months', fmt: 'int' },
        { key: 'alpha', label: 'Alpha', fmt: 'num' }, { key: 'beta', label: 'Beta', fmt: 'num' }, { key: 'gamma', label: 'Gamma', fmt: 'num' },
        { key: 'mae', label: 'MAE', fmt: 'num' }, { key: 'rmse', label: 'RMSE', fmt: 'num' }, { key: 'smape', label: 'SMAPE %', fmt: 'pct' }, { key: 'mase', label: 'MASE', fmt: 'num' },
        { key: 'accuracyPct', label: 'Accuracy %', fmt: 'pct', strong: true }, { key: 'biasPct', label: 'Bias %', fmt: 'pct', hint: '+ = under-forecast (stock-out risk), − = over-forecast (cash tied up)' },
        { key: 'lastMonthPlan', label: `${monthLabel(addMonths(cur, -1))} plan`, fmt: 'num' }, { key: 'lastMonthActual', label: 'Actual', fmt: 'num' },
        { key: 'lastMonthErrPct', label: 'Error %', fmt: 'pct' }] },
    { key: 'timeline', label: `Timeline — ${focusRow ? focusRow.itemCode : 'all items (value)'}`, rows: timeline,
      desc: `Month-by-month actuals, forecast, PO supply and projected inventory ${focusRow ? `for ${focusRow.itemCode} in quantity` : 'for all items in value (qty × item cost)'} — the data behind the chart.`,
      columns: [{ key: 'month', label: 'Month' }, { key: 'phase', label: 'Phase', fmt: 'badge', badge: { Actual: 'grey', 'Current (MTD)': 'amber', Forecast: 'blue' } },
        { key: 'actual', label: `Actual ${unitWord}`, fmt: 'num' }, { key: 'forecast', label: 'Forecast', fmt: 'num', strong: true },
        { key: 'lower', label: `Lower (${conf}%)`, fmt: 'num' }, { key: 'upper', label: `Upper (${conf}%)`, fmt: 'num' },
        { key: 'supply', label: 'Supply (PO)', fmt: 'num' }, { key: 'inventory', label: 'Projected inventory', fmt: 'num' },
        { key: 'planned', label: 'Required order', fmt: 'num' }] },
  ];
  // Column guide (hint per column; per-tab entries win over the shared ones).
  const monthHint = (prefix, i) => (prefix === 'f'
    ? (i === 0 ? `Forecast quantity for ${monthLabel(planMonths[0])} (current month, whole month incl. sales so far)` : `Forecast quantity for ${monthLabel(planMonths[i])} (manual override if set, else statistical)`)
    : (i === 0 ? `Projected stock at end of ${monthLabel(planMonths[0])} = on hand + PO supply − remaining forecast this month` : `Projected stock at end of ${monthLabel(planMonths[i])} = previous month + PO supply − forecast`));
  const COL_HINT = {
    itemCode: 'SAP item code and description', abc: 'Value class by forecast value: A = items making up the first 80% of plan value, B = next 15%, C = last 5%',
    method: 'Forecast model used (Average, Simple, Holt trend or Holt-Winters seasonal); sub-line = demand pattern', last3Avg: 'Average monthly demand of the last 3 completed months',
    horizonDemand: `Total forecast quantity over the ${horizon}-month horizon`, horizonLower: `Low end of the ${conf}% range for the ${horizon}-month total`,
    horizonUpper: `High end of the ${conf}% range for the ${horizon}-month total`, horizonValue: `${horizon}-month forecast quantity × item cost`,
    status: `STOCKOUT RISK (projected stock < 0), BELOW MIN (< min inventory), EXCESS (> ${excessMonths} months of cover), LOW DATA (< 4 months history), NO DEMAND or OK`,
    onHand: 'Quantity in stock now (SAP "In Stock")', openPo: `Open PO quantity counted as supply in the horizon (stale lines > ${staleDays} days late excluded)`,
    firstShort: 'First month the projected stock goes below zero (blank = no stock-out in the horizon)',
    coverMonths: 'Months the current stock lasts = on hand ÷ average monthly forecast',
    leadTime: `Days from order to receipt, from the item master; ${defaultLT} days assumed when not set (sub-line shows which)`,
    vendor: 'Preferred vendor on the item master',
  };
  const TAB_HINT = {
    orders: { urgency: 'EXPEDITE = order-by date already passed; ORDER NOW = order-by date within 14 days; PLANNED = later',
      month: 'Month in which the stock would fall below minimum inventory', qty: 'Shortfall to minimum inventory, at least the min order qty and rounded up to the order multiple',
      value: 'Order qty × item cost', orderBy: 'Latest date to place the order = needed-by date − lead time', leadTime: 'Lead time in days used for the order-by date', note: 'What to do and why' },
    supply: { arrivalStatus: `LATE = arrival date passed; STALE = over ${staleDays} days late (excluded from supply); DUE 30D = arrives within 30 days; SCHEDULED = later`,
      docNum: 'Purchase order number', cardName: 'Vendor on the purchase order', openQty: 'Quantity still to be received on the PO line',
      value: 'Open qty × PO line price', arrival: `Expected arrival date (${po.usedArrival})`, daysLate: 'Days past the expected arrival date',
      deposit: po.usedDeposit ? `Deposit recorded in ${po.usedDeposit}: PAID / NOT PAID (sub-line = deposit date); — for late lines` : 'Deposit tracking is off — set the "PO deposit UDF" option' },
    pace: { paceStatus: 'FAST = actual above 125% of expected; SLOW = below 75%; ON PLAN in between', planThisMonth: `Forecast for the whole of ${monthLabel(cur)}`,
      expectedMtd: `Plan × ${dom} ÷ ${dim} days — what should have been sold by today`, mtd: `Quantity actually ${source === 'orders' ? 'ordered' : 'invoiced (net of credit memos)'} so far this month`,
      pace: 'Actual MTD ÷ expected by today × 100', status: 'Stock status from the inventory projection' },
    accuracy: { historyMonths: 'Months of sales history used (from the first sale)', alpha: 'Level weight 0–1: higher = reacts faster to recent months',
      beta: 'Trend weight 0–1 (blank = no trend in the model)', gamma: 'Seasonal weight 0–1 (blank = no 12-month season)',
      mae: 'Mean absolute error: average miss per month, in units', rmse: 'Root mean squared error: typical miss per month, punishes big misses; drives the forecast range',
      smape: 'Symmetric mean absolute % error: average % miss per month (0 = perfect)', mase: 'Error vs a naive "same as last month" forecast: below 1 = better than naive',
      accuracyPct: '100 − (Σ |actual − forecast| ÷ Σ actual × 100), minimum 0', lastMonthPlan: 'What the model forecast for last month',
      lastMonthActual: 'Actual demand last month', lastMonthErrPct: '(actual − forecast) ÷ actual × 100 for last month' },
    projection: { minInv: `Higher of SAP min level and daily forecast × lead time × (1 + ${marginPct}% safety margin)` },
    timeline: { month: 'Calendar month', phase: 'Actual = completed month; Current (MTD) = this month so far; Forecast = future month',
      actual: `Actual demand ${unitWord}${focusRow ? '' : ' (qty × item cost)'}`, forecast: 'Model forecast (for past months: the one-month-ahead fitted value)',
      lower: `Low end of the ${conf}% range`, upper: `High end of the ${conf}% range`, supply: 'Purchase orders: placed (past months) or open arriving (future months)',
      inventory: 'Projected stock at month end with confirmed PO supply', planned: 'Quantity of required orders planned for that month' },
  };
  for (const t of tabs) t.columns = t.columns.map(c => {
    if (c.hint) return c;
    const m = /^([fp])(\d+)$/.exec(c.key);
    const hint = TAB_HINT[t.key]?.[c.key] ?? (m ? monthHint(m[1], Number(m[2])) : COL_HINT[c.key]);
    return hint ? { ...c, hint } : c;
  });
  const PROJ_DRILL = [{ key: 'status', label: 'Status', fmt: 'badge', badge: STATUS_BADGE }, { key: 'itemCode', label: 'Item', sub: 'itemName' }, { key: 'abc', label: 'ABC', fmt: 'badge' },
    { key: 'onHand', label: 'On hand', fmt: 'num' }, { key: 'openPo', label: 'Open PO', fmt: 'num' }, { key: 'minInv', label: 'Min inv.', fmt: 'num' },
    { key: 'firstShort', label: 'Stock-out' }, { key: 'horizonValue', label: 'Plan value', fmt: 'amt' }];

  // Keep each item's private series for /item before they are stripped from the payload.
  const priv = new Map(rows.map(r => [r.itemCode, { ...r }]));
  lastRuns.set(runKey(k.company, ctx.req), {
    at: Date.now(),
    item(code) {
      const r = priv.get(code);
      if (!r) return null;
      return {
        itemCode: r.itemCode, itemName: r.itemName, abc: r.abc, status: r.status, method: r.method,
        chart: chartSpec(`${r.itemCode} — ${r.itemName} (qty)`, buildTimeline([r], () => 1), 'qty'),
        months: planMonths.map((mo, i) => ({ key: mo, label: monthLabel(mo), stat: round(r._fc[i].stat, 2), value: round(r._fc[i].value, 2),
          manual: r._fc[i].manual, lower: round(r._fc[i].lower, 2), upper: round(r._fc[i].upper, 2), inventory: round(r._proj[i].invC, 2) })),
      };
    },
  });
  if (lastRuns.size > 50) lastRuns.delete(lastRuns.keys().next().value);
  for (const r of rows) for (const kk of Object.keys(r)) if (kk.startsWith('_')) delete r[kk];
  // Per-tab explanations (copies, so the shared row objects stay unchanged).
  const exKeys = { plan: ['method', 'horizonDemand'], projection: ['status', 'minInv', 'p0', 'firstShort', 'coverMonths'],
    pace: ['paceStatus'], accuracy: ['method', 'accuracyPct', 'biasPct'] };
  for (const t of tabs) if (exKeys[t.key]) t.rows = withExplain(t.rows, exOf, exKeys[t.key]);

  // ── Narrative ─────────────────────────────────────────────────────────────
  const topOut = [...stockouts].sort((a, b) => 'ABC'.indexOf(a.abc) - 'ABC'.indexOf(b.abc) || b.horizonValue - a.horizonValue)[0];
  const topRec = recs[0];
  const insight = `**${horizon}-month demand plan ${fmtAmt(horizonValue)} across ${rows.length} items; ${stockouts.length} items run out and ${belowMin.length} dip below min inventory on confirmed supply.**\n\n` +
    (topOut ? `- Most urgent: **${topOut.itemCode}** ${topOut.itemName} (class ${topOut.abc}) runs out in **${topOut.firstShort}** — on hand ${topOut.onHand}, open PO ${topOut.openPo}.\n` : '') +
    (topRec ? `- ${recs.filter(r => r.urgency !== 'PLANNED').length} orders to place now (${recs.filter(r => r.urgency === 'EXPEDITE').length} past their order-by date); total required ${fmtAmt(recValue)}.\n` : '') +
    `- Forecast accuracy ${round(accuracy, 1)}% with bias ${bias >= 0 ? '+' : ''}${round(bias, 1)}% (${bias >= 0 ? 'under-forecasting → stock-out risk' : 'over-forecasting → cash tied up'}).\n` +
    `- ${monthLabel(cur)} to day ${dom}: ${fmtAmt(mtdValue)} shipped vs ${fmtAmt(planMtdValue)} expected — ${fast.length} items selling fast, ${slow.length} slow.\n` +
    (latePo.length ? `- ${latePo.length} open PO lines are past their arrival date and counted as ${monthLabel(cur)} supply — confirm new ETAs.\n` : '') +
    (stalePo.length ? `- ${stalePo.length} open PO lines are over ${staleDays} days late and **excluded** from supply — close them in SAP or update the dates.\n` : '') +
    (unpaid.length ? `- ${unpaid.length} upcoming PO lines have no deposit recorded.\n` : '') +
    (excess.length ? `- ${excess.length} items hold more than ${excessMonths} months of cover (${fmtAmt(excess.reduce((a, r) => a + r.stockValue, 0))} stock value).\n` : '');

  const aiContext = `SUPPLY CHAIN DEMAND FORECAST as of ${asOf}${warehouse ? `, warehouse ${warehouse}` : ''}${groupFilter ? `, group ~ "${p.group}"` : ''}. Demand source: ${source === 'orders' ? 'sales orders' : 'A/R invoices net of credit memos'}. History ${historyMonths}m, horizon ${horizon}m (month 1 = ${monthLabel(cur)}, day ${dom}/${dim}), ${conf}% band, min inventory = daily forecast × lead time × (1+${marginPct}%).
Items ${rows.length}; plan value ${fmtAmt(horizonValue)}; next month value ${fmtAmt(nextValue)}; open PO value ${fmtAmt(poValue)}; required orders ${recs.length} (${fmtAmt(recValue)}); stock-out ${stockouts.length}; below min ${belowMin.length}; excess ${excess.length}; accuracy ${round(accuracy, 1)}%, bias ${round(bias, 1)}% (+ = under-forecast); MTD ${fmtAmt(mtdValue)} vs expected ${fmtAmt(planMtdValue)}; late PO lines ${latePo.length}; stale PO lines excluded ${stalePo.length}; unpaid deposits ${unpaid.length}.
AT RISK:
${ctxTable(projRows.filter(r => r.status === 'STOCKOUT RISK' || r.status === 'BELOW MIN'), [['itemCode', 'Item'], ['abc', 'ABC'], ['status', 'Status'], ['onHand', 'OnHand'], ['openPo', 'OpenPO'], ['minInv', 'MinInv'], ['firstShort', 'StockOut'], ['leadTime', 'LT']], 20)}
REQUIRED ORDERS:
${ctxTable(recs, [['urgency', 'Urgency'], ['itemCode', 'Item'], ['vendor', 'Vendor'], ['month', 'NeededIn'], ['qty', 'Qty'], ['value', 'Value'], ['orderBy', 'OrderBy']], 20)}
DEMAND PLAN (top by value):
${ctxTable(planRows, [['itemCode', 'Item'], ['method', 'Model'], ['last3Avg', 'Last3mAvg'], ['f0', monthLabel(planMonths[0])], ['f1', monthLabel(planMonths[1])], ['f2', monthLabel(planMonths[2])], ['horizonDemand', `${horizon}mTotal`], ['accuracyPct', 'Acc%'], ['biasPct', 'Bias%']], 20)}
PACE THIS MONTH:
${ctxTable(paceRows, [['itemCode', 'Item'], ['paceStatus', 'Pace'], ['planThisMonth', 'Plan'], ['mtd', 'MTD'], ['pace', 'Pace%']], 12)}
${latePo.length ? `LATE PO LINES:\n${ctxTable(latePo, [['docNum', 'PO'], ['cardName', 'Vendor'], ['itemCode', 'Item'], ['openQty', 'Qty'], ['daysLate', 'DaysLate'], ['deposit', 'Deposit']], 12)}` : ''}`;

  // ── KPI popups: chart, table and insight per KPI (same order as `kpis`) ──
  const sumv = (list, f) => list.reduce((a, r) => a + (typeof f === 'function' ? f(r) : num(r[f])), 0);
  const topBy = (list, key, n = 10) => [...list].sort((a, z) => num(z[key]) - num(a[key])).slice(0, n);
  const lbl = r => `${r.itemCode}${r.itemName ? ` · ${r.itemName}` : ''}`.slice(0, 44);
  const pctOf = (a, b) => (b ? round((a / b) * 100, 1) : 0);
  const ABC = ['A', 'B', 'C'];
  const STATUS_COLOR = { 'STOCKOUT RISK': '#DC2626', 'BELOW MIN': '#D97706', EXCESS: '#8B5CF6', 'LOW DATA': '#94A3B8', OK: '#16A34A', 'NO DEMAND': '#CBD5E1' };
  const ITEM = { key: 'itemCode', label: 'Item', sub: 'itemName' }, ABCCOL = { key: 'abc', label: 'ABC', fmt: 'badge' };
  const monthVals = planMonths.map((mo, i) => round(sumv(rows, r => num(r[`f${i}`]) * r.unitCost)));
  const peakIdx = monthVals.indexOf(Math.max(...monthVals));
  const nextVal = sumv(rows, r => num(r.f1) * r.unitCost);
  const top10Plan = topBy(rows, 'horizonValue');
  const nextRows = rows.filter(r => num(r.f1) > 0).map(r => ({ ...r, nextValue: round(num(r.f1) * r.unitCost) }));
  const jumps = nextRows.filter(r => r.last3Avg > 0 && r.f1 > r.last3Avg * 1.5);
  const PO_ST = ['SCHEDULED', 'DUE 30D', 'LATE', 'STALE'];
  const poByVendor = [...poRows.filter(r => r.arrivalStatus !== 'STALE').reduce((m, r) => m.set(r.cardName, (m.get(r.cardName) || 0) + r.value), new Map())].sort((a, z) => z[1] - a[1]);
  const shortMonths = planMonths.map(monthLabel);
  const recMonths = [...new Set(recs.map(r => r.month))].sort((a, b) => shortMonths.indexOf(a) - shortMonths.indexOf(b));
  const recByVendor = [...recs.reduce((m, r) => m.set(r.vendor || '(no preferred vendor)', (m.get(r.vendor || '(no preferred vendor)') || 0) + r.value), new Map())].sort((a, z) => z[1] - a[1]);
  const expedite = recs.filter(r => r.urgency === 'EXPEDITE');
  const errRows = withHist.map(r => ({ ...r, histValue: round(r.histTotal * r.unitCost), errValue: round((100 - r.accuracyPct) / 100 * r.histTotal * r.unitCost), biasValue: round(r.biasPct / 100 * r.histTotal * r.unitCost) }));
  const accBands = [['< 50%', r => r.accuracyPct < 50], ['50–70%', r => r.accuracyPct >= 50 && r.accuracyPct < 70], ['70–85%', r => r.accuracyPct >= 70 && r.accuracyPct < 85], ['≥ 85%', r => r.accuracyPct >= 85]];
  const biasBands = [['< −25%', r => r.biasPct < -25], ['−25…−10%', r => r.biasPct >= -25 && r.biasPct < -10], ['±10%', r => Math.abs(r.biasPct) <= 10], ['10…25%', r => r.biasPct > 10 && r.biasPct <= 25], ['> 25%', r => r.biasPct > 25]];
  const methodMix = [...withHist.reduce((m, r) => m.set(r.method, (m.get(r.method) || 0) + 1), new Map())].sort((a, z) => z[1] - a[1]);
  const paceImpact = paceRows.map(r => ({ ...r, impact: round(Math.abs(r.mtd - r.expectedMtd) * r.unitCost) }));
  const top10Pace = topBy(paceImpact, 'impact');
  const worstErr = topBy(errRows, 'errValue', 3);
  const underF = topBy(errRows.filter(r => r.biasPct > 10), 'biasValue', 2), overF = [...errRows.filter(r => r.biasPct < -10)].sort((a, z) => a.biasValue - z.biasValue).slice(0, 2);
  const firstOut = [...stockouts].sort((a, z) => shortMonths.indexOf(a.firstShort) - shortMonths.indexOf(z.firstShort) || 'ABC'.indexOf(a.abc) - 'ABC'.indexOf(z.abc))[0];
  const outNow = stockouts.filter(r => r.firstShort === monthLabel(cur));
  const KX = [
    { // Items planned
      chart: { title: 'Items by ABC class and stock status', type: 'bar', stacked: true, fmt: 'int', labels: ABC.map(c => `Class ${c}`),
        series: Object.keys(STATUS_COLOR).map(s => ({ name: s, color: STATUS_COLOR[s], values: ABC.map(c => rows.filter(r => r.abc === c && r.status === s).length) })) },
      columns: [ITEM, ABCCOL, { key: 'status', label: 'Status', fmt: 'badge' }, { key: 'method', label: 'Model', sub: 'pattern' }, { key: 'horizonValue', label: 'Plan value', fmt: 'amt' }, { key: 'accuracyPct', label: 'Accuracy', fmt: 'pct' }],
      title: 'Items by plan value',
      insight: `**${rows.length} items planned — ${rows.filter(r => r.abc === 'A').length} class-A items carry ${pctOf(sumv(rows.filter(r => r.abc === 'A'), 'horizonValue'), horizonValue)}% of the plan value.**\n\n` +
        `- Stock status: ${stockouts.length} stock-out risk, ${belowMin.length} below min, ${excess.length} excess, ${rows.filter(r => r.status === 'OK').length} OK.\n` +
        (top10Plan[0] ? `- Largest item: **${lbl(top10Plan[0])}** — plan ${fmtAmt(top10Plan[0].horizonValue)} (${top10Plan[0].method}).\n` : '') +
        (rows.filter(r => r.status === 'LOW DATA').length ? `- ${rows.filter(r => r.status === 'LOW DATA').length} items have too little history (LOW DATA) — review their forecasts or add overrides.` : '') },
    { // Demand plan
      chart: { title: `Plan value by month (${horizon} months)`, type: 'bar', labels: shortMonths, series: [{ name: 'Plan value', values: monthVals }] },
      columns: [ITEM, ABCCOL, { key: 'method', label: 'Model' }, { key: 'last3Avg', label: 'Last 3m avg', fmt: 'num' }, { key: 'horizonDemand', label: `${horizon}m qty`, fmt: 'num' }, { key: 'horizonValue', label: 'Plan value', fmt: 'amt' }],
      title: 'Biggest items in the plan',
      insight: `**${horizon}-month demand plan worth ${fmtAmt(horizonValue)}; the top 10 items make up ${pctOf(sumv(top10Plan, 'horizonValue'), horizonValue)}%.**\n\n` +
        (monthVals.length ? `- Peak month: **${shortMonths[peakIdx]}** at ${fmtAmt(monthVals[peakIdx])}; average ${fmtAmt(horizonValue / horizon)} per month.\n` : '') +
        (top10Plan[0] ? `- Largest item: **${lbl(top10Plan[0])}** — ${fmtAmt(top10Plan[0].horizonValue)} (${pctOf(top10Plan[0].horizonValue, horizonValue)}%).\n` : '') +
        `- ${rows.filter(r => r.overrides > 0).length} items carry manual overrides; the rest use the statistical forecast.` },
    { // Next month plan
      chart: { title: `Top 10 items — ${monthLabel(planMonths[1] || cur)} plan value`, type: 'bar', horizontal: true, labels: topBy(nextRows, 'nextValue').map(lbl), series: [{ name: 'Plan value', values: topBy(nextRows, 'nextValue').map(r => r.nextValue) }] },
      rows: nextRows, sortBy: 'nextValue', columns: [ITEM, ABCCOL, { key: 'last3Avg', label: 'Last 3m avg', fmt: 'num' }, { key: 'f1', label: 'Forecast qty', fmt: 'num' }, { key: 'nextValue', label: 'Value', fmt: 'amt' }, { key: 'method', label: 'Model' }],
      title: `Items planned for ${monthLabel(planMonths[1] || cur)}`,
      insight: `**${monthLabel(planMonths[1] || cur)} plan: ${fmtAmt(nextVal)} across ${nextRows.length} items (${nextValue ? `${nextVal >= nextValue ? '+' : ''}${pctOf(nextVal - nextValue, nextValue)}% vs ${monthLabel(cur)}` : 'no current-month plan'}).**\n\n` +
        (nextRows.length ? `- Largest: **${lbl(topBy(nextRows, 'nextValue', 1)[0])}** — ${fmtAmt(topBy(nextRows, 'nextValue', 1)[0].nextValue)}.\n` : '') +
        (jumps.length ? `- ${jumps.length} items are forecast 50%+ above their last-3-month average — confirm the demand before buying (e.g. **${lbl(jumps[0])}**: ${round(jumps[0].f1, 1)} vs ${round(jumps[0].last3Avg, 1)}).` : '- No item jumps more than 50% above its recent average.') },
    { // Open PO supply
      chart: { title: 'Open PO value by arrival status', type: 'bar', labels: PO_ST,
        series: [{ name: 'Value', values: PO_ST.map(s => round(sumv(poRows.filter(r => r.arrivalStatus === s), 'value'))) }] },
      columns: [{ key: 'docNum', label: 'PO #' }, { key: 'cardName', label: 'Vendor', sub: 'cardCode' }, ITEM, { key: 'value', label: 'Value', fmt: 'amt' }, { key: 'arrival', label: 'Arrival', fmt: 'date' }, { key: 'arrivalStatus', label: 'Status', fmt: 'badge' }, { key: 'daysLate', label: 'Days late', fmt: 'int' }],
      title: 'Open PO lines counted as supply',
      insight: `**${fmtAmt(poValue)} of open PO supply; ${latePo.length} lines (${fmtAmt(sumv(latePo, 'value'))}) are already late.**\n\n` +
        (poByVendor[0] ? `- Biggest supplier: **${poByVendor[0][0]}** — ${fmtAmt(poByVendor[0][1])} (${pctOf(poByVendor[0][1], poValue)}%).\n` : '') +
        (stalePo.length ? `- ${stalePo.length} stale lines (${fmtAmt(sumv(stalePo, 'value'))}) are more than ${staleDays} days late and left out — close them or update the dates in SAP.\n` : '') +
        (latePo.length ? `- Ask vendors for new ETAs on the late lines; they are counted as ${monthLabel(cur)} supply.` : '- All counted lines are on schedule.') },
    { // Stock-out risk
      chart: { title: 'Stock-outs by month of first shortage', type: 'bar', fmt: 'int', labels: shortMonths, stacked: true,
        series: ABC.map((c, i) => ({ name: `Class ${c}`, color: ['#DC2626', '#F59E0B', '#94A3B8'][i], values: shortMonths.map(m => stockouts.filter(r => r.firstShort === m && r.abc === c).length) })) },
      title: 'Items that run out',
      insight: stockouts.length ? `**${stockouts.length} items run out within ${horizon} months on current stock + POs; ${outNow.length} already this month.**\n\n` +
        (firstOut ? `- First to run out: **${lbl(firstOut)}** (class ${firstOut.abc}) in **${firstOut.firstShort}** — on hand ${firstOut.onHand}, open PO ${firstOut.openPo}.\n` : '') +
        `- Class A: ${stockouts.filter(r => r.abc === 'A').length}, B: ${stockouts.filter(r => r.abc === 'B').length}, C: ${stockouts.filter(r => r.abc === 'C').length}.\n` +
        `- ${expedite.length} required orders are past their order-by date — see Required orders and expedite them.` : '**No item is projected to run out in the horizon.**' },
    { // Below min
      chart: { title: 'Items below min, by month first below min', type: 'bar', fmt: 'int', labels: shortMonths, series: [{ name: 'Items', values: shortMonths.map(m => belowMin.filter(r => r.firstBelowMin === m).length) }] },
      title: 'Items dipping below min inventory',
      insight: belowMin.length ? `**${belowMin.length} items stay in stock but drop below their min inventory.**\n\n` +
        (topBy(belowMin, 'horizonValue', 1)[0] ? `- Most valuable: **${lbl(topBy(belowMin, 'horizonValue', 1)[0])}** — first below min in ${topBy(belowMin, 'horizonValue', 1)[0].firstBelowMin || 'the horizon'}.\n` : '') +
        `- Class A: ${belowMin.filter(r => r.abc === 'A').length}. Min = daily forecast × lead time × (1 + ${marginPct}%).\n- Place the PLANNED orders on time to restore the buffer.` : '**No item drops below its min inventory.**' },
    { // Required orders
      chart: { title: 'Required order value by month needed', type: 'bar', stacked: true, labels: recMonths,
        series: [['EXPEDITE', '#DC2626'], ['ORDER NOW', '#F59E0B'], ['PLANNED', '#2563EB']].map(([u, color]) => ({ name: u, color, values: recMonths.map(m => round(sumv(recs.filter(r => r.month === m && r.urgency === u), 'value'))) })) },
      columns: [{ key: 'urgency', label: 'Urgency', fmt: 'badge' }, ITEM, { key: 'vendor', label: 'Vendor' }, { key: 'qty', label: 'Qty', fmt: 'num' }, { key: 'value', label: 'Value', fmt: 'amt' }, { key: 'orderBy', label: 'Order by', fmt: 'date' }],
      title: 'Orders to place',
      insight: recs.length ? `**${fmtAmt(recValue)} of orders needed (${recs.length} lines); ${expedite.length} lines worth ${fmtAmt(sumv(expedite, 'value'))} are already past their order-by date.**\n\n` +
        (recByVendor[0] ? `- Largest vendor: **${recByVendor[0][0]}** — ${fmtAmt(recByVendor[0][1])}.\n` : '') +
        (recs[0] ? `- First to order: **${lbl(recs[0])}** — ${recs[0].qty} by ${recs[0].orderBy} (${recs[0].urgency}).\n` : '') +
        `- ${recs.filter(r => r.urgency === 'ORDER NOW').length} lines must be ordered within 14 days.` : '**No orders needed — projected stock stays above min inventory.**' },
    { // Accuracy
      chart: { title: 'Items by forecast accuracy', type: 'bar', fmt: 'int', labels: accBands.map(b => b[0]), series: [{ name: 'Items', values: accBands.map(([, t]) => withHist.filter(t).length) }] },
      rows: errRows, sortBy: 'errValue', columns: [ITEM, ABCCOL, { key: 'method', label: 'Model' }, { key: 'accuracyPct', label: 'Accuracy', fmt: 'pct' }, { key: 'histValue', label: 'History value', fmt: 'amt' }, { key: 'errValue', label: 'Error value', fmt: 'amt' }],
      title: 'Items contributing most forecast error',
      insight: `**Forecast accuracy ${round(accuracy, 1)}% (value weighted) — ${accuracy >= 70 ? 'reliable for planning' : accuracy >= 50 ? 'usable, but keep safety stock' : 'weak; rely on buffers and review'}.**\n\n` +
        (worstErr.length ? `- Biggest error contributors: ${worstErr.map(r => `**${r.itemCode}** (${round(r.accuracyPct, 1)}%, ${fmtAmt(r.errValue)})`).join(', ')}.\n` : '') +
        `- ${withHist.filter(r => r.accuracyPct < 50).length} of ${withHist.length} measured items are below 50%.\n` +
        (methodMix.length ? `- Models used: ${methodMix.slice(0, 3).map(([m, n]) => `${m} ${n}`).join(', ')}.` : '') },
    { // Bias
      chart: { title: 'Items by forecast bias', type: 'bar', fmt: 'int', labels: biasBands.map(b => b[0]), series: [{ name: 'Items', values: biasBands.map(([, t]) => withHist.filter(t).length) }] },
      rows: errRows, sortBy: 'biasValue', columns: [ITEM, ABCCOL, { key: 'biasPct', label: 'Bias', fmt: 'pct' }, { key: 'histValue', label: 'History value', fmt: 'amt' }, { key: 'biasValue', label: 'Bias value', fmt: 'amt' }, { key: 'method', label: 'Model' }],
      title: 'Items with the largest bias',
      insight: `**Bias ${bias >= 0 ? '+' : ''}${round(bias, 1)}% — the plan ${Math.abs(bias) <= 10 ? 'is balanced' : bias > 0 ? 'under-forecasts demand (stock-out risk)' : 'over-forecasts demand (cash tied up in stock)'}.**\n\n` +
        (underF.length ? `- Under-forecast most: ${underF.map(r => `**${r.itemCode}** (+${round(r.biasPct, 1)}%)`).join(', ')}.\n` : '') +
        (overF.length ? `- Over-forecast most: ${overF.map(r => `**${r.itemCode}** (${round(r.biasPct, 1)}%)`).join(', ')}.\n` : '') +
        `- Consider overrides for items consistently outside ±25%.` },
    { // MTD pace
      chart: { title: `Expected vs actual to day ${dom} (top 10 gaps)`, type: 'bar', horizontal: true, labels: top10Pace.map(lbl),
        series: [{ name: 'Expected', values: top10Pace.map(r => round(r.expectedMtd * r.unitCost)), color: '#94A3B8' }, { name: 'Actual', values: top10Pace.map(r => round(r.mtd * r.unitCost)) }] },
      rows: paceImpact, sortBy: 'impact', columns: [{ key: 'paceStatus', label: 'Pace', fmt: 'badge' }, ITEM, { key: 'expectedMtd', label: 'Expected qty', fmt: 'num' }, { key: 'mtd', label: 'Actual qty', fmt: 'num' }, { key: 'pace', label: 'Pace', fmt: 'pct' }, { key: 'impact', label: 'Gap value', fmt: 'amt' }],
      title: 'Largest gaps vs plan this month',
      insight: `**${monthLabel(cur)} to day ${dom}: ${fmtAmt(mtdValue)} actual vs ${fmtAmt(planMtdValue)} expected (${planMtdValue ? `${round(mtdValue / planMtdValue * 100, 1)}%` : 'no plan'}).**\n\n` +
        (fast[0] ? `- Selling fast (${fast.length}): e.g. **${lbl(topBy(fast, 'pace', 1)[0])}** at ${topBy(fast, 'pace', 1)[0].pace}% — check stock cover.\n` : '') +
        (slow[0] ? `- Selling slow (${slow.length}): e.g. **${lbl([...slow].sort((a, z) => a.pace - z.pace)[0])}** at ${[...slow].sort((a, z) => a.pace - z.pace)[0].pace}% — consider delaying POs.\n` : '') +
        `- ${paceRows.filter(r => r.paceStatus === 'ON PLAN').length} items are on plan (75–125%).` },
  ];

  return {
    kpis: [
      { label: 'Items planned', value: rows.length, fmt: 'int', hint: 'Inventory items with demand or open POs',
        calc: { formula: `Count of inventory items (OITM) with demand in the last ${historyMonths} months or an open PO line${warehouse ? `, warehouse ${warehouse}` : ''}${groupFilter ? `, group ~ "${p.group}"` : ''}.`,
          steps: ['Non-inventory lines are skipped.', 'Each item gets its own forecast model, chosen by AIC from simple / Holt / Holt-Winters exponential smoothing.', 'ABC class by plan value: A = top 80%, B = next 15%, C = rest.'],
          sources: [SRC.demand(source), SRC.oitm, SRC.por], tab: 'plan', sortBy: 'horizonValue',
          stats: [...['A', 'B', 'C'].map(c => ({ label: `Class ${c}`, value: rows.filter(r => r.abc === c).length, fmt: 'int' })),
            { label: 'Low data', value: rows.filter(r => r.status === 'LOW DATA').length, fmt: 'int' }, { label: 'No demand', value: rows.filter(r => r.status === 'NO DEMAND').length, fmt: 'int' }] } },
      { label: `Demand plan (${horizon}m)`, value: horizonValue, fmt: 'amt', hint: 'Forecast qty × item cost',
        calc: { formula: `Σ items Σ months (forecast qty × item unit cost) over ${horizon} months starting ${monthLabel(cur)}. Manual overrides replace the statistical forecast for that month.`,
          steps: [`History: ${source === 'orders' ? 'sales-order qty' : 'A/R invoice qty − credit memo qty'} per month, inventory UoM.`, 'Exponential smoothing per item (like Excel FORECAST.ETS), trend damped φ = 0.98.', `Band = ±${Z[conf]} × RMSE (${conf}%), widened by horizon.`],
          sources: [SRC.demand(source), SRC.oitm, SRC.ovr], tab: 'plan', sortBy: 'horizonValue',
          stats: [{ label: 'Next month value', value: round(rows.reduce((a, r) => a + (r.f1 ?? 0) * r.unitCost, 0)), fmt: 'amt' }, { label: 'Current month value', value: round(nextValue), fmt: 'amt' },
            { label: 'Class A share', value: horizonValue ? round(rows.filter(r => r.abc === 'A').reduce((a, r) => a + r.horizonValue, 0) / horizonValue * 100, 1) : 0, fmt: 'pct' },
            { label: 'Items with overrides', value: rows.filter(r => r.overrides > 0).length, fmt: 'int' }] } },
      { label: `Plan ${monthLabel(planMonths[1] || cur)}`, value: rows.reduce((a, r) => a + (r.f1 ?? 0) * r.unitCost, 0), fmt: 'amt', hint: 'Next month forecast × cost',
        calc: { formula: `Σ (forecast qty for ${monthLabel(planMonths[1] || cur)} × item unit cost).`, sources: [SRC.demand(source), SRC.oitm, SRC.ovr],
          tab: 'plan', filter: r => r.f1 > 0, sortBy: 'f1',
          columns: [{ key: 'itemCode', label: 'Item', sub: 'itemName' }, { key: 'abc', label: 'ABC', fmt: 'badge' }, { key: 'last3Avg', label: 'Last 3m avg', fmt: 'num' }, { key: 'f1', label: 'Forecast qty', fmt: 'num' }, { key: 'horizonValue', label: 'Plan value', fmt: 'amt' }, { key: 'method', label: 'Model' }] } },
      { label: 'Open PO supply', value: poValue, fmt: 'amt', tone: latePo.length ? 'warn' : '' , hint: `Excludes stale lines; ${latePo.length} lines late`,
        calc: { formula: `Σ open PO line qty × price, excluding lines more than ${staleDays} days past arrival (stale).`,
          steps: [`Arrival date from ${po.usedArrival}.`, 'Late lines (arrival passed) count as current-month supply.', `Stale lines (> ${staleDays} days late) are excluded from supply.`],
          sources: [SRC.por], tab: 'supply', sortBy: 'value', filter: r => r.arrivalStatus !== 'STALE',
          stats: ['SCHEDULED', 'DUE 30D', 'LATE', 'STALE'].map(s => ({ label: `${s} lines`, value: poRows.filter(r => r.arrivalStatus === s).length, fmt: 'int' }))
            .concat([{ label: 'Deposit not paid', value: unpaid.length, fmt: 'int' }]) } },
      { label: 'Stock-out risk', value: stockouts.length, fmt: 'int', tone: stockouts.length ? 'bad' : 'good', hint: 'Projected inventory falls below zero',
        calc: { formula: 'Count of items whose projected inventory (on hand + PO supply − forecast) goes below zero within the horizon.',
          steps: ['Projection per month = previous + PO arrivals − forecast (current month: remaining forecast only).', 'Status order: STOCKOUT RISK → BELOW MIN → EXCESS → LOW DATA → OK.'],
          sources: [SRC.oitw, SRC.por, SRC.demand(source)], tab: 'projection', filter: r => r.status === 'STOCKOUT RISK', columns: PROJ_DRILL, sortBy: 'horizonValue',
          stats: [...['A', 'B', 'C'].map(c => ({ label: `Class ${c}`, value: stockouts.filter(r => r.abc === c).length, fmt: 'int' })),
            { label: 'Out this month', value: stockouts.filter(r => r.firstShort === monthLabel(cur)).length, fmt: 'int' }] } },
      { label: 'Below min inventory', value: belowMin.length, fmt: 'int', tone: belowMin.length ? 'warn' : 'good', hint: 'Projection dips below min level',
        calc: { formula: `Count of items whose projection stays ≥ 0 but drops below min inventory = max(SAP min level, daily forecast × lead time × (1 + ${marginPct}%)).`,
          steps: [`Lead time from the item master, else ${defaultLT} days.`], sources: [SRC.oitw, SRC.oitm, SRC.por], tab: 'projection', filter: r => r.status === 'BELOW MIN', columns: PROJ_DRILL, sortBy: 'horizonValue',
          stats: ['A', 'B', 'C'].map(c => ({ label: `Class ${c}`, value: belowMin.filter(r => r.abc === c).length, fmt: 'int' })) } },
      { label: 'Required order value', value: recValue, fmt: 'amt', tone: recs.some(r => r.urgency === 'EXPEDITE') ? 'bad' : '', hint: 'Orders needed to stay above min',
        calc: { formula: 'Σ (order qty × unit cost) of required orders. Order qty = shortfall vs min inventory, at least the min order qty, rounded up to the order multiple.',
          steps: ['Order by = needed-by date − lead time.', 'Urgency: order-by passed → EXPEDITE; within 14 days → ORDER NOW; later → PLANNED.'],
          sources: [SRC.oitw, SRC.oitm, SRC.por, SRC.rules], tab: 'orders', sortBy: 'value',
          stats: ['EXPEDITE', 'ORDER NOW', 'PLANNED'].map(u => ({ label: u, value: round(recs.filter(r => r.urgency === u).reduce((a, r) => a + r.value, 0)), fmt: 'amt' }))
            .concat([{ label: 'Order lines', value: recs.length, fmt: 'int' }]) } },
      { label: 'Forecast accuracy', value: accuracy, fmt: 'pct', tone: accuracy >= 70 ? 'good' : accuracy >= 50 ? 'warn' : 'bad', hint: '100 − WAPE, value weighted, in-sample one-step-ahead',
        calc: { formula: 'Accuracy = 100 − WAPE, where WAPE = Σ |forecast − actual| × cost ÷ Σ actual × cost over the fitted history (value weighted).',
          steps: ['One-step-ahead fitted values vs actual demand on completed months.', 'Items without enough history are excluded.', '≥ 70% green, 50–70% amber, < 50% red.'],
          sources: [SRC.demand(source), SRC.oitm], tab: 'accuracy', sortBy: 'accuracyPct', filter: r => r.accuracyPct != null,
          stats: [{ label: 'Items measured', value: withHist.length, fmt: 'int' }, { label: 'Items < 50%', value: withHist.filter(r => r.accuracyPct < 50).length, fmt: 'int' },
            { label: 'Items ≥ 70%', value: withHist.filter(r => r.accuracyPct >= 70).length, fmt: 'int' }, { label: 'History value', value: round(sumAct), fmt: 'amt' }] } },
      { label: 'Forecast bias', value: bias, fmt: 'pct', tone: Math.abs(bias) <= 10 ? 'good' : 'warn', hint: '+ under-forecast / − over-forecast',
        calc: { formula: 'Bias = Σ (actual − forecast) × cost ÷ Σ actual × cost. + means under-forecasting (stock-out risk), − means over-forecasting (cash tied up).',
          sources: [SRC.demand(source), SRC.oitm], tab: 'accuracy', sortBy: 'biasPct', filter: r => r.biasPct != null,
          stats: [{ label: 'Under-forecast items', value: withHist.filter(r => r.biasPct > 10).length, fmt: 'int' }, { label: 'Over-forecast items', value: withHist.filter(r => r.biasPct < -10).length, fmt: 'int' },
            { label: 'Within ±10%', value: withHist.filter(r => Math.abs(r.biasPct) <= 10).length, fmt: 'int' }] } },
      { label: `MTD pace ${monthLabel(cur)}`, value: planMtdValue > 0 ? (mtdValue / planMtdValue) * 100 : null, fmt: 'pct', hint: `Actual to day ${dom} vs expected`,
        calc: { formula: `Pace = actual month-to-date value ÷ expected-by-day-${dom} value × 100. Expected = this month's plan × ${dom}/${dim} days.`,
          steps: ['Per item: pace > 125% → FAST, < 75% → SLOW, otherwise ON PLAN.', 'Items expecting less than 1 unit so far are left out (NO PLAN).'],
          sources: [SRC.demand(source), SRC.oitm], tab: 'pace',
          stats: [{ label: 'Actual MTD value', value: round(mtdValue), fmt: 'amt' }, { label: 'Expected MTD value', value: round(planMtdValue), fmt: 'amt' },
            { label: 'Fast items', value: fast.length, fmt: 'int' }, { label: 'Slow items', value: slow.length, fmt: 'int' }] } },
    ].map((k, i) => (KX[i] ? { ...k, calc: { ...k.calc, ...KX[i] } } : k)),
    chart: chartSpec(focusRow ? `${focusRow.itemCode} — ${focusRow.itemName} (qty)` : 'All items — demand, supply & projected inventory (value)', timeline, focusRow ? 'qty' : 'value at item cost'),
    tabs, insight, aiContext,
    paramsOut: { item: focusRow ? focusRow.itemCode : '' },
    notes: [
      `Actual demand = ${source === 'orders' ? 'sales-order quantity by posting month' : 'A/R invoice quantity − A/R credit memos by posting month'} (inventory UoM)${warehouse ? `, warehouse ${warehouse}` : ''}. ${monthLabel(cur)} is month-to-date; models are fitted on completed months only.`,
      `Forecast = exponential smoothing per item (Holt-Winters with 12-month season when ≥ 24 months of history, else Holt trend or simple; chosen by AIC, trend damped φ=${PHI}), like Excel FORECAST.ETS. Band = ±${Z[conf]}·RMSE widened by horizon. Accuracy/bias are in-sample one-step-ahead.`,
      `Supply = open PO quantity by arrival (${po.usedArrival}); late POs count in ${monthLabel(cur)}; lines more than ${staleDays} days late are treated as stale and excluded. Deposit RAG ${po.usedDeposit ? `from ${po.usedDeposit}` : 'is off — set "PO deposit UDF" (e.g. U_DepositDate)'}. Projection = on hand + supply − forecast (remaining forecast for ${monthLabel(cur)}).`,
      `Min inventory = max(SAP min level, daily forecast × lead time × (1 + ${marginPct}%)); lead time from the item master, else ${defaultLT} days. Required orders are lot-for-lot, rounded up to the item's minimum order qty / order multiple.`,
    ],
  };
}

export function createDemandForecastAgentRouter(deps) {
  return createInsightRouter(deps, {
    slug: 'scforecast', title: 'Supply Chain Demand Forecast Agent',
    defaults: { historyMonths: 36, horizonMonths: 12, confidence: 95, safetyMarginPct: 25, defaultLeadTime: 30, excessMonths: 6, stalePoDays: 180, demandSource: 'invoices' },
    persona: 'You are an S&OP demand and supply planner for a company running SAP Business One.',
    aiTask: 'Review this demand & supply forecast for the S&OP meeting. Summarise the rolling demand plan, which items will stock out or fall below minimum inventory and when, what must be ordered now (quantities, vendors, order-by dates), items selling faster or slower than plan this month, late POs and unpaid deposits, and where the forecast is least reliable.',
    run,
    extra(router, h) {
      const company = () => h.kit().company;
      const fail = (res, e) => res.status(e instanceof AgentDataError ? 400 : 500).json({ ok: false, error: e.message });

      // Filter-bar pick lists: inventory items, item groups, warehouses (cached 10 min per company).
      const lookupCache = new Map();
      router.post('/lookups', h.requireAuth, async (req, res) => {
        try {
          const k = h.kit();
          const hit = lookupCache.get(k.company);
          if (hit && Date.now() - hit.at < 600_000) return res.json({ ok: true, ...hit.data });
          const items = await loadItems(k);
          const groups = [...new Set([...items.values()].map(i => i.group).filter(Boolean))].sort((a, b) => a.localeCompare(b));
          let warehouses = [];
          if (await k.has('OWHS', 'WhsName')) warehouses = (await k.run(`SELECT {WhsCode}, {WhsName} FROM @OWHS`)).map(r => ({ code: r.WhsCode, name: r.WhsName || '' }));
          const data = {
            items: [...items.values()].map(i => ({ code: i.itemCode, name: i.itemName, group: i.group })).sort((a, b) => a.code.localeCompare(b.code)),
            groups, warehouses,
          };
          lookupCache.set(k.company, { at: Date.now(), data });
          res.json({ ok: true, ...data });
        } catch (e) { fail(res, e); }
      });

      // One item's chart + monthly forecast (statistical vs manual) from the last Analyze.
      router.post('/item', h.requireAuth, (req, res) => {
        try {
          const code = String(req.body?.itemCode || req.body?.row?.itemCode || '').trim();
          if (!code) return res.status(400).json({ ok: false, error: 'Item required.' });
          const last = lastRuns.get(runKey(company(), req));
          if (!last) return res.status(400).json({ ok: false, error: 'Run Analyze first.' });
          const d = last.item(code);
          if (!d) return res.status(400).json({ ok: false, error: `${code} is not in the current analysis (filters / no demand).` });
          res.json({ ok: true, ...d });
        } catch (e) { fail(res, e); }
      });

      // Manual forecast overrides. Accepts { months: { 'YYYY-MM': qty | '' } } or the
      // single { month, qty } form; a blank qty clears that month.
      router.post('/override', h.requireAuth, (req, res) => {
        try {
          const { row = {}, values = {} } = req.body || {};
          if (!row.itemCode) return res.status(400).json({ ok: false, error: 'Item required.' });
          const changes = values.months && typeof values.months === 'object' ? values.months : { [String(values.month || '').trim()]: values.qty };
          const s = agentSettingsRepo.get(company(), SETTINGS_KEY);
          const ov = s.overrides || {};
          const item = ov[row.itemCode] || {};
          let set = 0, cleared = 0;
          for (const [month, val] of Object.entries(changes)) {
            if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return res.status(400).json({ ok: false, error: 'Month must be YYYY-MM.' });
            const raw = String(val ?? '').trim();
            if (raw === '') { if (month in item) { delete item[month]; cleared++; } continue; }
            const q = Number(raw);
            if (!Number.isFinite(q) || q < 0) return res.status(400).json({ ok: false, error: `Quantity for ${month} must be a number ≥ 0.` });
            item[month] = q; set++;
          }
          if (Object.keys(item).length) ov[row.itemCode] = item; else delete ov[row.itemCode];
          agentSettingsRepo.set(company(), SETTINGS_KEY, { ...s, overrides: ov });
          res.json({ ok: true, message: `${row.itemCode}: ${set} month(s) overridden, ${cleared} cleared. Re-analyzing…` });
        } catch (e) { fail(res, e); }
      });
      router.post('/override/clear', h.requireAuth, (req, res) => {
        try {
          const code = req.body?.row?.itemCode;
          if (!code) return res.status(400).json({ ok: false, error: 'Item required.' });
          const s = agentSettingsRepo.get(company(), SETTINGS_KEY);
          const ov = s.overrides || {};
          delete ov[code];
          agentSettingsRepo.set(company(), SETTINGS_KEY, { ...s, overrides: ov });
          res.json({ ok: true, message: `Manual overrides for ${code} removed.` });
        } catch (e) { fail(res, e); }
      });
    },
  });
}
