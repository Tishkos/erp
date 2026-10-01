/**
 * The payables sweep — REQ-AP-001 §19.3, §19.4.
 *
 * "Over its time limit" is not an event anybody fires; it becomes true while
 * nobody is looking. So the state is read once a day: for every active check
 * whose named query this build implements, every payable over the limit in
 * force gets one `OVER_LIMIT_DETECTED` event and one automatic
 * `PENDING_REASON` hold — and never a second while the first stands, which
 * the partial unique index on (payable, check, open) guarantees even against
 * a sweep run twice.
 *
 * A check is a row of `sweep_check` plus a named query here. The rows for
 * SWIFT, PD and container clocks are seeded already and sit inert until
 * their build stages implement the queries — a new check is a new row and a
 * new query, never a schema change (§23).
 *
 * The sweep also keeps the event log's partitions a year ahead (§22.2) and
 * escalates holds that have waited past their escalation days with no owner
 * (§19.4).
 */
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { payable, payableHold, stageTimeLimit, sweepCheck } from '../db/schema';
import { limitInForce, type LimitScope, type TimeLimitRow } from '../domain/payables';
import * as events from './payable-events';
import * as holds from './payable-holds';
import * as contracts from './recurring-contracts';
import * as paymentApplications from './payment-applications';
import * as customs from './customs-pd';
import * as shipments from './shipments';
import * as loans from './loans';
import * as notifications from './notifications';

export interface SweepResult {
  readonly asOf: string;
  readonly checked: number;
  readonly opened: number;
  readonly escalated: number;
  /** §10.4 — contract periods the generator raised in this run. */
  readonly periodsGenerated: number;
  /** §15.4 — confirmed payments the bank reconciliation has shown debited. */
  readonly debitsMatched: number;
  /** §16.2 — PDs warned of their expiry, and PDs moved to expired, in this run. */
  readonly pdsWarned: number;
  readonly pdsExpired: number;
  /** §17.3 — containers marked Late in this run. */
  readonly containersLate: number;
  /** §15.7 — loan instalments that came due, and fell overdue, in this run. */
  readonly loanInstalmentsDue: number;
  readonly loanInstalmentsOverdue: number;
  /** Checks whose query this build does not implement yet — seeded, inert. */
  readonly skipped: string[];
}

/** One offender: a payable over a check's clock. */
interface Offender {
  readonly payableId: string;
  readonly laneCode: string;
  /** When the clock started — the limit counts from here. */
  readonly since: string;
  readonly scope: LimitScope;
  readonly summary: (limitDays: number, days: number) => string;
}

type CheckQuery = (tx: Tx, asOf: string) => Promise<Offender[]>;

const daysBetween = (from: string, to: string): number =>
  Math.floor((Date.parse(to) - Date.parse(from)) / 86_400_000);

/**
 * The named queries this build implements. Stage 1 can only read the payable
 * row itself; the later lanes' clocks arrive with their documents.
 */
