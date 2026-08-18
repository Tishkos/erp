# Phase 08 — CRM and Customer Management

> **Blueprint:** §6, Appendix B
> **Release (§27):** 5 — Sales and A/R
> **Depends on:** 06
> **Blocks:** 11 (project creation from opportunity)

---

## Purpose

§6: CRM is the commercial relationship module — leads, enquiries, opportunities, activities and customer history *before* a Sales Order or Project exists. It uses the **same Business Partner record** as Sales, Finance, Projects, Logistics and Money Transfer.

**Not on the critical path.** §7 states sales begins directly with a Sales Order, so CRM feeds order-to-cash without gating it. This phase can slip without blocking revenue processing — see correction C3 in [`../PHASES.md`](../PHASES.md).

## In scope

CRM Dashboard, Leads and Enquiries, Opportunities, Activities and Calendar, Contacts, Business Partner Onboarding, Customer 360, Campaign and Lead Source, After-Sales and Warranty Cases, CRM Reports, CRM Settings.

---

## Sub-phases

### 08.1 Leads and enquiries

**Build**
- Lead creation and import, owner assignment
- Lead source and campaign tagging
- Duplicate detection by name, phone, email, registration number and bank details

**Blueprint rules enforced**
- §6 — *"A lead can exist without an approved Business Partner"*
- §6 — duplicate detection criteria

**Test gate**
- [ ] A lead saves without a Business Partner record
- [ ] Duplicate detection fires on all five criteria before save
- [ ] Lead import runs through the Phase 01 import framework
- [ ] Owner assignment is recorded and every reassignment is audited

---

### 08.2 Opportunities

**Build**
- Qualification from lead to opportunity
- Requested products, expected value, probability, activities, next action
- Stages with audited transitions

**Blueprint rules enforced**
- §6 — *"Completed activities and stage changes remain in the audit trail"*
- Appendix B — Opportunity statuses: Open, Qualified, Won, Lost, Closed; effect: **No posting**

**Test gate**
- [ ] Lead-to-opportunity conversion retains the same customer and source identifiers (§6 acceptance criterion 1)
- [ ] Every stage change and ownership change is audited
- [ ] An opportunity creates no accounting entry at any stage
- [ ] Lost opportunities capture a reason and appear in the lost-opportunity report

---

### 08.3 Business Partner onboarding

**Build**
- Approval route creating or activating the Business Partner record when commercial activity requires it
- Status transitions: Prospect → Active, and On Hold, Blocked, Inactive

**Blueprint rules enforced**
- §6 — *"a Sales Order, Project, invoice or service transaction cannot"* exist without an approved Business Partner
- §6 — status values

**Test gate**
- [ ] A Sales Order, Project, invoice or service transaction against an unapproved partner is rejected
- [ ] A Blocked partner cannot be used on a new transaction without an authorised override (§6 acceptance criterion 2)
- [ ] Onboarding creates one record shared by Sales, Finance, Projects, Logistics and Money Transfer — not a CRM-local copy

---

### 08.4 Activities, calendar and contacts

**Build** — activity logging, calendar, contact management against partner and opportunity

**Test gate**
- [ ] Activities link to lead, opportunity, partner or case and are retrievable from each
- [ ] Completed activities remain in the audit trail
- [ ] Contact records respect the partner's data scope

---

### 08.5 Conversion to Sales Order or Project

**Build**
- Direct conversion of an approved opportunity into a Sales Order or a Project, according to business line
- No duplicate data entry — conversion carries the data across

**Blueprint rules enforced**
- §6 — *"Convert the approved opportunity directly into a Sales Order or Project, according to the business line"*
- §6 — *"Creates Sales Orders or Projects without duplicate data entry"*
- §10 — *"Create a project from an approved CRM opportunity or an approved management instruction"*

**Test gate**
- [ ] Opportunity-to-order conversion retains the same customer and source identifiers (§6 acceptance criterion 1)
- [ ] Opportunity-to-project conversion does the same
- [ ] Business line determines the conversion target
- [ ] Converted data is copied, not re-keyed, and the link back to the opportunity persists

---

### 08.6 Customer 360

**Build**
- Consolidated view: order, delivery, invoice, receipt, project, logistics, transfer and warranty history
- Credit exposure, overdue balance and payment behaviour from A/R
- Respects department, branch and record-level permission

**Blueprint rules enforced**
- §6 — *"Customer 360 respects department, branch and record-level permission"*
- §6 acceptance criterion 3 — *"Customer 360 displays authorised operational and financial history"*

**Test gate**
- [ ] Customer 360 shows only records the viewing user is authorised to see
- [ ] Financial figures match A/R ageing and the customer statement exactly
- [ ] A user without A/R permission sees the commercial history but not the financial figures
- [ ] History spans all six source modules where data exists

---

### 08.7 After-sales and warranty cases

**Build** — case management linked to the warranty record from Phase 06.7

**Test gate**
- [ ] A case links to the originating invoice and serial number
- [ ] Warranty validity is resolved from the Phase 06.7 calculation, not re-entered
- [ ] Case history appears in Customer 360

---

### 08.8 CRM reports

**Build** — per §6 and Appendix D: Pipeline by stage and owner; lead-source conversion; lost-opportunity reasons; customer activity; inactive customers; Customer 360 commercial and financial history. Filters: owner, stage, customer, business line.

**Test gate**
- [ ] Pipeline totals reconcile to the underlying opportunity records
- [ ] Every report respects data scope
- [ ] Lead-source conversion rates compute from actual conversions, not estimates

---

## Phase exit gate

§6 minimum acceptance criteria, verbatim:

| # | Criterion | Evidence |
|---|---|---|
| 1 | Lead-to-opportunity and opportunity-to-order/project conversion retain the same customer and source identifiers | 08.2, 08.5 gates |
| 2 | Duplicate and blocked-customer controls are enforced | 08.1, 08.3 gates |
| 3 | Customer 360 displays authorised operational and financial history | 08.6 gate |
| 4 | Every stage, ownership and master-data change is audited | 08.2, 08.4 gates |

**Completes the Phase 06 end-to-end scenario:**
> **Lead → opportunity →** Sales Order → reservation → partial delivery → A/R Invoice → receipt → allocation → customer statement → G/L and margin report

**Sign-off:** Sales and the Business Process Owner.
