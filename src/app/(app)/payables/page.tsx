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
import * as partners from '@/server/services/partners';
import * as departmentsService from '@/server/services/departments';
import * as payables from '@/server/services/payables';
import * as settings from '@/server/services/payables-settings';
import { createPayable } from './actions';

/**
 * The Payables workbench — REQ-AP-001 §21.2, the one list for everything owed.
 *
 * The sort is the triage order the diagram's red band implies:
 * stopped-without-reason first, then the oldest stop, then what falls due.
 * The seed views are the filter presets the sheet's "accountant report"
 * sections became — views, not a report.
 */
export const dynamic = 'force-dynamic';

/** The fallback until the 0230 seed rows exist on this database. */
const PRESET_VIEWS: readonly { key: string; query: string }[] = [
  { key: 'all_open', query: '' },
  { key: 'needs_reason', query: 'stopped=needs_reason' },
  { key: 'stopped', query: 'stopped=yes' },
  { key: 'imports', query: 'type=import' },
  { key: 'contracts', query: 'type=recurring' },
];

export default async function PayablesWorkbench({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/payables')) notFound();

  const [t, page, locale, context, outcome, params] = await Promise.all([
    getTranslations('admin.payables'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    searchParams,
  ]);

  const { principal } = context;
  if (!can(principal, 'view', payables.PERMISSION_OBJECT)) {
    return <Denied object={page('payables_workbench')} />;
  }
  const mayCreate = can(principal, 'create', payables.PERMISSION_OBJECT);

  const typeFilter = typeof params.type === 'string' ? params.type : null;
  const stoppedFilter =
    params.stopped === 'yes' || params.stopped === 'no' || params.stopped === 'needs_reason'
      ? params.stopped
      : null;
  const pageNo = Number(params.page) > 0 ? Number(params.page) : 1;

  const { rows, total, types, suppliers, departments, categories, savedViews } =
    await withCurrentUser(
    async (tx) => {
      const list = await payables.workbench(tx, {
        typeCode: typeFilter,
        stopped: stoppedFilter,
        search: outcome.q || null,
        page: pageNo,
        pageSize: 50,
      });
      const config = await settings.overview(tx);
      return {
        ...list,
        types: config.types.filter((type) => type.active),
        categories: config.categories.filter((c) => c.active),
        suppliers: await partners.listActiveInRole(tx, 'supplier'),
        departments: await departmentsService.listAll(tx),
        savedViews: await payables.workbenchViews(tx),
      };
    },
  );

  const money = (amount: string, currency: string) =>
    formatMoney(amount, currency, locale as Locale);
  const day = (value: string | null) =>
    value ? formatBusinessDate(value, locale as Locale) : '—';
  const daysSince = (since: Date | string) =>
    Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 86_400_000));

  // §21.2 — shared saved-view rows when the seeds exist; the presets until.
  const views =
    savedViews.length > 0
      ? savedViews.map((view) => ({
          key: view.id,
          label: view.name,
          query: new URLSearchParams(view.query).toString(),
        }))
      : PRESET_VIEWS.map((view) => ({ key: view.key, label: t(`view_${view.key}`), query: view.query }));
  const viewQuery = (query: string) => (query ? `/payables?${query}` : '/payables');
  const activeView =
    views.find((view) => {
      const q = new URLSearchParams(view.query);
      return (
        (q.get('stopped') ?? null) === stoppedFilter && (q.get('type') ?? null) === typeFilter
      );
    })?.key ?? null;

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
            <Form action={createPayable}>
              <Grid>
                <Select
                  label={t('type')}
                  name="payable_type"
                  options={types.map((type) => ({ value: type.code, label: type.name }))}
                  required
                />
                <Select
                  label={t('supplier')}
                  name="supplier_id"
                  options={suppliers.map((p) => ({ value: p.id, label: `${p.name} (${p.code})` }))}
                  required
                />
                <Field label={t('reference')} name="supplier_reference" required />
                <Field label={t('document_date')} name="document_date" required type="date" />
                <Field defaultValue="USD" label={t('currency')} name="currency" required />
                <Field hint={t('amount_hint')} label={t('amount')} name="amount" />
                <Select
                  emptyLabel="—"
                  label={t('department')}
                  name="department_code"
                  options={departments.map((d) => ({ value: d.code, label: d.name }))}
                />
                <Select
                  emptyLabel="—"
                  label={t('category')}
                  name="expense_category"
                  options={categories.map((c) => ({ value: c.code, label: c.name }))}
                />
                <Field label={t('due_date')} name="due_date" type="date" />
              </Grid>
              <Field label={t('description')} name="description" required wide />
              <Field label={t('terms')} name="payment_terms" wide />
              <input name="line_count" type="hidden" value="5" />
              <div className={s.sapTableWrap}>
                <table className={s.sapTable}>
                  <thead>
                    <tr>
                      <th scope="col">{t('line_item')}</th>
                      <th scope="col">{t('line_description')}</th>
                      <th scope="col">{t('line_quantity')}</th>
                      <th scope="col">{t('line_uom')}</th>
                      <th scope="col">{t('line_price')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[0, 1, 2, 3, 4].map((index) => (
                      <tr key={index}>
                        <td>
                          <input className={s.input} name={`line_${index}_item`} />
                        </td>
                        <td>
                          <input className={s.input} name={`line_${index}_description`} />
                        </td>
                        <td>
                          <input className={s.input} inputMode="decimal" name={`line_${index}_quantity`} />
                        </td>
                        <td>
                          <input className={s.input} defaultValue="EA" name={`line_${index}_uom`} />
                        </td>
                        <td>
                          <input className={s.input} inputMode="decimal" name={`line_${index}_price`} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted">{t('lines_hint')}</p>
              <SubmitRow>
                <Submit label={t('create')} />
              </SubmitRow>
            </Form>
          </NewRecordDialog>
        ) : null
      }
      back={{ href: '/', label: t('dashboard') }}
      subtitle={t('subtitle')}
      title={t('title')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <section aria-labelledby="payables-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="payables-title">
            <span>{t('title')}</span>
            <span className={s.sapTitleMeta}>{t('rows', { count: total })}</span>
          </h2>

          <div className={s.sapFootActions}>
            <nav aria-label={t('views')}>
              {views.map((view) => (
                <Link
                  aria-current={activeView === view.key ? 'page' : undefined}
                  className={`${s.button} ${s.small}${activeView === view.key ? ` ${s.primary}` : ''}`}
                  href={viewQuery(view.query)}
                  key={view.key}
                >
                  {view.label}
                </Link>
              ))}
            </nav>
            <form action="/payables" method="get">
              {typeFilter ? <input name="type" type="hidden" value={typeFilter} /> : null}
              {stoppedFilter ? <input name="stopped" type="hidden" value={stoppedFilter} /> : null}
              <input
                aria-label={t('search')}
                className={s.input}
                defaultValue={outcome.q}
                name="q"
                placeholder={t('search_placeholder')}
                type="search"
              />
              <button className={`${s.button} ${s.small}`} type="submit">
                {t('search')}
              </button>
            </form>
          </div>

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="payables-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{t('col_no')}</th>
                  <th scope="col">{t('col_type')}</th>
                  <th scope="col">{t('col_reference')}</th>
                  <th scope="col">{t('col_supplier')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('col_amount')}
                  </th>
                  <th scope="col">{t('col_stage')}</th>
                  <th scope="col">{t('col_stopped')}</th>
                  <th scope="col">{t('col_due')}</th>
                  <th scope="col">{t('col_branch')}</th>
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
                      <Link className={s.sapLink} href={`/payables/${encodeURIComponent(row.payableNo)}`}>
                        <bdi dir="ltr">{row.payableNo}</bdi>
                      </Link>
                    </td>
                    <td>{row.typeName}</td>
                    <td>
                      <bdi dir="ltr">{row.reference}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.supplierName}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.amountTxn, row.currency)}</bdi>
                    </td>
                    <td>
                      <span className={`status ${s.sapRegisterStatus}`} data-status="submitted">
                        {row.stageSequence}. {row.stageName}
                        {' · '}
                        {t('days_n', { count: daysSince(row.stageSince) })}
                      </span>
                    </td>
                    <td>
                      {row.needsReason ? (
                        <span className="status status--rejected" data-status="rejected">
                          {t('needs_reason')}
                        </span>
                      ) : row.onHold ? (
                        <span className="status status--rejected" data-status="rejected">
                          {row.hold?.reasonCode ?? t('stopped')}
                          {row.hold?.startedAt
                            ? ` · ${t('days_n', { count: daysSince(row.hold.startedAt) })}`
                            : ''}
                        </span>
                      ) : (
                        <span className="muted">{t('moving')}</span>
                      )}
                    </td>
                    <td>
                      <bdi dir="ltr">{day(row.dueDate)}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.branchCode}</bdi>
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
