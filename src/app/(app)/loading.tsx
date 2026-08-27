import type { CSSProperties } from 'react';
import { getTranslations } from 'next-intl/server';
import styles from '../route-states.module.css';

/**
 * What a screen shows while it is being produced.
 *
 * Every page in this application is `force-dynamic`, so there is always a
 * server round trip between the click and the content. This file sits inside
 * the `(app)` layout, so the header and navigation stay exactly where they
 * were — only the page segment is swapped for this placeholder, and then for
 * the screen.
 *
 * Two signals, for two distances. A thin progress bar along the top of the
 * viewport says "something is happening" from across the room; a skeleton in
 * the shape of a typical screen — title and actions, a toolbar, a table —
 * reserves the space the real screen will take so nothing jumps when it lands.
 */
const ROWS = [0, 1, 2, 3, 4, 5, 6, 7] as const;
const COLUMNS = [0, 1, 2, 3, 4] as const;

export default async function Loading() {
  const t = await getTranslations('error');

  return (
    <div aria-busy="true" aria-live="polite" className={styles.skeleton}>
      <span className={styles.srOnly}>{t('loading_title')}</span>
      <span aria-hidden="true" className={styles.progress} />

      <div className={styles.skeletonHeader}>
        <div className={styles.skeletonHeading}>
          <span className={`${styles.bar} ${styles.crumb}`} />
          <span className={`${styles.bar} ${styles.title}`} />
          <span className={`${styles.bar} ${styles.subtitle}`} />
        </div>
        <div className={styles.skeletonActions}>
          <span className={`${styles.bar} ${styles.ghostButton}`} />
          <span className={`${styles.bar} ${styles.primaryButton}`} />
        </div>
      </div>

      <div className={styles.skeletonStrip}>
        {[0, 1, 2, 3].map((slot) => (
          <span className={styles.card} key={slot}>
            <span className={`${styles.bar} ${styles.cardLabel}`} />
            <span className={`${styles.bar} ${styles.cardValue}`} />
          </span>
        ))}
      </div>

      <div className={styles.skeletonTable}>
        <div className={styles.skeletonToolbar}>
          <span className={`${styles.bar} ${styles.search}`} />
          <span className={`${styles.bar} ${styles.chip}`} />
          <span className={`${styles.bar} ${styles.chip}`} />
        </div>
        <div className={`${styles.skeletonRow} ${styles.skeletonRowHead}`}>
          {COLUMNS.map((column) => (
            <span className={`${styles.bar} ${styles.cell}`} key={column} />
          ))}
        </div>
        {ROWS.map((row) => (
          <div
            className={styles.skeletonRow}
            key={row}
            style={{ '--row': row } as CSSProperties}
          >
            {COLUMNS.map((column) => (
              <span className={`${styles.bar} ${styles.cell}`} key={column} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
