/**
 * Customs declarations — REQ-LOG-001 item 8 (Q1, decided by default).
 *
 * The PD pre-declares an import to customs; the **declaration** is what the
 * broker then lodged for the goods — its number, the import and the PD it
 * clears against, and what was *declared*: the customs value, the duty, the
 * taxes and the fees, in the currency of the lodgement. Those figures are
 * the declaration's own words, frozen once it leaves draft (0301's trigger).
 * They are never money in the books: the money is the broker's invoice line
 * charged to the import → `landed_cost_charge` → the landed cost. The screen
 * puts the declared figures beside what was actually charged, and the two
 * disagreeing is information, not an error.
 *
 *   Draft → Submitted → Accepted → Assessed → Cleared
 *                └── Cancelled / Rejected (with a reason) on the way
 *
 * Forward only, one step at a time (`domain/import-logistics`). Customs gives
 * its own number when it accepts the lodgement, so Accepted needs it. Every
 * move is an audit row and a `payable_event` on the import, in the PD lane.
 * Nothing here posts, locks or moves stock.
 */
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { appUser, businessPartner, currency as currencyTable, customsDeclaration, customsPd, landedCostCharge, payable, pdStatus } from '../db/schema';
import { businessToday } from '../domain/business-date';
import {
  DECLARATION_FINAL,
  DUTY_TYPES,
  DeclarationRuleError,
  assertDeclarationMove,
  isDeclarationStatus,
  nextDeclarationStatuses,
  type DeclarationStatus,
} from '../domain/import-logistics';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '../domain/money';
import type { ActorContext } from './chart-of-accounts';
import * as audit from './audit';
import * as authz from './authorization';
import * as events from './payable-events';
import { allocateDocumentNumber } from './numbering';
import * as payables from './payables';
import { registerPage, searchOf, type RegisterPaging } from './register-page';

export const PERMISSION_OBJECT = 'customs_declaration';
const SERIES = 'CUSTOMS_DECLARATION';

export class DeclarationNotFoundError extends Error {
  readonly code = 'CUSTOMS_DECLARATION_NOT_FOUND';
  constructor(ref: string) {
    super(`No customs declaration '${ref}', or it is outside the branches you may see.`);
    this.name = 'DeclarationNotFoundError';
  }
}

export { DeclarationRuleError };

const money = (value: bigint) => toDecimalString(value, MONEY_SCALE);
const amountOf = (value: string | null | undefined) => parseDecimal(value ?? '0', MONEY_SCALE);

async function load(tx: Tx, id: string) {
  const [row] = await tx.select().from(customsDeclaration).where(eq(customsDeclaration.id, id)).limit(1);
  if (!row) throw new DeclarationNotFoundError(id);
  return row;
}

/** HD9 — locked for a move, so two moves serialise and the second is refused. */
async function lock(tx: Tx, id: string) {
  const [row] = await tx.select().from(customsDeclaration).where(eq(customsDeclaration.id, id)).for('update');
  if (!row) throw new DeclarationNotFoundError(id);
  return row;
}

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

export interface DeclaredFigures {
  readonly currency?: string | null;
  readonly declaredValue?: bigint | null;
  readonly declaredDuty?: bigint | null;
  readonly declaredTaxes?: bigint | null;
  readonly declaredFees?: bigint | null;
  readonly hsCode?: string | null;
}

