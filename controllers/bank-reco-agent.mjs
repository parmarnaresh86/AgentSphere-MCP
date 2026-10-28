/**
 * Bank Reconciliation Agent — backend controller
 * Mounted at /api/bank-reco by chat-server.mjs (UI: public/bank-reco.html)
 *
 *  1. Scan     — OCR a bank statement (PDF / image) into header + transactions,
 *                then prove the extraction with a running-balance check
 *  2. SAP book — journal lines (JDT1) of the bank's G/L account for the period,
 *                plus earlier lines not yet externally reconciled in SAP (ExtrMatch = 0)
 *  3. Match    — reference / cheque no → keyword + date → unique amount → day groups,
 *                then an optional AI pass over what is left (accepted only if amounts tie)
 *  4. Reco     — the four reconciling buckets and the proof
 *                  SAP = Bank − issued-not-presented − credited-not-booked
 *                             + deposited-not-credited + debited-not-booked
 *  5. Export   — Excel reconciliation statement (exceljs)
 *
 * DB Direct (HANA / MSSQL) first, Service Layer fallback.
 */

import { Router } from 'express';
import multer from 'multer';
import ExcelJS from 'exceljs';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
let pdfParse;
try { pdfParse = _require('pdf-parse'); } catch (e) {}

const _upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_SL_JE = 20000;

const ymd = d => d.toISOString().slice(0, 10);
const isYmd = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const day = v => v ? String(v instanceof Date ? ymd(v) : v).slice(0, 10) : null;
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const num = v => { if (v == null || v === '') return null; const n = Number(String(v).replace(/[, ]/g, '')); return Number.isFinite(n) ? n : null; };
const daysBetween = (a, b) => { const d = Math.abs(Date.parse(a) - Date.parse(b)) / 864e5; return Number.isFinite(d) ? Math.round(d) : 9999; };
const safeAcct = s => String(s || '').replace(/[^A-Za-z0-9_\-.]/g, '');

// ── AI ────────────────────────────────────────────────────────────────────────
// content: Anthropic-style parts (text / image / document). The GPT path gets the
// text parts and images only — it cannot read a PDF without a text layer.
const AZURE_MAX_TOKENS = Number(process.env.BANK_RECO_AZURE_MAX_TOKENS) || 8192;   // Claude 3.5 Sonnet output cap
async function callAI(aiDeps, system, content, maxTokens = 1500) {
  const { AI_PROVIDER, gptChatComplete, azureMessagesCreate, USE_AI } = aiDeps || {};
  const hasPdf = content.some(p => p.type === 'document');
  const anthropic = async () => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const r = await client.messages.create({ model: 'claude-sonnet-4-6', max_tokens: maxTokens, system, messages: [{ role: 'user', content }] });
    return { text: r.content?.[0]?.text || '', truncated: r.stop_reason === 'max_tokens' };
  };
  try {
    if (AI_PROVIDER === 'gpt' && USE_AI && process.env.AZURE_GPT_ENDPOINT) {
      const textParts = content.filter(p => p.type === 'text');
      if (hasPdf && textParts.length < 2 && process.env.ANTHROPIC_API_KEY) return await anthropic();
      const parts = content.map(p => p.type === 'image'
        ? { type: 'image_url', image_url: { url: `data:${p.source.media_type};base64,${p.source.data}` } }
        : p.type === 'text' ? p : null).filter(Boolean);
      const r = await gptChatComplete({ messages: [{ role: 'system', content: system }, { role: 'user', content: parts }], max_tokens: Math.min(maxTokens, 16000) });
      return { text: r?.choices?.[0]?.message?.content || '', truncated: r?.choices?.[0]?.finish_reason === 'length' };
    }
    if (AI_PROVIDER === 'azure' && USE_AI && process.env.AZURE_OPENAI_API_KEY) {
      const r = await azureMessagesCreate({ model: process.env.AZURE_CLAUDE_MODEL || 'claude-sonnet-4-6', system,
        messages: [{ role: 'user', content }], max_tokens: Math.min(maxTokens, AZURE_MAX_TOKENS) });
      return { text: r?.content?.[0]?.text || r?.choices?.[0]?.message?.content || '', truncated: r?.stop_reason === 'max_tokens' };
    }
    if (process.env.ANTHROPIC_API_KEY) return await anthropic();
    return { text: '', truncated: false, error: 'No AI provider is configured.' };
  } catch (e) {
    console.warn('[BankReco] AI call failed:', e.message);
    return { text: '', truncated: false, error: e.message };
  }
}

// Parse the model's JSON; if the output was cut off mid-array, keep every complete row.
function parseLooseJSON(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  const body = text.slice(start);
  try { return JSON.parse(body.slice(0, body.lastIndexOf('}') + 1)); } catch {}
  for (const sep of ['],', '},']) {
    const cut = body.lastIndexOf(sep);
    if (cut < 0) continue;
    try { return { ...JSON.parse(body.slice(0, cut + 1) + ']}'), _truncated: true }; } catch {}
  }
  return null;
}

// ── 1. Scan ───────────────────────────────────────────────────────────────────
// Rows come back as arrays (about half the tokens of keyed objects) so a month of
// transactions fits; longer statements are read in continuation rounds.
const OCR_SYSTEM = `You read bank account statements and return ONLY a JSON object, no prose, in exactly this shape:
{"bankName":string|null,"branch":string|null,"accountNumber":string|null,"accountHolder":string|null,"currency":string|null,
 "periodFrom":"YYYY-MM-DD"|null,"periodTo":"YYYY-MM-DD"|null,"openingBalance":number|null,"closingBalance":number|null,
 "rows":[["YYYY-MM-DD","YYYY-MM-DD"|null,"description","reference"|null,"chequeNo"|null,debit,credit,balance|null]]}
Each element of "rows" is ONE transaction as an array in this fixed order:
  transaction date, value date, description (narration), reference (UTR / ref no column), cheque no, debit, credit, running balance.
Rules:
- List EVERY transaction row from EVERY page, once each, in printed order. Never invent, merge or skip rows.
- debit = money out of the account (withdrawal), credit = money in (deposit). Exactly one of them is non-zero; the other is 0.
- Numbers are plain JSON numbers: no commas, no currency symbols.
- balance is the running balance printed on that row. Make it negative when the statement marks it Dr / overdrawn.
- openingBalance / closingBalance use the same sign rule. Take them from the "Opening / B/F" and "Closing" lines if printed.
- Do NOT output opening balance, brought/carried forward, page total, or closing balance lines as rows.
- Dates on Indian statements are DD/MM/YYYY or DD-MMM-YY — convert to YYYY-MM-DD.
- Keep descriptions as printed, but on one line.`;
const OCR_MAX_TOKENS = Number(process.env.BANK_RECO_OCR_MAX_TOKENS) || 16000;
const OCR_MAX_ROUNDS = 8;

