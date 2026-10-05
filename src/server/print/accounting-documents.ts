/**
 * Accounting's own documents as print models — REQ-ACC-001 Part D (the
 * Printer door on every record, 2026-10-04).
 *
 * Each builder reads the service its record screen reads and lays out the
 * same header fields and the same lines under the same labels, so the copy
 * and the screen are one set of figures. Read through the reader's own row
 * security: another branch's record is not found rather than refused.
 */
import { formatBusinessDate, formatMoney, formatTimestamp, type Locale } from '@/i18n/config';
import { parseDecimal, toDecimalString } from '../domain/money';
import * as treasury from '../services/treasury';
import * as rec from '../services/bank-reconciliation';
import * as treasuryReports from '../services/treasury-reports';
import * as forecasts from '../services/cash-forecast';
import * as subledger from '../services/account-reconciliation';
import * as taxCodes from '../services/tax-codes';
import * as recurring from '../services/recurring-journals';
import * as periods from '../services/periods';
import * as deposits from '../services/bank-deposits';
import * as loans from '../services/loans';
import { businessToday } from '../domain/business-date';
import { addDays } from '../domain/dates';
import type { BuildContext, Built } from './documents';
import { EXPORT_ROW_CAP, type Fact, type PrintModel } from './model';

const day = (value: string | null | undefined, locale: Locale) => (value ? formatBusinessDate(value, locale) : '—');

/**
 * A document in its own currency. The model's money columns are read in the
 * model's currency, which the renderers know as dinars or dollars; a record
 * held in anything else keeps its figures as the words the screen shows.
 */
const inCurrency = (currency: string, locale: Locale) => {
  const model: PrintModel['currency'] = currency === 'USD' ? 'USD' : 'IQD';
  const native = currency === 'IQD' || currency === 'USD';
  return {
    currency: model,
    kind: (native ? 'money' : 'text') as 'money' | 'text',
    cell: (value: string | bigint): string => {
      const text = typeof value === 'bigint' ? toDecimalString(value, 4n) : value;
      return native ? text : formatMoney(text, currency, locale);
    },
  };
};

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

// ---------------------------------------------------------------------------
// Accounting's reports — each the screen's own read, transcribed
// ---------------------------------------------------------------------------

const report = (
  input: Pick<PrintModel, 'title' | 'filters' | 'tables'> &
    Partial<Pick<PrintModel, 'summary' | 'orientation'>> & { readonly fileName: string },
): PrintModel => ({
  kind: 'report',
  fields: [],
  summary: input.summary ?? [],
  signatures: false,
  orientation: input.orientation ?? 'portrait',
  currency: 'IQD',
  sheetName: input.title,
  ...input,
});

const queryValue = (query: URLSearchParams, name: string) => (query.get(name) ?? '').trim();

