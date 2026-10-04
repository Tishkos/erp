/**
 * Chart-data shaping, the import journey and the approval list's rules —
 * platform phase, Agent 2. All pure.
 */
import { describe, expect, it } from 'vitest';
import {
  ageingBands,
  balanceRows,
  chartNumber,
  hasActivity,
  monthStart,
  monthWindows,
  moneyOf,
  moneyString,
  pairSeries,
  rankedRows,
  sumMoney,
} from '@domain/dashboard-charts';
import {
  JOURNEY_STAGES,
  countByStage,
  furthest,
  journeyOf,
  reached,
  stagesFor,
  type ImportFacts,
} from '@domain/import-journey';
import {
  filterItems,
  mayActOnStep,
  mayApproveSubmitted,
  pageOf,
  sortItems,
  typesOf,
  type ApprovalItem,
} from '@domain/approval-center';
import type { Principal } from '@domain/permissions';

function principal(overrides: Partial<Principal> = {}): Principal {
  return { userId: 'me', isSuperUser: false, isActive: true, roleCodes: [], grants: [], branchCodes: ['HQ'], departments: [], ...overrides };
}

describe('money in charts is a scaled bigint until the last step', () => {
  it('parses at four places and rounds the FIFO valuation\'s ten half up', () => {
    expect(moneyOf('250350')).toBe(2503500000n);
    expect(moneyOf('250350.1234')).toBe(2503501234n);
    expect(moneyOf('0.12345')).toBe(1235n);
    expect(moneyOf('0.12344999')).toBe(1234n);
    expect(moneyOf('-0.00005')).toBe(-1n);
    expect(moneyOf(null)).toBe(0n);
    expect(moneyOf('')).toBe(0n);
  });

  it('refuses a value that is not a decimal', () => {
    expect(() => moneyOf('12,5')).toThrow(RangeError);
  });

  it('sums without a float', () => {
    // 0.1 + 0.2 is the float trap; scaled it is exact.
    expect(moneyString(sumMoney(['0.1', '0.2']))).toBe('0.3000');
    expect(moneyString(sumMoney(['9007199254740993', '1']))).toBe('9007199254740994.0000');
  });

  it('turns a figure into a plotted number only at the end', () => {
    expect(chartNumber('1500.5')).toBe(1500.5);
    expect(chartNumber('0')).toBe(0);
  });
});

describe('month windows are date arithmetic', () => {
  it('ends the last window on the business date, not the month end', () => {
    const w = monthWindows('2026-10-04', 3);
    expect(w.map((x) => x.month)).toEqual(['2026-08', '2026-09', '2026-10']);
    expect(w[2]).toEqual({ month: '2026-10', from: '2026-10-01', to: '2026-10-04' });
    expect(w[1]).toEqual({ month: '2026-09', from: '2026-09-01', to: '2026-09-30' });
  });

  it('crosses a year and knows a leap February', () => {
    const w = monthWindows('2028-02-29', 3);
    expect(w.map((x) => x.month)).toEqual(['2027-12', '2028-01', '2028-02']);
    expect(w[0]!.to).toBe('2027-12-31');
    expect(monthWindows('2028-03-10', 2)[0]!.to).toBe('2028-02-29');
    expect(monthWindows('2027-03-10', 2)[0]!.to).toBe('2027-02-28');
    expect(monthWindows('2100-03-10', 2)[0]!.to).toBe('2100-02-28');
    expect(monthWindows('2000-03-10', 2)[0]!.to).toBe('2000-02-29');
  });

  it('gives twelve windows in order', () => {
    const w = monthWindows('2026-01-15', 12);
    expect(w).toHaveLength(12);
    expect(w[0]!.month).toBe('2025-02');
    expect(w[11]!.month).toBe('2026-01');
  });

  it('refuses a date that is not ISO', () => {
    expect(() => monthWindows('04/10/2026', 3)).toThrow(RangeError);
  });

  it('starts a month', () => {
    expect(monthStart('2026-10-04')).toBe('2026-10-01');
  });
});

