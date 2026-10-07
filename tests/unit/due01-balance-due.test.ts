/**
 * The balance's due date, once the SWIFT is in — by direction 2026-10-07:
 * "don't show the due date until we get the SWIFT … once the payment
 * application is done, clicking the import application, a dialog comes up:
 * enter the due date, and it marks it".
 *
 * The pure half: what counts as a due date, when the import asks, what it
 * sets the date on, what it refuses — and that a payment run never takes an
 * invoice with no due date as due. Pure: no database, no clock.
 */
import { describe, expect, it } from 'vitest';
import {
  importDueDate,
  knownDueDate,
  owedOn,
  promptState,
  refusalFor,
  waitsForDueDate,
  type ImportInvoiceFacts,
  type PaidApplication,
} from '@/server/domain/balance-due';
import { classify, type Candidate } from '@domain/payment-run';

const SET = new Date('2026-10-07T09:00:00Z');

function invoice(overrides: Partial<ImportInvoiceFacts> = {}): ImportInvoiceFacts {
  return {
    id: 'i1',
    invoiceNo: 'PUR-HQ-2026-000001',
    invoiceDate: '2026-09-01',
    status: 'posted',
    dueDate: '2026-09-01',
    dueDateSetAt: null,
    totalIqd: '1000000.0000',
    settledAmountIqd: '200000.0000',
    ...overrides,
  };
}

function application(overrides: Partial<PaidApplication> = {}): PaidApplication {
  return { applicationNo: 'PAY-HQ-2026-000001', status: 'confirmed', confirmedOn: '2026-09-12', amountTxn: '200000.0000', currency: 'IQD', ...overrides };
}

describe('DUE1 · a due date is a date only once somebody set it', () => {
  it('the column default is no due date; a stamped one is', () => {
    expect(knownDueDate('2026-09-01', null)).toBeNull();
    expect(knownDueDate('2026-11-30', SET)).toBe('2026-11-30');
    expect(knownDueDate('2026-11-30', '2026-10-07T09:00:00Z')).toBe('2026-11-30');
  });

  it('a posted invoice still owing with no date waits for one; paid, reversed or set does not', () => {
    expect(waitsForDueDate(invoice())).toBe(true);
    expect(waitsForDueDate(invoice({ status: 'partially_executed' }))).toBe(true);
    expect(waitsForDueDate(invoice({ dueDateSetAt: SET }))).toBe(false);
    expect(waitsForDueDate(invoice({ settledAmountIqd: '1000000.0000' }))).toBe(false);
    expect(waitsForDueDate(invoice({ status: 'settled' }))).toBe(false);
    expect(waitsForDueDate(invoice({ status: 'reversed' }))).toBe(false);
    expect(waitsForDueDate(invoice({ status: 'draft' }))).toBe(false);
    expect(owedOn(invoice())).toBe(8_000_000_000n);
    expect(owedOn(invoice({ settledAmountIqd: '1000001.0000' }))).toBe(0n);
  });

  it("the import application's due date is its invoices': none until one was set, its own once one was", () => {
    // Opened by its invoice, which gave it the entry day: no due date yet, and waiting.
    expect(importDueDate('2026-09-01', [invoice()])).toEqual({ date: null, waiting: true });
    // Set on the invoice (and so on the import): the import's date.
    expect(importDueDate('2026-11-30', [invoice({ dueDate: '2026-11-30', dueDateSetAt: SET })])).toEqual({ date: '2026-11-30', waiting: false });
    // A reversed invoice does not count; an import raised on its own keeps what was typed on it.
    expect(importDueDate('2026-12-15', [invoice({ status: 'reversed' })])).toEqual({ date: '2026-12-15', waiting: false });
    expect(importDueDate(null, [])).toEqual({ date: null, waiting: false });
  });
});

