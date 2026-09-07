import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import {
  ActionButton,
  AdminPage,
  Field,
  Flash,
  Form,
  LinkButton,
  Select,
  Submit,
  SubmitRow,
  admin as s,
} from '@/components/admin';
import { Panel } from '@/components/ui';
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
import { createLine, deleteLine, moveLine, renameLine, setLineCash, setLineCategory } from './actions';

/**
 * The Statement Mapping — by direction, 2026-09-03.
 *
 * Finance owns the shape of its reports. Four layouts, one per tab: each is
 * a hierarchy of headers and lines, in the order the report prints them, and
 * each is built here. Accounts are mapped to these lines on the account
 * itself — this screen is where the lines exist.
 *
 * All four mappings are independent, because an account has a different
 * answer on each report and none can be worked out from another. What each
 * tab adds beyond a name is the one thing its report's arithmetic needs: the
 * role an income line plays, the side a balance-sheet line prints on, the
 * activity a cash-flow line belongs to.
 */
export const dynamic = 'force-dynamic';

const TABS = ['income-statement', 'balance-sheet', 'cash-flow', 'changes-in-equity'] as const;
type Tab = (typeof TABS)[number];

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

  // The name is whatever the mapping holds — renaming a line on this very
  // screen has to change what every screen shows, including this one.
  const label = (_code: string, name: string) => name;
  const sideName = (side: string) =>
    side === 'asset' ? t('reports.assets') : side === 'equity' ? t('reports.equity') : t('reports.liabilities');

  const STATEMENT_OF: Record<Tab, StatementFace> = {
    'income-statement': 'income_statement',
    'balance-sheet': 'balance_sheet',
    'cash-flow': 'cash_flow',
    'changes-in-equity': 'changes_in_equity',
  };
  const statement = STATEMENT_OF[tab];
  const flat = catalogue.flattened(statement);
  const headers = flat.filter((entry) => entry.line.isHeader);

  /** The one column each report adds beyond the line's own name. */
  const attributeHead: Record<Tab, string> = {
    'income-statement': t('mapping.role'),
    'balance-sheet': t('mapping.side'),
    'cash-flow': t('mapping.activity'),
    'changes-in-equity': t('mapping.accounts'),
  };
  const layoutHint: Record<Tab, string> = {
    'income-statement': t('mapping.layout_hint'),
    'balance-sheet': t('mapping.layout_hint'),
    'cash-flow': t('mapping.cash_flow_hint'),
    'changes-in-equity': t('mapping.equity_layout_hint'),
  };
  const newHint: Record<Tab, string> = {
    'income-statement': t('mapping.new_hint_income'),
    'balance-sheet': t('mapping.new_hint_balance'),
    'cash-flow': t('mapping.new_hint_cash_flow'),
    'changes-in-equity': t('mapping.new_hint_changes_in_equity'),
  };

  const tabTitle: Record<Tab, string> = {
    'income-statement': page('income_statement'),
    'balance-sheet': page('balance_sheet'),
    'cash-flow': page('cash_flow'),
    'changes-in-equity': page('changes_in_equity'),
  };

  return (
    <AdminPage
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

            <p className={s.sectionHint}>{layoutHint[tab]}</p>
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
                      {line.isHeader ? <strong>{label(line.code, line.name)}</strong> : label(line.code, line.name)}
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
                        <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
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
                          {/* Only the Cash Flow Statement has a pool of cash to
                              name, and only its own lines can be it. */}
                          {tab === 'cash-flow' && !line.isHeader ? (
                            line.isCash ? (
                              <ActionButton
                                action={setLineCash}
                                hidden={{ id: line.id, tab }}
                                label={t('mapping.unmark_cash')}
                              />
                            ) : (
                              <ActionButton
                                action={setLineCash}
                                hidden={{ id: line.id, tab, isCash: 'on' }}
                                label={t('mapping.mark_cash')}
                              />
                            )
                          ) : null}
                          {tab === 'cash-flow' && !line.isHeader && !line.isCash ? (
                            <form action={setLineCategory} style={{ display: 'flex', gap: '0.35rem' }}>
                              <input name="id" type="hidden" value={line.id} />
                              <input name="tab" type="hidden" value={tab} />
                              <select
                                className={s.select}
                                defaultValue={line.cashFlowCategory ?? 'operating'}
                                name="category"
                              >
                                {CASH_FLOW_CATEGORIES.map((category) => (
                                  <option key={category} value={category}>
                                    {t(`reports.cash_${category}`)}
                                  </option>
                                ))}
                              </select>
                              <Submit label={t('save')} small />
                            </form>
                          ) : null}
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

            {mayConfigure ? (
              <div className={s.assignGrid} style={{ marginTop: '1rem' }}>
                <Panel title={t('mapping.new_title')}>
                  <p className={s.sectionHint}>{newHint[tab]}</p>
                  <Form action={createLine}>
                    <input name="statement" type="hidden" value={statement} />
                    <input name="tab" type="hidden" value={tab} />
                    <div className={s.grid}>
                      <Field label={t('mapping.name')} name="name" required requiredLabel={t('required_hint')} />
                      <Select
                        label={t('mapping.kind')}
                        name="kind"
                        options={[
                          { value: 'line', label: t('mapping.kind_line') },
                          { value: 'header', label: t('mapping.kind_header') },
                          ...(tab === 'cash-flow' ? [{ value: 'cash', label: t('mapping.kind_cash') }] : []),
                        ]}
                      />
                      <Select
                        emptyLabel={t('mapping.parent_top')}
                        label={t('mapping.parent')}
                        name="parentId"
                        options={headers.map((entry) => ({
                          value: entry.line.id,
                          label: '   '.repeat(entry.depth) + label(entry.line.code, entry.line.name),
                        }))}
                      />
                      {tab === 'income-statement' ? (
                        <Select
                          emptyLabel={t('mapping.role_none')}
                          hint={t('mapping.role_hint')}
                          label={t('mapping.role')}
                          name="role"
                          options={INCOME_ROLES.map((role) => ({ value: role, label: lineT(role) }))}
                        />
                      ) : null}
                      {tab === 'balance-sheet' ? (
                        <Select
                          hint={t('mapping.side_hint')}
                          label={t('mapping.side')}
                          name="side"
                          options={BALANCE_SIDES.map((side) => ({ value: side, label: sideName(side) }))}
                          required
                        />
                      ) : null}
                      {tab === 'cash-flow' ? (
                        <Select
                          hint={t('mapping.cash_hint')}
                          label={t('mapping.activity')}
                          name="cashFlowCategory"
                          options={CASH_FLOW_CATEGORIES.map((category) => ({
                            value: category,
                            label: t(`reports.cash_${category}`),
                          }))}
                        />
                      ) : null}
                    </div>
                    <SubmitRow>
                      <Submit label={t('create')} />
                    </SubmitRow>
                  </Form>
                </Panel>

                <Panel title={t('mapping.rename_title')}>
                  <p className={s.sectionHint}>{t('mapping.rename_hint')}</p>
                  <Form action={renameLine}>
                    <input name="tab" type="hidden" value={tab} />
                    <div className={s.grid}>
                      <Select
                        label={t('mapping.line')}
                        name="id"
                        options={flat.map((entry) => ({
                          value: entry.line.id,
                          label: '   '.repeat(entry.depth) + label(entry.line.code, entry.line.name),
                        }))}
                        required
                      />
                      <Field label={t('mapping.name')} name="name" required requiredLabel={t('required_hint')} />
                    </div>
                    <SubmitRow>
                      <Submit label={t('save')} />
                    </SubmitRow>
                  </Form>
                </Panel>
              </div>
            ) : null}

            {tab === 'changes-in-equity' ? (
              <p className={s.sectionHint} style={{ marginTop: '0.75rem' }}>
                {t('mapping.equity_note')}
              </p>
            ) : null}
          </div>
        </div>
      </section>
    </AdminPage>
  );
}
