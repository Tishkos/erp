# Platform phase — consolidated summary (4–5 October 2026)

Branch `feat/platform-layer` (head `af50731`, pushed). It contains PR #52 (`feat/erp-integration`) plus the Inventory finish and the ten platform agents. Nothing here is on `main`; the merge to `main` is the owner's.

**This is not a statement of production readiness.** Each agent ran only typecheck, its own targeted tests and its own Playwright file. After each wave I merged and re-ran targeted unit and integration files and migrated an empty database through the whole journal. The full unit and integration suites, the 90-combination theme run, the end-to-end suites on a merged production build and a run against a real Nextcloud have not been run (the brief defers them to the regression phase).

Merged-tree checks (mine):

- `tsc` exit 0.
- Fresh database migrated through all 240 journal entries.
- Wave 5 targeted batch: 581 unit tests and 475 integration tests (19 files) passed.
- After the last fix: `task-center` + `notification-center` integration, 72 passed.

---

## AGENTS COMPLETED

### 1. Chat (`platform/chat`, merge `17eaacb`)

- **Implemented:** `/chat` with one-to-one and group conversations, quoted replies, six reactions, @mentions, files, and conversations hung on a record. Message states Sending → Sent → Delivered → Seen. Presence, typing line, search, header Messages badge. EN/AR, 390 px.
- **Architecture:**
  - Writer `services/chat.ts`, reader `services/chat-read.ts`, pure rules `domain/chat.ts`.
  - Access is the database's: FORCE RLS plus SECURITY DEFINER helpers; members read from the sequence number at which they joined.
  - Receipts come from a trigger.
  - Sync is adaptive polling (2/6/15/30 s) at `POST /chat/api/sync`; there is no push.
  - `clientId` makes sending idempotent; messages are retracted, never deleted.
  - Notices: `chat.message` (once per unseen run) and `chat.mention`.
- **Database:** `0310_chat_core` (six tables: conversation, participant, message, receipt, reaction, presence; trigram index; helpers; triggers; RLS) and `0311_chat_access` (grants, attachment policy). In `resetTestData` and `DOCUMENT_TABLES`. Controls C-60..62.
- **Permissions:** object `chat` (`view`, `create`) to every role. Reading is by membership under RLS. A record conversation needs `mayAccessParent`. Audited: opened, record opened, members added/removed/left, renamed, retracted.
- **Routes:** `/chat` (`?c=`, `?draft=`, `?record=type:id`), `POST /chat/api/sync`, `GET /chat/files/[id]`.
- **Targeted tests (agent-reported):** `chat-rules`, `screen-catalogue`, integration `chat` (own database), `ops16`, e2e `chat.spec`. Counts were not given in the hand-off.
- **Commits:** `4b4c001`…`004cdc4`, final `61a0fe7`.
- **Remaining limitation:** polling, not push (about 2 s on an open thread, 15 s closed). No message editing, threads, channels or calls. No e-mail or push for chat. Search is a substring match. `theme-readability` was not run.

### 2. Dashboard (`platform/dashboard`, merge `e73bea0`)

- **Implemented:**
  - `/` is a role-based Home with 45 widgets (18 figures, 9 charts, 18 lists), 15 quick actions and the import-journey chart.
  - `/approvals` is My Approvals, with inline Approve/Reject for chart accounts, journals and bank accounts.
  - Empty and "Not available for your role" states. EN/AR, 390 px.
- **Architecture:**
  - A registry: `domain/dashboard-widgets.ts` plus `services/home-loaders.ts`.
  - Each loader runs as the viewer in its own savepoint with a 15 s timeout and answers ready / empty / unreadable / unwired.
  - Money stays a decimal string.
  - `services/approval-center.ts` gathers the workflow inbox, submitted documents and HR feeds; `decide()` is the only writer.
  - The attention slot is filled by the Exception Center feed (wired by me, `32c04fe`).
