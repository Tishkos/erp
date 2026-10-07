'use client';

import { useEffect } from 'react';

/**
 * Every table cell knows its column's heading — the labels of a phone's cards.
 *
 * On a phone a register or report is drawn as a list of cards, one per row,
 * each cell a line "label … value" (admin.module.css › "A phone: each row a
 * card"). The label is the heading of the cell's column, copied here onto the
 * cell as `data-label` so the stylesheet can print it (`attr(data-label)`).
 * Doing it once, for the whole application, means no screen has to repeat its
 * headings in its cells.
 *
 * The headings are read as a grid, so a heading that spans two columns, and a
 * head in two rows (a currency over its Debit and Credit), give each column
 * its whole name ("IQD · Debit"). A body cell that spans columns gets no label
 * unless every column it covers has the same one: it is a caption of its own
 * ("Total", "Nothing to show").
 *
 * It also marks what must not break across lines (`data-nowrap`): a cell, or
 * a link or label inside one, whose words are a token — a code, a document
 * number, an amount, a date ("INV-HQ-2026-000001", "Oct 06, 2026"). The
 * tables let their text wrap so they fit the screen; a code broken after its
 * hyphen, or a date split from its year, is not text that wraps but a value
 * that is misread. Prose (a name, a description) still wraps.
 *
 * A cell is written to only after React has hydrated its table — an attribute
 * the server did not draw would otherwise read to React as a mismatch. A table
 * still asleep is tried again shortly. Afterwards a MutationObserver relabels
 * just the tables whose rows or headings changed; it never watches attributes,
 * so its own writes do not wake it.
 */
const SKIP = '[role="grid"], [role="treegrid"], [role="presentation"]';
const RETRY_MS = [120, 400, 1200, 3000, 6000, 12000, 24000];

const TOKEN_MAX = 32;
const INLINE = 'a, bdi, span, time, code, strong, b';

/** A code, a number or a date: one word, or up to three with a figure in them. */
export function isToken(text: string): boolean {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t || t.length > TOKEN_MAX) return false;
  if (!t.includes(' ')) return true;
  return /\d/.test(t) && t.split(' ').length <= 3;
}

function setFlag(element: Element, on: boolean, name = 'data-nowrap') {
  if (on) {
    if (!element.hasAttribute(name)) element.setAttribute(name, '');
  } else if (element.hasAttribute(name)) {
    element.removeAttribute(name);
  }
}

/**
 * The cell itself when its whole text is a token; otherwise its token parts.
 * A cell with nothing in it (`data-empty`) is left off a phone's card.
 */
function markTokens(cell: HTMLTableCellElement) {
  const text = cell.textContent ?? '';
  setFlag(cell, !text.trim() && !cell.querySelector('img, svg, input, select, textarea, button, a'), 'data-empty');
  const whole = isToken(text) && !cell.querySelector('input, select, textarea, button');
  setFlag(cell, whole);
  for (const part of cell.querySelectorAll(INLINE)) {
    const text = part.textContent ?? '';
    setFlag(part, !whole && !/\s/.test(text.trim()) && isToken(text));
  }
}

function hydrated(table: HTMLTableElement): boolean {
  return Object.keys(table).some((key) => key.startsWith('__reactFiber$'));
}

function headingText(cell: HTMLTableCellElement): string {
  const abbr = cell.getAttribute('abbr') ?? cell.getAttribute('aria-label');
  return (abbr ?? cell.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** One label per column, from the head's rows read as a grid. */
function columnLabels(head: HTMLTableSectionElement): string[] {
  const grid: string[][] = [];
  const rows = [...head.rows];
  rows.forEach((row, r) => {
    grid[r] ??= [];
    let c = 0;
    for (const cell of [...row.cells]) {
      while (grid[r]![c] !== undefined) c += 1;
      const text = headingText(cell);
      const span = Math.max(1, cell.colSpan || 1);
      const down = Math.max(1, cell.rowSpan || 1);
      for (let dr = 0; dr < down && r + dr < rows.length; dr += 1) {
        grid[r + dr] ??= [];
        for (let dc = 0; dc < span; dc += 1) grid[r + dr]![c + dc] = text;
      }
      c += span;
    }
  });
  const width = Math.max(0, ...grid.map((row) => row.length));
  const labels: string[] = [];
  for (let c = 0; c < width; c += 1) {
    const parts: string[] = [];
    for (const row of grid) {
      const text = row[c];
      if (text && parts[parts.length - 1] !== text) parts.push(text);
    }
    labels.push(parts.join(' · '));
  }
  return labels;
}

function label(table: HTMLTableElement) {
  const head = table.tHead;
  if (!head || head.rows.length === 0) return;
  const labels = columnLabels(head);
  const sections = [...table.tBodies, ...(table.tFoot ? [table.tFoot] : [])];
  for (const section of sections) {
    // Row spans in the body push later cells along, as in the head.
    const taken: number[][] = [];
    [...section.rows].forEach((row, r) => {
      taken[r] ??= [];
      let c = 0;
      for (const cell of [...row.cells]) {
        while (taken[r]![c]) c += 1;
        const span = Math.max(1, cell.colSpan || 1);
        const down = Math.max(1, cell.rowSpan || 1);
        for (let dr = 1; dr < down; dr += 1) {
          taken[r + dr] ??= [];
          for (let dc = 0; dc < span; dc += 1) taken[r + dr]![c + dc] = 1;
        }
        markTokens(cell);
        const covered = labels.slice(c, c + span);
        const text = covered.length > 0 && covered.every((l) => l === covered[0]) ? covered[0]! : '';
        if (text) {
          if (cell.getAttribute('data-label') !== text) cell.setAttribute('data-label', text);
        } else if (cell.hasAttribute('data-label')) {
          cell.removeAttribute('data-label');
        }
        c += span;
      }
    });
  }
}

export function TableLabels() {
  useEffect(() => {
    const waiting = new Set<HTMLTableElement>();
    const timers = new Set<number>();
    let frame = 0;
    let pending = new Set<HTMLTableElement>();

    const run = (tables: Iterable<HTMLTableElement>) => {
      for (const table of tables) {
        if (!table.isConnected || table.matches(SKIP)) continue;
        if (!hydrated(table)) {
          waiting.add(table);
          continue;
        }
        waiting.delete(table);
        label(table);
      }
    };

    const retry = (attempt: number) => {
      if (attempt >= RETRY_MS.length) return;
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        if (waiting.size === 0) return;
        run([...waiting]);
        if (waiting.size > 0) retry(attempt + 1);
      }, RETRY_MS[attempt]);
      timers.add(timer);
    };

    const flush = () => {
      frame = 0;
      const tables = pending;
      pending = new Set();
      const before = waiting.size;
      run(tables);
      if (waiting.size > before || (waiting.size > 0 && timers.size === 0)) retry(0);
    };

    const schedule = (table: HTMLTableElement) => {
      pending.add(table);
      if (!frame) frame = window.requestAnimationFrame(flush);
    };

    for (const table of document.querySelectorAll('table')) schedule(table);

    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target.nodeType === Node.ELEMENT_NODE ? (record.target as Element) : record.target.parentElement;
        const near = target?.closest('table');
        if (near) schedule(near);
        for (const node of record.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const element = node as Element;
          if (element instanceof HTMLTableElement) schedule(element);
          else if (element.firstElementChild) for (const table of element.querySelectorAll('table')) schedule(table);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    return () => {
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, []);

  return null;
}
