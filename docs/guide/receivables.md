# Receivables — user guide

The Receivables module (الذمم المدينة) holds everything a customer owes the company and how it gets settled. Its one menu heading is Sales & Receivables (المبيعات والذمم المدينة), and the screens follow the life of a debt:
a **customer** is entered and approved → a **sales invoice** bills them and, when posted, takes the goods out of the warehouse → a **customer receipt** records the money and is allocated to invoices → anything paid or credited beyond what is owed sits as a **credit or advance** until it is applied → **credit notes, debit notes and sales returns** correct what was billed → the **statement**, the **ageing** and the **reconciliation** read the result and change nothing.
Documents are raised in Iraqi dinars (IQD). A posted document is never edited: it is reversed, or corrected with a note or a return.
The Monitoring module (المتابعة) is described at the end; its three screens are drawn but show only "Coming soon".

## Concepts — Receivables

### Statuses — Receivables concepts
Every document shows its status as a coloured chip, in the list and in the first row of the record.
- **Draft** (مسودة) — saved, nothing in the ledger yet. Lines of a draft sales invoice can still be changed.
- **Pending approval** (بانتظار الموافقة) — used by Sales Returns: the return has been raised and waits for Accept or Reject.
- **Approved** (معتمد) — approved, not yet in the ledger (invoices, receipts, notes). For a Sales Return it means accepted: the goods are back and the customer has been credited.
- **Posted** (مرحّل) — in the ledger. For an invoice or debit note: owed and nothing received yet. For a receipt or credit: in the books, with something still left to apply.
- **Posted — partly paid** (مُرحَّلة — مدفوعة جزئيًا) — part of it has been settled (an invoice or debit note partly paid; a credit note or credit memo partly applied).
- **Settled** (مسوّى) — fully settled: an invoice or debit note paid in full, or a receipt / credit note / credit memo applied in full.
- **Rejected** (مرفوض) — a Sales Return that was refused; nothing moved.
- **Cancelled** (ملغى) — a draft note that was cancelled; nothing was posted.
- **Reversed** (معكوس) — a posted document that was undone by a mirrored journal.
The status moves by itself when money or credit is applied: nobody sets "paid" by hand.

### Approve and post are two steps — Receivables concepts
A sales invoice, a customer receipt and a credit or debit note all go **Draft → Approve → Post**. Approve (اعتماد) only marks the document as agreed. Post (ترحيل) writes the journal (and, for a sales invoice, takes the stock out). Each step is a separate permission, so the Approve button and the Post button appear only for people who hold that permission; a button that is missing means you do not hold the permission or the document is not in the right status. On these screens the system checks the permission only — it does not compare the approver with the person who raised the document.

### What each document posts — Receivables concepts
- Sales invoice, on Post: Debit Customer receivable / Credit Revenue for the invoice total; and for the goods, Debit Cost of goods sold / Credit Inventory at the stock's first-in-first-out cost. The stock leaves the warehouse in the same step.
- Customer receipt, on Post: Debit the bank or cash account the money went into / Credit Customer receivable.
- Credit note, on Post: Debit Sales returns and allowances (or the account chosen on the note) / Credit Customer receivable.
- Debit note, on Post: Debit Customer receivable / Credit Revenue (or the account chosen on the note).
- Sales return, on Accept: the goods come back, Debit Inventory / Credit Cost of goods sold at the cost they left at; and a credit memo is posted, Debit Sales returns / Credit Customer receivable (or Credit the bank or cash account when the refund is paid from the bank).
- Allocating a receipt or applying a credit posts no journal: it only records which debt the money or credit settled.

### Customer credit and advance — Receivables concepts
A customer's credit is never typed in; it is worked out from documents: what is left of a posted receipt that was not allocated (an **advance** when none of it was used, an **overpayment** when part was), what is left of a credit note, and what is left of a sales return's credit memo. Credits are kept apart from invoices — a customer with a 100,000 invoice and a 5,000,000 advance shows gross receivables 100,000 and a net position of −4,900,000, never a negative invoice. A credit is put against an invoice or a debit note on the Customer Credits & Advances screen.

### The four icons at the top of a record — Receivables concepts
Every receivables record (sales invoice, receipt, credit / debit note, credit memo, sales return) carries four small icons in its title bar, from the moment it is a draft:
1. **Printer** — Print / Export (طباعة / تصدير): downloads the document as PDF, Excel (.xlsx) or Word (.docx), in English or العربية. PDF needs the print permission on that document, Excel and Word need the export permission; a format you may not have is not offered. A document that is not posted prints with the mark DRAFT / NOT POSTED (مسودة / غير مرحّل).
2. **Paperclip** — Attachments (المرفقات): the files attached, with a count on the icon. Press **Choose a file** (اختر ملفاً), then **Attach** (إرفاق). Up to 25MB per file; programs and archives (.exe, .zip, .rar and similar) are refused.
3. **Speech bubble** — Notes (الملاحظات): what people wrote about the record (When / Who / Note), newest first. Type in **Add note** (إضافة ملاحظة) and press the button. A note is dated and signed and can never be edited or deleted; at most 2,000 characters.
4. **Clock** — Audit log (سجل التدقيق): everything that happened to the record — who, when, what changed.
The customer's own profile page is different: it has an **Account statement** button and an **Audit log** button instead of the four icons.

### Branch — Receivables concepts
A new invoice, receipt or note is raised in your Active branch (in your own menu, behind your picture in the top bar). On a new sales invoice only that branch's warehouses are offered. The registers (Sales Invoices, Customer Receipts, Credit Notes / Debit Notes, Sales Returns) list the documents of every branch you are allowed to see. Customer Credits & Advances, the open balances under Customer Statements and the By customer table of Customer Reconciliation read your Active branch; Receivables Ageing has its own Branch filter. To look at another branch, change the Active branch first.

### Searching a register — Receivables concepts
Every register has a search box, **Search this list** (ابحث في هذه القائمة). Type and press Enter or the magnifier: the list keeps the rows where any value contains what you typed — number, customer code or name, a date typed as 2026-10-04, an amount, or the status word in English (draft, approved, posted, settled, reversed). **Clear** (مسح) removes the search. The count beside it ("12 records") is the number of rows shown.

### Messages and common refusals — Receivables concepts
After an action the page shows **Saved.** (تم الحفظ.) or **That could not be saved.** (تعذّر الحفظ.) followed by the reason. The reason is written in English even when the screen is in Arabic. Reasons that can appear on any receivables document:
- "Permission denied: 'post' on 'ar_invoice' is not granted to this user." — you lack that permission (the two words in quotes name the action and the document type). Ask an administrator, or ask a colleague who holds it to do the step.
- "Out of scope: this user has no access to branch 'X'." — the document belongs to a branch you are not assigned to.
- "A ar_invoice cannot move from 'draft' to 'posted'. From 'draft' it may move to: approved, cancelled." — the step was tried in the wrong order (here: approve first, then post).
- "Cannot post into <period>: the period is closed. A closed period is final — the correction belongs in an open period (§3.2)." — the posting date falls in a closed accounting period. Use a date in an open period, or have the period reopened by Finance.
- "Cannot post into <period>: the period is soft-closed. Only a Finance Manager may post an approved adjustment into it (§14.6)."
- "No accounting mapping is configured for the '<line>' line of '<event>' … Configure the mapping in Accounting Mapping" — Finance has not said which account this kind of posting uses. Ask Finance to complete the accounting mapping, then post again.
- "<file> was not accepted: it is 30MB; the limit is 25MB." / "…files ending .zip are not accepted (§21)." / "…it is named .pdf but its content is image/png. The name and the file disagree." — attachment refusals; attach a smaller or proper file.
- "A note says something. Write what is happening with this record." / "A note is at most 2,000 characters. Attach a longer text as a file." — note refusals.

## Customers (العملاء)
Path: Accounting → Master Data — Financial → Customers   |   Arabic: المحاسبة ← البيانات الرئيسية — المالية ← العملاء
Address: /sales/customers (list) · /sales/customers/<customer code>?role=customer (profile)
Needs: `view` on `business_partner` to open; `create` to add a customer; `edit_draft` to see the Update form and the Grant / Remove role buttons; `approve` to approve a prospect and to save the Update form; `administer` to deactivate or reactivate.
What it is for: The customer master — who the company sells to. A customer and a supplier are the same record with two roles, so a company that both buys and sells appears on both lists. A customer must be Active (approved and in use) before it can be chosen on an invoice, a receipt or a note.

### How to add a customer — Customers
1. Open Accounting → Master Data — Financial → Customers (the customer master moved there on 2026-10-06; the address is still /sales/customers).
2. Press **New customer** (عميل جديد) at the top. A dialog opens.
3. Type the **Legal name** (الاسم القانوني). Optionally fill **Email** (البريد الإلكتروني), **Phone** (الهاتف) and the **Address** (العنوان). The New customer form does not ask for payment terms (since 2026-10-06): a customer is created with none, so its sales invoices fall due on the invoice date. Terms can still be set later on the profile's **Update** form if a customer ever needs them.
4. Press **Create** (إنشاء). The system gives the customer its code; you cannot type it.
5. The customer's profile opens with "Saved.". If you hold the approval permission the customer is **Active** (نشط) at once; otherwise it is a **Prospect** (محتمل) and shows "awaiting approval" (بانتظار الاعتماد) until somebody approves it.
If the name you type is exactly the legal name of an existing supplier, no second record is made: that supplier is given the customer role and its profile opens.

