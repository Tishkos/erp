/**
 * Phase 09 domain unit tests — §12.
 *
 * The arithmetic of the money transfer service, tested where it lives: no
 * database, no fixtures, and a hand-worked example the 09.8 gate asks for by
 * name.
 */
import { describe, expect, it } from 'vitest';
import {
  allocateAcrossDeposits,
  batchLinesSumTo,
  BatchOutOfBalanceError,
  calculateMargin,
  clientChargeIqd,
  clientClearingBalance,
  CLIENT_RATE_TYPE,
  depositAvailable,
  grossExchangeSpread,
  InsufficientClientFundsError,
  isFullRefund,
  isKycComplete,
  isTransferEditable,
  officialValueIqd,
  OFFICIAL_RATE_TYPE,
  TRANSFER_STAGE_BY_STATUS,
  transferStageName,
} from '../../src/server/domain/money-transfer';
import { parseDecimal, RATE_SCALE, toDecimalString } from '../../src/server/domain/money';

const iqd = (value: string) => parseDecimal(value, 4n);
const rate = (value: string) => parseDecimal(value, RATE_SCALE);
const show = (value: bigint) => toDecimalString(value, 4n);

/**
 * The worked example every figure below is checked against.
 *
 *   Deposits          5,000,000 + 7,000,000 + 3,000,000 = 15,000,000 IQD
 *   Requested         USD 9,000.00
 *   Official rate     1,450 IQD/USD   (Phase 02's `accounting` rate — §12.2's "official")
 *   Client rate       1,500 IQD/USD   (Phase 02's `client` rate — §12.2's "client")
 *   Transfer sent     13,050,000 IQD  (= 9,000 × 1,450)
 *   Bank charge          25,000 IQD, absorbed by the company
 *
 * Worked by hand:
 *   client charge        9,000 × 1,500 = 13,500,000
 *   official value       9,000 × 1,450 = 13,050,000
 *   gross spread        13,500,000 − 13,050,000 =    450,000
 *   net service margin     450,000 −    25,000  =    425,000
 *   remaining balance   15,000,000 − 13,050,000 −  0 = 1,950,000
 */
const EXAMPLE = {
  deposits: iqd('15000000'),
  requestedUsd: iqd('9000'),
  rates: { officialIqdPerUsd: rate('1450'), clientIqdPerUsd: rate('1500') },
  principal: iqd('13050000'),
  expenses: iqd('25000'),
  expensesChargedToClient: iqd('0'),
};

describe('§12.2 — the two rates', () => {
  it('names the Phase 02 rate types rather than introducing new ones (§14.3)', () => {
    // §14.3: "Rates are maintained only in the Finance Exchange Rate section."
    // Phase 02 already publishes both kinds §12.2 asks for.
    expect(OFFICIAL_RATE_TYPE).toBe('accounting');
    expect(CLIENT_RATE_TYPE).toBe('client');
  });

  it('charges the client at the client rate and values the transfer at the official one', () => {
    expect(show(clientChargeIqd(EXAMPLE.requestedUsd, EXAMPLE.rates))).toBe('13500000.0000');
    expect(show(officialValueIqd(EXAMPLE.requestedUsd, EXAMPLE.rates))).toBe('13050000.0000');
  });
});

describe('09.3 — Gross Exchange Spread computes from the two rates and is reproducible', () => {
  it('is the difference between the two conversions of the requested USD', () => {
    expect(show(grossExchangeSpread(EXAMPLE.requestedUsd, EXAMPLE.rates))).toBe('450000.0000');
  });

  it('reproduces exactly from the two figures on the client statement', () => {
    // The gate's word is "reproducible": a reader with the statement in front of
    // them must be able to redo the sum. That only holds if the spread is the
    // difference of the two amounts shown, which is what this asserts.
    const charge = clientChargeIqd(EXAMPLE.requestedUsd, EXAMPLE.rates);
    const official = officialValueIqd(EXAMPLE.requestedUsd, EXAMPLE.rates);
    expect(grossExchangeSpread(EXAMPLE.requestedUsd, EXAMPLE.rates)).toBe(charge - official);
  });

  it('is zero when the client is quoted the official rate', () => {
    const spread = grossExchangeSpread(EXAMPLE.requestedUsd, {
      officialIqdPerUsd: rate('1450'),
      clientIqdPerUsd: rate('1450'),
    });
    expect(spread).toBe(0n);
  });

  it('is negative when the client was quoted better than official — and says so', () => {
    // Not clamped to zero. A transfer priced below the official rate lost money,
    // and a margin report that hid it would hide the only cases worth finding.
    const spread = grossExchangeSpread(EXAMPLE.requestedUsd, {
      officialIqdPerUsd: rate('1450'),
      clientIqdPerUsd: rate('1400'),
    });
    expect(show(spread)).toBe('-450000.0000');
  });

  it('holds precision on a rate with eight decimal places', () => {
    // Rates are scale 8 (§24's money rules). A float would lose this.
    const spread = grossExchangeSpread(iqd('1'), {
      officialIqdPerUsd: rate('1450.00000001'),
      clientIqdPerUsd: rate('1450.00000002'),
    });
    expect(spread).toBe(0n); // one unit of 1e-8 IQD on one dollar rounds to nothing at scale 4
  });

  it('refuses a negative requested USD equivalent', () => {
    expect(() => grossExchangeSpread(iqd('-1'), EXAMPLE.rates)).toThrow(RangeError);
  });
});

