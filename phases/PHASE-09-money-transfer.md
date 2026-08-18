# Phase 09 — Money Transfer Service

> **Blueprint:** §12, Appendix B, Appendix C, Appendix D, Appendix E (FATF reference)
> **Release (§27):** 6 — Money Transfer and Logistics
> **Acceptance dependency (§27):** *"Client balances, bank ledger, service margin and G/L reconcile."*
> **Depends on:** 07
> **Blocks:** 10
> **Go-live gate:** requires legal/compliance approval — decision **D9**

---

## Purpose

§12: the client deposits IQD into a company bank account; the company initiates an IQD bank transfer based on a client-requested USD equivalent and approved exchange rates; the remaining client balance after transfer and direct expenses is the service result.

This is the highest-risk module in the blueprint. It is a regulated service (Appendix E cites FATF MVTS guidance), it holds client money, and §26's go-live gate 5 requires legal/compliance approval specifically for it.

## In scope

Client accounts, deposits, exchange rate reference, transfer instructions and initiation, Bank Execution Batch, fees and direct expenses, returned transfers and refunds, client-funded import with Client Inventory, client statements, margin and reconciliation.

---

## Sub-phases

### 09.1 Client accounts and KYC

**Build**
- Client account over the shared Business Partner record
- KYC data and documents linked to the partner (§21: *"KYC/compliance records are linked to the business partner and relevant Money Transfer cases"*)
- Risk-based controls per the FATF MVTS reference in Appendix E

**Test gate**
- [x] A client account uses the central Business Partner record, not a module-local copy
      — *`money_transfer_client_account` has no name, address, email, phone or tax
      identifier column at all, and `partner_id` is NOT NULL; asserted against
      `information_schema`. A trigger also refuses a partner without the customer role.*
- [x] KYC documents attach through the Phase 01 attachment service with correct classification
      — *`attachments.upload` with object type `client_kyc_record`, plus
      `client_kyc_document.required_document_code` (NOT NULL) saying which requirement
      the file answers. The module registers its own parent-access check, so §21's
      policy inheritance applies.*
- [x] A transfer cannot be initiated for a client whose KYC is incomplete
      — *Trigger `money_transfer_kyc_complete_to_initiate` on the move to Initiated:
      an approved, unsuperseded, unexpired record carrying every active required
      document for the client's risk rating. Tested through the service **and** by a
      direct UPDATE as `erp_app`.*
- [x] KYC records are visible from both the partner record and the transfer case
      — *`kycFor` reaches the same record by partner, by client account or by transfer;
      one record, three routes, because §21 links it to the partner.*

---

### 09.2 Client deposits

**Build**
- One or several partial deposits, by cash deposit into the company bank account or by bank transfer
- Client account remains open until the client confirms funding is complete and specifies the transfer amount
- Posts: Dr Company Bank Account / Cr Client Clearing (Client A/P-type account)

**Blueprint rules enforced**
- §12.3 — *"A client can make one or several partial deposits"*
- §12.3 — *"The client account remains open until the client confirms that funding is complete and specifies the amount to transfer"*
- Appendix C — *"Multiple partial deposits allowed"*
- Appendix B, Client Deposit statuses: Draft, Posted, Available, Partially Used, Used, Refunded, Reversed

**Test gate**
- [x] Multiple partial deposits accumulate against one client account
      — *Each deposit is its own numbered document; three of them sum to the account
      balance. Appendix B's Available / Partially Used / Used follow the usage rows.*
- [x] Each deposit posts Dr Bank / Cr Client Clearing atomically
      — *Through the Phase 02 posting engine by line role, inside the caller's
      transaction (§24). Tested by removing the mapping mid-flight: the posting fails
      and the deposit is still a draft with no journal — nothing half-written.*
- [x] The client clearing balance equals the sum of deposits less usage at all times
      — *There is no stored balance. `used_amount_iqd` is recomputed from the live
      usage rows by trigger, and `money_transfer_deposit_not_over_used` refuses
      over-consumption at the database.*