describe('series are not drawn from nothing', () => {
  it('says a series of zeroes has no activity, so no chart is made', () => {
    const zero = [{ month: '2026-09', first: '0', second: '0.0000' }];
    expect(hasActivity(zero)).toBe(false);
    expect(pairSeries(zero)).toBeNull();
  });

  it('keeps a series with any figure, at the ledger\'s scale', () => {
    const points = [
      { month: '2026-09', first: '0', second: '0' },
      { month: '2026-10', first: '1200.5', second: '300' },
    ];
    expect(hasActivity(points)).toBe(true);
    expect(pairSeries(points)).toEqual([
      { month: '2026-09', first: '0.0000', second: '0.0000' },
      { month: '2026-10', first: '1200.5000', second: '300.0000' },
    ]);
  });

  it('ranks positives largest first, ties by label, capped', () => {
    const rows = [
      { key: 'a', label: 'Alpha', amount: '10' },
      { key: 'b', label: 'Beta', amount: '30' },
      { key: 'c', label: 'Gamma', amount: '30' },
      { key: 'z', label: 'Zero', amount: '0' },
      { key: 'n', label: 'Neg', amount: '-5' },
    ];
    expect(rankedRows(rows, 3).map((r) => r.key)).toEqual(['b', 'c', 'a']);
    expect(rankedRows(rows, 1).map((r) => r.key)).toEqual(['b']);
    expect(rankedRows([{ key: 'z', label: 'Z', amount: '0' }], 8)).toEqual([]);
  });

  it('keeps an overdrawn balance (largest magnitude first) but not a zero one', () => {
    const rows = [
      { key: 'a', label: 'A', amount: '100' },
      { key: 'b', label: 'B', amount: '-500' },
      { key: 'c', label: 'C', amount: '0' },
    ];
    expect(balanceRows(rows, 5).map((r) => r.key)).toEqual(['b', 'a']);
  });

  it('draws ageing bands in report order, only those that hold something', () => {
    const bands = ageingBands({
      buckets: [
        { bucket: '90+', amountIqd: '40', invoices: 1 },
        { bucket: 'current', amountIqd: '100.5', invoices: 3 },
        { bucket: '1-30', amountIqd: '0', invoices: 0 },
      ],
    });
    expect(bands.map((b) => b.key)).toEqual(['current', '90+']);
    expect(bands.map((b) => b.step)).toEqual([1, 5]);
    expect(bands[0]).toMatchObject({ labelKey: 'bucket_current', value: '100.5000', count: 3 });
    expect(bands[1]!.labelKey).toBe('bucket_over_90');
    expect(ageingBands({ buckets: [] })).toEqual([]);
  });
});

const facts = (over: Partial<ImportFacts> = {}): ImportFacts => ({
  payableNo: 'PAY-1',
  stageCode: 'order_confirmed',
  blCount: 0,
  containerCount: 0,
  containersReceived: 0,
  departed: false,
  standingPds: 0,
  clearedDeclarations: 0,
  liveCharges: 0,
  receivedQty: '0',
  ...over,
});

