/**
 * Logistics detectors — platform phase, Agent 7: containers past their ETA,
 * shipments nobody has updated, customs papers in trouble, landed costs that
 * cannot be allocated.
 */
import { sql } from 'drizzle-orm';
import { businessDateOf } from '../../domain/business-date';
import { daysBetween } from '../../domain/ageing';
import { EVIDENCE_ROW, THRESHOLDS, severityByDays, type Finding } from '../../domain/exceptions';
import { profileHref } from '../../domain/profiles';
import * as views from '../logistics-views';
import { enc, rowsOf, type DetectContext } from './shared';

async function containerBranches(ctx: DetectContext, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = rowsOf<{ id: string; branch_code: string }>(
    await ctx.tx.execute(sql`
      select c.id::text, p.branch_code
        from shipment_container c join payable p on p.id = c.payable_id
       where c.id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`),
  );
  return new Map(rows.map((r) => [r.id, r.branch_code]));
}

// ---------------------------------------------------------------------------
// A container past its ETA and not received
// ---------------------------------------------------------------------------

export async function containerDelayed(ctx: DetectContext): Promise<Finding[]> {
  const { tx, today } = ctx;
  const { rows } = await views.shipmentTracking(tx, { view: 'open', asOf: today });
  const late = rows
    .map((row) => ({ row, severity: row.delayDays === null ? null : severityByDays(row.delayDays, THRESHOLDS.containerLate) }))
    .filter((x): x is { row: (typeof rows)[number]; severity: NonNullable<typeof x.severity> } => x.severity !== null);
  const branches = await containerBranches(ctx, late.map((x) => x.row.id));
  return late.map(({ row, severity }) => {
    const href = profileHref('container', row.containerNo, { id: row.id }) ?? '/logistics/shipment-tracking';
    return {
      detector: 'logistics.container_delayed',
      subject: row.id,
      severity,
      facts: {
        container: row.containerNo,
        bl: row.blNo,
        supplier: row.supplierName,
        importNo: row.payableNo,
        etaDate: row.eta,
        days: row.delayDays ?? 0,
      },
      evidence: [EVIDENCE_ROW({ ref: row.containerNo, href, date: row.eta, note: { code: 'container_eta_passed', params: { days: row.delayDays ?? 0 } } })],
      record: { type: 'shipment_container', id: row.id, label: row.containerNo, href },
      action: `/logistics/shipment-tracking?q=${enc(row.containerNo)}`,
      branchCode: branches.get(row.id) ?? null,
      partyCode: row.supplierCode,
    };
  });
}

// ---------------------------------------------------------------------------
// A container whose status nobody has written for a while
// ---------------------------------------------------------------------------

export async function shipmentUpdateStale(ctx: DetectContext): Promise<Finding[]> {
  const { tx, today } = ctx;
  const { rows } = await views.shipmentTracking(tx, { view: 'open', asOf: today });
  const stale = rows
    .filter((row) => row.lastUpdateAt !== null)
    .map((row) => {
      const last = businessDateOf(new Date(row.lastUpdateAt as string));
      const days = daysBetween(last, today);
      return { row, last, days, severity: severityByDays(days, THRESHOLDS.shipmentStale) };
    })
    .filter((x): x is typeof x & { severity: NonNullable<typeof x.severity> } => x.severity !== null);
  const branches = await containerBranches(ctx, stale.map((x) => x.row.id));
  return stale.map(({ row, last, days, severity }) => {
    const href = profileHref('container', row.containerNo, { id: row.id }) ?? '/logistics/shipment-tracking';
    return {
      detector: 'logistics.shipment_update_stale',
      subject: row.id,
      severity,
      facts: { container: row.containerNo, bl: row.blNo, supplier: row.supplierName, lastDate: last, days },
      evidence: [EVIDENCE_ROW({ ref: row.containerNo, href, date: last, note: { code: 'container_last_update', params: { days } } })],
      record: { type: 'shipment_container', id: row.id, label: row.containerNo, href },
      action: `/logistics/shipment-tracking?q=${enc(row.containerNo)}`,
      branchCode: branches.get(row.id) ?? null,
      partyCode: row.supplierCode,
    };
  });
}

// ---------------------------------------------------------------------------
// A customs paper in trouble
// ---------------------------------------------------------------------------

/** How far back a rejected or expired PD still counts as something to deal with. */
const PD_LOOKBACK_DAYS = 180;

/**
 * A payment document (PD) that stands as the latest of its chain and was
 * rejected, expired with value unwritten, is past its expiry while still
 * live, or expires within `pdExpiryWarningDays`.
 */
