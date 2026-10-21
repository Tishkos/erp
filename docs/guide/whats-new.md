# What is new — user guide

What changed in each version of the system, newest first: what is new, what was fixed, and what a person has to do. Answer "what is new", "the newest update", "the latest version", "the changelog", "release notes", «ما الجديد», «آخر تحديث», «التحديث الجديد», «شنو الجديد» from here. The version that is running is shown in the footer of every screen.

## What is new in version 1.1.5 (ما الجديد في الإصدار 1.1.5)
Version 1.1.5 is the newest version of the system (الإصدار الأحدث). It went live on 21 October 2026. What to do: reload the page once (حدّثوا الصفحة مرة واحدة).

### New: printed copies in the company's look — What is new in version 1.1.5
- Every printout and PDF (invoices, payments, statements, reports, and the PDFs Noah sends) now carries the company's look (تصميم الشركة): the Q logo, the logo's dark blue, a clean table, the details on a soft card, and the logo faint behind every page. The system's name is no longer printed anywhere.
- A new, clearer Arabic font (خط عربي جديد) that also writes Kurdish letters; text copied from the PDF reads correctly.
- **The amount in words** (المبلغ كتابةً) under the figures, in English and Arabic — for example "فقط ألفان دينار عراقي لا غير".
- Tables fit the page better: numbers take only the room they need, so descriptions stay on one line and long reports take fewer pages.

### New: the transit warehouses list their goods — What is new in version 1.1.5
- On Inventory → Warehouses Report, the goods of imports on their way are listed among the items of their warehouse — On Process (Without SWIFT), In Process, On Board, At Port — marked **On the way (not in stock)** (في الطريق (ليست في المخزون)), and the item search finds them. The summary's Items and Units count them too, said under the figure.

## What is new in version 1.1.4 (ما الجديد في الإصدار 1.1.4)
Version 1.1.4 went live on 21 October 2026, before version 1.1.5 above. What to do: reload the page once (حدّثوا الصفحة مرة واحدة).

### New: goods on the way in the warehouses — What is new in version 1.1.4
- Inventory → Warehouses Report now shows **Goods on the way — not in stock yet** (بضائع في الطريق — لم تدخل المخزون بعد): every container not yet received, at On Process (Without SWIFT), In Process, On board, At port or Customs cleared, with its import, supplier, goods, quantity and expected arrival. Choose On Board (or another stage) under Warehouse Name to see only that stage. These goods are not stock yet — they enter a warehouse when the container is received.
- The **On the way (not in stock)** column of the summary says how many containers and units each stage warehouse has on the way, and each stage warehouse's own page lists them.

### New: item search in the warehouses — What is new in version 1.1.4
- Search an item on the Warehouses Report (it also finds goods on the way, e.g. "panel"), on any warehouse's own page, or from the Warehouses list with **Find an item in the warehouses** (ابحث عن مادة في المخازن).

## What is new in version 1.1.3 (ما الجديد في الإصدار 1.1.3)
Version 1.1.3 went live on 21 October 2026, before version 1.1.4 above. What to do: reload the page once (حدّثوا الصفحة مرة واحدة).

### Fixed: a cash account on a ledger account of another currency — What is new in version 1.1.3
- A cash or bank account in dinars could be linked to a ledger account that takes dollars only (or the other way round), and then its receipts and payments were refused. Bank/Cash Accounts now refuses that choice and says which currency the ledger account takes.

## What is new in version 1.1.2 (ما الجديد في الإصدار 1.1.2)
Version 1.1.2 went live on 21 October 2026, before version 1.1.3 above. What to do: reload the page once (حدّثوا الصفحة مرة واحدة).

### Fixed: SWIFTs paid from a USD bank account — What is new in version 1.1.2
- **Paid** on a payment application paid from a USD account (Mansour Bank USD and the others) was refused with "it accepts USD only, and this entry is in IQD". It now posts: the dollars on the bank's side, the dinars on the supplier's side, converted automatically.
- Before anything is created, the Paid window shows the exchange rate of the paid date — "1 USD = … IQD" — and what the payment comes to in dinars, and asks you to tick **This exchange rate is correct**. If the rate is wrong, correct it under Currencies and Rates first.

## What is new in version 1.1.1 (ما الجديد في الإصدار 1.1.1)
Version 1.1.1 went live on 21 October 2026, before version 1.1.2 above. What to do: reload the page once (حدّثوا الصفحة مرة واحدة).
Also asked as: the newest update, the latest update, what changed today — آخر تحديث، التحديث الجديد، شنو الجديد.

### New: Leads → Opportunities → Projects — What is new in version 1.1.1
- Under Projects → Projects & Planning there are now **Leads** (العملاء المحتملون — the old Project Initiation register), **Opportunities** (الفرص) and the **Pipeline Board** (لوحة المسار), then Project Master. A client keeps one number (PIN-…) from lead to project.
- The board shows every client as a card in its column and updates by itself; record pages show an **Updates** list and refresh by themselves too (the green **Live** badge).

### New: Financed customers (Renewable Energy Financing) — What is new in version 1.1.1
- **New initiation** offers a third type: **Financed Customer** (عميل ممول). Seven stages: Customer (name, city, phone) → Quotation Sent (agreed / refused) → Bank Approval (approved / rejected) → Loan — First Payment → Installation → Contract → Loan — Fully Granted, then it becomes a project.

