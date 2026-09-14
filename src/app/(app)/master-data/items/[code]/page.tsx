import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Package } from 'lucide-react';
import { Panel } from '@/components/ui';
import {
  ActionButton,
  AdminPage,
  Field,
  Flash,
  Form,
  Grid,
  Hidden,
  Pill,
  ReasonForm,
  Select,
  Submit,
  SubmitRow,
  admin as s,
} from '@/components/admin';
import { AuditLogButton, RecordHistory } from '@/components/admin/history';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { can } from '@domain/permissions';
import { AdminNotFoundError } from '@/server/services/administration';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import { formatQuantity } from '@domain/uom';
import * as coa from '@/server/services/chart-of-accounts';
import * as items from '@/server/services/items';
import * as uom from '@/server/services/units-of-measure';
import {
  linkItemSupplier,
  makeDefaultSupplier,
  setItemActive,
  unlinkItemSupplier,
  updateItem,
} from '../actions';

/**
 * One item — Phase 2 requirement 4, including the part no other master needs:
 * the suppliers it can be bought from, one of them the default.
 *
 * The default is what a purchase order will propose. An item with suppliers
 * and no default would make that order ask a question with no answer, so the
 * first supplier linked becomes the default and removing the default hands the
 * role to the next one rather than leaving the item without.
 */
export const dynamic = 'force-dynamic';