describe('the import journey is read from facts, step by step', () => {
  const everything = principal({
    grants: ['payable', 'bill_of_lading', 'shipment_container', 'customs_pd', 'customs_declaration', 'landed_cost_register', 'inventory_movement'].map((object) => ({ verb: 'view' as const, object })),
  });

  it('has the nine steps in the order a person says them', () => {
    expect([...JOURNEY_STAGES]).toEqual(['application', 'shipping', 'bl', 'container', 'customs', 'clearance', 'landed_cost', 'receipt', 'inventory']);
  });

  it('reaches only the application for a bare import', () => {
    const steps = journeyOf(facts(), JOURNEY_STAGES);
    expect(steps.filter((s) => s.reached).map((s) => s.stage)).toEqual(['application']);
    expect(furthest(facts(), JOURNEY_STAGES)).toBe('application');
  });

  it('reaches a step on its own evidence', () => {
    expect(reached('bl', facts({ blCount: 1 }))).toBe(true);
    expect(reached('container', facts({ containerCount: 2 }))).toBe(true);
    expect(reached('shipping', facts({ departed: true }))).toBe(true);
    expect(reached('customs', facts({ standingPds: 1 }))).toBe(true);
    expect(reached('landed_cost', facts({ liveCharges: 2 }))).toBe(true);
    expect(reached('landed_cost', facts({ liveCharges: null }))).toBe(false);
    expect(reached('inventory', facts({ receivedQty: '12.5' }))).toBe(true);
    expect(reached('inventory', facts({ receivedQty: '0.000000' }))).toBe(false);
    expect(reached('inventory', facts({ receivedQty: null }))).toBe(false);
    expect(reached('inventory', facts({ receivedQty: '-3' }))).toBe(false);
  });

  it('counts a received container as having cleared customs', () => {
    expect(reached('clearance', facts({ containersReceived: 1 }))).toBe(true);
    expect(reached('clearance', facts({ clearedDeclarations: 1 }))).toBe(true);
    expect(reached('clearance', facts())).toBe(false);
    expect(reached('receipt', facts({ containersReceived: 1 }))).toBe(true);
  });

  it('is not a funnel: landed cost may be reached before receipt', () => {
    const f = facts({ liveCharges: 1 });
    expect(reached('landed_cost', f)).toBe(true);
    expect(reached('receipt', f)).toBe(false);
    expect(furthest(f, JOURNEY_STAGES)).toBe('landed_cost');
  });

  it('counts the imports that reached each step', () => {
    const imports = [facts(), facts({ blCount: 1, containerCount: 1 }), facts({ blCount: 1, containerCount: 2, containersReceived: 1 })];
    const counts = Object.fromEntries(countByStage(imports, JOURNEY_STAGES).map((c) => [c.key, c.count]));
    expect(counts).toMatchObject({ application: 3, bl: 2, container: 2, receipt: 1, clearance: 1, customs: 0 });
  });

  it('draws a step only for someone who can read its evidence', () => {
    expect(stagesFor(everything)).toEqual([...JOURNEY_STAGES]);
    const logistics = principal({
      grants: ['payable', 'bill_of_lading', 'shipment_container', 'customs_pd', 'customs_declaration', 'in_transit'].map((object) => ({ verb: 'view' as const, object })),
    });
    // No landed-cost register, no stock: those two steps are absent rather than zero.
    expect(stagesFor(logistics)).toEqual(['application', 'shipping', 'bl', 'container', 'customs', 'clearance', 'receipt']);
    expect(stagesFor(principal())).toEqual([]);
    expect(stagesFor(principal({ isActive: false, isSuperUser: true }))).toEqual([]);
    expect(stagesFor(principal({ isSuperUser: true }))).toEqual([...JOURNEY_STAGES]);
  });
});

const item = (over: Partial<ApprovalItem> = {}): ApprovalItem => ({
  id: 'workflow:1',
  source: 'workflow',
  documentType: 'journal_entry',
  documentNo: 'JE-HQ-2026-000001',
  href: '/finance/journals/JE-HQ-2026-000001',
  requester: 'Officer',
  since: '2026-10-01T08:00:00.000Z',
  amount: { value: '100.0000', currency: 'IQD' },
  stage: 'role_accounting_manager',
  action: 'approve',
  inline: { documentType: 'journal_entry', documentId: 'x' },
  ...over,
});