describe('09.8 — all six §12.4 figures against a hand-worked example', () => {
  const margin = calculateMargin({
    totalClientDepositsIqd: EXAMPLE.deposits,
    transferPrincipalIqd: EXAMPLE.principal,
    requestedUsd: EXAMPLE.requestedUsd,
    rates: EXAMPLE.rates,
    directExpensesIqd: EXAMPLE.expenses,
    expensesChargedToClientIqd: EXAMPLE.expensesChargedToClient,
  });

  it('Total Client Deposits', () => {
    expect(show(margin.totalClientDepositsIqd)).toBe('15000000.0000');
  });

  it('Transfer Principal is the IQD amount, not the requested USD (§1.1, 09.4)', () => {
    expect(show(margin.transferPrincipalIqd)).toBe('13050000.0000');
  });

  it('Gross Exchange Spread', () => {
    expect(show(margin.grossExchangeSpreadIqd)).toBe('450000.0000');
  });

  it('Direct Expenses', () => {
    expect(show(margin.directExpensesIqd)).toBe('25000.0000');
  });

  it('Net Service Margin — fees reduce it, and stay visible beside the spread (09.7)', () => {
    expect(show(margin.netServiceMarginIqd)).toBe('425000.0000');
    // "visible separately": the spread is still reported in full.
    expect(show(margin.grossExchangeSpreadIqd)).toBe('450000.0000');
    expect(margin.netServiceMarginIqd).toBe(
      margin.grossExchangeSpreadIqd - margin.directExpensesIqd,
    );
  });

  it('Remaining Client Balance = deposits − principal − expenses charged to the client', () => {
    expect(show(margin.remainingClientBalanceIqd)).toBe('1950000.0000');
    expect(margin.remainingClientBalanceIqd).toBe(
      margin.totalClientDepositsIqd -
        margin.transferPrincipalIqd -
        EXAMPLE.expensesChargedToClient,
    );
  });

  it('a charge borne by the client reduces their remaining balance, not the company margin base', () => {
    // §12.6 makes the distinction load-bearing, so the two expense figures are
    // separate inputs and move different results.
    const charged = calculateMargin({
      totalClientDepositsIqd: EXAMPLE.deposits,
      transferPrincipalIqd: EXAMPLE.principal,
      requestedUsd: EXAMPLE.requestedUsd,
      rates: EXAMPLE.rates,
      directExpensesIqd: EXAMPLE.expenses,
      expensesChargedToClientIqd: EXAMPLE.expenses,
    });

    expect(show(charged.remainingClientBalanceIqd)).toBe('1925000.0000');
    // The net margin is unchanged: the fee still reduces it (09.7), whoever
    // ultimately bore it.
    expect(show(charged.netServiceMarginIqd)).toBe('425000.0000');
  });
});

describe('09.2 / §12.3 — one or several partial deposits', () => {
  const deposits = [
    { id: 'd1', amountIqd: iqd('5000000'), usedIqd: 0n, refundedIqd: 0n },
    { id: 'd2', amountIqd: iqd('7000000'), usedIqd: 0n, refundedIqd: 0n },
    { id: 'd3', amountIqd: iqd('3000000'), usedIqd: 0n, refundedIqd: 0n },
  ];

  it('the clearing balance is the sum of deposits less usage', () => {
    expect(show(clientClearingBalance(deposits))).toBe('15000000.0000');
  });

  it('usage reduces the balance and nothing else does', () => {
    const used = [
      { ...deposits[0]!, usedIqd: iqd('5000000') },
      { ...deposits[1]!, usedIqd: iqd('2000000') },
      deposits[2]!,
    ];
    expect(show(clientClearingBalance(used))).toBe('8000000.0000');
    expect(show(depositAvailable(used[1]!))).toBe('5000000.0000');
  });

  it('allocates oldest deposit first, splitting the one that straddles the amount', () => {
    const applied = allocateAcrossDeposits(deposits, iqd('9000000'));

    expect(applied.map((a) => a.deposit.id)).toEqual(['d1', 'd2']);
    expect(show(applied[0]!.appliedIqd)).toBe('5000000.0000');
    expect(show(applied[1]!.appliedIqd)).toBe('4000000.0000');
  });

  it('skips a deposit already fully consumed', () => {
    const applied = allocateAcrossDeposits(
      [{ ...deposits[0]!, usedIqd: iqd('5000000') }, deposits[1]!],
      iqd('1000000'),
    );
    expect(applied.map((a) => a.deposit.id)).toEqual(['d2']);
  });

  it('refuses to send more than the client deposited (Appendix E — fund segregation)', () => {
    // The shortfall would be funded from other clients' money. That is the
    // failure client-fund segregation exists to prevent, so it is an error and
    // not an overdraft.
    expect(() => allocateAcrossDeposits(deposits, iqd('15000001'))).toThrow(
      InsufficientClientFundsError,
    );
  });

  it('allocating nothing allocates nothing, rather than failing', () => {
    expect(allocateAcrossDeposits(deposits, 0n)).toEqual([]);
  });
});

