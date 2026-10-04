# Internal Chat — implementation record (Platform phase, Agent 1, 2026-10-04)

Branch `platform/chat` (from `feat/platform-layer`). Practical, Qimah-shaped
collaboration: one-to-one and group conversations, real delivery states,
presence, replies, reactions, files, @mentions, and a conversation that hangs
on any ERP record. It is not Slack: no channels, threads, calls or bots.

## 1. Architecture

* **Writer / reader split.** `services/chat.ts` writes (open, members, send,
  retract, react, receipts, presence, typing); `services/chat-read.ts` reads
  (list, thread, earlier, sync, search, people, files, badge). Pure rules live
  in `domain/chat.ts` (state arithmetic, presence, mentions, validation) and are
  held by `tests/unit/chat-rules.test.ts`.
* **Access is the database's.** Row-level security (FORCE) on all six tables,
  with SECURITY DEFINER helpers (`app_chat_member`, `app_chat_can_read`,
  `app_chat_message_visible`, `app_chat_shares`, `app_chat_may_add`,
  `app_chat_touch`, `app_chat_lock`, `app_chat_first_unseen`). A person reads a
  conversation only while a member, and a message only from the seq they joined
  at. `outsider@example.com` sees no row, no file, no poll answer.
* **Real states.** `chat_receipt` has one row per recipient, written by an
  insert trigger with the message. `sent` = the row exists. `delivered_at` is
  written only when the recipient's browser acknowledges a later poll (`ack`).
  `seen_at` is written only when that tab is visible, the conversation open and
  scrolled to the end (`seen`). The sender's state is the slowest recipient's
  (`domain/chat.ts` › `stateOf`). *Sending* exists only in the sender's browser
  (a pending row keyed by `clientId`, merged when the persisted row returns);
  a failed send shows Retry/Discard. Nothing is derived from time.
* **Realtime = adaptive polling, no dependency.** `POST /chat/api/sync` runs in
  one transaction: heartbeat, acks, seen, typing, then returns the list, the
  badge, presence of the people met, and — for each open conversation whose
  `rev` moved — the new messages. Cadence 2 s (thread open) / 6 s (chat list) /
  15 s (other pages: header badge only) / 30 s (hidden tab), backing off to a
  minute on errors. Typing is `typing_until` (6 s TTL) carried in the poll.
* **Send is idempotent.** The client mints `clientId`; a unique index
  `(conversation, sender, client_id)` makes a retry answer with the first row.
* **Files** are ordinary attachments, object type `chat_message`. Upload and
  download go through `attachments.upload/download`; the parent check
  (`attachments-runtime.ts` › `chatMessageParentAccess`) requires membership
  from the message's seq. `/chat/files/[id]` streams (`?inline=1` for images).
* **Record conversations.** `openRecordConversation(tx, ctx, {recordType,
  recordId, label?, href?, members?})`: unique per (type, id, member set); the
  opener and every added member must pass `mayAccessParent` for that record
  (`attachments.mayAccessParent`). `RecordView {accessible:false}` exposes
  neither label nor link to a member who cannot open the record.
* **Notifications are emitted, not shown.** `chat.message` once per run of
  unseen messages per recipient (dedupe key on the first unseen seq; none for a
  muted conversation) and `chat.mention` per person named, via
  `notifications.insertNotification`. Link: `/chat?c=<conversationId>`. The
  header's existing bell is untouched.
* **Messages are never deleted.** Triggers refuse DELETE on conversation,
  participant, message and receipt; UPDATE is limited to a guarded set of
  columns. A withdrawal is a soft retract (`retracted_at/by/reason`), audited
  (`chat.message_retracted`); the body stays in the row, the screen shows
  "withdrawn by …" and the reason. Membership ends with `left_at`, not delete.

## 2. What was implemented

* `/chat` screen (journal-workspace split: conversation list | thread):
  search, new chat, new group, details (members, add/remove, rename, mute,
  leave), reply with quoted original (jump to it), reactions (six), @mention
  suggestions, attachments (picker, images inline), earlier messages, unread
  divider and per-conversation unread counts, system lines ("X added Y"),
  message search across the person's conversations, status shown on own
  messages (Sending → Sent → Delivered → Seen, `n/m` in groups, per-person
  hover), presence pill (Online / Away / Busy / Offline + last seen), typing
  line, Busy toggle, draft prefill `?draft=`, record chip when the conversation
  hangs on a record.