describe('only what the viewer can act on', () => {
  const step = { approverKind: 'role' as const, approverRole: 'accounting_manager', allowSelfApproval: false, submittedBy: 'someone', departmentCode: null };

  it('asks for the role the step names', () => {
    expect(mayActOnStep(step, principal({ roleCodes: ['accounting_manager'] }))).toBe(true);
    expect(mayActOnStep(step, principal({ roleCodes: ['accounting_officer'] }))).toBe(false);
    expect(mayActOnStep(step, principal())).toBe(false);
  });

  it('never lists what the viewer raised themselves — four eyes, a super user included', () => {
    const mine = { ...step, submittedBy: 'me' };
    expect(mayActOnStep(mine, principal({ roleCodes: ['accounting_manager'] }))).toBe(false);
    expect(mayActOnStep(mine, principal({ roleCodes: ['accounting_manager'], isSuperUser: true }))).toBe(false);
    expect(mayActOnStep({ ...mine, allowSelfApproval: true }, principal({ roleCodes: ['accounting_manager'] }))).toBe(true);
  });

  it('asks for the managed department when the step is the department manager\'s', () => {
    const dept = { approverKind: 'department_manager' as const, approverRole: null, allowSelfApproval: false, submittedBy: 'x', departmentCode: 'SALES' };
    expect(mayActOnStep(dept, principal({ departments: [{ code: 'SALES', isManager: true }] }))).toBe(true);
    expect(mayActOnStep(dept, principal({ departments: [{ code: 'SALES', isManager: false }] }))).toBe(false);
    expect(mayActOnStep(dept, principal({ departments: [{ code: 'FIN', isManager: true }] }))).toBe(false);
    expect(mayActOnStep({ ...dept, departmentCode: null }, principal({ departments: [{ code: 'SALES', isManager: true }] }))).toBe(false);
  });

  it('refuses a step with no approver and an inactive account', () => {
    expect(mayActOnStep({ ...step, approverKind: null }, principal({ roleCodes: ['accounting_manager'] }))).toBe(false);
    expect(mayActOnStep(step, principal({ roleCodes: ['accounting_manager'], isActive: false }))).toBe(false);
  });

  it('lets a submitted document be approved by a holder who did not raise it', () => {
    expect(mayApproveSubmitted(principal(), 'other', true)).toBe(true);
    expect(mayApproveSubmitted(principal(), 'me', true)).toBe(false);
    expect(mayApproveSubmitted(principal(), 'other', false)).toBe(false);
    expect(mayApproveSubmitted(principal({ isSuperUser: true }), 'me', true)).toBe(true);
    expect(mayApproveSubmitted(principal(), null, true)).toBe(true);
  });
});

describe('the list', () => {
  const items = [
    item({ id: 'a', since: '2026-10-03T00:00:00.000Z', documentNo: 'JE-2' }),
    item({ id: 'b', since: '2026-10-01T00:00:00.000Z', documentNo: 'JE-1' }),
    item({ id: 'c', since: null, documentNo: 'PO-9', documentType: 'purchase_order', requester: 'Zed' }),
  ];

  it('is oldest first, and undated last', () => {
    expect(sortItems(items).map((i) => i.id)).toEqual(['b', 'a', 'c']);
  });

  it('filters by phrase and by type', () => {
    expect(filterItems(items, { q: 'po-9' }).map((i) => i.id)).toEqual(['c']);
    expect(filterItems(items, { q: 'zed' }).map((i) => i.id)).toEqual(['c']);
    expect(filterItems(items, { documentType: 'journal_entry' }).map((i) => i.id)).toEqual(['a', 'b']);
    expect(filterItems(items, { q: 'nothing' })).toEqual([]);
    expect(filterItems(items, {})).toHaveLength(3);
  });

  it('pages with a true total and clamps the page', () => {
    const many = Array.from({ length: 60 }, (_, i) => item({ id: `i${i}` }));
    const p = pageOf(many, { page: 3 });
    expect(p).toMatchObject({ total: 60, page: 3, pages: 3, pageSize: 25 });
    expect(p.rows).toHaveLength(10);
    expect(pageOf(many, { page: 99 }).page).toBe(3);
    expect(pageOf(many, { page: -4 }).page).toBe(1);
    expect(pageOf([], {})).toMatchObject({ total: 0, pages: 1, page: 1, rows: [] });
  });

  it('lists the document types it holds, once each', () => {
    expect(typesOf(items)).toEqual(['journal_entry', 'purchase_order']);
  });
});
