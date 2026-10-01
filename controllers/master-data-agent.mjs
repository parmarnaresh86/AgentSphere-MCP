/**
 * Menu Master Agent — Conversational wizard for SAP B1 master data creation
 * Agents: Item Master | Customer Master | Supplier Master | Bill of Material
 */
import { Router } from 'express';
import axios from 'axios';
import db from '../db.mjs';

// ── GSTIN Check (gstinapi.in) ──────────────────────────────────────────────────
const GSTIN_API_BASE = 'https://www.gstinapi.in';
const GSTIN_API_KEY = process.env.GSTIN_API_KEY || 'gak_b5c5a3c19a214e50874653b8f7254e30';
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

db.exec(`CREATE TABLE IF NOT EXISTS master_data_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_type TEXT NOT NULL,
  doc_code TEXT, doc_name TEXT, user_name TEXT,
  payload TEXT, sap_result TEXT, status TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// ── Shared utils ──────────────────────────────────────────────────────────────
const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const arr = r => Array.isArray(r) ? r : (r?.value ?? []);
function logEntry(type, code, name, payload, result, status, user) {
  try {
    db.prepare(`INSERT INTO master_data_log(agent_type,doc_code,doc_name,user_name,payload,sap_result,status)VALUES(?,?,?,?,?,?,?)`)
      .run(type, code||'', name||'', user||'', JSON.stringify(payload), JSON.stringify(result), status);
  } catch(_) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// ITEM MASTER
// ─────────────────────────────────────────────────────────────────────────────
const _itemSess = new Map();
function itemInit() {
  return {
    step:'ASK_NAME', sid:`itm_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
    itemName:null, itemCode:null,
    series:null, seriesList:[],
    groupCode:null, groupName:null, groupList:[],
    invItem:null, salesItem:null, purchItem:null,
    uomList:[], invUom:null, invUomCode:null, invUomName:null,
    salesUom:null, salesUomCode:null, salesUomName:null,
    purchUom:null, purchUomCode:null, purchUomName:null, uomStep:null,
    manage:null,
    warehouse:null, warehouseName:null, warehouseList:[],
  };
}

function itemSteps(step) {
  const all = ['ASK_NAME','ASK_CODE','ASK_SERIES','ASK_GROUP','ASK_TYPE','ASK_UOM','ASK_MANAGE','ASK_WAREHOUSE','CONFIRM','DONE'];
  const labels = ['Name','Code','Series','Group','Type','UOM','Tracking','Warehouse','Confirm','Done'];
  const idx = all.indexOf(step);
  return `<div style="display:flex;align-items:center;flex-wrap:wrap;gap:2px;font-size:11px;padding:6px 0 4px">
    ${all.map((s,i) => {
      const active = i===idx, done = i<idx;
      return `<span style="display:inline-flex;align-items:center;gap:3px;color:${active?'#fff':done?'#6ee7b7':'rgba(255,255,255,0.45)'}">
        <span style="width:15px;height:15px;border-radius:50%;background:${active?'rgba(255,255,255,0.3)':done?'#10b981':'rgba(255,255,255,0.15)'};display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700">${done?'✓':(i+1)}</span>
        ${labels[i]}${i<all.length-1?'<span style="color:rgba(255,255,255,0.3);margin-left:2px">›</span>':''}
      </span>`;
    }).join('')}
  </div>`;
}

// Item Master replies use the imf-* classes (SAP Fiori theme) defined in public/index.html
function seriesChips(list) {
  if (!list.length) return '<em class="imf-empty">No series available</em>';
  return `<div class="imf-chips">${list.map(s =>
    `<button class="imf-chip" onclick="masterSend('select_series:${s.Series}:${esc(s.Name)}')">${esc(s.Name)}</button>`
  ).join('')}</div>`;
}
function groupChips(list) {
  if (!list.length) return '<em class="imf-empty">No groups available</em>';
  return `<div class="imf-chips">${list.map(g =>
    `<button class="imf-chip" onclick="masterSend('select_group:${g.Number}:${esc(g.GroupName)}')">${esc(g.GroupName)}</button>`
  ).join('')}</div>`;
}
function uomChips(list, step) {
  if (!list.length) return '<em class="imf-empty">No UOMs available</em>';
  return `<div class="imf-chips">${list.map(u =>
    `<button class="imf-chip" onclick="masterSend('select_uom:${step}:${u.AbsEntry}:${esc(u.Code||u.Name)}:${esc(u.Name)}')"><strong>${esc(u.Code||u.Name)}</strong>${u.Code&&u.Name&&u.Code!==u.Name?' — '+esc(u.Name):''}</button>`
  ).join('')}</div>`;
}
function warehouseChips(list) {
  if (!list.length) return '<em class="imf-empty">No warehouses available</em>';
  return `<div class="imf-chips">${list.map(w =>
    `<button class="imf-chip" onclick="masterSend('select_wh:${esc(w.WarehouseCode)}:${esc(w.WarehouseName)}')">${esc(w.WarehouseCode)} — ${esc(w.WarehouseName)}</button>`
  ).join('')}</div>`;
}
function itemTypeForm() {
  return `<div class="imf-type-box">
    <label><input type="checkbox" id="im-inv" checked> Inventory Item</label>
    <label><input type="checkbox" id="im-sales" checked> Sales Item</label>
    <label><input type="checkbox" id="im-purch" checked> Purchase Item</label>
  </div>
  <button class="imf-primary" style="margin-top:10px" onclick="masterSubmitItemType()">Continue →</button>`;
}
function manageChips() {
  return `<div class="imf-chips">${[
    {v:'none',  l:'No Tracking'},
    {v:'batch', l:'Batch Numbers'},
    {v:'serial',l:'Serial Numbers'},
  ].map(o => `<button class="imf-chip" onclick="masterSend('select_manage:${o.v}')">${o.l}</button>`).join('')}</div>`;
}
function itemSummaryHtml(sess) {
  const field = (k, v, wide) => `<div class="imf-sum-field${wide?' imf-span2':''}"><span class="k">${k}</span><span class="v">${v}</span></div>`;
  const flags = [
    sess.invItem && 'Inventory Item',
    sess.salesItem && 'Sales Item',
    sess.purchItem && 'Purchase Item',
  ].filter(Boolean);
  const fields = [
    field('Item Name', esc(sess.itemName)),
    field('Item Code', sess.itemCode ? esc(sess.itemCode) : '<em>Auto-generate</em>'),
    field('Series', esc(sess.seriesList.find(s=>s.Series===sess.series)?.Name ?? sess.series)),
    field('Item Group', esc(sess.groupName)),
    `<div class="imf-sum-field imf-span2"><span class="k">Item Flags</span><div class="imf-flags">${flags.map(f=>`<span class="imf-flag">✓ ${f}</span>`).join('')}</div></div>`,
    ...(sess.invItem   ? [field('Inventory UOM', esc(sess.invUomCode||(sess.invUomName||'—')))] : []),
    ...(sess.salesItem ? [field('Sales UOM',     esc(sess.salesUomCode||(sess.salesUomName||'—')))] : []),
    ...(sess.purchItem ? [field('Purchase UOM',  esc(sess.purchUomCode||(sess.purchUomName||'—')))] : []),
    field('Tracking Method', sess.manage==='serial'?'Serial Numbers':sess.manage==='batch'?'Batch Numbers':'No Tracking'),
    field('Default Warehouse', `${esc(sess.warehouse)} — ${esc(sess.warehouseName)}`, true),
  ];
  return `<div class="imf-summary">
    <div class="imf-sum-hdr">
      <span class="imf-sum-title">📄 Item Master Summary</span>
      <span class="imf-badge">Ready for Creation</span>
    </div>
    <div class="imf-sum-grid">${fields.join('')}</div>
    <div class="imf-sum-actions">
      <button class="imf-link-btn" onclick="masterSend('restart')">Edit Details</button>
      <button class="imf-primary" onclick="masterSend('confirm_create')">✓ Create Master Record</button>
    </div>
  </div>`;
}