### How to approve a prospect — Customers
1. Open the customer's profile (press its code in the list).
2. In the **Details** (التفاصيل) panel, beside Status "Prospect", press **Approve** (اعتماد). The button shows only to people who may approve.
3. The status becomes **Active** and the customer can now be chosen on documents.

### How to open and read a customer profile — Customers
1. In the Customers list press the customer's **Code**. (On the receivables registers and records the customer's code is a link to the same profile.)
2. The profile shows: a card with the name, the code and a status pill; **Roles** (الصفات) — Customer and Supplier, each Yes / No; **Details** — Status, Email, Phone, Payment terms (a link to the terms), Address, Created; the **Update** (تحديث) form; **Old books** (الدفاتر القديمة) when the old system held history for this partner; and the **Audit log** (سجل التدقيق) at the bottom.
3. **Account statement** (كشف الحساب) at the top opens Customer Statements with this customer already chosen. **Audit log** jumps to the log at the bottom of the page.
Every customer has a **Bank accounts** (الحسابات المصرفية) panel: add the customer's accounts there with **Add bank account** (إضافة حساب مصرفي); each is sent for verification and verified by a second person, as for a supplier (see Suppliers › How to add and verify a supplier bank account). A partner that is also a supplier additionally shows **Items supplied** (الأصناف المورَّدة).

### How to edit a customer — Customers
1. Open the profile. In the **Update** (تحديث) panel change Legal name, Email, Phone, Payment terms or Address.
2. Press **Save** (حفظ). "Saved." confirms it; the change is written to the Audit log with the old and the new value.
The code can never be changed.

### How to give or remove the customer role — Customers
1. Open the profile. In **Roles**, beside Customer or Supplier, press **Grant** (منح) or **Remove** (إزالة).
2. A partner must keep at least one role. After removing the Customer role the page reopens as the supplier's profile.

### How to deactivate or reactivate a customer — Customers
1. Open the profile. In the panel **Deactivate this partner** (إلغاء تنشيط الطرف) type the **Reason** (السبب) and press **Deactivate** (إلغاء التفعيل). The panel shows only to people who may administer partners.
2. A deactivated customer shows **Inactive** (غير نشط) and is no longer offered on new documents; its history and statement remain.
3. To bring it back press **Reactivate** (إعادة التفعيل) in the same panel.

### How to search the customer list — Customers
Type in **Search this list** (ابحث في هذه القائمة) and press Enter: the list keeps rows whose code, name, e-mail, phone, payment terms or status contain the text. **Clear** (مسح) shows everything again. The list columns are Code (الرمز), Legal name (الاسم القانوني), Status (الحالة), Payment terms (شروط الدفع), Contact (وسيلة الاتصال — the e-mail, or the phone when there is no e-mail) and Active (نشط).

### Fields — Customers
- **Legal name** (الاسم القانوني) — the company's registered name. Required. It is the name shown on every document and statement.
- **Email** (البريد الإلكتروني) — optional; must look like an e-mail address.
- **Phone** (الهاتف) — optional.
- **Payment terms** (شروط الدفع) — not on the New customer form; optional on the profile's Update form, chosen from the active payment terms, or **No terms set** (بلا شروط). It decides the due date proposed on this customer's sales invoices and debit notes ("When their invoices fall due."). With no terms — every customer created since 2026-10-06 — the due date is the invoice date.
- **Address** (العنوان) — optional, free text.
- **Code** (الرمز) — given by the system on saving; never typed, never changed.
- **Status** (الحالة) — Prospect (محتمل), Active (نشط), On hold (موقوف مؤقتًا), Blocked (محظور), Inactive (غير نشط). Only an Active customer that is also in use can be chosen on documents. The screen sets Prospect or Active on creation and Active on approval; it has no button for On hold or Blocked.
- **Active** (نشط) / **Inactive** (غير نشط) — the in-use switch, changed by Deactivate / Reactivate.

### After you save — Customers
A new customer is Active when its maker may approve partners, otherwise a Prospect. A Prospect cannot be chosen on a sales invoice, receipt, note or return until somebody with the approval permission presses Approve on its profile. Nothing is posted to the ledger by this screen. Every change is kept in the Audit log.

### Refusals — Customers
- "legalName: is required" — type the legal name.
- "legalName: 'X' is already a customer (CUS-…)" — that company is already on the list; open the existing record instead.
- "This looks like an existing partner: <code> <name> (matched on email, phone). Use the existing record, or confirm this is genuinely a different party." — another partner has the same e-mail, phone or (nearly) the same name. The New customer dialog has no box to confirm it is a different party, so either open the existing record and grant it the Customer role, or leave out / correct the e-mail or phone that matched.
- "paymentTermsCode: is not a known payment term" / "paymentTermsCode: is not active" — choose terms that are active.
- "Permission denied: 'approve' on 'business_partner' is not granted to this user." — shown when saving the Update form, or approving, without the approval permission. Ask somebody who may approve partners to make the change.
- "status: is active; only a prospect is approved" — the customer is no longer a prospect; nothing to approve.
- "active: the partner is deactivated; reactivate it before approving it".
- "role: a partner must be a customer, a supplier, or both — this is their only role" — grant the other role first, or deactivate the partner instead.
- "role: is the named supplier of at least one item" — the supplier role cannot be removed while items name this supplier.
- "reason: is required to deactivate a partner" — type why.

## Sales Invoices (فواتير المبيعات)
Receivables → Sales & Invoices → Sales Invoices   |   Arabic: الذمم المدينة ← المبيعات والفواتير ← فواتير المبيعات
Address: /sales/ar-invoices (list) · /sales/ar-invoices/new · /sales/ar-invoices/<invoice number>
Needs: `view` on `ar_invoice` to open; `create` to raise; `edit_draft` to change a draft's lines or accounts and to add a note; `approve` to approve; `post` to post, together with `execute` on `inventory_movement` because posting moves the stock; `approve` + `edit_draft` to return an approved invoice to draft; `reverse_cancel` on `ar_invoice`, `inventory_movement` and `journal_entry` to reverse; `print` / `export` for copies; `create` on `attachment` to attach a file.
What it is for: Billing a customer for goods sold from a warehouse. Posting the invoice creates the customer's debt, books the revenue and takes the goods out of stock at their cost.

### How to raise a sales invoice — Sales Invoices
1. Open Receivables → Sales & Invoices → Sales Invoices and press **New invoice** (فاتورة جديدة).
2. In the header type the **Customer Code** (رمز العميل) or the **Customer Name** (اسم العميل) and pick the customer from the suggestions — either box fills the other. Only active, approved customers are offered.
3. Check the **Invoice Date** (تاريخ الفاتورة) — it opens on today.
4. The **Due Date** (تاريخ الاستحقاق) fills itself from the customer's payment terms as soon as the customer and the date are known. Overtype it if this invoice has a different due date.
5. Leave **Receivable account (statement)** (حساب الذمم المدينة (كشف الحساب)) and **Revenue account** (حساب الإيراد) as they open unless Finance told you otherwise.
6. In **Lines** (البنود) type the **Item Code** (رمز الصنف) or **Item Name** (اسم الصنف), the **Quantity** (الكمية), the **Unit Price (IQD)** (سعر الوحدة (د.ع)) — it opens on the item's selling price — an optional **Discount** (الخصم), an optional **Supplier** (المورّد) and the **Warehouse** (المخزن). Under the quantity the screen shows **Available stock** (المخزون المتاح) for that item and warehouse.
7. Filling a line opens the next empty one. To drop a line press the ✕ at its end (**Remove line** — حذف البند).
8. Press **Create** (إنشاء). The invoice gets its number and opens as a **Draft**. Nothing is in the ledger and no stock has moved yet.
If the form shows a sentence instead of the fields (for example "Add a customer first." or "Set up a warehouse first."), that master data is missing — see Refusals.

### How to change a draft invoice — Sales Invoices
1. Open the draft from the list (press its number).
2. Type straight into the lines grid. A line saves itself when it is complete and you leave it ("saving…" shows briefly); a new empty line is always at the foot. Remove a line with ✕.
3. To change where it posts, choose another **Receivable account (statement)** or **Revenue account** in the header and press **Save accounts** (حفظ الحسابات).
The customer, the posting date and the due date cannot be changed after the invoice is created. If one of them is wrong, raise a new invoice.

### How to approve a sales invoice — Sales Invoices
1. Open the draft invoice and check its lines and total.
2. Press **Approve** (اعتماد) at the foot of the document. The button shows only to people who may approve sales invoices.
3. The status becomes **Approved** and **Approved by** (اعتمدها) shows the approver's name. The lines are now locked.

### How to post a sales invoice — Sales Invoices
1. Open the approved invoice and press **Post** (ترحيل).
2. The status becomes **Posted**; **Posted by** (رحّلها) shows who posted. The journal is written, the stock leaves the warehouse, and the invoice now appears on the customer's statement and in the ageing.

### How to send an approved invoice back to draft — Sales Invoices
1. Open the approved (not yet posted) invoice.
2. Type the reason in the box beside the button (placeholder "Why — this is kept in the audit trail") and press **Return to draft** (إعادة إلى المسودة).
3. The invoice is a Draft again, the approval is cleared, and it needs a fresh approval after correction.

