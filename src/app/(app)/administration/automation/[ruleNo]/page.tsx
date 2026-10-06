import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, Flash, Form, Grid, NewRecordDialog, Submit, SubmitRow, admin as s } from '@/components/admin';
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
import { changeRule, disableRule, enableRule } from '../actions';
import { RuleFields } from '../rule-form';

/**
 * One automation rule — platform phase, Agent 10. Copies the leave request and
 * the purchase invoice pages: the document window (header fields, the state as
 * the status chip, the verbs at the foot), its lines the conditions and the
 * steps in words, then the rule's versions and its latest runs stacked under it
 * in the supplier-statement manner. The four doors in the title bar: printer
 * (the `automation_rule` print model), paperclip, notes, clock.
 */
export const dynamic = 'force-dynamic';

const STATE_TONE: Readonly<Record<string, string>> = { on: 'posted', off: 'draft', paused: 'rejected' };
const OUTCOME_TONE: Readonly<Record<string, string>> = { done: 'posted', skipped: 'draft', failed: 'rejected' };
const clip = (value: string, max = 110): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

export default async function AutomationRulePage({ params, searchParams }: { params: Promise<{ ruleNo: string }>; searchParams: SearchParams }) {
  const [t, x, tasks, exceptions, page, locale, context, outcome, { ruleNo: rawNo }] = await Promise.all([
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
  const ruleNo = decodeURIComponent(rawNo);
  const { principal } = context;
  if (!can(principal, 'view', automation.PERMISSION_OBJECT)) return <Denied object={page('automation')} />;
  const mayAdminister = can(principal, 'administer', automation.PERMISSION_OBJECT);

  const found = await withCurrentUser(async (tx) => {
    const rule = await automation.byNo(tx, principal, ruleNo);
    if (!rule) return null;
    return {
      rule,
      book: await automation.nameBook(tx, automation.peopleIn(rule.actions)),
      versions: await automation.versionsOf(tx, principal, rule.id),
      runs: await automation.listRuns(tx, principal, { ruleNo: rule.ruleNo, pageSize: 10 }),
      notes: await recordNotes.listNotes(tx, { object: automation.PERMISSION_OBJECT, recordId: rule.ruleNo }),
      files: await readAttachments(tx, automation.PERMISSION_OBJECT, rule.id),
      choices: mayAdminister ? { roles: await automation.roleChoices(tx), people: await automation.peopleChoices(tx), sections: await automation.sectionChoices(tx, principal) } : null,
    };
  });
  if (!found) notFound();
  const { rule, book, versions, runs } = found;

  const state = rule.enabled ? 'on' : rule.pausedAt ? 'paused' : 'off';
  const moment = (iso: string | null) => (iso ? formatTimestamp(iso, locale as Locale) : '—');
  const words = wordsOf({
    say: (key, values) => x(key, values),
    book,
    money: (decimal) => formatMoney(decimal, 'IQD', locale as Locale),
    date: (iso) => formatBusinessDate(iso, locale as Locale),
    priority: (code) => tasks(`priority_${code}`),
    severity: (code) => exceptions(`severity_${code}`),
  });
  // What the person looking would make it do if they switched it on: their own reach, step by step.
  const reach = automation.reachFor(principal, rule.eventKey, rule.actions);
  const beyond = rule.actions.filter((_, i) => !reach[i]!.ok).map((a) => x(`action_${a.kind}`));

  const fields: DocumentField[] = [
    { label: x('rule_ref'), value: <bdi dir="ltr">{rule.ruleNo}</bdi> },
    { label: x('rule_status'), value: x(`pill_${state}`), status: STATE_TONE[state]! },
    { label: x('rule_name'), value: <bdi dir="auto">{rule.name}</bdi> },
    { label: x('rule_event'), value: eventName(x, rule.eventKey) },
    { label: x('rule_template'), value: x(`template_${rule.templateCode}`) },
    { label: x('rule_version'), value: <bdi dir="ltr">{rule.version}</bdi> },
    { label: x('rule_owner'), value: <bdi dir="auto">{rule.ownerName}</bdi> },
    { label: x('rule_created'), value: <bdi dir="auto">{rule.createdByName}</bdi> },
    { label: x('rule_created_at'), value: <bdi dir="ltr">{moment(rule.createdAt)}</bdi> },
    { label: x('rule_enabled_by'), value: <bdi dir="auto">{rule.enabledByName ?? '—'}</bdi> },
    { label: x('rule_enabled_at'), value: <bdi dir="ltr">{moment(rule.enabledAt)}</bdi> },
    { label: x('rule_last_run'), value: <bdi dir="ltr">{rule.lastRunAt ? `${moment(rule.lastRunAt)} · ${x(`outcome_${rule.lastOutcome ?? 'done'}`)}` : x('rule_not_run')}</bdi> },
    { label: x('rule_streak'), value: <bdi dir="ltr">{rule.consecutiveFailures}</bdi> },
    ...(rule.pausedReason ? [{ label: x('rule_paused'), value: <bdi dir="auto">{rule.pausedReason}</bdi>, wide: true }] : []),
  ];

  const hidden = (
    <>
      <input name="rule_no" type="hidden" value={rule.ruleNo} />
      <input name="template_code" type="hidden" value={rule.templateCode} />
    </>
  );
  const lines = [
    ...rule.conditions.map((c) => ({ part: x('rule_conditions'), what: conditionText(rule.eventKey, c, words), note: '' })),
    ...(rule.conditions.length === 0 ? [{ part: x('rule_conditions'), what: x('rule_no_conditions'), note: '' }] : []),
    ...rule.actions.map((a, i) => ({ part: `${x('rule_actions')} ${i + 1}`, what: actionText(a, words), note: a.note })),
  ];

  return (
    <AdminPage back={{ href: '/administration/automation', label: t('back') }} title={`${rule.ruleNo} · ${rule.name}`} trail={[{ href: '/', label: t('dashboard_label') }]} variant="sap">
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />
      {!rule.enabled && mayAdminister && beyond.length > 0 ? <p className={s.sapNote}>{x('reach_note', { steps: beyond.join(', ') })}</p> : null}

      <DocumentWindow
        actions={
          mayAdminister && found.choices ? (
            <>
              <NewRecordDialog buttonLabel={x('edit')} closeLabel={t('close')} title={x('edit_title', { rule: rule.ruleNo })} wide>
                <Form action={changeRule}>
                  {hidden}
                  <Field defaultValue={rule.name} id="edit-name" label={x('rule_name')} name="name" required wide />
                  <RuleFields choices={found.choices} idPrefix="edit" template={rule.templateCode} values={rule.params} />
                  <Grid>
                    <Field id="edit-note" label={x('change_note')} name="note" wide />
                  </Grid>
                  <p className="muted">{x('versions_hint')}</p>
                  <SubmitRow>
                    <Submit label={x('save_version')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
              {rule.enabled ? (
                <form action={disableRule}>
                  {hidden}
                  <input aria-label={x('disable_reason')} name="reason" placeholder={x('disable_reason')} required type="text" />
                  <Submit label={x('disable')} tone="secondary" variant="document" />
                </form>
              ) : (
                <form action={enableRule}>
                  {hidden}
                  <Submit label={x('enable')} variant="document" />
                </form>
              )}
            </>
          ) : null
        }
        titleActions={
          <>
            {/* Printer, paperclip, notes, clock — the standing four doors. */}
            <ExportIcon exportKey="automation_rule" id={rule.ruleNo} title={`${x('document_type')} ${rule.ruleNo}`} />
            <RecordAttachmentsDoor files={found.files} object={automation.PERMISSION_OBJECT} recordId={rule.id} />
            <RecordNotesDoor notes={found.notes} object={automation.PERMISSION_OBJECT} recordId={rule.ruleNo} />
            <HistoryButton closeLabel={t('close')} label={t('history')} title={t('history')}>
              <RecordHistory objectId={rule.ruleNo} objectType={automation.PERMISSION_OBJECT} />
            </HistoryButton>
          </>
        }
        documentType={x('document_type')}
        fields={fields}
        id="automation-rule"
        linesCount={lines.length}
        linesTitle={x('rule_lines_title')}
        number={rule.ruleNo}
      >
        <table aria-labelledby="automation-rule-lines-heading" className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">{x('rule_step')}</th>
              <th scope="col">{x('rule_what')}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => (
              <tr key={index}>
                <td>{line.part}</td>
                <td>
                  <bdi dir="auto">{line.what}</bdi>
                  {line.note ? <div className="muted"><bdi dir="auto">{x('act_note', { note: line.note })}</bdi></div> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DocumentWindow>

      <section aria-labelledby="automation-versions-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={`${s.sapWindow} mb-5`}>
          <h2 className={s.sapTitle} id="automation-versions-title">
            <span>{x('versions_title')}</span>
            <span className={s.sapTitleMeta}>{versions.length}</span>
          </h2>
          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="automation-versions-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{x('col_version')}</th>
                  <th scope="col">{x('col_name')}</th>
                  <th scope="col">{x('ver_by')}</th>
                  <th scope="col">{x('col_when')}</th>
                  <th scope="col">{x('ver_note')}</th>
                </tr>
              </thead>
              <tbody>
                {versions.map((v) => (
                  <tr key={v.version}>
                    <td>
                      <bdi dir="ltr">{v.version}</bdi>
                      {v.current ? <span className="muted"> · {x('ver_current')}</span> : null}
                    </td>
                    <td>
                      <bdi dir="auto">{v.name}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{v.changedByName}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{moment(v.createdAt)}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{v.changeNote ?? '—'}</bdi>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section aria-labelledby="automation-runs-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={`${s.sapWindow} mb-5`}>
          <h2 className={s.sapTitle} id="automation-runs-title">
            <span>{x('runs_of_rule')}</span>
            <span className={s.sapTitleMeta}>
              <Link className={s.sapLink} href={`/administration/automation?run_rule=${encodeURIComponent(rule.ruleNo)}`}>
                {x('all_runs')} ({runs.total})
              </Link>
            </span>
          </h2>
          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="automation-runs-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{x('col_when')}</th>
                  <th scope="col">{x('col_record')}</th>
                  <th scope="col">{x('col_outcome')}</th>
                  <th scope="col">{x('col_reason')}</th>
                </tr>
              </thead>
              <tbody>
                {runs.rows.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={4}>
                      {x('runs_none')}
                    </td>
                  </tr>
                ) : null}
                {runs.rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link className={s.sapLink} href={`/administration/automation/runs/${r.id}`}>
                        <bdi dir="ltr">{moment(r.startedAt)}</bdi>
                      </Link>
                    </td>
                    <td>
                      <bdi dir="ltr">{r.reference}</bdi>
                    </td>
                    <td>
                      <span className={`status status--${OUTCOME_TONE[r.outcome]} ${s.sapRegisterStatus}`} data-status={OUTCOME_TONE[r.outcome]}>
                        {x(`outcome_${r.outcome}`)}
                      </span>
                    </td>
                    <td>
                      <bdi dir="auto">{clip(r.reason)}</bdi>
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
