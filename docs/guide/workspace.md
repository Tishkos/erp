# Workspace — user guide

The workspace is the set of screens that belong to you rather than to one module: **Home** (the menu calls it My Dashboard), **My Approvals**, **Notifications** with the bell in the top bar, **Global Search** (Ctrl K) and your **Saved views**.
Home shows the figures, charts and lists your permissions earn; My Approvals lists what waits for your decision; the bell tells you what happened; Search finds a record, a number, a file or a screen; a saved view keeps a list's filters under a name.
All five read the data as you: they show only what your permissions and branches allow, and your notifications and views are seen by nobody else.
My Dashboard, My Approvals, Notifications and Global Search are under Dashboard → Home in the menu, beside My Tasks, Exceptions, Control Center and Chat, which are described under their own names.

## Concepts — Workspace

### Home, Dashboard and My Dashboard are one screen — Workspace concepts
The first screen after signing in carries three names. The menu entry is **My Dashboard** (لوحة معلوماتي); the page's own title is **Dashboard** (لوحة المتابعة); and buttons elsewhere call it Home — **Pin to Home** (تثبيت في الرئيسية), **On Home** (في الرئيسية). The back button at the top of most screens also says **Dashboard** (الرئيسية). All of them mean the screen at address /. The company's mark in the top bar opens it too.

### Everything in the workspace answers as you — Workspace concepts
- Home, My Approvals, the bell, Search and saved views read the data again, as you, each time they are opened. They can never show more than the screens behind them would show you.
- A part you may not see is left out — it is not drawn and then refused. A missing tile, list, search group or link is therefore usually a permission, not a fault.
- Your notifications, your read and unread marks and your saved views are yours alone. An administrator or a Super User does not see them.
- The figures on Home that are kept per branch follow the Active branch; change it to see another branch.

### How fresh the numbers are — Workspace concepts
- Home is worked out when the page opens. It does not refresh by itself: reload the page for newer figures.
- The number on the bell is checked about every 30 seconds while the tab is in front (every two minutes in a background tab). The list inside the bell is fetched when you open it. Nothing is pushed to the screen.
- Search asks the system while you type; records are looked up from the second character.
- A saved view stores filters, never rows, so opening one always shows today's records.

## My Dashboard (لوحة معلوماتي)
Path: Dashboard → Home → My Dashboard   |   Arabic: الرئيسية ← الرئيسية ← لوحة معلوماتي
Address: /
Needs: to be signed in (the menu entry needs `view` on `dashboard`). Every tile, chart and list needs `view` on the records its figures come from — named beside each part in the blocks below.
What it is for: Home — the first screen after signing in, titled **Dashboard** (لوحة المتابعة). It is put together for the person who opens it: shortcut buttons for your kind of work, figure tiles, charts, and lists of what can be acted on. Every figure links to the screen that proves it. It is read-only.

### How to read Home — My Dashboard
1. Open the system, or press the company's mark in the top bar, or open Dashboard → Home → My Dashboard.
2. Read the line under the title: "<branch> · as at <date>" — the Active branch and today's date. Change the Active branch to see another branch's figures.
3. At the top are up to five shortcut buttons (see "How to use the shortcut buttons — My Dashboard").
4. Next come the figure tiles. Each shows a number or an amount, its name and a short note. Press a tile to open the screen the figure comes from.
5. **Trends** (الاتجاهات) holds the charts that have something to draw. Under a chart, open "Table" to read the same figures as numbers (the word Table is shown in English on the Arabic screen as well).
6. Then the lists, each in its own window with a count beside the title and a **See all** (عرض الكل) link to the full screen. A list shows at most eight rows. Press the first cell of a row to open that record.
7. **Nothing to show** (لا شيء للعرض) is one table of the charts and lists you may see that are empty today: **Section** (القسم) and **State** (الحالة) — for example "No container is delayed."
8. **Not available for your role** (غير متاح لدورك) says, one sentence each, which areas of work your role holds nothing of — for example "No HR data is available for your role."
A tile with nothing to count shows a dash (—) and its reason, never a zero that was not counted. An amount of eight digits or more is shortened on its tile (for example 1.25B IQD); hover over it, or press the tile, for the exact amount.

### How to use the shortcut buttons — My Dashboard
At the top of Home there are at most five buttons, picked from the list below by your permissions and ordered by your kind of work; the first one is highlighted. A button is offered only if you may do what it opens.
- **My approvals** (موافقاتي) — opens My Approvals; for anyone a decision can wait on (you hold an `approve` permission on anything, or you manage a department). Always first.
- **Assign a task** (إسناد مهمة) — opens My Tasks; `submit` on `task`.
- **New sales invoice** (فاتورة مبيعات جديدة) — `create` on `ar_invoice`.
- **New customer receipt** (مقبوض عميل جديد) — `create` on `customer_receipt`.
- **New purchase invoice** (فاتورة مشتريات جديدة) — `create` on `ap_invoice`.
- **New supplier payment** (دفعة مورد جديدة) — `create` on `supplier_payment`.
- **Bank reconciliation** (مطابقة البنك) — `view` on `bank_reconciliation`.
- **Shipment tracking** (تتبع الشحنات) — `view` on `shipment_container`.
- **Stock availability** (توفر المخزون) — `view` on `inventory_movement`.
- **Stock receipts** (استلامات المخزون) — `view` on `stock_movement`.
- **Purchase orders** (أوامر الشراء) — `view` on `purchase_order`.
- **Leave requests** (طلبات الإجازة) — `view` on `leave_request`.
- **Projects** (المشاريع) — `view` on `project`.
- **My tasks** (مهامي) — `view` on `task`.
- **Chat** (المحادثات) — `view` on `chat`.
Only five fit, so a person with many permissions sees the five that rank highest for them and reaches the rest from the menu. The buttons cannot be chosen or rearranged.

### What each part shows: the figure tiles — My Dashboard
Each tile needs the permission named (`view` unless said otherwise) and opens the screen named.
- **Waiting for my approval** (بانتظار موافقتي) — how many documents wait for your decision; opens My Approvals. For people who hold an `approve` permission or manage a department.
- **Cash and bank** (النقد والبنوك) — all bank and cash balances added together, with the number of accounts; opens Bank Accounts. `bank_account`.
- **Owed to us** (مستحق لنا) and **Owed by us** (مستحق علينا) — what is still open on the Active branch's sales and purchase invoices, with the number of open invoices; open Sales Invoices and Purchase Invoices. `ar_invoice`, `ap_invoice`.
- **Overdue from customers** (متأخر على العملاء) and **Overdue to suppliers** (متأخر للموردين) — the part of those totals past its due date, with a warning sign when it is not zero. CEO role only.
- **Stock value** (قيمة المخزون) — stock at cost, with the number of warehouses; opens Inventory Valuation. `inventory_movement`.
- **Result this year** (نتيجة السنة) — income less expenses from 1 January to today for the Active branch; a warning sign marks a loss; opens Income Statement. `financial_statement`.
- **Payment applications open** (طلبات الدفع المفتوحة) — applications still Draft or Approved, split in the note; opens Payment Applications. `payment_application`.
- **Imports in progress** (استيرادات قيد التنفيذ) — imports not yet at their last stage (Cleared); the note says "of N imports", or "N containers are late" with a warning sign; opens Import Applications. `payable` and `shipment_container`.
- **Stock movements today** (حركات المخزون اليوم) — movements dated today; opens Stock Movement. `stock_movement`.
- **Open purchase orders** (أوامر الشراء المفتوحة) — orders approved and not fully received, with how many wait for approval; opens Purchase Orders. `purchase_order`.
- **Sales this month** (مبيعات هذا الشهر) — posted sales invoices of the Active branch dated this month, with their number. `ar_invoice`.
- **Employees** (الموظفون) — headcount, with how many are on leave today and how many requests wait; opens the HR Dashboard. `employee`.
- **Active projects** (المشاريع النشطة) — with "of N projects". `project`.
- **My open tasks** (مهامي المفتوحة) — with how many are overdue and due today; opens My Tasks. `task`.
- **Unread notifications** (إشعارات غير مقروءة) and **Unread messages** (رسائل غير مقروءة) — open Notifications and Chat. `notification`, `chat`.

