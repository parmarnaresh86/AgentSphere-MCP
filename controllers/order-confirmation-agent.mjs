/**
 * Order Confirmation Agents (Sales Orders and Purchase Orders)
 *  Lists open orders awaiting confirmation, shows a single order's full detail
 *  (header, lines, business-partner account position), and confirms one or
 *  many orders in SAP B1 by setting the document's native Confirmed flag
 *  (ORDR/OPOR.Confirmed — the "Approved" checkbox on the document).
 *
 *  Both agents share one router; DOC_TYPES holds what differs between them.
 *
 *  GET  /orders?status=pending|confirmed|all&search=&from=&to=
 *  GET  /orders/:docEntry
 *  POST /confirm   { docEntries: [1, 2, ...] }
 */
import { Router } from 'express';

const esc = s => String(s || '').replace(/'/g, "''");
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const MAX_LIST = 1000;
const MAX_CONFIRM = 200;

const DOC_TYPES = {
  sales:    { entity: '/Orders',         label: 'Sales Order',    tag: 'SO-CONFIRM', creditCheck: true },
  purchase: { entity: '/PurchaseOrders', label: 'Purchase Order', tag: 'PO-CONFIRM', creditCheck: false },
};

const LIST_FIELDS = [
  'DocEntry', 'DocNum', 'CardCode', 'CardName', 'DocDate', 'DocDueDate', 'NumAtCard',
  'DocTotal', 'DocTotalFc', 'DocCurrency', 'VatSum', 'Confirmed', 'SalesPersonCode', 'Comments',
].join(',');

// Service Layer caps each page (default 20) regardless of $top, so walk $skip until a short page.
async function fetchAllPaginated(sap, path, params, { pageSize = 100, maxItems = MAX_LIST } = {}) {
  let skip = 0;
  const all = [];
  while (true) {
    const r = await sap.get(path, { ...params, $top: pageSize, $skip: skip });
    const batch = r.value || [];
    all.push(...batch);
    const more = r['odata.nextLink'] || r['@odata.nextLink'] || batch.length === pageSize;
    if (!batch.length || !more || all.length >= maxItems) break;
    skip += batch.length;
  }
  return all.slice(0, maxItems);
}

// "SAP 400: {"error":{"message":{"value":"..."}}}" → just the readable message.
function sapErrorText(e) {
  const raw = String(e?.message || e).replace(/^SAP \d+:\s*/, '');
  try {
    const err = JSON.parse(raw).error;
    return err?.message?.value || err?.message || (typeof err === 'string' ? err : raw);
  } catch { return raw; }
}

// Foreign-currency orders carry their document-currency total in DocTotalFc.
function docAmount(d) {
  const fc = Number(d.DocTotalFc || 0);
  return fc > 0 ? fc : Number(d.DocTotal || 0);
}

function toListRow(d, salesPeople) {
  return {
    docEntry:  d.DocEntry,
    docNum:    d.DocNum,
    cardCode:  d.CardCode,
    cardName:  d.CardName,
    docDate:   d.DocDate ? String(d.DocDate).slice(0, 10) : null,
    dueDate:   d.DocDueDate ? String(d.DocDueDate).slice(0, 10) : null,
    customerRef: d.NumAtCard || '',
    total:     docAmount(d),
    totalLC:   Number(d.DocTotal || 0),
    currency:  d.DocCurrency || '',
    confirmed: d.Confirmed === 'tYES',
    salesPerson: salesPeople.get(d.SalesPersonCode) || '',
    comments:  d.Comments || '',
  };
}

function createDocConfirmationRouter(deps, type) {
  const { requireAuth, getActiveSap } = deps;
  const { entity, label, tag, creditCheck } = DOC_TYPES[type];
  const router = Router();

  // Sales-employee / buyer names are looked up once per request; the list is small.
  async function salesPeopleMap(sap) {
    try {
      const rows = await fetchAllPaginated(sap, '/SalesPersons', { $select: 'SalesEmployeeCode,SalesEmployeeName' }, { maxItems: 2000 });
      return new Map(rows.map(r => [r.SalesEmployeeCode, r.SalesEmployeeName]));
    } catch { return new Map(); }
  }

  // ── List open orders ──────────────────────────────────────────────────────
  router.get('/orders', requireAuth, async (req, res) => {
    const { status = 'pending', search = '', from = '', to = '' } = req.query;
    const filters = [`DocumentStatus eq 'bost_Open'`, `Cancelled eq 'tNO'`];
    if (status === 'pending')   filters.push(`Confirmed eq 'tNO'`);
    if (status === 'confirmed') filters.push(`Confirmed eq 'tYES'`);
    if (isDate(from)) filters.push(`DocDate ge '${from}'`);
    if (isDate(to))   filters.push(`DocDate le '${to}'`);
    const term = String(search).trim().slice(0, 60);
    if (term) {
      const t = esc(term);
      const parts = [`contains(CardName,'${t}')`, `contains(CardCode,'${t}')`, `contains(NumAtCard,'${t}')`];
      if (/^\d+$/.test(term)) parts.push(`DocNum eq ${parseInt(term, 10)}`);
      filters.push(`(${parts.join(' or ')})`);
    }
    try {
      const sap = getActiveSap();
      const [docs, salesPeople] = await Promise.all([
        fetchAllPaginated(sap, entity, { $filter: filters.join(' and '), $select: LIST_FIELDS, $orderby: 'DocDate desc,DocNum desc' }),
        salesPeopleMap(sap),
      ]);
      const orders = docs.map(d => toListRow(d, salesPeople));
      const pending = orders.filter(o => !o.confirmed);
      res.json({
        ok: true,
        orders,
        truncated: docs.length >= MAX_LIST,
        summary: {
          count: orders.length,
          pendingCount: pending.length,
          pendingValueLC: pending.reduce((s, o) => s + o.totalLC, 0),
          confirmedCount: orders.length - pending.length,
          customers: new Set(orders.map(o => o.cardCode)).size,
        },
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Single order detail ───────────────────────────────────────────────────
  router.get('/orders/:docEntry', requireAuth, async (req, res) => {
    const docEntry = parseInt(req.params.docEntry, 10);
    if (!docEntry) return res.status(400).json({ error: 'Invalid DocEntry' });
    try {
      const sap = getActiveSap();
      const d = await sap.get(`${entity}(${docEntry})`);
      const [bp, salesPeople] = await Promise.all([
        sap.get(`/BusinessPartners('${esc(d.CardCode)}')`, {
          $select: 'CardCode,CardName,CreditLimit,CurrentAccountBalance,OrdersBalance,OpenDeliveryNotesBalance,Phone1,EmailAddress',
        }).catch(() => null),
        salesPeopleMap(sap),
      ]);
      const lines = (d.DocumentLines || []).map(l => ({
        lineNum:   l.LineNum,
        itemCode:  l.ItemCode,
        description: l.ItemDescription,
        quantity:  Number(l.Quantity || 0),
        openQty:   Number(l.RemainingOpenQuantity ?? l.Quantity ?? 0),
        uom:       l.UoMCode || l.MeasureUnit || '',
        unitPrice: Number(l.UnitPrice || 0),
        discount:  Number(l.DiscountPercent || 0),
        taxCode:   l.TaxCode || l.VatGroup || '',
        lineTotal: Number(l.LineTotal || 0),
        warehouse: l.WarehouseCode || '',
        deliveryDate: l.ShipDate ? String(l.ShipDate).slice(0, 10) : null,
      }));
      let credit = null;
      if (bp) {
        const limit = creditCheck ? Number(bp.CreditLimit || 0) : 0;
        const exposure = Number(bp.CurrentAccountBalance || 0) + Number(bp.OrdersBalance || 0) + Number(bp.OpenDeliveryNotesBalance || 0);
        credit = {
          limit, exposure,
          balance: Number(bp.CurrentAccountBalance || 0),
          openOrders: Number(bp.OrdersBalance || 0),
          openDeliveries: Number(bp.OpenDeliveryNotesBalance || 0),
          // Credit limits only govern customers; suppliers just show their account position.
          status: !creditCheck ? 'none' : limit <= 0 ? 'nolimit' : exposure > limit ? 'exceeded' : exposure > limit * 0.8 ? 'warning' : 'ok',
          phone: bp.Phone1 || '', email: bp.EmailAddress || '',
        };
      }
      res.json({
        ok: true,
        order: {
          ...toListRow(d, salesPeople),
          open: d.DocumentStatus === 'bost_Open' && d.Cancelled !== 'tYES',
          taxTotal: Number(d.DocTotalFc > 0 ? d.VatSumFc || 0 : d.VatSum || 0),
          discountPercent: Number(d.DiscountPercent || 0),
          address: d.Address || '',
          shipTo: d.Address2 || '',
          lines,
        },
        credit,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Confirm one or many orders in SAP ─────────────────────────────────────
  router.post('/confirm', requireAuth, async (req, res) => {
    const ids = [...new Set((req.body?.docEntries || []).map(n => parseInt(n, 10)).filter(n => n > 0))];
    if (!ids.length) return res.status(400).json({ error: `Select at least one ${label.toLowerCase()}` });
    if (ids.length > MAX_CONFIRM) return res.status(400).json({ error: `Confirm at most ${MAX_CONFIRM} orders at a time` });

    const sap = getActiveSap();
    const who = req.user?.username || req.user?.email || req.user?.name || 'user';
    const results = [];
    // Sequential on purpose: one Service Layer session, and each PATCH can trip an approval procedure.
    for (const docEntry of ids) {
      let docNum = null;
      try {
        const d = await sap.get(`${entity}(${docEntry})`, { $select: 'DocEntry,DocNum,DocumentStatus,Cancelled,Confirmed,CardName' });
        docNum = d.DocNum;
        if (d.Cancelled === 'tYES' || d.DocumentStatus !== 'bost_Open') {
          results.push({ docEntry, docNum, cardName: d.CardName, ok: false, error: 'Order is closed or cancelled' });
          continue;
        }
        if (d.Confirmed === 'tYES') {
          results.push({ docEntry, docNum, cardName: d.CardName, ok: true, already: true });
          continue;
        }
        await sap.patch(`${entity}(${docEntry})`, { Confirmed: 'tYES' });
        results.push({ docEntry, docNum, cardName: d.CardName, ok: true });
      } catch (e) {
        results.push({ docEntry, docNum, ok: false, error: sapErrorText(e) });
      }
    }
    const confirmed = results.filter(r => r.ok && !r.already).length;
    const failed = results.filter(r => !r.ok).length;
    console.log(`[${tag}] user=${who} requested=${ids.length} confirmed=${confirmed} failed=${failed}`);
    res.json({ ok: failed === 0, confirmed, already: results.filter(r => r.already).length, failed, results });
  });

  return router;
}

export const createOrderConfirmationRouter = deps => createDocConfirmationRouter(deps, 'sales');
export const createPurchaseOrderConfirmationRouter = deps => createDocConfirmationRouter(deps, 'purchase');
