/**
 * What a person holds — REQ-HR-001 Stage HR-4 (§10 "Asset assignment").
 *
 * A row per hand-over: a fixed asset from the register (by its code) or
 * another item described with its serial, the day and the condition it went
 * out in; returned with the day and the condition it came back in. A fixed
 * asset is held by one person at a time (a unique index). A leaver's
 * clearance is what is still out, beside what their advances still owe.
 */
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { employee, employeeAdvance, employeeAsset, fixedAsset } from '../db/schema';
import { businessToday } from '../domain/business-date';
import { HrValidationError, assertDay } from '../domain/hr';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '../domain/money';
import { AdminNotFoundError, optionalText, recordChange, requireText } from './administration';
import * as authz from './authorization';
import type { ActorContext } from './chart-of-accounts';

export const PERMISSION_OBJECT = 'employee_asset';

export class AssetHoldError extends Error {
  readonly code = 'EMPLOYEE_ASSET';
  constructor(message: string) {
    super(message);
    this.name = 'AssetHoldError';
  }
}

export interface HandOutInput {
  readonly kind: string;
  /** A fixed asset's code, for kind `fixed_asset`. */
  readonly fixedAssetCode?: string | null;
  /** What it is, for an item; a fixed asset is described by the register. */
  readonly description?: string | null;
  readonly serialNo?: string | null;
  readonly handedOutOn: string;
  readonly condition?: string | null;
}

async function personOf(tx: Tx, employeeId: string) {
  const [row] = await tx
    .select({ id: employee.id, employeeNo: employee.employeeNo, branchCode: employee.branchCode, status: employee.status })
    .from(employee)
    .where(eq(employee.id, employeeId))
    .limit(1);
  if (!row) throw new HrValidationError('employee', 'names nobody you may see');
  return row;
}

/** Handed out: a fixed asset nobody holds, or an item with what it is. */
export async function handOut(tx: Tx, ctx: ActorContext, employeeId: string, input: HandOutInput): Promise<{ id: string }> {
  const person = await personOf(tx, employeeId);
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, { branchCode: person.branchCode, objectId: person.employeeNo });
  if (person.status === 'ended') throw new AssetHoldError(`${person.employeeNo} has left; nothing more is handed out to them.`);
  const on = assertDay((input.handedOutOn ?? '').trim(), 'handed_out_on');
  if (on > businessToday()) throw new HrValidationError('handed_out_on', `${on} has not come yet`);
  let fixedAssetId: string | null = null;
  let description: string;
  if (input.kind === 'fixed_asset') {
    const code = requireText(input.fixedAssetCode, 'fixed_asset', 64);
    const [asset] = await tx.select({ id: fixedAsset.id, description: fixedAsset.description }).from(fixedAsset).where(eq(fixedAsset.assetCode, code)).limit(1);
    if (!asset) throw new HrValidationError('fixed_asset', `names no fixed asset '${code}'`);
    const [held] = await tx
      .select({ employeeNo: employee.employeeNo })
      .from(employeeAsset)
      .innerJoin(employee, eq(employee.id, employeeAsset.employeeId))
      .where(and(eq(employeeAsset.fixedAssetId, asset.id), isNull(employeeAsset.returnedOn)))
      .limit(1);
    if (held) throw new AssetHoldError(`${code} is held by ${held.employeeNo}; it is returned before it is handed out again.`);
    fixedAssetId = asset.id;
    description = optionalText(input.description) ?? `${code} · ${asset.description}`;
  } else if (input.kind === 'item') {
    description = requireText(input.description, 'description', 300);
  } else throw new HrValidationError('kind', 'must be a fixed asset or an item');
  const [row] = await tx
    .insert(employeeAsset)
    .values({
      employeeId: person.id,
      branchCode: person.branchCode,
      assetKind: input.kind,
      fixedAssetId,
      description,
      serialNo: optionalText(input.serialNo, 120),
      handedOutOn: on,
      outCondition: optionalText(input.condition),
      handedOutBy: ctx.principal.userId,
    })
    .returning({ id: employeeAsset.id });
  await recordChange(tx, ctx, {
    action: 'employee_asset.handed_out',
    objectType: 'employee',
    objectId: person.employeeNo,
    branchCode: person.branchCode,
    after: { kind: input.kind, description, serialNo: optionalText(input.serialNo, 120), on },
  });
  return { id: row!.id };
}

