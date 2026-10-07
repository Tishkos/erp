'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useParams, usePathname } from 'next/navigation';
import { cn } from '@/components/intent/cn';
import { Skeleton } from '@/components/intent/skeleton';
import { shapeOf, type SkeletonShape } from './skeleton-shape';
import styles from './states.module.css';

/**
 * What a screen shows while it is being produced (the Intent UI redesign,
 * 2026-10-06).
 *
 * Every page is `force-dynamic`, so between a click and the screen there is
 * always a server round trip. A `loading.tsx` holds the screen's place for it:
 * the header and navigation stay where they were, a bar runs along the top,
 * and the page area is drawn in the shape of what is coming — so nothing
 * jumps when it lands.
 *
 * ── Why one component, and why it asks the address ───────────────────────
 * Next.js puts a `loading.tsx` around the children of the folder it sits in,
 * keyed by the child that is open; a boundary that is already showing a
 * screen does not fall back again when a deeper child changes. So a skeleton
 * at the top of the application covers moving between modules and nothing
 * else — opening an invoice from the invoice list kept the list on screen,
 * silent, until the invoice arrived. Every folder whose children are screens
 * therefore has a `loading.tsx` of its own, and each draws this component.
 *
 * Which shape it draws is read from the address being opened (the router has
 * it before the screen arrives) by `shapeOf`: Home is the dashboard — figures
 * and charts; an address with a record's number in it, or a `/new` form, is a
 * document; everything else is a register. The shapes copy the model screens
 * — the Purchase Invoices list and record, and Home.
 *
 * Nothing in it is read by a person: the bones are hidden from assistive
 * technology, which is told "Loading" once, through the status role.
 */
export function RouteSkeleton({ shape }: { readonly shape?: SkeletonShape }) {
  const pathname = usePathname() ?? '/';
  const params = useParams();
  const drawn = shape ?? shapeOf(pathname, params);
  const t = useTranslations('error');

  return (
    <div className="min-w-0" data-skeleton={drawn} role="status">
      <span className="sr-only">
        {t('loading_title')} — {t('loading_hint')}
      </span>
      <span aria-hidden="true" className={styles.progress} />
      <div aria-hidden="true" className={cn(styles.skeleton, 'flex min-w-0 flex-col gap-5 pb-8')}>
        {drawn === 'home' ? <HomeShape /> : drawn === 'document' ? <DocumentShape /> : <RegisterShape />}
      </div>
    </div>
  );
}

/* ── The pieces ─────────────────────────────────────────────────────────── */

/** One placeholder bar — Intent UI's Skeleton, with the shimmer of states.module.css. */
function Bone({ className, tone }: { readonly className?: string | undefined; readonly tone?: 'primary' | 'soft' | undefined }) {
  return <Skeleton className={cn(styles.bone, 'h-3', className)} data-tone={tone} />;
}

/** A card, as the screens draw them: rounded-xl, a hairline, the lightest shadow. */
function Card({ className, children }: { readonly className?: string; readonly children: ReactNode }) {
  return (
    <div className={cn('min-w-0 overflow-hidden rounded-xl border border-border bg-overlay shadow-xs', className)}>
      {children}
    </div>
  );
}

/** An outlined control — an input, a ghost button — with its words as a bone. */
function Outline({ className, children }: { readonly className?: string; readonly children: ReactNode }) {
  return <div className={cn('flex h-9 shrink-0 items-center rounded-lg border border-border px-3', className)}>{children}</div>;
}

