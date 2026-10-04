# General Ledger — user guide

The General Ledger heading (Accounting → General Ledger; Arabic: المحاسبة ← الأستاذ العام) is the company's books.
Work flows in this order: the year and its months are opened on **Accounting Periods**; **Posting Mappings** say which account every business document posts to; documents elsewhere (invoices, payments, receipts, stock, payroll) and the manual **Journal Entries** (plus **Recurring Journals**, which raise draft journal entries on a schedule) put posted journals into the ledger; a wrong posted journal is undone by a reversal, listed on **Reversals**.
**G/L Inquiry** and **Trial Balance** read the posted journals; **Account Reconciliation** compares each control account with its sub-ledger; the month is locked on **Period / Year-End Closing** once its checklist passes.
The four statements — **Income Statement**, **Balance Sheet**, **Changes in Equity**, **Cash Flow Statement** — read the same posted journals through the Statement Mapping.
Every list and report screen of this heading shows a row of tabs at the top with the other General Ledger screens you are allowed to open.

## Concepts — General Ledger

These ideas are shared by every screen under Accounting → General Ledger. The screen blocks below refer to them by name.

### Double entry — Concepts — General Ledger
Every journal has at least two lines. Each line names one account and carries either a debit or a credit, never both. The debits of a journal must equal its credits, measured in Iraqi dinars (IQD). A journal that does not balance cannot be submitted or posted. The ledger has no separate table of balances: an account's balance is simply the sum of the posted journal lines on it, so every report here (G/L Inquiry, Trial Balance, the four statements) is the same journals read in a different shape.

### Dimensions on a journal line — Concepts — General Ledger
Besides the account and the amount, a journal line can carry these tags (dimensions), used for filtering and for sub-ledgers:
- **Branch** (الفرع) — one journal belongs to one branch only, shown in the journal's header; every line takes that branch. For another branch, raise a separate journal.
- **Department / Cost Centre** — which department the cost or income belongs to. On a manual journal this is the **Department** (القسم) column of the lines.
- **Business Line**, **Project**, **Warehouse**, **Customer / Supplier**, **Employee / Salesperson** — filled in by the document that posted the journal (an invoice knows its customer, a stock movement its warehouse, a project invoice its project). The manual journal screen has no boxes for these.

Which dimensions an account requires is set on the account in the Chart of Accounts (as delivered, expense accounts require a department). If a required dimension is missing the line is refused with "Account … requires …".

### What "posted" means, and why a posted journal is reversed, not edited — Concepts — General Ledger
A journal moves through these statuses: **Draft** (مسودة) → **Pending approval** (بانتظار الموافقة) → **Posted** (مرحّل); from Pending approval it can also become **Rejected** (مرفوض); a posted journal that has been undone shows **Reversed** (معكوس).
- A Draft has no accounting effect. It can be changed or deleted.
- **Posted** means the lines are in the ledger: they count in G/L Inquiry, Trial Balance, the statements and the sub-ledgers (customer, supplier, bank…). From that moment the journal is locked — nothing on it can be edited or deleted, by anyone.
- A posted journal that is wrong is corrected by a **reversal**: a second journal, linked to the first, with every line's debit and credit swapped at exactly the same IQD and USD figures. The original becomes Reversed, the reversal is Posted, and both stay on the record with the reason. Then the correct journal is raised as a new entry. This keeps the full story: what was posted, that it was undone, why, and by whom.
- A reversal cannot itself be reversed, and a journal can be reversed only once.
- Reports count both Posted and Reversed journals, so an original and its reversal cancel each other.

### Maker-checker on journals — Concepts — General Ledger
A manual journal is raised by one person and approved by the Accounting Manager:
- A person who can create and submit (as delivered, the Accounting Officer role) presses **Submit**; the journal becomes Pending approval and waits for the Accounting Manager.
- The Accounting Manager opens it and presses **Approve and post** (or **Reject** with a reason). Approval and posting are one act — there is no "approved but not posted" journal.
- A person who may post (as delivered, the Accounting Manager role) and raises a journal personally posts it directly with **Submit**: the manager's own journal needs no second signature.
- The approval step asks for the Accounting Manager role by name. Somebody who passes every permission check (a Super User) but does not hold that role is refused with "This step is approved by 'accounting_manager'. You do not hold that role."
- Only people who belong to a Finance department can raise or submit a manual journal at all.
- A **Recurring Journal** template is stricter: it must be agreed by somebody other than the person who wrote it (a Super User alone is excepted).

### Periods: open, soft closed, closed — Concepts — General Ledger
Every journal posts into the monthly period that contains its posting date. A period has one of three states:
- **Open** (مفتوحة) — postings are accepted, including back-dated ones.
- **Soft closed** (مغلقة مؤقتاً) — the routine month-end lock. Documents (invoices, payments, receipts) and ordinary journals dated in the month are refused. The screen's hint says a soft-closed month "still allows an approved adjustment", but the journal screen has no box for the reason such an adjustment must carry, so in practice the month is set back to Open for the adjustment and soft closed again.
- **Closed** (مغلقة) — final. Nothing posts into a closed period by any route: no journal, no document, no reversal, no stock movement dated in it. A closed period cannot be reopened from the screens. Periods close in order: a month cannot be closed while an earlier month of the same year is not closed.

If no period covers a date, nothing can be posted on that date until the year is opened on Accounting Periods.
A correction for a closed month is posted in an open month.

