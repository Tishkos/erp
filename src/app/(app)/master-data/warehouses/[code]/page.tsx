import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Panel } from '@/components/ui';
import {
  ActionButton,
  AdminPage,
  Field,
  Flash,
  Form,
  Grid,
  Pill,
  Submit,
  SubmitRow,
  admin as s,
} from '@/components/admin';
import { AuditLogButton, RecordHistory } from '@/components/admin/history';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as reports from '@/server/services/inventory-reports';
import * as warehouses from '@/server/services/warehouses';
import { renameWarehouse, setWarehouseActive } from '../actions';

/**
 * One warehouse — Operations build, block 7.
 *
 * Its name and code, what it is holding, and everything that has been done to
 * it. The history is the point: a warehouse that was renamed, closed and
 * reopened is a warehouse whose stock reports change meaning on those dates,
 * and the only place that is recoverable is the audit trail.
 *
 * The stock table is the Warehouses Report narrowed to one warehouse, reading
 * the same FIFO layers, so the two can never disagree about what is here.
 */
export const dynamic = 'force-dynamic';

export default async function WarehouseRecordPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/master-data/warehouses')) notFound();

  const [t, page, column, locale, context, outcome, { code: rawCode }] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    params,
  ]);

  const code = decodeURIComponent(rawCode);
  const { principal } = context;
  if (!can(principal, 'view', warehouses.PERMISSION_OBJECT)) {
    return <Denied object={page('warehouses')} />;
  }
  const mayEdit = can(principal, 'configure', warehouses.PERMISSION_OBJECT);

  const data = await withCurrentUser(async (tx) => {
    const row = await warehouses.get(tx, code);
    if (!row) return null;
    return {
      row,
      stock: await reports.valuation(tx, principal, {
        warehouseCode: code,
        allPermittedBranches: true,
      }),
    };
  });

  if (!data) notFound();
  const { row, stock } = data;

  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);
  const units = (quantity: string) => String(Number(quantity));
  const total = stock.reduce((sum, line) => sum + Number(line.valueIqd), 0);

  return (
    <AdminPage
      actions={<AuditLogButton label={t('history')} />}
      back={{ href: '/master-data/warehouses', label: t('back') }}
      title={`${row.code} · ${row.name}`}
      trail={[{ href: '/', label: t('dashboard_label') }]}
      variant="sap"
    >
      <Flash
        error={outcome.error}
        errorTitle={t('error_title')}
        saved={outcome.saved}
        savedLabel={t('saved')}
      />

      <Panel title={page('warehouses')}>
        {mayEdit ? (
          <Form action={renameWarehouse}>
            <input name="code" type="hidden" value={row.code} />
            <Grid>
              <Field
                defaultValue={row.name}
                label={column('warehouse_name')}
                name="name"
                required
                requiredLabel={t('required_hint')}
              />
            </Grid>
            <SubmitRow>
              <Submit label={t('warehouses.rename')} />
              <ActionButton
                action={setWarehouseActive}
                hidden={row.active ? { code: row.code } : { code: row.code, active: 'on' }}
                label={row.active ? t('warehouses.close') : t('warehouses.reopen')}
              />
            </SubmitRow>
          </Form>
        ) : (
          <dl className={s.inboxFacts}>
            <div>
              <dt>{column('warehouse_name')}</dt>
              <dd>
                <bdi dir="auto">{row.name}</bdi>
              </dd>
            </div>
          </dl>
        )}

        <dl className={s.inboxFacts}>
          <div>
            <dt>{column('branch_code')}</dt>
            <dd>
              <bdi dir="ltr">{row.branchCode}</bdi>
            </dd>
          </div>
          <div>
            <dt>{column('active')}</dt>
            <dd>
              <Pill label={row.active ? t('active') : t('inactive')} on={row.active} />
            </dd>
          </div>
        </dl>
      </Panel>

      <Panel title={t('reports.warehouses_report')}>
        <div className="table-wrap">
          <table className="list">
            <thead>
              <tr>
                <th scope="col">{column('item_code')}</th>
                <th scope="col">{column('item_name')}</th>
                <th scope="col">{column('quantity')}</th>
                <th scope="col">{column('total_price')}</th>
              </tr>
            </thead>
            <tbody>
              {stock.length === 0 ? (
                <tr>
                  <td colSpan={4}>{t('reports.nothing_in_stock')}</td>
                </tr>
              ) : null}
              {stock.map((line) => (
                <tr key={line.itemCode}>
                  <td>
                    <bdi dir="ltr">{line.itemCode}</bdi>
                  </td>
                  <td>
                    <bdi dir="auto">{line.itemName}</bdi>
                  </td>
                  <td>
                    <bdi dir="ltr">{units(line.quantity)}</bdi>
                  </td>
                  <td>
                    <bdi dir="ltr">{money(line.valueIqd)}</bdi>
                  </td>
                </tr>
              ))}
            </tbody>
            {stock.length > 0 ? (
              <tfoot>
                <tr>
                  <td colSpan={3}>{t('reports.totals')}</td>
                  <td>
                    <bdi dir="ltr">{money(String(total))}</bdi>
                  </td>
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
      </Panel>

      <RecordHistory objectId={row.code} objectType={warehouses.PERMISSION_OBJECT} />
    </AdminPage>
  );
}
