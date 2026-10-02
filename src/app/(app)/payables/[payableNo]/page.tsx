import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import {
  AdminPage,
  Checkbox,
  Field,
  FilterRow,
  Flash,
  Form,
  Grid,
  Hidden,
  ReasonForm,
  Select,
  Submit,
  SubmitRow,
  admin as s,
} from '@/components/admin';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { NewRecordDialog } from '@/components/admin/dialog';
import { Attachments } from '@/components/admin/attachments';
import { RecordHistory } from '@/components/admin/history';
import { SectionTabs } from '@/components/admin/section-tabs';
import { StopDialog } from '@/components/admin/stop-dialog';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatMoney, formatQuantity, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { PENDING_REASON } from '@domain/payables';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import { loadPayableRecord } from './load';
import * as events from '@/server/services/payable-events';
import * as payables from '@/server/services/payables';
import * as paymentApplications from '@/server/services/payment-applications';
import * as customs from '@/server/services/customs-pd';
import * as banksService from '@/server/services/banks';
import * as shipmentsService from '@/server/services/shipments';
import * as loansService from '@/server/services/loans';
import * as landedService from '@/server/services/landed-cost';
import * as settingsService from '@/server/services/payables-settings';
import * as contracts from '@/server/services/recurring-contracts';
import * as serviceReceipts from '@/server/services/service-receipt';
import * as users from '@/server/services/users';
import {
  addNote,
  attachToPayable,
  cancelPayable,
  completeHold,
  linkInvoice,
  resolveHold,
  setTerms,
  updateHold,
  updatePiLines,
} from '../actions';
import { createApplication, planInstalmentsAction } from '../payment-applications/actions';
import { registerPd } from '../pd/actions';
import { pdChip } from '../pd/status';
import { createBlAction } from '../shipments/actions';
import { addLandedCharge, lockLandedCost, settleExchangeDifference, withdrawLandedCharge } from '../actions';
import { containerChip } from '../containers/status';
import { STATUS_CHIP, statusKey } from '../payment-applications/status';
import { businessDateOf, businessToday } from '@/server/domain/business-date';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '@domain/money';
import { isNotFoundError } from '@/server/not-found';

/**
 * The payable page — REQ-AP-001 §21.3, the one record everybody opens.
 *
 * It wears the Purchase Invoice's window because it is the same kind of thing:
 * a numbered document with header fields, a grid of lines, and a foot where
 * what may be done to it sits beside what it comes to. The stage rail is a
 * header field; a red note under the header is a stop. Below the window, the
 * record's own registers in the statement's manner: the invoices against it,
 * the service confirmations, the status log, the attachments and the history —
 * stacked, not tabbed, so nothing on the record hides behind a click.
 */
export const dynamic = 'force-dynamic';

