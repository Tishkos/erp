/**
 * A request that comes from this site's own script, not from another site's
 * page using the visitor's cookie.
 *
 * The routes behind the Document Center (`/documents/upload`, `/documents/link/poll`)
 * take raw bodies, so Next's built-in Origin check for server actions does not
 * cover them. They ask for the header only this site's script sets (a
 * cross-site form or `fetch` without CORS approval cannot add it) and an
 * `Origin`, when the browser sends one, that is this site's.
 */
export const SAME_SITE_HEADER = 'x-requested-with';
export const SAME_SITE_VALUE = 'qimah-documents';

export function sameSite(request: Request): boolean {
  if (request.headers.get(SAME_SITE_HEADER) !== SAME_SITE_VALUE) return false;
  const origin = request.headers.get('origin');
  if (!origin) return true;
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
