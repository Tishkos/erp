# Decisions Answered

**Phase 00.7** · Blueprint §28.2 · companion to [`DECISIONS.md`](DECISIONS.md)

> "When a technical constraint or ambiguity is identified, the IT specialist shall document the issue and available technical options. Issa Mohammed selects and approves the final business treatment. The IT specialist shall not select a business or accounting outcome independently."

Decisions that have been **made** live here, in full, with what each one changed
in the build. They are kept rather than archived: §28.1 requires a change to be
traceable to the decision that caused it, and the reasoning matters most later,
when someone asks why the system behaves the way it does.

[`DECISIONS.md`](DECISIONS.md) holds only what is still open or partly open, so
that what has *not* been decided stays visible rather than being buried among
what has.

---

## Answered

| # | Decision | Decided | By | Released |
|---|---|---|---|---|
| D4 | Availability, RPO, RTO and backup retention | 2026-08-17 | Tishko | Phase 20.3, infrastructure design |
| D6 | Accessibility level | 2026-08-17 | Tishko | Phase 20.5 |
| D7 | Chart of Accounts | 2026-08-17 | Tishko | Phase 02 and Phase 04 acceptance |
| D10 | Branch access and the Active Branch | 2026-08-17 | Tishko | Phase 01 RLS, Phase 02 and 04 reports, Phase 06 §7.2 |

**One term still to confirm under D7**, and it blocks nothing: the dimension
answer names "Cost Center", which is not one of §4.2's seven dimensions. Almost
certainly it means Department; if it means a genuinely separate dimension, that
is a change request under §28.1. See D7 item (e).

**Still owed on D4:** the Business Process Owner marked the availability figures
"subject to approval". They are treated as decided for build purposes; if any of
them tighten — particularly the RTO — the high-availability design changes and
that entry needs re-approving rather than amending.

---

## D4 — Availability, RPO, RTO and backup retention

| | |
|---|---|
| **Status** | 🟢 Decided |
| **Blueprint** | §25, "Availability, continuity and recovery" |
| **Blocks** | Phase 20.3; infrastructure design — **released** |
| **Owner** | Business Process Owner |
| **Raised** | 2026-08-16 |
| **Decided** | 2026-08-17 |
| **Decided by** | **Tishko answered this** |

### Decision

**Acceptance statement, as given:**

> Qimah Al Safinah ERP shall target 99.9% monthly service availability, excluding
> authorised maintenance. Critical production services shall have a database RPO
> of 15 minutes, attachment RPO of 1 hour and an RTO of 2 hours. Backups shall be
> encrypted, retained according to the approved retention schedule and include at
> least one recovery copy independent of the production environment. Restore
> capability shall be tested regularly, and documented business-continuity
> procedures shall apply during major outages.

#### Targets

| Area | Requirement |
|---|---|
| Service availability | 99.9% monthly, excluding authorised maintenance |
| Planned maintenance | Up to 2 hours weekly, outside business hours, announced in advance |
| Database RPO | **15 minutes** maximum data loss |
| Attachment RPO | **1 hour** maximum |
| RTO | **2 hours** for critical services |
| Recovery priority | Accounting, invoicing, payments, stock and approvals first |
| High availability | Required for critical infrastructure; full active-active **not** mandatory initially |
| Disaster recovery | Separate recovery capability for major infrastructure failure |
| Backup encryption | All copies encrypted |
| Off-site | At least one copy independent of the production environment |

#### Retention schedule

| Backup | Retention |
|---|---|
| Transaction logs / continuous recovery | 35 days |
| Daily | 30 days |
| Weekly | 12 weeks |
| Monthly | 12 months |
| Year-end | 7 years, subject to Finance/Legal |

Backups must not exist only on the production server or storage. A failure,
deletion, security incident or infrastructure loss affecting production must not
be able to destroy every recovery copy.

#### Recovery order

Authentication and user access → database → accounting and posting engine →
payments and banking → invoicing → inventory and warehouse → approvals →
attachments → lower-priority services, analytics and non-critical integrations.

Not every background service recovers at the same moment.

#### Restore testing

A backup job reporting success is not evidence of a usable backup.

| Frequency | Test |
|---|---|
| Monthly | Automated or sample restoration |
| Quarterly | Full database restoration |
| Every 6 months | Disaster-recovery exercise |
| After major infrastructure change | Additional recovery test |

