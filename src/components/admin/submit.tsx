'use client';

import { useEffect, useState } from 'react';
import { useFormStatus } from 'react-dom';
import styles from './admin.module.css';

/**
 * The submit button of every administration form.
 *
 * A server-action form pressed in the moment before the page has hydrated is
 * dropped without a word — no request, no error — and on a heavy page that
 * is the press a person actually makes: the account dialog, the member form,
 * the branch form all lost their first press this way (2026-08-29). The
 * button is disabled until the component has mounted, which is the earliest
 * moment the action can run, and while the form is being submitted, so it
 * can be pressed neither too early nor twice.
 */
export function Submit({
  label,
  tone = 'primary',
  small,
}: {
  readonly label: string;
  readonly tone?: 'primary' | 'secondary' | 'danger';
  readonly small?: boolean;
}) {
  const [ready, setReady] = useState(false);
  const { pending } = useFormStatus();
  useEffect(() => setReady(true), []);

  const cls = [
    styles.button,
    tone === 'primary' ? styles.primary : '',
    tone === 'danger' ? styles.danger : '',
    small ? styles.small : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button className={cls} disabled={!ready || pending} type="submit">
      {label}
    </button>
  );
}
