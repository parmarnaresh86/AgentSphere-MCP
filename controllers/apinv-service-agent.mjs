/**
 * A/P Invoice (Service) Agent — SAP service-type A/P Invoice (DocType dDocument_Service)
 *  Step-by-step: vendor (all suppliers) → invoice form → post.
 *  The form follows the SAP service document: optional open service PO (its lines are copied with
 *  BaseType 22, like "Copy From → Purchase Order"), G/L account lines (account, account name,
 *  description, amount, tax code, free text), vendor ref no., posting / document / due date and
 *  footer remarks. Vendor picker and card styling come from lib/copy-doc-flow.mjs; the form's
 *  controls are the sv* helpers in public/index.html.
 */
import { Router } from 'express';
import {
  card, errorCard, customerPickerHtml, selectedCustomerBanner, allPartiesWithCounts, searchCustomers,
  openDocsForCustomer, clearPartyCache, getTaxCodes, fetchAllPages, getCompanyId, escHtml, fmtN, odataStr, sapDate, today,
} from '../lib/copy-doc-flow.mjs';

const CFG = {
  tag: 'APSV', prefix: 'apsv', apiBase: '/api/apinv-service',
  theme:  { color: '#0a6ed1', bg: '#f5f9fd', light: '#eef6fc' },   // SAP S/4HANA Fiori blue, same as the copy-from agents
  party:  { label: 'Vendor', plural: 'vendors', cardType: 'cSupplier' },
  source: { entity: '/PurchaseOrders', filter: "DocType eq 'dDocument_Service'", baseType: 22, label: 'service PO', plural: 'service POs' },
  steps:  ['Vendor', 'Invoice Details', 'Posted'],
};
const WELCOME = '<div style="font-size:13.5px;font-weight:600;margin-bottom:6px">🧾 Welcome to the <strong>A/P Service Invoice Agent</strong>!</div>';
const DESC_MAX = 100, FREE_MAX = 100, REMARKS_MAX = 254;   // OPCH/PCH1 column sizes

// ── Master data ────────────────────────────────────────────────────────────────

// Postable G/L accounts (title accounts and accounts frozen for all transactions are left out).
const _acctCache = new Map(); // company → { at, list: [{ code, fmt, name }] }
async function postableAccounts(sap) {
  const key = getCompanyId(), hit = _acctCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.list;
  const rows = await fetchAllPages(sap, '/ChartOfAccounts', {
    $filter: "ActiveAccount eq 'tYES' and FrozenFor eq 'tNO'", $select: 'Code,Name,FormatCode', $orderby: 'FormatCode',
  }, 20000);
  const list = rows.map(a => ({ code: a.Code, fmt: a.FormatCode || a.Code, name: a.Name || '' }));
  _acctCache.set(key, { at: Date.now(), list });
  return list;
}

async function loadServicePO(sap, docEntry) {
  const d = await sap.get(`/PurchaseOrders(${parseInt(docEntry, 10)})`).catch(() => null);
  if (!d || d.DocType !== 'dDocument_Service' || d.DocumentStatus !== 'bost_Open' || d.Cancelled === 'tYES') return null;
  return {
    docEntry: d.DocEntry, docNum: d.DocNum, cardCode: d.CardCode, cardName: d.CardName || d.CardCode,
    numAtCard: d.NumAtCard || '',
    lines: (d.DocumentLines || [])
      .filter(l => l.LineStatus !== 'bost_Close' && Number(l.OpenAmount ?? l.LineTotal) > 0)
      .map(l => ({
        base: l.LineNum, acct: l.AccountCode, desc: l.ItemDescription || '', free: l.FreeText || '',
        amount: Number(l.OpenAmount ?? l.LineTotal), open: Number(l.OpenAmount ?? l.LineTotal), tax: l.TaxCode || '',
      })),
  };
}

// ── Cards ──────────────────────────────────────────────────────────────────────

async function vendorStep(sap, note) {
  let vendors = [];
  try { vendors = await allPartiesWithCounts(CFG, sap); } catch (e) { console.error('[APSV] vendor list:', e.message); }
  return customerPickerHtml(CFG, vendors, note || (vendors.length
    ? 'Showing all vendors — those with open service POs show the count.'
    : '⚠️ Could not load the vendor list. Type a vendor name below to search.'));
}