const rowToTx = r => Array.isArray(r)
  ? { date: r[0], valueDate: r[1], description: r[2], reference: r[3], chequeNo: r[4], debit: r[5], credit: r[6], balance: r[7] }
  : r;

function normaliseStatement(raw) {
  const src = Array.isArray(raw?.rows) ? raw.rows : Array.isArray(raw?.transactions) ? raw.transactions : [];
  const tx = src.map(rowToTx).map(t => {
    let debit = Math.abs(num(t?.debit) || 0), credit = Math.abs(num(t?.credit) || 0);
    if (debit && credit) { const net = credit - debit; credit = net > 0 ? net : 0; debit = net < 0 ? -net : 0; }
    return {
      date: isYmd(t?.date) ? t.date : null, valueDate: isYmd(t?.valueDate) ? t.valueDate : null,
      description: String(t?.description || '').trim(), reference: t?.reference ? String(t.reference).trim() : '',
      chequeNo: t?.chequeNo ? String(t.chequeNo).trim() : '', debit: r2(debit), credit: r2(credit), balance: num(t?.balance),
    };
  }).filter(t => t.debit || t.credit).map((t, i) => ({ id: `B${i + 1}`, ...t }));
  return {
    bankName: raw?.bankName || '', branch: raw?.branch || '', accountNumber: raw?.accountNumber ? String(raw.accountNumber) : '',
    accountHolder: raw?.accountHolder || '', currency: raw?.currency || '',
    periodFrom: isYmd(raw?.periodFrom) ? raw.periodFrom : (tx.find(t => t.date)?.date || null),
    periodTo: isYmd(raw?.periodTo) ? raw.periodTo : ([...tx].reverse().find(t => t.date)?.date || null),
    openingBalance: num(raw?.openingBalance), closingBalance: num(raw?.closingBalance), transactions: tx,
  };
}

// Edit distance between two amounts' digit strings (36139.29 vs 16139.29 → 1).
function digitEdits(a, b) {
  const x = Math.abs(a).toFixed(2).replace('.', ''), y = Math.abs(b).toFixed(2).replace('.', '');
  let row = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(row[j] + 1, cur[j - 1] + 1, row[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    row = cur;
  }
  return row[y.length];
}

// Running-balance proof of the OCR. Overdraft statements print "Dr" balances the model
// may leave positive — on the rows, in the header, or both — so each sign is settled on
// its own: rows by which sign makes consecutive rows chain, opening / closing by the rows
// next to them. Then every row must move the previous balance to its own.
export function checkStatement(st) {
  const tx = st.transactions;
  const chains = sign => tx.reduce((n, t, i) => n + (i && tx[i - 1].balance != null && t.balance != null &&
    Math.abs(r2(sign * tx[i - 1].balance + t.credit - t.debit) - sign * t.balance) <= 0.01 ? 1 : 0), 0);
  const signFlipped = chains(-1) > chains(1);
  if (signFlipped) tx.forEach(t => { if (t.balance != null) t.balance = -t.balance; });
  const nearest = (v, target) => v == null || target == null ? v : Math.abs(-v - target) < Math.abs(v - target) ? -v : v;
  const impliedOpening = tx[0]?.balance != null ? r2(tx[0].balance - tx[0].credit + tx[0].debit) : null;
  st.openingBalance = nearest(st.openingBalance, impliedOpening);
  st.closingBalance = nearest(st.closingBalance, [...tx].reverse().find(t => t.balance != null)?.balance);
  const derivedOpening = st.openingBalance == null;
  if (derivedOpening) st.openingBalance = impliedOpening ?? 0;

  const verify = () => {
    let prev = st.openingBalance, bad = 0;
    const flags = tx.map(t => {
      const expected = r2(prev + t.credit - t.debit);
      let flag = null;
      if (t.balance != null && Math.abs(expected - t.balance) > 0.01) { flag = `Running balance ${t.balance.toFixed(2)} ≠ expected ${expected.toFixed(2)} — amount misread or a row missing above`; bad++; }
      prev = t.balance ?? expected;
      return flag;
    });
    return { bad, flags };
  };
  let res = verify(), corrected = 0;
  // A misread amount breaks the chain on one row only. If the next row (or the printed
  // closing balance) agrees with this row's balance, the balance is right — take the
  // amount from the balance movement instead. Only when the digits are a near miss
  // (36139.29 read as 16139.29): a skipped row also breaks the chain, and folding its
  // amount into the next row would hide it.
  if (res.bad) {
    let prev = st.openingBalance;
    tx.forEach((t, i) => {
      const next = tx[i + 1];
      const confirmed = t.balance != null && (next
        ? next.balance != null && Math.abs(r2(t.balance + next.credit - next.debit) - next.balance) <= 0.01
        : st.closingBalance != null && Math.abs(t.balance - st.closingBalance) <= 0.01);
      const move = r2(t.balance - prev), read = t.credit || t.debit;
      if (t.balance != null && Math.abs(r2(prev + t.credit - t.debit) - t.balance) > 0.01 && confirmed && digitEdits(read, Math.abs(move)) <= 2) {
        t.credit = move > 0 ? move : 0; t.debit = move < 0 ? -move : 0;
        t.corrected = `Amount read as ${read.toFixed(2)} — corrected from the running balance`;
        corrected++;
      }
      prev = t.balance ?? r2(prev + t.credit - t.debit);
    });
    if (corrected) res = verify();
  }
  tx.forEach((t, i) => { t.flag = res.flags[i] || t.corrected || null; delete t.corrected; });
  const credits = r2(tx.reduce((s, t) => s + t.credit, 0)), debits = r2(tx.reduce((s, t) => s + t.debit, 0));
  const computedClosing = r2(st.openingBalance + credits - debits);
  if (st.closingBalance == null) st.closingBalance = [...tx].reverse().find(t => t.balance != null)?.balance ?? computedClosing;
  st.check = {
    rows: tx.length, credits, debits, computedClosing, derivedOpening,
    rowIssues: res.bad, corrected, closingOk: Math.abs(computedClosing - st.closingBalance) <= 0.01, signFlipped,
  };
  return st;
}

async function extractRows(aiDeps, content) {
  let header = null, truncated = false, error = null;
  const rows = [];
  for (let round = 0; round < OCR_MAX_ROUNDS; round++) {
    const ask = round === 0 ? 'Extract the bank statement as JSON per the instructions.'
      : `Continue the same statement. You have already returned ${rows.length} rows; the last one was ${JSON.stringify(rows[rows.length - 1])}. ` +
        'Return the same JSON shape with ONLY the rows that come after that one (header fields may be null). If there are no more rows, return "rows": [].';
    const r = await callAI(aiDeps, OCR_SYSTEM, [...content, { type: 'text', text: ask }], OCR_MAX_TOKENS);
    const raw = r.text ? parseLooseJSON(r.text) : null;
    if (!raw) { error = r.error || (r.text ? 'The AI reply was not valid JSON.' : null); truncated = round > 0; break; }
    header ??= raw;
    let got = Array.isArray(raw.rows) ? raw.rows : Array.isArray(raw.transactions) ? raw.transactions : [];
    if (rows.length && got.length && JSON.stringify(got[0]) === JSON.stringify(rows[rows.length - 1])) got = got.slice(1);
    rows.push(...got);
    const more = r.truncated || raw._truncated;
    if (!more) break;
    if (!got.length || round === OCR_MAX_ROUNDS - 1) { truncated = true; break; }
  }
  return { header, rows, truncated, error };
}

async function scanStatement(file, aiDeps) {
  let text = '';
  if (file.mimetype === 'application/pdf' && pdfParse) {
    try { const d = await pdfParse(file.buffer); text = (d.text || '').trim(); } catch (e) { console.warn('[BankReco] pdf-parse:', e.message); }
  }
  const content = [];
  if (IMAGE_TYPES.includes(file.mimetype)) content.push({ type: 'image', source: { type: 'base64', media_type: file.mimetype, data: file.buffer.toString('base64') } });
  else if (file.mimetype === 'application/pdf') content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.buffer.toString('base64') } });
  if (text.length > 100) content.push({ type: 'text', text: 'Text layer of the statement. Columns may run together without spaces ' +
    '(e.g. a cheque / ref number followed directly by the amount) — split them so each row\'s debit/credit moves the previous balance to that row\'s balance:\n' +
    text.slice(0, 120000) });
  let out = await extractRows(aiDeps, content);
  // Azure Claude failed (e.g. wrong deployment name) → retry once on GPT, which can read
  // the PDF's text layer or an image, but not a scanned PDF.
  const gptCanRead = text.length > 100 || IMAGE_TYPES.includes(file.mimetype);
  if (!out.rows.length && gptCanRead && aiDeps.AI_PROVIDER !== 'gpt' && process.env.AZURE_GPT_ENDPOINT && aiDeps.gptChatComplete) {
    console.warn('[BankReco] OCR failed on', aiDeps.AI_PROVIDER, '— retrying with GPT');
    out = await extractRows({ ...aiDeps, AI_PROVIDER: 'gpt', USE_AI: true }, content);
  }
  if (!out.header) return { error: out.error };
  const st = checkStatement(normaliseStatement({ ...out.header, rows: out.rows }));
  st.check.truncated = out.truncated;
  st.fileName = file.originalname;
  return st;
}