export async function customsIssue(ctx: DetectContext): Promise<Finding[]> {
  const { tx, today } = ctx;
  const warn = THRESHOLDS.pdExpiryWarningDays;
  const rows = rowsOf<{
    id: string;
    pd_no: string;
    registration_year: number;
    branch_code: string;
    expiry_date: string;
    status_code: string;
    status_date: string;
    is_terminal: boolean;
    payable_no: string | null;
  }>(
    await tx.execute(sql`
      select d.id::text, d.pd_no, d.registration_year::int, d.branch_code, d.expiry_date::text, d.status_code, d.status_date::text,
             s.is_terminal, p.payable_no
        from customs_pd d
        join pd_status s on s.code = d.status_code
        left join payable p on p.id = d.payable_id
       where not exists (select 1 from customs_pd n where n.supersedes_pd_id = d.id)
         and (p.id is null or p.cancelled_at is null)
         and (
              (d.status_code in ('rejected', 'expired_validated', 'expired_part_written_off') and d.status_date >= (${today}::date - ${PD_LOOKBACK_DAYS}::int))
           or (not s.is_terminal and d.expiry_date <= (${today}::date + ${warn}::int))
         )
       order by d.expiry_date, d.pd_no
       limit ${THRESHOLDS.findingsPerDetector + 1}`),
  );
  return rows.map((row) => {
    const href = profileHref('pd', row.pd_no, { year: row.registration_year }) ?? '/payables/pd';
    const days = daysBetween(row.expiry_date, today);
    const issue =
      row.status_code === 'rejected' ? 'rejected' : row.is_terminal ? 'expired' : row.expiry_date < today ? 'past_expiry' : 'expiring';
    return {
      detector: 'logistics.customs_issue',
      subject: row.id,
      severity: issue === 'rejected' || issue === 'past_expiry' ? ('high' as const) : ('medium' as const),
      facts: { pd: row.pd_no, issue, expiryDate: row.expiry_date, days: Math.abs(days), importNo: row.payable_no },
      evidence: [EVIDENCE_ROW({ ref: row.pd_no, href, date: row.expiry_date, note: { code: `pd_${issue}`, params: { days: Math.abs(days) } } })],
      record: { type: 'customs_pd', id: row.id, label: row.pd_no, href },
      action: href,
      branchCode: row.branch_code,
    };
  });
}

// ---------------------------------------------------------------------------
// An import whose landed cost cannot be allocated
// ---------------------------------------------------------------------------

export async function landedCostBlocked(ctx: DetectContext): Promise<Finding[]> {
  const { tx, today } = ctx;
  const { rows } = await views.landedCostsRegister(tx, { view: 'all' });
  const candidates = rows.filter((row) => row.unlockedCharges > 0 && row.state !== 'locked' && row.state !== 'nothing_charged');
  if (candidates.length === 0) return [];
  const ages = new Map(
    rowsOf<{ payable_id: string; oldest: string }>(
      await tx.execute(sql`
        select payable_id::text, min(created_at)::date::text as oldest
          from landed_cost_charge
         where cancelled_at is null and lock_id is null and charge_type_code not in ('purchase')
         group by payable_id`),
    ).map((r) => [r.payable_id, r.oldest]),
  );
  const findings: Finding[] = [];
  for (const row of candidates) {
    const oldest = ages.get(row.payableId) ?? today;
    const days = daysBetween(oldest, today);
    const severity = row.state === 'late_charges' ? ('high' as const) : severityByDays(days, THRESHOLDS.landedCostWaiting);
    if (severity === null) continue;
    const href = profileHref('import', row.payableNo) ?? '/payables';
    findings.push({
      detector: 'logistics.landed_cost_blocked',
      subject: row.payableId,
      severity,
      facts: {
        importNo: row.payableNo,
        supplier: row.supplierName,
        state: row.state,
        charges: row.unlockedCharges,
        unlockedIqd: row.unlockedIqd,
        days,
        containersIn: row.containersReceived,
        containers: row.containerCount,
        pds: row.pdSummary,
      },
      evidence: [
        EVIDENCE_ROW({ ref: row.payableNo, href, date: oldest, amount: row.unlockedIqd, note: { code: 'landed_unlocked', params: { charges: row.unlockedCharges, days } } }),
        EVIDENCE_ROW({ ref: row.payableNo, href, note: { code: 'landed_containers', params: { received: row.containersReceived, total: row.containerCount } } }),
      ],
      record: { type: 'payable', id: row.payableId, label: row.payableNo, href },
      action: `/logistics/landed-costs?q=${enc(row.payableNo)}`,
      branchCode: row.branchCode,
      partyCode: row.supplierCode,
    });
  }
  return findings;
}