describe('DUE2 · the import asks once its SWIFT is in', () => {
  it('nothing is asked before a payment application is paid', () => {
    const before = promptState({ applications: [application({ status: 'sent' })], invoices: [invoice()], maySet: true, open: true });
    expect(before).toMatchObject({ due: false, ask: false, paid: null });
    expect(before.waiting.map((one) => one.invoiceNo)).toEqual(['PUR-HQ-2026-000001']);
  });

  it('paid, owing, no date, and the grant: it asks, for what is owed on the invoices without a date', () => {
    const state = promptState({
      applications: [application(), application({ applicationNo: 'PAY-HQ-2026-000002', status: 'debited', confirmedOn: '2026-09-20' })],
      invoices: [invoice(), invoice({ id: 'i2', invoiceNo: 'PUR-HQ-2026-000002', invoiceDate: '2026-09-05', settledAmountIqd: '0.0000' }), invoice({ id: 'i3', invoiceNo: 'PUR-HQ-2026-000003', dueDateSetAt: SET })],
      maySet: true,
      open: true,
    });
    expect(state).toMatchObject({ due: true, ask: true, earliest: '2026-09-05' });
    // The latest paid application is the one the dialog names.
    expect(state.paid?.applicationNo).toBe('PAY-HQ-2026-000002');
    expect(state.waiting.map((one) => one.invoiceNo)).toEqual(['PUR-HQ-2026-000001', 'PUR-HQ-2026-000002']);
    expect(state.owedIqd).toBe(8_000_000_000n + 10_000_000_000n);
  });

  it('without the grant it is due but not asked ("Waiting for the due date"); a closed import asks nobody', () => {
    expect(promptState({ applications: [application()], invoices: [invoice()], maySet: false, open: true })).toMatchObject({ due: true, ask: false });
    expect(promptState({ applications: [application()], invoices: [invoice()], maySet: true, open: false })).toMatchObject({ due: false, ask: false });
  });

  it('once every invoice has its date (or is paid) the question is gone', () => {
    expect(promptState({ applications: [application()], invoices: [invoice({ dueDateSetAt: SET })], maySet: true, open: true })).toMatchObject({ due: false, ask: false });
    expect(promptState({ applications: [application()], invoices: [invoice({ status: 'settled', settledAmountIqd: '1000000.0000' })], maySet: true, open: true })).toMatchObject({ due: false });
  });
});

describe('DUE3 · the dialog refuses a date before an invoice of its own', () => {
  it('names the invoice; a non-date is refused as such; a date on or after every invoice passes', () => {
    const waiting = [invoice(), invoice({ invoiceNo: 'PUR-HQ-2026-000002', invoiceDate: '2026-09-05' })];
    expect(refusalFor('2026-09-03', waiting)).toEqual({ code: 'before_invoice', invoiceNo: 'PUR-HQ-2026-000002', invoiceDate: '2026-09-05' });
    expect(refusalFor('2026-08-31', waiting)).toMatchObject({ code: 'before_invoice', invoiceNo: 'PUR-HQ-2026-000001' });
    expect(refusalFor('soon', waiting)).toEqual({ code: 'not_a_date' });
    expect(refusalFor('', waiting)).toEqual({ code: 'not_a_date' });
    expect(refusalFor('2026-09-05', waiting)).toBeNull();
    expect(refusalFor('2026-12-31', waiting)).toBeNull();
  });
});

describe('DUE4 · a payment run never takes an invoice with no due date as due', () => {
  const candidate = (overrides: Partial<Candidate> = {}): Candidate => ({
    reference: 'PUR-HQ-2026-000001',
    supplierCode: 'SUP-001',
    outstandingIqd: 8_000_000_000n,
    dueDate: '2026-09-01',
    currency: 'IQD',
    priority: 5,
    documentStatus: 'posted',
    supplierStatus: 'active',
    hasPayableBankDetails: true,
    ...overrides,
  });

  it('not due on any pay date until it is set; set, it is due as before', () => {
    const unset = classify(candidate({ dueDateSet: false }), '2026-12-31', 'IQD');
    expect(unset.inclusion).toBe('excluded_not_due');
    expect(unset.reason).toMatch(/has no due date yet: it is set once the SWIFT for its advance is received/);
    expect(classify(candidate({ dueDateSet: true }), '2026-12-31', 'IQD').inclusion).toBe('selected');
    // Left out, the date is a real one (every other candidate, advances included).
    expect(classify(candidate(), '2026-12-31', 'IQD').inclusion).toBe('selected');
  });
});
