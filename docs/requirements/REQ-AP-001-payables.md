# REQ-AP-001 — Payables (Accounts Payable module, including the Import Application)

Everything the company owes, in one module. The *Purchasing* section becomes
**Payables**: one record per thing we have to pay — an import of panels, the
office rent, a forwarder's bill, a customs broker's fee, a consultant's month,
a utility invoice — and every one of them follows the same spine: requested →
received or confirmed → invoiced → approved → payment applied → paid → closed,
with the same status log, the same holds ("where is it stopped and why?") and
the same payment process through the banks. The **import application** is one
payable type with four extra lanes (PD / ASYCUDA, shipment per container,
warehouse, landed cost); the others are simpler, not different.

This document supersedes `REQ-APP-001` (the import application alone). The
import part is carried over unchanged in substance (Parts D–F) and is still the
written form of **`QS_ERP_Workflow_Final.pdf`** (copy at
`docs/requirements/REQ-AP-001-workflow.pdf`). Where this document and the
diagram disagree about the import, the diagram is the intent.

| | |
|---|---|
| **Requirement ID** | `REQ-AP-001` (supersedes `REQ-APP-001`) |
| **Release** | 2 |
| **Phase** | Operations build — Payables module, delivered in the eight stages of §25 |
| **Source** | `QS_ERP_Workflow_Final.pdf` · `QS_DASHBOARD.xlsx` · the code review of 2026-10-01 (§3) · the instruction of 2026-10-01 that Purchasing becomes Payables and covers service fees such as office rent |
| **Test case(s)** | §26 names the test file for every acceptance criterion; none exists yet |
| **Status** | Approved for the Stage 1 build (decisions recorded in §28) |
| **Approved by** | Baban Ali, 2026-10-01 (chat approval; §28.1 of the blueprint requires the Business Process Owner's written sign-off to be attached) |

---

## 0. How to read this document

* **Part A** (§1–§4) — objective, actors, what exists today, the five rules.
* **Part B** (§5–§7) — the payable record, its stages per type, the status log.
* **Part C** (§8–§12) — the payable types: import, service & expense, recurring
  contract (rent), local goods, advances and credit memos.
* **Part D** (§13–§18) — the import lanes, box by box, as drawn.
* **Part E** (§19) — holds: "Where is it stopped — and why?"
* **Part F** (§20) — closing a payable; landed cost.
* **Part G** (§21) — every screen, one by one.
* **Part H** (§22–§24) — never lose data, scalable, integration and migration.
* **Part I** (§25–§28) — delivery stages, acceptance criteria, out of scope, decisions.

Words used throughout:

| Word | Meaning here |
|---|---|
| **Payable** | One thing the company has to pay, from the moment it is known until it is paid and closed. Keyed by the supplier's reference (PO / INV / contract no.). Everything in this document hangs off it. |
| **Type** | What kind of payable: *Import*, *Service & expense*, *Recurring contract*, *Local goods*, *Advance*. Types are master data; each type says which lanes and stages apply. |
| **Import application** | A payable of type Import. The name the company uses, kept in the UI. |
| **Lane** | A track of the diagram: order & invoice, bank & finance, payment, PD, shipment, warehouse — plus *service* (confirmation of a service) and *contract* (recurring schedule). |
| **Stage** | The numbered position of a payable on its type's stage rail. Derived, never typed. |
| **Event** | One row in the status log. Append-only. |
| **Hold** | A recorded stop: where, why (reason code), who owns it, since when, next action. |
| **Time limit** | Days a stage may take before a hold is required. **Configured per type, per bank or payment method — never hard-coded.** |

---

# Part A — Objective, actors, today, rules

## 1. Business objective

The company imports solar panels, batteries and inverters into Iraq through
Aqaba and Umm Qasr, paid by SWIFT through Iraqi banks against ASYCUDA
pre-declarations, and it also pays — every month — office rent, utilities,
forwarders, customs brokers, consultants, bank charges and the like. Today the
imports live in a Google Sheet (`QS_DASHBOARD.xlsx`) and the rest lives in
e-mails and memory. The review of the sheet on 2026-10-01 found, among 58 live
invoices worth USD 35.3M: 25 payment applications not paid (USD 8.14M), 17 of
them waiting 19–112 days with **no recorded reason**; 177 containers in 46
B/Ls with **no status per container**; received quantities copied from the
invoice onto every B/L; and 11 "not paid" rows whose PD was already written off
(paid, but never recorded). Nothing in the sheet says *why* anything is late,
and the sheet cannot say that the office rent for October has not been paid
because the rent is not in it at all.

A real ERP keeps all of this in one Accounts Payable module. That is what this
requirement specifies:

1. **One record per payable**, of every kind — import, service, rent, local
   purchase — that every department updates and everyone reads.
2. **One payment process** for all of them: funds checked, application sent to
   the bank (SWIFT, local transfer, cash or cheque), confirmation recorded,
   money matched on the statement.
3. **A status log that records everything**, never overwritten.
4. **An answer, always, to "where is it stopped and why?"** — with an owner
   and a next action — for a late SWIFT and for an unpaid rent alike.
5. **Never lose data.** Nothing is deleted; corrections are new rows.
6. **Scalable, not fixed.** Any number of B/Ls, containers, instalments,
   contracts, banks and warehouses; every list is master data; adding a new
   kind of fee is a settings row, not a change to the system.

Process owner: Business Process Owner (Issa Mohammed), per §28 of the blueprint.

## 2. Actors and permissions

Existing roles are reused; two roles are added (§28 D1). The module introduces
one permission object per new document.

| Object | view | create / edit | approve / confirm | hold / resolve | notes |
|---|---|---|---|---|---|
| `payable` (any type) | all operations roles (branch-scoped) | purchasing (import, local goods); the **benefiting department's** user (service, recurring); accounting_officer (all) | accounting_manager | anyone who may edit the lane | the import type's extra lanes have their own objects below |
| `payment_application` | accounting roles | accounting_officer | accounting_manager approves; accounting_officer confirms SWIFT / transfer; cashier confirms cash | accounting_officer | §15.3 |
| `service_receipt` (existing) | department + accounting | the benefiting department | department manager | same | "did we actually get it?" |
| `recurring_contract` | accounting + the owning department | accounting_officer / admin | accounting_manager | — | rent, leases, subscriptions |
| `customs_pd` | all operations roles | customs_officer | — | same | import only |
| `bill_of_lading`, `shipment_container` | all operations roles | logistics_officer / purchasing | — | same | import only |
| `container_receipt` | warehouse, accounting | warehouse user of that branch | — | warehouse | import only |
| `bank` (master), `bank_loan` | accounting roles | accounting_manager | ceo above `approval_limit_iqd` | — | |
| `payables_settings` | accounting_manager | accounting_manager | — | — | stages, limits, codes, types |
| `payable_event` | whoever may view the payable | *nobody — system only* | — | — | |

Branch rule: a payable belongs to the branch of its order / contract; stock
from an import lands only in that branch's warehouses (existing rule).

## 3. What the system has today (code review, 2026-10-01)

| Area | Exists | Does not exist |
|---|---|---|
| **Purchasing menu** | Section `purchasing` (ordinal 4) with 16 items, of which these read real data: Suppliers, Purchase Invoices, Open Items (`/purchasing/payables`), Supplier Payments, Goods Returns, Supplier Statements. A second section `finance_ap` repeats advances, payments, ledger, ageing, allocations, reconciliation. | One module. A record that spans a payable's documents. |
| **Goods flow** | PO (schema+service, no screen) → goods receipt (schema+service, no screen; PO required; tolerance; partial) → AP invoice (live; 3-way match; `match_status`) → payment. | Per-container receipt; the import lanes (§3 of REQ-APP-001, carried into Part D). |
| **Service / expense flow** | PO → **service receipt** (schema+service, owned by the benefiting department, posts nothing, `awaitingDepartment` inbox) → AP invoice with `is_inventory=false` lines posting to an expense account → payment. **Non-PO invoices** need justification + approval (`non_po_justification`, `non_po_approved_by`). | A screen for service receipts. A contract that generates the monthly rent. Linking a forwarder's or broker's invoice line to the import it belongs to (landed cost). |
| **Payments** | Supplier payment, advance (PO required), payment proposal/batch (full outstanding only), allocations, payment methods (bank / cash / transfer, fee %), partner bank accounts with verification. | A payment application with sent / confirmed states for any method; reservation of funds; SWIFT date/ref; days waiting; instalment-level terms. |
| **Bank & treasury** | Bank/cash accounts (one G/L account each), booked and committed balances, statements, reconciliation, bank execution batches. | Bank master; reserved per payment; loans and commission. |
| **Status & stops** | `audit_event` append-only; `workflow_decision`; department routing; approvals inbox; notifications with escalation fields; daily `due-notices` sweep for due/overdue invoices. | A cross-document log; holds with reason / owner / next action; configurable time limits. |
| **Import specifics** | `supplier_shipment` (1 invoice, 4 fixed stages, staging warehouses typed `main`). | PD, B/L, containers, landed cost — see Part D. |

### 3.1 Reconciliation with `main` (82ad32b, after PR #3 "de-phase")

Verified on 2026-10-01 and already reflected below: screens are served only
when listed in `domain/screens.ts` `DELIVERED` (there is no `phase-gate.ts`);
the menu is `domain/menu.ts`; `goods_receipt.purchase_order_id` and
`supplier_advance.purchase_order_id` are NOT NULL by design and **stay so** —
every import and local-goods payable has a purchase order (§5.1); supplier
payment and advance store IQD only, so transaction-currency amounts live on
the payment application and are added to both documents as additive columns;
`payable_event` is a hand-authored partitioned migration; Stage 5 re-types
every shipment-stage warehouse to `transit`, including the three created live
on 2026-09-30.

## 4. The five rules

**R1 — One key.** The payable is the parent of every document that belongs to
it. A document that belongs to a payable carries `payable_id`. The supplier's
reference (PO / INV / contract number) is stored verbatim and normalised
(upper case, letters and digits only) and is unique per supplier and type.

**R2 — Lanes are independent.** Payment status never implies delivery status;
confirmation of a service never implies the invoice is approved. Each lane
keeps its own state and dates; the *stage* is derived.

**R3 — Append, never overwrite.** The status log, holds, status histories are
append-only tables protected by the `audit_event` trigger. Corrections are new
rows. Nothing under a payable is deleted; the only end states are *closed* and
*cancelled (with reason)*.

**R4 — Configured, not coded.** Payable types, lanes per type, stages per type,
time limits, reason codes, payment methods, banks, ports, statuses, charge
types and expense categories are master data with an `active` flag, edited on
a settings screen, effective immediately, logged. Day numbers in this document
are **seeds**, never rules.

**R5 — Nothing is lost on the way in.** The sheet, the current shipments and
the posted invoices and payments are migrated with their source recorded.

---

# Part B — The payable

## 5. The payable record

### 5.1 `payable`

| Field | Type | Rule |
|---|---|---|
| `id` | uuid | |
| `payable_type_code` | fk `payable_type` | Master (§5.3). Seed: `import`, `service`, `recurring`, `local_goods`, `advance`. |
| `payable_no` | text, unique | Number series **per type**, maintained on the Numbering screen: seed prefixes `IMP`, `SVC`, `RNT`, `PUR`, `ADV` (e.g. `IMP-HQ-2026-000123`). |
| `supplier_reference` | text | The supplier's PO / INV / contract number, verbatim. |
| `supplier_reference_key` | text | Normalised `[A-Z0-9]`. **Unique per supplier and type.** |
| `supplier_id` | fk `business_partner` | Required. Suppliers and vendors are one master (existing); the partner's verified bank accounts are what a payment application may pay to. |
| `branch_code`, `department_code` | fk | Branch required. **Department required for `service` and `recurring`** (the benefiting department that confirms the service). |
| `currency` | char(3) | Transaction currency. |
| `amount_txn`, `amount_iqd` | numeric | Agreed / invoiced amount (sum of linked invoices once posted; before that the PI / contract / quote). IQD at the accounting rate on the document date. |
| `quantity` | numeric, nullable | Goods types only; the *Cleared* rule uses it. |
| `date` | date | PI / invoice / contract date. |
| `description` | text | "Office rent October 2026", "panel & batteries". |
| `payment_terms_text` | text | Verbatim; the structured plan is §15.2. |
| `purchase_order_id` | fk, nullable | **Required for `import` and `local_goods`** (created from the PI lines through the existing PO service, or linked); optional for `service` (a service PO when one exists); null for `recurring` and `advance`. |
| `recurring_contract_id` | fk, nullable | Set when a `recurring` payable was generated by a contract (§10). |
| `expense_category_code` | fk, nullable | For `service` / `recurring`: rent, utilities, freight & forwarding, customs brokerage, professional fees, bank charges, repairs, subscriptions, other — master, extensible; carries the default expense account. |
| `charged_to_payable_id` | fk, nullable | A service payable whose cost belongs to an import (forwarder, broker, port) points at that import; its lines become landed-cost charges (§20.2). |
| `stage_code` | fk `payable_stage` | Derived (§6). Stored for listing; recomputed in the transaction of every event. |
| `stage_since` | timestamptz | |
| `on_hold` | boolean | Derived: an open hold exists (§19). |
| `closed_at`, `cancelled_at`, `cancel_reason` | nullable | End states. For the import type `closed_at` is *Cleared* (§20.1). |
| `source` | text | `erp` · `sheet_import` · `shipment_migration` · `contract`. |
| `created_by/at`, `updated_at` | | |

`payable_order_line` (PI / quote / contract lines: item or expense category,
description, quantity, unit, unit price) is kept for every type so the amount
is known before an invoice exists. One payable may link **many** AP invoices
(`ap_invoice.payable_id`, nullable fk added by this requirement — a rent paid
in two invoices, an import invoiced "-A / -B"); one invoice belongs to at most
one payable.

### 5.2 What every payable shows (the chip rows)

The list and the header show, for every payable, the type's chips. All types
share: reference · supplier · amount · terms · bank + funding · **Applied /
Paid / Remaining** · stage + days · **Stopped? reason · owner · since · next
action**. The import type adds the diagram's chips (PD no + expiry, PD status,
B/L no, Containers X of Y, POD + ETA, Inbounded qty, Warehouse). The service
and recurring types add: department · confirmed? (service receipt) · period
(for rent: "October 2026") · due date · expense category · charged to (import,
if any).

