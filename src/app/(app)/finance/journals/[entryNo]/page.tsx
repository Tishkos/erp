import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { ActionButton, AdminPage, Flash, ReasonForm, Submit, admin as s } from '@/components/admin';
import { Attachments } from '@/components/admin/attachments';
import { RecordHistory } from '@/components/admin/history';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatMoney, formatTimestamp, type Locale } from '@/i18n/config';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '@domain/money';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as coa from '@/server/services/chart-of-accounts';
import * as departments from '@/server/services/departments';
import * as journal from '@/server/services/journal';
import * as rates from '@/server/services/exchange-rates';
import * as attachments from '@/server/services/attachments';
import { LineCurrency } from '@/components/admin/line-currency';
import { ConfirmButton } from '@/components/admin/confirm-button';
import {
  addJournalLine,
  removeJournalLine,
  approveJournal,
  discardJournal,
  attachToJournal,
  rejectJournal,
  reverseJournal,
  submitJournal,
} from '../actions';

/**
 * One Journal Entry — Phase 1 requirements 2 and 3.
 *
 * Drawn as the document window the company already reads: a titled window, a
 * block of labelled boxes for the header, a ruled grid of lines with the
 * unused rows still showing, and the buttons along the bottom beside what the
 * document comes to.
 *
 * Each line carries a debit and a credit in all three currencies §24 stores —
 * the amount as typed, the IQD the ledger balances in, and the USD reporting
 * equivalent. The last two were computed on every line and shown nowhere.
 *
 * The line being added is the last row of the grid rather than a form beneath
 * it. Its controls sit in the cells and reach their form by `form=`, because a
 * `<form>` element cannot legally wrap a `<tr>`.
 *
 * Once posted the entry stops offering anything that would change it. The
 * database enforces that too; this page simply stops asking.
 */
export const dynamic = 'force-dynamic';

/** The id the cell controls use to reach the form that submits them. */
const ADD_LINE_FORM = 'add-line';

