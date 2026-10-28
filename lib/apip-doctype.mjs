/**
 * apip-doctype.mjs — decide whether a supplier invoice is an Item (goods) or a Service (expense) invoice.
 *
 * Each signal votes item (+) or service (−) with a weight; the sign of the sum is the type and
 * confidence (50–100 %) grows with both the agreement |sum| / total weight and the amount of evidence.
 *   vendor "always expense" setup ........ decides alone (service, 100 %)
 *   vendor history (posted / user-set) ... 3
 *   AI classification (invoice + lines) .. 2
 *   HSN vs SAC codes (India: SAC = 99xxxx) 2
 *   lines matched to SAP items ........... 2   (only once item matching has run)
 *   service wording in the descriptions .. 1.5
 *   goods units of measure (NOS, KG …) ... 1
 * No signal at all → the configured default type, confidence 0.
 */

const SERVICE_WORDS = /\b(services?|charges?|fees?|freight|courier|cartage|transport(ation)?|logistics|rent(al)?|hire|lease|consult(ing|ancy|ant)?|professional|retainer|commission|brokerage|maintenance|amc|repairs?|servicing|installation|commissioning|labou?r|manpower|job\s*work|testing|calibration|inspection|training|subscription|licen[cs]e|hosting|cloud|software|internet|broadband|telephone|mobile|electricity|power|water|insurance|advertis(ing|ement)|marketing|printing|security|housekeeping|cleaning|catering|travel|tour|hotel|lodging|legal|audit|accounting|interest|bank|penalty)\b/i;
const GOODS_UOMS = new Set(['nos', 'no', 'pcs', 'pc', 'piece', 'pieces', 'kg', 'kgs', 'g', 'gm', 'gms', 'mt', 'ton', 'tons', 'tonne', 'ltr', 'ltrs', 'l', 'ml',
  'mtr', 'mtrs', 'm', 'meter', 'metre', 'mm', 'cm', 'ft', 'sqft', 'sqm', 'box', 'boxes', 'set', 'sets', 'pkt', 'pkts', 'pack', 'packet', 'bag', 'bags',
  'roll', 'rolls', 'drum', 'drums', 'can', 'bottle', 'bottles', 'pair', 'pairs', 'dozen', 'doz', 'unit', 'units', 'ea', 'each', 'sheet', 'sheets', 'coil', 'bundle']);

const ITEMS = 'dDocument_Items', SERVICE = 'dDocument_Service';
const isSac = c => /^99\d{2,6}$/.test(String(c || '').replace(/\D/g, ''));
const isHsn = c => { const d = String(c || '').replace(/\D/g, ''); return d.length >= 4 && d.length <= 8 && !isSac(d); };
const pct = n => Math.round(n * 100);

/**
 * @param ext       normalised OCR result (invoiceType, invoiceTypeReason, lines[{description, hsn, uom, lineType}])
 * @param opts.expenseVendor   vendor is set up as "always expense invoice"
 * @param opts.history         [DocType, …] of this vendor's earlier user-confirmed invoices (newest first)
 * @param opts.lines           mapped lines (ItemCode, matchScore, mappedBy) — pass after item matching
 * @param opts.defaultType     settings.defaultDocType
 * @returns { type, confidence (0–1), reasons: [string], source: 'auto' }
 */
