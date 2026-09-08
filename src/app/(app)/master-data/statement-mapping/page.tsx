import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ActionButton, AdminPage, Flash, LinkButton, admin as s } from '@/components/admin';
import { StatementLineDialog } from '@/components/admin/statement-line-dialog';
import type { SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { can } from '@domain/permissions';
import {
  BALANCE_SIDES,
  CASH_FLOW_CATEGORIES,
  INCOME_ROLES,
  type StatementFace,
} from '@domain/financial-statements';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as statementLines from '@/server/services/statement-lines';
import { createLine, deleteLine, moveLine, updateLine } from './actions';

/**
 * The Statement Mapping — by direction, 2026-09-03.
 *
 * Finance owns the shape of its reports. Four layouts, one per tab: each is a
 * hierarchy of headers and lines, in the order the report prints them, and
 * each is built here. Accounts are mapped to these lines on the account
 * itself — this screen is where the lines exist.
 *
 * All four mappings are independent, because an account has a different
 * answer on each report and none can be worked out from another. What each
 * tab adds beyond a name is the one thing its report's arithmetic needs: the
 * role an income line plays, the side a balance-sheet line prints on, the
 * activity a cash-flow line belongs to.
 *
 * ── The screen is the layout, and nothing else ─────────────────────────────
 * Every change is made where the thing being changed is: New line at the top
 * right, as on every other register, and Up, Down, Edit and Remove on the row
 * itself. The forms that used to sit in panels beneath the table asked a
 * person to find, in a dropdown, the row they were already looking at.
 */
export const dynamic = 'force-dynamic';

const TABS = ['income-statement', 'balance-sheet', 'cash-flow', 'changes-in-equity'] as const;
type Tab = (typeof TABS)[number];

const STATEMENT_OF: Readonly<Record<Tab, StatementFace>> = {
  'income-statement': 'income_statement',
  'balance-sheet': 'balance_sheet',
  'cash-flow': 'cash_flow',
  'changes-in-equity': 'changes_in_equity',
};

export default async function StatementMappingPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/master-data/statement-mapping')) notFound();

  const [t, page, lineT, context, params] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('statement_line'),
    requireContext(),
    searchParams,
  ]);
  if (!can(context.principal, 'view', 'financial_statement')) {
    return <Denied object={page('statement_mapping')} />;
  }
  const mayConfigure = can(context.principal, 'configure', 'financial_statement');

  const requested = typeof params.statement === 'string' ? params.statement : TABS[0];
  const tab: Tab = (TABS as readonly string[]).includes(requested) ? (requested as Tab) : TABS[0];
  const saved = params.saved === '1';
  const error = typeof params.error === 'string' ? params.error : null;

  const { catalogue, counts } = await withCurrentUser(async (tx) => ({
    catalogue: await statementLines.catalogue(tx),
    counts: await statementLines.accountCounts(tx),
  }));

  const statement = STATEMENT_OF[tab];
  const flat = catalogue.flattened(statement);
  const headers = flat.filter((entry) => entry.line.isHeader);

  const sideName = (side: string) =>
    side === 'asset' ? t('reports.assets') : side === 'equity' ? t('reports.equity') : t('reports.liabilities');

  const tabTitle: Record<Tab, string> = {
    'income-statement': page('income_statement'),
    'balance-sheet': page('balance_sheet'),
    'cash-flow': page('cash_flow'),
    'changes-in-equity': page('changes_in_equity'),
  };
  const attributeHead: Record<Tab, string> = {
    'income-statement': t('mapping.role'),
    'balance-sheet': t('mapping.side'),
    'cash-flow': t('mapping.activity'),
    'changes-in-equity': t('mapping.accounts'),
  };

  // The dialog asks the same questions of a new line and of one being edited,
  // so both are handed the same choices to answer them from.
  const choices = {
    roles: INCOME_ROLES.map((role) => ({ value: role, label: lineT(role) })),
    sides: BALANCE_SIDES.map((side) => ({ value: side, label: sideName(side) })),
    activities: CASH_FLOW_CATEGORIES.map((category) => ({
      value: category,
      label: t(`reports.cash_${category}`),
    })),
  };
  const dialogLabels = (open: string, title: string) => ({
    open,
    title,
    close: t('close'),
    name: t('mapping.name'),
    kind: t('mapping.kind'),
    kindLine: t('mapping.kind_line'),
    kindHeader: t('mapping.kind_header'),
    parent: t('mapping.parent'),
    parentTop: t('mapping.parent_top'),
    role: t('mapping.role'),
    side: t('mapping.side'),
    activity: t('mapping.activity'),
    cash: t('mapping.is_cash'),
    save: t('save'),
    required: t('required_hint'),
    systemLine: t('mapping.system'),
  });

  return (
    <AdminPage
      actions={
        mayConfigure ? (
          <StatementLineDialog
            action={createLine}
            activities={choices.activities}
            hidden={{ statement, tab }}
            labels={dialogLabels(t('mapping.new_line'), t('mapping.new_title'))}
            mode="new"
            parents={headers.map((entry) => ({
              value: entry.line.id,
              label: '   '.repeat(entry.depth) + entry.line.name,
            }))}
            roles={choices.roles}
            sides={choices.sides}
            statement={statement}
          />
        ) : null
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/master-data/statement-mapping" />}
      subtitle={t('mapping.subtitle')}
      title={page('statement_mapping')}
      variant="sap"
    >
      <section className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle}>
            <span>
              {page('statement_mapping')} · {tabTitle[tab]}
            </span>
          </h2>

          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', padding: '0.75rem 0.75rem 0' }}>
            {TABS.map((entry) => (
              <LinkButton
                href={`/master-data/statement-mapping?statement=${entry}`}
                key={entry}
                label={tabTitle[entry]}
                small
                tone={entry === tab ? 'primary' : 'secondary'}
              />
            ))}
          </div>

          <div style={{ padding: '0.75rem' }}>
            <Flash error={error} errorTitle={t('error_title')} saved={saved} savedLabel={t('saved')} />

            <table className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{t('mapping.line')}</th>
                  <th scope="col">{attributeHead[tab]}</th>
                  <th className={s.sapNum} scope="col">
                    {t('mapping.accounts')}
                  </th>
                  {mayConfigure ? <th scope="col">{t('mapping.actions')}</th> : null}
                </tr>
              </thead>
              <tbody>
                {flat.map(({ line, depth }) => (
                  <tr className={line.isHeader ? s.sapLineRow : s.sapAccountRow} key={line.id}>
                    <td style={{ paddingInlineStart: `${0.6 + depth * 1.25}rem` }}>
                      {line.isHeader ? <strong>{line.name}</strong> : line.name}
                      {line.isSystem ? <span className={s.sapNote}> · {t('mapping.system')}</span> : null}
                    </td>
                    <td>
                      {line.role
                        ? lineT(line.role)
                        : line.side
                          ? sideName(line.side)
                          : line.isCash
                            ? t('mapping.is_cash')
                            : line.cashFlowCategory
                              ? t(`reports.cash_${line.cashFlowCategory}`)
                              : '—'}
                    </td>
                    <td className={s.sapNum}>{line.isHeader ? '—' : (counts.get(line.code) ?? 0)}</td>
                    {mayConfigure ? (
                      <td>
                        <div
                          style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', alignItems: 'center' }}
                        >
                          <ActionButton
                            action={moveLine}
                            hidden={{ id: line.id, direction: 'up', tab }}
                            label={t('mapping.up')}
                          />
                          <ActionButton
                            action={moveLine}
                            hidden={{ id: line.id, direction: 'down', tab }}
                            label={t('mapping.down')}
                          />
                          <StatementLineDialog
                            action={updateLine}
                            activities={choices.activities}
                            hidden={{ id: line.id, tab }}
                            initial={{
                              name: line.name,
                              kind: line.isHeader ? 'header' : 'line',
                              ...(line.role ? { role: line.role } : {}),
                              ...(line.side ? { side: line.side } : {}),
                              ...(line.cashFlowCategory
                                ? { cashFlowCategory: line.cashFlowCategory }
                                : {}),
                              isCash: line.isCash,
                            }}
                            isSystem={line.isSystem}
                            labels={dialogLabels(t('mapping.edit'), t('mapping.edit_title'))}
                            mode="edit"
                            roles={choices.roles}
                            sides={choices.sides}
                            statement={statement}
                          />
                          {!line.isSystem ? (
                            <ActionButton
                              action={deleteLine}
                              hidden={{ id: line.id, tab }}
                              label={t('mapping.remove')}
                              tone="danger"
                            />
                          ) : null}
                        </div>
                      </td>
                    ) : null}
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
