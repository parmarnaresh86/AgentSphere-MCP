/**
 * company-context.mjs
 *
 * Central loader for all company-specific metadata stored in SQLite.
 * Returns structured context objects consumed by DB Direct SQL generation
 * and the main AI system prompt.
 */

import { connRepo, schemaRepo } from './db.mjs';

// ── SAP B1 Complete Schema ────────────────────────────────────────────────────
export const BASE_SCHEMA = `
SAP Business One — Complete Table Reference (HANA & SQL Server)

══════════════════════════════════════════════════════════════
 SALES MODULE
══════════════════════════════════════════════════════════════

OQUT  Sales Quotation Header
  DocEntry(PK int), DocNum(int), CardCode(→OCRD), CardName, SlpCode(→OSLP),
  DocDate(date), DocDueDate(date), TaxDate(date), DocTotal(num), GrossProfit(num),
  DocCur, DocRate(num), DocStatus('O'Open/'C'Closed/'W'Cancelled), Cancelled('tNO'/'tYES'),
  Comments, NumAtCard, PayTermsGrpCode(→OCTG), VatSum(num), DiscPrcnt(num),
  TrnspCode(→OSHP), ShipToCode, BPLId(int), BPLName

QUT1  Sales Quotation Lines
  DocEntry(→OQUT), LineNum, ItemCode(→OITM), Dscription, Quantity(num), Price(num),
  LineTotal(num), GrssProfit(num), DiscPrcnt(num), TaxCode, WhsCode(→OWHS),
  CogsOcrCod(cost-centre dim1), CogsOcrCo2(dim2), CogsOcrCo3(dim3), CogsOcrCo4(dim4), CogsOcrCo5(dim5),
  PriceAfVAT(num), VatSum(num), UomEntry(int), unitMsr, ShipDate(date)

ORDR  Sales Order Header
  DocEntry(PK int), DocNum, CardCode(→OCRD), CardName, SlpCode(→OSLP),
  DocDate(date), DocDueDate(date), TaxDate(date), DocTotal(num), GrossProfit(num),
  DocCur, DocRate(num), DocStatus('O'/'C'/'W'), Cancelled('tNO'/'tYES'),
  Comments, NumAtCard, PayTermsGrpCode(→OCTG), VatSum(num), DiscPrcnt(num),
  TrnspCode(→OSHP), ShipToCode, BPLId(int), BPLName, PickStatus

RDR1  Sales Order Lines
  DocEntry(→ORDR), LineNum, ItemCode(→OITM), Dscription, Quantity(num), OpenQty(num),
  Price(num), LineTotal(num), GrssProfit(num), DiscPrcnt(num), TaxCode, WhsCode(→OWHS),
  CogsOcrCod, CogsOcrCo2, CogsOcrCo3, CogsOcrCo4, CogsOcrCo5,
  unitMsr, UomEntry(int), ShipDate(date)

ODLN  Delivery Header
  DocEntry(PK int), DocNum, CardCode(→OCRD), CardName, SlpCode(→OSLP),
  DocDate(date), DocDueDate(date), DocTotal(num), DocStatus('O'/'C'/'W'), Cancelled('tNO'/'tYES'),
  Comments, TrnspCode(→OSHP), ShipToCode, BPLId(int)

DLN1  Delivery Lines
  DocEntry(→ODLN), LineNum, ItemCode(→OITM), Dscription, Quantity(num),
  Price(num), LineTotal(num), WhsCode(→OWHS),
  CogsOcrCod, CogsOcrCo2, CogsOcrCo3, CogsOcrCo4, CogsOcrCo5,
  BatchNum, SerialNum

OINV  AR Invoice Header (Accounts Receivable)
  DocEntry(PK int), DocNum, CardCode(→OCRD), CardName, SlpCode(→OSLP),
  DocDate(date), DocDueDate(date), TaxDate(date), DocTotal(num), GrossProfit(num),
  PaidToDate(num), DocCur, DocRate(num), DocStatus('O'/'C'/'W'), Cancelled('tNO'/'tYES'),
  Comments, NumAtCard, PayTermsGrpCode(→OCTG), VatSum(num), DiscPrcnt(num),
  ShipToCode, TrnspCode(→OSHP), BPLId(int), BPLName, JrnlMemo

INV1  AR Invoice Lines
  DocEntry(→OINV), LineNum, ItemCode(→OITM), Dscription, Quantity(num),
  Price(num), LineTotal(num), GrssProfit(num), DiscPrcnt(num), TaxCode, WhsCode(→OWHS),
  CogsOcrCod(cost-centre dim1), CogsOcrCo2(dim2), CogsOcrCo3(dim3), CogsOcrCo4(dim4), CogsOcrCo5(dim5),
  PriceAfVAT(num), VatSum(num), UomEntry(int), unitMsr, BatchNum, SerialNum

ORIN  AR Credit Memo Header (Return/Credit Note)
  DocEntry(PK int), DocNum, CardCode(→OCRD), CardName, SlpCode(→OSLP),
  DocDate(date), DocDueDate(date), DocTotal(num), GrossProfit(num),
  DocStatus('O'/'C'/'W'), Cancelled('tNO'/'tYES'),
  Comments, VatSum(num), PayTermsGrpCode(→OCTG), BPLId(int)

RIN1  AR Credit Memo Lines
  DocEntry(→ORIN), LineNum, ItemCode(→OITM), Dscription, Quantity(num),
  Price(num), LineTotal(num), GrssProfit(num), WhsCode(→OWHS),
  CogsOcrCod, CogsOcrCo2, CogsOcrCo3, CogsOcrCo4, CogsOcrCo5

══════════════════════════════════════════════════════════════
 PURCHASING MODULE
══════════════════════════════════════════════════════════════

OPQT  Purchase Quotation Header
  DocEntry(PK int), DocNum, CardCode(→OCRD), CardName,
  DocDate(date), DocDueDate(date), DocTotal(num), DocStatus('O'/'C'/'W'),
  Comments, NumAtCard, BPLId(int)

PQT1  Purchase Quotation Lines
  DocEntry(→OPQT), LineNum, ItemCode(→OITM), Dscription,
  Quantity(num), Price(num), LineTotal(num), WhsCode(→OWHS)

OPOR  Purchase Order Header
  DocEntry(PK int), DocNum, CardCode(→OCRD), CardName,
  DocDate(date), DocDueDate(date), TaxDate(date), DocTotal(num), GrossProfit(num),
  DocStatus('O'/'C'/'W'), Cancelled('tNO'/'tYES'),
  Comments, NumAtCard, PayTermsGrpCode(→OCTG), VatSum(num), DiscPrcnt(num),
  ShipToCode, BPLId(int)

POR1  Purchase Order Lines
  DocEntry(→OPOR), LineNum, ItemCode(→OITM), Dscription,
  Quantity(num), OpenQty(num), Price(num), LineTotal(num), WhsCode(→OWHS),
  TaxCode, DiscPrcnt(num),
  CogsOcrCod, CogsOcrCo2, CogsOcrCo3, CogsOcrCo4, CogsOcrCo5

OPDN  Goods Receipt PO Header (GRPO)
  DocEntry(PK int), DocNum, CardCode(→OCRD), CardName,
  DocDate(date), DocDueDate(date), DocTotal(num),
  DocStatus('O'/'C'/'W'), Cancelled('tNO'/'tYES'),
  Comments, NumAtCard, BPLId(int)

PDN1  Goods Receipt PO Lines (GRPO Lines)
  DocEntry(→OPDN), LineNum, ItemCode(→OITM), Dscription,
  Quantity(num), Price(num), LineTotal(num), WhsCode(→OWHS),
  CogsOcrCod, CogsOcrCo2, CogsOcrCo3, CogsOcrCo4, CogsOcrCo5,
  BatchNum, SerialNum

OPCH  AP Invoice Header (Accounts Payable)
  DocEntry(PK int), DocNum, CardCode(→OCRD), CardName,
  DocDate(date), DocDueDate(date), TaxDate(date), DocTotal(num), GrossProfit(num),
  PaidToDate(num), DocCur, DocRate(num), DocStatus('O'/'C'/'W'), Cancelled('tNO'/'tYES'),
  Comments, NumAtCard, PayTermsGrpCode(→OCTG), VatSum(num), DiscPrcnt(num), BPLId(int)

PCH1  AP Invoice Lines
  DocEntry(→OPCH), LineNum, ItemCode(→OITM), Dscription,
  Quantity(num), Price(num), LineTotal(num), GrssProfit(num), WhsCode(→OWHS),
  TaxCode, DiscPrcnt(num),
  CogsOcrCod, CogsOcrCo2, CogsOcrCo3, CogsOcrCo4, CogsOcrCo5

ORPD  AP Credit Memo Header
  DocEntry(PK int), DocNum, CardCode(→OCRD), CardName,
  DocDate(date), DocTotal(num), DocStatus('O'/'C'/'W'), Cancelled('tNO'/'tYES'),
  Comments, BPLId(int)

RPD1  AP Credit Memo Lines
  DocEntry(→ORPD), LineNum, ItemCode(→OITM), Dscription,
  Quantity(num), Price(num), LineTotal(num), WhsCode(→OWHS)

OIGE  Goods Issue Header
  DocEntry(PK int), DocNum, DocDate(date), DocTotal(num),
  DocStatus('O'/'C'/'W'), Cancelled('tNO'/'tYES'), Comments, BPLId(int)

IGE1  Goods Issue Lines
  DocEntry(→OIGE), LineNum, ItemCode(→OITM), Dscription,
  Quantity(num), Price(num), LineTotal(num), WhsCode(→OWHS),
  CogsOcrCod, CogsOcrCo2, CogsOcrCo3, CogsOcrCo4, CogsOcrCo5

OIGN  Goods Receipt Header (non-PO)
  DocEntry(PK int), DocNum, DocDate(date), DocTotal(num),
  DocStatus('O'/'C'/'W'), Cancelled('tNO'/'tYES'), Comments, BPLId(int)

IGN1  Goods Receipt Lines
  DocEntry(→OIGN), LineNum, ItemCode(→OITM), Dscription,
  Quantity(num), Price(num), LineTotal(num), WhsCode(→OWHS)

OWTQ  Inventory Transfer Request Header
  DocEntry(PK int), DocNum, DocDate(date), DocDueDate(date),
  DocStatus('O'/'C'/'W'), Comments, ToWhsCode

WTQ1  Inventory Transfer Request Lines
  DocEntry(→OWTQ), LineNum, ItemCode(→OITM), Dscription,
  Quantity(num), Price(num), FromWhsCode, ToWhsCode

OWTR  Inventory Transfer Header
  DocEntry(PK int), DocNum, DocDate(date), FromWhsCode, ToWhsCode,
  DocStatus('O'/'C'/'W'), Cancelled('tNO'/'tYES'), Comments

WTR1  Inventory Transfer Lines
  DocEntry(→OWTR), LineNum, ItemCode(→OITM), Dscription,
  Quantity(num), Price(num), LineTotal(num), FromWhsCode, ToWhsCode,
  BatchNum, SerialNum

══════════════════════════════════════════════════════════════
 INVENTORY MODULE
══════════════════════════════════════════════════════════════

OITM  Item Master
  ItemCode(PK), ItemName, FrgnName, ItmsGrpCod(→OITB),
  InvntItem('tYES'/'tNO'), SellItem('tYES'/'tNO'), PrchseItem('tYES'/'tNO'),
  OnHand(num), IsCommited(num), OnOrder(num),
  LastPurPrc(num), AvgPrice(num), StdPrice(num), ListNum(→OPLN),
  ManBtchNum('tYES'/'tNO'), ManSerNum('tYES'/'tNO'),
  SWeight1(num), BuyUnitMsr, SalUnitMsr, NumInSale(num), NumInBuy(num),
  InvntryUom, BuyUomEntry(int), SalUomEntry(int), InvntUomEntry(int),
  Locked('tYES'/'tNO'), Canceled('tYES'/'tNO'), SupplierCode(→OCRD),
  QryGroup1..QryGroup64 (varchar — custom classification/property fields),
  U_fields (any UDF columns defined by company)

OITW  Item Warehouse Stock
  ItemCode(→OITM), WhsCode(→OWHS), OnHand(num), IsCommited(num), OnOrder(num),
  MinStock(num), MaxStock(num), ReorderQty(num), LeadTime(int)

OWHS  Warehouse Master
  WhsCode(PK), WhsName, Street, Block, ZipCode, City, County, Country,
  Phone1, Phone2, Fax, ManagerCode(→OUSR), Inactive('tYES'/'tNO')

OITB  Item Group Master
  ItmsGrpCod(PK int), ItmsGrpNam, PricLstObj(→OPLN),
  InvntryAct, RevenueAct, ExpensAct, CogsAct

OBTN  Batch Number Master
  ItemCode(→OITM), DistNumber, MnfSerial, LotNumber,
  ExpDate(date), MnfDate(date), InDate(date), WhsCode(→OWHS),
  Quantity(num), Status('A'Active/'U'Used), Remarks

OSRN  Serial Number Master
  ItemCode(→OITM), DistNumber, MnfSerial, LotNumber,
  ExpDate(date), MnfDate(date), InDate(date), WhsCode(→OWHS), Status

OPLN  Price List Header
  ListNum(PK int), ListName, BsedOn(int), Factor(num),
  Currency, RoundDec(int), ValidFrom(date), ValidTo(date)

ITM1  Item Price per Price List
  ItemCode(→OITM), PriceList(int→OPLN), Price(num), Currency, AutoUpdt

OSPP  Special Prices (BP-specific overrides)
  CardCode(→OCRD), ItemCode(→OITM), ListNum(→OPLN),
  Price(num), Discount(num), FromDate(date), ToDate(date)

OSTA  Stock Audit Trail
  AbsEntry(int), ItemCode(→OITM), WhsCode(→OWHS), DocDate(date),
  TransType(int), DocEntry(int), DocNum(int), InQty(num), OutQty(num),
  Price(num), CalcPrice(num)

══════════════════════════════════════════════════════════════
 PRODUCTION MODULE
══════════════════════════════════════════════════════════════

OWOR  Production Order Header
  DocEntry(PK int), DocNum, ItemCode(→OITM), ItemName,
  PlannedQty(num), CmpltQty(num), RjctQty(num), ScrapQty(num),
  Status('P'Planned/'R'Released/'C'Closed/'X'Cancelled),
  DueDate(date), StartDate(date), ClosingDate(date),
  Warehouse(→OWHS), OriginNum, OriginAbs, Comments, JrnlMemo,
  Type('S'Standard/'D'Disassembly/'S'Special)

WOR1  Production Order Components
  DocEntry(→OWOR), LineNum, ItemCode(→OITM), Dscription,
  PlannedQty(num), IssuedQty(num), BaseQty(num),
  WhsCode(→OWHS), IssueType('B'Backflush/'M'Manual)

OITT  Bill of Materials Header
  Code(PK), Dscription, Type('S'Sales/'P'Production/'T'Template/'A'Assembly),
  Quantity(num), Project

ITT1  Bill of Materials Components
  Code(→OITT), LineNum, ItemCode(→OITM), Dscription,
  Quantity(num), WhsCode, Price(num), PriceList(int→OPLN)

ORSC  Resource Master
  ResCode(PK), ResName, ResType('L'Labor/'M'Machine/'O'Other),
  Capacity(num), UnitOfMeasure, Cost(num), Active('tYES'/'tNO')

══════════════════════════════════════════════════════════════
 FINANCE MODULE
══════════════════════════════════════════════════════════════

OJDT  Journal Entry Header
  TransId(PK int), TransType(int), RefDate(date), TaxDate(date), DueDate(date),
  Memo, Ref1, Ref2, Ref3, CreatedBy(→OUSR), DataSource, TransCode,
  SystemRate(num), Indicator, BaseRef, BatchNum(int), StornoToTr(int), AutoStorno('Y'/'N')
  TransType: -2=Opening Bal, -3=Period-end Closing, 13=AR Inv, 14=AR CM, 15=Delivery,
             16=Sales Return, 18=AP Inv, 19=AP CM, 20=GRPO, 21=Goods Return,
             24=Incoming Pmt, 25=Deposit, 30=Journal Entry, 46=Outgoing Pmt,
             59=Goods Receipt, 60=Goods Issue, 67=Inv Transfer, 69=Landed Cost,
             162=Inv Revaluation, 202=Production Order

JDT1  Journal Entry Lines (the General Ledger — source for P&L, Balance Sheet, Trial Balance)
  TransId(→OJDT), Line_ID(int), Account(→OACT), ShortName(BP CardCode on BP lines, else = Account),
  Debit(num), Credit(num), SYSDeb(num), SYSCred(num),
  FCDebit(num), FCCredit(num), FCCurrency,
  RefDate(date = posting date), DueDate(date), TaxDate(date), TransType(int), BaseRef,
  LineMemo, ContraAct(→OACT), ProfitCode(→OPRC dim1), OcrCode2(dim2), OcrCode3(dim3),
  OcrCode4(dim4), OcrCode5(dim5), Project, BPLId(→OBPL branch),
  BalDueDeb(num), BalDueCred(num)

OACT  Chart of Accounts
  AcctCode(PK), AcctName, FormatCode, GroupMask(int drawer: typically 1 Assets, 2 Liabilities,
  3 Equity, 4 Revenue, 5 Cost of Sales, 6 Operating Exp, 7 Non-operating/Financing, 8 Other/Tax),
  Levels(int, 1 = drawer title), FatherNum(→OACT parent), Postable('Y' account/'N' title),
  ActType('I'Income/'E'Expenditure/'N'Other), Finanse('Y' = cash/bank account),
  LocManTran('Y' = control account), Frozen('Y'/'N'),
  CurrTotal(num, all-time balance — not for periods)

OBGS  Budget Scenario
  AbsId(PK int), Name, FinancYear(date)

OBGT  Budget per Account (annual)
  AcctCode(→OACT), Instance(→OBGS.AbsId), FinancYear(date), DebLTotal(num), CredLTotal(num)

BGT1  Budget per Account per Month
  AcctCode(→OACT), Instance(→OBGS.AbsId), Line_ID(int month 0-11 of FY), DebLTotal(num), CredLTotal(num)

OFPR  Posting Periods (fiscal calendar)
  AbsEntry(PK int), Code, Name, F_RefDate(date), T_RefDate(date), Category(fiscal year), PeriodStat

ORCT  Incoming Payment Header
  DocEntry(PK int), DocNum, CardCode(→OCRD), CardName,
  DocDate(date), DueDate(date), DocTotal(num), TrsfrSum(num),
  CashSum(num), CheckSum(num), CreditSum(num),
  DocCur, DocRate(num), Comments, BankCode, BnkAccount,
  DocStatus('O'/'C'), Cancelled('tNO'/'tYES')

RCT2  Incoming Payment — Applied Invoices
  DocNum(→ORCT), DocEntry(int), InvType(int), SumApplied(num),
  AppliedFC(num), InstlmntId(int)

OVPM  Outgoing Payment Header
  DocEntry(PK int), DocNum, CardCode(→OCRD), CardName,
  DocDate(date), DueDate(date), DocTotal(num), TrsfrSum(num),
  CashSum(num), CheckSum(num), DocCur, Comments,
  BankCode, BnkAccount, DocStatus('O'/'C'), Cancelled('tNO'/'tYES')

VPM2  Outgoing Payment — Applied Invoices
  DocNum(→OVPM), DocEntry(int), InvType(int), SumApplied(num)

ODPS  Deposit Header
  DepNum(PK int), DepDate(date), DepTotal(num),
  BankCode, BnkAccount, Comments, Canceled('tNO'/'tYES')

OBST  Bank Statement Header
  AbsEntry(PK int), BankCode, AcctCode, StmtDate(date),
  OpenBalance(num), FinalBalance(num)

BST1  Bank Statement Lines
  AbsEntry(→OBST), LineNum, TransDate(date), Credit(num), Debit(num),
  Ref1, Ref2, Ref3, Memo

══════════════════════════════════════════════════════════════
 BUSINESS PARTNERS MODULE
══════════════════════════════════════════════════════════════

OCRD  Business Partner Master
  CardCode(PK), CardName, CardType('C'Customer/'S'Supplier/'L'Lead),
  GroupCode(→OCRG), Phone1, Phone2, Fax, E_Mail, CntctPrsn,
  Balance(num), CreditLine(num), Discount(num),
  SlpCode(→OSLP), Territory(→OTER), Currency, PayTermsGrpCode(→OCTG),
  VatStatus, Country, City, ZipCode, Block, Building, StreetNo, Street,
  Cellular, Website, AliasName, VatIdUnCmp, TaxOffice, Industry(int),
  Frozen('tYES'/'tNO'), Valid('tYES'/'tNO'), CreateDate(date), UpdateDate(date),
  U_fields (company UDF columns)

CRD1  BP Addresses
  CardCode(→OCRD), AdresType('S'Ship/'B'Bill), Address,
  Street, Block, Building, ZipCode, City, County, Country,
  Phone1, Phone2, Fax, RowNum(int)

CRD7  BP Bank Accounts
  CardCode(→OCRD), BankCode, Account, Branch, Country, Currency, ManualEntry

OCRG  BP Group Master
  GroupCode(PK int), GroupName, GroupType('C'Customer/'S'Supplier/'L'Lead),
  PriceLst(int→OPLN)

OCPR  BP Contact Persons
  CntctCode(PK int), CardCode(→OCRD), Name, FirstName, LastName,
  Position, Remarks, Phone1, Phone2, Cellular, Fax, E_Mail,
  Active('Y'/'N'), BirthDate(date), Title

OCTG  Payment Terms
  GroupNum(PK int), PymntGroup, PriceMode(int),
  CashDiscPrct(num), ExtraMonth(int), ExtraDay(int),
  DueDateCode, NumberOfInstallments(int)

══════════════════════════════════════════════════════════════
 SALESPERSONS & TERRITORIES
══════════════════════════════════════════════════════════════

OSLP  Salesperson Master
  SlpCode(PK int), SlpName, Commission(num),
  Phone, Fax, Email, Mobile, Memo, Active('Y'/'N')

OTER  Territory Master
  TerritoryID(PK int), Descript, ParentID(int)

══════════════════════════════════════════════════════════════
 SERVICE MODULE
══════════════════════════════════════════════════════════════

OSCL  Service Call Header
  CallID(PK int), CustCode(→OCRD), CustName, CreateDate(date),
  CloseDate(date), Subject, Remark, Status(int), CallType(int),
  Priority(int), Origin(int), Engineer(→OUSR), ItemCode(→OITM),
  SerialNum, Contract(→OCSC), Problem, Cause, Resolution, BPLId(int)

OCSC  Service Contract Header
  ContractID(PK int), CustCode(→OCRD), CustName, ContractType(int),
  Status, StartDate(date), EndDate(date), Remarks, SigningDate(date)

OSCE  Equipment Card
  InsID(PK int), ItemCode(→OITM), ItemName, CardCode(→OCRD),
  SerialNum, DelivDate(date), WarntExpir(date), Status(int),
  Manufacturer, BrandName

══════════════════════════════════════════════════════════════
 HR MODULE
══════════════════════════════════════════════════════════════

OHEM  Employee Master
  empID(PK int), lastName, firstName, middleName,
  Department(→OHED), Position(→OHTP), Manager(→OHEM), BranchID(int),
  HomePhone, WorkPhone, OfficeExt, CellPhone, Fax, Email,
  StartDate(date), StatusCode, TerminationDate(date), U_fields

OHED  Department Master
  Code(PK int), Name

OHTP  Position (Job Title) Master
  Code(PK int), Name

OHAT  Employee Attendance
  EmpID(→OHEM), Date(date), StartTime, EndTime,
  BreakTime(num), TotalHrs(num), Status

══════════════════════════════════════════════════════════════
 CRM / ACTIVITIES
══════════════════════════════════════════════════════════════

OCLG  CRM Activity Log
  ClgCode(PK int), CntctCode(→OCPR), CardCode(→OCRD),
  Action(int), ClgDate(date), ClgTime, Recontact(date),
  Duration(num), DurType, Details, Notes, Closed('Y'/'N'),
  AssignedTo(→OUSR), Priority(int), ActivityType(int), Subject

OCAM  Marketing Campaign Header
  AbsEntry(PK int), CampaignNum, CampaignName,
  CampaignType(int), Status(int), StartDate(date), EndDate(date),
  Budget(num), Remarks

══════════════════════════════════════════════════════════════
 COST CENTRES & PROFIT CENTRES
══════════════════════════════════════════════════════════════

OPRC  Profit/Cost Centre Master
  PrcCode(PK), PrcName, DimCode(int→ODIM),
  ValidFrom(date), ValidTo(date), Active('Y'/'N'), GroupCode

OOCR  Distribution Rule (Allocation Key)
  OcrCode(PK), OcrName, DimCode(int→ODIM),
  InWhichDim(int), Active('Y'/'N'), BeginDate(date), EndDate(date)

ODIM  Dimension Master
  DimCode(PK int), DimName, Active('Y'/'N'), Mandatory('Y'/'N')

Note: On document LINES (INV1, RDR1, POR1, PCH1, etc.)
  CogsOcrCod = dimension 1 cost-centre code (maps to OOCR.OcrCode where DimCode=1)
  CogsOcrCo2 = dimension 2 cost-centre code
  CogsOcrCo3 = dimension 3 cost-centre code
  CogsOcrCo4 = dimension 4 cost-centre code
  CogsOcrCo5 = dimension 5 cost-centre code

══════════════════════════════════════════════════════════════
 SYSTEM / MASTER DATA
══════════════════════════════════════════════════════════════

OUSR  User Master
  USERID(PK int), USER_CODE, USER_NAME, E_Mail,
  Department, Branch, Mobile, Locked('Y'/'N')

NNM1  Document Number Series
  ObjectCode, SeriesName, InitialNum(int), LastNum(int),
  NextNumber(int), Prefix, Suffix, Locked('Y'/'N'), IsManual('Y'/'N')

OVTG  Tax Code (VAT) Master
  Code(PK), Name, Type, Rate(num), Account(→OACT),
  IsAcquisition, Country

OCUR  Currency Master
  CurrCode(PK), CurrName, CurrSymbol, IntCurrCode

ORTT  Exchange Rate
  Currency(→OCUR), RateDate(date), Rate(num)

OUVT  Unit of Measure Master
  UomEntry(PK int), UomCode, UomName, BaseUom(int), Factor(num)

OSHP  Shipping Types
  TrnspCode(PK int), TrnspName

CUFD  User Defined Fields Registry
  TableID (SAP table name e.g. 'OINV'), Name (field name starting with U_),
  AliasID, Descr (description), Type('C'Char/'N'Numeric/'D'Date/'L'Link),
  Size(int — char length), ValidValues (comma-separated if enum),
  DefaultVal, EditSize(int), Mandatory('Y'/'N')

══════════════════════════════════════════════════════════════
 KEY JOINS & RELATIONSHIPS
══════════════════════════════════════════════════════════════

  Document header→lines:   T0.DocEntry = T1.DocEntry
  Header→Business Partner: T0.CardCode = OCRD.CardCode
  Lines→Item:              T1.ItemCode = OITM.ItemCode
  Lines→Warehouse:         T1.WhsCode  = OWHS.WhsCode
  Header→Salesperson:      T0.SlpCode  = OSLP.SlpCode
  Lines→Cost-centre dim1:  T1.CogsOcrCod = OOCR.OcrCode
  JDT1→Account:            JDT1.Account  = OACT.AcctCode
  BP→Group:                OCRD.GroupCode = OCRG.GroupCode
  BP→Payment Terms:        OCRD.PayTermsGrpCode = OCTG.GroupNum
  Stock→Item+Warehouse:    OITW.ItemCode = OITM.ItemCode AND OITW.WhsCode = OWHS.WhsCode
  Batch→Item:              OBTN.ItemCode = OITM.ItemCode

STATUS CODES:
  DocStatus:    'O'=Open  'C'=Closed  'W'=Cancelled
  Cancelled:    'tNO'=Active  'tYES'=Cancelled
  CardType:     'C'=Customer  'S'=Supplier  'L'=Lead
  InvntItem etc:'tYES'=Yes  'tNO'=No
  OWOR.Status:  'P'=Planned  'R'=Released  'C'=Closed  'X'=Cancelled
`;

