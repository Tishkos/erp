'use client';

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { LucideIcon } from 'lucide-react';
import type { MenuSection } from '@domain/menu';
import type { ModuleGroupKey, ModuleKey } from '@domain/modules';
import { isDelivered, routeFor } from '@domain/screens';

/**
 * What every way of showing the modules shares — the top bar's dropdowns, the
 * phone drawer, the side panel and the bottom bar (2026-10-06): one module's
 * headings and screens, exactly as its dropdown lists them, and the two small
 * overlays the side panel's rail and the bottom bar use (a module's menu beside
 * or above its button, and the name of an icon).
 */

export interface ModuleDefinition {
  readonly key: ModuleKey;
  readonly icon: LucideIcon;
  /** The side panel's heading it stands under (`domain/modules.ts`); null for none (the Dashboard). */
  readonly group: ModuleGroupKey | null;
  readonly sectionKeys: readonly string[];
}

export interface ModuleGroup extends ModuleDefinition {
  readonly sections: readonly MenuSection[];
}

/** A module's first screen: the first built one in its menu, else its first. */
export function firstScreenOf(module: ModuleGroup): string | null {
  let first: string | null = null;
  for (const section of module.sections) {
    for (const item of section.items) {
      const href = routeFor(item, section.key);
      if (isDelivered(href)) return href;
      first ??= href;
    }
  }
  return first;
}

/** Whether one of a heading's screens is the open one. */
export function sectionHolds(section: MenuSection, activeHref: string | null): boolean {
  return activeHref !== null && section.items.some((item) => routeFor(item, section.key) === activeHref);
}

