/**
 * Record notes (2026-10-04) — one way for every record: an append-only audit
 * event `<object>.note_added`, `after: { note }`, read back newest first. The
 * PD's notes from before (`customs_pd.note_added`) and the purchase
 * invoice's are read as they were written.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { appPool, ownerPool, rejection, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as ap from '@/server/services/ap-invoice';
import * as customs from '@/server/services/customs-pd';
import * as expenses from '@/server/services/expenses';
import * as notes from '@/server/services/record-notes';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseDecimal } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';
import { BAGHDAD, PANEL, WAREHOUSE, buildTradingWorld, scope, type TradingWorld } from './trading-fixture';

const ERBIL = 'ERB';
let world: TradingWorld;
let journalId: string;
let serial = 0;

async function userWith(role: string | null): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,'Nobody Special')`, [id, `${id}@example.com`]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, BAGHDAD]);
  if (role) await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: BAGHDAD };
}

async function draftJournal(branchCode: string): Promise<string> {
  const { rows: periods } = await ownerPool.query(
    `select id from fiscal_period where starts_on <= '2026-09-01' and ends_on >= '2026-09-01' limit 1`,
  );
  const { rows } = await ownerPool.query(
    `insert into journal_entry (entry_no, document_date, posting_date, fiscal_period_id, branch_code, description,
        status, total_debit_iqd, total_credit_iqd, created_by)
     values ($1,'2026-09-01','2026-09-01',$2,$3,'Accrual','draft',0,0,$4) returning id`,
    [`JE-NOTES-${(serial += 1)}`, periods[0].id, branchCode, world.manager.principal.userId],
  );
  return rows[0].id as string;
}

const add = (ctx: ActorContext, object: string, recordId: string, body: string) =>
  withScope(scope(ctx), (tx) => notes.addNote(tx, ctx, { object, recordId, body }));
const list = (ctx: ActorContext, object: string, recordId: string) =>
  withScope(scope(ctx), (tx) => notes.listNotes(tx, { object, recordId }));

beforeEach(async () => {
  world = await buildTradingWorld();
  await seedBranch(ERBIL, 'Erbil');
  journalId = await draftJournal(BAGHDAD);
});

describe('record notes', () => {
  it('adds notes and lists them newest first, signed and dated', async () => {
    await add(world.clerk, 'journal_entry', journalId, '  Waiting for the landlord’s invoice  ');
    await add(world.manager, 'journal_entry', journalId, 'Landlord pays Monday');

    const read = await list(world.clerk, 'journal_entry', journalId);
    expect(read.map((n) => n.body)).toEqual(['Landlord pays Monday', 'Waiting for the landlord’s invoice']);
    expect(read.every((n) => n.author === 'Test User')).toBe(true);
    expect(read.every((n) => !Number.isNaN(Date.parse(n.createdAt)))).toBe(true);
    expect(Date.parse(read[0]!.createdAt)).toBeGreaterThanOrEqual(Date.parse(read[1]!.createdAt));
    // Another record's notes are not this one's.
    expect(await list(world.clerk, 'journal_entry', await draftJournal(BAGHDAD))).toEqual([]);
  });

  it('writes the note as the record’s own audit event', async () => {
    await add(world.clerk, 'journal_entry', journalId, 'Check the rate before posting');
    const { rows } = await ownerPool.query(
      `select action, object_type, object_id, branch_code, actor_user_id, after_value, outcome
         from audit_event where action like '%.note_added'`,
    );
    expect(rows).toEqual([
      {
        action: 'journal_entry.note_added',
        object_type: 'journal_entry',
        object_id: journalId,
        branch_code: BAGHDAD,
        actor_user_id: world.clerk.principal.userId,
        after_value: { note: 'Check the rate before posting' },
        outcome: 'success',
      },
    ]);
  });

  it('refuses a note that says nothing, or too much', async () => {
    expect(await rejection(add(world.clerk, 'journal_entry', journalId, '   '))).toMatch(/says something/);
    expect(await rejection(add(world.clerk, 'journal_entry', journalId, 'x'.repeat(notes.NOTE_MAX_LENGTH + 1)))).toMatch(
      /at most 2,000 characters/,
    );
    await add(world.clerk, 'journal_entry', journalId, 'x'.repeat(notes.NOTE_MAX_LENGTH));
    expect(await list(world.clerk, 'journal_entry', journalId)).toHaveLength(1);
  });

  it('is append-only: a note cannot be edited or removed, by the application or the owner', async () => {
    await add(world.clerk, 'journal_entry', journalId, 'First thought');
    const { rows } = await ownerPool.query(`select id from audit_event where action = 'journal_entry.note_added'`);
    const id = rows[0].id as string;

    const app = await appPool.connect();
    try {
      await app.query('begin');
      await app.query(`select set_config('app.user_id', $1, true)`, [world.clerk.principal.userId]);
      await app.query(`select set_config('app.branch_code', $1, true)`, [BAGHDAD]);
      expect(await rejection(app.query(`update audit_event set after_value = '{"note":"Second thought"}' where id = $1`, [id]))).toMatch(
        /permission denied|append-only|not allowed/i,
      );
      await app.query('rollback');
    } finally {
      app.release();
    }
    expect(await rejection(ownerPool.query(`delete from audit_event where id = $1`, [id]))).toMatch(/append-only|not allowed|cannot/i);
    expect((await list(world.clerk, 'journal_entry', journalId)).map((n) => n.body)).toEqual(['First thought']);
  });

  it('refuses a caller without the record’s grant, and writes the refusal', async () => {
    const reader = await userWith('ceo'); // views journals, never edits one
    expect(await rejection(add(reader, 'journal_entry', journalId, 'I was here'))).toMatch(/not permitted|denied|may not/i);
    const { rows } = await ownerPool.query(
      `select action, object_type from audit_event where actor_user_id = $1 and outcome = 'denied'`,
      [reader.principal.userId],
    );
    expect(rows).toEqual([{ action: 'authorisation.denied', object_type: 'journal_entry' }]);
    expect(notes.mayAddNote(reader.principal, 'journal_entry')).toBe(false);
    expect(notes.mayAddNote(world.clerk.principal, 'journal_entry')).toBe(true);
    expect(await list(world.clerk, 'journal_entry', journalId)).toEqual([]);
  });

  it('refuses a record the caller cannot see, an unknown record and an object that keeps no notes', async () => {
    const erbil = await draftJournal(ERBIL);
    expect(await rejection(add(world.clerk, 'journal_entry', erbil, 'Not my branch'))).toMatch(/No such record/);
    expect(await rejection(add(world.clerk, 'journal_entry', randomUUID(), 'Nothing here'))).toMatch(/No such record/);
    expect(await rejection(add(world.clerk, 'journal_entry', 'not-a-uuid', 'Nothing here'))).toMatch(/No such record/);
    expect(await rejection(add(world.clerk, 'role', 'accounting_officer', 'Hello'))).toMatch(/not kept on this kind/);
    const { rows } = await ownerPool.query(`select count(*)::int as n from audit_event where action like '%.note_added'`);
    expect(rows[0].n).toBe(0);
  });

  it('reads a PD’s notes written before the door existed, and writes new ones the PD’s way', async () => {
    const { rows } = await ownerPool.query(
      `insert into customs_pd (pd_no, branch_code, registration_date, expiry_date, status_date, created_by)
       values ('9330',$1,'2026-09-02','2027-03-01','2026-09-02',$2) returning id`,
      [BAGHDAD, world.clerk.principal.userId],
    );
    const pdId = rows[0].id as string;
    // The PD's own note, as Stage 4 has always written it.
    await withScope(scope(world.clerk), (tx) => customs.addNote(tx, world.clerk, pdId, 'Port file needed urgently'));
    expect((await list(world.clerk, 'customs_pd', pdId)).map((n) => n.body)).toEqual(['Port file needed urgently']);

    // Through the door: the same event, and the PD's last note follows it.
    await add(world.clerk, 'customs_pd', pdId, '3597 needs SWIFT');
    expect((await list(world.clerk, 'customs_pd', pdId)).map((n) => n.body)).toEqual(['3597 needs SWIFT', 'Port file needed urgently']);
    const { rows: pd } = await ownerPool.query(`select last_note from customs_pd where id = $1`, [pdId]);
    expect(pd[0].last_note).toBe('3597 needs SWIFT');
  });

  it('keeps the purchase invoice’s notes where the Overdue list reads them', async () => {
    const made = await withScope(scope(world.clerk), (tx) =>
      ap.create(tx, world.clerk, {
        supplierId: world.supplierId,
        supplierInvoiceNo: 'CSA-NOTE-0001',
        branchCode: BAGHDAD,
        invoiceDate: '2026-09-01',
        dueDate: '2026-11-01',
        lines: [
          {
            itemCode: PANEL,
            description: 'Solar Panel 550W',
            quantity: parseQuantity('1'),
            unitPriceIqd: parseDecimal('10000', 4n),
            uomCode: 'EA',
            isInventory: true,
            warehouseCode: WAREHOUSE,
          },
        ],
      }),
    );
    await add(world.clerk, 'ap_invoice', made.id, 'Landlord travelling, pays Monday');
    expect((await list(world.clerk, 'ap_invoice', made.id)).map((n) => n.body)).toEqual(['Landlord travelling, pays Monday']);
    const table = await withScope(scope(world.clerk), (tx) => expenses.notesOf(tx, made.id));
    expect(table.map((n) => n.note)).toEqual(['Landlord travelling, pays Monday']);
  });
});
