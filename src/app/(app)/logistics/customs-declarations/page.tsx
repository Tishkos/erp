import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, FilterRow, Flash, Form, Grid, ListToolbar, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { Pagination } from '@/components/ui';
import { NewRecordDialog } from '@/components/admin/dialog';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { ProfileLink } from '@/components/admin/profile-link';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { declarationChip } from '@domain/import-logistics';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as declarations from '@/server/services/customs-declarations';
import * as rates from '@/server/services/exchange-rates';
import { businessToday } from '@/server/domain/business-date';
import { createDeclaration } from './actions';
import { SavedViewsMenu } from '@/components/saved-views/saved-views-menu';
import { savedViewsFor } from '@/server/saved-views-gate';

/**
 * Customs Declarations — REQ-LOG-001 item 8. What the broker lodged for each
 * import: the register, newest first, with the PD it clears against and the
 * declared figures. Drawn as Purchase Invoices is: the module's tabs, one
 * register window, the search box and one filter; "New declaration" in the
 * header as "Register PD" is on the PDs.
 */
export const dynamic = 'force-dynamic';

const VIEWS = ['open', 'cleared', 'ended', 'all'] as const;

export default async function CustomsDeclarationsPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/logistics/customs-declarations')) notFound();

  const [t, pd, admin, page, locale, context, outcome] = await Promise.all([
    getTranslations('admin.logistics'),
    getTranslations('admin.customs_pd'),
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', declarations.PERMISSION_OBJECT)) {
    return <Denied object={page('customs_declarations')} />;
  }
  const mayCreate = can(principal, 'create', declarations.PERMISSION_OBJECT);

  // The person's saved views of this screen — and, on a bare arrival, their default one.
  const saved = await savedViewsFor('logistics.customs_declarations', searchParams);
  const params = await searchParams;
  const view = (VIEWS as readonly string[]).includes(String(params.view)) ? (params.view as (typeof VIEWS)[number]) : 'open';
  const today = businessToday();

  const { result, imports, currencies } = await withCurrentUser(async (tx) => ({
    result: await declarations.listForScreen(tx, { view, search: outcome.q, page: outcome.page }),
    imports: mayCreate ? await declarations.importChoices(tx) : [],
    // Currencies and Rates' own list, as every other document offers it.
    currencies: mayCreate ? (await rates.currencies(tx)).filter((row) => row.isActive) : [],
  }));
  const shown = result.rows;
  const query = (p: number) => [outcome.q ? `q=${encodeURIComponent(outcome.q)}` : '', `view=${view}`, `page=${p}`].filter(Boolean).join('&');
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');
  const ds = (status: string) => (t.has(`ds.${status}`) ? t(`ds.${status}`) : status);
  const ps = (code: string | null) => (code ? (locale !== 'en' && pd.has(`ps.${code}`) ? pd(`ps.${code}`) : code) : '—');

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <NewRecordDialog buttonLabel={t('new_declaration')} closeLabel={admin('close')} openOnLoad={Boolean(outcome.error)} title={t('new_declaration')}>
            <p className="muted">{t('new_declaration_note')}</p>
            <Form action={createDeclaration}>
              <Grid>
                <Select
                  label={t('import')}
                  name="payable_id"
                  options={imports.map((row) => ({ value: row.id, label: `${row.payableNo} · ${row.reference ?? ''} · ${row.supplierName}` }))}
                  required
                />
                <Field defaultValue={today} label={t('declaration_date')} name="declaration_date" required type="date" />
                <Field hint={t('customs_ref_hint')} label={t('customs_ref')} name="customs_ref" />
                <Field label={t('hs_code')} name="hs_code" />
                <Select
                  defaultValue={currencies[0]?.code}
                  label={t('currency')}
                  name="currency"
                  options={currencies.map((row) => ({ value: row.code, label: `${row.code} · ${row.name}` }))}
                  required
                />
                <Field label={t('declared_value')} name="declared_value" />
                <Field label={t('declared_duty')} name="declared_duty" />
                <Field label={t('declared_taxes')} name="declared_taxes" />
                <Field label={t('declared_fees')} name="declared_fees" />
              </Grid>
              <Field label={t('note')} name="note" wide />
              <SubmitRow>
                <Submit label={t('new_declaration')} />
              </SubmitRow>
            </Form>
          </NewRecordDialog>
        ) : null
      }
      back={{ href: '/', label: admin('dashboard_label') }}
      tabs={<SectionTabs route="/logistics/customs-declarations" />}
      subtitle={t('declarations_subtitle')}
      title={page('customs_declarations')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />

      <section aria-labelledby="declaration-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="declaration-list-title">
            <span>{page('customs_declarations')}</span>
            <span className={s.sapTitleMeta}>{admin('rows_shown', { count: result.total })}</span>
          </h2>
          <ListToolbar
            clearHref="/logistics/customs-declarations"
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
              <Select defaultValue={view} label={t('view')} name="view" options={VIEWS.map((key) => ({ value: key, label: t(`view_${key}`) }))} />
              <SubmitRow>
                <Submit label={t('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>
          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="declaration-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{t('declaration_no')}</th>
                  <th scope="col">{t('customs_ref')}</th>
                  <th scope="col">{t('declaration_date')}</th>
                  <th scope="col">{t('import')}</th>
                  <th scope="col">{t('supplier')}</th>
                  <th scope="col">{t('pd')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('declared_value')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('declared_duty')}
                  </th>
                  <th scope="col">{t('status')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={9}>
                      {t('none_declarations')}
                    </td>
                  </tr>
                ) : null}
                {shown.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link className={s.sapLink} href={`/logistics/customs-declarations/${encodeURIComponent(row.declarationNo)}`}>
                        <bdi dir="ltr">{row.declarationNo}</bdi>
                      </Link>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.customsRef ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{day(row.declarationDate)}</bdi>
                    </td>
                    <td>
                      <ProfileLink code={row.payableNo} kind="import">
                        {row.payableNo}
                        {row.reference ? ` · ${row.reference}` : ''}
                      </ProfileLink>
                    </td>
                    <td>
                      <ProfileLink code={row.supplierCode} dir="auto" kind="supplier">
                        {row.supplierName}
                      </ProfileLink>
                    </td>
                    <td>
                      {row.pdNo ? (
                        <>
                          <ProfileLink code={row.pdNo} kind="pd" qualifier={{ year: row.pdYear }}>
                            {row.pdNo}
                          </ProfileLink>
                          <div className="muted">{ps(row.pdStatusCode)}</div>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{formatMoney(row.declaredValue, row.currency, locale as Locale)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{formatMoney(row.declaredDuty, row.currency, locale as Locale)}</bdi>
                    </td>
                    <td>
                      <span className={`status status--${declarationChip(row.status)} ${s.sapRegisterStatus}`} data-status={declarationChip(row.status)}>
                        {ds(row.status)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {result.pages > 1 ? (
            <Pagination
              count={result.pages}
              current={result.page}
              hrefFor={(p) => `/logistics/customs-declarations?${query(p)}`}
              labels={{ label: admin('pagination'), previous: admin('previous'), next: admin('next'), page: (p) => admin('page_n', { page: p }) }}
              locale={locale}
            />
          ) : null}
        </div>
      </section>
    </AdminPage>
  );
}
