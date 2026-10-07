import type { LucideIcon } from 'lucide-react';
import { BadgeCheck, Banknote, Calculator, EyeOff, FileText, ListTodo, MessageSquare, ReceiptText, Settings, Ship, Users } from 'lucide-react';
import { cn } from '@/components/intent/cn';
import type { NotificationCategory } from '@domain/notification-center';

/**
 * How a notification's category looks: an icon in a tinted circle, the same in
 * the bell's popover and on the Notifications screen. The tints are the theme's
 * status tints (`bg-*-subtle` / `text-*-subtle-fg`), so every palette and
 * accent, light and dark, keeps them readable. A notification whose record the
 * reader can no longer open wears the neutral circle with a closed eye.
 */
type Tone = 'primary' | 'success' | 'warning' | 'info' | 'neutral';

const LOOK: Readonly<Record<NotificationCategory, { readonly icon: LucideIcon; readonly tone: Tone }>> = {
  approvals: { icon: BadgeCheck, tone: 'warning' },
  tasks: { icon: ListTodo, tone: 'info' },
  chat: { icon: MessageSquare, tone: 'primary' },
  documents: { icon: FileText, tone: 'neutral' },
  payments: { icon: Banknote, tone: 'success' },
  invoices: { icon: ReceiptText, tone: 'info' },
  logistics: { icon: Ship, tone: 'info' },
  accounting: { icon: Calculator, tone: 'primary' },
  hr: { icon: Users, tone: 'success' },
  system: { icon: Settings, tone: 'neutral' },
};

const TONE: Readonly<Record<Tone, string>> = {
  primary: 'bg-primary-subtle text-primary-subtle-fg',
  success: 'bg-success-subtle text-success-subtle-fg',
  warning: 'bg-warning-subtle text-warning-subtle-fg',
  info: 'bg-info-subtle text-info-subtle-fg',
  neutral: 'bg-secondary text-muted-fg',
};

export function CategoryIcon({
  category,
  gone = false,
  className,
}: {
  readonly category: NotificationCategory;
  readonly gone?: boolean;
  readonly className?: string;
}) {
  const look = LOOK[category] ?? LOOK.system;
  const Icon = gone ? EyeOff : look.icon;
  return (
    <span
      aria-hidden="true"
      className={cn('grid size-9 shrink-0 place-items-center rounded-full', TONE[gone ? 'neutral' : look.tone], className)}
      data-category={category}
    >
      <Icon className="size-4" />
    </span>
  );
}
