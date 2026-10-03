# REQ-HR-001 — Human Resources

| | |
|---|---|
| **Requirement ID** | `REQ-HR-001` |
| **Release** | 2 |
| **Test case(s)** | *Named per criterion in this document; each gains its link when its stage is built (00.6).* |
| **Status** | IN BUILD — Stage HR-1 built 2026-10-02 on `feat/hr-stage-1-people` (unattended; §12 decisions taken as proposed, see §14); REQ-FIX-001 FIX-5 (menu, departments, positions, user link) built; **HR-2 built 2026-10-03 on `feat/hr-stage-2-time`** (decisions B-HR-7 to B-HR-12, §14); **HR-3 built 2026-10-03 on `feat/hr-stage-3-payroll`** (decisions B-HR-13 to B-HR-17, §14); **HR-4 built 2026-10-03 on `feat/hr-stage-4-advances`** (decisions B-HR-18 to B-HR-21, §14); **HR-5 built 2026-10-03 on `feat/hr-stage-5-talent`** (decisions B-HR-22 to B-HR-26, §14); HR-6 per §11a |
| **Approved by** | *Not yet approved.* |

**Status: DRAFT for review — the decisions in §12 are OPEN, not final.**
Written 2026-10-02, in the manner of REQ-AP-001: the rules first, the screens
after, delivery in stages with numbered criteria, and a decision register the
sponsor ratifies before a line of Stage HR-1 is built.

The menu already reserves the whole section (`hr_payroll`, ordinal 15:
employees, organisation, attendance, leave, payroll, payslips, employee
advances, expense claims, travel, asset assignment, HR reports). This
document says what those eleven screens mean, in what order they arrive, and
which existing machinery each one reuses instead of reinventing.

---

# Part A — Purpose and principles

## 1. What this requirement covers

One register of the company's people and what the company owes them or has
entrusted to them: who works here and where (employee, organisation), when
they worked and when they did not (attendance, leave), what they are paid and
how it reaches the books (payroll → general ledger), what they were advanced
or spent for the company (employee advances, expense claims, travel), and
what equipment they hold (asset assignment).

## 2. The rules (the same five as REQ-AP-001 §4, applied to people)

| # | Rule |
|---|---|
| R1 | **One record per person.** An employee exists once, whichever branch or department they move through; history is dated rows, never overwritten fields. |
| R2 | **Time evaluates from facts.** Leave balances and payroll amounts are derived from recorded facts (contract rows, leave requests, attendance) — never typed as totals. |
| R3 | **Append-only money and history.** Payroll runs, payslips, advances, settlements and every status change are append-only; a wrong run is reversed and rerun, never edited. |
| R4 | **Configuration is master data.** Leave types, pay components, deduction rules, working calendars are rows an administrator edits — not constants in code. |
| R5 | **Privacy is scope.** Salary fields are visible only to roles granted them; RLS and the permission grants carry HR exactly as they carry payables. An employee's own record is visible to them read-only when they hold a user account. |

## 3. What already exists and must be reused, not duplicated

| Existing | Used for |
|---|---|
| `department`, `branch` masters | The organisation tree hangs from them; no second department table. |
| `app_user` | An employee *may* be linked to a user account (one-to-one, optional both ways); the link drives self-service visibility (R5). |
| Posting engine + `posting_rule` mappings | Payroll posts through mapped events (`hr.payroll_run`, `hr.payroll_payment`), like every other document. |
| Payables (REQ-AP-001 §27) | A posted payroll run raises **one payable of type `service`, category `payroll`** per branch per period — payment then travels the payment-application road that already exists, with its checks and its audit. |
| `cash_advance` + settlements | Employee advances and expense claims extend the existing cash-advance module (same tables where they fit, same settlement logic) rather than a parallel one. |
| `allocateDocumentNumber` | Series `EMP`, `LVE`, `PAYRUN`, `PSLIP`, `EADV`, `ECLM`, `TRV` (§11). |
| Maker-checker | Whoever enters a payroll run never approves it; approval posts nothing until the approver acts (as D9/D30 of REQ-AP-001). |
| The sweep pattern | Leave-balance warnings, contract expiry warnings, unsettled-advance ageing — the same daily sweep + time-limit rows as payables §19. |
| The notification outbox | Payslip issued, leave approved/refused, contract expiring — rows per channel; WhatsApp/email delivery arrives with REQ-WA-001 and is not a dependency here. |
| Design rule (AGENTS.md) | Every HR screen copies its model: lists copy the Purchase Invoices list, records copy the Purchase Invoice page, settings copy Numbering. No new CSS. |

