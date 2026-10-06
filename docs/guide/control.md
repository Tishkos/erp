# Exceptions, Control Center and automation — user guide

This guide covers the screens that watch the system itself rather than one module's documents.
**Exceptions** (الاستثناءات) lists what is wrong or late right now and needs a person: found by the system, kept until its cause is gone, and cleared by the system itself.
**Control Center** (مركز التحكم) asks, at the moment you open it, whether the books, the stock, the customer and supplier ledgers, the imports and the system's own machinery agree with each other, and shows the figures behind each answer.
**Related records** (السجلات المرتبطة) draws the chain of real records around one import, one supplier, one customer or one item.
**Automation** (الأتمتة) holds rules that tell people, raise a task, ask for a review or raise an exception when something happens — and that can never post, pay or move stock.
None of these screens repairs anything: each one points to the screen where the matter is dealt with.

## Concepts — Exceptions, Control Center and automation

### Which screen answers which question — Control concepts
- "What needs somebody's attention today, and who is on it?" — **Exceptions**. An exception is stored: it has a number, a history, and stays listed until its cause is gone.
- "Is the system consistent right now?" — **Control Center**. Nothing is stored: every figure is read again each time the page opens. It shows checks that pass as well as checks that fail.
- "Which documents hang on this import, supplier, customer or item?" — **Related records**.
- "Can the system tell somebody by itself when this happens?" — **Automation**.
The Control Center shows, beside each of its domains, how many exceptions are open there, and the number opens the Exceptions list for that domain.

### What these screens never do — Control concepts
- They never post a journal, pay, move stock, edit a document or approve anything. The work is always done on the document's own screen, by a person who holds the permission for it.
- They never show you more than your own permissions allow: an exception, a check or a related record that rests on a screen you may not open is hidden from you or says "Not checked for you" — it is never shown as zero or as "all good".
- An exception cannot be closed by hand, deleted or edited. A person can only acknowledge it; the system clears it when the cause is gone.

## Exceptions (الاستثناءات)
Path: Dashboard → Home → Exceptions   |   Arabic: الرئيسية ← الرئيسية ← الاستثناءات
Address: /exceptions (one exception: /exceptions/<exception number>, for example /exceptions/EXC-0007)
Needs: `view` on `exception` to open the list and an exception — and, for each exception, `view` on the kind of record it is about, in a branch you are assigned to. `execute` on `exception` to acknowledge. `administer` on `exception` for Refresh now. `print` / `export` on `exception` for copies.
What it is for: The one list of what in the books and in the work needs a person: a bank reconciliation that does not agree, a customer long overdue, a container past its arrival date, a task nobody finished. The system finds each one, says what is wrong with the figures behind it, names the screen where it is fixed, and removes it from the list by itself when the cause is gone.

### How to read the list — Exceptions
Needs: `view` on `exception`.
1. Open Dashboard → Home → **Exceptions** (الاستثناءات). The screen says: "What needs a person in the books and the work: found by the system, kept until its cause is gone."
2. The list opens on exceptions that are **Open** (مفتوح) or **Acknowledged** (قيد المتابعة). The most severe are first; within one severity the oldest is first. 50 rows to a page.
3. Under the search box one line says when the system last looked: "Last check <date and time>: N found, N new, N reopened, N cleared." Before the first check it says "The system has not run a check yet." (لم يجرِ النظام أي فحص بعد.)
4. Read a row from left to right: **Reference** (المرجع) — the exception's number, EXC-…; **Severity** (الخطورة); **Exception** (الاستثناء) — one sentence saying what is wrong; **Affected record** (السجل المعني); **Domain** (المجال); **Owner** (المسؤول); **First detected** (أول اكتشاف); **Status** (الحالة).
5. Click the **Reference** to open the exception. Click the **Affected record** to go straight to that record (a customer, a journal, a container, a task…).
6. An empty list reads "Nothing needs attention. The system checked and found nothing in what you are allowed to see." (لا شيء يحتاج إلى انتباه…) — or, with filters set, "No exception matches these filters." (لا استثناء يطابق هذه المرشحات.)
7. A note above the list, "N checks could not run last time; what they cover was left exactly as it was.", means some checks failed at the last look: the exceptions they cover were neither added nor cleared. Tell the system administrator if it stays.

### How to filter and search the list — Exceptions
Needs: `view` on `exception`.
1. Set one or more of the four filters and press **Show** (عرض). Nothing changes until you press it.
2. **Domain** (المجال): **All domains** (كل المجالات), or one of **Accounting** (المحاسبة), **Receivables** (الذمم المدينة), **Payables** (الذمم الدائنة), **Inventory** (المخزون), **Logistics** (الخدمات اللوجستية), **Tasks** (المهام), **Approvals** (الموافقات), **System** (النظام). The number in brackets beside each is how many open exceptions you may see there.
3. **Severity** (الخطورة): **All severities** (كل درجات الخطورة), **Low** (منخفض), **Medium** (متوسط), **High** (عالٍ), **Critical** (حرج) — each with its count of open exceptions.
4. **Status** (الحالة): **Open and acknowledged** (المفتوحة وقيد المتابعة) — what the list opens on; **Open** (مفتوح); **Acknowledged** (قيد المتابعة); **Resolved** (تمت معالجته); **All** (الكل).
5. **Owner** (المسؤول): **Anyone** (أي شخص), **Mine** (خاصتي) — exceptions whose owner is you, **No owner** (بلا مسؤول).
6. To search, type in **Search this list** (ابحث في هذه القائمة) and press Enter. The search looks in the exception number, the affected record's number or name, the owner's name, and the exception's sentence as it is stored in English — so on the Arabic screen search by a number, a code or a name rather than by Arabic words of the sentence. **Clear** (مسح) removes the search.
7. **Views** (العروض), beside the search box, keeps the filters you have set as a saved view of your own and opens them again later.
The filters are written into the page's address, so a filtered list can be bookmarked.

### How to refresh the list now — Exceptions
Needs: `administer` on `exception` (the CEO, the accounting manager and the system administrator). Without it the button is not shown.
1. The system looks by itself every 30 minutes. To look now, press **Refresh now** (حدّث الآن) at the top of the list.
2. The same check the schedule runs is run at once, over every branch. The list comes back with a green line: "Checked just now: N found, N new, N reopened, N cleared."
3. If a check ran less than 30 seconds ago the button does not run another one: it answers with the result of that last check (the line is worded the same way).
4. What you then see in the list is still only what your own permissions allow.
Refreshing changes no document. It only adds new exceptions, updates the ones still true and clears the ones whose cause is gone.

### How to open an exception and what it shows — Exceptions
Needs: `view` on `exception`, on the kind of record the exception is about, and the right to open that record.
1. In the list click the **Reference** (المرجع). The page is titled with the number and the sentence.
2. The header: **Reference** (المرجع); **Status** (الحالة); **Severity** (الخطورة); **Domain** (المجال); **Exception** (الاستثناء) — the one-line title; **What is wrong** (ما المشكلة) — the explanation with the figures (amounts, dates, days late); **Affected record** (السجل المعني) — a link; **Party** (الطرف) — the customer or supplier, when the exception is about one, linked to its profile; **Owner** (المسؤول); **Branch** (الفرع) — absent when the exception concerns the whole company; **First detected** (أول اكتشاف); **Last seen** (آخر رصد) — the last check that still found it; **Occurrence** (مرات الظهور).
3. Once acknowledged the header also shows **Acknowledged by** (أقرّ به), **Acknowledged on** (تاريخ الإقرار) and the **Note** (الملاحظة); once cleared, **Resolved on** (تاريخ المعالجة).
4. **Evidence** (الأدلة) — the rows the check found, at most 25: **Record** (السجل) — a link where the row has a page; **Date** (التاريخ); **Amount** (المبلغ) in dinars; **Quantity** (الكمية); **What is wrong with it** (ما المشكلة فيه). For an overdue customer, for example, these are the overdue invoices with the days each is late. "The check kept no single rows for this exception." means the explanation is the whole of it.
5. At the foot: the box and button to acknowledge (see "How to acknowledge an exception"), and the button that leads to the fix (see "How to follow the road to the fix").
6. Under the window, **History** (المسار) lists every step the exception has taken (see "Fields — Exceptions").
7. The title bar carries the four icons: printer, paperclip, notes, clock.
The wording is shown in your own language; an Arabic and an English reader see the same exception each in their language.

