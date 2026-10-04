import { headers } from 'next/headers';

/**
 * The way back to the record a shared door was opened on (2026-10-04).
 *
 * The Notes door and the paperclip post to one action each, shared by every
 * record, so the action cannot know the page it was opened on: it is told —
 * the door's hidden `return_to` (the page's path and query, read in the
 * browser), else the request's Referer. Either way it must be a path on this
 * site (HD6 — never an open redirect), and an earlier `saved`/`error` is
 * dropped so they do not pile up.
 */
export async function refererPath(): Promise<string | null> {
  const list = await headers();
  const referer = list.get('referer');
  if (!referer) return null;
  try {
    const url = new URL(referer);
    const host = list.get('x-forwarded-host') ?? list.get('host');
    if (host && url.host !== host) return null;
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

/** A path on this site, without the outcome of an earlier action; null for anything else. */
export function returnPath(requested: string | null): string | null {
  if (!requested || !/^\/(?!\/|\\)[^\s]*$/.test(requested)) return null;
  const [path, query = ''] = requested.split('?', 2) as [string, string?];
  const params = new URLSearchParams(query);
  params.delete('saved');
  params.delete('error');
  const rest = params.toString();
  return rest ? `${path}?${rest}` : path;
}

/** The door's own way back, else the referer, else home. */
export async function wayBack(requested: string | null): Promise<string> {
  return returnPath(requested) ?? returnPath(await refererPath()) ?? '/';
}
