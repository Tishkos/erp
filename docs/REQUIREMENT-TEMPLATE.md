# Requirement Specification Template

**Phase 00.6** · Blueprint Appendix E, "Detailed requirement template for each screen/process"

Every screen and every process gets one of these before it is built. Copy this file to `docs/requirements/REQ-<id>.md`.

Sixteen fields. All sixteen are required — "not applicable" is an acceptable answer, silence is not.

---

## REQ-**<id>** — **<screen or process name>**

| | |
|---|---|
| **Requirement ID** | `REQ-<module>-<nnn>` — stable, never reused |
| **Release** | 1–10 per §27 |
| **Phase** | e.g. `06.5` |
| **Blueprint section** | e.g. `§7.4` |
| **Test case(s)** | file path and test name |
| **Status** | Draft / Approved / Built / Accepted |
| **Approved by** | Business Process Owner, with date |

---

### 1. Business objective

*The problem solved, the value, and the process owner.*

### 2. Actors and permissions

*Who creates, views, edits, submits, approves, executes, posts, reverses, exports and administers.*

Use the §5.3 verbs. All thirteen: View, Create, Edit Draft, Submit, Approve, Execute, Post, Reverse/Cancel, Print, Export, Import, Configure, Administer.

| Verb | Role(s) | Data scope | Notes |
|---|---|---|---|
| View | | | |
| Create | | | |
| … | | | |

State explicitly whether a Department Manager (§5.2) finalises directly on this document.

### 3. Preconditions

*Required master data, prior documents, balances, period status and attachments.*

### 4. Screen and fields

| Field | Type | Length / precision | Mandatory | Default | Source | Allowed values | Editable when | Help text |
|---|---|---|---|---|---|---|---|---|
| | | | | | | | | |

Money fields carry the four-part tuple (§24) — record the transaction currency field, the IQD field, the USD reporting field and the rate reference, not a single amount.

### 5. Workflow and status

*Allowed transitions, actor, approval role, timers, rejection/recall/delegation, lock behaviour.*

| From | To | Actor | Condition | Fields locked on entry |
|---|---|---|---|---|
| | | | | |

Only statuses applicable to this document's operational and accounting effect (§3.2). Reference the Appendix B catalogue entry.

### 6. Validations

*Field, cross-field, duplicate, limit, credit/budget/stock, currency, date and compliance rules.*

| # | Rule | Trigger | Message | Blueprint ref |
|---|---|---|---|---|
| | | | | |

Validation messages identify the field, the reason and the corrective action (§25). No generic failures.

### 7. Calculations

*Formula, rounding, currency, quantity/UOM, tax/charge, cost and total logic.*

State the rounding rule explicitly. A reviewer must be able to reproduce every figure by hand.

### 8. Accounting event

*Trigger, debit/credit rules, control accounts, dimensions, FX and reversal.*

| Event | Debit | Credit | Control rule | Appendix C row |
|---|---|---|---|---|
| | | | | |

Account **names** only — never codes. Codes are resolved through Accounting Mapping (Appendix C, §3.3).

Required dimensions per §4.2. Reversal behaviour per §3.2.

### 9. Inventory and operational event

*Quantity/value movement, reservations, in-transit, project/logistics impact.*

### 10. Integrations

*Inbound/outbound data, API/file/event, ownership, idempotency and error handling.*

The API enforces identical permissions and validations to the UI (§23). One code path — record where it lives in `src/server/domain`.

### 11. Attachments and evidence

*Required document types, checklist, version, retention and confidentiality.*

Whether a checklist blocks submission, approval, posting or settlement (§21).

### 12. Notifications

*Event, recipient, channel, escalation and suppression.*

Notifications never substitute for workflow status (§21).

### 13. Reports and audit

*Reports affected, drill-down, audit events and control reconciliation.*

### 14. Exceptions

*Partial processing, over/under tolerance, cancellation, return, correction, failure and recovery.*

### 15. Acceptance criteria

*Given/when/then scenarios, expected balances and statuses, security and performance evidence.*

```
Given  <precondition>
When   <action>
Then   <expected result, including exact balances and statuses>
```

Each maps to a named automated test. A criterion with no test is not a criterion.

### 16. Out of scope

*Explicitly excluded behaviour, to prevent assumption.*

State what this screen deliberately does **not** do. §8.2's exclusion of Purchase Requisition, RFQ and Quotation Comparison is the model: excluded, not deferred.

---

## Review checklist

- [ ] All sixteen sections completed
- [ ] Every field in §4 has precision and mandatory rule
- [ ] Every §8 account is a name, not a code
- [ ] Every §15 criterion maps to a named test
- [ ] §16 states exclusions explicitly
- [ ] Approved in writing by the Business Process Owner (§28.1)
