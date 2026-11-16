/**
 * o2c-review.mjs — the final "Ready to Post" review card shared by the chat-builder sales agents
 * (Sales Order, Sales Quotation). Browser side: public/o2c-review.js (window.O2CReview).
 *
 *  • Header fields and every row are locked; "✏️ Edit Header" / the row's ✏️ button unlock them.
 *  • Rows can be removed (🗑); line totals and the document total update as you type.
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
 *   taxCodes: [{ Code, Name }], warehouses: [{ WarehouseCode }], currency
 */
export function buildReviewCard(o) {
  const taxOpt = sel => [`<option value="">— None —</option>`, ...(o.taxCodes || []).map(t =>
    `<option value="${esc(t.Code)}" ${t.Code === sel ? 'selected' : ''}>${esc(t.Code)}</option>`)].join('');
  const whOpt = sel => [`<option value="">— Default —</option>`, ...(o.warehouses || []).map(w =>
    `<option value="${esc(w.WarehouseCode)}" ${w.WarehouseCode === sel ? 'selected' : ''}>${esc(w.WarehouseCode)}</option>`)].join('');
  const total = (o.lines || []).reduce((s, l) => s + lineTotal(l), 0);

  const head = (o.header || []).map(f => `
    <div style="${f.wide ? 'grid-column:1/-1' : ''}">
      <div style="font-size:11px;color:#6b7280;margin-bottom:3px">${esc(f.label)}</div>
      <input type="${f.type === 'date' ? 'date' : 'text'}" data-h="${esc(f.key)}" value="${esc(f.value)}" placeholder="${esc(f.placeholder || '')}" disabled
        maxlength="${f.type === 'date' ? '' : 254}" style="${INPUT}">
    </div>`).join('');

  const rows = (o.lines || []).map((l, i) => `
    <tr data-row data-item="${esc(l.itemCode)}" style="border-bottom:1px solid #e5e7eb">
      <td style="padding:5px 6px;font-size:12px;color:#6b7280" data-no>${i + 1}</td>
      <td style="padding:5px 6px;font-size:12.5px"><b>${esc(l.itemCode)}</b>${l.itemName ? `<div style="font-size:11px;color:#6b7280">${esc(l.itemName)}</div>` : ''}</td>
      <td style="padding:5px 4px;width:80px"><input type="number" data-l="quantity" value="${num(l.quantity)}" min="0.001" step="any" disabled style="${CELL};width:76px;text-align:right" oninput="O2CReview.recalc(this)"></td>
      <td style="padding:5px 4px;width:95px"><input type="number" data-l="unitPrice" value="${num(l.unitPrice)}" min="0" step="any" disabled style="${CELL};width:90px;text-align:right" oninput="O2CReview.recalc(this)"></td>
      <td style="padding:5px 4px;width:62px"><input type="number" data-l="discountPercent" value="${num(l.discountPercent)}" min="0" max="100" step="any" disabled style="${CELL};width:58px;text-align:right" oninput="O2CReview.recalc(this)"></td>
      <td style="padding:5px 4px"><select data-l="taxCode" disabled style="${CELL};max-width:110px">${taxOpt(l.taxCode || '')}</select></td>
      <td style="padding:5px 4px"><select data-l="warehouseCode" disabled style="${CELL};max-width:100px">${whOpt(l.warehouseCode || '')}</select></td>
      <td style="padding:5px 6px;text-align:right;font-size:12.5px;font-weight:600" data-lt>${fmt(lineTotal(l))}</td>
      <td style="padding:5px 4px;white-space:nowrap">
        <button type="button" title="Edit this row" style="${BTN}" onclick="O2CReview.toggleRow(this)">✏️</button>
        <button type="button" title="Remove this row" style="${BTN};color:#b91c1c" onclick="O2CReview.removeRow(this)">🗑</button>
      </td>
    </tr>`).join('');

  return `<div data-o2c-review data-seq="${num(o.seq)}" data-send="${esc(o.send)}" data-action="${esc(o.postAction)}"
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
      <div style="font-size:11px;font-weight:700;color:#1d4ed8;letter-spacing:.04em;margin-bottom:6px">ROWS — click ✏️ to edit a row</div>
      <table style="width:100%;border-collapse:collapse;min-width:640px">
        <thead><tr style="background:#dbeafe;font-size:10.5px;font-weight:700;color:#1d4ed8;text-transform:uppercase">
          <th style="padding:5px 6px;text-align:left">#</th><th style="padding:5px 6px;text-align:left">Item</th>
          <th style="padding:5px 4px;text-align:right">Qty</th><th style="padding:5px 4px;text-align:right">Price</th>
          <th style="padding:5px 4px;text-align:right">Disc%</th><th style="padding:5px 4px;text-align:left">Tax</th>
          <th style="padding:5px 4px;text-align:left">Whs</th><th style="padding:5px 6px;text-align:right">Total</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div style="text-align:right;font-size:13px;margin-top:8px">Total before tax: <b data-total>${fmt(total)}</b> ${esc(o.currency || '')}</div>
    </div>

    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
      <button type="button" data-o2c-post onclick="O2CReview.post(this)"
        style="background:#0070F2;color:#fff;border:none;border-radius:6px;padding:9px 22px;font-size:13.5px;font-weight:700;cursor:pointer">${esc(o.postLabel)}</button>
      ${o.addMoreAction ? `<button type="button" onclick="O2CReview.send(this, ${esc(JSON.stringify(JSON.stringify({ action: o.addMoreAction })))})"
        style="background:#f3f4f6;color:#374151;border:1px solid #d1d5db;border-radius:6px;padding:9px 14px;font-size:13px;cursor:pointer">${esc(o.addMoreLabel || '+ Add More Items')}</button>` : ''}
    </div>
  </div>`;
}

/**
 * Validate a post from the review card against the lines the session holds.
 * Rows can be edited or removed, never added or swapped for another item here.
 * → { ok: true, header, lines } | { ok: false, error }
 */
export function readReviewPost(action, sessionLines, headerKeys) {
  const header = {};
  for (const k of headerKeys) header[k] = String(action?.header?.[k] ?? '').trim();
  const known = new Map((sessionLines || []).map(l => [l.itemCode, l]));
  const sent = Array.isArray(action?.lines) ? action.lines : [];
  if (!sent.length) return { ok: false, error: 'Keep at least one row on the document.' };
  const lines = [];
  for (const [i, r] of sent.entries()) {
    const base = known.get(r?.itemCode);
    if (!base) return { ok: false, error: `Row ${i + 1}: item ${r?.itemCode || '?'} is not on this document — use "+ Add More Items" to add items.` };
    const quantity = num(r.quantity), unitPrice = num(r.unitPrice), discountPercent = num(r.discountPercent);
    if (!(quantity > 0)) return { ok: false, error: `Row ${i + 1} (${base.itemCode}): quantity must be more than 0.` };
    if (unitPrice < 0) return { ok: false, error: `Row ${i + 1} (${base.itemCode}): price cannot be negative.` };
    if (discountPercent < 0 || discountPercent > 100) return { ok: false, error: `Row ${i + 1} (${base.itemCode}): discount must be between 0 and 100%.` };
    lines.push({ ...base, quantity, unitPrice, discountPercent, taxCode: String(r.taxCode || ''), warehouseCode: String(r.warehouseCode || '') });
  }
  return { ok: true, header, lines };
}
