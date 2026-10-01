import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import {
  AdminPage,
  Field,
  Flash,
  Form,
  Hidden,
  KeyValue,
  ReasonForm,
  Select,
  Submit,
  SubmitRow,
  admin as s,
} from '@/components/admin';
import { Attachments } from '@/components/admin/attachments';
import { RecordHistory } from '@/components/admin/history';
import { StopDialog } from '@/components/admin/stop-dialog';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { PENDING_REASON } from '@domain/payables';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as events from '@/server/services/payable-events';
import * as payables from '@/server/services/payables';
import * as settingsService from '@/server/services/payables-settings';
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

/**
 * The payable page — REQ-AP-001 §21.3, the one record everybody opens.
 *
 * The stage rail across the top shows the type's stages with the current one
 * lit and the diagram's ✓ marks; the chips row carries what the diagram says
 * every payable shows; a red banner sits under them whenever a hold is open —
 * the reason, the owner, the days, and what happens next. Below, the lanes
 * this build stage ships: Order & invoice, the Status log, Attachments &
 * history.
 */
export const dynamic = 'force-dynamic';

const TABS = ['order', 'log', 'attachments'] as const;
type Tab = (typeof TABS)[number];

export default async function PayablePage({
  params,
  searchParams,
}: {
  params: Promise<{ payableNo: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/payables')) notFound();

  const { payableNo } = await params;
  const [t, pageT, locale, context, outcome, query] = await Promise.all([
    getTranslations('admin.payables'),
    getTranslations('page'),
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

  const tab: Tab = TABS.includes(query.tab as Tab) ? (query.tab as Tab) : 'order';
  const laneFilter = typeof query.lane === 'string' ? query.lane : null;

  const found = await withCurrentUser(async (tx) => {
    try {
      const view = await payables.view(tx, payableNo);
      const log = await events.logFor(tx, view.payable.id, {
        laneCode: laneFilter,
        search: typeof query.logq === 'string' ? query.logq : null,
        page: outcome.page,
      });
      const config = await settingsService.overview(tx);
      const people = await users.listAll(tx);
      return { ...view, log, config, people };
    } catch {
      return null;
    }
  });
  if (!found) notFound();

  const { payable: row, type, rail, lanes, lines, invoices, holds, supplier, log, config, people } =
    found;

  const money = (amount: string, currency = row.currency) =>
    formatMoney(amount, currency, locale as Locale);
  const day = (value: string | Date | null) =>
    value ? formatBusinessDate(new Date(value).toISOString().slice(0, 10), locale as Locale) : '—';
  const daysSince = (since: Date | string) =>
    Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 86_400_000));

  const activeRail = rail.filter((stage) => stage.active);
  const currentSeq = activeRail.find((stage) => stage.code === row.stageCode)?.sequence ?? 0;
  const oldestHold = holds[0] ?? null;

  const base = `/payables/${encodeURIComponent(row.payableNo)}`;
  const reasonOptions = config.reasons
    .filter((reason) => reason.active && reason.code !== PENDING_REASON)
    .map((reason) => ({ value: reason.code, label: `${reason.code} — ${reason.name}` }));
  const ownerOptions = people
    .filter((person) => person.isActive)
    .map((person) => ({ value: person.id, label: person.displayName }));
  const laneOptions = lanes.map((lane) => ({ value: lane.code, label: t(`lane_${lane.code}`) }));
  const railName = (stage: (typeof rail)[number]) =>
    (stage as { name?: string }).name ?? stage.code;

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
      subtitle={`${type.name} · ${supplier?.name ?? ''}`}
      title={row.payableNo}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <section aria-label={t('rail')} className={s.sapDoc}>
        <div className={s.sapWindow}>
          {/* ── The stage rail (§21.3) ────────────────────────────────── */}
          <ol className={s.inline} style={{ listStyle: 'none', margin: 0, padding: '0.4rem 0', flexWrap: 'wrap' }}>
            {activeRail.map((stage) => (
              <li aria-current={stage.code === row.stageCode ? 'step' : undefined} key={stage.code}>
                <span
                  className={`status ${s.sapRegisterStatus}`}
                  data-status={
                    stage.sequence < currentSeq
                      ? 'approved'
                      : stage.code === row.stageCode
                        ? 'submitted'
                        : 'draft'
                  }
                >
                  {stage.sequence}. {railName(stage)}
                  {(stage as { isTerminalMark?: boolean }).isTerminalMark ? ' ✓' : ''}
                  {stage.code === row.stageCode
                    ? ` · ${t('days_n', { count: daysSince(row.stageSince) })}`
                    : ''}
                </span>
              </li>
            ))}
          </ol>

          {/* ── The chips (§5.2) ──────────────────────────────────────── */}
          <KeyValue
            rows={[
              { label: t('reference'), value: <bdi dir="ltr">{row.supplierReference}</bdi> },
              {
                label: t('supplier'),
                value: supplier ? `${supplier.name} (${supplier.code})` : '—',
              },
              {
                label: t('col_amount'),
                value: (
                  <bdi dir="ltr">
                    {money(row.amountTxn)} · {money(row.amountIqd, 'IQD')}
                  </bdi>
                ),
              },
              { label: t('quantity'), value: row.quantity ?? '—' },
              { label: t('terms'), value: row.paymentTermsText ?? '—' },
              { label: t('document_date'), value: <bdi dir="ltr">{day(row.documentDate)}</bdi> },
              { label: t('due_date'), value: <bdi dir="ltr">{day(row.dueDate)}</bdi> },
              { label: t('col_branch'), value: <bdi dir="ltr">{row.branchCode}</bdi> },
              {
                label: t('col_stopped'),
                value: row.onHold ? (
                  <span className="status status--rejected" data-status="rejected">
                    {t('stopped_yes')} · {oldestHold?.reasonCode ?? ''} ·{' '}
                    {t('days_n', { count: oldestHold ? daysSince(oldestHold.startedAt) : 0 })}
                  </span>
                ) : (
                  t('stopped_no')
                ),
              },
            ]}
          />

          {/* ── The stop banner(s) (§21.3) ────────────────────────────── */}
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

      {/* ── Tabs (§21.3) ─────────────────────────────────────────────── */}
      <nav aria-label={t('tabs')} className={s.sapFootActions}>
        {TABS.map((key) => (
          <Link
            aria-current={tab === key ? 'page' : undefined}
            className={`${s.button} ${s.small}${tab === key ? ` ${s.primary}` : ''}`}
            href={`${base}?tab=${key}`}
            key={key}
          >
            {t(`tab_${key}`)}
          </Link>
        ))}
      </nav>

      {tab === 'order' ? (
        <section aria-labelledby="order-title" className={s.sapDoc}>
          <div className={s.sapWindow}>
            <h2 className={s.sapTitle} id="order-title">
              <span>{t('tab_order')}</span>
            </h2>

            <div className={s.sapTableWrap}>
              <table className={s.sapTable}>
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
                      <td className={s.sapNum}>{line.quantity ?? '—'}</td>
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
            </div>

            <p className={s.sapGridCaption}>{t('invoices')}</p>
            <div className={s.sapTableWrap}>
              <table className={s.sapTable}>
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
                          {invoice.status}
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

            {mayEdit && !row.cancelledAt && !row.closedAt ? (
              <div className={s.sapFootActions}>
                <Form action={setTerms}>
                  <Hidden name="payable_no" value={row.payableNo} />
                  <Field
                    defaultValue={row.paymentTermsText ?? ''}
                    id="terms-edit"
                    label={t('terms')}
                    name="payment_terms"
                    required
                  />
                  <SubmitRow>
                    <Submit label={t('terms_save')} small tone="secondary" />
                  </SubmitRow>
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
                  <SubmitRow>
                    <Submit label={t('link_save')} small tone="secondary" />
                  </SubmitRow>
                </Form>
                {mayCancel ? (
                  <ReasonForm
                    action={cancelPayable}
                    hidden={{ payable_no: row.payableNo }}
                    label={t('cancel')}
                    reasonLabel={t('cancel_reason')}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {tab === 'log' ? (
        <section aria-labelledby="log-title" className={s.sapDoc}>
          <div className={s.sapWindow}>
            <h2 className={s.sapTitle} id="log-title">
              <span>{t('tab_log')}</span>
              <span className={s.sapTitleMeta}>{t('rows', { count: log.total })}</span>
            </h2>

            <nav aria-label={t('lane')} className={s.sapFootActions}>
              <Link
                aria-current={!laneFilter ? 'page' : undefined}
                className={`${s.button} ${s.small}${!laneFilter ? ` ${s.primary}` : ''}`}
                href={`${base}?tab=log`}
              >
                {t('all_lanes')}
              </Link>
              {lanes.map((lane) => (
                <Link
                  aria-current={laneFilter === lane.code ? 'page' : undefined}
                  className={`${s.button} ${s.small}${laneFilter === lane.code ? ` ${s.primary}` : ''}`}
                  href={`${base}?tab=log&lane=${lane.code}`}
                  key={lane.code}
                >
                  {t(`lane_${lane.code}`)}
                </Link>
              ))}
            </nav>

            <div className={s.sapTableWrap}>
              <table className={s.sapTable}>
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
                      <td>{event.actorUserId ? '' : t('system')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <Form action={addNote}>
              <Hidden name="payable_no" value={row.payableNo} />
              <Field id="add-note" label={t('add_note')} name="note" required wide />
              <SubmitRow>
                <Submit label={t('note_save')} small tone="secondary" />
              </SubmitRow>
            </Form>
          </div>
        </section>
      ) : null}

      {tab === 'attachments' ? (
        <section aria-label={t('tab_attachments')} className={s.sapDoc}>
          <div className={s.sapWindow}>
            <Attachments
              action={attachToPayable}
              hidden={{ payable_no: row.payableNo }}
              mayAttach={mayEdit}
              objectId={row.id}
              objectType={payables.PERMISSION_OBJECT}
            />
          </div>
          <RecordHistory objectId={row.id} objectType={payables.PERMISSION_OBJECT} />
        </section>
      ) : null}
    </AdminPage>
  );
}