export function classifyDocType(ext = {}, { expenseVendor = false, history = [], lines = null, defaultType = ITEMS } = {}) {
  if (expenseVendor) return { type: SERVICE, confidence: 1, reasons: ['Vendor is set up as an expense vendor'], source: 'auto' };
  let score = 0, weight = 0;
  const reasons = [];
  const vote = (w, dir, why) => { if (!w || !dir) return; score += w * dir; weight += Math.abs(w); reasons.push({ w: Math.abs(w), dir, why }); };
  const xl = Array.isArray(ext.lines) ? ext.lines : [];

  // vendor history — what this vendor's invoices were posted / set as before
  const hist = (history || []).filter(t => t === ITEMS || t === SERVICE).slice(0, 20);
  if (hist.length >= 2) {
    const svc = hist.filter(t => t === SERVICE).length, share = svc / hist.length;
    if (share >= 0.8) vote(3, -1, `${svc} of ${hist.length} earlier invoices from this vendor were Service`);
    else if (share <= 0.2) vote(3, 1, `${hist.length - svc} of ${hist.length} earlier invoices from this vendor were Item`);
  }

  // AI classification: invoice level + per-line labels
  const aiType = String(ext.invoiceType || '').toLowerCase();
  const aiLines = xl.map(l => String(l.lineType || '').toLowerCase()).filter(t => t === 'goods' || t === 'service');
  if (aiType === 'service' || aiType === 'item' || aiType === 'goods' || aiLines.length) {
    let dir = aiType === 'service' ? -1 : aiType ? 1 : 0;
    if (aiLines.length) { const s = aiLines.filter(t => t === 'service').length / aiLines.length; dir = dir ? (dir + (1 - 2 * s)) / 2 : 1 - 2 * s; }
    vote(2 * Math.abs(dir), Math.sign(dir), `AI read the bill as ${dir < 0 ? 'service' : 'goods'}${ext.invoiceTypeReason ? ` (${String(ext.invoiceTypeReason).slice(0, 80)})` : ''}`);
  }

  // HSN (goods) vs SAC (services) codes
  const coded = xl.filter(l => isSac(l.hsn) || isHsn(l.hsn));
  if (coded.length) {
    const sac = coded.filter(l => isSac(l.hsn)).length, dir = 1 - 2 * sac / coded.length;
    vote(2 * Math.abs(dir), Math.sign(dir), sac ? `${sac} of ${coded.length} line(s) carry a SAC (service) code` : `${coded.length} line(s) carry an HSN (goods) code`);
  }

  // lines matched to SAP items (vendor mapping / exact code / strong name match)
  if (Array.isArray(lines) && lines.length) {
    const strong = lines.filter(l => l.ItemCode && (l.mappedBy === 'vendor-item' || Number(l.matchScore) >= 0.85)).length;
    if (strong) vote(2 * strong / lines.length, 1, `${strong} of ${lines.length} line(s) matched an SAP item`);
  }

  // service wording / goods units
  if (xl.length) {
    const words = xl.filter(l => SERVICE_WORDS.test(l.description || '')).length;
    if (words) vote(1.5 * words / xl.length, -1, `${words} of ${xl.length} line(s) read like a service (charges, fees, rent …)`);
    const units = xl.filter(l => GOODS_UOMS.has(String(l.uom || '').toLowerCase().replace(/[^a-z]/g, ''))).length;
    if (units) vote(units / xl.length, 1, `${units} of ${xl.length} line(s) have a goods unit (NOS, KG …)`);
  }

  if (!weight || !score) return { type: defaultType === SERVICE ? SERVICE : ITEMS, confidence: 0, reasons: ['No clear signal — default type used'], source: 'default' };
  return {
    type: score < 0 ? SERVICE : ITEMS,
    // agreement between signals × amount of evidence (one weak clue alone stays below ~70 %)
    confidence: Math.round((0.5 + 0.5 * (Math.abs(score) / weight) * Math.min(1, weight / 4)) * 100) / 100,
    // signals that agree with the result first, then the ones that disagreed
    reasons: reasons.sort((a, b) => (b.dir === Math.sign(score)) - (a.dir === Math.sign(score)) || b.w - a.w)
      .map(r => (r.dir === Math.sign(score) ? r.why : `but ${r.why}`)),
    source: 'auto',
  };
}

export const docTypeLabel = (t, c) => `${t === SERVICE ? 'Service' : 'Item'}${c ? ` (${pct(c)}%)` : ''}`;
