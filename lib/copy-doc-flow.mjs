/**
 * Shared step-by-step "copy from base document" flow for the Sales O2C chain:
 *   Quotation → Sales Order, Sales Order → Delivery, Delivery → A/R Invoice,
 *   A/R Invoice → A/R Credit Memo — and, with cfg.party set to vendors, the
 *   purchasing PO → GRPO, GRPO → A/P Invoice and A/P Invoice → A/P Credit Memo.
 *
 * Same UI pattern as sales-order-agent.mjs: every step is a card rendered as the
 * chat reply (customer picker → open document list → editable lines → posted),
 * wired to the generic cf* helpers in public/index.html. Each controller supplies
 * a config (source/target entity, base type, theme, which fields are editable).
 */
import db, { connRepo, cacheRepo, dbConnRepo } from '../db.mjs';
import { executeSQL, isConnected, getActiveConfig, tableRef, connectDB } from '../db-connector.mjs';
import { getItemPrice } from './item-price.mjs';

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

// Business partner side of the flow — customers by default, vendors for purchasing agents.
const CUSTOMER_PARTY = { label: 'Customer', plural: 'customers', cardType: 'cCustomer' };
function partyOf(cfg) { return cfg.party || CUSTOMER_PARTY; }

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
  const steps = cfg.steps || [partyOf(cfg).label, cfg.source.label, 'Review Lines', 'Posted'];
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
    <span style="flex:1">✅ ${escHtml(partyOf(cfg).label)}: <strong>${escHtml(c.cardName)}</strong> (${escHtml(c.cardCode)})</span>
    <button onclick="cfAct('${cfg.prefix}','change_customer')" style="background:none;border:1px solid #d1d5db;color:#374151;border-radius:5px;padding:3px 10px;font-size:11.5px;cursor:pointer">Change</button>
  </div>`;
}

// Step 1 — customer / vendor picker. `customers` = [{ cardCode, cardName, count? }]
function customerPickerHtml(cfg, customers, note) {
  const party = partyOf(cfg);
  const opts = customers.map(c => ({ v: c.cardCode, t: `${c.cardCode} — ${c.cardName}${c.count ? ` (${c.count} open)` : ''}` }));
  const optHtml = opts.map(o => `<option value="${escHtml(o.v)}">${escHtml(o.t)}</option>`).join('');
  const body = `${note ? `<div style="font-size:12px;color:#6b7280;margin-bottom:8px">${note}</div>` : ''}
    <div data-cf-picker data-party="${escHtml(party.label)}" data-options="${escHtml(JSON.stringify(opts))}">
      <input type="text" placeholder="🔍 Filter ${escHtml(party.plural)} by name or code…" oninput="cfFilter(this)"
        style="width:100%;border:1.5px solid #d1d5db;border-radius:6px;padding:7px 10px;font-size:13px;margin-bottom:6px;box-sizing:border-box;outline:none">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
        <select style="flex:1;border:1.5px solid ${cfg.theme.color};border-radius:6px;padding:7px 10px;font-size:13px;background:#fff;outline:none">
          <option value="">— Select a ${escHtml(party.label)} (${customers.length}) —</option>${optHtml}
        </select>
        <button onclick="cfPickCustomer(this,'${cfg.prefix}')"
          style="background:${cfg.theme.color};color:#fff;border:none;border-radius:6px;padding:8px 18px;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap">Select →</button>
      </div>
    </div>
    <div style="font-size:11.5px;color:#6b7280">Or type a ${escHtml(party.label.toLowerCase())} name / code, or a ${escHtml(cfg.source.label)} number, in the chat box below.</div>`;
  return card(cfg, 1, `Step 1 — Select ${escHtml(party.label)}`, body);
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
  // The line's own tax code stays selectable even when the tax-code list doesn't carry it
  const taxOpts = sel => `<option value="" data-rate="0">— None —</option>`
    + (sel && !master.taxCodes.some(t => t.Code === sel) ? `<option value="${escHtml(sel)}" data-rate="0" selected>${escHtml(sel)}</option>` : '')
    + master.taxCodes.map(t =>
    `<option value="${escHtml(t.Code)}" data-rate="${Number(t.Rate || 0)}"${t.Code === sel ? ' selected' : ''}>${escHtml(t.Code)}${t.Rate ? ` (${Number(t.Rate)}%)` : ''}</option>`).join('');
  // With cfg.stock each option carries the item's on-hand qty in that warehouse (inventory UoM).
  // Warehouses holding stock come first (most stock on top), then the rest.
  const whOpts = (sel, stock) => {
    let codes = [...new Set([...(sel ? [sel] : []), ...Object.keys(stock || {}), ...src.lines.map(l => l.warehouse).filter(Boolean), ...master.warehouses.map(w => w.WarehouseCode)])];
    if (stock) codes.sort((a, b) => Number(stock[b] || 0) - Number(stock[a] || 0));
    return codes.map(code => {
      const qty = stock ? Number(stock[code] || 0) : null;
      return `<option value="${escHtml(code)}"${qty != null ? ` data-stock="${qty}"` : ''}${code === sel ? ' selected' : ''}>${escHtml(code)}${qty != null ? ` — ${fmtN(qty, 2)}` : ''}</option>`;
    }).join('');
  };
  const inp = 'border:1.5px solid #d1d5db;border-radius:5px;padding:4px 6px;font-size:12.5px;box-sizing:border-box';
  const numCell = (f, v, w, extra = '') =>
    `<input type="number" data-f="${f}" value="${v}" ${extra} oninput="cfCalc(this)" style="${inp};width:${w}px;text-align:right">`;

  const binWhs = new Set(src.binWhs || []);
  const rows = src.lines.map(l => {
    const sub = l.openQty * l.unitPrice * (1 - l.discountPercent / 100);
    const tot = sub * (1 + rate(l.taxCode) / 100);
    const whStock = cfg.stock ? Number(l.stock?.[l.warehouse] || 0) : 0;
    const stockCells = !cfg.stock ? '' : `
      <td data-f="whqty" style="padding:6px 8px;text-align:right;white-space:nowrap;font-weight:600">${fmtN(whStock, 2)}</td>
      <td style="padding:6px 8px;text-align:right;white-space:nowrap;color:#6b7280">${fmtN(l.totalStock, 2)}</td>`;
    const bsCell = !cfg.batchSerial ? '' : `<td style="padding:6px 8px;white-space:nowrap">${l.manage
      ? `<button type="button" onclick="cfPickBatchSerial(this)" style="background:#fff;border:1.5px solid ${cfg.theme.color};color:${cfg.theme.color};border-radius:5px;padding:4px 10px;font-size:11.5px;font-weight:600;cursor:pointer">${cfg.receive ? (l.manage === 'serial' ? '🔢 Create Serials' : '🏷️ Create Batches') : l.manage === 'serial' ? '🔢 Select Serials' : '📦 Select Batches'}</button>
         <div data-f="allocst" style="font-size:10.5px;color:#b91c1c;margin-top:2px">Not selected</div>`
      : cfg.bins && l.inventory !== false
      ? `<span data-binui style="display:${binWhs.has(l.warehouse) ? 'inline' : 'none'}"><button type="button" onclick="cfPickBatchSerial(this)" style="background:#fff;border:1.5px solid ${cfg.theme.color};color:${cfg.theme.color};border-radius:5px;padding:4px 10px;font-size:11.5px;font-weight:600;cursor:pointer">📍 Select Bins</button>
         <div data-f="allocst" style="font-size:10.5px;color:#b91c1c;margin-top:2px">Not selected</div></span><span data-nobin style="display:${binWhs.has(l.warehouse) ? 'none' : 'inline'};color:#9ca3af;font-size:11.5px">—</span>`
      : '<span style="color:#9ca3af;font-size:11.5px">—</span>'}</td>`;
    return `<tr data-cf-line data-linenum="${l.lineNum}" data-max="${l.openQty}" data-item="${escHtml(l.itemCode)}" data-itemname="${escHtml(l.itemName)}"
        data-price="${l.unitPrice}" data-disc="${l.discountPercent}" data-rate="${rate(l.taxCode)}"
        data-factor="${l.factor || 1}" data-manage="${l.manage || ''}" data-wh="${escHtml(l.warehouse || '')}"${l.inventory !== false ? ' data-inv="1"' : ''}${cfg.stock && l.inventory !== false ? ' data-stockcheck="1"' : ''}${l.srcAlloc ? ` data-srcalloc="${escHtml(JSON.stringify(l.srcAlloc))}"` : ''} style="border-bottom:1px solid #f3f4f6;background:#fff">
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

  // cfg.extraLines — "+ Add Line" rows for items that are not on the source document. They post without
  // a base link, so every field is editable; cfAddLine() in index.html clones this template row.
  const dftWh = src.lines[0]?.warehouse || master.warehouses[0]?.WarehouseCode || '';
  const extraTpl = !cfg.extraLines ? '' : `<template data-cf-extra-tpl><tr data-cf-extra data-price="0" data-disc="0" style="border-bottom:1px solid #f3f4f6;background:#fffdf5">
      <td style="padding:6px 8px;text-align:center"><button type="button" onclick="cfRemoveLine(this)" title="Remove line" style="background:none;border:1px solid #fca5a5;color:#b91c1c;border-radius:4px;width:22px;height:22px;cursor:pointer;line-height:1">✕</button></td>
      <td style="padding:6px 8px"><input type="text" data-f="itemq" placeholder="🔍 Search item code / name…" oninput="cfItemSearch(this)" onchange="cfItemPick(this)" autocomplete="off" style="${inp};width:220px">
        <datalist data-f="itemlist"></datalist><div data-f="itemname" style="font-size:11px;color:#6b7280;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">New line — not on ${escHtml(cfg.source.label)}</div></td>
      <td style="padding:6px 8px;text-align:right;color:#9ca3af">—</td>
      <td style="padding:6px 8px">${numCell('qty', 1, 80, 'min="0" step="any"')}</td>
      <td style="padding:6px 8px">${numCell('price', 0, 95, 'min="0" step="any"')}</td>
      <td style="padding:6px 8px">${numCell('disc', 0, 60, 'min="0" max="100" step="any"')}</td>
      <td style="padding:6px 8px"><select data-f="tax" onchange="cfCalc(this)" style="${inp};width:120px;background:#fff">${taxOpts(src.lines[0]?.taxCode || '')}</select></td>
      <td style="padding:6px 8px"><select data-f="wh" onchange="cfWhChange(this)" style="${inp};width:90px;background:#fff">${whOpts(dftWh, null)}</select></td>${cfg.stock ? '<td></td><td></td>' : ''}${!cfg.batchSerial ? '' : !cfg.receive ? '<td></td>' : `
      <td style="padding:6px 8px;white-space:nowrap"><span data-binui style="display:none"><button type="button" data-allocbtn onclick="cfPickBatchSerial(this)" style="background:#fff;border:1.5px solid ${cfg.theme.color};color:${cfg.theme.color};border-radius:5px;padding:4px 10px;font-size:11.5px;font-weight:600;cursor:pointer">📍 Select Bins</button>
         <div data-f="allocst" style="font-size:10.5px;color:#b91c1c;margin-top:2px">Not selected</div></span><span data-nobin style="color:#9ca3af;font-size:11.5px">—</span></td>`}
      <td data-f="total" style="padding:6px 8px;text-align:right;font-weight:700;color:${cfg.theme.color};white-space:nowrap">${fmtN(0)}</td>
    </tr></template>`;

  const field = (label, html) => `<div><div style="font-size:11px;color:#6b7280;margin-bottom:3px">${label}</div>${html}</div>`;
  const hdrInp = `width:100%;${inp};padding:6px 8px;font-size:13px`;
  const ptOpts = `<option value="">— Customer default —</option>` + master.payTerms.map(p =>
    `<option value="${p.GroupNumber}">${escHtml(p.PaymentTermsGroupName)}</option>`).join('');
  const dueDefault = cfg.defaultDueDate(src);

  const body = `${selectedCustomerBanner(cfg, { cardCode: src.cardCode, cardName: src.cardName })}
    <div data-cf-form data-prefix="${cfg.prefix}" data-source="${src.docEntry}"${cfg.batchSource || cfg.receive ? ' data-batchsrc="1"' : ''}${cfg.receive ? ' data-receive="1"' : ''}${cfg.bins ? ` data-binwhs="${escHtml(JSON.stringify(src.binWhs || []))}"` : ''}${cfg.bins && (cfg.batchSource || cfg.receive) ? ` data-dftbins="${escHtml(JSON.stringify(src.dftBins || {}))}"` : ''}>
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
            ${cfg.batchSerial ? `<th style="padding:6px 8px;text-align:left">Batch / Serial${cfg.bins ? ' / Bin' : ''}</th>` : ''}
            <th style="padding:6px 8px;text-align:right">Total</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>${cfg.extraLines ? `${extraTpl}
      <div style="display:flex;align-items:center;gap:10px;margin:-2px 0 12px">
        <button type="button" onclick="cfAddLine(this)" style="background:#fff;border:1.5px dashed ${cfg.theme.color};color:${cfg.theme.color};border-radius:6px;padding:6px 14px;font-size:12.5px;font-weight:600;cursor:pointer">+ Add Line</button>
        <span style="font-size:11.5px;color:#6b7280">${cfg.receive
          ? `Substitute or extra items not on the ${escHtml(cfg.source.label)} — posted as separate lines without a ${escHtml(cfg.source.short)} link (SAP locks the item on copied lines). Untick or reduce the ${escHtml(cfg.source.short)} line being replaced.`
          : `Extra items / services not on the ${escHtml(cfg.source.label)}. ${escHtml(cfg.source.label)} lines keep their item &amp; warehouse — SAP locks them on copied lines.`}</span>
      </div>` : ''}
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
    [partyOf(cfg).label, `${escHtml(src.cardName)} (${escHtml(src.cardCode)})`],
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

// cfg.source.filter — extra OData condition on the source documents, e.g. "DocType eq 'dDocument_Service'"
function srcFilter(cfg) { return cfg.source.filter ? ` and ${cfg.source.filter}` : ''; }

const _customerCache = new Map(); // `${company}|${entity}` → { at, list }
const CUSTOMER_CACHE_MS = 5 * 60 * 1000;   // cleared on post (clearPartyCache), so counts stay fresh

// Source document header table by base type — for the one-query open-document count over the DB.
const HEADER_TABLE = { 13: 'OINV', 15: 'ODLN', 17: 'ORDR', 18: 'OPCH', 20: 'OPDN', 22: 'OPOR', 23: 'OQUT' };

// Direct DB connection up (reconnecting the saved one if needed)? Never throws.
async function dbAvailable() {
  if (!isConnected()) {
    const saved = dbConnRepo.getActive();
    if (saved) { try { await connectDB(saved); } catch (e) { console.error('[CopyFlow] DB reconnect failed:', e.message); } }
  }
  return isConnected();
}

// Open documents per business partner in one GROUP BY — the Service Layer route pages
// 20 rows at a time, which for thousands of open A/R invoices means hundreds of calls.
async function openDocCountsSQL(cfg) {
  const table = HEADER_TABLE[cfg.source.baseType];
  if (!table || cfg.source.filter || !(await dbAvailable())) return null;
  try {
    const rows = rowsOf(await executeSQL(`SELECT "CardCode", MAX("CardName") AS "CardName", COUNT(*) AS "Cnt"
      FROM ${tableRef(table, getActiveConfig())} WHERE "DocStatus" = 'O' AND "CANCELED" = 'N' GROUP BY "CardCode"`));
    return rows.map(r => ({ cardCode: String(r.CardCode), cardName: String(r.CardName || r.CardCode), count: Number(r.Cnt || 0) }));
  } catch (e) {
    console.error(`[CopyFlow] ${table} open counts`, e.message);
    return null;
  }
}

// Drop the cached party lists after posting, so open-document counts refresh.
function clearPartyCache(cfg) {
  _customerCache.delete(`${getCompanyId()}|${cfg.source.entity}${srcFilter(cfg)}`);
  _customerCache.delete(`${getCompanyId()}|${cfg.source.entity}${srcFilter(cfg)}|all`);
}

async function customersWithOpenDocs(cfg, sap) {
  const key = `${getCompanyId()}|${cfg.source.entity}${srcFilter(cfg)}`;
  const hit = _customerCache.get(key);
  if (hit && Date.now() - hit.at < CUSTOMER_CACHE_MS) return hit.list;
  const viaSql = await openDocCountsSQL(cfg);
  if (viaSql) {
    const list = viaSql.sort((a, b) => a.cardName.localeCompare(b.cardName));
    _customerCache.set(key, { at: Date.now(), list });
    return list;
  }
  const rows = await fetchAllPages(sap, cfg.source.entity, {
    $filter: `DocumentStatus eq 'bost_Open' and Cancelled eq 'tNO'${srcFilter(cfg)}`,
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

// Business partners of the flow's card type → [{ CardCode, CardName }]. One query on OCRD over the
// direct DB connection when it is up; otherwise the Service Layer, which pages 20 rows at a time.
async function allPartners(cfg, sap) {
  if (await dbAvailable()) {
    try {
      const type = partyOf(cfg).cardType === 'cSupplier' ? 'S' : 'C';
      return rowsOf(await executeSQL(`SELECT "CardCode", "CardName" FROM ${tableRef('OCRD', getActiveConfig())} WHERE "CardType" = '${type}'`));
    } catch (e) {
      console.error('[CopyFlow] OCRD', e.message);
    }
  }
  return fetchAllPages(sap, '/BusinessPartners', { $filter: `CardType eq '${partyOf(cfg).cardType}'`, $select: 'CardCode,CardName', $orderby: 'CardName asc' }, 20000);
}

// Every customer / vendor of the flow's card type, with the open-document count merged in (cfg.allParties).
async function allPartiesWithCounts(cfg, sap) {
  const key = `${getCompanyId()}|${cfg.source.entity}${srcFilter(cfg)}|all`;
  const hit = _customerCache.get(key);
  if (hit && Date.now() - hit.at < CUSTOMER_CACHE_MS) return hit.list;
  const [bps, open] = await Promise.all([
    allPartners(cfg, sap),
    customersWithOpenDocs(cfg, sap).catch(e => { console.error('[CopyFlow] open docs count', e.message); return []; }),
  ]);
  const counts = new Map(open.map(c => [c.cardCode, c.count]));
  const list = bps.map(b => ({ cardCode: String(b.CardCode), cardName: String(b.CardName || b.CardCode), count: counts.get(b.CardCode) || 0 }))
    .sort((a, b) => (b.count > 0) - (a.count > 0) || a.cardName.localeCompare(b.cardName));   // open docs first
  _customerCache.set(key, { at: Date.now(), list });
  return list;
}

async function searchCustomers(cfg, sap, query) {
  const q = odataStr(query);
  const r = await sap.get('/BusinessPartners', {
    $filter: `CardType eq '${partyOf(cfg).cardType}' and (substringof('${q}',CardName) or substringof('${q}',CardCode))`,
    $select: 'CardCode,CardName', $orderby: 'CardName', $top: 20,
  });
  return (Array.isArray(r.value) ? r.value : []).map(c => ({ cardCode: c.CardCode, cardName: c.CardName }));
}

async function openDocsForCustomer(cfg, sap, cardCode) {
  return fetchAllPages(sap, cfg.source.entity, {
    $filter: `DocumentStatus eq 'bost_Open' and Cancelled eq 'tNO' and CardCode eq '${odataStr(cardCode)}'${srcFilter(cfg)}`,
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
        base:            l.BaseType != null && l.BaseType >= 0 ? { type: Number(l.BaseType), entry: Number(l.BaseEntry), line: Number(l.BaseLine) } : null,
        srcAlloc:        lineAlloc(l, `${cfg.source.label} #${doc.DocNum}`),
      }))
      .filter(l => l.openQty > 0),
  };
}