- **Database:** none.
- **Permissions:** no new object. Widgets need their grants plus a capability (management = `ceo`, approver, assigner). `/approvals` opens for `view workflow_instance` or the approver capability. The owning service applies its own rules on every decision.
- **Routes:** `/`, `/approvals`; actions `approveItem`, `rejectItem`.
- **Targeted tests (agent-reported):** unit 67 + guards 109; integration `dash-home` 35; e2e `dash-home` 8; `theme-readability` 14-test variant.
- **Commits:** `64ca020`…`be83dbc`, final `1ce4776`.
- **Remaining limitation:** the HR manager has no My Approvals menu entry (the menu gates on `workflow_instance`). Only three document types are decided inline. No per-user layout. `dashboard-workspace.tsx` is dead code.

### 3. Task Center (`platform/task-center`, merge `a475afb`)

- **Implemented:**
  - Tasks assigned person to person under a scope rule.
  - `/tasks` (My / Assigned / Team, buckets) and `/tasks/[taskNo]` (progress register, verbs, Reply in Chat, four doors, watchers).
  - Related record, tags, up to 5 files, overdue sweep, print model.
  - Registered with Document Center, Global Search, notes, attachments and profiles.
- **Architecture:**
  - `services/tasks.ts`, `domain/tasks.ts`, `services/task-sweep.ts`.
  - The 21-pair state machine is held equal in a database trigger.
  - Who may assign is one SQL function, `app_task_scope`, feeding the dropdown, the service and the trigger.
  - Visibility is RLS via `app_task_visible_to`.
  - 14 `task.*` notice kinds through the Notification Center.
- **Database:** `0340_task_core`, `0341_task_scope`, `0342_task_grants`, `0343_task_team`, `0344_task_system_session`. Table `task`, series `TASK`. In `resetTestData` and `DOCUMENT_TABLES`. Controls C-66..69.
- **Permissions:** object `task`. `view` opens; `create` / `edit_draft` raise a draft; `submit` is the right to assign and review; `execute` works a task; `administer` is organisation-wide; `print` / `export`. All roles get view/execute/print/export; `ceo`, `accounting_manager`, `hr_manager` and `project_manager` can create and assign; `ceo` administers.
- **Routes:** `/tasks` (`?view=&bucket=&q=&page=`), `/tasks/[taskNo]`.
- **Targeted tests (agent-reported):** unit 39, integration 40, e2e 7. Mine: integration now includes a notice-target test (TK5).
- **Commits:** `f3146ae`…`179225e`, final `00a07a8`; mine `af50731`.
- **Remaining limitation:** notice wording is English only. The previous assignee loses sight of a reassigned task and is not told. Drafts are invisible even to administrators. Progress is the stage of the road, not a percentage.

### 4. Document Center (`platform/document-center`, merge `0f76917`)

- **Implemented:**
  - QS Cloud Files (Nextcloud) at `/documents`: per-user Login Flow v2 link, browse, search, sort, download, preview, upload, new folder, all as the person.
  - Link a file to a record and back, and a "QS Cloud Files" panel under the paperclip.
  - A folder per record, shared to groups mapped from roles.
  - Settings screen.
  - Upload shows success only after the cloud confirms.
- **Architecture:**
  - The cloud is the storage authority; PostgreSQL holds only links and connection state.
  - Layers: `domain/cloud-files.ts`, `secret-box.ts` (AES-256-GCM from `ERP_SECRET_KEY`), `cloud-client.ts` (the only code that talks to the cloud), `cloud-*` services.
  - Link-target registry with 21 kinds; the paperclip is extended, not replaced.
  - Every cloud call uses the person's own app password.
