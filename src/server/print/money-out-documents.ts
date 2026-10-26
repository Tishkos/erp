/**
 * The printed Customer Payment and Expense Payment (0428, 2026-10-26) — the record's own fields, read
 * through the service the page reads, and how it posts: the debit (the customer's receivable, or the
 * expense account) and the credit (the account the money left), in dinars. The amount in words is
 * the payment's own, in its own currency.
 */
import { formatBusinessDate, formatMoney } from '@/i18n/config';
import * as customerPayments from '../services/customer-payment';
import * as expensePayments from '../services/expense-payment';
import type { BuildContext, Built } from './documents';
import type { Column, Fact, Table } from './model';

const COLUMNS = (ctx: BuildContext): Column[] => [
  { key: 'account', label: ctx.m.admin('money_out.line_account'), kind: 'text', weight: 3 },
  { key: 'debit', label: ctx.m.admin('money_out.debit'), kind: 'money' },
  { key: 'credit', label: ctx.m.admin('money_out.credit'), kind: 'money' },
];

function postingTable(ctx: BuildContext, debitLabel: string, creditLabel: string, amountIqd: string): Table {
  return {
    title: ctx.m.admin('money_out.lines_title'),
    columns: COLUMNS(ctx),
    rows: [
      { cells: { account: debitLabel, debit: amountIqd, credit: null } },
      { cells: { account: creditLabel, debit: null, credit: amountIqd } },
    ],
    empty: '—',
    totals: { label: ctx.m.admin('reports.totals'), cells: { debit: amountIqd, credit: amountIqd } },
  };
}

const wordsCurrency = (currency: string): 'IQD' | 'USD' | null => (currency === 'IQD' || currency === 'USD' ? currency : null);

function closing(ctx: BuildContext, row: { readonly status: string; readonly closedByName: string | null; readonly reversalEntryNo: string | null; readonly reversalReason: string | null; readonly cancelReason: string | null }): Fact[] {
  const t = (key: string) => ctx.m.admin(`money_out.${key}`);
  if (row.status === 'reversed') {
    return [
      { label: t('closed_by'), value: row.closedByName ?? '—' },
      { label: t('reversal_journal'), value: row.reversalEntryNo ?? '—', ltr: true },
      { label: t('reason'), value: row.reversalReason ?? '—' },
    ];
  }
  if (row.status === 'cancelled') {
    return [
      { label: t('closed_by'), value: row.closedByName ?? '—' },
      { label: t('reason'), value: row.cancelReason ?? '—' },
    ];
  }
  return [];
}

export async function customerPayment(ctx: BuildContext, paymentNo: string): Promise<Built | null> {
  const row = await customerPayments.viewByNo(ctx.tx, paymentNo);
  if (!row) return null;
  const { m, locale } = ctx;
  const t = (key: string) => m.admin(`money_out.${key}`);
  const fields: Fact[] = [
    { label: m.column('document_no'), value: row.paymentNo, ltr: true },
    { label: m.column('status'), value: m.status(row.status) },
    { label: m.column('customer_code'), value: row.customerCode, ltr: true },
    { label: m.column('customer_name'), value: row.customerName },
    { label: m.column('posting_date'), value: formatBusinessDate(row.paymentDate, locale), ltr: true },
    { label: m.column('bank_code'), value: row.accountCode, ltr: true },
    { label: m.column('bank_name'), value: row.accountName },
    { label: t('amount'), value: formatMoney(row.amount, row.currency, locale), ltr: true },
    ...(row.currency === 'IQD' ? [] : [{ label: t('amount_iqd'), value: formatMoney(row.amountIqd, 'IQD', locale), ltr: true }]),
    { label: t('purpose'), value: row.purpose },
    { label: t('payment_method'), value: row.paymentMethodCode ?? t('payment_method_none') },
    { label: t('reference'), value: row.reference ?? '—' },
    { label: t('written_by'), value: row.createdByName },
    { label: t('approved_by'), value: row.approvedByName ?? '—' },
    { label: t('posted_by'), value: row.postedByName ?? '—' },
    { label: t('journal'), value: row.journalEntryNo ?? '—', ltr: true },
    ...closing(ctx, row),
  ];
  const currency = wordsCurrency(row.currency);
  return {
    model: {
      kind: 'document',
      title: m.print('titles.customer_payment'),
      number: row.paymentNo,
      status: m.status(row.status),
      posted: row.journalEntryNo !== null,
      orientation: 'portrait',
      fields,
      filters: [],
      tables: [
        postingTable(
          ctx,
          m.admin('money_out.dr_customer', { customer: `${row.customerCode} · ${row.customerName}` }),
          m.admin('money_out.cr_account', { account: `${row.accountCode} · ${row.accountName}` }),
          row.amountIqd,
        ),
      ],
      summary: [],
      signatures: true,
      amountInWords: currency ? { amount: row.amount, currency } : { amount: row.amountIqd, currency: 'IQD' },
      currency: 'IQD',
      fileName: row.paymentNo,
      sheetName: row.paymentNo,
    },
    branchCode: row.branchCode,
    objectId: row.id,
  };
}

