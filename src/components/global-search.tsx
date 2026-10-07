'use client';

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { CornerDownLeft, Lightbulb, LoaderCircle, Search, SearchX, X } from 'lucide-react';
import { Dialog } from 'react-aria-components/Dialog';
import { Modal, ModalOverlay } from 'react-aria-components/Modal';
import type { MenuSection } from '@domain/menu';
import { routeFor } from '@domain/screens';
import { compareGroups, matchScreens, normaliseQuery, MIN_RECORD_QUERY, type ScreenEntry } from '@domain/search';
import type { PresentedGroup, PresentedHit, PresentedOutcome } from '@/server/search/present';
import { badgeStyles } from '@/components/intent/badge';
import { cn } from '@/components/intent/cn';
import { SearchTypeIcon } from './search-type-icon';

/**
 * Global search — Ctrl/⌘ K from anywhere in the shell.
 *
 * Two kinds of answer, in one list:
 *
 *   screens   the filtered tree the navigation shows (the same list, so it can
 *             neither reveal nor reach what the navigation would not) — matched
 *             here, as before;
 *   records   customers, invoices, containers, files… found by the server,
 *             as the signed-in person (`GET /search/results`): the browser sends
 *             the phrase and receives the answer, never the tables.
 *
 * Groups are ordered by how well their best hit matches (a number typed whole
 * first), master records before documents. Type to filter, arrows to move,
 * Enter to open, Escape to close; the last row opens every result on /search.
 *
 * The look is Intent UI's command menu (2026-10-06): a centred window over a
 * blurred backdrop — at a phone's width a sheet across the top — with a large
 * field, the results grouped under small headings, each row led by its type's
 * icon, and the keys along the foot. The window itself is React Aria's modal
 * (focus kept inside, the page behind it neither scrolled nor read out, focus
 * given back on close); the list is the palette's own combobox and listbox,
 * because its rows come from the server and keep the ranking above.
 */

/** Wait this long after the last keystroke before asking the server. */
const DEBOUNCE_MS = 180;
/** Where the screens sit among record groups of the same strength: after the masters, before the documents. */
const SCREEN_PRIORITY = 20;
const SCREEN_LIMIT = 6;
const IDLE_SCREENS = 12;

interface Screen extends ScreenEntry {
  readonly planned: boolean;
}

type Item =
  | { readonly kind: 'screen'; readonly id: string; readonly screen: Screen }
  | { readonly kind: 'record'; readonly id: string; readonly type: string; readonly hit: PresentedHit }
  | { readonly kind: 'more'; readonly id: string; readonly group: PresentedGroup }
  | { readonly kind: 'all'; readonly id: string };

type Row =
  | { readonly kind: 'heading'; readonly id: string; readonly label: string }
  | { readonly kind: 'item'; readonly item: Item; readonly index: number };

/** A result's status as Intent's badge, in the tone the register's chip wears. */
const STATUS_TONE: Readonly<Record<string, 'success' | 'info' | 'danger' | 'secondary'>> = {
  posted: 'success',
  settled: 'success',
  approved: 'success',
  submitted: 'info',
  executed: 'info',
  partially_executed: 'info',
  rejected: 'danger',
  cancelled: 'danger',
  reversed: 'danger',
  closed: 'danger',
};

function Key({ children }: { readonly children: ReactNode }) {
  return (
    <kbd className="inline-grid h-5 min-w-5 place-items-center rounded-[0.3rem] border border-border bg-overlay px-1 font-sans text-[0.6875rem] font-medium leading-none text-fg shadow-xs">
      {children}
    </kbd>
  );
}

