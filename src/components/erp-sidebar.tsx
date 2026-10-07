'use client';

import { useEffect, useRef, useState, type FocusEvent, type PointerEvent as ReactPointerEvent } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { MODULE_GROUPS, type ModuleKey } from '@domain/modules';
import type { HeaderBehaviour, SidebarStyle } from '@domain/appearance';
import { ShellTip, firstScreenOf, type ModuleGroup, type TipState } from './erp-nav-parts';

/**
 * The side panel (2026-10-06, by direction: "move the navbar to a side panel,
 * with icons, nicely … user side view / top view", then "kinda like Odoo's
 * side panel").
 *
 * Intent UI's sidebar under the top bar, on the start side (the right in
 * Arabic), as tall as the window and scrolling on its own: the list of
 * modules, each with its icon, as Odoo lists its apps. A module is a link to
 * its first screen; its headings and screens are then the top bar's section
 * menus (`erp-section-bar.tsx`), so the panel stays one short, quiet list and
 * the page keeps its height. The module of the open screen is marked.
 * Collapsed it is a rail of icons, each naming itself on hover and focus.
 * The top bar's own module list is not drawn in this mode — the panel is the
 * one "Primary navigation".
 *
 * Not on a phone: there the menu button and its drawer stay the navigation,
 * whichever layout the person chose (globals.css hides the panel).
 */
