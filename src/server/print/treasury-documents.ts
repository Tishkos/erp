/**
 * Accounting's own documents as print models — REQ-ACC-001 Part D (the
 * Printer door on every record, 2026-10-04).
 *
 * Each builder reads the service its record screen reads and lays out the
 * same header fields and the same lines under the same labels, so the copy
 * and the screen are one set of figures. Read through the reader's own row
 * security: another branch's record is not found rather than refused.
 */
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { parseDecimal, toDecimalString } from '../domain/money';
import * as treasury from '../services/treasury';
import * as rec from '../services/bank-reconciliation';
import type { BuildContext, Built } from './documents';
import type { Fact, PrintModel } from './model';

const day = (value: string | null | undefined, locale: Locale) => (value ? formatBusinessDate(value, locale) : '—');

const base = (
  input: Pick<PrintModel, 'title' | 'fields' | 'tables'> &
    Partial<Pick<PrintModel, 'number' | 'status' | 'posted' | 'summary' | 'signatures' | 'orientation'>> & {
      readonly fileName: string;
    },
): PrintModel => ({
  kind: 'document',
  orientation: input.orientation ?? 'portrait',
  filters: [],
  summary: input.summary ?? [],
  signatures: input.signatures ?? false,
  currency: 'IQD',
  sheetName: input.title,
  ...input,
});

/** An Internal Transfer: its boxes, and the journal it makes as its lines. */
export async function internalTransfer(ctx: BuildContext, transferNo: string): Promise<Built | null> {
  const { tx, m, locale, principal, branchCode } = ctx;
  let transfer: treasury.TransferRow;
  try {
    transfer = await treasury.transferByNo(tx, { principal, branchCode }, transferNo);
  } catch {
    return null;
  }
  const value = await treasury.valueTransfer(tx, transfer).catch(() => null);
  const t = (key: string) => m.admin(`internal_transfers.${key}`);
  const money = (amount: string, currency: string) => formatMoney(amount, currency, locale);
  const iqd = (amount: bigint) => toDecimalString(amount < 0n ? -amount : amount, 4n);

  const fields: Fact[] = [
    { label: t('col_no'), value: transfer.transferNo, ltr: true },
    { label: t('col_status'), value: m.status(transfer.status) },
    { label: t('date'), value: day(transfer.transferDate, locale), ltr: true },
    { label: t('from'), value: `${transfer.fromName} (${transfer.fromCode})` },
    { label: t('to'), value: `${transfer.toName} (${transfer.toCode})` },
    { label: t('amount'), value: money(transfer.amount, transfer.fromCurrency), ltr: true },
    { label: t('received'), value: money(transfer.receivedAmount, transfer.toCurrency), ltr: true },
    ...(transfer.fromCurrency !== transfer.toCurrency && transfer.fxRate
      ? [{ label: t('rate'), value: transfer.fxRate.replace(/\.?0+$/, ''), ltr: true }]
      : []),
    { label: t('reference'), value: transfer.bankReference ?? '—' },
    { label: t('journal'), value: transfer.journalEntryNo ?? '—', ltr: true },
    ...(transfer.reversalEntryNo ? [{ label: t('reversal_journal'), value: transfer.reversalEntryNo, ltr: true }] : []),
    { label: t('raised_by'), value: transfer.createdByName ?? '—' },
    { label: t('approved_by'), value: transfer.approvedByName ?? '—' },
    { label: t('posted_by'), value: transfer.postedByName ?? '—' },
    ...(transfer.note ? [{ label: t('purpose'), value: transfer.note }] : []),
    ...(transfer.reversalReason ? [{ label: t('reversal_reason'), value: transfer.reversalReason }] : []),
  ];

  const rows = [
    {
      cells: {
        account: `${transfer.toName} (${transfer.toCode})`,
        gl: transfer.toGlCode ?? '—',
        entered: money(transfer.receivedAmount, transfer.toCurrency),
        debit: value ? iqd(value.destinationIqd) : null,
        credit: null,
      },
    },
    {
      cells: {
        account: `${transfer.fromName} (${transfer.fromCode})`,
        gl: transfer.fromGlCode ?? '—',
        entered: money(transfer.amount, transfer.fromCurrency),
        debit: null,
        credit: value ? iqd(value.sourceIqd) : null,
      },
    },
    ...(value && value.differenceIqd !== 0n
      ? [
          {
            cells: {
              account: value.differenceIqd > 0n ? t('exchange_gain') : t('exchange_loss'),
              gl: '—',
              entered: null,
              debit: value.differenceIqd < 0n ? iqd(value.differenceIqd) : null,
              credit: value.differenceIqd > 0n ? iqd(value.differenceIqd) : null,
            },
          },
        ]
      : []),
  ];

  const title = m.print('titles.internal_transfer');
  return {
    model: base({
      title,
      number: transfer.transferNo,
      status: m.status(transfer.status),
      posted: transfer.status === 'posted' || transfer.status === 'reversed',
      fields,
      tables: [
        {
          title: t('lines'),
          columns: [
            { key: 'account', label: t('account'), kind: 'text', weight: 2 },
            { key: 'gl', label: t('gl_account'), kind: 'code' },
            { key: 'entered', label: t('entered'), kind: 'text' },
            { key: 'debit', label: t('debit'), kind: 'money' },
            { key: 'credit', label: t('credit'), kind: 'money' },
          ],
          rows,
          empty: '—',
          ...(value
            ? {
                totals: {
                  label: m.print('totals'),
                  // One figure each side: what the destination (and any loss)
                  // received equals what the source (and any gain) gave.
                  cells: {
                    debit: iqd(value.destinationIqd + (value.differenceIqd < 0n ? -value.differenceIqd : 0n)),
                    credit: iqd(value.sourceIqd + (value.differenceIqd > 0n ? value.differenceIqd : 0n)),
                  },
                  sum: ['debit', 'credit'],
                },
              }
            : {}),
        },
      ],
      signatures: true,
      fileName: transfer.transferNo,
    }),
    branchCode: transfer.branchCode,
    objectId: transfer.id,
  };
}

