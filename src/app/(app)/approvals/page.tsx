import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import {
  ActionButton,
  AdminPage,
  FilterRow,
  Flash,
  ListToolbar,
  ReasonForm,
  Select,
  Submit,
  SubmitRow,
  admin as s,
} from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { SectionTabs } from '@/components/admin/section-tabs';
import { Denied } from '@/components/denied';
import { Pagination } from '@/components/ui';
import { formatMoney, formatTimestamp, type Locale } from '@/i18n/config';
import { holdsCapability } from '@/server/domain/dashboard-widgets';
import { can } from '@domain/permissions';
import { requireContext, withCurrentUser } from '@/server/session';
import * as approvalCenter from '@/server/services/approval-center';
import * as approvals from '@/server/services/approvals';
import { approveItem, rejectItem } from './actions';

/**
 * My Approvals — what is waiting on me, and the decision.
 *
 * An action center, not a second approval engine. The list is whatever the
 * person could really act on, gathered by `approval-center` from the workflow
 * engine's own inbox and from the documents that wait in `submitted` for an
 * `approve` grant — each narrowed by the same four-eyes rule its own service
 * enforces, so a document the person raised themselves is never listed for
 * them. Every row opens the real document. The engine's own types (journals,
 * chart accounts, supplier bank details) can also be decided from the row, by
 * calling the service that owns them; everything else is decided on its own page,
 * where its own button lives, and the row says what is required there.
 *
 * Copies the Purchase Invoices register: toolbar, filter row, register table,
 * paging. What the person submitted and decided follow as stacked registers.
 */
export const dynamic = 'force-dynamic';

const humanize = (code: string): string => code.replace(/[._]/g, ' ');

