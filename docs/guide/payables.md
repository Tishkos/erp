# Payables — user guide

Payables (الذمم الدائنة) is where everything the company buys and owes to suppliers is entered, approved, paid and checked. It has three menu headings: Purchasing & Invoices (المشتريات والفواتير), Supplier Payments & Credits (مدفوعات الموردين وأرصدتهم الدائنة) and Supplier Balances (أرصدة الموردين).
Work flows in this order: a supplier is entered and approved (Suppliers); the supplier's invoice is entered as a Purchase Invoice — ticking "Import" opens an Import Application behind it, which also creates its Purchase Order; the invoice is sent for approval and posted.
Money is then asked of the bank with a Payment Application, whose confirmation creates a Supplier Payment (or a Supplier Advance when no invoice is posted yet). Goods that go back are a Purchase Return; price corrections are Supplier Credit / Debit Notes.
Expenses (rent, freight, brokerage) are purchase invoices raised with "Add expense"; Recurring Contracts raise the rent-type invoices period by period.
The balance screens (Supplier Credits, Supplier Statements, Payables Ageing, Supplier Reconciliation) only read what those documents posted — nothing is typed there.

## Concepts — Payables

### The four icons at the top of a record — Payables
Every purchase-side record page (purchase invoice, import application, purchase order, goods receipt, purchase return, supplier payment, payment application, supplier advance, recurring contract, supplier credit note) carries four small icons in its title bar:
- **Printer — Print / Export** (طباعة / تصدير). Opens a small window with the copies you may take, once in English and once in Arabic (العربية): **PDF**, **Excel (.xlsx)**, **Word (.docx)**. You only see the formats your role may take; if it may take none, the printer icon is not shown.
- **Paperclip — Attachments** (المرفقات). Shows the files kept on the record (with who added each). To add one: click the paperclip, **Choose a file** (اختر ملفاً), then **Attach** (إرفاق). Up to 25 MB; programs and archives are refused by their content. The file picker is shown only to users allowed to attach files. On the import application the paperclip is labelled **Attachments & history** (المرفقات والسجل).
- **Notes** (الملاحظات). A table of When (متى) / Who (من) / Note (ملاحظة), newest first, and a box with the button **Add note** (إضافة ملاحظة). A note is dated and signed and can never be edited or deleted. At most 2,000 characters. On a purchase invoice and on an import application anyone who can view the record may add a note; on the other records the box is shown only to users allowed to change that kind of record.
- **Clock — Audit log** (سجل التدقيق). Who did what to this record and when. Read-only.
Needs: printer — `view` plus `print` (PDF) or `export` (Excel, Word) on the record's object; paperclip — `create` on `attachment` plus `view` on the record's object (on an import application: `edit_draft` on `payable`); notes — `view` on `ap_invoice` for a purchase invoice, `view` on `payable` for an import application, `create` on `supplier_credit_memo` for a supplier credit note, `edit_draft` on the record's object for the others. The clock is shown to everyone who can open the record.

### Messages after an action — Payables
After a button is pressed the page comes back with either a green "Saved." (تم الحفظ) or a red box titled "That could not be saved." (تعذّر الحفظ) — on some payables screens "That did not save" (لم يتم الحفظ) — followed by the system's reason in a sentence. The reason is always shown in English. If the sentence starts "Permission denied: '…' on '…' is not granted to this user." your role lacks that permission; "Out of scope: this user has no access to branch '…'." means the record belongs to a branch you are not assigned to.

### Statuses of purchase documents — Payables
Most purchase documents use the same status words: Draft (مسودة) → Pending approval (بانتظار الموافقة) → Approved (معتمد) → Posted (مرحّل). After posting: Posted — partly paid (مُرحَّلة — مدفوعة جزئيًا), Settled (مسوّى), Reversed (معكوس), Cancelled (ملغى), Rejected (مرفوض), Closed (مغلق). A posted document is never edited: it is reversed with a reason and entered again.

### Approval by a second person — Payables
Several documents may not be approved by the person who prepared them: a payment application, a supplier advance, a supplier credit note, a recurring contract, a service confirmation, a supplier's bank account. The Super User is the one exception written into these rules — a Super User may approve alone (on the payment application, supplier advance and bank account pages the Approve / Verify button is nevertheless hidden from whoever prepared the record). A purchase return only needs the approve permission; the system does not compare the approver with the person who raised it. A purchase invoice is different: whoever presses **Approve and post** needs both the approve and the post permission for purchase invoices; the system does not compare that person with the one who entered the invoice.

### Money, currency and dates — Payables
The books are kept in Iraqi dinars (IQD). An invoice typed in another currency (for example USD) is converted at the exchange rate in force on the invoice date (Currencies and Rates); the invoice and its journal are in dinars, while the import application keeps the agreed currency, which is what the bank is asked to pay. A posting dated in a closed period is refused.

### Supplier must be approved — Payables
Only a supplier whose status is Active and who is in use is offered in the supplier pickers on these screens. A supplier entered by somebody without approval rights is a "Prospect" until it is approved on its profile (see Suppliers).

## Import Applications (معاملات الاستيراد)
Path: Transfers & Applications → Transfers & Applications → Import Applications   |   Arabic: التحويلات والطلبات ← التحويلات والطلبات ← معاملات الاستيراد
Address: /payables (one application: /payables/<application number>)
Needs: `view` on `payable` to open the list and a record. Creating needs `create` on `payable` (and `create` on `ap_invoice` for the invoice form).
What it is for: One record per import — from the supplier's invoice to the warehouse. The list shows every open import with its stage, what is paid, how many containers are in, and whether it is stopped. The record page is the one place where the payments, the customs PD, the shipment, the landed cost and the quantities of an import are read side by side.

### How to read the list — Import Applications
Needs: `view` on `payable`.
1. Open Transfers & Applications → Import Applications (its own module in the top bar since 2026-10-06, beside Payables). The list shows up to 50 rows and has no page buttons — use the search and the filters to narrow it. It is sorted for attention: applications stopped with no reason first, then the oldest stop, then the nearest due date.
2. Use the search box (Search this list — ابحث في هذه القائمة) to find by application number, supplier reference (PO / INV number) or description.
3. Use the filters and press **Filter** (تصفية): **Views** (العروض) — All open, Stopped — reason required, Stopped, Imports, Rent & contracts; **Type** (النوع) — empty means All types (كل الأنواع), the list opens on Import application; **Stopped?** (متوقف؟) — Stopped (متوقف), Reason required (السبب مطلوب), Moving (يتقدم), or All rows (كل الصفوف).
4. Columns: **No.** (الرقم) — click it to open the record; **Type** (النوع); **PO / INV no.** (رقم الطلب / الفاتورة) — the supplier's reference; **Supplier** (المورد); **Amount** (المبلغ) in the import's currency; **Paid** (المدفوع) — what confirmed payment applications have paid, with **Remaining** (المتبقي) under it once something is paid; **Stage** (المرحلة) — stage number, name and days in that stage; **Containers** (الحاويات) — "X of Y" received; **Stopped?** (متوقف؟) — red "Reason required", or the stop's reason code and days, or "Moving"; **Due** (الاستحقاق) — "—" with "Set once the SWIFT is received" (يُحدَّد عند استلام السويفت) until the balance's due date is set (see "How to set the due date for the balance — Import Applications"); **Branch** (الفرع).
5. Cancelled applications are not listed.

### How to create an import application — Import Applications
Needs: `create` on `payable` (for the button), `create` on `ap_invoice`, `edit_draft` on `payable`, and `create` and `submit` on `purchase_order`.
There is no separate form: an import application is opened by its purchase invoice.
1. On the list press **Enter supplier invoice** (إدخال فاتورة مورد). The New invoice page of Purchase Invoices opens.
2. Fill the invoice (see "How to enter a purchase invoice — Purchase Invoices"). Leave **Import** (استيراد) ticked and leave **Import application** (معاملة الاستيراد) on "New — opened by this invoice" (جديدة — تفتحها هذه الفاتورة).
3. Press **Create** (إنشاء). The system saves the invoice as a draft, opens the import application behind it with the invoice's lines, and creates a purchase order from those lines and sends it for approval.
4. To attach the invoice to an import that already exists (for example one migrated from the old sheet), choose that import in **Import application** instead of "New".

### How to read a supplier's document into a draft — Import Applications
Needs: `create` on `payable` (for the button), `create` on `ap_invoice`, `edit_draft` on `payable`, and `create` and `submit` on `purchase_order`.
1. On the list press **Read a document** (اقرأ مستنداً).
2. **Choose the document** (اختر المستند): the invoice the factory sent — PDF, Excel, Word, CSV or text, in any language.
3. Press **Read it** (اقرأها). The system reads the supplier, the goods and the prices into a draft purchase invoice marked as an import, keeps the file attached to it, and opens that invoice. Anything it was unsure of is written into the draft's note — check the draft before sending it for approval.

### How to open a record and what it shows — Import Applications
Needs: `view` on `payable`. The PD section also needs `view` on `customs_pd`; Shipment & containers and Quantities by model need `view` on `shipment_container`; Landed cost needs `view` on `landed_cost`; the loans table needs `view` on `bank_loan`.
1. Click the number in the **No.** column. The record opens with the application number as its title.
2. Header fields: **No.** (الرقم); **Stage** (المرحلة) with days in the stage; **Type** (النوع); **Supplier** (المورد) — a link to the supplier's profile; **Supplier reference** (مرجع المورد); **Rate applied** (سعر الصرف المطبّق) — only for an import in a foreign currency, the rate its dinars were worked out at; **Amount** (المبلغ) — in the agreed currency and in dinars; **Document date** (تاريخ المستند); **Due date** (تاريخ الاستحقاق) — "—" with "Set once the SWIFT is received" until the balance's due date is set, then the date with "Set by <name> on <date>" (حدّده … في …) under it; **Branch** (الفرع); **Quantity** (الكمية) — total units in base units; **Payment terms** (شروط الدفع); **Stage** rail — one chip per stage; **Description** (الوصف).
3. The lines table **Order & invoice** (الطلب والفاتورة): #, Item (المادة), Description (الوصف), Qty (الكمية), Unit price (سعر الوحدة), Amount (المبلغ). At the foot: Amount, **Paid** (المدفوع), **Remaining** (المتبقي).
4. Above the document, once the advance is paid and the balance has no due date: the due-date banner (see "How to set the due date for the balance — Import Applications"). Below the document, in this order: red stop banners (if any); **The goods’ journey** (رحلة البضاعة — see "The goods’ journey — Import Applications"); **Purchase invoices** (فواتير الشراء) of this import; then four sections side by side — **Payments** (المدفوعات), **PD / ASYCUDA** (التصريح المسبق / أسيكودا), **Shipment & containers** (الشحن والحاويات), **Landed cost** (الكلفة الواصلة); then **Quantities by model** (الكميات حسب الموديل); then the **Status log** (سجل الحالة).
5. A section is shown only if your role may view that kind of record (customs PDs, shipment containers, landed cost, bank loans).
5a. **Each of the four sections has its own paperclip** in its title (since 2026-10-06): the Payments section keeps the bank's SWIFT copies and remittance advices, PD / ASYCUDA the broker's letters and the ASYCUDA printouts, Shipment & containers the packing lists and shipping line papers, Landed cost the freight and clearance bills — separate from the import's own paperclip in the title bar, so a paper is found in the section it belongs to. Press the paperclip to see that section's files and to add one (needs `create` on `attachment`). The PD, B/L and container pages keep their own paperclips as well; the Logistics document registers (Customs documents, Shipping documents) list the PD / ASYCUDA and Shipment & containers sections' papers as the import's.
5b. **The related records' files come back to their section's paperclip** (since 2026-10-07): under the section's own files, **From related records** (من السجلات المرتبطة) lists, grouped by the record each file is kept on (its kind, its number as a link, how many files): **Payments** — the import's payment applications (their files and their papers, each marked Sent to the bank / Paid / Rejected / cancelled / Other), the supplier advances and supplier payments; **PD / ASYCUDA** — its PDs, the ASYCUDA readings that read them, its customs declarations; **Shipment & containers** — its B/Ls and containers; **Landed cost** — the invoices and journals its charges came from. The import's own paperclip in the title bar adds its purchase invoices' files and its goods returns'. The paperclip's number counts them all. Nothing is copied: a file put on a payment application is on the import the next time the page opens; it is opened from where it is kept, and a record your role may not open shows none of its files. Uploading through a section's paperclip still files under that section.
5c. **Blocks or List** (كتل / قائمة) at the end of the **From related records** title: Blocks shows a card per record side by side; List shows one row per file — Source (المصدر), File (الملف), Uploaded by (رفعه), Uploaded at (رُفع في), Size (الحجم). The choice is yours, kept in this browser for your user, and every paperclip on every import follows it; it starts on Blocks.
6. The header fields cannot be edited on this page: there is no button to change the payment terms or the description. They come from the invoice that opened the import. The due date is set once, through the dialog that asks for it when the advance is paid (see "How to set the due date for the balance — Import Applications").
7. The **Purchase invoices** table lists Invoice no. (رقم الفاتورة — click to open the invoice), Supplier invoice no. (رقم فاتورة المورد), Date (التاريخ), Total (IQD) (الإجمالي (د.ع)), Settled (IQD) (المسدد (د.ع)) and Status (الحالة).

### The goods’ journey — Import Applications
Needs: `view` on `payable`. The B/L, Containers, Clearance and Received steps also need `view` on `bill_of_lading` and `shipment_container`; Customs (PD) needs `view` on `customs_pd`; Landed cost needs `view` on `landed_cost`. A step your role cannot read is not shown.
Under the document (and any stop banner) the record shows where the goods stand, one step after another — across the page on a computer, down the page on a phone. A done step has a check, its date and the document that did it; the current step is highlighted; the others say **Pending** (قيد الانتظار). The title says how many are done.
1. **On Process (Without SWIFT)** (قيد المعالجة (بدون سويفت)) — only for an import whose invoice agreed a payable amount in front (by percentage or by amount) and whose goods were held for it: the date they were held, the amount in front ("Held for the advance — 20% payable in front"), the invoice. While they wait it says **Waiting for the advance’s payment application to be paid:** with the application's number.
2. **In Process** — with an advance: **Advance paid — goods released**, the date the application was paid and the application; without one this is the first step: **Invoice posted — the goods are in process**, with the invoice.
3. **Bill of lading**, 4. **Containers**, 5. **Customs (PD)** (the PD and its status), 6. **Clearance** ("1 of 2 containers cleared"), 7. **Landed cost** (charges booked, then locked), 8. **Received into <warehouse>** — the warehouses the containers were received into ("1 of 2 containers received"; "Received into the warehouse" while nothing is) — each done when the B/L, container, PD, declaration, lock or receipt exists. A step that happened without a recorded date says **Date not recorded**.
The steps are read from the documents and the status log; nothing on this block can be changed here. The steps do not have to happen in order (a PD can stand before the B/L): the highlighted step is the first one not done yet.

**Where the goods are now** — under the steps. First one line for the whole import: where its goods are, or each place with its count when the containers are split ("In Process · 1 container", "On board · 2 containers", "At port · 1 container", "Received into Main Warehouse · 1 container"). Then each container on its own track: In Process → On board → At port → Customs cleared → Received — the places it has passed filled, its current place ringed, with the date it got there, or its ETA (in red when its status says late). A container's place follows its own status and dates, so it moves as the container's page is updated (On the sea → At port → Cleared → Received). Before any container exists the line says the goods are in On Process (Without SWIFT) or In Process, and **No container on a B/L yet**. Missing and damaged containers are shown as such. The stock itself stays in the In Process warehouse until a container is received: imports do not move stock through On Board / At Port, so this is followed container by container.

**Blocks / List** (كتل / قائمة) — at the top of the record, beside **Stop / follow-up**: how the files that came back to each paperclip from its related records are drawn — cards side by side, or one row after another. One choice per person, remembered in this browser; the same switch is at the end of each paperclip's "From related records" title.

### Stages of an import — Import Applications
The stage is worked out by the system from the documents; nobody sets it by hand. The stage shown is the highest-numbered one whose condition is true, so stages can be skipped (a payment sent before the PD is registered shows "Payment in progress"). On the rail, the current stage is highlighted (tooltip "now" — الآن), a stage whose condition holds reads "this is true of the import now" (هذا صحيح على الاستيراد الآن), the others "not yet" (لم يحدث بعد). Stage names are stored as set up in Payables Settings and are shown in English:
1. **Order confirmed** — the application exists.
2. **Invoiced + funded** — an invoice of the import is posted, and a payment application has been approved or sent (or the import is already fully paid).
3. **PD registered** — at least one live customs PD (not rejected, not expired, not replaced by a re-registration).
4. **Payment in progress** — at least one payment application is sent, paid or debited.
5. **Shipment** — at least one container is recorded on a bill of lading.
6. **Partly received** — some containers received, not all.
7. **All received** — every container received.
8. **Cleared** — the supplier is fully paid and every payment application is confirmed; every container is received and nothing the invoices bought is left in transit; every PD is totally written off. When this becomes true the application is closed automatically and the log says "cleared". If one of the conditions later stops being true (an invoice reversed, a quantity corrected) the application is re-opened automatically and the log says why.
Clicking a stage chip jumps to the section that answers for it (Payments, PD, Shipment or Landed cost). Each stage change is written to the Status log and sent as a notification.

