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
import { divideHalfUp, MONEY_SCALE, parseDecimal, toDecimalString } from '@domain/money';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as loans from '@/server/services/loans';
import * as bankCash from '@/server/services/bank-cash-accounts';
import * as rates from '@/server/services/exchange-rates';
import {
  approveLoan,
  attachToLoan,
  cancelLoan,
  disburseLoan,
  payCommissionAction,
  payInstalmentAction,
  returnLoanToDraft,
  submitLoan,
  settleLoanEarly,
  setScheduleAction,
  setSharesAction,
} from '../actions';
import { INSTALMENT_CHIP, LOAN_CHIP } from '../status';
import { STATUS_CHIP } from '../../../payables/payment-applications/status';
import { windowTone } from '../../../payables/window-tone';
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
  if (!visibleRoute('/treasury/loans')) notFound();
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

  /*
   * Where the loan stands, summed from the repayments that were actually
   * posted (0275) — the same reading the status is decided from, so the
   * summary and the chip above it cannot disagree.
   */
  /*
   * Every account the company could pay from (2026-10-04). The loan's own is
   * the default — it usually is the one — but the money may be in another, and
   * C-20 asks whichever is chosen whether it holds enough.
   */
  const payFrom = await withCurrentUser(async (tx) => [
    ...(await bankCash.listOfKind(tx, 'bank')),
    ...(await bankCash.listOfKind(tx, 'cash')),
  ]).then((rows) => rows.filter((account) => account.active));

  const [position, repayments, quote] = await withCurrentUser(async (tx) => [
    await loans.positionOf(tx, loan.id),
    await loans.repaymentsOf(tx, loan.id),
    loan.status === 'active' ? await loans.settlementQuote(tx, loan.id, businessToday()) : null,
  ] as const);
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');
  const money = (value: string, currency = loan.currency) => formatMoney(value, currency, locale as Locale);
  const today = businessToday();
  const hidden = { loan_no: loan.loanNo };

  /*
   * A figure at the number of places its own money has (2026-10-03). A dinar
   * has none and a dollar has two, and Finance says which on Currencies &
   * Rates. Rounded on the stored bigint and written from it — these boxes go
   * back to a service that holds the typed schedule to repaying the principal
   * exactly, and a figure that went through a double might not.
   */
  const places = BigInt(
    (await withCurrentUser((tx) => rates.currencies(tx))).find((row) => row.code === loan.currency)?.decimals ?? 2,
  );
  const atPlaces = (value: string): string => {
    const scaled = parseDecimal(value, MONEY_SCALE);
    if (places >= MONEY_SCALE) return toDecimalString(scaled, MONEY_SCALE);
    return toDecimalString(divideHalfUp(scaled, 10n ** (MONEY_SCALE - places)), places);
  };

  /*
   * Whose loan it is, for the four-eyes rule — and not a super user's, because
   * `loans.approve` exempts them and a screen that hid the button would be a
   * screen disagreeing with the service behind it (2026-10-04).
   *
   * The company has one approver; that was the direction on 2026-10-03, and
   * the services were changed then. The buttons were not, so the owner could
   * send a loan for approval and then find nothing to press.
   */
  const mine = loan.createdBy === principal.userId && !principal.isSuperUser;
  const mayEdit = loan.status === 'draft' && can(principal, 'edit_draft', loans.PERMISSION_OBJECT);
  /*
   * Sent for approval by whoever may enter a loan — including the person who
   * entered it, since sending is not agreeing. Approval is a different grant
   * and still refuses them (0273).
   */
  const maySubmit = loan.status === 'draft' && can(principal, 'create', loans.PERMISSION_OBJECT);
  const mayApprove =
    (loan.status === 'draft' || loan.status === 'submitted') &&
    !mine &&
    can(principal, 'approve', loans.PERMISSION_OBJECT);
  const mayReturn = loan.status === 'submitted' && can(principal, 'approve', loans.PERMISSION_OBJECT);
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

  /*
   * The instalments there are, and no blank rows after them (2026-10-03). It
   * used to pad to eight, so a loan of four showed four empty dates nobody had
   * asked for — and the padding was the only way to lengthen a schedule, which
   * is a regeneration rather than four empty boxes.
   */
  const scheduleRows = schedule;

  // What the paperclip says it holds.
  const attachedCount = await withCurrentUser((tx) =>
    attachmentsService.currentFor(tx, loans.PERMISSION_OBJECT, loan.id),
  ).then((rows) => rows.length);

  return (
    <AdminPage
      back={{ href: '/treasury/loans', label: page('loans') }}
      tabs={<SectionTabs route="/treasury/loans" />}
      title={loan.loanNo}
      trail={[{ href: '/', label: admin('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />

      <DocumentWindow
        actions={
          <>
            {maySubmit ? (
              <form action={submitLoan}>
                <Hidden name="loan_no" value={loan.loanNo} />
                {/* The accent button: sending a loan for approval is what the
                    draft is for, and the company chose gold for the action a
                    screen exists to take (2026-10-03). */}
                <Submit label={t('submit')} variant="document" />
              </form>
            ) : null}
            {mayReturn ? (
              <form action={returnLoanToDraft} title={t('return_hint')}>
                <Hidden name="loan_no" value={loan.loanNo} />
                <input aria-label={t('return_reason')} name="reason" placeholder={t('return_reason')} required type="text" />
                <Submit label={t('return_to_draft')} tone="secondary" variant="document" />
              </form>
            ) : null}
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
                    <Select
                      defaultValue={loan.bankCashAccountId}
                      label={t('paid_from')}
                      name="bank_cash_account_id"
                      options={payFrom.map((account) => ({
                        value: account.id,
                        label: `${account.name} (${account.code}) · ${account.currency}`,
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
                          <th className={s.sapNum} scope="col">
                            {`${t('principal_part')} (${loan.currency})`}
                          </th>
                          <th className={s.sapNum} scope="col">
                            {`${t('interest_part')} (${loan.currency})`}
                          </th>
                          <th className={s.sapNum} scope="col">
                            {`${t('commission_part')} (${loan.currency})`}
                          </th>
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
                                defaultValue={row ? atPlaces(row.principalTxn) : ''}
                                inputMode="decimal"
                                name={`principal_${index}`}
                              />
                            </td>
                            <td>
                              <input
                                aria-label={`${t('interest_part')} ${index + 1}`}
                                className={s.input}
                                defaultValue={row ? atPlaces(row.interestTxn) : ''}
                                inputMode="decimal"
                                name={`interest_${index}`}
                              />
                            </td>
                            <td>
                              <input
                                aria-label={`${t('commission_part')} ${index + 1}`}
                                className={s.input}
                                defaultValue={row ? atPlaces(row.commissionTxn) : ''}
                                inputMode="decimal"
                                name={`commission_${index}`}
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      {/* What the rows come to, against what the loan is.
                          `setSchedule` refuses a schedule that does not repay
                          the principal exactly; this says so before it is
                          pressed (2026-10-03). */}
                      <tfoot>
                        <tr className={s.sapTotalRow}>
                          <td colSpan={2}>{t('principal_total')}</td>
                          <td className={s.sapNum}>
                            <bdi dir="ltr">{money(loan.principalTxn)}</bdi>
                          </td>
                          <td colSpan={2} />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                  <SubmitRow>
                    <Submit label={t('save_schedule')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {/*
              Ending it early: what is left, the interest it has earned since
              the last payment, and whatever the bank charges to close it
              (2026-10-03). The loan becomes fully repaid by the same rule
              every repayment goes through — the principal reaching nothing —
              not because this dialog says so.
            */}
            {quote && loan.status === 'active' && mayPost ? (
              <NewRecordDialog
                buttonLabel={t('settle_early')}
                closeLabel={admin('close')}
                title={t('settle_title', { loanNo: loan.loanNo })}
              >
                <p className="muted">{t('settle_note')}</p>
                <Form action={settleLoanEarly}>
                  <Hidden name="loan_no" value={loan.loanNo} />
                  <Grid>
                    <Select
                      defaultValue={loan.bankCashAccountId}
                      label={t('paid_from')}
                      name="bank_cash_account_id"
                      options={payFrom.map((account) => ({
                        value: account.id,
                        label: `${account.name} (${account.code}) · ${account.currency}`,
                      }))}
                      required
                    />
                    <Field defaultValue={today} label={t('settle_date')} name="paid_date" required type="date" />
                    <Field
                      defaultValue={toDecimalString(quote.accruedInterest, MONEY_SCALE)}
                      label={t('settle_interest')}
                      name="interest"
                    />
                    <Field label={t('settle_fee')} name="fee" />
                    <Field label={t('settle_reference')} name="reference" required />
                  </Grid>
                  <p className="muted">
                    {t('settle_outstanding')} {money(toDecimalString(quote.outstanding, MONEY_SCALE))}
                    {' · '}
                    {t('settle_total')} {money(toDecimalString(quote.total, MONEY_SCALE))}
                  </p>
                  <SubmitRow>
                    <Submit label={t('settle_early')} />
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
          { label: t('outstanding'), value: money(toDecimalString(position.outstanding, MONEY_SCALE)) },
          { label: t('repaid'), value: money(toDecimalString(position.principalRepaid, MONEY_SCALE)) },
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
                                defaultValue={atPlaces(row.commissionShareTxn)}
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

      {/* ── Where it stands, from what was posted ──────────────────── */}
      <section aria-labelledby="loan-summary-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="loan-summary-title">
            <span>{t('summary')}</span>
            {/* The same chip the header wears, so the summary and the
                document agree about what the loan is. */}
            <span className={`status status--${windowTone(chip)}`} data-status={windowTone(chip)}>
              {t(`status_${loan.status}`)}
            </span>
          </h2>
          <div className={s.sapBody}>
            <div className={s.sapFields}>
              {[
                { label: t('sum_principal'), value: position.principal },
                { label: t('sum_repaid'), value: position.principalRepaid },
                { label: t('sum_outstanding'), value: position.outstanding },
                { label: t('sum_interest'), value: position.interestPaid },
                { label: t('sum_fees'), value: position.feesPaid },
                { label: t('sum_total'), value: position.totalPaid },
              ].map((figure) => (
                <div className={s.sapField} key={figure.label}>
                  <span className={s.sapLabel}>{figure.label}</span>
                  <span className={s.sapBox}>
                    <bdi dir="ltr">{money(toDecimalString(figure.value, MONEY_SCALE))}</bdi>
                  </span>
                </div>
              ))}
              <div className={s.sapField}>
                <span className={s.sapLabel}>{t('sum_repaid_on')}</span>
                <span className={s.sapBox}>
                  <bdi dir="ltr">{day(position.repaidOn)}</bdi>
                </span>
              </div>
              <div className={s.sapField}>
                <span className={s.sapLabel}>{t('sum_left')}</span>
                <span className={s.sapBox}>
                  <bdi dir="ltr">{position.instalmentsLeft}</bdi>
                </span>
              </div>
            </div>
          </div>

          {/* What has actually been paid, newest first. */}
          <div className={s.sapTableWrap}>
            <table aria-labelledby="loan-summary-title" className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{t('paid_on')}</th>
                  <th scope="col">{t('rep_kind')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('principal_part')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('interest_part')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('fees_part')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('total_part')}
                  </th>
                  <th scope="col">{t('reference')}</th>
                </tr>
              </thead>
              <tbody>
                {repayments.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={7}>
                      {t('no_repayments')}
                    </td>
                  </tr>
                ) : null}
                {repayments.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <bdi dir="ltr">{day(row.paidDate)}</bdi>
                    </td>
                    <td>{t(`rk_${row.kind}`)}</td>
                    <td className={s.sapNum}>{money(row.principalTxn)}</td>
                    <td className={s.sapNum}>{money(row.interestTxn)}</td>
                    <td className={s.sapNum}>{money(row.feesTxn)}</td>
                    <td className={s.sapNum}>{money(row.totalTxn)}</td>
                    <td>
                      <bdi dir="ltr">{row.reference}</bdi>
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