Each test records: backup used, start and completion time, whether the RTO was
met, whether integrity checks passed, problems found, corrective actions.

#### Disaster recovery and continuity

Invoked when normal production recovery will not meet the RTO — extended hosting
outage, database corruption, major storage failure, destructive security
incident, loss of the primary environment.

Roles: Business Process Owner decides business priority; IT performs technical
recovery; Finance validates accounting data after restoration; department
managers validate outstanding operational transactions.

During an outage, business continues on a **controlled** temporary process —
receipts, deliveries, stock movements, bank movements, customer and supplier
payments, urgent approvals — each with a temporary reference recording date and
time, responsible employee, counterparty, amount or quantity, supporting
document and required approval. Every temporary transaction is entered and
reconciled when the ERP returns. **None may simply disappear.**

### What this changes in the build

The 15-minute database RPO is the demanding figure, and it settles an
architectural question rather than a documentary one:

1. **Nightly `pg_dump` alone is now insufficient.** `docs/RUNBOOK-database-recovery.md`
   was written with the RPO marked open and assumed a nightly full backup, which
   risks 24 hours of postings. It needs continuous archiving — WAL archiving or
   streaming replication — to reach 15 minutes. **The runbook's stated RPO and
   RTO have been updated from "Open — D4" to these figures, and the procedure
   itself must be extended in Phase 20.3.**
2. **Attachments need their own backup strategy.** A 1-hour attachment RPO
   against a 15-minute database RPO means the two cannot share one mechanism —
   which is consistent with attachment *content* living in object storage, not
   in the database (Phase 01.8).
3. **`scripts/verify-recovery.ts` gains a scheduled owner.** It already proves a
   restore rather than assuming it; the monthly/quarterly/six-monthly cadence
   above is what turns it from a tool into a control.
4. **Business continuity becomes a Phase 21 deliverable.** The temporary-reference
   process is a documented procedure with training material, not code — but the
   reconciliation of outage transactions on return is a real requirement and
   belongs in the go-live runbook.

**Still to confirm:** the Business Process Owner marked this "subject to approval".
The figures are treated as decided for build purposes; if any of them tighten
(particularly the RTO), the high-availability design changes and this entry needs
re-approving rather than amending.

---
## D6 — Accessibility level

| | |
|---|---|
| **Status** | 🟢 Decided |
| **Blueprint** | §25, "Usability and accessibility" |
| **Blocks** | Phase 20.5 — **released** |
| **Owner** | Business Process Owner |
| **Raised** | 2026-08-16 |
| **Decided** | 2026-08-17 |
| **Decided by** | **Tishko answered this** |

> §25: "Accessibility shall target **a recognised web accessibility level
> selected by the company**, including keyboard navigation and meaningful
> labels."

### Decision

**WCAG 2.2, Level AA**, applied to authenticated user-facing ERP screens.

#### Scope

In scope — every screen a user works in: navigation, forms, master data,
accounting, invoices, payments, warehouse, projects, HR, CRM, money transfer,
investments, reports, dashboards, approvals, profile and settings,
notifications, validation and error messages, and the authentication screens
themselves.

Out of the formal Phase 20.5 acceptance scope: developer tooling,
infrastructure management and internal technical administration interfaces that
are not part of the normal ERP user experience.

#### Accessibility is not access

The register records this distinction because it is the one that gets confused,
and confusing it would be a security failure rather than a usability one:

| | Question it answers |
|---|---|
| **Role-based access control** | *May* this user open this page, record or action? |
| **Accessibility** | Can a user who is already authorised *operate and understand* the page? |

Accessibility applies **after** authentication and authorisation have decided
what the user may reach. WCAG conformance never bypasses sign-in, role
permissions, record permissions, branch restrictions, approval authority,
segregation of duties or confidentiality controls. A screen being
accessibility-compliant gives nobody a permission they did not have — an HR
screen is no more reachable by a non-HR user for being well-labelled.

The ERP is a private internal system. Unauthenticated users reach nothing.

#### Minimum requirements

- **Keyboard navigation** — normal workflows usable without a mouse
- **Visible focus** — the user can always see which control is selected
- **Meaningful labels** — fields, buttons, icons and controls have understandable names
- **Readable contrast** — text and controls legible against their background

### What this changes in the build

