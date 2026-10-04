# Screen review — 4 October 2026

Defects found while the user guide (`docs/guide/`) was written from the code,
screen by screen. **Found by reading the code and both message catalogues, not
by using the screens** — each one should be confirmed on screen before it is
fixed. Nothing here has been changed, except where a line says **Fixed**.

Problems people report to Noah while using the system are a different list:
`var/issues/reported-issues.md` on the server.

## Fixed on the day

- **Arabic Appearance panel** — 38 labels (`shell.interface_style`, the preset
  names and descriptions, the save messages) were literal question marks in
  `messages/ar.json` since 2026-09-29. Translated.
- **WhatsApp settings** — `setting_group_only` had no label in either language
  and showed its raw key. Added.
- **Noah's free query never ran** — its time limit was set with a statement
  PostgreSQL refuses (`set local statement_timeout = $1`), so every query he
  wrote himself failed since 2026-10-02. Fixed, with a test.
- **Reversing a document's journal from chat** is refused (the journal screen
  still offers it — General Ledger 1 below).

## Worth doing first

These stop work or put a wrong figure in the books.

1. **New B/L on the Bills of Lading list loses its containers** (Logistics 1).
2. **Company → Update wipes the trade name, registration number and tax identifier** (Administration 1).
3. **Availability → Issue stock posts no journal** — stock value drops with nothing in the accounts (Inventory 3).
4. **The journal screen lets a document-posted journal be reversed on its own**, leaving the invoice and its stock as they were (General Ledger 1).
5. **A lone user cannot approve their own Opening Stock or Manual Deposit on screen**, although the service allows it (Inventory 1, Treasury 3).
6. **WhatsApp contact form: an update silently switches off Questions, Digest and Actions** unless they are ticked again (Administration 3).
7. **New loan: the schedule typed on the page is ignored**, and the "On dates I type" frequency is always refused (Treasury 8, 9).
8. **A mistyped bank statement line cannot be removed**, which blocks closing the statement for good (Treasury 12).
9. **Container "What it carries" keeps six rows only and drops the unit** (Logistics 11).
10. **Dead ends with no way out on screen**: a rejected journal, a rejected chart account, a wrong opening stock document, a deactivated account, a draft transfer (General Ledger 3, Treasury 11, 14, 15, Inventory 2).
11. **Refusal messages are English only, with internal field names and § references**, under an Arabic "could not be saved" (every area).
12. **A purchase invoice has no way back** — a draft cannot be cancelled, a submitted one cannot return to draft — and **its due date cannot be set on screen**, so with no supplier terms it reads Overdue the next day (Payables 2, 3).
13. **Purchase orders cannot be approved, cancelled or closed from any screen**; a supplier payment has no Reverse button (Payables 5, 6). Noah can take both steps from chat.
14. **Sales Returns and Purchase Returns read only the first 8 lines**; quantities on line 9 onward are silently dropped (Receivables 9, Payables 10).
15. **My Approvals can open and decide only chart-of-accounts requests** (Top bar 5).
16. **Leave and advance records open for anybody in the branch by direct address** (HR 9).
17. **A project that is technically complete refuses the cost of work already done**, and its retention can never be released, so it can never be closed (Projects 1–3).

## Inventory

