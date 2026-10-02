import { randomUUID } from 'node:crypto';
import { headers } from 'next/headers';
import { cache } from 'react';

/**
 * REQ-IMPROVE-001 OP-5 — one id per request, on every line it writes.
 *
 * nginx mints `$request_id` and passes it as `X-Request-ID`
 * (deploy/nginx.example.conf). The application takes that id, so the proxy's
 * access log, the application log and the audit trail agree on it; without
 * a proxy (development, tests) it mints its own. Only a well-formed value is
 * trusted — a header is client-settable when nothing in front of the app
 * overwrites it, and the audit column is not the place for a free string.
 *
 * `cache` ties the answer to the request, so a page that asks twice gets the
 * same id. The audit trail's `request_id` used to carry the session id,
 * which told the reader which *person* but not which *request*.
 */
export const currentRequestId = cache(async (): Promise<string> => {
  try {
    const value = (await headers()).get('x-request-id');
    if (value && /^[A-Za-z0-9._:-]{8,64}$/.test(value)) return value;
  } catch {
    // Outside a request (a script, a job) there are no headers.
  }
  return randomUUID();
});

/** The client's address as nginx saw it — HD3: X-Real-IP first, the forwarded chain second. */
export const currentClientIp = cache(async (): Promise<string | null> => {
  try {
    const list = await headers();
    return list.get('x-real-ip')?.trim() || list.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
  } catch {
    return null;
  }
});
