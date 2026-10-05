# Master Data — user guide

Master Data is the reference data of the Accounting module (المحاسبة): the records every document refers to and nobody retypes. This guide covers three of its headings.
**Master Data — Financial** (البيانات الرئيسية — المالية): the Chart of Accounts, where each account prints on the four financial statements (Statement Mapping), the currencies and their exchange rates, tax codes, payment terms and payment methods.
**Master Data — Banking** (البيانات الرئيسية — البنوك): the banks the company deals with, and the company's own bank accounts and cash accounts — each tied to one account of the chart.
**Master Data — Organization** (البيانات الرئيسية — الهيكل التنظيمي): branches, departments and cost centres.
The usual order of setting up is: branches and departments first; then the chart of accounts and its statement lines; currencies and a USD rate (nothing can be posted without one); banks, then bank and cash accounts on approved asset accounts of the chart; then tax codes, payment terms and payment methods. After that the documents in Treasury, Payables and Receivables can use them.

## Concepts — Master Data (البيانات الرئيسية)
Path: Accounting → Master Data — Financial / Master Data — Banking / Master Data — Organization   |   Arabic: المحاسبة ← البيانات الرئيسية — المالية / البيانات الرئيسية — البنوك / البيانات الرئيسية — الهيكل التنظيمي
What it is for: the ideas the master-data screens share — codes given by the system, deactivating instead of deleting, the audit log, the search box, and how a refusal reads.

### Codes are given by the system — Master Data
On most master-data screens you do not type the code: the dialog says "The system gives it its code when you save. The code cannot be typed or changed." (يمنحه النظام رمزه عند الحفظ. لا يمكن كتابة الرمز أو تغييره.) The code comes from a numbering series (Settings → Administration → Numbering). The default patterns are: accounts A/L/E/R/X + six digits (A assets, L liabilities, E equity, R revenue, X expenses); tax codes TAX-001; payment terms PT-0001; payment methods PM-0001; banks BNK-0001; bank accounts BANK-000001; cash accounts CASH-000001; departments DEP-0001; cost centres CC-0001. The one exception is a branch: its code may be typed, and if left blank it is made from the name. A code never changes after the record is created.

### Deactivate, never delete — Master Data
A master record that documents have used is never deleted. It is taken out of use with **Deactivate** (إلغاء التفعيل) and a **Reason** (السبب — "Why — this is kept in the audit trail"); it then stops being offered on new documents but stays on old ones. **Reactivate** (إعادة التفعيل) brings it back (every screen here except the Chart of Accounts, which has no reactivate button). The status pill reads **Active** (نشط) or **Inactive** (غير نشط).

### The audit log on a record — Master Data
Every master record's page ends with its history: who created it, every change with the old and new value, and every deactivation with its reason. The **Audit log** (سجل التدقيق) button at the top of the record jumps to it. On a tax code the log is behind the clock icon instead, beside the printer, paperclip and notes icons.

### Searching a list — Master Data
The box **Search this list** (ابحث في هذه القائمة) with the **Search** (بحث) button filters the list to rows containing the text in any column; **Clear** (مسح) shows everything again. The count beside it says how many records are shown.

### How a refusal reads — Master Data
After an action the page shows **Saved.** (تم الحفظ.) or **That could not be saved.** (تعذّر الحفظ.) followed by the reason. On master-data screens the reason usually starts with the name of the field, then a colon, then what is wrong — for example "name: is required" or "reason: is required to deactivate a bank". Fix that field and save again. "Permission denied: '<verb>' on '<object>' is not granted to this user." means your role lacks that permission; ask an administrator.

