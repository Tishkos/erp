# Phase 16 — Period Close & Financial Statements

> **Blueprint:** §14.5, §14.6, §14.7, §14.8, Appendix C, Appendix D, Appendix E (IAS 21, IFRS 18)
> **Release (§27):** 8 — Finance and Treasury
> **Acceptance dependency (§27):** *"Trial Balance, subledgers and bank reconciliations pass."*
> **Depends on:** 02, 07, and every subledger phase (04, 05, 06, 09, 10, 11, 12, 13, 15)
> **Blocks:** 18

---

## Purpose

The remainder of §14 after the Phase 02 kernel: recurring journals, month-end close, FX revaluation, year-end close and the financial statements.

This phase is where the whole system proves itself. Every prior phase claimed its subledger reconciles to the G/L; here they all have to do it at once, for a real period, and produce statements that tie.

---

## Sub-phases

### 16.1 Recurring journals

**Build**
- Recurring templates for rent, payroll, subscriptions, periodic accruals, amortisation and other repeating entries
- Each scheduled occurrence creates a **reviewable Standard Journal draft**
- Follows the Finance approval workflow

**Blueprint rules enforced**
- §14.5 — verbatim
- §14.3 — *"Recurring Journal templates create Standard Journal drafts"*

**Test gate**
- [ ] A scheduled occurrence creates a **draft**, never a posted journal
- [ ] The draft follows the same Finance approval workflow as a manual journal
- [ ] Changing a template does not alter drafts already created
- [ ] A missed schedule (system down) is caught up without duplicating, via the Phase 01.10 job durability
- [ ] Templates carry dimensions and they flow to the generated draft

---

### 16.2 Subledger-to-G/L reconciliation

**Build** — automated reconciliation reports for every subledger against its control account: customer, supplier, inventory, fixed-asset, bank, project, client funds, service

**Blueprint rules enforced**
- §1.2 — every subledger reconciles to the General Ledger
- §22 acceptance criterion 2 — *"A/R, A/P, inventory, fixed asset, bank and client-funds control reports reconcile to the G/L for a test period"*
- Appendix D — Finance Control: *"Subledger-to-G/L Reconciliation"*

**Test gate**
- [ ] A/R subledger equals the A/R control account
- [ ] A/P subledger equals the A/P control account
- [ ] Inventory FIFO valuation equals the inventory control account
- [ ] Fixed asset register equals cost less accumulated depreciation and impairment in the G/L
- [ ] Bank ledger equals the reconciled bank balance (Phase 07.7)
- [ ] Client funds (Money Transfer and Logistics clearing) equal their control accounts
- [ ] Project subledger equals its control accounts
- [ ] Any difference is reported with its composition, not merely flagged

---

### 16.3 FX revaluation

**Build** — period-end revaluation of foreign-currency balances, with reversal in the next period where policy requires

**Blueprint rules enforced**
- §26 critical UAT scenario — *"Foreign-currency invoice/payment and period-end revaluation with reversal in the next period where policy requires"*
- Appendix E — IAS 21 reference
- §14.3 — IQD is the primary balancing currency

**Test gate**
- [ ] Revaluation adjusts only foreign-currency balances, leaving IQD balances untouched
- [ ] The historical USD reporting equivalent on prior transactions is **not** altered by revaluation (§14.3)
- [ ] Reversal in the following period restores the pre-revaluation position exactly
- [ ] Revaluation posts through the Phase 02 engine and is fully reversible
- [ ] Running revaluation twice for the same period does not double-post

---

### 16.4 Month-end close

**Build**
- Close checklist with owners and completion tracking
- Soft close applied (Phase 02.2)
- Close progress and exception dashboard
- Controlled reopen

**Blueprint rules enforced**
- §22 — Finance Dashboard: *"trial balance health, unposted documents, overdue reconciliations, close progress and exception accounts"*
- §26 critical UAT — *"Month-end close checklist → subledger reconciliations → lock → financial statements → controlled reopen"*

**Test gate**
- [ ] The checklist blocks close while unposted documents or unreconciled subledgers remain
- [ ] Soft close prevents normal-user posting and permits Finance Manager adjustment (Phase 02.2)
- [ ] Reopening a closed period requires controlled exception approval and is audited
- [ ] The close dashboard shows real status, not a manually maintained flag

---

### 16.5 Year-end close

**Build** — per §14.7:
- Close Revenue and Expense accounts
- Transfer net profit or loss to Retained Earnings
- Carry Balance Sheet accounts forward
- Create opening balances for the new fiscal year
- Block year-end close while Draft or Pending Approval financial documents, unresolved subledger reconciliations or incomplete bank reconciliations remain

