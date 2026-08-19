# Decision Register

**Phase 00.7** · Blueprint §28.2 · answered decisions are in [`DecisionAnswered.md`](DecisionAnswered.md)

> "When a technical constraint or ambiguity is identified, the IT specialist shall document the issue and available technical options. Issa Mohammed selects and approves the final business treatment. The IT specialist shall not select a business or accounting outcome independently."

This register exists so that what has **not** been decided stays visible. A decision made quietly in code is a change-control breach under §28.1, not a shortcut.

Decisions that have been made move to [`DecisionAnswered.md`](DecisionAnswered.md) in full, with what each one changed in the build. This file holds only what is still owed, so the list of open questions cannot be lost among the answered ones.

**Owner of every business decision:** Issa Mohammed, Business Process Owner.

---

## Status summary

**Last reviewed:** 2026-08-18, after Phases 08, 11 and 12 and the Phase 09/10 merge.

| Status | Count |
|---|---|
| 🔴 Open — one of them blocking a posting outright | 8 |
| 🟡 Partially answered, or built the defensible way | 18 |
| 🟢 Decided — moved to `DecisionAnswered.md` | 5 |

| # | Decision | Status | Blocks | Raised by |
|---|---|---|---|---|
| D1 | Project revenue and cost recognition | 🔴 Open (policy) · build approach ruled | Phase 11.10 only | Blueprint §10 |
| D2 | Investment categories and valuation | 🔴 Open (policy) · build approach ruled | Phase 13.1, 13.5 | Blueprint §13 |
| D3 | Payroll formulas and deductions | 🔴 Open (policy) · build approach ruled | Phase 15.9 | Blueprint §20 |
| D5 | Volumes and retention | 🟡 All but response-time targets | Phase 20.4 judgement | Blueprint §25 |
| D8 | Cut-over date and historical depth | 🟡 Approach proposed, awaiting signature | Phase 21.1 | Blueprint §26 |
| D9 | Money Transfer legal approval, incl. what "KYC complete" contains | 🔴 Open | Phase 21 go-live | §21, Phase 09 |
| D11 | Accrual for confirmed uninvoiced services | 🟡 Built the defensible way | Nothing — would be Phase 16 | Phase 05 |
| D12 | Days Sales Outstanding formula and period basis | 🟡 Built one way, confirmation needed | Nothing | Phase 06 |
| D13 | What makes a payment "high-risk" | 🟡 Threshold seeded at 0 — everything is high-risk | Nothing | Phase 07 |
| D14 | Payment priority scale and settlement discounts | 🟡 Mechanism built and neutral | Nothing | Phase 07 |
| D15 | Dimensions on system-generated **postings** | 🔴 Open — widened at Phase 12 | Phase 12's first live depreciation run | Phase 07, widened Phase 12 |
| D17 | Whose money a residual client balance is | 🔴 Open | Phase 09 exit gate | Phase 09 |
| D18 | Is a deposit "Available" separately from "Posted"? | 🟡 Built as one state | Nothing | Phase 09 |
| D19 | May a client hold two open accounts? | 🟡 Built permissive | Nothing | Phase 09 |
| D20 | Who bears a Money Transfer direct expense | 🟡 No default — every charge states it | Nothing | Phase 09 |
| D21 | Does a cross-branch bank debit need a Super User? | 🟡 A consequence to confirm | Nothing | Phase 09 |
| D22 | Which clearing account a logistics funding credits | 🔴 **Blocking** | Phase 10.4 — funding cannot post at all | Phase 10 |
| D23 | Clearing-versus-receivable split at recognition | 🟡 Built funded-first | Nothing | Phase 10 |
| D24 | Cancelling a logistics job that carries posted money | 🟡 Refused for now | Cancellation past Approved | Phase 10 |
| D25 | Accounting treatment of a logistics claim | 🟡 Posts nothing, by design | Nothing | Phase 10 |
| D26 | What a duplicate customer match obliges | 🟡 Reports, never refuses | Nothing | Phase 08 |
| D27 | Progress approval, retention release, advance recovery | 🟡 Mechanisms built and neutral | Nothing | Phase 11 |
| D28 | Does depreciation re-base after an impairment? | 🟡 Built without re-basing | Nothing | Phase 12 |
| D29 | Who may see a client import file, now one register serves both | 🔴 Open — a consequence of D16 | Nothing; a row-level policy is cheaper now than later | 09/10 merge |
| D30 | The four thresholds seeded at zero | 🟡 All in force at their strictest | Nothing — each **tightens** | Configuration sweep |
| D31 | What role an investment counterparty holds in the partner master | 🟡 Recorded as a supplier, which is the nearest true thing | Nothing — master-data quality | Phase 13 |

**Answered and moved out:** D4 (availability and recovery), D6 (accessibility),
D7 (Chart of Accounts) and D10 (branch access and the Active Branch) — all on
2026-08-17, all by Tishko. **D7's answer released the Phase 02 and Phase 04
acceptance hold**, which was the single largest thing standing in front of the
build. **D10 replaced the session-branch model** Phase 01 had chosen, which in
turn unblocked §7.2 multi-branch Sales Orders in Phase 06.

---

### What is needed from you now

**Updated 2026-08-18**, after Phases 08, 11 and 12 and the Phase 09/10 merge.

Nine things are owed. Seven of them are a number, a word, or a short table — not
a policy document — and are set out here in the form the answer takes, so they can
be given without a meeting. The two that genuinely need Finance to sit down are
marked as such.

**D13 now sits inside D30**, which gathers the four thresholds this system seeds
at zero. They were scattered across three entries and nobody scanning for what
they owed would have found them; they are one sitting's work between them.