async function handleItemChat(sess, msg, sap, res, user) {
  const sid = sess.sid;
  const step = sess.step;

  if (msg === 'restart' || msg === 'Create Another Item' || msg === 'Start Over') {
    const fresh = itemInit(); fresh.sid = sid; _itemSess.set(sid, fresh);
    return res.json({ ok:true, reply:'<div>Let\'s start fresh. What is the <strong>Item Name</strong>?</div>', step:'ASK_NAME', sessionId:sid });
  }

  if (msg.startsWith('select_series:')) {
    const [,num,name] = msg.split(':');
    sess.series = Number(num);
    sess.step = 'ASK_GROUP';
    const gRes = await sap.get('/ItemGroups', { $select:'Number,GroupName', $orderby:'GroupName', $top:200 });
    sess.groupList = arr(gRes);
    return res.json({ ok:true, reply:`<div>Series <strong>${esc(name)}</strong> ✓</div><div style="margin-top:8px">Select the <strong>Item Group</strong>:</div><div style="margin-top:8px">${groupChips(sess.groupList)}</div>`, step:sess.step, sessionId:sid });
  }

  if (msg.startsWith('select_group:')) {
    const parts = msg.split(':'); sess.groupCode = Number(parts[1]); sess.groupName = parts.slice(2).join(':');
    sess.step = 'ASK_TYPE';
    return res.json({ ok:true, reply:`<div>Group <strong>${esc(sess.groupName)}</strong> ✓</div><div style="margin-top:10px">Which <strong>item types</strong> apply?</div>${itemTypeForm()}`, step:sess.step, sessionId:sid });
  }

  if (msg.startsWith('submit_item_type:')) {
    const [,i,s,p] = msg.split(':');
    sess.invItem = i==='true'; sess.salesItem = s==='true'; sess.purchItem = p==='true';
    if (!sess.invItem && !sess.salesItem && !sess.purchItem)
      return res.json({ ok:true, reply:'<div style="color:#b91c1c">⚠️ Select at least one item type.</div>', step:sess.step, sessionId:sid });
    const uRes = await sap.get('/UnitOfMeasurements', { $select:'AbsEntry,Code,Name', $orderby:'Name', $top:200 });
    sess.uomList = arr(uRes);
    sess.step = 'ASK_UOM';
    sess.uomStep = sess.invItem ? 'inv' : sess.salesItem ? 'sales' : 'purch';
    const lbl = {inv:'Inventory',sales:'Sales',purch:'Purchase'}[sess.uomStep];
    return res.json({ ok:true, reply:`<div>Types saved ✓</div><div style="margin-top:8px">Select <strong>${lbl} UOM</strong>:</div><div style="margin-top:8px">${uomChips(sess.uomList, sess.uomStep)}</div>`, step:sess.step, sessionId:sid });
  }

  if (msg.startsWith('select_uom:')) {
    // format: select_uom:step:AbsEntry:Code:Name
    const parts = msg.split(':');
    const which = parts[1]; const entry = Number(parts[2]); const code = parts[3]; const name = parts.slice(4).join(':') || code;
    if (which==='inv')   { sess.invUom=entry;  sess.invUomCode=code;  sess.invUomName=name;  }
    if (which==='sales') { sess.salesUom=entry; sess.salesUomCode=code; sess.salesUomName=name; }
    if (which==='purch') { sess.purchUom=entry; sess.purchUomCode=code; sess.purchUomName=name; }
    const display = code + (name && name!==code ? ` (${name})` : '');
    let next = null;
    if (which==='inv'   && sess.salesItem) next='sales';
    else if (which==='inv'   && sess.purchItem) next='purch';
    else if (which==='sales' && sess.purchItem) next='purch';
    if (next) {
      sess.uomStep = next;
      const lbl = {sales:'Sales',purch:'Purchase'}[next];
      return res.json({ ok:true, reply:`<div>${display} UOM ✓</div><div style="margin-top:8px">Select <strong>${lbl} UOM</strong>:</div><div style="margin-top:8px">${uomChips(sess.uomList, next)}</div>`, step:sess.step, sessionId:sid });
    }
    sess.step = 'ASK_MANAGE';
    return res.json({ ok:true, reply:`<div>${display} UOM ✓</div><div style="margin-top:10px">How should this item be <strong>tracked</strong>?</div><div style="margin-top:8px">${manageChips()}</div>`, step:sess.step, sessionId:sid });
  }

  if (msg.startsWith('select_manage:')) {
    const [,v] = msg.split(':'); sess.manage = v;
    sess.step = 'ASK_WAREHOUSE';
    const whRes = await sap.get('/Warehouses', { $select:'WarehouseCode,WarehouseName', $filter:"Inactive eq 'tNO'", $top:200 });
    sess.warehouseList = arr(whRes);
    const lbl = {none:'No Tracking',batch:'Batch Numbers',serial:'Serial Numbers'}[v]||v;
    return res.json({ ok:true, reply:`<div>Tracking: <strong>${lbl}</strong> ✓</div><div style="margin-top:8px">Select the <strong>Default Warehouse</strong>:</div><div style="margin-top:8px">${warehouseChips(sess.warehouseList)}</div>`, step:sess.step, sessionId:sid });
  }

  if (msg.startsWith('select_wh:')) {
    const parts = msg.split(':'); sess.warehouse = parts[1]; sess.warehouseName = parts.slice(2).join(':');
    sess.step = 'CONFIRM';
    return res.json({ ok:true, reply:`<div>Warehouse <strong>${esc(sess.warehouse)}</strong> ✓</div><div style="margin-top:10px">Please review and confirm:</div>${itemSummaryHtml(sess)}`, step:sess.step, sessionId:sid });
  }

  if (msg === 'confirm_create') {
    // UoM field names vary by SAP B1 version/config — discover via /api/master/item/debug-fields
    // and set UoMGroupEntry or individual entries after confirming the correct property names.
    const payload = {
      ItemName: sess.itemName,
      ...(sess.itemCode ? {ItemCode:sess.itemCode} : {}),
      Series: sess.series,
      ItemsGroupCode: sess.groupCode,
      InventoryItem: sess.invItem?'tYES':'tNO',
      SalesItem:     sess.salesItem?'tYES':'tNO',
      PurchaseItem:  sess.purchItem?'tYES':'tNO',
      ManageSerialNumbers: sess.manage==='serial'?'tYES':'tNO',
      ManageBatchNumbers:  sess.manage==='batch' ?'tYES':'tNO',
      DefaultWarehouse: sess.warehouse,
    };
    try {
      const result = await sap.post('/Items', payload);
      sess.step = 'DONE';
      logEntry('item', result.ItemCode||sess.itemCode||sess.itemName, sess.itemName, payload, result, 'success', user);
      return res.json({ ok:true, reply:`<div class="imf-success"><div class="imf-success-title">✓ Item Master Record Created Successfully!</div><div class="imf-success-text">Item <strong>${esc(result.ItemCode||'Auto-assigned')}</strong> (${esc(sess.itemName)}) has been created in SAP.</div></div>`, step:sess.step, sessionId:sid, quickReplies:['Create Another Item'] });
    } catch(e) {
      logEntry('item', sess.itemCode||'', sess.itemName, payload, {error:e.message}, 'error', user);
      return res.json({ ok:true, reply:`<div style="color:#b91c1c">❌ Failed: ${esc(e.message)}</div>`, step:sess.step, sessionId:sid, quickReplies:['Try Again','Start Over'] });
    }
  }

  // Step-based text input
  if (step==='ASK_NAME'||step==='INIT') {
    if (!msg.trim()) return res.json({ ok:true, reply:'<div>Please enter the <strong>Item Name</strong> to continue.</div>', step, sessionId:sid });
    sess.itemName = msg.trim(); sess.step = 'ASK_CODE';
    return res.json({ ok:true, reply:`<div>Item Name: <strong>${esc(sess.itemName)}</strong> ✓</div><div style="margin-top:8px">Enter the <strong>Item Code</strong>, or type <em>auto</em> to let SAP generate it:</div>`, step:sess.step, sessionId:sid });
  }
  if (step==='ASK_CODE') {
    const code = msg.trim(); sess.itemCode = (!code||code.toLowerCase()==='auto') ? null : code.toUpperCase();
    sess.step = 'ASK_SERIES';
    const serRes = await sap.post('/SeriesService_GetDocumentSeries', { DocumentTypeParams:{ Document:'4' } });
    sess.seriesList = arr(serRes);
    return res.json({ ok:true, reply:`<div>Code: <strong>${sess.itemCode||'Auto-generate'}</strong> ✓</div><div style="margin-top:8px">Select the <strong>Number Series</strong>:</div><div style="margin-top:8px">${seriesChips(sess.seriesList)}</div>`, step:sess.step, sessionId:sid });
  }
  return res.json({ ok:true, reply:'<div>Please follow the wizard steps above.</div>', step, sessionId:sid });
}

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOMER / SUPPLIER MASTER  (shared logic, different CardType)
// ─────────────────────────────────────────────────────────────────────────────
const _bpSess = { customer: new Map(), supplier: new Map() };
// ── Duplicate-name check against SAP BusinessPartners (case & whitespace insensitive) ──
const normBpName = s => String(s || '').trim().toLowerCase().replace(/\s+/g, '');
const CARD_TYPE_LABEL = { cCustomer:'Customer', cSupplier:'Supplier', cLid:'Lead' };
const BP_STOPWORDS = new Set(['and','the','of','pvt','ltd','private','limited','co','corp','inc','llp','llc','company','industries','industry','trading','traders','enterprise','enterprises']);
const nameTokens = s => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !BP_STOPWORDS.has(w));
const MATCH_RANK = { exact:0, similar:1, partial:2 };

async function checkDuplicateBP(sap, name) {
  const target = normBpName(name);
  if (!target) return { exists:false, matches:[], partialMatches:[] };
  const targetTokens = nameTokens(name);
  const searchTokens = (targetTokens.length ? targetTokens : [String(name).trim().split(/\s+/)[0]]).slice(0, 4);

  let candidates = [];
  try {
    const filter = searchTokens
      .map(w => `contains(tolower(CardName),'${w.toLowerCase().replace(/'/g, "''")}')`)
      .join(' or ');
    const r = await sap.get('/BusinessPartners', {
      $filter: filter,
      $select: 'CardCode,CardName,CardType,Phone1,EmailAddress,Valid',
      $top: 200,
    });
    candidates = arr(r);
  } catch(_) { candidates = []; }

  const seen = new Set();
  const all = candidates
    .map(c => {
      if (seen.has(c.CardCode)) return null;
      const cNorm = normBpName(c.CardName);
      const cTokens = nameTokens(c.CardName);
      let matchType = null;
      if (cNorm === target) matchType = 'exact';
      else if (cNorm.includes(target) || target.includes(cNorm)) matchType = 'similar';
      else if (targetTokens.some(t => cTokens.includes(t))) matchType = 'partial';
      if (!matchType) return null;
      seen.add(c.CardCode);
      return {
        CardCode: c.CardCode, CardName: c.CardName,
        CardType: CARD_TYPE_LABEL[c.CardType] || c.CardType,
        Phone1: c.Phone1 || '', EmailAddress: c.EmailAddress || '', Valid: c.Valid, matchType,
      };
    })
    .filter(Boolean)
    .sort((a, b) => MATCH_RANK[a.matchType] - MATCH_RANK[b.matchType]);

  const matches = all.filter(m => m.matchType !== 'partial');
  const partialMatches = all.filter(m => m.matchType === 'partial');
  return { exists: matches.some(m => m.matchType === 'exact'), matches, partialMatches };
}
function dupWarningHtml(dup) {
  const hasMatches = dup.matches.length > 0;
  const hasPartial = (dup.partialMatches || []).length > 0;
  if (!hasMatches && !hasPartial) return '<div style="margin-top:8px;font-size:12px;color:#059669">✅ No matching Business Partner found in SAP.</div>';
  let html = '';
  if (hasMatches) {
    const rows = dup.matches.slice(0, 6).map(m => `<div style="padding:4px 0;border-bottom:1px solid #fee2e2;font-size:12px">
      <strong>${esc(m.CardCode)}</strong> — ${esc(m.CardName)} <span style="color:#9ca3af">(${esc(m.CardType)})</span>
      ${m.matchType==='exact' ? '<span style="color:#dc2626;font-weight:700;margin-left:6px">EXACT MATCH</span>' : '<span style="color:#d97706;margin-left:6px">similar</span>'}
    </div>`).join('');
    html += `<div style="margin-top:8px;padding:10px 12px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px">
      <div style="font-size:12.5px;font-weight:700;color:#991b1b">⚠️ ${dup.matches.length} possible duplicate${dup.matches.length>1?'s':''} found in SAP (matched ignoring case &amp; spacing):</div>
      <div style="margin-top:6px">${rows}</div>
    </div>`;
  }
  if (hasPartial) {
    const prows = dup.partialMatches.slice(0, 6).map(m => `<div style="padding:4px 0;border-bottom:1px solid #fde68a;font-size:12px">
      <strong>${esc(m.CardCode)}</strong> — ${esc(m.CardName)} <span style="color:#9ca3af">(${esc(m.CardType)})</span>
      <span style="color:#b45309;margin-left:6px">partial match</span>
    </div>`).join('');
    html += `<div style="margin-top:8px;padding:10px 12px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px">
      <div style="font-size:12.5px;font-weight:700;color:#92400e">🔎 ${dup.partialMatches.length} name(s) share a word with this Business Partner:</div>
      <div style="margin-top:6px">${prows}</div>
    </div>`;
  }
  return html;
}

