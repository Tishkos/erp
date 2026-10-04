# Document Center / QS Cloud Files — implementation note

Platform phase, Agent 4. Branch `platform/document-center`. 2026-10-04.

**Provider confirmed from the repo's sponsor decision: Nextcloud** (QS Cloud
Files, https://files.qs-groups.com). Login Flow v2 per user; the app password
is encrypted with `ERP_SECRET_KEY` and revoked on unlink and on deactivation;
WebDAV as that user; the OCS Share API shares folders made from the ERP with
the Nextcloud groups mapped to ERP roles; a folder per record; **nothing is
copied** — the cloud stays the store and its permissions are the truth.

**The sandbox has no route to files.qs-groups.com.** Everything below was
checked against `tests/support/nextcloud-stub.ts`, a real HTTP server that
speaks the parts of Nextcloud used here. The first run on the host is the live
test (see *Remaining limitations* for what to look at first).

---

## 1. Architecture

```
 browser ──► ERP routes / pages ──► services (as the person) ──► CloudClient ──► Nextcloud
              session + ERP grant      cloud-accounts / cloud-files   one origin,    WebDAV / OCS /
              + record access          cloud-settings / link-targets  Basic auth     Login Flow v2
                                       │
                                       └─► Postgres: only links and connection state
```

| Layer | File | Role |
|---|---|---|
| Pure rules | `src/server/domain/cloud-files.ts` | path normalisation and traversal refusal (`normaliseCloudPath`, `isWithin`, `joinPath`, `breadcrumbs`), base-URL rules (https; loopback http only outside production), sharing bits, link shape (`formatLinkTarget` / `parseLinkTarget`), listing helpers (`kindOf`, `ENTRY_FILTERS`, `passesFilter`, `sortEntries`, `canPreview`, `readableSize`), a namespace-aware PROPFIND parser (`parsePropfind`), OCS and Login Flow v2 parsers, `connectionState`. No I/O. |
| Secret | `src/server/secret-box.ts` | AES-256-GCM, key by HKDF from `ERP_SECRET_KEY` (≥ 32 chars), AAD binds the ciphertext to its owner (`cloud-files:<userId>`, `cloud-link:<userId>`), format `v1.<iv>.<tag>.<ct>`. A missing or short key is a typed `SecretKeyError`; nothing is stored in the clear. |
| HTTP | `src/server/services/cloud-client.ts` | The only code that talks to the cloud. One person's credentials per instance; never follows a redirect to another origin with credentials; typed errors (`CloudUnreachableError`, `CloudAuthError`, `CloudDeniedError`, `CloudNotFoundError`, `CloudConflictError`, `CloudRequestError`). PROPFIND 0/1, MKCOL, PUT with `If-None-Match: *`, GET, `dav/meta` (path of a file id for the asker), OCS user / shares / `apppassword`, `status.php`, Login Flow v2. |
| Settings | `services/cloud-settings.ts` | address, on/off, start folder, record root, role → group mappings; audited; 10 s process cache (`getCached`, `peekCached`) so a record page costs nothing while the integration is off. |
| Accounts | `services/cloud-accounts.ts` | `beginLink` / `completeLink` / `cancelLink`, `sessionFor` (the state a person is in), `connect`, `withCloud` (records the outcome, marks a refused password as "link again"), `unlink`, `removeForDeactivation`. |
| Files | `services/cloud-files.ts` | `browse`, `entryAt`, `prepareUpload` + `sendToCloud` + `recordUpload`, `createFolder`, `ensureRecordFolder` (make, share with the mapped groups, link), `linkPath`, `unlinkFile`, `linksOfRecord`, `verifyLinks`, `recordsLinkedTo`, `entryForLink`, `recordDownload`. |
| Registry | `services/cloud-link-targets.ts` + `server/records/cloud-links.ts` | `registerCloudLinkTarget`, `targetOf`, `targetsFor(principal)`, `openRecord`, `findRecord`. 21 built-in kinds registered through `registerAllRecords()`. |
| Screens | `src/app/(app)/documents/…`, `src/app/(app)/administration/cloud-files/…` | see *Routes*. |
| Paperclip | `components/admin/record-cloud-files.tsx` (+ `attachments.tsx`, `record-attachments-door.tsx`) | the **QS Cloud Files** section under the ERP's own attachments. |