### IQD ledger, USD reading — Concepts — General Ledger
The ledger is kept in Iraqi dinars (IQD). Every posted line stores three figures: the amount as entered (in the account's currency), its value in IQD, and its value in USD. The IQD and USD values are worked out from the exchange rate in force on the journal's **posting date**, taken from Accounting → Master Data — Financial → Currencies and Rates (العملات وأسعار الصرف). The rate is never typed on a journal.
- A journal must balance in IQD. USD is a reading, not a second ledger.
- On every report the **Report currency** (عملة التقرير) box offers IQD or USD. USD adds up the USD figures stored on each line when it posted; nothing is converted again at report time, so last March's report gives the same figures whenever it is run.
- Because each line carries the rate of its own day, a USD Trial Balance over a period with several rates may show a small difference between debits and credits. That is expected; the IQD totals always agree.
- A reversal copies the original's IQD and USD figures, so it cancels the original exactly.

### How the four statements read the same journal — the Statement Mapping — Concepts — General Ledger
The Income Statement, Balance Sheet, Changes in Equity and Cash Flow Statement are not separate books. Each one reads the posted (and reversed) journal lines and groups the accounts into lines. Which line an account prints on is the **Statement Mapping** (تخطيط القوائم المالية), kept at Accounting → Master Data — Financial → Statement Mapping.
- Every account can be given a line on each of the four statements, independently.
- An account nobody has mapped falls on the default line for its type (asset, liability, equity, revenue, expense), so the statements are complete from the first day.
- Revenue and expense accounts are not Balance Sheet lines. Their accumulated result appears under Equity as **Result to date (not yet closed to retained earnings)** (النتيجة حتى تاريخه (لم تُقفل بعد إلى الأرباح المحتجزة)); that is what makes the two sides of the Balance Sheet agree.
- On the Cash Flow Statement the accounts placed on the mapping's cash line are "the cash"; every other account's movement explains the change in it.
- Totals such as Gross profit or Net income are lines of the mapping too: each shows the running total of everything above it.

If a figure sits on the wrong line of a statement, the fix is on the Statement Mapping screen, not in the journal.

### The four icons on a record — Concepts — General Ledger
A record window (a journal entry, a recurring journal, a period on the closing screen) carries four small icons in its title bar, in this order:
1. **Printer** — **Print / Export** (طباعة / تصدير): the record as a file. See "Print / Export" below.
2. **Paperclip** — **Attachments** (المرفقات): the files attached, with a number showing how many. Where you may attach, it holds **Choose a file** (اختر ملفاً) and **Attach** (إرفاق). Up to 25MB; programs and archives are refused.
3. **Speech mark** — **Notes** (الملاحظات): a table of When (متى) / Who (من) / Note (ملاحظة), newest first, and a box **Add note** (إضافة ملاحظة). A note is dated, signed and can never be edited or removed. 1 to 2,000 characters.
4. **Clock** — **Audit log** (سجل التدقيق): everything recorded about the record — who did what, when, with the reason and the before/after values.

### Print / Export — Concepts — General Ledger
Reports show a **Print / Export** (طباعة / تصدير) menu at the top of the screen; records show it behind the printer icon. It lists two languages — **English** and **العربية** — and under each the formats you are allowed: **PDF**, **Excel (.xlsx)**, **Word (.docx)**. Press one to download the file.
- PDF needs the print right; Excel and Word need the export right, on the same thing the screen itself is opened under. A format you may not have is not shown; if you may have none, there is no menu.
- A report is exported with exactly the filters the screen was run with (press **Run** first), and the filters are printed at the top of the file.
- The language of the copy is chosen per download and does not depend on your own screen language.
- A record that is not posted prints with the watermark **DRAFT / NOT POSTED** (مسودة / غير مرحّل).
- A file may carry at most 20,000 rows. Above that the download answers "This export has … rows; a file may carry at most …. Narrow the filters (a shorter period, one item or one warehouse) and export again."
- Every export is written to the audit trail.

### Where a refusal appears — Concepts — General Ledger
When the system refuses something, the page shows a red banner headed **That could not be saved.** (تعذّر الحفظ.) followed by the reason. On the journal's line grid and header boxes the reason appears directly on the row or under the boxes instead. Success shows **Saved.** (تم الحفظ.). The reasons themselves are written in English.

## Journal Entries (قيود اليومية)
Path: Accounting → General Ledger → Journal Entries   |   Arabic: المحاسبة ← الأستاذ العام ← قيود اليومية
Address: /finance/journals (one entry: /finance/journals/ENTRY-NUMBER; its audit log on a page of its own: /finance/journals/ENTRY-NUMBER/audit)
Needs: `view` on `journal_entry` to open the list and any entry. `create` on `journal_entry` plus membership of a Finance department for **New journal**; `edit_draft` to type the header and lines, add a note or delete a draft; `submit` to submit; `approve` (and the Accounting Manager role) to approve or reject; `post` to post your own entry directly; `reverse_cancel` to reverse; `print` for PDF and `export` for Excel/Word; `create` on `attachment` to attach a file.
What it is for: The register of every journal in the books — the manual ones typed here and the ones posted automatically by documents (invoices, payments, receipts, stock, payroll). It is where Finance raises a manual journal, sends it for approval, posts it, and reverses a posted one. There is no separate "new" page: the entry opens at once and is filled in on its own record.

### How to find a journal — Journal Entries
1. Open Accounting → General Ledger → Journal Entries. The list shows the entries of the branches you are allowed to see, newest posting date first.
2. Columns: **Reference** (المرجع) — the entry number, a link; **Posting date** (تاريخ الترحيل); **Description** (البيان); **Amount** (المبلغ) — the total of the debits in IQD; a paperclip column — how many files are attached; **Branch** (الفرع); **Raised by** (أنشأه); **Status** (الحالة).
3. To search, type in **Search this list** (ابحث في هذه القائمة) and press the search button. It looks in the number, the dates (written YYYY-MM-DD), the description, the branch, the raiser's name, the amount and the status word in English (draft, submitted, posted, rejected, reversed). **Clear** (مسح) removes the search.
4. To see one month only, open Accounting Periods and press the period's name in the Calendar: the list opens with "Showing entries posted in 2026-03." and a **Clear** link.
5. Press the entry number to open the record.

### How to create a journal — Journal Entries
1. Open Accounting → General Ledger → Journal Entries and press **New journal** (قيد جديد). The button shows only if you may create journals and you belong to a Finance department. If you may create journals but are not in a Finance department, the page says instead: "You are not in a Finance department, so you cannot raise an entry yet. An administrator adds a department with "Finance department" ticked, then adds you to it."
2. The entry opens immediately as a **Draft** with its number already given (for example JE-2026-000001), dated today, in the branch you are working in. The number is never reused, even if the draft is deleted.
3. Correct the header if needed: **Posting date** (تاريخ الترحيل), **Document date** (تاريخ المستند), **Description** (البيان). Each box is saved when you leave it — there is no Save button.
4. Enter the lines (see "How to enter the lines").
5. When the line under the grid says **Balanced** (متوازن), press **Submit** (إرسال).

### How to enter the lines — Journal Entries
1. On a Draft, the **Lines** (البنود) grid is typed into directly. There is no "Add line" button: fill the empty last row and a new empty row appears beneath it.
2. In **Account** (الحساب) choose the account from the list ("Choose an account…" / اختر حسابًا…). Only active, approved posting accounts are listed; an account tied to a foreign currency shows it after its name, for example "… · USD".
3. In **Department** (القسم) choose the department the cost or income belongs to. The first department in the list is pre-selected.
4. Type the amount in **Debit** (مدين) or in **Credit** (دائن). Typing in one empties the other — a line has one side only.
5. Leave the row (click elsewhere or press Tab; Enter in an amount box also leaves it). The row is saved the moment it has an account and one amount; "saving…" (جارٍ الحفظ…) shows briefly in the Total row. If the system refuses the row, the reason appears in red under the account on that row.
6. To change a saved row, edit the cell and leave the row; it is saved again in place and keeps its line number.
7. To remove a row press **✕** — **Remove line** (إزالة البند) — at the end of the row. The remaining lines are renumbered.
8. Watch the foot of the grid: **Total** (الإجمالي) of each side, then **Balanced** (متوازن), or **Out of balance · Difference …** (غير متوازن · الفرق) with the amount still missing.

### How to open a record and what it shows — Journal Entries
1. Press the entry number in the list (or any journal number shown as a link elsewhere: in G/L Inquiry, in Reversals, on a recurring journal).
2. The window is titled **Journal Entry** (قيد يومية) with the number. At the top right are the four icons (see "The four icons on a record").
3. Header boxes: **Entry no.** (رقم القيد), **Status** (الحالة), **Branch** (الفرع), **Raised by** (أنشأه), **Approved by** (اعتمده), **Posting date** (تاريخ الترحيل), **Document date** (تاريخ المستند), **Description** (البيان), **Created** (تاريخ الإنشاء), **Posted on** (تاريخ الترحيل الفعلي).
4. If a recurring journal raised it, **Raised from** (أُنشئ من) links to that template. If it was reversed, or is itself a reversal, a wide box says **This entry was reversed by:** (عُكس هذا القيد بموجب:) or **This entry reverses:** (هذا القيد يعكس:) with a link to the other entry.
5. **Lines** (البنود): on anything that is no longer a Draft the lines are read-only — #, **Account** (a link to the account's page in the Chart of Accounts), **Department**, **Debit**, **Credit** in IQD. A line entered in another currency shows the entered amount beneath the IQD figure. The foot shows **Debits** (المدين) and **Credits** (الدائن).
6. The buttons along the foot depend on the status and on what you may do: **Submit** on a Draft; **Approve and post** and **Reject** on Pending approval; **Reverse** on a Posted entry; **Delete draft** on a Draft.

### How to submit a journal — Journal Entries
1. Open the Draft. Make sure it has at least two lines and the foot says **Balanced**.
2. Press **Submit** (إرسال).
3. If you may only submit: the status becomes **Pending approval** (بانتظار الموافقة) and the entry is locked for editing; the Accounting Manager must now approve it.
4. If you may post (Accounting Manager): the same press approves and posts it — the status becomes **Posted** (مرحّل) straight away.
5. A submitted entry cannot be taken back by its raiser from this screen. If it must change, the Accounting Manager rejects it.

### How to approve or reject a journal — Journal Entries
1. Open the entry whose status is **Pending approval**. (The list can be searched with the word "submitted".)
2. Check the lines, the dates and the attachments (paperclip icon).
3. To accept, press **Approve and post** (اعتماد وترحيل). The entry becomes **Posted**; **Approved by** shows your name and **Posted on** the time.
4. To refuse, type the reason in **Reason for rejection** (سبب الرفض) and press **Reject** (رفض). The entry becomes **Rejected** (مرفوض).
5. A Rejected entry stays in the list for the record. This screen offers no way to edit, resubmit or delete it: the raiser opens a **New journal** and enters it again correctly.

### How to reverse a posted journal — Journal Entries
1. Open the **Posted** entry. The **Reverse** (عكس القيد) button shows only if you may reverse, and only on an entry that is not itself a reversal and has not been reversed already.
2. Press **Reverse**. A window **Confirm journal reversal** (تأكيد عكس القيد) opens: "You are about to reverse … This creates a linked journal entry that offsets it. This action cannot be undone."
3. Type the reason in **Why it is being reversed** (سبب العكس) — required.
4. Press **Yes, reverse this journal** (نعم، اعكس هذا القيد), or **Cancel** (إلغاء).
5. The system creates and posts the reversal at once — no approval step — and opens it. The reversal is dated today (or the original's posting date, if that is later), its description reads "Reversal of ORIGINAL-NUMBER — your reason", and every line is the original's with debit and credit swapped. The original's status becomes **Reversed** (معكوس). Each of the two shows a link to the other.
6. Raise a new journal with the correct figures if one is needed.

Note: today's period must accept postings, because the reversal is dated today.

Note: the Reverse button is also offered on a journal that a document posted (an invoice, a payment, a receipt, a stock document). Reversing it here undoes only the journal — the document itself, its stock and its open balance stay as they were. A posted purchase or sales invoice is corrected on its own page with its own Reverse action, which reverses the journal and puts the stock back; for any other document use that document's own correction on its own screen, not this button.

### How to delete a draft — Journal Entries
1. Open the Draft and press **Delete draft** (حذف المسودة).
2. Confirm in the window **Delete this draft?** (حذف هذه المسودة؟) with **Delete it** (احذفها), or press **Cancel** (إلغاء). The message says: "… and its lines will be removed. This cannot be undone, and the number is not given to another entry."
3. You return to the list. The entry, its lines and its attachments are gone; the audit trail keeps the fact that it existed and who deleted it; its number leaves a gap in the series.

Only a Draft can be deleted.

### How to print or export a journal — Journal Entries
1. Open the entry and press the printer icon — **Print / Export** (طباعة / تصدير).
2. Choose the language row (English or العربية) and the format: PDF, Excel (.xlsx) or Word (.docx).
3. The file is the **Journal Voucher** (سند قيد): number, status, posting and document dates, raised by, approved by, description; each line with its account, currency, the entered debit/credit, the IQD debit/credit and the USD debit/credit; IQD totals; the USD totals; and signature lines Prepared by / Approved by (CEO) / Received by. An entry that is not posted carries the DRAFT / NOT POSTED watermark.
4. If you may print, the browser's own Print (Ctrl+P) on the entry page also prints the voucher rather than the screen.

### How to attach a file to a journal — Journal Entries
1. Open the entry while it is a **Draft** and press the paperclip icon — **Attachments** (المرفقات).
2. Press **Choose a file** (اختر ملفاً), pick the file, press **Attach** (إرفاق).
3. The file is listed with its size, who attached it and when; pressing its name opens it.

After the entry leaves Draft the paperclip only lists the files — nothing more can be attached, so attach the supporting paper before submitting.

### How to add a note to a journal — Journal Entries
1. Open the entry (any status) and press the speech-mark icon — **Notes** (الملاحظات).
2. Type in **Add note** (إضافة ملاحظة) and press **Add note**.
3. The note appears at the top of the table with the time and your name. Notes cannot be edited or deleted.

### How to see who did what on a journal — Journal Entries
1. Open the entry and press the clock icon — **Audit log** (سجل التدقيق).
2. The log lists every event: created, each line added, changed or removed (with before and after), header changes, submitted, posted, rejected (with the reason), reversed (with the reason), notes and exports.

### Fields — Journal Entries
Header:
- **Entry no.** (رقم القيد) — given by the system when New journal is pressed; cannot be changed; never reused. The number carries the year of the posting date.
- **Status** (الحالة) — Draft (مسودة), Pending approval (بانتظار الموافقة), Posted (مرحّل), Rejected (مرفوض), Reversed (معكوس).
- **Branch** (الفرع) — the branch you were working in when you pressed New journal. Cannot be changed; every line belongs to it.
- **Raised by** (أنشأه) — who created the entry. Automatic.
- **Approved by** (اعتمده) — who approved and posted it; "—" until then.
- **Posting date** (تاريخ الترحيل) — required; defaults to today. "The date it hits the books; it decides the period." It also decides the exchange rate: changing it on a draft re-values every line at the new date. It must stay inside the year the entry was numbered in, and may not be earlier than the document date. Earlier dates than today are allowed if their period is open.
- **Document date** (تاريخ المستند) — the date on the paper; defaults to today; may not be later than the posting date. Left empty, it takes the posting date.
- **Description** (البيان) — optional free text saying what the entry is for. It is shown in the list, in the account's ledger in G/L Inquiry and on the voucher.
- **Created** (تاريخ الإنشاء), **Posted on** (تاريخ الترحيل الفعلي) — automatic time stamps.
- **Raised from** (أُنشئ من) — the recurring journal that raised this entry, if one did.

Lines:
- **#** — line number, automatic.
- **Account** (الحساب) — required. Active, approved posting accounts only (no group accounts). A control account (customer, supplier, bank, inventory and the like) can be used only by a person who may post journals.
- **Department** (القسم) — one of the active departments; always filled (the first in the list by default). "Which department the cost or income belongs to."
- **Debit** (مدين) / **Credit** (دائن) — exactly one of the two, more than zero. The amount is in the account's currency: IQD, unless the account is tied to another currency, in which case it is converted to IQD and USD at the posting date's rate.
- **Total** (الإجمالي) and **Balanced** (متوازن) / **Out of balance** (غير متوازن) with **Difference** (الفرق) — worked out live from what is typed. The running total adds the typed figures as they are; the binding check, in IQD, is made when you submit.

There is no per-line description and no box for project, warehouse, customer/supplier or employee on a manual journal.

### After you save — Journal Entries
- **Draft** (مسودة): nothing is in the ledger. The raiser edits, attaches, then submits — or deletes it.
- **Pending approval** (بانتظار الموافقة): locked for editing; waits for the Accounting Manager to approve and post, or reject.
- **Posted** (مرحّل): the lines are in the ledger from this moment — they appear in G/L Inquiry, Trial Balance and the statements, and lines on control accounts are written to the matching sub-ledger (customer, supplier, bank…). Approved by and Posted on are filled. The entry can no longer be changed or deleted; it can only be reversed.
- **Rejected** (مرفوض): nothing was posted; the entry is kept as it was, with the reason in the audit log.
- **Reversed** (معكوس): the entry was undone by the linked reversal entry, which is itself Posted. Both remain in the ledger and cancel each other.

A journal posted by a document goes straight to Posted when its document posts; it never passes through Draft on this screen.

### Refusals — Journal Entries
Creating and editing:
- "Only people in a finance department can raise journal entries, and you are not in one yet. To fix it: Accounting → Master Data → Departments, add a department with "Finance department" ticked; then Settings → Users, open your user and add it to that department." — raising or submitting needs membership of a Finance department, even for a Super User. (Departments are found today under Accounting → Master Data — Organization → Departments.)
- "No accounting period covers …, so nothing can be posted on that date yet. Open the year first: Accounting → General Ledger → Accounting Periods, then "Open a year"." — the fiscal year for that date has not been opened.
- "The document date cannot be after the posting date: a paper cannot be written after the entry that records it." — correct one of the two dates.
- "… is numbered in 2026, so it posts in that year. For another year, open a new entry." — the posting date was moved to another year.
- "Journal … is submitted and its lines can no longer be changed." (or "… and can no longer be changed.") — the entry has left Draft.
- "Cannot post to …: it is the bank control account. Direct manual posting requires Finance Manager approval; ordinarily it is posted by the source document, not by hand." — (the word before "control account" is the kind: customer, supplier, bank, inventory…). Only a person who may post journals can put a manual line on a control account; ask the Accounting Manager to enter that line, or use the proper document.
- "Cannot post to …: the account is inactive. An inactive account keeps its history but accepts no new entries.", "Cannot post to …: it is a group account. Groups summarise their children; postings go to a posting account beneath it.", "Cannot post to …: it is still '…'. An account accepts entries only once the Accounting Manager has approved it." — choose an active, approved posting account.
- "Account … requires Project. Supply the missing value(s) and post again." (or Warehouse, Customer / Supplier, Employee / Salesperson, Business Line) — the account demands a dimension the manual journal has no box for. Use an account that does not require it, or have Finance change the account's required dimensions in the Chart of Accounts.
- "Line … has no amount. Remove it, or give it a debit or a credit." / "Line … carries both a debit and a credit. Split it into two lines." — one side per line.
- "No USD exchange rate has been published yet, so this cannot be valued. Add one in Accounting → Master Data → Currencies and Rates." — every line is also valued in USD, so at least one USD rate must exist (the same message names another currency when the account is tied to it).

Submitting, approving, posting:
- "A journal needs at least two lines: one debit and one credit. A single-sided entry cannot balance."
- "The journal totals zero. An entry that moves nothing has no accounting effect — cancel it instead."
- "The journal does not balance in IQD. Debits total … and credits …, a difference of …. Every journal must balance in IQD (§14.3)." — fix the lines until the foot says Balanced.
- "Cannot post into …: the period is closed. A closed period is final — the correction belongs in an open period (§3.2)." — change the posting date to an open period.
- "Cannot post into …: the period is soft-closed. Only a Finance Manager may post an approved adjustment into it (§14.6)." — an ordinary user cannot post into a soft-closed month.
- "Posting into soft-closed … is an override and requires a stated reason, which is recorded and reported (§24)." — shown to a person who holds the override right; the journal screen has no box for that reason. Way out: on Accounting Periods set the period back to Open, post the journal, then soft close it again — or date the journal in an open period.
- "This step is approved by 'accounting_manager'. You do not hold that role." — approving and posting need the Accounting Manager role itself; a Super User without that role is refused too, and the entry stays as it was.
- "Account … is the customer control account, so the posting must say which customer it is against. Without it the subledger cannot reconcile to the account (§1.2)." — (also supplier, inventory, project, loan, bank). A manual line on a customer, supplier, inventory, project or loan control account cannot name its party on this screen, so the entry cannot post; use the proper document (invoice, receipt, payment, credit note) instead. A line on a bank or cash account's G/L account is accepted, because the account names its own bank.
- "… would hold -… IQD, and a bank or cash account cannot hold less than nothing. Deposit or draw the money first, or pay from an account that holds it." — the journal would take a bank or cash account below zero.
- "A journal_entry cannot move from 'posted' to 'posted'. …" (any pair of statuses) — somebody else already acted on the entry; reload the page.
- "Permission denied: 'submit' on 'journal_entry' is not granted to this user." (any action name) — your role lacks that right.

Reversing and deleting:
- "A reversal records why the original was wrong; give a reason."
- "Journal … is submitted; only a posted journal is reversed."
- "Journal … is itself a reversal and cannot be reversed (§14.3)." — post a fresh journal instead.
- "Journal … has already been reversed."
- "Cannot post into …: the period is closed…" on Reverse — the reversal is dated today, so today's period must be open.
- "… is posted, not a draft, so it cannot be deleted. Only a draft can be thrown away. An entry that has been posted is corrected by reversing it, which leaves both facts on the record: that it was posted, and that it was undone."

Attachments and notes:
- "… was not accepted: …" — the file was refused (too large, or a program/archive).
- "A note says something. Write what is happening with this record." / "A note is at most 2,000 characters. Attach a longer text as a file."

## Reversals (القيود العكسية)
Path: Accounting → General Ledger → Reversals   |   Arabic: المحاسبة ← الأستاذ العام ← القيود العكسية
Address: /finance/reversals
Needs: shown in the menu to a user with `view` on `journal_reversal`; the page itself opens for `view` on `journal_entry`.
What it is for: A read-only register of every correction made to the books: each reversed journal beside the journal that reversed it, and the reason. It answers "what has been changed, and why". Nothing can be done on this screen — a reversal is made on the journal being corrected (see Journal Entries, "How to reverse a posted journal").

### How to read the register — Reversals
1. Open Accounting → General Ledger → Reversals. The newest reversal is at the top.
2. Columns: **Original** (القيد الأصلي) — the reversed journal's number, a link to it; **Posted** (رُحّل) — the original's posting date; **Amount** (المبلغ) — the original's total debits in IQD; **Reversal** (القيد العكسي) — the reversing journal's number, a link; **Reversed** (عُكس) — the reversal's posting date; **Reason** (السبب) — the reversal's description, "Reversal of ORIGINAL — the reason typed".
3. Press either number to open that journal.
4. If nothing was ever reversed the table says **Nothing has been reversed.** (لم يُعكس أي قيد.)

The register has no filter, no search and no Print / Export menu. It lists journal reversals whether they were made on the journal's page or by reversing a document.

### Fields — Reversals
There is nothing to fill in on this screen.

### After you save — Reversals
Nothing is saved here. A row appears the moment a posted journal is reversed: the original shows Reversed, the reversal shows Posted.

### Refusals — Reversals
None on this screen. The refusals for making a reversal are listed under Journal Entries.

## G/L Inquiry (الاستعلام عن الأستاذ العام (G/L))
Path: Accounting → General Ledger → G/L Inquiry   |   Arabic: المحاسبة ← الأستاذ العام ← الاستعلام عن الأستاذ العام (G/L)
Address: /finance/gl-inquiry (one account: /finance/gl-inquiry/ACCOUNT-CODE)
Needs: `view` on `gl_inquiry`. `print` on `gl_inquiry` for PDF, `export` for Excel/Word.
What it is for: The General Ledger as a read-only table: every account with its balance at a date, and — one press on an account — every posted journal line on it with a running balance. The page title is **General Ledger** (الأستاذ العام).

### How to see every account's balance — G/L Inquiry
1. Open Accounting → General Ledger → G/L Inquiry.
2. Set the filters in the strip: **As at** (كما في) — the date; the balance counts everything posted from the beginning up to and including it (default today). **Report currency** (عملة التقرير) — IQD or USD. **Reporting level** (مستوى التقرير) — Level 1 shows only the chart's top headers; each further level opens what is beneath them; the deepest level (the default) lists every posting account.
3. Press **Run** (عرض).
4. Columns: **Account** (الحساب) — the code; **Name** (الاسم); **Type** (النوع) — Asset (أصول), Liability (التزامات), Equity (حقوق ملكية), Revenue (إيرادات), Expense (مصروفات); **Balance** (الرصيد) — one figure, marked **Dr** (مدين) or **Cr** (دائن) for the side it falls on; no minus sign is printed.
5. At the deepest level every active, approved posting account is listed even with a zero balance. At higher levels only headers that have movement are shown, each carrying the sum of the accounts beneath it.

The figures cover all the branches you are allowed to see, added together; there is no branch filter.

### How to see the journals behind one account — G/L Inquiry
1. On the G/L Inquiry table press a posting account's code or name (run the table at the deepest level to see every account; header rows are not links).
2. The account's page opens, titled "CODE · Name". Set **From** (من) and **To** (إلى) — default 1 January to 31 December of the current year — and **Report currency**; press **Run** (عرض).
3. Columns: **Posting date** (تاريخ الترحيل); **Entry** (القيد) — the journal number, a link to the journal; **Description** (البيان) — the journal's description; **Debit** (مدين); **Credit** (دائن); **Balance** (الرصيد) — the running balance after each line.
4. The foot shows **Balance** — the running balance after the last line.
5. The running balance starts from zero at the From date; it does not bring forward what was posted before it. To read the account's true balance, set From to a date before the account's first posting, or read the balance on the G/L Inquiry table.
6. **Back to list** (العودة إلى القائمة) returns to the table. If nothing was posted: **Nothing was posted in this period.** (لم يُرحّل شيء في هذه الفترة.)

### How to print or export — G/L Inquiry
1. Run the screen with the filters you want.
2. Press **Print / Export** (طباعة / تصدير) at the top, choose English or العربية, then PDF, Excel (.xlsx) or Word (.docx).
3. On the table the file is the **General Ledger** (الأستاذ العام) at that date, currency and level. On an account's page it is the **Account Ledger** (دفتر أستاذ الحساب) for that account and period, with debit and credit totals.

### Fields — G/L Inquiry
- **As at** (كما في) — required date; default today. Balances are positions: everything posted up to this date.
- **From** (من) / **To** (إلى) — on an account's page only; required dates; default the current calendar year.
- **Report currency** (عملة التقرير) — IQD (default) or USD. "IQD is the ledger. USD reads the same postings at the rate that applied when each one posted."
- **Reporting level** (مستوى التقرير) — Level 1 … Level N, where N is how deep the chart goes; default the deepest.

### After you save — G/L Inquiry
Nothing is saved; the screen only reads. A journal appears here the moment it is Posted. Drafts, Pending approval and Rejected journals never appear. Posted and Reversed journals are both counted.

### Refusals — G/L Inquiry
The screen refuses nothing. An account code that does not exist gives a "not found" page. An export of more than 20,000 rows is refused — shorten the period.

## Trial Balance (ميزان المراجعة)
Path: Accounting → General Ledger → Trial Balance   |   Arabic: المحاسبة ← الأستاذ العام ← ميزان المراجعة
Address: /finance/trial-balance
Needs: `view` on `trial_balance`. `print` on `trial_balance` for PDF, `export` for Excel/Word.
What it is for: A read-only report of every account that moved in a period, with its total debits and total credits, and the two grand totals that must agree. It is the first check that the books balance.

### How to run the report — Trial Balance
1. Open Accounting → General Ledger → Trial Balance.
2. Set **From** (من) and **To** (إلى) — default 1 January to 31 December of the current year; **Report currency** (عملة التقرير) — IQD or USD; **Reporting level** (مستوى التقرير) — Level 1 shows only the chart's top-level headers, each further level opens the headers beneath them, and the deepest level (the default) shows the posting accounts.
3. Press **Run** (عرض).
4. Columns: **Account** (الحساب), **Name** (الاسم), **Type** (النوع), **Debit** (مدين), **Credit** (دائن). The Debit and Credit columns are the totals posted to the account in the period — not a net balance and not an opening balance.
5. The last row is **Totals** (الإجماليات). The foot says **Debits equal credits** (المدين يساوي الدائن), or **Out by …** (الفرق …) with the difference, and repeats **Debits** (المدين) and **Credits** (الدائن).
6. Only accounts with movement in the period are listed. Header rows carry the sums of what is beneath them.

The report covers all the branches you are allowed to see, added together; there is no branch filter and no comparison column.

### How to print or export — Trial Balance
1. Run the report with the period, currency and level you want.
2. Press **Print / Export** (طباعة / تصدير), choose English or العربية, then PDF, Excel (.xlsx) or Word (.docx). The file shows the same rows, with the period, currency and level printed at the top.

### Fields — Trial Balance
- **From** (من) / **To** (إلى) — required dates; default the current calendar year. Journals whose posting date falls between them (inclusive) are counted.
- **Report currency** (عملة التقرير) — IQD (default) or USD.
- **Reporting level** (مستوى التقرير) — Level 1 … Level N (the depth of the chart); default the deepest.

### After you save — Trial Balance
Nothing is saved. Posted and Reversed journals are counted (a journal and its reversal cancel); Drafts, Pending approval and Rejected are not.

### Refusals — Trial Balance
The screen refuses nothing. In IQD the totals always agree, because every journal balances in IQD. In USD, **Out by …** can show a small difference when the period spans several exchange rates — that is expected, not an error. If the IQD totals ever disagree, tell the Accounting Manager and run the close checks on Accounting Periods — the check "General ledger integrity" looks for unbalanced postings.

## Accounting Periods (الفترات المحاسبية)
Path: Accounting → General Ledger → Accounting Periods   |   Arabic: المحاسبة ← الأستاذ العام ← الفترات المحاسبية
Address: /finance/periods
Needs: `view` on `fiscal_period` to open. `configure` on `fiscal_period` to open a year or change a period's state.
What it is for: The accounting calendar. It opens a fiscal year (which creates its monthly periods), shows the state of every month, changes a month between Open, Soft closed and Closed, and shows the close checklist for any month. Nothing can be posted on a date until its year has been opened here.

### How to open a fiscal year — Accounting Periods
1. Open Accounting → General Ledger → Accounting Periods and press **Open a year** (فتح سنة) at the top. (Before any year exists the page says **No year has been opened yet.** — "Nothing can be posted until a year exists — open one to begin.")
2. Fill **Year** (السنة) — the year's code, pre-filled like FY2026; **Starts** (تبدأ) — pre-filled 1 January; **Ends** (تنتهي) — pre-filled 31 December.
3. Press **Create** (إنشاء).
4. The system creates one period per calendar month between the two dates, named by month and year (for example "January 2026"), all **Open**.

### How to read the calendar — Accounting Periods
1. The band at the top shows the month that contains today, its state, and under **This month** (الشهر الحالي) its first and last day.
2. The **Calendar** (التقويم) table lists every period: **Period** (الفترة), **Year** (السنة), **Starts** (تبدأ), **Ends** (تنتهي), **State** (الحالة) — Open (مفتوحة), Soft closed (مغلقة مؤقتاً) or Closed (مغلقة).
3. Press a period's name to open Journal Entries showing only the journals posted in that month.

### How to change a period's state (open, soft close, close) — Accounting Periods
1. In the panel **Change a period** (تغيير فترة) choose the **Period** (الفترة) — each is listed with its current state.
2. Choose the new **State** (الحالة): **Open** (مفتوحة), **Soft closed** (مغلقة مؤقتاً) or **Closed** (مغلقة).
3. Type the **Reason** (السبب) — required; it is kept in the audit trail beside the change.
4. Press **Save** (حفظ).
5. Choosing **Closed** runs the close checklist first. If any blocking check fails the close is refused; if only warnings remain the month closes and the warnings are recorded with the close.

Closing is final: a Closed period cannot be set back to Open or Soft closed. Soft closed can be set back to Open.
The same change, with the checklist beside it, is on Period / Year-End Closing.

### How to run the close checklist — Accounting Periods
1. In the panel **Period close checks** (فحوصات إقفال الفترة) choose the **Period** and press **Run checks** (تشغيل الفحوصات). Without a choice the panel shows the earliest period that is not yet closed.
2. The sentence above the table says either "… may be closed: every blocking check passes as at …. Warnings, if any, are recorded with the close." or "… cannot be closed: N blocking checks fail. Open each line to see the figure on its own screen."
3. Table columns: **Check** (الفحص) — a link to the screen that shows the same thing in full; **Kind** (النوع) — **Blocking** (مانع) or **Warning** (تحذير); **Figure** (الرقم) — the count, difference or rate the check looked at; **Detail** (التفاصيل) — the first eight items behind the figure, then "… and N more"; **State** (الحالة) — **Pass** (ناجح), **Fail** (فاشل) or **Warning** (تحذير).
4. Fix what fails on the linked screens, then press Run checks again.

See "The thirteen close checks" below for what each one means.

### The thirteen close checks — Accounting Periods
Blocking checks (a failing one stops the close):

1. **Earlier periods are closed** (الفترات السابقة مقفلة) — every earlier month of the same year must already be Closed. Detail: the months still open. Fix: close them first, in order.
2. **General ledger integrity (unbalanced or orphaned postings)** (سلامة دفتر الأستاذ العام (قيود غير متوازنة أو يتيمة)) — the count of integrity problems anywhere in the ledger; expected zero. Link: Trial Balance.
3. **Journals dated in the period not yet posted** (قيود مؤرخة في الفترة لم تُرحَّل بعد) — journals whose posting date is in the month and that are still Draft or Pending approval. Detail: their numbers and status. Fix: post them, delete the drafts, or reject the pending ones. Link: Journal Entries.
4. **Sub-ledgers equal their control accounts** (الدفاتر الفرعية تساوي حسابات الرقابة) — the number of control accounts (customers, suppliers, banks, loans…) whose sub-ledger total differs from the account's ledger balance at the month's last day. Detail: account and difference. The Account Reconciliation screen shows the same figures.
5. **Stock ledger agrees with its documents and layers** (دفتر المخزون يطابق مستنداته وطبقاته) — stock documents without movements, movements without a document, unbalanced transfers, positions that differ from their cost layers. Link: Stock Ledger.
6. **Stock documents dated in the period still waiting** (مستندات مخزون مؤرخة في الفترة ما زالت بانتظار الاعتماد) — Opening Stock documents dated in the month that are still draft or submitted. Link: Opening Stock.

Warnings (shown, recorded with the close, but they do not stop it):

7. **Inventory value (layers) equals the inventory accounts — now** (قيمة المخزون (الطبقات) تساوي حسابات المخزون — الآن) — the difference between the value of the stock's cost layers and the inventory accounts' balance, both taken at the month's last day. Link: Warehouses Report.
8. **Positions below zero (goods still at sea) — now** (أرصدة تحت الصفر (بضاعة ما زالت في البحر) — الآن) — items whose stock in a warehouse is negative right now.
9. **Every bank account reconciled to the period end** (كل حساب بنكي مطابَق حتى نهاية الفترة) — active bank accounts with no approved bank reconciliation dated on or after the month's last day. Detail: each account and when it was last reconciled. Link: Bank Reconciliation.
10. **A USD rate dated within the period** (سعر صرف للدولار مؤرخ ضمن الفترة) — warns when the latest USD rate in force at the month's end is dated before the month began, or when there is none. Fix: publish a rate on Currencies and Rates.
11. **Clearing accounts carrying a balance** (حسابات وسيطة تحمل رصيداً) — the mapped clearing accounts (money received not yet put to a customer, goods received not yet invoiced, goods returned not yet credited, import costs not yet locked) that still hold a balance at the month's end.
12. **Revenue recognised for every running customer project** (الإيراد مُعترف به لكل مشروع عميل جارٍ) — running customer projects with no revenue recognition to the month's end. Link: Projects → Billing.
13. **Payroll posted for every branch that employed anybody** (الرواتب مُرحّلة لكل فرع فيه موظفون) — branches with employees whose payroll for the month is missing or not posted. Link: Payroll.

Each night the system runs the same checks on the earliest unclosed month whose last day has passed and, when a blocking check fails, sends an in-app notification to every Accounting Manager and Super User.

### Fields — Accounting Periods
Open a year:
- **Year** (السنة) — required; the year's code, for example FY2026. Must be unique.
- **Starts** (تبدأ) — required date; must be the first day of a month.
- **Ends** (تنتهي) — required date; must be after Starts. "Twelve monthly periods are created between these dates." (one period per calendar month in the range). The range must not overlap a year that already exists.

Change a period:
- **Period** (الفترة) — required; every period of every year, shown as "name · state".
- **State** (الحالة) — required; Open (مفتوحة), Soft closed (مغلقة مؤقتاً), Closed (مغلقة).
- **Reason** (السبب) — required; "Why — this is kept in the audit trail".

### After you save — Accounting Periods
- A new year: its monthly periods exist and are Open; documents and journals dated in them can post.
- **Open**: postings are accepted.
- **Soft closed**: documents and ordinary journals dated in the month are refused. Set it back to Open to post a late adjustment, then soft close again.
- **Closed**: final. No journal, document or stock movement dated in the month can be posted; the month cannot be reopened here.

Changing a state posts no journal. The change, the reason and (for a close) the warnings it was taken over are kept in the audit trail and listed under Close history on Period / Year-End Closing.

### Refusals — Accounting Periods
- "Fiscal calendar is not usable: FY2026 starts on day 15. A monthly calendar must start on the first of a month." — start the year on the 1st.
- "Fiscal calendar is not usable: FY2026 ends on or before it starts" — fix the dates.
- A message naming "fiscal_year_code_uniq" or "fiscal_year_no_overlap" — the year code is already used, or the dates overlap a year that already exists. Use another code or other dates.
- "… is closed. Reopening a closed period is a year-end action and is not available here (§14.6, Phase 16)." — a Closed month cannot be changed.
- "Changing the status of … requires a reason, which is recorded (§5.4)." — type a reason.
- "… cannot be closed while these checks fail: sequence, unposted_journals. Open Period Close to see the figures." — the names are the checks' internal codes: sequence = Earlier periods are closed; gl_integrity = General ledger integrity; unposted_journals = Journals dated in the period not yet posted; subledger_equals_gl = Sub-ledgers equal their control accounts; stock_ledger_integrity = Stock ledger agrees with its documents and layers; stock_documents_waiting = Stock documents dated in the period still waiting. Run the checks on this screen (or on Period / Year-End Closing), fix each failing line, then close again.
- "… cannot be closed before …: periods close in sequence" — close the earlier months first.
- "Permission denied: 'configure' on 'fiscal_period' is not granted to this user." — only a person who may configure the periods can change them.

## Period / Year-End Closing (إقفال الفترة / نهاية السنة)
Path: Accounting → General Ledger → Period / Year-End Closing   |   Arabic: المحاسبة ← الأستاذ العام ← إقفال الفترة / نهاية السنة
Address: /finance/closing
Needs: `view` on `fiscal_period` to open. `configure` on `fiscal_period` to soft close, close or reopen, and to add a note. `print`/`export` on `trial_balance` for the printer icon; `create` on `attachment` to attach closing papers.
What it is for: The month-end workspace: one period at a time, with its closing checklist, the control to soft close, close or reopen it, its closing papers and notes, and the history of every close. The year is closed by closing its months in order — there is no separate year-end run, and closing posts no journal (profit is not moved to retained earnings by an entry; the statements carry the result to equity themselves).

### How to close a month — Period / Year-End Closing
1. Open Accounting → General Ledger → Period / Year-End Closing. The window **Closing checklist — PERIOD** (قائمة تحقق الإقفال) opens on the earliest month not yet closed, with its dates.
2. To work on another month choose it in **Period** (الفترة) and press **Run checks** (تشغيل الفحوصات).
3. Read the checklist: **Check** (الفحص), **Kind** (النوع) — Blocking (مانع) / Warning (تحذير), **Figure** (الرقم), **Detail** (التفاصيل), **State** (الحالة) — Pass (ناجح) / Fail (فاشل) / Warning (تحذير). Each check's name is a link to the screen with the figures. The checks are the thirteen described under Accounting Periods.
4. Fix every check that shows **Fail**, then press Run checks again until the foot says "… may be closed: every blocking check passes as at …".
5. At the foot choose **State** (الحالة) = **Close** (إقفال), type the **Reason** (السبب), press **Apply** (تنفيذ).
6. The month becomes **Closed** (مغلقة). The foot shows the period's state and **YEAR closed** (المقفل من …) — how many of the year's months are closed, for example 3 / 12. The close appears in **Close history**.

Months must be closed in order, January first.

### How to soft close or reopen a month — Period / Year-End Closing
1. Choose the month in **Period** and press **Run checks**.
2. At the foot, in **State**: for an Open month choose **Soft close** (إقفال مبدئي); for a Soft closed month choose **Reopen (soft-closed)** (إعادة الفتح (المقفلة مبدئياً)).
3. Type the **Reason** (السبب) and press **Apply** (تنفيذ).

A soft close does not need the checklist to pass. A Closed month offers no control at all — it cannot be reopened.

### How to keep the closing papers, notes and history — Period / Year-End Closing
1. The checklist window's title bar carries the four icons for the chosen period (see "The four icons on a record").
2. Printer — **Print / Export**: the **Period Close** (إقفال الفترة) sheet — the period, its state and the checklist.
3. Paperclip — **Attachments**: attach the sign-off or the reconciliation file with **Choose a file** and **Attach**. Allowed at any state of the period.
4. Speech mark — **Notes**: add a dated, signed note about the close.
5. Clock — **Audit log**: every change to the period.

### How to read the close history — Period / Year-End Closing
The window **Close history** (سجل الإقفال) under the checklist lists every change of state of any period, newest first: **When** (متى), **Period** (الفترة), **Change** (التغيير) — from state → to state, **By** (من), **Reason** (السبب), **Closed over** (أُقفل رغم) — the warnings that were showing when the month was closed. Until something has been closed it says **No period has been closed or reopened yet.** A reader sees the changes made from the branches they work in.

### Fields — Period / Year-End Closing
- **Period** (الفترة) — which month the checklist is for; each is listed as "name · state".
- **State** (الحالة) — the action to apply: **Soft close** (إقفال مبدئي) — offered for an Open month; **Reopen (soft-closed)** (إعادة الفتح (المقفلة مبدئياً)) — offered for a Soft closed month; **Close** (إقفال) — offered for both. Pre-selected: Close when every blocking check passes.
- **Reason** (السبب) — required; kept with the change and shown in Close history.

### After you save — Period / Year-End Closing
The period's state changes at once and for everyone: **Open** (مفتوحة) → **Soft closed** (مغلقة مؤقتاً) → **Closed** (مغلقة); Soft closed can go back to Open; Closed is final. Nothing is posted to the ledger by closing. From then on any posting dated in a Closed month is refused everywhere in the system.
If no fiscal year exists the screen shows **No accounting calendar** (لا يوجد تقويم محاسبي) with a link to Accounting Periods.

### Refusals — Period / Year-End Closing
- "… cannot be closed while these checks fail: …. Open Period Close to see the figures." — one or more blocking checks fail; the names are internal codes (see Refusals — Accounting Periods for what each means). Fix them and apply again.
- "… cannot be closed before …: periods close in sequence" — close the earlier months first.
- "… is closed. Reopening a closed period is a year-end action and is not available here (§14.6, Phase 16)."
- "Changing the status of … requires a reason, which is recorded (§5.4)."
- "Permission denied: 'configure' on 'fiscal_period' is not granted to this user."

## Posting Mappings (خرائط الترحيل)
Path: Accounting → General Ledger → Posting Mappings   |   Arabic: المحاسبة ← الأستاذ العام ← خرائط الترحيل
Address: /finance/posting-mappings
Needs: `view` on `posting_rule` to open. `configure` on `posting_rule` to change a mapping.
What it is for: It says which account each business document posts to. The system never picks an account on its own: when an invoice, payment, return, payroll run or other document posts, each line of its journal goes to the account chosen here. A document whose required line has no account cannot post. Accounts that belong to the record itself — the bank a payment left, an item's inventory or cost-of-sales account — are not asked here.

### How to read the screen — Posting Mappings
1. Open Accounting → General Ledger → Posting Mappings.
2. The marker at the top right says **Every required line has an account** (كل سطر مطلوب له حساب), or how many are missing, for example "3 required lines have no account".
3. There is one panel per document, titled with the document's name (Purchase Invoice, Sales Invoice, Customer Receipt…). Each row of a panel is one line of that document's journal:
   - **Dr/Cr** (مدين/دائن) — **Dr** (مدين), **Cr** (دائن) or **Dr or Cr** (مدين أو دائن): the side the line falls on.
   - **Line** (السطر) — what the line is, in words. A grey **Required** (مطلوب) tag means no document of this kind can post without it; a tag such as **Supplier control** (رقابة الموردون) means only accounts designated as that kind of control account are offered.
   - **Account** (الحساب) — the account the line posts to, or **Not set** (غير محدد).
   - **Status** (الحالة) — **Ready** (جاهز) with a link to the account's page; **Not set** (غير محدد); or **Not eligible** (غير مؤهل) — the saved account can no longer be used (it was deactivated, lost its approval, or lost its control-account designation).

### How to change which account a document posts to — Posting Mappings
1. Find the document's panel and the line you want.
2. In the **Account** column open the list and choose the account. Only active, approved posting accounts are offered; on a control line only accounts with that control designation; on the Sales Invoice line "The sale" only revenue accounts that are not control accounts.
3. Change any other lines of the same document that need it.
4. Press **Save** (حفظ) at the top of that panel. One Save writes all the lines of that document together; if one line is refused, none are changed.
5. The change applies to documents posted from now on. Journals already posted keep the account they were posted with.

If the account you need is not in the list, first make it eligible in the Chart of Accounts (approved, active, not a group, and for a control line designated as that control account).

### How to remove a mapping — Posting Mappings
1. On the line, choose **Not set** (غير محدد) in the Account list.
2. Press **Save** on the panel. The line is unmapped from the next posting on; a document that needs it will be refused until an account is chosen again.

### The documents and their lines — Posting Mappings
Each panel and its lines, with the side and the tags shown on screen:
- **Purchase Invoice** (فاتورة شراء)
  - Cr — What the company owes the supplier (ما على الشركة للمورد) — Required; Supplier control accounts only
  - Dr — Goods received, not yet invoiced (بضاعة مستلمة ولم تُفوتر)
  - Dr — The cost of a service billed (كلفة خدمة مفوترة)
  - Dr — A cost charged to an import, until its landed cost is locked (كلفة محمّلة على استيراد إلى أن تُقفل كلفته الواصلة)
  - Dr or Cr — The difference between the order and the invoice (الفرق بين أمر الشراء والفاتورة)
- **Sales Invoice** (فاتورة بيع)
  - Dr — What the customer owes the company (ما على العميل للشركة) — Required; Customer control accounts only
  - Cr — The sale (المبيعات)
- **Customer Receipt** (سند قبض من عميل)
  - Cr — What the customer owes the company (ما على العميل للشركة) — Required; Customer control accounts only
  - Cr — Money received, not yet put to a customer (مبالغ مقبوضة لم تُنسب إلى عميل)
- **Customer Receipt — put to a customer** (سند قبض — عند تحديد العميل)
  - Dr — Money received, not yet put to a customer (مبالغ مقبوضة لم تُنسب إلى عميل) — Required
  - Cr — What the customer owes the company (ما على العميل للشركة) — Required; Customer control accounts only
- **Supplier Payment** (دفعة لمورد)
  - Dr — What the company owes the supplier (ما على الشركة للمورد) — Required; Supplier control accounts only
- **Supplier advance (deposit) paid** (دفع سلفة مورّد (عربون))
  - Dr — Money paid to suppliers ahead of the invoice (advances) (المبالغ المدفوعة للموردين قبل الفاتورة (السلف)) — Required
  - Cr — The bank or cash account, when none is named (الحساب المصرفي أو النقدي، حين لا يُسمّى أحدها)
- **Supplier advance applied to an invoice** (تسوية سلفة المورّد مع فاتورة)
  - Dr — What the company owes the supplier (ما على الشركة للمورد) — Required; Supplier control accounts only
  - Cr — Money paid to suppliers ahead of the invoice (advances) (المبالغ المدفوعة للموردين قبل الفاتورة (السلف)) — Required
- **Supplier advance refunded** (استرداد سلفة المورّد)
  - Dr — The bank or cash account, when none is named (الحساب المصرفي أو النقدي، حين لا يُسمّى أحدها)
  - Cr — Money paid to suppliers ahead of the invoice (advances) (المبالغ المدفوعة للموردين قبل الفاتورة (السلف)) — Required
- **Import exchange difference** (فرق صرف الاستيراد)
  - Dr or Cr — What the company owes the supplier (ما على الشركة للمورد) — Required; Supplier control accounts only
  - Cr — Money paid to suppliers ahead of the invoice (advances) (المبالغ المدفوعة للموردين قبل الفاتورة (السلف))
  - Cr — Realised exchange gain (ربح صرف محقق)
  - Dr — Realised exchange loss (خسارة صرف محققة)
- **Purchase Return** (مرتجع مشتريات)
  - Dr — What the company owes the supplier (ما على الشركة للمورد) — Required; Supplier control accounts only
  - Cr — Goods returned, not yet credited (بضاعة مرتجعة لم يصدر بها إشعار) — Required
- **Sales Return** (مرتجع مبيعات)
  - Cr — What the customer owes the company (ما على العميل للشركة) — Required; Customer control accounts only
  - Dr — The sale reversed (عكس المبيعات) — Required
- **Customer Credit Note** (إشعار دائن للعميل)
  - Cr — What the customer owes the company (ما على العميل للشركة) — Required; Customer control accounts only
  - Dr — The sale reversed (عكس المبيعات) — Required
- **Customer Debit Note** (إشعار مدين للعميل)
  - Dr — What the customer owes the company (ما على العميل للشركة) — Required; Customer control accounts only
  - Cr — The sale (المبيعات) — Required
- **Opening Stock** (رصيد أول المدة للمخزون)
  - Cr — What the opening stock is opened against (الحساب المقابل لرصيد أول المدة) — Required
- **Item Reconciliation** (تسوية الأصناف)
  - Dr or Cr — Stock found or lost on reconciliation (فروقات الجرد (زيادة أو عجز)) — Required
- **Internal transfer between bank or cash accounts in two currencies** — this panel has no name yet: its heading shows the code `posting_map.event.treasury_bank_transfer`
  - Cr — Realised exchange gain (ربح صرف محقق)
  - Dr — Realised exchange loss (خسارة صرف محققة)
- **Loan disbursement** (صرف قرض)
  - Cr — What the company owes the bank on the loan (ما على الشركة للبنك من القرض) — Required; Loans control accounts only
  - Dr — A cost charged to an import, until its landed cost is locked (كلفة محمّلة على استيراد إلى أن تُقفل كلفته الواصلة)
  - Dr — The bank’s commission, when it is expensed (عمولة البنك عند تحميلها مصروفًا)
- **Loan instalment repaid** (سداد قسط قرض)
  - Dr — What the company owes the bank on the loan (ما على الشركة للبنك من القرض) — Required; Loans control accounts only
  - Dr — Interest on the loan (فائدة القرض)
  - Dr — A cost charged to an import, until its landed cost is locked (كلفة محمّلة على استيراد إلى أن تُقفل كلفته الواصلة)
  - Dr — The bank’s commission, when it is expensed (عمولة البنك عند تحميلها مصروفًا)
  - Cr — Realised exchange gain (ربح صرف محقق)
  - Dr — Realised exchange loss (خسارة صرف محققة)
- **Foreign-currency loan re-valued in dinars** — this panel has no name yet: its heading shows the code `posting_map.event.treasury_loan_revaluation`
  - Dr or Cr — What the company owes the bank on the loan (ما على الشركة للبنك من القرض) — Required; Loans control accounts only
  - Cr — Realised exchange gain (ربح صرف محقق)
  - Dr — Realised exchange loss (خسارة صرف محققة)
- **Loan commission paid** (دفع عمولة قرض)
  - Dr — A cost charged to an import, until its landed cost is locked (كلفة محمّلة على استيراد إلى أن تُقفل كلفته الواصلة)
  - Dr — The bank’s commission, when it is expensed (عمولة البنك عند تحميلها مصروفًا)
- **Legacy books — opening balances** (الدفاتر القديمة — الأرصدة الافتتاحية)
  - Dr or Cr — What the customer owes the company (ما على العميل للشركة) — Required; Customer control accounts only
  - Dr or Cr — What the company owes the supplier (ما على الشركة للمورد) — Required; Supplier control accounts only
  - Dr or Cr — What the opening stock is opened against (الحساب المقابل لرصيد أول المدة) — Required
- **Landed cost locked** (إقفال الكلفة الواصلة)
  - Cr — A cost charged to an import, until its landed cost is locked (كلفة محمّلة على استيراد إلى أن تُقفل كلفته الواصلة) — Required
- **Project certificate** (شهادة مشروع)
  - Dr — What the customer owes the company (ما على العميل للشركة) — Required; Customer control accounts only
  - Dr — Retention the customer holds until release (المحتجزات لدى العميل حتى الإفراج) — Customer control accounts only
  - Cr — Contract revenue (إيراد العقد) — Required
- **Project revenue recognition** (إثبات إيراد المشروع)
  - Dr or Cr — Work done, not yet billed (WIP) (عمل منجز لم يُفوتر (أعمال تحت التنفيذ))
  - Dr or Cr — Billed ahead of the work (deferred revenue) (مفوتر قبل العمل (إيراد مؤجل))
  - Dr or Cr — Contract revenue (إيراد العقد) — Required
- **Project material issue** (صرف مواد للمشروع)
  - Dr or Cr — Project material cost (تكلفة مواد المشروع) — Required
  - Dr or Cr — The stock side of the issue — this line has no name yet: it shows the code `posting_map.role.inventory` — Required
- **Project labour (timesheets)** (عمالة المشروع (سجلات الساعات))
  - Dr — Project labour cost (تكلفة عمالة المشروع) — Required
  - Cr — Labour absorbed (العمالة المحمّلة) — Required
- **Project settlement** (تسوية المشروع)
  - Dr — Asset under construction (أصل قيد الإنشاء) — Required
  - Cr — Project cost settled (تكلفة المشروع المسوّاة) — Required
- **Payroll run** (مسير الرواتب)
  - Dr — Salaries and wages, by department (الرواتب والأجور حسب القسم) — Required
  - Dr — The employer’s own payroll cost (social security share) (كلفة الرواتب على صاحب العمل (حصة الضمان الاجتماعي))
  - Cr — Withheld from pay and owed on (social security, income tax) (المستقطع من الرواتب والمستحق للغير (الضمان الاجتماعي، ضريبة الدخل))
  - Cr — What people owe the company on advances and loans (ما يدين به الموظفون للشركة من سلف وقروض)
  - Cr — Net pay owed to the people, until it is paid (صافي الرواتب المستحق للموظفين حتى يُصرف) — Required
- **Payroll payment** (صرف الرواتب)
  - Dr — Net pay owed to the people, until it is paid (صافي الرواتب المستحق للموظفين حتى يُصرف) — Required
- **Employee advance or loan paid** (صرف سلفة أو قرض لموظف)
  - Dr — What people owe the company on advances and loans (ما يدين به الموظفون للشركة من سلف وقروض) — Required
- **Employee advance repaid in cash** (سداد نقدي لسلفة موظف)
  - Cr — What people owe the company on advances and loans (ما يدين به الموظفون للشركة من سلف وقروض) — Required
- **Expense claim reimbursed** (تسديد مطالبة مصاريف)
  - Dr — What people spent for the company and are reimbursed (ما أنفقه الموظفون للشركة ويُسدَّد لهم) — Required
  - Cr — What people owe the company on advances and loans (ما يدين به الموظفون للشركة من سلف وقروض)

### Fields — Posting Mappings
- **Account** (الحساب) — one list per line; optional except on lines tagged **Required** (مطلوب), which every document of that kind needs. Value: an active, approved posting account, or **Not set** (غير محدد).

A person who may only view sees the account as text and has no Save button.
This screen sets one account per document line for the whole company. It has no boxes to narrow a mapping by branch, warehouse, project or item group.

### After you save — Posting Mappings
The mapping is in force immediately for every later posting. Nothing is posted by saving. Each change is written to the audit trail with the previous account. A removed mapping is switched off, not erased, so journals posted through it keep their trail.

### Refusals — Posting Mappings
- "… must be designated as a supplier control account for purchasing.ap_invoice / supplier_payable. Set its control account in Chart of Accounts, then choose it in Posting Mappings so the journal and statement are posted together." — (also customer, loan). The line must go to a control account of that kind, so that the partner's statement is updated with the journal. Designate the account in the Chart of Accounts first.
- "… cannot receive sales revenue. Choose a Revenue posting account that is not a control account; customer balances belong on the receivable line."
- "… is not a document the posting engine posts." — the page was out of date; reload it.
- "Permission denied: 'configure' on 'posting_rule' is not granted to this user."

Seen on other screens when a mapping is missing:
- "No accounting mapping is configured for the 'supplier_payable' line of 'purchasing.ap_invoice'. Configure the mapping in Accounting Mapping — the posting cannot choose an account on its own (§3.3)." — a document could not post because a line it needs has no account. "Accounting Mapping" in this message is this screen, Posting Mappings: open the document's panel, set the account on that line, Save, then post the document again.
- "More than one accounting mapping matches the '…' line of '…' equally well: …" — two mappings compete for the same line; tell the Accounting Manager.

## Recurring Journals (القيود الدورية)
Path: Accounting → General Ledger → Recurring Journals   |   Arabic: المحاسبة ← الأستاذ العام ← القيود الدورية
Address: /finance/recurring-journals (one template: /finance/recurring-journals/TEMPLATE-NUMBER)
Needs: `view` on `journal_entry` to open. `create` on `journal_entry` for **New recurring journal** and **Raise due journals** (raising also needs membership of a Finance department); `edit_draft` to change a draft template, its lines, or add a note; `approve` to agree and start, resume, pause or end; `print`/`export` on `journal_entry` for the printer icon; `create` on `attachment` to attach.
What it is for: Standing entries — rent, depreciation, subscriptions, accruals — written once as a template that raises the same journal on a schedule. A template never posts anything itself: on each due date it raises an ordinary **Draft** journal in Journal Entries, which is then submitted, approved and posted like any other.

### How to create a recurring journal — Recurring Journals
1. Open Accounting → General Ledger → Recurring Journals and press **New recurring journal** (قيد متكرر جديد).
2. Fill **Name** (الاسم), **Frequency** (التكرار), **Every** (كل), **First due** (أول استحقاق), optionally **Last due** (آخر استحقاق) and **Description** (الوصف). Press **Create** (إنشاء).
3. The template opens as a **Draft** (مسودة) with its number (for example RJ-00001), in the branch you are working in.
4. Press **Add line** (إضافة سطر) for each line: choose the **Account** (الحساب), the **Side** (الجانب) — Debit (IQD) or Credit (IQD), type the **Amount** (المبلغ), optionally a **Department** (القسم) and a **Note** (ملاحظة); press **Add line**.
5. Add lines until the foot of **The journal it raises** (القيد الذي ينشئه) says **Balanced** (متوازن). To take a line off press **Remove** (حذف) on its row.
6. Ask a second person to agree it (see "How to agree and start").

To change the name or the schedule while it is a Draft press **Change** (تعديل), edit, and press **Save** (حفظ).

### How to agree and start a recurring journal — Recurring Journals
1. A person other than the one who wrote the template opens it. (The button is not shown to the writer; a Super User is the only exception.)
2. Check the lines and the schedule, then press **Agree and start** (الموافقة والبدء).
3. The status becomes **Active** (فعّال) and **Agreed by** shows the name. From now the lines and schedule are fixed; to change them, end the template and write a new one.

The template must have at least two lines and must balance.

### How to raise the journals that are due — Recurring Journals
1. For every template at once: on the list press **Raise due journals** (إنشاء القيود المستحقة) at the top. For one template: open it and press **Raise due journals** — the button shows only when it is Active and its **Next due** date is today or earlier.
2. For each due date up to today that has not been raised yet, the system creates one **Draft** journal in Journal Entries, with posting and document date equal to the due date, the description "NAME — TEMPLATE-NUMBER", and the template's lines. A date is never raised twice. If several due dates have passed, one journal is created for each.
3. **Next due** moves to the following date (or becomes empty after the Last due date).
4. Open each raised journal — from **Journals raised** (القيود المُنشأة) on the template, or from Journal Entries — check it, and **Submit** it; it then follows the normal approval and posting.

Nothing is raised automatically: somebody presses the button.

### How to pause, resume or end a recurring journal — Recurring Journals
1. Open the template.
2. To hold it: type the **Reason for pausing** (سبب الإيقاف) and press **Pause** (إيقاف مؤقت). Status **Paused** (موقوف مؤقتاً); nothing is raised while paused.
3. To continue a paused one: press **Resume** (الاستئناف). Status **Active** again.
4. To stop it for good: type the **Reason for ending** (سبب الإنهاء) and press **End** (إنهاء). Status **Ended** (منتهٍ); it has no next due date and cannot be restarted. The journals it raised stay.

### How to open a record and what it shows — Recurring Journals
1. On the list press the template number. List columns: **Template no.** (رقم النموذج), **Name** (الاسم), **Frequency** (التكرار), **Next due** (الاستحقاق التالي), **Amount** (المبلغ) — the total of the debit lines, **Raised** (المُنشأ) — how many journals it has raised, **Status** (الحالة).
2. To narrow the list use **View** (العرض): **All recurring journals** (كل القيود المتكررة), **Drafts** (المسودات), **Running** (الجارية) — active and paused, **Due now** (المستحقة الآن), **Ended** (المنتهية); press **Filter** (تصفية). The search box looks in the number and the name.
3. The record window is titled **Recurring Journal** (قيد متكرر). Boxes: Template no., Status, Name, Frequency, First due, Last due, Next due, **Branch** (الفرع), **Written by** (كتبه), **Agreed by** (وافق عليه), Description, and — once ended — **Reason for ending** with who ended it.
4. **The journal it raises** (القيد الذي ينشئه): #, Account (a link to the account), Department, **Note** (ملاحظة), **Debit (IQD)** (مدين (د.ع)), **Credit (IQD)** (دائن (د.ع)); the foot says **Balanced** (متوازن) or **Out of balance** (غير متوازن) with the two totals.
5. **Journals raised** (القيود المُنشأة): **Due** (الاستحقاق), **Journal** (القيد) — a link to the journal entry, **Status** — the journal's own status, **Raised by** (أنشأه), **Raised at** (أُنشئ في).
6. The title bar carries the four icons (printer, paperclip, notes, clock) from the Draft on. Files can be attached at any status.

### Fields — Recurring Journals
Template (New recurring journal / Change):
- **Name** (الاسم) — required; what the entry is (rent, depreciation…). It becomes the description of every journal raised.
- **Frequency** (التكرار) — required: **Monthly** (شهري), **Quarterly** (ربع سنوي) or **Yearly** (سنوي).
- **Every** (كل) — a whole number from 1 to 12; default 1. "1 is every month (quarter, year); 2 every other one." Shown afterwards as, for example, "Every 2 months".
- **First due** (أول استحقاق) — required date; default today. The first journal is dated on it and every later due date is counted from it, keeping the same day of the month where the month has it.
- **Last due** (آخر استحقاق) — optional date; "Leave empty for no end." Must not be before First due.
- **Description** (الوصف) — optional.

Line (Add line):
- **Account** (الحساب) — required; an active, approved posting account.
- **Side** (الجانب) — required: **Debit (IQD)** or **Credit (IQD)**.
- **Amount** (المبلغ) — required; a number greater than zero (commas and spaces are ignored).
- **Department** (القسم) — optional on the form; "—" for none. Choose one on any line whose account requires a department (as delivered, every expense account does) — otherwise the journal cannot be raised later.
- **Note** (ملاحظة) — optional text carried onto the line.

### After you save — Recurring Journals
Statuses: **Draft** (مسودة) → agreed by a second person → **Active** (فعّال) ⇄ **Paused** (موقوف مؤقتاً); any of them → **Ended** (منتهٍ) with a reason.
- Draft: schedule and lines can be changed; nothing is raised.
- Active: **Raise due journals** creates the Draft journals that are due. The template itself posts nothing; the ledger changes only when each raised journal is submitted, approved and posted in Journal Entries.
- Paused: nothing is raised until it is resumed.
- Ended: final.

Each journal a template raised shows **Raised from** with the template's number on its own page.

### Refusals — Recurring Journals
- "Name the recurring journal — rent, depreciation, a subscription." — Name is empty.
- "A recurring journal falls due monthly, quarterly or yearly." / "Every 1 to 12 of them." / "State the first due date as a date." / "It cannot end before it starts." — fix the schedule.
- "… is active; only a draft is changed. End it and write a new one." / "… is active; its lines are fixed." — a template can be edited only while it is a Draft.
- "A line is a debit or a credit, more than nothing — one of the two." / "Not a decimal value: "…"" — type a positive number as the amount.
- "Choose an active, approved posting account."
- "… was written by you; somebody else agrees to it." — the writer cannot agree their own template; ask a second person who may approve.
- "A journal has at least two lines; add them before it starts."
- "… does not balance: debits …, credits …." — make the two sides equal before agreeing.
- "… is draft; only an active one is paused." / "Say why it is paused." / "… has already ended." / "Say why it ends."
- "… is paused; only an active recurring journal raises journals."
- When raising: the journal refusals apply, because a real journal is being created — "Only people in a finance department can raise journal entries…", "No accounting period covers …" (open the year for that due date on Accounting Periods), and "Cannot post to …: it is the … control account. Direct manual posting requires Finance Manager approval…" when the template has a control-account line and the person raising may not post.
- "Account … requires Department / Cost Centre. Supply the missing value(s) and post again." when raising — a template line on an account that requires a department was saved without one. An active template's lines are fixed, so end the template and write a new one with the department on that line.
- "No recurring journal numbered …." — the number in the address does not exist.

## Account Reconciliation (مطابقة الحسابات)
Path: Accounting → General Ledger → Account Reconciliation   |   Arabic: المحاسبة ← الأستاذ العام ← مطابقة الحسابات
Address: /finance/account-reconciliation
Needs: `view` on `trial_balance`. `print` on `trial_balance` for PDF, `export` for Excel/Word.
What it is for: A read-only check that each control account in the ledger agrees with its sub-ledger — customers, suppliers, banks, loans and the like — at a date, and that the value of the stock agrees with the inventory accounts. These are the same figures the period close checklist asks for. The screen reports differences and where to look; it corrects nothing.

### How to run the check — Account Reconciliation
1. Open Accounting → General Ledger → Account Reconciliation.
2. Set **As at** (كما في) — default today — and press **Run** (عرض).
3. The first window, **Control accounts** (حسابات المراقبة), has one row per control account: **G/L account** (حساب الأستاذ) — a link to the account's page; **Sub-ledger** (الدفتر الفرعي) — its kind: Receivables (الذمم المدينة), Payables (الذمم الدائنة), Inventory (المخزون), Bank (المصارف), Fixed assets (الأصول الثابتة), Projects (المشاريع), Services (الخدمات), Bank loans (القروض المصرفية); **Sub-ledger** (balance) — the total of the sub-ledger entries up to the date; **G/L** (الأستاذ) — the account's ledger balance up to the date; **Difference** (الفرق) — sub-ledger less G/L, expected to be zero; **Status** (الحالة) — **Agrees** (متطابق) or **Differs** (مختلف); **Investigate** (التحقق) — the links **G/L inquiry** (استعلام الأستاذ), which opens the account's ledger, and **Sub-ledger** (الدفتر الفرعي), which opens the party-by-party screen (customer statements, supplier statements, loans, or the Warehouses Report).
4. The foot says **Every sub-ledger agrees with its control account.** (كل دفتر فرعي يطابق حساب المراقبة الخاص به.) or "N control account(s) differ from their sub-ledger."
5. The second window, **Inventory value** (قيمة المخزون), is always as of today whatever date is chosen above: **Cost layers** (طبقات الكلفة) — what the stock on hand cost; **Of which not yet posted** (منها غير مرحّل) — the part whose stock movement has no journal yet; **G/L** — the balance of the items' inventory accounts; **Difference**; **Status**; and a **Sub-ledger** link to the Warehouses Report.

All amounts are in IQD.

### How to print or export — Account Reconciliation
1. Run the screen for the date you want.
2. Press **Print / Export** (طباعة / تصدير), choose English or العربية, then PDF, Excel (.xlsx) or Word (.docx). The file is the **Account Reconciliation** (مطابقة الحسابات) as at that date.

### Fields — Account Reconciliation
- **As at** (كما في) — required date; default today. The control-accounts table counts everything posted up to and including it. The Inventory value window ignores it and is always "as of" today.

### After you save — Account Reconciliation
Nothing is saved or posted. A difference is a finding to investigate, not something the screen fixes: open the account's ledger with **G/L inquiry** and the party screen with **Sub-ledger**, find the journal that put an amount on the control account without its party, and correct it by reversing that journal or document.
The close checklist's check "Sub-ledgers equal their control accounts" reads the same table at the period's last day. Its inventory check is taken at the period's last day, while this screen's Inventory value is today's — for a past month the two can differ.

### Refusals — Account Reconciliation
The screen refuses nothing. If the chart has no control accounts the table says **No control accounts are marked on the chart.** (لا حسابات مراقبة معلَّمة في الدليل.)

## Income Statement (قائمة الدخل)
Path: Accounting → General Ledger → Income Statement   |   Arabic: المحاسبة ← الأستاذ العام ← قائمة الدخل
Address: /finance/income-statement
Needs: `view` on `financial_statement`. `print` on `financial_statement` for PDF, `export` for Excel/Word.
What it is for: What was earned and spent between two dates, read from the posted journals: revenue and expense accounts grouped onto the lines of the Statement Mapping, with the running totals (such as gross profit) and the net profit or loss for the period. Read-only.

### How to run the statement — Income Statement
1. Open Accounting → General Ledger → Income Statement.
2. Set the filters: **From** (من) and **To** (إلى) — the period, default 1 January to 31 December of the current year; **Report currency** (عملة التقرير) — IQD or USD; **Reporting level** (مستوى التقرير) — Level 1 shows only the top rows of the layout and the totals; each further level opens one more step, down to the accounts under each line (the default is the deepest).
3. Press **Run** (عرض).
4. Columns: **Line** (البند) and **Amount · IQD** (or · USD). The currency is named once in the column heading. A figure that reduces the result — a cost, an expense — is shown in brackets.
5. Total rows (for example Gross profit, Net income) show the running total of everything above them; the last one is ruled twice. The foot shows **Net profit** (صافي الربح) or **Net loss** (صافي الخسارة).
6. Use **Expand All** (توسيع الكل) / **Collapse All** (طي الكل), or the small arrow (▸ / ▾) at the start of a group's row, to fold and unfold groups.

Filters available: period, currency, level. There is no branch filter — the statement adds together all the branches you are allowed to see — and no comparison column: one period per run. To compare two periods, run it twice.

### How to print or export — Income Statement
1. Run the statement with the period, currency and level you want.
2. Press **Print / Export** (طباعة / تصدير), choose English or العربية, then PDF, Excel (.xlsx) or Word (.docx). The file shows the same rows at the same level, with the period and currency printed at the top.

### Fields — Income Statement
- **From** (من) / **To** (إلى) — required dates; default the current calendar year. Journals with a posting date between them are counted.
- **Report currency** (عملة التقرير) — IQD (default) or USD at the rate of each posting's own day.
- **Reporting level** (مستوى التقرير) — Level 1 … Level N; N is how deep the statement's layout goes, plus the accounts.

### After you save — Income Statement
Nothing is saved. The statement counts Posted and Reversed journals in the period (a journal and its reversal cancel). Which line an account appears on comes from the Statement Mapping; an unmapped revenue or expense account falls on its type's default line. A line or account with nothing in the period is not shown.

### Refusals — Income Statement
The screen refuses nothing. With no postings in the period it says **Nothing was posted in this period.** (لم يُرحّل شيء في هذه الفترة.) If an account is on the wrong line, change its line on the Statement Mapping screen.

## Balance Sheet (الميزانية العمومية)
Path: Accounting → General Ledger → Balance Sheet   |   Arabic: المحاسبة ← الأستاذ العام ← الميزانية العمومية
Address: /finance/balance-sheet
Needs: `view` on `financial_statement`. `print` on `financial_statement` for PDF, `export` for Excel/Word.
What it is for: What the company owns and owes at one date — the statement of financial position — read from every journal posted from the beginning up to that date. Read-only.

### How to run the statement — Balance Sheet
1. Open Accounting → General Ledger → Balance Sheet.
2. Set the filters: **As at** (كما في) — the date, default today ("The Balance Sheet is drawn at this date."); **Report currency** (عملة التقرير) — IQD or USD; **Reporting level** (مستوى التقرير) — Level 1 to Level 3: levels 1 and 2 show the headings and the lines, Level 3 (the default) adds the accounts under each line.
3. Press **Run** (عرض).
4. The statement has three parts, each with its total on the heading: **Assets** (الأصول); **Equity** (حقوق الملكية); **Liabilities** (الالتزامات). Under each are the headers and lines of the Statement Mapping.
5. Under Equity there is a line **Result to date (not yet closed to retained earnings)** (النتيجة حتى تاريخه (لم تُقفل بعد إلى الأرباح المحتجزة)): the accumulated profit or loss up to the date of the revenue and expense accounts (those not given a Balance Sheet line of their own). At Level 3 the revenue and expense accounts behind it are listed.
6. The foot says **The two sides agree** (الطرفان متساويان) or **The two sides do not agree** (الطرفان غير متساويين), and shows **Total assets** (إجمالي الأصول) and **Total equity and liabilities** (إجمالي حقوق الملكية والالتزامات).
7. **Expand All** (توسيع الكل) / **Collapse All** (طي الكل) fold and unfold the groups. A negative figure is shown in brackets.

Filters available: date, currency, level. There is no branch filter (all the branches you may see are added together) and no comparison column. This is a position at a date, not a period: it has no From date.

### How to print or export — Balance Sheet
1. Run the statement with the date, currency and level you want.
2. Press **Print / Export** (طباعة / تصدير), choose English or العربية, then PDF, Excel (.xlsx) or Word (.docx).

### Fields — Balance Sheet
- **As at** (كما في) — required date; default today. Everything posted up to and including it is counted.
- **Report currency** (عملة التقرير) — IQD (default) or USD.
- **Reporting level** (مستوى التقرير) — Level 1, 2 or 3; default 3.

### After you save — Balance Sheet
Nothing is saved. Closing a period or a year does not move the result into retained earnings by a journal, so the result stays on the "Result to date" line under Equity; that line is what keeps assets equal to equity plus liabilities. The Equity total here equals the closing figure of Changes in Equity drawn to the same date.

### Refusals — Balance Sheet
The screen refuses nothing. If the foot says **The two sides do not agree** in IQD, tell the Accounting Manager and run the close checks on Accounting Periods. In USD a small difference can come from postings at different exchange rates.

## Changes in Equity (التغيرات في حقوق الملكية)
Path: Accounting → General Ledger → Changes in Equity   |   Arabic: المحاسبة ← الأستاذ العام ← التغيرات في حقوق الملكية
Address: /finance/changes-in-equity
Needs: `view` on `financial_statement`. `print` on `financial_statement` for PDF, `export` for Excel/Word.
What it is for: What equity stood at when the period began, what was added and taken away during it, and what it stands at when the period ends. Read-only, from the posted journals.

### How to run the statement — Changes in Equity
1. Open Accounting → General Ledger → Changes in Equity.
2. Set **From** (من) and **To** (إلى) — default 1 January to 31 December of the current year — and **Report currency** (عملة التقرير); press **Run** (عرض). There is no level filter on this statement.
3. Columns: **Line** (البند) and **Amount · IQD** (or · USD). It reads top to bottom in the layout set on the Statement Mapping. As delivered: **Equity at the beginning of the period** (everything posted before the From date, including earlier profit not yet moved to retained earnings), the group **Add:** (what increased equity, including the period's result), the group **Subtract:** (what was taken out), and **Equity at the End of the Period**.
4. Each line is one row and one figure; accounts are not listed. A figure in brackets is negative — a loss or something taken out. Every line of the layout is shown even when it is zero.
5. The foot shows **Total equity** (إجمالي حقوق الملكية) — equity at the To date. It equals the Equity total of a Balance Sheet drawn at the same date.

Filters available: period and currency. No branch filter (all the branches you may see are added together), no level, no comparison column.

### How to print or export — Changes in Equity
1. Run the statement for the period and currency you want.
2. Press **Print / Export** (طباعة / تصدير), choose English or العربية, then PDF, Excel (.xlsx) or Word (.docx). The file is titled **Statement of Changes in Equity** (قائمة التغيرات في حقوق الملكية).

### Fields — Changes in Equity
- **From** (من) / **To** (إلى) — required dates; default the current calendar year. Opening equity is everything posted before From; the movement is what was posted from From to To.
- **Report currency** (عملة التقرير) — IQD (default) or USD.

### After you save — Changes in Equity
Nothing is saved. The statement reads Posted and Reversed journals. Which line an equity account appears on comes from the Statement Mapping; the period's profit or loss is worked out from the revenue and expense accounts.

### Refusals — Changes in Equity
The screen refuses nothing. If a line shows zero where a figure is expected (for example dividends), the account has not been put on that line in the Statement Mapping.

## Cash Flow Statement (قائمة التدفقات النقدية)
Path: Accounting → General Ledger → Cash Flow Statement   |   Arabic: المحاسبة ← الأستاذ العام ← قائمة التدفقات النقدية
Address: /finance/cash-flow
Needs: `view` on `financial_statement`. `print` on `financial_statement` for PDF, `export` for Excel/Word.
What it is for: Where the cash came from and where it went in a period, read from the journals that moved it. It starts from the period's net income and adjusts it by the movement of every other account, grouped into operating, investing and financing activities by the Statement Mapping, arriving at the change in cash. Read-only.

### How to run the statement — Cash Flow Statement
1. Open Accounting → General Ledger → Cash Flow Statement.
2. Set **From** (من) and **To** (إلى) — default 1 January to 31 December of the current year — and **Report currency** (عملة التقرير); press **Run** (عرض). There is no level filter.
3. Columns: **Line** (البند) and **Amount · IQD** (or · USD). "Money in is positive; money out is negative." — a negative figure is shown in brackets.
4. The rows follow the cash-flow layout of the Statement Mapping. As delivered: **Operating Activities** (Net Income, the adjustments such as depreciation, receivables, inventory and payables, and the activity's net total), **Investing Activities**, **Financing Activities**, **Not yet classified**, **Net increase in cash**, **Cash at the beginning of the period** and **Cash at the end of the period**.
5. The line **Not yet classified** lists, beneath it, every account that moved in the period but has no cash-flow line yet. Give those accounts a line on the Statement Mapping and they move to their proper activity.
6. The foot says one of: **The movement agrees with the cash balances** (الحركة تتفق مع أرصدة النقد); **The movement does not agree with the cash balances** (الحركة لا تتفق مع أرصدة النقد); or "No account has been marked as cash yet — set one on the Cash Flow mapping, or this statement has nothing to explain."

Filters available: period and currency. No branch filter (all the branches you may see are added together), no level, no comparison column.

### How to print or export — Cash Flow Statement
1. Run the statement for the period and currency you want.
2. Press **Print / Export** (طباعة / تصدير), choose English or العربية, then PDF, Excel (.xlsx) or Word (.docx).

### Fields — Cash Flow Statement
- **From** (من) / **To** (إلى) — required dates; default the current calendar year. Cash at the beginning is the cash accounts' balance the day before From.
- **Report currency** (عملة التقرير) — IQD (default) or USD.

### After you save — Cash Flow Statement
Nothing is saved. Which accounts are "the cash" is decided by the Statement Mapping: the accounts placed on its line marked **Cash and equivalents** (النقد وما يعادله). Revenue and expense accounts are counted inside net income only. Every other account's movement in the period (credits less debits) is an adjustment on the line it is mapped to, or under Not yet classified.

### Refusals — Cash Flow Statement
The screen refuses nothing.
- "No account has been marked as cash yet…" — open Accounting → Master Data — Financial → Statement Mapping, and put the cash and bank accounts on the cash-flow line marked Cash and equivalents.
- **The movement does not agree with the cash balances** — the statement does not tie to the cash accounts; tell the Accounting Manager. In USD a difference can come from postings at different exchange rates; check the statement in IQD first.