function bpInit(bpType) {
  return {
    step:'ASK_NAME', sid:`${bpType.slice(0,3)}_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
    bpType,
    cardName:null, cardCode:null,
    series:null, seriesList:[],
    groupCode:null, groupName:null, groupList:[],
    currency:null, currencyList:[],
    payTerms:null, payTermsName:null, termsList:[],
    phone:null, email:null,
    gstin:null,
    addresses:[],
  };
}
function bpSteps(step, bpType) {
  const all = ['ASK_NAME','ASK_CODE','ASK_SERIES','ASK_GROUP','ASK_CURRENCY','ASK_TERMS','ASK_PHONE','ASK_EMAIL','ASK_ADDRESS','CONFIRM','DONE'];
  const labels = ['Name','Code','Series','Group','Currency','Pay Terms','Phone','Email','Address','Confirm','Done'];
  const idx = all.indexOf(step);
  return `<div style="display:flex;align-items:center;flex-wrap:wrap;gap:2px;font-size:11px;padding:6px 0 4px">
    ${all.map((s,i)=>{
      const a=i===idx, d=i<idx;
      return `<span style="display:inline-flex;align-items:center;gap:3px;color:${a?'#fff':d?'#6ee7b7':'rgba(255,255,255,0.45)'}"><span style="width:15px;height:15px;border-radius:50%;background:${a?'rgba(255,255,255,0.3)':d?'#10b981':'rgba(255,255,255,0.15)'};display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700">${d?'✓':(i+1)}</span>${labels[i]}${i<all.length-1?'<span style="color:rgba(255,255,255,0.3);margin-left:2px">›</span>':''}</span>`;
    }).join('')}
  </div>`;
}

// Customer / Supplier replies use the imf-* classes (SAP Fiori theme) defined in public/index.html
function bpGroupChips(list) {
  if (!list.length) return '<em class="imf-empty">No groups</em>';
  return `<div class="imf-chips">${list.map(g => `<button class="imf-chip" onclick="masterSend('select_bp_group:${g.Code}:${esc(g.Name)}')">${esc(g.Name)}</button>`).join('')}</div>`;
}
function addressFormHtml(bpType, count) {
  const heading = count === 0 ? 'Add Bill To / Ship To Address' : 'Add Another Address';
  return `<div class="imf-form">
    <div class="imf-form-title">${heading}</div>
    <div class="imf-form-grid">
      <label>Address Name<input class="imf-field" id="addr-name-${bpType}" type="text" placeholder="e.g. Main Office, Warehouse"></label>
      <label>Type<select class="imf-select" id="addr-type-${bpType}"><option value="bo_BillTo">Bill To</option><option value="bo_ShipTo">Ship To</option></select></label>
      <label class="imf-span2">Street<input class="imf-field" id="addr-street-${bpType}" type="text" placeholder="Street / Road"></label>
      <label>City<input class="imf-field" id="addr-city-${bpType}" type="text" placeholder="City"></label>
      <label>State / Province<input class="imf-field" id="addr-state-${bpType}" type="text" placeholder="Optional"></label>
      <label>ZIP / Postal<input class="imf-field" id="addr-zip-${bpType}" type="text" placeholder="Postal code"></label>
      <label>Country Code<input class="imf-field" id="addr-country-${bpType}" type="text" placeholder="e.g. GB, US, IN" maxlength="3" style="text-transform:uppercase"></label>
    </div>
    <div class="imf-actions">
      <button class="imf-primary" onclick="masterSubmitAddress('${bpType}')">Save Address</button>
      <button class="imf-secondary" onclick="masterSend('done_addresses','${bpType}')">Done →</button>
      <button class="imf-link-btn" onclick="masterSend('done_addresses','${bpType}')">Skip</button>
    </div>
  </div>`;
}
function addressesTableHtml(addresses) {
  if (!addresses.length) return '<em class="imf-empty">No addresses added yet</em>';
  return `<div class="imf-table-wrap"><table class="imf-table">
    <tr><th>#</th><th>Name</th><th>Type</th><th>Street</th><th>City</th><th>Country</th><th></th></tr>
    ${addresses.map((a,i)=>`<tr>
      <td>${i+1}</td>
      <td><strong>${esc(a.AddressName)}</strong></td>
      <td><span class="imf-tag${a.AddressType==='bo_BillTo'?'':' ship'}">${a.AddressType==='bo_BillTo'?'Bill To':'Ship To'}</span></td>
      <td>${esc(a.Street)}</td>
      <td>${esc(a.City)}</td>
      <td>${esc(a.Country)}</td>
      <td><button class="imf-remove" title="Remove" onclick="masterSend('remove_address:${i}')">✕</button></td>
    </tr>`).join('')}
  </table></div>`;
}
function currencyChips(list) {
  if (!list.length) return '<em class="imf-empty">No currencies</em>';
  return `<div class="imf-chips">${list.map(c => `<button class="imf-chip" onclick="masterSend('select_currency:${esc(c.Code)}')"><strong>${esc(c.Code)}</strong> — ${esc(c.Name)}</button>`).join('')}</div>`;
}
function termsChips(list) {
  if (!list.length) return '<em class="imf-empty">No payment terms</em>';
  return `<div class="imf-chips">${list.map(t => `<button class="imf-chip" onclick="masterSend('select_terms:${t.GroupNumber}:${esc(t.PaymentTermsGroupName)}')">${esc(t.PaymentTermsGroupName)}</button>`).join('')}</div>`;
}
function bpSummaryHtml(sess) {
  const label = sess.bpType==='customer' ? 'Customer' : 'Supplier';
  const field = (k, v, wide) => `<div class="imf-sum-field${wide?' imf-span2':''}"><span class="k">${k}</span><span class="v">${v}</span></div>`;
  const fields = [
    field(`${label} Name`, esc(sess.cardName)),
    field('BP Code', sess.cardCode ? esc(sess.cardCode) : '<em>Auto-generate</em>'),
    field('Series', sess.series != null ? esc(sess.seriesList.find(s=>s.Series===sess.series)?.Name ?? String(sess.series)) : '<em>Default</em>'),
    field('BP Group', esc(sess.groupName)),
    field('Currency', esc(sess.currency||'—')),
    field('Payment Terms', esc(sess.payTermsName||'—')),
    field('Phone', esc(sess.phone||'—')),
    field('Email', esc(sess.email||'—')),
    ...(sess.gstin ? [field('GSTIN', esc(sess.gstin), true)] : []),
  ];
  return `<div class="imf-summary">
    <div class="imf-sum-hdr">
      <span class="imf-sum-title">📄 ${label} Master Summary</span>
      <span class="imf-badge">Ready for Creation</span>
    </div>
    <div class="imf-sum-grid">${fields.join('')}</div>
    <div class="imf-sum-sub">Addresses (${sess.addresses.length})</div>
    ${sess.addresses.length ? addressesTableHtml(sess.addresses) : '<div class="imf-hint">No addresses added.</div>'}
    <div class="imf-sum-actions">
      <button class="imf-link-btn" onclick="masterSend('restart')">Edit Details</button>
      <button class="imf-primary" onclick="masterSend('confirm_bp')">✓ Create ${label}</button>
    </div>
  </div>`;
}

async function handleBPChat(sess, msg, sap, res, user) {
  const sid = sess.sid; const step = sess.step; const bpType = sess.bpType;

  if (msg==='restart'||msg==='Create Another'||msg==='Start Over') {
    const fresh = bpInit(bpType); fresh.sid = sid; _bpSess[bpType].set(sid, fresh);
    return res.json({ ok:true, reply:`<div>Starting over. What is the <strong>${bpType==='customer'?'Customer':'Supplier'} Name</strong>?</div>`, step:'ASK_NAME', sessionId:sid });
  }

  if (msg.startsWith('select_bp_series:')) {
    const [,num,name] = msg.split(':');
    sess.series = (num==='skip'||!num) ? null : Number(num);
    sess.step = 'ASK_GROUP';
    let groupError = null;
    try {
      const gRes = await sap.get('/BusinessPartnerGroups', { $select:'Code,Name', $orderby:'Name', $top:200 });
      sess.groupList = arr(gRes);
    } catch(e) { sess.groupList = []; groupError = e.message; }
    const serLabel = sess.series != null ? esc(name) : 'Default';
    const groupContent = sess.groupList.length
      ? bpGroupChips(sess.groupList)
      : `<div style="font-size:12.5px;color:#b91c1c">⚠️ Could not load BP groups from SAP${groupError ? `: ${esc(groupError)}` : ' (none configured)'}.</div>`;
    return res.json({ ok:true, reply:`<div>Series: <strong>${serLabel}</strong> ✓</div><div style="margin-top:8px">Select the <strong>BP Group</strong>:</div><div style="margin-top:8px">${groupContent}</div>`, step:sess.step, sessionId:sid });
  }
  if (msg.startsWith('select_bp_group:')) {
    const parts = msg.split(':'); sess.groupCode = Number(parts[1]); sess.groupName = parts.slice(2).join(':');
    sess.step = 'ASK_CURRENCY';
    const cRes = await sap.get('/Currencies', { $select:'Code,Name', $orderby:'Code', $top:200 });
    sess.currencyList = arr(cRes);
    return res.json({ ok:true, reply:`<div>Group <strong>${esc(sess.groupName)}</strong> ✓</div><div style="margin-top:8px">Select the <strong>Currency</strong>:</div><div style="margin-top:8px">${currencyChips(sess.currencyList)}</div>`, step:sess.step, sessionId:sid });
  }
  if (msg.startsWith('select_currency:')) {
    const [,code] = msg.split(':'); sess.currency = code; sess.step = 'ASK_TERMS';
    const tRes = await sap.get('/PaymentTermsTypes', { $select:'GroupNumber,PaymentTermsGroupName', $orderby:'PaymentTermsGroupName', $top:200 });
    sess.termsList = arr(tRes);
    return res.json({ ok:true, reply:`<div>Currency: <strong>${esc(code)}</strong> ✓</div><div style="margin-top:8px">Select <strong>Payment Terms</strong>:</div><div style="margin-top:8px">${termsChips(sess.termsList)}</div>`, step:sess.step, sessionId:sid });
  }
  if (msg.startsWith('select_terms:')) {
    const parts = msg.split(':'); sess.payTerms = Number(parts[1]); sess.payTermsName = parts.slice(2).join(':');
    sess.step = 'ASK_PHONE';
    return res.json({ ok:true, reply:`<div>Payment Terms: <strong>${esc(sess.payTermsName)}</strong> ✓</div><div style="margin-top:8px">Enter <strong>Phone Number</strong> (or type <em>skip</em>):</div>`, step:sess.step, sessionId:sid });
  }
  if (msg.startsWith('submit_address:')) {
    const [addrName,addrType,street,city,state,zip,country] = msg.slice(15).split('|');
    sess.addresses.push({
      AddressName: addrName || `Address ${sess.addresses.length+1}`,
      AddressType: addrType || 'bo_BillTo',
      Street: street||'', City: city||'', State: state||'', ZipCode: zip||'', Country: country||'',
    });
    return res.json({ ok:true, reply:`<div>Address saved ✓</div><div style="margin-top:8px">${addressesTableHtml(sess.addresses)}</div><div style="margin-top:12px">Do you want to add another address?</div>`, step:sess.step, sessionId:sid, quickReplies:['Add Address','Continue →'] });
  }
  if (msg==='Add Address'||msg==='add_more_address') {
    return res.json({ ok:true, reply:`<div style="margin-bottom:8px">${addressesTableHtml(sess.addresses)}</div>${addressFormHtml(bpType, sess.addresses.length)}`, step:sess.step, sessionId:sid });
  }
  if (msg==='Continue →'||msg==='done_addresses') {
    sess.step = 'CONFIRM';
    return res.json({ ok:true, reply:`<div>Addresses confirmed ✓</div><div style="margin-top:10px">Review and confirm:</div>${bpSummaryHtml(sess)}`, step:sess.step, sessionId:sid });
  }
  if (msg.startsWith('remove_address:')) {
    const idx = Number(msg.split(':')[1]);
    if (idx>=0 && idx<sess.addresses.length) sess.addresses.splice(idx,1);
    return res.json({ ok:true, reply:`<div>Address removed.</div><div style="margin-top:8px">${addressesTableHtml(sess.addresses)}</div><div style="margin-top:12px">Add another address?</div>`, step:sess.step, sessionId:sid, quickReplies:['Add Address','Continue →'] });
  }
  if (msg==='confirm_bp') {
    const cardType = bpType==='customer' ? 'cCustomer' : 'cSupplier';
    if (sess.series == null && !sess.cardCode) {
      return res.json({ ok:true, reply:`<div style="color:#b91c1c">⚠️ No Number Series was selected and no manual Code was entered, so SAP cannot assign a ${bpType==='customer'?'Customer':'Supplier'} Code. Please go back and either pick a Series or type a specific BP Code.</div>`, step:sess.step, sessionId:sid, quickReplies:['Start Over'] });
    }
    const payload = {
      CardName: sess.cardName,
      ...(sess.cardCode ? {CardCode:sess.cardCode} : {}),
      CardType: cardType,
      ...(sess.series != null ? {Series: sess.series} : {}),
      GroupCode: sess.groupCode,
      ...(sess.currency ? {Currency:sess.currency} : {}),
      ...(sess.payTerms!=null ? {PayTermsGrpCode:sess.payTerms} : {}),
      ...(sess.phone ? {Phone1:sess.phone} : {}),
      ...(sess.email ? {EmailAddress:sess.email} : {}),
      ...(sess.gstin ? {FederalTaxID:sess.gstin} : {}),
      ...(sess.addresses.length ? {BPAddresses: sess.addresses.map((a,i)=>({...a, RowNum:i}))} : {}),
    };
    try {
      const result = await sap.post('/BusinessPartners', payload);
      sess.step = 'DONE';
      logEntry(bpType, result.CardCode||sess.cardCode||sess.cardName, sess.cardName, payload, result, 'success', user);
      return res.json({ ok:true, reply:`<div class="imf-success"><div class="imf-success-title">✓ ${bpType==='customer'?'Customer':'Supplier'} Master Record Created Successfully!</div><div class="imf-success-text"><strong>${esc(result.CardCode||'Auto-assigned')}</strong> (${esc(sess.cardName)}) has been created in SAP.</div></div>`, step:sess.step, sessionId:sid, quickReplies:['Create Another'] });
    } catch(e) {
      logEntry(bpType, sess.cardCode||'', sess.cardName, payload, {error:e.message}, 'error', user);
      return res.json({ ok:true, reply:`<div style="color:#b91c1c">❌ Failed: ${esc(e.message)}</div>`, step:sess.step, sessionId:sid, quickReplies:['Try Again','Start Over'] });
    }
  }

  // Text input steps
  if (step==='ASK_NAME'||step==='INIT') {
    if (!msg.trim()) return res.json({ ok:true, reply:'<div>Please enter the name.</div>', step, sessionId:sid });
    sess.cardName = msg.trim(); sess.step = 'ASK_CODE';
    const dup = await checkDuplicateBP(sap, sess.cardName);
    return res.json({ ok:true, reply:`<div>Name: <strong>${esc(sess.cardName)}</strong> ✓</div>${dupWarningHtml(dup)}<div style="margin-top:8px">Enter a <strong>BP Code</strong>, or type <em>auto</em> to let SAP assign one:</div>`, step:sess.step, sessionId:sid });
  }
  if (step==='ASK_CODE') {
    const code = msg.trim(); sess.cardCode = (!code||code.toLowerCase()==='auto') ? null : code.toUpperCase();
    sess.step = 'ASK_SERIES';
    sess.seriesError = null;
    try {
      const serRes = await sap.post('/SeriesService_GetDocumentSeries', { DocumentTypeParams:{ Document:'2' } });
      sess.seriesList = arr(serRes);
    } catch(e) { sess.seriesList = []; sess.seriesError = e.message; }
    let seriesContent;
    if (sess.seriesList.length) {
      seriesContent = seriesChips(sess.seriesList).replace(/select_series:/g,'select_bp_series:');
    } else if (sess.seriesError) {
      seriesContent = `<div class="imf-error" style="margin-bottom:8px">⚠️ Could not load series from SAP: ${esc(sess.seriesError)}</div>
        <div class="imf-chips"><button class="imf-chip" onclick="masterSend('select_bp_series:skip:Default')">Skip (use SAP default)</button></div>
        <div class="imf-hint" style="margin-top:10px">If SAP requires a series for this card type, enter a specific <strong>BP Code</strong> above instead of "auto" next time, or type a series number and press Enter.</div>`;
    } else {
      seriesContent = `<div class="imf-hint" style="margin:0 0 8px">No series configured in SAP.</div>
        <div class="imf-chips"><button class="imf-chip" onclick="masterSend('select_bp_series:skip:Default')">Skip (use SAP default)</button></div>
        <div class="imf-hint" style="margin-top:10px">Or type a series number and press Enter.</div>`;
    }
    return res.json({ ok:true, reply:`<div>Code: <strong>${sess.cardCode||'Auto-generate'}</strong> ✓</div><div style="margin-top:8px">Select the <strong>Number Series</strong>:</div><div style="margin-top:8px">${seriesContent}</div>`, step:sess.step, sessionId:sid });
  }
  if (step==='ASK_SERIES') {
    const input = msg.trim();
    sess.series = (!input || input.toLowerCase()==='skip') ? null : (isNaN(input) ? null : Number(input));
    sess.step = 'ASK_GROUP';
    let groupError = null;
    try {
      const gRes = await sap.get('/BusinessPartnerGroups', { $select:'Code,Name', $orderby:'Name', $top:200 });
      sess.groupList = arr(gRes);
    } catch(e) { sess.groupList = []; groupError = e.message; }
    const serLabel = sess.series != null ? String(sess.series) : 'Default';
    const groupContent = sess.groupList.length
      ? bpGroupChips(sess.groupList)
      : `<div style="font-size:12.5px;color:#b91c1c">⚠️ Could not load BP groups from SAP${groupError ? `: ${esc(groupError)}` : ' (none configured)'}.</div>`;
    return res.json({ ok:true, reply:`<div>Series: <strong>${esc(serLabel)}</strong> ✓</div><div style="margin-top:8px">Select the <strong>BP Group</strong>:</div><div style="margin-top:8px">${groupContent}</div>`, step:sess.step, sessionId:sid });
  }
  if (step==='ASK_PHONE') {
    sess.phone = (msg.toLowerCase()==='skip') ? null : msg.trim();
    sess.step = 'ASK_EMAIL';
    return res.json({ ok:true, reply:`<div>Phone: <strong>${sess.phone||'—'}</strong> ✓</div><div style="margin-top:8px">Enter <strong>Email Address</strong> (or type <em>skip</em>):</div>`, step:sess.step, sessionId:sid });
  }
  if (step==='ASK_EMAIL') {
    sess.email = (msg.toLowerCase()==='skip') ? null : msg.trim();
    sess.step = 'ASK_ADDRESS';
    const existing = sess.addresses.length ? `<div style="margin-bottom:8px">${addressesTableHtml(sess.addresses)}</div>` : '';
    return res.json({ ok:true, reply:`<div>Email: <strong>${sess.email||'—'}</strong> ✓</div><div style="margin-top:10px">Add a <strong>Bill To</strong> or <strong>Ship To</strong> address (optional):</div>${existing}${addressFormHtml(bpType, sess.addresses.length)}`, step:sess.step, sessionId:sid, quickReplies: sess.addresses.length ? ['Continue →'] : [] });
  }
  return res.json({ ok:true, reply:'<div>Please follow the wizard steps.</div>', step, sessionId:sid });
}

// ─────────────────────────────────────────────────────────────────────────────
// BILL OF MATERIAL
// ─────────────────────────────────────────────────────────────────────────────
const _bomSess = new Map();
function bomInit() {
  return {
    step:'ASK_PARENT', sid:`bom_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
    parentCode:null, parentName:null, parentResults:[],
    treeType:null, baseQty:1,
    components:[],                  // [{itemCode,itemName,quantity,warehouse,warehouseName}]
    pendingComp:null,               // {itemCode,itemName} being added
    compResults:[],
    warehouseList:[],
  };
}
function bomStepBar(step) {
  const all = ['ASK_PARENT','ASK_TREE_TYPE','ASK_BASE_QTY','ADDING_COMPONENTS','CONFIRM','DONE'];
  const labels = ['Parent Item','Tree Type','Base Qty','Components','Confirm','Done'];
  const idx = all.indexOf(step);
  return `<div style="display:flex;align-items:center;flex-wrap:wrap;gap:2px;font-size:11px;padding:6px 0 4px">
    ${all.map((s,i)=>{
      const a=i===idx,d=i<idx;
      return `<span style="display:inline-flex;align-items:center;gap:3px;color:${a?'#fff':d?'#6ee7b7':'rgba(255,255,255,0.45)'}"><span style="width:15px;height:15px;border-radius:50%;background:${a?'rgba(255,255,255,0.3)':d?'#10b981':'rgba(255,255,255,0.15)'};display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700">${d?'✓':(i+1)}</span>${labels[i]}${i<all.length-1?'<span style="color:rgba(255,255,255,0.3);margin-left:2px">›</span>':''}</span>`;
    }).join('')}
  </div>`;
}
// BOM replies use the imf-* classes (SAP Fiori theme) defined in public/index.html
const TREE_TYPE_LABELS = {iProductionTree:'Production (Assembly)', iSalesTree:'Sales Bundle', iTemplateTree:'Template', iDisassemblyTree:'Disassembly'};
function bomItemChips(list, prefix) {
  if (!list.length) return '<em class="imf-empty">No items found</em>';
  return `<div class="imf-chips">${list.map(i => `<button class="imf-chip" onclick="masterSend('${prefix}:${esc(i.ItemCode)}:${esc(i.ItemName)}')"><strong>${esc(i.ItemCode)}</strong> — ${esc(i.ItemName)}</button>`).join('')}</div>`;
}
function treeTypeChips() {
  return `<div class="imf-chips">${Object.entries(TREE_TYPE_LABELS)
    .map(([v,l]) => `<button class="imf-chip" onclick="masterSend('select_tree_type:${v}')">${l}</button>`).join('')}</div>`;
}
function bomComponentsTable(comps) {
  if (!comps.length) return '<em class="imf-empty">No components added yet</em>';
  return `<div class="imf-table-wrap"><table class="imf-table">
    <tr><th>#</th><th>Item Code</th><th>Item Name</th><th class="num">Qty</th><th>Warehouse</th><th></th></tr>
    ${comps.map((c,i) => `<tr><td>${i+1}</td><td><strong>${esc(c.itemCode)}</strong></td><td>${esc(c.itemName)}</td><td class="num">${c.quantity}</td><td>${esc(c.warehouse)}</td><td><button class="imf-remove" title="Remove" onclick="masterSend('remove_comp:${i}')">✕</button></td></tr>`).join('')}
  </table></div>`;
}
function bomSummaryHtml(sess) {
  const field = (k, v, wide) => `<div class="imf-sum-field${wide?' imf-span2':''}"><span class="k">${k}</span><span class="v">${v}</span></div>`;
  return `<div class="imf-summary">
    <div class="imf-sum-hdr">
      <span class="imf-sum-title">📄 Bill of Material Summary</span>
      <span class="imf-badge">Ready for Creation</span>
    </div>
    <div class="imf-sum-grid">
      ${field('Parent Item', `${esc(sess.parentCode)} — ${esc(sess.parentName)}`, true)}
      ${field('Tree Type', esc(TREE_TYPE_LABELS[sess.treeType] || sess.treeType))}
      ${field('Base Quantity', sess.baseQty)}
    </div>
    <div class="imf-sum-sub">Components (${sess.components.length})</div>
    ${bomComponentsTable(sess.components)}
    <div class="imf-sum-actions">
      <button class="imf-link-btn" onclick="masterSend('restart')">Start Over</button>
      <button class="imf-secondary" onclick="masterSend('add_more_comp')">+ Add More</button>
      <button class="imf-primary" onclick="masterSend('confirm_bom')">✓ Create BOM</button>
    </div>
  </div>`;
}

