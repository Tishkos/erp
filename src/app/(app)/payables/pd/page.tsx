import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import {
  AdminPage,
  Field,
  FilterRow,
  Flash,
  Form,
  Grid,
  ListToolbar,
  Select,
  Submit,
  SubmitRow,
  admin as s,
} from '@/components/admin';
import { Pagination } from '@/components/ui';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as customs from '@/server/services/customs-pd';
import { pdChip } from './status';
import { businessToday } from '@/server/domain/business-date';
import { SavedViewsMenu } from '@/components/saved-views/saved-views-menu';
import { savedViewsFor } from '@/server/saved-views-gate';

/**
 * PDs — REQ-AP-001 §21.8 (REQ-APP-001 S4).
 *
 * The customs pre-declarations, the soonest to expire first: the sheet's PD
 * and Pending tabs in one register. Days left turns red inside the warning
 * window. Drawn as Purchase Invoices is — the module's tabs, one register
 * window, the search box and one filter.
 */
export const dynamic = 'force-dynamic';

const VIEWS = ['live', 'expiring', 'final', 'holding', 'all'] as const;

export default async function PdListPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/payables/pd')) notFound();

  const [t, admin, page, locale, context, outcome] = await Promise.all([
    getTranslations('admin.customs_pd'),
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', customs.PERMISSION_OBJECT)) {
    return <Denied object={page('pds')} />;
  }
  const mayCreate = can(principal, 'create', customs.PERMISSION_OBJECT);
  const mayImport = can(principal, 'import', customs.PERMISSION_OBJECT);

  // The person's saved views of this screen — and, on a bare arrival, their default one.
  const saved = await savedViewsFor('imports.pd', searchParams);
  const params = await searchParams;
  const view = (VIEWS as readonly string[]).includes(String(params.view)) ? (params.view as (typeof VIEWS)[number]) : 'live';
  const applied = typeof params.applied === 'string' ? params.applied : null;
  const today = businessToday();

  const { result, warning } = await withCurrentUser(async (tx) => ({
    result: await customs.listForScreen(tx, { view, search: outcome.q, page: outcome.page }),
    warning: await customs.warningDays(tx),
  }));
  const shown = result.rows;
  const query = (p: number) =>
    [outcome.q ? `q=${encodeURIComponent(outcome.q)}` : '', `view=${view}`, `page=${p}`].filter(Boolean).join('&');
  const ps = (code: string, name: string) => (locale !== 'en' && t.has(`ps.${code}`) ? t(`ps.${code}`) : name);


  return (
    <AdminPage
      actions={
        <>
          {mayCreate ? (
            <Link className="action action--primary" href="/payables/pd/new">
              {t('register')}
            </Link>
          ) : null}
          {mayImport ? (
            <Link className="action action--primary" href="/payables/pd/asycuda">
              {t('asycuda')}
            </Link>
          ) : null}
        </>
      }
      back={{ href: '/', label: admin('dashboard_label') }}
      tabs={<SectionTabs route="/payables/pd" />}
      subtitle={t('subtitle')}
      title={page('pds')}
      variant="sap"
    >
      <Flash
        error={outcome.error}
        errorTitle={admin('error_title')}
        saved={outcome.saved && applied === null ? outcome.saved : false}
        savedLabel={admin('saved')}
      />
      {applied !== null && outcome.saved ? (
        <p className={s.sapNote} role="status">
          {t('applied_n', { count: Number(applied) })}
        </p>
      ) : null}

      <section aria-labelledby="pd-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="pd-list-title">
            <span>{page('pds')}</span>
            <span className={s.sapTitleMeta}>{admin('rows_shown', { count: result.total })}</span>
          </h2>

          <ListToolbar
            clearHref="/payables/pd"
            clearLabel={admin('clear_search')}
            countLabel={admin('rows_shown', { count: result.total })}
            placeholder={admin('search_placeholder')}
            q={outcome.q}
            searchLabel={admin('search')}
          >
            <SavedViewsMenu state={saved} />
          </ListToolbar>

          <form className={s.filterBar} method="get">
            <FilterRow>
              <Select
                defaultValue={view}
                label={t('view')}
                name="view"
                options={VIEWS.map((key) => ({ value: key, label: t(`view_${key}`, { days: warning }) }))}
              />
              <SubmitRow>
                <Submit label={t('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="pd-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{t('pd_no')}</th>
                  <th scope="col">{t('import')}</th>
                  <th scope="col">{t('supplier')}</th>
                  <th scope="col">{t('registered')}</th>
                  <th scope="col">{t('importer_code')}</th>
                  <th scope="col">{t('financier')}</th>
                  <th scope="col">{t('bank')}</th>
                  <th scope="col">{t('invoice_no')}</th>
                  <th scope="col">{t('expires')}</th>
                  <th scope="col">{t('declarant_code')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('days_left')}
                  </th>
                  <th scope="col">{t('status')}</th>
                  <th scope="col">{t('note')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={13}>
                      {t('none')}
                    </td>
                  </tr>
                ) : null}
                {shown.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link
                        className={s.sapLink}
                        href={`/payables/pd/${encodeURIComponent(row.pdNo)}?year=${row.registrationYear}`}
                      >
                        <bdi dir="ltr">{row.pdNo}</bdi>
                      </Link>
                    </td>
                    <td>
                      {row.payableNo ? (
                        <Link className={s.sapLink} href={`/payables/${encodeURIComponent(row.payableNo)}`}>
                          <bdi dir="ltr">{row.payableNo}</bdi>
                        </Link>
                      ) : (
                        <span className="status status--rejected" data-status="rejected">
                          {t('unlinked')}
                        </span>
                      )}
                      {row.reference ? (
                        <div className="muted">
                          <bdi dir="ltr">{row.reference}</bdi>
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <bdi dir="auto">{row.supplierName ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{formatBusinessDate(row.registrationDate, locale as Locale)}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.importerCode ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.financier ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.bankName ? `${row.bankName}${row.bankSwift ? ` · ${row.bankSwift}` : ''}` : '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.invoiceNo ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{formatBusinessDate(row.expiryDate, locale as Locale)}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.declarantCode ?? '—'}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      {row.isTerminal || row.superseded ? (
                        '—'
                      ) : row.daysLeft <= warning ? (
                        <span className="status status--rejected" data-status="rejected">
                          {row.daysLeft}
                        </span>
                      ) : (
                        row.daysLeft
                      )}
                    </td>
                    <td>
                      <span
                        className={`status status--${pdChip(row)} ${s.sapRegisterStatus}`}
                        data-status={pdChip(row)}
                      >
                        {ps(row.statusCode, row.statusName)}
                      </span>
                      {row.superseded ? <div className="muted">{t('superseded')}</div> : null}
                    </td>
                    <td>
                      <bdi dir="auto">{row.lastNote ?? ''}</bdi>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {result.pages > 1 ? (
            <Pagination count={result.pages} current={result.page} hrefFor={(p) => `/payables/pd?${query(p)}`} labels={{ label: admin('pagination'), previous: admin('previous'), next: admin('next'), page: (p) => admin('page_n', { page: p }) }} locale={locale} />
          ) : null}
        </div>
      </section>
    </AdminPage>
  );
}
