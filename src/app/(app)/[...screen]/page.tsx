import { getTranslations } from 'next-intl/server';
import { notFound, redirect } from 'next/navigation';
import { Denied } from '@/components/denied';
import { PlannedScreen } from '@/components/screens/planned';
import { optionalContext } from '@/server/session';
import { can } from '@domain/permissions';
import { screenRoutes } from '@domain/screens';
import { visibleRoute } from '@/server/phase-gate';

/**
 * Every Appendix A screen that has not yet been written by hand.
 *
 * A catch-all rather than 200 near-identical page files. The screen catalogue
 * knows every address in the approved tree and the phase each one arrives in,
 * so an unbuilt address renders an honest "planned" page — no sample rows,
 * no invented figures — rather than a 404 or a mock-up.
 *
 * Static routes win over a catch-all in the App Router, so a screen that
 * reads real data keeps its own file and is never served from here.
 *
 * The permission check is the same one the rest of the application makes, on
 * the same principal. §25: navigation hiding is not access control — so this
 * page refuses the object directly rather than trusting that a hidden menu item
 * kept anyone out.
 */
export const dynamic = 'force-dynamic';

export default async function ScreenPage({
  params,
}: {
  params: Promise<{ screen?: string[] }>;
}) {
  const { screen: segments } = await params;
  const parts = segments ?? [];
  const route = `/${parts.join('/')}`;
  const routes = screenRoutes();

  // A `document` screen is a pair: the list at its route, and one record at
  // `{route}/{number}`. An unmatched path is retried one segment shorter — if
  // the parent is a document screen, the last segment is a document number.
  const listRoute = parts.length > 1 ? `/${parts.slice(0, -1).join('/')}` : null;
  const parent = listRoute ? routes.get(listRoute) : undefined;
  const target = routes.get(route) ?? (parent?.archetype === 'document' ? parent : undefined);
  if (!target) notFound();
  // The phase gate: a screen of a phase not yet shared does not exist here.
  if (!visibleRoute(target.route)) notFound();

  const context = await optionalContext();
  if (!context) redirect('/sign-in');

  if (!can(context.principal, target.item.verb ?? 'view', target.item.object)) {
    const t = await getTranslations();
    return <Denied object={t(`page.${target.item.key}`)} />;
  }

  return <PlannedScreen screen={target} />;
}
