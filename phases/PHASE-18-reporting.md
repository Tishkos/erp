# Phase 18 — Reporting, Dashboards & Business Intelligence

> **Blueprint:** §22, Appendix D
> **Release (§27):** 10 — Reporting and Go-Live
> **Depends on:** all module phases
> **Blocks:** 20, 21

---

## Purpose

§22: one reconciled version of financial and operational truth, from executive summary to document-level drill-down.

> **Reporting principle (§22):** "A dashboard is a presentation layer, not an accounting ledger. The G/L and validated subledgers remain the books of record."

That principle is the architecture. Dashboards read; they never hold a balance of their own.

---

## Sub-phases

### 18.1 Semantic layer and governed views

**Build**
- A common semantic layer defining customer, supplier, item, project, department, warehouse, currency and period **consistently**
- Governed views or a reporting model reconciled to the transactional ledger
- Read/write separation so reporting does not run on the posting path

**Blueprint rules enforced**
- §22 — *"A common semantic layer defines customer, supplier, item, project, department, warehouse, currency and period consistently"*
- §22 — *"The reporting layer reads from governed views or a reporting model reconciled to the transactional ledger"*
- §25 — *"Dashboards use governed aggregates/read replicas where needed, not expensive uncontrolled queries on the posting path"*

**Test gate**
- [ ] Two different reports asking for "revenue by customer" return identical figures
- [ ] Every semantic entity has exactly one definition, used by every report
- [ ] Reporting queries do not execute against the primary posting path — verified under load
- [ ] The reporting model reconciles to the transactional ledger for a full test period

---

### 18.2 Row-level security in the query layer

**Build** — data scope enforced in the query layer, applying identically to screen, export and scheduled delivery

**Blueprint rules enforced**
- §22 — *"Row-level security is enforced in the query layer, not only hidden in the screen"*
- §22 acceptance criterion 3 — *"Users see only permitted sections and data scopes in both screen and export"*
- Appendix D — *"Export and scheduled delivery follow the same permissions as on-screen access"*

**Test gate**
- [ ] A branch-scoped user's report shows only their branch, on screen
- [ ] The same user's **export** contains only their branch — row counts match the screen exactly
- [ ] A **scheduled** report delivered to that user contains only their branch
- [ ] Totals and subtotals reflect only permitted rows — no leakage through an aggregate
- [ ] External BI connections reach only read-only governed datasets (§22)

---

### 18.3 Financial statements and finance reports

**Build** — the Appendix D Finance and Finance Control sets, on top of Phase 16.6

**Blueprint rules enforced**
- §22 — *"Operational reports reconcile to subledger controls; financial reports reconcile to the G/L"*
- §22 — *"Posted and unposted amounts must never be combined without an explicit visual distinction"*
- Appendix D — *"Every financial report drills to General Ledger and source document"*

**Test gate**
- [ ] Every financial report reconciles to the G/L
- [ ] Posted and unposted amounts are visually distinct wherever both appear
- [ ] Every total drills to balanced journal entries and original source documents (§22 acceptance criterion 1)
- [ ] IQD and USD versions use the same source transactions, with USD at historical rates (Appendix D)

---

### 18.4 Module report packs

**Build** — the full Appendix D catalogue across all sixteen domains: Executive, Finance, Finance Control, A/R, A/P, Treasury, CRM, Sales, Purchasing, Inventory, Projects, Logistics, Money Transfer, Investments, Fixed Assets, Budgeting, HR/Payroll, Audit — each with the key filters listed in that appendix.

**Test gate**
- [ ] Every report in Appendix D exists with its listed filters
- [ ] A/R, A/P, inventory, fixed asset, bank and client-funds control reports reconcile to the G/L for a test period (§22 acceptance criterion 2)
- [ ] Operational reports reconcile to their subledger controls
- [ ] Totals reconcile across summary, detail, subledger and General Ledger reports (Appendix D)
- [ ] Every operational report identifies posted and provisional data clearly (Appendix D)

---

### 18.5 Dashboards

**Build** — the nine §22 dashboards: Executive, Finance, Sales/CRM, Procurement, Inventory, Project, Logistics, Money Transfer, plus the Treasury dashboard from §17

