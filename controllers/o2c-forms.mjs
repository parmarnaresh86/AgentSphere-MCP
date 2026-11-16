/**
 * o2c-forms.mjs — server side of the chat pop-up forms "Create Delivery" and "Create A/R Invoice"
 * (public/index.html openDeliveryForm / openInvoiceForm). Mounted at /api/o2c-forms.
 *
 *   GET  /open-orders?cardCode=       open Sales Orders of a customer (DocNum, dates, total)
 *   GET  /open-deliveries?cardCode=   open Deliveries of a customer
 *   GET  /delivery/:entry             a Delivery as an invoice preview: open lines with net / tax / gross,
 *                                     freight and the totals the A/R invoice will carry
 *   POST /delivery                    Delivery from a Sales Order with the quantities, warehouses, bins and
 *                                     batches edited in the form (qty capped at the open quantity)
 *   POST /ar-invoice                  A/R Invoice from a Delivery: its open lines + its freight
 *   GET  /open-invoices?cardCode=     open A/R invoices of a customer with the balance due
 *   GET  /gl-accounts?q=              postable G/L accounts (bank / cash first) for the payment account
 *   POST /incoming-payment            incoming payment: invoices + amounts, bank transfer / cash / cheque
 *
 * Batch / bin stock comes from the direct DB connection (lib/copy-doc-flow.mjs listBinStock /
 * listBatchSerials), the same as the Order → Delivery agent.
 */
import { Router } from 'express';
import { listBinStock, listBatchSerials } from '../lib/copy-doc-flow.mjs';
import { docAmounts } from '../lib/doc-totals.mjs';
import db, { connRepo } from '../db.mjs';

