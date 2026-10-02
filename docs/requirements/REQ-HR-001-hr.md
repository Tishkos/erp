# REQ-HR-001 — Human Resources

| | |
|---|---|
| **Requirement ID** | `REQ-HR-001` |
| **Release** | 2 |
| **Test case(s)** | *Named per criterion in this document; each gains its link when its stage is built (00.6).* |
| **Status** | IN BUILD — Stage HR-1 built 2026-10-02 on `feat/hr-stage-1-people` (unattended; §12 decisions taken as proposed, see §14); HR-2 to HR-4 as drafted |
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

## 12. Acceptance criteria (every stage's tests named before it is built)

| # | Criterion | Test |
|---|---|---|
| H1 | Creating an employee allocates `EMP-…`, writes the first history row; every change of department/manager/salary is a new dated row; UPDATE on history raises. | → `tests/integration/hr01-employee-core.test.ts` › *allocates EMP-{BRANCH}-{SERIAL} and writes the first history rows* · → `tests/integration/hr01-employee-core.test.ts` › *a history row cannot be changed or removed, even by the owner* |
| H2 | Compensation is invisible to a role without the grant — the service refuses, the screen hides, RLS holds at the database. | → `tests/integration/hr01-employee-core.test.ts` › *the HR officer is refused by the service, the refusal is written, and the database returns no row* · → `tests/e2e/hr.spec.ts` › *an employee is created from the list, moved on the record, and the officer sees no salary* |
| H3 | A leave request over the balance is refused naming the balance; approval writes the attendance rows; the balance derives correctly across carry-over and half-days. | `hr02-leave` |
| H4 | A payroll run computes each line from components + attendance (a typed total is impossible); maker-checker holds; posting books the mapped journal **and** raises the payroll payable; reversal mirrors both. | `hr03-payroll-run` |
| H5 | The worked example (§12 D-HR-3 fixes the numbers): one employee, base + two allowances, one absence day, employee/employer social security and tax at the seeded rates — payslip, journal and payable match to the dinar. | `hr03-worked-example` |
| H6 | An advance is recovered by payroll deduction rows until zero; settling more than remains is refused; the sweep ages what is unsettled. | `hr04-advances` |
| H7 | Every HR route is in `domain/menu.ts` + `DELIVERED`, translated en/ar, passes theme readability at mobile RTL; every screen is indistinguishable in style from its model. | → `tests/e2e/hr.spec.ts` › *the section is in the navbar and every screen opens, in both languages* (HR-1's three screens; the rest with their stages) |
| H8 | Every service writing to a table carrying `employee_id` writes history/events in the same transaction (the A2 pattern). | → `tests/unit/hr01-event-coverage.test.ts` › *every exported function in employees.ts that writes a row also writes its history or audit* · → `tests/integration/hr01-employee-core.test.ts` › *positions, components, leave types and calendars are rows with their audit* |

## 13. Out of scope (this requirement)

Biometric/device attendance import (later import definition) · recruitment
and onboarding workflows · performance reviews · training · multi-country
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

