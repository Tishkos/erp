/**
 * Automation's print models — platform phase, Agent 10.
 *
 * `automation_rule` — one rule: what it listens for, what it checks, what it
 * does, who owns it, its versions and its latest runs. `automation_run` — one
 * run: the event it answered, the conditions as they stood, what each step did
 * or why it did not. Both are built from the services the screens read
 * (`automation.byNo`, `automation.runById`), so a copy shows what the reader's
 * own screen shows and nothing more, in the words the screen uses
 * (`domain/automation-text.ts`). A rule or a run the reader cannot open is not
 * found, and the export route answers as for any other missing document.
 *
 * "Posted" for the watermark means nothing here: a rule is not a posting.
 */
import { formatBusinessDate, formatMoney, formatTimestamp } from '@/i18n/config';
import { actionText, conditionText, eventName, fieldValueText, wordsOf, type Words } from '../domain/automation-text';
import * as automation from '../services/automation';
import type { BuildContext, Built } from './documents';
import type { Column, Fact, Row } from './model';

const REASON_NOTE = 'run_recorded_note';

function wordsFor(ctx: BuildContext, book: automation.NameBook): Words {
  const { m, locale } = ctx;
  return wordsOf({
    say: (key, values) => m.admin(`automation.${key}`, values),
    book,
    money: (decimal) => formatMoney(decimal, 'IQD', locale),
    date: (iso) => formatBusinessDate(iso, locale),
    priority: (code) => m.admin(`tasks.priority_${code}`),
    severity: (code) => m.admin(`exceptions.severity_${code}`),
  });
}

export async function automationRule(ctx: BuildContext, ruleNo: string): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const rule = await automation.byNo(tx, ctx.principal, ruleNo);
  if (!rule) return null;
  const x = (key: string, values?: Record<string, string | number>) => m.admin(`automation.${key}`, values);
  const moment = (iso: string | null) => (iso ? formatTimestamp(iso, locale) : '—');
  const words = wordsFor(ctx, await automation.nameBook(tx, automation.peopleIn(rule.actions)));
  const versions = await automation.versionsOf(tx, ctx.principal, rule.id);
  const runs = await automation.listRuns(tx, ctx.principal, { ruleNo: rule.ruleNo, pageSize: 20 });
  const state = rule.enabled ? x('pill_on') : rule.pausedAt ? x('pill_paused') : x('pill_off');

  const fields: Fact[] = [
    { label: x('rule_ref'), value: rule.ruleNo, ltr: true },
    { label: m.column('status'), value: state },
    { label: x('rule_name'), value: rule.name },
    { label: x('rule_event'), value: eventName(words.say, rule.eventKey) },
    { label: x('rule_template'), value: words.say(`template_${rule.templateCode}`) },
    { label: x('rule_version'), value: String(rule.version), ltr: true },
    { label: x('rule_owner'), value: rule.ownerName },
    { label: x('rule_created'), value: rule.createdByName },
    { label: x('rule_created_at'), value: moment(rule.createdAt), ltr: true },
    { label: x('rule_last_run'), value: rule.lastRunAt ? `${moment(rule.lastRunAt)} · ${x(`outcome_${rule.lastOutcome ?? 'done'}`)}` : x('rule_not_run') },
    { label: x('rule_streak'), value: String(rule.consecutiveFailures), ltr: true },
  ];
  if (rule.enabledAt) fields.push({ label: x('rule_enabled_at'), value: moment(rule.enabledAt), ltr: true });
  if (rule.enabledByName) fields.push({ label: x('rule_enabled_by'), value: rule.enabledByName });
  if (rule.pausedReason) fields.push({ label: x('rule_paused'), value: rule.pausedReason });

  const doesColumns: Column[] = [
    { key: 'part', label: x('rule_step'), kind: 'text', weight: 1 },
    { key: 'what', label: x('rule_what'), kind: 'text', weight: 6 },
  ];
  const doesRows: Row[] = [
    ...(rule.conditions.length === 0
      ? [{ cells: { part: x('rule_conditions'), what: x('rule_no_conditions') }, counts: false }]
      : rule.conditions.map((c) => ({ cells: { part: x('rule_conditions'), what: conditionText(rule.eventKey, c, words) }, counts: false }))),
    ...rule.actions.flatMap((a, i) => [
      { cells: { part: `${x('rule_actions')} ${i + 1}`, what: actionText(a, words) }, counts: false },
      ...(a.note ? [{ cells: { part: '', what: x('act_note', { note: a.note }) }, counts: false }] : []),
    ]),
  ];

  const versionColumns: Column[] = [
    { key: 'version', label: x('col_version'), kind: 'code', weight: 1 },
    { key: 'by', label: x('ver_by'), kind: 'text', weight: 3 },
    { key: 'when', label: x('col_when'), kind: 'text', weight: 3 },
    { key: 'note', label: x('ver_note'), kind: 'text', weight: 5 },
  ];
  const versionRows: Row[] = versions.map((v) => ({
    cells: { version: String(v.version), by: v.changedByName, when: moment(v.createdAt), note: v.changeNote ?? (v.current ? x('ver_current') : null) },
    counts: false,
  }));

  const runColumns: Column[] = [
    { key: 'when', label: x('col_when'), kind: 'text', weight: 3 },
    { key: 'record', label: x('col_record'), kind: 'code', weight: 3 },
    { key: 'outcome', label: x('col_outcome'), kind: 'text', weight: 2 },
    { key: 'reason', label: x('col_reason'), kind: 'text', weight: 7 },
  ];
  const runRows: Row[] = runs.rows.map((r) => ({
    cells: { when: moment(r.startedAt), record: r.reference, outcome: x(`outcome_${r.outcome}`), reason: r.reason },
    counts: false,
  }));

  return {
    model: {
      kind: 'document',
      title: m.print('titles.automation_rule'),
      number: rule.ruleNo,
      status: state,
      posted: false,
      orientation: 'portrait',
      fields,
      filters: [],
      tables: [
        { title: x('rule_lines_title'), columns: doesColumns, rows: doesRows, empty: '—' },
        { title: x('versions_title'), columns: versionColumns, rows: versionRows, empty: '—' },
        { title: x('runs_title'), columns: runColumns, rows: runRows, empty: x('runs_none') },
      ],
      summary: [],
      signatures: false,
      currency: 'IQD',
      fileName: rule.ruleNo,
      sheetName: rule.ruleNo,
    },
    branchCode: ctx.branchCode,
    objectId: rule.ruleNo,
  };
}