**D16 was answered on 2026-08-18** — one client import register, because the
paperwork arrives once. It is in
[`DecisionAnswered.md`](DecisionAnswered.md#d16--one-client-import-register)
with what it changed, including a duplicate-numbering defect it turned up on the
way: the two registers ran two sequences that minted the **same** file numbers.

| # | The question, in one line | The answer looks like | What it unblocks |
|---|---|---|---|
| **D22** | Which clearing account does a logistics client funding credit, at each job stage? | **Four rows.** For Draft, Approved, In Progress and Delivered, pick one of *Client Logistics Clearing* or *Deferred Service Balance* | Phase 10 client funding. **It cannot post at all today** |
| **D15** | Which department and business line does a system-generated posting belong to? | **Seven rows.** For cash count variance, FX revaluation, rounding, bank charges, depreciation, impairment and gain/loss on disposal: a named department, *the branch's default*, or *none required*. Then: does the same answer cover business line? | Phase 12's first live depreciation run, and every Phase 16 close step |
| **D13** | Above what amount is a payment "high-risk"? | **One number, in IQD.** It is seeded at 0, which makes every payment high-risk and demands a separate creator, approver and executor for all of them | Nothing. It **relaxes** a control that is currently at maximum |
| **D28** | Does depreciation re-base onto the revised carrying value after an impairment? | **Yes or no**, and whether it applies per category or per asset | Nothing. It changes future monthly profit, and is far cheaper to answer before there are impairments in the ledger |
| **D5** item 6 | What response time is acceptable? | **One small table** — list screens, document save, posting, reports | Judging the §25 load test. It can be run today but not scored |
| **D8** | Approve the migration approach, and supply two values | **A signature**, plus the target cut-over period and the named owner of each §26 data class | Phase 21.1 |
| **D30** | Four thresholds are seeded at zero. What should they be? | **Four numbers** — match tolerance and over-receipt (§8.4), write-off threshold (§16), high-risk payment (§17, = D13) | Nothing. Each one **tightens** today, so answering them relaxes work people are doing by hand |
| **D27** | Who approves a progress measurement, when does retention release, and how does an advance recover? | **Three short rules.** The rates are already per contract; what is missing is when they fire | Nothing today. Retention and advances are recorded but nothing releases or recovers automatically |
| **D29** | May a Logistics user see an import file belonging to a Money Transfer client? | **Yes or no.** If no, it needs a row-level policy beside D10's branch policy, which is cheap now and a migration later | Nothing today |
| **D9** | What does "KYC complete" contain? | **The catalogue**: risk bands, the documents each band requires, and how often identification is renewed. Legal and compliance own this, and it has the **longest external lead time of anything here** | Money Transfer go-live |

### The two that need Finance in a room

**D1, D2 and D3** — project revenue recognition, investment valuation, payroll
formulas. Your
[programme ruling](#programme-ruling--d1-d2-and-d3-build-the-mechanism-leave-the-business-values-empty)
means none of them stops a phase being *built*, and Phase 11 shipped nine of
twelve sub-phases under it. Each still stops its phase being *used*, and that
distinction disappears at go-live. They are also the three that cannot be
answered here under any reading of §28.1 — they are accounting policy and
statutory rules, not technical choices.

### The three that matter this week

Ranked by what each one is holding up **today**, not by size.

**1 · D22 — which clearing account a logistics funding credits, per job stage.**
A four-row table, and the only item in this register that stops a posting
outright. Phase 10 is built and tested and cannot take a client's money in
production until it lands. Nothing else in the register is in that position.

**2 · D2 — the investment categories and valuation methods.** Promoted on
2026-08-18 because **Phase 13 is being built now**. The structure ships with
`investment_type` and `investment_valuation_method` **empty**, which is
deliberate and safe — without a type no investment can be created, and without a
method no valuation can be recorded. But it means Phase 13 ships as a shell:
every mechanism real and tested, and **nothing recordable** until Finance fills
the two catalogues. The rest of the phase — proposals, approvals, funding through
Treasury, income, disposal, the register and the reports — is being built now and
does not wait.

**3 · D15 — dimensions on system-generated postings.** Seven rows. It was a
Phase 16 inconvenience when raised; Phase 12 brought it forward, because a
depreciation run against accounts that still require a department fails on the
first asset, and Phase 12 is built and waiting. Every month that passes adds
postings that will have to be classified twice if the answer is late.

**Why D1 and D3 are not on this list.** They are just as large, and neither is in
flight: Phase 11.10 is the only thing D1 holds and Phase 15 has not started. They
matter at go-live, not this week.

### What is deliberately not being asked

The register is longer than it was, and that is the ruling working rather than a
backlog forming. Of the twenty-four open items, **two** stop work: D22 and D15.
The rest are either a value to configure or a confirmation of something already
built the defensible way, and none of them is waiting on you to keep the build
moving.

**Waiting on a signature rather than a decision: D8.** The migration approach was
proposed on 2026-08-17 and needs written approval under §28.1. Two things inside
it are genuinely open: the target cut-over period, and the named owner of each
§26 data class.

---

## Programme ruling — D1, D2 and D3: build the mechanism, leave the business values empty

**Decided 2026-08-17 by Tishko.** This is not an answer to D1, D2 or D3. Their
business content — the recognition method, the valuation basis, the payroll
formula — remains 🔴 Open and can only be settled by Finance and HR. What was
decided is *how the build proceeds while they are open*, which is a technical
question and therefore one §28.1 does allow to be settled here.

**The ruling, in the words it was given in**

> Build the mechanism, leave the business values empty.
>
> - **D1 — Projects.** Build 11.1–11.9 and 11.11–11.12. Leave only the
>   revenue-recognition / WIP calculation in 11.10 inactive until Finance
>   supplies the policy.
> - **D2 — Investments.** Build the register, the configurable type structure,
>   mappings, income events and disposal logic. Leave the investment categories,
>   valuation methods and impairment rules empty until Finance defines them.
> - **D3 — Payroll.** Build the HR master, expenses, advances and the payroll
>   framework. Do not activate payroll calculations until HR and Finance provide
>   the formulas and statutory rules.
>
> Zero and neutral defaults are only safe where they make the system **stricter
> or inactive**. There is no safe neutral default for a revenue-recognition
> method, an investment valuation basis, or a payroll formula. Those stay
> unconfigured, not guessed.

**Why this matters beyond the three.** It states the test every other open
decision in this file is now held to: *an empty configuration is acceptable when
emptiness refuses; it is not acceptable when emptiness permits.* Two entries
below are in this file precisely because they fail that test if left empty —
D22 (which clearing account a logistics funding credits) refuses to post at all
until it is answered, which is correct; D13's risk threshold is seeded at zero,
which makes every payment high-risk, which is correct for the same reason.

**Where the ruling is already visible in the build**

| Phase | The mechanism that exists | The value that is deliberately absent |
|---|---|---|
| 11 | `project.recognition_method` is a column; progress certificates carry no journal link; there is no WIP table | Nothing reads the column. Nothing can post recognition |
| 13 | not yet built — the register and mappings may proceed | The category list ships empty |
| 15 | not yet built — HR master, expenses and advances may proceed | No payroll formula is programmed |
| 10 | `logistics_funding_stage_role` is a table, and posting resolves through it | It ships **empty**, so client funding cannot post until D22 is answered |
| 09 | `kyc_required_document` and `kyc_risk_rating` are catalogues | They ship empty; see D9 |
| 07 | `payment_risk_policy` holds a threshold | Seeded at 0 — every payment is high-risk until D13 lands |

**What it does not authorise.** It does not permit a plausible default anywhere
the default would let a posting through. A category list with sensible-looking
rows, a recognition method that defaults to percentage-of-completion, or a
payroll formula "for testing" would each be a §28.1 breach — and each would be
invisible, because the tests would be written against the same invented rule.

---

## D1 — Project revenue-recognition and cost-recognition policy

| | |
|---|---|
| **Status** | 🔴 Open |
| **Blueprint** | §10 |
| **Blocks** | Phase 11.10 (WIP and revenue recognition) |
| **Owner** | Finance → Business Process Owner |
| **Raised** | 2026-08-16 |

**The blueprint's own words**

> "Before development of progress billing and WIP, Finance must approve the project revenue-recognition and cost-recognition policy. The system shall support configuration, but IT must not invent the accounting treatment."
> "Project revenue recognition and WIP rules must be approved by Finance and aligned with applicable accounting policy."

**What is needed**
1. Recognition method per project or contract type — and whether it varies by type
2. How progress is measured for recognition purposes, and who approves the measurement
3. WIP account treatment: what accumulates, when it releases
4. Treatment of retention and customer advances at recognition (they are separate balances per §10, but their interaction with recognition is unstated)
5. Worked examples Finance will accept as the acceptance test

**Reference:** Appendix E cites IFRS 15 supporting material as the reference point for *policy design* — it does not authorise the implementation team to select the treatment.

**Can proceed without it:** Phases 11.1–11.9 and 11.11–11.12. Only the recognition calculation is blocked.

---

## D2 — Investment categories, valuation methods and posting rules

> **Moved to [`ImportantDecision.md`](ImportantDecision.md).** This is one of the
> three the build is waiting on today, and it is kept there in full so the short
> list stays short. Nothing about it changed; only where it lives.

---

## D3 — Payroll formulas, statutory deductions and benefits

| | |
|---|---|
| **Status** | 🔴 Open |
| **Blueprint** | §20 |
| **Blocks** | Phase 15.9 (payroll) |
| **Owner** | HR + Finance → Business Process Owner |
| **Raised** | 2026-08-16 |

**The blueprint's own words**

> "Payroll formulas, statutory deductions and benefits require signed HR/Finance specification."
> "Implement HR master, employee expenses and advances before full payroll if local payroll rules are not yet documented. **Payroll shall not be programmed from assumptions.**"

**What is needed**
1. Signed HR/Finance payroll specification
2. Statutory deduction rules applicable in Iraq
3. Benefit calculation rules
4. Approved test cases — §20 acceptance criterion 1 requires payroll to "reproduce approved test cases"
5. Advance-recovery-through-payroll rules

**Can proceed without it:** Phases 15.1–15.8. The blueprint itself prescribes this sequencing.

**Note:** if D3 is outstanding at Release 9, the phase ships without payroll and that is declared as a known limitation under §27.1 — not glossed over.

**Build approach:** ruled on 2026-08-17 — see [the programme ruling](#programme-ruling--d1-d2-and-d3-build-the-mechanism-leave-the-business-values-empty).


---

## D5 — Volumes, concurrency and retention horizon

| | |
|---|---|
| **Status** | 🟡 Decided except response-time targets |
| **Blueprint** | §25, "Performance and scalability" |
| **Blocks** | Phase 20.4; infrastructure sizing — **released for sizing** |
| **Owner** | Business Process Owner |
| **Raised** | 2026-08-16 |
| **Decided** | 2026-08-17 (items 1–5) |
| **Decided by** | **Tishko answered this** |

> §25: "Define target concurrent users, annual transaction volumes, attachment
> volume, integration throughput and data-retention horizon **before sizing**."

### Decision

| Area | Target |
|---|---|
| Normal concurrent users | 20 |
| Peak concurrent users | 50, including month-end and reporting periods |
| Registered-user capacity | 250–300 without architectural change |
| Annual business documents | ~250,000/year initially |
| Growth capacity | Scalable to ≥1,000,000 documents/year |
| Attachment size | 2–5 MB average |
| Annual attachment storage | ~500 GB/year, scalable independently of the database |
| Integration throughput | 10–20 requests/second normal; ~50/second peak |
| Online data retention | ≥4 years for accounting and business records, unless Finance or Legal requires longer |
| Archive | Older data may move to read-only storage, remaining **searchable and retrievable** |

### What this changes in the build

1. **Sizing is unblocked.** 50 peak users against 250,000 documents a year is a
   modest load for PostgreSQL; the figures that actually shape the design are the
   attachment volume (500 GB/year, growing) and the 4-year online retention,
   which together say attachment content belongs in object storage with its own
   lifecycle — as Phase 01.8 already assumes.
2. **`tests/load/smoke.js` gains real numbers.** The k6 smoke test can now model
   20 normal and 50 peak concurrent users rather than an invented figure.
3. **Archive must stay queryable.** "Searchable and retrievable" rules out cold
   storage that has to be restored before it can be read — which constrains the
   Phase 21 archive design, and is worth knowing before it is built rather than
   after.
4. **The 1,000,000-document growth target is an architectural instruction**, not
   a forecast: it says the design must not contain anything that stops working at
   four times the initial volume. Table partitioning is not needed at 250,000
   documents a year and should not be ruled out at a million.

### Still open — item 6

**Acceptable response-time targets** for list screens and for posting have not
been given.

This is the one item that still cannot be closed by assumption, and it is
specifically what §25 acceptance criterion 3 is judged against: without a target,
the load test can be **run but not judged**. A list that returns in four seconds
is either fine or a failure depending on a number nobody has stated.

Suggested shape for the answer, if it helps: a target and a ceiling for each of —
opening a list screen, running a filtered search, opening a record, posting a
journal, and running the Trial Balance. Ninety-fifth percentile rather than
average, because the average hides the month-end.

---

## D8 — Cut-over date, historical depth and archive approach

| | |
|---|---|
| **Status** | 🟡 Approach proposed 2026-08-17 — **awaiting Business Process Owner approval**; date and owners still open |
| **Blueprint** | §26 |
| **Blocks** | Phase 21.1 |
| **Owner** | Business Process Owner |
| **Raised** | 2026-08-16 |
| **Proposed** | 2026-08-17 — **Tishko drafted this** |

### Proposed approach — the opening position, not the history

> "Migration will use an opening-position approach rather than recreating the
> complete historical system. Master data, opening balances, outstanding
> transactions and other active records required to continue operations will be
> migrated into the ERP. Completed historical transactions that do not need to
> participate in current processing will remain available through a read-only
> archive.
>
> The final cut-over will take place at the start of an agreed accounting period
> after UAT and migration reconciliation have passed. A controlled
> transaction-freeze window will be used for the final migration.
>
> Each migration data class shall have a named business owner responsible for
> validating its completeness and accuracy before go-live."

#### 1 · Cut-over timing

| | |
|---|---|
| **When** | After UAT and migration reconciliation pass — not on a calendar date fixed in advance |
| **Where in the month** | The start of an accounting period, so the accounting is clean |
| **Freeze window** | ~24–48 hours for the final migration and reconciliation |
| **During the freeze** | Controlled emergency transactions only, recorded for later entry |

The worked example given: the old system closes at the end of 31 October; the
ERP is the official system from 1 November.

#### 2 · What is migrated

Master data and the **live position**, not the history:

Chart of Accounts · customers and suppliers · current account balances · open
customer invoices · open supplier invoices · current bank and cash balances ·
current stock quantities and values · open projects and contracts · open
advances, retentions and other outstanding balances · active employees.

The ERP therefore starts with a correct opening position and all unfinished
business. Closed historical transactions are not recreated one by one.

#### 3 · Historical records

Completed transactions stay in a **read-only archive** — invoices, payments,
journals, contracts, stock records, reports and attachments remain lookup-able
and not editable. If Finance later identifies specific historical information
that genuinely has to live inside the ERP, that data is selected separately.

#### 4 · Data ownership

Each §26 migration data class gets **one named business owner** who confirms
"this migrated data is complete and correct". IT imports and technically
validates; **IT does not approve the accounting or business accuracy of it.**
Finance approves finance data, Warehouse approves stock, HR approves employees.

### What is still open

| # | Item | Why it is still open |
|---|---|---|
| a | **Approval of this approach** | It is a proposal, marked "Business Process Owner approval required". §28.1 needs written approval before it is a decision. |
| b | **The cut-over date itself** | Deliberately conditional on UAT and reconciliation passing, so it cannot be fixed yet — but the *target period* can be, and Phase 21 planning needs one. |
| c | **The seven named data owners** | Deferred until §26's data classes are matched to actual people. This is the item most likely to be discovered late; a class with no owner has no one to sign it off at the go-live gate. |

### What this changes in the build

The approach is the low-risk one, and the parts of it that are engineering
rather than policy line up with what is already built:

1. **"Opening position, not history" is what Phase 04.7 already assumes.**
   Opening stock is a document with its own §9.7 cost-layer dates, precisely so
   that stock brought in at cut-over consumes in the right FIFO order without
   its receipts having to be recreated. The same shape is owed for opening A/R,
   A/P and bank balances in Phase 21.
2. **The read-only archive is a §26 deliverable, not a database.** D5 already
   settled that archived data must stay *"searchable and retrievable"* — which
   rules out cold storage that has to be restored before it can be read. Those
   two answers together define the archive: outside the ERP's transactional
   tables, inside something a user can still search.
3. **The freeze window needs a procedure, and D4 already has one.** "Controlled
   emergency transactions, recorded for later entry" is the same temporary-
   reference process D4 defined for an outage — date and time, responsible
   employee, counterparty, amount, supporting document, approval — and it should
   be the same procedure rather than a second one invented for cut-over.
4. **Reconciliation before cut-over is a gate, and it needs figures.** "Migration
   reconciliation has passed" means the trial balance, the A/R and A/P ageing,
   and the stock valuation all agree with the old system to the last dinar. The
   §9.9 inventory reconciliation and the §14.8 trial balance are already built
   and tested; Phase 21.2 runs them against migrated data rather than seeded
   data.
5. **Named owners map onto sign-off, which is already modelled.** §4.3's data
   ownership and the workflow engine's approver-is-a-person rule (§5.2) mean the
   sign-off can be a real approval in the system rather than an email — once the
   names exist.

**Recommendation:** approve the approach now and fix the target period; leave the
exact date conditional. Item (c) — the named owners — is worth doing early
precisely because it looks like paperwork: it is the item that turns "the data
looks right" into someone's signature at the go-live gate.

---

## D9 — Legal and compliance approval for Money Transfer

| | |
|---|---|
| **Status** | 🔴 Open |
| **Blueprint** | §26 go-live gate 5 |
| **Blocks** | Phase 21 exit — go-live |
| **Owner** | Legal / compliance → Business Process Owner |
| **Raised** | 2026-08-16 · **item 2 sharpened 2026-08-17** by the Phase 09 build |

> "Legal/compliance approval exists for regulated service processes, **especially Money Transfer**."

**What is needed**
1. Confirmation that the §12 process meets the applicable regulatory regime
2. KYC and AML control requirements to implement — Appendix E cites FATF MVTS guidance
3. Reporting or record-keeping obligations
4. Confirmation on client-fund handling and segregation

### Item 2, as Phase 09 now needs it: what does "KYC complete" contain?

Raised while building Phase 09 (`docs/open-questions-phase-09.md` §Q9.1) and kept
inside D9 rather than given its own number, because it is the same decision asked
as a data question instead of a policy one.

§21 requires KYC records linked to the partner and the transfer case, and Appendix
E cites the FATF MVTS guidance for *risk-based* controls. Neither says which
documents a client must produce, what the risk bands are, what each band obliges,
or how often identification must be renewed.

**What is built.** `kyc_risk_rating` and `kyc_required_document` are catalogues
Compliance fills; both ship **empty**. A transfer cannot be initiated unless the
client has an approved, unexpired KYC record carrying every active required
document that applies to their rating — enforced by trigger, on every path.

**The consequence of the empty catalogue, stated plainly.** With nothing
configured, "complete" reduces to *an approved, unexpired record*. That is a real
control and deliberately the weakest one that is still defensible. Every row
Compliance adds tightens it, with no code change.

**The risk this carries.** If the answer needs controls a document checklist
cannot express — transaction thresholds, sanctions screening, periodic review
triggers — those are new requirements under §28.1 and Phase 09 needs re-planning.
That is precisely the outcome D9 was raised early to surface.

**Why raise it now, not at go-live:** if compliance requires controls not in §12, those are new requirements needing a change request under §28.1, and Phase 09 must be re-planned. Discovering that at the go-live gate is discovering it too late.

---

## D11 — Accrual for confirmed but uninvoiced services

| | |
|---|---|
| **Status** | 🟡 Open — **built the defensible way; confirmation invited** |
| **Blueprint** | §8.2, §8.6, Appendix B, Appendix C |
| **Blocks** | Nothing today. Would become a Phase 16 (period close) requirement if the answer is yes |
| **Owner** | Finance → Business Process Owner |
| **Raised** | 2026-08-17, while building Phase 05.3 |

### The ambiguity (§28.2)

Two parts of the blueprint describe the Service Receipt / Expense Confirmation
differently, and the difference is a journal entry.

| Source | What it says |
|---|---|
| **Appendix B** | Service Receipt / Expense Confirmation · Benefiting Department · Draft, Pending Approval, Approved, Reversed · source: Purchase Order · effect: **"Receipt evidence / accrual"** |
| **Appendix C** | *No row for this document at all.* The nearest row is **"A/P Invoice – service/expense \| Expense / Service Cost \| Supplier A/P \| PO and Service Receipt required."** |

Appendix C is the posting matrix — the list of every accounting entry the system
makes. If the confirmation posted an accrual, it would have a row there. It has
none. But Appendix B's word *"accrual"* is not nothing either.

### What was built, and why

**The confirmation posts nothing.** It is receipt *evidence*: it proves the work
was delivered so the A/P Invoice can be three-way matched, and the expense
reaches the ledger at the invoice, exactly as Appendix C says.

This is expressed as a table property rather than a rule — `service_receipt` has
no journal link to fill in — so the document cannot acquire an accounting effect
by accident.

**No accounting treatment was selected by the implementation team.** Writing an
accrual journal would have been choosing one, which §28.1 forbids; not writing
one follows Appendix C, which is the blueprint's own authority on postings.

### The question

At period end, services confirmed but not yet invoiced are a real cost the
company has incurred and a real liability it owes. Does Finance want:

| # | Option | Consequence |
|---|---|---|
| 1 | **No accrual.** The cost lands when the invoice arrives | Simplest. Month-end expense depends on supplier invoicing speed, so a slow supplier moves cost into the next period. |
| 2 | **A period-end accrual**, reversed when the invoice posts | Dr Expense / Cr Accrued Expenses at close, from the confirmed-but-uninvoiced list. Needs an accrual account, and a Phase 16 close step. |
| 3 | **Accrue on confirmation**, like GRNI does for goods | The closest parallel to the goods flow — a "Services Received Not Invoiced" account playing GRNI's part. Most consistent, most work, and it would need a row in Appendix C. |

Option 3 is the one that makes the two purchasing flows symmetrical, which is
worth noting because the asymmetry is currently real: goods hit the balance
sheet at receipt (Dr Inventory / Cr GRNI) and services hit the P&L at invoice.

**Nothing is blocked.** The data needed for any of the three already exists —
every approved confirmation records what was delivered, when, for which
department, against which order line. Option 2 or 3 would be built in Phase 16;
option 1 is what runs today.

---

## D12 — Days Sales Outstanding: the formula and the period basis

| | |
|---|---|
| **Status** | 🟡 Built one way, confirmation needed |
| **Blueprint** | §22 KPI dictionary; §16; Phase 06.11 test gate |
| **Blocks** | Nothing — the figure computes, but it is not yet *the company's* figure |
| **Owner** | Business Process Owner (with Finance) |
| **Raised** | 2026-08-17 |

> §22, minimum KPI dictionary: *"**Days sales outstanding** — receivable
> collection indicator calculated from the **approved management formula** and
> **documented period basis**."*
> Phase 06.11 gate: *"Days sales outstanding computes per the documented
> formula."*

**The question.** The blueprint does not give a DSO formula. It says the formula
is management's and asks that it be documented — which makes choosing one a
business decision under §28.1, not a technical one. Three things need deciding
and they are independent:

**1. Which formula.**

| | Formula | What it does |
|---|---|---|
| a | **Classic**: `(closing A/R ÷ credit sales for the period) × days in period` | One division. Simple, comparable between months, and distorted by a lumpy month — a large sale on the last day inflates it. |
| b | **Countback** (exhaustion): walk back month by month, consuming the A/R balance against each month's sales until it is used up | Follows the actual ageing of the debt. Harder to explain, much less sensitive to one large late sale. |
| c | **Average-balance classic**: as (a), but `(opening + closing) ÷ 2` for A/R | A middle course; smooths a month-end spike without the countback's complexity. |

**2. Which sales.** Credit sales only, or all sales including cash? A cash sale
is collected the day it is made, so including it *lowers* DSO — which is
arithmetically true and arguably misleading, because DSO is meant to measure how
long credit takes to collect. The company makes both kinds of sale (§7.4), so this matters
here more than it does at most companies.

**3. Which period basis.** Calendar month, rolling 90 days, or year to date. The
same debt gives three different numbers.

**What is built, and why it is safe to proceed.** Option **(a)**, on **credit
sales only**, over a **caller-supplied date range** — the most common reading and
the one a Finance reader is least likely to be surprised by. The formula is not
hard-coded into a report: `domain/dso.ts` takes the components and the caller
states the range, so changing the answer is changing one function and its test
rather than hunting through queries.

**What changes if the owner prefers another.** Only that function. The
components — A/R balance, credit sales, days — are already separated, and the
ageing and statement figures they come from are unaffected: those are facts,
and DSO is an opinion about them.

**Related and also owed: the write-off threshold.** §16 requires a write-off to
have *"defined threshold, approval and reason code"*. The reason code and the
approval are built; the **threshold amount** is a number the company has to set.
It is configuration, defaulting to zero so that *every* write-off needs the
higher approval until Finance sets a figure — the same safe-by-default treatment
§8.4's receipt tolerance got.

---

## D13 — What makes a payment "high-risk"

| | |
|---|---|
| **Status** | 🟡 Safe default in force — **the figure is owed** |
| **Blueprint** | §17; Phase 07.3 test gate |
| **Blocks** | Nothing. Every payment currently takes the full control |
| **Owner** | Treasury + Finance → Business Process Owner |
| **Raised** | 2026-08-17, while building Phase 07.3 |

> §17: *"Creator, approver and executor shall be different users for **high-risk**
> payments."*
> §17 acceptance criterion 1: *"Payment batches enforce maker-checker controls
> and source approval."*

**The question.** §17 makes maker-checker conditional on a payment being
high-risk, and never says what high-risk means. That is a business decision:
it is the point at which the company decides a payment is worth three people's
time. Choosing it in code would be the implementation team setting the company's
own control threshold, which is exactly what §28.1 forbids.

**What is built.** A `payment_risk_policy` threshold — the **lowest amount that
is high-risk** — per branch with a company-wide default, seeded at **zero**. At
zero, every payment is high-risk and needs a separate creator, approver and
executor. A missing policy row means the same thing more strongly.

The direction of the default is the whole point, and it is the same one §16's
write-off threshold and §8.4's receipt tolerance already take: **a threshold
nobody has set is an unanswered question, not permission to skip the control.**

**What is needed.**

1. The amount at or above which a payment is high-risk — one figure, or one per
   branch if Baghdad and the others should differ.
2. Whether "high-risk" is only about **size**. Other readings are defensible and
   the mechanism would take them: a first payment to a new beneficiary, a
   payment to a beneficiary whose details changed recently, a cross-border
   payment, or a payment to a related party. Any of these can be added; none has
   been assumed.
3. Whether a **batch** is judged on its total or on its largest line. The batch
   total is used today, which is the stricter reading — ten small payments in one
   instruction still move one sum out of one account.

**What changes if the answer is a figure.** Only the seeded row. Batches already
record the threshold that was in force when they were raised, so raising it later
does not rewrite what an existing batch was judged against — an audit two years
from now can still see which rule applied.

---

## D14 — The payment-priority scale, and what happens to settlement discounts

| | |
|---|---|
| **Status** | 🟡 Mechanism built and deliberately neutral |
| **Blueprint** | §15; Appendix D |
| **Blocks** | Nothing. The run ranks by due date until the scale means something |
| **Owner** | Finance / Treasury → Business Process Owner |
| **Raised** | 2026-08-17, while building Phase 07.2 |

> §15: *"Include due items in payment proposal based on **due date, priority,
> discount** and available cash."*
> Appendix D, A/P reports: *"Due and overdue invoices, payment forecast and
> **discount opportunities**."*

§15 names three ranking inputs and defines none of them. Two need an answer.

### 1 · What "priority" means

There is a `payment_priority` on every supplier — 1 the most urgent, 9 the least
— and **every supplier sits at 5**. Nothing distinguishes them until somebody
decides what the scale is for, so the run ranks by due date in practice, which is
the behaviour nobody has to be told about.

What is needed: what the levels mean, who sets them, and — the part that actually
bites — **how priority trades against a due date when cash is short**. Today
priority wins outright, because §15 lists it first. A supplier at priority 1 with
an invoice due next week is therefore paid before one at priority 5 whose invoice
was due last month. That may be exactly right; it should be somebody's decision
rather than a consequence of the order of words in a sentence.

### 2 · Whether a settlement discount may be taken

`payment_terms` now carries a discount percentage and a discount window, and the
proposal **reports** what an early settlement would save and ranks by it.

**It does not deduct it.** Taking a discount means paying less than the invoice
says, and the difference has to land in an account — other income, a reduction of
the expense, or a credit note agreed with the supplier. Which one is an
accounting treatment, and §28.1 reserves those to Finance. Appendix C has no row
for it.

So the discount is an *opportunity* today: visible, ranked, and never applied. If
Finance wants discounts taken, three things are needed — the account the
difference posts to, who may authorise a short payment, and whether a discount
taken outside its window is refused or merely flagged.

**Nothing is blocked.** Both are ranking and reporting inputs; the payment run
works and the ledger is correct without either. The cost of leaving them is that
the run is less clever than §15 imagined, not that it is wrong.

---

## D15 — Which department and business line a system-generated posting belongs to

> **Moved to [`ImportantDecision.md`](ImportantDecision.md).** This is one of the
> three the build is waiting on today, and it is kept there in full so the short
> list stays short. Nothing about it changed; only where it lives.

---

# Raised by Phases 08 to 12, and by the Phase 09/10 merge

The nine entries D17 to D25 were written during the Phase 09 and Phase 10 builds
and held in `docs/open-questions-phase-09.md` and `docs/open-questions-phase-10.md`
because those phases were built on separate branches and neither would edit this
file behind the other's back. They are given D-numbers here. The two source
documents stay where they are — they carry the worked reasoning, and this register
carries the question.

**D16 was the tenth** and is already answered — see
[`DecisionAnswered.md`](DecisionAnswered.md#d16--one-client-import-register).

D26 to D28 are new, raised while building Phases 08, 11 and 12.

---

## D17 — Does a residual client balance belong to the client or to the company?

| | |
|---|---|
| **Status** | 🔴 Open — **the most consequential of the Phase 09 items**; mechanism built, treatment deferred |
| **Blueprint** | §12.4, §12.7, §22 KPI dictionary |
| **Blocks** | Nothing today. The Phase 09 exit gate — *"service margin … reconcile"* |
| **Owner** | Finance → Business Process Owner |
| **Raised** | 2026-08-17, building Phase 09 · full text in `docs/open-questions-phase-09.md` §Q9.2 |

A client funds an account, the goods are sent, and a small balance is left over.
§12.4 tracks a Remaining Client Balance but does not say what becomes of it: it is
refundable to the client, carried to their next cycle, or — after some period —
company income. Each answer posts differently and each changes what the service
margin means.

**What is built.** The balance is computed from deposits and usage, never stored,
so no answer is baked in. Nothing sweeps it anywhere.

---

## D18 — Is "Available" a state a client deposit can be in without being usable?

| | |
|---|---|
| **Status** | 🟡 Open — built as one state; a second is cheap to add |
| **Blueprint** | §12.3, Appendix B |
| **Blocks** | Nothing |
| **Owner** | Treasury → Business Process Owner |
| **Raised** | 2026-08-17 · `docs/open-questions-phase-09.md` §Q9.3 |

Appendix B lists Posted and Available as separate deposit statuses, which implies
a gap between them; §12.3 admits only cleared funds, which implies there is none.
Built as one state (`posted`). If a hold, a clearing delay, or a second pair of
eyes is wanted before client money can be spent, that is one status and one
transition — and it would be a **control**, so it may turn out to be part of D9.

---

## D19 — May a client hold more than one open account at once?

| | |
|---|---|
| **Status** | 🟡 Open — built permissive; balances are unambiguous either way |
| **Blueprint** | §12.3 |
| **Blocks** | Nothing |
| **Owner** | Treasury → Business Process Owner |
| **Raised** | 2026-08-17 · `docs/open-questions-phase-09.md` §Q9.4 |

§12.3 makes an account one funding cycle but does not say whether two cycles may
run at once. Built permissive: every deposit names its account and every transfer
draws only on its own account's deposits. Restricting it later is a partial unique
index — cheap now, disruptive once clients have history.

---

## D20 — Who bears a Money Transfer direct expense, by default?

| | |
|---|---|
| **Status** | 🟡 Open — built with **no default**, so every charge states it |
| **Blueprint** | §12.4, §12.6 |
| **Blocks** | Nothing |
| **Owner** | Finance → Business Process Owner |
| **Raised** | 2026-08-17 · `docs/open-questions-phase-09.md` §Q9.5 |

§12.6 settles one case — on a returned transfer *"the company absorbs all bank
charges"* — which shows the distinction matters without giving the general rule.
It changes the client's Remaining Client Balance and, on a return, whether the
refund is whole. `money_transfer_expense.charged_to_client` is NOT NULL with no
default and is frozen once posted, so nobody's silence decides and no posted
balance can be silently restated.

---

## D21 — Does a cross-branch bank debit need a Super User?

| | |
|---|---|
| **Status** | 🟡 A design consequence worth confirming, not a defect |
| **Blueprint** | §12.5, §5.1, §22 |
| **Blocks** | Nothing |
| **Owner** | Treasury → Business Process Owner |
| **Raised** | 2026-08-17 · `docs/open-questions-phase-09.md` §Q9.6 |

§12.5's own example combines a client transfer and a company import payment in one
bank debit, and those need not share a branch. Each line is row-level-security
scoped to its own branch (§22), and §5.1 makes Super User the only blanket grant —
so today only a Super User can compose such a batch. Accept it, give Treasury a
multi-branch data scope for this document type (a §5 decision, not a Phase 09 one),
or forbid cross-branch batches with a CHECK.

---

## D22 — Which clearing account a logistics client funding credits, at each job stage

> **Moved to [`ImportantDecision.md`](ImportantDecision.md).** This is one of the
> three the build is waiting on today, and it is kept there in full so the short
> list stays short. Nothing about it changed; only where it lives.

---

## D23 — How a part-funded logistics job divides at recognition

| | |
|---|---|
| **Status** | 🟡 Built the defensible way, confirmation invited |
| **Blueprint** | §11.4 |
| **Blocks** | Nothing |
| **Owner** | Finance → Business Process Owner |
| **Raised** | 2026-08-17 · `docs/open-questions-phase-10.md` §Q10-2 |

> §11.4: *"Service completion and recognition | **Client Logistics Clearing / Client A/R** | Logistics Revenue"*

Two possible debits and no statement of how a job funded 600,000 against a charge
of 1,500,000 divides. **Built funded-first:** discharge the clearing balance up to
what the client actually paid, bill the remainder to Client A/R. The reasoning is
not preference — debiting more clearing than was credited would leave a liability
account in debit, presenting an unfunded balance as money the company is holding.
Confirmation would settle whether Finance instead wants A/R taken first, leaving
client money on account until the job closes.

---

## D24 — What becomes of posted cost and client funding when a logistics job is cancelled

| | |
|---|---|
| **Status** | 🟡 Refused for now; the wider case is open |
| **Blueprint** | Appendix B |
| **Blocks** | Cancelling a job that has passed Approved |
| **Owner** | Logistics + Finance → Business Process Owner |
| **Raised** | 2026-08-17 · `docs/open-questions-phase-10.md` §Q10-3 |

Appendix B lists Cancelled among the Logistics Job statuses without saying what
happens to money already posted against the job. Cancellation past Approved is
refused — in the service with a message naming this question, and again by trigger.
Refusal is the recoverable direction: a job wrongly held open can be cancelled once
the rule is known; a job wrongly cancelled has already reversed postings.

---

## D25 — Accounting treatment of a logistics claim

| | |
|---|---|
| **Status** | 🟡 Posts nothing, by design |
| **Blueprint** | §11.1, §11.5, Appendix C |
| **Blocks** | Nothing — the claims register is built |
| **Owner** | Finance → Business Process Owner |
| **Raised** | 2026-08-17 · `docs/open-questions-phase-10.md` §Q10-4 |

§11.1 puts Claims and Exceptions in the Logistics menu and §11.5 requires a
Delivery Exceptions report, but **Appendix C — which is exhaustive — has no posting
row for a claim.** A claim for damaged goods plainly has financial consequences.
Needed: whether an open claim posts or only discloses; if it posts, at what point;
which account bears it and whether that differs by claim type; and whether a claim
against a carrier reduces that carrier's payable or stands as a separate
receivable. `logistics_claim` is a register with no journal link, and a claim must
be resolved or rejected before its job can close.

---

## D26 — What a duplicate customer match obliges

| | |
|---|---|
| **Status** | 🟡 Built to report, never to refuse; confirmation invited |
| **Blueprint** | §6 and its acceptance criteria |
| **Blocks** | Nothing |
| **Owner** | Sales + Compliance → Business Process Owner |
| **Raised** | 2026-08-17, building Phase 08 |

§6 requires duplicate detection across five criteria — name, phone, e-mail, tax
identifier and bank account — and requires that duplicates be *"identified"*. It
does not say what identification obliges.

**What is built.** Detection reports; it never refuses. A second enquiry from a
known customer is an ordinary event, and a system that blocked it would be worked
around within a week. Every match is returned with the criterion that produced it
and recorded in the audit trail, so no duplicate goes unnoticed.

**What is needed**

1. Whether any criterion is strong enough to *refuse* rather than warn. A repeated
   tax identifier or bank account is the likeliest candidate; both are the kind of
   match that is rarely innocent.
2. Whether a match on a **bank account** across two different partners should
   notify Compliance. It is the classic shared-beneficiary signal, and Phase 09's
   §12 work is what makes it visible.
3. Who merges duplicates once found, and whether a merge is reversible.

---

## D27 — Progress measurement, retention release and advance recovery on projects

| | |
|---|---|
| **Status** | 🟡 Mechanisms built and neutral; the rates are per contract, the *rules* are not stated |
| **Blueprint** | §10 |
| **Blocks** | Nothing today. It sits beside D1 |
| **Owner** | Finance + Projects → Business Process Owner |
| **Raised** | 2026-08-17, building Phase 11 |

D1 covers recognition. These three are adjacent and were not settled by it.

1. **Who may approve a progress measurement, and against what evidence.** §10
   requires measured progress to gate certification, and the build enforces
   `certificate ≤ measured progress` by trigger. It does not say whether a client
   representative's signature is required or an internal approval suffices.
2. **When retention releases.** Retention accumulates as movements and can never go
   negative. §10 does not say whether release is at practical completion, at the end
   of a defects period, or in instalments — nor whether a partial release needs the
   same approval as the certificate that withheld it.
3. **How an advance recovers.** `advance_recovery_percent` is per project. What is
   unstated is whether recovery is proportional on every certificate, deferred until
   a threshold, or subject to a minimum — and what happens if a contract ends with
   an advance unrecovered.

Each is a rate today and a rule tomorrow. Until answered, the figures are recorded
and reported but nothing recovers or releases automatically.

---

## D28 — Whether depreciation re-bases after an impairment

| | |
|---|---|
| **Status** | 🟡 Built the straightforward way; a method change if Finance wants otherwise |
| **Blueprint** | §18, Appendix E (IAS 16; IAS 36 by implication) |
| **Blocks** | Nothing |
| **Owner** | Finance → Business Process Owner |
| **Raised** | 2026-08-18, building Phase 12 |

§18 requires impairment to be visible separately from depreciation, and it is: two
accounts, two registers, one net book value. What §18 does not say is whether the
**future depreciation charge** changes after an impairment.

**What is built.** It does not. Straight line charges cost less residual over the
useful life, and the impairment sits in its own account. Carrying value reflects
both, and the register and the G/L agree.

**The alternative.** IAS 36 §63 bases post-impairment depreciation on the *revised*
carrying value over the remaining life. Under that reading, a 20,000 impairment on
a 120,000 asset with 33 months left would cut every future charge. Both are
defensible; they produce different monthly profit and are not a rounding apart.

**What is needed:** one answer, and whether it applies per category or per asset.
It is a configuration field and a branch in `monthlyCharge` — small, and much
smaller before there are impairments in the ledger than after.

---

## D29 — Who may see a client import file, now that one register serves both services

| | |
|---|---|
| **Status** | 🔴 Open — a consequence of D16 that D16 did not settle |
| **Blueprint** | §5.1, §5.3, §11, §12.6, §21 |
| **Blocks** | Nothing today. It is a permission question, and permissions are configuration |
| **Owner** | Compliance + Operations → Business Process Owner |
| **Raised** | 2026-08-18, on merging the registers |

**What changed.** Before D16 there were two tables and therefore two permission
objects: `logistics_client_import_file` and `client_import_file`, each with its
own `role_grant` rows. §5.3 checks a user against the object, so a Logistics
clerk saw logistics import files and a Money Transfer clerk saw transfer ones,
without anybody having decided that — it fell out of the table split.

One register means one object. Migration `0155` merged the two grant sets as a
**union**, because narrowing a grant silently is how a control becomes an outage:
Logistics held `print` and `configure` that Money Transfer did not, Money
Transfer held `reverse_cancel` that Logistics did not, and both services still do
the work those verbs describe.

**The consequence, stated plainly.** A Logistics clerk with `view` on
`client_import_file` can now see an import file that arose from a Money Transfer
client, in their own branch. Row-level security still confines them to that
branch (D10), and the file itself carries no amount from either service — but it
carries the client, the consignment and the origin country.

**Why this is a question and not a defect.** Both readings are defensible:

| | Reading | Consequence |
|---|---|---|
| a | One consignment, one record, one visibility. If the two services share a case, the people running them share the case | No change. What is built |
| b | Money Transfer is a regulated service (§21, D9) and its client files carry information a logistics clerk has no business need for | Not a grant change — a grant is per object and the object is now shared. It would need a **row-level rule**, in the shape of D10's branch policy: a Logistics role sees rows with no Money Transfer client account, and Compliance sees all |

**What is needed**

1. Whether a Logistics user should see an import file that belongs to a Money
   Transfer client.
2. If not: whether the boundary is *has a client account* or something narrower —
   a risk rating, a flag Compliance sets.
3. Whether the reverse holds. A Money Transfer clerk can now see logistics-only
   files; that is the same question with the parties swapped, and it is likelier
   to be acceptable.

**Why it is worth answering before go-live and not after.** A row-level policy
added later is a migration and a re-test of every read path on the table. Added
now it is one policy beside the branch policy that is already there. This is the
same shape as D21, and probably the same conversation.

---

## D30 — The four thresholds that are seeded at zero, and who owns each

| | |
|---|---|
| **Status** | 🟡 All four in force at their strictest; four numbers owed |
| **Blueprint** | §8.4, §15, §16, §17 |
| **Blocks** | Nothing. Every one of them **tightens** rather than permits |
| **Owner** | Four different people — see the table |
| **Raised** | 2026-08-18, sweeping the configuration for the programme ruling's test |

**Why this entry exists.** All four are already mentioned somewhere in this
register — two of them inside D12 and D13, in passing. Nobody scanning for what
they owe would find them there, and each is a single number. Gathered here so
they can be answered in one sitting.

**They all pass the [programme ruling](#programme-ruling--d1-d2-and-d3-build-the-mechanism-leave-the-business-values-empty)'s
test**, which is why none of them blocks anything: a threshold of zero makes the
system *stricter*, not looser. Every variance is a decision, every write-off needs
the higher approval, every payment takes the maker-checker route. The cost of
leaving them is not risk — it is that people approve things all day that the
company would rather they did not have to.

| Table | The number | Today | Whose |
|---|---|---|---|
| `ap_match_tolerance` | Quantity, price and value variance a three-way match may absorb (§8.4) | **0%** — nothing absorbed, every variance goes to a manager | Finance |
| `purchase_receipt_tolerance` | Over-receipt allowed against a purchase order (§8.4) | **0%** — every over-receipt is a decision | Purchasing |
| `ar_write_off_policy` | Write-off below which the ordinary approval suffices (§16) | **0 IQD** — every write-off needs the higher approval | Finance (raised under D12) |
| `payment_risk_policy` | Amount above which a payment is high-risk (§17) | **0 IQD** — every payment needs separate creator, approver and executor | Finance (this is **D13**) |

**What is needed:** four numbers. Each is per-company by default, and three of the
four also accept a per-supplier, per-item or per-branch override if the business
wants one — so "it depends" is a supported answer, not a blocked one.

**What is deliberately not here.** `kyc_risk_rating`, `kyc_required_document` and
`logistics_funding_stage_role` also ship empty, but they are not thresholds and
they do not fail safe in the same way. The first two are D9 — an empty catalogue
means "an approved, unexpired record", which is the *weakest* defensible reading
rather than the strictest. The third is D22, and it refuses to post at all. Both
are already in the register with that difference stated.

---

## D31 — What role does an investment counterparty hold in the partner master?

| | |
|---|---|
| **Status** | 🟡 Built the defensible way; the master data is slightly wrong until answered |
| **Blueprint** | §4.4, §13 |
| **Blocks** | Nothing. It is a data-quality question, not a posting one |
| **Owner** | Finance + Master Data → Business Process Owner |
| **Raised** | 2026-08-18, building Phase 13 |

**How it surfaced.** §13 requires an investment to name its counterparty, and
§4.4 requires *one identity per counterparty* — so the investee is a Business
Partner rather than a second master. But `business_partner` carries a CHECK:

```
business_partner_has_role  CHECK (is_customer OR is_supplier)
```

Those are the only two roles the master has, and **an investee is neither.** It
does not buy from the company and it does not sell to it. It is a company the
company owns a stake in.

**What is built.** An investment counterparty is recorded as a **supplier**,
because money flows to it at acquisition and that is the nearest true thing the
model can say. Nothing depends on the flag — the investment module never reads
it, and the partner is used only for identity and reporting.

**Why it still matters.** The supplier ledger, the A/P ageing and the supplier
reports all key on `is_supplier`. An investee marked as a supplier will appear in
lists of people the company buys from, with no transactions, forever. That is not
a misstatement of the accounts, but it is a misstatement of the master data, and
those get harder to correct as they accumulate.

**Options**

| | Option | Consequence |
|---|---|---|
| a | Leave it. Investees are suppliers with no purchases | No change. They clutter supplier lists |
| b | Add `is_investee` beside the other two, and relax the CHECK to include it | One column and one constraint change. The supplier reports keep meaning what they say |
| c | Investment counterparties are not Business Partners at all | Contradicts §4.4's one-identity rule, and loses the link when the same company is *also* a customer — which is exactly the case §4.4 exists for |

**What would settle it in one question.** *Should a company the business holds a
stake in appear in the supplier list?* If no, (b).

**Cost of a late answer.** (b) is a column and a CHECK today. Once investees have
accumulated in the supplier master, it is also a data-cleansing exercise across
whatever reports and ledgers have been built on the flag in the meantime.

---

# What the phases still to be built will need

Added 2026-08-18, at the request of the Business Process Owner: *"what is needed
for current that have completed in the phases but not decided, [and] what is
needed in future so far."* Everything above answers the first half. This section
answers the second.

Nothing here has a D-number yet, and deliberately so. A decision register that
fills up with questions nobody is being asked to answer stops being read. These
are **flagged early because they are cheap now and expensive later** — each one
is either a configuration table that must be populated before a phase can be
used, or a policy that determines what gets built rather than how.

The rule they are held to is the one in the
[programme ruling](#programme-ruling--d1-d2-and-d3-build-the-mechanism-leave-the-business-values-empty):
build the mechanism, leave the value empty, and make sure emptiness refuses
rather than permits. Where that is not possible, the item is marked ⚠.

---

## Phases already built, with work deliberately left

| Phase | What is not built | Why | Needs a decision? |
|---|---|---|---|
| 08 CRM | Lead import through the Phase 01 import framework | Sequencing only | No |
| 08 CRM | Opportunity-to-project conversion | Needed Phase 11, which now exists | No — schedule it |
| 08 CRM | Customer 360 across Logistics and Money Transfer history | Reachable only since the 09/10 merge | No — schedule it |
| 09 Money Transfer | Bank Execution Batch does not reconcile to a bank statement (§12.5, §12.7) | Phase 07.7's set-against-set matching was built for exactly this; the two were built on separate branches | No — it is wiring, not design |
| 11 Projects | 11.5 project labour and timesheets | The interface exists; Phase 15 is the source | No |
| 11 Projects | 11.6 subcontracts | Needs its own document set | No |
| 11 Projects | 11.10 WIP and revenue recognition | **D1** | Yes — D1 |

The four "no" rows are the honest ones to act on first: they are finished work
waiting to be connected, not questions waiting to be answered.

---

## Phase 13 — Investments

**Governed by D2.** §13 is explicit that the IT team implements configurable
types and posting rules *"only after Finance defines the required categories"*.
Under the programme ruling the register, the type structure, the mappings, income
events and disposal mechanics may all be built. The category list ships empty.

Also likely to surface, once building starts:

- Which categories require **related-party approval**, and what that approval is.
  §13 asks for it without defining the relationship test.
- Whether an investment can be held in a currency other than IQD or USD, which
  decides whether §14's two-currency model reaches far enough.

---

## Phase 14 — Budgeting

No open decision blocks it, but two things must come from the business rather
than from the build:

1. **What a budget check does when it fails.** §19 requires commitment control
   and a budget check. It does not say whether an over-budget purchase is
   *refused*, *warned*, or *routed for approval* — and whether the answer differs
   by amount, by account, or by who is asking. This is the same shape as D13 and
   should get the same treatment: build all three behaviours, configure none.
2. ⚠ **Allocation drivers.** §19 requires allocations to *"use documented drivers
   and create auditable journals"*. A driver is a business rule — headcount,
   floor area, revenue share — and there is no safe empty default: an allocation
   rule with no driver cannot run, which is correct, but an allocation rule with a
   *plausible* driver silently misstates departmental profit. Finance must supply
   the drivers before 14.6 is switched on.

---

## Phase 15 — HR and Payroll

**Governed by D3**, and the blueprint prescribes the sequencing itself: HR master,
employee expenses and advances first; payroll only once the formulas are signed.
Two adjacent items are not covered by D3:

- **Offboarding clearance.** §20 requires it, and Phase 12 already exposes
  `assetsHeldBy(userId)` for the asset half. What clearance must *cover* —
  assets, cash advances, project commitments, document custody — is a policy list.
- **Whether an unrecovered advance survives termination**, and against what it
  offsets. It touches D27's third item.

---

## Phase 16 — Close and statements

The phase where several existing open items stop being theoretical:

| Existing item | What Phase 16 does to it |
|---|---|
| **D11** accrual for uninvoiced services | The close is where the accrual is made or not made |
| **D12** DSO formula | 16.7's control reports publish it |
| **D15** dimensions on system-generated postings | Every one of the seven kinds posts during the close |

New, and worth raising before 16.3 is built:

- ⚠ **Whether FX revaluation reverses in the following period.** §26's UAT
  scenario says *"with reversal in the next period **where policy requires**"* —
  the blueprint defers to a policy that does not exist yet. Both behaviours are
  buildable and both are common. The gate "reversal restores the pre-revaluation
  position exactly" can only be tested once it is known whether reversal happens.
- **Which balances are revalued.** Monetary items only, per IAS 21 — but which
  accounts the company treats as monetary is a mapping, and it must exist before the first
  revaluation rather than after.
- **What may remain open when a period closes.** §16 requires the close to be
  gated; the list of conditions is a business one.

---

## Phase 17 — Documents

- ⚠ **Retention periods and confidentiality classifications.** §21 requires them
  to be *"configurable rather than hard-coded"*, which the build will honour — but
  configurable and empty means nothing is ever disposed of, and that is a legal
  exposure rather than a safe default. Legal must supply the periods.
- **Who may impose and lift a legal hold**, and whether lifting one requires two
  people. A hold that one person can lift is not a hold.
- **What "authorised administrator" means for disposal** (§21) — a role, or a
  named individual.

---

## Phase 18 — Reporting

Largely mechanical, with one exception: **who may see what, in the reports that
cross branches**. D10 settled the transaction boundary. A consolidated report is
the one place where a legitimate business need points the other way, and §22's
report list contains several. Expect a data-scope decision in the shape of D21.

---

## Phase 19 — Integrations

- **The interface catalogue** — which external systems the company actually connects to.
  §23 requires each interface to have a **named reconciliation owner**, and that
  is a person, not a design.
- **What happens to a failed inbound accounting interface.** §23 requires
  idempotency and a dead-letter queue, both of which the build provides. Whether a
  message that dead-letters raises an alert, blocks the close, or waits is policy.

---

## Phase 20 — Non-functional hardening

**D5 item 6** — the response-time targets — is the only outstanding input, and it
is the cheapest answer in this file. D4 and D6 are answered and in
`DecisionAnswered.md`.

---

## Phase 21 — Migration and go-live

- **D8** — the cut-over date, the historical depth, and the named owner of each
  §26 data class. The approach is proposed and needs a signature.
- **D9** — legal and compliance approval for Money Transfer, including what
  "KYC complete" contains. This is a go-live gate, not a build gate, and it is the
  one on this list with the longest external lead time.
- **What the parallel run must agree on before go-live is declared.** §26 requires
  a parallel run; the tolerance — exact agreement, or agreement within a stated
  materiality — is Finance's to set, and setting it afterwards is not setting it.

---

## The pattern worth noticing

Of the twenty-six open items above, exactly **two** stop work today: D22, which
refuses to post, and D15, which will refuse to depreciate. Every other one is
either a value to configure or a confirmation of something already built the
defensible way.

That is the programme ruling working. It is also why the count keeps rising
without the build slowing down — and why the count must be read as *work owed to
the business*, not work owed by the build. Each unanswered item is a place where
the system will do the safe thing rather than the right thing, and the two are
only the same until somebody notices.
