import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, Flash, Form, Grid, Hidden, ReasonForm, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { NewRecordDialog } from '@/components/admin/dialog';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { RecordHistory } from '@/components/admin/history';
import { AttachmentsButton, HistoryButton } from '@/components/admin/icon-dialog';
import { Attachments } from '@/components/admin/attachments';
import { SectionTabs } from '@/components/admin/section-tabs';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { ExportIcon } from '@/components/print/export-menu';
import { PrintSheet } from '@/components/print/print-sheet';
import { printSheet } from '@/server/print/sheet';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { toDecimalString } from '@domain/money';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import { isNotFoundError } from '@/server/not-found';
import { accountHref, glAccountHref, journalHref } from '@/server/domain/accounting-links';
import * as attachmentsService from '@/server/services/attachments';
import * as chart from '@/server/services/chart-of-accounts';
import * as departments from '@/server/services/departments';
import * as rec from '@/server/services/bank-reconciliation';
import * as statements from '@/server/services/bank-statement';
import {
  addLineAction,
  adjustmentAction,
  attachToStatement,
  closeStatementAction,
  confirmMatchAction,
  finaliseAction,
  matchManuallyAction,
  openReconciliationAction,
  pasteLinesAction,
  reopenAction,
  suggestAction,
} from '../actions';
import { STAGE_CHIP } from '../stage';

/**
 * One bank statement and its reconciliation — REQ-ACC-001 Part D-3.
 *
 * The Purchase Invoice's window: the statement and the reconciliation's
 * arithmetic in boxes, the bank's lines as the grid (each with how it
 * stands), and at the foot what may be done next — add lines, close the
 * statement, open the reconciliation, suggest, finalise, reopen. Under it, in
 * the supplier-statement manner, the matches and the ledger items the bank
 * has not shown yet. The four doors from the moment the draft exists; the
 * account, its G/L account and every journal open their own pages.
 */
export const dynamic = 'force-dynamic';

