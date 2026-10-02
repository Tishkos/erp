import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Package } from 'lucide-react';
import { Panel } from '@/components/ui';
import {
  ActionButton,
  AdminPage,
  Checkbox,
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
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import { formatQuantity, parseQuantity } from '@domain/uom';
import { formatMoney, type Locale } from '@/i18n/config';
import * as coa from '@/server/services/chart-of-accounts';
import * as items from '@/server/services/items';
import * as itemUnits from '@/server/services/item-units';
import * as uomService from '@/server/services/units-of-measure';
import {
  addItemUnit,
  deactivateItemUnit,
  linkItemSupplier,
  makeDefaultSupplier,
  setItemUnitDefault,
  setItemActive,
  setItemSellingPrice,
  setItemSupplierPrice,
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
  if (!visibleRoute('/inventory/items')) notFound();

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
        accounts: mayEdit ? await coa.postableAccounts(tx) : [],
        suppliers: mayEdit ? await items.selectableSuppliers(tx) : [],
        // REQ-FIX-001 FIX-4 — the units it is bought and sold in.
        units: await itemUnits.unitsOf(tx, code),
        uoms: mayEdit ? await uomService.listActive(tx) : [],
      };
    } catch (error) {
      if (error instanceof AdminNotFoundError) return null;
      throw error;
    }
  });
  if (!data) notFound();
  const { row, accounts, suppliers, units, uoms } = data;
  const kept = new Set(units.filter((unit) => unit.active).map((unit) => unit.uomCode));
  const addable = uoms.filter((uom) => !kept.has(uom.code));

  const revenue = accounts.filter((a) => a.accountType === 'revenue');
  const expense = accounts.filter((a) => a.accountType === 'expense');
  const asset = accounts.filter((a) => a.accountType === 'asset');
  const linkedIds = new Set(row.suppliers.map((supplier) => supplier.supplierId));
  const linkable = suppliers.filter((supplier) => !linkedIds.has(supplier.id));

  return (
    <AdminPage
      actions={<AuditLogButton label={t('history')} />}
      back={{ href: '/inventory/items', label: t('back') }}
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
                <span>{t('items.sales_account')}</span>
                <span>{row.salesAccount ?? t('none')}</span>
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
                <span>{t('items.selling_price')}</span>
                <span>
                  {row.sellingPriceIqd === null
                    ? t('none')
                    : formatMoney(row.sellingPriceIqd, 'IQD', locale as Locale)}
                </span>
              </li>
            </ul>
          </Panel>

          {mayEdit ? (
            <Panel title={t('items.selling_price')}>
              <Form action={setItemSellingPrice}>
                <Hidden name="code" value={row.code} />
                <Field
                  defaultValue={row.sellingPriceIqd ?? ''}
                  hint={t('items.prices_hint')}
                  label={t('items.selling_price')}
                  min={0}
                  name="price"
                  step="0.0001"
                  type="number"
                />
                <SubmitRow>
                  <Submit label={t('save')} />
                </SubmitRow>
              </Form>
            </Panel>
          ) : null}

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
                        <bdi dir="ltr">{formatQuantity(parseQuantity(line.onHand))}</bdi>{' '}
                        {row.baseUomCode}
                        {parseQuantity(line.reserved) > 0n ? (
                          <span className="muted">
                            {' '}
                            (
                            {t('items.reserved', {
                              quantity: formatQuantity(parseQuantity(line.reserved)),
                            })}
                            )
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
                      <th scope="col">{t('items.purchase_price')}</th>
                      <th scope="col">{t('items.is_default')}</th>
                      {mayEdit ? <th scope="col">{t('actions')}</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {row.suppliers.map((supplier) => (
                      <tr key={supplier.supplierId}>
                        <td>
                          <Link
                            href={`/payables/suppliers/${encodeURIComponent(supplier.supplierCode)}?role=supplier`}
                          >
                            {supplier.supplierCode}
                          </Link>{' '}
                          · {supplier.supplierName}
                        </td>
                        <td>{supplier.supplierItemCode ?? t('none')}</td>
                        <td>
                          {mayEdit ? (
                            <Form action={setItemSupplierPrice}>
                              <Hidden name="code" value={row.code} />
                              <Hidden name="supplierId" value={supplier.supplierId} />
                              <Field
                                defaultValue={supplier.purchasePriceIqd ?? ''}
                                label={t('items.purchase_price')}
                                min={0}
                                name="price"
                                step="0.0001"
                                type="number"
                              />
                              <Submit label={t('save')} />
                            </Form>
                          ) : supplier.purchasePriceIqd === null ? (
                            t('none')
                          ) : (
                            formatMoney(supplier.purchasePriceIqd, 'IQD', locale as Locale)
                          )}
                        </td>
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

          {/* REQ-FIX-001 FIX-4 — the units it is bought and sold in, each a
              share of the base unit its stock is counted in. */}
          <Panel
            title={t('items.units_title', { count: units.filter((unit) => unit.active).length })}
          >
            <div className="table-wrap">
              <table className="list">
                <thead>
                  <tr>
                    <th scope="col">{t('items.unit')}</th>
                    <th scope="col">{t('items.unit_holds')}</th>
                    <th scope="col">{t('items.unit_purchase_default')}</th>
                    <th scope="col">{t('items.unit_sales_default')}</th>
                    {mayEdit ? <th scope="col">{t('actions')}</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {units.map((unit) => (
                    <tr key={unit.uomCode}>
                      <td>
                        <bdi dir="ltr">{unit.uomCode}</bdi> · {unit.uomName}
                        {unit.isBase ? <Pill label={t('items.base_unit')} on /> : null}
                        {unit.active ? null : <Pill label={t('inactive')} on={false} />}
                      </td>
                      <td>
                        <bdi dir="ltr">
                          1 {unit.uomCode} ={' '}
                          {itemUnits.formatFraction(unit.numerator, unit.denominator)}{' '}
                          {row.baseUomCode}
                        </bdi>
                      </td>
                      <td>
                        {unit.isPurchaseDefault ||
                        (unit.isBase &&
                          !units.some((other) => other.active && other.isPurchaseDefault)) ? (
                          <Pill label={t('items.default')} on />
                        ) : mayEdit && unit.active ? (
                          <ActionButton
                            action={setItemUnitDefault}
                            hidden={{ code: row.code, uomCode: unit.uomCode, kind: 'purchase' }}
                            label={t('items.make_default')}
                          />
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        {unit.isSalesDefault ||
                        (unit.isBase &&
                          !units.some((other) => other.active && other.isSalesDefault)) ? (
                          <Pill label={t('items.default')} on />
                        ) : mayEdit && unit.active ? (
                          <ActionButton
                            action={setItemUnitDefault}
                            hidden={{ code: row.code, uomCode: unit.uomCode, kind: 'sales' }}
                            label={t('items.make_default')}
                          />
                        ) : (
                          '—'
                        )}
                      </td>
                      {mayEdit ? (
                        <td>
                          {unit.isBase || !unit.active ? (
                            unit.deactivatedReason ? (
                              <bdi dir="auto">{unit.deactivatedReason}</bdi>
                            ) : (
                              '—'
                            )
                          ) : (
                            <ReasonForm
                              action={deactivateItemUnit}
                              hidden={{ code: row.code, uomCode: unit.uomCode }}
                              label={t('deactivate')}
                              reasonLabel={t('reason')}
                              reasonPlaceholder={t('reason_placeholder')}
                            />
                          )}
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className={s.sectionHint}>{t('items.units_hint', { base: row.baseUomCode })}</p>

            {mayEdit && addable.length > 0 ? (
              <Form action={addItemUnit}>
                <Hidden name="code" value={row.code} />
                <Grid>
                  <Select
                    label={t('items.add_unit')}
                    name="uomCode"
                    options={addable.map((uom) => ({
                      value: uom.code,
                      label: `${uom.code} · ${uom.name}`,
                    }))}
                    required
                  />
                  <Field
                    hint={t('items.unit_holds_hint', { base: row.baseUomCode })}
                    label={t('items.unit_holds')}
                    name="baseQuantity"
                    required
                  />
                  <Field label={t('items.unit_barcode')} name="barcode" />
                </Grid>
                <Checkbox label={t('items.unit_purchase_default')} name="purchaseDefault" />
                <Checkbox label={t('items.unit_sales_default')} name="salesDefault" />
                <SubmitRow>
                  <Submit label={t('items.add_unit')} />
                </SubmitRow>
              </Form>
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
                  {/* Not block 1's fields, so not on the screen — and carried
                      through a save, so what is stored is not wiped by its
                      absence. */}
                  <input name="isStock" type="hidden" value={row.isStock ? 'stock' : 'service'} />
                  <input name="baseUomCode" type="hidden" value={row.baseUomCode} />
                  <input name="tracking" type="hidden" value={row.tracking ?? ''} />
                  <input
                    name="purchaseAccountId"
                    type="hidden"
                    value={row.purchaseAccountId ?? ''}
                  />
                  <input
                    name="warrantyMonths"
                    type="hidden"
                    value={row.warrantyMonths === null ? '' : String(row.warrantyMonths)}
                  />
                  <input name="description" type="hidden" value={row.description ?? ''} />
                  {/* Block 1's fields are the code, the name, the suppliers
                      and the three accounts. The category is none of them, so
                      it is off the screen — and carried through a save, so
                      what is already stored is not wiped by its absence. */}
                  <input name="category" type="hidden" value={row.category ?? ''} />
                  <Select
                    defaultValue={row.salesAccountId ?? ''}
                    emptyLabel={t('items.account_by_rule')}
                    hint={t('items.sales_account_hint')}
                    label={t('items.sales_account')}
                    name="salesAccountId"
                    options={revenue.map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` }))}
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
