/**
 * Ports — REQ-LOG-001 item 15. The `port` table (0234) had two seeded rows,
 * no writer and no screen; a B/L names its port of discharge from it and
 * types its port of loading. This is the one writer:
 *
 *   * **add** — a code minted from the series `PORT_CODE` (PRT-0003 …), the
 *     name, the UN/LOCODE (five letters, the country's two first) and the
 *     country. `create` on `port`.
 *   * **rename** — the name, LOCODE and country, in place: a port is a place,
 *     not a document. `configure`.
 *   * **deactivate / reactivate** — with a reason, never deleted: the B/Ls
 *     that name it keep naming it. `configure`.
 *
 * Every change is an audit row on `port` by its code (the record's history
 * and its notes are kept under the code).
 */
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { billOfLading, businessPartner, payable, port, shipmentContainer } from '../db/schema';
import type { ActorContext } from './chart-of-accounts';
import * as audit from './audit';
import * as authz from './authorization';
import { allocateDocumentNumber } from './numbering';

export const PERMISSION_OBJECT = 'port';
const SERIES = 'PORT_CODE';

export class PortError extends Error {
  readonly code = 'PORT';
  constructor(detail: string) {
    super(detail);
    this.name = 'PortError';
  }
}

export class PortNotFoundError extends Error {
  readonly code = 'PORT_NOT_FOUND';
  constructor(ref: string) {
    super(`No port '${ref}'.`);
    this.name = 'PortNotFoundError';
  }
}

export interface PortInput {
  readonly name: string;
  readonly locode?: string | null;
  readonly country?: string | null;
}

function cleaned(input: PortInput) {
  const name = input.name?.trim() ?? '';
  if (!name) throw new PortError('Give the port its name, as the shipping line writes it.');
  const locode = input.locode?.trim().toUpperCase() || null;
  if (locode && !/^[A-Z]{5}$/.test(locode)) {
    throw new PortError(`'${locode}' is not a UN/LOCODE: five letters, the country's two first (IQUQR).`);
  }
  const country = input.country?.trim().toUpperCase() || (locode ? locode.slice(0, 2) : null);
  if (country && !/^[A-Z]{2}$/.test(country)) throw new PortError(`'${country}' is not a two-letter country code.`);
  if (locode && country && locode.slice(0, 2) !== country) {
    throw new PortError(`LOCODE ${locode} is in ${locode.slice(0, 2)}, not ${country}.`);
  }
  return { name, locode, country };
}

async function load(tx: Tx, code: string) {
  const [row] = await tx.select().from(port).where(eq(port.code, code.toUpperCase())).limit(1);
  if (!row) throw new PortNotFoundError(code);
  return row;
}

async function assertUnique(tx: Tx, fields: { name: string; locode: string | null }, except: string | null) {
  const [clash] = await tx
    .select({ code: port.code, name: port.name })
    .from(port)
    .where(
      and(
        except ? sql`${port.code} <> ${except}` : undefined,
        fields.locode ? sql`(lower(${port.name}) = lower(${fields.name}) or ${port.locode} = ${fields.locode})` : sql`lower(${port.name}) = lower(${fields.name})`,
      ),
    )
    .limit(1);
  if (clash) throw new PortError(`${clash.code} is already ${clash.name}. One port, one row — reactivate it if it was retired.`);
}

/** Adds a port: the code is minted, the name and LOCODE must be new. */
export async function add(tx: Tx, ctx: ActorContext, input: PortInput) {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, { branchCode: ctx.branchCode });
  const fields = cleaned(input);
  await assertUnique(tx, fields, null);
  // The series started after the two seeded ports; a counter wound back (a
  // test reset, a restored database) must not mint a code a row already holds.
  let code = '';
  for (let attempt = 0; attempt < 50 && !code; attempt += 1) {
    const allocated = await allocateDocumentNumber(tx, SERIES, {}, ctx.principal.userId);
    const [taken] = await tx.select({ code: port.code }).from(port).where(eq(port.code, allocated.documentNo)).limit(1);
    if (!taken) code = allocated.documentNo;
  }
  if (!code) throw new PortError('No free port code could be minted; check the PORT_CODE series.');
  await tx.insert(port).values({ code, ...fields, active: true, createdBy: ctx.principal.userId });
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'port.created',
    objectType: PERMISSION_OBJECT,
    objectId: code,
    branchCode: ctx.branchCode,
    after: { code, ...fields },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
    clientIp: ctx.clientIp ?? null,
  });
  return { code };
}

