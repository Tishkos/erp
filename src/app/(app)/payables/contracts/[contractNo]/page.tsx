import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import {
  AdminPage,
  Field,
  Flash,
  Form,
  Hidden,
  Submit,
  SubmitRow,
  admin as s,
} from '@/components/admin';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { ProfileLink } from '@/components/admin/profile-link';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as contracts from '@/server/services/recurring-contracts';
import * as partners from '@/server/services/partners';
import { paymentState } from '@/server/services/expenses';
import { amendContract, approveContract, endContract, generatePeriodsNow } from '../actions';
import { businessDateOf, businessToday } from '@/server/domain/business-date';
import { isNotFoundError } from '@/server/not-found';
import { PurchaseDoors, readDoors } from '../../record-doors';

/**
 * The contract record — REQ-AP-001 §10.3 / §21.4, on the Journal Entry's
 * window (REQ-PAY-001 PAY3, 2026-10-04): the terms as its fields, the
 * supplier and the department as links, the four doors in its title bar from
 * the draft on, the periods it has raised (each an ordinary purchase invoice)
 * as its lines; underneath, the dated amendments that changed the rent and
 * the forms that amend or end it. Amendments reach future periods only;
 * nothing here rewrites a generated invoice.
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

  const { contractNo: rawContractNo } = await params;
  const contractNo = decodeURIComponent(rawContractNo);
  const [t, admin, expenseText, page, column, locale, context, outcome] = await Promise.all([
    getTranslations('admin.payables_contracts'),
    getTranslations('admin'),
    getTranslations('admin.expenses'),
    getTranslations('page'),
    getTranslations('column'),
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
      return { ...view, supplier, doors: await readDoors(tx, principal, { object: contracts.PERMISSION_OBJECT, recordId: view.contract.id }) };
    } catch (error) {
      // E1 — a missing record is a 404; anything else reaches the error boundary.
      if (isNotFoundError(error)) return null;
      throw error;
    }
  });
  if (!found) notFound();
  const { contract, periods, amendments, supplier, doors } = found;
  const self = `/payables/contracts/${encodeURIComponent(contract.contractNo)}`;

  const today = businessToday();
  const money = (amount: string, currency = contract.currency) =>
    formatMoney(amount, currency, locale as Locale);
  const day = (value: string | Date | null) =>
    value ? formatBusinessDate(businessDateOf(new Date(value)), locale as Locale) : '—';
  const chip = contract.status === 'active' ? 'approved' : contract.status === 'draft' ? 'draft' : 'cancelled';

  const fields: DocumentField[] = [
    { label: t('col_no'), value: <bdi dir="ltr">{contract.contractNo}</bdi> },
    { label: column('status'), value: t(`status_${contract.status}`), status: chip },
    { label: column('supplier_code'), value: <ProfileLink code={supplier?.code} kind="supplier">{supplier?.code ?? '—'}</ProfileLink> },
    {
      label: column('supplier_name'),
      value: (
        <ProfileLink code={supplier?.code} dir="auto" kind="supplier">
          {supplier?.legalName ?? '—'}
        </ProfileLink>
      ),
    },
    { label: t('department'), value: <ProfileLink code={contract.departmentCode} kind="department" /> },
    { label: t('category'), value: <bdi dir="ltr">{contract.expenseCategoryCode}</bdi> },
    { label: t('amount'), value: <bdi dir="ltr">{`${money(contract.amountPerPeriodTxn)} / ${t(contract.frequency)}`}</bdi> },
    { label: t('start_date'), value: <bdi dir="ltr">{day(contract.startDate)}</bdi> },
    { label: t('end_date'), value: <bdi dir="ltr">{day(contract.endDate)}</bdi> },
    { label: t('due_rule'), value: <bdi dir="ltr">{contract.dueRule}</bdi> },
    { label: t('generate_days_ahead'), value: <bdi dir="ltr">{String(contract.generateDaysAhead)}</bdi> },
    { label: t('auto_confirm'), value: contract.autoConfirm ? t('yes') : t('no') },
    { label: t('invoice_expected'), value: contract.invoiceExpected ? t('yes') : t('no') },
    { label: column('branch_code'), value: <bdi dir="ltr">{contract.branchCode}</bdi> },
    { label: t('description'), value: <bdi dir="auto">{contract.description}</bdi>, wide: true },
    ...(contract.endReason ? [{ label: t('end_reason'), value: <bdi dir="auto">{contract.endReason}</bdi>, wide: true }] : []),
  ];

  return (
    <AdminPage
      back={{ href: '/payables/contracts', label: admin('back') }}
      title={contract.contractNo}
      trail={[{ href: '/', label: admin('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <DocumentWindow
        actions={
          <>
            {mayApprove && contract.status === 'draft' ? (
              <form action={approveContract}>
                <input name="contract_id" type="hidden" value={contract.id} />
                <input name="contract_no" type="hidden" value={contract.contractNo} />
                <Submit label={t('approve')} variant="document" />
              </form>
            ) : null}
            {mayEdit && contract.status === 'active' ? (
              <form action={generatePeriodsNow}>
                <input name="contract_no" type="hidden" value={contract.contractNo} />
                <Submit label={t('generate_now')} tone="secondary" variant="document" />
              </form>
            ) : null}
          </>
        }
        documentType={t('record_title')}
        fields={fields}
        id="contract-document"
        linesCount={periods.length}
        linesTitle={t('periods')}
        number={contract.contractNo}
        titleActions={
          <PurchaseDoors
            doors={doors}
            exportId={contract.contractNo}
            exportKey="recurring_contract"
            object={contracts.PERMISSION_OBJECT}
            recordId={contract.id}
            returnTo={self}
            title={`${t('record_title')} ${contract.contractNo}`}
          />
        }
        totals={[{ label: t('amount'), value: `${money(contract.amountPerPeriodTxn)} / ${t(contract.frequency)}` }]}
      >
        <table aria-labelledby="contract-document-lines-heading" className={s.sapTable}>
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
                <td className={s.sapAccountCell}>
                  <ProfileLink code={period.invoiceNo} kind="purchase_invoice" />
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
                    const tone = state === 'paid' ? 'settled' : state === 'overdue' ? 'rejected' : 'submitted';
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
      </DocumentWindow>

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
                    <td>
                      <bdi dir="auto">{amendment.note}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{day(amendment.createdAt)}</bdi>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
    </AdminPage>
  );
}
