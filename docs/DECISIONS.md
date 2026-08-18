# Decision Register

**Phase 00.7** · Blueprint §28.2 · answered decisions are in [`DecisionAnswered.md`](DecisionAnswered.md)

> "When a technical constraint or ambiguity is identified, the IT specialist shall document the issue and available technical options. Issa Mohammed selects and approves the final business treatment. The IT specialist shall not select a business or accounting outcome independently."

This register exists so that what has **not** been decided stays visible. A decision made quietly in code is a change-control breach under §28.1, not a shortcut.

Decisions that have been made move to [`DecisionAnswered.md`](DecisionAnswered.md) in full, with what each one changed in the build. This file holds only what is still owed, so the list of open questions cannot be lost among the answered ones.

**Owner of every business decision:** Issa Mohammed, Business Process Owner.

---

## Status summary

| Status | Count |
|---|---|
| 🔴 Open — blocking a phase | 5 |
| 🟡 Partially answered | 6 |
| 🟢 Decided — moved to `DecisionAnswered.md` | 4 |

| # | Decision | Status | Blocks |
|---|---|---|---|
| D1 | Project revenue and cost recognition | 🔴 Open | Phase 11.10 |
| D2 | Investment categories and valuation | 🔴 Open | Phase 13.1, 13.5 |
| D3 | Payroll formulas and deductions | 🔴 Open | Phase 15.9 |
| D5 | Volumes and retention | 🟡 All but response-time targets | Phase 20.4 judgement |
| D8 | Cut-over date and historical depth | 🟡 Approach proposed, awaiting approval | Phase 21.1 |
| D9 | Money Transfer legal approval | 🔴 Open | Phase 21 go-live |
| D11 | Accrual for confirmed uninvoiced services | 🟡 Built the defensible way, confirmation invited | Nothing — would be Phase 16 |
| D12 | Days Sales Outstanding formula and period basis | 🟡 Built one way, confirmation needed | Nothing — the figure computes |
| D13 | What makes a payment "high-risk" | 🟡 Safe default in force, figure needed | Nothing — every payment takes the control |
| D14 | Payment priority scale and settlement discounts | 🟡 Mechanism built and neutral | Nothing — the run ranks by due date |
| D15 | Dimensions on system-generated expenses | 🔴 Open | Nothing yet — recurs at Phase 16 close |

**Answered and moved out:** D4 (availability and recovery), D6 (accessibility),
D7 (Chart of Accounts) and D10 (branch access and the Active Branch) — all on
2026-08-17, all by Tishko. **D7's answer released the Phase 02 and Phase 04
acceptance hold**, which was the single largest thing standing in front of the
build. **D10 replaced the session-branch model** Phase 01 had chosen, which in
turn unblocked §7.2 multi-branch Sales Orders in Phase 06.

**Most urgent now: D1, D2 and D3.** Each blocks a whole phase outright — 11, 13
and 15 — and none has a partial answer to build on. They are also the three that
cannot be answered by IT under any reading of §28.1: they are accounting policy
and statutory rules, not technical choices.

**Cheapest to answer: D5 item 6** — response-time targets. One short table, and
without it the §25 load test can be run but not judged.

**Waiting on a signature rather than a decision: D8.** The migration approach was
proposed on 2026-08-17 and needs the Business Process Owner's written approval
under §28.1. Two things inside it are still genuinely open: the target cut-over
period, and the named owner of each §26 data class.

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

| | |
|---|---|
| **Status** | 🔴 Open |
| **Blueprint** | §13 |
| **Blocks** | Phase 13.1 (type list), Phase 13.5 (valuation and impairment) |
| **Owner** | Finance → Business Process Owner |
| **Raised** | 2026-08-16 |

**The blueprint's own words**

> "The legal and accounting treatment of investments differs by instrument. The IT team must implement configurable types and posting rules only after Finance defines the required categories."
> "Valuation methods and frequency require Finance approval."

**What is needed**
1. The investment category list
2. Required fields per category
3. Account mappings per category
4. Valuation method and frequency per category
5. Impairment trigger and measurement basis
6. Which categories require related-party approval

**Reference:** Appendix E cites IFRS 9.

