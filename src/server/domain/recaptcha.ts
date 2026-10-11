/**
 * reCAPTCHA v2 ("I'm not a robot") on the sign-in form — the pure half.
 *
 * Google's script draws the box and puts its answer in the form as
 * `g-recaptcha-response`; the server asks Google's `siteverify` whether that
 * answer is a person's, with the secret key it alone holds. This file knows
 * the addresses and reads the answer; `services/recaptcha.ts` holds the keys
 * and makes the request.
 */

export const RECAPTCHA_SCRIPT = 'https://www.google.com/recaptcha/api.js';
export const RECAPTCHA_VERIFY = 'https://www.google.com/recaptcha/api/siteverify';

/** The form field Google's widget fills in. */
export const RECAPTCHA_FIELD = 'g-recaptcha-response';

export interface SiteVerifyReading {
  readonly ok: boolean;
  /** Why not, in Google's own words (`error-codes`), or ours. */
  readonly reason: string;
  /** The host name Google saw the box on, when it says. */
  readonly hostname: string | null;
}

/**
 * Reads `siteverify`'s answer. Only `success: true` passes; `hostname` is
 * handed back so the caller can refuse a box solved on somebody else's page
 * when it wants to.
 */
export function readSiteVerify(body: unknown): SiteVerifyReading {
  if (!body || typeof body !== 'object') return { ok: false, reason: 'no answer from reCAPTCHA', hostname: null };
  const answer = body as { success?: unknown; hostname?: unknown; 'error-codes'?: unknown };
  const hostname = typeof answer.hostname === 'string' ? answer.hostname : null;
  if (answer.success === true) return { ok: true, reason: '', hostname };
  const codes = Array.isArray(answer['error-codes'])
    ? answer['error-codes'].filter((code): code is string => typeof code === 'string')
    : [];
  return { ok: false, reason: codes.length > 0 ? codes.join(', ') : 'not confirmed', hostname };
}