### Decision: how it sits with the paperclip

The attachment system is **not replaced**. A record's paperclip (door 2 of the
four: printer, paperclip, notes, clock) still lists the files the ERP stores.
Under them, in the same dialog, `Attachments` draws a second panel, **QS Cloud
Files**, with the cloud files *linked* to the record, a "Link a file from Cloud
Files" button (opens the Document Center in link mode), "Create the record's
folder", and an upload that lands in the record's cloud folder and is linked.
Door count and order are unchanged; `RecordAttachmentsDoor` adds the linked files
to the number on the clip. Reason: one place to look for "what is filed against
this record", and no second door to learn.

### How the two directions work

* **Document → record.** In the Document Center a file's row has *Link to record*
  (a kind and the number printed on the record). `files.linkPath` resolves the
  number as the person (`findRecord`), checks they may open it (`openRecord`),
  asks the cloud (as them) for the file's id, and inserts a `cloud_file_link`.
  The register's *Linked to* column shows each record with a link to its page.
* **Record → documents.** The paperclip's cloud panel lists the record's live
  links, each **verified against the cloud as the viewer**: a file the cloud does
  not show them is "Not available to you in Cloud Files" and its name is not
  given. A file shared to the person elsewhere is found by its id (`dav/meta`).
  "Link a file from Cloud Files" opens `/documents?linkTo=<kind>:<id>` where each
  row offers *Link to this record* and the way back is the record.

---

## 2. What was implemented

* Pure rules, secret box and a Nextcloud client (WebDAV, OCS, Login Flow v2).
* Per-user connection through Login Flow v2: start, open in Cloud Files, the page
  polls itself (`/documents/link/poll`) and has *Check now* and *Cancel*; link
  attempts expire; a refused password turns into "Link my account again" (and
  *Unlink* removes the stale link); *Unlink* revokes at the cloud and deletes the
  stored secret even when the cloud cannot be reached (and says so).
* Deactivating a user (`users.setActive`) revokes and deletes their app password.
* Integration settings screen: address (with *Test the address*), on/off, the
  folder the Document Center starts in, the record root, the role → group
  mappings (write / share rights; deactivated with a reason, never deleted).
* The Document Center (`/documents`): breadcrumbs, search, filter (kind /
  linked), sort, paging (50), real files and folders only, *Download*, *Preview*
  (only where the cloud has a preview), *Open in Cloud Files*, upload (progress,
  per-file failure, *Try again*; "uploaded" only after the cloud confirms the
  size), new folder (optionally shared with the mapped groups), link / unlink.
