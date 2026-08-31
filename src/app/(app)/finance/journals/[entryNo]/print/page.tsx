import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { eq } from 'drizzle-orm';
import mainLogo from '../../../../../../../mainLogo.png';
import { formatBusinessDate, formatMoney, formatTimestamp, type Locale } from '@/i18n/config';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '@domain/money';
import { can } from '@domain/permissions';
import { appUser } from '@/server/db/schema';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as companyService from '@/server/services/company';
import * as journal from '@/server/services/journal';
import styles from '@/components/print/print.module.css';
import { PrintButton } from '@/components/print/print-button';

/**
 * The journal voucher, on paper — requested with the logo, in either language.
 *
 * A separate route rather than a print stylesheet over the workspace: paper
 * answers different questions. It says whose document this is (the
 * letterhead), what moved (the lines, ruled), and who stands behind it (the
 * provenance line and the signature rules) — and it says so in black on
 * white whatever palette the person works in, because the printout outlives
 * the screen it came from.
 *
 * `?lang=en|ar` picks the language of the *document*, independently of the
 * session: an Arabic-working accountant prints an English voucher for an
 * English-reading auditor without touching their own settings. The PDF is the
 * browser's print dialog — every platform ships one, and none is maintained
 * here.
 *
 * "Printed by … on … · branch …" comes from the session and the clock, not
 * from the document: it says who produced this piece of paper, which is the
 * provenance a copy in a file needs years later.
 */
export const dynamic = 'force-dynamic';

export default async function JournalPrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ entryNo: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!visibleRoute('/finance/journals')) notFound();

  const [{ entryNo: raw }, sp, context] = await Promise.all([
    params,
    searchParams,
    requireContext(),
  ]);
  const entryNo = decodeURIComponent(raw);
  if (!can(context.principal, 'view', journal.PERMISSION_OBJECT)) notFound();

  const lang: Locale = sp.lang === 'ar' ? 'ar' : 'en';
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  const [t, status] = await Promise.all([
    getTranslations({ locale: lang, namespace: 'admin' }),
    getTranslations({ locale: lang, namespace: 'status' }),
  ]);

  const data = await withCurrentUser(async (tx) => {
    try {
      const detail = await journal.detail(tx, entryNo);
      const [me] = await tx
        .select({ displayName: appUser.displayName })
        .from(appUser)
        .where(eq(appUser.id, context.principal.userId))
        .limit(1);
      return { ...detail, company: await companyService.current(tx), me: me?.displayName ?? '' };
    } catch {
      return null;
    }
  });
  if (!data) notFound();
  const { header, lines, raisedBy, approvedBy, company, me } = data;

  const money = (amount: string) => formatMoney(amount, 'IQD', lang);
  const entered = (amount: string, currency: string) => formatMoney(amount, currency, lang);
  const zero = (amount: string) => Number(amount) === 0;

  // USD equivalents summed in minor units, the same arithmetic the entry
  // screen uses — a voucher that disagreed with the screen would be worse
  // than no voucher.
  const sum = (of: (line: (typeof lines)[number]) => string) =>
    toDecimalString(
      lines.reduce((total, line) => total + parseDecimal(of(line), MONEY_SCALE), 0n),
      MONEY_SCALE,
    );

  const printedAt = formatTimestamp(new Date().toISOString(), lang);

  return (
    <div dir={dir}>
      <div className={styles.toolbar}>
        <PrintButton label={t('journals.print')} />
        <Link className={styles.quiet} href={`/finance/journals/${encodeURIComponent(entryNo)}/print?lang=en`}>
          English
        </Link>
        <Link className={styles.quiet} href={`/finance/journals/${encodeURIComponent(entryNo)}/print?lang=ar`}>
          العربية
        </Link>
        <Link className={styles.quiet} href={`/finance/journals/${encodeURIComponent(entryNo)}`}>
          {t('journals.print_back')}
        </Link>
      </div>

      <div className={styles.sheet}>
        <header className={styles.head}>
          <Image alt="" src={mainLogo} />
          <div className={styles.company}>
            <strong>{company?.legalName ?? 'Qimah Al-Safinah'}</strong>
            {company?.address ? <span>{company.address}</span> : null}
          </div>
          <div className={styles.docname}>
            <strong>{t('journals.print_title')}</strong>
            <span>
              {header.entryNo} · {status(header.status)}
            </span>
          </div>
        </header>

        <dl className={styles.facts}>
          <div>
            <dt>{t('journals.entry_no')}</dt>
            <dd>{header.entryNo}</dd>
          </div>
          <div>
            <dt>{t('journals.posting_date')}</dt>
            <dd>{formatBusinessDate(header.postingDate, lang)}</dd>
          </div>
          <div>
            <dt>{t('journals.document_date')}</dt>
            <dd>{formatBusinessDate(header.documentDate, lang)}</dd>
          </div>
          <div>
            <dt>{t('journals.raised_by')}</dt>
            <dd>{raisedBy ?? '—'}</dd>
          </div>
          <div>
            <dt>{t('journals.approved_by')}</dt>
            <dd>{approvedBy ?? '—'}</dd>
          </div>
          <div>
            <dt>{t('journals.description')}</dt>
            <dd>{header.description ?? '—'}</dd>
          </div>
        </dl>

        <table className={styles.lines}>
          <thead>
            <tr>
              <th>#</th>
              <th>{t('journals.account')}</th>
              <th>{t('journals.currency')}</th>
              <th className={styles.num}>{t('journals.debit')}</th>
              <th className={styles.num}>{t('journals.credit')}</th>
              <th className={styles.num}>
                {t('journals.debit')} — IQD
              </th>
              <th className={styles.num}>
                {t('journals.credit')} — IQD
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.id}>
                <td>{line.lineNo}</td>
                <td>
                  {line.accountCode} · {line.accountName}
                </td>
                <td>{line.currency}</td>
                <td className={styles.num}>
                  {zero(line.debitTxn) ? '' : entered(line.debitTxn, line.currency)}
                </td>
                <td className={styles.num}>
                  {zero(line.creditTxn) ? '' : entered(line.creditTxn, line.currency)}
                </td>
                <td className={styles.num}>{zero(line.debitIqd) ? '' : money(line.debitIqd)}</td>
                <td className={styles.num}>{zero(line.creditIqd) ? '' : money(line.creditIqd)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={5}>{t('journals.total')}</td>
              <td className={styles.num}>{money(header.totalDebitIqd)}</td>
              <td className={styles.num}>{money(header.totalCreditIqd)}</td>
            </tr>
            <tr>
              <td colSpan={5}>{t('journals.amount_usd')}</td>
              <td className={styles.num}>{formatMoney(sum((l) => l.debitUsd), 'USD', lang)}</td>
              <td className={styles.num}>{formatMoney(sum((l) => l.creditUsd), 'USD', lang)}</td>
            </tr>
          </tfoot>
        </table>

        <p className={styles.provenance}>
          {t('journals.printed_line', {
            name: me,
            when: printedAt,
            branch: context.scope.branchCode || '—',
          })}
        </p>

        <div className={styles.signatures}>
          <span>{t('journals.signature_prepared')}</span>
          <span>{t('journals.signature_approved')}</span>
          <span>{t('journals.signature_received')}</span>
        </div>
      </div>
    </div>
  );
}