async function searchItems(sap, q) {
  const filter = isNaN(q) ? `contains(ItemName,'${q}')` : `ItemCode eq '${q}' or contains(ItemName,'${q}')`;
  const res = await sap.get('/Items', { $filter: filter, $select:'ItemCode,ItemName', $top:10 });
  return arr(res);
}
async function itemPickerHtml(sap, prefix, excludeExistingBom = false) {
  try {
    const res = await sap.get('/Items', {
      $filter: "InventoryItem eq 'tYES'",
      $select: 'ItemCode,ItemName',
      $orderby: 'ItemName',
      $top: 200,
    });
    let items = arr(res);

    if (excludeExistingBom && items.length) {
      try {
        const bomRes = await sap.get('/ProductTrees', { $select: 'TreeCode', $top: 500 });
        const existing = new Set(arr(bomRes).map(b => b.TreeCode));
        items = items.filter(i => !existing.has(i.ItemCode));
      } catch(_) { /* if BOM fetch fails, show all items */ }
    }

    if (!items.length) return '<em class="imf-empty">All items already have a BOM, or none found. Type code below to search.</em>';
    const uid = `bom_${prefix}_${Math.random().toString(36).slice(2,7)}`;
    const opts = items.map(i =>
      `<option value="${esc(i.ItemCode)}" data-name="${esc(i.ItemName)}">${esc(i.ItemCode)} — ${esc(i.ItemName)}</option>`
    ).join('');
    return `<div class="imf-picker">
      <select id="${uid}" class="imf-select">
        <option value="">— Select an item —</option>
        ${opts}
      </select>
      <button class="imf-primary" style="white-space:nowrap;flex-shrink:0" onclick="masterSelectBomItem('${uid}','${prefix}')">Select →</button>
    </div>
    <div class="imf-hint">Or type a name / code in the box below to search</div>`;
  } catch(_) {
    return '<em class="imf-empty">Type item name or code below to search.</em>';
  }
}

