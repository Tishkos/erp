/**
 * REQ-HARDEN-001 HD14 (G1–G3) — the payable record reads in one transaction,
 * with a measured, bounded number of statements.
 *
 * The page opens two sessions: the session lookup (`requireContext`) and one
 * transaction for everything it draws — the attachments and the history used
 * to open a third and a fourth. This counts the statements that transaction
 * sends for an import payable seen by somebody who may do everything, and
 * holds the count under a budget, so a read added later shows up here.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { resetTestData } from './setup';
import { withScope } from '@/server/db/client';
import * as payables from '@/server/services/payables';
import { loadPayableRecord, type PayableRecordInput } from '@/app/(app)/payables/[payableNo]/load';
import { IMPORT_INPUT, buildPayablesWorld, scope, type PayablesWorld } from './payables-fixture';

let world: PayablesWorld;

beforeEach(async () => {
  await resetTestData();
  world = await buildPayablesWorld();
});

const ALL: PayableRecordInput['may'] = { edit: true, pay: true, viewPd: true, registerPd: true, viewShipment: true, createBl: true, viewLoans: true, viewLanded: true, addCharge: true, lock: true };

/** Counts what the transaction sends while `fn` runs — every statement is one round trip to the database. */
async function counted<T>(fn: () => Promise<T>): Promise<{ value: T; statements: string[] }> {
  const statements: string[] = [];
  const original = pg.Client.prototype.query;
  pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
    const first = args[0] as string | { text?: string };
    statements.push(typeof first === 'string' ? first : (first?.text ?? ''));
    return (original as (...a: unknown[]) => unknown).apply(this, args);
  } as typeof pg.Client.prototype.query;
  try {
    return { value: await fn(), statements };
  } finally {
    pg.Client.prototype.query = original;
  }
}

describe('HD14 · the payable record — one transaction, a bounded number of reads', () => {
  it('reads an import payable, its attachments and its history in one transaction under the budget', async () => {
    const made = await withScope(scope(world.manager), (tx) => payables.create(tx, world.manager, IMPORT_INPUT(world)));
    let statements: string[] = [];
    const found = await withScope(scope(world.manager), async (tx) => {
      const run = await counted(() => loadPayableRecord(tx, { payableNo: made.payableNo, laneFilter: null, logSearch: null, logPage: 1, may: ALL }));
      statements = run.statements;
      return run.value;
    });
    expect(found).not.toBeNull();
    // Drawn by the page from this read, not from sessions of their own.
    expect(found!.attachments.rows).toEqual([]);
    expect(found!.history.rows.length).toBeGreaterThan(0);
    // The owners are the active users by id and name — not every user joined to their credentials.
    expect(statements.some((s) => /auth_account/i.test(s))).toBe(false);
    expect(found!.people.length).toBeGreaterThan(0);
    // G3 — one settings table, not eight.
    expect(statements.filter((s) => /from "(payable_type|payable_lane|payable_stage|stage_time_limit|sweep_check|hold_reason_code|expense_category|payable_event_code)" order by/i.test(s))).toEqual([]);
    // The lock's state comes from the facts, charges and locks already read — the stage facts are read once.
    expect(statements.filter((s) => /from "supplier_advance"/i.test(s))).toHaveLength(1);
    // The measured figure, recorded in REQ-HARDEN-001 §3.G: 50 statements in one session on 2026-10-02
    // (about 70 across three sessions before). A read added later has to be paid for here.
    // IM2 (2026-10-03): +1 — the New B/L table reads what is left to ship of each model.
    expect(statements.length).toBeLessThanOrEqual(53);
  });

  it('a reader who may not stop the payable reads neither the reasons nor the owners', async () => {
    const made = await withScope(scope(world.manager), (tx) => payables.create(tx, world.manager, IMPORT_INPUT(world)));
    const found = await withScope(scope(world.officer), (tx) => loadPayableRecord(tx, { payableNo: made.payableNo, laneFilter: null, logSearch: null, logPage: 1, may: { ...ALL, edit: false } }));
    expect(found!.reasons).toEqual([]);
    expect(found!.people).toEqual([]);
  });

  it('a number nobody holds is a 404, not an error', async () => {
    const found = await withScope(scope(world.manager), (tx) => loadPayableRecord(tx, { payableNo: 'IMP-BGW-2026-999999', laneFilter: null, logSearch: null, logPage: 1, may: ALL }));
    expect(found).toBeNull();
  });
});
