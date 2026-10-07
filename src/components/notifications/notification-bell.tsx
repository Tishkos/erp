'use client';

import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { ArrowRight, Bell, CheckCheck, ChevronDown, Inbox, RefreshCw } from 'lucide-react';
import { badgeText, NOTIFICATION_CATEGORIES, type NotificationCategory } from '@domain/notification-center';
import { cn } from '@/components/intent/cn';
import type { FeedItem } from '@/server/services/notification-center';
import { CategoryIcon } from './category-look';
import { noteText, whenText, type Words } from './note-text';
import { adopt, markAllRead, markRead, markUnread, mount, setCategory, setOpen, setScope, useBell, type BellSnapshot } from './notification-store';
import { PANEL_FOOTER_LINK, PANEL_HEADER, UTILITY_PANEL } from './utility-panel';

/**
 * The bell's three small parts in the application header (`erp-shell.tsx`).
 *
 * The header's bell was a drawer of the ten latest, drawn once by the server.
 * It now carries the unread count, lists what is waiting (or everything) with
 * a category filter, opens a notification through `/notifications/open/<id>`
 * — which works out where it leads *now*, for this reader, and says so when
 * they can no longer go there — and marks read, unread and all read. The count
 * is a small badge on the bell (`erp-icon-button__badge`, Intent UI
 * 2026-10-06).
 *
 * The popover (Intent UI, 2026-10-06): a header with the title, the unread
 * count and "Mark all as read"; Unread / All as a segmented control beside the
 * category; each notification a row — its category's icon in a tinted circle,
 * the title, one muted line, how long ago, and the unread dot, which is also
 * the button that marks it read (or, on a read one, unread); the whole row
 * opens it. Then the way to the full screen.
 */

export interface BellSeedProps {
  readonly unread: number;
  readonly zone: string;
}

const serverSnapshot = (seed: BellSeedProps): BellSnapshot => ({
  loaded: true,
  status: 'ok',
  unread: seed.unread,
  categories: [],
  items: null,
  scope: 'unread',
  category: null,
  open: false,
  zone: seed.zone,
});

/** Takes the server's count in after the first render and whenever it hands a fresher one; keeps the poll running. */
function useBellFeed(seed: BellSeedProps): BellSnapshot {
  const snap = useBell(serverSnapshot(seed));
  useLayoutEffect(() => {
    adopt(seed);
  }, [seed.unread, seed.zone]);
  useEffect(() => mount(), []);
  return snap;
}

/** The label the bell button carries: its name, and how many are unread. */
export function useBellLabel(seed: BellSeedProps, base: string): string {
  const t = useTranslations('notifications');
  const snap = useBellFeed(seed);
  return snap.unread > 0 ? t('bell_label_count', { count: snap.unread }) : base;
}

/** The button's face: the bell, and — when something is waiting — the count as a small badge on it. */
export function BellGlyph({ seed }: { readonly seed: BellSeedProps }) {
  const snap = useBellFeed(seed);
  return (
    <>
      <Bell aria-hidden="true" />
      {snap.unread > 0 ? (
        <span aria-hidden="true" className="coa-count-badge erp-icon-button__badge" data-bell-badge={snap.unread}>
          {badgeText(snap.unread)}
        </span>
      ) : null}
    </>
  );
}

/** The mobile drawer's row for notifications: the count beside the label. */
export function BellCount({ seed }: { readonly seed: BellSeedProps }) {
  const snap = useBell(serverSnapshot(seed));
  if (snap.unread === 0) return null;
  return (
    <span aria-hidden="true" className="coa-count-badge">
      {badgeText(snap.unread)}
    </span>
  );
}

const SEGMENT =
  'inline-flex h-7 items-center rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring';