export function GlobalSearch({ sections }: { readonly sections: readonly MenuSection[] }) {
  const shell = useTranslations('shell');
  const page = useTranslations('page');
  const nav = useTranslations('nav');
  const pending = useTranslations('screen');
  const search = useTranslations('search');
  const router = useRouter();
  const base = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  /** The server's answer, with the phrase it answers (so a stale one is not mistaken for this phrase's). */
  const [answer, setAnswer] = useState<{ readonly phrase: string; readonly data: PresentedOutcome } | null>(null);
  const [problem, setProblem] = useState<'unavailable' | 'signed_out' | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const entries = useMemo<Screen[]>(
    () =>
      sections.flatMap((section) =>
        section.items.map((item) => ({
          key: `${section.key}:${item.key}`,
          label: page(item.key),
          section: nav(section.key),
          href: routeFor(item, section.key),
          planned: item.href === null,
        })),
      ),
    [sections, page, nav],
  );

  const phrase = query.trim();
  const wantsRecords = normaliseQuery(phrase).display.length >= MIN_RECORD_QUERY;
  const fresh = answer !== null && answer.phrase === phrase;

  // The screens: the live ones when nothing is typed (as the palette always showed), else the matching ones.
  const screens = useMemo<{ list: Screen[]; best: number }>(() => {
    if (phrase === '') {
      const list = [...entries]
        .filter((e) => !e.planned)
        .sort((a, b) => a.label.localeCompare(b.label))
        .slice(0, IDLE_SCREENS);
      return { list, best: 2 };
    }
    const ranked = matchScreens(entries, normaliseQuery(phrase), entries.length);
    const byKey = new Map(entries.map((e) => [e.key, e] as const));
    // A planned page is still reachable, just lower.
    const list = ranked
      .map((hit) => ({ screen: byKey.get(hit.key)!, tier: hit.tier }))
      .sort((a, b) => Number(a.screen.planned) - Number(b.screen.planned))
      .slice(0, SCREEN_LIMIT);
    return { list: list.map((hit) => hit.screen), best: ranked[0]?.tier ?? 3 };
  }, [entries, phrase]);

  // Records from the server, for a phrase long enough to ask.
  useEffect(() => {
    if (!open) return;
    if (!wantsRecords) {
      setAnswer(null);
      setProblem(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/search/results?q=${encodeURIComponent(phrase)}`, {
          signal: controller.signal,
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
        });
        if (response.status === 401) {
          setAnswer(null);
          setProblem('signed_out');
          return;
        }
        if (!response.ok) throw new Error(String(response.status));
        setAnswer({ phrase, data: (await response.json()) as PresentedOutcome });
        setProblem(null);
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') return;
        setAnswer(null);
        setProblem('unavailable');
      }
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, phrase, wantsRecords]);

  const nothing = wantsRecords && fresh && answer.data.groups.length === 0 && screens.list.length === 0;

  // Screens and record groups, merged by the same ranking the server uses.
  const rows = useMemo<Row[]>(() => {
    const groups: { key: string; best: number; priority: number; label: string; items: Item[] }[] = [];
    if (screens.list.length > 0) {
      groups.push({
        key: 'screen',
        best: screens.best,
        priority: SCREEN_PRIORITY,
        label: search('types.screen'),
        items: screens.list.map((screen) => ({ kind: 'screen', id: `s:${screen.key}`, screen })),
      });
    }
    if (wantsRecords) {
      for (const group of answer?.data.groups ?? []) {
        const items: Item[] = group.rows.map((hit) => ({ kind: 'record', id: `r:${group.key}:${hit.id}`, type: group.key, hit }));
        if (group.more) items.push({ kind: 'more', id: `m:${group.key}`, group });
        groups.push({ key: group.key, best: group.best, priority: group.priority, label: group.label, items });
      }
    }
    groups.sort(compareGroups);
    const result: Row[] = [];
    let index = 0;
    for (const group of groups) {
      result.push({ kind: 'heading', id: `h:${group.key}`, label: group.label });
      for (const item of group.items) result.push({ kind: 'item', item, index: index++ });
    }
    // "See all" once there is something to see — a phrase the server found nothing for says so instead.
    if (wantsRecords && !nothing) result.push({ kind: 'item', item: { kind: 'all', id: 'all' }, index: index++ });
    return result;
  }, [screens, answer, wantsRecords, nothing, search]);

  const items = useMemo(() => rows.flatMap((row) => (row.kind === 'item' ? [row.item] : [])), [rows]);
  const current = Math.min(active, Math.max(items.length - 1, 0));

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((value) => !value);
      } else if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      setAnswer(null);
      setProblem(null);
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [open]);

  // Keep the highlighted row in view as the arrows move through a long list.
  useEffect(() => {
    if (!open) return;
    const id = items[current]?.id;
    if (id) document.getElementById(`${base}${id}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, items, current, base]);

  const hrefOf = (item: Item | undefined): string | null => {
    if (!item) return null;
    switch (item.kind) {
      case 'screen':
        return item.screen.href;
      case 'record':
        return item.hit.href;
      case 'more':
        return `/search?q=${encodeURIComponent(phrase)}&type=${encodeURIComponent(item.group.key)}`;
      case 'all':
        return `/search?q=${encodeURIComponent(phrase)}`;
    }
  };

  const go = (item: Item | undefined) => {
    const href = hrefOf(item);
    if (!href) return;
    setOpen(false);
    router.push(href);
  };

  const searching = wantsRecords && !fresh && problem === null;
  const failed = fresh ? answer.data.failed : [];
  const status =
    problem === 'unavailable'
      ? search('unavailable')
      : problem === 'signed_out'
        ? search('signed_out')
        : phrase !== '' && !wantsRecords && screens.list.length === 0
          ? search('too_short')
          : null;

  return (
    <>
      <button
        aria-keyshortcuts="Control+K Meta+K"
        aria-label={shell('search')}
        className="erp-search-trigger"
        onClick={() => setOpen(true)}
        title={`${shell('search')} (${shell('search_shortcut')})`}
        type="button"
      >
        <Search aria-hidden="true" />
        {/* Drawn only when the bar has room to spare (HEADER_SQUEEZE › 'search'); else the icon alone. */}
        <span aria-hidden="true" className="erp-search-trigger__label">
          {shell('search')}
        </span>
        <kbd aria-hidden="true" className="erp-search-trigger__kbd">
          {shell('search_shortcut')}
        </kbd>
      </button>

      <ModalOverlay
        className={cn(
          'fixed inset-0 z-[90] flex items-start justify-center bg-black/25 backdrop-blur-[3px] dark:bg-black/55 sm:px-4 sm:pt-[12vh]',
          'entering:animate-in entering:fade-in entering:duration-200 entering:ease-out',
          'exiting:animate-out exiting:fade-out exiting:duration-150 exiting:ease-in',
          'motion-reduce:animate-none',
        )}
        isDismissable
        isOpen={open}
        onOpenChange={setOpen}
      >
        <Modal
          className={cn(
            'w-full outline-hidden sm:max-w-[42rem]',
            'entering:animate-in entering:slide-in-from-top-4 entering:duration-200 entering:ease-out sm:entering:slide-in-from-top-0 sm:entering:zoom-in-95',
            'exiting:animate-out exiting:fade-out exiting:duration-150 exiting:ease-in sm:exiting:zoom-out-95',
            'motion-reduce:animate-none',
          )}
        >
          <Dialog aria-label={shell('search')} className="outline-hidden">
            <div
              className={cn(
                // A sheet across the top on a phone; Intent's command menu, centred, from `sm` up.
                'erp-search__panel relative flex max-h-[85dvh] w-full flex-col overflow-hidden animate-none',
                'rounded-t-none rounded-b-2xl border-x-0 border-t-0 border-b border-border bg-overlay text-overlay-fg shadow-xl',
                'sm:max-h-[min(38rem,78dvh)] sm:rounded-xl sm:border sm:ring-1 sm:ring-fg/5',
              )}
            >
              <div className="flex items-center gap-3 border-b border-border px-4 sm:px-5">
                {searching ? (
                  <LoaderCircle aria-hidden="true" className="size-5 shrink-0 animate-spin text-primary motion-reduce:animate-none" />
                ) : (
                  <Search aria-hidden="true" className="size-5 shrink-0 text-muted-fg" />
                )}
                <input
                  aria-activedescendant={items[current] ? `${base}${items[current]!.id}` : undefined}
                  aria-controls={`${base}list`}
                  aria-expanded="true"
                  aria-label={shell('search')}
                  autoComplete="off"
                  autoFocus
                  className={cn(
                    'h-14 min-w-0 flex-1 appearance-none rounded-none border-0 bg-transparent p-0 text-base text-fg shadow-none outline-hidden',
                    'placeholder:text-muted-fg focus:shadow-none focus:outline-hidden focus-visible:outline-hidden',
                    '[&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden',
                  )}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setActive(0);
                  }}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing) return;
                    if (event.key === 'ArrowDown') {
                      event.preventDefault();
                      setActive(Math.min(current + 1, items.length - 1));
                    } else if (event.key === 'ArrowUp') {
                      event.preventDefault();
                      setActive(Math.max(current - 1, 0));
                    } else if (event.key === 'Enter') {
                      event.preventDefault();
                      go(items[current]);
                    }
                  }}
                  placeholder={search('placeholder')}
                  ref={input}
                  role="combobox"
                  spellCheck={false}
                  type="search"
                  value={query}
                />
                <button
                  aria-label={shell('close')}
                  className={cn(
                    'grid shrink-0 cursor-pointer place-items-center rounded-md text-muted-fg transition-colors hover:bg-secondary hover:text-fg',
                    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                    'size-8 sm:h-6 sm:w-auto sm:border sm:border-border sm:bg-muted sm:px-1.5 sm:font-sans sm:text-[0.6875rem] sm:font-medium',
                  )}
                  onClick={() => setOpen(false)}
                  type="button"
                >
                  <X aria-hidden="true" className="size-4 sm:hidden" />
                  <span aria-hidden="true" className="hidden sm:inline">
                    {search('key_esc')}
                  </span>
                </button>
              </div>

              {phrase === '' ? (
                <p className="flex items-center gap-2 px-4 pt-3 text-xs text-muted-fg sm:px-5">
                  <Lightbulb aria-hidden="true" className="size-3.5 shrink-0" />
                  {search('try')}
                </p>
              ) : null}

              <ul
                aria-label={shell('search')}
                className="min-h-0 flex-1 scroll-py-2 overflow-y-auto overscroll-contain p-2 empty:hidden"
                id={`${base}list`}
                role="listbox"
              >
                {rows.map((row) =>
                  row.kind === 'heading' ? (
                    <li
                      className="px-2.5 pb-1.5 pt-3.5 text-xs font-medium text-muted-fg first:pt-1.5"
                      key={row.id}
                      role="presentation"
                    >
                      {row.label}
                    </li>
                  ) : (
                    <li
                      aria-selected={row.index === current}
                      className={cn(
                        'group flex min-h-12 cursor-pointer select-none items-center gap-3 rounded-lg px-2.5 py-2 text-fg',
                        'forced-colors:aria-selected:outline-2 forced-colors:aria-selected:outline-[Highlight]',
                        row.index === current && 'bg-accent text-accent-fg',
                      )}
                      data-active={row.index === current ? 'true' : undefined}
                      id={`${base}${row.item.id}`}
                      key={row.item.id}
                      onClick={() => go(row.item)}
                      // The field keeps the focus (and so the arrows) while a row is pressed.
                      onMouseDown={(event) => event.preventDefault()}
                      // Move, not enter: a row scrolled under a still pointer by the arrows must not take the highlight.
                      onMouseMove={() => {
                        if (row.index !== current) setActive(row.index);
                      }}
                      role="option"
                    >
                      <ItemBody
                        active={row.index === current}
                        item={row.item}
                        notBuilt={pending('not_built')}
                        seeAll={search('see_all', { query: phrase })}
                        seeMore={search('see_more')}
                      />
                      <CornerDownLeft
                        aria-hidden="true"
                        className={cn('hidden size-4 shrink-0 text-muted-fg opacity-0 rtl:-scale-x-100 sm:block', row.index === current && 'opacity-100')}
                      />
                    </li>
                  ),
                )}
              </ul>

              <div aria-live="polite" role="status">
                {nothing ? (
                  <div className="flex flex-col items-center gap-2 px-6 pb-10 pt-8 text-center">
                    <span aria-hidden="true" className="mb-1 grid size-11 place-items-center rounded-full bg-muted text-muted-fg">
                      <SearchX className="size-5" />
                    </span>
                    <p className="text-sm font-medium text-fg">{search('empty', { query: phrase })}</p>
                    <p className="text-xs text-muted-fg">{search('none_hint')}</p>
                  </div>
                ) : searching ? (
                  <p className="flex items-center gap-2 border-t border-border px-4 py-2.5 text-xs text-muted-fg sm:px-5">
                    <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin motion-reduce:animate-none" />
                    {search('searching')}
                  </p>
                ) : status ? (
                  <p className="px-6 py-6 text-center text-sm text-muted-fg">{status}</p>
                ) : null}
                {failed.length > 0 ? (
                  <p className="border-t border-border px-4 py-2 text-xs text-muted-fg sm:px-5">{search('failed', { types: failed.join(', ') })}</p>
                ) : null}
              </div>

              <div className="hidden items-center gap-4 border-t border-border bg-muted/60 px-5 py-2.5 text-xs text-muted-fg sm:flex">
                <span className="inline-flex items-center gap-1.5">
                  <Key>↑</Key>
                  <Key>↓</Key>
                  {search('key_move')}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Key>
                    <CornerDownLeft aria-hidden="true" className="size-3 rtl:-scale-x-100" />
                  </Key>
                  {search('key_open')}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Key>{search('key_esc')}</Key>
                  {search('key_close')}
                </span>
              </div>
            </div>
          </Dialog>
        </Modal>
      </ModalOverlay>
    </>
  );
}

