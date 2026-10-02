/**
 * A/R Invoice → A/R Credit Memo Agent
 *  Step-by-step: customer → open A/R invoice → edit credit lines → post Credit Memo (BaseType 13).
 *  The chat flow itself is shared with the other copy-from agents — see lib/copy-doc-flow.mjs.
 */
import { Router } from 'express';
import { createCopyFlowChatHandler, batchSerialRoute, today, datePlusDays } from '../lib/copy-doc-flow.mjs';

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const FLOW = {
  tag: 'ARCM', prefix: 'arinv2arcm', apiBase: '/api/arinv-arcm',
  welcome: '<div style="font-size:13.5px;font-weight:600;margin-bottom:6px">🔴 Welcome to the <strong>A/R Invoice → Credit Memo Agent</strong>!</div>',
  theme:  { color: '#0a6ed1', bg: '#f5f9fd', light: '#eef6fc' },   // SAP S/4HANA Fiori blue (was per-agent accent)
  source: { entity: '/Invoices', baseType: 13, label: 'A/R Invoice', short: 'INV', plural: 'A/R invoices', dueLabel: 'Due Date' },
  target: { entity: '/CreditNotes', label: 'A/R Credit Memo', dueLabel: 'Due Date (blank = payment terms)', dueRequired: false, refLabel: 'Customer Ref', qtyLabel: 'Credit Qty' },
  editable: { price: true, disc: true, tax: true, wh: false }, payTerms: false,
  batchSerial: true,    // managed items must carry batches / serials …
  batchSource: true,    // … taken from the A/R invoice (or its delivery) or newly created — goods come back in, not out of stock
  bins: true,           // receiving bin(s) for bin-enabled warehouses
  allParties: true,     // step 1 lists every customer, with their open-invoice count
  defaultDueDate: () => '',
};

// ── Print layout ───────────────────────────────────────────────────────────────

