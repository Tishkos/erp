# QS ERP — Phase 0 · System Foundation — acceptance record

> **Source:** `QS ERP Phase 0.pdf` (this folder) · **Status:** accepted 2026-08-23
>
> This folder holds the phase definitions the programme follows from here: one
> PDF per phase, one acceptance record like this one when the phase closes.
> The next phase begins when its PDF lands in this folder.

## Delivery model

Every Phase 0 screen reads and writes the database (wired 2026-08-23). The
foundation *rules* — statuses, numbering, approval routing, audit,
permissions — are real domain code, database schema and services, enforced
today and covered by the unit suite; the administration screens now sit on
top of them through six services (`company`, `branches`, `departments`,
`users`, `roles`, `number-series`) and an `approvals` inbox service. None
of the eleven Phase 0 routes carries the PREVIEW banner.

## The ten requirements

| # | Requirement | Where it lives | How it is verified |
|---|---|---|---|
| 1 | Company Setup | `/administration/company` (settings screen); company identity in the shell header and sign-in screen | Screen renders with company context (Qimah Al-Safinah · Head Office · IQD · fiscal 2026) |
| 2 | Branches | `branch` table with the §4.1 rule that a branch, its default warehouse and default cash account are created together (deferred DB constraint); `/master-data/branches`; every session is branch-scoped (`applyScope`) | Seed creates HQ with warehouse and cash account in one transaction; constraint fires at COMMIT |
| 3 | Departments | `department` table; `user_department_scope` carries the per-department manager flag; `/master-data/departments` | Seeded FIN and OPS; manager flag drives approval routing (below) |
| 4 | User Management | `app_user` (active flag, individual accounts), branch and department scopes per user; sessions are httpOnly server-issued cookies; `/administration/users` | Sign-in/deny e2e suite; four seeded accounts demonstrate the differences |
| 5 | Roles and Permissions | Grants are object × verb (`permissions.ts`), deny-by-default on every page — navigation hiding is not access control; `/administration/roles`, `/administration/permissions` | e2e: outsider is refused on the direct URL; `permissions.test.ts` |
| 6 | Department Approval Flow | `department-routing.ts`: an ordinary employee submits to the Department Manager; the manager of the **document's** department finalises directly; a manager raising a document in another department submits like anyone else. Approvals arrive in `/approvals` | `department-routing.test.ts` covers all three cases; `workflow.test.ts` covers the engine |
| 7 | Standard Document Statuses | `statuses.ts` — one closed vocabulary for every document. The PDF's five are the whole set an invoice can be in: Draft→`draft`, Pending Approval→`submitted`, Approved/Final→`approved`, Cancelled→`cancelled`, Reversed→`reversed`. A refusal is not a sixth state: it returns the document to Draft with the approver's reason on the record (migration `0161`). Nothing is ever deleted — a delete trigger refuses outright, and invalid transitions are rejected in UI and API because both call the same machine | `statuses` unit tests; `phase00-invoicing.test.ts` walks the whole structure on a live document |
| 8 | Main System Navigation | `menu.ts` — the full Appendix A tree, filtered by role server-side | Live check: the administrator sees 11 sections, the accounting officer 9 (no HR, no Reports) |
| 9 | Automatic Document Numbering | `numbering.ts` + `number_series`; per-series sequences, numbers never reused; `/administration/numbering` | `numbering.test.ts`; numbers visible on every record and list |
| 10 | Record History | The record framework renders, on every record: summary (created by/when, status, owner, branch, source), the approvals timeline (who, when), related documents, journal entries and the audit timeline; `/administration/audit` is the trail report | `audit.test.ts`; live check on a record page shows Created→Updated→Submitted→Approved→Posted with actor and timestamp |

## The document the foundation is demonstrated on

Phase 0 defines rules rather than modules, which leaves it hard to check: a
rule nothing has gone through is a claim. **Invoicing** (`/accounting/invoicing`,
under Accounting → Sample documenting) is one document carried through every
rule the phase defines, and nothing more — it posts to no ledger, because that
is the accounting phases' work.

Pressing **New invoice** opens the document itself, already numbered. The
header, the items and the total are filled in on it, the way an ERP works;
nothing is typed into a dialog before the record exists.

| What it exercises | How |
|---|---|
| §9 numbering | `INV-{YYYY}-{SERIAL}`, allocated by `doc_sequence` at the moment the document is opened, never reused — an abandoned draft keeps its number |
| §7 statuses | Draft → Pending approval → Approved; **Cancelled** before a decision, **Reversed** after. A refusal is not a sixth state: it returns the invoice to Draft with the approver's reason on the record (migrations `0161`, `0163`) |
| Lines and totals | Items carry description, quantity and unit price; the line total is checked by the database and the invoice total is re-summed by a trigger, so the two can never disagree (`0162`). Lines move only while it is a draft, enforced in the database as well as the service |
| §5.2 approval | Submitted to the manager of the **invoice's** department; that manager, raising one in their own department, finalises it in the same act |
| §21 attachments | A file is stapled to the invoice, inspected on its content, scanned, stored immutably, and readable only by someone who may read the invoice |
| §10 record history | Who raised it and when, its status, the approval history with names, and the full audit trail — in words, not action codes |

