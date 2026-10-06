import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { House, MapPinOff } from 'lucide-react';
// The palettes' `--w-*` tokens, which the Intent theme reads: a missing page
// may be the first thing a session draws, before any screen has loaded them.
import '@/components/admin/admin.module.css';
import styles from './route-states.module.css';

/**
 * An address that is not in the approved tree.
 *
 * The catch-all serves every menu item, so reaching this page means the URL was
 * typed or followed from somewhere stale. It says which of the two things went
 * wrong — the page does not exist, as opposed to *you may not see it*, which is
 * the refusal in `Denied` — because telling a reader "not found" when they mean
 * "not allowed" sends them to the wrong person for help.
 *
 * Drawn as Intent UI's empty state (2026-10-06): the icon in a soft circle,
 * the title, the reason, the way on.
 */
export default async function NotFound() {
  const t = await getTranslations('error');

  return (
    <main className={styles.state}>
      <div className={styles.stateCard} role="alert">
        <span aria-hidden="true" className={styles.stateIcon}>
          <MapPinOff />
        </span>
        <h1>{t('not_found_title')}</h1>
        <p>{t('not_found_body')}</p>
        <div className={styles.stateActions}>
          <Link className={styles.stateAction} href="/">
            <House aria-hidden="true" />
            <span>{t('not_found_action')}</span>
          </Link>
        </div>
      </div>
    </main>
  );
}