**Can proceed without it:** the configurable structure, the register, income events, disposal mechanics.

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
For scalability, I would change the way D1, D2 and D3 are treated.


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
| **Raised** | 2026-08-16 |

> "Legal/compliance approval exists for regulated service processes, **especially Money Transfer**."

**What is needed**
1. Confirmation that the §12 process meets the applicable regulatory regime
2. KYC and AML control requirements to implement — Appendix E cites FATF MVTS guidance
3. Reporting or record-keeping obligations
4. Confirmation on client-fund handling and segregation

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
long credit takes to collect. QS makes both kinds of sale (§7.4), so this matters
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

## D15 — Which department and business line a system-generated expense belongs to

| | |
|---|---|
| **Status** | 🔴 Open |
| **Blueprint** | §4.2; migration 0005 |
| **Blocks** | Nothing today. It recurs at every Phase 16 close step |
| **Owner** | Finance → Business Process Owner |
| **Raised** | 2026-08-17, while building Phase 07.5 |

### The problem

§4.2 — as built in migration 0005 — makes **department and business line
mandatory on every expense account**. That was the right answer for expenses a
person raises: somebody bought something, for some department, in some line of
business, and the system should not let them avoid saying which.

Some expenses have nobody to ask. They are produced by the system from a fact
about the ledger rather than from anybody's decision:

| Expense | Where it comes from | Who would the department be? |
|---|---|---|
| **Cash count variance** (§17) | A float was counted and disagreed with the books | The custodian's department? The branch's? Nobody's? |
| **FX revaluation difference** (§16) | A rate moved between posting and close | It belongs to a currency, not a department |
| **Rounding difference** | Arithmetic | Nobody's |
| **Bank charges** (§17, Appendix D) | The bank took a fee | Finance's? The account's branch? |

Each has a branch — that much is always known. None has a department or a
business line that anybody chose.

### What is built

The mechanism §4.2 requires, unchanged. Where a system-generated posting has no
department to give, the **requirement is relaxed on that specific account**
through the existing per-account configuration (`chart_of_account`'s required
dimensions), rather than by inventing a value or weakening the rule generally.

That is a configuration decision made per account, and it is visible: an account
with no required dimensions says so, and can be listed.

### What is needed

1. For each of the four kinds above, one of: **a department to use**, **a
   department per branch**, or **confirmation that none is required**.
2. Whether the same answer covers business line, or whether the two differ.
3. Whether Finance wants these postings gathered into a single "unallocated"
   department so that they are visible as a total rather than invisible as an
   absence — which is the option most likely to be wanted and the least likely
   to be asked for.

### Why it is worth answering before Phase 16

Every one of these appears in the close. If the answer is "they need a
department", it is a small configuration change made once; if it is discovered
during the close, it is discovered while somebody is trying to close.



Yes — this is the right approach.

The key principle is:

Build the mechanism, leave the business values empty.

That keeps development moving without forcing Finance to answer everything immediately, while still respecting the blueprint.

For the three items:

D1 — Projects: build Phases 11.1–11.9 and 11.11–11.12. Leave only the revenue-recognition/WIP calculation in 11.10 inactive until Finance supplies the policy.
D2 — Investments: build the register, configurable type structure, mappings, income events and disposal logic. Leave the investment categories, valuation methods and impairment rules empty until Finance defines them.
D3 — Payroll: build HR master, expenses, advances and the payroll framework. Do not activate payroll calculations until HR/Finance provide the formulas and statutory rules.

The important distinction is that zero/neutral defaults are only safe where they make the system stricter or inactive. There is no safe neutral default for:

revenue-recognition method,
investment valuation basis,
payroll formula.

So those should remain unconfigured, not guessed.

I would also keep D1/D2/D3 marked 🔴 Open for business policy, but add something like:

Development impact: The surrounding configurable framework may proceed. Only the accounting/payroll treatment that depends on an approved policy remains blocked.

That makes it clear that “Open” does not mean the whole phase is stopped.

And your idea about getting worked examples instead of long policy documents is very good. For example, five real payroll examples or three sample project contracts with expected accounting entries would probably be more useful to development and UAT than a long written explanation.