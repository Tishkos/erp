# Changelog

Every release has a version, a tag, scope, migration notes, test evidence and
a rollback plan (blueprint §25; REQ-IMPROVE-001 OP-11). The version is
`package.json`'s and is what the footer shows; the tag is `v<version>`;
`docs/RELEASE.md` says how one is cut.

## Unreleased

## 1.1.6 — 2026-10-22

### Changed — printed copies
- The amount in words now stands beside the **amount in figures with its currency** ("52,120,000 IQD"), in the PDF, the Word file and the browser's print (by direction: "no amount in numbers … should contain the amount in numbers and currency too").
- A table's **heading and the cells under it are centred together**, and each cell sits in the middle of its row's height; the first column of an indented statement keeps to its reading start.

### Changed — the company's name instead of "QS"
- The application's name is **Qimah Al-Safinah** (قمة السفینە in Arabic) wherever it said "QS ERP": the browser tab, the brand, the WhatsApp answer's footer, the maintenance page, the authenticator's default label; "QS Cloud Files" is **Qimah Al-Safinah Cloud Files**; the guide follows.

### Migrations
- None. Rollback: the previous build.

### Test evidence
- The unit suite (166 files), `tests/integration/ops14-print-export.test.ts`, `tests/integration/wa02-intents.test.ts`.

## 1.1.5 — 2026-10-21

### New — printed copies in the company's look
- Every PDF (documents, reports, statements, the copies Noah sends), the Word file and the browser's print carry the company's look: the Q mark alone — no product name anywhere on paper or in the file's properties — the logo's navy as one solid colour (the band at the top and foot of each page, the table heading, the result's bar), the header fields on a soft card, soft alternate rows, signature lines, and who printed it, when and where in the foot of every page.
- A new font, **Vazirmatn**: Arabic, Kurdish and Persian letters and Latin, every letter one glyph, so a copy or a search of the PDF's text reads as printed. Arrows and other characters it lacks come from IBM Plex Sans Arabic instead of printing as a box.
- The type follows the page: a table's size follows its columns and the orientation, figures and codes take only the width they need, so descriptions read on one line (a 70-line ledger: 6 pages → 4). The browser's print reads in one column on a phone.
- **The amount in words** under the figures, in English and Arabic ("Two thousand Iraqi dinars only" / "فقط ألفان دينار عراقي لا غير"), dollars with their cents: a payment's or receipt's amount, an invoice's total, a payslip's and a payroll run's net; reports are not spelt.
- **The logo, faint, behind every page** in all three formats.

### New — the transit warehouses' items are not empty
- On the Warehouses Report the imports' goods on the way are listed among the items of their stage warehouse (On Process (Without SWIFT), In Process, On Board, At Port) — one line per item or description and unit, marked *On the way (not in stock)*, with no cost or value and outside the totals — and the item search finds them. The summary's Items and Units add them, said under the figure ("incl. 4 on the way"); an item both in stock and on the way counts once. Quantities are written with thousands separators.

### Migrations
- None. Rollback: the previous build.

### Test evidence
- `tests/unit/print-words.test.ts`, `tests/unit/print-format.test.ts`, `tests/integration/ops14-print-export.test.ts` (25), `tests/integration/wh01-goods-on-the-way.test.ts` (6), `tests/e2e/inventory-screens.spec.ts` (Warehouses Report, Warehouses).

## 1.1.4 — 2026-10-21

### New — where the imports' goods are, on the warehouse screens
- The Warehouses Report has **Goods on the way — not in stock yet**: every container not received, at its stage (On Process (Without SWIFT), In Process, On board, At port, Customs cleared), with its import, supplier, goods, quantity and ETA, and each import with no container yet. The imports taken over from the sheet have no stock (their containers carry descriptions only) and nothing moves stock through On Board or At Port, so those warehouses read 0 in stock; this shows what is really there. The placing is the Import Applications' own Goods filter.
- The summary's **On the way (not in stock)** column gives each stage warehouse its containers, imports and units; choosing a stage warehouse shows its goods first; a stage warehouse's own page shows them too.
- **Item search**: the report's search reaches the goods on the way (item, the container's description such as "panel", container or import number); every warehouse's page searches its own stock; the Warehouses list has **Find an item in the warehouses**.

### Migrations
- None. Read-only; nothing is stored. Rollback: the previous build.

### Test evidence
- `tests/integration/wh01-goods-on-the-way.test.ts`, `tests/e2e/inventory-screens.spec.ts` (Warehouses Report, Warehouses).

## 1.1.3 — 2026-10-21

### Fixed — a cash or bank account linked to a ledger account of another currency
- A cash account in dinars could be linked to "Cash on hand (USD)", a ledger account that takes dollars only, and then every receipt into it was refused at posting (CASH-000001 on live). Bank/Cash Accounts now refuses a ledger account whose currency is not the account's own, when it is chosen or when the currency is changed; an account already linked that way can still be opened, renamed and corrected.

### Migrations
- None. Rollback: the previous build.

### Test evidence
- `tests/integration/fx1-bank-deposits.test.ts` (the currency rule), `ops06-bank-cash.test.ts`.

## 1.1.2 — 2026-10-21

### Fixed — a SWIFT paid from a USD bank account could not be recorded
- Pressing **Paid** on a payment application paid from a USD bank account was refused: "Cannot post to A000031: it accepts USD only, and this entry is in IQD". The payment is now posted in dollars on the bank's side (the exact SWIFT amount) and in dinars on the supplier's side, at the accounting rate of the paid date — automatically. The supplier advance (a deposit before the invoice) is posted the same way.
- **The rate is confirmed first.** The Paid window shows the exchange rate of the paid date and what the payment comes to in dinars, and asks "This exchange rate is correct"; nothing is created until it is ticked, and a rate changed in the meantime is refused.

### Migrations
- None.