function formHtml(session, master, hdr = {}) {
  const v = session.vendor, po = session.po;
  const formId = ++session.formSeq;
  session.formId = formId;
  const acctBy = new Map(master.accounts.map(a => [a.code, a]));
  const listId = `apsv-accts-${formId}-${Math.random().toString(36).slice(2, 7)}`;
  const inp = 'border:1.5px solid #d1d5db;border-radius:5px;padding:5px 7px;font-size:12.5px;box-sizing:border-box';
  const hdrInp = `width:100%;${inp};padding:6px 8px;font-size:13px`;
  const field = (label, html) => `<div><div style="font-size:11px;color:#6b7280;margin-bottom:3px">${label}</div>${html}</div>`;
  const rate = code => Number(master.taxCodes.find(t => t.Code === code)?.Rate || 0);
  const taxOpts = sel => `<option value="" data-rate="0">— None —</option>` + master.taxCodes.map(t =>
    `<option value="${escHtml(t.Code)}" data-rate="${Number(t.Rate || 0)}"${t.Code === sel ? ' selected' : ''}>${escHtml(t.Code)}${t.Rate ? ` (${Number(t.Rate)}%)` : ''}</option>`).join('');

  const row = l => {
    const a = acctBy.get(l.acct);
    const tax = l.amount * rate(l.tax) / 100;
    const based = l.base != null;
    return `<tr data-sv-line${based ? ` data-base="${l.base}" data-open="${l.open}"` : ''}${l.acct ? ` data-acct="${escHtml(l.acct)}"` : ''} style="border-bottom:1px solid #f3f4f6;background:${based ? '#fff' : '#fffdf5'}">
      <td style="padding:6px 8px;text-align:center"><button type="button" onclick="svRemove(this)" title="Remove line" style="background:none;border:1px solid #fca5a5;color:#b91c1c;border-radius:4px;width:22px;height:22px;cursor:pointer;line-height:1">✕</button></td>
      <td style="padding:6px 8px">${based
        ? `<div style="font-weight:600;white-space:nowrap">${escHtml(a?.fmt || l.acct)}</div><div style="font-size:10.5px;color:${CFG.theme.color}">🔗 PO line ${l.base + 1}</div>`
        : `<input type="text" data-f="acct" list="${listId}" value="${a ? escHtml(`${a.fmt} — ${a.name}`) : ''}" placeholder="🔍 G/L account code / name…" oninput="svAcct(this)" autocomplete="off" style="${inp};width:200px">`}</td>
      <td data-f="acctname" style="padding:6px 8px;font-size:12px;color:#374151;max-width:180px">${escHtml(a?.name || '')}</td>
      <td style="padding:6px 8px"><input type="text" data-f="desc" value="${escHtml(l.desc || a?.name || '')}" maxlength="${DESC_MAX}" placeholder="Description" style="${inp};width:180px"></td>
      <td style="padding:6px 8px"><input type="number" data-f="amount" value="${l.amount || ''}" min="0" step="any"${based ? ` max="${l.open}"` : ''} oninput="svCalc(this)" placeholder="0.00" style="${inp};width:105px;text-align:right">${based ? `<div style="font-size:10.5px;color:#6b7280;text-align:right">open ${fmtN(l.open)}</div>` : ''}</td>
      <td style="padding:6px 8px"><select data-f="tax" onchange="svCalc(this)" style="${inp};width:110px;background:#fff">${taxOpts(l.tax)}</select></td>
      <td data-f="taxamt" style="padding:6px 8px;text-align:right;white-space:nowrap;color:#6b7280">${fmtN(tax)}</td>
      <td data-f="total" style="padding:6px 8px;text-align:right;white-space:nowrap;font-weight:700;color:${CFG.theme.color}">${fmtN(l.amount + tax)}</td>
      <td style="padding:6px 8px"><input type="text" data-f="free" value="${escHtml(l.free || '')}" maxlength="${FREE_MAX}" placeholder="Line remarks" style="${inp};width:160px"></td>
    </tr>`;
  };

  const lines = po ? po.lines : [{ amount: 0, tax: hdr.lastTax || '' }];
  const sub = lines.reduce((s, l) => s + Number(l.amount || 0), 0);
  const taxT = lines.reduce((s, l) => s + Number(l.amount || 0) * rate(l.tax) / 100, 0);
  const poOpts = `<option value="">— None (enter lines manually) —</option>` + master.openPOs.map(d =>
    `<option value="${Number(d.DocEntry)}"${po && po.docEntry === d.DocEntry ? ' selected' : ''}>PO #${d.DocNum} · ${escHtml((d.DocDate || '').slice(0, 10))} · ${fmtN(d.DocTotal)}${d.NumAtCard ? ` · ${escHtml(d.NumAtCard)}` : ''}</option>`).join('');
  const dflt = (k, d) => escHtml(hdr[k] != null ? hdr[k] : d);

  const body = `${selectedCustomerBanner(CFG, { cardCode: v.cardCode, cardName: v.cardName })}
    <div data-sv-form data-prefix="${CFG.prefix}" data-form="${formId}" data-po="${po ? po.docEntry : ''}"
      data-accts="${escHtml(JSON.stringify(master.accounts.map(a => [a.code, a.fmt, a.name])))}">
      <datalist id="${listId}">${master.accounts.map(a => `<option value="${escHtml(`${a.fmt} — ${a.name}`)}"></option>`).join('')}</datalist>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:12px">
        ${field(`PO Number${master.openPOs.length ? ` (${master.openPOs.length} open)` : ''}`, `<select data-h="po" onchange="svPickPO(this)" style="${hdrInp};background:#fff"${master.openPOs.length ? '' : ' disabled title="No open service POs for this vendor"'}>${poOpts}</select>`)}
        ${field('Vendor Ref No. (supplier invoice no.)', `<input type="text" data-h="numAtCard" value="${dflt('numAtCard', '')}" maxlength="100" placeholder="e.g. INV-1042" style="${hdrInp}">`)}
        ${field('Posting Date *', `<input type="date" data-h="docDate" value="${dflt('docDate', today())}" style="${hdrInp}">`)}
        ${field('Document Date *', `<input type="date" data-h="taxDate" value="${dflt('taxDate', today())}" style="${hdrInp}">`)}
        ${field('Due Date (blank = payment terms)', `<input type="date" data-h="dueDate" value="${dflt('dueDate', '')}" style="${hdrInp}">`)}
      </div>
      <div style="overflow-x:auto;border:1px solid #e5e7eb;border-radius:6px;margin-bottom:8px">
        <table style="width:100%;border-collapse:collapse;font-size:12.5px;min-width:1100px">
          <thead><tr style="background:${CFG.theme.light};color:${CFG.theme.color};font-size:10.5px;text-transform:uppercase;letter-spacing:.04em">
            <th style="padding:6px 8px"></th><th style="padding:6px 8px;text-align:left">G/L Account ✏️</th><th style="padding:6px 8px;text-align:left">Account Name</th>
            <th style="padding:6px 8px;text-align:left">Description ✏️</th><th style="padding:6px 8px;text-align:right">Amount ✏️</th>
            <th style="padding:6px 8px;text-align:left">Tax Code ✏️</th><th style="padding:6px 8px;text-align:right">Tax</th>
            <th style="padding:6px 8px;text-align:right">Total</th><th style="padding:6px 8px;text-align:left">Free Text ✏️</th>
          </tr></thead>
          <tbody>${lines.map(row).join('')}</tbody>
        </table>
      </div>
      <template data-sv-tpl>${row({ amount: 0, tax: lines[0]?.tax || '' })}</template>
      <div style="margin-bottom:12px"><button type="button" onclick="svAddLine(this)" style="background:#fff;border:1.5px dashed ${CFG.theme.color};color:${CFG.theme.color};border-radius:6px;padding:6px 14px;font-size:12.5px;font-weight:600;cursor:pointer">+ Add Line</button>
        ${po ? `<span style="font-size:11.5px;color:#6b7280;margin-left:8px">🔗 Lines from PO #${po.docNum} stay linked (reduce the amount to invoice part of a line). Added lines post on their own G/L account.</span>` : ''}</div>
      <div style="display:grid;grid-template-columns:minmax(220px,1fr) 260px;gap:14px;align-items:start;margin-bottom:12px">
        ${field('Remarks', `<textarea data-h="comments" rows="3" maxlength="${REMARKS_MAX}" style="${hdrInp};resize:vertical;font-family:inherit">${dflt('comments', po ? `Based on Purchase Order #${po.docNum}` : '')}</textarea>`)}
        <div style="background:#fff;border:1px solid #e5e7eb;border-radius:6px;padding:10px 12px;font-size:12.5px">
          <div style="display:flex;justify-content:space-between;margin-bottom:4px"><span style="color:#6b7280">Total Before Tax</span><span data-f="sub">${fmtN(sub)}</span></div>
          <div style="display:flex;justify-content:space-between;margin-bottom:6px"><span style="color:#6b7280">Tax</span><span data-f="taxsum">${fmtN(taxT)}</span></div>
          <div style="display:flex;justify-content:space-between;border-top:1px solid #e5e7eb;padding-top:6px;font-weight:800;font-size:14.5px;color:${CFG.theme.color}"><span>Total</span><span data-f="grand">${fmtN(sub + taxT)}</span></div>
        </div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
        <button data-sv-post onclick="svPost(this)" style="background:${CFG.theme.color};color:#fff;border:none;border-radius:6px;padding:9px 22px;font-size:13.5px;font-weight:700;cursor:pointer">✅ Post A/P Invoice</button>
        <button onclick="cfAct('${CFG.prefix}','change_customer')" style="background:#f3f4f6;color:#374151;border:1px solid #d1d5db;border-radius:6px;padding:9px 14px;font-size:13px;cursor:pointer">← Change Vendor</button>
      </div>
    </div>`;
  return card(CFG, 2, `Step 2 — A/P Invoice (Service)${po ? ` · based on PO #${po.docNum}` : ''}`, body);
}

function successHtml(session, result, lines, accounts) {
  const acctBy = new Map(accounts.map(a => [a.code, a]));
  const printUrl = `${CFG.apiBase}/print/${result.DocEntry}`;
  const info = [
    ['A/P Invoice No.', `<strong style="color:${CFG.theme.color};font-size:14px">#${result.DocNum}</strong>`],
    ['Doc Entry', String(result.DocEntry)],
    ['Vendor', `${escHtml(session.vendor.cardName)} (${escHtml(session.vendor.cardCode)})`],
    ...(session.po ? [['Based on', `Purchase Order #${session.po.docNum}`]] : []),
    ['Document Total', fmtN(result.DocTotal)],
  ].map(([k, v], i) => `<tr${i % 2 ? ' style="background:#f9fafb"' : ''}><td style="padding:6px 12px;color:#6b7280;width:38%">${k}</td><td style="padding:6px 12px">${v}</td></tr>`).join('');
  const trs = lines.map((l, i) => `<tr style="border-bottom:1px solid #f3f4f6">
      <td style="padding:5px 10px">${i + 1}</td>
      <td style="padding:5px 10px;font-weight:600">${escHtml(acctBy.get(l.acct)?.fmt || l.acct || '')}</td>
      <td style="padding:5px 10px">${escHtml(l.desc)}</td>
      <td style="padding:5px 10px">${escHtml(l.tax || '')}</td>
      <td style="padding:5px 10px;text-align:right">${fmtN(l.amount)}</td>
    </tr>`).join('');
  return `<div style="background:#f0fdf4;border:1.5px solid #10b981;border-radius:8px;padding:14px;margin:6px 0">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px">
      <div style="font-size:14.5px;font-weight:700;color:#065f46">✅ A/P Service Invoice Created Successfully</div>
      <a href="${printUrl}" target="_blank" style="background:${CFG.theme.color};color:#fff;border-radius:6px;padding:7px 16px;font-size:12.5px;font-weight:600;text-decoration:none;white-space:nowrap">🖨️ Print</a>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:12.5px;margin-bottom:10px"><tbody>${info}</tbody></table>
    <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px;min-width:440px">
      <thead><tr style="background:#dcfce7;color:#065f46;font-size:10.5px;text-transform:uppercase">
        <th style="padding:5px 10px;text-align:left">#</th><th style="padding:5px 10px;text-align:left">G/L Account</th>
        <th style="padding:5px 10px;text-align:left">Description</th><th style="padding:5px 10px;text-align:left">Tax</th><th style="padding:5px 10px;text-align:right">Amount</th>
      </tr></thead><tbody>${trs}</tbody></table></div>
  </div>`;
}

// ── Print layout ───────────────────────────────────────────────────────────────

function renderServicePrint(doc, accounts) {
  const company   = process.env.SAP_B1_COMPANY || process.env.SL_COMPANY || 'Company';
  const acctBy    = new Map(accounts.map(a => [a.code, a]));
  const lines     = doc.DocumentLines || [];
  const d10       = s => (s ? String(s).slice(0, 10) : '—');
  const money     = n => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const printedOn = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const linesHtml = lines.map((l, i) => `<tr>
      <td>${i + 1}</td><td><strong>${escHtml(acctBy.get(l.AccountCode)?.fmt || l.AccountCode || '')}</strong><div style="font-size:9.5px;color:#666">${escHtml(acctBy.get(l.AccountCode)?.name || '')}</div></td>
      <td>${escHtml(l.ItemDescription || '')}${l.FreeText ? `<div style="font-size:9.5px;color:#666;margin-top:2px">${escHtml(l.FreeText)}</div>` : ''}</td>
      <td>${escHtml(l.TaxCode || '')}</td><td style="text-align:right">${money(l.LineTotal)}</td>
    </tr>`).join('');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>A/P Service Invoice #${escHtml(String(doc.DocNum))}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:Arial,sans-serif;font-size:11px;color:#222;padding:28px 36px;max-width:980px;margin:auto}
  .print-btn{margin-bottom:16px;display:flex;gap:8px;justify-content:flex-end}
  .print-btn button{padding:8px 18px;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600}
  .btn-print{background:#0a6ed1;color:#fff}.btn-close{background:#eee;color:#333}
  .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;padding-bottom:16px;border-bottom:3px solid #0a6ed1}
  .co-name{font-size:20px;font-weight:700;color:#1a1d27}.doc-title{font-size:18px;font-weight:700;color:#0a6ed1;text-align:right}
  .info-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:20px}
  .info-box{border:1px solid #ddd;border-radius:6px;padding:12px}
  .info-label{font-size:9px;font-weight:700;text-transform:uppercase;color:#888;letter-spacing:.06em;margin-bottom:6px}
  .info-val{font-size:12px;color:#222;margin-bottom:2px}
  table{width:100%;border-collapse:collapse;margin-bottom:16px}thead tr{background:#0a6ed1}
  th{padding:8px 10px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:#fff}
  td{padding:7px 10px;border-bottom:1px solid #eee;font-size:11px;vertical-align:top}tr:nth-child(even) td{background:#f5f9fd}
  .totals{text-align:right;padding:8px 0 20px}.total-row{font-size:12px;color:#374151;margin-bottom:4px}
  .total-grand{font-size:15px;font-weight:700;color:#0a6ed1;margin-top:6px}
  .sig-section{display:grid;grid-template-columns:1fr 1fr 1fr;gap:32px;margin-top:48px}
  .sig-line{border-top:1px solid #333;margin-top:40px;padding-top:6px;font-size:9px;color:#888;text-transform:uppercase;letter-spacing:.04em;text-align:center}
  .footer{text-align:center;margin-top:24px;font-size:9px;color:#aaa;border-top:1px solid #eee;padding-top:12px}
  @media print{.print-btn{display:none}}
</style></head><body>
<div class="print-btn"><button class="btn-close" onclick="window.close()">&#x2715; Close</button><button class="btn-print" onclick="window.print()">&#x1F5A8; Print</button></div>
<div class="header">
  <div><div class="co-name">${escHtml(company)}</div><div style="color:#888;font-size:11px;margin-top:2px">SAP Business One &mdash; A/P Invoice (Service)</div></div>
  <div><div class="doc-title">A/P Invoice</div><div style="font-size:13px;color:#444;text-align:right">AP # ${escHtml(String(doc.DocNum))}</div></div>
</div>
<div class="info-grid">
  <div class="info-box"><div class="info-label">Vendor</div><div class="info-val"><strong>${escHtml(doc.CardName || '—')}</strong></div><div class="info-val" style="color:#666">${escHtml(doc.CardCode || '')}</div></div>
  <div class="info-box"><div class="info-label">Posting / Document / Due Date</div><div class="info-val"><strong>${escHtml(d10(doc.DocDate))}</strong></div><div class="info-val" style="color:#666">Doc: ${escHtml(d10(doc.TaxDate))} &nbsp;·&nbsp; Due: ${escHtml(d10(doc.DocDueDate))}</div></div>
  <div class="info-box"><div class="info-label">Vendor Ref No.</div><div class="info-val"><strong>${escHtml(doc.NumAtCard || '—')}</strong></div></div>
</div>
<table><thead><tr><th>#</th><th>G/L Account</th><th>Description</th><th>Tax</th><th style="text-align:right">Amount</th></tr></thead><tbody>${linesHtml}</tbody></table>
<div class="totals">
  <div class="total-row">Total Before Tax: ${money(Number(doc.DocTotal || 0) - Number(doc.VatSum || 0))}</div>
  <div class="total-row">Tax: ${money(doc.VatSum)}</div>
  <div class="total-grand">Total: ${money(doc.DocTotal)}</div>
</div>
${doc.Comments ? `<div style="border:1px solid #ddd;border-radius:6px;padding:12px;margin-bottom:20px;background:#f5f9fd;font-size:11px;line-height:1.6"><strong>Remarks:</strong> ${escHtml(doc.Comments)}</div>` : ''}
<div class="sig-section"><div><div class="sig-line">Prepared By</div></div><div><div class="sig-line">Approved By</div></div><div><div class="sig-line">Finance Manager</div></div></div>
<div class="footer">Printed on ${escHtml(printedOn)} &nbsp;|&nbsp; ${escHtml(company)} &mdash; SAP B1 A/P Invoice #${escHtml(String(doc.DocNum))} &nbsp;|&nbsp; Powered by Henny AI Solution</div>
</body></html>`;
}

// ── Chat handler ───────────────────────────────────────────────────────────────

const PO_NUM_RE = /^(?:PO\s*)?#?\s*(\d+)$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function initSession() { return { step: 'INIT', vendor: null, po: null, formSeq: 0, formId: 0, posting: false }; }

export function createAPInvServiceAgentRouter(deps) {
  const { requireAuth, printAuth, getActiveSap } = deps;
  const router = Router();
  const sessions = new Map();

  async function showForm(session, sap, hdr) {
    const [accounts, taxCodes, openPOs] = await Promise.all([
      postableAccounts(sap),
      getTaxCodes(sap),
      openDocsForCustomer(CFG, sap, session.vendor.cardCode).catch(e => { console.error('[APSV] open POs:', e.message); return []; }),
    ]);
    session.step = 'REVIEW_LINES';
    return formHtml(session, { accounts, taxCodes, openPOs }, hdr);
  }

  async function post(session, sap, a) {
    if (session.step !== 'REVIEW_LINES' || !session.vendor) return errorCard('Nothing to post', 'This form is no longer active. Select the vendor again.');
    if (Number(a.formId) !== session.formId) return errorCard('Outdated form', 'Use the most recent invoice form in this chat.');
    if (session.posting) return errorCard('Already posting', 'Please wait for the current post to finish.');
    if (!DATE_RE.test(a.docDate || '') || !DATE_RE.test(a.taxDate || '')) return errorCard('Dates required', 'Set the Posting Date and Document Date.');
    if (a.dueDate && !DATE_RE.test(a.dueDate)) return errorCard('Invalid due date', 'Pick a valid Due Date or leave it blank.');

    const [accounts, taxCodes] = await Promise.all([postableAccounts(sap), getTaxCodes(sap)]);
    const acctBy = new Map(accounts.map(x => [x.code, x]));
    const taxOk  = code => !code || !taxCodes.length || taxCodes.some(t => t.Code === code);
    const poLine = new Map((session.po?.lines || []).map(l => [l.base, l]));
    const lines = [];
    for (const l of a.lines || []) {
      const amount = Math.round(Number(l.amount) * 100) / 100;
      const based  = l.base != null && l.base !== '';
      const src    = based ? poLine.get(Number(l.base)) : null;
      if (based && !src) return errorCard('PO line not found', 'Reload the PO and try again.');
      const acct = based ? src.acct : String(l.acct || '');
      const label = acctBy.get(acct)?.fmt || acct || 'Line';
      if (!(amount > 0)) return errorCard('Amount missing', `${escHtml(label)}: enter an amount above zero, or remove the line.`);
      if (!based && !acctBy.has(acct)) return errorCard('G/L account missing', 'Pick a postable G/L account from the list on every line.');
      if (based && amount > src.open + 0.005) return errorCard('Amount too high', `${escHtml(label)}: ${fmtN(amount)} exceeds the open PO amount ${fmtN(src.open)}.`);
      if (!taxOk(l.tax)) return errorCard('Invalid tax code', `${escHtml(label)}: tax code ${escHtml(l.tax)} does not exist.`);
      const desc = String(l.desc || '').trim() || (based ? src.desc : acctBy.get(acct)?.name) || '';
      if (!desc) return errorCard('Description missing', `${escHtml(label)}: enter a description.`);
      lines.push({ base: based ? src.base : null, acct, amount, tax: l.tax || '', desc: desc.slice(0, DESC_MAX), free: String(l.free || '').trim().slice(0, FREE_MAX) });
    }
    if (!lines.length) return errorCard('No lines', 'Add at least one line with a G/L account and an amount.');

    const payload = {
      CardCode: session.vendor.cardCode,
      DocType:  'dDocument_Service',
      DocDate:  sapDate(a.docDate),
      TaxDate:  sapDate(a.taxDate),
      ...(a.dueDate   ? { DocDueDate: sapDate(a.dueDate) } : {}),
      ...(a.numAtCard ? { NumAtCard: String(a.numAtCard).slice(0, 100) } : {}),
      ...(a.comments  ? { Comments: String(a.comments).slice(0, REMARKS_MAX) } : {}),
      DocumentLines: lines.map(l => ({
        ...(l.base != null ? { BaseType: CFG.source.baseType, BaseEntry: Number(session.po.docEntry), BaseLine: l.base } : { AccountCode: l.acct }),
        ItemDescription: l.desc,
        LineTotal: l.amount,
        ...(l.tax  ? { TaxCode: l.tax } : {}),
        ...(l.free ? { FreeText: l.free } : {}),
      })),
    };

    session.posting = true;
    try {
      const result = await sap.post('/PurchaseInvoices', payload);
      session.step = 'DONE';
      clearPartyCache(CFG);
      return { reply: successHtml(session, result, lines, accounts), quickReplies: ['New A/P Service Invoice'],
        meta: { docEntry: result.DocEntry, docNum: result.DocNum, printUrl: `${CFG.apiBase}/print/${result.DocEntry}` } };
    } catch (e) {
      console.error('[APSV] post error:', e.message);
      return errorCard('Failed to post A/P Invoice', `SAP Error: ${escHtml(e.message)}<br><br>Fix the values in the form above and click Post again.`);
    } finally {
      session.posting = false;
    }
  }

  router.post('/chat', requireAuth, async (req, res) => {
    try {
      const { message = '', sessionId } = req.body || {};
      const sid = sessionId || `apsv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      if (!sessions.has(sid)) sessions.set(sid, initSession());
      const session = sessions.get(sid);
      const sap = getActiveSap();
      const msg = String(message).trim();

      let out = { reply: '', quickReplies: [], meta: {} };
      let action = null, m = null;
      if (msg.startsWith('{')) { try { action = JSON.parse(msg); } catch { /* treat as text */ } }

      if (action?.action === 'select_customer') {
        Object.assign(session, initSession(), { formSeq: session.formSeq });
        session.vendor = { cardCode: action.cardCode, cardName: action.cardName || action.cardCode };
        out.reply = await showForm(session, sap);
      } else if (action?.action === 'select_po' && session.vendor) {
        if (action.docEntry) {
          const po = await loadServicePO(sap, action.docEntry);
          if (!po || po.cardCode !== session.vendor.cardCode) out.reply = errorCard('Service PO not available', 'It may be closed, cancelled or belong to another vendor.');
          else if (!po.lines.length) out.reply = errorCard(`PO #${po.docNum} has nothing left to invoice`, 'Every line is already fully invoiced.');
          else { session.po = po; out.reply = await showForm(session, sap, { ...action.hdr, comments: undefined, numAtCard: action.hdr?.numAtCard || po.numAtCard }); }
        } else {
          session.po = null;
          out.reply = await showForm(session, sap, { ...action.hdr, comments: undefined });
        }
      } else if (action?.action === 'post_service') {
        const r = await post(session, sap, action);
        out = typeof r === 'string' ? { ...out, reply: r } : { ...out, ...r };
      } else if (action || !msg || /^(start over|restart|reset|cancel|new\b.*)$/i.test(msg) || session.step === 'DONE') {
        // change_customer, restart, or any text after posting → back to the vendor list
        Object.assign(session, initSession(), { formSeq: session.formSeq });
        session.step = 'SELECT_CUSTOMER';
        out.reply = (msg ? '' : WELCOME) + await vendorStep(sap);
      } else if ((m = msg.match(PO_NUM_RE))) {
        // A service PO number → its vendor + the form with the PO lines
        const r = await sap.get('/PurchaseOrders', { $filter: `DocNum eq ${parseInt(m[1], 10)} and DocumentStatus eq 'bost_Open' and ${CFG.source.filter}`, $select: 'DocEntry', $top: 1 });
        const po = r.value?.[0] ? await loadServicePO(sap, r.value[0].DocEntry) : null;
        if (!po || !po.lines.length) out.reply = errorCard(`No open service PO #${escHtml(m[1])}`, 'Check the number, or pick a vendor from the list above.');
        else {
          Object.assign(session, initSession(), { formSeq: session.formSeq });
          session.vendor = { cardCode: po.cardCode, cardName: po.cardName };
          session.po = po;
          out.reply = await showForm(session, sap, { numAtCard: po.numAtCard });
        }
      } else {
        const found = await searchCustomers(CFG, sap, msg);
        if (found.length === 1) {
          Object.assign(session, initSession(), { formSeq: session.formSeq });
          session.vendor = found[0];
          out.reply = await showForm(session, sap);
        } else if (found.length) {
          session.step = 'SELECT_CUSTOMER';
          out.reply = customerPickerHtml(CFG, found, `${found.length} vendors match "<strong>${escHtml(msg)}</strong>":`);
        } else {
          out.reply = errorCard(`No vendor matches "${escHtml(msg)}"`, 'Try another name or code, or a service PO number.');
        }
      }

      res.json({ ok: true, sessionId: sid, step: session.step, ...out });
    } catch (e) {
      console.error('[APSV] chat error:', e);
      res.status(500).json({ ok: false, error: e.message, reply: errorCard('Something went wrong', escHtml(e.message)) });
    }
  });

  // Sessions are replaced on the next "Restart" — nothing to drop here.
  router.post('/reset', requireAuth, (req, res) => res.json({ ok: true }));

  router.get('/print/:docEntry', printAuth, async (req, res) => {
    try {
      const sap = getActiveSap();
      const [doc, accounts] = await Promise.all([
        sap.get(`/PurchaseInvoices(${parseInt(req.params.docEntry, 10)})`),
        postableAccounts(sap).catch(() => []),
      ]);
      res.setHeader('Content-Type', 'text/html');
      res.send(renderServicePrint(doc, accounts));
    } catch (e) {
      res.status(500).send(`<pre style="color:red">Error loading A/P Invoice #${escHtml(req.params.docEntry)}: ${escHtml(e.message)}</pre>`);
    }
  });

  return router;
}