### What each part shows: the trends — My Dashboard
The charts sit under **Trends** (الاتجاهات). Only a chart with data is drawn; an empty one is named under Nothing to show. Amounts are in Iraqi dinars. Each needs `view` on the object named.
- **Income and expenses, month by month** (الإيرادات والمصروفات، شهراً بشهر) — the last twelve months of the Active branch, **Income** (الإيرادات) beside **Expenses** (المصروفات); **See all** (عرض الكل) opens Income Statement. `financial_statement`.
- **Owed to us, by how late** (مستحق لنا، بحسب مدة التأخر) and **Owed by us, by how late** (مستحق علينا، بحسب مدة التأخر) — one bar split into **Not yet due** (لم تستحق بعد), **1–30 days late** (متأخرة ١–٣٠ يوماً), **31–60 days late** (متأخرة ٣١–٦٠ يوماً), **61–90 days late** (متأخرة ٦١–٩٠ يوماً) and **Over 90 days late** (متأخرة أكثر من ٩٠ يوماً); the link **Invoices** (الفواتير) opens Sales Invoices or Purchase Invoices. `ar_invoice`, `ap_invoice`.
- **Cash and bank balances** (أرصدة النقد والبنوك) — the eight accounts with the largest balances; an overdrawn account is shown too. `bank_account`.
- **Sales invoiced and collected** (المبيعات المفوترة والمحصّلة) — the last six months, **Invoiced** (المفوتر) beside **Collected** (المحصّل). `ar_invoice`.
- **Biggest customers this year** (أكبر العملاء هذه السنة) — the eight largest by amount invoiced since 1 January. `ar_invoice`.
- **Stock value by warehouse** (قيمة المخزون بحسب المستودع) — the eight largest, at FIFO cost. `inventory_movement`.
- **Import journey** (رحلة الاستيراد) — see "What each part shows: the import journey — My Dashboard".
Under each chart "Table" gives the same figures as numbers; for the two "by how late" charts its columns are **How late** (مدة التأخر), **Document** (المستند) — the number of invoices — and **Total outstanding** (إجمالي المتبقي).

### What each part shows: the import journey — My Dashboard
Needs: `view` on `payable` and `shipment_container`.
The chart **Import journey** (رحلة الاستيراد) shows how far the imports in progress have got. It is a row of numbered steps, each followed by "reached / in progress": "3. Bill of lading · 4/6" means four of the six imports in progress have a bill of lading. Above it: "N imports in progress".
1. **Import application** (طلب الاستيراد) — the import exists.
2. **Shipping** (الشحن) — a container has left the port of loading.
3. **Bill of lading** (بوليصة الشحن) — a B/L is recorded.
4. **Container** (الحاوية) — containers are recorded.
5. **Customs** (الجمارك) — a customs pre-declaration (PD) stands for the import.
6. **Clearance** (التخليص) — a customs declaration is cleared, or a container has been received.
7. **Landed cost** (تكاليف الإنزال) — a landed-cost charge is booked.
8. **Receipt** (الاستلام) — a container has been received.
9. **Inventory** (المخزون) — goods of the import are in a warehouse.
- A step's colour says whether every import, some, or none have reached it; hover over it to read "Every import has reached this step", "N of M imports have reached this step" or "No import has reached this step".
- Each step is counted on its own, so the numbers need not fall from left to right.
- "Steps your role cannot read are not shown." (الخطوات التي لا يمكن لدورك قراءتها غير معروضة.) A step is drawn only if you may view the records that prove it, so a missing step never means zero.
- An import at its last stage (Cleared) is finished and is not counted. With more than 500 imports the chart says "Counted from the first 500 of N imports."
- **See all** (عرض الكل) opens Import Applications. "Table" lists **Step** (الخطوة) and **Imports that reached it** (الاستيرادات التي وصلت إليها).

### What each part shows: lists of your own work — My Dashboard
- **Needs attention** (تحتاج إلى معالجة) — open findings of the Exception Center that you may see: **Severity** (الخطورة), **Exception** (الاستثناء), **Area** (المجال), **Since** (منذ). **See all** (عرض الكل) opens Exceptions. Absent when there are none.
- **Waiting for my approval** (بانتظار موافقتي) — the eight that have waited longest: **Document** (المستند), **Type** (النوع), **Requested by** (طلبه), **Since** (منذ), **Amount** (المبلغ), **Action** (الإجراء). Press the document to open it; **See all** (عرض الكل) opens My Approvals. For people a decision can wait on.
- **My next tasks** (مهامي القادمة) — **Task** (المهمة), **Due** (الاستحقاق), **Priority** (الأولوية), **Status** (الحالة). `view` on `task`.
- **My pinned views** (عروضي المثبتة) — the saved views you pinned to Home, oldest pin first: **View** (العرض) and **Rows** (الصفوف), the number of rows that view lists today. Rows shows — for a screen that gives no count, and **Not available** (غير متاح) when you can no longer open the screen. Absent until you pin a view (see "How to pin a view to Home — Saved views").
- **Unread notifications** (إشعارات غير مقروءة) — **Notification** (الإشعار) and **Since** (منذ); pressing one opens what it is about. The text here is the stored English wording. Absent when there are none.
- **Findings to fix** (ملاحظات تحتاج إلى معالجة) — **What is wrong** (ما هو الخطأ) and **Where it is fixed** (أين يُعالَج): stock ledger problems (**Stock Ledger** — دفتر المخزون), receipts with no payer (**Receipts** — المقبوضات), a bank or cash account with no ledger account behind it (**Bank/Cash Accounts** — الحسابات البنكية والنقدية). Needs `view` on one of `inventory_movement`, `customer_receipt`, `bank_account`. Absent when there are none.
- **Recent activity** (آخر النشاطات) — the latest eight events of the audit log: **When** (متى), **Type** (النوع), **Event** (الحدث), **By** (بواسطة), **Outcome** (النتيجة). **See all** (عرض الكل) opens Audit Trail. `view` on `audit_event`.

