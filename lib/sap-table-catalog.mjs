// Curated master list of standard SAP B1 transaction/master-data tables,
// grouped by module — the "which tables matter" half of the schema dictionary.
// scanTablesSchema() (db-connector.mjs) supplies the other half at sync time:
// each table's REAL live column names, since those drift by SAP B1 version/
// localization and must never be hand-typed (see the OWOR/ItemName incident).
//
// One row per physical table. A table used by more than one module (e.g.
// OCRD, OITM) is listed once under its primary module — the label still
// applies wherever else it's joined from.
export const SAP_TABLE_CATALOG = [
  // ── Sales ──────────────────────────────────────────────────────────────
  { module: "Sales", table: "OQUT", label: "Sales Quotation Header" },
  { module: "Sales", table: "QUT1", label: "Sales Quotation Lines" },
  { module: "Sales", table: "ORDR", label: "Sales Order Header" },
  { module: "Sales", table: "RDR1", label: "Sales Order Lines" },
  { module: "Sales", table: "ODLN", label: "Delivery Header" },
  { module: "Sales", table: "DLN1", label: "Delivery Lines" },
  { module: "Sales", table: "OINV", label: "AR Invoice Header" },
  { module: "Sales", table: "INV1", label: "AR Invoice Lines" },
  { module: "Sales", table: "ORIN", label: "AR Credit Memo Header" },
  { module: "Sales", table: "RIN1", label: "AR Credit Memo Lines" },
  { module: "Sales", table: "ODPI", label: "Down Payment Invoice Header" },

  // ── Purchasing ─────────────────────────────────────────────────────────
  { module: "Purchasing", table: "OPQT", label: "Purchase Quotation Header" },
  { module: "Purchasing", table: "PQT1", label: "Purchase Quotation Lines" },
  { module: "Purchasing", table: "OPOR", label: "Purchase Order Header" },
  { module: "Purchasing", table: "POR1", label: "Purchase Order Lines" },
  { module: "Purchasing", table: "OPDN", label: "Goods Receipt PO Header" },
  { module: "Purchasing", table: "PDN1", label: "Goods Receipt PO Lines" },
  { module: "Purchasing", table: "OPCH", label: "AP Invoice Header" },
  { module: "Purchasing", table: "PCH1", label: "AP Invoice Lines" },
  { module: "Purchasing", table: "ORPD", label: "Goods Return Header" },
  { module: "Purchasing", table: "RPD1", label: "Goods Return Lines" },
  { module: "Purchasing", table: "ODPO", label: "Down Payment (Purchase) Header" },
  { module: "Purchasing", table: "OPIG", label: "Purchase Invoice (Reserve) Header" },
  { module: "Purchasing", table: "PIG1", label: "Purchase Invoice (Reserve) Lines" },

  // ── Inventory ──────────────────────────────────────────────────────────
  { module: "Inventory", table: "OITM", label: "Item Master" },
  { module: "Inventory", table: "OITW", label: "Item Warehouse Stock" },
  { module: "Inventory", table: "OWHS", label: "Warehouses" },
  { module: "Inventory", table: "OBPL", label: "Branches (Business Places)" },
  { module: "Inventory", table: "OITB", label: "Item Groups" },
  { module: "Inventory", table: "OBTN", label: "Batch Numbers" },
  { module: "Inventory", table: "OSRN", label: "Serial Numbers" },
  { module: "Inventory", table: "OIGE", label: "Goods Issue Header" },
  { module: "Inventory", table: "IGE1", label: "Goods Issue Lines" },
  { module: "Inventory", table: "OIGN", label: "Goods Receipt Header" },
  { module: "Inventory", table: "IGN1", label: "Goods Receipt Lines" },
  { module: "Inventory", table: "OWTR", label: "Inventory Transfer Header" },
  { module: "Inventory", table: "WTR1", label: "Inventory Transfer Lines" },
  { module: "Inventory", table: "OWTQ", label: "Inventory Transfer Request Header" },
  { module: "Inventory", table: "WTQ1", label: "Inventory Transfer Request Lines" },

  // ── Pricing ────────────────────────────────────────────────────────────
  { module: "Pricing", table: "OPLN", label: "Price Lists" },
  { module: "Pricing", table: "ITM1", label: "Item Price per Price List" },
  { module: "Pricing", table: "OSPP", label: "Special Prices for Business Partner" },

  // ── Production ─────────────────────────────────────────────────────────
  { module: "Production", table: "OWOR", label: "Production Order Header" },
  { module: "Production", table: "WOR1", label: "Production Order Lines (components)" },
  { module: "Production", table: "OITT", label: "Bill of Materials Header" },
  { module: "Production", table: "ITT1", label: "BOM Component Lines" },
  { module: "Production", table: "ORSC", label: "Resource Master" },
  { module: "Production", table: "RSC1", label: "Resource-Warehouse Link" },

  // ── Finance / Banking ──────────────────────────────────────────────────
  { module: "Finance", table: "OJDT", label: "Journal Entry Header" },
  { module: "Finance", table: "JDT1", label: "Journal Entry Lines" },
  { module: "Finance", table: "OACT", label: "Chart of Accounts" },
  { module: "Finance", table: "ORCT", label: "Incoming Payments Header" },
  { module: "Finance", table: "RCT2", label: "Incoming Payments — Invoices Paid" },
  { module: "Finance", table: "OVPM", label: "Outgoing Payments Header" },
  { module: "Finance", table: "VPM2", label: "Outgoing Payments — Invoices Paid" },
  { module: "Finance", table: "ODPS", label: "Deposits Header" },
  { module: "Finance", table: "OVTG", label: "Tax Groups" },
  { module: "Finance", table: "ORTT", label: "Exchange Rates" },
  { module: "Finance", table: "OFPR", label: "Posting Periods" },
  { module: "Finance", table: "OCSH", label: "Cash Register / Petty Cash" },

  // ── Cost Centres / Dimensions ──────────────────────────────────────────
  { module: "Cost Centres", table: "OPRC", label: "Cost Centres (Profit Centres)" },
  { module: "Cost Centres", table: "OOCR", label: "Distribution Rules" },
  { module: "Cost Centres", table: "ODIM", label: "Cost-Centre Dimensions" },

  // ── Fixed Assets ───────────────────────────────────────────────────────
  { module: "Fixed Assets", table: "OASN", label: "Fixed Asset Master" },
  { module: "Fixed Assets", table: "OACS", label: "Fixed Asset Classes" },
  { module: "Fixed Assets", table: "OACI", label: "Fixed Asset Depreciation Areas" },
  { module: "Fixed Assets", table: "OADP", label: "Fixed Asset Depreciation Posting" },

  // ── Business Partners ──────────────────────────────────────────────────
  { module: "Business Partners", table: "OCRD", label: "Business Partner Master" },
  { module: "Business Partners", table: "CRD1", label: "BP Addresses" },
  { module: "Business Partners", table: "CRD7", label: "BP Bank Accounts" },
  { module: "Business Partners", table: "OCRG", label: "BP Groups" },
  { module: "Business Partners", table: "OCPR", label: "BP Contact Persons" },
  { module: "Business Partners", table: "OCTG", label: "Payment Terms Groups" },
  { module: "Business Partners", table: "OSLP", label: "Sales Employees" },
  { module: "Business Partners", table: "OTER", label: "Territories" },

  // ── Service ────────────────────────────────────────────────────────────
  { module: "Service", table: "OSCL", label: "Service Call Header" },
  { module: "Service", table: "OCSC", label: "Service Contract Header" },
  { module: "Service", table: "OSCE", label: "Equipment Card" },

  // ── CRM ────────────────────────────────────────────────────────────────
  { module: "CRM", table: "OCLG", label: "Activities" },
  { module: "CRM", table: "OCAM", label: "Sales Opportunities" },

  // ── HR ─────────────────────────────────────────────────────────────────
  { module: "HR", table: "OHEM", label: "Employee Master" },
  { module: "HR", table: "OHED", label: "Employee Departments" },
  { module: "HR", table: "OHTP", label: "Employee Positions" },
  { module: "HR", table: "OHAT", label: "Employee Attendance Types" },
  { module: "HR", table: "OHST", label: "Employee Absence Reasons" },
];
