'use client';

import { useEffect, useState, useTransition } from 'react';
import { Plus } from 'lucide-react';
import styles from './admin.module.css';

/**
 * A button that does one thing on the server, and cannot be pressed before
 * it is able to.
 *
 * A server action pressed in the moment before the page has hydrated is
 * dropped without a word — no request, no error, and on a slow page that is
 * the press a person actually makes. This button is disabled until the
 * component has mounted, which is the earliest moment the action can run, and
 * disabled again while it runs so it cannot be pressed twice.
 */
export function ReadyButton({
  action,
  label,
  primary = true,
  icon = true,
}: {
  readonly action: () => Promise<void>;
  readonly label: string;
  readonly primary?: boolean;
  readonly icon?: boolean;
}) {
  const [ready, setReady] = useState(false);
  const [pending, startTransition] = useTransition();
  useEffect(() => setReady(true), []);

  return (
    <button
      className={`${styles.button}${primary ? ` ${styles.primary}` : ''}`}
      disabled={!ready || pending}
      onClick={() => startTransition(() => action())}
      type="button"
    >
      {icon ? <Plus aria-hidden="true" /> : null}
      <span>{label}</span>
    </button>
  );
}
