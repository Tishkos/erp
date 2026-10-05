# Workflow Automation — implementation record

Platform phase, Wave 5, Builder Agent 10 (started by an earlier agent, finished
by this one). Branch `platform/workflow-automation`, worktree
`/home/claude/wt/automation`, databases `erp_automation` / `erp_test_automation`,
port 3010. Migrations `0400_automation_core`, `0401_automation_grants`,
`0402_automation_provenance`, `0403_automation_print` (journal idx 236 to 239,
`when` 1795900000210 to 1795900000213). Controls C-86 to C-89. Series `AUT`
(`AUTOMATION_RULE`, 0400).

This is the first **controlled** automation layer. It is not a general workflow
builder and not Zapier: a rule is one explicit Qimah event, a few typed
conditions and a short list of actions from a closed set. It runs as the person
who owns it, with what that person could do by hand, and it can never post,
pay, move stock or run code.

## 1. Architecture

```
 business transaction                      cron */5 and 06:45                 settings screen
 ap-invoice.submit / .post                 scripts/ops/automation-run.ts      /administration/automation
        │ dispatch(tx, event, payload)            │                                  │
        ▼ (savepoint, never raises)               │ --produce [day]: sweep           ▼
 automation_record_event()  ─►  automation_event ◄┘ producers (task overdue,   automation.createFromTemplate /
 definer function; unique         (the outbox)       container past ETA,        change / enable / disable /
 (event, record, window)              │              sales invoice overdue)     setSwitch  (the only rule writer)
                                      ▼
                    runOnce():  per event, own transaction, system operator,
                    FOR UPDATE SKIP LOCKED  →  per matching enabled rule:
                      owner still active and holding administer?  else pause the rule
                      loop guard (automation_made, MAX_DEPTH 2)
                      conditions evaluated on the recorded payload (pure)
                      each action in a savepoint AS THE OWNER  ──►  Task Center, workflow engine,
                      advisory lock on the run key                    Exception Center, notifications
                      one append-only automation_run row per rule per attempt
```

* `domain/automation.ts` is pure: the vocabulary (condition operators, the five
  action kinds, recipients), `validateDefinition`, `evaluate`, `requirementsOf`
  / `reachOf` (what the owner must hold to do each action by hand), run keys,
  retries (1 / 10 / 60 minutes, three attempts), `shouldPause`, `guardOf` and
  `MAX_DEPTH`. `domain/automation-events.ts` is the closed event catalogue
  (`EVENTS`), the notice kinds and the sweep cap. `domain/automation-templates.ts`
  holds the five templates and their parameters (`parseParams`, `buildDefinition`).
  `domain/automation-text.ts` words a rule, a condition and a recorded value in
  the reader's language (`fieldValueText`): the screen, the run page and the copy
  all go through it, so no raw priority, section or person id is ever shown.
* `services/automation.ts` is the only writer of `automation_rule`,
  `automation_rule_version` and `automation_setting`, and the read model of the
  three screens. `services/automation-dispatch.ts` is the one call a business
  transaction makes. `services/automation-events.ts` holds the sweep producers
  (read-only, through the services that already know the answer).
  `services/automation-runner.ts` is `runOnce`; `services/automation-actions.ts`
  is `perform`. `services/exception-detectors/automation.ts` keeps the findings a
  rule raised true (they clear by themselves when the cause is gone).
* The database holds the same closed lists as the application
  (`automation_rule_version_guard` checks event, operators, action kinds,
  recipients and limits whoever inserts), the append-only history, the born-OFF
  rule, the `enabled_at` stamp, the once-only keys and the row security. The unit
  test reads migration 0400 and fails when the two vocabularies disagree.

The rule that makes it safe to leave running: **the business transaction only
records a fact.** No rule runs inside it, so a failing, slow or switched-off
engine can never hold up or roll back an invoice. The runner reads the recorded
payload; it does not re-read the document.

## 2. What was implemented