/** Payments & Receipts — every row the filters choose, up to the export cap. */
export async function paymentsReceipts(ctx: BuildContext, query: URLSearchParams): Promise<Built | null> {
  const { tx, m, locale, principal, branchCode } = ctx;
  const t = (key: string) => m.admin(`payments_receipts.${key}`);
  const from = queryValue(query, 'from') || `${businessToday().slice(0, 4)}-01-01`;
  const to = queryValue(query, 'to') || businessToday();
  const view = (treasuryReports.MONEY_VIEWS as readonly string[]).includes(queryValue(query, 'view'))
    ? (queryValue(query, 'view') as treasuryReports.MoneyView)
    : null;
  const accountCode = queryValue(query, 'account') || null;
  const search = queryValue(query, 'q') || null;
  const result = await treasuryReports.moneyRegister(tx, { principal, branchCode }, {
    from,
    to,
    view,
    accountCode,
    search,
    page: 1,
    pageSize: EXPORT_ROW_CAP + 1,
  });
  const title = m.print('titles.payments_receipts');
  return {
    model: report({
      title,
      orientation: 'landscape',
      filters: [
        { label: t('from'), value: day(from, locale), ltr: true },
        { label: t('to'), value: day(to, locale), ltr: true },
        ...(view ? [{ label: t('view'), value: t(`view_${view}`) }] : []),
        ...(accountCode ? [{ label: t('account'), value: accountCode, ltr: true }] : []),
        ...(search ? [{ label: m.print('search'), value: search }] : []),
      ],
      tables: [
        {
          columns: [
            { key: 'date', label: t('date'), kind: 'date' },
            { key: 'document', label: t('document'), kind: 'code' },
            { key: 'journal', label: m.admin('journals.entry_no'), kind: 'code' },
            { key: 'account', label: t('account'), kind: 'text', weight: 1.5 },
            { key: 'party', label: t('party'), kind: 'text', weight: 1.5 },
            { key: 'movement', label: t('movement'), kind: 'text' },
            { key: 'in', label: t('money_in'), kind: 'money' },
            { key: 'out', label: t('money_out'), kind: 'money' },
          ],
          rows: result.rows.map((row) => ({
            cells: {
              date: row.postingDate,
              document: row.documentNo ?? '—',
              journal: row.entryNo,
              account: `${row.accountName} (${row.accountCode})`,
              party: row.partyName ?? row.partyCode ?? row.description ?? '—',
              movement: t(`kind_${row.kind}`),
              in: row.direction === 'in' ? row.amountIqd : null,
              out: row.direction === 'out' ? row.amountIqd : null,
            },
          })),
          empty: t('none'),
          totals: { label: t('totals'), cells: { in: result.totalInIqd, out: result.totalOutIqd } },
        },
      ],
      fileName: `payments-receipts-${from}-${to}`,
    }),
    branchCode,
    objectId: 'payments_receipts',
  };
}

/** Cash Forecast — the periods, the position by currency, the lines by source. */
export async function cashForecast(ctx: BuildContext, query: URLSearchParams): Promise<Built | null> {
  const { tx, m, locale, principal, branchCode } = ctx;
  const t = (key: string) => m.admin(`cash_forecast.${key}`);
  const today = businessToday();
  const from = queryValue(query, 'from') || today;
  const to = queryValue(query, 'to') || addDays(from, 90);
  const bucket = (forecasts.FORECAST_BUCKETS as readonly string[]).includes(queryValue(query, 'bucket'))
    ? (queryValue(query, 'bucket') as forecasts.ForecastBucket)
    : 'week';
  const actor = { principal, branchCode };
  const forecast = await forecasts.forecast(tx, actor, { from, to, bucket });
  const title = m.print('titles.cash_forecast');
  return {
    model: report({
      title,
      filters: [
        { label: m.admin('reports.from'), value: day(from, locale), ltr: true },
        { label: m.admin('reports.to'), value: day(to, locale), ltr: true },
        { label: t('bucket'), value: t(`bucket_${bucket}`) },
      ],
      tables: [
        {
          title: t('by_period'),
          columns: [
            { key: 'period', label: t('period'), kind: 'date' },
            { key: 'opening', label: t('opening'), kind: 'money' },
            { key: 'in', label: t('inflow'), kind: 'money' },
            { key: 'out', label: t('outflow'), kind: 'money' },
            { key: 'closing', label: t('closing'), kind: 'money' },
          ],
          rows: forecast.periods.map((period) => ({
            cells: { period: period.periodStart, opening: period.openingIqd, in: period.inflowIqd, out: period.outflowIqd, closing: period.closingIqd },
          })),
          empty: t('nothing_expected'),
        },
        {
          title: t('by_source'),
          columns: [
            { key: 'period', label: t('period'), kind: 'date' },
            { key: 'source', label: t('source'), kind: 'text', weight: 1.5 },
            { key: 'in', label: t('inflow'), kind: 'money' },
            { key: 'out', label: t('outflow'), kind: 'money' },
            { key: 'net', label: t('net'), kind: 'money' },
          ],
          rows: forecast.lines.map((line) => ({
            cells: { period: line.periodStart, source: t(`source_${line.source}`), in: line.inflowIqd, out: line.outflowIqd, net: line.netIqd },
          })),
          empty: t('nothing_expected'),
        },
      ],
      summary: [
        { label: t('opening'), value: formatMoney(forecast.openingIqd, 'IQD', locale), ltr: true },
        { label: t('closing'), value: formatMoney(forecast.closingIqd, 'IQD', locale), ltr: true },
      ],
      fileName: `cash-forecast-${from}-${to}`,
    }),
    branchCode,
    objectId: 'cash_forecast',
  };
}

