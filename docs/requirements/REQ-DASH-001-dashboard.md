# REQ-DASH-001 — Dashboard

The landing screen at `/`. It has been deliberately blank since 2026-08-26; this
specifies what should replace the blank, and why it is a worklist rather than a
report.

| | |
|---|---|
| **Requirement ID** | `REQ-DASH-001` |
| **Release** | 1 |
| **Phase** | Operations build — after block 10 |
| **Blueprint section** | §5 (permissions) · §14.4 (maker-checker) · §15–16 (open items) · §21 (notifications) |
| **Test case(s)** | *None yet. §15 states the criteria; each gains its test link when the screen is built — a link to a test that does not exist would fail the 00.6 gate and is worse than no link.* |
| **Status** | Built — awaiting acceptance |
| **Approved by** | *Not yet approved. §28.1 requires written approval from the Business Process Owner before any of this is built.* |

---

## 1. Business objective

A person signing in should see what needs them today, and nothing else.

The dashboard this replaces (the original foundation dashboard, since removed
from the tree) showed live record counts, a fortnight of audit activity as a line chart,
the users-by-role split and the department managers. It was switched off by
direction on 2026-08-26 and should stay off: none of those figures is something
anybody does anything about. A count of items rises whether the month is going
well or badly.

What a person actually opens an accounting system to find out is three things,
in this order:

1. **What is waiting for me** — an approval nobody else can give, a document I
   raised and never posted.
2. **Where the money stands** — what is owed to us, what we owe, what is in the
   bank, and whether the period is open.
3. **What is wrong** — the small number of things that are broken and will stay
   broken until a human looks at them.

Anything that is a report already has a screen with filters, a period and a
Print / Export menu. The dashboard must send a person to the Trial Balance, not
attempt to be a smaller one — a figure on a dashboard that disagrees with the
report it summarises is worse than no dashboard, and every summary eventually
disagrees.

Process owner: Business Process Owner (Issa Mohammed), per §28.

## 2. Actors and permissions

The dashboard introduces **no permission object of its own**. Each band asks the
same object the screen behind it asks, so a person sees a band only if they can
already reach what it points at, and the dashboard can never become a way to
read something a role was refused.

| Band | Object asked | Verb | Roles that will see it today |
|---|---|---|---|
| Waiting on me — approvals | `workflow_instance` | view | accounting_officer, accounting_manager, ceo |
| Waiting on me — my drafts | each document's own object | view | whoever may view that document |
| Waiting on me — notifications | *the recipient's own* | — | everyone, own rows only |
| Money — bank and cash | `bank_account` | view | accounting_officer, accounting_manager, ceo |
| Money — receivable ageing | `ar_invoice` | view | accounting_officer, accounting_manager, ceo |
| Money — payable ageing | `ap_invoice` | view | accounting_officer, accounting_manager, ceo |
| Money — open period | `fiscal_period` | view | accounting_officer, accounting_manager, ceo |
| Wrong — inventory integrity | `inventory_movement` | view | accounting_manager, ceo |
| Wrong — unidentified receipts | `customer_receipt` | view | accounting_officer, accounting_manager, ceo |
| Wrong — accounts with no G/L | `bank_account` | view | accounting_manager |
| Wrong — overdue invoices | `ar_invoice`, `ap_invoice` | view | accounting_officer, accounting_manager, ceo |

**Data scope.** Every figure is the signed-in person's active branch, through
the same row-level security every other screen reads under. A figure that
silently spanned branches would be the one number on the screen that no report
can reproduce.

**Super User (§5.1)** sees every band. This is the one place that matters,
because a super user cannot approve (§14.4) — their approvals band is therefore
always empty, and that is correct rather than a fault.

## 3. Preconditions

- The person is signed in. An unauthenticated visitor is redirected to
  `/sign-in`, which is the only thing the current page does and must survive.
- No document, period or master record is required. Every band is allowed to be
  empty on a fresh system.

## 4. Screen and fields

One page, three bands, in the order below. **A band with nothing in it is not
drawn** — not drawn empty, not drawn with a "nothing here" line. This is the
rule `SectionTabs` already follows for a row of one: a screen that lists its own
emptiness teaches people to scroll past it.