export default async function PayablePage({
  params,
  searchParams,
}: {
  params: Promise<{ payableNo: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/payables')) notFound();

  const { payableNo } = await params;
  const [t, pa, cp, sh, lo, lc, admin, pageT, statusT, locale, context, outcome, query] = await Promise.all([
    getTranslations('admin.payables'),
    getTranslations('admin.payment_applications'),
    getTranslations('admin.customs_pd'),
    getTranslations('admin.shipments'),
    getTranslations('admin.loans'),
    getTranslations('admin.landed_cost'),
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('status'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    searchParams,
  ]);

  const { principal } = context;
  if (!can(principal, 'view', payables.PERMISSION_OBJECT)) {
    return <Denied object={pageT('payables_workbench')} />;
  }
  const mayEdit = can(principal, 'edit_draft', payables.PERMISSION_OBJECT);
  const mayCancel = can(principal, 'reverse_cancel', payables.PERMISSION_OBJECT);
  const mayPay = can(principal, 'create', paymentApplications.PERMISSION_OBJECT);
  const mayViewPd = can(principal, 'view', customs.PERMISSION_OBJECT);
  const mayRegisterPd = can(principal, 'create', customs.PERMISSION_OBJECT);
  const mayViewShipment = can(principal, 'view', shipmentsService.CONTAINER_OBJECT);
  const mayViewLoans = can(principal, 'view', loansService.PERMISSION_OBJECT);
  const mayViewLanded = can(principal, 'view', landedService.PERMISSION_OBJECT);
  const mayAddCharge = can(principal, 'create', landedService.PERMISSION_OBJECT);
  const mayLock = can(principal, 'post', landedService.PERMISSION_OBJECT);
  const mayWithdraw = can(principal, 'reverse_cancel', landedService.PERMISSION_OBJECT);
  const mayCreateBl = can(principal, 'create', shipmentsService.BL_OBJECT);

  const laneFilter = typeof query.lane === 'string' && query.lane ? query.lane : null;

  const found = await withCurrentUser((tx) =>
    loadPayableRecord(tx, {
      payableNo,
      laneFilter,
      logSearch: typeof query.logq === 'string' ? query.logq : null,
      logPage: outcome.page,
      may: { edit: mayEdit, pay: mayPay, viewPd: mayViewPd, registerPd: mayRegisterPd, viewShipment: mayViewShipment, createBl: mayCreateBl, viewLoans: mayViewLoans, viewLanded: mayViewLanded, addCharge: mayAddCharge, lock: mayLock },
    }),
  );
  if (!found) notFound();

  const {
    payable: row,
    type,
    rail,
    lanes,
    lines,
    invoices,
    holds,
    supplier,
    log,
    reasons,
    people,
    receipts,
    contract,
    instalments,
    applied,
    paymentTotals,
    exchangeOpen,
    funding,
    pickers,
    pds,
    pdPickers,
    shipment,
    blPorts,
    landed,
  } = found;
  const openPay = query.pay === '1';

  const money = (amount: string, currency = row.currency) =>
    formatMoney(amount, currency, locale as Locale);
  const day = (value: string | Date | null) =>
    value ? formatBusinessDate(businessDateOf(new Date(value)), locale as Locale) : '—';
  const daysSince = (since: Date | string) =>
    Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 86_400_000));

  const activeRail = rail.filter((stage) => stage.active);
  const currentSeq = activeRail.find((stage) => stage.code === row.stageCode)?.sequence ?? 0;
  const oldestHold = holds[0] ?? null;

  const base = `/payables/${encodeURIComponent(row.payableNo)}`;
  const reasonOptions = reasons
    .filter((reason) => reason.code !== PENDING_REASON)
    .map((reason) => ({ value: reason.code, label: `${reason.code} — ${reason.name}` }));
  const ownerOptions = people.map((person) => ({ value: person.id, label: person.displayName }));
  const laneOptions = lanes.map((lane) => ({ value: lane.code, label: t(`lane_${lane.code}`) }));
  const railName = (stage: (typeof rail)[number]) =>
    (stage as { name?: string }).name ?? stage.code;

  // The rail as the header reads it: done, here, still to come (§21.3).
  const railText = activeRail
    .map((stage) => {
      const mark =
        stage.code === row.stageCode
          ? ` ← ${t('rail_now')}`
          : stage.sequence < currentSeq && found.reached.includes(stage.code)
            ? ' ✓'
            : '';
      return `${stage.sequence}. ${railName(stage)}${mark}`;
    })
    .join('  ·  ');

  const stageChip = row.cancelledAt
    ? 'cancelled'
    : row.closedAt
      ? 'posted'
      : row.onHold
        ? 'rejected'
        : 'submitted';

  const fields: DocumentField[] = [
    { label: t('col_no'), value: <bdi dir="ltr">{row.payableNo}</bdi> },
    {
      label: t('col_stage'),
      value: `${currentSeq}. ${railName(activeRail.find((stage) => stage.code === row.stageCode) ?? activeRail[0]!)} · ${t('days_n', { count: daysSince(row.stageSince) })}`,
      status: stageChip,
    },
    { label: t('type'), value: type.name },
    {
      label: t('supplier'),
      value: <bdi dir="auto">{supplier ? `${supplier.name} (${supplier.code})` : '—'}</bdi>,
    },
    { label: t('reference'), value: <bdi dir="ltr">{row.supplierReference}</bdi> },
    {
      label: t('col_amount'),
      value: (
        <bdi dir="ltr">
          {row.currency === 'IQD'
            ? money(row.amountIqd, 'IQD')
            : `${money(row.amountTxn)} · ${money(row.amountIqd, 'IQD')}`}
        </bdi>
      ),
    },
    { label: t('document_date'), value: <bdi dir="ltr">{day(row.documentDate)}</bdi> },
    { label: t('due_date'), value: <bdi dir="ltr">{day(row.dueDate)}</bdi> },
    { label: t('col_branch'), value: <bdi dir="ltr">{row.branchCode}</bdi> },
    { label: t('quantity'), value: row.quantity ? <bdi dir="ltr">{formatQuantity(row.quantity, locale as Locale)}</bdi> : '—' },
    { label: t('terms'), value: row.paymentTermsText ?? '—', wide: true },
    { label: t('rail'), value: <bdi dir="auto">{railText}</bdi>, wide: true },
    { label: t('description'), value: <bdi dir="auto">{row.description}</bdi>, wide: true },
  ];

  return (
    <AdminPage
      actions={
        mayEdit && !row.cancelledAt && !row.closedAt ? (
          <StopDialog
            back={base}
            defaultLane="order"
            lanes={laneOptions}
            owners={ownerOptions}
            payableNo={row.payableNo}
            reasons={reasonOptions}
          />
        ) : null
      }
      back={{ href: '/payables', label: t('title') }}
      tabs={<SectionTabs route="/payables" />}
      title={row.payableNo}
      trail={[{ href: '/', label: admin('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <DocumentWindow
        actions={
          mayEdit && !row.cancelledAt && !row.closedAt ? (
            <>
              <Form action={setTerms}>
                <Hidden name="payable_no" value={row.payableNo} />
                <Field
                  defaultValue={row.paymentTermsText ?? ''}
                  id="terms-edit"
                  label={t('terms')}
                  name="payment_terms"
                  required
                />
                <Submit label={t('terms_save')} tone="secondary" variant="document" />
              </Form>
              <Form action={linkInvoice}>
                <Hidden name="payable_no" value={row.payableNo} />
                <Field
                  hint={t('link_invoice_hint')}
                  id="link-invoice"
                  label={t('link_invoice')}
                  name="ap_invoice_id"
                  required
                />
                <Submit label={t('link_save')} tone="secondary" variant="document" />
              </Form>
              {mayCancel ? (
                <ReasonForm
                  action={cancelPayable}
                  hidden={{ payable_no: row.payableNo }}
                  label={t('cancel')}
                  reasonLabel={t('cancel_reason')}
                />
              ) : null}
            </>
          ) : null
        }
        documentType={type.name}
        fields={fields}
        id="payable-document"
        linesCount={lines.length}
        linesTitle={t('tab_order')}
        number={row.payableNo}
        totals={[
          { label: t('col_amount'), value: money(row.amountTxn) },
          ...(paymentTotals
            ? [
                { label: pa('paid'), value: money(toDecimalString(paymentTotals.paidTxn, 4n)) },
                { label: pa('remaining'), value: money(toDecimalString(paymentTotals.remainingTxn, 4n)) },
              ]
            : []),
        ]}
      >
        <table aria-labelledby="payable-document-lines-heading" className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">{t('line_item')}</th>
              <th scope="col">{t('line_description')}</th>
              <th className={s.sapNum} scope="col">
                {t('line_quantity')}
              </th>
              <th className={s.sapNum} scope="col">
                {t('line_price')}
              </th>
              <th className={s.sapNum} scope="col">
                {t('line_amount')}
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 ? (
              <tr>
                <td className={s.sapEmptyRow} colSpan={6}>
                  {t('no_lines')}
                </td>
              </tr>
            ) : null}
            {lines.map((line) => (
              <tr key={line.id}>
                <td>{line.lineNo}</td>
                <td>
                  <bdi dir="ltr">{line.itemCode ?? '—'}</bdi>
                </td>
                <td>{line.description}</td>
                <td className={s.sapNum}>
                  {line.quantity ? <bdi dir="ltr">{formatQuantity(line.quantity, locale as Locale)}</bdi> : '—'}
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{line.unitPrice ? money(line.unitPrice) : '—'}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{line.amountTxn ? money(line.amountTxn) : '—'}</bdi>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DocumentWindow>

      {/* ── The stop banner(s) (§21.3) — red, under the document window. ── */}
      {holds.length > 0 || row.cancelledAt ? (
        <section aria-label={t('col_stopped')} className={s.sapDoc}>
          <div className={s.sapWindow}>
            {holds.map((hold) => (
              <div className={s.sapNote} key={hold.id}>
                <span className="status status--rejected" data-status="rejected">
                  {hold.reasonCode === PENDING_REASON
                    ? t('banner_needs_reason')
                    : `${t('stopped_banner')}: ${hold.reasonCode}`}
                </span>{' '}
                {hold.detail ?? ''} · {t('since')} <bdi dir="ltr">{day(hold.startedAt)}</bdi> (
                {t('days_n', { count: daysSince(hold.startedAt) })})
                {hold.nextAction ? (
                  <>
                    {' · '}
                    {t('next_action')}: {hold.nextAction} — <bdi dir="ltr">{day(hold.nextActionDue)}</bdi>
                  </>
                ) : null}
                {mayEdit && hold.reasonCode === PENDING_REASON ? (
                  <details>
                    <summary>{t('complete_hold')}</summary>
                    <Form action={completeHold}>
                      <Hidden name="payable_no" value={row.payableNo} />
                      <Hidden name="hold_id" value={hold.id} />
                      <Select label={t('reason')} name="reason_code" options={reasonOptions} required />
                      <Field id={`detail-${hold.id}`} label={t('detail')} name="detail" />
                      <Select label={t('owner')} name="owner" options={ownerOptions} required />
                      <Field id={`na-${hold.id}`} label={t('next_action')} name="next_action" required />
                      <Field
                        id={`nad-${hold.id}`}
                        label={t('next_action_due')}
                        name="next_action_due"
                        required
                        type="date"
                      />
                      <SubmitRow>
                        <Submit label={t('complete_save')} />
                      </SubmitRow>
                    </Form>
                  </details>
                ) : null}
                {mayEdit && hold.reasonCode !== PENDING_REASON ? (
                  <details>
                    <summary>{t('hold_actions')}</summary>
                    <Form action={updateHold}>
                      <Hidden name="payable_no" value={row.payableNo} />
                      <Hidden name="hold_id" value={hold.id} />
                      <Field id={`un-${hold.id}`} label={t('update_note')} name="note" required />
                      <Field id={`una-${hold.id}`} label={t('next_action')} name="next_action" />
                      <Field
                        id={`unad-${hold.id}`}
                        label={t('next_action_due')}
                        name="next_action_due"
                        type="date"
                      />
                      <SubmitRow>
                        <Submit label={t('update_save')} small />
                      </SubmitRow>
                    </Form>
                    <Form action={resolveHold}>
                      <Hidden name="payable_no" value={row.payableNo} />
                      <Hidden name="hold_id" value={hold.id} />
                      <Field id={`res-${hold.id}`} label={t('resolution')} name="resolution" required />
                      <SubmitRow>
                        <Submit label={t('resolve_save')} small tone="danger" />
                      </SubmitRow>
                    </Form>
                  </details>
                ) : null}
              </div>
            ))}

            {row.cancelledAt ? (
              <div className={s.sapNote}>
                <span className="status status--cancelled" data-status="cancelled">
                  {t('cancelled_banner')}
                </span>{' '}
                {row.cancelReason} · <bdi dir="ltr">{day(row.cancelledAt)}</bdi>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* ── The invoices against it ──────────────────────────────────── */}
      <section aria-labelledby="payable-invoices-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="payable-invoices-title">
            <span>{t('invoices')}</span>
            <span className={s.sapTitleMeta}>{t('rows', { count: invoices.length })}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table aria-labelledby="payable-invoices-title" className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{t('invoice_no')}</th>
                  <th scope="col">{t('supplier_invoice_no')}</th>
                  <th scope="col">{t('invoice_date')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('invoice_total')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('invoice_settled')}
                  </th>
                  <th scope="col">{t('col_status')}</th>
                </tr>
              </thead>
              <tbody>
                {invoices.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={6}>
                      {t('no_invoices')}
                    </td>
                  </tr>
                ) : null}
                {invoices.map((invoice) => (
                  <tr key={invoice.id}>
                    <td>
                      <Link
                        className={s.sapLink}
                        href={`/payables/invoices/${encodeURIComponent(invoice.invoiceNo)}`}
                      >
                        <bdi dir="ltr">{invoice.invoiceNo}</bdi>
                      </Link>
                    </td>
                    <td>
                      <bdi dir="ltr">{invoice.supplierInvoiceNo}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{day(invoice.invoiceDate)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(invoice.totalIqd, 'IQD')}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(invoice.settledAmountIqd, 'IQD')}</bdi>
                    </td>
                    <td>
                      <span className={`status status--${invoice.status}`} data-status={invoice.status}>
                        {statusT.has(invoice.status) ? statusT(invoice.status) : invoice.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {mayEdit && !row.cancelledAt && !row.closedAt && invoices.length === 0 ? (
            <details className={s.sapNote}>
              {/* D11 — editing supersedes; nothing under a payable deletes. */}
              <summary>{t('edit_lines')}</summary>
              <Form action={updatePiLines}>
                <Hidden name="payable_no" value={row.payableNo} />
                <input name="line_count" type="hidden" value="6" />
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
                      {[0, 1, 2, 3, 4, 5].map((index) => {
                        const line = lines[index];
                        return (
                          <tr key={index}>
                            <td>
                              <input
                                className={s.input}
                                defaultValue={line?.itemCode ?? ''}
                                name={`line_${index}_item`}
                              />
                            </td>
                            <td>
                              <input
                                className={s.input}
                                defaultValue={line?.description ?? ''}
                                name={`line_${index}_description`}
                              />
                            </td>
                            <td>
                              <input
                                className={s.input}
                                defaultValue={line?.quantity ?? ''}
                                inputMode="decimal"
                                name={`line_${index}_quantity`}
                              />
                            </td>
                            <td>
                              <input
                                className={s.input}
                                defaultValue={line?.uomCode ?? ''}
                                name={`line_${index}_uom`}
                              />
                            </td>
                            <td>
                              <input
                                className={s.input}
                                defaultValue={line?.unitPrice ?? ''}
                                inputMode="decimal"
                                name={`line_${index}_price`}
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <SubmitRow>
                  <Submit label={t('lines_save')} small tone="secondary" />
                </SubmitRow>
              </Form>
            </details>
          ) : null}
        </div>
      </section>

      {/* ── Payments (§15): the plan, the applications, Applied / Paid /
          Remaining. Imports only; drawn as the invoices register above. ── */}
      {paymentTotals ? (
        <section aria-labelledby="payable-payments-title" className={s.sapDoc} id="payments">
          <div className={s.sapWindow}>
            <h2 className={s.sapTitle} id="payable-payments-title">
              <span>{pa('section_title')}</span>
              <span className={s.sapTitleMeta}>
                <bdi dir="ltr">
                  {pa('applied')} {money(toDecimalString(paymentTotals.appliedTxn, 4n))} · {pa('paid')}{' '}
                  {money(toDecimalString(paymentTotals.paidTxn, 4n))} · {pa('remaining')}{' '}
                  {money(toDecimalString(paymentTotals.remainingTxn, 4n))}
                </bdi>
              </span>
            </h2>

            {exchangeOpen ? (
              // REQ-FIX-001 FX8 — fully paid in its currency, the dinars still to close.
              <div className={s.sapNote}>
                <bdi dir="auto">
                  {pa('exchange_open', {
                    owed: money(toDecimalString(exchangeOpen.owedIqd, 4n), 'IQD'),
                    over: money(toDecimalString(exchangeOpen.overpaidIqd + exchangeOpen.unusedDepositIqd, 4n), 'IQD'),
                  })}
                </bdi>
                {can(principal, 'post', paymentApplications.PERMISSION_OBJECT) ? (
                  <form action={settleExchangeDifference}>
                    <Hidden name="payable_no" value={row.payableNo} />
                    <Submit label={pa('exchange_settle')} small />
                  </form>
                ) : null}
              </div>
            ) : null}

            <div className={s.sapTableWrap}>
              <table aria-label={pa('instalments')} className={s.sapTable}>
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">{pa('instalment')}</th>
                    <th scope="col">{pa('trigger')}</th>
                    <th scope="col">{pa('expected_date')}</th>
                    <th className={s.sapNum} scope="col">
                      {pa('share')}
                    </th>
                    <th className={s.sapNum} scope="col">
                      {pa('col_amount')}
                    </th>
                    <th scope="col">{pa('col_status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {instalments.length === 0 ? (
                    <tr>
                      <td className={s.sapEmptyRow} colSpan={7}>
                        {pa('no_instalments')}
                      </td>
                    </tr>
                  ) : null}
                  {instalments.map((instalment) => (
                    <tr key={instalment.id}>
                      <td>{instalment.sequence}</td>
                      <td>
                        <bdi dir="auto">{instalment.label}</bdi>
                      </td>
                      <td>
                        <bdi dir="auto">
                          {instalment.triggerName}
                          {instalment.triggerDays !== null ? ` · ${instalment.triggerDays}` : ''}
                        </bdi>
                      </td>
                      <td>
                        <bdi dir="ltr">{day(instalment.expectedDate)}</bdi>
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{instalment.percent ? `${Number(instalment.percent)}%` : '—'}</bdi>
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{money(instalment.amountTxn)}</bdi>
                      </td>
                      <td>
                        <span
                          className={`status status--${instalment.status === 'paid' ? 'settled' : instalment.status === 'applied' ? 'submitted' : 'draft'}`}
                          data-status={instalment.status === 'paid' ? 'settled' : instalment.status === 'applied' ? 'submitted' : 'draft'}
                        >
                          {pa(`instalment_${instalment.status}`)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className={s.sapTableWrap}>
              <table aria-label={pa('section_applications')} className={s.sapTable}>
                <thead>
                  <tr>
                    <th scope="col">{pa('col_no')}</th>
                    <th scope="col">{pa('col_method')}</th>
                    <th scope="col">{pa('col_account')}</th>
                    <th scope="col">{pa('col_application_date')}</th>
                    <th className={s.sapNum} scope="col">
                      {pa('col_amount')}
                    </th>
                    <th scope="col">{pa('col_status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {applied.length === 0 ? (
                    <tr>
                      <td className={s.sapEmptyRow} colSpan={6}>
                        {pa('none_for_import')}
                      </td>
                    </tr>
                  ) : null}
                  {applied.map((application) => (
                    <tr key={application.id}>
                      <td>
                        <Link
                          className={s.sapLink}
                          href={`/payables/payment-applications/${encodeURIComponent(application.applicationNo)}`}
                        >
                          <bdi dir="ltr">{application.applicationNo}</bdi>
                        </Link>
                      </td>
                      <td>
                        <bdi dir="auto">{application.methodName}</bdi>
                      </td>
                      <td>
                        <bdi dir="ltr">{application.accountCode}</bdi>
                      </td>
                      <td>
                        <bdi dir="ltr">{day(application.applicationDate)}</bdi>
                        {application.daysWaiting !== null ? (
                          <div className="muted">{pa('days_n', { count: application.daysWaiting })}</div>
                        ) : null}
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{money(application.amountTxn)}</bdi>
                      </td>
                      <td>
                        <span
                          className={`status status--${STATUS_CHIP[application.status] ?? 'draft'}`}
                          data-status={STATUS_CHIP[application.status] ?? 'draft'}
                        >
                          {pa(statusKey(application.status, application.methodKind))}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {funding.length > 0 ? (
              <div className={s.sapTableWrap}>
                <table aria-label={lo('import_section')} className={s.sapTable}>
                  <thead>
                    <tr>
                      <th scope="col">{lo('import_section')}</th>
                      <th scope="col">{lo('col_bank')}</th>
                      <th scope="col">{lo('col_application')}</th>
                      <th className={s.sapNum} scope="col">
                        {lo('col_drawn')}
                      </th>
                      <th className={s.sapNum} scope="col">
                        {lo('col_share')}
                      </th>
                      <th scope="col">{lo('col_next_due')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {funding.map((draw) => (
                      <tr key={draw.id}>
                        <td>
                          <Link className={s.sapLink} href={`/payables/loans/${encodeURIComponent(draw.loanNo)}`}>
                            <bdi dir="ltr">{draw.loanNo}</bdi>
                          </Link>
                        </td>
                        <td>
                          <bdi dir="auto">{draw.bankName}</bdi>
                        </td>
                        <td>
                          <bdi dir="ltr">{draw.applicationNo}</bdi>
                        </td>
                        <td className={s.sapNum}>
                          <bdi dir="ltr">{money(draw.amountTxn, draw.currency)}</bdi>
                        </td>
                        <td className={s.sapNum}>
                          <bdi dir="ltr">{money(draw.commissionShareTxn, draw.currency)}</bdi>
                          <div className="muted">{draw.capitalised ? lo('capitalised_yes') : lo('capitalised_no')}</div>
                        </td>
                        <td>
                          <bdi dir="ltr">{day(draw.nextDue)}</bdi>
                          {draw.overdue ? (
                            <div>
                              <span className="status status--rejected" data-status="rejected">
                                {lo('overdue_flag')}
                              </span>
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            {pickers ? (
              <div className={s.sapBody}>
                <SubmitRow>
                  <NewRecordDialog
                    buttonLabel={pa('plan')}
                    closeLabel={admin('close')}
                    title={pa('plan_title', { payableNo: row.payableNo })}
                    wide
                  >
                    <p className="muted">{pa('plan_note', { amount: money(row.amountTxn) })}</p>
                    <Form action={planInstalmentsAction}>
                      <Hidden name="payable_no" value={row.payableNo} />
                      <input name="row_count" type="hidden" value="6" />
                      <div className={s.sapTableWrap}>
                        <table className={s.sapTable}>
                          <thead>
                            <tr>
                              <th scope="col">{pa('instalment')}</th>
                              <th scope="col">{pa('basis')}</th>
                              <th scope="col">{pa('value')}</th>
                              <th scope="col">{pa('trigger')}</th>
                              <th scope="col">{pa('trigger_days')}</th>
                              <th scope="col">{pa('expected_date')}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {[0, 1, 2, 3, 4, 5].map((index) => {
                              const current = instalments.filter((i) => i.status === 'planned')[index];
                              return (
                                <tr key={index}>
                                  <td>
                                    <input
                                      aria-label={`${pa('instalment')} ${index + 1}`}
                                      className={s.input}
                                      defaultValue={current?.label ?? (index === 0 ? pa('deposit') : index === 1 ? pa('balance') : '')}
                                      name={`label_${index}`}
                                    />
                                  </td>
                                  <td>
                                    <select
                                      aria-label={`${pa('basis')} ${index + 1}`}
                                      className={s.select}
                                      defaultValue={current?.basis ?? 'percent'}
                                      name={`basis_${index}`}
                                    >
                                      <option value="percent">{pa('basis_percent')}</option>
                                      <option value="amount">{pa('basis_amount')}</option>
                                    </select>
                                  </td>
                                  <td>
                                    <input
                                      aria-label={`${pa('value')} ${index + 1}`}
                                      className={s.input}
                                      defaultValue={
                                        current ? (current.basis === 'percent' ? Number(current.percent).toString() : current.amountTxn) : ''
                                      }
                                      inputMode="decimal"
                                      name={`value_${index}`}
                                    />
                                  </td>
                                  <td>
                                    <select
                                      aria-label={`${pa('trigger')} ${index + 1}`}
                                      className={s.select}
                                      defaultValue={current?.triggerCode ?? (index === 0 ? 'on_order' : 'against_bl_copy')}
                                      name={`trigger_${index}`}
                                    >
                                      {pickers.triggers.map((trigger) => (
                                        <option key={trigger.code} value={trigger.code}>
                                          {trigger.name}
                                        </option>
                                      ))}
                                    </select>
                                  </td>
                                  <td>
                                    <input
                                      aria-label={`${pa('trigger_days')} ${index + 1}`}
                                      className={s.input}
                                      defaultValue={current?.triggerDays ?? ''}
                                      inputMode="numeric"
                                      name={`days_${index}`}
                                    />
                                  </td>
                                  <td>
                                    <input
                                      aria-label={`${pa('expected_date')} ${index + 1}`}
                                      className={`${s.input} ${s.dateInput}`}
                                      defaultValue={current?.expectedDate ?? ''}
                                      name={`expected_${index}`}
                                      type="date"
                                    />
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      <SubmitRow>
                        <Submit label={pa('plan_save')} />
                      </SubmitRow>
                    </Form>
                  </NewRecordDialog>

                  <NewRecordDialog
                    buttonLabel={pa('new')}
                    closeLabel={admin('close')}
                    openOnLoad={openPay}
                    title={pa('new_for', { payableNo: row.payableNo })}
                  >
                    <Form action={createApplication}>
                      <Hidden name="payable_no" value={row.payableNo} />
                      <Grid>
                        <Select
                          emptyLabel={pa('no_instalment')}
                          label={pa('instalment')}
                          name="instalment_id"
                          options={pickers.instalments.map((instalment) => ({
                            value: instalment.id,
                            label: `${instalment.sequence}. ${instalment.label} — ${money(instalment.amountTxn)}`,
                          }))}
                        />
                        <Field hint={pa('amount_hint')} label={pa('col_amount')} name="amount" />
                        <Select
                          label={pa('col_method')}
                          name="payment_method"
                          options={pickers.methods.map((method) => ({ value: method.code, label: method.name }))}
                          required
                        />
                        <Select
                          label={pa('col_account')}
                          name="bank_cash_account_id"
                          options={pickers.accounts.map((account) => ({
                            value: account.id,
                            label: `${account.code} · ${account.name}${account.bankName ? ` · ${account.bankName}` : ''} — ${pa('available_short')} ${money(account.availableIqd, 'IQD')}`,
                          }))}
                          required
                        />
                        <Select
                          emptyLabel="—"
                          hint={pa('payee_hint')}
                          label={pa('payee')}
                          name="payee_bank_account_id"
                          options={pickers.payees.map((payee) => ({
                            value: payee.id,
                            label: `${payee.bankName} · ${payee.accountNumber}${payee.swift ? ` · ${payee.swift}` : ''}${payee.verified ? '' : ` (${pa('unverified')})`}`,
                          }))}
                        />
                        <Select
                          defaultValue="own_funds"
                          label={pa('funding')}
                          name="funding_source"
                          options={pickers.funding.map((source) => ({ value: source.code, label: source.name }))}
                        />
                        {pickers.loans.length > 0 ? (
                          <Select
                            emptyLabel="—"
                            hint={pa('loan_hint')}
                            label={pa('loan')}
                            name="loan_id"
                            options={pickers.loans.map((loan) => ({
                              value: loan.id,
                              label: `${loan.loanNo} · ${loan.bankName} · ${loan.accountCode} — ${money(loan.unallocatedTxn)}`,
                            }))}
                          />
                        ) : null}
                      </Grid>
                      <Field id="payapp-note" label={pa('note')} name="note" wide />
                      <SubmitRow>
                        <Submit label={pa('create')} />
                      </SubmitRow>
                    </Form>
                  </NewRecordDialog>
                </SubmitRow>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* ── PD / ASYCUDA (§16): every registration of this import, the
          soonest to expire first. Imports only. ── */}
      {type.code === 'import' && mayViewPd ? (
        <section aria-labelledby="payable-pd-title" className={s.sapDoc} id="pd">
          <div className={s.sapWindow}>
            <h2 className={s.sapTitle} id="payable-pd-title">
              <span>{cp('section_title')}</span>
              <span className={s.sapTitleMeta}>{t('rows', { count: pds.length })}</span>
            </h2>
            <div className={s.sapTableWrap}>
              <table aria-labelledby="payable-pd-title" className={s.sapTable}>
                <thead>
                  <tr>
                    <th scope="col">{cp('pd_no')}</th>
                    <th scope="col">{cp('bank')}</th>
                    <th scope="col">{cp('registered')}</th>
                    <th scope="col">{cp('expires')}</th>
                    <th className={s.sapNum} scope="col">
                      {cp('days_left')}
                    </th>
                    <th scope="col">{cp('status')}</th>
                    <th scope="col">{cp('note')}</th>
                  </tr>
                </thead>
                <tbody>
                  {pds.length === 0 ? (
                    <tr>
                      <td className={s.sapEmptyRow} colSpan={7}>
                        {cp('none_for_import')}
                      </td>
                    </tr>
                  ) : null}
                  {pds.map((pd) => (
                    <tr key={pd.id}>
                      <td>
                        <Link
                          className={s.sapLink}
                          href={`/payables/pd/${encodeURIComponent(pd.pdNo)}?year=${pd.registrationYear}`}
                        >
                          <bdi dir="ltr">{pd.pdNo}</bdi>
                        </Link>
                      </td>
                      <td>
                        <bdi dir="auto">{pd.bankName ?? '—'}</bdi>
                      </td>
                      <td>
                        <bdi dir="ltr">{day(pd.registrationDate)}</bdi>
                      </td>
                      <td>
                        <bdi dir="ltr">{day(pd.expiryDate)}</bdi>
                      </td>
                      <td className={s.sapNum}>{pd.isTerminal || pd.superseded ? '—' : pd.daysLeft}</td>
                      <td>
                        <span className={`status status--${pdChip(pd)}`} data-status={pdChip(pd)}>
                          {cp.has(`ps.${pd.statusCode}`) && locale !== 'en' ? cp(`ps.${pd.statusCode}`) : pd.statusName}
                        </span>
                        {pd.superseded ? <div className="muted">{cp('superseded')}</div> : null}
                      </td>
                      <td>
                        <bdi dir="auto">{pd.lastNote ?? ''}</bdi>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {pdPickers ? (
              <div className={s.sapBody}>
                <SubmitRow>
                  <NewRecordDialog
                    buttonLabel={cp('register')}
                    closeLabel={admin('close')}
                    title={cp('register_for', { payableNo: row.payableNo })}
                  >
                    <Form action={registerPd}>
                      <Hidden name="payable_no" value={row.payableNo} />
                      <Hidden name="back" value={`/payables/${encodeURIComponent(row.payableNo)}`} />
                      <Grid>
                        <Field hint={cp('pd_no_hint')} label={cp('pd_no')} name="new_pd_no" required />
                        <Field label={cp('registered')} name="registration_date" required type="date" />
                        <Field hint={cp('expiry_hint')} label={cp('expires')} name="expiry_date" required type="date" />
                        <Select
                          emptyLabel="—"
                          label={cp('bank')}
                          name="bank_code"
                          options={pdPickers.banks.map((b) => ({
                            value: b.code,
                            label: b.swiftBic ? `${b.name} · ${b.swiftBic}` : b.name,
                          }))}
                        />
                        <Select
                          defaultValue="submitted"
                          label={cp('status')}
                          name="status_code"
                          options={pdPickers.statuses
                            .filter((status) => status.active && !status.isTerminal)
                            .map((status) => ({ value: status.code, label: locale !== 'en' && cp.has(`ps.${status.code}`) ? cp(`ps.${status.code}`) : status.name }))}
                        />
                      </Grid>
                      <Field id="pd-register-note" label={cp('note')} name="note" wide />
                      <SubmitRow>
                        <Submit label={cp('register')} />
                      </SubmitRow>
                    </Form>
                  </NewRecordDialog>
                </SubmitRow>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* ── Shipment & containers (§17): the B/Ls and every container on
          its own, "X of Y received". Imports only. ── */}
      {shipment ? (
        <section aria-labelledby="payable-shipment-title" className={s.sapDoc} id="shipment">
          <div className={s.sapWindow}>
            <h2 className={s.sapTitle} id="payable-shipment-title">
              <span>{sh('section_title')}</span>
              <span className={s.sapTitleMeta}>
                {sh('x_of_y', { received: shipment.progress.received, total: shipment.progress.total })}
              </span>
            </h2>
            <div className={s.sapTableWrap}>
              <table aria-label={sh('bls')} className={s.sapTable}>
                <thead>
                  <tr>
                    <th scope="col">{sh('bl_no')}</th>
                    <th scope="col">{sh('bl_date')}</th>
                    <th scope="col">{sh('vessel')}</th>
                    <th scope="col">{sh('port_of_discharge')}</th>
                    <th scope="col">{sh('eta')}</th>
                    <th scope="col">{sh('received_x_of_y')}</th>
                  </tr>
                </thead>
                <tbody>
                  {shipment.bls.length === 0 ? (
                    <tr>
                      <td className={s.sapEmptyRow} colSpan={6}>
                        {sh('none_for_import')}
                      </td>
                    </tr>
                  ) : null}
                  {shipment.bls.map((bl) => (
                    <tr key={bl.id}>
                      <td>
                        <Link className={s.sapLink} href={`/payables/shipments/${encodeURIComponent(bl.blNo)}`}>
                          <bdi dir="ltr">{bl.blNo}</bdi>
                        </Link>
                      </td>
                      <td>
                        <bdi dir="ltr">{day(bl.blDate)}</bdi>
                      </td>
                      <td>
                        <bdi dir="auto">{[bl.vessel, bl.voyage].filter(Boolean).join(' / ') || '—'}</bdi>
                      </td>
                      <td>
                        <bdi dir="auto">{bl.portName ?? '—'}</bdi>
                      </td>
                      <td>
                        <bdi dir="ltr">{day(bl.eta)}</bdi>
                      </td>
                      <td>{sh('x_of_y', { received: bl.received, total: bl.total })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {shipment.containers.length > 0 ? (
              <div className={s.sapTableWrap}>
                <table aria-label={sh('containers')} className={s.sapTable}>
                  <thead>
                    <tr>
                      <th scope="col">{sh('container_no')}</th>
                      <th scope="col">{sh('bl_no')}</th>
                      <th scope="col">{sh('eta')}</th>
                      <th scope="col">{sh('status')}</th>
                      <th scope="col">{sh('warehouse')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shipment.containers.map((container) => (
                      <tr key={container.id}>
                        <td>
                          <Link
                            className={s.sapLink}
                            href={`/payables/containers/${encodeURIComponent(container.containerNo)}${container.receivedOn ? `?id=${container.id}` : ''}`}
                          >
                            <bdi dir="ltr">{container.containerNo}</bdi>
                          </Link>
                        </td>
                        <td>
                          <bdi dir="ltr">{container.blNo}</bdi>
                        </td>
                        <td>
                          <bdi dir="ltr">{day(container.eta)}</bdi>
                        </td>
                        <td>
                          <span className={`status status--${containerChip(container)}`} data-status={containerChip(container)}>
                            {locale !== 'en' && sh.has(`cs.${container.statusCode}`) ? sh(`cs.${container.statusCode}`) : container.statusName}
                          </span>
                        </td>
                        <td>
                          <bdi dir="ltr">{container.warehouseCode ?? '—'}</bdi>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            {blPorts ? (
              <div className={s.sapBody}>
                <SubmitRow>
                  <NewRecordDialog
                    buttonLabel={sh('new_bl')}
                    closeLabel={admin('close')}
                    title={sh('new_bl_for', { payableNo: row.payableNo })}
                    wide
                  >
                    <Form action={createBlAction}>
                      <Hidden name="payable_no" value={row.payableNo} />
                      <Hidden name="back" value={`/payables/${encodeURIComponent(row.payableNo)}`} />
                      <Grid>
                        <Field label={sh('bl_no')} name="bl_no" required />
                        <Field label={sh('bl_date')} name="bl_date" required type="date" />
                        <Field label={sh('eta')} name="eta" type="date" />
                        <Field label={sh('vessel')} name="vessel" />
                        <Field label={sh('voyage')} name="voyage" />
                        <Select
                          emptyLabel="—"
                          label={sh('port_of_discharge')}
                          name="port_of_discharge"
                          options={blPorts.map((port) => ({ value: port.code, label: port.name }))}
                        />
                        <Field hint={sh('size_type_hint')} label={sh('size_type')} name="size_type" />
                      </Grid>
                      <Field
                        hint={sh('containers_hint')}
                        id="bl-containers"
                        label={sh('containers')}
                        name="containers"
                        type="textarea"
                        wide
                      />
                      <Checkbox defaultChecked={shipment.bls.length === 0} label={sh('spread_lines')} name="spread_lines" />
                      <SubmitRow>
                        <Submit label={sh('new_bl')} />
                      </SubmitRow>
                    </Form>
                  </NewRecordDialog>
                </SubmitRow>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* ── Landed cost (§20.2): the charges, what a lock would do, the
          locks. Imports only. ── */}
      {landed ? (
        <section aria-labelledby="payable-landed-title" className={s.sapDoc} id="landed-cost">
          <div className={s.sapWindow}>
            <h2 className={s.sapTitle} id="payable-landed-title">
              <span>{lc('section_title')}</span>
              <span className={s.sapTitleMeta}>
                {lc('meta', {
                  total: money(
                    toDecimalString(
                      landed.charges
                        .filter((row) => !row.cancelledAt && row.chargeTypeCode !== 'purchase')
                        .reduce((sum, row) => sum + parseDecimal(row.amountIqd, MONEY_SCALE), 0n),
                      MONEY_SCALE,
                    ),
                    'IQD',
                  ),
                  state:
                    landed.state.unlocked > 0
                      ? lc('state_pending', { count: landed.state.unlocked })
                      : landed.state.locked
                        ? lc('state_locked')
                        : lc('state_open'),
                })}
              </span>
            </h2>
            <div className={s.sapTableWrap}>
              <table aria-labelledby="payable-landed-title" className={s.sapTable}>
                <thead>
                  <tr>
                    <th scope="col">{lc('col_type')}</th>
                    <th scope="col">{lc('col_source')}</th>
                    <th className={s.sapNum} scope="col">
                      {lc('col_amount')}
                    </th>
                    <th scope="col">{lc('col_state')}</th>
                    <th scope="col">{lc('col_note')}</th>
                  </tr>
                </thead>
                <tbody>
                  {landed.charges.length === 0 ? (
                    <tr>
                      <td className={s.sapEmptyRow} colSpan={5}>
                        {lc('none')}
                      </td>
                    </tr>
                  ) : null}
                  {landed.charges.map((row) => (
                    <tr key={row.id}>
                      <td>
                        {locale !== 'en' && lc.has(`type_name.${row.chargeTypeCode}`)
                          ? lc(`type_name.${row.chargeTypeCode}`)
                          : row.chargeTypeName}
                      </td>
                      <td>
                        <bdi dir="ltr">{row.sourceNo ?? '—'}</bdi>
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{money(row.amountIqd, 'IQD')}</bdi>
                        {row.currency !== 'IQD' ? (
                          <div className="muted">
                            <bdi dir="ltr">{money(row.amountTxn, row.currency)}</bdi>
                          </div>
                        ) : null}
                      </td>
                      <td>
                        {row.cancelledAt ? (
                          <span className="status status--cancelled" data-status="cancelled">
                            {lc('withdrawn')}
                          </span>
                        ) : row.lockId ? (
                          <span className="status status--posted" data-status="posted">
                            {lc('locked_n', { sequence: row.lockSequence ?? 1 })}
                          </span>
                        ) : (
                          <span className="status status--draft" data-status="draft">
                            {lc('unlocked')}
                          </span>
                        )}
                      </td>
                      <td>
                        <bdi dir="auto">{row.reason ?? row.note ?? row.cancelReason ?? '—'}</bdi>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {landed.state.unlocked > 0 && landed.preview.models.length > 0 ? (
              <div className={s.sapTableWrap}>
                <table aria-label={lc('preview_title')} className={s.sapTable}>
                  <thead>
                    <tr>
                      <th scope="col">{lc('col_model')}</th>
                      <th className={s.sapNum} scope="col">
                        {lc('col_received')}
                      </th>
                      <th className={s.sapNum} scope="col">
                        {lc('col_on_hand')}
                      </th>
                      <th className={s.sapNum} scope="col">
                        {lc('col_value')}
                      </th>
                      <th className={s.sapNum} scope="col">
                        {lc('col_allocated')}
                      </th>
                      <th className={s.sapNum} scope="col">
                        {lc('col_unit_now')}
                      </th>
                      <th className={s.sapNum} scope="col">
                        {lc('col_unit_after')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {landed.preview.models.map((model) => (
                      <tr key={model.itemCode}>
                        <td>
                          <bdi dir="ltr">{model.itemCode}</bdi>
                        </td>
                        <td className={s.sapNum}>
                          <bdi dir="ltr">{formatQuantity(model.receivedQty, locale as Locale)}</bdi>
                        </td>
                        <td className={s.sapNum}>
                          <bdi dir="ltr">{formatQuantity(model.onHandQty, locale as Locale)}</bdi>
                        </td>
                        <td className={s.sapNum}>
                          <bdi dir="ltr">{money(model.valueIqd, 'IQD')}</bdi>
                        </td>
                        <td className={s.sapNum}>
                          <bdi dir="ltr">{model.allocatedIqd ? money(model.allocatedIqd, 'IQD') : '—'}</bdi>
                        </td>
                        <td className={s.sapNum}>
                          <bdi dir="ltr">{money(model.unitCostIqd, 'IQD')}</bdi>
                        </td>
                        <td className={s.sapNum}>
                          <bdi dir="ltr">{model.unitCostAfterIqd ? money(model.unitCostAfterIqd, 'IQD') : '—'}</bdi>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            {landed.locks.length > 0 ? (
              <div className={s.sapTableWrap}>
                <table aria-label={lc('locks_title')} className={s.sapTable}>
                  <thead>
                    <tr>
                      <th scope="col">{lc('col_lock')}</th>
                      <th scope="col">{lc('col_date')}</th>
                      <th scope="col">{lc('col_basis')}</th>
                      <th className={s.sapNum} scope="col">
                        {lc('col_total')}
                      </th>
                      <th className={s.sapNum} scope="col">
                        {lc('col_stock')}
                      </th>
                      <th className={s.sapNum} scope="col">
                        {lc('col_cogs')}
                      </th>
                      <th scope="col">{lc('col_journal')}</th>
                      <th scope="col">{lc('col_by')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {landed.locks.map((row) => (
                      <tr key={row.id}>
                        <td>
                          {row.sequence === 1 ? lc('lock_first') : `${lc('lock_adjustment')} ${row.sequence}`}
                        </td>
                        <td>
                          <bdi dir="ltr">{day(row.lockDate)}</bdi>
                        </td>
                        <td>
                          {locale !== 'en' && lc.has(`basis_name.${row.basisCode}`) ? lc(`basis_name.${row.basisCode}`) : row.basisName}
                        </td>
                        <td className={s.sapNum}>
                          <bdi dir="ltr">{money(row.totalIqd, 'IQD')}</bdi>
                        </td>
                        <td className={s.sapNum}>
                          <bdi dir="ltr">{money(row.inventoryIqd, 'IQD')}</bdi>
                        </td>
                        <td className={s.sapNum}>
                          <bdi dir="ltr">{money(row.cogsIqd, 'IQD')}</bdi>
                        </td>
                        <td>
                          <bdi dir="ltr">{row.entryNo}</bdi>
                        </td>
                        <td>
                          <bdi dir="auto">{row.lockedBy ?? '—'}</bdi>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            {!landed.state.pdsWrittenOff && landed.state.unlocked > 0 ? (
              <p className={s.sapNote}>{lc('not_lockable')}</p>
            ) : null}

            {mayAddCharge || (mayLock && landed.state.pdsWrittenOff && landed.state.unlocked > 0) ? (
              <div className={s.sapBody}>
                <SubmitRow>
                  {mayAddCharge ? (
                    <NewRecordDialog
                      buttonLabel={lc('add')}
                      closeLabel={admin('close')}
                      title={lc('add_title', { payableNo: row.payableNo })}
                    >
                      <p className="muted">{lc('add_note')}</p>
                      <Form action={addLandedCharge}>
                        <Hidden name="payable_no" value={row.payableNo} />
                        <Grid>
                          <Select
                            label={lc('charge_type')}
                            name="charge_type"
                            options={landed.types.map((type) => ({
                              value: type.code,
                              label: locale !== 'en' && lc.has(`type_name.${type.code}`) ? lc(`type_name.${type.code}`) : type.name,
                            }))}
                            required
                          />
                          <Field id="landed-journal" label={lc('journal_entry_no')} name="journal_entry_no" required />
                          <Field id="landed-amount" label={lc('amount')} name="amount" required />
                          <Field hint={lc('reason_hint')} id="landed-reason" label={lc('reason')} name="reason" />
                        </Grid>
                        <Field id="landed-note" label={lc('note')} name="note" wide />
                        <SubmitRow>
                          <Submit label={lc('add')} />
                        </SubmitRow>
                      </Form>
                    </NewRecordDialog>
                  ) : null}
                  {mayLock && landed.state.pdsWrittenOff && landed.state.unlocked > 0 ? (
                    <NewRecordDialog
                      buttonLabel={landed.state.locked ? lc('lock_again') : lc('lock')}
                      closeLabel={admin('close')}
                      title={lc('lock_title', { payableNo: row.payableNo })}
                    >
                      <p className="muted">{lc('lock_note', { total: money(landed.preview.total, 'IQD') })}</p>
                      <Form action={lockLandedCost}>
                        <Hidden name="payable_no" value={row.payableNo} />
                        <Hidden name="line_count" value={String(landed.preview.models.length)} />
                        <Grid>
                          <Select
                            defaultValue={landed.bases.find((basis) => basis.isDefault)?.code}
                            label={lc('basis')}
                            name="basis"
                            options={landed.bases.map((basis) => ({
                              value: basis.code,
                              label:
                                locale !== 'en' && lc.has(`basis_name.${basis.code}`) ? lc(`basis_name.${basis.code}`) : basis.name,
                            }))}
                          />
                          <Field defaultValue={businessToday()} id="landed-lock-date" label={lc('lock_date')} name="lock_date" type="date" />
                        </Grid>
                        {landed.preview.models.length > 0 ? (
                          <div className={s.sapTableWrap}>
                            <table className={s.sapTable}>
                              <thead>
                                <tr>
                                  <th scope="col">{lc('col_model')}</th>
                                  <th scope="col">{lc('col_allocated')}</th>
                                </tr>
                              </thead>
                              <tbody>
                                {landed.preview.models.map((model, index) => (
                                  <tr key={model.itemCode}>
                                    <td>
                                      <Hidden name={`model_${index}`} value={model.itemCode} />
                                      <bdi dir="ltr">{model.itemCode}</bdi>
                                    </td>
                                    <td>
                                      <input
                                        aria-label={`${lc('col_allocated')} ${model.itemCode}`}
                                        className={s.input}
                                        inputMode="decimal"
                                        name={`amount_${index}`}
                                      />
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ) : null}
                        <p className="muted">{lc('manual_hint')}</p>
                        <Field id="landed-lock-note" label={lc('note')} name="note" wide />
                        <SubmitRow>
                          <Submit label={landed.state.locked ? lc('lock_again') : lc('lock')} />
                        </SubmitRow>
                      </Form>
                    </NewRecordDialog>
                  ) : null}
                  {mayWithdraw && landed.charges.some((row) => !row.lockId && !row.cancelledAt && row.sourceType === 'journal_entry') ? (
                    <NewRecordDialog buttonLabel={lc('withdraw')} closeLabel={admin('close')} title={lc('withdraw')}>
                      <p className="muted">{lc('withdraw_note')}</p>
                      <Form action={withdrawLandedCharge}>
                        <Hidden name="payable_no" value={row.payableNo} />
                        <Select
                          label={lc('withdraw_charge')}
                          name="charge_id"
                          options={landed.charges
                            .filter((charge) => !charge.lockId && !charge.cancelledAt && charge.sourceType === 'journal_entry')
                            .map((charge) => ({
                              value: charge.id,
                              label: `${charge.sourceNo ?? ''} · ${charge.chargeTypeName} · ${money(charge.amountIqd, 'IQD')}`,
                            }))}
                          required
                        />
                        <Field id="landed-withdraw-reason" label={lc('withdraw_reason')} name="reason" required wide />
                        <SubmitRow>
                          <Submit label={lc('withdraw')} />
                        </SubmitRow>
                      </Form>
                    </NewRecordDialog>
                  ) : null}
                </SubmitRow>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* ── The service lane: confirmations and the contract (§21.3) ──── */}
      {receipts.length > 0 || contract || type.code === 'service' || type.code === 'recurring' ? (
        <section aria-labelledby="payable-service-title" className={s.sapDoc}>
          <div className={s.sapWindow}>
            <h2 className={s.sapTitle} id="payable-service-title">
              <span>{t('tab_service')}</span>
              <span className={s.sapTitleMeta}>{t('rows', { count: receipts.length })}</span>
            </h2>

            {contract ? (
              <p className={s.sapNote}>
                <Link
                  className={s.sapLink}
                  href={`/payables/contracts/${encodeURIComponent(contract.contractNo)}`}
                >
                  {t('contract_link', { contractNo: contract.contractNo })}
                </Link>
                {' — '}
                {contract.description}
              </p>
            ) : null}

            <div className={s.sapTableWrap}>
              <table aria-labelledby="payable-service-title" className={s.sapTable}>
                <thead>
                  <tr>
                    <th scope="col">{t('receipt_no')}</th>
                    <th scope="col">{t('receipt_date')}</th>
                    <th scope="col">{t('receipt_department')}</th>
                    <th scope="col">{t('receipt_status')}</th>
                    <th scope="col">{t('receipt_note')}</th>
                  </tr>
                </thead>
                <tbody>
                  {receipts.length === 0 ? (
                    <tr>
                      <td className={s.sapEmptyRow} colSpan={5}>
                        {t('no_receipts')}
                      </td>
                    </tr>
                  ) : null}
                  {receipts.map((receipt) => (
                    <tr key={receipt.id}>
                      <td>
                        <bdi dir="ltr">{receipt.receiptNo}</bdi>
                      </td>
                      <td>
                        <bdi dir="ltr">{day(receipt.serviceDate)}</bdi>
                      </td>
                      <td>{receipt.departmentCode}</td>
                      <td>
                        <span
                          className="status"
                          data-status={
                            receipt.status === 'approved'
                              ? 'approved'
                              : receipt.status === 'reversed'
                                ? 'cancelled'
                                : receipt.status
                          }
                        >
                          {statusT.has(receipt.status) ? statusT(receipt.status) : receipt.status}
                        </span>
                      </td>
                      <td>{receipt.note ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : null}

      {/* ── The status log (§7.2 — records everything) ───────────────── */}
      <section aria-labelledby="payable-log-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="payable-log-title">
            <span>{t('tab_log')}</span>
            <span className={s.sapTitleMeta}>{t('rows', { count: log.total })}</span>
          </h2>

          <form action={base} className={s.filterBar} method="get">
            <FilterRow>
              <Select
                defaultValue={laneFilter ?? ''}
                emptyLabel={t('all_lanes')}
                label={t('lane')}
                name="lane"
                options={laneOptions}
              />
              <SubmitRow>
                <Submit label={t('filter')} small />
              </SubmitRow>
            </FilterRow>
          </form>

          <div className={s.sapTableWrap}>
            <table aria-labelledby="payable-log-title" className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{t('log_when')}</th>
                  <th scope="col">{t('lane')}</th>
                  <th scope="col">{t('log_what')}</th>
                  <th scope="col">{t('log_who')}</th>
                </tr>
              </thead>
              <tbody>
                {log.rows.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={4}>
                      {t('no_events')}
                    </td>
                  </tr>
                ) : null}
                {log.rows.map((event) => (
                  <tr key={event.id}>
                    <td>
                      <bdi dir="ltr">{day(event.occurredAt)}</bdi>
                    </td>
                    <td>
                      <span
                        className={`status ${s.sapRegisterStatus}`}
                        data-status={event.laneCode === 'hold' ? 'rejected' : 'submitted'}
                      >
                        {t(`lane_${event.laneCode}`)}
                      </span>
                    </td>
                    <td>
                      {event.summary}
                      {event.sourceNo ? (
                        <>
                          {' '}
                          <bdi dir="ltr">({event.sourceNo})</bdi>
                        </>
                      ) : null}
                    </td>
                    <td>
                      <bdi dir="auto">{event.actorUserId ? (event.actorName ?? '—') : t('system')}</bdi>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className={s.sapBody}>
            <Form action={addNote}>
              <Hidden name="payable_no" value={row.payableNo} />
              <Field id="add-note" label={t('add_note')} name="note" required wide />
              <SubmitRow>
                <Submit label={t('note_save')} small tone="secondary" />
              </SubmitRow>
            </Form>
          </div>
        </div>
      </section>

      {/* ── Attachments & history ────────────────────────────────────── */}
      <section aria-label={t('tab_attachments')} className={s.sapDoc}>
        <div className={s.sapWindow}>
          <Attachments
            preloaded={found.attachments}
            action={attachToPayable}
            hidden={{ payable_no: row.payableNo }}
            mayAttach={mayEdit}
            objectId={row.id}
            objectType={payables.PERMISSION_OBJECT}
          />
        </div>
      </section>
      <RecordHistory objectId={row.id} objectType={payables.PERMISSION_OBJECT} preloaded={found.history} />
    </AdminPage>
  );
}