### Rollback
- The previous build (`.next-prev`). Payments posted under 1.1.2 keep their dollar lines; the old build reads them as any journal.

### Test evidence
- `tests/integration/iob01-import-opening-balances.test.ts` (IOB5: USD-only bank, IQD-only supplier, rate refused unconfirmed and confirmed against another rate, then posted); the payment and posting suites; the unit suite.

## 1.1.1 — 2026-10-21

What went live today (57e78c8, deployed 2026-10-21 03:32 Baghdad) and the
fix after it, with the earlier unnumbered deploys listed below it since 1.1.0.

### Added — Leads → Opportunities → Projects
- **Three screens over one record.** Projects & Planning now reads **Leads** (the Project Initiation register), **Opportunities** (past the first stage, not yet a project) and the **Pipeline Board**, then Project Master. A client keeps one number (PIN-…) from lead to project.
- **The Renewable Energy Financing Initiative** is a third type, *Financed Customer*: Customer → Quotation sent (agreed / refused) → Bank approval → Loan, first payment → Installation → Contract → Loan fully granted, then an Active Project (type FINANCING). Each stage moves on only on its good outcome.
- **Live:** every record has an Updates list; record pages and the board redraw themselves when something changes.

### Added — live container tracking
- Each container's page asks its shipping line where the box is (DCSA Track & Trace; the line from the container number or the B/L) and shows the events, the vessel and the line's expected arrival beside ours. Kept in memory, never stored. Live per line once its API key is on the server (`TRACKING_<LINE>_URL` / `_KEY`); meanwhile a link to the line's own tracking page.

### Fixed — a sales invoice refused for want of a COGS account
- Items → **Category accounts**: inventory and COGS defaults per item category and for the company; saving fills the items that had none, new items take them.

### Changed — not enough money; who sees a balance
- **A payment application goes on when its account is short** — submitted, approved, sent and paid — and its page warns that paying it takes the account below zero. Other payments are still refused; money into an account below zero now always goes in (before, such an account refused even deposits).
- **A balance is shown only to whoever reads the treasury's balances** (Bank and Cash Reporting); no error message names what an account holds any more.

### Fixed — notification titles
- A notice whose sender gave no reference was titled with the record's database id ("Payable hold escalated — 215182bf-…"); it is titled with the record's number now (IMP-HQ-2026-000002). Notices already sent keep their titles.

### Migrations
- `0423_item_category_accounts` — a table; no data changed.
- `0424_project_initiation_financing` — columns and checks on `project_initiation`, the guard per road, project type FINANCING; no data changed.
- `0425_bank_overdraft_payment_applications` — C-20 narrowed (`assert_bank_not_negative(account, entry)`); no data changed.

### Rollback
- The previous build (`.next-prev`). The three migrations are additive; with the old build 0425's guard stays, which only lets more through, and the new columns are unread.

### Test evidence
- Unit suite (2,647 tests); integration `pg01-project-initiation`, `item-category-accounts`, `ap03-payments`, `treasury`, `treasury-cash-advance`, `pa02`, `adv01`, `wa19`, `ta01`; e2e `project-initiation.spec.ts` (three tests). The deploy of 57e78c8 ran with `SKIP_INTEGRATION` ("targeted suites green 2026-10-21 …").


### Added — the demo at accounting.qs-groups.com (2026-10-16)
- **A demo of the system, signed in as admin / admin.** The same release on its own database (`erp_demo`, built from nothing: the chart, a fiscal year, the stage warehouses), its own process and files, one account. It replaces the Odoo trial that answered at that address, which was removed for good. The demo sends nothing — no mail, no WhatsApp, no AI — and follows every live deploy.
- **Demo mode** (`ERP_DEMO=on`, ignored on the live database): the sign-in takes a user name, nobody is asked for an authenticator, and the demo account's password cannot be changed, so the next visitor can sign in. Live is unchanged.
- Rollout: deploy, then on the server `bash /opt/qs-erp-next/scripts/ops/demo-instance.sh create`. Rollback: `pm2 delete qs-erp-demo` and take the vhost out of `sites-enabled` (Odoo is not coming back). Test evidence: `tests/unit/demo-mode.test.ts`; the build of `erp_demo` and the admin / admin sign-in rehearsed on a scratch database.

### Added — the sheet's imports on the suppliers' accounts (2026-10-15)
- **Supplier balances include the imports.** Each import brought in from the sheet that still owes something gets its opening balance: a posted purchase invoice for what it still owed when it was brought in (agreed less paid), on the supplier's account in dinars at that day's rate and in exact dollars. Supplier Statements, Payables Ageing, Supplier Reconciliation and the supplier's profile show it like any bill. The import's own figures, stage and goods position do not change.
- **A payment on such an import can be confirmed.** It was refused (no invoice, no purchase order); it now pays the opening, and the exchange difference closes the supplier once the import is paid in full. Money the bank's copy shows left before the cut-over comes off the opening without a second payment.
- **The supplier's own invoice for the import, entered later, is not owed twice:** it is settled against the opening. Reversing it undoes that; the opening is not reversed while such an invoice rests on it.
- Migration: `0422_import_opening_balances` (a column on `ap_invoice`, the table `import_opening_settlement`, the posting event `payables.import_opening_balance`). After the deploy the openings are posted once on live with `var/sheet-work/import-openings.sh` (dry run, then `--apply`; a dump first). Rollback: the previous build; the openings are reversed invoice by invoice (Reverse, while nothing rests on them). Test evidence: `tests/integration/iob01-import-opening-balances.test.ts`; control C-96.

