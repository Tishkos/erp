import { getLocale } from 'next-intl/server';
import { isLocale, type Locale } from '@/i18n/config';
import { visibleRoute } from '../delivered';
import { withCurrentUser } from '../session';
import { prepareExport, renderExport } from './export';
import { messagesFor } from './i18n';
import { isExportFormat } from './model';
import { EXPORT_ACCESS, type ExportKey } from './access';

/**
 * The route handler behind every Print / Export link.
 *
 *   GET <screen>/export?format=pdf|xlsx|docx&lang=en|ar&<the screen's filters>
 *
 * The screen's own query string rides along untouched — the same parameters
 * the screen was run with — so the file is that screen's figures and no
 * other. `lang` picks the language of the document, independently of the
 * session's; without it, the reader's own language.
 */
export async function exportResponse(request: Request, key: ExportKey, id: string | null): Promise<Response> {
  if (!visibleRoute(EXPORT_ACCESS[key].route)) return new Response(null, { status: 404 });

  const url = new URL(request.url);
  const format = url.searchParams.get('format');
  if (!isExportFormat(format)) return new Response('Unknown export format.', { status: 400 });
  const lang = url.searchParams.get('lang') ?? '';
  const locale: Locale = isLocale(lang) ? lang : ((await getLocale()) as Locale);
  const query = new URLSearchParams(url.searchParams);
  query.delete('format');
  query.delete('lang');

  // OP-9 — the read and the audit record happen in the transaction; the
  // render happens after it has committed, so a slow PDF holds no lock.
  const prepared = await withCurrentUser((tx, context) =>
    prepareExport(
      tx,
      { principal: context.principal, branchCode: context.scope.branchCode },
      { key, format, locale, input: { id, query } },
    ),
  );
  if (prepared.status === 413) {
    return new Response(messagesFor(locale).print('too_many_rows', { rows: prepared.rows, cap: prepared.cap }), {
      status: 413,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store, private' },
    });
  }
  if (prepared.status !== 200) return new Response(null, { status: prepared.status });
  const result = { ...prepared, body: await renderExport(prepared) };

  const ascii = result.fileName.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return new Response(new Uint8Array(result.body), {
    headers: {
      'content-type': result.contentType,
      'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(result.fileName)}`,
      'content-length': String(result.body.length),
      // Never cached: a copy reflects one person's permissions at one moment,
      // and a shared cache would hand it to the next reader.
      'cache-control': 'no-store, private',
      'x-content-type-options': 'nosniff',
    },
  });
}
