# Decisions Needed Now

**As at 2026-08-19** · **Blueprint §28.2** · the short list · full register in [`DECISIONS.md`](DECISIONS.md) · answered in [`DecisionAnswered.md`](DecisionAnswered.md)

> "When a technical constraint or ambiguity is identified, the IT specialist shall document the issue and available technical options. Issa Mohammed selects and approves the final business treatment. The IT specialist shall not select a business or accounting outcome independently."

**Owner of all three:** Issa Mohammed, Business Process Owner, with Finance.

---

## The one thing to take from this page

**Three finished modules cannot be used in production, and each is waiting on one
configuration answer.**

| Module | State | Waiting on | Consequence today |
|---|---|---|---|
| **Phase 10 — Logistics** | Built, tested | **D22** | Cannot take a client's money at all |
| **Phase 12 — Fixed Assets** | Built, tested | **D15** | A live depreciation run fails on the first asset |
| **Phase 13 — Investments** | Built, tested — **finished 2026-08-19** | **D2** | Not one investment can be recorded |

None of the three is a design problem. Every mechanism is built, tested and
waiting; what is missing in each case is a small table of business values that
only Finance can supply. Between them they are **a four-row table, a category
list, and seven rows.**

This is the ruling working as intended, not failing: each of those tables ships
**empty**, and empty **refuses**. Nothing has been guessed, so nothing has to be
unpicked later. But the bill for that comes due as soon as the modules are
needed, and for three of them it is now due.

---

## Why this file exists

The register holds twenty-six live items. Most of them block nothing: they are
confirmations of something already built the defensible way, or a value whose
absence makes the system **stricter** rather than looser.

Three do not fit that description, and each is answerable in a sitting. They are
here in full so that the short list stays short.

**Everything else can wait, and saying so is the point.** A list of three that
are genuinely urgent is worth more than a list of twenty-six in which the urgent
ones are buried.

---

## At a glance

| | Decision | The answer looks like | What it is holding up |
|---|---|---|---|
| **1** | **D22** — which clearing account a logistics funding credits, per job stage | **Four rows** — for Draft, Approved, In Progress, Delivered, pick *Client Logistics Clearing* or *Deferred Service Balance* | Phase 10 **cannot take a client's money**. The only item in the register that stops a posting outright |
| **2** | **D2** — investment categories and valuation methods | **Two catalogues**, plus required fields and account mapping per category | **Phase 13 finished today** and cannot record a single investment. Promoted from third to second: it is no longer a phase in flight, it is a phase waiting |
| **3** | **D15** — dimensions on system-generated postings | **Seven rows** — a named department, the branch default, or *none required* | Phase 12 is built and waiting. A live depreciation run fails on the first asset |

**What changed since the last revision of this page (2026-08-18):** D2 moved up.
It was "the phase being built around the gap"; Phase 13 is now complete, so it is
a finished module that refuses every entry. Nothing else on the short list moved,
and nothing new joined it.

---

## What happens if these are late

**D22** — Phase 10 stays unusable. It is a four-row table, so every day it waits
is a day a finished module sits idle for want of two words per stage.

**D2** — Phase 13 is now finished, so the cost has changed shape. It is no longer
"the build proceeds around the gap"; it is a complete module that refuses every
entry. The real risk is the pressure to *"just put something sensible in for
now,"* and §13 warns against precisely that: an investment posted under an
invented category is a misstatement **no test would catch**, because the test
would be written against the same invented rule.

**D15** — every month adds system-generated postings that will have to be
classified twice: once by whatever the system does in the absence of an answer,
and again when the answer arrives.

---

## D22 — Which clearing account a logistics client funding credits, at each job stage

| | |
|---|---|
| **Status** | 🔴 **Open and blocking** — the only open item that stops a posting outright |
| **Blueprint** | §11.4 |
| **Blocks** | Phase 10.4 — client funding cannot be posted at all |
| **Owner** | Finance → Business Process Owner |
| **Raised** | 2026-08-17 · `docs/open-questions-phase-10.md` §Q10-1 |

