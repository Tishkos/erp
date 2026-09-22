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
