import { getLocale, getTranslations } from 'next-intl/server';
import { Panel, Pagination, SearchBox } from '@/components/ui';
import { AdminPage, Pill, admin } from '@/components/admin';
import { SectionTabs } from '@/components/admin/section-tabs';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatTimestamp, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { registerAllLists } from '@/server/lists';
import { rows } from '@/server/services/list';
import { requireContext, withCurrentUser } from '@/server/session';

/**
 * Audit Trail — Phase 0 requirement 10, company-wide.
 *
 * Read through the list framework so the rows are exactly what the caller's
 * scope allows (RLS), searched and paged the same way every other list is.
 */
export const dynamic = 'force-dynamic';

export default async function AuditPage({ searchParams }: { searchParams: SearchParams }) {
  registerAllLists();
  const [t, page, column, list, locale, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getTranslations('list'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  if (!can(context.principal, 'view', 'audit_event')) {
    return <Denied object={page('audit_trail')} />;
  }

  const result = await withCurrentUser((tx, ctx) =>
    rows(tx, ctx.principal, 'audit_event', {
      ...(outcome.q ? { search: outcome.q } : {}),
      page: outcome.page,
      pageSize: 50,
    }),
  );
  const pages = Math.max(1, Math.ceil((result.total ?? 0) / result.query.pageSize));
  const hrefFor = (p: number) => `/administration/audit?${outcome.q ? `q=${encodeURIComponent(outcome.q)}&` : ''}page=${p}`;

  return (
    <AdminPage tabs={<SectionTabs route="/administration/audit" />} back={{ href: '/', label: t('dashboard_label') }} subtitle={t('audit.subtitle')} title={t('audit.title')} variant="sap">
      <Panel
        actions={<SearchBox defaultValue={outcome.q} label={list('search')} placeholder={t('audit.search_placeholder')} />}
        flush
      >
        {result.rows.length === 0 ? (
          <p className="muted" style={{ padding: '1rem' }}>
            {list('no_rows')}
          </p>
        ) : (
          <div className="table-wrap">
            <table className="list">
              <thead>
                <tr>
                  <th scope="col">{column('occurred_at')}</th>
                  <th scope="col">{column('action')}</th>
                  <th scope="col">{column('object_type')}</th>
                  <th scope="col">{column('object_id')}</th>
                  <th scope="col">{column('actor')}</th>
                  <th scope="col">{column('branch_code')}</th>
                  <th scope="col">{column('outcome')}</th>
                  <th scope="col">{column('reason')}</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row, index) => (
                  <tr key={`${String(row.occurred_at)}-${index}`}>
                    <td>{formatTimestamp(String(row.occurred_at), locale as Locale)}</td>
                    <td>
                      <span className={admin.mono}>{String(row.action)}</span>
                    </td>
                    <td>{String(row.object_type)}</td>
                    <td>
                      <span className={admin.mono}>{row.object_id ? String(row.object_id) : '—'}</span>
                    </td>
                    <td>{row.actor ? String(row.actor) : '—'}</td>
                    <td>{row.branch_code ? String(row.branch_code) : '—'}</td>
                    <td>
                      <Pill label={String(row.outcome)} on={row.outcome === 'success' ? true : false} />
                    </td>
                    <td>{row.reason ? String(row.reason) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ padding: '0.75rem' }}>
          <p className="muted" style={{ margin: '0 0 0.5rem', fontSize: '0.8125rem' }}>
            {list('row_count', { count: result.total ?? result.rows.length })}
          </p>
          {pages > 1 ? (
            <Pagination
              count={pages}
              current={outcome.page}
              hrefFor={hrefFor}
              labels={{
                label: t('pagination'),
                previous: t('previous'),
                next: t('next'),
                page: (p) => t('page_n', { page: p }),
              }}
              locale={locale}
            />
          ) : null}
        </div>
      </Panel>
    </AdminPage>
  );
}