### Lanes and the status log — Import Applications
Needs: `view` on `payable` (also enough to add a note).
A lane is one line of work on an import; each event in the log is filed under a lane. The lanes shown are: Payable (الذمة), Order (الطلب), Bank (المصرف), Payment (الدفع), PD (التصريح), Shipment (الشحن), Warehouse (المخزن), Cost (الكلفة), Stop (التوقف). The lanes run independently: an import can be paid while its goods are still at sea.
1. Scroll to **Status log** (سجل الحالة). Columns: Date (التاريخ), Lane (المسار), What happened (ما الذي حدث) with the document number in brackets, Who (من) — "system" (النظام) when the system wrote it.
2. To see one lane only choose it in **Lane** (المسار) — empty is All lanes (كل المسارات) — and press **Filter** (تصفية).
3. To add a note type it in **Add a note** (إضافة ملاحظة) under the log and press **Add note** (إضافة). Anyone who can view the application may add a note, even after it is closed. The same notes are listed behind the notes icon at the top.

### How to stop an import and follow it up — Import Applications
Needs: `edit_draft` on `payable`. The application must not be cancelled or closed.
1. Press **Stop / follow-up** (إيقاف / متابعة) at the top of the record.
2. Fill: **Lane** (المسار) — required, opens on Order; **Reason** (السبب) — required; **Detail** (التفاصيل) — required when the reason is OTHER; **Owner** (المسؤول) — required, the person following it up; **Stopped since** (متوقف منذ) — optional, today if left empty; **Next action** (الإجراء التالي) — required; **Expected by** (متوقع بحلول) — required date.
3. Press **Record the stop** (تسجيل التوقف). A red banner "STOPPED: <reason code>" (متوقف) appears under the document with the detail, since when, the days, and the next action; the list shows the application as stopped; a notification is raised.
4. To report progress open **Update / resolve** (تحديث / حل) inside the banner: **What happened** (ما الذي حدث) — required, optional new **Next action** and **Expected by**; press **Add update** (إضافة تحديث).
5. To end the stop: in the same place type **How it was resolved** (كيف حُل) and press **Resolve** (حل).
Reasons offered (set up in Payables Settings, shown as code — name): PD — PD not validated / expired; FUND — Waiting deposit or loan; DOC — Documents missing at bank; BANK — Bank internal approval; CBI — Platform / K2 compliance review; REJ — Rejected, resubmit; SUP — Supplier bank details / query; CORR — Correspondent bank hold; AMT — Amount mismatch; SHIP — Container delayed at origin/port; CUS — Customs / port file pending; OTHER — Other.

### How to answer "Over time limit — reason required" — Import Applications
Needs: `edit_draft` on `payable`.
The system itself opens a stop when something has waited longer than its time limit (for example a SWIFT not confirmed). The banner then reads **Over time limit — reason required** (تجاوز المهلة — السبب مطلوب) and the list shows **Reason required** (السبب مطلوب). Until it is answered, work in the stopped lane is refused: in the Payment lane no payment application can be created, approved or sent; in the Order lane the order lines cannot be edited and no invoice can be linked.
1. Open the banner's **Complete — reason, owner, next action** (إكمال — السبب والمسؤول والإجراء التالي).
2. Fill **Reason** (required), **Detail**, **Owner** (required), **Next action** (required), **Expected by** (required).
3. Press **Complete the hold** (إكمال الإيقاف). The stop now has a reason and an owner, and the lane can be worked again.

### How to cancel an import application — Import Applications
Needs: `edit_draft` and `reverse_cancel` on `payable`.
1. In the actions row of the document type the reason in **Why it is cancelled** (سبب الإلغاء).
2. Press **Cancel application** (إلغاء الطلب). The record shows a "Cancelled" (ملغاة) banner with the reason and date, becomes read-only and leaves the list.
A cancellation is refused while a posted invoice is linked — reverse the invoice first.

### How to correct the order lines before any invoice — Import Applications
Needs: `edit_draft` on `payable`.
Only on an application that has no invoice linked (for example one migrated from the sheet).
1. Under **Purchase invoices** open **Edit PI lines (supersedes — the old lines stay in the record)** (تعديل بنود الفاتورة الأولية).
2. Up to six rows: Item (المادة) — the item code, Description (الوصف) — a row with no description is ignored, Qty (الكمية), Unit (الوحدة), Unit price (سعر الوحدة).
3. Press **Save lines** (حفظ البنود). The old lines are kept in the history, the new ones replace them and the amount and quantity are recalculated.

### How to pay — the deposit / advance and payment applications — Import Applications
Needs: `create` on `payment_application`; the import must be open.
Paying an import is always a payment application raised from its Payments section.
1. Scroll to **Payments** (المدفوعات). The title shows **Applied** (المطلوب) — sent to the bank, **Paid** (المدفوع) — confirmed by the bank, **Remaining** (المتبقي) — amount owed less paid. Supplier payments made directly against the import's invoices on the Supplier Payments screen count as paid too.
2. Press **New payment application** (طلب دفع جديد). (The same dialog opens when you choose the import under Payment Applications → New payment application.)
3. Fill: **Amount** (المبلغ) — any part of what is owed; left empty the application asks for all that is still unasked; **Method** (الطريقة) — required; **Paid from** (يُدفع من) — required, a bank or cash account in the import's currency, each shown with its available balance; **Supplier bank account** (حساب المورد البنكي) — needed for SWIFT and transfers, the verified account in the import's currency is pre-chosen, unverified ones are marked "not verified" (غير معتمد); **Loan** (القرض) — shown only when a bank loan can fund this currency; **Note** (ملاحظة).
4. Press **Create** (إنشاء). The application opens as a Draft on its own page; continue there (see Payment Applications: approve → send → confirm → record debit).
5. A part payment is normal: 20% with the order, the rest against the bill of lading — raise one application per part.
6. **Deposit before the invoice is posted:** if the application is confirmed while no invoice of the import is posted yet, confirming posts a **supplier advance** (a deposit) against the import's purchase order instead of a supplier payment. When the invoice is later posted the deposit is applied to it automatically.
7. **Payable in advance on the invoice — the goods wait for the advance (since 2026-10-06):** an import's purchase invoice opens with **Payable in advance** on **Payable by percentage** and the % box empty (type any share, or choose **Payable by amount** and type the amount, or **No upfront payment**), **Advance paid from** on the first bank or cash account in the invoice's currency, and **Advance payment method** on the first bank method. When the invoice is **posted**:
   - its goods go to the **On Process (Without SWIFT)** warehouse (قيد المعالجة — بدون سويفت), not In Process; the import's log says so (ADVANCE_HELD), and its Payments section shows "Waiting for the advance: … in On Process (Without SWIFT)";
   - the payment application for the payable amount is raised as a **Draft**, in the import's currency — by percentage the share (a dollar invoice asks for dollars, worked back at the rate on the invoice's face), by amount exactly the amount written — with the supplier's verified bank account in that currency (ADVANCE_RAISED). If the invoice names no account or method, or was typed in dinars against an import in another currency, the log says ADVANCE_NOT_RAISED and the application is raised by hand.
   - The application then goes the ordinary way: **Send for approval** → **Approve** by another person → the papers (see Payment Applications): **Sent to the bank** → waiting for the bank; **Paid** → posted, and the goods move from On Process (Without SWIFT) to **In Process** (ADVANCE_RELEASED) and the import continues like any other; **Rejected / cancelled** → the goods stay in On Process (Without SWIFT) and the log says so — a new application raised by hand and paid releases them.
   - B/Ls can be recorded meanwhile; a container cannot be received while the goods still wait for the advance.
8. Under the applications, **Loans funding this import** (القروض الممولة لهذا الاستيراد) lists each loan draw: Bank (البنك), Payment application (طلب الدفع), Drawn (المسحوب), Commission share (حصة العمولة) — "Capitalised into the funded imports" or "Expensed", Next due (الاستحقاق التالي), with an "Overdue" (متأخر) flag.

### How to set the due date for the balance — Import Applications
Needs: `view` on `payable` to see the question; `edit_draft` on `ap_invoice` to answer it (the grant an invoice's due date asks).
By direction (2026-10-07): an import bought with an advance has no due date until the SWIFT is received — the rest of the payment is agreed then.
1. Until somebody sets it, the import's **Due date** and its invoices' show "—" with "Set once the SWIFT is received" (يُحدَّد عند استلام السويفت) on every screen and copy. Such an invoice is **not overdue**: the payables ageing counts it under **Not yet due**, no due-soon or overdue notification is sent for it, the overdue-exposure finding, the Home lists and the payment run leave it out.
2. Once a payment application of the import is **Paid** (its paid paper — the SWIFT — attached) and an invoice of the import still owes something with no due date, opening the import shows the banner "The advance is paid (PAY-…, date). Set the due date for the balance." with **Set due date** (تحديد تاريخ الاستحقاق), and the dialog **Set the due date for the balance** (تحديد تاريخ استحقاق الرصيد) opens by itself.
3. The dialog says which payment application was paid and when, **Still owed** (المتبقي المستحق), and lists the invoices without a due date (Invoice no., Invoice date, Still owed). Choose the **Due date** (تاريخ الاستحقاق) and press **Save** (حفظ). The date is set on every invoice listed and on the import application.
4. **Later** (لاحقاً) — or the close button — closes it. It does not open by itself again in the same browser tab; it opens again the next time the import is opened in a new tab, until a date is set. The banner's **Set due date** opens it at any time.
5. Somebody who may not set it sees "Waiting for the due date" (بانتظار تاريخ الاستحقاق) in the banner and no button.
6. After saving, the import's **Due date** shows the date with "Set by <name> on <date>" under it, and so does each of its invoices; the date now shows in the registers, the supplier's statement, the ageing and the copies, and counts from then on for due-soon and overdue. The goods' journey shows it on the In Process step. An invoice's own **Set due date** button opens this same dialog.

### How to settle the exchange difference — Import Applications
Needs: `post` on `payment_application`.
For an import agreed in a foreign currency and fully paid in it, a note may appear in Payments: "Fully paid in its currency; in dinars its invoices still owe … and its payments are … over them. That is the exchange difference…". Normally the difference is booked automatically when the last payment is confirmed; the note stays only when the exchange gain and loss accounts were not mapped at that moment.
1. Have the exchange gain and loss mapped on Posting Mappings.
2. Press **Settle exchange difference** (تسوية فرق الصرف). The difference is posted dated today.

### How to register a PD from the import — Import Applications
Needs: `create` on `customs_pd`; the import must be open.
1. In **PD / ASYCUDA** press **Register PD** (تسجيل تصريح). A page of its own opens (since 2026-10-06), with the import already chosen; the PD list's **Register PD** opens the same page with the import to choose.
2. Fill: **PD no.** (رقم التصريح) — required, the ASYCUDA number as customs issued it; **Registered** (تاريخ التسجيل) — required; **Expires** (ينتهي في) — required, as ASYCUDA shows it; **Bank** (البنك) — optional; **Status** (الحالة) — opens on Submitted (مقدَّم); **Note** (ملاحظة).
3. Press **Register PD**. The PD opens on its own page — you are not sent back to the import. On the import it then appears in the section's table: PD no., Bank, Registered, Expires, Days left (الأيام المتبقية), Status, Note. Click the PD number to open it on its own page (Logistics).

### How to record a bill of lading from the import — Import Applications
Needs: `create` on `bill_of_lading`; the import must be open.
1. In **Shipment & containers** press **New B/L** (بوليصة شحن جديدة). A page of its own opens (since 2026-10-06), with the import already chosen and the containers as a table; the Shipments list's **New B/L** opens the same page with the import to choose and the containers as a pasted list.
2. Fill: **B/L no.** (رقم البوليصة) — required; **B/L date** (تاريخ البوليصة) — required; **ETA** (الوصول المتوقع) — required; **Vessel** (السفينة); **Voyage** (الرحلة); **Shipping line** (خط الشحن); **Port of loading** (ميناء التحميل); **Port of discharge** (ميناء التفريغ).
3. In the containers table add one row per container: **Container no.** (رقم الحاوية) — four letters and seven digits, the last digit is checked; **Size / type** (الحجم / النوع); **Seal no.** (رقم الختم); and for each model how many that container carries — leave a model's column empty to divide what is left of it equally. Never more than was ordered.
4. Press **New B/L**. The B/L opens on its own page — you are not sent back to the import. On the import, the B/L and its containers appear in the section (B/L no., B/L date, Vessel, Port of discharge, ETA, Received "X of Y"; and per container: Container no., B/L no., ETA, Status, Warehouse). Containers are received on their own pages (Logistics).

### Landed cost — charges, the lock, and the final cost — Import Applications
The **Landed cost** (الكلفة الواصلة) section — also a sheet of its own since 2026-10-06, under Logistics → Landed Costs → Landed Costs (click the import), with print, attachments, notes and history in its title bar; the section and the sheet show the same thing, and the buttons on each return to the page they were pressed on — collects every cost that belongs to the import besides the goods (freight, customs, port and forwarding, bank commission, loan cost, other) and, when locked, spreads it over the stock the containers brought in. Its title shows the total of charges and the state: "not locked" (غير مقفلة), "N charge(s) waiting for a lock", or "locked" (مقفلة).
- The charges table: **Type** (النوع), **Source** (المصدر) — the document or journal number, **Amount (IQD)** (المبلغ (د.ع)), **State** (الحالة) — Not locked (غير مقفل), Locked · n (مقفل), Withdrawn (مسحوب), **Note** (ملاحظة).
- A charge arrives by itself when an expense is entered with "Belongs to import" naming this import and posted, and with a loan's commission. A cost that was booked by a manual journal is added by hand (below).
- While charges wait for a lock, an **Allocation preview** shows per model: Received (المستلم), On hand (المتوفر), Value (IQD), Allocated (IQD), Unit cost now, Unit cost after.
- After a lock, **Final item cost** (الكلفة النهائية للصنف) shows per model: Received, On hand, Invoiced / unit, Charges / unit, **Final cost / unit**, Value in stock; the button **Final cost (print)** (التكلفة النهائية (طباعة)) prints it.
- The **Locks** table lists each lock: Lock (the first) or Adjustment n, Date, Basis, Total (IQD), Into stock (إلى المخزون), Cost of sales (كلفة المبيعات), Journal (القيد), By (بواسطة).

### How to add a landed-cost charge — Import Applications
Needs: `create` on `landed_cost`.
1. In **Landed cost** press **Add charge** (إضافة عبء).
2. Fill: **Type of cost** (نوع الكلفة) — required: Bank commission (عمولة مصرفية), Loan cost (كلفة قرض), Freight (شحن), Customs / ASYCUDA (جمارك / أسيكودا), Port & forwarding (ميناء وتخليص), Other (أخرى); **Journal no.** (رقم القيد) — required, the number of the posted journal that parked the cost on the clearing account; **Amount (IQD)** (المبلغ (د.ع)) — required, more than zero; **What it is** (ما هو) — required when the type is Other; **Note** (ملاحظة).
3. Press **Add charge**. The charge is listed as "Not locked". If the cost is already locked, the new charge waits for a dated adjustment (the button then reads **Allocate late charges**).

### How to withdraw a landed-cost charge — Import Applications
Needs: `reverse_cancel` on `landed_cost`.
Only a charge added from a journal and not yet locked can be withdrawn.
1. Press **Withdraw a charge** (سحب عبء).
2. Choose the **Charge** (العبء) and type **Why it is withdrawn** (سبب السحب).
3. Press **Withdraw a charge**. The charge stays in the table marked "Withdrawn". A charge that came with an invoice or a loan goes only when that document is reversed.

### How to lock the landed cost — Import Applications
Needs: `post` on `landed_cost`.
The lock buttons appear only when every PD of the import is totally written off, every container is received, and at least one charge is not locked. Until then the section says: "The landed cost is locked once every PD is totally written off and every container is received".
1. Press **Lock landed cost** (إقفال الكلفة الواصلة) — or **Allocate late charges** (توزيع الأعباء المتأخرة) when a lock already exists.
2. Choose **Allocate** (التوزيع): By value (حسب القيمة) — the default, By quantity (حسب الكمية) or Manual (يدوي). By weight (حسب الوزن) and By volume (حسب الحجم) exist in the settings but are switched off, because items carry no weight or volume yet.
3. Set **Date** (التاريخ) — today by default; not in the future, not before the previous lock, not before the day the last container was received.
4. For Manual only: type the amount each model carries; the amounts must add up to the charges.
5. Optional **Note**, then press the button again inside the dialog.
What it does: the charges are spread over the stock the import's containers brought in. The part belonging to stock still on hand raises its unit cost (debit Inventory); the part belonging to stock that already left goes where that stock went — cost of sales for a sale, project material cost for a project issue, and so on; the clearing account is credited with the total. One journal is posted, the charges become "Locked · n", and the lock is written to the status log.

### Quantities by model — Import Applications
Shown once the import has containers. One row per item, in the item's base unit:
- **Model** (الموديل) — item code and name.
- **Ordered** (المطلوب) — what the posted invoices bought.
- **In containers** (في الحاويات) — what the containers on the B/Ls are planned to carry.
- **Received** (المستلم) — what the container receipts moved into the warehouse in good order.
- **Damaged** (التالف) and **Short** (الناقص) — as recorded when containers were received.
- **Claimed** (المُطالَب به) — what was returned to the supplier as a claim (purchase returns against the invoice lines).
- **Still in transit** (ما زال في الطريق) — what the invoice bought that is still in a transit warehouse: not yet received and not yet claimed.
- **Not yet shipped** (لم يُشحن بعد) — ordered less what the containers plan.

### How to claim a shortage — Import Applications
Needs: `create` on `goods_return`; the import must be open.
When every container is in but something the invoice bought is still in transit, a note appears under Quantities by model and the button **Claim the shortage** (المطالبة بالنقص) is offered.
1. Press **Claim the shortage**.
2. Fill **Claim date** (تاريخ المطالبة) — required, today by default; **Supplier's reference** (مرجع المورد) — optional; **What is claimed** (ما المُطالَب به) — required, for example "40 cartons short in MSCU1234566, seal intact; 6 damaged".
3. Press **Claim the shortage**. One purchase return per invoice is created for everything still in transit, out of the transit warehouse, offset against what is owed to the supplier. Each return is then approved and posted on its own page (Purchase Returns); posting it recalculates the import's stage.
If the missing goods will come later instead, add the balance shipment as another container on a B/L.

### Fields — Import Applications
The import application itself is not typed — its header comes from the purchase invoice. These are the fields of the forms on its record page:
- Stop / follow-up — **Lane** (المسار): required, the line of work that is stopped; opens on Order. **Reason** (السبب): required, from the stop-reason list. **Detail** (التفاصيل): free text, required for reason OTHER. **Owner** (المسؤول): required, the user following it up. **Stopped since** (متوقف منذ): optional date, today when empty. **Next action** (الإجراء التالي): required. **Expected by** (متوقع بحلول): required date.
- Update a stop — **What happened** (ما الذي حدث): required; **Next action** and **Expected by**: optional. Resolve a stop — **How it was resolved** (كيف حُل): required.
- New payment application — **Amount** (المبلغ): optional, in the import's currency; empty asks for everything still unasked; never more than what is left. **Method** (الطريقة): required; an active payment method — its kind (SWIFT, transfer, cash, cheque) decides which account type pays, whether a supplier bank account is needed and what the confirm button is called. **Paid from** (يُدفع من): required; an active bank or cash account in the import's currency, shown with its available balance. **Supplier bank account** (حساب المورد البنكي): optional on the form, but required by the bank check for SWIFT and transfers; accounts are added and verified on the supplier's profile. **Loan** (القرض): optional, only shown when a loan can fund this currency. **Note** (ملاحظة): optional.
- Register PD — **PD no.** (رقم التصريح): required. **Registered** (تاريخ التسجيل): required date. **Expires** (ينتهي في): required date, not before Registered. **Bank** (البنك): optional. **Status** (الحالة): opens on Submitted. **Note** (ملاحظة): optional.
- New B/L — **B/L no.** (رقم البوليصة): required, unique. **B/L date** (تاريخ البوليصة): required. **ETA** (الوصول المتوقع): required, not before the B/L date. **Vessel** (السفينة), **Voyage** (الرحلة), **Shipping line** (خط الشحن), **Port of loading** (ميناء التحميل): optional text. **Port of discharge** (ميناء التفريغ): optional, from the ports list. Container rows — **Container no.** (رقم الحاوية), **Size / type** (الحجم / النوع), **Seal no.** (رقم الختم), and a quantity per model.
- Add charge — **Type of cost** (نوع الكلفة): required. **Journal no.** (رقم القيد): required, a posted journal. **Amount (IQD)** (المبلغ (د.ع)): required, above zero. **What it is** (ما هو): required for type Other. **Note** (ملاحظة): optional.
- Lock landed cost — **Allocate** (التوزيع): the basis; the default from settings is pre-chosen. **Date** (التاريخ): today by default. **Allocated (IQD)** per model: only for the Manual basis. **Note** (ملاحظة): optional.
- Withdraw a charge — **Charge** (العبء): required. **Why it is withdrawn** (سبب السحب): required.
- Claim the shortage — **Claim date** (تاريخ المطالبة): required, today by default. **Supplier's reference** (مرجع المورد): optional. **What is claimed** (ما المُطالَب به): required.
- Cancel application — **Why it is cancelled** (سبب الإلغاء): required.
- Set the due date for the balance — **Due date** (تاريخ الاستحقاق): required; not before the date of any invoice it is set on.
- Edit PI lines — **Item** (المادة), **Description** (الوصف), **Qty** (الكمية), **Unit** (الوحدة), **Unit price** (سعر الوحدة); a row without a description is ignored.
- **Add a note** (إضافة ملاحظة) — required text.

### After you save — Import Applications
An import application has no draft/approve/post of its own. It opens at stage 1 with its invoice, moves through the stages as its documents are posted, and ends either **Cleared** (closed automatically — then read-only except for attachments and notes) or **Cancelled** (with a reason). It posts nothing itself: the journal entries come from its invoices, payments, advances, purchase returns and landed-cost locks. Creating it also creates a purchase order from the invoice lines and submits it for approval. Setting the balance's due date writes the date on each waiting invoice and on the import (a "Due date of …" line in the status log, "Due date set" in each invoice's history); it posts and moves nothing.

