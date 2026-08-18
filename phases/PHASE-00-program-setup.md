# Phase 00 — Program Setup & Decision Register

> **Blueprint:** §1, §2, §25 (Maintainability, support and operations), §28, Appendix E
> **Release (§27):** 1 — Foundation
> **Depends on:** —
> **Blocks:** everything

---

## Purpose

Stand up the machinery the programme runs on, and open the register of decisions the blueprint deliberately withholds from the implementation team. No business functionality is built in this phase.

The blueprint is explicit that the implementation team does not get to invent business outcomes (§28.2: *"The IT specialist shall not select a business or accounting outcome independently"*). That only works if there is a visible, tracked list of what has not yet been decided. This phase creates it.

## In scope

- Source control, branching, code review policy
- Development / test-UAT / production environments
- CI/CD pipeline skeleton and versioned database migration framework
- Test harness baseline (unit, integration, end-to-end, no tests yet)
- Requirement specification template (Appendix E) instantiated as a working artefact
- Decision register and change-request register
- RACI instantiated (Appendix E)

## Out of scope

- Any screen, entity or business rule
- Infrastructure sizing — blocked on **D5**

---

## Sub-phases

### 00.1 Source control and code review policy

**Build**
- Repository, branch protection, review requirement, commit conventions
- `CONTRIBUTING` covering the §28 rule: no functional, accounting, workflow, permission or report change lands without an approved change request

**Blueprint rules enforced**
- §28.1 — *"All functional, accounting, workflow, permission and report changes require written approval from Issa Mohammed"*
- §25 — *"Technical and business documentation is version-controlled and updated with each release"*

**Test gate**
- [ ] A push directly to the protected branch is rejected
- [ ] A merge without review is rejected
- [ ] The repository contains the blueprint PDF and this phase set under version control

---

### 00.2 Environments

**Build**
- Three isolated environments: development, test/UAT, production
- Controlled promotion path; production is not writable by hand
- Environment-specific configuration held outside code

**Blueprint rules enforced**
- §25 — *"separate development, test/UAT and production environments with controlled promotion; production changes are never made directly"*
- §25 — *"Configuration is separated from code and changes are audited"*

**Test gate**
- [ ] A configuration change in development does not affect test or production
- [ ] No credential or secret appears in the repository — automated scan passes
- [ ] Direct write access to production by an individual account is demonstrably absent

---

### 00.3 Migration framework

**Build**
- Versioned, ordered database migrations with a documented recovery path
- Migration runs in CI against a fresh database and against a restored copy

**Blueprint rules enforced**
- §25 — *"Database schema changes use versioned migrations with rollback or recovery plan and tested backup"*

**Test gate**
- [x] A clean database migrates to head with no manual step
- [x] A migration applied twice is a no-op, not an error
- [x] The documented recovery procedure is executed once and succeeds

---

### 00.4 CI/CD pipeline

**Build**
- Build, test, migrate, deploy stages
- Release artefact carries scope, migration notes, test evidence, rollback plan

**Blueprint rules enforced**
- §25 — *"Every release has scope, migration notes, test evidence, approvals and rollback plan"*

**Test gate**
- [ ] A failing test blocks deployment
- [ ] A deployment can be rolled back, exercised once end to end
- [ ] The release artefact contains all five required items

---

### 00.5 Test harness baseline

**Build**
- Unit, integration and end-to-end test scaffolding, each with one passing smoke test
- Coverage reporting wired into CI
- A reusable fixture pattern for "a posted document with its journal"

**Blueprint rules enforced**
- §25 — *"Automated unit, integration and end-to-end tests cover critical posting and permission paths"*
- §26 Testing layers table

**Test gate**
- [x] Each of the three layers runs in CI and reports independently
- [x] Coverage is measured and published per build

---

### 00.6 Requirement specification template

**Build**
- Appendix E's per-screen template as a fillable working artefact with all 16 fields: Requirement ID, business objective, actors and permissions, preconditions, screen/fields, workflow/status, validations, calculations, accounting event, inventory/operational event, integrations, attachments/evidence, notifications, reports/audit, exceptions, acceptance criteria, out of scope
- Requirement IDs are stable and link to release, module and test case

**Blueprint rules enforced**
- Appendix E — *"Detailed requirement template for each screen/process"*
- §27.1 — as-built documentation is part of release completion

