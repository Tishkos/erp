import { getTranslations } from 'next-intl/server';

/**
 * The refusal screen — Phase 01.2, rendered by Phase 01.12's shell.
 *
 * §25: *"Use deny-by-default, server-side authorisation for every page, API and
 * record. Navigation hiding alone is not access control."* The 01.2 gate makes
 * the same point from the user's side: *"A user without View on an object
 * receives denial on the direct URL, not merely a hidden menu item."*
 *
 * So a page the user may not open must have something to render. Not a stack
 * trace and not a blank 500 — those read as a broken system and generate a
 * support ticket rather than a permission request. §25 again: *"Validation
 * messages identify the field, reason and corrective action."*
 *
 * What it deliberately does not say is what the page would have contained, or
 * whether the record exists. A refusal that leaks the shape of what was refused
 * is a slower way of granting access.
 */
export async function Denied({ object }: { object: string }) {
  const t = await getTranslations();

  return (
    <div className="panel" role="alert">
      <h1 className="page__title">{t('error.no_permission_title')}</h1>
      <p>{t('error.no_permission')}</p>
      <p className="muted">{t('error.no_permission_next', { object })}</p>
    </div>
  );
}
