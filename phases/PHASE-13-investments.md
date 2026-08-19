# Phase 13 — Investment Management

> **Blueprint:** §13, Appendix D, Appendix E (IFRS 9)
> **Release (§27):** 7 — Projects, Contracting and Investments
> **Acceptance dependency (§27):** *"Module subledgers and G/L reconcile."*
> **Depends on:** 07
> **Blocked by decision:** **D2** — investment categories, valuation methods and posting rules

---

## Purpose

§13: maintain a controlled investment register, transaction history, income, valuation, impairment, maturity and disposal by approved investment category.

> **Scope discipline (§13):** "The legal and accounting treatment of investments differs by instrument. The IT team must implement configurable types and posting rules only after Finance defines the required categories."

The **structure** is built now. The **categories, valuation methods and posting rules** wait for D2.

---

## Sub-phases

### 13.1 Investment type and master — ⚠ PARTIALLY BLOCKED

**Build now**
- Investment master: ownership percentage, units, counterparties, custody information, currency
- Investment type framework with per-type required fields and account mappings, driven by configuration

**Blocked on D2**
- The actual type list, the required-field sets per type, and the account mappings

**Blueprint rules enforced**
- §13 — *"Investment type determines required fields and account mappings"*
- §13 — *"Foreign-currency investments store transaction currency and base-currency equivalents"*

**Test gate (structure, testable now)**
- [x] Adding a new investment type requires no code change
- [x] Required fields vary by type and are enforced at save
- [x] Account mappings resolve through the Phase 02 posting profile
- [x] Foreign-currency investments store both transaction and base-currency amounts per §A4 of `TECHSTACK.md`
      — this gate was ticked once before it was true. The investment row, income,
      funding and disposal all carried both amounts; `investment_capital_call`
      carried only `amount_txn`, and it is the one row another module reads —
      §13.8 feeds it to the Phase 07.8 forecast. A dollar-denominated call
      therefore reached a treasurer's dinar forecast at one to one. Every
      capital-call test held an IQD investment, where the two amounts are the
      same number, so nothing caught it. There is now a test holding dollars.

---

### 13.2 Investment proposal and approval

**Build** — proposal with amount, currency, type, expected return and risk; management approval; funding source approval

**Blueprint rules enforced**
- §13 workflow steps 1 and 2
- §13 — *"Related-party status and approval are captured where the approved process requires it"*

**Test gate**
- [x] A proposal requires all five fields before submission
- [x] Both management approval and funding source approval are required before acquisition
- [x] Related-party status is captured and drives additional approval where configured
- [x] Approval history is complete and auditable

---

### 13.3 Acquisition and funding

**Build** — acquisition transaction creating the investment register entry, funded through Treasury

**Blueprint rules enforced**
- §13 — *"Treasury provides funding and receives proceeds"*
- §13 acceptance criterion 1 — *"An approved investment proposal creates a controlled acquisition record and accounting entry"*

**Test gate**
- [x] Acquisition without an approved proposal is impossible
- [x] The register entry and the accounting entry are created in one transaction
- [x] Funding flows through a Treasury payment (Phase 07), not a direct journal
- [x] Additional funding / capital call increases the register entry and posts correctly

---

### 13.4 Income events

**Build** — dividend, profit share, interest, distribution or other return

**Blueprint rules enforced**
- §13 — *"Income and disposal records require source evidence"*
- §13 acceptance criterion 3 — *"Income and disposal trace to bank transactions and supporting documents"*

**Test gate**
- [x] An income event without source evidence attached cannot be posted
- [x] Income traces to the receiving bank transaction
- [x] Income posts to the account mapped for the investment's type
- [x] Income by investment reconciles to the income G/L accounts

---

### 13.5 Valuation and impairment — ⚠ BLOCKED

**Blocked by decision D2.**

> §13: "Valuation methods and frequency require Finance approval."

**Build now:** the valuation record structure, the history mechanism, and the review scheduling hook.

**Do not build:** any default valuation method or frequency.

