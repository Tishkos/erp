/**
 * reCAPTCHA on the sign-in form: the answer is read as Google writes it, the
 * keys decide whether there is a box at all, and nothing passes that Google
 * did not confirm — not an empty answer, not an error, not an outage.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { RECAPTCHA_VERIFY, readSiteVerify } from '@/server/domain/recaptcha';
import { recaptchaSiteKey, verifyRecaptcha } from '@/server/services/recaptcha';

const KEYS = { RECAPTCHA_SITE_KEY: 'site-key', RECAPTCHA_SECRET_KEY: 'secret-key' };
const original = { ...process.env };
afterEach(() => {
  for (const name of Object.keys(KEYS)) {
    if (original[name] === undefined) delete process.env[name];
    else process.env[name] = original[name];
  }
});
const set = (keys: Partial<typeof KEYS>) => {
  for (const name of Object.keys(KEYS)) delete process.env[name];
  Object.assign(process.env, keys);
};

const answering = (status: number, body: unknown, seen: { url?: string; body?: string } = {}) =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    seen.url = String(url);
    seen.body = String(init?.body);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

describe('readSiteVerify', () => {
  it('passes only success: true, and carries the host name', () => {
    expect(readSiteVerify({ success: true, hostname: 'erp.qs-groups.com' })).toEqual({ ok: true, reason: '', hostname: 'erp.qs-groups.com' });
    expect(readSiteVerify({ success: false, 'error-codes': ['timeout-or-duplicate'] })).toMatchObject({ ok: false, reason: 'timeout-or-duplicate' });
    expect(readSiteVerify({ success: 'true' })).toMatchObject({ ok: false });
    expect(readSiteVerify(null)).toMatchObject({ ok: false });
    expect(readSiteVerify('yes')).toMatchObject({ ok: false });
  });
});

describe('recaptchaSiteKey', () => {
  it('is the site key only when both keys are set', () => {
    set(KEYS);
    expect(recaptchaSiteKey()).toBe('site-key');
    set({ RECAPTCHA_SITE_KEY: 'site-key' });
    expect(recaptchaSiteKey()).toBeNull();
    set({ RECAPTCHA_SECRET_KEY: 'secret-key' });
    expect(recaptchaSiteKey()).toBeNull();
    set({});
    expect(recaptchaSiteKey()).toBeNull();
  });
});

describe('verifyRecaptcha', () => {
  it('posts the secret, the answer and the address to siteverify and reads the reply', async () => {
    set(KEYS);
    const seen: { url?: string; body?: string } = {};
    const reading = await verifyRecaptcha(
      { response: 'the-token', remoteIp: '10.0.0.7' },
      answering(200, { success: true, hostname: 'erp.qs-groups.com' }, seen),
    );
    expect(reading.ok).toBe(true);
    expect(seen.url).toBe(RECAPTCHA_VERIFY);
    const sent = new URLSearchParams(seen.body);
    expect(sent.get('secret')).toBe('secret-key');
    expect(sent.get('response')).toBe('the-token');
    expect(sent.get('remoteip')).toBe('10.0.0.7');
  });

  it('refuses an empty answer without asking Google', async () => {
    set(KEYS);
    let asked = false;
    const reading = await verifyRecaptcha({ response: '  ' }, (async () => {
      asked = true;
      return new Response('{}');
    }) as unknown as typeof fetch);
    expect(reading.ok).toBe(false);
    expect(asked).toBe(false);
  });

  it('refuses when Google says no, answers an error, or cannot be reached', async () => {
    set(KEYS);
    expect((await verifyRecaptcha({ response: 'x' }, answering(200, { success: false, 'error-codes': ['invalid-input-response'] }))).ok).toBe(false);
    expect((await verifyRecaptcha({ response: 'x' }, answering(503, {}))).reason).toBe('reCAPTCHA answered 503');
    const down = (async () => {
      throw new Error('ENETUNREACH');
    }) as unknown as typeof fetch;
    expect((await verifyRecaptcha({ response: 'x' }, down)).reason).toContain('ENETUNREACH');
  });

  it('refuses without a secret', async () => {
    set({ RECAPTCHA_SITE_KEY: 'site-key' });
    expect((await verifyRecaptcha({ response: 'x' }, answering(200, { success: true }))).ok).toBe(false);
  });
});