/** Empty rows drawn under the lines, the way the grid draws room still to fill. */
const FILLER_ROWS = 3;

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
        // The currencies Finance has configured — the same list the Currencies
        // and Rates screen maintains, so the two never drift apart.
        moneys: (await rates.currencies(tx)).filter((c) => c.isActive),
        // The register beside the document: the same rows, the same scope.
        register: await journal.listAll(tx),
      };
    } catch {
      return null;
    }
  });
  if (!data) notFound();
  const { header, lines, raisedBy, approvedBy, linked, accounts, depts, moneys, attached } = data;
  const { register } = data;
  const hasAttachments = attached > 0;

  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);
  const usd = (amount: string) => formatMoney(amount, 'USD', locale as Locale);
  /** What the person actually typed, in the currency they typed it in. */
  const entered = (amount: string, currency: string) =>
    formatMoney(amount, currency, locale as Locale);
  /** A zero on one side of a line is nothing at all, so it is left blank. */
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

  const totalDebit = money(header.totalDebitIqd);
  const totalCredit = money(header.totalCreditIqd);
  const balanced = header.totalDebitIqd === header.totalCreditIqd;

  // The USD column totals are summed here rather than held on the header: USD
  // is a reporting equivalent and the ledger balances in IQD (§1.1), so there
  // is no stored total to read. Summed in minor units, not floats — a column
  // of figures that does not add up is the one thing a ledger may not do.
  const sum = (of: (line: (typeof lines)[number]) => string) =>
    toDecimalString(
      lines.reduce((total, line) => total + parseDecimal(of(line), MONEY_SCALE), 0n),
      MONEY_SCALE,
    );
  const totalDebitUsd = usd(sum((l) => l.debitUsd));
  const totalCreditUsd = usd(sum((l) => l.creditUsd));

  // The transaction column has no total: adding dinars to dollars produces a
  // figure that means nothing. It names the currency instead, and says so
  // plainly when the lines are in more than one.
  const currenciesUsed = new Set(lines.map((l) => l.currency));
  const txnTotalNote =
    currenciesUsed.size === 0
      ? '—'
      : currenciesUsed.size === 1
        ? [...currenciesUsed][0]!
        : t('journals.mixed_currencies');

  // The register beside a reversal shows the reversal register — both sides
  // of every pair — because that is the list this document belongs to. Every
  // other entry keeps the whole register beside it.
  const inReversalFamily = Boolean(header.reversesId || header.reversedById);
  const registerRows = inReversalFamily
    ? register.filter((row) => row.status === 'reversed' || row.reversesId)
    : register;

  /** Every column the grid has, so a filler row spans them exactly. A draft
      carries one more: the remove cell at the end of each line. */
  const columnCount = mayEdit ? 12 : 11;
  const fillers = Array.from({ length: FILLER_ROWS }, (_, i) => i);

  return (
    <AdminPage
      back={{ href: '/finance/journals', label: t('back') }}
      title={header.entryNo}
      trail={[{ href: '/', label: t('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      {/* Opening an entry opens the workspace: the register stays beside the
          document, so the next entry is one click away and the one being read
          keeps its place in the list. The register's own page is the plain
          full-width list — the split belongs to having a document open. */}
      <div className={`${s.sapDoc} ${s.sapSplit}`}>
        <aside
          aria-labelledby="journal-register-title"
          className={`${s.sapRegister} ${s.sapSplitAside}`}
        >
          <div className={s.sapWindow}>
            <h2 className={s.sapTitle} id="journal-register-title">
              <span>{t('journals.register')}</span>
              <span className={s.sapTitleMeta}>{t('rows_shown', { count: registerRows.length })}</span>
            </h2>
            <div className={`${s.sapTableWrap} ${s.sapAsideTableWrap}`}>
              <table
                aria-labelledby="journal-register-title"
                className={`${s.sapTable} ${s.sapRegisterTable} ${s.sapAsideTable}`}
              >
                <thead>
                  <tr>
                    <th scope="col">{column('reference')}</th>
                    <th scope="col">{t('journals.posting_date')}</th>
                    <th scope="col">{column('status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {registerRows.map((row) => {
                    const open = row.entryNo === header.entryNo;
                    return (
                      <tr
                        key={row.id}
                        // The row being read is marked, not merely coloured:
                        // an amber band means nothing to a screen reader.
                        // Written as a plain attribute rather than a spread:
                        // a spread ahead of `key` hides it from the compiler,
                        // and React then reports the whole list as keyless.
                        aria-current={open ? 'true' : undefined}
                        className={open ? s.sapRowSelected : undefined}
                      >
                        <td>
                          <Link
                            className={s.sapLink}
                            href={`/finance/journals/${encodeURIComponent(row.entryNo)}`}
                          >
                            <bdi dir="ltr">{row.entryNo}</bdi>
                          </Link>
                        </td>
                        <td>
                          <bdi dir="ltr">
                            {formatBusinessDate(row.postingDate, locale as Locale)}
                          </bdi>
                        </td>
                        <td>
                          <span
                            className={`status status--${row.status} ${s.sapRegisterStatus}`}
                            data-status={row.status}
                          >
                            {status(row.status)}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </aside>

        <div className={s.sapSplitMain} id="journal-document">
        <div className={s.sapWindow}>
          <div className={s.sapTitle}>
            <span>{page('journal_entry')}</span>
            <span className={s.sapTitleMeta}>
              <bdi dir="ltr">{header.entryNo}</bdi>
            </span>
          </div>

          <div className={s.sapBody}>
            {/* The header of the document. None of it is editable: the dates
                and the description are fixed when the entry is opened, and
                §14.3 keeps the rate off the document altogether. */}
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
              <div className={s.sapField}>
                <span className={s.sapLabel}>{t('created_at')}</span>
                <span className={s.sapBox}>
                  <bdi dir="ltr">
                    {formatTimestamp(header.createdAt.toISOString(), locale as Locale)}
                  </bdi>
                </span>
              </div>
              <div className={s.sapField}>
                <span className={s.sapLabel}>{t('journals.posted_at')}</span>
                <span className={s.sapBox}>
                  <bdi dir="ltr">
                    {header.postedAt
                      ? formatTimestamp(header.postedAt.toISOString(), locale as Locale)
                      : '—'}
                  </bdi>
                </span>
              </div>
              <div className={`${s.sapField} ${s.sapWide}`}>
                <span className={s.sapLabel}>{t('journals.description')}</span>
                <span className={s.sapBox}>
                  <bdi dir="auto">{header.description ?? '—'}</bdi>
                </span>
              </div>
              {/* Both ends of a reversal point at each other, permanently. */}
              {linked ? (
                <div className={`${s.sapField} ${s.sapWide}`}>
                  <span className={s.sapLabel}>
                    {t(
                      linked.relation === 'reversed_by'
                        ? 'journals.reversed_by_hint'
                        : 'journals.reverses_hint',
                    )}
                  </span>
                  <span className={s.sapBox}>
                    <Link
                      className={s.sapLink}
                      href={`/finance/journals/${encodeURIComponent(linked.entryNo)}`}
                    >
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
            <div className={`${s.sapTableWrap} ${s.sapLineTableWrap}`}>
              <table aria-labelledby="journal-lines-heading" className={s.sapTable}>
                <thead>
                  {/* Two header rows: the currency each pair is stated in,
                      then the debit and credit beneath it. */}
                  <tr>
                    <th rowSpan={2} scope="col">
                      #
                    </th>
                    <th rowSpan={2} scope="col">
                      {t('journals.account')}
                    </th>
                    <th rowSpan={2} scope="col">
                      {t('journals.line_description')}
                    </th>
                    <th rowSpan={2} scope="col">
                      {t('journals.department')}
                    </th>
                    <th rowSpan={2} scope="col">
                      {t('journals.currency')}
                    </th>
                    <th className={s.sapGroup} colSpan={2} scope="colgroup">
                      {t('journals.amount_txn')}
                    </th>
                    <th className={s.sapGroup} colSpan={2} scope="colgroup">
                      {t('journals.amount_iqd')}
                    </th>
                    <th className={s.sapGroup} colSpan={2} scope="colgroup">
                      {t('journals.amount_usd')}
                    </th>
                    {mayEdit ? <th aria-label={t('journals.remove_line')} rowSpan={2} /> : null}
                  </tr>
                  <tr>
                    <th className={s.sapNum} scope="col">
                      {t('journals.debit')}
                    </th>
                    <th className={s.sapNum} scope="col">
                      {t('journals.credit')}
                    </th>
                    <th className={s.sapNum} scope="col">
                      {t('journals.debit')}
                    </th>
                    <th className={s.sapNum} scope="col">
                      {t('journals.credit')}
                    </th>
                    <th className={s.sapNum} scope="col">
                      {t('journals.debit')}
                    </th>
                    <th className={s.sapNum} scope="col">
                      {t('journals.credit')}
                    </th>
                  </tr>
                </thead>

                <tbody>
                  {lines.length === 0 && !mayEdit ? (
                    <tr>
                      <td colSpan={columnCount}>{t('journals.no_lines')}</td>
                    </tr>
                  ) : null}

                  {lines.map((line) => (
                    <tr key={line.id}>
                      <td>
                        <bdi dir="ltr">{line.lineNo}</bdi>
                      </td>
                      <td className={s.sapAccountCell}>
                        <bdi dir="ltr">{line.accountCode}</bdi> ·{' '}
                        <bdi dir="auto">{line.accountName}</bdi>
                      </td>
                      <td>
                        <bdi dir="auto">{line.description ?? ''}</bdi>
                      </td>
                      <td>
                        <bdi dir="ltr">{line.departmentCode ?? ''}</bdi>
                      </td>
                      <td>
                        <bdi dir="ltr">{line.currency}</bdi>
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">
                          {zero(line.debitTxn) ? '' : entered(line.debitTxn, line.currency)}
                        </bdi>
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">
                          {zero(line.creditTxn) ? '' : entered(line.creditTxn, line.currency)}
                        </bdi>
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{zero(line.debitIqd) ? '' : money(line.debitIqd)}</bdi>
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{zero(line.creditIqd) ? '' : money(line.creditIqd)}</bdi>
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{zero(line.debitUsd) ? '' : usd(line.debitUsd)}</bdi>
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{zero(line.creditUsd) ? '' : usd(line.creditUsd)}</bdi>
                      </td>
                      {mayEdit ? (
                        <td className={s.sapRowRemove}>
                          {/* One press, no dialog: a draft line is one row of
                              typing, and putting it back is one row of typing.
                              The domain refuses this the moment the entry is
                              no longer a draft, and so does the database. */}
                          <form action={removeJournalLine}>
                            <input name="id" type="hidden" value={header.id} />
                            <input name="entryNo" type="hidden" value={header.entryNo} />
                            <input name="lineId" type="hidden" value={line.id} />
                            <button
                              aria-label={t('journals.remove_line')}
                              title={t('journals.remove_line')}
                              type="submit"
                            >
                              ✕
                            </button>
                          </form>
                        </td>
                      ) : null}
                    </tr>
                  ))}

                  {/* The line being written, in the grid it is joining. The
                      IQD and USD cells stay empty because they are not typed —
                      §14.3 puts the rate out of reach of the entry, and the
                      ledger fills them from the posting date. */}
                  {mayEdit ? (
                    <tr className={s.sapEntryRow}>
                      <td>
                        <bdi dir="ltr">{lines.length + 1}</bdi>
                      </td>
                      <td>
                        <select
                          aria-label={t('journals.account')}
                          dir="auto"
                          form={ADD_LINE_FORM}
                          id="f-accountId"
                          name="accountId"
                          required
                        >
                          <option value="">{t('journals.account')}…</option>
                          {accounts.map((a) => (
                            <option key={a.id} value={a.id}>
                              {/* The currency an account is tied to belongs on
                                  the account, where it is chosen — not
                                  discovered later in a refusal. */}
                              {a.currencyRestriction
                                ? `${a.code} · ${a.name} · ${a.currencyRestriction}`
                                : `${a.code} · ${a.name}`}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input
                          aria-label={t('journals.line_description')}
                          autoComplete="off"
                          form={ADD_LINE_FORM}
                          id="line-note"
                          name="description"
                          type="text"
                        />
                      </td>
                      <td>
                        <select
                          aria-label={t('journals.department')}
                          dir="auto"
                          form={ADD_LINE_FORM}
                          name="departmentCode"
                          required
                        >
                          {depts.map((d) => (
                            <option key={d.code} value={d.code}>
                              {d.code} · {d.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <select
                          aria-label={t('journals.currency')}
                          defaultValue="IQD"
                          dir="ltr"
                          form={ADD_LINE_FORM}
                          id="f-currency"
                          name="currency"
                          required
                        >
                          {moneys.map((c) => (
                            <option key={c.code} value={c.code}>
                              {c.code}
                            </option>
                          ))}
                        </select>
                      </td>
                      {/* One or the other, never both — the domain refuses a
                          line that fills both, and says so in those words. */}
                      <td>
                        <input
                          aria-label={t('journals.debit')}
                          dir="ltr"
                          form={ADD_LINE_FORM}
                          min={0}
                          name="debit"
                          step="0.01"
                          type="number"
                        />
                      </td>
                      <td>
                        <input
                          aria-label={t('journals.credit')}
                          dir="ltr"
                          form={ADD_LINE_FORM}
                          min={0}
                          name="credit"
                          step="0.01"
                          type="number"
                        />
                      </td>
                      <td className={s.sapNum} />
                      <td className={s.sapNum} />
                      <td className={s.sapNum} />
                      <td className={s.sapNum} />
                      <td className={s.sapRowRemove} />
                    </tr>
                  ) : null}

                  {/* Room still to fill, drawn rather than hidden. */}
                  {fillers.map((row) => (
                    <tr aria-hidden="true" className={s.sapFiller} key={`filler-${row}`}>
                      {Array.from({ length: columnCount }, (_, cell) => (
                        <td key={`filler-${row}-${cell}`} />
                      ))}
                    </tr>
                  ))}
                </tbody>

                <tfoot>
                  <tr className={s.sapTotalRow}>
                    <td colSpan={4}>{t('journals.total')}</td>
                    <td>
                      <bdi dir="auto">{txnTotalNote}</bdi>
                    </td>
                    {/* Dinars and dollars do not add, so the typed column has
                        no total. IQD is the column that must agree. */}
                    <td className={s.sapNum} />
                    <td className={s.sapNum} />
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{totalDebit}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{totalCredit}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{totalDebitUsd}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{totalCreditUsd}</bdi>
                    </td>
                    {mayEdit ? <td className={s.sapRowRemove} /> : null}
                  </tr>
                </tfoot>
              </table>
            </div>

            {mayEdit ? (
              <>
                {/* The form the cells above submit to. It holds only what is
                    not typed; the controls live in the row, addressed by
                    `form=`. */}
                <form action={addJournalLine} className={s.sapEntryBar} id={ADD_LINE_FORM}>
                  <input name="id" type="hidden" value={header.id} />
                  <input name="entryNo" type="hidden" value={header.entryNo} />
                  <Submit label={t('journals.add_line')} />
                  {/* §14.3 puts the rate out of reach of the entry, so say
                      where it comes from rather than leaving a missing field
                      to explain itself in a refusal. */}
                  <span className={s.sapNote}>{t('journals.rate_note')}</span>
                </form>
                {/* Picking a dollar-only account moves the currency with it,
                    so the pairing cannot be got wrong by leaving a control
                    where it was. */}
                <LineCurrency
                  accountSelectId="f-accountId"
                  currencySelectId="f-currency"
                  restrictions={Object.fromEntries(
                    accounts.map((a) => [a.id, a.currencyRestriction ?? null]),
                  )}
                />
              </>
            ) : null}
          </div>

          {/* The foot: what may be done, and what the document comes to. */}
          <div className={s.sapFoot}>
            <div className={s.sapFootActions}>
              {/* Paper is a status-free right: a draft prints stamped as a
                  draft, which is sometimes exactly what a reviewer wants. */}
              <Link
                className={s.button}
                href={`/finance/journals/${encodeURIComponent(header.entryNo)}/print`}
                target="_blank"
              >
                {t('journals.print')}
              </Link>
              {maySubmit ? (
                <ActionButton
                  action={submitJournal}
                  hidden={hidden}
                  label={t('journals.submit')}
                  small={false}
                  tone="primary"
                />
              ) : null}
              {mayDecide ? (
                <ActionButton
                  action={approveJournal}
                  hidden={hidden}
                  label={t('journals.approve')}
                  small={false}
                  tone="primary"
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
            <div className={s.sapFootTotals}>
              {/* An entry that does not balance cannot be posted, and the
                  totals are where a person looks to find out. */}
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
          </div>
        </div>

        {/* Deciding on somebody else's entry, and correcting one's own. Both
            need a reason typed, so neither belongs on the button bar. */}
        {mayDecide || mayReverse ? (
          <div className={`${s.sapWindow} ${s.noPrint}`}>
            <div className={s.sapTitle}>{t('journals.actions')}</div>
            <div className={s.sapBody}>
              {mayDecide ? (
                <ReasonForm
                  action={rejectJournal}
                  hidden={hidden}
                  label={t('journals.reject')}
                  reasonLabel={t('journals.reject_reason')}
                />
              ) : null}
              {mayReverse ? (
                <>
                  <p className={s.sapNote}>{t('journals.reverse_hint')}</p>
                  <ReasonForm
                    action={reverseJournal}
                    hidden={hidden}
                    label={t('journals.reverse')}
                    reasonLabel={t('journals.reverse_reason')}
                  />
                </>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* Once posted, nothing more can be attached. Rather than leave the
            column standing empty — a gutter beside the history, holding a box
            that can never fill — the history takes the full width. */}
        {mayAttach || hasAttachments ? (
          <div className={s.profileGrid}>
            <div className={s.profileStack}>
              <Attachments
                action={attachToJournal}
                hidden={hidden}
                mayAttach={mayAttach}
                objectId={header.id}
                objectType={journal.PERMISSION_OBJECT}
              />
            </div>
            <div className={s.profileStack}>
              <RecordHistory objectId={header.id} objectType={journal.PERMISSION_OBJECT} />
            </div>
          </div>
        ) : (
          <div className={s.profileGrid}>
            <div className={s.profileStack}>
              {/* A document that went through with no paperwork says so in
                  words — silence reads as a screen that forgot to load, and
                  an auditor should not have to infer the difference. */}
              <section className={s.sapWindow}>
                <div className={s.sapTitle}>{t('attachments.title')}</div>
                <div className={s.sapBody}>
                  <p className={s.sapNote}>{t('journals.no_attachments_posted')}</p>
                </div>
              </section>
            </div>
            <div className={s.profileStack}>
              <RecordHistory objectId={header.id} objectType={journal.PERMISSION_OBJECT} />
            </div>
          </div>
        )}
        </div>
      </div>

    </AdminPage>
  );
}