---

# Part B — The masters

## 4. Employee

| Field group | Content |
|---|---|
| Identity | Employee no (`EMP-{BRANCH}-{SERIAL}`), full name (ar + en), national ID, date of birth, phone, address, photo (attachment), emergency contact. |
| Employment | Branch, department, position, manager (another employee), hire date, employment kind (permanent / contract / daily), status (`active` / `suspended` / `ended`), end date + reason. |
| Dated history | Every change of branch, department, position, manager or salary is a dated row (`employee_history`), append-only — "who was their manager in March" is a query, not an apology. |
| Pay | Base salary (amount + currency), pay components assigned from the master (§6), bank account for salary (IBAN / account no, bank from the banks master) or cash flag. Salary fields live in their own table (`employee_compensation`, dated rows) so R5's grant can cover compensation separately from identity. |
| Link | Optional `app_user_id` (unique when set). |

## 5. Organisation

Positions (`position` master: code, title ar/en, department, reports-to
position) form a tree the Organisation screen draws read-only from the data —
no drawing tool, the tree **is** the employee/position rows. Headcount per
department is a count, not a typed number (R2).

## 6. Pay components and deduction rules (master data, R4)

`pay_component`: code, name ar/en, kind (`earning` / `deduction` /
`employer_cost`), calculation (`fixed` / `percent_of_base` / `manual`),
default amount or rate, taxable flag, active. Seeded examples (editable):
base salary, housing allowance, transport allowance, overtime (manual),
absence deduction (computed from attendance), social security employee share,
social security employer share, income tax. **Rates are rows, not code** —
the Iraqi social-security and income-tax rates are seeds the accountant
confirms (§12 D-HR-3), and a change is a new dated row.

## 7. Working calendar and leave types

`working_calendar`: the week's working days and the public holidays, per year
— rows, maintained on a settings screen. `leave_type`: code, name ar/en, days
per year, carry-over rule, paid/unpaid, requires attachment (sick note),
active. Balances derive per employee per year from type + hire date + taken
rows (R2); an opening balance at migration is itself a dated credit row.

---

# Part C — Time

## 8. Attendance and leave

* **Attendance** — one row per employee per day: present / absent / leave /
  holiday / rest day, with optional in/out times. Captured by the HR officer
  on a day sheet (bulk screen) in Stage HR-2; a device/API import is an
  import definition later, not this requirement. Absence without leave feeds
  the absence deduction component.
* **Leave request** — `LVE-…`: employee, type, from/to (half-days allowed),
  reason, attachment when the type requires one. Lifecycle draft → submitted
  → approved / refused → cancelled; the approver is the employee's manager
  (from the employee record) or an `hr_manager`; maker-checker as everywhere.
  Approval writes the attendance rows for the span. Balance can refuse: a
  request past the remaining balance is refused with the balance named,
  unless the type allows negative (a §12 decision).

---

# Part D — Money

## 9. Payroll

* **Payroll run** — `PAYRUN-{BRANCH}-{YYYY}-{MM}`: one per branch per month.
  Draft: the run gathers every active employee of the branch, computes each
  line from compensation + components + attendance (R2), and shows the sheet
  for review; manual components (overtime) are typed on the line with a
  note. Submitted → approved (maker-checker; the CEO above a limit, as
  D30) → **posted**.
* **Posting** — one journal through the posting engine: Dr each earning
  component's mapped account (by department dimension), Cr social security
  payable, Cr income tax payable, Cr **the payroll payable** — the §27 hook:
  posting raises one payable of type `service`, category `payroll`,
  supplier = the company's own payroll partner row (a §12 decision), with
  the run as its source document. Payment then goes out as a payment
  application with every existing check; `settled` closes the loop.
