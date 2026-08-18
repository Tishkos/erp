# Open questions — Phase 09, Money Transfer

> **Merged into the register on 2026-08-18.** Q9.1 is now part of **D9**; Q9.2 to
> Q9.6 are **D17, D18, D19, D20 and D21** in `docs/DECISIONS.md`. This file stays
> because it carries the worked reasoning; the register carries the question.

Raised while building Phase 09 (§12). Each is a **business or accounting outcome**
that the blueprint does not settle, so §28.1 forbids the implementation team from
choosing it. Written in the register's format for merging into D-numbers by
whoever owns that file; none of them has been given a D-number here.

Every one has been built **the defensible way** — the mechanism exists, the
choice is deferred and visible — so Phase 09 is not blocked on any of them. What
each answer changes is noted, so the cost of a late answer is known in advance.

D9 (legal/compliance approval for Money Transfer) is already open and already
covers the compliance regime. **Q9.1 below is the part of D9 that Phase 09 needs
answered as a data question rather than a policy one**; the rest are new.

---

## Q9.1 — What does "KYC complete" contain?

| | |
|---|---|
| **Status** | 🔴 Open — mechanism built, catalogue seeded **empty** |
| **Blueprint** | §21, Appendix E (FATF MVTS reference), §26 go-live gate 5 |
| **Blocks** | Nothing today. Phase 09 go-live — this is part of **D9** |
| **Owner** | Legal / compliance → Business Process Owner |
| **Raised** | 2026-08-17 |

**The ambiguity.** §21 requires KYC records linked to the partner and the transfer
case, and Appendix E cites the FATF MVTS guidance for *risk-based* controls.
Neither says which documents a client must produce, what the risk bands are, what
each band obliges, or how often identification must be renewed.

**What is built.** `kyc_risk_rating` and `kyc_required_document` are catalogues
Compliance fills; both ship **empty**. A transfer cannot be initiated unless the
client has an approved, unexpired KYC record that carries every active required
document applying to their rating — enforced by trigger, on every path.

**The consequence of the empty catalogue, stated plainly.** With nothing
configured, "complete" reduces to *an approved, unexpired record*. That is a real
control and it is deliberately the weakest one that is still defensible. Every
row Compliance adds tightens it, with no code change.

**Options**

| | Option | Consequence |
|---|---|---|
| a | Compliance fills the catalogues before go-live | No code change. The intended path |
| b | Controls needed that a document checklist cannot express — transaction thresholds, sanctions screening, periodic review triggers | New requirements under §28.1. Phase 09 needs re-planning; this is the risk D9 was raised early to surface |

---

## Q9.2 — Does a residual client balance belong to the client or to the company?

| | |
|---|---|
| **Status** | 🔴 Open — **the most consequential of these**; mechanism built, amount deferred to Finance |
| **Blueprint** | §12.4, §12.7, §22 KPI dictionary |
| **Blocks** | Nothing today. The Phase 09 exit gate — *"service margin … reconcile"* |
| **Owner** | Finance → Business Process Owner |
| **Raised** | 2026-08-17 |

**The ambiguity.** §12.4 requires the system to calculate six figures, two of
which are **Net Service Margin** and **Remaining Client Balance**. §12's purpose
paragraph says *"the remaining client balance after transfer and direct expenses
is the service result"* — which reads as though the two are the same number. But
§12.4 lists them separately, and the Phase 09 gates define them differently:

- 09.7 — *"Fees reduce Net Service Margin and are visible separately from Gross
  Exchange Spread"* → net margin = spread − direct expenses
- 09.8 — *"Remaining Client Balance equals deposits less transfer principal less
  expenses charged to the client"*

Both formulas are pinned by the gates and both are implemented. What is **not**
settled is what happens to the residue afterwards: on the worked example the
client deposited 15,000,000, the transfer sent 13,050,000, and 1,950,000 remains
on the client clearing account — of which 450,000 is the exchange spread the
company earned. Is that 450,000 the company's revenue, or is the whole 1,950,000
refundable to the client?

§22 says transfer margin is measured *"according to finance policy"*, which is
the sentence that makes this Finance's answer and not the implementation team's.

**What is built.** Both figures are computed and reported. Recognition of the
service result is a **separate, explicitly authorised act**: Finance calls
`recogniseServiceResult` with an amount, and the system refuses more than the
computed Net Service Margin. It posts Dr Client Clearing / Cr Service Revenue by
line role, so which accounts those are is Accounting Mapping's answer (§12.4).
Nothing is recognised automatically, and a residue simply stays on the client
clearing account — a liability — until somebody decides.

**Options**

| | Option | Consequence |
|---|---|---|
| a | The spread is the company's; recognise it when the transfer completes | Recognition becomes routine and could be automated on Completed. Client statements must then show the deduction |
| b | The whole residue is the client's until they take it or agree otherwise | Recognition is exceptional. Open Client Balances is a real liability report and the margin is only ever a KPI |
| c | Something between — e.g. recognised at period close, or netted against an agreed fee | The mechanism already supports it; the trigger point is the only thing that changes |

**Until this is answered**, the system reports the margin and holds the money.
That is the state that is wrong in the safest direction: the company can always
recognise revenue it deferred, but it cannot easily give back money it already
took into the profit and loss.

