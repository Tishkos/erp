/**
 * The pointing drawn on a picture of a screen (`src/server/guide/markers.ts`),
 * and the rules a live picture is taken under (`services/live-screenshot.ts`).
 *
 * The marker script runs in a browser page, where no build step reaches it:
 * it is handed over as text. What can be held here, without a browser, is
 * that the text stays what a page can run as it stands — it parses, it is
 * plain ES5 (a function given to `page.evaluate` is compiled by tsx first and
 * wrapped in a helper the page has never heard of; text is not, as long as
 * nothing ever needs to rewrite it), and it defines the two things the
 * callers call.
 *
 * The live picture's rules that are decided on text alone are held here too:
 * which addresses are pages, that the browser is given nothing to press, and
 * that the session it signs in with is the application's own kind.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { MARKERS_JS, UNMARK_CALL, markCall } from '@/server/guide/markers';
import { LIVE_SESSION_COOKIE, LIVE_SHOT_AGENT, checkPath, liveScreenshot, liveShotsReady } from '@/server/services/live-screenshot';

describe('the marker script', () => {
  it('parses as it stands', () => {
    expect(() => new Function(MARKERS_JS)).not.toThrow();
  });

  it('is plain ES5: no arrow functions, no block-scoped declarations, no template text', () => {
    expect(MARKERS_JS).not.toContain('=>');
    expect(MARKERS_JS).not.toMatch(/\bconst\s/);
    expect(MARKERS_JS).not.toMatch(/\blet\s/);
    expect(MARKERS_JS).not.toContain('`');
    expect(MARKERS_JS).not.toContain('${');
    // Nothing a bundler's helper would be needed for.
    expect(MARKERS_JS).not.toMatch(/\bclass\s|\basync\s|\bawait\s|\.\.\./);
  });

  it('defines the call that draws and the call that clears, once', () => {
    const window: Record<string, unknown> = {};
    const run = new Function('window', 'document', 'getComputedStyle', MARKERS_JS);
    run(window, {}, () => ({}));
    expect(typeof window.__erpMark).toBe('function');
    expect(typeof window.__erpUnmark).toBe('function');
    // Put in a second time (a caller that does not know it is there), it leaves the first alone.
    const first = window.__erpMark;
    run(window, {}, () => ({}));
    expect(window.__erpMark).toBe(first);
  });

  it('never reads a secret out of a field: by type, by name, by what it is called', () => {
    // The rule is in the script itself, so it holds for every caller.
    expect(MARKERS_JS).toMatch(/var SECRET = \/pass\|secret\|token\|otp\|code/);
    expect(MARKERS_JS).toMatch(/=== 'password'\) return true/);
    expect(MARKERS_JS).toMatch(/if \(secretField\(field, caption\)\) return null;/);
  });

  it('draws nothing into the layout: every box, tag and arrow is laid over the page and can be taken off', () => {
    expect(MARKERS_JS).not.toMatch(/insertBefore\(/);
    expect(MARKERS_JS).toMatch(/pointer-events:none/);
    expect(MARKERS_JS).toMatch(/querySelectorAll\('\[' \+ ATTR \+ '\]'\)/);
  });

  it('is called with its options as data, never as code', () => {
    const call = markCall({ scope: 'record', pointAt: ['Send for approval', 'x"); alert(1); ("'], withValues: true });
    expect(call.startsWith('window.__erpMark(')).toBe(true);
    // The label that tries to close the call is still inside a JSON string.
    expect(JSON.parse(call.slice('window.__erpMark('.length, -1))).toEqual({
      scope: 'record',
      pointAt: ['Send for approval', 'x"); alert(1); ("'],
      withValues: true,
    });
    expect(UNMARK_CALL).toContain('__erpUnmark');
  });
});

describe('a live picture — which addresses are pages', () => {
  it('takes a screen, a record, and an address with a query', () => {
    expect(checkPath('/payables/suppliers')).toEqual({ ok: true, path: '/payables/suppliers' });
    expect(checkPath(' /sales/ar-invoices/INV-HQ-2026-000001 ')).toEqual({ ok: true, path: '/sales/ar-invoices/INV-HQ-2026-000001' });
    expect(checkPath('/sales/customers/CUS-000001?role=customer')).toEqual({ ok: true, path: '/sales/customers/CUS-000001?role=customer' });
    expect(checkPath('/')).toEqual({ ok: true, path: '/' });
    expect(checkPath('/password')).toMatchObject({ ok: true });
  });

  it('refuses anything that is not a page of this application, before a browser is opened', () => {
    for (const asked of [
      '',
      'payables/suppliers',
      'https://example.com/x',
      'http://127.0.0.1:3200/payables/suppliers',
      'javascript:alert(1)',
      '//example.com/x',
      '/payables//suppliers',
      '/\\example.com',
      '/payables/../api/users',
      '/payables/%2e%2e/api',
      '/payables/a%2Fb',
      '/api/health',
      '/API/health',
      '/_next/static/chunks/x.js',
      '/sign-in',
      '/sign-out',
      '/healthz',
      '/session/version',
      '/attachments/7c0e1c1e-0000-0000-0000-000000000000',
      '/export/purchase_invoice/API-HQ-2026-000001',
      '/master-data/chart-of-accounts/export',
      '/master-data/chart-of-accounts/A100010/export',
      '/payables/suppliers and more',
      '/payables/<script>',
      `/${'x'.repeat(400)}`,
    ]) {
      const checked = checkPath(asked);
      expect(checked.ok, asked).toBe(false);
      if (!checked.ok) expect(checked.reason.length, asked).toBeGreaterThan(20);
    }
  });

  it('says why in a sentence that can be repeated to the person', () => {
    expect(checkPath('/export/x')).toMatchObject({ ok: false, reason: expect.stringMatching(/a file to download/) });
    expect(checkPath('/api/x')).toMatchObject({ ok: false, reason: expect.stringMatching(/not a screen/) });
    expect(checkPath('https://x.y')).toMatchObject({ ok: false, reason: expect.stringMatching(/not a web address/) });
    expect(checkPath('/sign-in')).toMatchObject({ ok: false, reason: expect.stringMatching(/show_screen "sign in"/) });
  });
});

describe('a live picture — the rules it is taken under', () => {
  const service = readFileSync('src/server/services/live-screenshot.ts', 'utf8');
  const before = process.env.NOAH_LIVE_SHOTS;
  afterEach(() => {
    if (before === undefined) delete process.env.NOAH_LIVE_SHOTS;
    else process.env.NOAH_LIVE_SHOTS = before;
  });

  it('signs in with the application’s own session cookie, by the application’s own name for it', () => {
    const session = readFileSync('src/server/session.ts', 'utf8');
    expect(session).toContain(`export const SESSION_COOKIE = '${LIVE_SESSION_COOKIE}';`);
    expect(LIVE_SHOT_AGENT).toBe('noah-live-screenshot');
    // As `authentication.ts` › createSession stores it: the token's SHA-256, never the token.
    expect(service).toMatch(/token: digest\(token\)/);
    expect(service).toMatch(/createHash\('sha256'\)\.update\(token\)\.digest\('hex'\)/);
  });

  it('makes a session that cannot outlive the picture: three minutes, and ended in a finally', () => {
    expect(service).toMatch(/const SESSION_MS = 3 \* 60_000;/);
    expect(service).toMatch(/expiresAt: new Date\(Date\.now\(\) \+ SESSION_MS\)/);
    expect(service).toMatch(/\} finally \{[\s\S]{0,260}await endSession\(input\.userId, minted\.sessionId\)/);
  });

  it('can only look: every request but a GET or a HEAD is refused, and it is given nothing to press', () => {
    expect(service).toMatch(/if \(method !== 'GET' && method !== 'HEAD'\) return route\.abort\('blockedbyclient'\);/);
    expect(service).toMatch(/if \(url\.origin !== origin\) return route\.abort\('blockedbyclient'\);/);
    expect(service).toMatch(/acceptDownloads: false/);
    // No click, no key, no form: the page is opened, waited for, drawn on and pictured.
    expect(service).not.toMatch(/\.(click|dblclick|tap|fill|type|press|check|uncheck|selectOption|setInputFiles|dispatchEvent|dragTo)\(/);
    expect(service).not.toMatch(/keyboard\.|mouse\./);
  });

  it('names nobody but the asker: a user id, and nothing else that could be a person', async () => {
    // Not a user id: refused before anything is opened or written.
    process.env.NOAH_LIVE_SHOTS = 'on';
    const ready = liveShotsReady();
    if (ready.ok) {
      await expect(liveScreenshot({ userId: 'admin@example.com', path: '/payables/suppliers', locale: 'en' })).resolves.toEqual({
        ok: false,
        reason: 'There is nobody to take the picture as.',
      });
    }
    expect(service).not.toMatch(/email|impersonat/i);
  });

  it('is switched off by one word, and says so', async () => {
    process.env.NOAH_LIVE_SHOTS = 'off';
    expect(liveShotsReady()).toEqual({ ok: false, reason: expect.stringMatching(/switched off/) });
    await expect(liveScreenshot({ userId: '00000000-0000-0000-0000-000000000001', path: '/payables/suppliers', locale: 'en' })).resolves.toMatchObject({
      ok: false,
      reason: expect.stringMatching(/switched off/),
    });
  });
});
