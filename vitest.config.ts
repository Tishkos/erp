import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('./src', import.meta.url));

/**
 * Two projects, deliberately separated — Phase 00.5.
 *
 *   unit         pure, fast, no I/O. Domain logic and architectural rules.
 *   integration  runs against a REAL PostgreSQL instance.
 *
 * TECHSTACK.md B3: "anything asserting a database guarantee — atomicity,
 * append-only, RLS, locking, constraints — runs as an integration test against
 * a real PostgreSQL instance. Mocking the database in those tests proves
 * nothing, because the guarantee being tested belongs to the database."
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': src,
      '@domain': `${src}/server/domain`,
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
          /*
           * A unit test never talks to a database — but some of what it imports
           * imports the database client, and that module refuses to load with
           * no address at all. CI always has one in its environment, so tests
           * written there loaded; a deploy runs this project with none, and
           * four files (the close-check catalogue among them) failed before
           * their first test (found 2026-10-05, after the platform merge). The
           * address below is never connected to: nothing listens on port 9, so
           * a unit test that did query would fail at once and say so.
           */
          env: { DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://unit-tests-never-connect@127.0.0.1:9/none' },
          // A file that writes a real workbook takes over five seconds on a machine short of memory; that is not a failure.
          testTimeout: 20_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['tests/integration/setup.ts'],
          // Database tests share one instance; run files serially so that
          // advisory locks and RLS session state are not cross-contaminated.
          // Concurrency is still exercised *inside* individual tests.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/server/domain/**'],
    },
  },
});
