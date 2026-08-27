import { getTranslations } from 'next-intl/server';
import { Panel } from '@/components/ui';
import {
  ActionButton,
  Field,
  Form,
  Grid,
  NewRecordDialog,
  ReasonForm,
  Select,
  Submit,
  SubmitRow,
  admin as s,
} from './index';
import { linesForType } from '@domain/financial-statements';
import type { AccountNode } from '@domain/chart-of-accounts';
import {
  allowSubAccounts,
  createAccount,
  deactivateAccount,
  setStatementLine,
} from '@/app/(app)/master-data/chart-of-accounts/actions';

/** One row of the parent picker: where it sits, and whether it can hold children. */
export interface PickerAccount {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly accountType: string;
  readonly isGroup: boolean;
  readonly isActive: boolean;
  readonly level: number;
}

/**
 * Raising an account — Phase 1 requirement 1.
 *
 * The picker shows the **whole** chart, indented, not only the accounts that
 * can be a parent. Showing only the eligible ones answers "where can this go?"
 * and hides the more useful question, "where does it go?" — a person looking
 * for Head Office Cash at Bank needs to see it, and to be told plainly that it
 * holds no sub-accounts yet rather than to wonder why it is missing.
 */
export async function NewAccountButton({
  accounts,
  currencies,
  openOnLoad = false,
}: {
  readonly accounts: readonly PickerAccount[];
  /** Active currencies from the master — the same list every other screen offers. */
  readonly currencies: readonly { readonly code: string; readonly name: string }[];
  readonly openOnLoad?: boolean;
}) {
  const t = await getTranslations('admin');
  const groups = accounts.filter((a) => a.isGroup && a.isActive);

  return (
    <NewRecordDialog
      buttonLabel={t('accounts.new')}
      closeLabel={t('close')}
      openOnLoad={openOnLoad}
      title={t('accounts.new')}
    >
      <Form action={createAccount}>
        <Grid>
          <Select
            defaultValue={groups[0]?.id ?? ''}
            hint={t('accounts.parent_hint')}
            label={t('accounts.parent')}
            name="parentId"
            options={accounts.map((account) => {
              const eligible = account.isGroup && account.isActive;
              return {
                value: account.id,
                // Shown so the shape of the chart is visible, but not
                // choosable — otherwise a person picks a posting account and
                // learns it was never allowed only after filling in the rest.
                disabled: !eligible,
                // Non-breaking spaces: a <select> collapses ordinary ones, and
                // the indentation is the only thing that shows the depth.
                label:
                  '   '.repeat(Math.max(0, account.level)) +
                  `${account.isGroup ? '[+]' : '·'} ${account.code} · ${account.name}` +
                  (eligible ? '' : ` — ${t('accounts.parent_not_a_header')}`),
              };
            })}
            required
          />
          <Field
            label={t('accounts.name')}
            name="name"
            required
            requiredLabel={t('required_hint')}
          />
          <Select
            hint={t('accounts.kind_hint')}
            label={t('accounts.kind')}
            name="isGroup"
            options={[
              { value: 'posting', label: t('accounts.kind_posting') },
              { value: 'group', label: t('accounts.kind_group') },
            ]}
          />
          <Select
            defaultValue="IQD"
            hint={t('accounts.currency_hint')}
            label={t('accounts.currency')}
            name="currencyRestriction"
            options={currencies.map((c) => ({ value: c.code, label: `${c.code} · ${c.name}` }))}
          />
          <Field label={t('accounts.description')} name="description" type="textarea" wide />
        </Grid>
        <SubmitRow>
          <Submit label={t('create')} />
        </SubmitRow>
      </Form>
      {groups.length === 0 ? <p className={s.sectionHint}>{t('accounts.no_parent')}</p> : null}
    </NewRecordDialog>
  );
}

/**
 * On one account: the statement line it reports on, whether it may hold
 * sub-accounts, and taking it out of use.
 */
export async function AccountControls({
  account,
  mayConfigure,
}: {
  readonly account: AccountNode;
  readonly mayConfigure: boolean;
}) {
  const [t, line] = await Promise.all([getTranslations('admin'), getTranslations('statement_line')]);
  if (!mayConfigure) return null;

  const options = linesForType(account.accountType);

  return (
    <div className={s.assignGrid}>
      {!account.isGroup ? (
        <>
          <Panel title={t('accounts.statement_line')}>
            <p className={s.sectionHint}>{t('accounts.statement_line_hint')}</p>
            <Form action={setStatementLine}>
              <input name="id" type="hidden" value={account.id} />
              <input name="code" type="hidden" value={account.code} />
              <Grid>
                <Select
                  defaultValue={account.statementLine ?? ''}
                  label={t('accounts.statement_line')}
                  name="statementLine"
                  options={[
                    { value: '', label: t('accounts.statement_line_default') },
                    ...options.map((option) => ({ value: option.code, label: line(option.code) })),
                  ]}
                />
              </Grid>
              <SubmitRow>
                <Submit label={t('save')} />
              </SubmitRow>
            </Form>
          </Panel>

          {/* The way to hang sub-accounts under an account that was opened as a
              posting one. Refused once it has been posted to — see the service. */}
          <Panel title={t('accounts.sub_accounts')}>
            <p className={s.sectionHint}>{t('accounts.sub_accounts_hint')}</p>
            <ActionButton
              action={allowSubAccounts}
              hidden={{ id: account.id, code: account.code }}
              label={t('accounts.allow_sub_accounts')}
              small={false}
              tone="secondary"
            />
          </Panel>
        </>
      ) : (
        <Panel title={t('accounts.sub_accounts')}>
          <p className={s.sectionHint}>{t('accounts.is_a_header')}</p>
        </Panel>
      )}

      {account.isActive ? (
        <Panel title={t('accounts.deactivate')}>
          <p className={s.sectionHint}>{t('accounts.deactivate_hint')}</p>
          <ReasonForm
            action={deactivateAccount}
            hidden={{ id: account.id, code: account.code }}
            label={t('accounts.deactivate')}
            reasonLabel={t('reason')}
            reasonPlaceholder={t('reason_placeholder')}
          />
        </Panel>
      ) : null}
    </div>
  );
}
