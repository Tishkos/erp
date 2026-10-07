'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ChevronDown } from 'lucide-react';
import type { MenuItem, MenuSection } from '@domain/menu';
import { routeFor } from '@domain/screens';
import { overflowOf } from './admin/tabs-overflow';
import { ModuleContents, SectionItems, sectionHolds, type ModuleGroup } from './erp-nav-parts';

/**
 * The open module's menu in the top bar (2026-10-06, by direction: "in side
 * panel … the tabs should move to navbar … like choosing Accounting in the
 * side panel we have a navbar of General Ledger ▾ and can drop down, Treasury
 * & Banking ▾ drop down … kinda like Odoo").
 *
 * Drawn when the modules are in the side panel or the bottom bar, after the
 * brand and a thin line: the module of the open screen, as its dropdown lists
 * it. A module of several headings shows each heading as a menu of its
 * screens; a module of one heading — Receivables, Inventory, HR — shows that
 * heading's screens themselves, as the page's own tabs did; a heading of one
 * screen is that screen's link. The heading (or screen) that holds the open
 * screen is marked, and the screen itself carries `aria-current`.
 *
 * One line that never scrolls and never shrinks a name: what does not fit
 * goes behind "More" at its end, measured as the section tabs measure
 * (`admin/tabs-overflow.ts`), the part that holds the open screen kept in its
 * place. The shell reads `data-need` (what every entry takes) to decide what
 * else the bar gives up first (erp-shell.tsx › fitNav).
 */

interface Entry {
  readonly key: string;
  readonly label: string;
  /** A heading drawn as a menu. */
  readonly section?: MenuSection;
  /** A screen drawn as a link. */
  readonly href?: string;
  readonly current: boolean;
  /** For "More": the heading it belongs under there. */
  readonly home: MenuSection;
  readonly item?: MenuItem;
}

