import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { History, Printer } from 'lucide-react';
import { AdminPage, Flash, ReasonForm, admin as s } from '@/components/admin';
import { ActionReadyButton } from '@/components/admin/action-ready-button';
import { Attachments } from '@/components/admin/attachments';
import { AttachmentsButton } from '@/components/admin/icon-dialog';
import { JournalHeaderForm } from '@/components/admin/journal-header-form';
import { JournalLinesGrid } from '@/components/admin/journal-lines-grid';
import { ConfirmButton } from '@/components/admin/confirm-button';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatMoney, formatTimestamp, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as coa from '@/server/services/chart-of-accounts';
import * as departments from '@/server/services/departments';
import * as journal from '@/server/services/journal';
import * as attachments from '@/server/services/attachments';
import {
  approveJournal,
  attachToJournal,
  discardJournal,
  rejectJournal,
  removeJournalLine,
  reverseJournal,
  saveJournalLine,
  submitJournal,
  updateJournalHeader,
} from '../actions';

/**
 * One Journal Entry — Phase 1 requirements 2 and 3.
 *
 * One window (by direction, 2026-08-29): the header in labelled boxes, the
 * lines in a grid that is typed into directly, and along the foot the buttons
 * that decide the document — submit, approve, reject, reverse, delete — with
 * the reasons typed beside them. The paperwork is a paperclip in the title
 * bar; the audit log is a button beside it. Nothing else shares the screen.
 *
 * While the entry is a draft its dates, description and lines are edited in
 * place and saved as they are left; the balance is summed on screen as it is
 * typed. Once posted the entry stops offering anything that would change it.
 * The database enforces that too; this page simply stops asking.
 */
export const dynamic = 'force-dynamic';