// ── 2. SAP book ───────────────────────────────────────────────────────────────
async function dbReady(deps) {
  const { isConnected, ensureConnected } = deps;
  if (!isConnected?.() && ensureConnected) { try { await ensureConnected(); } catch (e) { console.warn('[BankReco] DB reconnect failed:', e.message); } }
  return !!isConnected?.();
}

async function listAccounts(deps, sap) {
  if (await dbReady(deps)) {
    const T = t => deps.tableRef(t, deps.getActiveConfig());
    const accts = await deps.executeSQL(`SELECT A."AcctCode" AS "code", A."FormatCode" AS "formatCode", A."AcctName" AS "name", A."CurrTotal" AS "balance"
      FROM ${T('OACT')} A WHERE A."Finanse" = 'Y' AND A."Postable" = 'Y' ORDER BY A."AcctCode"`);
    let house = [];
    try { house = await deps.executeSQL(`SELECT D."GLAccount" AS "gl", D."Account" AS "accNo", D."BankCode" AS "bank", D."AcctName" AS "name" FROM ${T('DSC1')} D`); }
    catch (e) { console.warn('[BankReco] DSC1 read failed:', e.message); }
    return { source: 'db', accounts: accts.map(a => ({ ...a, balance: num(a.balance), house: house.filter(h => h.gl === a.code) })) };
  }
  const r = await sap.get('/ChartOfAccounts', { $filter: "CashAccount eq 'tYES' and ActiveAccount eq 'tYES'", $select: 'Code,Name,Balance,FormatCode', $top: 500 });
  let house = [];
  try { house = (await sap.get('/HouseBankAccounts', { $select: 'GLAccount,AccNo,BankCode,AccountName', $top: 500 })).value || []; } catch {}
  return { source: 'service-layer', accounts: (r.value || []).map(a => ({ code: a.Code, formatCode: a.FormatCode, name: a.Name, balance: num(a.Balance),
    house: house.filter(h => h.GLAccount === a.Code).map(h => ({ gl: h.GLAccount, accNo: h.AccNo, bank: h.BankCode, name: h.AccountName })) })) };
}

// Pick the G/L account whose house-bank account number (or name) carries the statement's account number.
function suggestAccount(accounts, st) {
  const digits = String(st?.accountNumber || '').replace(/\D/g, '');
  if (digits.length < 4) return null;
  const tail = digits.slice(-4);
  for (const a of accounts) if (a.house.some(h => { const d = String(h.accNo || '').replace(/\D/g, ''); return d && (d.endsWith(digits) || digits.endsWith(d) || d.endsWith(tail)); })) return a.code;
  return accounts.find(a => String(a.name || '').includes(tail))?.code || null;
}

