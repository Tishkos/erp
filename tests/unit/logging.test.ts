/**
 * Phase 01.1 test gate — *"No password, token or key appears in any application
 * log."*
 *
 * The check is on the serialised line, not on the object: a value that survives
 * into JSON is a value that reaches a support ticket, whatever the intermediate
 * structure looked like.
 */
import { describe, expect, it } from 'vitest';
import { buildLogRecord } from '../../src/server/logging';

const serialise = (
  level: Parameters<typeof buildLogRecord>[0],
  message: string,
  context: Record<string, unknown>,
) => JSON.stringify(buildLogRecord(level, message, context, new Date('2026-08-16T09:00:00Z')));

describe('01.1 gate · no secret reaches a log line', () => {
  it('redacts a password anywhere in the context', () => {
    const line = serialise('info', 'user signed in', {
      email: 'officer@example.com',
      password: 'Ledger-Trial-Balance-7',
    });

    expect(line).not.toContain('Ledger-Trial-Balance-7');
    expect(line).toContain('officer@example.com');
    expect(line).toContain('[redacted]');
  });

  it('redacts a session token, an API key and an MFA secret', () => {
    const line = serialise('warn', 'session resolved', {
      sessionToken: 'tok_abcdef',
      api_key: 'key_123',
      mfaSecret: 'JBSWY3DPEHPK3PXP',
      session_id: 'sess-9',
    });

    for (const secret of ['tok_abcdef', 'key_123', 'JBSWY3DPEHPK3PXP', 'sess-9']) {
      expect(line, secret).not.toContain(secret);
    }
  });

  it('redacts a secret nested inside an object', () => {
    // The realistic case: someone logs the whole request rather than a field.
    const line = serialise('debug', 'request received', {
      request: { headers: { authorization: 'Bearer abc' }, body: { password: 'p@ssw0rd-long' } },
    });

    expect(line).not.toContain('p@ssw0rd-long');
    // The Authorization header is how a bearer token actually travels, and the
    // word "token" appears nowhere in its name.
    expect(line).not.toContain('Bearer abc');
  });

  it('redacts the cookie header, which carries the session', () => {
    const line = serialise('debug', 'request received', {
      headers: { cookie: 'erp_session=abcdef123', 'set-cookie': 'erp_session=xyz' },
    });

    expect(line).not.toContain('abcdef123');
    expect(line).not.toContain('erp_session=xyz');
  });

  it('redacts a secret carried on a custom error', () => {
    // An error class is a plain object as far as a credential is concerned.
    class SignInError extends Error {
      constructor(readonly attemptedPassword: string) {
        super('Credentials were not accepted');
        this.name = 'SignInError';
      }
    }

    const line = serialise('error', 'sign-in failed', {
      error: new SignInError('Ledger-Trial-Balance-7'),
    });

    expect(line).not.toContain('Ledger-Trial-Balance-7');
    expect(line).toContain('Credentials were not accepted');
  });

  it('redacts through an error cause chain', () => {
    const cause = Object.assign(new Error('driver failed'), { token: 'tok_secret' });
    const line = serialise('error', 'query failed', {
      error: new Error('Failed query', { cause }),
    });

    expect(line).not.toContain('tok_secret');
    expect(line).toContain('driver failed');
  });

  it('keeps the business detail that makes a log worth having', () => {
    const record = buildLogRecord('info', 'journal posted', {
      journalNumber: 'JE-2026-0001',
      branchCode: 'HQ',
      totalDebitIqd: '1250000.0000',
    });

    expect(record.context).toMatchObject({
      journalNumber: 'JE-2026-0001',
      branchCode: 'HQ',
      totalDebitIqd: '1250000.0000',
    });
  });

  it('records the level and a timestamp it did not invent', () => {
    const record = buildLogRecord('warn', 'x', {}, new Date('2026-08-16T09:00:00Z'));
    expect(record.level).toBe('warn');
    expect(record.at).toBe('2026-08-16T09:00:00.000Z');
  });

  it('truncates a stack rather than burying the line in it', () => {
    const record = buildLogRecord('error', 'failed', { error: new Error('boom') });
    const stack = (record.context.error as { stack: string | null }).stack;
    expect(stack?.split('\n').length ?? 0).toBeLessThanOrEqual(8);
  });
});
