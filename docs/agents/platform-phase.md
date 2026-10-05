# Platform phase — ten implementation agents (2026-10-04)

The five core modules (Accounting, Logistics, Inventory, Payables, Receivables)
are on `main`. This phase builds the **platform / product layer** on top of them.
One orchestrating session runs ten builder agents in five waves. This file is
the orchestration layer's record: who builds what, where, and the rules they
share. `AGENTS.md` is still the house rulebook and overrides anything here.

## The phase is IMPLEMENTATION FIRST

Agents are **builders**, not QA. During the build:

* typecheck when appropriate (`npm run typecheck`, or `npx tsc --noEmit -p .` alone)
* targeted tests for changed code; focused integration tests on **your own database**
* a focused Playwright spec for the feature when practical, on **your own port**
* database checks directly related to the feature

**Do not** run the full unit suite after every change, and never the full
integration suite. Full regression happens after all ten features are merged.

## Every agent

1. inspects the existing architecture first (`AGENTS.md`, the services, the
   screens it touches, the migrations, the permission objects, the message files)
2. reuses existing Qimah components and services; never duplicates a service
3. reuses the permission system (`domain/permissions.ts`, `app_has_grant`, RLS)
4. reuses audit/history (`audit.record`, `RecordHistory`)
5. reuses the attachment infrastructure (`services/attachments.ts`,
   `attachments-runtime.ts`, the paperclip door) — no second file store
6. reuses `services/notifications.ts` / `notification-runner.ts` for notifications
7. keeps English + Arabic (both message files), RTL, mobile
8. uses real persisted data — **never mocked production data**; an empty state
   says "No data available" / "This integration is not configured"
9. shows no fake success: "Saved" / "Sent" / "Uploaded" only after the backend confirmed
10. commits meaningful WIP often, with the attribution trailer (below)
11. pushes its branch to `origin` regularly (`git push -u origin <branch>`)
12. leaves a concise handoff in `docs/audits/<FEATURE>-IMPLEMENTATION.md`
13. copies existing screens' design exactly (AGENTS.md › *Screens copy existing
    models*): only existing classes from `admin.module.css` / `ui/*.module.css`;
    every record page wears the four doors in `DocumentWindow.titleActions`

## Workspaces