function sapLine(r) {
  const debit = r2(r.Debit), credit = r2(r.Credit);
  return {
    id: `S${r.TransId}-${r.LineId}`, transId: r.TransId, jeNo: r.JENo ?? r.TransId, date: day(r.RefDate),
    debit, credit, dir: debit > 0 ? 'in' : 'out', amount: debit > 0 ? debit : credit,
    memo: r.Memo || '', lineMemo: r.LineMemo || '', ref1: r.Ref1 || '', ref2: r.Ref2 || '', ref3: r.Ref3 || '',
    contra: r.ContraAct || '', contraName: r.ContraName || '', creator: r.Creator || '', transType: String(r.TransType ?? ''),
    baseRef: r.BaseRef || '', stornoTo: r.StornoToTr || null, reconciled: r.ExtrMatch != null && Number(r.ExtrMatch) !== 0,
    trsfrRef: '', chequeNo: '', partner: '',
  };
}

async function fetchLedgerDB(deps, acct, from, to, lookFrom) {
  const T = t => deps.tableRef(t, deps.getActiveConfig());
  const base = `FROM ${T('JDT1')} J INNER JOIN ${T('OJDT')} O ON O."TransId" = J."TransId"
    LEFT JOIN ${T('OCRD')} C ON C."CardCode" = J."ContraAct" LEFT JOIN ${T('OACT')} A ON A."AcctCode" = J."ContraAct"
    LEFT JOIN ${T('OUSR')} U ON U."USERID" = O."UserSign"`;
  const cols = `J."TransId" AS "TransId", J."Line_ID" AS "LineId", J."RefDate" AS "RefDate", J."Debit" AS "Debit", J."Credit" AS "Credit",
    J."LineMemo" AS "LineMemo", J."Ref1" AS "Ref1", J."Ref2" AS "Ref2", J."ContraAct" AS "ContraAct", O."Number" AS "JENo", O."Memo" AS "Memo",
    O."TransType" AS "TransType", O."BaseRef" AS "BaseRef", O."StornoToTr" AS "StornoToTr",
    COALESCE(C."CardName", A."AcctName") AS "ContraName", U."U_NAME" AS "Creator"`;
  let rows, carryForward = true, lastSapRecon = null;
  try {
    // ExtrMatch = 0 only means "still open at the bank" while the account is kept
    // reconciled in SAP. If SAP reconciliation stopped months ago, every later line
    // is 0 and would show as a false outstanding item — compare this period only.
    const [{ D } = {}] = await deps.executeSQL(`SELECT MAX(J."RefDate") AS "D" FROM ${T('JDT1')} J WHERE J."Account" = '${acct}' AND J."ExtrMatch" <> 0`);
    lastSapRecon = day(D);
    carryForward = !!lastSapRecon && Date.parse(lastSapRecon) >= Date.parse(from) - 45 * 864e5;
    rows = await deps.executeSQL(`SELECT ${cols}, J."Ref3Line" AS "Ref3", J."ExtrMatch" AS "ExtrMatch" ${base}
      WHERE J."Account" = '${acct}' AND J."RefDate" <= '${to}'
        AND (J."RefDate" >= '${from}'${carryForward ? ` OR (J."RefDate" >= '${lookFrom}' AND J."ExtrMatch" = 0)` : ''})
      ORDER BY J."RefDate", J."TransId", J."Line_ID"`);
  } catch (e) {
    // Older schemas without Ref3Line / ExtrMatch: period lines only, no carry-forward.
    console.warn('[BankReco] full ledger query failed, retrying minimal:', e.message);
    carryForward = false;
    rows = await deps.executeSQL(`SELECT ${cols} ${base} WHERE J."Account" = '${acct}' AND J."RefDate" >= '${from}' AND J."RefDate" <= '${to}'
      ORDER BY J."RefDate", J."TransId", J."Line_ID"`);
  }
  const [{ B: opening } = {}] = await deps.executeSQL(`SELECT SUM(J."Debit" - J."Credit") AS "B" FROM ${T('JDT1')} J WHERE J."Account" = '${acct}' AND J."RefDate" < '${from}'`);
  const lines = rows.map(sapLine);

  // Payment documents carry the UTR / cheque no / partner the bank prints.
  const ids = [...new Set(lines.filter(l => l.transType === '46' || l.transType === '24').map(l => l.transId))];
  for (let i = 0; i < ids.length; i += 500) {
    const inList = ids.slice(i, i + 500).join(',');
    for (const [hdr, chq] of [['OVPM', 'VPM1'], ['ORCT', 'RCT1']]) {
      try {
        const refs = await deps.executeSQL(`SELECT P."TransId" AS "TransId", P."TrsfrRef" AS "TrsfrRef", P."CardName" AS "CardName",
          (SELECT MIN(K."CheckNum") FROM ${T(chq)} K WHERE K."DocNum" = P."DocEntry") AS "ChequeNo"
          FROM ${T(hdr)} P WHERE P."TransId" IN (${inList})`);
        for (const p of refs) for (const l of lines) if (l.transId === p.TransId) {
          l.trsfrRef = p.TrsfrRef || ''; l.partner = p.CardName || ''; l.chequeNo = p.ChequeNo ? String(p.ChequeNo) : '';
        }
      } catch (e) { console.warn(`[BankReco] ${hdr} refs:`, e.message); }
    }
  }
  return { source: 'db', opening: r2(opening), lines, carryForward, lastSapRecon };
}

async function fetchLedgerSL(sap, acct, from, to) {
  const jes = [];
  while (jes.length < MAX_SL_JE) {
    const r = await sap.get('/JournalEntries', { $filter: `ReferenceDate ge '${from}'`, $select: 'JdtNum,Number,ReferenceDate,Memo,TransactionCode,OriginalJournal,StornoToTr,JournalEntryLines',
      $orderby: 'JdtNum', $top: 500, $skip: jes.length });
    const page = r.value || [];
    jes.push(...page);
    if (!page.length || !(r['odata.nextLink'] || r['@odata.nextLink'])) break;
  }
  const all = [];
  for (const je of jes) for (const l of je.JournalEntryLines || []) if (l.AccountCode === acct) all.push(sapLine({
    TransId: je.JdtNum, LineId: l.Line_ID, JENo: je.Number, RefDate: je.ReferenceDate, Debit: l.Debit, Credit: l.Credit, LineMemo: l.LineMemo,
    Ref1: l.Reference1, Ref2: l.Reference2, Ref3: l.AdditionalReference, ContraAct: l.ContraAccount, ContraName: l.ShortName !== acct ? l.ShortName : '',
    Memo: je.Memo, TransType: je.OriginalJournal, StornoToTr: je.StornoToTr,
  }));
  // Service Layer only gives today's balance: walk it back to the period edges.
  const { Balance } = await sap.get(`/ChartOfAccounts('${acct}')`, { $select: 'Balance' });
  const net = ls => ls.reduce((s, l) => s + l.debit - l.credit, 0);
  const opening = r2(num(Balance) - net(all));
  return { source: 'service-layer', opening, lines: all.filter(l => l.date <= to), carryForward: false };
}