> §11.4: *"Client logistics funding or charge | Bank, Cash or Client Account | **Client Logistics Clearing / Deferred Service Balance according to document stage**"*

The blueprint names two credit accounts and says the choice depends on the stage.
It does not say which stage takes which. *Client Logistics Clearing* is money held
on the client's behalf; *Deferred Service Balance* is consideration for a service
not yet performed. Which one a receipt belongs in is a judgement about when the
company's obligation arises.

**What is needed:** one value for each stage at which funding can be received —
Draft, Approved, In Progress, Delivered. It is a four-row table, not a policy
document, and it is **the cheapest blocking answer in this register.**

**What is built.** `logistics_funding_stage_role` exists and posting resolves
through it. It ships **empty**, so funding cannot post — which is the ruling
working as intended: emptiness refuses.

---

## D2 — Investment categories, valuation methods and posting rules

| | |
|---|---|
| **Status** | 🔴 Open — **and the phase is now finished and waiting** (2026-08-19) |
| **Blueprint** | §13 |
| **Blocks** | All of Phase 13 in practice. Nothing can be recorded until the category list exists |
| **Owner** | Finance → Business Process Owner |
| **Raised** | 2026-08-16 · escalated 2026-08-19 when Phase 13 completed |

**The blueprint's own words**

> "The legal and accounting treatment of investments differs by instrument. The IT team must implement configurable types and posting rules only after Finance defines the required categories."
> "Valuation methods and frequency require Finance approval."

**What "empty" buys, concretely.** `investment_type` and
`investment_valuation_method` are catalogues that ship with no rows. An investment
names a type through a foreign key and a valuation names a method the same way, so
**neither can be recorded until Finance fills them.** Nothing in the code
enumerates a category or a method, and **no test names one**, so there is no
invented rule for a test to quietly agree with.

That last point is the whole reason this was worth doing the slow way. A seeded
list of plausible categories would have made every test pass against a rule nobody
approved, and the error would have surfaced in a financial statement rather than
in a test run.

**One gate in Phase 13 is left open specifically because of this**, and it is
recorded that way in the phase document rather than ticked: *"the approved method
reproduces Finance's worked examples."* There is no approved method, so there is
nothing to reproduce. The mechanism is tested; the answer is owed.

**What is needed, in the order it unblocks things**

1. **The category list.** Without it nothing can be recorded at all.
2. **The required fields per category** — held as data, so this is a list per row.
3. **The account mapping per category**, through §3.3's Accounting Mapping.
4. **The valuation methods and their review frequency.**
5. **The impairment trigger and measurement basis.**
6. **Which categories need related-party approval** — already a flag per type,
   awaiting its values.

Items 1 and 4 alone make the module usable. The rest can follow.

**Reference:** Appendix E cites IFRS 9.

**Built and waiting on nothing:** the configurable structure, the register,
proposal and two-stage approval, Treasury-routed funding, income events, valuation
history, impairment, partial and full disposal, the capital-call calendar and the
portfolio report.

---

## D15 — Which department and business line a system-generated posting belongs to

| | |
|---|---|
| **Status** | 🔴 Open — **and now recurring**; widened at Phase 12 |
| **Blueprint** | §4.2; migration 0005 |
| **Blocks** | Nothing today. It recurs at every Phase 16 close step, and now in every depreciation run |
| **Owner** | Finance → Business Process Owner |
| **Raised** | 2026-08-17, while building Phase 07.5 · widened 2026-08-18 at Phase 12 |

> **Widened 2026-08-18, at Phase 12.** This was raised about *expenses*. Phase 12
> produced the same problem on the revenue side — a gain on disposal is credited to
> a revenue account, and §4.2 makes **business line** mandatory on revenue accounts.
> Nobody chooses a business line for a gain that arises because an asset sold for
> more than its written-down value. The question is therefore about system-generated
> **postings**, not system-generated expenses, and the table below has grown.

### The problem

§4.2 — as built in migration 0005 — makes **department and business line mandatory
on every expense account**. That was the right answer for expenses a person raises:
somebody bought something, for some department, in some line of business, and the
system should not let them avoid saying which.

