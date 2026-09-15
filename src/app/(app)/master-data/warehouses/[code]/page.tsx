import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Warehouse } from 'lucide-react';
import { Panel } from '@/components/ui';
import {
  ActionButton,
  AdminPage,
  Field,
  Flash,
  Form,
  Grid,
  Pill,
  ReasonForm,
  Submit,
  SubmitRow,
  admin as s,
} from '@/components/admin';
import { AuditLogButton, RecordHistory } from '@/components/admin/history';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatMoney, formatTimestamp, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as reports from '@/server/services/inventory-reports';
import * as warehouses from '@/server/services/warehouses';
import { renameWarehouse, setWarehouseActive } from '../actions';

/**
 * One warehouse — Operations build, block 7.
 *
 * Laid out as a branch is, because it is the same kind of record: identity and
 * facts on the left, editing and history on the right. A person who has learned
 * one master-data screen has learned this one.
 *
 * The history is the part worth having. A warehouse that was renamed, closed
 * and reopened is a warehouse whose stock reports change meaning on those
 * dates, and the audit trail is the only place that is recoverable.
 *
 * The stock panel is the Warehouses Report narrowed to this warehouse, reading
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

      <div className={s.profileGrid}>
        {/* Left: identity, facts, lifecycle */}
        <div className={s.profileStack}>
          <Panel>
            <div className={s.profileCard}>
              <span className={`${s.avatarLarge} ${s.profileAvatar}`}>
                <Warehouse aria-hidden="true" style={{ inlineSize: '2rem', blockSize: '2rem' }} />
              </span>
              <h2>{row.name}</h2>
              <p>
                {column('warehouse_code')}: {row.code}
              </p>
              <Pill label={row.active ? t('active') : t('inactive')} on={row.active} />
            </div>
          </Panel>

          <Panel title={t('details')}>
            <ul className={s.profileFacts}>
              <li>
                <span>{column('branch_code')}</span>
                <span>{row.branchCode}</span>
              </li>
              <li>
                <span>{t('reports.totals')}</span>
                <span>{money(String(total))}</span>
              </li>
              <li>
                <span>{t('created_at')}</span>
                <span>{formatTimestamp(row.createdAt.toISOString(), locale as Locale)}</span>
              </li>
            </ul>
          </Panel>

          {mayEdit ? (
            <Panel title={row.active ? t('warehouses.close') : t('warehouses.reopen')}>
              {row.active ? (
                <ReasonForm
                  action={setWarehouseActive}
                  hidden={{ code: row.code }}
                  label={t('warehouses.close')}
                  reasonLabel={t('reason')}
                  reasonPlaceholder={t('reason_placeholder')}
                />
              ) : (
                <ActionButton
                  action={setWarehouseActive}
                  hidden={{ code: row.code, active: '1' }}
                  label={t('warehouses.reopen')}
                  small={false}
                  tone="primary"
                />
              )}
            </Panel>
          ) : null}
        </div>

        {/* Right: editing, what it holds, and history */}
        <div className={s.profileStack}>
          {mayEdit ? (
            <Panel title={t('update')}>
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
                  <Submit label={t('save')} />
                </SubmitRow>
              </Form>
            </Panel>
          ) : null}

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
                      <td>{line.itemCode}</td>
                      <td>{line.itemName}</td>
                      <td>{units(line.quantity)}</td>
                      <td>{money(line.valueIqd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <RecordHistory objectId={row.code} objectType={warehouses.PERMISSION_OBJECT} />
        </div>
      </div>
    </AdminPage>
  );
}
