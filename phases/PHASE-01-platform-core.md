# Phase 01 — Platform Core

> **Blueprint:** §3.4, §5, §21 (engine parts), §24, §25 (security, usability), Appendix A, Appendix B
> **Release (§27):** 1 — Foundation
> **Acceptance dependency (§27):** *"Authentication, server-side access and audit tests pass."*
> **Depends on:** 00
> **Blocks:** everything

---

## Purpose

Build the shared services every module calls. §24 makes this mandatory, not optional:

> "Module developers shall call shared services for numbering, currency, workflow, posting, attachments and audit logging. Duplicating these mechanisms inside each module will create inconsistent controls and expensive maintenance."

This is the largest and highest-risk phase. Every shortcut taken here is repaid twenty times across the module phases.

## In scope

Identity, authorisation, audit, document numbering, the status machine, the approval workflow engine, attachments, notifications, background jobs, the import framework, and the UI shell with its list and record frameworks.

## Out of scope

- The posting engine and anything accounting — Phase 02
- Business entities of any kind — Phase 03 onward
- Document Centre user interface — Phase 17 (the storage service is built here)

---

## Sub-phases

### 01.1 Identity and authentication

**Build**
- User accounts, credential storage, session lifecycle
- Strong password policy, temporary-password setup flow, forced change
- Multi-factor authentication for privileged and high-risk roles
- Session expiry and immediate revocation
- Super User account type retaining full administration access (§5.1)

**Blueprint rules enforced**
- §25 — *"strong password policy, temporary-password setup, multi-factor authentication for privileged and high-risk roles, session expiry and immediate revocation"*
- §5.1 — *"Super Users retain full administration access"*

**Test gate**
- [x] A password below policy is rejected at set time, not only at signup
- [x] A privileged role cannot complete sign-in without the second factor
- [x] Revoking a session terminates access on the **next request**, not at token expiry
- [x] Credentials are not recoverable from the database in plaintext or reversible form
- [x] No password, token or key appears in any application log

---

### 01.2 Authorisation — permissions and data scope

**Build**
- The 13 permission verbs from §5.3: View, Create, Edit Draft, Submit, Approve, Execute, Post, Reverse/Cancel, Print, Export, Import, Configure, Administer
- Roles composed of verb × object grants
- Department and branch data scope per user (§5.1)
- Enforcement in the shared data-access layer, applied to every query
- Deny-by-default: absence of a grant is denial

**Blueprint rules enforced**
- §25 — *"deny-by-default, server-side authorisation for every page, API and record. Navigation hiding alone is not access control"*
- §5.1 — *"Operational access shall be granted by screen and action rather than by menu visibility alone"*
- §5.3 — *"Department access and approval authority are separate settings"*
- §22 — *"Row-level security is enforced in the query layer, not only hidden in the screen"*

**Test gate**
- [x] A user without `View` on an object receives denial on the **direct URL**, not merely a hidden menu item
- [x] The same denial occurs on the API for the same user and object
- [x] A user scoped to Branch A cannot read a Branch B record by ID
- [x] Removing every grant from a role denies everything — no implicit allow anywhere
- [x] Granting `View` does not confer `Export`; granting `Approve` does not confer `Post`
- [x] A newly added object with no grants defined is inaccessible to all non-Super-Users by default

---

### 01.3 Department Manager model

**Build**
- Department Manager toggle on the user record, **per assigned department** (§5.2)
- Resolution rule: a Department Manager creating a document in that department finalises directly; a non-manager submits to the assigned Department Manager
- A user may be manager in one department and an ordinary user in another

**Blueprint rules enforced**
- §5.2 — all five bullets, verbatim behaviour
- §5.2 — *"Manager approval shall automatically execute the operational, inventory and accounting effects assigned to the document type"*

**Test gate**
- [x] User X, manager of Finance and ordinary user in Sales, finalises a Finance document directly and must submit a Sales document
- [x] A non-manager's document routes to the Department Manager of the document's department, not the creator's default department
- [x] Manager approval triggers the document type's configured execution effects in the same transaction
- [x] The toggle is per-department — setting it for one department does not set it for another

---

### 01.4 Audit trail engine

**Build**
- Append-only audit event store
- Captured per §5.4: user, date and time, action, section, record, before and after values, approval decision, reason, source device/session where available, links to original and reversing documents
- Written inside the same transaction as the change it records
- No application path to edit or delete an audit entry

**Blueprint rules enforced**
- §5.4 — *"Audit entries cannot be edited or deleted by application users"*
- §24 — *"Append-only; protected from normal user alteration"* (Appendix B, Audit Event)
- §25 — security events recorded: authentication, authorisation failures, privilege changes, exports, configuration changes, sensitive-data access

**Test gate**
- [x] Every create, update and status transition produces an audit event with before/after values
- [x] The application database role holds no `UPDATE` or `DELETE` privilege on the audit table
- [x] A rolled-back business transaction leaves **no** audit event — audit and change commit together or not at all
- [x] An authorisation failure is recorded with actor, target and outcome
- [x] An export is recorded with actor, filters and row count
- [x] Audit entries contain no password, token or full sensitive document content

