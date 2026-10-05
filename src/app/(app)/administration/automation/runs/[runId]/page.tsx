import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, admin as s } from '@/components/admin';
import { readAttachments } from '@/components/admin/attachments';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { RecordHistory } from '@/components/admin/history';
import { HistoryButton } from '@/components/admin/icon-dialog';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { RecordAttachmentsDoor } from '@/components/admin/record-attachments-door';
import { RecordNotesDoor } from '@/components/admin/record-notes-door';
import { ExportIcon } from '@/components/print/export-menu';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatMoney, formatTimestamp, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { actionText, conditionText, eventName, wordsOf } from '@/server/domain/automation-text';
import { requireContext, withCurrentUser } from '@/server/session';
import * as automation from '@/server/services/automation';
import * as recordNotes from '@/server/services/record-notes';

/**
 * One automation run — platform phase, Agent 10. The record of what a rule did
 * (or why it did not) with one event: the document window with the event, the
 * record it was about, who it ran as and the outcome; its lines the steps
 * taken; under it the conditions as they stood and the event as it was
 * recorded. A run is evidence and is never edited: no verbs at its foot. The
 * four doors in the title bar: printer (`automation_run`), paperclip, notes,
 * clock.
 */
export const dynamic = 'force-dynamic';

const OUTCOME_TONE: Readonly<Record<string, string>> = { done: 'posted', skipped: 'draft', failed: 'rejected' };
const STEP_TONE: Readonly<Record<string, string>> = { done: 'posted', carried: 'posted', skipped: 'draft', failed: 'rejected' };

