import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Upload } from 'lucide-react';
import { AdminPage, Field, Flash, Select, Submit, admin as s } from '@/components/admin';
import { SectionTabs } from '@/components/admin/section-tabs';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { businessDateOf, businessToday } from '@/server/domain/business-date';
import { requireContext, withCurrentUser } from '@/server/session';
import * as legacy from '@/server/services/legacy-import';
import type { LegacyReport } from '@/server/services/legacy-import';
import { runLegacyImport } from './actions';

/**
 * The legacy books import — REQ-LEGACY-001.
 *
 * Copies the Sheet Migration screen: one upload form (dry run or apply),
 * then the latest run's report as the registers the accountant reads —
 * the workbooks recognised, what stops an apply, the partners, the
 * balances against the old trial balance, the warehouses and items, the
 * opening stock, what is at sea, the history kept, the old trial balance
 * for the journal entered by hand — and the runs so far.
 */
export const dynamic = 'force-dynamic';

export default async function LegacyImportPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/administration/legacy-import')) notFound();
  const [t, admin, page, locale, context, outcome] = await Promise.all([
    getTranslations('admin.legacy_import'),
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', legacy.PERMISSION_OBJECT)) {
    return <Denied object={page('legacy_import')} />;
  }
  const mayRun = can(principal, 'import', legacy.PERMISSION_OBJECT);

  const runs = await withCurrentUser((tx) => legacy.runs(tx));
  const latest = runs[0] ?? null;
  const report = (latest?.report ?? null) as LegacyReport | null;
  const iqd = (value: string | null) => (value === null ? '—' : formatMoney(value, 'IQD', locale as Locale));
  const usd = (value: string | null) => (value === null ? '—' : formatMoney(value, 'USD', locale as Locale));
  const amount = (value: string, currency: 'IQD' | 'USD') => (currency === 'USD' ? usd(value) : iqd(value));
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');
  const when = (value: Date | string) => formatBusinessDate(businessDateOf(new Date(value)), locale as Locale);
  const mode = (value: string) => (value === 'apply' ? t('mode_apply') : t('mode_dry_run'));
  const rate = (value: string | null) => (value === null ? '—' : new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(Number(value)));

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
  const table = (id: string, head: readonly { label: string; numeric?: boolean }[], rows: React.ReactNode) => (
    <div className={s.sapTableWrap}>
      <table aria-labelledby={id} className={s.sapTable}>
        <thead>
          <tr>
            {head.map((column) => (
              <th className={column.numeric ? s.sapNum : undefined} key={column.label} scope="col">
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  );

  return (
    <AdminPage
      back={{ href: '/', label: admin('dashboard_label') }}
      tabs={<SectionTabs route="/administration/legacy-import" />}
      subtitle={t('subtitle')}
      title={page('legacy_import')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />

      {mayRun
        ? section(
            'legacy-run-title',
            t('run_title'),
            null,
            <div className={s.sapBody}>
              <p className="muted">{t('run_note')}</p>
              <form action={runLegacyImport} className={s.uploadForm}>
                <label className={s.uploadPicker}>
                  <Upload aria-hidden="true" />
                  <span>{t('choose')}</span>
                  <input accept=".xlsx,.xls" aria-label={t('files')} multiple name="files" required type="file" />
                </label>
                <Field defaultValue={businessToday()} hint={t('cut_over_hint')} label={t('cut_over')} name="cut_over_date" required type="date" />
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
            'legacy-files-title',
            t('files_title'),
            t('latest_meta', { mode: mode(latest.mode), count: latest.fileNames.length, date: day(latest.cutOverDate), when: when(latest.runAt), by: latest.runBy ?? '—' }),
            <>
              {table(
                'legacy-files-title',
                [{ label: t('col_file') }, { label: t('col_sheet') }, { label: t('col_kind') }, { label: t('col_rows'), numeric: true }],
                report.files.flatMap((file) =>
                  file.sheets.length === 0
                    ? [
                        <tr key={file.fileName}>
                          <td>
                            <bdi dir="ltr">{file.fileName}</bdi>
                          </td>
                          <td>—</td>
                          <td>
                            <span className="status status--rejected" data-status="rejected">
                              —
                            </span>
                          </td>
                          <td className={s.sapNum}>—</td>
                        </tr>,
                      ]
                    : file.sheets.map((sheet) => (
                        <tr key={`${file.fileName}-${sheet.sheet}`}>
                          <td>
                            <bdi dir="ltr">{file.fileName}</bdi>
                          </td>
                          <td>
                            <bdi dir="auto">{sheet.sheet}</bdi>
                          </td>
                          <td>{t(`kind_${sheet.kind}`)}</td>
                          <td className={s.sapNum}>{sheet.rows}</td>
                        </tr>
                      )),
                ),
              )}
              {report.missing.length > 0 ? <p className={s.sapNote}>{t('missing', { kinds: report.missing.map((k) => t(`kind_${k}`)).join(', ') })}</p> : null}
            </>,
          )}

          {section(
            'legacy-stops-title',
            t('stops_title'),
            admin('rows_shown', { count: report.stops.length }),
            table(
              'legacy-stops-title',
              [{ label: t('col_message') }],
              report.stops.length === 0
                ? empty(1, t('stops_none'))
                : report.stops.map((stop, index) => (
                    <tr key={index}>
                      <td>
                        <span className="status status--rejected" data-status="rejected">
                          {stop}
                        </span>
                      </td>
                    </tr>
                  )),
            ),
          )}

          {report.problems.length > 0
            ? section(
                'legacy-problems-title',
                t('problems_title'),
                admin('rows_shown', { count: report.problems.length }),
                table(
                  'legacy-problems-title',
                  [{ label: t('col_file') }, { label: t('col_row'), numeric: true }, { label: t('col_message') }],
                  report.problems.map((problem, index) => (
                    <tr key={index}>
                      <td>
                        <bdi dir="ltr">
                          {problem.fileName} · {problem.sheet}
                        </bdi>
                      </td>
                      <td className={s.sapNum}>{problem.row}</td>
                      <td>{problem.message}</td>
                    </tr>
                  )),
                ),
              )
            : null}

          {section(
            'legacy-partners-title',
            t('partners_title'),
            t('partners_create', { count: report.partners.create.length, matched: report.partners.matched.length, conflicts: report.partners.conflicts.length }),
            <>
              {report.partners.conflicts.length > 0
                ? table(
                    'legacy-partners-title',
                    [{ label: t('col_code') }, { label: t('col_name') }, { label: t('col_erp_name') }],
                    report.partners.conflicts.map((row) => (
                      <tr key={row.code}>
                        <td>
                          <bdi dir="ltr">{row.code}</bdi>
                        </td>
                        <td>
                          <bdi dir="auto">{row.legacyName}</bdi>
                        </td>
                        <td>
                          <span className="status status--rejected" data-status="rejected">
                            <bdi dir="auto">{row.erpName}</bdi>
                          </span>
                        </td>
                      </tr>
                    )),
                  )
                : null}
              {table(
                'legacy-partners-title',
                [{ label: t('col_code') }, { label: t('col_name') }, { label: t('col_kind2') }, { label: t('col_phone') }],
                report.partners.create.length === 0
                  ? empty(4, t('matched', { count: report.partners.matched.length }))
                  : report.partners.create.map((row) => (
                      <tr key={row.code}>
                        <td>
                          <bdi dir="ltr">{row.code}</bdi>
                        </td>
                        <td>
                          <bdi dir="auto">{row.name}</bdi>
                        </td>
                        <td>{row.kind === 'supplier' ? t('supplier') : t('customer')}</td>
                        <td>
                          <bdi dir="ltr">{row.phone ?? '—'}</bdi>
                        </td>
                      </tr>
                    )),
              )}
            </>,
          )}

          {section(
            'legacy-balances-title',
            t('balances_title'),
            admin('rows_shown', { count: report.balances.lines.length }),
            <>
              <p className={s.sapNote}>{t('balances_note', { implied: rate(report.rate.implied), erp: rate(report.rate.erp) })}</p>
              {table(
                'legacy-balances-title',
                [{ label: t('totals_title') }, { label: t('col_old_books'), numeric: true }, { label: t('col_old_tb'), numeric: true }],
                <>
                  <tr>
                    <td>{t('customers_iqd')}</td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{iqd(report.balances.totals.customerIqd)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{iqd(report.balances.tb.customersIqd)}</bdi>
                    </td>
                  </tr>
                  <tr>
                    <td>{t('customers_usd')}</td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{usd(report.balances.totals.customerUsd)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{usd(report.balances.tb.customersUsd)}</bdi>
                    </td>
                  </tr>
                  <tr>
                    <td>{t('suppliers_iqd')}</td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{iqd(report.balances.totals.supplierIqd)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{iqd(report.balances.tb.suppliersIqd)}</bdi>
                    </td>
                  </tr>
                  <tr>
                    <td>{t('suppliers_usd')}</td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{usd(report.balances.totals.supplierUsd)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{usd(report.balances.tb.suppliersUsd)}</bdi>
                    </td>
                  </tr>
                </>,
              )}
              <p className={s.sapNote}>
                <span className={`status status--${report.balances.agrees ? 'posted' : 'rejected'}`} data-status={report.balances.agrees ? 'posted' : 'rejected'}>
                  {report.balances.agrees ? t('agrees') : t('disagrees')}
                </span>
              </p>
              {table(
                'legacy-balances-title',
                [{ label: t('col_currency') }, { label: t('col_lines'), numeric: true }, { label: t('col_equity'), numeric: true }, { label: t('col_journal') }],
                report.balances.journals.length === 0
                  ? empty(4, '—')
                  : report.balances.journals.map((journal) => (
                      <tr key={journal.currency}>
                        <td>{journal.currency}</td>
                        <td className={s.sapNum}>{journal.lines}</td>
                        <td className={s.sapNum}>
                          <bdi dir="ltr">{amount(journal.equity, journal.currency)}</bdi>
                        </td>
                        <td>{journal.entryNo ? <bdi dir="ltr">{journal.entryNo}</bdi> : t('after_apply')}</td>
                      </tr>
                    )),
              )}
              {table(
                'legacy-balances-title',
                [{ label: t('col_code') }, { label: t('col_name') }, { label: t('col_kind2') }, { label: t('col_currency') }, { label: t('col_amount'), numeric: true }],
                report.balances.lines.length === 0
                  ? empty(5, '—')
                  : report.balances.lines.map((line) => (
                      <tr key={`${line.code}-${line.currency}`}>
                        <td>
                          <bdi dir="ltr">{line.code}</bdi>
                        </td>
                        <td>
                          <bdi dir="auto">{line.name}</bdi>
                        </td>
                        <td>{line.kind === 'supplier' ? t('supplier') : t('customer')}</td>
                        <td>{line.currency}</td>
                        <td className={s.sapNum}>
                          <bdi dir="ltr">{amount(line.amount, line.currency)}</bdi>
                        </td>
                      </tr>
                    )),
              )}
            </>,
          )}

          {section(
            'legacy-warehouses-title',
            t('warehouses_title'),
            `${t('to_create', { count: report.warehouses.create.length })} · ${t('matched', { count: report.warehouses.matched.length })}`,
            table(
              'legacy-warehouses-title',
              [{ label: t('col_warehouse') }, { label: t('col_code') }],
              [
                ...report.warehouses.create.map((name) => (
                  <tr key={name}>
                    <td>
                      <bdi dir="auto">{name}</bdi>
                    </td>
                    <td>{t('after_apply')}</td>
                  </tr>
                )),
                ...report.warehouses.matched.map((row) => (
                  <tr key={row.name}>
                    <td>
                      <bdi dir="auto">{row.name}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.code}</bdi>
                    </td>
                  </tr>
                )),
              ],
            ),
          )}

          {section(
            'legacy-items-title',
            t('items_title'),
            `${t('to_create', { count: report.items.create.length })} · ${t('matched', { count: report.items.matched.length })}`,
            table(
              'legacy-items-title',
              [{ label: t('col_item') }, { label: t('col_uom') }, { label: t('col_code') }],
              [
                ...report.items.create.map((row) => (
                  <tr key={row.name}>
                    <td>
                      <bdi dir="auto">{row.name}</bdi>
                    </td>
                    <td>{row.uom}</td>
                    <td>{t('after_apply')}</td>
                  </tr>
                )),
                ...report.items.matched.map((row) => (
                  <tr key={row.name}>
                    <td>
                      <bdi dir="auto">{row.name}</bdi>
                    </td>
                    <td>—</td>
                    <td>
                      <bdi dir="ltr">{row.code}</bdi>
                    </td>
                  </tr>
                )),
              ],
            ),
          )}

          {section(
            'legacy-stock-title',
            t('stock_title'),
            admin('rows_shown', { count: report.stock.documents.length }),
            <>
              <p className={s.sapNote}>{t('stock_note', { tb: iqd(report.stock.tbValueIqd), proposed: iqd(report.stock.proposedValueIqd) })}</p>
              {table(
                'legacy-stock-title',
                [{ label: t('col_warehouse') }, { label: t('col_lines'), numeric: true }, { label: t('col_units'), numeric: true }, { label: t('col_cost'), numeric: true }, { label: t('col_document') }],
                report.stock.documents.length === 0
                  ? empty(5, '—')
                  : report.stock.documents.map((doc) => (
                      <tr key={doc.warehouse}>
                        <td>
                          <bdi dir="auto">{doc.warehouse}</bdi>
                        </td>
                        <td className={s.sapNum}>{doc.lines}</td>
                        <td className={s.sapNum}>
                          <bdi dir="ltr">{doc.units}</bdi>
                        </td>
                        <td className={s.sapNum}>
                          <bdi dir="ltr">{iqd(doc.costIqd)}</bdi>
                        </td>
                        <td>{doc.documentNo ? <bdi dir="ltr">{doc.documentNo}</bdi> : t('after_apply')}</td>
                      </tr>
                    )),
              )}
            </>,
          )}

          {report.stock.noCost.length > 0
            ? section(
                'legacy-nocost-title',
                t('no_cost_title'),
                admin('rows_shown', { count: report.stock.noCost.length }),
                table(
                  'legacy-nocost-title',
                  [{ label: t('col_item') }, { label: t('col_warehouse') }, { label: t('col_quantity'), numeric: true }],
                  report.stock.noCost.map((row, index) => (
                    <tr key={index}>
                      <td>
                        <bdi dir="auto">{row.item}</bdi>
                      </td>
                      <td>
                        <bdi dir="auto">{row.warehouse}</bdi>
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{row.quantity}</bdi>
                      </td>
                    </tr>
                  )),
                ),
              )
            : null}

          {section(
            'legacy-transit-title',
            t('in_transit_title'),
            admin('rows_shown', { count: report.stock.inTransit.length }),
            <>
              <p className={s.sapNote}>{t('in_transit_note')}</p>
              {table(
                'legacy-transit-title',
                [{ label: t('col_item') }, { label: t('col_warehouse') }, { label: t('col_quantity'), numeric: true }],
                report.stock.inTransit.length === 0
                  ? empty(3, '—')
                  : report.stock.inTransit.map((row, index) => (
                      <tr key={index}>
                        <td>
                          <bdi dir="auto">{row.item}</bdi>
                        </td>
                        <td>
                          <bdi dir="auto">{row.warehouse}</bdi>
                        </td>
                        <td className={s.sapNum}>
                          <bdi dir="ltr">{row.quantity}</bdi>
                        </td>
                      </tr>
                    )),
              )}
            </>,
          )}

          {section(
            'legacy-archive-title',
            t('archive_title'),
            null,
            <>
              <p className={s.sapNote}>{t('archive_note')}</p>
              {table(
                'legacy-archive-title',
                [{ label: t('col_kind') }, { label: t('col_rows'), numeric: true }],
                <>
                  {(['sales', 'purchases', 'receipts', 'payments'] as const).map((key) => (
                    <tr key={key}>
                      <td>{t(`archive_${key}`)}</td>
                      <td className={s.sapNum}>{report.archive[key]}</td>
                    </tr>
                  ))}
                  <tr>
                    <td>{t('archive_written')}</td>
                    <td className={s.sapNum}>{report.archive.written ?? t('after_apply')}</td>
                  </tr>
                </>,
              )}
              {report.archive.unmatchedNames.length > 0 ? <p className={s.sapNote}>{t('unmatched_names', { names: report.archive.unmatchedNames.join('، ') })}</p> : null}
              {report.archive.unmatchedCodes.length > 0 ? <p className={s.sapNote}>{t('unmatched_codes', { codes: report.archive.unmatchedCodes.join(', ') })}</p> : null}
            </>,
          )}

          {section(
            'legacy-tb-title',
            t('tb_title'),
            null,
            <>
              <p className={s.sapNote}>{t('tb_note')}</p>
              {table(
                'legacy-tb-title',
                [{ label: t('col_caption') }, { label: t('col_iqd'), numeric: true }, { label: t('col_usd'), numeric: true }, { label: t('col_final'), numeric: true }],
                report.tb.length === 0
                  ? empty(4, '—')
                  : report.tb.map((line, index) => (
                      <tr key={index}>
                        <td>
                          <bdi dir="auto">{line.caption}</bdi>
                        </td>
                        <td className={s.sapNum}>
                          <bdi dir="ltr">{iqd(line.iqd)}</bdi>
                        </td>
                        <td className={s.sapNum}>
                          <bdi dir="ltr">{usd(line.usd)}</bdi>
                        </td>
                        <td className={s.sapNum}>
                          <bdi dir="ltr">{iqd(line.final)}</bdi>
                        </td>
                      </tr>
                    )),
              )}
            </>,
          )}
        </>
      ) : (
        section('legacy-none-title', t('latest'), null, <p className={s.sapNote}>{t('none')}</p>)
      )}

      {section(
        'legacy-runs-title',
        t('runs_title'),
        admin('rows_shown', { count: runs.length }),
        <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
          <table aria-labelledby="legacy-runs-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
            <thead>
              <tr>
                <th scope="col">{t('col_run')}</th>
                <th scope="col">{t('col_files')}</th>
                <th scope="col">{t('col_cut_over')}</th>
                <th scope="col">{t('col_when')}</th>
                <th scope="col">{t('col_by')}</th>
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
                    <bdi dir="ltr">{run.fileNames.join(', ')}</bdi>
                  </td>
                  <td>
                    <bdi dir="ltr">{day(run.cutOverDate)}</bdi>
                  </td>
                  <td>
                    <bdi dir="ltr">{when(run.runAt)}</bdi>
                  </td>
                  <td>
                    <bdi dir="auto">{run.runBy ?? '—'}</bdi>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      )}
    </AdminPage>
  );
}
