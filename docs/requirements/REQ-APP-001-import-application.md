# REQ-APP-001 — Import Application (QS ERP Workflow)

One import, one application. The application opens with the supplier's pending
order / invoice and stays open until every container is in the warehouse, the
PD is totally written off and the supplier is fully paid. Every update from
every lane — order, bank & finance, payment, PD, each container, warehouse — is
recorded on the application, and the application always shows where it is,
whether it is stopped, and why.

This document is the written form of **`QS_ERP_Workflow_Final.pdf`** (copy at
`docs/requirements/REQ-APP-001-workflow.pdf`). Every box, arrow and band on that
page is specified here, stage by stage and screen by screen. Where this document
and the diagram disagree, the diagram is the intent and this document is wrong.

| | |
|---|---|
| **Requirement ID** | `REQ-APP-001` |
| **Release** | 2 |
| **Phase** | Operations build — Import module, delivered in the seven stages of §19 |
| **Source** | `QS_ERP_Workflow_Final.pdf` · `QS_DASHBOARD.xlsx` (the Google Sheet the company runs on today) · the code review of 2026-10-01 summarised in §3 |
| **Test case(s)** | §20 names the test file for every acceptance criterion; none exists yet |
| **Status** | Draft — for approval |
| **Approved by** | *Not yet approved. §28.1 requires written approval from the Business Process Owner before any of this is built.* |

---

## 0. How to read this document

* **Part A** (§1–§4) — objective, actors, what the system has today, and the
  five rules that everything else follows.
* **Part B** (§5–§6) — the application record, its stages, and the status log.
* **Part C** (§7–§12) — the six lanes of the diagram, one section each, in the
  order they appear left to right.
* **Part D** (§13) — the "Where is it stopped — and why?" band.
* **Part E** (§14) — the "Application cleared" band and the landed cost.
* **Part F** (§15) — every screen, one by one.
* **Part G** (§16–§18) — data preservation, scalability, integrations, migration
  of the current sheet.
* **Part H** (§19–§22) — delivery stages, acceptance criteria, out of scope,
  open questions.

Words used throughout:

| Word | Meaning here |
|---|---|
| **Application** | The import record keyed by the supplier's PO / INV number. Everything in this document hangs off it. |
| **Lane** | One of the six vertical tracks on the diagram. Lanes run side by side and move at their own speed. |
| **Stage** | One of the eight numbered positions in the *Application status* column. Derived, never typed. |
| **Event** | One row in the application status log. Append-only. |
| **Hold** | A recorded stop: where, why (reason code), who owns it, since when, next action. |
| **Time limit** | The number of days a stage may take before a hold is required. **Configured, never hard-coded.** |

---

# Part A — Objective, actors, today, rules

## 1. Business objective

The company imports solar panels, batteries, inverters and related goods from
China, Singapore and the UAE into Iraq through Aqaba and Umm Qasr. Each import
is paid through an Iraqi bank by SWIFT against a customs pre-declaration (PD)
registered in ASYCUDA, ships on one or more bills of lading, and arrives
container by container into one of several warehouses.

Today this is run in a Google Sheet (`QS_DASHBOARD.xlsx`). The review of that
sheet on 2026-10-01 found, among 58 live invoices worth USD 35.3M:

* 25 payment applications not paid (USD 8.14M); 17 of them had waited 19–112
  days since the application date, and **none** had a recorded reason.
* 177 containers across 46 B/Ls, stored as one text cell per B/L, with **no
  status per container** — so a B/L with seven containers of which four
  arrived cannot be expressed.
* Received quantity copied from the invoice onto every B/L, so one invoice on
  four B/Ls showed four times its quantity as received.
* 11 of the 25 "not paid" applications already had their PD totally written
  off — most likely paid, but the SWIFT date was never entered.
* 31 PDs that matched no invoice; invoice keys with stray spaces; supplier
  names with leading spaces.

The sheet loses data because it overwrites cells; it cannot say why something
is late because it has nowhere to write it; and it cannot grow because every
new case (a second B/L, a third instalment, a new bank) means a new column.

The objective of this requirement is therefore:

1. **One record per import** that every department updates and everyone reads.
2. **A status log that records everything** — not only problems — and is never
   overwritten.
3. **An answer, always, to "where is it stopped and why?"** — with an owner and
   a next action — recorded on the application itself.
4. **Never lose data.** Nothing on an application is deleted; corrections are
   new rows; the history is complete.
5. **Scalable, not fixed.** Any number of B/Ls, containers, instalments, PDs,
   banks, loans and warehouses per application; every list (stages, reason
   codes, ports, statuses, time limits) is master data a manager edits, not a
   constant a developer changes.

Process owner: Business Process Owner (Issa Mohammed), per §28.

## 2. Actors and permissions

The module introduces one permission object per new document and reuses the
existing objects for everything it touches. Roles below are the existing role
codes; a new role `logistics_officer` and `customs_officer` are proposed
(§22 Q1) — until approved, `accounting_officer` covers both.

| Object | view | create / edit | approve / confirm | hold / resolve hold | who, today |
|---|---|---|---|---|---|
| `import_application` | all operations roles | purchasing, accounting_officer | accounting_manager | anyone who may edit the lane in question | — |
| `payment_application` | accounting roles | accounting_officer | accounting_manager (approve), accounting_officer (SWIFT confirm) | accounting_officer | — |
| `customs_pd` | all operations roles | customs_officer / accounting_officer | — | same | — |
| `bill_of_lading`, `shipment_container` | all operations roles | logistics_officer / purchasing | — | same | — |
| `container_receipt` (goods receipt per container) | warehouse, accounting | warehouse user of that branch | — | warehouse | — |
| `bank` (master), `bank_loan` | accounting roles | accounting_manager | ceo for loans above `approval_limit_iqd` | — | — |
| `import_settings` (stages, limits, codes, ports, statuses) | accounting_manager | accounting_manager | — | — | — |
| `application_event` | whoever may view the application | *nobody — written by the system only* | — | — | — |

Branch rule: an application belongs to the branch of its purchase order; its
containers may land in any warehouse of that branch (existing warehouse-branch
rule, `inventory.receive` refuses otherwise). RLS follows the existing
`permitted_branches` function.

## 3. What the system has today (code review, 2026-10-01)

Read before designing anything, so that nothing is built twice.

| Diagram lane | Exists | Does not exist |
|---|---|---|
| **Order & invoice** | Purchase order (`purchase_order`, hidden — no screen in `OPERATIONS`). AP invoice (`ap_invoice`, live) with `purchase_order_id`, partial settlement (`settled_amount_iqd`), reversal. Payment terms master (`payment_terms` + `payment_term_instalment`) — **days-based only**, and the instalment schedule is computed but never applied to an invoice (`domain/payment-terms.ts:239-242`). | A record keyed by the supplier's PO / INV no. that spans documents. Deposit % + "balance against B/L" terms. Proforma invoice. |
| **Bank & finance** | `bank_cash_account` (one G/L account each; `bank_name` free text; `swift`, `iban`, `currency`). Balance = G/L; "committed" = approved bank transfers + pending payment-batch lines (`treasury.balances`). Bank statements and reconciliation. `investment_capital_call` as a dated-obligation pattern. | Bank master (Mansour, Arab, NBI, Rafidain). Reservation of money for a specific payment. Loans: principal, commission, net proceeds, schedule, instalment status. Deposits of own money as a document. Native-currency available balance. |
| **Payment** | Supplier payment (draft → approved → posted), supplier advance (per PO), payment proposal/batch (pays full outstanding only), allocations. Money transfers have a *Sent (requires bank reference) → Completed* pattern worth copying. | A "payment application to the bank" document with sent / SWIFT-confirmed / debited states, SWIFT date and reference, days waiting. Instalment-level tracking. USD payment from an IQD account (refused today). |
| **PD / ASYCUDA** | Nothing. | Everything: PD record, statuses, expiry, bank code, port file, write-off. |
| **Shipment per container** | `supplier_shipment`: one per AP invoice, four fixed stages (`in_process → on_board → on_port → in_bounded`), each stage = one staging warehouse, moves *all* the invoice's stock at once, no dates, no B/L. `logistics_job_leg.transport_document_no` holds a B/L number but only for client logistics jobs. Staging warehouses are seeded as type `main`, so **goods at sea count as available for sale** (defect). | B/L entity, container entity, per-container status / ETA / port, "X of Y received", partial arrival. |
| **Warehouse & stock** | FIFO inventory ledger (`inventory_movement` + `cost_layer`), stock per item per warehouse, goods receipt per PO (schema only, no screen), transfers with requested/issued/received quantities. | Receipt per container. Planned vs received per container. In-transit that excludes goods at sea from availability. Landed cost into FIFO cost. |
| **Application status / stops** | `audit_event` — append-only by trigger, before/after JSON, shown by `RecordHistory`. `workflow_decision` append-only. `collection_activity` append-only follow-up log. CRM opportunity has `owner`, `next_action`, `next_action_on`. `ar_write_off_reason` reason-code master. Daily sweep `due-notices.ts` (dedupes one notice per item per day). Notification rules with escalation fields (unscheduled). | A cross-document timeline. Hold record (stopped / reason / owner / since / next action). Stage time limits. A sweep that detects over-limit stages. |

