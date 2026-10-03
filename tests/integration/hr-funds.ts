/**
 * REQ-HR-001 — money in a fixture bank or till before HR pays out of it
 * (C-20): the trading world's account funded from its return clearing,
 * through `funds.ts`.
 */
import { fundLedger } from './funds';
import { BAGHDAD, type TradingWorld } from './trading-fixture';

/** The trading world's bank, funded. */
export const fundBank = (world: TradingWorld, amountIqd = '1000000000.0000') => fundAccount(world, world.accounts.bank!, amountIqd);

/** Any bank or cash account's G/L account, funded. */
export const fundAccount = (world: TradingWorld, glAccountId: string, amountIqd: string, on = '2026-01-01'): Promise<void> =>
  fundLedger({ glAccountId, contraAccountId: world.accounts.return_clearing!, amountIqd, branchCode: BAGHDAD, userId: world.manager.principal.userId, on });
