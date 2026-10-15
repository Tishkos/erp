import { Upload } from 'lucide-react';
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
import { NewRecordDialog } from '@/components/admin/dialog';
import { SectionTabs } from '@/components/admin/section-tabs';
import { draftFromDocumentAction } from './invoices/actions';
import { DatesHidden, RegisterFilter } from '@/components/admin/register-filter';
import { registerDatesOf, registerDatesParams } from '@/server/domain/register-dates';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatMoney, type Locale } from '@/i18n/config';
import { DueDateText } from '@/components/admin/due-date-text';
import { can } from '@domain/permissions';
import { parseDecimal, toDecimalString } from '@domain/money';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as payables from '@/server/services/payables';
import * as settings from '@/server/services/payables-settings';

/**
 * The Payables workbench — REQ-AP-001 §21.2, the one list for everything owed.
 *
 * The sort is the triage order the diagram's red band implies:
 * stopped-without-reason first, then the oldest stop, then what falls due.
 * The saved views are filter controls in the toolbar — a view is a stored
 * filter, so it is offered where the filters live, in the register's own
 * window (the Purchase Invoices list is the model).
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

  const [t, admin, page, locale, context, outcome, params] = await Promise.all([
    getTranslations('admin.payables'),
    getTranslations('admin'),
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

  // D13 — the payable record is the import application; the other types are
  // deactivated (expenses are purchase invoices). The list shows imports.
  let typeFilter: string | null =
    typeof params.type === 'string' && params.type ? params.type : 'import';
  let stoppedFilter: 'yes' | 'no' | 'needs_reason' | null =
    params.stopped === 'yes' || params.stopped === 'no' || params.stopped === 'needs_reason'
      ? params.stopped
      : null;
  // The filters beyond type and stopped (2026-10-15, by direction: "more options — pending etc, much more states").
  const supplierFilter = typeof params.supplier === 'string' && params.supplier ? params.supplier : null;
  const stageFilter = typeof params.stage === 'string' && params.stage ? params.stage : null;
  const paymentFilter = payables.choiceOf(payables.WORKBENCH_PAYMENT_STATES, params.payment);
  const goodsFilter = payables.choiceOf(payables.WORKBENCH_GOODS_PLACES, params.goods);
  const stateFilter = payables.choiceOf(payables.WORKBENCH_STATES, params.state);
  const pageNo = Number(params.page) > 0 ? Number(params.page) : 1;
  const viewParam = typeof params.view === 'string' && params.view ? params.view : null;
  // The Filter's window of document dates and the order — newest first unless asked (2026-10-07).
  const dates = registerDatesOf(params);

  const { rows, total, types, savedViews, suppliers, stages } =
    await withCurrentUser(
    async (tx) => {
      const stored = await payables.workbenchViews(tx);
      // A chosen view is a stored filter: its query becomes the filters, the
      // same way typing them would.
      if (viewParam) {
        const chosen = stored.find((view) => view.id === viewParam);
        const query = chosen
          ? new URLSearchParams(chosen.query as Record<string, string>)
          : new URLSearchParams(
              PRESET_VIEWS.find((view) => view.key === viewParam)?.query ?? '',
            );
        typeFilter = query.get('type');
        stoppedFilter =
          query.get('stopped') === 'yes' ||
          query.get('stopped') === 'no' ||
          query.get('stopped') === 'needs_reason'
            ? (query.get('stopped') as 'yes' | 'no' | 'needs_reason')
            : null;
      }
      const list = await payables.workbench(tx, {
        typeCode: typeFilter,
        stopped: stoppedFilter,
        supplierId: supplierFilter,
        stageCode: stageFilter,
        payment: paymentFilter,
        goods: goodsFilter,
        state: stateFilter,
        search: outcome.q || null,
        page: pageNo,
        pageSize: 50,
        dates,
      });
      const types = await settings.activeTypes(tx);
      return {
        ...list,
        types,
        savedViews: stored,
        suppliers: await payables.workbenchSuppliers(tx, typeFilter),
        stages: await payables.railFor(tx, typeFilter ?? 'import'),
      };
    },
  );

  const money = (amount: string, currency: string) =>
    formatMoney(amount, currency, locale as Locale);
  const daysSince = (since: Date | string) =>
    Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 86_400_000));

  // §21.2 — shared saved-view rows when the seeds exist; the presets until.
  // A view is a stored filter, so each is offered as a choice of the View
  // filter control; choosing one submits its stored query.
  const views =
    savedViews.length > 0
      ? savedViews.map((view) => ({
          key: view.id,
          label: view.name,
          query: new URLSearchParams(view.query).toString(),
        }))
      : PRESET_VIEWS.map((view) => ({ key: view.key, label: t(`view_${view.key}`), query: view.query }));
  const activeView =
    views.find((view) => {
      const q = new URLSearchParams(view.query);
      return (
        (q.get('stopped') ?? null) === stoppedFilter && (q.get('type') ?? null) === typeFilter
      );
    })?.key ?? '';

  // The new filters, carried by the search box and the dates filter.
  const kept: Record<string, string> = {
    ...(supplierFilter ? { supplier: supplierFilter } : {}),
    ...(stageFilter ? { stage: stageFilter } : {}),
    ...(paymentFilter ? { payment: paymentFilter } : {}),
    ...(goodsFilter ? { goods: goodsFilter } : {}),
    ...(stateFilter ? { state: stateFilter } : {}),
  };

  return (
    <AdminPage
      actions={
        // D13 — an import is born at the purchase invoice: the accountant
        // enters the supplier's PDF and ticks Import. There is no second form.
        mayCreate ? (
          <>
            {/*
              The document first, the form second.

              The accountant has the factory's invoice in her hand — a PDF, a
              workbook, a Word file, in Chinese or English — so the system
              takes it and does the typing: the goods, the prices, the
              supplier, with everything it was unsure of written into the
              draft's note. What it produces is a draft, submitted and
              approved by people like any other.
            */}
            <NewRecordDialog
              buttonLabel={t('read_document')}
              closeLabel={admin('close')}
              openOnLoad={Boolean(outcome.error)}
              title={t('read_document_title')}
            >
              <Form action={draftFromDocumentAction}>
                <p className="muted">{t('read_document_hint')}</p>
                <label className={s.uploadPicker}>
                  <Upload aria-hidden="true" />
                  <span>{t('read_document_choose')}</span>
                  <input accept=".pdf,.xlsx,.xls,.docx,.csv,.txt" aria-label={t('read_document_choose')} name="file" required type="file" />
                </label>
                <SubmitRow>
                  <Submit label={t('read_document_submit')} />
                </SubmitRow>
              </Form>
            </NewRecordDialog>
            <Link className="action action--primary" href="/payables/invoices/new">
              {t('new_from_invoice')}
            </Link>
          </>
        ) : null
      }
      back={{ href: '/', label: admin('dashboard_label') }}
      tabs={<SectionTabs route="/payables" />}
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

          <ListToolbar
            clearHref="/payables"
            clearLabel={admin('clear_search')}
            countLabel={admin('rows_shown', { count: rows.length })}
            hidden={{
              ...(viewParam ? { view: viewParam } : {}),
              ...(typeof params.type === 'string' && params.type ? { type: params.type } : {}),
              ...(stoppedFilter && !viewParam ? { stopped: stoppedFilter } : {}),
              ...kept,
              ...registerDatesParams(dates),
            }}
            placeholder={t('workbench_search_placeholder')}
            q={outcome.q}
            searchLabel={admin('search')}
          >
            <RegisterFilter
              dates={dates}
              keep={{
                q: outcome.q,
                view: viewParam,
                type: typeof params.type === 'string' ? params.type : null,
                stopped: typeof params.stopped === 'string' ? params.stopped : null,
                ...kept,
              }}
              path="/payables"
            />
          </ListToolbar>

          {/* The screen's own filters: the saved views and the two facts they
              are made of. Choosing a view submits its stored query. */}
          <form className={s.filterBar} method="get">
            <DatesHidden dates={dates} />
            <FilterRow>
              <Select
                defaultValue={activeView}
                emptyLabel="—"
                label={t('views')}
                name="view"
                options={views.map((view) => ({ value: view.key, label: view.label }))}
              />
              <Select
                defaultValue={typeFilter ?? ''}
                emptyLabel={t('all_types')}
                label={t('type')}
                name="type"
                options={types.map((type) => ({ value: type.code, label: type.name }))}
              />
              <Select
                defaultValue={stoppedFilter ?? ''}
                emptyLabel={t('all_rows')}
                label={t('col_stopped')}
                name="stopped"
                options={[
                  { value: 'yes', label: t('stopped') },
                  { value: 'needs_reason', label: t('needs_reason') },
                  { value: 'no', label: t('moving') },
                ]}
              />
              <Select
                defaultValue={supplierFilter ?? ''}
                emptyLabel={t('filter_all_suppliers')}
                label={t('col_supplier')}
                name="supplier"
                options={suppliers.map((supplier) => ({ value: supplier.id, label: `${supplier.name} (${supplier.code})` }))}
                searchable
              />
              <Select
                defaultValue={stageFilter ?? ''}
                emptyLabel={t('filter_all_stages')}
                label={t('col_stage')}
                name="stage"
                options={stages.filter((stage) => stage.active || stage.code === stageFilter).map((stage) => ({ value: stage.code, label: `${stage.sequence}. ${stage.name}` }))}
              />
              <Select
                defaultValue={paymentFilter ?? ''}
                emptyLabel={t('filter_any_payment')}
                label={t('filter_payment')}
                name="payment"
                options={payables.WORKBENCH_PAYMENT_STATES.map((state) => ({ value: state, label: t(`filter_payment_${state}`) }))}
              />
              <Select
                defaultValue={goodsFilter ?? ''}
                emptyLabel={t('filter_any_goods')}
                label={t('filter_goods')}
                name="goods"
                options={payables.WORKBENCH_GOODS_PLACES.map((place) => ({ value: place, label: t(`journey_now_place_${place}`) }))}
              />
              <Select
                defaultValue={stateFilter ?? ''}
                emptyLabel={t('filter_state_live')}
                label={t('filter_state')}
                name="state"
                options={payables.WORKBENCH_STATES.map((state) => ({ value: state, label: t(`filter_state_${state}`) }))}
              />
              <SubmitRow>
                <Submit label={t('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>

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
                  <th className={s.sapNum} scope="col">
                    {t('col_paid')}
                  </th>
                  <th scope="col">{t('col_stage')}</th>
                  <th scope="col">{t('col_containers')}</th>
                  <th scope="col">{t('col_stopped')}</th>
                  <th scope="col">{t('col_due')}</th>
                  <th scope="col">{t('col_branch')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={11}>
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
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.paidTxn, row.currency)}</bdi>
                      {Number(row.paidTxn) > 0 ? (
                        <div className="muted">
                          {t('remaining_short')}{' '}
                          <bdi dir="ltr">
                            {money(
                              toDecimalString(parseDecimal(row.amountTxn, 4n) - parseDecimal(row.paidTxn, 4n), 4n),
                              row.currency,
                            )}
                          </bdi>
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <span className={`status ${s.sapRegisterStatus}`} data-status="submitted">
                        {row.stageSequence}. {row.stageName}
                        {' · '}
                        {t('days_n', { count: daysSince(row.stageSince) })}
                      </span>
                    </td>
                    <td>
                      {row.containersTotal > 0
                        ? t('x_of_y', { received: row.containersReceived, total: row.containersTotal })
                        : '—'}
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
                      {/* None until an invoice of it was set on purpose — an advance's balance waits for its SWIFT (2026-10-07). */}
                      <DueDateText date={row.dueDate} locale={locale} waiting={row.dueDateWaiting ? admin('balance_due.waiting') : null} />
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