### How to follow the road to the fix — Exceptions
1. Open the exception. At the foot of its window there is one button named after the screen where the matter is dealt with — for example **Open Bank Reconciliation** (افتح المطابقة البنكية), **Open Posting Mappings** (افتح ربط الترحيل), **Open Shipment Tracking** (افتح تتبع الشحنات), **Open Landed Cost** (افتح التكلفة الواصلة), **Open Task** (افتح المهمة), **Open Approvals** (افتح الموافقات).
2. Press it. That screen opens, narrowed to the record where that is possible (the customer's open items, the container's tracking row, the import's landed cost).
3. Do the work there, with the permissions that screen asks for: match the bank lines, map the account, receive the container, collect the invoice, finish the task, decide the approval.
4. Nothing more is needed on the exception. At the next check — within 30 minutes — the system no longer finds the cause and clears the exception by itself.
The button is not shown on a resolved exception. The **Affected record** link in the header opens the record itself (the customer, the journal, the container), which is not always the same place as the screen that fixes it. The "What the system looks for…" blocks below name the button of each kind of exception.

### How to acknowledge an exception — Exceptions
Needs: `execute` on `exception`, and to be able to open the exception. Only an **Open** exception can be acknowledged.
1. Open the exception.
2. In the box **What you know and what will be done** (ما تعرفه وما سيُفعل) at the foot of the window, write what you know about it and what will be done — at most 1,000 characters. The note is required.
3. Press **Acknowledge** (إقرار).
4. The page answers "Saved." The status becomes **Acknowledged** (قيد المتابعة), the header shows your name, the time and your note, and a line reads "Acknowledged: someone is on it. It clears by itself when the cause is gone."
What acknowledging does: it says a person has seen it and is on it. The exception stays in the list (under Acknowledged) until its cause is gone, and it no longer counts as "open" on the Home page, in the filter counts and in the Control Center. It is written to the history and to the audit log with your name.
What it does not do: it fixes nothing and closes nothing. An acknowledgement cannot be withdrawn or edited; add a note through the notes icon if there is more to say. If the same trouble later gets worse (its severity rises), the system puts the exception back to Open.

### How an exception gets resolved — Exceptions
1. Nobody resolves an exception by hand. There is no Resolve, Close, Dismiss or Delete button, for any role.
2. The system looks every 30 minutes (and when somebody presses Refresh now). When a check no longer finds the cause — the invoice was paid, the container was received, the account was mapped — the exception becomes **Resolved** (تمت معالجته). Its page then reads "The cause is gone; the system cleared this exception by itself." and its history gains the line **Cleared: the cause is gone** (زال سببه فعولج), by **The system** (النظام).
3. So after fixing the cause, allow up to 30 minutes, or ask somebody who may to press **Refresh now**.
4. A resolved exception leaves the default list; choose **Resolved** or **All** in the Status filter to see it. It is never deleted.
5. If the same trouble comes back, the same exception is reopened — same number, history kept, **Occurrence** one higher, history line **Found again** (وُجد من جديد).
6. If a check could not run, it clears nothing: the exceptions it covers stay exactly as they were until it runs properly again.
One known case never clears by itself: a manual journal posted to the customers' or suppliers' control account without naming a customer or supplier stays an exception even after a correcting journal. Acknowledge it with a note saying which journal corrected it.

### Statuses — Exceptions
- **Open** (مفتوح) — found, and nobody has said they are on it. This is what counts as "needing attention".
- **Acknowledged** (قيد المتابعة) — a person has acknowledged it with a note. Still true, still listed.
- **Resolved** (تمت معالجته) — the cause is gone; cleared by the system.
The moves, and who makes them:
- Open → Acknowledged: a person, with a note.
- Open → Resolved and Acknowledged → Resolved: the system only, when a check no longer finds the cause.
- Resolved → Open: the system, when the same trouble is found again.
- Acknowledged → Open: the system, when the trouble got more severe.
No other move exists. A person can never move an exception to Resolved or back to Open.
In the **Status** filter, **Open and acknowledged** (المفتوحة وقيد المتابعة) shows the first two together and **All** (الكل) shows all three.

### Severities — Exceptions
Four grades, set by the system from how serious the kind of trouble is and, for anything that is late, from how long it has lasted:
- **Critical** (حرج) — for example a journal that does not balance, a control account that differs from its sub-ledger, a customer more than 180 days overdue.
- **High** (عالٍ) — for example a posting that failed, negative stock, a container 14 days past its date.
- **Medium** (متوسط) — for example a bank reconciliation with a difference a week after the statement, a customs paper about to expire.
- **Low** (منخفض) — for example a task one day late, a customer 30 days overdue.
A person cannot change a severity. The system raises it as the delay grows (history line **Severity raised** — ارتفعت الخطورة) and lowers it when the situation eases (**Severity lowered** — انخفضت الخطورة). The day limits are fixed in the system; there is no settings screen for them. Only Critical and High exceptions send a notification; Medium and Low wait on the screen.

### Fields — Exceptions
List columns: **Reference** (المرجع) — the number, opens the exception; **Severity** (الخطورة); **Exception** (الاستثناء) — the sentence; **Affected record** (السجل المعني) — opens the record; **Domain** (المجال); **Owner** (المسؤول); **First detected** (أول اكتشاف); **Status** (الحالة).
- **Owner** (المسؤول) is taken by the system from the record itself where it has a responsible person — the person a task is with, the approver a document waits for. Otherwise it is "—". Nobody can assign or change an owner on this screen.
- **Occurrence** (مرات الظهور) — 1 the first time; one more each time a cleared exception is found again.
- **First detected** (أول اكتشاف) and **Last seen** (آخر رصد) — when the system first found it and the last check that still found it.
**Evidence** (الأدلة) columns: **Record** (السجل), **Date** (التاريخ), **Amount** (المبلغ), **Quantity** (الكمية), **What is wrong with it** (ما المشكلة فيه). At most 25 rows are kept.
**History** (المسار) columns: **Event** (الحدث), **When** (متى), **By** (بواسطة) — a person's name, or **The system** (النظام), **Severity** (الخطورة) at that moment, **Note** (ملاحظة). Events: **Detected** (اكتُشف), **Acknowledged** (أُقرّ به), **Cleared: the cause is gone** (زال سببه فعولج), **Found again** (وُجد من جديد), **Severity raised** (ارتفعت الخطورة), **Severity lowered** (انخفضت الخطورة).
The only thing a person types on this screen is the acknowledgement note: **What you know and what will be done** (ما تعرفه وما سيُفعل), required, at most 1,000 characters.

### What the system looks for in Accounting — Exceptions
You see these only if you may open the screen named in brackets. One exception per bank reconciliation, account, journal, posting role or period.
- **Bank reconciliation with a difference** (مطابقة بنكية فيها فرق) — a reconciliation still shows a difference between the bank statement and the ledger: Medium from 7 days after the statement date, High from 30, Critical from 90. Button: **Open Bank Reconciliation** (افتح المطابقة البنكية). (Bank Reconciliation)
- **Control account differs from its sub-ledger** (حساب رقابة يختلف عن دفتره الفرعي) — the ledger balance of a customers' or suppliers' control account is not the total of the customer or supplier accounts. Critical. Button: **Open Account Reconciliation** (افتح مطابقة الحسابات). (G/L Inquiry)
- **Journal that breaks the rules of the books** (قيد يخالف قواعد الدفاتر) — a journal that does not balance, has only one side, is posted to a group account, or has a customer or supplier entry although it is not posted. Critical. Button: **Open Trial Balance** (افتح ميزان المراجعة). (Journal Entries)
- **Posting role without an account** (دور ترحيل بلا حساب) — a posting rule has no usable account for one of its lines, so documents of that kind will refuse to post. High or Medium. Button: **Open Posting Mappings** (افتح ربط الترحيل). (Posting Mappings)
- **Posting that failed** (ترحيل فشل) — a document's posting failed and has not been done again; the exception quotes what the system said. High. Button: **Open Posting Mappings**.
- **Period that cannot close** (فترة لا يمكن إقفالها) — a period has ended and is still open because one of the closing checks fails. Medium at first, High from 5 days after the period's last day. Button: **Open the check** (افتح الفحص). (Accounting Periods)

### What the system looks for in Receivables and Payables — Exceptions
One exception per customer or supplier in a branch (its overdue invoices are the evidence rows), or per journal, or per credit note.
Receivables — seen with `view` on sales invoices:
- **Customer with overdue invoices** (عميل لديه فواتير متأخرة) — graded by the oldest overdue invoice: Low from 30 days late, Medium from 60, High from 90, Critical from 180. Button: **Open Receivables** (افتح الذمم المدينة), on that customer.
- **Customer ledger does not agree with the books** (دفتر العملاء لا يوافق الدفاتر) — a journal on the customers' control account with no customer entry behind it, on another control account, or for another amount. High. Button: **Open Customer Reconciliation** (افتح مطابقة العملاء).
- **Overdue invoice, raised by an automation rule** (فاتورة متأخرة، رفعتها قاعدة أتمتة) — one sales invoice, raised by a rule on the Automation screen; it clears when the invoice is no longer owed. Button: **Open Invoice** (افتح الفاتورة). None of the present rule templates raises this kind, so it is not met in practice yet.
Payables — seen with `view` on purchase invoices (the credit one with `view` on supplier credit notes):
- **Supplier invoices overdue** (فواتير موردين متأخرة) — what the company owes a supplier past the due date: Low from 14 days, Medium from 30, High from 60, Critical from 90. Button: **Open Supplier Open Items** (افتح بنود الموردين المفتوحة), on that supplier.
- **Supplier ledger does not agree with the books** (دفتر الموردين لا يوافق الدفاتر) — the same three faults on the suppliers' control account. High. Button: **Open Payables Reconciliation** (افتح مطابقة الموردين).
- **Supplier credit that does not add up** (إشعار دائن مورد لا تتطابق أرقامه) — a supplier credit note is recorded as applied for one amount while its applications add up to another. High. Button: **Open Credit Memo** (افتح مذكرة الدائن).

### What the system looks for in Inventory — Exceptions
Seen with `view` on stock movements (the in-transit one with `view` on In-Transit Inventory).
- **Negative stock** (مخزون بالسالب) — an item stands below zero in a warehouse. High. The screens never allow this, so it only appears after data was damaged outside the application; report it. Button: **Open Stock Ledger** (افتح سجل المخزون).
- **Stock layers do not match the ledger** (طبقات المخزون لا توافق السجل) — for one item in one warehouse the FIFO cost layers and the stock ledger show different quantities, so the item's value is unreliable. High. Button: **Open Stock Ledger**.
- **Stock document and ledger disagree** (مستند مخزني وسجل المخزون غير متفقين) — a posted document that moved no stock, stock movements that name a document that does not exist, or a transfer that did not issue and receive the same quantity. Critical. Button: **Open Stock Checks** (افتح فحوص المخزون).
- **Stock value differs from the inventory accounts** (قيمة المخزون تختلف عن حسابات المخزون) — the stock valued at FIFO cost is not what the inventory accounts hold in the ledger. One exception for the company. High. Button: **Open Account Reconciliation** (افتح مطابقة الحسابات).
- **Stock in transit that imports do not explain** (مخزون في الطريق لا تفسّره الاستيرادات) — for one item, the quantity standing in the transit warehouses is not what the open imports account for. Medium. Button: **Open In-Transit** (افتح البضاعة في الطريق).

### What the system looks for in Logistics — Exceptions
One exception per container, customs paper or import. You see one only if you may open the screen named in brackets.
- **Container past its expected arrival** (حاوية تجاوزت موعد وصولها) — not received and past its expected date: Low from 3 days, Medium from 7, High from 14, Critical from 30. Button: **Open Shipment Tracking** (افتح تتبع الشحنات), on that container. (Containers)
- **Shipment with no recent status** (شحنة بلا تحديث حديث للحالة) — nobody has written a status for a container that is not yet received: Low from 7 days, Medium from 14, High from 30. Button: **Open Shipment Tracking**.
- **Customs paper in trouble** (مستند جمركي في مشكلة) — a customs PD that customs rejected or that is past its expiry date and still open (High), that has expired without being fully written off, or that expires within 14 days (Medium). Button: **Open Pre-declaration** (افتح الإقرار المبدئي). (Customs Pre-Declarations)
- **Landed cost waiting to be allocated** (تكلفة واصلة تنتظر التوزيع) — an import has charges not yet spread over its goods: Medium once the oldest has waited 21 days, High from 60 days; High at once when charges were added after the landed cost was locked. The explanation says what it waits for (PDs not written off, containers not all received, or nothing — nobody has done it). Button: **Open Landed Cost** (افتح التكلفة الواصلة). (the Landed cost section of an import)
- **Container late, raised by an automation rule** (حاوية متأخرة، رفعتها قاعدة أتمتة) — raised by a rule on the Automation screen, at the severity the rule names; it clears when the container is received. Button: **Open Shipment Tracking**.

### What the system looks for in Tasks, Approvals and System — Exceptions
Tasks — you see one only if you could open the task itself:
- **Overdue task** (مهمة متأخرة) — past its due date: Low from 1 day, Medium from 3, High from 7, Critical from 30. Owner: the person it is with. Button: **Open Task** (افتح المهمة).
- **Blocked task** (مهمة معطّلة) — marked blocked: Medium from 3 days, High from 7, Critical from 21.
- **Overdue task, raised by an automation rule** (مهمة متأخرة، رفعتها قاعدة أتمتة) — a kind kept for automation rules; none of the present rule templates raises it.
Approvals:
- **Document waiting for approval** (مستند ينتظر الموافقة) — a document sent for approval and not decided: Low from 3 days, Medium from 7, High from 14, Critical from 30. Shown to the approver it waits for and to the people who manage the approval routes. Button: **Open Approvals** (افتح الموافقات).
System — seen with `view` on Backup and Health:
- **System health** (سلامة النظام) — what the daily health check reports: no backup or a backup too old, unfinished or not encrypted; no open accounting period, the current period closed, next year not opened; a scheduled job that failed; disk space low; notifications not delivered; a bank account without a ledger account. Critical, High or Medium. The message inside is in English on both screens. Button: **Open Backup and Health** (افتح النسخ الاحتياطي والسلامة).
- **Check showed only part of what it found** (الفحص أظهر جزءًا مما وجده) — one kind of trouble produced more than 200 exceptions; the 200 most severe are listed and the rest appear as these clear. Medium.

### Who sees which exception — Exceptions
An exception is shown to you only when all of these hold:
1. You may open the Exceptions screen. Every role may; every role may also acknowledge and take copies.
2. You may open the screen that shows the same matter in full — Bank Reconciliation for a reconciliation difference, sales invoices for an overdue customer, containers for a late container, and so on. A logistics officer therefore never sees, and never learns of, a bank reconciliation difference.
3. The exception belongs to a branch you are assigned to, or to the whole company.
4. You could open the affected record itself. A task is seen only by the people who can see that task; an approval waiting is seen by its approver and by the people who manage approval routes.
The same rule decides the list, the counts in the filters, the exception's page, its notes, files and printed copy, and the search. An exception you may not see answers "That page does not exist" when its address is typed — the same as a number that was never used. Two colleagues can therefore see different lists and different counts; neither list is wrong.

### Who is notified — Exceptions
- A notification goes out (the bell) when a **Critical** or **High** exception is found for the first time, when one comes back after being cleared, and when an exception's severity rises to High or Critical.
- It goes to the people who may see that exception in its branch, and to its owner. The notification opens the exception. In the notifications list these are filed under the Accounting category, whatever their domain.
- **Medium** and **Low** exceptions send nothing; they wait on the list.
- Each event is told once: the same exception found again at the next check, unchanged, sends nothing more.

### The four icons on an exception — Exceptions
In the title bar of an exception, in this order:
1. **Printer** — **Print / Export** (طباعة / تصدير): a copy of the exception with its evidence and its history, in English or العربية, as PDF (needs `print` on `exception`), Excel or Word (need `export`).
2. **Paperclip** — **Attachments** (المرفقات): files kept with the exception, for example the bank's letter. Files can be added until the exception is resolved, by whoever may attach files.
3. **Speech bubble** — **Notes** (الملاحظات): dated, signed notes that are never edited. Anyone who can open the exception may add one — use it for progress after the acknowledgement.
4. **Clock** — **Audit log** (سجل التدقيق): who acknowledged it and when, and the notes added.
The exception's own steps (detected, acknowledged, cleared, found again) are in the **History** (المسار) table on the page, not behind the clock.

### What it does not do — Exceptions
- It does not fix, post, pay, match, receive or approve anything. It names the screen where that is done.
- An exception is resolved only by the system's own check, never by hand; the check runs every 30 minutes.
- There is no bulk acknowledge, no snooze, no "ignore", no way to assign an owner, and no way to change a severity.
- The day limits (30 days overdue, 3 days late…) cannot be changed from a screen.
- It lists only the kinds of trouble described in the "What the system looks for…" blocks. It does not, for example, list bank statement lines that are simply not matched yet, unused supplier credit, a project over its budget, or payroll and leave matters — those have their own screens and notifications.
- A long list is capped: at most 200 exceptions of one kind and 25 evidence rows per exception. When the cap is reached the list says so with its own exception.

### Refusals — Exceptions
After **Acknowledge** or **Refresh now**, a refusal is shown as "That could not be saved." followed by one of these sentences (always in English):
- "Say what you know and what will be done: an acknowledgement carries a note." — the note box was empty. Write the note and press Acknowledge again.
- "The note is at most 1000 characters." — shorten it; put longer text in a note behind the notes icon or attach a file.
- "EXC-0007 has been acknowledged already." — somebody acknowledged it while your page was open. Reload; to add what you know, use the notes icon.
- "EXC-0007 is resolved; the cause is gone." — the system cleared it meanwhile. Nothing more to do.
- "No exception EXC-0007." — the number does not exist, or it is an exception you may not see.
- "Permission denied: 'execute' on 'exception' is not granted to this user." — you may read exceptions but not acknowledge them; ask an administrator.
- "Permission denied: 'administer' on 'exception' is not granted to this user." — Refresh now is for the CEO, the accounting manager and the system administrator.
- **Not available to you** (غير متاح لك) — you do not hold `view` on `exception`.
- **That page does not exist** (هذه الصفحة غير موجودة) — the exception number in the address does not exist or is outside what you may see.
If the **Acknowledge** box is missing, the exception is already acknowledged or resolved, or you lack the permission. If an exception you expected is missing, it rests on a screen or a branch you may not open, or it has been resolved — set Status to **All**.

## Control Center (مركز التحكم)
Path: Dashboard → Home → Control Center   |   Arabic: الرئيسية ← الرئيسية ← مركز التحكم
Address: /control-center
Needs: `view` on `control_center` (held by the CEO, the accounting manager and the system administrator). Each check also needs `view` on the screen it summarises; without it that one check reads "Not checked for you". The open-exception counts need `view` on `exception`.
What it is for: The screen titled **ERP Control Center** (مركز التحكم في النظام) answers one question — is the system consistent inside? — with 32 checks of the books, the stock, the customer and supplier ledgers, the imports and the system's own machinery. Each check shows its state, the figures it compared and what needs attention. It is read-only: nothing is ever changed from here.

### How to read the screen — Control Center
Needs: `view` on `control_center`.
1. Open Dashboard → Home → **Control Center** (مركز التحكم).
2. The first line says when the answer was read: "Checked <date and time>: N checks read in N ms. Nothing is stored; every figure is read when this page opens."
3. The second line says whose data was compared: "Company-wide: every branch is compared." for a Super User, otherwise "Branches you see: <codes>. Each check compares only what you may read."
4. **Summary** (الملخص) — one row per domain: **Domain** (المجال), then how many of its checks are in each state — **Needs attention** (يحتاج إلى انتباه), **Could not be checked** (تعذّر فحصه), **Not checked** (لم يُفحص), **OK** (سليم) — and **Open exceptions** (الاستثناءات المفتوحة). There is no score and no percentage: the headline is these counts.
5. Click a domain's name to see only that domain. Click its number under **Open exceptions** to open the Exceptions list for that domain.
6. Below the summary, one table per domain — **Accounting** (المحاسبة), **Inventory** (المخزون), **Receivables** (الذمم المدينة), **Payables** (الذمم الدائنة), **Logistics** (الخدمات اللوجستية), **System** (النظام) — headed "N checks, N need attention". Each row is one check (see "How to read a check").
If you may not open Exceptions, the last column shows "—" and a line reads "You do not have access to the Exception Center, so its counts are not shown."

### How to run the checks again and filter them — Control Center
1. Every time the page opens, the checks are run afresh. To run them again press **Run checks now** (شغّل الفحوص الآن) — it is the page asked again; there is no other button on the screen.
2. To narrow the page first choose a **Domain** (المجال) — **All domains** (كل المجالات) or one of the six — and/or a **State** (الحالة): **All states** (كل الحالات), **OK** (سليم), **Needs attention** (يحتاج إلى انتباه), **Not checked** (لم يُفحص), **Could not be checked** (تعذّر فحصه). The number in brackets beside each state is how many checks stand in it now. Then press **Run checks now**.
3. Choosing a domain runs only that domain's checks. Choosing a state runs them all and shows only the rows in that state; the Summary still counts every check that ran.
4. "No check is in that state." (لا فحص في هذه الحالة.) means the state filter left nothing to show — for example Needs attention on a healthy system.
5. The choices are written into the page's address, so "Accounting, needs attention" can be bookmarked.
The whole run is given at most 90 seconds and each check at most 10 seconds, so the page always answers; a check that ran out of time says so.

### How to read a check — Control Center
Each check is one row with three columns.
1. **Check** (الفحص) — its name and, under it, what it verifies in one sentence, for example **Trial balance** (ميزان المراجعة): "Total debits equal total credits across every posted journal." The name is a link to the screen where the matter is seen in full (the Trial Balance, Bank Reconciliation, Inventory Checks, Posting Mappings…); it is plain text if you may not open that screen.
2. **State** (الحالة) — one of the four states.
3. **Evidence** (الدليل) — the figures the check compared, one to a line, for example **Total debit** (إجمالي المدين), **Total credit** (إجمالي الدائن) and **Difference** (الفرق); or **Sub-ledger** (الدفتر الفرعي), **Control account** (الحساب الرقابي) and **Difference**. When something is wrong the last line says "N need attention".
4. Under a check that needs attention: up to eight lines, each saying in words what is wrong, with a link to the record or to **Open** (افتح) — for example "Total debit … does not equal total credit …: a difference of …", "<account>: sub-ledger …, ledger …, a difference of …", "Job … has not run for N hours.", or the title of a late container.
5. "N more are not listed here." with **Open** — there are more than eight; open the screen to see them all.
6. A check that is **Not checked** or **Could not be checked** shows the reason in the Evidence column instead of figures.
Money is in dinars. To act on what a check shows, follow its link: nothing can be corrected on this screen.

### States — Control Center
- **OK** (سليم) — the check ran and found nothing that needs attention. Its figures are still shown.
- **Needs attention** (يحتاج إلى انتباه) — the check ran and found something; the lines under it say what and where.
- **Not checked** (لم يُفحص) — the check was not asked. Either "Not checked for you: it reads <screen>, which you may not open." or "Not set up here, so there is nothing to check." It is not a fault and not a pass.
- **Could not be checked** (تعذّر فحصه) — the check was asked and could not answer; the reason follows. It is never shown as OK.
A check has no history and no owner: its state is what was true at the moment the page was read. For something that must be followed until it is gone, use Exceptions.

### Why a check reads "Not checked for you" — Control Center
The Control Center reads everything with your own permissions, so two people can see different results for the same check.
- "Not checked for you: it reads <screen>, which you may not open." — you do not hold `view` on the screen that check summarises. The screen is named: **the Trial Balance** (ميزان المراجعة), **Bank Reconciliation** (التسوية البنكية), **Bank Accounts** (الحسابات البنكية), **Posting Mappings** (ربط الترحيل), **Inventory Checks** (فحوص المخزون), **In-Transit Inventory** (المخزون في الطريق), **Sales Invoices** (فواتير المبيعات), **Purchase Invoices** (فواتير المشتريات), **Supplier Credits** (أرصدة الموردين الدائنة), **Landed Costs** (التكاليف الواصلة), **Landed Cost** (التكلفة الواصلة), **Customs PDs** (بيانات الجمارك المسبقة), **Containers** (الحاويات), **Background Jobs** (المهام الخلفية), **WhatsApp** (واتساب), **Automation** (الأتمتة), **Cloud Files Settings** (إعدادات الملفات السحابية), **Backup and Health** (النسخ الاحتياطي وسلامة النظام), **Users** (المستخدمون), **Roles** (الأدوار), **Employees** (الموظفون).
- What to do: nothing is wrong with the system. If you should see that check, ask an administrator for `view` on that screen. A CEO who may not open Posting Mappings, for example, sees three accounting checks as Not checked.
- The check's name is then plain text, not a link.
- "Not set up here, so there is nothing to check." — a part of the system is not in use: the WhatsApp bridge was never paired, cloud files are switched off, or no automation rule exists yet.
- Branches: a check compares only the branches you are assigned to. A figure can therefore be smaller for you than for a Super User, who sees the company.

### Why a check reads "Could not be checked" — Control Center
The reason is written in the Evidence column:
- "Could not be checked: it did not answer within 10 seconds." — the check took too long. Press **Run checks now** again; if it repeats, tell the system administrator.
- "Could not be checked: the 90 seconds allowed for the whole run ran out first." — earlier checks used up the time. Choose one **Domain** and run again.
- "Could not be checked: <message>" — the check met an error; the message is the system's own, in English. Report it with the check's name.
- "Could not be checked: the job records cannot be read on this server." / "… the job schedule cannot be read on this server." — the Scheduled jobs check answers for the server it runs on, and that server keeps no such files.
One check failing never blanks the page: the others are still shown.

### The checks in Accounting — Control Center
Seven checks.
- **Trial balance** (ميزان المراجعة) — total debits equal total credits across every posted journal.
- **Journal integrity** (سلامة القيود) — every posted journal balances, has two sides and posts only to accounts that take postings.
- **Bank reconciliation** (التسوية البنكية) — no bank statement differs from the ledger beyond the days allowed.
- **Bank and cash accounts** (الحسابات البنكية والنقدية) — every bank and cash account points at a ledger account that exists.
- **Posting roles** (أدوار الترحيل) — every role a posting rule needs is mapped to an account.
- **Exchange difference accounts** (حسابات فروق الصرف) — the exchange gain/loss and revaluation roles are mapped, so foreign-currency postings can close.
- **Posting failures** (إخفاقات الترحيل) — no posting has failed and is waiting to be done again.
Needs, beside the Control Center itself: the Trial Balance for the first two; Bank Reconciliation; Bank Accounts; Posting Mappings for the last three.

### The checks in Inventory, Receivables and Payables — Control Center
Inventory — five checks:
- **Stock against the ledger** (المخزون مقابل الدفتر) — the FIFO layers hold the same value as the inventory accounts in the ledger. Figures: **Stock at FIFO cost** (المخزون بتكلفة الوارد أولًا), **Inventory accounts in the ledger** (حسابات المخزون في الدفتر), **Difference** (الفرق).
- **Negative stock** (المخزون السالب) — no item stands below zero in any warehouse.
- **FIFO layers** (طبقات الوارد أولًا) — the cost layers of every item agree with the stock movements.
- **Documents against the stock ledger** (المستندات مقابل دفتر المخزون) — every stock document wrote its movements and every movement has its document.
- **Stock in transit** (المخزون في الطريق) — what stands in the transit warehouses is explained by open imports.
Receivables — two checks:
- **Receivables control account** (الحساب الرقابي للذمم المدينة) — the customer sub-ledger equals the receivables control accounts, and every ledger line is consistent.
- **Customer statements against ageing** (كشوف العملاء مقابل أعمار الذمم) — what the statements show owed is accounted for by open invoices.
Payables — three checks:
- **Payables control account** (الحساب الرقابي للذمم الدائنة) — the same for suppliers.
- **Supplier statements against ageing** (كشوف الموردين مقابل أعمار الذمم).
- **Supplier credits** (أرصدة الموردين الدائنة) — every supplier credit is applied for what its applications add up to.

### The checks in Logistics and System — Control Center
Logistics — four checks:
- **Imports in transit** (استيرادات في الطريق) — no import has more shipped or received than was bought, or goods still in transit after every container is in.
- **Landed costs** (التكاليف الواصلة) — no import has landed cost stuck waiting to be allocated.
- **Customs** (الجمارك) — no PD or declaration is rejected, expired or inconsistent.
- **Shipment delays** (تأخر الشحنات) — no container is past its expected arrival or has gone without a status update.
System — eleven checks:
- **Scheduled jobs** (المهام المجدولة) — every scheduled job ran on time and finished cleanly.
- **Outbox queues** (طوابير الإرسال) — no queue holds items given up on, or waiting more than a day.
- **Notification deliveries** (تسليم الإشعارات) — none stuck, none failed in the last week.
- **WhatsApp bridge** (جسر واتساب) — paired, connected and reporting.
- **Automation** (الأتمتة) — no rule paused or failing, events are being taken up, and automation is switched on.
- **Cloud files** (الملفات السحابية) — the connection is set up, its key is sound, its links point at the server set.
- **System health** (سلامة النظام) — the database answers, the system is up to date, backups and disk are in order.
- **Users without a role** (مستخدمون بلا دور) — every active user holds at least one role.
- **Unknown permission objects** (كائنات صلاحيات غير معروفة) — every permission granted to a role names something the system uses.
- **Super Users** (المستخدمون الرئيسيون) — at most one active Super User.
- **Users and employees** (المستخدمون والموظفون) — every active user has an employee record, and no employee who left still has an active user.

### What it does not do — Control Center
- It changes nothing: no posting, no correction, no "mark as resolved". The only control is the filter form with **Run checks now**.
- It keeps nothing: there is no history of yesterday's result and nothing to print or export from this screen. To keep a result, note the time on the first line.
- It gives no score, grade or percentage.
- It does not notify anybody. What must reach a person is an exception: see Exceptions, whose open counts are shown per domain.
- A check lists at most eight things; the rest are counted and reached through the check's link.
- The Scheduled jobs and backup figures describe the server the page runs on.
- Tasks and Approvals have no domain here; their late items are exceptions.

### Refusals — Control Center
Nothing is saved on this screen, so there is no "That could not be saved." here. What a person can meet:
- **Not available to you** (غير متاح لك) — you do not hold `view` on `control_center`. It is granted to the CEO, the accounting manager and the system administrator; the menu entry is hidden from everyone else.
- "Not checked for you: it reads <screen>, which you may not open." — one check is withheld from you; see "Why a check reads "Not checked for you"".
- "Could not be checked: …" — one check could not answer; see "Why a check reads "Could not be checked"".
- "You do not have access to the Exception Center, so its counts are not shown." — the Open exceptions column is empty for you.
- "No check was run." (لم يُشغَّل أي فحص.) / "No check is in that state." (لا فحص في هذه الحالة.) — the filters left nothing; set Domain and State back to All and press **Run checks now**.

## Related records (السجلات المرتبطة)
Path: not in the menu — a section named **Related records** at the foot of an import application, of a supplier's or customer's profile and of a stock item's page; its link **Open the whole chain** (افتح السلسلة كاملة) opens the same chain on a page of its own
Address: /control-center/relationships?type=<import | supplier | customer | item>&id=<import number | partner code | item code>
Needs: `view` on the record the chain starts from — `payable` for an import, `business_partner` for a supplier or a customer, `item` for an item. Each step is drawn only with `view` on its own records. The Control Center permission is not needed.
What it is for: Shows how the real records around one import, supplier, customer or item connect — for an import: its purchase invoices, bills of lading, containers, customs papers, landed cost, receipts and the stock they became. Every line is a record that exists and opens its own page. Read-only.

### How to open the related records of a record — Related records
1. Open the record: an import application (Transfers & Applications → Import Applications, click its number), a supplier (Payables → Supplier Balances → Suppliers), a customer (Receivables → Sales & Receivables → Customers) or an item (Accounting → Master Data — Inventory Reference → Items).
2. Scroll down to the section **Related records** (السجلات المرتبطة). On an import it sits above the Status log; on a supplier or customer profile above the Audit log; on an item at the foot of the page.
3. To see the chain alone on a page, press **Open the whole chain** (افتح السلسلة كاملة). The page is titled "<Import | Supplier | Customer | Item> <number>: related records"; the back button **Back to <number>** (العودة إلى <number>) returns to the record.
4. Press any record's number in the table to open that record.
The section appears on an import application only when its type is Import, and on an item only when it is a stock item. A partner who is both a supplier and a customer shows the chain of the side the profile was opened as (from Suppliers or from Customers).

### How to read the chain — Related records
1. The first line names the record the chain starts from: its kind, its number and its name.
2. A row of numbered chips shows the steps in order, for example "1. Purchase invoices · 2", "2. Bills of lading · 1", "3. Containers · 4". The number after the dot is how many records of that step you may open; a "+" after it means there are more than the section read. A chip without a number is a step with nothing yet (hover: **Not yet** — لم يحدث بعد).
3. The table lists the records step by step: **Step** (الخطوة); **Record** (السجل) — the number, a link when you may open its page, with a short note under it (a B/L's vessel and expected date, a PD's expiry, a receipt's warehouse, a layer's quantity and unit cost); **From** (من) — the record of the step before that this one hangs on (a container's bill of lading, a declaration's PD); **Date** (التاريخ); **Status** (الحالة); **Amount or quantity** (المبلغ أو الكمية).
4. **Not yet** (لم يحدث بعد) on a step's row — the step before it has records and this one has none: the import has containers but no receipt yet, a supplier has an order but no goods receipt. Steps further on are left out until the chain gets there.
5. "and N more you may open" — a step shows at most six records. "and more" — there are more than the 24 the section reads; open the step's own screen to see them all.
6. "Could not be read just now." (تعذّرت القراءة الآن.) — that one step failed to load; the rest is still right. Reload the page.
7. The last line: "A step you may not open is not shown at all, and records you may not open are not counted."

### The four chains — Related records
- **Import** (الاستيراد) — **Purchase invoices** (فواتير المشتريات) → **Bills of lading** (بوالص الشحن) → **Containers** (الحاويات) → **Customs PDs** (البيانات الجمركية المسبقة) → **Declarations** (الإقرارات الجمركية) → **Landed cost** (التكلفة الواصلة) — its locks → **Receipts** (الاستلامات) → **Inventory** (المخزون) — where the goods stand now → **FIFO layers** (طبقات الوارد أولًا) — what each receipt cost. There is no separate "shipment" step: the bill of lading is the shipment and the containers are its lines.
- **Supplier** (المورد) — **Purchase orders** (أوامر الشراء) → **Goods receipts** (استلامات البضاعة) → **Purchase invoices** (فواتير المشتريات) → **Payments** (المدفوعات) → **Statement** (كشف الحساب) — the balance, with its oldest entry → **Ageing** (أعمار الذمم) — open invoices: how many are open and how many overdue.
- **Customer** (العميل) — **Sales invoices** (فواتير المبيعات) → **Receipts** (سندات القبض) → **Credit notes** (إشعارات الدائن) → **Returns** (المرتجعات) → **Statement** (كشف الحساب) → **Ageing** (أعمار الذمم).
- **Item** (الصنف) — **Warehouses** (المستودعات) — where it stands and how much → **FIFO layers** (طبقات الوارد أولًا) → **Movements** (الحركات) → **Source documents** (المستندات المصدر) — the documents that moved it.
A cancelled or closed import shows what it has and no "Not yet". An item never shows "Not yet".

### Why a step or a record is missing — Related records
- A step is drawn only if you hold `view` on its records: the Containers step needs the bills of lading and the containers, the Statement step needs the partner and its invoices, the item's Movements need the stock movements. A step you may not open is absent — not empty, not "0" — so the chain never tells you that something you may not see exists.
- A record inside a step is listed only if you could open it yourself: your branches and the record's own access rule decide. Records you may not open are not counted either.
- A record's number in the **From** column is shown only when that record is itself in the chain you see.
- A record without a link is one whose own page you may not open or that has no page (a FIFO layer, a landed-cost lock).
- "Nothing related to this record that you may open." (لا شيء مرتبط بهذا السجل مما يحق لك فتحه.) — no step has anything for you.
Two colleagues can therefore see different chains for the same import; each is complete for that person.

### Refusals — Related records
Nothing is typed or saved here. What a person can meet:
- **Not available to you** (غير متاح لك) — on the chain page: you do not hold `view` on the kind of record the chain starts from (import applications, business partners or items).
- **That page does not exist** (هذه الصفحة غير موجودة) — the number in the address is not an import, supplier, customer or item you may open, or the address names another kind of record. Open the record from its list and use **Open the whole chain** from there.
- No **Related records** section on a record — the record is not an import-type application or not a stock item.

## Automation (الأتمتة)
Path: Settings → Administration → Automation   |   Arabic: الإعدادات ← الإدارة ← الأتمتة
Address: /administration/automation (one rule: /administration/automation/<rule number>; one run: /administration/automation/runs/<run id>)
Needs: `view` on `automation` to open the screen, a rule or a run; `administer` on `automation` to create a rule, edit it, switch it on or off, stop all automation and change the pause setting; `print` / `export` on `automation` for copies. Both are held by the CEO and the system administrator only.
What it is for: Rules that act by themselves when something happens in the system: "when a purchase invoice of 50,000,000 or more is submitted, hold it for a second person's review and tell the accounting managers". A rule is made from one of five ready templates by filling in a few numbers and names. Every rule is born switched off, runs with the permissions of the person who switched it on, and leaves a record of everything it did.

### What it can and cannot do — Automation
A rule can do five things, and only these:
- **Tell people** (إبلاغ أشخاص) — send a notification to a role, a named person, the rule's owner, whoever raised the record, the person a task is with, or that person's supervisor.
- **Raise a task** (إنشاء مهمة) — a task in the Task Center, for a named person or for whoever raised the record.
- **Ask for a review** (طلب مراجعة) — hold a submitted purchase invoice until a second person approves the review in My Approvals.
- **Raise an exception** (إنشاء استثناء) — put a finding in the Exception Center (of the present templates, only the container one does).
- **Point people to the workflow** (توجيه أشخاص إلى سير العمل) — tell people an invoice is waiting for review in My Approvals.
A rule can never:
- post a journal or a document, pay or receive money, or move stock — "Posting stays a person's act";
- approve anything, edit or delete a record, or run a formula or a program;
- do what its owner could not do by hand — such a step is skipped and the run says so;
- tell a person about a record that person may not open;
- act on an invoice that was submitted or posted before the rule was switched on;
- act twice on the same event, or on a record that it created itself.
There is no free-form rule builder: a rule listens to one of five events — **Purchase invoice submitted** (تقديم فاتورة مشتريات), **Purchase invoice posted** (ترحيل فاتورة مشتريات), **Task overdue** (مهمة متأخرة), **Container past its expected arrival** (حاوية تجاوزت موعد وصولها), **Sales invoice overdue** (فاتورة مبيعات متأخرة). There are no rules yet for payments, bank reconciliation, approvals requested or chat messages.

### How to read the screen — Automation
Needs: `view` on `automation`.
The screen has four parts, top to bottom.
1. **Status** (الحالة) — whether automation as a whole is on ("Automation is on" — الأتمتة مفعّلة — with the chip **On** — قيد التشغيل) or off ("Automation is switched off" — الأتمتة متوقفة — with the chip **Off** — متوقفة), and the figures: **Rules** (القواعد), **On** (قيد التشغيل), **Paused** (موقوفة مؤقتًا), **Failing** (متعثّرة), **Failed runs in 7 days** (تشغيلات فاشلة خلال 7 أيام), **Events waiting** (أحداث بالانتظار), **Last run** (آخر تشغيل), and **Pause a rule after this many failed events in a row** (إيقاف القاعدة مؤقتًا بعد هذا العدد من الأحداث الفاشلة المتتالية). An administrator also sees the switch and the pause setting here.
2. **Rules** (القواعد) — every rule: **Rule** (القاعدة) — its number, AUT-…, opens it; **Name** (الاسم); **Event** (الحدث); **State** (الحالة); **Owner** (المالك); **Last run** (آخر تشغيل) with its outcome; **Failures** (الإخفاقات) — "N failed · N in a row".
3. **Templates** (القوالب) — the five templates, each with its **Event** and, for an administrator, the button **Create a rule** (إنشاء قاعدة).
4. **Runs** (التشغيلات) — what the rules did, newest first: **When** (الوقت) — opens the run; **Rule** (القاعدة); **Record** (السجل) — the invoice, task or container it was about; **Outcome** (النتيجة); **What happened** (ما حدث).
With no rule yet the list says "No rules yet. Create one from a template below; it starts switched off."

### How to filter the rules and the runs — Automation
1. Rules: type in **Search this list** (ابحث في هذه القائمة) to find a rule by its number, its name or its owner's name. Or choose **State** (الحالة) — **All** (الكل), **On** (قيد التشغيل), **Off** (متوقفة), **Paused** (موقوفة مؤقتًا), **Failing** (متعثّرة) — and/or **Event** (الحدث) — **Any event** (أي حدث) or one of the five — and press **Filter** (تصفية).
2. Runs: choose **Rule** (القاعدة) — **Any rule** (أي قاعدة) or one rule — and/or **Outcome** (النتيجة) — **Any outcome** (أي نتيجة), **Done** (تم), **Not done** (لم يُنفَّذ), **Failed** (فشل) — and press that table's own **Filter** (تصفية).
3. The two tables filter independently: setting one does not undo the other. Each has its own page numbers.
4. To see everything a rule did, open the rule and press **All runs** (كل التشغيلات), or choose it in the runs' **Rule** filter.
**Failing** lists rules whose latest events failed (one or more in a row); **Paused** lists rules the system stopped by itself.

### How to create a rule from a template — Automation
Needs: `administer` on `automation`, and `view` on the kind of record the rule is about (purchase invoices, tasks, containers or sales invoices).
1. Open Settings → Administration → **Automation** (الأتمتة) and scroll to **Templates** (القوالب).
2. On the template's row press **Create a rule** (إنشاء قاعدة). A window opens titled "New rule from “<template>”", with one sentence saying what the template does.
3. Type a **Rule name** (اسم القاعدة) — 3 to 80 characters, for example "Invoices over 50 million — review".
4. Fill the template's own fields (see "The five templates"). Nothing is pre-filled: an amount, a number of days, a role or a person is always your choice.
5. Press **Create rule** (إنشاء القاعدة).
6. The rule's page opens with "Saved." and a number AUT-…. Its state is **Off** (متوقفة): nothing happens yet.
7. Read **What it does** (ما تفعله) on the page — the rule in plain sentences — and, when it is right, switch it on (see "How to switch a rule on").
If something is refused, the window opens again with the reason above it.

### The five templates — Automation
- **Purchase invoice over an amount** (فاتورة مشتريات تتجاوز مبلغًا) — when a purchase invoice is submitted for at least the amount, it waits for a second person's review in My Approvals before it can be posted, and a role is told. Fields: **Amount from (IQD)** (المبلغ ابتداءً من (د.ع)), **Role to tell** (الدور المراد إبلاغه).
- **Purchase invoice posted over an amount** (فاتورة مشتريات مرحّلة تتجاوز مبلغًا) — when an invoice of at least the amount has been posted, a role is told. Nothing is held. Fields: **Amount from (IQD)**, **Role to tell**.
- **Container past its expected arrival** (حاوية تجاوزت موعد وصولها المتوقع) — when a container is the given number of days past its expected arrival and not received: an exception is raised, a role is told and, if chosen, a follow-up task is raised. Fields: **Days late** (أيام التأخر), **Severity** (الدرجة), **Role to tell**, **Also raise a follow-up task** (إنشاء مهمة متابعة أيضًا) and the five task fields.
- **Task overdue** (مهمة متأخرة) — when a task is the given number of days past its due date, the person it is with and/or their supervisor are told. Fields: **Days late**, **Tell the person the task is with** (إبلاغ من المهمة عنده), **Tell their supervisor** (إبلاغ مشرفه) — tick at least one.
- **Sales invoice overdue** (فاتورة مبيعات متأخرة) — when a sales invoice is the given number of days past its due date, a follow-up task is raised for whoever raised the invoice, and they are told. Fields: **Days late**, **Only invoices from (IQD)** (الفواتير ابتداءً من (د.ع) فقط), and the task fields.
Every template also has **Note added to what the rule does** (ملاحظة تُضاف إلى ما تفعله القاعدة).

### Fields — Automation
The fields of the template windows (create and edit):
- **Rule name** (اسم القاعدة) — required; 3 to 80 characters.
- **Amount from (IQD)** (المبلغ ابتداءً من (د.ع)) — required; in dinars, digits and at most four decimals; above zero. The rule acts on invoices of this amount or more.
- **Only invoices from (IQD)** (الفواتير ابتداءً من (د.ع) فقط) — optional; leave empty for every overdue invoice.
- **Days late** (أيام التأخر) — required; a whole number from 1 to 365. The rule acts once the record is at least this many days late.
- **Role to tell** (الدور المراد إبلاغه) — required; one role from the list. Everyone holding it is told, each only if they may open the record.
- **Severity** (الدرجة) — required; **Critical** (حرج), **High** (عالٍ), **Medium** (متوسط) or **Low** (منخفض): the severity of the exception raised.
- **Also raise a follow-up task** (إنشاء مهمة متابعة أيضًا) — a tick. "The five task fields below are used only when this is ticked."
- **Task for** (المهمة إلى) — an active user. **Section the task is raised in** (القسم الذي تُنشأ فيه المهمة) — one of the sections you may raise tasks in. **Task title** (عنوان المهمة) — 3 to 120 characters. **Task priority** (أولوية المهمة) — **Low** (منخفضة), **Normal** (عادية), **High** (عالية), **Urgent** (عاجلة). **Task due in (days)** (استحقاق المهمة خلال (أيام)) — 0 to 60 days after the day the rule runs.
- **Tell the person the task is with** (إبلاغ من المهمة عنده) / **Tell their supervisor** (إبلاغ مشرفه) — ticks.
- **Note added to what the rule does** (ملاحظة تُضاف إلى ما تفعله القاعدة) — optional; at most 300 characters; it travels with the notification, the task and the exception.
- **Why it is changed** (سبب التعديل) — on the edit window only; optional; at most 1,000 characters.
Drop-downs open on **Choose…** (اختر…).

### How to open a rule and what it shows — Automation
Needs: `view` on `automation`.
1. In **Rules** click the rule's number. The page is titled with the number and the name.
2. The header: **Rule** (القاعدة); **State** (الحالة); **Rule name** (اسم القاعدة); **Event** (الحدث); **Template** (القالب); **Version** (الإصدار); **Owner (it runs with their permissions)** (المالك (تعمل القاعدة بصلاحياته)); **Created by** (أنشأها); **Created** (تاريخ الإنشاء); **Switched on by** (شغّلها); **Acts on what happens after** (تعمل على ما يقع بعد) — the moment it was switched on; **Last run** (آخر تشغيل) with its outcome, or "Never run" (لم تُشغَّل قط); **Failed events in a row** (أحداث فاشلة متتالية); and, on a paused rule, **Paused** (إيقاف مؤقت) with the reason.
3. **What it does** (ما تفعله) — the rule in sentences, columns **Step** (الخطوة) and **What** (ماذا): rows **When** (متى) are its conditions ("Invoice amount (IQD) is at least …", or "Always: every such event"); rows **Then** (ثم) 1, 2, 3 are what it does, in order ("Ask for a second person's review before the invoice can be posted", "Tell everyone with the role …").
4. At the foot, for an administrator: **Edit parameters** (تعديل المعاملات), and **Switch on** (تشغيل) or — on a rule that is on — the box **Why it is switched off** (سبب الإيقاف) with **Switch off** (إيقاف).
5. **Versions** (الإصدارات) — every version: **Version** (الإصدار) — the one in force is marked **Current** (الحالي), **Name** (الاسم), **Changed by** (غيّرها), **When** (الوقت), **Why** (السبب).
6. **Runs of this rule** (تشغيلات هذه القاعدة) — its last ten runs, and the link **All runs** (كل التشغيلات).
7. The title bar carries the four icons: printer, paperclip, notes, clock.

### How to switch a rule on — Automation
Needs: `administer` on `automation`, `view` on the kind of record the rule is about, and the permission for at least one of the things the rule does.
1. Open the rule. Its state is **Off** (متوقفة) or **Paused** (موقوفة مؤقتًا).
2. Read the note above the rule if there is one: "If you switch it on you become its owner and it runs with your permissions. These steps are beyond what you could do by hand and would be skipped: …". It names the steps you yourself are not permitted to do. Either accept that they will be skipped, or let a colleague who holds those permissions switch the rule on.
3. Press **Switch on** (تشغيل).
4. "Saved." The state becomes **On** (قيد التشغيل), you are now the **Owner**, **Switched on by** shows your name, and **Acts on what happens after** shows this moment.
From now on the rule acts on events that happen after that moment: an invoice submitted or posted before it is never acted on. For the lateness rules the event is the system's morning check, so a task, container or sales invoice that is already late enough when the rule is switched on is acted on at the next morning's check. What each step needs of the owner: telling people — `view` on the record; raising a task — `create` and `submit` on tasks and `view` on the record; asking for a review — `submit` or `approve` on purchase invoices; raising an exception — `administer` and `execute` on exceptions and `view` on the record.

### How to switch a rule off — Automation
Needs: `administer` on `automation`.
1. Open the rule. Its state is **On** (قيد التشغيل).
2. In the box **Why it is switched off** (سبب الإيقاف) type the reason — at least 3 characters.
3. Press **Switch off** (إيقاف).
4. "Saved." The state becomes **Off** (متوقفة). The rule stops acting at once; its versions and its runs stay. The reason is kept in the rule's audit log (the clock icon).
Switching a rule off does not undo what it already did: tasks and exceptions it raised stay, and a purchase invoice it held for review stays held until a person decides the review in My Approvals. A rule is never deleted; one that is no longer wanted is left switched off.

### How to edit a rule — Automation
Needs: `administer` on `automation`.
1. Open the rule and press **Edit parameters** (تعديل المعاملات). The window "Edit <rule number>" opens with the present values.
2. Change the **Rule name** and/or the template's fields. The template and the event of a rule cannot be changed — make a new rule from another template instead.
3. Optionally say why in **Why it is changed** (سبب التعديل).
4. Press **Save as a new version** (حفظ كإصدار جديد).
5. "Saved." The **Version** goes up by one and appears in **Versions** (الإصدارات) marked **Current** (الحالي) with your name and your reason.
"A change is a new version; an earlier one is never edited. The person who saves a change becomes the owner." A rule that is on stays on and acts from the new version, with your permissions, from the next event. Each run names the version it used, so an old run can always be read against the rule as it was then.

### How to stop all automation — Automation
Needs: `administer` on `automation`.
1. Open Settings → Administration → **Automation**. In **Status** (الحالة), type why in **Reason** (السبب) — at least 3 characters; "Kept in the audit trail. While it is off no rule acts and no event is recorded."
2. Press **Switch automation off** (إيقاف الأتمتة).
3. The status reads "Automation is switched off" (الأتمتة متوقفة) with the chip **Off**. Every rule stops at once, whatever its own state says; the rules keep their own On/Off setting for later.
4. To start again, type the reason and press **Switch automation on** (تشغيل الأتمتة).
While automation is off, what happens in the system is not noted for the rules at all. So when it is switched on again there is no backlog: nothing that happened in between is acted on. A purchase invoice already held for review stays held until a person decides it in My Approvals. The Control Center shows the switch being off as something that needs attention.

### How to set when a failing rule is paused — Automation
Needs: `administer` on `automation`.
1. In **Status**, change **Pause a rule after this many failed events in a row** (إيقاف القاعدة مؤقتًا بعد هذا العدد من الأحداث الفاشلة المتتالية) — a whole number from 1 to 20; it starts at 3.
2. Press **Save** (حفظ).
A rule whose runs fail that many events in a row is switched off by the system and marked **Paused** (موقوفة مؤقتًا), with the reason on its page: "It failed 3 events in a row (the last: …), so it was paused. Look at its runs, fix the cause and switch it on again." The people who administer automation are notified once ("Automation rule AUT-… was paused"). A rule is also paused when its owner's account is deactivated or the owner no longer administers automation: "Paused: its owner is deactivated." To bring a paused rule back, fix the cause and press **Switch on** — whoever does becomes its owner.

### How to open a run and what it shows — Automation
Needs: `view` on `automation`.
1. In **Runs** (التشغيلات), or in **Runs of this rule** on a rule's page, click the date and time in **When** (الوقت).
2. The header: **Run** (التشغيل) — its number; **Outcome** (النتيجة); **Rule** (القاعدة) — a link; **Rule version** (إصدار القاعدة); **Event** (الحدث); **About** (بخصوص) — the invoice, task or container, a link to it; **Ran** (وقت التشغيل); **Attempt** (المحاولة); **Ran with the permissions of** (عملت بصلاحيات) — the owner at that moment; **What happened** (ما حدث) — the summary sentence.
3. **What it did** (ما فعلته) — one row per step: **Step** (الخطوة); **Outcome** (النتيجة) — **Done** (تم), **Not done** (لم يُنفَّذ), **Failed** (فشل) or **Done on an earlier attempt** (تم في محاولة سابقة); **Detail** (التفاصيل) — for example "Told 2 people.", "Task TASK-… raised and given out."; **Made** (ما أنشأته) — the number of the task or exception it created.
4. **Conditions checked** (الشروط المفحوصة) — each condition (**When** — متى), what the value actually **Was** (كانت القيمة), and **Met** (متحقق) or **Not met** (غير متحقق).
5. **Then** (ثم) — what the rule was going to do, step by step.
6. **The event as it was recorded** (الحدث كما سُجّل) — **Field** (الحقل) and **Value** (القيمة): the supplier, the amount, the dates, who raised it, days late.
7. A run has no buttons: it is evidence and is never edited or deleted. The four icons are in the title bar.
"The sentences are kept as they were written when the run happened." — the **What happened** and **Detail** sentences are in English on both screens.

### Statuses — Automation
A rule's **State** (الحالة):
- **Off** (متوقفة) — as every rule is born, or switched off by a person. It does nothing.
- **On** (قيد التشغيل) — it acts on each new event it listens for.
- **Paused** (موقوفة مؤقتًا) — the system switched it off after repeated failures or because of its owner; the reason is on its page. It does nothing until a person switches it on again.
- **Failing** (متعثّرة) — a filter and a figure, not a state of its own: rules whose latest events failed, one or more in a row (a rule paused for failing is counted there too).
A run's **Outcome** (النتيجة):
- **Done** (تم) — at least one step was done and none failed. A step the owner could not do is shown as Not done inside the run.
- **Not done** (لم يُنفَّذ) — the rule looked at the event and did nothing: its conditions were not met, the record was one it made itself, or every step was skipped. **What happened** says which.
- **Failed** (فشل) — a step failed. It is tried again after 1 minute, then 10 minutes, then an hour — three attempts in all; a step refused for good is not tried again.
Automation as a whole is **On** or **Off** (the switch in the Status panel).

### Who a rule runs as — Automation
- Every rule has one **Owner** (المالك): the person who last switched it on or last saved a change to it. The rule "runs with their permissions".
- Each time the rule acts, the system asks again whether the owner could do that step by hand at that moment, in that branch. If not, the step is not done and the run says: "Not done: The rule's owner could not do this by hand (… missing), so it is not done for them."
- A person who is told by a rule is checked too: nobody is told about a record they may not open — "None of the 3 people named could open …, so nobody was told."
- A task is raised under the Task Center's own rule of who may assign to whom; if the owner may not give a task to that person, the run fails with "The Task Center refused the task: …".
- If the owner's account is deactivated, or the owner stops administering automation, the rule is paused at its next event.
- A review asked for by a rule cannot be approved by the rule's owner, nor by whoever entered or submitted the invoice.
So before a colleague leaves or changes role, have another administrator open their rules and switch them on again under their own name.

### When rules run — Automation
- Purchase invoice rules: the event is noted the moment the invoice is submitted or posted, and the rules act within about five minutes. The invoice's own submit or post is never delayed or blocked by a rule that is slow or failing.
- Task overdue, Container past its expected arrival and Sales invoice overdue: the system looks once every morning (06:45). So a task that fell due yesterday is acted on this morning, not at midnight.
- A lateness rule acts once on each late record, on the first morning check at which the rule is on and the record is at least the given **Days late** — not again every morning. If the due date or expected date is moved and passed again, that is a new lateness and the rule acts once more.
- On earlier mornings the run is **Not done** with "Conditions not met: daysLate is 2; the rule needs at least 3."
- If a morning's look was missed, the system administrator can run it for that day afterwards, on the server.
- **Events waiting** in the Status panel is what the rules have not taken up yet; more than half an hour of waiting shows in the Control Center.

### How a purchase invoice is held for review — Automation
This is what the template **Purchase invoice over an amount** does.
1. Somebody submits a purchase invoice of the amount or more. Within about five minutes the rule asks for a review; the run's detail reads "<invoice> now waits for a review before it can be posted (it shows in My Approvals)."
2. The role named in the rule is told that the invoice is waiting for review.
3. A second person — an accounting manager who neither entered nor submitted the invoice and is not the rule's owner — opens Dashboard → Home → My Approvals and approves or rejects the review. Rejecting needs a reason and sends the invoice back to Draft; the people who entered and submitted it are told.
4. Approving the review posts nothing. It only lifts the hold; the invoice is then approved and posted on its own page by whoever holds those permissions, as always.
5. Until the review is approved, posting is refused: "A/P invoice <number> is 'submitted': it is waiting for the review an automation rule asked for; a second person approves the review first (My Approvals)."
The hold does not go away when the rule or all automation is switched off: only a person's decision in My Approvals lifts it.

### The four icons on a rule and on a run — Automation
Both pages carry the four icons in the title bar:
1. **Printer** — **Print / Export** (طباعة / تصدير): the rule (its sentences, its versions) or the run (its steps, conditions and recorded event) as PDF, Excel or Word, in English or العربية. PDF needs `print`, Excel and Word need `export`, on `automation`.
2. **Paperclip** — **Attachments** (المرفقات): for example the decision that asked for the rule.
3. **Speech bubble** — **Notes** (الملاحظات): dated, signed notes; only people who administer automation may add one.
4. **Clock** — **Audit log** (سجل التدقيق): who created the rule, changed it, switched it on or off, with the reasons.

### Refusals — Automation
Shown as "That could not be saved." followed by the sentence, always in English. These are met when switching a rule or automation on or off; the ones met while filling a template are in "Refusals in the template window".
- "You could not do any of this rule's actions yourself (… missing), and it runs with your permissions, so it would only ever skip." — you pressed Switch on but hold none of the permissions the rule's steps need. Let somebody who holds them switch it on.
- "You may not open ap invoice records, so a rule on them would act on what you cannot see." (also "task", "shipment container", "ar invoice") — you need `view` on that kind of record to create, edit or switch on a rule about it.
- "There is no role "…"." / "The person named for the task is not an active user." / "There is no active section "…"." — a role, person or section the rule names was removed or deactivated since. Edit the rule and choose another, then switch it on.
- "AUT-003 is already on." / "AUT-003 is already off." — somebody else did it meanwhile; reload the page.
- "Say why the rule is being switched off." — type a reason of at least 3 characters.
- "Say why automation is being switched off." / "Say why automation is being switched on." — the same for the switch in the Status panel.
- "A rule pauses after 1 to 20 failed events in a row." — the pause setting must be a whole number from 1 to 20.
- "There is no automation rule AUT-099." — the rule number does not exist.
- "Permission denied: 'administer' on 'automation' is not granted to this user." — you may read the screen but not change it.
- **Not available to you** (غير متاح لك) — you do not hold `view` on `automation`. Only the CEO and the system administrator do; the menu entry is hidden from everyone else.
- **That page does not exist** (هذه الصفحة غير موجودة) — the rule number or the run number in the address does not exist.
On a purchase invoice held by a rule, the Post button answers: "A/P invoice <number> is 'submitted': it is waiting for the review an automation rule asked for; a second person approves the review first (My Approvals)."

### Refusals in the template window — Automation
When **Create rule** or **Save as a new version** is refused, the window opens again with "That could not be saved." and the sentence. A field is named by the system's own short name: thresholdIqd = Amount from (IQD); minimumAmountIqd = Only invoices from (IQD); daysLate = Days late; notifyRole = Role to tell; severity = Severity; taskAssignee = Task for; taskDepartment = Section the task is raised in; taskTitle = Task title; taskPriority = Task priority; taskDueInDays = Task due in (days); note = the note.
- "A rule's name is 3 to 80 characters."
- "thresholdIqd: required." — and the same with any other required field left empty. Fill it.
- "thresholdIqd: an amount in dinars (digits, at most four decimals)." — type digits only, for example 50000000.
- "thresholdIqd: an amount above zero."
- "daysLate: a whole number." / "daysLate: at least 1." / "daysLate: at most 365."
- "taskDueInDays: at most 60."
- "notifyRole: choose a role." / "taskAssignee: choose a person." / "taskDepartment: choose a section." — pick from the list.
- "taskTitle: 3 to 120 characters." / "note: at most 300 characters."
- "Choose who is told: the person the task is with, their supervisor, or both." — the Task overdue template with neither box ticked.
- "Nothing was changed." — the edit window was saved with the same values; change something or close the window.
- "The note is at most 1000 characters." — shorten **Why it is changed**.
- "Permission denied: 'administer' on 'automation' is not granted to this user."

### What the sentences on a run mean — Automation
A run's **What happened** (ما حدث) and **Detail** (التفاصيل) are written by the system in English. The common ones:
- "Conditions not met: amountIqd is 12000000.0000; the rule needs at least 50000000.0000." — the rule looked and correctly did nothing. Outcome **Not done**.
- "Told 2 people." / "Told 2 people, 1 person left out because they could not open it." — the notification went only to those who may open the record.
- "None of the 3 people named could open <record>, so nobody was told." / "Nobody to tell: …" — nobody in the role may open that record. Check who holds the role.
- "Task TASK-… raised and given out." — the task exists in the Task Center.
- "The Task Center refused the task: …" — the owner may not give a task to that person in that section. It is not tried again; change the rule's person or section.
- "<invoice> now waits for a review before it can be posted (it shows in My Approvals)." / "<invoice> is already waiting for a review."
- "Exception EXC-… raised (high)." / "Exception EXC-… was already open for this record."
- "Not done: The rule's owner could not do this by hand (… missing), so it is not done for them." — the owner lacks a permission for that step.
- "… It will be tried again at 09:15 UTC (attempt 1 of 3)." — a step failed; the system retries after 1, 10 and 60 minutes. "Attempt 3 of 3: the rule gives up on this one." ends it.
- "Not run: this record was made by this rule itself (AUT-…); a rule never acts on what it made, so it cannot start a loop." / "… a chain stops after 2 steps." — a guard against rules feeding each other.
- "Not run: its owner is deactivated. The rule was paused; switching it on again makes the person who does it the owner." — also "its owner no longer exists" and "its owner no longer holds administer on automation".
