import { getTranslations } from 'next-intl/server';
import { sql } from 'drizzle-orm';
import { db } from '@/server/db/client';

/**
 * The footer every signed-in page ends with.
 *
 * Left: whose system this is. Right: a health light — green when the database
 * answered this request, red when it did not. It is a real probe, not a
 * decoration: the one thing a user most needs to know when a screen misbehaves
 * is whether the system behind it is reachable.
 *
 * Centre: which phase of the build is running. By direction (2026-08-31) this
 * is the *only* place a phase is named — it belongs to the footer, beside the
 * copyright and the health light, where a reader takes it as a note about the
 * system's maturity. It does not belong in a field's hint, where it reads as a
 * caveat on the thing being typed.
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
        <span className="erp-footer__version">{t('footer_phase')}</span>
        <span className={`erp-footer__health${healthy ? '' : ' erp-footer__health--down'}`}>
          <span className="erp-footer__dot" aria-hidden="true" />
          {healthy ? t('system_healthy') : t('system_degraded')}
        </span>
      </div>
    </footer>
  );
}