* **Payslips** — `PSLIP-…` per employee per run, append-only, printed with
  the ERP's own print sheets (ar/en); visible to the linked user (R5).
* **Reversal** — a posted run is reversed whole (journal mirrored, payable
  cancelled if unpaid) and rerun; never edited (R3). Refused once its
  payable is partly paid.

## 10. Advances, claims, travel, assets

* **Employee advance** — `EADV-…`, an extension of the existing
  `cash_advance`: requested, approved (maker-checker), paid from a bank/cash
  account, settled against payroll lines (a deduction component per run until
  recovered) or by cash return. The sweep ages unsettled advances.
* **Expense claim** — `ECLM-…`: lines with expense categories (the payables
  `expense_category` master), attachments required per category rule,
  approved by the manager, reimbursed through a payment application or the
  next payroll run (a §12 decision).
* **Travel request** — `TRV-…`: destination, dates, purpose, estimated cost,
  approval; an approved trip may open an employee advance; the claim settles
  it. Stage HR-4; no booking integrations.
* **Asset assignment** — hand-over/return rows per employee referencing the
  item/asset by code and serial, with condition notes and signatures as
  attachments. A leaver's clearance lists what is still out (§11 screen).

---

# Part E — Screens (§ the eleven reserved menu items)

Every screen copies its model per the AGENTS.md design rule. In brief:

| Screen | Route | Model | Content |
|---|---|---|---|
| Employees | `/hr/employees` (+`/[employeeNo]`) | invoices list / invoice record | Register + the employee document: identity fields, dated history stacked under (statement manner), compensation section visible only with the grant. |
| Organisation | `/hr/organisation` | supplier-statements (stacked read-only) | The tree as indented register rows per department; headcount counted. |
| Attendance | `/hr/attendance` | list + a bulk day-sheet dialog | Day sheet per branch/department; month view per employee. |
| Leave | `/hr/leave` (+record) | invoices list / record | Requests register; record with approve/refuse actions and the balance shown. |
| Payroll | `/hr/payroll` (+`/[runNo]`) | invoices list / record | Runs register; the run document: lines grid, totals, submit/approve/post/reverse actions. |
| Payslips | `/hr/payslips` | invoices list | Register; each prints; a linked user sees own only. |
| Employee advances | `/hr/employee-advances` | advances screens of payables | Request/approve/pay/settle. |
| Expense claims | `/hr/expense-claims` | invoices list / record | Lines + attachments + approval. |
| Travel | `/hr/travel` | invoices list / record | Request + approval + linked advance/claim. |
| Asset assignment | `/hr/asset-assignment` | list + record | Out/returned register per employee; clearance view. |
| HR reports | `/hr/reports` | existing reports screens | Headcount, leave balances, payroll register per period, unsettled advances. |
| HR settings | `/administration/hr-settings` | numbering settings | Pay components · leave types · calendars · deduction rules · series — stacked windows, rows never deleted, only deactivated. |

---

# Part F — Delivery

## 11. Stages (each its own branch and PR, in this order)

| Stage | Delivers | Depends on |
|---|---|---|
| **HR-1 — People & organisation** · *built* | §4, §5, employee + organisation screens, `hr_officer` / `hr_manager` roles and grants, series `EMP`, history append-only, user link, HR settings (components/types/calendars as masters, inert until used). Migration `0241_hr_people`. | — |
| **HR-2 — Time** | §7, §8: calendars, leave types/requests/balances, attendance day sheet, the sweep rows (balance warnings, contract expiry) | HR-1 |
| **HR-3 — Payroll** | §6 components live, §9 whole: run lifecycle, posting mappings, the payroll payable (§27 hook), payslips, reversal | HR-1, HR-2, payables Stage 3 (payment applications) |
| **HR-4 — Advances, claims, travel, assets** | §10, the four screens, settlement into payroll deductions | HR-3 |

