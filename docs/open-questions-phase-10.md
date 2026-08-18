# Open questions raised by Phase 10 — Logistics Operations

> **Merged into the register on 2026-08-18.** Q10-1 to Q10-4 are **D22, D23, D24
> and D25** in `docs/DECISIONS.md`. This file stays because it carries the worked
> reasoning; the register carries the question.

**Phase 10** · Blueprint §11 · raised 2026-08-17 by the Phase 10 build

> §28.1: *"When a technical constraint or ambiguity is identified, the IT specialist shall document the issue and available technical options. Issa Mohammed selects and approves the final business treatment. The IT specialist shall not select a business or accounting outcome independently."*

These are written in the Decision Register's format so they can be merged into
`docs/DECISIONS.md` as D-numbers by whoever owns that file. Phase 10 has **not**
edited the register itself.

**Owner of every business decision:** Issa Mohammed, Business Process Owner.

---

## Status summary

| # | Question | Status | Blocks |
|---|---|---|---|
| Q10-1 | Which clearing account each funding stage credits | 🔴 Open | Client funding cannot post at all |
| Q10-2 | Clearing-versus-receivable split at recognition | 🟡 Built the defensible way, confirmation invited | Nothing — build proceeds |
| Q10-3 | Cancelling a job that already carries posted money | 🟡 Refused for now; the wider case is open | Cancellation after In Progress |
| Q10-4 | Accounting treatment of a logistics claim | 🟡 Posts nothing, by design | Nothing — the register is built |

**Only Q10-1 blocks anything outright**, and it blocks a lot: no client funding
can be posted until it is answered, which means 10.4's accounting event cannot
run in production. It is also the cheapest of the four to answer — it is a
two-row table, not a policy.

---

## Q10-1 — Which clearing account a client funding credits, at each job stage

| | |
|---|---|
| **Status** | 🔴 Open |
| **Blueprint** | §11.4 |
| **Blocks** | 10.4 — client funding cannot be posted at all |
| **Owner** | Finance → Business Process Owner |
| **Raised** | 2026-08-17 |

**The blueprint's own words**

> §11.4, accounting event table: *"Client logistics funding or charge | Bank, Cash or Client Account | **Client Logistics Clearing / Deferred Service Balance according to document stage**"*

**The ambiguity**

The blueprint names two credit accounts and says the choice depends on the
document stage. It does not say which stage takes which. Appendix B gives the
Logistics Job seven statuses — Draft, Approved, In Progress, Delivered, Settled,
Closed, Cancelled — and money can arrive at four of them.

The two accounts mean different things. *Client Logistics Clearing* is money the
company is holding on the client's behalf against a job. *Deferred Service
Balance* is consideration received for a service not yet performed. Which one a
particular receipt belongs in is an accounting judgement about when the company's
obligation arises, and §28.1 puts that beyond the implementation team.

**What is needed**

A value for each stage at which funding can be received:

| Job stage (Appendix B) | Credit account |
|---|---|
| Draft | ? |
| Approved | ? |
| In Progress | ? |
| Delivered | ? |
| Settled | ? |

**The options**

1. **Deferred Service Balance until Delivered, Client Logistics Clearing after.**
   Reads the two accounts as before/after performance. Simple, and matches the
   language of "deferred".
2. **Client Logistics Clearing throughout, Deferred Service Balance never used
   for logistics.** Treats every receipt as client money held, and recognises the
   whole obligation at settlement. Fewest moving parts; makes the second account
   dead for this module, which the blueprint's wording argues against.
3. **Deferred Service Balance only where the client has funded a fixed-price
   service in advance; Client Logistics Clearing where the funding is a float
   against third-party costs.** Discriminates on the *nature* of the receipt
   rather than on the job's stage — which is arguably what §11.4 means, but is
   not what it says.

**How the build has handled it**

`logistics_funding_stage_role` maps job stage → posting line role, and **ships
empty**. `postFunding` refuses with a sentence naming this question rather than
falling back to a default. Being unable to post is recoverable; posting six
months of receipts to the wrong account is not.

Once the answer is known it is five INSERTs and no code change — §3.3's principle
applied to the choice of line role rather than the choice of account.

**Can proceed without it:** everything else in Phase 10. Charges, costs, margin,
delivery evidence, settlement and all ten reports are built and tested. Only the
funding posting is held.

---

## Q10-2 — How a part-funded job divides between Client Logistics Clearing and Client A/R at recognition

| | |
|---|---|
| **Status** | 🟡 Built the defensible way, confirmation invited |
| **Blueprint** | §11.4 |
| **Blocks** | Nothing — the build proceeds |
| **Owner** | Finance → Business Process Owner |
| **Raised** | 2026-08-17 |

**The blueprint's own words**

> §11.4: *"Service completion and recognition | **Client Logistics Clearing / Client A/R** | Logistics Revenue"*

**The ambiguity**

Two possible debits, and no statement of how a job that was funded 600,000
against a charge of 1,500,000 divides between them.

**What the build does, and why**

