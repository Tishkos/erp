# Phase 02 — Accounting Kernel

> **Blueprint:** §1.2, §3.1, §3.3, §14.1–14.4, §14.6, §24, Appendix C
> **Release (§27):** 2 — re-sequenced from Release 8. See correction **C1** in [`../PHASES.md`](../PHASES.md)
> **Depends on:** 01
> **Blocks:** 03, 04, 05, 06, 07, 09, 10, 11, 12, 13, 14, 15, 16, 19
> **Blocked by decision:** **D7** — Chart of Accounts must be configured by the Business Process Owner

---

## Purpose

Build the accounting engine every operational module posts through. §3.3 requires operational documents to create accounting entries automatically; §24 requires that posting be atomic, idempotent and configuration-driven. This phase delivers that engine before any module needs it.

**Why this moved:** Release 3's acceptance dependency is *"Inventory subledger and G/L reconcile."* Release 4's is *"supplier ledger and G/L reconcile."* Release 5's is *"revenue and COGS reconcile."* No G/L exists in the §27 ordering until Release 8. The kernel therefore has to precede Release 3. The remainder of Release 8 — recurring journals, close, statements — stays in Release 8 as Phase 16.

## In scope

Chart of Accounts, fiscal periods and soft close, currency and rates, the dimensions framework, manual Journal Entry, the posting engine, account determination, reversal, subledger framework, Trial Balance and G/L inquiry.

## Out of scope

- Recurring journals, year-end close, FX revaluation, financial statements — Phase 16
- Any operational document — Phases 04 onward
- Bank reconciliation — Phase 07

---

## Sub-phases

### 02.1 Chart of Accounts

**Build**
- Hierarchical, configurable account structure (§1.2)
- Per §4.3: account code/name, parent, type, posting allowed, control account flag, currency restrictions, required dimensions
- Control accounts protected from direct manual posting except through the Finance route
- Active/inactive; deactivation rather than deletion when referenced

**Blueprint rules enforced**
- §1.2 — *"The Chart of Accounts shall remain hierarchical and configurable"*
- §3.3 — *"All accounts used by automatic or manual journals shall exist and be active in the Chart of Accounts"*
- §14.3 — *"Direct manual posting to customer, supplier, inventory, bank and control accounts is allowed only through Finance Journal Entry and requires Finance Manager approval"*
- Glossary — control account *"is normally protected from direct manual posting"*

**Test gate**
- [x] A journal referencing an inactive account is rejected
- [x] A journal referencing a non-posting (header) account is rejected
- [x] A non-Finance user cannot post to a control account by any path
- [x] An account referenced by a transaction cannot be deleted, only deactivated
- [x] Required-dimension settings on an account are enforced at posting time

**⚠ Blocked on D7.** The structure is built here; the actual account codes come from the Business Process Owner. Appendix C: *"Exact account codes and account names are selected through Accounting Mapping after the Chart of Accounts is configured by Issa Mohammed."*

---

### 02.2 Fiscal calendar and period control

**Build**
- Fiscal calendar, periods, period status
- **Soft close** semantics: normal users cannot post to a soft-closed period; authorised Finance Manager users can post approved adjustments
- Back-dated posting allowed when the period permits

**Blueprint rules enforced**
- §14.6 — *"The accounting period model is Soft Close. Normal users cannot post to a Soft-Closed period. Authorised Finance Manager users can post approved adjustments to the period. Posting dates earlier than the current date are allowed when the period permits posting"*
- §3.4 — *"Soft-close accounting periods"*

**Test gate**
- [x] A normal user posting into a soft-closed period is rejected
- [x] A Finance Manager posting an approved adjustment into the same period succeeds and is audited as a period override
- [x] A back-dated posting into an open period succeeds
- [x] Period-lock overrides appear in the required report (§24: *"Period-lock override and back-dated posting report"*)

---

### 02.3 Currency and exchange rate engine

