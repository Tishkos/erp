# Phase 10 — Logistics Operations

> **Blueprint:** §11, Appendix B, Appendix C, Appendix D
> **Release (§27):** 6 — Money Transfer and Logistics
> **Depends on:** 07, 09
> **Blocks:** —

---

## Purpose

§11: Logistics is a **separate revenue service** managing customer import and shipping service jobs, direct third-party expenses and the separate logistics margin. A logistics job can be linked to the same client import file as a Money Transfer transaction *without combining their accounting results*.

## In scope

Client import files, service jobs, routes and legs, carriers, shipping and customs documents, client charges, third-party costs, client deposits, job settlement, proof of delivery, claims and exceptions, customer billing, reports.

---

## Sub-phases

### 10.1 Client import files

**Build**
- Client import file as the shared reference linking a logistics job and, where applicable, a money transfer case
- Cross-reference visible from both sides **without** merging their accounting

**Blueprint rules enforced**
- §11 — *"A logistics job can be linked to the same client import file as a Money Transfer transaction without combining their accounting results"*
- §12.2 — *"Related Client Import File and Logistics Job where the approved process requires it"*

**Test gate**
- [x] One import file links a logistics job and a transfer case — `client_import_file_reference` is module-agnostic; the test registers the transfer side exactly as Phase 09 will
- [x] The two remain fully separate in revenue, expense and margin reporting — enforced by omission: the reference table has **no amount, currency, debit, credit or margin column**, asserted against `information_schema`
- [x] The Money Transfer and Logistics Cross-Reference report (§11.5) shows both without netting them — `crossReference` returns one `figures` object per module and the return type has no combined field

---

### 10.2 Logistics jobs

**Build** — workflow per §11.2:
> Client Request → Logistics Job → Service Charge / Client Funding → Carrier and Third-Party Execution → Cost Recording → Delivery Evidence → Client Settlement / Billing → Job Close

**Blueprint rules enforced**
- Appendix B, Logistics Job statuses: Draft, Approved, In Progress, Delivered, Settled, Closed, Cancelled; effect: **Job cost and service revenue**

**Test gate**
- [x] The job progresses through every status in the defined order and rejects skips — `document_status_transition` rows, `assertJobTransition` in the domain, and the `logistics_job_status_follows_order` trigger; tested at the service *and* by a direct `update` that bypasses it
- [x] A job cannot close with unsettled costs or unbilled charges — the `logistics_job_zz_close_is_clean` trigger checks five positions; `closeBlockers` computes the same five so the refusal can list them all
- [x] Job cost and service revenue are both attributable to the job — `logistics_job_cost.job_id` and `logistics_job_settlement.job_id` are both NOT NULL

**Note.** Appendix B gives this document no *Pending Approval* state, unlike
Purchase Order and Goods Receipt. That absence is honoured rather than filled in:
approval is §5.2's `approve` verb exercised on a draft, and separation of duties
is enforced by refusing the raiser's own approval.

---

### 10.3 Routes, legs and carriers

**Build** — route and leg structure, carrier master, carrier payables tracking

**Test gate**
- [x] A job supports multiple legs with distinct carriers — `logistics_job_leg` keyed `(job_id, leg_no)`, each leg naming its own carrier
- [x] Carrier payables reconcile to the A/P subledger — by construction, not by agreement: a cost credits the `supplier_payable` role carrying the carrier's Business Partner, and Phase 02's subledger writes itself from that journal line. Tested by comparing the report against `subledger_entry`
- [x] Carrier performance data is captured for the required report — planned vs actual arrival per leg; `carrierPerformance` scores only legs with both, and compares ISO date strings rather than `Date`

---

### 10.4 Client charges and funding

**Build**
- Logistics charges paid by the client added to the client account **from the Logistics module**
- Posts: Dr Bank, Cash or Client Account / Cr Client Logistics Clearing or Deferred Service Balance, according to document stage

**Blueprint rules enforced**
- §11.3 — *"Logistics charges paid by the client are added to the client account from the Logistics module"*
- §11.4 — the accounting event table

**Test gate**
- [x] Client funding posts to Client Logistics Clearing, distinct from the Money Transfer Client Clearing account — resolved through §3.3's mapping on a `logistics.*` event that no transfer event shares; every line also carries `business_line = LOGISTICS`, so the G/L separates the two services as well as the module does
- [x] The account selected depends on document stage, per §11.4 — `logistics_funding_stage_role` maps stage → line role; tested with two jobs at two stages landing in two different accounts. **The mapping ships empty and funding refuses to post until Finance fills it in — see Q10-1.**
- [x] Client logistics balances are reported separately from money transfer client balances — `clientBalances` reads only logistics tables and has no parameter that could widen it

