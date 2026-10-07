import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, Submit, admin as s } from '@/components/admin';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { ProfileLink } from '@/components/admin/profile-link';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { toDecimalString } from '@domain/money';
import { isNotFoundError } from '@/server/not-found';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as applications from '@/server/services/payment-applications';
import * as payables from '@/server/services/payables';
import { createApplication, startApplication } from '../actions';
import { IntentSelect } from '@/components/admin/intent-select';

export const dynamic = 'force-dynamic';

const LIST = '/payables/payment-applications';

/**
 * A payment application on a sheet of its own — by direction 2026-10-06
 * ("register PD and payment application, they should have their own sheet,
 * not switch us back to the import application … like invoicing").
 *
 * The request to the bank used to be a window on the import's page, and the
 * list's "New payment application" sent the accountant there. Now it is a
 * document page in the purchase invoice's style: the import is named first
 * (chosen here, or carried in `?import=` from the import's page), then the
 * money, the method, the account and the supplier's account. Create opens the
 * application's own record — never the import.
 */
export default async function NewPaymentApplicationPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute(LIST)) notFound();

  const [t, admin, page, locale, context, outcome, query] = await Promise.all([
    getTranslations('admin.payment_applications'),
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    searchParams,
  ]);
  const { principal } = context;
  if (!can(principal, 'create', applications.PERMISSION_OBJECT)) {
    return <Denied object={page('payment_applications')} />;
  }
  const chosen = typeof query.import === 'string' ? query.import.trim() : '';

  const found = await withCurrentUser(async (tx) => {
    const imports = await applications.payableImports(tx);
    if (!chosen) return { imports, owner: null, pickers: null, totals: null };
    try {
      const owner = await payables.view(tx, chosen);
      return {
        imports,
        owner,
        pickers: await applications.pickersFor(tx, owner.payable.id),
        totals: await applications.totalsFor(tx, owner.payable.id),
      };
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  });
  if (!found) notFound();

  const money = (amount: string, currency: string) => formatMoney(amount, currency, locale as Locale);
  const { owner, pickers, totals } = found;

  // Step one: which import. The import's own page skips it by naming the import in the address.
  if (!owner || !pickers || !totals) {
    const fields: DocumentField[] = [
      {
        label: t('import'),
        control: true,
        value: (
          <IntentSelect aria-label={t('import')} defaultValue="" name="payable_no" required>
            <option value="" />
            {found.imports.map((row) => (
              <option key={row.payableNo} value={row.payableNo}>
                {`${row.payableNo} · ${row.reference} · ${row.supplierName}`}
              </option>
            ))}
          </IntentSelect>
        ),
      },
    ];
    return (
      <AdminPage back={{ href: LIST, label: admin('back') }} tabs={<SectionTabs route={LIST} />} title={t('new')} trail={[{ href: '/', label: admin('dashboard_label') }]} variant="sap">
        <Flash error={outcome.error} errorTitle={admin('error_title')} saved={false} savedLabel="" />
        <form action={startApplication}>
          <DocumentWindow actions={<Submit label={t('continue')} variant="document" />} documentType={page('payment_applications')} fields={fields} id="payapp-start" linesTitle={t('new')} number="">
            <table aria-labelledby="payapp-start-lines-heading" className={s.sapTable}>
              <tbody>
                <tr>
                  <td>{t('new_note')}</td>
                </tr>
              </tbody>
            </table>
          </DocumentWindow>
        </form>
      </AdminPage>
    );
  }

  const row = owner.payable;
  const remaining = toDecimalString(totals.remainingTxn, 4n);
  const payee =
    (pickers.payees.find((one) => one.verified && one.currency === row.currency) ?? pickers.payees.find((one) => one.verified))?.id ?? '';

  const fields: DocumentField[] = [
    { label: t('import'), value: <ProfileLink code={row.payableNo} kind="import" /> },
    {
      label: admin('payables.supplier'),
      value: <ProfileLink code={owner.supplier?.code} dir="auto" kind="supplier" name={owner.supplier?.name ?? null} />,
    },
    { label: admin('payables.currency'), value: <bdi dir="ltr">{row.currency}</bdi> },
    { label: t('remaining'), value: <bdi dir="ltr">{money(remaining, row.currency)}</bdi> },
    {
      // A part payment is the ordinary case: 20% with the order, the rest against the bill of lading.
      label: t('col_amount'),
      control: true,
      value: (
        <>
          <input aria-label={t('col_amount')} dir="ltr" inputMode="decimal" name="amount" type="text" />
          <span className={s.sapEnteredNote}>{t('amount_part_hint', { remaining: money(remaining, row.currency) })}</span>
        </>
      ),
    },
    {
      label: t('col_method'),
      control: true,
      value: (
        <IntentSelect aria-label={t('col_method')} defaultValue={pickers.methods[0]?.code ?? ''} name="payment_method" required>
          {pickers.methods.map((method) => (
            <option key={method.code} value={method.code}>
              {method.name}
            </option>
          ))}
        </IntentSelect>
      ),
    },
    {
      label: t('col_account'),
      control: true,
      value: (
        <IntentSelect aria-label={t('col_account')} defaultValue={pickers.accounts[0]?.id ?? ''} name="bank_cash_account_id" required>
          {pickers.accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {`${account.code} · ${account.name}${account.bankName ? ` · ${account.bankName}` : ''} — ${t('available_short')} ${money(account.availableIqd, 'IQD')}`}
            </option>
          ))}
        </IntentSelect>
      ),
    },
    {
      // The supplier's accounts are set up and verified on its profile; the one in this import's currency is chosen.
      label: t('payee'),
      control: true,
      value: (
        <>
          <IntentSelect aria-label={t('payee')} defaultValue={payee} name="payee_bank_account_id">
            <option value="">—</option>
            {pickers.payees.map((one) => (
              <option key={one.id} value={one.id}>
                {`${one.bankName} · ${one.iban ?? one.accountNumber}${one.swift ? ` · ${one.swift}` : ''} · ${one.currency}${one.verified ? '' : ` (${t('unverified')})`}`}
              </option>
            ))}
          </IntentSelect>
          <span className={s.sapEnteredNote}>{t('payee_hint')}</span>
        </>
      ),
    },
    ...(pickers.loans.length > 0
      ? [
          {
            label: t('loan'),
            control: true,
            value: (
              <>
                <IntentSelect aria-label={t('loan')} defaultValue="" name="loan_id">
                  <option value="">—</option>
                  {pickers.loans.map((loan) => (
                    <option key={loan.id} value={loan.id}>
                      {`${loan.loanNo} · ${loan.bankName} · ${loan.accountCode} — ${money(loan.unallocatedTxn, row.currency)}`}
                    </option>
                  ))}
                </IntentSelect>
                <span className={s.sapEnteredNote}>{t('loan_hint')}</span>
              </>
            ),
          } satisfies DocumentField,
        ]
      : []),
  ];

  return (
    <AdminPage
      back={{ href: LIST, label: admin('back') }}
      tabs={<SectionTabs route={LIST} />}
      title={t('new_for', { payableNo: row.payableNo })}
      trail={[{ href: '/', label: admin('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={false} savedLabel="" />
      <form action={createApplication}>
        <input name="payable_no" type="hidden" value={row.payableNo} />
        <DocumentWindow
          actions={<Submit label={t('create')} variant="document" />}
          documentType={page('payment_applications')}
          fields={fields}
          fieldsAfterLines={[
            {
              label: t('note'),
              control: true,
              wide: true,
              value: <input aria-label={t('note')} name="note" type="text" />,
            },
          ]}
          id="payapp-new"
          linesTitle={t('new')}
          number=""
        >
          <table aria-labelledby="payapp-new-lines-heading" className={s.sapTable}>
            <tbody>
              <tr>
                <td>{t('new_note')}</td>
              </tr>
            </tbody>
          </table>
        </DocumentWindow>
      </form>
    </AdminPage>
  );
}
