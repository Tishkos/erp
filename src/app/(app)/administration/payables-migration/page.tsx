import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Upload } from 'lucide-react';
import { AdminPage, Field, Flash, Form, Hidden, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { SectionTabs } from '@/components/admin/section-tabs';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as migration from '@/server/services/payables-migration';
import type { MigrationReport } from '@/server/services/payables-migration';
import { runMigration, signOffMigration } from './actions';

/**
 * The sheet import — REQ-AP-001 §24.3, §24.4.
 *
 * One upload form (dry run or apply), then the latest run's report as the
 * registers the accountant reads: the totals against the sheet, the suppliers
 * it could not match, the banks, what was not imported and why, the PD holding
 * list, the SWIFT dates to verify, the cleared comparison with its sign-off,
 * the containers, the warehouses, every value changed on the way in — and the
 * runs so far. Each register is drawn as the other Payables registers are.
 */
export const dynamic = 'force-dynamic';

const COUNT_KEYS = ['imports', 'payments', 'pds', 'bls', 'containers', 'details', 'orderLines', 'notes'] as const;

export default async function PayablesMigrationPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/administration/payables-migration')) notFound();
  const [t, admin, page, locale, context, outcome] = await Promise.all([
    getTranslations('admin.payables_migration'),
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', migration.PERMISSION_OBJECT)) {
    return <Denied object={page('payables_migration')} />;
  }
  const mayRun = can(principal, 'import', migration.PERMISSION_OBJECT);
  const maySignOff = can(principal, 'approve', migration.PERMISSION_OBJECT);

  const runs = await withCurrentUser((tx) => migration.runs(tx));
  const latest = runs[0] ?? null;
  const report = (latest?.report ?? null) as MigrationReport | null;
  const usd = (value: string) => formatMoney(value, 'USD', locale as Locale);
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');
  const when = (value: Date | string) => formatBusinessDate(new Date(value).toISOString().slice(0, 10), locale as Locale);
  const mode = (value: string) => (value === 'apply' ? t('mode_apply') : t('mode_dry_run'));
  const yes = (value: boolean) => (value ? t('yes') : t('no'));

  const section = (id: string, title: string, meta: string | null, body: React.ReactNode) => (
    <section aria-labelledby={id} className={s.sapDoc}>
      <div className={s.sapWindow}>
        <h2 className={s.sapTitle} id={id}>
          <span>{title}</span>
          {meta ? <span className={s.sapTitleMeta}>{meta}</span> : null}
        </h2>
        {body}
      </div>
    </section>
  );
  const empty = (columns: number, label: string) => (
    <tr>
      <td className={s.sapEmptyRow} colSpan={columns}>
        {label}
      </td>
    </tr>
  );

  return (
    <AdminPage
      back={{ href: '/', label: admin('dashboard_label') }}
      tabs={<SectionTabs route="/administration/payables-migration" />}
      subtitle={t('subtitle')}
      title={page('payables_migration')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />

      {mayRun
        ? section(
            'migration-run-title',
            t('run_title'),
            null,
            <div className={s.sapBody}>
              <p className="muted">{t('run_note')}</p>
              <form action={runMigration} className={s.uploadForm}>
                <label className={s.uploadPicker}>
                  <Upload aria-hidden="true" />
                  <span>{t('choose')}</span>
                  <input accept=".xlsx" aria-label={t('file')} name="file" required type="file" />
                </label>
                <Select
                  defaultValue="dry_run"
                  label={t('mode')}
                  name="mode"
                  options={[
                    { value: 'dry_run', label: t('mode_dry_run') },
                    { value: 'apply', label: t('mode_apply') },
                  ]}
                />
                <Submit label={t('run')} />
              </form>
            </div>,
          )
        : null}

      {report && latest ? (
        <>
          {section(
            'migration-latest-title',
            t('latest'),
            t('latest_meta', { mode: mode(latest.mode), file: latest.fileName, date: when(latest.runAt), by: latest.runBy ?? '—' }),
            <>
              <div className={s.sapTableWrap}>
                <table aria-labelledby="migration-latest-title" className={s.sapTable}>
                  <thead>
                    <tr>
                      <th scope="col">{t('col_what')}</th>
                      <th className={s.sapNum} scope="col">
                        {t('col_count')}
                      </th>
                      <th className={s.sapNum} scope="col">
                        {t('col_existing')}
                      </th>
                      <th className={s.sapNum} scope="col">
                        {t('col_created')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {COUNT_KEYS.map((key) => {
                      const existing = { imports: 'payables', payments: 'applications', pds: 'pds', bls: 'bls' }[key as string];
                      const created = {
                        imports: 'payables',
                        payments: 'applications',
                        pds: 'pds',
                        bls: 'bls',
                        containers: 'containers',
                        orderLines: 'orderLines',
                        notes: 'notes',
                      }[key as string];
                      return (
                        <tr key={key}>
                          <td>{t(`count_${key}`)}</td>
                          <td className={s.sapNum}>{report.counts[key] ?? 0}</td>
                          <td className={s.sapNum}>{existing ? (report.existing[existing] ?? 0) : '—'}</td>
                          <td className={s.sapNum}>{report.created && created ? (report.created[created] ?? 0) : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className={s.sapTableWrap}>
                <table aria-label={t('totals_title')} className={s.sapTable}>
                  <thead>
                    <tr>
                      <th scope="col">{t('totals_title')}</th>
                      <th className={s.sapNum} scope="col">
                        {t('col_sheet')}
                      </th>
                      <th className={s.sapNum} scope="col">
                        {t('col_erp')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {(['invoiced', 'paid', 'applied'] as const).map((key) => (
                      <tr key={key}>
                        <td>{t(`total_${key}`)}</td>
                        <td className={s.sapNum}>
                          <bdi dir="ltr">{usd(report.totals.sheet[key])}</bdi>
                        </td>
                        <td className={s.sapNum}>
                          {report.totals.erp ? <bdi dir="ltr">{usd(report.totals.erp[key])}</bdi> : t('erp_after_apply')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {report.shipments ? <p className={s.sapNote}>{t('shipments', report.shipments)}</p> : null}
            </>,
          )}

          {section(
            'migration-suppliers-title',
            t('suppliers_title'),
            admin('rows_shown', { count: report.suppliers.unmatched.length }),
            <div className={s.sapTableWrap}>
              <table aria-labelledby="migration-suppliers-title" className={s.sapTable}>
                <thead>
                  <tr>
                    <th scope="col">{t('col_supplier')}</th>
                    <th scope="col">{t('col_references')}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.suppliers.unmatched.length === 0 ? empty(2, t('all_matched')) : null}
                  {report.suppliers.unmatched.map((row) => (
                    <tr key={row.name}>
                      <td>
                        <bdi dir="auto">{row.name}</bdi>
                      </td>
                      <td>
                        <bdi dir="ltr">{row.references.join(', ')}</bdi>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>,
          )}

          {section(
            'migration-banks-title',
            t('banks_title'),
            null,
            <div className={s.sapTableWrap}>
              <table aria-labelledby="migration-banks-title" className={s.sapTable}>
                <thead>
                  <tr>
                    <th scope="col">{t('col_bank_sheet')}</th>
                    <th scope="col">{t('col_bank')}</th>
                    <th scope="col">{t('col_account')}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.banks.map((row) => (
                    <tr key={row.sheet}>
                      <td>
                        <bdi dir="ltr">{row.sheet}</bdi>
                      </td>
                      <td>
                        <bdi dir="auto">{row.bankName ?? '—'}</bdi>
                      </td>
                      <td>
                        {row.accountCode ? (
                          <bdi dir="ltr">{row.accountCode}</bdi>
                        ) : (
                          <span className="status status--rejected" data-status="rejected">
                            {t('no_account')}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>,
          )}

          {section(
            'migration-skipped-title',
            t('skipped_title'),
            admin('rows_shown', { count: report.skippedPayments.length }),
            <div className={s.sapTableWrap}>
              <table aria-labelledby="migration-skipped-title" className={s.sapTable}>
                <thead>
                  <tr>
                    <th className={s.sapNum} scope="col">
                      {t('col_row')}
                    </th>
                    <th scope="col">{t('col_reference')}</th>
                    <th className={s.sapNum} scope="col">
                      {t('col_amount')}
                    </th>
                    <th scope="col">{t('col_reason')}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.skippedPayments.length === 0 ? empty(4, '—') : null}
                  {report.skippedPayments.map((row) => (
                    <tr key={row.row}>
                      <td className={s.sapNum}>{row.row}</td>
                      <td>
                        <bdi dir="ltr">{row.reference}</bdi>
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{usd(row.amount)}</bdi>
                      </td>
                      <td>
                        {row.code ? t(`skip_${row.code}`, { name: row.name ?? '' }) : <bdi dir="auto">{row.reason}</bdi>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>,
          )}

          {section(
            'migration-holding-title',
            t('holding_title'),
            admin('rows_shown', { count: report.pdHolding.length }),
            <div className={s.sapTableWrap}>
              <table aria-labelledby="migration-holding-title" className={s.sapTable}>
                <thead>
                  <tr>
                    <th className={s.sapNum} scope="col">
                      {t('col_row')}
                    </th>
                    <th scope="col">{t('col_pd')}</th>
                    <th scope="col">{t('col_reference')}</th>
                    <th scope="col">{t('col_status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.pdHolding.length === 0 ? empty(4, '—') : null}
                  {report.pdHolding.map((row) => (
                    <tr key={`${row.row}-${row.pdNo}`}>
                      <td className={s.sapNum}>{row.row}</td>
                      <td>
                        <bdi dir="ltr">{row.pdNo}</bdi>
                      </td>
                      <td>
                        <bdi dir="ltr">{row.reference || '—'}</bdi>
                      </td>
                      <td>
                        <bdi dir="auto">{row.status}</bdi>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>,
          )}

          {section(
            'migration-verify-title',
            t('verify_title'),
            admin('rows_shown', { count: report.verifySwift.length }),
            <div className={s.sapTableWrap}>
              <table aria-labelledby="migration-verify-title" className={s.sapTable}>
                <thead>
                  <tr>
                    <th className={s.sapNum} scope="col">
                      {t('col_row')}
                    </th>
                    <th scope="col">{t('col_reference')}</th>
                    <th className={s.sapNum} scope="col">
                      {t('col_amount')}
                    </th>
                    <th scope="col">{t('col_applied_on')}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.verifySwift.length === 0 ? empty(4, '—') : null}
                  {report.verifySwift.map((row) => (
                    <tr key={row.row}>
                      <td className={s.sapNum}>{row.row}</td>
                      <td>
                        <bdi dir="ltr">{row.reference}</bdi>
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{usd(row.amount)}</bdi>
                      </td>
                      <td>
                        <bdi dir="ltr">{day(row.applicationDate)}</bdi>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>,
          )}

          {section(
            'migration-cleared-title',
            t('cleared_title'),
            latest.signedOffAt ? t('signed_off', { date: when(latest.signedOffAt), note: latest.signOffNote ?? '—' }) : null,
            <>
              <p className={s.sapNote}>
                {t('cleared_counts', {
                  rule: report.cleared.ruleCleared,
                  legacy: report.cleared.legacyCleared,
                  marked: report.cleared.markedNotPdWrittenOff.length,
                  written: report.cleared.pdWrittenOffNotMarked.length,
                })}
              </p>
              <div className={s.sapTableWrap}>
                <table aria-labelledby="migration-cleared-title" className={s.sapTable}>
                  <thead>
                    <tr>
                      <th scope="col">{t('col_reference')}</th>
                      <th scope="col">{t('col_legacy')}</th>
                      <th scope="col">{t('col_rule')}</th>
                      <th scope="col">{t('col_paid')}</th>
                      <th scope="col">{t('col_received')}</th>
                      <th scope="col">{t('col_written_off')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.cleared.differences.length === 0 ? empty(6, t('no_differences')) : null}
                    {report.cleared.differences.map((row) => (
                      <tr key={row.reference}>
                        <td>
                          <bdi dir="ltr">{row.reference}</bdi>
                        </td>
                        <td>{yes(row.legacy)}</td>
                        <td>
                          <span
                            className={`status status--${row.rule ? 'settled' : 'draft'}`}
                            data-status={row.rule ? 'settled' : 'draft'}
                          >
                            {yes(row.rule)}
                          </span>
                        </td>
                        <td>{yes(row.fullyPaid)}</td>
                        <td>{yes(row.allReceived)}</td>
                        <td>{yes(row.pdsWrittenOff)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {latest.mode === 'apply' && !latest.signedOffAt && maySignOff && latest.runById !== principal.userId ? (
                <div className={s.sapBody}>
                  <p className="muted">{t('sign_off_hint')}</p>
                  <Form action={signOffMigration}>
                    <Hidden name="run_id" value={latest.id} />
                    <Field id="migration-sign-off-note" label={t('sign_off_note')} name="note" wide />
                    <SubmitRow>
                      <Submit label={t('sign_off')} />
                    </SubmitRow>
                  </Form>
                </div>
              ) : null}
            </>,
          )}

          {section(
            'migration-containers-title',
            t('containers_title'),
            t('estimated_bls', { count: report.containers.estimatedBls }),
            <div className={s.sapTableWrap}>
              <table aria-labelledby="migration-containers-title" className={s.sapTable}>
                <thead>
                  <tr>
                    <th scope="col">{t('col_bl')}</th>
                    <th scope="col">{t('col_numbers')}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.containers.invalid.length + report.containers.withoutContainers.length === 0 ? empty(2, '—') : null}
                  {report.containers.invalid.map((row) => (
                    <tr key={row.blNo}>
                      <td>
                        <bdi dir="ltr">{row.blNo}</bdi>
                      </td>
                      <td>
                        <bdi dir="ltr">{row.numbers.join(', ')}</bdi>
                        <div className="muted">{t('invalid_containers')}</div>
                      </td>
                    </tr>
                  ))}
                  {report.containers.withoutContainers.map((blNo) => (
                    <tr key={`none-${blNo}`}>
                      <td>
                        <bdi dir="ltr">{blNo}</bdi>
                      </td>
                      <td className="muted">{t('without_containers')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>,
          )}

          {section(
            'migration-warehouses-title',
            t('warehouses_title'),
            null,
            <div className={s.sapTableWrap}>
              <table aria-labelledby="migration-warehouses-title" className={s.sapTable}>
                <thead>
                  <tr>
                    <th scope="col">{t('col_warehouse_sheet')}</th>
                    <th scope="col">{t('col_warehouse_erp')}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.warehouses.length === 0 ? empty(2, '—') : null}
                  {report.warehouses.map((row) => (
                    <tr key={row.sheet}>
                      <td>
                        <bdi dir="auto">{row.sheet}</bdi>
                      </td>
                      <td>
                        <bdi dir="ltr">{row.erp ?? '—'}</bdi>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>,
          )}

          {section(
            'migration-fixes-title',
            t('fixes_title'),
            admin('rows_shown', { count: report.fixes.length }),
            <div className={s.sapTableWrap}>
              <table aria-labelledby="migration-fixes-title" className={s.sapTable}>
                <thead>
                  <tr>
                    <th scope="col">{t('col_row')}</th>
                    <th scope="col">{t('col_field')}</th>
                    <th scope="col">{t('col_original')}</th>
                    <th scope="col">{t('col_used')}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.fixes.length === 0 ? empty(4, '—') : null}
                  {report.fixes.map((row) => (
                    <tr key={`${row.sheet}-${row.row}-${row.field}`}>
                      <td>
                        <bdi dir="ltr">
                          {row.sheet} {row.row}
                        </bdi>
                      </td>
                      <td>{row.field}</td>
                      <td>
                        <bdi dir="auto">{JSON.stringify(row.original)}</bdi>
                      </td>
                      <td>
                        <bdi dir="auto">{row.used}</bdi>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>,
          )}
        </>
      ) : (
        section('migration-none-title', t('latest'), null, <p className={s.sapNote}>{t('none')}</p>)
      )}

      {section(
        'migration-runs-title',
        t('runs_title'),
        admin('rows_shown', { count: runs.length }),
        <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
          <table aria-labelledby="migration-runs-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
            <thead>
              <tr>
                <th scope="col">{t('col_run')}</th>
                <th scope="col">{t('col_file')}</th>
                <th scope="col">{t('col_when')}</th>
                <th scope="col">{t('col_by')}</th>
                <th scope="col">{t('col_signed')}</th>
              </tr>
            </thead>
            <tbody>
              {runs.length === 0 ? empty(5, t('none')) : null}
              {runs.map((run) => (
                <tr key={run.id}>
                  <td>
                    <span
                      className={`status status--${run.mode === 'apply' ? 'posted' : 'draft'} ${s.sapRegisterStatus}`}
                      data-status={run.mode === 'apply' ? 'posted' : 'draft'}
                    >
                      {mode(run.mode)}
                    </span>
                  </td>
                  <td>
                    <bdi dir="ltr">{run.fileName}</bdi>
                  </td>
                  <td>
                    <bdi dir="ltr">{when(run.runAt)}</bdi>
                  </td>
                  <td>
                    <bdi dir="auto">{run.runBy ?? '—'}</bdi>
                  </td>
                  <td>{run.signedOffAt ? <bdi dir="ltr">{when(run.signedOffAt)}</bdi> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      )}
    </AdminPage>
  );
}