export default async function BankReconciliationPage({
  params,
  searchParams,
}: {
  params: Promise<{ statementNo: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/treasury/bank-reconciliation')) notFound();
  const { statementNo: raw } = await params;
  const statementNo = decodeURIComponent(raw);

  const [t, admin, page, locale, context, outcome] = await Promise.all([
    getTranslations('admin.bank_reconciliation'),
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', rec.PERMISSION_OBJECT)) {
    return <Denied object={page('bank_reconciliation')} />;
  }
  const mayAdjust = can(principal, 'approve', rec.PERMISSION_OBJECT);

  const found = await withCurrentUser(async (tx, request) => {
    const ctx = { principal: request.principal, branchCode: request.scope.branchCode };
    try {
      const view = await rec.workspace(tx, ctx, statementNo);
      return {
        view,
        attached: (await attachmentsService.currentFor(tx, statements.DOCUMENT_TYPE, view.statement.statementId)).length,
        // The account an adjustment's other side goes to: never a control
        // account (a fee is not a customer), and the departments it may name.
        accounts: mayAdjust && view.reconciliation ? (await chart.postableAccounts(tx)).filter((a) => !a.controlAccount) : [],
        depts: mayAdjust && view.reconciliation ? (await departments.listAll(tx)).filter((d) => d.active) : [],
      };
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  });
  if (!found) notFound();
  const { view, attached, accounts, depts } = found;
  const { statement, lines, rejected, reconciliation } = view;

  const day = (value: string) => formatBusinessDate(value, locale as Locale);
  const money = (amount: string | bigint) =>
    formatMoney(typeof amount === 'bigint' ? toDecimalString(amount, 4n) : amount, statement.currency, locale as Locale);
  const hidden = { statement_no: statement.statementNo };

  const isDraft = statement.statementStatus === 'draft';
  const reconciling = reconciliation !== null && statement.reconciliationStatus === 'draft';
  const reconciled = statement.stage === 'reconciled';
  const mayAddLines = isDraft && can(principal, 'create', statements.PERMISSION_OBJECT);
  const mayPaste = isDraft && can(principal, 'import', statements.PERMISSION_OBJECT);
  const mayClose = isDraft && can(principal, 'approve', statements.PERMISSION_OBJECT);
  const mayOpen = statement.stage === 'ready' && can(principal, 'create', rec.PERMISSION_OBJECT);
  const maySuggest = reconciling && can(principal, 'edit_draft', rec.PERMISSION_OBJECT);
  const mayMatch = reconciling && can(principal, 'execute', rec.PERMISSION_OBJECT);
  const mayFinalise = reconciling && can(principal, 'approve', rec.PERMISSION_OBJECT);
  const mayReopen = reconciled && can(principal, 'reverse_cancel', rec.PERMISSION_OBJECT);
  const openLines = lines.filter((line) => line.matchStatus !== 'matched');

  const journalLink = (entryNo: string) => (
    <Link className={s.sapLink} href={journalHref(entryNo)}>
      <bdi dir="ltr">{entryNo}</bdi>
    </Link>
  );

  const fields: DocumentField[] = [
    { label: t('col_statement'), value: <bdi dir="ltr">{statement.statementNo}</bdi> },
    { label: t('col_status'), value: t(`stage_${statement.stage}`), status: STAGE_CHIP[statement.stage] },
    {
      label: t('account'),
      value: (
        <Link className={s.sapLink} href={accountHref(view.accountKind, statement.accountCode)}>
          <bdi dir="auto">{`${statement.accountName} (${statement.accountCode})`}</bdi>
        </Link>
      ),
    },
    {
      label: t('gl_account'),
      value: view.glCode ? (
        <Link className={s.sapLink} href={glAccountHref(view.glCode)}>
          <bdi dir="auto">{`${view.glCode} · ${view.glName ?? ''}`}</bdi>
        </Link>
      ) : (
        '—'
      ),
    },
    { label: t('col_period'), value: <bdi dir="ltr">{`${day(statement.periodFrom)} – ${day(statement.periodTo)}`}</bdi> },
    { label: t('bank_reference'), value: <bdi dir="auto">{statement.bankReference ?? '—'}</bdi> },
    { label: t('opening'), value: <bdi dir="ltr">{money(statement.openingIqd)}</bdi> },
    { label: t('closing'), value: <bdi dir="ltr">{money(statement.closingIqd)}</bdi> },
    ...(statement.reconciliationNo ? [{ label: t('reconciliation_no'), value: <bdi dir="ltr">{statement.reconciliationNo}</bdi> }] : []),
    ...(reconciliation
      ? [
          { label: t('ledger_balance'), value: <bdi dir="ltr">{money(reconciliation.position.ledgerBalanceIqd)}</bdi> },
          { label: t('in_transit'), value: <bdi dir="ltr">{money(reconciliation.position.depositsInTransitIqd)}</bdi> },
          { label: t('unpresented'), value: <bdi dir="ltr">{money(reconciliation.position.unpresentedPaymentsIqd)}</bdi> },
          {
            label: t('difference'),
            value: <bdi dir="ltr">{money(reconciliation.position.differenceIqd)}</bdi>,
            status: reconciliation.position.balanced ? 'settled' : 'rejected',
          },
        ]
      : []),
    { label: t('entered_by'), value: <bdi dir="auto">{view.createdBy ?? '—'}</bdi> },
    ...(statement.reconciliationNo ? [{ label: t('prepared_by'), value: <bdi dir="auto">{view.preparedBy ?? '—'}</bdi> }] : []),
    ...(statement.reconciliationNo ? [{ label: t('approved_by'), value: <bdi dir="auto">{view.approvedBy ?? admin('none')}</bdi> }] : []),
    ...(view.reopenReason
      ? [
          {
            label: t('reopened', { count: statement.reopenCount }),
            value: <bdi dir="auto">{`${view.reopenedBy ?? '—'} — ${view.reopenReason}`}</bdi>,
            wide: true,
          },
        ]
      : []),
  ];

  const sheet = await printSheet('bank_reconciliation', statement.statementNo);

  return (
    <AdminPage
      back={{ href: '/treasury/bank-reconciliation', label: page('bank_reconciliation') }}
      tabs={<SectionTabs route="/treasury/bank-reconciliation" />}
      title={statement.statementNo}
      trail={[{ href: '/', label: admin('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />

      <DocumentWindow
        actions={
          <>
            {mayAddLines ? (
              <NewRecordDialog buttonLabel={t('add_line')} closeLabel={admin('close')} title={t('add_line')}>
                <Form action={addLineAction}>
                  <Hidden name="statement_no" value={statement.statementNo} />
                  <Grid>
                    <Field defaultValue={statement.periodFrom} label={t('booking_date')} name="booking_date" required type="date" />
                    <Field label={t('value_date')} name="value_date" type="date" />
                    <Select
                      label={t('direction')}
                      name="direction"
                      options={[
                        { value: 'in', label: t('direction_in') },
                        { value: 'out', label: t('direction_out') },
                      ]}
                      required
                    />
                    <Field label={t('amount')} name="amount" required />
                    <Field label={t('reference')} name="reference" />
                    <Field label={t('counterparty')} name="counterparty" />
                  </Grid>
                  <Field id="line-description" label={t('description')} name="description" wide />
                  <SubmitRow>
                    <Submit label={t('add_line')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {mayPaste ? (
              <NewRecordDialog buttonLabel={t('paste')} closeLabel={admin('close')} title={t('paste')} wide>
                <p className="muted">{t('paste_note', { columns: statements.PASTE_COLUMNS.join(', ') })}</p>
                <Form action={pasteLinesAction}>
                  <Hidden name="statement_no" value={statement.statementNo} />
                  <Field label={t('paste_content')} name="content" required type="textarea" wide />
                  <SubmitRow>
                    <Submit label={t('paste')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {mayClose ? (
              <form action={closeStatementAction} title={t('close_hint')}>
                <Hidden name="statement_no" value={statement.statementNo} />
                <Submit label={t('close_statement')} variant="document" />
              </form>
            ) : null}
            {mayOpen ? (
              <form action={openReconciliationAction}>
                <Hidden name="statement_no" value={statement.statementNo} />
                <Submit label={t('open_reconciliation')} variant="document" />
              </form>
            ) : null}
            {maySuggest ? (
              <form action={suggestAction}>
                <Hidden name="statement_no" value={statement.statementNo} />
                <Submit label={t('suggest')} tone="secondary" variant="document" />
              </form>
            ) : null}
            {mayAdjust && reconciling && openLines.length > 0 ? (
              <NewRecordDialog buttonLabel={t('adjust')} closeLabel={admin('close')} title={t('adjust')}>
                <p className="muted">{t('adjust_note')}</p>
                <Form action={adjustmentAction}>
                  <Hidden name="statement_no" value={statement.statementNo} />
                  <Grid>
                    <Select
                      label={t('statement_line')}
                      name="adjust_line_id"
                      options={openLines.map((line) => ({
                        value: line.id,
                        label: `${line.lineNo}. ${day(line.bookingDate)} · ${money(line.amountIqd)}${line.reference ? ` · ${line.reference}` : ''}`,
                      }))}
                      required
                    />
                    <Select
                      label={t('adjust_account')}
                      name="account_id"
                      options={accounts.map((account) => ({ value: account.id, label: `${account.code} · ${account.name}` }))}
                      required
                    />
                    <Select
                      emptyLabel="—"
                      label={t('department')}
                      name="department_code"
                      options={depts.map((dept) => ({ value: dept.code, label: `${dept.code} · ${dept.name}` }))}
                    />
                  </Grid>
                  <Field id="adjust-description" label={t('description')} name="adjust_description" required wide />
                  <SubmitRow>
                    <Submit label={t('adjust')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {mayFinalise ? (
              <form action={finaliseAction} title={t('finalise_hint')}>
                <Hidden name="statement_no" value={statement.statementNo} />
                <Submit label={t('finalise')} variant="document" />
              </form>
            ) : null}
            {mayReopen ? <ReasonForm action={reopenAction} hidden={hidden} label={t('reopen')} reasonLabel={t('reopen_reason')} /> : null}
          </>
        }
        titleActions={
          <>
            {/* Printer, paperclip, notes, clock — from the moment the draft exists. */}
            <ExportIcon exportKey="bank_reconciliation" id={statement.statementNo} title={`${t('document_type')} ${statement.statementNo}`} />
            <AttachmentsButton
              closeLabel={admin('close')}
              count={attached}
              label={admin('attachments.title')}
              title={admin('attachments.title')}
            >
              <Attachments
                action={attachToStatement}
                hidden={hidden}
                mayAttach={can(principal, 'create', 'attachment')}
                objectId={statement.statementId}
                objectType={statements.DOCUMENT_TYPE}
              />
            </AttachmentsButton>
            <HistoryButton closeLabel={admin('close')} label={admin('history')} title={admin('history')}>
              <RecordHistory
                objectId={statement.statementId}
                objectType={statements.DOCUMENT_TYPE}
                related={statement.reconciliationId ? [{ objectType: rec.DOCUMENT_TYPE, objectId: statement.reconciliationId }] : []}
              />
            </HistoryButton>
          </>
        }
        documentType={t('document_type')}
        fields={fields}
        id="bank-reconciliation-document"
        linesCount={lines.length}
        linesTitle={t('lines')}
        number={statement.statementNo}
        totals={[
          { label: t('closing'), value: money(statement.closingIqd) },
          ...(reconciliation ? [{ label: t('difference'), value: money(reconciliation.position.differenceIqd) }] : []),
        ]}
      >
        <table aria-labelledby="bank-reconciliation-document-lines-heading" className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">{t('booking_date')}</th>
              <th scope="col">{t('value_date')}</th>
              <th scope="col">{t('reference')}</th>
              <th scope="col">{t('counterparty')}</th>
              <th className={s.sapNum} scope="col">
                {t('amount')}
              </th>
              <th scope="col">{t('col_match')}</th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 ? (
              <tr>
                <td className={s.sapEmptyRow} colSpan={7}>
                  {t('no_lines')}
                </td>
              </tr>
            ) : null}
            {lines.map((line) => (
              <tr key={line.id}>
                <td>{line.lineNo}</td>
                <td>
                  <bdi dir="ltr">{day(line.bookingDate)}</bdi>
                </td>
                <td>
                  <bdi dir="ltr">{day(line.valueDate)}</bdi>
                </td>
                <td>
                  <bdi dir="auto">{line.reference ?? '—'}</bdi>
                  {line.description ? (
                    <div className="muted">
                      <bdi dir="auto">{line.description}</bdi>
                    </div>
                  ) : null}
                </td>
                <td>
                  <bdi dir="auto">{line.counterparty ?? '—'}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(line.amountIqd)}</bdi>
                </td>
                <td>
                  <span
                    className={`status status--${line.matchStatus === 'matched' ? 'settled' : line.matchStatus === 'suggested' ? 'submitted' : 'draft'}`}
                    data-status={line.matchStatus === 'matched' ? 'settled' : line.matchStatus === 'suggested' ? 'submitted' : 'draft'}
                  >
                    {t(`match_${line.matchStatus}`)}
                    {line.matchNo ? ` · ${line.matchNo}` : ''}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DocumentWindow>

      {/* ── The rows the bank's file had that could not be read ── */}
      {rejected.length > 0 ? (
        <section aria-labelledby="reconciliation-rejected-title" className={s.sapDoc}>
          <div className={s.sapWindow}>
            <h2 className={s.sapTitle} id="reconciliation-rejected-title">
              <span>{t('rejected_title')}</span>
              <span className={s.sapTitleMeta}>{rejected.length}</span>
            </h2>
            <div className={s.sapTableWrap}>
              <table aria-labelledby="reconciliation-rejected-title" className={s.sapTable}>
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">{t('rejected_row')}</th>
                    <th scope="col">{t('rejected_problem')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rejected.map((row) => (
                    <tr key={row.lineNo}>
                      <td>{row.lineNo}</td>
                      <td>
                        <bdi dir="ltr">{row.rawText}</bdi>
                      </td>
                      <td>
                        <bdi dir="auto">{row.problem}</bdi>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : null}

      {/* ── The matches: what was agreed to be the same money ── */}
      {reconciliation ? (
        <section aria-labelledby="reconciliation-matches-title" className={s.sapDoc}>
          <div className={s.sapWindow}>
            <h2 className={s.sapTitle} id="reconciliation-matches-title">
              <span>{t('matches_title')}</span>
              <span className={s.sapTitleMeta}>{reconciliation.matches.length}</span>
            </h2>
            <div className={s.sapTableWrap}>
              <table aria-labelledby="reconciliation-matches-title" className={s.sapTable}>
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">{t('col_statement_lines')}</th>
                    <th scope="col">{t('col_journals')}</th>
                    <th scope="col">{t('col_why')}</th>
                    <th scope="col">{t('col_state')}</th>
                  </tr>
                </thead>
                <tbody>
                  {reconciliation.matches.length === 0 ? (
                    <tr>
                      <td className={s.sapEmptyRow} colSpan={5}>
                        {t('no_matches')}
                      </td>
                    </tr>
                  ) : null}
                  {reconciliation.matches.map((match) => (
                    <tr key={match.id}>
                      <td>{match.matchNo}</td>
                      <td>
                        <bdi dir="ltr">{match.statementLines.map((line) => `${line.lineNo} (${money(line.amountIqd)})`).join(', ')}</bdi>
                      </td>
                      <td>
                        {match.journalLines.map((line, index) => (
                          <span key={`${line.entryNo}-${index}`}>
                            {index > 0 ? ', ' : ''}
                            {journalLink(line.entryNo)}
                          </span>
                        ))}
                        {match.adjustmentEntryNo ? <div className="muted">{t('adjustment')}</div> : null}
                      </td>
                      <td>
                        <bdi dir="auto">{match.why ?? '—'}</bdi>
                        {match.confidence !== null ? <div className="muted">{`${match.confidence}%`}</div> : null}
                      </td>
                      <td>
                        <span
                          className={`status status--${match.state === 'confirmed' ? 'settled' : 'submitted'}`}
                          data-status={match.state === 'confirmed' ? 'settled' : 'submitted'}
                        >
                          {t(`state_${match.state}`)}
                        </span>
                        {match.confirmedBy ? (
                          <div className="muted">
                            <bdi dir="auto">{match.confirmedBy}</bdi>
                          </div>
                        ) : null}
                        {mayMatch && match.state === 'suggested' ? (
                          <form action={confirmMatchAction}>
                            <Hidden name="statement_no" value={statement.statementNo} />
                            <Hidden name="match_id" value={match.id} />
                            <Submit label={t('confirm')} small tone="secondary" />
                          </form>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : null}

      {/* ── Matched by hand: tick the bank's lines and the books' items that are the same money ── */}
      {reconciliation ? (
        <section aria-labelledby="reconciliation-unmatched-title" className={s.sapDoc}>
          <div className={s.sapWindow}>
            <h2 className={s.sapTitle} id="reconciliation-unmatched-title">
              <span>{t('unmatched_title')}</span>
              <span className={s.sapTitleMeta}>{`${openLines.length} · ${reconciliation.ledger.length}`}</span>
            </h2>
            <Form action={matchManuallyAction}>
              <Hidden name="statement_no" value={statement.statementNo} />
              <div className={s.sapTableWrap}>
                <table aria-labelledby="reconciliation-unmatched-title" className={s.sapTable}>
                  <thead>
                    <tr>
                      <th scope="col">{t('col_side')}</th>
                      <th scope="col">{t('booking_date')}</th>
                      <th scope="col">{t('reference')}</th>
                      <th className={s.sapNum} scope="col">
                        {t('amount')}
                      </th>
                      <th className={s.sapNum} scope="col">
                        {t('col_age')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {openLines.length === 0 && reconciliation.ledger.length === 0 ? (
                      <tr>
                        <td className={s.sapEmptyRow} colSpan={5}>
                          {t('nothing_unmatched')}
                        </td>
                      </tr>
                    ) : null}
                    {openLines.map((line) => (
                      <tr key={line.id}>
                        <td>
                          <label className={s.check}>
                            {mayMatch ? <input name="statement_line_id" type="checkbox" value={line.id} /> : null}
                            <span>{`${t('side_bank')} ${line.lineNo}`}</span>
                          </label>
                        </td>
                        <td>
                          <bdi dir="ltr">{day(line.bookingDate)}</bdi>
                        </td>
                        <td>
                          <bdi dir="auto">{line.reference ?? '—'}</bdi>
                        </td>
                        <td className={s.sapNum}>
                          <bdi dir="ltr">{money(line.amountIqd)}</bdi>
                        </td>
                        <td className={s.sapNum}>—</td>
                      </tr>
                    ))}
                    {reconciliation.ledger.map((item) => (
                      <tr key={item.id}>
                        <td>
                          <label className={s.check}>
                            {mayMatch ? <input name="journal_line_id" type="checkbox" value={item.id} /> : null}
                            <span>{t(item.amountIqd.startsWith('-') ? 'side_unpresented' : 'side_in_transit')}</span>
                          </label>
                          <div>{journalLink(item.entryNo)}</div>
                        </td>
                        <td>
                          <bdi dir="ltr">{day(item.postingDate)}</bdi>
                        </td>
                        <td>
                          <bdi dir="auto">{item.reference ?? '—'}</bdi>
                        </td>
                        <td className={s.sapNum}>
                          <bdi dir="ltr">{money(item.amountIqd)}</bdi>
                        </td>
                        <td className={s.sapNum}>
                          <bdi dir="ltr">{item.ageDays}</bdi>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {mayMatch && openLines.length > 0 && reconciliation.ledger.length > 0 ? (
                <SubmitRow>
                  <Submit label={t('match_ticked')} tone="secondary" />
                </SubmitRow>
              ) : null}
            </Form>
          </div>
        </section>
      ) : null}

      {sheet ? <PrintSheet {...sheet} /> : null}
    </AdminPage>
  );
}