Each row is a link to the document or screen that proves it. No row is an
editable control; nothing is approved, posted or allocated from here. A
dashboard that acts is a dashboard people press by accident.

### Band 1 — Waiting on me

| Field | Type | Source | Notes |
|---|---|---|---|
| Count | integer | `approvals.inbox` length | The band's heading carries it |
| Document number | text | `workflow_instance.document_id` → the document | Links to the document |
| Document type | text | `workflow_instance.document_type_code` | In words, not the code |
| Raised by | text | `app_user.display_name` | |
| Waiting since | date | `workflow_instance.submitted_at` | Business date, oldest first |
| My drafts | integer + rows | union across document tables — see §7 | Documents I raised, still `draft` |
| Unread notifications | integer + rows | `notifications.inboxFor(tx, userId, { unreadOnly: true })` | |

Oldest first, deliberately: an approval that has waited nine days is the one
that matters, and newest-first buries it.

### Band 2 — Money, as at today

| Field | Type | Precision | Source | Notes |
|---|---|---|---|---|
| Account | text | — | `bank_cash_account.code` · `name` | Bank and cash, one row each |
| Balance | money | 4 dp, IQD | the subledger beside the journals | Same figure the Bank/Cash Statement closes at |
| Receivable outstanding | money | 4 dp, IQD | `ar_invoice.net_iqd − allocated_iqd` where status is `posted` or `partially_executed` | Split by bucket |
| Payable outstanding | money | 4 dp, IQD | `ap_invoice.total_iqd − settled_amount_iqd`, same statuses | Split by bucket |
| Ageing bucket | enum | — | `domain/ageing.ts` `bucketFor(dueDate, today)` | current, 1-30, 31-60, 61-90, 90+ |
| Open period | text | — | `services/periods.ts` | Says which period accepts a posting today |

**Money fields (§24).** Every amount here is IQD at 4 decimal places, the scale
the services return, and is shown through `formatMoney` like everywhere else.
The dashboard performs **no currency conversion**: a figure converted at a rate
the screen chose is a figure no statement can reproduce.

### Band 3 — Needs attention

Exceptions only. Each is one line naming the thing and the count, linking to
where it is fixed.

| Exception | Source | Where it is fixed |
|---|---|---|
| Inventory integrity findings | `services/inventory-integrity.check` | Stock Ledger / Stock Movement |
| Receipts with no payer (§16) | `customer_receipt.customer_id is null`, status `posted` | The receipt's own page |
| Bank/cash account with no G/L account behind it | `bank_cash_account.gl_account_code is null` or the account is gone | Bank/Cash Accounts |
| Invoices overdue | ageing bucket `90+`, then `61-90` | The invoice |

The third of these is not hypothetical: `CASH-ACCOUNTANT_ERBIL` points at a
deleted `chart_of_account` and has been failing the weekly restore drill. It is
visible today only to somebody who reads the drill log.

### Band 4 — How the business is doing (charts)

Added 2026-09-29 at the sponsor's direction; see §16 for what it replaced.

| Chart | Form | Why that form | Source |
|---|---|---|---|
| Income and expenses, month by month | grouped columns, 2 series | the two are *compared*, not added — a stack would invite reading a total that means nothing; one baseline, one scale, never a second axis | `profitOrLoss`, once per month |
| Owed to us / by us, by how late | one ordered stacked bar each | ageing is an ordered scale, so a one-hue ramp where later is darker — not a categorical palette, which would ask colour to mean identity when it means severity | the ageing buckets of Band 2 |
| Cash and bank balances | horizontal bars, one series | ranked magnitude across accounts that have no natural order | the same balances as Band 2 |
| Biggest customers | horizontal bars, one series | ranked magnitude, top eight | posted A/R, year to date |
| Stock held, by warehouse | horizontal bars, one series | ranked magnitude | `inventoryReports.valuation`, summed per warehouse |

**Conditions, all of which are the difference between a chart and decoration:**

- **Every figure comes from the service that owns it.** The monthly series is
  twelve calls to `profitOrLoss` — the Income Statement's own function — rather
  than one query grouped by month, because the statement's totals come from the
  *layout* Finance mapped, not from summing account types. A query written for
  the chart would be a second opinion about what counts as income.