// ── 3. Match ──────────────────────────────────────────────────────────────────
const STOP = new Set(('NEFT RTGS IMPS UPI TRANSFER TRF PAYMENT PAYMENTS RECEIPT BANK LTD LIMITED PVT PRIVATE FROM INWARD OUTWARD CHEQUE CHQ CLG ' +
  'CLEARING DEPOSIT BEING AMOUNT PAID RECEIVED AGAINST ACCOUNT INDIA THE AND FOR TOWARDS ENTRY INCOMING OUTGOING JOURNAL INVOICE BILL ' +
  'MONTH CREDIT DEBIT CASH BRANCH ONLINE FUND FUNDS INTERNET MOBILE BANKING').split(' '));
const DATE_LIKE = /^(20\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])|(0[1-9]|[12]\d|3[01])(0[1-9]|1[0-2])20\d{2})$/;

function tokenise(text, ignore) {
  const up = String(text || '').toUpperCase(), refs = new Set(), words = new Set();
  for (const m of up.matchAll(/[A-Z0-9]*\d[A-Z0-9]*/g)) {
    for (const t of [m[0], ...(m[0].match(/\d{5,}/g) || [])]) {
      const n = t.replace(/^0+/, '');
      if (n.length >= 5 && !DATE_LIKE.test(n) && !ignore.has(n)) refs.add(n);
    }
  }
  for (const m of up.matchAll(/[A-Z]{4,}/g)) if (!STOP.has(m[0])) words.add(m[0]);
  return { refs, words };
}
const refHit = (a, b) => { for (const x of a) for (const y of b) { if (x === y) return true; const [s, l] = x.length < y.length ? [x, y] : [y, x]; if (s.length >= 6 && l.endsWith(s)) return true; } return false; };
const shared = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n; };

function reversalPairs(sap, bank) {
  const excluded = new Map();
  const byTrans = new Map(sap.map(l => [String(l.transId), l]));
  const bankHas = (amt, dir) => bank.some(b => Math.abs(b.amount - amt) < 0.005 && b.dir === dir);
  const mark = (a, b, why) => {
    if (excluded.has(a.id) || excluded.has(b.id)) return;
    if (bankHas(a.amount, a.dir) && bankHas(b.amount, b.dir)) return;   // bounced in the bank too — let matching pair them
    excluded.set(a.id, why); excluded.set(b.id, why);
  };
  for (const l of sap) {
    const orig = l.stornoTo != null ? byTrans.get(String(l.stornoTo)) : null;
    if (orig && Math.abs(orig.amount - l.amount) < 0.005 && orig.dir !== l.dir) mark(orig, l, `Reversed in SAP (JE ${orig.jeNo} ↔ ${l.jeNo})`);
  }
  for (const l of sap) {
    if (excluded.has(l.id) || !/revers/i.test(`${l.memo} ${l.lineMemo}`)) continue;
    const twin = sap.filter(o => o !== l && !excluded.has(o.id) && o.dir !== l.dir && Math.abs(o.amount - l.amount) < 0.005 && daysBetween(o.date, l.date) <= 31)
      .sort((x, y) => daysBetween(x.date, l.date) - daysBetween(y.date, l.date))[0];
    if (twin) mark(twin, l, `Reverse entry (JE ${twin.jeNo} ↔ ${l.jeNo})`);
  }
  return excluded;
}

function sumOf(rows) { return r2(rows.reduce((s, r) => s + r.amount, 0)); }

