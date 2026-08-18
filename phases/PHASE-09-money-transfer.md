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
- [ ] A client account uses the central Business Partner record, not a module-local copy
- [ ] KYC documents attach through the Phase 01 attachment service with correct classification
- [ ] A transfer cannot be initiated for a client whose KYC is incomplete
- [ ] KYC records are visible from both the partner record and the transfer case

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
- [ ] Multiple partial deposits accumulate against one client account
- [ ] Each deposit posts Dr Bank / Cr Client Clearing atomically
- [ ] The client clearing balance equals the sum of deposits less usage at all times
- [ ] The account cannot be closed while the client has not confirmed funding complete
- [ ] Client Clearing subledger reconciles to its G/L control account

---

### 09.3 Exchange rate reference

**Build**
- Official exchange rate and client exchange rate held per transaction (§12.2)
- Rates sourced from the Phase 02 rate engine, not entered locally

**Blueprint rules enforced**
- §12.2 — *"Official exchange rate and client exchange rate"* are required transaction data
- §14.3 — rates are maintained only in the Finance Exchange Rate section

**Test gate**
- [ ] Both rates are captured on the transaction and stored historically
- [ ] Rates cannot be edited on the transfer document itself
- [ ] Gross Exchange Spread computes from the two rates and is reproducible

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
- [ ] Every one of the eight data elements is captured and mandatory where the process requires it
- [ ] The requested USD equivalent is stored for reference and does not become the ledger amount
- [ ] The IQD transfer amount is the ledger amount (§1.1: IQD is the primary ledger currency)

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
- [ ] Rates and details are editable before initiation
- [ ] After initiation, **every** field is locked — verified via UI, API and import
- [ ] Correction is only possible through full reversal plus a new transaction; no partial edit path exists
- [ ] The reversal and the original remain permanently linked

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
- [ ] A batch containing a client transfer and a company import payment keeps both lines' accounting fully separate
- [ ] Each line retains its own client/vendor, branch, cost centre and margin
- [ ] Batch total equals the sum of lines exactly, to the last unit of currency
- [ ] The batch matches to **one** bank statement line in the Phase 07.7 workspace
- [ ] Reversing one line does not corrupt the others
- [ ] A batch cannot be executed while its total does not equal the sum of its lines

*This is the single most bespoke mechanism in the blueprint. There is no off-the-shelf equivalent. Budget accordingly.*

---

### 09.7 Bank fees and direct expenses

**Build** — Dr Bank Fees / Money Transfer Direct Expense, Cr Company Bank Account (§12.4)

**Blueprint rules enforced**
- Appendix C — *"Linked to transfer"*

**Test gate**
- [ ] Every fee links to a specific transfer
- [ ] Fees reduce Net Service Margin and are visible separately from Gross Exchange Spread
- [ ] An unlinked fee cannot be posted to the Money Transfer expense account

---

### 09.8 Margin calculation

**Build** — the system calculates, per §12.4: Total Client Deposits, Transfer Principal, Gross Exchange Spread, Direct Expenses, Net Service Margin, Remaining Client Balance

**Blueprint rules enforced**
- §12.4 — *"Account names are configured through Accounting Mapping; they are not hard-coded"*
- §22 KPI dictionary — Transfer margin: *"Approved client rate economics less actual transfer cost, fees and recognised FX effects according to finance policy"*

**Test gate**
- [ ] All six figures compute correctly against a hand-worked example
- [ ] Remaining Client Balance equals deposits less transfer principal less expenses charged to the client
- [ ] No account name or code is hardcoded — changing the mapping changes the posting with no code change
- [ ] Margin drills to client → case → deposit → settlement → journal (§22 KPI drill-down)

---

### 09.9 Returned transfers and refunds

**Build** — lifecycle per §12.6: Initiated → Sent → Returned → Refunded
- The client receives a **full refund**
- The company **absorbs all bank charges**
- The system reverses the transfer and the recognised service result
- Original and reversing entries remain permanently linked

**Test gate**
- [ ] The refund to the client is the full amount, with no deduction of bank charges
- [ ] Bank charges remain as company expense after the refund
- [ ] The recognised service result is reversed, not left standing
- [ ] Original and reversing entries link permanently and both become read-only
- [ ] The client's clearing balance returns to its pre-transfer position exactly

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
- [ ] A client-funded import creates **zero** company inventory quantity — verified in every Phase 04 availability bucket
- [ ] No Sales Invoice can be created for client-funded goods by any path
- [ ] Client Inventory is a financial balance only, with no quantity ledger
- [ ] Client Inventory reconciles to its G/L account and clears to zero on delivery settlement
- [ ] The client-funded import is visibly separate from the standard transfer model in reporting

*Client Inventory is a financial intermediary account, not a warehouse. Do not model it as one — routing it through the Phase 04 inventory ledger would create company inventory quantities that §11.3 and §12.4 both prohibit.*

---

### 09.11 Client statements, reports and reconciliation

**Build** — the §12.7 report set: Client Deposit Ledger; Open Client Balances; Transfer Register; Bank Execution Batch Reconciliation; Gross Spread; Direct Expenses; Net Margin; Returned Transfers; Refunds; Client Import Cross-Reference; Transfer-to-Bank Statement Reconciliation.

**Test gate**
- [ ] Every transfer and refund reconciles to client subledger, bank ledger and General Ledger (§12.7 acceptance criterion 1)
- [ ] Client Import Cross-Reference links transfers to their Logistics jobs (completed in Phase 10)
- [ ] Transfer-to-Bank Statement Reconciliation ties every transfer to a statement line
- [ ] Reports respect data scope and distinguish posted from provisional data

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
