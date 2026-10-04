'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowRight, Search, X } from 'lucide-react';
import type { MenuSection } from '@domain/menu';
import { routeFor } from '@domain/screens';
import { compareGroups, matchScreens, normaliseQuery, MIN_RECORD_QUERY, type ScreenEntry } from '@domain/search';
import type { PresentedGroup, PresentedHit, PresentedOutcome } from '@/server/search/present';

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
  | { readonly kind: 'record'; readonly id: string; readonly hit: PresentedHit }
  | { readonly kind: 'more'; readonly id: string; readonly group: PresentedGroup }
  | { readonly kind: 'all'; readonly id: string };

type Row =
  | { readonly kind: 'heading'; readonly id: string; readonly label: string }
  | { readonly kind: 'item'; readonly item: Item; readonly index: number };

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
        const items: Item[] = group.rows.map((hit) => ({ kind: 'record', id: `r:${group.key}:${hit.id}`, hit }));
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
    if (wantsRecords) result.push({ kind: 'item', item: { kind: 'all', id: 'all' }, index: index++ });
    return result;
  }, [screens, answer, wantsRecords, search]);

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

  const failed = fresh ? answer.data.failed : [];
  const status =
    problem === 'unavailable'
      ? search('unavailable')
      : problem === 'signed_out'
        ? search('signed_out')
        : wantsRecords && !fresh
          ? search('searching')
          : wantsRecords && fresh && answer.data.groups.length === 0 && screens.list.length === 0
            ? search('empty', { query: phrase })
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
      </button>

      {open ? (
        <div className="erp-search" role="dialog" aria-modal="true" aria-label={shell('search')}>
          <div className="erp-search__scrim" onClick={() => setOpen(false)} />
          <div className="erp-search__panel">
            <div className="erp-search__bar">
              <Search aria-hidden="true" />
              <input
                aria-activedescendant={items[current] ? `${base}${items[current]!.id}` : undefined}
                aria-controls={`${base}list`}
                aria-expanded="true"
                aria-label={shell('search')}
                autoComplete="off"
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
              <button aria-label={shell('close')} className="erp-search__close" onClick={() => setOpen(false)} type="button">
                <X aria-hidden="true" />
              </button>
            </div>
            <ul className="erp-search__results" id={`${base}list`} role="listbox">
              {rows.map((row) =>
                row.kind === 'heading' ? (
                  <li className="erp-search__empty" key={row.id} role="presentation">
                    {row.label}
                  </li>
                ) : (
                  <li
                    aria-selected={row.index === current}
                    className={`erp-search__item${row.index === current ? ' erp-search__item--active' : ''}`}
                    id={`${base}${row.item.id}`}
                    key={row.item.id}
                    onClick={() => go(row.item)}
                    onMouseEnter={() => setActive(row.index)}
                    role="option"
                  >
                    <ItemBody
                      item={row.item}
                      notBuilt={pending('not_built')}
                      seeAll={search('see_all', { query: phrase })}
                      seeMore={search('see_more')}
                    />
                    <ArrowRight aria-hidden="true" className="coa-directional-icon" />
                  </li>
                ),
              )}
              {status ? (
                <li aria-live="polite" className="erp-search__empty" role="status">
                  {status}
                </li>
              ) : null}
              {failed.length > 0 ? (
                <li className="erp-search__empty" role="status">
                  {search('failed', { types: failed.join(', ') })}
                </li>
              ) : null}
            </ul>
            <p className="erp-search__hint">{shell('search_hint')}</p>
          </div>
        </div>
      ) : null}
    </>
  );
}

function ItemBody({
  item,
  notBuilt,
  seeAll,
  seeMore,
}: {
  readonly item: Item;
  readonly notBuilt: string;
  readonly seeAll: string;
  readonly seeMore: string;
}) {
  switch (item.kind) {
    case 'screen':
      return (
        <span className="erp-search__text">
          <strong>{item.screen.label}</strong>
          <small>
            {item.screen.section}
            {item.screen.planned ? ` · ${notBuilt}` : ''}
          </small>
        </span>
      );
    case 'more':
      return (
        <span className="erp-search__text">
          <strong>{seeMore}</strong>
          <small>{item.group.label}</small>
        </span>
      );
    case 'all':
      return (
        <span className="erp-search__text">
          <strong>{seeAll}</strong>
        </span>
      );
    case 'record': {
      const { hit } = item;
      const detail = [hit.related, hit.party, hit.date, hit.amount].filter((value): value is string => Boolean(value));
      return (
        <>
          <span className="erp-search__text">
            <strong>
              <bdi dir="auto">{hit.number}</bdi>
              {hit.title ? (
                <>
                  {' · '}
                  <bdi dir="auto">{hit.title}</bdi>
                </>
              ) : null}
            </strong>
            {detail.length > 0 ? (
              <small>
                {detail.map((value, index) => (
                  <span key={index}>
                    {index > 0 ? ' · ' : ''}
                    <bdi dir="auto">{value}</bdi>
                  </span>
                ))}
              </small>
            ) : null}
          </span>
          {hit.status ? (
            <span className={`status status--${hit.status.chip}`} data-status={hit.status.chip}>
              {hit.status.label}
            </span>
          ) : null}
        </>
      );
    }
  }
}