// ── Dimension column → friendly name mapping ──────────────────────────────────
const DEFAULT_DIM_MAP = {
  CogsOcrCod: 'Brand',
  CogsOcrCo2: 'SubBrand',
  CogsOcrCo3: 'Budget',
  CogsOcrCo4: 'Universe',
  CogsOcrCo5: 'CogsCustomer',
};

// ── In-memory cache ───────────────────────────────────────────────────────────
const _cache    = new Map();   // company → { ctx, expiresAt }
const CACHE_TTL = 60_000;      // 1 minute

export function invalidateCache(company) {
  if (company) _cache.delete(company);
  else _cache.clear();
}

// ── Main loader ───────────────────────────────────────────────────────────────
/**
 * Load all company-specific context from SQLite.
 * Returns a structured object — see typedef below.
 *
 * @param {string} [company] — company DB name; defaults to active connection
 * @returns {CompanyContext}
 */
export function loadCompanyContext(company) {
  const conn    = company ? connRepo.getByCompany(company) : connRepo.getActive();
  const companyName = company || conn?.company || '';

  // Cache hit
  const cached = _cache.get(companyName);
  if (cached && Date.now() < cached.expiresAt) return cached.ctx;

  // ── Connection-level data ─────────────────────────────────────────────────
  const schemaHint = conn?.schema_hint || '';

  // Parse dim_names: "CogsOcrCod=Brand,CogsOcrCo2=SubBrand,..."
  const dimMap = { ...DEFAULT_DIM_MAP };
  if (conn?.dim_names) {
    for (const pair of conn.dim_names.split(',')) {
      const [col, label] = pair.split('=');
      if (col && label) dimMap[col.trim()] = label.trim();
    }
  }

  // ── Schema Registry ───────────────────────────────────────────────────────
  const registryRows = companyName
    ? schemaRepo.listByCompany.all(companyName)
    : [];

  const udfs    = registryRows.filter(r => r.type === 'udf');
  const tables  = registryRows.filter(r => r.type === 'table');
  const views   = registryRows.filter(r => r.type === 'view');
  const queries = registryRows.filter(r => r.type === 'query');

  const ctx = {
    company:    companyName,
    schemaHint,
    dimMap,
    udfs,
    tables,
    views,
    queries,
    allEntries: registryRows,
  };

  _cache.set(companyName, { ctx, expiresAt: Date.now() + CACHE_TTL });
  return ctx;
}

