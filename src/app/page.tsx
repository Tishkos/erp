import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/app-shell';
import { optionalContext } from '@/server/session';
import { visibleMenu } from '@domain/menu';

/**
 * My Dashboard — Appendix A menu 1, Phase 01.12.
 *
 * The landing screen. Its widgets (my tasks, my approvals, recent records)
 * arrive with the modules that produce them; what exists now is the shell
 * itself and an honest account of what the signed-in user may reach.
 */
export const dynamic = 'force-dynamic';

export default async function Home() {
  const context = await optionalContext();
  if (!context) redirect('/sign-in');

  const t = await getTranslations();
  const sections = visibleMenu(context.principal);
  const reachable = sections.flatMap((s) => s.items).filter((i) => i.href !== null);

  return (
    <AppShell>
      <div className="page__header">
        <h1 className="page__title">{t('page.my_dashboard')}</h1>
      </div>

      <section className="panel">
        <h2 className="panel__title">{t('page.recent_records')}</h2>
        <ul className="nav__list">
          {reachable.map((item) => (
            <li key={item.key}>
              <a className="nav__link" href={item.href!}>
                {t(`page.${item.key}`)}
              </a>
            </li>
          ))}
        </ul>
      </section>

      <section className="panel">
        <h2 className="panel__title">{t('phase.not_built')}</h2>
        <p className="muted">{t('phase.explanation')}</p>
      </section>
    </AppShell>
  );
}
