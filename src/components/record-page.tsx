import type { ReactNode } from 'react';
import { getLocale, getTranslations } from 'next-intl/server';
import { inArray } from 'drizzle-orm';
import type { RecordView } from '@domain/record-view';
import { formatBusinessDate, formatMoney, formatTimestamp, type Locale } from '@/i18n/config';
import { appUser } from '@/server/db/schema';
import { performRecordAction } from '@/server/record-action';
import { withCurrentUser } from '@/server/session';

/**
 * The record framework's rendering half — Phase 01.12, Appendix A rules 2–4.
 *
 * *"Every record shows status, owner, branch, dates, source, approvals, related
 * documents, journal entries and audit timeline."*
 *
 * Every section is rendered, and a section with nothing in it says so —
 * *"This document has not posted to the General Ledger"* — rather than
 * disappearing, because an absent section and an empty one look identical
 * to a reader who is trying to establish that a document never posted.
 *
 * Written for a person, not a log (by direction, 2026-08-29): people are
 * named, not numbered; an event is a sentence from the catalogue, not an
 * action code; and only the actions that can be taken now are offered.
 */
export async function RecordPage({
  view,
  returnTo,
  hideTitle = false,
  journalEmptyContent,
}: {
  view: RecordView;
  /** Where to come back to after an action. The record's own address. */
  readonly returnTo?: string;
  /** The page already carries the record's name in its own header. */
  readonly hideTitle?: boolean;
  readonly journalEmptyContent?: ReactNode;
}) {
  const [t, statusLabel, actionLabel, eventLabel, page, locale] = await Promise.all([
    getTranslations('record'),
    getTranslations('status'),
    getTranslations('action'),
    getTranslations('audit_action'),
    getTranslations('page'),
    getLocale(),
  ]);
  const { header, approvals, related, journals, audit, actions, draftMarking } = view;

  // Every person the record mentions, named once. Resolved here rather than
  // stored, so a renamed person is still recognisable in old events.
  const ids = new Set<string>();
  if (header.ownerUserId) ids.add(header.ownerUserId);
  for (const approval of approvals) {
    for (const decision of approval.decisions) ids.add(decision.actorUserId);
  }
  for (const entry of audit) if (entry.actorUserId) ids.add(entry.actorUserId);
  const names = new Map<string, string>();
  if (ids.size > 0) {
    const people = await withCurrentUser((tx) =>
      tx
        .select({ id: appUser.id, displayName: appUser.displayName })
        .from(appUser)
        .where(inArray(appUser.id, [...ids])),
    );
    for (const person of people) names.set(person.id, person.displayName);
  }
  const nameOf = (id: string | null) => (id ? (names.get(id) ?? t('someone')) : '—');

  // An event is named in the catalogue where a name exists. Where one does
  // not — the trail is written by every service in the system — the code is
  // read out as words rather than shown raw: "chart of account · approve".
  const eventName = (code: string): string => {
    if (eventLabel.has(code)) return eventLabel(code);
    const [type, ...rest] = code.split('.');
    const words = (s: string) => s.replace(/_/g, ' ');
    return rest.length > 0 ? `${words(type!)} · ${words(rest.join('.'))}` : words(code);
  };

  // A document is named by its number and its kind, never by its id.
  const documentName = (doc: { documentType: string; documentNumber: string | null; documentId: string }) => {
    const kind = page.has(kindKey(doc.documentType)) ? page(kindKey(doc.documentType)) : doc.documentType.replace(/_/g, ' ');
    return `${kind} ${doc.documentNumber ?? doc.documentId}`;
  };

  const when = (iso: string) => formatTimestamp(iso, locale as Locale);
  // Print and export are not decisions on the document: they open a page or
  // download a file, and the module that owns the record places them where
  // they belong. Posting them here would only ask the workflow to "perform"
  // something it has no effect for.
  const offered = actions.filter((action) => action.enabled && action.key !== 'print' && action.key !== 'export');

  return (
    <article>
      {/* Rule 4 — a draft is marked, in text as well as colour, and the marking
          survives printing (see globals.css @media print). */}
      {draftMarking.labelKey === 'record.marking.final' ? null : (
        <div className="draft-band" role="status">
          {t(draftMarking.labelKey.replace('record.marking.', 'marking.'))}
        </div>
      )}

      {/* A page that carries the record's name in its own header carries its
          status there too — the account's hero card, for one — so the whole
          header is left to it rather than saying "Approved" twice. */}
      {hideTitle ? null : (
        <div className="page__header">
          <h1 className="page__title">{header.documentNumber ?? header.documentId}</h1>
          <span className={`status status--${header.status}`}>{statusLabel(header.status)}</span>
        </div>
      )}

      {/* Rule 3 — only actions valid for status and permission are offered. */}
      {offered.length > 0 ? (
        <div className="actions">
          {offered.map((action) => (
            // One form per action, because each posts a different verb.
            <form action={performRecordAction} key={action.key}>
              <input name="documentType" type="hidden" value={header.documentType} />
              <input name="documentId" type="hidden" value={header.documentId} />
              <input name="action" type="hidden" value={action.key} />
              <input name="returnTo" type="hidden" value={returnTo ?? ''} />
              {/* §5.4 — a rejection or a cancellation carries a reason. */}
              {action.key === 'reject' || action.key === 'cancel' || action.key === 'reverse' ? (
                <input aria-label={t('reason')} className="action__reason" name="reason" placeholder={t('reason')} required />
              ) : null}
              <button
                className={`action${action.key === 'submit' || action.key === 'post' || action.key === 'approve' ? ' action--primary' : ''}`}
                type="submit"
              >
                {actionLabel(action.key)}
              </button>
            </form>
          ))}
        </div>
      ) : null}

      <section className="panel">
        <h2 className="panel__title">{t('status')}</h2>
        <dl className="facts">
          <div>
            <dt>{t('owner')}</dt>
            <dd>{nameOf(header.ownerUserId)}</dd>
          </div>
          {header.branchCode ? (
            <div>
              <dt>{t('branch')}</dt>
              <dd>{header.branchCode}</dd>
            </div>
          ) : null}
          {header.departmentCode ? (
            <div>
              <dt>{t('department')}</dt>
              <dd>{header.departmentCode}</dd>
            </div>
          ) : null}
          {header.documentDate ? (
            <div>
              <dt>{t('document_date')}</dt>
              <dd>{formatBusinessDate(header.documentDate, locale as Locale)}</dd>
            </div>
          ) : null}
          <div>
            <dt>{t('created')}</dt>
            <dd>{when(header.createdAt)}</dd>
          </div>
          <div>
            <dt>{t('updated')}</dt>
            <dd>{header.updatedAt ? when(header.updatedAt) : '—'}</dd>
          </div>
          {header.source ? (
            <div>
              <dt>{t.has(`relation.${header.source.relation}`) ? t(`relation.${header.source.relation}`) : t('source')}</dt>
              <dd>{documentName(header.source)}</dd>
            </div>
          ) : null}
        </dl>
      </section>

      <section className="panel">
        <h2 className="panel__title">{t('approvals')}</h2>
        {approvals.every((approval) => approval.decisions.length === 0) ? (
          <p className="muted">{t('no_approvals')}</p>
        ) : (
          <ul className="timeline">
            {approvals.flatMap((approval) =>
              approval.decisions.map((decision, index) => (
                <li key={`${approval.instanceId}-${index}`}>
                  <time dateTime={decision.decidedAt}>{when(decision.decidedAt)}</time>
                  <span>
                    {t.has(`decision.${decision.decision}`)
                      ? t(`decision.${decision.decision}`, { name: nameOf(decision.actorUserId) })
                      : `${decision.decision} — ${nameOf(decision.actorUserId)}`}
                    {decision.reason ? ` — ${decision.reason}` : ''}
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
                <span className="muted">{t.has(`relation.${doc.relation}`) ? t(`relation.${doc.relation}`) : doc.relation}</span>
                <span>{documentName(doc)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2 className="panel__title">{t('journals')}</h2>
        {journals.length === 0 ? (
          journalEmptyContent ?? <p className="muted">{t('no_journals')}</p>
        ) : (
          <ul className="timeline">
            {journals.map((journal) => (
              <li key={journal.journalId}>
                <span>{journal.journalNumber ?? journal.journalId}</span>
                <span>{formatMoney(journal.totalDebitIqd, 'IQD', locale as Locale)}</span>
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
                <time dateTime={entry.at}>{when(entry.at)}</time>
                <span>
                  <strong>{eventName(entry.action)}</strong>
                  {entry.actorUserId ? ` · ${t('by', { name: nameOf(entry.actorUserId) })}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}

/** The catalogue names a document kind by its menu key; the record framework by its type. */
function kindKey(documentType: string): string {
  return ({ chart_of_account: 'chart_of_accounts', journal_entry: 'journal_entry' } as Record<string, string>)[documentType] ?? documentType;
}
