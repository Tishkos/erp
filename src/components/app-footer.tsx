import { getTranslations } from 'next-intl/server';
import { db } from '@/server/db/client';
import { probe, version } from '@/server/services/system-health';

/**
 * The footer every signed-in page ends with.
 *
 * Left: whose system this is. Right: a health light — green when the database
 * answered this request *and the schema is at head* (the same probe /healthz
 * answers, REQ-IMPROVE-001 OP-4), red when either is not so. It is a real
 * probe, not a decoration: the one thing a user most needs to know when a
 * screen misbehaves is whether the system behind it is reachable.
 *
 * Centre: the version that is running, read from package.json — beside the
 * copyright and the health light, where a reader takes it as a note about
 * the system rather than a caveat on the thing being typed.
 */
export async function AppFooter() {
  const t = await getTranslations('shell');
  const healthy = await db
    .transaction((tx) => probe(tx))
    .then((result) => result.ok)
    .catch(() => false);

  return (
    <footer className="erp-footer" role="contentinfo">
      <div className="erp-footer__inner">
        <span className="erp-footer__copy">{t('footer_copyright', { year: new Date().getFullYear() })}</span>
        <span className="erp-footer__version">{t('footer_version', { version: version() })}</span>
        <span className={`erp-footer__health${healthy ? '' : ' erp-footer__health--down'}`}>
          <span className="erp-footer__dot" aria-hidden="true" />
          {healthy ? t('system_healthy') : t('system_degraded')}
        </span>
      </div>
    </footer>
  );
}