export async function automationRun(ctx: BuildContext, runId: string): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const run = await automation.runById(tx, ctx.principal, runId);
  if (!run) return null;
  const x = (key: string, values?: Record<string, string | number>) => m.admin(`automation.${key}`, values);
  const moment = (iso: string | null) => (iso ? formatTimestamp(iso, locale) : '—');
  const rule = await automation.byNo(tx, ctx.principal, run.ruleNo);
  const userIds = [...run.planned.flatMap((a) => automation.peopleIn([a])), ...['raisedBy', 'assigneeId'].map((k) => String(run.payload[k] ?? '')).filter(Boolean)];
  const book = await automation.nameBook(tx, userIds);
  const words = wordsFor(ctx, book);
  const outcome = x(`outcome_${run.outcome}`);

  const fields: Fact[] = [
    { label: x('run_ref'), value: run.id, ltr: true },
    { label: x('run_outcome'), value: outcome },
    { label: x('run_rule'), value: `${run.ruleNo} · ${rule?.name ?? run.ruleName}` },
    { label: x('run_rule_version'), value: String(run.ruleVersion), ltr: true },
    { label: x('run_event'), value: eventName(words.say, run.eventKey) },
    { label: x('run_subject'), value: run.reference, ltr: true },
    { label: x('run_started'), value: moment(run.startedAt), ltr: true },
    { label: x('run_attempt'), value: String(run.attempt), ltr: true },
    { label: x('run_owner'), value: run.ownerName },
  ];

  const happened: Column[] = [{ key: 'text', label: x('run_reason'), kind: 'text' }];
  const happenedRows: Row[] = [{ cells: { text: run.reason }, counts: false }, { cells: { text: x(REASON_NOTE) }, counts: false }];

  const checkColumns: Column[] = [
    { key: 'what', label: x('run_conditions_title'), kind: 'text', weight: 6 },
    { key: 'actual', label: x('run_cond_actual'), kind: 'text', weight: 2 },
    { key: 'met', label: x('col_outcome'), kind: 'text', weight: 2 },
  ];
  const valueOf = (field: string, raw: string | null): string => (raw === null ? '—' : fieldValueText(run.eventKey, field, raw, words));
  const checkRows: Row[] = run.checks.map((c) => ({
    cells: { what: conditionText(run.eventKey, c.condition, words), actual: valueOf(c.condition.field, c.actual), met: c.met ? x('run_cond_met') : x('run_cond_unmet') },
    counts: false,
  }));

  const stepColumns: Column[] = [
    { key: 'step', label: x('rule_step'), kind: 'text', weight: 3 },
    { key: 'result', label: x('col_outcome'), kind: 'text', weight: 2 },
    { key: 'detail', label: x('run_step_detail'), kind: 'text', weight: 7 },
    { key: 'made', label: x('run_step_made'), kind: 'code', weight: 2 },
  ];
  const stepRows: Row[] = run.results.map((r) => ({
    cells: {
      step: m.admin(`automation.action_${r.kind}`),
      result: x(`step_${r.status}`),
      detail: r.detail,
      made: r.ref ?? null,
    },
    counts: false,
  }));

  const payloadColumns: Column[] = [
    { key: 'field', label: x('run_payload_field'), kind: 'text', weight: 3 },
    { key: 'value', label: x('run_payload_value'), kind: 'text', weight: 6 },
  ];
  const payloadRows: Row[] = automation.payloadLines(run.eventKey, run.payload).map((p) => ({
    cells: { field: x(`payload_${p.field}`), value: fieldValueText(run.eventKey, p.field, p.value, words) },
    counts: false,
  }));

  return {
    model: {
      kind: 'document',
      title: m.print('titles.automation_run'),
      number: `${run.ruleNo} · ${run.id}`,
      status: outcome,
      posted: run.outcome === 'done',
      orientation: 'portrait',
      fields,
      filters: [],
      tables: [
        { title: x('run_reason'), columns: happened, rows: happenedRows, empty: '—' },
        { title: x('run_conditions_title'), columns: checkColumns, rows: checkRows, empty: x('run_conditions_none') },
        { title: x('run_steps_title'), columns: stepColumns, rows: stepRows, empty: x('run_steps_none') },
        { title: x('run_payload_title'), columns: payloadColumns, rows: payloadRows, empty: '—' },
      ],
      summary: [],
      signatures: false,
      currency: 'IQD',
      fileName: `${run.ruleNo}-${run.id}`,
      sheetName: run.id,
    },
    branchCode: run.branchCode ?? ctx.branchCode,
    objectId: run.id,
  };
}
