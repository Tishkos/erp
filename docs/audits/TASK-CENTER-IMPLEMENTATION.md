# Task Center and task assignment — implementation record (Platform phase, Agent 3, 2026-10-04)

Branch `platform/task-center` (from `feat/platform-layer` at 94f02ef). A task is a
piece of work one person asks another to do — in a section, with a priority and
a deadline, optionally about an ERP record — that walks one road and is never
deleted. The point of the module is **who may be given work by whom**: that
rule lives in one SQL function and is held by the service and the database
alike. It is not a project scheduler, a ticket desk or a to-do list without an
owner; it has no sub-tasks, no recurrence and no time tracking.

This is an implementation record, not a statement that the module is ready for
production. Nothing here has been run against the live database, a second
person's browser on the host, or the WhatsApp/Cloud Files services.

## 1. Architecture

* **Writer / pure rules / reader.** `services/tasks.ts` writes (create, amend,
  `act` — one entry for all eleven steps —, watchers, Reply in Chat) and reads
  (lists, counts, workload, record, dashboard feeds). `domain/tasks.ts` is the
  same rules without a database (the road, who takes each step, due-date
  states, progress, notice recipients and wording) and is what
  `tests/unit/task-center.test.ts` holds. `services/task-sweep.ts` is the
  morning job. `print/task-documents.ts` is the print model.
* **The road** (`TRANSITIONS`): `draft → assigned → accepted → in_progress ⇄
  blocked`, `in_progress → submitted → completed`; `submitted → in_progress`
  (returned, with a reason); `assigned → rejected → assigned` (reassigned);
  reassign from any working state; `cancel` from any live state with a reason;
  `completed` and `cancelled` are final. The migration's trigger holds the same
  21 pairs; the unit test reads the migration and fails if they differ.
* **Who takes a step is part of the road.** The assignee accepts, declines,
  starts, blocks, resumes and hands in; the person who assigned reviews
  (complete / return), reassigns and cancels; the raiser assigns a draft and
  cancels it; a holder of `administer` stands in for the assigner and never
  for the assignee. The service checks first, for a sentence; the trigger
  (`task_lifecycle_guard`) checks again for anybody else, and **stamps the
  moments** (`assigned_at`, `accepted_at`, … are the database's, whatever a
  statement says).
