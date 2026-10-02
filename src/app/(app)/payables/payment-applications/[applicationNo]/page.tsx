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
  Submit,
  SubmitRow,
  admin as s,
} from '@/components/admin';
import { NewRecordDialog } from '@/components/admin/dialog';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { Attachments } from '@/components/admin/attachments';
import { RecordHistory } from '@/components/admin/history';
import { SectionTabs } from '@/components/admin/section-tabs';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { toDecimalString } from '@domain/money';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as applications from '@/server/services/payment-applications';
import {
  approveApplication,
  attachToApplication,
  cancelApplication,
  confirmApplication,
  confirmBeforeCutOver,
  debitApplication,
  rejectApplication,
  sendApplication,
} from '../actions';
import { STATUS_CHIP, statusKey } from '../status';
import { windowTone } from '../../window-tone';

/**
 * One payment application — REQ-AP-001 §21.7.
 *
 * It wears the Purchase Invoice's window: the header fields in boxes, a grid,
 * and a foot holding what may be done next beside what it comes to. The grid
 * is what a person needs at that moment — before Send, the dashed-arrow
 * checklist (funds, the supplier's verified account, the PD, the trigger);
 * after it, the money's path (sent → confirmed → debited) with the posted
 * document. The Confirm dialog says what it will post before it posts it.
 */
export const dynamic = 'force-dynamic';

const CHECK_CHIP: Readonly<Record<string, string>> = {
  pass: 'settled',
  fail: 'rejected',
  warning: 'submitted',
  not_applicable: 'draft',
};