### Refusals — Import Applications
- "… is already open as … for this supplier. One import, one record (R1)" — the supplier reference is already used by another open import of this supplier; open that one, or use a different reference for a genuinely different purchase.
- "… has no In Process warehouse, so an import's goods have nowhere to be while at sea." — create the branch's transit warehouses first (Warehouses).
- "An invoice with no purchase order needs a written justification and a second approver (§15)…" (when reading a document) — a line of the document was not matched to a stock item in the Items list; add the item, or enter the invoice by hand.
- "No reader is configured on this host, so a document cannot be read into a draft." — the document reader is not set up; enter the invoice by hand.
- "The document says "…", which is not plainly one of our suppliers. Add them first, or raise the invoice by hand." / "No supplier could be read out of that document…" — add and approve the supplier, or use Enter supplier invoice.
- "… is over its time limit in the … lane and the stop has no reason yet. Complete the hold — reason, owner, next action — before changing anything in this lane." — answer the red "Over time limit — reason required" banner first.
- "Choose the reason the payable is stopped…", "Reason OTHER requires the detail in words…", "Name who is following this up…", "Say what happens next — the next action is required.", "Give the next action its expected date." — a stop needs a reason, an owner, a next action and its date.
- "This hold is already resolved." / "This hold already has its reason — use Update instead." — refresh the page; the stop was already answered.
- "… a cancelled payable is read-only." / "… a closed payable is read-only except for attachments and notes" — nothing more can be changed; a cleared import re-opens by itself only when a clearing condition stops holding.
- "… invoice … is posted against it. Reverse the invoice first — cancelling the record would not cancel the debt." — reverse the invoice on its page, then cancel.
- "… invoice … is posted — the invoice is the figure now. Correct it there." — the order lines cannot be edited once an invoice is posted.
- "… is more than is left to ask the bank for on … Applications never total more than is owed." / "Nothing is left to ask the bank for on …" — the payment applications already cover the amount; reject or cancel one, or type a smaller amount.
- "… holds IQD and … is in USD (D3). Pay from an account in USD." — choose a Paid-from account in the import's currency.
- "… is paid from a cash account, and … is a bank account." (or the reverse) — a cash method is paid from a cash account, every other method from a bank account.
- "… is cancelled; nothing more is paid against it." / "… is cleared; re-open it before paying more." — no payment application on a cancelled or cleared import.
- "… is not fully paid in … yet; its exchange difference is known only once it is." / "… has no exchange difference to book…" — Settle exchange difference is only for a fully paid foreign-currency import that still has a difference.
- "Name the posted journal that carries the cost", "No journal …", "… is draft; only a posted journal carries a cost." — a landed-cost charge needs the number of a posted journal.
- "Say what an "other" charge is." / "State the amount of the charge." — fill What it is for type Other, and an amount above zero.
- "A locked charge is part of the cost; a correction is a new, dated charge." / "This charge belongs to its document; reverse the document to withdraw it." / "Say why the charge is withdrawn." — withdrawal rules for charges.
- "…'s landed cost is locked once every PD is totally written off" / "… once every container is received…" — finish customs and receiving first.
- "… has no charge to allocate yet." / "Every charge of … is already in its landed cost…" — nothing to lock.
- "A landed cost is locked on a day that has come…", "… a later lock of the same import cannot be dated before it", "…'s last container was received on …; its landed cost is locked on or after the day the goods arrived" — correct the lock date.
- "The amounts typed per model add up to …; the charges to allocate are …" — in a Manual lock the amounts must equal the charges.
- "Weight is not on the item master yet; allocate by value, by quantity or manually." (same for Volume) — only if those bases were switched on in the settings; choose another basis.
- "Item … names no inventory account; set it on the item first." (or "cost of sales account") — complete the item's accounts on the Items screen.
- "… of … has left its layer in …, and the movements that took it account for …. Run the inventory integrity check before locking the landed cost." — stock records need checking by the accountant before the lock.
- "… has N container(s) still to arrive. A shortage is claimed once every container is in — or add the balance shipment as another container." / "Nothing of … is left in transit: there is no shortage to claim." — claim rules.
- "Say what is claimed and why — the supplier will ask." / "Give the date of the claim." — fill the claim form.
- "PD … of … is already registered. One registration, one row…" / "A PD registered on … cannot expire on …" / "Give the PD number as ASYCUDA shows it." — PD registration checks.
- "B/L … is already recorded. One B/L, one record…", "Give the ETA: without it nobody is told when the containers are late.", "An ETA of … is before the B/L was issued on …", "Not container numbers: … A container number is four letters and seven digits (MSCU1234566).", "… is listed twice." — B/L checks.
- "… is before invoice …'s own date (…)." (in the due-date dialog) — choose a date on or after the date of every invoice listed.
- "Every invoice of this import already has its due date." — somebody set it meanwhile; the page shows it once reopened.
- "No payment application of this import has been paid yet: the due date is set once the SWIFT is received." — attach the paid paper to the payment application first.
- "A due date is a date." — choose a date in the field.

## Purchase Orders (أوامر الشراء)
Path: Payables → Purchasing & Invoices → Purchase Orders   |   Arabic: الذمم الدائنة ← المشتريات والفواتير ← أوامر الشراء
Address: /payables/purchase-orders (one order: /payables/purchase-orders/<order number>)
Needs: `view` on `purchase_order`
What it is for: A read-only register of the company's commitments: what was ordered, what has arrived and what has been billed. Nothing is typed here. An order is created by the system when an import application is opened by its purchase invoice — the invoice's lines become the order, and it is sent for approval automatically.

### How to read the list — Purchase Orders
1. Open Payables → Purchasing & Invoices → Purchase Orders. Newest orders are first; use the page numbers at the bottom for older ones. There is no search box on this list.
2. Columns: **Order** (الأمر) — click to open; **Supplier** (المورّد); **Date** (التاريخ); **Status** (الحالة); **Total (IQD)** (الإجمالي (د.ع)); **Received** (المستلم) — received quantity / ordered quantity; **Invoiced** (المفوتر) — invoiced quantity / ordered quantity; **Payable** (الذمة) — the import application the order belongs to, as a link.
3. Statuses shown: Draft (مسودة), Submitted (مُقدّم), Approved (معتمد), Partially executed (منفّذ جزئياً), Executed (منفّذ), Cancelled (ملغى), Closed (مغلق), Rejected (مرفوض).