/** Account Reconciliation — the control accounts and the inventory figure, as at a date. */
export async function accountReconciliation(ctx: BuildContext, query: URLSearchParams): Promise<Built | null> {
  const { tx, m, locale, principal, branchCode } = ctx;
  const t = (key: string) => m.admin(`account_reconciliation.${key}`);
  const asOf = queryValue(query, 'to') || businessToday();
  const result = await subledger.accountReconciliation(tx, { principal, branchCode }, asOf);
  const kind = (code: string) => t(`kind_${code}`);
  const title = m.print('titles.account_reconciliation');
  return {
    model: report({
      title,
      orientation: 'landscape',
      filters: [{ label: m.admin('reports.as_at_label'), value: day(asOf, locale), ltr: true }],
      tables: [
        {
          title: t('control_accounts'),
          columns: [
            { key: 'account', label: t('account'), kind: 'text', weight: 2 },
            { key: 'kind', label: t('subledger'), kind: 'text' },
            { key: 'sub', label: t('subledger_balance'), kind: 'money' },
            { key: 'gl', label: t('gl_balance'), kind: 'money' },
            { key: 'difference', label: t('difference'), kind: 'money' },
          ],
          rows: result.rows.map((row) => ({
            cells: {
              account: `${row.accountCode} · ${row.accountName}`,
              kind: kind(row.subledgerType),
              sub: row.subledgerBalance,
              gl: row.generalLedgerBalance,
              difference: row.difference,
            },
          })),
          empty: t('no_control_accounts'),
        },
        {
          title: t('inventory_title'),
          columns: [
            { key: 'kind', label: t('subledger'), kind: 'text' },
            { key: 'layers', label: t('layers'), kind: 'money' },
            { key: 'provisional', label: t('not_yet_posted'), kind: 'money' },
            { key: 'gl', label: t('gl_balance'), kind: 'money' },
            { key: 'difference', label: t('difference'), kind: 'money' },
          ],
          rows: [
            {
              cells: {
                kind: t('kind_inventory'),
                layers: result.inventory.layersIqd,
                provisional: result.inventory.provisionalIqd,
                gl: result.inventory.accountsIqd,
                difference: result.inventory.differenceIqd,
              },
            },
          ],
          empty: '—',
        },
      ],
      fileName: `account-reconciliation-${asOf}`,
    }),
    branchCode,
    objectId: 'account_reconciliation',
  };
}

/** A Tax Code: its boxes, and every rate it has had. */
export async function taxCode(ctx: BuildContext, code: string): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  let row: Awaited<ReturnType<typeof taxCodes.detail>>;
  try {
    row = await taxCodes.detail(tx, code);
  } catch {
    return null;
  }
  const t = (key: string) => m.admin(`tax_codes.${key}`);
  const percent = (rate: string | null) => (rate === null ? '—' : `${rate.replace(/\.?0+$/, '')}%`);
  const today = await taxCodes.rateOn(tx, code, businessToday());
  const title = m.print('titles.tax_code');
  return {
    model: base({
      title,
      number: row.code,
      status: row.active ? m.admin('active') : m.status('cancelled'),
      posted: true,
      fields: [
        { label: t('code'), value: row.code, ltr: true },
        { label: t('name'), value: row.name },
        { label: t('direction'), value: t(`direction_${row.direction}`) },
        { label: t('recoverable'), value: row.isRecoverable ? t('recoverable_yes') : t('recoverable_no') },
        { label: t('account'), value: `${row.account.code} · ${row.account.name}` },
        { label: t('current_rate'), value: percent(today), ltr: true },
        { label: t('created_by'), value: row.createdByName ?? '—' },
      ],
      tables: [
        {
          title: t('rates'),
          columns: [
            { key: 'from', label: t('effective_from'), kind: 'text' },
            { key: 'rate', label: t('rate'), kind: 'text' },
            { key: 'by', label: t('added_by'), kind: 'text' },
          ],
          rows: row.rates.map((rate) => ({
            cells: { from: day(rate.effectiveFrom, locale), rate: percent(rate.ratePercent), by: rate.createdBy ?? '—' },
          })),
          empty: t('no_rates'),
        },
      ],
      fileName: row.code,
    }),
    // A tax code is the company's, not a branch's: the reader's letterhead.
    branchCode: ctx.branchCode,
    objectId: row.code,
  };
}

