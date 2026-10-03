import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import {
  AdminPage,
  Field,
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
import { NewRecordDialog } from '@/components/admin/dialog';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { Attachments } from '@/components/admin/attachments';
import { RecordHistory } from '@/components/admin/history';
import { AttachmentsButton, HistoryButton } from '@/components/admin/icon-dialog';
import * as attachmentsService from '@/server/services/attachments';
import { SectionTabs } from '@/components/admin/section-tabs';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as loans from '@/server/services/loans';
import {
  approveLoan,
  attachToLoan,
  cancelLoan,
  disburseLoan,
  payCommissionAction,
  payInstalmentAction,
  setScheduleAction,
  setSharesAction,
} from '../actions';
import { INSTALMENT_CHIP, LOAN_CHIP } from '../status';
import { STATUS_CHIP } from '../../payment-applications/status';
import { windowTone } from '../../window-tone';
import { businessToday } from '@/server/domain/business-date';
import { isNotFoundError } from '@/server/not-found';

/**
 * One bank loan — REQ-AP-001 §15.7, §21.10.
 *
 * The Purchase Invoice's window: the loan in boxes, its schedule as the grid
 * (each instalment's status, and when and how it was paid), and the foot
 * holding what may be done next — approve, record the money arriving, pay
 * the next instalment — beside what is outstanding and what is left to fund.
 * Under it, what the loan funded and the commission each draw carries to its
 * import; then the contract and the bank's letters; then the audit log.
 */
export const dynamic = 'force-dynamic';

export default async function LoanPage({
  params,
  searchParams,
}: {
  params: Promise<{ loanNo: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/payables/loans')) notFound();
  const { loanNo: raw } = await params;
  const loanNo = decodeURIComponent(raw);
  const [t, pa, admin, page, locale, context, outcome] = await Promise.all([
    getTranslations('admin.loans'),
    getTranslations('admin.payment_applications'),
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', loans.PERMISSION_OBJECT)) {
    return <Denied object={page('loans')} />;
  }

  const found = await withCurrentUser(async (tx) => {
    try {
      return await loans.view(tx, loanNo);
    } catch (error) {
      // E1 — a missing record is a 404; anything else reaches the error boundary.
      if (isNotFoundError(error)) return null;
      throw error;
    }
  });
  if (!found) notFound();
  const { loan, treatment, schedule, allocations, totals } = found;
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');
  const money = (value: string, currency = loan.currency) => formatMoney(value, currency, locale as Locale);
  const today = businessToday();
  const hidden = { loan_no: loan.loanNo };

  const mine = loan.createdBy === principal.userId;
  const mayEdit = loan.status === 'draft' && can(principal, 'edit_draft', loans.PERMISSION_OBJECT);
  const mayApprove = loan.status === 'draft' && !mine && can(principal, 'approve', loans.PERMISSION_OBJECT);
  const mayPost = can(principal, 'post', loans.PERMISSION_OBJECT);
  const mayDisburse = loan.status === 'approved' && mayPost;
  const unpaid = schedule.filter((row) => row.status !== 'paid');
  const mayPay = loan.status === 'active' && mayPost && unpaid.length > 0;
  const commissionOnItsOwn = !treatment.deducted && !treatment.spread && Number(loan.commissionTxn) > 0;
  const mayPayCommission =
    commissionOnItsOwn && !loan.commissionPaidOn && (loan.status === 'approved' || loan.status === 'active') && mayPost;
  const mayCancel =
    (loan.status === 'draft' && can(principal, 'edit_draft', loans.PERMISSION_OBJECT)) ||
    (loan.status === 'approved' && can(principal, 'reverse_cancel', loans.PERMISSION_OBJECT));
  const live = allocations.filter((row) => !row.releasedAt);
  const mayShare = loan.allocationMethod === 'manual' && live.length > 0 && can(principal, 'approve', loans.PERMISSION_OBJECT);
  const net = money(loan.netProceedsTxn);
  const chip = LOAN_CHIP[loan.status] ?? 'draft';
  // Master names are held in English; Arabic reads the seeded code's translation.
  const treatmentName = locale !== 'en' && t.has(`tr.${treatment.code}`) ? t(`tr.${treatment.code}`) : treatment.name;

  const fields: DocumentField[] = [
    { label: t('col_no'), value: <bdi dir="ltr">{loan.loanNo}</bdi> },
    { label: t('col_status'), value: t(`status_${loan.status}`), status: windowTone(chip) },
    {
      label: t('bank'),
      value: <bdi dir="auto">{found.bank ? `${found.bank.name}${found.bank.swiftBic ? ` · ${found.bank.swiftBic}` : ''}` : loan.bankCode}</bdi>,
    },
    {
      label: t('account'),
      value: (
        <Link className={s.sapLink} href={`/master-data/bank-accounts/${encodeURIComponent(found.account.code)}`}>
          <bdi dir="ltr">
            {found.account.code} · {found.account.name}
          </bdi>
        </Link>
      ),
    },
    { label: t('principal'), value: <bdi dir="ltr">{money(loan.principalTxn)}</bdi> },
    {
      label: t('commission'),
      value: (
        <bdi dir="auto">
          {Number(loan.commissionPct).toString()}% · {money(loan.commissionTxn)} · {treatmentName}
        </bdi>
      ),
    },
    { label: t('net_proceeds'), value: <bdi dir="ltr">{net}</bdi> },
    {
      label: t('commission_booked'),
      value: loan.commissionCapitalised ? t('capitalised_yes') : t('capitalised_no'),
    },
    { label: t('interest'), value: loan.interestPctPa ? `${Number(loan.interestPctPa).toString()}%` : '—' },
    { label: t('allocation_method'), value: t(`method_${loan.allocationMethod}`) },
    { label: t('frequency'), value: `${t(`freq_${loan.frequency}`)} · ${loan.instalmentCount}` },
    { label: t('maturity'), value: <bdi dir="ltr">{day(loan.maturityDate)}</bdi> },
    {
      label: t('disbursed'),
      value: loan.disbursementDate ? (
        <bdi dir="ltr">
          {day(loan.disbursementDate)} · {loan.disbursementReference}
        </bdi>
      ) : (
        t('not_yet')
      ),
    },
    ...(commissionOnItsOwn
      ? [
          {
            label: t('commission_paid'),
            value: loan.commissionPaidOn ? (
              <bdi dir="ltr">
                {day(loan.commissionPaidOn)} · {loan.commissionReference}
              </bdi>
            ) : (
              t('not_yet')
            ),
          },
        ]
      : []),
    { label: t('entered_by'), value: <bdi dir="auto">{found.people.createdBy ?? '—'}</bdi> },
    { label: t('approved_by'), value: <bdi dir="auto">{found.people.approvedBy ?? '—'}</bdi> },
    ...(loan.purpose ? [{ label: t('purpose'), value: <bdi dir="auto">{loan.purpose}</bdi>, wide: true }] : []),
    ...(loan.closedReason
      ? [{ label: t('cancel_reason'), value: <bdi dir="auto">{loan.closedReason}</bdi>, status: 'cancelled', wide: true }]
      : []),
  ];

  const scheduleRows = [...schedule.map((row) => row), ...Array.from({ length: Math.max(0, 8 - schedule.length) }, () => null)];

  // What the paperclip says it holds.
  const attachedCount = await withCurrentUser((tx) =>
    attachmentsService.currentFor(tx, loans.PERMISSION_OBJECT, loan.id),
  ).then((rows) => rows.length);

  return (
    <AdminPage
      back={{ href: '/payables/loans', label: page('loans') }}
      tabs={<SectionTabs route="/payables/loans" />}
      title={loan.loanNo}
      trail={[{ href: '/', label: admin('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />

      <DocumentWindow
        actions={
          <>
            {mayApprove ? (
              <form action={approveLoan}>
                <Hidden name="loan_no" value={loan.loanNo} />
                <Submit label={t('approve')} variant="document" />
              </form>
            ) : null}
            {mayDisburse ? (
              <NewRecordDialog
                buttonLabel={t('disburse')}
                closeLabel={admin('close')}
                title={t('disburse_title', { loanNo: loan.loanNo })}
              >
                <p className="muted">{t('disburse_note', { net, principal: money(loan.principalTxn) })}</p>
                <Form action={disburseLoan}>
                  <Hidden name="loan_no" value={loan.loanNo} />
                  <Grid>
                    <Field defaultValue={today} label={t('disbursement_date')} name="disbursement_date" required type="date" />
                    <Field id="disburse-reference" label={t('reference')} name="reference" required />
                  </Grid>
                  <SubmitRow>
                    <Submit label={t('disburse')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {mayPay ? (
              <NewRecordDialog buttonLabel={t('pay')} closeLabel={admin('close')} title={t('pay_title', { loanNo: loan.loanNo })}>
                <p className="muted">{t('pay_note')}</p>
                <Form action={payInstalmentAction}>
                  <Hidden name="loan_no" value={loan.loanNo} />
                  <Grid>
                    <Select
                      defaultValue={unpaid[0]?.id}
                      label={t('instalment')}
                      name="instalment_id"
                      options={unpaid.map((row) => ({
                        value: row.id,
                        label: `${row.sequence}. ${day(row.dueDate)} — ${money(row.totalTxn)}`,
                      }))}
                      required
                    />
                    <Field defaultValue={today} label={t('paid_date')} name="paid_date" required type="date" />
                    <Field id="pay-reference" label={t('reference')} name="reference" required />
                  </Grid>
                  <SubmitRow>
                    <Submit label={t('pay')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {mayPayCommission ? (
              <NewRecordDialog
                buttonLabel={t('pay_commission')}
                closeLabel={admin('close')}
                title={t('pay_commission_title', { loanNo: loan.loanNo })}
              >
                <p className="muted">{t('pay_commission_note')}</p>
                <Form action={payCommissionAction}>
                  <Hidden name="loan_no" value={loan.loanNo} />
                  <Grid>
                    <Field defaultValue={today} label={t('paid_date')} name="paid_on" required type="date" />
                    <Field id="commission-reference" label={t('reference')} name="reference" required />
                  </Grid>
                  <SubmitRow>
                    <Submit label={t('pay_commission')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {mayEdit ? (
              <NewRecordDialog buttonLabel={t('edit_schedule')} closeLabel={admin('close')} title={t('edit_schedule')} wide>
                <p className="muted">{t('edit_schedule_note', { principal: money(loan.principalTxn) })}</p>
                <Form action={setScheduleAction}>
                  <Hidden name="loan_no" value={loan.loanNo} />
                  <Hidden name="row_count" value={String(scheduleRows.length)} />
                  <div className={s.sapTableWrap}>
                    <table className={s.sapTable}>
                      <thead>
                        <tr>
                          <th scope="col">#</th>
                          <th scope="col">{t('due_date')}</th>
                          <th scope="col">{t('principal_part')}</th>
                          <th scope="col">{t('interest_part')}</th>
                          <th scope="col">{t('commission_part')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {scheduleRows.map((row, index) => (
                          <tr key={row?.id ?? `blank-${index}`}>
                            <td>{index + 1}</td>
                            <td>
                              <input
                                aria-label={`${t('due_date')} ${index + 1}`}
                                className={`${s.input} ${s.dateInput}`}
                                defaultValue={row?.dueDate ?? ''}
                                name={`due_${index}`}
                                type="date"
                              />
                            </td>
                            <td>
                              <input
                                aria-label={`${t('principal_part')} ${index + 1}`}
                                className={s.input}
                                defaultValue={row ? Number(row.principalTxn).toFixed(2) : ''}
                                inputMode="decimal"
                                name={`principal_${index}`}
                              />
                            </td>
                            <td>
                              <input
                                aria-label={`${t('interest_part')} ${index + 1}`}
                                className={s.input}
                                defaultValue={row ? Number(row.interestTxn).toFixed(2) : ''}
                                inputMode="decimal"
                                name={`interest_${index}`}
                              />
                            </td>
                            <td>
                              <input
                                aria-label={`${t('commission_part')} ${index + 1}`}
                                className={s.input}
                                defaultValue={row ? Number(row.commissionTxn).toFixed(2) : ''}
                                inputMode="decimal"
                                name={`commission_${index}`}
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <SubmitRow>
                    <Submit label={t('save_schedule')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {mayCancel ? (
              <ReasonForm
                action={cancelLoan}
                hidden={hidden}
                label={t('cancel')}
                reasonLabel={t('cancel_reason')}
                tone="secondary"
              />
            ) : null}
          </>
        }
        titleActions={
          <>
            {/* The paperclip and the clock, as every record wears them
                (2026-10-03). The loan has no print model yet, so it has no
                printer: a door onto nothing is worse than no door. */}
            <AttachmentsButton
              closeLabel={admin('close')}
              count={attachedCount}
              label={t('attachments')}
              title={t('attachments')}
            >
              <Attachments
                action={attachToLoan}
                hidden={hidden}
                mayAttach={can(principal, 'edit_draft', loans.PERMISSION_OBJECT)}
                objectId={loan.id}
                objectType={loans.PERMISSION_OBJECT}
              />
            </AttachmentsButton>
            <HistoryButton closeLabel={admin('close')} label={admin('history')} title={admin('history')}>
              <RecordHistory objectId={loan.id} objectType={loans.PERMISSION_OBJECT} />
            </HistoryButton>
          </>
        }
        documentType={t('record')}
        fields={fields}
        id="loan-document"
        linesCount={schedule.length}
        linesTitle={t('schedule')}
        number={loan.loanNo}
        totals={[
          { label: t('outstanding'), value: money(totals.outstanding) },
          { label: t('unallocated'), value: money(totals.unallocated) },
        ]}
      >
        <table aria-labelledby="loan-document-lines-heading" className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">{t('due_date')}</th>
              <th className={s.sapNum} scope="col">
                {t('principal_part')}
              </th>
              <th className={s.sapNum} scope="col">
                {t('commission_part')}
              </th>
              <th className={s.sapNum} scope="col">
                {t('interest_part')}
              </th>
              <th className={s.sapNum} scope="col">
                {t('total')}
              </th>
              <th scope="col">{t('col_status')}</th>
              <th scope="col">{t('paid')}</th>
            </tr>
          </thead>
          <tbody>
            {schedule.map((row) => (
              <tr key={row.id}>
                <td>{row.sequence}</td>
                <td>
                  <bdi dir="ltr">{day(row.dueDate)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(row.principalTxn)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(row.commissionTxn)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(row.interestTxn)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(row.totalTxn)}</bdi>
                </td>
                <td>
                  <span
                    className={`status status--${INSTALMENT_CHIP[row.state] ?? 'draft'}`}
                    data-status={INSTALMENT_CHIP[row.state] ?? 'draft'}
                  >
                    {t(`inst_${row.state}`)}
                  </span>
                </td>
                <td>
                  {row.paidDate ? (
                    <bdi dir="ltr">
                      {day(row.paidDate)} · {row.paidReference}
                    </bdi>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DocumentWindow>

      {/* ── What the loan funded, and the commission each draw carries ── */}
      <section aria-labelledby="loan-funded-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="loan-funded-title">
            <span>{t('funded')}</span>
            <span className={s.sapTitleMeta}>
              {t('allocated')} {money(totals.allocated)} · {t('unallocated')} {money(totals.unallocated)}
            </span>
          </h2>
          <Form action={setSharesAction}>
            <Hidden name="loan_no" value={loan.loanNo} />
            <Hidden name="row_count" value={String(live.length)} />
            <div className={s.sapTableWrap}>
              <table aria-labelledby="loan-funded-title" className={s.sapTable}>
                <thead>
                  <tr>
                    <th scope="col">{t('col_application')}</th>
                    <th scope="col">{t('col_import')}</th>
                    <th className={s.sapNum} scope="col">
                      {t('col_drawn')}
                    </th>
                    <th className={s.sapNum} scope="col">
                      {t('col_share')}
                    </th>
                    <th scope="col">{t('col_state')}</th>
                  </tr>
                </thead>
                <tbody>
                  {allocations.length === 0 ? (
                    <tr>
                      <td className={s.sapEmptyRow} colSpan={5}>
                        {t('none_funded')}
                      </td>
                    </tr>
                  ) : null}
                  {allocations.map((row) => {
                    const index = live.findIndex((entry) => entry.id === row.id);
                    return (
                      <tr key={row.id}>
                        <td>
                          <Link
                            className={s.sapLink}
                            href={`/payables/payment-applications/${encodeURIComponent(row.applicationNo)}`}
                          >
                            <bdi dir="ltr">{row.applicationNo}</bdi>
                          </Link>
                          <div>
                            <span
                              className={`status status--${STATUS_CHIP[row.applicationStatus] ?? 'draft'}`}
                              data-status={STATUS_CHIP[row.applicationStatus] ?? 'draft'}
                            >
                              {pa(`status_${row.applicationStatus}`)}
                            </span>
                          </div>
                        </td>
                        <td>
                          <Link className={s.sapLink} href={`/payables/${encodeURIComponent(row.payableNo)}`}>
                            <bdi dir="ltr">{row.payableNo}</bdi>
                          </Link>
                        </td>
                        <td className={s.sapNum}>
                          <bdi dir="ltr">{money(row.amountTxn)}</bdi>
                        </td>
                        <td className={s.sapNum}>
                          {mayShare && index >= 0 ? (
                            <>
                              <Hidden name={`allocation_${index}`} value={row.id} />
                              <input
                                aria-label={`${t('col_share')} ${row.applicationNo}`}
                                className={s.input}
                                defaultValue={Number(row.commissionShareTxn).toFixed(2)}
                                inputMode="decimal"
                                name={`share_${index}`}
                              />
                            </>
                          ) : (
                            <bdi dir="ltr">{money(row.commissionShareTxn)}</bdi>
                          )}
                        </td>
                        <td>
                          {row.releasedAt ? (
                            <>
                              <span className="status status--cancelled" data-status="cancelled">
                                {t('released')}
                              </span>
                              <div className="muted">
                                <bdi dir="auto">{row.releaseReason}</bdi>
                              </div>
                            </>
                          ) : (
                            <span className="status status--approved" data-status="approved">
                              {t('live')}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {mayShare ? (
              <div className={s.sapBody}>
                <SubmitRow>
                  <Submit label={t('share_save')} />
                </SubmitRow>
              </div>
            ) : null}
          </Form>
        </div>
      </section>

    </AdminPage>
  );
}