* **Events (5).** Record events: `ap_invoice.submitted` (`ap-invoice.submit`) and
  `ap_invoice.posted` (`ap-invoice.post`). Sweep events, one per record per
  business day: `task.overdue`, `container.eta_exceeded`, `ar_invoice.overdue`.
  A sweep records an event only for a kind some enabled rule is listening to, at
  most `SWEEP_EVENT_CAP` (2,000) per kind per morning (what is not reached is
  counted and the next run goes on; exit code 2 tells the job monitor).
* **Actions (5).** `create_notification` (to a role, a person, the rule's owner,
  whoever raised the record, the person a task is with, or their supervisor; each
  person is checked as themselves — a notice never tells anyone a record exists
  they may not open), `create_task` (through `tasks.create` in the Task Center's
  scope; an assignee outside the owner's scope is a failed run, never forced),
  `request_approval` (the workflow engine's own route for a purchase invoice,
  `ap_invoice`, one step by the accounting manager; the invoice cannot be posted
  while the review is open, and approving it only lifts the hold), `create_exception`
  (Exception Center, through `exceptions.raiseFromAutomation`), `open_workflow`
  (tells people the invoice is waiting for review in My Approvals).
* **Templates (5), shipped as templates and every rule born OFF:**
  `invoice_over_threshold` (purchase invoice at or over an amount is held for a
  second person's review and a role is told), `container_eta_exceeded` (container
  N days past ETA and not received: exception, notice, optional follow-up task),
  `task_overdue` (the person it is with and, where permitted, their supervisor are
  told), `invoice_overdue_follow_up` (sales invoice N days past due: a follow-up
  task and a notice for whoever raised it), and `invoice_posted_notice` (a posted
  invoice at or over an amount: a role is told; nothing held).
* **Versioned and audited.** A change is a new append-only version; a run names
  the version it used. The person who saves or enables a rule becomes its owner
  and the rule runs with that person's permissions. Every change is audited
  (`automation.*` actions) with the request id.
* **Idempotence.** `automation_event_once` (event, record, window) and
  `automation_run_done_once` (rule, event, record, stretch of lateness) make a
  repeated, retried or concurrent dispatch produce one `done` run and one effect;
  two runners at once split the outbox with `SKIP LOCKED`, and an advisory lock on
  the run key covers the rest.
* **Determinism.** The same recorded payload and rule version give the same plan.
  Conditions use exact scaled-bigint comparison for money and whole-number days.
* **Loop guard.** `automation_made` remembers what an action created (a task, a
  finding). A rule never acts on a record it made itself, and nothing acts on a
  record made two steps from a person (`MAX_DEPTH = 2`).
* **Kill switches and auto-pause.** One global switch and one per rule (with a
  reason, audited). While the global switch is off nothing is recorded, so there
  is no backlog to flood when it is switched on. A rule that fails N events in a
  row (default 3, 1–20, on the screen) is paused and the administrators are told
  once (`automation.paused`). A permanent refusal (the owner may not do it, the
  recipient may not open the record) is logged and not retried.
* **Business dates.** Sweeps are dated by the business day (`businessToday()`,
  `--produce YYYY-MM-DD` for a missed day); due dates for follow-up tasks use
  `addBusinessDays`. Nothing reads the server's UTC date.
* **Screens.** `/administration/automation` (settings screen: status and kill
  switch, rules, templates, runs), `/administration/automation/[ruleNo]` and
  `/administration/automation/runs/[runId]` (record screens). Both records wear
  the four doors in the standing order (printer, paperclip, notes, clock). Print
  models `automation_rule` and `automation_run`; EN and AR with RTL; checked at
  390 px.
* **Control Center.** One additive check `platform.automation` (rules paused or
  failing this week, events the runner has not taken for half an hour, the global
  switch left off; "not set up" until a first rule exists). The Control Center now
  has 32 checks.
* **Notification Center.** One notice kind per event plus `automation.paused`.
  The container notice opens Shipment Tracking narrowed to the container, because
  the centre does not follow a record page that sits under a list screen.

### Events that exist, and events that do not (yet)

| Event | Status |
|---|---|
| purchase invoice submitted, posted | built (record events) |
| task overdue, container past ETA, sales invoice overdue | built (sweeps) |
| payment posted | not built |
| task assigned | not built (the Task Center already notifies) |
| approval requested | not built |
| reconciliation exception | not built |
| cloud integration failure | not built |
| action "send an allowed message" | deferred: Chat has no system-line API |

Each missing event is one `EVENTS` entry, one producer, one migration widening the
closed lists and the words (see section 11).

## 3. Data source

Everything a rule sees is the **recorded payload** of its event (supplier, amount
in IQD as an exact decimal, dates, the people involved), built by the producer from
the owning service's own read at the moment the fact happened. Sweeps read through
`tasks.owedWithDueDate`, `logistics-views.shipmentTracking` and
`open-items.openItems`. Nothing is read from a table the owning service does not
already expose. Run history, versions and the event log are the module's own
tables.

## 4. Permissions

* `view` and `administer` on `automation`: CEO and system administrator (0401);
  `print` and `export` the same two (0403); a Super User holds every verb. Everyone
  else gets the standard Denied page on the screen, the rule and the run, and no
  menu item.
* A rule runs with its **owner's** permissions, asked again at run time
  (`requirementsOf`): notify = `view` of the record; task = `create` + `submit` on
  `task` and `view` of the record; approval = `submit` or `approve` on `ap_invoice`;
  exception = `administer` **and** `execute` on `exception` and `view` of the
  record. Switching a rule on shows what the person would not be able to do by hand
  (those steps would be skipped).
* A refusal at run time is a skipped or failed run with its reason. An owner who is
  deactivated or no longer holds `administer` on automation pauses the rule.
* Row security on all six tables: read with `view` on `automation` (or as a Super
  User); the rule, its versions and the setting are written with `administer`;
  events, runs and provenance only by the system operator (the runner).

## 5. Database changes

| File | idx | `when` | What |
|---|---|---|---|
| `0400_automation_core.sql` | 236 | 1795900000210 | `automation_setting`, `automation_rule`, `automation_rule_version` (append-only, vocabulary guard), `automation_event` (outbox), `automation_run` (append-only), `automation_record_event` / `automation_listening` / `automation_is_on` (definer functions), RLS, series `AUTOMATION_RULE` (AUT) |
| `0401_automation_grants.sql` | 237 | 1795900000211 | `view` and `administer` on `automation` for CEO and system administrator; the `ap_invoice` approval route (one step, accounting manager) |
| `0402_automation_provenance.sql` | 238 | 1795900000212 | `automation_made` (append-only; the loop guard's memory) |
| `0403_automation_print.sql` | 239 | 1795900000213 | `print` and `export` on `automation` for the same two roles |

Applied to both databases. `resetTestData` clears the five document tables and puts
`automation_setting` back to on / 3; `format-live-database.sh` clears the same five
and keeps `automation_setting` (listed in ops16's `KEPT_BY_A_FORMAT`).

## 6. Routes

`/administration/automation`, `/administration/automation/[ruleNo]`,
`/administration/automation/runs/[runId]`; print keys `automation_rule`,
`automation_run` (the standard export route, as every other record); cron job lines
`automation-run` (every five minutes) and `automation-produce` (06:45) in
`scripts/ops/crontab.erp`.

## 7. Shared files touched (all additive)

`messages/en.json`, `messages/ar.json` (block `admin.automation`, `page.automation`,
`print.titles.automation_*`, `notifications.kind.automation_*`, the Control Center
check and its figures and items) · `scripts/ops/crontab.erp` (two lines) ·
`scripts/ops/format-live-database.sh` (five tables) · `src/components/admin/index.tsx`
(`Select` takes an `id`, so two selects on a page do not share `f-<name>`) ·
`src/server/attachments-runtime.ts` (rule and run parent access) ·
`src/server/db/migrations/meta/_journal.json` · `src/server/db/schema/index.ts` ·
`src/server/domain/{control-center,exceptions,menu,notification-center,screens}.ts`
· `src/server/print/{access,registry}.ts` · `src/server/services/{ap-invoice,
approval-center,control-center-readers,exceptions,record-notes,workflow}.ts` ·
`src/server/services/exception-detectors/index.ts` · `docs/CONTROLS.md` (C-86 to
C-89) · `docs/notes/doors-coverage.md` · `AGENTS.md` (one section at the end) ·
`tests/integration/setup.ts` (`resetTestData`) ·
`tests/integration/{cc01-control-center,ex01-exceptions,notification-center,
ops14-print-export,ops16-document-table-lists}.test.ts` ·
`tests/unit/{ex01-exceptions,im04-live-guard,im05-jobs-locked,
screen-catalogue}.test.ts` (counts: 253 screens, 369 in total, 253 wired routes;
the job list). The earlier agent also made two day-count assertions in ex01 and
notification-center follow the real business day (they passed only on 4 October).

`ap-invoice.ts` gained the two `dispatch` calls, `approveReview` / `rejectReview`
and the "review open" refusal in `post`; `approval-center.ts` gained one handler
(`ap_invoice`, decided with `submit`); `workflow.ts` gained only the invoice number
in `referenceOf`. (The workflow engine already refuses a decision by whoever
requested it, so the rule's owner who asked for a review cannot answer it.)

## 8. Targeted checks run

Own databases only, every run through `heavy`; no full integration suite.

* `npx tsc --noEmit -p .` — clean.
* Unit: `npx vitest run --project unit tests/unit/wf01-automation.test.ts` — 46
  pass (closed vocabulary equals migration 0400, templates, evaluator, retries,
  guard, words in both locales with matching placeholders, `fieldValueText`,
  registrations). The whole unit project once: 132 files, 2,215 tests pass.
* Integration: `npx vitest run --project integration tests/integration/wf01-automation.test.ts`
  — 42 pass in about 12 seconds: scenarios AU1 to AU12 (four template rules and
  the posted notice end to end, permission-awareness, kill switches and auto-pause
  told once, determinism, idempotence including concurrent dispatch and a second
  runner, outbox fault does not touch the business transaction, loop guard chain,
  permanent refusals, versioning and append-only, bounded work). Scenarios pick
  their own days; none depends on the calendar.
* `tests/integration/cc01-control-center.test.ts` — 32 pass (the new
  `platform.automation` scenario: a paused rule, a rule whose runs failed, events
  not taken; back to "not set up" afterwards).
* `tests/integration/{ex01-exceptions,notification-center}.test.ts` — 79 pass;
  `ops14-print-export` — 25 pass (the two automation keys are listed with the
  CEO/administrator-only keys); `ops16-document-table-lists` — 3 pass;
  `im15-controls-register` — 3 pass (C-86 to C-89).
* E2E: `npx playwright test -c playwright.local.config.ts tests/e2e/automation.spec.ts --workers=1 --project=chromium`
  — 10 pass: the administrator makes a rule from the Task overdue template (born
  off, read in words, four doors, switched on), the manager raises a task due in a
  week, the sweep for a day three days after the due date records one event and a
  second run records none, the run is on the register and on its own page, the
  officer is told and the notice opens the task, the kill switch stops recording
  until it is put back, changing the rule saves a second version (the form shows what was typed), the rule is switched off with a reason, the manager and the
  outsider are turned away from the screen, the rule and the run, and the three
  screens hold at 390 px right to left with no sideways page scroll.
  `tests/e2e/theme-readability.spec.ts` — 14 pass.

## 9. Commits

`dff989f`, `01661d4`, `2e7b321`, `d1166d7`, `3ca916b` (earlier agent: catalogue and
vocabulary, migrations 0400/0401, dispatch and rule service, producers, actions,
runner, review gate, cron, first integration draft), `7b9433a`, `c71396c`, `daef148`
(merge of `feat/platform-layer`), then this agent: `6234b3c` (loop guard and
provenance 0402, lazy payloads, permanent refusals, notice recipients checked as
themselves, posted-invoice template, bounded sweeps), `06aa769` (integration test,
`execute` required to raise an exception), `291becc` (screens, words, print models,
notes and files access, 0403, menu and catalogue), `988cee5` (Control Center
check), `0298ac8` (Playwright spec, controls, doors table, values worded by kind,
templates table) and the closing commit with this record, the AGENTS.md section and
the ops14/ops16 test lists.

## 10. Remaining limitations

* **Hold-on-review survives a switch-off.** If automation is switched off after a
  rule held a purchase invoice for review, the review stays open until a person
  decides it in My Approvals; nothing lifts it automatically. This is deliberate
  (a held invoice is never released by a missing engine) and shown in the invoice's
  refusal message.
* Run reasons and step sentences are stored in English and shown as written; the
  run page says so. Everything around them (labels, outcomes, conditions, events,
  values) is worded in the reader's language.
* One notification per recipient per event per rule (deduped by occurrence); a rule
  cannot ask for a digest.
* Notice links: the container notice opens Shipment Tracking (the centre does not
  serve a record page under a list screen). The pre-existing `container.late`
  notice very likely has the same limit.
* Seen, not touched: the Task Center's own `task.assigned` / `task.reassigned`
  notices store the task **number** as `object_id`, while the Notification Center
  resolves the `task` kind by uuid, so they read "No longer available" for the
  assignee. Automation's task notices carry the uuid and open correctly. A fix is
  one line in `services/tasks.ts` (pass the task's id) or a number lookup in
  `notification-center.ts`.
* No cloud-integration or reconciliation events; no "send an allowed message".
* Screen design: the Status panel uses the profile-facts list (generous row
  height), the settings screen puts four registers in one page, and the long
  rule sentences in the rule's own table scroll sideways inside the table on a
  phone like every other register. No new CSS class was added.
* The 2,000-per-morning sweep cap is a constant (`SWEEP_EVENT_CAP`), not a setting.

## 11. What next agents need

* **Add an event.** `EVENTS` entry (fields and their types, which recipients and
  actions it allows, `href`, optionally `noticeHref` / `exceptionDetector` /
  `episodeField`), a producer (a record event: `dispatch` after the state change,
  in the same transaction; a sweep: `PRODUCERS` in `automation-events.ts`), a
  migration widening `automation_event_key_known`, `automation_rule_event_known`
  and the version guard's event list (never edit 0400), the notice kind in
  `notification-center.KINDS` and `notifications.kind.automation_<key>`, and the
  words `event_*`, `payload_*`, `field_*` in both locales. The unit test lists what
  is missing.
* **Add an action kind** only if it is not a posting and the owning service has its
  own check; add it to `ACTION_KINDS`, `validateActions`, `requirementsOf`,
  `perform`, the words and the migration guard.
* **Add a template**: an entry in `TEMPLATES` with its `build`, `template_<code>`
  and `template_<code>_what` and `p_<param>` in both locales; the form is drawn
  from the template's parameter list.
* `scripts/ops/automation-run.ts` is listed in `tests/unit/im04-live-guard.test.ts`
  as a job whose purpose is the live database; any new script that writes rules or
  events must refuse while `var/LIVE` exists or be listed there with its reason.
  The runner is a cron job through `run-job.sh`, shown on Background Jobs.
* The Control Center check, the controls rows and the print keys already exist;
  keep them in step when the vocabulary changes.
* Rule notes, files and history are keyed by the rule number (notes, history) and
  the rule's uuid (files); a run's by its id.
