# REQ-PM-001 — Project System (Project Management module)

| | |
|---|---|
| **Requirement ID** | `REQ-PM-001` |
| **Release** | 2 |
| **Test case(s)** | *Named per criterion in this document; each gains its link when its stage is built (00.6).* |
| **Status** | DRAFT — written 2026-10-02 at the sponsor's direction ("a new req for module Project Management … one of the best, the SAP ERP Project System"); the §15 decisions are proposed defaults, taken as proposed while the build runs unattended and listed for ratification |
| **Approved by** | *Not yet approved.* |

**Status: IN BUILD — PM-1 built on `feat/pm-stage-1-structure` (migration 0245, PM1–PM3 and PM14 held by tests); the decisions under §15 Decisions stand as taken alone and are open to the sponsor's review.**
Written 2026-10-02, in the manner of REQ-AP-001: the rules first, the
objects and their life cycle, the screens after, delivery in stages with
numbered criteria, and a decision register the sponsor ratifies.

The menu already reserves the whole section (`projects`, ordinal 6: Project
Master, Contracts, WBS, Budgets, Change Orders, Project Costs, Procurement,
Material Issues, Progress, Billing, Forecast, Close, Reports), and Phase 11
already built the machinery under it — the project master, the WBS tree,
the five budget amounts, commitments, costs, material issues, measured and
approved progress, certificates with retention and advances, variations,
closeout — with sixty-one integration tests and **no screens**. This
document says what the thirteen screens mean, what the machinery still
lacks to stand beside SAP's Project System (PS), in what order it arrives,
and which existing parts each piece reuses instead of reinventing.

---

# Part A — Purpose and principles

## 1. What this requirement covers

One structure for every piece of work the company undertakes that has a
beginning, an end, a budget and somebody answerable for it — a customer
contract (a solar installation, a supply-and-fit job), an internal project
(a warehouse fit-out, the ERP itself), an investment (a building that will
become a fixed asset) — from the first line of the work breakdown to the
last journal of its settlement:

* **Structure** — the project definition and its work breakdown structure
  (WBS), coded by a mask, each element saying whether it may be planned,
  whether costs may be posted to it, whether it is billed; activities and
  milestones with dates, dependencies and scheduling.
* **Plan and budget** — cost planning by version, the budget as a document
  (original, supplement, return, transfer) with availability control that
  warns and then stops; change orders that move the revised figure and
  never the baseline.
* **Execution** — commitments the moment an order or a payable is assigned
  to a WBS element; actual costs from the ledger's `project` dimension and
  from stock issued to the project; procurement and material issues visible
  per element.
* **Progress, billing, forecast** — measured and approved progress, earned
  value (BCWS, BCWP, ACWP; CPI, SPI; EAC, ETC), the billing plan and the
  certificates that become customer invoices with retention and advance
  recovery, revenue recognition by percentage of completion with WIP at
  period end, the forecast at completion by cost code.
* **Close and reports** — technical completion, settlement (to a fixed asset
  for an investment project, to the result for the rest), the closed
  project; the hierarchy cost report, line items, the milestone trend
  analysis, the earned-value report.

## 2. The rules (the same five as REQ-AP-001 §4, applied to projects)