The audit trail, the status machine helper, numbering, attachments, the
notification service and the due-notice sweep are reused as they are. The
four-stage `supplier_shipment` is **superseded** by §11 and kept read-only for
history (§18.4).

## 4. The five rules

Everything in Parts B–F follows from these. A design that breaks one of them is
wrong even if it is convenient.

**R1 — One key.** The application is the parent of every import document. A
document that belongs to an import carries `application_id`; a document that
does not carry it is not part of any import. The supplier's PO / INV number is
stored on the application (`supplier_reference`), normalised for matching
(upper case, letters and digits only — the same rule the sheet's formulas use),
and must be unique per supplier.

**R2 — Lanes are independent.** Payment status never implies shipment status,
PD status never implies payment status. Each lane keeps its own state and its
own dates. The *stage* (§5.3) is derived from the lanes; nobody types it.

**R3 — Append, never overwrite.** The application status log, holds, PD status
history and container status history are append-only tables protected by the
same trigger that protects `audit_event`. A correction is a new row that says
what was wrong. No screen, action or API deletes an application or anything
under it; the only end states are *cleared* and *cancelled (with reason)*.

**R4 — Configured, not coded.** Stages, time limits, reason codes, ports,
container statuses, PD statuses, banks, event codes and the landed-cost
allocation method are master data with an `active` flag, edited on a settings
screen by an accounting manager, effective immediately, and logged. Day numbers
in this document (e.g. "14 days") are **examples only** — the seed values on
first install, never a rule.

**R5 — Nothing is lost on the way in.** Existing data (the sheet, the current
`supplier_shipment` rows, posted invoices and payments) is migrated, not
re-typed, and every migrated row says where it came from.

---

# Part B — The application

## 5. The application record

### 5.1 `import_application`

| Field | Type | Rule |
|---|---|---|
| `id` | uuid | |
| `application_no` | text, unique | From the number series `APP` (prefix per branch, e.g. `APP-HQ-2026-000123`). Allocated on create, never reused. |
| `supplier_reference` | text | The supplier's PO / INV number exactly as written (e.g. `CSA-AL0001-1`). |
| `supplier_reference_key` | text | Normalised: upper case, `[A-Z0-9]` only. **Unique per supplier.** Used for matching imports from the sheet and for search. |
| `supplier_id` | fk `business_partner` | Required. |
| `branch_code` | fk `branch` | Required; from the PO. |
| `currency` | char(3) | Transaction currency of the invoice (USD today). |
| `invoice_amount_txn`, `invoice_amount_iqd` | numeric | From the linked AP invoice when posted; before that from the PI (typed). IQD at the accounting rate on the invoice date (`exchangeRates.convertOn`). |
| `invoice_quantity` | numeric | Sum of line quantities. Used by the *Cleared* rule. |
| `invoice_date` | date | |
| `product_summary` | text | Free text ("panel & batteries"), for the list. |
| `payment_terms_text` | text | The terms as written on the PI/invoice, kept verbatim (evidence). The structured form is §9.2. |
| `purchase_order_id` | fk, nullable | |
| `stage_code` | fk `application_stage` | **Derived** (§5.3). Stored for listing speed; recomputed on every event. |
| `stage_since` | timestamptz | When the current stage was entered. |
| `on_hold` | boolean | Derived: an open hold exists (§13). |
| `cleared_at` | timestamptz, nullable | Set once by the rule in §14.1. |
| `cancelled_at`, `cancel_reason` | nullable | The only other end state. |
| `source` | text | `erp` · `sheet_import` (§18) · `shipment_migration`. |
| `created_by/at`, `updated_at` | | |

One application may link to **many** AP invoices (`ap_invoice.application_id`,
nullable fk added by this requirement) — the sheet already has invoices
split "-A / -B". The *invoice amount* on the application is the sum.

### 5.2 What the application keeps (the chip row of the diagram)

The list screen and the application header show, for every application, the
fields in the diagram's "Application status keeps" row. Each is either a column
of §5.1 or a derived value defined here:

| Chip | Source |
|---|---|
| PO / INV no. | `supplier_reference` |
| Supplier | `supplier_id` |
| INV amount + qty | `invoice_amount_txn`, `invoice_quantity` |
| Payment terms | `payment_terms_text` + instalment plan (§9.2) |
| Bank + funding (deposit / loan) | From payment applications (§9.3): bank account(s) used, funding source(s) |
| PD no. + expiry | Latest PD (§10) — and a count if more than one |
| PD status | Latest PD status |
| Applied / Paid (SWIFT) / Remaining | §9.5 |
| B/L no. | All B/L numbers (§11) |
| Containers: X of Y received | §11.5 |
| POD + ETA per container | §11.3 |
| Inbounded qty | Sum of received container lines (§12) |
| Warehouse | Distinct warehouses that received containers |

And the "Always visible" row:

| Chip | Source |
|---|---|
| Current stage | `stage_code` + `stage_since` |
| Stopped? YES / NO | `on_hold` |
| Stop reason code | Open hold's `reason_code` |
| Owner | Open hold's `owner_user_id` |
| Stopped since + days | Open hold's `started_at`, today − started_at |
| Next action + expected date | Open hold's `next_action`, `next_action_due` |

### 5.3 Stages — the *Application status* column

Eight stages, seeded as rows of `application_stage` (code, sequence, name,
description, `active`). The sequence may be edited and stages may be added by
configuration (R4); the **derivation rule** of each seeded stage is fixed by
this requirement because it is what makes the stage true.

| # | Stage (seed) | The application is in this stage when… |
|---|---|---|
| 1 | **Order confirmed** | It exists and has no posted AP invoice yet (pending order / PI received). |
| 2 | **Invoiced + funded** | At least one AP invoice is posted and the instalment plan (§9.2) is set. "Funded" = the first instalment's payment application has a bank account and funding source recorded. |
| 3 | **PD registered** | At least one PD exists in a status that is not `rejected` / `expired` (§10). |
| 4 | **Payment in progress** | At least one payment application is in `sent` (applied to bank, waiting SWIFT). |
| 5 | **Shipped** | At least one B/L exists with at least one container. |
| 6 | **Partly received** | At least one container is `received` and at least one is not. |
| 7 | **All received** ✓ | Every container of every B/L is `received` (and at least one exists). *Goods tracking ends here* (diagram band). |
| 8 | **Cleared** ✓ | §14.1 — supplier fully paid **and** all received with qty = invoice qty **and** PD totally written off. |

Derivation: the stage is the **highest-numbered** stage whose condition holds,
except that 6 and 7 are exclusive, and 8 requires 7. Because lanes are
independent (R2), an application can be *Shipped* before it is *Payment in
progress* (deposit paid, balance against B/L) — the stage still reads 5, and the
payment lane shows its own state. The stage is recomputed inside the same
transaction as any event that can change it, and the change itself is an
event (`STAGE_CHANGED`).

### 5.4 Numbering, attachments, audit

* Number series `APP` is created by migration and maintained on the existing
  Numbering screen.
* Attachments use the existing attachment service against object type
  `import_application` (PI, invoice, PD print-out, B/L, packing list, port
  file, SWIFT copy, loan contract). An attachment event is written to the log.
* Every change still writes `audit_event` as today; the application log (§6)
  is in addition, not instead — the audit trail is the legal record of a
  change, the application log is the company's story of the import.

## 6. The application status log — "records everything"

### 6.1 `application_event` (append-only)

One row per update, from every lane, written **in the same transaction** as
the change it describes. Protected by the no-update/no-delete trigger of
`audit_event`.

| Field | Rule |
|---|---|
| `id`, `application_id` | |
| `occurred_at` | Business date/time of the thing (e.g. the SWIFT date), typed or taken from the document. |
| `recorded_at` | Server clock. Never typed. |
| `lane_code` | `order` · `bank` · `payment` · `pd` · `shipment` · `warehouse` · `application` · `hold` (master `application_lane`). |
| `event_code` | fk `application_event_code` (master, §6.2). |
| `summary` | One line, generated from a template in the code's master row, e.g. "SWIFT confirmed — deposit USD 536,715.12 paid from Arab Bank". Stored, not re-rendered, so it never changes. |
| `source_type`, `source_id`, `source_no` | The document that caused it (`payment_application`, `shipment_container`, `customs_pd` …) and its number. |
| `before`, `after` | jsonb; the changed fields only. |
| `actor_user_id` | From the session; `system` for sweeps. |
| `hold_id` | When the event opens, updates or resolves a hold (§13). |
| `attachment_id` | When the event is a document being attached. |
| `correction_of` | fk `application_event`, nullable — a correction points at the row it corrects; neither is ever changed. |

Indexes: `(application_id, recorded_at desc)`; `(event_code, recorded_at)`;
`(source_type, source_id)`. The table is created **partitioned by year of
`recorded_at`** from day one so it can grow without a later rewrite (§16.2).

### 6.2 Event catalogue (seed) — what gets recorded

`application_event_code` is master data (code, lane, name, summary template,
`active`). New codes are added by configuration; a code is never deleted. Seed:

| Lane | Code | Written when |
|---|---|---|
| application | `APPLICATION_OPENED` · `STAGE_CHANGED` · `FIELD_CHANGED` · `ATTACHMENT_ADDED` · `NOTE_ADDED` · `CLEARED` · `CANCELLED` · `CORRECTION` | the application itself changes |
| order | `PO_LINKED` · `PI_RECORDED` · `INVOICE_POSTED` · `INVOICE_REVERSED` · `TERMS_SET` · `TERMS_CHANGED` · `MOVED_TO_BL` | §8 |
| bank | `BANK_ACCOUNT_ASSIGNED` · `DEPOSIT_RECORDED` · `LOAN_LINKED` · `FUNDS_RESERVED` · `FUNDS_RELEASED` · `DEBIT_FINAL` · `LOAN_INSTALMENT_PAID` · `LOAN_INSTALMENT_OVERDUE` · `COMMISSION_RECORDED` | §9 (bank side) |
| payment | `INSTALMENT_PLANNED` · `PAYMENT_APPLIED` · `SWIFT_PENDING` · `SWIFT_CONFIRMED` · `PAYMENT_REJECTED` · `PAYMENT_CANCELLED` · `FULLY_PAID` · `SWIFT_OVER_LIMIT` | §9 |
| pd | `PD_SUBMITTED` · `PD_STATUS_CHANGED` (carries old → new) · `PORT_FILE_SENT` · `PD_EXPIRING` · `PD_EXPIRED` · `PD_REJECTED` · `PD_REREGISTERED` · `PD_TOTALLY_WRITTEN_OFF` | §10 |
| shipment | `BL_ISSUED` · `CONTAINER_ADDED` · `CONTAINER_STATUS_CHANGED` · `ETA_CHANGED` · `CONTAINER_LATE` · `ALL_CONTAINERS_RECEIVED` | §11 |
| warehouse | `CONTAINER_RECEIVED` (qty, warehouse) · `QUANTITY_VARIANCE` · `STOCK_AVAILABLE` · `OUTBOUND_RECORDED` | §12 |
| hold | `HOLD_OPENED` · `HOLD_UPDATED` · `HOLD_REASSIGNED` · `HOLD_RESOLVED` · `OVER_LIMIT_DETECTED` · `ESCALATED` | §13 |
| cost | `CHARGE_RECORDED` · `LANDED_COST_LOCKED` · `ITEM_COST_ALLOCATED` | §14.2 |

Rule: **a service that changes anything under an application must write at
least one event, or its transaction is rejected** — enforced by an integration
test that walks every service touching `application_id` (§20, test
`imp01-event-coverage`).

### 6.3 What the log shows (the "Example of one application's history" box)

The log is shown newest-first on the application page and oldest-first when
printed, one line per event: date · lane chip · summary · who. Holds show as
red lines ("STOPPED: BANK — SWIFT over limit, calling bank"). A filter by lane
and a search box are the only controls. There is no edit.

---

# Part C — The six lanes

Each section below follows the lane's boxes top to bottom as drawn. For each
box: what it is, what is stored, what moves the lane on, what is logged, and
the exception box at the bottom of the lane.

## 7. Lane rules common to all lanes

* A lane's state is held on its own document(s), never on the application.
* Every state change goes through `statuses.assertTransitionAllowed` using a
  transition table seeded by migration **and editable in import settings**
  (new rows only; a seeded transition may be deactivated, not deleted).
* Every state change writes `audit_event` (existing) **and** `application_event`
  (§6).
* A *dashed arrow* on the diagram is a dependency check: the target action
  refuses with a plain-language message naming what it waits for (e.g.
  "Payment application needs a validated PD — PD 9330 is still PreApproved").
  A manager may override with a reason; the override is an event.
* Dates are typed as business dates; the server stamps `recorded_at`.

## 8. Lane 1 — Order & invoice ("What we buy")

| Box | Specification |
|---|---|
| **Pending order / PI** | Creating the application records the proforma / pending order: supplier, PI number (= `supplier_reference`), PI date, currency, amount, and the model lines (item code, description, quantity, unit price). Lines are stored in `application_order_line` so quantity is known before the invoice exists. Optional link to an existing `purchase_order`. Event `APPLICATION_OPENED`, `PI_RECORDED`. |
| **Purchase invoice** | The existing AP invoice, created from the application page ("Create purchase invoice") with lines pre-filled from the PI, or linked afterwards by picking an existing posted invoice of the same supplier whose reference matches `supplier_reference_key`. Posting the invoice writes `INVOICE_POSTED` with amount and quantity; reversal writes `INVOICE_REVERSED` and re-derives the stage. Several invoices per application are allowed; one invoice belongs to at most one application. |
| **Payment terms** | `payment_terms_text` (verbatim) and the structured instalment plan of §9.2, entered together. Event `TERMS_SET`; any later change `TERMS_CHANGED` with before/after. The invoice's own `due_date` (existing) is kept for AP ageing and is set from the last instalment's expected date. |
| **Move to BL** | Automatic. The moment the first B/L is recorded (§11.1) the order lane writes `MOVED_TO_BL`; from then on quantities are tracked per container, and the PI lines become the plan to check containers against. |
| *(no exception box)* | — |

## 9. Lanes 2 and 3 — Bank & finance ("Where the money comes from") and Payment ("Paying the supplier")

The two lanes are specified together because every dashed arrow between them
is a rule.

### 9.1 Bank accounts (box "Bank accounts — Mansour · Arab · NBI · Rafidain")

* New master `bank` (code, name, SWIFT/BIC, country, `active`), seeded from the
  PD sheet's bank codes: `MBIVIQBAXXX` Mansour (32), `ARABIQBAXXX` Arab (88),
  `NBIQIQBAXXX` NBI (15), `BABIIQBAXXX` (8), plus Rafidain. **Not a fixed list.**
* `bank_cash_account.bank_id` (fk, nullable for cash accounts) replaces the
  free-text `bank_name` for bank accounts; the text column is kept and
  back-filled.
* Three figures per account, in the account's **own currency** and in IQD:
  * **Booked** — the G/L balance (existing `treasury.balances`).
  * **Reserved** — money held for payment applications in `approved` or `sent`
    (§9.3) **plus** the existing commitments (approved transfers, pending
    batch lines). Added to the `committedIqd` subquery.
  * **Available** = Booked − Reserved. Shown on the account screen and in the
    payment-application picker.

### 9.2 Instalments planned (box in the Payment lane)

`application_instalment` — the structured form of the terms:

| Field | Rule |
|---|---|
| `sequence` | 1, 2, 3 … unlimited. |
| `label` | "Deposit", "Balance", "2nd payment" (free). |
| `basis` | `percent` of invoice amount **or** `amount` in transaction currency. The plan must total 100 % / the invoice amount; the last instalment absorbs rounding (existing `instalmentSchedule` rule). |
| `trigger` | Master `instalment_trigger` (seed): `on_order` · `before_production` · `before_shipment` · `against_bl_copy` · `against_bl_original` · `days_after_bl` · `days_after_invoice` · `on_arrival_warehouse` · `after_delivery` · `sinosure_credit`. Configurable (R4). |
| `trigger_days` | For the `days_after_*` triggers (e.g. 60). |
| `expected_date` | Derived when the trigger's event happens (B/L date + 60), typed for `on_order`; recomputed and logged when the trigger date changes. |
| `status` | `planned` → `applied` (a payment application exists) → `paid` → `cancelled`. Derived from §9.3. |

The 60 terms texts in the sheet all fit this model ("TT 10% deposit, 90%
balance against B/L in 60 days" = two rows). Event `INSTALMENT_PLANNED`.

### 9.3 Payment application (box "Payment application — needs validated PD + funds")

A new document, `payment_application`, number series `PAYAPP`. It is the
**company's request to its bank** to pay the supplier. It is not a journal; the
journal is posted when the money leaves (§9.4).

| Field | Rule |
|---|---|
| `application_id`, `instalment_id` | Required. One instalment may have several payment applications only if an earlier one was rejected/cancelled. |
| `bank_cash_account_id` | Required. The account must be active and in the application's currency **or** flagged `fx_allowed` with the conversion rate recorded (§22 Q3). |
| `funding_source` | `own_funds` · `loan` (master, extensible). If `loan`, `loan_id` is required (§9.7) and the loan must have undrawn / unallocated proceeds ≥ amount. |
| `amount_txn`, `amount_iqd` | Typed in transaction currency; IQD at the accounting rate on `application_date`. |
| `application_date` | The date the file went to the bank. Required when the status becomes `sent`. |
| `bank_reference` | The bank's file / application number, if any. |
| `swift_date`, `swift_reference` | Required when the status becomes `swift_confirmed`. The SWIFT copy is attached. |
| `debit_date`, `statement_line_id` | Set when the debit is matched to a bank statement line (§9.4). |
| `status` | `draft` → `approved` → `sent` → `swift_confirmed` → `debited`; `rejected` (reason) / `cancelled` (reason) from `approved` or `sent`. Seeded transitions, editable. |
| `supplier_payment_id` / `supplier_advance_id` | The posted accounting document created at `swift_confirmed` (§9.4). |
| `pd_id` | The PD the bank paid against (required unless overridden). |
| `days_waiting` | Derived: today − `application_date` while `sent`. |

**Dashed-arrow checks on *send* (all overridable by a manager with a reason,
logged):**

1. *Needs validated PD* (arrow from PD lane): a PD of this application is in a
   status flagged `allows_payment` (seed: Validated, Partially written off) and
   not expired.
2. *Needs funds* (arrow from Bank lane): the account's **Available** ≥ amount.
   On approval the amount becomes **Reserved** (`FUNDS_RESERVED`); on
   rejection/cancellation it is released (`FUNDS_RELEASED`).
3. *Instalment trigger met*: for `against_bl_*` the application has a B/L;
   for `before_shipment` no container has left (`on_sea`); otherwise warning only.

### 9.4 SWIFT pending → SWIFT confirmed → Fully paid

| Box | Specification |
|---|---|
| **SWIFT pending — clock runs · NOT PAID** | Status `sent`. The list shows `days_waiting`. The daily sweep (§13.3) compares it with the time limit of stage *Payment in progress* **for that bank** (limits may be per bank, R4) and, when over, writes `SWIFT_OVER_LIMIT` and requires a hold (§13). The diagram's "e.g. 14 d" is the seed value. |
| **SWIFT confirmed — Swift date set · PAID** | Action *Confirm SWIFT*: type `swift_date`, `swift_reference`, attach the copy. In the same transaction the system creates and posts the accounting document through the **existing** services: a `supplier_advance` if no AP invoice is posted yet (deposit before invoice), otherwise a `supplier_payment` allocated to the application's invoice(s). Posting date = `swift_date`. Event `SWIFT_CONFIRMED`, and `DEBIT_FINAL` in the bank lane once the bank statement line is matched (existing reconciliation; the match sets `debit_date`). Reserved → released, Booked falls. |
| **Fully paid — Remaining = 0** | Derived (§9.5). Event `FULLY_PAID`. Instalment statuses become `paid`. |
| **Exception: SWIFT late — over limit (e.g. 14 d) → reason** | Not a status. It is the hold of §13 with lane `payment`, opened automatically by the sweep and completed by the accountant with the reason code. The payment application stays `sent` until the bank answers. |

Existing behaviour to change: `supplier-payment.allocate` today accepts a
`draft` payment, so an invoice can show as settled before money moved
(`services/supplier-payment.ts:291`). Within this module allocation happens
only at `swift_confirmed`, in the same transaction as posting.

### 9.5 Applied / Paid / Remaining (calculations)

For an application:

* **Applied** = Σ `amount_txn` of payment applications in `sent` + `swift_confirmed` + `debited`.
* **Paid (SWIFT)** = Σ `amount_txn` in `swift_confirmed` + `debited`.
* **Remaining** = invoice amount − Paid. (Before the invoice is posted: PI amount − Paid.)
* **Fully paid** ⇔ Remaining = 0 (to the currency's minor unit).

All three are also kept in IQD using each document's own rate. Totals are
computed in SQL from the rows, never stored on the application, so they cannot
drift (same principle as the inventory ledger).

### 9.6 Deposit / loan in — Available balance — Funds reserved — Debit final — Loan repayment (the Bank lane, top to bottom)

| Box | Specification |
|---|---|
| **Deposit / loan in — own money or bank loan** | *Deposit*: an existing *Other Receipt* against the bank account, with a new receipt type `owner_deposit` (posts bank ↔ equity/shareholder account). Event `DEPOSIT_RECORDED` on any application that names this account as its funding source and is not yet funded (informational). *Loan*: §9.7 disbursement. |
| **Available balance — booked − reserved** | §9.1. |
| **Funds reserved — held for the application** | §9.3 check 2. A reservation is a row in `payment_application` with status `approved`/`sent`; there is no separate table, so a reservation cannot exist without the document that explains it. |
| **Debit final — money left the account** | §9.4: the posted supplier payment/advance **and** the matched statement line. Until the statement match, the application shows "SWIFT confirmed, debit not yet seen on statement". |
| **Loan repayment — instalments + commission** | §9.7. |
| **Exception: no funds / instalment overdue** | *No funds*: the send check fails; the user may open a hold with reason `FUND`. *Instalment overdue*: the sweep marks a loan instalment overdue and writes `LOAN_INSTALMENT_OVERDUE` on every application that loan funds. |

### 9.7 Loans — `bank_loan`, `bank_loan_instalment`, `bank_loan_allocation`

Not fixed to any bank; one register for all.

**`bank_loan`**

| Field | Rule |
|---|---|
| `loan_no` | Series `LOAN`. |
| `bank_id`, `bank_cash_account_id` | The lender and the account the proceeds land in. |
| `currency`, `principal_txn`, `principal_iqd` | |
| `commission_pct`, `commission_txn` | Commission amount defaults to principal × pct; editable (banks round). |
| `commission_treatment` | `deducted_at_disbursement` (net proceeds credited) · `paid_separately` · `spread_over_instalments`. Master, extensible. |
| `interest_pct_pa` | Nullable; the seeded Rafidain example has none. |
| `net_proceeds_txn` | Derived: principal − deducted commission. |
| `disbursement_date` | When money arrived. Required to move to `active`. |
| `instalment_count`, `frequency` (`monthly`/`quarterly`/`custom`), `first_due_date`, `maturity_date` | Generate the schedule; `custom` lets the user type each due date. |
| `status` | `draft` → `approved` → `active` → `fully_repaid`; `cancelled`. `overdue` is a flag on instalments, not a loan status. |
| `purpose`, attachments | Contract, schedule, bank letters. |

**`bank_loan_instalment`**: `sequence`, `due_date`, `principal_txn`,
`commission_txn` (if spread), `interest_txn`, `total_txn`, `status`
(`upcoming` → `due` (within the configured warning days, seed 7) → `paid` /
`overdue`), `paid_date`, `supplier_payment_id`/journal reference of the
repayment. The last instalment absorbs rounding.

**`bank_loan_allocation`**: which applications the loan funded and how much —
written automatically from payment applications with `funding_source = loan`.
The **commission share** of each application = commission × (allocated amount /
principal), recomputed when allocations change, and recorded as a landed-cost
charge of type `bank_commission` (§14.2). The allocation method is
configurable (`by_amount_used` seed; `equal`, `manual` alternatives).

**Accounting events (existing journal service, new posting mappings):**

| Event | Dr | Cr |
|---|---|---|
| Disbursement (net) | Bank account (net proceeds) · Bank commission expense **or** prepaid/landed-cost clearing (per treatment) | Loan liability (principal) |
| Instalment paid | Loan liability (principal) · interest expense | Bank account |
| Commission paid separately | Commission expense / clearing | Bank account |

A **loan liability control account** kind is added to the chart-of-accounts
control kinds (`domain/chart-of-accounts.ts`) so the subledger reconciles like
AP and AR do.

## 10. Lane 4 — PD / ASYCUDA ("Customs pre-declaration")

### 10.1 `customs_pd`

| Field | Rule |
|---|---|
| `application_id` | Required. **Several PDs per application are allowed** (the sheet has invoices with 2–3 PDs; a rejected or expired PD is re-registered, never edited). |
| `pd_no` | The ASYCUDA number. Unique per registration year. |
| `registration_date`, `expiry_date` | Expiry typed (the sheet shows 181–257 days; **not computed**, the validity is the customs office's). |
| `bank_id`, `bank_swift` | The bank the PD is registered with; a payment application against this PD must use an account of that bank (check 1 of §9.3, overridable). |
| `status` | fk `pd_status` master — seed exactly the ASYCUDA list: `submitted` (Submited) · `pre_approved` · `validated` · `partially_written_off` · `totally_written_off` · `rejected` · `expired_validated` · `expired_part_written_off`. Each row carries flags: `allows_payment`, `is_terminal`, `is_expired`. New statuses by configuration. |
| `status_history` | `customs_pd_status_history` (append-only): status, effective date, source (`user` / `asycuda_screenshot` / `sweep`), note, attachment. |
| `port_file_sent_on` | Per container, see §11.3 (`port_file_sent_on` lives on the container); the PD shows the count "port files sent: 3 of 5". |
| `notes` | Free text — replaces the sheet's "Pending" notes ("port file needed urgently", "3597 need swift"). Each note is also an event. |

### 10.2 Boxes

| Box | Specification |
|---|---|
| **PD submitted — registered in ASYCUDA** | Create with `submitted`. Event `PD_SUBMITTED`. |
| **PreApproved — waiting validation** | Status change. `PD_STATUS_CHANGED`. |
| **Validated — bank + SWIFT code · valid period** | Status `validated` unlocks payment applications (§9.3). The *valid period* is `registration_date → expiry_date`; the sweep writes `PD_EXPIRING` at the configured warning (seed 45 days) and `PD_EXPIRED` on the day after expiry, and requires a hold with reason `PD` if the PD is not terminal. |
| **Port file sent — per arrived container** | Action on a container (§11.3) that has reached `customs_cleared`; records `port_file_sent_on`; event `PORT_FILE_SENT` on the PD lane. |
| **Partially written off — some containers settled** | Status change, normally after the first port files. |
| **Totally written off — PD fully settled** | Terminal, feeds *Cleared* (§14.1). Event `PD_TOTALLY_WRITTEN_OFF`. |
| **Exception: Rejected / Expired → re-register** | `rejected` and the two `expired_*` statuses are terminal for that PD row. Action *Re-register* creates a new PD row linked by `supersedes_pd_id`; the old one stays. Event `PD_REREGISTERED`. A hold with reason `PD` is required until the new PD is validated. |

## 11. Lane 5 — Shipment, per container ("Every container on its own")

### 11.1 `bill_of_lading`

| Field | Rule |
|---|---|
| `application_id` | Required. **Unlimited B/Ls per application.** |
| `bl_no`, `bl_date` | Unique `bl_no`. |
| `shipping_line`, `vessel`, `voyage` | Optional. |
| `port_of_loading`, `port_of_discharge_id` | POD from master `port` (seed Aqaba, Umm Qasr; extensible). |
| `eta` | B/L-level ETA; each container may override. |
| `status` | **Derived** from its containers: the least-advanced container's status (so a B/L is `received` only when all its containers are). |
| `total_quantity` | Σ container lines (planned). Compared to the PI/invoice lines; a mismatch is a warning event `QUANTITY_VARIANCE`, not a block. |

Recording the first B/L writes `BL_ISSUED` and triggers `MOVED_TO_BL` (§8).
Instalments with trigger `against_bl_*` get their `expected_date`.

### 11.2 `shipment_container`

| Field | Rule |
|---|---|
| `bl_id`, `application_id` | |
| `container_no` | ISO 6346 format checked (4 letters + 7 digits); duplicates across live B/Ls refused; the same number may recur on a later import after this one is received. |
| `size_type` | 20GP / 40HC … free master. |
| `status` | fk `container_status` master. Seed: `not_loaded` · `on_sea` · `at_port` · `customs_cleared` · `received` · `late` · `missing_damaged`. Flags per row: `counts_as_received`, `is_exception`, `sequence`. Editable (R4). |
| `eta` | Per container; defaults from the B/L. Changing it writes `ETA_CHANGED` (old → new). |
| `departed_on`, `arrived_port_on`, `customs_cleared_on`, `port_file_sent_on`, `received_on` | One date per stage, **all kept** (never overwritten; a re-dated stage writes a correction event). |
| `warehouse_code` | Where it was received (the receipt sets it). |
| `container_receipt_id` | The goods receipt that received it (§12). |
| `status_history` | `shipment_container_status_history` (append-only): status, date, actor, note. |

`shipment_container_line`: `item_code` (the model), `description`, `planned_qty`,
`unit`, `received_qty`, `damaged_qty`, `short_qty`, `warehouse_code` — one row
per model per container (a container may carry several models; a model may be
split across containers).

### 11.3 Boxes

| Box | Specification |
|---|---|
| **Not shipped — awaiting loading** | Stage 5 not yet reached: no B/L, or containers `not_loaded`. |
| **B/L issued — lists every container no.** | §11.1; containers are entered with the B/L (paste a list of numbers; the system splits and validates). |
| **On the sea — each container: own ETA** | Status `on_sea`, `departed_on`. |
| **On port / customs — container by container** | `at_port` with `arrived_port_on`; then `customs_cleared` with `customs_cleared_on`; then *Port file sent* (§10.2). |
| **Container received — inbound date per container** | Set only by the warehouse receipt (§12); never typed here. |
| **"partly: 3 of 5 in"** | §11.5. |
| **All containers in — Y of Y received** ✓ | Derived; writes `ALL_CONTAINERS_RECEIVED`; stage 7. |
| **Exception: Container late — ETA passed, not arrived** | The sweep sets `late` on any container whose `eta` < today and status is before `at_port`; event `CONTAINER_LATE`; a hold with reason `SHIP` is required on the application. When the container arrives, the status moves on and the hold is resolved with what happened. `missing_damaged` is set by the receipt when quantities differ (§12). |

### 11.4 The existing four-stage shipment

`supplier_shipment` (`in_process → on_board → on_port → in_bounded`) is
replaced by this lane. The `/inventory/in-transit` screen becomes the
*Containers in transit* list (§15.9). Existing rows are migrated (§18.4) and the
table is kept read-only.

Stock while at sea: the staging warehouses WH-INPROC / WH-BOARD / WH-PORT are
changed to type **`transit`** so that `stock_position` stops counting goods at
sea as available for sale (defect found in review). In this lane goods are
**not** in any warehouse until received (§12); the *in transit* figure is the
Σ planned − received of container lines, shown on availability as a separate
"incoming" column, never as on-hand.

### 11.5 X of Y

* **Y** = number of containers across all B/Ls of the application.
* **X** = containers whose status has `counts_as_received`.
* Shown as "X of Y received" on every list and header; stage 6 while
  0 < X < Y, stage 7 when X = Y > 0.
* *Partly received for longer than the configured limit* (seed 30 days from the
  first receipt) → the sweep requires a hold with reason `SHIP`.

## 12. Lane 6 — Warehouse & stock ("What we have in stock")

| Box | Specification |
|---|---|
| **Container detail — container × model × WH** | `shipment_container_line` (§11.2). This is the plan the receipt is checked against. |
| **In transit — planned − received qty** | Derived per model and per application; feeds the availability screen's "incoming" column (§11.4). |
| **Inbound — date + qty per warehouse** | **Receive container**: a goods receipt keyed to the container (`goods_receipt.container_id`, new nullable fk; `purchase_order_id` becomes nullable so a receipt can be per container when the PO exists only as a PI). One receipt per container; several containers may be received in one session but each gets its own document. Lines pre-filled from the container lines; the user confirms `received_qty`, `damaged_qty`, `short_qty`, warehouse (must belong to the application's branch). Posting writes `inventory_movement` + `cost_layer` rows in the same transaction (existing `inventory.receive`, unit cost from the AP invoice line; if the invoice is not posted yet, the PI price, corrected at invoice posting through the existing cost-adjustment path). Sets the container `received`, `received_on`, `warehouse_code`; events `CONTAINER_RECEIVED` and, if any variance, `QUANTITY_VARIANCE` + status `missing_damaged` on the container + an automatic hold with reason `OTHER`/"claim" for purchasing. |
| **In stock — inbound − outbound · 9 WH** | Existing `stock_position` per item per warehouse. "9 WH" on the diagram is the company's current count, not a limit — warehouses are master data. |
| **Outbound / sales — sales invoice, customer** | Existing AR invoice / delivery note. When an AR invoice issues stock from a cost layer that came from a container of an application, the application receives an informational `OUTBOUND_RECORDED` event (traceability of what was sold from which import). |

The received quantity of an application = Σ `received_qty` over container
lines — the fix for the sheet's double counting.

---

# Part D — Where is it stopped, and why?

## 13. Holds

### 13.1 Principle (the red band of the diagram)

> Any problem that appears in tracking must be updated in the application
> status. Any stage over its time limit must carry a reason code, owner and
> next action. Time limits are set by you. Every change is logged.

A **hold** is how that is done. Holds are opened in two ways:

* **Automatically**, by the daily sweep, when a lane has been in a state longer
  than the configured time limit (SWIFT pending, PD not validated, container
  ETA passed, partly received too long, PD expiring…). The sweep opens the hold
  with reason `PENDING_REASON` and **no owner**; the application then shows
  *Stopped? YES — reason required*, and the list screen sorts it to the top.
  The responsible person must complete it (reason, owner, next action) — the
  application cannot be edited in that lane until they do (manager override
  with reason allowed and logged).
* **Manually**, by anyone who learns of a problem ("supplier's bank details
  are wrong", "customs is holding the container"), from the *Stop / follow-up*
  dialog on the application page — at any stage, over limit or not.

### 13.2 `application_hold` (append-only state, never deleted)

| Field | Rule |
|---|---|
| `application_id`, `lane_code`, `stage_code` | Where. |
| `source_type`, `source_id` | The document that is stuck (payment application, container, PD). |
| `reason_code` | fk `hold_reason_code` master. Seed the twelve codes of the diagram: `PD` not validated / expired · `FUND` waiting deposit or loan · `DOC` documents missing at bank · `BANK` bank internal approval · `CBI` platform / K2 compliance review · `REJ` rejected, resubmit · `SUP` supplier bank details / query · `CORR` correspondent bank hold · `AMT` amount mismatch · `SHIP` container delayed at origin / port · `CUS` customs / port file pending · `OTHER` free text (detail required). Plus the system code `PENDING_REASON`. Each row: `code`, `name`, `lane_hint`, `default_owner_role`, `requires_detail`, `active`. **Editable** (R4). |
| `detail` | Free text; required for `OTHER`. |
| `owner_user_id` | Who is following up. Required to leave `PENDING_REASON`. |
| `started_at` | When the stop began — the sweep uses the date the limit was passed; a manual hold uses today or a typed earlier date. |
| `next_action`, `next_action_due` | Required. |
| `status` | `open` → `resolved`; never deleted. |
| `resolved_at`, `resolution` | What happened. |
| `escalated_at`, `escalated_to_role` | §13.4. |

Every change to a hold is a row in `application_hold_update` (append-only:
what changed, by whom, when) **and** an application event. The hold's current
values are a projection of its updates; the screen shows the full thread, like
`collection_activity` does for AR.

`on_hold` on the application = an open hold exists. "Stopped since + days" uses
the oldest open hold.

### 13.3 Time limits — `stage_time_limit`

| Field | Rule |
|---|---|
| `check_code` | Which clock: `swift_pending` · `pd_not_validated` · `pd_expiring` · `container_eta_passed` · `partly_received` · `at_port` · `invoice_unfunded` · … (master, extensible — each check is a named query in `services/import-sweep.ts`, registered in a table so a new check is a new row + a new named query, not a schema change). |
| `scope` | `all` · `bank:<code>` · `port:<code>` · `supplier:<id>` — the most specific active row wins. |
| `limit_days` | The number. **Seed values are examples** (swift_pending 14, pd_not_validated 7, pd_expiring 45, container_eta_passed 0 (= day after ETA), partly_received 30, at_port 10, invoice_unfunded 7). |
| `escalate_after_days`, `escalate_to_role` | §13.4. |
| `active`, `valid_from` | A changed limit is a new row; the old one is closed. |

The sweep (`scripts/ops/import-sweep.ts`, cron next to `due-notices`) runs
daily, idempotently: one `OVER_LIMIT_DETECTED` event and one automatic hold per
(application, check) while the condition holds — never a second one for the
same condition.

### 13.4 Escalation and notifications

* When a hold is opened the owner (or the reason code's default role) gets an
  in-app notification through the existing notification service, rule
  `import.hold.opened`.
* When a hold has no owner for longer than `escalate_after_days`, or stays open
  past the limit's escalation, the sweep writes `ESCALATED` and notifies
  `escalate_to_role` (seed: `accounting_manager`).
* Holds are visible on the existing dashboard's *Waiting on me* band for the
  owner — the only dashboard change in this requirement. (A separate alerts
  dashboard is **out of scope**, §21.)

---

# Part E — Cleared, and the landed cost

## 14. Application cleared

### 14.1 The rule (the orange band)

The application is **cleared automatically** — nobody clicks it — in the same
transaction as the event that satisfies the last of three conditions:

1. **Supplier fully paid** — Remaining = 0 (§9.5) and every payment application
   of the plan is `swift_confirmed` or `debited`.
2. **Every container received** — stage 7, and Σ received_qty = invoice
   quantity (short/damaged quantities resolved by a goods return, credit memo or
   an accepted variance recorded with a reason).
3. **PD totally written off** — every PD of the application that is not
   superseded is `totally_written_off`.

Event `CLEARED`, `cleared_at` set, stage 8. A cleared application is read-only
except for attachments and notes. If a condition later stops holding (an
invoice reversal, a corrected quantity), the application is **re-opened** with
event `CORRECTION` and the reason — `cleared_at` is kept in history, not
erased.

The sheet's manual "Clear?" column is replaced by this rule. During migration
(§18) the 22 rows marked "cleared" are compared with the rule and every
difference is listed for the accountant (the review found 6 marked cleared
whose PD is not written off, and 9 written off but not marked).

### 14.2 Landed cost (the box under the band)

`landed_cost_charge` — one row per cost that belongs to the import:

| Field | Rule |
|---|---|
| `application_id` | |
| `charge_type` | master `landed_cost_type`, seed: `purchase` (SWIFT paid) · `bank_commission` · `loan_cost` · `freight` · `customs_asycuda` · `port_forwarding` · `other`. Extensible. |
| `amount_txn`, `currency`, `amount_iqd` | |
| `source_type`, `source_id` | The AP invoice line (forwarder's invoice), journal, loan allocation, payment application that carries the cost. Charges are **created from documents**, not typed, except `other` with a reason. |
| `allocation_basis` | Inherited from settings: `by_value` (seed) · `by_quantity` · `by_weight` · `by_volume` · `manual`. |

**Final landed cost — locked after PD written off.** The action *Lock landed
cost* is offered once condition 3 of §14.1 holds (charges after that point are
rare but possible, so the lock is a deliberate action, not automatic, and a
late charge after the lock creates a new, dated adjustment — never an edit).
Locking writes `LANDED_COST_LOCKED` with the total.

**Item cost per model — allocated to each SKU in stock.** On lock, each
non-`purchase` charge is allocated across the application's received container
lines by the basis and written to the cost layers created by those receipts as
a **value-only adjustment** (`inventory_movement` of a new kind
`landed_cost_adjustment`, quantity 0, with the IQD value; the FIFO layer's
`unit_cost_iqd` is restated). Journal: Dr Inventory, Cr the clearing account
each charge was parked in. This is the only place where cost layers are
restated after receipt, and it is done inside the ledger's own rules (one
transaction, both tables, `AGENTS.md` ledger section). The new movement kind
is added to `resetTestData` and `format-live-database.sh`.

Event `ITEM_COST_ALLOCATED` per model with the resulting unit cost.

---

# Part F — Screens

## 15. Screen by screen

Conventions: every screen is a Next.js route under `src/app/(app)/imports/…`
(a new top-level **Imports** menu entry between *Purchasing* and *Inventory*),
registered in `phase-gate.ts` `OPERATIONS` and `domain/screens.ts` `DELIVERED`
on the day it reads real data, uses `DocumentWindow` / `RecordHistory` and the
existing print & export menu, is translated in `messages/en.json` and
`messages/ar.json`, and works at mobile width and RTL like the rest of the
application. Lists page server-side (existing `list.ts`), never load everything.

### 15.1 S1 — Applications list `/imports`

*The replacement for the sheet's `dashboard` tab.*

| | |
|---|---|
| **Columns (default view)** | Application no · PO / INV no · Supplier · INV date · INV amount (txn) · Qty · **Stage** (chip, with days in stage) · **Stopped?** (red chip: reason code · owner · days) · PD no / status / expiry · Applied / Paid / Remaining · B/L count · **Containers X of Y** · Next action + due · Branch |
| **Filters** | Stage · Stopped (yes/no/needs reason) · Supplier · Bank · Port · PD status · Container status · Date ranges (INV, application, ETA) · Branch · Text search on PO/INV, PD, B/L, container number (one box) |
| **Saved views** | Existing `saved-views` service. Seed views: *All open* · *Stopped — reason required* · *SWIFT waiting* · *Partly received* · *PD expiring* · *Cleared this month* — these replace the "accountant report" sections that were removed from the diagram; they are views, not a report. |
| **Sorting** | Default: stopped-without-reason first, then days stopped desc, then stage. |
| **Row actions** | Open · Stop / follow-up (dialog §15.7) · Print row sheet |
| **Header actions** | New application · Import from sheet (§18, managers) · Export |
| **Permissions** | `import_application:view`, branch-scoped |

### 15.2 S2 — Application page `/imports/[applicationNo]`

*The one record everybody opens.*

**Header band** — the two chip rows of §5.2 exactly as on the diagram; the
Stopped chip is red when `on_hold`; the stage rail (8 steps, current one
highlighted, ✓ on 7 and 8) across the top; days in current stage.

**Stop banner** — when on hold: "STOPPED — {reason code} {reason name} · owner ·
since {date} ({n} days) · next action {text} by {date}" with buttons *Update*,
*Reassign*, *Resolve* (§15.7). When the hold is `PENDING_REASON`: "Over time
limit — reason required" and the *Complete* button.

**Tabs (one per lane, in diagram order) + two more:**

| Tab | Shows | Actions |
|---|---|---|
| **Order & invoice** | PI header and lines; linked AP invoice(s) with status and link; terms text; instalment plan table (§9.2) | Edit PI (before invoice) · Create purchase invoice · Link existing invoice · Set / change terms |
| **Bank & funding** | Accounts used (booked / reserved / available each) · deposits noted · loans linked with allocation and commission share · loan instalments due | Record deposit (opens Other Receipt pre-filled) · Link loan |
| **Payments** | Instalments with status; payment applications table: no · instalment · bank · amount · applied date · **days waiting** · SWIFT date / ref · status · posted document | New payment application · Approve · Send · **Confirm SWIFT** · Reject / Cancel (reason) |
| **PD / ASYCUDA** | PDs (latest first) with status, registration, expiry, days left, bank, port files sent X of Y; status history thread | New PD · Change status (date, source, attachment) · Re-register · Add note |
| **Shipment & containers** | B/Ls, each expanded to its containers: number · size · status chip · ETA · stage dates · warehouse · received X/planned | New B/L (+ paste containers) · Add container · Change status (date) · Change ETA · Port file sent · Mark late / missing (reason) · **Receive** (opens §15.6) |
| **Warehouse & stock** | Container lines (model × container × warehouse) planned / received / damaged / short; in-transit per model; stock per warehouse for the application's models (from `stock_position`); outbound from these layers | Open receipt · Open stock ledger |
| **Landed cost** | Charges table by type with source document; totals; allocation preview per model; lock status | Add charge (from document / other with reason) · Lock · View allocation |
| **Status log** | §6.3 — newest first, lane filter, search; holds as red lines | Add note · Print log |
| **Attachments & history** | Existing attachments component; `RecordHistory` (audit) | Attach |

Footer: created, branch, source (`sheet_import` shows the sheet row id).

### 15.3 S3 — Payment applications `/imports/payment-applications` and `/imports/payment-applications/[no]`

List: no · application · supplier · instalment · bank account · amount ·
applied date · **days waiting** · status · SWIFT date · owner of hold if any.
Default filter: `sent`, sorted by days waiting desc — the "SWIFT waiting" view.

Record: the fields of §9.3 as a `DocumentWindow`; the dashed-arrow checks shown
as a checklist with green/red marks before *Send* ("Validated PD ✓ 9330 ·
Funds ✓ Arab USD available 1,240,000 · Trigger ✓ B/L MEDUWI804404 issued");
*Confirm SWIFT* dialog (date, reference, attachment) that explains what will be
posted ("will post Supplier Payment of USD 805,072.68 allocated to invoice
CSA-AL0001-1, dated 9 Oct 2026"); reject/cancel with reason.

### 15.4 S4 — PDs `/imports/pd` and `/imports/pd/[pdNo]`

List: PD no · application · supplier · bank · registration · expiry ·
**days left** (red ≤ warning days) · status · port files X of Y · notes.
Default view: not terminal, sorted by days left asc — replaces the sheet's `PD`
and `Pending` tabs. Record: §10.1 plus the status thread and the containers
whose port files it covers. Bulk action *Update statuses from ASYCUDA list*
(paste or upload the document list; the system matches by PD no, shows a diff,
writes one status-history row per change with source `asycuda_list` — the
sheet's "Check / MATCH / STATUS CHECK" columns become this diff).

### 15.5 S5 — B/Ls and containers `/imports/shipments` (list of B/Ls) and `/imports/containers` (list of containers)

Containers list is the new **Containers in transit** screen and replaces
`/inventory/in-transit` (the old route redirects). Columns: container no · B/L ·
application · supplier · POD · ETA · status · days since ETA · warehouse ·
planned / received. Default view: not received, sorted by ETA. Bulk status
change for a vessel's containers (pick all with the same B/L → *Arrived at
port on …*).

### 15.6 S6 — Receive container (dialog / page `/imports/containers/[id]/receive`)

Pre-filled lines (model, planned qty, unit); enter received, damaged, short;
warehouse picker limited to the branch's non-transit warehouses; date; note;
attachments (delivery note, photos). Shows the variance before posting and
asks for a reason when it is not zero. On post: §12. One-time `document_id`
(existing form idempotency rule) so a double submit cannot receive twice.

### 15.7 S7 — Stop / follow-up dialog (component, used on S1, S2, S3, S4, S5)

Fields: lane (defaulted from where it was opened) · stuck document (defaulted)
· reason code (picker from the master, grouped by lane hint; `OTHER` requires
detail) · detail · owner (user picker, defaulted from the code's default role)
· started on (defaulted today; may be earlier) · next action · due date. On an
existing hold: *Update* (new thread entry), *Reassign*, *Resolve* (what
happened — required). Everything typed becomes an `application_hold_update`
row and an event. Nothing in the thread can be edited afterwards.

### 15.8 S8 — Banks and loans

* `/master-data/banks` — the `bank` master (code, name, SWIFT, active).
* `/master-data/bank-accounts` (existing) — add bank picker, and the three
  balances Booked / Reserved / Available in account currency and IQD with a
  drill-down list of what is reserved (the payment applications).
* `/imports/loans` and `/imports/loans/[loanNo]` — §9.7: header, generated
  schedule (editable before approval, dated rows after), allocations to
  applications with commission share, repayments (each repayment is a payment
  document posted through the existing journal with the instalment reference),
  attachments. List: loan no · bank · principal · outstanding · next due ·
  overdue flag · status.

### 15.9 S9 — Import settings `/administration/import-settings` (accounting manager)

One screen, tabs:

| Tab | Edits |
|---|---|
| Stages | `application_stage` — name, sequence, active (derivation rules are shown read-only) |
| Time limits | `stage_time_limit` — check, scope (all / bank / port / supplier), limit days, escalation days & role, valid from; a change creates a new dated row |
| Reason codes | `hold_reason_code` |
| Container statuses | `container_status` with flags |
| PD statuses | `pd_status` with flags |
| Ports | `port` |
| Instalment triggers | `instalment_trigger` |
| Landed cost | `landed_cost_type`; default allocation basis |
| Event codes | `application_event_code` — name and summary template only (codes are added by migration when a service starts writing them) |

Every change is an `audit_event`; nothing is deleted, only deactivated.

### 15.10 Existing screens that change

| Screen | Change |
|---|---|
| AP invoice (`/purchasing/ap-invoices/[no]`) | Shows "Import application APP-…" with link; *Create from application* path pre-fills lines; posting writes the event; the `RecordHistory` folds in the application's events for this invoice (`timelineWithAttachments` `related`). |
| Supplier payments | Read-only when created by a payment application (the SWIFT confirmation is the source); link back. |
| Bank/cash accounts | §15.8. |
| Availability / stock ledger | "Incoming (in transit)" column per item from container lines; goods at sea no longer on-hand (§11.4). |
| Dashboard | *Waiting on me* gains "Holds I own" and "Holds needing a reason in my lane". Nothing else. |
| Numbering | Series `APP`, `PAYAPP`, `LOAN`, `CREC` (container receipt) appear. |

---

# Part G — Data preservation, scalability, integration, migration

## 16. Never lose data

### 16.1 Rules enforced in the database, not only in code

| Rule | Mechanism |
|---|---|
| `application_event`, `application_hold_update`, `customs_pd_status_history`, `shipment_container_status_history`, `landed_cost_allocation` are append-only | The `audit_event` trigger (`0001_phase01_platform_core.sql:206`) reused: UPDATE and DELETE raise. |
| No application, payment application, PD, B/L, container, loan or charge is ever deleted | No DELETE grant on these tables for `erp_app`; services expose only cancel-with-reason, which is a status row plus an event. |
| A cancelled or superseded row stays visible | Lists have an "include cancelled" toggle; the record shows "Cancelled on … by … because …". |
| Corrections are new rows | `correction_of` on events; `supersedes_pd_id` on PDs; dated adjustment rows for landed cost; status-history rows for re-dated stages. |
| Documents created by the module in other modules follow their own rules | A supplier payment created at SWIFT confirmation is reversed, never deleted, if wrong (existing `reverse`), and the reversal is an event on the application. |
| Attachments are kept | Existing attachment retention; an attachment can be marked superseded, not removed. |
| Migrations are additive | Per `AGENTS.md`: never rewrite an applied migration; journal timestamps strictly increasing; every new stock-moving kind added to `resetTestData` and `format-live-database.sh`. |
| Imports keep their source | `source` + `source_row` on every migrated row (§18); the original sheet file is attached to a system application `APP-MIGRATION-2026`. |
| Backups | Existing nightly backup and weekly restore drill cover the new tables; the drill's table list is extended by the same migration that creates them. |

### 16.2 Volume and retention

The event table is partitioned by year from the first migration; partitions
are created a year ahead by the nightly job. No row is ever purged; a partition
older than the configured online horizon (seed 7 years) may be moved to slower
storage, never dropped, by a documented operations procedure. Indexes of §6.1
keep the application page at one query per tab.

## 17. Scalable, not fixed

| Concern | How it stays open |
|---|---|
| Number of B/Ls, containers, instalments, PDs, payment applications, loans, charges per application | Unbounded child rows; nothing is a column on the parent. The sheet's "4 B/Ls in one cell" and "Warehouse 3 … Warehouse 9" columns are the anti-pattern this replaces. |
| Banks, ports, warehouses, statuses, reason codes, stages, triggers, charge types | Master tables with `active`, edited in settings, effective immediately, logged. |
| Time limits | Rows with scope and validity, not constants; per bank / port / supplier. |
| New checks for the sweep | A new named query + a settings row; no schema change. |
| New event kinds | A new master row; the log table does not change. |
| Currencies | Every money field is stored in transaction currency **and** IQD with the rate used; nothing assumes USD. |
| Branches | RLS as today; applications, receipts and holds are branch-scoped. |
| Users and roles | Permissions are objects × verbs as today; new roles are configuration. |
| Interfaces | The sheet import (§18) is built as an *import definition* of the existing import framework (`import-definitions.ts`), so a future supplier portal, ASYCUDA list or bank file is another definition, not another module. Every list has CSV export. |
| Performance | Lists are server-paged and indexed on the filter columns; derived totals are SQL aggregates with covering indexes; the application header reads one row + four aggregate queries. Target: list < 1 s at 10,000 applications and 200,000 events; application page < 1.5 s. Load test added to `tests/load`. |

## 18. Migration of the current sheet (`QS_DASHBOARD.xlsx`)

A one-time, re-runnable import (dry-run first, with a report), built as an
import definition. Mapping:

| Sheet | Target | Rules |
|---|---|---|
| `dashboard` (58 rows) | `import_application` + `application_order_line` (one summary line when no detail) | Key = `PO no./INV.` normalised; supplier matched by normalised name (trim, collapse spaces, strip U+2002); unmatched suppliers listed, never auto-created. Amount, qty, terms text, products. `Clear?` kept as `legacy_cleared` for the §14.1 comparison. |
| `PMT` (80 rows) | `payment_application` | Bank → `bank_cash_account` by bank code (mapping table in the dry-run report); application date; SWIFT date → status `swift_confirmed` if present else `sent`; rows with neither date → `draft`. The 11 rows "not paid but PD totally written off" are flagged `verify_swift_date` in the report. |
| `PD` (88 rows) + `Pending` | `customs_pd` + status history | Match to application by normalised key; 31 unmatched PDs are imported with `application_id` null into a holding list for the customs officer to link; notes become `notes` + events. |
| `BL` (46) + hidden `CTN No.` (43) | `bill_of_lading` + `shipment_container` | Container numbers split on newline, validated; status mapped `Inbounded → received`, `On the sea → on_sea`, `On port → at_port`; ETA, B/L date, POD. **Received quantity is not copied from the B/L row** (it was the invoice qty); it comes from `BL Product Detail` where present, else the B/L total qty is spread over its containers equally and flagged `estimated` for the warehouse to confirm. |
| `BL Product Detail` (5) | `shipment_container_line` | As is. |
| `Inventory Detail`, `Outbound Detail`, `Warehouse Master` | Not imported — stock already lives in the ERP ledger; the warehouse master is reconciled by name in the report. |
| `Pending Order` (13 lines) | `application_order_line` of the matching application | The pre-sale columns are ignored (the company does not run pre-sales). |

Data quality fixes applied on the way in, each listed in the report with the
original value: trimmed keys and names; duplicate PDs per invoice kept as
separate PD rows ordered by registration date; the dashboard's "latest PD only"
becomes all PDs.

### 18.4 Existing `supplier_shipment` rows

Each row becomes one application (if the invoice has no sheet match) or links
to the matched one, with one B/L `MIGRATED-<invoice no>` and one container
`MIGRATED-<invoice no>` carrying the invoice's lines, at the status mapped from
the four stages; stock stays where the ledger says it is. Source
`shipment_migration`.

---

# Part H — Delivery, acceptance, scope, questions

## 19. Delivery stages (each its own branch, in this order)

| Stage | Delivers | Depends on |
|---|---|---|
| **1 — Application core** | §5, §6, §13 (holds, reason codes, time limits, sweep), §15.1, §15.2 (header, Order tab, Status log, Attachments), §15.7, §15.9, numbering, permissions, menu | — |
| **2 — Payments & bank** | §9.1–§9.6, §15.3, bank master, reserved/available, SWIFT confirmation posting through existing services, §15.8 (accounts part) | 1 |
| **3 — PD / ASYCUDA** | §10, §15.4, ASYCUDA list diff | 1 |
| **4 — Shipment & warehouse** | §11, §12, §15.5, §15.6, staging warehouses → transit, availability "incoming", retirement of the 4-stage shipment, §18.4 | 1 (and 2 for "against B/L" triggers) |
| **5 — Loans** | §9.7, §15.8 (loans), loan liability control kind, allocations and commission share | 2 |
| **6 — Landed cost** | §14.2 | 4, 5 |
| **7 — Migration & go-live** | §18 import definition, dry-run report, accountant sign-off of the §14.1 comparison, cut-over runbook, training sheet for each lane's team | all |

Stage 1 alone already gives the company what the sheet cannot: one record,
every update logged, and "where is it stopped and why" with an owner.

## 20. Acceptance criteria

Each names its test file under `tests/integration/` (none exists yet; a link
is added when the test does).

| # | Criterion | Test |
|---|---|---|
| A1 | Creating an application allocates `APP-…`, writes `APPLICATION_OPENED`, and a second application with the same supplier + normalised reference is refused. | `imp01-application-core` |
| A2 | Every service that writes to a table carrying `application_id` writes at least one `application_event` in the same transaction; a service that does not fails the coverage test. | `imp01-event-coverage` |
| A3 | UPDATE or DELETE on `application_event`, `application_hold_update`, the two status-history tables raises; DELETE on any application table is refused for `erp_app`. | `imp01-append-only` |
| A4 | The stage is derived correctly for each of the eight seeded conditions, including a deposit-paid-then-shipped application (stage 5 while payment lane shows balance pending). | `imp01-stage-derivation` |
| A5 | The sweep, run twice on the same day, opens exactly one `PENDING_REASON` hold for a payment application over its bank's limit; completing it requires reason, owner, next action; the thread is append-only. | `imp01-holds-sweep` |
| A6 | Changing a time limit in settings takes effect on the next sweep without deployment; the old limit row stays with its validity. | `imp01-settings-live` |
| A7 | Sending a payment application without a validated PD is refused with a message naming the PD; a manager override is logged as an event with reason. | `imp02-payment-checks` |
| A8 | Approving a payment application reduces the account's Available by its amount; rejection releases it; SWIFT confirmation posts a supplier payment (or advance before invoice) dated the SWIFT date, allocates it, and the invoice's `settled_amount_iqd` changes only then. | `imp02-reserve-and-swift` |
| A9 | Applied / Paid / Remaining match the sheet's figures for the 58 migrated applications after import (USD 35,309,347.81 invoiced; USD 15,617,285.40 paid; USD 23,872,694.40 applied). | `imp07-migration-totals` |
| A10 | A PD moved to `expired_validated` requires a hold with reason `PD` and allows re-registration; the old PD row is unchanged and linked. | `imp03-pd-lifecycle` |
| A11 | An application with 4 B/Ls and 10 containers (the CSA-AL0001-1 case) shows "X of 10 received" as containers are received one at a time, moves to stage 6 at the first receipt and to 7 at the tenth, and its received quantity is Σ container lines, not 4 × invoice qty. | `imp04-containers-partial` |
| A12 | Receiving a container writes `inventory_movement` + `cost_layer` in one transaction with the warehouse's branch; a repeated submit with the same `document_id` returns the existing receipt; a variance sets `missing_damaged` and opens a hold. | `imp04-container-receipt` |
| A13 | Goods on containers not yet received are not in `stock_position` on-hand and appear as "incoming"; staging warehouses are type `transit`. | `imp04-in-transit-availability` |
| A14 | A loan of 1,000,000 at 2 % deducted at disbursement credits 980,000 to the account, books 1,000,000 liability and 20,000 commission; a 4-instalment quarterly schedule is generated with the last absorbing rounding; funding two applications 600,000 / 400,000 allocates commission 12,000 / 8,000. | `imp05-loan` |
| A15 | Locking landed cost allocates charges by value across received lines, restates the FIFO layers by a value-only movement in the same transaction, and `inventory-integrity` reports no drift. | `imp06-landed-cost` |
| A16 | Cleared is set automatically when the third condition is met, never by a user; reversing the invoice afterwards re-opens with a `CORRECTION` event and `cleared_at` preserved in history. | `imp01-cleared-rule` |
| A17 | The dry-run import of `QS_DASHBOARD.xlsx` produces the report of §18 (unmatched suppliers, unmatched PDs, verify-SWIFT rows, legacy-cleared differences) and changes nothing; the real run is idempotent. | `imp07-sheet-import` |
| A18 | Application list at 10,000 applications / 200,000 events responds under 1 s; application page under 1.5 s. | `tests/load/imports.js` |
| A19 | Every new route is in `OPERATIONS` and `DELIVERED`, translated in `en` and `ar`, passes the theme-readability e2e at mobile RTL width. | `tests/e2e/imports.spec.ts` |

## 21. Out of scope (this release)

* An automatic alerts dashboard (the saved views of §15.1 cover the need; a
  dashboard can be added later on top of the same queries).
* The accountant's report as a document (removed from the diagram; the views
  and the printable status log replace it).
* Pre-sale / pre-sold quantities (the company does not run them).
* Letters of credit, Sinosure claims handling (the `sinosure_credit` trigger
  only sets the expected date).
* Direct bank or ASYCUDA integrations (both arrive as import definitions
  later; §17 keeps the door open).
* Changes to the existing GL, AP, AR or inventory posting rules beyond the
  mappings named in §9.7 and §14.2.

## 22. Open questions (answers needed before stage 1 is approved)

1. **Roles.** Create `logistics_officer` and `customs_officer`, or keep both
   under `accounting_officer`?
2. **Who completes an automatic hold?** Proposal: the reason code's default
   role for that lane (payment → accountant, shipment → logistics, PD →
   customs). Confirm.
3. **USD from an IQD account.** Today refused. Allow with the accounting rate
   of the SWIFT date and an FX difference posting, or keep refusing and require
   a USD account? (Affects §9.3.)
4. **Time-limit seeds.** The example values (14 / 7 / 45 / 30 / 10 / 7 days)
   are placeholders; the accounting manager sets the real ones on day one.
5. **Loan commission treatment.** Expense when paid, or capitalised into
   landed cost of the goods it funded (as drawn on the diagram)? The model
   supports both; the posting mapping needs one default.
6. **Quantity variance.** Who may accept a short delivery as final (so the
   application can clear) — purchasing manager, accounting manager, or both?

---

## Review checklist

- [ ] Every box of `QS_ERP_Workflow_Final.pdf` appears in §8–§14 with a stored state or a derived value.
- [ ] Every dashed arrow of the diagram is a named check in §7–§9 with its override rule.
- [ ] The three *Cleared* conditions are exactly those of the diagram's band.
- [ ] No day number in this document is stated as a rule — all are seeds (R4).
- [ ] No table under the application can be updated-in-place or deleted where the diagram says "recorded" (R3).
- [ ] Every screen in §15 names its route, columns, actions and permission object.
- [ ] Every acceptance criterion names a test file.
- [ ] `AGENTS.md` rules are honoured: additive migrations, ledger tables in both reset lists, form idempotency, warehouse-branch rule.
