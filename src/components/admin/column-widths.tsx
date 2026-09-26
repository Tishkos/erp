'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import styles from './admin.module.css';

/**
 * Column boundaries a person can drag, and the widths they chose.
 *
 * Extracted from the invoice lines grid so that every grid of document lines
 * behaves the same way — the sponsor's words: *"this is our main design for
 * table lines"*. A grid names its own columns; everything about moving a
 * boundary and remembering where it was put is here.
 *
 * Keys are the grid's own and must stay stable: they name a stored width, so
 * renaming or translating a heading must not lose the layout behind it.
 */

/** Narrow enough to tuck a column away, wide enough to still be a column. */
export const MIN_COLUMN_PX = 40;

export type ColumnWidths<Key extends string> = Partial<Record<Key, number>>;

/**
 * A stored preference is input like any other. Only keys this grid knows and
 * only sensible numbers survive, so an old or hand-edited entry cannot break a
 * screen.
 */
function parse<Key extends string>(keys: readonly Key[], raw: string | null): ColumnWidths<Key> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: ColumnWidths<Key> = {};
    for (const key of keys) {
      const value = (parsed as Record<string, unknown>)[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= MIN_COLUMN_PX) {
        out[key] = Math.round(value);
      }
    }
    return out;
  } catch {
    return {};
  }
}

export interface GripProps {
  readonly onPointerDown: (event: React.PointerEvent<HTMLSpanElement>) => void;
  readonly onPointerMove: (event: React.PointerEvent<HTMLSpanElement>) => void;
  readonly onPointerUp: (event: React.PointerEvent<HTMLSpanElement>) => void;
  readonly onPointerCancel: () => void;
  readonly onDoubleClick: () => void;
}

export function useColumnWidths<Key extends string>(
  keys: readonly Key[],
  /**
   * Where the widths are kept. Carry the user in it, so two people sharing a
   * browser do not inherit each other's layout, and the document type, so one
   * kind of document is remembered apart from another. Omit it and the columns
   * are still draggable — just not remembered.
   */
  widthsKey?: string,
) {
  const [widths, setWidths] = useState<ColumnWidths<Key>>({});
  const held = useRef<ColumnWidths<Key>>({});
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{ key: Key; from: number; was: number; rtl: boolean } | null>(null);

  /* Read after mount, never during render: the server has no localStorage, so
     seeding state from it would draw one width on the server and another in
     the browser. The grid paints at its stylesheet widths for the first frame
     and settles into the person's own straight after. */
  useEffect(() => {
    if (!widthsKey) return;
    const stored = parse(keys, window.localStorage.getItem(widthsKey));
    held.current = stored;
    setWidths(stored);
    // `keys` is a module-level constant at every call site; re-reading storage
    // because an array literal changed identity would be noise.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widthsKey]);

  const keep = useCallback(
    (next: ColumnWidths<Key>) => {
      held.current = next;
      setWidths(next);
      if (!widthsKey) return;
      // A refusal to store — a full or locked profile — must not cost the
      // width on screen, so it is swallowed rather than surfaced.
      try {
        window.localStorage.setItem(widthsKey, JSON.stringify(next));
      } catch {
        /* the layout still holds for this visit */
      }
    },
    [widthsKey],
  );

  const gripProps = useCallback(
    (key: Key): GripProps => ({
      onPointerDown: (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        const cell = event.currentTarget.closest('th');
        drag.current = {
          key,
          from: event.clientX,
          was: cell ? cell.getBoundingClientRect().width : MIN_COLUMN_PX,
          // In Arabic the columns run the other way, so dragging right must
          // narrow the column rather than widen it.
          rtl: cell ? getComputedStyle(cell).direction === 'rtl' : false,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        setResizing(true);
      },
      onPointerMove: (event) => {
        const on = drag.current;
        if (!on) return;
        const travelled = event.clientX - on.from;
        const next = Math.max(
          MIN_COLUMN_PX,
          Math.round(on.was + (on.rtl ? -travelled : travelled)),
        );
        // The pointer moves far more often than a width needs storing, so the
        // drag paints from state and writes once, on release.
        const merged = { ...held.current, [key]: next };
        held.current = merged;
        setWidths(merged);
      },
      onPointerUp: (event) => {
        if (!drag.current) return;
        drag.current = null;
        setResizing(false);
        try {
          event.currentTarget.releasePointerCapture(event.pointerId);
        } catch {
          /* the capture was already surrendered */
        }
        keep(held.current);
      },
      onPointerCancel: () => {
        drag.current = null;
        setResizing(false);
        keep(held.current);
      },
      /** A boundary put back: the column returns to the width the screen chose. */
      onDoubleClick: () => {
        const rest = { ...held.current };
        delete rest[key];
        keep(rest);
      },
    }),
    [keep],
  );

  /** For the `col`: an inline width beats every rule, so a hand-set width
   *  survives a change of breakpoint. */
  const widthOf = useCallback(
    (key: Key) => {
      const set = widths[key];
      return set === undefined ? undefined : { inlineSize: `${set}px` };
    },
    [widths],
  );

  return { widthOf, gripProps, resizing };
}

/** The grip itself, on the boundary it moves. */
export function ColumnGrip({
  label,
  resizing,
  ...handlers
}: GripProps & { readonly label: string; readonly resizing: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={styles.sapColGrip}
      data-dragging={resizing ? 'true' : undefined}
      title={label}
      {...handlers}
    />
  );
}
