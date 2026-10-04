/**
 * Recurring Journals — REQ-ACC-001 Part D-7, migration 0291.
 *
 * A template that raises the same journal on a schedule: rent, depreciation,
 * subscriptions, accruals. It never posts. Raising it is `journal.createDraft`
 * and `journal.addLine` — the ordinary draft journal, numbered from the
 * ordinary series, its rate and dimensions resolved by the journal engine,
 * submitted, approved and posted by the ordinary people under the ordinary
 * period locks. There is no second posting mechanism here.
 *
 *   draft ──activate (not by its writer)──▶ active ⇄ paused
 *     │                                       │
 *     └───────────────── end (reason) ────────┴──▶ ended
 *
 * Its lines are typed while it is a draft (frozen after, by the database);
 * `raiseDue` raises one draft journal per due date, never two for one date
 * (`recurring_journal_run_due_uniq`), and moves the next due date on.
 */
import { and, asc, desc, eq, isNotNull, lte, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { appUser, chartOfAccount, journalEntry, recurringJournal, recurringJournalLine, recurringJournalRun } from '../db/schema';
import { RECURRING_FREQUENCIES } from '../db/schema/recurring-journals';
import { addMonths } from '../domain/dates';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '../domain/money';
import type { ActorContext } from './chart-of-accounts';
import * as audit from './audit';
import * as authz from './authorization';
import * as journal from './journal';
import { allocateFreeCode } from './numbering';
import { countOf, registerPage, searchOf, whereOf, type RegisterPaging } from './register-page';

/** Recurring journals raise journal entries, and are authorised as they are. */
export const PERMISSION_OBJECT = 'journal_entry';
export const DOCUMENT_TYPE = 'recurring_journal';

export type RecurringFrequency = (typeof RECURRING_FREQUENCIES)[number];
export { RECURRING_FREQUENCIES };

export class RecurringJournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecurringJournalError';
  }
}

export class RecurringJournalNotFoundError extends Error {
  readonly code = 'RECURRING_JOURNAL_NOT_FOUND';
  constructor(readonly templateNo: string) {
    super(`No recurring journal numbered ${templateNo}.`);
  }
}

/** Months between two due dates. */
export function monthsPer(frequency: RecurringFrequency, interval: number): number {
  const base = frequency === 'monthly' ? 1 : frequency === 'quarterly' ? 3 : 12;
  return base * interval;
}

/**
 * The due date after `from`, kept on the starting day of the month where the
 * month has it (31 January, 28 February, 31 March) — counted from the start,
 * not from the last due date, so a short month does not drag every later one.
 */
export function dueAfter(startsOn: string, from: string, frequency: RecurringFrequency, interval: number): string {
  const step = monthsPer(frequency, interval);
  let n = 0;
  let due = startsOn;
  while (due <= from) {
    n += 1;
    due = addMonths(startsOn, n * step);
  }
  return due;
}

async function lock(tx: Tx, id: string) {
  const [row] = await tx.select().from(recurringJournal).where(eq(recurringJournal.id, id)).limit(1).for('update');
  if (!row) throw new RecurringJournalError(`No recurring journal with id '${id}'.`);
  return row;
}

async function byNo(tx: Tx, templateNo: string) {
  const [row] = await tx.select().from(recurringJournal).where(eq(recurringJournal.templateNo, templateNo)).limit(1);
  if (!row) throw new RecurringJournalNotFoundError(templateNo);
  return row;
}

function assertDate(value: string, field: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RecurringJournalError(`State the ${field} as a date.`);
}

export interface TemplateInput {
  readonly name: string;
  readonly description?: string | null;
  readonly frequency: RecurringFrequency;
  readonly intervalCount?: number;
  readonly startsOn: string;
  readonly endsOn?: string | null;
}

