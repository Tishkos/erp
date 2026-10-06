import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, FilterRow, Flash, ListToolbar, Select, Submit, SubmitRow, admin as s, matches } from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { ProfileLink } from '@/components/admin/profile-link';
import { SectionTabs } from '@/components/admin/section-tabs';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { toDecimalString } from '@domain/money';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as balances from '@/server/services/supplier-balances';

/**
 * Supplier Credits — REQ-PAY-001 PAY10 (2026-10-04), the Purchase Invoices
 * register's shape. What the company holds with its suppliers, read from the
 * documents themselves (`supplier-balances.credits`, no balance table): a
 * payment not yet put against an invoice (an overpayment, a payment on
 * account), an advance paid and not yet applied, a posted credit note not yet
 * applied. Each document opens on its own record, where it is applied; the
 * per-supplier block at the top is the same rows summed, so the two cannot
 * disagree. Authorised on `supplier_payment` (D-PAY-6).
 */
export const dynamic = 'force-dynamic';

const KINDS = ['payment', 'advance', 'credit_note'] as const;
const RECORD_KIND = { payment: 'supplier_payment', advance: 'supplier_advance', credit_note: 'supplier_credit_note' } as const;

export default async function SupplierCreditsPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/payables/supplier-credits')) notFound();

  const [t, x, page, column, locale, context, outcome, params] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.supplier_credits'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    searchParams,
  ]);

  const { principal } = context;
  if (!can(principal, 'view', balances.CREDITS_OBJECT)) {
    return <Denied object={page('supplier_credits')} />;
  }

  const kindParam = typeof params.kind === 'string' && (KINDS as readonly string[]).includes(params.kind) ? (params.kind as balances.CreditKind) : null;
  const supplierParam = typeof params.supplier === 'string' ? params.supplier.trim() : '';

  const rows = await withCurrentUser((tx) => balances.credits(tx, principal, { supplierCode: supplierParam || null, kind: kindParam }));
  const shown = rows.filter((row) => matches({ ...row }, outcome.q));
  const totals = balances.creditTotals(shown);
  const held = totals.reduce((sum, row) => sum + row.totalIqd, 0n);

  const money = (amount: string | bigint) => formatMoney(typeof amount === 'bigint' ? toDecimalString(amount, 4n) : amount, 'IQD', locale as Locale);

  return (
    <AdminPage
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/payables/supplier-credits" />}
      subtitle={x('subtitle')}
      title={x('title')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <section aria-labelledby="supplier-credits-title" className={`${s.sapDoc} ${s.sapRegister} mb-5`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="supplier-credits-title">
            <span>{x('title')}</span>
            <span className={s.sapTitleMeta}>{t('rows_shown', { count: shown.length })}</span>
          </h2>

          <ListToolbar
            clearHref="/payables/supplier-credits"
            clearLabel={t('clear_search')}
            countLabel={t('rows_shown', { count: shown.length })}
            placeholder={t('search_placeholder')}
            q={outcome.q}
            searchLabel={t('search')}
          />

          <form className={s.filterBar} method="get">
            <FilterRow>
              <Select
                defaultValue={kindParam ?? ''}
                emptyLabel={x('all_kinds')}
                label={x('kind')}
                name="kind"
                options={KINDS.map((kind) => ({ value: kind, label: x(`kind_${kind}`) }))}
              />
              <Field defaultValue={supplierParam} hint={x('supplier_hint')} label={x('supplier')} name="supplier" />
              <SubmitRow>
                <Submit label={x('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="supplier-credits-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{x('kind')}</th>
                  <th scope="col">{x('col_document')}</th>
                  <th scope="col">{x('col_date')}</th>
                  <th scope="col">{column('supplier_code')}</th>
                  <th scope="col">{column('supplier_name')}</th>
                  <th scope="col">{column('branch_code')}</th>
                  <th className={s.sapNum} scope="col">
                    {x('col_amount')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('col_applied')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('col_unapplied')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={9}>
                      {x('none')}
                    </td>
                  </tr>
                ) : null}
                {shown.map((row) => (
                  <tr key={`${row.kind}-${row.documentNo}`}>
                    <td>{x(`kind_${row.kind}`)}</td>
                    <td>
                      <ProfileLink code={row.documentNo} kind={RECORD_KIND[row.kind]} />
                    </td>
                    <td>
                      <bdi dir="ltr">{formatBusinessDate(row.documentDate, locale as Locale)}</bdi>
                    </td>
                    <td>
                      <ProfileLink code={row.supplierCode} kind="supplier">
                        {row.supplierCode}
                      </ProfileLink>
                    </td>
                    <td>
                      <ProfileLink code={row.supplierCode} dir="auto" kind="supplier">
                        {row.supplierName}
                      </ProfileLink>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.branchCode}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.amountIqd)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.appliedIqd)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.unappliedIqd)}</bdi>
                    </td>
                  </tr>
                ))}
              </tbody>
              {shown.length > 0 ? (
                <tfoot>
                  <tr className={s.sapTotalRow}>
                    <td colSpan={8}>{x('total_unapplied')}</td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(held)}</bdi>
                    </td>
                  </tr>
                </tfoot>
              ) : null}
            </table>
          </div>
        </div>
      </section>

      {/* The same rows, by supplier — the supplier-statement manner. */}
      <section aria-labelledby="supplier-credits-by-supplier" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="supplier-credits-by-supplier">
            <span>{x('by_supplier')}</span>
            <span className={s.sapTitleMeta}>{t('rows_shown', { count: totals.length })}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{column('supplier_code')}</th>
                  <th scope="col">{column('supplier_name')}</th>
                  <th className={s.sapNum} scope="col">
                    {x('col_payments')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('col_advances')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('col_credit_notes')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('col_total')}
                  </th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {totals.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={7}>
                      {x('none')}
                    </td>
                  </tr>
                ) : null}
                {totals.map((row) => (
                  <tr key={row.supplierCode}>
                    <td>
                      <ProfileLink code={row.supplierCode} kind="supplier">
                        {row.supplierCode}
                      </ProfileLink>
                    </td>
                    <td>
                      <ProfileLink code={row.supplierCode} dir="auto" kind="supplier">
                        {row.supplierName}
                      </ProfileLink>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.paymentIqd)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.advanceIqd)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.creditNoteIqd)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.totalIqd)}</bdi>
                    </td>
                    <td>
                      <Link className={s.sapLink} href={`/payables/supplier-statements?code=${encodeURIComponent(row.supplierCode)}`}>
                        {x('open_statement')}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </AdminPage>
  );
}
