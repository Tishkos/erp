import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { admin as s } from './index';
import { ReportWindow } from './report-filter';
import { ProfileLink } from './profile-link';
import { formatBusinessDate, formatQuantity, formatStatementAmount, type Locale } from '@/i18n/config';
import type { LegacyHistory } from '@/server/domain/legacy-history';
import type { ImportsSection } from '@/server/domain/statement-imports';
import type { SupplierImportRow } from '@/server/services/payment-applications';

/**
 * Two windows stacked under a partner's statement (2026-10-14, by direction:
 * "the customer not created with their own statements … suppliers we bought
 * things from them"): what the old books hold for the account, and — for a
 * supplier — the import applications with what each agreed, what the bank
 * holds and what is paid. Neither is a posting; both follow the statement's
 * currency, and offer the other currency's statement where it has rows.
 */

const SHOWN_ITEMS = 3;

function Elsewhere({
  elsewhere,
  hrefFor,
  label,
}: {
  readonly elsewhere: Readonly<Record<string, number>>;
  readonly hrefFor: (currency: string) => string;
  readonly label: (count: number, currency: string) => string;
}) {
  const entries = Object.entries(elsewhere);
  if (entries.length === 0) return null;
  return (
    <>
      {entries.map(([currency, count]) => (
        <Link className={s.sapLink} href={hrefFor(currency)} key={currency}>
          {label(count, currency)}
        </Link>
      ))}
    </>
  );
}

export async function OldBooksWindow({
  history,
  hrefFor,
}: {
  readonly history: LegacyHistory;
  readonly hrefFor: (currency: string) => string;
}) {
  const [t, statementT, locale] = await Promise.all([
    getTranslations('admin.statement_extras'),
    getTranslations('admin.partners'),
    getLocale(),
  ]);
  const money = (amount: string) => formatStatementAmount(amount, history.currency, locale as Locale);
  const elsewhere = Object.keys(history.elsewhere).length > 0;
  if (history.rows.length === 0 && !elsewhere) return null;

  return (
    <ReportWindow
      meta={
        <>
          {t('history_meta', { count: history.rows.length })}{' '}
          <Elsewhere
            elsewhere={history.elsewhere}
            hrefFor={hrefFor}
            label={(count, currency) => t('elsewhere', { count, currency })}
          />
        </>
      }
      title={t('history_title')}
      {...(history.rows.length > 0
        ? {
            foot: (
              <div className={s.sapFootTotals}>
                <div className={s.sapFootTotal}>
                  <span>{t('net')}</span>
                  <strong>
                    <bdi dir="ltr">{money(history.net)}</bdi>
                  </strong>
                </div>
              </div>
            ),
          }
        : {})}
    >
      <table className={`${s.sapTable} ${s.sapReportTable}`} data-old-books>
        <thead>
          <tr>
            <th scope="col">{t('col_date')}</th>
            <th scope="col">{t('col_no')}</th>
            <th scope="col">{t('col_kind')}</th>
            <th scope="col">{t('col_items')}</th>
            <th className={s.sapNum} scope="col">{`${statementT('statement_debit')} · ${history.currency}`}</th>
            <th className={s.sapNum} scope="col">{`${statementT('statement_credit')} · ${history.currency}`}</th>
          </tr>
        </thead>
        <tbody>
          {history.rows.length === 0 ? (
            <tr>
              <td className={s.sapEmptyRow} colSpan={6}>
                {t('history_empty', { currency: history.currency })}
              </td>
            </tr>
          ) : (
            history.rows.map((row) => (
              <tr key={`${row.kind}-${row.legacyNo}`}>
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
                <td className={s.sapNum}>
                  <bdi dir="ltr">{Number(row.debit) === 0 ? '' : money(row.debit)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{Number(row.credit) === 0 ? '' : money(row.credit)}</bdi>
                </td>
              </tr>
            ))
          )}
          {history.rows.length > 0 ? (
            <tr data-rule="double">
              <td colSpan={4}>{t('total')}</td>
              <td className={s.sapNum}>
                <bdi dir="ltr">{money(history.totalDebit)}</bdi>
              </td>
              <td className={s.sapNum}>
                <bdi dir="ltr">{money(history.totalCredit)}</bdi>
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </ReportWindow>
  );
}

/** The import applications' table — the statement's window and the supplier profile's panel draw the same rows. */
export async function SupplierImportsTable({
  rows,
  totals,
  currency,
  showCurrency = false,
}: {
  readonly rows: readonly SupplierImportRow[];
  /** The totals row, in `currency`; none when the rows are in several currencies. */
  readonly totals?: ImportsSection<SupplierImportRow>['totals'];
  readonly currency: string | null;
  readonly showCurrency?: boolean;
}) {
  const [t, column, locale] = await Promise.all([
    getTranslations('admin.statement_extras'),
    getTranslations('column'),
    getLocale(),
  ]);
  const money = (amount: string, code: string) => formatStatementAmount(amount, code, locale as Locale);
  const suffix = currency && !showCurrency ? ` · ${currency}` : '';

  return (
    <table className={`${s.sapTable} ${s.sapReportTable}`} data-supplier-imports>
      <thead>
        <tr>
          <th scope="col">{t('col_import')}</th>
          <th scope="col">{t('col_reference')}</th>
          <th scope="col">{t('col_date')}</th>
          <th scope="col">{t('col_stage')}</th>
          {showCurrency ? <th scope="col">{column('currency')}</th> : null}
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
            {showCurrency ? (
              <td>
                <bdi dir="ltr">{row.currency}</bdi>
              </td>
            ) : null}
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
        {currency && totals && rows.length > 0 ? (
          <tr data-rule="double">
            <td colSpan={showCurrency ? 5 : 4}>{t('total')}</td>
            <td className={s.sapNum}>
              <bdi dir="ltr">{money(totals.agreed, currency)}</bdi>
            </td>
            <td className={s.sapNum}>
              <bdi dir="ltr">{money(totals.withBank, currency)}</bdi>
            </td>
            <td className={s.sapNum}>
              <bdi dir="ltr">{money(totals.paid, currency)}</bdi>
            </td>
            <td className={s.sapNum}>
              <bdi dir="ltr">{money(totals.remaining, currency)}</bdi>
            </td>
          </tr>
        ) : null}
      </tbody>
    </table>
  );
}

export async function SupplierImportsWindow({
  section,
  currency,
  hrefFor,
}: {
  readonly section: ImportsSection<SupplierImportRow>;
  readonly currency: string;
  readonly hrefFor: (currency: string) => string;
}) {
  const t = await getTranslations('admin.statement_extras');
  if (section.rows.length === 0 && Object.keys(section.elsewhere).length === 0) return null;
  return (
    <ReportWindow
      meta={
        <>
          {t('imports_meta', { count: section.rows.length })}{' '}
          <Elsewhere
            elsewhere={section.elsewhere}
            hrefFor={hrefFor}
            label={(count, code) => t('elsewhere', { count, currency: code })}
          />
        </>
      }
      title={t('imports_title')}
    >
      {section.rows.length === 0 ? (
        <table className={`${s.sapTable} ${s.sapReportTable}`}>
          <tbody>
            <tr>
              <td className={s.sapEmptyRow}>{t('imports_empty', { currency })}</td>
            </tr>
          </tbody>
        </table>
      ) : (
        <SupplierImportsTable currency={currency} rows={section.rows} totals={section.totals} />
      )}
    </ReportWindow>
  );
}