export default async function JournalPage({
  params,
  searchParams,
}: {
  params: Promise<{ entryNo: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/finance/journals')) notFound();

  const [t, page, column, status, locale, context, outcome, { entryNo: raw }] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getTranslations('status'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    params,
  ]);
  const entryNo = decodeURIComponent(raw);
  const { principal } = context;
  if (!can(principal, 'view', journal.PERMISSION_OBJECT)) {
    return <Denied object={page('journal_entry')} />;
  }

  const data = await withCurrentUser(async (tx) => {
    try {
      const detail = await journal.detail(tx, entryNo);
      return {
        ...detail,
        accounts: await coa.postableAccounts(tx),
        attached: (await attachments.currentFor(tx, journal.PERMISSION_OBJECT, detail.header.id)).length,
        depts: (await departments.listAll(tx)).filter((d) => d.active),
      };
    } catch {
      return null;
    }
  });
  if (!data) notFound();
  const { header, lines, raisedBy, approvedBy, linked, accounts, depts, attached } = data;

  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);
  const entered = (amount: string, currency: string) => formatMoney(amount, currency, locale as Locale);
  const zero = (amount: string) => Number(amount) === 0;

  const isDraft = header.status === 'draft';
  const mayEdit = isDraft && can(principal, 'edit_draft', journal.PERMISSION_OBJECT);
  const maySubmit = isDraft && can(principal, 'submit', journal.PERMISSION_OBJECT);
  const mayDecide =
    header.status === 'submitted' && can(principal, 'approve', journal.PERMISSION_OBJECT);
  const mayReverse =
    header.status === 'posted' &&
    !header.reversesId &&
    !header.reversedById &&
    can(principal, 'reverse_cancel', journal.PERMISSION_OBJECT);
  const mayAttach = isDraft && can(principal, 'create', 'attachment');
  const hidden = { id: header.id, entryNo: header.entryNo };
  const address = `/finance/journals/${encodeURIComponent(header.entryNo)}`;

  const totalDebit = money(header.totalDebitIqd);
  const totalCredit = money(header.totalCreditIqd);
  const balanced = header.totalDebitIqd === header.totalCreditIqd;

  return (
    <AdminPage
      back={{ href: '/finance/journals', label: t('back') }}
      title={header.entryNo}
      trail={[{ href: '/', label: t('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <div className={s.sapDoc} id="journal-document">
        <div className={s.sapWindow}>
          <div className={s.sapTitle}>
            <span>
              {page('journal_entry')}{' '}
              <span className={s.sapTitleMeta}>
                <bdi dir="ltr">{header.entryNo}</bdi>
              </span>
            </span>
            {/* The paperwork and the trail: two small doors in the title bar,
                so the document itself is only the document. */}
            <span className={s.sapTitleActions}>
              <AttachmentsButton
                closeLabel={t('close')}
                count={attached}
                label={t('attachments.title')}
                title={t('attachments.title')}
              >
                <Attachments
                  action={attachToJournal}
                  hidden={hidden}
                  mayAttach={mayAttach}
                  objectId={header.id}
                  objectType={journal.PERMISSION_OBJECT}
                />
              </AttachmentsButton>
              <Link className={s.sapIconButton} href={`${address}/audit`} title={t('journals.audit_log')}>
                <History aria-hidden="true" />
                <span>{t('journals.audit_log')}</span>
              </Link>
              <Link className={s.sapIconButton} href={`${address}/print`} target="_blank" title={t('journals.print')}>
                <Printer aria-hidden="true" />
                <span>{t('journals.print')}</span>
              </Link>
            </span>
          </div>

          <div className={s.sapBody}>
            <div className={s.sapFields}>
              <div className={s.sapField}>
                <span className={s.sapLabel}>{t('journals.entry_no')}</span>
                <span className={s.sapBox}>
                  <bdi dir="ltr">{header.entryNo}</bdi>
                </span>
              </div>
              <div className={s.sapField}>
                <span className={s.sapLabel}>{column('status')}</span>
                <span className={`${s.sapBox} ${s.sapStatus}`} data-status={header.status}>
                  {status(header.status)}
                </span>
              </div>
              <div className={s.sapField}>
                <span className={s.sapLabel}>{column('branch_code')}</span>
                <span className={s.sapBox}>
                  <bdi dir="ltr">{header.branchCode}</bdi>
                </span>
              </div>
              <div className={s.sapField}>
                <span className={s.sapLabel}>{t('journals.raised_by')}</span>
                <span className={s.sapBox}>
                  <bdi dir="auto">{raisedBy ?? '—'}</bdi>
                </span>
              </div>
              <div className={s.sapField}>
                <span className={s.sapLabel}>{t('journals.approved_by')}</span>
                <span className={s.sapBox}>
                  <bdi dir="auto">{approvedBy ?? t('none')}</bdi>
                </span>
              </div>

              {/* The dates and the description: typed while a draft, fixed
                  once submitted. §14.3 keeps the rate off the document. */}
              {mayEdit ? (
                <JournalHeaderForm
                  description={header.description ?? ''}
                  documentDate={header.documentDate}
                  entryNo={header.entryNo}
                  journalId={header.id}
                  postingDate={header.postingDate}
                  labels={{
                    documentDate: t('journals.document_date'),
                    postingDate: t('journals.posting_date'),
                    postingDateHint: t('journals.posting_date_hint'),
                    description: t('journals.description'),
                  }}
                  save={updateJournalHeader}
                />
              ) : (
                <>
                  <div className={s.sapField}>
                    <span className={s.sapLabel}>{t('journals.posting_date')}</span>
                    <span className={s.sapBox}>
                      <bdi dir="ltr">{formatBusinessDate(header.postingDate, locale as Locale)}</bdi>
                    </span>
                  </div>
                  <div className={s.sapField}>
                    <span className={s.sapLabel}>{t('journals.document_date')}</span>
                    <span className={s.sapBox}>
                      <bdi dir="ltr">{formatBusinessDate(header.documentDate, locale as Locale)}</bdi>
                    </span>
                  </div>
                  <div className={`${s.sapField} ${s.sapWide}`}>
                    <span className={s.sapLabel}>{t('journals.description')}</span>
                    <span className={s.sapBox}>
                      <bdi dir="auto">{header.description ?? '—'}</bdi>
                    </span>
                  </div>
                </>
              )}

              <div className={s.sapField}>
                <span className={s.sapLabel}>{t('created_at')}</span>
                <span className={s.sapBox}>
                  <bdi dir="ltr">{formatTimestamp(header.createdAt.toISOString(), locale as Locale)}</bdi>
                </span>
              </div>
              <div className={s.sapField}>
                <span className={s.sapLabel}>{t('journals.posted_at')}</span>
                <span className={s.sapBox}>
                  <bdi dir="ltr">
                    {header.postedAt ? formatTimestamp(header.postedAt.toISOString(), locale as Locale) : '—'}
                  </bdi>
                </span>
              </div>
              {/* Both ends of a reversal point at each other, permanently. */}
              {linked ? (
                <div className={`${s.sapField} ${s.sapWide}`}>
                  <span className={s.sapLabel}>
                    {t(linked.relation === 'reversed_by' ? 'journals.reversed_by_hint' : 'journals.reverses_hint')}
                  </span>
                  <span className={s.sapBox}>
                    <Link className={s.sapLink} href={`/finance/journals/${encodeURIComponent(linked.entryNo)}`}>
                      <bdi dir="ltr">{linked.entryNo}</bdi>
                    </Link>
                  </span>
                </div>
              ) : null}
            </div>

            {/* The lines. */}
            <div className={s.sapGridCaption} id="journal-lines-heading">
              <span aria-hidden="true" className={s.sapDisclosure}>
                ▾
              </span>
              <strong>{t('journals.lines')}</strong>
              <span className={s.sapGridCount}>{lines.length}</span>
            </div>

            {mayEdit ? (
              <JournalLinesGrid
                accounts={accounts.map((a) => ({
                  id: a.id,
                  code: a.code,
                  name: a.name,
                  currency: a.currencyRestriction,
                }))}
                currency="IQD"
                departments={depts.map((d) => ({ code: d.code, name: d.name }))}
                entryNo={header.entryNo}
                journalId={header.id}
                labels={{
                  account: t('journals.account'),
                  department: t('journals.department'),
                  debit: t('journals.debit'),
                  credit: t('journals.credit'),
                  total: t('journals.total'),
                  remove: t('journals.remove_line'),
                  chooseAccount: t('journals.choose_account'),
                  saving: t('journals.saving'),
                  balanced: t('journals.balanced'),
                  outOfBalance: t('journals.out_of_balance'),
                  difference: t('journals.difference'),
                }}
                lines={lines.map((line) => ({
                  id: line.id,
                  lineNo: line.lineNo,
                  accountId: line.accountId,
                  departmentCode: line.departmentCode ?? '',
                  debit: line.debitTxn,
                  credit: line.creditTxn,
                  currency: line.currency,
                }))}
                locale={locale}
                remove={removeJournalLine}
                save={saveJournalLine}
              />
            ) : (
              <div className={`${s.sapTableWrap} ${s.sapLineTableWrap}`}>
                <table aria-labelledby="journal-lines-heading" className={s.sapTable}>
                  <thead>
                    <tr>
                      <th scope="col">#</th>
                      <th scope="col">{t('journals.account')}</th>
                      <th scope="col">{t('journals.department')}</th>
                      <th className={s.sapNum} scope="col">
                        {t('journals.debit')}
                      </th>
                      <th className={s.sapNum} scope="col">
                        {t('journals.credit')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.length === 0 ? (
                      <tr>
                        <td colSpan={5}>{t('journals.no_lines')}</td>
                      </tr>
                    ) : null}
                    {lines.map((line) => (
                      <tr key={line.id}>
                        <td>
                          <bdi dir="ltr">{line.lineNo}</bdi>
                        </td>
                        <td className={s.sapAccountCell}>
                          <bdi dir="ltr">{line.accountCode}</bdi> · <bdi dir="auto">{line.accountName}</bdi>
                        </td>
                        <td>
                          <bdi dir="ltr">{line.departmentCode ?? ''}</bdi>
                        </td>
                        {/* The ledger figure, in IQD. A line entered in another
                            currency says what was typed, beneath it. */}
                        <td className={s.sapNum}>
                          <bdi dir="ltr">{zero(line.debitIqd) ? '' : money(line.debitIqd)}</bdi>
                          {line.currency !== 'IQD' && !zero(line.debitTxn) ? (
                            <span className={s.sapEnteredNote}>{entered(line.debitTxn, line.currency)}</span>
                          ) : null}
                        </td>
                        <td className={s.sapNum}>
                          <bdi dir="ltr">{zero(line.creditIqd) ? '' : money(line.creditIqd)}</bdi>
                          {line.currency !== 'IQD' && !zero(line.creditTxn) ? (
                            <span className={s.sapEnteredNote}>{entered(line.creditTxn, line.currency)}</span>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className={s.sapTotalRow}>
                      <td colSpan={3}>{t('journals.total')}</td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{totalDebit}</bdi>
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{totalCredit}</bdi>
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>

          {/* The foot: what may be done, and what the document comes to. */}
          <div className={s.sapFoot}>
            <div className={s.sapFootActions}>
              {maySubmit ? (
                <ActionReadyButton action={submitJournal} hidden={hidden} label={t('journals.submit')} tone="primary" />
              ) : null}
              {mayDecide ? (
                <>
                  <ActionReadyButton action={approveJournal} hidden={hidden} label={t('journals.approve')} tone="primary" />
                  <ReasonForm
                    action={rejectJournal}
                    hidden={hidden}
                    label={t('journals.reject')}
                    reasonLabel={t('journals.reject_reason')}
                  />
                </>
              ) : null}
              {/* Correcting a posted entry: the reason is typed here, beside
                  the button, and the reversal opens in this same window. */}
              {mayReverse ? (
                <ReasonForm
                  action={reverseJournal}
                  hidden={hidden}
                  label={t('journals.reverse')}
                  reasonLabel={t('journals.reverse_reason')}
                />
              ) : null}
              {/* Only ever on a draft. Once submitted the entry is a document
                  and §7 keeps it — it is rejected, cancelled or reversed. */}
              {mayEdit ? (
                <ConfirmButton
                  action={discardJournal}
                  body={t('journals.discard_confirm', { entryNo: header.entryNo })}
                  cancelLabel={t('cancel')}
                  confirmLabel={t('journals.discard_yes')}
                  hidden={hidden}
                  label={t('journals.discard')}
                  title={t('journals.discard_title')}
                />
              ) : null}
            </div>
            {/* A draft's totals are summed live on the grid; a document that
                has left draft shows what the ledger holds. */}
            {mayEdit ? null : (
              <div className={s.sapFootTotals}>
                {balanced ? null : <span className={s.sapWarn}>{t('journals.out_of_balance')}</span>}
                <div className={s.sapFootTotal}>
                  <span>{t('journals.total_debit')}</span>
                  <strong>
                    <bdi dir="ltr">{totalDebit}</bdi>
                  </strong>
                </div>
                <div className={s.sapFootTotal}>
                  <span>{t('journals.total_credit')}</span>
                  <strong>
                    <bdi dir="ltr">{totalCredit}</bdi>
                  </strong>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </AdminPage>
  );
}
