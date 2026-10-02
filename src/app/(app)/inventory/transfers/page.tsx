import { randomUUID } from 'node:crypto';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Panel } from '@/components/ui';
import {
  AdminPage,
  Field,
  Flash,
  Form,
  Grid,
  Hidden,
  ListToolbar,
  NewRecordDialog,
  Pill,
  Select,
  Submit,
  SubmitRow,
  matches,
} from '@/components/admin';
import { SearchablePicker } from '@/components/admin/searchable-picker';
import { IntegrityBanner } from '@/components/admin/integrity-banner';
import { SectionTabs } from '@/components/admin/section-tabs';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { ExportMenu } from '@/components/print/export-menu';
import { can } from '@domain/permissions';
import { formatQuantity, parseQuantity } from '@domain/uom';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as items from '@/server/services/items';
import * as stock from '@/server/services/stock-operations';
import * as warehouses from '@/server/services/warehouses';
import { createTransfer } from './actions';
import { businessToday } from '@/server/domain/business-date';

/**
 * Transfer — Operations build, block 7: *"Items can be transferred between
 * warehouses."*
 *
 * One form: the item, the two warehouses, the quantity and the date. Saving it
 * moves the stock — Out of the first warehouse, In to the second — and the
 * system numbers it. There is no request to approve and nothing in transit:
 * the build asks for a transfer, not for the blueprint's four-step workflow.
 */
export const dynamic = 'force-dynamic';

export default async function TransfersPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/inventory/transfers')) notFound();

  const [t, page, column, printT, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getTranslations('print'),
    requireContext(),
    outcomeOf(searchParams),
  ]);

  const { principal } = context;
  if (!can(principal, 'view', stock.TRANSFER_OBJECT)) {
    return <Denied object={page('transfer_requests')} />;
  }
  const mayCreate = can(principal, 'create', stock.TRANSFER_OBJECT);

  const { rows, stockItems, houses } = await withCurrentUser(async (tx) => ({
    rows: await stock.listTransfers(tx),
    stockItems: mayCreate ? await items.invoiceChoices(tx, 'purchase') : [],
    houses: mayCreate
      ? (await warehouses.listActive(tx)).filter(
          (house) => house.branchCode === context.scope.branchCode,
        )
      : [],
  }));
  const shown = rows.filter((row) => matches(row, outcome.q));
  const today = businessToday();
  const warehouseOptions = houses.map((house) => ({
    value: house.code,
    label: `${house.code} · ${house.name}`,
  }));

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <NewRecordDialog
            buttonLabel={t('transfers.new')}
            closeLabel={t('close')}
            openOnLoad={Boolean(outcome.error)}
            title={t('transfers.new')}
          >
            <p className="muted">{t('transfers.created_note')}</p>
            <Form action={createTransfer}>
              {/* Minted when the page is drawn. Two presses of this form send
                  one id, and the second finds the first's transfer saved. */}
              <Hidden name="document_id" value={randomUUID()} />
              <Grid>
                {/* The name alone. A transfer is raised by somebody who knows
                    what is moving, not its code, and the pair asked for the
                    same fact twice. The code still reaches the server — the
                    picker carries it in a hidden field once what is typed
                    matches an item exactly, so a half-typed name submits
                    nothing rather than a guess. */}
                <SearchablePicker
                  label={column('item_name')}
                  name="item_code"
                  options={stockItems.map((row) => ({ value: row.code, label: row.name }))}
                  required
                />
                <Select
                  emptyLabel=""
                  label={column('from_warehouse')}
                  name="from_warehouse_code"
                  options={warehouseOptions}
                  required
                />
                <Select
                  emptyLabel=""
                  label={column('to_warehouse')}
                  name="to_warehouse_code"
                  options={warehouseOptions}
                  required
                />
                <Field
                  label={column('quantity')}
                  min={0}
                  name="quantity"
                  required
                  requiredLabel={t('required_hint')}
                  type="number"
                />
                <Field
                  defaultValue={today}
                  label={column('date')}
                  name="transfer_date"
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
      tabs={<SectionTabs route="/inventory/transfers" />}
      subtitle={t('transfers.subtitle')}
      title={page('transfer_requests')}
      variant="sap"
    >
      <IntegrityBanner />
      <Flash
        error={outcome.error}
        errorTitle={t('error_title')}
        saved={outcome.saved}
        savedLabel={t('saved')}
      />

      <Panel flush>
        <ListToolbar
          clearHref="/inventory/transfers"
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
                <th scope="col">{column('from_warehouse')}</th>
                <th scope="col">{column('to_warehouse')}</th>
                <th scope="col">{column('quantity')}</th>
                {/* Whether the Stock Movement ledger holds this transfer. It
                    always does for a transfer the application wrote; the
                    column exists so that one it does not hold is seen here,
                    beside the figure it failed to move, rather than found by
                    somebody's arithmetic on another page. */}
                <th scope="col">{t('transfers.ledger')}</th>
                <th scope="col">{printT('menu')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 ? (
                <tr>
                  <td colSpan={9}>{t('transfers.none')}</td>
                </tr>
              ) : null}
              {shown.map((row) => (
                <tr key={row.id}>
                  <td>
                    <bdi dir="ltr">{row.transferNo}</bdi>
                  </td>
                  <td>
                    <bdi dir="ltr">{row.transferDate}</bdi>
                  </td>
                  <td>
                    <bdi dir="ltr">{row.itemCode}</bdi>
                  </td>
                  <td>
                    <bdi dir="auto">{row.itemName}</bdi>
                  </td>
                  <td>
                    <bdi dir="ltr">{row.fromWarehouseCode}</bdi>
                  </td>
                  <td>
                    <bdi dir="ltr">{row.toWarehouseCode}</bdi>
                  </td>
                  <td>
                    <bdi dir="ltr">{formatQuantity(parseQuantity(row.quantity))}</bdi>
                  </td>
                  <td>
                    {parseQuantity(row.ledgerQuantity) === parseQuantity(row.quantity) ? (
                      <Pill label={t('transfers.ledger_recorded')} on />
                    ) : (
                      <span title={t('transfers.ledger_missing_hint')}>
                        <Pill label={t('transfers.ledger_missing')} on={false} />
                      </span>
                    )}
                  </td>
                  <td>
                    <ExportMenu
                      exportKey="transfer"
                      id={row.transferNo}
                      label={row.transferNo}
                      principal={principal}
                    />
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
