# Integrated ERP System

Built to **`ERP Build Map (2).pdf`** — *Integrated ERP System Blueprint | Approved Business & Functional Requirements*, 45 pages, 28 sections and Appendices A–E.

**Business Process Owner:** Issa Mohammed. Per the execution rule on page 1, no business rule, accounting rule, workflow or permission rule changes without written approval.

---

## Documents

| File | What it is |
|---|---|
| [`PHASES.md`](PHASES.md) | The 22-phase build plan, dependency graph, and the two corrections to the §27 roadmap |
| [`TECHSTACK.md`](TECHSTACK.md) | Part A: the 15 technical constraints the blueprint imposes on any stack. Part B: the chosen stack, verified against them |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Architecture rules, branching, tests, definition of done |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | **Nine open decisions blocking build.** Read this first |
| [`docs/RACI.md`](docs/RACI.md) | Who decides what |
| [`docs/REQUIREMENT-TEMPLATE.md`](docs/REQUIREMENT-TEMPLATE.md) | The Appendix E per-screen specification, 16 fields |
| [`docs/CHANGE-REQUEST-TEMPLATE.md`](docs/CHANGE-REQUEST-TEMPLATE.md) | §28.1 change control |
| [`phases/`](phases/) | One file per phase, each with sub-phases and test gates |

---

## Getting started

```bash
cp .env.example .env      # placeholder values are fine for local development
npm install
npm run db:up             # PostgreSQL 17 in Docker — requires Docker Desktop running
npm run db:migrate
npm test                  # unit + integration
npm run dev               # http://localhost:3000
```

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | Production build (standalone container output) |
| `npm run typecheck` | TypeScript, no emit |
| `npm run db:up` / `db:down` | Start / stop local PostgreSQL |
| `npm run db:generate` | Generate a migration from the Drizzle schema |
| `npm run db:migrate` | Apply migrations (as `erp_owner`) |
| `npm run db:reset` | Drop and rebuild the local schema — local only, refuses anything else |
| `npm run test:unit` | Domain logic and architectural rules — fast, no I/O |
| `npm run test:integration` | Database guarantees, against a real PostgreSQL |
| `npm run test:e2e` | Playwright |
| `npm run test:load` | k6 — thresholds pending decision D5 |

---

## Architecture in one page

```
src/
  app/                 Next.js App Router — transport only
  server/
    domain/            business rules. NO framework imports. Enforced by a test.
    db/
      client.ts        app-role pool + withScope() for RLS
      migrate.ts       migration runner (owner role)
      schema/          Drizzle table definitions
      migrations/      versioned SQL
tests/
  unit/                pure, fast
  integration/         real PostgreSQL
  e2e/                 Playwright
  load/                k6
```

**Three rules that matter more than the rest:**

1. **Business logic lives in `src/server/domain`** and imports no framework. §23 requires the API to enforce identical validations to the UI — that is only possible with one code path. A test fails the build if the boundary is crossed.

2. **Money is never a `number`.** Every monetary value carries four parts (§24): transaction amount + currency, IQD ledger amount, USD reporting amount at the historical rate, and the rate reference. Rates are stored **IQD per USD** — the inverse loses ~5% precision at any sane scale.

3. **The application never connects as the database owner.** `erp_app` owns nothing, so `FORCE ROW LEVEL SECURITY` genuinely applies. `erp_owner` runs migrations only. Without this separation every authorisation test passes for the wrong reason.

---

## Status

**Phase 00 — Program Setup: complete.** Phase 01 (Platform Core) is next.

The `spike_*` objects in migration `0000_phase00_spike.sql` are a **stack validation spike**, not production schema. They prove the four hardest constraints work on this stack — append-only ledgers, row-level security that cannot be bypassed, exact money precision, idempotent posting, gapless numbering under concurrency — before Phases 01 and 02 depend on them. They are dropped in Phase 01.

### Blocked

Nine decisions in [`docs/DECISIONS.md`](docs/DECISIONS.md) are outstanding. The urgent one is **D7 — the Chart of Accounts**: Phase 02 cannot be accepted and no Appendix C posting mapping can be configured until it exists. Every module phase from 04 onward sits behind it.