- [x] The account cannot be closed while the client has not confirmed funding complete
      — *CHECK `money_transfer_client_account_close_needs_confirmation`, plus a service
      refusal that also requires the balance to be zero. Tested by direct UPDATE too.*
- [x] Client Clearing subledger reconciles to its G/L control account
      — *`client_clearing` is a `customer` control account, so Phase 02.9 writes the
      subledger from the journal line in the same transaction. `subledger.reconciliation`
      reports a difference of 0.0000.*

---

### 09.3 Exchange rate reference

**Build**
- Official exchange rate and client exchange rate held per transaction (§12.2)
- Rates sourced from the Phase 02 rate engine, not entered locally

**Blueprint rules enforced**
- §12.2 — *"Official exchange rate and client exchange rate"* are required transaction data
- §14.3 — rates are maintained only in the Finance Exchange Rate section

**Test gate**
- [x] Both rates are captured on the transaction and stored historically
      — *Two `exchange_rate` references plus a snapshot of each at scale 8. Phase 02
      already publishes exactly the two kinds §12.2 asks for: `accounting` (official)
      and `client` (§12 money transfer pricing), so Phase 09 adds no rate table.*
- [x] Rates cannot be edited on the transfer document itself
      — *Trigger `money_transfer_rate_snapshot` **overwrites** the snapshot columns
      from the referenced rows on every insert and update, so no value a caller
      supplies survives the statement. It also refuses a market rate where §12.2 asks
      for the official one, a superseded rate, and a rate effective after the transfer
      date.*
- [x] Gross Exchange Spread computes from the two rates and is reproducible
      — *`grossExchangeSpread` in the domain layer: the difference of the two
      conversions of the requested USD, so a reader can redo it from the two amounts
      on the client statement. Unit-tested for zero, negative and 8-dp precision.*

---

### 09.4 Transfer instruction and required data

**Build** — the §12.2 required transaction data set:
- Client Business Partner and client account
- Requested USD equivalent for pricing and reference
- Official and client exchange rate
- Actual IQD deposits and deposit dates
- IQD transfer amount, company bank account, beneficiary, bank reference
- Direct bank charges and other transfer expenses
- Related Client Import File and Logistics Job where required

**Test gate**
- [x] Every one of the eight data elements is captured and mandatory where the process requires it
      — *All present as columns; NOT NULL where the process cannot proceed without them.
      The bank reference is required to reach Sent rather than at creation, because it
      is the bank that supplies it. The import file and logistics job stay optional —
      §12.2's own "where the approved process requires it".*
- [x] The requested USD equivalent is stored for reference and does not become the ledger amount
      — *No posting reads `requested_usd`; asserted against the journal lines.*
- [x] The IQD transfer amount is the ledger amount (§1.1)
      — *`transfer_amount_iqd` is what posts, in IQD, and it is what the journal total
      equals.*

---

### 09.5 Initiate Transfer and the edit lock

**Build**
- Rates and service details editable **while only deposit entries exist**
- After Initiate Transfer creates the transfer entry, **the transaction is locked**
- Correction requires full reversal and a new transaction
- Posts: Dr Client Clearing / Cr Company Bank Account

**Blueprint rules enforced**
- §12.3 — *"Rates and service details remain editable while only deposit entries exist"*
- §12.3 — *"After Initiate Transfer creates the transfer entry, the transaction is locked. Correction requires full reversal and a new transaction"*
- §12.7 acceptance — *"The system prevents editing after Initiate Transfer"*
- Appendix C — *"Locks transaction; reversal required for correction"*
- Appendix B, Money Transfer statuses: Draft, Funded, Initiated, Sent, Completed, Returned, Refunded, Reversed

**Test gate**
- [x] Rates and details are editable before initiation
      — *`amendTransfer` while the transfer is Draft or Funded; refused from Initiated.*
