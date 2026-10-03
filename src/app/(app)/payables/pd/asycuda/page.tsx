import { Upload } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, FilterRow, Flash, ListToolbar, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { NewRecordDialog } from '@/components/admin/dialog';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { SectionTabs } from '@/components/admin/section-tabs';
import { Denied } from '@/components/denied';
import { Pagination } from '@/components/ui';
import { formatBusinessDate, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { businessDateOf } from '@/server/domain/business-date';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as asycuda from '@/server/services/asycuda-runs';
import * as customs from '@/server/services/customs-pd';
import { readAsycudaList } from '../actions';

/**
 * Update PDs from the ASYCUDA list — REQ-AP-001 §21.8, rebuilt with
 * IMPROVEMENT-002 (sponsor, 2026-10-03: "everything is everywhere … make it a
 * table like other pages, a new ASYCUDA document").
 *
 * The register of readings, as the Purchase Invoices list: every time the
 * officer reads the document list it becomes a numbered document
 * (ASY-YYYY-NNNNN) with the export it was read from filed on it. "Read the
 * ASYCUDA list" in the header takes the file (or the pasted list) and opens
 * the new reading, where the difference is looked at line by line and
 * applied. Nothing moves in the books until then.
 *
 * Where the declarations stand is the PD register's own view ("Expiring
 * within N days"); this screen no longer repeats it.
 */
export const dynamic = 'force-dynamic';

const STATUSES = ['previewed', 'applied'] as const;

export default async function AsycudaPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/payables/pd/asycuda')) notFound();
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
  const status = (STATUSES as readonly string[]).includes(String(params.status)) ? (params.status as (typeof STATUSES)[number]) : null;

  const result = await withCurrentUser((tx) => asycuda.listRuns(tx, { search: outcome.q, status, page: outcome.page }));
  const day = (value: Date | null) => (value ? formatBusinessDate(businessDateOf(value), locale as Locale) : '—');
  const query = (p: number) =>
    [outcome.q ? `q=${encodeURIComponent(outcome.q)}` : '', status ? `status=${status}` : '', `page=${p}`].filter(Boolean).join('&');

  return (
    <AdminPage
      actions={
        <NewRecordDialog buttonLabel={t('asycuda_read')} closeLabel={admin('close')} openOnLoad={Boolean(outcome.error)} title={t('asycuda_read')}>
          <p className="muted">{t('asycuda_read_note')}</p>
          {/* The picker is the one the Sheet Migration and Legacy Import
              screens use, down to its classes: a file is chosen the same
              way everywhere in this system. */}
          <form action={readAsycudaList} className={s.uploadForm}>
            <label className={s.uploadPicker}>
              <Upload aria-hidden="true" />
              <span>{t('asycuda_file')}</span>
              <input accept=".xlsx,.xls,.csv,.txt,.tsv" aria-label={t('asycuda_file')} multiple name="files" type="file" />
            </label>
            <p className="muted">{t('asycuda_file_hint')}</p>
            <Field hint={t('asycuda_hint')} label={t('asycuda_list')} name="list" type="textarea" wide />
            <SubmitRow>
              <Submit label={t('asycuda_preview')} />
            </SubmitRow>
          </form>
        </NewRecordDialog>
      }
      back={{ href: '/payables/pd', label: page('pds') }}
      tabs={<SectionTabs route="/payables/pd/asycuda" />}
      subtitle={t('asycuda_subtitle')}
      title={t('asycuda')}
      trail={[{ href: '/', label: admin('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />

      <section aria-labelledby="asycuda-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="asycuda-list-title">
            <span>{t('asycuda_runs')}</span>
            <span className={s.sapTitleMeta}>{admin('rows_shown', { count: result.total })}</span>
          </h2>

          <ListToolbar
            clearHref="/payables/pd/asycuda"
            clearLabel={admin('clear_search')}
            countLabel={admin('rows_shown', { count: result.total })}
            placeholder={admin('search_placeholder')}
            q={outcome.q}
            searchLabel={admin('search')}
          />

          <form className={s.filterBar} method="get">
            <FilterRow>
              <Select
                defaultValue={status ?? ''}
                emptyLabel={t('view_all')}
                label={t('status')}
                name="status"
                options={STATUSES.map((code) => ({ value: code, label: t(`asycuda_status_${code}`) }))}
              />
              <SubmitRow>
                <Submit label={t('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="asycuda-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{t('asycuda_no')}</th>
                  <th scope="col">{t('asycuda_read_at')}</th>
                  <th scope="col">{t('asycuda_read_by')}</th>
                  <th scope="col">{t('asycuda_from')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('asycuda_lines')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('asycuda_change_count')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('unreadable')}
                  </th>
                  <th scope="col">{t('status')}</th>
                  <th scope="col">{t('asycuda_applied_at')}</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={9}>
                      {outcome.q || status ? t('asycuda_none') : t('asycuda_no_runs')}
                    </td>
                  </tr>
                ) : null}
                {result.rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      {row.runNo ? (
                        <Link className={s.sapLink} href={`/payables/pd/asycuda/${encodeURIComponent(row.runNo)}`}>
                          <bdi dir="ltr">{row.runNo}</bdi>
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      <bdi dir="ltr">{day(row.readAt)}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.readBy ?? '—'}</bdi>
                    </td>
                    <td>
                      {row.fileNames.length > 0 ? <bdi dir="auto">{row.fileNames.join(', ')}</bdi> : t('asycuda_pasted')}
                      {row.files > 0 ? <div className="muted">{t('asycuda_files_kept', { count: row.files })}</div> : null}
                    </td>
                    <td className={s.sapNum}>{row.lineCount + row.unreadableCount}</td>
                    <td className={s.sapNum}>{row.changeCount}</td>
                    <td className={s.sapNum}>{row.unreadableCount}</td>
                    <td>
                      <span
                        className={`status status--${row.status === 'applied' ? 'approved' : 'draft'} ${s.sapRegisterStatus}`}
                        data-status={row.status === 'applied' ? 'approved' : 'draft'}
                      >
                        {t(`asycuda_status_${row.status}`)}
                      </span>
                    </td>
                    <td>
                      <bdi dir="ltr">{day(row.appliedAt)}</bdi>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {result.pages > 1 ? (
            <Pagination
              count={result.pages}
              current={result.page}
              hrefFor={(p) => `/payables/pd/asycuda?${query(p)}`}
              labels={{ label: admin('pagination'), previous: admin('previous'), next: admin('next'), page: (p) => admin('page_n', { page: p }) }}
              locale={locale}
            />
          ) : null}
        </div>
      </section>
    </AdminPage>
  );
}
