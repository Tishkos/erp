'use client';

import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Bell } from 'lucide-react';
import { badgeText, NOTIFICATION_CATEGORIES, type NotificationCategory } from '@domain/notification-center';
import { noteText, whenText, type Words } from './note-text';
import { adopt, markAllRead, markRead, markUnread, mount, setCategory, setOpen, setScope, useBell, type BellSnapshot } from './notification-store';

/**
 * The bell's three small parts in the application header (`erp-shell.tsx`).
 *
 * The header's bell was a drawer of the ten latest, drawn once by the server.
 * It now carries the unread count, lists what is waiting (or everything) with
 * a category filter, opens a notification through `/notifications/open/<id>`
 * — which works out where it leads *now*, for this reader, and says so when
 * they can no longer go there — and marks read, unread and all read. The count
 * is a small badge on the bell (`erp-icon-button__badge`, Intent UI
 * 2026-10-06); the list and the buttons keep their classes, which the shell's
 * stylesheet draws in Intent UI's look inside the popover.
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

/** The popover: filter, list, and the way into the full screen. */
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

  return (
    <>
      <div className="actions">
        <button
          aria-pressed={snap.scope === 'unread'}
          className={`coa-button coa-button--filter${snap.scope === 'unread' ? ' coa-button--active' : ''}`}
          onClick={() => setScope('unread')}
          type="button"
        >
          {t('tab_unread')}
        </button>
        <button
          aria-pressed={snap.scope === 'all'}
          className={`coa-button coa-button--filter${snap.scope === 'all' ? ' coa-button--active' : ''}`}
          onClick={() => setScope('all')}
          type="button"
        >
          {t('tab_all')}
        </button>
        <select
          aria-label={t('category_filter')}
          onChange={(event) => setCategory(event.target.value === '' ? null : (event.target.value as NotificationCategory))}
          value={snap.category ?? ''}
        >
          <option value="">{t('category_all')}</option>
          {NOTIFICATION_CATEGORIES.map((category) => (
            <option key={category} value={category}>
              {t(`category.${category}`)}
            </option>
          ))}
        </select>
        <button className="coa-button coa-button--secondary" disabled={unreadIn === 0} onClick={() => markAllRead()} type="button">
          {t('mark_all_read')}
        </button>
      </div>

      {snap.items === null ? (
        <p className="erp-utility-popover__empty">{snap.status === 'retrying' ? t('load_failed') : t('loading')}</p>
      ) : snap.items.length === 0 ? (
        <p className="erp-utility-popover__empty">{snap.scope === 'unread' ? t('empty_unread') : t('empty_all')}</p>
      ) : (
        <ul className="erp-notifications__list">
          {snap.items.map((item) => {
            const text = noteText(words, item);
            const when = now ? whenText(item.createdAt, now, locale, snap.zone) : null;
            return (
              <li className={item.read ? undefined : 'erp-notifications__unread'} data-notification-id={item.id} key={item.id}>
                {item.openable ? (
                  // A plain link on purpose: the address is worked out when it is followed, and a prefetch must not do it.
                  <a href={`/notifications/open/${item.id}`} onClick={onNavigate}>
                    <strong>
                      <bdi dir="auto">{text.title}</bdi>
                    </strong>
                    {text.detail ? (
                      <p>
                        <bdi dir="auto">{text.detail}</bdi>
                      </p>
                    ) : null}
                  </a>
                ) : (
                  <>
                    <strong>
                      <bdi dir="auto">{text.title}</bdi>
                    </strong>
                    {text.detail ? (
                      <p>
                        <bdi dir="auto">{text.detail}</bdi>
                      </p>
                    ) : null}
                    {text.gone && text.title !== t('gone') ? <p className="muted">{t('gone')}</p> : null}
                  </>
                )}
                <time dateTime={item.createdAt} title={when?.absolute ?? item.createdAt}>
                  {when?.relative ?? ''}
                </time>{' '}
                <button className="coa-compact-button" onClick={() => (item.read ? markUnread(item.id) : markRead(item.id))} type="button">
                  {item.read ? t('mark_unread') : t('mark_read')}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <Link className="erp-utility-popover__link" href="/notifications" onClick={onNavigate}>
        {t('see_all')}
      </Link>
    </>
  );
}
