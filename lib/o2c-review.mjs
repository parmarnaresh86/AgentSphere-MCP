/**
 * o2c-review.mjs — the final "Ready to Post" review card shared by the chat-builder sales agents
 * (Sales Order, Sales Quotation). Browser side: public/o2c-review.js (window.O2CReview).
 *
 *  • Header fields and every row are locked; "✏️ Edit Header" / the row's ✏️ button unlock them.
 *  • Rows can be removed (🗑); line totals, tax (estimated from the tax code's rate) and the document total
 *    update as you type. SAP works out the final tax when the document is posted.
 *  • o.addRow: "+ Add Row" adds an editable row right on the card (item search, customer price).
 *  • ✅ Post sends { action, seq, header, lines } once — the button disables itself on the first click.
 *  • seq ties the post to this card: the agent accepts a post only from the newest review card.
 */

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const fmt = n => num(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const lineTotal = l => num(l.quantity) * num(l.unitPrice) * (1 - num(l.discountPercent) / 100);

const INPUT = 'width:100%;border:1.5px solid #d1d5db;border-radius:6px;padding:6px 8px;font-size:13px;box-sizing:border-box;background:#fff';
const CELL = 'border:1.5px solid #d1d5db;border-radius:5px;padding:4px 6px;font-size:12.5px;box-sizing:border-box;background:#fff';
const BTN = 'border:1px solid #d1d5db;background:#fff;border-radius:6px;padding:3px 8px;font-size:12px;cursor:pointer';

/**
 * @param {object} o
 *   title, partyLabel, party {code,name}, seq, send (window function name, e.g. 'soaSend'),
 *   postAction, postLabel, addMoreAction, addMoreLabel,
 *   header: [{ key, label, type: 'date'|'text', value, placeholder, wide }],
 *   lines:  [{ itemCode, itemName, quantity, unitPrice, discountPercent, taxCode, warehouseCode }],
 *   taxCodes: [{ Code, Name, Rate }], warehouses: [{ WarehouseCode }], currency,
 *   addRow: { items: [{ code, name }], priceApi, sessionId, searchApi }   — optional "+ Add Row" on the card;
 *           searchApi: GET {searchApi}/items?q= adds matches from the whole item master while typing
 *   qtyOnly: true   — no price / discount / tax columns or totals (e.g. Purchase Request); the values travel as hidden fields
 *   preview: { api, label, sessionId }   — optional Preview button: POST {api}/preview { sessionId, header, lines } → { ok, html }
 */
export function buildReviewCard(o) {
  const rates = new Map((o.taxCodes || []).map(t => [t.Code, num(t.Rate)]));
  const taxOpt = sel => [`<option value="" data-rate="0">— None —</option>`, ...(o.taxCodes || []).map(t =>
    `<option value="${esc(t.Code)}" data-rate="${num(t.Rate)}" title="${esc(t.Name || '')}" ${t.Code === sel ? 'selected' : ''}>${esc(t.Code)}${num(t.Rate) ? ` (${num(t.Rate)}%)` : ''}</option>`)].join('');
  const lineTax = l => lineTotal(l) * (rates.get(l.taxCode) || 0) / 100;
  const whOpt = sel => [`<option value="">— Default —</option>`, ...(o.warehouses || []).map(w =>
    `<option value="${esc(w.WarehouseCode)}" ${w.WarehouseCode === sel ? 'selected' : ''}>${esc(w.WarehouseCode)}</option>`)].join('');
  const subTotal = (o.lines || []).reduce((s, l) => s + lineTotal(l), 0);
  const taxTotal = (o.lines || []).reduce((s, l) => s + lineTax(l), 0);
  const cur = esc(o.currency || '');
  const listId = `o2c-items-${num(o.seq)}-${Math.random().toString(36).slice(2, 7)}`;

  const head = (o.header || []).map(f => `
    <div style="${f.wide ? 'grid-column:1/-1' : ''}">
      <div style="font-size:11px;color:#6b7280;margin-bottom:3px">${esc(f.label)}</div>
      <input type="${f.type === 'date' ? 'date' : 'text'}" data-h="${esc(f.key)}" value="${esc(f.value)}" placeholder="${esc(f.placeholder || '')}" disabled
        maxlength="${f.type === 'date' ? '' : 254}" style="${INPUT}">
    </div>`).join('');

  // existing rows start locked; a new row (template) starts open, with an item search instead of the item code
  const rowHtml = (l, i, isNew) => {
    const dis = isNew ? '' : 'disabled';
    const item = isNew
      ? `<input type="text" data-item-in list="${listId}" placeholder="🔍 Item code or name" onchange="O2CReview.pickItem(this)" oninput="O2CReview.searchItems(this)" autocomplete="off" style="${CELL};width:100%;min-width:170px">
         <div data-item-name style="font-size:11px;color:#6b7280;margin-top:2px"></div>`
      : `<b>${esc(l.itemCode)}</b>${l.itemName ? `<div style="font-size:11px;color:#6b7280">${esc(l.itemName)}</div>` : ''}`;
    return `
    <tr data-row ${isNew ? 'data-new class="o2c-editing"' : ''} data-item="${esc(l.itemCode || '')}" style="border-bottom:1px solid #e5e7eb">
      <td style="padding:5px 6px;font-size:12px;color:#6b7280" data-no>${i + 1}</td>
      <td style="padding:5px 6px;font-size:12.5px">${item}</td>
      <td style="padding:5px 4px;width:80px"><input type="number" data-l="quantity" value="${num(l.quantity)}" min="0.001" step="any" ${dis} style="${CELL};width:76px;text-align:right" oninput="O2CReview.recalc(this)" onchange="O2CReview.qtyChanged(this)"></td>
      ${o.qtyOnly ? `<td style="display:none"><input type="hidden" data-l="unitPrice" value="${num(l.unitPrice)}"><input type="hidden" data-l="discountPercent" value="${num(l.discountPercent)}"><input type="hidden" data-l="taxCode" value="${esc(l.taxCode || '')}"></td>` : `
      <td style="padding:5px 4px;width:95px"><input type="number" data-l="unitPrice" value="${num(l.unitPrice)}" min="0" step="any" ${dis} style="${CELL};width:90px;text-align:right" oninput="this.dataset.manual='1';O2CReview.recalc(this)"></td>
      <td style="padding:5px 4px;width:62px"><input type="number" data-l="discountPercent" value="${num(l.discountPercent)}" min="0" max="100" step="any" ${dis} style="${CELL};width:58px;text-align:right" oninput="O2CReview.recalc(this)"></td>
      <td style="padding:5px 4px"><select data-l="taxCode" ${dis} style="${CELL};max-width:130px" onchange="O2CReview.recalc(this)">${taxOpt(l.taxCode || '')}</select></td>`}
      <td style="padding:5px 4px"><select data-l="warehouseCode" ${dis} style="${CELL};max-width:${o.qtyOnly ? 200 : 100}px">${whOpt(l.warehouseCode || '')}</select></td>
      ${o.qtyOnly ? '' : `<td style="padding:5px 6px;text-align:right;font-size:12.5px;font-weight:600" data-lt>${fmt(lineTotal(l))}</td>
      <td style="padding:5px 6px;text-align:right;font-size:12px;color:#6b7280" data-ltax>${fmt(lineTax(l))}</td>`}
      <td style="padding:5px 4px;white-space:nowrap">
        <button type="button" title="${isNew ? 'Done editing this row' : 'Edit this row'}" style="${BTN}" onclick="O2CReview.toggleRow(this)">${isNew ? '✓' : '✏️'}</button>
        <button type="button" title="Remove this row" style="${BTN};color:#b91c1c" onclick="O2CReview.removeRow(this)">🗑</button>
      </td>
    </tr>`;
  };
  const rows = (o.lines || []).map((l, i) => rowHtml(l, i, false)).join('');
  const add = o.addRow;

  return `<div data-o2c-review data-seq="${num(o.seq)}" data-send="${esc(o.send)}" data-action="${esc(o.postAction)}"
      ${add ? `data-price-api="${esc(add.priceApi || '')}" data-search-api="${esc(add.searchApi || '')}" data-sid="${esc(add.sessionId || '')}"` : ''}
      ${o.preview ? `data-preview-api="${esc(o.preview.api)}" ${add ? '' : `data-sid="${esc(o.preview.sessionId || '')}"`}` : ''}
      style="background:#eff6ff;border:1.5px solid #0070F2;border-radius:8px;padding:14px;margin:6px 0">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px">
      <div style="font-size:13px;font-weight:700;color:#1d4ed8">${esc(o.title)}</div>
    </div>
    <div style="font-size:12.5px;margin-bottom:10px">${esc(o.partyLabel)}: <strong>${esc(o.party?.name)}</strong> (${esc(o.party?.code)})</div>

    <div style="background:#fff;border:1px solid #dbeafe;border-radius:8px;padding:10px 12px;margin-bottom:10px" data-o2c-head>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <span style="font-size:11px;font-weight:700;color:#1d4ed8;letter-spacing:.04em">HEADER</span>
        <button type="button" style="${BTN}" onclick="O2CReview.toggleHeader(this)">✏️ Edit Header</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">${head}</div>
    </div>

    <div style="background:#fff;border:1px solid #dbeafe;border-radius:8px;padding:8px 10px;overflow-x:auto">
      <div style="font-size:11px;font-weight:700;color:#1d4ed8;letter-spacing:.04em;margin-bottom:6px">ROWS — click ✏️ to edit a row${add ? ', “+ Add Row” to add an item' : ''}</div>
      <table style="width:100%;border-collapse:collapse;min-width:${o.qtyOnly ? 460 : 680}px">
        <thead><tr style="background:#dbeafe;font-size:10.5px;font-weight:700;color:#1d4ed8;text-transform:uppercase">
          <th style="padding:5px 6px;text-align:left">#</th><th style="padding:5px 6px;text-align:left">Item</th>
          <th style="padding:5px 4px;text-align:right">Qty</th>${o.qtyOnly ? '<th style="display:none"></th>' : `<th style="padding:5px 4px;text-align:right">Price</th>
          <th style="padding:5px 4px;text-align:right">Disc%</th><th style="padding:5px 4px;text-align:left">Tax</th>`}
          <th style="padding:5px 4px;text-align:left">Whs</th>${o.qtyOnly ? '' : '<th style="padding:5px 6px;text-align:right">Net Total</th><th style="padding:5px 6px;text-align:right">Tax</th>'}<th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${add ? `<template data-new-row>${rowHtml({ quantity: 1, unitPrice: 0, discountPercent: 0 }, 0, true)}</template>
        <datalist id="${listId}">${(add.items || []).map(i => `<option value="${esc(i.code)}">${esc(i.name)}</option>`).join('')}</datalist>
        <button type="button" onclick="O2CReview.addRow(this)" style="margin-top:8px;background:#fff;border:1.5px dashed #0070F2;color:#0070F2;border-radius:6px;padding:6px 14px;font-size:12.5px;font-weight:600;cursor:pointer">+ Add Row</button>` : ''}
      ${o.qtyOnly ? '' : `<table style="margin:10px 0 2px auto;border-collapse:collapse;font-size:13px;min-width:260px">
        <tr><td style="padding:3px 12px;color:#6b7280">Subtotal (before tax)</td><td style="padding:3px 4px;text-align:right" data-sub>${fmt(subTotal)}</td><td style="padding:3px 4px;color:#6b7280">${cur}</td></tr>
        <tr><td style="padding:3px 12px;color:#6b7280">Tax</td><td style="padding:3px 4px;text-align:right" data-tax>${fmt(taxTotal)}</td><td style="padding:3px 4px;color:#6b7280">${cur}</td></tr>
        <tr style="border-top:2px solid #0070F2"><td style="padding:6px 12px;font-weight:700;color:#1d4ed8">Document Total</td><td style="padding:6px 4px;text-align:right;font-weight:700;font-size:14.5px;color:#1d4ed8" data-total>${fmt(subTotal + taxTotal)}</td><td style="padding:6px 4px;color:#6b7280">${cur}</td></tr>
      </table>
      <div style="text-align:right;font-size:11px;color:#9ca3af">Tax is estimated from each tax code's rate — SAP calculates the final amount when posting.</div>`}
    </div>

    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
      <button type="button" data-o2c-post onclick="O2CReview.post(this)"
        style="background:#0070F2;color:#fff;border:none;border-radius:6px;padding:9px 22px;font-size:13.5px;font-weight:700;cursor:pointer">${esc(o.postLabel)}</button>
      ${o.preview ? `<button type="button" data-o2c-preview onclick="O2CReview.preview(this)"
        style="background:#fff;color:#0070F2;border:1.5px solid #0070F2;border-radius:6px;padding:9px 18px;font-size:13px;font-weight:700;cursor:pointer">${esc(o.preview.label || '👁 Preview')}</button>` : ''}
      ${o.addMoreAction ? `<button type="button" onclick="O2CReview.send(this, ${esc(JSON.stringify(JSON.stringify({ action: o.addMoreAction })))})"
        style="background:#f3f4f6;color:#374151;border:1px solid #d1d5db;border-radius:6px;padding:9px 14px;font-size:13px;cursor:pointer">${esc(o.addMoreLabel || '+ Add More Items')}</button>` : ''}
    </div>
  </div>`;
}

/**
 * Validate a post from the review card against the lines the session holds.
 * Rows can be edited or removed; with opts.allowNew, rows for other items are accepted too and
 * flagged isNew (the caller must check those items exist in SAP).
 * → { ok: true, header, lines } | { ok: false, error }
 */
export function readReviewPost(action, sessionLines, headerKeys, opts = {}) {
  const header = {};
  for (const k of headerKeys) header[k] = String(action?.header?.[k] ?? '').trim();
  const known = new Map((sessionLines || []).map(l => [l.itemCode, l]));
  const sent = Array.isArray(action?.lines) ? action.lines : [];
  if (!sent.length) return { ok: false, error: 'Keep at least one row on the document.' };
  const lines = [];
  for (const [i, r] of sent.entries()) {
    const code = String(r?.itemCode || '').trim();
    if (!code) return { ok: false, error: `Row ${i + 1}: pick an item.` };
    const base = known.get(code);
    if (!base && !opts.allowNew) return { ok: false, error: `Row ${i + 1}: item ${code} is not on this document — use "+ Add More Items" to add items.` };
    const quantity = num(r.quantity), unitPrice = num(r.unitPrice), discountPercent = num(r.discountPercent);
    if (!(quantity > 0)) return { ok: false, error: `Row ${i + 1} (${code}): quantity must be more than 0.` };
    if (unitPrice < 0) return { ok: false, error: `Row ${i + 1} (${code}): price cannot be negative.` };
    if (discountPercent < 0 || discountPercent > 100) return { ok: false, error: `Row ${i + 1} (${code}): discount must be between 0 and 100%.` };
    lines.push({ ...(base || { itemCode: code, isNew: true }), quantity, unitPrice, discountPercent, taxCode: String(r.taxCode || ''), warehouseCode: String(r.warehouseCode || '') });
  }
  return { ok: true, header, lines };
}