export default async function ItemPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/master-data/items')) notFound();

  const [t, page, column, context, outcome, { code: rawCode }] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    requireContext(),
    outcomeOf(searchParams),
    params,
  ]);
  const code = decodeURIComponent(rawCode);
  const { principal } = context;
  if (!can(principal, 'view', items.PERMISSION_OBJECT)) {
    return <Denied object={page('items')} />;
  }
  const mayEdit = can(principal, 'configure', items.PERMISSION_OBJECT);
  const mayAdminister = can(principal, 'administer', items.PERMISSION_OBJECT);

  const data = await withCurrentUser(async (tx) => {
    try {
      const row = await items.detail(tx, code);
      return {
        row,
        units: mayEdit ? await uom.listActive(tx) : [],
        categories: mayEdit ? await items.categories(tx) : [],
        accounts: mayEdit ? await coa.postableAccounts(tx) : [],
        suppliers: mayEdit ? await items.selectableSuppliers(tx) : [],
      };
    } catch (error) {
      if (error instanceof AdminNotFoundError) return null;
      throw error;
    }
  });
  if (!data) notFound();
  const { row, units, categories, accounts, suppliers } = data;

  const revenue = accounts.filter((a) => a.accountType === 'revenue');
  const expense = accounts.filter((a) => a.accountType === 'expense');
  const asset = accounts.filter((a) => a.accountType === 'asset');
  const linkedIds = new Set(row.suppliers.map((supplier) => supplier.supplierId));
  const linkable = suppliers.filter((supplier) => !linkedIds.has(supplier.id));

  return (
    <AdminPage
      actions={<AuditLogButton label={t('history')} />}
      back={{ href: '/master-data/items', label: t('back') }}
      title={`${row.code} · ${row.name}`}
      trail={[{ href: '/', label: t('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <div className={s.profileGrid}>
        <div className={s.profileStack}>
          <Panel>
            <div className={s.profileCard}>
              <span className={`${s.avatarLarge} ${s.profileAvatar}`}>
                <Package aria-hidden="true" style={{ inlineSize: '2rem', blockSize: '2rem' }} />
              </span>
              <h2>{row.name}</h2>
              <p>
                {t('code')}: {row.code}
              </p>
              <Pill label={row.active ? t('active') : t('inactive')} on={row.active} />
            </div>
          </Panel>

          <Panel title={t('details')}>
            <ul className={s.profileFacts}>
              <li>
                <span>{t('items.kind')}</span>
                <span>{row.isStock ? t('items.kind_stock') : t('items.kind_service')}</span>
              </li>
              <li>
                <span>{t('items.category')}</span>
                <span>{row.category ?? t('none')}</span>
              </li>
              <li>
                <span>{t('items.base_uom')}</span>
                <span>
                  {row.baseUomCode}
                  {row.baseUomName ? ` · ${row.baseUomName}` : ''}
                </span>
              </li>
              <li>
                <span>{t('items.tracking')}</span>
                <span>{row.tracking ? t(`items.tracking_${row.tracking}`) : t('items.tracking_none')}</span>
              </li>
              <li>
                <span>{t('items.sales_account')}</span>
                <span>{row.salesAccount ?? t('none')}</span>
              </li>
              <li>
                <span>{t('items.purchase_account')}</span>
                <span>{row.purchaseAccount ?? t('none')}</span>
              </li>
              <li>
                <span>{t('items.inventory_account')}</span>
                <span>{row.inventoryAccount ?? t('none')}</span>
              </li>
              <li>
                <span>{t('items.cogs_account')}</span>
                <span>{row.cogsAccount ?? t('none')}</span>
              </li>
              <li>
                <span>{t('items.warranty_months')}</span>
                <span>{row.warrantyMonths ?? t('none')}</span>
              </li>
            </ul>
          </Panel>

          {/* What is actually on the shelf. Not stored on the item — summed
              from the stock movements, so it cannot disagree with them. */}
          {row.isStock ? (
            <Panel title={t('items.stock_title')}>
              {row.stock.length === 0 ? (
                <p className="muted">{t('items.no_stock')}</p>
              ) : (
                <ul className={s.profileFacts}>
                  {row.stock.map((line) => (
                    <li key={line.warehouseCode}>
                      <span>
                        {line.warehouseCode}
                        {line.warehouseName ? ` · ${line.warehouseName}` : ''}
                      </span>
                      <span>
                        <bdi dir="ltr">{formatQuantity(BigInt(line.onHand))}</bdi> {row.baseUomCode}
                        {BigInt(line.reserved) > 0n ? (
                          <span className="muted">
                            {' '}
                            ({t('items.reserved', { quantity: formatQuantity(BigInt(line.reserved)) })})
                          </span>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className={s.sectionHint}>{t('items.stock_hint')}</p>
            </Panel>
          ) : null}

          {mayAdminister ? (
            <Panel title={row.active ? t('items.deactivate_title') : t('reactivate')}>
              {row.active ? (
                <ReasonForm
                  action={setItemActive}
                  hidden={{ code: row.code }}
                  label={t('deactivate')}
                  reasonLabel={t('reason')}
                  reasonPlaceholder={t('reason_placeholder')}
                />
              ) : (
                <ActionButton
                  action={setItemActive}
                  hidden={{ code: row.code, active: '1' }}
                  label={t('reactivate')}
                  small={false}
                  tone="primary"
                />
              )}
            </Panel>
          ) : null}
        </div>

        <div className={s.profileStack}>
          {/* Requirement 4 — one or more suppliers, one of them the default. */}
          <Panel title={t('items.suppliers_title', { count: row.suppliers.length })}>
            {row.suppliers.length === 0 ? (
              <p className="muted">{t('items.no_suppliers')}</p>
            ) : (
              <div className="table-wrap">
                <table className="list">
                  <thead>
                    <tr>
                      <th scope="col">{t('items.supplier')}</th>
                      <th scope="col">{t('items.supplier_item_code')}</th>
                      <th scope="col">{t('items.is_default')}</th>
                      {mayEdit ? <th scope="col">{t('actions')}</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {row.suppliers.map((supplier) => (
                      <tr key={supplier.supplierId}>
                        <td>
                          <Link
                            href={`/master-data/business-partners/${encodeURIComponent(supplier.supplierCode)}`}
                          >
                            {supplier.supplierCode}
                          </Link>{' '}
                          · {supplier.supplierName}
                        </td>
                        <td>{supplier.supplierItemCode ?? t('none')}</td>
                        <td>
                          {supplier.isDefault ? (
                            <Pill label={t('items.default')} on />
                          ) : mayEdit ? (
                            <ActionButton
                              action={makeDefaultSupplier}
                              hidden={{
                                code: row.code,
                                supplierId: supplier.supplierId,
                                supplierItemCode: supplier.supplierItemCode ?? '',
                              }}
                              label={t('items.make_default')}
                            />
                          ) : (
                            '—'
                          )}
                        </td>
                        {mayEdit ? (
                          <td>
                            <ActionButton
                              action={unlinkItemSupplier}
                              hidden={{ code: row.code, supplierId: supplier.supplierId }}
                              label={t('items.unlink')}
                            />
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {mayEdit ? (
              linkable.length === 0 ? (
                <p className={s.sectionHint}>{t('items.no_more_suppliers')}</p>
              ) : (
                <Form action={linkItemSupplier}>
                  <Hidden name="code" value={row.code} />
                  <Grid>
                    <Select
                      label={t('items.add_supplier')}
                      name="supplierId"
                      options={linkable.map((supplier) => ({
                        value: supplier.id,
                        label: `${supplier.code} · ${supplier.name}`,
                      }))}
                      required
                    />
                    <Field
                      hint={t('items.supplier_item_code_hint')}
                      label={t('items.supplier_item_code')}
                      name="supplierItemCode"
                    />
                  </Grid>
                  <SubmitRow>
                    <Submit label={t('items.link_supplier')} />
                  </SubmitRow>
                </Form>
              )
            ) : null}
          </Panel>

          {mayEdit ? (
            <Panel title={t('update')}>
              <Form action={updateItem}>
                <input name="code" type="hidden" value={row.code} />
                <Grid>
                  <Field
                    defaultValue={row.name}
                    label={t('name')}
                    name="name"
                    required
                    requiredLabel={t('required_hint')}
                  />
                  <Select
                    defaultValue={row.isStock ? 'stock' : 'service'}
                    hint={t('items.kind_hint')}
                    label={t('items.kind')}
                    name="isStock"
                    options={[
                      { value: 'stock', label: t('items.kind_stock') },
                      { value: 'service', label: t('items.kind_service') },
                    ]}
                  />
                  <Select
                    defaultValue={row.baseUomCode}
                    label={t('items.base_uom')}
                    name="baseUomCode"
                    options={units.map((u) => ({ value: u.code, label: `${u.code} · ${u.name}` }))}
                    required
                  />
                  <Select
                    defaultValue={row.tracking ?? 'batch'}
                    hint={t('items.tracking_hint')}
                    label={t('items.tracking')}
                    name="tracking"
                    options={items.ITEM_TRACKING.map((value) => ({
                      value,
                      label: t(`items.tracking_${value}`),
                    }))}
                  />
                  <Select
                    defaultValue={row.category ?? ''}
                    emptyLabel={t('items.no_category')}
                    label={t('items.category')}
                    name="category"
                    options={categories.map((c) => ({ value: c, label: c }))}
                  />
                  <Field
                    hint={t('items.new_category_hint')}
                    label={t('items.new_category')}
                    name="newCategory"
                  />
                  <Select
                    defaultValue={row.salesAccountId ?? ''}
                    emptyLabel={t('items.account_by_rule')}
                    hint={t('items.sales_account_hint')}
                    label={t('items.sales_account')}
                    name="salesAccountId"
                    options={revenue.map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` }))}
                  />
                  <Select
                    defaultValue={row.purchaseAccountId ?? ''}
                    emptyLabel={t('items.account_by_rule')}
                    hint={t('items.purchase_account_hint')}
                    label={t('items.purchase_account')}
                    name="purchaseAccountId"
                    options={expense.map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` }))}
                  />
                  <Select
                    defaultValue={row.inventoryAccountId ?? ''}
                    emptyLabel={t('items.account_by_rule')}
                    hint={t('items.inventory_account_hint')}
                    label={t('items.inventory_account')}
                    name="inventoryAccountId"
                    options={asset.map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` }))}
                  />
                  <Select
                    defaultValue={row.cogsAccountId ?? ''}
                    emptyLabel={t('items.account_by_rule')}
                    hint={t('items.cogs_account_hint')}
                    label={t('items.cogs_account')}
                    name="cogsAccountId"
                    options={expense.map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` }))}
                  />
                  <Field
                    defaultValue={row.warrantyMonths === null ? '' : String(row.warrantyMonths)}
                    hint={t('items.warranty_hint')}
                    label={t('items.warranty_months')}
                    min={0}
                    name="warrantyMonths"
                    type="number"
                  />
                  <Field
                    defaultValue={row.description}
                    label={column('description')}
                    name="description"
                    type="textarea"
                    wide
                  />
                </Grid>
                <SubmitRow>
                  <Submit label={t('save')} />
                </SubmitRow>
              </Form>
            </Panel>
          ) : null}

          <RecordHistory objectId={row.code} objectType={items.PERMISSION_OBJECT} />
        </div>
      </div>
    </AdminPage>
  );
}