### New: Live container tracking — What is new in version 1.1.1
- Each container's page has **Live tracking**: where the shipping line says the box is, the vessel, the line's expected arrival beside ours, and every event — refreshed every five minutes, never saved. A link opens the line's own tracking page. The live feed for each line starts once its API key is entered on the server.

### Fixed: invoices that would not post for want of a COGS account — What is new in version 1.1.1
- Items → **Category accounts** (حسابات الفئات) sets the inventory and COGS accounts per item category, and a company default. Saving fills every item that had none, and new items take them. A sales invoice that was refused can then be posted again; its approval stands.

### Fixed: notification titles — What is new in version 1.1.1
- A reminder such as "Payable hold escalated" showed a long code instead of the import's number. It now shows the number (for example IMP-HQ-2026-000002). Reminders already sent keep their old title.

### Changed: not enough money, and who sees balances — What is new in version 1.1.1
- A payment application is no longer stopped when its bank or cash account does not hold enough money: it can be submitted, approved, sent and paid, and its page warns that paying it takes the account below zero.
- Only people who may see bank balances (Bank and Cash Reporting) see the amounts; everyone else sees the warning without figures. No error message shows an account's balance any more.

## What is new in version 1.1.0 (ما الجديد في الإصدار 1.1.0)
Version 1.1.0 went live on 13 October 2026, before version 1.1.1 above. It went live on 13 October 2026.
What to do: reload the page once (حدّثوا الصفحة مرة واحدة) so the browser loads the new version. Nothing else is needed; no data was changed.
In short: one new screen — **Project Initiation** (تأسيس المشاريع) — and four fixes. The blocks below say each in detail.
Also asked as: the newest update, the latest update, the latest version, the new version, the changelog, the release notes, what changed, what was updated — آخر تحديث، التحديث الجديد، التحديث الأخير، الإصدار الجديد، شنو الجديد، ما الذي تغيّر، سجل التغييرات.

### New: Project Initiation — What is new in version 1.1.0
- Where: Projects → Projects & Planning → **Project Initiation** (المشاريع ← المشاريع والتخطيط ← تأسيس المشاريع). It is the first screen under Projects.
- What it is: every customer project now starts here, before it is a project. Press **New initiation** (تأسيس جديد) and choose the project type: **Direct Sales Project** (مشروع بيع مباشر) or **Tender Project** (مشروع مناقصة).
- A direct sale goes through six stages: Sales Lead, Opportunity and Pre-Sales Form, Site Survey Design, BOQ Costing, Proposal Follow-up, Contract Signing.
- A tender goes through six stages: Tender Lead, Go / No-Go, Site Visit & Pre-Bid Meeting, Tender Design BOQ, Compliance Matrix & Bidding, Submission & Award.
- One stage at a time. A note at the top of the record says what the current stage still needs; the button **Next stage** (المرحلة التالية) appears when nothing is missing.
- The Pre-Sales Form holds the site (GPS coordinates, governorate, area, land or rooftop), the contact person, and the system type (On-Grid, Off-Grid, Hybrid, BESS, Solar Pumping). The customer's documents are attached with the paperclip of that stage.
- The bill of quantities (BOQ, جدول الكميات) is typed line by line: material, shipping and installation costs, with totals.
- When the contract is signed, a second person presses **Confirm contract and create project** (تأكيد العقد وإنشاء المشروع). The record becomes a released project by itself, with the contract value and the BOQ total as its budget. The project's page shows the form, the files and the BOQ.
- A Direct Sales or a Tender project can no longer be created directly on Project Master; it comes only from Project Initiation. Internal and investment projects are still created on Project Master.
- The full instructions are in the guide under "Project Initiation".
- Also asked as: what is new in the latest update, the new screen, the new feature — الجديد في آخر تحديث، الشاشة الجديدة، الميزة الجديدة.

### Fixed — What is new in version 1.1.0
- **The error when moving from Settings to Accounting.** With the side panel, going from one module to another sometimes replaced the whole screen with "This screen could not be shown" (تعذّر عرض هذه الشاشة). It happened most often from Settings to Accounting. It is fixed; the menu no longer breaks when you change module.
- **A record that does not exist.** Opening a project, a user or a container that is not there showed an error page. It now says "That page does not exist" (هذه الصفحة غير موجودة), with clearer words.
- **The "Enrol your authenticator" notification** (سجّل تطبيق المصادقة) showed a code instead of its text in the bell. It now shows the date properly.
- **Being signed out by mistake.** When the server was slow for a moment, a person could be sent to the sign-in page and the chat and the bell stopped updating until the page was reloaded. This no longer happens.
- Screens also open a little faster: the system does less work on every click.
- Also asked as: what was fixed in the latest update, the fixes, the bugs fixed, the changelog — ما الذي أُصلح في آخر تحديث، الإصلاحات، سجل التغييرات.

### How to ask about an update — What is new in version 1.1.0
- In the WhatsApp group, write a message that begins with `!ai`, for example: `!ai what is new in the update?` or `!ai ما الجديد في التحديث؟`.
- In the system, press the assistant button in the bottom corner of any screen and ask the same question; no `!ai` is needed there.
- To learn the new screen step by step, ask: "how do I open a new project initiation?" (كيف أفتح تأسيس مشروع جديد؟).
