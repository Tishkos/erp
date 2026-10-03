import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { can } from '@domain/permissions';
import { screenRoutes } from '@domain/screens';
import { requireContext } from '@/server/session';
import { visibleRoute } from '@/server/delivered';
import styles from './admin.module.css';

/**
 * The screens that live next to this one — one compact row of tabs.
 *
 * "Next to" means **the same menu heading**, and nothing else. Open Chart of
 * Accounts and the row offers the rest of Master Data; open Customers and it
 * offers the rest of Sales. That is the promise the menu already made, so the
 * tabs repeat it rather than inventing a second grouping the reader has to
 * learn.
 *
 * ── It used to group by the URL, and that was wrong ────────────────────────
 * The row was assembled from every screen whose address began with the same
 * segment. While each area had one owner that read the same; once Customers,
 * Suppliers, Items, Units of Measure and the bank and cash accounts moved to
 * the headings whose work they belong to — while keeping their /master-data
 * addresses, because a URL is a name and renaming it breaks every link anyone
 * saved — Chart of Accounts started offering thirteen tabs, six of which
 * belonged to four other headings. A tab row that disagrees with the menu is
 * worse than no tab row: the reader cannot tell which one is lying.
 *
 * Nothing is invented and nothing is offered that the URL would refuse: a
 * screen appears only if it is built and the signed-in
 * person may view it. A row of one is no row at all, so it is not drawn.
 */
export async function SectionTabs({ route }: { readonly route: string }) {
  const [page, context] = await Promise.all([getTranslations('page'), requireContext()]);
  const all = [...screenRoutes().values()];
  const current = all.find((screen) => screen.route === route);
  if (!current) return null;

  // The menu heading this screen sits under — the same answer the sidebar
  // gives, from the same tree, in the tree's own order.
  const siblings = all.filter(
    (screen) =>
      screen.section.key === current.section.key &&
      screen.wired &&
      visibleRoute(screen.route) &&
      can(context.principal, screen.item.verb ?? 'view', screen.item.object),
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
