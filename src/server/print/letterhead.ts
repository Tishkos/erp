import { eq } from 'drizzle-orm';
import type { Locale } from '@/i18n/config';
import type { Tx } from '../db/client';
import { appUser, branch } from '../db/schema';
import * as companyService from '../services/company';
import { messagesFor } from './i18n';
import type { Letterhead } from './model';

/**
 * Whose document this is, and who took this copy of it, when.
 *
 * The company's English name is its registered legal name; the Arabic name is
 * the one the application already shows beside it in the shell. The branch is
 * the document's own branch — a Purchase Invoice raised in Basra says Basra,
 * whoever prints it — and a report's is the branch the reader is working in.
 * "Printed by … at …" is the session and the clock, not the document: it is
 * the provenance a filed copy needs years later.
 */
export async function letterheadFor(
  tx: Tx,
  input: {
    readonly locale: Locale;
    readonly userId: string;
    readonly branchCode: string;
    /** When the copy is taken. Passed in, so a test can pin it. */
    readonly at?: string;
  },
): Promise<Letterhead> {
  const [company, [me], [place]] = await Promise.all([
    companyService.current(tx),
    tx.select({ name: appUser.displayName }).from(appUser).where(eq(appUser.id, input.userId)).limit(1),
    tx.select({ code: branch.code, name: branch.name }).from(branch).where(eq(branch.code, input.branchCode)).limit(1),
  ]);
  const english = messagesFor('en');
  const arabic = messagesFor('ar');
  const t = messagesFor(input.locale).print;

  return {
    locale: input.locale,
    companyEn: company?.legalName ?? english.shell('company_name'),
    companyAr: arabic.shell('company_name'),
    branch: place ? `${place.code} · ${place.name}` : input.branchCode || '—',
    printedBy: me?.name ?? '—',
    printedAt: input.at ?? new Date().toISOString(),
    labels: {
      branch: t('branch'),
      printedAt: t('printed_at'),
      printedBy: t('printed_by'),
      filters: t('filters'),
      // The placeholders are handed back as themselves: the renderers fill
      // them per page, after the last page exists.
      pageOf: t('page_of', { page: '{page}', pages: '{pages}' }),
      watermark: t('watermark'),
      preparedBy: t('prepared_by'),
      approvedBy: t('approved_by'),
      receivedBy: t('received_by'),
    },
  };
}