* Every state is a plain statement: **not configured** ("This integration is not
  configured" — with the way on only for someone who may configure it), **not
  linked** (link step), **waiting for approval**, **link again**, **unreachable**,
  **folder missing**, empty folder / empty root / no match.
* The record's paperclip section (above), folder per record
  (`<record root>/<kind>/<number>`), shared with the groups of the roles that may
  open that kind of record.
* The link-target registry with 21 kinds: purchase invoices, purchase orders,
  goods receipts, goods returns, supplier payments, supplier advances, payment
  applications, import applications (payables), B/Ls, containers, customs PDs,
  customs declarations, sales invoices, customer receipts, sales returns, bank
  loans, journal entries, employees, projects, customers, suppliers. **Tasks are
  not built yet**: the Task Center registers `task` itself (see *What next agents
  need*).

## 3. Data source

| What | Where it comes from |
|---|---|
| Files, folders, sizes, dates, rights, previews, downloads | **The cloud**, read live as the person (their app password). Nothing is cached or copied in Qimah; nothing is invented when the cloud is down — the page says it cannot be reached. |
| Who the person is in the cloud (login name, display name) | `ocs/v2.php/cloud/user` at link time; stored in `cloud_account`. |
| Whether a linked file is visible to the viewer | Asked of the cloud for every record view (`verifyLinks`). |
| Links, connection state, settings, mappings | Postgres (`cloud_file_link`, `cloud_account`, `cloud_link_attempt`, `cloud_setting`, `cloud_group_mapping`). |
| Storage numbers / activity | **Not shown.** The page draws no quota, "recent activity" or counts that the ERP cannot read from the cloud. |

## 4. Permissions

Three layers, all must agree:

1. **ERP permission.** Object `cloud_files`: `view` opens the screen and the
   record section, `create` uploads, makes folders and links. Object
   `cloud_setting`: `view` opens the settings, `configure` changes them.
   Denials go through `permit()` and are written durably.
2. **The record.** Linking, listing a record's links and making its folder
   require that the person may open the record (`openRecord`): the kind's
   `registerParentAccessCheck` where one is registered (the attachments rule),
   else `view` on the kind's object and a row visible under RLS (branch rule). An
   unregistered kind is refused. "Missing", "hidden" and "not yours" give one
   answer.
3. **The cloud.** Every WebDAV/OCS call is made with the person's own app
   password, so Nextcloud's own sharing and group membership decide what they see
   and write. A shared folder shows with the share's rights (read-only folders
   offer no upload).

Grants (migration 0322): `cloud_files` view/create are **copied from the
`attachment` grants** (whoever could use the paperclip keeps the Document
Center, nobody gains a power); `cloud_setting` view/configure go to the roles
that could `configure` attachments, to `ceo` and to `system_administrator`. In
the development database this means `cloud_files` view for accounting manager and
officer, CEO, customs, HR manager and officer, logistics, system administrator;
create for all of those but the CEO; `cloud_setting` for accounting manager, CEO
and system administrator. **`project_manager` has no `attachment` grant and so no
`cloud_files` grant** — see limitations.

Branch restrictions: link rows carry the record's `branch_code` and are read
under RLS through it; a person never sees a link to a record outside their
branch. The cloud side has no concept of ERP branches, so branch separation of
the *files* is by Nextcloud group (the mapping), not by ERP branch.

Request safety: `/documents/file` and `/documents/upload` check the session,
and `/documents/upload` and the poll also require the same-site header
(`src/server/same-site.ts`: `X-Requested-With: qimah-documents` and an Origin
matching the host). Downloads are `Content-Disposition: attachment`, `nosniff`,
`Content-Security-Policy: sandbox`; they are never rendered in the ERP's origin.
The app password never appears in a response, log, audit row or page.

## 5. Database changes

Three migrations, hand-authored, additive, appended after the journal's last
entry (`when` strictly greater, as the AGENTS.md rule requires):

| File | Journal `when` | What |
|---|---|---|
| `0320_cloud_files_core.sql` | 1795900000130 | `cloud_setting` (single row id 1: `enabled`, `base_url`, `root_path`, `record_root`, `updated_by/at`), `cloud_group_mapping` (PK `role_code`; `group_name`, `can_write`, `can_share`, `active`, `deactivated_reason`), `cloud_account` (PK `user_id`; `server_url`, `cloud_user`, `display_name`, **sealed** `secret`, `linked_at`, `last_ok_at`, `last_error`), `cloud_link_attempt` (PK `user_id`; sealed `poll_token`, `login_url`, `expires_at`). RLS enabled + forced on all four; `cloud_account` readable and deletable by its owner and by whoever administers users (to revoke on deactivation; the content is ciphertext bound to the owner). |
| `0321_cloud_file_links.sql` | 1795900000131 | `cloud_file_link` (server, cloud file id, object type + id, record label, branch, name/path as the linker saw them, `linked_by/at`, `unlinked_by/at/reason`). Unique live link per file and record; `cloud_file_link_guard` trigger: never deleted, what was linked cannot change, an ended link stays as it ended. RLS by the record's branch. |
| `0322_cloud_files_grants.sql` | 1795900000132 | the `cloud_files` and `cloud_setting` grants described above. |

