# Phase 07 — Treasury, Bank & Cash

> **Blueprint:** §17, Appendix B, Appendix C, Appendix D
> **Release (§27):** 6 — re-sequenced from Release 8. See correction **C2** in [`../PHASES.md`](../PHASES.md)
> **Depends on:** 05, 06
> **Blocks:** 09, 10, 13, 15, 16

---

## Purpose

§17: Treasury is *"the execution layer for A/P, A/R, payroll, investments, projects and Money Transfer."* It must exist before Money Transfer, because §12.5 requires a Bank Execution Batch reconciling to a single bank-statement amount and §12.7 makes Transfer-to-Bank-Statement reconciliation an acceptance criterion.

## In scope

Bank and cash account operations, payment proposal and batch with maker-checker, receipts, inter-account transfers, petty cash, cheque register, bank statement import, the reconciliation workspace, daily cash position and cash forecast.

## Out of scope

- FX revaluation and period close — Phase 16
- Money Transfer client accounts — Phase 09

---

## Sub-phases

### 07.1 Bank and cash account operations

**Build**
- Operational layer over the Phase 03 bank/cash master
- Currency validation, available-balance validation, approval-limit enforcement
- Cash accounts with custodians, limits and periodic cash counts

**Blueprint rules enforced**
- §17 — *"Bank account currency must match payment currency or use an approved FX conversion transaction"*
- §17 — *"Cash accounts have custodians, limits and periodic cash counts"*

**Test gate**
- [x] A payment in a currency other than the account currency is rejected unless routed through an approved FX conversion — the escape hatch is stated by the caller, never assumed: an automatic conversion would be the system choosing a rate, which §14.3 makes a Finance decision
- [x] A payment exceeding the account's approval limit routes to the higher approver — and an account with **no** limit set routes everything higher, because a limit nobody configured is an unanswered question rather than a licence
- [x] Cash count variances are recorded, approved and posted — a surplus is a variance too; a variance with no explanation cannot be approved; a count that agreed has nothing to approve and posts nothing
- [x] Each bank/cash account's ledger balance equals its mapped G/L account balance — it *is* that balance. There is no cached column anywhere in the schema, so the gate is an identity rather than a reconciliation that might fail

---

### 07.2 Payment proposal and payment batch

**Build**
- Proposal built from due items by due date, priority, discount and available cash
- Payment batch with bank instruction/reference
- Execution confirmation updating source items

**Blueprint rules enforced**
- §15 — *"Include due items in payment proposal based on due date, priority, discount and available cash"*
- §17 — *"Generate payment batch and bank instruction/reference"*
- §15 acceptance criterion 2 — *"Payment proposal includes only eligible approved items"*

**Test gate**
- [x] The proposal excludes unapproved, blocked-supplier and already-paid items — and **says so on the document**: an excluded item is a row with a reason, not an absence. Finance's first question about a payment run is always about something missing from it, and a run that recorded only what it paid could not answer it
- [x] Proposal totals never exceed available cash for the selected account — held by a CHECK on the header and a deferred trigger tying that total to its own lines, so neither the application nor a later migration can quietly loosen it. An approved batch also *commits* its cash, so two runs approved the same morning cannot promise the same money twice
- [x] Execution confirmation updates every source invoice and advance in one transaction — invoices become Phase 05 supplier payments and advances post Dr Supplier Advance / Cr Bank as Appendix C requires. The batch invents no ledger entry of its own; a second way for money to leave the company is a second set of numbers to disagree with
- [x] A failed or returned payment reverts the source items to open and is reported — two different events, kept apart: a line that failed before it was sent never became a payment, and one that was *returned* is undone by a counter-entry through the source document, because §3.2 keeps automatic journals out of the generic reversal

---

### 07.3 Maker-checker controls

**Build**
- Creator, approver and executor are different users for high-risk payments
- Beneficiary bank detail verification before payment

**Blueprint rules enforced**
- §17 — *"Creator, approver and executor shall be different users for high-risk payments"*
- §17 — *"Payments cannot use inactive/unverified beneficiary bank details"*
- §15 — *"Supplier bank detail changes require independent verification and approval before payment"*
- §17 acceptance criterion 1 — *"Payment batches enforce maker-checker controls and source approval"*

