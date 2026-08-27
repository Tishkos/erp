import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { CalendarClock, Layers, type LucideIcon } from 'lucide-react';
import type { ScreenRoute } from '@domain/screens';
import { routeFor, screenRoutes } from '@domain/screens';
import { AdminPage, Pill, admin as s } from '@/components/admin';
import { Panel } from '@/components/ui';

/**
 * A screen the approved tree names and no phase has built yet.
 *
 * It says exactly that — what the screen is, which module owns it, which
 * phase delivers it, what shape it will take — and offers the live screens
 * in the same section. It draws no figures: an invented number on an ERP
 * screen is worse than an empty one, because someone will act on it.
 */
const ARCHETYPE_ICON: Record<string, LucideIcon> = {};

export async function PlannedScreen({ screen }: { readonly screen: ScreenRoute }) {
  const [t, page, nav, archetype] = await Promise.all([
    getTranslations('screen'),
    getTranslations('page'),
    getTranslations('nav'),
    getTranslations('screen.archetype'),
  ]);
  const title = page(screen.item.key);
  const live = [...screenRoutes().values()].filter(
    (other) => other.section.key === screen.section.key && other.wired && other.route !== screen.route,
  );
  const Icon = ARCHETYPE_ICON[screen.archetype] ?? Layers;

  return (
    <AdminPage
      back={{ href: '/', label: t('planned_back') }}
      subtitle={nav(screen.section.key)}
      title={title}
      trail={[{ href: '/', label: t('planned_back') }]}
    >
      <Panel>
        <div className={s.emptyState} style={{ paddingBlock: '2.6rem' }}>
          <CalendarClock aria-hidden="true" />
          <strong>{t('planned_title')}</strong>
          <p className="muted" style={{ margin: '0.2rem 0 0', maxInlineSize: '40rem' }}>
            {t('planned_body')}
          </p>
          <span style={{ display: 'flex', gap: '0.4rem', marginBlockStart: '0.6rem', flexWrap: 'wrap', justifyContent: 'center' }}>
            <Pill label={archetype(screen.archetype)} on={null} />
            <Pill label={screen.item.object} on={null} />
          </span>
        </div>
      </Panel>

      <Panel title={t('planned_shape')}>
        <p className="muted" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0 }}>
          <Icon aria-hidden="true" style={{ inlineSize: '1rem', blockSize: '1rem' }} />
          {t(`about.${screen.archetype}`)}
        </p>
      </Panel>

      {live.length > 0 ? (
        <Panel title={t('planned_live_in_section')}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
            {live.map((other) => (
              <Link className={`${s.button} ${s.small}`} href={routeFor(other.item, other.section.key)} key={other.route}>
                {page(other.item.key)}
              </Link>
            ))}
          </div>
        </Panel>
      ) : null}
    </AdminPage>
  );
}
