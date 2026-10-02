/**
 * PD / ASYCUDA — REQ-AP-001 Stage 4 (§16, §21.8).
 *
 * The customs pre-declaration of an import, kept as current as ASYCUDA:
 *
 *   * **register** — the PD number customs issued, its registration and expiry
 *     dates (typed: the validity is the customs office's) and the bank it is
 *     registered with. `PD_SUBMITTED`.
 *   * **change status** — one row of history per change, with where the news
 *     came from. Validated unlocks payment applications (§15.3 check 1);
 *     Totally written off feeds Cleared (§20.1). A terminal status is final:
 *     a rejected or expired PD is **re-registered**, a new row that names the
 *     one it supersedes, never edited (§16.2).
 *   * **the ASYCUDA list** — paste the document list; the system matches each
 *     line by PD number, shows the difference, and applies it as history rows
 *     with source `asycuda_list` (the sheet's "Check / MATCH / STATUS CHECK").
 *   * **the sweep** — `PD_EXPIRING` at the warning (seed 45 days), and on the
 *     day after expiry the PD moves to its expired status and the import stops
 *     until it is re-registered.
 */
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  appUser,
  bank,
  businessPartner,
  customsPd,
  customsPdStatusHistory,
  payable,
  paymentApplication,
  pdStatus,
  stageTimeLimit,
  type PdHistorySource,
} from '../db/schema';
import {
  PdValidationError,
  daysUntil,
  expiredStatusFor,
  needsReRegistration,
  parseAsycudaList,
  paymentReadiness,
  type PdFacts,
  type PdStatusRow,
  type PaymentReadiness,
} from '../domain/customs-pd';
import { limitInForce } from '../domain/payables';
import type { ActorContext } from './chart-of-accounts';
import * as audit from './audit';
import * as authz from './authorization';
import * as events from './payable-events';
import * as payables from './payables';

export const PERMISSION_OBJECT = 'customs_pd';

export class PdNotFoundError extends Error {
  readonly code = 'PD_NOT_FOUND';
  constructor(ref: string) {
    super(`No PD '${ref}', or it is outside the branches you may see.`);
    this.name = 'PdNotFoundError';
  }
}

const today = () => new Date().toISOString().slice(0, 10);

export async function statuses(tx: Tx): Promise<PdStatusRow[]> {
  return tx.select().from(pdStatus).orderBy(asc(pdStatus.sequence));
}

async function statusMap(tx: Tx) {
  return new Map((await statuses(tx)).map((row) => [row.code, row]));
}

async function load(tx: Tx, id: string) {
  const [row] = await tx.select().from(customsPd).where(eq(customsPd.id, id)).limit(1);
  if (!row) throw new PdNotFoundError(id);
  return row;
}