export function matchRows(bank, sap, st) {
  const ignore = new Set([String(st?.accountNumber || '').replace(/\D/g, '').replace(/^0+/, '')].filter(Boolean));
  for (const b of bank) {
    Object.assign(b, tokenise(`${b.description} ${b.reference} ${b.chequeNo}`, ignore));
    b.refs.delete(String(Math.round(b.amount)));
  }
  for (const s of sap) {
    Object.assign(s, tokenise(`${s.memo} ${s.lineMemo} ${s.ref1} ${s.ref2} ${s.ref3} ${s.trsfrRef} ${s.chequeNo} ${s.partner} ${s.contraName}`, ignore));
    s.refs.delete(String(Math.round(s.amount)));
  }
  const excluded = reversalPairs(sap, bank);
  const openB = new Set(bank.map(b => b.id));
  const openS = new Set(sap.filter(s => !excluded.has(s.id)).map(s => s.id));
  const B = new Map(bank.map(b => [b.id, b])), S = new Map(sap.map(s => [s.id, s]));
  const matches = [];
  const take = (bs, ss, method, confidence, note) => {
    bs.forEach(b => openB.delete(b.id)); ss.forEach(s => openS.delete(s.id));
    matches.push({ id: `M${matches.length + 1}`, bank: bs.map(b => b.id), sap: ss.map(s => s.id), method, confidence, note });
  };
  const same = (b, s) => b.dir === s.dir && Math.abs(b.amount - s.amount) < 0.005;

  // Pass 1 — same amount + shared reference / cheque no, or shared party word within 10 days.
  const cands = [];
  for (const b of bank) for (const s of sap) {
    if (!openS.has(s.id) || !same(b, s)) continue;
    const dd = daysBetween(b.date, s.date), ref = refHit(b.refs, s.refs), words = shared(b.words, s.words);
    if (ref) cands.push({ b, s, score: 100 + Math.min(words, 3) * 5 - Math.min(dd, 60) / 2, method: 'reference', note: 'Amount + reference / cheque no' });
    else if (words && dd <= 10) cands.push({ b, s, score: 50 + Math.min(words, 3) * 10 - dd, method: 'keyword', note: `Amount + party/narration (${dd}d apart)` });
  }
  cands.sort((x, y) => y.score - x.score);
  for (const c of cands) if (openB.has(c.b.id) && openS.has(c.s.id)) take([c.b], [c.s], c.method, 'high', c.note);

  // Pass 2 — amount unique on both sides; small amounts must also be close in date.
  for (const b of bank) {
    if (!openB.has(b.id)) continue;
    const ss = [...openS].map(id => S.get(id)).filter(s => same(b, s));
    const bs = [...openB].map(id => B.get(id)).filter(o => o.dir === b.dir && Math.abs(o.amount - b.amount) < 0.005);
    if (ss.length !== 1 || bs.length !== 1) continue;
    const dd = daysBetween(b.date, ss[0].date);
    if (b.amount >= 100000 ? dd <= 45 : dd <= 3) take([b], ss, 'amount', 'medium', `Unique amount, ${dd}d apart — narration differs, please review`);
  }

  // Pass 3 — one line on one side equals several lines on the other (same day, or sharing a party word).
  const groupPass = (oneSide, manySide, openOne, openMany, oneIsBank) => {
    for (const one of oneSide) {
      if (!openOne.has(one.id)) continue;
      const pool = [...openMany].map(id => (oneIsBank ? S : B).get(id)).filter(m => m.dir === one.dir && m.amount < one.amount && daysBetween(m.date, one.date) <= 3);
      if (pool.length < 2) continue;
      const groups = [...new Set(pool.map(m => m.date))].map(d => pool.filter(m => m.date === d));
      groups.push(pool.filter(m => shared(m.words, one.words) || refHit(m.refs, one.refs)));
      const hit = groups.find(g => g.length >= 2 && Math.abs(sumOf(g) - one.amount) < 0.005);
      if (hit) oneIsBank ? take([one], hit, 'group', 'medium', `1 bank line = ${hit.length} SAP lines`) : take(hit, [one], 'group', 'medium', `${hit.length} bank lines = 1 SAP line`);
    }
  };
  groupPass(sap, bank, openS, openB, false);
  groupPass(bank, sap, openB, openS, true);

  return { matches, excluded: [...excluded].map(([id, reason]) => ({ id, reason })), openBank: [...openB], openSap: [...openS] };
}

const AI_MATCH_SYSTEM = `You help reconcile a bank statement with the company's SAP bank ledger. You get the lines that are still unmatched.
"in" = money into the bank (bank credit / SAP debit), "out" = money out (bank debit / SAP credit).
Propose matches only where you are confident the bank line(s) and SAP line(s) are the SAME transaction: same direction,
and the amounts must tie exactly (one-to-one, one-to-many or many-to-one). Use party names, cheque/UTR numbers and dates.
Never match different parties just because the amount is equal.
Return ONLY JSON: {"matches":[{"bank":["B1"],"sap":["S12-0"],"reason":"short reason"}]}. Return {"matches":[]} if none.`;

async function aiMatch(aiDeps, bank, sap, result) {
  const B = new Map(bank.map(b => [b.id, b])), S = new Map(sap.map(s => [s.id, s]));
  const ob = result.openBank.slice(0, 150).map(id => B.get(id)), os = result.openSap.slice(0, 150).map(id => S.get(id));
  if (!ob.length || !os.length) return 0;
  const facts = {
    bank: ob.map(b => ({ id: b.id, date: b.date, dir: b.dir, amount: b.amount, text: `${b.description} ${b.reference} ${b.chequeNo}`.trim() })),
    sap: os.map(s => ({ id: s.id, date: s.date, dir: s.dir, amount: s.amount, text: [s.memo, s.lineMemo, s.ref1, s.ref2, s.ref3, s.trsfrRef, s.chequeNo && `Chq ${s.chequeNo}`, s.partner || s.contraName].filter(Boolean).join(' | ') })),
  };
  const { text } = await callAI(aiDeps, AI_MATCH_SYSTEM, [{ type: 'text', text: JSON.stringify(facts) }], 4000);
  const out = text ? parseLooseJSON(text) : null;
  let n = 0;
  for (const m of out?.matches || []) {
    const bs = (m.bank || []).map(id => B.get(id)), ss = (m.sap || []).map(id => S.get(id));
    if (!bs.length || !ss.length || bs.some(b => !b || !result.openBank.includes(b.id)) || ss.some(s => !s || !result.openSap.includes(s.id))) continue;
    const dir = bs[0].dir;
    if ([...bs, ...ss].some(x => x.dir !== dir) || Math.abs(sumOf(bs) - sumOf(ss)) >= 0.005) continue;
    result.openBank = result.openBank.filter(id => !m.bank.includes(id));
    result.openSap = result.openSap.filter(id => !m.sap.includes(id));
    result.matches.push({ id: `M${result.matches.length + 1}`, bank: bs.map(b => b.id), sap: ss.map(s => s.id), method: 'ai', confidence: 'medium', note: String(m.reason || 'AI suggested').slice(0, 200) });
    n++;
  }
  return n;
}

// ── 4. Reco ───────────────────────────────────────────────────────────────────
export const CATEGORIES = [
  { key: 'issuedNotPresented',   label: 'Cheques Issued But Not Presented',   side: 'sap',  dir: 'out', sign: -1 },
  { key: 'creditedNotBooked',    label: 'Credited in Bank But Not Booked',    side: 'bank', dir: 'in',  sign: -1 },
  { key: 'depositedNotCredited', label: 'Cheques Received But Not Deposited', side: 'sap',  dir: 'in',  sign: +1 },
  { key: 'debitedNotBooked',     label: 'Debited by Bank But Not Booked',     side: 'bank', dir: 'out', sign: +1 },
];

// manual: [{ category, date, description, amount }] — carry-forwards keyed in by the user.
export function summarise(bankClose, sapClose, items, manual = []) {
  const cats = CATEGORIES.map(c => {
    const rows = items.filter(i => i.category === c.key);
    const extra = manual.filter(m => m.category === c.key);
    return { ...c, rows, manual: extra, total: r2(sumOf(rows) + extra.reduce((s, m) => s + (num(m.amount) || 0), 0)) };
  });
  const computed = r2(bankClose + cats.reduce((s, c) => s + c.sign * c.total, 0));
  return { categories: cats, bankClose: r2(bankClose), sapClose: r2(sapClose), computed, difference: r2(computed - sapClose) };
}