### Changed — Transfers & Applications (2026-10-15)
- **Search by name, word by word.** Import Applications and Payment Applications find a row by any part of the supplier's name or code ("ham" finds Hama), words in any order; Import Applications also by the numbers of its payment applications, PDs, B/Ls, containers and invoices.
- **More filters.** Import Applications: supplier, stage, payment (none / pending / at the bank / part paid / fully paid), where the goods are, open / cleared / cancelled. Payment Applications: status groups (pending, not with the bank yet, paid, closed) and every status, supplier, bank, currency.
- **One import, one bank.** Once an import has a live payment application from a bank, every later one goes through the same bank; the form offers only that bank's accounts.
- **What is typed is kept.** The new payment application form keeps its values in the browser per import — through a tab change, a reload or a refused save — and lists the applications in progress.
- **Rejected / cancelled needs the reason, not a file.**
- Migrations: none. Rollback: the previous build (`.next-prev`). Test evidence: `tests/unit/ta01-transfers-applications.test.ts`, `tests/integration/ta01-transfers-applications.test.ts`.

### Changed — the WhatsApp group
- **A notice for the whole team is tagged `@all`** (by direction, 2026-10-13: "the tagging should be @all, not specific names"). The team's message no longer lists the people it could tag by name; it says `@all`, and every member of the group is notified. A person's own alert still tags that person. An answer written by the AI cannot tag the whole group.

