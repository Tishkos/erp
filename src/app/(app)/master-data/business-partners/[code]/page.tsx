import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Handshake } from 'lucide-react';
import { Panel } from '@/components/ui';
import {
  ActionButton,
  AdminPage,
  Checkbox,
  Field,
  Flash,
  Form,
  Grid,
  Pill,
  ReasonForm,
  Select,
  Submit,
  SubmitRow,
  admin as s,
} from '@/components/admin';
import { NewRecordDialog } from '@/components/admin/dialog';
import { AuditLogButton, RecordHistory } from '@/components/admin/history';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatMoney, formatQuantity, formatTimestamp, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { formatIban } from '@/server/domain/bank-details';
import { AdminNotFoundError } from '@/server/services/administration';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as banks from '@/server/services/banks';
import * as bankDetails from '@/server/services/business-partner';
import * as rates from '@/server/services/exchange-rates';
import * as legacy from '@/server/services/legacy-import';
import * as partners from '@/server/services/partners';
import * as terms from '@/server/services/payment-terms';
import {
  addPartnerBankAccount,
  deactivatePartnerBankAccount,
  defaultPartnerBankAccount,
  returnPartnerBankAccount,
  setPartnerActive,
  setPartnerRole,
  submitPartnerBankAccount,
  updatePartnerRecord,
  verifyPartnerBankAccount,
} from '../actions';

/** The chip each state of a bank account wears — the house's own status colours. */
const BANK_CHIP = { draft: 'draft', submitted: 'submitted', verified: 'approved', inactive: 'cancelled' } as const;

/**
 * One business partner — the record behind both the Customers and the
 * Suppliers screen (Phase 2 requirements 2 and 3).
 *
 * There is one record page because there is one record. §6: *"one record
 * serves CRM, Sales, Finance, Projects, Logistics and Money Transfer"*. The
 * roles are shown as what they are — two switches on one company — so that a
 * person who came here from Customers can see this is also a supplier rather
 * than discovering it later from a balance that will not net.
 */
export const dynamic = 'force-dynamic';

