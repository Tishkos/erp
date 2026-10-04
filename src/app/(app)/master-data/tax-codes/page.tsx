import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AdminPage, Field, FilterRow, Flash, Form, Grid, ListToolbar, Select, Submit, SubmitRow, admin as s, matches } from '@/components/admin';
import { NewRecordDialog } from '@/components/admin/dialog';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import { businessToday } from '@/server/domain/business-date';
import * as chart from '@/server/services/chart-of-accounts';
import * as taxCodes from '@/server/services/tax-codes';
import { createTaxCode } from './actions';

/**
 * Tax Codes — REQ-ACC-001 Part D-5.
 *
 * Every tax code with its treatment, its account and the rate in force
 * today, drawn as Purchase Invoices is: tabs, one register window, the search
 * box and one filter, the status chip last. A code is created from the
 * dialog (its code minted) and changed on its record, where its rates are
 * added from a date and never edited.
 */
export const dynamic = 'force-dynamic';

const VIEWS = ['input', 'output', 'inactive'] as const;

export default async function TaxCodesPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/master-data/tax-codes')) notFound();

  const [t, admin, page, status, context, outcome] = await Promise.all([
    getTranslations('admin.tax_codes'),
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('status'),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', taxCodes.PERMISSION_OBJECT)) {
    return <Denied object={page('tax_codes')} />;
  }
  const mayCreate = can(principal, 'create', taxCodes.PERMISSION_OBJECT);

  const params = await searchParams;
  const view = (VIEWS as readonly string[]).includes(String(params.view)) ? (params.view as (typeof VIEWS)[number]) : null;

  const { rows, accounts } = await withCurrentUser(async (tx) => ({
    rows: await taxCodes.listAll(tx),
    // A tax account is a posting account and never a control account.
    accounts: mayCreate ? (await chart.postableAccounts(tx)).filter((account) => !account.controlAccount) : [],
  }));
  const shown = rows
    .filter((row) => matches(row, outcome.q))
    .filter((row) => (view === 'inactive' ? !row.active : view ? row.active && row.direction === view : true));
  const percent = (rate: string | null) => (rate === null ? '—' : `${rate.replace(/\.?0+$/, '')}%`);

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <NewRecordDialog
            buttonLabel={t('new')}
            closeLabel={admin('close')}
            openOnLoad={params.tax === 'new' && Boolean(outcome.error)}
            title={t('new')}
          >
            <p className="muted">{t('new_note')}</p>
            <Form action={createTaxCode}>
              <Grid>
                <Field label={t('name')} name="name" required />
                <Select
                  label={t('direction')}
                  name="direction"
                  options={taxCodes.TAX_DIRECTIONS.map((key) => ({ value: key, label: t(`direction_${key}`) }))}
                  required
                />
                <Select
                  label={t('recoverable')}
                  name="recoverable"
                  options={[
                    { value: 'yes', label: t('recoverable_yes') },
                    { value: 'no', label: t('recoverable_no') },
                  ]}
                  required
                />
                <Select
                  label={t('account')}
                  name="account_id"
                  options={accounts.map((account) => ({ value: account.id, label: `${account.code} · ${account.name}` }))}
                  required
                />
                <Field hint={t('rate_hint')} label={t('rate')} name="rate" required />
                <Field defaultValue={businessToday()} label={t('effective_from')} name="effective_from" required type="date" />
              </Grid>
              <SubmitRow>
                <Submit label={t('create')} />
              </SubmitRow>
            </Form>
          </NewRecordDialog>
        ) : null
      }
      back={{ href: '/', label: admin('dashboard_label') }}
      tabs={<SectionTabs route="/master-data/tax-codes" />}
      subtitle={t('subtitle')}
      title={page('tax_codes')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />

      <section aria-labelledby="tax-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="tax-list-title">
            <span>{page('tax_codes')}</span>
            <span className={s.sapTitleMeta}>{admin('rows_shown', { count: shown.length })}</span>
          </h2>

          <ListToolbar
            clearHref="/master-data/tax-codes"
            clearLabel={admin('clear_search')}
            countLabel={admin('rows_shown', { count: shown.length })}
            placeholder={admin('search_placeholder')}
            q={outcome.q}
            searchLabel={admin('search')}
          />

          <form className={s.filterBar} method="get">
            <FilterRow>
              <Select
                defaultValue={view ?? ''}
                emptyLabel={t('view_all')}
                label={t('view')}
                name="view"
                options={VIEWS.map((key) => ({ value: key, label: t(`view_${key}`) }))}
              />
              <SubmitRow>
                <Submit label={t('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="tax-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{t('code')}</th>
                  <th scope="col">{t('name')}</th>
                  <th scope="col">{t('direction')}</th>
                  <th scope="col">{t('recoverable')}</th>
                  <th scope="col">{t('account')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('current_rate')}
                  </th>
                  <th scope="col">{t('status')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={7}>
                      {t('none')}
                    </td>
                  </tr>
                ) : null}
                {shown.map((row) => (
                  <tr key={row.code}>
                    <td>
                      <Link className={s.sapLink} href={`/master-data/tax-codes/${encodeURIComponent(row.code)}`}>
                        <bdi dir="ltr">{row.code}</bdi>
                      </Link>
                    </td>
                    <td>
                      <bdi dir="auto">{row.name}</bdi>
                    </td>
                    <td>{t(`direction_${row.direction}`)}</td>
                    <td>{row.isRecoverable ? t('recoverable_yes') : t('recoverable_no')}</td>
                    <td>
                      <bdi dir="auto">{`${row.accountCode} · ${row.accountName}`}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{percent(row.currentRate)}</bdi>
                    </td>
                    <td>
                      <span
                        className={`status status--${row.active ? 'posted' : 'cancelled'} ${s.sapRegisterStatus}`}
                        data-status={row.active ? 'posted' : 'cancelled'}
                      >
                        {row.active ? admin('active') : status('cancelled')}
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