- [x] After initiation, **every** field is locked — verified via API and import
      — *Trigger `money_transfer_locked_after_initiation` compares `to_jsonb(NEW)` with
      `to_jsonb(OLD)` minus the lifecycle keys, so a column added in a later phase is
      locked from the moment it exists. Fourteen columns are driven one at a time by
      direct UPDATE as `erp_app` — the same path the API and the Phase 01 import
      framework take. `bank_reference` is write-once, since the bank supplies it after
      execution.*
      **UI not verified** — Phase 09 builds no screens; there is no UI in this
      repository yet. The lock is enforced below any UI, so a screen cannot open it.
- [x] Correction is only possible through full reversal plus a new transaction; no partial edit path exists
      — *No DELETE grant for `erp_app` on `money_transfer` (asserted), and the only
      edit path refuses. `replaced_by_transfer_id` records the successor.*
- [x] The reversal and the original remain permanently linked
      — *Phase 02's `reverses_id` / `reversed_by_id`, set in both directions and made
      unchangeable by migration 0023. Asserted, including that clearing the link fails.*

---

### 09.6 Bank Execution Batch

**Build**
- One bank debit combining several internally separate transactions — for example a client transfer and a company import payment
- Each source line retains its own document, client/vendor, branch, cost centre, accounting and margin
- Batch total reconciles to the single bank-statement amount

**Blueprint rules enforced**
- §12.5 — verbatim, all three requirements
- §12.7 acceptance — *"Bank Execution Batch lines sum exactly to the bank execution total"*
- Appendix B, Bank Execution Batch statuses: Draft, Approved, Executed, Reconciled, Reversed

**Test gate**
- [x] A batch containing a client transfer and a company import payment keeps both lines' accounting fully separate
      — ***The batch posts nothing.*** §12.5's verb is *retain*, not *create*: each
      source document has already posted its own journal by its own line roles, and
      execution stamps the line with the journal that document produced. Two journals,
      three distinct line roles, asserted.
- [x] Each line retains its own client/vendor, branch, cost centre and margin
      — *All six are columns on the **line**, not the header, and branch, counterparty
      and amount are read from the source document rather than supplied — a trigger
      refuses a line that claims values its document does not have.*
- [x] Batch total equals the sum of lines exactly, to the last unit of currency
      — *`total_iqd` is the **bank's** figure from the bank advice, not a sum this
      system computes, which is what makes the check a control rather than a tautology.*
- [ ] The batch matches to **one** bank statement line in the Phase 07.7 workspace
      — **Waiting on Phase 07 (Treasury).** The bank statement table and the 07.7
      reconciliation workspace do not exist. What is built and tested: the batch
      records a `statement_line_ref`, a partial unique index refuses two live batches
      claiming the same statement line on the same account, and a reconciliation with
      no reference is refused. Phase 07 replaces the text reference with its own
      foreign key; the report's shape does not change.
- [x] Reversing one line does not corrupt the others
      — *True by construction: there is no shared journal to corrupt. Asserted by
      deep-comparing the surviving line before and after, and confirming its journal
      still stands. The batch total stays as the bank recorded it and the difference
      column makes the gap visible rather than hiding it.*
- [x] A batch cannot be executed while its total does not equal the sum of its lines
      — *Trigger `bank_execution_batch_lines_sum_to_total`, tested one ten-thousandth
      of a dinar out, and by direct UPDATE as `erp_app`. An empty batch is refused too.*

*This is the single most bespoke mechanism in the blueprint. There is no off-the-shelf equivalent. Budget accordingly.*

---

### 09.7 Bank fees and direct expenses

**Build** — Dr Bank Fees / Money Transfer Direct Expense, Cr Company Bank Account (§12.4)

**Blueprint rules enforced**
- Appendix C — *"Linked to transfer"*

**Test gate**
- [x] Every fee links to a specific transfer
      — *`money_transfer_expense.money_transfer_id` is NOT NULL. Appendix C's "linked
      to transfer" is the column, not a rule anyone has to remember.*
