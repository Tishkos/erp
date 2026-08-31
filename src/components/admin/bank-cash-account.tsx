import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Banknote, Landmark } from 'lucide-react';
import { Panel } from '@/components/ui';
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
import { AutoCode } from './auto-code';
import { AuditLogButton, RecordHistory } from './history';
import { SectionTabs } from './section-tabs';
import { outcomeOf, type SearchParams } from './params';
import { Denied } from '@/components/denied';
import { can } from '@domain/permissions';
import { AdminNotFoundError } from '@/server/services/administration';
import { requireContext, withCurrentUser } from '@/server/session';
import * as accounts from '@/server/services/bank-cash-accounts';
import * as rates from '@/server/services/exchange-rates';
import * as users from '@/server/services/users';
import {
  createAccount,
  setAccountActive,
  updateAccount,
} from '@/app/(app)/master-data/bank-accounts/actions';

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

  const { rows, places, gl, people, moneys } = await withCurrentUser(async (tx) => ({
    rows: await accounts.listOfKind(tx, kind),
    places: mayCreate ? await accounts.listBranches(tx) : [],
    gl: mayCreate ? await accounts.availableGlAccounts(tx) : [],
    people: mayCreate && kind === 'cash' ? await users.listAll(tx) : [],
    // The currencies Finance has configured. An account's currency is one of
    // them or it is nothing: a typed code is a code nothing else in the system
    // knows, and the first payment in it would have no rate to be read at.
    moneys: mayCreate ? await rates.currencies(tx) : [],
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
            <AutoCode codeId="f-code" mode="upper" nameId="f-name" />
            <Form action={createAccount}>
              <Hidden name="kind" value={kind} />
              <Grid>
                <Field hint={t('code_auto_hint')} label={t('code')} name="code" />
                <Field label={t('name')} name="name" required requiredLabel={t('required_hint')} />
                <Select
                  label={column('branch_code')}
                  name="branchCode"
                  options={places.map((b) => ({ value: b.code, label: `${b.code} · ${b.name}` }))}
                  required
                />
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
                <th scope="col">{column('branch_code')}</th>
                <th scope="col">{t('accounts_shared.gl_account')}</th>
                <th scope="col">{t('accounts_shared.currency')}</th>
                <th scope="col">{column('active')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 ? (
                <tr>
                  <td colSpan={7}>{t(`${kind}_accounts.none`)}</td>
                </tr>
              ) : null}
              {shown.map((row) => (
                <tr key={row.code}>
                  <td>
                    <Link href={`${route}/${encodeURIComponent(row.code)}`}>{row.code}</Link>
                  </td>
                  <td>{row.name}</td>
                  <td>{(kind === 'bank' ? row.bankName : row.custodianName) ?? t('none')}</td>
                  <td>{row.branchCode}</td>
                  <td>
                    {row.glAccountCode} · {row.glAccountName}
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
  const [t, page, column, context, outcome, { code: rawCode }] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
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

  const data = await withCurrentUser(async (tx) => {
    try {
      const row = await accounts.detail(tx, code);
      return {
        row,
        places: mayEdit ? await accounts.listBranches(tx) : [],
        gl: mayEdit ? await accounts.availableGlAccounts(tx, row.glAccountId) : [],
        people: mayEdit ? await users.listAll(tx) : [],
        moneys: mayEdit ? await rates.currencies(tx) : [],
      };
    } catch (error) {
      if (error instanceof AdminNotFoundError) return null;
      throw error;
    }
  });
  if (!data) notFound();
  const { row, places, gl, people, moneys } = data;
  // The address is the truth about which list this belongs on; a cash account
  // reached through the bank route is the wrong page for it.
  if (row.accountType !== kind) notFound();

  const Icon = kind === 'bank' ? Landmark : Banknote;

  return (
    <AdminPage
      actions={<AuditLogButton label={t('history')} />}
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
                  {row.glAccountCode} · {row.glAccountName}
                </span>
              </li>
              <li>
                <span>{column('branch_code')}</span>
                <span>
                  {row.branchCode}
                  {row.branchName ? ` · ${row.branchName}` : ''}
                </span>
              </li>
              <li>
                <span>{t('accounts_shared.currency')}</span>
                <span>{row.currency}</span>
              </li>
              {kind === 'bank' ? (
                <>
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
                  <Select
                    defaultValue={row.branchCode}
                    label={column('branch_code')}
                    name="branchCode"
                    options={places.map((b) => ({ value: b.code, label: `${b.code} · ${b.name}` }))}
                    required
                  />
                  <Select
                    defaultValue={row.glAccountId}
                    hint={t('accounts_shared.gl_hint')}
                    label={t('accounts_shared.gl_account')}
                    name="glAccountId"
                    options={[
                      // The one it already holds, so the picker can show it.
                      { value: row.glAccountId, label: `${row.glAccountCode} · ${row.glAccountName}` },
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
