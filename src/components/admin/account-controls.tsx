import { getTranslations } from 'next-intl/server';
import { Panel } from '@/components/ui';
import { ActionButton, Field, Form, Grid, ReasonForm, Select, Submit, SubmitRow, admin as s } from './index';
import { NewAccountDialog } from './new-account-dialog';
import { linesForType } from '@domain/financial-statements';
import type { AccountNode } from '@domain/chart-of-accounts';
import {
  allowSubAccounts,
  createAccount,
  deactivateAccount,
  setStatementLine,
  updateAccount,
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
 *
 * No currency is asked for: the ledger is kept in IQD (by direction,
 * 2026-08-29), and every posting account opened here holds it.
 */
export async function NewAccountButton({ accounts }: { readonly accounts: readonly PickerAccount[] }) {
  const t = await getTranslations('admin');
  const groups = accounts.filter((a) => a.isGroup && a.isActive);

  return (
    <NewAccountDialog
      create={createAccount}
      defaultParent={groups[0]?.id ?? ''}
      labels={{
        button: t('accounts.new'),
        title: t('accounts.new'),
        close: t('close'),
        parent: t('accounts.parent'),
        parentHint: t('accounts.parent_hint'),
        name: t('accounts.name'),
        kind: t('accounts.kind'),
        kindHint: t('accounts.kind_hint'),
        kindPosting: t('accounts.kind_posting'),
        kindGroup: t('accounts.kind_group'),
        description: t('accounts.description'),
        create: t('create'),
        creating: t('accounts.creating'),
        errorTitle: t('error_title'),
        required: t('required_hint'),
        noParent: groups.length === 0 ? t('accounts.no_parent') : null,
      }}
      parents={accounts.map((account) => {
        const eligible = account.isGroup && account.isActive;
        return {
          value: account.id,
          // Shown so the shape of the chart is visible, but not choosable —
          // otherwise a person picks a posting account and learns it was
          // never allowed only after filling in the rest.
          disabled: !eligible,
          // Non-breaking spaces: a <select> collapses ordinary ones, and the
          // indentation is the only thing that shows the depth.
          label:
            '   '.repeat(Math.max(0, account.level)) +
            `${account.isGroup ? '[+]' : '·'} ${account.code} · ${account.name}` +
            (eligible ? '' : ` — ${t('accounts.parent_not_a_header')}`),
        };
      })}
    />
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
      {/* What may be typed on an account: its name and what it is for. */}
      <Panel title={t('accounts.edit')}>
        <Form action={updateAccount}>
          <input name="id" type="hidden" value={account.id} />
          <input name="code" type="hidden" value={account.code} />
          <Grid>
            <Field defaultValue={account.name} label={t('accounts.name')} name="name" required requiredLabel={t('required_hint')} />
            <Field defaultValue={account.description ?? ''} label={t('accounts.description')} name="description" type="textarea" wide />
          </Grid>
          <SubmitRow>
            <Submit label={t('save')} />
          </SubmitRow>
        </Form>
      </Panel>
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
