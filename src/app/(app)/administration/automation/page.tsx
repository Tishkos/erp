import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { Pagination, Panel } from '@/components/ui';
import {
  AdminPage,
  Field,
  FilterRow,
  Flash,
  Form,
  ListToolbar,
  NewRecordDialog,
  ReasonForm,
  Select,
  Submit,
  SubmitRow,
  admin as s,
} from '@/components/admin';
import { SectionTabs } from '@/components/admin/section-tabs';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatTimestamp, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { EVENT_KEYS, eventLabelKey, eventOf } from '@/server/domain/automation-events';
import { TEMPLATE_CODES, TEMPLATES } from '@/server/domain/automation-templates';
import { requireContext, withCurrentUser } from '@/server/session';
import * as automation from '@/server/services/automation';
import { createRule, savePauseThreshold, switchAutomation } from './actions';
import { RuleFields } from './rule-form';

/**
 * Automation — platform phase, Agent 10. A settings screen: it copies Numbering
 * (the title and subtitle, the Status panel with its forms, the register in a
 * flush panel with the toolbar and the table), and the runs log under it is a
 * second register of the same kind. Nothing here is drawn that Numbering and the
 * purchase invoice list do not draw already.
 *
 * What is on it: the kill switch and the pause threshold, the rules (a rule is
 * built from a template and is born OFF), the templates, and the runs — each
 * run one line that opens its own page.
 */
export const dynamic = 'force-dynamic';

const OUTCOME_TONE: Readonly<Record<string, string>> = { done: 'posted', skipped: 'draft', failed: 'rejected' };
const OUTCOMES = ['done', 'skipped', 'failed'] as const;
const clip = (value: string, max = 110): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

