/**
 * The matching workspace — bank reconciliation and its relatives.
 *
 * Six screens in the tree are not a table with a detail panel beside it. They
 * are two populations that must be brought into agreement: statement lines
 * against ledger entries, a counted quantity against a recorded one, an invoice
 * against its order and receipt. What the reader does there is pick from both
 * sides and assert they are the same thing.
 *
 * So the shape leads with the number that says whether the work is finished —
 * the difference — and puts the two populations side by side beneath it. A
 * reconciliation screen whose difference is not on screen is not a
 * reconciliation screen.
 */
import { getLocale, getTranslations } from 'next-intl/server';
import {
  ArrowLeftRight,
  CheckCircle2,
  CircleAlert,
  Inbox,
  Sparkles,
} from 'lucide-react';
import type { ScreenRoute } from '@domain/screens';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { sampleEntityRows } from '@/sample/generate';
import {
  Button,
  DataTable,
  EmptyState,
  Panel,
  StatusPill,
  type TableColumn,
  type TableRow,
} from '@/components/ui';
import styles from './matching.module.css';

/** Screens whose work is reconciling two populations rather than listing one. */
export const MATCHING_SCREENS: ReadonlySet<string> = new Set([
  'bank_reconciliation',
  'match_exceptions',
  'stock_reconciliation',
  'soft_close',
  'year_end_close',
  'ar_reconciliation',
  'ap_reconciliation',
  'transfer_reconciliation',
  'investment_reconciliation',
  'asset_verification',
]);

export async function MatchingShape({ screen }: { readonly screen: ScreenRoute }) {
  const [locale, t, column, status] = await Promise.all([
    getLocale(),
    getTranslations('screen'),
    getTranslations('column'),
    getTranslations('status'),
  ]);

  const key = screen.item.key;
  const money = (value: number) => formatMoney(value, 'IQD', locale as Locale);

  const left = sampleEntityRows(`${key}:statement`, 'ledger', 6);
  const right = sampleEntityRows(`${key}:ledger`, 'ledger', 5);

  const sum = (rows: readonly Record<string, unknown>[]) =>
    rows.reduce((total, row) => total + Number(row.debit) + Number(row.credit), 0);
  const leftTotal = sum(left);
  const rightTotal = sum(right);
  const difference = leftTotal - rightTotal;
  const reconciled = difference === 0;

  const columns: readonly TableColumn[] = [
    { key: 'entry_no', label: column('entry_no') },
    { key: 'posting_date', label: column('posting_date') },
    { key: 'amount', label: column('amount'), numeric: true },
  ];

  const toRows = (rows: readonly Record<string, unknown>[]): readonly TableRow[] =>
    rows.map((row, index) => ({
      id: String(row.id ?? index),
      cells: {
        entry_no: <bdi dir="ltr">{String(row.entry_no)}</bdi>,
        posting_date: (
          <bdi dir="auto">{formatBusinessDate(String(row.posting_date), locale as Locale)}</bdi>
        ),
        amount: (
          <bdi dir="ltr">{money(Number(row.debit) + Number(row.credit))}</bdi>
        ),
      },
    }));

  return (
    <>
      {/* The number the whole screen exists to drive to zero. */}
      <section aria-label={t('difference')} className={styles.balanceStrip}>
        <article className={styles.balanceCard}>
          <h2>{t('statement_side')}</h2>
          <p>
            <bdi dir="ltr">{money(leftTotal)}</bdi>
          </p>
        </article>
        <article className={styles.balanceCard}>
          <h2>{t('ledger_side')}</h2>
          <p>
            <bdi dir="ltr">{money(rightTotal)}</bdi>
          </p>
        </article>
        <article
          className={`${styles.balanceCard} ${reconciled ? styles.settled : styles.outstanding}`}
        >
          <h2>{t('difference')}</h2>
          <p>
            <bdi dir="ltr">{money(Math.abs(difference))}</bdi>
          </p>
          <span className={styles.verdict}>
            {reconciled ? (
              <CheckCircle2 aria-hidden="true" />
            ) : (
              <CircleAlert aria-hidden="true" />
            )}
            {reconciled ? t('reconciled') : t('not_reconciled')}
          </span>
        </article>
        <article className={styles.balanceActions}>
          <Button icon={Sparkles} label={t('auto_match')} />
          <Button icon={ArrowLeftRight} label={t('match_selected')} tone="primary" />
        </article>
      </section>

      <div className={styles.panes}>
        <Panel
          flush
          icon={Inbox}
          title={`${t('statement_side')} · ${t('unmatched')}`}
        >
          {left.length === 0 ? (
            <EmptyState
              hint={t('nothing_unmatched_hint')}
              icon={CheckCircle2}
              title={t('nothing_unmatched')}
            />
          ) : (
            <DataTable caption={t('statement_side')} columns={columns} rows={toRows(left)} />
          )}
        </Panel>

        <Panel flush icon={Inbox} title={`${t('ledger_side')} · ${t('unmatched')}`}>
          {right.length === 0 ? (
            <EmptyState
              hint={t('nothing_unmatched_hint')}
              icon={CheckCircle2}
              title={t('nothing_unmatched')}
            />
          ) : (
            <DataTable caption={t('ledger_side')} columns={columns} rows={toRows(right)} />
          )}
        </Panel>
      </div>

      <Panel icon={CheckCircle2} title={t('matched')}>
        <ul className={styles.matchedList}>
          {sampleEntityRows(`${key}:matched`, 'document', 4).map((row, index) => (
            <li key={String(row.id ?? index)}>
              <bdi dir="ltr">{String(row.reference)}</bdi>
              <span>{String(row.description)}</span>
              <bdi dir="ltr">{money(Number(row.amount))}</bdi>
              <StatusPill label={status(String(row.status))} status={String(row.status)} />
            </li>
          ))}
        </ul>
      </Panel>
    </>
  );
}
