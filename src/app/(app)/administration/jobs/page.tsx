import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, Pill, admin as s } from '@/components/admin';
import { SectionTabs } from '@/components/admin/section-tabs';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { can } from '@domain/permissions';
import { requireContext, withCurrentUser } from '@/server/session';
import * as jobs from '@/server/services/scheduled-jobs';

/**
 * Background Jobs — REQ-IMPROVE-001 OP-4 / OP-7.
 *
 * Copies the Payables Settings screen: one settings page, its registers
 * stacked as `sapDoc` sections. Read-only — a job is run on the server.
 */
export const dynamic = 'force-dynamic';

export default async function BackgroundJobsPage({ searchParams }: { searchParams: SearchParams }) {
  const [t, page, column, locale, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', jobs.PERMISSION_OBJECT)) {
    return <Denied object={page('background_jobs')} />;
  }
  const actor = { principal, branchCode: context.scope.branchCode };
  const [scheduled, hand] = await Promise.all([
    jobs.listScheduled(actor),
    withCurrentUser((tx) => jobs.outbox(tx, actor)),
  ]);
  const when = (value: string | null) =>
    value ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';

  return (
    <AdminPage
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/administration/jobs" />}
      subtitle={t('jobs.subtitle')}
      title={t('jobs.title')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <section aria-labelledby="jobs-scheduled-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="jobs-scheduled-title">
            <span>{t('jobs.scheduled')}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{column('name')}</th>
                  <th scope="col">{t('jobs.schedule')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('jobs.timeout')}
                  </th>
                  <th scope="col">{column('last_run')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('jobs.exit')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('jobs.duration')}
                  </th>
                  <th scope="col">{column('status')}</th>
                  <th scope="col">{t('jobs.log')}</th>
                </tr>
              </thead>
              <tbody>
                {scheduled.length === 0 ? (
                  <tr>
                    <td colSpan={8}>{t('jobs.no_crontab')}</td>
                  </tr>
                ) : null}
                {scheduled.map((row) => (
                  <tr key={row.name}>
                    <td>
                      <bdi dir="ltr">{row.name}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.schedule}</bdi>
                    </td>
                    <td className={s.sapNum}>{t('jobs.seconds', { count: row.timeoutSeconds })}</td>
                    <td>{when(row.lastRunAt)}</td>
                    <td className={s.sapNum}>{row.lastExit === null ? '—' : row.lastExit}</td>
                    <td className={s.sapNum}>{row.lastSeconds === null ? '—' : t('jobs.seconds', { count: row.lastSeconds })}</td>
                    <td>
                      <Pill
                        label={row.state === 'ok' ? t('jobs.state_ok') : row.state === 'failed' ? t('jobs.state_failed') : t('jobs.state_never')}
                        on={row.state === 'ok' ? true : row.state === 'failed' ? false : null}
                      />
                    </td>
                    <td>
                      <bdi dir="ltr">{row.logPath}</bdi>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section aria-labelledby="jobs-outbox-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="jobs-outbox-title">
            <span>{t('jobs.outbox')}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{t('jobs.queue')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('jobs.pending')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('jobs.dispatched')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('jobs.abandoned')}
                  </th>
                  <th scope="col">{t('jobs.oldest_pending')}</th>
                </tr>
              </thead>
              <tbody>
                {hand.queues.map((row) => (
                  <tr key={row.queue}>
                    <td>
                      <bdi dir="ltr">{row.queue}</bdi>
                    </td>
                    <td className={s.sapNum}>{row.pending}</td>
                    <td className={s.sapNum}>{row.dispatched}</td>
                    <td className={s.sapNum}>{row.abandoned}</td>
                    <td>{when(row.oldestPendingAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section aria-labelledby="jobs-deliveries-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="jobs-deliveries-title">
            <span>{t('jobs.deliveries')}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{column('channel')}</th>
                  <th scope="col">{column('status')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('jobs.count')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {hand.deliveries.length === 0 ? (
                  <tr>
                    <td colSpan={3}>—</td>
                  </tr>
                ) : null}
                {hand.deliveries.map((row) => (
                  <tr key={`${row.channel}-${row.status}`}>
                    <td>
                      <bdi dir="ltr">{row.channel}</bdi>
                    </td>
                    <td>
                      {t.has(`jobs.delivery_${row.status}`) ? t(`jobs.delivery_${row.status}`) : <bdi dir="ltr">{row.status}</bdi>}
                    </td>
                    <td className={s.sapNum}>{row.count}</td>
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