### How to reverse a posted invoice — Sales Invoices
1. Open the posted invoice. **Reverse invoice** (عكس الفاتورة) is offered only while nothing has been received against it.
2. Type **Why the invoice was wrong** (سبب خطأ الفاتورة) and press **Reverse invoice**.
3. The journal is mirrored, the goods go back to the warehouse at the cost they left at, and the status becomes **Reversed**. The reversal is dated the day it is made, so the current accounting period must be open.
Use a reversal when the invoice itself was a mistake; use a Sales Return when the customer sends goods back, and a credit note for a price allowance.

### How to open a record and what it shows — Sales Invoices
1. In the list press the invoice number. List columns: Reference (المرجع), Invoice Date (تاريخ الفاتورة), Due Date (تاريخ الاستحقاق), Customer Code, Customer Name, Amount (المبلغ), Status (الحالة).
2. The record shows the header (Invoice Number, Status, Customer Code and Name — links to the customer's profile — Invoice Date, Due Date, the two accounts, **Raised by** (أنشأها), **Approved by** (اعتمدها), **Posted by** (رحّلها)), the lines and the **Total Price (IQD)**.
3. **Revenue accounts** (حسابات الإيرادات): for each line, the account its revenue goes to and **Selected by** (مصدر الاختيار) — Document account (حساب المستند), Configured exception (استثناء محاسبي مهيأ), Item sales account (حساب مبيعات الصنف), General mapping (الربط العام) or Recorded journal (القيد المسجل). On a posted invoice these are the accounts on its journal.
4. **Settlement** (التسوية), once posted: Payment terms, Invoice Date, Due Date, Total Price, Paid (المدفوع), Outstanding (المتبقي), Last payment (آخر دفعة) and **Status against terms** (الحالة مقابل الشروط) — "Due in 6 days", "11 days overdue", "Paid 3 days late" or "Paid on time" — with each payment listed.
5. **Receipts, credits and returns** (المقبوضات والأرصدة الدائنة والمرتجعات), once posted: every receipt applied, credit note or credit memo applied, debit note or credit note raised against it and sales return, each a link, with **Paid and credited** (المدفوع والمخصوم) and the **Remaining balance** (الرصيد المتبقي).
6. The four icons in the title bar: see "The four icons at the top of a record — Receivables concepts". The browser's own Print (Ctrl+P) prints the invoice sheet too.

### Fields — Sales Invoices
Header:
- **Customer Code** / **Customer Name** (رمز العميل / اسم العميل) — required. Type either one and choose from the list; what is typed must match a customer exactly. Decides whose account is charged.
- **Invoice Date** (تاريخ الفاتورة) — required; default today. It is the invoice date, the date of the journal and of the stock movement, and it decides the accounting period.
- **Due Date** (تاريخ الاستحقاق) — required; proposed from the customer's payment terms (with no terms: the posting date). Once you type in it yourself it stops following the terms. The ageing and "overdue" are counted from this date.
- **Receivable account (statement)** (حساب الذمم المدينة (كشف الحساب)) — optional. **As configured** (حسب الإعداد) uses the company's accounting mapping; otherwise only customer control accounts are offered. It is the account the customer's debt is kept on.
- **Revenue account** (حساب الإيراد) — optional; opens on **As configured**, which means each line's revenue goes to its item's own sales account, then to the general mapping. An account chosen here overrides that for every line. Only revenue accounts that are not control accounts are offered.
Lines:
- **Item Code** / **Item Name** (رمز الصنف / اسم الصنف) — required on the first line. Only active stock items are offered; either box fills the other.
- **Quantity** (الكمية) — required, more than zero, in the item's base unit.
- **Unit Price (IQD)** (سعر الوحدة (د.ع)) — required, not negative; opens on the item's selling price and can be overtyped.
- **Discount** (الخصم) — optional; an amount of money taken off the line (not a percentage). It cannot be more than quantity × price.
- **Total Price (IQD)** (القيمة الإجمالية (د.ع)) — calculated: quantity × unit price − discount. Not typed.
- **Supplier** (المورّد) — optional. **Any supplier** (أي مورّد) sells the oldest stock of the item whoever it was bought from; choosing a supplier sells only from the stock bought from that supplier, and the cost follows that stock. The list holds the suppliers linked to the item and is greyed out when the item has none.
- **Warehouse** (المخزن) — required; the warehouse the goods leave from. Only warehouses of your Active branch are offered.
- **Available stock** (المخزون المتاح) — shown under the quantity, not typed. "Checking stock…" (جارٍ فحص المخزون…) while it is read; availability is checked again when posting.

### After you save — Sales Invoices
- **Draft** (مسودة) — after Create. Lines and accounts can be changed by people who may edit drafts. Next: Approve.
- **Approved** (معتمد) — after Approve. Locked. Next: Post, or Return to draft.
- **Posted** (مرحّل) — after Post. Journal written: Debit Customer receivable / Credit Revenue for the total; Debit Cost of goods sold / Credit Inventory for the cost of the goods. The stock leaves each line's warehouse (oldest stock first; only the chosen supplier's stock when the line names one). The customer now owes the amount; it appears in Customer Statements and Receivables Ageing.
- **Posted — partly paid** (مُرحَّلة — مدفوعة جزئيًا) — a receipt or a credit has settled part of it.
- **Settled** (مسوّى) — receipts and credits cover the whole invoice.
- **Reversed** (معكوس) — undone by Reverse invoice.

### Refusals — Sales Invoices
- "Add a customer first." / "N customer(s) exist and none is active and approved. Approve or reactivate one on the Customers screen." / "Add a stock item first." / "N item(s) exist and none is a stock item that is active. Check them on the Items screen." / "Set up a warehouse first." — shown instead of the New invoice form; create or approve that master data first (a warehouse must exist in your Active branch).
- "An invoice with no lines bills for nothing. Name at least one item." — fill at least one line.
- "Line 2 names ITEM-1 but has no quantity or unit price. Complete it, or clear the item to drop the line."
- "Line 2 does not say which warehouse ITEM-1 is sold from. The stock has to leave somewhere."
- "Line 1 has a discount larger than the line, which would make it a credit note." — lower the discount; a credit is given with a credit note.
- "Line 1 has no quantity. An invoice bills for something." / "Line 1 has a negative price. A refund is a credit note."
- "Line 1 names no item 'X'." / "Line 1 names X, which is no longer active." / "Line 1 names no warehouse 'X'." — choose an active item / an existing warehouse.
- "<code> does not hold the Customer role, so a Sales Invoice cannot be raised for them (§6). …grant the Customer role on the partner record" — open the partner and grant the Customer role.
- "Sales Invoice <no> is approved and its lines can no longer be changed. An approved invoice goes back to draft first, and a posted one is reversed." — use Return to draft, or Reverse.
- "<no> would be left billing for nothing. Change this line, or cancel the invoice." — the last line cannot be removed; change it instead. (The record has no cancel button; an unwanted draft is simply left unapproved.)
- "<account> is not a customer control account, so this invoice would post a balanced journal and never appear on the customer's statement. Designate it in Chart of Accounts, or leave the field empty to use the configured mapping." — pick a customer control account or As configured.
- "<account> is the customer control account and keeps a partner's balance; income and cost cannot be posted there." — choose a real revenue account.
- "Line 1 sells more ITEM-1 than WH-1 holds of that supplier’s stock. Negative stock is not allowed." or "Cannot issue 10 of ITEM-1 from WH-1: 4 is available. Negative inventory is prohibited without exception (§9.2). Reduce the quantity, receive stock first, or issue from another warehouse." — on Post: there is not enough stock. Return the invoice to draft and lower the quantity or change the warehouse / supplier, or receive the stock first.
- "Line 1 sells ITEM-1, which names no inventory account. Set one on the item." / "…which names no COGS account, so its cost has nowhere to go. Set one on the item." — complete the item's accounts on the Items screen.
- "Give a reason for returning the invoice to draft." / "Only an approved, unposted and unallocated invoice can return to draft. Posted invoices require a reversal."
- "<no> cannot be reversed: a reversal records why the invoice was wrong (§14.3). Give a reason."
- "<no> cannot be reversed: Sales Return <SR> was raised against it. An invoice with a return behind it is corrected through the return, not undone."
- "<no> cannot be reversed: Credit Memo <M> was raised against it, so the customer has already been credited for part of it."
- "<no> cannot be reversed: 50000.0000 IQD has been received against it. Reverse the receipt first; the invoice can then be reversed." — money or credit is applied to the invoice. The receipt screen has no reverse button, so in practice correct the invoice with a credit note or a sales return instead.
- "The line could not be saved. Your changes are still here; leave the row again to retry." — shown on a line of a draft when saving it failed; click into the row and out again.
- Period, permission and mapping refusals: see "Messages and common refusals — Receivables concepts".

## Customer Receipts (مقبوضات العملاء)
Receivables → Customer Receipts & Credits → Customer Receipts   |   Arabic: الذمم المدينة ← مقبوضات العملاء وأرصدتهم الدائنة ← مقبوضات العملاء
Address: /sales/customer-receipts (list, titled Receipts — المقبوضات) · /sales/customer-receipts/new · /sales/customer-receipts/<receipt number>
Needs: `view` on `customer_receipt` to open; `create` to record a receipt; `approve` to approve; `post` to post; `execute` to allocate it to invoices; `edit_draft` to add a note; `print` / `export` for copies; `create` on `attachment` to attach a file.
What it is for: Recording money received from a customer into a bank or cash account, and saying which invoices it pays. Partial payment is normal: one receipt can pay several invoices, and one invoice can be paid by several receipts.