const q = s => String(s ?? '').replace(/'/g, "''");
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const day = s => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? String(s) : new Date().toISOString().slice(0, 10));
const addDays = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const fmt = n => num(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function createO2CFormsRouter({ requireAuth, getActiveSap }) {
  const router = Router();
  const posting = new Set();   // `${kind}:${baseEntry}` while a post is running — a second click is refused

  const openDocs = (entity) => async (req, res) => {
    try {
      const cardCode = String(req.query.cardCode || '').trim();
      if (!cardCode) return res.json({ ok: false, error: 'Select a customer first.' });
      const d = await getActiveSap().get(`/${entity}`, {
        $filter: `CardCode eq '${q(cardCode)}' and DocumentStatus eq 'bost_Open' and Cancelled eq 'tNO'`,
        $select: 'DocEntry,DocNum,DocDate,DocDueDate,DocTotal,DocCurrency,NumAtCard', $orderby: 'DocNum desc', $top: 200,
      });
      res.json({ ok: true, docs: (d.value || []).map(x => ({ docEntry: x.DocEntry, docNum: x.DocNum, docDate: String(x.DocDate || '').slice(0, 10),
        dueDate: String(x.DocDueDate || '').slice(0, 10), total: num(x.DocTotal), currency: x.DocCurrency || '', ref: x.NumAtCard || '' })) });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  };
  router.get('/open-orders', requireAuth, openDocs('Orders'));
  router.get('/open-deliveries', requireAuth, openDocs('DeliveryNotes'));

  // ── Delivery as A/R invoice preview ─────────────────────────────────────────
  async function invoicePlan(sap, entry) {
    const del = await sap.get(`/DeliveryNotes(${entry})`);
    if (del.DocumentStatus === 'bost_Close' || del.Cancelled === 'tYES') throw new Error(`Delivery #${del.DocNum} is closed — it has already been invoiced or cancelled.`);
    const all = docAmounts(del);
    const idx = (del.DocumentLines || []).map((l, i) => i).filter(i => del.DocumentLines[i].LineStatus !== 'bost_Close');
    if (!idx.length) throw new Error(`Delivery #${del.DocNum} has no open lines left to invoice.`);
    const partial = idx.length < (del.DocumentLines || []).length;
    const fc = num(del.DocTotalFc) !== 0;
    // Freight is copied only while nothing of the delivery has been invoiced yet (a partly invoiced delivery
    // already passed its freight on with the first invoice).
    const freight = partial ? [] : (del.DocumentAdditionalExpenses || [])
      .map(e => ({ code: e.ExpenseCode, amount: num(fc ? e.LineTotalFC : e.LineTotal), taxCode: e.TaxCode || '', vatGroup: e.VatGroup || '', remarks: e.Remarks || '' }))
      .filter(e => e.code != null && e.amount);
    const lines = idx.map(i => {
      const l = del.DocumentLines[i], a = all.lines[i];
      return { lineNum: l.LineNum, itemCode: l.ItemCode, itemName: l.ItemDescription || '', qty: num(l.RemainingOpenQuantity ?? l.Quantity),
        unitPrice: num(l.UnitPrice ?? l.Price), discount: num(l.DiscountPercent), taxCode: l.TaxCode || l.VatGroup || '', warehouse: l.WarehouseCode || '',
        net: a.net, tax: a.tax, rate: a.rate, gross: a.gross };
    });
    const sub = lines.reduce((s, l) => s + l.net, 0), tax = lines.reduce((s, l) => s + l.tax, 0);
    // A fully open delivery → its own totals (freight and freight tax included); otherwise the open lines only.
    const amounts = partial
      ? { subTotal: sub, discount: 0, tax, other: 0, rounding: 0, total: sub + tax, currency: all.currency }
      : all;
    return { del, lines, freight, amounts, partial };
  }

  router.get('/delivery/:entry', requireAuth, async (req, res) => {
    try {
      const { del, lines, freight, amounts, partial } = await invoicePlan(getActiveSap(), parseInt(req.params.entry, 10));
      res.json({ ok: true, header: { docEntry: del.DocEntry, docNum: del.DocNum, cardCode: del.CardCode, cardName: del.CardName,
        docDate: String(del.DocDate || '').slice(0, 10), ref: del.NumAtCard || '', currency: amounts.currency }, lines, freight, amounts, partial });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  router.post('/ar-invoice', requireAuth, async (req, res) => {
    const b = req.body || {}, entry = parseInt(b.deliveryDocEntry, 10);
    if (!entry) return res.json({ ok: false, error: 'Select a delivery.' });
    const key = `inv:${entry}`;
    if (posting.has(key)) return res.json({ ok: false, error: 'This invoice is already being posted — please wait.' });
    posting.add(key);
    try {
      const sap = getActiveSap();
      const { del, lines, freight } = await invoicePlan(sap, entry);
      if (b.cardCode && b.cardCode !== del.CardCode) throw new Error(`Delivery #${del.DocNum} belongs to ${del.CardCode}, not ${b.cardCode}.`);
      const docDate = day(b.docDate), due = Math.max(0, parseInt(b.dueInDays, 10) || 0);
      const payload = {
        CardCode: del.CardCode, DocDate: docDate, TaxDate: docDate, DocDueDate: addDays(docDate, due),
        ...(del.NumAtCard ? { NumAtCard: del.NumAtCard } : {}),
        Comments: [`Based on Delivery #${del.DocNum}`, b.comments].filter(Boolean).join(' · ').slice(0, 254),
        DocumentLines: lines.map(l => ({ BaseType: 15, BaseEntry: entry, BaseLine: l.lineNum })),
        ...(freight.length ? { DocumentAdditionalExpenses: freight.map(f => ({
          ExpenseCode: f.code, LineTotal: f.amount,
          ...(f.taxCode ? { TaxCode: f.taxCode } : {}), ...(f.vatGroup ? { VatGroup: f.vatGroup } : {}),
          ...(f.remarks ? { Remarks: f.remarks } : {}) })) } : {}),
      };
      const inv = await sap.post('/Invoices', payload);
      res.json({ ok: true, docEntry: inv.DocEntry, docNum: inv.DocNum, cardCode: del.CardCode, cardName: del.CardName,
        amounts: inv.DocTotal != null ? docAmounts(inv) : null, freightCopied: freight.length, dueDate: payload.DocDueDate });
    } catch (e) { res.json({ ok: false, error: e.message }); }
    finally { posting.delete(key); }
  });

  // ── Delivery from a Sales Order ──────────────────────────────────────────────
  router.post('/delivery', requireAuth, async (req, res) => {
    const b = req.body || {}, entry = parseInt(b.orderDocEntry, 10);
    if (!entry) return res.json({ ok: false, error: 'Select a sales order.' });
    const key = `dln:${entry}`;
    if (posting.has(key)) return res.json({ ok: false, error: 'This delivery is already being posted — please wait.' });
    posting.add(key);
    try {
      const sap = getActiveSap();
      const order = await sap.get(`/Orders(${entry})`);
      if (order.DocumentStatus === 'bost_Close' || order.Cancelled === 'tYES') throw new Error(`Sales Order #${order.DocNum} is closed or cancelled.`);
      if (b.cardCode && b.cardCode !== order.CardCode) throw new Error(`Sales Order #${order.DocNum} belongs to ${order.CardCode}, not ${b.cardCode}.`);
      const byLine = new Map((order.DocumentLines || []).map(l => [Number(l.LineNum), l]));
      const whsBins = new Map();
      const binEnabled = async w => {
        if (!whsBins.has(w)) whsBins.set(w, (await sap.get(`/Warehouses('${q(w)}')`, { $select: 'WarehouseCode,EnableBinLocations' })).EnableBinLocations === 'tYES');
        return whsBins.get(w);
      };

      const lines = [];
      for (const l of Array.isArray(b.lines) ? b.lines : []) {
        const base = byLine.get(Number(l.lineNum));
        const qty = num(l.qty);
        if (!base || !(qty > 0)) continue;
        const open = num(base.RemainingOpenQuantity ?? base.OpenQuantity);
        if (base.LineStatus === 'bost_Close' || open <= 0) throw new Error(`${base.ItemCode}: this order line is already fully delivered.`);
        if (qty > open + 1e-9) throw new Error(`${base.ItemCode}: ${qty} is more than the open quantity ${open}.`);
        const whs = String(l.warehouseCode || base.WarehouseCode || '');
        if (!whs) throw new Error(`${base.ItemCode}: select a warehouse.`);
        const it = await sap.get(`/Items('${q(base.ItemCode)}')`, { $select: 'ItemCode,InventoryItem,ManageBatchNumbers,ManageSerialNumbers' });
        const inventory = it.InventoryItem !== 'tNO';
        const invQty = qty * (num(base.UnitsOfMeasurment) || 1);
        const line = { BaseType: 17, BaseEntry: entry, BaseLine: Number(base.LineNum), Quantity: qty, WarehouseCode: whs };

        if (inventory && it.ManageSerialNumbers === 'tYES') {
          throw new Error(`${base.ItemCode} is serial-numbered — pick its serial numbers in Sales — O2C → Order → Delivery.`);
        }
        const inBins = inventory && await binEnabled(whs);
        const binAlloc = (binAbs, qty, snb) => ({ BinAbsEntry: Number(binAbs), Quantity: qty, AllowNegativeQuantity: 'tNO', SerialAndBatchNumbersBaseLine: snb, BaseLineNumber: lines.length });

        if (inventory && it.ManageBatchNumbers === 'tYES') {
          // batches FEFO (with their bins in a bin warehouse); the batch / bin picked in the form narrows the choice
          let rows = inBins ? (await listBinStock('batch', base.ItemCode, whs)).rows
                            : (await listBatchSerials('batch', base.ItemCode, whs)).map(r => ({ ...r, qty: Math.max(0, r.qty - r.committed) }));
          if (l.batch) rows = rows.filter(r => String(r.batch) === String(l.batch));
          if (inBins && Number(l.binAbs) > 0) rows = rows.filter(r => Number(r.binAbs) === Number(l.binAbs));
          let left = invQty; const picks = [];
          for (const r of rows) { if (left <= 1e-9) break; const take = Math.min(r.qty, left); if (take > 0) { picks.push({ ...r, take }); left -= take; } }
          if (left > 1e-6) throw new Error(`${base.ItemCode}: not enough batch stock in ${whs}${l.batch ? ` (batch ${l.batch})` : ''}${inBins && l.binAbs ? ' in the selected bin' : ''} — short by ${+left.toFixed(4)}.`);
          const batches = [];
          for (const p of picks) { const ex = batches.find(x => x.BatchNumber === String(p.batch)); if (ex) ex.Quantity += p.take; else batches.push({ BatchNumber: String(p.batch), Quantity: p.take }); }
          line.BatchNumbers = batches;
          if (inBins) line.DocumentLinesBinAllocations = picks.map(p => binAlloc(p.binAbs, p.take, batches.findIndex(x => x.BatchNumber === String(p.batch))));
        } else if (inBins) {
          let rows = (await listBinStock('bin', base.ItemCode, whs)).rows;
          if (Number(l.binAbs) > 0) {
            rows = rows.filter(r => Number(r.binAbs) === Number(l.binAbs));
            const have = rows.reduce((s, r) => s + r.qty, 0);
            if (have + 1e-9 < invQty) throw new Error(`${base.ItemCode}: the selected bin has ${have} in stock, ${invQty} needed.`);
          } else rows = [...rows].sort((a, c) => (c.isDefault - a.isDefault) || (c.qty - a.qty));
          let left = invQty; const picks = [];
          for (const r of rows) { if (left <= 1e-9) break; const take = Math.min(r.qty, left); if (take > 0) { picks.push({ binAbs: r.binAbs, take }); left -= take; } }
          if (left > 1e-6) throw new Error(`${base.ItemCode}: not enough stock in the bins of ${whs} — short by ${+left.toFixed(4)}.`);
          line.DocumentLinesBinAllocations = picks.map(p => binAlloc(p.binAbs, p.take, -1));
        }
        lines.push(line);
      }
      if (!lines.length) throw new Error('Enter a quantity for at least one line.');

      const payload = {
        CardCode: order.CardCode, DocDate: day(b.docDate),
        ...(order.NumAtCard ? { NumAtCard: order.NumAtCard } : {}),
        Comments: [`Based on Sales Order #${order.DocNum}`, b.carrier ? `Carrier ${b.carrier}` : '', b.tracking ? `Tracking ${b.tracking}` : ''].filter(Boolean).join(' · ').slice(0, 254),
        DocumentLines: lines,
      };
      const dln = await sap.post('/DeliveryNotes', payload);
      res.json({ ok: true, docEntry: dln.DocEntry, docNum: dln.DocNum, cardCode: order.CardCode, cardName: order.CardName, orderNum: order.DocNum,
        lines: lines.length, total: dln.DocTotal != null ? fmt(dln.DocTotal) : null, currency: dln.DocCurrency || '' });
    } catch (e) { res.json({ ok: false, error: e.message }); }
    finally { posting.delete(key); }
  });

  // ── Incoming payment ─────────────────────────────────────────────────────────
  // Open A/R invoices of a customer, with the balance still due (DocNum shown, DocEntry kept for posting)
  router.get('/open-invoices', requireAuth, async (req, res) => {
    try {
      const cardCode = String(req.query.cardCode || '').trim();
      if (!cardCode) return res.json({ ok: false, error: 'Select a customer first.' });
      const d = await getActiveSap().get('/Invoices', {
        $filter: `CardCode eq '${q(cardCode)}' and DocumentStatus eq 'bost_Open' and Cancelled eq 'tNO'`,
        $select: 'DocEntry,DocNum,DocDate,DocDueDate,DocTotal,PaidToDate,DocTotalFc,DocCurrency,NumAtCard', $orderby: 'DocDueDate asc,DocNum asc', $top: 500,
      });
      res.json({ ok: true, invoices: (d.value || []).map(x => ({ docEntry: x.DocEntry, docNum: x.DocNum, docDate: String(x.DocDate || '').slice(0, 10),
        dueDate: String(x.DocDueDate || '').slice(0, 10), total: num(x.DocTotal), balance: Math.max(0, +(num(x.DocTotal) - num(x.PaidToDate)).toFixed(2)),
        currency: x.DocCurrency || '', foreign: num(x.DocTotalFc) !== 0, ref: x.NumAtCard || '' })).filter(x => x.balance > 0) });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // Postable G/L accounts for the payment account (cash / bank) — synced cache, live SAP as fallback.
  // Bank / cash accounts first.
  router.get('/gl-accounts', requireAuth, async (req, res) => {
    try {
      const s = String(req.query.q || '').trim(), like = `%${s}%`;
      const company = connRepo.getActive()?.company || 'default';
      let rows = db.prepare(`SELECT AcctCode, FormatCode, AcctName FROM cache_gl_accounts
        WHERE company_id=? AND Postable='tYES' AND Frozen<>'tYES' AND (AcctCode LIKE ? OR FormatCode LIKE ? OR AcctName LIKE ?)
        ORDER BY CASE WHEN AcctName LIKE '%bank%' OR AcctName LIKE '%cash%' OR AcctName LIKE '%petty%' THEN 0 ELSE 1 END, FormatCode, AcctCode LIMIT 200`)
        .all(company, like, like, like);
      if (!rows.length && !s) {
        const d = await getActiveSap().get('/ChartOfAccounts', { $filter: "ActiveAccount eq 'tYES' and FrozenFor eq 'tNO'", $select: 'Code,Name,FormatCode', $top: 200 });
        rows = (d.value || []).map(a => ({ AcctCode: a.Code, FormatCode: a.FormatCode, AcctName: a.Name }));
      }
      res.json(rows.map(a => ({ AcctCode: a.AcctCode, Account: a.FormatCode || a.AcctCode, AcctName: a.AcctName })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/incoming-payment', requireAuth, async (req, res) => {
    const b = req.body || {}, cardCode = String(b.cardCode || '').trim();
    if (!cardCode) return res.json({ ok: false, error: 'Select a customer.' });
    const key = `pay:${cardCode}`;
    if (posting.has(key)) return res.json({ ok: false, error: 'A payment for this customer is already being posted — please wait.' });
    posting.add(key);
    try {
      const sap = getActiveSap();
      const picks = (Array.isArray(b.invoices) ? b.invoices : []).filter(i => num(i.amount) > 0);
      if (!picks.length) throw new Error('Tick at least one invoice and enter the amount received.');
      const applied = [];
      for (const p of picks) {
        const inv = await sap.get(`/Invoices(${parseInt(p.docEntry, 10)})`, { $select: 'DocEntry,DocNum,CardCode,DocumentStatus,Cancelled,DocTotal,PaidToDate,DocTotalFc' });
        if (inv.CardCode !== cardCode) throw new Error(`Invoice #${inv.DocNum} belongs to ${inv.CardCode}, not ${cardCode}.`);
        if (inv.DocumentStatus === 'bost_Close' || inv.Cancelled === 'tYES') throw new Error(`Invoice #${inv.DocNum} is already paid / closed.`);
        if (num(inv.DocTotalFc) !== 0) throw new Error(`Invoice #${inv.DocNum} is in a foreign currency — receive it in Sales — O2C → Incoming Payment.`);
        const balance = +(num(inv.DocTotal) - num(inv.PaidToDate)).toFixed(2), amount = +num(p.amount).toFixed(2);
        if (amount > balance + 0.005) throw new Error(`Invoice #${inv.DocNum}: ${fmt(amount)} is more than the balance due ${fmt(balance)}.`);
        applied.push({ DocEntry: inv.DocEntry, InvoiceType: 'it_Invoice', SumApplied: amount, docNum: inv.DocNum });
      }
      const total = +applied.reduce((s, a) => s + a.SumApplied, 0).toFixed(2);
      const docDate = day(b.docDate);
      const payload = {
        CardCode: cardCode, DocDate: docDate,
        ...(b.reference ? { CounterReference: String(b.reference).slice(0, 27) } : {}),
        Remarks: String(b.remarks || `Payment for invoice(s) ${applied.map(a => '#' + a.docNum).join(', ')}`).slice(0, 254),
        PaymentInvoices: applied.map(({ docNum, ...a }) => a),
      };
      const means = String(b.means || '');
      const account = String(b.account || '').trim();
      if (means === 'transfer') {
        if (!account) throw new Error('Choose the bank G/L account the transfer was received into.');
        Object.assign(payload, { TransferAccount: account, TransferSum: total, TransferDate: day(b.transferDate || docDate), TransferReference: String(b.reference || '').slice(0, 27) });
      } else if (means === 'cash') {
        Object.assign(payload, { CashSum: total, ...(account ? { CashAccount: account } : {}) });
      } else if (means === 'check') {
        const c = b.check || {};
        if (!String(c.number || '').trim()) throw new Error('Enter the cheque number.');
        if (account) payload.CheckAccount = account;
        payload.PaymentChecks = [{ CheckSum: total, CheckNumber: String(c.number).trim(), ...(c.bank ? { BankCode: String(c.bank) } : {}),
          ...(c.branch ? { Branch: String(c.branch) } : {}), DueDate: day(c.dueDate || docDate), Trnsfrable: 'tNO' }];
      } else throw new Error('Choose how the customer paid: bank transfer, cash or cheque.');
      const pay = await sap.post('/IncomingPayments', payload);
      res.json({ ok: true, docEntry: pay.DocEntry, docNum: pay.DocNum, total, invoices: applied.map(a => ({ docNum: a.docNum, amount: a.SumApplied })) });
    } catch (e) { res.json({ ok: false, error: e.message }); }
    finally { posting.delete(key); }
  });

  return router;
}
