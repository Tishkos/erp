'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Menu } from 'lucide-react';
import type { ModuleKey } from '@domain/modules';
import type { SidebarStyle } from '@domain/appearance';
import { ModuleFlyout, ShellTip, type ModuleGroup, type TipState } from './erp-nav-parts';

/** This browser's count of screens opened per module — a convenience of this device only. */
const USES_KEY = 'erp-module-uses';
/** How many modules a phone's bar holds before "More". */
const PHONE_SLOTS = 4;

function readUses(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(USES_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/**
 * The modules a phone's bar shows: the four this person opens most on this
 * device (the menu's order until they have opened anything, and between
 * equals), always with the module of the open screen among them, drawn in the
 * menu's order so they do not change places as the counts move.
 */
export function phoneModules(
  modules: readonly { readonly key: ModuleKey }[],
  uses: Readonly<Record<string, number>>,
  activeKey: ModuleKey | null,
): ReadonlySet<ModuleKey> {
  const count = (key: ModuleKey) => Number(uses[key]) || 0;
  const ranked = [...modules].sort((a, b) => count(b.key) - count(a.key));
  const chosen = ranked.slice(0, PHONE_SLOTS).map((module) => module.key);
  if (activeKey && modules.some((module) => module.key === activeKey) && !chosen.includes(activeKey)) {
    if (chosen.length < PHONE_SLOTS) chosen.push(activeKey);
    else chosen[chosen.length - 1] = activeKey;
  }
  return new Set(chosen);
}

/**
 * The bottom bar (2026-10-06, by direction: "navbar in bottom").
 *
 * Intent UI's floating dock: fixed to the foot of the window, rounded,
 * raised, on a blurred surface, clear of the phone's home indicator. Every
 * module's icon with its name under it — or the icons alone, when the person
 * chose that or the names do not fit (measured, as the top bar measures) —
 * the current module marked. A module opens its menu upwards, exactly as its
 * dropdown lists it.
 *
 * On a phone it holds the four modules this person opens most and "More",
 * which opens the menu drawer the menu button opens.
 */
export function ErpDock({
  modules,
  activeKey,
  activeHref,
  pathname,
  sidebar,
  onMore,
}: {
  readonly modules: readonly ModuleGroup[];
  readonly activeKey: ModuleKey | null;
  readonly activeHref: string | null;
  readonly pathname: string;
  readonly sidebar: SidebarStyle;
  readonly onMore: () => void;
}) {
  const shell = useTranslations('shell');
  const [menu, setMenu] = useState<{ readonly key: ModuleKey; readonly anchor: HTMLElement } | null>(null);
  const [tip, setTip] = useState<TipState | null>(null);
  const [uses, setUses] = useState<Readonly<Record<string, number>>>({});
  const dockRef = useRef<HTMLElement>(null);
  const shown = useMemo(() => phoneModules(modules, uses, activeKey), [modules, uses, activeKey]);

  useEffect(() => {
    setMenu(null);
    setTip(null);
    const counted = readUses();
    if (activeKey) {
      counted[activeKey] = (Number(counted[activeKey]) || 0) + 1;
      try {
        window.localStorage.setItem(USES_KEY, JSON.stringify(counted));
      } catch {
        // Without storage the phone's bar keeps the menu's order.
      }
    }
    setUses(counted);
  }, [pathname, activeKey]);

  // Names under the icons while they fit; the icons alone when they do not.
  const fit = () => {
    const dock = dockRef.current;
    if (!dock) return;
    if (sidebar === 'icons') {
      dock.dataset.fit = 'icons';
      return;
    }
    dock.dataset.fit = 'labels';
    if (dock.scrollWidth > dock.clientWidth + 1) dock.dataset.fit = 'icons';
  };
  useLayoutEffect(fit);
  useEffect(() => {
    const resized = () => fit();
    window.addEventListener('resize', resized);
    void document.fonts?.ready.then(resized);
    return () => window.removeEventListener('resize', resized);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `fit` reads only the setting and the element.
  }, [sidebar]);

  const showTip = (text: string, event: ReactPointerEvent<HTMLElement> | FocusEvent<HTMLElement>) => {
    if (dockRef.current?.dataset.fit !== 'icons') return;
    if (event.type === 'focus' && !event.currentTarget.matches(':focus-visible')) return;
    setTip({ text, box: event.currentTarget.getBoundingClientRect(), placement: 'above' });
  };
  const hideTip = () => setTip(null);

  return (
    <nav aria-label={shell('primary_navigation')} className="erp-dock" data-fit="labels" ref={dockRef}>
      <ul className="erp-dock__list">
        {modules.map((module) => {
          const Icon = module.icon;
          const name = shell(`module.${module.key}`);
          const active = module.key === activeKey;
          const open = menu?.key === module.key;
          const menuId = `erp-dock-menu-${module.key}`;
          return (
            <li className="erp-dock__item" data-phone={shown.has(module.key) ? 'shown' : 'hidden'} key={module.key}>
              <button
                aria-controls={open ? menuId : undefined}
                aria-current={active ? 'page' : undefined}
                aria-expanded={open}
                className="erp-dock__trigger"
                data-active={active ? 'true' : 'false'}
                onBlur={hideTip}
                onClick={(event) => {
                  hideTip();
                  const anchor = event.currentTarget;
                  setMenu((current) => (current?.key === module.key ? null : { key: module.key, anchor }));
                }}
                onFocus={(event) => showTip(name, event)}
                onPointerEnter={(event) => {
                  if (!open) showTip(name, event);
                }}
                onPointerLeave={hideTip}
                type="button"
              >
                <Icon aria-hidden="true" className="erp-dock__icon" />
                <span className="erp-dock__label">{name}</span>
              </button>
              {open ? (
                <ModuleFlyout
                  activeHref={activeHref}
                  anchor={menu.anchor}
                  id={menuId}
                  module={module}
                  onClose={(returnFocus) => {
                    setMenu(null);
                    if (returnFocus) menu.anchor.focus();
                  }}
                  placement="above"
                />
              ) : null}
            </li>
          );
        })}
        <li className="erp-dock__item erp-dock__item--more">
          <button
            aria-controls="erp-mobile-drawer"
            className="erp-dock__trigger"
            onClick={() => {
              setMenu(null);
              onMore();
            }}
            type="button"
          >
            <Menu aria-hidden="true" className="erp-dock__icon" />
            <span className="erp-dock__label">{shell('dock_more')}</span>
          </button>
        </li>
      </ul>
      <ShellTip tip={tip} />
    </nav>
  );
}
