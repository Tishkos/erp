/**
 * REQ-HR-001 Stage HR-6 — the requests' and documents' rules, with no
 * database.
 *
 * Every kind is asked, sent and decided; a claim is then reimbursed and a
 * letter issued, a trip and another request end at the decision. A claim
 * that names its trip settles what the trip's advance still owes first, and
 * pays only the rest. A document is read against its expiry and the warning
 * limit.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REQUEST_SERIES,
  RequestError,
  assertRequestTransition,
  claimSettlement,
  daysLeft,
  expiryState,
  letterText,
  nextStatuses,
  tripAdvanceFirstMonth,
  wholeDinarsUp,
} from '@/server/domain/hr-requests';
import { parseDecimal } from '@/server/domain/money';
import { POSTING_MAP } from '@/server/domain/posting-map';

const iqd = (value: string) => parseDecimal(value, 4n);
const ROOT = process.cwd();

describe('H11 · the requests', () => {
  it('moves each kind along its own road', () => {
    expect(nextStatuses('expense_claim', 'approved')).toEqual(['paid', 'cancelled']);
    expect(nextStatuses('letter', 'approved')).toEqual(['issued', 'cancelled']);
    expect(nextStatuses('travel', 'approved')).toEqual([]);
    expect(nextStatuses('other', 'submitted')).toEqual(['approved', 'refused', 'cancelled']);
    expect(() => assertRequestTransition('TRV-1', 'travel', 'approved', 'paid')).toThrow(/cannot become paid/);
    expect(() => assertRequestTransition('ECLM-1', 'expense_claim', 'draft', 'approved')).toThrow(RequestError);
    expect(() => assertRequestTransition('LTR-1', 'letter', 'issued', 'cancelled')).toThrow(RequestError);
  });

  it('numbers each kind in its own series', () => {
    expect(REQUEST_SERIES).toEqual({ expense_claim: 'EXPENSE_CLAIM', travel: 'TRAVEL_REQUEST', letter: 'HR_LETTER', other: 'EMPLOYEE_REQUEST' });
    const migration = readFileSync(join(ROOT, 'src/server/db/migrations/0265_hr_requests.sql'), 'utf8');
    for (const [key, prefix] of [
      ['EXPENSE_CLAIM', 'ECLM'],
      ['TRAVEL_REQUEST', 'TRV'],
      ['HR_LETTER', 'LTR'],
      ['EMPLOYEE_REQUEST', 'ERQ'],
      ['EMPLOYEE_DOCUMENT', 'EDOC'],
    ])
      expect(migration).toContain(`('${key}', '${prefix}'`);
  });

  it('settles the trip’s advance from the claim first, and pays only the rest', () => {
    expect(claimSettlement(iqd('300000'), iqd('250001'))).toEqual({ offset: iqd('250001'), cash: iqd('49999') });
    expect(claimSettlement(iqd('100000'), iqd('250001'))).toEqual({ offset: iqd('100000'), cash: 0n });
    expect(claimSettlement(iqd('100000'), 0n)).toEqual({ offset: 0n, cash: iqd('100000') });
    expect(claimSettlement(iqd('100000'), iqd('-5'))).toEqual({ offset: 0n, cash: iqd('100000') });
    expect(() => claimSettlement(0n, 0n)).toThrow(/claim of nothing/);
  });

  it('advances a trip in whole dinars, recovered from pay from the second month after it unless a claim settles it', () => {
    expect(wholeDinarsUp(iqd('250000.5'))).toBe(iqd('250001'));
    expect(wholeDinarsUp(iqd('250000'))).toBe(iqd('250000'));
    expect(tripAdvanceFirstMonth('2026-09-15')).toBe('2026-11-01');
    expect(tripAdvanceFirstMonth('2026-11-30')).toBe('2027-01-01');
    expect(tripAdvanceFirstMonth('2026-12-01')).toBe('2027-02-01');
  });

  it('offers a letter composed from the employee record', () => {
    const facts = { fullName: 'Karim Saleh', employeeNo: 'EMP-1', position: 'Accountant', department: 'Finance', hireDate: '2025-01-01', endDate: '2026-06-30', addressedTo: null, company: 'Qimah' };
    expect(letterText('employment', facts)).toBe('To whom it may concern,\n\nThis is to certify that Karim Saleh (EMP-1) has been employed by Qimah since 2025-01-01 and works as Accountant, Finance.\n\nThis letter is issued at their request.');
    expect(letterText('experience', { ...facts, addressedTo: 'Rafidain Bank' })).toMatch(/^Rafidain Bank,\n\n.*from 2025-01-01 to 2026-06-30 as Accountant, Finance\./);
  });

  it('posts a reimbursed claim to the expense, the advance it settles and the account it left', () => {
    const claim = POSTING_MAP.find((d) => d.event === 'hr.expense_claim')!;
    expect(claim.lines.map((l) => [l.role, l.side, l.always])).toEqual([
      ['employee_expense', 'debit', true],
      ['employee_advance', 'credit', false],
    ]);
  });
});

describe('H12 · the documents', () => {
  it('reads an expiry against the day and the warning limit', () => {
    expect(daysLeft('2026-10-23', '2026-10-03')).toBe(20);
    expect(expiryState(null, '2026-10-03', 30)).toBe('no_expiry');
    expect(expiryState('2026-10-23', '2026-10-03', 30)).toBe('expiring');
    expect(expiryState('2026-10-23', '2026-10-03', 10)).toBe('valid');
    expect(expiryState('2026-10-03', '2026-10-03', 0)).toBe('expiring');
    expect(expiryState('2026-10-02', '2026-10-03', 30)).toBe('expired');
  });
});

describe('H8 · requests and documents write their audit with every change', () => {
  for (const file of ['employee-requests.ts', 'employee-documents.ts']) {
    it(`every exported writer in ${file} records the change`, () => {
      const source = readFileSync(join(ROOT, 'src/server/services', file), 'utf8');
      const chunks = source.split(/\nexport async function /).slice(1);
      const offenders: string[] = [];
      for (const chunk of chunks) {
        const body = chunk.split(/\n(?:export |async function |function )/)[0]!;
        const writes = /\.(insert|update|delete)\((employeeRequest|employeeRequestLine|employeeDocument)\)/.test(body);
        // `renew` writes through `create`, which records it, and records the supersession itself.
        if (writes && !/\brecordChange\(/.test(body)) offenders.push(chunk.slice(0, chunk.indexOf('(')));
      }
      expect(offenders).toEqual([]);
      expect(chunks.length).toBeGreaterThanOrEqual(5);
    });
  }

  it('the database holds what the services promise', () => {
    const migration = readFileSync(join(ROOT, 'src/server/db/migrations/0265_hr_requests.sql'), 'utf8');
    for (const name of [
      'employee_request_decider_not_requester',
      'employee_request_guard',
      'employee_request_line_frozen',
      'employee_request_paid_is_claim',
      'employee_request_issued_is_letter',
      'employee_request_refusal_has_note',
      'employee_request_cancel_has_reason',
      'employee_document_withdrawn',
      'employee_document_replaces_uniq',
      'employee_advance_recovery_claim',
    ])
      expect(migration).toContain(name);
    expect(migration).toMatch(/employee_request_scope[\s\S]*app_has_grant\('employee_request', 'view'\)/);
    expect(migration).toMatch(/employee_document_scope[\s\S]*app_is_employee/);
  });
});
