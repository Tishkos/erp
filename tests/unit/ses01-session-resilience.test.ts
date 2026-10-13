/**
 * The session and the connection pool (2026-10-12).
 *
 * Found while chasing an error page that turned out to be the shell's own
 * (`tests/e2e/section-bar-modules.spec.ts`): under pressure the development
 * server answered its own pollers 401 with a perfectly good session, because a
 * connection it could not get in time was read as "nobody is signed in".
 *
 * Three rules, the halves that need no database:
 *
 *   1. A failure to *get* a connection is told from every other failure, so it
 *      alone may be tried again (nothing had been sent).
 *   2. Only "nobody is signed in" reads as signed out. A database that could
 *      not be reached says nothing about who is asking — it used to send the
 *      person to the sign-in form and stop the chat and the bell for good.
 *   3. The caller is resolved once per render and through the retrying
 *      transaction: read from the source, because the guarantee is that no
 *      screen goes back to resolving it six times.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isConnectFailure } from '@/server/db/client';
import { SessionInvalidError, isSignedOutError } from '@/server/domain/authentication';

describe('SES1 · a connection that could not be had is told from a statement that failed', () => {
  it('the pool’s own timeout, a refusal and a server not ready are connect failures', () => {
    expect(isConnectFailure(new Error('timeout exceeded when trying to connect'))).toBe(true);
    expect(isConnectFailure(new Error('Connection terminated due to connection timeout'))).toBe(true);
    expect(isConnectFailure(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5434'), { code: 'ECONNREFUSED' }))).toBe(true);
    expect(isConnectFailure(Object.assign(new Error('sorry, too many clients already'), { code: '53300' }))).toBe(true);
    expect(isConnectFailure(Object.assign(new Error('the database system is starting up'), { code: '57P03' }))).toBe(true);
  });

  it('is found under the wrapper a query layer puts around it', () => {
    const wrapped = new Error('Failed query: begin', { cause: new Error('timeout exceeded when trying to connect') });
    expect(isConnectFailure(wrapped)).toBe(true);
  });

  it('anything after BEGIN is never one — a retry there could repeat a write', () => {
    expect(isConnectFailure(Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' }))).toBe(false);
    expect(isConnectFailure(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }))).toBe(false);
    expect(isConnectFailure(Object.assign(new Error('deadlock detected'), { code: '40P01' }))).toBe(false);
    // A connection lost in the middle of a transaction may have lost it at COMMIT.
    expect(isConnectFailure(new Error('Connection terminated unexpectedly'))).toBe(false);
    expect(isConnectFailure(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).toBe(false);
    expect(isConnectFailure(null)).toBe(false);
    expect(isConnectFailure('timeout exceeded when trying to connect')).toBe(false);
  });
});

describe('SES2 · only "nobody is signed in" is a sign-out', () => {
  it('no cookie, and a session that is unknown, expired or revoked', () => {
    expect(isSignedOutError(Object.assign(new Error('no session cookie was sent'), { code: 'NOT_SIGNED_IN' }))).toBe(true);
    expect(isSignedOutError(new SessionInvalidError('it expired'))).toBe(true);
    expect(isSignedOutError(new SessionInvalidError('it was revoked'))).toBe(true);
  });

  it('a database that could not be reached is not', () => {
    expect(isSignedOutError(new Error('timeout exceeded when trying to connect'))).toBe(false);
    expect(isSignedOutError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))).toBe(false);
    expect(isSignedOutError(Object.assign(new Error('permission denied for table app_user'), { code: '42501' }))).toBe(false);
    expect(isSignedOutError(undefined)).toBe(false);
  });
});

describe('SES3 · the request’s identity is resolved once, and through the retrying transaction', () => {
  const session = readFileSync('src/server/session.ts', 'utf8');
  const client = readFileSync('src/server/db/client.ts', 'utf8');

  it('`currentContext` is shared by everything one render asks', () => {
    expect(session).toMatch(/import \{ cache \} from 'react';/);
    expect(session).toMatch(/export const currentContext = cache\(/);
  });

  it('no caller of the session opens a transaction that cannot retry its connection', () => {
    expect(session).not.toMatch(/db\.transaction\(/);
    expect(session.match(/transact\(/g)?.length).toBeGreaterThanOrEqual(2);
    expect(readFileSync('src/server/chat-api.ts', 'utf8')).not.toMatch(/db\.transaction\(/);
  });

  it('`optionalContext` answers null for a sign-out and throws everything else', () => {
    const body = /export async function optionalContext\(\)[\s\S]*?\n}\n/.exec(session)?.[0] ?? '';
    expect(body).toContain('if (isSignedOutError(error)) return null;');
    expect(body).toContain('throw error;');
    // The bare `catch { return null }` is what read a slow database as "signed out".
    expect(body).not.toMatch(/catch\s*\{\s*return null;?\s*\}/);
  });

  it('the retry is bounded: two more attempts, then the failure is thrown as it came', () => {
    expect(client).toMatch(/const CONNECT_RETRY_DELAYS_MS = \[200, 800\] as const;/);
    expect(client).toMatch(/if \(delay === undefined \|\| !isConnectFailure\(error\)\) throw error;/);
  });
});
