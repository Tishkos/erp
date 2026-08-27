import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { MapPinOff } from 'lucide-react';
import styles from './route-states.module.css';

/**
 * An address that is not in the approved tree.
 *
 * The catch-all serves every menu item, so reaching this page means the URL was
 * typed or followed from somewhere stale. It says which of the two things went
 * wrong — the page does not exist, as opposed to *you may not see it*, which is
 * the refusal in `Denied` — because telling a reader "not found" when they mean
 * "not allowed" sends them to the wrong person for help.
 */
export default async function NotFound() {
  const t = await getTranslations('error');

  return (
    <main className={styles.state}>
      <div className={styles.stateCard} role="alert">
        <span className={styles.stateIcon}>
          <MapPinOff aria-hidden="true" />
        </span>
        <h1>{t('not_found_title')}</h1>
        <p>{t('not_found_body')}</p>
        <Link className={styles.stateAction} href="/">
          {t('not_found_action')}
        </Link>
      </div>
    </main>
  );
}