// Batches / serials recorded on a document line → { label, batches:[{batch,qty}], serials:[serial] } or null.
function lineAlloc(l, label) {
  const batches = (l.BatchNumbers || []).filter(b => b.BatchNumber).map(b => ({ batch: String(b.BatchNumber), qty: Number(b.Quantity || 0) }));
  const serials = (l.SerialNumbers || []).map(s => s.InternalSerialNumber).filter(Boolean).map(String);
  return batches.length || serials.length ? { label, batches, serials } : null;
}

// Inbound return (cfg.batchSource): batches are those on the source document or new ones typed
// by the user; serials must be on the source document. Nothing picked → take them from the source
// line in order, up to the returned quantity, into the warehouse's default bin (dftBin) if it has bins.
function checkSourceAlloc(base, l, invQty, dftBin) {
  const src = base.srcAlloc || { label: 'the source document', batches: [], serials: [] };
  const at = dftBin ? { binAbs: dftBin.binAbs } : {};
  if (base.manage === 'batch') {
    if (!(l.batches || []).some(b => Number(b.qty) > 0)) {
      let left = invQty;
      l.batches = [];
      for (const b of src.batches) { const take = Math.min(b.qty, left); if (take > 1e-9) { l.batches.push({ batch: b.batch, qty: take, ...at }); left -= take; } }
    }
    const onSrc = new Map(src.batches.map(b => [b.batch, b.qty]));
    const total = new Map();
    for (const b of l.batches) {
      const name = String(b.batch || '').trim(), qty = Number(b.qty);
      if (!(qty > 0)) continue;
      if (!name) return errorCard('Batch number missing', `${escHtml(base.itemCode)}: enter a batch number for every quantity.`);
      if (name.length > 36) return errorCard('Batch number too long', `${escHtml(base.itemCode)}: batch ${escHtml(name)} is longer than 36 characters.`);
      b.batch = name;
      total.set(name, (total.get(name) || 0) + qty);
    }
    for (const [name, qty] of total) {
      if (onSrc.has(name) && qty > onSrc.get(name) + 1e-6) {
        return errorCard('Batch quantity too high', `${escHtml(base.itemCode)}: batch ${escHtml(name)} — ${fmtN(qty, 2)} exceeds the ${fmtN(onSrc.get(name), 2)} on ${escHtml(src.label)}.`);
      }
    }
  } else if (base.manage === 'serial') {
    if (!src.serials.length) return errorCard('Serials not found', `${escHtml(base.itemCode)}: no serial numbers are recorded on the source document line — they cannot be returned on this credit memo.`);
    if (!(l.serials || []).some(s => s && s.serial)) l.serials = src.serials.slice(0, Math.round(invQty)).map(serial => ({ serial, ...at }));
    const onSrc = new Set(src.serials);
    const bad = l.serials.find(s => s && s.serial && !onSrc.has(String(s.serial)));
    if (bad) return errorCard('Serial not on source document', `${escHtml(base.itemCode)}: serial ${escHtml(bad.serial)} is not on ${escHtml(src.label)}.`);
  }
  return null;
}

