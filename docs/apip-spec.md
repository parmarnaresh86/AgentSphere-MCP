# AP Invoice Processing (APIP) — module spec / API contract

New main sidebar menu **"AP Invoice Processing"** (own nav-section in `public/index.html`) with sub-menus:
Processing Dashboard · Invoice Queue · Invoice Approval · Approval Stage · Approval Master · Mail Configuration · Settings.

Files (each owned by ONE builder — do not edit the other side's files):
- Backend: `controllers/ap-invoice-processing-agent.mjs` (router factory `createApipRouter(deps)`), `lib/apip-store.mjs` (SQLite tables + repo), `lib/apip-intake.mjs` (folder watcher + multi-mailbox IMAP poller).
- Frontend: `public/ap-invoice-processing.js` (one IIFE, scoped CSS prefix `.apip-`, exposes `window.showApipPanel(view)`).
- Integration (done by lead): menu in index.html, `<script src="/ap-invoice-processing.js">`, `#apip-panel` in hide-lists, router mount in chat-server.mjs.

Mounted at `/api/apip`. Auth header `x-auth-token` (requireAuth sets `req.user` = {id, username, role, ...}).
Router deps: `{ requireAuth, printAuth, getActiveSap, gptChatComplete, azureMessagesCreate, AI_PROVIDER, USE_AI, cacheRepo, getActiveCompanyId, db }`.
All JSON responses `{ ok:true, ... }` or `{ ok:false, error }` with non-2xx status.

## Intake — three modes
1. **Folder**: watch `settings.inputFolder` (poll every `settings.folderPollSec`, default 30). Each new `*.pdf` → copied into app storage `data/apip/files/<id>.pdf`, queue row `source='folder'`. After processing: success → move original file to `settings.processedFolder`; failure → move to `settings.failedFolder` (create folders if missing; on name clash append timestamp).
2. **Mail**: multiple mailbox configs (IMAP). Poll each enabled mailbox every `pollSec`; unseen mails whose subject matches `subjectFilter` regex (blank = any) with PDF attachments → queue rows `source='mail'`, `sourceRef=<mailbox name / from / subject>`; mark seen after enqueue.
3. **Upload**: manual upload from the Invoice Queue UI (`source='upload'`, label "Uploaded Invoice").
If `settings.autoProcess` is true, new queue items are OCR-processed immediately.

## Processing
OCR via `lib/ocr-extract.mjs` (`extractPdfText`, `runVisionExtraction`) with an AP-invoice system prompt → JSON:
`{ vendorName, vendorGstin, vendorCode, invoiceNo, invoiceDate, dueDate, poNumber, currency, subtotal, taxTotal, total, lines:[{description, itemCode, hsn, qty, uom, unitPrice, discountPct, taxPct, taxAmount, lineTotal}] }`.
Then SAP master matching via `lib/ocr-sap-match.mjs` (`matchPartner(sap,{name,code},'cSupplier')`, `matchItem`, `getWarehouses`, `getOpenPOs`) + cacheRepo (tax codes, warehouses, currencies, payment terms) → `mapped` object (SAP-shaped AP invoice draft). Mapping memory: when the user saves a correction (vendor name→CardCode, line description→ItemCode/GL), store it in `apip_mappings` and prefer it next time.
Duplicate check: same vendor + invoiceNo already posted → `processingStatus='duplicate'`.
processingStatus: `pending | processing | processed | failed | duplicate | posted`.
approvalStatus: `NOT_REQUIRED | PENDING | PARTIAL | APPROVED | REJECTED` (PENDING when an applicable template exists and it has been sent for approval; before sending: `DRAFT`).

## Endpoints
Dashboard
- `GET /dashboard` → `{ counts:{total,pending,processing,processed,failed,duplicate,posted}, approval:{pending,partial,approved,rejected}, bySource:{folder,mail,upload}, recent:[queueRow…10], intake:{folderRunning,mailRunning,lastFolderScan,lastMailScan}, daily:[{date,received,posted,failed}…14] }`

Queue
- `GET /queue?status=&search=&tab=queue|sent` → `{ rows:[queueRow] }`; queueRow = `{ id, fileName, receivedAt, source, sourceRef, processingStatus, approvalStatus, error, vendorName, cardCode, invoiceNo, total, currency, sapDocEntry, sapDocNum }`. `tab=sent` = rows already sent for approval.
- `POST /queue/upload` multipart field `files` (multiple PDFs) → `{ rows }`
- `POST /queue/:id/process` → `{ row }` · `POST /queue/process-all` (all pending/failed) → `{ started, count }`
- `DELETE /queue/:id`
- `GET /queue/:id/pdf` (printAuth; `?token=` allowed) → the PDF stream
- `GET /queue/:id/json` → `{ extracted, mapped }` (raw OCR + mapped)
- `POST /queue/:id/send-approval` body `{ templateId? }` → picks first matching template (requestor = current user/role, invoice total ≤ stage threshold rules) → `{ row }`

Invoice form (SAP B1 A/P Invoice)
- `GET /invoice/:id` → `{ row, extracted, mapped, approval:{ templateName, stages:[{no,name,status,approvals:[{user,action,comment,at}]}] } }`
  `mapped` = `{ CardCode, CardName, NumAtCard, DocDate, DocDueDate, TaxDate, DocCurrency, Series, Comments, DocType:'dDocument_Items'|'dDocument_Service', BaseType: 22|20|null (PO / GRPO), BaseEntry, DiscountPercent, lines:[{ ItemCode, ItemDescription, AccountCode, Quantity, UnitPrice, DiscountPercent, TaxCode, WarehouseCode, UoMCode, BaseType, BaseEntry, BaseLine, ocrDescription, matchScore }], totals:{ beforeDiscount, discount, tax, total }, warnings:[string] }`
- `PUT /invoice/:id` body `{ mapped }` → save edits (+ learn mappings) → `{ mapped }`
- `POST /invoice/:id/validate` → `{ issues:[{field,line?,message,severity}] }` (vendor exists, items/GL exist, totals vs OCR total, duplicate NumAtCard)
- `POST /invoice/:id/post` → requires approvalStatus in (APPROVED, NOT_REQUIRED) unless `settings.postWithoutApproval`; POST to SAP `/PurchaseInvoices` (or `/Drafts` with DocObjectCode 'oPurchaseInvoices' when `settings.postAsDraft`); attaches nothing else → `{ docEntry, docNum }`; sets processingStatus=posted.
- Lookups (SAP + cache): `GET /lookups` → `{ taxCodes, warehouses, currencies, paymentTerms, series }`; `GET /vendors?q=`; `GET /items?q=`; `GET /gl-accounts?q=`; `GET /open-docs?cardCode=` → `{ pos:[…], grpos:[…] }` (open PO / GRPO with lines for base-document linking).
- `POST /master-sync` → refreshes cached masters used for mapping (vendors, items, tax codes, warehouses) → `{ synced:{…counts} }`.

Approvals
- `GET /approvals?tab=mine|partial|approved|rejected&search=` → `{ rows:[{ id(queueId), fileName, vendorName, templateName, stageNo, stageCount, stageName, status, approvedCount, requiredCount, progressPct, sapDocNum, date }] }`
- `POST /approvals/:queueId/approve` body `{ comment }` · `POST /approvals/:queueId/reject` body `{ comment }` → `{ row }`. Approver must be in current stage approvers (user id or role). Stage completes when approvals ≥ approvalsRequired → next stage; rejections ≥ rejectorsRequired → REJECTED. All stages done → APPROVED (and auto-post if `settings.autoPostOnApproval`).
- `GET /approval-stages` → flat list of all stages across templates `[{ templateId, templateName, stageNo, name, description, approvalsRequired, rejectorsRequired, maxInvoiceTotal, approvers:[{type:'user'|'role', id, name}] , pendingCount }]`

Approval Master (templates)
- `GET /templates?search=` → `{ rows:[{ id, name, description, stageCount, settingsEnabled, requestorCount, createdAt }] }`
- `GET /templates/:id` → `{ template:{ id, name, description, requestors:[{type,id,name}], additionalSettings:{ enabled, deviationPct, vendorCodes:[string] }, stages:[{ name, description, approvalsRequired, rejectorsRequired, maxInvoiceTotal, approvers:[{type,id,name}] }] } }`
- `POST /templates` · `PUT /templates/:id` (same body as template) · `DELETE /templates/:id`
- `GET /principals` → `{ users:[{id,name}], roles:[{id,name}] }` (from users / roles tables in db.mjs)

Mail configuration (multiple)
- `GET /mail-configs` → `{ rows:[{ id, name, imapHost, imapPort, imapTls, user, folder, subjectFilter, pollSec, enabled, lastCheck, lastError }] }` (password never returned)
- `POST /mail-configs` · `PUT /mail-configs/:id` (password optional on update; stored encrypted using `encryptDbPassword/decryptDbPassword` from db.mjs) · `DELETE /mail-configs/:id` · `POST /mail-configs/:id/test` → `{ ok, message }`

Settings (configuration fields)
- `GET /settings` · `PUT /settings` → `{ settings }` with fields:
  `inputFolder, processedFolder, failedFolder, folderWatchEnabled, folderPollSec, mailEnabled, autoProcess, autoSendApproval, approvalRequired, postWithoutApproval, autoPostOnApproval, postAsDraft, defaultSeries, defaultTaxCode, defaultWarehouse, defaultGlAccount, defaultDocType, priceTolerancePct, totalTolerance, duplicateCheck, ocrEngine ('ai'|'text'), extraFields:[{key,label,type:'text'|'number'|'date'|'select',options?, sapField (e.g. U_xxx), required}]`
- `GET /intake/status` · `POST /intake/start` · `POST /intake/stop` · `POST /intake/scan-now` · `GET /logs` → `{ logs:[{ts,level,msg}] }` (ring buffer 200)

Folder paths are validated server-side (exists or creatable; reject if input == processed/failed).