**Test gate**
- [x] The same user cannot create and approve a high-risk payment — refused by the service *and* by a CHECK on the table, because a control that lives only in application code is one a future migration can drop without noticing
- [x] The same user cannot approve and execute a high-risk payment — and cannot create and execute either, which is the pair people forget: a second person approving something one person both invented and sent is not two pairs of hands
- [x] A payment to an unverified beneficiary bank account is blocked — checked at approval and again at execution, because the two questions are asked at different moments and the answer can change in between
- [x] A bank detail changed after approval but before execution re-triggers verification — the batch line records **which revision the approver saw**, and the database bumps that revision on any payable change. It catches the case nothing else does: details un-approved, redirected and re-approved, where every row looks valid and the money is still going somewhere nobody signed for
- [x] Every maker-checker step is in the audit trail with actor and timestamp — proposal built, proposal approved, batch created, approved and executed, each with its own actor, and the approval also records the beneficiary revisions it was given

**What §17 does not say, and D13 now asks:** what makes a payment *high-risk*.
The threshold is configuration seeded at zero, so every payment takes the full
control until Finance sets a figure.

---

### 07.4 Receipts and inter-account transfers

**Build**
- Customer Receipt (from Phase 06) and Other Receipt
- Bank Transfer between company accounts

**Test gate**
- [x] An inter-account transfer debits one account and credits the other in a single balanced journal — one document, two legs, one entry, and each leg lands in **its own** G/L account
- [x] A transfer between accounts of different currencies uses an approved FX conversion and records both legs — the rate is stated on the transfer and refused where there is no conversion to rate; what left and what arrived are both recorded rather than one inferred from the other
- [x] Other Receipts post to the configured account and carry required dimensions — a document of its own, and deliberately not a variant of the Customer Receipt: it **cannot credit a subledger control account**, refused by the service and by trigger, and there is no customer column in which to record one. A receipt that could go either way depending on how it was filled in is a receipt that eventually goes the wrong way, and the control account stops tying to the subledger

---

### 07.5 Petty cash and cash advances

**Build** — Petty Cash, Cash Advance, Cash Count per §17

**Test gate**
- [x] Petty cash balance per custodian is tracked and reconciles to its G/L account — it *is* that balance, and advances outstanding sit **beside** it rather than inside it: cash in a drawer and cash somebody is carrying are different things, and netting them hides exactly the one that goes missing
- [x] Cash count variance requires approval and posts an adjustment — 07.1's cash count, unchanged. A float is counted the same way whether or not somebody has an advance out of it, and two implementations of "what is in the drawer" would eventually disagree
- [x] Petty cash advances age and are reported (Appendix D) — aged from the date the advance was **due to be accounted for**, not from the date it was issued. An advance given a month before a trip is not overdue; ageing from issue would flag it alongside one that genuinely is, and a report that cries wolf is a report nobody reads

**The advance is a receivable, not an expense.** Money handed to somebody who has
not yet said what it was for has not been spent — it has been lent, and until the
receipts arrive that is what the balance sheet should say. The expense arrives
with the receipts, on the accounts the receipts name, with their own §4.2
dimensions: one advance buys fuel, stationery and a courier fee, and a single
"petty cash" account would answer no question anybody asks.

**Two ways to close it, and only two.** Every dinar is accounted for with a
receipt or handed back. `settled + returned ≤ amount` at all times, and a status
of *settled* requires the two to equal it — so an advance cannot be filed away
while money is still out, which is the one outcome the document exists to
prevent.

**Raised while building this: D15.** A cash-count variance is an expense, and
§4.2 requires a department and a business line on every expense — but no cash
count carries either, and nobody chose them. The same gap applies to FX
differences, rounding and bank charges, all of which appear in the Phase 16
close.

---

### 07.6 Bank statement import

**Build**
- Import or manual entry of bank statements, per the statement format on the account master
- Unique import key preventing duplicate statement lines

**Blueprint rules enforced**
- Appendix B, Bank Statement Line — *"Unique import key; match status; book-to-bank reconciliation"*
- §23 — file-import centre for bank statements

**Test gate**
- [x] Importing the same statement twice does not duplicate lines — caught twice over: one statement per account per period, and beneath that a unique import key per line built from *what the transaction is* rather than from what the file called it
- [x] Statement lines carry date, value date, amount, reference and counterparty — with the value date checked against the booking date rather than merely stored, because money cannot clear before it moves and a file that says otherwise has been parsed wrongly
- [x] An unparseable line is reported rather than silently dropped — kept as **raw text** with the reason, because the person fixing it needs what the bank actually sent, not the system's summary of why it failed
- [x] The import runs through the Phase 01 import framework with preview, error file and batch ID — and through `appendLine`, the same function a screen calls, so the import key and the line rules apply to a file exactly as they do to typing