/** A Recurring Journal: its schedule, the journal it raises, and the journals it raised. */
export async function recurringJournal(ctx: BuildContext, templateNo: string): Promise<Built | null> {
  const { tx, m, locale, principal, branchCode } = ctx;
  let view: Awaited<ReturnType<typeof recurring.view>>;
  try {
    view = await recurring.view(tx, { principal, branchCode }, templateNo);
  } catch {
    return null;
  }
  const { template, lines, runs, totals } = view;
  const t = (key: string, values?: Record<string, string | number>) => m.admin(`recurring_journals.${key}`, values);
  const every =
    template.intervalCount === 1
      ? t(`frequency_${template.frequency}`)
      : t('every_n', { n: template.intervalCount, unit: t(`unit_${template.frequency}`) });
  const title = m.print('titles.recurring_journal');
  return {
    model: base({
      title,
      number: template.templateNo,
      status: t(`status_${template.status}`),
      posted: template.status !== 'draft',
      fields: [
        { label: t('col_no'), value: template.templateNo, ltr: true },
        { label: t('name'), value: template.name },
        { label: t('frequency'), value: every },
        { label: t('starts_on'), value: day(template.startsOn, locale), ltr: true },
        { label: t('ends_on'), value: day(template.endsOn, locale), ltr: true },
        { label: t('next_due'), value: day(template.nextDueOn, locale), ltr: true },
        { label: t('written_by'), value: view.createdByName ?? '—' },
        { label: t('agreed_by'), value: view.activatedByName ?? '—' },
        ...(template.description ? [{ label: t('description'), value: template.description }] : []),
        ...(template.endReason ? [{ label: t('end_reason'), value: template.endReason }] : []),
      ],
      tables: [
        {
          title: t('lines'),
          columns: [
            { key: 'line', label: '#', kind: 'code', weight: 0.45 },
            { key: 'account', label: t('account'), kind: 'text', weight: 2 },
            { key: 'department', label: t('department'), kind: 'code' },
            { key: 'debit', label: t('debit'), kind: 'money' },
            { key: 'credit', label: t('credit'), kind: 'money' },
          ],
          rows: lines.map((line) => ({
            cells: {
              line: String(line.lineNo),
              account: `${line.accountCode} · ${line.accountName}`,
              department: line.departmentCode ?? '',
              debit: Number(line.debit) === 0 ? null : line.debit,
              credit: Number(line.credit) === 0 ? null : line.credit,
            },
          })),
          empty: t('no_lines'),
          totals: { label: m.print('totals'), cells: { debit: totals.debit, credit: totals.credit }, sum: ['debit', 'credit'] },
        },
        {
          title: t('runs_title'),
          columns: [
            { key: 'due', label: t('due_on'), kind: 'text' },
            { key: 'journal', label: t('journal'), kind: 'code' },
            { key: 'status', label: t('col_status'), kind: 'text' },
            { key: 'by', label: t('raised_by'), kind: 'text' },
          ],
          rows: runs.map((run) => ({
            cells: { due: day(run.dueOn, locale), journal: run.entryNo, status: m.status(run.status), by: run.raisedBy ?? '—' },
          })),
          empty: t('no_runs'),
        },
      ],
      signatures: true,
      fileName: template.templateNo,
    }),
    branchCode: template.branchCode,
    objectId: template.id,
  };
}

/**
 * Period / Year-End Closing: one period's checklist as it stands, and the
 * closes and reopenings it has been through — the page's own figures, read
 * from the same `periods.closeReport` and `periods.closeHistory`.
 */