### Changed — the Payables Sheet Migration, read again before the live cut-over
- **PD notes are the words on the Pending sheet, nothing else.** The sheet keeps five lists one under another; read as one table, a date ("46224") or a status ("Submited") became the note of 22 PDs. Each list is now read under its own header: 14 notes on the 2026-10 sheet.
- **A migrated PD carries its invoice number** (the platform's "invoice no."), as the sheet writes it beside the PD. "PORT File Sent? YES" is kept on the container's history. The Warehouse Master is read by its names.
- **A migrated import says where its goods are.** With no purchase invoice in the system, its page reads the goods' position from its payment applications and containers: On Process (Without SWIFT) while they wait for the SWIFT, In Process from the first SWIFT date, then On board / At port / Received by container.
- The runbook lists what the 2026-10 workbook itself needs corrected, and what live needs first (six suppliers, three USD bank accounts, a true USD rate).

### Added — asking about an update
- **"What is new" has an answer.** `docs/guide/whats-new.md` holds each release's news and fixes, so the AI answers "what is new in the update?" in the WhatsApp group (`!ai …`) and in the application's assistant from it. The release note sent to the group ends with that invitation.

## 1.1.0 — 2026-10-13

The second numbered release. Its own work is the Project Guide's **Project
Initiation** and the fix for the application failing when moving between
modules. It is also the first number given since 1.0.0, so it takes in
everything that reached the live system under that number: the entries
further down, written as each landed, and the work of 2026-10-04 to
2026-10-11, which `AGENTS.md` records section by section rather than line by
line here.

### Added — Project Initiation (the Project Guide, by direction 2026-10-12)
- **A screen of its own, first under Projects.** Every customer project starts as a Project Initiation, numbered PIN-{BRANCH}-{YYYY}-{SERIAL}, opened with the guide's Main Project Initiation Selector: a **Direct Sales Project** or a **Tender Project**.
- **Workflow One — Direct Sales:** 1 Sales Lead → 2 Opportunity and Pre-Sales Form → 3 Site Survey Design → 4 BOQ Costing → 5 Proposal Follow-up → 6 Contract Signing. **Workflow Two — Tender:** 7 Tender Lead → 8 Feasibility Review and Tender Qualification (Go / No-Go) → 9 Site Visit & Pre-Bid Meeting → 10 Tender Design BOQ → 11 Compliance Matrix & Bidding → 12 Submission & Award. One stage at a time; a note on the record says what the current stage still needs, and *Next stage* appears when nothing is missing.
- **The Pre-Sales Form:** site coordinates (GPS), governorate, area, land or rooftop; the contact person, job title, phones and official email; the system type (On-Grid, Off-Grid, Hybrid, BESS, Solar Pumping); the customer's documents behind the stage's own paperclip.
- **The bill of quantities** in the record's lines — material, shipping and installation costs with their totals. It is the approved BOQ once the record leaves its stage, and does not change again.
- **The tender's own parts:** the issuing entity, reference, deadline and link to the tender documents; Go / No-Go approved by somebody who holds `approve` (a No-Go needs its reason and ends the record); the site visit's minutes and clarifications; the compliance matrix, every line answered; the bid price and the bank guarantee, issued before the bid and converted or released at the award.
- **Follow-up activities** — calls, meetings, site visits, clarifications, addenda — kept as written.
- **The conversion point.** The signed contract is confirmed by somebody other than whoever opened the record (a super user alone excepted): the project is created and released in the same step, of type Direct Sales Project or Tender Project, with the contract's value, the BOQ's total as its baseline budget and the dates and manager given. The project's page shows the initiation's form, files and BOQ — read from the initiation, never copied.
- **A Direct Sales or a Tender project is made only this way.** The New project form no longer offers the two types, and one typed in by hand is refused.
- **Four doors** on the record (print, attachments, notes, history); each stage that names documents has its own paperclip; the Proposal stage prints the technical and commercial proposal.
- Amounts are in IQD, as everywhere in Projects. Global Search does not list initiations yet.
- Migration 0421. Controls C-93, C-94. Guide: `docs/guide/projects.md` › Project Initiation.

### Fixed
- **Moving from one module to another no longer takes the application down.** With the modules in the side panel or the bottom bar, the top bar's list of the open module's headings used the "More" measurement of the module just left for the first drawing of the next. From Settings to Accounting it named entries that did not exist, and the whole application was replaced by "This screen could not be shown". It happened on every such move, for everybody on the side panel — the company's default. The server never logged it: it was the browser's. The bar and the page tabs now keep a measurement with the list it was taken of.
- **A record that is not there is "does not exist", not an error.** A project that does not exist (on its own page and on six project workspaces given a stale code), a user page and a container asked for by something that is not an id, each showed the error page. All 74 record screens were asked for a record nobody has; these three were the failures. The not-found page now speaks of the page *or record*, where it spoke only of the menu tree.
- **The "Enrol your authenticator" notification** showed a raw key in the bell: its label asked for a date it was never given.
- **A slow database is no longer read as a sign-out.** A connection the pool could not hand out in time sent the person to the sign-in form and answered the chat and the bell 401, on which both stop until the page is reloaded. Only a missing, unknown, expired or revoked session is "signed out" now; a transaction that could not get a connection is tried twice more, and nothing after its first statement is ever repeated. Control C-95.

### Changed
- **The caller is resolved once per page.** The layout, the shell, the page and each of its doors each asked who the reader was, in a transaction of their own — about sixteen database transactions for one click, about eight now.
- Signing out clears the session cookie even when the session cannot be revoked at that moment.

### Migrations
- `0421_project_initiation` — additive: four new tables, their triggers, row security and grants; the series `PROJECT_INITIATION`; two rows in `project_type` (Direct Sales Project, Tender Project) and nine in `lead_source`. No existing row is changed.
- `0240` to `0420` were applied to the live database by the deploys made under 1.0.0; this release does not run them again.

### Rollback
- Application: `RUNBOOK-host-build.md` § 8 — the previous build is kept as `.next-prev`. With the application rolled back and 0421 left in place, its tables are simply unused; `/healthz` reports the migrations ahead of the build until the release is put back.
- Data: nothing existing is touched. The pre-migration dump `deploy.sh` takes is the way back from 0421 itself, restored beside the live database (`RUNBOOK-database-recovery.md`).

### Test evidence
- Type check and the unit suite (159 files, 2,587 tests) green.
- Integration, against a real PostgreSQL: `pg01-project-initiation` (both workflows end to end, the database's rules, the branch wall), the Project System suites `pm01`–`pm03` and `projects`, `ops14-print-export`, `ops16-document-table-lists`, `hd05-rls-coverage`, `shared-record-notes`, `notification-center`, `im2-02-bl`, `crm`. The whole suite runs again inside `deploy.sh`.
- Browser: `project-initiation` (a direct sale to an Active Project; a tender through Go to lost; Arabic at a phone's width), `section-bar-modules` (fails on the old bar, passes on the new), `missing-records` (every record screen), and the existing `navigation-layouts` side-panel and bottom-bar tests and `tabs-navigate`.

### Also in this release — delivered since 1.0.0

### Added — supplier bank accounts on the supplier's profile (IMPROVEMENT-002, sponsor 2026-10-03)
- **Bank accounts on the profile.** A supplier may hold several accounts. Each takes the bank (from the bank list, or named), branch, address, beneficiary (defaults to the supplier), account no. and/or IBAN, SWIFT/BIC, currency (from the currency list), an intermediary bank and SWIFT, and a note.
- **Refused when entered:** an IBAN failing its check digits or its country's length, a SWIFT/BIC of the wrong shape, an inactive currency, or the same account twice on one supplier. The same account on another partner is the duplicate warning, and it can be confirmed.
- **Verified by a second person.** Send for verification notifies the accounting managers. Whoever entered or sent the account cannot verify it. Send back carries a reason and returns the account to draft.
- **Several accounts in use, one default.** The first verified account is the default. Make default switches it, and the payment run pays the default. Take out of use needs a reason and is final; a default taken out passes the default on. Nothing is deleted.
- **The payment application form** offers only accounts still in use, and preselects the verified one in the import's currency. Its hint says where accounts are verified.
- **The supplier's history** includes its bank accounts' events.
- Migration 0269: new account columns; one default per partner; the default must be in use; out of use needs a reason and is final; bank and intermediary are frozen once verified. Control C-40.

### Changed — supplier bank accounts on the supplier's profile (IMPROVEMENT-002, sponsor 2026-10-03)
- **Bank accounts are set up on the supplier's profile.** Each one takes:
  - The bank, from the bank list or named, with its branch and address.
  - The beneficiary (by default the supplier itself).
  - The account no. and/or IBAN.
  - The SWIFT/BIC and the currency, from the currency list.
  - An intermediary bank and its SWIFT/BIC.
  - A note.
- **A supplier may hold several accounts.** Dinars and dollars, or two banks, can all be in use at once.
- **What a bank would refuse is refused on entry.** That covers:
  - An IBAN that fails its check digits or its country's length.
  - A SWIFT/BIC of the wrong shape.
  - An inactive currency.
  - The same account twice on one supplier.
- **A second person verifies every account.** It cannot be whoever entered it or sent it. Sending it notifies the accounting managers; until now the rule was there and nothing raised it. A verifier may send an account back with what is wrong.
- **One account is the default.** A payment run pays to it, and the first verified account takes it. Changing the default is recorded.
- **An account taken out of use keeps its reason and is never deleted.** It is not used again, and if it was the default, the default moves to the most recently verified account.
- **Changes after verification.** The bank, account no., IBAN, SWIFT and intermediary are frozen (migration 0269). Editing the beneficiary's name un-approves the account, as before.
- **Payment applications** offer only accounts still in use, with the default first. The verified one in the import's currency is preselected.

### Changed — ASYCUDA readings are documents (IMPROVEMENT-002, sponsor 2026-10-03)
- **Update from ASYCUDA is a register.** It lists every reading of the ASYCUDA document list, like the other lists: search, a status filter (Not applied / Applied), number, read on, read by, file, lines, changes, not read, applied on. "Read the ASYCUDA list" in the header takes the export (Excel/CSV, several files read as one) or a pasted list. Where the declarations stand stays on the PD register ("Expiring within N days"), so this screen no longer repeats it.
- **Each reading is a numbered document**, ASY-YYYY-NNNNN (migration 0268; earlier readings are numbered by date). It opens on its own page with its boxes and its lines in ASYCUDA's order: each line as ASYCUDA wrote it, the PD (linked), what ASYCUDA says, the date, the import, the status when read, the status now, and what applying does. Apply is the action at its foot, once.
- **The export it was read from is filed on the reading.** The page carries the paperclip, the clock and the printer in its title bar. The reading prints (PDF, Excel, Word × EN/AR). Whoever may read the list into the PDs may print it, and the customs and logistics officers may now file paperwork.
- **The PD page** moved its attachments and history into the same title-bar doors.
- **Uploads on the payables screens** (import, invoice, B/L, container, PD, reading, application, loan) and on leave now register the attachment rules first. A server that had just started refused the first file.

### Changed — the B/L, written properly (IMPROVEMENT-002, sponsor 2026-10-03)
- **Containers are a table, not a comma-separated paste.** One row per container: number, size/type, seal no., and the quantity it carries of each model of the import. Leave a model's column empty and what is left of it is divided equally. The grid's foot shows what is typed against what is left; never more than was ordered. Pasting several numbers into one box fills a row each.
- **Container numbers are checked against ISO 6346, check digit included.** The grid points out a wrong last digit as it is typed, and the service refuses it, naming the right digit. The hint's example is now MSCU1234566.
- **The ETA is required on a B/L** — it is what makes a container late.
- **Edit a B/L** (number, date, ETA, vessel, voyage, shipping line, ports) while nothing on it is received. Containers still on its ETA follow the new one.
- **Edit a container** (number, size/type, seal) until it is received.
- **Cancel a B/L or a container** with a reason, never deleted. A cancelled B/L's number may be entered again (migration 0267: unique among live B/Ls; containers gain a seal no.).
- **A container's plan changed by hand** is held to what is left of the order.
- **The B/L page carries the paperclip, the clock and the printer** in its title bar, like the Import Application. The B/L prints (PDF, Excel, Word × EN/AR): its boxes, its containers and what each carries. The container page has the same paperclip and clock.
- **Containers register:** a "Short or damaged" view — the exceptions to follow up, with damaged / short per container — and a "Cancelled" view.

### Changed — IMPROVEMENT-002 IM2-1, the Import Application (the sponsor's workflow kept as it is)
- **Short containers.** The receipt works out what is short: planned − received − damaged, with Short left empty. A count that does not add up is refused. More than planned may arrive, with nothing short. The plan is in the unit the PI bought in, and the stock moves in base units, so an import bought in BOX clears.
- **Quantities by model.** A full-width register on the import shows, for each model: ordered, in containers, received, damaged, short, claimed, still in transit, and not yet shipped (the balance shipment).
- **Claim the shortage.** Once every container is in, the claim takes what is still in transit back to the supplier as a purchase return against the invoice line, offset to what we owe. It resolves the receipt's hold and logs `SHORTAGE_CLAIMED` (migration 0266). The import clears when nothing of it is left in transit. A PD that expired part written off then counts as done.
- **Landed cost** is locked only once every container is received, because it is spread over what the receipts brought in.
- **A loan named on a payment application is its funding source.** "Funded by" left the screen, and the application had been refused ever since.
- **An application with no amount** asks for everything that is left.
- **Stage 2 "Invoiced + funded"** is reached with any application asked of the bank, or with the import paid. The instalment plan left the screen.
- **Supplier payments made straight against an import's invoices** count towards Paid, Fully paid and the cap on new applications.
- **An import read from a supplier's document in another currency.** The invoice is booked in dinars at the invoice date's rate, and the import keeps the agreed currency. Its stock lines land in transit, although the document names no warehouse.
- **The import's quantity follows its posted invoices.**
- **Locks** on payment-application create, ASYCUDA apply, and container plan, stage and ETA changes. Each now locks its row before checking its status.

### Fixed
- Confirming a payment application no longer counts its own reservation
  against it: the supplier payment it posts is drawn from the money the
  approval reserved (§15.1), so an account holding the amount — not twice
  it — can confirm. The older integration suites fund their fixture banks
  before paying (C-20); the sales-exchange gate ignores FX-3's
  `payable_exchange_difference`.
- A fresh database migrates to head in one run again: `migrate.ts` commits
  after each migration that adds an enum value before running what uses it
  (0260 used `whatsapp`, added by 0242, in the same transaction). The
  im10, ops13 and ops14 integration suites fund their fixture banks before
  paying from them (C-20); the legacy-import preparation script reads the
  business day, not UTC's (hd07).
- REQ-HR-001 — the payroll, advances and recruitment/performance migrations
  had reached the journal at times earlier than main's newest, so a database
  that had already run those would have passed them over. They run after
  main's now (0262–0264); a database that ran them under their earlier names
  is recorded, not run twice (`migrate.ts`). The controls register's
  duplicated rows are renumbered (C-20 the bank rule, C-21 onward HR). The
  payroll and advances tests fund the bank before paying from it (C-20).

### Added
- REQ-HR-001 HR-6 — **Employee Requests**, **Documents**, the **HR
  Dashboard** and **HR Reports**; the HR section is complete. One register
  for an expense claim (ECLM-…), a trip (TRV-…), a letter (LTR-…) or
  anything else (ERQ-…), asked by HR or by the person and decided by their
  manager or the HR manager — never by the asker or the person. A claim's
  lines name the expense categories (a receipt filed where the category
  wants one); Finance reimburses it from a bank or cash account
  (`hr.expense_claim`), and a claim naming its trip settles the trip's
  advance first. An approved trip opens its advance; a letter is drafted
  from the employee record, issued with its text and printed as issued.
  A person's papers (EDOC-…: contract, ID, passport, permits, certificates,
  hand-over) are filed with their scan, renewed by a new row, withdrawn with
  a reason, never deleted; the sweep raises one about to expire. The HR
  dashboard counts headcount, movement, leave, requests, vacancies,
  reviews, expiring documents and — under their grants — payroll cost and
  advances owed; four reports (headcount, leave balances, payroll register,
  unsettled advances) on screen, PDF and Excel. The employee page shows the
  person's requests and papers; the main dashboard the requests waiting on
  me. Migration 0265; controls C-36 to C-39.
- REQ-HR-001 HR-5 — **Recruitment** and **Performance**. A vacancy (VAC-…)
  for a position, drafted by HR and opened by the HR manager; its applicants
  (APL-…, CV filed on their record) move forward through screening,
  interview and offer — never back, out with a note — and an offer hired is
  an employee made in the vacancy's branch, department and position, its
  first history row naming the application (one record per person: a known
  national id is refused). The last hire fills the vacancy; a filled or
  closed vacancy tells the rest of its pipeline no. The sweep raises a
  vacancy past its closing day. **Review cycles** on HR Settings; a cycle's
  reviews (REV-…) started for everybody with a manager who signs in; HR sets
  the goals and their weights, only the reviewer rates them, the overall is
  the weighted average; the person reads their own review and adds their word
  once; an HR manager who is neither the reviewer nor the person signs it off,
  after which it is the record. The dashboard shows reviews and offers
  waiting on me; the employee page shows where the person was hired from and
  their reviews. Migration 0264.
- REQ-HR-001 HR-4 — **Advances & Loans**. A salary advance or a loan
  (EADV-…) asked for by HR or by the person, endorsed by their manager,
  approved by Finance (never by the asker, the person or the endorser), paid
  from a bank or cash account; recovered by payroll month by month from its
  first recovery month (a missed month caught up, never more than is owed,
  never below a net of nothing), given back when a run is reversed, settled
  in cash for what remains and never more. The morning sweep raises a loan
  behind its schedule; the dashboard shows advances waiting on me. The
  employee page shows the person's advances and the **equipment** they hold
  (a fixed asset or an item, handed out and returned with its condition) —
  a leaver's clearance. Migration 0263.
- REQ-HR-001 HR-3 — **Payroll**. One run per branch per month, computed from
  the facts: the salary in force, each person's own component figures
  (allowances, an exemption — dated rows on the employee page), the
  components' defaults, and the month as the day sheet and the leave read it
  (absences and unpaid leave at the day's rate, part months by working days
  employed); overtime and income tax typed on the draft with their notes.
  Prepared and sent by the HR manager, approved by the accounting manager or
  the CEO (never the preparer), posted by Finance as one journal by
  department through mapped roles or the components' own accounts, every line
  a payslip (PSL-…) the person can open and print. The net pay is paid by
  bank transfer and in cash from the treasury's accounts; a run nothing was
  paid from is reversed whole and run again. The dashboard shows runs waiting
  on me; the cash forecast's payroll source is live; the period-close
  checklist warns of a month without a posted payroll. Migration 0262.
- REQ-HR-001 HR-2 — time. **Leave Management**: requests counted on the
  year's working calendar (rest days and holidays not taken, half days at the
  ends), held to the balance of their type (entitlement by months served,
  carry-over capped, opening balances and corrections as dated rows), a sick
  note required where the type says so, decided by the person's manager or
  the HR manager — never by whoever asked, never by the person — with
  notices both ways and a band on the dashboard. **Attendance**: the day
  sheet per branch and department, present or absent with in and out times,
  never over an approved leave, every correction audited. The employee page
  shows the year's balances, the requests and the month day by day. A
  contract's end date; the morning `hr-sweep` warns of contracts ending,
  requests waiting and annual leave about to lapse (limits on HR Settings).
  Migration 0261.
- The sponsor's WhatsApp configuration (`whatsapp-configuration`) on top of
  main: Noah on Opus 5.5 working the question out (WA-3), answering in the
  group only, reading what is sent to him, the claude-CLI brain, the
  maker-checker wording. Its two migrations run after main's head
  (`0246_whatsapp_group_only`, `0247_whatsapp_noah_opus`, journal times
  …061–062), and the migration runner repairs a database from the WhatsApp
  line, which had passed over the Project System's first three stages
  (`LINEAGE_REPAIRS` in `src/server/db/migrate.ts`).
- REQ-FIX-001 FIX-5 — HR in the sponsor's order: Dashboard, Employees,
  Departments, Positions, Attendance, Leave Management, Payroll, Advances &
  Loans, Recruitment, Performance, Employee Requests, Documents, Reports.
  **Departments** (register and record: seats in reporting order, the
  people, headcount, vacancies) and **Positions** (register and record,
  code minted — 0255) are built; Organisation now opens Departments; the
  Positions window left HR Settings. A new user is also an employee unless
  *Also an employee* is unticked — the account and the employee made
  together and linked, the account page naming the employee;
  `scripts/ops/ensure-user-employees.ts` (run by the deploy) makes the
  employee behind each existing active user, once.
- REQ-FIX-001 FIX-4 — units of measure on purchase: an item keeps its units
  on its record (*1 BOX = 24 EA*, a purchase and a sales default, a unit
  deactivated with a reason, the base unit always kept — 0254 holds it); the
  new-item dialog chooses the base unit; every purchase invoice line has a
  Unit, starting in the purchase default, its price following the unit until
  typed over. Stock is received, returned and costed in the base unit,
  exactly or refused, so a box of 24 at 24,000 is 24 pieces at 1,000 on the
  FIFO layer and in the journal. Lines that named a unit their item does not
  keep were repaired to the item's base unit by the migration. A sale is
  written in the base unit and refuses another.
- REQ-FIX-001 FIX-3 — the import and its invoices agree: a deposit is applied
  to the import's invoice when it posts; an import agreed in dinars takes its
  amount from its invoices (discounts and a second invoice included); an
  import agreed in another currency closes on its exchange difference (gain
  or loss) once fully paid, or says it waits for the exchange accounts;
  *Part paid* on the invoice screens; Invoice Status Tracking keeps imports
  out. The supplier advance's events and the exchange difference are on
  Posting Mappings (0253).
- REQ-FIX-001 FIX-2 — Availability is a register like every other: the
  Inventory tabs, search, a warehouse filter and "only items with stock",
  item names, fifty rows a page with the true count; issuing stock is a
  dialog and its refusal comes back in the service's words. The temporary
  password screen is a centred card like sign-in, outside the shell, with
  sign out on it.
- REQ-FIX-001 FIX-1 — the menu the sponsor asked for: Payables in four
  headings (Purchasing & Invoices, Payments, Suppliers & Balances, Setup)
  with payables work only; a Logistics module holding the customs
  declarations, the ASYCUDA list, bills of lading, containers and Invoice
  Status Tracking; Bank Loans and a new **Bank Deposits** screen (cash taken
  to the bank, or money from another source — a register over the bank
  transfer and the other receipt, approved by somebody else and posted) under
  Treasury & Banking. Routes are unchanged.

### Fixed
- Stale e2e expectations in the Phase 0 foundation suite: roles are given
  and created by the CEO, and the audit trail names actions in words.
- Bank and Cash Reporting counted every treasury posting (other receipts,
  loans, commissions, cash advances, reconciliation adjustments) as a
  transfer between own accounts; only a bank transfer's journal is one now
  (migration 0252 indexes the link).
- A page with two dialogs labelled both after the first one's title.
- Stale e2e expectations: the shell's unbuilt-screen and theme tests, the
  section-tabs navigation test.
- REQ-HARDEN-001 HARDEN-4 completed: the payable record reads in one
  transaction under a measured budget (G1–G3, HD14); each page hands the
  browser the nine message namespaces its client components use, not the
  catalogue — a workbench page from 408 KB to 224 KB (G7, HD19); no raw
  status, kind, lane or outcome code reaches a screen, and one
  `status_order` namespace for the order documents (H2–H3, HD18); the A21
  load run with its figures (I3, HD17: `tests/load/payables.js`,
  `scripts/load/seed-payables-volume.ts`).
- REQ-PM-001 PM-6 — close, settlement, labour and the reports: hours booked
  on an element by one person, approved by another and posted by Finance
  once the month has ended at the base salary ÷ the calendar's working days
  ÷ 8 (D-PM-8); a Material Issue document now posts its cost against the
  items' inventory accounts (D-PM-13); the **Close** workspace — Phase 11's
  five blockers and five more, technical completion, the settlement (an
  investment project's cost to the asset under construction, the rest's
  WIP cleared; drafted by one, posted by another; one per project) and the
  close; the **Reports** screen — the hierarchy cost report, line items,
  milestone trend analysis and earned value, printed and exported through
  the ERP's renderers from the same models the screen draws. A settled
  project refuses any further cost, recognition or reopen. Migration 0250.
- REQ-PM-001 PM-5 — billing, revenue recognition and forecast: a customer
  project's **billing plan** (per billing element, due on a billing
  milestone reached and approved, or on a date; a share of the contract as
  it stands or an amount; never more than the contract); certificates
  raised from a due line or from measured progress, carrying Phase 11's
  retention and advance recovery, approved by somebody other than their
  raiser and **posted** (D-PM-11: Dr customer receivable and retention
  receivable on the customer's sub-ledger, Cr project revenue, the project
  on every line); a draft withdrawn with a reason gives its balances back.
  **Revenue recognition** by percentage of completion, cost to cost (D-PM-1):
  nothing posts until Finance ratifies the method on Project Settings; then
  per project and period end the difference between recognised and billed
  goes to WIP or deferred revenue, reversed on the first day of the next
  run; refused in a closed period; a loss contract is flagged. The
  **Forecast** report: plan, budget, committed, actual, ETC (typed, dated
  and reasoned, or the formula), EAC and VAC per element. The close
  checklist warns of customer projects without recognition to the
  period's end; the WhatsApp bot answers "project status P" (D-PM-10).
  Migration 0249 (the measured-progress trigger now exempts a certificate
  raised from a billing-plan line).