export default async function BusinessPartnerPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/sales/customers') && !visibleRoute('/payables/suppliers')) notFound();

  const [t, page, column, locale, context, outcome, query, { code: rawCode }] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    searchParams,
    params,
  ]);
  const code = decodeURIComponent(rawCode);
  const { principal } = context;
  if (!can(principal, 'view', partners.PERMISSION_OBJECT)) {
    return <Denied object={page('md_business_partners')} />;
  }
  const mayEdit = can(principal, 'edit_draft', partners.PERMISSION_OBJECT);
  const mayAdminister = can(principal, 'administer', partners.PERMISSION_OBJECT);
  const maySubmit = can(principal, 'submit', partners.PERMISSION_OBJECT);
  const mayVerify = can(principal, 'approve', partners.PERMISSION_OBJECT);

  const data = await withCurrentUser(async (tx) => {
    try {
      const row = await partners.detail(tx, code);
      return {
        row,
        paymentTerms: mayEdit ? await terms.listActive(tx) : [],
        // REQ-LEGACY-001 — what the old books say about this partner.
        history: await legacy.historyOf(tx, row.id),
        // IMPROVEMENT-002 — its bank accounts, set up and verified here.
        accounts: await bankDetails.bankAccountsOf(tx, row.id),
        bankList: mayEdit ? await banks.listActive(tx) : [],
        currencyRows: mayEdit ? (await rates.currencies(tx)).filter((currency) => currency.isActive) : [],
      };
    } catch (error) {
      if (error instanceof AdminNotFoundError) return null;
      throw error;
    }
  });
  if (!data) notFound();
  const { row, paymentTerms, history, accounts, bankList, currencyRows } = data;
  const bankT = await getTranslations('admin.partners');
  const selected = accounts.find((account) => account.id === query.account) ?? null;
  const legacyT = await getTranslations('admin.legacy_import');
  const routeRole: partners.PartnerRole =
    query.role === 'supplier' || (query.role !== 'customer' && !row.isCustomer && row.isSupplier)
      ? 'supplier'
      : 'customer';
  const listRoute = routeRole === 'customer' ? '/sales/customers' : '/payables/suppliers';
  const selfHref = `${listRoute}/${encodeURIComponent(row.code)}?role=${routeRole}`;
  const accountHidden = (id: string) => ({ code: row.code, returnRole: routeRole, account: id });
  const showBanks = row.isSupplier || accounts.length > 0;

  return (
    <AdminPage
      actions={
        <>
          {/* The statement is one screen on each side, under Sales and under
              Purchasing. This opens it with the partner already chosen, on the
              side their own role puts them; one who is both is read as a
              customer, the same answer the Customers list gives. */}
          <Link
            className={s.backButton}
            href={`${
              routeRole === 'customer' ? '/sales/customer-statements' : '/payables/supplier-statements'
            }?code=${encodeURIComponent(code)}`}
          >
            {t('partners.statement')}
          </Link>
          <AuditLogButton label={t('history')} />
        </>
      }
      back={{
        href: listRoute,
        label: t('back'),
      }}
      title={`${row.code} · ${row.legalName}`}
      trail={[{ href: '/', label: t('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <div className={s.profileGrid}>
        <div className={s.profileStack}>
          <Panel>
            <div className={s.profileCard}>
              <span className={`${s.avatarLarge} ${s.profileAvatar}`}>
                <Handshake aria-hidden="true" style={{ inlineSize: '2rem', blockSize: '2rem' }} />
              </span>
              <h2>{row.legalName}</h2>
              <p>
                {t('code')}: {row.code}
              </p>
              <Pill label={row.active ? t('active') : t('inactive')} on={row.active} />
            </div>
          </Panel>

          {/* §6 — either role, or both, never neither. */}
          <Panel title={t('partners.roles')}>
            <ul className={s.profileFacts}>
              <li>
                <span>{t('partners.role_customer')}</span>
                <span>
                  <Pill label={row.isCustomer ? t('yes') : t('no')} on={row.isCustomer} />
                  {mayEdit ? (
                    <>
                      {' '}
                      <ActionButton
                        action={setPartnerRole}
                        hidden={{
                          code: row.code,
                          role: 'customer',
                          ...(row.isCustomer ? {} : { held: '1' }),
                        }}
                        label={row.isCustomer ? t('partners.remove_role') : t('partners.grant_role')}
                      />
                    </>
                  ) : null}
                </span>
              </li>
              <li>
                <span>{t('partners.role_supplier')}</span>
                <span>
                  <Pill label={row.isSupplier ? t('yes') : t('no')} on={row.isSupplier} />
                  {mayEdit ? (
                    <>
                      {' '}
                      <ActionButton
                        action={setPartnerRole}
                        hidden={{
                          code: row.code,
                          role: 'supplier',
                          ...(row.isSupplier ? {} : { held: '1' }),
                        }}
                        label={row.isSupplier ? t('partners.remove_role') : t('partners.grant_role')}
                      />
                    </>
                  ) : null}
                </span>
              </li>
              {row.isSupplier ? (
                <li>
                  <span>{t('partners.items_supplied')}</span>
                  <span>
                    {row.itemCount === 0
                      ? t('none')
                      : t('partners.items_supplied_count', {
                          count: row.itemCount,
                          preferred: row.defaultForItems,
                        })}
                  </span>
                </li>
              ) : null}
            </ul>
          </Panel>

          <Panel title={t('details')}>
            <ul className={s.profileFacts}>
              <li>
                <span>{column('status')}</span>
                <span>{t(`partners.status_${row.status}`)}</span>
              </li>
              <li>
                <span>{t('partners.email')}</span>
                <span>{row.email ?? t('none')}</span>
              </li>
              <li>
                <span>{t('partners.phone')}</span>
                <span>{row.phone ?? t('none')}</span>
              </li>
              <li>
                <span>{t('partners.payment_terms')}</span>
                <span>
                  {row.paymentTermsCode ? (
                    <Link href={`/master-data/payment-terms/${encodeURIComponent(row.paymentTermsCode)}`}>
                      {row.paymentTermsCode}
                    </Link>
                  ) : (
                    t('none')
                  )}
                  {row.paymentTermsName ? ` · ${row.paymentTermsName}` : ''}
                </span>
              </li>
              <li>
                <span>{t('partners.address')}</span>
                <span>{row.address ?? t('none')}</span>
              </li>
              <li>
                <span>{t('created_at')}</span>
                <span>{formatTimestamp(row.createdAt.toISOString(), locale as Locale)}</span>
              </li>
            </ul>
          </Panel>

          {mayAdminister ? (
            <Panel title={row.active ? t('partners.deactivate_title') : t('reactivate')}>
              {row.active ? (
                <ReasonForm
                  action={setPartnerActive}
                  hidden={{ code: row.code, returnRole: routeRole }}
                  label={t('deactivate')}
                  reasonLabel={t('reason')}
                  reasonPlaceholder={t('reason_placeholder')}
                />
              ) : (
                <ActionButton
                  action={setPartnerActive}
                  hidden={{ code: row.code, active: '1', returnRole: routeRole }}
                  label={t('reactivate')}
                  small={false}
                  tone="primary"
                />
              )}
            </Panel>
          ) : null}
        </div>

        <div className={s.profileStack}>
          {mayEdit ? (
            <Panel title={t('update')}>
              <Form action={updatePartnerRecord}>
                <input name="code" type="hidden" value={row.code} />
                <input name="returnRole" type="hidden" value={routeRole} />
                <Grid>
                  <Field
                    defaultValue={row.legalName}
                    label={t('partners.legal_name')}
                    name="legalName"
                    required
                    requiredLabel={t('required_hint')}
                  />
                  <Field defaultValue={row.email} label={t('partners.email')} name="email" type="email" />
                  <Field defaultValue={row.phone} label={t('partners.phone')} name="phone" />
                  {/* Blocks 2 and 3 name four things: the name, the code, the
                      payment terms and the contact information. These three
                      are none of them, so they are off the screen — and
                      carried through a save, because the update replaces every
                      column and their absence would wipe what is stored. */}
                  <input name="tradeName" type="hidden" value={row.tradeName ?? ''} />
                  <input name="registrationNo" type="hidden" value={row.registrationNo ?? ''} />
                  <input name="taxIdentifier" type="hidden" value={row.taxIdentifier ?? ''} />
                  <Select
                    defaultValue={row.paymentTermsCode ?? ''}
                    emptyLabel={t('partners.no_terms')}
                    hint={t('partners.terms_hint')}
                    label={t('partners.payment_terms')}
                    name="paymentTermsCode"
                    options={paymentTerms.map((term) => ({
                      value: term.code,
                      label: `${term.code} · ${term.name}`,
                    }))}
                  />
                  {/* Blocks 2 and 3 ask for the name, the code, the payment
                      terms and the contact information. The credit figures are
                      none of them — carried through a save, not asked. */}
                  <input name="creditLimitIqd" type="hidden" value={row.creditLimitIqd ?? ''} />
                  <input name="creditTermsDays" type="hidden" value={row.creditTermsDays ?? ''} />
                  <Field
                    defaultValue={row.address}
                    label={t('partners.address')}
                    name="address"
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


          {/* IMPROVEMENT-002 (sponsor, 2026-10-03) — the supplier's bank
              accounts in full, several at once, each verified by somebody
              other than the person who entered it before money goes to it. */}
          {showBanks ? (
            <Panel
              actions={
                mayEdit ? (
                  <NewRecordDialog buttonLabel={bankT('bank_add')} closeLabel={t('close')} openOnLoad={Boolean(outcome.error) && query.add_bank === '1'} title={bankT('bank_add')}>
                    <p className="muted">{bankT('bank_add_note')}</p>
                    <Form action={addPartnerBankAccount}>
                      <input name="code" type="hidden" value={row.code} />
                      <input name="returnRole" type="hidden" value={routeRole} />
                      <Grid>
                        <Select
                          emptyLabel={bankT('bank_not_listed')}
                          label={bankT('bank_from_list')}
                          name="bank_code"
                          options={bankList.map((b) => ({ value: b.code, label: b.swiftBic ? `${b.name} · ${b.swiftBic}` : b.name }))}
                        />
                        <Field hint={bankT('bank_name_hint')} label={bankT('bank_name')} name="bank_name" />
                        <Field label={bankT('bank_branch')} name="bank_branch" />
                        <Field label={bankT('bank_address')} name="bank_address" />
                        <Field defaultValue={row.legalName} hint={bankT('account_holder_hint')} label={bankT('account_holder')} name="account_holder" />
                        <Select
                          defaultValue="IQD"
                          label={bankT('currency')}
                          name="currency"
                          options={currencyRows.map((currency) => ({ value: currency.code, label: `${currency.code} · ${currency.name}` }))}
                          required
                        />
                        <Field hint={bankT('account_number_hint')} label={bankT('account_number')} name="account_number" />
                        <Field hint={bankT('iban_hint')} label={bankT('iban')} name="iban" />
                        <Field hint={bankT('swift_hint')} label={bankT('swift')} name="swift" />
                        <Field label={bankT('intermediary_bank')} name="intermediary_bank" />
                        <Field label={bankT('intermediary_swift')} name="intermediary_swift" />
                      </Grid>
                      <Field label={bankT('bank_note')} name="note" type="textarea" wide />
                      <Checkbox label={bankT('bank_confirm_duplicate')} name="confirmed_not_duplicate" />
                      <SubmitRow>
                        <Submit label={bankT('bank_add')} />
                      </SubmitRow>
                    </Form>
                  </NewRecordDialog>
                ) : null
              }
              flush
              labelledBy="bank-accounts-title"
              title={bankT('bank_accounts')}
            >
              <div className="table-wrap">
                <table aria-labelledby="bank-accounts-title" className="list">
                  <thead>
                    <tr>
                      <th scope="col">{bankT('bank_col_bank')}</th>
                      <th scope="col">{bankT('swift')}</th>
                      <th scope="col">{bankT('bank_col_account')}</th>
                      <th scope="col">{bankT('currency')}</th>
                      <th scope="col">{bankT('account_holder')}</th>
                      <th scope="col">{bankT('bank_col_status')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {accounts.length === 0 ? (
                      <tr>
                        <td className="muted" colSpan={6}>
                          {bankT('bank_accounts_none')}
                        </td>
                      </tr>
                    ) : null}
                    {accounts.map((account) => (
                      <tr key={account.id}>
                        <td>
                          <Link href={`${selfHref}&account=${encodeURIComponent(account.id)}#bank-account`}>
                            <bdi dir="auto">{account.bankName}</bdi>
                          </Link>
                          {account.bankBranch ? (
                            <div className="muted">
                              <bdi dir="auto">{account.bankBranch}</bdi>
                            </div>
                          ) : null}
                        </td>
                        <td>
                          <bdi dir="ltr">{account.swift ?? '—'}</bdi>
                        </td>
                        <td>
                          <bdi dir="ltr">{account.iban ? formatIban(account.iban) : account.accountNumber}</bdi>
                          {account.iban && account.accountNumber !== account.iban ? (
                            <div className="muted">
                              <bdi dir="ltr">{account.accountNumber}</bdi>
                            </div>
                          ) : null}
                        </td>
                        <td>
                          <bdi dir="ltr">{account.currency}</bdi>
                        </td>
                        <td>
                          <bdi dir="auto">{account.accountHolder ?? '—'}</bdi>
                        </td>
                        <td>
                          <span className={`status status--${BANK_CHIP[account.state]}`} data-status={BANK_CHIP[account.state]}>
                            {bankT(`bank_state_${account.state}`)}
                          </span>
                          {account.isDefault ? <div className="muted">{bankT('bank_default')}</div> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          ) : null}

          {selected ? (
            <Panel
              actions={
                <Link className={s.backButton} href={`${selfHref}#bank-accounts-title`}>
                  {t('close')}
                </Link>
              }
              labelledBy="bank-account"
              title={`${selected.bankName} · ${selected.iban ? formatIban(selected.iban) : selected.accountNumber}`}
            >
              <ul className={s.profileFacts}>
                <li>
                  <span>{bankT('bank_col_status')}</span>
                  <span>
                    <span className={`status status--${BANK_CHIP[selected.state]}`} data-status={BANK_CHIP[selected.state]}>
                      {bankT(`bank_state_${selected.state}`)}
                    </span>
                    {selected.isDefault ? ` · ${bankT('bank_default')}` : ''}
                  </span>
                </li>
                <li>
                  <span>{bankT('bank_name')}</span>
                  <span>
                    <bdi dir="auto">{selected.bankName}</bdi>
                    {selected.bankCode ? (
                      <>
                        {' · '}
                        <Link href={`/master-data/banks/${encodeURIComponent(selected.bankCode)}`}>
                          <bdi dir="ltr">{selected.bankCode}</bdi>
                        </Link>
                      </>
                    ) : null}
                  </span>
                </li>
                <li>
                  <span>{bankT('bank_branch')}</span>
                  <span>
                    <bdi dir="auto">{selected.bankBranch ?? t('none')}</bdi>
                  </span>
                </li>
                <li>
                  <span>{bankT('bank_address')}</span>
                  <span>
                    <bdi dir="auto">{selected.bankAddress ?? t('none')}</bdi>
                  </span>
                </li>
                <li>
                  <span>{bankT('account_holder')}</span>
                  <span>
                    <bdi dir="auto">{selected.accountHolder ?? t('none')}</bdi>
                  </span>
                </li>
                <li>
                  <span>{bankT('account_number')}</span>
                  <span>
                    <bdi dir="ltr">{selected.accountNumber}</bdi>
                  </span>
                </li>
                <li>
                  <span>{bankT('iban')}</span>
                  <span>
                    <bdi dir="ltr">{selected.iban ? formatIban(selected.iban) : t('none')}</bdi>
                  </span>
                </li>
                <li>
                  <span>{bankT('swift')}</span>
                  <span>
                    <bdi dir="ltr">{selected.swift ?? t('none')}</bdi>
                  </span>
                </li>
                <li>
                  <span>{bankT('currency')}</span>
                  <span>
                    <bdi dir="ltr">{selected.currency}</bdi>
                  </span>
                </li>
                <li>
                  <span>{bankT('intermediary_bank')}</span>
                  <span>
                    <bdi dir="auto">
                      {[selected.intermediaryBank, selected.intermediarySwift].filter(Boolean).join(' · ') || t('none')}
                    </bdi>
                  </span>
                </li>
                <li>
                  <span>{bankT('bank_note')}</span>
                  <span>
                    <bdi dir="auto">{selected.note ?? t('none')}</bdi>
                  </span>
                </li>
                <li>
                  <span>{bankT('bank_entered_by')}</span>
                  <span>
                    <bdi dir="auto">{selected.createdByName ?? t('none')}</bdi>
                    {' · '}
                    {formatTimestamp(selected.createdAt.toISOString(), locale as Locale)}
                  </span>
                </li>
                {selected.approvedAt ? (
                  <li>
                    <span>{bankT('bank_verified_by')}</span>
                    <span>
                      <bdi dir="auto">{selected.approvedByName ?? t('none')}</bdi>
                      {' · '}
                      {formatTimestamp(selected.approvedAt.toISOString(), locale as Locale)}
                    </span>
                  </li>
                ) : null}
                {selected.deactivatedAt ? (
                  <li>
                    <span>{bankT('bank_out_by')}</span>
                    <span>
                      <bdi dir="auto">{selected.deactivatedByName ?? t('none')}</bdi>
                      {' · '}
                      {formatTimestamp(selected.deactivatedAt.toISOString(), locale as Locale)}
                      {' — '}
                      <bdi dir="auto">{selected.deactivationReason}</bdi>
                    </span>
                  </li>
                ) : null}
              </ul>
              {selected.state === 'submitted' && selected.createdBy === principal.userId ? (
                <p className="muted">{bankT('bank_self_note')}</p>
              ) : null}
              <div className={s.inline}>
                {selected.state === 'draft' && maySubmit ? (
                  <ActionButton action={submitPartnerBankAccount} hidden={accountHidden(selected.id)} label={bankT('bank_submit')} small={false} tone="primary" />
                ) : null}
                {selected.state === 'submitted' && mayVerify && selected.createdBy !== principal.userId ? (
                  <ActionButton action={verifyPartnerBankAccount} hidden={accountHidden(selected.id)} label={bankT('bank_verify')} small={false} tone="primary" />
                ) : null}
                {selected.state === 'verified' && !selected.isDefault && mayEdit ? (
                  <ActionButton action={defaultPartnerBankAccount} hidden={accountHidden(selected.id)} label={bankT('bank_make_default')} small={false} />
                ) : null}
              </div>
              {selected.state === 'submitted' && mayVerify ? (
                <ReasonForm
                  action={returnPartnerBankAccount}
                  hidden={accountHidden(selected.id)}
                  label={bankT('bank_return')}
                  reasonLabel={bankT('bank_return_reason')}
                  tone="secondary"
                />
              ) : null}
              {selected.state !== 'inactive' && mayEdit ? (
                <ReasonForm
                  action={deactivatePartnerBankAccount}
                  hidden={accountHidden(selected.id)}
                  label={bankT('bank_deactivate')}
                  reasonLabel={bankT('bank_deactivate_reason')}
                />
              ) : null}
            </Panel>
          ) : null}

          {history.length > 0 ? (
            <Panel flush title={legacyT('history_title')}>
              <div className="table-wrap">
                <table className="list">
                  <thead>
                    <tr>
                      <th scope="col">{legacyT('col_kind')}</th>
                      <th scope="col">{legacyT('col_code')}</th>
                      <th scope="col">{legacyT('col_when')}</th>
                      <th scope="col">{legacyT('col_item')}</th>
                      <th className="numeric" scope="col">
                        {legacyT('col_quantity')}
                      </th>
                      <th className="numeric" scope="col">
                        {legacyT('col_amount')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((doc) => (
                      <tr key={doc.id}>
                        <td>{legacyT(`archive_${doc.kind === 'sale' ? 'sales' : doc.kind === 'purchase' ? 'purchases' : doc.kind === 'receipt' ? 'receipts' : 'payments'}`)}</td>
                        <td>
                          <bdi dir="ltr">{doc.legacyNo}</bdi>
                        </td>
                        <td>{doc.documentDate ? formatBusinessDate(doc.documentDate, locale as Locale) : '—'}</td>
                        <td>
                          <bdi dir="auto">{doc.itemName ?? doc.operation ?? '—'}</bdi>
                        </td>
                        <td className="numeric">{doc.quantity ? `${formatQuantity(doc.quantity, locale as Locale)} ${doc.unit ?? ''}`.trim() : '—'}</td>
                        <td className="numeric">
                          <bdi dir="ltr">{doc.amount ? formatMoney(doc.amount, doc.currency === 'USD' ? 'USD' : 'IQD', locale as Locale) : '—'}</bdi>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          ) : null}

          <RecordHistory
            objectId={row.id}
            objectType={partners.PERMISSION_OBJECT}
            related={accounts.map((account) => ({ objectType: bankDetails.BANK_DOCUMENT_TYPE, objectId: account.id }))}
          />
        </div>
      </div>
    </AdminPage>
  );
}
