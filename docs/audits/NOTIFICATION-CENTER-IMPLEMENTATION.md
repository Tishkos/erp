# Notification Center — implementation record (platform phase, Agent 6)

Branch `platform/notification-center` · worktree `/home/claude/wt/notifications` ·
databases `erp_notifications` / `erp_test_notifications` · port 3006 · migration
`0350_notification_center` (journal `idx` 226, `when` 1795900000160) · controls
C-70 to C-73.

This is a record of what was built and how to extend it. It claims no more than
the targeted checks in "Checks run" show; nothing here has been run against the
merged tree, the full unit suite or the full integration suite, and nothing here
is a statement that the module is ready for production use.

## 1. What it is

One bell, one list, one table. The notification centre **extends**
`services/notifications.ts` and the delivery runner (`notification-runner.ts`);
there is no second system. What it adds:

* the header bell: the unread count in place of the glyph, a popover with
  *Unread / All*, a category filter, relative time with the absolute time on
  hover (`title`), mark read / unread / all read, and the way into the full
  screen;
* `/notifications`: a list screen (copy of Purchase Invoices — Show and Category
  as a `FilterRow`, the standard register, paging at 50) with the same actions;
* `/notifications/open/<id>`: the one door a click goes through. It works out
  where the notification leads **now, for this reader**, marks it read only if
  they can go there, and otherwise answers "no longer available" — never a dead
  link;
* the **registry** (`domain/notification-center.ts`): every kind of notification
  declares in one line its category, the permission object a recipient needs, its
  window (when it may be told again) and whether its text is a person's own words;
* `emit(kind, …)`: the stable function a module calls to tell named people.

## 2. Architecture

```
module (workflow, shipments, cloud-files, chat, tasks, sweeps …)
   │  emit() / insertNotification() / raise()      ← one write path
   ▼
services/notifications.ts      refusalFor (grant, branch, active) ─► app_notify (ON CONFLICT DO NOTHING)
   │                                                                   │
   │ unreadCountFor / countsFor / listFor / findFor / mark*            ▼
   ▼                                                      notification (FORCE RLS: recipient only, 0350)
services/notification-center.ts   resolveTarget (reader's scope) · feedFor · open · markAllReadAudited
   ▲                         ▲
   │                         └── GET /notifications/open/[id]   (redirect, or /notifications?gone=1)
   │
POST /notifications/api/feed ◄── components/notifications/notification-store.ts (one poll, useSyncExternalStore)
                                   └─ notification-bell.tsx (count, popover) · note-text.ts (labels, times)
/notifications (page.tsx, actions.ts) — the list screen
```

* `domain/notification-center.ts` — pure: `KINDS`, `KIND_PREFIXES`, `registerKind`,
  `kindDef`, `matchOf` / `claimedByOthers` (SQL category filters from the same
  registry), `windowToken`, `dedupeKeyOf`, `needsOccurrence`, `labelParams`,
  `pollIntervalMs`, `badgeText`, `relativeParts`.
* `services/notifications.ts` — the writer/reader (see §4).
* `services/notification-center.ts` — target resolution, feed, open, audited
  mark-all.
