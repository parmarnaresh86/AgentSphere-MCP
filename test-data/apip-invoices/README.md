# AP Invoice Processing — test invoices (STTL_SD)

Dummy supplier invoices for testing **AP Invoice Processing** against the STTL_SD company.
Vendors, PO numbers, item codes, prices and tax codes are taken from open documents in STTL_SD.
Each document has a footer saying it is a sample for testing.

The data was checked against SAP on **12 Nov 2026**. If someone receives, invoices or closes these POs and GRPOs in SAP, the expected results below will change.

## How to load

Upload the files one at a time from **AP Invoice Processing → Invoice Queue**, or email them to the configured AP mailbox.
Do **not** copy them all into the watched folder (`C:\Invoice\IN`) unless you want all ten imported at once.

## Expected results

| File | Vendor (SAP) | Invoice no. | What it tests | Expected outcome |
|---|---|---|---|---|
| 01-1worldsync-grpo-match.pdf | 1World Sync (V00001) | 187338 | 3-way match through the GRPO | Linked to **GRPO 14431**, whose vendor ref is 187338. Bag S-1306: 50 × $9.80 = **$490.00**. No warnings. |
| 02-1worldsync-po-10846.pdf | 1World Sync (V00001) | 1WS-2026-4471 | Clean match to a PO | Linked to open **PO 10846**. BG1000099999EA0EN03: 5 × $200 = **$1,000.00**. |
| 03-216digital-po-10852-taxed.pdf | 216digital, Inc. (V00706) | 216D-11872 | Multi-line PO with sales tax | Linked to **PO 10852**, both lines. 15% tax on line 2. Total **$89.00**, the same as the PO total. |
| 04-216digital-po-10844-price-variance.pdf | 216digital, Inc. (V00706) | 216D-11890 | Price outside tolerance | Linked to **PO 10844**. Warning: line 1 is **$110 vs the PO's $100** (+10%, over the 5% tolerance). Total $339.50. |
| 05-unilever-po-10837-qty-over.pdf | Unilever Asia Private Limited (V00784) | UAPL/SG/26/90412 | Quantity over the open PO quantity | Linked to **PO 10837**. Warning: **700 cases invoiced vs 655 open**. Total $11,760.00. |
| 06-allen-lund-freight-service.pdf | Allen Lund Company, LLC (V00904) | ALC-5530721 | Service / freight bill, no PO | Detected as a **service** invoice. Lines need a G/L account (set one up under Vendor Expense G/L). Total $5,820.00. |
| 07-att-mobility-wireless-bill.pdf | AT&T Mobility (V00038) | 287301445219X11102026 | Utility / expense bill with tax | **Service** invoice, three lines, NJ tax 6.625%. Total $1,487.42. |
| 08-unknown-vendor-office-supplies.pdf | *not in SAP* | BOS-24518 | Unknown vendor | Warning: **vendor not matched**. Select a supplier manually, or reject the invoice. Total $842.87. |
| 09-duplicate-of-01.pdf | 1World Sync (V00001) | 187338 | Duplicate detection | Marked **duplicate** once #01 has been posted, or is already in the queue. Posting is blocked. |
| 10-unilever-po-10836-scanned.jpg | Unilever Asia Private Limited (V00784) | UAPL/SG/26/90377 | Photo / scan (JPG), not a PDF | OCR reads the image. Linked to **PO 10836**: 1,500 cases × $16.80 = **$25,200.00**. |

## Notes

- **Posting creates real A/P invoices in STTL_SD.** Use a test company, or cancel the invoices afterwards, if you don't want them in this database.
- After #01 or #02 has been posted, uploading the same file again shows the duplicate warning. That is expected.
- The vendor email addresses and registration numbers that SAP doesn't hold, such as Unilever's, are made up and use `.example` domains.
