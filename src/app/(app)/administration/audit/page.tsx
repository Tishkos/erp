import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { inArray } from 'drizzle-orm';
import { Panel, Pagination, SearchBox } from '@/components/ui';
import { AdminPage, Pill, admin } from '@/components/admin';
import { SectionTabs } from '@/components/admin/section-tabs';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatTimestamp, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { appUser, chartOfAccount, journalEntry } from '@/server/db/schema';
import { registerAllLists } from '@/server/lists';
import { rows } from '@/server/services/list';
import { requireContext, withCurrentUser } from '@/server/session';

/**
 * Audit Trail — Phase 0 requirement 10, company-wide.
 *
 * Read through the list framework so the rows are exactly what the caller's
 * scope allows (RLS), searched and paged the same way every other list is.
 *
 * Written for a person (by direction, 2026-08-29): an event is named from the
 * catalogue rather than shown as its code, a record kind is a word, and a
 * record is its number — the journal's entry number, the account's code —
 * linked to itself, never a bare id.
 */
export const dynamic = 'force-dynamic';

/** Where a record of each kind lives, addressed by what a person knows. */
const ADDRESSES: Readonly<Record<string, (ref: string) => string>> = {
  journal_entry: (no) => `/finance/journals/${encodeURIComponent(no)}`,
  chart_of_account: (code) => `/master-data/chart-of-accounts/${encodeURIComponent(code)}`,
  app_user: (id) => `/administration/users/${encodeURIComponent(id)}`,
  department: (code) => `/master-data/departments/${encodeURIComponent(code)}`,
  branch: (code) => `/master-data/branches/${encodeURIComponent(code)}`,
  company: () => '/administration/company',
  role: (code) => `/administration/roles/${encodeURIComponent(code)}`,
  number_series: (key) => `/administration/numbering/${encodeURIComponent(key)}`,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function AuditPage({ searchParams }: { searchParams: SearchParams }) {
  registerAllLists();
  const [t, page, column, list, event, locale, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getTranslations('list'),
    getTranslations('audit_action'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  if (!can(context.principal, 'view', 'audit_event')) {
    return <Denied object={page('audit_trail')} />;
  }

  const { result, refs } = await withCurrentUser(async (tx, ctx) => {
    const result = await rows(tx, ctx.principal, 'audit_event', {
      ...(outcome.q ? { search: outcome.q } : {}),
      page: outcome.page,
      pageSize: 50,
    });

    // The ids on this page, turned into the numbers and names people use.
    const idsOf = (type: string) =>
      [...new Set(result.rows.filter((r) => r.object_type === type && UUID.test(String(r.object_id ?? ''))).map((r) => String(r.object_id)))];
    const refs = new Map<string, { label: string; ref: string }>();
    const journalIds = idsOf('journal_entry');
    if (journalIds.length > 0) {
      for (const j of await tx.select({ id: journalEntry.id, entryNo: journalEntry.entryNo }).from(journalEntry).where(inArray(journalEntry.id, journalIds))) {
        refs.set(`journal_entry:${j.id}`, { label: j.entryNo, ref: j.entryNo });
      }
    }
    const accountIds = idsOf('chart_of_account');
    if (accountIds.length > 0) {
      for (const a of await tx.select({ id: chartOfAccount.id, code: chartOfAccount.code, name: chartOfAccount.name }).from(chartOfAccount).where(inArray(chartOfAccount.id, accountIds))) {
        refs.set(`chart_of_account:${a.id}`, { label: `${a.code} · ${a.name}`, ref: a.code });
      }
    }
    const userIds = idsOf('app_user');
    if (userIds.length > 0) {
      for (const u of await tx.select({ id: appUser.id, displayName: appUser.displayName }).from(appUser).where(inArray(appUser.id, userIds))) {
        refs.set(`app_user:${u.id}`, { label: u.displayName, ref: u.id });
      }
    }
    return { result, refs };
  });

  const pages = Math.max(1, Math.ceil((result.total ?? 0) / result.query.pageSize));
  const hrefFor = (p: number) => `/administration/audit?${outcome.q ? `q=${encodeURIComponent(outcome.q)}&` : ''}page=${p}`;

  const eventName = (code: string) => {
    if (event.has(code)) return event(code);
    const [type, ...rest] = code.split('.');
    const words = (s: string) => s.replace(/_/g, ' ');
    return rest.length > 0 ? words(rest.join('.')) : words(type!);
  };
  const kindName = (type: string) => (t.has(`audit.kinds.${type}`) ? t(`audit.kinds.${type}`) : type.replace(/_/g, ' '));
  const outcomeName = (value: string) => (t.has(`audit.outcome.${value}`) ? t(`audit.outcome.${value}`) : value);

  /** The record a row is about — by number, linked, or a plain word when the row is about the whole register. */
  const recordCell = (type: string, id: string | null) => {
    if (!id || id === type) return '—';
    const known = refs.get(`${type}:${id}`);
    const label = known?.label ?? (UUID.test(id) ? t('audit.former_record') : id);
    const address = ADDRESSES[type];
    const ref = known?.ref ?? id;
    return address && (known || !UUID.test(id)) ? (
      <Link className={admin.sapLink} href={address(ref)}>
        <bdi dir="auto">{label}</bdi>
      </Link>
    ) : (
      <bdi dir="auto">{label}</bdi>
    );
  };

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
                {result.rows.map((row, index) => {
                  const type = String(row.object_type);
                  const done = String(row.outcome);
                  return (
                    <tr key={`${String(row.occurred_at)}-${index}`}>
                      <td>
                        <bdi dir="ltr">{formatTimestamp(String(row.occurred_at), locale as Locale)}</bdi>
                      </td>
                      <td>
                        <strong>{eventName(String(row.action))}</strong>
                      </td>
                      <td>{kindName(type)}</td>
                      <td>{recordCell(type, row.object_id ? String(row.object_id) : null)}</td>
                      <td>{row.actor ? String(row.actor) : '—'}</td>
                      <td>{row.branch_code ? String(row.branch_code) : '—'}</td>
                      <td>
                        <Pill label={outcomeName(done)} on={done === 'success' ? true : false} />
                      </td>
                      <td>{row.reason ? String(row.reason) : '—'}</td>
                    </tr>
                  );
                })}
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
