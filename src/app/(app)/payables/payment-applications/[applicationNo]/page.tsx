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
import { Upload } from 'lucide-react';
import { NewRecordDialog } from '@/components/admin/dialog';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { ProfileLink } from '@/components/admin/profile-link';
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
  addApplicationPaper,
  approveApplication,
  cancelApplication,
  confirmBeforeCutOver,
  debitApplication,
  rejectApplication,
  submitApplication,
} from '../actions';
import { STATUS_CHIP, statusKey } from '../status';
import { windowTone } from '../../window-tone';
import { businessDateOf, businessToday } from '@/server/domain/business-date';
import { isNotFoundError } from '@/server/not-found';
import { PurchaseDoors, readDoors } from '../../record-doors';

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
      const seen = await applications.view(tx, applicationNo);
      return {
        ...seen,
        doors: await readDoors(tx, principal, { object: applications.PERMISSION_OBJECT, recordId: seen.application.id }),
        // What each paper is (2026-10-06): the files the paperclip lists, with their kind.
        papers: await applications.papersOf(tx, seen.application.id),
      };
    } catch (error) {
      // E1 — a missing record is a 404; anything else reaches the error boundary.
      if (isNotFoundError(error)) return null;
      throw error;
    }
  });
  if (!found) notFound();

  const { application: row, method, account, accountBank, payee, instalment, people, checks, doors } = found;
  const self = `/payables/payment-applications/${encodeURIComponent(row.applicationNo)}`;
  const accountKind = account.accountType === 'cash' ? 'cash_account' : 'bank_account';
  const kind = method.kind;
  const money = (amount: string, currency: string = row.currency) => formatMoney(amount, currency, locale as Locale);
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');
  const today = businessToday();

  // Draft → Send for approval → Approved by somebody else (2026-10-06, by direction).
  const maySubmit = row.status === 'draft' && can(principal, 'submit', applications.PERMISSION_OBJECT);
  const mayApprove =
    row.status === 'submitted' &&
    can(principal, 'approve', applications.PERMISSION_OBJECT) &&
    (row.createdBy !== principal.userId || principal.isSuperUser);
  // After approval the papers move it: sent to the bank, paid, rejected / cancelled.
  const offered = applications.papersFor(row.status);
  const maySend = offered.includes('sent_to_bank') && can(principal, 'execute', applications.PERMISSION_OBJECT);
  const mayOverride = can(principal, 'approve', applications.PERMISSION_OBJECT);
  const mayConfirm = offered.includes('paid') && can(principal, 'post', applications.PERMISSION_OBJECT);
  const mayRefusePaper =
    (row.status === 'approved' && can(principal, 'reverse_cancel', applications.PERMISSION_OBJECT)) ||
    (row.status === 'sent' && can(principal, 'approve', applications.PERMISSION_OBJECT));
  const mayAttach = can(principal, 'create', 'attachment');
  // D37 — a sheet row the sheet left "sent" although the money had gone.
  const mayConfirmMigrated = mayConfirm && row.source === 'sheet_import';
  const mayDebit = row.status === 'confirmed' && can(principal, 'post', applications.PERMISSION_OBJECT);
  // Before approval a decision needs no paper: the approver rejects, the preparer cancels.
  const mayReject = row.status === 'submitted' && can(principal, 'approve', applications.PERMISSION_OBJECT);
  const mayCancel =
    (row.status === 'draft' || row.status === 'submitted') && can(principal, 'edit_draft', applications.PERMISSION_OBJECT);
  const paperLabel = (kind: string) => t(`paper_${kind}`);
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
      value: <ProfileLink code={found.supplier?.code} dir="auto" kind="supplier" name={found.supplier?.name ?? null} />,
    },
    { label: t('col_method'), value: <bdi dir="auto">{method.name}</bdi> },
    {
      label: t('col_account'),
      value: (
        <>
          <ProfileLink code={account.code} dir="auto" kind={accountKind} name={account.name} />
          {accountBank ? (
            <>
              {' · '}
              <ProfileLink code={accountBank.code} dir="auto" kind="bank">
                {accountBank.name}
              </ProfileLink>
            </>
          ) : null}
        </>
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
          <Link className={s.sapLink} href={`/treasury/loans/${encodeURIComponent(found.loan.loanNo)}`}>
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
  const showChecks = row.status === 'draft' || row.status === 'submitted' || row.status === 'approved';

  /*
   * A paper and the step it proves (2026-10-06, by direction: "once posted it
   * has attachments; whenever someone updates them it has to be pointed out
   * what this attachment is"). One form per kind, each asking only what that
   * step needs; the file is required — but for rejected / cancelled, which
   * asks the reason and takes a paper only if there is one (2026-10-15, by
   * direction: "rejection doesn't need attachments mandatory but needs the
   * reason").
   */
  const paperFile = (optional: boolean) => (
    <label className={s.uploadPicker}>
      <Upload aria-hidden="true" />
      <span>{optional ? t('paper_file_optional') : admin('attachments.choose')}</span>
      <input name="file" required={!optional} type="file" />
    </label>
  );
  const paperDialog = (kind: 'sent_to_bank' | 'paid' | 'rejected_cancelled') => (
    <NewRecordDialog
      buttonLabel={t(`paper_action_${kind}`)}
      closeLabel={admin('close')}
      openOnLoad={Boolean(outcome.error) && ((kind === 'sent_to_bank' && row.status === 'approved') || (kind === 'paid' && row.status === 'sent'))}
      title={t(`paper_title_${kind}`, { applicationNo: row.applicationNo })}
    >
      <p className="muted">{t(`paper_note_${kind}`)}</p>
      <Form action={addApplicationPaper}>
        <Hidden name="application_no" value={row.applicationNo} />
        <Hidden name="kind" value={kind} />
        {kind === 'sent_to_bank' ? (
          <Grid>
            <Field defaultValue={today} label={t('col_application_date')} name="paper_date" required type="date" />
            <Field hint={t('bank_reference_hint')} label={t('bank_reference')} name="paper_reference" />
          </Grid>
        ) : null}
        {kind === 'sent_to_bank' && failing.length > 0 && mayOverride ? (
          <Field
            hint={t('override_hint', { checks: failing.map((check) => t(`check_${check.code}`)).join(', ') })}
            label={t('override_reason')}
            name="override_reason"
            wide
          />
        ) : null}
        {kind === 'paid' ? (
          <>
            <p className="muted">
              {found.confirmPostsAs === 'payment'
                ? t('confirm_posts_payment', { invoices: found.owingInvoices.join(', ') })
                : t('confirm_posts_advance')}
            </p>
            <Grid>
              <Field defaultValue={today} label={t(`confirmed_on_${kind === 'paid' ? method.kind : 'swift'}`)} name="paper_date" required type="date" />
              <Field label={t(`reference_${method.kind}`)} name="paper_reference" required />
            </Grid>
          </>
        ) : null}
        {kind === 'rejected_cancelled' ? (
          <Field label={t('paper_reason')} name="paper_reason" required wide />
        ) : null}
        {kind !== 'rejected_cancelled' ? paperFile(false) : mayAttach ? paperFile(true) : null}
        <SubmitRow>
          <Submit label={t(`paper_action_${kind}`)} />
        </SubmitRow>
      </Form>
    </NewRecordDialog>
  );

  return (
    <AdminPage
      back={{ href: '/payables/payment-applications', label: page('payment_applications') }}
      tabs={<SectionTabs route="/payables/payment-applications" />}
      title={row.applicationNo}
      trail={[{ href: '/', label: admin('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />

      {/* Owner's decision 4.6 (2026-10-04): a payment application is the request
          to the bank; the allocation to invoices lives on the supplier payment
          its confirmation creates. Said on the record, so nobody looks for it here. */}
      <p className={`${s.sapNote} mb-4`}>
        {t('meaning')}
        {documentHref && found.documentNo ? (
          <>
            {' '}
            <Link className={s.sapLink} href={documentHref}>
              <bdi dir="ltr">{found.documentNo}</bdi>
            </Link>
          </>
        ) : null}
      </p>

      <DocumentWindow
        actions={
          <>
            {maySubmit ? (
              <form action={submitApplication}>
                <Hidden name="application_no" value={row.applicationNo} />
                <Submit label={t('submit')} variant="document" />
              </form>
            ) : null}
            {mayApprove ? (
              <form action={approveApplication}>
                <Hidden name="application_no" value={row.applicationNo} />
                <Submit label={t('approve')} variant="document" />
              </form>
            ) : null}
            {maySend && mayAttach ? paperDialog('sent_to_bank') : null}
            {mayConfirm && mayAttach ? paperDialog('paid') : null}
            {mayRefusePaper ? paperDialog('rejected_cancelled') : null}
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
        documentType={t('document_type')}
        fields={fields}
        id="payment-application-document"
        titleActions={
          <PurchaseDoors
            doors={doors}
            exportId={row.applicationNo}
            exportKey="payment_application"
            object={applications.PERMISSION_OBJECT}
            recordId={row.id}
            returnTo={self}
            title={`${t('document_type')} ${row.applicationNo}`}
            attach={{
              action: addApplicationPaper,
              hidden: { application_no: row.applicationNo },
              formExtra: (
                <>
                  <Select
                    defaultValue="other"
                    label={t('paper_kind')}
                    name="kind"
                    options={offered.map((kind) => ({ value: kind, label: paperLabel(kind) }))}
                    required
                  />
                  {offered.length > 1 ? (
                    <>
                      <Field hint={t('paper_date_hint')} label={t('paper_date')} name="paper_date" type="date" />
                      <Field hint={t('paper_reference_hint')} label={t('paper_reference')} name="paper_reference" />
                      <Field hint={t('paper_reason_hint')} label={t('paper_reason')} name="paper_reason" />
                    </>
                  ) : null}
                </>
              ),
            }}
          />
        }
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

      {/* What each paper is — and so which step it moved (2026-10-06). */}
      <section aria-labelledby="payment-application-papers-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="payment-application-papers-title">
            <span>{t('papers_title')}</span>
            <span className={s.sapTitleMeta}>{t('papers_meta', { count: found.papers.length })}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table aria-labelledby="payment-application-papers-title" className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{t('paper_kind')}</th>
                  <th scope="col">{t('paper_file')}</th>
                  <th scope="col">{t('path_date')}</th>
                </tr>
              </thead>
              <tbody>
                {found.papers.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={3}>
                      {t('papers_none')}
                    </td>
                  </tr>
                ) : null}
                {found.papers.map((paper) => (
                  <tr key={paper.attachmentId}>
                    <td>
                      <span className={`status status--${PAPER_CHIP[paper.kind] ?? 'draft'}`} data-status={PAPER_CHIP[paper.kind] ?? 'draft'}>
                        {paperLabel(paper.kind)}
                      </span>
                    </td>
                    <td>
                      <a className={s.sapLink} href={`/attachments/${paper.attachmentId}`} rel="noreferrer" target="_blank">
                        <bdi dir="auto">{paper.fileName}</bdi>
                      </a>
                    </td>
                    <td>
                      <bdi dir="ltr">{day(businessDateOf(paper.createdAt))}</bdi>
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

/** A paper's chip: what it did. */
const PAPER_CHIP: Readonly<Record<string, string>> = {
  sent_to_bank: 'submitted',
  paid: 'posted',
  rejected_cancelled: 'rejected',
  other: 'draft',
};
