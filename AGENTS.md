<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Database verification and migration ordering

The development seed uses `DATABASE_URL`, not `DATABASE_URL_OWNER`. Use explicit isolated application/test database URLs for verification; never rely on `.env` defaults.

Drizzle applies migrations using `_journal.json` timestamps, not filename numbers. This branch registers the queued `0197` price-storage migration before `0200` invoice dimensions. Pending `0198` and `0199` migrations must be appended with timestamps greater than `1795900000002`; do not insert them earlier or rewrite applied migrations.

## Audit timestamp payloads

Pass timestamps to `audit.record` as ISO strings, not JavaScript `Date` objects, which the current audit pipeline serializes as `{}`. Existing audit rows remain immutable.