* Header: the Messages button shows `coa-count-badge` with the unread total in
  place of the envelope; its drawer lists waiting conversations and links to
  `/chat`. Mobile drawer row carries the count. Three small components in
  `src/components/chat/chat-header.tsx`, six lines wired in `erp-shell.tsx`.
* English and Arabic (RTL) catalogues (`chat` namespace, `page.chat`, ~130 keys),
  390 px mobile (list and thread are one pane at a time, back button).

## 3. Data source

PostgreSQL only; tables `chat_conversation`, `chat_participant`,
`chat_message`, `chat_receipt`, `chat_reaction`, `chat_presence`. Drizzle schema
`src/server/db/schema/chat.ts`. Times are instants; display uses
`BUSINESS_TIME_ZONE` (passed as a prop). Attachments live in the existing
`attachment` table and store. Nothing is mocked.

## 4. Permissions

* New permission object `chat`. Migration 0311 grants `view` + `create` to every
  existing role (copied from `role`), bumps `permissions_version`. Roles created
  later get it on the roles screen. Without `chat` view the screen is Denied,
  the poll answers 403, the header button is the old empty drawer.
* Who may talk to whom: any active user with the grant (the directory is the
  company's). What a person may *read* is membership (RLS), never the grant.
* Record conversations: `mayAccessParent` for the record type — the same rule
  the attachments use — for the opener and for each member added.
* Writes audit: `chat.conversation_opened`, `chat.record_conversation_opened`,
  `chat.members_added`, `chat.member_removed`, `chat.member_left`,
  `chat.group_renamed`, `chat.message_retracted`. Message bodies are not copied
  into audit.

## 5. Database changes

* `0310_chat_core.sql` (journal idx 220, `when` 1795900000120): six tables,
  indexes (incl. trigram on body for search), helpers, triggers, RLS policies.
* `0311_chat_access.sql` (idx 221, `when` 1795900000121): `chat` grants for
  every role; one SELECT policy `attachment_chat_member` so a member in another
  branch can read a conversation's file rows.
* §5 lists: the six tables are in `tests/integration/setup.ts`
  (`resetTestData`) and `scripts/ops/format-live-database.sh`
  (`DOCUMENT_TABLES`); `ops16-document-table-lists.test.ts` checks both.
* `docs/CONTROLS.md`: C-60 (readable only by members, from the seq they
  joined), C-61 (never edited or deleted; withdrawn with a reason; receipts
  forward-only and on the recipient's own statement), C-62 (a file opens only
  for a member; a record is shown only to a member who could open it).

## 6. Routes

* `GET /chat` (`?c=<id>`, `?draft=`, `?record=<type>:<id>&label=&href=`).
* `POST /chat/api/sync` (same-origin guard, 401 signed out, 403 restricted).
* `GET /chat/files/[id]` (`?inline=1`).
* Server actions in `chat/actions.ts`: send, retract, react, openDirect,
  createGroup, openRecord, addMembers, removeMember, leave, rename, mute, busy,
  earlier, search, people.
* Menu: first module's group, after Notifications (`menu.ts`, `screens.ts`, catalogue test).

## 7. Shared files touched (all additive)

`src/components/erp-shell.tsx` (import, `chatEnabled`, label/glyph/popover/count
at the Mail button and the mobile row) · `src/server/domain/menu.ts` ·
`src/server/domain/screens.ts` · `tests/unit/screen-catalogue.test.ts` ·
`src/i18n/client-messages.ts` (adds `chat`) · `messages/en.json` ·
`messages/ar.json` · `src/server/attachments-runtime.ts` (chat_message parent
rule) · `src/server/services/attachments.ts` (exports `mayAccessParent`) ·
`tests/integration/setup.ts` · `scripts/ops/format-live-database.sh` ·
`src/server/db/migrations/meta/_journal.json` · `src/server/db/schema/index.ts` ·
`AGENTS.md` (one appended section) · `docs/CONTROLS.md` (three rows) ·
`docs/notes/doors-coverage.md` (a Chat note).

## 8. Targeted checks run

* `npx vitest run --project unit tests/unit/chat-rules.test.ts tests/unit/screen-catalogue.test.ts`
* `npx vitest run --project integration tests/integration/chat.test.ts` (own
  DB `erp_test_chat`)
* `npx vitest run --project integration tests/integration/ops16-document-table-lists.test.ts`
* `npx playwright test tests/e2e/chat.spec.ts --workers=1` (dev server on 3001,
  database `erp_chat`): two real browsers prove Sent → Delivered → Seen, the
  typing line, reply + quote, reaction, image and file upload/download,
  outsider denial (screen, poll 403, file 404); a second test takes EN desktop
  and AR 390 px screenshots beside Purchase Invoices.
* `npx tsc --noEmit -p .` (only the pre-existing `mainLogo.png` errors).
* Results are in the hand-off report; not run: full suites,
  `theme-readability.spec.ts` (see limitations).

## 9. Commits

4b4c001 schema + RLS (0310–0311) · 769ef36 pure rules · dd0d0cb services +
attachment parent check · 3bcd4db integration tests + reset lists · 630c5c5
screen, header, routes, actions, catalogue, menu · 004cdc4 list-row thread,
Playwright spec, controls, AGENTS section · (final commit: this document).

## 10. Remaining limitations

* Polling, not push: a message reaches an open thread within ~2 s, a closed
  one within 15 s. Fine for dozens of users; a few hundred need a push channel
  (the `sync` response is the seam; swap the transport, keep the shape).
* No message editing (only withdraw), no threads/channels, no voice/video, no
  read-by-whom list beyond the hover text, no push/e-mail for chat (the
  notification rows exist; the e-mail rules are the notifications admin's).
* Presence: Offline = no poll for 75 s (the heartbeat is the poll); Away =
  polling but no touch of the page for 5 min; Busy is the person's own switch
  and shows while polling; otherwise Online. A hidden tab polls every 30 s, so
  it stays present but turns Away.
* Search is a substring match (trigram index) over messages the person can
  read; no ranking, no attachment-content search.
* Design: every element uses existing classes. Gaps (nothing invented): no
  bubble or avatar-with-status class, so messages are `fileList` rows with the
  sender name and time in the title row; no composer class, so the composer is
  the `sapEntryBar` row; the unread divider is an `sapNote` line. A reviewer
  may want a chat-specific class set; that is a design decision for the owner.
* `theme-readability.spec.ts` was not run (it walks 90 palette combinations
  against the seeded dev server; chat uses only classes that spec already
  covers, but the AGENTS rule says run it before "done").
* Hydration warning in dev logs comes from the screenshot step's injected
  `caret-color` style, not from the page.

## 11. What the next agents need

* **Task Center / any "discuss this" door:** call
  `chat.openRecordConversation(tx, ctx, { recordType, recordId, label, href })`
  in the same transaction as your action, then redirect to
  `/chat?c=<conversationId>` (add `&draft=<text>` to prefill the box; the text
  is a draft only, nothing is sent). Check `RecordView.accessible` when you
  render a chip for another user.
* **Notifications / Notification Center:** chat emits `chat.message` and
  `chat.mention` (object `chat_conversation`, context `{conversationId,
  messageId, seq, senderId, href}`); render them with `href`, do not add a
  chat bell. Only unread-run-first notifications exist (ten messages = one).
* **Global Search:** `chat-read.searchMessages` is the access-correct source
  for message hits (membership + seq window); do not query `chat_message`
  without a user scope. Results should link `/chat?c=<id>`.
* **Document Center:** a chat file is an attachment with object type
  `chat_message`; its parent check is membership. Do not list them as business
  documents without that check.
* **Integrator:** CONTROLS numbering C-60..62 may collide with another branch;
  renumber on merge and keep `im15-controls-register` green. The AGENTS.md
  section is appended at the end; migrations 0310–0311 sit at journal
  `when` …120–121 (the chat range is …120–129).