- [x] Fees reduce Net Service Margin and are visible separately from Gross Exchange Spread
      — *`netServiceMargin = grossExchangeSpread − directExpenses`, with both reported.*
- [x] An unlinked fee cannot be posted to the Money Transfer expense account
      — *There is no unlinked fee to post: a raw INSERT with a null transfer is refused
      by the NOT NULL. `charged_to_client` has **no default**, so nobody's silence
      decides who bears the charge (§12.6 makes that load-bearing).*

---

### 09.8 Margin calculation

**Build** — the system calculates, per §12.4: Total Client Deposits, Transfer Principal, Gross Exchange Spread, Direct Expenses, Net Service Margin, Remaining Client Balance

**Blueprint rules enforced**
- §12.4 — *"Account names are configured through Accounting Mapping; they are not hard-coded"*
- §22 KPI dictionary — Transfer margin: *"Approved client rate economics less actual transfer cost, fees and recognised FX effects according to finance policy"*

**Test gate**
- [x] All six figures compute correctly against a hand-worked example
      — *Deposits 15,000,000; USD 9,000 at official 1,450 and client 1,500; principal
      13,050,000; charge 25,000 absorbed. Spread 450,000, net margin 425,000, remaining
      balance 1,950,000. Worked in the unit test's own comment and asserted end to end.*
- [x] Remaining Client Balance equals deposits less transfer principal less expenses charged to the client
      — *Verbatim, and moved by flipping `charged_to_client` on the same expense.*
- [x] No account name or code is hardcoded — changing the mapping changes the posting with no code change
      — *Every posting is by line role through the Phase 02 engine. Tested by pointing
      `client_clearing` at a different account mid-test: the journal follows the
      mapping. No account code appears in any Phase 09 source file.*
- [x] Margin drills to client → case → deposit → settlement → journal (§22 KPI drill-down)
      — *`drillDown` returns the whole chain per funding deposit, each step carrying
      its journal.*

> **Open question Q9.2** — §12.4 lists Net Service Margin and Remaining Client
> Balance as separate figures, and §12's purpose paragraph reads as though the
> residue *is* the service result. Both formulas are pinned by the gates above and
> both are implemented; what is **not** settled is whether the residue belongs to
> the company or the client. Recognition is therefore an explicit act by Finance,
> bounded by the computed margin, never automatic. See
> `docs/open-questions-phase-09.md`.

---

### 09.9 Returned transfers and refunds

**Build** — lifecycle per §12.6: Initiated → Sent → Returned → Refunded
- The client receives a **full refund**
- The company **absorbs all bank charges**
- The system reverses the transfer and the recognised service result
- Original and reversing entries remain permanently linked

**Test gate**
- [x] The refund to the client is the full amount, with no deduction of bank charges
      — *The amount is **not a parameter**: `refundClient` computes the client's whole
      remaining balance, and trigger `money_transfer_stage_preconditions` recomputes it
      from the deposits and refuses any other figure. A refund net of the 25,000 charge
      is refused by direct UPDATE as well.*
- [x] Bank charges remain as company expense after the refund
      — *The expense postings are untouched by the return — that is what absorbing them
      means. Asserted: still posted, still a debit to the expense account, and the bank
      account ends down by exactly the charge.*
- [x] The recognised service result is reversed, not left standing
      — *A mirror posting by line role, linked as a reversal; the revenue account nets
      to zero.*
- [x] Original and reversing entries link permanently and both become read-only
      — *Both directions set, both entries refuse edits, and the link itself cannot be
      cleared (migration 0023).*
- [x] The client's clearing balance returns to its pre-transfer position exactly
      — *15,000,000 back to 15,000,000 — not 14,975,000. The deposit usage rows are
      reversed and the totals recomputed by trigger, so it is exact rather than close.*

---

### 09.10 Client-funded import and Client Inventory

**Build** — the §12.4 client-funded import model:

