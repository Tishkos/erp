import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowRight, type LucideIcon } from 'lucide-react';
import { cn } from '@/components/intent/cn';

/**
 * Text in a status or accent colour, readable on its own tint and on the card
 * in every palette. The theme's `--ui-*-subtle-fg` on `--ui-*-subtle` measured
 * 3.6–4.4:1 on the light palettes; mixing a share of the text colour in keeps
 * the hue and moves it the right way on both grounds — darker on a light
 * palette, lighter on a dark one — to 4.5:1 and over.
 */
export const INK = {
  primary: 'text-[color:color-mix(in_oklab,var(--ui-primary-subtle-fg)_72%,var(--ui-fg))]',
  success: 'text-[color:color-mix(in_oklab,var(--ui-success-subtle-fg)_70%,var(--ui-fg))]',
  info: 'text-[color:color-mix(in_oklab,var(--ui-info-subtle-fg)_70%,var(--ui-fg))]',
  warning: 'text-[color:color-mix(in_oklab,var(--ui-warning-subtle-fg)_66%,var(--ui-fg))]',
  danger: 'text-[color:color-mix(in_oklab,var(--ui-danger-subtle-fg)_70%,var(--ui-fg))]',
} as const;

/**
 * One band of a dashboard — an Intent UI card (2026-10-06, the redesign).
 *
 * A rounded card on the page canvas: the title and, at its end, the way to the
 * screen that reads the whole band properly; the body is whatever the band
 * holds — a table (full bleed, under a hairline), a row of figures, a list.
 * Home and the HR dashboard both draw their bands with it, so the two keep
 * looking like one application.
 *
 * **A band with nothing in it is not rendered.** That decision belongs to the
 * caller — the page does not render `<Band>` at all when its rows are empty or
 * its permission is absent — because a heading over an empty box is worse than
 * silence: it is a promise the screen does not keep.
 */
export function Band({
  title,
  count,
  href,
  hrefLabel,
  icon: Icon,
  className,
  children,
}: {
  readonly title: string;
  /** How many rows are behind it, shown as a count badge beside the title. */
  readonly count?: number | undefined;
  /** Where the whole band is read properly. */
  readonly href?: string | undefined;
  readonly hrefLabel?: string | undefined;
  /** A quiet glyph before the title. */
  readonly icon?: LucideIcon | undefined;
  readonly className?: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <section
      className={cn(
        // The margin is the space between bands stacked straight in a page (the HR dashboard); a grid or a flex
        // column that spaces its cards with a gap passes `mb-0`.
        'mb-4 flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-overlay text-overlay-fg shadow-xs',
        className,
      )}
    >
      <div className="flex min-h-12 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-3 sm:px-5">
        <h2 className="m-0 flex min-w-0 items-center gap-2 font-semibold text-base text-fg">
          {Icon ? <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-fg" /> : null}
          <span className="min-w-0">{title}</span>
          {count === undefined ? null : (
            <span className="inline-flex min-w-6 items-center justify-center rounded-full bg-secondary px-2 py-px font-medium text-secondary-fg text-xs/5 tabular-nums">
              <bdi dir="ltr">{count}</bdi>
            </span>
          )}
        </h2>
        {href && hrefLabel ? <SeeAll href={href} label={hrefLabel} /> : null}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </section>
  );
}

/** The link at the end of a card's title: to the screen that holds the rest. */
export function SeeAll({ href, label }: { readonly href: string; readonly label: string }) {
  return (
    <Link
      className={cn(
        INK.primary,
        'inline-flex shrink-0 items-center gap-1 rounded-md font-medium text-sm no-underline outline-offset-2 hover:underline hover:underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring',
      )}
      href={href}
    >
      {label}
      <ArrowRight aria-hidden="true" className="size-3.5 rtl:-scale-x-100" />
    </Link>
  );
}

/**
 * A row of figures — labelled boxes, each opening the screen that proves it.
 *
 * `Figure` takes its value already formatted. Nothing here rounds, converts or
 * re-adds: every number on a dashboard is a figure a service returned, so it
 * cannot disagree with the report it came from.
 */
export function Figures({ children }: { readonly children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 border-border border-t p-4 sm:grid-cols-3 sm:px-5 lg:grid-cols-5">{children}</div>;
}

export function Figure({
  label,
  value,
  href,
  tone,
}: {
  readonly label: string;
  readonly value: ReactNode;
  /** Where the figure is proved. A figure nobody can check is decoration. */
  readonly href?: string | undefined;
  /** `warn` for a figure that is a problem by its nature — money overdue. */
  readonly tone?: 'warn' | undefined;
}) {
  const body = (
    <>
      <span className={cn('font-medium text-xs', tone === 'warn' ? INK.warning : 'text-muted-fg')}>{label}</span>
      <span className={cn('font-semibold text-2xl/8 tabular-nums tracking-tight rtl:tracking-normal', tone === 'warn' ? INK.warning : 'text-fg')}>
        <bdi dir="ltr">{value}</bdi>
      </span>
    </>
  );
  const box = cn(
    'flex min-w-0 flex-col gap-1 rounded-xl border p-3.5',
    tone === 'warn' ? 'border-warning-subtle-fg/30 bg-warning-subtle' : 'border-border bg-muted/40',
  );
  return href ? (
    <Link
      className={cn(box, 'no-underline outline-offset-2 transition-colors hover:border-input hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring')}
      href={href}
    >
      {body}
    </Link>
  ) : (
    <div className={box}>{body}</div>
  );
}

/** Right-aligned, aligned digits: the class a numeric cell of a band's table wears. */
export const NUMERIC_CELL = 'text-end tabular-nums whitespace-nowrap';

/**
 * The rows of a band, in Intent's table: a muted header row, rows divided by
 * hairlines, numbers to the end. The cells are styled from here, so a caller's
 * rows need nothing but `NUMERIC_CELL` on a figure.
 */
export function BandTable({
  headings,
  children,
}: {
  readonly headings: readonly (string | { readonly label: string; readonly numeric: true })[];
  readonly children: ReactNode;
}) {
  return (
    <div className="min-w-0 overflow-x-auto border-border border-t">
      <table className="w-full border-collapse text-fg text-sm [&_tbody_td]:px-4 [&_tbody_td]:py-2.5 [&_tbody_td]:align-middle [&_tbody_tr:hover]:bg-muted/60 [&_tbody_tr]:border-border [&_tbody_tr]:border-t [&_tbody_tr]:transition-colors [&_td:first-child]:ps-4 sm:[&_td:first-child]:ps-5 sm:[&_td:last-child]:pe-5">
        <thead className="bg-muted text-muted-fg text-xs">
          <tr>
            {headings.map((heading) => {
              const label = typeof heading === 'string' ? heading : heading.label;
              return (
                <th
                  className={cn(
                    'whitespace-nowrap px-4 py-2 font-medium first:ps-4 sm:first:ps-5 sm:last:pe-5',
                    typeof heading === 'string' ? 'text-start' : 'text-end',
                  )}
                  key={label}
                  scope="col"
                >
                  {label}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
