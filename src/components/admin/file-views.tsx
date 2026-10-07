'use client';

import { useId, useSyncExternalStore, type ReactNode } from 'react';
import { LayoutGrid, List } from 'lucide-react';
import { ToggleGroup, ToggleGroupItem } from '@/components/intent/toggle-group';

/**
 * Blocks or a list — how a record's gathered files are drawn, one choice per
 * person that every list on every page follows (by direction 2026-10-07: "add
 * two views, one by block (horizontally aligned), one where they come right
 * after each other, and it saves the user preference").
 *
 * The choice is a per-person convenience, so it lives in the browser —
 * `localStorage`, keyed by the person's user id so two people sharing a
 * machine keep their own — read and written in try/catch: a private window or
 * blocked storage leaves the default (Blocks) and loses nothing on screen. One
 * module-level store serves every list on the page, so pressing List in one
 * dialog redraws them all, and another tab follows through the `storage`
 * event. The server always draws Blocks; the browser settles into the
 * person's own straight after hydration (`useSyncExternalStore`'s server
 * snapshot), so nothing is written during a render.
 */
export type FileView = 'blocks' | 'list';

const PREFIX = 'qimah:file-view:';
const listeners = new Set<() => void>();
/** When storage refuses, the choice still holds for this page. */
const memory = new Map<string, FileView>();

function read(userId: string): FileView {
  try {
    return window.localStorage.getItem(`${PREFIX}${userId}`) === 'list' ? 'list' : 'blocks';
  } catch {
    return 'blocks';
  }
}

function keep(userId: string, view: FileView): void {
  try {
    window.localStorage.setItem(`${PREFIX}${userId}`, view);
    memory.delete(userId);
  } catch {
    /* the view still changes for this visit */
    memory.set(userId, view);
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith(PREFIX)) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function useFileView(userId: string): FileView {
  return useSyncExternalStore(
    subscribe,
    () => memory.get(userId) ?? read(userId),
    () => 'blocks',
  );
}

/**
 * The Blocks / List switch on its own — for a record's actions row, next to
 * its Stop / follow-up (2026-10-07, by direction: "next to [the] stop follow
 * button … two views"). The same store as every list's switch, so pressing it
 * redraws the lists in all the paperclips at once.
 */
export function FileViewSwitch({
  userId,
  labels,
}: {
  readonly userId: string;
  readonly labels: { readonly group: string; readonly blocks: string; readonly list: string };
}) {
  const view = useFileView(userId);
  return (
    <ToggleGroup
      aria-label={labels.group}
      data-file-view-switch=""
      disallowEmptySelection
      onSelectionChange={(keys) => {
        const next = [...keys][0];
        if (next === 'blocks' || next === 'list') keep(userId, next);
      }}
      selectedKeys={[view]}
      selectionMode="single"
      size="sm"
    >
      <ToggleGroupItem data-file-view-option="blocks" id="blocks">
        <LayoutGrid aria-hidden="true" />
        <span>{labels.blocks}</span>
      </ToggleGroupItem>
      <ToggleGroupItem data-file-view-option="list" id="list">
        <List aria-hidden="true" />
        <span>{labels.list}</span>
      </ToggleGroupItem>
    </ToggleGroup>
  );
}

/**
 * A titled list of files with the Blocks / List switch at the end of its
 * title. Both drawings come from the server; only the chosen one is shown.
 */
export function FileViews({
  userId,
  title,
  meta,
  labels,
  blocks,
  list,
}: {
  readonly userId: string;
  readonly title: string;
  readonly meta?: string;
  readonly labels: { readonly group: string; readonly blocks: string; readonly list: string };
  readonly blocks: ReactNode;
  readonly list: ReactNode;
}) {
  const view = useFileView(userId);
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="mt-4 flex flex-col gap-3" data-file-views="" data-view={view}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border pb-2">
        <h3 className="text-sm font-semibold text-fg" id={headingId}>
          {title}
        </h3>
        {meta ? <span className="text-xs text-muted-fg tabular-nums">{meta}</span> : null}
        <ToggleGroup
          aria-label={labels.group}
          className="ms-auto"
          disallowEmptySelection
          onSelectionChange={(keys) => {
            const next = [...keys][0];
            if (next === 'blocks' || next === 'list') keep(userId, next);
          }}
          selectedKeys={[view]}
          selectionMode="single"
          size="xs"
        >
          <ToggleGroupItem data-file-view-option="blocks" id="blocks">
            <LayoutGrid aria-hidden="true" />
            <span>{labels.blocks}</span>
          </ToggleGroupItem>
          <ToggleGroupItem data-file-view-option="list" id="list">
            <List aria-hidden="true" />
            <span>{labels.list}</span>
          </ToggleGroupItem>
        </ToggleGroup>
      </header>
      {view === 'list' ? list : blocks}
    </section>
  );
}