**Build**
- Currency master per §4.3: ISO code, decimals, accounting rate, market rate, client rate type, effective date, source, entered by
- Rates maintained **only** in the Finance Exchange Rate section
- IQD as primary transaction and ledger currency; USD as historical-rate reporting equivalent
- Every money value stored as the four-part tuple: transaction amount, currency, IQD amount, USD reporting amount, rate reference

**Blueprint rules enforced**
- §1.1 — *"IQD is the primary transaction and ledger currency; USD values are reporting equivalents calculated using approved historical exchange rates"*
- §14.3 — *"Exchange rate cannot be edited inside Journal Entry. Rates are maintained only in the Finance Exchange Rate section"*
- §14.3 — *"IQD is the primary balancing currency. USD is a historical-rate reporting equivalent and does not replace IQD ledger values"*
- §24 — *"All money fields store transaction currency amount, base currency amount, currency and rate/reference"*
- §2.3 — reports available in IQD or USD *"without changing the original transaction currency or ledger amount"*

**Test gate**
- [x] The rate field is not editable inside Journal Entry by any path, UI or API
- [x] A posted entry retains its historical rate; changing today's rate does not alter it
- [x] Re-running a report for a past period reproduces the same USD figures it produced originally
- [x] Money arithmetic uses exact decimals — a repeated-addition test over 10,000 rows shows zero drift
- [x] Rates carry effective dates and the correct rate is selected by posting date
- [x] Switching a report between IQD and USD leaves the underlying transaction and ledger amounts unchanged

**This is the constraint that cannot be retrofitted.** See `TECHSTACK.md` §A4.

---

### 02.4 Dimensions framework

**Build**
- The seven dimensions from §4.2: Branch, Department/Cost Centre, Business Line, Project, Warehouse, Customer/Supplier, Employee/Salesperson
- Mandatory-or-optional configuration **by account and by document type**
- Customer/Supplier derived from the source document and not manually alterable after posting

**Blueprint rules enforced**
- §4.2 — *"Dimensions shall be mandatory or optional by account and document type"*
- §4.2 validation column — Branch mandatory for all operational transactions; Department/Cost Centre mandatory for operating expense accounts; Business Line mandatory for revenue and direct cost accounts; Project mandatory for project-specific revenue, cost and inventory issues; Warehouse mandatory for stock movements
- §4.2 — Customer/Supplier *"Derived from source document; not manually altered after posting"*
- §14.3 — *"Cost Centre is optional or mandatory according to the Chart of Accounts setting for the selected account"*

**Test gate**
- [x] Posting to an operating expense account without a Cost Centre is rejected
- [x] Posting to a revenue account without a Business Line is rejected
- [x] A stock movement without a Warehouse dimension is rejected
- [x] Customer/Supplier on a posted line cannot be altered by any path
- [x] The same account can be mandatory for one document type and optional for another, if so configured

---

### 02.5 Journal Entry

**Build**
- Header per §14.2: Journal Entry Number (auto, never reused), Document Date, Posting Date (period-controlled), Description, Attachment (optional), Created By / Approved By from workflow
- Lines per §14.2: G/L Account, Debit, Credit, transaction currency amount, IQD amount, USD reporting equivalent, Business Partner, Branch, Cost Centre, Project, Department, Service Line, Warehouse, Bank Account, Line Description
- One branch per Journal Entry
- Standard Journal as the only manual journal type

**Blueprint rules enforced**
- §14.3 — *"One Journal Entry can contain one branch only"*
- §14.3 — *"The only manual journal type is Standard Journal"*
- §14 — *"Journal Entries belong exclusively to the Finance Department"*

**Test gate**
- [x] A journal with lines in two branches is rejected
- [x] A journal that does not balance in IQD is rejected — enforced as a database constraint, not only in application code
- [x] Only Finance-department users can create a Journal Entry
- [x] Journal Entry Numbers are unique and never reused across a rollback

---

### 02.6 Journal approval and posting

**Build**
- Finance user creates and submits to the Finance Manager
- Finance Manager creates and posts directly
- Approval posts automatically and locks

