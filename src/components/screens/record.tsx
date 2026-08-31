/**
 * The record half of a `document` screen — Appendix A rules 2–4.
 *
 * Rule 2: every record shows status, owner, branch, dates, source, approvals,
 * related documents, journal entries and an audit timeline. All nine sections
 * render unconditionally. A section with nothing in it says so, because an
 * absent section and an empty one look identical to a reader trying to
 * establish that a document never posted.
 *
 * Rule 3: only actions valid for the status *and* the caller's permissions are
 * enabled, and a disabled one says which of the two it failed. That decision is
 * `actionsFor` in the domain, called here with the real principal — so this
 * page cannot offer an action the rest of the application would refuse.
 *
 * Rule 4: a draft is marked as a draft, in text as well as colour, and the
 * marking survives printing.
 */
import { getLocale, getTranslations } from 'next-intl/server';
import {
  BookOpen,
  ClipboardCheck,
  FileText,
  History,
  Link2,
  ListOrdered,
} from 'lucide-react';
import type { MenuItem } from '@domain/menu';
import type { Principal } from '@domain/permissions';
import { actionsFor, draftMarkingFor } from '@domain/record-view';
import {
  formatBusinessDate,
  formatMoney,
  formatTimestamp,
  type Locale,
} from '@/i18n/config';
import { SAMPLE_TRANSITIONS, sampleRecord } from '@/sample/record';
import {
  Button,
  DataTable,
  EmptyState,
  Panel,
  PageHeader,
  PresentationBanner,
  PreviewAction,
  StatusPill,
  Workspace,
  type TableColumn,
  type TableRow,
} from '@/components/ui';
import styles from './record.module.css';

export interface RecordViewProps {
  readonly item: MenuItem;
  readonly documentNumber: string;
  readonly principal: Principal;
  readonly backHref: string;
}

