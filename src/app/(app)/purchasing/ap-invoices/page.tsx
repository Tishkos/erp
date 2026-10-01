import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, ListToolbar, admin as s, matches } from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as ap from '@/server/services/ap-invoice';

/**
 * Purchase Invoices — Operations build, block 4.
 *
 *   Header   Invoice Number (automatically generated); Posting Date; Due Date;
 *            Supplier Code; Supplier Name.
 *
 * The register shows those five and what the invoice came to, which is the
 * column a person actually scans for. The supplier's name is joined from the
 * partner rather than copied onto the invoice, so a supplier renamed this year
 * reads correctly on an invoice raised last year.
 */
export const dynamic = 'force-dynamic';

export default async function ApInvoicesPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/purchasing/ap-invoices')) notFound();

  const [t, page, column, status, locale, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getTranslations('status'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);

  const { principal } = context;
  if (!can(principal, 'view', ap.PERMISSION_OBJECT)) {
    return <Denied object={page('ap_invoices')} />;
  }
  const mayCreate = can(principal, 'create', ap.PERMISSION_OBJECT);

  const rows = await withCurrentUser((tx) => ap.list(tx));
  const shown = rows.filter((row) => matches(row, outcome.q));

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <Link className="action action--primary" href="/purchasing/ap-invoices/new">
            {t('ap_invoices.new')}
          </Link>
        ) : null
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/purchasing/ap-invoices" />}
      subtitle={t('ap_invoices.subtitle')}
      title={t('ap_invoices.title')}
      variant="sap"
    >
      <Flash
        error={outcome.error}
        errorTitle={t('error_title')}
        saved={outcome.saved}
        savedLabel={t('saved')}
      />

      <section aria-labelledby="ap-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="ap-list-title">
            <span>{t('ap_invoices.title')}</span>
            <span className={s.sapTitleMeta}>{t('rows_shown', { count: shown.length })}</span>
          </h2>

          <ListToolbar
            clearHref="/purchasing/ap-invoices"
            clearLabel={t('clear_search')}
            countLabel={t('rows_shown', { count: shown.length })}
            placeholder={t('search_placeholder')}
            q={outcome.q}
            searchLabel={t('search')}
          />

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="ap-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{column('reference')}</th>
                  <th scope="col">{column('posting_date')}</th>
                  <th scope="col">{column('due_date')}</th>
                  <th scope="col">{column('supplier_code')}</th>
                  <th scope="col">{column('supplier_name')}</th>
                  <th className={s.sapNum} scope="col">
                    {column('amount')}
                  </th>
                  <th scope="col">{column('status')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={7}>
                      {t('ap_invoices.none')}
                    </td>
                  </tr>
                ) : null}
                {shown.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link
                        className={s.sapLink}
                        href={`/purchasing/ap-invoices/${encodeURIComponent(row.invoiceNo)}`}
                      >
                        <bdi dir="ltr">{row.invoiceNo}</bdi>
                      </Link>
                    </td>
                    <td>
                      <bdi dir="ltr">{formatBusinessDate(row.invoiceDate, locale as Locale)}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{formatBusinessDate(row.dueDate, locale as Locale)}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.supplierCode ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.supplierName ?? '—'}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{formatMoney(row.totalIqd, 'IQD', locale as Locale)}</bdi>
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
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </AdminPage>
  );
}
