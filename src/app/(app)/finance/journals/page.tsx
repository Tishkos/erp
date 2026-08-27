import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import {
  AdminPage,
  Field,
  Flash,
  Form,
  Grid,
  ListToolbar,
  NewRecordDialog,
  Submit,
  SubmitRow,
  admin as s,
  matches,
} from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as journal from '@/server/services/journal';
import { startJournal } from './actions';

/**
 * Journal Entries — Phase 1 requirement 2.
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
  const today = new Date().toISOString().slice(0, 10);

  const { rows, inFinance } = await withCurrentUser(async (tx) => ({
    rows: await journal.listAll(tx),
    // §14 — an entry can only be raised from a Finance department, so say so
    // here rather than after the entry has been filled in and refused.
    inFinance: await journal.isInFinanceDepartment(tx, principal.userId),
  }));
  // A month arrives from the fiscal calendar: one press on a period shows
  // what was posted into it. The filter reads the posting date, which is the
  // date that decided the period (§14.6).
  const params = await searchParams;
  const month = typeof params.month === 'string' && /^d{4}-d{2}$/.test(params.month)
    ? params.month
    : null;
  const shown = rows
    .filter((row) => matches(row, outcome.q))
    .filter((row) => (month ? row.postingDate.startsWith(month) : true));

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <NewRecordDialog
            buttonLabel={t('journals.new')}
            closeLabel={t('close')}
            openOnLoad={Boolean(outcome.error)}
            title={t('journals.new')}
          >
            {/* Only the two dates and a description: the lines go on the
                entry itself, where the running total can be seen. */}
            <Form action={startJournal}>
              <Grid>
                <Field
                  defaultValue={today}
                  hint={t('journals.document_date_hint')}
                  label={t('journals.document_date')}
                  name="documentDate"
                  type="date"
                />
                <Field
                  defaultValue={today}
                  hint={t('journals.posting_date_hint')}
                  label={t('journals.posting_date')}
                  name="postingDate"
                  type="date"
                  required
                  requiredLabel={t('required_hint')}
                />
                <Field label={t('journals.description')} name="description" type="textarea" wide />
              </Grid>
              <SubmitRow>
                <Submit label={t('create')} />
              </SubmitRow>
            </Form>
          </NewRecordDialog>
        ) : null
      }
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
      {mayCreate && !inFinance ? (
        <p className={s.sectionHint}>{t('journals.not_in_finance')}</p>
      ) : null}

      <section aria-labelledby="journal-register-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="journal-register-title">
            <span>{t('journals.register')}</span>
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
            <table
              aria-labelledby="journal-register-title"
              className={`${s.sapTable} ${s.sapRegisterTable}`}
            >
              <thead>
                <tr>
                  <th scope="col">{column('reference')}</th>
                  <th scope="col">{t('journals.posting_date')}</th>
                  <th scope="col">{t('journals.description')}</th>
                  <th className={s.sapNum} scope="col">
                    {column('amount')}
                  </th>
                  <th scope="col">{column('branch_code')}</th>
                  <th scope="col">{t('journals.raised_by')}</th>
                  <th scope="col">{column('status')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={7}>
                      {t('rows_shown', { count: 0 })}
                    </td>
                  </tr>
                ) : null}
                {shown.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link
                        className={s.sapLink}
                        href={`/finance/journals/${encodeURIComponent(row.entryNo)}`}
                      >
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
                    <td>
                      <bdi dir="ltr">{row.branchCode}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.raisedBy ?? '—'}</bdi>
                    </td>
                    <td>
                      <span
                        className={`status status--${row.status} ${s.sapRegisterStatus}`}
                        data-status={row.status}
                      >
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
