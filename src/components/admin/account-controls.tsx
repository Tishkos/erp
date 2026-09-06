import { getTranslations } from 'next-intl/server';
import { Panel } from '@/components/ui';
import { ActionButton, Field, Form, Grid, ReasonForm, Select, Submit, SubmitRow, admin as s } from './index';
import { NewAccountDialog } from './new-account-dialog';
import type { StatementFace } from '@domain/financial-statements';
import type { AccountNode } from '@domain/chart-of-accounts';
import {
  allowSubAccounts,
  createAccount,
  deactivateAccount,
  setStatementLines,
  updateAccount,
} from '@/app/(app)/master-data/chart-of-accounts/actions';

/** One line of the mapping, as the pages hand it to these controls. */
export interface MappingLine {
  readonly code: string;
  readonly name: string;
  readonly statement: StatementFace;
  readonly isHeader: boolean;
  readonly depth: number;
  readonly accountTypes: readonly string[];
}

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
export async function NewAccountButton({
  accounts,
  mapping,
}: {
  readonly accounts: readonly PickerAccount[];
  readonly mapping: readonly MappingLine[];
}) {
  const [t, line] = await Promise.all([
    getTranslations('admin'),
    getTranslations('statement_line'),
  ]);
  const groups = accounts.filter((a) => a.isGroup && a.isActive);

  // Every line of the mapping, on both statements, whichever parent is chosen
  // — the same rule as the parent picker above: showing only the eligible
  // ones answers "what may this account take?" and hides the more useful
  // question, "where does everything report?". The dialog disables what the
  // chosen parent's type cannot carry rather than removing it, and headers
  // are shown for shape but never chosen — accounts connect to lines.
  const lines = mapping.map((option) => ({
    value: option.code,
    // The seeded lines keep their translated names; Finance's own lines are
    // printed as Finance named them.
    label:
      '   '.repeat(Math.max(0, option.depth)) +
      (line.has(option.code) ? line(option.code) : option.name),
    section: option.statement === 'income_statement' ? ('profit_or_loss' as const) : ('financial_position' as const),
    accountTypes: option.accountTypes,
    isHeader: option.isHeader,
  }));

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
        statementMappings: t('accounts.statement_mappings'),
        incomeStatementLine: t('accounts.income_statement_line'),
        balanceSheetLine: t('accounts.balance_sheet_line'),
        statementLineHint: t('accounts.statement_line_create_hint'),
        balanceSheetLineHint: t('accounts.balance_sheet_line_hint'),
        balanceSheetLineUnmapped: t('accounts.balance_sheet_line_unmapped'),
        statementLineDefault: t('accounts.statement_line_default'),
        headerNoLine: t('accounts.header_no_line'),
        create: t('create'),
        creating: t('accounts.creating'),
        errorTitle: t('error_title'),
        required: t('required_hint'),
        noParent: groups.length === 0 ? t('accounts.no_parent') : null,
      }}
      lines={lines}
      parents={accounts.map((account) => {
        const eligible = account.isGroup && account.isActive;
        return {
          value: account.id,
          // A child takes its parent's type, so the parent decides which
          // statement lines the new account may report on.
          accountType: account.accountType,
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
 * On one account: its independent statement mappings, whether it may hold
 * sub-accounts, and taking it out of use.
 */
export async function AccountControls({
  account,
  mapping,
  mayConfigure,
}: {
  readonly account: AccountNode;
  readonly mapping: readonly MappingLine[];
  readonly mayConfigure: boolean;
}) {
  const [t, line] = await Promise.all([getTranslations('admin'), getTranslations('statement_line')]);
  if (!mayConfigure) return null;

  const isProfitOrLoss = account.accountType === 'revenue' || account.accountType === 'expense';
  const primaryStatement = isProfitOrLoss ? 'income_statement' : 'balance_sheet';
  const primaryOptions = mapping.filter(
    (entry) =>
      entry.statement === primaryStatement &&
      !entry.isHeader &&
      entry.accountTypes.includes(account.accountType),
  );
  const balanceSheetOptions = isProfitOrLoss
    ? mapping.filter(
        (entry) =>
          entry.statement === 'balance_sheet' &&
          !entry.isHeader &&
          entry.accountTypes.includes(account.accountType),
      )
    : [];

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
          <Panel title={t('accounts.statement_mappings')}>
            <p className={s.sectionHint}>{t('accounts.statement_line_hint')}</p>
            <Form action={setStatementLines}>
              <input name="id" type="hidden" value={account.id} />
              <input name="code" type="hidden" value={account.code} />
              <Grid>
                <Select
                  defaultValue={account.statementLine ?? ''}
                  label={
                    isProfitOrLoss
                      ? t('accounts.income_statement_line')
                      : t('accounts.balance_sheet_line')
                  }
                  name="statementLine"
                  options={[
                    { value: '', label: t('accounts.statement_line_default') },
                    ...primaryOptions.map((option) => ({
                      value: option.code,
                      label: line.has(option.code) ? line(option.code) : option.name,
                    })),
                  ]}
                />
                {isProfitOrLoss ? (
                  <Select
                    defaultValue={account.balanceSheetLine ?? ''}
                    hint={t('accounts.balance_sheet_line_hint')}
                    label={t('accounts.balance_sheet_line')}
                    name="balanceSheetLine"
                    options={[
                      { value: '', label: t('accounts.balance_sheet_line_unmapped') },
                      ...balanceSheetOptions.map((option) => ({
                        value: option.code,
                        label: line.has(option.code) ? line(option.code) : option.name,
                      })),
                    ]}
                  />
                ) : null}
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
        <>
          {/* A header has no line to set, and the person looking for one is
              owed the reason: it reports wherever its accounts do. */}
          <Panel title={t('accounts.statement_mappings')}>
            <p className={s.sectionHint}>{t('accounts.header_no_line')}</p>
          </Panel>
          <Panel title={t('accounts.sub_accounts')}>
            <p className={s.sectionHint}>{t('accounts.is_a_header')}</p>
          </Panel>
        </>
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