- **Database:** `0320_cloud_files_core` (settings, group mapping, account, link attempts), `0321_cloud_file_links` (`cloud_file_link` + guard trigger), `0322_cloud_files_grants`. `cloud_file_link` is in both reset lists. Controls C-63..65. New environment key `ERP_SECRET_KEY` (32+ characters).
- **Permissions:** object `cloud_files` (`view`, `create`, copied from `attachment`'s grants); `cloud_setting` (`view`, `configure`) to the roles that configured attachments plus `ceo` and `system_administrator`. Record access is checked, and the cloud's own rights apply.
- **Routes:** `/documents`, `GET /documents/file`, `POST /documents/upload` (200 MiB), `POST /documents/link/poll`, `/administration/cloud-files`.
- **Targeted tests (agent-reported, against a Nextcloud stub):** unit 32, integration 31, e2e 6, plus a unit batch of 124 and an integration batch (hd05, hd06, hd07, ops16, platform-attachments, pay03) green.
- **Commits:** `09905aa`…`6c800b6`, final `65ef664`.
- **Remaining limitation:**
  - Never run against the real server: the sandbox has no route to `files.qs-groups.com`. The first run on the host is the live test; the hand-off lists five things to check.
  - nginx needs a `/documents/upload` location (its default limit is 26m).
  - Role-mapping changes do not re-share old folders.
  - Paging is in memory.
  - Link names are not refreshed after a rename in the cloud.

### 5. Global Search (`platform/global-search`, merge `eb63fcf`)

- **Implemented:** the Ctrl/Cmd+K palette and the `/search` page. Results are grouped by record type plus screens, run as the asker in a read-only transaction. Five ranking tiers, Arabic folding, serial-number matching. It writes nothing. 24 types after the merges.
- **Architecture:**
  - A declarative registry: `search/registry.ts`, `entities/*`, `services/global-search.ts`, `domain/search.ts`.
  - RLS blocks non-leakproof LIKE and trigram operators on policed tables, so numbers use btree comparisons across the whole table and names match only inside the newest 10,000 rows (`CONTAINS_WINDOW`).
  - Unpoliced tables use trigram indexes over `search_fold`.
  - A new type is one declaration plus one `BUILT_IN` entry.
- **Database:** `0330_global_search`: `pg_trgm`, `search_fold()`, 9 trigram indexes, 12 reference btrees, 17 date btrees, 2 attachment btrees, `doc_number_allocation()`. No rows or policies changed.
- **Permissions:** no new object. A type is queried only if the asker holds its view grant and its list route is served; the table's RLS and branch rule then apply. Warehouses carry the branch rule in the query. Files need `attachment` view plus the parent check. Employee results never carry pay.
- **Routes:** `GET /search/results?q=` (JSON), `/search?q=&type=&page=`.
- **Targeted tests (agent-reported):** unit 58, integration 39, e2e 5. Measured at 90–330 ms (super user) and 110–420 ms (branch user) on the volume fixture.
- **Commits:** `5324222`…`5b529af`, final `75fef62`.
- **Remaining limitation:** name matching on large policed tables sees only the newest 10,000 rows. Deep paging over files can end early; offset is capped at 1,000. No sales orders or delivery notes (their routes are not delivered).

### 6. Notification Center (`platform/notification-center`, merge `f5cd124`)

- **Implemented:** header bell with unread count and popover (Unread/All, category, mark read/unread/all); `/notifications`; `/notifications/open/<id>`, which resolves the target for this reader now and shows "no longer available" instead of a dead link; a kind registry and `emit()`. It extends the existing notifications service and delivery runner.
- **Architecture:**
  - Pure `domain/notification-center.ts` (`KINDS`, `registerKind`, windows).
  - `services/notifications.ts` is the writer; `services/notification-center.ts` resolves targets, the feed and open.
  - Dedupe key `kind|objectType|objectId|window|recipient` under a unique index.
  - The recipient's grant is checked at creation.
  - Targets are resolved at list time and again at click time.
  - Poll: 30 s visible, 120 s hidden.
- **Database:** `0350_notification_center`: indexes, recipient-only read/update policies, `notification_forward_only()`, `app_deliveries_stuck()`, `notification:view` to every role. No new table. Controls C-70..73.
- **Permissions:** `notification:view` to every role. Reads are recipient-only (super users read only their own). The feed route is POST and same-origin only.
- **Routes:** `/notifications`, `GET /notifications/open/[id]`, `POST /notifications/api/feed`.
- **Targeted tests (agent-reported):** unit 58, integration 31 plus existing notification suites, e2e 4, `theme-readability` 14-test variant.
- **Commits:** final `3225457`; the hand-off does not list the rest.
- **Remaining limitation:** the overdue-invoice notice repeats daily (a weekly window is recommended). HR kinds have no Arabic labels. A record page resolves only when its parent is a document-archetype screen. Task notices did not open the task until `af50731` (fixed after the merge).

### 7. Exception Center (`platform/exception-center`, merge `1fd163d`)

- **Implemented:**
  - Sweep-detected, deduplicated findings with severity, domain, evidence (up to 25 rows) and a road to the fix.
  - Lifecycle: open → acknowledged (with note) → resolved by the sweep only. Reopening raises the occurrence count.
  - 24 detectors in 8 domains plus `platform.sweep_truncated`.
  - Cron every 30 minutes and "Refresh now".
  - `/exceptions` and a record page with four doors.
  - Notices for new critical/high, reopened and raised findings.
- **Architecture:**
  - Pure `domain/exceptions.ts`.
  - Detector runners in `services/exception-detectors/*` read through existing services and write nothing.
  - `services/exceptions.ts` is the only writer; the sweep runs in two transactions (detect read-only, then persist under an advisory lock).
  - A finding resolves only if its own detector ran without error.
  - Wording is rendered from stored facts in the viewer's language.
  - Exposes `openFor`, `countsFor`, `byRecord`.
- **Database:** `0380_exception_core` (`exception`, `exception_history` append-only, `exception_sweep_run`, guards, RLS `exception_scope`, series `EXCEPTION`) and `0381_exception_grants`. Controls C-78..81 (renumbered at merge from C-82..85).
- **Permissions:** object `exception`: `view` / `execute` / `print` / `export` to every role; `administer` to `ceo`, `accounting_manager`, `system_administrator`. A finding is visible only with `view` on `exception` and on its own object, within the user's branches, plus the parent-access check. Acknowledging needs `execute`.
- **Routes:** `/exceptions` (`?domain=&severity=&status=&owner=&q=`), `/exceptions/[exceptionNo]`, cron `scripts/ops/exception-sweep.ts`, export key `exception`.
- **Targeted tests (agent-reported):** unit 49, integration 48, e2e 5. Mine: `ex01-gl-difference` unit (3 tests) added; `ex01` integration made date-independent.
- **Commits:** `30c7668`…`24e4a4d`, final `21d9466`; mine `b6cdf89`, `32c04fe`, `7b9433a`.
- **Remaining limitation:** thresholds are constants, not settings. Acknowledge only; no bulk action, assignment or snooze. `platform.system_health` depends on the host and is English only. The first live sweep sends a burst of notices. A manual journal on a control account with no party keeps `payables.ledger_inconsistency` open until acknowledged.

### 8. Saved Views (`platform/saved-views`, merge `e91b63c`)

- **Implemented:** save, rename, duplicate, delete, default and pin views on 16 registered screens through a Views menu; `/profile/views`; relative-date rules (stored as rule names, evaluated with `businessToday()`); the default applies only on a bare arrival (`?sv=none` bypasses); an unavailable view says why; a `pinnedFor` feed for Home. New filters on Purchase Invoices, Containers, Customers and Suppliers.
- **Architecture:** a view stores the screen's question (query string), never its answer. Registry `domain/saved-view-routes.ts`, rules `domain/saved-views.ts`, service `services/saved-views.ts`. Opening a view only navigates, so the screen's own query, RLS and branch rules answer. Counts reuse the screens' shared register functions.
- **Database:** `0360_saved_route_views`: `saved_view.kind`, `saved_view.pinned_at`, six check constraints, `saved_view_pinned_idx`, the `saved_view_route_guard` trigger (100 per person, 12 pinned), read policy recreated. Controls C-74..77.
- **Permissions:** route views are owner-only, even from super users; nothing is shared. Availability re-checks `visibleRoute` and `can` for the current viewer.
- **Routes:** `/profile/views`; actions save, rename, duplicate, delete, set default, pin.
- **Targeted tests (agent-reported):** unit 35, integration 56 (27 in `sv01`), e2e 4, `theme-readability` 14-test variant.
- **Commits:** `be74891`…`0420b7b`, final `c72b63d`.
- **Remaining limitation:** sort and column choices are not stored. No sharing. Counts exist for 9 of the 16 screens. Task Center has no registry entry yet.

### 9. Relationships + Control Center (`platform/control-center`, merge `9306e1d`)

- **Implemented:**
  - Read-only `/control-center`: 31 checks in six domains (32 with automation), computed per request as the viewer. States are ok / not checked / unavailable, with no score. Exception counts per domain.
  - Related Records: four chains (import, supplier, customer, item) as a stacked section on three record pages and a drill-down page.
- **Architecture:**
  - `domain/control-center.ts` (CHECKS) and `services/control-center.ts` `run()`: read-only transaction, each check in its own savepoint (10 s) under a 90 s budget.
  - A check runs only if the viewer holds `view` on every screen it summarises.
  - Readers call the services that own the question.
  - `services/relationships.ts` `graphFor`; "Not yet" is derived from data.
  - Views that ignore RLS are filtered by hand.
- **Database:** `0390_control_center_grants` (three `role_grant` rows, a `permissions_version` bump). No table, column or trigger. Controls C-82..85.
- **Permissions:** object `control_center`, `view`: `ceo`, `accounting_manager`, `system_administrator`. The relationships page opens for whoever may open the root record. Nothing writes.
- **Routes:** `/control-center` (`?domain=&state=`), `/control-center/relationships?type=&id=`; a section on `/payables/[payableNo]`, `/master-data/business-partners/[code]`, `/master-data/items/[code]`.
- **Targeted tests (agent-reported):** unit 52, integration 55, e2e 7; also re-ran payables, logistics and im2-bl e2e after touching their pages.
- **Commits:** `2dd4a7f`…`c0657eb`, final `1dcc5af`.
- **Remaining limitation:** found but not fixed (other agents' code): `accounting.gl_integrity` has a null branch; the event `inventory.goods_receipt` is not on `POSTING_MAP`; `users.listAll` omits users without a credential. (The false `inventory.gl_difference` finding was fixed by me, `b6cdf89`.) The seeded dev CEO lacks three views, so four checks read "Not checked for you". Not run at production volume.

### 10. Workflow Automation (`platform/workflow-automation`, merge `252a4dc`)

- **Implemented:**
  - A rule is one event, typed conditions and one of a closed set of five actions: notify, create task, request approval, raise exception, open workflow.
  - Five events: `ap_invoice.submitted`, `ap_invoice.posted`, and sweeps for `task.overdue`, `container.eta_exceeded`, `ar_invoice.overdue`.
  - Five templates, every rule born OFF. Versioned and audited. A global and a per-rule switch. Auto-pause after repeated failures (default 3). Loop guard at depth 2.
  - Screens with four doors; Control Center check `platform.automation`.
  - It can never post, pay, move stock or run code.
- **Architecture:**
  - The business transaction only records a fact (`automation_record_event()` writes an outbox row); no rule runs inside it.
  - `runOnce` handles each event in its own transaction as the system operator (`FOR UPDATE SKIP LOCKED`); each action runs in a savepoint as the rule's owner with permissions re-checked at run time.
  - The database guard holds the same closed vocabularies (a unit test compares them to the migration).
  - Idempotence by unique keys on events and runs.
  - `ap-invoice.ts` gained two dispatch calls, review approve/reject, and a refusal to post while a review is open.
- **Database:** `0400_automation_core` (settings, rule, rule version, event, run, definer functions, RLS, series `AUTOMATION_RULE`), `0401_automation_grants`, `0402_automation_provenance`, `0403_automation_print`. Five tables in both reset lists. Controls C-86..89.
- **Permissions:** object `automation` (`view`, `administer`, `print`, `export`) to `ceo` and `system_administrator` only. A rule runs as its owner and each action needs the owner's own grant (notify = `view` of the record; task = `create` + `submit` on `task`; approval = `submit` or `approve` on `ap_invoice`; exception = `administer` and `execute` on `exception`). A deactivated or under-privileged owner pauses the rule.
- **Routes:** `/administration/automation`, `/administration/automation/[ruleNo]`, `/administration/automation/runs/[runId]`; print keys `automation_rule`, `automation_run`; cron `automation-run` (5 min) and `automation-produce` (06:45).
- **Targeted tests (agent-reported):** unit 46 (whole unit project once: 2,215 passed), integration 42, e2e 10. Mine on the merged tree: 581 unit and 475 integration across the Wave 5 batch.
- **Commits:** earlier agent `dff989f`…`daef148`; continuation `6234b3c`…`f6ba9f6`; final `74b5b99`. This agent was interrupted once and resumed from its commits.
- **Remaining limitation:** events not built: payment posted, task assigned, approval requested, reconciliation exception, cloud integration failure. "Send an allowed message" is deferred (Chat has no system-line API). Run reasons are stored in English. A held invoice stays held when its rule is switched off, until a person decides it.

### Inventory finish (`feat/inventory-finish`, merge `ffee776`)

Not one of the ten, but it ran first at the brief's request.

- Transfer and reconciliation record pages with FIFO layers, before/after positions, the journal and four doors, plus two print models.
- The four `lc03-final-cost` `it.todo` cases became real tests; this found and fixed a genuine Final Cost lock-reconciliation defect from before migration 0280 (`reconcileLock` now counts `unattributedIqd`).
- Exact bigint sums on the Warehouses Report and warehouse profile.
- No migration. Commits `529fa73`…`ac5b3c0`, final `36467af`.
- Not additive: `print/documents.ts` lost the two old builders (replaced in the registry).

---

## GLOBAL

### Shared files changed (preserved both sides at every merge)

- **Journal and schema:** `_journal.json` (240 entries, idx renumbered at merge), `schema/index.ts`.
- **Messages:** `messages/en.json` and `ar.json`, `client-messages.ts` (union of namespaces).
- **Rule documents:** `AGENTS.md`, `docs/CONTROLS.md`, `doors-coverage.md`.
- **Screens and menu:** `screens.ts`, `menu.ts`, `erp-shell.tsx`, `screen-catalogue.test.ts` (counts raised through the merges; now 253 screens and 369 total).
- **Test and maintenance lists:** `setup.ts` (`resetTestData`), `format-live-database.sh`, `crontab.erp`, the `im04`/`im05` guards, the `ops16` list.
- **Attachments and records:** `services/attachments.ts` (`mayAccessParent`), `attachments-runtime.ts`, `records/index.ts`.
- **Print and search:** `print/registry.ts`, `print/access.ts`, `search/entities/index.ts`.
- **Notification and approval plumbing:** `domain/notification-center.ts`, `services/notifications.ts`, `workflow.ts`, `approvals.ts`, `ap-invoice.ts`.
- **Other:** 12 list pages (Saved Views), `print/documents.ts` (two builders removed), `theme-readability.spec.ts` (`.first()` on ten locators).

### Migration numbers used

| Block | Journal idx | Migrations | Owner |
|---|---|---|---|
| 0310–0311 | 220–221 | chat core, access | Chat |
| 0320–0322 | | cloud files core, links, grants | Document Center |
| 0330 | | global search | Global Search |
| 0340–0344 | 226–230 | task core, scope, grants, team, system session | Task Center |
| 0350 | | notification center | Notification Center |
| 0360 | | saved route views | Saved Views |
| 0380–0381 | 233–234 | exception core, grants | Exception Center |
| 0390 | 235 | control center grants | Control Center |
| 0400–0403 | 236–239 | automation core, grants, provenance, print | Automation |

- Dashboard and Inventory finish used none.
- Control numbers: Chat C-60..62, Documents C-63..65, Tasks C-66..69, Notifications C-70..73, Saved Views C-74..77, Exceptions C-78..81, Control Center C-82..85, Automation C-86..89. Global Search, Dashboard and Inventory finish used none.
- Every `when` is after the journal's last earlier entry, as the rule requires.

### Conflicts encountered

- **Rule documents and messages:** `AGENTS.md`, `CONTROLS.md` and both message files conflicted in every wave; resolved by keeping both sides.
- **Journal and `schema/index.ts`:** idx values collided (several agents wrote 220 or 226) and were renumbered at merge, ordered by `when`, never by filename.
- **`mayAccessParent`:** three agents each exported their own. I unified it as `Promise<boolean | null>` (`null` = no check registered; a throwing check counts as `false`) and updated Chat to `=== true`.
- **Control numbers:** Document Center C-60..62 → C-63..65, then Exceptions C-82..85 → C-78..81. The `im15` test requires numbering without gaps.
- **Test counts:** `screen-catalogue` counts raised at each merge.
- **Fixture and date assumptions:**
  - A task-center assertion that its `when` values exceeded every other block failed once later blocks merged; it now compares only with earlier entries.
  - `ex01` and notification-center NC8 passed only on 4 October (hard-coded day counts and "tomorrow"); made date-relative (`7b9433a`).
- **Cross-agent defects found at the seams:**
  - The Exception Center's false Inventory-vs-GL difference on a clean import (fixed).
  - Task notices resolved as "No longer available" in the Notification Center (fixed in `af50731`).
  - The Dashboard's attention slot was not wired to the Exception Center (wired in `32c04fe`).

### Cross-module dependencies

- Chat ← Task Center (Reply in Chat), Dashboard (unread badge). Chat → attachments, notifications.
- Document Center ← Task Center, Exceptions (link targets). Document Center → attachments, record registry, users.
- Global Search ← Task Center, Exceptions, Document Center (registered types).
- Notification Center ← Chat, Tasks, Exceptions, Automation, workflow, Cloud Files. It resolves every target in the reader's own scope.
- Saved Views → Dashboard (`pinnedFor`), Exceptions (`exceptions.list` is registered).
- Dashboard → Tasks, Notifications, Saved Views, Chat, approvals, Exceptions (attention feed).
- Exceptions → Tasks (`overdueTasks`, `blockedTasks`), accounting, inventory, logistics, system health. Exposes feeds to Dashboard, Control Center and Automation.
- Control Center → Exceptions, nearly every reporting service. Automation → Tasks, Exceptions, Notifications, workflow, `ap-invoice`; adds the check `platform.automation` to the Control Center.

### Features intentionally deferred

- Full regression (suites, theme-readability across 90 combinations, e2e on a merged production build, load) — the brief puts this after consolidation.
- Chat push/e-mail, message edit, channels, calls. Automation sending a chat message.
- Task sub-sections, notice translation, previous-assignee notice.
- Saved view sorting/columns/sharing; counts on the other 7 screens.
- Exception thresholds as settings, bulk acknowledge, assignment.
- Document Center: per-profile panel, refresh of renamed links, re-share on mapping change.
- Automation events: payment posted, task assigned, approval requested, reconciliation exception, cloud integration failure.
- Not built, by the brief's own exclusions: an AI assistant, a general workflow builder, a CRM, a project-management replacement, social chat, a separate document store.

### Needs an owner decision or a live check

- PR #52 (`feat/erp-integration` → `main`) is still open; `feat/platform-layer` contains it plus all of the above.
- First run of the Document Center against the real Nextcloud (set `ERP_SECRET_KEY`, add the nginx upload location).
- The remaining three reported defects (`accounting.gl_integrity` branch, `inventory.goods_receipt` not on `POSTING_MAP`, `users.listAll`).
- The HR manager's missing My Approvals entry; the daily overdue-invoice notice.
- Older questions still open: the source of closing check 7, the Payables dropdown headings, Finance department membership after a rebuild.
- Old module worktrees and scratch databases remain on disk (the sandbox refused bulk deletion).
