# Change Request Template

**Phase 00.7** · Blueprint §28.1 and Appendix E

> "All functional, accounting, workflow, permission and report changes require written approval from Issa Mohammed."
> "A change is not complete until documentation, automated tests, UAT evidence and training material are updated."

Copy to `docs/changes/CR-<nnn>.md`.

---

## CR-**<nnn>** — **<title>**

| | |
|---|---|
| **Change ID** | `CR-<nnn>` |
| **Requested by** | |
| **Request date** | |
| **Status** | Raised / Under analysis / Approved / Rejected / Deferred / Implemented |
| **Target release** | 1–10 per §27 |

---

### Reason and benefit

*Regulatory, control, operational, defect or improvement rationale.*

Which is it? — [ ] Regulatory  [ ] Control  [ ] Operational  [ ] Defect  [ ] Improvement

### Current process

*What the system does today, and where it is specified (blueprint section, requirement ID).*

### Required process

*What it must do instead. Specific enough to implement without further interpretation.*

### Impact assessment

| Area | Impact |
|---|---|
| Modules | |
| Interfaces | |
| Migration | |
| Security | |
| Data | |
| Training | |
| Timeline | |
| Cost | |

### Accounting and control review

*Posting, reconciliation, approval and audit consequences.*

- Does this change any posting in Appendix C? If so, which rows?
- Does it change a subledger-to-G/L reconciliation?
- Does it change an approval requirement or a permission?
- Does it affect an existing audit trail or reversal linkage?
- Does it invalidate any already-passed phase gate? Which?

> A change with accounting impact requires Finance review **in addition to** Business Process Owner approval.

### Decision

| | |
|---|---|
| **Decision** | Approve / Reject / Defer / Request more analysis |
| **Approver** | |
| **Date** | |
| **Rationale** | |

### Implementation evidence

§28.1 — the change is not complete until all five are done:

- [ ] **Requirements** updated — requirement ID(s): `______`
- [ ] **Code / release** — commit or PR: `______`
- [ ] **Test cases** added or updated: `______`
- [ ] **UAT evidence** recorded: `______`
- [ ] **Documentation and training material** updated: `______`

### Phase gates to re-run

*Which gates in `phases/` must be re-executed because of this change.*

| Phase | Sub-phase | Gate | Re-run status |
|---|---|---|---|
| | | | |

---

## When a change request is required

| Change | CR needed? |
|---|---|
| Business rule, accounting treatment, workflow, permission, report | **Yes** — §28.1 |
| Adding a configurable alternative the blueprint did not define | **Yes** — §28: *"The development team shall not convert them into configurable alternatives unless the blueprint explicitly defines configuration"* |
| Screen grouping or layout, with no change to function, permission, status or posting | No — Appendix A permits refinement for usability |
| Bug fix restoring specified behaviour | No — but record the defect and the test that now covers it |
| Technical implementation choice with no business effect | No — but if it constrains a business requirement, raise it under §28.2 in [`DECISIONS.md`](DECISIONS.md) |