/** The PDs of one import, with whether a re-registration superseded each. */
export async function factsFor(tx: Tx, payableId: string): Promise<PdFacts[]> {
  const result = await tx.execute(sql`
    select d.id, d.pd_no as "pdNo", d.status_code as "statusCode", d.expiry_date::text as "expiryDate",
           d.bank_code as "bankCode",
           exists (select 1 from customs_pd n where n.supersedes_pd_id = d.id) as superseded
      from customs_pd d
     where d.payable_id = ${payableId}
     order by d.registration_date, d.created_at`);
  return result.rows as unknown as PdFacts[];
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

export interface RegisterInput {
  readonly payableId: string;
  readonly pdNo: string;
  readonly registrationDate: string;
  readonly expiryDate: string;
  readonly bankCode?: string | null;
  /** Usually Submitted; a PD entered late may start further along. */
  readonly statusCode?: string | null;
  readonly note?: string | null;
  readonly supersedesPdId?: string | null;
}

export async function register(tx: Tx, ctx: ActorContext, input: RegisterInput) {
  const owner = await payables.load(tx, input.payableId);
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, { branchCode: owner.branchCode });
  if (owner.payableTypeCode !== 'import') {
    throw new PdValidationError(`${owner.payableNo} is not an import; only imports are declared to customs.`);
  }
  if (owner.cancelledAt) throw new PdValidationError(`${owner.payableNo} is cancelled.`);

  const pdNo = input.pdNo.trim().toUpperCase();
  if (!pdNo) throw new PdValidationError('Give the PD number as ASYCUDA shows it.');
  if (!input.registrationDate || !input.expiryDate) {
    throw new PdValidationError('Give the registration date and the expiry date ASYCUDA shows.');
  }
  if (input.expiryDate < input.registrationDate) {
    throw new PdValidationError(
      `A PD registered on ${input.registrationDate} cannot expire on ${input.expiryDate}. Check the dates on the ASYCUDA screen.`,
    );
  }

  const map = await statusMap(tx);
  const statusCode = input.statusCode || 'submitted';
  const status = map.get(statusCode);
  if (!status || status.active === false) throw new PdValidationError(`'${statusCode}' is not a PD status.`);

  const [duplicate] = await tx
    .select({ id: customsPd.id, payableId: customsPd.payableId })
    .from(customsPd)
    .where(
      and(
        eq(customsPd.pdNo, pdNo),
        sql`${customsPd.registrationYear} = extract(year from ${input.registrationDate}::date)::smallint`,
      ),
    )
    .limit(1);
  if (duplicate) {
    throw new PdValidationError(
      `PD ${pdNo} of ${input.registrationDate.slice(0, 4)} is already registered. One registration, one row — ` +
        'change its status, or re-register it if customs rejected it or it expired.',
    );
  }

  let bankSwift: string | null = null;
  if (input.bankCode) {
    const [known] = await tx.select().from(bank).where(eq(bank.code, input.bankCode)).limit(1);
    if (!known) throw new PdValidationError(`'${input.bankCode}' is not a bank.`);
    bankSwift = known.swiftBic;
  }

  const [created] = await tx
    .insert(customsPd)
    .values({
      pdNo,
      payableId: owner.id,
      branchCode: owner.branchCode,
      registrationDate: input.registrationDate,
      expiryDate: input.expiryDate,
      bankCode: input.bankCode || null,
      bankSwift,
      statusCode,
      statusDate: input.registrationDate,
      supersedesPdId: input.supersedesPdId ?? null,
      lastNote: input.note?.trim() || null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: customsPd.id });

  await tx.insert(customsPdStatusHistory).values({
    pdId: created!.id,
    statusCode,
    effectiveDate: input.registrationDate,
    source: 'user',
    note: input.note?.trim() || null,
    recordedBy: ctx.principal.userId,
  });

  await events.record(tx, {
    payableId: owner.id,
    eventCode: 'PD_SUBMITTED',
    summary:
      `PD ${pdNo} registered in ASYCUDA on ${input.registrationDate}, valid until ${input.expiryDate}` +
      (statusCode !== 'submitted' ? ` — ${status.name}` : ''),
    sourceType: PERMISSION_OBJECT,
    sourceId: created!.id,
    sourceNo: pdNo,
    actorUserId: ctx.principal.userId,
  });
  if (input.note?.trim()) {
    await events.record(tx, {
      payableId: owner.id,
      eventCode: 'PD_NOTE',
      summary: `PD ${pdNo}: ${input.note.trim()}`,
      sourceType: PERMISSION_OBJECT,
      sourceId: created!.id,
      sourceNo: pdNo,
      actorUserId: ctx.principal.userId,
    });
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'customs_pd.registered',
    objectType: PERMISSION_OBJECT,
    objectId: created!.id,
    branchCode: owner.branchCode,
    after: {
      pdNo,
      payableNo: owner.payableNo,
      registrationDate: input.registrationDate,
      expiryDate: input.expiryDate,
      status: statusCode,
      bank: input.bankCode ?? null,
    },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
  await payables.recomputeStage(tx, owner.id, ctx.principal.userId);
  return { id: created!.id, pdNo };
}

// ---------------------------------------------------------------------------
// Status changes
// ---------------------------------------------------------------------------

export interface StatusChangeInput {
  readonly statusCode: string;
  readonly effectiveDate: string;
  readonly note?: string | null;
  readonly source?: PdHistorySource;
}

/** One status change, one history row, the matching events. `ctx` null = the sweep. */
export async function changeStatus(tx: Tx, ctx: ActorContext | null, pdId: string, input: StatusChangeInput) {
  const pd = await load(tx, pdId);
  if (ctx) await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, { branchCode: pd.branchCode });

  const map = await statusMap(tx);
  const from = map.get(pd.statusCode)!;
  const to = map.get(input.statusCode);
  if (!to || to.active === false) throw new PdValidationError(`'${input.statusCode}' is not a PD status.`);
  if (to.code === from.code) {
    throw new PdValidationError(`PD ${pd.pdNo} is already ${from.name}.`);
  }
  if (from.isTerminal) {
    throw new PdValidationError(
      `PD ${pd.pdNo} is ${from.name}, which is final. ` +
        (from.isExpired || from.code === 'rejected'
          ? 'Re-register it: the new PD supersedes this one, and this one stays as customs left it (§16.2).'
          : 'Nothing follows a totally written-off PD.'),
    );
  }
  if (!input.effectiveDate) throw new PdValidationError('Give the date ASYCUDA shows for the change.');
  if (input.effectiveDate < pd.registrationDate) {
    throw new PdValidationError(
      `A status on ${input.effectiveDate} is before PD ${pd.pdNo} was registered (${pd.registrationDate}).`,
    );
  }
  const note = input.note?.trim() || null;
  const source = input.source ?? 'user';

  await tx
    .update(customsPd)
    .set({
      statusCode: to.code,
      statusDate: input.effectiveDate,
      ...(note ? { lastNote: note } : {}),
      updatedAt: new Date(),
    })
    .where(eq(customsPd.id, pdId));
  await tx.insert(customsPdStatusHistory).values({
    pdId,
    statusCode: to.code,
    effectiveDate: input.effectiveDate,
    source,
    note,
    recordedBy: ctx?.principal.userId ?? null,
  });

  if (pd.payableId) {
    const sourceText =
      source === 'asycuda_list' ? ' (ASYCUDA list)' : source === 'sweep' ? ' (expiry)' : source === 'asycuda_screenshot' ? ' (ASYCUDA screenshot)' : '';
    const base = {
      payableId: pd.payableId,
      sourceType: PERMISSION_OBJECT,
      sourceId: pd.id,
      sourceNo: pd.pdNo,
      actorUserId: ctx?.principal.userId ?? null,
    };
    await events.record(tx, {
      ...base,
      eventCode: 'PD_STATUS_CHANGED',
      summary: `PD ${pd.pdNo}: ${from.name} → ${to.name} on ${input.effectiveDate}${sourceText}${note ? ` — ${note}` : ''}`,
      before: { status: from.code },
      after: { status: to.code },
    });
    const special =
      to.code === 'totally_written_off'
        ? { code: 'PD_TOTALLY_WRITTEN_OFF', text: `PD ${pd.pdNo} totally written off — settled with customs` }
        : to.code === 'rejected'
          ? { code: 'PD_REJECTED', text: `PD ${pd.pdNo} rejected — re-register it` }
          : to.isExpired
            ? { code: 'PD_EXPIRED', text: `PD ${pd.pdNo} expired on ${pd.expiryDate} — re-register it` }
            : null;
    if (special) await events.record(tx, { ...base, eventCode: special.code, summary: special.text });
    await payables.recomputeStage(tx, pd.payableId, ctx?.principal.userId ?? null);
  }

  await audit.record(tx, {
    actorUserId: ctx?.principal.userId ?? null,
    action: 'customs_pd.status_changed',
    objectType: PERMISSION_OBJECT,
    objectId: pdId,
    branchCode: pd.branchCode,
    before: { status: from.code },
    after: { status: to.code, effectiveDate: input.effectiveDate, source },
    reason: note,
    outcome: 'success',
    requestId: ctx?.requestId ?? null,
  });
}