// Documents whose lines carry the batch / serial numbers that moved the stock.
const BASE_DOCS = {
  20: { entity: '/PurchaseDeliveryNotes', label: 'GRPO' },
  15: { entity: '/DeliveryNotes',         label: 'Delivery' },
};

// For managed lines whose source document holds no batches/serials itself (e.g. an
// A/P Invoice copied from a GRPO), read them from the base document line instead —
// so the picker can show exactly which batches / serials came in on this document.
async function attachBaseAllocations(sap, src) {
  const docs = new Map();
  for (const l of src.lines) {
    if (!l.manage || l.srcAlloc || !l.base || !BASE_DOCS[l.base.type]) continue;
    const key = `${l.base.type}|${l.base.entry}`;
    if (!docs.has(key)) {
      docs.set(key, await sap.get(`${BASE_DOCS[l.base.type].entity}(${l.base.entry})`)
        .catch(e => { console.error('[CopyFlow] base doc', key, e.message); return null; }));
    }
    const doc  = docs.get(key);
    const line = doc?.DocumentLines?.find(x => Number(x.LineNum) === l.base.line);
    if (line) l.srcAlloc = lineAlloc(line, `${BASE_DOCS[l.base.type].label} #${doc.DocNum}`);
  }
}

// Adds per-warehouse on-hand stock and batch/serial management to each line.
async function enrichWithStock(sap, src) {
  const codes = [...new Set(src.lines.map(l => l.itemCode))];
  const items = await Promise.all(codes.map(code =>
    sap.get(`/Items('${odataStr(code)}')`, { $select: 'ItemCode,InventoryItem,ManageBatchNumbers,ManageSerialNumbers,QuantityOnStock,ItemWarehouseInfoCollection' })
      .catch(e => { console.error('[CopyFlow] item stock', code, e.message); return null; })));
  const byCode = new Map(items.filter(Boolean).map(i => [i.ItemCode, i]));
  for (const l of src.lines) {
    const it = byCode.get(l.itemCode);
    l.manage     = it?.ManageSerialNumbers === 'tYES' ? 'serial' : it?.ManageBatchNumbers === 'tYES' ? 'batch' : '';
    l.inventory  = it ? it.InventoryItem !== 'tNO' : true;   // non-stock items skip the on-hand check
    l.totalStock = Number(it?.QuantityOnStock || 0);
    l.stock      = Object.fromEntries((it?.ItemWarehouseInfoCollection || []).map(w => [w.WarehouseCode, Number(w.InStock || 0)]));
  }
}