---

### 10.5 Third-party costs

**Build**
- Direct logistics expenses allocated to the job
- Posts: Dr Logistics Job Cost / Cr Bank or Supplier A/P

**Blueprint rules enforced**
- §11.3 — *"The company does not absorb logistics costs; direct logistics expenses are allocated to the job and deducted from the logistics service charge to determine job margin"*
- Appendix C — Logistics direct cost: *"Job link mandatory"*

**Test gate**
- [x] A logistics cost without a job link cannot be posted — stronger than that: it cannot be *represented*. `job_id` is NOT NULL, so there is no state of the table in which an unallocated logistics cost exists. Tested by a direct insert and by asserting `is_nullable = 'NO'`
- [x] Job margin = service charge − allocated direct costs, verified against a hand-worked example — 1,500,000 charged − 850,000 cost = 650,000, checked in both the unit and integration suites
- [x] No logistics cost lands in a general overhead account — one debit role, `logistics_job_cost`, and no code path emits any other. Tested by exhaustion: every debit line ever produced by the logistics module resolves to the one mapped account
- [x] Costs flow correctly whether paid by bank or accrued to Supplier A/P — a CHECK makes exactly one counterparty representable per settlement mode; both paths posted and asserted

---

### 10.6 Goods handling — no company inventory

**Build** — enforcement of the §11.3 boundary

**Blueprint rules enforced**
- §11.3 — *"Goods imported for a client do not enter company warehouses"*
- §11.3 — *"Goods remain in a financial intermediary account, Client Inventory, until delivery to the client"*
- §11.3 — *"No Sales Invoice is issued for the goods because the company is providing a service rather than selling the goods"*

**Test gate**
- [x] A logistics job creates zero company inventory quantity in every Phase 04 availability bucket — a full job lifecycle leaves `inventory_movement`, `cost_layer` and `stock_reservation` empty. The reason it will stay true: **no table in Phase 10 has an item, quantity, UOM or warehouse column**, asserted against `information_schema` and against the source in `tests/unit/phase10-no-company-inventory.test.ts`
- [x] No Sales Invoice can be raised for the goods on a logistics job — *partially*. Phase 06 does not exist, so there is no Sales Invoice to refuse. What is enforced now is that Phase 10 cannot reach for one: no logistics module imports or names any sales/A-R symbol, asserted structurally. **Re-check when Phase 06 lands** — the remaining half is that Phase 06 must refuse a logistics job as an invoice source
- [ ] The Client Inventory balance is shared correctly with the Phase 09.10 model and clears on delivery — **waiting on Phase 09.** Client Inventory is the Money Transfer side of §12.4 (*Dr Client Inventory / Cr Company Bank* on payment, *Dr Client Account / Cr Client Inventory* on delivery); Phase 10 holds no Client Inventory balance of its own and must not invent one. Testable as soon as 09.10 exists

---

### 10.7 Delivery evidence and claims

**Build** — proof of delivery, claims and exceptions register

**Test gate**
- [x] Proof of delivery attaches through the Phase 01 attachment service — `logistics_delivery_evidence` points at `attachment` and stores no bytes; a trigger requires the attachment to be held against *this* job and to have cleared the §21 malware scan
- [x] A job cannot settle without the delivery evidence its type requires — required set is configuration on the service type; checked in the service with a named message and again by the `logistics_settlement_job_is_deliverable` trigger, tested by a direct insert
- [x] Claims link to the job and are reported as delivery exceptions — `logistics_claim.job_id` NOT NULL, leg-belongs-to-job enforced by trigger, surfaced by `deliveryExceptions`. **A claim posts nothing** — Appendix C has no row for one; see Q10-4

---

### 10.8 Job settlement, billing and close

**Build**
- Client settlement and billing
- Service completion recognition: Dr Client Logistics Clearing or Client A/R / Cr Logistics Revenue
- Job close

**Blueprint rules enforced**
- §11.4 — the recognition row
- Appendix C — Logistics service recognition: *"Separate from Money Transfer margin"*

**Test gate**
- [x] Revenue recognises on service completion per the configured mapping, not on funding — tested by funding a job in full and asserting the revenue account is still nil, then settling and asserting it is not
- [x] Logistics revenue posts to a logistics revenue account distinct from any money transfer account — single `logistics_revenue` line role on a `logistics.*` event, plus `business_line = LOGISTICS` on every line
- [x] A job cannot close with an open client balance or unrecorded cost — the close trigger checks unbilled charges, draft costs, funded-minus-recognised, open legs and open claims
- [x] Job margin reconciles to the G/L — `marginFor` and a direct sum over `journal_line` are computed from different places and asserted equal; the Gross Margin report agrees with both