/** One heading's screens, as every menu draws them (a dropdown, the drawer, the section bar). */
export function SectionItems({
  section,
  activeHref,
  onNavigate,
}: {
  readonly section: MenuSection;
  readonly activeHref: string | null;
  readonly onNavigate: () => void;
}) {
  const page = useTranslations('page');
  const pending = useTranslations('screen');

  return (
    <ul className="erp-module-section__list">
      {section.items.map((item) => {
        // Every item in the approved tree has an address: the one its
        // module declared, or the one the screen catalogue derives. An
        // item that is not built yet keeps its pending badge, so the
        // tree says which pages are previews without refusing to open
        // them — which is what it used to do, for 176 of 218 items.
        const href = routeFor(item, section.key);
        // Unbuilt means not delivered — not "its address is derived".
        // Sales Invoices, Customer Receipts and every other built
        // screen whose route comes from its key were drawn grey with
        // "Not yet built" on them (found 2026-10-04).
        const preview = !isDelivered(href);
        return (
          <li className="erp-module-section__item" key={item.key}>
            <Link
              // The one deepest link, not every link the path starts
              // with: Update from ASYCUDA lives under Customs
              // Pre-Declarations' address, so both used to read as the
              // open screen (reported 2026-10-02).
              aria-current={activeHref === href ? 'page' : undefined}
              className={`erp-menu-item erp-menu-item--link${preview ? ' erp-menu-item--preview' : ''}`}
              href={href}
              onClick={onNavigate}
              title={preview ? pending('not_built') : undefined}
            >
              <span className="erp-menu-item__label">{page(item.key)}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function ModuleContents({
  module,
  activeHref,
  onNavigate,
  sections = module.sections,
}: {
  readonly module: ModuleGroup;
  /** The one deepest link that matches the path, worked out once by the shell. */
  readonly activeHref: string | null;
  readonly onNavigate: () => void;
  /** Some of the module's headings only (the section bar's More). */
  readonly sections?: readonly MenuSection[];
}) {
  const nav = useTranslations('nav');

  return (
    <div className="erp-module-contents">
      {sections.map((section) => (
        <section className="erp-module-section" key={section.key}>
          <h3 className="erp-module-section__title">{nav(section.key)}</h3>
          <SectionItems activeHref={activeHref} onNavigate={onNavigate} section={section} />
        </section>
      ))}
    </div>
  );
}

const GAP = 8;

function isRtl(): boolean {
  return document.documentElement.dir === 'rtl';
}

/**
 * A module's menu beside its button (the side panel's rail) or above it (the
 * bottom bar).
 *
 * Fixed to the window and placed from the button's own box, so the panel's
 * scrolling cannot clip it and it never runs off the screen: beside the rail it
 * opens towards the content (left of it in Arabic), above the bar it centres on
 * its button and is held inside the window. It sits in the document right
 * after its button, so Tab walks into it as it walks into a top-bar dropdown.
 * A press outside it, Esc, or following one of its links closes it.
 */
export function ModuleFlyout({
  id,
  module,
  anchor,
  placement,
  activeHref,
  onClose,
}: {
  readonly id: string;
  readonly module: ModuleGroup;
  readonly anchor: HTMLElement;
  readonly placement: 'side' | 'above';
  readonly activeHref: string | null;
  /** `true` when focus should go back to the module's button (Esc). */
  readonly onClose: (returnFocus: boolean) => void;
}) {
  const shell = useTranslations('shell');
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<CSSProperties | null>(null);
  const close = useRef(onClose);
  useLayoutEffect(() => {
    close.current = onClose;
  });
  const Icon = module.icon;

  useLayoutEffect(() => {
    const position = () => {
      const element = ref.current;
      if (!element || !anchor.isConnected) return;
      const box = anchor.getBoundingClientRect();
      const width = document.documentElement.clientWidth;
      const height = window.innerHeight;
      if (placement === 'side') {
        // Never over the top bar: the panel's own top is the ceiling.
        const ceiling = Math.max(GAP, (anchor.closest('.erp-sidebar')?.getBoundingClientRect().top ?? 0) + 4);
        const maxHeight = height - ceiling - GAP;
        const top = Math.max(ceiling, Math.min(box.top - 4, height - Math.min(element.offsetHeight, maxHeight) - GAP));
        setPlace(
          isRtl()
            ? { right: Math.max(GAP, width - box.left + GAP), top, maxHeight }
            : { left: box.right + GAP, top, maxHeight },
        );
      } else {
        const own = element.offsetWidth;
        const left = Math.max(GAP, Math.min(box.left + box.width / 2 - own / 2, width - own - GAP));
        setPlace({ left, bottom: height - box.top + GAP, maxHeight: Math.max(10 * 16, box.top - GAP * 2) });
      }
    };
    position();
    window.addEventListener('resize', position);
    return () => window.removeEventListener('resize', position);
  }, [anchor, placement]);

  useEffect(() => {
    const away = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target || ref.current?.contains(target) || anchor.contains(target)) return;
      close.current(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      close.current(true);
    };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', escape);
    };
  }, [anchor]);

  return (
    <div
      className="erp-flyout"
      data-placement={placement}
      id={id}
      ref={ref}
      style={place ?? { visibility: 'hidden' }}
    >
      <p className="erp-flyout__title">
        <Icon aria-hidden="true" />
        <span>{shell(`module.${module.key}`)}</span>
      </p>
      <ModuleContents activeHref={activeHref} module={module} onNavigate={() => close.current(false)} />
    </div>
  );
}

export interface TipState {
  readonly text: string;
  readonly box: DOMRect;
  readonly placement: 'side' | 'above';
  /** A line above the name — on the rail, the group the first module of a group heads. */
  readonly caption?: string;
}

/**
 * The name of an icon, beside it (the rail) or above it (the bottom bar), on
 * hover and on keyboard focus. The button already carries the name for a
 * screen reader, so the tip itself is hidden from one.
 */
export function ShellTip({ tip }: { readonly tip: TipState | null }) {
  if (!tip) return null;
  const { box, placement } = tip;
  const style: CSSProperties =
    placement === 'side'
      ? isRtl()
        ? { right: document.documentElement.clientWidth - box.left + GAP, top: box.top + box.height / 2 }
        : { left: box.right + GAP, top: box.top + box.height / 2 }
      : { left: box.left + box.width / 2, bottom: window.innerHeight - box.top + GAP };
  return (
    <span aria-hidden="true" className="erp-tip" data-placement={placement} style={style}>
      {tip.caption ? <small className="erp-tip__caption">{tip.caption}</small> : null}
      {tip.text}
    </span>
  );
}
