/**
 * Item price lookup for the Sales Quotation / Sales Order agents.
 *
 *  1. SAP's own pricing for the customer (CompanyService_GetItemPrice): the
 *     customer's price list, special prices and period/volume discounts.
 *  2. If SAP returns 0 (e.g. the customer sits on a price list with no prices),
 *     fall back to a base price list: SALES_FALLBACK_PRICE_LIST if set, else the
 *     first active price list that is its own base, other than the customer's.
 */

function odataStr(s) { return String(s).replace(/'/g, "''"); }

const _fallbackCache = new Map(); // baseUrl|company → { at, lists }
const FALLBACK_CACHE_MS = 10 * 60 * 1000;

async function getPriceLists(sap) {
  const key = sap.baseUrl + '|' + (sap._connCredentials?.company || '');
  const hit = _fallbackCache.get(key);
  if (hit && Date.now() - hit.at < FALLBACK_CACHE_MS) return hit.lists;
  const r = await sap.get('/PriceLists', { $select: 'PriceListNo,PriceListName,BasePriceList,Factor,Active', $orderby: 'PriceListNo' });
  const lists = Array.isArray(r.value) ? r.value : [];
  _fallbackCache.set(key, { at: Date.now(), lists });
  return lists;
}

export async function getItemPrice(sap, { cardCode, itemCode, qty = 1, date }) {
  const day = date || new Date().toISOString().slice(0, 10);
  let sapPrice = 0, currency = '';
  try {
    const r = await sap.post('/CompanyService_GetItemPrice', {
      ItemPriceParams: { CardCode: cardCode, ItemCode: itemCode, UoMQuantity: Number(qty) || 1, Date: day },
    });
    sapPrice = Number(r?.Price || 0);
    currency = r?.Currency || '';
  } catch (e) {
    console.error('[ItemPrice] GetItemPrice failed:', e.message);
  }
  if (sapPrice > 0) return { price: sapPrice, currency, source: 'customer' };

  // Fallback — item's price on a base price list
  const [bp, item, lists] = await Promise.all([
    sap.get(`/BusinessPartners('${odataStr(cardCode)}')`, { $select: 'PriceListNum' }).catch(() => ({})),
    sap.get(`/Items('${odataStr(itemCode)}')`, { $select: 'ItemPrices' }),
    getPriceLists(sap).catch(() => []),
  ]);
  const envList = Number(process.env.SALES_FALLBACK_PRICE_LIST) || null;
  const base = envList
    ? lists.find(l => l.PriceListNo === envList)
    : lists.find(l => l.Active !== 'tNO' && l.BasePriceList === l.PriceListNo && l.PriceListNo !== bp.PriceListNum);
  if (!base) return { price: 0, currency: '', source: 'none' };
  const p = (item.ItemPrices || []).find(x => x.PriceList === base.PriceListNo);
  if (!p || !Number(p.Price)) return { price: 0, currency: '', source: 'none' };
  return { price: Number(p.Price), currency: p.Currency || '', source: 'fallback', priceList: base.PriceListName };
}

// Express handler factory: GET ?sessionId=&itemCode=&qty= — the customer comes
// from the agent's own chat session, so the client never has to pass it.
export function itemPriceRoute(getActiveSap, getSessionCustomer) {
  return async (req, res) => {
    try {
      const cardCode = getSessionCustomer(String(req.query.sessionId || ''));
      const itemCode = String(req.query.itemCode || '').trim();
      if (!cardCode || !itemCode) return res.json({ ok: false, error: 'customer and item required' });
      const r = await getItemPrice(getActiveSap(), { cardCode, itemCode, qty: req.query.qty });
      res.json({ ok: true, ...r });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  };
}