### What each part shows: lists by area of work — My Dashboard
Each list needs `view` on the objects named, shows eight rows, and **See all** (عرض الكل) opens the screen in brackets.
- **Biggest imports in progress** (أكبر الاستيرادات الجارية) — CEO role, `payable`: **Import** (الاستيراد), **Supplier** (المورد), **Stage** (المرحلة), **Reached** (وصل إلى) — the furthest step of the import journey, **Containers** (الحاويات), **Amount** (المبلغ). [Import Applications]
- **Payments due in the next seven days** (دفعات تستحق خلال سبعة أيام) — `payable`: **Payable** (الذمة), Supplier, **Due** (الاستحقاق), Amount. [Import Applications]
- **Delayed containers** (حاويات متأخرة) — `shipment_container`: **Container** (الحاوية), Import, Supplier, **ETA** (الوصول المتوقع), **Days late** (أيام التأخير). [Shipment Tracking]
- **Containers waiting on customs** (حاويات بانتظار الجمارك) — `shipment_container` and `customs_pd`: Container, Import, **Status** (الحالة), **Next step** (الخطوة التالية). [Shipment Tracking]
- **Landed costs not yet locked** (تكاليف الإنزال غير المقفلة) — `landed_cost_register`: Import, Supplier, **State** (الحالة), **Not locked** (غير مقفل). [Landed Costs]
- **Goods in transit** (بضاعة في الطريق) — `in_transit`: Import, **Item** (الصنف), **In transit** (في الطريق), Containers. [In-Transit Inventory]
- **Containers ready to receive** (حاويات جاهزة للاستلام) — `shipment_container` and `inventory_movement`: Container, Import, **Warehouse** (المستودع), **Cleared on** (تاريخ التخليص). [Shipment Tracking]
- **Stock at or below its minimum** (مخزون عند حدّه الأدنى أو دونه) — `inventory_movement`: Item, Warehouse, **On hand** (المتوفر), **Minimum** (الحد الأدنى). Only items that have a minimum level, and never the in-transit warehouse. [Availability]
- **Today's stock movements** (حركات المخزون اليوم) — `stock_movement`: Item, Warehouse, **Movement** (الحركة), **Quantity** (الكمية), **Document** (المستند). [Stock Movement]
- **Open purchase orders** (أوامر الشراء المفتوحة) — `purchase_order`: **Order** (الأمر), Supplier, **Expected** (المتوقع), **Open value** (القيمة المفتوحة). [Purchase Orders]
- **On leave today** (في إجازة اليوم) — `leave_request` and `employee`: **Request** (الطلب), **Employee** (الموظف), **Leave type** (نوع الإجازة), **Until** (حتى). [Leave Management]
- **Active projects** (المشاريع النشطة) — `project`: **Project** (المشروع), **Manager** (المدير), **Ends** (ينتهي), **Available** (المتاح). [Project Master]

### Why your Home is different from a colleague's — My Dashboard
- A tile, chart or list is on your Home only if you hold the permissions it needs. A few also need something you are: the CEO role (the two overdue tiles, Biggest imports in progress), being somebody a decision can wait on (the approval tile and list), or `submit` on `task` (the Assign a task button).
- Order: what waits for you comes first (approvals, Needs attention). Then your areas of work, the one you hold most of first — an accountant's Home leads with money, a storekeeper's with stock. The CEO role reads in a fixed order: money, then operations, then people and projects. Your own things (tasks, notifications, chat) come last.
- An area you hold nothing of is named once under **Not available for your role** (غير متاح لدورك): finance, receivables, payables, sales, purchasing, inventory, logistics, HR, projects — for example "No finance data is available for your role." (لا تتوفر بيانات مالية لدورك.)
- A part you may see that has nothing in it today is not hidden: its tile shows a dash with the reason, and a chart or list is named under **Nothing to show** (لا شيء للعرض). Four lists simply disappear when empty: Needs attention, My pinned views, Unread notifications, Findings to fix.
- A Super User passes every permission check and so sees every part.
- Figures follow the branches you are assigned to and, where a figure is kept per branch, the Active branch.

### What Home does not do — My Dashboard
- Nothing can be typed, approved or changed on Home. It only reads and links.
- The layout cannot be customised: parts cannot be hidden, moved or added. The one thing you add yourself is a pinned saved view.
- It does not refresh by itself; reload the page.
- A list shows eight rows and a bar chart eight bars; the full picture is behind **See all** (عرض الكل).
- A container counts as delayed only after the system's morning check has found its ETA passed, so a container whose ETA passed today may not be listed until tomorrow.
- On a phone the tiles stack in one column, so a person with many permissions scrolls a long way before the charts.
- The word "Table" under the charts is not translated.

### Refusals — My Dashboard
- "The <part> section could not be read. Everything else on this page is unaffected." (تعذّرت قراءة قسم … بقية الصفحة غير متأثرة.) — one part failed to load (it met an error or took longer than 15 seconds). It is shown on the tile or in Nothing to show. Reload the page; report it if it stays.
- "Some sources could not be read." (تعذّرت قراءة بعض المصادر.) on the Waiting for my approval tile — one of the places approvals come from could not be read, so the count may be short. Open My Approvals, which names the source.
- "Not available to you" (غير متاح لك) after pressing a tile — Home showed a figure you may see, but the screen it opens asks for a further permission (for example the Employees tile needs `view` on `employee`, the HR Dashboard it opens needs `view` on `hr_report`). Ask an administrator.
- A figure that looks wrong: press it and check it on the screen it comes from. Home only repeats that screen's figure.

## My Approvals (موافقاتي)
Path: Dashboard → Home → My Approvals   |   Arabic: الرئيسية ← الرئيسية ← موافقاتي
Address: /approvals
Needs: `view` on `workflow_instance` to open. To decide on the row: `approve` on `chart_of_account`, `journal_entry` or `business_partner` (for a purchase invoice held for review, `submit` on `ap_invoice`), together with the role the step asks for. Other kinds of document are listed only if you may decide them on their own page.
What it is for: One list of the documents that wait for your decision — only those you could really decide — followed by what you sent for approval and what you decided. Every row opens the real document. Title **My Approvals** (موافقاتي): "Documents waiting for your decision, then what you submitted and what you decided."

### How to see what is waiting for you — My Approvals
1. Open Dashboard → Home → My Approvals, or press the **My approvals** (موافقاتي) button or the **Waiting for my approval** (بانتظار موافقتي) tile on Home.
2. The first window, **Waiting for you** (بانتظارك), lists the documents waiting for your decision, the one that has waited longest first, 25 to a page. The count beside the title is how many there are.
3. Read a row: **Document** (المستند) — its number, a link to the real document; **Submitted by** (قدّمه); **Type** (النوع); **Submitted** (تاريخ التقديم); **Amount** (المبلغ); **Current stage** (المرحلة الحالية); **Action required** (الإجراء المطلوب).
4. To narrow the list, type part of a document number or of the submitter's name in **Search this list** (ابحث في هذه القائمة) and press Enter, or choose a **Document type** (نوع المستند) and press **Filter** (تصفية).
5. To remove the type filter choose **All types** (كل الأنواع) and press **Filter** (تصفية) again. **Clear** (مسح), shown while a search is active, removes the search and the filter together.
6. With nothing waiting the list says "Nothing is waiting for your approval." (لا شيء ينتظر موافقتك.); when the filter matches nothing, "Nothing matches this filter." (لا شيء يطابق هذه التصفية.)
A document you raised yourself is not listed for you when its approval must come from somebody else.
If you decide documents (leave requests, for example) but do not hold `view` on `workflow_instance`, My Approvals is not in your menu: use the list **Waiting for my approval** (بانتظار موافقتي) on Home, whose rows open the documents.