* UI in `components/notifications/`; the shell (`erp-shell.tsx`, `app-shell.tsx`)
  passes a seed (unread count, books' time zone) and draws the three small parts.

## 3. Where the data comes from

Everything is the `notification` table (+ `notification_delivery`,
`notification_rule`). The count is a partial-index query; the list is `listFor` (newest first,
offset paging at 50, 12 in the popover); category counts come from one
grouped query. Labels are not stored: the table keeps the emitter's plain English
`subject` / `body` as a fallback, and the screen draws
`notifications.kind.<kind with dots as underscores>` (EN/AR) from the facts in
`context` (`labelParams`). Chat text is shown as written (`userText`).
Nothing on the screen is mocked; with no notifications the list says so.

## 4. The contract other modules use

```ts
import * as notifications from '@/server/services/notifications';

await notifications.emit(tx, {
  kind: 'task.assigned',            // an entry of KINDS / KIND_PREFIXES, or a new one
  objectType: 'task', objectId: row.taskNo,
  recipients: [assigneeId], except: [actorId],
  subject: 'Task T-12 assigned to you',            // plain fallback text
  context: { taskNo: row.taskNo, name: row.title, actor: actorName, href: `/tasks/${row.taskNo}` },
  occurrence: `${revision}`,        // REQUIRED for an `occurrence` kind
  branchCode: row.branchCode,
});
// → { created, suppressed, skipped, ids }
```

* `emit` — named people; checks each recipient (active, grant on the kind's
  `object`, branch) and optionally `recordAccess: true`; dedupes; adds the delivery
  rows/jobs of any active rule for the kind.
* `insertNotification(tx, row)` / `tryInsertNotification` — the older, lower
  contract (caller builds `dedupeKey`); signatures unchanged, so Chat, the Task
  Center, HR and the sweeps keep working. Registered kinds with an `object` are
  grant-checked here too (`not_permitted` → `null`).
* `raise(tx, …)` — the rule-driven path (recipients by role); it now also skips
  people who may not be told.
* Reads: `unreadCountFor(tx, userId)`, `countsFor`, `listFor(tx, userId, {state,
  category, q, page, pageSize})`, `findFor`, `categories()`; writes
  `markRead`, `markUnread`, `markManyRead`, `markAllRead(tx, userId, {category})`.
* `safely(tx, step)` — runs a notice in a savepoint; a failure is logged and left
  out, the business act commits (C-73).

### Adding a kind (one line)

```ts
// domain/notification-center.ts  — KINDS
'bank_reconciliation.issue': { category: 'accounting', object: 'bank_reconciliation', window: 'day' },
```
plus `notifications.kind.bank_reconciliation_issue.title` (and optional `.detail`)
in `messages/en.json` and `messages/ar.json`. `tests/unit/notification-center.test.ts`
fails on a registered kind with no label in either locale. A module that owns many
kinds can call `registerKind()` at load instead; a family (`hr.`, `task.`) is a
`KIND_PREFIXES` entry. An unregistered kind still works — category by prefix, else
*system* — so an emitter never loses a notification because the registry was behind.

Label parameters available to a message: `{ref}` (reference/number/code/task no.),
`{party}`, `{days}`, `{actor}`, `{amount}`, `{date}`, `{name}`, `{count}`, `{extra}`.
Avoid apostrophes in ICU strings.

## 5. Events

| Kind | Category | Who emits | Window / recurrence |
|---|---|---|---|
| `approval.required` | approvals | `workflow.submit` (approvers of the step, never the submitter), next step after a decision | `occurrence` = `revision:step` |
| `approval.completed`, `approval.rejected` | approvals | `workflow.decide` (to the submitter) | `occurrence` = revision; recall settles the open asks |
| `chat.message`, `chat.mention` | chat | `chat.ts` (Wave 1, unchanged) | its own key: first unseen message / per message |
| `document.linked` | documents | `cloud-files.ts` › `tellLinked` (file linked to a record) | `occurrence` |
| `customer_receipt.received`, `supplier_payment.made` | payments | existing rules | `once` |
| `ar_invoice.*`, `ap_invoice.*` due soon / due today / overdue | invoices | `due-notices.ts` (06:20 job) | `day` — told each business day while the condition lasts (existing behaviour) |
| `ar_invoice.paid_late`, `ap_invoice.paid_late` | invoices | existing | `once` |
| `container.late` | logistics | `shipments.lateSweep` ← `payables-sweep` (06:10 job) | `occurrence` = the ETA that passed |
| `payable.stage.changed`, `payable.hold.*`, `shipment.status_changed` | logistics | existing | `occurrence` / `day` |
| `fiscal_period.close_blocked`, `inventory.integrity_failed`, `project.availability_warning` | accounting | `closing-checks`, `inventory-integrity`, projects | `day` |
| `system.health` | system | `health-check` job | `day` |
| `hr.*` | hr | HR stages (existing) | `occurrence` |
| `task.*` | tasks | **Task Center** (parallel agent) through `insertNotification` | their own keys; registry slots exist |

**Slots with no emitter yet (listed for the module that owns them):**
`reconciliation.issue` (Bank Reconciliation: unmatched lines past a threshold —
call `emit` with `occurrence` = the statement/run id); the `exception.*` family
(Exceptions agent); Automation notices. Each has a category, a window and, for
`reconciliation.issue`, a label in both locales.

No new sweep job was needed: invoice, container, closing, integrity and health
notices ride on the existing lines of `scripts/ops/crontab.erp`
(`payables-sweep`, `due-notices`, `closing-checks`, `inventory-integrity`,
`health-check`). `crontab.erp` is unchanged.

## 6. Dedupe and re-notification rule

The key is `kind|objectType|objectId|window|recipient` — the existing unique index
`notification_dedupe_uniq` and `ON CONFLICT DO NOTHING` inside `app_notify` (0238).
A refresh, a double render, a retry or two requests at the same instant write one
row. When the same subject may be told **again** is the kind's `window`:

* `once` — never again (payment received, paid late);
* `day` — once per business day (`businessToday()`, Asia/Baghdad) while the
  condition lasts. An invoice that stays overdue is told each morning. That is the
  existing behaviour of `due-notices.ts`, kept; **recommendation:** a weekly window
  after day 7 overdue would be quieter — a one-line registry change plus a
  `windowToken` case;
* `occurrence` — as often as the caller names a new occurrence. `emit` throws if
  an `occurrence` kind has none, so a second legitimate event is never silently
  dropped as a repeat.

## 7. Permissions

* **At creation:** `refusalFor` — the recipient is active, holds `verb` (default
  `view`) on the kind's `object`, and (when a branch is named) is in that branch.
  Super users pass the grant. `emit({ recordAccess: true })` also resolves the
  target as the recipient, inside the caller's transaction.
* **Reads:** FORCE RLS (0350): `notification_read` / `notification_update` allow the
  recipient only; a super user reads their own. The scheduled delivery runner and
  the DB-level sweeps set `app.system_sweep`. `notification_forward_only` keeps
  what a notification says fixed; `read_at` moves both ways, `acted_at` /
  `escalated_at` forward only. `notification:view` is granted to every role (so
  each person has a screen); it limits nothing about *whose* rows they see.
* **At open:** `resolveTarget` runs in the reader's scope — their grants and RLS —
  on listing and again on click. A record that is gone, left their branch or lost
  its grant reads "No longer available", with the notification's text withheld
  (it may name a party or amount), and no link.
* **INSERT:** `notification_write` stays `app_signed_in()` (existing); the recipient
  grant check is the service layer's (`refusalFor`), not the database's.
* The feed route is POST, same-origin only; 401 with no session, 403 for a restricted
  account, a foreign origin or no `view` on `notification`; the open route ignores
  prefetches and cross-site loads.

## 8. Routes

| Route | Purpose |
|---|---|
| `/notifications` | list screen (`?state=unread|all`, `?category=`, `?q=`, `?page=`, `?gone=1` flash) |
| `/notifications/open/[id]` | GET → redirect to the resolved target, or `/notifications?gone=1` |
| `/notifications/api/feed` | POST `{list, scope, category}` → `{unread, categories, items, zone}` for the bell |

`/notifications` was already catalogued (the Approvals / Notifications / Chat tabs);
it is now in `DELIVERED` (`domain/screens.ts`) and in the screen catalogue's
delivered-route expectation. The catalogue's total (250) is unchanged.

## 9. Database

`0350_notification_center.sql` (journal idx 226): indexes `notification_unread_idx`,
`notification_kind_idx`; recipient-only `notification_read` / `notification_update`;
`notification_forward_only()`; `app_deliveries_stuck()` (definer; System Health
counted others' rows as a super user); `notification:view` for every role;
`permissions_version` bump. **No new table**, so `resetTestData` and
`format-live-database.sh` are unchanged (`ops16-document-table-lists` passes).

## 10. UI and rules followed

Only existing classes: `coa-count-badge`, `erp-utility-popover*`,
`erp-notifications__list` / `__unread`, `coa-button--filter` / `--active` /
`--secondary`, `coa-compact-button`, `.actions`, `.muted`, and the `s.sap*` register
classes; no inline styles, new CSS or icons. The bell never writes global state
during server render (seed adopted in a layout effect); notification links are plain
`<a>` so a prefetch cannot open and mark read. `notifications` is in
`CLIENT_NAMESPACES`; a kind code is never shown raw (label with `.has` fallback,
`hd18`). Screens tested at 1360px EN and 390px AR (RTL).

Gaps (stated, not invented): the popover's list rows have no avatar/icon per
category (no class exists); the bell count is the header's `coa-count-badge` shown
in place of the glyph (no positioned-badge class exists); a read notification uses
the default status chip (the existing "Draft" look) because no neutral "read" tone
exists; at 390px the register scrolls inside its wrapper like the model screen does.

## 11. Shared files touched (additive)

`messages/en.json`, `messages/ar.json` (a `notifications` namespace; one
`audit_action.notification.marked_all_read`), `src/i18n/client-messages.ts`
(`'notifications'`), `src/components/erp-shell.tsx`, `src/components/app-shell.tsx`,
`src/server/domain/screens.ts` (+1 delivered route), `src/server/db/migrations/meta/_journal.json`
(idx 226), `docs/CONTROLS.md` (C-70..C-73), `AGENTS.md` (one section),
`tests/unit/screen-catalogue.test.ts` (+1 route). Services edited to emit or to
stay inside the stricter RLS: `workflow.ts`, `department-routing.ts`, `journal.ts`
(approval announce), `shipments.ts`, `cloud-files.ts`, `closing-checks.ts`,
`inventory-integrity.ts`, `system-health.ts`, `notifications.ts`.

## 12. Checks run

All through `/home/claude/bin/heavy`, against `erp_test_notifications` /
`erp_notifications` only.

* `npx tsc --noEmit` — clean.
* Unit: `notification-center`, `notifications`, `hd18-no-raw-enum`, `hd19-client-messages`
  — 58 passed. `screen-catalogue` passes after the expectation line.
* Integration: `tests/integration/notification-center.test.ts` — 31 passed (once
  under repeats and races, read-state persistence, RLS isolation for user /
  outsider / super user, recipient permission filter, target refusal after access is
  revoked, approvals, savepoint isolation, sweep dedupe). Existing suites that touch
  notifications and the delivery runner — all passed (5 files/72, 7 files/96,
  8 files/80, 7 files/116 tests in four batches), `ops16-document-table-lists` 3/3.
* E2E: `tests/e2e/notifications.spec.ts` — 4 passed (bell count and list, category
  filter, click opens the real record, mark all read persists after reload, mark
  unread, outsider and super user isolation, Arabic 390px + desktop EN
  screenshots). `tests/e2e/theme-readability.spec.ts` — 14 passed.
* Screenshots: `/home/claude/shots/notifications/` — `notifications-desktop-en.png`
  beside `model-invoices-desktop-en.png`; `notifications-mobile-ar.png` beside
  `model-invoices-mobile-ar.png`; `bell-popover-desktop-en.png`,
  `bell-popover-mobile-ar.png`.
* Not run: the full unit suite, the full integration suite, `next build`.

**Known red:** `tests/unit/im15-controls-register.test.ts` › "numbered without gaps"
expects C-66 after C-65 and gets C-70 in this worktree, because the Task Center's
C-66..C-69 are on its branch. It turns green when both branches are merged.

## 13. Decisions taken by default

* Audit grain: raising is audited by the originating event; read / unread / open
  are not audited; *mark all read* writes one `notification.marked_all_read` row
  (object = the user, after `{count, category}`).
* A click on a notification that resolves to nothing leaves it unread; a
  resolved one is read on open.
* The submitter is never told about their own submission; a journal the submitter
  may post themselves announces nothing; a bank-account submission keeps its own
  rule (`partner_bank_account.submitted`), not the workflow's.
* Poll: 30 s visible, 120 s hidden, exponential back-off to 5 min; the list is
  fetched only while the popover is open; the popover's mark-all follows the chosen
  category.
* Super users read only their own notifications; the "stuck deliveries" count moved
  to a definer function so System Health still sees all.
* HR kinds keep their stored English text (`hr.*` has a category but no Arabic
  label yet).

## 14. Needs from the next agents / merge notes

* **Task Center:** emits through `insertNotification` with `eventType = task.*`,
  `objectType 'task'`, `context.href = /tasks/<no>`. The registry already classifies
  `task.*` as *tasks* with `object: 'task'` (every role holds `task:view`, 0342) and
  labels exist in both locales. For a click to open the task, `resolveTarget` needs
  `/tasks/<no>` served (`visibleRoute`) and its screen's permission object — i.e.
  `/tasks` in `DELIVERED` and the route table on their branch. If a task notice reads
  "No longer available" after merging, check that first. `task.*` kinds carry
  `branchCode`; a recipient outside the task's branch is skipped by `refusalFor`
  (by design); drop the branch from their call if that is not wanted.
* **Merge conflicts to expect** (`git merge-tree` against `platform/task-center`):
  `docs/CONTROLS.md` and `_journal.json` — both are plain additions at the end;
  keep both. Their `notifications.ts` block merges cleanly.
* **Bank Reconciliation / Exceptions / Automation:** emit with `emit(...)`; see §5.
* **Dormant rules:** the `journal_entry.submitted` / `chart_of_account.submitted`
  rules would tell an approver twice if they were ever raised in addition to the
  workflow's `approval.required`. Retire them when that path is enabled.
* `visibleRoute` caveat: a record page inherits its parent's delivery only for an
  `archetype 'document'` screen; a record whose parent is a different archetype
  needs its own `DELIVERED` entry to be openable from a notice.
