/**
 * doc-totals.mjs — tax and document totals for the sales / purchase transaction agents.
 *
 *   docAmounts(doc)                 SAP's own amounts of a posted document (document currency):
 *                                   per line { net, tax, rate, gross } + subTotal, discount, tax, other
 *                                   (freight / charges), rounding, total, currency
 *   estimateAmounts(lines, taxCodes) the same shape, estimated from the tax-code rates — for when SAP
 *                                   didn't send the document back. lines: [{ quantity, unitPrice,
 *                                   discountPercent, taxCode }]; result has estimated: true
 *   resultAmounts(result, lines, taxCodes)  docAmounts(result) when the POST response carries the
 *                                   document with the same number of lines, else estimateAmounts
 *   cardTotalsHtml(amt, { color, label })   Subtotal / Discount / Tax / Freight / Rounding / Total block
 *                                   for the success card in the chat
 *   printTotalsHtml(amt, { color, label })  the same block for a print page (self-contained styles)
 *   printTaxHeads() / printTaxCells(amt, i)  extra print columns: Net Total · Tax % · Tax · Gross Total
 *   money(v)                        1,234.50
 */

const n = v => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
export const money = v => n(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Amounts of a SAP document — the foreign-currency fields on an FC document, else local currency. */
export function docAmounts(doc) {
  const fc = n(doc?.DocTotalFc) !== 0;   // SAP leaves the FC total at 0 on local-currency documents
  const lines = (doc?.DocumentLines || []).map(l => {
    const net = fc ? n(l.RowTotalFC) : n(l.LineTotal);
    const tax = fc ? n(l.NetTaxAmountFC ?? l.TaxTotalFC) : n(l.NetTaxAmount ?? l.TaxTotal);
    return { net, tax, rate: n(l.TaxPercentagePerRow), gross: net + tax };
  });
  const subTotal = lines.reduce((s, l) => s + l.net, 0);
  const tax      = fc ? n(doc.VatSumFc) : n(doc.VatSum);
  const discount = fc ? n(doc.TotalDiscountFC) : n(doc.TotalDiscount);
  const total    = fc ? n(doc.DocTotalFc) : n(doc.DocTotal);
  const rounding = fc ? n(doc.RoundingDiffAmountFC) : n(doc.RoundingDiffAmount);
  // freight / other charges = whatever is left between the parts and SAP's total
  const other    = total - (subTotal - discount + tax + rounding);
  return { lines, subTotal, discount, tax, rounding, other: Math.abs(other) >= 0.005 ? other : 0, total, currency: doc?.DocCurrency || '' };
}

/** Estimate from the tax-code rates (taxCodes: [{ Code, Rate }]). */
export function estimateAmounts(lines, taxCodes = []) {
  const rates = new Map((taxCodes || []).map(t => [t.Code, n(t.Rate)]));
  const ls = (lines || []).map(l => {
    const net = n(l.quantity ?? l.qty) * n(l.unitPrice) * (1 - n(l.discountPercent) / 100);
    const rate = rates.get(l.taxCode) || 0, tax = net * rate / 100;
    return { net, tax, rate, gross: net + tax };
  });
  const subTotal = ls.reduce((a, l) => a + l.net, 0), tax = ls.reduce((a, l) => a + l.tax, 0);
  return { lines: ls, subTotal, discount: 0, tax, rounding: 0, other: 0, total: subTotal + tax, currency: '', estimated: true };
}

/** SAP's amounts from a POST response when it carries the document, else the estimate. */
export function resultAmounts(result, lines, taxCodes) {
  if (result?.DocTotal != null && Array.isArray(result.DocumentLines) && result.DocumentLines.length === (lines || []).length)
    return docAmounts(result);
  return estimateAmounts(lines, taxCodes);
}

function rows(amt) {
  const cur = esc(amt.currency);
  const r = [['Subtotal (before tax)', money(amt.subTotal)]];
  if (amt.discount) r.push(['Discount', '− ' + money(amt.discount)]);
  r.push(['Tax', money(amt.tax)]);
  if (amt.other) r.push(['Freight / other charges', money(amt.other)]);
  if (amt.rounding) r.push(['Rounding', money(amt.rounding)]);
  return { cur, r };
}

/** Totals block for a success card in the chat. */
export function cardTotalsHtml(amt, { color = '#1d4ed8', label = 'Document Total' } = {}) {
  const { cur, r } = rows(amt);
  return `<table style="margin:10px 0 0 auto;border-collapse:collapse;font-size:13px;min-width:270px">
    ${r.map(([k, v]) => `<tr><td style="padding:3px 12px;color:#6b7280">${k}</td><td style="padding:3px 4px;text-align:right">${v} ${cur}</td></tr>`).join('')}
    <tr style="border-top:2px solid ${color}"><td style="padding:6px 12px;font-weight:700;color:${color}">${esc(label)}</td><td style="padding:6px 4px;text-align:right;font-weight:700;font-size:14.5px;color:${color}">${money(amt.total)} ${cur}</td></tr>
  </table>${amt.estimated ? '<div style="text-align:right;font-size:11px;color:#9ca3af">Estimated from the tax-code rates — open Print for the amounts saved in SAP.</div>' : ''}`;
}

/** Totals block for a print page. */
export function printTotalsHtml(amt, { color = '#0070F2', label = 'Document Total' } = {}) {
  const { cur, r } = rows(amt);
  const td = 'border:none;background:none;padding:4px 10px;font-size:12px;text-align:right';
  return `<table style="width:auto;min-width:300px;margin:4px 0 20px auto;border-collapse:collapse">
    ${r.map(([k, v]) => `<tr><td style="${td};color:#6b7280">${k}</td><td style="${td};color:#374151">${v} ${cur}</td></tr>`).join('')}
    <tr><td style="${td};border-top:2px solid ${color};font-size:15px;font-weight:700;color:${color};padding-top:8px">${esc(label)}</td><td style="${td};border-top:2px solid ${color};font-size:15px;font-weight:700;color:${color};padding-top:8px">${money(amt.total)} ${cur}</td></tr>
  </table>`;
}

/** Extra print columns. */
export function printTaxHeads(thStyle = '') {
  const s = thStyle ? ` style="${thStyle};text-align:right"` : ' style="text-align:right"';
  return `<th${s}>Net Total</th><th${s}>Tax %</th><th${s}>Tax</th><th${s}>Gross Total</th>`;
}
export function printTaxCells(amt, i, tdStyle = '') {
  const l = amt.lines[i] || { net: 0, tax: 0, rate: 0, gross: 0 };
  const s = ` style="${tdStyle ? tdStyle + ';' : ''}text-align:right"`;
  return `<td${s}>${money(l.net)}</td><td${s}>${l.rate ? l.rate + '%' : ''}</td><td${s}>${money(l.tax)}</td><td${s}><strong>${money(l.gross)}</strong></td>`;
}
