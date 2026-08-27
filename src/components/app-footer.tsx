import { getTranslations } from 'next-intl/server';
import { currentPhase } from '@/server/phase-gate';
import { sql } from 'drizzle-orm';
import { db } from '@/server/db/client';

/**
 * The footer every signed-in page ends with.
 *
 * Left: whose system this is. Centre: which release is running. Right: a
 * health light — green when the database answered this request, red when it
 * did not. It is a real probe, not a decoration: the one thing a user most
 * needs to know when a screen misbehaves is whether the system behind it is
 * reachable.
 */
export async function AppFooter() {
  const t = await getTranslations('shell');
  const healthy = await db
    .execute(sql`select 1`)
    .then(() => true)
    .catch(() => false);

  return (
    <footer className="erp-footer" role="contentinfo">
      <div className="erp-footer__inner">
        <span className="erp-footer__copy">{t('footer_copyright', { year: new Date().getFullYear() })}</span>
        <span className="erp-footer__version">{t('footer_version', { version: currentPhase() })}</span>
        <span className={`erp-footer__health${healthy ? '' : ' erp-footer__health--down'}`}>
          <span className="erp-footer__dot" aria-hidden="true" />
          {healthy ? t('system_healthy') : t('system_degraded')}
        </span>
      </div>
    </footer>
  );
}
