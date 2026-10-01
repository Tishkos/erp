'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { MenuSection } from '@domain/menu';

/**
 * The Appendix A menu tree — Phase 01.12.
 *
 * The tree it renders was pruned on the server by `visibleMenu(principal)`.
 * Hiding is presentation only: §25 is explicit that *"navigation hiding alone
 * is not access control"*, and every page and API re-checks the permission
 * regardless of what the sidebar showed.
 *
 * Items whose module has not been built yet are rendered as plain text
 * that delivers them, rather than as links to a blank page. Appendix A's tree is
 * mandatory at functional level, so removing them until their module lands
 * would misrepresent the approved scope; a dead link would look like a fault.
 */
export function Navigation({ sections }: { sections: readonly MenuSection[] }) {
  const pathname = usePathname();
  const nav = useTranslations('nav');
  const page = useTranslations('page');
  const pending = useTranslations('screen');

  return (
    <nav className="shell__nav" aria-label={nav('home')}>
      {sections.map((section) => (
        <div className="nav__section" key={section.key}>
          <div className="nav__heading">{nav(section.key)}</div>
          <ul className="nav__list">
            {section.items.map((item) => (
              <li key={item.key}>
                {item.href ? (
                  <Link
                    className="nav__link"
                    href={item.href}
                    aria-current={pathname === item.href ? 'page' : undefined}
                  >
                    {page(item.key)}
                  </Link>
                ) : (
                  // Not a link, and not labelled with a date promise: a
                  // person reading the menu needs to know the page is not
                  // ready, not which sprint it belongs to.
                  <span className="nav__link nav__link--pending" title={pending('not_built')}>
                    {page(item.key)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
