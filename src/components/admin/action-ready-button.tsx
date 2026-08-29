'use client';

import { useEffect, useState, useTransition } from 'react';
import styles from './admin.module.css';

/**
 * A row action that cannot be lost.
 *
 * A plain server-action form pressed while the page is mid-refresh — the
 * grid has just saved a line and is redrawing — can be dropped without a
 * request ever leaving the browser. This button builds the form itself and
 * calls the action inside a transition, so the press is carried through the
 * redraw; it is disabled until the component has mounted and while the
 * action runs, so it can neither be pressed too early nor twice.
 */
export function ActionReadyButton({
  action,
  hidden,
  label,
  tone = 'secondary',
}: {
  readonly action: (formData: FormData) => Promise<void>;
  readonly hidden: Readonly<Record<string, string>>;
  readonly label: string;
  readonly tone?: 'primary' | 'secondary' | 'danger';
}) {
  const [ready, setReady] = useState(false);
  const [pending, startTransition] = useTransition();
  useEffect(() => setReady(true), []);

  const cls = [styles.button, tone === 'primary' ? styles.primary : '', tone === 'danger' ? styles.danger : '']
    .filter(Boolean)
    .join(' ');

  return (
    <button
      className={cls}
      disabled={!ready || pending}
      onClick={() => {
        const form = new FormData();
        for (const [name, value] of Object.entries(hidden)) form.set(name, value);
        startTransition(() => action(form));
      }}
      type="button"
    >
      {label}
    </button>
  );
}