// ── Prompt builders ───────────────────────────────────────────────────────────

/**
 * Build the dimension alias block for SQL prompts.
 */
export function buildDimBlock(ctx) {
  const lines = Object.entries(ctx.dimMap).map(([col, label]) =>
    `  Real column: "${col}"  →  alias AS "${label}"`
  );
  return lines.length
    ? 'Cost-centre dimension columns (use REAL column name, alias for display):\n' +
      lines.join('\n') +
      '\nIMPORTANT: Never use the alias name as a column reference.'
    : '';
}

/**
 * Build the schema registry block for SQL prompts.
 */
export function buildRegistryBlock(ctx) {
  const sections = [];

  if (ctx.udfs.length) {
    // Group UDFs by table for compact display
    const byTable = {};
    for (const e of ctx.udfs) {
      const t = e.table_name || 'Unknown';
      if (!byTable[t]) byTable[t] = [];
      byTable[t].push(`${e.name}(${e.definition || '?'}${e.description ? ' — '+e.description : ''})`);
    }
    const lines = Object.entries(byTable).map(([t, fs]) => `  ${t}: ${fs.join(', ')}`);
    sections.push('UDF Fields (User-Defined Fields):\n' + lines.join('\n'));
  }

  if (ctx.tables.length) {
    // Auto-synced standard SAP B1 tables (sync-tables) can carry 200-400+
    // columns — most of that tail is localization/audit noise (EDoc*, NFe*,
    // GST*, U_* custom fields for modules this company doesn't use). Sending
    // the full list on every prompt bloats tokens and can crowd out the
    // fields that actually matter, so cap what's shown here; the full list
    // still lives in the registry (UI/API) for reference.
    const MAX_COLS_SHOWN = 60;
    sections.push('Custom / Object Tables — use the SQL TABLE NAME in FROM/JOIN, never the label:\n' +
      ctx.tables.map(e => {
        const cols = e.definition ? e.definition.split(',') : [];
        const shown = cols.length > MAX_COLS_SHOWN
          ? cols.slice(0, MAX_COLS_SHOWN).join(',') + `,...(+${cols.length - MAX_COLS_SHOWN} more columns not shown — mostly localization/audit fields)`
          : e.definition;
        return `  SQL TABLE NAME: ${e.table_name || e.name}  (label: ${e.name})` +
          (shown         ? `\n    Columns: ${shown}` : '') +
          (e.description ? `\n    Purpose: ${e.description}` : '');
      }).join('\n'));
  }

  if (ctx.views.length) {
    sections.push('Custom Views:\n' +
      ctx.views.map(e =>
        `  View: ${e.name}` +
        (e.definition  ? `\n    Definition: ${e.definition}` : '') +
        (e.description ? `\n    Purpose: ${e.description}` : '')
      ).join('\n'));
  }

  if (ctx.queries.length) {
    sections.push('Saved / Reference Queries:\n' +
      ctx.queries.map(e =>
        `  Query: ${e.name}` +
        (e.description ? ` — ${e.description}` : '') +
        (e.definition  ? `\n    SQL: ${e.definition}` : '')
      ).join('\n'));
  }

  return sections.length
    ? `Company Schema Registry (${ctx.company}):\n` + sections.join('\n\n')
    : '';
}