async function handleBOMChat(sess, msg, sap, res, user) {
  const sid = sess.sid; const step = sess.step;

  if (msg==='restart'||msg==='Create Another BOM'||msg==='Start Over') {
    const fresh = bomInit(); fresh.sid = sid; _bomSess.set(sid, fresh);
    const picker = await itemPickerHtml(sap, 'select_parent', true);
    return res.json({ ok:true, reply:`<div>Starting over. Select the <strong>Parent (Finished) Item</strong>:</div>${picker}`, step:'ASK_PARENT', sessionId:sid });
  }
  if (msg==='add_more_comp') {
    sess.step = 'ADDING_COMPONENTS';
    const picker = await itemPickerHtml(sap, 'select_comp');
    return res.json({ ok:true, reply:`<div style="margin-bottom:6px">${bomComponentsTable(sess.components)}</div><div>Select the next component:</div>${picker}`, step:sess.step, sessionId:sid });
  }
  if (msg.startsWith('remove_comp:')) {
    const idx = Number(msg.split(':')[1]);
    if (idx>=0 && idx<sess.components.length) sess.components.splice(idx,1);
    const picker = await itemPickerHtml(sap, 'select_comp');
    return res.json({ ok:true, reply:`<div>Component removed.</div><div style="margin-top:8px">${bomComponentsTable(sess.components)}</div><div style="margin-top:8px">Select another component:</div>${picker}`, step:sess.step, sessionId:sid });
  }
  if (msg.startsWith('select_parent:')) {
    const parts = msg.split(':'); sess.parentCode = parts[1]; sess.parentName = parts.slice(2).join(':');
    sess.step = 'ASK_TREE_TYPE';
    return res.json({ ok:true, reply:`<div>Parent: <strong>${esc(sess.parentCode)}</strong> — ${esc(sess.parentName)} ✓</div><div style="margin-top:10px">Select the <strong>BOM Type</strong>:</div><div style="margin-top:8px">${treeTypeChips()}</div>`, step:sess.step, sessionId:sid });
  }
  if (msg.startsWith('select_tree_type:')) {
    const [,t] = msg.split(':'); sess.treeType = t; sess.step = 'ASK_BASE_QTY';
    const lbl = {iProductionTree:'Production',iSalesTree:'Sales Bundle',iTemplateTree:'Template',iDisassemblyTree:'Disassembly'}[t]||t;
    return res.json({ ok:true, reply:`<div>Tree Type: <strong>${lbl}</strong> ✓</div><div style="margin-top:8px">Enter the <strong>Base Quantity</strong> (default: 1):</div>`, step:sess.step, sessionId:sid });
  }
  if (msg.startsWith('select_comp:')) {
    const parts = msg.split(':'); sess.pendingComp = { itemCode:parts[1], itemName:parts.slice(2).join(':') };
    sess.step = 'AWAIT_COMP_QTY';
    return res.json({ ok:true, reply:`<div>Component: <strong>${esc(sess.pendingComp.itemCode)}</strong> — ${esc(sess.pendingComp.itemName)} ✓</div><div style="margin-top:8px">Enter <strong>Quantity</strong> for this component:</div>`, step:sess.step, sessionId:sid });
  }
  if (msg.startsWith('select_comp_wh:')) {
    const parts = msg.split(':'); const whCode = parts[1]; const whName = parts.slice(2).join(':');
    sess.components.push({ ...sess.pendingComp, quantity: sess.pendingComp._qty, warehouse: whCode, warehouseName: whName });
    sess.pendingComp = null;
    sess.step = 'ADDING_COMPONENTS';
    const picker = await itemPickerHtml(sap, 'select_comp');
    const finishBtn = `<button class="imf-primary" onclick="masterSend('done_adding')">✓ Finish Adding</button>`;
    return res.json({ ok:true, reply:`<div>Component added ✓</div><div style="margin-top:8px">${bomComponentsTable(sess.components)}</div><div style="margin-top:10px">Add another component or ${finishBtn}</div>${picker}`, step:sess.step, sessionId:sid });
  }
  if (msg==='done_adding') {
    if (!sess.components.length) return res.json({ ok:true, reply:'<div style="color:#b91c1c">⚠️ Add at least one component.</div>', step:sess.step, sessionId:sid });
    sess.step = 'CONFIRM';
    return res.json({ ok:true, reply:`<div>Components saved ✓ Review the BOM:</div>${bomSummaryHtml(sess)}`, step:sess.step, sessionId:sid });
  }
  if (msg==='confirm_bom') {
    const payload = {
      TreeCode: sess.parentCode,
      TreeType: sess.treeType,
      Quantity: sess.baseQty,
      ProductTreeLines: sess.components.map(c => ({ ItemCode:c.itemCode, Quantity:c.quantity, Warehouse:c.warehouse })),
    };
    try {
      const result = await sap.post('/ProductTrees', payload);
      sess.step = 'DONE';
      logEntry('bom', sess.parentCode, sess.parentName, payload, result, 'success', user);
      return res.json({ ok:true, reply:`<div class="imf-success"><div class="imf-success-title">✓ Bill of Material Created Successfully!</div><div class="imf-success-text">BOM for <strong>${esc(sess.parentCode)}</strong> (${esc(sess.parentName)}) with <strong>${sess.components.length}</strong> component${sess.components.length===1?'':'s'} has been created in SAP.</div></div>`, step:sess.step, sessionId:sid, quickReplies:['Create Another BOM'] });
    } catch(e) {
      logEntry('bom', sess.parentCode, sess.parentName, payload, {error:e.message}, 'error', user);
      return res.json({ ok:true, reply:`<div style="color:#b91c1c">❌ Failed: ${esc(e.message)}</div>`, step:sess.step, sessionId:sid, quickReplies:['Try Again','Start Over'] });
    }
  }

  // Text input steps
  if (step==='ASK_PARENT') {
    if (!msg.trim()) return res.json({ ok:true, reply:'<div>Enter parent item name or code to search.</div>', step, sessionId:sid });
    const items = await searchItems(sap, msg.trim());
    if (!items.length) return res.json({ ok:true, reply:'<div>No items found. Try a different search.</div>', step, sessionId:sid });
    if (items.length===1) {
      sess.parentCode = items[0].ItemCode; sess.parentName = items[0].ItemName; sess.step = 'ASK_TREE_TYPE';
      return res.json({ ok:true, reply:`<div>Parent: <strong>${esc(items[0].ItemCode)}</strong> — ${esc(items[0].ItemName)} ✓</div><div style="margin-top:10px">Select the <strong>BOM Type</strong>:</div><div style="margin-top:8px">${treeTypeChips()}</div>`, step:sess.step, sessionId:sid });
    }
    sess.parentResults = items;
    return res.json({ ok:true, reply:`<div>Select the parent item:</div><div style="margin-top:8px">${bomItemChips(items,'select_parent')}</div>`, step, sessionId:sid });
  }
  if (step==='ASK_BASE_QTY') {
    const q = parseFloat(msg.trim()||'1'); sess.baseQty = isNaN(q)?1:q; sess.step = 'ADDING_COMPONENTS';
    if (!sess.warehouseList.length) {
      const whRes = await sap.get('/Warehouses', { $select:'WarehouseCode,WarehouseName', $filter:"Inactive eq 'tNO'", $top:200 });
      sess.warehouseList = arr(whRes);
    }
    const picker = await itemPickerHtml(sap, 'select_comp');
    return res.json({ ok:true, reply:`<div>Base Qty: <strong>${sess.baseQty}</strong> ✓</div><div style="margin-top:10px">Select <strong>components</strong> to add:</div>${picker}`, step:sess.step, sessionId:sid });
  }
  if (step==='ADDING_COMPONENTS') {
    const items = await searchItems(sap, msg.trim());
    if (!items.length) return res.json({ ok:true, reply:'<div>No items found. Try a different search.</div>', step, sessionId:sid });
    return res.json({ ok:true, reply:`<div>Select a component:</div><div style="margin-top:8px">${bomItemChips(items,'select_comp')}</div>`, step, sessionId:sid });
  }
  if (step==='AWAIT_COMP_QTY') {
    const q = parseFloat(msg.trim()); if (isNaN(q)||q<=0) return res.json({ ok:true, reply:'<div>Enter a valid quantity.</div>', step, sessionId:sid });
    sess.pendingComp._qty = q;
    return res.json({ ok:true, reply:`<div>Quantity: <strong>${q}</strong> ✓</div><div style="margin-top:8px">Select the <strong>Warehouse</strong> for this component:</div><div style="margin-top:8px">${warehouseChips(sess.warehouseList).replace(/select_wh:/g,'select_comp_wh:')}</div>`, step, sessionId:sid });
  }
  return res.json({ ok:true, reply:'<div>Please follow the wizard steps.</div>', step, sessionId:sid });
}

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE CALL AGENT
// ─────────────────────────────────────────────────────────────────────────────
const _scSess = new Map();
function scInit() {
  return {
    step: 'ASK_MODE',
    sid: `sc_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
    mode: null,
    customerCode: null, customerName: null,
    itemCode: null, itemName: null, itemManage: 'none',
    serialNum: null,
    subject: null, description: null, priority: null,
    callType: null, callTypeName: null, callTypeList: [],
    problemType: null, problemTypeName: null, problemTypeList: [],
    technicianCode: null, technicianName: null, technicianList: [],
    callId: null, existingCall: null,
    newStatus: null, resolution: null,
  };
}
function scStepBar(step, mode) {
  const all    = mode==='update'
    ? ['ASK_CALL_ID','ASK_UPDATE_ACTION','CONFIRM_UPDATE','DONE']
    : ['ASK_BP','ASK_ITEM','ASK_SUBJECT','ASK_DESCRIPTION','ASK_PRIORITY','ASK_CALL_TYPE','ASK_TECHNICIAN','CONFIRM','DONE'];
  const labels = mode==='update'
    ? ['Find Call','Update','Confirm','Done']
    : ['Customer','Item','Subject','Description','Priority','Type','Technician','Confirm','Done'];
  const idx = all.indexOf(step);
  return `<div style="display:flex;align-items:center;flex-wrap:wrap;gap:2px;font-size:11px;padding:6px 0 4px">
    ${all.map((s,i)=>{const a=i===idx,d=i<idx;return `<span style="display:inline-flex;align-items:center;gap:3px;color:${a?'#fff':d?'#67e8f9':'rgba(255,255,255,0.45)'}"><span style="width:15px;height:15px;border-radius:50%;background:${a?'rgba(255,255,255,0.3)':d?'#0e7490':'rgba(255,255,255,0.15)'};display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700">${d?'✓':(i+1)}</span>${labels[i]}${i<all.length-1?'<span style="color:rgba(255,255,255,0.3);margin-left:2px">›</span>':''}</span>`;}).join('')}
  </div>`;
}
function scModeButtons() {
  return `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px">
    <button onclick="masterSend('sc_mode:create')" style="padding:10px 22px;background:linear-gradient(135deg,#0e7490,#155e75);color:#fff;border:none;border-radius:8px;font-size:13.5px;font-weight:700;cursor:pointer;box-shadow:0 2px 6px rgba(14,116,144,0.3)">✨ Create New Service Call</button>
    <button onclick="masterSend('sc_mode:update')" style="padding:10px 22px;background:linear-gradient(135deg,#d97706,#92400e);color:#fff;border:none;border-radius:8px;font-size:13.5px;font-weight:700;cursor:pointer;box-shadow:0 2px 6px rgba(217,119,6,0.3)">🔄 Update Existing Call</button>
  </div>`;
}
function priorityChips() {
  return [
    {v:'scp_Low',   l:'⬇ Low',   bg:'#f0fdf4',b:'#10b981',c:'#065f46'},
    {v:'scp_Medium',l:'➡ Medium',bg:'#fff7ed',b:'#f97316',c:'#9a3412'},
    {v:'scp_High',  l:'⬆ High',  bg:'#fef2f2',b:'#ef4444',c:'#991b1b'},
  ].map(o=>`<button onclick="masterSend('select_sc_priority:${o.v}')" style="margin:4px;padding:8px 18px;background:${o.bg};border:1.5px solid ${o.b};border-radius:20px;cursor:pointer;font-size:13px;color:${o.c};font-weight:700">${o.l}</button>`).join('');
}
function scStatusChips() {
  return [
    {v:'scs_Open',   l:'🟢 Open'},
    {v:'scs_Pending',l:'🟡 Pending'},
    {v:'scs_Closed', l:'🔴 Closed'},
  ].map(o=>`<button onclick="masterSend('select_sc_status:${o.v}')" style="margin:4px;padding:8px 18px;background:#f9fafb;border:1.5px solid #6b7280;border-radius:20px;cursor:pointer;font-size:13px;color:#374151;font-weight:600">${o.l}</button>`).join('');
}
function scCallTypeChips(list) {
  if (!list.length) return '<em style="font-size:12px;color:#6b7280">No types configured. Type description below or skip.</em>';
  return list.map(t=>`<button onclick="masterSend('select_sc_type:${t.CallTypeID}:${esc(t.Name)}')" style="margin:3px;padding:6px 14px;background:#ecfdf5;border:1.5px solid #0e7490;border-radius:20px;cursor:pointer;font-size:12.5px;color:#134e4a;font-weight:600">${esc(t.Name)}</button>`).join('');
}
function scProblemChips(list) {
  if (!list.length) return '<em style="font-size:12px;color:#6b7280">No problem types found.</em>';
  return list.map(t=>`<button onclick="masterSend('select_sc_problem:${t.ProblemTypeID}:${esc(t.Name)}')" style="margin:3px;padding:6px 14px;background:#fefce8;border:1.5px solid #ca8a04;border-radius:20px;cursor:pointer;font-size:12.5px;color:#713f12;font-weight:600">${esc(t.Name)}</button>`).join('');
}
function scTechChips(list) {
  const skipBtn = `<button onclick="masterSend('sc_skip_technician')" style="margin:3px;padding:5px 12px;background:#f3f4f6;border:1.5px solid #9ca3af;border-radius:20px;cursor:pointer;font-size:12.5px;color:#6b7280">Skip (Unassigned)</button>`;
  if (!list.length) return skipBtn;
  return `<div style="max-height:180px;overflow-y:auto;display:flex;flex-wrap:wrap;gap:2px">${list.map(e=>`<button onclick="masterSend('select_sc_tech:${e.EmployeeID}:${esc(e.FirstName)} ${esc(e.LastName)}')" style="margin:3px;padding:5px 12px;background:#f0f9ff;border:1.5px solid #0ea5e9;border-radius:20px;cursor:pointer;font-size:12.5px;color:#0369a1">${esc(e.FirstName)} ${esc(e.LastName)}</button>`).join('')}${skipBtn}</div>`;
}
function scSummaryHtml(sess) {
  const pLbl = {scp_Low:'⬇ Low',scp_Medium:'➡ Medium',scp_High:'⬆ High'}[sess.priority]||'—';
  const rows = [
    ['Customer', sess.customerCode ? `${esc(sess.customerCode)} — ${esc(sess.customerName)}` : '—'],
    ['Item', sess.itemCode ? `${esc(sess.itemCode)} — ${esc(sess.itemName)}` : '—'],
    ...(sess.serialNum ? [['Serial / Batch', esc(sess.serialNum)]] : []),
    ['Subject', esc(sess.subject)],
    ['Description', `<span style="word-break:break-word">${esc(sess.description||'—')}</span>`],
    ['Priority', pLbl],
    ['Call Type', esc(sess.callTypeName||'—')],
    ['Problem Type', esc(sess.problemTypeName||'—')],
    ['Technician', esc(sess.technicianName||'Unassigned')],
  ];
  return `<div style="background:var(--card-bg,#f9fafb);border:1.5px solid #0e7490;border-radius:8px;padding:14px;margin:6px 0">
    <div style="font-size:13.5px;font-weight:700;color:#0e7490;margin-bottom:10px">📋 Service Call Summary</div>
    <table style="width:100%;border-collapse:collapse;font-size:12.5px">${rows.map(([k,v])=>`<tr><td style="padding:4px 8px;color:#6b7280;width:38%;border-bottom:1px solid #f3f4f6;white-space:nowrap">${k}</td><td style="padding:4px 8px;font-weight:600;border-bottom:1px solid #f3f4f6">${v}</td></tr>`).join('')}</table>
    <div style="margin-top:12px;display:flex;gap:8px">
      <button onclick="masterSend('confirm_sc_create')" style="background:#0e7490;color:#fff;border:none;border-radius:6px;padding:8px 22px;font-size:13px;font-weight:700;cursor:pointer">✅ Create Service Call</button>
      <button onclick="masterSend('restart')" style="background:transparent;color:#6b7280;border:1px solid #d1d5db;border-radius:6px;padding:8px 16px;font-size:12.5px;cursor:pointer">↺ Start Over</button>
    </div>
  </div>`;
}
async function scBPPickerHtml(sap) {
  try {
    const res = await sap.get('/BusinessPartners', { $filter:"CardType eq 'cCustomer'", $select:'CardCode,CardName', $orderby:'CardName', $top:200 });
    const bps = arr(res);
    if (!bps.length) return '<em>Type customer name or code below to search.</em>';
    const uid = `sc_bp_${Math.random().toString(36).slice(2,7)}`;
    const opts = bps.map(b=>`<option value="${esc(b.CardCode)}" data-name="${esc(b.CardName)}">${esc(b.CardCode)} — ${esc(b.CardName)}</option>`).join('');
    return `<div style="display:flex;gap:8px;align-items:center;margin-top:8px;max-width:520px">
      <select id="${uid}" style="flex:1;padding:7px 10px;border:1.5px solid #d1d5db;border-radius:6px;font-size:12.5px;background:var(--bg,#fff);color:var(--text,#111);min-width:0">
        <option value="">— Select a customer —</option>${opts}
      </select>
      <button onclick="masterSelectScBP('${uid}')" style="padding:7px 16px;background:#0e7490;color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap">Select →</button>
    </div>
    <div style="font-size:11px;color:#9ca3af;margin-top:4px">Or type a name / code in the box below to search</div>`;
  } catch(_) { return '<em>Type customer name or code below to search.</em>'; }
}
async function scItemPickerHtml(sap) {
  try {
    const res = await sap.get('/Items', { $select:'ItemCode,ItemName', $orderby:'ItemName', $top:200 });
    const items = arr(res);
    if (!items.length) return '<em>No items found.</em>';
    const uid = `sc_item_${Math.random().toString(36).slice(2,7)}`;
    const opts = items.map(i=>`<option value="${esc(i.ItemCode)}" data-name="${esc(i.ItemName)}">${esc(i.ItemCode)} — ${esc(i.ItemName)}</option>`).join('');
    return `<div style="display:flex;gap:8px;align-items:center;margin-top:8px;max-width:520px">
      <select id="${uid}" style="flex:1;padding:7px 10px;border:1.5px solid #d1d5db;border-radius:6px;font-size:12.5px;background:var(--bg,#fff);color:var(--text,#111);min-width:0">
        <option value="">— Select an item —</option>${opts}
      </select>
      <button onclick="masterSelectScItem('${uid}')" style="padding:7px 16px;background:#0e7490;color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap">Select →</button>
    </div>
    <div style="margin-top:8px"><button onclick="masterSend('sc_skip_item')" style="padding:6px 14px;background:#f3f4f6;border:1px solid #d1d5db;border-radius:6px;font-size:12.5px;color:#6b7280;cursor:pointer">Skip (no specific item)</button></div>`;
  } catch(_) { return '<em>Type item code below or skip.</em>'; }
}

async function handleSCChat(sess, msg, sap, res, user) {
  const sid = sess.sid; const step = sess.step;

  if (msg==='restart'||msg==='Start Over') {
    const fresh = scInit(); fresh.sid = sid; _scSess.set(sid, fresh);
    return res.json({ ok:true, reply:`<div>Starting fresh. What would you like to do?</div>${scModeButtons()}`, step:'ASK_MODE', sessionId:sid });
  }
  if (msg==='Create Another') {
    const fresh = scInit(); fresh.sid = sid; fresh.mode='create'; fresh.step='ASK_BP'; _scSess.set(sid, fresh);
    const picker = await scBPPickerHtml(sap);
    return res.json({ ok:true, reply:`<div>Select the <strong>Customer</strong>:</div>${picker}`, step:'ASK_BP', sessionId:sid });
  }
  if (msg==='Update Another') {
    const fresh = scInit(); fresh.sid = sid; fresh.mode='update'; fresh.step='ASK_CALL_ID'; _scSess.set(sid, fresh);
    return res.json({ ok:true, reply:'<div>Enter the <strong>Service Call ID</strong> to update:</div>', step:'ASK_CALL_ID', sessionId:sid });
  }

  // ── Mode selection ──────────────────────────────────────────────────────────
  if (msg.startsWith('sc_mode:')) {
    const [,mode] = msg.split(':'); sess.mode = mode;
    if (mode==='create') {
      sess.step = 'ASK_BP';
      const picker = await scBPPickerHtml(sap);
      return res.json({ ok:true, reply:`<div>Let's create a new service call.</div><div style="margin-top:8px">Select the <strong>Customer</strong>:</div>${picker}`, step:sess.step, sessionId:sid });
    }
    sess.step = 'ASK_CALL_ID';
    return res.json({ ok:true, reply:'<div>Enter the <strong>Service Call ID</strong> (numeric) to update:</div>', step:sess.step, sessionId:sid });
  }

  // ── CREATE: BP selected from combo ──────────────────────────────────────────
  if (msg.startsWith('select_sc_bp:')) {
    const parts = msg.split(':'); sess.customerCode = parts[1]; sess.customerName = parts.slice(2).join(':');
    sess.step = 'ASK_ITEM';
    const picker = await scItemPickerHtml(sap);
    return res.json({ ok:true, reply:`<div>Customer: <strong>${esc(sess.customerCode)} — ${esc(sess.customerName)}</strong> ✓</div><div style="margin-top:8px">Select the <strong>Item</strong> related to this call (optional):</div>${picker}`, step:sess.step, sessionId:sid });
  }

  // ── CREATE: Item selected from combo ────────────────────────────────────────
  if (msg.startsWith('select_sc_item:')) {
    const parts = msg.split(':'); sess.itemCode = parts[1]; sess.itemName = parts.slice(2).join(':');
    try {
      const item = await sap.get(`/Items('${sess.itemCode}')`, { $select:'ManageSerialNumbers,ManageBatchNumbers' });
      const isSerial = item.ManageSerialNumbers === 'tYES';
      const isBatch  = item.ManageBatchNumbers  === 'tYES';
      sess.itemManage = isSerial ? 'serial' : isBatch ? 'batch' : 'none';
      if (isSerial || isBatch) {
        sess.step = 'ASK_SERIAL';
        return res.json({ ok:true, reply:`<div>Item: <strong>${esc(sess.itemCode)}</strong> ✓ (${isSerial?'Serialized':'Batched'} item)</div><div style="margin-top:8px">Enter the <strong>${isSerial?'Serial':'Batch'} Number</strong> (or type <em>skip</em>):</div>`, step:sess.step, sessionId:sid });
      }
    } catch(_) { sess.itemManage = 'none'; }
    sess.step = 'ASK_SUBJECT';
    return res.json({ ok:true, reply:`<div>Item: <strong>${esc(sess.itemCode)}</strong> — ${esc(sess.itemName)} ✓</div><div style="margin-top:8px">Enter the <strong>Subject</strong> of this service call:</div>`, step:sess.step, sessionId:sid });
  }

  if (msg==='sc_skip_item') {
    sess.itemCode = null; sess.itemName = null; sess.step = 'ASK_SUBJECT';
    return res.json({ ok:true, reply:'<div>No specific item ✓</div><div style="margin-top:8px">Enter the <strong>Subject</strong> of this service call:</div>', step:sess.step, sessionId:sid });
  }

  // ── CREATE: Priority ────────────────────────────────────────────────────────
  if (msg.startsWith('select_sc_priority:')) {
    const [,p] = msg.split(':'); sess.priority = p;
    const lbl = {scp_Low:'Low',scp_Medium:'Medium',scp_High:'High'}[p]||p;
    sess.step = 'ASK_CALL_TYPE';
    try { const r2 = await sap.get('/ServiceCallTypes', { $select:'CallTypeID,Name', $top:100 }); sess.callTypeList = arr(r2); } catch(_) { sess.callTypeList = []; }
    const typeContent = scCallTypeChips(sess.callTypeList) + `<div style="margin-top:8px"><button onclick="masterSend('sc_skip_type')" style="padding:5px 12px;background:#f3f4f6;border:1px solid #d1d5db;border-radius:6px;font-size:12px;color:#6b7280;cursor:pointer">Skip Call Type</button></div>`;
    return res.json({ ok:true, reply:`<div>Priority: <strong>${lbl}</strong> ✓</div><div style="margin-top:8px">Select the <strong>Call Type</strong>:</div><div style="margin-top:8px">${typeContent}</div>`, step:sess.step, sessionId:sid });
  }

  // ── CREATE: Call Type ───────────────────────────────────────────────────────
  if (msg.startsWith('select_sc_type:')) {
    const parts = msg.split(':'); sess.callType = Number(parts[1]); sess.callTypeName = parts.slice(2).join(':');
    return await _scAskProblem(sess, sap, res, sid);
  }
  if (msg==='sc_skip_type') {
    sess.callType = null; sess.callTypeName = null;
    return await _scAskProblem(sess, sap, res, sid);
  }

  // ── CREATE: Problem type ────────────────────────────────────────────────────
  if (msg.startsWith('select_sc_problem:')) {
    const parts = msg.split(':'); sess.problemType = Number(parts[1]); sess.problemTypeName = parts.slice(2).join(':');
    return await _scAskTechnician(sess, sap, res, sid);
  }
  if (msg==='sc_skip_problem') {
    sess.problemType = null; sess.problemTypeName = null;
    return await _scAskTechnician(sess, sap, res, sid);
  }

  // ── CREATE: Technician ──────────────────────────────────────────────────────
  if (msg.startsWith('select_sc_tech:')) {
    const parts = msg.split(':'); sess.technicianCode = Number(parts[1]); sess.technicianName = parts.slice(2).join(':');
    sess.step = 'CONFIRM';
    return res.json({ ok:true, reply:`<div>Technician: <strong>${esc(sess.technicianName)}</strong> ✓</div><div style="margin-top:10px">Review and confirm:</div>${scSummaryHtml(sess)}`, step:sess.step, sessionId:sid });
  }
  if (msg==='sc_skip_technician') {
    sess.technicianCode = null; sess.technicianName = null; sess.step = 'CONFIRM';
    return res.json({ ok:true, reply:`<div>No technician assigned ✓</div><div style="margin-top:10px">Review and confirm:</div>${scSummaryHtml(sess)}`, step:sess.step, sessionId:sid });
  }

  // ── CREATE: Confirm & submit ────────────────────────────────────────────────
  if (msg==='confirm_sc_create') {
    const payload = {
      CustomerCode: sess.customerCode,
      Subject: sess.subject,
      ...(sess.itemCode        ? { ItemCode: sess.itemCode }             : {}),
      ...(sess.serialNum       ? { InternalSerialNum: sess.serialNum }   : {}),
      ...(sess.description     ? { Description: sess.description }       : {}),
      ...(sess.callType        ? { CallType: sess.callType }             : {}),
      ...(sess.problemType     ? { ProblemType: sess.problemType }       : {}),
      ...(sess.technicianCode  ? { TechnicianCode: sess.technicianCode } : {}),
    };
    try {
      const result = await sap.post('/ServiceCalls', payload);
      sess.step = 'DONE';
      const callId = result.ServiceCallID ?? result.CallID ?? '—';
      logEntry('service_call', String(callId), sess.subject, payload, result, 'success', user);
      return res.json({ ok:true, reply:`<div style="background:#ecfdf5;border:1px solid #0e7490;border-radius:8px;padding:14px"><div style="font-size:14px;font-weight:700;color:#0e7490;margin-bottom:6px">✅ Service Call Created!</div><div style="font-size:12.5px;color:#065f46">ID: <strong>${esc(String(callId))}</strong> &nbsp;|&nbsp; Subject: <strong>${esc(sess.subject)}</strong></div><div style="font-size:12px;color:#6b7280;margin-top:4px">Customer: ${esc(sess.customerName||'')} &nbsp;|&nbsp; Priority: ${{scp_Low:'Low',scp_Medium:'Medium',scp_High:'High'}[sess.priority]||'—'}</div></div>`, step:sess.step, sessionId:sid, quickReplies:['Create Another','Update Existing'] });
    } catch(e) {
      logEntry('service_call','',sess.subject,payload,{error:e.message},'error',user);
      return res.json({ ok:true, reply:`<div style="color:#b91c1c">❌ Failed: ${esc(e.message)}</div>`, step:sess.step, sessionId:sid, quickReplies:['Try Again','Start Over'] });
    }
  }
  if (msg==='Update Existing') { sess.mode='update'; sess.step='ASK_CALL_ID'; return res.json({ ok:true, reply:'<div>Enter the <strong>Service Call ID</strong> to update:</div>', step:'ASK_CALL_ID', sessionId:sid }); }

  // ── UPDATE: Status ──────────────────────────────────────────────────────────
  if (msg.startsWith('select_sc_status:')) {
    const [,status] = msg.split(':'); sess.newStatus = status;
    const lbl = {scs_Open:'Open',scs_Pending:'Pending',scs_Closed:'Closed'}[status]||status;
    if (status==='scs_Closed') {
      sess.step = 'ASK_RESOLUTION';
      return res.json({ ok:true, reply:`<div>Status: <strong>${lbl}</strong> ✓</div><div style="margin-top:8px">Enter <strong>Resolution</strong> text (or type <em>skip</em>):</div>`, step:sess.step, sessionId:sid });
    }
    sess.step = 'CONFIRM_UPDATE';
    return res.json({ ok:true, reply:`<div>Status: <strong>${lbl}</strong> ✓</div><div style="margin-top:10px">Confirm update to Service Call <strong>#${sess.callId}</strong>?</div><div style="margin-top:8px;display:flex;gap:8px"><button onclick="masterSend('confirm_sc_update')" style="background:#0e7490;color:#fff;border:none;border-radius:6px;padding:8px 20px;font-size:13px;font-weight:700;cursor:pointer">✅ Update</button><button onclick="masterSend('restart')" style="background:transparent;color:#6b7280;border:1px solid #d1d5db;border-radius:6px;padding:8px 14px;font-size:12.5px;cursor:pointer">↺ Start Over</button></div>`, step:sess.step, sessionId:sid });
  }

  if (msg==='confirm_sc_update') {
    const patch = { ...(sess.newStatus ? {Status:sess.newStatus} : {}), ...(sess.resolution ? {Resolution:sess.resolution} : {}) };
    try {
      await sap.patch(`/ServiceCalls(${sess.callId})`, patch);
      sess.step = 'DONE';
      logEntry('service_call_update',String(sess.callId),`Update SC #${sess.callId}`,patch,{},'success',user);
      return res.json({ ok:true, reply:`<div style="background:#ecfdf5;border:1px solid #0e7490;border-radius:8px;padding:14px"><div style="font-size:14px;font-weight:700;color:#0e7490;margin-bottom:6px">✅ Service Call Updated!</div><div style="font-size:12.5px;color:#065f46">Call #<strong>${sess.callId}</strong> updated successfully.</div></div>`, step:sess.step, sessionId:sid, quickReplies:['Create Another','Update Another'] });
    } catch(e) {
      return res.json({ ok:true, reply:`<div style="color:#b91c1c">❌ Update failed: ${esc(e.message)}</div>`, step:sess.step, sessionId:sid, quickReplies:['Try Again','Start Over'] });
    }
  }

  // ── Text input steps ────────────────────────────────────────────────────────
  if (step==='ASK_BP'||step==='ASK_MODE') {
    const q = msg.trim();
    if (!q) { const picker = await scBPPickerHtml(sap); return res.json({ ok:true, reply:`<div>Select a <strong>Customer</strong>:</div>${picker}`, step:'ASK_BP', sessionId:sid }); }
    try {
      const filter = isNaN(q) ? `CardType eq 'cCustomer' and contains(CardName,'${q}')` : `CardType eq 'cCustomer' and (CardCode eq '${q}' or contains(CardName,'${q}'))`;
      const bps = arr(await sap.get('/BusinessPartners', { $filter:filter, $select:'CardCode,CardName', $top:10 }));
      if (!bps.length) return res.json({ ok:true, reply:'<div>No customers found. Try a different name.</div>', step:'ASK_BP', sessionId:sid });
      if (bps.length===1) {
        sess.customerCode = bps[0].CardCode; sess.customerName = bps[0].CardName; sess.step = 'ASK_ITEM';
        const picker = await scItemPickerHtml(sap);
        return res.json({ ok:true, reply:`<div>Customer: <strong>${esc(bps[0].CardCode)} — ${esc(bps[0].CardName)}</strong> ✓</div><div style="margin-top:8px">Select the <strong>Item</strong> (optional):</div>${picker}`, step:sess.step, sessionId:sid });
      }
      return res.json({ ok:true, reply:`<div>Select a customer:</div><div style="margin-top:8px">${bps.map(b=>`<button onclick="masterSend('select_sc_bp:${esc(b.CardCode)}:${esc(b.CardName)}')" style="margin:3px;padding:6px 14px;background:#ecfdf5;border:1.5px solid #0e7490;border-radius:6px;cursor:pointer;font-size:12.5px"><strong>${esc(b.CardCode)}</strong> — ${esc(b.CardName)}</button>`).join('')}</div>`, step:'ASK_BP', sessionId:sid });
    } catch(e) { return res.json({ ok:true, reply:`<div style="color:#b91c1c">Search failed: ${esc(e.message)}</div>`, step:'ASK_BP', sessionId:sid }); }
  }

  if (step==='ASK_ITEM') {
    const q = msg.trim();
    if (!q||q.toLowerCase()==='skip') { sess.step='ASK_SUBJECT'; return res.json({ ok:true, reply:'<div>No item ✓</div><div style="margin-top:8px">Enter the <strong>Subject</strong>:</div>', step:sess.step, sessionId:sid }); }
    const items = await searchItems(sap, q);
    if (!items.length) return res.json({ ok:true, reply:'<div>No items found. Try different search or skip.</div>', step, sessionId:sid });
    return res.json({ ok:true, reply:`<div>Select an item:</div><div style="margin-top:8px">${items.map(i=>`<button onclick="masterSend('select_sc_item:${esc(i.ItemCode)}:${esc(i.ItemName)}')" style="margin:3px;padding:6px 14px;background:#f9fafb;border:1.5px solid #6b7280;border-radius:6px;cursor:pointer;font-size:12.5px"><strong>${esc(i.ItemCode)}</strong> — ${esc(i.ItemName)}</button>`).join('')}</div>`, step, sessionId:sid });
  }

  if (step==='ASK_SERIAL') {
    const v = msg.trim(); sess.serialNum = (!v||v.toLowerCase()==='skip') ? null : v; sess.step = 'ASK_SUBJECT';
    return res.json({ ok:true, reply:`<div>${sess.serialNum?`Serial/Batch: <strong>${esc(sess.serialNum)}</strong>`:'Skipped'} ✓</div><div style="margin-top:8px">Enter the <strong>Subject</strong>:</div>`, step:sess.step, sessionId:sid });
  }

  if (step==='ASK_SUBJECT') {
    if (!msg.trim()) return res.json({ ok:true, reply:'<div>Please enter the subject.</div>', step, sessionId:sid });
    sess.subject = msg.trim(); sess.step = 'ASK_DESCRIPTION';
    return res.json({ ok:true, reply:`<div>Subject: <strong>${esc(sess.subject)}</strong> ✓</div><div style="margin-top:8px">Enter a <strong>Description</strong> (details of the issue — or type <em>skip</em>):</div>`, step:sess.step, sessionId:sid });
  }

  if (step==='ASK_DESCRIPTION') {
    sess.description = (msg.toLowerCase()==='skip') ? null : msg.trim(); sess.step = 'ASK_PRIORITY';
    return res.json({ ok:true, reply:`<div>Description saved ✓</div><div style="margin-top:8px">Select the <strong>Priority</strong>:</div><div style="margin-top:8px">${priorityChips()}</div>`, step:sess.step, sessionId:sid });
  }

  if (step==='ASK_CALL_TYPE') {
    sess.callTypeName = msg.trim(); sess.callType = null;
    return await _scAskProblem(sess, sap, res, sid);
  }

  if (step==='ASK_CALL_ID') {
    const id = parseInt(msg.trim());
    if (isNaN(id)) return res.json({ ok:true, reply:'<div>Please enter a valid numeric Service Call ID.</div>', step, sessionId:sid });
    try {
      const callData = await sap.get(`/ServiceCalls(${id})`);
      sess.callId = id; sess.existingCall = callData; sess.step = 'ASK_UPDATE_ACTION';
      const sLbl = {scs_Open:'🟢 Open',scs_Pending:'🟡 Pending',scs_Closed:'🔴 Closed'}[callData.Status]||callData.Status||'Unknown';
      return res.json({ ok:true, reply:`<div style="background:#ecfdf5;border:1px solid #0e7490;border-radius:8px;padding:12px;margin-bottom:10px">
        <div style="font-weight:700;color:#0e7490;margin-bottom:6px">📞 Service Call #${id}</div>
        <div style="font-size:12.5px"><strong>Customer:</strong> ${esc(callData.CustomerCode||'—')}</div>
        <div style="font-size:12.5px"><strong>Subject:</strong> ${esc(callData.Subject||'—')}</div>
        <div style="font-size:12.5px"><strong>Status:</strong> ${sLbl}</div>
        <div style="font-size:12.5px"><strong>Priority:</strong> ${esc(callData.Priority||'—')}</div>
      </div>
      <div>Update <strong>Status</strong>:</div><div style="margin-top:6px">${scStatusChips()}</div>`, step:sess.step, sessionId:sid });
    } catch(e) { return res.json({ ok:true, reply:`<div style="color:#b91c1c">❌ Service Call #${id} not found: ${esc(e.message)}</div>`, step, sessionId:sid }); }
  }

  if (step==='ASK_UPDATE_ACTION') {
    return res.json({ ok:true, reply:`<div>Select a new <strong>Status</strong>:</div><div style="margin-top:8px">${scStatusChips()}</div>`, step, sessionId:sid });
  }

  if (step==='ASK_RESOLUTION') {
    sess.resolution = (msg.toLowerCase()==='skip') ? null : msg.trim(); sess.step = 'CONFIRM_UPDATE';
    return res.json({ ok:true, reply:`<div>Resolution saved ✓</div><div style="margin-top:10px">Confirm update to Service Call <strong>#${sess.callId}</strong>?</div><div style="margin-top:8px;display:flex;gap:8px"><button onclick="masterSend('confirm_sc_update')" style="background:#0e7490;color:#fff;border:none;border-radius:6px;padding:8px 20px;font-size:13px;font-weight:700;cursor:pointer">✅ Update</button><button onclick="masterSend('restart')" style="background:transparent;color:#6b7280;border:1px solid #d1d5db;border-radius:6px;padding:8px 14px;font-size:12.5px;cursor:pointer">↺ Start Over</button></div>`, step:sess.step, sessionId:sid });
  }

  return res.json({ ok:true, reply:'<div>Please follow the wizard steps.</div>', step, sessionId:sid });
}
async function _scAskProblem(sess, sap, res, sid) {
  sess.step = 'ASK_PROBLEM';
  try { const r2 = await sap.get('/ServiceCallProblemTypes', { $select:'ProblemTypeID,Name', $top:100 }); sess.problemTypeList = arr(r2); } catch(_) { sess.problemTypeList = []; }
  const probContent = scProblemChips(sess.problemTypeList) + `<div style="margin-top:8px"><button onclick="masterSend('sc_skip_problem')" style="padding:5px 12px;background:#f3f4f6;border:1px solid #d1d5db;border-radius:6px;font-size:12px;color:#6b7280;cursor:pointer">Skip</button></div>`;
  return res.json({ ok:true, reply:`<div>Call Type: <strong>${esc(sess.callTypeName||'—')}</strong> ✓</div><div style="margin-top:8px">Select the <strong>Problem Type</strong>:</div><div style="margin-top:8px">${probContent}</div>`, step:sess.step, sessionId:sid });
}
async function _scAskTechnician(sess, sap, res, sid) {
  sess.step = 'ASK_TECHNICIAN';
  try { const r2 = await sap.get('/EmployeesInfo', { $select:'EmployeeID,FirstName,LastName', $filter:"Active eq 'tYES'", $top:100 }); sess.technicianList = arr(r2); } catch(_) { sess.technicianList = []; }
  return res.json({ ok:true, reply:`<div>Problem Type: <strong>${esc(sess.problemTypeName||'—')}</strong> ✓</div><div style="margin-top:8px">Select a <strong>Technician</strong>:</div><div style="margin-top:8px">${scTechChips(sess.technicianList)}</div>`, step:sess.step, sessionId:sid });
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTER FACTORY
// ─────────────────────────────────────────────────────────────────────────────
export function createMenuMasterRouter({ requireAuth, getActiveSap }) {
  const router = Router();

  // ── DEBUG: fetch first item's full JSON to verify field names ────────────────
  router.get('/item/debug-fields', requireAuth, async (req, res) => {
    try {
      const sap = getActiveSap();
      const items = await sap.get('/Items', { $top: 1, $select: '' });
      const first = Array.isArray(items) ? items[0] : (items?.value?.[0]);
      if (!first) return res.json({ error: 'No items found in SAP' });
      const uomFields = Object.entries(first)
        .filter(([k]) => /uom|unit|msr|measure|buy|sal|inv|purch/i.test(k))
        .reduce((o,[k,v]) => { o[k]=v; return o; }, {});
      res.json({ allKeys: Object.keys(first), uomRelated: uomFields, fullItem: first });
    } catch(e) { res.json({ error: e.message }); }
  });

  // ── GSTIN CHECK (Supplier Master) ─────────────────────────────────────────
  router.get('/gstin/:gstin', requireAuth, async (req, res) => {
    const gstin = String(req.params.gstin || '').trim().toUpperCase();
    if (!GSTIN_RE.test(gstin)) {
      return res.json({ ok:false, error: 'Invalid GSTIN format. Expected a 15-character GSTIN (e.g. 22AAAAA0000A1Z5).' });
    }
    try {
      const r = await axios.get(`${GSTIN_API_BASE}/v1/gstin/${gstin}`, {
        headers: { 'x-api-key': GSTIN_API_KEY },
        timeout: 15000,
        validateStatus: () => true,
      });
      if (r.status !== 200 || !r.data?.success) {
        const msg = r.data?.error
          || (r.status === 404 ? 'GSTIN not registered in the GST database.'
            : r.status === 402 ? 'GSTIN API is out of credits.'
            : r.status === 401 ? 'GSTIN API key is missing or invalid.'
            : `GSTIN lookup failed (HTTP ${r.status}).`);
        return res.json({ ok:false, error: msg });
      }
      res.json({ ok:true, data: r.data.data, credits_remaining: r.data.credits_remaining });
    } catch(e) {
      res.json({ ok:false, error: e.message || 'GSTIN lookup failed.' });
    }
  });

  // ── BP CHECK — standalone "does this name already exist in SAP?" lookup ────
  router.get('/bp-check', requireAuth, async (req, res) => {
    const rawName = String(req.query.name || '').trim();
    if (!rawName) return res.json({ ok:false, error: 'Please enter a name to check.' });
    try {
      const sap = getActiveSap();
      const dup = await checkDuplicateBP(sap, rawName);
      res.json({ ok:true, query: rawName, exists: dup.exists, matches: dup.matches, partialMatches: dup.partialMatches });
    } catch(e) {
      res.json({ ok:false, error: e.message || 'BP check failed.' });
    }
  });

  // ── Post GSTIN lookup result into the Customer/Supplier Master wizard ───────
  router.post('/bp/init-from-gstin', requireAuth, async (req, res) => {
    try {
      const { bpType, name, gstin, address } = req.body || {};
      if (bpType !== 'customer' && bpType !== 'supplier') return res.json({ ok:false, error:'Invalid BP type.' });
      if (!name || !String(name).trim()) return res.json({ ok:false, error:'Missing business partner name.' });

      const sap = getActiveSap();
      const sess = bpInit(bpType);
      sess.cardName = String(name).trim();
      sess.gstin = gstin ? String(gstin).trim().toUpperCase() : null;
      if (address && (address.Street || address.City)) {
        sess.addresses.push({
          AddressName: address.AddressName || 'GSTIN Registered Address',
          AddressType: address.AddressType === 'bo_ShipTo' ? 'bo_ShipTo' : 'bo_BillTo',
          Street: address.Street || '', City: address.City || '',
          State: address.State || '', ZipCode: address.ZipCode || '',
          Country: address.Country || 'IN',
        });
      }
      sess.step = 'ASK_CODE';
      _bpSess[bpType].set(sess.sid, sess);

      const dup = await checkDuplicateBP(sap, sess.cardName);
      const addrLine = sess.addresses[0]
        ? `${sess.addresses[0].Street}${sess.addresses[0].City ? ', '+sess.addresses[0].City : ''}${sess.addresses[0].State ? ', '+sess.addresses[0].State : ''}${sess.addresses[0].ZipCode ? ' '+sess.addresses[0].ZipCode : ''}`
        : null;
      const reply = `<div>📋 Pre-filled from <strong>GSTIN Check</strong>:</div>
        <div style="margin-top:6px;padding:10px 12px;background:var(--card-bg,#f9fafb);border:1px solid var(--border,#e5e7eb);border-radius:8px;font-size:12.5px">
          <div><strong>Name:</strong> ${esc(sess.cardName)}</div>
          ${sess.gstin ? `<div style="margin-top:3px"><strong>GSTIN:</strong> ${esc(sess.gstin)}</div>` : ''}
          ${addrLine ? `<div style="margin-top:3px"><strong>Address:</strong> ${esc(addrLine)}</div>` : ''}
        </div>
        ${dupWarningHtml(dup)}
        <div style="margin-top:10px">Enter a <strong>BP Code</strong>, or type <em>auto</em> to let SAP assign one:</div>`;
      res.json({ ok:true, sessionId: sess.sid, step: sess.step, reply });
    } catch(e) {
      res.json({ ok:false, error: e.message || 'Failed to start wizard from GSTIN.' });
    }
  });

  // ── ITEM MASTER ────────────────────────────────────────────────────────────
  router.post('/item/reset', requireAuth, (req, res) => {
    const { sessionId } = req.body;
    if (sessionId && _itemSess.has(sessionId)) _itemSess.delete(sessionId);
    res.json({ ok:true });
  });
  router.post('/item/chat', requireAuth, async (req, res) => {
    try {
      const sap = getActiveSap();
      const { message='', sessionId } = req.body;
      const user = req.user?.username || '';
      let sess = sessionId && _itemSess.get(sessionId);
      if (!sess) { sess = itemInit(); _itemSess.set(sess.sid, sess); }
      if (!sessionId || !_itemSess.has(sessionId)) {
        const welcome = `<div>What is the <strong>Item Name</strong>?</div>`;
        return res.json({ ok:true, reply:welcome, step:sess.step, sessionId:sess.sid, stepBar:itemSteps(sess.step) });
      }
      const result = await handleItemChat(sess, message, sap, res, user);
      // stepBar injected via middleware below — but we handle inline
    } catch(e) {
      res.json({ ok:false, error:e.message });
    }
  });

  // ── CUSTOMER MASTER ────────────────────────────────────────────────────────
  router.post('/customer/reset', requireAuth, (req, res) => {
    const { sessionId } = req.body;
    if (sessionId && _bpSess.customer.has(sessionId)) _bpSess.customer.delete(sessionId);
    res.json({ ok:true });
  });
  router.post('/customer/chat', requireAuth, async (req, res) => {
    try {
      const sap = getActiveSap();
      const { message='', sessionId } = req.body;
      const user = req.user?.username || '';
      let sess = sessionId && _bpSess.customer.get(sessionId);
      if (!sess) {
        sess = bpInit('customer'); _bpSess.customer.set(sess.sid, sess);
        return res.json({ ok:true, reply:'<div>What is the <strong>Customer Name</strong>?</div>', step:sess.step, sessionId:sess.sid });
      }
      await handleBPChat(sess, message, sap, res, user);
    } catch(e) { res.json({ ok:false, error:e.message }); }
  });

  // ── SUPPLIER MASTER ────────────────────────────────────────────────────────
  router.post('/supplier/reset', requireAuth, (req, res) => {
    const { sessionId } = req.body;
    if (sessionId && _bpSess.supplier.has(sessionId)) _bpSess.supplier.delete(sessionId);
    res.json({ ok:true });
  });
  router.post('/supplier/chat', requireAuth, async (req, res) => {
    try {
      const sap = getActiveSap();
      const { message='', sessionId } = req.body;
      const user = req.user?.username || '';
      let sess = sessionId && _bpSess.supplier.get(sessionId);
      if (!sess) {
        sess = bpInit('supplier'); _bpSess.supplier.set(sess.sid, sess);
        return res.json({ ok:true, reply:'<div>What is the <strong>Supplier Name</strong>?</div>', step:sess.step, sessionId:sess.sid });
      }
      await handleBPChat(sess, message, sap, res, user);
    } catch(e) { res.json({ ok:false, error:e.message }); }
  });

  // ── BILL OF MATERIAL ───────────────────────────────────────────────────────
  router.post('/bom/reset', requireAuth, (req, res) => {
    const { sessionId } = req.body;
    if (sessionId && _bomSess.has(sessionId)) _bomSess.delete(sessionId);
    res.json({ ok:true });
  });
  router.post('/bom/chat', requireAuth, async (req, res) => {
    try {
      const sap = getActiveSap();
      const { message='', sessionId } = req.body;
      const user = req.user?.username || '';
      let sess = sessionId && _bomSess.get(sessionId);
      if (!sess) {
        sess = bomInit(); _bomSess.set(sess.sid, sess);
        const picker = await itemPickerHtml(sap, 'select_parent', true);
        return res.json({ ok:true, reply:`<div>Select the <strong>Parent (Finished) Item</strong>:</div>${picker}`, step:sess.step, sessionId:sess.sid });
      }
      await handleBOMChat(sess, message, sap, res, user);
    } catch(e) { res.json({ ok:false, error:e.message }); }
  });

  // ── SERVICE CALL ───────────────────────────────────────────────────────────
  router.post('/service-call/reset', requireAuth, (req, res) => {
    const { sessionId } = req.body;
    if (sessionId && _scSess.has(sessionId)) _scSess.delete(sessionId);
    res.json({ ok:true });
  });
  router.post('/service-call/chat', requireAuth, async (req, res) => {
    try {
      const sap = getActiveSap();
      const { message='', sessionId } = req.body;
      const user = req.user?.username || '';
      let sess = sessionId && _scSess.get(sessionId);
      if (!sess) {
        sess = scInit(); _scSess.set(sess.sid, sess);
        return res.json({ ok:true, reply:`<div>👋 Welcome to <strong>Service Call Agent</strong>!</div><div style="margin-top:6px;font-size:12.5px;color:#6b7280">Define your requirements — the Agent manages the entire process.<br>Supports serialized, batched &amp; non-serialized items. Creates or updates Service Calls in seconds.</div><div style="margin-top:10px">What would you like to do?</div>${scModeButtons()}`, step:sess.step, sessionId:sess.sid });
      }
      await handleSCChat(sess, message, sap, res, user);
    } catch(e) { res.json({ ok:false, error:e.message }); }
  });

  return router;
}
