# QS ERP — Phase 1 · Accounting Core — acceptance record

> **Source:** `PHASE-1-requirements.md` (this folder) · **Built:** 2026-08-25
>
> Phase 1 establishes the basic accounting structure: the Chart of Accounts,
> Journal Entries with approval, posting and reversal, and the reports read
> from what they post. It builds on the Phase 0 foundation and adds nothing
> the phase definition does not ask for.

## The five requirements

| # | Requirement | Where it lives | How it is verified |
|---|---|---|---|
| 1 | Chart of Accounts | `chart_of_account` under the five seeded type roots (Assets, Liabilities, Equity, Revenue, Expenses); `is_group` distinguishes a header from a posting account; an account is raised, approved by the Accounting Manager, and deactivated — never deleted. `/master-data/chart-of-accounts` | `phase1-accounting-core.test.ts` §1; e2e raises two accounts as one person and approves them as another |
| 2 | Journal Entries | `journal.ts` — number allocated on creation from the `JOURNAL_ENTRY` series and never reused, document date, posting date, description, optional attachment (§21), debit and credit lines. Submitted to the Accounting Manager through the Phase 0 workflow engine; a Finance Manager creates and posts directly (§14.4). `/finance/journals` | `phase1-accounting-core.test.ts` §2; e2e enters a two-line entry and posts it |
| 3 | Journal Posting and Reversal | Approval sets the entry `posted` in the same act. Database triggers refuse every edit and every delete of a posted entry and its lines. A correction is `journal.reverse()` — a full mirror with the sides swapped, carrying the original's own figures, linked in both directions permanently. `/finance/reversals` | `phase1-accounting-core.test.ts` §3 (seven tests, including refusing a second reversal and refusing to reverse a reversal); e2e reverses a posted entry and reads the register |
| 4 | General Ledger and Trial Balance | The General Ledger *is* the posted journal lines — there is no second table to fall out of step. `/finance/gl-inquiry` reads one account with a running balance; `/finance/trial-balance` totals every account with a movement and reports whether debits equal credits | `phase1-accounting-core.test.ts` §4; e2e checks the entry appears and the totals agree |
| 5 | Financial Reports | `financial-statements.ts` — Statement of Profit or Loss for a period, Statement of Financial Position as at a date, both from the same posted lines. Accounts are assigned to statement lines (`chart_of_account.statement_line`, migration `0165`); an unassigned account falls to its type's default rather than vanishing. `/finance/statements` | `phase1-accounting-core.test.ts` §5; e2e reads both statements and checks the Position balances |

## Two screens the phase definition does not name

Both are prerequisites without which requirement 3 cannot be performed at all,
so they are part of the phase rather than additions to it:

- **`/finance/periods`** — a journal posts *into a period*. Until a fiscal year
  is opened there is nowhere for an entry to go. The screen opens a year (which
  generates its twelve months) and moves a period between open, soft-closed and
  closed, each with a reason.
- **`/master-data/exchange-rates`** — every journal line is measured in the
  ledger currency **and** in USD, so a posting date with no rate in force is
  refused outright. Nothing at all could be posted until a rate was published.
  A published rate is never edited: a correction supersedes it, so a journal
  posted last month keeps the figure it was measured at.

## A rule relaxed, deliberately, and how to put it back

§4.2 makes **Business Line** mandatory on revenue and expense accounts, and the
rule is right — a Profit or Loss that cannot be cut by business line is worth
less than one that can. But the Business Line master is detailed accounting
Master Data, which Phase 1 explicitly excludes.

Left as it stood the two collided: every journal touching a revenue or an
expense account was refused for a dimension the system offered no way to
supply, which meant no Statement of Profit or Loss could exist. Migration
`0166` relaxes the requirement to `optional` **for `journal_entry` only**,
using the per-document override that exists for this purpose. Entries made
before the master arrives are unclassified rather than wrong.

**Tighten it to `mandatory` when the Business Line master ships.**

## Faults this phase found and fixed

Each was a real defect, found by putting an entry through the system rather
than by reading the code:

- **The record framework's action buttons did nothing.** Submit, Approve,
  Reject and the rest were rendered as inert `type="button"` — the right
  buttons, enabled at the right times, wired to nothing. Everything they needed
  already existed; `server/record-action.ts` connects them, and a refusal is
  now shown rather than swallowed.
- **Every account created through the screen became a header account.** The
  form read the kind with a presence check, and a `<select>` always submits a
  value — so nothing raised through the UI could ever take a posting.
- **The reports were ungrantable.** `gl_inquiry`, `trial_balance`,
  `financial_statement` and `journal_reversal` had no grants on any role, so
  the Trial Balance refused the Accounting Manager and told them to ask an
  administrator who had no way to grant it either (migration `0167`).
- **`ReasonForm` gave every reason field the same id.** A record offering
  reject, cancel and reverse at once handed all three labels to the first field
  and left the others with no accessible name.
- **Unnamed audit actions rendered as their own key.** The fallback used
  `try/catch`, but next-intl returns the key path for a missing message instead
  of throwing, so `audit_action.journal_entry.created` appeared on screen.
  `t.has()` is the check that actually works.
- **A reversal could be dated before what it undid.** The service now moves the
  date forward rather than refusing, and the database refuses it besides.

## Verified

- **1,164 unit tests** and **1,643 integration tests** pass — the whole suite,
  not only this phase's, so nothing Phase 0 relies on was disturbed.
- **`phase1-accounting-core.test.ts`: 24 integration tests** against a real
  PostgreSQL instance, one describe per requirement — including that the ledger
  is flat after a reversal, that the Statement of Financial Position balances,
  and that the database refuses a revenue account on an asset statement line.
- **`accounting.spec.ts`: 8 browser tests**, the phase's own expected result
  performed end to end — open the year, publish a rate, raise and approve two
  accounts, enter and post a balanced journal, read it in the General Ledger
  and the Trial Balance, produce both statements, reverse the entry, and see
  the books flat again.
- **49 browser tests** pass in total; Phase 0 is unaffected.

## The design pass (2026-08-25)

After the first deploy, by direction:

- The rates screen was offered **twice in one dropdown** — "Exchange Rates"
  under Finance and "Currencies and Rates" under Master Data, both leading to
  the same page. It is master data, so Master Data keeps it and the Appendix A
  tree loses the duplicate.
- Filter rows aligned to `flex-end`, so one field carrying a hint grew taller
  and every other input in the row dropped to match its bottom edge. They
  align to the top now: labels on one line, inputs on the next.
- **Accounting periods** put a state picker, a reason box and a Save button on
  each of twelve rows — thirty-six controls for an action taken once a month,
  burying the twelve facts a person came to read. One change form above a
  read-only calendar instead.
- The statements listed accounts whose balance nets to nil (a posting and its
  reversal). Those belong in the Trial Balance and the General Ledger, which
  are about movement — not on a statement of balances.
- The Trial Balance's first column header rendered as `COLUMN.ACCOUNT`: a
  message key nobody had written.
- The Statement of Financial Position borrowed the Trial Balance's words and
  claimed "Debits equal credits". Its own claim is that the two sides agree.
- The journal document band repeated the entry number the heading directly
  above it already carried, and an empty Attachments panel appeared on posted
  entries, where nothing more can ever be attached.

## Not included, as the phase definition requires

Accounts Payable, Accounts Receivable, Treasury and Banking, Fixed Assets,
Budgeting, customer and supplier subledgers, inventory accounting, purchasing,
sales, payroll and the detailed accounting Master Data. The phase gate refuses
all of them on the direct URL as well as hiding them from the menu.
