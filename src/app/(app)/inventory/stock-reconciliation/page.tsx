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
  Select,
  Submit,
  SubmitRow,
  matches,
} from '@/components/admin';
import { PairedPicker } from '@/components/admin/paired-picker';
import { SectionTabs } from '@/components/admin/section-tabs';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { can } from '@domain/permissions';
import { formatQuantity, parseQuantity } from '@domain/uom';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as items from '@/server/services/items';
import * as stock from '@/server/services/stock-operations';
import * as warehouses from '@/server/services/warehouses';
import { createAdjustment } from './actions';

/**
 * Item Reconciliation — Operations build, block 7.
 *
 *   Item Name; Warehouse; In/Out; Adjustment Quantity. The adjustment is
 *   entered as In or Out to match the actual inventory quantity.
 *
 * Those four and the date. An Out cannot take the warehouse below zero
 * (block 11); an In is valued at what the same item already costs.
 */
export const dynamic = 'force-dynamic';

export default async function ReconciliationPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/inventory/stock-reconciliation')) notFound();

  const [t, page, column, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    requireContext(),
    outcomeOf(searchParams),
  ]);

  const { principal } = context;
  if (!can(principal, 'view', stock.RECONCILIATION_OBJECT)) {
    return <Denied object={page('stock_reconciliation')} />;
  }
  const mayCreate = can(principal, 'create', stock.RECONCILIATION_OBJECT);

  const { rows, stockItems, houses } = await withCurrentUser(async (tx) => ({
    rows: await stock.listAdjustments(tx),
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
            buttonLabel={t('reconciliation.new')}
            closeLabel={t('close')}
            openOnLoad={Boolean(outcome.error)}
            title={t('reconciliation.new')}
          >
            <p className="muted">{t('reconciliation.created_note')}</p>
            <Form action={createAdjustment}>
              <Grid>
                <PairedPicker
                  codeLabel={column('item_code')}
                  name="item_code"
                  nameLabel={column('item_name')}
                  options={stockItems.map((row) => ({
                    value: row.code,
                    code: row.code,
                    name: row.name,
                  }))}
                  plain
                  required
                />
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
                <Select
                  label={column('in_out')}
                  name="direction"
                  options={[
                    { value: 'in', label: t('reconciliation.in') },
                    { value: 'out', label: t('reconciliation.out') },
                  ]}
                  required
                />
                <Field
                  label={column('adjustment_quantity')}
                  min={0}
                  name="quantity"
                  required
                  requiredLabel={t('required_hint')}
                  type="number"
                />
                <Field
                  defaultValue={today}
                  label={column('date')}
                  name="adjustment_date"
                  required
                  requiredLabel={t('required_hint')}
                  type="date"
                />
              </Grid>
              <SubmitRow>
                <Submit label={t('create')} />
              </SubmitRow>
            </Form>
          </NewRecordDialog>
        ) : null
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/inventory/stock-reconciliation" />}
      subtitle={t('reconciliation.subtitle')}
      title={page('stock_reconciliation')}
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
          clearHref="/inventory/stock-reconciliation"
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
                <th scope="col">{column('item_code')}</th>
                <th scope="col">{column('item_name')}</th>
                <th scope="col">{column('warehouse')}</th>
                <th scope="col">{column('in_out')}</th>
                <th scope="col">{column('adjustment_quantity')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 ? (
                <tr>
                  <td colSpan={7}>{t('reconciliation.none')}</td>
                </tr>
              ) : null}
              {shown.map((row) => (
                <tr key={row.id}>
                  <td>
                    <bdi dir="ltr">{row.adjustmentNo}</bdi>
                  </td>
                  <td>
                    <bdi dir="ltr">{row.adjustmentDate}</bdi>
                  </td>
                  <td>
                    <bdi dir="ltr">{row.itemCode}</bdi>
                  </td>
                  <td>
                    <bdi dir="auto">{row.itemName}</bdi>
                  </td>
                  <td>
                    <bdi dir="auto">{`${row.warehouseCode} · ${row.warehouseName}`}</bdi>
                  </td>
                  <td>{row.direction === 'in' ? t('reconciliation.in') : t('reconciliation.out')}</td>
                  <td>
                    <bdi dir="ltr">{formatQuantity(parseQuantity(row.quantity))}</bdi>
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