export default async function AutomationRunPage({ params, searchParams }: { params: Promise<{ runId: string }>; searchParams: SearchParams }) {
  const [t, x, tasks, exceptions, page, locale, context, outcome, { runId }] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.automation'),
    getTranslations('admin.tasks'),
    getTranslations('admin.exceptions'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    params,
  ]);
  const { principal } = context;
  if (!can(principal, 'view', automation.PERMISSION_OBJECT)) return <Denied object={page('automation')} />;

  const found = await withCurrentUser(async (tx) => {
    const run = await automation.runById(tx, principal, runId);
    if (!run) return null;
    const ids = [...automation.peopleIn(run.planned), ...['raisedBy', 'assigneeId'].map((k) => String(run.payload[k] ?? '')).filter(Boolean)];
    return {
      run,
      book: await automation.nameBook(tx, ids),
      notes: await recordNotes.listNotes(tx, { object: 'automation_run', recordId: run.id }),
      files: await readAttachments(tx, 'automation_run', run.id),
    };
  });
  if (!found) notFound();
  const { run, book } = found;

  const moment = (iso: string | null) => (iso ? formatTimestamp(iso, locale as Locale) : '—');
  const money = (decimal: string) => formatMoney(decimal, 'IQD', locale as Locale);
  const date = (iso: string) => formatBusinessDate(iso, locale as Locale);
  const words = wordsOf({
    say: (key, values) => x(key, values),
    book,
    money,
    date,
    priority: (code) => tasks(`priority_${code}`),
    severity: (code) => exceptions(`severity_${code}`),
  });
  const valueOf = (field: string, raw: string | null): string => {
    if (raw === null) return '—';
    const type = automation.fieldType(run.eventKey, field);
    return type === 'money' ? money(raw) : type === 'date' ? date(raw) : raw;
  };
  const payload = automation.payloadLines(run.eventKey, run.payload, book.users);

  const fields: DocumentField[] = [
    { label: x('run_ref'), value: <bdi dir="ltr">{run.id}</bdi> },
    { label: x('run_outcome'), value: x(`outcome_${run.outcome}`), status: OUTCOME_TONE[run.outcome]! },
    {
      label: x('run_rule'),
      value: (
        <Link className={s.sapLink} href={`/administration/automation/${encodeURIComponent(run.ruleNo)}`}>
          <bdi dir="ltr">{run.ruleNo}</bdi> · <bdi dir="auto">{run.ruleName}</bdi>
        </Link>
      ),
    },
    { label: x('run_rule_version'), value: <bdi dir="ltr">{run.ruleVersion}</bdi> },
    { label: x('run_event'), value: eventName(x, run.eventKey) },
    {
      label: x('run_subject'),
      value: (
        <Link className={s.sapLink} href={run.recordHref}>
          <bdi dir="ltr">{run.reference}</bdi>
        </Link>
      ),
    },
    { label: x('run_started'), value: <bdi dir="ltr">{moment(run.startedAt)}</bdi> },
    { label: x('run_attempt'), value: <bdi dir="ltr">{run.attempt}</bdi> },
    { label: x('run_owner'), value: <bdi dir="auto">{run.ownerName}</bdi> },
    { label: x('run_reason'), value: <bdi dir="auto">{run.reason}</bdi>, wide: true },
  ];

  return (
    <AdminPage back={{ href: '/administration/automation', label: t('back') }} title={`${run.ruleNo} · ${run.id}`} trail={[{ href: '/', label: t('dashboard_label') }]} variant="sap">
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <DocumentWindow
        titleActions={
          <>
            {/* Printer, paperclip, notes, clock — the standing four doors. */}
            <ExportIcon exportKey="automation_run" id={run.id} title={`${x('run_document_type')} ${run.id}`} />
            <RecordAttachmentsDoor files={found.files} object="automation_run" recordId={run.id} />
            <RecordNotesDoor notes={found.notes} object="automation_run" recordId={run.id} />
            <HistoryButton closeLabel={t('close')} label={t('history')} title={t('history')}>
              <RecordHistory objectId={run.id} objectType="automation_run" />
            </HistoryButton>
          </>
        }
        documentType={x('run_document_type')}
        fields={fields}
        id="automation-run"
        linesCount={run.results.length}
        linesTitle={x('run_steps_title')}
        number={run.id}
      >
        <table aria-labelledby="automation-run-lines-heading" className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">{x('rule_step')}</th>
              <th scope="col">{x('col_outcome')}</th>
              <th scope="col">{x('run_step_detail')}</th>
              <th scope="col">{x('run_step_made')}</th>
            </tr>
          </thead>
          <tbody>
            {run.results.length === 0 ? (
              <tr>
                <td className={s.sapEmptyRow} colSpan={4}>
                  {x('run_steps_none')}
                </td>
              </tr>
            ) : null}
            {run.results.map((step) => (
              <tr key={step.index}>
                <td>{x(`action_${step.kind}`)}</td>
                <td>
                  <span className={`status status--${STEP_TONE[step.status] ?? 'draft'} ${s.sapRegisterStatus}`} data-status={STEP_TONE[step.status] ?? 'draft'}>
                    {x(`step_${step.status}`)}
                  </span>
                </td>
                <td>
                  <bdi dir="auto">{step.detail}</bdi>
                </td>
                <td>{step.ref ? <bdi dir="ltr">{step.ref}</bdi> : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">{x('run_recorded_note')}</p>
      </DocumentWindow>

      <section aria-labelledby="automation-run-conditions-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="automation-run-conditions-title">
            <span>{x('run_conditions_title')}</span>
            <span className={s.sapTitleMeta}>{run.checks.length}</span>
          </h2>
          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="automation-run-conditions-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{x('rule_conditions')}</th>
                  <th scope="col">{x('run_cond_actual')}</th>
                  <th scope="col">{x('col_outcome')}</th>
                </tr>
              </thead>
              <tbody>
                {run.checks.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={3}>
                      {x('run_conditions_none')}
                    </td>
                  </tr>
                ) : null}
                {run.checks.map((check, index) => (
                  <tr key={index}>
                    <td>
                      <bdi dir="auto">{conditionText(run.eventKey, check.condition, words)}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{valueOf(check.condition.field, check.actual)}</bdi>
                    </td>
                    <td>
                      <span className={`status status--${check.met ? 'posted' : 'rejected'} ${s.sapRegisterStatus}`} data-status={check.met ? 'posted' : 'rejected'}>
                        {check.met ? x('run_cond_met') : x('run_cond_unmet')}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section aria-labelledby="automation-run-planned-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="automation-run-planned-title">
            <span>{x('rule_actions')}</span>
            <span className={s.sapTitleMeta}>{run.planned.length}</span>
          </h2>
          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="automation-run-planned-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{x('rule_step')}</th>
                  <th scope="col">{x('rule_what')}</th>
                </tr>
              </thead>
              <tbody>
                {run.planned.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={2}>
                      {x('run_steps_none')}
                    </td>
                  </tr>
                ) : null}
                {run.planned.map((action, index) => (
                  <tr key={index}>
                    <td>{x(`action_${action.kind}`)}</td>
                    <td>
                      <bdi dir="auto">{actionText(action, words)}</bdi>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section aria-labelledby="automation-run-payload-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="automation-run-payload-title">
            <span>{x('run_payload_title')}</span>
            <span className={s.sapTitleMeta}>{payload.length}</span>
          </h2>
          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="automation-run-payload-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{x('run_payload_field')}</th>
                  <th scope="col">{x('run_payload_value')}</th>
                </tr>
              </thead>
              <tbody>
                {payload.map((line) => (
                  <tr key={line.field}>
                    <td>{x(`payload_${line.field}`)}</td>
                    <td>
                      <bdi dir="auto">{line.type === 'money' ? money(line.value) : line.type === 'date' ? date(line.value) : line.value}</bdi>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </AdminPage>
  );
}
