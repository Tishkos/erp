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
 *
 * `variant="document"` wears the document window's own buttons instead of the
 * application's. Those windows had been building their buttons by hand, which
 * meant a create or an approve had neither guard: pressing Create twice raised
 * the document twice, and a person who double-clicked raised it as many times
 * as the press was registered (reported 2026-09-27). A second press on an
 * approve would have posted the journal twice.
 */
export function Submit({
  label,
  name,
  tone = 'primary',
  small,
  variant = 'admin',
}: {
  readonly label: string;
  /**
   * What the button is called, when its face does not say so. An arrow reads
   * as "black up-pointing triangle" to a screen reader and as nothing at all
   * on hover, so a button wearing one is given its name here.
   */
  readonly name?: string | undefined;
  readonly tone?: 'primary' | 'secondary' | 'danger';
  readonly small?: boolean;
  /** Which chrome: the application's forms, or a document window's actions. */
  readonly variant?: 'admin' | 'document';
}) {
  const [ready, setReady] = useState(false);
  const { pending } = useFormStatus();
  useEffect(() => setReady(true), []);

  const cls =
    variant === 'document'
      ? `action${tone === 'primary' ? ' action--primary' : ''}`
      : [
          styles.button,
          tone === 'primary' ? styles.primary : '',
          tone === 'danger' ? styles.danger : '',
          small ? styles.small : '',
        ]
          .filter(Boolean)
          .join(' ');
  return (
    <button
      className={cls}
      disabled={!ready || pending}
      type="submit"
      {...(name ? { 'aria-label': name, title: name } : {})}
    >
      {label}
    </button>
  );
}