Most of it is already in place from Phase 01.12, and naming the standard turns
those choices from preferences into acceptance criteria:

1. **The focus ring is a requirement, not a style.** `globals.css` already
   refuses to remove `:focus-visible` and replaces it with a stronger ring —
   that is now WCAG 2.2 AA §2.4.11, not a preference.
2. **Labels come from the catalogue.** Every control is labelled through
   `messages/en.json`, and `tests/unit/i18n-catalogue.test.ts` fails the build
   if a component hardcodes a user-facing string. That test now also protects an
   accessibility requirement.
3. **Status is never colour alone.** The draft band carries text and a hatched
   border as well as colour, because colour alone fails for a colour-blind reader
   and on a monochrome printout — WCAG §1.4.1.
4. **Contrast must be measured, not assumed.** The status colours in
   `globals.css` were chosen to look right; Phase 20.5 has to check each against
   4.5:1 for text and 3:1 for controls, in both light and dark themes.
5. **Phase 20.5 needs an automated axe/WCAG pass** over the authenticated screens
   in the scope list above, and a keyboard-only walkthrough of the critical
   workflows.

**Note on RTL:** WCAG conformance and §25's right-to-left requirement are
independent, and both are already served by the same decision — logical CSS
properties throughout (`margin-inline-start`, never `margin-left`), proved by
`tests/e2e/rtl.spec.ts`.

---
## D7 — Chart of Accounts 🔥

| | |
|---|---|
| **Status** | 🟢 Decided — all items answered 2026-08-17; one term to confirm |
| **Blueprint** | §1.2, §4.3, Appendix C |
| **Blocks** | Phase 02.1 acceptance, and therefore every posting mapping in Appendix C |
| **Owner** | Business Process Owner |
| **Raised** | 2026-08-16 |
| **Part received** | 2026-08-16 — `phases/chartsofaccount.md` |
| **Part answered** | 2026-08-17 — `docs/Anwers.md`, **Tishko answered this** |

**The blueprint's own words**

> Appendix C: "Exact account codes and account names are selected through Accounting Mapping **after the Chart of Accounts is configured by Issa Mohammed**."

**What is needed**
1. The account code structure and hierarchy — ✅ **received**; codes are allocated by the system (see 2026-08-16 decision below)
2. The account list with type, posting-allowed flag and control-account flag — ✅ **resolved by method**: accounts are entered in the system as needed, not delivered as a list
3. Currency restrictions per account — ✅ **decided 2026-08-17**: one currency per account, asked at creation
4. Required dimensions per account — §4.2 makes these mandatory-or-optional *by account* — ❌ outstanding
5. Which accounts are control accounts protected from direct manual posting (§14.3) — ❌ outstanding

### What was received on 2026-08-16

The file supplies the **group level only**, headed "QS Groups", with zero balances:

| Code | Name | Side shown in the extract | Correct normal balance | Currency |
|---|---|---|---|---|
| A000001 | Assets — QS | Dr | Dr | IQD |
| L000001 | Liabilities — QS | Cr | Cr | IQD |
| E000001 | Equity — QS | Cr | Cr | IQD |
| R000001 | Revenue — QS | Cr | Cr | IQD |
| X000001 | Expense — QS | **Cr** | **Dr** ⚠ | IQD |

**⚠ The Expense group is shown credit-normal. Expenses are debit-normal.** See the discrepancy note below — this is item (g) in the outstanding list.

What this establishes:

- **The five account types** and the normal balance of each, matching §14 and Appendix C.
- **The code format:** one type letter (A, L, E, R, X) followed by six digits. Codes are typed rather than ranged, so an account's type is readable from its code and cannot drift from it.
- **IQD as the account currency**, consistent with §1.1.
- These five are **group (header) accounts** — the file calls them Groups. Under §4.3 a header account is not posting-allowed, and §3.3 requires every posted account to exist and be active, so posting accounts must hang below these.

### What is still outstanding, and what each one blocks

