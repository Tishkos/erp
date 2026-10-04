import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, FilterRow, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import type { SearchParams } from '@/components/admin/params';
import { SectionTabs } from '@/components/admin/section-tabs';
import { Denied } from '@/components/denied';
import { formatMoney, formatQuantity, formatTimestamp, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import {
  CC_DOMAINS,
  CHECK_STATES,
  STATE_TONE,
  checkKey,
  isCcDomain,
  isCheckState,
  type CheckResult,
  type Figure,
  type Item,
} from '@/server/domain/control-center';
import { requireContext, withCurrentUser } from '@/server/session';
import * as controlCenter from '@/server/services/control-center';
import { formatFacts, render } from '@/server/services/exception-text';

/**
 * ERP Control Center — platform phase, Agent 9. "Is Qimah internally healthy?", asked of the system now.
 *
 * A report screen: the filters as a form of Selects, a summary register, then one stacked section per
 * domain with a register of its checks. Every check shows its state, the figures it compared and — when
 * something needs attention — the first things that do, each with the record that opens. There is no score
 * and no percentage: the headline is how many checks stand in each state. A check the viewer may not read,
 * or that could not answer, says so and why; it is never a green tick.
 *
 * Nothing here fixes, posts, edits or resolves. "Run checks now" is this page asked again: the answer is
 * computed on every request (the time it took is said), and the Exception Center — the system of record
 * for what needs a person — is linked per domain.
 */
export const dynamic = 'force-dynamic';

/** The summary's columns, most urgent first (`domain/control-center.STATE_ORDER`). */
const SUMMARY_STATES = ['attention', 'unavailable', 'not_checked', 'ok'] as const;

export default async function ControlCenterPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/control-center')) notFound();
  const [t, x, page, locale, context, params] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.control_center'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    searchParams,
  ]);
  const { principal } = context;
  if (!can(principal, 'view', controlCenter.PERMISSION_OBJECT)) return <Denied object={page('control_center')} />;

  const place = locale as Locale;
  const one = (name: string) => (typeof params[name] === 'string' ? (params[name] as string) : '');
  const domain = isCcDomain(one('domain')) ? (one('domain') as (typeof CC_DOMAINS)[number]) : null;
  const state = isCheckState(one('state')) ? (one('state') as (typeof CHECK_STATES)[number]) : null;

  const report = await withCurrentUser((tx) =>
    controlCenter.run(tx, { principal, branchCode: context.scope.branchCode, domain }),
  );
  const { summary } = report;
  const shown = report.results.filter((result) => !state || result.state === state);
  const domains = CC_DOMAINS.filter((d) => shown.some((result) => result.domain === d));

  const number = (value: number) => new Intl.NumberFormat(place).format(value);
  const word = (value: string) => {
    // A word from another process ("waiting for QR scan") is looked up as a key, and kept as it is where we have no words for it.
    const key = value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    return key && x.has(`word.${key}`) ? x(`word.${key}`) : value;
  };
  const served = (href: string | null): string | null =>
    href && visibleRoute(href.split('?')[0]!.split('#')[0]!) ? href : null;

  const figureValue = (figure: Figure): string => {
    if (figure.amountIqd != null) return formatMoney(figure.amountIqd, 'IQD', place);
    if (figure.quantity != null) return formatQuantity(figure.quantity, place);
    if (figure.count != null) return number(figure.count);
    // A word from another process (the bridge's state, the cloud connection's) is put into our words where we have them.
    return word(figure.text ?? '') || '—';
  };

  const figureLabel = (figure: Figure): string => (x.has(`figure.${figure.key}`) ? x(`figure.${figure.key}`, { ...(figure.params ?? {}) }) : figure.key);

  const itemText = (item: Item): string => {
    const facts = Object.fromEntries(Object.entries(item.params).map(([name, value]) => [name, name === 'state' || name === 'channel' ? word(String(value)) : value]));
    if (item.detector) return render(place, item.detector, item.params).title;
    const key = `item.${item.code}`;
    return x.has(key) ? x(key, formatFacts(facts, place)) : item.code;
  };

  const reasonText = (result: CheckResult): string => {
    const reason = result.reason;
    if (!reason) return '';
    const key = `reason.${reason.code}`;
    const values: Record<string, string | number> = { ...(reason.params ?? {}) };
    if (typeof values.object === 'string') values.object = x.has(`object.${values.object}`) ? x(`object.${values.object}`) : values.object;
    if (typeof values.what === 'string') values.what = x.has(`what.${values.what}`) ? x(`what.${values.what}`) : values.what;
    return x.has(key) ? x(key, values) : reason.code;
  };

  const tabs = <SectionTabs route="/control-center" />;
  const ranAt = formatTimestamp(report.ranAt, place);

  return (
    <AdminPage
      back={{ href: '/', label: t('dashboard_label') }}
      subtitle={x('subtitle')}
      tabs={tabs}
      title={x('title')}
      variant="sap"
    >
      <p className={s.hint}>{x('read_at', { when: ranAt, ms: number(report.elapsedMs), count: number(report.results.length) })}</p>
      <p className={s.hint}>{report.scope.companyWide ? x('scope_all') : x('scope_branches', { branches: report.scope.branches.join(', ') })}</p>

      <form className={s.filterBar} method="get">
        <FilterRow>
          <Select
            defaultValue={domain ?? ''}
            emptyLabel={x('all_domains')}
            label={x('domain')}
            name="domain"
            options={CC_DOMAINS.map((d) => ({ value: d, label: x(`domain_${d}`) }))}
          />
          <Select
            defaultValue={state ?? ''}
            emptyLabel={x('all_states')}
            label={x('state')}
            name="state"
            options={CHECK_STATES.map((v) => ({ value: v, label: `${x(`state_${v}`)} (${number(summary.byState[v])})` }))}
          />
          <SubmitRow>
            <Submit label={x('run_now')} />
          </SubmitRow>
        </FilterRow>
      </form>

      <section aria-labelledby="cc-summary-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="cc-summary-title">
            <span>{x('summary')}</span>
            <span className={s.sapTitleMeta}>{x('checks_count', { count: number(summary.total) })}</span>
          </h2>
          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="cc-summary-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{x('domain')}</th>
                  {SUMMARY_STATES.map((v) => (
                    <th className={s.sapNum} key={v} scope="col">
                      {x(`state_${v}`)}
                    </th>
                  ))}
                  <th className={s.sapNum} scope="col">{x('open_exceptions')}</th>
                </tr>
              </thead>
              <tbody>
                {report.results.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={6}>{x('none')}</td>
                  </tr>
                ) : null}
                {CC_DOMAINS.filter((d) => summary.byDomain[d] && Object.values(summary.byDomain[d]).some((n) => n > 0)).map((d) => {
                  const counts = summary.byDomain[d];
                  const open = report.exceptions?.byDomain[d];
                  return (
                    <tr key={d}>
                      <td>
                        <Link className={s.sapLink} href={`/control-center?domain=${d}`}>{x(`domain_${d}`)}</Link>
                      </td>
                      {SUMMARY_STATES.map((v) => (
                        <td className={s.sapNum} key={v}>
                          <bdi dir="ltr">{number(counts[v])}</bdi>
                        </td>
                      ))}
                      <td className={s.sapNum}>
                        {open === undefined ? (
                          '—'
                        ) : (
                          <Link className={s.sapLink} href={`/exceptions?domain=${d}`}>
                            <bdi dir="ltr">{number(open)}</bdi>
                          </Link>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {report.exceptions === null ? <p className={s.sectionHint}>{x('exceptions_hidden')}</p> : null}
        </div>
      </section>

      {domains.map((d) => {
        const results = shown.filter((result) => result.domain === d);
        const attention = results.filter((result) => result.state === 'attention').length;
        return (
          <section aria-labelledby={`cc-${d}-title`} className={s.sapDoc} id={d} key={d}>
            <div className={s.sapWindow}>
              <h2 className={s.sapTitle} id={`cc-${d}-title`}>
                <span>{x(`domain_${d}`)}</span>
                <span className={s.sapTitleMeta}>{x('domain_meta', { count: number(results.length), attention: number(attention) })}</span>
              </h2>
              <div className={s.sapTableWrap}>
                <table aria-labelledby={`cc-${d}-title`} className={s.sapTable}>
                  <thead>
                    <tr>
                      <th scope="col">{x('col_check')}</th>
                      <th scope="col">{x('col_state')}</th>
                      <th scope="col">{x('col_evidence')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.map((result) => {
                      const key = checkKey(result.code);
                      const href = result.state === 'not_checked' ? null : served(result.route);
                      const reason = reasonText(result);
                      return [
                        <tr key={result.code}>
                          <td>
                            {href ? (
                              <Link className={s.sapLink} href={href}>
                                <bdi dir="auto">{x(`check.${key}.title`)}</bdi>
                              </Link>
                            ) : (
                              <bdi dir="auto">{x(`check.${key}.title`)}</bdi>
                            )}
                            <br />
                            <span className="muted">{x(`check.${key}.what`)}</span>
                          </td>
                          <td>
                            <span className={`status status--${STATE_TONE[result.state]} ${s.sapRegisterStatus}`} data-status={STATE_TONE[result.state]}>
                              {x(`state_${result.state}`)}
                            </span>
                          </td>
                          <td>
                            {reason ? <span>{reason}</span> : null}
                            {result.figures.length > 0 ? (
                              <span>
                                {result.figures.map((figure, index) => (
                                  <span key={`${figure.key}-${index}`}>
                                    {index > 0 ? <br /> : null}
                                    <bdi dir="auto">{figureLabel(figure)}</bdi>
                                    {': '}
                                    <bdi dir="ltr">{figureValue(figure)}</bdi>
                                  </span>
                                ))}
                              </span>
                            ) : null}
                            {result.state === 'attention' ? (
                              <>
                                <br />
                                <span className="muted">{x('attention_count', { count: number(result.attention) })}</span>
                              </>
                            ) : null}
                          </td>
                        </tr>,
                        ...result.items.map((item, index) => {
                          const itemHref = served(item.href);
                          return (
                            <tr key={`${result.code}|${index}`}>
                              <td colSpan={3}>
                                <bdi dir="auto">{itemText(item)}</bdi>
                                {item.ref ? (
                                  <>
                                    {' '}
                                    {itemHref ? (
                                      <Link className={s.sapLink} href={itemHref}>
                                        <bdi dir="auto">{item.ref}</bdi>
                                      </Link>
                                    ) : (
                                      <bdi dir="auto">{item.ref}</bdi>
                                    )}
                                  </>
                                ) : itemHref ? (
                                  <>
                                    {' '}
                                    <Link className={s.sapLink} href={itemHref}>
                                      {x('open')}
                                    </Link>
                                  </>
                                ) : null}
                              </td>
                            </tr>
                          );
                        }),
                        result.hidden > 0 ? (
                          <tr key={`${result.code}|hidden`}>
                            <td colSpan={3}>
                              <span className="muted">
                                {x('more_items', { count: number(result.hidden) })}{' '}
                                {href ? (
                                  <Link className={s.sapLink} href={href}>
                                    {x('open')}
                                  </Link>
                                ) : null}
                              </span>
                            </td>
                          </tr>
                        ) : null,
                      ];
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        );
      })}
      {shown.length === 0 && report.results.length > 0 ? <p className={s.sectionHint}>{x('none_filtered')}</p> : null}
    </AdminPage>
  );
}
