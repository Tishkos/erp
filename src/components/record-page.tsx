import { getTranslations } from 'next-intl/server';
import type { RecordView } from '@domain/record-view';
import { formatBusinessDate, formatMoney, formatTimestamp } from '@/i18n/config';
import { performRecordAction } from '@/server/record-action';

/**
 * The record framework's rendering half — Phase 01.12, Appendix A rules 2–4.
 *
 * *"Every record shows status, owner, branch, dates, source, approvals, related
 * documents, journal entries and audit timeline."*
 *
 * All nine sections are rendered unconditionally. A section with nothing in it
 * says so — *"This document has not posted to the General Ledger"* — rather
 * than disappearing, because an absent section and an empty one look identical
 * to a reader who is trying to establish that a document never posted.
 */
export async function RecordPage({
  view,
  returnTo,
}: {
  view: RecordView;
  /** Where to come back to after an action. The record's own address. */
  readonly returnTo?: string;
}) {
  const t = await getTranslations('record');
  const statusLabel = await getTranslations('status');
  const actionLabel = await getTranslations('action');
  const { header, approvals, related, journals, audit, actions, draftMarking } = view;

  return (
    <article>
      {/* Rule 4 — a draft is marked, in text as well as colour, and the marking
          survives printing (see globals.css @media print). Keyed off the label,
          not `isFinal`: approved and executed carry the label `final` without
          being terminal, and rejected/cancelled/reversed are terminal but must
          still show their stamp. */}
      {draftMarking.labelKey === 'record.marking.final' ? null : (
        <div className="draft-band" role="status">
          {t(draftMarking.labelKey.replace('record.marking.', 'marking.'))}
        </div>
      )}

      <div className="page__header">
        <h1 className="page__title">{header.documentNumber ?? header.documentId}</h1>
        <span className={`status status--${header.status}`}>{statusLabel(header.status)}</span>
      </div>

      {/* Rule 3 — only actions valid for status and permission are enabled, and
          a disabled one says why (§25: reason and corrective action). */}
<div className="actions">
        {actions.map((action) => (
          // One form per action, because each posts a different verb. A
          // disabled button still renders, so a reader can see what would be
          // possible and why it is not.
          <form action={performRecordAction} key={action.key}>
            <input name="documentType" type="hidden" value={header.documentType} />
            <input name="documentId" type="hidden" value={header.documentId} />
            <input name="action" type="hidden" value={action.key} />
            <input name="returnTo" type="hidden" value={returnTo ?? ''} />
            {/* §5.4 — a rejection or a cancellation carries a reason. */}
            {action.enabled && (action.key === 'reject' || action.key === 'cancel' || action.key === 'reverse') ? (
              <input
                aria-label={t('reason')}
                className="action__reason"
                name="reason"
                placeholder={t('reason')}
                required
              />
            ) : null}
            <button
              className={`action${action.key === 'submit' || action.key === 'post' ? ' action--primary' : ''}`}
              disabled={!action.enabled}
              title={
                action.disabledReasonKey
                  ? actionLabel(action.disabledReasonKey.replace('action.', ''))
                  : undefined
              }
              type="submit"
            >
              {actionLabel(action.key)}
            </button>
          </form>
        ))}
      </div>

      <section className="panel">
        <h2 className="panel__title">{t('status')}</h2>
        <dl className="facts">
          <div>
            <dt>{t('owner')}</dt>
            <dd>{header.ownerUserId ?? '—'}</dd>
          </div>
          <div>
            <dt>{t('branch')}</dt>
            <dd>{header.branchCode ?? '—'}</dd>
          </div>
          <div>
            <dt>{t('department')}</dt>
            <dd>{header.departmentCode ?? '—'}</dd>
          </div>
          <div>
            <dt>{t('document_date')}</dt>
            <dd>{header.documentDate ? formatBusinessDate(header.documentDate) : '—'}</dd>
          </div>
          <div>
            <dt>{t('created')}</dt>
            <dd>{formatTimestamp(header.createdAt)}</dd>
          </div>
          <div>
            <dt>{t('updated')}</dt>
            <dd>{header.updatedAt ? formatTimestamp(header.updatedAt) : '—'}</dd>
          </div>
          <div>
            <dt>{t('source')}</dt>
            <dd>
              {header.source
                ? `${header.source.documentType} ${header.source.documentNumber ?? header.source.documentId}`
                : '—'}
            </dd>
          </div>
        </dl>
      </section>

      <section className="panel">
        <h2 className="panel__title">{t('approvals')}</h2>
        {approvals.length === 0 ? (
          <p className="muted">{t('no_approvals')}</p>
        ) : (
          <ul className="timeline">
            {approvals.flatMap((approval) =>
              approval.decisions.map((decision, index) => (
                <li key={`${approval.instanceId}-${index}`}>
                  <time dateTime={decision.decidedAt}>{formatTimestamp(decision.decidedAt)}</time>
                  <span>
                    {decision.decision} — {decision.actorUserId}
                    {decision.reason ? ` · ${decision.reason}` : ''}
                  </span>
                </li>
              )),
            )}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2 className="panel__title">{t('related')}</h2>
        {related.length === 0 ? (
          <p className="muted">{t('no_related')}</p>
        ) : (
          <ul className="timeline">
            {related.map((doc) => (
              <li key={`${doc.documentType}-${doc.documentId}`}>
                <span className="muted">{doc.relation}</span>
                <span>
                  {doc.documentType} {doc.documentNumber ?? doc.documentId}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2 className="panel__title">{t('journals')}</h2>
        {journals.length === 0 ? (
          <p className="muted">{t('no_journals')}</p>
        ) : (
          <ul className="timeline">
            {journals.map((journal) => (
              <li key={journal.journalId}>
                <span>{journal.journalNumber ?? journal.journalId}</span>
                <span>{formatMoney(journal.totalDebitIqd, 'IQD')}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2 className="panel__title">{t('audit')}</h2>
        {audit.length === 0 ? (
          <p className="muted">{t('no_audit')}</p>
        ) : (
          <ul className="timeline">
            {audit.map((entry, index) => (
              <li key={index}>
                <time dateTime={entry.at}>{formatTimestamp(entry.at)}</time>
                <span>
                  {entry.action}
                  {entry.actorUserId ? ` — ${entry.actorUserId}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}