| Stage | Debit | Credit |
|---|---|---|
| Client deposit | Company Bank Account | Client Clearing / Client A/P-Type Account |
| Payment for client goods | Client Inventory | Company Bank Account |
| Delivery and financial settlement | Client Account | Client Inventory |

- Client goods **never** enter company warehouses or company inventory quantities
- **No Sales Invoice** is issued for the goods
- Logistics revenue and costs are recorded separately (Phase 10)

**Blueprint rules enforced**
- §12.4 — all three bullets
- §11.3 — *"Goods imported for a client do not enter company warehouses"*; *"Goods remain in a financial intermediary account, Client Inventory, until delivery to the client"*; *"No Sales Invoice is issued for the goods because the company is providing a service rather than selling the goods"*
- Appendix C — Client-funded import payment: *"No company warehouse quantity"*; Client-funded goods delivery settlement: *"No Sales Invoice"*

**Test gate**
- [x] A client-funded import creates **zero** company inventory quantity — verified in every Phase 04 availability bucket
      — *All nine §9.5 buckets read zero for a real stock item in a real warehouse
      after a full client-funded import. Stronger still: `inventory_movement`,
      `cost_layer`, `cost_layer_consumption` and `stock_reservation` are all **empty** —
      not netted to zero, never written.*
- [ ] No Sales Invoice can be created for client-funded goods by any path
      — **Waiting on Phase 06 (Sales).** There is no Sales Invoice in the system yet,
      so this cannot be tested. What is built: the company never owns the goods, no
      company inventory quantity exists to sell, and delivery charges the client's
      account directly rather than recognising revenue (asserted — the service revenue
      account stays at zero through a full import and delivery). **Phase 06 must not
      offer client-funded goods as invoiceable**; there is nothing in Phase 09 for it
      to pick up, which is the intended state.
- [x] Client Inventory is a financial balance only, with no quantity ledger
      — *No table in this module has an item, warehouse or quantity column; asserted
      against `information_schema`. An **event trigger** refuses an `ALTER TABLE` that
      would add one, so the absence stays a guarantee rather than a current fact.*
- [x] Client Inventory reconciles to its G/L account and clears to zero on delivery settlement
      — *The module's balance is derived from the postings, so it agrees with the G/L by
      construction. Trigger `client_import_file_clears_to_zero` refuses to settle or
      close a file carrying a residual balance — tested through the service and by
      direct UPDATE.*
- [x] The client-funded import is visibly separate from the standard transfer model in reporting
      — *`crossReference` links the cases and reports no combined figure: §11.3 and
      §12.4 both keep the two services' results apart.*

*Client Inventory is a financial intermediary account, not a warehouse. Do not model it as one — routing it through the Phase 04 inventory ledger would create company inventory quantities that §11.3 and §12.4 both prohibit.*

---

### 09.11 Client statements, reports and reconciliation

**Build** — the §12.7 report set: Client Deposit Ledger; Open Client Balances; Transfer Register; Bank Execution Batch Reconciliation; Gross Spread; Direct Expenses; Net Margin; Returned Transfers; Refunds; Client Import Cross-Reference; Transfer-to-Bank Statement Reconciliation.

**Test gate**
- [x] Every transfer and refund reconciles to client subledger, bank ledger and General Ledger (§12.7 acceptance criterion 1)
      — *`reports.reconciliation` reads the module's figure, the journal's and the
      subledger's from the rows of each and compares the three — not three summaries of
      one cache. After a return and a full refund the client subledger and the Client
      Clearing G/L account are both at zero and the bank is down by exactly the absorbed
      charge.*
- [x] Client Import Cross-Reference links transfers to their Logistics jobs *(completed in Phase 10)*
      — *The report exists and links client account → import file → transfer →
      `logistics_job_ref`. The reference is text and carries no foreign key because the
      Logistics table is Phase 10's; **Phase 10 adds the constraint**, and the report's
      shape does not change when it does.*