## 11a. What is left (re-cut to the sponsor's menu, REQ-FIX-001 FIX-5, 2026-10-02)

Built: HR-1 (people, history, compensation, HR settings) and FIX-5 — the
menu in the sponsor's order, every new user also an employee (backfill
for the existing ones), **Departments** and **Positions** as screens.
Set aside by the sponsor until the REQ-FIX-001 list is done. Left, in
order, each its own branch:

| Stage | Menu items | Delivers |
|---|---|---|
| **HR-2 — Time** · *built* | Attendance, Leave Management | Working calendars live; leave types, requests (employee → manager → HR manager), balances and accrual, negative-balance rule (D-HR-6); the attendance day sheet per branch/department and the month view per employee (D-HR-8: day status only); contract-expiry and low-balance notices in the sweep. |
| **HR-3 — Payroll** · *built* | Payroll (payslips inside it) | Pay components live (D-HR-3 rates confirmed by the accountant first, with the worked example H5); the run: draft → submitted → approved → posted, absences from HR-2, the journal through posting mappings, the payroll payable to pay through payment applications; payslips (print, own payslip for the linked user); reversal. |
| **HR-4 — Advances & Loans** · *built* | Advances & Loans | Employee advances and loans: request, approval (manager + accounting manager), payment, repayment schedule deducted in payroll; asset assignment on the employee record (out/returned, clearance). |
| **HR-5 — Recruitment & Performance** · *built* | Recruitment, Performance | Vacancies against vacant positions, applicants and stages, hire → employee (through `employees.create`); review cycles, goals, ratings, sign-off. |
| **HR-6 — Requests, Documents, Dashboard, Reports** | Employee Requests, Documents, Dashboard, Reports | Requests (expense claims, travel, letters, other) with approval; employee documents (contracts, IDs, certificates) with expiry notices, kept in the Document Center; the HR dashboard (headcount, joiners/leavers, leave, payroll cost); reports: headcount, leave balances, payroll register, unsettled advances. |

Open decisions before HR-2 and HR-3: D-HR-1 (who approves), D-HR-3 (the
statutory rates and the worked example), D-HR-4 (the payroll payable's
supplier), D-HR-5 (expense-claim reimbursement road), D-HR-6, D-HR-8.

## 12. Acceptance criteria (every stage's tests named before it is built)

