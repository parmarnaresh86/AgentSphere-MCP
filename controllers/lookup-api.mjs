/**
 * Generic lookup/autocomplete + document-fetch + print endpoints used by
 * multiple, otherwise-unrelated frontend forms (vendor/customer/item
 * pickers, warehouse/bin/batch selectors, order/PO/GRPO re-fetch for
 * delivery/GRPO/AP-invoice forms, and the print-preview page). None of this
 * is specific to any one agent — it's shared UI plumbing — so it lives in
 * its own module rather than any particular controllers/*-agent.mjs file.
 *
 * Extracted from chat-server.mjs (was two separate inline clusters under
 * "/api/suggest/*", "/api/fetch/*" and "/api/print/*") as part of splitting
 * that file into smaller modules. Unlike the agent controllers, none of
 * these routes were behind requireAuth in the original code — that's
 * preserved as-is here, not something this extraction changes.
 */
import { Router } from 'express';
import db, { connRepo, cacheRepo } from '../db.mjs';

const esc = s => String(s || '').replace(/'/g, "''");

function renderPrint(docType, doc) {
  const TITLES = { quotation:"Sales Quotation", order:"Sales Order", delivery:"Delivery Note", invoice:"A/R Invoice" };
  const title = TITLES[docType] || docType;
  const lines = (doc.DocumentLines || []).filter(l => l.LineStatus !== "bost_Close");
  const linesHtml = lines.map((l, i) => `
    <tr>
      <td>${i+1}</td>
      <td>${l.ItemCode||""}</td>
      <td>${l.ItemDescription||""}</td>
      <td style="text-align:right">${Number(l.Quantity||0).toFixed(2)}</td>
      <td>${l.UoMCode||""}</td>
      <td style="text-align:right">${Number(l.UnitPrice||0).toFixed(2)}</td>
      <td style="text-align:right">${Number(l.DiscountPercent||0).toFixed(1)}%</td>
      <td style="text-align:right">${Number(l.LineTotal||0).toFixed(2)}</td>
    </tr>`).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${title} #${doc.DocNum}</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:Arial,sans-serif;font-size:11px;color:#222;padding:28px 36px;max-width:900px;margin:auto}
    .print-btn{text-align:right;margin-bottom:16px}
    .print-btn button{padding:8px 18px;background:#5b6af0;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px}
    .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;padding-bottom:16px;border-bottom:2px solid #5b6af0}
    .company-name{font-size:20px;font-weight:700;color:#1a1d27}
    .company-sub{color:#888;font-size:11px;margin-top:2px}
    .doc-title{font-size:18px;font-weight:700;color:#5b6af0;text-align:right}
    .doc-num{font-size:13px;color:#444;text-align:right;margin-top:2px}
    .info-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px}
    .info-box{border:1px solid #ddd;border-radius:6px;padding:12px}
    .info-label{font-size:9px;font-weight:700;text-transform:uppercase;color:#888;letter-spacing:.06em;margin-bottom:6px}
    .info-val{font-size:12px;color:#222;margin-bottom:2px}
    .info-val strong{font-size:13px}
    table{width:100%;border-collapse:collapse;margin-bottom:16px}
    thead tr{background:#f0f2f8}
    th{padding:8px 10px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:#555;border-bottom:2px solid #d0d4f0}
    td{padding:7px 10px;border-bottom:1px solid #eee;font-size:11px}
    tr:nth-child(even) td{background:#fafbfe}
    .totals{text-align:right;margin-bottom:20px}
    .total-row{display:flex;justify-content:flex-end;gap:24px;padding:3px 0;font-size:12px}
    .total-row.grand{font-size:14px;font-weight:700;padding-top:8px;border-top:2px solid #222;margin-top:4px}
    .badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:10px;font-weight:700}
    .badge-open{background:#d4f4e8;color:#1a7a4a}
    .badge-close{background:#f4d4d4;color:#7a1a1a}
    .comments-box{border:1px solid #ddd;border-radius:6px;padding:12px;margin-bottom:20px;font-size:11px;color:#444}
    .signatures{display:grid;grid-template-columns:1fr 1fr 1fr;gap:24px;margin-top:40px}
    .sig{text-align:center}
    .sig-line{border-top:1px solid #333;margin-top:32px;padding-top:4px;font-size:9px;color:#888;text-transform:uppercase}
    .footer-note{text-align:center;margin-top:20px;font-size:9px;color:#aaa}
    @media print{.print-btn{display:none}.page-break{page-break-before:always}}
  </style>
</head>
<body>
<div class="print-btn"><button onclick="window.print()">🖨️ Print</button></div>

<div class="header">
  <div>
    <div class="company-name">${process.env.SAP_B1_COMPANY||"Company"}</div>
    <div class="company-sub">SAP Business One</div>
  </div>
  <div>
    <div class="doc-title">${title}</div>
    <div class="doc-num"># ${doc.DocNum}</div>
    <div style="text-align:right;margin-top:4px">
      <span class="badge ${doc.DocumentStatus==="bost_Open"?"badge-open":"badge-close"}">${doc.DocumentStatus==="bost_Open"?"Open":"Closed"}</span>
    </div>
  </div>
</div>

<div class="info-grid">
  <div class="info-box">
    <div class="info-label">Bill To / Customer</div>
    <div class="info-val"><strong>${doc.CardName||doc.CardCode||"—"}</strong></div>
    <div class="info-val">${doc.CardCode||""}</div>
    ${doc.Address?`<div class="info-val" style="margin-top:4px;white-space:pre-line">${doc.Address}</div>`:""}
  </div>
  <div class="info-box">
    <div class="info-label">Document Details</div>
    <div class="info-val"><strong>Entry #${doc.DocEntry}</strong></div>
    <div class="info-val">Date: ${doc.DocDate?.slice(0,10)||"—"}</div>
    <div class="info-val">Due: ${doc.DocDueDate?.slice(0,10)||"—"}</div>
    <div class="info-val">Currency: ${doc.DocCurrency||"—"}</div>
  </div>
</div>

<table>
  <thead>
    <tr><th>#</th><th>Item Code</th><th>Description</th><th style="text-align:right">Qty</th><th>UoM</th><th style="text-align:right">Unit Price</th><th style="text-align:right">Disc%</th><th style="text-align:right">Total</th></tr>
  </thead>
  <tbody>${linesHtml}</tbody>
</table>

<div class="totals">
  <div class="total-row"><span>Subtotal</span><span>${Number((doc.DocTotal||0)-(doc.VatSum||0)).toFixed(2)} ${doc.DocCurrency||""}</span></div>
  <div class="total-row"><span>VAT / Tax</span><span>${Number(doc.VatSum||0).toFixed(2)}</span></div>
  <div class="total-row grand"><span>Total</span><span>${Number(doc.DocTotal||0).toFixed(2)} ${doc.DocCurrency||""}</span></div>
</div>

${doc.Comments?`<div class="comments-box"><strong>Comments / Remarks:</strong><br>${doc.Comments}</div>`:""}

<div class="signatures">
  <div class="sig"><div class="sig-line">Prepared By</div></div>
  <div class="sig"><div class="sig-line">Authorized By</div></div>
  <div class="sig"><div class="sig-line">Customer Signature</div></div>
</div>

<div class="footer-note">Generated by SAP B1 Assistant · ${new Date().toLocaleString()}</div>
</body></html>`;
}

export function createLookupApiRouter(deps) {
  const { getActiveSap } = deps;
  const router = Router();

  router.get('/suggest/vendors', async (req, res) => {
    try {
      const q = (req.query.q || "").trim();
      let filter = "CardType eq 'cSupplier' and Frozen eq 'tNO'";
      if (q) {
        const e2 = esc(q.toUpperCase());
        filter += ` and (substringof('${esc(q)}',CardCode) or substringof('${esc(q)}',CardName) or substringof('${e2}',CardCode) or substringof('${e2}',CardName))`;
      }
      const d = await getActiveSap().get("/BusinessPartners", { $filter:filter, $select:"CardCode,CardName,City,Country,Phone1,EmailAddress", $top:20, $orderby:"CardName asc" });
      res.json(d.value || []);
    } catch(e) { res.status(500).json({ error:e.message }); }
  });

  router.get('/suggest/customers', async (req, res) => {
    try {
      const q = (req.query.q || "").trim();
      const companyId = connRepo.getActive()?.company || 'default';
      // Cache-first
      const rows = db.prepare(`SELECT CardCode,CardName,City,Country,Phone1,EmailAddress FROM cache_business_partners
        WHERE company_id=? AND CardType='cCustomer' AND Frozen='tNO'
        AND (CardCode LIKE ? OR CardName LIKE ?) ORDER BY CardName LIMIT 20`)
        .all(companyId, `%${q}%`, `%${q}%`);
      if (rows.length) return res.json(rows);
      // Fallback to live SAP
      let filter = "CardType eq 'cCustomer'";
      if (q) { const e2 = esc(q.toUpperCase()); filter += ` and (substringof('${esc(q)}',CardCode) or substringof('${esc(q)}',CardName) or substringof('${e2}',CardCode) or substringof('${e2}',CardName))`; }
      const d = await getActiveSap().get("/BusinessPartners", { $filter:filter, $select:"CardCode,CardName,City,Country,Phone1,EmailAddress", $top:20, $orderby:"CardName asc" });
      res.json(d.value || []);
    } catch(e) { res.status(500).json({ error:e.message }); }
  });

  router.get('/suggest/items', async (req, res) => {
    try {
      const q = (req.query.q || "").trim();
      const companyId = connRepo.getActive()?.company || 'default';
      // Cache-first
      const rows = db.prepare(`SELECT ItemCode,ItemName,ManageBatchNumbers,ManageSerialNumbers,SalesUnit,PurchaseUnit,SalesVATGroup
        FROM cache_items WHERE company_id=? AND Frozen='tNO'
        AND (ItemCode LIKE ? OR ItemName LIKE ?) ORDER BY ItemName LIMIT 20`)
        .all(companyId, `%${q}%`, `%${q}%`);
      if (rows.length) return res.json(rows);
      // Fallback to live SAP
      let filter = "ItemType eq 'itItems' and Frozen eq 'tNO'";
      if (q) filter += ` and (substringof('${esc(q)}',ItemCode) or substringof('${esc(q)}',ItemName))`;
      const d = await getActiveSap().get("/Items", { $filter:filter, $select:"ItemCode,ItemName,ManageBatchNumbers,ManageSerialNumbers,SalesUnit,PurchaseUnit,SalesVATGroup", $top:20, $orderby:"ItemName asc" });
      res.json(d.value || []);
    } catch(e) { res.status(500).json({ error:e.message }); }
  });

  // ── Tax codes (VAT Groups) — cache-first ─────────────────────────────────────
  router.get('/suggest/tax-codes', async (req, res) => {
    try {
      const companyId = connRepo.getActive()?.company || 'default';
      const cached = cacheRepo.getTaxCodes(companyId);
      if (cached.length) return res.json(cached.map(v=>({ Code:v.Code, Name:v.Name })));
      const d = await getActiveSap().get("/VatGroups", { $select:"Code,Name", $orderby:"Code asc", $top:100 });
      res.json((d.value||d||[]).map(v=>({ Code:v.Code, Name:v.Name })));
    } catch(e) { res.status(500).json({ error:e.message }); }
  });

  // ── BP Addresses (Bill-To / Ship-To) ─────────────────────────────────────────
  router.get('/suggest/bp-addresses', async (req, res) => {
    try {
      const cc = (req.query.cardCode||"").trim();
      if (!cc) return res.json([]);
      const bp = await getActiveSap().get(`/BusinessPartners('${esc(cc)}')`,
        { $select:"CardCode,CardName,BPAddresses" });
      res.json(bp.BPAddresses || []);
    } catch(e) { res.status(500).json({ error:e.message }); }
  });

  router.get('/suggest/warehouses', async (_req, res) => {
    try {
      const d = await getActiveSap().get("/Warehouses", { $filter:"Inactive eq 'tNO'", $select:"WarehouseCode,WarehouseName,EnableBinLocations", $top:100, $orderby:"WarehouseName asc" });
      res.json(d.value || []);
    } catch(e) { res.status(500).json({ error:e.message }); }
  });

  router.get('/suggest/bins', async (req, res) => {
    try {
      const { warehouse } = req.query;
      if (!warehouse) return res.json([]);
      const d = await getActiveSap().get("/BinLocations", { $filter:`WarehouseCode eq '${esc(warehouse)}' and Inactive eq 'tNO'`, $select:"AbsEntry,BinCode,WarehouseCode", $top:200, $orderby:"BinCode asc" });
      res.json(d.value || []);
    } catch(e) { res.status(500).json({ error:e.message }); }
  });

  router.get('/suggest/batches', async (req, res) => {
    try {
      const { item, warehouse } = req.query;
      if (!item) return res.json([]);
      let filter = `ItemCode eq '${esc(item)}' and Quantity gt 0`;
      if (warehouse) filter += ` and WhsCode eq '${esc(warehouse)}'`;
      const d = await getActiveSap().get("/BatchNumberDetails", { $filter:filter, $select:"BatchNumber,ItemCode,WhsCode,Quantity,ExpiryDate,AdmissionDate", $orderby:"ExpiryDate asc", $top:100 });
      res.json(d.value || []);
    } catch(e) { res.status(500).json({ error:e.message }); }
  });

  // ── Fetch order for delivery form ──
  router.get('/fetch/order/:entry', async (req, res) => {
    try {
      const doc = await getActiveSap().get(`/Orders(${req.params.entry})`);
      // Enrich each line with batch flag
      const lines = await Promise.all((doc.DocumentLines||[]).map(async (l) => {
        try {
          const item = await getActiveSap().get(`/Items('${esc(l.ItemCode)}')`);
          return { ...l, isBatch: item.ManageBatchNumbers === "tYES", isSerial: item.ManageSerialNumbers === "tYES" };
        } catch { return { ...l, isBatch: false, isSerial: false }; }
      }));
      res.json({ ...doc, DocumentLines: lines });
    } catch(e) { res.status(500).json({ error:e.message }); }
  });

  // ── Fetch PO for GRPO form ──
  router.get('/fetch/po/:entry', async (req, res) => {
    try {
      const doc = await getActiveSap().get(`/PurchaseOrders(${req.params.entry})`);
      res.json(doc);
    } catch(e) { res.status(500).json({ error:e.message }); }
  });

  // ── Fetch GRPO for AP Invoice form ──
  router.get('/fetch/grpo/:entry', async (req, res) => {
    try {
      const doc = await getActiveSap().get(`/GoodsReceiptsPO(${req.params.entry})`);
      res.json(doc);
    } catch(e) { res.status(500).json({ error:e.message }); }
  });

  // ── Print ──
  router.get('/print/:docType/:docEntry', async (req, res) => {
    const { docType, docEntry } = req.params;
    const ENTITIES = { quotation:"Quotations", order:"Orders", delivery:"DeliveryNotes", invoice:"Invoices" };
    const entity = ENTITIES[docType.toLowerCase()];
    if (!entity) return res.status(400).send("Unknown doc type");
    try {
      const doc = await getActiveSap().get(`/${entity}(${docEntry})`);
      res.setHeader("Content-Type", "text/html");
      res.send(renderPrint(docType, doc));
    } catch(e) { res.status(500).send(`<pre>Error: ${e.message}</pre>`); }
  });

  return router;
}