### How to approve or reject from the list — My Approvals
Four kinds are decided on the row itself: **Chart account** (حساب في دليل الحسابات), **Journal entry** (قيد يومية), **Bank details** (بيانات بنكية), and a **Purchase invoice** (فاتورة مشتريات) that an automation rule is holding for review. For these the **Action required** (الإجراء المطلوب) cell holds the buttons.
1. Press the document's number and read the document first.
2. Back in the list, press **Approve** (اعتماد) to approve.
3. To reject, type why in **Reason for rejection** (سبب الرفض) on that row and press **Reject** (رفض). The reason is required and is kept with the decision.
4. "Saved." (تم الحفظ.) appears only after the decision is really recorded. The row leaves the list and the decision appears under **My decisions** (قراراتي). A refusal comes back as "That could not be saved." (تعذّر الحفظ.) with the reason.
What each decision does:
- Chart account — decides the request for the new account.
- Journal entry — when yours is the last approval on its route, approving posts the journal; rejecting marks it Rejected with your reason.
- Bank details — approving verifies the supplier's or customer's bank account (the first verified account becomes the default one); rejecting returns it with your reason.
- Purchase invoice under review — approving lifts the hold and posts nothing; rejecting returns the invoice to Draft.

### How to decide a document that has no buttons on its row — My Approvals
For every other type the **Action required** (الإجراء المطلوب) cell names what is asked of you, followed by **Open** (فتح). Press it (or the document's number) and decide on the document's own page, with its own button.
- **Approve** (اعتماد) — a purchase order waiting for approval, a payment application (it waits as a Draft), a payroll run, an advance or loan.
- **Approve and post** (اعتماد وترحيل) — a submitted purchase invoice; you need both `approve` and `post` on `ap_invoice`. The same words are shown for a payroll run that waits to be posted.
- **Confirm** (تأكيد) — a service receipt waiting for your department. Its link opens the service receipts list searched for that receipt.
- **Decide** (البت) — a leave request or an employee request.
- **Endorse** (تأييد) and **Pay out** (صرف) — an advance or loan to endorse or pay; a payroll run to pay.
- **Rate** (تقييم), **Sign off** (اعتماد نهائي), **Read and answer** (قراءة وردّ) — a performance review.
- **Hire** (تعيين) — an applicant who has been made an offer.
- **Reimburse** (تسديد) and **Issue the letter** (إصدار الخطاب) — an employee request: an expense claim to pay, a letter to issue.
The steps on those pages are described with each document in the Payables and HR guides. Nothing is decided from My Approvals for these types: the row only tells you and takes you there.

### How to follow what you sent and what you decided — My Approvals
1. **My submissions** (ما قدّمته) lists your last 20 requests sent along an approval route: **Document** (المستند), **Submitted** (تاريخ التقديم) and **Status** (الحالة) — **Pending** (معلّق) until decided, then Approved (معتمد) or Rejected (مرفوض). Empty: "You have not submitted anything yet." (لم تقدّم شيئاً بعد.)
2. **My decisions** (قراراتي) lists your last 20 decisions: **Document** (المستند), **Decision** (القرار) with the reason you typed under it, and **Decided** (تم البت) — when. Empty: "You have not decided anything yet." (لم تقرّر شيئاً بعد.)
3. In these two lists a chart account is shown as "code — name" and is a link. Other documents (journal entries, bank details, invoices under review) are shown by a long internal identifier with no link; open them on their own screens.
These two lists cover only documents that travel an approval route — chart accounts, journal entries, bank details and purchase-invoice reviews. A purchase order, a payment application or a leave request you raised is followed on its own screen.

### Fields — My Approvals
- **Search this list** (ابحث في هذه القائمة) — optional; part of a document number or of the submitter's name.
- **Document type** (نوع المستند) — optional; offers **All types** (كل الأنواع) and only the types that are in your list now. Nothing changes until you press **Filter** (تصفية).
- **Document** (المستند) — the number people know the document by. A chart account reads "code — name"; bank details read "partner code · bank".
- **Submitted by** (قدّمه) — who sent it; — where the list does not know (service receipts, payroll runs).
- **Submitted** (تاريخ التقديم) — when it began waiting. Some HR documents show —; they are sorted last.
- **Amount** (المبلغ) — where the document has one: a journal's total, an order's total, a payment application's amount in its currency, an invoice's total (added up from its lines until it is posted), a payroll run's net, an advance, an expense claim.
- **Current stage** (المرحلة الحالية) — where the document stands: "Role: <role>" (الدور: …) names the role whose holder must decide; **Department manager** (مدير القسم); **Submitted** (مقدَّم); **Draft** (مسودة) for a payment application; **Offer made** (تم تقديم العرض) for an applicant; a payroll run shows its own status.
- **Action required** (الإجراء المطلوب) — the **Approve** (اعتماد) and **Reject** (رفض) buttons, or what is asked and **Open** (فتح).
- **Reason for rejection** (سبب الرفض) — required to reject; the person who raised the document reads it.

### What happens next — My Approvals
- A decided row leaves **Waiting for you** (بانتظارك) at once and appears under **My decisions** (قراراتي) with the time and your reason. A decision cannot be taken back from this screen; a wrong one is corrected on the document's own page.
- If the route has a further step, the document moves on to the next approver; otherwise the document itself changes (a journal is posted, a bank account is verified, an invoice's hold is lifted).
- Notifications follow the route. When a document reaches an approver, each approver gets "Approval needed: <ref>" (مطلوب اعتماد: …) — never the person who submitted it. When it is decided, the submitter gets "Approved: <ref>" (تم الاعتماد: …) or "Rejected: <ref>" (تم الرفض: …); after a rejection they open the document to read the reason.
- Every decision is written to the document's history with your name and the time.
- The list is read again each time the page opens, so a document somebody else decided meanwhile is simply gone.

### Who sees what — My Approvals
A row is listed only if you could decide it now.
- Documents on an approval route (chart accounts, journal entries, bank details, purchase-invoice reviews): the current step is assigned to you by name or to a role you hold, you hold the permission to decide that kind, and — unless the step allows it — you are not the person who submitted it.
- Purchase orders: waiting for approval; you hold `approve` on `purchase_order` and did not create the order (a Super User may approve alone).
- Payment applications: still Draft; you hold `approve` on `payment_application` and did not create it (a Super User may approve alone).
- Purchase invoices: submitted, not reversed and not held for review; you hold both `approve` and `post` on `ap_invoice`.
- Service receipts: submitted for a department you belong to (an accounting manager or Super User sees every department); `view` on `service_receipt`.
- HR: the leave requests, payroll runs, advances and loans, performance reviews, job offers and employee requests that wait for you under each document's own rule.
Each kind is read up to a limit (the 100 oldest purchase orders, payment applications and purchase invoices; 50 service receipts), so with a very long backlog the newest are listed only after older ones are decided.

### Refusals — My Approvals
The reason after "That could not be saved." is written in English.
- "You cannot approve a document you raised. This step requires a different approver (Appendix B)." — somebody else must decide it.
- "This step is approved by '<role>'. You do not hold that role." — it waits for another role.
- "Say why it is rejected, so the person who raised it knows what to correct." or "A 'rejected' decision requires a reason, and the reason is kept with it (§5.4)." — type the reason for rejection.
- "A purchase order is decided on its own page; open it from the list." (the same for any type without buttons) — open the document and use its own button.
- "This <document> has already completed its approval route." / "This <document> is not awaiting approval. It may have been rejected or recalled." — it was decided or withdrawn while your page was open; reload.
- "'approve' is not available while this document is '<status>'. …" — the document is no longer in a status that can be approved.
- "This bank account was taken out of use; it cannot be verified." — the account was deactivated; nothing is left to decide.
- "Permission denied: 'approve' on 'journal_entry' is not granted to this user." (or another kind) — you lack that permission; ask an administrator.
- A note above the list, "N more documents are waiting for you but have no decision screen here yet." (… مستندات أخرى بانتظارك لكن لا توجد لها شاشة قرار هنا بعد.) — documents of a kind this list cannot show; tell an administrator.
- A note, "Some sources could not be read this time: <sources>. The rest of the list is complete." (تعذّرت قراءة بعض المصادر هذه المرة: … بقية القائمة مكتملة.) — reload the page; the source names are internal English words.
- "Not available to you" (غير متاح لك) — you do not hold `view` on `workflow_instance`.

## Notifications (الإشعارات)
Path: the bell in the top bar (on a phone: Notifications at the bottom of the drawer); the full page: Dashboard → Home → Notifications   |   Arabic: الرئيسية ← الرئيسية ← الإشعارات
Address: /notifications (opening one goes through /notifications/open/<number>)
Needs: `view` on `notification` — every role has it. You only ever see your own notifications; opening what one is about needs the permission of that record.
What it is for: Reading what the system has told you — an approval that waits for you, a task, a chat message, an invoice falling due, a late container — and going straight to the record it is about.

### How to read notifications from the bell — Notifications
1. Look at the bell in the top bar. While something is unread, the bell is replaced by the number of unread notifications (up to 99, then "99+").
2. Press it. A panel headed **Notifications** (الإشعارات) lists the latest twelve, newest first. It opens on **Unread** (غير المقروءة); press **All** (الكل) to include those already read.
3. To see one kind only, choose a category in the drop-down, which opens on **All categories** (كل الفئات).
4. Each entry shows a title, usually a line of detail, and how long ago it arrived ("5 minutes ago"); hover over the time for the exact date and time. Unread entries are highlighted.
5. Press an entry's title to open what it is about. Press **See all notifications** (عرض كل الإشعارات) for the full page.
6. Close the panel by pressing the bell again, pressing outside it, or Esc.
With nothing to list the panel says "You are all caught up. No unread notifications." (لا شيء جديد لديك. لا توجد إشعارات غير مقروءة.) on Unread, or "Nothing has been sent to you yet." (لم يُرسل إليك أي إشعار بعد.) on All.
On a phone the bell is inside the menu button: press ☰, then **Notifications** (الإشعارات), which shows the unread count beside it.

### How to open what a notification is about — Notifications
1. Press the notification's title — in the bell, on the Notifications page, or in the Unread notifications list on Home.
2. The system works out, at that moment and for you, where the notification leads, and opens it: the document waiting for approval, the task, the chat conversation, the invoice, the container.
3. Opening a notification marks it read.
4. If you can no longer open the record — it was removed, it moved to a branch you are not assigned to, or your permission was withdrawn — you land on the Notifications page with "That notification leads to something you can no longer open." (هذا الإشعار يقود إلى شيء لم يعد بإمكانك فتحه.) and the notification stays unread.
5. In the lists such a notification has no link and reads **No longer available** (لم يعد متاحاً) — "You can no longer open what this was about." (لم يعد بإمكانك فتح ما يخصه هذا الإشعار.) Its original text is hidden on purpose: it may name a party or an amount that is no longer yours to see.
6. A notification that has nothing to open is plain text without a link.
The address of a notification is never stored: it is worked out again each time, so an old notification still leads to the right place, or says honestly that it no longer can.

### How to mark notifications read or unread — Notifications
1. In the bell, press **Mark as read** (تحديد كمقروء) on an entry. On an entry already read the button says **Mark as unread** (تحديد كغير مقروء). The number on the bell changes at once.
2. **Mark all as read** (تحديد الكل كمقروء) marks every unread notification read — or, when a category is chosen in the drop-down, only that category's. The button is greyed when nothing is unread there.
3. On the Notifications page the same two buttons are in each row's **Actions** (الإجراءات) column, and **Mark all as read** (تحديد الكل كمقروء) is at the top of the page while something is unread; it follows the **Category** (الفئة) chosen in the filter.
4. Opening a notification marks it read by itself.
Read and unread are only your own reminders. Marking changes nothing in the record, nobody else sees it, and it can be undone as often as you like.

### How to use the Notifications page — Notifications
1. Open Dashboard → Home → Notifications, or press **See all notifications** (عرض كل الإشعارات) in the bell. The page is titled **Notifications** (الإشعارات): "What the system has told you, newest first. Only your own are listed."
2. The list shows 50 notifications to a page, newest first, with page numbers at the bottom.
3. Set **Show** (عرض) to **All** (الكل) or **Unread** (غير المقروءة), choose a **Category** (الفئة) or leave **All categories** (كل الفئات), and press **Filter** (تصفية). The page opens on All.
4. **Search this list** (ابحث في هذه القائمة) finds a word or a document number in the notification's stored text. The stored text is English, so on the Arabic screen search by the document's number.
5. **Clear** (مسح), shown while a search is active, removes the search and the filters together.
6. Press a notification's title to open what it is about; use the button in its row to mark it read or unread.
The address keeps the filters (/notifications?state=unread&category=invoices), so a filtered list can be bookmarked.

### Fields — Notifications
Columns of the page:
- **When** (الوقت) — how long ago it arrived; hover for the exact date and time, in the company's time zone.
- **Category** (الفئة) — one of **Approvals** (الموافقات), **Tasks** (المهام), **Chat** (المحادثات), **Documents** (المستندات), **Payments** (المدفوعات), **Invoices** (الفواتير), **Logistics** (الشحن والخدمات اللوجستية), **Accounting** (المحاسبة), **Human resources** (الموارد البشرية), **System** (النظام).
- **Notification** (الإشعار) — the title (a link when it can be opened) and a line of detail.
- **Status** (الحالة) — **Unread** (غير مقروء), **Read** (مقروء), or **No longer available** (لم يعد متاحاً).
- **Actions** (الإجراءات) — **Mark as read** (تحديد كمقروء) or **Mark as unread** (تحديد كغير مقروء).
Filters, all optional:
- **Show** (عرض) — **All** (الكل) or **Unread** (غير المقروءة).
- **Category** (الفئة) — **All categories** (كل الفئات) or one of the ten above.
In the bell the same choices are the two buttons **Unread** (غير المقروءة) and **All** (الكل) and the category drop-down.
Findings of the Exception Center arrive under Accounting whatever area they are about; notices of automation rules arrive under the category of their record (Invoices, Tasks, Logistics).

### What you are told about, and how often — Notifications
- Approvals — "Approval needed: <ref>" when a document on an approval route reaches you (never for one you submitted); "Approved: <ref>" or "Rejected: <ref>" to the person who submitted it; bank details waiting for verification.
- Tasks — a task was assigned to you, accepted, started, blocked, submitted for review, completed or reassigned, or changed in another way; a task is due soon or overdue.
- Chat — a new message (once for a run of unread messages; not for a muted conversation) and each mention of you. The text is the message as written.
- Documents — a file was linked to a record.
- Payments — a customer receipt was received; a supplier payment was made.
- Invoices — a sales or supplier invoice falls due soon, is due today, is overdue, or was paid late.
- Logistics — a container is late; a shipment's status changed; an import moved to another stage, was put on hold, or its hold has waited too long.
- Accounting — a period cannot close yet; the stock ledger check found something; a project reached its budget warning line; a new critical or high finding of the Exception Center.
- Human resources — the HR events described in the HR guide.
- System — system health needs attention, an automation rule was paused, and anything not filed elsewhere.
How often:
- One event tells you once. Reloading a page, or two people acting at the same moment, never doubles a notification.
- Conditions that last are repeated once each business day while they last: an invoice due soon, due today or overdue; a period that cannot close; stock ledger findings; a budget warning; system health. An invoice that stays overdue is therefore announced again every morning until it is settled. There is no weekly setting and no "stop reminding me".
- You are told only about kinds of record you were permitted to view, in your branches, at the moment the notice was raised.

### What happens next — Notifications
- A new notification can take up to half a minute to show on the bell (two minutes in a background tab). Opening the bell fetches the list at once.
- Read and unread marks are kept on your account, so they are the same on every device.
- Notifications are not deleted: there is no delete button, and read ones stay under **All** (الكل).
- A notification's text never changes after it is raised; only its read mark moves.
- **Mark all as read** (تحديد الكل كمقروء) is written once to the audit log, with how many were marked. Single marks and opening are not recorded.
- This screen has no setting for choosing which notifications you receive.
- HR notices, and the task notices for rejected, resumed, returned, cancelled and updated tasks, are shown in the English they were written in, on the Arabic screen too.

### Refusals — Notifications
- "That notification leads to something you can no longer open." (هذا الإشعار يقود إلى شيء لم يعد بإمكانك فتحه.) — shown in the red band at the top of the Notifications page after pressing such a notification. The band carries its usual heading "That could not be saved." although nothing was being saved. Nothing is wrong: the record is gone or no longer yours to open.
- **No longer available** (لم يعد متاحاً) — "You can no longer open what this was about." (لم يعد بإمكانك فتح ما يخصه هذا الإشعار.) — the same, said in the list. If you believe you should still see the record, ask an administrator about your branch or permission.
- "The notifications could not be loaded. Trying again shortly." (تعذّر تحميل الإشعارات. ستُعاد المحاولة بعد قليل.) — the bell could not reach the system. It retries by itself, waiting longer each time (up to five minutes). Check your connection.
- "Loading notifications..." (جارٍ تحميل الإشعارات...) — the list is being fetched; wait a moment.
- The number on the bell stops changing — your session has ended; the bell stops asking until you sign in again.
- "Not available to you" (غير متاح لك) on the page — your account holds no `view` on `notification` (an account with no role). Ask an administrator.

## Global Search (البحث الشامل)
Path: the magnifier in the top bar, or Ctrl K (⌘ K on a Mac) from any screen; the full page: Dashboard → Home → Global Search   |   Arabic: الرئيسية ← الرئيسية ← البحث الشامل
Address: /search
Needs: to be signed in (the menu entry needs `view` on `dashboard`). A kind of record is searched only if you hold `view` on it; a file is found only if you may open the record it is attached to.
What it is for: Finding a record, a document number, an attached file or a screen from anywhere, without knowing which list it is in. It shows only what you are allowed to open, and it only reads: nothing is saved, not even what you typed.

### How to search from anywhere (Ctrl K) — Global Search
1. Press Ctrl K (⌘ K on a Mac) on any screen, or the magnifier in the top bar. A box opens: "Search numbers, names, files and screens…" (ابحث بالأرقام والأسماء والملفات والشاشات…).
2. Before you type, it lists up to twelve of your screens, in alphabetical order, under **Screens** (الشاشات).
3. Type. From the first character it lists the matching screens (up to six). From the second character it also searches records; "Searching…" (جارٍ البحث…) shows while it looks.
4. Results come in groups, each under the name of its kind — Customers, Purchase invoices, Containers, Files — with up to five rows a group. The best match is first: a number typed in full comes before everything else.
5. Move with ↑ and ↓ and press Enter, or click a row. The record or the screen opens.
6. **See more** (عرض المزيد) under a group opens that group on the Search page. The last row, "See all results for “…”" (عرض كل النتائج لـ «…»), opens the whole result there.
7. Close the box with Esc, the ✕, a click outside it, or Ctrl K again.
The line at the bottom repeats the keys: "↑ ↓ to move · Enter to open · Esc to close · Ctrl K opens from anywhere".

### How to see every result on the Search page — Global Search
1. Open Dashboard → Home → Global Search, or choose "See all results" in the Ctrl K box. The page is titled **Global Search** (البحث الشامل): "Find a record, a number, a file or a screen. You see only what you are allowed to open."
2. Type in the search box and press Enter. The count beside it reads "N results".
3. Results are stacked in windows: **Screens** (الشاشات) first (up to eight), then one window for each kind of record, with up to ten rows each.
4. A window that holds more shows **See more** (عرض المزيد) in its title bar. Press it to see that kind alone, 25 rows to a page, with page numbers.
5. Or choose a **Record type** (نوع السجل) — **All record types** (كل أنواع السجلات), Screens, or one of the kinds you may view — and press **Filter** (تصفية).
6. Press a record's **Number** (الرقم), or a screen's name, to open it. **Clear** (مسح) empties the search and the type.
The address holds the phrase and the type (/search?q=…&type=…), so a search can be bookmarked or sent to a colleague, who will see only what they may open.

### What to type — Global Search
- A document number in full — for example PUR-HQ-2026-000012 — finds that document first. Purchase invoices entered before 2026-10-06 are numbered API-… and are found by that number (and by "API-12") too.
- Its short form: the letters of the series and the serial ("AP-12", "API 12"), or the serial alone ("12").
- The beginning of a number or code ("SUP-0000").
- A name or part of one: a customer, supplier, item, employee, project or account. Two characters match the beginning of a name; three or more also match inside it.
- A reference as the other party wrote it — a supplier's invoice number, a container number, a bill of lading number.
- A party's name also finds its documents: a supplier's name lists the supplier first, then the documents that name it, such as its invoices.
- A file's name finds the attachment; opening it opens the record the file hangs on.
- A screen's name, in the language your screen is in, finds the screen.
Rules:
- Capitals and small letters are the same.
- Arabic is matched leniently: أ, إ and آ as ا; ة as ه; ى as ي; with or without the marks; ١٢٣ as 123.
- With several words, every word must be found. At most four words and 80 characters are used.
- Records need at least two characters: "Type at least two characters to search records." (اكتب حرفين على الأقل للبحث في السجلات.)

### What each part shows — Global Search
In the Ctrl K box:
- A screen row shows the screen's name with its menu heading under it; "Not yet built" (لم تُنشأ بعد) marks a screen that is in the menu but not built.
- A record row shows its number and name; under them, where known, what a file is attached to, the party, the date and the amount; and at the end its status chip.
On the Search page each window of records has the columns:
- **Number** (الرقم) — the number or code, the link that opens the record; for a file, its name.
- **Name** (الاسم) — the record's name or description.
- **Related to** (متعلق بـ) — the customer or supplier; for a file, the kind of record it is attached to.
- **Date** (التاريخ) and **Amount** (المبلغ).
- **Status** (الحالة) — the same status words the record's own screen uses.
The **Screens** (الشاشات) window has **Screen** (الشاشة) and **Menu** (القائمة) — the heading the screen sits under.
An amount is shown only where you may see money for that kind of record. An employee never shows pay, and an item's price shows only with `view` on `price_list`.
The filter **Record type** (نوع السجل) offers only the kinds you may view, so its list differs from one person to another.

### What Search finds and does not find — Global Search
It finds, each only with `view` on that kind of record: **Customers** (العملاء), **Suppliers** (الموردون), **Employees** (الموظفون), **Items** (الأصناف), **Warehouses** (المستودعات), **Bank and cash accounts** (الحسابات البنكية والنقدية), **G/L accounts** (حسابات الأستاذ العام), **Projects** (المشاريع), **Purchase invoices** (فواتير المشتريات), **Sales invoices** (فواتير المبيعات), **Supplier payments** (مدفوعات الموردين), **Customer receipts** (مقبوضات العملاء), **Payment applications** (طلبات الدفع), **Purchase orders** (أوامر الشراء), **Goods receipts** (استلامات البضائع), **Sales returns** (مرتجعات المبيعات), **Journal entries** (قيود اليومية), **Bank loans** (القروض المصرفية), tasks (headed **Task** — مهمة), **Exceptions** (الاستثناءات), **Imports and payables** (الاستيراد والمستحقات), **Bills of lading** (بوالص الشحن), **Containers** (الحاويات), **Customs pre-declarations** (البيانات الجمركية المسبقة), **Customs declarations** (البيانات الجمركية), **Files** (الملفات) and **Screens** (الشاشات).
It does not find:
- Records of a kind you may not view, or of a branch you are not assigned to. They are left out as if they did not exist.
- Sales orders and delivery notes, chat messages, files kept in Qimah Al-Safinah Cloud Files, and the text inside a file (a file is found by its name only).
- Old documents by name. In a long list of documents a name or description is matched only among the newest 10,000 records you may see. An older document is still found by its number, its serial, the beginning of its reference, or its party's name. Customers, suppliers, items, warehouses and accounts are always searched in full.
- More than 1,000 rows of one kind: paging stops there, so narrow the phrase instead.
Search keeps no history: there is no list of recent searches, and what you type is not recorded.

### Refusals — Global Search
- "Nothing found for “…”." (لا توجد نتائج لـ «…».) in the Ctrl K box, or "Nothing matches “…”." (لا شيء يطابق «…».) on the page — try fewer letters, the number instead of the name, or another spelling. The record may also be of a kind or a branch you may not see.
- "Type at least two characters to search records." (اكتب حرفين على الأقل للبحث في السجلات.) — one character searches screens only.
- "Type a number, a name, a file name or a screen to search." (اكتب رقمًا أو اسمًا أو اسم ملف أو شاشة للبحث.) — the page with an empty box.
- "Not searched this time: <kinds>." (لم يُبحث فيها هذه المرة: …) — one kind of record took too long (each is given five seconds) or failed; the other groups are complete. Search again, with a longer phrase.
- "Search is unavailable. Try again in a moment." (البحث غير متاح. حاول مرة أخرى بعد قليل.) — the system could not be reached.
- "Sign in again to search." (سجّل الدخول من جديد للبحث.) — your session has ended.

## Saved views (العروض المحفوظة)
Path: the Views (العروض) button on a list screen; all your views: your own menu → Profile settings → Saved views
Address: /profile/views
Needs: to be signed in. A view can be saved, opened, made the default, pinned or duplicated only for a screen you may open now.
What it is for: Keeping the filters of a list under a name — "Unpaid imports", "Containers arriving this month" — so the list opens that way with one press, by itself when you arrive (a default view), or from Home (a pinned view). A view holds filters, never records, and only you can see it.

### How to save the filters on screen as a view — Saved views
1. Open a list that has the **Views** (العروض) button (see "Which screens have Views — Saved views"), set its search and filters, and press the list's own Filter button so the list shows them. A filter you changed but did not apply is not saved.
2. Press **Views** (العروض), the button with the bookmark icon. When you already keep views of this screen it shows how many: "Views (3)". The window **Saved views** (العروض المحفوظة) opens.
3. Under **Save the filters on screen** (حفظ المرشّحات الظاهرة على الشاشة) read the line "This view will keep: …" (سيحتفظ هذا العرض بـ: …): it lists exactly what will be stored. With no filter set it says "No filters are set, so this view will open the screen as it comes."
4. Type a **View name** (اسم العرض).
5. If the screen has dates, a box beside the name asks what to do with them. Leave **The dates shown now** (التواريخ المعروضة الآن) to keep those exact dates, or pick a rule such as **This month** (هذا الشهر) so the view works the dates out again each day it is opened.
6. Press **Save view** (حفظ العرض). "Saved." (تم الحفظ.) confirms, and the view is listed under **Your views of this screen** (عروضك لهذه الشاشة).

### How to open a saved view — Saved views
1. On the list, press **Views** (العروض) and, under **Your views of this screen** (عروضك لهذه الشاشة), press **Open** (فتح) on the view. The window closes and the list reloads with those filters. The next time you open Views, that view wears the badge **Showing now** (معروض الآن).
2. From anywhere: open your own menu → Profile settings → the line **Saved views** (العروض المحفوظة), then press **Open** (فتح) on the view.
3. From Home: press the view's name in **My pinned views** (عروضي المثبتة), if you pinned it.
Opening a view only sets the list's filters. The list then reads its records afresh, as you, today: a view never shows more than you are allowed to see, and a view with a date rule uses today's dates.
You may change the filters after opening; the saved view is not altered. A view's filters cannot be edited: set the new filters, save them under a new name and delete the old view.

### How to make a view the default of its screen — Saved views
1. Press **Views** (العروض), then **Make default** (جعله الافتراضي) on the view. It gets the badge **Default** (الافتراضي). A screen has one default: choosing another replaces the earlier one.
2. From then on, arriving at the screen without any filter — from the menu, a tab or a plain link — opens it in that view.
3. The default is not applied when the address already carries a search or a filter: a bookmark or link that holds filters, or after you press the list's Filter button, even with the filters empty.
4. To see the plain list once, press **Views** (العروض), then **Show without a view** (عرض الشاشة بدون عرض محفوظ).
5. To stop, press **Remove default** (إلغاء الافتراضي) on the view.
A default view that keeps no filters changes nothing, because it asks for what the screen shows anyway.

### How to pin a view to Home — Saved views
1. Press **Views** (العروض), then **Pin to Home** (تثبيت في الرئيسية) on the view. It gets the badge **On Home** (في الرئيسية).
2. Home lists it under **My pinned views** (عروضي المثبتة), oldest pin first, with its name as a link and, in **Rows** (الصفوف), how many rows the view lists today.
3. **Unpin** (إلغاء التثبيت) takes it off Home; the view itself stays.
At most 12 views can be pinned.
The row count is shown for Purchase Invoices, Payables Ageing, Suppliers, Receivables Ageing, Customers, Containers, Customs Pre-Declarations, Customs Declarations and Availability. A pinned view of any other screen opens normally and shows — instead of a number.
The count is worked out when Home opens, as you; it is never stored.

### How to rename, duplicate or delete a view — Saved views
1. To rename, change the name in the box where the view's name stands and press **Rename** (إعادة تسمية).
2. To copy, press **Duplicate** (تكرار). The copy is named "<name> (copy)" — if that is taken, "(2)", "(3)" and so on are added — and keeps the same filters. It is neither the default nor pinned.
3. To delete, press **Delete** (حذف). A window asks "Delete this view?" (حذف هذا العرض؟) — "“<name>” is deleted. Only the saved filters go; the screen and its records are not affected." Press **Delete** (حذف) to confirm, or **Cancel** (إلغاء).
4. "Saved." (تم الحفظ.) confirms each of these.
The same buttons are in the Views window of the list and on the Saved views page.

### How to manage all your views — Saved views
1. Open your own menu → **Profile settings** (إعدادات الملف الشخصي). In the **Account** (الحساب) panel the line **Saved views** (العروض المحفوظة) shows how many you keep ("3 views", or "None yet"); press it. Or press **All my views** (كل عروضي) at the foot of any Views window. The address is /profile/views.
2. The page **Saved views** (العروض المحفوظة) lists every view of every screen: **Screen** (الشاشة); **View** (العرض) — the name box with **Rename** (إعادة تسمية) and the badges; **Filters** (المرشّحات) — what the view keeps, in words; **Actions** (إجراءات) — **Open** (فتح), **Make default** (جعله الافتراضي) or **Remove default** (إلغاء الافتراضي), **Pin to Home** (تثبيت في الرئيسية) or **Unpin** (إلغاء التثبيت), **Duplicate** (تكرار), **Delete** (حذف).
3. **Search this list** (ابحث في هذه القائمة) finds a view by its name or by its screen's name; **Clear** (مسح), shown while a search is active, removes it.
4. Beside the search box the page counts "N of 100 views · M of 12 pinned to Home".
With no views it says "You have no saved views yet. Open a list, set its filters and choose Views, then Save view." (ليست لديك عروض محفوظة بعد…); when the search matches none, "No view matches the search." (لا يوجد عرض يطابق البحث.)

### Fields — Saved views
- **View name** (اسم العرض) — required; one line of at most 80 characters; it must differ from your other views of the same screen. The box suggests "e.g. Overdue suppliers" (مثال: الموردون المتأخرون).
- The date box — only on screens with dates; optional. It is labelled **Dates** (التواريخ), **ETA window** (نافذة الوصول المتوقع) or **As at** (كما في), and opens on **The dates shown now** (التواريخ المعروضة الآن).
- Rules for a from–to pair (Dates, ETA window): **Today** (اليوم), **This month** (هذا الشهر), **Last month** (الشهر الماضي), **Next month** (الشهر القادم), **Next 7 days** (الأيام السبعة القادمة), **Next 30 days** (الثلاثون يومًا القادمة), **Last 7 days** (الأيام السبعة الماضية), **Last 30 days** (الثلاثون يومًا الماضية), **Month to date** (منذ بداية الشهر), **Year to date** (منذ بداية السنة), **This year** (هذه السنة), **Up to today** (حتى اليوم), **From today** (من اليوم).
- Rules for a single date (As at): **Today** (اليوم), **Start of this month** (بداية هذا الشهر), **End of this month** (نهاية هذا الشهر), **End of last month** (نهاية الشهر الماضي), **Start of this year** (بداية هذه السنة).
- Badges on a view: **Showing now** (معروض الآن) — the list is showing exactly this view; **Default** (الافتراضي); **On Home** (في الرئيسية); **Unavailable — you no longer have access** (غير متاح — لم تعد لديك صلاحية); **Unavailable — screen not available** (غير متاح — الشاشة غير متوفرة); **Unavailable — screen removed** (غير متاح — أُزيلت الشاشة).
- The summary under a view's name lists each filter and its value; a date kept as a rule reads as the rule; a view with none reads **No filters** (بدون مرشّحات).
"Today" in a rule is the company's business day.

### Which screens have Views — Saved views
The **Views** (العروض) button is on these screens. A view keeps the search word and that screen's filters; the date box offered is in brackets.
- Payables: Purchase Invoices — including **Minimum amount (IQD)** (الحد الأدنى للمبلغ (د.ع)); Payables Ageing [As at]; Suppliers — including **Status** (الحالة).
- Receivables: Receivables Ageing [As at]; Sales Invoices; Customer Receipts; Customers — including **Status** (الحالة).
- Logistics: Containers — including **ETA from** (الوصول المتوقع من) and **ETA to** (الوصول المتوقع إلى) [ETA window]; Bills of Lading; Customs Pre-Declarations; Customs Declarations; Shipment Tracking; In-Transit Inventory.
- Inventory: Availability; Stock Movement [Dates]; Stock Ledger [Dates].
- Dashboard: Exceptions.
On most of these the button is in the toolbar, beside the search box and the row count. On the four that have no search box — Payables Ageing, Receivables Ageing, Stock Movement, Stock Ledger — it is at the top of the page beside the title.
Screens not named here have no Views button; to keep their filters, bookmark the filtered page. The button is also absent on a screen you may not open.

### After you save — Saved views
- A view is stored on your account and follows you to any device. Nobody else — not an administrator, not a Super User — can see or use it. There is no sharing.
- You may keep 100 views in all and pin 12 to Home.
- Every save, rename, copy, delete, default and pin is written to the audit log.
- If your permission for a screen is later withdrawn, its views stay listed and are marked Unavailable with the reason. They cannot be opened, made the default, pinned or duplicated, but they can still be renamed, unpinned, taken off default and deleted. On Home such a pinned view reads **Not available** (غير متاح).
- If a screen later drops a filter that a view kept, the view still opens with the rest and says "These filters no longer apply to the screen and are left out: …" (لم تعد هذه المرشّحات تنطبق على الشاشة وقد استُبعدت: …).

### What a view does not keep — Saved views
- The sort order and the choice of columns are not stored.
- The page number is not stored; a view opens on the first page.
- Rows, totals and amounts owed are never stored: a view is a question, and the answer is read again each time.
- A filter that was typed but not applied before pressing Views.
- A view cannot be shared. To hand a filtered list to a colleague, send them the page's address; they will see what their own permissions allow.
- A view's filters cannot be edited in place.
- An amount in a view's summary is shown as stored (1000000, not 1,000,000).
- The **Views** (العروض) drop-down inside the filters of Import Applications (All open, Stopped…) is a different thing: ready-made filters supplied with the system, described with that screen. Import Applications has no Views button.

### Refusals — Saved views
These appear in the red band, in your language.
- "A view needs a name." (العرض يحتاج إلى اسم.)
- "A view name is at most 80 characters." (اسم العرض لا يزيد على 80 حرفًا.)
- "A view name is one line of text." (اسم العرض سطر واحد من النص.)
- "You already have a view named “…” on this screen." (لديك بالفعل عرض باسم «…» على هذه الشاشة.) — choose another name; the same name may be used on a different screen.
- "At most 100 views can be kept; delete one first." (يمكن الاحتفاظ بـ 100 عرضًا على الأكثر؛ احذف عرضًا أولًا.) — at the limit this sentence also replaces the save form in the Views window.
- "At most 12 views can be pinned to Home; unpin one first." (يمكن تثبيت 12 عروض على الأكثر في الرئيسية؛ ألغِ تثبيت أحدها أولًا.)
- "You can no longer open this screen, so the view cannot be used." (لم يعد بإمكانك فتح هذه الشاشة، لذا لا يمكن استخدام العرض.) — your permission for the screen was withdrawn; ask an administrator, or delete the view.
- "That view does not exist, or it is not yours." (هذا العرض غير موجود أو ليس لك.) — it was deleted meanwhile, for example in another tab; reload the page.
- "That screen cannot be saved as a view." (لا يمكن حفظ هذه الشاشة كعرض.), "That date rule is not one this screen offers." (قاعدة التاريخ هذه غير متاحة في هذه الشاشة.) and "That view carries too many filters." (يحتوي هذا العرض على مرشّحات أكثر من اللازم.) — not met through the buttons; reload the page and save again.
