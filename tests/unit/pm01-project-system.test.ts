/**
 * REQ-PM-001 Stage PM-1 — the pure rules of the Project System: the coding
 * mask, the status profile, the roll-up over the tree, the display order,
 * and availability control's lines (PM1, PM2, PM3 — the halves that need
 * no database).
 */
import { describe, expect, it } from 'vitest';
import { TRANSITIONS, assertTransition, availabilityState, nextWbsCode, rollUp, treeOrder, wbsCodeLevel } from '@/server/domain/project-system';

describe('PM1 · the coding mask and the tree', () => {
  it('the mask, the roll-up, the order and the availability lines', () => {
    expect(nextWbsCode('P', null, [])).toBe('P-1');
    expect(nextWbsCode('P', 'P-1', ['P-1.1', 'P-1.3', 'P-2.1'])).toBe('P-1.4');
    expect(wbsCodeLevel('P', 'P-1.2', 'P-1.2.7')).toBe(3);
    expect(() => wbsCodeLevel('P', 'P-1', 'P-2.1')).toThrow(/must begin with/);
    const nodes = [
      { code: 'P-1', parentCode: null, level: 1 },
      { code: 'P-1.2', parentCode: 'P-1', level: 2 },
      { code: 'P-1.10', parentCode: 'P-1', level: 2 },
      { code: 'P-1.2.1', parentCode: 'P-1.2', level: 3 },
    ];
    const totals = rollUp(nodes, new Map([['P-1.2.1', { budgetIqd: 10n, committedIqd: 2n, actualIqd: 3n }], ['P-1.10', { budgetIqd: 5n, committedIqd: 0n, actualIqd: 1n }]]));
    expect(totals.get('P-1')).toEqual({ budgetIqd: 15n, committedIqd: 2n, actualIqd: 4n });
    expect(totals.get('P-1.2')).toEqual({ budgetIqd: 10n, committedIqd: 2n, actualIqd: 3n });
    expect(treeOrder(nodes).map((n) => n.code)).toEqual(['P-1', 'P-1.2', 'P-1.2.1', 'P-1.10']);
    const profile = { warnPercent: 90, stopPercent: 100 };
    expect(availabilityState(1000n, 899n, profile)).toBe('ok');
    expect(availabilityState(1000n, 900n, profile)).toBe('warn');
    expect(availabilityState(1000n, 1001n, profile)).toBe('stop');
    expect(availabilityState(0n, 1n, profile)).toBe('stop');
  });

  it('PS\'s status profile: CRTD → REL → (hold ⇄) → TECO → CLSD, and one reopen from TECO', () => {
    expect(assertTransition('release', 'draft', 'P')).toBe('active');
    expect(assertTransition('hold', 'active', 'P')).toBe('on_hold');
    expect(assertTransition('resume', 'on_hold', 'P')).toBe('active');
    expect(assertTransition('technical_complete', 'active', 'P')).toBe('closing');
    expect(assertTransition('reopen', 'closing', 'P')).toBe('active');
    expect(assertTransition('close', 'closing', 'P')).toBe('closed');
    expect(() => assertTransition('close', 'active', 'P')).toThrow(/allowed from closing only/);
    expect(() => assertTransition('release', 'closed', 'P')).toThrow(/allowed from draft only/);
    expect(Object.keys(TRANSITIONS)).toEqual(['release', 'hold', 'resume', 'technical_complete', 'reopen', 'close']);
  });
});