### 5.3 `payable_type` (master)

| Field | Rule |
|---|---|
| `code`, `name`, `active` | |
| `lanes` | Which lanes apply: import → order, bank, payment, pd, shipment, warehouse, cost; service → order, service, bank, payment; recurring → contract, service, bank, payment; local_goods → order, warehouse, bank, payment; advance → bank, payment. Lanes are rows of `payable_lane`; the pairing is a table, so a new type is configuration. |
| `requires_po`, `requires_department`, `requires_receipt` | The three controls: no goods without an order; no service without a benefiting department; no invoice approval without a receipt (goods receipt or service receipt) unless the type says otherwise (recurring rent: the contract is the receipt evidence, see §10). |
| `number_series_key` | |
| `stage_set` | §6. |

## 6. Stages per type

Stages are rows of `payable_stage` (type, sequence, code, name, derivation
rule name, `active`). The rule names are implemented once each; a type's rail
is a list of them, so a rail is configuration. Seed rails:

**Import** (the diagram's eight; unchanged from REQ-APP-001):
1 Order confirmed · 2 Invoiced + funded · 3 PD registered · 4 Payment in
progress · 5 Shipped · 6 Partly received · 7 All received ✓ · 8 Cleared ✓ —
derivation exactly as §6 of REQ-APP-001 (carried in §20.1 and Part D).

**Service & expense**:
1 **Requested** — payable exists (quote / PO / request recorded) · 2 **Received /
confirmed** — a service receipt is approved by the benefiting department ·
3 **Invoiced** — AP invoice posted · 4 **Approved for payment** — invoice
approved (non-PO justification approved where required) · 5 **Payment in
progress** — payment application `sent` · 6 **Paid** — remaining = 0 ·
7 **Closed** ✓ — paid and matched on the bank statement (or cash receipt
signed).

**Recurring contract instance** (one payable per period): 1 **Due** — generated
from the contract with its period and due date · 2 **Confirmed** — the
department confirms the period (automatic when the contract says
`auto_confirm`, e.g. rent) · 3 Invoiced (if the landlord invoices; else the
contract line is the invoice evidence) · 4 Approved · 5 Payment in progress ·
6 Paid · 7 Closed ✓.

**Local goods**: 1 Ordered · 2 Received (goods receipt) · 3 Invoiced · 4
Approved (3-way match) · 5 Payment in progress · 6 Paid · 7 Closed ✓.

**Advance**: 1 Requested · 2 Approved · 3 Payment in progress · 4 Paid ·
5 Settled (applied to invoices) ✓.

Derivation: the highest-numbered stage whose rule holds, recomputed inside the
transaction of any event that can change it; the change is an event
(`STAGE_CHANGED`). R2 still holds — for a service, *Payment in progress* can be
true while *Received / confirmed* is not (an advance to a consultant); the
stage reads 5 and the service lane shows "not yet confirmed".

## 7. The payable status log — "records everything"

### 7.1 `payable_event` (append-only)

Exactly the table of §6.1 of REQ-APP-001, renamed: one row per update from
every lane, written in the same transaction as the change; `occurred_at`
(business) and `recorded_at` (server); `lane_code`; `event_code` (master);
stored `summary`; `source_type/id/no`; `before`/`after` jsonb; actor;
`hold_id`; `attachment_id`; `correction_of`. Partitioned by year of
`recorded_at` by a hand-authored migration; the `audit_event` trigger rejects
UPDATE and DELETE. Indexes `(payable_id, recorded_at desc)`,
`(event_code, recorded_at)`, `(source_type, source_id)`.

### 7.2 Event catalogue (seed)

`payable_event_code` master (code, lane, name, summary template, active). Seed
= the catalogue of §6.2 of REQ-APP-001 with `APPLICATION_OPENED` renamed
`PAYABLE_OPENED`, plus:

| Lane | Code | Written when |
|---|---|---|
| service | `SERVICE_RECEIPT_CREATED` · `SERVICE_CONFIRMED` (by whom, period) · `SERVICE_DISPUTED` · `SERVICE_RECEIPT_REVERSED` | §9 |
| contract | `CONTRACT_LINKED` · `PERIOD_GENERATED` · `PERIOD_AUTO_CONFIRMED` · `CONTRACT_AMENDED` (rent change, escalation) · `CONTRACT_ENDED` | §10 |
| order | `INVOICE_APPROVED` · `NON_PO_JUSTIFIED` · `MATCH_EXCEPTION` · `CREDIT_MEMO_APPLIED` | §9, §11, §12 |
| payment | `PAYMENT_METHOD_SET` · `CASH_PAID` · `TRANSFER_CONFIRMED` (local) | §15 |
| cost | `CHARGED_TO_IMPORT` (a service line charged to an import payable) | §20.2 |

Rule: a service that changes anything under a payable must write at least one
event or its transaction is rejected — enforced by test `ap01-event-coverage`.

### 7.3 Display

Newest first on the payable page, oldest first when printed; one line per
event: date · lane chip · summary · who. Holds in red. Filter by lane, search.
No edit.

---

# Part C — Payable types

## 8. Import (the import application)

**How it starts (decision D13).** The CEO agrees the purchase with the
supplier (usually on WeChat) and receives the supplier's PDF — the PI /
invoice with models, quantities, prices and payment terms. He sends it to the
accountant. The accountant enters it as a **purchase invoice** on the
existing Purchase Invoices screen (supplier, invoice number, lines, terms,
the PDF attached) and ticks *Import* (pre-ticked for a supplier flagged
foreign / import). **That purchase invoice is the import application**: the
system creates the application behind it in the same transaction, keyed by
the invoice number (the same key the sheet used, "PO no./INV."), with the
invoice lines as its lines and the invoice's instalment plan as its terms,
and the purchase order the ERP's own controls need (receipts, advances) is
created silently from the lines. Nobody fills a second form and nobody types
anything twice. An import invoice does not put goods into stock when posted —
stock arrives container by container (§18); until then its stock lines post
to goods-in-transit.

The invoice page gets an **Import tracking** button that opens the
application page (§21.3); the *Import applications* list shows the same
records. A payable of type `import` is the application of the workflow diagram. Its
order lane, bank lane, payment lane, PD lane, shipment lane and warehouse lane
are specified in Part D, holds in Part E, cleared and landed cost in Part F —
all carried over from REQ-APP-001 with the new names (`payable`,
`payable_id`, series `IMP`). Its stage rail is the diagram's eight stages. It
is the only type with `quantity`, containers and a PD; it is otherwise a
payable like any other: the same list, the same page layout, the same payment
application, the same holds.

## 9. Service & expense payables (rent, utilities, forwarders, brokers, fees)

The flow the blueprint already names (§8.2 "service or expense purchase") made
visible and tracked.

### 9.1 What they are

Anything the company pays that is not goods into stock: office rent (through
§10 when recurring), electricity and internet, freight forwarding and port
handling, customs brokerage, consultancy, repairs, software subscriptions,
bank charges, government fees. `expense_category` master (code, name, default
expense account, `requires_po` default, `requires_receipt` default, `active`).

### 9.2 The flow (lanes: order · service · bank · payment)

| Step | Specification |
|---|---|
| **Requested** | The benefiting department (or accounting on its behalf) opens the payable: supplier, category, description, amount or quote, currency, expected date, optional service PO (existing PO service with non-inventory lines), attachments (quote, contract). Event `PAYABLE_OPENED`. |
| **Received / confirmed** | The existing **service receipt** gets its screen (§21.5): the department confirms what was delivered (period, quantity or "done"), with evidence. Approval by the department manager. Event `SERVICE_CONFIRMED`. A disputed service is `SERVICE_DISPUTED` + a hold with reason `SUP` or `OTHER`. `payable_type.requires_receipt` may be switched off per category (bank charges, government fees) — then the invoice itself is the evidence and the approver sees "no receipt required: <category>". |
| **Invoiced** | AP invoice (existing) linked to the payable, lines `is_inventory=false` to the category's expense account (overridable per line), dimensions (department, cost centre, project) as today. Non-PO invoices keep the existing justification + approval control. A forwarder's or broker's invoice whose lines belong to an import carries `charged_to_payable_id` on each line: the line becomes a landed-cost charge of the import (§20.2) and the expense is parked in the landed-cost clearing account instead of P&L. Event `INVOICE_POSTED`, `CHARGED_TO_IMPORT`. |
| **Approved for payment** | Invoice approval (existing status machine): requires the receipt when the type says so; match exceptions (quantity/price vs PO) surface as holds with reason `AMT`. Event `INVOICE_APPROVED`. |
| **Payment in progress → Paid → Closed** | Shared payment lane, §15: the payment application names the method — SWIFT for a foreign supplier, local bank transfer, cash (petty cash / cashier) or cheque — and the bank or cash account; funds are reserved; confirmation records the SWIFT/transfer reference or the signed cash voucher; the supplier payment posts and allocates; the statement match closes it. Time limits are per method and bank (§19.3: `transfer_pending` seed 3 days, `swift_pending` seed 14). |

### 9.3 What a service payable shows

Chips: reference · supplier · category · department · amount · confirmed?
(date, by) · invoice no · approved? · method · applied / paid / remaining ·
due date · stage + days · stopped? reason · owner · next action · charged to
(import no, if any).

## 10. Recurring contracts (rent, leases, subscriptions)

### 10.1 `recurring_contract`

| Field | Rule |
|---|---|
| `contract_no` | Series `CTR`. |
| `supplier_id`, `department_code`, `branch_code`, `expense_category_code` | Landlord / provider; the department that occupies / uses. |
| `description` | "Erbil office lease, 3rd floor". |
| `currency`, `amount_per_period_txn` | |
| `frequency` | `monthly` · `quarterly` · `yearly` · `custom` (master). |
| `start_date`, `end_date`, `notice_days` | End may be open. |
| `due_rule` | e.g. `day_of_period:1` (due on the 1st), `days_before_period_start:15`, `days_after_invoice:30` — master of rules. |
| `generate_days_ahead` | How early the period's payable is created (seed 30). |
| `auto_confirm` | True for rent (the lease is the receipt evidence); false for metered utilities (the department confirms the bill). |
| `invoice_expected` | Whether the provider sends an invoice each period (utilities yes, many landlords no — then the contract line is the evidence and the payable's amount is the contract amount). |
| `escalation` | Optional: `+pct` or `+amount` every `n` periods, or a dated amendment table. Amendments are rows (`recurring_contract_amendment`), never edits. |
| `deposit_txn`, `deposit_payable_id` | A security deposit is an `advance` payable linked here. |
| `status` | `draft` → `active` → `ended`; `cancelled`. |
| attachments | The lease / contract. |

### 10.2 Generation

The daily sweep (the same one as §19.3) creates, `generate_days_ahead` before
each period, one payable of type `recurring` with `period_start`,
`period_end`, `due_date`, amount from the contract (after escalation),
description "<contract description> — <period>", linked to the contract.
Idempotent: one payable per contract per period, ever. Events
`PERIOD_GENERATED` on the new payable and `CONTRACT_LINKED`. If `auto_confirm`,
the payable moves to stage 2 at once (`PERIOD_AUTO_CONFIRMED`). From there it
is a service payable: invoice (if expected) → approval → payment application →
paid → closed. **An unpaid rent past its due date gets an automatic hold**
(check `recurring_overdue`, seed 0 days = the day after due) that needs a
reason — exactly like a late SWIFT.

### 10.3 What the contract page shows

Header; the schedule of periods (generated / confirmed / invoiced / paid /
overdue, with amounts and dates); amendments; deposit; attachments; the status
log of the contract itself (`CONTRACT_AMENDED`, `CONTRACT_ENDED`). Ending a
contract stops generation after `end_date`; periods already generated stay.

## 11. Local goods purchase

Goods bought locally into stock: PO (existing) → goods receipt (existing
schema and service, given its screen §21.6) → AP invoice (3-way match,
existing) → payment lane. The payable is created from the PO ("Create payable"
on the PO, or automatically when a PO of a supplier flagged *track as payable*
is approved — setting, seed on). Stage rail per §6. No PD, no containers; the
goods receipt is per PO as today, and the receipt's lines write the inventory
ledger exactly as now.

## 12. Advances and credit memos

* An **advance** payable is a prepayment that is not yet against an invoice:
  a supplier deposit before the PI (import), a security deposit (rent), a
  retainer. It is a `supplier_advance` (existing, PO required for purchases;
  for a rent deposit it is linked to the contract and the PO requirement is
  satisfied by `payable_type.requires_po = false` for `advance` with a
  contract — the "never against nothing" control is the contract). Paid
  through the payment lane; settled by allocation to later invoices (existing
  `supplier_advance_settlement`); stage *Settled* when fully applied.
* A **supplier credit memo** (existing) applied to a payable reduces its
  remaining and writes `CREDIT_MEMO_APPLIED`.

---

# Part D — The import lanes

## 13. Lane rules common to all lanes

* A lane's state is held on its own document(s), never on the application.
* Every state change goes through `statuses.assertTransitionAllowed` using a
  transition table seeded by migration **and editable in import settings**
  (new rows only; a seeded transition may be deactivated, not deleted).
* Every state change writes `audit_event` (existing) **and** `payable_event`
  (§7).
* A *dashed arrow* on the diagram is a dependency check: the target action
  refuses with a plain-language message naming what it waits for (e.g.
  "Payment application needs a validated PD — PD 9330 is still PreApproved").
  A manager may override with a reason; the override is an event.
* Dates are typed as business dates; the server stamps `recorded_at`.

## 14. Lane 1 — Order & invoice ("What we buy")

| Box | Specification |
|---|---|
| **Pending order / PI** | The supplier's PDF, entered by the accountant as a purchase invoice (§8) — that entry *is* the application's birth: `supplier_reference` = the invoice number, the invoice lines are stored as `payable_order_line`, the PDF is attached. **In the same transaction a purchase order is created from those lines through the existing `purchase-order` service and submitted** — approval stays a second person's act in the approvals inbox (blueprint §5.2 maker-checker; one officer must not self-approve a commitment) (the PI is the company's order; `purchase_order.reference` = the PI number) — or, when the user picks an existing approved PO of the same supplier, that PO is linked and its lines become the order lines. Event `PAYABLE_OPENED`, `PI_RECORDED`, `PO_LINKED`. |
| **Purchase invoice** | The existing AP invoice, created from the application page ("Create purchase invoice") with lines pre-filled from the PI, or linked afterwards by picking an existing posted invoice of the same supplier whose reference matches `supplier_reference_key`. Posting the invoice writes `INVOICE_POSTED` with amount and quantity; reversal writes `INVOICE_REVERSED` and re-derives the stage. Several invoices per application are allowed; one invoice belongs to at most one application. |
| **Payment terms** | `payment_terms_text` (verbatim) and the structured instalment plan of §15.2, entered together. Event `TERMS_SET`; any later change `TERMS_CHANGED` with before/after. The invoice's own `due_date` (existing) is kept for AP ageing and is set from the last instalment's expected date. |
| **Move to BL** | Automatic. The moment the first B/L is recorded (§17.1) the order lane writes `MOVED_TO_BL`; from then on quantities are tracked per container, and the PI lines become the plan to check containers against. |
| *(no exception box)* | — |

## 15. Lanes 2 and 3 — Bank & finance ("Where the money comes from") and Payment ("Paying the supplier")

The two lanes are specified together because every dashed arrow between them
is a rule.

### 15.1 Bank accounts (box "Bank accounts — Mansour · Arab · NBI · Rafidain")

* New master `bank` (code, name, SWIFT/BIC, country, `active`), seeded from the
  PD sheet's bank codes: `MBIVIQBAXXX` Mansour (32), `ARABIQBAXXX` Arab (88),
  `NBIQIQBAXXX` NBI (15), `BABIIQBAXXX` (8), plus Rafidain. **Not a fixed list.**
* `bank_cash_account.bank_id` (fk, nullable for cash accounts) replaces the
  free-text `bank_name` for bank accounts; the text column is kept and
  back-filled.
* Three figures per account, in the account's **own currency** and in IQD:
  * **Booked** — the G/L balance (existing `treasury.balances`).
  * **Reserved** — money held for payment applications in `approved` or `sent`
    (§15.3) **plus** the existing commitments (approved transfers, pending
    batch lines). Added to the `committedIqd` subquery.
  * **Available** = Booked − Reserved. Shown on the account screen and in the
    payment-application picker.

### 15.2 Instalments planned (box in the Payment lane)

`payable_instalment` — the structured form of the terms:

| Field | Rule |
|---|---|
| `sequence` | 1, 2, 3 … unlimited. |
| `label` | "Deposit", "Balance", "2nd payment" (free). |
| `basis` | `percent` of invoice amount **or** `amount` in transaction currency. The plan must total 100 % / the invoice amount; the last instalment absorbs rounding (existing `instalmentSchedule` rule). |
| `trigger` | Master `instalment_trigger` (seed): `on_order` · `before_production` · `before_shipment` · `against_bl_copy` · `against_bl_original` · `days_after_bl` · `days_after_invoice` · `on_arrival_warehouse` · `after_delivery` · `sinosure_credit`. Configurable (R4). |
| `trigger_days` | For the `days_after_*` triggers (e.g. 60). |
| `expected_date` | Derived when the trigger's event happens (B/L date + 60), typed for `on_order`; recomputed and logged when the trigger date changes. |
| `status` | `planned` → `applied` (a payment application exists) → `paid` → `cancelled`. Derived from §15.3. |

The 60 terms texts in the sheet all fit this model ("TT 10% deposit, 90%
balance against B/L in 60 days" = two rows). Event `INSTALMENT_PLANNED`.

### 15.3 Payment application (box "Payment application — needs validated PD + funds")

A new document, `payment_application`, number series `PAYAPP`, **used by every payable type** (import, service, rent, local goods, advance). It is the
**company's request to its bank or cashier** to pay the supplier. It is not a journal; the
journal is posted when the money leaves (§15.4).

| Field | Rule |
|---|---|
| `payable_id`, `instalment_id` | Required. One instalment may have several payment applications only if an earlier one was rejected/cancelled. |
| `payment_method_code` | fk `payment_method` (existing master: bank / cash / transfer, fee %). Seed codes `SWIFT`, `LOCAL_TRANSFER`, `CASH`, `CHEQUE`. The method decides which confirmation fields are required and which time limit applies (§19.3, scope `method:<code>`). |
| `bank_cash_account_id` | Required. A bank account for SWIFT / transfer / cheque, a cash account for cash. Must be active and in the payable's currency (§28 D3). |
| `payee_bank_account_id` | fk `partner_bank_account`, required for SWIFT / transfer; must be **verified** (existing control). |
| `funding_source` | `own_funds` · `loan` (master, extensible). If `loan`, `loan_id` is required (§15.7) and the loan must have undrawn / unallocated proceeds ≥ amount. |
| `amount_txn`, `amount_iqd` | Typed in transaction currency; IQD at the accounting rate on `application_date`. |
| `application_date` | The date the file went to the bank. Required when the status becomes `sent`. |
| `bank_reference` | The bank's file / application number, if any. |
| `confirmed_on`, `confirmation_reference` | Required when the status becomes `confirmed`: for SWIFT the SWIFT date and MT103 reference (the UI labels them *SWIFT date / SWIFT ref*, and the copy is attached); for a local transfer the bank reference; for cash the voucher number and the signed voucher; for a cheque the cheque number and date. |
| `debit_date`, `statement_line_id` | Set when the debit is matched to a bank statement line (§15.4). |
| `status` | `draft` → `approved` → `sent` → `confirmed` → `debited`; `rejected` (reason) / `cancelled` (reason) from `approved` or `sent`. Seeded transitions, editable. (`confirmed` is shown as *SWIFT confirmed* when the method is SWIFT — the diagram's wording.) |
| `supplier_payment_id` / `supplier_advance_id` | The posted accounting document created at `confirmed` (§15.4). |
| `pd_id` | Import payables only: the PD the bank paid against (required unless overridden). |
| `days_waiting` | Derived: today − `application_date` while `sent`. |

**Dashed-arrow checks on *send* (all overridable by a manager with a reason,
logged):**

1. *Needs validated PD* (arrow from PD lane; **import payables only**): a PD of this application is in a
   status flagged `allows_payment` (seed: Validated, Partially written off) and
   not expired. For other types this check is skipped and shown as "not applicable".
2. *Needs funds* (arrow from Bank lane): the account's **Available** ≥ amount.
   On approval the amount becomes **Reserved** (`FUNDS_RESERVED`); on
   rejection/cancellation it is released (`FUNDS_RELEASED`).
3. *Instalment trigger met*: for `against_bl_*` the application has a B/L;
   for `before_shipment` no container has left (`on_sea`); otherwise warning only.

### 15.4 SWIFT pending → SWIFT confirmed → Fully paid

| Box | Specification |
|---|---|
| **SWIFT pending — clock runs · NOT PAID** | Status `sent`. The list shows `days_waiting`. The daily sweep (§19.3) compares it with the time limit **for that method and bank** (limits may be per method, per bank, R4) and, when over, writes `SWIFT_OVER_LIMIT` and requires a hold (§19). The diagram's "e.g. 14 d" is the seed value. |
| **SWIFT confirmed — Swift date set · PAID** | Action *Confirm SWIFT*: type `swift_date`, `swift_reference`, attach the copy. In the same transaction the system creates and posts the accounting document through the **existing** services: a `supplier_advance` against the application's purchase order if no AP invoice is posted yet (deposit before invoice), otherwise a `supplier_payment` allocated to the application's invoice(s). Both documents receive the new `amount_txn` + `currency` columns (Stage 2, additive) so the posted document shows the SWIFT amount in its own currency; the journal stays IQD. Posting date = `swift_date`. Event `SWIFT_CONFIRMED`, and `DEBIT_FINAL` in the bank lane once the bank statement line is matched (existing reconciliation; the match sets `debit_date`). Reserved → released, Booked falls. |
| **Fully paid — Remaining = 0** | Derived (§15.5). Event `FULLY_PAID`. Instalment statuses become `paid`. |
| **Exception: SWIFT late — over limit (e.g. 14 d) → reason** | Not a status. It is the hold of §19 with lane `payment`, opened automatically by the sweep and completed by the accountant with the reason code. The payment application stays `sent` until the bank answers. |

Existing behaviour to change: `supplier-payment.allocate` today accepts a
`draft` payment, so an invoice can show as settled before money moved
(`services/supplier-payment.ts:291`). Within this module allocation happens
only at `confirmed`, in the same transaction as posting.

### 15.5 Applied / Paid / Remaining (calculations)

For an application:

* **Applied** = Σ `amount_txn` of payment applications in `sent` + `confirmed` + `debited`.
* **Paid (SWIFT / confirmed)** = Σ `amount_txn` in `confirmed` + `debited`.
* **Remaining** = invoice amount − Paid. (Before the invoice is posted: PI amount − Paid.)
* **Fully paid** ⇔ Remaining = 0 (to the currency's minor unit).

All three are also kept in IQD using each document's own rate. Totals are
computed in SQL from the rows, never stored on the application, so they cannot
drift (same principle as the inventory ledger).

### 15.6 Deposit / loan in — Available balance — Funds reserved — Debit final — Loan repayment (the Bank lane, top to bottom)

| Box | Specification |
|---|---|
| **Deposit / loan in — own money or bank loan** | *Deposit*: an existing *Other Receipt* against the bank account, with a new receipt type `owner_deposit` (posts bank ↔ equity/shareholder account). Event `DEPOSIT_RECORDED` on any application that names this account as its funding source and is not yet funded (informational). *Loan*: §15.7 disbursement. |
| **Available balance — booked − reserved** | §15.1. |
| **Funds reserved — held for the application** | §15.3 check 2. A reservation is a row in `payment_application` with status `approved`/`sent`; there is no separate table, so a reservation cannot exist without the document that explains it. |
| **Debit final — money left the account** | §15.4: the posted supplier payment/advance **and** the matched statement line. Until the statement match, the application shows "SWIFT confirmed, debit not yet seen on statement". |
| **Loan repayment — instalments + commission** | §15.7. |
| **Exception: no funds / instalment overdue** | *No funds*: the send check fails; the user may open a hold with reason `FUND`. *Instalment overdue*: the sweep marks a loan instalment overdue and writes `LOAN_INSTALMENT_OVERDUE` on every application that loan funds. |

### 15.7 Loans — `bank_loan`, `bank_loan_instalment`, `bank_loan_allocation`

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
charge of type `bank_commission` (§20.2). The allocation method is
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

## 16. Lane 4 — PD / ASYCUDA ("Customs pre-declaration")

### 16.1 `customs_pd`

| Field | Rule |
|---|---|
| `payable_id` | Required. **Several PDs per application are allowed** (the sheet has invoices with 2–3 PDs; a rejected or expired PD is re-registered, never edited). |
| `pd_no` | The ASYCUDA number. Unique per registration year. |
| `registration_date`, `expiry_date` | Expiry typed (the sheet shows 181–257 days; **not computed**, the validity is the customs office's). |
| `bank_id`, `bank_swift` | The bank the PD is registered with; a payment application against this PD must use an account of that bank (check 1 of §15.3, overridable). |
| `status` | fk `pd_status` master — seed exactly the ASYCUDA list: `submitted` (Submited) · `pre_approved` · `validated` · `partially_written_off` · `totally_written_off` · `rejected` · `expired_validated` · `expired_part_written_off`. Each row carries flags: `allows_payment`, `is_terminal`, `is_expired`. New statuses by configuration. |
| `status_history` | `customs_pd_status_history` (append-only): status, effective date, source (`user` / `asycuda_screenshot` / `sweep`), note, attachment. |
| `port_file_sent_on` | Per container, see §17.3 (`port_file_sent_on` lives on the container); the PD shows the count "port files sent: 3 of 5". |
| `notes` | Free text — replaces the sheet's "Pending" notes ("port file needed urgently", "3597 need swift"). Each note is also an event. |

### 16.2 Boxes

| Box | Specification |
|---|---|
| **PD submitted — registered in ASYCUDA** | Create with `submitted`. Event `PD_SUBMITTED`. |
| **PreApproved — waiting validation** | Status change. `PD_STATUS_CHANGED`. |
| **Validated — bank + SWIFT code · valid period** | Status `validated` unlocks payment applications (§15.3). The *valid period* is `registration_date → expiry_date`; the sweep writes `PD_EXPIRING` at the configured warning (seed 45 days) and `PD_EXPIRED` on the day after expiry, and requires a hold with reason `PD` if the PD is not terminal. |
| **Port file sent — per arrived container** | Action on a container (§17.3) that has reached `customs_cleared`; records `port_file_sent_on`; event `PORT_FILE_SENT` on the PD lane. |
| **Partially written off — some containers settled** | Status change, normally after the first port files. |
| **Totally written off — PD fully settled** | Terminal, feeds *Cleared* (§20.1). Event `PD_TOTALLY_WRITTEN_OFF`. |
| **Exception: Rejected / Expired → re-register** | `rejected` and the two `expired_*` statuses are terminal for that PD row. Action *Re-register* creates a new PD row linked by `supersedes_pd_id`; the old one stays. Event `PD_REREGISTERED`. A hold with reason `PD` is required until the new PD is validated. |

## 17. Lane 5 — Shipment, per container ("Every container on its own")

### 17.1 `bill_of_lading`

| Field | Rule |
|---|---|
| `payable_id` | Required. **Unlimited B/Ls per application.** |
| `bl_no`, `bl_date` | Unique `bl_no`. |
| `shipping_line`, `vessel`, `voyage` | Optional. |
| `port_of_loading`, `port_of_discharge_id` | POD from master `port` (seed Aqaba, Umm Qasr; extensible). |
| `eta` | B/L-level ETA; each container may override. |
| `status` | **Derived** from its containers: the least-advanced container's status (so a B/L is `received` only when all its containers are). |
| `total_quantity` | Σ container lines (planned). Compared to the PI/invoice lines; a mismatch is a warning event `QUANTITY_VARIANCE`, not a block. |

Recording the first B/L writes `BL_ISSUED` and triggers `MOVED_TO_BL` (§14).
Instalments with trigger `against_bl_*` get their `expected_date`.

### 17.2 `shipment_container`

| Field | Rule |
|---|---|
| `bl_id`, `payable_id` | |
| `container_no` | ISO 6346 format checked (4 letters + 7 digits); duplicates across live B/Ls refused; the same number may recur on a later import after this one is received. |
| `size_type` | 20GP / 40HC … free master. |
| `status` | fk `container_status` master. Seed: `not_loaded` · `on_sea` · `at_port` · `customs_cleared` · `received` · `late` · `missing_damaged`. Flags per row: `counts_as_received`, `is_exception`, `sequence`. Editable (R4). |
| `eta` | Per container; defaults from the B/L. Changing it writes `ETA_CHANGED` (old → new). |
| `departed_on`, `arrived_port_on`, `customs_cleared_on`, `port_file_sent_on`, `received_on` | One date per stage, **all kept** (never overwritten; a re-dated stage writes a correction event). |
| `warehouse_code` | Where it was received (the receipt sets it). |
| `container_receipt_id` | The goods receipt that received it (§18). |
| `status_history` | `shipment_container_status_history` (append-only): status, date, actor, note. |

`shipment_container_line`: `item_code` (the model), `description`, `planned_qty`,
`unit`, `received_qty`, `damaged_qty`, `short_qty`, `warehouse_code` — one row
per model per container (a container may carry several models; a model may be
split across containers).

### 17.3 Boxes

| Box | Specification |
|---|---|
| **Not shipped — awaiting loading** | Stage 5 not yet reached: no B/L, or containers `not_loaded`. |
| **B/L issued — lists every container no.** | §17.1; containers are entered with the B/L (paste a list of numbers; the system splits and validates). |
| **On the sea — each container: own ETA** | Status `on_sea`, `departed_on`. |
| **On port / customs — container by container** | `at_port` with `arrived_port_on`; then `customs_cleared` with `customs_cleared_on`; then *Port file sent* (§16.2). |
| **Container received — inbound date per container** | Set only by the warehouse receipt (§18); never typed here. |
| **"partly: 3 of 5 in"** | §17.5. |
| **All containers in — Y of Y received** ✓ | Derived; writes `ALL_CONTAINERS_RECEIVED`; stage 7. |
| **Exception: Container late — ETA passed, not arrived** | The sweep sets `late` on any container whose `eta` < today and status is before `at_port`; event `CONTAINER_LATE`; a hold with reason `SHIP` is required on the application. When the container arrives, the status moves on and the hold is resolved with what happened. `missing_damaged` is set by the receipt when quantities differ (§18). |

### 17.4 The existing four-stage shipment

`supplier_shipment` (`in_process → on_board → on_port → in_bounded`) is
replaced by this lane. The `/inventory/in-transit` screen becomes the
*Containers in transit* list (§21.9). Existing rows are migrated (§24.4) and the
table is kept read-only.

Stock while at sea: the staging warehouses WH-INPROC / WH-BOARD / WH-PORT are
changed to type **`transit`** so that `stock_position` stops counting goods at
sea as available for sale (defect found in review). In this lane goods are
**not** in any warehouse until received (§18); the *in transit* figure is the
Σ planned − received of container lines, shown on availability as a separate
"incoming" column, never as on-hand.

### 17.5 X of Y

* **Y** = number of containers across all B/Ls of the application.
* **X** = containers whose status has `counts_as_received`.
* Shown as "X of Y received" on every list and header; stage 6 while
  0 < X < Y, stage 7 when X = Y > 0.
* *Partly received for longer than the configured limit* (seed 30 days from the
  first receipt) → the sweep requires a hold with reason `SHIP`.

## 18. Lane 6 — Warehouse & stock ("What we have in stock")

| Box | Specification |
|---|---|
| **Container detail — container × model × WH** | `shipment_container_line` (§17.2). This is the plan the receipt is checked against. |
| **In transit — planned − received qty** | Derived per model and per application; feeds the availability screen's "incoming" column (§17.4). |
| **Inbound — date + qty per warehouse** | **Receive container**: a goods receipt against the application's purchase order (`purchase_order_id` stays NOT NULL — every application has a PO, §5.1) with the new `goods_receipt.container_id` (nullable fk; set for every receipt made from this module). One receipt per container; several containers may be received in one session but each gets its own document. Lines pre-filled from the container lines; the user confirms `received_qty`, `damaged_qty`, `short_qty`, warehouse (must belong to the application's branch). Posting writes `inventory_movement` + `cost_layer` rows in the same transaction (existing `inventory.receive`, unit cost from the AP invoice line; if the invoice is not posted yet, the PI price, corrected at invoice posting through the existing cost-adjustment path). Sets the container `received`, `received_on`, `warehouse_code`; events `CONTAINER_RECEIVED` and, if any variance, `QUANTITY_VARIANCE` + status `missing_damaged` on the container + an automatic hold with reason `OTHER`/"claim" for purchasing. |
| **In stock — inbound − outbound · 9 WH** | Existing `stock_position` per item per warehouse. "9 WH" on the diagram is the company's current count, not a limit — warehouses are master data. |
| **Outbound / sales — sales invoice, customer** | Existing AR invoice / delivery note. When an AR invoice issues stock from a cost layer that came from a container of an application, the application receives an informational `OUTBOUND_RECORDED` event (traceability of what was sold from which import). |

The received quantity of an application = Σ `received_qty` over container
lines — the fix for the sheet's double counting.

---


---

# Part E — Where is it stopped, and why?

## 19. Holds

### 19.1 Principle (the red band of the diagram)

> Any problem that appears in tracking must be updated in the application
> status. *(Holds apply to every payable type — a rent that is not paid needs a reason exactly like a SWIFT that is late.)* Any stage over its time limit must carry a reason code, owner and
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

### 19.2 `payable_hold` (append-only state, never deleted)

| Field | Rule |
|---|---|
| `payable_id`, `lane_code`, `stage_code` | Where. |
| `source_type`, `source_id` | The document that is stuck (payment application, container, PD). |
| `reason_code` | fk `hold_reason_code` master. Seed the twelve codes of the diagram: `PD` not validated / expired · `FUND` waiting deposit or loan · `DOC` documents missing at bank · `BANK` bank internal approval · `CBI` platform / K2 compliance review · `REJ` rejected, resubmit · `SUP` supplier bank details / query · `CORR` correspondent bank hold · `AMT` amount mismatch · `SHIP` container delayed at origin / port · `CUS` customs / port file pending · `OTHER` free text (detail required). Plus the system code `PENDING_REASON`. Each row: `code`, `name`, `lane_hint`, `default_owner_role`, `requires_detail`, `active`. **Editable** (R4). |
| `detail` | Free text; required for `OTHER`. |
| `owner_user_id` | Who is following up. Required to leave `PENDING_REASON`. |
| `started_at` | When the stop began — the sweep uses the date the limit was passed; a manual hold uses today or a typed earlier date. |
| `next_action`, `next_action_due` | Required. |
| `status` | `open` → `resolved`; never deleted. |
| `resolved_at`, `resolution` | What happened. |
| `escalated_at`, `escalated_to_role` | §19.4. |

Every change to a hold is a row in `payable_hold_update` (append-only:
what changed, by whom, when) **and** an application event. The hold's current
values are a projection of its updates; the screen shows the full thread, like
`collection_activity` does for AR.

`on_hold` on the application = an open hold exists. "Stopped since + days" uses
the oldest open hold.

### 19.3 Time limits — `stage_time_limit`

| Field | Rule |
|---|---|
| `check_code` | Which clock: `swift_pending` · `pd_not_validated` · `pd_expiring` · `container_eta_passed` · `partly_received` · `at_port` · `invoice_unfunded` · … (master, extensible — each check is a named query in `services/import-sweep.ts`, registered in a table so a new check is a new row + a new named query, not a schema change). |
| `scope` | `all` · `bank:<code>` · `port:<code>` · `supplier:<id>` — the most specific active row wins. |
| `limit_days` | The number. **Seed values are examples** (swift_pending 14, pd_not_validated 7, pd_expiring 45, container_eta_passed 0 (= day after ETA), partly_received 30, at_port 10, invoice_unfunded 7). |
| `escalate_after_days`, `escalate_to_role` | §19.4. |
| `active`, `valid_from` | A changed limit is a new row; the old one is closed. |

The sweep (`scripts/ops/import-sweep.ts`, cron next to `due-notices`) runs
daily, idempotently: one `OVER_LIMIT_DETECTED` event and one automatic hold per
(application, check) while the condition holds — never a second one for the
same condition.

### 19.4 Escalation and notifications

* When a hold is opened the owner (or the reason code's default role) gets an
  in-app notification through the existing notification service, rule
  `import.hold.opened`.
* When a hold has no owner for longer than `escalate_after_days`, or stays open
  past the limit's escalation, the sweep writes `ESCALATED` and notifies
  `escalate_to_role` (seed: `accounting_manager`). The escalation clock runs
  from when the hold was **opened**, not from the back-dated breach date —
  otherwise an automatic hold would escalate in the same sweep that raised it.
* Holds are visible on the existing dashboard's *Waiting on me* band for the
  owner — the only dashboard change in this requirement. (A separate alerts
  dashboard is **out of scope**, §27.)

---


---

# Part F — Closing, and the landed cost

## 20. Closing a payable — cleared

### 20.1 The rule (the orange band)

The application is **cleared automatically** — nobody clicks it — in the same
transaction as the event that satisfies the last of three conditions:

1. **Supplier fully paid** — Remaining = 0 (§15.5) and every payment application
   of the plan is `confirmed` or `debited`.
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
(§24) the 22 rows marked "cleared" are compared with the rule and every
difference is listed for the accountant (the review found 6 marked cleared
whose PD is not written off, and 9 written off but not marked).

### 20.2 Landed cost (the box under the band)

`landed_cost_charge` — one row per cost that belongs to the import:

| Field | Rule |
|---|---|
| `payable_id` | |
| `charge_type` | master `landed_cost_type`, seed: `purchase` (SWIFT paid) · `bank_commission` · `loan_cost` · `freight` · `customs_asycuda` · `port_forwarding` · `other`. Extensible. |
| `amount_txn`, `currency`, `amount_iqd` | |
| `source_type`, `source_id` | The AP invoice line (forwarder's invoice), journal, loan allocation, payment application that carries the cost. Charges are **created from documents**, not typed, except `other` with a reason. |
| `allocation_basis` | Inherited from settings: `by_value` (seed) · `by_quantity` · `by_weight` · `by_volume` · `manual`. |

**Final landed cost — locked after PD written off.** The action *Lock landed
cost* is offered once condition 3 of §20.1 holds (charges after that point are
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

---

# Part G — Screens

## 21. Screen by screen

Conventions: every screen is a Next.js route under `src/app/(app)/payables/…`.
**Every screen draws the module's navigation with the existing `SectionTabs`
component** (the screens of the same menu heading, in the menu's order) and
never its own row of links; filters and saved views live inside the list
area, below the tabs, next to the search box. A screen that looks different
from the rest of the ERP is wrong.
The menu section `purchasing` is **renamed `payables`** (key, label in `en`
and `ar`, ordinal unchanged) and absorbs the items of `finance_ap` (supplier
ledger, ageing, allocations, reconciliation), which section is removed from
the tree — one module, one place. Existing routes under `/purchasing/…` keep
working as redirects to their `/payables/…` equivalents (nothing a user has
bookmarked breaks). Each route joins `domain/screens.ts` `DELIVERED` on the
day it reads real data. Screens use `DocumentWindow` / `RecordHistory`, the
print & export menu, server-side paging, `messages/en.json` + `ar.json`, and
work at mobile width and RTL. Nothing about the existing appearance changes.

### 21.1 Payables menu (after this requirement)

| Item | Route | Status |
|---|---|---|
| Payables workbench | `/payables` | new (§21.2) |
| Suppliers & vendors | `/payables/suppliers` (was `/purchasing/suppliers`) | existing, + verified bank accounts tab |
| Purchase orders | `/payables/purchase-orders` | existing schema, new screen (§21.6) |
| Goods receipts | `/payables/goods-receipts` | existing schema, new screen (§21.6) |
| Service receipts | `/payables/service-receipts` | existing schema, new screen (§21.5) |
| Purchase & expense invoices | `/payables/invoices` (was `/purchasing/ap-invoices`) | existing, + payable link, + charged-to-import lines |
| Recurring contracts | `/payables/contracts` | new (§21.4) |
| Import applications | `/payables` filtered to type Import; records at `/payables/[payableNo]` | new (§21.3) |
| Payment applications | `/payables/payment-applications` | new (§21.7) |
| Supplier payments | `/payables/supplier-payments` | existing |
| Advances | `/payables/advances` | existing schema, screen in Stage 3 |
| Returns & credit memos | `/payables/goods-returns`, `/payables/credit-memos` | existing / schema |
| Open items & ageing | `/payables/open-items` (was `/purchasing/payables`), `/payables/ageing` | existing |
| Supplier statements | `/payables/supplier-statements` | existing |
| PDs (import) | `/payables/pd` | new (§21.8) |
| Shipments & containers (import) | `/payables/shipments`, `/payables/containers` (replaces `/inventory/in-transit`) | new (§21.9) |
| Banks & loans | `/master-data/banks`, `/payables/loans` | new (§21.10) |
| Payables settings | `/administration/payables-settings` | new (§21.11) |

### 21.2 Payables workbench `/payables`

The one list for everything owed — but **two experiences, one table**. An
import is a big tracked record; a rent, a forwarder's bill or a broker's fee
is not, and must never be shown with the import's machinery. The list area
has two tabs:

* **Imports** (default) — the full columns below, the stage, the stopped
  chips, the "Stopped — reason required" views.
* **Expenses** — every other type, plainly: name · who we pay · amount · due
  date · **Unpaid / Paid / Overdue** · belongs to import (if any). No stage
  rail, no reason codes, no hold owner. *Overdue* = due date passed and not
  paid: the row turns red with "Overdue — N days" and an inline **Add note**
  so someone writes why (internally the `recurring_overdue` / `service` hold
  with reason `OTHER` and the note as detail — the data model is kept, the
  procedure is hidden).

Header actions: **Add expense** (below) — there is no "New import" button:
an import is born when the accountant enters the supplier's invoice (§8). **Add expense** — a small dialog: type of fee (`expense_category`: rent,
electricity, internet, freight forwarding, customs brokerage, consultant,
bank charge, other — extensible in settings) · name · who we pay · amount +
currency · due date · attach invoice (optional) · *belongs to import*
(optional, for forwarder / broker / port costs) · *repeat every month*
(creates the recurring contract and its first period) · Save. Saving creates
a payable of type `service` (or `recurring`) and writes `PAYABLE_OPENED`.

Imports tab columns (default view): no · **type** chip ·
reference · supplier · department · description · amount (txn) · **stage**
(+ days) · **Stopped?** (reason · owner · days) · due / expected date ·
applied / paid / remaining · next action + due · branch. Type-specific columns
appear when the list is filtered to one type (import: PD, containers X of Y,
B/L; recurring: period). Filters: type · stage · stopped (yes / no / needs
reason) · supplier · department · category · bank · method · due range · text
search across reference, PD, B/L, container, contract. Saved views (seed):
*All open* · *Stopped — reason required* · *Due this week* · *Overdue* ·
*SWIFT / transfer waiting* · *Import — partly received* · *Rent & contracts
this month* · *Closed this month*. Sort default: stopped-without-reason first,
then days stopped desc, then due date. Row actions: open · stop / follow-up
(§21.12) · print. Header: New payable (type picker) · Export.

### 21.3 Payable page `/payables/[payableNo]`

One layout for every type; the tabs that show are the type's lanes.

* **Header band** — for **import**: the chip rows of §5.2, the 8-step stage
  rail as drawn, days in stage. For **every other type**: the expense fields,
  a status chip *Unpaid / Paid / Overdue*, and the buttons **Mark paid**
  (date, method, reference — creates the posted supplier payment through the
  existing service in the same transaction and writes the event) and **Add
  note**. The 7-step rails of §6 still exist internally (derived and logged)
  but are not drawn for these types.
* **Stop banner** (import only) — as §19: reason · owner · since · next
  action, with *Update / Reassign / Resolve*; or "Over time limit — reason
  required". Other types show only the red *Overdue* chip and the note.
* **Tabs** (shown when the lane applies): Order & invoice · Service
  (receipt / confirmation; for recurring: the period and contract) · Bank &
  funding · Payments · PD / ASYCUDA · Shipment & containers · Warehouse &
  stock · Landed cost · **Status log** · Attachments & history — each as
  specified in §15.2 of REQ-APP-001 for the import lanes, and for the service
  lane: receipt(s) with confirmation status, period, evidence; buttons *New
  service receipt*, *Confirm*, *Dispute*.
* Footer: created, branch, department, source, contract (if any).

### 21.4 Recurring contracts `/payables/contracts` and `/payables/contracts/[contractNo]`

List: contract no · supplier · department · category · amount / period ·
frequency · next due · status · overdue periods (red). Record: §10.3. Actions:
New · Amend (dated) · End · Generate next period now (manual, logged).

### 21.5 Service receipts `/payables/service-receipts`

The department's inbox ("awaiting my confirmation") and list; record with PO
lines (or the payable's lines when no PO), period, confirmed quantity /
"done", evidence attachments, approve / dispute. Posts nothing (unchanged).

### 21.6 Purchase orders and goods receipts `/payables/purchase-orders`, `/payables/goods-receipts`

Screens for the existing documents: PO list + record (lines, status, received
/ invoiced quantities, linked payable); goods receipt list + record (per PO;
per container when opened from an import — §18). Both exist in schema and
service today and only need their screens.

### 21.7 Payment applications `/payables/payment-applications`

As §15.3 of REQ-APP-001 (list sorted by days waiting; record with the
dashed-arrow checklist; *Confirm* dialog that explains the posting), extended
with the payment method: SWIFT (swift date + reference + copy), local transfer
(reference + date), cash (cash account, voucher no, signed voucher
attachment), cheque (number, date). The PD check applies only to import
payables.

### 21.8 PDs, 21.9 Shipments & containers, 21.10 Banks & loans

As §15.4, §15.5–§15.6 and §15.8 of REQ-APP-001 (unchanged in substance; routes under
`/payables/…`).

### 21.11 Payables settings `/administration/payables-settings`

Tabs: Payable types (lanes, controls, series) · Stages per type · Time limits
(check, scope: type / bank / method / port / supplier, days, escalation) ·
Reason codes · Expense categories · Instalment triggers · Payment methods (link
to the existing master) · Container statuses · PD statuses · Ports ·
Landed-cost types and allocation basis · Event codes. Nothing is deleted,
only deactivated; every change is audited.

### 21.12 Stop / follow-up dialog

As §15.7 of REQ-APP-001; used on every list and record of the module.

### 21.13 Existing screens that change

| Screen | Change |
|---|---|
| Purchase & expense invoice | Payable picker (or created from a payable with pre-filled lines); `charged_to_payable_id` per line with the import picker; posting writes the payable event; history folds in the payable's events for this invoice. |
| Supplier payments | Read-only when created by a payment application; link back. |
| Suppliers & vendors | Bank accounts tab shows verification status; a payment application may only pay to a verified account (existing control, now enforced at *Send*). |
| Bank / cash accounts | Booked / Reserved / Available with drill-down. |
| Availability / stock ledger | "Incoming (in transit)" per item; goods at sea not on-hand. |
| Dashboard | *Waiting on me* gains "Holds I own", "Holds needing a reason in my lane", "Service receipts awaiting my confirmation", "Payables due this week". Nothing else. |
| Numbering | Series `IMP`, `SVC`, `RNT`, `PUR`, `ADV`, `CTR`, `PAYAPP`, `LOAN`, `CREC`. |
| Approvals inbox | Payable approvals (invoice approval, non-PO, payment application approval) appear there with links. |


---

# Part H — Data preservation, scalability, integration, migration

## 22. Never lose data

### 22.1 Rules enforced in the database, not only in code

| Rule | Mechanism |
|---|---|
| `payable_event`, `payable_hold_update`, `customs_pd_status_history`, `shipment_container_status_history`, `landed_cost_allocation` are append-only | The `audit_event` trigger (`0001_phase01_platform_core.sql:206`) reused: UPDATE and DELETE raise. |
| No application, payment application, PD, B/L, container, loan or charge is ever deleted | No DELETE grant on these tables for `erp_app`; services expose only cancel-with-reason, which is a status row plus an event. |
| A cancelled or superseded row stays visible | Lists have an "include cancelled" toggle; the record shows "Cancelled on … by … because …". |
| Corrections are new rows | `correction_of` on events; `supersedes_pd_id` on PDs; dated adjustment rows for landed cost; status-history rows for re-dated stages. |
| Documents created by the module in other modules follow their own rules | A supplier payment created at SWIFT confirmation is reversed, never deleted, if wrong (existing `reverse`), and the reversal is an event on the application. |
| Attachments are kept | Existing attachment retention; an attachment can be marked superseded, not removed. |
| Migrations are additive | Per `AGENTS.md`: never rewrite an applied migration; journal timestamps strictly increasing; every new stock-moving kind added to `resetTestData` and `format-live-database.sh`. |
| Imports keep their source | `source` + `source_row` on every migrated row (§24); the original sheet file is attached to a system application `IMP-MIGRATION-2026`. |
| Backups | Existing nightly backup and weekly restore drill cover the new tables; the drill's table list is extended by the same migration that creates them. |

### 22.2 Volume and retention

The event table is partitioned by year from the first (hand-authored) migration; partitions
are created a year ahead by the nightly job. No row is ever purged; a partition
older than the configured online horizon (seed 7 years) may be moved to slower
storage, never dropped, by a documented operations procedure. Indexes of §7.1
keep the application page at one query per tab.

## 23. Scalable, not fixed

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
| Interfaces | The sheet import (§24) is built as an *import definition* of the existing import framework (`import-definitions.ts`), so a future supplier portal, ASYCUDA list or bank file is another definition, not another module. Every list has CSV export. |
| Performance | Lists are server-paged and indexed on the filter columns; derived totals are SQL aggregates with covering indexes; the application header reads one row + four aggregate queries. Target: list < 1 s at 10,000 applications and 200,000 events; application page < 1.5 s. Load test added to `tests/load`. |


## 24. Integration and migration

### 24.1 Integration points (existing services reused)

| Need | Existing service | How it is used |
|---|---|---|
| Purchase order from a PI | `purchase-order` | created and approved in the payable's transaction (import, local goods) |
| Receipt evidence | `goods-receipt`, `service-receipt` | unchanged documents; gain `payable_id` / `container_id` |
| Invoice | `ap-invoice` | gains `payable_id`; line `charged_to_payable_id`; approval writes events |
| Money out | `supplier-payment`, `supplier-advance`, `journal`, `posting` | created and posted at confirmation of a payment application; gain `amount_txn` + `currency` |
| Funds | `treasury.balances` | reserved payment applications added to committed |
| Statement match | `bank-reconciliation` | sets `debit_date` / closes the payable |
| Stock | `inventory.receive`, `cost_layer` | container receipts; landed-cost value adjustment |
| Log & controls | `audit`, `statuses`, `numbering`, `attachments`, `notifications`, `due-notices` pattern, `saved-views`, `list` | as described |
| Approvals | `department-routing`, `approvals` | invoice approval, non-PO, payment application approval, service receipt approval |

### 24.2 Menu and route migration

`purchasing` → `payables` (key and labels), `finance_ap` items moved in and
the section removed; `/purchasing/*` → `/payables/*` redirects; permissions
granted on the old objects are unchanged (objects keep their names).

### 24.3 Migration of the current sheet (`QS_DASHBOARD.xlsx`)

A one-time, re-runnable import (dry-run first, with a report), built as an
import definition. Mapping:

| Sheet | Target | Rules |
|---|---|---|
| `dashboard` (58 rows) | `payable` + `payable_order_line` (one summary line when no detail) | Key = `PO no./INV.` normalised; supplier matched by normalised name (trim, collapse spaces, strip U+2002); unmatched suppliers listed, never auto-created. Amount, qty, terms text, products. `Clear?` kept as `legacy_cleared` for the §20.1 comparison. |
| `PMT` (80 rows) | `payment_application` | Bank → `bank_cash_account` by bank code (mapping table in the dry-run report); application date; method `SWIFT`; SWIFT date → status `confirmed` if present else `sent`; rows with neither date → `draft`. The 11 rows "not paid but PD totally written off" are flagged `verify_swift_date` in the report. |
| `PD` (88 rows) + `Pending` | `customs_pd` + status history | Match to application by normalised key; 31 unmatched PDs are imported with `payable_id` null into a holding list for the customs officer to link; notes become `notes` + events. |
| `BL` (46) + hidden `CTN No.` (43) | `bill_of_lading` + `shipment_container` | Container numbers split on newline, validated; status mapped `Inbounded → received`, `On the sea → on_sea`, `On port → at_port`; ETA, B/L date, POD. **Received quantity is not copied from the B/L row** (it was the invoice qty); it comes from `BL Product Detail` where present, else the B/L total qty is spread over its containers equally and flagged `estimated` for the warehouse to confirm. |
| `BL Product Detail` (5) | `shipment_container_line` | As is. |
| `Inventory Detail`, `Outbound Detail`, `Warehouse Master` | Not imported — stock already lives in the ERP ledger; the warehouse master is reconciled by name in the report. |
| `Pending Order` (13 lines) | `payable_order_line` of the matching application | The pre-sale columns are ignored (the company does not run pre-sales). |

Data quality fixes applied on the way in, each listed in the report with the
original value: trimmed keys and names; duplicate PDs per invoice kept as
separate PD rows ordered by registration date; the dashboard's "latest PD only"
becomes all PDs.

### 24.4 Existing `supplier_shipment` rows

Each row becomes one application (if the invoice has no sheet match) or links
to the matched one, with one B/L `MIGRATED-<invoice no>` and one container
`MIGRATED-<invoice no>` carrying the invoice's lines, at the status mapped from
the four stages; stock stays where the ledger says it is. Source
`shipment_migration`.

---


---

# Part I — Delivery, acceptance, scope, decisions

## 25. Delivery stages (each its own branch and PR, in this order)

| Stage | Delivers | Depends on |
|---|---|---|
| **1 — Payables core** | §5–§7, §19 (holds, reason codes, time limits, sweep), §21.1 (menu rename + redirects), §21.2 workbench, §21.3 (header, Order tab, Status log, Attachments), §21.12 dialog, §21.11 settings (Stage-1 tabs), numbering, permissions, roles | — |
| **2 — Service, rent and local goods** | §9, §10, §11, §12 (advances linked to contracts), §21.4 contracts, §21.5 service receipts, §21.6 PO & goods receipt screens, invoice link + `charged_to_payable_id`, the contract generator in the sweep | 1 |
| **3 — Payments & bank** | §15.1–§15.6 for all methods (SWIFT, transfer, cash, cheque), §21.7, bank master, reserved / available, confirmation posting, advances screen | 1 |
| **4 — PD / ASYCUDA** | §16, §21.8 | 1 |
| **5 — Shipment & warehouse** | §17, §18, §21.9, container receipts, staging warehouses → transit, retirement of the 4-stage shipment, §24.4 | 1, 3 |
| **6 — Loans** | §15.7, §21.10 (loans), loan liability control kind, allocations and commission share | 3 |
| **7 — Landed cost** | §20.2, including service lines charged to imports | 2, 5, 6 |
| **8 — Migration & go-live** | §24.3 sheet import, dry-run report, accountant sign-off of the cleared comparison, cut-over runbook, training sheet per lane | all |

Stage 1 alone replaces the sheet's purpose: one record per payable of any
kind, every update logged, "where is it stopped and why" with an owner. Stage
2 brings the rent and the forwarders in; Stage 3 makes the payment process
one process.

## 26. Acceptance criteria

| # | Criterion | Test |
|---|---|---|
| A1 | Creating a payable of each seeded type allocates its series number, writes `PAYABLE_OPENED`, enforces the type's controls (PO required for import / local goods; department required for service / recurring), and refuses a duplicate supplier + normalised reference + type. | `ap01-payable-core` |
| A2 | Every service writing to a table carrying `payable_id` writes at least one `payable_event` in the same transaction; the coverage test fails any that does not. | `ap01-event-coverage` |
| A3 | UPDATE / DELETE on the append-only tables raise; DELETE on any payable table is refused for `erp_app`. | `ap01-append-only` |
| A4 | Stage derivation is correct for each seeded rail, including deposit-paid-then-shipped (import, stage 5) and advance-before-confirmation (service, stage 5 with lane "not confirmed"). | `ap01-stage-derivation` |
| A5 | The sweep, run twice, opens exactly one `PENDING_REASON` hold per payable+check over its limit (SWIFT pending, recurring overdue, PD not validated…); completing needs reason, owner, next action; the thread is append-only. | `ap01-holds-sweep` |
| A6 | A time limit changed in settings (scope type / bank / method) applies on the next sweep without deployment; the old row keeps its validity. | `ap01-settings-live` |
| A7 | The menu shows *Payables* (en/ar) with the moved `finance_ap` items; every `/purchasing/*` route redirects to `/payables/*`; permissions unchanged. | `ap01-menu-redirects` |
| A8 | A monthly rent contract generates one payable per period, 30 days ahead, idempotently; auto-confirm moves it to stage 2; a period unpaid after its due date gets an automatic hold; an amendment changes future periods only. | `ap02-recurring-contract` |
| A9 | A service payable cannot have its invoice approved without an approved service receipt when the category requires one; a category with `requires_receipt=false` approves with the note shown. | `ap02-service-flow` |
| A10 | A forwarder's invoice line charged to an import becomes a landed-cost charge of that import and posts to the clearing account, not P&L. | `ap02-charged-to-import` |
| A11 | Sending a payment application without funds / without a validated PD (import) / to an unverified supplier bank account is refused with a message naming the cause; manager override is logged. | `ap03-payments` (A11 · ap03-payment-checks) |
| A12 | Approval reserves funds; rejection releases; confirmation (SWIFT, transfer, cash, cheque each) posts the right document dated the confirmation date and allocates it; `settled_amount_iqd` changes only then; the posted document carries `amount_txn` + `currency`. | `ap03-payments` (A12 · ap03-reserve-and-confirm) |
| A13–A15 | The shipment criteria of REQ-APP-001: B/Ls with their containers arriving part by part ("X of Y received", stage 6 then 7); each container received into the ledger once, its `document_id` the idempotency key, short or damaged goods logged with a reason and a claim hold; goods at sea owned but not available (in a transit warehouse, never in `stock_position.available`). | `ap05-shipment` (A13 / A14 · container by container; A15 · goods at sea); `tests/e2e/payables.spec.ts` (Stage 5) |
| A16–A19 | The remaining import criteria A10, A14–A16 of REQ-APP-001 (PD lifecycle; the loan example; landed cost lock; automatic Cleared and re-open). | `ap04-customs-pd` (PD lifecycle, A10 of REQ-APP-001); `imp05-*`…`imp07-*` for the rest |
| A20 | Applied / Paid / Remaining of the 58 migrated imports match the sheet (USD 35,309,347.81 invoiced; 15,617,285.40 paid; 23,872,694.40 applied); the dry run changes nothing and lists unmatched suppliers / PDs, verify-SWIFT rows and legacy-cleared differences. | `ap08-migration` |
| A21 | Workbench at 10,000 payables / 200,000 events < 1 s; payable page < 1.5 s. | `tests/load/payables.js` |
| A22 | Every new route is in `domain/menu.ts` and `DELIVERED`, translated in `en` and `ar`, passes the theme-readability e2e at mobile RTL width. | `tests/e2e/payables.spec.ts` |
| A23 | D13 — a purchase invoice ticked *Import* opens the import application behind it in the same transaction (keyed by the supplier's number, the invoice's lines, a submitted PO, `PAYABLE_OPENED` / `PO_LINKED` / `TERMS_SET`); an unticked invoice opens nothing; the database refuses an import invoice without its application. | `ap02-expenses-and-import-invoice` |
| A24 | D12 — *Add expense* raises a non-PO invoice whose §15 evidence is the type of fee (no second approver at entry, the CEO posts it); a non-PO invoice with no type of fee is still refused; *Mark paid* posts and allocates the payment (officer refused, paying twice refused); Unpaid / Overdue / Paid read correctly; a note is dated, signed and never edited; a contract raises one purchase invoice per period. | `ap02-expenses-and-import-invoice`, `ap02-recurring-contract` |

## 27. Out of scope (this release)

* Payroll and salaries (the `hr_payroll` section; a payroll run may later
  create a payable of type `service` with category *payroll* — the type system
  allows it).
* Petty-cash expense claims beyond what the existing cash-advance module does.
* Withholding tax on supplier payments (the payment application has a
  `deductions` extension point; rules and rates are a later requirement).
* An automatic alerts dashboard; the accountant's report as a document (saved
  views and the printable status log replace it).
* Pre-sale / pre-sold quantities.
* Letters of credit; Sinosure claims; direct bank or ASYCUDA integrations
  (they arrive as import definitions later).
* Changes to GL, AR or inventory posting rules beyond the mappings named in
  §15.7 and §20.2.

## 28. Decisions (2026-10-01)

| # | Question | Decision |
|---|---|---|
| D1 | Roles | Create `logistics_officer` and `customs_officer`; `accounting_officer` holds both until users are assigned. Department users confirm service receipts through the existing department routing. |
| D2 | Who completes an automatic hold | The reason code's default role for that lane (payment → accounting officer; shipment → logistics; PD → customs; service / recurring → the owning department's manager). `accounting_manager` may complete any. |
| D3 | USD from an IQD account | Refused; a payment application must name an account in the payable's currency. |
| D4 | Time-limit seeds | Examples only, editable from day one: SWIFT pending 14, local transfer pending 3, PD not validated 7, PD expiry warning 45, partly received 30, at port 10, invoice unfunded 7, recurring overdue 0 (day after due), service unconfirmed 10 days. |
| D5 | Loan commission | Capitalised into the landed cost of the imports the loan funded; "expense when paid" remains an available treatment. |
| D6 | Accepting a short delivery as final | `accounting_manager`. |
| D7 | Module name and scope | *Purchasing* becomes **Payables** and covers every payable type (import, service & expense, recurring contract, local goods, advance); `finance_ap` merges into it. The import application keeps its name as a type. |
| D8 | Rent evidence | A lease with `auto_confirm` is its own receipt evidence; no service receipt is required per period. Metered utilities require the department's confirmation of the bill. |
| D9 | PO from a PI (Stage 1 build, 2026-10-01) | The PO is created and *submitted* in the payable's transaction; approval is a second person's act (maker-checker). |
| D10 | Escalation clock (Stage 1 build) | Counts from the hold's `opened_at`, not from the breach date. |
| D11 | Order lines | No DELETE on `payable_order_line`; a changed PI line supersedes the old one and writes `FIELD_CHANGED` (follow-up to Stage 1). |
| D12 | Two experiences, one table (2026-10-01, after the first look at the workbench) | Imports get the full tracking UI; every other type gets the simple *Add expense* dialog and *Unpaid / Paid / Overdue* with a note. The stop machinery with reason codes is drawn for imports only. Every screen uses `SectionTabs`; no screen draws its own navigation. |
| D13 | Where an import is born (2026-10-01) | At the purchase invoice: the accountant enters the supplier's PDF as a purchase invoice ticked *Import*; the application is created behind it automatically, keyed by the invoice number; the PO is created silently for the ERP's controls. No separate form. Expenses (rent, forwarders, brokers, utilities) are ordinary purchase invoices with *Mark paid* and Unpaid/Paid/Overdue — not payables. |
| D14 | What confirms a payment (Stage 3 build) | The payment method keeps its name and rail; a new `confirmation_kind` (SWIFT copy · transfer reference · cash voucher · cheque number) decides the Confirm dialog's fields, the event (`SWIFT_CONFIRMED` / `TRANSFER_CONFIRMED` / `CASH_PAID` / `CHEQUE_PAID`) and which clock watches it (`swift_pending` or `transfer_pending`). Method codes stay minted (Critical Rule 1); the four §15.3 methods are seeded as `PM-…` rows by name. |
| D15 | The lane guard and the bank's answer (Stage 3 build) | A `PENDING_REASON` hold in the payment lane blocks Create, Approve and Send (§19.1). It does not block Confirm, Reject, Cancel or Record debit: the bank's answer is what resolves a late SWIFT, and refusing to record money that already left would make the books wrong. |
| D16 | A deposit before the invoice posts (Stage 3 build) | Confirm creates the supplier advance through the existing service as the people who acted: requested by the application's maker, approved by its approver, paid by whoever confirms — so the advance's own maker-checker holds and its audit names real people. The approver must therefore hold `approve` on supplier advances (accounting manager). |
| D17 | Which IQD figure (Stage 3 build) | Converted at the accounting rate when drafted, again on the application date at Send (that is what is reserved), and again on the confirmation date at Confirm (that is what is posted). Applied / Paid / Remaining are kept in the transaction currency; IQD totals use each row's own rate. |
| D18 | The PD check before Stage 4 (Stage 3 build) | Until the PD register exists, check 1 answers *warning* ("confirm the PD is validated before the bank pays") rather than refusing; Stage 4 replaces it with the real check. The B/L triggers likewise warn until Stage 5. |
| D19 | Reservations across branches (Stage 3 build) | An account is a company master, so its Reserved figure counts every branch's applications (a `SECURITY DEFINER` sum), never only those the reader's branch scope can see. |
| D20 | The PD's expiry (Stage 4 build) | The day after a validated (or partly written-off) PD's expiry the sweep moves it to its expired status itself (history source *Expiry (automatic)*), and a `pd_expired` check (limit 0) stops the import with a `PENDING_REASON` hold in the PD lane until it is re-registered. A rejected PD that is not re-registered stops it the same way. A PD that expires before it was ever validated has no expired status to move to; the sweep writes `PD_EXPIRED` once instead. |
| D21 | The PD and the paying bank (Stage 4 build) | When both the PD and the paying account name a bank, they must be the same bank (check 1, overridable by a manager with a reason). A PD or an account with no bank recorded does not fail on the bank. The PD the bank paid against is stored on the application at Send. |
| D22 | The ASYCUDA list (Stage 4 build) | Pasted, never uploaded as a file in this build: the page reads it line by line (number, status as ASYCUDA spells it, optional date), shows the difference — will be updated / already so / no such PD / final / not read — and applies only after the person presses *Apply*. Final PDs are not changed by a list; they are re-registered. |
| D23 | Where an import's goods wait (Stage 5 build) | An import invoice receives its stock lines into the branch's *In Process* warehouse, a transit warehouse: owned and valued, never available to sell (A15). The warehouse the accountant chose on the line becomes the import's destination (the PO lines, the payable's default warehouse). The legacy four-stage shipment is not opened for an import; containers replace it. The staging warehouses are transit warehouses from migration 0234 on, and the report pickers (Stock Ledger, Stock Movement, FIFO Valuation) list every active warehouse so stock in transit can still be read. |
| D24 | The container receipt (Stage 5 build) | A container is received by its own document, `container_receipt` (`CREC-{BRANCH}-{YYYY}-{SERIAL}`), whose id is the form's one-time `document_id`: a repeat answers with the first receipt. It moves the counted quantity out of transit into the chosen warehouse of the same branch through `inventory.relocate` (`transfer_issue` / `transfer_receipt` on the invoice line's own FIFO layers, no journal — the value was posted with the invoice). It is refused before the invoice is posted, into another branch, or into a transit warehouse. Receipt and lines are append-only, and the document is in `resetTestData`, `format-live-database.sh` and the integrity checks. |
| D25 | Short and damaged (Stage 5 build) | Anything not received whole makes the container *Missing / damaged* (it counts as arrived for "X of Y"), needs a reason, writes `QUANTITY_VARIANCE` and opens a `receipt_variance` hold in the warehouse lane for the claim. The short or damaged quantity stays in transit until the claim decides it; "accept short delivery as final" (D6) is left for the landed-cost stage. |
| D26 | Deferred from Stage 5 | The §24.4 migration of `supplier_shipment` rows and the `/inventory/in-transit` redirect move to Stage 8 (migration); the container-status, port and PD-status settings tabs are seeded rows editable in the database until then. Status names are master data held in English; Arabic reads the translation of the seeded code and falls back to the stored name. |

---

## Review checklist

- [ ] Every box of `QS_ERP_Workflow_Final.pdf` appears in Part D–F with a stored state or a derived value.
- [ ] Every payable type in §5.3 has a stage rail in §6, lanes in §5.3, and a flow in Part C.
- [ ] Office rent, utilities, forwarder and broker fees each have a worked path from request to closed (§9, §10, §20.2).
- [ ] Every dashed arrow of the diagram is a named check with its override rule.
- [ ] No day number is stated as a rule — all are seeds (R4).
- [ ] No table under a payable can be updated in place or deleted where the diagram says "recorded" (R3).
- [ ] Every screen in §21 names its route, columns, actions and permission object; every old `/purchasing/*` route has a redirect.
- [ ] Every acceptance criterion names a test file.
- [ ] `AGENTS.md` rules are honoured: additive migrations, ledger tables in both reset lists, form idempotency, warehouse-branch rule, audit timestamps as ISO strings.
