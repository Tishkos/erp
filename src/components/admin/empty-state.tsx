import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/components/intent/cn';

/**
 * A whole page, or a whole section, with nothing in it — Intent UI's empty
 * state (the redesign, 2026-10-06): the icon in a soft tinted circle with a
 * fainter ring round it, a title, one line that says why and what to do, and
 * at most a way on.
 *
 * For a page that has nothing to show yet (no tasks, no notifications, a
 * search that found nothing), not for a register that is merely empty under
 * its filters — that keeps its one quiet row (`s.sapEmptyRow`), because the
 * toolbar above it is the way on. The missing, failed and offline pages are
 * drawn with it too (`src/app/not-found.tsx`, `error.tsx`).
 *
 * It holds no state and no hooks, so a server page and a client component can
 * both draw it. Words are the caller's, from the catalogue.
 *
 * ```tsx
 * <EmptyState
 *   action={{ href: '/tasks?new=1', label: words.newTask, icon: Plus }}
 *   description={words.noTasksLine}
 *   icon={ListChecks}
 *   title={words.noTasks}
 * />
 * ```
 *
 * Inside a card or a register that is already drawn, `variant="plain"` drops
 * the card of its own. A route state is the page's heading (`headingLevel={1}`).
 */
export type EmptyStateTone = 'primary' | 'neutral' | 'success' | 'warning' | 'danger';

export interface EmptyStateLink {
  readonly href: string;
  readonly label: string;
  readonly icon?: LucideIcon | undefined;
}

export interface EmptyStateProps extends Omit<ComponentPropsWithoutRef<'div'>, 'title'> {
  readonly icon: LucideIcon;
  readonly title: ReactNode;
  /** One line: why there is nothing, and what would put something here. */
  readonly description?: ReactNode;
  readonly tone?: EmptyStateTone;
  /** The way on, drawn as the primary button. */
  readonly action?: EmptyStateLink | undefined;
  /** A second way on, drawn as an outline button beside it. */
  readonly secondaryAction?: EmptyStateLink | undefined;
  /** Buttons the caller draws itself (a client action, a form) — after the links. */
  readonly actions?: ReactNode;
  /** `card` stands on the page canvas; `plain` sits inside a card or a register that is already drawn. */
  readonly variant?: 'card' | 'plain';
  /** A route state is the page's `h1`; an empty section inside a page is an `h2`. */
  readonly headingLevel?: 1 | 2 | 3;
  /** Classes for the icon's circle (a test hook, an override). */
  readonly iconClassName?: string | undefined;
  /** What sits between the line and the buttons — a reference, a hint. */
  readonly children?: ReactNode;
}

/** The circle's tint, its icon and its ring, per tone — theme colours only. */
const TONES: Readonly<Record<EmptyStateTone, string>> = {
  primary: 'bg-primary-subtle text-primary-subtle-fg ring-primary-subtle/50',
  neutral: 'bg-muted text-muted-fg ring-muted/70',
  success: 'bg-success-subtle text-success-subtle-fg ring-success-subtle/50',
  warning: 'bg-warning-subtle text-warning-subtle-fg ring-warning-subtle/50',
  danger: 'bg-danger-subtle text-danger-subtle-fg ring-danger-subtle/50',
};

/**
 * Intent UI's buttons, written out for a link or a native `<button>`: the
 * vendored `buttonStyles` lives in a client module, which a server page
 * cannot call.
 */
const BUTTON =
  'inline-flex min-h-9 items-center justify-center gap-2 rounded-lg border px-3.5 py-1.5 font-medium text-sm/6 no-underline outline-offset-2 transition-colors focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-60 [&_svg]:size-4 [&_svg]:shrink-0 forced-colors:border-[ButtonText]';

const INTENTS = {
  primary:
    'border-[color-mix(in_oklab,var(--ui-primary)_85%,black)] bg-primary text-primary-fg hover:bg-[color-mix(in_oklab,var(--ui-primary-fg)_10%,var(--ui-primary)_90%)] hover:text-primary-fg [&_svg]:opacity-80',
  outline: 'border-border bg-transparent text-fg hover:bg-secondary hover:text-fg [&_svg]:text-muted-fg',
} as const;

export function emptyStateButton(intent: keyof typeof INTENTS = 'primary', className?: string): string {
  return cn(BUTTON, INTENTS[intent], className);
}

function LinkButton({ link, intent }: { readonly link: EmptyStateLink; readonly intent: keyof typeof INTENTS }) {
  const Icon = link.icon;
  return (
    <Link className={emptyStateButton(intent)} href={link.href}>
      {Icon ? <Icon aria-hidden="true" /> : null}
      <span>{link.label}</span>
    </Link>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  tone = 'primary',
  action,
  secondaryAction,
  actions,
  variant = 'card',
  headingLevel = 2,
  iconClassName,
  className,
  children,
  ...rest
}: EmptyStateProps) {
  const Heading = `h${headingLevel}` as const;
  const hasActions = Boolean(action || secondaryAction || actions);

  return (
    <div
      className={cn(
        'mx-auto grid w-full justify-items-center gap-1.5 text-center',
        variant === 'card'
          ? 'max-w-md rounded-xl border border-border bg-overlay px-6 pt-9 pb-8 text-overlay-fg shadow-xs'
          : 'max-w-lg px-4 py-10',
        className,
      )}
      data-slot="empty-state"
      {...rest}
    >
      <span
        aria-hidden="true"
        className={cn('mb-3 grid size-12 place-items-center rounded-full ring-[0.45rem]', TONES[tone], iconClassName)}
      >
        <Icon className="size-5" />
      </span>
      <Heading className="m-0 text-balance font-semibold text-fg text-lg/7 tracking-tight rtl:tracking-normal">{title}</Heading>
      {description ? <p className="m-0 max-w-sm text-pretty text-muted-fg text-sm/6">{description}</p> : null}
      {children}
      {hasActions ? (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {action ? <LinkButton intent="primary" link={action} /> : null}
          {secondaryAction ? <LinkButton intent="outline" link={secondaryAction} /> : null}
          {actions}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Where a route state stands: the middle of the page area, inside the shell,
 * with room above and below so it does not hug the header.
 */
export function EmptyStatePage({ children, className }: { readonly children: ReactNode; readonly className?: string | undefined }) {
  return <div className={cn('grid min-h-[60vh] place-items-center px-1 py-8 sm:px-4', className)}>{children}</div>;
}
