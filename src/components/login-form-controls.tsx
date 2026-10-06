'use client';

import { useId, useState } from 'react';
import { useFormStatus } from 'react-dom';
import type { KeyboardEvent, ReactNode } from 'react';
import { ArrowRight, Eye, EyeOff, KeyRound, Languages, Loader2, Lock, LogOut, Mail, TriangleAlert } from 'lucide-react';
import { buttonStyles } from '@/components/intent/button';
import { cn } from '@/components/intent/cn';

/**
 * The interactive pieces of the sign-in form. The form itself stays a server
 * component; only the things that need browser state live here — the
 * password visibility toggle, the submit button that knows the action is in
 * flight, and the language switch.
 *
 * The inputs stay native (`name`, `id`, `type` and labels are what the server
 * action reads and the end-to-end tests drive); they are drawn as Intent UI's
 * `Input` is (the Intent UI redesign, 2026-10-06).
 */

/** Intent UI's `Input`, on a native `<input>`. */
const inputStyles = cn(
  'block h-10 w-full min-w-0 appearance-none rounded-lg border border-input bg-transparent px-3 shadow-xs sm:h-9',
  'text-base/6 text-fg placeholder:text-muted-fg sm:text-sm/6',
  'outline-hidden transition-[border-color,box-shadow] enabled:hover:border-muted-fg/40',
  'focus:border-ring/70 focus:ring-3 focus:ring-ring/20 focus:enabled:hover:border-ring/80',
  '[&::-ms-reveal]:hidden dark:scheme-dark',
);

const labelStyles = 'text-sm/6 font-medium text-fg select-none';

/** The icon at the start of a field. */
function FieldIcon({ children }: { readonly children: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0 start-0 z-10 grid w-9 place-items-center text-muted-fg *:size-4"
    >
      {children}
    </span>
  );
}

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
    <div className="grid gap-1.5">
      <label className={labelStyles} htmlFor={id}>
        {label}
      </label>
      <div className="relative">
        <FieldIcon>
          <Mail />
        </FieldIcon>
        <input
          autoComplete="username"
          className={cn(inputStyles, 'ps-9')}
          id={id}
          name="email"
          placeholder={placeholder}
          required
          type="email"
        />
      </div>
    </div>
  );
}