export async function expensePayment(ctx: BuildContext, paymentNo: string): Promise<Built | null> {
  const row = await expensePayments.viewByNo(ctx.tx, paymentNo);
  if (!row) return null;
  const { m, locale } = ctx;
  const t = (key: string) => m.admin(`money_out.${key}`);
  const fields: Fact[] = [
    { label: m.column('document_no'), value: row.paymentNo, ltr: true },
    { label: m.column('status'), value: m.status(row.status) },
    { label: t('payee'), value: row.payee },
    { label: t('expense_account'), value: `${row.expenseAccountCode} · ${row.expenseAccountName}` },
    { label: m.column('posting_date'), value: formatBusinessDate(row.paymentDate, locale), ltr: true },
    { label: m.column('bank_code'), value: row.accountCode, ltr: true },
    { label: m.column('bank_name'), value: row.accountName },
    { label: t('amount'), value: formatMoney(row.amount, row.currency, locale), ltr: true },
    ...(row.currency === 'IQD' ? [] : [{ label: t('amount_iqd'), value: formatMoney(row.amountIqd, 'IQD', locale), ltr: true }]),
    { label: t('purpose'), value: row.purpose },
    { label: t('department'), value: row.departmentCode ?? '—', ltr: true },
    { label: t('business_line'), value: row.businessLineCode ?? '—', ltr: true },
    { label: t('payment_method'), value: row.paymentMethodCode ?? t('payment_method_none') },
    { label: t('reference'), value: row.reference ?? '—' },
    { label: t('written_by'), value: row.createdByName },
    { label: t('approved_by'), value: row.approvedByName ?? '—' },
    { label: t('posted_by'), value: row.postedByName ?? '—' },
    { label: t('journal'), value: row.journalEntryNo ?? '—', ltr: true },
    ...closing(ctx, row),
  ];
  const currency = wordsCurrency(row.currency);
  return {
    model: {
      kind: 'document',
      title: m.print('titles.expense_payment'),
      number: row.paymentNo,
      status: m.status(row.status),
      posted: row.journalEntryNo !== null,
      orientation: 'portrait',
      fields,
      filters: [],
      tables: [
        postingTable(
          ctx,
          m.admin('money_out.dr_expense', { account: `${row.expenseAccountCode} · ${row.expenseAccountName}` }),
          m.admin('money_out.cr_account', { account: `${row.accountCode} · ${row.accountName}` }),
          row.amountIqd,
        ),
      ],
      summary: [],
      signatures: true,
      amountInWords: currency ? { amount: row.amount, currency } : { amount: row.amountIqd, currency: 'IQD' },
      currency: 'IQD',
      fileName: row.paymentNo,
      sheetName: row.paymentNo,
    },
    branchCode: row.branchCode,
    objectId: row.id,
  };
}