/** The popover: header, filter, list, and the way into the full screen. */
export function BellPopover({ seed, onNavigate }: { readonly seed: BellSeedProps; readonly onNavigate: () => void }) {
  const t = useTranslations('notifications');
  const locale = useLocale();
  const snap = useBell(serverSnapshot(seed));
  const [now, setNow] = useState<Date | null>(null);

  // The popover exists only while it is open: tell the store, so the poll fetches the list.
  useEffect(() => {
    setOpen(true);
    return () => setOpen(false);
  }, []);
  // Relative times are drawn from the browser's clock once mounted (server and browser would disagree), and kept fresh.
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  const words = t as unknown as Words;
  const unreadIn = useMemo(() => {
    const entry = snap.categories.find((c) => c.category === snap.category);
    return snap.category === null ? snap.unread : (entry?.unread ?? 0);
  }, [snap.categories, snap.category, snap.unread]);
  const unreadOf = (category: NotificationCategory): number => snap.categories.find((c) => c.category === category)?.unread ?? 0;

  return (
    <div className={UTILITY_PANEL}>
      <div className={PANEL_HEADER}>
        <h2 className="text-base font-semibold text-fg">{t('title')}</h2>
        {snap.unread > 0 ? (
          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[0.6875rem] font-semibold tabular-nums text-primary-fg">
            {badgeText(snap.unread)}
            <span className="sr-only"> {t('unread_count', { count: snap.unread })}</span>
          </span>
        ) : null}
        <button
          className={cn(
            'ms-auto inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs font-medium text-primary-subtle-fg transition-colors',
            'hover:bg-primary-subtle disabled:cursor-default disabled:text-muted-fg disabled:opacity-60 disabled:hover:bg-transparent',
            'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
          )}
          disabled={unreadIn === 0}
          onClick={() => markAllRead()}
          type="button"
        >
          <CheckCheck aria-hidden="true" className="size-3.5" />
          {t('mark_all_read')}
        </button>
      </div>

      <div className="flex items-center gap-2 border-b border-border px-4 pb-3">
        <div aria-label={t('state_filter')} className="inline-flex shrink-0 rounded-lg bg-muted p-0.5" role="group">
          {(['unread', 'all'] as const).map((scope) => (
            <button
              aria-pressed={snap.scope === scope}
              className={cn(
                SEGMENT,
                snap.scope === scope ? 'bg-overlay text-fg shadow-xs ring-1 ring-border' : 'cursor-pointer text-muted-fg hover:text-fg',
              )}
              key={scope}
              onClick={() => setScope(scope)}
              type="button"
            >
              {scope === 'unread' ? t('tab_unread') : t('tab_all')}
            </button>
          ))}
        </div>
        <span className="relative ms-auto min-w-0">
          <select
            aria-label={t('category_filter')}
            className={cn(
              'block h-8 w-full max-w-44 cursor-pointer appearance-none truncate rounded-lg border border-input bg-overlay py-0 ps-2.5 pe-7 text-xs text-fg',
              'hover:border-muted-fg/40 focus:border-ring focus:outline-hidden focus:ring-3 focus:ring-ring/20 dark:scheme-dark',
            )}
            onChange={(event) => setCategory(event.target.value === '' ? null : (event.target.value as NotificationCategory))}
            value={snap.category ?? ''}
          >
            <option value="">{t('category_all')}</option>
            {NOTIFICATION_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {t(`category.${category}`)}
                {unreadOf(category) > 0 ? ` (${badgeText(unreadOf(category))})` : ''}
              </option>
            ))}
          </select>
          <ChevronDown aria-hidden="true" className="pointer-events-none absolute end-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-fg" />
        </span>
      </div>

      {snap.items === null ? (
        snap.status === 'retrying' ? (
          <PanelEmpty icon={<RefreshCw className="size-5" />} text={t('load_failed')} />
        ) : (
          <div aria-live="polite" className="space-y-1 p-2" role="status">
            <span className="sr-only">{t('loading')}</span>
            {[0, 1, 2].map((i) => (
              <div aria-hidden="true" className="flex gap-3 px-2.5 py-2.5" key={i}>
                <span className="size-9 shrink-0 animate-pulse rounded-full bg-secondary motion-reduce:animate-none" />
                <span className="flex-1 space-y-2 pt-1">
                  <span className="block h-3 w-3/4 animate-pulse rounded bg-secondary motion-reduce:animate-none" />
                  <span className="block h-2.5 w-1/2 animate-pulse rounded bg-secondary motion-reduce:animate-none" />
                </span>
              </div>
            ))}
          </div>
        )
      ) : snap.items.length === 0 ? (
        snap.scope === 'unread' ? (
          <PanelEmpty icon={<CheckCheck className="size-5" />} text={t('empty_unread')} tone="success" />
        ) : (
          <PanelEmpty icon={<Inbox className="size-5" />} text={t('empty_all')} />
        )
      ) : (
        <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain p-1.5">
          {snap.items.map((item) => (
            <NotificationRow item={item} key={item.id} locale={locale} now={now} onNavigate={onNavigate} words={words} zone={snap.zone} />
          ))}
        </ul>
      )}

      <Link className={PANEL_FOOTER_LINK} href="/notifications" onClick={onNavigate}>
        {t('see_all')}
        <ArrowRight aria-hidden="true" className="size-3.5 rtl:-scale-x-100" />
      </Link>
    </div>
  );
}