const CHECK_QUERIES: Readonly<Record<string, CheckQuery>> = {
  /** D4 — a service payable nobody has confirmed (still at its first stage). */
  service_unconfirmed: async (tx) => {
    const rows = await tx
      .select({
        id: payable.id,
        since: sql<string>`${payable.stageSince}::date::text`,
        typeCode: payable.payableTypeCode,
        supplierId: payable.supplierId,
      })
      .from(payable)
      .where(
        and(
          eq(payable.payableTypeCode, 'service'),
          eq(payable.stageCode, 'requested'),
          isNull(payable.cancelledAt),
          isNull(payable.closedAt),
        ),
      );
    return rows.map((row) => ({
      payableId: row.id,
      laneCode: 'service',
      since: row.since,
      scope: { typeCode: row.typeCode, supplierId: row.supplierId },
      summary: (limit, days) =>
        `Over time limit: unconfirmed for ${days} days (limit ${limit}) — the benefiting department has not confirmed it`,
    }));
  },

  /** D4 — a recurring payable past its due date and not yet paid. */
  recurring_overdue: async (tx, asOf) => {
    const rows = await tx
      .select({
        id: payable.id,
        due: sql<string>`${payable.dueDate}::text`,
        typeCode: payable.payableTypeCode,
        supplierId: payable.supplierId,
        stageCode: payable.stageCode,
      })
      .from(payable)
      .where(
        and(
          eq(payable.payableTypeCode, 'recurring'),
          lt(payable.dueDate, asOf),
          isNull(payable.cancelledAt),
          isNull(payable.closedAt),
          sql`${payable.stageCode} not in ('paid','closed')`,
        ),
      );
    return rows.map((row) => ({
      payableId: row.id,
      laneCode: 'payment',
      since: row.due!,
      scope: { typeCode: row.typeCode, supplierId: row.supplierId },
      summary: (limit, days) =>
        `Over time limit: due ${row.due}, unpaid for ${days} days (limit ${limit})`,
    }));
  },

  /** §16.2, D4 — a PD submitted or pre-approved and not validated (seed 7 days). */
  pd_not_validated: async (tx) => {
    const rows = await standingPds(tx, sql`d.status_code in ('submitted', 'pre_approved')`);
    return rows.map((row) => ({
      payableId: row.payableId,
      laneCode: 'pd',
      since: row.registered,
      scope: { typeCode: row.typeCode, bankCode: row.bankCode, supplierId: row.supplierId },
      summary: (limit, days) =>
        `Over time limit: PD ${row.pdNo} ${row.statusName} for ${days} days, not validated (limit ${limit})`,
    }));
  },

  /** §16.2 — a PD rejected or expired and not re-registered: the import stops on it. */
  pd_expired: async (tx) => {
    const rows = await standingPds(tx, sql`(s.is_expired or d.status_code = 'rejected')`);
    return rows.map((row) => ({
      payableId: row.payableId,
      laneCode: 'pd',
      since: row.statusCode === 'rejected' ? row.registered : row.expiry,
      scope: { typeCode: row.typeCode, bankCode: row.bankCode, supplierId: row.supplierId },
      summary: () => `PD ${row.pdNo} is ${row.statusName} and not re-registered — reason required`,
    }));
  },

  /** §17.3 — a container whose ETA passed while still loading or at sea (set Late first). */
  container_eta_passed: async (tx) => {
    const result = await tx.execute(sql`
      select c.payable_id as "payableId", c.container_no as "containerNo", c.eta::text as eta,
             p.payable_type_code as "typeCode", p.supplier_id as "supplierId", b.port_of_discharge_code as "portCode"
        from shipment_container c
        join payable p on p.id = c.payable_id
        join bill_of_lading b on b.id = c.bl_id
       where c.status_code = 'late' and c.received_on is null and c.cancelled_at is null
         and p.cancelled_at is null and p.closed_at is null
       order by c.eta`);
    const rows = result.rows as {
      payableId: string;
      containerNo: string;
      eta: string;
      typeCode: string;
      supplierId: string;
      portCode: string | null;
    }[];
    return rows.map((row) => ({
      payableId: row.payableId,
      laneCode: 'shipment',
      since: row.eta,
      scope: { typeCode: row.typeCode, supplierId: row.supplierId, portCode: row.portCode },
      summary: (limit, days) => `Container ${row.containerNo} late: ETA ${row.eta} passed ${days} days ago and it has not arrived`,
    }));
  },

  /** D4 — a container at port (or cleared) and not received (seed 10 days). */
  at_port: async (tx) => {
    const result = await tx.execute(sql`
      select c.payable_id as "payableId", c.container_no as "containerNo", c.arrived_port_on::text as since,
             p.payable_type_code as "typeCode", p.supplier_id as "supplierId", b.port_of_discharge_code as "portCode"
        from shipment_container c
        join payable p on p.id = c.payable_id
        join bill_of_lading b on b.id = c.bl_id
       where c.status_code in ('at_port', 'customs_cleared') and c.arrived_port_on is not null
         and c.received_on is null and c.cancelled_at is null
         and p.cancelled_at is null and p.closed_at is null
       order by c.arrived_port_on`);
    const rows = result.rows as {
      payableId: string;
      containerNo: string;
      since: string;
      typeCode: string;
      supplierId: string;
      portCode: string | null;
    }[];
    return rows.map((row) => ({
      payableId: row.payableId,
      laneCode: 'shipment',
      since: row.since,
      scope: { typeCode: row.typeCode, supplierId: row.supplierId, portCode: row.portCode },
      summary: (limit, days) =>
        `Over time limit: ${row.containerNo} at port ${days} days, not received (limit ${limit})`,
    }));
  },

  /** §17.5, D4 — partly received for longer than the limit (seed 30 days from the first receipt). */
  partly_received: async (tx) => {
    const result = await tx.execute(sql`
      select c.payable_id as "payableId", min(c.received_on)::text as since,
             count(*)::int as total, (count(*) filter (where s.counts_as_received))::int as received,
             min(p.payable_type_code) as "typeCode", min(p.supplier_id::text) as "supplierId"
        from shipment_container c
        join container_status s on s.code = c.status_code
        join payable p on p.id = c.payable_id
       where c.cancelled_at is null and p.cancelled_at is null and p.closed_at is null
       group by c.payable_id
      having (count(*) filter (where s.counts_as_received)) > 0
         and (count(*) filter (where s.counts_as_received)) < count(*)`);
    const rows = result.rows as {
      payableId: string;
      since: string;
      total: number;
      received: number;
      typeCode: string;
      supplierId: string;
    }[];
    return rows.map((row) => ({
      payableId: row.payableId,
      laneCode: 'shipment',
      since: row.since,
      scope: { typeCode: row.typeCode, supplierId: row.supplierId },
      summary: (limit, days) =>
        `Over time limit: partly received for ${days} days — ${row.received} of ${row.total} containers in (limit ${limit})`,
    }));
  },

  /** §15.4, D4 — a SWIFT sent to the bank and not confirmed. Per method and bank. */
  swift_pending: (tx) => pendingApplications(tx, 'swift'),

  /** D4 — a local transfer, cheque or cash payment sent and not confirmed. */
  transfer_pending: (tx) => pendingApplications(tx, 'other'),

  /**
   * D4 — an import whose invoice is posted and owing, with nothing asked of
   * the bank: no payment application approved, sent or paid. The clock runs
   * from the invoice's posting.
   */
  invoice_unfunded: async (tx) => {
    const result = await tx.execute(sql`
      select p.id, p.payable_type_code as "typeCode", p.supplier_id as "supplierId",
             min(i.posted_at)::date::text as since, string_agg(i.invoice_no, ', ') as invoices
        from payable p
        join ap_invoice i on i.payable_id = p.id
                         and i.status in ('posted', 'partially_executed')
                         and i.reversed_at is null
                         and i.total_iqd > i.settled_amount_iqd
       where p.cancelled_at is null and p.closed_at is null
         and not exists (
               select 1 from payment_application pa
                where pa.payable_id = p.id
                  and pa.status in ('approved', 'sent', 'confirmed', 'debited'))
       group by p.id`);
    const rows = result.rows as {
      id: string;
      typeCode: string;
      supplierId: string;
      since: string;
      invoices: string;
    }[];
    return rows.map((row) => ({
      payableId: row.id,
      laneCode: 'bank',
      since: row.since,
      scope: { typeCode: row.typeCode, supplierId: row.supplierId },
      summary: (limit, days) =>
        `Over time limit: invoice ${row.invoices} posted ${days} days ago and not funded — no payment application approved (limit ${limit})`,
    }));
  },
};