---

### 01.5 Document numbering and sequences

**Build**
- Sequence definitions per §4.3: prefix, year/branch pattern, next number, reset rules, document type
- Transactional allocation — a number is never issued twice
- Gap reporting (§24 requires *"duplicate source references and sequence gaps"* as a report)

**Blueprint rules enforced**
- §3.4 — *"Unique document numbering"*
- §14.2 — *"Journal Entry Number — Generated automatically and never reused"*
- §24 — sequence gap reporting

**Test gate**
- [x] 1,000 concurrent allocations against one sequence produce 1,000 distinct numbers with no duplicate
- [x] A rolled-back document leaves a recorded, reportable gap rather than silently reusing the number
- [x] Branch and year patterns resolve correctly across a year boundary
- [x] A number, once issued, cannot be reissued by any code path

---

### 01.6 Document status machine

**Build**
- The common status model from §24: Draft, Submitted, Approved, Partially Executed, Executed/Received/Delivered, Posted, Settled, Rejected, Cancelled, Reversed, Closed
- Per-document-type transition allow-list — §3.2: *"Each document type shall use only the states applicable to its operational and accounting effect"*
- Editing rules per status, from the §24 status table
- Server-side transition validation shared by UI and API

**Blueprint rules enforced**
- §24 — *"Document status transitions are allow-listed and checked server-side"*
- §24 acceptance — *"Invalid status transitions are rejected from both UI and API"*
- §3.2 — *"A saved draft cannot be deleted; it may be edited or cancelled"*; *"A final operational or accounting document cannot be edited or deleted"*

**Test gate**
- [x] An unlisted transition is rejected from the UI **and** from the API with the same result
- [x] A saved draft cannot be deleted by any path; it can be edited or cancelled
- [x] A Posted document rejects every edit and every delete
- [x] Cancelling requires a reason and the reason is stored
- [x] Each document type exposes only the statuses configured for it

---

### 01.7 Approval workflow engine

**Build**
- Workflow definitions versioned per document type
- Steps, actors, decisions, timestamps, delegation
- Submit, approve, reject with reason, recall where allowed
- Self-approval prohibition where configured
- Escalation timers

**Blueprint rules enforced**
- Appendix B, Workflow Instance — *"No self-approval where prohibited; complete decision history"*
- §24 — *"Submission freezes controlled fields and starts the approval workflow"*
- §24 — *"approval itself does not automatically mean accounting posting unless configured"*

**Test gate**
- [x] Submission freezes the fields marked controlled; uncontrolled fields remain editable where the status allows
- [x] A user cannot approve their own document where the definition prohibits it
- [x] Rejection requires a reason and returns the document to Draft as a new revision
- [x] Delegation records both the delegate and the original actor
- [x] The full decision history survives — approve, reject, recall and delegate are all retrievable
- [x] Changing a workflow definition does not alter the recorded history of in-flight or completed instances

---

### 01.8 Attachment service

**Build**
- Upload pipeline: file-type validation, size limit, malware scan, required metadata, permission check
- Immutable object identifier, content hash, versioning — later versions never overwrite earlier ones
- Access inheritance from the parent record
- Retention metadata and legal-hold flag

**Blueprint rules enforced**
- §21 — *"stored using an immutable object identifier and linked to the parent record; later versions do not overwrite prior versions"*
- §21 — *"No executable file types shall be accepted unless explicitly authorised and technically isolated"*
- §21 — *"Attachments inherit the confidentiality and access policy of the parent record"*
- §21 acceptance — *"Users cannot access an attachment when they cannot access its parent record"*

**Test gate**
- [x] Uploading a second version preserves the first and both remain retrievable
- [x] A user denied access to the parent record cannot fetch the attachment by object ID or by direct URL
- [x] An executable is rejected on **content inspection**, not file extension
- [x] A file failing malware scan is quarantined and never linked to the parent
- [x] Every upload, download and replacement is in the audit trail

*Document Centre search, checklists and expiry reminders are Phase 17. This sub-phase delivers the service they call.*

---

### 01.9 Notification engine

**Build**
- Event-driven notification generation with rule configuration
- Channels: in-app inbox, e-mail
- Duplicate suppression, delivery status recording, escalation on inaction

**Blueprint rules enforced**
- §21 — *"Notification rules must suppress duplicates, record delivery status and allow escalation if a task is not acted upon"*
- §21 — *"System notifications are not a substitute for workflow status. A missed e-mail must never change the underlying approval requirement"*
- §21 acceptance — *"Notifications are generated once per qualifying event and escalation works according to configured time limits"*

**Test gate**
- [x] One qualifying event generates exactly one notification, verified under retry and duplicate event delivery
- [x] Delivery failure is recorded and visible, and does not alter the document's approval state
- [x] Escalation fires at the configured interval when a task is not acted upon
- [x] Suppressing notifications entirely leaves every approval requirement intact

