/**
 * analytics-v2.mjs
 * V2 Analytics Engine â€” Conversational AI SQL for SAP B1
 *
 * Architecture:
 *   User question â†’ Stage 1: Intent Classifier
 *                 â†’ Stage 2: AI generates HANA/MSSQL SQL (with retry)
 *                 â†’ Stage 3: Execute on DB â†’ Format response
 *
 * Works like ChatGPT Data Analysis: natural language â†’ SQL â†’ results.
 * Keeps conversation history so follow-up questions work ("now filter by UK", "show top 5 only").
 */

import https from 'node:https';
import {
  executeSQL, isConnected, getActiveType, getActiveConfig, fetchLiveUDFs
} from './db-connector.mjs';
import { BASE_SCHEMA, buildSqlContext } from './company-context.mjs';
import { sqlCacheRepo } from './db.mjs';
import { matchTemplate } from './query-templates.mjs';
import { isExcelExportRequest, generateExcelExport, generateMultiTabExcelReport } from './lib/excel-export.mjs';
import { buildProfessionalInsight } from './lib/data-insight.mjs';
import dotenv from 'dotenv';
dotenv.config();

const SQL_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const normQuestion = (text) => text.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();

const AI_PROVIDER = (process.env.AI_PROVIDER || 'anthropic').toLowerCase();
const USE_AI = !!(
  process.env.DEMO_MODE !== 'true' && (
    AI_PROVIDER === 'gpt'
      ? (process.env.AZURE_GPT_ENDPOINT && process.env.AZURE_OPENAI_API_KEY)
      : AI_PROVIDER === 'azure'
        ? (process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_ENDPOINT)
        : (process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY.startsWith('your-'))
  )
);

// â”€â”€ INTENT CLASSIFIER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Ordered by specificity â€” more specific patterns first to avoid false matches.
const INTENT_PATTERNS = [

  // â”€â”€ Service (check before sales so "service invoice" doesn't go to sales) â”€â”€
  {
    intent: 'service',
    re: /\b(service.?call|service.?ticket|service.?contract|equipment.?card|technician|resolution.?time|sla|helpdesk|after.?sales.?service|warranty|maintenance.?call|support.?ticket)\b/i,
  },

  // â”€â”€ Production â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    intent: 'production',
    re: /\b(production.?order|work.?order|\bwor\b|bom|bill.?of.?material|routing|manufacture|assembly|wip|work.?in.?progress|planned.?order|production.?qty|completed.?qty|rejected.?qty|disassembl|sub.?assembl|production.?cost|raw.?material.?consumption|back.?flush)\b/i,
  },

  // â”€â”€ Goods Movement (issue/receipt standalone â€” not purchasing GRPO) â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    intent: 'goods_movement',
    re: /\b(goods.?issue|goods.?receipt(?!.*po|\s*purchase|\s*vendor)|stock.?transfer|inventory.?transfer|transfer.?between.?warehouse|goods.?return|return.?to.?warehouse|issue.?from.?store|material.?issue|material.?receipt|goods.?in|goods.?out|internal.?transfer|stock.?movement)\b/i,
  },

  // â”€â”€ Cost Centre / Profit Centre â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    intent: 'cost_centre',
    re: /\b(cost.?cent(re|er)|profit.?cent(re|er)|dimension|distribution.?rule|cost.?allocation|department.?cost|branch.?performance|cost.?code|ocrcode|ocr.?code|cost.?centre.?analysis|brand.?wise|brandwise|category.?wise|region.?wise|division.?wise)\b/i,
  },

  // â”€â”€ CRM / Activities â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    intent: 'crm',
    re: /\b(activit|opportunity|campaign|meeting|phone.?call|task.?log|follow.?up|crm|lead.?management|pipeline|sales.?opportunity|prospect|deal|engagement|interaction.?log)\b/i,
  },

  // â”€â”€ HR / Employees â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    intent: 'hr',
    re: /\b(employee|staff|headcount|department.?staff|position|job.?title|payroll|salary|hr\b|human.?resource|joining.?date|termination|contract.?type|leave|absent|workforce)\b/i,
  },

  // â”€â”€ Price / Special Price â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    intent: 'price',
    re: /\b(price.?list|special.?price|discount.?matrix|customer.?price|item.?price|pricing|price.?level|last.?purchase.?price|avg.?price|standard.?price|price.?by.?customer|price.?by.?item|price.?break)\b/i,
  },

  // â”€â”€ Banking / Deposits â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    intent: 'banking',
    re: /\b(bank.?deposit|deposit|bank.?transfer|bank.?reconcil|cheque|check.?payment|bank.?account|bank.?statement|bank.?balance|cash.?flow|petty.?cash|bank.?code)\b/i,
  },

  // â”€â”€ Fixed Assets â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    intent: 'fixed_assets',
    re: /\b(fixed.?asset|asset.?register|depreciation|net.?book.?value|nbv|asset.?class|asset.?acquisition|asset.?disposal|asset.?transfer|accumulated.?depreciation|amortization)\b/i,
  },

  // â”€â”€ Purchasing (check before sales so "purchase return" goes here) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    intent: 'purchasing',
    re: /\b(purchas|vendor.?invoice|ap.?inv|a\/p.?inv|purchase.?order|\bpo\b(?!d\b|s\b)|grpo|goods.?receipt.?po|purchase.?return|purchase.?credit|vendor.?credit|ap.?credit|supplier.?invoice|supplier.?credit|vendor.?return|landed.?cost|purchase.?quot|rfq|request.?for.?quot|blanket.?agree|inbound.?delivery|material.?receiv|vendor.?aging|supplier.?aging|payable)\b/i,
  },

  // â”€â”€ Sales (broad â€” after more specific patterns) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    intent: 'sales',
    re: /\b(sales?(?!.?order.?type)|revenue|turnover|ar.?inv|a\/r.?inv|customer.?inv|sales.?order|\bso\b(?!\s*p)|delivery.?note|dispatch|despatch|ar.?credit|credit.?note(?!.*ap|.*vendor|.*purchase)|sales.?return|top.?customer|salesperson|sales.?rep|commission|sales.?quot|order.?value|net.?sales|gross.?profit|gp\b|gp%|margin|receivable|ar.?aging|customer.?aging|outstanding.?invoice|down.?payment.*customer|advance.*customer)\b/i,
  },

  // â”€â”€ Inventory / Stock â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    intent: 'inventory',
    re: /\b(stock|inventory|warehouse|item.?master|\bitem(?!.?group.?sales)\b|product(?!ion)|sku|quantity.?on.?hand|on.?hand|on.?order|committed|reorder.?point|min.?stock|max.?stock|batch.?number|serial.?number|dead.?stock|slow.?moving|fast.?moving|abc.?analysis|stock.?valuation|stock.?aging|expir|shelf.?life|bin.?location|pick.?list|picking|negative.?stock)\b/i,
  },

  // â”€â”€ Finance / Accounting (broad) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    intent: 'finance',
    re: /\b(journal|ledger|account(?!.*manager)|gl\b|trial.?balance|profit.?loss|p&l|balance.?sheet|income.?statement|debit|credit(?!.*note|.*memo)|payment|receipt|cash|aging|outstanding|vat|tax|gst|withholding|currency|exchange.?rate|budget|fiscal|period.?end|month.?end|year.?end|reconcil|bank.?recon|petty.?cash|expense|accrual|provision|write.?off|bad.?debt|financial.?statement|pl\b)\b/i,
  },

  // â”€â”€ Business Partners â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    intent: 'business_partner',
    re: /\b(business.?partner|\bbp\b|customer.?list|vendor.?list|supplier.?list|contact.?person|territory|credit.?limit|payment.?term|customer.?group|supplier.?group|customer.?master|vendor.?master|bp.?master|address|billing.?address|shipping.?address|country.?wise.?customer|blocked.?customer|inactive.?customer)\b/i,
  },
];