// Default bin of each given warehouse → { whs: { binAbs, binCode } } (warehouses without one are left out).
async function defaultBins(sap, whsCodes) {
  const out = {};
  if (!whsCodes.length) return out;
  try {
    const whs = await fetchAllPages(sap, '/Warehouses', { $filter: "EnableBinLocations eq 'tYES'", $select: 'WarehouseCode,DefaultBin' }, 1000);
    const want = whs.filter(w => whsCodes.includes(w.WarehouseCode) && Number(w.DefaultBin) > 0);
    await Promise.all(want.map(async w => {
      const bin = await sap.get(`/BinLocations(${Number(w.DefaultBin)})`, { $select: 'AbsEntry,BinCode' }).catch(() => null);
      out[w.WarehouseCode] = { binAbs: Number(w.DefaultBin), binCode: bin?.BinCode || String(w.DefaultBin) };
    }));
  } catch (e) {
    console.error('[CopyFlow] default bins', e.message);
  }
  return out;
}

// Codes of the warehouses with "Enable Bin Locations" ticked (OWHS.BinActivat).
async function binWarehouses(sap) {
  try {
    const rows = await fetchAllPages(sap, '/Warehouses', { $filter: "EnableBinLocations eq 'tYES'", $select: 'WarehouseCode' }, 1000);
    return rows.map(w => w.WarehouseCode);
  } catch (e) {
    console.error('[CopyFlow] bin warehouses', e.message);
    return [];
  }
}

async function ensureDb(what) {
  if (!isConnected()) {
    const saved = dbConnRepo.getActive();   // same auto-reconnect as chat-server.mjs
    if (saved) { try { await connectDB(saved); } catch (e) { console.error('[CopyFlow] DB reconnect failed:', e.message); } }
  }
  if (!isConnected()) throw new Error(`Direct database connection is not active — connect it under Settings → DB Connection to load ${what}.`);
}