1. **Opening Stock approval.** The record page hides "Approve and post" from the person who entered the document, although the service removed that rule on 2026-09-27 for single-person companies. A lone user cannot approve their own opening stock on screen.
2. **Opening Stock has no way back.** There is no edit, reject or cancel; a wrong document stays "Pending approval" forever.
3. **Availability → Issue stock posts no journal.** It writes a movement shown as "Sale" with no document, so stock value drops with nothing in the accounts (only a warning in Inventory Checks).
4. **Issue stock dialog details.** Batch is not marked required although every screen-made item is batch-tracked; typed values are lost on a refusal.
5. **Minimum stock level cannot be set anywhere**, so "Low stock" on the Warehouses Report is always 0.
6. **Unused item labels.** Tracking, purchase account, warranty and category labels exist in both languages but no screen uses them — the Items screens have no field for purchase account, tracking, warranty months, category, description or minimum stock level.
7. **Item Update form lets Inventory and COGS accounts be blanked** ("Decided by posting rule"), after which purchases and sales refuse.
8. **Warehouses Report menu entry** needs `view` on `fifo_valuation`, which no migration grants, while the page itself checks `inventory_movement`. It is probably visible only to a Super User.
9. **Typo in a refusal** on Item Reconciliation: "Choose the the warehouse."
10. **No Department field** on Item Reconciliation or Opening Stock. If the adjustment or opening account requires one, "Account … requires …" has no way out on that screen (Stock Count does have the box).
11. **Stock Count planned under the wrong active branch** can never be adjusted; the branch-mismatch refusal only appears at the last step, and the warehouse list offers every permitted branch.
12. **Stock Count, smaller issues.** The Plan dialog does not reopen after a refusal. A batch-tracked line with no batch blocks the whole adjustment with no fix on screen. Nothing stops the counter from approving their own variance.
13. **Stock Movement and Stock Ledger show no document number** for stock counts, container receipts, project issues and delivery notes. Reversals, project movements, write-offs and damage all show as "Other".
14. **Reconciliation link on Stock Receipts / Issues** opens the list without the number in the search box (Stock Movement does add it).
15. **Inventory Checks "Source" column** shows developer identifiers (function, table and migration names), and the detail lines are English technical strings.
16. **Shipment refusal points to a missing control**: "Mark one on the Warehouses screen", but that screen cannot mark a stage, and the warehouse profile shows no type, transit or stage. The stage warehouses come only from the setup script.
17. **Refusal messages are English-only** and carry "§9.2" / "§5.4" references and internal field names ("baseUomCode:", "inventoryAccountId:", "numerator:", "uomCode:").
18. **Unit of Measure with an Arabic name and blank code** is refused ("code: could not be made from the name; type one").
19. **Arabic wording is inconsistent.** Warehouses Report is "تقرير المستودعات" in the menu but "تقرير المخازن" as page title; warehouse is "مخزن" in some labels and "مستودع" in others; opening stock is "رصيد أول المدة" versus "مخزون افتتاحي"; reconciliation is "تسوية" versus "مطابقة".
20. **Transfer and Item Reconciliation have no cancel or reverse**; the only correction is an opposite document.

Not confirmed: whether issuing from a transit warehouse through the Availability dialog is refused (the dialog lists transit warehouses).

## Logistics

1. **New B/L on the Bills of Lading list loses its containers.** The dialog's Containers box, Size / type and "Spread the import's lines equally" tick are never read on save, so the B/L is saved with no containers and no warning. ETA is not marked required there but saving is refused without it. The New B/L dialog on the import page has the grid and works.
2. **Raw codes shown as refusals.** `asycuda_nothing_given` and `attachment_missing` appear literally under "That could not be saved." The translated sentence for the first exists in both locales but is not used.
3. **In-Transit Inventory, "Transit warehouses — the ledger's balance" is probably always empty.** It reads the stock position's on-hand figure and hides zero rows, but migration 0287 made on-hand 0 for transit warehouses. The reconciliation line under it would then never show. AGENTS.md's Logistics note still describes the pre-0287 behaviour.
4. **The same reconciliation counts only import goods.** Goods of non-import invoices in the stage warehouses would be reported as an unexplained difference.
5. **New declaration has no PD field**, although its note says to choose the PD. It can only be set afterwards through Edit declaration.
6. **Internal status code shown in English.** On the Customs Declarations list, the PD status under the PD number shows e.g. `partially_written_off`; the same happens in the Edit declaration PD picker. Arabic shows the translated name.
7. **Missing Arabic.** Register PD's Status options show English names. The "Customs (PDs)" summaries on Shipments, Containers, In-Transit, Tracking, Landed Costs and Duties use English status names. The charge "Source" column shows an internal document-type code. All service refusals are English-only, and the Invoice Status Tracking ones show codes such as `in_process` and `on_board`.
8. **Inconsistent Arabic terms.** The PD is "تصريح" on PD screens but "بيان مسبق" on Logistics screens and the print title. The import is "معاملة الاستيراد" in some places and "طلب الاستيراد" in others. The heading is "الكلفة الواصلة" while the item is "التكاليف الواصلة".
9. **Cancel declaration's reason box is labelled "Cancel declaration"**, the same as the button, not "Reason".
10. **Expired Submitted/Pre-approved PD has no direct way out.** The import's tracking says "re-register it", but Re-register is offered only for Rejected or Expired statuses, so the user must first change the status by hand.
11. **Container "What it carries" dialog.** It offers six rows only, so a container with more than six models loses the rest on save. It also sends no unit, so saved plan lines lose their unit and are then counted in base units.
12. **Search and View are separate forms on every register.** Searching resets the view and choosing a view drops the search. On Cost Allocation the lock filter can only be cleared by reopening the screen.
13. **Landed Costs register is stricter than the import page.** It needs every PD Totally written off, while the import page's lock rule also accepts Expired (partly written off) with nothing left in transit. The register can say "Waiting: PDs not written off" when the lock is actually allowed.
14. **Shipments view "All containers in" also lists an import whose B/L has no containers**, which defect 1 produces.
15. **PD record turns Days left red at a fixed 45 days**, while the list uses the configured warning window.

