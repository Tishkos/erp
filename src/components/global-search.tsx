'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowRight, Search, X } from 'lucide-react';
import type { MenuSection } from '@domain/menu';
import { routeFor } from '@domain/screens';

/**
 * Global search — Ctrl/⌘ K from anywhere in the shell.
 *
 * Searches the screens the signed-in person may open (the same filtered tree
 * the navigation shows, so it can neither reveal nor reach anything the
 * navigation would not). Type to filter, arrows to move, Enter to go.
 */
interface Entry {
  readonly key: string;
  readonly label: string;
  readonly section: string;
  readonly href: string;
  readonly planned: boolean;
}

export function GlobalSearch({ sections }: { readonly sections: readonly MenuSection[] }) {
  const shell = useTranslations('shell');
  const page = useTranslations('page');
  const nav = useTranslations('nav');
  const phase = useTranslations('phase');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const entries = useMemo<Entry[]>(
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

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? entries.filter((e) => e.label.toLowerCase().includes(q) || e.section.toLowerCase().includes(q))
      : entries.filter((e) => !e.planned);
    // Live screens first, then alphabetically — a planned page is still reachable, just lower.
    return list.sort((a, b) => Number(a.planned) - Number(b.planned) || a.label.localeCompare(b.label)).slice(0, 12);
  }, [entries, query]);

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
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [open]);

  const go = (entry: Entry | undefined) => {
    if (!entry) return;
    setOpen(false);
    router.push(entry.href);
  };

  return (
    <>
      <button
        aria-keyshortcuts="Control+K Meta+K"
        className="erp-search-trigger"
        onClick={() => setOpen(true)}
        title={`${shell('search')} (${shell('search_shortcut')})`}
        type="button"
      >
        <Search aria-hidden="true" />
        <span className="erp-search-trigger__label">{shell('search')}</span>
        <kbd aria-hidden="true">{shell('search_shortcut')}</kbd>
      </button>

      {open ? (
        <div className="erp-search" role="dialog" aria-modal="true" aria-label={shell('search')}>
          <div className="erp-search__scrim" onClick={() => setOpen(false)} />
          <div className="erp-search__panel">
            <div className="erp-search__bar">
              <Search aria-hidden="true" />
              <input
                aria-label={shell('search')}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActive(0);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    setActive((i) => Math.min(i + 1, results.length - 1));
                  } else if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    setActive((i) => Math.max(i - 1, 0));
                  } else if (event.key === 'Enter') {
                    event.preventDefault();
                    go(results[active]);
                  }
                }}
                placeholder={shell('search_placeholder')}
                ref={input}
                type="search"
                value={query}
              />
              <button aria-label={shell('close')} className="erp-search__close" onClick={() => setOpen(false)} type="button">
                <X aria-hidden="true" />
              </button>
            </div>
            <ul className="erp-search__results" role="listbox">
              {results.length === 0 ? (
                <li className="erp-search__empty">{shell('search_empty')}</li>
              ) : (
                results.map((entry, index) => (
                  <li
                    aria-selected={index === active}
                    className={`erp-search__item${index === active ? ' erp-search__item--active' : ''}`}
                    key={entry.key}
                    onClick={() => go(entry)}
                    onMouseEnter={() => setActive(index)}
                    role="option"
                  >
                    <span className="erp-search__text">
                      <strong>{entry.label}</strong>
                      <small>
                        {entry.section}
                        {entry.planned ? ` · ${phase('not_built')}` : ''}
                      </small>
                    </span>
                    <ArrowRight aria-hidden="true" />
                  </li>
                ))
              )}
            </ul>
            <p className="erp-search__hint">{shell('search_hint')}</p>
          </div>
        </div>
      ) : null}
    </>
  );
}