export async function RecordScreen({
  item,
  documentNumber,
  principal,
  backHref,
}: RecordViewProps) {
  const [locale, t, record, column, status, action, screen] = await Promise.all([
    getLocale(),
    getTranslations(),
    getTranslations('record'),
    getTranslations('column'),
    getTranslations('status'),
    getTranslations('action'),
    getTranslations('screen'),
  ]);

  const doc = sampleRecord(item.key, documentNumber);
  const marking = draftMarkingFor(doc.status);
  const actions = actionsFor({
    documentType: item.object,
    status: doc.status,
    transitions: SAMPLE_TRANSITIONS,
    principal,
  });

  const money = (value: number) => formatMoney(value, 'IQD', locale as Locale);
  const number = new Intl.NumberFormat(locale);

  const lineColumns: readonly TableColumn[] = [
    { key: 'line', label: record('line_no'), numeric: true },
    { key: 'description', label: column('description') },
    { key: 'quantity', label: column('quantity'), numeric: true },
    { key: 'unit_price', label: column('unit_price'), numeric: true },
    { key: 'line_total', label: column('line_total'), numeric: true },
  ];

  const lineRows: readonly TableRow[] = doc.lines.map((line) => ({
    id: line.id,
    cells: {
      line: <bdi dir="ltr">{number.format(line.lineNo)}</bdi>,
      description: line.description,
      quantity: <bdi dir="ltr">{number.format(line.quantity)}</bdi>,
      unit_price: <bdi dir="ltr">{money(line.unitPrice)}</bdi>,
      line_total: <bdi dir="ltr">{money(line.lineTotal)}</bdi>,
    },
  }));

  /** Rule 3 — a disabled action says which check it failed, never just "no". */
  const actionButtons = actions.map((entry) => {
    const tone = entry.key === 'submit' || entry.key === 'post' ? 'primary' : 'secondary';

    // A disabled action stays a plain button: it must carry the reason it is
    // refused, and it must not open a dialog implying it could have run.
    if (!entry.enabled) {
      return (
        <Button
          disabled
          key={entry.key}
          label={action(entry.key)}
          tone={tone}
          {...(entry.disabledReasonKey
            ? { title: action(entry.disabledReasonKey.replace('action.', '')) }
            : {})}
        />
      );
    }

    return (
      <PreviewAction
        badge={screen('preview_action')}
        close={t('shell.close')}
        key={entry.key}
        label={action(entry.key)}
        noticeBody={screen('preview_notice_body')}
        noticeTitle={screen('preview_notice_title')}
        tone={tone}
      />
    );
  });

  return (
    <Workspace>
      {/*
        Rule 4 — the marking is text, not only colour, and it prints.

        Shown when the marking actually says something. `draftMarkingFor` gives
        an approved or executed document `isFinal: false` (true — it has not
        posted) but the label `record.marking.final`, so keying the band off
        `isFinal` alone renders a band reading "FINAL" on a document that is
        not. Keying off the label instead shows it for exactly the states a
        reader must not mistake for a clean posted document — draft, pending
        approval, cancelled, rejected, reversed — and stays silent otherwise.
        `record-page.tsx` has the same conflict and predates this.
      */}
      {marking.labelKey === 'record.marking.final' ? null : (
        <p className={styles.draftBand} role="status">
          {t(marking.labelKey)}
        </p>
      )}

      <PageHeader
        actions={<>{actionButtons}</>}
        subtitle={`${t(`page.${item.key}`)} · ${doc.partner}`}
        title={doc.documentNumber}
      />

      <PresentationBanner
        badge={screen('preview_badge')}
        note={screen('preview_note')}
      />

      <div className={styles.layout}>
        <div className={styles.main}>
          {/* Rule 2 — the header facts, all of them, in one place. */}
          <Panel icon={FileText} title={screen('summary')}>
            <dl className={styles.facts}>
              <div>
                <dt>{record('status')}</dt>
                <dd>
                  <StatusPill label={status(doc.status)} status={doc.status} />
                </dd>
              </div>
              <div>
                <dt>{record('owner')}</dt>
                <dd>{doc.owner}</dd>
              </div>
              <div>
                <dt>{record('branch')}</dt>
                <dd>
                  <bdi dir="ltr">{doc.branch}</bdi>
                </dd>
              </div>
              <div>
                <dt>{record('department')}</dt>
                <dd>{doc.department}</dd>
              </div>
              <div>
                <dt>{record('document_date')}</dt>
                <dd>
                  <bdi dir="auto">{formatBusinessDate(doc.documentDate, locale as Locale)}</bdi>
                </dd>
              </div>
              <div>
                <dt>{record('created')}</dt>
                <dd>
                  <bdi dir="auto">{formatTimestamp(doc.createdAt, locale as Locale)}</bdi>
                </dd>
              </div>
              <div>
                <dt>{record('updated')}</dt>
                <dd>
                  <bdi dir="auto">{formatTimestamp(doc.updatedAt, locale as Locale)}</bdi>
                </dd>
              </div>
              <div>
                <dt>{record('source')}</dt>
                <dd>
                  {doc.source ? <bdi dir="ltr">{doc.source}</bdi> : t('chart.not_available')}
                </dd>
              </div>
            </dl>
          </Panel>

          <Panel
            flush
            footer={
              <>
                <span>{record('total')}</span>
                <strong>
                  <bdi dir="ltr">{money(doc.total)}</bdi>
                </strong>
              </>
            }
            icon={ListOrdered}
            title={record('lines')}
          >
            <DataTable caption={record('lines')} columns={lineColumns} rows={lineRows} />
          </Panel>
        </div>

        <div className={styles.side}>
          <Panel icon={ClipboardCheck} title={record('approvals')}>
            {doc.approvals.length === 0 ? (
              <EmptyState icon={ClipboardCheck} title={record('no_approvals')} />
            ) : (
              <ol className={styles.timeline}>
                {doc.approvals.map((approval) => (
                  <li key={approval.id}>
                    <strong>{approval.approver}</strong>
                    <span>
                      {approval.at ? (
                        <bdi dir="auto">{formatTimestamp(approval.at, locale as Locale)}</bdi>
                      ) : (
                        record('awaiting')
                      )}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </Panel>

          <Panel icon={Link2} title={record('related')}>
            {doc.related.length === 0 ? (
              <EmptyState icon={Link2} title={record('no_related')} />
            ) : (
              <ul className={styles.linkList}>
                {doc.related.map((related) => (
                  <li key={related.id}>
                    <bdi dir="ltr">{related.reference}</bdi>
                    <StatusPill label={status(related.status)} status={related.status} />
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel icon={BookOpen} title={record('journals')}>
            {doc.journals.length === 0 ? (
              <EmptyState icon={BookOpen} title={record('no_journals')} />
            ) : (
              <ul className={styles.linkList}>
                {doc.journals.map((journal) => (
                  <li key={journal.id}>
                    <bdi dir="ltr">{journal.reference}</bdi>
                    <span>
                      <bdi dir="ltr">{money(journal.debit)}</bdi>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel icon={History} title={record('audit')}>
            {doc.audit.length === 0 ? (
              <EmptyState icon={History} title={record('no_audit')} />
            ) : (
              <ol className={styles.timeline}>
                {doc.audit.map((entry) => (
                  <li key={entry.id}>
                    <strong>{record(`audit_action.${entry.action}`)}</strong>
                    <span>
                      {entry.actor} ·{' '}
                      <bdi dir="auto">{formatTimestamp(entry.at, locale as Locale)}</bdi>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </Panel>
        </div>
      </div>

      <p className={styles.backLink}>
        <Button href={backHref} label={record('back_to_list')} />
      </p>
    </Workspace>
  );
}