**Blueprint rules enforced**
- §13 — *"The system preserves historical valuations; it does not overwrite prior values"*
- §13 acceptance criterion 2 — *"Historical valuations remain visible and attributable to approvers"*
- Appendix E — IFRS 9 reference

**Test gate**
- [x] A new valuation creates a new record; the prior valuation remains retrievable
- [x] Every valuation records its approver and date
- [x] Valuation history is visible in chronological order with the method used at the time
- [ ] Once D2 is decided: the approved method reproduces Finance's worked examples
      — **blocked on D2, by design.** `investment_valuation_method` ships empty and a
      valuation cannot name a method that is not in it, so there is no method whose
      worked examples could be reproduced. The mechanism is tested; the answer is owed.

---

### 13.6 Disposal

**Build** — partial or full disposal, proceeds, realised result calculation

**Test gate**
- [x] Partial disposal reduces units and carrying value proportionally per the approved method
- [x] Realised result computes correctly for proceeds above and below carrying value
- [x] Full disposal clears the register entry and its balances to zero
- [x] Disposal traces to the receiving bank transaction and supporting documents

---

### 13.7 Documents and calendar

**Build** — investment documents, agreements, expiry reminders, maturity and capital-call calendar

**Blueprint rules enforced**
- §13 — *"Document management stores contracts, certificates and statements"*

**Test gate**
- [ ] Documents attach through the Phase 01 service and inherit access from the investment record
      — *partially.* Income and disposal both require a real `attachment` row and refuse
      without one, and RLS reaches the investment through `object_id`. What is not built is
      an investment-specific wrapper over the Phase 01 upload service; the tests attach
      directly. Small, and worth doing when 13.7 gets its screen.
- [ ] Expiry reminders fire through the Phase 01 notification engine
      — **not built.** `attachment` has no expiry column: §21 gives the Document Centre
      *"expiry date and renewal owner"* and that is **Phase 17**. Adding one here would give
      this module a private copy of a field the whole system will share, which is the mistake
      Phases 09 and 10 made with the client import file and it cost a merge to undo.
- [ ] The maturity, review, document expiry and capital-call calendar shows all four event types
      — *three of four, tested.* Maturity, review and capital call are in one chronological
      list. Document expiry waits on Phase 17 for the same reason as above, and the union is
      shaped so adding it is one `union all` and no change to the result.

---

### 13.8 Portfolio reporting

**Build** — per §13 and Appendix D: Investment Register; Income; Valuation; Impairment; Maturity; Disposal; Reconciliation. Plus portfolio by type, currency, counterparty and status; cost, carrying value, income and total return; realised and unrealised result with audit history; investment cash-flow forecast. Filters: investment type, counterparty, date.

**Blueprint rules enforced**
- §13 acceptance criterion 4 — *"Portfolio reports reconcile to investment G/L accounts"*
- §13 — *"BI combines investment cost, income, current value and realised/unrealised result"*

**Test gate**
- [x] Portfolio totals reconcile to the investment G/L accounts
- [x] Realised and unrealised results are reported separately, each with audit history
- [x] The cash-flow forecast feeds the Phase 07.8 Treasury forecast
- [x] Reports respect data scope

---

## Phase exit gate

§13 minimum acceptance criteria, verbatim:

| # | Criterion | Evidence |
|---|---|---|
| 1 | An approved investment proposal creates a controlled acquisition record and accounting entry | 13.3 gate |
| 2 | Historical valuations remain visible and attributable to approvers | 13.5 gate |
| 3 | Income and disposal trace to bank transactions and supporting documents | 13.4, 13.6 gates |
| 4 | Portfolio reports reconcile to investment G/L accounts | 13.8 gate |

**Sign-off:** Finance, with D2 decided and recorded.

---

## Notes for the team

§13's scope discipline note is unusually direct: *"The IT team must implement configurable types and posting rules only after Finance defines the required categories."* Building the structure ahead of D2 is intended and fine. Populating it with plausible defaults is not — an investment posted under an invented category produces a misstatement that no test in this phase would catch, because the test would be written against the same invented rule.