/** §16.2 — the standing PDs of open imports, for the two PD clocks. */
async function standingPds(tx: Tx, where: ReturnType<typeof sql>) {
  const result = await tx.execute(sql`
    select d.id, d.pd_no as "pdNo", d.payable_id as "payableId", d.status_code as "statusCode",
           d.registration_date::text as registered, d.expiry_date::text as expiry,
           d.bank_code as "bankCode", s.name as "statusName",
           p.payable_type_code as "typeCode", p.supplier_id as "supplierId"
      from customs_pd d
      join pd_status s on s.code = d.status_code
      join payable p on p.id = d.payable_id
     where p.cancelled_at is null and p.closed_at is null
       and not exists (select 1 from customs_pd n where n.supersedes_pd_id = d.id)
       and ${where}
     order by d.registration_date`);
  return result.rows as {
    id: string;
    pdNo: string;
    payableId: string;
    statusCode: string;
    registered: string;
    expiry: string;
    bankCode: string | null;
    statusName: string;
    typeCode: string;
    supplierId: string;
  }[];
}

/**
 * The applications sent and waiting for the bank's answer, one offender per
 * application (the hold is per payable and check, so the oldest opens it).
 */
async function pendingApplications(tx: Tx, which: 'swift' | 'other'): Promise<Offender[]> {
  const result = await tx.execute(sql`
    select pa.payable_id as "payableId", pa.application_no as "applicationNo",
           pa.application_date::text as since, pa.payment_method_code as "methodCode",
           b.bank_code as "bankCode", p.payable_type_code as "typeCode", p.supplier_id as "supplierId",
           b.code as "accountCode"
      from payment_application pa
      join payment_method m on m.code = pa.payment_method_code
      join bank_cash_account b on b.id = pa.bank_cash_account_id
      join payable p on p.id = pa.payable_id
     where pa.status = 'sent'
       and p.cancelled_at is null and p.closed_at is null
       and ${which === 'swift' ? sql`m.confirmation_kind = 'swift'` : sql`m.confirmation_kind <> 'swift'`}
     order by pa.application_date`);
  const rows = result.rows as {
    payableId: string;
    applicationNo: string;
    since: string;
    methodCode: string;
    bankCode: string | null;
    typeCode: string;
    supplierId: string;
    accountCode: string;
  }[];
  return rows.map((row) => ({
    payableId: row.payableId,
    laneCode: 'payment',
    since: row.since,
    scope: {
      typeCode: row.typeCode,
      bankCode: row.bankCode,
      methodCode: row.methodCode,
      supplierId: row.supplierId,
    },
    summary: (limit, days) =>
      which === 'swift'
        ? `Over time limit: SWIFT pending ${days} days (limit ${limit}) — ${row.applicationNo} at ${row.accountCode}, NOT PAID`
        : `Over time limit: payment pending ${days} days (limit ${limit}) — ${row.applicationNo} at ${row.accountCode}`,
  }));
}