/** A note on a PD — "port file needed urgently", "3597 needs SWIFT". Also an event. */
export async function addNote(tx: Tx, ctx: ActorContext, pdId: string, note: string) {
  const pd = await load(tx, pdId);
  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, { branchCode: pd.branchCode });
  const text = note.trim();
  if (!text) throw new PdValidationError('A note says something.');
  await tx.update(customsPd).set({ lastNote: text, updatedAt: new Date() }).where(eq(customsPd.id, pdId));
  if (pd.payableId) {
    await events.record(tx, {
      payableId: pd.payableId,
      eventCode: 'PD_NOTE',
      summary: `PD ${pd.pdNo}: ${text}`,
      sourceType: PERMISSION_OBJECT,
      sourceId: pd.id,
      sourceNo: pd.pdNo,
      actorUserId: ctx.principal.userId,
    });
  }
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'customs_pd.note_added',
    objectType: PERMISSION_OBJECT,
    objectId: pdId,
    branchCode: pd.branchCode,
    after: { note: text },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

/**
 * §24.3 — a PD the sheet could not match waits with no import (the holding
 * list) until the customs officer names it. Linking is the only change an
 * unlinked PD takes besides its status: once, to an open import, which then
 * carries it (`PD_LINKED`, and the PD's status as it stands).
 */
