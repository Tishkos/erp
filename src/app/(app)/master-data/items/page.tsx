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
  Hidden,
  ListToolbar,
  NewRecordDialog,
  Pill,
  Select,
  Submit,
  SubmitRow,
  admin as s,
  matches,
} from '@/components/admin';
import { SectionTabs } from '@/components/admin/section-tabs';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import { formatQuantity, parseQuantity } from '@domain/uom';
import * as items from '@/server/services/items';
import * as uomService from '@/server/services/units-of-measure';
import * as coa from '@/server/services/chart-of-accounts';
import { createItem, setItemCategoryAccounts } from './actions';

/**
 * Item master — Phase 2 requirement 4.
 *
 * "The same item record will be used later in Purchasing, Inventory and
 *  Sales", which is why the code is the identity and why the list leads with
 *  it. The supplier count says whether an item has been set up for purchasing
 *  at all — an item nobody sells us cannot be ordered.
 */
export const dynamic = 'force-dynamic';

export default async function ItemsPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/inventory/items')) notFound();

  const [t, page, column, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', items.PERMISSION_OBJECT)) {
    return <Denied object={page('items')} />;
  }
  const mayCreate = can(principal, 'create', items.PERMISSION_OBJECT);
  // 0423 — the default stock accounts are Finance's, set under `configure`.
  const mayConfigure = can(principal, 'configure', items.PERMISSION_OBJECT);
  const accountsWindow = (await searchParams).accounts === '1';

  const { rows, accounts, uoms, suppliers, defaults } = await withCurrentUser(async (tx) => ({
    rows: await items.listAll(tx),
    accounts: mayCreate || mayConfigure ? await coa.postableAccounts(tx) : [],
    defaults: mayCreate || mayConfigure ? await items.categoryAccounts(tx) : null,
    // REQ-FIX-001 FIX-4 — the unit its stock is counted in is chosen, not assumed.
    uoms: mayCreate ? await uomService.listActive(tx) : [],
    // 0408 — who it is bought from, chosen as it is made (2026-10-06, by direction).
    suppliers: mayCreate ? await items.selectableSuppliers(tx) : [],
  }));
  const accountOptions = (type: string) =>
    accounts
      .filter((a) => a.accountType === type)
      .map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` }));
  const shown = rows.filter((row) => matches(row, outcome.q));
  const companyDefault = defaults?.rows.find((row) => row.category === null) ?? null;

  return (
    <AdminPage
      actions={
        <>
        {mayConfigure && defaults ? (
          <NewRecordDialog
            buttonLabel={t('items.category_accounts')}
            closeLabel={t('close')}
            openOnLoad={accountsWindow}
            quiet
            title={t('items.category_accounts')}
            wide
          >
            <p className="muted">{t('items.category_accounts_intro')}</p>
            {accountsWindow ? (
              <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />
            ) : null}
            <p>{t('items.category_accounts_lacking_total', { count: defaults.lackingTotal })}</p>
            <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
              <table className={`${s.sapTable} ${s.sapRegisterTable}`}>
                <thead>
                  <tr>
                    <th scope="col">{t('items.category_accounts_scope')}</th>
                    <th scope="col">{t('items.inventory_account')}</th>
                    <th scope="col">{t('items.cogs_account')}</th>
                    <th className={s.sapNum} scope="col">{t('items.category_accounts_lacking')}</th>
                  </tr>
                </thead>
                <tbody>
                  {defaults.rows.length === 0 ? (
                    <tr>
                      <td className={s.sapEmptyRow} colSpan={4}>
                        {t('items.category_accounts_none')}
                      </td>
                    </tr>
                  ) : null}
                  {defaults.rows.map((row) => (
                    <tr key={row.category ?? '*'}>
                      <td>{row.category === null ? t('items.category_accounts_company') : <bdi dir="auto">{row.category}</bdi>}</td>
                      <td>{row.inventoryAccount ? <bdi dir="ltr">{row.inventoryAccount}</bdi> : '—'}</td>
                      <td>{row.cogsAccount ? <bdi dir="ltr">{row.cogsAccount}</bdi> : '—'}</td>
                      <td className={s.sapNum}>
                        {row.category === null ? defaults.lackingTotal : (defaults.lacking[row.category] ?? 0)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {defaults.unset.length > 0 ? (
              <p className="muted">{t('items.category_accounts_unset', { list: defaults.unset.join(', ') })}</p>
            ) : null}
            <Form action={setItemCategoryAccounts}>
              <Grid>
                <Select
                  label={t('items.category_accounts_scope')}
                  name="categoryScope"
                  options={[
                    { value: '', label: t('items.category_accounts_company') },
                    ...[...new Set([...defaults.rows.map((row) => row.category), ...defaults.unset])]
                      .filter((category): category is string => Boolean(category))
                      .sort()
                      .map((category) => ({ value: category, label: category })),
                  ]}
                />
                <Select
                  emptyLabel=""
                  label={t('items.inventory_account')}
                  name="defaultInventoryAccountId"
                  options={accountOptions('asset')}
                />
                <Select
                  emptyLabel=""
                  label={t('items.cogs_account')}
                  name="defaultCogsAccountId"
                  options={accountOptions('expense')}
                />
              </Grid>
              <SubmitRow>
                <Submit label={t('items.category_accounts_save')} />
              </SubmitRow>
            </Form>
          </NewRecordDialog>
        ) : null}
        {mayCreate ? (
          <NewRecordDialog
            buttonLabel={t('items.new')}
            closeLabel={t('close')}
            openOnLoad={Boolean(outcome.error) && !accountsWindow}
            title={t('items.new')}
          >
            <p className="muted">{t('items.created_note')}</p>
            {/* No Code field, and no slug following the name into one. The
                system mints it (by direction, 2026-09-26): a code that can be
                typed is a code that can be typed twice. */}
            <Form action={createItem}>
              <Grid>
                {/* Block 1: Item Code (the system's), Item Full Name, Related
                    Supplier(s) — linked on the item once it exists — and the
                    three accounts. Nothing else is asked. A build item is a
                    stock item counted in each, identified by the invoice that
                    brought it in (its batch), so those are set, not asked. */}
                <Hidden name="isStock" value="stock" />
                <Hidden name="tracking" value="batch" />
                <Field
                  label={t('items.full_name')}
                  name="name"
                  required
                  requiredLabel={t('required_hint')}
                  wide
                />
                <Select
                  defaultValue={uoms.some((uom) => uom.code === 'EA') ? 'EA' : (uoms[0]?.code ?? '')}
                  hint={t('items.base_unit_hint')}
                  label={t('items.base_unit')}
                  name="baseUomCode"
                  options={uoms.map((uom) => ({ value: uom.code, label: `${uom.code} · ${uom.name}` }))}
                  required
                />
                <Select
                  defaultValue={companyDefault?.inventoryAccountId ?? undefined}
                  emptyLabel=""
                  label={t('items.inventory_account')}
                  name="inventoryAccountId"
                  options={accountOptions('asset')}
                  required
                />
                {/* Blank is a real answer here, as on the item's own page: the
                    sale then posts to the revenue mapping. Inventory and COGS
                    have no such fallback — a sale refuses an item without them —
                    so those two are required. */}
                <Select
                  emptyLabel={t('items.account_by_rule')}
                  label={t('items.sales_account')}
                  name="salesAccountId"
                  options={accountOptions('revenue')}
                />
                <Select
                  defaultValue={companyDefault?.cogsAccountId ?? undefined}
                  emptyLabel=""
                  label={t('items.cogs_account')}
                  name="cogsAccountId"
                  options={accountOptions('expense')}
                  required
                />
                {/* Block 1's "Related Supplier(s)" — since 0408 an item is
                    bought only from a supplier linked to it, so the link can
                    be made as the item is: one or more, the first its default. */}
                <Select
                  hint={t('items.new_suppliers_hint')}
                  label={t('items.new_suppliers')}
                  multiple
                  name="supplierIds"
                  options={suppliers.map((supplier) => ({
                    value: supplier.id,
                    label: `${supplier.code} · ${supplier.name}`,
                  }))}
                  size={Math.min(Math.max(suppliers.length, 2), 5)}
                />
              </Grid>
              <SubmitRow>
                <Submit label={t('create')} />
              </SubmitRow>
            </Form>
          </NewRecordDialog>
        ) : null}
        </>
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/inventory/items" />}
      subtitle={t('items.subtitle')}
      title={page('items')}
      variant="sap"
    >
      <Flash
        error={accountsWindow ? null : outcome.error}
        errorTitle={t('error_title')}
        saved={outcome.saved}
        savedLabel={t('saved')}
      />

      <Panel flush>
        <ListToolbar
          clearHref="/inventory/items"
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
                <th scope="col">{column('code')}</th>
                <th scope="col">{column('name')}</th>
                <th scope="col">{t('items.kind')}</th>
                <th scope="col">{t('items.base_uom')}</th>
                <th scope="col">{t('items.on_hand')}</th>
                <th scope="col">{t('items.supplier')}</th>
                <th scope="col">{column('active')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 ? (
                <tr>
                  <td colSpan={7}>{t('items.none')}</td>
                </tr>
              ) : null}
              {shown.map((row) => (
                <tr key={row.code}>
                  <td>
                    <Link href={`/inventory/items/${encodeURIComponent(row.code)}`}>{row.code}</Link>
                  </td>
                  <td>{row.name}</td>
                  <td>{row.isStock ? t('items.kind_stock') : t('items.kind_service')}</td>
                  <td>{row.baseUomCode}</td>
                  {/* A service has no stock, so a figure here would be a lie
                      rather than a zero. */}
                  <td>
                    {row.isStock ? (
                      <bdi dir="ltr">{formatQuantity(parseQuantity(row.onHand))}</bdi>
                    ) : (
                      '—'
                    )}
                  </td>
                  {/* Who it is bought from (0408) — the linked suppliers in use, the default first. */}
                  <td>
                    {row.supplierNames ? <bdi dir="auto">{row.supplierNames}</bdi> : <span className="muted">{t('none')}</span>}
                  </td>
                  <td>
                    <Pill label={row.active ? t('active') : t('inactive')} on={row.active} />
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
