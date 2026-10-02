import { Upload } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, Flash, Submit, SubmitRow, admin as s } from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as asycuda from '@/server/services/asycuda-runs';
import * as customs from '@/server/services/customs-pd';
import { applyAsycudaRun, readAsycudaList } from '../actions';

/**
 * Update PDs from the ASYCUDA list — REQ-AP-001 §21.8 (REQ-APP-001 S4).
 *
 * The officer exports the document list from ASYCUDA; this reads the file
 * they already have, shows line by line what each declaration is now and what
 * ASYCUDA says, and only then applies — one history row each, source "ASYCUDA
 * list". This is the sheet's "Check / MATCH / STATUS CHECK" columns made a
 * step with a record.
 *
 * Each reading is kept (`asycuda_run`, 0257). Asking a file to be pasted was
 * where the mistakes came from — a row missed at the bottom of a scroll is a
 * declaration nobody updated, which is a payment that will not go out — and
 * keeping the reading means "what did customs say on the second, and who
 * applied it" is answerable afterwards, which for the document that releases
 * money it has to be.
 */
export const dynamic = 'force-dynamic';

const OUTCOME_CHIP: Readonly<Record<string, string>> = {
  change: 'approved',
  same: 'draft',
  not_found: 'rejected',
  ambiguous: 'rejected',
  final: 'cancelled',
};

interface ReportRow {
  readonly line: number;
  readonly pdNo: string;
  readonly payableNo: string | null;
  readonly currentStatus: string | null;
  readonly newStatus: string;
  readonly effectiveDate: string | null;
  readonly outcome: keyof typeof OUTCOME_CHIP;
}

