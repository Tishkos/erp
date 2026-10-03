import type { ReactNode } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, admin as s } from '@/components/admin';
import { Band, BandTable, Figure, Figures } from '@/components/admin/dashboard-band';
import { BarList, Chart, GroupedColumns, Legend, StackedBands } from '@/components/admin/charts';
import { documentHref } from '@/components/admin/document-link';
import { formatBusinessDate, formatMoney, formatTimestamp, type Locale } from '@/i18n/config';
import { registerAllLists } from '@/server/lists';
import * as dashboard from '@/server/services/dashboard';
import { optionalContext, withCurrentUser } from '@/server/session';

/**
 * The Dashboard — REQ-DASH-001.
 *
 * It answers one question, in this order: what is waiting for me, where does
 * the money stand, and what is wrong. It is not a report — every figure on it
 * belongs to a screen that has filters, a period and a Print / Export menu, and
 * each figure links to that screen. The dashboard's job is to send you there,
 * not to be a smaller version of it.
 *
 * **There is no one dashboard.** Each band asks the same permission object its
 * own screen asks, so the page composes itself out of what the signed-in person
 * may already see: the CEO gets the audit trail and the result for the year,
 * the Accounting Officer gets neither, and neither of them was configured —
 * both fall out of the grants. That also means the page can never leak: a band
 * is not rendered, rather than rendered and refused.
 *
 * A band with nothing in it is not drawn at all. A heading over an empty box is
 * a promise the screen does not keep, and people learn to scroll past it.
 *
 * The redirect is the one thing the blank version of this page did that
 * mattered: an unauthenticated visitor reaches the sign-in form, not a screen.
 */
export const dynamic = 'force-dynamic';