Each agent works **only** inside its own worktree, on its own branch, with its
own databases and port. Never `cd` into another worktree or into
`/home/claude/qs_erp` (the orchestrator's). Never push to `main` or to
`feat/platform-layer`. Never force-push.

| Wave | Agent | Worktree | Branch | Dev DB / Test DB | Port | Migrations | `_journal.json` `when` |
|---|---|---|---|---|---|---|---|
| 1 | 1 Chat | `/home/claude/wt/chat` | `platform/chat` | `erp_chat` / `erp_test_chat` | 3001 | 0310–0319 | 1795900000120–129 |
| 1 | 4 Document Center | `/home/claude/wt/documents` | `platform/document-center` | `erp_documents` / `erp_test_documents` | 3004 | 0320–0329 | 1795900000130–139 |
| 1 | 5 Global Search | `/home/claude/wt/search` | `platform/global-search` | `erp_search` / `erp_test_search` | 3005 | 0330–0339 | 1795900000140–149 |
| 2 | 3 Task Center | `/home/claude/wt/tasks` | `platform/task-center` | `erp_tasks` / `erp_test_tasks` | 3003 | 0340–0349 | 1795900000150–159 |
| 2 | 6 Notifications | `/home/claude/wt/notifications` | `platform/notification-center` | `erp_notifications` / `erp_test_notifications` | 3006 | 0350–0359 | 1795900000160–169 |
| 2 | 8 Saved Views | `/home/claude/wt/views` | `platform/saved-views` | `erp_views` / `erp_test_views` | 3008 | 0360–0369 | 1795900000170–179 |
| 3 | 2 Dashboard | `/home/claude/wt/dashboard` | `platform/dashboard` | `erp_dashboard` / `erp_test_dashboard` | 3002 | 0370–0379 | 1795900000180–189 |
| 3 | 7 Exception Center | `/home/claude/wt/exceptions` | `platform/exception-center` | `erp_exceptions` / `erp_test_exceptions` | 3007 | 0380–0389 | 1795900000190–199 |
| 4 | 9 Relationships + Control Center | `/home/claude/wt/control` | `platform/control-center` | `erp_control` / `erp_test_control` | 3009 | 0390–0399 | 1795900000200–209 |
| 5 | 10 Workflow Automation | `/home/claude/wt/automation` | `platform/workflow-automation` | `erp_automation` / `erp_test_automation` | 3010 | 0400–0409 | 1795900000210–219 |

The worktree's `.env` already points at the agent's databases, attachment
directory and port (`PORT`, `E2E_BASE_URL`). `node_modules` is a symlink to the
orchestrator's install — do not `npm install` anything new without saying so in
the handoff (a new dependency is a decision for the sponsor).

Commands, from the worktree root:

```bash
set -a; . ./.env; set +a                 # every shell
npx tsx src/server/db/migrate.ts         # dev db (already migrated and seeded)
npx tsx src/server/db/migrate.ts --test  # test db (the integration setup also migrates)
npx tsx scripts/seed-dev.ts              # reseed dev db
npx vitest run --project integration tests/integration/<yours>.test.ts
npx vitest run --project unit tests/unit/<yours>.test.ts
PORT=$PORT npm run dev                   # dev server on your port (background it)
npx playwright test tests/e2e/<yours>.spec.ts --workers=1   # uses E2E_BASE_URL
```

Seeded users (password `Ledger-Trial-Balance-7`): `officer@example.com`,
`manager@example.com`, `ceo@example.com`, `outsider@example.com`,
`admin@example.com` (super user).

## Migrations

* Use **your block** of file numbers and `when` values, in order, starting at the
  block's first value. The journal's `idx` continues from the last entry; the
  orchestrator renumbers `idx` at merge (the `when` values stay).
* A migration that adds an enum value ends a step (`migrateInSteps`); keep it in
  its own file.
* A new table that names a document goes into **both** `tests/integration/setup.ts`
  (`resetTestData`) and `scripts/ops/format-live-database.sh` (`DOCUMENT_TABLES`),
  or into `ops16`'s `NOT_DOCUMENTS` when it is not a document. Run
  `npx vitest run --project integration tests/integration/ops16-document-table-lists.test.ts`.
* A new table gets RLS like its neighbours (`app_has_grant`, branch scope) and the
  `erp_app` grants the migration's neighbours give. Ledger-like tables are append-only.
* Never rewrite a migration that is on `main`.

## Shared files — additive edits only

These will be touched by several agents at once. Make the **smallest additive
change**, never reformat, never reorder, never delete another module's lines:

* `src/server/domain/menu.ts` (+ `tests/unit/fx1-menu.test.ts`, `screen-catalogue.test.ts`)
* `messages/en.json`, `messages/ar.json` — add keys **inside your own namespace**
  (`chat.*`, `tasks.*`, …; `page.<key>` and `nav.<key>` for your routes); keep the
  2-space layout; append at the end of the object you add to
* `src/i18n/client-messages.ts` (`CLIENT_NAMESPACES`) — add your namespace
* `src/components/admin/erp-shell.tsx` and the layout — a new header control is
  a new small component you import, not a rewrite of the shell
* `src/server/domain/permissions.ts` and the seed/grants migrations — new objects
  and grants in your own migration
* `src/server/attachments-runtime.ts`, `services/record-notes.ts` (`TARGETS`),
  `src/server/print/registry.ts`, `EXPORT_ACCESS` — one added line per record
* `src/server/services/notifications.ts` — add kinds; do not restructure
* `tests/integration/setup.ts`, `scripts/ops/format-live-database.sh`
* `docs/CONTROLS.md` (+ `im15-controls-register`) when you add an enforced control
* `docs/notes/doors-coverage.md` — add your record pages' rows
* `AGENTS.md` — append **one section** for your feature at the end

When two agents need the same shared foundation, the one listed as its owner
builds it; the other reads what exists and says in its handoff what it needs.
The orchestrator merges each wave into `feat/platform-layer` and resolves
conflicts keeping **both** behaviours.

## Ownership of shared foundations

| Foundation | Owner | Others |
|---|---|---|
| Conversations, messages, presence, typing | Chat (1) | Tasks (3) opens a conversation through Chat's service/route |
| Cloud files connection, Document Center UI, document ↔ record links | Document Center (4) | nobody else touches the cloud |
| Global search index/queries, the command palette | Global Search (5) | later agents register their record types in its registry |
| `services/notifications.ts` kinds, the bell, read state, dedupe | Notifications (6) | Chat/Tasks/Docs *emit* through the existing `notifications.ts`; they do not build a bell |
| Tasks, assignment scope, lifecycle | Task Center (3) | Dashboard, Exceptions, Automation read it |
| `services/saved-views.ts`, pin to home | Saved Views (8) | Dashboard renders pinned views |
| `/` and `/approvals` | Dashboard (2) | others expose read services it draws |
| Exceptions model and screen | Exception Center (7) | Control Center (9), Automation (10) read it |
| Relationship graph + Control Center | 9 | — |
| Automation rules/events/actions | 10 | — |

Existing code to inspect before building anything in these areas:
`services/dashboard.ts`, `services/notifications.ts`, `services/notification-runner.ts`,
`services/saved-views.ts`, `services/workflow.ts`, `services/document-actions.ts`,
`services/payable-events.ts`, `app/(app)/documents`, `app/(app)/approvals`,
`app/(app)/monitoring`, `app/(app)/page.tsx`, `domain/menu.ts`, `domain/permissions.ts`.

## Handoff: `docs/audits/<FEATURE>-IMPLEMENTATION.md`

Concise. Sections: architecture · what was implemented · data source ·
permissions · database changes (migration files and numbers) · routes ·
shared files touched · targeted checks run (commands and counts) · commits
(hashes) · remaining limitations · what the next agents need from you.

## Commits

Every commit message ends with:

```
Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HSUx6pXrmtZ3XeeUXraDJ8
```

## Not in this phase

AI ERP assistant · a general workflow builder · a generic CRM · a project-management
replacement · social-network chat · a separate document repository · any second
accounting, inventory or notification engine.