async function figuresOf(tx: Tx, input: DeclaredFigures, current?: typeof customsDeclaration.$inferSelect) {
  const currency = (input.currency ?? current?.currency ?? 'IQD').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new DeclarationRuleError(`'${currency}' is not a currency code (three letters, like IQD or USD).`);
  // The ERP's own currencies, as every other document takes them. A currency
  // retired since the draft was written stays on it until somebody changes it.
  const [known] = await tx.select().from(currencyTable).where(eq(currencyTable.code, currency)).limit(1);
  if (!known || (!known.isActive && currency !== current?.currency)) {
    throw new DeclarationRuleError(`${currency} is not an active currency. Choose one from Currencies and Rates.`);
  }
  const pick = (given: bigint | null | undefined, stored: string | undefined, label: string) => {
    const value = given ?? (stored !== undefined ? amountOf(stored) : 0n);
    if (value < 0n) throw new DeclarationRuleError(`The declared ${label} cannot be negative.`);
    return value;
  };
  return {
    currency,
    declaredValue: money(pick(input.declaredValue, current?.declaredValue, 'value')),
    declaredDuty: money(pick(input.declaredDuty, current?.declaredDuty, 'duty')),
    declaredTaxes: money(pick(input.declaredTaxes, current?.declaredTaxes, 'taxes')),
    declaredFees: money(pick(input.declaredFees, current?.declaredFees, 'fees')),
    hsCode: (input.hsCode === undefined ? current?.hsCode : input.hsCode?.trim() || null) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Create and edit (draft only)
// ---------------------------------------------------------------------------

export interface CreateInput extends DeclaredFigures {
  readonly payableId: string;
  readonly pdId?: string | null;
  readonly declarationDate?: string | null;
  readonly customsRef?: string | null;
  readonly note?: string | null;
}

/** Raises a draft declaration against an open import, and the PD it clears if one is named. */
export async function create(tx: Tx, ctx: ActorContext, input: CreateInput) {
  const owner = await payables.load(tx, input.payableId);
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, { branchCode: owner.branchCode });
  if (owner.payableTypeCode !== 'import') {
    throw new DeclarationRuleError(`${owner.payableNo} is not an import; only an import's goods are declared to customs.`);
  }
  if (owner.cancelledAt) throw new DeclarationRuleError(`${owner.payableNo} is cancelled.`);
  if (owner.closedAt) throw new DeclarationRuleError(`${owner.payableNo} is closed; nothing more is declared on it.`);

  let pd: typeof customsPd.$inferSelect | null = null;
  if (input.pdId) {
    const [found] = await tx.select().from(customsPd).where(eq(customsPd.id, input.pdId)).limit(1);
    if (!found) throw new DeclarationRuleError('That PD does not exist, or is outside your branches.');
    if (found.payableId && found.payableId !== owner.id) {
      throw new DeclarationRuleError(`PD ${found.pdNo} belongs to another import. A declaration clears against its own import's PD.`);
    }
    pd = found;
  }

  const declarationDate = input.declarationDate || businessToday();
  const figures = await figuresOf(tx, input);
  const allocated = await allocateDocumentNumber(
    tx,
    SERIES,
    { branchCode: owner.branchCode, year: Number(declarationDate.slice(0, 4)) },
    ctx.principal.userId,
  );
  const customsRef = input.customsRef?.trim() || null;

  const [created] = await tx
    .insert(customsDeclaration)
    .values({
      declarationNo: allocated.documentNo,
      customsRef,
      payableId: owner.id,
      pdId: pd?.id ?? null,
      branchCode: owner.branchCode,
      declarationDate,
      status: 'draft',
      statusDate: declarationDate,
      ...figures,
      note: input.note?.trim() || null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: customsDeclaration.id, declarationNo: customsDeclaration.declarationNo });

  await events.record(tx, {
    payableId: owner.id,
    eventCode: 'DECLARATION_RAISED',
    summary: `Customs declaration ${allocated.documentNo} raised${pd ? ` against PD ${pd.pdNo}` : ''} — ${figures.currency} ${figures.declaredValue} declared`,
    sourceType: PERMISSION_OBJECT,
    sourceId: created!.id,
    sourceNo: allocated.documentNo,
    actorUserId: ctx.principal.userId,
  });
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'customs_declaration.created',
    objectType: PERMISSION_OBJECT,
    objectId: created!.id,
    branchCode: owner.branchCode,
    after: { declarationNo: allocated.documentNo, payableNo: owner.payableNo, pdNo: pd?.pdNo ?? null, customsRef, ...figures, declarationDate },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
    clientIp: ctx.clientIp ?? null,
  });
  return { id: created!.id, declarationNo: allocated.documentNo };
}

export interface UpdateInput extends DeclaredFigures {
  readonly pdId?: string | null;
  readonly declarationDate?: string | null;
  readonly customsRef?: string | null;
  readonly note?: string | null;
}