**Blueprint rules enforced**
- §14.7 — all five bullets
- Appendix C — Year-end close: *"Creates new-year opening balances after reconciliation gate"*

**Test gate**
- [ ] Year-end close is blocked by draft financial documents
- [ ] Year-end close is blocked by pending-approval financial documents
- [ ] Year-end close is blocked by unresolved subledger reconciliations
- [ ] Year-end close is blocked by incomplete bank reconciliations
- [ ] Revenue and expense accounts close to zero; the net moves to Retained Earnings
- [ ] Balance sheet accounts carry forward with their dimension detail intact
- [ ] New-year opening balances equal prior-year closing balances, account by account and dimension by dimension

*Test each of the four blocking conditions individually. §14.7 lists them separately for a reason.*

---

### 16.6 Financial statements

**Build** — generated from **account-to-report-line mappings**, not hardcoded account numbers:
- Trial Balance
- Statement of Profit or Loss
- Statement of Financial Position
- Cash Flow
- Statement of Changes in Equity
- Supporting schedules

Available in IQD or USD (§2.3).

**Blueprint rules enforced**
- §22 — *"Financial statements are generated from account-to-report-line mappings, not hard-coded account numbers"*
- §22 — *"Every financial report shows base currency, reporting period, run time, data status and filter criteria"*
- §22 — *"Historical reports use the rates and mappings valid for the reporting period unless an authorised restatement is performed"*
- §14.8 — *"Trial Balance, subledgers and financial statements reconcile"*
- Appendix E — IFRS 18 reference for presentation and disclosure

**Test gate**
- [ ] Adding an account to the Chart of Accounts and mapping it changes the statements with no code change
- [ ] An unmapped account is **reported as unmapped**, not silently omitted from the statements
- [ ] Statement of Financial Position balances: assets = liabilities + equity
- [ ] Statement of Profit or Loss ties to the Trial Balance revenue and expense movement
- [ ] Cash Flow ties to the movement in bank and cash balances for the period
- [ ] Every statement line drills to account, journal, source document and attachment (§22 acceptance criterion 1)
- [ ] Every statement shows base currency, period, run time, data status and filters
- [ ] The USD statement uses historical rates and reproduces identically on re-run
- [ ] Re-running a prior period uses that period's mappings and rates, not today's

---

### 16.7 Finance control reports

**Build** — per Appendix D: Journal Register; Reversal Register; Soft-Close Exceptions; Year-End Checklist; Subledger-to-G/L Reconciliation. Filters: date, user, source, status, branch.

Plus the §24 integrity reports: posting exception queue and root cause; documents stuck beyond target time; unbalanced or orphan-entry integrity report (expected zero); duplicate source references and sequence gaps; master records missing mappings or default dimensions; period-lock override and back-dated posting report.

**Test gate**
- [ ] The unbalanced/orphan integrity report returns **zero** (§24)
- [ ] The sequence gap report explains every gap
- [ ] The period-lock override report lists every back-dated and override posting with actor and reason
- [ ] Reversal Register pairs every reversal with its original
- [ ] Master records missing mappings or default dimensions are listed before they cause a posting failure

---

## Phase exit gate

§27 Release 8 acceptance: *"Trial Balance, subledgers and bank reconciliations pass."*

§14.8 minimum acceptance criteria, verbatim:

| # | Criterion | Evidence |
|---|---|---|
| 1 | Every journal is balanced in IQD | 16.7 integrity report — zero unbalanced |
| 2 | USD reports reproduce historical-rate equivalents consistently | 16.6 gate |
| 3 | Source-document journals drill back to the originating operational document | 16.6 gate |
| 4 | Trial Balance, subledgers and financial statements reconcile | 16.2, 16.6 gates |

**End-to-end scenarios (§26 critical UAT list):**
> Foreign-currency invoice/payment and period-end revaluation with reversal in the next period where policy requires
> Journal creation → approval → posting → reversal and source/audit trace
> Month-end close checklist → subledger reconciliations → lock → financial statements → controlled reopen

**Sign-off:** Finance signs the reconciled Trial Balance and the statements. This is the strongest evidence available before go-live that the system is sound.

---

## Notes for the team

**Run a full close on real migrated data before Phase 21, not after.** The blueprint's go-live gate (§26) requires *"Opening statement of financial position and subledger controls are signed by Finance."* If the first genuine close happens during cut-over, there is no time to fix what it finds. Schedule a rehearsal close against the Phase 21.8 rehearsal migration data.

**Unmapped accounts must be loud.** The most common way a financial statement silently misstates is an account that exists, carries a balance, and maps to no report line — so it simply vanishes. Make the unmapped-account report a blocking check on statement generation, not an optional review.
