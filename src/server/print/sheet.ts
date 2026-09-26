import { getLocale } from 'next-intl/server';
import type { Locale } from '@/i18n/config';
import { withCurrentUser } from '../session';
import { mayExport, type ExportKey } from './access';
import { messagesFor } from './i18n';
import { letterheadFor } from './letterhead';
import type { Letterhead, PrintModel } from './model';
import { exportable } from './registry';

/**
 * The print sheet for a record page — the model its PDF is drawn from, in the
 * reader's language, for the browser's own print.
 *
 * Only for a reader who may print it: without `print`, the page carries no
 * sheet, and the browser prints the screen as it always did.
 */
export async function printSheet(
  key: ExportKey,
  id: string | null,
  query: URLSearchParams = new URLSearchParams(),
): Promise<{ readonly model: PrintModel; readonly head: Letterhead } | null> {
  const locale = (await getLocale()) as Locale;
  return withCurrentUser(async (tx, context) => {
    if (!mayExport(context.principal, key, 'pdf')) return null;
    const built = await exportable(key).build(
      { tx, principal: context.principal, branchCode: context.scope.branchCode, locale, m: messagesFor(locale) },
      { id, query },
    );
    if (!built) return null;
    const head = await letterheadFor(tx, { locale, userId: context.principal.userId, branchCode: built.branchCode });
    return { model: built.model, head };
  });
}
