/**
 * REQ-LOG-001 — the pure rules the Logistics screens read
 * (`domain/import-logistics.ts`): a container's next action and delay, the
 * life of a customs declaration, a charge's state, and why the landed cost
 * is where it is. No database.
 */
import { describe, expect, it } from 'vitest';
import {
  DECLARATION_FINAL,
  DECLARATION_STATUSES,
  assertDeclarationMove,
  chargeState,
  daysBetween,
  declarationChip,
  delayDays,
  isDeclarationStatus,
  lockReason,
  nextAction,
  nextDeclarationStatuses,
} from '@domain/import-logistics';

const box = (statusCode: string, extra: Partial<Parameters<typeof nextAction>[0]> = {}) =>
  nextAction({ statusCode, cancelled: false, customsClearedOn: null, portFileSentOn: null, ...extra });

describe('a container’s next action and delay', () => {
  it('names what the container waits for from its stage, and nothing once it is in or cancelled', () => {
    expect(box('not_loaded')).toBe('load');
    expect(box('on_sea')).toBe('await_arrival');
    expect(box('late')).toBe('chase_eta');
    expect(box('at_port')).toBe('clear_customs');
    expect(box('customs_cleared', { customsClearedOn: '2026-10-01' })).toBe('send_port_file');
    expect(box('customs_cleared', { customsClearedOn: '2026-10-01', portFileSentOn: '2026-10-02' })).toBe('receive');
    expect(box('missing_damaged')).toBe('claim_shortage');
    expect(box('received')).toBeNull();
    expect(box('on_sea', { cancelled: true })).toBeNull();
  });

  it('counts the days past the ETA, none before it, and none once received', () => {
    expect(daysBetween('2026-10-01', '2026-10-08')).toBe(7);
    expect(delayDays('2026-10-01', null, '2026-10-08')).toBe(7);
    expect(delayDays('2026-10-10', null, '2026-10-08')).toBe(0);
    expect(delayDays(null, null, '2026-10-08')).toBe(0);
    expect(delayDays('2026-10-01', '2026-10-05', '2026-10-08')).toBeNull();
  });
});

describe('the life of a customs declaration', () => {
  it('goes forward one step at a time, out with a reason, and never again from an end', () => {
    expect(DECLARATION_STATUSES).toEqual(['draft', 'submitted', 'accepted', 'assessed', 'cleared', 'cancelled', 'rejected']);
    expect(nextDeclarationStatuses('draft')).toEqual(['submitted', 'cancelled']);
    expect(nextDeclarationStatuses('submitted')).toEqual(['accepted', 'rejected', 'cancelled']);
    expect(nextDeclarationStatuses('assessed')).toEqual(['cleared', 'rejected', 'cancelled']);
    for (const end of DECLARATION_FINAL) expect(nextDeclarationStatuses(end)).toEqual([]);
    expect(() => assertDeclarationMove('CDN-1', 'draft', 'submitted')).not.toThrow();
    expect(() => assertDeclarationMove('CDN-1', 'draft', 'cleared')).toThrow(/from there it goes to submitted, cancelled — not cleared/);
    expect(() => assertDeclarationMove('CDN-1', 'draft', 'rejected')).toThrow(/not rejected/);
    expect(() => assertDeclarationMove('CDN-1', 'cleared', 'cancelled')).toThrow(/does not move again/);
    expect(isDeclarationStatus('assessed')).toBe(true);
    expect(isDeclarationStatus('posted')).toBe(false);
  });

  it('wears the shared chips', () => {
    expect(declarationChip('cleared')).toBe('settled');
    expect(declarationChip('accepted')).toBe('approved');
    expect(declarationChip('assessed')).toBe('approved');
    expect(declarationChip('submitted')).toBe('submitted');
    expect(declarationChip('rejected')).toBe('rejected');
    expect(declarationChip('cancelled')).toBe('cancelled');
    expect(declarationChip('draft')).toBe('draft');
  });
});

describe('a charge and the lock, in a word', () => {
  it('reads a charge as withdrawn, locked or waiting', () => {
    expect(chargeState({ cancelledAt: new Date(), lockId: 'x' })).toBe('withdrawn');
    expect(chargeState({ cancelledAt: null, lockId: 'x' })).toBe('locked');
    expect(chargeState({ cancelledAt: null, lockId: null })).toBe('unlocked');
  });

  it('says why the landed cost is where it is, in the order the import page decides it', () => {
    const base = { pdsWrittenOff: true, containersIn: true, unlocked: 2, locked: false };
    expect(lockReason(base)).toBe('ready');
    expect(lockReason({ ...base, pdsWrittenOff: false })).toBe('waiting_pds');
    expect(lockReason({ ...base, containersIn: false })).toBe('waiting_containers');
    expect(lockReason({ ...base, pdsWrittenOff: false, containersIn: false })).toBe('waiting_pds');
    expect(lockReason({ ...base, unlocked: 0 })).toBe('nothing_charged');
    expect(lockReason({ ...base, locked: true, unlocked: 0 })).toBe('locked');
    expect(lockReason({ ...base, locked: true, unlocked: 1 })).toBe('late_charges');
  });
});
