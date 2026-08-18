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
- [ ] One import file links a logistics job and a transfer case
- [ ] The two remain fully separate in revenue, expense and margin reporting
- [ ] The Money Transfer and Logistics Cross-Reference report (§11.5) shows both without netting them

---

### 10.2 Logistics jobs

**Build** — workflow per §11.2:
> Client Request → Logistics Job → Service Charge / Client Funding → Carrier and Third-Party Execution → Cost Recording → Delivery Evidence → Client Settlement / Billing → Job Close

**Blueprint rules enforced**
- Appendix B, Logistics Job statuses: Draft, Approved, In Progress, Delivered, Settled, Closed, Cancelled; effect: **Job cost and service revenue**

**Test gate**
- [ ] The job progresses through every status in the defined order and rejects skips
- [ ] A job cannot close with unsettled costs or unbilled charges
- [ ] Job cost and service revenue are both attributable to the job

---

### 10.3 Routes, legs and carriers

**Build** — route and leg structure, carrier master, carrier payables tracking

**Test gate**
- [ ] A job supports multiple legs with distinct carriers
- [ ] Carrier payables reconcile to the A/P subledger
- [ ] Carrier performance data is captured for the required report

---

### 10.4 Client charges and funding

**Build**
- Logistics charges paid by the client added to the client account **from the Logistics module**
- Posts: Dr Bank, Cash or Client Account / Cr Client Logistics Clearing or Deferred Service Balance, according to document stage

**Blueprint rules enforced**
- §11.3 — *"Logistics charges paid by the client are added to the client account from the Logistics module"*
- §11.4 — the accounting event table

**Test gate**
- [ ] Client funding posts to Client Logistics Clearing, distinct from the Money Transfer Client Clearing account
- [ ] The account selected depends on document stage, per §11.4
- [ ] Client logistics balances are reported separately from money transfer client balances

---

### 10.5 Third-party costs

**Build**
- Direct logistics expenses allocated to the job
- Posts: Dr Logistics Job Cost / Cr Bank or Supplier A/P

**Blueprint rules enforced**
- §11.3 — *"The company does not absorb logistics costs; direct logistics expenses are allocated to the job and deducted from the logistics service charge to determine job margin"*
- Appendix C — Logistics direct cost: *"Job link mandatory"*

**Test gate**
- [ ] A logistics cost without a job link cannot be posted
- [ ] Job margin = service charge − allocated direct costs, verified against a hand-worked example
- [ ] No logistics cost lands in a general overhead account
- [ ] Costs flow correctly whether paid by bank or accrued to Supplier A/P

---

### 10.6 Goods handling — no company inventory

**Build** — enforcement of the §11.3 boundary

**Blueprint rules enforced**
- §11.3 — *"Goods imported for a client do not enter company warehouses"*
- §11.3 — *"Goods remain in a financial intermediary account, Client Inventory, until delivery to the client"*
- §11.3 — *"No Sales Invoice is issued for the goods because the company is providing a service rather than selling the goods"*

**Test gate**
- [ ] A logistics job creates zero company inventory quantity in every Phase 04 availability bucket
- [ ] No Sales Invoice can be raised for the goods on a logistics job
- [ ] The Client Inventory balance is shared correctly with the Phase 09.10 model and clears on delivery

---

### 10.7 Delivery evidence and claims

**Build** — proof of delivery, claims and exceptions register

**Test gate**
- [ ] Proof of delivery attaches through the Phase 01 attachment service
- [ ] A job cannot settle without the delivery evidence its type requires
- [ ] Claims link to the job and are reported as delivery exceptions

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
- [ ] Revenue recognises on service completion per the configured mapping, not on funding
- [ ] Logistics revenue posts to a logistics revenue account distinct from any money transfer account
- [ ] A job cannot close with an open client balance or unrecorded cost
- [ ] Job margin reconciles to the G/L

---

### 10.9 Logistics reports

**Build** — per §11.5 and Appendix D: Open Jobs; Client Import File Status; Job Revenue; Direct Cost; Gross Margin; Carrier Payables; Client Balances; Delivery Exceptions; Job Documents; Money Transfer and Logistics Cross-Reference. Filters: client, job, carrier, route, date.

**Test gate**
- [ ] Job margin in reports equals the G/L result for the same jobs
- [ ] The cross-reference report shows transfer and logistics figures side by side without combining them
- [ ] Carrier payables tie to A/P
- [ ] All reports respect data scope

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

## Notes for the team

The separation between Logistics and Money Transfer is stated three times in the blueprint (§2.2, §11.3, §12.4) and reinforced in Appendix C. It exists because the two services have different economics and, for Money Transfer, different regulatory exposure. A shared client import file is a *reference*, not a merge. Model the link as a cross-reference, and keep every account, every clearing balance and every margin calculation distinct.