export default async function Home() {
  const context = await optionalContext();
  if (!context) redirect('/sign-in');

  const [t, column, locale] = await Promise.all([
    getTranslations('admin'),
    getTranslations('column'),
    getLocale(),
  ]);

  registerAllLists();
  const view = await withCurrentUser((tx, request) =>
    dashboard.forPrincipal(tx, request.principal, request.scope.branchCode),
  );

  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);
  const day = (value: string) => formatBusinessDate(value, locale as Locale);
  // Named one by one rather than derived from the bucket's own string: '90+'
  // is not a message key, and `replace` on it produces one that silently does
  // not exist.
  const BUCKET_KEY: Record<string, string> = {
    current: 'bucket_current',
    '1-30': 'bucket_1_30',
    '31-60': 'bucket_31_60',
    '61-90': 'bucket_61_90',
    '90+': 'bucket_over_90',
  };
  const bucketName = (bucket: string) => t(`dashboard.${BUCKET_KEY[bucket] ?? 'bucket_current'}`);
  // Which ramp step each bucket wears. Ordered by how late the money is, so
  // the darkest step always means "90 days and over" whatever the amounts are.
  const BUCKET_STEP: Record<string, number> = { current: 1, '1-30': 2, '31-60': 3, '61-90': 4, '90+': 5 };

  // Said once, at the top: every figure below is this branch, as at this day.
  // A figure whose scope is unstated is a figure nobody can reconcile.
  const subtitle = t('dashboard.as_at', { branch: view.branchCode, date: day(view.asOf) });

  const unreadable = (name: string) => (
    <p className={s.sectionHint} key={name}>
      {t('dashboard.unreadable', { band: name })}
    </p>
  );

  const waiting = view.waiting;
  const attention = view.attention;
  const showAttention = attention !== null && dashboard.hasAttention(attention);

  // ── The charts ───────────────────────────────────────────────────────────
  // Assembled here rather than in the markup so each one can decide for itself
  // whether it has anything to say. A chart of nothing is worse than no chart:
  // it looks like a fault in the data.
  const num = (value: string) => Number(value);
  // The charts carry numbers; the tables under them carry the services own
  // decimal strings. Only the label passes through here, so nothing is added
  // or re-totalled from a rounded figure.
  const chartMoney = (value: number) => money(String(value));
  const monthName = (month: string) =>
    new Date(`${month}-01T00:00:00Z`).toLocaleString(locale, { month: 'short', timeZone: 'UTC' });
  const charts: ReactNode[] = [];

  if (view.monthly && view.monthly.some((row) => num(row.incomeIqd) + num(row.expensesIqd) !== 0)) {
    const income = {
      label: t('dashboard.income'),
      token: '--chart-series-1',
      values: view.monthly.map((row) => num(row.incomeIqd)),
    };
    const expenses = {
      label: t('dashboard.expenses'),
      token: '--chart-series-2',
      values: view.monthly.map((row) => num(row.expensesIqd)),
    };
    charts.push(
      <Chart
        hint={t('dashboard.last_months', { count: view.monthly.length })}
        key="monthly"
        table={
          <table>
            <thead>
              <tr>
                <th scope="col">{column('date')}</th>
                <th scope="col">{t('dashboard.income')}</th>
                <th scope="col">{t('dashboard.expenses')}</th>
                <th scope="col">{t('dashboard.net_result')}</th>
              </tr>
            </thead>
            <tbody>
              {view.monthly.map((row) => (
                <tr key={row.month}>
                  <td>{row.month}</td>
                  <td>{money(row.incomeIqd)}</td>
                  <td>{money(row.expensesIqd)}</td>
                  <td>{money(row.resultIqd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        }
        title={t('dashboard.chart_trading')}
        wide
      >
        <Legend series={[income, expenses]} />
        <GroupedColumns
          format={chartMoney}
          labels={view.monthly.map((row) => monthName(row.month))}
          series={[income, expenses]}
        />
      </Chart>,
    );
  }

  // Owed to us and owed by us, each as one ordered stack. Ageing is a scale,
  // not a set of identities, so this is the one-hue ramp: later is darker.
  for (const [key, ageing, side, href] of [
    ['receivable', view.receivable, t('dashboard.receivable'), '/sales/ar-invoices'],
    ['payable', view.payable, t('dashboard.payable'), '/payables/invoices'],
  ] as const) {
    if (!ageing || ageing.invoices === 0) continue;
    charts.push(
      <Chart
        hint={t('dashboard.of_total', { total: money(ageing.totalIqd) })}
        key={`ageing-${key}`}
        table={
          <table>
            <thead>
              <tr>
                <th scope="col">{t('dashboard.bucket')}</th>
                <th scope="col">{column('document')}</th>
                <th scope="col">{t('dashboard.total_open')}</th>
              </tr>
            </thead>
            <tbody>
              {ageing.buckets.map((row) => (
                <tr key={row.bucket}>
                  <td>{bucketName(row.bucket)}</td>
                  <td>{row.invoices}</td>
                  <td>{money(row.amountIqd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        }
        title={t('dashboard.chart_ageing', { side })}
      >
        <StackedBands
          bands={ageing.buckets.map((row) => ({
            key: row.bucket,
            label: bucketName(row.bucket),
            value: num(row.amountIqd),
            step: BUCKET_STEP[row.bucket] ?? 1,
          }))}
          format={chartMoney}
        />
        <Link className={s.sapPlainLink} href={href}>
          {t('dashboard.open_invoices')}
        </Link>
      </Chart>,
    );
  }

  if (view.balances && view.balances.length > 0) {
    charts.push(
      <Chart
        key="cash"
        table={
          <table>
            <thead>
              <tr>
                <th scope="col">{column('account')}</th>
                <th scope="col">{t('dashboard.balance')}</th>
              </tr>
            </thead>
            <tbody>
              {view.balances.map((row) => (
                <tr key={row.code}>
                  <td>{row.name}</td>
                  <td>{money(row.balanceIqd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        }
        title={t('dashboard.chart_cash')}
      >
        <BarList
          format={chartMoney}
          rows={view.balances.map((row) => ({
            key: row.code,
            label: row.name,
            value: num(row.balanceIqd),
          }))}
        />
      </Chart>,
    );
  }

  if (view.customers && view.customers.length > 0) {
    charts.push(
      <Chart
        hint={t('dashboard.year_to_date')}
        key="customers"
        table={
          <table>
            <thead>
              <tr>
                <th scope="col">{column('customer_name')}</th>
                <th scope="col">{t('dashboard.invoiced')}</th>
              </tr>
            </thead>
            <tbody>
              {view.customers.map((row) => (
                <tr key={row.key}>
                  <td>{row.label}</td>
                  <td>{money(row.amountIqd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        }
        title={t('dashboard.chart_customers')}
      >
        <BarList
          format={chartMoney}
          rows={view.customers.map((row) => ({
            key: row.key,
            label: row.label,
            value: num(row.amountIqd),
          }))}
        />
      </Chart>,
    );
  }

  if (view.stock && view.stock.length > 0) {
    charts.push(
      <Chart
        hint={t('dashboard.at_cost')}
        key="stock"
        table={
          <table>
            <thead>
              <tr>
                <th scope="col">{column('warehouse_name')}</th>
                <th scope="col">{t('dashboard.value')}</th>
              </tr>
            </thead>
            <tbody>
              {view.stock.map((row) => (
                <tr key={row.key}>
                  <td>{row.label}</td>
                  <td>{money(row.amountIqd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        }
        title={t('dashboard.chart_stock')}
      >
        <BarList
          format={chartMoney}
          rows={view.stock.map((row) => ({
            key: row.key,
            label: row.label,
            value: num(row.amountIqd),
          }))}
        />
      </Chart>,
    );
  }

  return (
    <AdminPage subtitle={subtitle} title={t('dashboard.title')} variant="sap">
      {waiting === null ? unreadable(t('dashboard.waiting')) : null}

      {waiting &&
      (waiting.approvals.length > 0 ||
        waiting.unreadNotifications > 0 ||
        waiting.holdsIOwn.length > 0 ||
        waiting.receiptsAwaiting.length > 0 ||
        waiting.dueThisWeek.length > 0 ||
        waiting.leaveAwaiting.length > 0 ||
        waiting.payrollAwaiting.length > 0 ||
        waiting.advancesAwaiting.length > 0 ||
        waiting.reviewsAwaiting.length > 0 ||
        waiting.hiresAwaiting.length > 0 ||
        waiting.requestsAwaiting.length > 0 ||
        waiting.holdsNeedingReason.length > 0) ? (
        <Band
          count={
            waiting.approvals.length +
            waiting.holdsIOwn.length +
            waiting.holdsNeedingReason.length +
            waiting.receiptsAwaiting.length +
            waiting.leaveAwaiting.length +
            waiting.payrollAwaiting.length +
            waiting.advancesAwaiting.length +
            waiting.reviewsAwaiting.length +
            waiting.hiresAwaiting.length +
            waiting.requestsAwaiting.length
          }
          href="/approvals"
          hrefLabel={t('dashboard.open_approvals')}
          title={t('dashboard.waiting')}
        >
          {/* §19.4 — the only dashboard change the requirement makes. */}
          {waiting.holdsNeedingReason.length > 0 ? (
            <BandTable headings={[t('dashboard.holds_need_reason'), column('date'), '']}>
              {waiting.holdsNeedingReason.map((hold) => (
                <tr key={`nr:${hold.payableNo}:${hold.laneCode}`}>
                  <td className={s.sapAccountCell}>
                    <Link href={`/payables/${encodeURIComponent(hold.payableNo)}`}>
                      <bdi dir="ltr">{hold.payableNo}</bdi>
                    </Link>{' '}
                    · {t.has(`payables.lane_${hold.laneCode}`) ? t(`payables.lane_${hold.laneCode}`) : hold.laneCode}
                  </td>
                  <td>
                    <bdi dir="ltr">
                      {formatTimestamp(new Date(hold.startedAt).toISOString(), locale as Locale)}
                    </bdi>
                  </td>
                  <td>
                    <Link href="/payables?stopped=needs_reason">
                      {t('dashboard.open_payables')}
                    </Link>
                  </td>
                </tr>
              ))}
            </BandTable>
          ) : null}

          {waiting.holdsIOwn.length > 0 ? (
            <BandTable
              headings={[t('dashboard.holds_i_own'), t('dashboard.next_action'), column('date')]}
            >
              {waiting.holdsIOwn.map((hold) => (
                <tr key={`own:${hold.payableNo}:${hold.laneCode}:${hold.reasonCode}`}>
                  <td className={s.sapAccountCell}>
                    <Link href={`/payables/${encodeURIComponent(hold.payableNo)}`}>
                      <bdi dir="ltr">{hold.payableNo}</bdi>
                    </Link>{' '}
                    · {hold.reasonCode}
                  </td>
                  <td>{hold.nextAction ?? '—'}</td>
                  <td>
                    <bdi dir="ltr">{hold.nextActionDue ?? '—'}</bdi>
                  </td>
                </tr>
              ))}
            </BandTable>
          ) : null}
          {/* §21.13 — the department's inbox, surfaced where the day starts. */}
          {waiting.receiptsAwaiting.length > 0 ? (
            <BandTable
              headings={[t('dashboard.receipts_awaiting'), column('date'), '']}
            >
              {waiting.receiptsAwaiting.map((receipt) => (
                <tr key={`sr:${receipt.receiptNo}`}>
                  <td className={s.sapAccountCell}>
                    <bdi dir="ltr">{receipt.receiptNo}</bdi>
                    {receipt.belongsTo ? (
                      <>
                        {' · '}
                        <bdi dir="ltr">{receipt.belongsTo}</bdi>
                      </>
                    ) : null}
                  </td>
                  <td>
                    <bdi dir="ltr">{receipt.serviceDate}</bdi>
                  </td>
                  <td>
                    <Link href="/payables/service-receipts">
                      {t('dashboard.open_service_receipts')}
                    </Link>
                  </td>
                </tr>
              ))}
            </BandTable>
          ) : null}

          {/* REQ-HR-001 HR-2 — leave waiting for my decision. */}
          {waiting.leaveAwaiting.length > 0 ? (
            <BandTable headings={[t('dashboard.leave_awaiting'), column('date'), '']}>
              {waiting.leaveAwaiting.map((request) => (
                <tr key={`lv:${request.requestNo}`}>
                  <td className={s.sapAccountCell}>
                    <Link href={`/hr/leave/${encodeURIComponent(request.requestNo)}`}>
                      <bdi dir="ltr">{request.requestNo}</bdi>
                    </Link>{' '}
                    · <bdi dir="auto">{request.fullNameEn}</bdi>
                  </td>
                  <td>
                    <bdi dir="ltr">{`${request.fromDate} → ${request.toDate}`}</bdi>
                  </td>
                  <td>
                    <Link href={`/hr/leave/${encodeURIComponent(request.requestNo)}`}>{t('dashboard.open_leave')}</Link>
                  </td>
                </tr>
              ))}
            </BandTable>
          ) : null}

          {/* REQ-HR-001 HR-3 — payroll waiting for me: to approve, to post, to pay. */}
          {waiting.payrollAwaiting.length > 0 ? (
            <BandTable headings={[t('dashboard.payroll_awaiting'), column('amount'), '']}>
              {waiting.payrollAwaiting.map((run) => (
                <tr key={`pr:${run.runNo}`}>
                  <td className={s.sapAccountCell}>
                    <Link href={`/hr/payroll/${encodeURIComponent(run.runNo)}`}>
                      <bdi dir="ltr">{run.runNo}</bdi>
                    </Link>{' '}
                    · <bdi dir="ltr">{`${run.branchCode} ${run.month}`}</bdi> · {t(`dashboard.payroll_action_${run.action}`)}
                  </td>
                  <td>
                    <bdi dir="ltr">{formatMoney(run.netIqd, 'IQD', locale as Locale)}</bdi>
                  </td>
                  <td>
                    <Link href={`/hr/payroll/${encodeURIComponent(run.runNo)}`}>{t('dashboard.open_payroll')}</Link>
                  </td>
                </tr>
              ))}
            </BandTable>
          ) : null}

          {/* REQ-HR-001 HR-4 — advances and loans waiting for me: to endorse, to approve, to pay. */}
          {waiting.advancesAwaiting.length > 0 ? (
            <BandTable headings={[t('dashboard.advances_awaiting'), column('amount'), '']}>
              {waiting.advancesAwaiting.map((advance) => (
                <tr key={`ea:${advance.advanceNo}`}>
                  <td className={s.sapAccountCell}>
                    <Link href={`/hr/advances/${encodeURIComponent(advance.advanceNo)}`}>
                      <bdi dir="ltr">{advance.advanceNo}</bdi>
                    </Link>{' '}
                    · <bdi dir="auto">{advance.fullNameEn}</bdi> · {t(`dashboard.advance_action_${advance.action}`)}
                  </td>
                  <td>
                    <bdi dir="ltr">{formatMoney(advance.amountIqd, 'IQD', locale as Locale)}</bdi>
                  </td>
                  <td>
                    <Link href={`/hr/advances/${encodeURIComponent(advance.advanceNo)}`}>{t('dashboard.open_advance')}</Link>
                  </td>
                </tr>
              ))}
            </BandTable>
          ) : null}

          {/* REQ-HR-001 HR-5 — reviews waiting for me: to rate, to sign off, to read and answer. */}
          {waiting.reviewsAwaiting.length > 0 ? (
            <BandTable headings={[t('dashboard.reviews_awaiting'), t('dashboard.review_cycle'), '']}>
              {waiting.reviewsAwaiting.map((review) => (
                <tr key={`rv:${review.reviewNo}`}>
                  <td className={s.sapAccountCell}>
                    <Link href={`/hr/performance/${encodeURIComponent(review.reviewNo)}`}>
                      <bdi dir="ltr">{review.reviewNo}</bdi>
                    </Link>{' '}
                    · <bdi dir="auto">{review.fullNameEn}</bdi> · {t(`dashboard.review_action_${review.action}`)}
                  </td>
                  <td>
                    <bdi dir="ltr">{review.cycleCode}</bdi>
                  </td>
                  <td>
                    <Link href={`/hr/performance/${encodeURIComponent(review.reviewNo)}`}>{t('dashboard.open_review')}</Link>
                  </td>
                </tr>
              ))}
            </BandTable>
          ) : null}

          {/* REQ-HR-001 HR-5 — offers made, waiting for the hire. */}
          {waiting.hiresAwaiting.length > 0 ? (
            <BandTable headings={[t('dashboard.hires_awaiting'), t('dashboard.vacancy'), '']}>
              {waiting.hiresAwaiting.map((offer) => (
                <tr key={`hi:${offer.applicantNo}`}>
                  <td className={s.sapAccountCell}>
                    <Link href={`/hr/recruitment/applicants/${encodeURIComponent(offer.applicantNo)}`}>
                      <bdi dir="ltr">{offer.applicantNo}</bdi>
                    </Link>{' '}
                    · <bdi dir="auto">{offer.fullNameEn}</bdi>
                  </td>
                  <td>
                    <bdi dir="ltr">{offer.vacancyNo}</bdi>
                  </td>
                  <td>
                    <Link href={`/hr/recruitment/applicants/${encodeURIComponent(offer.applicantNo)}`}>{t('dashboard.open_applicant')}</Link>
                  </td>
                </tr>
              ))}
            </BandTable>
          ) : null}

          {/* REQ-HR-001 HR-6 — employee requests waiting for me: to decide, to reimburse, to issue. */}
          {waiting.requestsAwaiting.length > 0 ? (
            <BandTable headings={[t('dashboard.requests_awaiting'), column('amount'), '']}>
              {waiting.requestsAwaiting.map((request) => (
                <tr key={`rq:${request.requestNo}`}>
                  <td className={s.sapAccountCell}>
                    <Link href={`/hr/requests/${encodeURIComponent(request.requestNo)}`}>
                      <bdi dir="ltr">{request.requestNo}</bdi>
                    </Link>{' '}
                    · <bdi dir="auto">{request.fullNameEn}</bdi> · {t(`dashboard.request_action_${request.action}`)}
                  </td>
                  <td>{request.kind === 'expense_claim' ? <bdi dir="ltr">{formatMoney(request.amountIqd, 'IQD', locale as Locale)}</bdi> : <bdi dir="auto">{request.subject}</bdi>}</td>
                  <td>
                    <Link href={`/hr/requests/${encodeURIComponent(request.requestNo)}`}>{t('dashboard.open_request')}</Link>
                  </td>
                </tr>
              ))}
            </BandTable>
          ) : null}

          {/* §21.13 — what falls due in the next seven days. */}
          {waiting.dueThisWeek.length > 0 ? (
            <BandTable
              headings={[t('dashboard.due_this_week'), column('date'), column('amount')]}
            >
              {waiting.dueThisWeek.map((due) => (
                <tr key={`due:${due.payableNo}`}>
                  <td className={s.sapAccountCell}>
                    <Link href={`/payables/${encodeURIComponent(due.payableNo)}`}>
                      <bdi dir="ltr">{due.payableNo}</bdi>
                    </Link>{' '}
                    · <bdi dir="auto">{due.supplierName}</bdi>
                  </td>
                  <td>
                    <bdi dir="ltr">{due.dueDate}</bdi>
                  </td>
                  <td>
                    <bdi dir="ltr">
                      {formatMoney(due.amountTxn, due.currency, locale as Locale)}
                    </bdi>
                  </td>
                </tr>
              ))}
            </BandTable>
          ) : null}

          {waiting.unreadNotifications > 0 ? (
            <Figures>
              <Figure
                label={t('dashboard.unread_notifications')}
                value={waiting.unreadNotifications}
              />
            </Figures>
          ) : null}

          {waiting.approvals.length > 0 ? (
            <BandTable
              headings={[column('document_type'), column('raised_by'), t('dashboard.waiting_since')]}
            >
              {waiting.approvals.map((item) => {
                const href = documentHref(item.documentTypeCode, item.documentId);
                const label = item.documentTypeCode.replace(/_/g, ' ');
                return (
                  <tr key={`${item.documentTypeCode}:${item.documentId}`}>
                    <td className={s.sapAccountCell}>
                      {href ? <Link href={href}>{label}</Link> : label}
                    </td>
                    <td>
                      <bdi dir="auto">{item.submittedByName ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">
                        {formatTimestamp(item.submittedAt.toISOString(), locale as Locale)}
                      </bdi>
                    </td>
                  </tr>
                );
              })}
            </BandTable>
          ) : null}
        </Band>
      ) : null}

      {view.result ? (
        <Band
          href="/finance/income-statement"
          hrefLabel={t('dashboard.open_statement')}
          title={t('dashboard.result', { from: day(view.result.from), to: day(view.result.to) })}
        >
          <Figures>
            <Figure
              href="/finance/income-statement"
              label={t('dashboard.income')}
              value={money(view.result.income)}
            />
            <Figure
              href="/finance/income-statement"
              label={t('dashboard.expenses')}
              value={money(view.result.expenses)}
            />
            <Figure
              href="/finance/income-statement"
              label={t('dashboard.net_result')}
              value={money(view.result.result)}
            />
          </Figures>
        </Band>
      ) : null}

      {view.balances && view.balances.length > 0 ? (
        <Band
          count={view.balances.length}
          href="/master-data/bank-accounts"
          hrefLabel={t('dashboard.open_accounts')}
          title={t('dashboard.cash_position')}
        >
          <Figures>
            {view.balances.map((account) => (
              <Figure
                href={
                  account.kind === 'bank'
                    ? `/master-data/bank-accounts/${encodeURIComponent(account.code)}`
                    : `/master-data/cash-accounts/${encodeURIComponent(account.code)}`
                }
                key={account.code}
                label={account.name}
                value={money(account.balanceIqd)}
              />
            ))}
          </Figures>
        </Band>
      ) : null}

      {view.receivable && view.receivable.invoices > 0 ? (
        <Band
          count={view.receivable.invoices}
          href="/sales/ar-invoices"
          hrefLabel={t('dashboard.open_invoices')}
          title={t('dashboard.receivable')}
        >
          <Figures>
            <Figure label={t('dashboard.total_open')} value={money(view.receivable.totalIqd)} />
            {view.receivable.buckets.map((row) => (
              <Figure
                key={row.bucket}
                label={bucketName(row.bucket)}
                tone={row.bucket === 'current' ? undefined : 'warn'}
                value={money(row.amountIqd)}
              />
            ))}
          </Figures>
        </Band>
      ) : null}

      {view.payable && view.payable.invoices > 0 ? (
        <Band
          count={view.payable.invoices}
          href="/payables/invoices"
          hrefLabel={t('dashboard.open_invoices')}
          title={t('dashboard.payable')}
        >
          <Figures>
            <Figure label={t('dashboard.total_open')} value={money(view.payable.totalIqd)} />
            {view.payable.buckets.map((row) => (
              <Figure
                key={row.bucket}
                label={bucketName(row.bucket)}
                tone={row.bucket === 'current' ? undefined : 'warn'}
                value={money(row.amountIqd)}
              />
            ))}
          </Figures>
        </Band>
      ) : null}

      {showAttention ? (
        <Band title={t('dashboard.attention')}>
          <BandTable headings={[t('dashboard.finding'), t('dashboard.where_fixed')]}>
            {attention.integrityFindings.map((finding) => (
              <tr key={finding}>
                <td>{finding}</td>
                <td className={s.sapAccountCell}>
                  <Link href="/inventory/stock-ledger">{t('dashboard.stock_ledger')}</Link>
                </td>
              </tr>
            ))}
            {attention.unidentifiedReceipts > 0 ? (
              <tr>
                <td>
                  {t('dashboard.unidentified_receipts', { count: attention.unidentifiedReceipts })}
                </td>
                <td className={s.sapAccountCell}>
                  <Link href="/sales/customer-receipts">{t('dashboard.receipts')}</Link>
                </td>
              </tr>
            ) : null}
            {attention.accountsWithoutLedger.map((code) => (
              <tr key={code}>
                <td>{t('dashboard.account_without_ledger', { code })}</td>
                <td className={s.sapAccountCell}>
                  <Link href="/master-data/bank-accounts">{t('dashboard.bank_accounts')}</Link>
                </td>
              </tr>
            ))}
          </BandTable>
        </Band>
      ) : null}

      {charts.length > 0 ? (
        <Band title={t('dashboard.charts')}>
          <div className={s.chartGrid}>{charts}</div>
        </Band>
      ) : null}

      {view.activity && view.activity.length > 0 ? (
        <Band
          href="/administration/audit"
          hrefLabel={t('dashboard.open_audit')}
          title={t('dashboard.activity')}
        >
          <BandTable
            headings={[column('date'), t('dashboard.event'), column('raised_by'), column('status')]}
          >
            {view.activity.map((event, index) => (
              <tr key={`${event.occurredAt}-${index}`}>
                <td>
                  <bdi dir="ltr">{formatTimestamp(event.occurredAt, locale as Locale)}</bdi>
                </td>
                <td>{event.action.replace(/[._]/g, ' ')}</td>
                <td>
                  <bdi dir="auto">{event.actor}</bdi>
                </td>
                <td>{t.has(`audit.outcome.${event.outcome}`) ? t(`audit.outcome.${event.outcome}`) : event.outcome}</td>
              </tr>
            ))}
          </BandTable>
        </Band>
      ) : null}
    </AdminPage>
  );
}