**Blueprint rules enforced**
- §14.4 — all four bullets, verbatim behaviour
- §14.4 — *"A posted Journal Entry cannot be edited or deleted"*

**Test gate**
- [x] A Finance user's journal routes to the Finance Manager and does not post on save
- [x] A Finance Manager's journal posts directly
- [x] Approval posts and locks in one transaction — an approved-but-unposted state is unreachable
- [x] A posted journal rejects edit and delete from UI and API

---

### 02.7 Posting engine

**Build**
- Central posting service called by every module — no module writes journals directly
- Account determination from configurable posting profiles: transaction type, item/service group, partner group, warehouse, project and other approved criteria
- Resolves accounts, dimensions and rates; generates a balanced journal plus subledger entries **within one database transaction**
- Deterministic source reference preventing duplicate posting
- Posting identifiers written back to the source document
- Post-commit event emission
- Posting preview, posting log, failed-posting queue

**Blueprint rules enforced**
- §3.3 — *"Posting accounts shall be selected through configurable accounting mappings, not hard-coded account numbers"*
- §24 — *"Posting must be atomic: either all journal/subledger/inventory records commit, or none do"*
- §24 — *"Each posting batch includes a deterministic source reference to prevent duplicate posting"*
- §24 — *"The posting engine emits events after commit so downstream notifications cannot cause partial financial posting"*
- §3.3 — *"Each posting shall retain the source module, document and line identifiers for complete drill-down"*
- Appendix C posting engine control checklist — all eight items

**Test gate**
- [x] **Atomicity:** a forced failure mid-posting leaves no journal, no subledger entry and no stock movement (§24 acceptance criterion 2)
- [x] **Idempotency:** posting the same source event twice produces exactly one set of financial effects (§24 acceptance criterion 1)
- [x] **Traceability:** every journal line resolves to source document, source line, posting rule and actor (§24 acceptance criterion 3)
- [x] No account number is hardcoded anywhere — changing a posting profile changes the resulting accounts with no code change
- [x] A posting that would violate a dimension requirement fails cleanly with a business error, leaving nothing partial
- [x] Failed postings land in the failed-posting queue with a root cause and can be reprocessed
- [x] Posting preview shows the exact journal that will be produced, and the produced journal matches it
- [x] Post-commit events fire **after** commit — a subscriber that throws does not roll back the posting
- [x] Appendix C control checklist: all eight items verified individually

---

### 02.8 Reversal engine

**Build**
- Full reversal only for manual journals
- Reversal Date equal to or later than the original Posting Date
- Original and reversal permanently linked
- Both read-only after reversal

**Blueprint rules enforced**
- §14.3 — *"Manual Journal corrections use Full Reversal only"*
- §14.3 — *"Reversal Date must equal or be later than the original Posting Date"*
- §3.2 — *"A posted document may be corrected only by the approved reversal or return document for that process"*
- Appendix C — *"Original and reversal linked permanently"*
- §24 status table, Reversed — *"Original and reversal read-only"*

**Test gate**
- [x] Partial reversal of a manual journal is impossible by any path
- [x] A reversal dated before the original posting date is rejected
- [x] After reversal, both documents are read-only and each links to the other
- [x] The net effect of original plus reversal on every account and dimension is exactly zero
- [x] A reversal cannot itself be reversed into a loop that re-creates the original effect

---

### 02.9 Subledger framework

**Build**
- Shared subledger mechanism for customer, supplier, inventory, fixed-asset, bank, project and service subledgers (§1.2)
- Each subledger reconciles to its G/L control account
- Append-only entries; balances derived from entries or from controlled balance tables that reconcile to them

**Blueprint rules enforced**
- §1.2 — *"The system shall maintain detailed customer, supplier, inventory, fixed-asset, bank, project and service subledgers that reconcile to the General Ledger"*
- §24 — *"Balances are derived from immutable entries or controlled balance tables that reconcile to them"*
- §24 — *"Posted journals and subledger entries are append-only"*

