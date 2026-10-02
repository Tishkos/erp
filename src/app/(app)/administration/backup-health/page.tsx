import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, Pill, admin as s } from '@/components/admin';
import { SectionTabs } from '@/components/admin/section-tabs';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { can } from '@domain/permissions';
import { requireContext, withCurrentUser } from '@/server/session';
import * as health from '@/server/services/system-health';

/**
 * Backup and Health — REQ-IMPROVE-001 OP-4 (IM3).
 *
 * Copies the Payables Settings screen: a settings page whose registers are
 * stacked `sapDoc` sections. Everything on it is read now, not cached: the
 * probe /healthz answers, the findings the daily job notifies, the backup
 * sets on disk.
 */
export const dynamic = 'force-dynamic';

function size(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.round(bytes / 1e3)} kB`;
}

export default async function BackupHealthPage({ searchParams }: { searchParams: SearchParams }) {
  const [t, page, column, locale, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', health.PERMISSION_OBJECT)) {
    return <Denied object={page('backup_health')} />;
  }
  const [probe, report] = await withCurrentUser(async (tx) => [await health.probe(tx), await health.check(tx)] as const);
  const backups = health.backupSets();
  const when = (value: string | null) =>
    value ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';

  const facts: readonly { readonly label: string; readonly value: string; readonly ok: boolean | null }[] = [
    { label: t('backup_health.database'), value: probe.database ? t('backup_health.reachable') : t('backup_health.unreachable'), ok: probe.database },
    {
      label: t('backup_health.migrations'),
      value: `${t('backup_health.migrations_value', { applied: probe.migrations.applied, expected: probe.migrations.expected ?? '?' })} — ${probe.migrations.atHead ? t('backup_health.at_head') : t('backup_health.behind')}`,
      ok: probe.migrations.atHead,
    },
    { label: t('backup_health.version'), value: probe.version, ok: null },
    { label: t('backup_health.build'), value: probe.build, ok: null },
    { label: t('backup_health.revision'), value: probe.revision, ok: null },
    { label: t('backup_health.business_date'), value: report.today, ok: null },
    { label: t('backup_health.checked_at'), value: when(probe.checkedAt), ok: null },
  ];

  return (
    <AdminPage
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/administration/backup-health" />}
      subtitle={t('backup_health.subtitle')}
      title={t('backup_health.title')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <section aria-labelledby="bh-probe-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="bh-probe-title">
            <span>{t('backup_health.probe')}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{column('name')}</th>
                  <th scope="col">{column('value')}</th>
                  <th scope="col">{column('result')}</th>
                </tr>
              </thead>
              <tbody>
                {facts.map((fact) => (
                  <tr key={fact.label}>
                    <td>{fact.label}</td>
                    <td>
                      <bdi dir="ltr">{fact.value}</bdi>
                    </td>
                    <td>{fact.ok === null ? '—' : <Pill label={fact.ok ? t('yes') : t('no')} on={fact.ok} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section aria-labelledby="bh-findings-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="bh-findings-title">
            <span>{t('backup_health.findings')}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{t('backup_health.severity')}</th>
                  <th scope="col">{column('code')}</th>
                  <th scope="col">{t('backup_health.message')}</th>
                </tr>
              </thead>
              <tbody>
                {report.findings.length === 0 ? (
                  <tr>
                    <td colSpan={3}>{t('backup_health.no_findings', { checks: report.checked.join(', ') })}</td>
                  </tr>
                ) : null}
                {report.findings.map((finding, index) => (
                  <tr key={`${finding.code}-${index}`}>
                    <td>
                      <Pill label={finding.severity === 'stop' ? t('backup_health.stop') : t('backup_health.warn')} on={finding.severity === 'stop' ? false : null} />
                    </td>
                    <td>
                      <bdi dir="ltr">{finding.code}</bdi>
                    </td>
                    <td>{finding.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section aria-labelledby="bh-backups-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="bh-backups-title">
            <span>{t('backup_health.backups')}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{t('backup_health.set')}</th>
                  <th scope="col">{t('backup_health.written_at')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('backup_health.size')}
                  </th>
                  <th scope="col">{t('backup_health.complete')}</th>
                  <th scope="col">{t('backup_health.encrypted')}</th>
                  <th scope="col">{t('backup_health.offsite')}</th>
                </tr>
              </thead>
              <tbody>
                {backups.sets.length === 0 ? (
                  <tr>
                    <td colSpan={6}>{t('backup_health.no_backups', { root: backups.root })}</td>
                  </tr>
                ) : null}
                {backups.sets.map((set) => (
                  <tr key={set.name}>
                    <td>
                      <bdi dir="ltr">{set.name}</bdi>
                    </td>
                    <td>{when(set.writtenAt)}</td>
                    <td className={s.sapNum}>{size(set.bytes)}</td>
                    <td>
                      <Pill label={set.complete ? t('yes') : t('no')} on={set.complete} />
                    </td>
                    <td>
                      <Pill label={set.encrypted ? t('yes') : t('no')} on={set.encrypted} />
                    </td>
                    <td>
                      <Pill label={set.offsite ? t('yes') : t('no')} on={set.offsite} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </AdminPage>
  );
}
