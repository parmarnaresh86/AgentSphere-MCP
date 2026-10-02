/**
 * PO → GRPO Agent
 *  Step-by-step: vendor → open Purchase Order → edit receipt lines → post Goods Receipt PO (BaseType 22).
 *  Per line: qty / price / disc / tax code / warehouse; batch- and serial-managed items create new
 *  batches / serial numbers (many per line); bin-enabled warehouses allocate to receiving bins.
 *  "+ Add Line" receives a substitute or extra item without a PO link (SAP locks the item on copied lines).
 *  The chat flow itself is shared with the other copy-from agents — see lib/copy-doc-flow.mjs.
 */
import { Router } from 'express';
import { createCopyFlowChatHandler, batchSerialRoute, today } from '../lib/copy-doc-flow.mjs';

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const FLOW = {
  tag: 'PO-GRPO', prefix: 'po-to-grpo', apiBase: '/api/po-to-grpo',
  welcome: '<div style="font-size:13.5px;font-weight:600;margin-bottom:6px">📦 Welcome to the <strong>PO → Goods Receipt PO Agent</strong>!</div>',
  theme:  { color: '#0a6ed1', bg: '#f5f9fd', light: '#eef6fc' },   // SAP S/4HANA Fiori blue, same as the other copy-from agents
  party:  { label: 'Vendor', plural: 'vendors', cardType: 'cSupplier' },
  source: { entity: '/PurchaseOrders', baseType: 22, label: 'Purchase Order', short: 'PO', plural: 'purchase orders', dueLabel: 'Delivery Date' },
  target: { entity: '/PurchaseDeliveryNotes', label: 'Goods Receipt PO', dueLabel: 'Delivery Date', dueRequired: false, refLabel: 'Vendor Ref / Delivery Note', qtyLabel: 'Recv Qty' },
  editable: { price: true, disc: true, tax: true, wh: true }, payTerms: false,
  batchSerial: true,    // batch / serial items need batches / serials …
  receive: true,        // … created on this receipt (new stock), not picked from stock
  bins: true,           // receiving bin(s) for bin-enabled warehouses
  extraLines: true,     // substitute / extra items not on the PO
  defaultDueDate: () => today(),
};

// ── Router factory ─────────────────────────────────────────────────────────────

export function createPOtoGRPOAgentRouter(deps) {
  const { requireAuth, printAuth, getActiveSap } = deps;
  const router = Router();

  const chat = createCopyFlowChatHandler(FLOW, getActiveSap);
  router.post('/chat', requireAuth, chat);

  // Item search + vendor price for the "+ Add Line" rows
  router.get('/items', requireAuth, chat.itemSearch);

  // Receiving bins of a warehouse (kind=receivebins) — Service Layer fallback without a direct DB connection
  router.get('/batch-serials', requireAuth, batchSerialRoute(getActiveSap));

  // Sessions live in the shared handler and are replaced on the next "Restart" — nothing to drop here.
  router.post('/reset', requireAuth, (req, res) => res.json({ ok: true }));

  router.get('/print/:docEntry', printAuth, async (req, res) => {
    try {
      const sap = getActiveSap();
      const doc = await sap.get(`/PurchaseDeliveryNotes(${parseInt(req.params.docEntry, 10)})`);
      res.setHeader('Content-Type', 'text/html');
      res.send(renderGRPOPrint(doc));
    } catch (e) {
      res.status(500).send(`<pre style="color:red">Error loading GRPO #${escHtml(req.params.docEntry)}: ${escHtml(e.message)}</pre>`);
    }
  });

  return router;
}

