import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, Flash, Submit, SubmitRow, admin as s } from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as customs from '@/server/services/customs-pd';
import { applyAsycudaList } from '../actions';

/**
 * Update PDs from the ASYCUDA list — REQ-AP-001 §21.8 (REQ-APP-001 S4).
 *
 * Paste the document list from ASYCUDA; the page shows, line by line, what
 * each PD is now and what ASYCUDA says, and only then applies the changes —
 * one history row each, source "ASYCUDA list". This is the sheet's
 * "Check / MATCH / STATUS CHECK" columns made a step with a record.
 */
export const dynamic = 'force-dynamic';

const OUTCOME_CHIP: Readonly<Record<string, string>> = {
  change: 'approved',
  same: 'draft',
  not_found: 'rejected',
  ambiguous: 'rejected',
  final: 'cancelled',
};

export default async function AsycudaPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/payables/pd')) notFound();
  const [t, admin, page, locale, context, outcome] = await Promise.all([
    getTranslations('admin.customs_pd'),
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  if (!can(context.principal, 'import', customs.PERMISSION_OBJECT)) {
    return <Denied object={t('asycuda')} />;
  }
  const params = await searchParams;
  const list = typeof params.list === 'string' ? params.list : '';

  const diff = list.trim() ? await withCurrentUser((tx) => customs.asycudaDiff(tx, list)) : null;
  const ps = (code: string, name: string) => (locale !== 'en' && t.has(`ps.${code}`) ? t(`ps.${code}`) : name);
  const statusName = (code: string | null) =>
    code ? ps(code, diff?.statuses.find((row) => row.code === code)?.name ?? code) : '—';
  const changes = diff?.rows.filter((row) => row.outcome === 'change').length ?? 0;

  return (
    <AdminPage
      back={{ href: '/payables/pd', label: page('pds') }}
      tabs={<SectionTabs route="/payables/pd" />}
      subtitle={t('asycuda_subtitle')}
      title={t('asycuda')}
      trail={[{ href: '/', label: admin('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />

      <section aria-labelledby="asycuda-paste-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="asycuda-paste-title">
            <span>{t('asycuda_paste')}</span>
          </h2>
          <div className={s.sapBody}>
            <form method="get">
              <Field
                defaultValue={list}
                hint={t('asycuda_hint')}
                label={t('asycuda_list')}
                name="list"
                required
                type="textarea"
                wide
              />
              <SubmitRow>
                <Submit label={t('asycuda_preview')} />
              </SubmitRow>
            </form>
          </div>
        </div>
      </section>

      {diff ? (
        <section aria-labelledby="asycuda-diff-title" className={`${s.sapDoc} ${s.sapRegister}`}>
          <div className={s.sapWindow}>
            <h2 className={s.sapTitle} id="asycuda-diff-title">
              <span>{t('asycuda_diff')}</span>
              <span className={s.sapTitleMeta}>{t('asycuda_changes', { count: changes })}</span>
            </h2>
            <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
              <table aria-labelledby="asycuda-diff-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
                <thead>
                  <tr>
                    <th scope="col">{t('line')}</th>
                    <th scope="col">{t('pd_no')}</th>
                    <th scope="col">{t('import')}</th>
                    <th scope="col">{t('now')}</th>
                    <th scope="col">{t('asycuda_says')}</th>
                    <th scope="col">{t('effective_date')}</th>
                    <th scope="col">{t('what_happens')}</th>
                  </tr>
                </thead>
                <tbody>
                  {diff.rows.length === 0 ? (
                    <tr>
                      <td className={s.sapEmptyRow} colSpan={7}>
                        {t('asycuda_nothing')}
                      </td>
                    </tr>
                  ) : null}
                  {diff.rows.map((row) => (
                    <tr key={`${row.line}-${row.pdNo}`}>
                      <td>{row.line}</td>
                      <td>
                        <bdi dir="ltr">{row.pdNo}</bdi>
                      </td>
                      <td>
                        {row.payableNo ? (
                          <Link className={s.sapLink} href={`/payables/${encodeURIComponent(row.payableNo)}`}>
                            <bdi dir="ltr">{row.payableNo}</bdi>
                          </Link>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>{statusName(row.currentStatus)}</td>
                      <td>{statusName(row.newStatus)}</td>
                      <td>
                        <bdi dir="ltr">{row.effectiveDate ?? t('today')}</bdi>
                      </td>
                      <td>
                        <span
                          className={`status status--${OUTCOME_CHIP[row.outcome]} ${s.sapRegisterStatus}`}
                          data-status={OUTCOME_CHIP[row.outcome]}
                        >
                          {t(`outcome_${row.outcome}`)}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {diff.unreadable.map((row) => (
                    <tr key={`u-${row.line}`}>
                      <td>{row.line}</td>
                      <td colSpan={5}>
                        <bdi dir="auto">{row.text}</bdi>
                      </td>
                      <td>
                        <span className="status status--rejected" data-status="rejected">
                          {t('unreadable')}
                        </span>{' '}
                        <span className="muted">{row.why}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {changes > 0 ? (
              <div className={s.sapBody}>
                <form action={applyAsycudaList}>
                  <textarea defaultValue={list} hidden name="list" readOnly />
                  <SubmitRow>
                    <Submit label={t('asycuda_apply', { count: changes })} />
                  </SubmitRow>
                </form>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}
    </AdminPage>
  );
}
