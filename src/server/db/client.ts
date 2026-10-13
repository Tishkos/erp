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
 * Whether a failure happened while *getting* a connection — before a single
 * statement of the transaction ran.
 *
 * The pool waits `connectionTimeoutMillis` for a free client and then rejects
 * with "timeout exceeded when trying to connect". On a busy or memory-starved
 * host that wait is lost to the machine, not to the database: the process
 * stalls for a few seconds, the timer fires, and a screen that had nothing
 * wrong with it fails (seen on the development machine, 2026-10-12: the
 * server answered its own pollers as if nobody were signed in). Because
 * nothing has been sent yet, trying again is always safe — for a read and for
 * a write alike — which is not true of any failure after BEGIN, so those are
 * never matched here.
 */
export function isConnectFailure(error: unknown): boolean {
  for (let cause: unknown = error, depth = 0; cause && depth < 5; depth += 1) {
    const { message, code } = cause as { message?: unknown; code?: unknown };
    if (typeof message === 'string' && /timeout exceeded when trying to connect|Connection terminated due to connection timeout/i.test(message)) return true;
    // Refused or not ready yet; too many connections; the server is starting up or shutting down.
    if (code === 'ECONNREFUSED' || code === '53300' || code === '57P03') return true;
    cause = (cause as { cause?: unknown }).cause;
  }
  return false;
}

const CONNECT_RETRY_DELAYS_MS = [200, 800] as const;

/**
 * `db.transaction`, tried again when no connection could be had. Two more
 * attempts, a moment apart; anything else — and a third failure — is thrown as
 * it came, to the error boundary and the log.
 */
export async function transact<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await db.transaction(fn);
    } catch (error) {
      const delay = CONNECT_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isConnectFailure(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
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
  return transact(async (tx) => {
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
/**
 * HD5 — marks a transaction as a system sweep: one that escalates or
 * re-delivers notifications for everybody and must read them all. Set by the
 * scheduled jobs on their own transactions; no web request sets it.
 */
export async function markSystemSweep(tx: Tx): Promise<void> {
  await tx.execute(sql`select set_config('app.system_sweep', 'on', true)`);
}

export async function applyScope(tx: Tx, scope: RequestScope): Promise<void> {
  await tx.execute(sql`select set_config('app.user_id', ${scope.userId}, true)`);
  await tx.execute(sql`select set_config('app.branch_code', ${scope.branchCode}, true)`);
  await tx.execute(
    sql`select set_config('app.is_super_user', ${scope.isSuperUser ? 'true' : 'false'}, true)`,
  );
}
