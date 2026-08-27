/**
 * Exchange rate service — Phase 02.3.
 *
 * §14.3 — "Exchange rate cannot be edited inside Journal Entry. Rates are
 * maintained only in the Finance Exchange Rate section."
 *
 * So there are exactly two operations: publish a rate here, and *resolve* one
 * by date everywhere else. Nothing in the system accepts a rate as input on a
 * transaction, which is what makes §22's "a reprint reproduces" achievable
 * rather than aspirational.
 */
import { and, asc, desc, eq, isNull, lte } from 'drizzle-orm';
import {
  identityRate,
  LEDGER_RATE_TYPE,
  NoRateForDateError,
  parseRate,
  type PublishedRate,
  type RateType,
} from '../domain/exchange-rates';
import { currency as currencyCode_, LEDGER_CURRENCY, REPORTING_CURRENCY, toIqd, toUsd } from '../domain/money';
import { currency as currencyTable, exchangeRate } from '../db/schema';
import type { Tx } from '../db/client';
import type { ActorContext } from './chart-of-accounts';
import * as audit from './audit';
import * as authz from './authorization';

export const PERMISSION_OBJECT = 'exchange_rate';

export class RateSupersessionError extends Error {
  readonly code = 'RATE_SUPERSESSION_INVALID';
  constructor(detail: string) {
    super(detail);
    this.name = 'RateSupersessionError';
  }
}

export interface PublishRateInput {
  readonly currency: string;
  readonly rateType?: RateType;
  /** Decimal string, IQD per one unit of the currency. */
  readonly iqdPerUnit: string;
  readonly effectiveFrom: string;
  readonly source?: string | null;
  /** Set when correcting an earlier rate: the old row is superseded, not edited. */
  readonly supersedes?: string | null;
}

/**
 * Publishes a rate.
 *
 * Correcting a rate supersedes the earlier row rather than editing it. A
 * posting that already used the old rate keeps pointing at a row that still
 * says what it said at the time — which is the difference between an audit
 * trail and a story.
 */
export async function publishRate(
  tx: Tx,
  ctx: ActorContext,
  input: PublishRateInput,
): Promise<{ id: string }> {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
    requestId: ctx.requestId ?? null,
  });

  // Parsed through the domain so an unusable value is refused before it is
  // stored, with the same rule the ledger uses.
  const scaled = parseRate(input.iqdPerUnit);
  const rateType = input.rateType ?? LEDGER_RATE_TYPE;

  // Retire the old rate *before* inserting the new one. A correction usually
  // carries the same effective date, and only one rate per currency, type and
  // date may be live — so if the order were reversed the two would collide on
  // that index and a legitimate correction would look like a duplicate.
  if (input.supersedes) {
    const [superseded] = await tx
      .select()
      .from(exchangeRate)
      .where(eq(exchangeRate.id, input.supersedes))
      .limit(1);

    if (!superseded) {
      throw new RateSupersessionError(`No exchange rate with id '${input.supersedes}' to supersede.`);
    }
    if (superseded.supersededAt) {
      throw new RateSupersessionError('That rate has already been superseded.');
    }

    await tx
      .update(exchangeRate)
      .set({ supersededAt: new Date() })
      .where(eq(exchangeRate.id, input.supersedes));
  }

  const [created] = await tx
    .insert(exchangeRate)
    .values({
      currencyCode: input.currency,
      rateType,
      iqdPerUnit: input.iqdPerUnit,
      effectiveFrom: input.effectiveFrom,
      source: input.source ?? null,
      enteredBy: ctx.principal.userId,
    })
    .returning({ id: exchangeRate.id });

  if (input.supersedes) {
    // Now the replacement exists, the retired row can point at it.
    await tx
      .update(exchangeRate)
      .set({ supersededBy: created!.id })
      .where(eq(exchangeRate.id, input.supersedes));
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'exchange_rate.published',
    objectType: PERMISSION_OBJECT,
    objectId: created!.id,
    branchCode: ctx.branchCode,
    after: {
      currency: input.currency,
      rateType,
      iqdPerUnit: input.iqdPerUnit,
      effectiveFrom: input.effectiveFrom,
      source: input.source ?? null,
      supersedes: input.supersedes ?? null,
    },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });

  // Referenced so the scaled value is validated even when the caller only
  // supplies a string; a rate that cannot be parsed must not reach the table.
  void scaled;

  return { id: created!.id };
}

/**
 * A resolved rate. `id` is the row that answered — null for the ledger
 * currency, which converts at one and has no row to point at.
 */
export type ResolvedRate = PublishedRate & { id: string | null };

/**
 * The rate to use on a date — the latest effective on or before it, and
 * failing that the earliest published.
 *
 * Superseded rows are excluded throughout. The first clause is the accounting
 * rule: a later effective date does not disturb an earlier one, so re-running
 * last month's report after this month's rate is published gives the same
 * figures (§14.8). The second exists because refusing a date that precedes
 * every published rate was refusing *work* — back-dating an entry a day past
 * the first rate ever entered stopped it dead. The nearest rate values it, and
 * the line records which row that was.
 *
 * IQD short-circuits: IQD per one IQD is one, by definition, and no row is
 * needed to say so. Requiring one is what made an ordinary dinar journal fail
 * with "there is no IQD rate covering ...".
 */
