import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import {
  AdminPage,
  Field,
  Flash,
  Form,
  Grid,
  Select,
  Submit,
  SubmitRow,
  admin as s,
} from '@/components/admin';
import { NewRecordDialog } from '@/components/admin/dialog';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as contracts from '@/server/services/recurring-contracts';
import * as departmentsService from '@/server/services/departments';
import * as partners from '@/server/services/partners';
import * as settingsService from '@/server/services/payables-settings';
import { createContract } from './actions';

/**
 * Recurring contracts — REQ-AP-001 §21.4, the standing commitments.
 *
 * One row per contract: what it costs per period, how often, when the next
 * period falls due, and — in red — how many generated periods sit unpaid past
 * their date. The periods themselves are ordinary payables on the workbench;
 * this list is the contracts that keep raising them.
 */
export const dynamic = 'force-dynamic';

export default async function RecurringContractsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/payables/contracts')) notFound();

  const [t, page, locale, context, outcome] = await Promise.all([
    getTranslations('admin.payables_contracts'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);

  const { principal } = context;
  if (!can(principal, 'view', contracts.PERMISSION_OBJECT)) {
    return <Denied object={page('recurring_contracts')} />;
  }
  const mayCreate = can(principal, 'create', contracts.PERMISSION_OBJECT);

  const { rows, suppliers, departments, categories } = await withCurrentUser(async (tx) => ({
    rows: await contracts.listForScreen(tx),
    suppliers: await partners.listActiveInRole(tx, 'supplier'),
    departments: await departmentsService.listAll(tx),
    categories: (await settingsService.overview(tx)).categories.filter((c) => c.active),
  }));

  const money = (amount: string, currency: string) =>
    formatMoney(amount, currency, locale as Locale);
  const day = (value: string | null) =>
    value ? formatBusinessDate(value, locale as Locale) : '—';

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <NewRecordDialog
            buttonLabel={t('new')}
            closeLabel={t('close')}
            openOnLoad={Boolean(outcome.error)}
            title={t('new_title')}
            wide
          >
            <Form action={createContract}>
              <Grid>
                <Select
                  label={t('supplier')}
                  name="supplier_id"
                  options={suppliers.map((p) => ({ value: p.id, label: `${p.name} (${p.code})` }))}
                  required
                />
                <Select
                  label={t('department')}
                  name="department_code"
                  options={departments.map((d) => ({ value: d.code, label: d.name }))}
                  required
                />
                <Select
                  label={t('category')}
                  name="expense_category"
                  options={categories.map((c) => ({ value: c.code, label: c.name }))}
                  required
                />
                <Field defaultValue="USD" label={t('currency')} name="currency" required />
                <Field label={t('amount')} name="amount" required />
                <Select
                  label={t('frequency')}
                  name="frequency"
                  options={[
                    { value: 'monthly', label: t('monthly') },
                    { value: 'quarterly', label: t('quarterly') },
                    { value: 'yearly', label: t('yearly') },
                  ]}
                  required
                />
                <Field label={t('start_date')} name="start_date" required type="date" />
                <Field label={t('end_date')} name="end_date" type="date" />
                <Field
                  defaultValue="day_of_period:1"
                  hint={t('due_rule_hint')}
                  label={t('due_rule')}
                  name="due_rule"
                />
                <Field
                  defaultValue="30"
                  label={t('generate_days_ahead')}
                  name="generate_days_ahead"
                  type="number"
                />
              </Grid>
              <Field label={t('description')} name="description" required wide />
              <label className={s.inline}>
                <input defaultChecked name="auto_confirm" type="checkbox" /> {t('auto_confirm')}
              </label>
              <label className={s.inline}>
                <input name="invoice_expected" type="checkbox" /> {t('invoice_expected')}
              </label>
              <SubmitRow>
                <Submit label={t('create')} />
              </SubmitRow>
            </Form>
          </NewRecordDialog>
        ) : null
      }
      back={{ href: '/payables', label: t('payables')}}
      subtitle={t('subtitle')}
      title={t('title')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <section aria-labelledby="contracts-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="contracts-title">
            <span>{t('title')}</span>
            <span className={s.sapTitleMeta}>{t('rows', { count: rows.length })}</span>
          </h2>

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="contracts-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{t('col_no')}</th>
                  <th scope="col">{t('col_supplier')}</th>
                  <th scope="col">{t('col_department')}</th>
                  <th scope="col">{t('col_category')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('col_amount')}
                  </th>
                  <th scope="col">{t('col_frequency')}</th>
                  <th scope="col">{t('col_next_due')}</th>
                  <th scope="col">{t('col_status')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('col_overdue')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={9}>
                      {t('none')}
                    </td>
                  </tr>
                ) : null}
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link
                        className={s.sapLink}
                        href={`/payables/contracts/${encodeURIComponent(row.contractNo)}`}
                      >
                        <bdi dir="ltr">{row.contractNo}</bdi>
                      </Link>
                    </td>
                    <td>
                      <bdi dir="auto">{row.supplierName}</bdi>
                    </td>
                    <td>{row.departmentCode}</td>
                    <td>{row.categoryName ?? row.expenseCategoryCode}</td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.amountPerPeriodTxn, row.currency)}</bdi>
                    </td>
                    <td>{t(row.frequency)}</td>
                    <td>
                      <bdi dir="ltr">{day(row.nextDue)}</bdi>
                    </td>
                    <td>
                      <span className="status" data-status={row.status === 'active' ? 'approved' : row.status === 'draft' ? 'draft' : 'cancelled'}>
                        {t(`status_${row.status}`)}
                      </span>
                    </td>
                    <td className={s.sapNum}>
                      {row.overduePeriods > 0 ? (
                        <span className="status status--rejected" data-status="rejected">
                          {row.overduePeriods}
                        </span>
                      ) : (
                        <span className="muted">0</span>
                      )}
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