function checkSchedule(input: TemplateInput) {
  if (!input.name?.trim()) throw new RecurringJournalError('Name the recurring journal — rent, depreciation, a subscription.');
  if (!(RECURRING_FREQUENCIES as readonly string[]).includes(input.frequency)) {
    throw new RecurringJournalError('A recurring journal falls due monthly, quarterly or yearly.');
  }
  const interval = input.intervalCount ?? 1;
  if (!Number.isInteger(interval) || interval < 1 || interval > 12) throw new RecurringJournalError('Every 1 to 12 of them.');
  assertDate(input.startsOn, 'first due date');
  if (input.endsOn) {
    assertDate(input.endsOn, 'last date');
    if (input.endsOn < input.startsOn) throw new RecurringJournalError('It cannot end before it starts.');
  }
  return interval;
}

/** A new template, a draft: its schedule now, its lines on its record. */
export async function create(tx: Tx, ctx: ActorContext, input: TemplateInput): Promise<{ id: string; templateNo: string }> {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, { branchCode: ctx.branchCode });
  const interval = checkSchedule(input);
  const templateNo = await allocateFreeCode(
    tx,
    'RECURRING_JOURNAL',
    async (candidate) =>
      Boolean((await tx.select({ id: recurringJournal.id }).from(recurringJournal).where(eq(recurringJournal.templateNo, candidate)))[0]),
    ctx.principal.userId,
  );
  const [made] = await tx
    .insert(recurringJournal)
    .values({
      templateNo,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      branchCode: ctx.branchCode,
      frequency: input.frequency,
      intervalCount: interval,
      startsOn: input.startsOn,
      endsOn: input.endsOn || null,
      nextDueOn: input.startsOn,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: recurringJournal.id });
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'recurring_journal.created',
    objectType: DOCUMENT_TYPE,
    objectId: made!.id,
    branchCode: ctx.branchCode,
    after: { templateNo, name: input.name.trim(), frequency: input.frequency, interval, startsOn: input.startsOn, endsOn: input.endsOn ?? null },
    outcome: 'success',
  });
  return { id: made!.id, templateNo };
}

/** The schedule and the name, while it is a draft. */
export async function updateDraft(tx: Tx, ctx: ActorContext, id: string, input: TemplateInput): Promise<void> {
  const row = await lock(tx, id);
  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, { branchCode: row.branchCode, objectId: id });
  if (row.status !== 'draft') throw new RecurringJournalError(`${row.templateNo} is ${row.status}; only a draft is changed. End it and write a new one.`);
  const interval = checkSchedule(input);
  await tx
    .update(recurringJournal)
    .set({
      name: input.name.trim(),
      description: input.description?.trim() || null,
      frequency: input.frequency,
      intervalCount: interval,
      startsOn: input.startsOn,
      endsOn: input.endsOn || null,
      nextDueOn: input.startsOn,
      updatedAt: new Date(),
    })
    .where(eq(recurringJournal.id, id));
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'recurring_journal.updated',
    objectType: DOCUMENT_TYPE,
    objectId: id,
    branchCode: row.branchCode,
    before: { name: row.name, frequency: row.frequency, interval: row.intervalCount, startsOn: row.startsOn, endsOn: row.endsOn },
    after: { name: input.name.trim(), frequency: input.frequency, interval, startsOn: input.startsOn, endsOn: input.endsOn ?? null },
    outcome: 'success',
  });
}

export interface LineInput {
  readonly accountId: string;
  readonly debit?: string | null;
  readonly credit?: string | null;
  readonly departmentCode?: string | null;
  readonly description?: string | null;
}