- **Every chart has a table of the same numbers**, open from the chart itself.
  No value is reachable only by pointing at it.
- **One series, one colour.** No chart colours its bars darker-where-bigger:
  that spends the only free channel on what the bar's length already says.
- **The palette is validated, not chosen.** Two categorical slots and a
  five-step ordinal ramp, checked against this application's own light and dark
  surfaces for lightness band, chroma, colour-vision separation,
  normal-vision separation and contrast. The dark ramp stops one step lighter
  than the light one because its darkest step measured 1.95:1 against the
  window.
- **A chart with nothing in it is not drawn.** An empty plot reads as a fault in
  the data.

## 5. Workflow and status

None. The dashboard has no state of its own and no lifecycle. It renders what
other documents are in the middle of.

## 6. Validations

None on input — the screen takes no input. The rules that apply are rendering
rules:

| # | Rule | Reason |
|---|---|---|
| 1 | A band the person may not see is not rendered, not rendered empty | §5.1 — the absence of a band is not a disclosure; an empty band with a heading is |
| 2 | A band with zero rows is not rendered | A screen that lists its own emptiness is scrolled past |
| 3 | Every figure states its branch, or is the active branch | A figure whose scope is unstated is a figure nobody can reconcile |
| 4 | No band performs an action | See §16 |
| 5 | A failing band does not fail the page | One slow or broken query must not blank the landing screen |

Rule 5 has a cost worth stating: a band that fails silently is a band nobody
notices is missing. It should render as one line saying it could not be read,
which is an exception in Band 3 terms rather than a blank space.

## 7. Calculations

Three, and all of them are sums of figures the services already hold. Nothing is
re-derived from documents.

1. **Receivable / payable outstanding.** Per invoice, `total − settled`, summed.
   These are the same expressions `supplier-payment.outstandingOn` and the AR
   equivalent use, so the dashboard's total and an invoice's own outstanding
   cannot drift.
2. **Ageing bucket.** `domain/ageing.ts` already exposes `bucketFor` and
   `AGEING_BUCKETS`; nothing on screen uses them yet. This screen would be the
   first consumer, which means the buckets get their first test here.
3. **My drafts.** *This is the one piece of genuinely new query work.* There is
   no view over "documents this person raised that are still draft" — it is a
   union across `ap_invoice`, `ar_invoice`, `supplier_payment`,
   `customer_receipt`, `journal_entry`, `stock_transfer`, `stock_adjustment`,
   `opening_stock`, `sales_return` and `goods_return`. That union must be kept
   in step as document tables are added, exactly as
   `tests/integration/ops16-document-table-lists.test.ts` already keeps
   `resetTestData` and `format-live-database.sh` in step. **It should be derived
   from the schema and covered by that same test, not hand-written.**

Balances in Band 2 are read, not computed: the bank and cash figures come from
the subledger the posting engine writes, the same source
`partner-statement.ts` reads, so the dashboard closes where the statement does.

## 8. Accounting event

None. Nothing on this screen posts.

| Event | Debit | Credit | Control rule | Appendix C row |
|---|---|---|---|---|
| — | — | — | not applicable | — |

## 9. Inventory and operational event

None. Band 3 *reports* inventory integrity findings; it does not touch
`inventory_movement`.

## 10. Integrations

None outward. Inward, the dashboard is a reader of services that already exist:

| Band | Service |
|---|---|
| Approvals | `services/approvals.ts` — `inbox`, `mySubmissions` |
| Notifications | `services/notifications.ts` — `inboxFor` |
| Bank and cash | `services/bank-cash-accounts.ts`, `services/partner-statement.ts` |
| Ageing | `domain/ageing.ts` over `ap_invoice` / `ar_invoice` |
| Period | `services/periods.ts` |
| Integrity | `services/inventory-integrity.ts` — `check`, `findingCount` |

No new service is required except the drafts union in §7.3.

## 11. Attachments and evidence

None.

## 12. Notifications

The dashboard raises none. It *displays* the §21 inbox, which is a different
thing: the nightly 02:15 inventory integrity check already notifies accounting
managers in-app, and Band 3 is where that notification should also be visible to
somebody who has not opened the bell.

## 13. Reports and audit

