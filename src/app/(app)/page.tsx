import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, admin as s } from '@/components/admin';
import { Band, BandTable, Figure, Figures } from '@/components/admin/dashboard-band';
import { documentHref } from '@/components/admin/document-link';
import { formatBusinessDate, formatMoney, formatTimestamp, type Locale } from '@/i18n/config';
import { registerAllLists } from '@/server/lists';
import * as dashboard from '@/server/services/dashboard';
import { optionalContext, withCurrentUser } from '@/server/session';

/**
 * The Dashboard — REQ-DASH-001.
 *
 * It answers one question, in this order: what is waiting for me, where does
 * the money stand, and what is wrong. It is not a report — every figure on it
 * belongs to a screen that has filters, a period and a Print / Export menu, and
 * each figure links to that screen. The dashboard's job is to send you there,
 * not to be a smaller version of it.
 *
 * **There is no one dashboard.** Each band asks the same permission object its
 * own screen asks, so the page composes itself out of what the signed-in person
 * may already see: the CEO gets the audit trail and the result for the year,
 * the Accounting Officer gets neither, and neither of them was configured —
 * both fall out of the grants. That also means the page can never leak: a band
 * is not rendered, rather than rendered and refused.
 *
 * A band with nothing in it is not drawn at all. A heading over an empty box is
 * a promise the screen does not keep, and people learn to scroll past it.
 *
 * The redirect is the one thing the blank version of this page did that
 * mattered: an unauthenticated visitor reaches the sign-in form, not a screen.
 */
export const dynamic = 'force-dynamic';

