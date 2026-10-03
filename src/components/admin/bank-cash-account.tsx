import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { ArrowDownLeft, ArrowUpRight, Banknote, Hourglass, Landmark, Wallet } from 'lucide-react';
import { Panel } from '@/components/ui';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import {
  ActionButton,
  AdminPage,
  Field,
  Flash,
  Form,
  Grid,
  Hidden,
  ListToolbar,
  NewRecordDialog,
  Pill,
  ReasonForm,
  Select,
  Submit,
  SubmitRow,
  admin as s,
  matches,
} from './index';
import { AuditLogButton, RecordHistory } from './history';
import { SectionTabs } from './section-tabs';
import { outcomeOf, type SearchParams } from './params';
import { Denied } from '@/components/denied';
import { ExportMenu } from '@/components/print/export-menu';
import { can } from '@domain/permissions';
import { toDecimalString } from '@domain/money';
import { AdminNotFoundError } from '@/server/services/administration';
import { requireContext, withCurrentUser } from '@/server/session';
import * as accounts from '@/server/services/bank-cash-accounts';
import * as banks from '@/server/services/banks';
import * as reservations from '@/server/services/treasury';
import * as treasury from '@/server/services/treasury-reports';
import * as rates from '@/server/services/exchange-rates';
import * as users from '@/server/services/users';
import {
  createAccount,
  setAccountActive,
  updateAccount,
} from '@/app/(app)/master-data/bank-accounts/actions';
import { businessToday } from '@/server/domain/business-date';

/**
 * Bank accounts and cash accounts — Phase 2 requirements 5 and 6.
 *
 * One component, two screens. They are the same record in the database and the
 * same lifecycle on screen; what differs is the handful of fields each kind
 * needs, and that difference is expressed once here rather than twice in two
 * pages that would drift apart.
 *
 * A bank account has a bank, a number, an IBAN and a statement format. A cash
 * account has a custodian and a float ceiling. Asking either set of questions
 * of the other kind wastes the reader's attention on fields that will always
 * be blank, which is why they are two screens and not one with a type picker.
 */

const ROUTES = {
  bank: '/master-data/bank-accounts',
  cash: '/master-data/cash-accounts',
} as const;

const PAGE_KEY = { bank: 'bank_cash_accounts', cash: 'cash_accounts' } as const;

