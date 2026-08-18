# Phase 15 — HR, Payroll, Employee Expenses & Advances

> **Blueprint:** §20, Appendix D
> **Release (§27):** 9 — Fixed Assets, Budgeting, HR and Payroll
> **Acceptance dependency (§27):** *"Registers, payroll control and G/L reconcile."*
> **Depends on:** 07
> **Blocks:** 11 (timesheets)
> **Blocked by decision:** **D3** — payroll formulas, statutory deductions and benefits

---

## Purpose

§20: HR, Payroll, Employee Expenses and Advances use the same employee, branch, department, cost centre, project, bank-account, approval and accounting structures as the rest of the ERP.

> **Required sequencing (§20):** "Implement HR master, employee expenses and advances before full payroll if local payroll rules are not yet documented. Payroll shall not be programmed from assumptions."

The blueprint tells you the order. Sub-phases 15.1 through 15.8 run first; **15.9 waits for D3**.

---

## Sub-phases

### 15.1 Employee master

**Build** — employee, contracts, position, department, manager; link to user account where needed

**Blueprint rules enforced**
- §20 — *"Organisation/department masters and user accounts are shared with the platform"*
- §20 — *"Sensitive employee data is not included in general audit exports or reports without permission"*

**Test gate**
- [ ] The employee record uses the shared organisation and department masters, not local copies
- [ ] Linking an employee to a user account does not grant that user any HR permission by itself
- [ ] Sensitive employee fields are masked by role (`TECHSTACK.md` §A13)
- [ ] Sensitive data is excluded from general audit exports unless the user holds explicit permission

---

### 15.2 Attendance, shifts and timesheets

**Build** — attendance capture, shift patterns, timesheets feeding project cost (Phase 11.5)

**Blueprint rules enforced**
- §20 — *"Timesheets and expenses feed project cost"*
- §20 acceptance criterion 3 — *"Project timesheets/expenses update project actual cost"*

**Test gate**
- [ ] An approved timesheet line updates project actual cost at the configured rate
- [ ] Timesheet hours are attributable to project and WBS element
- [ ] Attendance and timesheet are reconcilable against each other
- [ ] An unapproved timesheet does not affect project cost

---

### 15.3 Leave

**Build** — leave requests, balances, approval routing

**Test gate**
- [ ] Leave balance decrements on approval, not on request
- [ ] A request exceeding the available balance is rejected or routed per policy
- [ ] Leave interacts correctly with attendance for the same dates
- [ ] Leave history is retained and reportable

---

### 15.4 Employee expense claims

**Build** — claim submission with receipts and project/cost-centre dimensions, approval, payment

**Blueprint rules enforced**
- §20 — *"Employees cannot approve their own expenses or advances"*
- §20 — *"Expense policy limits and required receipts are configurable"*
- §20 acceptance criterion 2 — *"Employee expenses and advances enforce approval and receipt rules"*

**Test gate**
- [ ] An employee cannot approve their own claim by any path, including as a department manager of their own department
- [ ] A claim exceeding the policy limit requires the escalated approval
- [ ] A claim missing a required receipt cannot be submitted
- [ ] Claims tagged to a project update project actual cost
- [ ] Payment flows through Treasury (Phase 07), not a direct journal

---

### 15.5 Travel requests and per diem

**Build** — travel request, per diem calculation, linkage to expense claim

**Test gate**
- [ ] Per diem calculates per the configured rate and duration
- [ ] A travel-related claim links to its approved travel request
- [ ] Travel costs carry the correct department, cost centre and project dimensions

---

### 15.6 Employee advances and loans

**Build** — advance/loan issue, settlement, recovery through payroll where approved

**Blueprint rules enforced**
- §20 — *"Approve, pay and settle advances; recover balances through payroll where approved"*
- §20 — *"Open advances and assigned assets appear in offboarding clearance"*

**Test gate**
- [ ] An employee cannot approve their own advance
- [ ] Settlement reduces the advance balance by exactly the settled amount
- [ ] The same advance cannot be settled twice
- [ ] Outstanding advances are reported and appear in offboarding clearance
- [ ] Payroll recovery (once 15.9 is built) reduces the advance and the net pay consistently

---

