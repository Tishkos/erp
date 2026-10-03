/**
 * The part of the catalogue the browser needs — REQ-HARDEN-001 G7 (HD19).
 *
 * Server components translate on the server (`getTranslations`); only the
 * client components below call `useTranslations`, and only for these
 * namespaces. Handing the provider the whole catalogue put ~200 KB (English)
 * to ~250 KB (Arabic) of JSON into every page, twice escaped in the RSC
 * payload, and it was most of each response's render time under load (the
 * A21 run, §3.I). `tests/unit/hd19-client-messages.test.ts` holds every
 * `useTranslations` in `src` to this list, so a client component that needs
 * another namespace fails the build instead of a page.
 */
export const CLIENT_NAMESPACES = ['chart', 'column', 'error', 'list', 'nav', 'page', 'screen', 'shell', 'status'] as const;

export function clientMessages<T extends Record<string, unknown>>(messages: T): Partial<T> {
  const picked: Record<string, unknown> = {};
  for (const key of CLIENT_NAMESPACES) if (key in messages) picked[key] = messages[key];
  return picked as Partial<T>;
}