- [ ] Transfer-to-Bank Statement Reconciliation ties every transfer to a statement line
      — **Waiting on Phase 07 (Treasury).** The report is built and tested: it ties a
      transfer through its Bank Execution Batch to a statement reference, and keeps a
      transfer with no batch as a visible gap rather than filtering it out. It cannot
      tie to a *real* statement line until Phase 07.7 provides one.
- [x] Reports respect data scope and distinguish posted from provisional data
      — *Every report reads through RLS, so a manager of another branch with identical
      permissions sees nothing of this branch's — asserted both ways round. Draft
      documents are returned with `isPosted: false` and are excluded from balances.*

---

## Phase exit gate

§27 Release 6 acceptance: *"Client balances, bank ledger, service margin and G/L reconcile."*

§12.7 acceptance criteria, verbatim:

| # | Criterion | Evidence |
|---|---|---|
| 1 | Every transfer and refund reconciles to client subledger, bank ledger and General Ledger | 09.11 gate |
| 2 | The system prevents editing after Initiate Transfer | 09.5 gate |
| 3 | Bank Execution Batch lines sum exactly to the bank execution total | 09.6 gate |

**End-to-end scenario (§26 critical UAT list):**
> Money Transfer client onboarding → KYC approval → deposit → quoted rate → transfer execution → settlement → bank reconciliation → client balance and margin

**Sign-off:** Treasury, Finance, and — before go-live — legal/compliance per §26 gate 5 (decision **D9**).

---

## Notes for the team

**Money Transfer and Logistics are separate services.** §11.3 and §12.4 both insist on it: separate revenue, separate expenses, separate margin, even when both relate to the same client import. A logistics job may be linked to the same client import file as a transfer without combining their accounting results. Do not let a shared client import file become a shared P&L.

**The edit lock is the primary control.** §12.3 and §12.7 both state it. Test it on the API and import paths, not only the UI — a locked form with an open endpoint is not a lock.

---

## Build status — 2026-08-17

**Built.** All eleven sub-phases. 36 unit tests (`tests/unit/money-transfer.test.ts`)
and 91 integration tests across four files:
`phase09-money-transfer.test.ts` (09.1–09.5, 09.7–09.9),
`phase09-bank-execution-batch.test.ts` (09.6),
`phase09-client-import.test.ts` (09.10),
`phase09-reports.test.ts` (09.11).

**Migrations 0120–0125**, applied in this order — each `when` is strictly
increasing and sits above Phase 05's last (`1787005000000`):

| # | File | `when` |
|---|---|---|
| 0120 | `phase09_client_account_kyc` | 1789000000000 |
| 0121 | `phase09_client_deposits` | 1789001000000 |
| 0122 | `phase09_client_import` | 1789002000000 |
| 0123 | `phase09_transfer_instruction` | 1789003000000 |
| 0124 | `phase09_transfer_expenses` | 1789004000000 |
| 0125 | `phase09_bank_execution_batch` | 1789005000000 |

**Three gates left unticked, each waiting on a phase that does not exist:**

| Gate | Waiting on |
|---|---|
| 09.6 — batch matches one statement line in the 07.7 workspace | **Phase 07** — bank statements |
| 09.10 — no Sales Invoice can be created for client-funded goods | **Phase 06** — there is no Sales Invoice yet |
| 09.11 — Transfer-to-Bank Statement Reconciliation ties every transfer to a statement line | **Phase 07** |

**Six open questions** are in `docs/open-questions-phase-09.md`, none blocking.
The one that matters is **Q9.2** — whether a residual client balance is the
company's margin or the client's money. §12.4 lists the two figures separately,
§12's purpose paragraph reads as though they are one, and §22 defers the answer to
finance policy. Until Finance answers, the system reports the margin and holds the
money, which is the direction that is safe to be wrong in.

**Depends on 07** (per the header) but does not use it: Phase 09 posts against the
Phase 03 bank/cash master and the Phase 02 engine, and records a bank statement
*reference* where Phase 07 will later put a link.
