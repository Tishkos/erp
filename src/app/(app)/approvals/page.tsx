import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { CheckCircle2, ClipboardCheck, Inbox, Send } from 'lucide-react';
import { Panel } from '@/components/ui';
import { ActionButton, AdminPage, Flash, Pill, ReasonForm, admin as s } from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatTimestamp, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { requireContext, withCurrentUser } from '@/server/session';
import * as approvals from '@/server/services/approvals';
import { approveFromInbox, rejectFromInbox } from './actions';

/**
 * My Approvals — Phase 0 requirement 6.
 *
 * Three numbers at the top (waiting, submitted, decided), then the inbox as
 * a list of decision rows — each with the document, where it came from and
 * the two things an approver can do — followed by the person's own
 * submissions and decisions.
 */
export const dynamic = 'force-dynamic';

export default async function ApprovalsPage({ searchParams }: { searchParams: SearchParams }) {
  const [t, page, status, locale, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('status'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', approvals.PERMISSION_OBJECT)) {
    return <Denied object={page('my_approvals')} />;
  }
  const fmt = (d: Date | null) => (d ? formatTimestamp(d.toISOString(), locale as Locale) : t('none'));
  const statusLabel = (x: string) => {
    try {
      return status(x);
    } catch {
      return x;
    }
  };

  const data = await withCurrentUser(async (tx) => {
    const inbox = [];
    for (const item of await approvals.inbox(tx, principal)) {
      inbox.push({ ...item, ref: await approvals.recordReference(tx, item.documentTypeCode, item.documentId) });
    }
    const submissions = [];
    for (const x of await approvals.mySubmissions(tx, principal)) {
      submissions.push({ ...x, ref: await approvals.recordReference(tx, x.documentTypeCode, x.documentId) });
    }
    const decisions = [];
    for (const d of await approvals.myDecisions(tx, principal)) {
      decisions.push({ ...d, ref: await approvals.recordReference(tx, d.documentTypeCode, d.documentId) });
    }
    return { inbox, submissions, decisions };
  });

  const docLink = (ref: { label: string; href: string | null }) =>
    ref.href ? <Link href={ref.href}>{ref.label}</Link> : <span className={s.mono}>{ref.label}</span>;

  return (
    <AdminPage back={{ href: '/', label: t('dashboard_label') }} subtitle={t('approvals.subtitle')} title={t('approvals.title')} variant="sap">
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <div className={s.statRow}>
        <div className={s.stat}>
          <span className={s.statIcon}>
            <Inbox aria-hidden="true" />
          </span>
          <div>
            <strong>{data.inbox.length}</strong>
            <span>{t('approvals.inbox')}</span>
          </div>
        </div>
        <div className={s.stat}>
          <span className={s.statIcon}>
            <Send aria-hidden="true" />
          </span>
          <div>
            <strong>{data.submissions.filter((x) => !x.isComplete).length}</strong>
            <span>{t('approvals.pending')}</span>
          </div>
        </div>
        <div className={s.stat}>
          <span className={s.statIcon}>
            <CheckCircle2 aria-hidden="true" />
          </span>
          <div>
            <strong>{data.decisions.length}</strong>
            <span>{t('approvals.my_decisions')}</span>
          </div>
        </div>
      </div>

      <Panel flush title={t('approvals.inbox')}>
        {data.inbox.length === 0 ? (
          <div className={s.emptyState}>
            <ClipboardCheck aria-hidden="true" />
            <strong>{t('approvals.inbox_empty')}</strong>
          </div>
        ) : (
          <div className={s.inboxList}>
            {data.inbox.map((item) => (
              <article className={s.inboxItem} key={item.instanceId}>
                <div className={s.inboxDoc}>
                  <span className={s.inboxKind}>{item.documentTypeCode}</span>
                  {/* Clickable, always: an approver reads the document before
                      deciding on it, and this is the way in. */}
                  {docLink(item.ref)}
                  <span className={s.inboxWaiting}>
                    {t('approvals.waiting_on_you')}
                  </span>
                </div>
                <dl className={s.inboxFacts}>
                  <div>
                    <dt>{t('approvals.submitted_by')}</dt>
                    <dd>{item.submittedByName ?? item.submittedBy}</dd>
                  </div>
                  <div>
                    <dt>{t('approvals.submitted_at')}</dt>
                    <dd>{fmt(item.submittedAt)}</dd>
                  </div>
                  <div>
                    <dt>{t('approvals.department')}</dt>
                    <dd>
                      {item.departmentCode ?? t('none')}
                      {item.approverRole ? ` · ${item.approverRole}` : ''}
                    </dd>
                  </div>
                </dl>
                <div className={s.inboxDecide}>
                  <ActionButton
                    action={approveFromInbox}
                    hidden={{ documentTypeCode: item.documentTypeCode, recordId: item.ref.recordId }}
                    label={t('approvals.approve')}
                    small={false}
                    tone="primary"
                  />
                  <ReasonForm
                    action={rejectFromInbox}
                    hidden={{ documentTypeCode: item.documentTypeCode, recordId: item.ref.recordId }}
                    label={t('approvals.reject')}
                    reasonLabel={t('approvals.reject_reason')}
                  />
                </div>
              </article>
            ))}
          </div>
        )}
      </Panel>

      <div className={s.assignGrid}>
        <Panel flush title={t('approvals.my_submissions')}>
          {data.submissions.length === 0 ? (
            <div className={s.emptyState}>
              <Send aria-hidden="true" />
              <strong>{t('approvals.my_submissions_empty')}</strong>
            </div>
          ) : (
            <div className="table-wrap" style={{ border: 0 }}>
              <table className="list">
                <thead>
                  <tr>
                    <th scope="col">{t('approvals.document')}</th>
                    <th scope="col">{t('approvals.submitted_at')}</th>
                    <th scope="col">{t('status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.submissions.map((x) => (
                    <tr key={x.instanceId}>
                      <td>{docLink(x.ref)}</td>
                      <td>{fmt(x.submittedAt)}</td>
                      <td>
                        <Pill
                          label={x.isComplete ? statusLabel(x.lastDecision ?? 'approved') : t('approvals.pending')}
                          on={x.isComplete ? x.lastDecision !== 'rejected' : null}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel flush title={t('approvals.my_decisions')}>
          {data.decisions.length === 0 ? (
            <div className={s.emptyState}>
              <CheckCircle2 aria-hidden="true" />
              <strong>{t('approvals.my_decisions_empty')}</strong>
            </div>
          ) : (
            <div className="table-wrap" style={{ border: 0 }}>
              <table className="list">
                <thead>
                  <tr>
                    <th scope="col">{t('approvals.document')}</th>
                    <th scope="col">{t('approvals.decision')}</th>
                    <th scope="col">{t('approvals.decided')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.decisions.map((d, i) => (
                    <tr key={`${d.documentId}-${i}`}>
                      <td>{docLink(d.ref)}</td>
                      <td>
                        <Pill label={statusLabel(d.decision)} on={d.decision !== 'rejected'} />
                        {d.reason ? <span className="muted" style={{ display: 'block', fontSize: '0.72rem' }}>{d.reason}</span> : null}
                      </td>
                      <td>{fmt(d.decidedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </AdminPage>
  );
}