| # | Item | State | Blocks |
|---|---|---|---|
| a | The posting accounts under each group — code, name, parent | ✅ **Method decided 2026-08-16** — entered in the system, codes auto-allocated | — |
| b | Posting-allowed vs header flag per account | ✅ Set per account at creation | — |
| c | Control-account flag — customer, supplier, inventory, bank (§14.3) | ✅ **Decided 2026-08-17** — Officer proposes, Manager approves, protected once used | — |
| d | Currency restrictions per account | ✅ **Decided 2026-08-17** — one currency per account | — |
| e | Required dimensions per account (§4.2) | ✅ **Decided 2026-08-17** — set at the group, inherited, overridable | — |
| f | Whether "QS" denotes one entity among several | ✅ **Resolved 2026-08-17** — QS *is* the company | — |
| g | Why the Expense group is shown credit-normal in the source system | ✅ **Resolved 2026-08-17** — display artefact of a zero balance | — |

### Answered 2026-08-17 — **Tishko answered this**

#### f · Company scope — 🟢 Resolved

> "Qimah Al Safinah (QS) is the company the ERP is being built for. … The Chart
> of Accounts belongs to Qimah Al Safinah. Any future multi-company structure
> would be treated as a separate future requirement and does not need to
> complicate the current Chart of Accounts design."

QS is not a segment, a division or one entity among several — it is the company.
The suffix "— QS" on the five group names is the company's name, not a
discriminator that other entities would repeat with their own letters.

**What this changes in the build:** nothing needs adding, and that is the point.
There is no company/entity column in `chart_of_account`, no code-space
partitioning, and no consolidation dimension — and now none is owed. Phase 16
consolidation is single-entity. If a second company ever appears it arrives as a
change request under §28.3, and the register will say plainly that the current
chart was designed on this answer.





#### g · The Expense group's normal balance — 🟢 Resolved

> "X000001 — Expense — QS showed Cr only as a placeholder/default display
> because the balance was zero. It does not represent the account's accounting
> configuration. Expense accounts are debit-normal."

This is possibility 1 of the two set out below: the `Cr` marker is an artefact
of printing a zero balance, carrying no configuration meaning.

**What this changes in the build:** the code was already right — normal balance
is *derived* from the account type in `src/server/domain/accounts.ts` and cannot
be stored contradicting it. What this answer removes is a **Phase 21.2
obligation**: expense balances carried over at migration do not need a sign
check against a mis-configured source, and prior-period reports from the source
system can be used as comparatives without review. That was the expensive half
of the question.

#### e · Required dimensions per account — 🟢 Decided

> "Dimension rules are configured primarily at the account-group level. Child
> accounts automatically inherit the group's rules for Branch, Project, Cost
> Center and Department. Finance may override a rule for a specific account when
> necessary. … This keeps the Chart of Accounts manageable as hundreds or
> thousands of accounts are added."

| | |
|---|---|
| **Set at** | The group. One rule covers every account below it |
| **Inherited by** | Every descendant, automatically |
| **Overridable** | Yes, per account, by Finance |
| **Example given** | Operating Expenses requires Branch and Cost Centre → every expense account below inherits both, unless Finance changes that account |

**What this changes in the build** — this was the last item holding Phase 02
acceptance, and it changed the model rather than filling in a list:

1. **`account_required_dimension` could not express the decision.** It held rules
   per account, and an account with no rows meant two different things: *inherit
   the group's* and *deliberately require nothing*. Migration 0034 adds
   `chart_of_account.declares_dimensions`, and the effective rules are now **the
   nearest self-or-ancestor that declares**. A group declares once; a thousand
   accounts below it inherit; Finance overrides one by making it declare its own
   set — which may be empty, and an empty declaration is how "not for this
   account" is said.
2. **An override is total, not additive.** Merging an account's rules with its
   group's would make it impossible to *remove* a requirement, and the decision
   says Finance may override. So a declaring account replaces the inheritance
   outright.
3. **Rejected: copying the group's rows down to each child on creation.** It
   makes the group's rule unchangeable in practice — editing it would have to
   find and update every copy, and any copy edited in the meantime would be
   either silently overwritten or silently kept.
4. **The resolution lives in SQL** (`account_effective_dimensions`) as well as
   in the domain, so a report, a hand-run query and a posting all give the same
   answer. The tree view resolves it by walking down from the roots instead —
   same rule, but drawing a thousand-account chart does not cost a thousand
   recursive queries.
5. **The screen must say where a rule came from.** "Branch is required" is much
   less useful to Finance than "Branch is required — inherited from Operating
   Expenses", because the second names the account they need to change.
   `effectiveDimensions()` returns the source with the rules.

