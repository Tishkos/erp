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
