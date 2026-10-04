/**
 * Workflow automation — the closed vocabulary, the evaluator and the templates,
 * with no database (platform phase, Agent 10).
 *
 * What a rule can say is a short closed list, and this file holds that list to
 * its word: every event has labels in both languages and a producer that fires
 * it; a condition naming an unknown field, operator or key is refused; the
 * evaluator gives the same answer to the same inputs; no action in the
 * catalogue, and no import of the automation services, can post, pay, receive
 * or move stock. The runner on a real database, the outbox, idempotency,
 * permissions and the four templates end to end are
 * `tests/integration/wf01-automation.test.ts`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ACTIONS_MAX,
  AutomationError,
  CONDITIONS_MAX,
  MAX_ATTEMPTS,
  MAX_DEPTH,
  guardOf,
  evaluate,
  nextAttemptAt,
  outcomeOf,
  runKeyOf,
  shouldPause,
  validateActions,
  validateConditions,
  validateDefinition,
  type ActionResult,
} from '../../src/server/domain/automation';
import {
  ACTION_KINDS,
  EVENTS,
  EVENT_KEYS,
  RECIPIENT_KINDS,
  episodeOf,
  eventLabelKey,
  noticeKind,
  payloadProblems,
  subjectKeyOf,
} from '../../src/server/domain/automation-events';
import { TEMPLATES, TEMPLATE_CODES, buildDefinition, parseParams } from '../../src/server/domain/automation-templates';

const read = (path: string) => readFileSync(path, 'utf8');
const money = (value: string) => value;

describe('the event catalogue', () => {
  it('is closed: five events, each with a shape, a source and an object', () => {
    expect([...EVENT_KEYS].sort()).toEqual(['ap_invoice.posted', 'ap_invoice.submitted', 'ar_invoice.overdue', 'container.eta_exceeded', 'task.overdue']);
    for (const key of EVENT_KEYS) {
      const def = EVENTS[key];
      expect(def.key).toBe(key);
      expect(['record', 'sweep']).toContain(def.source);
      expect(def.object).toMatch(/^[a-z_]+$/);
      expect(Object.keys(def.fields)).toEqual(expect.arrayContaining(['subjectId', 'reference', 'branchCode']));
      expect(def.actions.length).toBeGreaterThan(0);
      for (const a of def.actions) expect(ACTION_KINDS).toContain(a);
      for (const r of def.recipients) expect(RECIPIENT_KINDS).toContain(r);
    }
  });

  it('names the stretch of lateness a sweep event belongs to; a record event is its own', () => {
    for (const key of EVENT_KEYS) {
      const def = EVENTS[key];
      if (def.source === 'sweep') {
        expect(def.episodeField, key).toBeTruthy();
        expect(def.fields[def.episodeField!]?.type).toBe('date');
      } else {
        expect(def.episodeField).toBeUndefined();
      }
    }
    expect(episodeOf('task.overdue', { dueDate: '2026-10-01' }, 'on:2026-10-05')).toBe('2026-10-01');
    expect(episodeOf('ap_invoice.submitted', {}, 'at:2026-10-05T10:00:00.000Z')).toBe('at:2026-10-05T10:00:00.000Z');
  });

  it('lets only the events that can raise an exception do so, each under one detector', () => {
    const withException = EVENT_KEYS.filter((key) => (EVENTS[key].actions as readonly string[]).includes('create_exception'));
    expect(withException.sort()).toEqual(['ar_invoice.overdue', 'container.eta_exceeded', 'task.overdue']);
    for (const key of withException) expect(EVENTS[key].exceptionDetector, key).toMatch(/^[a-z]+\.automation_[a-z_]+$/);
    for (const key of EVENT_KEYS.filter((k) => !withException.includes(k))) expect(EVENTS[key].exceptionDetector).toBeUndefined();
  });

  it('lets only a purchase invoice that is waiting be put under review', () => {
    const asking = EVENT_KEYS.filter((key) => (EVENTS[key].actions as readonly string[]).includes('request_approval'));
    expect(asking).toEqual(['ap_invoice.submitted']);
  });

  it('checks a payload against the shape its event declares', () => {
    const ok = { subjectId: 'a', reference: 'PI-1', branchCode: 'HQ', supplierCode: 'S-1', supplierName: 'Sup', amountIqd: '1500.0000', invoiceDate: '2026-10-01', raisedBy: '11111111-1111-4111-8111-111111111111' };
    expect(payloadProblems('ap_invoice.submitted', ok)).toEqual([]);
    expect(payloadProblems('ap_invoice.submitted', { ...ok, extra: 1 })).toEqual(['ap_invoice.submitted does not carry "extra"']);
    expect(payloadProblems('ap_invoice.submitted', { ...ok, amountIqd: 'lots' })[0]).toMatch(/amountIqd must be an amount/);
    const { supplierName: _gone, ...missing } = ok;
    expect(payloadProblems('ap_invoice.submitted', missing)).toEqual(['ap_invoice.submitted needs "supplierName"']);
    expect(payloadProblems('task.overdue', { subjectId: 'x', reference: 'T', branchCode: 'HQ', taskTitle: 't', assigneeId: 'nope', priority: 'high', departmentCode: 'FIN', dueDate: '2026-10-01', daysLate: -1 }).length).toBe(2);
    expect(subjectKeyOf('task.overdue', { subjectId: 'abc' })).toBe('task:abc');
  });

  it('files each event under its own notification kind', () => {
    expect(noticeKind('ap_invoice.submitted')).toBe('automation.ap_invoice_submitted');
    expect(eventLabelKey('container.eta_exceeded')).toBe('container_eta_exceeded');
    expect(new Set(EVENT_KEYS.map(noticeKind)).size).toBe(EVENT_KEYS.length);
  });
});

describe('conditions', () => {
  it('accepts a money threshold, a number of days and a code, in their canonical form', () => {
    expect(validateConditions('ap_invoice.submitted', [{ field: 'amountIqd', op: 'gte', value: '5000000' }])).toEqual([{ field: 'amountIqd', op: 'gte', value: '5000000.0000' }]);
    expect(validateConditions('task.overdue', [{ field: 'daysLate', op: 'gt', value: '3' }])).toEqual([{ field: 'daysLate', op: 'gt', value: 3 }]);
    expect(validateConditions('task.overdue', [{ field: 'priority', op: 'in', value: ['high', 'urgent', 'high'] }])).toEqual([{ field: 'priority', op: 'in', value: ['high', 'urgent'] }]);
    expect(validateConditions('ap_invoice.submitted', [])).toEqual([]);
  });

  it('refuses what is not in the vocabulary: unknown fields, operators, keys, types and sizes', () => {
    const cases: [string, unknown, RegExp][] = [
      ['ap_invoice.submitted', [{ field: 'notes', op: 'eq', value: 'x' }], /no field "notes"/],
      ['ap_invoice.submitted', [{ field: 'reference', op: 'eq', value: 'PI-1' }], /no field "reference" a condition may test/],
      ['ap_invoice.submitted', [{ field: 'amountIqd', op: 'matches', value: '1' }], /not an operator/],
      ['ap_invoice.submitted', [{ field: 'amountIqd', op: 'in', value: ['1'] }], /cannot be tested with "in"/],
      ['ap_invoice.submitted', [{ field: 'branchCode', op: 'gte', value: 'HQ' }], /cannot be tested with "gte"/],
      ['ap_invoice.submitted', [{ field: 'amountIqd', op: 'gte', value: '1', script: 'x' }], /has no "script"/],
      ['ap_invoice.submitted', [{ field: 'amountIqd', op: 'gte', value: 'amount > 5' }], /not an amount/],
      ['ap_invoice.submitted', [{ field: 'amountIqd', op: 'gte', value: '1.00001' }], /not an amount/],
      ['ap_invoice.submitted', [{ field: 'amountIqd', op: 'gte', value: '-1' }], /cannot be negative/],
      ['task.overdue', [{ field: 'daysLate', op: 'gte', value: 'three' }], /whole number of days/],
      ['task.overdue', [{ field: 'daysLate', op: 'gte', value: 1.5 }], /whole number of days/],
      ['task.overdue', [{ field: 'priority', op: 'eq', value: "x'; drop table task; --" }], /short code/],
      ['task.overdue', [{ field: 'priority', op: 'in', value: [] }], /list of one to/],
      ['task.overdue', 'priority = high', /list/],
      ['task.overdue', [{ field: 'priority' }], /no field|operator|short code/],
      ['no.such_event', [], /not an event/],
    ];
    for (const [event, input, message] of cases) expect(() => validateConditions(event, input), JSON.stringify(input)).toThrowError(message);
    expect(() => validateConditions('task.overdue', Array.from({ length: CONDITIONS_MAX + 1 }, () => ({ field: 'daysLate', op: 'gte', value: 1 })))).toThrowError(/at most/);
  });

  it('carries no expression, script or query: the vocabulary has no key that holds one', () => {
    const source = read('src/server/domain/automation.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(source).not.toMatch(/\beval\b|new Function|\bvm\b|child_process|\.execute\(|sql`|from 'drizzle/);
  });
});

describe('actions', () => {
  const task = { kind: 'create_task', assignee: { kind: 'record_assignee' }, departmentCode: 'FIN', title: 'Chase it', priority: 'high', dueInDays: 2, note: '' };

  it('accepts each of the five kinds on an event that allows it', () => {
    const checked = validateActions('task.overdue', [
      { kind: 'create_notification', recipients: [{ kind: 'record_assignee' }, { kind: 'role', roleCode: 'ceo' }] },
      task,
      { kind: 'create_exception', severity: 'high', note: 'x' },
    ]);
    expect(checked.map((a) => a.kind)).toEqual(['create_notification', 'create_task', 'create_exception']);
    expect(validateActions('ap_invoice.submitted', [{ kind: 'request_approval' }, { kind: 'open_workflow', recipients: [{ kind: 'role', roleCode: 'ceo' }] }]).length).toBe(2);
  });

  it('refuses an action the event does not allow, and a recipient it cannot name', () => {
    expect(() => validateActions('task.overdue', [{ kind: 'request_approval' }])).toThrowError(/cannot request approval/);
    expect(() => validateActions('ap_invoice.posted', [{ kind: 'create_exception', severity: 'high' }])).toThrowError(/cannot create exception/);
    expect(() => validateActions('container.eta_exceeded', [{ kind: 'create_notification', recipients: [{ kind: 'record_assignee' }] }])).toThrowError(/no "record_assignee"/);
    expect(() => validateActions('ap_invoice.submitted', [{ kind: 'create_notification', recipients: [{ kind: 'assignee_supervisor' }] }])).toThrowError(/no "assignee_supervisor"/);
  });

  it('refuses the unknown: a kind, a key, a role that is not a code, a task for a role, a loose priority', () => {
    const cases: [string, unknown, RegExp][] = [
      ['task.overdue', [{ kind: 'post_journal' }], /not something a rule can do/],
      ['task.overdue', [{ kind: 'send_message', recipients: [] }], /not something a rule can do/],
      ['task.overdue', [{ kind: 'create_notification', recipients: [{ kind: 'record_assignee' }], sql: 'x' }], /has no "sql"/],
      ['task.overdue', [{ kind: 'create_notification', recipients: [{ kind: 'role', roleCode: 'Drop Table' }] }], /name the role/],
      ['task.overdue', [{ kind: 'create_notification', recipients: [{ kind: 'user', userId: 'bob' }] }], /name the person/],
      ['task.overdue', [{ kind: 'create_notification', recipients: [] }], /one to/],
      ['task.overdue', [{ ...task, assignee: { kind: 'role', roleCode: 'ceo' } }], /not to a role/],
      ['task.overdue', [{ ...task, priority: 'whenever' }], /priority is one of/],
      ['task.overdue', [{ ...task, dueInDays: 400 }], /due in 0 to/],
      ['task.overdue', [{ ...task, title: 'x' }], /title/],
      ['task.overdue', [{ kind: 'create_exception', severity: 'catastrophic' }], /severity is one of/],
      ['task.overdue', [{ kind: 'create_notification', recipients: [{ kind: 'record_assignee' }], note: 'x'.repeat(301) }], /at most 300/],
      ['task.overdue', [], /at least one/],
      ['ap_invoice.submitted', [{ kind: 'request_approval' }, { kind: 'request_approval' }], /once/],
    ];
    for (const [event, input, message] of cases) expect(() => validateActions(event, input), JSON.stringify(input)).toThrowError(message);
    expect(() => validateActions('task.overdue', Array.from({ length: ACTIONS_MAX + 1 }, () => ({ kind: 'create_notification', recipients: [{ kind: 'record_assignee' }] })))).toThrowError(/at most/);
  });

  it('never offers an action that posts, pays, receives or moves stock', () => {
    // The kinds are the whole list, and none of them is a financial act.
    expect([...ACTION_KINDS].sort()).toEqual(['create_exception', 'create_notification', 'create_task', 'open_workflow', 'request_approval']);
    for (const kind of ACTION_KINDS) expect(kind).not.toMatch(/post|pay|receipt|stock|journal|approve$|reverse|edit|delete/);
  });
});

describe('the evaluator', () => {
  const definition = validateDefinition(
    'ap_invoice.submitted',
    [{ field: 'amountIqd', op: 'gte', value: '5000000' }, { field: 'branchCode', op: 'in', value: ['HQ', 'ERB'] }],
    [{ kind: 'request_approval' }, { kind: 'create_notification', recipients: [{ kind: 'role', roleCode: 'ceo' }] }],
  );
  const payload = { subjectId: 'x', reference: 'PI-1', branchCode: 'HQ', supplierCode: 'S', supplierName: 'Sup', amountIqd: '5000000.0000', invoiceDate: '2026-10-01', raisedBy: null };

  it('matches at the boundary, exactly, and plans the actions in order', () => {
    const result = evaluate(definition, payload);
    expect(result.matched).toBe(true);
    expect(result.unmet).toEqual([]);
    expect(result.planned.map((a) => a.kind)).toEqual(['request_approval', 'create_notification']);
  });

  it('compares money as scaled integers: a dinar short does not match, and long decimals do not drift', () => {
    expect(evaluate(definition, { ...payload, amountIqd: '4999999.9999' }).matched).toBe(false);
    expect(evaluate(definition, { ...payload, amountIqd: '9007199254740993.0000' }).matched).toBe(true);
    const tight = validateDefinition('ap_invoice.submitted', [{ field: 'amountIqd', op: 'eq', value: '9007199254740993' }], [{ kind: 'request_approval' }]);
    expect(evaluate(tight, { ...payload, amountIqd: '9007199254740992.0000' }).matched).toBe(false);
    expect(evaluate(tight, { ...payload, amountIqd: '9007199254740993.0000' }).matched).toBe(true);
  });

  it('says every condition that did not hold, and plans nothing', () => {
    const result = evaluate(definition, { ...payload, amountIqd: '100.0000', branchCode: 'BAS' });
    expect(result.matched).toBe(false);
    expect(result.unmet.map((u) => u.field)).toEqual(['amountIqd', 'branchCode']);
    expect(result.unmet[0]).toMatchObject({ actual: '100.0000', expected: '5000000.0000' });
    expect(result.planned).toEqual([]);
  });

  it('does not match a field the payload left empty', () => {
    expect(evaluate(definition, { ...payload, branchCode: null }).matched).toBe(false);
  });

  it('is deterministic: same inputs, same answer, whatever the order of the payload or the clock', () => {
    const shuffled = Object.fromEntries(Object.entries(payload).reverse());
    const first = evaluate(definition, payload);
    for (let i = 0; i < 20; i += 1) expect(evaluate(definition, i % 2 ? shuffled : payload)).toEqual(first);
    const source = read('src/server/domain/automation.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const evaluator = source.slice(source.indexOf('export function evaluate'), source.indexOf('export const runKeyOf'));
    expect(evaluator).not.toMatch(/Date\.now|new Date\(|Math\.random|process\.env|crypto/);
  });

  it('keys a run by rule, event, record and stretch, so a rule acts once on one', () => {
    expect(runKeyOf('r1', 'task.overdue', 'task:abc', '2026-10-01')).toBe('r1|task.overdue|task:abc|2026-10-01');
    expect(runKeyOf('r1', 'task.overdue', 'task:abc', '2026-10-01')).not.toBe(runKeyOf('r2', 'task.overdue', 'task:abc', '2026-10-01'));
  });
});

describe('runs, retries and pausing', () => {
  const result = (status: ActionResult['status']): ActionResult => ({ index: 0, kind: 'create_notification', status, detail: 'x' });

  it('decides the outcome from what each step did', () => {
    expect(outcomeOf([result('done'), result('skipped')])).toBe('done');
    expect(outcomeOf([result('carried'), result('skipped')])).toBe('done');
    expect(outcomeOf([result('skipped'), result('skipped')])).toBe('skipped');
    expect(outcomeOf([result('done'), result('failed')])).toBe('failed');
    expect(outcomeOf([])).toBe('skipped');
  });

  it('retries a failed run at one, ten and sixty minutes, three times, then stops', () => {
    const now = new Date('2026-10-05T10:00:00Z');
    expect(nextAttemptAt(1, now)?.toISOString()).toBe('2026-10-05T10:01:00.000Z');
    expect(nextAttemptAt(2, now)?.toISOString()).toBe('2026-10-05T10:10:00.000Z');
    expect(nextAttemptAt(MAX_ATTEMPTS, now)).toBeNull();
  });

  it('pauses a rule after N events in a row end in failure', () => {
    expect(shouldPause(2, 3)).toBe(false);
    expect(shouldPause(3, 3)).toBe(true);
    expect(shouldPause(0, 0)).toBe(false);
  });
});

describe('the loop guard', () => {
  const made = (ruleId: string, depth: number) => ({ ruleId, ruleNo: 'AUT-004', depth });

  it('lets automation act on what a person made, and what its actions then make is one step from a person', () => {
    expect(guardOf(null, 'r1')).toEqual({ allowed: true, depth: 1 });
  });

  it('never lets a rule act on a record it made itself', () => {
    const verdict = guardOf(made('r1', 1), 'r1');
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toMatch(/made by this rule itself \(AUT-004\).*cannot start a loop/);
  });

  it('lets another rule act on it once, one step further, and then stops the chain', () => {
    expect(guardOf(made('r1', 1), 'r2')).toEqual({ allowed: true, depth: 2 });
    const stopped = guardOf(made('r1', MAX_DEPTH), 'r2');
    expect(stopped.allowed).toBe(false);
    if (!stopped.allowed) expect(stopped.reason).toMatch(/chain stops after 2 steps/);
  });

  it('is pure: the same inputs give the same verdict', () => {
    for (let i = 0; i < 10; i += 1) expect(guardOf(made('a', 1), 'b')).toEqual(guardOf(made('a', 1), 'b'));
  });
});

describe('the templates', () => {
  it('are the four the brief names and a notice for a large posted invoice, each on an event of the catalogue', () => {
    expect([...TEMPLATE_CODES]).toEqual(['invoice_over_threshold', 'container_eta_exceeded', 'task_overdue', 'invoice_overdue_follow_up', 'invoice_posted_notice']);
    expect(TEMPLATES.invoice_posted_notice.eventKey).toBe('ap_invoice.posted');
    // Every event a rule can be built on has a template: nothing in the catalogue is unreachable.
    expect(new Set(TEMPLATE_CODES.map((c) => TEMPLATES[c].eventKey))).toEqual(new Set(EVENT_KEYS));
    expect(TEMPLATES.invoice_over_threshold.eventKey).toBe('ap_invoice.submitted');
    expect(TEMPLATES.container_eta_exceeded.eventKey).toBe('container.eta_exceeded');
    expect(TEMPLATES.task_overdue.eventKey).toBe('task.overdue');
    expect(TEMPLATES.invoice_overdue_follow_up.eventKey).toBe('ar_invoice.overdue');
  });

  it('carry no firing default: every number, person and role is left to the administrator', () => {
    const source = read('src/server/domain/automation-templates.ts');
    expect(source).not.toMatch(/default[A-Z]?\w*\s*[:=]\s*[\d'"]/);
    for (const code of TEMPLATE_CODES) {
      const required = TEMPLATES[code].params.filter((p) => p.required && !p.whenFlag);
      expect(required.length, code).toBeGreaterThan(0);
      // Nothing is filled in for them: asking for the parameters with nothing given refuses.
      expect(() => parseParams(code, {}), code).toThrowError(AutomationError);
    }
  });

  it('builds a validated definition from parameters, template 1: an invoice over a threshold', () => {
    const params = parseParams('invoice_over_threshold', { thresholdIqd: '5,000,000', notifyRole: 'ceo', note: 'Large invoice' });
    const built = buildDefinition('invoice_over_threshold', params);
    expect(built.eventKey).toBe('ap_invoice.submitted');
    expect(built.conditions).toEqual([{ field: 'amountIqd', op: 'gte', value: '5000000.0000' }]);
    expect(built.actions.map((a) => a.kind)).toEqual(['request_approval', 'open_workflow']);
  });

  it('template 2: a container past its ETA, with the follow-up task only when asked for', () => {
    const base = { daysLate: '3', severity: 'high', notifyRole: 'logistics_officer' };
    const without = buildDefinition('container_eta_exceeded', parseParams('container_eta_exceeded', base));
    expect(without.actions.map((a) => a.kind)).toEqual(['create_exception', 'create_notification']);
    const withTask = buildDefinition(
      'container_eta_exceeded',
      parseParams('container_eta_exceeded', {
        ...base,
        followUp: 'on',
        taskAssignee: '11111111-1111-4111-8111-111111111111',
        taskDepartment: 'LOG',
        taskTitle: 'Chase the shipping line',
        taskPriority: 'high',
        taskDueInDays: '2',
      }),
    );
    expect(withTask.actions.map((a) => a.kind)).toEqual(['create_exception', 'create_notification', 'create_task']);
    expect(() => parseParams('container_eta_exceeded', { ...base, followUp: 'on' })).toThrowError(/taskAssignee: required/);
    // Parameters of a switched-off follow-up are dropped, not half-kept.
    expect(parseParams('container_eta_exceeded', { ...base, taskAssignee: 'whatever' })).not.toHaveProperty('taskAssignee');
  });

  it('template 3: a task that is overdue, told to the assignee and/or the supervisor — at least one', () => {
    const both = buildDefinition('task_overdue', parseParams('task_overdue', { daysLate: '1', notifyAssignee: 'on', notifySupervisor: 'on' }));
    expect(both.actions[0]).toMatchObject({ kind: 'create_notification', recipients: [{ kind: 'record_assignee' }, { kind: 'assignee_supervisor' }] });
    expect(() => buildDefinition('task_overdue', parseParams('task_overdue', { daysLate: '1' }))).toThrowError(/Choose who is told/);
  });

  it('template 4: an overdue sales invoice, a task and a notice for whoever raised it, an optional minimum amount', () => {
    const base = { daysLate: '7', taskDepartment: 'FIN', taskTitle: 'Chase the customer', taskPriority: 'normal', taskDueInDays: '3' };
    expect(buildDefinition('invoice_overdue_follow_up', parseParams('invoice_overdue_follow_up', base)).conditions).toEqual([{ field: 'daysLate', op: 'gte', value: 7 }]);
    const minimum = buildDefinition('invoice_overdue_follow_up', parseParams('invoice_overdue_follow_up', { ...base, minimumAmountIqd: '250000' }));
    expect(minimum.conditions).toEqual([{ field: 'daysLate', op: 'gte', value: 7 }, { field: 'amountIqd', op: 'gte', value: '250000.0000' }]);
    expect(minimum.actions.map((a) => a.kind)).toEqual(['create_task', 'create_notification']);
  });

  it('template 5: a purchase invoice posted over an amount tells a role, and holds and posts nothing', () => {
    const built = buildDefinition('invoice_posted_notice', parseParams('invoice_posted_notice', { thresholdIqd: '20,000,000', notifyRole: 'ceo' }));
    expect(built.eventKey).toBe('ap_invoice.posted');
    expect(built.conditions).toEqual([{ field: 'amountIqd', op: 'gte', value: '20000000.0000' }]);
    expect(built.actions.map((a) => a.kind)).toEqual(['create_notification']);
  });

  it('refuses parameters that will not do, in the parameter\'s own words', () => {
    const cases: [Parameters<typeof parseParams>[0], Record<string, string>, RegExp][] = [
      ['invoice_over_threshold', { thresholdIqd: '0', notifyRole: 'ceo' }, /thresholdIqd: an amount above zero/],
      ['invoice_over_threshold', { thresholdIqd: 'many', notifyRole: 'ceo' }, /thresholdIqd: an amount in dinars/],
      ['invoice_over_threshold', { thresholdIqd: '10', notifyRole: 'CEO!' }, /notifyRole: choose a role/],
      ['task_overdue', { daysLate: '0' }, /daysLate: at least 1/],
      ['task_overdue', { daysLate: '1.5' }, /daysLate: a whole number/],
      ['container_eta_exceeded', { daysLate: '2', severity: 'dire', notifyRole: 'ceo' }, /severity: one of/],
      ['invoice_overdue_follow_up', { daysLate: '2', taskDepartment: 'FIN', taskTitle: 'x', taskPriority: 'normal', taskDueInDays: '1' }, /taskTitle: 3 to 120/],
    ];
    for (const [code, raw, message] of cases) expect(() => parseParams(code, raw), JSON.stringify(raw)).toThrowError(message);
  });

  it('every built definition passes the same validation as a hand-written one', () => {
    const params = parseParams('task_overdue', { daysLate: '2', notifyAssignee: 'on' });
    const built = buildDefinition('task_overdue', params);
    expect(validateDefinition(built.eventKey, built.conditions, built.actions)).toEqual(built);
    expect(money('x')).toBe('x');
  });
});

describe('what automation is not allowed to touch (no financial posting, ever)', () => {
  const FILES = [
    'src/server/domain/automation.ts',
    'src/server/domain/automation-events.ts',
    'src/server/domain/automation-templates.ts',
    ...readdirSync('src/server/services').filter((f) => /^automation[-.]/.test(f)).map((f) => `src/server/services/${f}`),
  ];
  const strip = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const FORBIDDEN_IMPORTS =
    /from '\.\/(journal|posting|inventory|inventory-integrity|fifo|stock-operations|stock-count|supplier-payment|payment-applications|payment-run|customer-receipt|receipt-allocation|ar-invoice|goods-receipt|goods-return|sales-return|landed-cost|payroll|treasury|money-transfer|bank-reconciliation|bank-deposits|periods|closing|reversal|supplier-advance|customer-credits|ap-invoice)'/;

  it('has files to look at', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(6);
  });

  it('imports no service that posts, pays, receives, reverses or moves stock', () => {
    for (const file of FILES) expect(strip(read(file)), file).not.toMatch(FORBIDDEN_IMPORTS);
  });

  it('writes to no ledger, stock, payment or posting table', () => {
    for (const file of FILES) {
      const code = strip(read(file));
      expect(code, file).not.toMatch(/\b(insert\s+into|update|delete\s+from)\s+"?(journal_entry|journal_line|inventory_movement|cost_layer|stock_position|supplier_payment|customer_receipt|payment_application|bank_statement|ap_invoice|ar_invoice|goods_receipt|payable)\b/i);
      expect(code, file).not.toMatch(/\.(insert|update|delete)\((journalEntry|journalLine|inventoryMovement|costLayer|supplierPayment|customerReceipt|apInvoice|arInvoice|goodsReceipt|payable)\b/);
    }
  });
});