**Blueprint rules enforced**
- §22 — dashboards are derived from posted or clearly labelled provisional data; *"they do not maintain separate balances"*

**Test gate**
- [ ] No dashboard holds a balance of its own — every figure traces to the ledger
- [ ] Provisional figures are labelled as provisional
- [ ] Dashboard figures equal the corresponding report figures exactly
- [ ] Dashboards respect data scope
- [ ] Dashboard load does not degrade posting performance under concurrent use

---

### 18.6 Report designer and saved views

**Build** — report designer and saved views for authorised power users

**Blueprint rules enforced**
- §22 — *"Users can save filter views and schedule delivery when they have export permission"*
- §22 acceptance criterion 4 — *"Saved views and scheduled reports preserve filters and produce reproducible results"*

**Test gate**
- [ ] A saved view reproduces identical results on re-run against unchanged data
- [ ] A saved view cannot widen the creating user's data scope
- [ ] Sharing a saved view applies the **recipient's** scope, not the author's
- [ ] Only users with export permission can schedule delivery

---

### 18.7 Scheduled distribution and controlled exports

**Build** — scheduled report distribution, export with metadata

**Blueprint rules enforced**
- §22 — *"Exports include report title, filters, generated-by and generated-at metadata where practical"*
- §22 — *"Every financial report shows base currency, reporting period, run time, data status and filter criteria"*
- §25 — *"large exports and reports run asynchronously"*

**Test gate**
- [ ] Every export carries title, filters, generated-by and generated-at
- [ ] Large exports run asynchronously and do not block the user or the posting path
- [ ] Scheduled delivery applies the recipient's permissions at send time, not at schedule time
- [ ] Every export is audited (Phase 01.4)

---

### 18.8 KPI dictionary and management packs

**Build**
- The §22 minimum KPI dictionary: Revenue, Gross margin, Days sales outstanding, Inventory availability, Purchase commitment, Project forecast margin, Transfer margin, Cash position — each with definition, primary owner and drill-down path
- Published management packs, versioned and frozen for the reporting date, with preparer and approver

**Blueprint rules enforced**
- §22 — *"Material KPI definitions, owners and formulas are documented in a KPI dictionary"*
- §22 — *"Published management packs are versioned and frozen for the reporting date, with preparer and approver"*
- §22 acceptance criterion 5 — *"A published management pack can be re-opened with its original data cut, version and approvals"*

**Test gate**
- [ ] All eight KPIs are defined with owner and drill-down path per the §22 table
- [ ] Each KPI drills along its documented path — for example Transfer margin: client → case → deposit → settlement → journal
- [ ] A published pack re-opens with its original data cut, version and approvals
- [ ] A frozen pack does not change when underlying data is later corrected — a restatement is explicit

---

## Phase exit gate

§22 minimum acceptance criteria, verbatim:

| # | Criterion | Evidence |
|---|---|---|
| 1 | Every statement total can be drilled to balanced journal entries and original source documents | 18.3 gate |
| 2 | A/R, A/P, inventory, fixed asset, bank and client-funds control reports reconcile to the G/L for a test period | 18.4 gate |
| 3 | Users see only permitted sections and data scopes in both screen and export | 18.2 gate |
| 4 | Saved views and scheduled reports preserve filters and produce reproducible results | 18.6 gate |
| 5 | A published management pack can be re-opened with its original data cut, version and approvals | 18.8 gate |

Plus the five Appendix D report validation rules.

**Sign-off:** Finance for the financial reports; each module's data owner for their operational reports; Business Process Owner for the KPI dictionary.

---

## Notes for the team

**Export is the security boundary people forget.** §22 makes it an explicit acceptance criterion that scope applies to exports as well as screens, and Appendix D repeats it for scheduled delivery. A report that filters correctly on screen and exports the full table is a data breach, not a bug. Test the export path separately for every scoped report.

**Historical reproducibility is a hard requirement.** §22: *"Historical reports use the rates and mappings valid for the reporting period unless an authorised restatement is performed."* This means the reporting layer must resolve rates and account mappings as at the reporting date, not as at run time. Design for it in 18.1 — it is very difficult to add afterwards.