### How to open a record — Purchase Orders
Needs: `view` on `purchase_order`; adding a note needs `edit_draft` on `purchase_order`.
1. Click the order number.
2. Header: **Order** (الأمر), **Status** (الحالة), **Supplier Code** / **Supplier Name** (links to the supplier's profile), **Date** (التاريخ), **Expected** (المتوقع), **Currency** (العملة), **Reference** (المرجع) — the supplier's reference, **Branch** (الفرع), **Payable** (الذمة) — link to the import application, and **Cancellation reason** (سبب الإلغاء) when cancelled.
3. Lines — "Ordered, received and invoiced" (المطلوب والمستلم والمفوتر): #, Item (المادة), Description (الوصف), **Ordered** (المطلوب), **Received** (المستلم), **Remaining** (المتبقي) = ordered − received − closed, **Invoiced** (المفوتر), Unit price (IQD), Total Price (IQD). Foot: total ordered, total received, Total (IQD).
4. Below: **Goods receipts** (استلامات البضائع) against this order — Receipt, Date, Status, Received; and **Purchase invoices** (فواتير الشراء) against it — Invoice, Date, Status, Amount (IQD), Allocated (المخصّص, what has been settled on the invoice).
5. The four icons at the top (printer, paperclip, notes, clock) work as described in Concepts.

### After you save — Purchase Orders
Nothing is saved from this screen. The page has no buttons to create, approve, cancel or close an order. An order raised for an import is in status Submitted; a supplier advance can be requested against any order that is not Draft, Cancelled, Closed or Rejected (see Supplier Advances).

### Refusals — Purchase Orders
- "… is prospect, so a purchase order cannot be raised against them (§6). Choose an active supplier … a prospect is approved on its record under Payables › Suppliers." — appears when an import invoice is saved for a supplier that is not approved (also "has been deactivated", "is not a supplier"); approve or reactivate the supplier on its profile.
- "A purchase order with no lines commits the company to nothing." — the import invoice had no lines.

## Goods Receipts (استلامات البضائع)
Inventory → Receipts, Issues & Transfers → Goods Receipts   |   Arabic: المخزون ← الاستلام والصرف والتحويل ← استلامات البضائع
Address: /payables/goods-receipts (one receipt: /payables/goods-receipts/<receipt number>)
Needs: `view` on `goods_receipt`
What it is for: A read-only register of what arrived, against which purchase order, into which warehouse. Nothing is typed here.

### How to read the list — Goods Receipts
Inventory → Receipts, Issues & Transfers → Goods Receipts (moved there from Payables on 2026-10-06; the address /payables/goods-receipts is unchanged). Use the page numbers for older receipts; there is no search box.
2. Columns: **Receipt** (الاستلام) — click to open; **Order** (الأمر) — link to the purchase order; **Supplier** (المورّد); **Date** (التاريخ); **Warehouse** (المخزن); **Lines** (البنود) — number of lines; **Status** (الحالة).

### How to open a record — Goods Receipts
Needs: `view` on `goods_receipt`; adding a note needs `edit_draft` on `goods_receipt`.
1. Click the receipt number.
2. Header: **Receipt** (الاستلام), **Status** (الحالة), **Order** (الأمر) as a link, **Supplier Code** / **Supplier Name**, **Date** (التاريخ), **Supplier delivery note** (مذكرة تسليم المورّد), **Branch** (الفرع), **Note** (ملاحظة) and **Reversal reason** (سبب العكس) when present.
3. Lines: Item (المادة), **Ordered** (المطلوب), **This receipt** (هذا الاستلام), **Received to date** (المستلم حتى الآن), **Remaining** (المتبقي), UoM (الوحدة), Warehouse (المخزن), Batch (الدفعة), Serial (التسلسلي). Foot: total of This receipt.
4. The four icons at the top work as described in Concepts.

### After you save — Goods Receipts
Nothing is saved from this screen: it has no buttons to create, post or reverse a receipt. The goods of an import are received container by container on the container's page under Logistics; the goods of a local purchase invoice enter the warehouse when that invoice is posted.

## Purchase Invoices (فواتير المشتريات)
Path: Payables → Purchasing & Invoices → Purchase Invoices   |   Arabic: الذمم الدائنة ← المشتريات والفواتير ← فواتير المشتريات
Address: /payables/invoices (new: /payables/invoices/new; one invoice: /payables/invoices/<invoice number>)
Needs: `view` on `ap_invoice` to open the list and a record; `create` on `ap_invoice` for New invoice. An import invoice also needs `create` and `edit_draft` on `payable` and `create` and `submit` on `purchase_order`, because saving it opens the import application and its order.
What it is for: What the company has been billed. Every supplier bill is entered here — goods for an import, goods bought locally, and (through Expenses) rent, freight and other costs. Posting an invoice creates the debt to the supplier and brings the goods into stock. The page title on screen is "Purchase Invoices" (فواتير الشراء).

### How to read the list — Purchase Invoices
1. Open Payables → Purchasing & Invoices → Purchase Invoices.
2. Search with the box "Search this list" (ابحث في هذه القائمة) — it matches any text on the row.
3. Filter with **View** (العرض), **Import application** (معاملة الاستيراد) — All (الكل), Linked to an import application (مرتبطة بمعاملة استيراد), Not linked (غير مرتبطة) — and **Minimum amount (IQD)** (الحد الأدنى للمبلغ (د.ع)), then press **Show** (عرض). View: All invoices (جميع الفواتير), Imports (الاستيراد), Expenses (المصروفات), Unpaid (غير مدفوعة — unpaid, part paid or overdue), Overdue (متأخرة). A saved view keeps all three filters.
4. Columns: **Reference** (المرجع) — the invoice's own number only (a link to it); **Import application** (معاملة الاستيراد) — the import application it belongs to (a link), empty for an invoice without one (since 2026-10-06 it has its own column rather than sitting beside the number); **Supplier invoice / receipt no.** (رقم فاتورة / وصل المورّد) — the supplier's own number, empty when none was typed; **Invoice Date** (تاريخ الفاتورة); **Due Date** (تاريخ الاستحقاق) — "—" with "Set once the SWIFT is received" (يُحدَّد عند استلام السويفت) until the due date is set on purpose; **Supplier Code** (رمز المورّد); **Supplier Name** (اسم المورّد); **Amount** (المبلغ) — the total in IQD, zero until the invoice is posted; **Status** (الحالة); **Payment** (الدفع) — Not posted (غير مرحّلة), Not started (لم تبدأ), Part paid (مدفوعة جزئيًا), Paid (مدفوعة), or Overdue — N days (متأخرة — N يوم) with the latest note written on the invoice shown under it.

### How to enter a purchase invoice — Purchase Invoices
Needs: `create` on `ap_invoice`. With Import ticked also `create` and `edit_draft` on `payable` and `create` and `submit` on `purchase_order`.
1. Press **New invoice** (فاتورة جديدة) on the list (or **Enter supplier invoice** on Import Applications).
2. If the page says "Add a supplier first.", "Add a stock item first." or "Set up a warehouse first." (or that none of the existing ones is active and approved), that set-up must be done before an invoice can be entered.
3. Choose the supplier by typing in **Supplier Code** or **Supplier Name** — filling one fills the other.
4. Type the supplier's own number from the paper they gave you in **Supplier invoice / receipt no.** (رقم فاتورة / وصل المورّد) — optional.
5. Choose the **Currency** the supplier's invoice is in; the rate of the day is shown ("1 USD = … IQD").
6. Check the **Invoice Date**, and the **Payable account (statement)** — the account's balance is shown under it.
7. Leave **Import** ticked for goods coming from abroad; untick it for a local purchase.
8. In the lines type the item, quantity, unit price and (optionally) discount, and choose the warehouse. Only the items linked to the chosen supplier are offered (Inventory → Items → the item → **Bought from**); with no supplier chosen there is nothing to pick yet, and the row says "Choose the supplier first — the items offered are the ones it sells.". Under the item its **Supplier's code** (رمز المورّد للصنف) is shown when the item's link names one. Filling a line opens the next one. The totals row shows the total in the invoice currency and what the ledger will carry in IQD.
9. First check **Advance paid from** (with its account's balance under it) and **Advance payment method** — they open on the first account in the invoice's currency and the first bank method. With no account chosen there is no upfront payment: **Payable in advance** stays on No upfront payment and cannot be changed, and a note under it says to choose the account first (2026-10-07).
10. Then choose **Payable in advance** (الدفع المقدم): **No upfront payment** (بلا دفعة مقدمة), **Payable by percentage** (دفع مقدم بنسبة مئوية) or **Payable by amount** (دفع مقدم بمبلغ). With Import ticked it opens on Payable by percentage with the box empty; without Import on No upfront payment. For the two that pay in front a box opens beside it — **Advance payment %** (نسبة الدفعة المقدمة %) or **Advance amount** (مبلغ الدفعة المقدمة) — type the figure; under the box the screen shows **Payable amount** (المبلغ المستحق الدفع) or "That is N% of the total", and **Left to pay** (المتبقي للدفع). Optionally type a **Note**.
11. Press **Create** (إنشاء). The invoice is saved as a Draft, gets its number (PUR-…, for example PUR-HQ-2026-000012), and opens on its own page. If Import was ticked, the import application (and its purchase order) is opened at the same moment and its number shows on the invoice.
12. If the page says an item "is not linked to" the supplier, a person who may change items sees **Open … to link the supplier** (افتح … لربط المورّد) under the message: open the item, add the supplier under **Bought from**, and enter the invoice again.

### Fields — Purchase Invoices
- **Supplier Code** / **Supplier Name** (رمز المورّد / اسم المورّد) — required. Only suppliers that are Active (approved) and in use are offered. Changing the supplier changes the items the lines offer.
- **Supplier invoice / receipt no.** (رقم فاتورة / وصل المورّد) — optional; the supplier's own number, as on the invoice or receipt they gave. Left empty, the system's own invoice number stands in for it (and the screens show it as empty). One number per supplier: a number this supplier already billed under is refused (§15). With Import ticked a new import application is keyed by this number.
- **Currency** (العملة) — the currency the prices are typed in; opens on IQD. For another currency the system converts every price to dinars at the rate in force on the posting date; the invoice and its journal are in dinars, and the record later shows **Issued in** (محررة بـ) with that rate. If Import is ticked, the import application keeps this currency and it is what the bank is asked to pay.
- **Invoice Date** (تاريخ الفاتورة) — required; today by default. It is the invoice date, the date of the journal and of the stock movement.
- **Payable account (statement)** (حساب الذمم الدائنة (كشف الحساب)) — optional. The supplier control account the debt is kept on; opens on the configured account. "As configured" (حسب الإعداد) means the posting mapping decides. Under it: **Balance** (الرصيد) — the account's balance in the general ledger now (every posted journal, as its Chart of Accounts profile shows it), with **Dr** (مدين) or **Cr** (دائن) for the side, and the account's code and name; for "As configured" it is the balance of the account the mapping would use. It follows the choice. Shown to whoever holds `view` on `chart_of_account` or `gl_inquiry`; nobody else sees it.
- **Import** (استيراد) — tick box, ticked by default: "This is an import — open the import application behind it". Ticked: the goods are booked into the branch's In Process (transit) warehouse when the invoice is posted and wait there until the containers are received; the warehouse chosen on the lines is where they will finally be received. Unticked: the goods enter the chosen warehouse as soon as the invoice is posted.
- **Import application** (معاملة الاستيراد) — "New — opened by this invoice" (جديدة — تفتحها هذه الفاتورة), or choose an open import to add this invoice to it. Used only when Import is ticked.
- **Payable in advance** (الدفع المقدم) — one selection: **No upfront payment** (بلا دفعة مقدمة), **Payable by percentage** (دفع مقدم بنسبة مئوية), **Payable by amount** (دفع مقدم بمبلغ). It follows the Import box until you choose (ticked: by percentage, the box empty; unticked: no upfront payment). No share is preset — type any.
- **Advance payment %** (نسبة الدفعة المقدمة %) — beside the selection when it is by percentage: more than 0 and at most 100 (the box will not take more). Under it: **Payable amount** (المبلغ المستحق الدفع) — what that share of the total comes to — and **Left to pay** (المتبقي للدفع) — the total less it.
- **Advance amount** (مبلغ الدفعة المقدمة) — beside the selection when it is by amount: more than 0 and at most the invoice's total, in the invoice's currency; more is said in red ("More than the invoice comes to…") and the form is not sent. Under it: "That is N% of the total" and **Left to pay**.
- For No upfront payment there is no box and nothing is sent. The figures are worked out from the lines as they are typed, in the invoice's currency (and in dinars for a foreign one); the payable amount is exactly what the payment application asks for when the invoice posts — by amount, the amount itself.
- **Advance paid from** (تُدفع الدفعة المقدمة من) — the bank or cash account the advance leaves from. Only accounts in the invoice's currency are offered (an import is paid from an account in its own currency); the first is chosen by itself, and the choice follows the Currency box. "— not yet decided —" leaves the application to be raised by hand on the import. Under it, the **Balance** of the G/L account that bank or cash account is kept on — for an account in another currency in that currency first, then in dinars.
- **Advance payment method** (طريقة دفع الدفعة المقدمة) — how it travels (SWIFT, transfer, cash…); opens on the first bank method. With the payable amount and the account, these are all a payment application needs, so when the invoice is posted the advance's payment application is raised by itself as a **Draft** for exactly the payable amount — nobody types it. Open it (Transfers & Applications → Payment Applications, or the import's Payments section), **Send for approval**, have it approved by somebody else, then attach its papers; its **paid** paper (the SWIFT) moves the goods from On Process (Without SWIFT) to In Process.
- **Project element** (عنصر المشروع) and **Project cost code** (رمز تكلفة المشروع) — shown only when projects have elements that can take costs. "None — not for a project" (لا شيء — ليس لمشروع) leaves the invoice unassigned; if one is chosen the other must be chosen too.
- Line — **Item Code** / **Item Name** (رمز الصنف / اسم الصنف) — required; active stock items linked to the chosen supplier only (since 2026-10-06 an item is bought only from a supplier linked to it on the item's page). A line whose item the supplier does not sell says "Not an item this supplier sells — link the supplier on the item's page." and is refused when saved. Searching the line by a name that finds nothing says why: the item is **not linked to this supplier** (link it on the item's page) or it is **not in our items** at all. Under the name: **Supplier's code** (رمز المورّد للصنف), the supplier's own code for the item, when the link names one.
- Line — **Quantity** (الكمية) — required, more than zero.
- Line — **Unit** (الوحدة) — one of the item's units; the item's purchase default when left alone.
- Line — **Unit Price** (سعر الوحدة) — required, in the invoice currency; not negative.
- Line — **Discount** (الخصم) — optional amount off the line; not more than the line.
- Line — **Total Price** (القيمة الإجمالية) — worked out: quantity × unit price − discount.
- Line — **Warehouse** (المخزن) — required; a warehouse of your branch.
- **Note** (ملاحظة) — optional; saved as the invoice's first note (see the notes icon).
- The due date is not on the form. Until somebody sets it on purpose the invoice has none (2026-10-07): every screen and copy shows "—" with "Set once the SWIFT is received", it is never Overdue, the ageing counts it under Not yet due and no due-soon or overdue notice is sent. It is set once the advance is paid — see "How to set the due date — Purchase Invoices". A due date written on the document as it is raised (an expense's, a recurring contract's period, a debit note's, one said to Noah) counts as set.
- The invoice number is given by the system: **PUR-**{branch}-{year}-{serial} since 2026-10-06. Invoices entered before carry **API-** and keep it; both are found by their number everywhere.

### How to open a record and what it shows — Purchase Invoices
1. Click the invoice number in the list.
2. Header: **Invoice Number** (رقم الفاتورة); **Import application** (معاملة الاستيراد) — link, when there is one; **Type of fee** (نوع الرسوم) for an expense; **Payment** (الدفع) state; **Status** (الحالة); **Supplier Code** / **Supplier Name** (links to the supplier's profile); **Supplier invoice / receipt no.** (رقم فاتورة / وصل المورّد) — "—" when none was typed; the invoice a debit note adjusts, when it is one; **Invoice Date**; **Due Date** — "—" with "Set once the SWIFT is received" until a due date has been set on purpose, then the date with "Set by <name> on <date>" (حدّده … في …) under it; **Issued in** (محررة بـ) — currency and rate, for a foreign-currency invoice; **Payable in advance** — "Payable by percentage · 20%" or "Payable by amount · That is N% of the total"; **Payable amount** (المبلغ المستحق الدفع) — in the agreed currency and in IQD; **Left to pay** (المتبقي للدفع); and under them **Advance paid from** — the account (link), the method, and the payment application the posting raised (link, with its status), or "payment application raised when the invoice posts" while it is still a draft, with the account's **Balance** under it; **Raised by** (أنشأها); **Payable account (statement)** and **Expense account (service lines)** (حساب المصروف (سطور الخدمات)), each with its **Balance** (Dr / Cr) under it for whoever may read the ledger; **Submitted by** (قدّمه); **Posted by** (رحّلها).
3. Lines: #, Item Code, Item Name, Quantity, Unit Price, Discount, Total Price, Warehouse, with the total at the foot.
- **Accounting entries — debit and credit** (القيود المحاسبية — مدين ودائن): under the settlement, the journal the posting wrote — each line's account (link), description, Debit (IQD), Credit (IQD), and the totals, which always balance; the journal's number and status in the title; the reversal's journal under it when the invoice was reversed. Before posting it says the entries are written when the invoice is posted (since 2026-10-06).
4. Under the document, once the invoice is posted: a settlement panel (payment terms, what is paid, what is left, how late, and each payment against it); then **Credit and debit notes on this invoice** (إشعارات الدائن والمدين على هذه الفاتورة) — Kind, Note no., Date, Status, Amount.
5. The four icons at the top: printer (the Purchase Invoice copy), paperclip (the supplier's PDF, packing list…), notes, clock — see Concepts.

### How to change a draft — Purchase Invoices
Needs: `edit_draft` on `ap_invoice`.
Only a Draft raised on its own can be changed (not one raised from a purchase order, and not an expense).
1. Open the draft. Its lines are typed straight in the grid: change a value and leave the row — the line is saved at once; fill the last row to add a line; use the remove button at the end of a row to delete it.
2. To change the accounts choose **Payable account (statement)** or **Expense account (service lines)** in the header and press **Save accounts** (حفظ الحسابات). "As configured" (حسب الإعداد) clears the choice. The balance under each follows the choice.
3. To correct the supplier's number type it in **Supplier invoice / receipt no.** and press **Save** (حفظ) beside it; emptied, the system's number stands in again. The import application keeps the reference it was opened with. A line's item must still be one the supplier sells.
4. The supplier, the currency, the posting date and the Import tick cannot be changed after the draft is created.
5. The page has no button to delete or cancel a draft, and none to return an invoice from Pending approval to Draft. An invoice entered wrongly and already sent for approval can only be posted and then reversed.

### How to send for approval — Purchase Invoices
Needs: `submit` on `ap_invoice`.
1. Open the Draft and press **Send for approval** (إرسال للاعتماد).
2. The status becomes Pending approval (بانتظار الموافقة). The lines can no longer be changed.
3. A super user's own draft has no Send for approval (since 2026-10-06): it shows **Approve and post** (اعتماد وترحيل) straight away — see the next section.

### How a super user approves their own invoice — Purchase Invoices
Needs: the super user flag (a super user holds every grant); the draft must be one they raised.
1. Open your Draft and press **Approve and post** (اعتماد وترحيل).
2. The system records both steps in one go — Sent for approval and Approved and posted, each in the history with your name — and the invoice is Posted (see "After you save").
3. If an automation rule reviews submitted purchase invoices (Workflow Automation's "invoice over a threshold"), the invoice stops at Pending approval and the page says "Sent for approval: an automation rule reviews submitted purchase invoices first. Once the review is approved in My Approvals, press Approve and post." The rule's hold works exactly as on the ordinary road.
4. Everybody else, and a super user looking at somebody else's draft, keeps the ordinary road: Send for approval, then Approve and post by a person who holds approve and post.

### How to approve and post — Purchase Invoices
Needs: both `approve` and `post` on `ap_invoice`.
1. Open the invoice in status Pending approval and press **Approve and post** (اعتماد وترحيل).
2. The status becomes Posted (مرحّل) and the journal, the stock and the payable are written (see "After you save").

### How to reverse a posted invoice — Purchase Invoices
Needs: `reverse_cancel` on `ap_invoice`.
Offered while the invoice is Posted and nothing has been paid or settled against it.
1. Open the invoice, type the reason in the box "Why the invoice was wrong" (سبب خطأ الفاتورة).
2. Press **Reverse invoice** (عكس الفاتورة).
3. The journal is reversed (dated today, so the current period must be open), the goods leave the warehouse at the cost they came in at, and the invoice is marked Reversed (معكوس) with the reason. A posted invoice is never edited — reverse it and enter it again. For goods that physically go back to the supplier use a Purchase Return instead.

### How to set the due date — Purchase Invoices
Needs: `edit_draft` on `ap_invoice`.
1. **Set due date** (تحديد تاريخ الاستحقاق) is in the actions row when the invoice belongs to an import, a payment application of that import is Paid (the SWIFT received), and the invoice still owes something with no due date. Before that the button is not there: the date is not known yet.
2. It opens the import's dialog **Set the due date for the balance** (تحديد تاريخ استحقاق الرصيد): choose the **Due date** and press **Save** — the date is set on every invoice of the import that waits for one, and on the import (see "How to set the due date for the balance — Import Applications"). **Later** closes it.
3. The record then shows the date with "Set by <name> on <date>"; the history shows "Due date set".

### How to follow the import or the payment — Purchase Invoices
1. On an invoice that belongs to an import press **Import tracking** (متابعة الاستيراد) to open the import application.
2. Payments are not made from the invoice page. An import is paid with payment applications on its import application; any other invoice is paid from Supplier Payments (create a payment, then allocate it to the invoice).

### After you save — Purchase Invoices
- **Draft** (مسودة) → **Pending approval** (بانتظار الموافقة) by Send for approval → **Posted** (مرحّل) by Approve and post → **Posted — partly paid** (مُرحَّلة — مدفوعة جزئيًا) and **Settled** (مسوّى) as payments, advances, credit notes or returns are put against it; or **Reversed** (معكوس). A super user's own draft goes from Draft to Posted with one press (both steps recorded).
- Saving a draft posts nothing. Saving with Import ticked opens the import application and creates and submits its purchase order.
- Posting writes one journal dated the posting date: debit Inventory for each stock line (the item's own inventory account) — or Expense for a service line, or the landed-cost clearing account for an expense line that belongs to an import — and credit the Supplier payable account with the total. Stock lines are received into the warehouse (for an import: into the In Process transit warehouse) at the invoice price.
- Posting an invoice of an import also: updates the import's amount and quantity, moves its stage, applies any deposit (supplier advance) already paid on that import to this invoice, and — when an advance was agreed (by percentage or by amount) with an account and a method — raises the payment application for the payable amount in the import's currency, as a draft, (event ADVANCE_RAISED on the import's log; ADVANCE_NOT_RAISED, with the reason, when it could not).
- Posting an expense line that "belongs to an import" adds a charge to that import's Landed cost section.
- Posting a local (non-import) invoice whose goods went into the In Process warehouse opens its tracking under Logistics → In-Transit Inventory.

### Refusals — Purchase Invoices
- "An invoice with no lines bills for nothing. Name at least one item." — add at least one line with an item.
- "Line N names … but has no quantity or unit price. Complete it, or clear the item to drop the line." — finish the line.
- "Line N does not say which warehouse … arrives in. A purchase invoice puts the goods somewhere." — choose the warehouse on that line.
- "No … exchange rate has been published yet, so this cannot be valued." — publish the rate for that currency under Currencies and Rates.
- "… has no In Process warehouse, so an import's goods have nowhere to be while at sea." — create the branch's transit warehouses (Warehouses) first.
- "… is already open as … for this supplier. One import, one record (R1)…" — this supplier already has an open import with the same reference; choose it in Import application instead of "New".
- "… belongs to a different supplier than …" — the import chosen in Import application is another supplier's.
- "Supplier invoice … has already been entered as … (§15)." — the same supplier invoice / receipt number exists for this supplier; check it is not the same bill.
- "… is not linked to … : an item is bought only from the suppliers linked to it. Link … on the item's page (/inventory/items/…), or choose an item … sells." — link the supplier on the item's page (Inventory → Items → the item → Bought from), or choose another item.
- "An advance cannot be more than 100% of the invoice." / "an advance cannot be more than the invoice — … asked of …" / "An advance percentage is more than nought — or choose No upfront payment." / "An advance amount is more than nought…" — the advance is more than 0 and at most the invoice. A draft line change that would bring the total under an advance written as an amount is refused the same way.
- "… only a super user approves their own draft in one step; send it for approval…" / "… it was raised by somebody else; it is sent for approval by whoever raised it…" — the one-step approval is a super user's own draft alone.
- "A/P invoice … is 'submitted': only a draft invoice may have its lines changed…" — lines are fixed after Send for approval.
- "… it was raised from a purchase order, so its lines are the order's (§8.4)." — correct the order, not the invoice.
- "Line N names …, which is no longer active." / "names no item …" / "names no warehouse …" / "has no quantity…" / "has a negative price. A refund is a credit note." / "has a discount larger than the line…" — correct the line.
- "… would be left billing for nothing. Change this line, or delete the invoice." — the last line of a draft cannot be removed.
- "… only a draft invoice can be submitted." / "… an invoice posts from submitted — it is entered, matched, then posted." — the action does not fit the current status.
- "Permission denied: 'post' on 'ap_invoice' is not granted to this user." (or 'approve') — only a user holding both permissions can approve and post.
- "Invoice … has N unresolved match exception(s) (§8.4)…" — an invoice raised from a purchase order differs from what was ordered or received; a manager must accept the variance or the invoice must be corrected.
- "… the benefiting department has not confirmed the service — an approved service receipt is the evidence (A9)." — a service invoice waits for its department's confirmation (see Expenses).
- "No accounting mapping is configured for the '…' line of 'purchasing.ap_invoice'…" — an account is missing on Posting Mappings (Accounting).
- "Cannot post into …: …" — the period of the posting date is closed; use a date in an open period.
- "… cannot be reversed: a reversal records why the invoice was wrong (§14.3). Give a reason." — type the reason.
- "… cannot be reversed: … IQD has been paid or settled against it. Reverse the payment first…" — undo what is settled on it first.
- "… cannot be reversed: Goods Return … was raised against it…" / "Supplier Credit Memo … was raised against it." / "a payment run has selected it…" — the invoice has documents resting on it; correct through those documents.
- "… cannot be reversed: its charge on … is already in that import's landed cost (lock …)…" — a locked landed cost is not taken back; record the correction as a new, dated charge.
- "… is before invoice …'s own date (…)." (in the due-date dialog) — a due date is on or after the invoice's own date.

## Expenses (المصروفات)
Path: Payables → Purchasing & Invoices → Expenses   |   Arabic: الذمم الدائنة ← المشتريات والفواتير ← المصروفات
Address: /payables/service-receipts
Needs: `view` on `service_receipt` to open the screen. **Add expense** needs `create` on `ap_invoice`; Submit and Approve on a confirmation need `submit` / `approve` on `service_receipt`.
What it is for: Two things on one screen. (1) **Add expense** enters a bill that is not goods — rent, utilities, freight, customs brokerage, fees — as a purchase invoice with one line. (2) Below it, the service confirmations: the benefiting department's "yes, we received this service", before anything is paid. The page title on screen reads "Service Receipts" (استلامات الخدمات).

### How to add an expense — Expenses
Needs: `view` on `service_receipt` to open the screen and `create` on `ap_invoice` for Add expense; then `submit`, and `approve` plus `post`, on `ap_invoice` to get it posted.
1. Press **Add expense** (إضافة مصروف).
2. Fill the form (see Fields) and press **Save expense** (حفظ المصروف).
3. The system creates a Draft purchase invoice with one line for the amount and opens it on the Purchase Invoices record page.
4. On that page press **Send for approval** (إرسال للاعتماد); a user allowed to approve and post purchase invoices then presses **Approve and post** (اعتماد وترحيل).
5. Pay it from Supplier Payments: create a payment to the same supplier and allocate it to this invoice.

### Fields — Expenses
- **Type of fee** (نوع الرسوم) — required. The expense category; the list is set up in Payables Settings (for example Office rent, Utilities, Freight & forwarding, Customs brokerage, Professional fees, Bank charges, Government fees, Repairs & maintenance, Software subscriptions, Other). The category decides the expense account the invoice posts to when one is set on it.
- **Who we pay** (الجهة المستفيدة) — required. An active, approved supplier.
- **Amount (IQD)** (المبلغ (دينار)) — required, more than zero, in dinars.
- **Bill date** (تاريخ الفاتورة) — required; today by default. Becomes the posting date.
- **Due date** (تاريخ الاستحقاق) — required. Drives the Overdue state and the ageing.
- **Supplier's bill no.** (رقم فاتورة المورد) — optional. If typed, the same number cannot be entered twice for the same supplier.
- **Belongs to import** (يعود إلى معاملة استيراد) — optional. Choose an open import application when this cost (freight, clearing…) is part of that import's landed cost. Then the posted amount goes to the landed-cost clearing account instead of expense and appears as a charge in the import's Landed cost section.
- **Name** (الاسم) — required. What it is for, as it should read in the list, e.g. "Erbil office rent — October". It becomes the line description and the invoice's note.

### How to confirm a service — Expenses
Needs: `submit` on `service_receipt` to submit, `approve` on `service_receipt` to approve.
The two tables list service confirmations: **Awaiting confirmation** (بانتظار التأكيد) — those submitted and waiting — and **All receipts** (كل الاستلامات).
1. Columns: **Receipt** (الاستلام), **Supplier** (المورّد), **Belongs to** (يعود إلى) — link to the import application or purchase order, **Department** (القسم), **Service date** (تاريخ الخدمة), **Status** (الحالة), **Actions** (إجراءات).
2. On a Draft row press **Submit** (تقديم).
3. On a Submitted row press **Approve** (اعتماد). The approver must belong to the department shown on the row and must not be the person who raised the confirmation; a Super User may approve alone.
4. An approved confirmation posts nothing. It is the evidence that lets the service's invoice be posted.
This screen has no button to raise a new confirmation.

### After you save — Expenses
- Add expense → a Draft purchase invoice (visible under Purchase Invoices with View = Expenses) → Pending approval → Posted. Posting debits the expense account (or the landed-cost clearing account when it belongs to an import) and credits the supplier payable; nothing enters stock.
- A confirmation moves Draft (مسودة) → Submitted (مُقدّم) → Approved (معتمد); it can later show Reversed (معكوس).

### Refusals — Expenses
- "Enter the amount on the bill." / "An expense of nothing charges nothing. Enter the amount on the bill." — type an amount above zero.
- "Give the expense a name — what it is for, as it should read in the list." — fill Name.
- "Supplier invoice … has already been entered as … (§15)." — that supplier's bill number is already in the system; check for a duplicate.
- "… is closed — its cost is locked and takes no further charges." — the import chosen in Belongs to import is closed or cancelled.
- "… is not an import — landed cost belongs to the goods it moved (§9.2)." — choose an import application.
- "Confirmation … is owned by department … (§8.6), and you do not belong to it. Only the department that asked for the work can confirm it was done — ask them to approve it." — ask a member of that department.
- "… the person who raised a confirmation cannot approve it — the approval is what makes it evidence (§5.2)." — a second person approves.
- "… only a draft confirmation can be submitted." / "… only a submitted confirmation can be approved." — refresh; the status already moved.

## Recurring Contracts (العقود الدورية)
Path: Payables → Purchasing & Invoices → Recurring Contracts   |   Arabic: الذمم الدائنة ← المشتريات والفواتير ← العقود الدورية
Address: /payables/contracts (one contract: /payables/contracts/<contract number>)
Needs: `view` on `recurring_contract`. New contract needs `create`; Approve needs `approve`; Amend and Generate need `edit_draft`; End needs `reverse_cancel` — all on `recurring_contract`.
What it is for: The standing commitments — rent, utilities, subscriptions. Each active contract raises its own purchase invoice period by period, so nobody has to type the rent every month.

### How to read the list — Recurring Contracts
1. Open Payables → Purchasing & Invoices → Recurring Contracts.
2. Columns: **Contract** (العقد) — click to open; **Supplier** (المورّد); **Department** (القسم); **Category** (الفئة); **Amount / period** (المبلغ / الفترة); **Frequency** (الدورية) — Monthly (شهري), Quarterly (ربع سنوي), Yearly (سنوي); **Next due** (الاستحقاق التالي); **Status** (الحالة) — Draft (مسودة), Active (نشط), Ended (منتهٍ), Cancelled (ملغى); **Overdue periods** (فترات متأخرة) — a red count when periods are past due and unpaid.

### How to create a contract — Recurring Contracts
Needs: `create` on `recurring_contract` to create; `approve` on `recurring_contract` to approve.
1. Press **New contract** (عقد جديد).
2. Fill the form (see Fields) and press **Create** (إنشاء). The contract is saved as Draft and opens on its page.
3. A different person, allowed to approve contracts, opens it and presses **Approve** (اعتماد). The contract becomes Active. A Super User may approve a contract they raised themselves.

### Fields — Recurring Contracts
- **Supplier** (المورّد) — required; an active, approved supplier.
- **Department** (القسم) — required; the department that benefits.
- **Category** (الفئة) — required; an expense category.
- **Currency** (العملة) — required; opens on USD.
- **Amount per period** (المبلغ لكل فترة) — required, in the contract's currency. Each period's invoice is converted to dinars at the rate of the period's first day.
- **Frequency** (الدورية) — required: Monthly, Quarterly or Yearly.
- **Start date** (تاريخ البدء) — required; the first period starts here.
- **End date** (تاريخ الانتهاء) — optional; no period starting after it is raised.
- **Due rule** (قاعدة الاستحقاق) — when each period falls due. Opens on "day_of_period:1" (day 1 of the period). Other forms: "days_before_period_start:5" (so many days before the period starts), "days_after_invoice:30" (the period's start stands in until the invoice has its own due date).
- **Generate days ahead** (أيام التوليد المسبق) — how many days before a period starts its invoice is raised; opens on 30.
- **Description** (الوصف) — required; it becomes the invoice line, followed by the period's month.
- **Auto-confirm each period (the contract is its own evidence)** (تأكيد تلقائي لكل فترة) — ticked by default. Ticked: each period's invoice is sent for approval as soon as it is raised. Unticked: it waits as a Draft for somebody to check the amount.
- **An invoice is expected each period** (تُتوقّع فاتورة لكل فترة) — optional tick, kept on the contract for information.

### How to open a record and what it shows — Recurring Contracts
1. Click the contract number.
2. Header: Contract, Status, Supplier Code / Name (links), Department, Category, Amount per period with its frequency, Start date, End date, Due rule, Generate days ahead, Auto-confirm (Yes/No), An invoice is expected each period (Yes/No), Branch, Description, and End reason (سبب الإنهاء) when ended.
3. **Periods raised** (الفترات المرفوعة): Period (الفترة) — from–to, Payable (الذمة) — the purchase invoice raised for it, as a link, Due (الاستحقاق), Amount / period in IQD, Stage (المرحلة) — the invoice's payment state (Not posted, Not started, Part paid, Paid, Overdue).
4. **Amendments** (التعديلات): Effective from (نافذ من), Amount / period, Note (ملاحظة), Recorded (سُجّل).
5. The four icons at the top work as described in Concepts.

### How to raise the period invoices — Recurring Contracts
Needs: `edit_draft` on `recurring_contract` for the button.
1. The system does this by itself once a day for every Active contract.
2. To do it now, open an Active contract and press **Generate next period now** (توليد الفترة التالية الآن). It raises the invoices of every period that is due to be generated today — for all active contracts, not only the one on screen. A period is never invoiced twice.
3. Each invoice is then approved and posted on the Purchase Invoices record page like any expense, and paid from Supplier Payments.

### How to change the amount — Recurring Contracts
Needs: `edit_draft` on `recurring_contract`.
On an Active contract open **Amend (dated)** (تعديل (مؤرّخ)).
1. **Effective from** (نافذ من) — required; periods starting on or after this date use the new amount.
2. **Amount per period** — leave empty to keep the amount.
3. **Note** (ملاحظة) — required; why.
4. Press **Record amendment** (تسجيل التعديل). Invoices already raised are not changed.

### How to end a contract — Recurring Contracts
Needs: `reverse_cancel` on `recurring_contract`.
On an Active contract open **End the contract** (إنهاء العقد), fill **End date** (required) and **End reason** (required), press **End contract** (إنهاء العقد). The status becomes Ended and no further periods are raised.

### After you save — Recurring Contracts
Draft → Active (approved by a second person) → Ended. The contract itself posts nothing; each period becomes a purchase invoice (an expense) numbered and posted in the normal way: debit expense, credit supplier payable.

### Refusals — Recurring Contracts
- "… the person who raised a contract cannot approve it — it is a standing commitment (§5.2)." — a second person approves.
- "… only a draft can be approved." / "… only an active contract ends." / "… an ended contract is history." — the action does not fit the status.
- "due_rule: '…' is not a due rule this build knows." — use one of the three forms shown under the field.
- "note: an amendment says why, or it is not a record." — fill the amendment's Note.
- "reason: ending a standing commitment states why." — fill End reason.
- "No … exchange rate has been published yet, so this cannot be valued." — publish the rate of the contract's currency before periods can be invoiced.

## Purchase Returns (مرتجعات المشتريات)
Path: Payables → Purchasing & Invoices → Purchase Returns   |   Arabic: الذمم الدائنة ← المشتريات والفواتير ← مرتجعات المشتريات
Address: /payables/goods-returns (new: /payables/goods-returns/new; one return: /payables/goods-returns/<return number>)
Needs: `view` on `goods_return`. New return needs `create`, Approve needs `approve`, Send back needs `post` — all on `goods_return`.
What it is for: Goods sent back to a supplier, always against the purchase invoice that brought them in. The same document is used to claim a shortage on an import. For an invoice that was simply wrong and nothing physically goes back, reverse the invoice instead.

### How to read the list — Purchase Returns
1. Open Payables → Purchasing & Invoices → Purchase Returns; search with the box at the top.
2. Columns: **Reference** (المرجع) — the return number, click to open; **Invoice Date**; **Supplier Code**; **Supplier Name**; **Original Purchase Invoice** (فاتورة الشراء الأصلية); **Offset Account** (الحساب المقابل) — Accounts Payable (الذمم الدائنة) or Bank (البنك); **Status**.

### How to create a return — Purchase Returns
Needs: `create` on `goods_return` to create, `approve` to approve, `post` to send back.
1. Press **New return** (مرتجع جديد).
2. Optionally type the supplier in **Supplier Name** to narrow the suggestions.
3. Type the invoice number (or part of it) in **Original Purchase Invoice** (فاتورة الشراء الأصلية) and press **Choose** (اختر). Only posted invoices whose lines booked stock into a warehouse can be chosen. If the page says "That could be more than one invoice. Type more of its number." type more; "No returnable invoice matches that." means the invoice is not posted or has no stock lines.
4. Fill the header (see Fields).
5. In the lines table type the quantity to send back in **Return Quantity** (كمية الإرجاع) for each item; leave a row empty to skip it. **Returnable** (القابل للإرجاع) is the most that can go back.
6. Press **Create** (إنشاء). The return is saved as Draft and opens on its page.
7. A user allowed to approve returns presses **Approve** (اعتماد); then a user allowed to post them presses **Send back** (إرسال).

### Fields — Purchase Returns
- **Supplier Code** / **Supplier Name** — read from the invoice; not editable.
- **Invoice Date** (تاريخ الفاتورة) — required; today by default.
- **Offset Account** (الحساب المقابل) — required. **Accounts Payable** (الذمم الدائنة): the return reduces what is owed on the invoice. **Bank** (البنك): the supplier refunds the money.
- **Bank or cash account** (حساب بنكي أو نقدي) — the account the refund arrives in; needed only when the offset is Bank.
- **Supplier reimburses the landed cost** (المورّد يعوّض الكلفة الواصلة) — No (default) or Yes. It matters only for goods whose cost already includes freight, duty and clearance from a landed-cost lock: No sends that part to purchase variance; Yes parks it on return clearing until the supplier's credit clears it.
- **Reason** (السبب) — required.
- Line — Item Code, Item Name, Unit Price (IQD), **Warehouse** (the warehouse the invoice booked the goods into — fixed, not a choice), **Invoiced** (المفوتر), **Returnable** (القابل للإرجاع), **Return Quantity** (كمية الإرجاع).

### How to open a record — Purchase Returns
The record shows Reference, Status, Supplier Code / Name, Invoice Date, Branch, Original Purchase Invoice (link), the supplier credit note (link) when one exists, Offset Account, Supplier reimburses the landed cost (Yes/No) and Reason; lines: #, Item Code, Return Quantity, Warehouse Code. The four icons at the top work as described in Concepts; the printer gives the "purchase return" copy.

### After you save — Purchase Returns
- Draft (مسودة) → Approved (معتمد) → Posted (مرحّل).
- **Send back** posts the return: the goods leave the warehouse at the cost they came in at, and one journal is written — debit Accounts Payable (or Bank for a refund), credit Inventory. With the Accounts Payable offset the invoice's settled amount goes up, so the invoice becomes "Posted — partly paid" or "Settled".
- If the invoice belongs to an import, the import's quantities and stage are recalculated (a shortage claim reduces "Still in transit").
- A return created by **Claim the shortage** on an import application arrives here as a Draft and is approved and posted the same way.

### Refusals — Purchase Returns
- "A return with no lines sends nothing back. Say what is being returned." — type at least one Return Quantity.
- "A return needs a reason (§5.4)…" — fill Reason.
- "Purchase invoice … is '…'. Until it posts, nothing it names is in a warehouse to return." — the invoice must be posted.
- "Only … of … is available to return from that delivery, and … was asked for (§8.7)." — the quantity is more than Returnable.
- "A return offset to Bank must name which bank or cash account the refund arrives in." — choose the Bank or cash account.
- "That bank or cash account is closed. A refund cannot be received into it." — choose an active account.
- "… only a draft return can be approved." / "… a return ships once it has been approved." — follow the order Approve, then Send back.
- "Only … of the … on this invoice are in …, and the return sends back …. Return them from the warehouse they are in. Negative stock is not allowed." — the goods are no longer in that warehouse (sold or moved); reduce the quantity.
- "Return … sends back goods whose cost includes freight, duty and clearance, and that part posts to '…' — no account is mapped for '…'. Map it on Posting Mappings, then send the return again." — the accountant maps the purchase variance / return clearing account.

## Supplier Payments (مدفوعات الموردين)
Path: Payables → Supplier Payments & Credits → Supplier Payments   |   Arabic: الذمم الدائنة ← مدفوعات الموردين وأرصدتهم الدائنة ← مدفوعات الموردين
Address: /payables/supplier-payments (new: /payables/supplier-payments/new; one payment: /payables/supplier-payments/<payment number>)
Needs: `view` on `supplier_payment`. New payment needs `create`; allocating and posting need `post` — on `supplier_payment`.
What it is for: Money paid to suppliers, and — on each payment's page — which invoices it was put against. Payments confirmed from a payment application appear here already posted and allocated; a payment for a local invoice or an expense is entered here by hand. The page title on screen is "Payments" (المدفوعات).

### How to read the list — Supplier Payments
1. Open Payables → Supplier Payments & Credits → Supplier Payments; search with the box at the top.
2. Columns: **Reference** (المرجع) — the payment number, click to open; **Invoice Date** (تاريخ الفاتورة); **Supplier Code**; **Supplier Name**; **Bank/Cash Code** (رمز البنك/الصندوق); **Bank/Cash Name** (اسم البنك/الصندوق); **Amount (IQD)** (المبلغ (د.ع)); **Allocated** (المخصص); **Status** (الحالة).

### How to enter a payment — Supplier Payments
Needs: `create` on `supplier_payment` to create; `post` on `supplier_payment` to allocate and to post.
1. Press **New payment** (دفعة جديدة).
2. Fill the header (see Fields) and press **Create** (إنشاء). The payment is saved as Draft and opens on its page.
3. On the payment's page, put it against invoices: the lines list the supplier's open invoices with **Reference**, **Due Date** and **Outstanding** (المتبقي). Type the amount in the box on an invoice's row and press **Allocate** (تخصيص) — or press **Pay oldest first** (سدّد الأقدم أولاً) to spread the payment over the oldest invoices automatically.
4. Press **Post** (ترحيل). The money leaves the bank or cash account in the books.
5. Anything not allocated stays on the payment as **Unallocated** (غير المخصص) and shows under Supplier Credits until it is allocated to a later invoice (open the payment again and allocate).

### Fields — Supplier Payments
- **Supplier Code** / **Supplier Name** — required; active, approved suppliers only.
- **Bank/Cash Code** / **Bank/Cash Name** — required; an active bank or cash account. A payment entered here is in dinars, so the account must hold IQD.
- **Invoice Date** (تاريخ الفاتورة) — required; today by default.
- **Amount (IQD)** (المبلغ (د.ع)) — required; more than zero.
- **Reference** (المرجع) — optional; the transfer reference, cheque number or voucher number.

### How to open a record and what it shows — Supplier Payments
1. Click the payment number in the list.
2. Header: **Number** (الرقم), **Status**, Supplier Code / Name (links), **Invoice Date**, Bank/Cash Code / Name (links), **Branch**, **Amount (IQD)**, **Unallocated** (غير المخصص), **Reference**, and — for a payment confirmed from a payment application — the **Payment application** (طلب دفع) link and its amount.
3. Lines **Supplier Invoice** (فاتورة المورّد): the supplier's invoices still owing, oldest first.
4. Section **Allocated** (المخصص): every invoice this payment was put against — Invoice Number, Due Date, Date, Allocated. The allocation of a payment to invoices is always kept here, never on the payment application.
5. The four icons at the top work as described in Concepts.

### After you save — Supplier Payments
- Draft (مسودة) → Posted (مرحّل).
- **Post** writes the journal: debit Supplier payable, credit the bank or cash account, dated the posting date.
- **Allocate** raises the invoice's settled amount at once: the invoice becomes "Posted — partly paid" (مُرحَّلة — مدفوعة جزئيًا) or, when nothing is left, "Settled" (مسوّى). A payment can be allocated before or after it is posted.
- This page has no button to reverse a posted payment.

### Refusals — Supplier Payments
- "A payment of nothing pays nothing. State the amount leaving the bank." — type an amount.
- "… holds USD and this payment is in IQD (§17). Pay from an account in the payment currency." — choose an IQD account; a foreign-currency import is paid through a payment application instead.
- "… is closed, so no payment can leave it." — choose an active account.
- "… has … IQD available against … IQD — deposit or draw the money first, or pay from an account that holds it." — the account does not have the funds on posting.
- "Allocating … would exceed the payment balance of … (§15). A payment cannot be spread further than the money that left the bank." — the amount is more than the payment's unallocated part.
- "Allocating … would exceed the invoice balance of … (§15). An invoice can only be paid down to zero…" — the amount is more than the invoice still owes.
- "Payment … is already allocated to invoice … (§15)." — one payment is put against an invoice once.
- "Invoice … is '…'. A payment is allocated to approved open items (Appendix C)." — the invoice is not posted (or is reversed).
- "Payment … has nothing left to apply, or the supplier has no invoice still owing…" — Pay oldest first found nothing to do.
- "Supplier payment … is 'posted': it has already posted." — it was posted already.

## Payment Applications (طلبات الدفع)
Path: Transfers & Applications → Transfers & Applications → Payment Applications   |   Arabic: التحويلات والطلبات ← التحويلات والطلبات ← طلبات الدفع
Address: /payables/payment-applications (one application: /payables/payment-applications/<application number>)
Needs: `view` on `payment_application`. Create needs `create`; Approve and Reject need `approve`; Send needs `execute`; Confirm and Record debit need `post`; Cancel needs `edit_draft` for a draft and `reverse_cancel` once approved or sent — all on `payment_application`.
What it is for: A payment application is the company's request to its bank or cashier to pay a supplier for an import. It is prepared, approved by a second person (which reserves the money), sent to the bank, confirmed when the bank has paid (which posts the payment), and finally marked when the debit shows on the bank statement. The list is sorted longest waiting first. The allocation to invoices is not kept here — it is on the supplier payment the confirmation creates.

### How to read the list — Payment Applications
1. Open Transfers & Applications → Payment Applications (its own module in the top bar since 2026-10-06); search with the box at the top.
2. Filter with **View** (العرض) and press **Show** (عرض): All (الكل), To approve (بانتظار الاعتماد) — drafts, To send to the bank (للإرسال إلى البنك) — approved, Waiting for the bank (بانتظار البنك) — sent, Paid (مدفوعة), Rejected or cancelled (مرفوضة أو ملغاة).
3. Columns: **Application no.** (رقم الطلب); **Import** (الاستيراد) — the import application and its supplier reference; **Supplier** (المورد); **Method** (الطريقة); **Paid from** (يُدفع من) — the account and its bank; **Amount** (المبلغ) in the import's currency; **Sent to bank** (أُرسل إلى البنك) — the date; **Days waiting** (أيام الانتظار); **Status** (الحالة).

### How to create a payment application — Payment Applications
Needs: `create` on `payment_application`.
1. Press **New payment application** (طلب دفع جديد).
2. Choose the **Import application** (معاملة الاستيراد) and press **Continue** (متابعة). The application's own page opens (since 2026-10-06) with the import named at the top; from the import application's Payments section, **New payment application** opens the same page with the import already named.
3. Fill the page and press **Create** — the application opens on its own record, never the import — see "How to pay — the deposit / advance and payment applications — Import Applications" for the fields (Amount, Method, Paid from, Supplier bank account, Loan, Note).
4. The new application opens on its own page in status Draft.

### How to open a record and what it shows — Payment Applications
1. Click the application number.
2. Header: Application no.; Status; Import (link); Instalment (القسط); Supplier (link); Method; Paid from (links to the account and its bank); **Supplier bank account** (حساب المورد البنكي) — green when verified, red when not; **Funded by** (مصدر التمويل) with the loan when there is one; **Paid against PD** (دُفع مقابل التصريح); Amount in the import's currency and in IQD; Sent to bank; Days waiting; **Bank reference** (مرجع البنك); the confirmation date and reference — labelled by method: SWIFT date / SWIFT ref (MT103), Transfer date / Transfer reference, Voucher date / Cash voucher no., Cheque date / Cheque no.; **Posted as** (رُحّل بوصفه) — link to the supplier payment or supplier advance it created; **Debit on statement** (الخصم في الكشف); Prepared by (أعدّه), Approved by (اعتمده), Sent by (أرسله), Confirmed by (أكّده); **Sent although** (أُرسل رغم) — the checks that were overridden and why; **Reason** for a rejection or cancellation; Note.
3. While the application is Draft or Approved the grid shows **Checks before sending** (الفحوص قبل الإرسال): Check (الفحص), Result (النتيجة), What it found (ما وُجد). After it is sent the grid shows **The money's path** (مسار المال): Sent to the bank → SWIFT confirmed / Transfer confirmed / Cash paid / Cheque paid → Debit on the statement.
4. Foot: the Amount, and **Available on <account>** (المتاح في) — what the paying account has available now.
5. **Import tracking** (متابعة الاستيراد) opens the import application. The four icons at the top work as described in Concepts.

### The checks before sending — Payment Applications
Four checks are shown, each with a result: **OK** (سليم), **Refuses Send** (يمنع الإرسال), **Check by hand** (يُتحقق يدويًا) or **Not applicable** (لا ينطبق).
- **Validated PD** (تصريح مسبق معتمد) — the import must have a validated customs PD ("the bank pays only against a validated PD").
- **Funds available** (توفر الأموال) — the paying account's available balance covers the amount.
- **Verified supplier account** (حساب مورد معتمد) — for SWIFT and transfers a supplier bank account must be named, belong to this supplier and be verified on the supplier's profile. Not needed for cash or cheque.
- **Instalment trigger** (شرط القسط) — only for an application tied to an instalment (for example "against the B/L" needs a B/L recorded on the import).
The checks run again with the day's figures when you press Send.

### How to send for approval — Payment Applications
Needs: `submit` on `payment_application`.
1. Open the Draft and press **Send for approval** (إرسال للموافقة). The status becomes "Sent for approval" (أُرسل للموافقة) and it appears in My Approvals for whoever may approve payment applications (since 2026-10-06; before, a Draft was approved directly).

### How to approve — Payment Applications
Needs: `approve` on `payment_application`.
1. A person other than the one who prepared it opens the application that was **sent for approval** and presses **Approve — reserve funds** (اعتماد — حجز المبلغ). The button is not shown to the person who prepared the application. The approver may instead press **Reject** with a reason.
2. The status becomes "Approved — funds reserved" (معتمد — المبلغ محجوز): the amount is held on the paying account (its Available goes down) and, if a loan funds it, the loan is drawn.

### The papers move it — Payment Applications
Since 2026-10-06, after approval every step is a **paper**: you attach the file and say what it is, and the application moves with it. The paperclip asks **What is this paper?** (ما هذه الورقة؟) with the choices the application's state allows, and the action row has a button for each next step:
- **Sent to the bank** (أُرسلت إلى البنك) — on an Approved application: the paper that went to the bank → the application waits for the bank ("Sent — not paid").
- **Paid** (مدفوعة) — on a Sent application: the SWIFT copy (MT103) or the bank's confirmation → posted as below, and any goods of the import held in On Process (Without SWIFT) for its advance move to In Process.
- **Rejected / cancelled** (مرفوضة / ملغاة) — on an Approved application it is cancelled, on a Sent one rejected (the bank refused it); a reason is required. The import's log says so, and goods held for its advance stay where they are.
- **Other** (أخرى) — any other paper; nothing moves.
The **Papers — what each one is** (الأوراق — ما كل ورقة) table under the application lists every paper with its kind and date. A paper that is not the next step is refused ("… is not its next step"), and a refused step keeps no paper.

### How to send to the bank — Payment Applications
Needs: `execute` on `payment_application`; sending although a check fails also needs `approve` on `payment_application`.
1. On an Approved application press **Sent to the bank — attach the paper** (أُرسلت إلى البنك — أرفق الورقة).
2. Fill **Sent to bank** (أُرسل إلى البنك) — required, the date the file went, today by default; **Bank reference** (مرجع البنك) — optional, the bank's file or application number; choose the file.
3. If a check fails, Send is refused. A user who may approve payment applications sees the box **Send anyway because…** (أرسل رغم ذلك لأن…) listing the failing checks; typing a reason there sends it anyway, and the reason is kept on the application and in the import's log.
4. Press the button. The status becomes "Sent — not paid" (أُرسل — غير مدفوع) — for a SWIFT, "SWIFT pending — not paid" (سويفت معلّق — غير مدفوع). The days-waiting clock starts, and the dinar value is recalculated at the rate of that date (it is recalculated once more at the confirmation date when the payment is posted).

### How to confirm the payment — Payment Applications
Needs: `post` on `payment_application`.
1. When the bank's copy (or the cashier's voucher) is in hand, press **Paid — attach the SWIFT copy** (دُفعت — أرفق نسخة السويفت) on a Sent application.
2. The dialog says what it will post: a supplier payment allocated to the import's invoices still owing — or, when no invoice of the import is posted yet, a supplier advance (a deposit) against its purchase order.
3. Fill the date (SWIFT date / Transfer date / Voucher date / Cheque date — required, today by default) and the reference (SWIFT ref (MT103) / Transfer reference / Cash voucher no. / Cheque no. — required).
4. Choose the file and press the button. The status becomes "Paid" (مدفوع) — "SWIFT confirmed — paid" (سويفت مؤكَّد — مدفوع) for a SWIFT — **Posted as** shows the document created, and goods the import held for its advance move to In Process.
5. The file is kept as the application's "Paid" paper.
6. **Paid before the cut-over** (مدفوع قبل الانتقال) is offered only on applications migrated from the old sheet whose money left before the system started: it records the date and reference and posts nothing.

### How to record the bank debit — Payment Applications
Needs: `post` on `payment_application`.
1. On a Paid application press **Record debit** (تسجيل الخصم).
2. Fill **Debit on statement** (الخصم في الكشف) — required; the date the bank statement shows the money leaving; today by default — and press **Record debit**.
3. The status becomes "Debit final" (خُصم نهائيًا). When the payment is matched in Bank Reconciliation the system records this by itself during its daily run.

### How to reject or cancel — Payment Applications
Needs: Reject — `approve`; Cancel — `edit_draft` for a Draft, `reverse_cancel` for an Approved or Sent one (all on `payment_application`).
- **Reject** (رفض) — on an application sent for approval, by the approver; type **Why rejected** (سبب الرفض).
- **Cancel** (إلغاء) — on a Draft or one sent for approval (by whoever may edit it); type **Why cancelled** (سبب الإلغاء).
- On an Approved or Sent application, attach the paper with **Rejected / cancelled — attach the paper** and say why: an Approved one is cancelled, a Sent one rejected.
Either way the reservation on the account is released, a loan draw goes back to the loan, and the amount is free to be asked for again.

### Fields — Payment Applications
- New payment application (list) — **Import application** (معاملة الاستيراد): required; an open import. The amount, method, account, supplier bank account, loan and note are then filled on the import's page.
- Send to bank — **Sent to bank** (أُرسل إلى البنك): required date, today by default. **Bank reference** (مرجع البنك): optional. **Send anyway because…** (أرسل رغم ذلك لأن…): shown only when a check fails and you may approve payment applications; the reason for overriding.
- Confirm — the date (**SWIFT date** تاريخ السويفت / **Transfer date** تاريخ الحوالة / **Voucher date** تاريخ السند / **Cheque date** تاريخ الصك): required, today by default, not before the Sent date. The reference (**SWIFT ref (MT103)** مرجع السويفت / **Transfer reference** مرجع الحوالة / **Cash voucher no.** رقم سند الصرف / **Cheque no.** رقم الصك): required.
- Record debit — **Debit on statement** (الخصم في الكشف): required date, not before the confirmation date.
- Reject — **Why rejected** (سبب الرفض): required. Cancel — **Why cancelled** (سبب الإلغاء): required.

### After you save — Payment Applications
- Draft (مسودة) → Sent for approval (أُرسل للموافقة) → Approved — funds reserved (معتمد — المبلغ محجوز) → Sent — not paid (أُرسل — غير مدفوع) → Paid (مدفوع) → Debit final (خُصم نهائيًا); or Rejected (مرفوض) / Cancelled (ملغى) before it is paid.
- Nothing is posted until **Confirm**. Confirm posts, dated the confirmation date and at that day's rate: a supplier payment (debit Supplier payable, credit Bank) allocated to the import's owing invoices oldest first — or a supplier advance (debit Supplier advance, credit Bank) when no invoice is posted yet. The reservation is released.
- Each step is written to the import's status log and the import's stage is recalculated (for example to Payment in progress once an application is sent). When the import becomes fully paid the log says "Fully paid", and for a foreign-currency import the exchange difference is booked.

### Refusals — Payment Applications
- "… : the person who prepared a payment application cannot approve it — approving it reserves company money (§5.2)." — a second person approves (a Super User may approve alone).
- "… is 'draft' and cannot become 'sent'. A payment application moves draft → approved → sent → confirmed → debited; it is rejected or cancelled, with a reason, before it is confirmed." — the step does not fit the current status.
- "… cannot go to the bank: … Fix the cause, or a manager may send it anyway with a reason, which is logged." — a check fails; the sentence in the middle says which. Typical causes: "No PD is registered for this import — the bank pays only against a validated PD."; "… has … IQD available against … IQD — deposit or draw the money first."; "Name the supplier bank account the money goes to."; "… is not verified — approve it on the supplier first."; "…: no B/L is recorded on the import yet — the bank pays this one against the B/L."
- "Give the date the file went to the bank." — fill Sent to bank.
- "… can no longer pay USD." — the paying account was closed or its currency changed since the draft; cancel and raise a new application.
- "Give the SWIFT date." / "Give the date the money was paid." / "Give the SWIFT (MT103) reference from the bank's copy." / "Give the cash voucher number." / "Give the cheque number." / "Give the bank's transfer reference." — fill the confirm dialog.
- "The money cannot have left on …, before the file went to the bank on …." — the confirmation date is before the Sent date.
- "… has no purchase order, so a deposit cannot be recorded against it. Post the invoice first and confirm again." — no invoice is posted and the import has no order; post the invoice, then confirm.
- "Give the date the statement shows the debit." / "A debit on … is before the payment was confirmed on …." — correct the debit date.
- "Say why … is rejected." / "Say why … is cancelled." — the reason is required.
- "… is blocked, so it cannot be paid (§15)." (or "is on hold") — on Confirm, when the supplier has been blocked or put on hold since the application was raised; the supplier's status must be put right first.
- "… was raised in the ERP; confirm it with the bank's copy, which posts the payment." / "… was migrated on …; money that left on … is confirmed with the bank's copy as any payment is, and posted." — Paid before the cut-over is only for migrated applications and only for a date on or before the migration day.
- "… is in USD; this payment is in IQD." / "…'s money is in …; a payment it funds is paid from there." / "… has USD … left to fund; this payment is USD …." / "…; its money has not arrived, so it funds nothing yet. Record the disbursement first." — loan funding rules: same currency, paid from the loan's account, within what the loan has left, and the loan disbursed.
- See also the refusals on creation listed under Import Applications (amount more than is left, wrong account currency or type, import cancelled or cleared, lane stopped).

## Supplier Advances (سلف الموردين)
Path: Payables → Supplier Payments & Credits → Supplier Advances   |   Arabic: الذمم الدائنة ← مدفوعات الموردين وأرصدتهم الدائنة ← سلف الموردين
Address: /payables/advances (one advance: /payables/advances/<advance number>)
Needs: `view` on `supplier_advance`. New advance request needs `create`; Approve needs `approve`; Pay needs `post` — on `supplier_advance`.
What it is for: Money paid to a supplier before the invoice — the deposits on imports (created automatically when a payment application is confirmed before any invoice is posted) and advances requested here against a purchase order. The **Unapplied** column is what is still the company's claim on the supplier.

### How to read the list — Supplier Advances
1. Open Payables → Supplier Payments & Credits → Supplier Advances; search with the box at the top.
2. Filter with **View** (العرض) and press **Show** (عرض): All (الكل), To approve (بانتظار الاعتماد), To pay (للدفع), Paid (مدفوعة), Settled (مسوّاة).
3. Columns: **Advance no.** (رقم السلفة) — click to open, with the import application's number beside it when the advance belongs to one; **Purchase order** (أمر الشراء); **Supplier** (المورد); **Requested** (تاريخ الطلب); **Paid** (تاريخ الدفع); **Amount (IQD)** (المبلغ (دينار)); **Unapplied** (غير المستخدم); **Status** (الحالة).

### How to request, approve and pay an advance — Supplier Advances
Needs: `create` to request, `approve` to approve, `post` to pay — on `supplier_advance`.
1. Press **New advance request** (طلب سلفة جديد).
2. Fill: **Purchase order** (أمر الشراء) — required; the supplier comes from the order. Orders that are Draft, Cancelled, Closed or Rejected are not offered. **Amount (IQD)** (المبلغ (دينار)) — required. **Requested** (تاريخ الطلب) — required; today by default. **Reason** (السبب) — optional.
3. Press **Request** (طلب). The advance is saved as Draft and opens on its page.
4. A different person, allowed to approve advances, presses **Approve** (اعتماد). The button is not shown to the person who requested it.
5. A user allowed to pay advances presses **Pay** (دفع), chooses **Paid from** (يُدفع من) — the bank or cash account — and **Paid** (تاريخ الدفع) — required, today by default — and presses **Pay**.

### Fields — Supplier Advances
- **Purchase order** (أمر الشراء) — required; the order the advance is paid against. The supplier is taken from the order.
- **Amount (IQD)** (المبلغ (دينار)) — required; in dinars, above zero.
- **Requested** (تاريخ الطلب) — required; today by default.
- **Reason** (السبب) — optional.
- Pay dialog — **Paid from** (يُدفع من): the bank or cash account the money leaves. **Paid** (تاريخ الدفع): required, today by default; the posting date of the payment.

### How to open a record and what it shows — Supplier Advances
Header: Advance no., Status, Purchase order (link), **Import application** (معاملة الاستيراد) (link), Supplier (link), Requested, Paid, Amount (in IQD, and in the import's currency for a foreign-currency deposit), **Requested by** (طلبها), **Approved by** (اعتمدها), **Paid by** (دفعها), Reason. Lines — **Settled against invoices** (مسوّاة مقابل الفواتير): Invoice (link), Date, Amount, Status. Foot: Amount and **Unapplied** (غير المستخدم). The four icons at the top work as described in Concepts.

### After you save — Supplier Advances
- Draft (مسودة) → Approved (معتمد) → Posted (مرحّل) when paid → Posted — partly paid / Settled (مسوّى) as it is used against invoices.
- **Pay** posts the journal: debit Supplier advance, credit the bank or cash account.
- An advance that belongs to an import is applied automatically when an invoice of that import is posted (oldest advance first, up to what the invoice owes); each use appears in "Settled against invoices" and reduces Unapplied.
- This page has no button to apply an advance to an invoice by hand or to record a refund. An unapplied advance stays visible under Supplier Credits.

### Refusals — Supplier Advances
- "State the amount of the advance in IQD." / "An advance of nothing is not an advance. State the amount to be paid." — type an amount above zero.
- "Purchase order … is 'draft', so no advance can be paid against it (§8.5)." — the order must be a commitment (not draft or cancelled).
- "… the person who requested an advance cannot approve it — approving it releases company money (§5.2)." — a second person approves (a Super User may approve alone).
- "… only a draft advance request can be approved." / "… an advance is paid once it has been approved." — follow the order Request → Approve → Pay.

## Supplier Credits (أرصدة الموردين الدائنة)
Path: Payables → Supplier Payments & Credits → Supplier Credits   |   Arabic: الذمم الدائنة ← مدفوعات الموردين وأرصدتهم الدائنة ← أرصدة الموردين الدائنة
Address: /payables/supplier-credits
Needs: `view` on `supplier_payment`
What it is for: A read-only list of the company's money that suppliers still hold: payments posted but not yet put against an invoice, advances paid but not yet applied, and credit notes posted but not yet applied. Nothing is typed here; each figure is read from its own document.

### How to read the screen — Supplier Credits
1. Open Payables → Supplier Payments & Credits → Supplier Credits; search with the box at the top.
2. Filter: **Kind** (النوع) — All kinds (كل الأنواع), Unallocated payment / overpayment (دفعة غير مخصصة / دفع زائد), Advance (سلفة), Credit note (إشعار دائن); **Supplier** (المورّد) — type the supplier code; press **Show** (عرض).
3. First table, one row per document: **Kind** (النوع); **Document** (المستند) — click to open the payment, advance or credit note; **Date** (التاريخ); Supplier Code; Supplier Name; Branch; **Amount** (المبلغ); **Applied** (المطبّق); **Unapplied** (غير المطبّق). Foot: **Total held with suppliers** (إجمالي ما لدى الموردين).
4. Second table **By supplier** (حسب المورّد): Supplier Code, Supplier Name, **Unallocated payments** (دفعات غير مخصصة), **Unapplied advances** (سلف غير مطبّقة), **Unapplied credit notes** (إشعارات دائن غير مطبّقة), **Total held** (إجمالي المحتفظ به), and a **Statement** (كشف الحساب) link that opens the supplier's statement.
5. To use a credit: open the payment and allocate it to an invoice (Supplier Payments), or open the credit note and press Apply (Supplier Credit / Debit Notes). An import's advance is applied automatically when its invoice is posted.

## Supplier Credit / Debit Notes (إشعارات الموردين الدائنة والمدينة)
Path: Payables → Supplier Payments & Credits → Supplier Credit / Debit Notes   |   Arabic: الذمم الدائنة ← مدفوعات الموردين وأرصدتهم الدائنة ← إشعارات الموردين الدائنة والمدينة
Address: /payables/credit-memos (one credit note: /payables/credit-memos/<note number>; a debit note opens under /payables/invoices/<invoice number>)
Needs: `view` on `supplier_credit_memo` or `view` on `ap_invoice` to open the list (a credit note's own page needs `view` on `supplier_credit_memo`). New credit note needs `create` on `supplier_credit_memo`; New debit note needs `create` on `ap_invoice`.
What it is for: Corrections to what is owed on a posted purchase invoice without goods moving. A **credit note** reduces it (a price allowance, a rebate, damaged goods the supplier does not want back). A **debit note** adds to it (a charge the invoice missed) — it is a purchase invoice linked to the one it adjusts. Credit memos that came with purchase returns are listed beside them.

### How to read the list — Supplier Credit / Debit Notes
1. Open Payables → Supplier Payments & Credits → Supplier Credit / Debit Notes; search with the box at the top.
2. Filter **Kind** (النوع) and press **Show** (عرض): All kinds (كل الأنواع), Credit note (إشعار دائن), Credit memo (return) (إشعار دائن (مرتجع)), Debit note (إشعار مدين).
3. Columns: **Note no.** (رقم الإشعار) — click to open; **Kind** (النوع); **Date** (التاريخ); Supplier Code; Supplier Name; **Invoice Number** — the invoice adjusted, and the purchase return when there is one; **Amount (IQD)** (المبلغ (د.ع)); **Applied / paid** (مطبّق / مدفوع); **Status** (الحالة).

### How to raise a credit note — Supplier Credit / Debit Notes
Needs: `create`, then `approve`, then `post` on `supplier_credit_memo` (Apply also needs `post`).
1. Press **New credit note** (إشعار دائن جديد).
2. Fill the form (see Fields) and press **Create** (إنشاء). The note is saved as Draft and opens on its page.
3. A different person, allowed to approve credit notes, presses **Approve** (اعتماد). A Super User may approve a note they raised themselves.
4. A user allowed to post credit notes presses **Post** (ترحيل). The credit is applied to its invoice up to what the invoice still owes; anything left stays **Unapplied** (غير مطبّق).
5. To use an unapplied remainder: on the posted note, in **Apply the credit** (تطبيق الرصيد), type the amount beside another open invoice of the same supplier (Invoice Number, Due Date, Outstanding are shown) and press **Apply** (تطبيق).

### How to raise a debit note — Supplier Credit / Debit Notes
Needs: `create` on `ap_invoice`; then `submit`, and `approve` plus `post`, on `ap_invoice` to get it posted.
1. Press **New debit note** (إشعار مدين جديد).
2. Fill the form (see Fields) and press **Create**. A Draft purchase invoice for the amount is created, linked to the invoice it adjusts, and opens on the Purchase Invoices record page.
3. Send it for approval, approve and post it, and pay it exactly like any purchase invoice. The original invoice's page lists it under "Credit and debit notes on this invoice".

### Fields — Supplier Credit / Debit Notes
- **Invoice it adjusts** (الفاتورة التي يعدّلها) — required; a posted purchase invoice, shown with its supplier and total.
- **Supplier's note no.** (رقم إشعار المورّد) — optional; as printed on the supplier's document. Left empty, the system's own number is used.
- **Date** (التاريخ) — required; today by default. The posting date of the note.
- **Amount (IQD)** (المبلغ (د.ع)) — required; more than zero. A credit note cannot be for more than the invoice's total.
- **Credit account** (الحساب الدائن) — credit note only, optional. Where the credit is booked; empty means "Purchase variance (as configured)" (فروقات أسعار الشراء (حسب الإعداد)).
- **Due date** (تاريخ الاستحقاق) — debit note only, optional; empty means it comes from the supplier's payment terms.
- **Expense account** (حساب المصروف) — debit note only, optional; empty means "As configured" (حسب الإعداد).
- **Reason** (السبب) — required.

### How to open a credit note and what it shows — Supplier Credit / Debit Notes
Header: Note no., Status, Kind, Supplier Code / Name (links), Invoice it adjusts (link), Purchase return (link, for a return's memo), Supplier's note no., Date, Branch, Amount (IQD), **Applied** (مطبّق), **Unapplied** (غير مطبّق), Credit account, Raised by, **Approved by** (اعتمده), **Posted by** (رحّله), **Journal entry** (قيد اليومية) and **Reversal entry** (قيد العكس) as links, Reason, and the reversal reason when reversed. Lines — **Where the credit went** (أين طُبّق الرصيد): Invoice Number, Date, Amount. The four icons at the top work as described in Concepts.

### How to cancel or reverse a credit note — Supplier Credit / Debit Notes
Needs: Cancel draft — `create`; Reverse — `reverse_cancel` (on `supplier_credit_memo`).
- **Cancel draft** (إلغاء المسودة) — on a Draft; type **Why it is cancelled** (سبب الإلغاء).
- **Reverse** (عكس) — on a Posted note; type **Why the note was wrong** (لماذا كان الإشعار خاطئاً). The journal is reversed and every application of the credit is taken back off its invoice.
- A credit memo that belongs to a purchase return cannot be approved, posted, cancelled or reversed here; it is corrected through the return.

### After you save — Supplier Credit / Debit Notes
- Credit note: Draft (مسودة) → Approved (معتمد) → Posted (مرحّل) → Reversed (معكوس); or Cancelled (ملغى) from Draft. Posting writes: debit Supplier payable, credit purchase variance (or the credit account named). The invoice's settled amount rises by what was applied, so the invoice may become "Posted — partly paid" or "Settled"; an unapplied remainder shows under Supplier Credits.
- Debit note: follows the purchase-invoice statuses; posting it debits expense and credits the supplier payable, and it ages and is paid as its own invoice.

### Refusals — Supplier Credit / Debit Notes
- "Invoice … is '…'. A credit note corrects a posted invoice; a draft is corrected by editing it." (same for a debit note) — choose a posted invoice.
- "A credit note is for a positive amount — what the supplier has agreed to credit." / "A debit note is for a positive amount — what the supplier charges on top." — type an amount above zero.
- "Invoice … came to … IQD; a credit note against it cannot be for more than the invoice." — reduce the amount.
- "A credit note says why the supplier is crediting. Give a reason." / "A debit note says why the supplier is charging more. Give a reason." — fill Reason.
- "… was raised by you; somebody else approves it." — a second person approves.
- "Credit note … is '…'; only a draft is approved." / "… a credit note posts once somebody has approved it." / "… only a draft is cancelled." / "… only a posted note is reversed." / "… only a posted credit is applied." — the action does not fit the status.
- "… credits a goods return and posted with it." / "… credits a goods return; it is corrected through the return." — a return's memo is handled on the return.
- "Nothing is mapped for purchasing.ap_invoice / purchase_variance, so … has no account to post to. Map it in Posting Mappings, or name the account on the note." — set the mapping or choose a Credit account.
- "… has … IQD left to apply; … was asked for." / "… owes … IQD; a credit settles a debt down to nothing and no further." — reduce the amount applied.
- "Invoice … is another supplier's. A credit settles only its own supplier's debts." / "Invoice … is …'s and the credit is …'s; a credit is applied within its branch." — apply to an invoice of the same supplier and branch.
- "Say why the draft is being cancelled." / "A reversal records why the credit note was wrong. Give a reason." — the reason is required.

## Suppliers (الموردون)
Path: Accounting → Master Data — Financial → Suppliers   |   Arabic: المحاسبة ← البيانات الرئيسية — المالية ← الموردون
Address: /payables/suppliers (one supplier's profile: /payables/suppliers/<supplier code>?role=supplier)
Needs: `view` on `business_partner`. New supplier needs `create`; editing details, roles and bank accounts needs `edit_draft`; approving a prospect and verifying a bank account need `approve`; sending a bank account for verification needs `submit`; deactivating or reactivating the supplier needs `administer` — all on `business_partner`.
What it is for: The supplier master — who the company buys from, one record per company. A company that is also a customer keeps one record with both roles. The profile shows the supplier's details, its bank accounts (each verified by a second person before money is sent to it) and its payables position.

### How to read the list — Suppliers
1. Open Accounting → Master Data — Financial → Suppliers (the supplier master moved there on 2026-10-06; the address is still /payables/suppliers); search with the box at the top.
2. Columns: **Code** (الرمز) — click to open the profile; **Legal name** (الاسم القانوني); **Status** (الحالة) — Prospect (محتمل), Active (نشط), On hold (موقوف مؤقتًا), Blocked (محظور), Inactive (غير نشط); **Payment terms** (شروط الدفع); **Contact** (وسيلة الاتصال) — email or phone; **Active** (نشط) — Active / Inactive (in use or not).

### How to add a supplier — Suppliers
Needs: `create` on `business_partner`. The supplier is Active at once only for a user who also holds `approve` on `business_partner`.
1. Press **New supplier** (مورد جديد).
2. Fill: **Legal name** (الاسم القانوني) — required; **Email** (البريد الإلكتروني); **Phone** (الهاتف); **Address** (العنوان). A new supplier is not asked for payment terms (since 2026-10-07): a purchase invoice's due date is set once the SWIFT is received; terms can still be added later on the supplier's **Update** form.
3. Press **Create** (إنشاء). The system gives the supplier its code; the code cannot be typed or changed.
4. If a company with exactly the same legal name already exists as a customer, no second record is made: that record is given the supplier role and keeps its code.
5. The new supplier is **Active** at once only if you are allowed to approve partners; otherwise it is a **Prospect** (محتمل) and must be approved before it can be used.

### How to approve a prospect — Suppliers
Needs: `approve` on `business_partner`.
A prospect is not offered in any supplier picker (purchase invoice, expense, payment, contract), and a purchase order against it is refused.
1. Open the supplier's profile. Under **Details** (التفاصيل), beside Status "Prospect", a user allowed to approve partners sees the button **Approve** (اعتماد); everybody else sees "awaiting approval" (بانتظار الاعتماد).
2. Press **Approve**. The status becomes Active and the supplier can be used on documents.

### Fields — Suppliers
- **Legal name** (الاسم القانوني) — required. The registered name; also used to detect duplicates.
- **Email** (البريد الإلكتروني), **Phone** (الهاتف) — optional contact details; an email or phone already on another partner counts as a possible duplicate.
- **Payment terms** (شروط الدفع) — not on the New supplier form (since 2026-10-07); optional on the supplier's **Update** form. A purchase invoice's due date is not taken from them any more: it is set once the SWIFT is received (Import Applications → the import → **Set due date**).
- **Address** (العنوان) — optional.
- **Code** (الرمز) — given by the system on saving; never typed.

### How to open a profile and what it shows — Suppliers
1. Click the code in the list (or the supplier's name on any payables record).
2. Top: the code, the legal name and a status pill; buttons **Account statement** (كشف الحساب) — opens Supplier Statements with this supplier chosen — and the **Audit log** (سجل التدقيق).
3. **Roles** (الصفات): Customer and Supplier, each Yes/No, with **Grant** (منح) / **Remove** (إزالة) for users who may edit; for a supplier, **Items supplied** (الأصناف المورَّدة).
4. **Details** (التفاصيل): Status (with Approve for a prospect), Email, Phone, Payment terms (link), Address, created date.
5. **Payables position** (موقف الذمم الدائنة) — shown to users who can view supplier payments: **Owed on open invoices** (المستحق على الفواتير المفتوحة) — opens Payables Ageing for this supplier; **Open invoices** (الفواتير المفتوحة) — the count; **Held with the supplier (credits)** (المحتجز لدى المورّد) — unallocated payments + unapplied advances + unapplied credit notes, opens Supplier Credits; **Net position** (صافي الموقف) — owed less held; **Credit / debit notes** — "Open the register" (فتح السجل).
6. **Update** (تحديث) — the edit form: Legal name, Email, Phone, Payment terms, Address; press **Save** (حفظ).
7. **Bank accounts** (الحسابات المصرفية) — the supplier's accounts: Bank, SWIFT / BIC, Account no. / IBAN, Currency, Account holder (beneficiary), Status, and "Default" (الافتراضي) on the default one. Click a row to open that account's details and actions.
8. A deactivate / reactivate panel for users allowed to administer partners.

### How to add and verify a supplier bank account — Suppliers
Needs: `edit_draft` to add, make default or take out of use; `submit` to send for verification; `approve` to verify or send back — on `business_partner`.
SWIFT and transfer payment applications pass the bank check only with a verified supplier account.
1. On the profile press **Add bank account** (إضافة حساب مصرفي) and enter the account as it is on the supplier's bank letter: **Bank from the bank list** (البنك من قائمة البنوك) or "Not on the list" (غير موجود في القائمة) with **Bank name** (اسم البنك); **Branch** (الفرع); **Bank address** (عنوان البنك); **Account holder (beneficiary)** (صاحب الحساب (المستفيد)) — opens on the supplier's legal name; **Currency** (العملة); **Account number** (رقم الحساب) — may be empty when the IBAN is given; **IBAN** — checked for its country's length and check digits; **SWIFT / BIC** — 8 or 11 characters; **Intermediary bank** (البنك الوسيط) and its SWIFT / BIC; **Note** (ملاحظة). Tick **The same account is on another partner — I have checked, and it is right** only when the system reported that the account number already exists on another partner.
2. Press **Add bank account**. The account is saved as Draft (مسودة) and is not used yet.
3. Open the account (click its row) and press **Send for verification** (إرسال للتحقق). Status: Awaiting verification (بانتظار التحقق).
4. A different person, allowed to approve partners, opens it and presses **Verify** (تحقق). Status: Verified (تم التحقق). The first verified account becomes the default. The person who entered the account does not see the Verify button and sees "You entered or sent this account, so somebody else verifies it."
5. The verifier can instead press **Send back** (إعادة) with **What is wrong with it** (ما الخطأ فيه); the account returns to Draft.
6. On a verified account that is not the default press **Make default** (جعله الافتراضي) to make it the one payments prefer.
7. To stop using an account press **Take out of use** (إخراج من الاستخدام) with **Why it is taken out of use**; this is final — add the account again as a new one if needed.

### How to deactivate or reactivate a supplier — Suppliers
Needs: `administer` on `business_partner`.
On the profile, in **Deactivate this partner** (إلغاء تنشيط الطرف), type the **Reason** (السبب) and press **Deactivate** (إلغاء التفعيل). A deactivated supplier is not offered on new documents. **Reactivate** (إعادة التفعيل) brings it back.

### After you save — Suppliers
A supplier's status is Prospect (محتمل) → Active (نشط) once approved; On hold (موقوف مؤقتًا), Blocked (محظور) and Inactive (غير نشط) also exist. Separately, the in-use switch shows Active / Inactive. Only a supplier that is both Active in status and in use is offered on purchase documents. Nothing is posted to the accounts from this screen; every change is written to the audit log.

### Refusals — Suppliers
- "legalName: '…' is already a supplier (…)" — a supplier with this exact name exists; open that record.
- "This looks like an existing partner: … (matched on name / email / phone). Use the existing record, or confirm this is genuinely a different party." — the name, email or phone matches another partner. Open the existing record; if it is the same company with another role, grant it the Supplier role on its profile. The New supplier form has no confirmation tick, so a genuinely different company with the same email or phone has to be entered with different contact details.
- "… is prospect, so a purchase order cannot be raised against them (§6)…" — approve the supplier on its profile.
- "status: is active; only a prospect is approved" — it was already approved.
- "active: the partner is deactivated; reactivate it before approving it" — reactivate first.
- "reason: is required to deactivate a partner" — type the reason.
- "role: a partner must be a customer, a supplier, or both — this is their only role" — the last role cannot be removed.
- "role: is the named supplier of at least one item" — remove the supplier from those items before removing the Supplier role.
- "paymentTermsCode: is not a known payment term" / "is not active" — choose active payment terms.
- "Name the bank, or choose it from the bank list." / "Give the account number or the IBAN." / "… is not an active currency." — complete the bank account form.
- "… is not an IBAN: two letters for the country, two check digits, then the account." / "An IBAN from … has … characters; … has …." / "… fails its check digits — a character is mistyped." — correct the IBAN.
- "… is not a SWIFT/BIC code: 8 or 11 characters…" — correct the SWIFT code.
- "… is already one of this partner's bank accounts." — the account is already on this supplier.
- "This looks like an existing partner: … (matched on bank account number)…" — the same account is on another partner; check, then tick the confirmation box and save again.
- "You cannot approve a document you raised. This step requires a different approver (Appendix B)." — the person who entered a bank account cannot verify it.
- "Only a verified account in use can be the default." / "This bank account was taken out of use; it cannot be verified." / "This bank account is already out of use." — the action does not fit the account's state.
- "Say what is wrong with the details, so they can be corrected." / "Say why the account is taken out of use." — the reason is required.

## Supplier Statements (كشوف حسابات الموردين)
Path: Payables → Supplier Balances → Supplier Statements   |   Arabic: الذمم الدائنة ← أرصدة الموردين ← كشوف حسابات الموردين
Address: /payables/supplier-statements (a supplier already chosen: /payables/supplier-statements?code=<supplier code>)
Needs: `view` on `business_partner`
What it is for: A read-only account statement for one supplier over a period — every posting on the supplier's account with a running balance — and, underneath, what is still open on its invoices. Purchases are Credit; payments and credits are Debit. With no supplier chosen the lower part lists every supplier's position.

### How to run a statement — Supplier Statements
Needs: `view` on `business_partner`; PDF needs `print` and Excel / Word need `export` on `business_partner`.
1. Open Payables → Supplier Balances → Supplier Statements.
2. Set **From** (من) and **To** (إلى) — they open on 1 January and 31 December of the current year.
3. Choose **Report currency** (عملة التقرير): IQD or USD.
4. In **Supplier** (مورد) type the supplier's code or name, or pick one from the suggestions.
5. Optionally narrow the lower table with **Show** (العرض): All (الكل), Falling due soon (يستحق قريباً), Overdue only (المتأخر فقط), Not yet paid (لم يُسدَّد بعد), Part paid (مسدَّد جزئياً).
6. Press **Run** (عرض).
7. To print or export, use **Print / Export** (طباعة / تصدير) at the top — offered once a supplier is chosen.

### What the statement shows — Supplier Statements
- Statement table: **Date** (التاريخ); **Document** (المستند) — a link to the purchase invoice, supplier payment or purchase return, or to the journal entry when the posting has no document; **Due Date**; **How late** (مدة التأخر) — "N days overdue" or "Due in N days", measured at the statement's end date (or today if the end date is in the future); **Description** (الوصف); **Debit**, **Credit** and running **Balance** (مدين / دائن / الرصيد) in the report currency.
- The first row is the **Opening balance** (الرصيد الافتتاحي) — everything before the From date; the last row is the **Closing balance** (الرصيد الختامي) with total debit and total credit.
- **Invoice Balances** (أرصدة الفواتير), "Open as at <date>": with a supplier chosen, its open invoices — Invoice Number (link), Invoice Date, Due Date, **Payment terms** (شروط الدفع), Total Price (IQD), **Paid** (المدفوع), **Outstanding** (المتبقي), **Status against terms** (الحالة مقابل الشروط). With no supplier chosen, one row per supplier — Supplier (the name opens its statement, the code its profile), number of invoices, **Gross Payables** (إجمالي الذمم الدائنة للموردين), **Overdue** (متأخرة), **Unapplied Supplier Credits / Advances** (أرصدة الموردين الدائنة / الدفعات المقدمة غير المطبقة), **Other Non-invoice Debits** (مدين غير مرتبط بفواتير أخرى), **Net Supplier Position** (صافي رصيد المورد).
- Foot of that window: Gross Payables, Not Yet Due (غير مستحقة بعد), Overdue, Unapplied Supplier Credits / Advances, Other Non-invoice Debits, Net Supplier Position, and the ageing buckets: Not yet due (لم تستحق بعد), 1–30 days late, 31–60 days late, 61–90 days late, Over 90 days late.
- When a supplier holds credits, a small table **Supplier Credits / Advances** shows "On account since" (الرصيد قائم منذ) and the "Credit / advance balance".

### Messages — Supplier Statements
- "Choose a supplier to read their account." (اختر موردًا لقراءة حسابه) — nothing was typed in Supplier.
- "No Supplier matches that. Type a code or a name, or pick one from the list." — the text matches nobody.
- "That could be more than one Supplier. Type more of the code or the name." — the text matches several suppliers.
- "Nothing posted to this account in the period." — the supplier has no postings between From and To.

## Payables Ageing (أعمار الذمم الدائنة)
Path: Payables → Supplier Balances → Payables Ageing   |   Arabic: الذمم الدائنة ← أرصدة الموردين ← أعمار الذمم الدائنة
Address: /payables/open-items (one supplier: /payables/open-items?code=<supplier code>)
Needs: `view` on `ap_invoice`
What it is for: A read-only report of what the company owes suppliers, invoice by invoice, and how late each one is, as at a chosen date — with the unapplied credits and the check that the invoices tie to the supplier accounts in the ledger.

### How to run the report — Payables Ageing
Needs: `view` on `ap_invoice`; PDF needs `print` and Excel / Word need `export` on `ap_invoice`.
1. Open Payables → Supplier Balances → Payables Ageing.
2. Optionally type a supplier code or name in the first box ("Everybody — or type a name or code"); empty means every supplier.
3. Set **As at** (كما في) — required; today by default. The report shows what was open on that date.
4. Choose **Show** (العرض): All, including paid (الكل، بما في ذلك المدفوع); Still owed (ما زال مستحقاً); Overdue only (المتأخر فقط).
5. Press **Show** (عرض).
6. Use **Print / Export** (طباعة / تصدير) at the top for PDF / Excel / Word.

### What the report shows — Payables Ageing
- **Invoice Balances** (أرصدة الفواتير), "Open as at <date>": **Supplier Name**; **Invoice Number** (link to the invoice); **Invoice Date**; **Due Date**; **Payment terms** (شروط الدفع); **Total Price (IQD)**; **Paid** (المدفوع) — everything settled on the invoice so far; **Outstanding** (المتبقي); **Status** (الحالة); **Status against terms** (الحالة مقابل الشروط) — "N days overdue" (متأخرة N يوماً), "Due in N days" (تستحق خلال N يوماً), "Paid on time" (دُفعت في موعدها) or "Paid N days late". A totals row sums Total, Paid and Outstanding.
- **Supplier Credits / Advances** (أرصدة الموردين الدائنة / الدفعات المقدمة) — suppliers holding money of ours: "On account since" and the balance; the supplier's name opens its statement.
- **Other Non-invoice Debits** — balances on a supplier's account that come from no invoice.
- **Supplier credits / advances reconciliation** (تسوية أرصدة الموردين الدائنة / الدفعات المقدمة) — the ageing: one row "Invoice Balances" spread over **Not yet due** (لم تستحق بعد), **1–30 days late**, **31–60 days late**, **61–90 days late**, **Over 90 days late** (with the number of invoices in brackets) and **Totals**. Foot: Gross Payables, Not Yet Due, Overdue, Unapplied Supplier Credits / Advances, Other Non-invoice Debits, Net Supplier Position, **Ledger balance** (رصيد الدفتر).
- The strip at the bottom says **Ties to the statement** (مطابق لكشف الحساب) when the invoices, credits and other debits add up to the ledger balance, or **Difference is listed above** (الفرق مُبيَّن أعلاه) when they do not.
- Buckets are calculated from invoice balances only, by days past the due date.

### Messages — Payables Ageing
- "Nothing matches — no invoice is outstanding for this date." — nothing to show for the choices made.
- "No Supplier matches that…" / "That could be more than one Supplier…" — the supplier box does not identify one supplier.

## Supplier Reconciliation (تسوية حسابات الموردين)
Path: Payables → Supplier Balances → Supplier Reconciliation   |   Arabic: الذمم الدائنة ← أرصدة الموردين ← تسوية حسابات الموردين
Address: /payables/reconciliation
Needs: `view` on `ap_invoice`
What it is for: A read-only check that the supplier subledger (what the documents say is owed to each supplier) equals the A/P control accounts in the General Ledger. Where it does not, the journal lines behind the difference are listed. Nothing is corrected on this screen.

### How to read the screen — Supplier Reconciliation
1. Open Payables → Supplier Balances → Supplier Reconciliation.
2. Set **As of** (حتى تاريخ) — today by default — and press **Show** (عرض).
3. **Control accounts** (الحسابات الرقابية): one row per supplier control account — **Account** (الحساب, link), **Account name** (اسم الحساب), **Supplier subledger** (دفتر الموردين الفرعي), **A/P control account** (حساب الذمم الدائنة الرقابي), **Difference** (الفرق), with totals. Above the table one line says either "Subledger equals the control account: <amount>" or "Difference of <amount> — see the lines below".
4. **Investigation** (التحقيق): every journal line that explains a difference — **Why** (السبب): No supplier on the line (لا مورّد على القيد), Amounts differ (المبالغ مختلفة), Filed under another account (مسجّل تحت حساب آخر), Journal not posted (القيد غير مرحّل); **Journal entry** (link); Invoice Date; Status; Account; Supplier Code; Description; **Line (Dr − Cr)**; **Subledger (Dr − Cr)**. When there is none: "Every journal line on a supplier control account has its subledger entry, and they agree."
5. **By supplier** (حسب المورّد): Supplier Code, Supplier Name, **A/P control account** (the supplier's ledger balance), **Open invoices** (الفواتير المفتوحة), **Unapplied Supplier Credits / Advances**, **Other Non-invoice Debits**, and a **Statement** (كشف الحساب) link; totals at the foot.
6. To fix a difference open the journal entry named in Investigation and decide there (typically a manual journal posted to a supplier control account without naming the supplier). "Nothing here is corrected automatically: open the entry and decide."
7. If the first table says "No account is designated as a supplier control account." the chart of accounts has no account marked as a supplier control account.