describe('§12.3 / §12.7 — the edit lock', () => {
  it('is editable while only deposit entries exist', () => {
    expect(isTransferEditable('draft')).toBe(true);
    expect(isTransferEditable('approved')).toBe(true);
  });

  it('is locked from Initiate Transfer onward', () => {
    // §12.3: "After Initiate Transfer creates the transfer entry, the
    // transaction is locked."
    for (const status of ['posted', 'executed', 'settled', 'rejected', 'closed', 'reversed']) {
      expect(isTransferEditable(status)).toBe(false);
    }
  });

  it('locks a status nobody has thought of yet', () => {
    // The rule is stated as an allow-list, so the default for anything new is
    // locked. This is the safe direction for this rule to be wrong in.
    expect(isTransferEditable('some_future_state')).toBe(false);
  });
});

describe('Appendix B — the eight Money Transfer statuses', () => {
  it('maps all eight onto §3.2 shared vocabulary', () => {
    expect(Object.values(TRANSFER_STAGE_BY_STATUS)).toEqual([
      'Draft',
      'Funded',
      'Initiated',
      'Sent',
      'Completed',
      'Returned',
      'Refunded',
      'Reversed',
    ]);
  });

  it('reports a status in the blueprint’s own words', () => {
    expect(transferStageName('posted')).toBe('Initiated');
    expect(transferStageName('rejected')).toBe('Returned');
  });
});

describe('§12.7 acceptance 3 — batch lines sum exactly to the bank execution total', () => {
  it('accepts an exact match', () => {
    expect(batchLinesSumTo(iqd('13075000'), [iqd('13050000'), iqd('25000')])).toBe(true);
  });

  it('refuses a difference of one unit in the last place', () => {
    // "Exactly" is the blueprint's word, and there is no tolerance parameter to
    // widen. One unit of 0.0001 IQD is still unexplained company money.
    expect(batchLinesSumTo(iqd('13075000.0001'), [iqd('13050000'), iqd('25000')])).toBe(false);
  });

  it('reports the difference in the error, both ways round', () => {
    const short = new BatchOutOfBalanceError('BEB-1', iqd('100'), iqd('60'));
    expect(short.message).toContain('40.0000');

    const over = new BatchOutOfBalanceError('BEB-2', iqd('60'), iqd('100'));
    expect(over.message).toContain('-40.0000');
  });
});

describe('§12.6 — the client receives a full refund', () => {
  it('a refund equal to the whole clearing balance is full', () => {
    expect(isFullRefund(iqd('15000000'), iqd('15000000'))).toBe(true);
  });

  it('a refund net of bank charges is not', () => {
    // "The company absorbs all bank charges." Deducting them would charge the
    // client for a transfer that never arrived.
    expect(isFullRefund(iqd('14975000'), iqd('15000000'))).toBe(false);
  });
});

describe('§21 / Appendix E — KYC completeness', () => {
  const complete = { status: 'approved', expiresOn: '2026-12-31', missingDocumentCodes: [] };

  it('an approved, unexpired record with nothing missing is complete', () => {
    expect(isKycComplete(complete, '2026-08-17')).toBe(true);
  });

  it('a record with no expiry stays complete — Compliance sets expiry, not this code', () => {
    expect(isKycComplete({ ...complete, expiresOn: null }, '2030-01-01')).toBe(true);
  });

  it('expires inclusively: a record expiring today still covers today', () => {
    expect(isKycComplete({ ...complete, expiresOn: '2026-08-17' }, '2026-08-17')).toBe(true);
    expect(isKycComplete({ ...complete, expiresOn: '2026-08-16' }, '2026-08-17')).toBe(false);
  });

  it('an unapproved record is not complete, whatever else is true of it', () => {
    expect(isKycComplete({ ...complete, status: 'submitted' }, '2026-08-17')).toBe(false);
    expect(isKycComplete({ ...complete, status: 'rejected' }, '2026-08-17')).toBe(false);
  });

  it('a missing required document makes it incomplete', () => {
    expect(
      isKycComplete({ ...complete, missingDocumentCodes: ['PASSPORT'] }, '2026-08-17'),
    ).toBe(false);
  });
});