/** A line on a draft template: an account, one side, an amount in dinars. */
export async function addLine(tx: Tx, ctx: ActorContext, id: string, input: LineInput): Promise<{ lineNo: number }> {
  const row = await lock(tx, id);
  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, { branchCode: row.branchCode, objectId: id });
  if (row.status !== 'draft') throw new RecurringJournalError(`${row.templateNo} is ${row.status}; its lines are fixed.`);
  const debit = input.debit?.trim() ? parseDecimal(input.debit.replace(/[,\s]/g, ''), MONEY_SCALE) : 0n;
  const credit = input.credit?.trim() ? parseDecimal(input.credit.replace(/[,\s]/g, ''), MONEY_SCALE) : 0n;
  if ((debit > 0n) === (credit > 0n) || debit < 0n || credit < 0n) {
    throw new RecurringJournalError('A line is a debit or a credit, more than nothing — one of the two.');
  }
  const [account] = await tx.select().from(chartOfAccount).where(eq(chartOfAccount.id, input.accountId)).limit(1);
  if (!account || account.isGroup || !account.isActive || account.approvalStatus !== 'approved') {
    throw new RecurringJournalError('Choose an active, approved posting account.');
  }
  const [next] = (await tx.execute(sql`select coalesce(max(line_no), 0) + 1 as n from recurring_journal_line where recurring_journal_id = ${id}`))
    .rows as { n: number }[];
  const lineNo = Number(next?.n ?? 1);
  await tx.insert(recurringJournalLine).values({
    recurringJournalId: id,
    lineNo,
    accountId: input.accountId,
    debit: toDecimalString(debit, MONEY_SCALE),
    credit: toDecimalString(credit, MONEY_SCALE),
    departmentCode: input.departmentCode || null,
    description: input.description?.trim() || null,
  });
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'recurring_journal.line_added',
    objectType: DOCUMENT_TYPE,
    objectId: id,
    branchCode: row.branchCode,
    after: { lineNo, account: `${account.code} · ${account.name}`, debit: toDecimalString(debit, MONEY_SCALE), credit: toDecimalString(credit, MONEY_SCALE) },
    outcome: 'success',
  });
  return { lineNo };
}

export async function removeLine(tx: Tx, ctx: ActorContext, id: string, lineId: string): Promise<void> {
  const row = await lock(tx, id);
  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, { branchCode: row.branchCode, objectId: id });
  if (row.status !== 'draft') throw new RecurringJournalError(`${row.templateNo} is ${row.status}; its lines are fixed.`);
  const removed = await tx
    .delete(recurringJournalLine)
    .where(and(eq(recurringJournalLine.id, lineId), eq(recurringJournalLine.recurringJournalId, id)))
    .returning({ lineNo: recurringJournalLine.lineNo });
  if (removed.length === 0) throw new RecurringJournalError('That line is not on this recurring journal.');
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'recurring_journal.line_removed',
    objectType: DOCUMENT_TYPE,
    objectId: id,
    branchCode: row.branchCode,
    before: { lineNo: removed[0]!.lineNo },
    outcome: 'success',
  });
}

async function linesOf(tx: Tx, id: string) {
  return tx
    .select({
      id: recurringJournalLine.id,
      lineNo: recurringJournalLine.lineNo,
      accountId: recurringJournalLine.accountId,
      accountCode: chartOfAccount.code,
      accountName: chartOfAccount.name,
      debit: recurringJournalLine.debit,
      credit: recurringJournalLine.credit,
      departmentCode: recurringJournalLine.departmentCode,
      description: recurringJournalLine.description,
    })
    .from(recurringJournalLine)
    .innerJoin(chartOfAccount, eq(chartOfAccount.id, recurringJournalLine.accountId))
    .where(eq(recurringJournalLine.recurringJournalId, id))
    .orderBy(asc(recurringJournalLine.lineNo));
}

/**
 * Agreed: from now it raises its journal on every due date. By somebody
 * other than whoever wrote it — one person sets up a standing entry, another
 * agrees to it (the Super User alone excepted, as the database says). It
 * must balance, as every journal it raises will have to.
 */