Shared lists: `cloud_file_link` is in `scripts/ops/format-live-database.sh`
(`DOCUMENT_TABLES`, first) and `tests/integration/setup.ts` (`resetTestData`,
which also clears the other three tables and puts `cloud_setting` back to its
seed); the other three are *kept by a format* in `ops16-document-table-lists`.
Controls C-60 to C-62 in `docs/CONTROLS.md`.

Environment: `ERP_SECRET_KEY` (≥ 32 characters) must exist on the host before
Cloud Files can be switched on or anyone can link (`.env.example`,
`docs/RUNBOOK-host-build.md`). Without it the settings screen says so and
refuses to enable; the Document Center says "not configured".

## 6. Routes

| Route | What |
|---|---|
| `/documents` | the Document Center. Query: `path`, `q`, `kind`, `sort`, `dir`, `page`, `linkTo=<kind>:<id>` (link mode), `linkFile=<path>` (link step), `link=waiting\|expired\|revoke_failed` (notes). |
| `/documents/file` GET | `?path=` or `?link=<link id>` (+ `&preview=1`): streams one file as the person. 303 to `/documents` when the integration is off or the person is not linked, 404 for anything the cloud does not show them, 502 when the cloud is unreachable. A `link=` read also requires that the person may open the record. Audited (`cloud_file.downloaded` / `.previewed`). |
| `/documents/upload` POST | raw body, `?dir=&name=&record=<kind>:<id>`; requires `Content-Length`; first 4 KiB inspected by the attachments policy before any byte is sent; 200 MiB limit; never replaces; answers JSON `{ ok, … }` 201 only after the cloud has the bytes. |
| `/documents/link/poll` POST | the self-checking link page. A transient failure stays "pending"; any other error cancels the attempt and says why. |
| `/administration/cloud-files` | settings (copies the Numbering screen). Menu: Settings → after Numbering (`cloud_files_settings`). |

Server actions (`documents/actions.ts`): start / check / cancel link, unlink
account, new folder, link file, unlink file (reason), create record folder.
`/documents` was already a delivered route (it was the coming-soon page);
`page('document_centre','cloud_files','/documents')` and
`page('cloud_files_settings','cloud_setting','/administration/cloud-files')` are in
`domain/menu.ts`.

## 7. Shared files touched

Additive unless noted. All are small edits to files other agents may also touch;
conflicts should be resolved by keeping both sides.

* `src/server/db/migrations/meta/_journal.json` (3 entries, `when` …130–132) and
  `src/server/db/schema/index.ts` (one export).
* `src/server/domain/menu.ts`, `src/server/domain/screens.ts` (one page each, one
  delivered route).
* `messages/en.json`, `messages/ar.json`: new `cloudFiles` namespace; `page`
  (`cloud_files_settings`) and `audit_action` entries. 2-space JSON.
* `src/server/records/index.ts` (hooks the link targets into `registerAllRecords()`).
* `src/server/services/attachments.ts` (adds `mayAccessParent`, no change to what
  exists), `users.ts` (`setActive` revokes the cloud account on deactivation).
* `src/components/admin/attachments.tsx` (renders the cloud section; new optional
  `cloud` prop), `record-attachments-door.tsx` (count), `index.tsx` (`ListToolbar`
  accepts `hidden`).
* `tests/integration/setup.ts` (reset), `scripts/ops/format-live-database.sh`,
  `tests/integration/ops16-document-table-lists.test.ts` (3 + 1 kept tables),
  `tests/unit/screen-catalogue.test.ts` (pinned counts 248 → 249, 362 → 363, one
  delivered route).