## General Ledger

**Journal Entries**
1. The Reverse button is offered on journals posted by documents. The screen's reversal path has no "manual journals only" rule (a separate reversal service has it but is not used), so reversing there leaves the invoice and its stock untouched.
2. The journal record shows no source document or link for document-posted journals.
3. A Rejected journal is a dead end: it cannot be edited, resubmitted or deleted. A submitted journal cannot be recalled by its raiser.
4. In a soft-closed period, a user with the override right gets "Posting into soft-closed … requires a stated reason", but no screen collects that reason. The on-screen hint "Soft closed still allows an approved adjustment" is therefore misleading.
5. Approval requires the `accounting_manager` role by name. A Super User without it is refused ("This step is approved by 'accounting_manager'…"), and their Submit fails entirely.
6. An account that requires project, warehouse, partner or employee is refused with "Account … requires …", and the grid has no field to supply it. (Manual journal lines carry Account, Department, Debit and Credit only.)
7. A manual line on a customer, supplier, inventory, project or loan control account can be typed but never posted ("must say which customer it is against").
8. The live "Balanced" indicator adds typed figures regardless of currency, so it is wrong when an account tied to a foreign currency is used.
9. Hints exist in the messages for document date, department and currency but are not shown on the form.

**Posting Mappings**
10. Labels are missing in both languages for `posting_map.event.treasury_bank_transfer`, `posting_map.event.treasury_loan_revaluation` and `posting_map.role.inventory`; the screen should show the raw keys for two panel headings and one line.
11. The refusal "No accounting mapping is configured…" sends the user to "Accounting Mapping" (the screen is Posting Mappings) and uses internal event and role codes.

**Periods and closing**
12. The close refusal lists failing checks by internal code (`sequence`, `unposted_journals`…) and says "Open Period Close", which is not a screen name.
13. The check label says "Inventory value … — now" but the check is computed at the period's last day.
14. Two check links go to unhelpful screens: "Sub-ledgers equal their control accounts" opens G/L Inquiry rather than Account Reconciliation, and "A USD rate dated within the period" links back to Accounting Periods rather than Currencies and Rates.
15. A duplicate or overlapping fiscal year surfaces a raw database constraint message.
16. Period names are generated in English only ("January 2026").

**Other screens**
17. Reversals: the menu is gated on `journal_reversal` view but the page checks `journal_entry` view. It has no search, filter or export.
18. G/L Inquiry account page: the running balance starts at zero at the From date, with no opening balance row.
19. Recurring Journals: amounts are labelled "(IQD)", but a line on an account tied to a foreign currency is raised in that currency.
20. Recurring Journals: a line saved without a department on an expense account fails only when raising, after the lines are frozen. The only way out is to end the template and rewrite it.

**Wording and translation**
21. The "not in a finance department" refusal gives outdated menu paths ("Accounting → Master Data → Departments", "Settings → Users").
22. All refusal sentences are English only. `attachment_missing` is shown as a raw code.
23. Arabic is inconsistent between menu and screen: "القيود الدورية" vs "قيد متكرر"; "مغلقة مؤقتاً" vs "إقفال مبدئي"; "قيود اليومية" vs "القيود اليومية".

