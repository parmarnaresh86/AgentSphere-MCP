/**
 * Shared step-by-step "copy from base document" flow for the Sales O2C chain:
 *   Quotation → Sales Order, Sales Order → Delivery, Delivery → A/R Invoice,
 *   A/R Invoice → A/R Credit Memo.
 *
 * Same UI pattern as sales-order-agent.mjs: every step is a card rendered as the
 * chat reply (customer picker → open document list → editable lines → posted),
 * wired to the generic cf* helpers in public/index.html. Each controller supplies
 * a config (source/target entity, base type, theme, which fields are editable).
 */
import db, { connRepo, cacheRepo, dbConnRepo } from '../db.mjs';
import { executeSQL, isConnected, getActiveConfig, tableRef, connectDB } from '../db-connector.mjs';

// ── Small utils ────────────────────────────────────────────────────────────────

function today() { return new Date().toISOString().slice(0, 10); }
function datePlusDays(n) { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
function sapDate(s) { return s.length === 10 ? `${s}T00:00:00` : s; }
function fmtN(n, d = 2) {
  if (n == null || isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function odataStr(s) { return String(s).replace(/'/g, "''"); }

function getCompanyId() { const c = connRepo.getActive(); return c ? c.company : 'default'; }

function getCacheWarehouses() {
  return db.prepare(`SELECT WarehouseCode, WarehouseName FROM cache_warehouses WHERE company_id=? AND Inactive='tNO' ORDER BY WarehouseCode`).all(getCompanyId());
}
function getCachePayTerms() {
  return db.prepare(`SELECT GroupNumber, PaymentTermsGroupName FROM cache_payment_terms WHERE company_id=? ORDER BY PaymentTermsGroupName`).all(getCompanyId());
}

// Tax codes — cache first, live SAP fallback (VAT localizations use /VatGroups,
// US/CA Sales Tax localizations use /SalesTaxCodes), same as sales-order-agent.mjs.
async function getTaxCodes(sap) {
  const cid  = getCompanyId();
  const rows = db.prepare(`SELECT Code, Name, Rate FROM cache_tax_codes WHERE company_id=? ORDER BY Code`).all(cid);
  if (rows.length) return rows;
  try {
    const d   = await sap.get('/VatGroups', { $orderby: 'Code asc', $top: 200 });
    const vat = (Array.isArray(d.value) ? d.value : []).map(v => {
      const slabs = v.VatGroups || [];
      return { Code: v.Code, Name: v.Name, Category: v.Category, Rate: slabs.length ? Number(slabs[slabs.length - 1].Rate || 0) : 0 };
    });
    if (vat.length) { cacheRepo.upsertTaxCodes(cid, vat); return vat; }
  } catch { /* entity not available in this localization */ }
  try {
    const d  = await sap.get('/SalesTaxCodes', { $orderby: 'Code asc', $top: 200 });
    const st = (Array.isArray(d.value) ? d.value : []).map(v => ({ Code: v.Code, Name: v.Name, Category: 'Sales Tax', Rate: Number(v.Rate || 0) }));
    if (st.length) { cacheRepo.upsertTaxCodes(cid, st); return st; }
  } catch { /* entity not available in this localization */ }
  return [];
}

// SAP Service Layer caps rows-per-request at its page size (often 20) whatever
// $top says, so keep paging with $skip until no more rows come back.
async function fetchAllPages(sap, endpoint, params, hardCap) {
  const all = [];
  let skip = 0;
  while (all.length < hardCap) {
    const r    = await sap.get(endpoint, { ...params, $skip: skip });
    const rows = Array.isArray(r.value) ? r.value : [];
    if (!rows.length) break;
    all.push(...rows);
    skip += rows.length;
  }
  return all;
}

// ── Card building blocks ───────────────────────────────────────────────────────

function stepper(cfg, active) {
  const steps = ['Customer', cfg.source.label, 'Review Lines', 'Posted'];
  return `<div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin-bottom:10px;font-size:11px">` +
    steps.map((s, i) => {
      const n = i + 1, done = n < active, cur = n === active;
      const bg  = cur ? cfg.theme.color : done ? cfg.theme.light : '#f3f4f6';
      const fg  = cur ? '#fff' : done ? cfg.theme.color : '#9ca3af';
      return `<span style="background:${bg};color:${fg};border-radius:10px;padding:2px 9px;font-weight:600">${done ? '✓' : n} ${escHtml(s)}</span>` +
        (i < steps.length - 1 ? `<span style="color:#d1d5db">›</span>` : '');
    }).join('') + `</div>`;
}

function card(cfg, active, title, body) {
  return `<div style="background:${cfg.theme.bg};border:1.5px solid ${cfg.theme.color};border-radius:8px;padding:14px;margin:6px 0">
    ${stepper(cfg, active)}
    <div style="font-size:13px;font-weight:700;color:${cfg.theme.color};margin-bottom:10px">${title}</div>
    ${body}
  </div>`;
}

function errorCard(title, detail) {
  return `<div style="background:#fef2f2;border:1.5px solid #f87171;border-radius:8px;padding:12px 16px;color:#b91c1c;font-size:13px">
    ❌ <strong>${title}</strong>${detail ? `<br><br>${detail}` : ''}
  </div>`;
}

function selectedCustomerBanner(cfg, c) {
  return `<div style="background:#fff;border:1px solid ${cfg.theme.color};border-radius:6px;padding:8px 12px;margin-bottom:10px;font-size:12.5px;display:flex;align-items:center;gap:8px">
    <span style="flex:1">✅ Customer: <strong>${escHtml(c.cardName)}</strong> (${escHtml(c.cardCode)})</span>
    <button onclick="cfAct('${cfg.prefix}','change_customer')" style="background:none;border:1px solid #d1d5db;color:#374151;border-radius:5px;padding:3px 10px;font-size:11.5px;cursor:pointer">Change</button>
  </div>`;
}

// Step 1 — customer picker. `customers` = [{ cardCode, cardName, count? }]
function customerPickerHtml(cfg, customers, note) {
  const opts = customers.map(c => ({ v: c.cardCode, t: `${c.cardCode} — ${c.cardName}${c.count ? ` (${c.count} open)` : ''}` }));
  const optHtml = opts.map(o => `<option value="${escHtml(o.v)}">${escHtml(o.t)}</option>`).join('');
  const body = `${note ? `<div style="font-size:12px;color:#6b7280;margin-bottom:8px">${note}</div>` : ''}
    <div data-cf-picker data-options="${escHtml(JSON.stringify(opts))}">
      <input type="text" placeholder="🔍 Filter customers by name or code…" oninput="cfFilter(this)"
        style="width:100%;border:1.5px solid #d1d5db;border-radius:6px;padding:7px 10px;font-size:13px;margin-bottom:6px;box-sizing:border-box;outline:none">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
        <select style="flex:1;border:1.5px solid ${cfg.theme.color};border-radius:6px;padding:7px 10px;font-size:13px;background:#fff;outline:none">
          <option value="">— Select a Customer (${customers.length}) —</option>${optHtml}
        </select>
        <button onclick="cfPickCustomer(this,'${cfg.prefix}')"
          style="background:${cfg.theme.color};color:#fff;border:none;border-radius:6px;padding:8px 18px;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap">Select →</button>
      </div>
    </div>
    <div style="font-size:11.5px;color:#6b7280">Or type a customer name / code, or a ${escHtml(cfg.source.label)} number, in the chat box below.</div>`;
  return card(cfg, 1, `Step 1 — Select Customer`, body);
}

// Step 2 — open source documents for the selected customer.
function sourceListHtml(cfg, customer, docs) {
  const rows = docs.map((d, i) => `
    <tr style="border-bottom:1px solid #f3f4f6;${i % 2 ? 'background:#f9fafb' : 'background:#fff'}">
      <td style="padding:7px 10px;font-weight:700;color:${cfg.theme.color};white-space:nowrap">${escHtml(cfg.source.short)} #${d.DocNum}</td>
      <td style="padding:7px 10px;white-space:nowrap">${escHtml((d.DocDate || '').slice(0, 10))}</td>
      <td style="padding:7px 10px;white-space:nowrap">${escHtml((d.DocDueDate || '').slice(0, 10))}</td>
      <td style="padding:7px 10px">${escHtml(d.NumAtCard || '—')}</td>
      <td style="padding:7px 10px;text-align:right;font-weight:600;white-space:nowrap">${fmtN(d.DocTotal)}</td>
      <td style="padding:5px 10px;text-align:right">
        <button onclick="cfAct('${cfg.prefix}','select_source',${Number(d.DocEntry)})"
          style="background:${cfg.theme.color};color:#fff;border:none;border-radius:5px;padding:5px 14px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap">Select →</button>
      </td>
    </tr>`).join('');
  const body = `${selectedCustomerBanner(cfg, customer)}
    <div style="font-size:12.5px;color:#374151;margin-bottom:6px"><strong>${docs.length}</strong> open ${docs.length === 1 ? escHtml(cfg.source.label) : escHtml(cfg.source.plural)} — pick one to copy into a ${escHtml(cfg.target.label)}:</div>
    <div style="overflow-x:auto;border:1px solid #e5e7eb;border-radius:6px">
      <table style="width:100%;border-collapse:collapse;font-size:12.5px;min-width:520px">
        <thead><tr style="background:${cfg.theme.light};color:${cfg.theme.color};font-size:10.5px;text-transform:uppercase;letter-spacing:.04em">
          <th style="padding:6px 10px;text-align:left">Doc #</th><th style="padding:6px 10px;text-align:left">Date</th>
          <th style="padding:6px 10px;text-align:left">${escHtml(cfg.source.dueLabel || 'Due Date')}</th><th style="padding:6px 10px;text-align:left">Reference</th>
          <th style="padding:6px 10px;text-align:right">Total</th><th></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  return card(cfg, 2, `Step 2 — Select ${escHtml(cfg.source.label)}`, body);
}

// Step 3 — editable lines + header fields, posted via cfPost().
function linesFormHtml(cfg, src, master) {
  const ed   = cfg.editable;
  const rate = code => Number(master.taxCodes.find(t => t.Code === code)?.Rate || 0);
  const taxOpts = sel => `<option value="" data-rate="0">— None —</option>` + master.taxCodes.map(t =>
    `<option value="${escHtml(t.Code)}" data-rate="${Number(t.Rate || 0)}"${t.Code === sel ? ' selected' : ''}>${escHtml(t.Code)}${t.Rate ? ` (${Number(t.Rate)}%)` : ''}</option>`).join('');
  // With cfg.stock each option carries the item's on-hand qty in that warehouse (inventory UoM).
  // Warehouses holding stock come first (most stock on top), then the rest.
  const whOpts = (sel, stock) => {
    let codes = [...new Set([...(sel ? [sel] : []), ...Object.keys(stock || {}), ...master.warehouses.map(w => w.WarehouseCode)])];
    if (stock) codes.sort((a, b) => Number(stock[b] || 0) - Number(stock[a] || 0));
    return codes.map(code => {
      const qty = stock ? Number(stock[code] || 0) : null;
      return `<option value="${escHtml(code)}"${qty != null ? ` data-stock="${qty}"` : ''}${code === sel ? ' selected' : ''}>${escHtml(code)}${qty != null ? ` — ${fmtN(qty, 2)}` : ''}</option>`;
    }).join('');
  };
  const inp = 'border:1.5px solid #d1d5db;border-radius:5px;padding:4px 6px;font-size:12.5px;box-sizing:border-box';
  const numCell = (f, v, w, extra = '') =>
    `<input type="number" data-f="${f}" value="${v}" ${extra} oninput="cfCalc(this)" style="${inp};width:${w}px;text-align:right">`;

  const rows = src.lines.map(l => {
    const sub = l.openQty * l.unitPrice * (1 - l.discountPercent / 100);
    const tot = sub * (1 + rate(l.taxCode) / 100);
    const whStock = cfg.stock ? Number(l.stock?.[l.warehouse] || 0) : 0;
    const stockCells = !cfg.stock ? '' : `
      <td data-f="whqty" style="padding:6px 8px;text-align:right;white-space:nowrap;font-weight:600">${fmtN(whStock, 2)}</td>
      <td style="padding:6px 8px;text-align:right;white-space:nowrap;color:#6b7280">${fmtN(l.totalStock, 2)}</td>`;
    const bsCell = !cfg.batchSerial ? '' : `<td style="padding:6px 8px;white-space:nowrap">${l.manage
      ? `<button type="button" onclick="cfPickBatchSerial(this)" style="background:#fff;border:1.5px solid ${cfg.theme.color};color:${cfg.theme.color};border-radius:5px;padding:4px 10px;font-size:11.5px;font-weight:600;cursor:pointer">${l.manage === 'serial' ? '🔢 Select Serials' : '📦 Select Batches'}</button>
         <div data-f="allocst" style="font-size:10.5px;color:#b91c1c;margin-top:2px">Not selected</div>`
      : '<span style="color:#9ca3af;font-size:11.5px">—</span>'}</td>`;
    return `<tr data-cf-line data-linenum="${l.lineNum}" data-max="${l.openQty}" data-item="${escHtml(l.itemCode)}" data-itemname="${escHtml(l.itemName)}"
        data-price="${l.unitPrice}" data-disc="${l.discountPercent}" data-rate="${rate(l.taxCode)}"
        data-factor="${l.factor || 1}" data-manage="${l.manage || ''}"${cfg.stock ? ' data-stockcheck="1"' : ''} style="border-bottom:1px solid #f3f4f6;background:#fff">
      <td style="padding:6px 8px;text-align:center"><input type="checkbox" data-f="use" checked onchange="cfCalc(this)" style="width:15px;height:15px"></td>
      <td style="padding:6px 8px"><div style="font-weight:600;white-space:nowrap">${escHtml(l.itemCode)}</div><div style="font-size:11px;color:#6b7280;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(l.itemName)}">${escHtml(l.itemName)}</div></td>
      <td style="padding:6px 8px;text-align:right;color:#6b7280;white-space:nowrap">${fmtN(l.openQty, 2)} ${escHtml(l.unit)}</td>
      <td style="padding:6px 8px">${numCell('qty', l.openQty, 80, `min="0" max="${l.openQty}" step="any"`)}</td>
      <td style="padding:6px 8px">${ed.price ? numCell('price', l.unitPrice, 95, 'min="0" step="any"') : `<div style="text-align:right">${fmtN(l.unitPrice)}</div>`}</td>
      <td style="padding:6px 8px">${ed.disc ? numCell('disc', l.discountPercent, 60, 'min="0" max="100" step="any"') : `<div style="text-align:right">${fmtN(l.discountPercent)}%</div>`}</td>
      <td style="padding:6px 8px">${ed.tax
        ? `<select data-f="tax" onchange="cfCalc(this)" style="${inp};width:120px;background:#fff">${taxOpts(l.taxCode)}</select>`
        : escHtml(l.taxCode || '—')}</td>
      <td style="padding:6px 8px">${ed.wh
        ? `<select data-f="wh" onchange="cfWhChange(this)" style="${inp};width:${cfg.stock ? 130 : 90}px;background:#fff">${whOpts(l.warehouse, cfg.stock ? l.stock : null)}</select>`
        : escHtml(l.warehouse || '—')}</td>${stockCells}${bsCell}
      <td data-f="total" style="padding:6px 8px;text-align:right;font-weight:700;color:${cfg.theme.color};white-space:nowrap">${fmtN(tot)}</td>
    </tr>`;
  }).join('');

  const field = (label, html) => `<div><div style="font-size:11px;color:#6b7280;margin-bottom:3px">${label}</div>${html}</div>`;
  const hdrInp = `width:100%;${inp};padding:6px 8px;font-size:13px`;
  const ptOpts = `<option value="">— Customer default —</option>` + master.payTerms.map(p =>
    `<option value="${p.GroupNumber}">${escHtml(p.PaymentTermsGroupName)}</option>`).join('');
  const dueDefault = cfg.defaultDueDate(src);

  const body = `${selectedCustomerBanner(cfg, { cardCode: src.cardCode, cardName: src.cardName })}
    <div data-cf-form data-prefix="${cfg.prefix}" data-source="${src.docEntry}">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:12px">
        ${field('Posting Date', `<input type="date" data-h="docDate" value="${today()}" style="${hdrInp}">`)}
        ${field(escHtml(cfg.target.dueLabel) + (cfg.target.dueRequired ? ' *' : ''), `<input type="date" data-h="dueDate" value="${dueDefault}" style="${hdrInp}">`)}
        ${field(escHtml(cfg.target.refLabel || 'Customer Ref'), `<input type="text" data-h="numAtCard" value="${escHtml(src.numAtCard || '')}" placeholder="Optional" style="${hdrInp}">`)}
        ${cfg.payTerms ? field('Payment Terms', `<select data-h="payTerms" style="${hdrInp};background:#fff">${ptOpts}</select>`) : ''}
      </div>
      <div style="overflow-x:auto;border:1px solid #e5e7eb;border-radius:6px;margin-bottom:10px">
        <table style="width:100%;border-collapse:collapse;font-size:12.5px;min-width:${760 + (cfg.stock ? 160 : 0) + (cfg.batchSerial ? 120 : 0)}px">
          <thead><tr style="background:${cfg.theme.light};color:${cfg.theme.color};font-size:10.5px;text-transform:uppercase;letter-spacing:.04em">
            <th style="padding:6px 8px"></th><th style="padding:6px 8px;text-align:left">Item</th>
            <th style="padding:6px 8px;text-align:right">Open Qty</th><th style="padding:6px 8px;text-align:left">${escHtml(cfg.target.qtyLabel)} ✏️</th>
            <th style="padding:6px 8px;text-align:left">Unit Price${ed.price ? ' ✏️' : ''}</th><th style="padding:6px 8px;text-align:left">Disc%${ed.disc ? ' ✏️' : ''}</th>
            <th style="padding:6px 8px;text-align:left">Tax${ed.tax ? ' ✏️' : ''}</th><th style="padding:6px 8px;text-align:left">Whse${ed.wh ? ' ✏️' : ''}</th>
            ${cfg.stock ? `<th style="padding:6px 8px;text-align:right">In Whse</th><th style="padding:6px 8px;text-align:right">Total Stock</th>` : ''}
            ${cfg.batchSerial ? `<th style="padding:6px 8px;text-align:left">Batch / Serial</th>` : ''}
            <th style="padding:6px 8px;text-align:right">Total</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div style="margin-bottom:12px">${field('Remarks', `<input type="text" data-h="comments" value="Based on ${escHtml(cfg.source.label)} #${src.docNum}" style="${hdrInp}">`)}</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
        <button data-cf-post onclick="cfPost(this)"
          style="background:${cfg.theme.color};color:#fff;border:none;border-radius:6px;padding:9px 22px;font-size:13.5px;font-weight:700;cursor:pointer">✅ Post ${escHtml(cfg.target.label)}</button>
        <button onclick="cfAct('${cfg.prefix}','change_source')"
          style="background:#f3f4f6;color:#374151;border:1px solid #d1d5db;border-radius:6px;padding:9px 14px;font-size:13px;cursor:pointer">← Change ${escHtml(cfg.source.label)}</button>
        <span style="flex:1"></span>
        <span style="font-size:12px;color:#6b7280">Total (incl. tax):</span>
        <span data-f="grand" style="font-size:15px;font-weight:800;color:${cfg.theme.color}">${fmtN(src.lines.reduce((s, l) => s + l.openQty * l.unitPrice * (1 - l.discountPercent / 100) * (1 + rate(l.taxCode) / 100), 0))}</span>
      </div>
    </div>`;
  return card(cfg, 3, `Step 3 — Review ${escHtml(cfg.source.label)} #${src.docNum} → ${escHtml(cfg.target.label)}`, body);
}

function successHtml(cfg, src, result, lines, printUrl) {
  const trs = lines.map((l, i) => `
    <tr style="border-bottom:1px solid #f3f4f6">
      <td style="padding:5px 10px">${i + 1}</td>
      <td style="padding:5px 10px;font-weight:600">${escHtml(l.itemCode)}</td>
      <td style="padding:5px 10px;text-align:right">${fmtN(l.qty, 2)}</td>
      <td style="padding:5px 10px;text-align:right">${fmtN(l.unitPrice)}</td>
      <td style="padding:5px 10px">${escHtml(l.taxCode || '')}</td>
      <td style="padding:5px 10px">${escHtml(l.warehouse || '')}</td>
    </tr>`).join('');
  const info = [
    [`${cfg.target.label} No.`, `<strong style="color:${cfg.theme.color};font-size:14px">#${result.DocNum}</strong>`],
    ['Doc Entry', String(result.DocEntry)],
    ['Customer', `${escHtml(src.cardName)} (${escHtml(src.cardCode)})`],
    [`Based on`, `${escHtml(cfg.source.label)} #${src.docNum}`],
    ['Document Total', fmtN(result.DocTotal)],
  ].map(([k, v], i) => `<tr${i % 2 ? ' style="background:#f9fafb"' : ''}><td style="padding:6px 12px;color:#6b7280;width:38%">${k}</td><td style="padding:6px 12px">${v}</td></tr>`).join('');
  return `<div style="background:#f0fdf4;border:1.5px solid #10b981;border-radius:8px;padding:14px;margin:6px 0">
    ${stepper(cfg, 5)}
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px">
      <div style="font-size:14.5px;font-weight:700;color:#065f46">✅ ${escHtml(cfg.target.label)} Created Successfully</div>
      <a href="${printUrl}" target="_blank" style="background:${cfg.theme.color};color:#fff;border-radius:6px;padding:7px 16px;font-size:12.5px;font-weight:600;text-decoration:none;white-space:nowrap">🖨️ Print</a>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:12.5px;margin-bottom:10px"><tbody>${info}</tbody></table>
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:12px;min-width:440px">
        <thead><tr style="background:#dcfce7;color:#065f46;font-size:10.5px;text-transform:uppercase">
          <th style="padding:5px 10px;text-align:left">#</th><th style="padding:5px 10px;text-align:left">Item</th>
          <th style="padding:5px 10px;text-align:right">Qty</th><th style="padding:5px 10px;text-align:right">Price</th>
          <th style="padding:5px 10px;text-align:left">Tax</th><th style="padding:5px 10px;text-align:left">Whse</th>
        </tr></thead><tbody>${trs}</tbody>
      </table>
    </div>
  </div>`;
}

// ── SAP data access ────────────────────────────────────────────────────────────

const _customerCache = new Map(); // `${company}|${entity}` → { at, list }
const CUSTOMER_CACHE_MS = 60 * 1000;

async function customersWithOpenDocs(cfg, sap) {
  const key = `${getCompanyId()}|${cfg.source.entity}`;
  const hit = _customerCache.get(key);
  if (hit && Date.now() - hit.at < CUSTOMER_CACHE_MS) return hit.list;
  const rows = await fetchAllPages(sap, cfg.source.entity, {
    $filter: `DocumentStatus eq 'bost_Open' and Cancelled eq 'tNO'`,
    $select: 'DocEntry,CardCode,CardName',
    $orderby: 'CardName asc',
  }, 5000);
  const map = new Map();
  rows.forEach(r => {
    const c = map.get(r.CardCode) || { cardCode: r.CardCode, cardName: r.CardName || r.CardCode, count: 0 };
    c.count++; map.set(r.CardCode, c);
  });
  const list = [...map.values()].sort((a, b) => a.cardName.localeCompare(b.cardName));
  _customerCache.set(key, { at: Date.now(), list });
  return list;
}

async function searchCustomers(sap, query) {
  const q = odataStr(query);
  const r = await sap.get('/BusinessPartners', {
    $filter: `CardType eq 'cCustomer' and (substringof('${q}',CardName) or substringof('${q}',CardCode))`,
    $select: 'CardCode,CardName', $orderby: 'CardName', $top: 20,
  });
  return (Array.isArray(r.value) ? r.value : []).map(c => ({ cardCode: c.CardCode, cardName: c.CardName }));
}

async function openDocsForCustomer(cfg, sap, cardCode) {
  return fetchAllPages(sap, cfg.source.entity, {
    $filter: `DocumentStatus eq 'bost_Open' and Cancelled eq 'tNO' and CardCode eq '${odataStr(cardCode)}'`,
    $select: 'DocEntry,DocNum,DocDate,DocDueDate,CardCode,CardName,DocTotal,NumAtCard',
    $orderby: 'DocDate desc',
  }, 100);
}

async function loadSource(cfg, sap, docEntry) {
  const doc = await sap.get(`${cfg.source.entity}(${parseInt(docEntry, 10)})`);
  if (!doc || doc.DocumentStatus !== 'bost_Open') return null;
  return {
    docEntry:  doc.DocEntry,
    docNum:    doc.DocNum,
    docDate:   (doc.DocDate || '').slice(0, 10),
    dueDate:   (doc.DocDueDate || '').slice(0, 10),
    cardCode:  doc.CardCode,
    cardName:  doc.CardName || doc.CardCode,
    numAtCard: doc.NumAtCard || '',
    lines: (doc.DocumentLines || [])
      .filter(l => l.ItemCode && l.LineStatus !== 'bost_Close')
      .map(l => ({
        lineNum:         l.LineNum,
        itemCode:        l.ItemCode,
        itemName:        l.ItemDescription || l.ItemCode,
        openQty:         Number(l.RemainingOpenQuantity ?? l.Quantity ?? 0),
        unitPrice:       Number(l.UnitPrice ?? l.Price ?? 0),
        discountPercent: Number(l.DiscountPercent || 0),
        unit:            l.UoMCode || l.MeasureUnit || '',
        warehouse:       l.WarehouseCode || '',
        taxCode:         l.TaxCode || l.VatGroup || '',
        factor:          Number(l.UnitsOfMeasurment || 1) || 1,   // inventory units per sales unit
      }))
      .filter(l => l.openQty > 0),
  };
}

// Adds per-warehouse on-hand stock and batch/serial management to each line.
async function enrichWithStock(sap, src) {
  const codes = [...new Set(src.lines.map(l => l.itemCode))];
  const items = await Promise.all(codes.map(code =>
    sap.get(`/Items('${odataStr(code)}')`, { $select: 'ItemCode,ManageBatchNumbers,ManageSerialNumbers,QuantityOnStock,ItemWarehouseInfoCollection' })
      .catch(e => { console.error('[CopyFlow] item stock', code, e.message); return null; })));
  const byCode = new Map(items.filter(Boolean).map(i => [i.ItemCode, i]));
  for (const l of src.lines) {
    const it = byCode.get(l.itemCode);
    l.manage     = it?.ManageSerialNumbers === 'tYES' ? 'serial' : it?.ManageBatchNumbers === 'tYES' ? 'batch' : '';
    l.totalStock = Number(it?.QuantityOnStock || 0);
    l.stock      = Object.fromEntries((it?.ItemWarehouseInfoCollection || []).map(w => [w.WarehouseCode, Number(w.InStock || 0)]));
  }
}

// Batches / serials available in a warehouse — read from SAP's OBTQ/OBTN and
// OSRQ/OSRN tables over the direct DB connection (the Service Layer does not
// expose per-warehouse batch or serial quantities).
export async function listBatchSerials(kind, itemCode, whsCode) {
  if (!isConnected()) {
    const saved = dbConnRepo.getActive();   // same auto-reconnect as chat-server.mjs
    if (saved) { try { await connectDB(saved); } catch (e) { console.error('[CopyFlow] DB reconnect failed:', e.message); } }
  }
  if (!isConnected()) throw new Error('Direct database connection is not active — connect it under Settings → DB Connection to load batches/serials.');
  const cfgDb = getActiveConfig();
  const t = n => tableRef(n, cfgDb);
  const ic = odataStr(itemCode), wc = odataStr(whsCode);
  if (kind === 'batch') {
    const rows = await executeSQL(`SELECT T0."DistNumber", T0."ExpDate", T0."MnfDate", T0."InDate", T1."Quantity", T1."CommitQty"
      FROM ${t('OBTN')} T0 INNER JOIN ${t('OBTQ')} T1 ON T1."ItemCode" = T0."ItemCode" AND T1."SysNumber" = T0."SysNumber"
      WHERE T1."ItemCode" = '${ic}' AND T1."WhsCode" = '${wc}' AND T1."Quantity" > 0
      ORDER BY T0."ExpDate", T0."InDate", T0."DistNumber"`);
    return rowsOf(rows).map(r => ({
      batch: r.DistNumber, qty: Number(r.Quantity || 0), committed: Number(r.CommitQty || 0),
      expiry: dateOnly(r.ExpDate), mfg: dateOnly(r.MnfDate), admission: dateOnly(r.InDate),
    }));
  }
  const rows = await executeSQL(`SELECT T0."DistNumber", T0."MnfSerial", T0."LotNumber", T0."SysNumber", T0."ExpDate", T0."InDate"
    FROM ${t('OSRN')} T0 INNER JOIN ${t('OSRQ')} T1 ON T1."ItemCode" = T0."ItemCode" AND T1."SysNumber" = T0."SysNumber"
    WHERE T1."ItemCode" = '${ic}' AND T1."WhsCode" = '${wc}' AND T1."Quantity" > 0
    ORDER BY T0."InDate", T0."DistNumber"`);
  return rowsOf(rows).map(r => ({
    serial: r.DistNumber, sysNumber: Number(r.SysNumber), mfrSerial: r.MnfSerial || '', lot: r.LotNumber || '',
    expiry: dateOnly(r.ExpDate), admission: dateOnly(r.InDate),
  }));
}
function rowsOf(r) { return Array.isArray(r) ? r : (r?.rows || r?.recordset || []); }
function dateOnly(d) { if (!d) return ''; const s = d instanceof Date ? d.toISOString() : String(d); return s.slice(0, 10); }

// Express handler: GET ?kind=batch|serial&itemCode=&whs=
export function batchSerialRoute() {
  return async (req, res) => {
    try {
      const kind = req.query.kind === 'serial' ? 'serial' : 'batch';
      const itemCode = String(req.query.itemCode || '').trim(), whs = String(req.query.whs || '').trim();
      if (!itemCode || !whs) return res.json({ ok: false, error: 'itemCode and whs are required' });
      res.json({ ok: true, kind, rows: await listBatchSerials(kind, itemCode, whs) });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  };
}

async function loadSourceByNum(cfg, sap, docNum) {
  const r = await sap.get(cfg.source.entity, {
    $filter: `DocNum eq ${parseInt(docNum, 10)} and DocumentStatus eq 'bost_Open'`,
    $select: 'DocEntry', $top: 1,
  });
  const entry = r.value?.[0]?.DocEntry;
  return entry ? loadSource(cfg, sap, entry) : null;
}

// ── Chat handler ───────────────────────────────────────────────────────────────

const DOC_NUM_RE = /^(?:(?:SQ|QT|QUOT|SO|ORD|DN|DEL|INV|AR|ARINV)\s*)?#?\s*(\d+)$/i;

function initSession() { return { step: 'INIT', customer: null, source: null, posting: false }; }

/**
 * cfg = {
 *   tag, prefix, apiBase, welcome,
 *   theme:  { color, bg, light },
 *   source: { entity, baseType, label, short, plural, dueLabel },
 *   target: { entity, label, dueLabel, dueRequired, refLabel, qtyLabel },
 *   editable: { price, disc, tax, wh }, payTerms,
 *   defaultDueDate(src) → 'YYYY-MM-DD' | '',
 * }
 */
export function createCopyFlowChatHandler(cfg, getActiveSap) {
  const sessions = new Map();

  async function showCustomerStep(sap, note) {
    let customers = [];
    try { customers = await customersWithOpenDocs(cfg, sap); }
    catch (e) { console.error(`[${cfg.tag}] customersWithOpenDocs:`, e.message); }
    if (!customers.length) {
      return customerPickerHtml(cfg, [], `${note ? note + '<br>' : ''}⚠️ No customers with open ${escHtml(cfg.source.plural)} were found. Type a customer name below to search.`);
    }
    return customerPickerHtml(cfg, customers, note || `Showing only customers that have open ${escHtml(cfg.source.plural)}.`);
  }

  async function showSourceStep(session, sap, customer) {
    session.customer = customer;
    session.source   = null;
    const docs = await openDocsForCustomer(cfg, sap, customer.cardCode);
    if (!docs.length) {
      session.step = 'SELECT_CUSTOMER';
      return showCustomerStep(sap, `No open ${escHtml(cfg.source.plural)} for <strong>${escHtml(customer.cardName)}</strong>. Pick another customer:`);
    }
    session.step = 'SELECT_SOURCE';
    return sourceListHtml(cfg, customer, docs);
  }

  async function showLinesStep(session, sap, src) {
    if (!src) return errorCard(`${cfg.source.label} not found`, `It may be closed, cancelled or already fully copied.`);
    if (!src.lines.length) return errorCard(`${cfg.source.label} #${src.docNum} has no open lines`, 'Every line has already been copied to a target document.');
    if (cfg.stock || cfg.batchSerial) await enrichWithStock(sap, src);
    session.customer = { cardCode: src.cardCode, cardName: src.cardName };
    session.source   = src;
    session.step     = 'REVIEW_LINES';
    const master = { taxCodes: cfg.editable.tax ? await getTaxCodes(sap) : [], warehouses: getCacheWarehouses(), payTerms: cfg.payTerms ? getCachePayTerms() : [] };
    return linesFormHtml(cfg, src, master);
  }

  async function post(session, sap, a) {
    const src = session.source;
    if (!src || session.step !== 'REVIEW_LINES') return { reply: errorCard('Nothing to post', `This form is no longer active. Select a ${escHtml(cfg.source.label)} again.`) };
    if (Number(a.sourceDocEntry) !== Number(src.docEntry)) return { reply: errorCard('Outdated form', `Use the most recent form for ${escHtml(cfg.source.label)} #${src.docNum}.`) };
    if (session.posting) return { reply: errorCard('Already posting', 'Please wait for the current post to finish.') };

    const byLine = new Map(src.lines.map(l => [l.lineNum, l]));
    const lines  = [];
    for (const l of a.lines || []) {
      const base = byLine.get(Number(l.lineNum));
      const qty  = Number(l.qty);
      if (!base || !(qty > 0)) continue;
      if (qty > base.openQty + 1e-9) return { reply: errorCard('Quantity too high', `${escHtml(base.itemCode)}: ${fmtN(qty, 2)} exceeds the open quantity ${fmtN(base.openQty, 2)}.`) };
      const whs    = cfg.editable.wh ? (l.warehouse || base.warehouse) : base.warehouse;
      const invQty = qty * (base.factor || 1);
      if (cfg.stock && base.stock && invQty > Number(base.stock[whs] || 0) + 1e-9) {
        return { reply: errorCard('Insufficient stock', `${escHtml(base.itemCode)}: needs ${fmtN(invQty, 2)} but warehouse ${escHtml(whs)} has ${fmtN(base.stock[whs] || 0, 2)} in stock. Pick another warehouse or reduce the quantity.`) };
      }
      let alloc = {};
      if (cfg.batchSerial && base.manage === 'batch') {
        const batches = (l.batches || []).filter(b => b.batch && Number(b.qty) > 0).map(b => ({ BatchNumber: String(b.batch), Quantity: Number(b.qty) }));
        const sum = batches.reduce((s, b) => s + b.Quantity, 0);
        if (Math.abs(sum - invQty) > 1e-6) return { reply: errorCard('Batches not selected', `${escHtml(base.itemCode)}: select batches for exactly ${fmtN(invQty, 2)} (selected ${fmtN(sum, 2)}).`) };
        alloc = { BatchNumbers: batches };
      } else if (cfg.batchSerial && base.manage === 'serial') {
        const serials = (l.serials || []).filter(s => s && s.serial);
        if (serials.length !== Math.round(invQty) || Math.abs(invQty - Math.round(invQty)) > 1e-6) {
          return { reply: errorCard('Serials not selected', `${escHtml(base.itemCode)}: select exactly ${fmtN(invQty, 0)} serial number(s) (selected ${serials.length}).`) };
        }
        alloc = { SerialNumbers: serials.map(s => ({ InternalSerialNumber: String(s.serial), ...(s.sysNumber ? { SystemSerialNumber: Number(s.sysNumber) } : {}), Quantity: 1 })) };
      }
      lines.push({
        alloc,
        lineNum: base.lineNum, itemCode: base.itemCode, qty,
        unitPrice:       cfg.editable.price ? Number(l.unitPrice) : base.unitPrice,
        discountPercent: cfg.editable.disc  ? Number(l.discountPercent || 0) : base.discountPercent,
        taxCode:         cfg.editable.tax   ? (l.taxCode || '') : base.taxCode,
        warehouse:       cfg.editable.wh    ? (l.warehouse || '') : base.warehouse,
      });
    }
    if (!lines.length) return { reply: errorCard('No lines selected', 'Tick at least one line with a quantity above zero.') };
    if (cfg.target.dueRequired && !a.dueDate) return { reply: errorCard(`${cfg.target.dueLabel} is required`, 'Set the date and post again.') };

    const payload = {
      CardCode: src.cardCode,
      DocDate:  sapDate(a.docDate || today()),
      ...(a.dueDate   ? { DocDueDate: sapDate(a.dueDate) } : {}),
      ...(a.numAtCard ? { NumAtCard: a.numAtCard } : {}),
      ...(a.comments  ? { Comments: a.comments } : {}),
      ...(cfg.payTerms && a.payTerms !== '' && a.payTerms != null ? { PaymentGroupCode: Number(a.payTerms) } : {}),
      DocumentLines: lines.map(l => ({
        BaseType: cfg.source.baseType, BaseEntry: Number(src.docEntry), BaseLine: l.lineNum,
        Quantity: l.qty,
        ...(cfg.editable.price ? { UnitPrice: l.unitPrice } : {}),
        ...(cfg.editable.disc  ? { DiscountPercent: l.discountPercent } : {}),
        ...(cfg.editable.tax && l.taxCode   ? { TaxCode: l.taxCode } : {}),
        ...(cfg.editable.wh  && l.warehouse ? { WarehouseCode: l.warehouse } : {}),
        ...l.alloc,
      })),
    };

    session.posting = true;
    try {
      const result = await sap.post(cfg.target.entity, payload);
      session.step = 'DONE';
      _customerCache.delete(`${getCompanyId()}|${cfg.source.entity}`);
      const printUrl = `${cfg.apiBase}/print/${result.DocEntry}`;
      return {
        reply: successHtml(cfg, src, result, lines, printUrl),
        quickReplies: [`New ${cfg.target.label}`],
        meta: { docEntry: result.DocEntry, docNum: result.DocNum, printUrl },
      };
    } catch (e) {
      console.error(`[${cfg.tag}] post error:`, e.message);
      return { reply: errorCard(`Failed to post ${escHtml(cfg.target.label)}`, `SAP Error: ${escHtml(e.message)}<br><br>Fix the values in the form above and click Post again.`) };
    } finally {
      session.posting = false;
    }
  }

  return async function chat(req, res) {
    try {
      const { message = '', sessionId } = req.body || {};
      const sid = sessionId || `${cfg.prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      if (!sessions.has(sid)) sessions.set(sid, initSession());
      const session = sessions.get(sid);
      const sap = getActiveSap();
      const msg = String(message).trim();

      let out = { reply: '', quickReplies: [], meta: {} };
      let action = null, srcByNum = null;
      if (msg.startsWith('{')) { try { action = JSON.parse(msg); } catch { /* treat as text */ } }

      if (action) {
        switch (action.action) {
          case 'select_customer':
            out.reply = await showSourceStep(session, sap, { cardCode: action.cardCode, cardName: action.cardName || action.cardCode });
            break;
          case 'select_source':
            out.reply = await showLinesStep(session, sap, await loadSource(cfg, sap, action.docEntry));
            break;
          case 'change_source':
            out.reply = session.customer ? await showSourceStep(session, sap, session.customer) : await showCustomerStep(sap);
            break;
          case 'post_target':
            out = { quickReplies: [], meta: {}, ...(await post(session, sap, action)) };
            break;
          case 'change_customer':
          default:
            Object.assign(session, initSession());
            session.step = 'SELECT_CUSTOMER';
            out.reply = await showCustomerStep(sap);
        }
      } else if (!msg || /^(start over|restart|reset|cancel|new\b.*|process another.*)$/i.test(msg) || session.step === 'DONE') {
        Object.assign(session, initSession());
        session.step = 'SELECT_CUSTOMER';
        out.reply = (msg ? '' : cfg.welcome) + await showCustomerStep(sap);
      } else if (DOC_NUM_RE.test(msg) && (srcByNum = await loadSourceByNum(cfg, sap, msg.match(DOC_NUM_RE)[1]))) {
        // A document number, e.g. "716", "#716", "SQ 716"
        out.reply = await showLinesStep(session, sap, srcByNum);
      } else {
        const found = await searchCustomers(sap, msg);
        if (found.length === 1) out.reply = await showSourceStep(session, sap, found[0]);
        else if (found.length) { session.step = 'SELECT_CUSTOMER'; out.reply = customerPickerHtml(cfg, found, `${found.length} customers match "<strong>${escHtml(msg)}</strong>":`); }
        else out.reply = errorCard(`No customer matches "${escHtml(msg)}"`, `Try another name or code, or a ${escHtml(cfg.source.label)} number.`);
      }

      res.json({ ok: true, sessionId: sid, step: session.step, ...out });
    } catch (e) {
      console.error(`[${cfg.tag}] chat error:`, e);
      res.status(500).json({ ok: false, error: e.message, reply: errorCard('Something went wrong', escHtml(e.message)) });
    }
  };
}

export { datePlusDays, today };