/**
 * Build the full company-specific extras string injected into DB Direct SQL prompts.
 */
export function buildSqlContext(company) {
  const ctx = loadCompanyContext(company);
  return [
    ctx.schemaHint,
    buildDimBlock(ctx),
    buildRegistryBlock(ctx),
  ].filter(Boolean).join('\n\n');
}

/**
 * Build a compact summary for the main AI system prompt.
 */
export function buildAiSummary(company) {
  const ctx = loadCompanyContext(company);
  if (!ctx.company) return '';

  const lines = [`Company: ${ctx.company}`];

  const dimLines = Object.entries(ctx.dimMap)
    .map(([col, label]) => `${col}=${label}`)
    .join(', ');
  if (dimLines) lines.push(`Dimensions: ${dimLines}`);

  if (ctx.udfs.length) {
    lines.push(`UDF Fields (${ctx.udfs.length}): ` +
      ctx.udfs.map(u => `${u.table_name ? u.table_name+'.' : ''}${u.name}`).join(', '));
  }
  if (ctx.tables.length)  lines.push(`Custom Tables: ${ctx.tables.map(t=>t.name).join(', ')}`);
  if (ctx.views.length)   lines.push(`Custom Views: ${ctx.views.map(v=>v.name).join(', ')}`);
  if (ctx.queries.length) lines.push(`Saved Queries: ${ctx.queries.map(q=>q.name).join(', ')}`);

  return '### Company Context\n' + lines.map(l => `- ${l}`).join('\n');
}

/**
 * Get just the dimension map for the active (or named) company.
 */
export function getDimMap(company) {
  return loadCompanyContext(company).dimMap;
}