**Test gate**
- [x] A subledger entry is written in the same transaction as its journal, never separately
- [x] Subledger total equals the G/L control account balance for every test dataset
- [x] The application role cannot update or delete a subledger entry
- [x] Any balance table can be rebuilt from the entries and reproduces the same figures

---

### 02.10 Trial Balance and G/L inquiry

**Build**
- Trial Balance by period, account, branch and dimensions, in IQD or USD
- G/L Inquiry and Account Activity with drill-down to journal and source document
- Integrity checks: unbalanced entries, orphan entries, duplicate source references, sequence gaps

**Blueprint rules enforced**
- §14.1 — Trial Balance, G/L Inquiry, Account Activity on the Finance menu
- §14.8 — *"Source-document journals drill back to the originating operational document"*
- §24 — *"Unbalanced or orphan-entry integrity report, expected to be zero"*

**Test gate**
- [x] Trial Balance debits equal credits for every period, in IQD
- [x] The USD Trial Balance reproduces historical-rate equivalents consistently across re-runs (§14.8)
- [x] Every Trial Balance figure drills to journal lines and from there to the source document
- [x] The integrity report returns zero unbalanced and zero orphan entries
- [x] Data scope applies — a branch-scoped user's Trial Balance shows only their branch

---

## Phase exit gate

| # | Criterion | Evidence |
|---|---|---|
| 1 | Chart of Accounts is configured and enforces active, posting-allowed and control-account rules | 02.1 gate |
| 2 | Soft close behaves per §14.6 with override auditing | 02.2 gate |
| 3 | Rates are Finance-only, historical and reproducible | 02.3 gate |
| 4 | Dimension requirements are enforced by account and document type | 02.4 gate |
| 5 | Journal Entry meets every §14.2 and §14.3 rule | 02.5, 02.6 gates |
| 6 | Posting is atomic, idempotent, mapping-driven and traceable | 02.7 gate — §24 acceptance criteria 1, 2, 3 |
| 7 | Reversal is full-only, correctly dated and permanently linked | 02.8 gate |
| 8 | Subledgers reconcile to control accounts | 02.9 gate |
| 9 | Trial Balance balances and drills to source | 02.10 gate |
| 10 | Appendix C posting engine control checklist passes in full | 02.7 gate |

**Sign-off:** Business Process Owner approves the Chart of Accounts and the posting profile configuration. Finance confirms the Trial Balance reconciles.

---

## Notes for the team

This phase is where the system is won or lost. Three specifics:

1. **Atomicity is a database property, not a code convention.** If the journal, subledger and inventory writes can be separated by a network hop, §24 cannot be satisfied. See `TECHSTACK.md` §A1.
2. **The four-part money tuple must land in the first migration.** Adding `amount_usd` and `rate_ref` later means rewriting every table, every query and every report. See `TECHSTACK.md` §A4.
3. **No module may write a journal.** Every posting goes through 02.7. The moment a module writes its own journal, the Appendix C control checklist stops being enforceable, and §24's warning about duplicated mechanisms comes true.

### Two 02.4 corrections found while building Phase 05

**§4.2's first layer was unreachable for automated postings.** `PostingRequest`
carried only an `eventType` (`purchasing.ap_invoice`), and the posting engine
passed it where `document_type_dimension` expects a *document type*
(`ap_invoice`). The two are different namespaces, and the table's foreign key
means an event-type row cannot even be inserted — so a per-document-type
dimension rule could be configured for a manual journal and silently never
applied to anything the modules post. `PostingRequest` now carries an optional
`documentTypeCode`, falling back to the event type where a module has not
supplied one.

**An account's dimension rules now override §4.2's type default, not add to
it.** D7 (2026-08-17) says *"Finance may override a rule for a specific account
when necessary."* An override that could only ever add was not one: Finance could
make an expense account require a project, but could never stop one requiring a
department — and purchase price variance on stock genuinely has no department,
because the goods were received by a warehouse rather than confirmed by one.
`effectiveRequirement` now consults the account-type default only where nothing
in the account's ancestry declares. Where nothing declares, §4.2 is unchanged.