export async function activate(tx: Tx, ctx: ActorContext, id: string): Promise<void> {
  const row = await lock(tx, id);
  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, { branchCode: row.branchCode, objectId: id });
  if (row.status !== 'draft' && row.status !== 'paused') throw new RecurringJournalError(`${row.templateNo} is ${row.status}.`);
  if (row.status === 'draft' && row.createdBy === ctx.principal.userId && !ctx.principal.isSuperUser) {
    throw new RecurringJournalError(`${row.templateNo} was written by you; somebody else agrees to it.`);
  }
  const lines = await linesOf(tx, id);
  if (lines.length < 2) throw new RecurringJournalError('A journal has at least two lines; add them before it starts.');
  const debit = lines.reduce((sum, line) => sum + parseDecimal(line.debit, MONEY_SCALE), 0n);
  const credit = lines.reduce((sum, line) => sum + parseDecimal(line.credit, MONEY_SCALE), 0n);
  if (debit !== credit) {
    throw new RecurringJournalError(
      `${row.templateNo} does not balance: debits ${toDecimalString(debit, MONEY_SCALE)}, credits ${toDecimalString(credit, MONEY_SCALE)}.`,
    );
  }
  const now = new Date();
  await tx
    .update(recurringJournal)
    .set({
      status: 'active',
      ...(row.status === 'draft' ? { activatedBy: ctx.principal.userId, activatedAt: now } : {}),
      updatedAt: now,
    })
    .where(eq(recurringJournal.id, id));
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: row.status === 'draft' ? 'recurring_journal.activated' : 'recurring_journal.resumed',
    objectType: DOCUMENT_TYPE,
    objectId: id,
    branchCode: row.branchCode,
    before: { status: row.status },
    after: { status: 'active', totalIqd: toDecimalString(debit, MONEY_SCALE) },
    outcome: 'success',
  });
}

/** Held: nothing is raised while it is paused; resumed by `activate`. */
export async function pause(tx: Tx, ctx: ActorContext, id: string, reason: string): Promise<void> {
  const row = await lock(tx, id);
  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, { branchCode: row.branchCode, objectId: id });
  if (row.status !== 'active') throw new RecurringJournalError(`${row.templateNo} is ${row.status}; only an active one is paused.`);
  if (!reason?.trim()) throw new RecurringJournalError('Say why it is paused.');
  await tx.update(recurringJournal).set({ status: 'paused', updatedAt: new Date() }).where(eq(recurringJournal.id, id));
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'recurring_journal.paused',
    objectType: DOCUMENT_TYPE,
    objectId: id,
    branchCode: row.branchCode,
    before: { status: row.status },
    after: { status: 'paused' },
    reason: reason.trim(),
    outcome: 'success',
  });
}

/** Ended for good, with a reason. The journals it raised stay, naming it. */
export async function end(tx: Tx, ctx: ActorContext, id: string, reason: string): Promise<void> {
  const row = await lock(tx, id);
  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, { branchCode: row.branchCode, objectId: id });
  if (row.status === 'ended') throw new RecurringJournalError(`${row.templateNo} has already ended.`);
  if (!reason?.trim()) throw new RecurringJournalError('Say why it ends.');
  const now = new Date();
  await tx
    .update(recurringJournal)
    .set({ status: 'ended', endedBy: ctx.principal.userId, endedAt: now, endReason: reason.trim(), nextDueOn: null, updatedAt: now })
    .where(eq(recurringJournal.id, id));
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'recurring_journal.ended',
    objectType: DOCUMENT_TYPE,
    objectId: id,
    branchCode: row.branchCode,
    before: { status: row.status },
    after: { status: 'ended' },
    reason: reason.trim(),
    outcome: 'success',
  });
}

/**
 * Raises the journal for every due date up to `asOf` — one draft each,
 * through the journal engine, dated the due date. A date already raised is
 * passed over (the run table holds one per date). Returns the journals made.
 * Who raises them must be able to write journals; the drafts then go through
 * submission and approval like any other.
 */