**⚠ One term needs confirming — "Cost Center" is not one of §4.2's dimensions.**

§4.2 gives a closed list of seven: **branch, department, business line, project,
warehouse, business partner, employee**. The answer names *Branch, Project, Cost
Center and Department* — three of which are on the list and one of which is not.

The system does have a `cost_centre` table, used on purchase order lines, but it
is not a posting dimension and no account can require it. Two readings, and the
implementation team must not pick between them (§28.1):

| # | Reading | Consequence |
|---|---|---|
| 1 | "Cost Center" is another word for **Department** — the two are commonly used interchangeably | Nothing to do. The four named dimensions become three, all of which exist. |
| 2 | Cost Centre is a **separate analytical dimension** from Department | An eighth dimension is added to §4.2's closed list. That is a change request under §28.1, not a configuration change: it touches the dimension enum, every posting line, the trial balance by dimension, and Phase 18's reporting. |

Reading 1 is the more likely, since §4.2 already carries Department and the
blueprint never lists Cost Centre among the dimensions. It is **not assumed**:
the inheritance is built for whatever dimensions are configured, so this answer
changes which rules Finance sets, not whether the mechanism works.

#### c · Control accounts — 🟢 Decided

> "The Accounting Officer may propose that an account is a control account when
> creating it, but the Accounting Manager must approve the designation before
> the account becomes active. … Once a control account has transactions,
> changing or removing its control-account status should require Accounting
> Manager approval and should not be allowed if doing so would break existing
> accounting mappings."

| Purpose | Control-account kind |
|---|---|
| Accounts Receivable | `customer` |
| Accounts Payable | `supplier` |
| Inventory | `inventory` |
| Bank / Cash | `bank` |

All four already exist in the `control_account_kind` enum, along with
`fixed_asset`, `project` and `service` for the later phases.

**What this changes in the build:**

1. **The first half was already true and needed nothing.** An account is raised
   as a draft carrying whatever kind the Officer proposes, and it accepts no
   postings until the Manager approves it — held by
   `chart_of_account_active_requires_approval` since migration 0003. Approving
   the account approves the designation.
2. **The second half needed two different protections, because they fail
   differently.** Migration 0034:
   - **Would break a mapping** — refused outright by the database. If a posting
     rule points at the account, removing the designation leaves that mapping
     selecting an account §14.3 no longer protects, and the next automated
     posting goes somewhere the reconciliation does not expect. No approval
     makes that safe; the mappings are repointed first.
   - **Has transactions** — allowed, but only through `setControlAccount()`,
     which requires the `approve` verb. The database cannot tell an Accounting
     Manager from anyone else; what it can do is refuse the change to everyone
     unless the session carries that approval, and the marker is set for the
     length of the statement so it cannot leak into a later write.
3. **The `approve` verb, not `configure`.** Configuring the chart is an
   Officer's work; this is not.

#### d · Account currency — 🟢 Decided

> "Each Chart of Accounts account is limited to one currency only. When creating
> a new account, the ERP should ask for the Account Currency at the beginning of
> the setup. The currency should not be assumed automatically. … If Accounting
> needs the same type of account in another currency, they should create a
> separate account for that currency."

| | |
|---|---|
| **Rule** | One account, one currency. `Cash IQD` → IQD; `Cash USD` → USD; `Bank EUR` → EUR |
| **At creation** | The currency is **asked for**, from the full list of active currencies, with **no default** |
| **Same account, second currency** | Not possible — create a separate account |
| **Group (header) accounts** | Hold no balance, so they carry no currency requirement |

**What this changes in the build** — three things, all now done:

1. **The column stops being optional.** `chart_of_account.currency_restriction`
   was nullable and documented as *"null is unrestricted"*. Unrestricted is now
   the one state the answer rules out. Migration 0032 adds a CHECK: a
   posting-allowed account must name a currency. A group may not.
2. **`createAccount` refuses to guess.** Passing no currency for a posting
   account raises `AccountCurrencyRequiredError`, which names the field and the
   correction rather than quietly writing IQD. "Should not be assumed
   automatically" is a rule about *defaults*, and a default is exactly what a
   nullable column with an obvious fallback becomes.
3. **The §14.5 revaluation question narrows.** With one currency per account,
   foreign-currency revaluation has a well-defined scope — every account with a
   non-IQD currency — rather than needing to inspect balances to discover which
   accounts hold foreign amounts. Phase 07.5 gets simpler for it.

