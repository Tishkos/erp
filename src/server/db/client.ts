/**
 * Application database client.
 *
 * Connects as erp_app — deliberately NOT the table owner, so
 * FORCE ROW LEVEL SECURITY applies. See scripts/sql/00-init-roles.sql and
 * TECHSTACK.md A3.
 *
 * Blueprint §22: "Row-level security is enforced in the query layer, not only
 * hidden in the screen."
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import * as schema from './schema';
import { configurePgTypes } from './types';

// Before any pool exists: a business date must not become an instant (A10).
configurePgTypes();

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env.');
}

export const pool = new Pool({
  connectionString,
  // A long-running container, not serverless — see TECHSTACK.md B2 risk register.
  // The posting path needs stable connections for row locks and transactions.
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

export const db = drizzle(pool, { schema });

/** The transaction handle every repository function takes. */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The security context every request runs under. */
export interface RequestScope {
  userId: string;
  branchCode: string;
  /**
   * §5.1 — Super Users retain full administration access. Read from
   * app_user.is_super_user when the request is authenticated; it is never
   * supplied by the client.
   */
  isSuperUser?: boolean;
}

/**
 * Runs `fn` inside a transaction with the RLS session variables set.
 *
 * `set_config(..., true)` makes the setting transaction-local, so it cannot
 * leak to the next request that borrows this pooled connection. Any query run
 * outside this helper sees nothing, because the RLS policies compare against a
 * NULL branch code.
 *
 * This is the only sanctioned way to read or write scoped tables.
 */
export async function withScope<T>(scope: RequestScope, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await applyScope(tx, scope);
    return fn(tx);
  });
}

/**
 * Sets the security context on an existing transaction.
 *
 * Exported because a few paths — recording a refused request, recording a
 * failed sign-in — need the context on a transaction they opened themselves.
 * See `src/server/services/audit.ts` for why those cannot share the caller's.
 */
export async function applyScope(tx: Tx, scope: RequestScope): Promise<void> {
  await tx.execute(sql`select set_config('app.user_id', ${scope.userId}, true)`);
  await tx.execute(sql`select set_config('app.branch_code', ${scope.branchCode}, true)`);
  await tx.execute(
    sql`select set_config('app.is_super_user', ${scope.isSuperUser ? 'true' : 'false'}, true)`,
  );
}