// Batches / serials available in a warehouse — read from SAP's OBTQ/OBTN and
// OSRQ/OSRN tables over the direct DB connection (the Service Layer does not
// expose per-warehouse batch or serial quantities).
export async function listBatchSerials(kind, itemCode, whsCode) {
  await ensureDb('batches/serials');
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

// OBIN.RtrictType — Restricted Transactions on the bin master. An outbound
// document (Delivery) cannot issue from: 1 = All Transactions, 3 = All Outbound,
// 4 = All Except Inventory Transactions. (0 = None, 2 = All Inbound are fine.)
const OUTBOUND_BLOCKED = new Set(['1', '3', '4']);
// An inbound document (A/R Credit Memo) cannot receive into: 1 = All, 2 = All Inbound, 4 = All Except Inventory.
const INBOUND_BLOCKED  = new Set(['1', '2', '4']);

// Bin master of a warehouse (OBIN rows + OWHS flags), cached briefly — it rarely changes,
// and re-reading every bin of a large warehouse on each picker open is the slow part.
// Only the columns used are selected; * is the fallback for localizations missing one.
const BIN_MASTER_TTL_MS = 5 * 60 * 1000;
const _binMaster = new Map();   // `${OBIN table ref}|${whs}` → { at, bins, whs }
async function binMaster(t, wc) {
  const key = `${t('OBIN')}|${wc}`;
  const hit = _binMaster.get(key);
  if (hit && Date.now() - hit.at < BIN_MASTER_TTL_MS) return hit;
  const pick = (cols, table) => executeSQL(`SELECT ${cols} FROM ${t(table)} WHERE "WhsCode" = '${wc}'`)
    .catch(() => executeSQL(`SELECT * FROM ${t(table)} WHERE "WhsCode" = '${wc}'`));
  const [bins, whs] = await Promise.all([
    pick('"AbsEntry", "BinCode", "Disabled", "RtrictType"', 'OBIN'),
    pick('"DftBinAbs", "BinActivat"', 'OWHS'),
  ]);
  const entry = { at: Date.now(), bins: rowsOf(bins), whs: rowsOf(whs)[0] || {} };
  _binMaster.set(key, entry);
  return entry;
}

// Bins of a bin-enabled warehouse that SAP allows a Delivery to issue from:
// active (OBIN.Disabled <> 'Y') and not transaction-restricted for outbound.
async function allowedBins(t, wc, blocked = OUTBOUND_BLOCKED) {
  const { bins, whs: w } = await binMaster(t, wc);
  const defaultAbs = Number(w.DftBinAbs || 0);
  const allowed = new Map();
  for (const b of bins) {
    if (String(b.Disabled || 'N') === 'Y' || blocked.has(String(b.RtrictType ?? '0'))) continue;
    allowed.set(Number(b.AbsEntry), { binAbs: Number(b.AbsEntry), binCode: String(b.BinCode || b.AbsEntry), isDefault: Number(b.AbsEntry) === defaultAbs });
  }
  return { allowed, binEnabled: String(w.BinActivat || 'N') === 'Y' };
}

// Stock per bin in a warehouse, limited to the bins a Delivery may issue from —
// like SAP's Bin Location Allocation window. kind: 'bin' (plain item, OIBQ),
// 'batch' (batch per bin, OBBQ) or 'serial' (serial per bin, OSBQ).
// → { rows, hidden } where hidden counts in-stock bins excluded as disabled/restricted.
export async function listBinStock(kind, itemCode, whsCode) {
  await ensureDb('bin locations');
  const t = n => tableRef(n, getActiveConfig());
  const ic = odataStr(itemCode), wc = odataStr(whsCode);
  const { allowed, binEnabled } = await allowedBins(t, wc);
  if (!binEnabled) throw new Error(`Warehouse ${whsCode} does not have bin locations enabled.`);

  let raw;
  if (kind === 'batch') {
    raw = rowsOf(await executeSQL(`SELECT T0."DistNumber", T0."ExpDate", T0."MnfDate", T0."InDate", T1."BinAbs", T1."OnHandQty"
      FROM ${t('OBTN')} T0 INNER JOIN ${t('OBBQ')} T1 ON T1."SnBMDAbs" = T0."AbsEntry"
      WHERE T1."ItemCode" = '${ic}' AND T1."WhsCode" = '${wc}' AND T1."OnHandQty" > 0`)).map(r => ({
      batch: r.DistNumber, expiry: dateOnly(r.ExpDate), mfg: dateOnly(r.MnfDate), admission: dateOnly(r.InDate),
      binAbs: Number(r.BinAbs), qty: Number(r.OnHandQty || 0),
    }));
  } else if (kind === 'serial') {
    raw = rowsOf(await executeSQL(`SELECT T0."DistNumber", T0."MnfSerial", T0."LotNumber", T0."SysNumber", T0."ExpDate", T0."InDate", T1."BinAbs", T1."OnHandQty"
      FROM ${t('OSRN')} T0 INNER JOIN ${t('OSBQ')} T1 ON T1."SnBMDAbs" = T0."AbsEntry"
      WHERE T1."ItemCode" = '${ic}' AND T1."WhsCode" = '${wc}' AND T1."OnHandQty" > 0`)).map(r => ({
      serial: r.DistNumber, sysNumber: Number(r.SysNumber), mfrSerial: r.MnfSerial || '', lot: r.LotNumber || '',
      expiry: dateOnly(r.ExpDate), admission: dateOnly(r.InDate), binAbs: Number(r.BinAbs), qty: Number(r.OnHandQty || 0),
    }));
  } else {
    raw = rowsOf(await executeSQL(`SELECT "BinAbs", "OnHandQty" FROM ${t('OIBQ')}
      WHERE "ItemCode" = '${ic}' AND "WhsCode" = '${wc}' AND "OnHandQty" > 0`)).map(r => ({ binAbs: Number(r.BinAbs), qty: Number(r.OnHandQty || 0) }));
  }

  const rows = raw.filter(r => allowed.has(r.binAbs)).map(r => ({ ...r, ...allowed.get(r.binAbs) }));
  // Batches FEFO, serials by admission; within each the warehouse default bin first, then bin code.
  const byBin = (a, b) => (b.isDefault - a.isDefault) || a.binCode.localeCompare(b.binCode);
  const s = v => v || '9999-12-31';
  rows.sort(kind === 'batch'  ? (a, b) => s(a.expiry).localeCompare(s(b.expiry)) || s(a.admission).localeCompare(s(b.admission)) || String(a.batch).localeCompare(String(b.batch)) || byBin(a, b)
          : kind === 'serial' ? (a, b) => s(a.admission).localeCompare(s(b.admission)) || String(a.serial).localeCompare(String(b.serial))
          : byBin);
  return { rows, hidden: new Set(raw.filter(r => !allowed.has(r.binAbs)).map(r => r.binAbs)).size };
}

// Bins of a warehouse an inbound document may receive into — default bin first, then bin code.
export async function listReceiveBins(whsCode) {
  await ensureDb('bin locations');
  const t = n => tableRef(n, getActiveConfig());
  const { allowed, binEnabled } = await allowedBins(t, odataStr(whsCode), INBOUND_BLOCKED);
  if (!binEnabled) throw new Error(`Warehouse ${whsCode} does not have bin locations enabled.`);
  return [...allowed.values()].sort((a, b) => (b.isDefault - a.isDefault) || a.binCode.localeCompare(b.binCode));
}

// Express handler: GET ?kind=batch|serial|bin&itemCode=&whs=[&bins=1]  ·  ?kind=receivebins&whs=
// bins=1 (or kind=bin) returns stock split per allowed bin location.
// Receiving bins over the Service Layer — used when the direct DB connection is not active.
// Only active bins (inbound restrictions are not exposed there); default bin first.
async function listReceiveBinsSL(sap, whsCode) {
  const w = await sap.get(`/Warehouses('${odataStr(whsCode)}')`, { $select: 'WarehouseCode,EnableBinLocations,DefaultBin' });
  if (w.EnableBinLocations !== 'tYES') throw new Error(`Warehouse ${whsCode} does not have bin locations enabled.`);
  const dft = Number(w.DefaultBin || 0);
  const params = f => ({ $filter: `${f} eq '${odataStr(whsCode)}' and Inactive eq 'tNO'`, $select: 'AbsEntry,BinCode', $orderby: 'BinCode asc' });
  const rows = await fetchAllPages(sap, '/BinLocations', params('Warehouse'), 5000)
    .catch(() => fetchAllPages(sap, '/BinLocations', params('WarehouseCode'), 5000));
  return rows.map(b => ({ binAbs: Number(b.AbsEntry), binCode: String(b.BinCode || b.AbsEntry), isDefault: Number(b.AbsEntry) === dft }))
    .sort((a, b) => (b.isDefault - a.isDefault) || a.binCode.localeCompare(b.binCode));
}

// getActiveSap (optional) enables the Service Layer fallback for kind=receivebins.
export function batchSerialRoute(getActiveSap) {
  return async (req, res) => {
    try {
      if (req.query.kind === 'receivebins') {
        const whs = String(req.query.whs || '').trim();
        if (!whs) return res.json({ ok: false, error: 'whs is required' });
        let rows;
        try { rows = await listReceiveBins(whs); }
        catch (e) {
          if (!getActiveSap || isConnected()) throw e;
          rows = await listReceiveBinsSL(getActiveSap(), whs);
        }
        return res.json({ ok: true, kind: 'receivebins', rows });
      }
      const kind = ['serial', 'bin'].includes(req.query.kind) ? req.query.kind : 'batch';
      const itemCode = String(req.query.itemCode || '').trim(), whs = String(req.query.whs || '').trim();
      if (!itemCode || !whs) return res.json({ ok: false, error: 'itemCode and whs are required' });
      if (kind === 'bin' || req.query.bins === '1') return res.json({ ok: true, kind, bins: true, ...(await listBinStock(kind, itemCode, whs)) });
      res.json({ ok: true, kind, rows: await listBatchSerials(kind, itemCode, whs) });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  };
}

async function loadSourceByNum(cfg, sap, docNum) {
  const r = await sap.get(cfg.source.entity, {
    $filter: `DocNum eq ${parseInt(docNum, 10)} and DocumentStatus eq 'bost_Open'${srcFilter(cfg)}`,
    $select: 'DocEntry', $top: 1,
  });
  const entry = r.value?.[0]?.DocEntry;
  return entry ? loadSource(cfg, sap, entry) : null;
}

// Receipt of new stock (cfg.receive, e.g. GRPO): batches / serials are created on posting.
// l.batches [{batch, qty, expiry, mfg, binAbs}] · l.serials [{serial, mfrSerial, expiry, binAbs}] · l.bins [{binAbs, qty}]
// → { alloc } or { error } (an errorCard). Quantities are inventory UoM.
function receiveAlloc(itemCode, manage, l, invQty, inBins, whs) {
  const code = escHtml(itemCode);
  const binAlloc = (binAbs, qty, snbLine) => ({ BinAbsEntry: Number(binAbs), Quantity: qty, AllowNegativeQuantity: 'tNO', SerialAndBatchNumbersBaseLine: snbLine });
  const noBin = what => errorCard('Bin location not selected', `${code}: warehouse ${escHtml(whs)} uses bin locations — pick the bin for ${what}.`);
  const date = d => (/^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) ? sapDate(String(d)) : null);
  if (manage === 'batch') {
    const picks = (l.batches || []).map(b => ({ ...b, batch: String(b.batch || '').trim() })).filter(b => Number(b.qty) > 0);
    if (picks.some(b => !b.batch)) return { error: errorCard('Batch number missing', `${code}: enter a batch number for every quantity.`) };
    const long = picks.find(b => b.batch.length > 36);
    if (long) return { error: errorCard('Batch number too long', `${code}: batch ${escHtml(long.batch)} is longer than 36 characters.`) };
    if (inBins) { const b = picks.find(x => !(Number(x.binAbs) > 0)); if (b) return { error: noBin(`batch ${escHtml(b.batch)}`) }; }
    const batches = [];
    for (const b of picks) {
      const ex = batches.find(x => x.BatchNumber === b.batch);
      if (ex) { ex.Quantity += Number(b.qty); continue; }
      batches.push({
        BatchNumber: b.batch, Quantity: Number(b.qty),
        ...(date(b.expiry) ? { ExpiryDate: date(b.expiry) } : {}),
        ...(date(b.mfg)    ? { ManufacturingDate: date(b.mfg) } : {}),
      });
    }
    const sum = batches.reduce((t, b) => t + b.Quantity, 0);
    if (!batches.length || Math.abs(sum - invQty) > 1e-6) return { error: errorCard('Batches not created', `${code}: create batches for exactly ${fmtN(invQty, 2)} (entered ${fmtN(sum, 2)}).`) };
    const alloc = { BatchNumbers: batches };
    if (inBins) alloc.DocumentLinesBinAllocations = picks.map(b => binAlloc(b.binAbs, Number(b.qty), batches.findIndex(x => x.BatchNumber === b.batch)));
    return { alloc };
  }
  if (manage === 'serial') {
    const serials = (l.serials || []).map(x => ({ ...x, serial: String(x?.serial || '').trim() })).filter(x => x.serial);
    if (Math.abs(invQty - Math.round(invQty)) > 1e-6 || serials.length !== Math.round(invQty)) {
      return { error: errorCard('Serials not created', `${code}: enter exactly ${fmtN(invQty, 0)} serial number(s) (entered ${serials.length}).`) };
    }
    const names = serials.map(x => x.serial.toUpperCase()), dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup) return { error: errorCard('Duplicate serial number', `${code}: serial ${escHtml(dup)} is entered twice.`) };
    if (serials.some(x => x.serial.length > 36)) return { error: errorCard('Serial number too long', `${code}: serial numbers can be at most 36 characters.`) };
    if (inBins) { const x = serials.find(y => !(Number(y.binAbs) > 0)); if (x) return { error: noBin(`serial ${escHtml(x.serial)}`) }; }
    const alloc = { SerialNumbers: serials.map(x => ({
      InternalSerialNumber: x.serial, Quantity: 1,
      ...(x.mfrSerial ? { ManufacturerSerialNumber: String(x.mfrSerial).trim() } : {}),
      ...(date(x.expiry) ? { ExpiryDate: date(x.expiry) } : {}),
    })) };
    if (inBins) alloc.DocumentLinesBinAllocations = serials.map((x, i) => binAlloc(x.binAbs, 1, i));
    return { alloc };
  }
  if (inBins) {
    const bins = (l.bins || []).filter(b => Number(b.binAbs) > 0 && Number(b.qty) > 0);
    const sum  = bins.reduce((t, b) => t + Number(b.qty), 0);
    if (Math.abs(sum - invQty) > 1e-6) return { error: errorCard('Bins not selected', `${code}: warehouse ${escHtml(whs)} uses bin locations — allocate exactly ${fmtN(invQty, 2)} to bins (selected ${fmtN(sum, 2)}).`) };
    return { alloc: { DocumentLinesBinAllocations: bins.map(b => binAlloc(b.binAbs, Number(b.qty), -1)) } };
  }
  return { alloc: {} };
}