/**
 * A bank statement and its reconciliation: the statement's boxes and the
 * reconciliation's arithmetic, the bank's lines with how each stands, and
 * the matches agreed.
 */
export async function bankReconciliation(ctx: BuildContext, statementNo: string): Promise<Built | null> {
  const { tx, m, locale, principal, branchCode } = ctx;
  let view: Awaited<ReturnType<typeof rec.workspace>>;
  try {
    view = await rec.workspace(tx, { principal, branchCode }, statementNo);
  } catch {
    return null;
  }
  const { statement, lines, reconciliation } = view;
  const t = (key: string, values?: Record<string, string | number>) => m.admin(`bank_reconciliation.${key}`, values);
  const money = (amount: string | bigint) =>
    formatMoney(typeof amount === 'bigint' ? toDecimalString(amount, 4n) : amount, statement.currency, locale);

  const fields: Fact[] = [
    { label: t('col_statement'), value: statement.statementNo, ltr: true },
    { label: t('col_status'), value: t(`stage_${statement.stage}`) },
    { label: t('account'), value: `${statement.accountName} (${statement.accountCode})` },
    { label: t('gl_account'), value: view.glCode ? `${view.glCode} · ${view.glName ?? ''}` : '—' },
    { label: t('col_period'), value: `${day(statement.periodFrom, locale)} – ${day(statement.periodTo, locale)}`, ltr: true },
    { label: t('bank_reference'), value: statement.bankReference ?? '—' },
    { label: t('opening'), value: money(statement.openingIqd), ltr: true },
    { label: t('closing'), value: money(statement.closingIqd), ltr: true },
    ...(statement.reconciliationNo ? [{ label: t('reconciliation_no'), value: statement.reconciliationNo, ltr: true }] : []),
    ...(reconciliation
      ? [
          { label: t('ledger_balance'), value: money(reconciliation.position.ledgerBalanceIqd), ltr: true },
          { label: t('in_transit'), value: money(reconciliation.position.depositsInTransitIqd), ltr: true },
          { label: t('unpresented'), value: money(reconciliation.position.unpresentedPaymentsIqd), ltr: true },
          { label: t('difference'), value: money(reconciliation.position.differenceIqd), ltr: true },
        ]
      : []),
    { label: t('entered_by'), value: view.createdBy ?? '—' },
    ...(statement.reconciliationNo ? [{ label: t('prepared_by'), value: view.preparedBy ?? '—' }] : []),
    ...(statement.reconciliationNo ? [{ label: t('approved_by'), value: view.approvedBy ?? '—' }] : []),
  ];

  const title = m.print('titles.bank_reconciliation');
  return {
    model: base({
      title,
      number: statement.statementNo,
      status: t(`stage_${statement.stage}`),
      posted: statement.stage === 'reconciled',
      orientation: 'landscape',
      fields,
      tables: [
        {
          title: t('lines'),
          columns: [
            { key: 'line', label: '#', kind: 'code', weight: 0.45 },
            { key: 'booking', label: t('booking_date'), kind: 'text' },
            { key: 'value', label: t('value_date'), kind: 'text' },
            { key: 'reference', label: t('reference'), kind: 'text', weight: 1.5 },
            { key: 'counterparty', label: t('counterparty'), kind: 'text' },
            { key: 'amount', label: t('amount'), kind: 'money' },
            { key: 'match', label: t('col_match'), kind: 'text' },
          ],
          rows: lines.map((line) => ({
            cells: {
              line: String(line.lineNo),
              booking: day(line.bookingDate, locale),
              value: day(line.valueDate, locale),
              reference: line.reference ?? '—',
              counterparty: line.counterparty ?? '—',
              amount: line.amountIqd,
              match: `${t(`match_${line.matchStatus}`)}${line.matchNo ? ` · ${line.matchNo}` : ''}`,
            },
          })),
          empty: t('no_lines'),
          totals: {
            label: m.print('totals'),
            // The statement's movement: the lines summed, exactly.
            cells: { amount: toDecimalString(lines.reduce((sum, line) => sum + parseDecimal(line.amountIqd, 4n), 0n), 4n) },
            sum: ['amount'],
          },
        },
        ...(reconciliation
          ? [
              {
                title: t('matches_title'),
                columns: [
                  { key: 'match', label: '#', kind: 'code' as const, weight: 0.45 },
                  { key: 'lines', label: t('col_statement_lines'), kind: 'text' as const, weight: 1.5 },
                  { key: 'journals', label: t('col_journals'), kind: 'text' as const, weight: 1.5 },
                  { key: 'why', label: t('col_why'), kind: 'text' as const, weight: 2 },
                  { key: 'state', label: t('col_state'), kind: 'text' as const },
                ],
                rows: reconciliation.matches.map((match) => ({
                  cells: {
                    match: String(match.matchNo),
                    lines: match.statementLines.map((line) => String(line.lineNo)).join(', '),
                    journals: match.journalLines.map((line) => line.entryNo).join(', '),
                    why: match.why ?? '—',
                    state: t(`state_${match.state}`),
                  },
                })),
                empty: t('no_matches'),
              },
            ]
          : []),
      ],
      signatures: true,
      fileName: statement.statementNo,
    }),
    branchCode: statement.branchCode,
    objectId: statement.statementId,
  };
}
