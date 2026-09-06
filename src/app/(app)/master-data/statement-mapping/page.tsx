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
import { BALANCE_SIDES, INCOME_ROLES, type StatementFace } from '@domain/financial-statements';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as statementLines from '@/server/services/statement-lines';
import { createLine, deleteLine, moveLine, renameLine, setLineCash, setLineCategory } from './actions';

/**
 * The Statement Mapping — by direction, 2026-09-03.
 *
 * Finance owns the shape of its reports. Four mappings on one screen: the
 * Income Statement's headers and lines, the Balance Sheet's, the Cash Flow
 * classification of every line, and the equity lines the Statement of
 * Changes in Equity reads. Accounts are connected to these lines when the
 * accounts are opened — this screen is where the lines themselves are made.
 *
 * The Income Statement and Balance Sheet keep independent account mappings,
 * so a revenue or expense account can explain the period result on the first
 * and be presented within equity on the second. Cash Flow classifies primary
 * lines, while Changes in Equity reads the Balance Sheet equity mapping.
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

  const label = (code: string, name: string) => (lineT.has(code) ? lineT(code) : name);
  const sideName = (side: string) =>
    side === 'asset' ? t('reports.assets') : side === 'equity' ? t('reports.equity') : t('reports.liabilities');

  const statement: StatementFace = tab === 'balance-sheet' ? 'balance_sheet' : 'income_statement';
  const flat = catalogue.flattened(statement);
  const everyPostingLine = [
    ...catalogue.flattened('balance_sheet'),
    ...catalogue.flattened('income_statement'),
  ].filter((entry) => !entry.line.isHeader);
  const equityLines = catalogue
    .flattened('balance_sheet')
    .filter((entry) => !entry.line.isHeader && entry.line.side === 'equity');
  const headers = flat.filter((entry) => entry.line.isHeader);

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

            {tab === 'income-statement' || tab === 'balance-sheet' ? (
              <>
                <p className={s.sectionHint}>{t('mapping.layout_hint')}</p>
                <table className={s.sapTable}>
                  <thead>
                    <tr>
                      <th scope="col">{t('mapping.line')}</th>
                      <th scope="col">{tab === 'income-statement' ? t('mapping.role') : t('mapping.side')}</th>
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
                          {line.isHeader
                            ? statement === 'balance_sheet' && line.side
                              ? sideName(line.side)
                              : '—'
                            : line.role
                              ? lineT(line.role)
                              : line.side
                                ? sideName(line.side)
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
                      <p className={s.sectionHint}>
                        {tab === 'income-statement' ? t('mapping.new_hint_income') : t('mapping.new_hint_balance')}
                      </p>
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
                            ]}
                          />
                          <Select
                            emptyLabel={t('mapping.parent_top')}
                            label={t('mapping.parent')}
                            name="parentId"
                            options={headers.map((entry) => ({
                              value: entry.line.id,
                              label:
                                '   '.repeat(entry.depth) + label(entry.line.code, entry.line.name),
                            }))}
                          />
                          {statement === 'income_statement' ? (
                            <Select
                              emptyLabel={t('mapping.role_none')}
                              hint={t('mapping.role_hint')}
                              label={t('mapping.role')}
                              name="role"
                              options={INCOME_ROLES.map((role) => ({ value: role, label: lineT(role) }))}
                            />
                          ) : (
                            <Select
                              hint={t('mapping.side_hint')}
                              label={t('mapping.side')}
                              name="side"
                              options={BALANCE_SIDES.map((side) => ({ value: side, label: sideName(side) }))}
                              required
                            />
                          )}
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
                              label:
                                '   '.repeat(entry.depth) + label(entry.line.code, entry.line.name),
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
              </>
            ) : null}

            {tab === 'cash-flow' ? (
              <>
                <p className={s.sectionHint}>{t('mapping.cash_hint')}</p>
                <table className={s.sapTable}>
                  <thead>
                    <tr>
                      <th scope="col">{t('mapping.line')}</th>
                      <th scope="col">{t('mapping.statement')}</th>
                      <th scope="col">{t('mapping.category')}</th>
                      {mayConfigure ? <th scope="col">{t('mapping.actions')}</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {everyPostingLine.map(({ line }) => (
                      <tr className={s.sapAccountRow} key={line.id}>
                        <td>{label(line.code, line.name)}</td>
                        <td>
                          {line.statement === 'income_statement' ? page('income_statement') : page('balance_sheet')}
                        </td>
                        <td>
                          {line.isCash
                            ? t('mapping.is_cash')
                            : line.cashFlowCategory
                              ? t(`reports.cash_${line.cashFlowCategory}`)
                              : '—'}
                        </td>
                        {mayConfigure ? (
                          <td>
                            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                              {!line.isCash ? (
                                <form action={setLineCategory} style={{ display: 'flex', gap: '0.35rem' }}>
                                  <input name="id" type="hidden" value={line.id} />
                                  <input name="tab" type="hidden" value={tab} />
                                  <select className={s.select} defaultValue={line.cashFlowCategory ?? ''} name="category">
                                    <option value="operating">{t('reports.cash_operating')}</option>
                                    <option value="investing">{t('reports.cash_investing')}</option>
                                    <option value="financing">{t('reports.cash_financing')}</option>
                                  </select>
                                  <Submit label={t('save')} small />
                                </form>
                              ) : null}
                              {line.side === 'asset' ? (
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
                            </div>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : null}

            {tab === 'changes-in-equity' ? (
              <>
                <p className={s.sectionHint}>{t('mapping.equity_hint')}</p>
                <table className={s.sapTable}>
                  <thead>
                    <tr>
                      <th scope="col">{t('mapping.line')}</th>
                      <th className={s.sapNum} scope="col">
                        {t('mapping.accounts')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {equityLines.map(({ line, depth }) => (
                      <tr className={s.sapAccountRow} key={line.id}>
                        <td style={{ paddingInlineStart: `${0.6 + depth * 1.25}rem` }}>
                          {label(line.code, line.name)}
                        </td>
                        <td className={s.sapNum}>{counts.get(line.code) ?? 0}</td>
                      </tr>
                    ))}
                    <tr className={s.sapAccountRow}>
                      <td>{t('reports.equity_result')}</td>
                      <td className={s.sapNum}>—</td>
                    </tr>
                  </tbody>
                </table>
                <p className={s.sectionHint} style={{ marginTop: '0.75rem' }}>
                  {t('mapping.equity_note')}
                </p>
              </>
            ) : null}
          </div>
        </div>
      </section>
    </AdminPage>
  );
}