Attachment storage is a directory (`ATTACHMENT_DIR`, `/var/lib/qs-erp/attachments`
in production) and the scanner is a signature check; the seam where S3/R2 and
ClamAV go is a single `registerStorage`/`registerScanner` call in
`attachments-runtime.ts`.

## Navigation, as it stands

**Accounting** carries **Master Data** (Branches, Departments) and **Sample
documenting** (Invoicing). **Settings** carries administration only. Everything
belonging to a later phase is refused by the phase gate, on the direct URL as
well as in the menu.

## Faults this phase found and fixed

Each of these was a real defect, found by putting a document through the rules
rather than by reading them:

- A number field with no `step` — the browser refused **1250.50** silently: no
  request, no message. Money fields now carry `step="0.01"`, and any number
  field defaults to `any` rather than to whole units.
- Document audit events were written unbranched, which D10 reserves for super
  users — so an ordinary employee could not see their own invoice's history.
  A record that belongs to a branch now records it.
- The line triggers ran under row-level security and could not always see
  their own parent. `invoice_line_draft_only` raised a false alarm; worse,
  `invoice_retotal` would have left a total quietly stale. Both are now
  `SECURITY DEFINER` (`0164`).
- Two forms on one screen shared a field id, which handed both labels to the
  first input and left the second with no accessible name.
- The module popover right-aligned itself whenever the item was among the last
  three — true of every item once the phase gate leaves three modules, so the
  widest popover opened off the left of the screen.
- The routing engine's execution effect was registered by whichever entry
  point happened to run first. On a freshly started server the invoicing
  screens got there before it, and an approval was correctly refused rather
  than silently doing nothing. Every invoicing action now registers first.

## Verified on acceptance

- 1,164 unit tests and 1,619 integration tests pass against a real PostgreSQL
  instance — statuses, numbering, workflow, department-routing, permissions,
  audit, attachments, and the invoice round trip itself
  (`tests/integration/phase00-invoicing.test.ts`, 29 tests).
- e2e: 41 browser tests pass, including the invoice round trip end to end —
  an employee opens an invoice, fills in its header, puts two items on it,
  attaches the order, and submits it; the manager of its department finds it
  in `/approvals`, opens it from there and approves it; and the record names
  both people, in words.
- e2e: unauthenticated visitors are redirected to sign-in; a user without
  grants is refused on the direct URL; sign-in failure does not reveal which
  half was wrong.
- Live route audit as the administrator: all twelve Phase 0 screens render
  (company, users, managers, roles, permissions, data-scopes, numbering,
  audit, branches, departments, approvals, home).

## Live accounts (erp.qs-groups.com)

By direction (2026-08-23) the production database holds exactly two active
accounts: `admin@qs-groups.com` (super user) and `employee@qs-groups.com`
(Accounting Officer, HQ). The seed's example.com accounts were renamed onto
them (history intact) or deactivated — accounts are never deleted. Passwords
were issued once, out of band; change them from *Profile settings*.

## Demonstration accounts (development seed)

| Account | Purpose |
|---|---|
| `admin@example.com` | Super user, for reviewing every screen |
| `manager@example.com` | Department Manager of Finance — finalises directly |
| `officer@example.com` | Ordinary employee — submits for approval |
| `outsider@example.com` | Holds nothing — demonstrates deny-by-default |

One password for all: see `scripts/seed-dev.ts`.

## Wired on 2026-08-23 — what each screen now does

| Screen | Live behaviour |
|---|---|
| `/administration/company` | Creates or updates the single company record; base currency chosen here |
| `/master-data/branches` (+ record) | Create (branch + main warehouse + cash GL account + default cash account in one transaction), edit, deactivate with reason; record history |
| `/master-data/departments` (+ record) | Create, edit, parent, finance flag, members, make/remove Department Manager (drives §5.2 routing), deactivate |
| `/administration/users` (+ record) | Create with one-time temporary password, roles, branch scopes + default, department scopes, reset password, deactivate (revokes every session), sessions list, history |
| `/administration/managers` | Every department with its managers |
| `/administration/roles` (+ record) | Create role; grant matrix by system section × permitted action |
| `/administration/permissions` | The whole role × section matrix |
| `/administration/data-scopes` | Every user × branch scope |
| `/administration/numbering` (+ record) | Create/edit series (pattern validated), issued count, last number, recent allocations, close/reopen |
| `/administration/audit` | The audit trail through the list framework — searched, paged, RLS-scoped |
| `/approvals` | Inbox (assigned to me, or to a role I hold), approve/reject through the record framework, my submissions, my decisions |

Grants: migration `0158_phase00_administration_grants.sql` adds the
`system_administrator` role (view/create/configure/administer/export on the
administration objects) and gives the finance roles a view on the inbox and
the organisation. `admin@example.com` remains a super user.

Verified by `tests/e2e/phase0.spec.ts`, one test per PDF requirement.