---

## Q9.3 — Is "Available" a state a deposit can be in without being usable?

| | |
|---|---|
| **Status** | 🟡 Open — built as one state; a second is cheap to add if wanted |
| **Blueprint** | §12.3, Appendix B (Client Deposit statuses) |
| **Blocks** | Nothing |
| **Owner** | Treasury → Business Process Owner |
| **Raised** | 2026-08-17 |

**The ambiguity.** Appendix B lists Client Deposit statuses as Draft, **Posted**,
**Available**, Partially Used, Used, Refunded, Reversed. Posted and Available are
separate entries, which implies a deposit can be posted and not yet available.

§12.3 admits only two ways money arrives — *"cash deposit into the company bank
account or by bank transfer"* — and both are cleared funds by the time they are
recorded, so there is no obvious gap between the two states.

**What is built.** One state (`posted`) carrying both meanings, documented in the
schema. The deposit is usable the moment it posts.

**Options**

| | Option | Consequence |
|---|---|---|
| a | They are one state | No change. What is built |
| b | Available is a separate step — a compliance hold, a clearing delay, a second pair of eyes before client money can be spent | One extra status and one extra transition. Worth knowing that this would be a *control*, so it is the kind of thing Q9.1 might turn out to require |

---

## Q9.4 — May a client hold more than one open account at once?

| | |
|---|---|
| **Status** | 🟡 Open — built permissive; balances are unambiguous either way |
| **Blueprint** | §12.3 |
| **Blocks** | Nothing |
| **Owner** | Treasury → Business Process Owner |
| **Raised** | 2026-08-17 |

**The ambiguity.** §12.3 says *"the client account remains open until the client
confirms that funding is complete and specifies the amount to transfer"*, which
makes an account one funding cycle. It does not say whether a client may run two
cycles at once — paying into one consignment while another is still being sent.

**What is built.** Several open accounts per client are allowed. Every deposit
names its account and every transfer draws only on its own account's deposits, so
balances stay unambiguous however many there are. Restricting it would have been
inventing a rule the blueprint does not state.

**Options**

| | Option | Consequence |
|---|---|---|
| a | Several open cycles allowed | No change. What is built |
| b | One open account per client (per branch?) | A partial unique index. Cheap now; disruptive once clients have history |

---

## Q9.5 — Who bears a direct expense, by default?

| | |
|---|---|
| **Status** | 🟡 Open — built with **no default**, so every expense states it |
| **Blueprint** | §12.4, §12.6 |
| **Blocks** | Nothing |
| **Owner** | Finance → Business Process Owner |
| **Raised** | 2026-08-17 |

**The ambiguity.** §12.4 posts bank fees to a Money Transfer Direct Expense
account without saying whether the client is charged for them. §12.6 settles one
case only — on a **returned** transfer *"the company absorbs all bank charges"* —
which shows the distinction exists and matters, without giving the general rule.

It matters twice: it changes the client's Remaining Client Balance (§12.4), and on
a return it decides whether the refund is whole (§12.6).

**What is built.** `money_transfer_expense.charged_to_client` is NOT NULL **with
no default**, so every charge says who bears it and nobody's silence decides. The
column is frozen once the expense posts, because flipping it afterwards would
silently restate a client's balance.

**Options**

| | Option | Consequence |
|---|---|---|
| a | Keep it explicit per charge | No change. What is built |
| b | A default by expense type, or per client agreement | A configuration table, in the shape of the tolerance tables Phase 05 already uses |

---

## Q9.6 — Does a cross-branch bank debit need a Super User?

| | |
|---|---|
| **Status** | 🟡 Open — a design consequence worth confirming, not a defect |
| **Blueprint** | §12.5, §5.1, §22 |
| **Blocks** | Nothing |
| **Owner** | Treasury → Business Process Owner |
| **Raised** | 2026-08-17 |

**The observation.** §12.5's own example combines *"a client transfer and a
company import payment"* in one bank debit, and those need not belong to the same
branch. Each batch line carries its own branch, as §12.5 requires, and each is
row-level-security scoped to it (§22).

The consequence: assembling a batch that spans two branches means being able to
see both, and §5.1 makes Super User the only blanket grant. So today a
cross-branch bank debit can only be composed by a Super User.

**Options**

| | Option | Consequence |
|---|---|---|
| a | Accept it — cross-branch debits are rare and deserve that level of authority | No change |
| b | Give Treasury a multi-branch data scope for this document type | A §5 data-scope decision, not a Phase 09 one |
| c | Cross-branch batches are not wanted at all | A CHECK that every line shares the batch's branch. Simplest of the three, and it would narrow §12.5 |

---

## Not raised here, and why

**The line roles Phase 09 posts by.** `client_clearing`, `client_account`,
`client_inventory`, `transfer_expense`, `service_revenue` and `bank` are names,
resolved through Accounting Mapping (§12.4, §3.3). Which G/L account each becomes
is configuration, not a question — the mapping screen is where it is answered, and
no code changes when it is.

**`client_clearing` and `client_account` are kept as two roles** because §12.4's
two tables name them separately. Finance may map both to one account; that is
their answer to make, and keeping the roles distinct is what leaves it open.
