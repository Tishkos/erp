# Phase 17 — Document Management, Notifications & Collaboration

> **Blueprint:** §21
> **Release (§27):** 10 — Reporting and Go-Live
> **Depends on:** 01 (attachment and notification services)
> **Blocks:** —

---

## Purpose

§21: the supporting evidence, task routing and communication layer for every transactional module.

> **Design boundary (§21):** "The module records business evidence and collaboration around ERP transactions. It is not intended to replace a full enterprise content-management platform unless that scope is approved separately."
> §21: "It must not become an uncontrolled file store; attachments, versions, approvals and retention must remain linked to a business record."

The engine was built in Phase 01.8 and 01.9. This phase builds the user-facing layer and the governance around it.

---

## Sub-phases

### 17.1 Document Centre

**Build** — search by module, document number, business partner, project, date, document type and tag

**Blueprint rules enforced**
- §21 acceptance criterion 5 — *"Document searches return only records allowed by the user's role and data scope"*

**Test gate**
- [ ] All seven search dimensions work and can be combined
- [ ] Search returns only documents whose parent record the user can access
- [ ] A user cannot discover the existence of an unauthorised document through search result counts
- [ ] Search performance is acceptable against a realistic document volume

---

### 17.2 Attachment panel

**Build** — attachment panel embedded in **every** master and transaction record

**Test gate**
- [ ] Every master and transaction record exposes the panel
- [ ] Access inherits from the parent record, verified per Phase 01.8
- [ ] Uploading from the panel applies the same validation as the Document Centre

---

### 17.3 Document types and checklists

**Build**
- Document types per §21: contract, purchase order, delivery note, invoice, bank advice, customs document, KYC document, warranty certificate, technical drawing, approval memo
- Checklists that may require an attachment before submission, approval, posting or settlement

**Blueprint rules enforced**
- §21 acceptance criterion 1 — *"A configured document checklist can block workflow submission until all required evidence is attached"*

**Test gate**
- [ ] A checklist blocks submission when required evidence is missing
- [ ] The same checklist can block at approval, posting or settlement, configurable per document type
- [ ] Removing a required attachment after submission raises the exception rather than silently allowing progress
- [ ] Checklist configuration requires Configure permission, not ordinary transaction permission

---

### 17.4 Versioning, retention and legal hold

**Build**
- Version history, check-in/check-out where editing is permitted
- Expiry date and renewal owner
- Retention periods and legal-hold administration, configurable rather than hardcoded

**Blueprint rules enforced**
- §21 — *"Financial evidence attached to a posted transaction is immutable; replacement creates a new version with reason and approver"*
- §21 acceptance criterion 3 — *"Replacing a posted document preserves the original and records reason, user, date and approval"*
- §21 — *"Retention periods, legal holds and confidentiality classifications are configurable rather than hard-coded"*
- §21 — *"At the end of the retention period, authorised administrators may archive or dispose of the document according to company policy; transactional history remains intact"*

**Test gate**
- [ ] Replacing evidence on a posted transaction preserves the original and records reason, user, date and approval
- [ ] A document under legal hold cannot be disposed of by any path, including retention expiry
- [ ] Disposal at retention end leaves the transactional history intact
- [ ] Retention and classification are configuration, changeable without a code release
- [ ] Check-out prevents concurrent editing and check-in creates a new version

---

### 17.5 Tasks, notes and mentions

**Build** — internal notes, @mentions, assignments, due dates, completion status

**Test gate**
- [ ] A mention notifies the mentioned user through the Phase 01.9 engine
- [ ] A task carries owner, due date, process and priority and appears in the open-tasks report
- [ ] Notes inherit the parent record's access policy
- [ ] Completing a task is audited

---

### 17.6 Notification centre

**Build** — approvals, exceptions, expiries, overdue tasks, low stock, failed integrations, period-close tasks

**Blueprint rules enforced**
- §21 — *"System notifications are not a substitute for workflow status. A missed e-mail must never change the underlying approval requirement"*
- §21 acceptance criterion 4 — *"Notifications are generated once per qualifying event and escalation works according to configured time limits"*

**Test gate**
- [ ] All seven notification categories generate correctly
- [ ] Exactly one notification per qualifying event, verified under duplicate event delivery
- [ ] Escalation fires at the configured limit
- [ ] Disabling all notifications leaves every approval requirement and document status unchanged
- [ ] Delivery failure is recorded and reported, and does not alter workflow state

---

### 17.7 Templates and outbound correspondence

**Build** — order, invoice, statement, transfer confirmation, approval notification templates

**Blueprint rules enforced**
- §21 — *"Generated PDFs must retain a reference to the source transaction and template version"*

**Test gate**
- [ ] Every generated document carries its source transaction reference and template version
- [ ] Regenerating an old document uses the template version valid at the time, or clearly marks that it does not
- [ ] Generated documents attach to the source record automatically

---

### 17.8 External sharing

**Build** — expiring links, named recipients, download logging

**Blueprint rules enforced**
- §21 — *"External sharing must use expiring links, named recipients and download logging; public anonymous links are prohibited by default"*
- §21 — *"Every upload, download, replacement, external share, expiry-date change and deletion request is logged"*

**Test gate**
- [ ] A share link expires at the configured time and then returns denial
- [ ] A link is bound to named recipients and rejects others
- [ ] No configuration produces a public anonymous link by default
- [ ] Every share and every download is logged with actor, recipient and timestamp

---

### 17.9 Document reports

**Build** — per §21: missing mandatory documents by process or status; documents approaching expiry and overdue renewals; uploads/downloads by user and sensitive-document access; notification delivery, failure and escalation statistics; open tasks by owner, due date, process and priority.

**Test gate**
- [ ] Missing-document report matches what the checklists would block
- [ ] Sensitive-document access report is itself permission-restricted
- [ ] Notification statistics reconcile to the Phase 01.9 delivery records
- [ ] Reports respect data scope

---

## Phase exit gate

§21 minimum acceptance criteria, verbatim:

| # | Criterion | Evidence |
|---|---|---|
| 1 | A configured document checklist can block workflow submission until all required evidence is attached | 17.3 gate |
| 2 | Users cannot access an attachment when they cannot access its parent record | 17.2 gate, Phase 01.8 |
| 3 | Replacing a posted document preserves the original and records reason, user, date and approval | 17.4 gate |
| 4 | Notifications are generated once per qualifying event and escalation works according to configured time limits | 17.6 gate |
| 5 | Document searches return only records allowed by the user's role and data scope | 17.1 gate |

**Sign-off:** Business Process Owner, with the §21 design boundary explicitly acknowledged — this is not an enterprise content-management platform.

---

## Notes for the team

The §21 warning is worth repeating: *"It must not become an uncontrolled file store."* The pressure to add generic folders, free-form uploads and a shared drive will come from users within weeks of go-live. Every document lives against a business record. A file with no parent has no access policy, no retention rule and no audit context — which is precisely the state §21 is written to prevent.