**A note on the import key, because it involved a real trade-off.** Two
genuinely different transactions can be identical on every visible field — the
same amount to the same reference on the same day happens. Telling "the second
copy of one line" apart from "a second, identical line" needs information the two
do not contain, so the key includes the line's **position in the statement**,
which a re-import reproduces exactly. The cost is stated rather than hidden: a
file listing the same period in a different order would give its identical-looking
lines different keys. That is why the bank's own transaction identifier is used
whenever there is one — it is authoritative rather than inferred.

**Also enforced, and not asked for:** the statement must add up. Opening plus
movement equals closing, or it does not close. A truncated download still looks
like a statement, and 07.7 would agree the G/L to a number the bank never said —
which is worse than not reconciling, because it comes with a tick next to it.

---

### 07.7 Bank reconciliation workspace

**Build**
- Automatic matching by amount, date, reference and counterparty, with manual confirmation
- Resolution of unmatched items, bank fees, interest, returned payments and timing differences
- Statement lines immutable after reconciliation; corrections through a reopen/adjustment workflow
- Reconciliation cannot be finalised with unexplained differences unless an authorised adjustment is posted

**Blueprint rules enforced**
- §17 — all of the above, verbatim
- §17 acceptance criterion 2 — *"Bank statement matching supports automatic suggestions and manual confirmation"*
- §17 acceptance criterion 3 — *"Reconciled bank balance agrees to the G/L for the same date"*

**Test gate**
- [x] Automatic matching proposes correct matches and never auto-commits without confirmation — `suggestMatches` has no way of writing a confirmation; putting a name on a match is a different function with a different permission, so "never auto-commits" is a property of the code rather than a promise about it
- [x] Reconciliation cannot be finalised while an unexplained difference remains — and there is **no override parameter to reach for**. §17 says an adjustment is posted, not that a difference is waived: the adjustment removes the difference by recording what it was, after which the arithmetic balances on its own
- [x] An authorised adjustment posts through the Phase 02 engine to a clearing account — and the statement line is matched to the entry the posting created, so the adjustment is not merely posted but accounted for
- [x] Reconciled statement lines are immutable; a correction requires the reopen workflow and is audited — enforced by trigger on UPDATE *and* DELETE. The reopen is a named act with a reason, it is counted, and it turns every confirmation back into a suggestion: what was agreed must be agreed again
- [x] Reconciled bank balance equals the G/L balance for the same date, proven for a full test period — a whole February, matched, adjusted and signed, and the figure checked independently against `treasury.balances`
- [x] Unmatched and unidentified items are reported and aged (§17 acceptance criterion 4) — **both sides**, because they mean different things: a statement line nobody matched is money the bank moved that the books do not show (usually a missing entry), and a ledger entry nobody matched is money the books show that the bank has not (usually just time)

**A match is a set against a set, not a pair.** §12.5's Bank Execution Batch puts
one bank debit against several internally separate transfers — each keeping its
own document, client, branch and margin — and requires the batch total to
reconcile to the single statement amount. A one-to-one match cannot say that, and
Phase 09 would have had to rebuild this workspace to add it. Tested here with
three ledger legs against one statement line, and with the refusal when the legs
do not total it.

**Timing differences are not errors.** A cheque written on the 27th and presented
in March makes the two records disagree, and both are right. The reconciliation
subtracts it and says so; what is left after the timing differences are applied
is the *unexplained* difference, and that is the only figure §17 refuses to let
anybody sign over.

---

### 07.8 Cash position and forecast

**Build**
- Daily cash and bank balance by currency and account
- Cash forecast combining due A/P, expected A/R, project commitments, payroll and transfer funding
- Foreign-currency position and funding requirements

**Blueprint rules enforced**
- §17 — *"Cash forecast combines due A/P, expected A/R, project commitments, payroll and transfer funding"*
- §17 acceptance criterion 5 — *"Treasury dashboard provides current and forecast liquidity by currency"*

