import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, ListToolbar, admin as s, matches } from '@/components/admin';
import { ReadyButton } from '@/components/admin/ready-button';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as journal from '@/server/services/journal';
import * as attachments from '@/server/services/attachments';
import { startJournal } from './actions';

/**
 * Journal Entries — Phase 1 requirement 2.
 *
 * The table of entries, and one button. "New journal" opens the entry at
 * once, numbered and dated today, so the person is typing lines a moment
 * after pressing it (by direction, 2026-08-29).
 *
 * The list is what the person's branch scope allows; the database decides
 * that, not this page. What may be done with any one of them is decided on
 * the entry itself.
 */
export const dynamic = 'force-dynamic';

export default async function JournalsPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/finance/journals')) notFound();

  const [t, page, column, status, locale, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getTranslations('status'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', journal.PERMISSION_OBJECT)) {
    return <Denied object={page('journal_entry')} />;
  }
  const mayCreate = can(principal, 'create', journal.PERMISSION_OBJECT);

  const { rows, files, inFinance } = await withCurrentUser(async (tx) => ({
    rows: await journal.listAll(tx),
    files: await attachments.countByObject(tx, journal.PERMISSION_OBJECT),
    // §14 — an entry can only be raised from a Finance department, so say so
    // here rather than after the entry has been opened and refused.
    inFinance: await journal.isInFinanceDepartment(tx, principal.userId),
  }));
  // A month arrives from the fiscal calendar: one press on a period shows
  // what was posted into it. The filter reads the posting date, which is the
  // date that decided the period (§14.6).
  const params = await searchParams;
  const month = typeof params.month === 'string' && /^\d{4}-\d{2}$/.test(params.month) ? params.month : null;
  const shown = rows
    .filter((row) => matches(row, outcome.q))
    .filter((row) => (month ? row.postingDate.startsWith(month) : true));

  return (
    <AdminPage
      actions={mayCreate && inFinance ? <ReadyButton action={startJournal} label={t('journals.new')} /> : null}
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/finance/journals" />}
      subtitle={t('journals.subtitle')}
      title={t('journals.title')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />
      {month ? (
        <p className={s.sectionHint}>
          {t('journals.month_filter', { month })}{' '}
          <Link className={s.sapLink} href="/finance/journals">
            {t('clear_search')}
          </Link>
        </p>
      ) : null}
      {mayCreate && !inFinance ? <p className={s.sectionHint}>{t('journals.not_in_finance')}</p> : null}

      <section aria-labelledby="journal-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="journal-list-title">
            <span>{t('journals.title')}</span>
            <span className={s.sapTitleMeta}>{t('rows_shown', { count: shown.length })}</span>
          </h2>

          <ListToolbar
            clearHref="/finance/journals"
            clearLabel={t('clear_search')}
            countLabel={t('rows_shown', { count: shown.length })}
            placeholder={t('search_placeholder')}
            q={outcome.q}
            searchLabel={t('search')}
          />

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="journal-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{column('reference')}</th>
                  <th scope="col">{t('journals.posting_date')}</th>
                  <th scope="col">{t('journals.description')}</th>
                  <th className={s.sapNum} scope="col">
                    {column('amount')}
                  </th>
                  <th aria-label={t('journals.attachments_col')} scope="col" title={t('journals.attachments_col')}>
                    📎
                  </th>
                  <th scope="col">{column('branch_code')}</th>
                  <th scope="col">{t('journals.raised_by')}</th>
                  <th scope="col">{column('status')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={8}>
                      {t('rows_shown', { count: 0 })}
                    </td>
                  </tr>
                ) : null}
                {shown.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link className={s.sapLink} href={`/finance/journals/${encodeURIComponent(row.entryNo)}`}>
                        <bdi dir="ltr">{row.entryNo}</bdi>
                      </Link>
                    </td>
                    <td>
                      <bdi dir="ltr">{formatBusinessDate(row.postingDate, locale as Locale)}</bdi>
                    </td>
                    <td>
                      <span className={s.sapRegisterDescription} title={row.description ?? undefined}>
                        <bdi dir="auto">{row.description ?? '—'}</bdi>
                      </span>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{formatMoney(row.totalDebitIqd, 'IQD', locale as Locale)}</bdi>
                    </td>
                    <td className={s.sapNum}>{files.get(row.id) ?? '—'}</td>
                    <td>
                      <bdi dir="ltr">{row.branchCode}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.raisedBy ?? '—'}</bdi>
                    </td>
                    <td>
                      <span className={`status status--${row.status} ${s.sapRegisterStatus}`} data-status={row.status}>
                        {status(row.status)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </AdminPage>
  );
}