/** Changes a draft's figures, PD, date or reference. Anything past draft keeps its words (0301). */
export async function update(tx: Tx, ctx: ActorContext, id: string, input: UpdateInput) {
  const row = await lock(tx, id);
  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, { branchCode: row.branchCode, objectId: id });
  if (row.status !== 'draft') {
    throw new DeclarationRuleError(`${row.declarationNo} is ${row.status}; what it declared is the record. Cancel it and raise another if customs has it wrong.`);
  }
  let pdId = row.pdId;
  let pdNo: string | null = null;
  if (input.pdId !== undefined) {
    if (input.pdId) {
      const [found] = await tx.select().from(customsPd).where(eq(customsPd.id, input.pdId)).limit(1);
      if (!found) throw new DeclarationRuleError('That PD does not exist, or is outside your branches.');
      if (found.payableId && found.payableId !== row.payableId) {
        throw new DeclarationRuleError(`PD ${found.pdNo} belongs to another import.`);
      }
      pdId = found.id;
      pdNo = found.pdNo;
    } else {
      pdId = null;
    }
  }
  const figures = await figuresOf(tx, input, row);
  const before = {
    pdId: row.pdId,
    customsRef: row.customsRef,
    declarationDate: row.declarationDate,
    currency: row.currency,
    declaredValue: row.declaredValue,
    declaredDuty: row.declaredDuty,
    declaredTaxes: row.declaredTaxes,
    declaredFees: row.declaredFees,
    hsCode: row.hsCode,
    note: row.note,
  };
  const after = {
    pdId,
    customsRef: input.customsRef === undefined ? row.customsRef : input.customsRef?.trim() || null,
    declarationDate: input.declarationDate || row.declarationDate,
    ...figures,
    note: input.note === undefined ? row.note : input.note?.trim() || null,
  };
  await tx
    .update(customsDeclaration)
    .set({ ...after, statusDate: after.declarationDate, updatedAt: new Date() })
    .where(eq(customsDeclaration.id, id));
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'customs_declaration.updated',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: row.branchCode,
    before,
    after: { ...after, pdNo },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
    clientIp: ctx.clientIp ?? null,
  });
}

// ---------------------------------------------------------------------------
// The life of a declaration
// ---------------------------------------------------------------------------

export interface MoveInput {
  readonly to: string;
  readonly on?: string | null;
  /** Customs' own number — required to reach Accepted. */
  readonly customsRef?: string | null;
  /** Required to cancel or reject. */
  readonly reason?: string | null;
  readonly note?: string | null;
}

/** The verb each step asks for. Cancelling and rejecting are the manager's. */
function verbFor(to: DeclarationStatus): 'submit' | 'reverse_cancel' {
  return to === 'cancelled' || to === 'rejected' ? 'reverse_cancel' : 'submit';
}

/** One step forward, or out: Submitted, Accepted, Assessed, Cleared, Cancelled, Rejected. */
export async function move(tx: Tx, ctx: ActorContext, id: string, input: MoveInput) {
  if (!isDeclarationStatus(input.to)) throw new DeclarationRuleError(`'${input.to}' is not a declaration status.`);
  const to = input.to;
  const row = await lock(tx, id);
  await authz.authorize(ctx.principal, verbFor(to), PERMISSION_OBJECT, { branchCode: row.branchCode, objectId: id });
  const from = row.status as DeclarationStatus;
  assertDeclarationMove(row.declarationNo, from, to);

  const on = input.on || businessToday();
  if (on < row.declarationDate) {
    throw new DeclarationRuleError(`${to} on ${on} is before ${row.declarationNo} was lodged (${row.declarationDate}).`);
  }
  const reason = input.reason?.trim() || null;
  if ((to === 'cancelled' || to === 'rejected') && !reason) {
    throw new DeclarationRuleError(`Say why ${row.declarationNo} is ${to}: the reason is the record.`);
  }
  const customsRef = input.customsRef?.trim() || row.customsRef;
  if (to === 'accepted' && !customsRef) {
    throw new DeclarationRuleError(`Customs gives its own number when it accepts ${row.declarationNo}. Enter it to mark the declaration accepted.`);
  }
  if (to === 'submitted') {
    const declared = amountOf(row.declaredValue);
    if (declared <= 0n) throw new DeclarationRuleError(`${row.declarationNo} declares no value. Enter what was declared before submitting it.`);
  }

  await tx
    .update(customsDeclaration)
    .set({
      status: to,
      statusDate: on,
      customsRef,
      ...(reason ? { reason } : {}),
      updatedAt: new Date(),
    })
    .where(eq(customsDeclaration.id, id));

  const note = input.note?.trim() || null;
  const sourceBase = {
    payableId: row.payableId,
    sourceType: PERMISSION_OBJECT,
    sourceId: row.id,
    sourceNo: row.declarationNo,
    actorUserId: ctx.principal.userId,
  };
  await events.record(tx, {
    ...sourceBase,
    eventCode: to === 'cleared' ? 'DECLARATION_CLEARED' : 'DECLARATION_MOVED',
    summary:
      to === 'cleared'
        ? `Customs declaration ${row.declarationNo} cleared on ${on}${customsRef ? ` (customs ref ${customsRef})` : ''}`
        : `Customs declaration ${row.declarationNo}: ${from} → ${to} on ${on}${reason ? ` — ${reason}` : ''}${note ? ` — ${note}` : ''}`,
    before: { status: from },
    after: { status: to },
  });
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: `customs_declaration.${to}`,
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: row.branchCode,
    before: { status: from, customsRef: row.customsRef },
    after: { status: to, statusDate: on, customsRef, note },
    reason,
    outcome: 'success',
    requestId: ctx.requestId ?? null,
    clientIp: ctx.clientIp ?? null,
  });
  return { id, declarationNo: row.declarationNo, from, to };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface DeclarationFilter extends RegisterPaging {
  readonly search?: string | null;
  readonly view?: 'open' | 'cleared' | 'ended' | 'all' | null;
  readonly payableId?: string | null;
}

