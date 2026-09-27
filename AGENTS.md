<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Isolated database verification

`scripts/seed-dev.ts` uses `DATABASE_URL`, not `DATABASE_URL_OWNER`. Setting only the owner URL does not redirect the seed. For isolated verification, explicitly point `DATABASE_URL` and `DATABASE_URL_TEST` at the intended isolated database, and verify the running development server uses that same database before browser tests. Never rely on `.env` defaults for a seed or test run.

## Audit timestamp payloads

Pass timestamps to `audit.record` as ISO strings, not JavaScript `Date` objects: a Date in an audit before-value was serialized as `{}` by the current audit pipeline. Existing audit rows remain immutable; any correction must be an append-only supplement with verified source evidence.

## Release integration and migration ordering

Release `5f721629294249c8e9bd16b124f8b770253b50c3` on `fix/item-revenue-routing` — the supplier-statement fix, invoice dimensions, item-based revenue routing and account-profile corrections — is integrated here. The tree's pricing work predates it and was committed first, so the merge reads as "the release on top of the prices".

Production applied migrations `0197` and `0200` with journal timestamps `1795900000001` and `1795900000002`. Drizzle orders execution by `_journal.json` timestamps, not filename numbers, so the pending `0198`/`0199`/`0201` migrations are appended after the latest journal entry with strictly greater timestamps. Never rewrite an applied migration and never sort the journal by filename.

## Inventory: one ledger, and the scripts that must respect it

`inventory_movement` is the only source of stock quantity. `stock_position`, `positionOf`, the Stock Movement page and the Warehouses Report's Quantity column all sum it; `cost_layer` carries the value. Every document that moves stock writes its rows in the same transaction, so the two cannot drift through the application — only through maintenance.

When a new document table that moves stock is added (migration), add it to **both** `tests/integration/setup.ts` (`resetTestData`) **and** `scripts/ops/format-live-database.sh` (`DOCUMENT_TABLES`). The 2026-09-27 orphans (`TRF-HQ-2026-000001/2`, `ADJ-HQ-2026-000001`) were the format script wiping `inventory_movement` while `stock_transfer`/`stock_adjustment` were missing from its list.

To check a live database: `npx tsx scripts/ops/stock-movement-trace.ts [warehouse] [item]` prints every movement with a running balance and runs `services/inventory-integrity.ts` (documents without ledger rows, rows without documents, unbalanced transfers). To remove a verified orphan document: `scripts/ops/remove-orphan-stock-documents.sh [--yes] TRF-… ADJ-…` — it refuses anything that has movements and writes an `audit_event` per removal.

The Warehouses Report's *Total Price* is IQD at FIFO cost, not a quantity and not a selling price: 507 units bought as 10 @ 50 and 500 @ 500 less 3 sold is 250,350 IQD.

Integration suites: `npx vitest run --project integration tests/integration/ops15-inventory-ledger.test.ts` (≈2 min) covers the lifecycle, warehouse isolation, returns, transfers, shipment stages, concurrent double-posting, negative stock and the integrity checks.