/** The page's own header: the way back, the title and its line, the actions. */
function PageHead({ crumb, actions }: { readonly crumb: boolean; readonly actions: number }) {
  return (
    <div className="flex flex-col gap-5">
      {crumb ? (
        <div className="flex items-center gap-3">
          <Outline className="h-8 gap-2 px-2.5">
            <Bone className="size-3 rounded-sm" />
            <Bone className="w-16" />
          </Outline>
          <Bone className="w-28" tone="soft" />
        </div>
      ) : null}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="grid min-w-0 gap-2.5">
          <Bone className="h-7 w-52 sm:w-72" />
          <Bone className="h-3.5 w-40 sm:w-60" tone="soft" />
        </div>
        {actions > 0 ? (
          <div className="flex gap-2">
            {Array.from({ length: actions }, (_, index) =>
              index === 0 ? (
                <Bone className="h-9 w-28 rounded-lg" key={index} tone="primary" />
              ) : (
                <Outline className="hidden w-32 justify-center md:flex" key={index}>
                  <Bone className="w-20" />
                </Outline>
              ),
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

const TAB_WIDTHS = ['w-24', 'w-20', 'w-16', 'w-24', 'w-20', 'w-14'] as const;

/** The section's row of tabs, the open one underlined. */
function TabRow({ count }: { readonly count: number }) {
  return (
    <div className="-mt-1 flex items-end gap-6 overflow-hidden border-border border-b">
      {TAB_WIDTHS.slice(0, count).map((width, index) => (
        <div
          className={cn('shrink-0 pt-1 pb-3', index === 0 && '-mb-px border-primary border-b-2', index > 2 && 'hidden sm:block')}
          key={index}
        >
          <Bone className={width} tone={index === 0 ? 'primary' : undefined} />
        </div>
      ))}
    </div>
  );
}

/* ── Register: the Purchase Invoices list ─────────────────────────────── */

/** Varied widths, so eight rows read as data rather than as a grille. */
const ROW_WIDTHS = [
  ['w-[78%]', 'w-[62%]', 'w-[70%]', 'w-[84%]', 'w-[56%]'],
  ['w-[66%]', 'w-[70%]', 'w-[58%]', 'w-[72%]', 'w-[64%]'],
  ['w-[84%]', 'w-[58%]', 'w-[66%]', 'w-[60%]', 'w-[72%]'],
  ['w-[60%]', 'w-[66%]', 'w-[74%]', 'w-[80%]', 'w-[48%]'],
  ['w-[72%]', 'w-[62%]', 'w-[60%]', 'w-[66%]', 'w-[68%]'],
  ['w-[80%]', 'w-[70%]', 'w-[68%]', 'w-[54%]', 'w-[60%]'],
  ['w-[64%]', 'w-[58%]', 'w-[72%]', 'w-[76%]', 'w-[70%]'],
  ['w-[70%]', 'w-[66%]', 'w-[62%]', 'w-[62%]', 'w-[52%]'],
] as const;

const REGISTER_COLUMNS = 'grid-cols-[1.6fr_1fr_0.9fr] md:grid-cols-[1.9fr_1fr_1fr_1.6fr_1fr_0.8fr]';

function RegisterShape() {
  return (
    <>
      <PageHead actions={1} crumb />
      <TabRow count={5} />
      <Card>
        <div className="flex items-center justify-between gap-4 border-border border-b px-5 py-4">
          <Bone className="h-4 w-40" />
          <Bone className="w-16" tone="soft" />
        </div>
        <div className="flex items-center gap-3 border-border border-b px-5 py-3">
          <Outline className="w-full max-w-sm justify-between">
            <Bone className="w-28" tone="soft" />
            <Bone className="size-3.5 rounded-full" tone="soft" />
          </Outline>
          <Outline className="ms-auto hidden w-24 justify-center gap-2 sm:flex">
            <Bone className="size-3.5 rounded-sm" />
            <Bone className="w-10" />
          </Outline>
        </div>
        <div className={cn('grid gap-4 border-border border-b bg-muted px-5 py-3', REGISTER_COLUMNS)}>
          <Bone className="h-2.5 w-20" tone="soft" />
          <Bone className="h-2.5 w-16" tone="soft" />
          <Bone className="h-2.5 w-14" tone="soft" />
          <Bone className="hidden h-2.5 w-24 md:block" tone="soft" />
          <Bone className="ms-auto hidden h-2.5 w-14 md:block" tone="soft" />
          <Bone className="hidden h-2.5 w-12 md:block" tone="soft" />
        </div>
        {ROW_WIDTHS.map((widths, row) => (
          <div
            className={cn('grid items-center gap-4 border-border px-5 py-3.5', REGISTER_COLUMNS, row < ROW_WIDTHS.length - 1 && 'border-b')}
            key={row}
          >
            <Bone className={widths[0]} tone="primary" />
            <Bone className={widths[1]} />
            <Bone className={widths[2]} />
            <Bone className={cn('hidden md:block', widths[3])} />
            <Bone className={cn('ms-auto hidden md:block', widths[4])} />
            <Bone className="hidden h-5 w-14 rounded-md md:block" tone="soft" />
          </div>
        ))}
      </Card>
    </>
  );
}

/* ── Document: the purchase invoice's record ──────────────────────────── */

const FIELD_WIDTHS = ['w-3/4', 'w-1/2', 'w-2/3', 'w-3/5', 'w-1/2', 'w-4/5', 'w-2/5', 'w-2/3'] as const;
const LINE_COLUMNS = 'grid-cols-[2fr_1fr_1fr] sm:grid-cols-[2.4fr_1fr_1fr_1.2fr]';

function DocumentShape() {
  return (
    <>
      <PageHead actions={2} crumb />
      <TabRow count={4} />
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-border border-b px-5 py-4">
          <Bone className="h-4 w-44" />
          <Bone className="h-5 w-16 rounded-md" tone="soft" />
          <div className="ms-auto flex gap-1.5">
            {[0, 1, 2, 3].map((door) => (
              <div className="grid size-8 place-items-center rounded-lg border border-border" key={door}>
                <Bone className="size-3.5 rounded-sm" />
              </div>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-5 p-5 md:grid-cols-4">
          {FIELD_WIDTHS.map((width, index) => (
            <div className="grid gap-2" key={index}>
              <Bone className="h-2.5 w-20" tone="soft" />
              <Outline className="bg-muted/40">
                <Bone className={width} />
              </Outline>
            </div>
          ))}
        </div>
        <div className="px-5 pb-3">
          <div className="flex items-center gap-2">
            <Bone className="h-3.5 w-16" />
            <Bone className="h-4 w-6 rounded-full" tone="soft" />
          </div>
        </div>
        <div className="mx-5 overflow-hidden rounded-lg border border-border">
          <div className={cn('grid gap-4 border-border border-b bg-muted px-4 py-3', LINE_COLUMNS)}>
            <Bone className="h-2.5 w-24" tone="soft" />
            <Bone className="h-2.5 w-14" tone="soft" />
            <Bone className="ms-auto h-2.5 w-14" tone="soft" />
            <Bone className="ms-auto hidden h-2.5 w-16 sm:block" tone="soft" />
          </div>
          {ROW_WIDTHS.slice(0, 4).map((widths, row) => (
            <div className={cn('grid items-center gap-4 border-border px-4 py-3', LINE_COLUMNS, row < 3 && 'border-b')} key={row}>
              <Bone className={widths[0]} />
              <Bone className={widths[2]} />
              <Bone className={cn('ms-auto', widths[4])} />
              <Bone className={cn('ms-auto hidden sm:block', widths[3])} />
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-end justify-between gap-4 p-5">
          <div className="flex gap-2">
            <Bone className="h-9 w-24 rounded-lg" tone="primary" />
            <Outline className="w-24 justify-center">
              <Bone className="w-12" />
            </Outline>
          </div>
          <div className="grid gap-2.5">
            {['w-28', 'w-36'].map((width) => (
              <div className="flex items-center justify-end gap-6" key={width}>
                <Bone className="w-16" tone="soft" />
                <Bone className={cn('h-4', width)} />
              </div>
            ))}
          </div>
        </div>
      </Card>
      <Card>
        <div className="border-border border-b px-5 py-4">
          <Bone className="h-4 w-36" />
        </div>
        <div className="grid gap-3.5 p-5">
          {['w-3/5', 'w-2/5', 'w-1/2'].map((width) => (
            <Bone className={width} key={width} />
          ))}
        </div>
      </Card>
    </>
  );
}

/* ── Home: figures, then charts ───────────────────────────────────────── */

const FIGURE_WIDTHS = [
  ['w-28', 'w-14', 'w-20'],
  ['w-24', 'w-24', 'w-16'],
  ['w-24', 'w-32', 'w-24'],
  ['w-32', 'w-10', 'w-16'],
  ['w-28', 'w-12', 'w-24'],
  ['w-20', 'w-28', 'w-20'],
  ['w-24', 'w-16', 'w-28'],
  ['w-28', 'w-24', 'w-20'],
] as const;

/** A bar chart's silhouette, month by month. */
const CHART_BARS = [
  ['h-[38%]', 'h-[52%]', 'h-[34%]', 'h-[66%]', 'h-[58%]', 'h-[78%]', 'h-[48%]', 'h-[62%]', 'h-[44%]', 'h-[72%]', 'h-[56%]', 'h-[84%]'],
  ['h-[60%]', 'h-[44%]', 'h-[70%]', 'h-[50%]', 'h-[64%]', 'h-[40%]', 'h-[76%]', 'h-[58%]', 'h-[68%]', 'h-[46%]', 'h-[74%]', 'h-[54%]'],
] as const;

function HomeShape() {
  return (
    <>
      <PageHead actions={4} crumb={false} />
      <TabRow count={6} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4">
        {FIGURE_WIDTHS.map(([label, value, hint], index) => (
          <Card className={cn('flex min-h-30 flex-col gap-4 p-4', index > 3 && 'hidden sm:flex')} key={index}>
            <div className="flex items-start justify-between gap-3">
              <Bone className={label} />
              <Bone className="size-8 rounded-lg" tone="soft" />
            </div>
            <Bone className={cn('h-7', value)} />
            <Bone className={cn('h-2.5', hint)} tone="soft" />
          </Card>
        ))}
      </div>
      <Bone className="mt-1 h-4 w-20" />
      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
        {CHART_BARS.map((bars, chart) => (
          <Card className={cn(chart > 0 && 'hidden lg:block')} key={chart}>
            <div className="flex items-start justify-between gap-4 px-5 pt-5">
              <div className="grid gap-2">
                <Bone className="h-4 w-56 max-w-full" />
                <Bone className="w-24" tone="soft" />
              </div>
              <Bone className="w-14" tone="soft" />
            </div>
            <div className="flex h-48 items-end gap-2 px-5 pt-6 pb-5 sm:gap-3">
              {bars.map((height, index) => (
                <Bone className={cn('flex-1 rounded-b-none rounded-t-md', height, index > 7 && 'hidden sm:block')} key={index} tone={index === bars.length - 1 ? 'primary' : undefined} />
              ))}
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}