export async function raiseDue(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  asOf: string,
): Promise<{ dueOn: string; entryNo: string }[]> {
  const row = await lock(tx, id);
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, { branchCode: row.branchCode, objectId: id });
  if (row.status !== 'active') throw new RecurringJournalError(`${row.templateNo} is ${row.status}; only an active recurring journal raises journals.`);
  const lines = await linesOf(tx, id);
  const raised: { dueOn: string; entryNo: string }[] = [];
  let due = row.nextDueOn;
  while (due && due <= asOf && (!row.endsOn || due <= row.endsOn)) {
    const [already] = await tx
      .select({ id: recurringJournalRun.id })
      .from(recurringJournalRun)
      .where(and(eq(recurringJournalRun.recurringJournalId, id), eq(recurringJournalRun.dueOn, due)))
      .limit(1);
    if (!already) {
      const draft = await journal.createDraft(tx, ctx, {
        branchCode: row.branchCode,
        documentDate: due,
        postingDate: due,
        description: `${row.name} — ${row.templateNo}`,
      });
      for (const line of lines) {
        await journal.addLine(tx, ctx, draft.id, {
          accountId: line.accountId,
          ...(parseDecimal(line.debit, MONEY_SCALE) > 0n ? { debit: line.debit } : { credit: line.credit }),
          dimensions: { department: line.departmentCode ?? null },
          description: line.description ?? row.name,
        });
      }
      await tx.insert(recurringJournalRun).values({ recurringJournalId: id, dueOn: due, journalEntryId: draft.id, raisedBy: ctx.principal.userId });
      await audit.record(tx, {
        actorUserId: ctx.principal.userId,
        action: 'recurring_journal.raised',
        objectType: DOCUMENT_TYPE,
        objectId: id,
        branchCode: row.branchCode,
        after: { dueOn: due, entryNo: draft.entryNo },
        relatedObjectId: draft.id,
        outcome: 'success',
      });
      raised.push({ dueOn: due, entryNo: draft.entryNo });
    }
    due = dueAfter(row.startsOn, due, row.frequency as RecurringFrequency, row.intervalCount);
  }
  const next = due && (!row.endsOn || due <= row.endsOn) ? due : null;
  await tx.update(recurringJournal).set({ nextDueOn: next, updatedAt: new Date() }).where(eq(recurringJournal.id, id));
  return raised;
}

/** Every active template's journals due up to `asOf` — the screen's "Raise all due". */
export async function raiseAllDue(tx: Tx, ctx: ActorContext, asOf: string): Promise<{ templateNo: string; dueOn: string; entryNo: string }[]> {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, { branchCode: ctx.branchCode });
  const due = await tx
    .select({ id: recurringJournal.id, templateNo: recurringJournal.templateNo })
    .from(recurringJournal)
    .where(and(eq(recurringJournal.status, 'active'), isNotNull(recurringJournal.nextDueOn), lte(recurringJournal.nextDueOn, asOf)))
    .orderBy(asc(recurringJournal.templateNo));
  const raised: { templateNo: string; dueOn: string; entryNo: string }[] = [];
  for (const template of due) {
    for (const made of await raiseDue(tx, ctx, template.id, asOf)) raised.push({ templateNo: template.templateNo, ...made });
  }
  return raised;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export const RECURRING_VIEWS = ['draft', 'active', 'due', 'ended'] as const;
export type RecurringView = (typeof RECURRING_VIEWS)[number];

export interface RecurringRow {
  readonly id: string;
  readonly templateNo: string;
  readonly name: string;
  readonly frequency: RecurringFrequency;
  readonly intervalCount: number;
  readonly startsOn: string;
  readonly endsOn: string | null;
  readonly nextDueOn: string | null;
  readonly status: string;
  readonly totalIqd: string;
  readonly runs: number;
}

const TEMPLATES = sql`(
  select r.id::text as id, r.template_no, r.name, r.frequency, r.interval_count, r.starts_on::text as starts_on,
         r.ends_on::text as ends_on, r.next_due_on::text as next_due_on, r.status, r.created_at, r.branch_code,
         (select coalesce(sum(l.debit), 0)::text from recurring_journal_line l where l.recurring_journal_id = r.id) as total_iqd,
         (select count(*)::int from recurring_journal_run x where x.recurring_journal_id = r.id) as runs
    from recurring_journal r
) x`;

const toRow = (row: Record<string, unknown>): RecurringRow => ({
  id: String(row.id),
  templateNo: String(row.template_no),
  name: String(row.name),
  frequency: String(row.frequency) as RecurringFrequency,
  intervalCount: Number(row.interval_count),
  startsOn: String(row.starts_on),
  endsOn: (row.ends_on as string | null) ?? null,
  nextDueOn: (row.next_due_on as string | null) ?? null,
  status: String(row.status),
  totalIqd: String(row.total_iqd),
  runs: Number(row.runs ?? 0),
});