export async function linkToImport(tx: Tx, ctx: ActorContext, pdId: string, payableId: string) {
  const pd = await load(tx, pdId);
  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, { branchCode: pd.branchCode });
  if (pd.payableId) throw new PdValidationError(`PD ${pd.pdNo} is already linked to an import.`);
  const owner = await payables.load(tx, payableId);
  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, { branchCode: owner.branchCode });
  if (owner.payableTypeCode !== 'import') {
    throw new PdValidationError(`${owner.payableNo} is not an import; only imports are declared to customs.`);
  }
  if (owner.cancelledAt || owner.closedAt) throw new PdValidationError(`${owner.payableNo} is closed.`);

  const [status] = await tx.select().from(pdStatus).where(eq(pdStatus.code, pd.statusCode)).limit(1);
  const [linked] = await tx
    .update(customsPd)
    .set({ payableId: owner.id, branchCode: owner.branchCode, updatedAt: new Date() })
    .where(and(eq(customsPd.id, pd.id), isNull(customsPd.payableId)))
    .returning({ id: customsPd.id });
  if (!linked) throw new PdValidationError(`PD ${pd.pdNo} is already linked to an import.`);

  await events.record(tx, {
    payableId: owner.id,
    eventCode: 'PD_LINKED',
    summary:
      `PD ${pd.pdNo} (registered ${pd.registrationDate}, valid until ${pd.expiryDate}) linked from the holding list` +
      ` — ${status?.name ?? pd.statusCode} since ${pd.statusDate}`,
    sourceType: PERMISSION_OBJECT,
    sourceId: pd.id,
    sourceNo: pd.pdNo,
    actorUserId: ctx.principal.userId,
  });
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'customs_pd.linked',
    objectType: PERMISSION_OBJECT,
    objectId: pd.id,
    branchCode: owner.branchCode,
    before: { payableNo: null, branchCode: pd.branchCode },
    after: { payableNo: owner.payableNo, branchCode: owner.branchCode },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
  await payables.recomputeStage(tx, owner.id, ctx.principal.userId);
  return { id: pd.id, pdNo: pd.pdNo, payableNo: owner.payableNo };
}