export async function periodClose(ctx: BuildContext, periodId: string): Promise<Built | null> {
  const { tx, m, locale, principal, branchCode } = ctx;
  let report: Awaited<ReturnType<typeof periods.closeReport>>;
  try {
    report = await periods.closeReport(tx, periodId);
  } catch {
    return null;
  }
  const { period } = report;
  const p = (key: string, values?: Record<string, string | number>) => m.admin(`periods.${key}`, values);
  const c = (key: string, values?: Record<string, string | number>) => m.admin(`closing.${key}`, values);
  const history = (await periods.closeHistory(tx, { principal, branchCode })).filter(
    (row) => row.periodName === period.name && row.yearCode === period.fiscalYearCode,
  );
  const title = m.print('titles.period_close');
  const checkName = (code: string) => p(`check_${code}`);
  return {
    model: base({
      title,
      number: `${period.name} · ${period.fiscalYearCode}`,
      status: p(`state_${period.status}`),
      posted: period.status === 'closed',
      fields: [
        { label: p('period'), value: period.name },
        { label: p('year'), value: period.fiscalYearCode, ltr: true },
        { label: p('starts_on'), value: day(period.startsOn, locale), ltr: true },
        { label: p('ends_on'), value: day(period.endsOn, locale), ltr: true },
        { label: p('state'), value: p(`state_${period.status}`) },
        { label: m.admin('reports.as_at_label'), value: day(report.asOf, locale), ltr: true },
        {
          label: p('close_checks'),
          value: report.mayClose
            ? p('close_checks_pass', { period: period.name, asOf: day(report.asOf, locale) })
            : p('close_checks_fail', { period: period.name, count: report.blockingFailures.length }),
        },
      ],
      tables: [
        {
          title: c('checklist', { period: period.name }),
          columns: [
            { key: 'check', label: p('check'), kind: 'text', weight: 2.2 },
            { key: 'severity', label: p('check_severity'), kind: 'text' },
            { key: 'figure', label: p('check_figure'), kind: 'code' },
            { key: 'detail', label: p('check_detail'), kind: 'text', weight: 2 },
            { key: 'state', label: p('state'), kind: 'text' },
          ],
          rows: report.checks.map((check) => ({
            cells: {
              check: checkName(check.code),
              severity: p(`check_severity_${check.severity}`),
              figure: check.figure,
              detail:
                check.detail.length === 0
                  ? '—'
                  : check.detail.slice(0, 8).join('; ') + (check.detail.length > 8 ? ` ${p('check_more', { count: check.detail.length - 8 })}` : ''),
              state: p(`check_state_${check.state}`),
            },
          })),
          empty: '—',
        },
        {
          title: c('history_title'),
          columns: [
            { key: 'when', label: c('when'), kind: 'text' },
            { key: 'change', label: c('change'), kind: 'text' },
            { key: 'who', label: c('who'), kind: 'text' },
            { key: 'reason', label: m.admin('reason'), kind: 'text', weight: 2 },
            { key: 'warnings', label: c('warnings'), kind: 'text', weight: 2 },
          ],
          rows: history.map((row) => ({
            cells: {
              when: formatTimestamp(new Date(row.occurredAt).toISOString(), locale),
              change: `${row.fromStatus ? p(`state_${row.fromStatus}`) : '—'} → ${row.toStatus ? p(`state_${row.toStatus}`) : '—'}`,
              who: row.actorName ?? '—',
              reason: row.reason ?? '—',
              warnings: row.warnings.length === 0 ? '—' : row.warnings.map(checkName).join('; '),
            },
          })),
          empty: c('no_history'),
        },
      ],
      signatures: true,
      fileName: `period-close-${period.fiscalYearCode}-${period.name}`,
    }),
    // A period is the company's, not a branch's: the reader's letterhead.
    branchCode,
    objectId: period.id,
  };
}

