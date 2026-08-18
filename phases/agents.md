 You are building one phase of an ERP system from an approved blueprint
    (`ERP Build Map (2).pdf`, decomposed into `phases/PHASE-XX-*.md`). Another agent
      is working on Phase 05 in parallel. Everything below exists to keep you out of
      its way.

      ## ASSIGNMENT — the only lines that differ between agents

          PHASE:              08          (agent B: 09      agent C: 10)
          PHASE DOC:          phases/PHASE-08-crm.md
          TEST DATABASE:      erp_test_a  (agent B: erp_test_b   agent C: erp_test_c)
          MIGRATION NUMBERS:  0100-0119   (agent B: 0120-0139    agent C: 0140-0159)
          MIGRATION `when`:   1788000000  (agent B: 1789000000   agent C: 1790000000)
                              …000 + 1000 per migration, strictly increasing

Hard boundaries — do not cross these

**Work in a git worktree.** `EnterWorktree` first. Never commit to `main`.
**Touch only your phase.** Do not edit anything under Phase 05, or any file
named `purchase-order*`, `goods-receipt*`, `service-receipt*`, `ap-invoice*`,
`three-way-match*`, `receipt-tolerance*`.
**Do not edit** `docs/DECISIONS.md`, `docs/DecisionAnswered.md`, `PHASES.md`,
or any phase doc other than your own. If you find an ambiguity in the
blueprint that needs a business decision, write it to
`docs/open-questions-phase-{PHASE}.md` in the register's format (Status /
    Blueprint / Blocks / Owner / the ambiguity / the options). Someone else will
         merge it into D-numbers. **Never choose a business or accounting outcome
         yourself** — blueprint §28.1 forbids it.
      4. **Your own test database.** Create it, then export
         `DATABASE_URL_TEST=postgres://erp_owner:owner_dev_password@localhost:5432/{TEST DATABASE}`
         before running anything. Never run tests against `erp_test`.
         docker exec erp-postgres psql -U erp_owner -d erp \
  -c "CREATE DATABASE {TEST DATABASE} OWNER erp_owner"
```
**Migrations.** Name files inside your reserved number range. Add the journal
entry to `src/server/db/migrations/meta/_journal.json` by hand using your
reserved `when` base — drizzle applies migrations in `when` order and
**silently skips** any whose `when` is lower than the last applied one. This
has already cost time once; check it.
**`schema/index.ts` and `tests/integration/setup.ts` are shared.** Append your
lines at the very end of the relevant block and change nothing else in them,
so the merge is trivial.
7. Run only your own test files while working. Run the full suite once at the
   end — never while another agent's run is in flight.

## Conventions this codebase already holds to — match them

- **Layers:** pure logic in `src/server/domain/` (no I/O, no imports from
services/`), transaction-taking functions in `src/server/services/`, Drizzle
ables in `src/server/db/schema/`. Services take a `tx` and never open their
wn transaction.
*The database is the enforcement.** Every rule that matters gets a CHECK, a
rigger, a partial unique index or a withheld grant — not just a service
heck. Express rules so the prohibited state is *unrepresentable* where you
an (a column that doesn't exist beats a rule nobody can forget).
*Migrations are generated then hand-extended.** `npx drizzle-kit generate`
roduces the DDL; you append triggers, RLS policies, `doc_sequence`,
document_type`, `document_status_transition`, `role_grant` and `GRANT`
  statements by hand. Read `0033_phase05_goods_receipt.sql` as the template.
  Every table gets branch RLS (`app_is_super_user() OR branch_code =
  app_current_branch()`) and no DELETE grant for `erp_app` on documents.
- **Money and quantities are scaled BigInt**, never floats: money `numeric(19,4)`
  scale 4, quantities `numeric(24,6)` scale 6, rates scale 8. Business dates are
  ISO strings, never JS `Date`.
  nventions this codebase already holds to — match them

ayers:** pure logic in `src/server/domain/` (no I/O, no imports from
rvices/`), transaction-taking functions in `src/server/services/`, Drizzle
les in `src/server/db/schema/`. Services take a `tx` and never open their
 transaction.
he database is the enforcement.** Every rule that matters gets a CHECK, a
gger, a partial unique index or a withheld grant — not just a service
ck. Express rules so the prohibited state is *unrepresentable* where you
 (a column that doesn't exist beats a rule nobody can forget).
igrations are generated then hand-extended.** `npx drizzle-kit generate`
        produces the DDL; you append triggers, RLS policies, `doc_sequence`,
        `document_type`, `document_status_transition`, `role_grant` and `GRANT`
   statements by hand. Read `0033_phase05_goods_receipt.sql` as the template.
ry table gets branch RLS (`app_is_super_user() OR branch_code =
_current_branch()`) and no DELETE grant for `erp_app` on documents.
oney and quantities are scaled BigInt**, never floats: money `numeric(19,4)`
le 4, quantities `numeric(24,6)` scale 6, rates scale 8. Business dates are
 strings, never JS `Date`.
o module writes a journal.** Every posting goes through the Phase 02 engine
ervices/posting.ts`) by **line role**, never by account number (§3.3).
very test names the blueprint clause it comes from.** Unit tests in
sts/unit/`, integration in `tests/integration/phase{PHASE}-*.test.ts`. Test
 rule at the service *and* at the database ("refuses at the database too,
assing the service").
ments explain *why*, not what. Where you rejected an alternative design,
 so and say why.

      ## What to do
      ## What to do

1. Read `{PHASE DOC}` in full, and the blueprint sections it cites.
ild each sub-phase in order: schema → migration → service → tests.
ck each test-gate checkbox in `{PHASE DOC}` only when its test passes, and
notate it with how it's enforced. Leave unticked anything that genuinely
pends on a phase that doesn't exist, and say what it's waiting for.
pm run typecheck` clean, and your phase's tests green, before you stop.
port: what's built, what's blocked, what's in
ocs/open-questions-phase-{PHASE}.md`, and the merge order for your
grations.

hese three phases

08 (CRM), 09 (Money Transfer) and 10 (Logistics) are the only substantial phases that neither depend on Phase 05 nor on each other. 06 Sales and 07 Treasury both sit directly behind 05 in the dependency map, and 11, 12 and 14 all list 05 as a dependency — handing those out now would have agents building against a moving target.

Two caveats worth knowing before you run it. 09 is the hardest phase in the set — client-fund segregation, execution batches, returned transfers — and D9's compliance requirements are still unknown, so parts of it may need reworking once Legal answers. And an agent starting cold will rebuild thinking that Phase 05 already established; expect its first sub-phase to be slower than the numbers suggest, and expect to spend real time on the merge.