Also noted: none of the four financial statements has a branch filter or a compare option; maker-checker on journals is not strict (an Accounting Manager's own journal posts on Submit).

## Treasury and master data

**Manual Deposits**
1. Labels `source_bank`, `source_transfer`, `document_type_bank` and `document_type_transfer` are missing in both languages; a bank deposit shows a raw key in the Source column and the record title.
2. `document_type_cash` reads "Bank deposit — cash" for what is now a deposit into a cash account.
3. The page hides Approve from the raiser even when they are a Super User, though the service allows it. A one-approver company cannot approve its own deposit.
4. The Cash deposit button shows with `create` on `bank_cash_account`, but saving needs `create` on `other_receipt`. The Credit account list is only loaded for the latter, so the required picker can be empty.
5. The amount is posted as dinars whatever the receiving account's currency.
6. There is no reverse or cancel on a deposit.
7. The list header "Into bank account" is also used for cash deposits, and the Arabic subtitle is shorter than the English.

**Bank Loans**
8. On the new-loan page the schedule rows are editable, but Create does not read them. The saved schedule is regenerated from the terms, with interest starting one or three months before the first due date rather than at the expected disbursement date, so it can differ from the preview.
9. Frequency "On dates I type" is always refused on that page ("A custom schedule names each of its N due dates; 0 given.") because the page has no date fields.
10. The purpose chosen on the form is not shown on the record, and "Other bank fees" is stored but never shown or posted.
- Loan revaluation: the service exists and is tested, but no screen or action calls it.

**Internal Transfers and Bank Reconciliation**
11. A draft or approved transfer cannot be cancelled; an approved one keeps its amount reserved until posted.
12. A typed statement line cannot be removed and a statement cannot be cancelled, so a mistyped line blocks Close statement for good. The "Cancelled" stage has a label but no action.
13. Reconciliation figures and the bank account profile's "What this account holds" format dinar ledger balances with the account's own currency.

**Chart of Accounts**
14. A rejected account has no way back to draft; the service function exists but is not wired.
15. A deactivated account cannot be reactivated.
16. The generic Cancel action on a draft records an audit event but changes nothing.
17. A Super User without the Accounting Manager role sees Approve and is refused.
18. The chart's Export button is shown without the `export` permission.
19. Arabic `record.journals` is "أرصدة غير مرتبطة بالفواتير" for "Journal entries".
20. Arabic for "control account" is inconsistent: "حساب تحكم" in one label, "حساب رقابة" in another.
- The account profile has no control for the currency restriction or the required dimensions, although both are enforced at posting. New posting accounts are always IQD.

**Other master data**
21. A published rate cannot be corrected: the same currency and date raises a raw database "duplicate key … exchange_rate_live_uniq" message. A duplicate currency code is also a raw database error.
22. The rate dialog defaults "Effective from" to 1 January of the current year.
23. The menu says "Currencies and Rates" while the page title says "Accounting rates".
24. The Payment Terms and Cost Centres dialogs show the stale note "The code follows the name unless you type one" beside "The system gives it its code"; neither has a code field.
25. An inactive tax code's status chip reads "Cancelled".
26. All refusals are English only, and master-data ones lead with internal field names (`glAccountId:`, `custodianUserId:`, `feeAccountId:`, `swiftBic:`).

## Administration

1. **Company save wipes three values.** Trade name, registration number and tax identifier have labels but no form fields, and the save action sends them blank, so every Update clears whatever was stored. Base currency can also be changed at any time with no guard.
2. **WhatsApp settings labels.** `group_hint` exists in both files but is never rendered, so the screen never says how to obtain the group id. (`setting_group_only` — fixed.)
3. **WhatsApp contact form silently drops switches.** Add and update share one form; an update overwrites all four switches with the form's state, which opens with only Notifications ticked. "May decide documents" is saved as No without a message when Questions is unticked.
4. **Replacing an authenticator removes the second step (Profile → Security).** The "Issue a new key" hint says sign-in still needs the old app's code until the new one is confirmed. In code, issuing a new key un-enrols the account at once, so sign-in asks for no code until confirmation.
5. **Permissions help text contradicts the code.** It says "Super users bypass all of this", but a Super user without the CEO role cannot create roles, edit permissions or assign roles. The refusal reads "Permission denied: 'administer' on 'permission'…", which is misleading for a Super user.
6. **No way out on screen** for a lost authenticator or a locked-out account (no reset or unlock for another user), deleting or deactivating a role, seeing or changing a role's "requires authenticator" flag, or changing a user's e-mail.
7. **Users screen.** The New user dialog accepts a Default branch that is not ticked, then refuses with "branchCode: the user is not scoped to that branch". After any refusal the dialog reopens empty. A creator without the CEO role sees an empty "Roles" legend with no explanation. The Sessions table shows expired sessions as "Live".
8. **Audit Trail labels and search.** Many events and record kinds have no label in either language (role granted/revoked, branch and department scope, WhatsApp contact/setting/session, notification rule, payables settings, both imports, authorisation denied). Search matches internal codes, the person's name and the reason only; it does not match the displayed or Arabic event names or document numbers.
9. **Refusal messages are hard-coded English** on all these screens, with raw field names (displayName, e164, alsoEmployee, legalName). Backup and Health finding sentences are English-only too.
10. **Raw key shown.** Legacy Books Import and Payables Sheet Migration show "attachment_missing" when no file is chosen.
11. **Backup and Health has two Arabic names**: menu "النسخ الاحتياطي وحالة النظام", page title "النسخ الاحتياطي والصحة".
12. **Payables Settings.** The Active tick is ignored for a new reason code or expense category (always saved active). There is no deactivate button for either. A blank Lane or Default owner role cannot clear the old value. Replacing a time limit with a future "Valid from" switches the old row off immediately, leaving a gap. "Check" is free text with no list. The page uses a different error title ("That did not save") from the other screens.
13. **System Parameters** is in the menu tree but not built, so it is hidden.

## Receivables

**Customers**
1. The New customer dialog cannot answer the duplicate warning ("…or confirm this is genuinely a different party"): the form has no confirm tick, so a matching e-mail, phone or near-name is a dead end.
2. The same dialog's hint says "use the same code", but there is no code field; the real match is on exact legal name.
3. The Update form shows to anyone with `edit_draft`, but every save needs `approve`, because the update always carries the credit-limit fields. An accounting officer is refused for changing a phone number.
4. Statuses On hold and Blocked have labels but no screen sets them.

**Sales Invoices and Customer Receipts**
5. "…Change this line, or cancel the invoice." — there is no cancel action for an invoice.
6. "Reverse the receipt first; the invoice can then be reversed." — receipts have no reverse or un-allocate, in the service or on screen.
7. A draft receipt cannot be edited or cancelled.
8. Receipts without a payer are supported by the service and flagged on the Dashboard, but the form requires a customer and no screen can identify one.

**Sales Returns and Credit Notes**
9. Only the first 8 listed lines are read on save; quantities typed on line 9 onward are silently dropped.
10. Reject sends the return's own reason as the rejection reason; there is no box to say why.
11. The credit/debit note Reverse box reuses the placeholder "Why the invoice was wrong".

**Monitoring** — List of customers, History and Reports all show only "Coming soon".

## Top bar, dashboard, sign-in and what every screen shares

1. **Built screens drawn grey with "Not yet built"** in the module dropdowns — Sales Invoices, Customer Receipts, Sales Returns and every other built screen whose address is derived from its name. **Fixed** (the test was "has no address of its own", not "is not built").
2. **Top-bar initials were wrong for most names** — the name was split on the letter "s" instead of on spaces ("System Administrator" read "ST"). **Fixed.**
3. **The Dashboard's payables-hold tables showed raw keys** (`dashboard.holds_need_reason`, `holds_i_own`, `next_action`, `open_payables` were read from a namespace that did not have them). **Fixed** (labels added, both languages).
4. **Two more Arabic Appearance sentences were question marks** (`interface_style_hint`, `appearance_save_error`). **Fixed.**
5. **My Approvals: only chart-of-accounts requests can be opened or decided from the inbox.** Journal entries and partner bank accounts show a raw id with no link, and Approve/Reject answer "No record source is registered for 'journal_entry'."
6. `/profile/security` has no link anywhere, yet the bell reminder says "Enrol it under My profile → Security."
7. On a phone in portrait the user button is hidden and the drawer has no Sign out or Profile settings.
8. The drawer shows the first 8 characters of the internal user id instead of the name.
9. After the first second-factor attempt the sign-in form comes back blank; email and password must be retyped with the code.
10. The Dashboard chart "Table" toggle is hard-coded English; Recent activity and the approvals table show raw internal codes.
11. The Receipts page title is "Receipts" while the menu says "Customer Receipts".
12. Attachment actions can show raw codes as the reason (`attachment_missing`, `not_found`).
13. **A file that fails the virus scan is quarantined silently**: the screen says "Saved." and the file is simply not listed.

## HR

1. Refusal messages are English only and carry internal field names and spec codes ("base_salary_iqd:", "(D-HR-2)", "(H6)", "§21"); statuses in them are raw codes.
2. The HR module button is untranslated in Arabic ("HR").
3. The HR Settings subtitle (both languages) still lists "Positions", which moved to HR → Positions.
4. HR Settings has no edit form for an existing leave type, working calendar or review cycle, and a calendar cannot be deactivated. The save actions support editing; the page does not offer it.
5. Stale wording: the leave note "…attached below…" and the claim note "attach them below". Files are behind the paperclip at the top.
6. **Self-service is unreachable.** The rules let a person ask their own leave, advance or request without a grant, but the lists need `view` and the New buttons need `create`.
7. The payslip notification says "Open it under HR → Payroll → PSL…", which a person without the payroll grant cannot open.
8. The "Link sign-in" hint says a linked person sees their own record read-only, but the employee page refuses anyone without `view` on `employee`.
9. **Leave request and advance record pages open for any user of the record's branch by direct address.** There is no `view` check and the row rule is branch-wide; requests, documents and reviews also ask for the grant.
10. Super User handling is inconsistent. Migration 0278 and the payroll service let a Super User approve their own work; the leave, advance, employee request and review sign-off services still refuse.
11. The advance page's "behind schedule" note counts the month in progress and can read "(current days late)". The morning check and the report exclude the running month.
12. A draft advance cannot be edited, only cancelled and re-entered.
13. An approved trip or other request cannot be cancelled at all.
14. New document: an empty Title is filled with the English type code ("work permit") even in Arabic, though the hint says "the type's name".
15. Employee history shows a manager as an id fragment when that manager is no longer active or the reader lacks edit rights.
16. Arabic names and titles are not used in several places: position and manager on the employee list, the leave record, and "On leave today" on the dashboard.
17. The employee record has two windows with the same element id (Requests and Leave requests).
18. The New request dialog shows trip and letter boxes for every kind and does not mark a trip's required fields, so "destination: is required" only appears after saving.
19. Salary and pay-figure boxes reject thousands separators with "Not a decimal value"; claims strip commas, advances do not.
20. Attaching with no file chosen shows the raw key "attachment_missing".
21. A recorded attendance day cannot be cleared back to "not recorded".
22. The pay component "Taxable" tick is stored but used nowhere in the computation.
23. Reports: after choosing another report, Search must be pressed once before its filters appear.
24. The New employee dialog has no Address or Emergency contact, though the action reads them; they are reachable only through Edit details.
25. Page titles differ from menu labels: Performance is "تقييم الأداء" on the page and "الأداء" in the menu; the Dashboard page is "HR Dashboard" against "Dashboard" in the menu.

## Projects

**Close flow — refusals with no way out**
1. The database still refuses any cost or commitment on a project that is not Released (a trigger from the first projects migration, never relaxed). The service and the on-screen note at technical completion say cost of work already done is still accepted. So posting the month's labour or a service invoice on a Technically complete project fails with "Project … is closing; nothing can be spent against a project that is not active", while the Book hours and Post labour buttons still show.
2. No certificate can be raised after technical completion, though the same note promises "the final billing".
3. No screen records an advance received or releases retention; the service functions exist but nothing calls them. Advance recovered is therefore always zero, and retention from a posted certificate keeps the close check "Advance or retention outstanding" open for good.
4. A rejected change order still counts as "not approved" in the close check, and there is no cancel action for a change order.
5. Only the approved original budget writes the per-cost-code budget lines. A cost code first introduced by a supplement can never be spent against ("There is no budget line '…' on this project").

**Wrong or inconsistent behaviour**
6. On the project record, "Revised budget" (top window) and "Revised contract value" (Contract table) show the baseline figures.
7. Super User self-approval: the service and database allow it for release, certificate, hours and settlement, but those pages hide the button from the raiser. The budget and change-order pages were corrected; these four were not.
8. The Contracts list and the change order's Contract change test the type code `CUSTOMER`, not the kind. A custom customer-kind type is missing from Contracts and refuses a Contract change, although the new change-order form shows that field.
9. Deactivating a project type makes existing projects of that type refuse adding or editing WBS elements.
10. Project Settings has no way to edit an existing type, profile or cost code, although its subtitle says rows are edited.
11. Material Issues: the warehouse picker lists the user's branch, but posting requires the project's branch, and a draft cannot be edited; Post is shown without checking `execute` on `inventory_movement`; the return form cannot name the original issue line, so the user must work out the unit cost by hand.
12. The Type filter on Project Master is empty for users without `create`.
13. On the project record any refusal re-opens the "New element" dialog.

**Missing pieces**
14. The project record carries only the notes and clock icons (no printer, no paperclip); the settlement has no record page or icons at all.
15. The settlement note points to "the Fixed Assets screen", which is not built.
16. Billing method is stored and shown, but no rule reads it.
17. Smaller limits: a typed ETC cannot be removed to return to the formula; the labour month list offers only the last 12 months; the WBS / plan / progress project pickers offer only the 100 newest projects; editing a project silently clears its cost centre.

**Labels and messages**
18. Arabic: the Procurement "Open" column reuses the Open button label and reads "فتح"; the menu says "الملف الرئيسي للمشروع" while the page title says "سجل المشاريع"; Close project is "إقفال المشروع" on the record and "إغلاق المشروع" on the Close screen.
19. Refusal messages are English only. They show internal references (§10, REQ-PM-001, D-PM-5, R2, PM4, "blueprint 10") and raw status words (on_hold, closing, active) instead of the labels users see.

## Payables

1. **Advance payment % never raises its payment application.** Posting needs a paying account and method on the invoice, and no form sets them; it only logs "raise it by hand".
2. **Purchase invoice has no way back.** There is no button to cancel or delete a draft, or to return a submitted invoice to draft, though refusals say "rejected back to draft first" and "delete the invoice". An expense draft cannot be edited at all.
3. **Due date cannot be set on screen.** "Set due date" is hidden and "Mark paid" is computed but never drawn. With no supplier terms the due date is the invoice date, so the invoice reads Overdue the next day.
4. **Approve / Verify hidden from a Super User who prepared the record** on the payment application, supplier advance and supplier bank account pages, although the service lets a Super User approve alone.
5. **Purchase Orders cannot be approved, cancelled or closed from any Payables screen.** Orders created by imports stay "Submitted". (Noah can take these steps from chat: `document_step` on a PO-… number.)
6. **Supplier payment has no Reverse button**, and no screen for the blocked-supplier override. A payment application for a supplier blocked after it was raised cannot be confirmed. (Noah can reverse a PAY-… from chat.)
7. **Supplier advance cannot be applied to an invoice or refunded by hand.** Only import-linked advances apply themselves.
8. **No screen creates a service confirmation**, so the Expenses screen can only submit or approve ones that already exist.
9. **New supplier form has no "not a duplicate" tick**, yet the refusal says "or confirm this is genuinely a different party". Its hint says "use the same code", but the form has no code field; matching is by exact legal name.
10. **New purchase return reads only the first 8 line rows.** Quantities typed on row 9 onward are silently ignored.
11. **Import Applications list has no pager**: only the first 50 rows show.
12. **"Generate next period now" raises due periods for every active contract**, not only the one on screen, and the action has no permission check of its own.
13. **English-only text in the Arabic UI:** stage names, stop-reason names, the payable type name, expense categories, saved-view names, payment method names, and every refusal sentence.
14. **Menu label and page title disagree:** Expenses opens a page titled "Service Receipts" (استلامات الخدمات). Supplier Payments opens "Payments" (المدفوعات). Purchase Invoices is فواتير المشتريات in the menu and فواتير الشراء on the page. Supplier Credit / Debit Notes is إشعارات الموردين الدائنة والمدينة in the menu and إشعارات الدائن / المدين للموردين on the page.
15. **Import record cannot edit payment terms, link an invoice or reassign a stop**; the actions exist but are not drawn.
16. **Reading a supplier document with an unmatched line** fails with the unrelated "needs a written justification and a second approver (§15)" message.
