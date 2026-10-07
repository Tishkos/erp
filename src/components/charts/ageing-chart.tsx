import type { ReactNode } from 'react';
import { getLocale, getTranslations } from 'next-intl/server';
import { Chart } from '@/components/admin/charts';
import { BandTable, NUMERIC_CELL } from '@/components/admin/dashboard-band';
import { Donut } from '@/components/charts/donut';
import { percentText, shareRatio, shortMoney } from '@/components/charts/figures';
import { formatMoney, type Locale } from '@/i18n/config';
import { AGEING_BUCKETS, type AgeingBucket } from '@domain/ageing';
import { BUCKET_STEP, BUCKET_WORD, chartNumber, moneyOf, moneyString } from '@/server/domain/dashboard-charts';

/**
 * What is owed, by how late — the donut Home draws, for the screens that hold
 * the open items themselves: Receivables Ageing, the supplier ageing, a
 * supplier's profile.
 *
 * Handed the very rows the screen lists (each with its bucket and what is
 * still outstanding), it adds them up itself — as scaled bigints, in the
 * ageing's own bucket order — so the picture is the register's and cannot
 * disagree with it. A row with nothing outstanding is not counted; with
 * nothing outstanding at all, nothing is drawn (never a ring of zero).
 *
 * The buckets are an ordered scale, so they wear the validated ordinal ramp:
 * one hue, darker as it gets later. The table under the card says the same
 * figures in words.
 */

export interface AgedRow {
  readonly bucket: AgeingBucket;
  /** A decimal string, in dinars. */
  readonly outstandingIqd: string;
}

const RAMP: Readonly<Record<number, string>> = {
  1: 'var(--chart-ramp-1)',
  2: 'var(--chart-ramp-2)',
  3: 'var(--chart-ramp-3)',
  4: 'var(--chart-ramp-4)',
  5: 'var(--chart-ramp-5)',
};

export async function AgeingChart({
  rows,
  side,
  hint,
  action,
  className,
}: {
  readonly rows: readonly AgedRow[];
  /** Whose money: owed to us (customer) or owed by us (supplier). The title follows. */
  readonly side: 'customer' | 'supplier';
  readonly hint?: string | undefined;
  /** At the end of the title: the screen that holds the rest. */
  readonly action?: ReactNode;
  readonly className?: string | undefined;
}) {
  const totals = new Map<AgeingBucket, { amount: bigint; count: number }>();
  for (const row of rows) {
    const amount = moneyOf(row.outstandingIqd);
    if (amount <= 0n) continue;
    const held = totals.get(row.bucket) ?? { amount: 0n, count: 0 };
    totals.set(row.bucket, { amount: held.amount + amount, count: held.count + 1 });
  }
  const buckets = AGEING_BUCKETS.filter((bucket) => totals.has(bucket)).map((bucket) => ({ bucket, ...totals.get(bucket)! }));
  if (buckets.length === 0) return null;

  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);
  const lang = locale as Locale;
  const whole = buckets.reduce((sum, one) => sum + one.amount, 0n);
  const invoices = buckets.reduce((sum, one) => sum + one.count, 0);
  const total = shortMoney(moneyString(whole), 'IQD', lang);
  const money = (amount: bigint) => formatMoney(moneyString(amount), 'IQD', lang);
  const count = (value: number) => new Intl.NumberFormat(lang).format(value);
  const label = (bucket: AgeingBucket) => t(`admin.dashboard.${BUCKET_WORD[bucket]}`);

  return (
    <Chart
      action={action}
      className={className}
      hint={hint}
      table={
        <BandTable headings={[t('admin.dashboard.bucket'), { label: t('column.document'), numeric: true }, { label: t('admin.dashboard.total_open'), numeric: true }]}>
          {buckets.map((one) => (
            <tr key={one.bucket}>
              <td>{label(one.bucket)}</td>
              <td className={NUMERIC_CELL}>
                <bdi dir="ltr">{count(one.count)}</bdi>
              </td>
              <td className={NUMERIC_CELL}>
                <bdi dir="ltr">{money(one.amount)}</bdi>
              </td>
            </tr>
          ))}
          <tr className="bg-muted font-semibold">
            <td>{t('home.chart.total')}</td>
            <td className={NUMERIC_CELL}>
              <bdi dir="ltr">{count(invoices)}</bdi>
            </td>
            <td className={NUMERIC_CELL}>
              <bdi dir="ltr">{money(whole)}</bdi>
            </td>
          </tr>
        </BandTable>
      }
      tableLabel={t('home.table')}
      title={t(side === 'customer' ? 'home.widget.chart_receivable_ageing.title' : 'home.widget.chart_payable_ageing.title')}
    >
      <Donut
        centreLabel={t('admin.dashboard.total_open')}
        centreNote={t('home.note.open_invoices', { count: invoices })}
        centreTitle={total.shortened ? total.exact : undefined}
        centreValue={total.text}
        parts={buckets.map((one) => ({
          key: one.bucket,
          label: label(one.bucket),
          value: chartNumber(moneyString(one.amount)),
          color: RAMP[BUCKET_STEP[one.bucket]] ?? RAMP[3]!,
          text: money(one.amount),
          share: percentText(shareRatio(one.amount, whole), lang),
          note: t('home.note.open_invoices', { count: one.count }),
        }))}
      />
    </Chart>
  );
}