Some postings have nobody to ask. They are produced by the system from a fact about
the ledger rather than from anybody's decision:

| Posting | Where it comes from | Who would the department be? |
|---|---|---|
| **Cash count variance** (§17) | A float was counted and disagreed with the books | The custodian's department? The branch's? Nobody's? |
| **FX revaluation difference** (§16) | A rate moved between posting and close | It belongs to a currency, not a department |
| **Rounding difference** | Arithmetic | Nobody's |
| **Bank charges** (§17, Appendix D) | The bank took a fee | Finance's? The account's branch? |
| **Depreciation** (§18.5) | Time passed | The asset has a department — but the *charge* is nobody's decision |
| **Impairment loss** (§18) | An asset was written down | The asset's department, or Finance's? |
| **Gain or loss on disposal** (§18.6) | Proceeds differed from carrying value | Which **business line** profits from selling a mixer? |

Each has a branch — that much is always known. None has a department or a business
line that anybody chose.

Depreciation is the mildest of these and the most instructive. The asset *does*
carry a department, and each charge is stamped with the asset's own — so the answer
is available. But it was chosen for the asset, not for the charge, and a transfer
changes it mid-life. The build carries it forward because doing so is what makes the
register reconcile by dimension; whether Finance wants the charge to follow the asset
or to sit somewhere fixed is still their call.

### What is built

The mechanism §4.2 requires, unchanged. Where a system-generated posting has no
department to give, the **requirement is relaxed on that specific account** through
the existing per-account configuration (`chart_of_account`'s required dimensions),
rather than by inventing a value or weakening the rule generally.

That is a configuration decision made per account, and it is visible: an account
with no required dimensions says so, and can be listed.

### What is needed

1. For each of the seven kinds above, one of: **a department to use**, **a
   department per branch**, or **confirmation that none is required**.
2. Whether the same answer covers business line, or whether the two differ.
3. Whether Finance wants these postings gathered into a single "unallocated"
   department so that they are visible as a total rather than invisible as an
   absence — which is the option most likely to be wanted and the least likely to
   be asked for.

### Why it is worth answering before Phase 16

Every one of these appears in the close. If the answer is "they need a department",
it is a small configuration change made once; if it is discovered during the close,
it is discovered while somebody is trying to close.

**And now before Phase 12 runs in production.** A depreciation run against accounts
that still require a department fails on the first asset. The Phase 12 tests clear
the requirement on the four affected accounts to prove the gate rather than the gap,
and the mapped accounts must be configured the same way before the first live run —
or D15 answered, which is better.

---

## Next, but not this week

These are the ones most likely to be asked about after the three above. All of them
are in [`DECISIONS.md`](DECISIONS.md) in full, and none is holding up work that is
finished.

| | Decision | Why it can wait |
|---|---|---|
| **D30** | Four thresholds seeded at zero — match tolerance, over-receipt, write-off, high-risk payment | Every one is at its **strictest** today. Answering them relaxes work people are doing by hand; leaving them costs effort, not correctness |
| **D9** | What "KYC complete" contains | The longest external lead time of anything owed, because Legal owns it. Worth starting early even though nothing waits on it |
| **D8** | The migration approach | Needs a signature rather than a decision, plus the cut-over period and data-class owners |
| **D29** | Who may see a client import file now one register serves both | Cheap now, a migration later. Raised by the D16 merge on 2026-08-18 |
| **D31** | What role an investment counterparty holds in the partner master | Recorded as a supplier because money flows to it at acquisition — the nearest true thing. Master-data tidiness, not correctness. Raised 2026-08-19 at Phase 13 |
| **D17** | Whose money a residual client balance is | Open, and the most consequential of the Phase 09 items — but the mechanism is built and nothing is blocked while it waits |
| **D1**, **D3** | Project revenue recognition; payroll formulas | Just as large as D2, but neither is in flight. Phase 11.10 is all D1 holds, and Phase 15 has not started. They matter at go-live |

---

*Maintained alongside the register. When one of these is answered it moves to*
[`DecisionAnswered.md`](DecisionAnswered.md) *in full, and the next most urgent item*
*takes its place here.*
