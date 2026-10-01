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
import * as coa from '@/server/services/chart-of-accounts';
import { createItem } from './actions';

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

  const { rows, accounts } = await withCurrentUser(async (tx) => ({
    rows: await items.listAll(tx),
    accounts: mayCreate ? await coa.postableAccounts(tx) : [],
  }));
  const accountOptions = (type: string) =>
    accounts
      .filter((a) => a.accountType === type)
      .map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` }));
  const shown = rows.filter((row) => matches(row, outcome.q));

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <NewRecordDialog
            buttonLabel={t('items.new')}
            closeLabel={t('close')}
            openOnLoad={Boolean(outcome.error)}
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
                <Hidden name="baseUomCode" value="EA" />
                <Hidden name="tracking" value="batch" />
                <Field
                  label={t('items.full_name')}
                  name="name"
                  required
                  requiredLabel={t('required_hint')}
                  wide
                />
                <Select
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
                  emptyLabel=""
                  label={t('items.cogs_account')}
                  name="cogsAccountId"
                  options={accountOptions('expense')}
                  required
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
      tabs={<SectionTabs route="/inventory/items" />}
      subtitle={t('items.subtitle')}
      title={page('items')}
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
                <th scope="col">{t('items.suppliers')}</th>
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
                  <td>{row.supplierCount}</td>
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