**Q10-2** records the clearing-versus-receivable split at recognition: funded
first, because a liability clearing account debited past what was funded stops
meaning what it says. Where a job was funded at two stages mapping to different
clearing roles, each role is debited for what it actually received, oldest first.

---

### 10.9 Logistics reports

**Build** — per §11.5 and Appendix D: Open Jobs; Client Import File Status; Job Revenue; Direct Cost; Gross Margin; Carrier Payables; Client Balances; Delivery Exceptions; Job Documents; Money Transfer and Logistics Cross-Reference. Filters: client, job, carrier, route, date.

**Test gate**
- [x] Job margin in reports equals the G/L result for the same jobs — no report reads a stored total; every figure is recomputed from the documents, so there is only one number to disagree with
- [x] The cross-reference report shows transfer and logistics figures side by side without combining them — one `figures` object per module, no combined field on the return type, and no amount column on the table it reads
- [x] Carrier payables tie to A/P — report and `subledger_entry` compared directly
- [x] All reports respect data scope — no report filters by branch by hand; every table carries RLS, and a Basra user is shown to see nothing of a Baghdad job through the service *and* through the raw `erp_app` connection

All ten §11.5 reports are built: Open Jobs, Client Import File Status, Job
Revenue, Direct Cost, Gross Margin, Carrier Payables, Client Balances, Delivery
Exceptions, Job Documents, Cross-Reference — plus Carrier Performance for 10.3.
Appendix D's five filters (client, job, carrier, route, date) are one predicate,
tested including the negative cases.

---

## Phase exit gate

§27 Release 6 acceptance (shared with Phase 09): *"Client balances, bank ledger, service margin and G/L reconcile."*

| # | Criterion | Evidence |
|---|---|---|
| 1 | Logistics revenue, cost and margin are separate from Money Transfer in every report and every account | 10.4, 10.8, 10.9 gates |
| 2 | Every logistics cost is job-linked; none is absorbed as overhead | 10.5 gate |
| 3 | No company inventory quantity and no Sales Invoice arises from a logistics job | 10.6 gate |
| 4 | Job margin reconciles to the G/L | 10.8 gate |
| 5 | A job cannot close with unsettled costs, unbilled charges or missing delivery evidence | 10.2, 10.7, 10.8 gates |

**End-to-end scenario (§26 critical UAT list):**
> Logistics job → vendor costs → customer charge → proof of delivery → invoice and profitability

**Sign-off:** Logistics and Finance.

---

## Build status — 2026-08-17

| Criterion | State |
|---|---|
| 1 · Logistics separate from Money Transfer in every report and account | ✅ Structural — the shared table holds no money |
| 2 · Every logistics cost job-linked, none absorbed as overhead | ✅ NOT NULL column, single line role |
| 3 · No company inventory quantity and no Sales Invoice from a logistics job | ✅ inventory · ⚠️ Sales Invoice half-testable until Phase 06 |
| 4 · Job margin reconciles to the G/L | ✅ |
| 5 · No close with unsettled costs, unbilled charges or missing evidence | ✅ |

**Tests:** 98 — 39 unit (`tests/unit/logistics.test.ts`,
`tests/unit/phase10-no-company-inventory.test.ts`), 59 integration
(`tests/integration/phase10-logistics.test.ts`). All green.

**Migrations:** 0140–0146, `when` 1790000000000 step 1000000.

**Held:** one gate (10.6, Client Inventory) waits on Phase 09.10; half of one
(10.6, Sales Invoice) waits on Phase 06. Client funding cannot post in production
until Q10-1 is answered — see `docs/open-questions-phase-10.md`.

**Depends on 07 (Treasury) and 09 (Money Transfer), neither of which exists.**
Phase 10 was built without either. Bank and cash movements go through the Phase
02 posting engine directly against `bank_cash_account`; when Phase 07 lands, the
`bank` and `cash` line roles are where its treasury documents plug in.

---

## Notes for the team

The separation between Logistics and Money Transfer is stated three times in the blueprint (§2.2, §11.3, §12.4) and reinforced in Appendix C. It exists because the two services have different economics and, for Money Transfer, different regulatory exposure. A shared client import file is a *reference*, not a merge. Model the link as a cross-reference, and keep every account, every clearing balance and every margin calculation distinct.