// ── Print HTML renderer ────────────────────────────────────────────────────────
function renderGRPOPrint(doc) {
  const company   = process.env.SAP_B1_COMPANY || process.env.SL_COMPANY || 'Company';
  const lines     = doc.DocumentLines || [];
  const docDate   = doc.DocDate ? doc.DocDate.slice(0, 10) : '—';
  const printedOn = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const grandTotal = lines.reduce((s, l) => s + Number(l.LineTotal || 0), 0);

  const linesHtml = lines.map((l, i) => `
    <tr>
      <td>${i + 1}</td>
      <td><strong>${l.ItemCode || ''}</strong></td>
      <td>${l.ItemDescription || ''}</td>
      <td style="text-align:right">${Number(l.Quantity || 0).toFixed(2)}</td>
      <td>${l.UoMCode || l.MeasureUnit || ''}</td>
      <td style="text-align:right">${Number(l.UnitPrice || 0) > 0 ? Number(l.UnitPrice).toFixed(2) : '—'}</td>
      <td style="text-align:right">${Number(l.LineTotal || 0) > 0 ? Number(l.LineTotal).toFixed(2) : '—'}</td>
      <td>${l.WarehouseCode || ''}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Goods Receipt PO #${doc.DocNum}</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#222;padding:28px 36px;max-width:980px;margin:auto}
    .print-btn{margin-bottom:16px;display:flex;gap:8px;justify-content:flex-end}
    .print-btn button{padding:8px 18px;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600}
    .btn-print{background:#0f766e;color:#fff}.btn-close{background:#eee;color:#333}
    .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;padding-bottom:16px;border-bottom:3px solid #0f766e}
    .co-name{font-size:20px;font-weight:700;color:#1a1d27}
    .doc-title{font-size:18px;font-weight:700;color:#0f766e;text-align:right}
    .doc-num{font-size:13px;color:#444;text-align:right;margin-top:2px}
    .info-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:20px}
    .info-box{border:1px solid #ddd;border-radius:6px;padding:12px}
    .info-label{font-size:9px;font-weight:700;text-transform:uppercase;color:#888;letter-spacing:.06em;margin-bottom:6px}
    .info-val{font-size:12px;color:#222;margin-bottom:2px}
    table{width:100%;border-collapse:collapse;margin-bottom:16px}
    thead tr{background:#0f766e}
    th{padding:8px 10px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:#fff}
    td{padding:7px 10px;border-bottom:1px solid #eee;font-size:11px}
    tr:nth-child(even) td{background:#f0fdf9}
    .totals{text-align:right;padding:12px 0 20px}
    .total-grand{font-size:14px;font-weight:700;color:#0f766e}
    .sig-section{display:grid;grid-template-columns:1fr 1fr 1fr;gap:32px;margin-top:48px}
    .sig-line{border-top:1px solid #333;margin-top:40px;padding-top:6px;font-size:9px;color:#888;text-transform:uppercase;letter-spacing:.04em;text-align:center}
    .footer{text-align:center;margin-top:24px;font-size:9px;color:#aaa;border-top:1px solid #eee;padding-top:12px}
    .watermark{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-30deg);font-size:60px;color:rgba(0,0,0,.04);font-weight:900;pointer-events:none;z-index:0}
    @media print{.print-btn{display:none}}
  </style>
</head>
<body>
<div class="watermark">GOODS RECEIPT</div>
<div class="print-btn">
  <button class="btn-close" onclick="window.close()">✕ Close</button>
  <button class="btn-print" onclick="window.print()">🖨️ Print</button>
</div>
<div class="header">
  <div>
    <div class="co-name">${company}</div>
    <div style="color:#888;font-size:11px;margin-top:2px">SAP Business One — Goods Receipt PO</div>
  </div>
  <div>
    <div class="doc-title">Goods Receipt PO</div>
    <div class="doc-num">GRPO # ${doc.DocNum}</div>
  </div>
</div>
<div class="info-grid">
  <div class="info-box">
    <div class="info-label">Vendor</div>
    <div class="info-val"><strong>${doc.CardName || '—'}</strong></div>
    ${doc.CardCode ? `<div class="info-val" style="color:#666">${doc.CardCode}</div>` : ''}
  </div>
  <div class="info-box">
    <div class="info-label">Receipt Date</div>
    <div class="info-val"><strong>${docDate}</strong></div>
    <div class="info-val" style="color:#666">Entry # ${doc.DocEntry}</div>
  </div>
  <div class="info-box">
    <div class="info-label">Reference</div>
    <div class="info-val">GRPO # <strong>${doc.DocNum}</strong></div>
    <div class="info-val" style="color:#666">Received into stock</div>
  </div>
</div>
${doc.Comments ? `<div style="border:1px solid #ddd;border-radius:6px;padding:12px;margin-bottom:20px;background:#f0fdf9;font-size:11px;line-height:1.6"><strong>📝 Comments:</strong><br><br>${doc.Comments}</div>` : ''}
<table>
  <thead>
    <tr>
      <th>#</th><th>Item Code</th><th>Description</th>
      <th style="text-align:right">Qty Received</th><th>Unit</th>
      <th style="text-align:right">Unit Price</th><th style="text-align:right">Total</th>
      <th>Warehouse</th>
    </tr>
  </thead>
  <tbody>${linesHtml}</tbody>
</table>
${grandTotal > 0 ? `<div class="totals"><div class="total-grand">Total Receipt Value: ${grandTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div></div>` : ''}
<div class="sig-section">
  <div><div class="sig-line">Received By</div></div>
  <div><div class="sig-line">Verified By</div></div>
  <div><div class="sig-line">Entered By</div></div>
</div>
<div class="footer">
  Printed on ${printedOn} &nbsp;|&nbsp; ${company} — SAP B1 Goods Receipt PO #${doc.DocNum} &nbsp;|&nbsp; Powered by Henny AI Solution
</div>
</body>
</html>`;
}
