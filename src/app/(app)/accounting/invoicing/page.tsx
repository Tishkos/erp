import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { Plus } from 'lucide-react';
import { Panel } from '@/components/ui';
import { AdminPage, Flash, ListToolbar, admin as s, matches } from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { requireContext, withCurrentUser } from '@/server/session';
import * as departments from '@/server/services/departments';
import * as invoicing from '@/server/services/invoicing';
import { startInvoice } from './actions';

/**
 * Invoicing — Phase 0's document.
 *
 * The list a person may see is the one their branch scope allows (the
 * database decides that, not this page), and what they may do with a row is
 * decided on the record itself.
 */
export const dynamic = 'force-dynamic';

export default async function InvoicingPage({ searchParams }: { searchParams: SearchParams }) {
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
  if (!can(principal, 'view', invoicing.PERMISSION_OBJECT)) {
    return <Denied object={page('invoicing')} />;
  }
  const mayCreate = can(principal, 'create', invoicing.PERMISSION_OBJECT);

  const { rows, hasDepartment } = await withCurrentUser(async (tx) => ({
    rows: await invoicing.listAll(tx, principal),
    hasDepartment: (await departments.listAll(tx)).some((d) => d.active),
  }));
  const shown = rows.filter((row) => matches(row, outcome.q));

  return (
    <AdminPage
      actions={
        // Always there for somebody who may raise one. If there is nowhere to
        // send it yet the refusal says so — a button that is simply absent
        // teaches nobody anything.
        mayCreate ? (
          <form action={startInvoice}>
            <button className={`${s.button} ${s.primary}`} type="submit">
              <Plus aria-hidden="true" />
              <span>{t('invoicing.new')}</span>
            </button>
          </form>
        ) : null
      }
      back={{ href: '/', label: t('dashboard_label') }}
      subtitle={t('invoicing.subtitle')}
      title={t('invoicing.title')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />
      {mayCreate && !hasDepartment ? (
        <p className={s.sectionHint}>{t('invoicing.no_department')}</p>
      ) : null}

      <Panel flush>
        <ListToolbar
          clearHref="/accounting/invoicing"
          clearLabel={t('clear_search')}
          countLabel={t('rows_shown', { count: shown.length })}
          placeholder={t('search_placeholder')}
          q={outcome.q}
          searchLabel={t('search')}
        />
        <div className="table-wrap" style={{ border: 0 }}>
          <table className="list">
            <thead>
              <tr>
                <th scope="col">{column('reference')}</th>
                <th scope="col">{t('invoicing.customer')}</th>
                <th className="numeric" scope="col">
                  {column('amount')}
                </th>
                <th scope="col">{column('document_date')}</th>
                <th scope="col">{column('department')}</th>
                <th scope="col">{t('invoicing.raised_by')}</th>
                <th scope="col">{column('status')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <tr key={row.id}>
                  <td>
                    <Link href={`/accounting/invoicing/${encodeURIComponent(row.documentNo)}`}>
                      {row.documentNo}
                    </Link>
                  </td>
                  <td>{row.customerName || <span className="muted">{t('invoicing.untitled')}</span>}</td>
                  <td className="numeric">{formatMoney(row.amount, row.currency, locale as Locale)}</td>
                  <td>{formatBusinessDate(row.documentDate, locale as Locale)}</td>
                  <td>{row.departmentCode}</td>
                  <td>{row.raisedBy ?? '—'}</td>
                  <td>
                    <span className={`status status--${row.status}`}>{status(row.status)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </AdminPage>
  );
}