// ── 5. Export ─────────────────────────────────────────────────────────────────
const NAVY = 'FF1F3864', BLUE = 'FF4472C4', TOTAL = 'FFE2EFDA', ALT = 'FFEBF0FA';
const NUMFMT = '#,##0.00;(#,##0.00);"-"';
const fill = argb => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });

async function buildWorkbook(p) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'AgentSphere Bank Reconciliation';
  const sheetName = (p.bankName ? `${p.bankName} ${String(p.accountNumber || '').slice(-4)}` : 'Bank Reco').replace(/[\\/*?:[\]]/g, '').slice(0, 31) || 'Bank Reco';
  const ws = wb.addWorksheet(sheetName);
  const cols = ['Posting Date', 'Doc. No.', 'Trans. No.', 'Remarks', 'Offset Acct', 'Offset Acct Name', 'Debit (LC)', 'Credit (LC)', 'Creator', 'Ref. 3 (Row)'];
  ws.columns = [12, 11, 11, 52, 14, 30, 16, 16, 14, 22].map(width => ({ width }));
  const band = (text, argb, size = 12) => {
    const r = ws.addRow([text]); ws.mergeCells(r.number, 1, r.number, 10);
    r.getCell(1).fill = fill(argb); r.getCell(1).font = { bold: true, size, color: { argb: 'FFFFFFFF' } }; r.height = 20; return r;
  };
  band(`${p.bankName || 'Bank'} · A/c ${p.accountNumber || '—'} · Bank Reconciliation Statement · ${p.from} to ${p.to}`, NAVY, 13);
  const s = ws.addRow([`Prepared by: ${p.preparedBy || ''}`, '', '', 'Balance As per Bank Statement', `G/L ${p.glAccount || ''} ${p.glName || ''}`, '', p.summary.bankClose, '', '', `As at ${p.to}`]);
  s.font = { bold: true }; s.getCell(7).numFmt = NUMFMT;
  const hdr = ws.addRow(cols);
  hdr.eachCell(c => { c.fill = fill(NAVY); c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.alignment = { vertical: 'middle', wrapText: true }; });
  ws.views = [{ state: 'frozen', ySplit: 3 }];

  for (const c of p.summary.categories) {
    band(`${c.sign < 0 ? 'Less' : 'Add'}: ${c.label}`, BLUE, 11);
    let alt = false;
    const rowsOut = [
      ...c.rows.map(r => r.side === 'sap'
        ? [r.date, r.jeNo, r.transId, [r.memo, r.lineMemo].filter(Boolean).join(' — '), r.contra, r.contraName || r.partner, r.debit || null, r.credit || null, r.creator, r.ref3 || r.chequeNo || r.trsfrRef]
        : [r.date, '', '', `Bank: ${r.description}`, '', '', r.dir === 'in' ? r.amount : null, r.dir === 'out' ? r.amount : null, '', r.reference || r.chequeNo]),
      ...c.manual.map(m => [m.date || '', '', '', `Manual: ${m.description || ''}`, '', '', c.dir === 'in' ? num(m.amount) : null, c.dir === 'out' ? num(m.amount) : null, '', '']),
    ];
    for (const v of rowsOut) {
      const r = ws.addRow(v);
      if (v[0] && isYmd(v[0])) { r.getCell(1).value = new Date(`${v[0]}T00:00:00Z`); r.getCell(1).numFmt = 'dd-mmm-yy'; }
      r.getCell(7).numFmt = r.getCell(8).numFmt = NUMFMT;
      if (alt) r.eachCell({ includeEmpty: true }, cell => { cell.fill = fill(ALT); });
      alt = !alt;
    }
    const t = ws.addRow(['', '', '', `Total — ${c.label}`, '', '', c.dir === 'in' ? c.total : null, c.dir === 'out' ? c.total : null]);
    t.font = { bold: true }; t.getCell(7).numFmt = t.getCell(8).numFmt = NUMFMT;
    t.eachCell({ includeEmpty: true }, cell => { if (cell.col <= 10) cell.fill = fill(TOTAL); });
  }
  ws.addRow([]);
  const line = (label, value, argb, white) => {
    const r = ws.addRow(['', '', '', label, '', '', value]);
    r.font = { bold: true, color: white ? { argb: 'FFFFFFFF' } : undefined }; r.getCell(7).numFmt = NUMFMT;
    if (argb) for (let i = 1; i <= 10; i++) r.getCell(i).fill = fill(argb);
  };
  line('Balance As per Day Book (computed)', p.summary.computed, TOTAL);
  line('Book Balance SAP', p.summary.sapClose, TOTAL);
  line('Difference', p.summary.difference, Math.abs(p.summary.difference) < 0.005 ? 'FF00B050' : 'FFFF0000', true);

  // Supporting sheets: what was matched, and the statement exactly as read.
  const m = wb.addWorksheet('Matched');
  m.columns = [{ header: 'Match', width: 8 }, { header: 'Method', width: 11 }, { header: 'Bank date', width: 12 }, { header: 'Bank narration', width: 50 },
    { header: 'Bank amount', width: 16 }, { header: 'SAP date', width: 12 }, { header: 'SAP JE / remarks', width: 50 }, { header: 'SAP amount', width: 16 }, { header: 'Note', width: 40 }];
  for (const x of p.matched || []) {
    const r = m.addRow([x.id, x.method, x.bankDate, x.bankText, x.bankAmount, x.sapDate, x.sapText, x.sapAmount, x.note]);
    r.getCell(5).numFmt = r.getCell(8).numFmt = NUMFMT;
  }
  const b = wb.addWorksheet('Bank Statement');
  b.columns = [{ header: 'Date', width: 12 }, { header: 'Value date', width: 12 }, { header: 'Description', width: 60 }, { header: 'Reference', width: 22 },
    { header: 'Withdrawal', width: 16 }, { header: 'Deposit', width: 16 }, { header: 'Balance', width: 18 }, { header: 'Status', width: 14 }, { header: 'OCR check', width: 40 }];
  for (const t of p.statementRows || []) {
    const r = b.addRow([t.date, t.valueDate, t.description, t.reference || t.chequeNo, t.debit || null, t.credit || null, t.balance, t.status, t.flag || '']);
    [5, 6, 7].forEach(i => { r.getCell(i).numFmt = NUMFMT; });
  }
  for (const w of [m, b]) w.getRow(1).eachCell(c => { c.fill = fill(NAVY); c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; });
  return wb.xlsx.writeBuffer();
}

// ── Router ────────────────────────────────────────────────────────────────────
export function createBankRecoRouter(deps) {
  const { requireAuth, getActiveSap, gptChatComplete, azureMessagesCreate, AI_PROVIDER, USE_AI, OCR_PROVIDER } = deps;
  const aiDeps = { AI_PROVIDER, gptChatComplete, azureMessagesCreate, USE_AI };
  // Statement OCR may run on a different engine (Azure Claude reads scanned PDFs; GPT cannot).
  const ocrDeps = OCR_PROVIDER ? { ...aiDeps, AI_PROVIDER: OCR_PROVIDER, USE_AI: true } : aiDeps;
  const router = Router();

  router.get('/accounts', requireAuth, async (req, res) => {
    try { res.json({ ok: true, ...(await listAccounts(deps, getActiveSap())) }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  router.post('/scan', requireAuth, _upload.single('statement'), async (req, res) => {
    try {
      const file = req.file;
      if (!file) return res.status(400).json({ ok: false, error: 'No file uploaded.' });
      if (file.mimetype !== 'application/pdf' && !IMAGE_TYPES.includes(file.mimetype))
        return res.status(400).json({ ok: false, error: 'Upload the bank statement as a PDF or an image (JPG / PNG).' });
      const statement = await scanStatement(file, ocrDeps);
      if (!statement?.transactions?.length)
        return res.status(422).json({ ok: false, error: 'Could not read any transactions. Check the file is a clear bank statement' +
          (statement?.error ? ` (AI: ${String(statement.error).slice(0, 300)})` : ' and that an AI provider is configured') + '.' });
      let suggested = null;
      try { suggested = suggestAccount((await listAccounts(deps, getActiveSap())).accounts, statement); } catch {}
      res.json({ ok: true, statement, suggestedAccount: suggested });
    } catch (e) {
      console.error('[BankReco] scan error:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Body: { statement, account, from, to, lookbackDays, useAI }
  router.post('/reconcile', requireAuth, async (req, res) => {
    try {
      const { statement: raw, useAI } = req.body || {};
      const acct = safeAcct(req.body?.account);
      if (!acct) return res.status(400).json({ ok: false, error: 'Choose the bank G/L account.' });
      if (!raw?.transactions?.length) return res.status(400).json({ ok: false, error: 'Scan a bank statement first.' });
      const statement = checkStatement(normaliseStatement(raw));
      const from = isYmd(req.body.from) ? req.body.from : statement.periodFrom;
      const to = isYmd(req.body.to) ? req.body.to : statement.periodTo;
      if (!isYmd(from) || !isYmd(to)) return res.status(400).json({ ok: false, error: 'Statement period (from / to) is required.' });
      const look = new Date(`${from}T00:00:00Z`);
      look.setUTCDate(look.getUTCDate() - Math.min(Math.max(Number(req.body.lookbackDays) || 90, 0), 730));

      let ledger = null;
      if (await dbReady(deps)) {
        try { ledger = await fetchLedgerDB(deps, acct, from, to, ymd(look)); }
        catch (e) { console.warn('[BankReco] DB ledger failed, using Service Layer:', e.message); }
      }
      if (!ledger) ledger = await fetchLedgerSL(getActiveSap(), acct, from, to);
      const sapClose = r2(ledger.opening + ledger.lines.filter(l => l.date >= from).reduce((s, l) => s + l.debit - l.credit, 0));

      const bank = statement.transactions.map(t => ({ ...t, dir: t.credit > 0 ? 'in' : 'out', amount: t.credit > 0 ? t.credit : t.debit }));
      const sap = ledger.lines;
      const result = matchRows(bank, sap, statement);
      const aiMatched = useAI && (USE_AI || process.env.ANTHROPIC_API_KEY) ? await aiMatch(aiDeps, bank, sap, result) : 0;

      const strip = ({ refs, words, ...r }) => r;
      res.json({
        ok: true, from, to, account: acct, source: ledger.source, carryForward: ledger.carryForward, lastSapRecon: ledger.lastSapRecon || null, lookFrom: ymd(look),
        statement: { ...statement, transactions: undefined },
        bank: bank.map(strip), sap: sap.map(strip),
        sapOpening: ledger.opening, sapClose, bankClose: statement.closingBalance,
        matches: result.matches, excluded: result.excluded, openBank: result.openBank, openSap: result.openSap, aiMatched,
        categories: CATEGORIES,
      });
    } catch (e) {
      console.error('[BankReco] reconcile error:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Narrative review of the reco exactly as it stands on screen (manual edits included).
  router.post('/insights', requireAuth, async (req, res) => {
    try {
      const { text } = await callAI(aiDeps,
        'You are a chartered accountant reviewing a monthly bank reconciliation prepared from SAP Business One and the bank statement. ' +
        'The JSON holds the balances, the reconciling items per category and the matching statistics. Write a concise markdown review: ' +
        '1) verdict — does it reconcile, and if not what the difference most likely is; 2) items needing action (stale cheques older than 3 months, ' +
        'bank charges / interest / ECS to book in SAP, unidentified receipts to allocate, possible duplicates, low-confidence matches to verify); ' +
        '3) suggested journal entries for the debited/credited-not-booked items. Quote figures from the JSON only. Under 300 words.',
        [{ type: 'text', text: JSON.stringify(req.body || {}).slice(0, 60000) }], 1200);
      res.json({ ok: true, text, available: !!text });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // Body: the reco as shown on screen → recomputes the totals server-side and returns .xlsx.
  router.post('/export', requireAuth, async (req, res) => {
    try {
      const p = req.body || {};
      const items = Array.isArray(p.items) ? p.items : [];
      p.summary = summarise(num(p.bankClose) || 0, num(p.sapClose) || 0, items, Array.isArray(p.manual) ? p.manual : []);
      const buf = await buildWorkbook(p);
      const tag = String(p.to || '').slice(0, 7);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="Bank Reco ${String(p.bankName || p.glAccount || '').replace(/[^\w .-]/g, '')} ${tag}.xlsx"`);
      res.send(Buffer.from(buf));
    } catch (e) {
      console.error('[BankReco] export error:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return router;
}