/** HD4 — the six-digit authenticator code, asked for when the account requires one. */
export function CodeField({
  id,
  label,
  placeholder,
}: {
  readonly id: string;
  readonly label: string;
  readonly placeholder: string;
}) {
  return (
    <div className="grid gap-1.5">
      <label className={labelStyles} htmlFor={id}>
        {label}
      </label>
      <div className="relative">
        <FieldIcon>
          <KeyRound />
        </FieldIcon>
        <input
          autoComplete="one-time-code"
          className={cn(inputStyles, 'ps-9 tabular-nums')}
          id={id}
          inputMode="numeric"
          maxLength={7}
          name="code"
          pattern="[0-9 ]{6,7}"
          placeholder={placeholder}
          required
          type="text"
        />
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
  name = 'password',
  autoComplete = 'current-password',
  hint,
}: {
  readonly id: string;
  readonly label: string;
  readonly placeholder: string;
  readonly showLabel: string;
  readonly hideLabel: string;
  readonly capsLockLabel: string;
  /** The password screen's three fields (REQ-FIX-001 FIX-2) post under their own names. */
  readonly name?: string;
  readonly autoComplete?: 'current-password' | 'new-password';
  readonly hint?: string;
}) {
  const [visible, setVisible] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const toggleId = useId();
  const capsId = useId();
  const hintId = useId();

  // Caps Lock is the commonest reason a correct password is refused, and the
  // one the failure message (deliberately) cannot name.
  const watchCapsLock = (event: KeyboardEvent<HTMLInputElement>) =>
    setCapsLock(event.getModifierState('CapsLock'));

  return (
    <div className="grid gap-1.5">
      <label className={labelStyles} htmlFor={id}>
        {label}
      </label>
      <div className="relative">
        <FieldIcon>
          <Lock />
        </FieldIcon>
        <input
          aria-describedby={[toggleId, capsLock ? capsId : null, hint ? hintId : null].filter(Boolean).join(' ')}
          autoComplete={autoComplete}
          className={cn(inputStyles, 'ps-9 pe-11')}
          id={id}
          name={name}
          onBlur={() => setCapsLock(false)}
          onKeyDown={watchCapsLock}
          onKeyUp={watchCapsLock}
          placeholder={placeholder}
          required
          type={visible ? 'text' : 'password'}
        />
        <button
          aria-label={visible ? hideLabel : showLabel}
          aria-pressed={visible}
          className={cn(
            'absolute inset-y-0 end-1 my-auto grid size-8 cursor-pointer place-items-center rounded-md border-0 bg-transparent p-0 sm:size-7',
            'text-muted-fg hover:bg-secondary hover:text-fg',
            'outline-hidden focus-visible:ring-2 focus-visible:ring-ring/60',
          )}
          id={toggleId}
          onClick={() => setVisible((value) => !value)}
          type="button"
        >
          {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </div>
      {hint ? (
        <p className="m-0 text-xs/5 text-muted-fg" id={hintId}>
          {hint}
        </p>
      ) : null}
      {capsLock ? (
        <p className="m-0 flex items-center gap-1.5 text-xs/5 font-medium text-warning-subtle-fg" id={capsId} role="status">
          <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />
          {capsLockLabel}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The checkbox is the application's own (`[data-palette] input[type=checkbox]`
 * in admin.module.css: the accent, its ink for the tick, native rendering in
 * forced colours); here it only takes Intent UI's shape.
 */
export function RememberMe({ label }: { readonly label: string }) {
  return (
    <label className="flex w-fit cursor-pointer items-center gap-2.5 text-sm/6 text-fg select-none">
      <input
        className="size-4 shrink-0 rounded-[0.3rem] border-input shadow-xs checked:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
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
    <button
      aria-busy={pending}
      className={cn(buttonStyles({ intent: 'primary', size: 'lg' }), 'group/submit mt-1 w-full cursor-pointer disabled:cursor-wait')}
      disabled={pending}
      type="submit"
    >
      {pending ? (
        <>
          <Loader2 aria-hidden="true" className="animate-spin" />
          <span>{pendingLabel}</span>
        </>
      ) : (
        <>
          <span>{label}</span>
          <ArrowRight
            aria-hidden="true"
            className="transition-transform group-hover/submit:translate-x-0.5 rtl:-scale-x-100 rtl:group-hover/submit:-translate-x-0.5 motion-reduce:transition-none"
          />
        </>
      )}
    </button>
  );
}

/** The password page's way out: an outline button, the session's sign-out. */
export function SignOutButton({ label }: { readonly label: string }) {
  const { pending } = useFormStatus();

  return (
    <button
      aria-busy={pending}
      className={cn(buttonStyles({ intent: 'outline', size: 'md' }), 'w-full cursor-pointer disabled:cursor-wait')}
      disabled={pending}
      type="submit"
    >
      {pending ? <Loader2 aria-hidden="true" className="animate-spin" /> : <LogOut aria-hidden="true" className="rtl:-scale-x-100" />}
      <span>{label}</span>
    </button>
  );
}

/**
 * English or Arabic before anyone has signed in. The same device preference
 * the header's toggle writes (`erp-locale`), then a full reload — every
 * server component, the message bundle and the direction change together.
 */
export function LanguageSwitch({
  current,
  label,
  english,
  arabic,
}: {
  readonly current: 'en' | 'ar';
  readonly label: string;
  /** Each language in its own script, so it can be found by someone who reads only that one. */
  readonly english: string;
  readonly arabic: string;
}) {
  const choose = (next: 'en' | 'ar') => {
    if (next === current) return;
    document.cookie = `erp-locale=${next}; Path=/; Max-Age=31536000; SameSite=Lax`;
    window.location.reload();
  };

  return (
    <div
      aria-label={label}
      className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-overlay p-0.5 shadow-xs"
      role="group"
    >
      <Languages aria-hidden="true" className="mx-1.5 size-4 shrink-0 text-muted-fg" />
      {(['en', 'ar'] as const).map((language) => (
        <button
          aria-pressed={current === language}
          className={cn(
            'inline-flex h-7 cursor-pointer items-center rounded-md border-0 px-2.5 text-xs/5 font-medium',
            'outline-hidden focus-visible:ring-2 focus-visible:ring-ring/60',
            current === language
              ? 'bg-secondary text-fg'
              : 'bg-transparent text-muted-fg hover:bg-secondary/60 hover:text-fg',
          )}
          key={language}
          lang={language}
          onClick={() => choose(language)}
          type="button"
        >
          {language === 'ar' ? arabic : english}
        </button>
      ))}
    </div>
  );
}