**Test gate**
- [x] One real screen is specified end to end using the template as proof it is workable
- [x] Requirement ID → test case linkage is demonstrated for that screen

---

### 00.7 Decision register

**Build**
- A tracked register of every decision the blueprint withholds, seeded with D1–D9 from [`../PHASES.md`](../PHASES.md)
- Each entry: decision, blueprint reference, phase blocked, owner, options documented, status, date decided
- Change-request register using the Appendix E change-request template

**Blueprint rules enforced**
- §28.2 — *"the IT specialist shall document the issue and available technical options. Issa Mohammed selects and approves the final business treatment"*
- §28.1 — every change records current behaviour, required behaviour, affected modules, accounting impact, data impact, security impact, test cases, effective release

**Test gate**
- [x] D1–D10 are present with owner and blocked phase recorded
- [x] D7 (Chart of Accounts) is flagged as blocking Phase 02
- [ ] The register is visible to the Business Process Owner without needing the development team

---

### 00.8 RACI and governance activation

**Build**
- Appendix E RACI instantiated with named people
- Escalation path and clarification-request route agreed

**Blueprint rules enforced**
- Page 1 execution rule — Issa Mohammed is sole Business Process Owner and final authority
- §5.5 — *"The IT specialist has no authority to change business processes, accounting logic, workflow rules or permission policy without written approval"*

**Test gate**
- [ ] Every row of the Appendix E RACI table has a named person
- [ ] One clarification request is raised and resolved through the agreed route as a dry run

---

## Phase exit gate

| # | Criterion | Evidence |
|---|---|---|
| 1 | Three environments exist with controlled promotion | Deployment log showing dev → test → prod path |
| 2 | A change cannot reach production without review and passing tests | Blocked-merge and blocked-deploy demonstrations |
| 3 | Migrations run clean and the recovery path has been executed | CI log + recovery run record |
| 4 | All three test layers report in CI | Build output |
| 5 | The requirement template is proven on one real screen | Completed specification |
| 6 | D1–D9 are registered with owners | Decision register |
| 7 | RACI is populated and the clarification route works | Signed RACI + dry-run record |

**Sign-off:** Business Process Owner acknowledges the decision register, in particular that **D7 (Chart of Accounts) blocks Phase 02**.

---

## Notes for the team

The temptation in this phase is to skip the decision register and start building, resolving ambiguity as it appears. The blueprint forecloses that: §28.3 says gaps found in testing are handled through *controlled later releases*, and §28 opens with *"The development team shall not convert them into configurable alternatives unless the blueprint explicitly defines configuration."* A decision made quietly in code during Phase 11 is a change-control breach, not a shortcut.

### Fixed 2026-08-17 — the integration suite had got slow

`resetTestData` runs before **every** test, and by the end of Phase 05 it issues
roughly fifty statements — of which about sixteen are `ALTER TABLE … DISABLE /
ENABLE TRIGGER` pairs, each taking an ACCESS EXCLUSIVE lock and invalidating
cached query plans. With 800-odd integration tests the reset now costs more than
the assertions do: a full run went from about ten minutes at the end of Phase 04
to over thirty by 05.7, and it grows with every document type added.

**It is a real cost, not a cosmetic one.** A suite slow enough to avoid running
is a suite that stops catching things, and there are sixteen phases still to
build.

**The fix.** Every `ALTER TABLE … DISABLE TRIGGER` pair — thirty-six of them,
seventy-two statements — replaced by a single `SET session_replication_role =
replica` for the length of the reset. That is what a logical-replication apply
worker runs as: user triggers and foreign-key triggers do not fire. No DDL, no
locks, no plan invalidation.

Two details that matter:

- **It is a session setting**, so the whole reset now runs on one checked-out
  client rather than on whichever of the pool's four connections comes to hand.
- **It is restored in a `finally`.** A connection handed back to the pool still
  in `replica` would silently disable every guard for whatever ran next, which
  is the one failure mode here worth being careful about.

The reset was already lifting these guards one table at a time, so **nothing
about what is proved changed** — each guard is asserted in its own test, as
before. What changed is how expensively it is proved. Verified by dropping the
test database and running the full suite from scratch, so the migrations, the
reset and every phase gate were all exercised against it.