/** §16.2 — a rejected or expired PD is re-registered as a new row that supersedes it. */
export async function reRegister(
  tx: Tx,
  ctx: ActorContext,
  oldPdId: string,
  input: Omit<RegisterInput, 'payableId' | 'supersedesPdId'>,
) {
  const old = await load(tx, oldPdId);
  const map = await statusMap(tx);
  const facts: PdFacts = {
    id: old.id,
    pdNo: old.pdNo,
    statusCode: old.statusCode,
    expiryDate: old.expiryDate,
    bankCode: old.bankCode,
    superseded: Boolean(
      (await tx.select({ id: customsPd.id }).from(customsPd).where(eq(customsPd.supersedesPdId, old.id)).limit(1))[0],
    ),
  };
  if (!old.payableId) throw new PdValidationError(`PD ${old.pdNo} is not linked to an import yet.`);
  if (!needsReRegistration(facts, map)) {
    throw new PdValidationError(
      facts.superseded
        ? `PD ${old.pdNo} has already been re-registered.`
        : `PD ${old.pdNo} is ${map.get(old.statusCode)?.name}; only a rejected or expired PD is re-registered.`,
    );
  }
  const created = await register(tx, ctx, {
    ...input,
    payableId: old.payableId,
    bankCode: input.bankCode ?? old.bankCode,
    supersedesPdId: old.id,
  });
  await events.record(tx, {
    payableId: old.payableId,
    eventCode: 'PD_REREGISTERED',
    summary: `PD ${old.pdNo} re-registered as ${created.pdNo}; ${old.pdNo} stays as customs left it`,
    sourceType: PERMISSION_OBJECT,
    sourceId: created.id,
    sourceNo: created.pdNo,
    actorUserId: ctx.principal.userId,
  });
  return created;
}

// ---------------------------------------------------------------------------
// §21.8 — the ASYCUDA list
// ---------------------------------------------------------------------------

export interface AsycudaDiffRow {
  readonly line: number;
  readonly pdNo: string;
  readonly pdId: string | null;
  readonly payableNo: string | null;
  readonly currentStatus: string | null;
  readonly newStatus: string;
  readonly effectiveDate: string | null;
  /** change · same · not_found · ambiguous · final */
  readonly outcome: 'change' | 'same' | 'not_found' | 'ambiguous' | 'final';
}

export async function asycudaDiff(tx: Tx, text: string) {
  const all = await statuses(tx);
  const map = new Map(all.map((row) => [row.code, row]));
  const parsed = parseAsycudaList(text, all);
  const numbers = [...new Set(parsed.rows.map((row) => row.pdNo))];
  const found = numbers.length
    ? await tx
        .select({
          id: customsPd.id,
          pdNo: customsPd.pdNo,
          statusCode: customsPd.statusCode,
          payableNo: payable.payableNo,
          superseded: sql<boolean>`exists (select 1 from customs_pd n where n.supersedes_pd_id = ${customsPd.id})`,
        })
        .from(customsPd)
        .leftJoin(payable, eq(payable.id, customsPd.payableId))
        .where(inArray(customsPd.pdNo, numbers))
    : [];

  const rows: AsycudaDiffRow[] = parsed.rows.map((row) => {
    // The standing registration of that number: not one a later row superseded.
    const candidates = found.filter((pd) => pd.pdNo === row.pdNo && !pd.superseded);
    if (candidates.length === 0) {
      return { ...row, pdId: null, payableNo: null, currentStatus: null, newStatus: row.statusCode, outcome: 'not_found' };
    }
    if (candidates.length > 1) {
      return { ...row, pdId: null, payableNo: null, currentStatus: null, newStatus: row.statusCode, outcome: 'ambiguous' };
    }
    const pd = candidates[0]!;
    const outcome =
      pd.statusCode === row.statusCode ? 'same' : map.get(pd.statusCode)?.isTerminal ? 'final' : 'change';
    return {
      ...row,
      pdId: pd.id,
      payableNo: pd.payableNo,
      currentStatus: pd.statusCode,
      newStatus: row.statusCode,
      outcome,
    };
  });
  return { rows, unreadable: parsed.unreadable, statuses: all };
}