export default async function Home() {
  const context = await optionalContext();
  if (!context) redirect('/sign-in');

  const [t, column, locale] = await Promise.all([
    getTranslations('admin'),
    getTranslations('column'),
    getLocale(),
  ]);

  registerAllLists();
  const view = await withCurrentUser((tx, request) =>
    dashboard.forPrincipal(tx, request.principal, request.scope.branchCode),
  );

  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);
  const day = (value: string) => formatBusinessDate(value, locale as Locale);
  // Named one by one rather than derived from the bucket's own string: '90+'
  // is not a message key, and `replace` on it produces one that silently does
  // not exist.
  const BUCKET_KEY: Record<string, string> = {
    current: 'bucket_current',
    '1-30': 'bucket_1_30',
    '31-60': 'bucket_31_60',
    '61-90': 'bucket_61_90',
    '90+': 'bucket_over_90',
  };
  const bucketName = (bucket: string) => t(`dashboard.${BUCKET_KEY[bucket] ?? 'bucket_current'}`);

  // Said once, at the top: every figure below is this branch, as at this day.
  // A figure whose scope is unstated is a figure nobody can reconcile.
  const subtitle = t('dashboard.as_at', { branch: view.branchCode, date: day(view.asOf) });

  const unreadable = (name: string) => (
    <p className={s.sectionHint} key={name}>
      {t('dashboard.unreadable', { band: name })}
    </p>
  );

  const waiting = view.waiting;
  const attention = view.attention;
  const showAttention = attention !== null && dashboard.hasAttention(attention);

  return (
    <AdminPage subtitle={subtitle} title={t('dashboard.title')} variant="sap">
      {waiting === null ? unreadable(t('dashboard.waiting')) : null}

      {waiting && (waiting.approvals.length > 0 || waiting.unreadNotifications > 0) ? (
        <Band
          count={waiting.approvals.length}
          href="/approvals"
          hrefLabel={t('dashboard.open_approvals')}
          title={t('dashboard.waiting')}
        >
          {waiting.unreadNotifications > 0 ? (
            <Figures>
              <Figure
                label={t('dashboard.unread_notifications')}
                value={waiting.unreadNotifications}
              />
            </Figures>
          ) : null}

          {waiting.approvals.length > 0 ? (
            <BandTable
              headings={[column('document_type'), column('raised_by'), t('dashboard.waiting_since')]}
            >
              {waiting.approvals.map((item) => {
                const href = documentHref(item.documentTypeCode, item.documentId);
                const label = item.documentTypeCode.replace(/_/g, ' ');
                return (
                  <tr key={`${item.documentTypeCode}:${item.documentId}`}>
                    <td className={s.sapAccountCell}>
                      {href ? <Link href={href}>{label}</Link> : label}
                    </td>
                    <td>
                      <bdi dir="auto">{item.submittedByName ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">
                        {formatTimestamp(item.submittedAt.toISOString(), locale as Locale)}
                      </bdi>
                    </td>
                  </tr>
                );
              })}
            </BandTable>
          ) : null}
        </Band>
      ) : null}

      {view.result ? (
        <Band
          href="/finance/income-statement"
          hrefLabel={t('dashboard.open_statement')}
          title={t('dashboard.result', { from: day(view.result.from), to: day(view.result.to) })}
        >
          <Figures>
            <Figure
              href="/finance/income-statement"
              label={t('dashboard.income')}
              value={money(view.result.income)}
            />
            <Figure
              href="/finance/income-statement"
              label={t('dashboard.expenses')}
              value={money(view.result.expenses)}
            />
            <Figure
              href="/finance/income-statement"
              label={t('dashboard.net_result')}
              value={money(view.result.result)}
            />
          </Figures>
        </Band>
      ) : null}

      {view.balances && view.balances.length > 0 ? (
        <Band
          count={view.balances.length}
          href="/master-data/bank-accounts"
          hrefLabel={t('dashboard.open_accounts')}
          title={t('dashboard.cash_position')}
        >
          <Figures>
            {view.balances.map((account) => (
              <Figure
                href={
                  account.kind === 'bank'
                    ? `/master-data/bank-accounts/${encodeURIComponent(account.code)}`
                    : `/master-data/cash-accounts/${encodeURIComponent(account.code)}`
                }
                key={account.code}
                label={account.name}
                value={money(account.balanceIqd)}
              />
            ))}
          </Figures>
        </Band>
      ) : null}

      {view.receivable && view.receivable.invoices > 0 ? (
        <Band
          count={view.receivable.invoices}
          href="/sales/ar-invoices"
          hrefLabel={t('dashboard.open_invoices')}
          title={t('dashboard.receivable')}
        >
          <Figures>
            <Figure label={t('dashboard.total_open')} value={money(view.receivable.totalIqd)} />
            {view.receivable.buckets.map((row) => (
              <Figure
                key={row.bucket}
                label={bucketName(row.bucket)}
                tone={row.bucket === 'current' ? undefined : 'warn'}
                value={money(row.amountIqd)}
              />
            ))}
          </Figures>
        </Band>
      ) : null}

      {view.payable && view.payable.invoices > 0 ? (
        <Band
          count={view.payable.invoices}
          href="/purchasing/ap-invoices"
          hrefLabel={t('dashboard.open_invoices')}
          title={t('dashboard.payable')}
        >
          <Figures>
            <Figure label={t('dashboard.total_open')} value={money(view.payable.totalIqd)} />
            {view.payable.buckets.map((row) => (
              <Figure
                key={row.bucket}
                label={bucketName(row.bucket)}
                tone={row.bucket === 'current' ? undefined : 'warn'}
                value={money(row.amountIqd)}
              />
            ))}
          </Figures>
        </Band>
      ) : null}

      {showAttention ? (
        <Band title={t('dashboard.attention')}>
          <BandTable headings={[t('dashboard.finding'), t('dashboard.where_fixed')]}>
            {attention.integrityFindings.map((finding) => (
              <tr key={finding}>
                <td>{finding}</td>
                <td className={s.sapAccountCell}>
                  <Link href="/inventory/stock-ledger">{t('dashboard.stock_ledger')}</Link>
                </td>
              </tr>
            ))}
            {attention.unidentifiedReceipts > 0 ? (
              <tr>
                <td>
                  {t('dashboard.unidentified_receipts', { count: attention.unidentifiedReceipts })}
                </td>
                <td className={s.sapAccountCell}>
                  <Link href="/sales/customer-receipts">{t('dashboard.receipts')}</Link>
                </td>
              </tr>
            ) : null}
            {attention.accountsWithoutLedger.map((code) => (
              <tr key={code}>
                <td>{t('dashboard.account_without_ledger', { code })}</td>
                <td className={s.sapAccountCell}>
                  <Link href="/master-data/bank-accounts">{t('dashboard.bank_accounts')}</Link>
                </td>
              </tr>
            ))}
          </BandTable>
        </Band>
      ) : null}

      {view.activity && view.activity.length > 0 ? (
        <Band
          href="/administration/audit"
          hrefLabel={t('dashboard.open_audit')}
          title={t('dashboard.activity')}
        >
          <BandTable
            headings={[column('date'), t('dashboard.event'), column('raised_by'), column('status')]}
          >
            {view.activity.map((event, index) => (
              <tr key={`${event.occurredAt}-${index}`}>
                <td>
                  <bdi dir="ltr">{formatTimestamp(event.occurredAt, locale as Locale)}</bdi>
                </td>
                <td>{event.action.replace(/[._]/g, ' ')}</td>
                <td>
                  <bdi dir="auto">{event.actor}</bdi>
                </td>
                <td>{event.outcome}</td>
              </tr>
            ))}
          </BandTable>
        </Band>
      ) : null}
    </AdminPage>
  );
}