const useBeforePaint = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function ErpSectionBar({
  module,
  activeHref,
  pathname,
}: {
  readonly module: ModuleGroup;
  readonly activeHref: string | null;
  readonly pathname: string;
}) {
  const shell = useTranslations('shell');
  const nav = useTranslations('nav');
  const page = useTranslations('page');
  const navRef = useRef<HTMLElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [hidden, setHidden] = useState<readonly number[] | null>(null);
  const moduleName = shell(`module.${module.key}`);

  // One heading: its screens are the bar. Several: each heading is a menu, or a link when it holds one screen.
  const entries: readonly Entry[] =
    module.sections.length === 1
      ? module.sections[0]!.items.map((item) => {
          const section = module.sections[0]!;
          const href = routeFor(item, section.key);
          return { key: `${section.key}:${item.key}`, label: page(item.key), href, current: href === activeHref, home: section, item };
        })
      : module.sections.map((section) =>
          section.items.length === 1
            ? {
                key: section.key,
                label: nav(section.key),
                href: routeFor(section.items[0]!, section.key),
                current: sectionHolds(section, activeHref),
                home: section,
                item: section.items[0]!,
              }
            : { key: section.key, label: nav(section.key), section, current: sectionHolds(section, activeHref), home: section },
        );
  const current = entries.findIndex((entry) => entry.current);
  const signature = `${module.key}|${entries.map((entry) => entry.key).join('|')}`;

  const measure = useCallback(() => {
    const bar = navRef.current;
    const ruler = rulerRef.current;
    if (!bar || !ruler) return;
    const widths = [...ruler.querySelectorAll<HTMLElement>('[data-measure-entry]')].map((one) => one.getBoundingClientRect().width);
    const more = ruler.querySelector<HTMLElement>('[data-measure-more]')?.getBoundingClientRect().width ?? 0;
    if (widths.length !== entries.length) return;
    const style = getComputedStyle(bar);
    const list = bar.querySelector<HTMLElement>('.erp-sections__list');
    const gap = list ? Number.parseFloat(getComputedStyle(list).columnGap) || 0 : 0;
    // The line before the entries is the bar's own (::before): its room is not theirs.
    const line = getComputedStyle(bar, '::before');
    const padding =
      (Number.parseFloat(style.paddingInlineStart) || 0) +
      (Number.parseFloat(style.paddingInlineEnd) || 0) +
      (Number.parseFloat(line.width) || 0) +
      (Number.parseFloat(line.marginInlineStart) || 0) +
      (Number.parseFloat(line.marginInlineEnd) || 0);
    const need = widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, widths.length - 1) + padding;
    bar.dataset.need = String(Math.ceil(need));
    const room = bar.clientWidth - padding;
    if (room <= 0) return;
    const next = overflowOf(widths, gap, room, more, current);
    setHidden((was) => (was && was.length === next.length && was.every((value, index) => value === next[index]) ? was : next));
  }, [current, entries.length]);

  useBeforePaint(() => {
    measure();
    const bar = navRef.current;
    const ruler = rulerRef.current;
    if (!bar || !ruler || typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    observer.observe(bar);
    observer.observe(ruler);
    void document.fonts?.ready.then(measure);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [measure, signature]);

  // A new screen closes what was open.
  useEffect(() => setOpen(null), [pathname, signature]);

  // A press anywhere else, or Esc wherever the focus is, closes it.
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!navRef.current?.contains(event.target as Node)) setOpen(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !navRef.current?.contains(document.activeElement)) setOpen(null);
    };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const tucked = new Set(hidden ?? []);
  const shown = entries.map((entry, index) => ({ entry, index })).filter(({ index }) => !tucked.has(index));
  const inMore = (hidden ?? []).map((index) => entries[index]!);
  // "More" lists its headings whole (with their titles) or, for a one-heading module, the screens left over.
  const moreSections: readonly MenuSection[] =
    module.sections.length === 1
      ? inMore.length
        ? [{ ...module.sections[0]!, items: inMore.flatMap((entry) => (entry.item ? [entry.item] : [])) }]
        : []
      : inMore.map((entry) => entry.section ?? entry.home);
  const moreCurrent = inMore.some((entry) => entry.current);

  const links = (key: string) =>
    [...(navRef.current?.querySelectorAll<HTMLAnchorElement>(`[data-menu="${key}"] a`) ?? [])];
  const focusIn = (key: string, at: 'first' | 'last' | number) => {
    const all = links(key);
    if (!all.length) return;
    const index = at === 'first' ? 0 : at === 'last' ? all.length - 1 : (at + all.length) % all.length;
    all[index]?.focus();
  };
  const triggerOf = (key: string) => navRef.current?.querySelector<HTMLButtonElement>(`[data-trigger="${key}"]`) ?? null;

  const onTriggerKey = (key: string) => (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(key);
      const to = event.key === 'ArrowDown' ? 'first' : 'last';
      requestAnimationFrame(() => focusIn(key, to));
    } else if (event.key === 'Escape' && open === key) {
      event.preventDefault();
      setOpen(null);
    }
  };
  const onMenuKey = (key: string) => (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const all = links(key);
    const at = all.indexOf(document.activeElement as HTMLAnchorElement);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusIn(key, at + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusIn(key, at - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusIn(key, 'first');
    } else if (event.key === 'End') {
      event.preventDefault();
      focusIn(key, 'last');
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(null);
      triggerOf(key)?.focus();
    }
  };
  // Focus leaving an open menu and its button closes it.
  const onItemBlur = (key: string) => (event: FocusEvent<HTMLLIElement>) => {
    if (open === key && !event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(null);
  };

  const menuButton = (key: string, label: string, isCurrent: boolean, count?: number) => (
    <button
      aria-controls={open === key ? `erp-sections-${key}` : undefined}
      aria-current={isCurrent ? 'true' : undefined}
      aria-expanded={open === key}
      className="erp-sections__trigger"
      data-current={isCurrent ? 'true' : 'false'}
      data-trigger={key}
      onClick={() => setOpen((was) => (was === key ? null : key))}
      onKeyDown={onTriggerKey(key)}
      type="button"
    >
      <span>{label}</span>
      {count ? (
        <span aria-hidden="true" className="erp-sections__count">
          {count}
        </span>
      ) : null}
      <ChevronDown aria-hidden="true" className="erp-sections__chevron" />
    </button>
  );

  return (
    <nav
      aria-label={shell('section_menu', { module: moduleName })}
      className="erp-sections"
      data-measured={hidden === null ? undefined : ''}
      ref={navRef}
    >
      <ul className="erp-sections__list">
        {shown.map(({ entry }) => (
          <li className="erp-sections__item" key={entry.key} onBlur={onItemBlur(entry.key)}>
            {entry.section ? (
              <>
                {menuButton(entry.key, entry.label, entry.current)}
                {open === entry.key ? (
                  <div
                    className="erp-module-popover erp-sections__menu"
                    data-menu={entry.key}
                    id={`erp-sections-${entry.key}`}
                    onKeyDown={onMenuKey(entry.key)}
                  >
                    <SectionItems activeHref={activeHref} onNavigate={() => setOpen(null)} section={entry.section} />
                  </div>
                ) : null}
              </>
            ) : (
              <Link
                aria-current={entry.href === activeHref ? 'page' : undefined}
                className="erp-sections__trigger erp-sections__link"
                data-current={entry.current ? 'true' : 'false'}
                href={entry.href!}
              >
                {entry.label}
              </Link>
            )}
          </li>
        ))}
        {moreSections.length ? (
          <li className="erp-sections__item erp-sections__item--more" onBlur={onItemBlur('more')}>
            {menuButton('more', shell('sections_more'), moreCurrent, inMore.length)}
            {open === 'more' ? (
              <div
                className="erp-module-popover erp-sections__menu erp-sections__menu--more"
                data-menu="more"
                id="erp-sections-more"
                onKeyDown={onMenuKey('more')}
              >
                <ModuleContents
                  activeHref={activeHref}
                  module={module}
                  onNavigate={() => setOpen(null)}
                  sections={moreSections}
                />
              </div>
            ) : null}
          </li>
        ) : null}
      </ul>
      {/* The ruler: every entry as the bar draws it, never seen nor read. */}
      <div aria-hidden="true" className="erp-sections__ruler" ref={rulerRef}>
        {entries.map((entry) => (
          <span className="erp-sections__trigger" data-measure-entry="" key={entry.key}>
            <span>{entry.label}</span>
            {entry.section ? <ChevronDown className="erp-sections__chevron" /> : null}
          </span>
        ))}
        <span className="erp-sections__trigger" data-measure-more="">
          <span>{shell('sections_more')}</span>
          <span className="erp-sections__count">{entries.length}</span>
          <ChevronDown className="erp-sections__chevron" />
        </span>
      </div>
    </nav>
  );
}