export default async function ApprovalsPage({ searchParams }: { searchParams: SearchParams }) {
  const [t, page, status, column, locale, context, outcome, params] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('status'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    searchParams,
  ]);
  const { principal } = context;
  // The engine's grant, or being somebody a decision waits on (an HR manager decides leave without ever viewing a workflow).
  if (!can(principal, 'view', approvals.PERMISSION_OBJECT) && !holdsCapability(principal, 'approver')) {
    return <Denied object={page('my_approvals')} />;
  }

  const documentType = typeof params.documentType === 'string' ? params.documentType : '';
  // No forced direction: in Arabic a time is words as well as digits, and reads back to front inside a left-to-right island.
  const fmt = (iso: string | null) => (iso ? formatTimestamp(iso, locale as Locale) : '—');
  const statusLabel = (code: string) => (status.has(code) ? status(code) : humanize(code));
  const typeLabel = (type: string) => (t.has(`approvals.type_${type}`) ? t(`approvals.type_${type}`) : humanize(type));
  const stageLabel = (stage: string) => {
    if (stage.startsWith('role:')) return t('approvals.stage_role', { role: humanize(stage.slice(5)) });
    if (t.has(`approvals.stage_${stage}`)) return t(`approvals.stage_${stage}`);
    return statusLabel(stage);
  };
  const actionLabel = (action: string) => (t.has(`approvals.action_${action}`) ? t(`approvals.action_${action}`) : humanize(action));

  const data = await withCurrentUser(async (tx, request) => {
    const center = await approvalCenter.list(
      tx,
      { principal, branchCode: request.scope.branchCode },
      { q: outcome.q, documentType, page: outcome.page },
    );
    const submissions = [];
    for (const x of await approvals.mySubmissions(tx, principal)) {
      submissions.push({ ...x, ref: await approvals.recordReference(tx, x.documentTypeCode, x.documentId) });
    }
    const decisions = [];
    for (const d of await approvals.myDecisions(tx, principal)) {
      decisions.push({ ...d, ref: await approvals.recordReference(tx, d.documentTypeCode, d.documentId) });
    }
    return { center, submissions, decisions };
  });
  const { center } = data;

  // The filter, carried by the decision forms so the person lands back where they were.
  const carried = {
    ...(documentType ? { documentTypeFilter: documentType } : {}),
    ...(outcome.q ? { q: outcome.q } : {}),
    ...(center.page > 1 ? { page: String(center.page) } : {}),
  };
  const query = (target: number) => {
    const next = new URLSearchParams();
    if (outcome.q) next.set('q', outcome.q);
    if (documentType) next.set('documentType', documentType);
    if (target > 1) next.set('page', String(target));
    const text = next.toString();
    return `/approvals${text ? `?${text}` : ''}`;
  };

  const docLink = (ref: { label: string; href: string | null }) =>
    ref.href ? (
      <Link className={s.sapLink} href={ref.href}>
        <bdi dir="ltr">{ref.label}</bdi>
      </Link>
    ) : (
      <bdi dir="ltr">{ref.label}</bdi>
    );

  return (
    <AdminPage
      back={{ href: '/', label: t('dashboard_label') }}
      subtitle={t('approvals.subtitle')}
      tabs={<SectionTabs route="/approvals" />}
      title={t('approvals.title')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <section aria-labelledby="approvals-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="approvals-title">
            <span>{t('approvals.inbox')}</span>
            <span className={s.sapTitleMeta}>{t('rows_shown', { count: center.total })}</span>
          </h2>

          <ListToolbar
            clearHref="/approvals"
            clearLabel={t('clear_search')}
            countLabel={t('rows_shown', { count: center.total })}
            hidden={documentType ? { documentType } : {}}
            placeholder={t('search_placeholder')}
            q={outcome.q}
            searchLabel={t('search')}
          />

          <form className={s.filterBar} method="get">
            {outcome.q ? <input name="q" type="hidden" value={outcome.q} /> : null}
            <FilterRow>
              <Select
                defaultValue={documentType}
                emptyLabel={t('approvals.filter_all')}
                label={t('approvals.filter_type')}
                name="documentType"
                options={center.types.map((type) => ({ value: type, label: typeLabel(type) }))}
              />
              <SubmitRow>
                <Submit label={t('approvals.filter_apply')} />
              </SubmitRow>
            </FilterRow>
          </form>

          {center.unroutable > 0 ? <p className={s.sapNote}>{t('approvals.unroutable', { count: center.unroutable })}</p> : null}
          {center.failed.length > 0 ? <p className={s.sapNote}>{t('approvals.failed_sources', { sources: center.failed.map(humanize).join(', ') })}</p> : null}

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="approvals-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{t('approvals.document')}</th>
                  <th scope="col">{t('approvals.submitted_by')}</th>
                  <th scope="col">{t('approvals.col_type')}</th>
                  <th scope="col">{t('approvals.submitted_at')}</th>
                  <th className={s.sapNum} scope="col">
                    {column('amount')}
                  </th>
                  <th scope="col">{t('approvals.col_stage')}</th>
                  <th scope="col">{t('approvals.col_action')}</th>
                </tr>
              </thead>
              <tbody>
                {center.rows.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={7}>
                      {center.all > 0 ? t('approvals.queue_none_filtered') : t('approvals.queue_none')}
                    </td>
                  </tr>
                ) : null}
                {center.rows.map((item) => (
                  <tr key={item.id}>
                    <td>{docLink({ label: item.documentNo, href: item.href })}</td>
                    <td>
                      <bdi dir="auto">{item.requester ?? '—'}</bdi>
                    </td>
                    <td>{typeLabel(item.documentType)}</td>
                    <td>
                      <bdi>{fmt(item.since)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      {item.amount ? <bdi dir="ltr">{formatMoney(item.amount.value, item.amount.currency, locale as Locale)}</bdi> : '—'}
                    </td>
                    <td>
                      <span className={`status status--submitted ${s.sapRegisterStatus}`} data-status="submitted">
                        {stageLabel(item.stage)}
                      </span>
                    </td>
                    <td>
                      {item.inline ? (
                        <div className={s.inlineRow}>
                          <ActionButton
                            action={approveItem}
                            hidden={{ documentType: item.inline.documentType, documentId: item.inline.documentId, ...carried }}
                            label={t('approvals.approve')}
                            tone="primary"
                          />
                          <ReasonForm
                            action={rejectItem}
                            hidden={{ documentType: item.inline.documentType, documentId: item.inline.documentId, ...carried }}
                            label={t('approvals.reject')}
                            reasonLabel={`${t('approvals.reject_reason')} · ${item.documentNo}`}
                          />
                        </div>
                      ) : (
                        <>
                          {actionLabel(item.action)}
                          {item.href ? (
                            <>
                              {' · '}
                              <Link className={s.sapLink} href={item.href}>
                                {t('approvals.open_to_act')}
                              </Link>
                            </>
                          ) : null}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            count={center.pages}
            current={center.page}
            hrefFor={(target) => query(target)}
            labels={{ label: t('pagination'), previous: t('previous'), next: t('next'), page: (p) => t('page_n', { page: p }) }}
            locale={locale}
          />
        </div>
      </section>

      <section aria-labelledby="approvals-submissions-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="approvals-submissions-title">
            <span>{t('approvals.my_submissions')}</span>
            <span className={s.sapTitleMeta}>{t('rows_shown', { count: data.submissions.length })}</span>
          </h2>
          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="approvals-submissions-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{t('approvals.document')}</th>
                  <th scope="col">{t('approvals.submitted_at')}</th>
                  <th scope="col">{column('status')}</th>
                </tr>
              </thead>
              <tbody>
                {data.submissions.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={3}>
                      {t('approvals.my_submissions_empty')}
                    </td>
                  </tr>
                ) : null}
                {data.submissions.map((x) => {
                  const tone = x.isComplete ? ((x.lastDecision ?? 'approved') === 'rejected' ? 'rejected' : 'approved') : 'submitted';
                  return (
                    <tr key={x.instanceId}>
                      <td>{docLink(x.ref)}</td>
                      <td>
                        <bdi>{fmt(x.submittedAt.toISOString())}</bdi>
                      </td>
                      <td>
                        <span className={`status status--${tone} ${s.sapRegisterStatus}`} data-status={tone}>
                          {x.isComplete ? statusLabel(x.lastDecision ?? 'approved') : t('approvals.pending')}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section aria-labelledby="approvals-decisions-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="approvals-decisions-title">
            <span>{t('approvals.my_decisions')}</span>
            <span className={s.sapTitleMeta}>{t('rows_shown', { count: data.decisions.length })}</span>
          </h2>
          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="approvals-decisions-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{t('approvals.document')}</th>
                  <th scope="col">{t('approvals.decision')}</th>
                  <th scope="col">{t('approvals.decided')}</th>
                </tr>
              </thead>
              <tbody>
                {data.decisions.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={3}>
                      {t('approvals.my_decisions_empty')}
                    </td>
                  </tr>
                ) : null}
                {data.decisions.map((d, index) => {
                  const tone = d.decision === 'rejected' ? 'rejected' : 'approved';
                  return (
                    <tr key={`${d.documentId}-${index}`}>
                      <td>{docLink(d.ref)}</td>
                      <td>
                        <span className={`status status--${tone} ${s.sapRegisterStatus}`} data-status={tone}>
                          {statusLabel(d.decision)}
                        </span>
                        {d.reason ? (
                          <div className="muted">
                            <bdi dir="auto">{d.reason}</bdi>
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <bdi>{fmt(d.decidedAt ? d.decidedAt.toISOString() : null)}</bdi>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </AdminPage>
  );
}