- REQ-PM-001 PM-4 — schedule, progress and earned value: activities and
  milestones (usage billing, progress or date) under the elements,
  finish-to-start and start-to-start links with lags, the critical-path
  pass in the project's working calendar (earliest and latest dates,
  float, the critical path) on the WBS workspace; each run's milestone
  dates kept append-only for the trend; a progress milestone reached by
  one person and approved by another sets the element's percent;
  technical completion waits for every activity done and every milestone
  reached or cancelled. The **Progress** workspace: BCWS, BCWP, ACWP,
  CPI, SPI, EAC and VAC to a chosen day, element by element and summed up
  the tree, with the measurements, the milestones and their trend.
  Migration 0248.
- REQ-PM-001 PM-3 — execution: a purchase order, a payable and a purchase
  invoice may be assigned to a project element and cost code; the order's
  approval (or an order-less payable's opening) commits against the
  element's availability, the invoice's posting carries the project
  dimension and converts the promise — services as the cost, goods as
  stock until issued — and its reversal gives the promise back;
  cancellation releases it with the reason. The **Material Issues**
  document (issue at FIFO, return at the cost it went out at, the one-time
  form id), **Project Costs** (the line items beside the journal's
  figure) and **Procurement** (each promise, converted, released, open).
  Migration 0247.
- REQ-PM-001 PM-2 — planning and budget: the cost plan in versions with
  its spread by month (**Cost Plan**), the budget as documents — original,
  supplement, return, transfer — raised by one person and approved by
  another, the original writing the baseline once (**Budgets**, the
  new-document grid of elements × cost codes); availability control per
  element against the tolerance profile (warning notifications to the
  responsible person and the project manager, the stop line refusing the
  commitment, a raised line with a reason from the WBS element dialog);
  change orders with lines, two approvals and the supplement they raise
  (**Change Orders**). Migration 0246.
- REQ-PM-001 PM-1 — the Project System's structure: project types,
  tolerance profiles and cost codes as master data on the **Project
  Settings** screen; the `PRJ-{BRANCH}-{YYYY}-{SERIAL}` series; the WBS
  coding mask (five levels) with the planning, account-assignment and
  billing indicators, read by `recordCost` and `issueToProject`; the status
  profile (release by another person, hold and resume with reasons,
  technical completion, reopen once, close); the **Project Master** list
  and record, **Contracts** and the **WBS** workspace under the Projects
  section. Migration 0245.
- REQ-HARDEN-001 HARDEN-3/4 (part) — detail pages tell a missing record
  from a failed read (E1–E3, HD12 gate), the foreign-key indexes the hot
  paths join on (migration 0244, HD13), the dashboard's receipts filtered
  before the limit (G6), the service receipt chip translated (H1), a mobile
  Playwright project with the Arabic 390px pass over every delivered list
  and settings screen (I1/I2, HD16), the daily health check naming a
  bank/cash account whose ledger account is gone (F5), root notes moved to
  `docs/notes/` and the scratch script removed (J1, J3).
- REQ-IMPROVE-001 IMPROVE-2a — closing controls: the closed-period lock at
  the database (journals, stock movements, close in sequence; migration
  0243), the period-close checklist on the Accounting Periods screen with
  the hard close refused while a blocking check fails, the nightly
  `closing-checks` job, and `docs/CONTROLS.md` with its gate test.
- REQ-WA-001 WA-1/WA-2 — the WhatsApp bridge (`npm run whatsapp-bridge`,
  Baileys, pairing kept in the database), the `whatsapp` notification channel
  with its contacts, settings and message log on the **WhatsApp** screen, and
  the read-only query bot for the CEO (stock, payable and application status,
  SWIFT pending, due this week, stopped payables, supplier and customer
  balances with the statement as PDF, today's summary — Arabic and English;
  the model router when `ANTHROPIC_API_KEY` is set). Migration 0242.
- REQ-HARDEN-001 F1–F3 — the outbox finally delivers: the notification
  delivery runner, the e-mail sender over SMTP, retries on the D-HD-4
  schedule, `deliver-notifications` every five minutes in the crontab.
- REQ-HR-001 Stage HR-1 — people and organisation (`/hr/employees`,
  `/hr/organisation`, HR Settings). Migration 0241.
- REQ-LEGACY-001 — the legacy books import (`/administration/legacy-import`),
  reading the old system's `.xls`/`.xlsx` books into partners, items,
  warehouses, opening balances and opening stock, once, with a dry run.
  Migration 0240.

### Fixed
- REQ-HARDEN-001 G5 / HD15 — the goods receipt, purchase order, service receipt, recurring contract, PD, loan, payment application and shipment (B/L) registers page at 50 with a true count: the filters and the search run in SQL, the header shows the total, and the standard pager appears past one page. Before, three stopped silently at 200 rows and five read every row and filtered in memory.

### Migration notes
- 0240–0244 are additive (0244 adds indexes only). 0243 adds triggers: after it, a period that is `closed` refuses postings and stock movements at the table, and a period cannot be closed before the earlier ones of its year. 0242 adds an enum value (`whatsapp`) and must run
  on its own before the bridge starts (the migrator runs it as one
  transaction; nothing in the same file uses the value).
- After deploying: install the crontab (`install-cron.sh`, done by
  `deploy.sh`) so `deliver-notifications` runs; on the VPS install
  `deploy/whatsapp-bridge.service` and pair (`docs/RUNBOOK-whatsapp.md`).

## 1.0.0 — 2026-10-02

The first numbered release: everything delivered from the foundation to the
REQ-AP-001 cut-over, plus REQ-HARDEN-001 stages 1–2 and REQ-IMPROVE-001
stage 1.

### Added
- REQ-IMPROVE-001 Stage 1 — Operations: nightly encrypted backup sets with
  off-site copy and rotation (`backup.sh`), the crontab in the repository with
  locking, timeouts and per-job logs (`crontab.erp`, `run-job.sh`,
  `install-cron.sh`), the weekly restore drill calling `verify-recovery`,
  `/healthz`, the daily health check, the **Background Jobs** and **Backup
  and Health** screens, request ids and error digests in the log and on the
  error page, the export row cap with rendering after commit, the staging
  copy script with its scrub, the live-marker guard on every fixture script,
  the host-build runbook, the nginx and pm2 examples with the maintenance
  page, the production audit gate and Dependabot, e2e in CI against a
  database.
- REQ-HARDEN-001 Stages 1–2: sign-in hardening (lockout, temporary password
  expiry, MFA enrolment grace), permission-change propagation, RLS on every
  remaining table, business dates in Asia/Baghdad, integer money everywhere.

### Changed
- WhatsApp bot: the agent model is `claude-sonnet-5-5` again (migration 0251),
  by direction; 0245 had replaced it with `claude-sonnet-5`. Superseded by
  the sponsor's WhatsApp configuration: Noah on `claude-opus-5-5` (0247).
- `next` 16.3.8 (security), `nodemailer` 10; `package.json` version is real.
- Deploys build beside the running application and swap; the previous build
  is kept as `.next-prev`; a deploy ships only what is on `origin/main`.

### Migrations
- `0238_harden_access`, `0239_improve_operations` — additive; no data change.

### Rollback
- Application: `RUNBOOK-host-build.md` § 8. Data: the pre-migration dump,
  restored beside the live database (`RUNBOOK-database-recovery.md`).