| # | Rule |
|---|---|
| R1 | **One structure, one code.** A project is one row that is also the `project` posting dimension (§4.2); its WBS elements are the only places a cost, a commitment, a plan or a bill may hang. Nothing is assigned to "the project" loosely — it is assigned to an element, and the element decides whether it may receive it (operative indicators, §5). |
| R2 | **The baseline is written once; everything after is a dated row.** Contract value, the original budget and the baseline dates are set when the project is released and never touched again. Supplements, returns, transfers, change orders, re-plans, re-forecasts are rows beside them, each with its reason, its approver and its date (Phase 11's rule, kept). |
| R3 | **Availability is computed, never stored.** Budget minus commitments minus actuals is a sum over the rows each time it is asked for (Phase 11's rule, kept); availability control reads that sum, warns at the first tolerance and stops at the second (§7). |
| R4 | **Configuration is master data.** Project types, the coding mask, status profiles, cost codes, tolerance profiles, milestone usages, settlement rules and the recognition method are rows an administrator edits — not constants in code. |
| R5 | **Every figure traces to a document.** An actual cost is a journal line with the `project` dimension or a stock movement to the project; a commitment is an approved order or payable; a billed amount is a certificate that became an invoice; a recognised revenue is a period journal. The screens show sums of these; the reports show the rows. |

## 3. What already exists and must be reused, not duplicated

| Existing | Used for |
|---|---|
| `project` (organisation schema) — the §4.2 dimension and §10 master in one row; statuses `draft · active · on_hold · closing · closed`; contract value, baseline budget and dates, billing method, retention and advance-recovery percentages, `recognition_method` slot | The project definition. PS's status profile maps onto these (§6). |
| `project_wbs` (tree, cycle refused by trigger), `project_budget_line` (cost code → account, baseline and forecast), `project_commitment`, `project_cost`, `project_progress`, `project_certificate`, `project_balance_movement` (retention, advance), `project_variation` (versioned change orders, two approvals) | The whole of Part B's data model, extended by columns and a few new tables (§16), never replaced. |
| `services/projects.ts` — create (from an approved opportunity or an instruction), approve, WBS, budget lines, commit / release, record cost, issue / return stock, measure / approve progress, certify, advance and retention, variations, closeout blockers, close, budget report, project view | Every screen's actions; new functions are added beside them. |
| Posting engine + `posting_rule` + the `project` dimension on journal lines; `account_required_dimension` | Actual costs: a line posted with the dimension *is* the cost (R5). Recognition and settlement post through mapped events (§10, §12). |
| Inventory: `project_issue` / `project_return` movement kinds, FIFO layers | Material issues at layer cost, returns at the cost they went out at (Phase 11.3). |
| Purchase orders, REQ-AP-001 payables and payment applications | Commitments (an approved order or payable assigned to a WBS element), their conversion to actual on invoice posting. |
| AR invoices, `partner_statement`, open items | A certificate becomes an AR invoice with the project dimension; retention is its own balance. |
| Fixed assets (`fixed_asset`, assets under construction) | Settlement of an investment project to an asset (§12). |
| HR (REQ-HR-001): `employee`, `employee_compensation` | Timesheets and labour cost at the employee's rate (PM-6, later). |
| Workflow / approvals, maker-checker, `statuses` service, `allocateDocumentNumber` | Release of a project, approval of a budget document, of a change order, of progress, of a certificate — whoever raises never approves (REQ-AP-001 D9/D30). Series `PRJ`, `WBS` (mask), `PBD` (budget document), `CO`, `CERT`, `PMI` (material issue). |
| Periods (REQ-IMPROVE-001 2a) | A project journal dated in a closed period is refused at the database; WIP and recognition journals are period documents and appear in the close checklist. |
| The notification outbox + WhatsApp (REQ-WA-001) | Budget tolerance reached, milestone due or overdue, change order awaiting approval, certificate approved; the bot answers "project status *P*" (PM-5). |
| Exports / print (`print/reports.ts`) | Every report prints and exports through the ERP's own renderers; the project cost report is the Warehouses Report's pattern. |
| Design rule (AGENTS.md) | Lists copy the Purchase Invoices list; records copy the Purchase Invoice page; the WBS, Progress and Close workspaces copy the Payables workbench; settings copy Numbering. No new CSS. |

---

# Part B — The objects

## 4. The project definition

The header (PS: *project definition*). One row, `project.code` from the
series `PRJ-{BRANCH}-{YYYY}-{SERIAL}` or typed when the company's own
numbering is wanted (D-PM-2), carrying:

| Field | Meaning |
|---|---|
| Type (new, master data) | `customer` (billed to a customer), `internal` (cost only, settles to the result), `investment` (settles to a fixed asset). Decides which screens apply and where settlement goes. |
| Customer, contract value, billing method, retention %, advance recovery % | Existing — the contract (Contracts screen, §13). |
| Responsible person (manager), department, cost centre, branch, business line | Existing. The manager approves nothing they raised. |
| Basic dates (baseline), forecast dates | Baseline written once at release; forecast dates move with scheduling. |
| Currency | IQD; a USD contract is measured in IQD at the posting rate, the contract value kept in both. |
| Coding mask, status profile, tolerance profile, settlement rule, recognition method | Configuration references (§5, §6, §7, §12). |
| Origin | The approved opportunity or the management instruction (existing). |

## 5. The work breakdown structure

A tree of elements under the definition, coded by the project's mask
(PS: *coding mask*, e.g. `PRJ-HQ-2026-000004` → `…-1`, `…-1.2`, `…-1.2.3`).
Each element carries, beside its existing name, parent, responsible person
and dates:

| Operative indicator (new) | Meaning |
|---|---|
| **Planning element** | Costs may be planned here (§7). |
| **Account-assignment element** | Costs may be posted here: a journal line, a commitment, a material issue naming this element is accepted; one naming an element without it is refused by the service and by the posting engine's dimension check. |
| **Billing element** | Certificates and the billing plan hang here (customer projects). |

A level-1 element is created with the definition. An element inherits its
parent's responsible person and dates until its own are typed. The tree is
the WBS workspace (§13); costs roll up it in every report.

**Activities and milestones** (PS: *network*, kept deliberately simple — D-PM-4):
an activity is a dated piece of work under an element (duration in working
days from the branch's calendar, planned start and finish, actual start and
finish, percent complete); it may depend on another activity
(finish-to-start, start-to-start, with a lag in days). Scheduling is a
forward pass over the dependencies: earliest start and finish, float, the
critical path marked. A milestone is an activity of zero duration with a
*usage*: `billing` (a billing-plan date, §11), `progress` (a progress
measurement point, §10), `date` (a plain date to trend). The milestone trend
analysis (§14) plots each milestone's planned date as it stood at every
re-plan.

## 6. The status profile

PS's system statuses, mapped onto the existing enum so Phase 11's tests
stay true, with the transitions the service allows:

| PS | Here | Enters when | Allows | Refuses |
|---|---|---|---|---|
| CRTD | `draft` | created | structure, plan, budget drafts | commitments, costs, billing |
| REL | `active` | released by somebody other than the creator; baseline written | everything in Part C | — |
| — | `on_hold` | put on hold with a reason | reading, change orders | new commitments, issues, certificates |
| TECO | `closing` | technically complete: no open activity, every milestone reached or cancelled | settlement, final billing, retention release | new commitments, issues |
| CLSD | `closed` | the closeout blockers are clear and settlement is posted | reading | everything |

Each transition is a dated, reasoned, audited row (existing `statuses`
service); `closing → active` is allowed once with a reason (reopen for
rework); `closed` is final.

---

# Part C — Money and time

## 7. Planning, budget and availability control

**Cost plan** (new `project_plan_line`): per planning element and cost
code, per plan version (`0` the original, `1…n` re-plans), with a period
spread (month by month, so BCWS exists, §10). The current version is the
one availability and EVM read; older versions are kept.

**Budget as a document** (new `project_budget_document`): PS's *original
budget*, *supplement*, *return* and *transfer* between elements, each a
document with lines per element, raised by one person and approved by
another; the existing `baseline_iqd` on `project_budget_line` is written
only by the original budget's approval (R2). The budget by element is the
sum of approved documents; the budget report shows original, supplements,
returns, transfers, current.

**Availability control** (tolerance profile, master data): the five amounts
per element — budget, committed, actual, forecast, available — are Phase
11's; the profile adds two lines: *warn* at 90 % of budget assigned
(commitments + actuals) → a notification to the responsible person and the
project manager; *stop* at 100 % → the commitment or posting is refused (the
existing `assertWithinBudget`, now reading the profile). A manager may raise
the stop line for one element with a reason (recorded).

**Change orders** (existing variations, screened): a change order carries
scope, cost and schedule effect, the commercial approval and the budget
approval; on approval it raises a budget supplement document and moves the
forecast dates. The baseline never moves (R2).

## 8. Commitments and actual costs

* **Commitment** when a purchase order or a payable (REQ-AP-001) is approved
  with a WBS element assigned (new `wbs_code` on the order line and the
  payable line); released on cancellation; converted to actual when the
  invoice posts (Phase 11's rule, extended from orders to payables).
* **Actual cost** is a posted journal line carrying the `project` dimension
  and the element (new `wbs_code` beside the dimension on `journal_line`),
  or a `project_issue` movement at FIFO cost. `project_cost` keeps its rows
  as the index of those lines; nothing is typed as an actual.
* **Labour** (PM-6): a timesheet line at the employee's compensation rate
  posts a cost to the element and a credit to the labour-absorption account.

## 9. Material to projects

Existing: issue from a warehouse to an element at layer cost, return at the
same cost, reported per project. Screened as the Material Issues document
(§13) with the one-time form id of the transfer forms.

## 10. Progress and earned value

Progress is measured per element (percent complete or physical quantity)
by one person and approved by another (existing). From the current plan's
period spread and the approved progress:

| | Definition |
|---|---|
| BCWS (planned value) | the cost plan of the element up to the date |
| BCWP (earned value) | the approved percent complete × the element's current budget |
| ACWP (actual cost) | the element's actual costs up to the date |
| CPI, SPI | BCWP ÷ ACWP, BCWP ÷ BCWS |
| EAC | ACWP + (budget − BCWP) ÷ CPI (the default method; the manager may type an ETC per cost code, §11) |
| VAC | budget − EAC |

A milestone with usage `progress` sets the element's percent when it is
reached (its own approval). The Progress workspace (§13) shows the tree
with these figures and the measurement rows beneath.

## 11. Billing, revenue recognition and forecast

**Billing plan** (customer projects): per billing element, lines of either
a milestone (usage `billing`, billed when reached) or a date, each with a
percentage of the contract value or an amount. A certificate (existing)
is raised from a due line or from measured progress, carries retention and
advance recovery, is approved by somebody else, and becomes an AR invoice
with the project dimension (existing).

**Revenue recognition** — D-PM-1 for Finance to ratify: the default is the
*percentage-of-completion, cost-to-cost* method at period end: recognised
revenue to date = contract value × (actual cost ÷ EAC); the period's
journal posts the difference against WIP (unbilled receivable) or deferred
revenue (billed in advance), through two new mapped roles; the journal is
reversed and re-posted next period. The period-close checklist gains a
warning row: "project recognition posted for every active customer project".
Until ratified, nothing posts (Phase 11's D1 stance holds) and the screen
shows the computed figures as *what would post*.

**Forecast**: per cost code, EAC = actual + ETC, where ETC is the formula
of §10 unless the manager types one (dated, reasoned); variance at
completion and the forecast dates from scheduling. The Forecast report
shows plan, budget, committed, actual, ETC, EAC, VAC per element.

## 12. Close and settlement

Technical completion (`closing`) needs: no open activity, every milestone
reached or cancelled, no open commitment (existing blocker). Settlement is
a period document (new `project_settlement`): for an `investment` project
the accumulated cost moves to the fixed asset under construction (and the
asset is capitalised on the fixed-assets screen); for `internal` and
`customer` projects the WIP / deferred revenue is cleared and the result
stands in the P&L. The close (`closed`) needs the existing blockers clear
*and* settlement posted; a closed project refuses every posting (existing)
and its elements refuse assignment.

---

# Part D — Screens (thirteen, all copying their models)

## 13. Screen by screen

| Screen | Route | Model | Shows / does |
|---|---|---|---|
| Project Master | `/projects` · `/projects/[code]` | Purchase Invoices list · Purchase Invoice page | The register (type, customer, manager, status, contract value, budget, committed, actual, available, % complete); the record: definition fields, status chip and transitions, the five amounts, then stacked registers — WBS, budget documents, change orders, commitments, costs, certificates, balances, history, attachments |
| Contracts | `/projects/contracts` · `[code]` | the same | Customer projects' contract view: value, billing method, retention and advance, billing plan, certificates, retention and advance balances |
| WBS | `/projects/wbs?project=…` | Payables workbench (workspace) | The tree with code, name, responsible, dates, indicators, the five amounts rolled up; add / edit element dialogs; activities and milestones under each element with the schedule |
| Budgets | `/projects/budgets` · `[no]` | list · document page | Budget documents (original, supplement, return, transfer): lines per element, approval, the resulting budget by element |
| Change Orders | `/projects/change-orders` · `[no]` | list · document page | Variations: scope, cost and schedule effect, two approvals, versions |
| Project Costs | `/projects/costs` | Purchase Invoices list | Line items: date, element, cost code, document, amount — journal lines with the dimension and material issues, filtered by project, element, period |
| Procurement | `/projects/procurement` | list | Orders and payables assigned to elements with their commitment and its conversion |
| Material Issues | `/projects/material-issues` · `[no]` | list · document page | Issue / return documents, lines at layer cost |
| Progress | `/projects/progress?project=…` | workbench | The tree with % complete, BCWS, BCWP, ACWP, CPI, SPI, EAC; measurement and approval; milestones reached |
| Billing | `/projects/billing` · `[no]` | list · document page | Billing plan lines due, certificates, the invoice each became, retention held, advance recovered; recognition figures and the period journal |
| Forecast | `/projects/forecast` | report (Warehouses Report model) | Per project and element: plan, budget, committed, actual, ETC, EAC, VAC; typed ETC rows |
| Close | `/projects/close?project=…` | workbench | Blockers (existing five + open activities, unreached milestones, unposted settlement), technical completion, settlement, close |
| Reports | `/projects/reports` | report | Hierarchy cost report; line items; milestone trend analysis; earned-value report; all printed and exported through the ERP's renderers |

Settings (`/administration/project-settings`, model Numbering): project
types, coding masks, status profiles, tolerance profiles, cost codes,
milestone usages, settlement rules, recognition method.

---

# Part E — Delivery

## 14. Stages (each its own branch and PR, in this order)

| Stage | Delivers | Depends on |
|---|---|---|
| **PM-1 — Structure and the master screens** | Project types and settings; coding mask and operative indicators on the WBS; the status profile on the existing enum (release by another person, hold, technical completion, reopen once); the Project Master list and record; the Contracts screen; the WBS workspace with element dialogs; the `project_settings` screen; the dimension check reading the account-assignment indicator | — |
| **PM-2 — Planning and budget** | Plan versions with period spread; budget documents (original, supplement, return, transfer) with approval; tolerance profiles and availability control (warn, stop, raised line with reason); the Budgets and Change Orders screens | PM-1 |
| **PM-3 — Execution** | `wbs_code` on order and payable lines; commitments from payables; actual costs indexed from journal lines with element; the Project Costs, Procurement and Material Issues screens | PM-2 |
| **PM-4 — Schedule, progress, earned value** | Activities, dependencies, forward-pass scheduling, float and critical path; milestones with usages; the Progress workspace with EVM; milestone trend rows kept per re-plan | PM-1 |
| **PM-5 — Billing, recognition, forecast** | Billing plan; certificates from due lines; recognition journal (D-PM-1) and WIP; the Billing and Forecast screens; the period-close warning; the WhatsApp intent "project status" | PM-3, PM-4 |
| **PM-6 — Close, settlement, reports, labour** | Technical completion and close with the extended blockers; settlement to asset or result; the Close workspace; the four reports; timesheets at compensation rates | PM-5 |

## 15. Acceptance criteria

| # | Criterion | Test |
|---|---|---|
| PM1 | A project is created with a type, coded by its mask; its level-1 element exists; an element's code follows the mask and its parent; a cycle is refused (existing). | `pm01-structure` → `tests/integration/pm01-structure.test.ts › PM1`, `tests/unit/pm01-project-system.test.ts` |
| PM2 | A cost, a commitment or an issue naming an element without the account-assignment indicator is refused by the service and by the posting engine; one naming an element with it is accepted and rolls up the tree. | `pm01-indicators` → `tests/integration/pm01-structure.test.ts › PM2` |
| PM3 | Release writes the baseline once and refuses the creator; hold refuses new commitments; technical completion refuses while an activity is open; reopen is allowed once with a reason; close refuses while a blocker stands. | `pm01-status-profile` → `tests/integration/pm01-structure.test.ts › PM3` (the activity blocker arrives with PM-4) |
| PM4 | Budget by element is the sum of approved budget documents; the original writes `baseline_iqd` once; a supplement, a return and a transfer move the current figure and leave the baseline; a document is not approved by its raiser. | `pm02-budget-documents` |
| PM5 | Availability control warns at the profile's first line (a notification to the responsible person) and stops at the second (the commitment refused); a raised line with a reason admits the commitment and is audited. | `pm02-availability-control` |
| PM6 | A payable approved with an element assigned is a commitment; posting its invoice converts it to actual without double-counting; cancelling releases it with a reason (extends Phase 11's order case). | `pm03-commitments` |
| PM7 | The Project Costs line items equal the journal lines with the dimension plus the material issues, and their sum equals the element's actual. | `pm03-line-items` |
| PM8 | The forward pass gives every activity its earliest start and finish and its float from the dependencies and the calendar; the critical path has zero float; a milestone of usage `progress` sets the element's percent when reached. | `pm04-scheduling` |
| PM9 | BCWS, BCWP, ACWP, CPI, SPI and EAC follow §10 from the plan spread, approved progress and actuals, element by element and rolled up. | `pm04-earned-value` |
| PM10 | A billing-plan line falls due on its milestone or date; the certificate it raises carries retention and advance recovery and becomes an AR invoice (existing arithmetic kept). | `pm05-billing-plan` |
| PM11 | With the recognition method ratified, the period journal posts contract value × (actual ÷ EAC) less billed to WIP or deferred revenue, reverses next period, and is refused in a closed period; before ratification nothing posts. | `pm05-recognition` |
| PM12 | Settlement moves an investment project's cost to its asset under construction and clears WIP for the rest; close needs it; a closed project refuses every posting. | `pm06-settlement-close` |
| PM13 | The four reports print and export through the ERP's renderers with the same figures as the screens; the hierarchy report's roll-up equals the line items' sum. | `pm06-reports` |
| PM14 | Every screen copies its model: the theme suite passes, the mobile RTL suite covers the new routes, and the two side-by-side screenshots per screen are shown. | `pm-screens` → `tests/e2e/projects.spec.ts`, `tests/e2e/mobile-rtl.spec.ts` (PM-1 screens: Project Master, record, Contracts, WBS, Project Settings) |

## 16. Data model additions (summary; Phase 11's tables stay)

`project_type`, `project_coding_mask`, `project_status_profile` (rows for
the five statuses with their allowed transitions), `project_tolerance_profile`
(warn %, stop %), `project_cost_code` (code → account), `project_settlement_rule`
(master data); columns on `project` (type, profiles, mask, forecast dates,
`technically_complete_at`, `reopened_at`); columns on `project_wbs` (the three
indicators, level, path); `project_activity`, `project_activity_dependency`,
`project_milestone_history`; `project_plan_version`, `project_plan_line` (period
spread); `project_budget_document` + lines; `wbs_code` on `journal_line`,
`purchase_order_line`, `payable_order_line`, `inventory_movement`;
`project_billing_plan_line`; `project_recognition` (period journal index);
`project_settlement`; `project_timesheet` (PM-6). Everything append-only
where it is a fact; deactivated where it is master data.

## 17. Out of scope (this release)

Resource levelling and capacity planning · a Gantt drawn by the browser
(the schedule is a table with dates and float; a chart is a later artifact)
· multi-currency plans · inter-company projects · claims management ·
a customer portal.

---

# §15 Decisions — proposed defaults (taken as proposed while unattended; ratify or change)

| # | Question | Proposed default |
|---|---|---|
| D-PM-1 | Revenue recognition | Percentage-of-completion, cost-to-cost, at period end, through mapped roles `project_wip` and `project_deferred_revenue`; reversed next period. **Finance ratifies before PM-5 posts anything** (Phase 11's D1). |
| D-PM-2 | Project numbering | Series `PRJ-{BRANCH}-{YYYY}-{SERIAL}`; a typed code is allowed for a project the company already names (the legacy books). |
| D-PM-3 | Coding mask | `{PROJECT}-{N}` per level, dotted (`…-1.2.3`), five levels at most. |
| D-PM-4 | Networks | Activities with finish-to-start and start-to-start dependencies, forward-pass scheduling and float; no backward pass, no resource load, no browser Gantt in this release. |
| D-PM-5 | Tolerance profile | Warn at 90 %, stop at 100 % of budget assigned; the stop line may be raised per element by the project manager with a reason, never above 110 % without the accounting manager. |
| D-PM-6 | Who approves what | Release, budget documents, change orders, certificates and settlement: the accounting manager; progress: the project manager (never their own measurement); a project over the amount band in the approval matrix (REQ-IMPROVE-001 FC-6, when built): the CEO. |
| D-PM-7 | Settlement | Investment projects to the asset under construction; internal and customer projects to the result (WIP cleared). Monthly settlement of an investment project (PS's periodic settlement) is not in this release — one settlement at technical completion. |
| D-PM-8 | Labour | Timesheets at the employee's base salary ÷ the calendar's working days ÷ 8, posted monthly (PM-6). |
| D-PM-9 | Retention | Kept as Phase 11 built it: its own balance, released only through the release, never more than held. |
| D-PM-10 | WhatsApp | "project status P" answers the five amounts, % complete, CPI/SPI and the next milestone; CEO only (REQ-WA-001 D-WA-3). |
