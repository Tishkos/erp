'use client';

import { useTranslations } from 'next-intl';
import { TriangleAlert } from 'lucide-react';
import styles from '../route-states.module.css';

/**
 * The boundary a failed render falls into.
 *
 * §25 asks for a reason and a corrective action rather than a blank page or a
 * stack trace. The reason a reader most needs on an accounting screen is the
 * second line: nothing was written. A failure that leaves someone unsure
 * whether their document posted is worse than the failure itself.
 *
 * `reset` is React's own retry — it re-renders the segment without a full page
 * load, so the reader keeps their place in the shell.
 */
export default function ScreenError({ reset }: { readonly reset: () => void }) {
  const t = useTranslations('error');

  return (
    <main className={styles.state}>
      <div className={styles.stateCard} role="alert">
        <span className={`${styles.stateIcon} ${styles.stateIconAlert}`}>
          <TriangleAlert aria-hidden="true" />
        </span>
        <h1>{t('error_title')}</h1>
        <p>{t('error_body')}</p>
        <button className={styles.stateAction} onClick={reset} type="button">
          {t('error_action')}
        </button>
      </div>
    </main>
  );
}