// ── Chat handler ───────────────────────────────────────────────────────────────

const DOC_NUM_RE = /^(?:(?:SQ|QT|QUOT|SO|ORD|DN|DEL|INV|AR|ARINV|AP|APINV|PI|GRPO|GRN)\s*)?#?\s*(\d+)$/i;

function initSession() { return { step: 'INIT', customer: null, source: null, posting: false }; }

// SAP 234006089 — "Specifying a state without a country/region is not allowed in marketing documents."
const STATE_NO_COUNTRY_RE = /state without a country|234006089/i;

// AddressExtension that gives every address carrying a State a Country — from the source
// document's own address, else the partner master. null when no country can be found.
async function countryFixForAddress(sap, cfg, src) {
  let ext = {}, bpCountry = '';
  try { ext = (await sap.get(`${cfg.source.entity}(${Number(src.docEntry)})`, { $select: 'AddressExtension' })).AddressExtension || {}; }
  catch (e) { console.error('[CopyFlow] source address', e.message); }
  try { bpCountry = (await sap.get(`/BusinessPartners('${odataStr(src.cardCode)}')`, { $select: 'Country' })).Country || ''; }
  catch (e) { console.error('[CopyFlow] partner country', e.message); }
  const country = ext.BillToCountry || ext.ShipToCountry || bpCountry;
  if (!country) return null;
  const fix = {};
  for (const side of ['BillTo', 'ShipTo']) {
    if (ext[`${side}State`]) fix[`${side}State`] = ext[`${side}State`];
    fix[`${side}Country`] = ext[`${side}Country`] || country;
  }
  return fix;
}

/**
 * cfg = {
 *   tag, prefix, apiBase, welcome,
 *   theme:  { color, bg, light },
 *   party?: { label, plural, cardType },          // default: customers (cCustomer)
 *   source: { entity, baseType, label, short, plural, dueLabel },
 *   target: { entity, label, dueLabel, dueRequired, refLabel, qtyLabel },
 *   editable: { price, disc, tax, wh }, payTerms,
 *   stock?, batchSerial?,                         // on-hand check / batch & serial selection
 *   bins?,                                        // bin allocation in bin-enabled warehouses (needs batchSerial)
 *   allParties?,                                  // step 1 lists every customer / vendor, not only those with open docs
 *   batchSource?,                                 // inbound return: batches / serials come from the source doc, not stock
 *   extraLines?,                                  // "+ Add Line" rows for items not on the source doc (no base link); route GET /items → chat.itemSearch
 *   receive?,                                     // receipt of new stock (GRPO): batches / serials are created, bins from receivebins
 *   defaultDueDate(src) → 'YYYY-MM-DD' | '',
 * }
 */