### 15.7 Employee asset assignment

**Build** — assignment of company assets to employees, integrated with Phase 12.4

**Test gate**
- [ ] Assigned assets are visible from both the employee record and the asset register
- [ ] Assigned assets appear in offboarding clearance
- [ ] Returning an asset updates both records in one transaction

---

### 15.8 Onboarding and offboarding

**Build** — recruitment, onboarding and offboarding checklists; HR documents with expiry reminders

**Blueprint rules enforced**
- §20 — *"Deactivate access and recover assets during offboarding"*
- §20 acceptance criterion 4 — *"Offboarding revokes system access and lists unresolved advances/assets"*

**Test gate**
- [ ] Offboarding revokes the linked user account's access immediately, not at next session expiry
- [ ] Offboarding lists every unresolved advance and every assigned asset
- [ ] Offboarding cannot complete while items remain unresolved, or records the exception with approval
- [ ] HR document expiry reminders fire through the Phase 01 notification engine

---

### 15.9 Payroll — ⚠ BLOCKED

**Blocked by decision D3.**

> §20: "Payroll formulas, statutory deductions and benefits require signed HR/Finance specification."
> §20 required sequencing: "Payroll shall not be programmed from assumptions."

**Build now:** payroll component structure, payroll run framework, payslip template, the Treasury payment instruction interface, and the payroll journal posting hook.

**Do not build:** any formula, deduction rate or benefit calculation. Iraqi statutory payroll rules are not in the blueprint and must not be inferred.

**Blueprint rules enforced**
- §20 — *"Payroll data is highly restricted and separated from general user permissions"*
- §20 — workflow: prepare payroll → review exceptions → approve payroll batch → generate payment instruction to Treasury → post payroll journal
- §20 acceptance criterion 1 — *"Payroll calculations reproduce approved test cases and reconcile to payment and G/L totals"*

**Test gate (once D3 is signed)**
- [ ] Payroll calculations reproduce **every** approved test case supplied by HR/Finance, exactly
- [ ] Payroll totals reconcile to the payment instruction and to the G/L (§20 acceptance criterion 1)
- [ ] Payroll data is inaccessible to users without explicit payroll permission — verified on UI, API and export
- [ ] Advance recovery through payroll reconciles to the Phase 15.6 advance balance
- [ ] A payroll run is idempotent — re-running the same period does not double-post
- [ ] Payroll journal carries employee, department, cost centre, branch and project dimensions

---

### 15.10 HR reports

**Build** — per §20 and Appendix D: Employee Register; Attendance; Leave; Payroll Register; Employee Advances; Expense Claims. Plus headcount and turnover, payroll reconciliation to G/L and bank, expense by department/project with policy exceptions, assigned assets and offboarding clearance. Filters: employee, department, branch, period.

**Test gate**
- [ ] Payroll summary reconciles to G/L and to the bank payment
- [ ] Expense reports show policy exceptions distinctly
- [ ] Reports enforce the payroll permission separation — a non-payroll user sees no payroll figures
- [ ] Sensitive employee data does not appear in exports without permission

---

## Phase exit gate

§20 minimum acceptance criteria, verbatim:

| # | Criterion | Evidence |
|---|---|---|
| 1 | Payroll calculations reproduce approved test cases and reconcile to payment and G/L totals | 15.9 gate — **requires D3** |
| 2 | Employee expenses and advances enforce approval and receipt rules | 15.4, 15.6 gates |
| 3 | Project timesheets/expenses update project actual cost | 15.2, 15.4 gates |
| 4 | Offboarding revokes system access and lists unresolved advances/assets | 15.8 gate |

Criteria 2, 3 and 4 can be met without D3. **Criterion 1 cannot.** If D3 is outstanding at release time, the phase ships without payroll and that limitation is declared under §27.1 (*"known limitations"*), not glossed over.

**Sign-off:** HR and Finance. Payroll requires the signed HR/Finance specification per §20.

---

## Notes for the team

**Payroll permission separation is stricter than ordinary role separation.** §20 says payroll data is *"highly restricted and separated from general user permissions"* — a Finance Manager does not automatically see payroll. Model it as a distinct permission dimension, not as another role, or the separation will erode the first time someone needs a report.