export async function rateOn(
  tx: Tx,
  currencyCode: string,
  onDate: string,
  rateType: RateType = LEDGER_RATE_TYPE,
): Promise<ResolvedRate> {
  if (currencyCode === LEDGER_CURRENCY) {
    return { id: null, ...identityRate(currencyCode) };
  }

  const live = and(
    eq(exchangeRate.currencyCode, currencyCode),
    eq(exchangeRate.rateType, rateType),
    isNull(exchangeRate.supersededAt),
  );

  const [inForce] = await tx
    .select()
    .from(exchangeRate)
    .where(and(live, lte(exchangeRate.effectiveFrom, onDate)))
    .orderBy(desc(exchangeRate.effectiveFrom))
    .limit(1);

  // Nothing on or before the date — reach forward to the earliest there is.
  const [row] = inForce
    ? [inForce]
    : await tx
        .select()
        .from(exchangeRate)
        .where(live)
        .orderBy(asc(exchangeRate.effectiveFrom))
        .limit(1);

  if (!row) throw new NoRateForDateError(currencyCode, rateType, onDate);

  return {
    id: row.id,
    currency: row.currencyCode,
    rateType: row.rateType,
    iqdPerUnit: parseRate(row.iqdPerUnit),
    effectiveFrom: row.effectiveFrom,
    source: row.source,
  };
}

/** The four-part money tuple §24 requires, resolved from a date. */
export interface ConvertedAmount {
  /** Scaled by MONEY_SCALE. */
  readonly amountTxn: bigint;
  readonly currency: string;
  readonly amountIqd: bigint;
  readonly amountUsd: bigint;
  /**
   * The rate rows used, so the posting can point at them forever. Null for
   * the ledger currency, which converts at one and has no row.
   */
  readonly txnRateId: string | null;
  readonly usdRateId: string | null;
}

/**
 * Converts a transaction amount into the ledger and reporting currencies.
 *
 * The caller supplies an amount, a currency and a **date** — never a rate.
 * §1.1: IQD is the ledger currency and USD is a reporting equivalent at the
 * historical rate, so both are derived here and neither is typed by anyone.
 */
export async function convertOn(
  tx: Tx,
  amountTxn: bigint,
  currencyCode: string,
  onDate: string,
): Promise<ConvertedAmount> {
  const txnRate = await rateOn(tx, currencyCode, onDate);
  const amountIqd = toIqd(amountTxn, txnRate.iqdPerUnit);

  const usdRate =
    currencyCode === REPORTING_CURRENCY
      ? txnRate
      : await rateOn(tx, REPORTING_CURRENCY, onDate);

  return {
    amountTxn,
    currency: currencyCode,
    amountIqd,
    amountUsd: toUsd(amountIqd, usdRate.iqdPerUnit),
    txnRateId: txnRate.id,
    usdRateId: usdRate.id,
  };
}

/** The currencies Finance has configured (§4.3). */
export async function currencies(tx: Tx) {
  return tx.select().from(currencyTable).orderBy(desc(currencyTable.isLedger));
}

/** §1.1 — there is exactly one, and it is IQD. */
export async function ledgerCurrency(tx: Tx): Promise<string> {
  const [row] = await tx
    .select({ code: currencyTable.code })
    .from(currencyTable)
    .where(eq(currencyTable.isLedger, true))
    .limit(1);

  return row?.code ?? LEDGER_CURRENCY;
}

/**
 * Adds a currency to the master — §4.3.
 *
 * This is what stood between the company and a euro rate: the rate dialog
 * offered a fixed constant list, but a published rate points at the currency
 * *table*, so any code without a row failed on the way in. The master is now
 * fed here, and everything downstream — the rate dialog, an account's
 * currency restriction, a journal line's currency — reads the table.
 *
 * Same permission as publishing a rate: it is the same screen, maintained by
 * the same people, and a second permission object would be a second thing to
 * grant for one job.
 */
export async function createCurrency(
  tx: Tx,
  ctx: ActorContext,
  input: { readonly code: string; readonly name: string; readonly decimals?: number },
): Promise<void> {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
    requestId: ctx.requestId ?? null,
  });

  // The domain's shape rule, so the refusal names the rule rather than a
  // constraint. The ledger currency exists from Phase 0 and is not repeatable.
  const code = currencyCode_(input.code.trim().toUpperCase());
  const decimals = input.decimals ?? 2;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 6) {
    throw new RangeError('Decimals must be a whole number between 0 and 6.');
  }

  await tx
    .insert(currencyTable)
    .values({ code, name: input.name.trim(), decimals, isLedger: false, isActive: true });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'currency.created',
    objectType: 'currency',
    objectId: code,
    branchCode: ctx.branchCode,
    after: { code, name: input.name.trim(), decimals },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

/**
 * Retires or restores a currency.
 *
 * Retired means "no new lines": history keeps every posting it ever made.
 * The ledger currency cannot be retired (§1.1), and neither can the
 * reporting currency — every posting still needs its USD equivalent.
 */
export async function setCurrencyActive(
  tx: Tx,
  ctx: ActorContext,
  code: string,
  active: boolean,
): Promise<void> {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
    requestId: ctx.requestId ?? null,
  });

  if (!active && (code === LEDGER_CURRENCY || code === REPORTING_CURRENCY)) {
    throw new Error(`${code} cannot be retired: every posting is measured in it.`);
  }

  await tx.update(currencyTable).set({ isActive: active }).where(eq(currencyTable.code, code));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: active ? 'currency.reactivated' : 'currency.retired',
    objectType: 'currency',
    objectId: code,
    branchCode: ctx.branchCode,
    after: { isActive: active },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}