/**
 * A manual deposit — the register's row, in the words its record page uses:
 * the one line the money is, into the account it landed in, from whoever
 * paid it or the cash it came out of (REQ-FIX-001 FIX-1; the printer door,
 * 2026-10-04). Read through the register's own reader, so a deposit of
 * another branch is not found rather than refused.
 */
export async function bankDeposit(ctx: BuildContext, depositNo: string): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  let deposit: deposits.DepositRow;
  try {
    deposit = await deposits.byNo(tx, depositNo);
  } catch {
    return null;
  }
  const t = (key: string) => m.admin(`bank_deposits.${key}`);
  const own = inCurrency(deposit.currency, locale);
  const into = `${deposit.intoName} (${deposit.intoCode}) · ${deposit.currency}`;
  const from = deposit.payer ?? `${deposit.fromName} (${deposit.fromCode})`;
  const fields: Fact[] = [
    { label: t('col_no'), value: deposit.no, ltr: true },
    { label: t('col_status'), value: m.status(deposit.status) },
    { label: t('date'), value: day(deposit.depositDate, locale), ltr: true },
    { label: t('source'), value: t(`source_${deposit.source}`) },
    { label: t('into'), value: into },
    { label: t('from'), value: from },
    ...(deposit.source !== 'transfer' ? [{ label: t('credit_account'), value: `${deposit.fromCode} · ${deposit.fromName}` }] : []),
    { label: t('reference'), value: deposit.reference ?? '—' },
    { label: t('journal'), value: deposit.journalEntryNo ?? '—', ltr: true },
    ...(deposit.note ? [{ label: t('note'), value: deposit.note }] : []),
  ];
  return {
    model: {
      ...base({
        title: m.print('titles.bank_deposit'),
        number: deposit.no,
        status: m.status(deposit.status),
        posted: deposit.status === 'posted',
        fields,
        tables: [
          {
            title: t('lines'),
            columns: [
              { key: 'into', label: t('into'), kind: 'text', weight: 2 },
              { key: 'from', label: t('from'), kind: 'text', weight: 2 },
              { key: 'amount', label: t('amount'), kind: own.kind },
            ],
            rows: [{ cells: { into: `${deposit.intoName} (${deposit.intoCode})`, from, amount: own.cell(deposit.amount) } }],
            empty: '—',
            totals: { label: t('amount'), cells: { amount: own.cell(deposit.amount) }, sum: ['amount'] },
          },
        ],
        signatures: true,
        fileName: deposit.no,
      }),
      currency: own.currency,
    },
    branchCode: deposit.branchCode,
    objectId: deposit.id,
  };
}

/**
 * A bank loan — its boxes and its repayment schedule as the record page shows
 * them, each instalment with how it stands and when it was paid, the foot
 * holding what is outstanding, repaid and still to allocate (REQ-AP-001
 * §15.7; the printer door, 2026-10-04). The figures are in the loan's own
 * currency, as the page's are.
 */
