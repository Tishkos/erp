import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { can } from '@domain/permissions';
import { screenRoutes } from '@domain/screens';
import { requireContext } from '@/server/session';
import { visibleRoute } from '@/server/phase-gate';
import styles from './admin.module.css';

/**
 * The screens that live next to this one — one compact row of tabs.
 *
 * Derived from the approved tree: every *live* screen in the same menu
 * section that the signed-in person may view. Nothing is invented and nothing
 * is offered that the URL would refuse; moving between Company, Users, Roles
 * and the rest becomes one click instead of a round trip through the menu.
 */
export async function SectionTabs({ route }: { readonly route: string }) {
  const [page, context] = await Promise.all([getTranslations('page'), requireContext()]);
  const all = [...screenRoutes().values()];
  const current = all.find((screen) => screen.route === route);
  if (!current) return null;

  // Grouped by the URL's first segment, not the menu section: /administration/*
  // is one working area even where the tree files a page under another
  // heading (the audit trail lives in Documents but its address is here).
  const area = route.split('/')[1];
  const siblings = all.filter(
    (screen) =>
      screen.route.split('/')[1] === area &&
      screen.wired &&
      visibleRoute(screen.route) &&
      can(context.principal, screen.item.verb ?? 'view', screen.item.object),
  );
  // A stable order, independent of which tab is open: the section that owns
  // most of this area keeps its tree order first, and routes adopted from
  // elsewhere (the audit trail is filed under Documents) follow. Sorting
  // against the *current* page instead would reshuffle the row on every click.
  const owner = [...siblings.reduce((counts, screen) => {
    counts.set(screen.section.key, (counts.get(screen.section.key) ?? 0) + 1);
    return counts;
  }, new Map<string, number>())].sort((a, b) => b[1] - a[1])[0]?.[0];
  siblings.sort(
    (a, b) => Number(a.section.key !== owner) - Number(b.section.key !== owner),
  );
  if (siblings.length < 2) return null;

  return (
    <nav aria-label={page(current.item.key)} className={styles.tabsBar}>
      {siblings.map((screen) => (
        <Link
          aria-current={screen.route === route ? 'page' : undefined}
          className={styles.tabItem}
          href={screen.route}
          key={screen.route}
        >
          {page(screen.item.key)}
        </Link>
      ))}
    </nav>
  );
}
