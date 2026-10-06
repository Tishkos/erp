'use client';

import { useTranslations } from 'next-intl';
import { RotateCcw, TriangleAlert } from 'lucide-react';
// The palettes' `--w-*` tokens, which the Intent theme reads (a failed render
// may come before any screen has loaded them).
import '@/components/admin/admin.module.css';
import styles from './route-states.module.css';

/**
 * The boundary a failed render falls into.
 *
 * §25 asks for a reason and a corrective action rather than a blank page or a
 * stack trace. The reason a reader most needs on an accounting screen is the
 * second line: nothing was written. A failure that leaves someone unsure
 * whether their document posted is worse than the failure itself.
 *
 * The reference line is React's error digest, which `instrumentation.ts`
 * wrote on the log line for this failure; it is what support asks for.
 *
 * `reset` is React's own retry — it re-renders the segment without a full page
 * load, so the reader keeps their place in the shell.
 *
 * Drawn as Intent UI's empty state (2026-10-06), its icon in the danger tint.
 */
export default function ScreenError({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}) {
  const t = useTranslations('error');

  return (
    <main className={styles.state}>
      <div className={styles.stateCard} role="alert">
        <span aria-hidden="true" className={`${styles.stateIcon} ${styles.stateIconAlert}`}>
          <TriangleAlert />
        </span>
        <h1>{t('error_title')}</h1>
        <p>{t('error_body')}</p>
        {/* OP-5 — the digest is on the server's log line for this failure. */}
        {error.digest ? <p className={styles.stateReference}>{t('error_reference', { digest: error.digest })}</p> : null}
        <div className={styles.stateActions}>
          <button className={styles.stateAction} onClick={reset} type="button">
            <RotateCcw aria-hidden="true" />
            <span>{t('error_action')}</span>
          </button>
        </div>
      </div>
    </main>
  );
}
