import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Pagination } from '@/components/ui';
import { AdminPage, Field, FilterRow, Flash, Form, Grid, Hidden, ListToolbar, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { NewRecordDialog } from '@/components/admin/dialog';
import { SearchablePicker } from '@/components/admin/searchable-picker';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { businessToday } from '@/server/domain/business-date';
import { requireContext, withCurrentUser } from '@/server/session';
import * as items from '@/server/services/items';
import * as pe from '@/server/services/project-execution';
import * as ps from '@/server/services/project-system';
import * as warehouses from '@/server/services/warehouses';
import { createMaterialIssue } from './actions';

/**
 * Material Issues — REQ-PM-001 §9. Copies the Stock Transfers list: the
 * register of issue and return documents, and the new-document dialog with
 * the one-time id of the transfer forms — one item per document, moved at
 * layer cost to one element when the document is posted.
 */
export const dynamic = 'force-dynamic';

export default async function MaterialIssuesPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/projects/material-issues')) notFound();
  const [t, x, page, column, status, locale, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.projects'),
    getTranslations('page'),
    getTranslations('column'),
    getTranslations('status'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', pe.PERMISSION_OBJECT)) {
    return <Denied object={page('material_issues')} />;
  }
  const params = await searchParams;
  const projectParam = typeof params.project === 'string' ? params.project : '';
  const statusParam = typeof params.status === 'string' ? params.status : '';
  const pageNo = Number(params.page) > 0 ? Number(params.page) : 1;
  const mayCreate = can(principal, 'create', pe.PERMISSION_OBJECT);

  const { result, choices, pickers, stockItems, houses } = await withCurrentUser(async (tx) => ({
    result: await pe.issues(tx, { projectCode: projectParam || null, status: statusParam || null, search: outcome.q, page: pageNo }),
    choices: (await ps.list(tx, { pageSize: 100 })).rows,
    pickers: mayCreate ? await pe.assignmentPickers(tx) : { elements: [], codes: [] },
    stockItems: mayCreate ? await items.invoiceChoices(tx, 'purchase') : [],
    houses: mayCreate ? (await warehouses.listActive(tx)).filter((house) => house.branchCode === context.scope.branchCode) : [],
  }));
  const money = (value: string) => formatMoney(value, 'IQD', locale as Locale);
  const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
  const query = (p: number) => [outcome.q ? `q=${encodeURIComponent(outcome.q)}` : '', projectParam ? `project=${encodeURIComponent(projectParam)}` : '', statusParam ? `status=${statusParam}` : '', `page=${p}`].filter(Boolean).join('&');
  const today = businessToday();
  const costName = (c: { nameEn: string; nameAr: string | null }) => (locale === 'ar' && c.nameAr ? c.nameAr : c.nameEn);

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <NewRecordDialog buttonLabel={x('new_issue')} closeLabel={t('close')} openOnLoad={Boolean(outcome.error)} title={x('new_issue_title')}>
            <p className="muted">{x('issue_note')}</p>
            <Form action={createMaterialIssue}>
              <Hidden name="document_id" value={randomUUID()} />
              <Grid>
                <Select label={x('element')} name="element" options={pickers.elements.map((e) => ({ value: `${e.projectCode}|${e.wbsCode}`, label: `${e.wbsCode} · ${e.name} (${e.projectName})` }))} required />
                <Select label={x('cost_code')} name="cost_code" options={pickers.codes.map((c) => ({ value: c.code, label: `${c.code} · ${costName(c)}` }))} required />
                <Select label={x('kind')} name="kind" options={[{ value: 'issue', label: x('kind_issue') }, { value: 'return', label: x('kind_return_stock') }]} required />
                <Select emptyLabel="" label={column('warehouse')} name="warehouse_code" options={houses.map((house) => ({ value: house.code, label: `${house.code} · ${house.name}` }))} required />
                <SearchablePicker label={column('item_name')} name="item_code" options={stockItems.map((row) => ({ value: row.code, label: row.name }))} required />
                <Field label={column('quantity')} min={0} name="quantity" required requiredLabel={t('required_hint')} type="number" />
                <Field hint={x('unit_cost_hint')} label={x('unit_cost')} name="unit_cost_iqd" />
                <Field label={column('batch_number')} name="batch_number" />
                <Field label={column('serial_number')} name="serial_number" />
                <Field defaultValue={today} label={column('date')} name="movement_date" required requiredLabel={t('required_hint')} type="date" />
              </Grid>
              <Field label={column('description')} name="description" wide />
              <SubmitRow>
                <Submit label={t('create')} />
              </SubmitRow>
            </Form>
          </NewRecordDialog>
        ) : undefined
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/projects/material-issues" />}
      subtitle={x('material_issues_subtitle')}
      title={page('material_issues')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <section aria-labelledby="issues-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="issues-list-title">
            <span>{page('material_issues')}</span>
            <span className={s.sapTitleMeta}>{t('rows_shown', { count: result.total })}</span>
          </h2>

          <ListToolbar clearHref="/projects/material-issues" clearLabel={t('clear_search')} countLabel={t('rows_shown', { count: result.total })} placeholder={t('search_placeholder')} q={outcome.q} searchLabel={t('search')} />

          <form className={s.filterBar} method="get">
            {outcome.q ? <input name="q" type="hidden" value={outcome.q} /> : null}
            <FilterRow>
              <Select defaultValue={projectParam} emptyLabel={x('all_projects')} label={x('project')} name="project" options={choices.map((c) => ({ value: c.code, label: `${c.code} · ${c.name}` }))} />
              <Select defaultValue={statusParam} emptyLabel={x('status_all')} label={column('status')} name="status" options={['draft', 'posted', 'cancelled'].map((value) => ({ value, label: status(value) }))} />
              <SubmitRow>
                <Submit label={x('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="issues-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{column('document_no')}</th>
                  <th scope="col">{x('project')}</th>
                  <th scope="col">{x('element')}</th>
                  <th scope="col">{x('cost_code')}</th>
                  <th scope="col">{column('warehouse')}</th>
                  <th scope="col">{x('kind')}</th>
                  <th scope="col">{column('date')}</th>
                  <th className={s.sapNum} scope="col">
                    {x('lines')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('cost')}
                  </th>
                  <th scope="col">{column('status')}</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={10}>
                      {x('no_issues')}
                    </td>
                  </tr>
                ) : null}
                {result.rows.map((row) => (
                  <tr key={row.documentNo}>
                    <td>
                      <Link className={s.sapLink} href={`/projects/material-issues/${encodeURIComponent(row.documentNo)}`}>
                        <bdi dir="ltr">{row.documentNo}</bdi>
                      </Link>
                    </td>
                    <td>
                      <Link className={s.sapLink} href={`/projects/${encodeURIComponent(row.projectCode)}`}>
                        <bdi dir="ltr">{row.projectCode}</bdi>
                      </Link>{' '}
                      <bdi dir="auto">{row.projectName}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.wbsCode}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.costCode}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.warehouseCode}</bdi>
                    </td>
                    <td>{row.kind === 'issue' ? x('kind_issue') : x('kind_return_stock')}</td>
                    <td>
                      <bdi dir="ltr">{formatBusinessDate(row.movementDate, locale as Locale)}</bdi>
                    </td>
                    <td className={s.sapNum}>{row.lines}</td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.totalCostIqd)}</bdi>
                    </td>
                    <td>
                      <span className={`status status--${row.status} ${s.sapRegisterStatus}`} data-status={row.status}>
                        {status(row.status)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 ? (
            <Pagination count={pages} current={result.page} hrefFor={(p) => `/projects/material-issues?${query(p)}`} labels={{ label: t('pagination'), previous: t('previous'), next: t('next'), page: (p) => t('page_n', { page: p }) }} locale={locale} />
          ) : null}
        </div>
      </section>
    </AdminPage>
  );
}
