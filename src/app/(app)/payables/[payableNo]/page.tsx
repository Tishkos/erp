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
import { AttachmentsButton, HistoryButton, NotesButton } from '@/components/admin/icon-dialog';
import * as papers from '@/server/services/payable-papers';
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
import { createApplication } from '../payment-applications/actions';
import { registerPd } from '../pd/actions';
import { pdChip } from '../pd/status';
import { claimShortageAction, createBlAction } from '../shipments/actions';
import { ContainerRowsGrid } from '@/components/admin/container-rows-grid';
import { SIZE_TYPES } from '@/server/domain/shipments';
import { addLandedCharge, lockLandedCost, settleExchangeDifference, withdrawLandedCharge } from '../actions';
import { containerChip } from '../containers/status';
import { STATUS_CHIP, statusKey } from '../payment-applications/status';
import { businessDateOf, businessToday } from '@/server/domain/business-date';
import { divideHalfUp, MONEY_SCALE, parseDecimal, toDecimalString } from '@domain/money';
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
  // IM2-1 — a shortage is claimed with a goods return.
  const mayClaim = can(principal, 'create', 'goods_return');
  // IM2 — the B/L's containers table, its words in the reader's language.
  const containerGridLabels = {
    containerNo: sh('container_no'),
    sizeType: sh('size_type'),
    sealNo: sh('seal_no'),
    remove: sh('remove_container'),
    left: sh('grid_left'),
    typed: sh('grid_typed'),
    divided: sh('grid_divided'),
    tooMany: sh('grid_too_many', { left: '{left}' }),
    notANumber: sh('grid_not_a_number'),
    checkDigit: sh('grid_check_digit', { digit: '{digit}' }),
  };

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
    blModels,
    landed,
  } = found;
  const openPay = query.pay === '1';

  const money = (amount: string, currency = row.currency) =>
    formatMoney(amount, currency, locale as Locale);
  const day = (value: string | Date | null) =>
    value ? formatBusinessDate(businessDateOf(new Date(value)), locale as Locale) : '—';
  const daysSince = (since: Date | string) =>
    Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 86_400_000));

  // Every attachment the import has, wherever it was put: on the invoice,
  // the declaration, a payment application, a bill of lading or a container.
  const allPapers = await withCurrentUser((tx) => papers.papersFor(tx, row.id));

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

  /*
   * The rail, as chips.
   *
   * Where a stage sends you: the lane that answers for it. The sections are
   * already on this page under these anchors, so "where are we" and "what do
   * I do about it" are one click apart.
   */
  const STAGE_SECTION: Readonly<Record<string, string>> = {
    import_invoiced_funded: '#payments',
    fully_paid: '#payments',
    payment_sent: '#payments',
    closed_matched: '#payments',
    import_pd_registered: '#pd',
    import_shipped: '#shipment',
    import_partly_received: '#shipment',
    import_all_received: '#shipment',
    goods_received: '#shipment',
    import_cleared: '#landed-cost',
  };

  const railChips = (
    <span className={s.inlineRow}>
      {activeRail.map((stage) => {
        // `reached` is each stage's own rule read against the facts, and they
        // do not hold in order — a payment sent before the declaration is
        // registered is "Payment in progress" with the PD stage never passed.
        const here = stage.code === row.stageCode;
        const holds = found.reached.includes(stage.code);
        const tone = here ? 'submitted' : holds ? 'approved' : 'draft';
        const label = `${stage.sequence}. ${railName(stage)}`;
        const section = STAGE_SECTION[stage.ruleName] ?? null;
        const chip = (
          <span
            className={`status status--${tone}`}
            data-status={tone}
            title={here ? t('rail_now') : holds ? t('rail_done') : t('rail_todo')}
          >
            {label}
          </span>
        );
        return section ? (
          <Link href={section} key={stage.code}>
            {chip}
          </Link>
        ) : (
          <span key={stage.code}>{chip}</span>
        );
      })}
    </span>
  );

  const stageChip = row.cancelledAt
    ? 'cancelled'
    : row.closedAt
      ? 'posted'
      : row.onHold
        ? 'rejected'
        : 'submitted';

  /*
   * The notes somebody wrote, off the log that is loaded (2026-10-03). The
   * status log below the document is the complete record and stays that way;
   * this is the door for "what did we say about this one".
   */
  const written = log.rows.filter((event) => event.eventCode === 'NOTE_ADDED');

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
    /*
     * The rate these dinars were worked out at (2026-10-03).
     *
     * Not stored as a rate and not needed to be: the import holds what was
     * agreed and what it came to, and the one implies the other. Dividing them
     * gives the rate that was actually applied on the day — which is the point
     * the question was really about. A rate published next week converts
     * nothing here, because the lines of a posted invoice are dinars already.
     */
    ...(row.currency !== 'IQD' && parseDecimal(row.amountTxn, MONEY_SCALE) > 0n
      ? [
          {
            label: t('rate_applied'),
            value: (
              <bdi dir="ltr">
                {`1 ${row.currency} = ${money(
                  toDecimalString(
                    divideHalfUp(
                      parseDecimal(row.amountIqd, MONEY_SCALE) * 10_000n,
                      parseDecimal(row.amountTxn, MONEY_SCALE),
                    ),
                    MONEY_SCALE,
                  ),
                  'IQD',
                )}`}
              </bdi>
            ),
          },
        ]
      : []),
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
    { label: t('rail'), value: railChips, wide: true },
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
        titleActions={
          <>
            <AttachmentsButton
              closeLabel={admin('close')}
              count={found.attachments.rows.length}
              label={t('tab_attachments')}
              title={t('tab_attachments')}
            >
              <Attachments
                preloaded={found.attachments}
                action={attachToPayable}
                hidden={{ payable_no: row.payableNo }}
                mayAttach={mayEdit}
                objectId={row.id}
                objectType={payables.PERMISSION_OBJECT}
              />
            </AttachmentsButton>
            {/*
              The notes somebody wrote on this import, behind the same door the
              purchase invoice uses (2026-10-03). They are `NOTE_ADDED` events
              on its own log — the status log below still shows every event of
              every kind; this is the ones a person wrote.
            */}
            <NotesButton
              closeLabel={admin('close')}
              count={written.length}
              label={t('add_note')}
              title={t('add_note')}
            >
              <div className={s.sapTableWrap}>
                <table className={s.sapTable}>
                  <thead>
                    <tr>
                      <th scope="col">{t('log_when')}</th>
                      <th scope="col">{t('log_who')}</th>
                      <th scope="col">{t('add_note')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {written.length === 0 ? (
                      <tr>
                        <td className={s.sapEmptyRow} colSpan={3}>
                          {t('no_events')}
                        </td>
                      </tr>
                    ) : null}
                    {written.map((event) => (
                      <tr key={event.id}>
                        <td>
                          <bdi dir="ltr">{day(event.occurredAt)}</bdi>
                        </td>
                        <td>
                          <bdi dir="auto">{event.actorUserId ? (event.actorName ?? '—') : t('system')}</bdi>
                        </td>
                        <td>
                          <bdi dir="auto">{event.summary}</bdi>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Form action={addNote}>
                <Hidden name="payable_no" value={row.payableNo} />
                <Field id="note-door" label={t('add_note')} name="note" required wide />
                <SubmitRow>
                  <Submit label={t('note_save')} small tone="secondary" />
                </SubmitRow>
              </Form>
            </NotesButton>
            <HistoryButton closeLabel={admin('close')} label={admin('history')} title={admin('history')}>
              <RecordHistory objectId={row.id} objectType={payables.PERMISSION_OBJECT} preloaded={found.history} />
            </HistoryButton>
          </>
        }
        actions={
          mayEdit && !row.cancelledAt && !row.closedAt && mayCancel ? (
            <ReasonForm
              action={cancelPayable}
              hidden={{ payable_no: row.payableNo }}
              label={t('cancel')}
              reasonLabel={t('cancel_reason')}
            />
          ) : null
        }
        documentType={type.name}
        fields={fields}
        id="payable-document"
        linesCount={lines.length}
        linesTitle={t('tab_order')}
        number={row.payableNo}
        totals={[
          {
            label: t('col_amount'),
            // Both, as the header field says them: what the supplier is owed,
            // and what the books carry for it (2026-10-03).
            value:
              row.currency === 'IQD'
                ? money(row.amountIqd, 'IQD')
                : `${money(row.amountTxn)} · ${money(row.amountIqd, 'IQD')}`,
          },
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

      {/*
        The four lanes of an import, side by side.

        They are independent by design (§21.3) — paid while the goods are
        at sea, arrived while customs is open — so they are read against
        each other, and stacking them meant scrolling past three to reach
        the fourth. `chartGrid` is the dashboard's own grid: as many
        columns as fit, stacking itself when the screen is narrow.
      */}
      <div className={s.chartGrid}>
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
                    buttonLabel={pa('new')}
                    closeLabel={admin('close')}
                    openOnLoad={openPay}
                    title={pa('new_for', { payableNo: row.payableNo })}
                  >
                    <Form action={createApplication}>
                      <Hidden name="payable_no" value={row.payableNo} />
                      <Grid>
                        {/*
                          A part payment is the ordinary case, not a special
                          one: 20% with the order, the rest against the bill
                          of lading. The box has always taken any amount —
                          what it was missing was saying so, and saying what
                          is still owed (2026-10-03).
                        */}
                        <Field
                          hint={pa('amount_part_hint', { remaining: money(toDecimalString(paymentTotals.remainingTxn, 4n)) })}
                          label={pa('col_amount')}
                          name="amount"
                        />
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
                        {/* IMPROVEMENT-002 — the supplier's accounts are set up and
                            verified on its profile; the one in this import's
                            currency (the default first) is chosen for you. */}
                        <Select
                          defaultValue={
                            (pickers.payees.find((payee) => payee.verified && payee.currency === row.currency) ??
                              pickers.payees.find((payee) => payee.verified))?.id ?? ''
                          }
                          emptyLabel="—"
                          hint={pa('payee_hint')}
                          label={pa('payee')}
                          name="payee_bank_account_id"
                          options={pickers.payees.map((payee) => ({
                            value: payee.id,
                            label: `${payee.bankName} · ${payee.iban ?? payee.accountNumber}${payee.swift ? ` · ${payee.swift}` : ''} · ${payee.currency}${payee.verified ? '' : ` (${pa('unverified')})`}`,
                          }))}
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
                        <Field hint={sh('eta_hint')} label={sh('eta')} name="eta" required type="date" />
                        <Field label={sh('vessel')} name="vessel" />
                        <Field label={sh('voyage')} name="voyage" />
                        <Field label={sh('shipping_line')} name="shipping_line" />
                        <Field label={sh('port_of_loading')} name="port_of_loading" />
                        <Select
                          emptyLabel="—"
                          label={sh('port_of_discharge')}
                          name="port_of_discharge"
                          options={blPorts.map((port) => ({ value: port.code, label: port.name }))}
                        />
                      </Grid>
                      <p className={s.sapGridCaption}>{sh('containers_caption')}</p>
                      <ContainerRowsGrid
                        labels={containerGridLabels}
                        models={blModels.map((model) => ({
                          key: model.key,
                          label: model.itemCode ?? model.description,
                          unit: model.uomCode,
                          left: model.left,
                        }))}
                        sizeTypes={SIZE_TYPES.map((type) => ({ code: type.code, label: `${type.code} (${type.iso})` }))}
                      />
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

            {!landed.state.ready && landed.state.unlocked > 0 ? (
              <p className={s.sapNote}>{lc('not_lockable')}</p>
            ) : null}

            {mayAddCharge || (mayLock && landed.state.ready && landed.state.unlocked > 0) ? (
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
                  {mayLock && landed.state.ready && landed.state.unlocked > 0 ? (
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
      </div>

      {/* ── Quantities by model (IM2-1): where every unit the invoices
          bought stands — in containers, arrived, claimed, still in transit.
          Full width under the lanes, the supplier-statement manner. ── */}
      {shipment && shipment.quantities.length > 0 ? (
        <section aria-labelledby="payable-quantities-title" className={s.sapDoc} id="quantities">
          <div className={s.sapWindow}>
            <h2 className={s.sapTitle} id="payable-quantities-title">
              <span>{sh('quantities')}</span>
              <span className={s.sapTitleMeta}>
                {sh('x_of_y', { received: shipment.progress.received, total: shipment.progress.total })}
              </span>
            </h2>
            {shipment.quantities.length > 0 ? (
              <div className={s.sapTableWrap}>
                <table aria-label={sh('quantities')} className={s.sapTable}>
                  <thead>
                    <tr>
                      <th scope="col">{sh('model')}</th>
                      <th className={s.sapNum} scope="col">{sh('q_ordered')}</th>
                      <th className={s.sapNum} scope="col">{sh('q_planned')}</th>
                      <th className={s.sapNum} scope="col">{sh('received')}</th>
                      <th className={s.sapNum} scope="col">{sh('damaged')}</th>
                      <th className={s.sapNum} scope="col">{sh('short')}</th>
                      <th className={s.sapNum} scope="col">{sh('q_claimed')}</th>
                      <th className={s.sapNum} scope="col">{sh('q_in_transit')}</th>
                      <th className={s.sapNum} scope="col">{sh('q_not_shipped')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shipment.quantities.map((line) => (
                      <tr key={line.itemCode}>
                        <td>
                          <bdi dir="ltr">{line.itemCode}</bdi> {line.itemName ?? ''}
                        </td>
                        {[line.ordered, line.planned, line.received, line.damaged, line.short, line.claimed, line.inTransit, line.notYetShipped].map((value, index) => (
                          <td className={s.sapNum} key={index}>
                            <bdi dir="ltr">{formatQuantity(value, locale as Locale)}</bdi>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            {shipment.shortageOpen ? (
              <div className={s.sapBody}>
                <p className={s.sapNote}>{sh('shortage_note')}</p>
                {mayClaim && !row.cancelledAt && !row.closedAt ? (
                  <SubmitRow>
                    <NewRecordDialog buttonLabel={sh('claim_shortage')} closeLabel={admin('close')} title={sh('claim_title', { payableNo: row.payableNo })}>
                      <Form action={claimShortageAction}>
                        <Hidden name="payable_no" value={row.payableNo} />
                        <p className={s.sapGridCaption}>{sh('claim_caption')}</p>
                        <Grid>
                          <Field defaultValue={businessToday()} id="claim-date" label={sh('claim_date')} name="return_date" required type="date" />
                          <Field id="claim-reference" label={sh('supplier_reference')} name="supplier_reference" />
                          <Field hint={sh('claim_reason_hint')} id="claim-reason" label={sh('claim_reason')} name="reason" required wide />
                        </Grid>
                        <SubmitRow>
                          <Submit label={sh('claim_shortage')} />
                        </SubmitRow>
                      </Form>
                    </NewRecordDialog>
                  </SubmitRow>
                ) : null}
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

    </AdminPage>
  );
}
