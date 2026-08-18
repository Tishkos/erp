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
- [x] A lead saves without a Business Partner record — the column is nullable and the opportunity's is not, which is §6's rule expressed as a schema rather than as a check somebody could forget
- [x] Duplicate detection fires on all five criteria before save — against existing **leads and partners alike**, because the same company may already be a customer or may already have been entered last month by somebody else. It **reports rather than refuses**: a second enquiry from a known customer is an ordinary event, and a system that blocked it would be worked around within a week
- [~] Lead import runs through the Phase 01 import framework — *not built.* The framework and `createLead` are both here; registering the definition is small, and it is the one piece of 08.1 left open
- [x] Owner assignment is recorded and every reassignment is audited — with the reason where one was given, and **no audit row for a reassignment to the same person**, so the trail records what changed rather than what was clicked

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
- [x] Lead-to-opportunity conversion retains the same customer and source identifiers (§6 acceptance criterion 1) — checked in the service **and** by trigger, so an opportunity cannot drift from its lead afterwards either. A lead with no partner may be given one (that is what qualification is), but a lead that already names a customer cannot quietly become an opportunity for a different one
- [x] Every stage change and ownership change is audited — with the loss reason attached, since the lost-opportunity report has no other input
- [x] An opportunity creates no accounting entry at any stage — proved by walking one through every stage and counting the journals, and by there being **no journal column** on either table to record one in
- [x] Lost opportunities capture a reason and appear in the lost-opportunity report — and a decided opportunity cannot be re-opened: a pipeline where yesterday's loss becomes today's open deal reports a conversion rate nobody can rely on

---

### 08.3 Business Partner onboarding

**Build**
- Approval route creating or activating the Business Partner record when commercial activity requires it
- Status transitions: Prospect → Active, and On Hold, Blocked, Inactive

**Blueprint rules enforced**
- §6 — *"a Sales Order, Project, invoice or service transaction cannot"* exist without an approved Business Partner
- §6 — status values

**Test gate**
- [x] A Sales Order, Project, invoice or service transaction against an unapproved partner is rejected — prospect, on hold, blocked and deactivated are each refused by name, so the message says which of the four it was
- [x] A Blocked partner cannot be used on a new transaction without an authorised override (§6 acceptance criterion 2) — the sales side refuses outright; the override §15 allows is the A/P one, where a blocked *supplier* may be paid by a manager with a stated reason
- [x] Onboarding creates one record shared by Sales, Finance, Projects, Logistics and Money Transfer — not a CRM-local copy. Proved from the catalogue rather than by assertion: every CRM table that names a customer carries a foreign key to `business_partner`, and no `crm_customer` table exists for the two to drift apart

---

### 08.4 Activities, calendar and contacts

**Build** — activity logging, calendar, contact management against partner and opportunity

**Test gate**
- [x] Activities link to lead, opportunity, partner or case and are retrievable from each — **exactly one** of the four, held by a check, so a deleted opportunity cannot leave an activity pointing at nothing
- [x] Completed activities remain in the audit trail — with the outcome recorded on completion
- [x] Contact records respect the partner's data scope — one primary contact per partner, held by a partial unique index: "who do we call?" cannot have two answers

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
- [x] Opportunity-to-order conversion retains the same customer and source identifiers (§6 acceptance criterion 1) — the order is read back after creation and checked rather than the copy being trusted, and a trigger refuses an opportunity linked to an order for a different customer
- [~] Opportunity-to-project conversion does the same — *awaits Phase 11.* There is no project master to convert into yet, and a stub would be a second answer to "where do projects come from?"
- [x] Business line determines the conversion target — taken from the opportunity, never from the caller, so the target cannot be argued with at conversion time
- [x] Converted data is copied, not re-keyed, and the link back to the opportunity persists — customer, branch and business line come from the opportunity; only what an order needs and an opportunity does not (prices, warehouses, real quantities) is supplied. One opportunity becomes one order, held by a unique index: a second would count the win twice

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
- [x] Customer 360 shows only records the viewing user is authorised to see — two populations behind one screen, governed by two permissions: commercial history follows CRM, financial figures follow A/R
- [x] Financial figures match A/R ageing and the customer statement exactly — read from `ar_invoice` with the same outstanding-and-overdue arithmetic, not recomputed
- [x] A user without A/R permission sees the commercial history but not the financial figures — **omitted, not zeroed.** An absent figure and a figure of nothing are different statements, and only one of them is true
- [~] History spans all six source modules where data exists — leads, opportunities, orders, cases and activities are in. Logistics jobs and Money Transfer history became reachable when Phases 09 and 10 merged, and are the remaining half of this line

---

### 08.7 After-sales and warranty cases

**Build** — case management linked to the warranty record from Phase 06.7

**Test gate**
- [x] A case links to the originating invoice and serial number
- [x] Warranty validity is resolved from the Phase 06.7 calculation, not re-entered — the case has **no expiry column**, so there is no second answer to disagree with the first when a warranty is extended
- [x] Case history appears in Customer 360

---

### 08.8 CRM reports

**Build** — per §6 and Appendix D: Pipeline by stage and owner; lead-source conversion; lost-opportunity reasons; customer activity; inactive customers; Customer 360 commercial and financial history. Filters: owner, stage, customer, business line.

**Test gate**
- [x] Pipeline totals reconcile to the underlying opportunity records — unweighted **and** weighted by probability, because they answer different questions: what is on the table, and what a treasurer should believe
- [x] Every report respects data scope
- [x] Lead-source conversion rates compute from actual conversions, not estimates — leads raised, how many became opportunities, how many were won; nothing modelled

---

## Phase exit gate

§6 minimum acceptance criteria, verbatim:

| # | Criterion | Evidence |
|---|---|---|
| 1 | Lead-to-opportunity and opportunity-to-order/project conversion retain the same customer and source identifiers | 08.2 and 08.5 gates — enforced in the service *and* by trigger, at both ends. The **project half awaits Phase 11** |
| 2 | Duplicate and blocked-customer controls are enforced | 08.1 and 08.3 gates — duplicates on all five criteria, reported rather than refused; a partner who is not approved and active cannot be sold to |
| 3 | Customer 360 displays authorised operational and financial history | 08.6 gate — the financial half omitted rather than zeroed for a viewer without A/R rights |
| 4 | Every stage, ownership and master-data change is audited | 08.2 and 08.4 gates — including the reason a loss was recorded, and nothing written for a change that changed nothing |

**Tests:** `tests/integration/phase08-crm.test.ts` — 47 integration tests;
`tests/unit/crm.test.ts` — 29 unit tests.

**What is deliberately not closed:**

| Gate | Why |
|---|---|
| Lead import through the Phase 01 framework | The framework and `createLead` both exist; registering the definition is the small piece left |
| Opportunity-to-project conversion | Awaits Phase 11. A stub would be a second answer to "where do projects come from?" |
| Customer 360 across all six modules | Five are in. Logistics and Money Transfer history became reachable only when those phases merged |

**The rule this phase is built around:** Appendix B says an opportunity has *no
posting*, and nothing in Phase 08 has a journal column to record one in. The
absence is the control — a nullable link that was always null would be an
invitation, and the first person to fill it in would create revenue nobody sold.

**Completes the Phase 06 end-to-end scenario:**
> **Lead → opportunity →** Sales Order → reservation → partial delivery → A/R Invoice → receipt → allocation → customer statement → G/L and margin report

**Sign-off:** Sales and the Business Process Owner.