const columns = {
  id: customsDeclaration.id,
  declarationNo: customsDeclaration.declarationNo,
  customsRef: customsDeclaration.customsRef,
  status: customsDeclaration.status,
  statusDate: sql<string>`${customsDeclaration.statusDate}::text`,
  declarationDate: sql<string>`${customsDeclaration.declarationDate}::text`,
  currency: customsDeclaration.currency,
  declaredValue: customsDeclaration.declaredValue,
  declaredDuty: customsDeclaration.declaredDuty,
  declaredTaxes: customsDeclaration.declaredTaxes,
  declaredFees: customsDeclaration.declaredFees,
  hsCode: customsDeclaration.hsCode,
  branchCode: customsDeclaration.branchCode,
  payableNo: payable.payableNo,
  reference: payable.supplierReference,
  supplierCode: businessPartner.code,
  supplierName: businessPartner.legalName,
  pdNo: customsPd.pdNo,
  pdYear: customsPd.registrationYear,
  pdStatusCode: customsPd.statusCode,
};

function whereOf(filter: DeclarationFilter) {
  const view = filter.view ?? 'all';
  const viewSql =
    view === 'open'
      ? sql`${customsDeclaration.status} in ('draft', 'submitted', 'accepted', 'assessed')`
      : view === 'cleared'
        ? sql`${customsDeclaration.status} = 'cleared'`
        : view === 'ended'
          ? sql`${customsDeclaration.status} in ('cancelled', 'rejected')`
          : undefined;
  return and(
    filter.payableId ? eq(customsDeclaration.payableId, filter.payableId) : undefined,
    viewSql,
    searchOf(
      [
        customsDeclaration.declarationNo,
        customsDeclaration.customsRef,
        customsDeclaration.status,
        customsDeclaration.hsCode,
        customsDeclaration.currency,
        payable.payableNo,
        payable.supplierReference,
        businessPartner.legalName,
        businessPartner.code,
        customsPd.pdNo,
        customsDeclaration.declarationDate,
      ],
      filter.search,
    ) ?? undefined,
  );
}

function query(tx: Tx, where: ReturnType<typeof and>) {
  return tx
    .select(columns)
    .from(customsDeclaration)
    .innerJoin(payable, eq(payable.id, customsDeclaration.payableId))
    .innerJoin(businessPartner, eq(businessPartner.id, payable.supplierId))
    .leftJoin(customsPd, eq(customsPd.id, customsDeclaration.pdId))
    .where(where)
    .orderBy(desc(customsDeclaration.declarationDate), desc(customsDeclaration.createdAt), asc(customsDeclaration.id))
    .$dynamic();
}

/** The register: one page of fifty with the true count (HD15). */
export async function listForScreen(tx: Tx, filter: DeclarationFilter = {}) {
  const where = whereOf(filter);
  return registerPage({
    paging: filter,
    count: async () => {
      const [row] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(customsDeclaration)
        .innerJoin(payable, eq(payable.id, customsDeclaration.payableId))
        .innerJoin(businessPartner, eq(businessPartner.id, payable.supplierId))
        .leftJoin(customsPd, eq(customsPd.id, customsDeclaration.pdId))
        .where(where);
      return row?.n ?? 0;
    },
    rows: ({ limit, offset }) => query(tx, where).limit(limit).offset(offset),
  });
}

/** An import's declarations, newest first — for the import's and the PD's own sections. */
export async function listFor(tx: Tx, filter: { payableId?: string | null; pdId?: string | null }) {
  return query(
    tx,
    and(
      filter.payableId ? eq(customsDeclaration.payableId, filter.payableId) : undefined,
      filter.pdId ? eq(customsDeclaration.pdId, filter.pdId) : undefined,
    ),
  );
}

/**
 * Declared beside charged — the one comparison the record makes. Charged is
 * the import's live `customs_asycuda` charges in IQD (the broker's invoice
 * lines and the clearing journals, never typed here), with how many of them
 * a landed-cost lock has already allocated.
 */
