'use client';

import Link from 'next/link';
import { ChevronDown } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import styles from './admin.module.css';
import { overflowOf } from './tabs-overflow';

export interface SectionTab {
  readonly href: string;
  readonly label: string;
  readonly current: boolean;
}

/** Runs before paint in the browser; on the server (where it would warn) it is a plain effect. */
const useBeforePaint = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * The section's tabs on one line that never scrolls sideways.
 *
 * Every tab is drawn by the server, so a row that fits never moves when the
 * page wakes. Once it has, the row measures itself (a hidden copy of the
 * labels, and the room the bar has — both watched, so a resize or a late font
 * re-runs it) and the tabs that do not fit move behind a "More" button at the
 * end of the row. Each tab is one link in one place: on the row, or in the
 * menu. The menu is a disclosure of plain links (the WAI-ARIA navigation
 * pattern), so a tab stays a link with its own address wherever it is, and
 * the current one keeps `aria-current`.
 */
export function SectionTabsNav({
  label,
  moreLabel,
  tabs,
}: {
  readonly label: string;
  readonly moreLabel: string;
  readonly tabs: readonly SectionTab[];
}) {
  const navRef = useRef<HTMLElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const menuId = useId();
  // null until measured: the server's row, every tab on it.
  const [hidden, setHidden] = useState<readonly number[] | null>(null);
  const [open, setOpen] = useState(false);
  const current = tabs.findIndex((tab) => tab.current);
  const signature = tabs.map((tab) => tab.href).join('|');

  const measure = useCallback(() => {
    const nav = navRef.current;
    const ruler = measureRef.current;
    if (!nav || !ruler) return;
    const items = [...ruler.querySelectorAll<HTMLElement>('[data-measure-tab]')];
    const more = ruler.querySelector<HTMLElement>('[data-measure-more]');
    if (items.length !== tabs.length || !more) return;
    const style = getComputedStyle(nav);
    const gap = Number.parseFloat(style.columnGap) || 0;
    const room = nav.clientWidth - (Number.parseFloat(style.paddingInlineStart) || 0) - (Number.parseFloat(style.paddingInlineEnd) || 0);
    if (room <= 0) return;
    const next = overflowOf(
      items.map((item) => item.getBoundingClientRect().width),
      gap,
      room,
      more.getBoundingClientRect().width,
      current,
    );
    setHidden((was) => (was && was.length === next.length && was.every((v, i) => v === next[i]) ? was : next));
  }, [current, tabs.length]);

  useBeforePaint(() => {
    measure();
    const nav = navRef.current;
    const ruler = measureRef.current;
    if (!nav || !ruler || typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    observer.observe(nav);
    observer.observe(ruler);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [measure, signature]);

  // A new page (or a row that fits again) closes the menu.
  useEffect(() => setOpen(false), [signature]);
  useEffect(() => {
    if (hidden && hidden.length === 0) setOpen(false);
  }, [hidden]);

  // A press anywhere else, or focus leaving the bar, closes it.
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (navRef.current && !navRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  const focusItem = (index: number | 'first' | 'last') => {
    const links = [...(menuRef.current?.querySelectorAll<HTMLAnchorElement>('a') ?? [])];
    if (!links.length) return;
    const at = index === 'first' ? 0 : index === 'last' ? links.length - 1 : (index + links.length) % links.length;
    links[at]?.focus();
  };

  const onButtonKey = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const to = event.key === 'ArrowDown' ? 'first' : 'last';
      setOpen(true);
      requestAnimationFrame(() => focusItem(to));
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      setOpen(false);
    }
  };

  const onMenuKey = (event: ReactKeyboardEvent<HTMLUListElement>) => {
    const links = [...(menuRef.current?.querySelectorAll<HTMLAnchorElement>('a') ?? [])];
    const at = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusItem(at + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusItem(at - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusItem('first');
    } else if (event.key === 'End') {
      event.preventDefault();
      focusItem('last');
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    }
  };

  const tucked = new Set(hidden ?? []);
  const shown = tabs.map((tab, index) => ({ tab, index })).filter(({ index }) => !tucked.has(index));
  const menu = (hidden ?? []).map((index) => tabs[index]!);
  const currentTucked = current >= 0 && tucked.has(current);

  return (
    <nav
      aria-label={label}
      className={styles.tabsBar}
      data-tabs-measured={hidden === null ? undefined : ''}
      onBlur={(event) => {
        if (open && !event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
      ref={navRef}
    >
      {shown.map(({ tab }) => (
        <Link
          aria-current={tab.current ? 'page' : undefined}
          className={styles.tabItem}
          href={tab.href}
          key={tab.href}
        >
          {tab.label}
        </Link>
      ))}
      {menu.length > 0 && (
        <div className={styles.tabsMore}>
          <button
            aria-controls={menuId}
            aria-expanded={open}
            className={`${styles.tabItem} ${styles.tabsMoreButton}`}
            data-current-inside={currentTucked ? '' : undefined}
            data-tabs-more=""
            onClick={() => setOpen((was) => !was)}
            onKeyDown={onButtonKey}
            ref={buttonRef}
            type="button"
          >
            <span>{moreLabel}</span>
            <span aria-hidden className={styles.tabsMoreCount}>
              {menu.length}
            </span>
            <ChevronDown aria-hidden className={styles.tabsMoreChevron} data-open={open ? '' : undefined} />
          </button>
          <ul className={styles.tabsMenu} hidden={!open} id={menuId} onKeyDown={onMenuKey} ref={menuRef}>
            {menu.map((tab) => (
              <li key={tab.href}>
                <Link
                  aria-current={tab.current ? 'page' : undefined}
                  className={styles.tabsMenuItem}
                  href={tab.href}
                  onClick={() => setOpen(false)}
                >
                  {tab.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      {/* The ruler: every label as the row draws it, never seen nor read. A
          box of no size that clips its row, so it widens nothing. */}
      <div aria-hidden className={styles.tabsMeasure}>
        <div className={styles.tabsMeasureRow} ref={measureRef}>
          {tabs.map((tab) => (
            <span className={styles.tabItem} data-measure-tab="" key={tab.href}>
              {tab.label}
            </span>
          ))}
          <span className={`${styles.tabItem} ${styles.tabsMoreButton}`} data-measure-more="">
            <span>{moreLabel}</span>
            <span className={styles.tabsMoreCount}>{tabs.length}</span>
            <ChevronDown aria-hidden className={styles.tabsMoreChevron} />
          </span>
        </div>
      </div>
    </nav>
  );
}