export function ErpSidebar({
  modules,
  activeKey,
  grouped,
  pathname,
  sidebar,
  header,
  onSidebarChange,
}: {
  readonly modules: readonly ModuleGroup[];
  readonly activeKey: ModuleKey | null;
  /** The modules under their group headings (Appearance › Group modules in the side panel). */
  readonly grouped: boolean;
  readonly pathname: string;
  readonly sidebar: SidebarStyle;
  readonly header: HeaderBehaviour;
  readonly onSidebarChange: (next: SidebarStyle) => void;
}) {
  const shell = useTranslations('shell');
  const rail = sidebar === 'icons';
  const [tip, setTip] = useState<TipState | null>(null);
  const asideRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => setTip(null), [pathname, rail]);

  // The open module is in view.
  useEffect(() => {
    const nav = navRef.current;
    const current = nav?.querySelector<HTMLElement>('[data-active="true"]');
    if (!nav || !current) return;
    const top = current.getBoundingClientRect().top - nav.getBoundingClientRect().top + nav.scrollTop;
    if (top < nav.scrollTop || top + current.offsetHeight > nav.scrollTop + nav.clientHeight) {
      nav.scrollTop = Math.max(0, top - nav.clientHeight / 3);
    }
  }, [rail, activeKey, grouped]);

  // A top bar that scrolls away leaves the panel the whole height of the window.
  useEffect(() => {
    const aside = asideRef.current;
    if (!aside) return;
    if (header !== 'static') {
      aside.style.removeProperty('inset-block-start');
      return;
    }
    const bar = document.querySelector<HTMLElement>('.erp-header');
    let frame = 0;
    const follow = () => {
      frame = 0;
      aside.style.insetBlockStart = `${bar ? Math.max(0, bar.getBoundingClientRect().bottom) : 0}px`;
    };
    const soon = () => {
      if (!frame) frame = requestAnimationFrame(follow);
    };
    follow();
    window.addEventListener('scroll', soon, { passive: true });
    window.addEventListener('resize', soon);
    return () => {
      window.removeEventListener('scroll', soon);
      window.removeEventListener('resize', soon);
      cancelAnimationFrame(frame);
      aside.style.removeProperty('inset-block-start');
    };
  }, [header]);

  const showTip = (
    text: string,
    event: ReactPointerEvent<HTMLElement> | FocusEvent<HTMLElement>,
    caption?: string,
  ) => {
    if (!rail) return;
    if (event.type === 'focus' && !event.currentTarget.matches(':focus-visible')) return;
    setTip({ text, box: event.currentTarget.getBoundingClientRect(), placement: 'side', ...(caption ? { caption } : {}) });
  };
  const hideTip = () => setTip(null);
  const collapseLabel = rail ? shell('sidebar_expand') : shell('sidebar_collapse');

  // The modules that open a screen, in the menu's order. Grouped: the modules with no group (the Dashboard)
  // first and under no heading, then each group in MODULE_GROUPS order with only the modules shown.
  const shown = modules.flatMap((module) => {
    const href = firstScreenOf(module);
    return href ? [{ module, href }] : [];
  });
  const groups = grouped
    ? [null, ...MODULE_GROUPS]
        .map((group) => ({ group, entries: shown.filter(({ module }) => module.group === group) }))
        .filter(({ entries }) => entries.length > 0)
    : [];

  const entry = ({ module, href }: (typeof shown)[number], caption?: string) => {
    const Icon = module.icon;
    const name = shell(`module.${module.key}`);
    const active = module.key === activeKey;
    return (
      <li className="erp-sidebar__module" key={module.key}>
        <Link
          aria-current={active ? 'true' : undefined}
          className="erp-sidebar__trigger"
          data-active={active ? 'true' : 'false'}
          data-module={module.key}
          href={href}
          onBlur={hideTip}
          onClick={hideTip}
          onFocus={(event) => showTip(name, event, caption)}
          onPointerEnter={(event) => showTip(name, event, caption)}
          onPointerLeave={hideTip}
        >
          <Icon aria-hidden="true" className="erp-sidebar__icon" />
          <span className="erp-sidebar__label">{name}</span>
        </Link>
      </li>
    );
  };

  return (
    <div className="erp-sidebar" data-groups={grouped ? 'grouped' : 'plain'} data-style={sidebar} id="erp-sidebar" ref={asideRef}>
      <nav aria-label={shell('primary_navigation')} className="erp-sidebar__nav" onScroll={hideTip} ref={navRef}>
        {grouped ? (
          // A heading over each group of related modules (by direction, 2026-10-07: "for payable and receivable
          // there should be 'Invoicing', a text on top of them"); on the rail a thin line, the name in the first tip.
          <ul className="erp-sidebar__groups">
            {groups.map(({ group, entries }) => {
              if (!group) {
                return (
                  <li className="erp-sidebar__group" data-group="" key="ungrouped">
                    <ul className="erp-sidebar__list">{entries.map((one) => entry(one))}</ul>
                  </li>
                );
              }
              const label = shell(`module_group.${group}`);
              return (
                <li className="erp-sidebar__group" data-group={group} key={group}>
                  <p className="erp-sidebar__group-label" id={`erp-side-group-${group}`}>
                    {label}
                  </p>
                  <ul aria-labelledby={`erp-side-group-${group}`} className="erp-sidebar__list">
                    {entries.map((one, index) => entry(one, index === 0 ? label : undefined))}
                  </ul>
                </li>
              );
            })}
          </ul>
        ) : (
          <ul className="erp-sidebar__list">{shown.map((one) => entry(one))}</ul>
        )}
      </nav>
      <div className="erp-sidebar__foot">
        <button
          aria-controls="erp-sidebar"
          aria-expanded={!rail}
          aria-label={collapseLabel}
          className="erp-sidebar__collapse"
          onBlur={hideTip}
          onClick={() => {
            hideTip();
            onSidebarChange(rail ? 'full' : 'icons');
          }}
          onFocus={(event) => showTip(collapseLabel, event)}
          onPointerEnter={(event) => showTip(collapseLabel, event)}
          onPointerLeave={hideTip}
          type="button"
        >
          {rail ? (
            <PanelLeftOpen aria-hidden="true" className="erp-mirror-rtl" />
          ) : (
            <PanelLeftClose aria-hidden="true" className="erp-mirror-rtl" />
          )}
          <span aria-hidden="true" className="erp-sidebar__label">{shell('sidebar_collapse_short')}</span>
        </button>
      </div>
      <ShellTip tip={tip} />
    </div>
  );
}