export async function chargedFor(tx: Tx, payableId: string) {
  const rows = await tx
    .select({
      id: landedCostCharge.id,
      amountIqd: landedCostCharge.amountIqd,
      amountTxn: landedCostCharge.amountTxn,
      currency: landedCostCharge.currency,
      sourceType: landedCostCharge.sourceType,
      sourceNo: landedCostCharge.sourceNo,
      lockId: landedCostCharge.lockId,
      note: landedCostCharge.note,
      createdAt: landedCostCharge.createdAt,
    })
    .from(landedCostCharge)
    .where(
      and(
        eq(landedCostCharge.payableId, payableId),
        isNull(landedCostCharge.cancelledAt),
        sql`${landedCostCharge.chargeTypeCode} in (${sql.join(DUTY_TYPES.map((type) => sql`${type}`), sql`, `)})`,
      ),
    )
    .orderBy(asc(landedCostCharge.createdAt));
  const total = rows.reduce((sum, row) => sum + amountOf(row.amountIqd), 0n);
  const locked = rows.filter((row) => row.lockId).reduce((sum, row) => sum + amountOf(row.amountIqd), 0n);
  return { rows, totalIqd: money(total), lockedIqd: money(locked), unlockedIqd: money(total - locked) };
}

export async function viewByNo(tx: Tx, declarationNo: string) {
  const [row] = await tx.select().from(customsDeclaration).where(eq(customsDeclaration.declarationNo, declarationNo.toUpperCase())).limit(1);
  if (!row) throw new DeclarationNotFoundError(declarationNo);
  return view(tx, row);
}

export async function viewById(tx: Tx, id: string) {
  return view(tx, await load(tx, id));
}

async function view(tx: Tx, row: typeof customsDeclaration.$inferSelect) {
  const [owner] = await tx
    .select({
      id: payable.id,
      payableNo: payable.payableNo,
      reference: payable.supplierReference,
      supplierCode: businessPartner.code,
      supplierName: businessPartner.legalName,
      currency: payable.currency,
      cancelledAt: payable.cancelledAt,
      closedAt: payable.closedAt,
    })
    .from(payable)
    .innerJoin(businessPartner, eq(businessPartner.id, payable.supplierId))
    .where(eq(payable.id, row.payableId))
    .limit(1);
  const [pd] = row.pdId
    ? await tx
        .select({
          id: customsPd.id,
          pdNo: customsPd.pdNo,
          year: customsPd.registrationYear,
          statusCode: customsPd.statusCode,
          statusName: pdStatus.name,
          statusDate: sql<string>`${customsPd.statusDate}::text`,
          expiryDate: sql<string>`${customsPd.expiryDate}::text`,
        })
        .from(customsPd)
        .innerJoin(pdStatus, eq(pdStatus.code, customsPd.statusCode))
        .where(eq(customsPd.id, row.pdId))
        .limit(1)
    : [];
  const [author] = await tx.select({ name: appUser.displayName }).from(appUser).where(eq(appUser.id, row.createdBy)).limit(1);
  // The PDs the declaration could clear against: the import's own, standing.
  const pdChoices = await tx
    .select({ id: customsPd.id, pdNo: customsPd.pdNo, year: customsPd.registrationYear, statusCode: customsPd.statusCode })
    .from(customsPd)
    .where(eq(customsPd.payableId, row.payableId))
    .orderBy(desc(customsPd.registrationDate));
  const charged = await chargedFor(tx, row.payableId);
  const declaredTotal = amountOf(row.declaredDuty) + amountOf(row.declaredTaxes) + amountOf(row.declaredFees);
  const status = row.status as DeclarationStatus;
  return {
    declaration: row,
    owner: owner!,
    pd: pd ?? null,
    pdChoices,
    createdByName: author?.name ?? null,
    charged,
    /** Duty + taxes + fees as declared — the figure to read against `charged.totalIqd` when the currency is IQD. */
    declaredChargesTotal: money(declaredTotal),
    comparable: row.currency === 'IQD',
    isFinal: DECLARATION_FINAL.includes(status),
    next: nextDeclarationStatuses(status),
  };
}

/** Open imports a declaration may be raised on, newest first. */
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

/** The standing PDs of one import, for the raise form once an import is chosen. */
export async function pdChoicesFor(tx: Tx, payableId: string) {
  return tx
    .select({ id: customsPd.id, pdNo: customsPd.pdNo, year: customsPd.registrationYear, statusCode: customsPd.statusCode })
    .from(customsPd)
    .where(eq(customsPd.payableId, payableId))
    .orderBy(desc(customsPd.registrationDate));
}
