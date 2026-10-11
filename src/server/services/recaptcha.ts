/**
 * reCAPTCHA v2 on the sign-in form — the half that holds the keys and talks
 * to Google (by direction, 2026-10-11: "setup recaptcha in login screen").
 *
 * Both keys set: the box is drawn and `verifyRecaptcha` must say yes before
 * the credentials are looked at. Either unset: there is no box and nothing to
 * check — the development server and the end-to-end tests run that way. The
 * secret never reaches the browser; the site key is public by design.
 *
 * A failure to reach Google is a refusal, not a pass: the box is a lock, and
 * a lock that opens when its keeper is away is not one. Unset the keys to
 * take the box off while Google is unreachable.
 */
import { RECAPTCHA_VERIFY, readSiteVerify, type SiteVerifyReading } from '../domain/recaptcha';

const env = (name: string) => process.env[name]?.trim() || null;

/** The public site key, when the server is configured for the box; null otherwise. */
export function recaptchaSiteKey(): string | null {
  return env('RECAPTCHA_SITE_KEY') && env('RECAPTCHA_SECRET_KEY') ? env('RECAPTCHA_SITE_KEY') : null;
}

/** How long Google is given to answer before the sign-in is refused. */
export const VERIFY_TIMEOUT_MS = 8_000;

/**
 * Asks Google whether the box's answer is a person's. `fetchImpl` is for the
 * unit test; the sign-in passes nothing.
 */
export async function verifyRecaptcha(
  input: { readonly response: string; readonly remoteIp?: string | null },
  fetchImpl: typeof fetch = fetch,
): Promise<SiteVerifyReading> {
  const secret = env('RECAPTCHA_SECRET_KEY');
  if (!secret) return { ok: false, reason: 'RECAPTCHA_SECRET_KEY is not set', hostname: null };
  const response = input.response.trim();
  if (!response) return { ok: false, reason: 'the box was not ticked', hostname: null };

  const body = new URLSearchParams({ secret, response });
  if (input.remoteIp) body.set('remoteip', input.remoteIp);
  try {
    const answer = await fetchImpl(RECAPTCHA_VERIFY, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    if (!answer.ok) return { ok: false, reason: `reCAPTCHA answered ${answer.status}`, hostname: null };
    return readSiteVerify(await answer.json());
  } catch (error) {
    return {
      ok: false,
      reason: `reCAPTCHA could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      hostname: null,
    };
  }
}