function NotificationRow({
  item,
  words,
  locale,
  now,
  zone,
  onNavigate,
}: {
  readonly item: FeedItem;
  readonly words: Words;
  readonly locale: string;
  readonly now: Date | null;
  readonly zone: string;
  readonly onNavigate: () => void;
}) {
  const text = noteText(words, item);
  const when = now ? whenText(item.createdAt, now, locale, zone) : null;
  const title = (
    <bdi className="line-clamp-2" dir="auto">
      {text.title}
    </bdi>
  );
  const toggle = item.read ? words('mark_unread') : words('mark_read');
  return (
    <li
      className={cn(
        'group relative flex items-start gap-3 rounded-lg px-2.5 py-2.5 transition-colors hover:bg-muted/70',
        'has-[a:focus-visible]:bg-muted/70 has-[a:focus-visible]:outline-2 has-[a:focus-visible]:-outline-offset-2 has-[a:focus-visible]:outline-ring',
      )}
      data-notification-id={item.id}
      data-read={item.read ? 'true' : 'false'}
    >
      <CategoryIcon category={item.category} gone={text.gone} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          {item.openable ? (
            // A plain link on purpose: the address is worked out when it is followed, and a prefetch must not do it.
            // Stretched over the row, so the whole row opens it; the dot's button sits above it.
            <a
              className={cn(
                'min-w-0 flex-1 text-sm leading-5 text-fg no-underline outline-hidden after:absolute after:inset-0 after:rounded-lg after:content-[""] hover:text-fg',
                item.read ? 'font-normal' : 'font-semibold',
              )}
              href={`/notifications/open/${item.id}`}
              onClick={onNavigate}
            >
              {title}
            </a>
          ) : (
            <span className={cn('min-w-0 flex-1 text-sm leading-5', text.gone ? 'text-muted-fg' : 'text-fg', item.read ? 'font-normal' : 'font-semibold')}>
              {title}
            </span>
          )}
          <time
            // Above the stretched link, so the exact moment shows on hover.
            className={cn('relative z-10 shrink-0 pt-px text-xs tabular-nums', item.read ? 'text-muted-fg' : 'font-medium text-primary-subtle-fg')}
            dateTime={item.createdAt}
            title={when?.absolute ?? item.createdAt}
          >
            {when?.relative ?? ''}
          </time>
        </div>
        {text.detail ? (
          <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-fg">
            <bdi dir="auto">{text.detail}</bdi>
          </p>
        ) : null}
        {text.gone && text.title !== words('gone') ? <p className="mt-0.5 text-xs italic text-muted-fg">{words('gone')}</p> : null}
      </div>
      {/* The unread dot is the switch: pressed, an unread one is read; on a read one (shown on hover or focus) it marks it unread again. */}
      <button
        aria-label={toggle}
        className={cn(
          'relative z-10 -me-1 grid size-6 shrink-0 cursor-pointer place-items-center self-center rounded-full transition-opacity',
          'hover:bg-secondary focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring',
          item.read && 'opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-60',
        )}
        onClick={() => (item.read ? markUnread(item.id) : markRead(item.id))}
        title={toggle}
        type="button"
      >
        <span
          aria-hidden="true"
          className={cn('block size-2.5 rounded-full', item.read ? 'border-[1.5px] border-muted-fg' : 'bg-primary ring-4 ring-primary-subtle')}
        />
      </button>
    </li>
  );
}

function PanelEmpty({ icon, text, tone }: { readonly icon: React.ReactNode; readonly text: string; readonly tone?: 'success' }) {
  return (
    <div aria-live="polite" className="flex flex-col items-center gap-3 px-6 py-10 text-center" role="status">
      <span
        aria-hidden="true"
        className={cn('grid size-12 place-items-center rounded-full', tone === 'success' ? 'bg-success-subtle text-success-subtle-fg' : 'bg-muted text-muted-fg')}
      >
        {icon}
      </span>
      <p className="max-w-64 text-sm text-muted-fg">{text}</p>
    </div>
  );
}
