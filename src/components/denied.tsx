import { getTranslations } from 'next-intl/server';
import { Lock } from 'lucide-react';
// The palettes' `--w-*` tokens, which the Intent theme reads: a refused page
// draws no screen that would have loaded them.
import '@/components/admin/admin.module.css';

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
 *
 * Drawn as the other route states are — Intent UI's empty state in a card
 * (2026-10-06) — in utilities over the legacy `.panel`. The markup the tests
 * and Noah's camera read stays: `.panel[role="alert"] > h1.page__title`, and
 * no class that contains "stateCard" (that is the missing/failed card).
 */
export async function Denied({ object }: { object: string }) {
  const t = await getTranslations();

  return (
    <div
      className="panel mx-auto my-10 grid w-full max-w-md justify-items-center gap-1.5 rounded-xl border border-border bg-overlay px-6 pt-9 pb-8 text-center text-overlay-fg shadow-xs"
      role="alert"
    >
      <span
        aria-hidden="true"
        className="mb-3 grid size-12 place-items-center rounded-full bg-warning-subtle text-warning-subtle-fg ring-[0.45rem] ring-warning-subtle/45"
      >
        <Lock className="size-5" />
      </span>
      <h1 className="page__title m-0 text-lg/7 font-semibold tracking-tight text-balance text-fg rtl:tracking-normal">
        {t('error.no_permission_title')}
      </h1>
      <p className="m-0 max-w-sm text-sm/6 text-muted-fg">{t('error.no_permission')}</p>
      <p className="muted m-0 max-w-sm text-sm/6 text-muted-fg">{t('error.no_permission_next', { object })}</p>
    </div>
  );
}