export async function bankLoan(ctx: BuildContext, loanNo: string): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  let found: Awaited<ReturnType<typeof loans.view>>;
  try {
    found = await loans.view(tx, loanNo);
  } catch {
    return null;
  }
  const { loan, treatment, schedule, totals } = found;
  const position = await loans.positionOf(tx, loan.id);
  const t = (key: string) => m.admin(`loans.${key}`);
  const own = inCurrency(loan.currency, locale);
  const money = (value: string | bigint) =>
    formatMoney(typeof value === 'bigint' ? toDecimalString(value, 4n) : value, loan.currency, locale);
  const pct = (value: string | null) => (value ? `${Number(value).toString()}%` : '—');
  const commissionOnItsOwn = !treatment.deducted && !treatment.spread && Number(loan.commissionTxn) > 0;
  // Master names are held in English; Arabic reads the seeded code's
  // translation, as the page does (a code the catalogue does not know keeps
  // its English name).
  const SEEDED_TREATMENTS = ['deducted_at_disbursement', 'paid_separately', 'spread_over_instalments'];
  const treatmentName = locale !== 'en' && SEEDED_TREATMENTS.includes(treatment.code) ? t(`tr.${treatment.code}`) : treatment.name;
  const fields: Fact[] = [
    { label: t('col_no'), value: loan.loanNo, ltr: true },
    { label: t('col_status'), value: t(`status_${loan.status}`) },
    {
      label: t('bank'),
      value: found.bank ? `${found.bank.name}${found.bank.swiftBic ? ` · ${found.bank.swiftBic}` : ''}` : loan.bankCode,
    },
    { label: t('account'), value: `${found.account.code} · ${found.account.name}` },
    { label: t('principal'), value: money(loan.principalTxn), ltr: true },
    { label: t('commission'), value: `${pct(loan.commissionPct)} · ${money(loan.commissionTxn)} · ${treatmentName}` },
    { label: t('net_proceeds'), value: money(loan.netProceedsTxn), ltr: true },
    { label: t('commission_booked'), value: loan.commissionCapitalised ? t('capitalised_yes') : t('capitalised_no') },
    { label: t('interest'), value: pct(loan.interestPctPa) },
    { label: t('allocation_method'), value: t(`method_${loan.allocationMethod}`) },
    { label: t('frequency'), value: `${t(`freq_${loan.frequency}`)} · ${loan.instalmentCount}` },
    { label: t('maturity'), value: day(loan.maturityDate, locale), ltr: true },
    {
      label: t('disbursed'),
      value: loan.disbursementDate ? `${day(loan.disbursementDate, locale)} · ${loan.disbursementReference ?? ''}`.trim() : t('not_yet'),
      ltr: Boolean(loan.disbursementDate),
    },
    ...(commissionOnItsOwn
      ? [
          {
            label: t('commission_paid'),
            value: loan.commissionPaidOn ? `${day(loan.commissionPaidOn, locale)} · ${loan.commissionReference ?? ''}`.trim() : t('not_yet'),
            ltr: Boolean(loan.commissionPaidOn),
          },
        ]
      : []),
    { label: t('entered_by'), value: found.people.createdBy ?? '—' },
    { label: t('approved_by'), value: found.people.approvedBy ?? '—' },
    ...(loan.purpose ? [{ label: t('purpose'), value: loan.purpose }] : []),
    ...(loan.closedReason ? [{ label: t('cancel_reason'), value: loan.closedReason }] : []),
  ];
  const rows = schedule.map((row) => ({
    cells: {
      seq: String(row.sequence),
      due: row.dueDate,
      principal: own.cell(row.principalTxn),
      commission: own.cell(row.commissionTxn),
      interest: own.cell(row.interestTxn),
      total: own.cell(row.totalTxn),
      status: t(`inst_${row.state}`),
      paid: row.paidDate ? `${day(row.paidDate, locale)}${row.paidReference ? ` · ${row.paidReference}` : ''}` : '—',
    },
  }));
  return {
    model: {
      ...base({
        title: m.print('titles.bank_loan'),
        number: loan.loanNo,
        status: t(`status_${loan.status}`),
        posted: loan.status === 'active' || loan.status === 'closed',
        fields,
        tables: [
          {
            title: t('schedule'),
            columns: [
              { key: 'seq', label: '#', kind: 'code' },
              { key: 'due', label: t('due_date'), kind: 'date' },
              { key: 'principal', label: t('principal_part'), kind: own.kind },
              { key: 'commission', label: t('commission_part'), kind: own.kind },
              { key: 'interest', label: t('interest_part'), kind: own.kind },
              { key: 'total', label: t('total'), kind: own.kind },
              { key: 'status', label: t('col_status'), kind: 'text' },
              { key: 'paid', label: t('paid'), kind: 'text', weight: 2 },
            ],
            rows,
            empty: '—',
          },
        ],
        summary: [
          { label: t('outstanding'), value: money(position.outstanding), ltr: true },
          { label: t('repaid'), value: money(position.principalRepaid), ltr: true },
          { label: t('unallocated'), value: money(totals.unallocated), ltr: true },
        ],
        signatures: true,
        orientation: 'landscape',
        fileName: loan.loanNo,
      }),
      currency: own.currency,
    },
    branchCode: loan.branchCode,
    objectId: loan.id,
  };
}
