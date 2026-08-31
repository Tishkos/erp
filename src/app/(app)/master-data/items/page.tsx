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
import { AutoCode } from '@/components/admin/auto-code';
import { SectionTabs } from '@/components/admin/section-tabs';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import { formatQuantity } from '@domain/uom';
import * as items from '@/server/services/items';
import * as uom from '@/server/services/units-of-measure';
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
  if (!visibleRoute('/master-data/items')) notFound();

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

  const { rows, units, categories } = await withCurrentUser(async (tx) => ({
    rows: await items.listAll(tx),
    units: mayCreate ? await uom.listActive(tx) : [],
    categories: mayCreate ? await items.categories(tx) : [],
  }));
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
            <AutoCode codeId="f-code" mode="upper" nameId="f-name" />
            <Form action={createItem}>
              <Grid>
                <Field hint={t('code_auto_hint')} label={t('code')} name="code" />
                <Field label={t('name')} name="name" required requiredLabel={t('required_hint')} />
                <Select
                  defaultValue="stock"
                  hint={t('items.kind_hint')}
                  label={t('items.kind')}
                  name="isStock"
                  options={[
                    { value: 'stock', label: t('items.kind_stock') },
                    { value: 'service', label: t('items.kind_service') },
                  ]}
                />
                <Select
                  label={t('items.base_uom')}
                  name="baseUomCode"
                  options={units.map((u) => ({ value: u.code, label: `${u.code} · ${u.name}` }))}
                  required
                />
                {/* §9.3 — a stock item must track serials, batches or both.
                    A service tracks nothing, and the service ignores this. */}
                <Select
                  defaultValue="batch"
                  hint={t('items.tracking_hint')}
                  label={t('items.tracking')}
                  name="tracking"
                  options={items.ITEM_TRACKING.map((value) => ({
                    value,
                    label: t(`items.tracking_${value}`),
                  }))}
                />
                <Select
                  emptyLabel={t('items.no_category')}
                  label={t('items.category')}
                  name="category"
                  options={categories.map((c) => ({ value: c, label: c }))}
                />
                <Field hint={t('items.new_category_hint')} label={t('items.new_category')} name="newCategory" />
              </Grid>
              <SubmitRow>
                <Submit label={t('create')} />
              </SubmitRow>
            </Form>
          </NewRecordDialog>
        ) : null
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/master-data/items" />}
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
          clearHref="/master-data/items"
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
                <th scope="col">{t('items.category')}</th>
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
                  <td colSpan={8}>{t('items.none')}</td>
                </tr>
              ) : null}
              {shown.map((row) => (
                <tr key={row.code}>
                  <td>
                    <Link href={`/master-data/items/${encodeURIComponent(row.code)}`}>{row.code}</Link>
                  </td>
                  <td>{row.name}</td>
                  <td>{row.category ?? t('none')}</td>
                  <td>{row.isStock ? t('items.kind_stock') : t('items.kind_service')}</td>
                  <td>{row.baseUomCode}</td>
                  {/* A service has no stock, so a figure here would be a lie
                      rather than a zero. */}
                  <td>
                    {row.isStock ? (
                      <bdi dir="ltr">{formatQuantity(BigInt(row.onHand))}</bdi>
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