function renderARCMPrint(doc) {
  const company   = process.env.SAP_B1_COMPANY || process.env.SL_COMPANY || 'Company';
  const lines     = doc.DocumentLines || [];
  const docDate   = doc.DocDate    ? doc.DocDate.slice(0, 10)    : '—';
  const dueDate   = doc.DocDueDate ? doc.DocDueDate.slice(0, 10) : '—';
  const printedOn = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const grandTotal = lines.reduce((s, l) => s + Number(l.LineTotal || 0), 0);
  const taxTotal   = lines.reduce((s, l) => s + Number(l.VatSum   || 0), 0);

  const linesHtml = lines.map((l, i) => `
    <tr>
      <td>${i + 1}</td>
      <td><strong>${escHtml(l.ItemCode || '')}</strong></td>
      <td>${escHtml(l.ItemDescription || '')}</td>
      <td style="text-align:right">${Number(l.Quantity  || 0).toFixed(2)}</td>
      <td>${escHtml(l.UoMCode || l.MeasureUnit || '')}</td>
      <td style="text-align:right">${Number(l.UnitPrice || 0).toFixed(2)}</td>
      <td style="text-align:right">${Number(l.LineTotal || 0).toFixed(2)}</td>
      <td>${escHtml(l.TaxCode || '')}</td>
      <td>${escHtml(l.WarehouseCode || '')}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>A/R Credit Memo #${doc.DocNum}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:Arial,sans-serif;font-size:11px;color:#222;padding:28px 36px;max-width:1020px;margin:auto}
  .print-btn{margin-bottom:16px;display:flex;gap:8px;justify-content:flex-end}
  .print-btn button{padding:8px 18px;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600}
  .btn-print{background:#0a6ed1;color:#fff}.btn-close{background:#eee;color:#333}
  .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;padding-bottom:16px;border-bottom:3px solid #0a6ed1}
  .co-name{font-size:20px;font-weight:700;color:#1a1d27}
  .doc-title{font-size:18px;font-weight:700;color:#0a6ed1;text-align:right}
  .info-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:20px}
  .info-box{border:1px solid #ddd;border-radius:6px;padding:12px}
  .info-label{font-size:9px;font-weight:700;text-transform:uppercase;color:#888;letter-spacing:.06em;margin-bottom:6px}
  .info-val{font-size:12px;color:#222;margin-bottom:2px}
  table{width:100%;border-collapse:collapse;margin-bottom:16px}
  thead tr{background:#0a6ed1}
  th{padding:8px 10px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:#fff}
  td{padding:7px 10px;border-bottom:1px solid #eee;font-size:11px}
  tr:nth-child(even) td{background:#f5f9fd}
  .totals{text-align:right;padding:8px 0 20px}
  .total-row{font-size:12px;color:#374151;margin-bottom:4px}
  .total-grand{font-size:15px;font-weight:700;color:#0a6ed1;margin-top:6px}
  .sig-section{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;margin-top:40px;border-top:1px solid #e5e7eb;padding-top:24px}
  .sig-box{text-align:center}
  .sig-line{border-top:1px solid #374151;margin-top:36px;padding-top:6px;font-size:10px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.05em}
  .footer{text-align:center;margin-top:24px;font-size:9px;color:#aaa;border-top:1px solid #eee;padding-top:12px}
  .watermark{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-30deg);font-size:46px;color:rgba(0,0,0,.04);font-weight:900;pointer-events:none;z-index:0}
  @media print{.print-btn{display:none}}
</style></head><body>
<div class="watermark">A/R CREDIT MEMO</div>
<div class="print-btn">
  <button class="btn-close" onclick="window.close()">&#x2715; Close</button>
  <button class="btn-print" onclick="window.print()">&#x1F5A8; Print</button>
</div>
<div class="header">
  <div>
    <div class="co-name">${escHtml(company)}</div>
    <div style="color:#888;font-size:11px;margin-top:2px">SAP Business One &mdash; A/R Credit Memo</div>
  </div>
  <div>
    <div class="doc-title">A/R Credit Memo</div>
    <div style="font-size:13px;color:#444;text-align:right">CM # ${escHtml(String(doc.DocNum))}</div>
  </div>
</div>
<div class="info-grid">
  <div class="info-box">
    <div class="info-label">Customer</div>
    <div class="info-val"><strong>${escHtml(doc.CardName || '—')}</strong></div>
    ${doc.CardCode ? `<div class="info-val" style="color:#666">${escHtml(doc.CardCode)}</div>` : ''}
  </div>
  <div class="info-box">
    <div class="info-label">Posting Date / Due Date</div>
    <div class="info-val"><strong>${escHtml(docDate)}</strong></div>
    <div class="info-val" style="color:#666">Due: ${escHtml(dueDate)}</div>
  </div>
  <div class="info-box">
    <div class="info-label">Remarks / Source Invoice</div>
    <div class="info-val"><strong>${escHtml(doc.NumAtCard || '—')}</strong></div>
    <div class="info-val" style="color:#666">CM # ${escHtml(String(doc.DocNum))}</div>
  </div>
</div>
${doc.Comments ? `<div style="border:1px solid #b0d5f5;border-radius:6px;padding:12px;margin-bottom:20px;background:#f5f9fd;font-size:11px;line-height:1.6"><strong>&#x1F4DD; Remarks:</strong><br><br>${escHtml(doc.Comments)}</div>` : ''}
<table>
  <thead><tr>
    <th>#</th><th>Item Code</th><th>Description</th>
    <th style="text-align:right">Qty</th><th>Unit</th>
    <th style="text-align:right">Unit Price</th><th style="text-align:right">Total</th>
    <th>Tax</th><th>WH</th>
  </tr></thead>
  <tbody>${linesHtml}</tbody>
</table>
<div class="totals">
  ${taxTotal > 0 ? `<div class="total-row">Subtotal: ${(grandTotal - taxTotal).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>` : ''}
  ${taxTotal > 0 ? `<div class="total-row">Tax: ${taxTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>` : ''}
  <div class="total-grand">Credit Total: ${grandTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
</div>
<div class="sig-section">
  <div class="sig-box"><div class="sig-line">Prepared By</div></div>
  <div class="sig-box"><div class="sig-line">Approved By</div></div>
  <div class="sig-box"><div class="sig-line">Finance Manager</div></div>
</div>
<div class="footer">Printed on ${escHtml(printedOn)} &nbsp;|&nbsp; ${escHtml(company)} &mdash; SAP B1 A/R Credit Memo #${escHtml(String(doc.DocNum))} &nbsp;|&nbsp; Powered by Henny AI Solution</div>
</body></html>`;
}


// ── Router factory ─────────────────────────────────────────────────────────────

export function createARInvToARCMRouter(deps) {
  const { requireAuth, printAuth, getActiveSap } = deps;
  const router = Router();

  router.post('/chat', requireAuth, createCopyFlowChatHandler(FLOW, getActiveSap));

  // Bins a credit memo may receive into, for the Batch / Serial / Bin window
  router.get('/batch-serials', requireAuth, batchSerialRoute());

  // Sessions live in the shared handler and are replaced on the next "Restart" — nothing to drop here.
  router.post('/reset', requireAuth, (req, res) => res.json({ ok: true }));

  router.get('/print/:docEntry', printAuth, async (req, res) => {
    try {
      const sap = getActiveSap();
      const doc = await sap.get(`/CreditNotes(${parseInt(req.params.docEntry, 10)})`);
      res.setHeader('Content-Type', 'text/html');
      res.send(renderARCMPrint(doc));
    } catch (e) {
      res.status(500).send(`<pre style="color:red">Error loading A/R Credit Memo #${escHtml(req.params.docEntry)}: ${escHtml(e.message)}</pre>`);
    }
  });

  return router;
}