Funded first: the clearing balance is discharged up to what the client actually
paid, and the remainder is billed to Client A/R. On the example above, that is Dr
Client Logistics Clearing 600,000, Dr Client A/R 900,000, Cr Logistics Revenue
1,500,000.

The reasoning is not preference. Client Logistics Clearing holds money the client
has paid; debiting more of it than was credited would leave a liability clearing
account in debit — an unfunded balance presented as money the company is holding.
The only division that keeps the account meaning what it says is "discharge what
was funded, bill the rest".

A second rule follows from Q10-1: where a job was funded at two stages that map
to *different* clearing roles, the settlement debits each role for what it
actually received, oldest funding first, so neither account is left holding a
residue.

**What confirmation would settle**

Whether Finance wants any other division — for instance recognising against A/R
first and leaving client money on account until the job closes.

**Where it lives:** `splitRecognition` and `allocateAcrossFundings` in
`src/server/domain/logistics.ts`, both unit-tested against worked examples.

---

## Q10-3 — What becomes of posted cost and client funding when a job is cancelled

| | |
|---|---|
| **Status** | 🟡 Refused for now; the wider case is open |
| **Blueprint** | Appendix B |
| **Blocks** | Cancelling a job that has passed Approved |
| **Owner** | Logistics and Finance → Business Process Owner |
| **Raised** | 2026-08-17 |

**The blueprint's own words**

> Appendix B, Logistics Job: *"Draft, Approved, In Progress, Delivered, Settled, Closed, **Cancelled**"*

**The ambiguity**

Appendix B lists Cancelled without saying which states reach it. From In Progress
onward a job may carry posted third-party cost and posted client funding. What
happens to that money on cancellation is a business decision with at least three
plausible answers, and no clause anywhere in §11 addresses it.

**What is needed**

1. May a job be cancelled after In Progress at all, or is the correct route to
   deliver nothing, settle at zero and close?
2. If it may: what happens to third-party costs already incurred — absorbed by
   the company (which §11.3 appears to forbid: *"the company does not absorb
   logistics costs"*), billed to the client as an abortive charge, or recovered
   from the carrier?
3. What happens to client funding already received — refunded, retained as a
   cancellation fee, or held against a future job?
4. If a fee is retained, what recognises it, and to which revenue account?

**The options**

1. **Cancellation only before execution starts** (what is built). A job that has
   incurred cost is delivered-or-abandoned through settlement, so every figure
   reaches the ledger through the one recognition path.
2. **Cancellation at any stage, with a mandatory abortive-charge settlement.**
   Keeps §11.3 intact by requiring the costs to be charged somewhere before the
   job can close.
3. **Cancellation at any stage with a write-off.** Simplest operationally, and in
   direct tension with §11.3.

**What the build does**

Cancellation is allowed from Draft and Approved only — the two states in which,
by construction, nothing has posted. Enforced in the domain, in the service with
a message naming this question, and in the database by a trigger on
`logistics_job`. The refusal is the recoverable direction.

---

## Q10-4 — Accounting treatment of a logistics claim

| | |
|---|---|
| **Status** | 🟡 Posts nothing, by design |
| **Blueprint** | §11.1, §11.5, Appendix C |
| **Blocks** | Nothing — the claims register is built |
| **Owner** | Finance → Business Process Owner |
| **Raised** | 2026-08-17 |

**The ambiguity**

§11.1 puts *"Claims and Exceptions"* in the Logistics menu and §11.5 requires a
Delivery Exceptions report. **Appendix C has no posting row for a claim.** A
claim for damaged goods plainly has financial consequences — a provision, a
receivable from the carrier, a reduction of the client charge, or nothing until
it settles — and the posting matrix, which is exhaustive, is silent.

**What is needed**

1. Does an open claim create an accounting entry, or only a disclosure?
2. If it does: at what point — when raised, when accepted by the carrier, or when
   settled?
3. Which account bears it, and does the answer differ by claim type (damage,
   loss, delay, shortage)?
4. Does a claim against a carrier reduce that carrier's payable, or stand as a
   separate receivable?

**What the build does**

`logistics_claim` is a register with no journal link and no posting path.
`estimated_amount` is nullable and exists for the Delivery Exceptions report
only. A claim must be resolved or rejected before its job can close, so no claim
can be quietly forgotten — but nothing about it reaches the ledger until this is
answered.

---

## A note on what Phase 10 did *not* treat as an open question

Two things looked like ambiguities and are not:

**Who owns the Client Import File.** Appendix A lists *Client Import Files* under
menu 7, Logistics; menu 8, Money Transfer, does not list it, and §12.2 refers to
the *"Related Client Import File and Logistics Job"* — the language of a module
pointing at something another module owns. Phase 10 therefore owns the table and
Phase 09 registers against it through a module-agnostic cross-reference. This is
a module-boundary decision, not a business or accounting one.

**What delivery evidence each service requires.** 10.7 requires that a job cannot
settle without the evidence its type requires, and the blueprint nowhere says
what an air-freight job must prove as against a customs-clearance job. Rather
than raise it as a decision, it is built as configuration
(`logistics_service_type_evidence`) for the Logistics department to set — which
is where §11.1 puts *"Logistics Settings"*.