**A consequence worth stating plainly:** this multiplies bank and cash accounts
by the number of currencies traded. That is the intended reading of the answer —
it is how the currency of a balance stays unambiguous — but it means the chart
grows sideways rather than deep, and the Phase 02.1 tree view should be expected
to show `Cash — IQD`, `Cash — USD`, `Cash — EUR` as siblings rather than as one
account with three balances.

### Discrepancy: the Expense group's normal balance (raised under §28.2) — **closed 2026-08-17**

> **Resolved.** Possibility 1 below is confirmed: the `Cr` was a display default
> for a zero balance, not configuration. Retained as the record of how it was
> raised and answered, per §28.2.

**What the extract says.** `X000001 - Expense - QS` carries `0 IQD Cr`. The other four groups are as expected: Assets `Dr`, Liabilities `Cr`, Equity `Cr`, Revenue `Cr`.

**Why it cannot stand.** Expenses increase on the debit side. This is not a policy choice — it is the accounting equation that §14.3's balancing rule rests on:

> Assets + Expenses = Liabilities + Equity + Revenue

A credit-normal expense account would report every expense as a negative figure, invert the Profit and Loss statement, and make the §14.8 requirement that "Trial Balance debits equal credits" arithmetically true but meaningless.

**What has been done in the build.** Nothing has been configured from the extract's value. The normal balance is now **derived from the account type** in `src/server/domain/accounts.ts` and can never be stored as a contradicting field; `assertNormalBalance()` rejects the contradiction outright, and `tests/unit/accounts.test.ts` asserts all five types individually. No business, accounting or workflow rule was selected by the implementation team in doing so — the debit-normal treatment of expenses is definitional, not discretionary, so §28.1 is not engaged.

**What is still needed from the Business Process Owner.** Two possibilities, with different consequences at migration:

| # | Possibility | Consequence |
|---|---|---|
| 1 | The `Cr` marker is an artefact of the extract — a zero balance printed with a default side, carrying no configuration meaning | Nothing to do. Confirm and close. |
| 2 | The Expense group really is configured credit-normal in the source system | Every expense balance carried over in Phase 21 must be sign-checked before import, and the source system's own reports for prior periods should be reviewed before they are relied on as comparatives |

Possibility 1 is the more likely reading, since the other four groups are correct and all five balances are zero. It still needs confirming rather than assuming, because possibility 2 changes what Phase 21.2 has to validate.

**Effect on the build:** Phase 02.1 can be **built** on what has been received — the hierarchy, the type letters, the posting/control/dimension flags all exist as structure regardless of which accounts eventually fill them, and §3.3 requires the mappings to be configuration rather than code in any case. Phase 02 cannot be **accepted** until (a)–(e) arrive, because acceptance means posting real events to real accounts and reconciling them.

### Decision taken 2026-08-16 — the chart is built in the system, not supplied as a document

The Business Process Owner confirmed: **the five groups are the whole of the initial chart.** Accounts below them are added inside the system as they are needed, rather than delivered as a list to load.

Consequences, all now built in Phase 02.1:

| | |
|---|---|
| **Structure** | A real tree. Any group holds further groups or posting accounts, to any depth. Groups hold no balance; posting accounts take the entries. |
| **Codes** | **Automatic.** Allocated through the Phase 01.5 numbering service, one counter per account type, in the received format — the next account under Assets is `A000002`. Never typed by hand, never reused. |
| **Who may add** | Role-based. **Accounting Officer** raises and submits; **Accounting Manager** approves. An account accepts postings only once approved, held by a database constraint rather than by convention. |
| **Self-approval** | Refused, including for the Accounting Manager. The chart is what every posting in the system maps against. |

This converts items (a)–(e) from *documents awaited* into *data entered during operation*.

### What is left of D7 after 2026-08-17

**Nothing that blocks anything.** All seven items are answered. One term needs
confirming — whether "Cost Center" means Department or an eighth dimension (see
item (e) above) — and that decides which rules Finance configures, not whether
the mechanism works.

One thing remains a **person's care rather than a document**: when receivables,
payables, inventory and bank accounts are created, someone must set the
control-account kind. The system now protects the designation once it is set and
refuses to remove it while a mapping depends on it, but nothing can make someone
apply it in the first place, and getting it wrong is invisible until a
reconciliation fails months later.

