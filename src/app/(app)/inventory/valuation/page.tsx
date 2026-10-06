import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, FilterRow, Flash, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import type { SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { ExportMenu } from '@/components/print/export-menu';
import { ProfileLink } from '@/components/admin/profile-link';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatMoney, formatQuantity, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { businessToday } from '@/server/domain/business-date';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as availability from '@/server/services/availability';
import * as valuation from '@/server/services/inventory-valuation';

/**
 * Inventory Valuation — IMPROVEMENT-002: the FIFO position at a date, exact,
 * beside the General Ledger at the same date.
 *
 * The date decides what the figures are called: **Final** inside the unbroken
 * run of closed periods, **Provisional** after it, a future date refused. An
 * issue dated before the receipt it drew from makes a range impossible: the
 * line is flagged and shown as the ledger has it, never corrected. Per
 * inventory account, the layers' value against the account's posted balance
 * at the date; the known reconciling items are listed in the requirement.
 * Costing method: FIFO. Every figure is an exact decimal.
 */
export const dynamic = 'force-dynamic';

export default async function InventoryValuationPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/inventory/valuation')) notFound();

  const [t, admin, page, column, locale, context, params] = await Promise.all([
    getTranslations('admin.inventory_valuation'),
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    searchParams,
  ]);
  const { principal } = context;
  if (!can(principal, 'view', valuation.PERMISSION_OBJECT)) {
    return <Denied object={page('inventory_valuation')} />;
  }
  const one = (key: string) => (typeof params[key] === 'string' ? (params[key] as string).trim() : '');
  const asOf = one('as_of') || businessToday();
  const warehouseCode = one('warehouse') || null;
  const category = one('category') || null;
  const branchCode = one('branch') || null;

  const { result, refused, warehouses, categories, branches } = await withCurrentUser(async (tx) => {
    let found: valuation.HistoricalValuation | null = null;
    let why: string | null = null;
    try {
      found = await valuation.valuationAt(tx, principal, { asOf, warehouseCode, category, branchCode, allPermittedBranches: !branchCode });
    } catch (error) {
      if (error instanceof valuation.ValuationDateError) why = error.message;
      else throw error;
    }
    return {
      result: found,
      refused: why,
      warehouses: await availability.warehouses(tx, principal),
      categories: await availability.categories(tx, principal),
      branches: await availability.branches(tx, principal),
    };
  });
  const money = (value: string) => formatMoney(value, 'IQD', locale as Locale);
  const qty = (value: string) => formatQuantity(value, locale as Locale);
  const day = (value: string) => formatBusinessDate(value, locale as Locale);
  const statusChip = result ? (result.status === 'final' ? 'posted' : 'draft') : 'rejected';
  const statusText = result ? t(`status_${result.status}`) : t('status_refused');

  return (
    <AdminPage
      actions={result ? <ExportMenu exportKey="inventory_valuation" query={params} /> : undefined}
      back={{ href: '/', label: admin('dashboard_label') }}
      subtitle={t('subtitle')}
      tabs={<SectionTabs route="/inventory/valuation" />}
      title={page('inventory_valuation')}
      variant="sap"
    >
      {refused ? <Flash error={refused} errorTitle={admin('error_title')} saved={false} savedLabel={admin('saved')} /> : null}
      <form method="get">
        <FilterRow>
          <Field defaultValue={asOf} label={t('as_of')} name="as_of" required type="date" />
          <Select defaultValue={warehouseCode ?? ''} emptyLabel={t('all_warehouses')} label={column('warehouse')} name="warehouse" options={warehouses.map((w) => ({ value: w.code, label: `${w.code} · ${w.name}` }))} />
          <Select defaultValue={category ?? ''} emptyLabel={t('all_categories')} label={t('category')} name="category" options={categories.map((code) => ({ value: code, label: code }))} />
          <Select defaultValue={branchCode ?? ''} emptyLabel={t('all_branches')} label={column('branch_code')} name="branch" options={branches.map((b) => ({ value: b.code, label: `${b.code} · ${b.name}` }))} />
          <SubmitRow>
            <Submit label={t('run')} />
          </SubmitRow>
        </FilterRow>
      </form>

      <section aria-labelledby="valuation-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="valuation-title">
            <span>{t('position_at', { date: day(asOf) })}</span>
            <span className={s.sapTitleMeta}>
              <span className={`status status--${statusChip}`} data-status={statusChip}>
                {statusText}
              </span>
              {' · '}
              {t('costing_fifo')}
              {result?.finalThrough ? ` · ${t('final_through', { date: day(result.finalThrough) })}` : ''}
            </span>
          </h2>
          {result && result.status === 'provisional' ? <p className={`${s.sapNote} px-5 py-2.5`}>{t('provisional_note')}</p> : null}
          {result && result.flags.length > 0 ? (
            <p className={`${s.sapNote} px-5 py-2.5`}>
              {t('flagged_note', { count: result.flags.length })}
              {result.flags.map((flag) => (
                <span key={flag.layerId}>
                  {' '}
                  <bdi dir="auto">{flag.detail}</bdi>
                </span>
              ))}
            </p>
          ) : null}
          <div className={s.sapTableWrap}>
            <table aria-labelledby="valuation-title" className={`${s.sapTable} ${s.sapReportTable}`}>
              <thead>
                <tr>
                  <th scope="col">{column('item_code')}</th>
                  <th scope="col">{column('item_name')}</th>
                  <th scope="col">{t('category')}</th>
                  <th scope="col">{column('warehouse')}</th>
                  <th scope="col">{column('branch_code')}</th>
                  <th className={s.sapNum} scope="col">
                    {column('quantity')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('unit_cost')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('value')}
                  </th>
                  <th scope="col">{t('note')}</th>
                </tr>
              </thead>
              <tbody>
                {!result || result.lines.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={9}>
                      {t('none')}
                    </td>
                  </tr>
                ) : (
                  result.lines.map((line) => (
                    <tr key={`${line.itemCode}:${line.warehouseCode}:${line.branchCode}`}>
                      <td>
                        <ProfileLink code={line.itemCode} kind="item" />
                      </td>
                      <td>
                        <bdi dir="auto">{line.itemName}</bdi>
                      </td>
                      <td>
                        <bdi dir="auto">{line.category ?? '—'}</bdi>
                      </td>
                      <td>
                        <ProfileLink code={line.warehouseCode} kind="warehouse" name={line.warehouseName} />
                      </td>
                      <td>
                        <bdi dir="ltr">{line.branchCode}</bdi>
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{`${qty(line.quantity)} ${line.uomCode}`}</bdi>
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{money(line.unitCostIqd)}</bdi>
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{money(line.valueIqd)}</bdi>
                      </td>
                      <td>{line.flagged ? t('flagged') : line.isTransit ? t('in_transit') : '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
              {result && result.lines.length > 0 ? (
                <tfoot>
                  <tr className={s.sapTotalRow}>
                    <td colSpan={5}>{t('total')}</td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{qty(result.totalQuantity)}</bdi>
                    </td>
                    <td />
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(result.totalIqd)}</bdi>
                    </td>
                    <td />
                  </tr>
                </tfoot>
              ) : null}
            </table>
          </div>
        </div>
      </section>

      {result ? (
        <section aria-labelledby="valuation-gl-title" className={s.sapDoc}>
          <div className={s.sapWindow}>
            <h2 className={s.sapTitle} id="valuation-gl-title">
              <span>{t('against_gl')}</span>
              <span className={s.sapTitleMeta}>{t('gl_note')}</span>
            </h2>
            <div className={s.sapTableWrap}>
              <table aria-labelledby="valuation-gl-title" className={`${s.sapTable} ${s.sapReportTable}`}>
                <thead>
                  <tr>
                    <th scope="col">{t('account')}</th>
                    <th className={s.sapNum} scope="col">
                      {t('layers')}
                    </th>
                    <th className={s.sapNum} scope="col">
                      {t('gl_balance')}
                    </th>
                    <th className={s.sapNum} scope="col">
                      {t('difference')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {result.accounts.length === 0 ? (
                    <tr>
                      <td className={s.sapEmptyRow} colSpan={4}>
                        {t('no_accounts')}
                      </td>
                    </tr>
                  ) : (
                    result.accounts.map((account) => (
                      <tr key={account.accountId}>
                        <td>
                          <ProfileLink code={account.accountCode} kind="gl_account" name={account.accountName} />
                        </td>
                        <td className={s.sapNum}>
                          <bdi dir="ltr">{money(account.layersIqd)}</bdi>
                        </td>
                        <td className={s.sapNum}>
                          <bdi dir="ltr">{money(account.glIqd)}</bdi>
                        </td>
                        <td className={s.sapNum}>
                          <bdi dir="ltr">{money(account.differenceIqd)}</bdi>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
                {result.accounts.length > 0 ? (
                  <tfoot>
                    <tr className={s.sapTotalRow}>
                      <td>{t('total')}</td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{money(result.layersOnAccountsIqd)}</bdi>
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{money(result.glTotalIqd)}</bdi>
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{money(result.differenceIqd)}</bdi>
                      </td>
                    </tr>
                  </tfoot>
                ) : null}
              </table>
            </div>
          </div>
        </section>
      ) : null}
    </AdminPage>
  );
}
