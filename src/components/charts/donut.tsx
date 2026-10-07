'use client';

import { useState } from 'react';
import { cn } from '@/components/intent/cn';

/**
 * A whole and its parts, as a donut with the whole in the middle and, beside
 * it, a legend that says every part's amount and share — the ageing of what
 * is owed, a balance by bucket, a headcount by department.
 *
 * Drawn by hand in SVG rather than by recharts: it is in the first paint, it
 * prints, and it needs no measuring. Pointing at a part (on the ring or in the
 * legend) lifts it and the middle says that part instead of the whole; nothing
 * is reachable only that way — the legend always shows every figure, and the
 * card's table says them again.
 *
 * Colours come from the caller, in the parts' order: an *ordered* scale (how
 * late) passes the validated ordinal ramp, one hue getting darker; parts that
 * are identities pass the categorical steps. The 2px gaps between parts are
 * the surface showing through, not strokes. Right to left the ring runs
 * counter-clockwise from the top, as the reading does; the middle's figures
 * are not mirrored.
 */

export interface DonutPart {
  readonly key: string;
  readonly label: string;
  /** The plotted share — never added again as money. */
  readonly value: number;
  /** A CSS colour. */
  readonly color: string;
  /** The amount as the reader reads it. */
  readonly text: string;
  /** Its share of the whole, already formatted ("62%"). */
  readonly share: string;
  /** A line under the label in the legend ("3 invoices"). */
  readonly note?: string | undefined;
}

const SIZE = 120;
const CENTRE = SIZE / 2;
const RADIUS = 50;
const THICKNESS = 13;
/** In hundredths of the circumference: about 2px at the drawn size. */
const GAP = 0.5;
const MIN_ARC = 0.6;

export function Donut({
  parts,
  centreLabel,
  centreValue,
  centreTitle,
  centreNote,
}: {
  readonly parts: readonly DonutPart[];
  /** Over the figure in the middle ("Total outstanding"). */
  readonly centreLabel: string;
  /** The whole, as short as it reads ("907,500 IQD", "1.25B IQD"). */
  readonly centreValue: string;
  /** The whole exactly, for the middle's title when the value is shortened. */
  readonly centreTitle?: string | undefined;
  /** Under the figure ("12 open invoices"). */
  readonly centreNote?: string | undefined;
}) {
  const [active, setActive] = useState<string | null>(null);
  const total = parts.reduce((sum, one) => sum + Math.max(0, one.value), 0);
  if (total <= 0) return null;

  const drawn = parts.filter((one) => one.value > 0);
  const gap = drawn.length > 1 ? GAP : 0;
  let start = 0;
  const arcs = drawn.map((one) => {
    const length = (one.value / total) * 100;
    const arc = { part: one, start, length: Math.max(MIN_ARC, length - gap) };
    start += length;
    return arc;
  });
  const shown = active ? parts.find((one) => one.key === active) : undefined;

  return (
    // Side by side when the card is wide enough for both, whatever the window is — a donut in a profile's narrow
    // column stacks as it does on a phone.
    <div className="@container min-w-0">
    {/* On a card the width of the page the pair keeps its own width, so an amount stays near its label. */}
    <div className="flex min-w-0 max-w-3xl flex-col items-center gap-5 @md:flex-row @md:items-center @md:gap-8">
      <div className="relative size-44 shrink-0" onPointerLeave={() => setActive(null)}>
        <svg
          aria-hidden="true"
          className={cn(
            'size-full rtl:-scale-x-100',
            'motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:animate-in motion-safe:duration-500',
          )}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
        >
          <g transform={`rotate(-90 ${CENTRE} ${CENTRE})`}>
          {arcs.map(({ part, start: from, length }) => {
            const lifted = active === part.key;
            const dimmed = active !== null && !lifted;
            return (
              <circle
                className="cursor-default transition-[stroke-width,opacity] duration-200 motion-reduce:transition-none"
                cx={CENTRE}
                cy={CENTRE}
                fill="none"
                key={part.key}
                onPointerEnter={() => setActive(part.key)}
                opacity={dimmed ? 0.35 : 1}
                pathLength={100}
                r={RADIUS}
                stroke={part.color}
                strokeDasharray={`${length} ${100 - length}`}
                strokeDashoffset={-from}
                strokeWidth={lifted ? THICKNESS + 4 : THICKNESS}
              >
                <title>{`${part.label}: ${part.text} (${part.share})`}</title>
              </circle>
            );
          })}
          </g>
        </svg>
        <div
          className="absolute inset-[16%] flex flex-col items-center justify-center rounded-full px-1 text-center"
          title={shown ? undefined : centreTitle}
        >
          <span className="line-clamp-2 text-muted-fg text-xs leading-tight">{shown ? shown.label : centreLabel}</span>
          <span
            className={cn(
              'mt-1 font-semibold text-fg tabular-nums tracking-tight rtl:tracking-normal',
              (shown ? shown.text : centreValue).length > 13 ? 'text-base/5' : 'text-lg/6',
            )}
          >
            <bdi>{shown ? shown.text : centreValue}</bdi>
          </span>
          {shown ? (
            <span className="mt-0.5 text-muted-fg text-xs tabular-nums">
              <bdi dir="ltr">{shown.share}</bdi>
            </span>
          ) : centreNote ? (
            <span className="mt-0.5 text-muted-fg text-xs">{centreNote}</span>
          ) : null}
        </div>
      </div>
      <ul className="m-0 flex w-full min-w-0 flex-1 list-none flex-col gap-0.5 p-0" onPointerLeave={() => setActive(null)}>
        {parts.map((one) => (
          <li
            className={cn(
              'flex min-w-0 items-center gap-3 rounded-lg px-2.5 py-2 text-sm transition-colors duration-150 motion-reduce:transition-none',
              active === one.key ? 'bg-muted' : 'hover:bg-muted/60',
            )}
            key={one.key}
            onPointerEnter={() => setActive(one.key)}
          >
            <span aria-hidden="true" className="size-3 shrink-0 rounded-[4px]" style={{ background: one.color }} />
            <span className="flex min-w-0 flex-1 flex-col">
              {/* Its own direction (cut at its own end), placed at the row's start whichever way it reads. */}
              <span className="max-w-full self-start truncate text-fg" dir="auto">
                {one.label}
              </span>
              {one.note ? <span className="truncate text-muted-fg text-xs">{one.note}</span> : null}
            </span>
            <span className="w-10 shrink-0 text-end text-muted-fg text-xs tabular-nums">
              <bdi dir="ltr">{one.share}</bdi>
            </span>
            <span className="shrink-0 text-end font-semibold text-fg tabular-nums">
              <bdi dir="ltr">{one.text}</bdi>
            </span>
          </li>
        ))}
      </ul>
    </div>
    </div>
  );
}