async function limitsFor(tx: Tx, checkCode: string): Promise<TimeLimitRow[]> {
  const rows = await tx
    .select({
      scope: stageTimeLimit.scope,
      limitDays: stageTimeLimit.limitDays,
      escalateAfterDays: stageTimeLimit.escalateAfterDays,
      escalateToRole: stageTimeLimit.escalateToRole,
      active: stageTimeLimit.active,
      validFrom: sql<string>`${stageTimeLimit.validFrom}::text`,
    })
    .from(stageTimeLimit)
    .where(eq(stageTimeLimit.checkCode, checkCode));
  return rows;
}

/**
 * One day's sweep, idempotent. Call inside a super-scoped transaction — the
 * sweep reads every branch, like the due-notice sweep does, because a clock
 * nobody's branch can see is a clock nobody answers for.
 */
export async function runSweep(tx: Tx, asOf: string): Promise<SweepResult> {
  // §22.2 — the log's partitions stay a year ahead of the calendar.
  const nextYear = Number(asOf.slice(0, 4)) + 1;
  await tx.execute(sql`select payable_event_ensure_partition(${nextYear})`);

  // §10.4 — the contract generator runs in the same sweep, before the
  // checks, so a period born due today is also checked today. Idempotent, as
  // the generator itself is.
  const generated = await contracts.generateDue(tx, asOf, null);

  // §15.4 — a confirmed payment whose bank line the reconciliation matched is
  // debit-final; read before the checks so a matched one stops being pending.
  const debitsMatched = await paymentApplications.syncDebits(tx);

  // §16.2 — PD_EXPIRING inside the warning window; past its expiry a PD moves
  // to its expired status, which the pd_expired check below then stops on.
  const pdExpiry = await customs.expirySweep(tx, asOf);

  // §17.3 — a container whose ETA passed while loading or at sea is Late; the
  // container_eta_passed check below then stops the import on it.
  const containersLate = await shipments.lateSweep(tx, asOf);

  // §15.6 — a loan instalment inside the warning window is due; one past it
  // is overdue, and every import the loan funds is told once.
  const loanInstalments = await loans.instalmentSweep(tx, asOf);

  const checks = await tx.select().from(sweepCheck).where(eq(sweepCheck.active, true));

  let checked = 0;
  let opened = 0;
  const skipped: string[] = [];

  for (const check of checks) {
    const query = CHECK_QUERIES[check.code];
    if (!query) {
      skipped.push(check.code);
      continue;
    }
    checked += 1;

    const limits = await limitsFor(tx, check.code);
    for (const offender of await query(tx, asOf)) {
      const limit = limitInForce(limits, offender.scope, asOf);
      if (!limit) continue;

      const days = daysBetween(offender.since, asOf);
      if (days <= limit.limitDays) continue;

      const breachedOn = new Date(
        Date.parse(offender.since) + (limit.limitDays + 1) * 86_400_000,
      );
      const created = await holds.openAutomatic(tx, {
        payableId: offender.payableId,
        laneCode: offender.laneCode,
        checkCode: check.code,
        startedAt: breachedOn,
        summary: offender.summary(limit.limitDays, days),
      });
      if (created) opened += 1;
    }
  }

  // §19.4 — a hold with no owner past its escalation days is told upward,
  // once: `escalated_at` is the idempotency mark.
  const limits = await tx
    .select({
      checkCode: stageTimeLimit.checkCode,
      escalateAfterDays: stageTimeLimit.escalateAfterDays,
      escalateToRole: stageTimeLimit.escalateToRole,
    })
    .from(stageTimeLimit)
    .where(and(eq(stageTimeLimit.active, true), sql`${stageTimeLimit.escalateAfterDays} is not null`));
  const escalateDays = new Map(limits.map((l) => [l.checkCode, l]));

  let escalated = 0;
  const openHolds = await tx
    .select()
    .from(payableHold)
    .where(
      and(
        eq(payableHold.status, 'open'),
        isNull(payableHold.ownerUserId),
        isNull(payableHold.escalatedAt),
        sql`${payableHold.checkCode} is not null`,
      ),
    );

  for (const hold of openHolds) {
    const rule = escalateDays.get(hold.checkCode!);
    if (!rule?.escalateAfterDays) continue;
    // From when the hold was OPENED, not from the backdated breach: the
    // escalation is about nobody answering, and nobody could answer before
    // the question existed.
    const waited = daysBetween(hold.createdAt.toISOString().slice(0, 10), asOf);
    if (waited <= rule.escalateAfterDays) continue;

    const toRole = rule.escalateToRole ?? 'accounting_manager';
    await tx
      .update(payableHold)
      .set({ escalatedAt: new Date(), escalatedToRole: toRole, updatedAt: new Date() })
      .where(eq(payableHold.id, hold.id));

    await events.record(tx, {
      payableId: hold.payableId,
      eventCode: 'ESCALATED',
      summary: `Escalated to ${toRole}: stopped ${waited} days with nobody following up`,
      holdId: hold.id,
      actorUserId: null,
    });

    const [parent] = await tx
      .select({ payableNo: payable.payableNo, branchCode: payable.branchCode })
      .from(payable)
      .where(eq(payable.id, hold.payableId))
      .limit(1);

    await notifications.raise(
      tx,
      {
        eventType: 'payable.hold.escalated',
        objectType: 'payable',
        objectId: hold.payableId,
        occurrence: asOf,
      },
      { payableNo: parent?.payableNo ?? hold.payableId, days: waited },
      { branchCode: parent?.branchCode ?? null },
    );

    escalated += 1;
  }

  return {
    asOf,
    checked,
    opened,
    escalated,
    periodsGenerated: generated.periodsCreated,
    debitsMatched,
    pdsWarned: pdExpiry.warned,
    pdsExpired: pdExpiry.expired,
    containersLate,
    loanInstalmentsDue: loanInstalments.due,
    loanInstalmentsOverdue: loanInstalments.overdue,
    skipped,
  };
}
