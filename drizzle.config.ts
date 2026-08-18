import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

// Migrations run as erp_owner. The application never uses this connection —
// see scripts/sql/00-init-roles.sql and TECHSTACK.md A3.
const url = process.env.DATABASE_URL_OWNER;

if (!url) {
  throw new Error(
    'DATABASE_URL_OWNER is not set. Copy .env.example to .env. ' +
      'Migrations run as the owner role, not the application role.',
  );
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/server/db/schema/index.ts',
  out: './src/server/db/migrations',
  dbCredentials: { url },
  // Emit readable SQL — these migrations are reviewed as part of the release
  // record required by blueprint §25 ("scope, migration notes, test evidence,
  // approvals and rollback plan").
  verbose: true,
  strict: true,
});