| # | Criterion | Test |
|---|---|---|
| H1 | Creating an employee allocates `EMP-…`, writes the first history row; every change of department/manager/salary is a new dated row; UPDATE on history raises. | → `tests/integration/hr01-employee-core.test.ts` › *allocates EMP-{BRANCH}-{SERIAL} and writes the first history rows* · → `tests/integration/hr01-employee-core.test.ts` › *a history row cannot be changed or removed, even by the owner* |
| H2 | Compensation is invisible to a role without the grant — the service refuses, the screen hides, RLS holds at the database. | → `tests/integration/hr01-employee-core.test.ts` › *the HR officer is refused by the service, the refusal is written, and the database returns no row* · → `tests/e2e/hr.spec.ts` › *an employee is created from the list, moved on the record, and the officer sees no salary* |
| H3 | A leave request over the balance is refused naming the balance; an approved leave is what the day reads (B-HR-9); the balance derives correctly across carry-over and half-days. | → `tests/integration/hr02-time.test.ts` › *past the balance is refused with what remains; a type that may borrow lends up to its limit*, `tests/unit/hr02-time.test.ts` › *H3c · the balance carries, capped, never a debt* |
| H3x | HR-2 whole: decided by the manager (link) or HR manager, never by the asker or the person; a sick note required; the day sheet never written over a leave; the month reads leave over the sheet over the calendar; the sweep raises each notice once. | → `tests/integration/hr02-time.test.ts` (H4, H4b, H4c, H4d), `tests/e2e/hr-time.spec.ts` |
| H4 | A payroll run computes each line from components + attendance (a typed total is impossible); maker-checker holds; posting books the mapped journal **and** raises the payroll payable; reversal mirrors both. (B-HR-14: the net pay is owed on `net_pay` and paid by the run's own payments.) | → `tests/integration/hr03-payroll.test.ts` › *H4 · a run computed from the facts*, *H4 · maker-checker*, *H4 · reversed whole, and the month run again* · `tests/unit/hr03-payroll.test.ts` › *H4 · the rules of a run* · `tests/e2e/hr-payroll.spec.ts` |
| H5 | The worked example (§12 D-HR-3 fixes the numbers): one employee, base + two allowances, one absence day, employee/employer social security and tax at the seeded rates — payslip, journal and payable match to the dinar. (B-HR-15 sets the example until the accountant signs one off.) | → `tests/unit/hr03-payroll.test.ts` › *H5 · the worked example, to the dinar*, *H5 · the journal the run posts* · `tests/integration/hr03-payroll.test.ts` › *H5 · the worked example, posted and paid to the dinar* |
| H6 | An advance is recovered by payroll deduction rows until zero; settling more than remains is refused; the sweep ages what is unsettled. | → `tests/integration/hr04-advances.test.ts` › *H6 · recovered from the pay until nothing is owed*, *H6 · asked, endorsed, approved, paid* · `tests/unit/hr04-advances.test.ts` › *H6 · the schedule*, *H6 · the payroll takes what is due, and no more than the pay* · `tests/e2e/hr-advances.spec.ts` |
| H9 | HR-5 recruitment: a vacancy is opened by the HR manager; applicants move forward only, every move a row that cannot change, out with a note; an offer hired is an employee made through `employees.create` (one record per person — a known national id is refused), its first history row naming the application; the last hire fills the vacancy and closes the rest of its pipeline; an applicant and their CV are read only under recruitment's grant. | → `tests/integration/hr05-talent.test.ts` › *H9 · recruitment* · `tests/unit/hr05-talent.test.ts` › *H9 · the pipeline* · `tests/e2e/hr-talent.spec.ts` |
| H10 | HR-5 performance: one review per person per cycle, reviewed by their manager; HR sets the goals, only the reviewer rates; the overall is the weighted average with the weights making 100; the person reads their own and adds their word once; signed off by an HR manager who is neither the reviewer nor the person, then frozen; a cycle closes when every review is done. | → `tests/integration/hr05-talent.test.ts` › *H10 · performance* · `tests/unit/hr05-talent.test.ts` › *H10 · the review* · `tests/e2e/hr-talent.spec.ts` |
| H7 | Every HR route is in `domain/menu.ts` + `DELIVERED`, translated en/ar, passes theme readability at mobile RTL; every screen is indistinguishable in style from its model. | → `tests/e2e/hr.spec.ts` › *the section is in the navbar and every screen opens, in both languages* (HR-1's three screens; the rest with their stages) |
| H8 | Every service writing to a table carrying `employee_id` writes history/events in the same transaction (the A2 pattern). | → `tests/unit/hr01-event-coverage.test.ts` › *every exported function in employees.ts that writes a row also writes its history or audit* · → `tests/integration/hr01-employee-core.test.ts` › *positions, components, leave types and calendars are rows with their audit* |

## 13. Out of scope (this requirement)

Biometric/device attendance import (later import definition) · onboarding
workflows (recruitment and performance reviews were brought in by §11a and
built in HR-5) · training · multi-country
payroll and currencies other than IQD salaries (a §12 decision may admit
USD) · loans to employees beyond the advance mechanism · shift planning.

---

# §12 Decisions — OPEN, awaiting the sponsor

| # | Question | Proposed default (to ratify or change) |
|---|---|---|
| D-HR-1 | Who approves what | Leave: the employee's manager, `hr_manager` may always. Payroll: entered by `hr_officer`, approved by `hr_manager`, posted by CEO (as invoices). Advances: manager + `accounting_manager`. |
| D-HR-2 | Salary currency | IQD only in this release; USD salaries would need D17-style conversion rules. |
| D-HR-3 | Statutory rates and the worked example | Social security employee 5% / employer 12%, income tax per the current Iraqi brackets — **entered as seeds by the accountant, with one worked example signed off** before HR-3 is built (it becomes criterion H5). |
| D-HR-4 | The payroll payable's supplier | One internal business-partner row "Payroll — <branch>" per branch, or one company-wide; flagged internal so it never appears in supplier pickers. |
| D-HR-5 | Expense claim reimbursement road | Payment application (default) or next payroll run — or per-claim choice. |
| D-HR-6 | Negative leave balances | Refused by default; a type may allow a bounded negative (e.g. sick −5). |
| D-HR-7 | Who may see identity vs compensation | Identity: `hr_officer`+; compensation: `hr_manager`, `accounting_manager`, CEO; own payslip: the linked user. |
| D-HR-8 | Attendance granularity | Day status only in HR-2 (present/absent/leave); in/out times optional columns, no overtime computation from times until a later requirement. |

---

# §14 Decisions taken in the HR-1 build (2026-10-02, unattended; the sponsor may reverse any)

| # | Decision |
|---|---|
| B-HR-1 | D-HR-7 as proposed: `hr_officer` holds identity (`employee` view/create/edit/configure), `hr_manager` adds `administer` (status, sign-in link) and the compensation grant; the accounting manager and the CEO read compensation; the system administrator and the HR manager configure the settings. The database asks for the grant itself (`app_has_grant`) in the compensation policy, so a query that forgets the service still returns nothing. |
| B-HR-2 | The history records *that* the salary changed (`base_salary_iqd`, no values); the figures are the dated `employee_compensation` rows, readable only under their grant. A history readable by whoever reads the employee cannot carry the number. |
| B-HR-3 | Identity (names, national id, phone, address, emergency contact) is corrected in place and audited, not history: a typo is not an event. Branch, department, position, manager, kind and status are history. |
| B-HR-4 | A deactivation of a position, component or leave type needs a reason (§5.4 as the audit already enforces); a calendar's holiday may be removed, since nothing references one yet. |
| B-HR-5 | The HR screens live under `/hr/…` (Part E) with `/administration/hr-settings`; the section's other nine items keep their derived addresses until their stages. The Organisation screen copies the supplier-statement manner (stacked registers), indenting a seat under its parent with the dash the registers already use. |
| B-HR-6 | D-HR-3's rates are seeded as rows (employee 5 %, employer 12 %, income tax manual) for the accountant to confirm before HR-3; D-HR-6 seeded with sick leave allowed 5 days below zero; the Iraqi 2026 calendar seeded with six public holidays as a starting list. |
| B-HR-7 | HR-2: a day's working calendar is the year's active calendar (the first by code); none for the year reads Sunday–Thursday with no holidays, as the Project System does. Days taken are counted on the calendar as it stands — a holiday added later gives the day back. |
| B-HR-8 | Entitlement is the type's days for a year served whole; in the hire year and the leaving year, by months served (a start on or before the 15th counts its month, a leaving on or after the 15th counts its month), to the nearest half day. What is left carries into the next year up to the type's carry-over, never as a debt. A type with no days a year (unpaid leave) is not held to a balance. Opening balances and corrections are dated rows with their reason (`leave_balance_entry`), never a typed total. |
| B-HR-9 | §8 says approval writes the attendance rows. It does not: the day *reads* the approved leave over it, then the day sheet, then the calendar. A late sick note therefore excuses the absence the sheet recorded, and cancelling a leave deletes nothing. The sheet refuses to write over an approved leave. |
| B-HR-10 | D-HR-1 as proposed: the person's manager decides through the employee record's manager link (no grant needed), or a holder of `approve` on `leave_request` (the HR manager). Whoever asked never decides (also a database check), nor does the person. A granted leave is cancelled only by the HR manager (`administer`). A person with a sign-in may ask for their own leave without a grant (R5); the full self-service menu is HR-6. |
| B-HR-11 | The attendance sheet holds present or absent with optional in/out times (D-HR-8); a day not yet come is refused. Payroll (HR-3) reads `attendance.summary`: present, absent, not recorded, paid and unpaid leave in half days. |
| B-HR-12 | The morning sweep (`hr-sweep`, 06:30) raises: a contract ending within 30 days (to HR managers), a request waiting 3 days (to whoever may decide it), and, within 45 days of the year's end, unused days of a type marked *warn before lapse* (annual leave) above what carries (to HR managers and the person). The three limits are rows on HR Settings. `employee.contract_end_date` is a history field like the rest. |
| B-HR-13 | HR-3, D-HR-1 read with D-HR-7: a run is a sheet of salaries, and the officer reads none, so the run is **prepared and sent by the HR manager**; it is **approved by the accounting manager or the CEO** — never by whoever prepared or sent it (`payroll_run_approver_not_preparer`, a database check) — and **posted, paid and reversed by Finance** (the accounting manager). Approval approves the figures shown: posting posts the stored lines, not a fresh computation. The CEO's approval above a limit (D30) is not built: any approver approves any run. |
| B-HR-14 | HR-3, the §9 / §27 payable hook: D12 retired the *service* payable type (every expense became a purchase invoice) and a purchase invoice cannot debit a liability, so the net pay is not a supplier's balance. It is owed on the `net_pay` account until the run's own **payment** — one per pay method (bank transfer, cash), from a bank or cash account — posts `hr.payroll_payment` (Dr net pay, Cr the account, its bank sub-ledger party set as a supplier payment's is). The bank reconciliation, the treasury balances and the cash forecast read it as they read any payment. D-HR-4's payroll partner is therefore not needed. A run anything was paid from is not reversed. |
| B-HR-15 | HR-3, the arithmetic (until the accountant signs off D-HR-3's example): the base is the compensation row in force at the month's end, for the **working days employed** (a part month by working days); the **absence** is the day's rate (base ÷ the month's working days) × the days the sheet recorded absent on working days plus approved unpaid leave (half days half), never more than the base paid; an unrecorded working day is paid as worked (the screen says how many); a **percent of base** is taken of the base earned (paid less the absence); a fixed component is the person's own figure, or the component's default when it has one, for the days employed; manual components (overtime, income tax until its brackets are rows) are typed on the draft with their note. Every figure is rounded to the **whole dinar**, half up. Suspended people are not paid; a leaver is paid to their end date. Worked example (H5): Karim, base 1,500,000, housing 300,000, transport 100,000, one day absent in September 2026 (22 working days), overtime 50,000, tax 25,000 → gross 1,950,000; absence 68,182; social security 5 % of 1,431,818 = 71,591; deductions 164,773; **net 1,785,227**; employer 12 % = 171,818. |
| B-HR-16 | HR-3, where it posts (§9 "Posting"): each pay component may name its own **expense** account (an earning, an employer cost) and **liability** account (a deduction, an employer cost — social security payable, income tax payable) on HR Settings; a component that names none posts to the roles Finance maps for `hr.payroll_run` — `salary_expense` and `payroll_employer_cost` by the department dimension, `payroll_withholding`, and `net_pay`. The absence is taken off the base's own expense line (pay not earned is cost not incurred). One active base salary and one active absence deduction at a time. |
| B-HR-17 | HR-3, R5 and the rest of the system: a person with a sign-in reads and prints **their own** posted payslip (`app_own_payslip`), is told when it is issued, and sees of the run only what the payslip prints (`app_payslip_header`) — never the run's totals. The cash forecast's *payroll* source is live: approved and posted runs' unpaid net pay on their pay date, as totals by day (`app_payroll_outflows`) so no salary reaches a treasury reader. The period-close checklist warns (`payroll_posted`) of any branch that employed somebody in the month without a posted run. A person's own component figures (`employee_pay_component`) are dated, append-only rows under the compensation grant, written by `services/employees.ts`. |
| B-HR-18 | HR-4: a salary advance or loan is its own document (`employee_advance`, EADV-…), not the petty-cash `cash_advance`: that is a custodian's float settled by receipts; this is the person's debt recovered from their pay. They share the posting engine, the bank and cash accounts and the ageing buckets (`domain/cash-advance.bucketFor`), not a table. A salary advance comes back in one instalment, a loan in up to 60; amounts are whole dinars. |
| B-HR-19 | HR-4, D-HR-1 for advances: asked by HR or by the person (R5, as leave); **endorsed** by the person's manager through the employee record's link or an HR manager; **approved** by the accounting manager; **paid** by Finance from a bank or cash account (`hr.employee_advance`: Dr `employee_advance`, Cr the account). The asker and the person never endorse or approve, and the approver is never the endorser (check constraints). Refused with a note; cancelled with a reason until it is paid. |
| B-HR-20 | HR-4, recovery: the seeded deduction **ADVANCE** (`advance_recovery`) takes what the schedule has due by the month less what is back — a month whose payroll recovered nothing is caught up the next — never more than is owed, never so much the net pay goes below nothing (the rest is due next month). Posting the run writes the recovery rows (oldest advance first) and credits `employee_advance`; reversing it writes them back. Cash handed in settles what remains and never more (`hr.employee_advance_repayment`). The morning sweep raises an advance behind its schedule at the end of last month to the HR managers, once a month. |
| B-HR-21 | HR-4, equipment (§10 "Asset assignment") lives on the employee record: a fixed asset from the register (one holder at a time, a unique index) or another item with its serial, handed out and returned with the condition each way. A leaver's **clearance** — what is still out and what the advances still owe — is shown on their record; it does not stop the leaving (the sponsor may make it a gate). Signed hand-over forms are filed in the Document Center (HR-6). |
| B-HR-22 | HR-5, who does what in recruitment (D-HR-1 read for it): HR (the officer and the manager) drafts vacancies, adds applicants and moves them on; the **HR manager** (`approve` on `recruitment`) opens a vacancy, amends an open one (a later closing day, another headcount — never fewer than hired), closes it with a reason, and hires. A vacancy is for an active position; its department is the position's unless HR names another. The CEO reads. |
| B-HR-23 | HR-5, the pipeline: applied → screening → interview → offer, a stage may be skipped, never gone back to; rejected or withdrawn from any open stage with a note; only an offer becomes a hire. Every move is an append-only `applicant_stage` row. When a vacancy stops — filled by its last hire, a headcount brought down to the hires made, or closed — the applicants still in its pipeline are rejected, each by a stage row naming why: an application does not stay open on a seat that is gone. |
| B-HR-24 | HR-5, the hire (R1): the employee is made through `employees.create` in the vacancy's branch, department and position, with the applicant's names and phone, the kind the vacancy says unless the hire says otherwise, and the manager, national id, date of birth and contract end typed at the hire; the first history row reads *Hired from APL-… (VAC-…)*. A national id already on an employee is refused — that person is moved, not hired twice. The new person's manager is told who joins them and when; the employee page links back to the application. An applicant is somebody outside the company, so their row (and their CV, filed on it) is read under recruitment's own grant, not by everybody in the branch. |
| B-HR-25 | HR-5, performance: review cycles are master data on HR Settings (made by whoever configures HR, opened, closed). HR starts a cycle's reviews for everybody in its branch (a department if named) employed in the period who has none yet, the reviewer the person's manager through the link when the manager signs in — the rest are named for HR to add one by one with a reviewer. HR sets goals (title, target, whole-percentage weight); **only the reviewer rates** (1 Unsatisfactory … 5 Outstanding) and finishes, and only when the weights make 100 and every goal is rated: the overall is Σ weight × rating ÷ 100, exact to two decimals (R2). The reviewer or an HR manager may send a rated review back with a reason. |
| B-HR-26 | HR-5, sign-off and the person (R5): an HR manager signs a rated review off — never its reviewer (a check) nor the person (a trigger); the person reads their own review once it is written (`app_review_reach`, as the reviewer does) and adds their word once, before or after the sign-off. Signed off or cancelled (with a reason), the review is the record: the trigger refuses any change but that one word. A cycle closes only when every review in it is signed off or cancelled. Ratings feed nothing else yet — pay rises stay compensation rows HR writes (D-HR-7). |