## Chart of Accounts (دليل الحسابات)
Path: Accounting → Master Data — Financial → Chart of Accounts   |   Arabic: المحاسبة ← البيانات الرئيسية — المالية ← دليل الحسابات
Address: /master-data/chart-of-accounts  (an account's profile: /master-data/chart-of-accounts/<account code>)
Needs: `view` on `chart_of_account` to open the chart and a profile; `create` for New account; `submit` for Submit for approval; `approve` for Approve and Reject (and you must hold the Accounting Manager role) and for setting the control account; `configure` for Edit account, Financial statement mapping, Let it hold sub-accounts and Deactivate; `print` for Print; `export` for Export.
What it is for: the tree of every ledger account of the company. Accounts are opened here, approved before they can take entries, told where to print on each financial statement, and retired when no longer used. Opening an account shows its details, its balance for the year and its latest journals.

### Groups and posting accounts, and the five types — Chart of Accounts
- A **Header account** (حساب رئيسي) — shown in lists as **Group account** (حساب تجميعي) and marked [+] in pickers — only groups other accounts. It holds no balance of its own, takes no entries, and has no statement mapping: it prints the sum of the accounts beneath it.
- A **Posting account** (حساب ترحيل) is the kind journals post to. Nothing can hang beneath it.
- Every account has one of five types: **Assets** (الأصول), **Liabilities** (الالتزامات), **Equity** (حقوق الملكية), **Revenue** (الإيرادات), **Expenses** (المصروفات). The type is never chosen: a new account takes the type of the header it is opened under.
- The account code is given by the system from the type's own series (A… for assets, L… liabilities, E… equity, R… revenue, X… expenses). It is not typed and cannot be changed.
- The chart is company-wide: an account belongs to no single branch.

### How to find an account in the chart — Chart of Accounts
1. Open Accounting → Master Data — Financial → Chart of Accounts.
2. The table shows **Code** (الرمز), **Name** (الاسم), **Type** (النوع), **Group** (مجموعة — Group account or Posting account) and **Status** (الحالة). An approved account that was deactivated also shows "· Inactive".
3. Type part of the code or the name in **Search accounts...** (ابحث في الحسابات...) and press **Search** (بحث); **Clear** (مسح) removes the search.
4. Fold or unfold a header with the small arrow before its code, or use **Expand All** (توسيع الكل) / **Collapse All** (طي الكل).
5. Click a code or a name to open the account's profile. **Previous page** / **Next page** move through a long chart.

### How to open a new account — Chart of Accounts
1. On the chart, press **New account** (حساب جديد).
2. **Under** (تحت): choose the header account the new one sits beneath. The list shows the whole chart as a path with its code; only headers — marked [+] — can be chosen. A posting account in the list says "holds no sub-accounts".
3. Type the **Name** (الاسم).
4. **Kind** (النوع): **Posting account** (حساب ترحيل) to take entries, or **Header account** (حساب رئيسي) to group other accounts.
5. For a posting account, under **Financial statement mapping** (تخطيط القوائم المالية) you may choose a line on each of the four reports — Income Statement, Balance Sheet, Cash Flow Statement, Changes in Equity. Leaving a report on **Default for its type** (الافتراضي حسب نوعه) is allowed: the account then prints where its type says.
6. Optionally type a **Description** (الوصف).
7. Press **Create** (إنشاء). The account gets its code, opens on its own profile, and is a **Draft** (مسودة): it is not active and cannot take entries until it is approved.

### How to send an account for approval, and approve or reject it — Chart of Accounts
1. Open the draft account's profile. A band across the record says **Draft — not yet submitted** (مسودة — لم تُرسل بعد).
2. Press **Submit for approval** (إرسال للموافقة). The status becomes **Pending approval** (بانتظار الموافقة).
3. A user who holds the Accounting Manager role and the approve permission opens the account and presses **Approve** (موافقة). The status becomes **Approved** (معتمد) and the account becomes active in the same step; from now it is offered on journals and documents.
4. To refuse it instead, type the **Reason** (السبب) and press **Reject** (رفض). The status becomes **Rejected** (مرفوض). A rejected account has no further button on its page; open a new account with the corrected details.
5. Every decision is listed under **Approvals** (الموافقات) and in the **Audit timeline** (الخط الزمني للتدقيق) on the profile.

### How to open an account profile and read it — Chart of Accounts
1. Click the account in the chart. The page title is the code and the name.
2. **Account Details** (تفاصيل الحساب): the name, code and status; then Code, Type, **Parent Account** (الحساب الأب — a link), Group (Group account / Posting account), Active (Active / Inactive), the line it prints on for each of the four reports (or "Default for its type"), and **Control account** (حساب تحكم) when it is one.
3. **Recent Journals** (القيود الأخيرة): the eight latest postings — Posting Date, entry number (opens the journal), description, debit, credit.
4. **Balance Summary** (ملخص الرصيد), in IQD for the current year: **Opening Balance** (الرصيد الافتتاحي — the balance before 1 January), **Total Debits** (إجمالي المدين) and **Total Credits** (إجمالي الدائن) of the year, and **Closing Balance** (الرصيد الختامي). **Open in the General Ledger** (فتح في دفتر الأستاذ العام) shows every line.
5. Below: the status band and action buttons, then **Status** (owner, created, last changed, the header it sits under), **Approvals**, **Related documents** (its sub-accounts), **Journal entries** and the **Audit timeline**.
6. A header account shows no journals and no balance of its own.

### How to change an account's name, statement lines or control role — Chart of Accounts
1. **Edit account** (تعديل الحساب): change the **Name** and the **Description** and press **Save** (حفظ). These are the only typed details of an account; the code, type and parent do not change.
2. **Financial statement mapping** (تخطيط القوائم المالية) — posting accounts only: choose the line for each report, or **Default for its type**, and press **Save**. Header lines, totals and computed lines cannot be chosen. A revenue or expense account cannot be put on a Cash Flow line (it is already inside Net Income). The change affects how the statements read from that moment.
3. **Control account** (حساب تحكم) — posting accounts only, needs the approve permission: choose **Not a control account** (ليس حساب رقابة) or the subledger it controls — Customer (العملاء), Supplier (الموردون), Inventory (المخزون), Bank (البنوك), Fixed asset (الأصول الثابتة), Project (المشاريع), Service (الخدمات), Loans (القروض) — and press **Save**. The change applies to future postings only.

### What a control account is — Chart of Accounts
A control account is the ledger side of a subledger: the customer control account carries what customers owe, the supplier one what is owed to suppliers, the inventory one the stock value, the loan one the bank loans. It is posted by the source documents (invoices, receipts, payments, stock movements, loan postings), not by hand: a manual journal to it is refused unless a Finance Manager approves it. Because of that a control account is not offered as the credit account of a Manual Deposit, as the other account of a bank-reconciliation adjustment, or as a tax account; and a bank or cash account can only be linked to an asset account that is not a control account (or is the Bank one). Customer and supplier control accounts feed the customer and supplier statements.

### Currency and required dimensions of an account — Chart of Accounts
- Currency: the ledger is kept in Iraqi dinars. A posting account opened on this screen holds IQD and the dialog does not ask for a currency; a header account has none. The currency of an account cannot be changed on its profile. An entry in another currency on such an account is refused with "Cannot post to <code>: it accepts IQD only, and this entry is in <currency>".
- Required dimensions: an account can require that every posting to it carries certain details — branch, department, business line, project, warehouse, business partner or employee. The rule is normally set on a header and inherited by the accounts under it. A posting that lacks one is refused with "Account <code> requires <dimension>. Supply the missing value(s) and post again." The account profile has no control for setting these rules.

### How to let an account hold sub-accounts — Chart of Accounts
1. Open a posting account's profile. The **Sub-accounts** (الحسابات الفرعية) panel explains that nothing can hang beneath a posting account.
2. Press **Let it hold sub-accounts** (اجعله يحمل حسابات فرعية). The account becomes a header: it loses its currency and its statement lines and can now be chosen under **Under** when opening a new account.
3. This works only while the account has never been posted to. If it has postings, open the new sub-accounts beside it instead and stop using it.

### How to deactivate an account — Chart of Accounts
1. On an active account's profile, in the **Deactivate** (إيقاف) panel, type the **Reason** and press **Deactivate**.
2. The account stays in the system and on old entries; it simply stops accepting new ones. A header cannot be deactivated while it still has active accounts beneath it.
3. The profile offers no button to reactivate an account, so deactivate only when you are sure.

### How to print or export — Chart of Accounts
1. On the chart, **Export** (تصدير) downloads the accounts as a CSV file — the same rows the list shows for your search.
2. On an account's profile, **Print** (طباعة) opens the **Account Statement** (كشف حساب) in a new tab: the account's facts, the year's opening balance, movement and closing balance, and this year's postings. Use the browser's print to print it or save it as PDF.
3. On an account's profile, **Export** (تصدير) downloads every posting of the account as a CSV file.

### Fields — Chart of Accounts
New account (حساب جديد):
- **Under** (تحت) — required; an active header account. Decides where the account sits and its type.
- **Name** (الاسم) — required.
- **Kind** (النوع) — **Posting account** (default) or **Header account**. "A header groups other accounts; a posting account takes entries."
- **Income Statement / Balance Sheet / Cash Flow Statement / Changes in Equity** (قائمة الدخل / الميزانية العمومية / قائمة التدفقات النقدية / التغيرات في حقوق الملكية) — optional, posting accounts only; default **Default for its type**. The lines offered are those built on Statement Mapping.
- **Description** (الوصف) — optional.
On the profile:
- **Name**, **Description** — Edit account.
- the four statement lines — Financial statement mapping.
- **Control account** (حساب تحكم) — Not a control account, or one of the eight subledgers.
- **Reason** (السبب) — required for Deactivate and for Reject.
Not on any form: the code (given by the system), the type (taken from the parent), the currency (IQD for a posting account).

### After you save — Chart of Accounts
Statuses: **Draft** (مسودة) → **Pending approval** (بانتظار الموافقة) after Submit for approval → **Approved** (معتمد) or **Rejected** (مرفوض).
A new account is a draft and inactive. Approval makes it approved and active together; only an account that is approved, active and a posting account is offered on journals, bank and cash accounts, tax codes, payment-method fees, deposits and adjustments.
Opening or changing an account posts nothing to the ledger. Every step — created, submitted, approved, rejected, renamed, statement lines changed, control role changed, converted to a header, deactivated — is written in the audit timeline with who did it and when.

### Refusals — Chart of Accounts
- "This account cannot sit there: <code> is a posting account, so it cannot hold children. Convert it to a group first, which is only possible while it has no transactions." — choose a header under **Under**, or first press Let it hold sub-accounts on that account.
- "This account cannot sit there: <code> is inactive. Reactivate it before adding accounts beneath it." — choose an active header.
- "This account cannot sit there: a header account carries no statement mapping of its own; it prints the sum of the accounts beneath it" — do not choose statement lines for a header.
- "This account cannot sit there: An account needs a name." — type the name.
- "This step is approved by 'accounting_manager'. You do not hold that role." — approving an account needs the Accounting Manager role as well as the approve permission; ask a user who holds that role, or have the role given under Settings → Administration → Users.
- "'<action>' is not available while this document is '<status>'. … Refresh the record to see the actions that are available now." — the account's status changed since the page was opened; reload it.
- "This account cannot sit there: <code> has <n> postings against it, so it holds a balance of its own and cannot become a header. Open the sub-accounts beside it instead, and stop using this one." — on Let it hold sub-accounts.
- "This account cannot sit there: <code> already holds sub-accounts." — it is already a header.
- "<code> still has <n> active child account(s). Deactivate them first." — on Deactivate of a header.
- "<code> is a group account. A group summarises its children and has no balance of its own to reconcile a subledger against; the control account is the posting account beneath it." — set the control role on a posting account.
- "The <type> account counter is a hundred numbers behind the chart. Set it past the highest code in use before raising another account." — the numbering series is behind; an administrator corrects it on Settings → Administration → Numbering.
- When posting elsewhere: "Cannot post to <code>: it is still 'draft'. An account accepts entries only once the Accounting Manager has approved it." — submit and approve the account. "Cannot post to <code>: the account is inactive. …" — use another account. "Cannot post to <code>: it is a group account. …" — post to a posting account beneath it. "Cannot post to <code>: it is the <subledger> control account. Direct manual posting requires Finance Manager approval; ordinarily it is posted by the source document, not by hand." — use the proper document instead of a manual journal.

## Statement Mapping (تخطيط القوائم المالية)
Path: Accounting → Master Data — Financial → Statement Mapping   |   Arabic: المحاسبة ← البيانات الرئيسية — المالية ← تخطيط القوائم المالية
Address: /master-data/statement-mapping  (one tab per report: ?statement=income-statement, balance-sheet, cash-flow, changes-in-equity)
Needs: `view` on `financial_statement` to open; `configure` on `financial_statement` for New line, the up and down arrows, Edit and Remove.
What it is for: building the layout of the four financial statements — the headers and lines each report prints, in the order it prints them. Accounts are attached to these lines on the account itself (Chart of Accounts); this screen is where the lines exist.

### How to read the layout of a report — Statement Mapping
1. Open Accounting → Master Data — Financial → Statement Mapping.
2. Press the button of the report to work on: **Income Statement** (قائمة الدخل), **Balance Sheet** (الميزانية العمومية), **Cash Flow Statement** (قائمة التدفقات النقدية) or **Changes in Equity** (التغيرات في حقوق الملكية).
3. The table lists the report's rows in printing order, indented under their headers: **Line** (البند); **Kind** (النوع) — **Header** (عنوان), **Line** (بند), **Total** (إجمالي), **Computed** (محتسب), or on the cash-flow tab **Cash and equivalents** (النقد وما يعادله); on the Balance Sheet the column is **Side** (الجانب) — Assets, Equity or Liabilities; **Accounts** (الحسابات) — how many accounts of the chart report on that line ("—" for headers, totals and computed lines); and **Actions**.
4. **Expand All** / **Collapse All** fold the headers.

### How to add a line or a header — Statement Mapping
1. On the report's tab, press **New line** (بند جديد).
2. Type the **Name** (الاسم).
3. Choose the **Kind** (النوع): **Line — takes accounts** (بند — يستقبل الحسابات), **Header — groups lines** (عنوان — يجمع البنود), or **Total — adds up the lines above it** (مجموع — يجمع البنود التي فوقه).
4. Choose **Under** (تحت): a header of the same report, or **Top level** (المستوى الأعلى).
5. On the Balance Sheet, choose the **Side** (الجانب): Assets (الأصول), Equity (حقوق الملكية) or Liabilities (الالتزامات) — required for lines and headers.
6. On the Cash Flow Statement, for a line, choose **Cash and equivalents** when the accounts on this line are the cash the statement explains; otherwise leave "—".
7. Press **Save** (حفظ). The new line is placed last under its header; move it with the arrows.

### How to reorder, edit or remove a line — Statement Mapping
1. **▲** and **▼** on a row move it up or down among the rows printed beside it under the same header.
2. **Edit** (تعديل) opens the same dialog to change the name, the kind, the header it sits under, the side or the cash flag. A line whose figure is worked out from the ledger shows its kind as **Worked out from the ledger** (يُحتسب من السجلات); it can be renamed and moved but its kind cannot be changed.
3. **Remove** (حذف) deletes the line at once. It is refused while the line still has lines beneath it or an account still reports on it.

### Fields — Statement Mapping
- **Name** (الاسم) — required; what the report prints.
- **Kind** (النوع) — Line (takes accounts; the default), Header (groups lines; takes no accounts) or Total (adds up the lines above it).
- **Under** (تحت) — optional; a header of the same report; default Top level. The layout nests at most four levels.
- **Side** (الجانب) — Balance Sheet only; Assets, Equity or Liabilities. A line can only sit under a header of the same side.
- **Cash and equivalents** (النقد وما يعادله) — Cash Flow Statement lines only; "—" or Cash and equivalents.

### After you save — Statement Mapping
There is no status and no approval: a change takes effect at once on the financial statement it belongs to, and the line becomes available in the statement pickers on the Chart of Accounts. Nothing is posted. Every change is written to the audit trail.

### Refusals — Statement Mapping
- "name: is required" — type the name.
- "A Balance Sheet line names its side — assets, equity or liabilities — so the statement knows where to print it." — choose the Side.
- "'<header>' is on the <side> side — a <side> line cannot sit under it." — choose a header of the same side, or change the side.
- "A line sits under a header. Choose one, or leave it at the top level." — the row chosen under **Under** is not a header.
- "The layout nests at most 4 levels deep." — place the line higher.
- "'<line>' already sits beneath '<moving line>', so '<moving line>' cannot be put under it." — a header cannot be moved under one of its own lines.
- "Account <code> reports on '<line>', so it cannot become a header. Move the account to another line first." — change the account's statement line on its profile first.
- "'<line>' still has lines beneath it, so it is a header. Move or remove those first." — when changing a header into a line.
- "'<line>' still has lines beneath it — remove or move those first." — on Remove.
- "Account <code> still reports on '<line>' — move it to another line first." — on Remove; change that account's statement line on Chart of Accounts.
- "'<line>' is worked out from the ledger, and the statement needs it to reach the same equity the Balance Sheet shows. It can be renamed and moved, but not removed." — this line cannot be removed.

## Currencies and Rates (العملات وأسعار الصرف)
Path: Accounting → Master Data — Financial → Currencies and Rates   |   Arabic: المحاسبة ← البيانات الرئيسية — المالية ← العملات وأسعار الصرف
Address: /master-data/exchange-rates
Needs: `view` on `exchange_rate` to open; `create` on `exchange_rate` for Publish a rate, Add currency, Retire and Reactivate.
What it is for: the list of currencies the company uses and the accounting exchange rates every posting is measured at. The page is titled **Accounting rates** (أسعار الصرف المحاسبية). The ledger is kept in IQD, and every entry is also measured in USD, so nothing can be posted until a USD rate exists.

### How to add a rate from a date — Currencies and Rates
1. Open Accounting → Master Data — Financial → Currencies and Rates and press **Publish a rate** (نشر سعر).
2. Choose the **Currency** (العملة) — USD by default; the ledger currency (IQD) and retired currencies are not offered.
3. Type the **Rate** (السعر): how many IQD one unit of the currency is worth (for example 1310 for one US dollar). It must be more than zero.
4. Set **Effective from** (ساري من): the first day the rate applies. It defaults to 1 January of this year — change it to the real date.
5. **Source** (المصدر) says where the figure came from; it is filled with "Central Bank of Iraq" and may be changed.
6. Press **Publish** (نشر). The rate appears under **In force** (الساري) if its date has arrived, otherwise under **Also published** (أسعار منشورة أخرى) as **Takes effect later** (يبدأ لاحقًا).

### How a rate is chosen for a document — Currencies and Rates
- A document uses the latest rate whose Effective from is on or before the document's date. Publishing a later rate does not change earlier documents: last month's entries stay at last month's rate.
- If every rate of the currency is dated after the document, the earliest rate is used.
- If the currency has no rate at all, the document is refused: "No <currency> exchange rate has been published yet, so this cannot be valued. Add one in Accounting → Master Data → Currencies and Rates."
- The rate is never typed on a document; it is always read from this screen by date.
- **In force** shows, per currency, the rate applying today — "the figure a journal posted now would use". **Also published** lists the other live rates: **A later rate applies now** (يطبَّق سعر أحدث الآن) for an older rate, **Takes effect later** for a future one.

### Rate types — Currencies and Rates
This screen publishes one kind of rate: the accounting rate, the one the ledger and every posting use. The dialog has no rate-type field. A published rate cannot be edited or deleted on this screen; to change the rate from a day onward, publish a new rate with that day as Effective from.

### How to add, retire or reactivate a currency — Currencies and Rates
1. Press **Add currency** (إضافة عملة). "A currency has to exist here before a rate can be published for it, or an account held in it."
2. Type the **Currency code** (رمز العملة) — three letters, such as EUR, AED, TRY — and the **Name** (الاسم). **Symbol** (الرمز) is optional (€, £, ₺). **Decimals** (الخانات العشرية) is the number of digits after the point when amounts are shown, 0 to 6, default 2.
3. Press **Add currency**. It appears in the **Currencies** (العملات) table as **Active**, and can now be chosen in the rate dialog, on bank and cash accounts and on documents. Publish a rate for it before using it.
4. **Retire** (إيقاف) on a currency's row stops it being offered on new records; nothing already posted changes. **Reactivate** (إعادة التفعيل) brings it back. IQD and USD have no Retire button — every posting is measured in them.

### Fields — Currencies and Rates
Publish a rate (نشر سعر):
- **Currency** (العملة) — required; an active currency other than IQD; default USD.
- **Rate** (السعر) — required; IQD per one unit; more than zero; up to eight decimals.
- **Effective from** (ساري من) — required date; "It applies from this date until a later rate supersedes it. The earliest rate also covers anything posted before it."
- **Source** (المصدر) — optional; default "Central Bank of Iraq".
Add currency (إضافة عملة):
- **Currency code** (رمز العملة) — required; exactly three letters.
- **Name** (الاسم) — required.
- **Symbol** (الرمز) — optional, up to four characters; shown in lists only.
- **Decimals** (الخانات العشرية) — 0 to 6; default 2.
Tables on the page: **Currencies** — Currency, Name, Symbol, Decimals, State; **In force** — Currency, Rate, Effective from, Source, Entered by; **Also published** — Currency, Rate, Effective from, State, Source.

### After you save — Currencies and Rates
There is no approval: a published rate applies at once to every document dated on or after its Effective from (until a later rate takes over). Nothing is posted by publishing a rate, and documents already posted keep the rate they were measured at. When no rate exists the page says **No rate has been published yet.** (لم يُنشر أي سعر بعد.) and explains that nothing can be posted until a USD rate exists.

### Refusals — Currencies and Rates
- "Exchange rate must be positive, received <value>" — type a rate above zero.
- A message containing `duplicate key value violates unique constraint "exchange_rate_live_uniq"` — a rate for the same currency and the same Effective from date already exists. A published rate cannot be replaced from this screen: publish the new figure with a different Effective from date.
- "Invalid currency code: <code>. Expected three uppercase letters." — the code must be three letters.
- "Decimals must be a whole number between 0 and 6." — correct the decimals.
- A "duplicate key" message when adding a currency — the code already exists in the Currencies table; reactivate it instead.
- "<code> cannot be retired: every posting is measured in it." — IQD and USD cannot be retired.

## Tax Codes (رموز الضرائب)
Path: Accounting → Master Data — Financial → Tax Codes   |   Arabic: المحاسبة ← البيانات الرئيسية — المالية ← رموز الضرائب
Address: /master-data/tax-codes  (a record: /master-data/tax-codes/<tax code>)
Needs: `view` on `tax_code` to open the list and a record; `create` on `tax_code` for New tax code; `configure` on `tax_code` for Change, Add rate, Deactivate, Reactivate and for adding a note; `create` on `attachment` to attach a file; `print` / `export` on `tax_code` for the printer icon.
What it is for: the reusable tax settings documents refer to — the code, whether it is tax on purchases or on sales, whether it is recoverable, the ledger account it posts to, and its rate from each date. Rates are never typed into individual invoices.

### How to create a tax code — Tax Codes
1. Open Accounting → Master Data — Financial → Tax Codes and press **New tax code** (رمز ضريبي جديد).
2. Type the **Name** (الاسم).
3. Choose the **Treatment** (المعالجة): **Input (purchases)** (مدخلات (مشتريات)) or **Output (sales)** (مخرجات (مبيعات)).
4. Choose **Recoverable** (قابلية الاسترداد): **Recoverable** (قابلة للاسترداد) or **Not recoverable (a cost)** (غير قابلة للاسترداد (كلفة)).
5. Choose the **G/L account** (حساب الأستاذ) the tax posts to — an active, approved posting account that is not a control account.
6. Type the first **Rate** (النسبة) as a percentage, such as 15 or 2.5, and its **Effective from** (تسري من) date (today by default).
7. Press **Create tax code** (إنشاء الرمز). The system gives the code (TAX-001, TAX-002, …) and opens its record.

### How to add a new rate from a date — Tax Codes
1. Open the tax code (click its code in the list) and press **Add rate** (إضافة نسبة).
2. Type the **Rate** and the **Effective from** date and press **Add rate**.
3. Documents dated on or after that date use the new rate; documents dated earlier keep the rate they had. A rate already written is never changed or removed — to correct one, add another from a different date.
4. The **Rates** (النسب) grid lists every rate, newest first, with who added it and when; **Rate today** (نسبة اليوم) shows the one in force now.

### How to change, deactivate or reactivate a tax code — Tax Codes
1. **Change** (تعديل) opens the name, treatment, recoverability and G/L account; press **Save** (حفظ). The rate is not changed here — use Add rate.
2. To stop a code being used, type the **Reason for deactivating** (سبب الإيقاف) and press **Deactivate** (إلغاء التفعيل). Its status then reads **Cancelled** (ملغى).
3. **Reactivate** (إعادة التفعيل) on a deactivated code puts it back in use; its status reads **Active** (نشط).
4. The icons at the top of the record: printer (the tax code as PDF, Excel or Word, in English or Arabic), paperclip (attach the tax authority's letter or the rate notice), notes, and clock (audit log).

### How to search and filter the list — Tax Codes
1. Search box: any text in the code, the name, the G/L account's code or name, or the rate.
2. **View** (العرض): **All tax codes** (كل الرموز), **Input** (مدخلات), **Output** (مخرجات) — active codes of that treatment — or **Inactive** (غير فعّالة). Press **Filter** (تصفية).
3. Columns: Code, Name, Treatment, Recoverable, G/L account, **Rate today**, Status.

### Fields — Tax Codes
- **Name** (الاسم) — required.
- **Treatment** (المعالجة) — required; Input (purchases) or Output (sales).
- **Recoverable** (قابلية الاسترداد) — required; Recoverable (the tax can be claimed back — it is an asset) or Not recoverable (a cost).
- **G/L account** (حساب الأستاذ) — required; an active, approved posting account, not a control account. One account cannot serve both a recoverable and a non-recoverable tax code.
- **Rate** (النسبة) — required; a percentage from 0 to 100 with up to six decimals ("A percentage, such as 15 or 2.5.").
- **Effective from** (تسري من) — required date; one rate per date.
- **Reason for deactivating** (سبب الإيقاف) — required to deactivate.
Shown on the record: Code, Status, Name, Treatment, Recoverable, G/L account (opens the account), Rate today, Created by.

### After you save — Tax Codes
A tax code is in use as soon as it is created — there is no approval step. Status is **Active** (نشط) or, after deactivation, **Cancelled** (ملغى). Nothing is posted by creating or changing a tax code; a document that uses the code asks for the rate in force on its own date. Every change is in the audit log behind the clock icon.

### Refusals — Tax Codes
- "name: is required" — type the name.
- "rate: is a percentage, such as 15 or 2.5" — type digits only, at most six decimals.
- "rate: is at most 100%" — lower the rate.
- "account: <code> is not an active, approved posting account" — choose an approved, active posting account (approve it on Chart of Accounts first).
- "account: <code> already carries <tax code>, a non-recoverable tax; one account cannot hold both (§4.3)" (or "a recoverable tax") — use a different account for this code.
- "effectiveFrom: <tax code> already has a rate from <date>; a rate is never changed, add one from another date" — choose another date.
- "effectiveFrom: is a date" — fill the date.
- "reason: is required to deactivate a tax code" — type the reason.

## Payment Terms (شروط الدفع)
Path: Accounting → Master Data — Financial → Payment Terms   |   Arabic: المحاسبة ← البيانات الرئيسية — المالية ← شروط الدفع
Address: /master-data/payment-terms  (a record: /master-data/payment-terms/<code>)
Needs: `view` on `payment_term` to open the list and a record; `create` for New payment term; `configure` for the Update panel; `administer` for Deactivate and Reactivate.
What it is for: when an invoice falls due and what an early settlement is worth. A payment term is set on a customer or supplier and gives every invoice its due date.

### How to create a payment term — Payment Terms
1. Open Accounting → Master Data — Financial → Payment Terms and press **New payment term** (شرط دفع جديد).
2. Type the **Name** (الاسم) — for example "30 days".
3. **Due date counted from** (يُحتسب الاستحقاق من): **The document date** (تاريخ المستند) or **The end of the month** (نهاية الشهر).
4. **Days to pay** (أيام السداد): the number of days after that date; 0 by default.
5. Press **Create** (إنشاء). The system gives the code (PT-0001, …) and opens the record. Early-settlement discount and instalments are set on the record.

### How to set a discount or instalments, and check the due date — Payment Terms
1. Open the term and use the **Update** (تحديث) panel.
2. Early settlement: type **Discount %** (نسبة الخصم %) and **Discount within days** (الخصم خلال أيام) — both, or neither.
3. **Instalments** (الأقساط): for a term that falls due in parts, fill one row per part — **Days after** (بعد كم يوم) and **Percentage** (النسبة). The rows must total 100%. Leave every row blank for a term that falls due once. Two spare rows are always shown; save and reopen to get more.
4. Press **Save** (حفظ).
5. Check the result in **What this term does** (ماذا يفعل هذا الشرط): set **An invoice dated** (فاتورة بتاريخ) and press **Run** (عرض); **Falls due** (تستحق في) shows the due date worked out by the same rule invoices use.
6. **Partners on these terms** (الأطراف على هذه الشروط) lists the customers and suppliers using the term; each opens the partner.

### How the due date is worked out — Payment Terms
- Counted from The document date: due date = document date + Days to pay.
- Counted from The end of the month: due date = last day of the document's month + Days to pay.
- With instalments: each part falls due on the starting date + its Days after, for its Percentage of the invoice; the last part takes any rounding; Days to pay is ignored and the term's due date is the last instalment's date.
- A document with no payment term falls due on its own date.

### How to deactivate or reactivate a payment term — Payment Terms
1. On the record, in **Deactivate this payment term** (إلغاء تنشيط شرط الدفع), type the **Reason** and press **Deactivate** (إلغاء التفعيل).
2. It is refused while an active partner still has this term; change the partner's payment term first.
3. **Reactivate** (إعادة التفعيل) brings it back.

### Fields — Payment Terms
- **Name** (الاسم) — required.
- **Due date counted from** (يُحتسب الاستحقاق من) — The document date (default) or The end of the month. "The date the clock starts on."
- **Days to pay** (أيام السداد) — whole days, 0 to 3650; default 0. "For a term that falls due once. Ignored when instalments are set."
- **Discount %** (نسبة الخصم %) — optional; above 0 and at most 100.
- **Discount within days** (الخصم خلال أيام) — optional; whole days. "Both a percentage and a number of days, or neither."
- Instalment rows: **Days after** (بعد كم يوم) — whole days, 0 to 3650; **Percentage** (النسبة) — the rows total 100%.
List columns: Code, Name, Due date counted from, Days to pay, **Early settlement** (السداد المبكر — "x% within n days" or "—"), Active.

### After you save — Payment Terms
A payment term is active as soon as it is created; there is no approval. It can then be chosen on customers and suppliers. Changing a term posts nothing. Every change and deactivation is in the audit log on the record.

### Refusals — Payment Terms
- "name: is required" — type the name.
- "dueDays: must be a whole number of days between 0 and 3650" — correct Days to pay (the same message with "daysAfter" or "discountDays" names the other day fields).
- "discount: needs both a percentage and a number of days, or neither" — fill both discount fields or clear both.
- "discountPercent: must be greater than 0 and at most 100" — correct the discount.
- "<code> instalments total <x>%, not 100%. Every part of the invoice must fall due on some date." — make the percentages add up to 100.
- "reason: is required to deactivate a payment term" — type the reason.
- "code: is still the payment term of partner <partner code>" — give that customer or supplier another payment term, then deactivate.

## Payment Methods (طرق الدفع)
Path: Accounting → Master Data — Financial → Payment Methods   |   Arabic: المحاسبة ← البيانات الرئيسية — المالية ← طرق الدفع
Address: /master-data/payment-methods  (a record: /master-data/payment-methods/<code>)
Needs: `view` on `payment_method` to open the list and a record; `create` for New payment method; `configure` for the Update panel; `administer` for Deactivate and Reactivate.
What it is for: how money is received and paid — cash, transfer, cheque. The method is what a person picks on a payment; beneath it are the channel the money moves through, what proves the payment, and any fee.

### How to create a payment method — Payment Methods
1. Open Accounting → Master Data — Financial → Payment Methods and press **New payment method** (طريقة دفع جديدة).
2. Type the **Name** (الاسم) — for example "Cheque" or "Bank transfer".
3. **Settles through** (تُسدَّد عبر): **A bank account** (حساب بنكي), **A cash account** (حساب نقدي) or **A money transfer** (حوالة مالية). A cheque is a bank method.
4. **Proved by** (يُثبت بـ): what the accountant enters when the payment is confirmed — **SWIFT copy (MT103)** (نسخة السويفت (MT103)), **Transfer reference** (مرجع الحوالة), **Signed cash voucher** (سند صرف نقدي موقّع) or **Cheque number** (رقم الصك).
5. Press **Create** (إنشاء). The system gives the code (PM-0001, …) and opens the record.

### How to set a fee, change or deactivate a payment method — Payment Methods
1. Open the method and use the **Update** (تحديث) panel to change the name, Settles through and Proved by.
2. If the method costs a percentage, type the **Fee** (الرسم) and choose **Fee posts to** (يُقيَّد الرسم في) — the posting account the fee is booked to; with a fee, the account is required. Leave the fee blank when the method costs nothing.
3. Press **Save** (حفظ).
4. To retire the method: in **Deactivate this payment method** (إلغاء تنشيط طريقة الدفع) type the **Reason** and press **Deactivate**. **Reactivate** brings it back.

### Fields — Payment Methods
- **Name** (الاسم) — required.
- **Settles through** (تُسدَّد عبر) — A bank account (default), A cash account, or A money transfer.
- **Proved by** (يُثبت بـ) — SWIFT copy (MT103), Transfer reference (default), Signed cash voucher, or Cheque number.
- **Fee** (الرسم) — optional, on the record; a percentage of the amount, 0 to 100.
- **Fee posts to** (يُقيَّد الرسم في) — on the record; a posting account; required when a fee is charged; **No fee charged** (لا يوجد رسم) otherwise.
List columns: Code, Name, Settles through, Proved by, Fee (percentage · account code, or "—"), Active.

### After you save — Payment Methods
A payment method is active as soon as it is created; there is no approval and nothing is posted. Every change is in the audit log on the record.

### Refusals — Payment Methods
- "name: is required" — type the name.
- "feePercent: must be between 0 and 100" — correct the fee.
- "feeAccountId: is required when a fee is charged" — choose Fee posts to, or clear the fee.
- "feeAccountId: is a header, not a posting account" — choose a posting account.
- "reason: is required to deactivate a payment method" — type the reason.

## Banks (البنوك)
Path: Accounting → Master Data — Banking → Banks   |   Arabic: المحاسبة ← البيانات الرئيسية — البنوك ← البنوك
Address: /master-data/banks  (a record: /master-data/banks/<bank code>)
Needs: `view` on `bank` to open the list and a record; `create` on `bank` for New bank; `configure` on `bank` for the Update panel, Deactivate and Reactivate.
What it is for: the list of banks the company deals with — Mansour, Arab, NBI, Rafidain and any other. A bank is named once; the company's bank accounts, bank loans and suppliers' bank accounts point to it.

### How to add a bank — Banks
1. Open Accounting → Master Data — Banking → Banks and press **New bank** (بنك جديد).
2. Type the **Name** (الاسم).
3. **SWIFT / BIC** (سويفت / BIC): 8 or 11 characters, e.g. MBIVIQBAXXX; leave blank if not known yet.
4. **Country** (الدولة): two letters — IQ, AE, CN; IQ is filled in.
5. Press **Create** (إنشاء). The system gives the code (BNK-0001, …) and opens the record.
A bank can also be added while entering a new bank loan, by choosing "Another bank — I will type its name" there.

### How to open, change or deactivate a bank — Banks
1. Click the bank's code in the list. The record shows the name, code and status; **Details** (التفاصيل) with SWIFT / BIC and Country; and **Accounts** (الحسابات) — the company's accounts held with this bank (code, name, account number, currency, active), each opening the bank account.
2. Use the **Update** (تحديث) panel to change the name, SWIFT / BIC or country, then **Save** (حفظ).
3. To retire the bank: in **Deactivate this bank** (إلغاء تنشيط هذا البنك) type the **Reason** and press **Deactivate**. An inactive bank is no longer offered on new bank accounts or loans. **Reactivate** brings it back.

### Fields — Banks
- **Name** (الاسم) — required.
- **SWIFT / BIC** (سويفت / BIC) — optional; 8 or 11 characters (four letters for the bank, two for the country, two for the place, and an optional three for the branch). No two banks may share one.
- **Country** (الدولة) — two letters; default IQ.
List columns: Code, Name, SWIFT / BIC, Country, Accounts (how many company accounts are held with it), Active.

### After you save — Banks
A bank is active as soon as it is created; there is no approval and nothing is posted. Every change is in the audit log on the record.

### Refusals — Banks
- "name: is required" — type the name.
- "swiftBic: is 8 or 11 characters: four letters for the bank, two for the country, two for the place, and an optional branch" — correct the SWIFT code or leave it blank.
- "swiftBic: <SWIFT> is already <bank code>" — that bank already exists; use it.
- "country: is a two-letter country code (IQ, CN, AE)" — type two letters.
- "reason: is required to deactivate a bank" — type the reason.

## Bank Accounts (الحسابات البنكية)
Path: Accounting → Master Data — Banking → Bank Accounts   |   Arabic: المحاسبة ← البيانات الرئيسية — البنوك ← الحسابات البنكية
Address: /master-data/bank-accounts  (a record: /master-data/bank-accounts/<account code>)
Needs: `view` on `bank_account` to open the list and a record; `create` on `bank_account` for New bank account; `configure` on `bank_account` for the Update panel; `administer` on `bank_account` for Deactivate and Reactivate; `print` / `export` on `bank_account` for Print / Export.
What it is for: the company's own bank accounts and the ledger account each one is carried in. Payments, receipts, transfers, loans and bank reconciliations all name one of these accounts. An account belongs to the company, not to a branch.

### How to create a bank account — Bank Accounts
1. First make sure an asset posting account for it exists and is approved on Chart of Accounts — one ledger account per bank account.
2. Open Accounting → Master Data — Banking → Bank Accounts and press **New bank account** (حساب بنكي جديد).
3. Type the **Name** (الاسم).
4. Choose the **G/L account** (الحساب في دليل الحسابات): only active, approved posting accounts under Assets that no other bank or cash account uses are offered.
5. Choose the **Currency** (العملة) — IQD by default; the account can only hold this currency.
6. Choose the **Bank** (البنك) from the Banks list, and optionally type **Bank name / branch** (اسم البنك / الفرع); left blank, it is filled with the bank's name.
7. Type the **Account number** (رقم الحساب) — the real number the bank assigned.
8. Press **Create** (إنشاء). The system gives the code (BANK-000001, …) and opens the record. IBAN, SWIFT, statement format and approval limit are set on the record.

### How to open a bank account and read what it holds — Bank Accounts
1. Click the account's code in the list.
2. Left: the name, code and status; **Details** (التفاصيل) — G/L account (opens the ledger account), Currency, Bank (opens the bank), Bank name / branch, Account number, IBAN, SWIFT, Statement format, Approval limit.
3. **What this account holds** (ما يحتفظ به هذا الحساب): **Holds now** (الرصيد الحالي — the ledger balance today); **Received in <year>** (المقبوض) and **Paid out in <year>** (المدفوع) — real money in and out this year; **Pending debit** (مدين معلّق — money promised to approved transfers and payments not yet sent); **Held at the start of <year>**; **Available to pay with** (المتاح للدفع — the balance less the pending debit); **Last movement** (آخر حركة); and, when there were any, **Moved in from our own accounts** / **Moved out to our own accounts**. The figures are the ledger's — the same as Bank and Cash Reporting.
4. **See every transaction** (عرض كل الحركات) opens Bank and Cash Reporting for this account.
5. **Print / Export** (طباعة / تصدير) at the top gives the account's statement as PDF, Excel or Word; **Audit log** (سجل التدقيق) jumps to the history at the foot.

### How to change, re-link, deactivate or reactivate a bank account — Bank Accounts
1. Use the **Update** (تحديث) panel on the record: Name, G/L account, Currency, Bank, Bank name / branch, Account number, IBAN, SWIFT, Statement format, Approval limit. Press **Save** (حفظ).
2. If the list shows **No G/L account — the account it named is gone. Choose one.** (لا يوجد حساب أستاذ) for an account, open it and choose a G/L account in the Update panel; the account cannot post until it has one.
3. To retire the account: in **Deactivate this account** (إلغاء تنشيط الحساب) type the **Reason** and press **Deactivate**. An inactive account is not offered on new transfers, deposits, loans or statements. **Reactivate** brings it back.

### Fields — Bank Accounts
- **Name** (الاسم) — required.
- **G/L account** (الحساب في دليل الحسابات) — required; an active, approved posting account under Assets, not another subledger's control account, and not already carried by another bank or cash account. Every posting on this bank account goes to this ledger account, and the account's balance is that ledger account's balance.
- **Currency** (العملة) — required; one of the active currencies; default IQD.
- **Bank** (البنك) — optional; an active bank from Banks.
- **Bank name / branch** (اسم البنك / الفرع) — optional free text for what the bank list does not say (a branch, a desk); defaults to the bank's name.
- **Account number** (رقم الحساب) — required; the number assigned by the bank; it identifies the account on statements.
- **IBAN** (الآيبان) — optional; on the record.
- **SWIFT** (سويفت) — optional; on the record.
- **Statement format** (صيغة الكشف) — optional; "How its statements arrive, so they can be imported."
- **Approval limit** (حد الاعتماد) — optional amount; "The ceiling a payment from this account may reach." A bank loan landing in this account whose value in dinars is above this limit — or any loan when the limit is empty — can only be approved by a user holding the CEO role or a Super User.
List columns: Code, Name, Bank name / branch, G/L account, Currency, Active.

### After you save — Bank Accounts
A bank account is active as soon as it is created; there is no approval and creating it posts nothing. Its balance is always read from the ledger account it is linked to, never typed. A bank account can never hold less than nothing: a posting that would take it below zero is refused (see the Treasury & Banking guide). Every change is in the audit log on the record.

### Refusals — Bank Accounts
- "name: is required" / "accountNumber: is required" — fill the field.
- "glAccountId: is a header, not a posting account" / "glAccountId: must be an asset account — cash is an asset" / "glAccountId: is not active" — choose an active asset posting account.
- "glAccountId: is the <customer / supplier / …> control account, which its own subledger maintains — choose a cash or bank account" — choose an ordinary cash or bank ledger account.
- "glAccountId: is already carried by account <code>" — each bank or cash account needs its own ledger account; open a new one on Chart of Accounts.
- "bankCode: <bank name> is no longer active" — reactivate the bank or choose another.
- "currency: is a three-letter code such as IQD or USD" — choose a currency.
- "approvalLimitIqd: must be a positive amount" — correct the limit.
- "reason: is required to deactivate an account" — type the reason.
- "The bank account counter is a hundred numbers behind the register. Set it past the highest code in use on the Numbering screen before adding another." — an administrator corrects the series on Settings → Administration → Numbering.

## Cash Accounts (الحسابات النقدية)
Path: Accounting → Master Data — Banking → Cash Accounts   |   Arabic: المحاسبة ← البيانات الرئيسية — البنوك ← الحسابات النقدية
Address: /master-data/cash-accounts  (a record: /master-data/cash-accounts/<account code>)
Needs: `view` on `bank_account` to open the list and a record; `create` on `bank_account` for New cash account; `configure` on `bank_account` for the Update panel; `administer` on `bank_account` for Deactivate and Reactivate; `print` / `export` on `bank_account` for Print / Export.
What it is for: the company's cash floats — the tills and cash boxes — who holds each one, and the ledger account it is carried in. A cash account is used like a bank account on payments, receipts, transfers and deposits, but it has a custodian and a ceiling instead of a bank and a number.

### How to create a cash account — Cash Accounts
1. First make sure an asset posting account for it exists and is approved on Chart of Accounts — one ledger account per cash account.
2. Open Accounting → Master Data — Banking → Cash Accounts and press **New cash account** (حساب نقدي جديد).
3. Type the **Name** (الاسم).
4. Choose the **G/L account** (الحساب في دليل الحسابات) — an active, approved asset posting account that no other bank or cash account uses.
5. Choose the **Currency** (العملة) — IQD by default.
6. Choose the **Custodian** (أمين العهدة): the active user answerable for this float at a cash count. A cash account needs one.
7. Press **Create** (إنشاء). The system gives the code (CASH-000001, …) and opens the record. The float ceiling and approval limit are set on the record.

### How to open, change, deactivate or reactivate a cash account — Cash Accounts
1. Click the account's code in the list. The record shows the name, code and status; **Details** — G/L account (opens the ledger account), Currency, Custodian, **Float ceiling** (سقف العهدة), Approval limit; and **What this account holds** with the same figures as a bank account (Holds now, Received, Pending debit, Paid out, Held at the start of the year, Available to pay with, Last movement).
2. Use the **Update** (تحديث) panel: Name, G/L account, Currency, Custodian, Float ceiling, Approval limit; then **Save** (حفظ).
3. To retire it: in **Deactivate this account** type the **Reason** and press **Deactivate**; **Reactivate** brings it back.
4. **Print / Export** gives the cash account's statement; **See every transaction** opens Bank and Cash Reporting for it.

### Fields — Cash Accounts
- **Name** (الاسم) — required.
- **G/L account** (الحساب في دليل الحسابات) — required; an active, approved posting account under Assets, not another subledger's control account and not used by another bank or cash account. The cash account's balance is this ledger account's balance.
- **Currency** (العملة) — required; one of the active currencies; default IQD.
- **Custodian** (أمين العهدة) — required; a user; "The person answerable for this float at a cash count."
- **Float ceiling** (سقف العهدة) — optional amount, on the record; "The most this float may hold." A transfer or deposit that would take the cash above it is refused: "<code> would hold <amount>, above its cash limit of <limit> … bank the excess, or have the limit raised."
- **Approval limit** (حد الاعتماد) — optional amount, on the record; "The ceiling a payment from this account may reach."
List columns: Code, Name, Custodian, G/L account, Currency, Active.

### After you save — Cash Accounts
A cash account is active as soon as it is created; there is no approval and creating it posts nothing. Its balance is the balance of its ledger account. A cash account can never hold less than nothing: a posting that would take it below zero is refused (see the Treasury & Banking guide). Every change is in the audit log on the record.

### Refusals — Cash Accounts
- "name: is required" — type the name.
- "custodianUserId: is required for a cash account" — choose the custodian.
- "glAccountId: is a header, not a posting account" / "glAccountId: must be an asset account — cash is an asset" / "glAccountId: is not active" / "glAccountId: is the <subledger> control account, which its own subledger maintains — choose a cash or bank account" / "glAccountId: is already carried by account <code>" — choose an active asset posting account of its own.
- "cashLimitIqd: must be a positive amount" / "approvalLimitIqd: must be a positive amount" — correct the amount.
- "reason: is required to deactivate an account" — type the reason.

## Branches (الفروع)
Path: Accounting → Master Data — Organization → Branches   |   Arabic: المحاسبة ← البيانات الرئيسية — الهيكل التنظيمي ← الفروع
Address: /master-data/branches  (a record: /master-data/branches/<branch code>)
Needs: `view` on `branch` to open the list and a record; `create` on `branch` for New branch; `configure` on `branch` for the Update panel; `administer` on `branch` for Deactivate and Reactivate.
What it is for: the company's branches. Every user and every transaction belongs to a branch, and a user only sees the documents of the branches they are assigned to. A branch is never deleted — it is deactivated.

### How to create a branch — Branches
1. Open Accounting → Master Data — Organization → Branches and press **New branch** (فرع جديد).
2. **Code** (الرمز): leave it blank and it is made from the name as you type (BAGHDAD OFFICE → BAGHDAD_OFFICE), or type your own. It cannot be changed later.
3. Type the **Name** (الاسم).
4. Optionally choose the **Branch manager** (مدير الفرع) from the active users, and type the **Address** (العنوان).
5. Press **Create** (إنشاء). The branch opens on its record. Creating a branch also creates its main warehouse — code WH-<branch code>, named "<branch name> Main Warehouse" — and makes it the branch's **Default warehouse** (المستودع الافتراضي).

### How to open, change or deactivate a branch — Branches
1. Click the branch's code in the list. The record shows the name, code and status, and **Details**: Branch manager, Default warehouse, Address, Created.
2. Use the **Update** (تحديث) panel to change the name, the manager or the address, then **Save** (حفظ).
3. To retire the branch: in **Deactivate this branch** (إلغاء تفعيل هذا الفرع) type the **Reason** and press **Deactivate**; **Reactivate** brings it back.
4. The audit log at the foot also shows which users were given this branch.

### Fields — Branches
- **Code** (الرمز) — optional when creating; 1–32 letters, digits, hyphens or underscores, starting with a letter or digit; stored in capitals. "Left blank, it is made from the name. It cannot be changed later."
- **Name** (الاسم) — required.
- **Branch manager** (مدير الفرع) — optional; a user; **No manager** (لا يوجد مدير) by default.
- **Address** (العنوان) — optional.
- **Default warehouse** (المستودع الافتراضي) — shown, not typed; the main warehouse created with the branch.
List columns: Code, Name, Manager, Default warehouse, Active.

### After you save — Branches
A branch is active as soon as it is created, together with its main warehouse; there is no approval and nothing is posted. Users are given the branch on Settings → Administration → Users. Bank and cash accounts are not per branch — a company account is chosen on each payment or receipt. Every change is in the audit log on the record.

### Refusals — Branches
- "name: is required" — type the name.
- "code: use 1–32 letters, digits, hyphens or underscores, starting with a letter or digit" — correct the code.
- "code: '<CODE>' is already a branch" — choose another code.
- "code: could not be made from the name; type one" — the name has no Latin letters or digits (for example an Arabic-only name); type a code yourself.
- "reason: is required to deactivate a branch" — type the reason.

## Departments (الأقسام)
Path: Accounting → Master Data — Organization → Departments   |   Arabic: المحاسبة ← البيانات الرئيسية — الهيكل التنظيمي ← الأقسام
Address: /master-data/departments  (a record: /master-data/departments/<department code>)
Needs: `view` on `department` to open the list and a record; `create` on `department` for New department; `configure` on `department` for the Update panel; `administer` on `department` for Deactivate and Reactivate; to add or remove members and managers: `configure` on `user_department_scope`, or being the department's own manager.
What it is for: the company's departments and who belongs to each. Departments route approvals — a document goes to the manager of the department it was raised in — and the Finance flag decides who may raise journal entries.

### How to create a department — Departments
1. Open Accounting → Master Data — Organization → Departments and press **New department** (قسم جديد).
2. Type the **Name** (الاسم).
3. Optionally choose the **Parent department** (القسم الأعلى); **None (top level)** (لا يوجد (مستوى أعلى)) by default.
4. Tick **Finance department** (قسم مالي) if its members are the people who keep the books.
5. Press **Create** (إنشاء). The system gives the code (DEP-0001, …) and opens the record.

### How to add members and name the manager — Departments
1. Open the department. **Members** (الأعضاء) lists the people in it: name and e-mail (opens the user), whether they are the manager, and whether they are active.
2. To add someone: in **Add a member** (إضافة عضو) choose the user, tick **As department manager** (كمدير للقسم) if they are to manage it, and press **Add a member**.
3. On a member's row: **Make manager** (تعيين مديراً) or **Remove as manager** (إزالة كمدير), and **Remove from department** (إزالة من القسم).
4. The department's manager is the person documents raised in it go to for approval. Removing the manager leaves the department with **No manager assigned** (لم يُعيَّن مدير) until another is named.

### How to change or deactivate a department — Departments
1. Use the **Update** (تحديث) panel on the record: Name, Parent department, Finance department; then **Save** (حفظ).
2. To retire it: type the **Reason** in the **Deactivate** panel and press **Deactivate**; **Reactivate** brings it back.

### Fields — Departments
- **Name** (الاسم) — required.
- **Parent department** (القسم الأعلى) — optional; another department; not the department itself.
- **Finance department** (قسم مالي) — tick box; default unticked. Only people who are members of a department with this tick can raise journal entries.
- Add a member: **Users** (المستخدمون) — required; an active user not yet in the department; **As department manager** — tick box.
List columns: Code, Name, Parent, Manager, Finance (Yes / No), Active.

### After you save — Departments
A department is active as soon as it is created; there is no approval and nothing is posted. Membership changes take effect at once for the user. Every change — including who was added, removed or made manager, and by whom — is in the audit log on the record.

### Refusals — Departments
- "name: is required" — type the name.
- "parentCode: cannot be the department itself" — choose another parent or none.
- "reason: is required to deactivate a department" — type the reason.
- "Permission denied: 'configure' on 'user_department_scope' is not granted to this user." — only an administrator with that permission, or the department's own manager, changes its members.
- Seen on journals, explained here: "Only people in a finance department can raise journal entries, and you are not in one yet. To fix it: Accounting → Master Data → Departments, add a department with "Finance department" ticked; then Settings → Users, open your user and add it to that department."

## Cost Centres (مراكز التكلفة)
Path: Accounting → Master Data — Organization → Cost Centres   |   Arabic: المحاسبة ← البيانات الرئيسية — الهيكل التنظيمي ← مراكز التكلفة
Address: /master-data/cost-centres  (a record: /master-data/cost-centres/<code>)
Needs: `view` on `cost_centre` to open the list and a record; `create` on `cost_centre` for New cost centre; `configure` on `cost_centre` for the Update panel; `administer` on `cost_centre` for Deactivate and Reactivate.
What it is for: where cost is gathered, independently of who reports to whom. A cost centre has an owner who answers for its budget, and may be tied to one branch or be company-wide.

### How to create a cost centre — Cost Centres
1. Open Accounting → Master Data — Organization → Cost Centres and press **New cost centre** (مركز تكلفة جديد).
2. Type the **Name** (الاسم).
3. Optionally choose the **Owner** (المسؤول) from the active users — "Budget responsibility rests with a person, not a box."
4. Optionally choose the **Branch** (الفرع); leave it on **Company-wide** (على مستوى الشركة) for a cost centre not tied to one branch.
5. Press **Create** (إنشاء). The system gives the code (CC-0001, …) and opens the record. The code does not change afterwards.

### How to open, change or deactivate a cost centre — Cost Centres
1. Click the code in the list. The record shows the name, code and status, and **Details**: Owner, Branch (or Company-wide), Created.
2. Use the **Update** (تحديث) panel to change the name, owner or branch, then **Save** (حفظ).
3. To retire it: in **Deactivate this cost centre** (إلغاء تنشيط مركز التكلفة) type the **Reason** and press **Deactivate**; **Reactivate** brings it back.

### Fields — Cost Centres
- **Name** (الاسم) — required.
- **Owner** (المسؤول) — optional; a user; **No owner named** (لا يوجد مسؤول) by default.
- **Branch** (الفرع) — optional; an active branch; blank means **Company-wide**.
List columns: Code, Name, Owner, Branch, Active.

### After you save — Cost Centres
A cost centre is active as soon as it is created; there is no approval and nothing is posted. Every change is in the audit log on the record.

### Refusals — Cost Centres
- "name: is required" — type the name.
- "ownerUserId: is not a known user" / "branchCode: is not a known branch" — choose the owner or the branch again from the list.
- "reason: is required to deactivate a cost centre" — type the reason.