/** Applies the changes of a diff, one history row each, source `asycuda_list`. */
export async function asycudaApply(tx: Tx, ctx: ActorContext, text: string, asOf = today()) {
  await authz.authorize(ctx.principal, 'import', PERMISSION_OBJECT, { branchCode: ctx.branchCode });
  const diff = await asycudaDiff(tx, text);
  let changed = 0;
  for (const row of diff.rows) {
    if (row.outcome !== 'change' || !row.pdId) continue;
    await changeStatus(tx, ctx, row.pdId, {
      statusCode: row.newStatus,
      effectiveDate: row.effectiveDate ?? asOf,
      source: 'asycuda_list',
    });
    changed += 1;
  }
  return {
    changed,
    same: diff.rows.filter((row) => row.outcome === 'same').length,
    notFound: diff.rows.filter((row) => row.outcome === 'not_found').map((row) => row.pdNo),
    skipped: diff.rows.filter((row) => row.outcome === 'final' || row.outcome === 'ambiguous').map((row) => row.pdNo),
    unreadable: diff.unreadable.length,
  };
}

// ---------------------------------------------------------------------------
// §15.3 check 1 — for the payment application
// ---------------------------------------------------------------------------

export async function paymentCheck(
  tx: Tx,
  payableId: string,
  input: { asOf: string; accountBankCode: string | null },
): Promise<PaymentReadiness> {
  const pds = await factsFor(tx, payableId);
  const map = await statusMap(tx);
  const banks = await tx.select({ code: bank.code, name: bank.name }).from(bank);
  return paymentReadiness(pds, map, {
    ...input,
    bankName: (code) => banks.find((b) => b.code === code)?.name ?? code,
  });
}

// ---------------------------------------------------------------------------
// §16.2 — the sweep's part
// ---------------------------------------------------------------------------

/**
 * Writes `PD_EXPIRING` once per PD inside the warning window, and moves a PD
 * whose expiry has passed to its expired status (source `sweep`). Idempotent:
 * the warning looks for its own event; an expired PD is terminal.
 */