interface ReportUnreadable {
  readonly line: number;
  readonly text: string;
  readonly why: string;
}

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
  const runId = typeof params.run === 'string' ? params.run : '';

  const { current, statuses, history, standing, warningDays } = await withCurrentUser(async (tx) => ({
    current: runId ? await asycuda.run(tx, runId) : null,
    statuses: await customs.statuses(tx),
    history: await asycuda.runs(tx),
    // What the declarations say right now — the thing a customs officer opens
    // this screen to see, whether or not they are about to read a report.
    // Soonest expiry first, because that is the order the work happens in.
    standing: await customs.listForScreen(tx, { pageSize: 50 }),
    warningDays: await customs.warningDays(tx),
  }));

  const report = (current?.report ?? null) as { rows?: ReportRow[]; unreadable?: ReportUnreadable[] } | null;
  const rows = report?.rows ?? [];
  const unreadable = report?.unreadable ?? [];
  const ps = (code: string, name: string) => (locale !== 'en' && t.has(`ps.${code}`) ? t(`ps.${code}`) : name);
  const statusName = (code: string | null) =>
    code ? ps(code, statuses.find((row) => row.code === code)?.name ?? code) : '—';
  const day = (value: Date | string | null) =>
    value ? formatBusinessDate(typeof value === 'string' ? value : value.toISOString().slice(0, 10), locale as Locale) : '—';

  return (
    <AdminPage
      back={{ href: '/payables/pd', label: page('pds') }}
      tabs={<SectionTabs route="/payables/pd/asycuda" />}
      subtitle={t('asycuda_subtitle')}
      title={t('asycuda')}
      trail={[{ href: '/', label: admin('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />

      <section aria-labelledby="asycuda-read-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="asycuda-read-title">
            <span>{t('asycuda_paste')}</span>
          </h2>
          <div className={s.sapBody}>
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
          </div>
        </div>
      </section>

      {current ? (
        <section aria-labelledby="asycuda-diff-title" className={`${s.sapDoc} ${s.sapRegister}`}>
          <div className={s.sapWindow}>
            <h2 className={s.sapTitle} id="asycuda-diff-title">
              <span>{t('asycuda_diff')}</span>
              <span className={s.sapTitleMeta}>
                {t('asycuda_changes', { count: current.changeCount })}
                {current.fileNames.length > 0 ? ` · ${current.fileNames.join(', ')}` : ''}
                {` · ${day(current.readAt)}`}
              </span>
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
                  {rows.length === 0 && unreadable.length === 0 ? (
                    <tr>
                      <td className={s.sapEmptyRow} colSpan={7}>
                        {t('asycuda_nothing')}
                      </td>
                    </tr>
                  ) : null}
                  {rows.map((row) => (
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
                  {unreadable.map((row) => (
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
            {current.status === 'previewed' && current.changeCount > 0 ? (
              <div className={s.sapBody}>
                <form action={applyAsycudaRun}>
                  <input name="run" type="hidden" value={current.id} />
                  <SubmitRow>
                    <Submit label={t('asycuda_apply', { count: current.changeCount })} />
                  </SubmitRow>
                </form>
              </div>
            ) : null}
            {current.status === 'applied' ? (
              <div className={s.sapBody}>
                <p className="muted">{t('asycuda_already_applied', { at: day(current.appliedAt) })}</p>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {/*
        Where the declarations stand.

        The screen used to be a box to paste into and nothing else, so it said
        nothing at all until somebody uploaded a file. What a customs officer
        opens it to know is which declarations are live, which expire first,
        and which of them are holding up a payment — the ASYCUDA list is read
        *against* this. Soonest expiry first, because that is the order the
        work actually happens in.
      */}
      <section aria-labelledby="asycuda-standing-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="asycuda-standing-title">
            <span>{t('asycuda_standing')}</span>
            <span className={s.sapTitleMeta}>
              {t('asycuda_standing_meta', {
                total: standing.total,
                expiring: standing.rows.filter((row) => row.daysLeft !== null && row.daysLeft <= warningDays && !row.isTerminal).length,
                days: warningDays,
              })}
            </span>
          </h2>
          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="asycuda-standing-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{t('pd_no')}</th>
                  <th scope="col">{t('import')}</th>
                  <th scope="col">{t('supplier')}</th>
                  <th scope="col">{t('status')}</th>
                  <th scope="col">{t('registered')}</th>
                  <th scope="col">{t('expires')}</th>
                  <th scope="col">{t('days_left')}</th>
                  <th scope="col">{t('asycuda_pays')}</th>
                </tr>
              </thead>
              <tbody>
                {standing.rows.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={8}>
                      {t('asycuda_no_pds')}
                    </td>
                  </tr>
                ) : null}
                {standing.rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link className={s.sapLink} href={`/payables/pd/${encodeURIComponent(row.pdNo)}?year=${row.registrationYear}`}>
                        <bdi dir="ltr">{row.pdNo}</bdi>
                      </Link>
                    </td>
                    <td>
                      {row.payableNo ? (
                        <Link className={s.sapLink} href={`/payables/${encodeURIComponent(row.payableNo)}`}>
                          <bdi dir="ltr">{row.payableNo}</bdi>
                        </Link>
                      ) : (
                        <span className="muted">{t('asycuda_not_linked')}</span>
                      )}
                    </td>
                    <td>
                      <bdi dir="auto">{row.supplierName ?? '—'}</bdi>
                    </td>
                    <td>{ps(row.statusCode, row.statusName)}</td>
                    <td>
                      <bdi dir="ltr">{row.registrationDate}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.expiryDate}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      {row.daysLeft === null ? (
                        '—'
                      ) : (
                        <span
                          className={`status status--${row.daysLeft < 0 ? 'rejected' : row.daysLeft <= warningDays ? 'pending' : 'approved'} ${s.sapRegisterStatus}`}
                          data-status={row.daysLeft < 0 ? 'rejected' : row.daysLeft <= warningDays ? 'pending' : 'approved'}
                        >
                          {row.daysLeft < 0 ? t('asycuda_expired_days', { days: -row.daysLeft }) : t('asycuda_days', { days: row.daysLeft })}
                        </span>
                      )}
                    </td>
                    <td>{row.allowsPayment ? t('yes') : t('no')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section aria-labelledby="asycuda-runs-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="asycuda-runs-title">
            <span>{t('asycuda_runs')}</span>
          </h2>
          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="asycuda-runs-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{t('asycuda_read_at')}</th>
                  <th scope="col">{t('asycuda_from')}</th>
                  <th scope="col">{t('line')}</th>
                  <th scope="col">{t('asycuda_change_count')}</th>
                  <th scope="col">{t('status')}</th>
                </tr>
              </thead>
              <tbody>
                {history.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={5}>
                      {t('asycuda_no_runs')}
                    </td>
                  </tr>
                ) : null}
                {history.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link className={s.sapLink} href={`/payables/pd/asycuda?run=${encodeURIComponent(row.id)}`}>
                        <bdi dir="ltr">{day(row.readAt)}</bdi>
                      </Link>
                    </td>
                    <td>{row.fileNames.length > 0 ? row.fileNames.join(', ') : t('asycuda_pasted')}</td>
                    <td className={s.sapNum}>{row.lineCount}</td>
                    <td className={s.sapNum}>{row.changeCount}</td>
                    <td>
                      <span
                        className={`status status--${row.status === 'applied' ? 'approved' : 'draft'} ${s.sapRegisterStatus}`}
                        data-status={row.status === 'applied' ? 'approved' : 'draft'}
                      >
                        {t(`asycuda_status_${row.status}`)}
                      </span>
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
