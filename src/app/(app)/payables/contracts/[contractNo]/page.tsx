import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import {
  AdminPage,
  Field,
  Flash,
  Form,
  Hidden,
  KeyValue,
  Submit,
  SubmitRow,
  admin as s,
} from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as contracts from '@/server/services/recurring-contracts';
import * as partners from '@/server/services/partners';
import { paymentState } from '@/server/services/expenses';
import { amendContract, approveContract, endContract, generatePeriodsNow } from '../actions';

/**
 * The contract record — REQ-AP-001 §10.3 / §21.4.
 *
 * The terms up top; underneath, the two histories the contract owns: the
 * periods it has raised (each an ordinary payable) and the dated amendments
 * that changed the rent. Amendments reach future periods only; nothing here
 * rewrites a generated payable.
 */
export const dynamic = 'force-dynamic';

export default async function ContractPage({
  params,
  searchParams,
}: {
  params: Promise<{ contractNo: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/payables/contracts')) notFound();

  const { contractNo } = await params;
  const [t, expenseText, page, locale, context, outcome] = await Promise.all([
    getTranslations('admin.payables_contracts'),
    getTranslations('admin.expenses'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);

  const { principal } = context;
  if (!can(principal, 'view', contracts.PERMISSION_OBJECT)) {
    return <Denied object={page('recurring_contracts')} />;
  }
  const mayApprove = can(principal, 'approve', contracts.PERMISSION_OBJECT);
  const mayEdit = can(principal, 'edit_draft', contracts.PERMISSION_OBJECT);
  const mayEnd = can(principal, 'reverse_cancel', contracts.PERMISSION_OBJECT);

  const found = await withCurrentUser(async (tx) => {
    try {
      const view = await contracts.view(tx, contractNo);
      const supplier = await partners.loadPartner(tx, view.contract.supplierId);
      return { ...view, supplier };
    } catch {
      return null;
    }
  });
  if (!found) notFound();
  const { contract, periods, amendments, supplier } = found;

  const today = new Date().toISOString().slice(0, 10);
  const money = (amount: string, currency = contract.currency) =>
    formatMoney(amount, currency, locale as Locale);
  const day = (value: string | Date | null) =>
    value ? formatBusinessDate(new Date(value).toISOString().slice(0, 10), locale as Locale) : '—';

  return (
    <AdminPage
      back={{ href: '/payables/contracts', label: t('title') }}
      subtitle={`${supplier?.legalName ?? ''} · ${t(contract.frequency)}`}
      title={contract.contractNo}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <section aria-labelledby="contract-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="contract-title">
            <span>{t('record_title')}</span>
            <span className={s.sapTitleMeta}>
              <span
                className="status"
                data-status={
                  contract.status === 'active'
                    ? 'approved'
                    : contract.status === 'draft'
                      ? 'draft'
                      : 'cancelled'
                }
              >
                {t(`status_${contract.status}`)}
              </span>
            </span>
          </h2>

          <KeyValue
            rows={[
              { label: t('supplier'), value: supplier?.legalName ?? '—' },
              { label: t('department'), value: contract.departmentCode },
              { label: t('category'), value: contract.expenseCategoryCode },
              {
                label: t('amount'),
                value: `${money(contract.amountPerPeriodTxn)} / ${t(contract.frequency)}`,
              },
              { label: t('start_date'), value: day(contract.startDate) },
              { label: t('end_date'), value: day(contract.endDate) },
              { label: t('due_rule'), value: contract.dueRule },
              {
                label: t('generate_days_ahead'),
                value: String(contract.generateDaysAhead),
              },
              { label: t('auto_confirm'), value: contract.autoConfirm ? t('yes') : t('no') },
              { label: t('invoice_expected'), value: contract.invoiceExpected ? t('yes') : t('no') },
              { label: t('description'), value: contract.description },
              ...(contract.endReason
                ? [{ label: t('end_reason'), value: contract.endReason }]
                : []),
            ]}
          />

          <div className={s.sapFootActions}>
            {mayApprove && contract.status === 'draft' ? (
              <Form action={approveContract}>
                <Hidden name="contract_id" value={contract.id} />
                <Hidden name="contract_no" value={contract.contractNo} />
                <Submit label={t('approve')} small />
              </Form>
            ) : null}
            {mayEdit && contract.status === 'active' ? (
              <Form action={generatePeriodsNow}>
                <Hidden name="contract_no" value={contract.contractNo} />
                <Submit label={t('generate_now')} small />
              </Form>
            ) : null}
          </div>

          {mayEdit && contract.status === 'active' ? (
            <details>
              <summary>{t('amend')}</summary>
              <Form action={amendContract}>
                <Hidden name="contract_id" value={contract.id} />
                <Hidden name="contract_no" value={contract.contractNo} />
                <Field label={t('effective_from')} name="effective_from" required type="date" />
                <Field hint={t('amend_amount_hint')} label={t('amount')} name="amount" />
                <Field label={t('amend_note')} name="note" required />
                <SubmitRow>
                  <Submit label={t('amend_save')} small />
                </SubmitRow>
              </Form>
            </details>
          ) : null}
          {mayEnd && contract.status === 'active' ? (
            <details>
              <summary>{t('end')}</summary>
              <Form action={endContract}>
                <Hidden name="contract_id" value={contract.id} />
                <Hidden name="contract_no" value={contract.contractNo} />
                <Field label={t('end_date')} name="end_date" required type="date" />
                <Field label={t('end_reason')} name="reason" required />
                <SubmitRow>
                  <Submit label={t('end_save')} small tone="danger" />
                </SubmitRow>
              </Form>
            </details>
          ) : null}
        </div>
      </section>

      {/* ── The periods it has raised ─────────────────────────────────── */}
      <section aria-labelledby="periods-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="periods-title">
            <span>{t('periods')}</span>
            <span className={s.sapTitleMeta}>{t('rows', { count: periods.length })}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{t('col_period')}</th>
                  <th scope="col">{t('col_payable')}</th>
                  <th scope="col">{t('col_due')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('col_amount')}
                  </th>
                  <th scope="col">{t('col_stage')}</th>
                </tr>
              </thead>
              <tbody>
                {periods.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={5}>
                      {t('no_periods')}
                    </td>
                  </tr>
                ) : null}
                {periods.map((period) => (
                  <tr key={period.id}>
                    <td>
                      <bdi dir="ltr">
                        {day(period.periodStart)} – {day(period.periodEnd)}
                      </bdi>
                    </td>
                    <td>
                      <Link
                        className={s.sapLink}
                        href={`/payables/invoices/${encodeURIComponent(period.invoiceNo)}`}
                      >
                        <bdi dir="ltr">{period.invoiceNo}</bdi>
                      </Link>
                    </td>
                    <td>
                      <bdi dir="ltr">{day(period.dueDate)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(period.totalIqd, 'IQD')}</bdi>
                    </td>
                    <td>
                      {(() => {
                        const state = paymentState(period, today);
                        const tone =
                          state === 'paid' ? 'settled' : state === 'overdue' ? 'rejected' : 'submitted';
                        return (
                          <span className={`status status--${tone}`} data-status={tone}>
                            {expenseText(`state_${state}`)}
                          </span>
                        );
                      })()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ── The dated amendments (R3 — append-only) ───────────────────── */}
      <section aria-labelledby="amendments-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="amendments-title">
            <span>{t('amendments')}</span>
            <span className={s.sapTitleMeta}>{t('rows', { count: amendments.length })}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{t('col_effective_from')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('col_amount')}
                  </th>
                  <th scope="col">{t('col_note')}</th>
                  <th scope="col">{t('col_recorded')}</th>
                </tr>
              </thead>
              <tbody>
                {amendments.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={4}>
                      {t('no_amendments')}
                    </td>
                  </tr>
                ) : null}
                {amendments.map((amendment) => (
                  <tr key={amendment.id}>
                    <td>
                      <bdi dir="ltr">{day(amendment.effectiveFrom)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">
                        {amendment.amountPerPeriodTxn ? money(amendment.amountPerPeriodTxn) : '—'}
                      </bdi>
                    </td>
                    <td>{amendment.note}</td>
                    <td>
                      <bdi dir="ltr">{day(amendment.createdAt)}</bdi>
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