export async function expirySweep(tx: Tx, asOf: string): Promise<{ warned: number; expired: number }> {
  const map = await statusMap(tx);
  const limits = await tx
    .select({
      scope: stageTimeLimit.scope,
      limitDays: stageTimeLimit.limitDays,
      escalateAfterDays: stageTimeLimit.escalateAfterDays,
      escalateToRole: stageTimeLimit.escalateToRole,
      active: stageTimeLimit.active,
      validFrom: sql<string>`${stageTimeLimit.validFrom}::text`,
    })
    .from(stageTimeLimit)
    .where(eq(stageTimeLimit.checkCode, 'pd_expiring'));

  const open = await tx
    .select({
      id: customsPd.id,
      pdNo: customsPd.pdNo,
      payableId: customsPd.payableId,
      statusCode: customsPd.statusCode,
      expiryDate: sql<string>`${customsPd.expiryDate}::text`,
      bankCode: customsPd.bankCode,
      typeCode: payable.payableTypeCode,
      supplierId: payable.supplierId,
    })
    .from(customsPd)
    .leftJoin(payable, eq(payable.id, customsPd.payableId))
    .where(sql`not exists (select 1 from customs_pd n where n.supersedes_pd_id = ${customsPd.id})`);

  let warned = 0;
  let expired = 0;
  for (const pd of open) {
    const status = map.get(pd.statusCode);
    if (!status || status.isTerminal) continue;
    const left = daysUntil(pd.expiryDate, asOf);

    if (left < 0) {
      const next = expiredStatusFor(pd.statusCode);
      if (next) {
        const dayAfter = new Date(Date.parse(`${pd.expiryDate}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
        await changeStatus(tx, null, pd.id, {
          statusCode: next,
          effectiveDate: dayAfter,
          source: 'sweep',
          note: `Expired on ${pd.expiryDate}`,
        });
        expired += 1;
      } else if (pd.payableId) {
        // Never validated and past its expiry: there is no expired status
        // for it, but the story says so, once.
        const [seen] = await tx.execute(sql`
          select 1 from payable_event where payable_id = ${pd.payableId}
             and event_code = 'PD_EXPIRED' and source_id = ${pd.id} limit 1`).then((r) => r.rows);
        if (!seen) {
          await events.record(tx, {
            payableId: pd.payableId,
            eventCode: 'PD_EXPIRED',
            summary: `PD ${pd.pdNo} passed its expiry (${pd.expiryDate}) while ${status.name} — re-register it`,
            sourceType: PERMISSION_OBJECT,
            sourceId: pd.id,
            sourceNo: pd.pdNo,
            actorUserId: null,
          });
        }
      }
      continue;
    }

    const limit = limitInForce(limits, { typeCode: pd.typeCode, bankCode: pd.bankCode, supplierId: pd.supplierId }, asOf);
    if (!limit || left > limit.limitDays || !pd.payableId) continue;
    const [seen] = await tx.execute(sql`
      select 1 from payable_event where payable_id = ${pd.payableId}
         and event_code = 'PD_EXPIRING' and source_id = ${pd.id} limit 1`).then((r) => r.rows);
    if (seen) continue;
    await events.record(tx, {
      payableId: pd.payableId,
      eventCode: 'PD_EXPIRING',
      summary: `PD ${pd.pdNo} expires on ${pd.expiryDate} — ${left} days left (warning at ${limit.limitDays})`,
      sourceType: PERMISSION_OBJECT,
      sourceId: pd.id,
      sourceNo: pd.pdNo,
      actorUserId: null,
    });
    warned += 1;
  }
  return { warned, expired };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface PdListFilter {
  readonly view?: 'live' | 'expiring' | 'final' | 'holding' | 'all' | null;
  readonly payableId?: string | null;
}

export async function list(tx: Tx, filter: PdListFilter = {}) {
  const asOf = today();
  const rows = await tx
    .select({
      id: customsPd.id,
      pdNo: customsPd.pdNo,
      registrationYear: customsPd.registrationYear,
      registrationDate: sql<string>`${customsPd.registrationDate}::text`,
      expiryDate: sql<string>`${customsPd.expiryDate}::text`,
      statusCode: customsPd.statusCode,
      statusName: pdStatus.name,
      isTerminal: pdStatus.isTerminal,
      allowsPayment: pdStatus.allowsPayment,
      isExpired: pdStatus.isExpired,
      lastNote: customsPd.lastNote,
      payableNo: payable.payableNo,
      reference: payable.supplierReference,
      supplierName: businessPartner.legalName,
      bankName: bank.name,
      branchCode: customsPd.branchCode,
      superseded: sql<boolean>`exists (select 1 from customs_pd n where n.supersedes_pd_id = ${customsPd.id})`,
    })
    .from(customsPd)
    .innerJoin(pdStatus, eq(pdStatus.code, customsPd.statusCode))
    .leftJoin(payable, eq(payable.id, customsPd.payableId))
    .leftJoin(businessPartner, eq(businessPartner.id, payable.supplierId))
    .leftJoin(bank, eq(bank.code, customsPd.bankCode))
    .where(filter.payableId ? eq(customsPd.payableId, filter.payableId) : undefined)
    .orderBy(asc(customsPd.expiryDate), desc(customsPd.createdAt));

  const withDays = rows.map((row) => ({ ...row, daysLeft: daysUntil(row.expiryDate, asOf) }));
  const warning = await warningDays(tx);
  switch (filter.view ?? 'live') {
    case 'live':
      return withDays.filter((row) => !row.isTerminal && !row.superseded);
    case 'expiring':
      return withDays.filter((row) => !row.isTerminal && !row.superseded && row.daysLeft <= warning);
    case 'final':
      return withDays.filter((row) => row.isTerminal || row.superseded);
    case 'holding':
      return withDays.filter((row) => row.payableNo === null);
    default:
      return withDays;
  }
}

/** The warning window in force today (seed 45 days). */
export async function warningDays(tx: Tx): Promise<number> {
  const limits = await tx
    .select({
      scope: stageTimeLimit.scope,
      limitDays: stageTimeLimit.limitDays,
      escalateAfterDays: stageTimeLimit.escalateAfterDays,
      escalateToRole: stageTimeLimit.escalateToRole,
      active: stageTimeLimit.active,
      validFrom: sql<string>`${stageTimeLimit.validFrom}::text`,
    })
    .from(stageTimeLimit)
    .where(eq(stageTimeLimit.checkCode, 'pd_expiring'));
  return limitInForce(limits, {}, today())?.limitDays ?? 45;
}

export async function viewByNo(tx: Tx, pdNo: string, year?: number | null) {
  const candidates = await tx
    .select()
    .from(customsPd)
    .where(
      and(
        eq(customsPd.pdNo, pdNo.toUpperCase()),
        year ? sql`${customsPd.registrationYear} = ${year}` : undefined,
      ),
    )
    .orderBy(desc(customsPd.registrationDate));
  const pd = candidates[0];
  if (!pd) throw new PdNotFoundError(pdNo);

  const map = await statusMap(tx);
  const history = await tx
    .select({
      id: customsPdStatusHistory.id,
      statusCode: customsPdStatusHistory.statusCode,
      effectiveDate: sql<string>`${customsPdStatusHistory.effectiveDate}::text`,
      source: customsPdStatusHistory.source,
      note: customsPdStatusHistory.note,
      recordedAt: customsPdStatusHistory.recordedAt,
      recordedBy: appUser.displayName,
    })
    .from(customsPdStatusHistory)
    .leftJoin(appUser, eq(appUser.id, customsPdStatusHistory.recordedBy))
    .where(eq(customsPdStatusHistory.pdId, pd.id))
    .orderBy(desc(customsPdStatusHistory.recordedAt));

  const [owner] = pd.payableId
    ? await tx
        .select({
          payableNo: payable.payableNo,
          reference: payable.supplierReference,
          supplierName: businessPartner.legalName,
          supplierCode: businessPartner.code,
        })
        .from(payable)
        .innerJoin(businessPartner, eq(businessPartner.id, payable.supplierId))
        .where(eq(payable.id, pd.payableId))
        .limit(1)
    : [];
  const [bankRow] = pd.bankCode ? await tx.select().from(bank).where(eq(bank.code, pd.bankCode)).limit(1) : [];
  const [supersedes] = pd.supersedesPdId
    ? await tx
        .select({ pdNo: customsPd.pdNo, year: customsPd.registrationYear })
        .from(customsPd)
        .where(eq(customsPd.id, pd.supersedesPdId))
        .limit(1)
    : [];
  const [supersededBy] = await tx
    .select({ pdNo: customsPd.pdNo, year: customsPd.registrationYear })
    .from(customsPd)
    .where(eq(customsPd.supersedesPdId, pd.id))
    .limit(1);
  const paidAgainst = await tx
    .select({
      applicationNo: paymentApplication.applicationNo,
      status: paymentApplication.status,
      currency: paymentApplication.currency,
      amountTxn: paymentApplication.amountTxn,
    })
    .from(paymentApplication)
    .where(eq(paymentApplication.pdId, pd.id));

  const status = map.get(pd.statusCode)!;
  return {
    pd,
    status,
    statusName: (code: string) => map.get(code)?.name ?? code,
    history,
    owner: owner ?? null,
    bank: bankRow ?? null,
    supersedes: supersedes ?? null,
    supersededBy: supersededBy ?? null,
    paidAgainst,
    daysLeft: daysUntil(pd.expiryDate, today()),
    mayReRegister: needsReRegistration(
      {
        id: pd.id,
        pdNo: pd.pdNo,
        statusCode: pd.statusCode,
        expiryDate: pd.expiryDate,
        bankCode: pd.bankCode,
        superseded: Boolean(supersededBy),
      },
      map,
    ),
    otherYears: candidates.slice(1).map((row) => row.registrationYear),
  };
}

/** Imports a PD may be registered against: open imports. */
export async function importChoices(tx: Tx) {
  return tx
    .select({
      id: payable.id,
      payableNo: payable.payableNo,
      reference: payable.supplierReference,
      supplierName: businessPartner.legalName,
    })
    .from(payable)
    .innerJoin(businessPartner, eq(businessPartner.id, payable.supplierId))
    .where(and(eq(payable.payableTypeCode, 'import'), isNull(payable.cancelledAt), isNull(payable.closedAt)))
    .orderBy(desc(payable.createdAt));
}