### How to record a receipt — Customer Receipts
1. Open Receivables → Customer Receipts & Credits → Customer Receipts and press **New receipt** (مقبوض جديد).
2. Type the **Customer Code** or **Customer Name** and pick the customer.
3. Type the **Bank/Cash Code** (رمز البنك/الصندوق) or **Bank/Cash Name** (اسم البنك/الصندوق) and pick the account the money went into; the name shows the account's currency.
4. Check the **Invoice Date** (تاريخ الفاتورة), type the **Amount (IQD)** (المبلغ (د.ع)), optionally choose the **Payment method** (طريقة الدفع) and type a **Reference** (المرجع).
5. Press **Create** (إنشاء). The receipt gets its number and opens as a **Draft**. Invoices are not chosen here: "Invoices are allocated on the receipt’s own page, once it is posted."

### How to approve and post a receipt — Customer Receipts
1. Open the draft receipt and press **Approve** (اعتماد) (shown to people who may approve receipts). Status: **Approved**.
2. Press **Post** (ترحيل) (shown to people who may post receipts). Status: **Posted**; the money is now in the bank or cash account and on the customer's statement.

### How to allocate a receipt to invoices — Customer Receipts
1. Open the posted receipt. Under **Customer Invoice** (فاتورة العميل) it lists the customer's invoices that still owe something: Reference, Due Date, **Outstanding** (المتبقي), oldest due first.
2. Quick way: press **Apply oldest first** (خصّص للأقدم أولاً). The money is put on the oldest invoice first, then the next, until it runs out.
3. By hand: each row has an amount box already filled with that invoice's share under oldest-first. Change the amount if the customer said which invoice they are paying, and press **Allocate** (تخصيص) on that row. Repeat for other rows.
4. **Unallocated** (غير المخصص) in the header shows what is left. When it reaches zero the receipt becomes **Settled**; each invoice becomes Posted — partly paid or Settled.
5. To put what is left against a debit note, or to leave it as the customer's advance, see the next task.

### How to use what is left of a receipt — Customer Receipts
1. On the posted receipt, the **Applied to** (مخصص على) register lists every invoice and debit note it settled.
2. If something is left, the link **Apply the <amount> left** (تخصيص المتبقي) opens Customer Credits & Advances with this receipt chosen; apply it there to an invoice or a debit note.
3. If nothing is owed yet, do nothing: the remainder stays on the customer's account as an advance and is listed on Customer Credits & Advances until it is applied.

### How to open a record and what it shows — Customer Receipts
1. In the list press the receipt number. List columns: Reference, Invoice Date, Customer Code, Customer Name, Bank/Cash Code, Bank/Cash Name, Amount (IQD), **Allocated** (المخصص), Status.
2. The record shows Number (الرقم), Status, Customer Code and Name (links to the profile), Invoice Date, Bank/Cash Code and Name (links to the account), Branch (الفرع), Amount (IQD), Unallocated, Reference, Currency (العملة), Payment method; the open invoices; the totals Amount and Allocated; and the Applied to register.
3. The four icons in the title bar: see "The four icons at the top of a record — Receivables concepts". Ctrl+P prints the receipt sheet.

### Fields — Customer Receipts
- **Customer Code** / **Customer Name** (رمز العميل / اسم العميل) — required on the form. Only active, approved customers are offered.
- **Bank/Cash Code** / **Bank/Cash Name** (رمز البنك/الصندوق / اسم البنك/الصندوق) — required; the bank or cash account the money was received into. Only active accounts that have a ledger account behind them are offered. The receipt is in the account's currency, and it must be a dinar (IQD) account.
- **Invoice Date** (تاريخ الفاتورة) — required; default today; the date of the receipt and of its journal. Lateness of the customer's payment is counted from this date.
- **Amount (IQD)** (المبلغ (د.ع)) — required, more than zero.
- **Payment method** (طريقة الدفع) — optional; from the active Payment Methods, or **— not stated —** (— غير محددة —). Information only.
- **Reference** (المرجع) — optional free text, e.g. the bank's reference or the cheque number.
- **Unallocated** (غير المخصص) — calculated: amount minus what has been allocated or applied.

### After you save — Customer Receipts
- **Draft** (مسودة) → **Approved** (معتمد) → **Posted** (مرحّل). On Post: Debit the ledger account of the chosen bank or cash account / Credit Customer receivable, dated the posting date; a notification that money arrived is sent to the people set to receive it.
- While part of it is still unapplied the receipt stays **Posted**; when every dinar is allocated it becomes **Settled** (مسوّى).
- Allocating posts no journal; it moves the invoice to Posted — partly paid or Settled and reduces the customer's open balance in the ageing.
- The record has no button to edit, cancel or reverse a receipt.

### Refusals — Customer Receipts
- "Add a customer first." / "N customer(s) exist and none is active and approved…" / "Set up a bank or cash account first." / "N bank or cash account(s) exist and none is active." — shown instead of the New receipt form; fix the master data first.
- "A receipt records money that arrived, so its amount is positive. Money going out is a payment or a refund."
- "<account> holds USD and this receipt is in IQD (§17). Receive into an account in the receipt currency." — choose a dinar account; a receipt into a foreign-currency account is not accepted.
- "<code> does not hold the Customer role, so money cannot be received against their customer account (§6)…" — grant the Customer role on the partner, or use another kind of receipt.
- "'X' is not an active payment method. Choose one from Payment Methods."
- "Receipt <no> is 'draft'. Money is allocated to invoices once it has been posted — before that it is a document, not a payment." — approve and post first.
- "Receipt <no> has 20000.0000 left to apply, and this allocation is 50000.0000. A receipt cannot pay out more than the customer paid in — apply less, or record the rest as a second receipt (§16)."
- "Allocating 60000.0000 to invoice <no> exceeds its balance of 50000.0000. Money received beyond an invoice is a customer credit, not a larger invoice — allocate the excess to another open item or leave it unapplied (§15)."
- "An allocation from <no> must be positive. Applying nothing is not applying." — type an amount above zero.
- "Receipt <no> has nothing left to apply, or the customer has no invoice still owing. Money with no debt to settle stays unapplied and appears on the unapplied report (§16)." — nothing to do; the remainder is the customer's advance.
- "Receipt <no> is from a different customer than invoice <no>. One customer’s money does not settle another’s debt…".
- "Nothing outstanding for this customer." (لا يوجد متبقٍ لهذا العميل.) — not a refusal: the customer has no open invoice, so there is nothing to allocate to.