export function classifyIntent(question) {
  for (const { intent, re } of INTENT_PATTERNS) {
    if (re.test(question)) return intent;
  }
  return 'general';
}

// ── SQL LINTER ───────────────────────────────────────────────────────────────
// Catches known dialect mistakes the AI makes BEFORE wasting a DB round-trip on
// SQL that's guaranteed to fail (e.g. DATEADD in HANA — see the bug this fixed).
// Returns an error string describing the first problem found, or null if clean.
export function lintSql(sql, dbType) {
  const isHana = dbType === 'hana';
  if (isHana) {
    if (/\bDATEADD\s*\(/i.test(sql))
      return `DATEADD(...) is not valid HANA syntax. Use ADD_YEARS(date,n) / ADD_MONTHS(date,n) / ADD_DAYS(date,n) instead.`;
    if (/\bISNULL\s*\(/i.test(sql))
      return `ISNULL(...) is T-SQL, not valid in HANA. Use IFNULL(expr, default) instead.`;
    if (/\[[A-Za-z0-9_]+\]/.test(sql))
      return `Square brackets [table]/[column] are not valid HANA syntax. Use double-quoted identifiers: "TABLE"."COLUMN".`;
  } else {
    if (/\bIFNULL\s*\(/i.test(sql))
      return `IFNULL(...) is HANA syntax, not valid in SQL Server. Use ISNULL(expr, default) instead.`;
    if (/\bADD_YEARS\s*\(|\bADD_MONTHS\s*\(|\bADD_DAYS\s*\(/i.test(sql))
      return `ADD_YEARS/ADD_MONTHS/ADD_DAYS are HANA functions, not valid in SQL Server. Use DATEADD(YEAR|MONTH|DAY, n, date) instead.`;
  }
  // Universal — SAP B1 has no Cancelled/Canceled column; DocStatus is the only way
  if (/\b(cancelled|canceled)\s*=/i.test(sql) || /["\[]?(cancelled|canceled)["\]]?\s*(=|<>)/i.test(sql))
    return `There is no "Cancelled"/"Canceled" column in SAP B1. Use DocStatus ('O'=Open,'C'=Closed,'W'=Cancelled) instead.`;
  if (!/^\s*SELECT\b/i.test(sql))
    return `Only SELECT statements are allowed.`;
  return null;
}

// â”€â”€ FOCUS BLOCKS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Each block tells the AI exactly which tables and columns matter for that intent.
const INTENT_FOCUS = {

  sales: `
PRIORITY TABLES FOR THIS QUERY:
  OINV  â€” AR Invoice header      (DocEntry,DocNum,CardCode,CardName,SlpCode,DocDate,DocDueDate,DocTotal,GrossProfit,PaidToDate,DocStatus,NumAtCard,Comments,PayToCode,ShipToCode,TaxDate,DiscSum,FreightSum,Currency,DocRate)
  INV1  â€” AR Invoice lines       (DocEntry,LineNum,ItemCode,Dscription,Quantity,Price,DiscPrcnt,LineTotal,GrssProfit,WhsCode,CogsOcrCod,CogsOcrCo2,CogsOcrCo3,CogsOcrCo4,CogsOcrCo5,TaxCode,VatGroup,UomCode,OcrCode,OcrCode2)
  ORDR  â€” Sales Order header     (DocEntry,DocNum,CardCode,CardName,SlpCode,DocDate,DocDueDate,DocTotal,GrossProfit,DocStatus,NumAtCard,ReqDate,PickStatus,DelivrySum)
  RDR1  â€” Sales Order lines      (DocEntry,LineNum,ItemCode,Dscription,Quantity,OpenQty,Price,LineTotal,GrssProfit,WhsCode,ShipDate,CogsOcrCod,OpenCreQty)
  ODLN  â€” Delivery (DO) header   (DocEntry,DocNum,CardCode,CardName,DocDate,DocTotal,DocStatus,TrackNo,TrnspCode)
  DLN1  â€” Delivery lines         (DocEntry,LineNum,ItemCode,Dscription,Quantity,Price,LineTotal,WhsCode,CogsOcrCod)
  ORIN  â€” AR Credit Memo header  (DocEntry,DocNum,CardCode,CardName,SlpCode,DocDate,DocTotal,GrossProfit,DocStatus)
  RIN1  â€” AR Credit Memo lines   (DocEntry,LineNum,ItemCode,Dscription,Quantity,Price,LineTotal,GrssProfit,WhsCode,CogsOcrCod)
  OQUT  â€” Sales Quotation header (DocEntry,DocNum,CardCode,CardName,SlpCode,DocDate,DocDueDate,DocTotal,DocStatus)
  QUT1  â€” Sales Quotation lines  (DocEntry,LineNum,ItemCode,Dscription,Quantity,Price,LineTotal,WhsCode)
  ODPI  â€” AR Down Payment Inv    (DocEntry,DocNum,CardCode,CardName,DocDate,DocTotal,DocStatus,PaidToDate)
  OSLP  â€” Salesperson            (SlpCode,SlpName,Commission,Phone,Email,Active)
  OTER  â€” Sales Territory        (TerritoryID,Descript,SalesManager)
  OCRD  â€” Business Partner       (CardCode,CardName,CardType,GroupCode,SlpCode,Balance,CreditLine,Territory,PaymentGroupCode,Currency)
  OCRG  â€” BP Group               (GroupCode,GroupName)
CogsOcrCod=Dim1(Brand/Category), CogsOcrCo2=Dim2, CogsOcrCo3=Dim3, CogsOcrCo4=Dim4, CogsOcrCo5=Dim5
Key joins: OINV+INV1 ON DocEntry | ORDR+RDR1 ON DocEntry | ODLN+DLN1 ON DocEntry
DocStatus: 'O'=Open 'C'=Closed 'W'=Cancelled
PaidToDate on OINV = paid amount; DocTotal-PaidToDate = balance due`,

  purchasing: `
PRIORITY TABLES FOR THIS QUERY:
  OPOR  â€” Purchase Order header      (DocEntry,DocNum,CardCode,CardName,DocDate,DocDueDate,DocTotal,DocStatus,NumAtCard,Comments,TaxDate)
  POR1  â€” Purchase Order lines       (DocEntry,LineNum,ItemCode,Dscription,Quantity,OpenQty,Price,LineTotal,WhsCode,ShipDate,U_Fields)
  OPCH  â€” AP Invoice header          (DocEntry,DocNum,CardCode,CardName,DocDate,DocDueDate,DocTotal,PaidToDate,DocStatus,NumAtCard,TaxDate)
  PCH1  â€” AP Invoice lines           (DocEntry,LineNum,ItemCode,Dscription,Quantity,Price,LineTotal,WhsCode,OcrCode,OcrCode2)
  OPDN  â€” Goods Receipt PO header    (DocEntry,DocNum,CardCode,CardName,DocDate,DocTotal,DocStatus,NumAtCard)
  PDN1  â€” Goods Receipt PO lines     (DocEntry,LineNum,ItemCode,Dscription,Quantity,Price,LineTotal,WhsCode,StockPrice)
  ORPD  â€” AP Credit Memo header      (DocEntry,DocNum,CardCode,CardName,DocDate,DocTotal,DocStatus)
  RPD1  â€” AP Credit Memo lines       (DocEntry,LineNum,ItemCode,Dscription,Quantity,Price,LineTotal,WhsCode)
  OPQT  â€” Purchase Quotation header  (DocEntry,DocNum,CardCode,CardName,DocDate,DocDueDate,DocTotal,DocStatus)
  PQT1  â€” Purchase Quotation lines   (DocEntry,LineNum,ItemCode,Dscription,Quantity,Price,LineTotal,WhsCode)
  ODPO  â€” AP Down Payment header     (DocEntry,DocNum,CardCode,CardName,DocDate,DocTotal,DocStatus)
  OPIG  â€” Goods Return to Vendor hdr (DocEntry,DocNum,CardCode,CardName,DocDate,DocTotal,DocStatus)
  PIG1  â€” Goods Return to Vendor lns (DocEntry,LineNum,ItemCode,Dscription,Quantity,Price,LineTotal,WhsCode)
  OCRD  â€” Vendor master              (CardCode,CardName,CardType='S',GroupCode,Balance,CreditLine,PaymentGroupCode,Currency)
  OCRG  â€” BP Group                   (GroupCode,GroupName)
Key joins: OPOR+POR1 ON DocEntry | OPCH+PCH1 ON DocEntry | OPDN+PDN1 ON DocEntry
DocStatus: 'O'=Open 'C'=Closed 'W'=Cancelled
PaidToDate on OPCH = paid; DocTotal-PaidToDate = balance payable`,

  inventory: `
PRIORITY TABLES FOR THIS QUERY:
  OITM  â€” Item Master          (ItemCode,ItemName,ItmsGrpCod,InvntItem,SellItem,PrchseItem,OnHand,IsCommited,OnOrder,LastPurPrc,AvgPrice,StdPrice,MinLevel,MaxLevel,LeadTime,ManBtchNum,ManSerNum,InvntryUom,PurUnitMsr,SalUnitMsr,ValidFor,Locked,FrgnName,CodeBars,SuppCatNum,PicturName,UserText)
  OITW  â€” Item-Warehouse Stock (ItemCode,WhsCode,OnHand,IsCommited,OnOrder,MinStock,MaxStock,ReorderQty)
  OWHS  â€” Warehouse Master     (WhsCode,WhsName,Street,City,Country,Inactive,BinActivat)
  OITB  â€” Item Group           (ItmsGrpCod,ItmsGrpNam,PriceList)
  OBTN  â€” Batch Numbers        (ItemCode,DistNumber,WhsCode,Quantity,ExpDate,MnfDate,Status,LotNumber,OriginNo)
  OSRN  â€” Serial Numbers       (ItemCode,DistNumber,WhsCode,Status,MnfDate,ExpDate,IntrSerial,SuppSerial)
  OPLN  â€” Price Lists          (ListNum,ListName,Currency,Factor,IsGrossPrice,Active)
  ITM1  â€” Item Prices          (ItemCode,PriceList,Price,Currency,PriceByCurr)
  OSPP  â€” Special Prices by BP (CardCode,ItemCode,Price,PriceList,Discount,PriceDate)
  OSTA  â€” Special Prices Items (ItemCode,ItmsGrpCod,PriceList,Discount,DateFrom,DateTo)
  OIPF  â€” Pick List            (AbsEntry,Status,PickDate,WhsCode,PickType,AssignedTo)
  IPF1  â€” Pick List Lines      (AbsEntry,DocEntry,DocType,LineNum,ItemCode,Quantity,PickedQty,WhsCode)
Key join: OITM T0 INNER JOIN OITW T1 ON T0.ItemCode=T1.ItemCode
Slow/dead stock: items with OnHand>0 but no recent sales in OINV/INV1
Negative stock: OITW.OnHand < 0`,

  finance: `
PRIORITY TABLES FOR THIS QUERY:
  OJDT  â€” Journal Entry header    (TransId,TransType,RefDate,DueDate,Memo,Ref1,Ref2,Ref3,CreatedBy,UserSign,BaseRef,StornoDate,TransTypeName,Series)
  JDT1  â€” Journal Entry lines     (TransId,Line_ID,Account,ShortName,Debit,Credit,SYSDebit,SYSCredit,FCDebit,FCCredit,RefDate,DueDate,LineMemo,ContraAct,OcrCode,OcrCode2,OcrCode3,OcrCode4,OcrCode5,FCCurrency,BalDueDeb,BalDueCred)
  OACT  â€” Chart of Accounts       (AcctCode,AcctName,GroupMask,ActType,Blocked,CurrTotal,LocTotal,FormatCode,Finanse,ExternalCode,CurrencyOnly,AcctCurrency)
  ORCT  â€” Incoming Payments       (DocEntry,DocNum,CardCode,CardName,DocDate,DocTotal,TrsfrRef,TransId,JrnlMemo,PaymentSum)
  RCT2  â€” Incoming Payment Lines  (DocNum,InvType,DocEntry,SumApplied,AppliedFC,Currency,DiscountSum,WTAmnt)
  OVPM  â€” Outgoing Payments       (DocEntry,DocNum,CardCode,CardName,DocDate,DocTotal,TrsfrRef,TransId,JrnlMemo)
  VPM2  â€” Outgoing Payment Lines  (DocNum,InvType,DocEntry,SumApplied,AppliedFC,Currency,DiscountSum,WTAmnt)
  ODPS  â€” Deposits                (AbsEntry,DepDate,BankCode,AcctNum,DepTotal,ReciptSum,CheckSum,TransfSum,JrnlMemo)
  OVTG  â€” Tax Groups              (Code,Name,Rate,EUVat,VatDueDate,Category,Inactive)
  ORTT  â€” Exchange Rates          (Currency,RateDate,Rate)
  OFPR  â€” Fiscal Periods          (AbsEntry,F_Year,PeriodCode,PeriodName,StartDate,EndDate,Active,LockedAU)
  OBST  â€” Budget Scenarios        (AbsId,Name,Description,Active)
  OCSH  â€” Cash Flow Line          (TransId,ActType,Descript,Amount,Currency,Date1)
Key: JDT1.OcrCode=CostCentreDim1 | TransType 13=AR Invoice 18=AP Invoice 24=IncomingPay 46=OutgoingPay 30=Journal
IncomingPayment joins: ORCT.DocEntry â†’ RCT2.DocNum â†’ RCT2.DocEntry=OINV.DocEntry`,

  goods_movement: `
PRIORITY TABLES FOR THIS QUERY:
  OIGE  â€” Goods Issue header       (DocEntry,DocNum,DocDate,DocTotal,Comments,DocStatus,ToWhsCode)
  IGE1  â€” Goods Issue lines        (DocEntry,LineNum,ItemCode,Dscription,Quantity,Price,LineTotal,WhsCode,OcrCode,OcrCode2)
  OIGN  â€” Goods Receipt header     (DocEntry,DocNum,DocDate,DocTotal,Comments,DocStatus,ToWhsCode)
  IGN1  â€” Goods Receipt lines      (DocEntry,LineNum,ItemCode,Dscription,Quantity,Price,LineTotal,WhsCode,OcrCode)
  OWTR  â€” Inventory Transfer hdr   (DocEntry,DocNum,DocDate,DocTotal,DocStatus,Comments,FromWhsCode,ToWhsCode)
  WTR1  â€” Inventory Transfer lines (DocEntry,LineNum,ItemCode,Dscription,Quantity,Price,LineTotal,FromWhsCode,ToWhsCode)
  OWTQ  â€” Stock Transfer Request   (DocEntry,DocNum,DocDate,DocTotal,DocStatus,Comments,FromWhsCode,ToWhsCode)
  WTQ1  â€” Stock Transfer Req lines (DocEntry,LineNum,ItemCode,Dscription,Quantity,Price,LineTotal,FromWhsCode,ToWhsCode)
  OITM  â€” Item Master              (ItemCode,ItemName,ItmsGrpCod,OnHand)
  OWHS  â€” Warehouse                (WhsCode,WhsName)
Key: Goods Issue reduces stock | Goods Receipt increases stock | Transfer moves between warehouses
Join: OIGE+IGE1 ON DocEntry | OIGN+IGN1 ON DocEntry | OWTR+WTR1 ON DocEntry`,

  cost_centre: `
PRIORITY TABLES FOR THIS QUERY:
  OPRC  â€” Profit Centres / Cost Centres (PrcCode,PrcName,DimCode,Active,ValidFrom,ValidTo,InWhichDim)
  OOCR  â€” Distribution Rules           (OcrCode,OcrName,Active,InWhichDim,DimCode,TotalPerc)
  ODIM  â€” Dimensions                   (DimCode,DimName,ActiveDim,ShortName)
  JDT1  â€” Journal lines with CC coding (TransId,Line_ID,Account,Debit,Credit,OcrCode,OcrCode2,OcrCode3,OcrCode4,OcrCode5)
  INV1  â€” AR Invoice lines CC          (DocEntry,LineNum,ItemCode,LineTotal,GrssProfit,CogsOcrCod,CogsOcrCo2,CogsOcrCo3,CogsOcrCo4,CogsOcrCo5)
  PCH1  â€” AP Invoice lines CC          (DocEntry,LineNum,ItemCode,LineTotal,OcrCode,OcrCode2)
  OINV  â€” AR Invoice header            (DocEntry,DocNum,CardCode,CardName,DocDate,DocTotal,DocStatus)
  OPCH  â€” AP Invoice header            (DocEntry,DocNum,CardCode,CardName,DocDate,DocTotal,DocStatus)
CogsOcrCod on document lines = Dim1 cost centre. OcrCode on JDT1 = Dim1.
Use OPRC to get the name of a cost centre by its code.
Common query: GROUP BY INV1.CogsOcrCod with JOIN OPRC ON PrcCode=CogsOcrCod to get the name.`,

  production: `
PRIORITY TABLES FOR THIS QUERY:
  OWOR  â€” Production Order header    (DocEntry,DocNum,ItemCode,ItemName,PlannedQty,CmpltQty,RjctQty,Status,Type,StartDate,DueDate,OriginNum,Warehouse,PostDate,Remarks,ProductionCost,ActualMaterialCost,ActualResourceCost,ActualOverheadCost)
  WOR1  â€” Production Order comp/lines(DocEntry,LineNum,ItemCode,ItemType,Dscription,PlannedQty,IssuedQty,Price,Warehouse,BaseQty,IssueType,ActualAddition)
  OITT  â€” Bill of Materials header   (Code,Name,Type,Warehouse,Price,BOMType,Status)
  ITT1  â€” BOM component lines        (Code,Father,ItemCode,Quantity,Warehouse,Price,IssueMethod,CompWhs,VisualOrder)
  ORSC  â€” Resource Master            (VisResCode,VisResName,ResType,DefaultWhs,Active,UoMGroup)
  RSC1  â€” Resource Capacities        (VisResCode,Date1,Capacity,OnHand,Committed)
  OITM  â€” Item Master (FG/RM)        (ItemCode,ItemName,ItmsGrpCod,OnHand,IsCommited,OnOrder,ManBtchNum,ManSerNum)
  OITW  â€” Item Warehouse Stock       (ItemCode,WhsCode,OnHand,IsCommited,OnOrder)
Production Order Status: 'P'=Planned 'L'=Released 'A'=Closed 'X'=Cancelled
Type: 'S'=Standard 'D'=Disassembly 'K'=Special
Join: OWOR T0 INNER JOIN WOR1 T1 ON T0.DocEntry=T1.DocEntry`,

  business_partner: `
PRIORITY TABLES FOR THIS QUERY:
  OCRD  â€” BP Master Data     (CardCode,CardName,CardType,GroupCode,Phone1,Phone2,Fax,E_Mail,CntctPrsn,Balance,CreditLine,SlpCode,Territory,Currency,VatLiable,PymntGroup,Blocked,DunTerm,DiscCode,PriceList,DfTcnician,IntSrvTime,MaxCommiss,SalesPersonCode,ValidFor,Address,ZipCode,City,Country,State,FederalTaxID,LicTradNum,CreateDate,UpdateDate)
  CRD1  â€” BP Addresses       (CardCode,AdresType,Address,Street,Block,ZipCode,City,County,Country,State,BuildgFlrRm)
  CRD7  â€” BP Bank Accounts   (CardCode,BankCode,Account,Branch,IBAN,SwiftCode,Country)
  OCRG  â€” BP Groups          (GroupCode,GroupName,GroupType)
  OCPR  â€” Contact Persons    (CardCode,CntctCode,Name,Phone1,Phone2,MobilePhone,Fax,E_Mail,Title,Position,Active,Notes,CreateDate)
  OCTG  â€” Payment Terms      (GroupNum,PymntGroup,ExtraMonth,ExtraDays,BslineDate,Discount,PymntAdpt,OpenInc)
  OSLP  â€” Salesperson        (SlpCode,SlpName,Commission,Phone,Email,Active)
  OTER  â€” Sales Territory    (TerritoryID,Descript,SalesManager)
CardType: 'C'=Customer 'S'=Supplier 'L'=Lead
Blocked: 'Y'=Blocked 'N'=Active
Common: Find all customers with balance > 0: WHERE CardType='C' AND Balance > 0`,

  service: `
PRIORITY TABLES FOR THIS QUERY:
  OSCL  â€” Service Call        (CallID,CstmrCode,CstmrName,Subject,Descript,Status,Priority,Origin,TechnicianCode,ItemCode,ItemName,SerialNo,CreateDate,CloseDate,ResolTime,ClosingDate,Response,Resolut,Cause,CallType,BillFlag,ContractCode,Assignee,ResolutionDesc,InternalRemarks)
  OCSC  â€” Service Contract    (ContractID,CstmrCode,CstmrName,StartDate,EndDate,ContractType,Status,Remarks,ItemCode,SerialNo,MaxCallsQty,UsedCalls,RemainingCalls,TerminDate,Duration,DurType)
  OSCE  â€” Equipment Card      (InsID,ItemCode,ItemName,CstmrCode,CstmrName,SerialNo,InstallDate,Status,WhsCode,DeliveryDate,ManufactDate,PurchaseDate,ReturnDate,Technician,ContractEndDate)
  OCRD  â€” Customer BP         (CardCode,CardName,Phone1,E_Mail,CntctPrsn)
  OSLP  â€” Technician          (SlpCode,SlpName,Phone,Email)
Service Call Status: -1=Draft 0=Open 1=Closed 2=Resolved 3=Pending 4=Waiting Parts
Priority: -1=Low 0=Medium 1=High 2=Critical
Origin: 0=Phone 1=Email 2=Web 3=Fax 4=Letter`,

  crm: `
PRIORITY TABLES FOR THIS QUERY:
  OCLG  â€” Activity Log        (ClgCode,CardCode,CardName,Notes,CntctSbjct,Activity,Action,ClgType,Recontact,Closed,HandledBy,AssignedTo,CntctType,StartDate,StartTime,EndDate,Duration,Location,CloseDate,DocType,DocEntry,DocNum,Priority,CntctCode,Phone,Fax,E_Mail,DeatilBef,OwnerCode,ShowAs,CampaignCode)
  OCAM  â€” Campaign Master     (CampaignCode,CampaignName,StartDate,EndDate,CampaignType,Status,Owner,Remarks,Budget,ActualCost,Remarks2)
  OCRD  â€” Business Partner    (CardCode,CardName,CardType,Phone1,E_Mail,SlpCode,Territory)
  OCPR  â€” Contact Person      (CardCode,CntctCode,Name,Phone1,MobilePhone,E_Mail,Position)
  OSLP  â€” Owner/Salesperson   (SlpCode,SlpName,Phone,Email)
Activity: 'A'=Phone 'B'=Meeting 'C'=Task 'D'=Note 'E'=Email 'P'=Other
Closed: 'N'=Open 'Y'=Closed
ClgType: General=0 Lead=1 Customer=2 Supplier=3
Common: count open activities by type, by owner, by customer`,

  hr: `
PRIORITY TABLES FOR THIS QUERY:
  OHEM  â€” Employee Master     (empID,lastName,firstName,sex,Department,Branch,Position,jobTitle,startDate,statusCode,salary,salaryUnit,eMail,officePhone,mobilePhone,homePhone,homeAddress,homeCity,homeCountry,Manager,Picture,bankCode,bankBranch,bankAccount,leaveDate,terminationReason,ssn,passport,dateofBirth,nationality,education,Title,middleName,active,createDate,updateDate)
  OHED  â€” Employee Education  (empID,startDate,endDate,institution,fieldOfStudy,degree)
  OHTP  â€” HR Positions        (positionCode,name,description,jobType)
  OHAT  â€” Absence Transaction (empID,absType,fromDate,toDate,totalDays,approved,notes)
  OHST  â€” Salary History      (empID,fromDate,toDate,salary,salaryUnit,remarks)
  OHEM.statusCode: A=Active  D=Terminated  S=On Leave  I=Inactive
  OHEM.sex: M=Male  F=Female
  OHEM.salaryUnit: M=Monthly  H=Hourly  A=Annual
Common: list active employees by department, headcount by branch`,

  price: `
PRIORITY TABLES FOR THIS QUERY:
  OPLN  â€” Price List Master    (ListNum,ListName,Currency,Factor,IsGrossPrice,Active,Base,BasePricList)
  ITM1  â€” Item Prices          (ItemCode,PriceList,Price,Currency,PriceByCurr)
  OSPP  â€” Special Prices by BP (CardCode,ItemCode,Price,PriceList,Discount,PriceDate,DateFrom,DateTo)
  OSTA  â€” Special Prices Groups(ItemCode,ItmsGrpCod,PriceList,Discount,DateFrom,DateTo)
  OITM  â€” Item Master          (ItemCode,ItemName,ItmsGrpCod,LastPurPrc,AvgPrice,StdPrice,InvntryUom)
  OCRD  â€” Business Partner     (CardCode,CardName,PriceList,DiscCode)
Common: ITM1 T0 INNER JOIN OPLN T1 ON T0.PriceList=T1.ListNum
        OSPP: customer-specific price overrides (join on CardCode+ItemCode)`,

  banking: `
PRIORITY TABLES FOR THIS QUERY:
  ODPS  â€” Deposits             (AbsEntry,DepDate,BankCode,AcctNum,DepTotal,ReciptSum,CheckSum,TransfSum,JrnlMemo,DepoType)
  ORCT  â€” Incoming Payments    (DocEntry,DocNum,CardCode,CardName,DocDate,DocTotal,TrsfrRef,TransId,CashSum,CheckSum,TrsfrSum,CreditSum)
  OVPM  â€” Outgoing Payments    (DocEntry,DocNum,CardCode,CardName,DocDate,DocTotal,TrsfrRef,TransId,CashSum,CheckSum,TrsfrSum,CreditSum)
  OJDT  â€” Journal Entries      (TransId,TransType,RefDate,Memo,Ref1,Ref2)
  JDT1  â€” Journal Lines        (TransId,Account,Debit,Credit,SYSDebit,SYSCredit,RefDate,LineMemo,ContraAct)
  OACT  â€” Chart of Accounts    (AcctCode,AcctName,ActType,CurrTotal,LocTotal)
Common: Bank accounts are OACT records with ActType='C' (cash/bank type)`,

  fixed_assets: `
PRIORITY TABLES FOR THIS QUERY:
  OASN  â€” Fixed Asset Master      (AssetCode,AssetName,AssetClass,AssetGroup,SerialNum,Quantity,PurchaseDate,Supplier,ItemCode,WhsCode,Location,Employee,Notes,Active,CostAccount,RevalAccount,AccDeprAccount,DeprAccount,NetBookVal,AcqValue,DeprValue,RetirValue,UsefulLife,Status)
  OACS  â€” Asset Class Master      (ClassCode,ClassName,AssetType,LifeYears,DepreciationArea,AcctCost,AcctAccuDep,AcctDepExp)
  OACI  â€” Asset Category          (CategoryCode,CategoryName)
  OADP  â€” Asset Depreciation      (AssetCode,FiscalYear,Period,DepType,DepAmount,AccumDep,NetBookVal,PostingDate)
Fixed Asset Status: A=Active I=Inactive R=Retired
Common: show assets with net book value, annual depreciation, useful life remaining`,

  general: `Use any relevant SAP B1 tables from the schema below. Always join on DocEntry for document header-line joins. Use CardCode to join OCRD. Use ItemCode to join OITM.`,
};

// â”€â”€ AI CALLER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const _httpsAgent = new https.Agent({ rejectUnauthorized: false });

export async function callAI(messages, maxTokens = 1500) {
  if (AI_PROVIDER === 'azure') {
    const { default: axios } = await import('axios');
    const endpoint = (process.env.AZURE_OPENAI_ENDPOINT || '').replace(/\/+$/, '');
    const model    = process.env.AZURE_CLAUDE_MODEL || 'claude-3-5-sonnet-20241022';
    const apiVer   = process.env.AZURE_API_VERSION  || '2024-05-01-preview';
    const url      = `${endpoint}/openai/deployments/${model}/chat/completions?api-version=${apiVer}`;
    const r = await axios.post(url,
      { model, max_tokens: maxTokens, messages },
      { headers: { 'Content-Type': 'application/json', 'api-key': process.env.AZURE_OPENAI_API_KEY }, httpsAgent: _httpsAgent }
    );
    return r.data?.choices?.[0]?.message?.content || '';
  }

  if (AI_PROVIDER === 'gpt') {
    const { default: axios } = await import('axios');
    const endpoint = (process.env.AZURE_GPT_ENDPOINT || '').replace(/\/+$/, '');
    const r = await axios.post(endpoint,
      { messages, max_tokens: maxTokens },
      { headers: { 'Content-Type': 'application/json', 'api-key': process.env.AZURE_OPENAI_API_KEY }, httpsAgent: _httpsAgent }
    );
    return r.data?.choices?.[0]?.message?.content || '';
  }

  // Default: Anthropic
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const ant = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const r = await ant.messages.create({ model: 'claude-sonnet-4-6', max_tokens: maxTokens, messages });
  return r.content?.[0]?.text || '';
}

// â”€â”€ SQL GENERATOR â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export async function generateSQL(question, intent, history = [], lastError = null) {
  const cfg    = getActiveConfig();
  const dbType = getActiveType();
  const isHana = dbType === 'hana';
  const schema = cfg?.schema_name || cfg?.database || '';

  const dialectRules = isHana
    ? `DATABASE: SAP HANA
SCHEMA: "${schema}"
MANDATORY syntax rules:
  - Identifiers MUST use double quotes: "${schema}"."TABLE"."COLUMN"
  - Use IFNULL(expr, default) â€” NOT ISNULL
  - Use || for string concatenation â€” NOT +
  - Use YEAR(col), MONTH(col), DAY(col) for date parts
  - Use TO_DATE('2024-01-01') for date literals
  - Use ADD_YEARS(date, n), ADD_MONTHS(date, n), ADD_DAYS(date, n) for date arithmetic â€” e.g. ADD_YEARS(CURRENT_DATE, -1)
  - NEVER use DATEADD(...) â€” that is T-SQL/SQL Server syntax and is NOT valid in HANA
  - Table alias columns also quoted: T0."DocTotal"
  - No square brackets anywhere`
    : `DATABASE: SQL Server (T-SQL)
DATABASE NAME: [${cfg?.database || 'SBO_DB'}]
MANDATORY syntax rules:
  - Use [DB].[dbo].[TABLE] with square brackets â€” NOT double quotes
  - Use ISNULL(expr, default) â€” NOT IFNULL
  - Use + for string concatenation
  - Use YEAR(col), MONTH(col) for date parts
  - Use FORMAT(date, 'yyyy-MM') for month grouping`;

  const focus = INTENT_FOCUS[intent] || INTENT_FOCUS.general;
  // Only send the ~20K-char complete schema for unclassified ('general') questions —
  // classified intents already get a self-sufficient focus block with real table/column
  // definitions for the relevant module, so the huge dump is unnecessary weight that
  // slows generation and gives the AI more chances to pick an irrelevant table.
  const schemaBlock = intent === 'general'
    ? `=== SAP B1 COMPLETE SCHEMA ===\n${BASE_SCHEMA}\n\n`
    : '';

  let companyExtras = '';
  try { companyExtras = buildSqlContext() || ''; } catch {}

  let liveUDFs = '';
  try { liveUDFs = await fetchLiveUDFs() || ''; } catch {}

  const today    = new Date().toISOString().slice(0, 10);
  const thisYear = new Date().getFullYear();
  const lastYear = thisYear - 1;

  // Conversation history â€” last 6 exchanges (12 items) for follow-up context
  const historyBlock = history.length > 0
    ? '\n--- Conversation history (use for context/follow-up interpretation) ---\n' +
      history.slice(-12).map(h =>
        h.role === 'user'
          ? `User asked: ${h.content}`
          : `Assistant responded with SQL:\n${h.sql || '(SQL not recorded)'}\nResult: ${h.summary || '(no summary)'}`
      ).join('\n') +
      '\n--- End history ---\n'
    : '';

  const retryBlock = lastError
    ? `\n!!! PREVIOUS SQL ATTEMPT FAILED with error: "${lastError}"\nGenerate corrected SQL that avoids this error.\n`
    : '';

  const systemContent =
    `You are an expert SAP Business One SQL analyst. Generate one precise SELECT query.\n\n` +
    `${dialectRules}\n\n` +
    schemaBlock +
    (companyExtras ? `=== COMPANY-SPECIFIC FIELDS ===\n${companyExtras}\n\n` : '') +
    (liveUDFs      ? `=== USER DEFINED FIELDS (UDFs) ===\n${liveUDFs}\n\n` : '') +
    `=== FOCUS FOR THIS QUERY ===\n${focus}\n\n` +
    `=== BUSINESS RULES ===\n` +
    `DocStatus: 'O'=Open  'C'=Closed  'W'=Cancelled\n` +
    `CardType:  'C'=Customer  'S'=Supplier  'L'=Lead\n` +
    `\n` +
    `!!! CRITICAL â€” NEVER USE Cancelled OR Canceled AS A COLUMN NAME IN SQL !!!\n` +
    `There is NO "Cancelled" or "Canceled" column in SAP B1 HANA SQL tables.\n` +
    `To filter open documents:      WHERE DocStatus = 'O'\n` +
    `To filter closed documents:    WHERE DocStatus = 'C'\n` +
    `To exclude cancelled docs:     WHERE DocStatus <> 'W'\n` +
    `To get only active documents:  WHERE DocStatus IN ('O','C')\n` +
    `For open sales orders example: WHERE "ORDR"."DocStatus" = 'O'\n` +
    `NEVER write: Cancelled='tNO', Cancelled='tYES', Canceled='Y', Canceled='N'\n` +
    `\n` +
    `CogsOcrCod = Cost Centre Dim1 (e.g. Brand/Category), CogsOcrCo2-5 = Dim2-5\n` +
    `PaidToDate on OINV/OPCH = amount paid; DocTotal-PaidToDate = balance outstanding\n` +
    `GrossProfit on doc headers = total GP; GrssProfit on lines = line GP\n` +
    `For P&L: Credit on income accounts = revenue; Debit on expense accounts = cost\n` +
    `TransType in OJDT: 13=AR Invoice 14=AR Credit 18=AP Invoice 19=AP Credit 24=IncomingPay 46=OutgoingPay 30=Journal 59=Inventory\n` +
    `For OJDT/JDT1/OACT: filter by RefDate range only â€” no status/cancelled column exists\n\n` +
    `=== DATE CONTEXT ===\n` +
    `Today: ${today} | This year: ${thisYear} (${thisYear}-01-01 to ${today}) | Last year: ${lastYear} (${lastYear}-01-01 to ${lastYear}-12-31)\n` +
    `"YTD" = ${thisYear}-01-01 to ${today} | "MTD" = first day of current month to ${today}\n\n` +
    historyBlock + retryBlock;

  const userContent =
    `User question: "${question}"\n\n` +
    `FIRST, decide how this answer should be presented and output it as the very\n` +
    `first line, exactly in this format (nothing else on that line):\n` +
    `PRESENTATION: chart | insight | table\n` +
    `  - chart   → user wants a visual/trend/comparison (mentions chart, graph, plot,\n` +
    `              trend, "by month/quarter/year", compare, breakdown, visualize)\n` +
    `  - insight → user wants a narrative/business analysis, not just numbers\n` +
    `              (mentions insight, analysis, detail analysis, explain, why, summary)\n` +
    `  - table   → user wants a plain list/lookup of records (default — no chart or\n` +
    `              analysis wording, e.g. "show me...", "list...", "find...")\n` +
    `Then leave one blank line, then output ONLY the raw SQL — RULES for the SQL, follow exactly:\n` +
    `1. Return ONLY the raw SQL — no explanation, no markdown fences (\`\`\`), no comments (--)\n` +
    `2. Only SELECT — never INSERT/UPDATE/DELETE/DROP/EXEC/CREATE/ALTER/TRUNCATE\n` +
    `3. NEVER add TOP, LIMIT, FETCH FIRST, or ROWNUM — return ALL matching rows. Only add a limit if user says "top N" or "show me N".\n` +
    `4. Use meaningful column aliases: AS "Customer Name", AS "Sales Amount", AS "Month"\n` +
    `5. ${isHana ? 'ALL identifiers must be double-quoted: "SCHEMA"."TABLE"."COLUMN"' : 'Use square brackets: [DB].[dbo].[TABLE]'}\n` +
    `6. For totals: SUM(LineTotal) for sales, COUNT(DISTINCT DocEntry) for document count\n` +
    `7. Always ORDER BY the main metric DESC unless user specifies otherwise\n` +
    `8. Include the standard SAP B1 business fields a professional report on this topic would have —\n` +
    `   not just the bare aggregate. E.g. for sales/purchase transactions also include DocNum,\n` +
    `   DocDate, and the relevant code (ItemCode/CardCode) alongside its description/name — enough\n` +
    `   that the sheet reads as a real business report, not a 2-column summary. Only trim fields the\n` +
    `   user explicitly asked to exclude or that don't apply (e.g. no need for WarehouseCode on a\n` +
    `   pure customer-level rollup).`;

  const raw = await callAI([{ role: 'user', content: systemContent + '\n' + userContent }], 1500);

  // First line carries the AI's presentation decision — peel it off before the
  // usual SQL cleanup so a model that ignores the format doesn't break SQL parsing.
  const rawLines = raw.trim().split('\n');
  const presMatch = rawLines[0].match(/^PRESENTATION:\s*(chart|insight|table)/i);
  const presentation = presMatch ? presMatch[1].toLowerCase() : null;
  const sqlSource = presMatch ? rawLines.slice(1).join('\n') : raw;

  // Strip markdown fences if AI added them despite instructions
  let sql = sqlSource.trim()
    .replace(/^```[\w]*\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  if (!sql) throw new Error('AI returned empty response');
  if (!/^SELECT\b/i.test(sql)) {
    throw new Error(`AI returned non-SELECT content: "${sql.slice(0, 120)}"`);
  }
  return { sql, presentation };
}

// Decides single-sheet vs multi-tab BEFORE any SQL runs, so the caller knows
// which pipeline to route into. This used to be a keyword regex ("multiple
// tabs", "multi chart", "trend...item wise"...) — the same class of guess
// that proved fragile for chart/insight/table detection (missed "chart" and
// "analysis" the first time, mishandled "insight" the second). Real
// reasoning instead: one cheap, focused AI call, not a pattern match.
export async function decideReportShape(question) {
  const prompt =
    `A user asked for an Excel export of SAP Business One data: "${question}"\n\n` +
    `Does this need MULTIPLE worksheet tabs/views (e.g. asks for more than one kind of ` +
    `breakdown — a trend AND an item-level split, several charts, explicit "tabs"), or ` +
    `is it really just ONE flat table of rows in a single sheet?\n\n` +
    `Respond with ONLY one word, no punctuation, no explanation: "multi" or "single".`;
  try {
    const raw = await callAI([{ role: 'user', content: prompt }], 10);
    return /multi/i.test(raw.trim()) ? 'multi' : 'single';
  } catch (e) {
    console.warn(`[Excel Report] shape decision failed, defaulting to single: ${e.message}`);
    return 'single';
  }
}

// ── MULTI-TAB EXCEL REPORT PLANNER ──────────────────────────────────────────
// "prepare excel ... with trend analysis and item wise month wise analysis,
// multiple tabs, multi chart" → one AI call decides the shape of the report
// (which tabs, what each is about, whether it needs a chart), then each tab
// gets its own independently-generated, lint-checked, real SQL query — same
// engine as a normal question, just run N times instead of once.
async function planExcelReport(question) {
  // Without an explicit date anchor, the model falls back to a stale year
  // from its training data (verified: it wrote "2023" for "this year" even
  // though generateSQL's own date context — used below per-tab — would have
  // resolved it correctly). Every sqlQuestion must inherit the true today.
  const today = new Date().toISOString().slice(0, 10);
  const thisYear = new Date().getFullYear();
  const lastYear = thisYear - 1;

  const prompt =
    `You are planning a multi-tab Excel report for a SAP Business One analytics request.\n` +
    `User request: "${question}"\n\n` +
    `=== DATE CONTEXT — use these, do not guess a year from memory ===\n` +
    `Today: ${today} | This year: ${thisYear} | Last year: ${lastYear}\n\n` +
    `Decide 2-4 worksheet tabs that together fully answer this. For each tab specify:\n` +
    `- name: short Excel-safe tab name, max 25 characters, no : \\ / ? * [ ] characters\n` +
    `- sqlQuestion: one precise, FULLY SELF-CONTAINED natural-language question describing exactly\n` +
    `  what this tab's data should contain. It will be turned into SQL independently of the other\n` +
    `  tabs and of the original request, so restate the date range/entity explicitly — never say\n` +
    `  "this" or "the same as above". If the original request says "this year"/"this month"/etc,\n` +
    `  write out the actual year/date from the DATE CONTEXT above (e.g. "${thisYear}"), never a\n` +
    `  year from memory or a prior conversation.\n` +
    `- chartType: "line" for a trend over time, "bar" for a ranking/comparison, "none" for a\n` +
    `  detail/pivot table that doesn't need a chart\n\n` +
    `Respond with ONLY raw JSON, no markdown fences, no explanation:\n` +
    `{"tabs":[{"name":"...","sqlQuestion":"...","chartType":"..."}]}`;

  const raw = await callAI([{ role: 'user', content: prompt }], 800);
  const cleaned = raw.trim().replace(/^```[\w]*\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed?.tabs) && parsed.tabs.length) {
      return parsed.tabs.slice(0, 5).map((t, i) => ({
        name: String(t.name || `Tab ${i + 1}`).slice(0, 25).replace(/[:\\/?*[\]]/g, ''),
        sqlQuestion: String(t.sqlQuestion || question),
        chartType: ['line', 'bar', 'pie', 'none'].includes(t.chartType) ? t.chartType : 'none',
      }));
    }
  } catch (e) {
    console.warn(`[Excel Report] plan parse failed, falling back to single tab: ${e.message}`);
  }
  return [{ name: 'Data', sqlQuestion: question, chartType: 'bar' }];
}

// Runs the plan: each tab's SQL is generated, linted, and executed
// independently — one tab failing (bad SQL, no matching data) doesn't sink
// the whole report, it's just dropped and reported back as a failure.
export async function buildMultiTabExcelReport(question) {
  const plan = await planExcelReport(question);
  const intent = classifyIntent(question);
  const dbType = getActiveType();
  const built = [], failed = [];

  for (const tab of plan) {
    try {
      const { sql } = await generateSQL(tab.sqlQuestion, intent, [], null);
      const lintError = lintSql(sql, dbType);
      if (lintError) throw new Error(lintError);
      const rows = await executeSQL(sql);
      built.push({ name: tab.name, rows, chartType: tab.chartType, sql });
    } catch (err) {
      failed.push({ name: tab.name, error: err.message });
    }
  }

  if (!built.length) {
    throw new Error(`Could not build any tab: ${failed.map((f) => `${f.name} (${f.error})`).join('; ')}`);
  }

  const url = await generateMultiTabExcelReport(question, built);
  return { url, built, failed };
}

// ── RESPONSE FORMATTER ──────────────────────────────────────────────────────
function buildMarkdownTable(rows) {
  if (!rows.length) return '';
  const cols     = Object.keys(rows[0]);
  const header   = `| ${cols.join(' | ')} |`;
  const divider  = `| ${cols.map(() => '---').join(' | ')} |`;
  const rowLines = rows.slice(0, 200).map(r =>
    `| ${cols.map(c => {
      const v = r[c];
      if (v === null || v === undefined) return '';
      return String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 120);
    }).join(' | ')} |`
  );
  return [header, divider, ...rowLines].join('\n');
}

function buildResultSummary(rows) {
  if (!rows.length) return 'No rows returned.';
  const cols = Object.keys(rows[0]);
  const preview = rows.slice(0, 3).map(r =>
    cols.map(c => `${c}=${r[c]}`).join(', ')
  ).join(' | ');
  return `${rows.length} rows. Columns: [${cols.join(', ')}]. Preview: ${preview}`;
}

// "Summary"-style wording ("give me an overview", "summarize sales", "at a
// glance"...) means the user wants the picture, not the rows — the frontend
// opens straight into the Chart + AI Summary tabs instead of the raw table.
function isSummaryStyleQuestion(question) {
  return /\b(summary|summarize|summarise|overview|insight|snapshot|at a glance|highlight|recap|chart|graph|plot|trend|analysis|analyse|analyze|visuali[sz]e)\b/i.test(question || "");
}

function formatResponse(question, rows, sql, presentation = null) {
  const dbLabel = getActiveType()?.toUpperCase() || 'DB';

  if (!rows.length) {
    return (
      `**No data found** for: *${question}*\n\n` +
      `The query returned 0 rows. Try:\n` +
      `- Checking the date range (e.g. "last year" vs "this year")\n` +
      `- Verifying filters (status, warehouse, etc.)\n` +
      `- Rephrasing the question\n\n` +
      `**SQL used:**\n\`\`\`sql\n${sql}\n\`\`\``
    );
  }

  // presentation comes from the AI's own read of the question (set alongside
  // the generated SQL) — only missing on a cache/template hit, where no AI
  // call ran this turn, so fall back to the keyword heuristic.
  const displayMode = presentation || (isSummaryStyleQuestion(question) ? "chart" : "table");

  // Emit structured block — frontend renders rich tabbed analytics card
  // rowCount = true total from DB; rows = up to 2000 sent to client
  const MAX_ROWS = 2000;
  const payload = { rows: rows.slice(0, MAX_ROWS), sql, source: dbLabel, rowCount: rows.length, question, displayMode };
  // Real computed stats (total/avg/max/min/trend) from the actual rows —
  // shown on screen right under the card, same as the DB Direct fast path.
  const insight = buildProfessionalInsight(question, rows);
  return `__ATBL__${JSON.stringify(payload)}__/ATBL__\n\n${insight}`;
}

// â”€â”€ MAIN V2 HANDLER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
/**
 * handleV2Chat â€” called from chat-server.mjs when engine === 'v2'
 * @param {object} body  â€” req.body: { message, sessionId, v2History }
 * @param {object} res   â€” Express response object
 */
export async function handleV2Chat(body, res) {
  const { message, sessionId, v2History = [] } = body;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const emit = (obj) => { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch {} };

  if (!USE_AI) {
    emit({ type: 'error', message: 'Analytics V2 requires an AI API key. Set ANTHROPIC_API_KEY or Azure credentials in .env' });
    return res.end();
  }
  if (!isConnected()) {
    emit({ type: 'error', message: 'No database connected. Go to Settings -> DB Connection and connect to HANA/MSSQL first.' });
    return res.end();
  }

  try {
    const cfg    = getActiveConfig();
    const schema = cfg?.schema_name || cfg?.database || 'DB';
    const dbType = getActiveType()?.toUpperCase() || 'DB';

    // Stage 1: Classify
    emit({ type: 'step', id: 'read', icon: 'read', text: 'Reading your question...', status: 'active' });
    const intent = classifyIntent(message);
    const LABELS = {
      sales: 'Sales & Revenue', purchasing: 'Purchasing & Vendors',
      inventory: 'Inventory & Stock', finance: 'Finance & Accounting',
      production: 'Production & Manufacturing', business_partner: 'Business Partners',
      service: 'Service Management', cost_centre: 'Cost Centres',
      crm: 'CRM & Activities', hr: 'HR & Employees',
      price: 'Pricing', banking: 'Banking', fixed_assets: 'Fixed Assets',
      general: 'General Analytics',
    };
    console.log('[V2] intent="' + intent + '" | "' + message.slice(0, 80) + '"');
    emit({ type: 'step', id: 'read', icon: 'brain', text: 'Module identified: ' + (LABELS[intent] || intent), status: 'done' });

    // Cache check \u2014 identical (company + question) within the TTL skips the LLM
    // call and the DB round-trip entirely and answers instantly.
    const cacheKey = schema + '::' + normQuestion(message);
    const cached = v2History.length === 0 ? sqlCacheRepo.get(cacheKey, SQL_CACHE_TTL_MS) : null; // skip cache on follow-ups (they depend on conversation context)
    let sql = null, rows = null, lastError = null, presentation = null;

    // Query Template Library \u2014 hand-written SQL for the highest-frequency questions
    // (top sellers, low stock, AR/AP aging, open orders, ...). Skips the LLM entirely
    // when it matches: faster and zero hallucination risk. Skipped on follow-ups,
    // same as the cache, since templates don't carry conversation context.
    const template = v2History.length === 0 ? matchTemplate(message, getActiveType(), cfg) : null;

    if (cached) {
      sql = cached.sql; rows = cached.rows;
      console.log('[V2] cache hit \u2014 ' + rows.length + ' rows');
      emit({ type: 'step', id: 'sql', icon: 'check', text: 'Answered from cache (asked recently)', status: 'done' });
      emit({ type: 'step', id: 'exec', icon: 'check', text: rows.length + ' row' + (rows.length !== 1 ? 's' : '') + ' (cached)', status: 'done' });
    } else if (template) {
      sql = template.sql;
      console.log('[V2] template match \u2014 ' + template.name);
      emit({ type: 'step', id: 'sql', icon: 'check', text: 'Matched known query pattern (' + template.name.replace(/_/g, ' ') + ')', status: 'done' });
      emit({ type: 'step', id: 'exec', icon: 'db', text: 'Querying ' + schema + ' (' + dbType + ')...', status: 'active' });
      try {
        rows = await executeSQL(sql);
        console.log('[V2] rows=' + rows.length);
        emit({ type: 'step', id: 'exec', icon: 'check', text: rows.length + ' row' + (rows.length !== 1 ? 's' : '') + ' retrieved from database', status: 'done' });
        sqlCacheRepo.set(cacheKey, schema, message, sql, rows);
      } catch (err) {
        // Template SQL failing means the schema differs from what we assumed
        // (e.g. custom fields) \u2014 fall back to AI generation rather than erroring out.
        console.warn('[V2] template ' + template.name + ' failed (' + err.message + '), falling back to AI generation');
        sql = null; rows = null;
      }
    }

    if (!cached && !rows) {
      // Stage 2: Generate SQL
      emit({ type: 'step', id: 'sql', icon: 'code', text: 'Generating SQL query with AI...', status: 'active' });

      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          ({ sql, presentation } = await generateSQL(message, intent, v2History, attempt > 1 ? lastError : null));
          const lineCount = sql.split('\n').length;
          console.log('[V2] SQL (' + lineCount + 'L): ' + sql.slice(0, 150));

          // Pre-flight lint \u2014 catches known dialect mistakes before wasting a DB
          // round-trip on SQL that's guaranteed to fail (e.g. DATEADD in HANA).
          const lintError = lintSql(sql, getActiveType());
          if (lintError) throw new Error(lintError);

          emit({ type: 'step', id: 'sql', icon: 'check', text: 'SQL ready \u2014 ' + lineCount + ' line query', status: 'done' });

          // Stage 3: Execute
          emit({ type: 'step', id: 'exec', icon: 'db', text: 'Querying ' + schema + ' (' + dbType + ')...', status: 'active' });
          rows = await executeSQL(sql);
          console.log('[V2] rows=' + rows.length);
          emit({ type: 'step', id: 'exec', icon: 'check', text: rows.length + ' row' + (rows.length !== 1 ? 's' : '') + ' retrieved from database', status: 'done' });
          sqlCacheRepo.set(cacheKey, schema, message, sql, rows);
          break;

        } catch (err) {
          lastError = err.message;
          console.warn('[V2] attempt ' + attempt + ' failed: ' + err.message);
          if (attempt === 1) {
            emit({ type: 'step', id: 'sql', icon: 'retry', text: 'Query error \u2014 auto-correcting...', status: 'retry' });
            emit({ type: 'step', id: 'sql2', icon: 'code', text: 'Regenerating corrected SQL...', status: 'active' });
          } else {
            emit({ type: 'error', message: lastError, sql });
            return res.end();
          }
        }
      }
    }

    // Stage 4: Format
    emit({ type: 'step', id: 'fmt', icon: 'table', text: 'Preparing results...', status: 'active' });
    let reply = formatResponse(message, rows, sql, presentation);
    if (rows.length && isExcelExportRequest(message)) {
      const excelUrl = await generateExcelExport(message, rows);
      reply += `\n\n📥 **[Download Excel (${rows.length} rows)](${excelUrl})**`;
    }
    const summary = buildResultSummary(rows);
    emit({ type: 'step', id: 'fmt', icon: 'check', text: rows.length > 0 ? 'Complete \u2014 ' + rows.length + ' rows ready' : 'Complete \u2014 no data found', status: 'done' });
    emit({ type: 'result', reply, sessionId, v2SQL: sql, v2Summary: summary });

  } catch (err) {
    console.error('[V2] Unexpected error:', err.message);
    emit({ type: 'error', message: err.message });
  }
  res.end();
}
