'use client';

import { useId, useState } from 'react';
import { useFormStatus } from 'react-dom';
import type { KeyboardEvent } from 'react';
import { ArrowRight, Eye, EyeOff, Loader2, Lock, Mail, TriangleAlert } from 'lucide-react';
import styles from '@/app/sign-in/sign-in.module.css';

/**
 * The interactive pieces of the sign-in form. The form itself stays a server
 * component; only the two things that need browser state live here — the
 * password visibility toggle, and the submit button that knows the action is
 * in flight.
 */

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
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <div className="relative">
        <input
          autoComplete="username"
          className={styles.input}
          id={id}
          name="email"
          placeholder={placeholder}
          required
          type="email"
        />
        <span aria-hidden="true" className={styles.icon}>
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
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <div className="relative">
        <input
          aria-describedby={capsLock ? `${toggleId} ${capsId}` : toggleId}
          autoComplete="current-password"
          className={styles.input}
          id={id}
          name="password"
          onBlur={() => setCapsLock(false)}
          onKeyDown={watchCapsLock}
          onKeyUp={watchCapsLock}
          placeholder={placeholder}
          required
          type={visible ? 'text' : 'password'}
        />
        <span aria-hidden="true" className={styles.icon}>
          <Lock className="size-[18px]" />
        </span>
        <button
          aria-label={visible ? hideLabel : showLabel}
          aria-pressed={visible}
          className={styles.toggle}
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
    <label className={styles.remember}>
      <input
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
      className={styles.submit}
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
    </button>
  );
}
