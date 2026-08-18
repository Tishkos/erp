import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { visibleMenu } from '@domain/menu';
import { requireContext } from '@/server/session';
import { Navigation } from './navigation';

/**
 * The application shell — Phase 01.12.
 *
 * Resolves the caller once per request and hands the pruned menu to the
 * navigation. Doing it here rather than in each page means no screen can be
 * reached without a resolved principal, which is what §25's deny-by-default
 * requires of *"every page, API and record"*.
 */
export async function AppShell({ children }: { children: ReactNode }) {
  const t = await getTranslations();
  const { principal, scope } = await requireContext();
  const sections = visibleMenu(principal);

  return (
    <div className="shell">
      <header className="shell__header">
        <span className="shell__brand">{t('app.name')}</span>
        <span className="shell__spacer" />
        <div className="shell__identity">
          {/* The branch a document raised now will belong to — shown, not
              buried in a menu, because posting to the wrong branch is
              expensive to unwind (§4.1). */}
          <span>{scope.branchCode || '—'}</span>
          <span aria-hidden>·</span>
          <span>{principal.userId.slice(0, 8)}</span>
        </div>
      </header>

      <Navigation sections={sections} />

      <main className="shell__main">{children}</main>
    </div>
  );
}