export function createCopyFlowChatHandler(cfg, getActiveSap) {
  const sessions = new Map();

  const party = partyOf(cfg);

  async function showCustomerStep(sap, note) {
    let customers = [];
    try { customers = cfg.allParties ? await allPartiesWithCounts(cfg, sap) : await customersWithOpenDocs(cfg, sap); }
    catch (e) { console.error(`[${cfg.tag}] customer list:`, e.message); }
    if (cfg.allParties && customers.length) {
      return customerPickerHtml(cfg, customers, note || `Showing all ${escHtml(party.plural)} — those with open ${escHtml(cfg.source.plural)} show the count.`);
    }
    if (!customers.length) {
      return customerPickerHtml(cfg, [], `${note ? note + '<br>' : ''}⚠️ No ${escHtml(party.plural)} with open ${escHtml(cfg.source.plural)} were found. Type a ${escHtml(party.label.toLowerCase())} name below to search.`);
    }
    return customerPickerHtml(cfg, customers, note || `Showing only ${escHtml(party.plural)} that have open ${escHtml(cfg.source.plural)}.`);
  }

  async function showSourceStep(session, sap, customer) {
    session.customer = customer;
    session.source   = null;
    const docs = await openDocsForCustomer(cfg, sap, customer.cardCode);
    if (!docs.length) {
      session.step = 'SELECT_CUSTOMER';
      // Every party is listed (allParties), so many have nothing open — point back to the list
      // already on screen instead of stacking another full picker.
      if (cfg.allParties) return errorCard(`No open ${escHtml(cfg.source.plural)} for ${escHtml(customer.cardName)}`, `Pick another ${escHtml(party.label.toLowerCase())} from the list above — those with open ${escHtml(cfg.source.plural)} show the count, e.g. “(2 open)”.`);
      return showCustomerStep(sap, `No open ${escHtml(cfg.source.plural)} for <strong>${escHtml(customer.cardName)}</strong>. Pick another ${escHtml(party.label.toLowerCase())}:`);
    }
    session.step = 'SELECT_SOURCE';
    return sourceListHtml(cfg, customer, docs);
  }

  async function showLinesStep(session, sap, src) {
    if (!src) return errorCard(`${cfg.source.label} not found`, `It may be closed, cancelled or already fully copied.`);
    if (!src.lines.length) return errorCard(`${cfg.source.label} #${src.docNum} has no open lines`, 'Every line has already been copied to a target document.');
    if (cfg.stock || cfg.batchSerial) await enrichWithStock(sap, src);
    if (cfg.batchSerial) await attachBaseAllocations(sap, src);
    if (cfg.bins) src.binWhs = await binWarehouses(sap);
    if (cfg.bins && (cfg.batchSource || cfg.receive)) src.dftBins = await defaultBins(sap, [...new Set(src.lines.map(l => l.warehouse))].filter(w => src.binWhs.includes(w)));
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
      if (cfg.stock && base.stock && base.inventory !== false && invQty > Number(base.stock[whs] || 0) + 1e-9) {
        return { reply: errorCard('Insufficient stock', `${escHtml(base.itemCode)}: needs ${fmtN(invQty, 2)} but warehouse ${escHtml(whs)} has ${fmtN(base.stock[whs] || 0, 2)} in stock. Pick another warehouse or reduce the quantity.`) };
      }
      // Bin-enabled warehouse: every stock line needs DocumentLinesBinAllocations, in inventory UoM.
      // Batch / serial picks then carry the bin they come from, linked by SerialAndBatchNumbersBaseLine.
      const inBins = cfg.bins && base.inventory !== false && (src.binWhs || []).includes(whs);
      const needBin = (x, what) => inBins && !(Number(x.binAbs) > 0) ? errorCard('Bin location not selected', `${escHtml(base.itemCode)}: warehouse ${escHtml(whs)} uses bin locations — pick the bin for ${what}.`) : null;
      const binAlloc = (binAbs, qty, snbLine) => ({ BinAbsEntry: Number(binAbs), Quantity: qty, AllowNegativeQuantity: 'tNO', SerialAndBatchNumbersBaseLine: snbLine });
      let alloc = {};
      if (cfg.receive && cfg.batchSerial) {
        const r = receiveAlloc(base.itemCode, base.manage, l, invQty, inBins, whs);
        if (r.error) return { reply: r.error };
        alloc = r.alloc;
      } else if (cfg.batchSource && base.manage) {
        const err = checkSourceAlloc(base, l, invQty, inBins ? src.dftBins?.[whs] : null);
        if (err) return { reply: err };
      }
      if (cfg.receive) { /* allocated above */ }
      else if (cfg.batchSerial && base.manage === 'batch') {
        const picks = (l.batches || []).filter(b => b.batch && Number(b.qty) > 0);
        for (const b of picks) { const err = needBin(b, `batch ${escHtml(b.batch)}`); if (err) return { reply: err }; }
        const batches = [];
        for (const b of picks) {
          const ex = batches.find(x => x.BatchNumber === String(b.batch));
          if (ex) ex.Quantity += Number(b.qty); else batches.push({ BatchNumber: String(b.batch), Quantity: Number(b.qty) });
        }
        const sum = batches.reduce((s, b) => s + b.Quantity, 0);
        if (Math.abs(sum - invQty) > 1e-6) return { reply: errorCard('Batches not selected', `${escHtml(base.itemCode)}: select batches for exactly ${fmtN(invQty, 2)} (selected ${fmtN(sum, 2)}).`) };
        alloc = { BatchNumbers: batches };
        if (inBins) alloc.DocumentLinesBinAllocations = picks.map(b => binAlloc(b.binAbs, Number(b.qty), batches.findIndex(x => x.BatchNumber === String(b.batch))));
      } else if (cfg.batchSerial && base.manage === 'serial') {
        const serials = (l.serials || []).filter(s => s && s.serial);
        if (serials.length !== Math.round(invQty) || Math.abs(invQty - Math.round(invQty)) > 1e-6) {
          return { reply: errorCard('Serials not selected', `${escHtml(base.itemCode)}: select exactly ${fmtN(invQty, 0)} serial number(s) (selected ${serials.length}).`) };
        }
        for (const s of serials) { const err = needBin(s, `serial ${escHtml(s.serial)}`); if (err) return { reply: err }; }
        alloc = { SerialNumbers: serials.map(s => ({ InternalSerialNumber: String(s.serial), ...(s.sysNumber ? { SystemSerialNumber: Number(s.sysNumber) } : {}), Quantity: 1 })) };
        if (inBins) alloc.DocumentLinesBinAllocations = serials.map((s, i) => binAlloc(s.binAbs, 1, i));
      } else if (inBins) {
        const bins = (l.bins || []).filter(b => Number(b.binAbs) > 0 && Number(b.qty) > 0);
        const sum  = bins.reduce((s, b) => s + Number(b.qty), 0);
        if (Math.abs(sum - invQty) > 1e-6) return { reply: errorCard('Bins not selected', `${escHtml(base.itemCode)}: warehouse ${escHtml(whs)} uses bin locations — allocate exactly ${fmtN(invQty, 2)} to bins (selected ${fmtN(sum, 2)}).`) };
        alloc = { DocumentLinesBinAllocations: bins.map(b => binAlloc(b.binAbs, Number(b.qty), -1)) };
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
    // "+ Add Line" rows (cfg.extraLines) — items not on the source document, posted without a base link.
    for (const l of cfg.extraLines ? a.extraLines || [] : []) {
      const itemCode = String(l.itemCode || '').trim(), qty = Number(l.qty);
      if (!itemCode) return { reply: errorCard('Item missing', 'Pick an item from the search list on every added line, or remove the line.') };
      if (!(qty > 0)) return { reply: errorCard('Quantity missing', `${escHtml(itemCode)}: enter a quantity above zero.`) };
      if (!(Number(l.unitPrice) >= 0)) return { reply: errorCard('Invalid price', `${escHtml(itemCode)}: enter a unit price of zero or more.`) };
      let it;
      try { it = await sap.get(`/Items('${odataStr(itemCode)}')`, { $select: 'ItemCode,InventoryItem,ManageBatchNumbers,ManageSerialNumbers,PurchaseItemsPerUnit' }); }
      catch { return { reply: errorCard('Item not found', `${escHtml(itemCode)} does not exist in SAP.`) }; }
      const manage = it.ManageSerialNumbers === 'tYES' ? 'serial' : it.ManageBatchNumbers === 'tYES' ? 'batch' : '';
      if (manage && !cfg.receive) {
        return { reply: errorCard('Batch / serial item', `${escHtml(itemCode)} is batch- or serial-managed — receive it on a GRPO first, then invoice that GRPO.`) };
      }
      const inventory = it.InventoryItem !== 'tNO';
      if (inventory && !l.warehouse) return { reply: errorCard('Warehouse missing', `${escHtml(itemCode)}: pick the warehouse that receives this stock.`) };
      let alloc = {};
      if (cfg.receive && inventory) {
        // A line without a base link is entered in the item's purchasing UoM
        const invQty = qty * (Number(it.PurchaseItemsPerUnit || 1) || 1);
        const inBins = cfg.bins && (src.binWhs || []).includes(l.warehouse);
        const r = receiveAlloc(itemCode, manage, l, invQty, inBins, l.warehouse);
        if (r.error) return { reply: r.error };
        alloc = r.alloc;
      }
      lines.push({
        extra: true, alloc, itemCode, qty,
        unitPrice: Number(l.unitPrice), discountPercent: Number(l.discountPercent || 0),
        taxCode: l.taxCode || '', warehouse: inventory ? l.warehouse : '',
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
      DocumentLines: lines.map((l, i) => l.extra ? {
        ItemCode: l.itemCode, Quantity: l.qty, UnitPrice: l.unitPrice, DiscountPercent: l.discountPercent,
        ...(l.taxCode   ? { TaxCode: l.taxCode } : {}),
        ...(l.warehouse ? { WarehouseCode: l.warehouse } : {}),
        ...l.alloc,
        ...(l.alloc.DocumentLinesBinAllocations ? { DocumentLinesBinAllocations: l.alloc.DocumentLinesBinAllocations.map(b => ({ ...b, BaseLineNumber: i })) } : {}),
      } : ({
        BaseType: cfg.source.baseType, BaseEntry: Number(src.docEntry), BaseLine: l.lineNum,
        Quantity: l.qty,
        ...(cfg.editable.price ? { UnitPrice: l.unitPrice } : {}),
        ...(cfg.editable.disc  ? { DiscountPercent: l.discountPercent } : {}),
        ...(cfg.editable.tax && l.taxCode   ? { TaxCode: l.taxCode } : {}),
        ...(cfg.editable.wh  && l.warehouse ? { WarehouseCode: l.warehouse } : {}),
        ...l.alloc,
        ...(l.alloc.DocumentLinesBinAllocations ? { DocumentLinesBinAllocations: l.alloc.DocumentLinesBinAllocations.map(b => ({ ...b, BaseLineNumber: i })) } : {}),
      })),
    };

    session.posting = true;
    try {
      let result;
      try {
        result = await sap.post(cfg.target.entity, payload);
      } catch (e) {
        // The partner's bill-to / ship-to address has a State but no Country, and SAP copies it
        // onto the document — supply the missing country and post once more.
        if (!STATE_NO_COUNTRY_RE.test(e.message)) throw e;
        const addr = await countryFixForAddress(sap, cfg, src);
        if (!addr) throw new Error(`${party.label} ${src.cardCode} has an address with a State but no Country. Set the Country on its Bill-To / Ship-To address in the Business Partner master and post again.`);
        result = await sap.post(cfg.target.entity, { ...payload, AddressExtension: addr });
      }
      session.step = 'DONE';
      clearPartyCache(cfg);
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

  const chat = async function chat(req, res) {
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
        const found = await searchCustomers(cfg, sap, msg);
        if (found.length === 1) out.reply = await showSourceStep(session, sap, found[0]);
        else if (found.length) { session.step = 'SELECT_CUSTOMER'; out.reply = customerPickerHtml(cfg, found, `${found.length} ${escHtml(party.plural)} match "<strong>${escHtml(msg)}</strong>":`); }
        else out.reply = errorCard(`No ${escHtml(party.label.toLowerCase())} matches "${escHtml(msg)}"`, `Try another name or code, or a ${escHtml(cfg.source.label)} number.`);
      }

      res.json({ ok: true, sessionId: sid, step: session.step, ...out });
    } catch (e) {
      console.error(`[${cfg.tag}] chat error:`, e);
      res.status(500).json({ ok: false, error: e.message, reply: errorCard('Something went wrong', escHtml(e.message)) });
    }
  };

  // GET ?sessionId=&q=        → items matching q, for the "+ Add Line" search (cfg.extraLines)
  // GET ?sessionId=&itemCode= → that item with the session's business partner price
  chat.itemSearch = async function itemSearch(req, res) {
    try {
      const sap = getActiveSap();
      const itemCode = String(req.query.itemCode || '').trim();
      if (itemCode) {
        const it = await sap.get(`/Items('${odataStr(itemCode)}')`, { $select: 'ItemCode,ItemName,InventoryItem,ManageBatchNumbers,ManageSerialNumbers,DefaultWarehouse,PurchaseItemsPerUnit' });
        const cardCode = sessions.get(String(req.query.sessionId || ''))?.customer?.cardCode;
        const price = cardCode ? await getItemPrice(sap, { cardCode, itemCode }).catch(() => ({ price: 0 })) : { price: 0 };
        return res.json({ ok: true, item: {
          itemCode: it.ItemCode, itemName: it.ItemName || it.ItemCode, inventory: it.InventoryItem !== 'tNO',
          managed: it.ManageSerialNumbers === 'tYES' ? 'serial' : it.ManageBatchNumbers === 'tYES' ? 'batch' : '',
          warehouse: it.DefaultWarehouse || '', price: Number(price.price || 0),
          factor: party.cardType === 'cSupplier' ? Number(it.PurchaseItemsPerUnit || 1) || 1 : 1,
        } });
      }
      const q = String(req.query.q || '').trim();
      if (q.length < 2) return res.json({ ok: true, items: [] });
      const flag = party.cardType === 'cSupplier' ? 'PurchaseItem' : 'SalesItem';
      const r = await sap.get('/Items', {
        $filter: `${flag} eq 'tYES' and Valid eq 'tYES' and (substringof('${odataStr(q)}',ItemCode) or substringof('${odataStr(q)}',ItemName))`,
        $select: 'ItemCode,ItemName', $orderby: 'ItemCode', $top: 20,
      });
      res.json({ ok: true, items: (r.value || []).map(i => ({ itemCode: i.ItemCode, itemName: i.ItemName || '' })) });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  };
  return chat;
}

export { datePlusDays, today };

// Building blocks for agents with their own form on top of this flow's cards (e.g. apinv-service-agent.mjs).
export {
  card, errorCard, customerPickerHtml, selectedCustomerBanner, allPartiesWithCounts, searchCustomers,
  openDocsForCustomer, clearPartyCache, getTaxCodes, fetchAllPages, getCompanyId, escHtml, fmtN, odataStr, sapDate,
};
