import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { ActionButton, AdminPage, FilterRow, Flash, ListToolbar, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { SectionTabs } from '@/components/admin/section-tabs';
import { Denied } from '@/components/denied';
import { noteText, whenText, type Words } from '@/components/notifications/note-text';
import { Pagination } from '@/components/ui';
import { can } from '@domain/permissions';
import { BUSINESS_TIME_ZONE } from '@/server/domain/business-date';
import { NOTIFICATION_CATEGORIES, NOTIFICATION_PAGE_SIZE, isCategory } from '@/server/domain/notification-center';
import { visibleRoute } from '@/server/delivered';
import { registerAllRecords } from '@/server/records';
import { requireContext, withCurrentUser } from '@/server/session';
import * as center from '@/server/services/notification-center';
import { markAllReadForm, toggleReadForm } from './actions';

/**
 * Notifications — everything the system has told this person, newest first.
 *
 * Copies the Purchase Invoices list: the search, the Show and Category filters
 * as a filter form, the standard register, paging. Only this person's own
 * notifications are read (row-level security, then the recipient), and each row
 * is drawn with where it leads *for this reader now*: a link while they can
 * still open it, "no longer available" — without the text, which may name what
 * is no longer theirs — when they cannot.
 */
export const dynamic = 'force-dynamic';

export default async function NotificationsPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/notifications')) notFound();
  const [t, n, nav, column, locale, context, outcome, params] = await Promise.all([
    getTranslations('admin'),
    getTranslations('notifications'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    searchParams,
  ]);
  const { principal, scope } = context;
  if (!can(principal, 'view', 'notification')) return <Denied object={nav('notifications')} />;

  const stateParam = params.state === 'unread' ? 'unread' : 'all';
  const categoryParam = typeof params.category === 'string' && isCategory(params.category) ? params.category : '';
  const gone = params.gone === '1';

  registerAllRecords();
  const feed = await withCurrentUser((tx) =>
    center.feedFor(
      tx,
      { principal, branchCode: scope.branchCode },
      { state: stateParam, category: categoryParam || null, q: outcome.q || null, page: outcome.page, pageSize: NOTIFICATION_PAGE_SIZE },
    ),
  );

  const words = n as unknown as Words;
  const now = new Date();
  const kept = { q: outcome.q, state: stateParam, category: categoryParam, page: String(feed.page) };
  const hiddenOf = (extra: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries({ ...kept, ...extra }).filter(([, value]) => value !== ''));
  const query = (p: number) =>
    new URLSearchParams({ ...(outcome.q ? { q: outcome.q } : {}), state: stateParam, ...(categoryParam ? { category: categoryParam } : {}), page: String(p) }).toString();

  return (
    <AdminPage
      actions={feed.unread > 0 ? <ActionButton action={markAllReadForm} hidden={hiddenOf({})} label={n('mark_all_read')} small={false} /> : null}
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/notifications" />}
      subtitle={n('subtitle')}
      title={n('title')}
      variant="sap"
    >
      <Flash
        error={gone ? n('gone_flash') : outcome.error}
        errorTitle={t('error_title')}
        saved={outcome.saved}
        savedLabel={t('saved')}
      />

      <section aria-labelledby="notifications-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="notifications-list-title">
            <span>{n('list_label')}</span>
            <span className={s.sapTitleMeta}>{t('rows_shown', { count: feed.count })}</span>
          </h2>

          <ListToolbar
            clearHref="/notifications"
            clearLabel={t('clear_search')}
            countLabel={t('rows_shown', { count: feed.count })}
            hidden={{ state: stateParam, ...(categoryParam ? { category: categoryParam } : {}) }}
            placeholder={t('search_placeholder')}
            q={outcome.q}
            searchLabel={t('search')}
          />

          <form className={s.filterBar} method="get">
            <FilterRow>
              <Select
                defaultValue={stateParam}
                label={n('state_filter')}
                name="state"
                options={[
                  { value: 'all', label: n('state_all') },
                  { value: 'unread', label: n('state_unread') },
                ]}
              />
              <Select
                defaultValue={categoryParam}
                emptyLabel={n('category_all')}
                label={n('category_filter')}
                name="category"
                options={NOTIFICATION_CATEGORIES.map((category) => ({ value: category, label: n(`category.${category}`) }))}
              />
              <SubmitRow>
                <Submit label={n('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="notifications-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{n('col_when')}</th>
                  <th scope="col">{n('col_category')}</th>
                  <th scope="col">{n('col_message')}</th>
                  <th scope="col">{column('status')}</th>
                  <th scope="col">{n('col_actions')}</th>
                </tr>
              </thead>
              <tbody>
                {feed.items.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={5}>
                      {stateParam === 'unread' ? n('empty_unread') : n('empty_all')}
                    </td>
                  </tr>
                ) : null}
                {feed.items.map((item) => {
                  const text = noteText(words, item);
                  const when = whenText(item.createdAt, now, locale, BUSINESS_TIME_ZONE);
                  const tone = text.gone ? 'cancelled' : item.read ? 'draft' : 'submitted';
                  return (
                    <tr data-notification-id={item.id} data-read={item.read ? 'true' : 'false'} key={item.id}>
                      <td>
                        <time dateTime={item.createdAt} title={when.absolute}>
                          {when.relative}
                        </time>
                      </td>
                      <td>{n(`category.${item.category}`)}</td>
                      <td>
                        {item.openable ? (
                          // A plain link on purpose: the address is worked out when it is followed (/notifications/open/<id>).
                          <a className={s.sapLink} href={`/notifications/open/${item.id}`}>
                            <bdi dir="auto">{text.title}</bdi>
                          </a>
                        ) : (
                          <bdi dir="auto">{text.title}</bdi>
                        )}
                        {text.detail ? (
                          <>
                            <br />
                            <span className="muted">
                              <bdi dir="auto">{text.detail}</bdi>
                            </span>
                          </>
                        ) : null}
                        {text.gone && text.title !== n('gone') ? (
                          <>
                            <br />
                            <span className="muted">{n('gone')}</span>
                          </>
                        ) : null}
                      </td>
                      <td>
                        <span className={`status status--${tone} ${s.sapRegisterStatus}`} data-status={tone}>
                          {text.gone ? n('gone') : item.read ? n('status_read') : n('status_unread')}
                        </span>
                      </td>
                      <td>
                        <ActionButton
                          action={toggleReadForm}
                          hidden={hiddenOf({ id: item.id, to: item.read ? 'unread' : 'read' })}
                          label={item.read ? n('mark_unread') : n('mark_read')}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pagination
            count={feed.pages}
            current={feed.page}
            hrefFor={(p) => `/notifications?${query(p)}`}
            labels={{ label: t('pagination'), previous: t('previous'), next: t('next'), page: (p) => t('page_n', { page: p }) }}
            locale={locale}
          />
        </div>
      </section>
    </AdminPage>
  );
}