* **Assignment scope** (`app_task_scope(actor, assignee, section, branch)`, 0341)
  returns *why* the assignee is in the assigner's scope, or null:
  `self` · `organisation` (assigner holds `administer`) · `department`
  (assigner manages the section — `user_department_scope.is_manager` — and the
  assignee is a member) · `report` (the assignee reports to the assigner through
  the employee records' manager links, twelve levels, loop-safe). Always:
  assigner holds `submit`, works in the branch, belongs to the section (or
  holds `administer`); assignee is active, holds `view` and `execute` on tasks
  and works in the branch. The same function feeds `app_task_eligible` (the
  dropdown), `scopeOf` (the service) and `task_assignment_guard` (the trigger).
* **Visibility** (`app_task_visible_to`, policy `task_scope`, FORCE RLS): a draft
  is its raiser's alone; otherwise raiser, assigner, assignee and watchers
  wherever they work, and — in a branch they work in, holding `view` — a holder
  of `administer`, the section's manager, and whoever the assignee reports to.
  A system session (`app.is_super_user`) opens every non-draft task (0344).
* **Notices** go through `notifications.insertNotification` only: fourteen
  `task.*` kinds in one exported block of `services/notifications.ts`
  (`TASK_EVENT_TYPES`, `TASK_NOTICE_TARGET`), recipients are computed from the
  step, then filtered with `app_task_visible_to` using the values just written,
  the actor is removed, a dedupe key makes a repeat a no-op.
* **Reply in Chat** (`openChat`): `chat.openRecordConversation` in the same
  transaction (record type `task`, id = the task's uuid, label = number, href
  `/tasks/<no>`), then the action redirects to `/chat?c=<id>&draft=<text>`,
  the draft from the catalogue string `admin.tasks.chat_draft` in the user's
  language. Nothing is sent.

## 2. What was implemented

* Screens. `/tasks` — copies Purchase Invoices: SectionTabs, ListToolbar, a
  filter form (View: My tasks · Assigned by me · Team *only for people who lead
  anybody*; Show: all · open · due today · due soon · overdue · blocked ·
  waiting for review · completed, each with its count), the standard register
  (Team: the load by person stacked underneath), paging, and the New task
  dialog (title, section, eligible assignee, priority, deadline, description,
  record it is about, tags, up to five files). `/tasks/[taskNo]` — copies the
  HR request page: header fields, status chip, the Progress register as its
  lines (raised → assigned → accepted → started → blocked → handed in →
  completed/cancelled, who and when), the verbs at its foot (only the ones the
  reader may take; assign/reassign take the eligible list; decline, block,
  return and cancel need a reason), Reply in Chat, the **four doors** in order
  (Print/Export · Attachments · Notes · Audit log), and a Watchers register.
* A task is registered with the Document Center (`registerCloudLinkTarget`),
  record notes (`TARGETS`), attachments (`taskParentAccess`), Global Search
  (priority 42; `TASK-001`, `1`, the title, the assignee's name), the profile
  kinds (`task` → `/tasks`), the print registry (`task`, `EXPORT_ACCESS`), the
  screen catalogue (`/tasks` delivered) and the controls register (C-66–C-69).
* Dashboard and Exceptions are **fed, not edited**: `dashboardSummary(tx,
  reader)`, `overdueTasks`, `blockedTasks`.
* English and Arabic: `admin.tasks.*`, `audit_action.task.*`,
  `print.titles.task`, `search.types.task`, `search.status.{assigned,
  in_progress, completed}`.

## 3. Data source

Everything is read from and written to the `task` table under the reader's
own row-level scope. Nothing is mocked. People are `app_user`; sections are
`department`; membership is `user_department_scope` or an active `employee`
row; the reporting chain is `employee.manager_employee_id`. The related record
is whatever the Document Center registers (`cloud-link-targets.findRecord`,
which asks `attachments.mayAccessParent`). Numbers come from the document
series `TASK` (`TASK-001`, padding 3, one series for all branches).

## 4. Permissions

Object `task`, granted in 0342 (bumps `permissions_version`). The closed
13-verb vocabulary has no "assign", so: `view` opens a task · `create` and
`edit_draft` raise and edit a draft · **`submit` is the right to assign** (and to
review, reassign, cancel what one assigned) · `execute` works an assigned task
· **`administer` is organisation-wide assignment** · `print`/`export` for the
copy. Seeded: every role that existed gets `view`, `execute`, `print`, `export`;
`ceo`, `accounting_manager`, `hr_manager`, `project_manager` get `create`,
`edit_draft`, `submit`; `ceo` gets `administer`. A role created later has none
of these until someone grants them — the Team view and the New task button
follow the grant and the scope, not the role name.

## 5. Database changes

| Migration | `when` | Holds |
|---|---|---|
| 0340_task_core | …150 | `task` table and its checks; indexes; `task_no_delete`; `task_lifecycle_guard()` (road, who, reasons, DB-stamped moments); `erp_app` grants (no DELETE); `TASK` series; `document_type` |
| 0341_task_scope | …151 | the scope functions; `task_assignment_guard`; both triggers; RLS (FORCE) and policy `task_scope` |
| 0342_task_grants | …152 | `role_grant` rows for `task` |
| 0343_task_team | …153 | `app_task_leads()` for the Team view |
| 0344_task_system_session | …154 | `ALTER POLICY`: the system session opens non-draft tasks (the sweep) |

Journal idx 226–230. `task` is in `resetTestData` and `DOCUMENT_TABLES`
(`format-live-database.sh`); the `TASK` series is kept by `resetTestData`.

## 6. Routes

`/tasks` (list; `?view=mine|assigned|team&bucket=…&q=…&page=…`), `/tasks/[taskNo]`
(record). Server actions in `src/app/(app)/tasks/actions.ts`: `createTask`,
`updateTask`, `stepTask`, `addWatcher`, `removeWatcher`, `replyInChat`.
The client component `components/admin/task-assignment-fields.tsx` redraws the
assignee list when the section changes; it carries no class of its own.

## 7. Shared files touched (all additive)

`AGENTS.md` (one section) · `docs/CONTROLS.md` (C-66–C-69) ·
`docs/notes/doors-coverage.md` (a section) · `messages/en.json`, `messages/ar.json`
(new keys at the end of their objects) · `scripts/ops/crontab.erp` (one line) ·
`scripts/ops/format-live-database.sh` (`task`) · `src/server/attachments-runtime.ts` ·
`src/server/db/migrations/meta/_journal.json` · `src/server/db/schema/index.ts` ·
`src/server/domain/{profiles,screens,search}.ts` · `src/server/print/{access,registry}.ts` ·
`src/server/records/index.ts` · `src/server/search/entities/index.ts` ·
`src/server/services/{notifications,record-notes}.ts` · `tests/integration/setup.ts` ·
`tests/unit/{im04-live-guard,im05-jobs-locked,screen-catalogue}.test.ts`.
`next-env.d.ts` is gitignored and was absent in this worktree; it was created
locally for `tsc` and is not committed.

## 8. Targeted checks run

Own databases `erp_tasks`, `erp_test_tasks` (`DATABASE_URL_TEST` set to the
latter); no full suite.

* `tsc --noEmit -p .` — clean.
* `tests/unit/task-center.test.ts` (39) — the road equals the migration's pair
  list; who may take each step; due-date states; tags/title/date rules;
  recipients and wording of every notice; messages present in both languages;
  index and journal shape; priorities unique; four doors in order.
* `tests/integration/task-center.test.ts` (40) — scope (self, direct and
  indirect report, section manager, administrator; a manager is not everyone's
  manager; the list equals the function for every user), refusal by the
  service **and** by the trigger, lifecycle, reasons, DB-stamped moments, a
  double press moving the task once, no delete, visibility for eleven people,
  notices (once; never to the actor; not to someone who lost sight of it), the
  sweep as a system administrator who is not a flagged super user, dashboard
  and feeds, Global Search, notes, files, related record, Reply in Chat,
  print model.
* Affected suites, once each: `im15-controls-register`, `screen-catalogue`,
  `fx1-menu`, `fx5-hr-menu`, `im04-live-guard`, `im05-jobs-locked`,
  `profiles`, `i18n-catalogue`, `hd18`, `hd19`, `gs-search-*` (unit);
  `ops16-document-table-lists`, `gs-global-search` (integration).
* `tests/e2e/task-center.spec.ts` (7) against `next dev` on port 3003 over
  `erp_tasks`: scope in the dropdown, the road one valid verb at a time,
  block needing a reason, Reply in Chat draft, related record and file,
  Team view only for those who lead, a person with no grant turned away, the
  list and record at 390 px in Arabic with no sideways scroll. Screenshots in
  `/home/claude/shots/tasks/` (`tasks-assigned-desktop-en`, `task-record-*`,
  `tasks-list-mobile-ar`, `task-record-mobile-ar`, `model-invoices-*`).
  `theme-readability.spec.ts` was **not** run (it checks all 90 palette/accent
  combinations and was outside the targeted scope).

## 9. Commits

`f3146ae` task table, lifecycle and scope triggers (0340–0342) · `a77073a`
service, sweep, registrations, print model, search entity, list screen and
actions · `4cfd579` record page, messages · `f46404d` unit tests · `83c4b21`
0344, uuid[] fix, integration tests · `179225e` controls, doors row, search
priority · `ba75530` Playwright spec, serialised queries · and the closing
commit with this record and the `AGENTS.md` section.

## 10. Remaining limitations

* **Notice wording is English** (the row's `context` carries the facts for a
  screen that wants to say it in the reader's language; the bell is Agent 6's).
* On **reassignment the previous assignee loses sight of the task** (they are
  no longer a party), so they are not notified of it; the audit history still
  records the move. A deliberate reading of "recipients limited to people who
  may see the task"; say if the previous assignee should keep read access.
* **Sub-sections are not followed**: managing a section does not extend to
  `department.parent_code` children. The Team view and visibility use the
  section's manager flag and the employee manager links only.
* The **audit history is keyed by the task number**, the Document Center's
  record link by the task's uuid — the same mismatch `employee` has. Notes use
  the number, files the uuid.
* **Progress is the stage of the road** (0–100), not a measure of the work.
* **Membership counts from either source** — a `user_department_scope` row or an
  active `employee` row in the section — both to receive work there and to
  raise it. **Managing** a section is only the `is_manager` flag on
  `user_department_scope`; an employee's department alone does not make
  anybody its manager (a person who manages people by the employee records'
  manager links is a manager of *those people*, via `report`).
* Drafts are invisible even to administrators and super users (a draft is the
  raiser's own); only the raiser can assign or cancel one.
* The seeded dev data puts every user in Finance, so the dropdown there shows
  everybody who can do the work; out-of-scope cases (other section, other
  branch, no manager link) are proved by the integration test, not by the seed.
* Not run: the WhatsApp/Cloud Files integrations, `theme-readability`, the
  full unit and integration suites, a production build, or any live database.

## 11. What the next agents need

* **Dashboard / Exceptions (Agent 6 or the dashboard owner):** call
  `tasks.dashboardSummary(tx, reader)` — `available: false` and zeros without
  `view`; `team` is null unless the reader leads somebody; each `TaskBrief` has
  `href`. `tasks.overdueTasks` / `blockedTasks` are the Exceptions feeds. Do not
  re-read the table; the row policy already scopes it.
* **Notification Center (Agent 6):** the kinds are `TASK_EVENT_TYPES`
  (`task.assigned … task.overdue`); `object_type = 'task'`, `object_id` = the task
  number, `context.href` is the page; `TASK_NOTICE_TARGET` names the category and
  route. Use `app_task_visible_to` if you ever recompute recipients.
* **Anyone adding a task step:** add it to `TRANSITIONS`, to the migration's
  pair list (a new migration — never edit 0340), to `NOTICE_FOR_ACTION`, to both
  locales (`action_*`, `audit_action.task.*`) and to `task-center.test.ts`.
* **Anyone changing who may assign:** change `app_task_scope` in a new
  migration and nothing else; the list, the service and the trigger follow.
* **Anyone running the sweep by hand:** `npx tsx scripts/ops/task-sweep.ts
  [YYYY-MM-DD]`; it needs an active system administrator or super user.
* Two test runs must not share a database (`AGENTS.md`); this module's tests
  used `erp_test_tasks`.