**Test gate**
- [x] Daily position by account and currency ties to the G/L for the same date — it *is* the G/L, read through the one function that answers "what is in this account". A dashboard computing its own figure would be a second answer waiting to disagree
- [~] The forecast draws from all five listed sources; removing one visibly changes the result — **two of the five can contribute today.** A/P due and A/R expected are read from open invoices and each visibly changes the result when excluded. Project commitments (Phase 11), payroll (Phase 15, itself blocked on D3) and transfer funding (Phase 09) have no documents to read yet. They are **named sources reporting `available: false` with the phase they await**, not silent zeroes — a treasurer needs to know the difference between "payroll is nil this month" and "payroll is not in here"
- [x] Forecast by day, week and month are internally consistent — the same movements in different-sized boxes: identical closing balance in all three, identical totals, and each period opening where the last one closed
- [x] Foreign-currency exposure is reported by currency, not collapsed to base — and **read rather than converted**. The ledger keeps an IQD and a USD figure for every line (§14.3), so the exposure is what was recorded; converting at read time would answer a question about today's rate, and the rate is precisely what the exposure is exposed to

**Nothing in 07.8 has a table.** Every figure is read from the ledger and from
documents that already exist. A stored forecast is one that goes stale in a way
nobody notices, and a stored position is a second version of a balance that is
already recorded once.

**The three missing sources are a dependency, not an omission.** Each is one
function away, and the report already lists it. When Phase 09, 11 and 15 land,
this gate closes without the forecast being redesigned.

---

## Phase exit gate

§17 minimum acceptance criteria, verbatim:

| # | Criterion | Evidence |
|---|---|---|
| 1 | Payment batches enforce maker-checker controls and source approval | 07.3 gate — and the exit-gate scenario, where the raiser is refused approval and the approver is refused execution |
| 2 | Bank statement matching supports automatic suggestions and manual confirmation | 07.7 gate — suggestions are written as suggestions, and confirming is a different function with a different permission |
| 3 | Reconciled bank balance agrees to the G/L for the same date | 07.7 gate — a whole February, agreed, with the figure checked independently against `treasury.balances` |
| 4 | Unmatched and unidentified items are reported and aged | 07.7 gate — both sides, because a statement line nobody matched and a ledger entry nobody matched mean different things |
| 5 | Treasury dashboard provides current and forecast liquidity by currency | 07.8 gate — position and exposure by currency, never collapsed to base |

**Exit-gate test:** `tests/integration/phase07-exit-gate.test.ts` — one month
end to end. Money is proposed by one person, approved by a second, sent by a
third, appears on the bank's own statement, is matched back to the ledger, the
fee nobody recorded is adjusted, the reconciliation is signed, and the dashboard
reads the same figure the bank does. Each control is proved on its own in its
sub-phase; this proves they **compose**, which is where a treasury system either
holds together or does not.

**Completes the Phase 05 chain** the phase plan names:
… → A/P Invoice → payment → **bank reconciliation** → G/L.

**Two findings that came out of building this phase**, both fixed:

1. **Supplier payments credited the wrong account.** The bank leg resolved
   through a §3.3 mapping rather than naming the account the money left. With one
   bank account nobody notices; with two, every payment credits the same account
   and 07.1's identity — *an account's ledger balance is its G/L balance* — stops
   holding. Fixed in supplier payments, supplier advances and customer receipts.
2. **`drizzle-kit generate` regenerated twelve migrations' worth of DDL** into
   what should have been one delta, because snapshots for 0041–0052 were never
   written. Caught before it was applied. The rule that follows: schema-level
   changes go into the drizzle schema *before* generating; only triggers, seeds,
   grants and RLS are hand-appended.

**Raised while building:** D13 (what makes a payment high-risk), D14 (the payment
priority scale and settlement discounts) and D15 (which department a
system-generated expense belongs to). None blocks anything today; all three are
configuration the business owns, and each is seeded with the cautious default.

**Completes the Phase 05 end-to-end scenario:**
> … → A/P Invoice → payment → **bank reconciliation** → G/L

**Sign-off:** Treasury (data owner per §4.3) and Finance.

---

## Notes for the team

Phase 09 depends on 07.6 and 07.7 specifically. The Bank Execution Batch in §12.5 splits one bank debit across several internally separate transactions, each retaining its own document, client/vendor, branch, cost centre, accounting and margin — and the batch total must reconcile to the single bank-statement amount. That reconciliation is only possible if statement import and the matching workspace already exist and can match one statement line to a batch rather than to a single document. Build 07.7 with that many-to-one case in mind rather than retrofitting it in Phase 09.