export default async function PaymentApplicationPage({
  params,
  searchParams,
}: {
  params: Promise<{ applicationNo: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/payables/payment-applications')) notFound();

  const { applicationNo: raw } = await params;
  const applicationNo = decodeURIComponent(raw);
  const [t, admin, page, locale, context, outcome] = await Promise.all([
    getTranslations('admin.payment_applications'),
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);

  const { principal } = context;
  if (!can(principal, 'view', applications.PERMISSION_OBJECT)) {
    return <Denied object={page('payment_applications')} />;
  }

  const found = await withCurrentUser(async (tx) => {
    try {
      return await applications.view(tx, applicationNo);
    } catch {
      return null;
    }
  });
  if (!found) notFound();

  const { application: row, method, account, accountBank, payee, instalment, people, checks } = found;
  const kind = method.kind;
  const money = (amount: string, currency: string = row.currency) => formatMoney(amount, currency, locale as Locale);
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');
  const today = new Date().toISOString().slice(0, 10);

  const mayApprove =
    row.status === 'draft' &&
    can(principal, 'approve', applications.PERMISSION_OBJECT) &&
    row.createdBy !== principal.userId;
  const maySend = row.status === 'approved' && can(principal, 'execute', applications.PERMISSION_OBJECT);
  const mayOverride = can(principal, 'approve', applications.PERMISSION_OBJECT);
  const mayConfirm = row.status === 'sent' && can(principal, 'post', applications.PERMISSION_OBJECT);
  // D37 — a sheet row the sheet left "sent" although the money had gone.
  const mayConfirmMigrated = mayConfirm && row.source === 'sheet_import';
  const mayDebit = row.status === 'confirmed' && can(principal, 'post', applications.PERMISSION_OBJECT);
  const mayReject =
    (row.status === 'approved' || row.status === 'sent') &&
    can(principal, 'approve', applications.PERMISSION_OBJECT);
  const mayCancel =
    (row.status === 'draft' && can(principal, 'edit_draft', applications.PERMISSION_OBJECT)) ||
    ((row.status === 'approved' || row.status === 'sent') &&
      can(principal, 'reverse_cancel', applications.PERMISSION_OBJECT));
  const failing = checks.filter((check) => check.outcome === 'fail');

  const statusChip = windowTone(STATUS_CHIP[row.status] ?? 'draft');
  const documentHref =
    found.documentKind === 'payment' && found.documentNo
      ? `/payables/supplier-payments/${encodeURIComponent(found.documentNo)}`
      : found.documentKind === 'advance' && found.documentNo
        ? `/payables/advances/${encodeURIComponent(found.documentNo)}`
        : null;

  const fields: DocumentField[] = [
    { label: t('col_no'), value: <bdi dir="ltr">{row.applicationNo}</bdi> },
    { label: t('col_status'), value: t(statusKey(row.status, kind)), status: statusChip },
    {
      label: t('col_import'),
      value: (
        <Link className={s.sapLink} href={`/payables/${encodeURIComponent(found.payable.payableNo)}`}>
          <bdi dir="ltr">
            {found.payable.payableNo} · {found.payable.supplierReference}
          </bdi>
        </Link>
      ),
    },
    {
      label: t('instalment'),
      value: instalment ? (
        <bdi dir="auto">
          {instalment.sequence}. {instalment.label} — {instalment.triggerName}
        </bdi>
      ) : (
        '—'
      ),
    },
    {
      label: t('col_supplier'),
      value: <bdi dir="auto">{found.supplier ? `${found.supplier.name} (${found.supplier.code})` : '—'}</bdi>,
    },
    { label: t('col_method'), value: <bdi dir="auto">{method.name}</bdi> },
    {
      label: t('col_account'),
      value: (
        <bdi dir="auto">
          {account.code} · {account.name}
          {accountBank ? ` · ${accountBank.name}` : ''}
        </bdi>
      ),
    },
    {
      label: t('payee'),
      value: payee ? (
        <bdi dir="ltr">
          {payee.bankName} · {payee.accountNumber}
          {payee.swift ? ` · ${payee.swift}` : ''}
        </bdi>
      ) : (
        '—'
      ),
      ...(payee
        ? { status: payee.approvalStatus === 'approved' && payee.isActive ? 'posted' : 'rejected' }
        : {}),
    },
    {
      label: t('funding'),
      value: found.loan ? (
        <>
          <bdi dir="auto">{found.fundingName}</bdi> ·{' '}
          <Link className={s.sapLink} href={`/payables/loans/${encodeURIComponent(found.loan.loanNo)}`}>
            <bdi dir="ltr">{found.loan.loanNo}</bdi>
          </Link>
        </>
      ) : (
        <bdi dir="auto">{found.fundingName}</bdi>
      ),
    },
    {
      label: t('pd'),
      value: found.pd ? (
        <Link
          className={s.sapLink}
          href={`/payables/pd/${encodeURIComponent(found.pd.pdNo)}${found.pd.year ? `?year=${found.pd.year}` : ''}`}
        >
          <bdi dir="ltr">{found.pd.pdNo}</bdi>
        </Link>
      ) : (
        '—'
      ),
    },
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
    { label: t('col_application_date'), value: <bdi dir="ltr">{day(row.applicationDate)}</bdi> },
    {
      label: t('col_days_waiting'),
      value: found.daysWaiting === null ? '—' : t('days_n', { count: found.daysWaiting }),
      ...(found.daysWaiting !== null ? { status: 'submitted' } : {}),
    },
    { label: t('bank_reference'), value: <bdi dir="ltr">{row.bankReference ?? '—'}</bdi> },
    { label: t(`confirmed_on_${kind}`), value: <bdi dir="ltr">{day(row.confirmedOn)}</bdi> },
    { label: t(`reference_${kind}`), value: <bdi dir="ltr">{row.confirmationReference ?? '—'}</bdi> },
    {
      label: t('posted_as'),
      value:
        found.documentNo && documentHref ? (
          <Link className={s.sapLink} href={documentHref}>
            <bdi dir="ltr">{found.documentNo}</bdi>
          </Link>
        ) : (
          '—'
        ),
    },
    { label: t('debit_date'), value: <bdi dir="ltr">{day(row.debitDate)}</bdi> },
    { label: t('raised_by'), value: <bdi dir="auto">{people.createdBy ?? '—'}</bdi> },
    { label: t('approved_by'), value: <bdi dir="auto">{people.approvedBy ?? '—'}</bdi> },
    { label: t('sent_by'), value: <bdi dir="auto">{people.sentBy ?? '—'}</bdi> },
    { label: t('confirmed_by'), value: <bdi dir="auto">{people.confirmedBy ?? '—'}</bdi> },
    ...(row.overriddenChecks.length > 0
      ? [
          {
            label: t('override'),
            value: (
              <bdi dir="auto">
                {row.overriddenChecks.map((code) => t(`check_${code}`)).join(', ')} — {row.overrideReason} (
                {people.overrideBy ?? '—'})
              </bdi>
            ),
            status: 'rejected',
            wide: true,
          },
        ]
      : []),
    ...(row.closedReason
      ? [{ label: t('closed_reason'), value: <bdi dir="auto">{row.closedReason}</bdi>, status: statusChip, wide: true }]
      : []),
    ...(row.note ? [{ label: t('note'), value: <bdi dir="auto">{row.note}</bdi>, wide: true }] : []),
  ];

  // The grid: the checks before Send; the money's path after it.
  const path = [
    {
      step: t('path_sent'),
      date: row.applicationDate,
      detail: row.bankReference ? `${t('bank_reference')}: ${row.bankReference}` : '',
      done: Boolean(row.applicationDate),
    },
    {
      step: t(`path_confirmed_${kind}`),
      date: row.confirmedOn,
      detail: row.confirmationReference ?? '',
      done: Boolean(row.confirmedOn),
    },
    {
      step: t('path_debited'),
      date: row.debitDate,
      detail: row.statementLineId ? t('path_matched') : '',
      done: Boolean(row.debitDate),
    },
  ];
  const showChecks = row.status === 'draft' || row.status === 'approved';

  return (
    <AdminPage
      back={{ href: '/payables/payment-applications', label: page('payment_applications') }}
      tabs={<SectionTabs route="/payables/payment-applications" />}
      title={row.applicationNo}
      trail={[{ href: '/', label: admin('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />

      <DocumentWindow
        actions={
          <>
            {mayApprove ? (
              <form action={approveApplication}>
                <Hidden name="application_no" value={row.applicationNo} />
                <Submit label={t('approve')} variant="document" />
              </form>
            ) : null}
            {maySend ? (
              <NewRecordDialog
                buttonLabel={t('send')}
                closeLabel={admin('close')}
                openOnLoad={Boolean(outcome.error) && row.status === 'approved'}
                title={t('send_title', { applicationNo: row.applicationNo })}
              >
                <p className="muted">{t('send_note')}</p>
                <Form action={sendApplication}>
                  <Hidden name="application_no" value={row.applicationNo} />
                  <Grid>
                    <Field defaultValue={today} label={t('col_application_date')} name="application_date" required type="date" />
                    <Field hint={t('bank_reference_hint')} label={t('bank_reference')} name="bank_reference" />
                  </Grid>
                  {failing.length > 0 && mayOverride ? (
                    <Field
                      hint={t('override_hint', { checks: failing.map((check) => t(`check_${check.code}`)).join(', ') })}
                      label={t('override_reason')}
                      name="override_reason"
                      wide
                    />
                  ) : null}
                  <SubmitRow>
                    <Submit label={t('send')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {mayConfirm ? (
              <NewRecordDialog
                buttonLabel={t(`confirm_${kind}`)}
                closeLabel={admin('close')}
                openOnLoad={Boolean(outcome.error) && row.status === 'sent'}
                title={t(`confirm_${kind}`)}
              >
                <p className="muted">
                  {found.confirmPostsAs === 'payment'
                    ? t('confirm_posts_payment', { invoices: found.owingInvoices.join(', ') })
                    : t('confirm_posts_advance')}
                </p>
                <Form action={confirmApplication}>
                  <Hidden name="application_no" value={row.applicationNo} />
                  <Grid>
                    <Field
                      defaultValue={today}
                      label={t(`confirmed_on_${kind}`)}
                      name="confirmed_on"
                      required
                      type="date"
                    />
                    <Field label={t(`reference_${kind}`)} name="confirmation_reference" required />
                  </Grid>
                  <p className="muted">{t('attach_copy_hint')}</p>
                  <SubmitRow>
                    <Submit label={t(`confirm_${kind}`)} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {mayConfirmMigrated ? (
              <NewRecordDialog
                buttonLabel={t('confirm_before_cut_over')}
                closeLabel={admin('close')}
                title={t('confirm_before_cut_over')}
              >
                <p className="muted">{t('confirm_before_cut_over_note')}</p>
                <Form action={confirmBeforeCutOver}>
                  <Hidden name="application_no" value={row.applicationNo} />
                  <Grid>
                    <Field label={t(`confirmed_on_${kind}`)} name="confirmed_on" required type="date" />
                    <Field label={t(`reference_${kind}`)} name="confirmation_reference" required />
                  </Grid>
                  <p className="muted">{t('attach_copy_hint')}</p>
                  <SubmitRow>
                    <Submit label={t('confirm_before_cut_over')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {mayDebit ? (
              <NewRecordDialog buttonLabel={t('debit')} closeLabel={admin('close')} title={t('debit')}>
                <p className="muted">{t('debit_note')}</p>
                <Form action={debitApplication}>
                  <Hidden name="application_no" value={row.applicationNo} />
                  <Field defaultValue={today} label={t('debit_date')} name="debit_date" required type="date" />
                  <SubmitRow>
                    <Submit label={t('debit')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            <Link className="action" href={`/payables/${encodeURIComponent(found.payable.payableNo)}`}>
              {t('import_tracking')}
            </Link>
            {mayReject ? (
              <ReasonForm
                action={rejectApplication}
                hidden={{ application_no: row.applicationNo }}
                label={t('reject')}
                reasonLabel={t('reject_reason')}
              />
            ) : null}
            {mayCancel ? (
              <ReasonForm
                action={cancelApplication}
                hidden={{ application_no: row.applicationNo }}
                label={t('cancel')}
                reasonLabel={t('cancel_reason')}
                tone="secondary"
              />
            ) : null}
          </>
        }
        auditHref="#audit-log"
        auditLabel={admin('history')}
        documentType={t('document_type')}
        fields={fields}
        id="payment-application-document"
        linesCount={showChecks ? checks.length : path.length}
        linesTitle={showChecks ? t('checks_title') : t('path_title')}
        number={row.applicationNo}
        totals={[
          { label: t('col_amount'), value: money(row.amountTxn) },
          { label: t('available_now', { account: account.code }), value: money(toDecimalString(found.position.availableIqd, 4n), 'IQD') },
        ]}
      >
        {showChecks ? (
          <table aria-labelledby="payment-application-document-lines-heading" className={s.sapTable}>
            <thead>
              <tr>
                <th scope="col">{t('check')}</th>
                <th scope="col">{t('check_result')}</th>
                <th scope="col">{t('check_detail')}</th>
              </tr>
            </thead>
            <tbody>
              {checks.map((check) => (
                <tr key={check.code}>
                  <td>{t(`check_${check.code}`)}</td>
                  <td>
                    <span
                      className={`status status--${CHECK_CHIP[check.outcome]}`}
                      data-status={CHECK_CHIP[check.outcome]}
                    >
                      {t(`outcome_${check.outcome}`)}
                    </span>
                  </td>
                  <td>
                    <bdi dir="auto">{check.detail}</bdi>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table aria-labelledby="payment-application-document-lines-heading" className={s.sapTable}>
            <thead>
              <tr>
                <th scope="col">{t('path_step')}</th>
                <th scope="col">{t('path_date')}</th>
                <th scope="col">{t('path_detail')}</th>
              </tr>
            </thead>
            <tbody>
              {path.map((step) => (
                <tr key={step.step}>
                  <td>
                    <span
                      className={`status status--${step.done ? 'settled' : 'draft'}`}
                      data-status={step.done ? 'settled' : 'draft'}
                    >
                      {step.step}
                    </span>
                  </td>
                  <td>
                    <bdi dir="ltr">{day(step.date)}</bdi>
                  </td>
                  <td>
                    <bdi dir="auto">{step.detail || '—'}</bdi>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </DocumentWindow>

      {/* ── The SWIFT copy, the voucher, the bank's letter ───────────── */}
      <section aria-label={t('attachments')} className={s.sapDoc}>
        <div className={s.sapWindow}>
          <Attachments
            action={attachToApplication}
            hidden={{ application_no: row.applicationNo }}
            mayAttach={can(principal, 'edit_draft', applications.PERMISSION_OBJECT)}
            objectId={row.id}
            objectType={applications.PERMISSION_OBJECT}
          />
        </div>
      </section>
      <RecordHistory objectId={row.id} objectType={applications.PERMISSION_OBJECT} />
    </AdminPage>
  );
}
