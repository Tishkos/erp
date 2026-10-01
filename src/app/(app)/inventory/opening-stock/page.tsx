import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Panel } from '@/components/ui';
import {
  AdminPage,
  Field,
  Flash,
  Form,
  Grid,
  ListToolbar,
  NewRecordDialog,
  Pill,
  Select,
  Submit,
  SubmitRow,
  matches,
} from '@/components/admin';
import { OpeningStockLines } from '@/components/admin/opening-stock-lines';
import { SectionTabs } from '@/components/admin/section-tabs';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as items from '@/server/services/items';
import * as opening from '@/server/services/opening-stock';
import * as warehouses from '@/server/services/warehouses';
import { createOpeningStock } from './actions';

/**
 * Opening Stock — Operations build, block 7.
 *
 *   Item Name; Item Code; Quantity; Total Price; Average Unit Price;
 *   Warehouse Name; Warehouse Code.
 *
 * One warehouse per document and a line per item. The number is the system's.
 */
export const dynamic = 'force-dynamic';

export default async function OpeningStockPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/inventory/opening-stock')) notFound();

  const [t, page, column, status, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getTranslations('status'),
    requireContext(),
    outcomeOf(searchParams),
  ]);

  const { principal } = context;
  if (!can(principal, 'view', opening.PERMISSION_OBJECT)) {
    return <Denied object={page('opening_stock')} />;
  }
  const mayCreate = can(principal, 'create', opening.PERMISSION_OBJECT);

  const { rows, stockItems, houses } = await withCurrentUser(async (tx) => ({
    rows: await opening.list(tx),
    stockItems: mayCreate ? await items.invoiceChoices(tx, 'purchase') : [],
    houses: mayCreate
      ? (await warehouses.listActive(tx)).filter(
          (house) => house.branchCode === context.scope.branchCode,
        )
      : [],
  }));
  const shown = rows.filter((row) => matches(row, outcome.q));
  const today = new Date().toISOString().slice(0, 10);

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <NewRecordDialog
            buttonLabel={t('opening_stock.new')}
            closeLabel={t('close')}
            openOnLoad={Boolean(outcome.error)}
            title={t('opening_stock.new')}
            wide
          >
            <p className="muted">{t('opening_stock.created_note')}</p>
            <Form action={createOpeningStock}>
              <Grid>
                <Select
                  emptyLabel=""
                  label={column('warehouse')}
                  name="warehouse_code"
                  options={houses.map((house) => ({
                    value: house.code,
                    label: `${house.code} · ${house.name}`,
                  }))}
                  required
                />
                <Field
                  defaultValue={today}
                  label={column('date')}
                  name="document_date"
                  required
                  requiredLabel={t('required_hint')}
                  type="date"
                />
              </Grid>
              <OpeningStockLines
                items={stockItems.map((row) => ({ code: row.code, name: row.name }))}
                labels={{
                  itemCode: column('item_code'),
                  itemName: column('item_name'),
                  quantity: column('quantity'),
                  total: column('total_price'),
                  average: column('average_unit_price'),
                  remove: t('remove_line'),
                  resizeColumn: t('invoices.resize_column'),
                  documentTotal: t('reports.totals'),
                }}
                widthsKey={`erp.lines.opening.${context.principal.userId}`}
              />
              <SubmitRow>
                <Submit label={t('save')} />
              </SubmitRow>
            </Form>
          </NewRecordDialog>
        ) : null
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/inventory/opening-stock" />}
      subtitle={t('opening_stock.subtitle')}
      title={page('opening_stock')}
      variant="sap"
    >
      <Flash
        error={outcome.error}
        errorTitle={t('error_title')}
        saved={outcome.saved}
        savedLabel={t('saved')}
      />

      <Panel flush>
        <ListToolbar
          clearHref="/inventory/opening-stock"
          clearLabel={t('clear_search')}
          countLabel={t('rows_shown', { count: shown.length })}
          placeholder={t('search_placeholder')}
          q={outcome.q}
          searchLabel={t('search')}
        />
        <div className="table-wrap">
          <table className="list">
            <thead>
              <tr>
                <th scope="col">{column('document_no')}</th>
                <th scope="col">{column('date')}</th>
                <th scope="col">{column('warehouse_code')}</th>
                <th scope="col">{column('warehouse_name')}</th>
                <th scope="col">{t('opening_stock.lines')}</th>
                <th scope="col">{column('total_price')}</th>
                <th scope="col">{column('status')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 ? (
                <tr>
                  <td colSpan={7}>{t('opening_stock.none')}</td>
                </tr>
              ) : null}
              {shown.map((row) => (
                <tr key={row.id}>
                  <td>
                    <Link href={`/inventory/opening-stock/${encodeURIComponent(row.documentNo)}`}>
                      <bdi dir="ltr">{row.documentNo}</bdi>
                    </Link>
                  </td>
                  <td>
                    <bdi dir="ltr">{row.documentDate}</bdi>
                  </td>
                  <td>
                    <bdi dir="ltr">{row.warehouseCode}</bdi>
                  </td>
                  <td>
                    <bdi dir="auto">{row.warehouseName}</bdi>
                  </td>
                  <td>{row.lines}</td>
                  <td>
                    <bdi dir="ltr">{Number(row.totalIqd).toLocaleString('en-US')}</bdi>
                  </td>
                  <td>
                    <Pill label={status(row.status)} on={row.status === 'approved'} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </AdminPage>
  );
}
