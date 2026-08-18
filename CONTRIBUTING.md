# Contributing

**Phase 00.1** · Blueprint §28

---

## The rule that governs everything

From page 1 of the blueprint:

> No business rule, accounting rule, workflow or permission rule may be changed without written approval from Issa Mohammed.

And §28:

> Approved business rules in this blueprint are implementation requirements. The development team shall **not** convert them into configurable alternatives unless the blueprint explicitly defines configuration.

If a change touches a business rule, accounting treatment, workflow, permission or report, it needs an approved change request before the code is written — see [`docs/CHANGE-REQUEST-TEMPLATE.md`](docs/CHANGE-REQUEST-TEMPLATE.md).

If you find an ambiguity or a technical constraint, document the issue and the options in [`docs/DECISIONS.md`](docs/DECISIONS.md) and raise it. Do not resolve it in code. §28.2:

> The IT specialist shall not select a business or accounting outcome independently.

---

## Before you write code

1. There is an approved requirement specification — [`docs/REQUIREMENT-TEMPLATE.md`](docs/REQUIREMENT-TEMPLATE.md), all sixteen sections
2. The sub-phase it belongs to is identified in [`PHASES.md`](PHASES.md)
3. The previous sub-phase's test gate has passed

---

## Architecture rules

### Business logic lives in `src/server/domain`

One implementation of every rule, called by the UI, the API and background jobs alike.

§23: *"Every create/update API must enforce the same permissions and business validations as the user interface."* Two code paths cannot satisfy that — one of them will drift.

The domain layer imports no framework: no Next.js, no React, no Drizzle, no auth library, no queue. This is enforced by `tests/unit/domain-purity.test.ts`, which fails the build. Persistence and authorisation are the layers above; the domain is pure and testable in isolation.

Server Actions are a **transport**, not a place for logic. They validate input, resolve the caller, and call the domain.

### No module writes a journal

Every posting goes through the posting engine (Phase 02.7). §24 exists specifically to prevent each module inventing its own posting, numbering, status or audit behaviour:

> Module developers shall call shared services for numbering, currency, workflow, posting, attachments and audit logging.

### Money is never a `number`

Use the `Money` type in `src/server/domain/money.ts`. JavaScript numbers are IEEE-754 doubles and a ledger that must balance cannot use them.

Every monetary value carries four parts (§24): transaction amount + currency, IQD ledger amount, USD reporting amount, and the historical rate reference. Exchange rates are stored **IQD per USD**, never the inverse.

### Posted records are never updated or deleted

Corrections create a new linked entry (§24). The database enforces this — `REVOKE UPDATE, DELETE` plus a trigger. If you find yourself needing an `UPDATE` on a ledger table, the design is wrong.

### The application never connects as the database owner

`erp_app` owns nothing, so `FORCE ROW LEVEL SECURITY` applies to it. `erp_owner` runs migrations only. See `scripts/sql/00-init-roles.sql`.

---

## Branching and review

- `main` is protected. No direct pushes.
- One branch per sub-phase or change request: `phase-02.7-posting-engine`, `cr-014-retention-release`
- Every pull request needs one review and a green CI run
- Commit messages reference the phase or CR: `phase 02.7: atomic posting with deterministic source reference`

---

## Tests

| Kind | Location | When |
|---|---|---|
| Unit | `tests/unit/` | Domain logic, calculations, architectural rules |
| Integration | `tests/integration/` | **Anything asserting a database guarantee** |
| End-to-end | `tests/e2e/` | User-visible workflows, §26 UAT scenarios |
| Load | `tests/load/` | Phase 20.4 |

Atomicity, append-only, RLS, locking and constraints are guarantees of the **database**. Mocking the database in those tests proves nothing. They run against a real PostgreSQL instance — `npm run db:up`.

Every acceptance criterion in a requirement specification maps to a named test. A criterion with no test is not a criterion.

### Running the integration suite

**One run at a time. Never two.** Every integration test file shares a single
database, `erp_test`, and `resetTestData` empties it between tests. Two runs
against it interleave their resets, and the result is not a clean failure — it is
a scatter of unrelated tests failing on unique-constraint violations in
`doc_number_allocation` and on rows a neighbour deleted mid-transaction. The
failures point at innocent modules, which is the expensive part: they read as a
regression in whatever ran second.

Two things make this easy to do by accident:

- **A cancelled command is not a stopped run.** Killing the terminal, or a tool
  timing out, ends the thing that was watching the run. The vitest process keeps
  going, holds its connections, and finishes minutes later. Check with
  `Get-Process node` before starting another.
- **Chunking the suite does not halve the wall clock** if the chunks overlap. It
  multiplies the failures instead.

The suite takes roughly 90 minutes end to end and cannot usefully be shortened by
running it in parallel — `fileParallelism` is off deliberately, because these
tests assert database guarantees and concurrent writers would make the assertions
meaningless. Run one file while iterating (`npx vitest run --project integration
tests/integration/phase12-fixed-assets.test.ts`) and the whole suite once, before
committing.

---

## Migrations

- Generated with `npm run db:generate`, applied with `npm run db:migrate`
- Constraint SQL that Drizzle cannot express — append-only triggers, RLS policies, `REVOKE` — is appended to the generated file by hand and reviewed
- Migrations are forward-only. The recovery path is documented per release (§25)
- Never edit a migration that has been applied to any shared environment

---

## Secrets

Never in the repository. `.env` is git-ignored; `.env.example` documents the shape with placeholder values only. Real values live in the deployment platform's secret store (§25, A13: *"manage keys separately from application code"*).

CI scans history for committed secrets and fails the build.

---

## Definition of done

From page 45 of the blueprint. A module is complete only when:

1. The business workflow works end to end
2. Permissions and approvals are enforced server-side
3. Source documents, subledgers and G/L reconcile
4. Cancellation and reversal are controlled
5. Reports drill to evidence
6. Audit logging is complete
7. Tests pass
8. Users are trained
9. The process owner signs acceptance

§27.1: *"No release is complete based only on screen availability."*