* `docs/CONTROLS.md` (C-60 to C-62), `docs/notes/doors-coverage.md` (a section),
  `AGENTS.md` (one section appended), `.env.example`, `docs/RUNBOOK-host-build.md`,
  `deploy/nginx.example.conf` (a `location = /documents/upload`).
* `playwright.local.config.ts` is git-excluded and was not committed.

## 8. Targeted checks run

| Command | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx vitest run --project unit tests/unit/cloud-files-domain.test.ts` | 32 passed (paths and traversal, link rules, PROPFIND parsing, Login Flow state, secret box, listing helpers) |
| `npx vitest run --project integration tests/integration/document-center.test.ts` | 31 passed, against the Nextcloud stub: configure and refusals, connect (Login Flow), listing as the user, shared folders with share rights, upload confirmed only on 2xx and by size, no overwrite, share via group mapping, record folder, link both directions, permission refusals, unlink with reason, deactivation revoke, redirect never carries credentials, identifier injection |
| `npx vitest run --project unit` on `delivered-screens`, `fx1-menu`, `fx1-set-up-people-menu`, `fx5-hr-menu`, `hd18-no-raw-enum`, `hd19-client-messages`, `i18n-catalogue`, `screen-catalogue`, `ui-frameworks`, `im15-controls-register`, `im04-live-guard` | 124 passed after updating the pinned catalogue counts |
| `npx vitest run --project integration` on `hd05-rls-coverage`, `hd06-authz-coverage`, `hd07-business-today`, `ops16-document-table-lists`, `platform-attachments`, `pay03-purchase-attachments` | all passed after listing the three kept tables |
| `npx playwright test -c playwright.local.config.ts tests/e2e/document-center.spec.ts --workers=1 --project=chromium` | 6 passed (2.3 min) on the dev server against the stub |

Not run (outside the task's "targeted only"): the full integration suite,
`theme-readability` (no new CSS, colours or classes were added; it should be run
at merge as AGENTS.md asks), `ops15-inventory-ledger`.

Screenshots (desktop English 1280 and Arabic 390 px) are in
`/home/claude/shots/documents/`: `documents-not-configured`, `documents-not-linked`,
`documents-linked-empty`, `documents-listing`, `cloud-files-settings`,
`record-paperclip` (open), and the two screens copied for comparison,
`model-purchase-invoices` and `model-numbering`. No horizontal page scroll at
390 px (asserted in the spec).

## 9. Commits

| Hash | What |
|---|---|
| 09905aa | pure rules of QS Cloud Files and the secret box, with tests |
| 27eae5c | schema, cloud client, settings, accounts, link registry and file services |
| 9916c31 | Nextcloud stub, integration tests, deactivation revokes the app password |
| 2037693 | the screen, routes, settings and the record's paperclip section |
| 825c684 | refuse a non-https address on a live server |
| 6c800b6 | Playwright spec; unlink a stale link; ICU tag and upload label fixes; audit key not redacted |
| next | docs, controls (C-60 to C-62), catalogue counts, ops16 list, nginx, the cloud's current file name on a record — `git log -1` of the branch |

## 10. Remaining limitations

1. **Not run against a real Nextcloud.** First things to check on the host:
   (a) Login Flow v2 `poll` and the `loginName`/`appPassword` it returns;
   (b) the `dav/meta/{fileid}` lookup (`nc:meta-path-for-user`) used to find a
   linked file the person sees through a share — if the server version does not
   offer it, the link shows "Not available to you" for files seen only through
   shares (own files are unaffected);
   (c) `nc:has-preview` and `core/preview?fileId=` for previews;
   (d) OCS share creation for groups that exist (a mapping to a group that does
   not exist is reported, not hidden, as `unknown_group`);
   (e) `DELETE ocs/v2.php/core/apppassword` for revoke.
2. **Upload size.** The Document Center allows 200 MiB; nginx's global
   `client_max_body_size 26m` would refuse more with a 413. `deploy/nginx.example.conf`
   now has a `location = /documents/upload` (210 m, no request buffering, 15 min
   timeouts) — copy it to the live server. Uploads are one PUT (no chunking), so a
   dropped connection starts that file again; *Try again* is offered, and a
   partial file is never reported as uploaded (size is compared after the PUT).
3. **`project_manager`** holds no `cloud_files` grant because it holds no
   `attachment` grant; grant it in the roles screen if project managers should
   use the Document Center.
4. **A link is to a file or a folder by its cloud id.** If the file is renamed or
   moved in the cloud the link follows it and the record shows the cloud's
   current name; the name and path stored with the link stay as they were when it
   was made (the guard trigger would allow refreshing them for a live link; no code
   does yet; `verifyLinks` shows the cloud's current name). If the file is deleted in the cloud the link reads "Not available to
   you".
5. **Permissions in the cloud are not mirrored back.** Sharing a record's folder
   uses the role → group mapping at the time of creation; later changes to the
   mapping do not re-share old folders.
6. **A person with `app_user administer`** can read the encrypted `secret` of
   others' cloud accounts at the database (needed to revoke on deactivation). It
   is ciphertext bound to the owner and useless without `ERP_SECRET_KEY`.
7. **Paging is in memory** (the folder is listed with one PROPFIND depth 1, then
   filtered, sorted and paged). Very large folders (many thousands of entries)
   will be slow.
8. **Pages that pass a non-uuid id** for a uuid-keyed kind to `Attachments`
   simply show no cloud section. The 21 registered kinds were checked against the
   ids their pages use; the journal page (which renders `Attachments` directly)
   shows the section without adding to the clip's count.
9. **No profile-page panel.** Linking status and *Unlink* are on the Document
   Center page; a "Cloud Files" panel on the personal profile page was not added.
10. **Previews** are the cloud's own preview image for images and PDFs the cloud
    reports it can preview; Office files open in Cloud Files or download.
11. **The Dev "1 Issue" badge** in screenshots is the development overlay noting
    Playwright's `caret-color` style on inputs during capture (hydration notice),
    not a defect of the page.

## 11. What next agents need

* **Task Center (or any new record kind):** call
  `registerCloudLinkTarget({ type: 'task', object: 'task', folderName: 'Tasks', table, idColumn: 'id', idKind: 'uuid', labelColumn: 'task_no', branchColumn, href: (label) => '/tasks/' + label })`
  from your own records registration (not by editing `cloud-links.ts`), add
  `cloudFiles.record_task` to both message files, and render `Attachments` or
  `RecordAttachmentsDoor` for the record with the same `objectType`. If your
  kind has a `registerParentAccessCheck`, that is the access rule; otherwise
  `view` on `object` plus a visible row.
* **Chat / Global Search:** a cloud file is addressed by `{ serverUrl, fileId }`
  and opened through `/documents/file?link=<link id>` (inside a record) or
  `?path=` (inside the Document Center); never put the cloud's URL or a path
  that bypasses the ERP route in a message. Link rows are in
  `cloud_file_link` (`files.linksOfRecord`, `files.recordsLinkedTo`); search over
  *file names* is the cloud's, not the ERP's.
* **Stub for tests:** `startNextcloudStub()` in `tests/support/nextcloud-stub.ts`
  (`addUser`, `addToGroup`, `putFile`, `grant(loginUrl, uid)`, `failNext`,
  `keepOnlyOnNextPut`, `revokeAll`, `requests`). Integration tests set the
  address to `stub.url` through `settings.save`; loopback http is accepted only
  outside production.
* **Never** fetch the cloud from a component; call `accounts.sessionFor` +
  `accounts.withCloud` in a server component or action, and let the person's own
  cloud answer.
* **Docs:** AGENTS.md › *Document Center and QS Cloud Files*, `docs/CONTROLS.md`
  C-60 to C-62, `docs/notes/doors-coverage.md` (the paperclip section).