---

### 01.10 Background job scheduler

**Build**
- Durable scheduled and queued jobs surviving restart
- Retry policy with dead-letter queue, ownership and alerting
- Job status visibility and a "stuck beyond target time" report

**Blueprint rules enforced**
- §24 — *"Background jobs and scheduler"*; *"Documents stuck in a status beyond target time"* report
- §24 — *"The posting engine emits events after commit so downstream notifications cannot cause partial financial posting"*
- §25 — *"Support tools may inspect status and retry safe jobs but may not edit posted financial data"*

**Test gate**
- [x] A scheduled job survives an application restart and still runs
- [x] A failing job retries per policy then lands in the dead-letter queue with an owner and an alert
- [x] A dead-lettered job can be replayed without editing data by hand
- [x] Support tooling can retry a job but cannot modify a posted record — verified by attempting it

---

### 01.11 Import framework

**Build**
- Validation preview, error file, import batch ID, rollback before final posting
- Source ID retained on every imported row

**Blueprint rules enforced**
- §4.4 — *"Bulk import requires validation preview, error file, import batch ID and rollback before final posting"*
- §3.4 — *"Controlled data import with validation and error reporting"*

**Test gate**
- [x] A file with mixed valid and invalid rows produces a preview and a downloadable error file, and commits nothing
- [x] An import batch can be rolled back completely before final posting
- [x] Every imported row carries its batch ID and source ID
- [x] Import respects the same permissions and validations as manual entry

---

### 01.12 UI shell, list and record frameworks

**Build**
- Navigation implementing the Appendix A menu tree at functional level
- **List framework:** permission-controlled search, filters, sorting, saved views, export
- **Record framework:** status, owner, branch, dates, source, approvals, related documents, journal entries, audit timeline
- Action enablement driven by current status **and** permission
- Draft documents visually distinct from final
- Internationalisation from the first screen: message catalogue, logical CSS properties, explicit number/date/currency formatting

**Blueprint rules enforced**
- Appendix A "Global user-interface rules" — all four bullets
- §25 — *"Consistent navigation, terminology, status colours, action placement and keyboard behaviour across modules"*
- §25 — *"localisation architecture shall allow Arabic labels and right-to-left layout later without redesign"*
- §25 — *"Validation messages identify the field, reason and corrective action; no generic 'something went wrong' for business errors"*

**Test gate**
- [x] Every list supports search, filter, sort, saved views and export, and each respects permission and data scope
- [x] Export returns exactly the rows the on-screen list would return for that user — no more
- [x] Every record page shows status, owner, branch, dates, source, approvals, related documents and audit timeline
- [x] An action invalid for the current status is disabled **and** rejected server-side if invoked directly
- [x] Draft documents are unmistakably distinct from final documents
- [x] No user-facing string is hardcoded — the catalogue is the single source
- [x] Flipping the layout to RTL produces a usable screen with no code change
- [x] A business validation failure names the field, the reason and the corrective action

---

## Phase exit gate

The §27 Release 1 acceptance dependency is *"Authentication, server-side access and audit tests pass."*

| # | Criterion | Evidence |
|---|---|---|
| 1 | Authentication, MFA and revocation work as specified | 01.1 gate |
| 2 | Authorisation denies by default and is enforced server-side on UI and API | 01.2 gate — the security test in §25 acceptance criterion 1 |
| 3 | Department Manager routing behaves per §5.2 in all four combinations | 01.3 gate |
| 4 | Audit is complete, append-only and transactional | 01.4 gate |
| 5 | Numbering is unique and gap-reportable under concurrency | 01.5 gate |
| 6 | Status transitions are allow-listed and rejected identically on UI and API | 01.6 gate |
| 7 | Workflow records complete decision history and prohibits self-approval | 01.7 gate |
| 8 | Attachments are immutable, versioned and access-inherited | 01.8 gate |
| 9 | Notifications are exactly-once with escalation, and never alter approval state | 01.9 gate |
| 10 | Jobs are durable, retryable and dead-lettered | 01.10 gate |
| 11 | Import previews, reports errors and rolls back | 01.11 gate |
| 12 | Shell, list and record frameworks meet the Appendix A global UI rules | 01.12 gate |

**Sign-off:** Business Process Owner accepts the permission catalogue and the Department Manager behaviour. These two shape every subsequent module.

---

## Notes for the team

Three failure modes to guard against in this phase:

1. **Authorisation implemented per screen.** It must live in the shared data-access layer. If a module can write a query that bypasses scope filtering, §25's deny-by-default requirement is not met, and it will not be caught until the penetration test in Phase 20.
2. **Audit written after the fact.** If the audit event is written in a separate transaction, a rolled-back change can leave a phantom audit entry, or a committed change can leave no entry. Both break §5.4.
3. **The status machine reimplemented per module.** §24 exists specifically to prevent this. One engine, configured per document type from the Appendix B catalogue.
