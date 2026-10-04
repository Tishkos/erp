import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AdminPage } from '@/components/admin';
import { SectionTabs } from '@/components/admin/section-tabs';
import { ChartsBand, KpiRow, ListBand, QuietBand, UnavailableBand, homeText } from '@/components/admin/home-widgets';
import { formatBusinessDate } from '@/i18n/config';
import { visibleRoute } from '@/server/delivered';
import * as home from '@/server/services/home';
import { optionalContext, withCurrentUser } from '@/server/session';

/**
 * Home — the page composed for the person who opened it.
 *
 * Not one dashboard with parts hidden: a list of widgets, each declaring the
 * grants it needs (`domain/dashboard-widgets`), and a page made of those the
 * signed-in person really holds. The same page asked by the CEO, an accounting
 * officer, a warehouse person and someone with no role answers differently,
 * and nothing is configured to make it so — it falls out of their grants,
 * which is also why the page cannot leak: a widget is not drawn rather than
 * drawn and refused.
 *
 * Order, top to bottom: the title and the few shortcuts this person's work
 * earns; the primary figures; the trends where there is something to draw; what
 * can be acted on; then, in one table, whatever the person may see that has
 * nothing in it. Each figure opens the screen that proves it. A role without
 * a family's data is told so in a sentence at the foot, and a widget the person
 * may see but that has nothing in it says that, in its own words, rather than
 * drawing a zero.
 *
 * The redirect is the one thing the blank version of this page did that
 * mattered: an unauthenticated visitor reaches the sign-in form, not a screen.
 */
export const dynamic = 'force-dynamic';

export default async function Home() {
  const context = await optionalContext();
  if (!context) redirect('/sign-in');

  const [t, x] = await Promise.all([getTranslations('admin'), homeText()]);
  const view = await withCurrentUser((tx, request) =>
    home.forViewer(tx, { principal: request.principal, branchCode: request.scope.branchCode }, visibleRoute),
  );

  // A widget with rows or a chart is drawn; one with nothing in it (or unreadable) is named in the quiet band.
  const drawn = (widget: (typeof view.list)[number]) => widget.outcome.state === 'ready';
  const quiet = [...view.chart, ...view.list].filter((widget) => !drawn(widget));

  return (
    <AdminPage
      actions={
        view.quickActions.length > 0 ? (
          <>
            {view.quickActions.map((action, index) => (
              <Link className={index === 0 ? 'action action--primary' : 'action'} href={action.href} key={action.key}>
                {x.t(`home.quick.${action.key}`)}
              </Link>
            ))}
          </>
        ) : null
      }
      subtitle={t('dashboard.as_at', { branch: view.branchCode, date: formatBusinessDate(view.asOf, x.locale) })}
      tabs={<SectionTabs route="/" />}
      title={t('dashboard.title')}
      variant="sap"
    >
      <KpiRow served={visibleRoute} widgets={view.kpi} x={x} />
      <ChartsBand served={visibleRoute} widgets={view.chart} x={x} />
      {view.list.filter(drawn).map((widget) => (
        <ListBand key={widget.key} served={visibleRoute} widget={widget} x={x} />
      ))}
      <QuietBand widgets={quiet} x={x} />
      <UnavailableBand families={view.unavailable} x={x} />
    </AdminPage>
  );
}