## Customer Credits & Advances (الأرصدة الدائنة للعملاء والدفعات المقدمة)
Receivables → Customer Receipts & Credits → Customer Credits & Advances   |   Arabic: الذمم المدينة ← مقبوضات العملاء وأرصدتهم الدائنة ← الأرصدة الدائنة للعملاء والدفعات المقدمة
Address: /sales/customer-credits
Needs: `view` on `customer_receipt` to open; to apply a credit, `execute` on `customer_receipt` (a receipt's remainder) or `execute` on `customer_credit_memo` (a credit note's or credit memo's remainder); `view` on `ar_invoice` for the outstanding figures in the By customer table.
What it is for: Shows what every customer holds with the company — advances, unapplied receipts and overpayments, credit note and credit memo balances — and lets you put a credit against an invoice or a debit note. No invoice is invented for an advance; the credit simply waits.

### How to see what credit a customer holds — Customer Credits & Advances
Receivables → Customer Receipts & Credits → Customer Credits & Advances.
2. The first table, **Credits & advances** (الأرصدة الدائنة والدفعات المقدمة), lists each credit: Reference (a link to the receipt or note), **Kind** (النوع), Date, Customer Code, Customer Name, **Source invoice** (الفاتورة المصدر), Amount, **Applied** (المخصص), **Unapplied** (غير المخصص), Status, and an **Apply** (تخصيص) link when something is left. The last row totals **Unapplied credits** (الأرصدة الدائنة غير المخصصة).
3. Filter with **Customer Name** (choose one, or **All customers** — جميع العملاء) and **Show** (عرض): **With something left to apply** (ما تبقى منه رصيد للتخصيص — the default) or **All, including fully applied** (الكل، بما فيها المخصصة بالكامل); press **Filter** (تصفية). The search box searches the rows.
4. The **By customer** (حسب العميل) table at the bottom shows, per customer as at today: **Outstanding invoices & debit notes** (الفواتير والإشعارات المدينة المستحقة), **Received** (المقبوض), **Applied receipts** (المقبوضات المخصصة), **Unapplied** and **Net position** (صافي المركز = outstanding minus unapplied credit), with links **Ageing** (الأعمار) and **Statement** (كشف الحساب).

### How to apply a credit to an invoice or debit note — Customer Credits & Advances
1. In the Credits & advances table press **Apply** (تخصيص) on the credit's row (or arrive from a receipt's "Apply the … left" link or a credit note's "Apply the remainder" button).
2. A second table opens, titled **Apply <number>** with the customer and the amount left. It lists what that customer owes: Reference, Kind — **Sales invoice** (فاتورة مبيعات) or **Debit note** (إشعار مدين) —, Due Date, Total Price, Outstanding, oldest due first.
3. Each row has an amount box, pre-filled so the amounts down the column add up to the credit (oldest first). Change it if needed and press **Apply** on that row.
4. "Saved." confirms. The credit's Unapplied falls and the invoice or debit note moves to Posted — partly paid or Settled. Repeat for other rows.

### Fields — Customer Credits & Advances
- **Kind** (النوع) — **Advance** (دفعة مقدمة): a posted receipt none of which has been applied; **Unapplied receipt / overpayment** (مقبوض غير مخصص / زيادة دفع): a receipt partly applied; **Credit memo (return)** (إشعار دائن (مرتجع)): what is left of a sales return's credit; **Credit note** (إشعار دائن): what is left of a credit note.
- **Source invoice** (الفاتورة المصدر) — the invoice a credit note or credit memo was raised against, if any.
- **Amount** (المبلغ) / **Applied** (المخصص) / **Unapplied** (غير المخصص) — the credit's total, what has been used, what is left.
- Amount box in the Apply table — how much of this credit to put on that row's document. Must be above zero, not more than the credit has left and not more than the document still owes.
- Not listed here: a credit memo that was refunded from the bank (the customer was paid back, so no credit remains on the account).

### After you save — Customer Credits & Advances
Applying posts no journal — the credit and the debt are already in the ledger. It records the pairing (shown on both documents: "Applied to" on the receipt or note, "Receipts, credits and returns" on the invoice, "Settled by" on a debit note), raises the applied amount on both, and moves their statuses (the credit towards Settled; the invoice or debit note towards Posted — partly paid or Settled). The ageing, the statement balance and the net position follow at once.

### Refusals — Customer Credits & Advances
- "<credit> has 20000 left to apply and this is 50000. A credit cannot give back more than it is for." — lower the amount.
- "<document> has 30000 still owed and this is 50000. Credit beyond what is owed stays on the account as a credit; it does not make the debt negative." — lower the amount to what is owed.
- "An application of <credit> to <document> must be for a positive amount."
- "<credit> and <document> belong to different customers. One customer's credit does not settle another's debt (§16)."
- "<credit> is 'draft'. A credit is applied once it has been posted." — approve and post the receipt or note first.
- "<document> is 'draft', and only a posted document is owed."
- "Credit memo <no> was refunded from the bank, so it never reached the customer's account and has nothing to apply."
- "Nothing is left on this credit to apply." (لم يتبقَّ شيء من هذا الرصيد للتخصيص.) / "This customer owes nothing right now. The credit stays on the account until something is." (لا يدين هذا العميل بشيء حالياً…) — shown in the Apply table; nothing to do.
- No amount box in the Apply table — you do not hold the permission to apply that kind of credit.

## Customer Statements (كشوف حسابات العملاء)
Receivables → Customer Balances → Customer Statements   |   Arabic: الذمم المدينة ← أرصدة العملاء ← كشوف حسابات العملاء
Address: /sales/customer-statements
Needs: `view` on `business_partner` to open; `view` on `ar_invoice` for the Invoice Balances part; `print` on `business_partner` for the PDF copy, `export` for Excel and Word.
What it is for: A read-only account statement: every posting on a customer's account in a period with a running balance, and under it what is still owed. With no customer chosen it lists every customer's position, which answers "who owes us money". Sales are Debit; receipts and credits are Credit.

### How to run a customer's statement — Customer Statements
Receivables → Customer Balances → Customer Statements (or press **Account statement** on a customer's profile).
2. In **Customer** (عميل) type the code or the name and pick from the list.
3. Set **From** (من) and **To** (إلى) — they open on the first and last day of this year — and the **Report currency** (عملة التقرير), IQD or USD.
4. Optionally set **Show** (العرض) to narrow the open invoices listed underneath.
5. Press **Run** (عرض). The address bar now holds the choices, so the page can be bookmarked or sent to a colleague.
6. Read the table: **Opening balance** (الرصيد الافتتاحي), then one row per posting, then **Closing balance** (الرصيد الختامي) with total Debit and total Credit. The closing balance is also shown at the foot.

### How to see who owes money without choosing a customer — Customer Statements
1. Leave the Customer box empty and press **Run**.
2. The **Invoice Balances** (أرصدة الفواتير) window lists every customer with: number of open documents (المستند), **Gross Receivables** (إجمالي الذمم المدينة), **Overdue** (متأخرة), **Unapplied Customer Credits / Advances** (أرصدة العملاء الدائنة / الدفعات المقدمة غير المطبقة), **Other Non-invoice Debits** (مدين غير مرتبط بفواتير أخرى) and **Net Customer Position** (صافي رصيد العميل).
3. Press a customer's name to open their statement; press the code to open their profile.

### How to print or export a statement — Customer Statements
1. Choose a customer and run the statement. The **Print / Export** (طباعة / تصدير) menu appears at the top only when a customer is chosen.
2. Open it and pick the language row (English or العربية) and the format: PDF, Excel (.xlsx) or Word (.docx). The copy uses the same customer, dates and currency as the screen.

### Fields — Customer Statements
Filters:
- **Customer** (عميل) — a code or a name; anything that can only be one customer is accepted. Empty = everybody's positions.
- **Show** (العرض) — which open invoices the lower window lists: **All** (الكل), **Falling due soon** (يستحق قريباً — due within the next 7 days), **Overdue only** (المتأخر فقط), **Not yet paid** (لم يُسدَّد بعد), **Part paid** (مسدَّد جزئياً).
- **From** / **To** (من / إلى) — the statement period. Open items are aged as at the To date, but never later than today.
- **Report currency** (عملة التقرير) — IQD is the ledger; USD reads the same postings at the rate that applied when each one posted.
Statement columns:
- **Date** (التاريخ) — posting date. **Document** (المستند) — the invoice, receipt, note or memo number (a link), or the journal number for a manual journal. **Due Date** (تاريخ الاستحقاق) and **How late** (مدة التأخر) — for invoices: "N days overdue" or "Due in N days" as at the statement's end date. **Description** (البيان). **Debit** (مدين) — what increased the customer's debt (sales, debit notes). **Credit** (دائن) — what reduced it (receipts, credit notes, returns). **Balance** (الرصيد) — running balance; positive means the customer owes the company.
Invoice Balances window (customer chosen): Invoice Number, Invoice Date, Due Date, **Payment terms** (شروط الدفع), Total Price, **Allocated Payments** (الدفعات المخصصة للفواتير), **Credits / Returns Applied** (الأرصدة الدائنة / المرتجعات المطبقة), **Other Adjustments Applied** (التسويات الأخرى المطبقة), **Outstanding** (المتبقي), **Status against terms** (الحالة مقابل الشروط).
Foot totals: Gross Receivables, **Not Yet Due** (غير مستحقة بعد), Overdue, Unapplied Customer Credits / Advances, Other Non-invoice Debits, Net Customer Position, and the amounts by lateness: Not yet due, 1–30 days late, 31–60 days late, 61–90 days late, Over 90 days late.
Two smaller tables appear when they have rows: **Customer Credits / Advances** (who holds a credit, since when, how much) and **Other Non-invoice Debits** (a debit on a customer's account that came from a journal, not from an invoice).
**Old books — before the cut-over** (الدفاتر القديمة — قبل التحويل), right under the statement's lines when a customer is chosen: every document the old system exported for the account, each in its own currency whatever the Report currency is — **Date** (التاريخ; a sale shows "Not in the export" because the old sales export has no date), **Old no.** (الرقم القديم), **Document** (المستند: Sale invoice, Receipt voucher, Payment voucher, Purchase invoice), **Goods** (المواد: the first three items with quantities, "+N more"), **Currency** (العملة, only when the account has documents in both dinars and dollars), **Debit** and **Credit**, then a **Total** row per currency and **Net of these lines** (صافي هذه الأسطر) per currency at the foot — dinars and dollars are never added together. Dated documents come first in date order, the sales after them in the old list's order. These lines are history: nothing is posted from them, and they need not add up to the opening balance — the old system's balance (the statement's opening line on the cut-over date) also holds entries its export does not carry. The printed copy carries the same, one table per currency.

### After you save — Customer Statements
Nothing is saved; the screen only reads. It reads the same postings the ledger holds, so its closing balance equals the customer's balance in Receivables Ageing (Net position) and in Customer Reconciliation. The Old books table is read from the old system's documents kept at the import and never changes a balance.

### Refusals — Customer Statements
- "Choose a customer to read their account." (اختر عميلًا لقراءة حسابه.) — no customer chosen; the upper table stays empty (the lower window still lists everybody).
- "No Customer matches that. Type a code or a name, or pick one from the list." — what was typed matches nobody.
- "That could be more than one Customer. Type more of the code or the name."
- "Nothing posted to this account in the period." (لا يوجد قيد على هذا الحساب خلال الفترة.) — widen the dates.
- "Nothing here — no invoice on this account matches what is being shown." — the Show filter matches nothing; set Show to All.
- "This export has N rows; a file may carry at most M. Narrow the filters…" — shorten the period and export again.

## Receivables Ageing (أعمار الذمم المدينة)
Receivables → Customer Balances → Receivables Ageing   |   Arabic: الذمم المدينة ← أرصدة العملاء ← أعمار الذمم المدينة
Address: /sales/receivables
Needs: `view` on `ar_invoice` to open; `print` on `ar_invoice` for the PDF copy, `export` for Excel and Word.
What it is for: A read-only report of what customers owe, invoice by invoice and debit note by debit note, and how late each is, as at a date. Lateness is counted from the due date, not the invoice date.

### How to read the ageing — Receivables Ageing
Receivables → Customer Balances → Receivables Ageing. It opens as at today for your Active branch.
2. Five figures at the top: **Gross receivables** (إجمالي الذمم المدينة — everything still owed on invoices and debit notes), **Not yet due** (غير مستحقة بعد), **Overdue** (متأخرة), **Unapplied credits** (الأرصدة الدائنة غير المخصصة — what customers hold with us) and **Net position** (صافي المركز — what is owed less what is held, equal to the ledger balance).
3. The **Invoice Balances** (أرصدة الفواتير) table lists each document: Customer Name, Invoice Number (with each receipt and credit applied listed under it as date · amount · number, each a link), Invoice Date, Due Date, Payment terms, Total Price, Allocated Payments, Credits / Returns Applied, Other Adjustments Applied, **Outstanding**, Status, and **Status against terms** ("Due in 6 days", "11 days overdue", "Paid 3 days late", "Paid on time"). A debit note is marked **Debit note** (إشعار مدين) under its number. The last row totals the columns.
4. Under it, when they have rows: **Customer Credits / Advances** (customer, **On account since** — الرصيد قائم منذ —, **Credit / advance balance**, link **Credits & advances**) and **Other Non-invoice Debits**.
5. The last window, **Customer credits / advances reconciliation** (تسوية أرصدة العملاء الدائنة / الدفعات المقدمة), shows the open amount by lateness — Not yet due, 1–30, 31–60, 61–90, Over 90 days late, with the number of documents in brackets — and the totals. Its strip says **Ties to the statement** (مطابق لكشف الحساب) when documents, credits and ledger agree, or **Difference is listed above** (الفرق مُبيَّن أعلاه).

### How to filter the ageing — Receivables Ageing
1. **Customer** (عميل) — type a code or name ("Everybody — or type a name or code").
2. **Branch** (الفرع) — one of your branches or **All my branches** (جميع فروعي).
3. **As at** (كما في) — the date the report is aged at.
4. **Currency** (العملة) — **All currencies** (جميع العملات) or one currency: lists only documents raised in it.
5. **Show** (العرض) — **All** (الكل), **Open** (مفتوحة — still owed), **Partially paid** (مدفوعة جزئياً), **Paid** (مدفوعة), **Overdue** (متأخرة).
6. Press **Show** (عرض). The filters change which rows are listed; the five figures and the tie are always worked out over every document of the chosen customer and branch.

### How to drill down — Receivables Ageing
1. Press a customer's name to narrow the report to that customer; a line appears with links **Customer** (العميل — the profile), **Statement** (كشف الحساب) and **Credits & advances** (الأرصدة الدائنة والدفعات المقدمة).
2. Press an invoice or debit note number to open the document; press a receipt or credit number under it to open that.
3. Press the customer code to open the customer's profile.

### How to print or export the ageing — Receivables Ageing
Open **Print / Export** (طباعة / تصدير) at the top and choose the language and PDF, Excel (.xlsx) or Word (.docx). The copy carries the same filters as the screen.

### Fields — Receivables Ageing
What each figure means:
- **Gross receivables** (إجمالي الذمم المدينة) — the outstanding amount of every posted invoice and debit note. Credits are not netted into it.
- **Not yet due** (غير مستحقة بعد) — the part of the gross whose due date has not passed on the As at date.
- **Overdue** (متأخرة) — the part whose due date has passed.
- **Unapplied credits** (الأرصدة الدائنة غير المخصصة) — what customers hold on their accounts that has not been put against a document: advances, overpayments, remainders of credit notes and credit memos.
- **Net position** (صافي المركز) — the customers' balance in the ledger: what is owed less what is held. It can be negative for a customer who has paid in advance.
- **Total Price** (القيمة الإجمالية) — the document's amount. **Allocated Payments** (الدفعات المخصصة للفواتير) — receipts allocated to it. **Credits / Returns Applied** (الأرصدة الدائنة / المرتجعات المطبقة) — credit notes and return credit memos applied to it. **Other Adjustments Applied** (التسويات الأخرى المطبقة) — any other approved adjustment of the invoice, such as a write-off. **Outstanding** (المتبقي) — what is left: total less the three before it.
- **Status against terms** (الحالة مقابل الشروط) — counted from the due date: "Due in N days", "N days overdue"; for a paid document "Paid on time" or "Paid N days late" (the lateness of the last payment, counted from the receipt's date).
- Lateness groups — **Not yet due** (لم تستحق بعد), **1–30 days late** (متأخرة ١–٣٠ يوماً), **31–60 days late** (متأخرة ٣١–٦٠ يوماً), **61–90 days late** (متأخرة ٦١–٩٠ يوماً), **Over 90 days late** (متأخرة أكثر من ٩٠ يوماً): the outstanding amount whose due date is that many days before the As at date.
- **Other Non-invoice Debits** (مدين غير مرتبط بفواتير أخرى) — a debit on a customer's account that has no invoice behind it, for example an opening balance or a correction posted by journal. It is shown but never aged.
- **On account since** (الرصيد قائم منذ) — the date of the oldest posting on that customer's account.

### After you save — Receivables Ageing
Nothing is saved; the report only reads. It uses the same figures as the invoice's Settlement panel, the Customer Statement and the Dashboard's "Owed to us", so they cannot disagree.

### Refusals — Receivables Ageing
- "Nothing matches — no invoice is outstanding for this date." (لا شيء يطابق — لا توجد فاتورة قائمة في هذا التاريخ.) — widen the filters.
- "No Customer matches that. Type a code or a name, or pick one from the list." / "That could be more than one Customer. Type more of the code or the name." — the Customer box.
- A draft or merely approved invoice is not listed: only posted documents are debts.

## Credit Notes / Debit Notes (الإشعارات الدائنة / الإشعارات المدينة)
Receivables → Sales & Invoices → Credit Notes / Debit Notes   |   Arabic: الذمم المدينة ← المبيعات والفواتير ← الإشعارات الدائنة / الإشعارات المدينة
Address: /sales/credit-notes (list) · /sales/credit-notes/new?kind=credit · /sales/credit-notes/new?kind=debit · /sales/credit-notes/<note number>
Needs: `view` on `customer_credit_memo` to open; `create` to raise a note; `approve` to approve; `post` to post; `edit_draft` to cancel a draft and to add a note; `reverse_cancel` on `customer_credit_memo` and on `journal_entry` to reverse; `execute` to apply a credit note's remainder; `print` / `export` for copies; `create` on `attachment` to attach a file.
What it is for: Adjusting a customer's account without goods moving. A **credit note** reduces what the customer owes (a price allowance, a correction). A **debit note** increases it (a charge the invoice missed). The register also lists the **credit memos** that sales returns create; those open read-only.

### How to raise a credit note — Credit Notes / Debit Notes
1. Open Receivables → Sales & Invoices → Credit Notes / Debit Notes and press **New credit note** (إشعار دائن جديد).
2. In **Customer Name** type the customer's code or name ("Customer code or name") and press **Choose** (اختر). The rest of the form appears with that customer's invoices.
3. Check the **Invoice Date** (تاريخ الفاتورة).
4. In **Invoice Number** (رقم الفاتورة) choose the invoice being corrected, or leave **No invoice — on the account** (دون فاتورة — على الحساب). Each invoice shows its total and what is still open.
5. Type the **Amount** (المبلغ). Leave **Allowance account** (حساب الخصومات) on **As configured** unless Finance told you otherwise.
6. Type the **Reason** (السبب) (required) and, if useful, a **Description** (الوصف).
7. Press **Raise credit note** (إنشاء إشعار دائن). The note opens as a **Draft**.

### How to raise a debit note — Credit Notes / Debit Notes
1. Press **New debit note** (إشعار مدين جديد) on the register.
2. Choose the customer as for a credit note and press **Choose**.
3. Fill Invoice Date; **Due Date** (تاريخ الاستحقاق) may be left empty — "Left empty, it comes from the customer’s payment terms."
4. Optionally choose the invoice the charge belongs to (for tracing only), type the **Amount**, leave **Revenue account** (حساب الإيرادات) on As configured, type the **Reason**.
5. Press **Raise debit note** (إنشاء إشعار مدين). The note opens as a Draft.

### How to approve and post a note — Credit Notes / Debit Notes
1. Open the draft note and press **Approve** (اعتماد). Status: **Approved**.
2. Press **Post** (ترحيل). Status: **Posted**. A credit note raised against an invoice settles that invoice at once, up to what the invoice still owes; anything beyond stays as the customer's credit. A debit note is now owed from its due date.

### How to cancel a draft note — Credit Notes / Debit Notes
1. Open the draft note. Type the reason in the box beside the button and press **Cancel draft** (إلغاء المسودة).
2. Status: **Cancelled**. Nothing was posted.

### How to reverse a posted note — Credit Notes / Debit Notes
1. Open the posted note. **Reverse** (عكس) is offered only while nothing has been applied to or from it.
2. Type why the note was wrong and press **Reverse**. Its journal is mirrored and the status becomes **Reversed**; the record shows the reversal journal number and the reason.
3. Once a credit note has been used, or a debit note has been paid, it cannot be reversed: correct it with the opposite kind of note.

### How to apply what is left of a credit note — Credit Notes / Debit Notes
1. Open the posted credit note. If **Remaining** (المتبقي) is above zero, press **Apply the remainder** (تخصيص المتبقي).
2. Customer Credits & Advances opens with this note chosen; apply it there to an invoice or a debit note.

### How to open a record and what it shows — Credit Notes / Debit Notes
1. In the register press the number. Filter the register with **Kind** (النوع): **All kinds** (جميع الأنواع), **Credit note** (إشعار دائن), **Debit note** (إشعار مدين), **Credit memo (sales return)** (إشعار دائن (مرتجع مبيعات)), then **Filter** (تصفية). Columns: Reference, Kind, Invoice Date, Due Date (debit notes only), Customer Code, Customer Name, Invoice Number, Amount, **Applied / received** (المخصص / المقبوض), Status.
2. A note's record shows: Number, Status, Kind, Customer (links), Invoice Date, Due Date, Invoice Number (link), the account, **Journal entry** (القيد اليومي — a link once posted), **Raised by** (أنشأه), **Approved by** (اعتمده), **Posted by** (رحّله), Branch, Reason, Description, and **Reversal** (العكس) when reversed. Its lines are **Applied to** (خُصّص على) for a credit note or **Settled by** (سُدّد بواسطة) for a debit note — date, document (link), amount. Totals: Amount, **Applied** (المخصص) or **Received** (المقبوض), **Remaining** (المتبقي).
3. A credit memo's record is read-only: it shows the customer, the invoice, the **Sales return** (مرتجع المبيعات) that created it, its journal, what it was applied to, and the note "Raised and posted by its sales return. What is left on it can be applied from Customer Credits & Advances."
4. The four icons in the title bar: see "The four icons at the top of a record — Receivables concepts".

### Fields — Credit Notes / Debit Notes
- **Customer Name** (اسم العميل) — required; typed code or name, then Choose. Only active, approved customers.
- **Kind** (النوع) — Credit note or Debit note; fixed by the button you pressed.
- **Invoice Date** (تاريخ الفاتورة) — required; default today; the date of the note and of its journal.
- **Due Date** (تاريخ الاستحقاق) — debit notes only; optional. Empty = worked out from the customer's payment terms from the posting date. It cannot be before the posting date. The debit note ages from this date.
- **Invoice Number** (رقم الفاتورة) — optional; one of the customer's posted invoices, or **No invoice — on the account**. For a credit note: "A credit note against an invoice settles it as far as it still owes when posted; the rest stays as the customer’s credit." For a debit note: "The invoice this charge belongs to, if any — for tracing; the debit note is owed on its own due date."
- **Amount** (المبلغ) — required, above zero. A credit note against an invoice cannot be for more than the invoice total.
- **Allowance account** (حساب الخصومات) on a credit note / **Revenue account** (حساب الإيرادات) on a debit note — optional; **As configured** (حسب الإعداد) uses the accounting mapping; otherwise a revenue account that is not a control account.
- **Reason** (السبب) — required; why the account is adjusted. Shown on the record and used as the journal line's description.
- **Description** (الوصف) — optional longer text.

### After you save — Credit Notes / Debit Notes
- **Draft** (مسودة) → **Approved** (معتمد) → **Posted** (مرحّل); or Draft → **Cancelled** (ملغى).
- Credit note on Post: Debit Sales returns and allowances (or the chosen account) / Credit Customer receivable. If it names an invoice that still owes money, it is applied to that invoice immediately, up to what is owed. The rest is the customer's credit, listed on Customer Credits & Advances.
- Debit note on Post: Debit Customer receivable / Credit Revenue (or the chosen account). It appears in the ageing and on the statement, and is settled by allocating a receipt or applying a credit to it on Customer Credits & Advances.
- A note against an invoice posts to the same receivable account as that invoice.
- **Posted — partly paid** (مُرحَّلة — مدفوعة جزئيًا) when part is applied / received; **Settled** (مسوّى) when all of it is; **Reversed** (معكوس) after Reverse.

### Refusals — Credit Notes / Debit Notes
- "More than one customer matches — type more of the name or the code." / "No customer matches what was typed." — hints under the customer box.
- "A note is for a positive amount. Which way it moves the account is what credit and debit say."
- "A note says why the account is being adjusted (§5.4). Give a reason."
- "<code> does not hold the Customer role, so it has no customer account to adjust (§6)."
- "Invoice <no> belongs to a different customer. A note corrects its own customer's account."
- "Invoice <no> is 'draft'. A note corrects a posted invoice; a draft is corrected by editing it."
- "Invoice <no> came to 100000.0000 IQD, and a credit note against it cannot be for more than the invoice."
- "A debit note cannot fall due before it is issued." — move the due date to the posting date or later.
- "<account> is the customer control account and keeps a partner's balance; income and cost cannot be posted there." — choose another account or As configured.
- "Say why the draft is being cancelled."
- "A reversal records why the note was wrong (§14.3). Give a reason."
- "10000.0000 IQD of <no> has been applied to what the customer owes. A credit that has been used is not withdrawn; raise a debit note for the correction."
- "10000.0000 IQD has been received against <no>. A charge that has been paid is not withdrawn; raise a credit note for the correction."
- Period, permission and mapping refusals: see "Messages and common refusals — Receivables concepts".

## Sales Returns (مرتجعات المبيعات)
Receivables → Sales & Invoices → Sales Returns   |   Arabic: الذمم المدينة ← المبيعات والفواتير ← مرتجعات المبيعات
Address: /sales/sales-returns (list) · /sales/sales-returns/new · /sales/sales-returns/<return number>
Needs: `view` on `sales_return` to open; `create` to raise a return; `approve` and `execute` on `sales_return` together to Accept or Reject. Accepting also needs `execute` on `inventory_movement` (the goods come back into stock) and `create`, `approve`, `post` — and `execute` when the offset is Accounts Receivable — on `customer_credit_memo` (the credit memo is made in the same step). `edit_draft` to add a note; `print` / `export` for copies; `create` on `attachment` to attach a file.
What it is for: Taking back goods a customer returns against a posted sales invoice: the goods go back into a warehouse and the customer is credited (or refunded from a bank or cash account).

### How to raise a sales return — Sales Returns
1. Open Receivables → Sales & Invoices → Sales Returns and press **New return** (مرتجع جديد).
2. Optionally type the customer in **Customer Name** ("Customer name or code") — it only narrows the invoices suggested.
3. In **Original Sales Invoice** (فاتورة المبيعات الأصلية) type the invoice number or part of it and press **Choose** (اختر). Only posted invoices can be returned against.
4. The form appears with the customer filled in. Check the **Invoice Date**.
5. Choose the **Offset Account** (الحساب المقابل): **Accounts Receivable** (الذمم المدينة) to credit the customer's account, or **Bank** (البنك) to pay the money back. If Bank, also choose the **Bank or cash account** (حساب بنكي أو نقدي) the refund comes out of.
6. Type the **Reason** (السبب) (required).
7. In the lines table type the **Return Quantity** (كمية الإرجاع) for each item coming back. Leave the box empty for items the customer keeps. **Returnable** (القابل للإرجاع) is the most you may return on that line.
8. Press **Create** (إنشاء). The return gets its number and opens with status **Pending approval**. Nothing has moved yet.

### How to accept a sales return — Sales Returns
1. Open the return (status Pending approval).
2. For each line choose the **Warehouse Code** (رمز المخزن) the goods go back into; it opens on the warehouse the line was sold from. Only warehouses of the return's branch are offered.
3. Press **Accept** (قبول). The button shows only to people who may both approve and carry out returns.
4. In one step the goods are received, put back into stock at the cost they left at, and a credit memo is created and posted for the customer. With Accounts Receivable as offset the credit is applied to the original invoice as far as it still owes; the rest stays as the customer's credit. With Bank the refund is credited to the chosen bank or cash account.
5. The status becomes **Approved** (accepted). The credit memo is listed on Credit Notes / Debit Notes as "Credit memo (sales return)".

### How to reject a sales return — Sales Returns
1. Open the return (status Pending approval) and press **Reject** (رفض).
2. The status becomes **Rejected**. Nothing moved; the quantities can be returned again on a new return.

### How to open a record and what it shows — Sales Returns
1. In the list press the return number. List columns: Reference, Invoice Date, Customer Code, Customer Name, Original Sales Invoice (link), Offset Account, Status.
2. The record shows Reference, Status, Customer (links), Invoice Date, Invoice Number (link), Branch, Offset Account, Reason, and the lines: #, Item Code, Item Name, Return Quantity, Warehouse Code.
3. The four icons in the title bar: see "The four icons at the top of a record — Receivables concepts". Ctrl+P prints the return sheet.

### Fields — Sales Returns
- **Customer Name** (first step) — optional; "Optional — narrows the invoices suggested below."
- **Original Sales Invoice** (فاتورة المبيعات الأصلية) — required; a posted invoice, typed by number. Everything else is read from it.
- **Customer Code** / **Customer Name** — read from the invoice; not typed.
- **Invoice Date** (تاريخ الفاتورة) — required; default today; the date the return is requested.
- **Offset Account** (الحساب المقابل) — required: **Accounts Receivable** (reduces what the customer owes) or **Bank** (the money is paid back).
- **Bank or cash account** (حساب بنكي أو نقدي) — needed only when the offset is Bank; an active account. Ignored when the offset is Accounts Receivable.
- **Reason** (السبب) — required; why the customer is returning the goods.
- Lines (read from the invoice): Item Code, Item Name, Unit Price (IQD) (the price billed), Warehouse (where it was sold from), **Invoiced** (المفوتر), **Returnable** (القابل للإرجاع = invoiced minus what earlier returns already took, rejected returns not counted).
- **Return Quantity** (كمية الإرجاع) — per line; empty or 0 = not returned. Cannot exceed Returnable. Only lines with something returnable are listed, and only the first eight listed lines are read when the form is saved — for an invoice with more lines, raise a second return for the rest.
- **Warehouse Code** (رمز المخزن) on the record — chosen per line when accepting; must be a main or branch warehouse.

### After you save — Sales Returns
- **Pending approval** (بانتظار الموافقة) — after Create. No stock and no money has moved. Next: Accept or Reject by somebody allowed to.
- **Approved** (معتمد) — after Accept. Stock: the accepted quantity comes back into the chosen warehouse at the original cost, Debit Inventory / Credit Cost of goods sold. Money: a credit memo is created, approved and posted for the returned goods at the price billed, Debit Sales returns / Credit Customer receivable (offset Accounts Receivable) or Credit the bank or cash account (offset Bank). With Accounts Receivable the memo is applied to the original invoice up to what it still owes; any remainder is the customer's credit on Customer Credits & Advances.
- **Rejected** (مرفوض) — after Reject. Nothing moved.
- A return blocks the reversal of its invoice (unless the return was rejected).

### Refusals — Sales Returns
- "Post a sales invoice first." (رحّل فاتورة مبيعات أولاً.) — there is no posted invoice to return against.
- "That could be more than one invoice. Type more of its number." / "No returnable invoice matches that." — hints under the invoice box.
- "Invoice <no> is 'draft'. Appendix C requires an accepted return to name a source invoice, and an invoice that has not posted has not yet billed the customer for anything to send back."
- "A sales return with no lines records nothing coming back. Say what is being returned, or do not raise it." — type at least one Return Quantity.
- "A sales return states why the customer is returning the goods. …" — type the Reason.
- "A return offset to Bank must name which bank or cash account the refund comes out of." — choose the Bank or cash account.
- "That bank or cash account is closed. A refund cannot be paid out of it."
- "Returning 5 of ITEM-1 is more than the customer bought. Invoiced: 10; already returned: 8; still returnable: 2. Goods the customer was never billed for are not a return (§7.5)." — lower the quantity.
- "A return inspected as 'saleable' cannot be put into <warehouse>, which is a … warehouse." — on Accept: choose a main or branch warehouse.
- "The invoice sold stock from more than one batch, so the inspection must say which units came back. …" — on Accept, for goods sold from several batches; the screen cannot name the batch, so ask your administrator.
- "Sales Return <no> has nothing left to credit. Either nothing was accepted, or a credit memo has already been raised for all of it."
- "Permission denied: 'post' on 'customer_credit_memo' is not granted to this user." (or 'create', 'approve', 'execute') — accepting needs the credit memo and stock permissions as well; ask somebody who holds them to accept.
- Period, permission and mapping refusals: see "Messages and common refusals — Receivables concepts".

## Customer Reconciliation (مطابقة حسابات العملاء)
Receivables → Customer Balances → Customer Reconciliation   |   Arabic: الذمم المدينة ← أرصدة العملاء ← مطابقة حسابات العملاء
Address: /sales/customer-reconciliation
Needs: `view` on `ar_invoice`.
What it is for: A read-only check that the customers' balances (the subledger) add up to the Accounts Receivable control account in the general ledger. It shows a difference and where it comes from; it never corrects anything.

### How to read the reconciliation — Customer Reconciliation
Receivables → Customer Balances → Customer Reconciliation. Set **As at** (كما في) and press **Show** (عرض); it opens as at today.
2. **Customer subledger and A/R control** (دفتر العملاء الفرعي وحساب مراقبة الذمم): one row per customer control account — **Account code** (رمز الحساب — opens the account's ledger), **Account** (الحساب), **Customer subledger** (دفتر العملاء الفرعي), **A/R control (G/L)** (حساب المراقبة (الأستاذ العام)), **Difference** (الفرق). The foot totals the three.
3. The strip gives the verdict: "Difference: 0 IQD ✅ — the subledger and the control account agree at <amount>." or "Difference: <amount> ⚠️ — the lines below are where it comes from. Nothing is corrected here."
4. **Investigation — the lines that make the difference** (التحقيق — الأسطر التي تصنع الفرق): each journal line behind a difference with its **Finding** (النتيجة), Invoice Date, **Journal entry** (a link), Account code, Customer Code, Description, **G/L line** (سطر الأستاذ العام) and **Subledger entry** (قيد الدفتر الفرعي). With no difference it says "Every line on the customer control accounts has its subledger entry, and every entry its line."
5. **By customer — subledger and open documents** (حسب العميل — الدفتر الفرعي والمستندات المفتوحة): per customer, **Customer subledger**, **Open invoices & debit notes** (الفواتير والإشعارات المدينة المفتوحة), Unapplied Customer Credits / Advances, Other Non-invoice Debits, and a **Statement** (كشف الحساب) link.

### How to investigate a difference — Customer Reconciliation
1. Read the Finding on each line: **On the control account, not on the subledger** (على حساب المراقبة وليس في الدفتر الفرعي — usually a manual journal posted to the control account without naming a customer); **Subledger amount differs from the line** (مبلغ الدفتر الفرعي يختلف عن السطر); **Filed under another control account** (مسجّل تحت حساب مراقبة آخر); **Subledger entry for an unposted journal** (قيد دفتر فرعي لقيد يومي غير مرحّل).
2. Press the journal number to open the journal entry and decide with Finance how it should be corrected (normally by reversing that journal and posting it correctly). The screen itself repairs nothing — "open each journal to decide how it should be corrected."

### Fields — Customer Reconciliation
- **As at** (كما في) — the only filter; the date both sides are read at. Press **Show** (عرض).
- **Customer subledger** (دفتر العملاء الفرعي) — the sum of every customer's own balance kept on that control account.
- **A/R control (G/L)** (حساب المراقبة (الأستاذ العام)) — the balance of the same account in the general ledger.
- **Difference** (الفرق) — subledger less ledger; it should be 0. A non-zero figure is shown in bold as a warning.
- **G/L line** (سطر الأستاذ العام) / **Subledger entry** (قيد الدفتر الفرعي) — in the Investigation table: the amount of the journal line (debit less credit) and the amount recorded for the customer against that line ("—" when nothing was recorded).
- **Open invoices & debit notes** (الفواتير والإشعارات المدينة المفتوحة) — in the By customer table: what the customer's posted documents still owe; beside it the customer's subledger balance, their unapplied credits and any non-invoice debit, which together explain the gap between the two.

### After you save — Customer Reconciliation
Nothing is saved; the screen only reads.

### Refusals — Customer Reconciliation
- "No account is designated as a customer control account." (لا يوجد حساب محدد كحساب مراقبة للعملاء.) — Finance must mark the receivable account as the customer control account in the Chart of Accounts.
- "No customer has a balance." (لا يوجد عميل لديه رصيد.) — nothing posted yet for the date.

## List of customers (قائمة العملاء)
Path: Monitoring → Monitoring → List of customers   |   Arabic: المتابعة ← المتابعة ← قائمة العملاء
Address: /monitoring/customer-list
Needs: `view` on `monitoring`.
What it is for: A screen of the Monitoring module that is drawn but not built yet. It shows only **Coming soon** (قريباً). It is not the customer master — to work with customers use Accounting → Master Data — Financial → Customers.

### How to use it — List of customers
There is nothing to do on this screen yet: no list, no search, no buttons. The tabs at the top lead to the two other Monitoring screens, History and Reports, which say the same. In the menu its name is greyed and hovering shows "Not yet built" (لم تُنشأ بعد).

### Refusals — List of customers
- "Not available to you" (غير متاح لك) — you do not hold the Monitoring permission; ask an administrator.

## History (السجل)
Path: Monitoring → Monitoring → History   |   Arabic: المتابعة ← المتابعة ← السجل
Address: /monitoring/history
Needs: `view` on `monitoring`.
What it is for: A Monitoring screen that is drawn but not built yet; it shows only **Coming soon** (قريباً). For the history of one record, use the clock icon on that record (Audit log).

### How to use it — History
There is nothing to do on this screen yet. To see what happened to a document, open the document and press the clock icon in its title bar.

### Refusals — History
- "Not available to you" (غير متاح لك) — you do not hold the Monitoring permission.

## Reports (التقارير)
Path: Monitoring → Monitoring → Reports   |   Arabic: المتابعة ← المتابعة ← التقارير
Address: /monitoring/reports
Needs: `view` on `monitoring`.
What it is for: A Monitoring screen that is drawn but not built yet; it shows only **Coming soon** (قريباً). The receivables reports that work today are Customer Statements, Receivables Ageing and Customer Reconciliation.

### How to use it — Reports
There is nothing to do on this screen yet.

### Refusals — Reports
- "Not available to you" (غير متاح لك) — you do not hold the Monitoring permission.