/** Corrects a port's name, LOCODE or country in place. */
export async function rename(tx: Tx, ctx: ActorContext, code: string, input: PortInput) {
  const row = await load(tx, code);
  await authz.authorize(ctx.principal, 'configure', PERMISSION_OBJECT, { branchCode: ctx.branchCode, objectId: row.code });
  const fields = cleaned(input);
  await assertUnique(tx, fields, row.code);
  await tx.update(port).set(fields).where(eq(port.code, row.code));
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'port.updated',
    objectType: PERMISSION_OBJECT,
    objectId: row.code,
    branchCode: ctx.branchCode,
    before: { name: row.name, locode: row.locode, country: row.country },
    after: fields,
    outcome: 'success',
    requestId: ctx.requestId ?? null,
    clientIp: ctx.clientIp ?? null,
  });
}

/** Retires a port with a reason. The B/Ls that name it keep it; new B/Ls cannot choose it. */
export async function deactivate(tx: Tx, ctx: ActorContext, code: string, reason: string) {
  const row = await load(tx, code);
  await authz.authorize(ctx.principal, 'configure', PERMISSION_OBJECT, { branchCode: ctx.branchCode, objectId: row.code });
  const why = reason?.trim();
  if (!why) throw new PortError(`Say why ${row.name} is retired: the reason is the record.`);
  if (!row.active) throw new PortError(`${row.name} is already retired.`);
  await tx.update(port).set({ active: false }).where(eq(port.code, row.code));
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'port.deactivated',
    objectType: PERMISSION_OBJECT,
    objectId: row.code,
    branchCode: ctx.branchCode,
    before: { active: true },
    after: { active: false },
    reason: why,
    outcome: 'success',
    requestId: ctx.requestId ?? null,
    clientIp: ctx.clientIp ?? null,
  });
}