/** Returned, with the day and the condition it came back in. */
export async function returnAsset(tx: Tx, ctx: ActorContext, id: string, input: { returnedOn: string; condition?: string | null }): Promise<void> {
  const [row] = await tx.select().from(employeeAsset).where(eq(employeeAsset.id, id)).for('update').limit(1);
  if (!row) throw new AdminNotFoundError('asset hand-over', id);
  const person = await personOf(tx, row.employeeId);
  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, { branchCode: row.branchCode, objectId: person.employeeNo });
  if (row.returnedOn) throw new AssetHoldError(`${row.description} came back on ${row.returnedOn}.`);
  const on = assertDay((input.returnedOn ?? '').trim(), 'returned_on');
  if (on < row.handedOutOn) throw new HrValidationError('returned_on', `cannot be before it was handed out (${row.handedOutOn})`);
  if (on > businessToday()) throw new HrValidationError('returned_on', `${on} has not come yet`);
  await tx
    .update(employeeAsset)
    .set({ returnedOn: on, returnCondition: optionalText(input.condition), returnedBy: ctx.principal.userId })
    .where(eq(employeeAsset.id, id));
  await recordChange(tx, ctx, {
    action: 'employee_asset.returned',
    objectType: 'employee',
    objectId: person.employeeNo,
    branchCode: row.branchCode,
    before: { outCondition: row.outCondition },
    after: { description: row.description, on, condition: optionalText(input.condition) },
  });
}

/** What a person holds and has held, what is out first. */
export async function ofEmployee(tx: Tx, employeeId: string) {
  return tx
    .select({
      id: employeeAsset.id,
      assetKind: employeeAsset.assetKind,
      description: employeeAsset.description,
      serialNo: employeeAsset.serialNo,
      handedOutOn: employeeAsset.handedOutOn,
      outCondition: employeeAsset.outCondition,
      returnedOn: employeeAsset.returnedOn,
      returnCondition: employeeAsset.returnCondition,
      assetCode: fixedAsset.assetCode,
    })
    .from(employeeAsset)
    .leftJoin(fixedAsset, eq(fixedAsset.id, employeeAsset.fixedAssetId))
    .where(eq(employeeAsset.employeeId, employeeId))
    .orderBy(sql`${employeeAsset.returnedOn} is not null`, desc(employeeAsset.handedOutOn));
}

/** The fixed assets nobody holds, for the hand-out form. */
export async function available(tx: Tx) {
  return (
    tx
      .select({ code: fixedAsset.assetCode, description: fixedAsset.description })
      .from(fixedAsset)
      // Qualified by hand: in a one-table select Drizzle prints a column bare, which the subquery would read as its own.
      .where(
        sql`not exists (select 1 from employee_asset h where h.fixed_asset_id = "fixed_asset"."id" and h.returned_on is null) and "fixed_asset"."status"::text in ('approved', 'available_for_use', 'active')`,
      )
      .orderBy(asc(fixedAsset.assetCode))
  );
}

export interface Clearance {
  readonly assetsOut: number;
  readonly advancesOwedIqd: string;
  readonly clear: boolean;
}

/** A leaver's clearance (§10): what is still out, what is still owed. */
export async function clearanceOf(tx: Tx, employeeId: string): Promise<Clearance> {
  const [out] = (await tx.execute(sql`select count(*)::int as n from employee_asset where employee_id = ${employeeId}::uuid and returned_on is null`)).rows as { n: number }[];
  const owed = await tx
    .select({ amount: employeeAdvance.amountIqd, recovered: employeeAdvance.recoveredIqd })
    .from(employeeAdvance)
    .where(and(eq(employeeAdvance.employeeId, employeeId), eq(employeeAdvance.status, 'paid')));
  const total = owed.reduce((sum, a) => sum + parseDecimal(a.amount, MONEY_SCALE) - parseDecimal(a.recovered, MONEY_SCALE), 0n);
  return { assetsOut: out?.n ?? 0, advancesOwedIqd: toDecimalString(total, MONEY_SCALE), clear: (out?.n ?? 0) === 0 && total === 0n };
}