**Why this was the critical blocker:** Phase 02 delivers the posting engine.
The engine is configuration-driven — §3.3: "Posting accounts shall be selected
through configurable accounting mappings, not hard-coded account numbers" — so
the *engine* was always buildable without D7. Acceptance is what needed the
answers, because acceptance means posting real events to real accounts and
reconciling them.

**Current position: the Phase 02 and Phase 04 acceptance hold is released.**
Between 2026-08-16 and 2026-08-17 D7 went from "the whole chart is missing" to
fully answered. What acceptance now needs is real accounts entered and real
events posted through them — work, not a decision.

---

## D10 — Branch access and the Active Branch

| | |
|---|---|
| **Status** | 🟢 Decided |
| **Blueprint** | §4.1, §4.2, §22, §25; 01.2 test gate |
| **Blocks** | Nothing — **released**, and it unblocked §7.2 in Phase 06 |
| **Owner** | Business Process Owner |
| **Raised** | 2026-08-17 |
| **Decided** | 2026-08-17 |
| **Decided by** | **Tishko answered this** |

> 01.2 gate: *"A user scoped to Branch A cannot read a Branch B record by ID."*
> §22: *"Row-level security is enforced in the query layer, not only hidden in
> the screen."*

**The question raised.** A user may be assigned several branches. When they open
a list of documents, should they see the branch they are working in, or every
branch they are assigned to?

Phase 01 had implemented the first reading — one session branch, everything else
invisible — and the register invited confirmation. The answer replaced it.

### Decision

Three controls, kept separate:

| | What it decides | Where it lives |
|---|---|---|
| **Allowed Branches** | *Security.* Which branch data the user may reach at all. | `user_branch_scope` |
| **Active Branch** | *A working default.* Which branch a new document starts in, and which a list opens on. | `app.branch_code` |
| **Role** | *What actions* the user may perform. | `role_grant` |

In the owner's words: *"This is better than your current 'one session branch =
everything else invisible' approach. Use: Allowed Branches = Security, Active
Branch = Working default, Role = What actions you can perform."*

And the rule as stated:

> *"A user's assigned branches define which branch data the user is authorised to
> access. … One permitted branch is selected as the Active Branch and is used as
> the default for new transactions and normal list filtering. Users with multiple
> branch permissions may switch their Active Branch or view all permitted
> branches where appropriate. **The Active Branch shall not replace branch-level
> security; access restrictions must be enforced by the backend and
> database/query layer.**"*

Specifically:

- A user assigned Baghdad alone cannot view Erbil or Basra records — **including
  by entering an ID or a URL directly**.
- A user assigned Baghdad and Erbil may view both.
- Lists open on the Active Branch, and a multi-branch user may switch the filter
  to another permitted branch or to **All Permitted Branches**.
- New documents default to the Active Branch; unauthorised branches are not
  offered, and the backend validates the branch again on save and on post.
- Branch also remains an **accounting dimension** (§4.2), so per-branch and
  consolidated statements come from one Chart of Accounts rather than from
  separate charts per branch.

### What this changed in the build

**The security predicate, in twenty-four policies.** Migration
`0041_d10_permitted_branches.sql` replaced *"is this row in my session's
branch?"* with *"is this row in a branch I am permitted?"* across every
branch-scoped table. Two functions carry it:

- `app_permitted_branches()` — the user's scope rows, read `SECURITY DEFINER`
  with a fixed `search_path`, so the answer cannot be widened by changing what
  the caller may read. Fails closed: no `app.user_id`, no branches.
- `app_branch_allowed(branch)` — the predicate the policies use.

`app_current_branch()` keeps its name and loses its authority. It is now the
Active Branch: a default and a filter, and it decides nothing about access.

**It closed a hole in the 01.2 gate.** `0043_d10_document_line_scope.sql`. Nine
document *line* tables had no row-level security at all, while the application
role held `SELECT` on every one of them:

> `ap_invoice_line` · `goods_receipt_line` · `goods_return_line` ·
> `opening_stock_line` · `purchase_order_line` · `sales_order_line` ·
> `service_receipt_line` · `stock_count_line` · `supplier_payment_allocation`

