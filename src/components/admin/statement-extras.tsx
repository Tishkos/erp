import { getLocale, getTranslations } from 'next-intl/server';
import { admin as s } from './index';
import { ReportWindow } from './report-filter';
import { ProfileLink } from './profile-link';
import { formatBusinessDate, formatQuantity, formatStatementAmount, type Locale } from '@/i18n/config';
import type { LegacyHistory } from '@/server/domain/legacy-history';
import type { ImportsTotal } from '@/server/domain/statement-imports';
import type { SupplierImportRow } from '@/server/services/payment-applications';

/**
 * Two windows stacked under a partner's statement (2026-10-14, by direction:
 * "the customer not created with their own statements … suppliers we bought
 * things from them"): what the old books hold for the account, and — for a
 * supplier — the import applications with what each agreed, what the bank
 * holds and what is paid. Neither is a posting.
 *
 * Both show every currency, each amount in its own, whatever the statement is
 * run in (the second pass, the same day: the dollar imports were behind a link
 * on a statement that opens in dinars, and read as "still didn't show"). A
 * Currency column appears when there is more than one; the totals are one row
 * per currency, never added across.
 */

const SHOWN_ITEMS = 3;

export async function OldBooksWindow({ history }: { readonly history: LegacyHistory }) {
  const [t, statementT, column, locale] = await Promise.all([
    getTranslations('admin.statement_extras'),
    getTranslations('admin.partners'),
    getTranslations('column'),
    getLocale(),
  ]);
  if (history.rows.length === 0) return null;
  const money = (amount: string, currency: string) => formatStatementAmount(amount, currency, locale as Locale);
  const single = history.totals.length === 1 ? history.totals[0]!.currency : null;
  const suffix = single ? ` · ${single}` : '';

  return (
    <ReportWindow
      foot={
        <div className={s.sapFootTotals}>
          {history.totals.map((total) => (
            <div className={s.sapFootTotal} key={total.currency}>
              <span>{single ? t('net') : `${t('net')} · ${total.currency}`}</span>
              <strong>
                <bdi dir="ltr">{money(total.net, total.currency)}</bdi>
              </strong>
            </div>
          ))}
        </div>
      }
      meta={t('history_meta', { count: history.rows.length })}
      title={t('history_title')}
    >
      <table className={`${s.sapTable} ${s.sapReportTable}`} data-old-books>
        <thead>
          <tr>
            <th scope="col">{t('col_date')}</th>
            <th scope="col">{t('col_no')}</th>
            <th scope="col">{t('col_kind')}</th>
            <th scope="col">{t('col_items')}</th>
            {single ? null : <th scope="col">{column('currency')}</th>}
            <th className={s.sapNum} scope="col">{`${statementT('statement_debit')}${suffix}`}</th>
            <th className={s.sapNum} scope="col">{`${statementT('statement_credit')}${suffix}`}</th>
          </tr>
        </thead>
        <tbody>
          {history.rows.map((row) => (
            <tr key={`${row.kind}-${row.legacyNo}-${row.currency}`}>
              <td>
                {row.date ? <bdi dir="ltr">{formatBusinessDate(row.date, locale as Locale)}</bdi> : <span className="muted">{t('no_date')}</span>}
              </td>
              <td>
                <bdi dir="ltr">{row.legacyNo}</bdi>
              </td>
              <td>{t(`kind_${row.kind}`)}</td>
              <td>
                {row.items.length === 0
                  ? '—'
                  : row.items.slice(0, SHOWN_ITEMS).map((item, index) => (
                      <span key={index}>
                        {index > 0 ? (locale === 'ar' ? '، ' : ', ') : null}
                        <bdi dir="auto">{item.name}</bdi>
                        {item.quantity ? (
                          <span className="muted">
                            {' × '}
                            <bdi dir="ltr">{formatQuantity(item.quantity, locale as Locale)}</bdi>
                            {item.unit ? ` ${item.unit}` : ''}
                          </span>
                        ) : null}
                      </span>
                    ))}
                {row.items.length > SHOWN_ITEMS ? (
                  <span className="muted"> {t('items_more', { count: row.items.length - SHOWN_ITEMS })}</span>
                ) : null}
              </td>
              {single ? null : (
                <td>
                  <bdi dir="ltr">{row.currency}</bdi>
                </td>
              )}
              <td className={s.sapNum}>
                <bdi dir="ltr">{Number(row.debit) === 0 ? '' : money(row.debit, row.currency)}</bdi>
              </td>
              <td className={s.sapNum}>
                <bdi dir="ltr">{Number(row.credit) === 0 ? '' : money(row.credit, row.currency)}</bdi>
              </td>
            </tr>
          ))}
          {history.totals.map((total) => (
            <tr data-rule="double" key={`total-${total.currency}`}>
              <td colSpan={4}>{single ? t('total') : `${t('total')} · ${total.currency}`}</td>
              {single ? null : (
                <td>
                  <bdi dir="ltr">{total.currency}</bdi>
                </td>
              )}
              <td className={s.sapNum}>
                <bdi dir="ltr">{money(total.debit, total.currency)}</bdi>
              </td>
              <td className={s.sapNum}>
                <bdi dir="ltr">{money(total.credit, total.currency)}</bdi>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ReportWindow>
  );
}

/** The import applications' table — the statement's window and the supplier profile's panel draw the same rows. */
export async function SupplierImportsTable({
  rows,
  totals,
}: {
  readonly rows: readonly SupplierImportRow[];
  /** One per currency the rows are in. */
  readonly totals: readonly ImportsTotal[];
}) {
  const [t, column, locale] = await Promise.all([
    getTranslations('admin.statement_extras'),
    getTranslations('column'),
    getLocale(),
  ]);
  const money = (amount: string, code: string) => formatStatementAmount(amount, code, locale as Locale);
  const single = totals.length === 1 ? totals[0]!.currency : null;
  const suffix = single ? ` · ${single}` : '';

  return (
    <table className={`${s.sapTable} ${s.sapReportTable}`} data-supplier-imports>
      <thead>
        <tr>
          <th scope="col">{t('col_import')}</th>
          <th scope="col">{t('col_reference')}</th>
          <th scope="col">{t('col_date')}</th>
          <th scope="col">{t('col_stage')}</th>
          {single ? null : <th scope="col">{column('currency')}</th>}
          <th className={s.sapNum} scope="col">{`${t('col_agreed')}${suffix}`}</th>
          <th className={s.sapNum} scope="col">{`${t('col_with_bank')}${suffix}`}</th>
          <th className={s.sapNum} scope="col">{`${t('col_paid')}${suffix}`}</th>
          <th className={s.sapNum} scope="col">{`${t('col_left')}${suffix}`}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.payableNo}>
            <td>
              <ProfileLink code={row.payableNo} kind="import" />
              {row.fromSheet ? <span className="muted"> · {t('from_sheet')}</span> : null}
            </td>
            <td>
              <bdi dir="ltr">{row.reference ?? '—'}</bdi>
            </td>
            <td>{row.documentDate ? <bdi dir="ltr">{formatBusinessDate(row.documentDate, locale as Locale)}</bdi> : '—'}</td>
            <td>
              <bdi dir="auto">{row.stageName}</bdi>
            </td>
            {single ? null : (
              <td>
                <bdi dir="ltr">{row.currency}</bdi>
              </td>
            )}
            <td className={s.sapNum}>
              <bdi dir="ltr">{money(row.agreedTxn, row.currency)}</bdi>
            </td>
            <td className={s.sapNum}>
              <bdi dir="ltr">{Number(row.withBankTxn) === 0 ? '' : money(row.withBankTxn, row.currency)}</bdi>
            </td>
            <td className={s.sapNum}>
              <bdi dir="ltr">{money(row.paidTxn, row.currency)}</bdi>
            </td>
            <td className={s.sapNum}>
              <strong>
                <bdi dir="ltr">{money(row.remainingTxn, row.currency)}</bdi>
              </strong>
            </td>
          </tr>
        ))}
        {totals.map((total) => (
          <tr data-rule="double" key={`total-${total.currency}`}>
            <td colSpan={4}>{single ? t('total') : `${t('total')} · ${total.currency}`}</td>
            {single ? null : (
              <td>
                <bdi dir="ltr">{total.currency}</bdi>
              </td>
            )}
            <td className={s.sapNum}>
              <bdi dir="ltr">{money(total.agreed, total.currency)}</bdi>
            </td>
            <td className={s.sapNum}>
              <bdi dir="ltr">{money(total.withBank, total.currency)}</bdi>
            </td>
            <td className={s.sapNum}>
              <bdi dir="ltr">{money(total.paid, total.currency)}</bdi>
            </td>
            <td className={s.sapNum}>
              <bdi dir="ltr">{money(total.remaining, total.currency)}</bdi>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export async function SupplierImportsWindow({
  rows,
  totals,
}: {
  readonly rows: readonly SupplierImportRow[];
  readonly totals: readonly ImportsTotal[];
}) {
  const t = await getTranslations('admin.statement_extras');
  if (rows.length === 0) return null;
  return (
    <ReportWindow meta={t('imports_meta', { count: rows.length })} title={t('imports_title')}>
      <SupplierImportsTable rows={rows} totals={totals} />
    </ReportWindow>
  );
}