export async function listForScreen(
  tx: Tx,
  ctx: ActorContext,
  filter: RegisterPaging & { readonly view?: RecurringView | null; readonly search?: string | null; readonly asOf: string },
) {
  await authz.authorize(ctx.principal, 'view', PERMISSION_OBJECT, { branchCode: ctx.branchCode });
  const where = whereOf([
    filter.view === 'draft' ? sql`x.status = 'draft'` : null,
    filter.view === 'active' ? sql`x.status in ('active', 'paused')` : null,
    filter.view === 'due' ? sql`x.status = 'active' and x.next_due_on::date <= ${filter.asOf}::date` : null,
    filter.view === 'ended' ? sql`x.status = 'ended'` : null,
    searchOf([sql`x.template_no`, sql`x.name`], filter.search),
  ]);
  return registerPage<RecurringRow>({
    paging: filter,
    count: () => countOf(tx, sql`from ${TEMPLATES} ${where}`),
    rows: async ({ limit, offset }) => {
      const result = await tx.execute(sql`select * from ${TEMPLATES} ${where} order by x.template_no desc limit ${limit} offset ${offset}`);
      return (result as unknown as { rows: Record<string, unknown>[] }).rows.map(toRow);
    },
  });
}

/** One template by its number: its lines, its people and every journal it raised. */
export async function view(tx: Tx, ctx: ActorContext, templateNo: string) {
  await authz.authorize(ctx.principal, 'view', PERMISSION_OBJECT, { branchCode: ctx.branchCode });
  const row = await byNo(tx, templateNo);
  const lines = await linesOf(tx, row.id);
  const people = await tx
    .select({ id: appUser.id, name: appUser.displayName })
    .from(appUser)
    .where(sql`${appUser.id} in (${sql.join(
      [row.createdBy, row.activatedBy, row.endedBy].filter((v): v is string => Boolean(v)).map((v) => sql`${v}`),
      sql`, `,
    )})`);
  const name = (id: string | null) => (id ? (people.find((p) => p.id === id)?.name ?? null) : null);
  const runs = await tx
    .select({
      dueOn: recurringJournalRun.dueOn,
      entryNo: journalEntry.entryNo,
      status: journalEntry.status,
      raisedAt: recurringJournalRun.raisedAt,
      raisedBy: appUser.displayName,
    })
    .from(recurringJournalRun)
    .innerJoin(journalEntry, eq(journalEntry.id, recurringJournalRun.journalEntryId))
    .leftJoin(appUser, eq(appUser.id, recurringJournalRun.raisedBy))
    .where(eq(recurringJournalRun.recurringJournalId, row.id))
    .orderBy(desc(recurringJournalRun.dueOn));
  const debit = lines.reduce((sum, line) => sum + parseDecimal(line.debit, MONEY_SCALE), 0n);
  const credit = lines.reduce((sum, line) => sum + parseDecimal(line.credit, MONEY_SCALE), 0n);
  return {
    template: row,
    lines,
    runs,
    totals: { debit: toDecimalString(debit, MONEY_SCALE), credit: toDecimalString(credit, MONEY_SCALE), balanced: debit === credit },
    createdByName: name(row.createdBy),
    activatedByName: name(row.activatedBy),
    endedByName: name(row.endedBy),
  };
}

/** The template a journal was raised by, if any — for the journal's own page. */
export async function templateOfJournal(tx: Tx, journalEntryId: string): Promise<{ templateNo: string; dueOn: string } | null> {
  const [row] = await tx
    .select({ templateNo: recurringJournal.templateNo, dueOn: recurringJournalRun.dueOn })
    .from(recurringJournalRun)
    .innerJoin(recurringJournal, eq(recurringJournal.id, recurringJournalRun.recurringJournalId))
    .where(eq(recurringJournalRun.journalEntryId, journalEntryId))
    .limit(1);
  return row ?? null;
}