export default async function AutomationPage({ searchParams }: { searchParams: SearchParams }) {
  const [t, x, page, locale, context, outcome, params] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.automation'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    searchParams,
  ]);
  const { principal } = context;
  if (!can(principal, 'view', automation.PERMISSION_OBJECT)) return <Denied object={page('automation')} />;
  const mayAdminister = can(principal, 'administer', automation.PERMISSION_OBJECT);

  const one = (key: string): string => (typeof params[key] === 'string' ? (params[key] as string) : '');
  const stateParam = automation.isState(one('state')) ? one('state') : '';
  const eventParam = eventOf(one('event')) ? one('event') : '';
  const ruleParam = one('run_rule');
  const outcomeParam = (OUTCOMES as readonly string[]).includes(one('run_outcome')) ? one('run_outcome') : '';
  const runPage = Math.max(1, Number(one('rpage') || '1') || 1);
  const templateParam = one('template');

  const data = await withCurrentUser(async (tx) => ({
    settings: await automation.settings(tx),
    overview: await automation.overview(tx, principal),
    rules: await automation.listRules(tx, principal, { search: outcome.q, state: stateParam ? (stateParam as automation.StateFilter) : null, eventKey: eventParam || null, page: outcome.page }),
    runs: await automation.listRuns(tx, principal, { ruleNo: ruleParam || null, outcome: outcomeParam || null, page: runPage }),
    ruleOptions: await automation.ruleOptions(tx, principal),
    choices: mayAdminister
      ? { roles: await automation.roleChoices(tx), people: await automation.peopleChoices(tx), sections: await automation.sectionChoices(tx, principal) }
      : null,
  }));
  const { settings, overview, rules, runs } = data;

  const when = (iso: string | null) => (iso ? formatTimestamp(iso, locale as Locale) : x('none_yet'));
  const eventLabel = (key: string) => x(`event_${eventLabelKey(key)}`);
  const ruleState = (row: { enabled: boolean; pausedReason: string | null }) => (row.enabled ? 'on' : row.pausedReason ? 'paused' : 'off');
  const STATE_TONE: Readonly<Record<string, string>> = { on: 'posted', off: 'draft', paused: 'rejected' };

  // Each register keeps the other's place in the address: setting one filter does not undo the other.
  const keep = (omit: readonly string[]): Record<string, string> => {
    const kept: Record<string, string> = {};
    for (const key of ['q', 'state', 'event', 'page', 'run_rule', 'run_outcome', 'rpage']) {
      const value = key === 'q' ? outcome.q : one(key);
      if (value && !omit.includes(key)) kept[key] = value;
    }
    return kept;
  };
  const href = (changes: Record<string, string | null>): string => {
    const query = new URLSearchParams({ ...keep([]), ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== null) as [string, string][]) });
    for (const [key, value] of Object.entries(changes)) if (value === null) query.delete(key);
    const text = query.toString();
    return text ? `/administration/automation?${text}` : '/administration/automation';
  };
  const pagination = { label: t('pagination'), previous: t('previous'), next: t('next'), page: (p: number) => t('page_n', { page: p }) };

  const fact = (label: string, value: string, ltr = false) => (
    <li key={label}>
      <span>{label}</span>
      <span>{ltr ? <bdi dir="ltr">{value}</bdi> : value}</span>
    </li>
  );

  return (
    <AdminPage back={{ href: '/', label: t('dashboard_label') }} subtitle={x('subtitle')} tabs={<SectionTabs route="/administration/automation" />} title={x('title')} variant="sap">
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <Panel title={x('status_title')}>
        <ul className={s.profileFacts}>
          <li>
            <span>{settings.enabled ? x('global_on') : x('global_off')}</span>
            <span>
              <span className={`status status--${settings.enabled ? 'posted' : 'rejected'}`} data-status={settings.enabled ? 'posted' : 'rejected'}>
                {settings.enabled ? x('pill_on') : x('pill_off')}
              </span>
            </span>
          </li>
          {overview ? fact(x('fig_rules'), String(overview.rules), true) : null}
          {overview ? fact(x('fig_on'), String(overview.on), true) : null}
          {overview ? fact(x('fig_paused'), String(overview.paused), true) : null}
          {overview ? fact(x('fig_failing'), String(overview.failing), true) : null}
          {overview ? fact(x('fig_failed_week'), String(overview.failedRunsWeek), true) : null}
          {overview ? fact(x('fig_waiting'), String(overview.pendingEvents), true) : null}
          {overview ? fact(x('fig_last_run'), when(overview.lastRunAt), true) : null}
          {fact(x('pause_after'), String(settings.pauseAfterFailures), true)}
        </ul>
        {mayAdminister ? (
          <>
            <ReasonForm
              action={switchAutomation}
              hidden={{ on: settings.enabled ? '0' : '1' }}
              label={settings.enabled ? x('switch_off') : x('switch_on')}
              reasonLabel={x('switch_reason')}
              reasonPlaceholder={x('switch_reason_hint')}
              tone={settings.enabled ? 'danger' : 'primary'}
            />
            <Form action={savePauseThreshold}>
              <FilterRow>
                <Field defaultValue={settings.pauseAfterFailures} label={x('pause_after')} max={20} min={1} name="threshold" required type="number" />
                <SubmitRow>
                  <Submit label={x('pause_save')} tone="secondary" />
                </SubmitRow>
              </FilterRow>
            </Form>
          </>
        ) : null}
      </Panel>

      <Panel flush title={x('rules_title')}>
        <ListToolbar
          clearHref={href({ q: null, page: null })}
          clearLabel={t('clear_search')}
          countLabel={t('rows_shown', { count: rules.total })}
          hidden={keep(['q', 'page'])}
          placeholder={t('search_placeholder')}
          q={outcome.q}
          searchLabel={t('search')}
        />
        <form className={s.filterBar} method="get">
          {Object.entries(keep(['state', 'event', 'page'])).map(([name, value]) => (
            <input key={name} name={name} type="hidden" value={value} />
          ))}
          <FilterRow>
            <Select
              defaultValue={stateParam}
              emptyLabel={x('state_all')}
              id="rules-state"
              label={x('state')}
              name="state"
              options={(['on', 'off', 'paused', 'failing'] as const).map((value) => ({ value, label: x(`state_${value}`) }))}
            />
            <Select
              defaultValue={eventParam}
              emptyLabel={x('event_all')}
              id="rules-event"
              label={x('event')}
              name="event"
              options={EVENT_KEYS.map((key) => ({ value: key, label: eventLabel(key) }))}
            />
            <SubmitRow>
              <Submit label={x('filter')} />
            </SubmitRow>
          </FilterRow>
        </form>
        <div className="table-wrap">
          <table className="list">
            <thead>
              <tr>
                <th scope="col">{x('col_rule')}</th>
                <th scope="col">{x('col_name')}</th>
                <th scope="col">{x('col_event')}</th>
                <th scope="col">{x('col_state')}</th>
                <th scope="col">{x('col_owner')}</th>
                <th scope="col">{x('col_last_run')}</th>
                <th scope="col">{x('col_failures')}</th>
              </tr>
            </thead>
            <tbody>
              {rules.rows.length === 0 ? (
                <tr>
                  <td className={s.sapEmptyRow} colSpan={7}>
                    {x('rules_none')}
                  </td>
                </tr>
              ) : null}
              {rules.rows.map((row) => {
                const state = ruleState(row);
                return (
                  <tr key={row.id}>
                    <td>
                      <Link href={`/administration/automation/${encodeURIComponent(row.ruleNo)}`}>
                        <bdi dir="ltr">{row.ruleNo}</bdi>
                      </Link>
                    </td>
                    <td>
                      <bdi dir="auto">{row.name}</bdi>
                    </td>
                    <td>{eventLabel(row.eventKey)}</td>
                    <td>
                      <span className={`status status--${STATE_TONE[state]}`} data-status={STATE_TONE[state]}>
                        {x(`pill_${state}`)}
                      </span>
                    </td>
                    <td>
                      <bdi dir="auto">{row.ownerName}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.lastRunAt ? when(row.lastRunAt) : '—'}</bdi>
                      {row.lastOutcome ? <span className="muted"> · {x(`outcome_${row.lastOutcome}`)}</span> : null}
                    </td>
                    <td>{row.failedRuns > 0 || row.consecutiveFailures > 0 ? x('failures_cell', { failed: row.failedRuns, streak: row.consecutiveFailures }) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Pagination count={rules.pages} current={rules.page} hrefFor={(p) => href({ page: String(p) })} labels={pagination} locale={locale} />
      </Panel>

      <Panel flush title={x('templates_title')}>
        <div className="table-wrap">
          <table className="list">
            <thead>
              <tr>
                <th scope="col">{x('col_template')}</th>
                <th scope="col">{x('col_event')}</th>
                <th scope="col">{x('col_what')}</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {TEMPLATE_CODES.map((code) => (
                <tr key={code}>
                  <td>{x(`template_${code}`)}</td>
                  <td>{eventLabel(TEMPLATES[code].eventKey)}</td>
                  <td>{x(`template_${code}_what`)}</td>
                  <td>
                    {data.choices ? (
                      <NewRecordDialog
                        buttonLabel={x('use_template')}
                        closeLabel={t('close')}
                        openOnLoad={Boolean(outcome.error) && templateParam === code}
                        title={x('create_title', { template: x(`template_${code}`) })}
                        wide
                      >
                        <Form action={createRule}>
                          <input name="template_code" type="hidden" value={code} />
                          <p className="muted">{x('templates_hint')}</p>
                          <Field id={`new-${code}-name`} label={x('rule_name')} name="name" required wide />
                          <RuleFields choices={data.choices} idPrefix={`new-${code}`} template={code} />
                          <SubmitRow>
                            <Submit label={x('create')} />
                          </SubmitRow>
                        </Form>
                      </NewRecordDialog>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel flush title={x('runs_title')}>
        <form className={s.filterBar} method="get">
          {Object.entries(keep(['run_rule', 'run_outcome', 'rpage'])).map(([name, value]) => (
            <input key={name} name={name} type="hidden" value={value} />
          ))}
          <FilterRow>
            <Select
              defaultValue={ruleParam}
              emptyLabel={x('rule_all')}
              id="runs-rule"
              label={x('rule_filter')}
              name="run_rule"
              options={data.ruleOptions.map((r) => ({ value: r.ruleNo, label: `${r.ruleNo} · ${r.name}` }))}
            />
            <Select
              defaultValue={outcomeParam}
              emptyLabel={x('outcome_all')}
              id="runs-outcome"
              label={x('outcome')}
              name="run_outcome"
              options={OUTCOMES.map((value) => ({ value, label: x(`outcome_${value}`) }))}
            />
            <SubmitRow>
              <Submit label={x('filter')} />
            </SubmitRow>
          </FilterRow>
        </form>
        <div className="table-wrap">
          <table className="list">
            <thead>
              <tr>
                <th scope="col">{x('col_when')}</th>
                <th scope="col">{x('col_rule')}</th>
                <th scope="col">{x('col_record')}</th>
                <th scope="col">{x('col_outcome')}</th>
                <th scope="col">{x('col_reason')}</th>
              </tr>
            </thead>
            <tbody>
              {runs.rows.length === 0 ? (
                <tr>
                  <td className={s.sapEmptyRow} colSpan={5}>
                    {x('runs_none')}
                  </td>
                </tr>
              ) : null}
              {runs.rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <Link href={`/administration/automation/runs/${row.id}`}>
                      <bdi dir="ltr">{when(row.startedAt)}</bdi>
                    </Link>
                  </td>
                  <td>
                    <Link href={`/administration/automation/${encodeURIComponent(row.ruleNo)}`}>
                      <bdi dir="ltr">{row.ruleNo}</bdi>
                    </Link>
                  </td>
                  <td>
                    <bdi dir="ltr">{row.reference}</bdi>
                  </td>
                  <td>
                    <span className={`status status--${OUTCOME_TONE[row.outcome]}`} data-status={OUTCOME_TONE[row.outcome]}>
                      {x(`outcome_${row.outcome}`)}
                    </span>
                  </td>
                  <td>
                    <bdi dir="auto">{clip(row.reason)}</bdi>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pagination count={runs.pages} current={runs.page} hrefFor={(p) => href({ rpage: String(p) })} labels={pagination} locale={locale} />
      </Panel>
    </AdminPage>
  );
}