export async function AccountList({
  kind,
  searchParams,
}: {
  readonly kind: accounts.AccountKind;
  readonly searchParams: SearchParams;
}) {
  const [t, page, column, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', accounts.PERMISSION_OBJECT)) {
    return <Denied object={page(PAGE_KEY[kind])} />;
  }
  const mayCreate = can(principal, 'create', accounts.PERMISSION_OBJECT);
  const route = ROUTES[kind];

  const { rows, gl, people, moneys, bankRows } = await withCurrentUser(async (tx) => ({
    rows: await accounts.listOfKind(tx, kind),
    gl: mayCreate ? await accounts.availableGlAccounts(tx) : [],
    people: mayCreate && kind === 'cash' ? await users.listAll(tx) : [],
    // The currencies Finance has configured. An account's currency is one of
    // them or it is nothing: a typed code is a code nothing else in the system
    // knows, and the first payment in it would have no rate to be read at.
    moneys: mayCreate ? await rates.currencies(tx) : [],
    // REQ-AP-001 §15.1 — the bank is a master row.
    bankRows: mayCreate && kind === 'bank' ? await banks.listActive(tx) : [],
  }));
  const shown = rows.filter((row) => matches(row, outcome.q));

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <NewRecordDialog
            buttonLabel={t(`${kind}_accounts.new`)}
            closeLabel={t('close')}
            openOnLoad={Boolean(outcome.error)}
            title={t(`${kind}_accounts.new`)}
          >
            <p className="muted">{t(`${kind}_accounts.created_note`)}</p>
            {/* The ERP code is generated. For banks, the number field below
                asks for the real account number assigned by the bank. */}
            <Form action={createAccount}>
              <Hidden name="kind" value={kind} />
              <Grid>
                <Field label={t('name')} name="name" required requiredLabel={t('required_hint')} />
                {/* No branch. By direction, 2026-09-27: an account is the
                    company's, and the branch that matters is the one on the
                    payment or the receipt. */}
                {/* One G/L account each, and no two accounts share one — the
                    picker only offers those not already carried. */}
                <Select
                  hint={t('accounts_shared.gl_hint')}
                  label={t('accounts_shared.gl_account')}
                  name="glAccountId"
                  options={gl.map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` }))}
                  required
                />
                <Select
                  defaultValue="IQD"
                  hint={t('accounts_shared.currency_hint')}
                  label={t('accounts_shared.currency')}
                  name="currency"
                  options={moneys
                    .filter((c) => c.isActive)
                    .map((c) => ({ value: c.code, label: `${c.code} · ${c.name}` }))}
                  required
                />
                {kind === 'bank' ? (
                  <>
                    <Select
                      emptyLabel="—"
                      hint={t('bank_accounts.bank_hint')}
                      label={t('bank_accounts.bank')}
                      name="bankCode"
                      options={bankRows.map((b) => ({
                        value: b.code,
                        label: b.swiftBic ? `${b.name} · ${b.swiftBic}` : b.name,
                      }))}
                    />
                    <Field label={t('bank_accounts.bank_name')} name="bankName" />
                    <Field
                      hint={t('bank_accounts.number_hint')}
                      label={t('bank_accounts.account_number')}
                      name="accountNumber"
                      required
                      requiredLabel={t('required_hint')}
                    />
                  </>
                ) : (
                  <Select
                    hint={t('cash_accounts.custodian_hint')}
                    label={t('cash_accounts.custodian')}
                    name="custodianUserId"
                    options={people
                      .filter((p) => p.isActive)
                      .map((p) => ({ value: p.id, label: `${p.displayName} · ${p.email}` }))}
                    required
                  />
                )}
              </Grid>
              <SubmitRow>
                <Submit label={t('create')} />
              </SubmitRow>
            </Form>
          </NewRecordDialog>
        ) : null
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route={route} />}
      subtitle={t(`${kind}_accounts.subtitle`)}
      title={page(PAGE_KEY[kind])}
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
          clearHref={route}
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
                <th scope="col">
                  {kind === 'bank' ? t('bank_accounts.bank_name') : t('cash_accounts.custodian')}
                </th>
                <th scope="col">{t('accounts_shared.gl_account')}</th>
                <th scope="col">{t('accounts_shared.currency')}</th>
                <th scope="col">{column('active')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 ? (
                <tr>
                  <td colSpan={6}>{t(`${kind}_accounts.none`)}</td>
                </tr>
              ) : null}
              {shown.map((row) => (
                <tr key={row.code}>
                  <td>
                    <Link href={`${route}/${encodeURIComponent(row.code)}`}>{row.code}</Link>
                  </td>
                  <td>{row.name}</td>
                  <td>{(kind === 'bank' ? row.bankName : row.custodianName) ?? t('none')}</td>
                  <td>
                    {/* Null when the G/L account this once pointed at is no
                        longer there. Said plainly, and the row stays on the
                        list, because this is the screen that repairs it. */}
                    {row.glAccountCode ? (
                      `${row.glAccountCode} · ${row.glAccountName}`
                    ) : (
                      <Pill label={t('accounts_shared.gl_missing')} on={false} />
                    )}
                  </td>
                  <td>{row.currency}</td>
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

export async function AccountRecord({
  kind,
  params,
  searchParams,
}: {
  readonly kind: accounts.AccountKind;
  readonly params: Promise<{ code: string }>;
  readonly searchParams: SearchParams;
}) {
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
  if (!can(principal, 'view', accounts.PERMISSION_OBJECT)) {
    return <Denied object={page(PAGE_KEY[kind])} />;
  }
  const mayEdit = can(principal, 'configure', accounts.PERMISSION_OBJECT);
  const mayAdminister = can(principal, 'administer', accounts.PERMISSION_OBJECT);

  /*
   * The year so far, and what the account holds now.
   *
   * `to` is today, so `closingIqd` is every posted movement up to this moment
   * — the account's actual balance, not the year's. The in and out figures are
   * the year's, because "how much has gone through this till" is a question
   * about a period and lifetime totals on a five-year-old account answer it
   * badly.
   */
  const year = new Date().getFullYear();
  const window = { from: `${year}-01-01`, to: businessToday() };

  const data = await withCurrentUser(async (tx, request) => {
    try {
      const row = await accounts.detail(tx, code);
      return {
        row,
        bankRows: mayEdit && kind === 'bank' ? await banks.listActive(tx) : [],
        // REQ-AP-001 §15.1 — Booked / Reserved / Available.
        reserved: await reservations.accountPosition(tx, row.id).catch(() => null),
        gl: mayEdit ? await accounts.availableGlAccounts(tx, row.glAccountId) : [],
        people: mayEdit ? await users.listAll(tx) : [],
        moneys: mayEdit ? await rates.currencies(tx) : [],
        /*
         * Read through the same service the Bank and Cash Reporting screen
         * uses, so this panel and that report cannot state different balances
         * for one account. An account with no G/L account linked has no
         * position to state, and says so rather than showing nought.
         */
        position: (
          await treasury
            .positions(
              tx,
              { principal: request.principal, branchCode: request.scope.branchCode },
              window,
              { accountCode: code },
            )
            .catch(() => [])
        )[0] ?? null,
      };
    } catch (error) {
      if (error instanceof AdminNotFoundError) return null;
      throw error;
    }
  });
  if (!data) notFound();
  const { row, gl, people, moneys, position, bankRows, reserved } = data;
  const money = (amount: string) => formatMoney(amount, row.currency, locale as Locale);
  // The address is the truth about which list this belongs on; a cash account
  // reached through the bank route is the wrong page for it.
  if (row.accountType !== kind) notFound();

  const Icon = kind === 'bank' ? Landmark : Banknote;

  return (
    <AdminPage
      actions={
        <>
          <ExportMenu exportKey={`${kind}_statement`} id={row.code} />
          <AuditLogButton label={t('history')} />
        </>
      }
      back={{ href: ROUTES[kind], label: t('back') }}
      title={`${row.code} · ${row.name}`}
      trail={[{ href: '/', label: t('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <div className={s.profileGrid}>
        <div className={s.profileStack}>
          <Panel>
            <div className={s.profileCard}>
              <span className={`${s.avatarLarge} ${s.profileAvatar}`}>
                <Icon aria-hidden="true" style={{ inlineSize: '2rem', blockSize: '2rem' }} />
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
                <span>{t('accounts_shared.gl_account')}</span>
                <span>
                  {row.glAccountCode ? (
                    `${row.glAccountCode} · ${row.glAccountName}`
                  ) : (
                    <Pill label={t('accounts_shared.gl_missing')} on={false} />
                  )}
                </span>
              </li>
              <li>
                <span>{t('accounts_shared.currency')}</span>
                <span>{row.currency}</span>
              </li>
              {kind === 'bank' ? (
                <>
                  <li>
                    <span>{t('bank_accounts.bank')}</span>
                    <span>
                      {row.bankMasterName
                        ? `${row.bankMasterName}${row.bankMasterSwift ? ` · ${row.bankMasterSwift}` : ''}`
                        : t('none')}
                    </span>
                  </li>
                  <li>
                    <span>{t('bank_accounts.bank_name')}</span>
                    <span>{row.bankName ?? t('none')}</span>
                  </li>
                  <li>
                    <span>{t('bank_accounts.account_number')}</span>
                    <span>{row.accountNumber ?? t('none')}</span>
                  </li>
                  <li>
                    <span>{t('bank_accounts.iban')}</span>
                    <span>{row.iban ?? t('none')}</span>
                  </li>
                  <li>
                    <span>{t('bank_accounts.swift')}</span>
                    <span>{row.swift ?? t('none')}</span>
                  </li>
                  <li>
                    <span>{t('bank_accounts.statement_format')}</span>
                    <span>{row.statementFormat ?? t('none')}</span>
                  </li>
                </>
              ) : (
                <>
                  <li>
                    <span>{t('cash_accounts.custodian')}</span>
                    <span>{row.custodianName ?? t('none')}</span>
                  </li>
                  <li>
                    <span>{t('cash_accounts.cash_limit')}</span>
                    <span>{row.cashLimitIqd ?? t('none')}</span>
                  </li>
                </>
              )}
              <li>
                <span>{t('accounts_shared.approval_limit')}</span>
                <span>{row.approvalLimitIqd ?? t('none')}</span>
              </li>
            </ul>
          </Panel>

          {mayAdminister ? (
            <Panel title={row.active ? t('accounts_shared.deactivate_title') : t('reactivate')}>
              {row.active ? (
                <ReasonForm
                  action={setAccountActive}
                  hidden={{ code: row.code, kind }}
                  label={t('deactivate')}
                  reasonLabel={t('reason')}
                  reasonPlaceholder={t('reason_placeholder')}
                />
              ) : (
                <ActionButton
                  action={setAccountActive}
                  hidden={{ code: row.code, kind, active: '1' }}
                  label={t('reactivate')}
                  small={false}
                  tone="primary"
                />
              )}
            </Panel>
          ) : null}
        </div>

        <div className={s.profileStack}>
          {/* ── What this account holds ──────────────────────────────────
              First in the wide column, above the form. The balance is what a
              person opens a till or a bank account to find out; the form is
              what they open it to change, and that is the rarer errand.

              Read through `treasury-reports.ts`, which reads the G/L, so this
              figure is the ledger's rather than a second tally kept beside it
              — and cannot disagree with Bank and Cash Reporting. */}
          {position ? (
            <Panel
              actions={
                <Link className={s.sapLink} href={`/treasury/reporting?account=${encodeURIComponent(row.code)}`}>
                  {t('accounts_shared.see_transactions')}
                </Link>
              }
              icon={Wallet}
              title={t('accounts_shared.money_title')}
            >
              <div className={s.holdings}>
                <div className={s.holdingsHead}>
                  <span>{t('accounts_shared.holds_now')}</span>
                  <span className={s.holdingsAmount}>
                    <bdi dir="ltr">{money(position.closingIqd)}</bdi>
                  </span>
                </div>

                <div className={s.holdingsFlows}>
                  <div className={`${s.holdingsFlow} ${s.holdingsIn}`}>
                    <span>
                      <ArrowDownLeft aria-hidden="true" />
                      {t('accounts_shared.received_in', { year: String(year) })}
                    </span>
                    <strong>
                      <bdi dir="ltr">{money(position.moneyInIqd)}</bdi>
                    </strong>
                  </div>

                  {/*
                    REQ-AP-001 §15.1 — what payment applications hold on this
                    account, and have not yet sent.

                    Between the money that arrived and the money that left,
                    because that is what it is: the same fact one moment
                    earlier. Always drawn, including at nought (2026-10-03) —
                    it used to appear only when something was held, which hid
                    it exactly when a person most needs to know that nothing
                    is holding the balance back.
                  */}
                  {reserved ? (
                    <div className={`${s.holdingsFlow} ${s.holdingsPending}`}>
                      <span>
                        <Hourglass aria-hidden="true" />
                        {t('accounts_shared.reserved')}
                      </span>
                      <strong>
                        <bdi dir="ltr">{money(toDecimalString(reserved.committedIqd, 4n))}</bdi>
                      </strong>
                    </div>
                  ) : null}

                  <div className={`${s.holdingsFlow} ${s.holdingsOut}`}>
                    <span>
                      <ArrowUpRight aria-hidden="true" />
                      {t('accounts_shared.paid_out_in', { year: String(year) })}
                    </span>
                    <strong>
                      <bdi dir="ltr">{money(position.moneyOutIqd)}</bdi>
                    </strong>
                  </div>

                  <div className={s.holdingsFlow}>
                    <span>{t('accounts_shared.opening_year', { year: String(year) })}</span>
                    <strong>
                      <bdi dir="ltr">{money(position.openingIqd)}</bdi>
                    </strong>
                  </div>

                  {reserved ? (
                    <div className={s.holdingsFlow}>
                      <span>{t('accounts_shared.available')}</span>
                      <strong>
                        <bdi dir="ltr">{money(toDecimalString(reserved.availableIqd, 4n))}</bdi>
                      </strong>
                    </div>
                  ) : null}

                  <div className={s.holdingsFlow}>
                    <span>{t('accounts_shared.last_movement')}</span>
                    <strong>
                      {position.lastMovementDate ? (
                        <bdi dir="ltr">
                          {formatBusinessDate(position.lastMovementDate, locale as Locale)}
                        </bdi>
                      ) : (
                        t('accounts_shared.never_moved')
                      )}
                    </strong>
                  </div>

                  {/* Only when there are any: a till that has never been part
                      of a transfer should not carry two empty tiles. */}
                  {Number(position.transfersInIqd) > 0 || Number(position.transfersOutIqd) > 0 ? (
                    <>
                      <div className={s.holdingsFlow}>
                        <span>{t('accounts_shared.transfers_in')}</span>
                        <strong>
                          <bdi dir="ltr">{money(position.transfersInIqd)}</bdi>
                        </strong>
                      </div>
                      <div className={s.holdingsFlow}>
                        <span>{t('accounts_shared.transfers_out')}</span>
                        <strong>
                          <bdi dir="ltr">{money(position.transfersOutIqd)}</bdi>
                        </strong>
                      </div>
                    </>
                  ) : null}
                </div>
              </div>
            </Panel>
          ) : null}

          {mayEdit ? (
            <Panel title={t('update')}>
              <Form action={updateAccount}>
                <input name="code" type="hidden" value={row.code} />
                <Hidden name="kind" value={kind} />
                <Grid>
                  <Field
                    defaultValue={row.name}
                    label={t('name')}
                    name="name"
                    required
                    requiredLabel={t('required_hint')}
                  />
                  {/* Bank and cash accounts are company-wide. Transactions
                      carry the branch they belong to. */}
                  <Select
                    /*
                     * Offered — and preselected — only when the account it
                     * names is really there. A dangling id left in the list
                     * would sit selected under a "null · null" label, and
                     * saving the form would write it straight back: the one
                     * screen that repairs the link quietly preserving the
                     * break instead. With it gone the field is empty and
                     * `required`, so the form asks for a real account.
                     */
                    defaultValue={row.glAccountCode ? row.glAccountId : undefined}
                    hint={t('accounts_shared.gl_hint')}
                    label={t('accounts_shared.gl_account')}
                    name="glAccountId"
                    options={[
                      // The one it already holds, so the picker can show it.
                      ...(row.glAccountCode
                        ? [
                            {
                              value: row.glAccountId,
                              label: `${row.glAccountCode} · ${row.glAccountName}`,
                            },
                          ]
                        : []),
                      ...gl
                        .filter((a) => a.id !== row.glAccountId)
                        .map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` })),
                    ]}
                    required
                  />
                  <Select
                    defaultValue={row.currency}
                    hint={t('accounts_shared.currency_hint')}
                    label={t('accounts_shared.currency')}
                    name="currency"
                    options={moneys
                      // Whatever it already holds stays offered, even if the
                      // currency was since retired — otherwise saving any other
                      // field would silently change the account's currency.
                      .filter((c) => c.isActive || c.code === row.currency)
                      .map((c) => ({ value: c.code, label: `${c.code} · ${c.name}` }))}
                    required
                  />
                  {kind === 'bank' ? (
                    <>
                      <Select
                        defaultValue={row.bankCode ?? ''}
                        emptyLabel="—"
                        hint={t('bank_accounts.bank_hint')}
                        label={t('bank_accounts.bank')}
                        name="bankCode"
                        options={bankRows.map((b) => ({
                          value: b.code,
                          label: b.swiftBic ? `${b.name} · ${b.swiftBic}` : b.name,
                        }))}
                      />
                      <Field defaultValue={row.bankName} label={t('bank_accounts.bank_name')} name="bankName" />
                      <Field
                        defaultValue={row.accountNumber}
                        hint={t('bank_accounts.number_hint')}
                        label={t('bank_accounts.account_number')}
                        name="accountNumber"
                        required
                        requiredLabel={t('required_hint')}
                      />
                      <Field defaultValue={row.iban} label={t('bank_accounts.iban')} name="iban" />
                      <Field defaultValue={row.swift} label={t('bank_accounts.swift')} name="swift" />
                      <Field
                        defaultValue={row.statementFormat}
                        hint={t('bank_accounts.statement_format_hint')}
                        label={t('bank_accounts.statement_format')}
                        name="statementFormat"
                      />
                    </>
                  ) : (
                    <>
                      <Select
                        defaultValue={row.custodianUserId ?? ''}
                        hint={t('cash_accounts.custodian_hint')}
                        label={t('cash_accounts.custodian')}
                        name="custodianUserId"
                        options={people.map((p) => ({
                          value: p.id,
                          label: `${p.displayName} · ${p.email}`,
                        }))}
                        required
                      />
                      <Field
                        defaultValue={row.cashLimitIqd}
                        hint={t('cash_accounts.cash_limit_hint')}
                        label={t('cash_accounts.cash_limit')}
                        min={0}
                        name="cashLimitIqd"
                        step="0.0001"
                        type="number"
                      />
                    </>
                  )}
                  <Field
                    defaultValue={row.approvalLimitIqd}
                    hint={t('accounts_shared.approval_limit_hint')}
                    label={t('accounts_shared.approval_limit')}
                    min={0}
                    name="approvalLimitIqd"
                    step="0.0001"
                    type="number"
                  />
                </Grid>
                <SubmitRow>
                  <Submit label={t('save')} />
                </SubmitRow>
              </Form>
            </Panel>
          ) : null}

          <RecordHistory objectId={row.code} objectType={accounts.PERMISSION_OBJECT} />
        </div>
      </div>
    </AdminPage>
  );
}