The headers were protected from Phase 01 onward, so *"a user scoped to Branch A
cannot read a Branch B record by ID"* held for the document and not for its
contents: another branch's Sales Order could not be opened, and every line of it
— item, quantity, unit price, discount, delivery location — could be read
directly. For a purchase order, the supplier's prices.

Nothing was leaking through the application, because the services always joined
through the header. That is precisely the situation §22 is written against —
*"row-level security is enforced in the query layer, not only hidden in the
screen"* — since a control that lives only in the queries somebody remembered to
write is a control the next query forgets. D10 says where it must live: *"access
restrictions must be enforced by the backend and database/query layer."*

`purchase_order_line` and `sales_order_line` are scoped by the **line's own**
branch, because §8.3 and §7.2 let one order span branches and those columns exist
for exactly that; the other seven read their document's. A user permitted one
branch of a two-branch order therefore sees the header and the lines they are
entitled to, and the header total will exceed the lines they can see. That is the
honest outcome — the alternative is showing them another branch's prices so the
arithmetic looks tidy.

**The audit trail needed its own migration.** `0042_d10_audit_trail_scope.sql`.
`audit_event` is the one table whose policy is deliberately asymmetric, and 0041
had flattened it:

- *Read* is narrower than the branch rule — an unbranched event is
  administration-wide and is a Super User's to read.
- *Write* is wider — §25 requires authorisation failures to be logged, and the
  record of a **scope denial names the branch that was refused**, which under
  D10 is by definition one the actor does not hold. Until D10 that row got in by
  accident, because the refusal is recorded on a connection scoped to the branch
  being refused. The exception is now explicit and bounded to `outcome =
  'denied'` by the acting user, so a *successful* action still cannot be written
  into a branch the actor does not hold, and nobody can plant a denial
  attributed to somebody else.

**Lists apply two predicates, not one** (`services/list.ts`).
`app_branch_allowed` always — matching the policy, so the page and the row count
cannot disagree — and the Active Branch **only when the caller has not filtered
on branch themselves**. `allPermittedBranches` on a `ListQuery` widens the
default and never the permission.

**Reports split by what they are for.** In
`services/inventory-reports.ts`, valuation is a daily working figure, so it opens
on the Active Branch and takes `branchCode` or `allPermittedBranches` — the
month-end consolidation the old model could not express at all. The **trace does
not default to the Active Branch**: it answers *"where did this unit go"*, and a
unit that went to another branch is precisely the case someone runs a trace for.
Stopping at a screen default would have a recall report *not found* about a
movement the user is entitled to see.

The Trial Balance and Account Activity (`services/trial-balance.ts`) take the
same treatment as valuation, and for the same reason §4.2 makes Branch a
dimension: *"Baghdad Profit & Loss"* and *"all branches combined"* are two
reports, not one ambiguous one. They had relied on row-level security alone to
supply the branch, which stopped being a filter the moment security became the
permitted set.

**It resolved a live conflict in Phase 06.** §7.2 allows one Sales Order to
carry lines for several branches. Under the session-branch model that document
could not be approved in a single act, and a per-line `set_config` workaround had
been written to get round it. D10 removed the conflict at its source, and the
workaround was deleted rather than kept.

**One thing every future test has to know.** A principal's permitted branches are
now *rows*, not a claim the session makes. A fixture user created without
`user_branch_scope` rows is permitted nothing — so the first audited action fails
with a row-level security violation rather than the assertion the test was about,
and a scoped list quietly returns nothing and looks like correct scoping. Four
test files were seeding users without them. Seed both halves, or the test proves
the wrong thing.

**What did not change.** A user still cannot reach a branch outside their
permitted list, by ID, by URL or by API. Selecting an unpermitted branch as the
Active Branch grants nothing — the 01.2 gate is now tested from both seats, and
answers the same way from each.

---


## How to record a decision

When a decision is made, update its entry in place:

```markdown
| **Status** | 🟢 Decided |
| **Decided** | YYYY-MM-DD |
| **Decided by** | name |

### Decision
<what was decided, in enough detail to implement without further interpretation>

### Evidence
<link to the written approval — §28.1 requires written approval>
```

Then raise the corresponding change request if the decision alters anything already built, using [`CHANGE-REQUEST-TEMPLATE.md`](CHANGE-REQUEST-TEMPLATE.md).

Per §28.1, a change is not complete until documentation, automated tests, UAT evidence and training material are updated.