function ItemBody({
  item,
  active,
  notBuilt,
  seeAll,
  seeMore,
}: {
  readonly item: Item;
  readonly active: boolean;
  readonly notBuilt: string;
  readonly seeAll: string;
  readonly seeMore: string;
}) {
  // The type's tile turns to the accent on the highlighted row; its secondary line keeps its contrast on the row's tint.
  const tile = active ? 'border-transparent bg-primary text-primary-fg' : '';
  const meta = cn('block truncate text-xs', active ? 'text-accent-fg/75' : 'text-muted-fg');
  switch (item.kind) {
    case 'screen':
      return (
        <>
          <SearchTypeIcon className={tile} type="screen" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{item.screen.label}</span>
            <span className={meta}>
              {item.screen.section}
              {item.screen.planned ? ` · ${notBuilt}` : ''}
            </span>
          </span>
        </>
      );
    case 'more':
      return (
        <>
          <SearchTypeIcon className={cn('border-dashed', tile)} type="more" />
          <span className="min-w-0 flex-1">
            <span className={cn('block truncate text-sm font-medium', active ? '' : 'text-primary-subtle-fg')}>{seeMore}</span>
            <span className={meta}>{item.group.label}</span>
          </span>
        </>
      );
    case 'all':
      return (
        <>
          <SearchTypeIcon className={tile} type="all" />
          <span className="min-w-0 flex-1">
            <span className={cn('block truncate text-sm font-medium', active ? '' : 'text-primary-subtle-fg')}>{seeAll}</span>
          </span>
        </>
      );
    case 'record': {
      const { hit } = item;
      const detail = [hit.related, hit.party, hit.date, hit.amount].filter((value): value is string => Boolean(value));
      return (
        <>
          <SearchTypeIcon className={tile} type={item.type} />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-baseline gap-2">
              <bdi className="min-w-0 truncate text-sm font-medium tabular-nums" dir="auto">
                {hit.number}
              </bdi>
              {hit.title ? (
                <bdi className="min-w-0 shrink-[4] truncate text-sm" dir="auto">
                  {hit.title}
                </bdi>
              ) : null}
            </span>
            {detail.length > 0 ? (
              <span className={meta}>
                {detail.map((value, index) => (
                  <span key={index}>
                    {index > 0 ? ' · ' : ''}
                    <bdi dir="auto">{value}</bdi>
                  </span>
                ))}
              </span>
            ) : null}
          </span>
          {hit.status ? (
            <span
              className={badgeStyles({
                intent: STATUS_TONE[hit.status.chip] ?? 'secondary',
                isCircle: false,
                // A grey badge on the highlighted (grey) row keeps its edge.
                className: cn('shrink-0', !STATUS_TONE[hit.status.chip] && active && 'bg-overlay'),
              })}
              data-status={hit.status.chip}
            >
              {hit.status.label}
            </span>
          ) : null}
        </>
      );
    }
  }
}
