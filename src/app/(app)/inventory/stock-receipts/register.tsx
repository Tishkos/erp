import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, FilterRow, Flash, ListToolbar, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { Pagination } from '@/components/ui';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { ProfileLink } from '@/components/admin/profile-link';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatMoney, formatQuantity, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as flows from '@/server/services/stock-flows';

/**
 * Stock Receipts and Stock Issues — IMPROVEMENT-002: two read-only registers
 * over the movement ledger, drawn as every register is (the Purchase
 * Invoices list): the Inventory tabs, one window, the search box, the date,
 * warehouse and kind filters, fifty rows a page. Every row names the document
 * that moved the stock and opens it where it has a page; the item and the
 * warehouse open their profiles. Nothing is entered here — the documents do
 * that.
 */
export async function StockFlowRegister({ direction, searchParams }: { direction: flows.FlowDirection; searchParams: SearchParams }) {
  const route = direction === 'receipt' ? '/inventory/stock-receipts' : '/inventory/stock-issues';
  const pageKey = direction === 'receipt' ? 'stock_receipts' : 'stock_issues';
  if (!visibleRoute(route)) notFound();

  const [t, admin, page, column, locale, context, outcome] = await Promise.all([
    getTranslations('admin.stock_flows'),
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', flows.PERMISSION_OBJECT)) {
    return <Denied object={page(pageKey)} />;
  }

  const params = await searchParams;
  const text = (name: string) => (typeof params[name] === 'string' && params[name] ? (params[name] as string) : null);
  const from = text('from');
  const to = text('to');
  const warehouseCode = text('warehouse');
  const kind = text('kind');
  const kinds = direction === 'receipt' ? flows.RECEIPT_KINDS : flows.ISSUE_KINDS;

  const { result, warehouses } = await withCurrentUser(async (tx) => ({
    result: await flows.forScreen(tx, principal, direction, { search: outcome.q, from, to, warehouseCode, kind, page: outcome.page }),
    warehouses: await flows.warehouses(tx, principal),
  }));
  const query = (p: number) =>
    [
      outcome.q ? `q=${encodeURIComponent(outcome.q)}` : '',
      from ? `from=${from}` : '',
      to ? `to=${to}` : '',
      warehouseCode ? `warehouse=${encodeURIComponent(warehouseCode)}` : '',
      kind ? `kind=${kind}` : '',
      `page=${p}`,
    ]
      .filter(Boolean)
      .join('&');
  const titleId = `${pageKey}-title`;

  return (
    <AdminPage back={{ href: '/', label: admin('dashboard_label') }} tabs={<SectionTabs route={route} />} subtitle={t(`${pageKey}_subtitle`)} title={page(pageKey)} variant="sap">
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />

      <section aria-labelledby={titleId} className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id={titleId}>
            <span>{page(pageKey)}</span>
            <span className={s.sapTitleMeta}>{admin('rows_shown', { count: result.total })}</span>
          </h2>

          <ListToolbar clearHref={route} clearLabel={admin('clear_search')} countLabel={admin('rows_shown', { count: result.total })} placeholder={admin('search_placeholder')} q={outcome.q} searchLabel={admin('search')} />

          <form className={s.filterBar} method="get">
            <FilterRow>
              <Field defaultValue={from ?? ''} label={column('from')} name="from" type="date" />
              <Field defaultValue={to ?? ''} label={column('to')} name="to" type="date" />
              <Select defaultValue={warehouseCode ?? ''} emptyLabel={t('all_warehouses')} label={column('warehouse')} name="warehouse" options={warehouses.map((w) => ({ value: w.code, label: `${w.code} · ${w.name}` }))} />
              <Select defaultValue={kind ?? ''} emptyLabel={t('all_kinds')} label={t('kind')} name="kind" options={kinds.map((code) => ({ value: code, label: t(`kind_${code}`) }))} />
              <SubmitRow>
                <Submit label={t('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby={titleId} className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{column('date')}</th>
                  <th scope="col">{t('kind')}</th>
                  <th scope="col">{column('document_no')}</th>
                  <th scope="col">{column('item_code')}</th>
                  <th scope="col">{column('item_name')}</th>
                  <th scope="col">{column('warehouse')}</th>
                  <th className={s.sapNum} scope="col">
                    {column('quantity')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('unit_cost')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('value')}
                  </th>
                  <th scope="col">{t('journal')}</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={10}>
                      {t(`${pageKey}_none`)}
                    </td>
                  </tr>
                ) : null}
                {result.rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <bdi dir="ltr">{formatBusinessDate(row.movementDate, locale as Locale)}</bdi>
                    </td>
                    <td>{t(`kind_${row.kind}`)}</td>
                    <td>
                      {row.documentNo && row.documentHref ? (
                        <Link className={s.sapLink} href={row.documentHref}>
                          <bdi dir="ltr">{row.documentNo}</bdi>
                        </Link>
                      ) : (
                        <bdi dir="ltr">{row.documentNo ?? '—'}</bdi>
                      )}
                    </td>
                    <td>
                      <ProfileLink code={row.itemCode} kind="item" />
                    </td>
                    <td>
                      <bdi dir="auto">{row.itemName}</bdi>
                    </td>
                    <td>
                      <ProfileLink code={row.warehouseCode} kind="warehouse" name={row.warehouseName} />
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{`${formatQuantity(row.quantity, locale as Locale)} ${row.uomCode}`}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{row.unitCostIqd ? formatMoney(row.unitCostIqd, 'IQD', locale as Locale) : '—'}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{row.valueIqd ? formatMoney(row.valueIqd, 'IQD', locale as Locale) : '—'}</bdi>
                    </td>
                    <td>
                      {row.journalEntryNo ? (
                        <Link className={s.sapLink} href={`/finance/journals/${encodeURIComponent(row.journalEntryNo)}`}>
                          <bdi dir="ltr">{row.journalEntryNo}</bdi>
                        </Link>
                      ) : (
                        '—'
                      )}
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
              hrefFor={(p) => `${route}?${query(p)}`}
              labels={{ label: admin('pagination'), previous: admin('previous'), next: admin('next'), page: (p) => admin('page_n', { page: p }) }}
              locale={locale}
            />
          ) : null}
        </div>
      </section>
    </AdminPage>
  );
}