/** Brings a retired port back, with a reason. */
export async function reactivate(tx: Tx, ctx: ActorContext, code: string, reason: string) {
  const row = await load(tx, code);
  await authz.authorize(ctx.principal, 'configure', PERMISSION_OBJECT, { branchCode: ctx.branchCode, objectId: row.code });
  const why = reason?.trim();
  if (!why) throw new PortError(`Say why ${row.name} is back in use.`);
  if (row.active) throw new PortError(`${row.name} is in use already.`);
  await tx.update(port).set({ active: true }).where(eq(port.code, row.code));
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'port.reactivated',
    objectType: PERMISSION_OBJECT,
    objectId: row.code,
    branchCode: ctx.branchCode,
    before: { active: false },
    after: { active: true },
    reason: why,
    outcome: 'success',
    requestId: ctx.requestId ?? null,
    clientIp: ctx.clientIp ?? null,
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const usage = {
  blCount: sql<number>`(select count(*)::int from bill_of_lading b where b.port_of_discharge_code = ${port.code} and b.cancelled_at is null)`,
  openContainers: sql<number>`(select count(*)::int from shipment_container c join bill_of_lading b on b.id = c.bl_id
                                where b.port_of_discharge_code = ${port.code} and c.cancelled_at is null and c.received_on is null)`,
  lastBlDate: sql<string | null>`(select max(b.bl_date)::text from bill_of_lading b where b.port_of_discharge_code = ${port.code} and b.cancelled_at is null)`,
};

/** Every port, in use first, with how many live B/Ls discharge there. */
export async function list(tx: Tx, filter: { view?: 'active' | 'retired' | 'all' | null } = {}) {
  const view = filter.view ?? 'all';
  return tx
    .select({ code: port.code, name: port.name, locode: port.locode, country: port.country, active: port.active, ...usage })
    .from(port)
    .where(view === 'active' ? eq(port.active, true) : view === 'retired' ? eq(port.active, false) : undefined)
    .orderBy(desc(port.active), asc(port.name));
}

/** One port and the B/Ls that discharge there — its profile. */
export async function viewByCode(tx: Tx, code: string) {
  const [row] = await tx
    .select({ code: port.code, name: port.name, locode: port.locode, country: port.country, active: port.active, createdBy: port.createdBy, ...usage })
    .from(port)
    .where(eq(port.code, code.toUpperCase()))
    .limit(1);
  if (!row) throw new PortNotFoundError(code);
  const bls = await tx
    .select({
      id: billOfLading.id,
      blNo: billOfLading.blNo,
      blDate: sql<string>`${billOfLading.blDate}::text`,
      eta: sql<string | null>`${billOfLading.eta}::text`,
      vessel: billOfLading.vessel,
      shippingLine: billOfLading.shippingLine,
      portOfLoading: billOfLading.portOfLoading,
      payableNo: payable.payableNo,
      supplierName: businessPartner.legalName,
      supplierCode: businessPartner.code,
      cancelledAt: billOfLading.cancelledAt,
      containers: sql<number>`(select count(*)::int from shipment_container c where c.bl_id = ${billOfLading.id} and c.cancelled_at is null)`,
      open: sql<number>`(select count(*)::int from shipment_container c where c.bl_id = ${billOfLading.id} and c.cancelled_at is null and c.received_on is null)`,
    })
    .from(billOfLading)
    .innerJoin(payable, eq(payable.id, billOfLading.payableId))
    .innerJoin(businessPartner, eq(businessPartner.id, payable.supplierId))
    .where(eq(billOfLading.portOfDischargeCode, row.code))
    .orderBy(desc(billOfLading.blDate), desc(billOfLading.createdAt));
  return { port: row, bls };
}

/**
 * Routes in use — what the B/Ls say: each port of loading (typed) to each
 * port of discharge (from the list), how many live B/Ls took it, how many
 * containers are still on the way, and when it was last used. Read, not kept:
 * a route is a fact about the B/Ls, never a record of its own.
 */
export async function routesInUse(tx: Tx) {
  const rows = await tx
    .select({
      portOfLoading: sql<string>`coalesce(nullif(btrim(${billOfLading.portOfLoading}), ''), '—')`,
      dischargeCode: port.code,
      dischargeName: port.name,
      bls: sql<number>`count(*)::int`,
      lastBlDate: sql<string>`max(${billOfLading.blDate})::text`,
      shippingLines: sql<string | null>`string_agg(distinct nullif(btrim(${billOfLading.shippingLine}), ''), ', ')`,
      openContainers: sql<number>`coalesce(sum((select count(*) from shipment_container c where c.bl_id = ${billOfLading.id} and c.cancelled_at is null and c.received_on is null)), 0)::int`,
    })
    .from(billOfLading)
    .leftJoin(port, eq(port.code, billOfLading.portOfDischargeCode))
    .where(isNull(billOfLading.cancelledAt))
    .groupBy(sql`1`, port.code, port.name)
    .orderBy(sql`count(*) desc`, sql`1`);
  return rows;
}

/** Live containers bound for a port, for the profile's "on the way" count. */
export async function inboundContainers(tx: Tx, code: string) {
  return tx
    .select({
      id: shipmentContainer.id,
      containerNo: shipmentContainer.containerNo,
      statusCode: shipmentContainer.statusCode,
      eta: sql<string | null>`${shipmentContainer.eta}::text`,
      blNo: billOfLading.blNo,
    })
    .from(shipmentContainer)
    .innerJoin(billOfLading, eq(billOfLading.id, shipmentContainer.blId))
    .where(and(eq(billOfLading.portOfDischargeCode, code.toUpperCase()), isNull(shipmentContainer.cancelledAt), isNull(shipmentContainer.receivedOn)))
    .orderBy(sql`${shipmentContainer.eta} asc nulls last`);
}
