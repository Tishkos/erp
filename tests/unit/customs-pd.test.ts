/**
 * REQ-AP-001 §16 — the PD rules, decidable without a database.
 */
import { describe, expect, it } from 'vitest';
import {
  allWrittenOff,
  daysUntil,
  expiredStatusFor,
  isLivePd,
  needsReRegistration,
  parseAsycudaList,
  paymentReadiness,
  type PdFacts,
  type PdStatusRow,
} from '@domain/customs-pd';

const STATUSES: PdStatusRow[] = [
  { code: 'submitted', name: 'Submitted', asycudaLabel: 'Submited', allowsPayment: false, isTerminal: false, isExpired: false },
  { code: 'pre_approved', name: 'Pre-approved', asycudaLabel: 'PreApproved', allowsPayment: false, isTerminal: false, isExpired: false },
  { code: 'validated', name: 'Validated', asycudaLabel: 'Validated', allowsPayment: true, isTerminal: false, isExpired: false },
  { code: 'partially_written_off', name: 'Partially written off', asycudaLabel: 'Partially Written Off', allowsPayment: true, isTerminal: false, isExpired: false },
  { code: 'totally_written_off', name: 'Totally written off', asycudaLabel: 'Totally Written Off', allowsPayment: false, isTerminal: true, isExpired: false },
  { code: 'rejected', name: 'Rejected', asycudaLabel: 'Rejected', allowsPayment: false, isTerminal: true, isExpired: false },
  { code: 'expired_validated', name: 'Expired (validated)', asycudaLabel: 'Expired Validated', allowsPayment: false, isTerminal: true, isExpired: true },
];
const MAP = new Map(STATUSES.map((s) => [s.code, s]));
const pd = (over: Partial<PdFacts> = {}): PdFacts => ({
  id: 'p1',
  pdNo: '9330',
  statusCode: 'validated',
  expiryDate: '2027-03-01',
  bankCode: 'BNK-0002',
  superseded: false,
  ...over,
});

describe('§16 · which PDs count', () => {
  it('live is registered and not dead; written off still counts', () => {
    expect(isLivePd(pd(), MAP)).toBe(true);
    expect(isLivePd(pd({ statusCode: 'totally_written_off' }), MAP)).toBe(true);
    expect(isLivePd(pd({ statusCode: 'rejected' }), MAP)).toBe(false);
    expect(isLivePd(pd({ statusCode: 'expired_validated' }), MAP)).toBe(false);
    expect(isLivePd(pd({ superseded: true }), MAP)).toBe(false);
  });

  it('all written off ignores superseded rows and needs at least one PD', () => {
    expect(allWrittenOff([])).toBe(false);
    expect(
      allWrittenOff([
        pd({ statusCode: 'rejected', superseded: true }),
        pd({ id: 'p2', statusCode: 'totally_written_off' }),
      ]),
    ).toBe(true);
    expect(allWrittenOff([pd({ statusCode: 'totally_written_off' }), pd({ id: 'p2' })])).toBe(false);
  });

  it('a rejected or expired PD nobody re-registered needs it', () => {
    expect(needsReRegistration(pd({ statusCode: 'rejected' }), MAP)).toBe(true);
    expect(needsReRegistration(pd({ statusCode: 'expired_validated' }), MAP)).toBe(true);
    expect(needsReRegistration(pd({ statusCode: 'rejected', superseded: true }), MAP)).toBe(false);
    expect(needsReRegistration(pd({ statusCode: 'totally_written_off' }), MAP)).toBe(false);
    expect(expiredStatusFor('validated')).toBe('expired_validated');
    expect(expiredStatusFor('partially_written_off')).toBe('expired_part_written_off');
    expect(expiredStatusFor('submitted')).toBeNull();
    expect(daysUntil('2026-10-20', '2026-09-10')).toBe(40);
  });
});

describe('§15.3 check 1 · paymentReadiness', () => {
  const asOf = '2026-09-10';
  it('passes on a validated PD of the account’s bank, naming it', () => {
    const answer = paymentReadiness([pd()], MAP, { asOf, accountBankCode: 'BNK-0002' });
    expect(answer).toMatchObject({ outcome: 'pass', pdId: 'p1' });
    expect(answer.detail).toMatch(/PD 9330 is validated/);
  });

  it('fails with the cause: none, not validated, expired, another bank', () => {
    expect(paymentReadiness([], MAP, { asOf, accountBankCode: null }).detail).toMatch(/No PD is registered/);
    expect(paymentReadiness([pd({ statusCode: 'pre_approved' })], MAP, { asOf, accountBankCode: null }).detail).toMatch(
      /PD 9330 is Pre-approved/,
    );
    expect(paymentReadiness([pd({ expiryDate: '2026-09-09' })], MAP, { asOf, accountBankCode: null }).detail).toMatch(
      /expired on 2026-09-09/,
    );
    const other = paymentReadiness([pd()], MAP, {
      asOf,
      accountBankCode: 'BNK-0001',
      bankName: (code) => (code === 'BNK-0001' ? 'Mansour Bank' : 'Arab Bank'),
    });
    expect(other.outcome).toBe('fail');
    expect(other.detail).toMatch(/registered with Arab Bank .* from Mansour Bank/);
  });

  it('a PD with no bank, or an account with no bank, does not fail on the bank', () => {
    expect(paymentReadiness([pd({ bankCode: null })], MAP, { asOf, accountBankCode: 'BNK-0001' }).outcome).toBe('pass');
    expect(paymentReadiness([pd()], MAP, { asOf, accountBankCode: null }).outcome).toBe('pass');
  });
});

describe('§21.8 · parseAsycudaList', () => {
  it('reads tabs, commas, runs of spaces and single spaces; ASYCUDA spellings; dates both ways', () => {
    const { rows, unreadable } = parseAsycudaList(
      [
        'PD No\tStatus',
        '9330\tValidated\t08/09/2026',
        '9331  Submited',
        '9332, Partially Written Off, 2026-09-20',
        'ab-12 Totally Written Off',
        '',
        '9333 Mislaid',
      ].join('\n'),
      STATUSES,
    );
    expect(rows).toEqual([
      { line: 2, pdNo: '9330', statusCode: 'validated', effectiveDate: '2026-09-08' },
      { line: 3, pdNo: '9331', statusCode: 'submitted', effectiveDate: null },
      { line: 4, pdNo: '9332', statusCode: 'partially_written_off', effectiveDate: '2026-09-20' },
      { line: 5, pdNo: 'AB-12', statusCode: 'totally_written_off', effectiveDate: null },
    ]);
    expect(unreadable.map((row) => [row.line, row.why])).toEqual([
      [1, 'needs a PD number and then a status'],
      [7, '"Mislaid" is not a PD status'],
    ]);
  });
});