- The dashboard is **not** a report and carries no Print / Export menu. Every
  figure on it belongs to a report that has one.
- Rendering it is a read and is not audited. Auditing a landing page would bury
  the trail that matters under one row per sign-in.
- Every link leads to a screen that is audited in its own right.

## 14. Exceptions

- **A brand-new system, nothing posted:** every band is empty, so the page is
  empty. That is correct and must not be papered over with a welcome panel.
- **A person with no grants at all:** no band renders. They should see the same
  "what to ask for" line the other screens give rather than a blank page.
- **A super user:** the approvals band is always empty, because a super user
  cannot approve (§14.4). Not a fault.
- **No period open:** Band 2's period line says so. This is worth surfacing —
  only the current fiscal year is open, and a person discovering it at the
  moment they try to post has already done the work.
- **A slow band:** see §6 rule 5. The page renders; the band says it could not
  be read.

## 15. Acceptance criteria

Criteria only. Each gains its test link when the screen is built — §15 of the
template requires that every criterion name a test, and a criterion naming a
test that does not exist would pass the eye and fail the build.

```
Given  a signed-in Accounting Manager with two approvals waiting
When   they open /
Then   the approvals band names both, oldest first, each linking to its document
```

```
Given  a signed-in user with no approvals waiting
When   they open /
Then   no approvals band is rendered at all
```

```
Given  a Super User
When   they open /
Then   the approvals band is absent, because a super user cannot approve
```

```
Given  posted A/R invoices in several ageing buckets
When   the receivable band is rendered
Then   each bucket's total equals the sum of (net − allocated) for its invoices
And    the total equals the figure the Customer Statement closes at
```

```
Given  a person whose active branch is HQ
When   any figure is rendered
Then   it covers HQ and no other branch
```

```
Given  a bank or cash account whose G/L account has been deleted
When   the attention band is rendered
Then   it names that account and links to where the G/L account is chosen
```

```
Given  a user holding `view` on ar_invoice but not on inventory_movement
When   they open /
Then   the receivable band renders and the integrity band does not
```

```
Given  one band's query fails
When   the page is rendered
Then   the other bands still render, and the failed band says it could not be read
```

```
Given  an unauthenticated visitor
When   they open /
Then   they reach the sign-in form
```

```
Given  the layout is rendered right-to-left
When   the page is displayed
Then   it remains usable, with no sideways scroll
```

## 16. Out of scope

Excluded, not deferred. Each of these was considered and rejected for a reason,
and the reason is the point:

- ~~**Charts of any kind.**~~ **Reversed by the sponsor, 2026-09-29.** This
  section argued that a trend nobody acts on is decoration. The sponsor's answer
  was that an executive reads the shape of a year faster than a column of
  figures, and that is a fair correction: the objection was to the *old*
  dashboard's 14-day activity line — a count of records with no decision
  attached — not to charts as such. Charts are in scope, under §4 Band 4, with
  the conditions that make them answerable rather than decorative: every series
  comes from the service that owns the figure, every chart carries a table of
  the same numbers, and a chart with nothing in it is not drawn. What stays
  excluded is the activity line itself.
- **Record counts** — how many customers, items, users. Nobody does anything
  about these numbers.
- **Acting from the dashboard** — approving, posting, allocating. These are
  maker-checker decisions (§14.4) and belong on the document, where the person
  can read what they are deciding about. A one-click approve on a summary line
  is how a control becomes a formality.
- **A configurable widget layout.** Every person choosing their own dashboard
  means no two people discussing "the dashboard" mean the same screen.
- **Any figure in a currency other than IQD**, or converted at a rate this
  screen picks. See §4, Band 2.
- **A P&L or balance-sheet summary.** Those are periods and levels and a
  comparison basis; a single figure without them is a number nobody can
  reconcile. Link to the statement instead.

---

## Review checklist

- [x] All sixteen sections completed
- [x] Every field in §4 has a source and, where it is money, its precision
- [x] Every §8 account is a name, not a code — not applicable; no accounting event
- [ ] Every §15 criterion maps to a named test — **deliberately open; this is a specification, not a built screen**
- [x] §16 states exclusions explicitly
- [ ] Approved in writing by the Business Process Owner (§28.1)
