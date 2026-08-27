'use client';

import { useId, useState } from 'react';
import { useFormStatus } from 'react-dom';
import type { KeyboardEvent } from 'react';
import { ArrowRight, Eye, EyeOff, Loader2, Lock, Mail, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * The interactive pieces of the sign-in form. The form itself stays a server
 * component; only the two things that need browser state live here — the
 * password visibility toggle, and the submit button that knows the action is
 * in flight.
 */

const INPUT =
  'h-12 rounded-xl border-border-strong bg-surface ps-11 text-[15px] shadow-[inset_0_1px_2px_rgb(10_17_36_/_3%)] transition-[border-color,box-shadow] placeholder:text-muted-foreground/70 hover:border-ring/60 focus-visible:border-ring focus-visible:ring-4 focus-visible:ring-ring/15';

const ICON =
  'pointer-events-none absolute inset-y-0 start-0 flex w-11 items-center justify-center text-muted-foreground transition-colors peer-focus-visible:text-primary';

export function EmailField({
  id,
  label,
  placeholder,
}: {
  readonly id: string;
  readonly label: string;
  readonly placeholder: string;
}) {
  return (
    <div className="grid gap-2">
      <label className="text-[13px] font-semibold text-foreground" htmlFor={id}>
        {label}
      </label>
      <div className="relative">
        <Input
          autoComplete="username"
          className={cn('peer', INPUT)}
          id={id}
          name="email"
          placeholder={placeholder}
          required
          type="email"
        />
        <span aria-hidden="true" className={ICON}>
          <Mail className="size-[18px]" />
        </span>
      </div>
    </div>
  );
}

export function PasswordField({
  id,
  label,
  placeholder,
  showLabel,
  hideLabel,
  capsLockLabel,
}: {
  readonly id: string;
  readonly label: string;
  readonly placeholder: string;
  readonly showLabel: string;
  readonly hideLabel: string;
  readonly capsLockLabel: string;
}) {
  const [visible, setVisible] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const toggleId = useId();
  const capsId = useId();

  // Caps Lock is the commonest reason a correct password is refused, and the
  // one the failure message (deliberately) cannot name.
  const watchCapsLock = (event: KeyboardEvent<HTMLInputElement>) =>
    setCapsLock(event.getModifierState('CapsLock'));

  return (
    <div className="grid gap-2">
      <label className="text-[13px] font-semibold text-foreground" htmlFor={id}>
        {label}
      </label>
      <div className="relative">
        <Input
          aria-describedby={capsLock ? `${toggleId} ${capsId}` : toggleId}
          autoComplete="current-password"
          className={cn('peer pe-12', INPUT)}
          id={id}
          name="password"
          onBlur={() => setCapsLock(false)}
          onKeyDown={watchCapsLock}
          onKeyUp={watchCapsLock}
          placeholder={placeholder}
          required
          type={visible ? 'text' : 'password'}
        />
        <span aria-hidden="true" className={ICON}>
          <Lock className="size-[18px]" />
        </span>
        <button
          aria-label={visible ? hideLabel : showLabel}
          aria-pressed={visible}
          className="absolute inset-y-1.5 end-1.5 grid w-9 cursor-pointer place-items-center rounded-lg border-0 bg-transparent p-0 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
          id={toggleId}
          onClick={() => setVisible((value) => !value)}
          type="button"
        >
          {visible ? <EyeOff className="size-[18px]" /> : <Eye className="size-[18px]" />}
        </button>
      </div>
      {capsLock ? (
        <p
          className="m-0 flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400"
          id={capsId}
          role="status"
        >
          <TriangleAlert aria-hidden="true" className="size-3.5" />
          {capsLockLabel}
        </p>
      ) : null}
    </div>
  );
}

export function RememberMe({ label }: { readonly label: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 text-[13px] text-foreground select-none">
      <input
        className="size-[18px] cursor-pointer rounded-md accent-[var(--accent)]"
        defaultChecked
        name="remember"
        type="checkbox"
        value="1"
      />
      <span>{label}</span>
    </label>
  );
}

export function SubmitButton({ label, pendingLabel }: { readonly label: string; readonly pendingLabel: string }) {
  const { pending } = useFormStatus();

  return (
    <Button
      aria-busy={pending}
      className="group/submit relative h-12 w-full overflow-hidden rounded-xl bg-[linear-gradient(135deg,var(--accent),var(--accent-hover))] text-[15px] font-semibold text-white! shadow-[0_10px_24px_-10px_rgb(var(--accent-rgb)/65%)] transition-[transform,box-shadow,filter] hover:shadow-[0_14px_28px_-10px_rgb(var(--accent-rgb)/75%)] hover:brightness-105 active:translate-y-px disabled:opacity-80"
      disabled={pending}
      type="submit"
    >
      {pending ? (
        <>
          <Loader2 className="size-[18px] animate-spin" />
          <span>{pendingLabel}</span>
        </>
      ) : (
        <>
          <span>{label}</span>
          <ArrowRight className="size-[18px] transition-transform group-hover/submit:translate-x-0.5 rtl:rotate-180 rtl:group-hover/submit:-translate-x-0.5" />
        </>
      )}
    </Button>
  );
}
