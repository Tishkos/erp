/**
 * REQ-LOG-001 item 8 — the customs declaration (0301, Q1 decided by default).
 *
 *   life      Draft → Submitted → Accepted → Assessed → Cleared; or Cancelled /
 *             Rejected with a reason. Forward only; the three ends are final.
 *   words     The declared figures are frozen once it leaves draft — by the
 *             service and by the table; nothing posts, nothing locks.
 *   who       Create / edit / submit with the PD grants; cancel and reject
 *             are the manager's; the other branch cannot see it.
 *   kept      Never deleted; every move is an audit row and an import event.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerPool, rejection } from './setup';
import { withScope } from '@/server/db/client';
import * as declarations from '@/server/services/customs-declarations';
import * as attachments from '@/server/services/attachments';
import * as recordNotes from '@/server/services/record-notes';
import { registerAllRecords } from '@/server/records';
import { buildImportWorld, charge, importOf, iqd, registerPd, scope, type ImportWorld } from './logistics-fixture';

let world: ImportWorld;
let payableId: string;
let pdId: string;

const create = (input: Partial<declarations.CreateInput> = {}) =>
  withScope(scope(world.clerk), (tx) =>
    declarations.create(tx, world.clerk, {
      payableId,
      pdId,
      declarationDate: '2026-08-20',
      currency: 'IQD',
      declaredValue: iqd('5000000'),
      declaredDuty: iqd('250000'),
      declaredTaxes: iqd('50000'),
      declaredFees: iqd('20000'),
      ...input,
    }),
  );
const move = (id: string, to: string, extra: Partial<declarations.MoveInput> = {}, actor = world.clerk) =>
  withScope(scope(actor), (tx) => declarations.move(tx, actor, id, { to, on: '2026-08-21', ...extra }));
const statusOf = async (id: string) => (await ownerPool.query(`select status, customs_ref, reason from customs_declaration where id = $1`, [id])).rows[0];

beforeEach(async () => {
  world = await buildImportWorld();
  ({ payableId } = await importOf(world, '100'));
  pdId = (await registerPd(world, payableId, '7001')).id;
});

describe('life · forward only, one step at a time', () => {
  it('numbers the draft, walks it to cleared, and refuses to skip or to move again', async () => {
    const made = await create();
    expect(made.declarationNo).toBe('CDN-BGW-2026-000001');
    expect((await statusOf(made.id)).status).toBe('draft');

    expect(await rejection(move(made.id, 'accepted'))).toMatch(/from there it goes to submitted, cancelled/);
    expect(await rejection(move(made.id, 'nonsense'))).toMatch(/not a declaration status/);
    await move(made.id, 'submitted');
    expect(await rejection(move(made.id, 'submitted'))).toMatch(/goes to accepted, rejected, cancelled/);
    expect(await rejection(move(made.id, 'accepted'))).toMatch(/Customs gives its own number/);
    await move(made.id, 'accepted', { customsRef: 'BG-1' });
    // A date before the lodgement is refused.
    expect(await rejection(move(made.id, 'assessed', { on: '2026-08-01' }))).toMatch(/before .* was lodged/);
    await move(made.id, 'assessed');
    await move(made.id, 'cleared', { on: '2026-08-25' });
    expect(await statusOf(made.id)).toMatchObject({ status: 'cleared', customs_ref: 'BG-1' });
    expect(await rejection(move(made.id, 'cancelled', { reason: 'Too late' }, world.manager))).toMatch(/does not move again/);

    const view = await withScope(scope(world.clerk), (tx) => declarations.viewByNo(tx, made.declarationNo));
    expect(view.isFinal).toBe(true);
    expect(view.next).toEqual([]);
    expect(view.pd?.pdNo).toBe('7001');
    expect(view.declaredChargesTotal).toBe('320000.0000');

    const { rows: events } = await ownerPool.query(
      `select event_code, source_no from payable_event where payable_id = $1 and event_code like 'DECLARATION%' order by recorded_at, id`,
      [payableId],
    );
    expect(events.map((row) => row.event_code)).toEqual(['DECLARATION_RAISED', 'DECLARATION_MOVED', 'DECLARATION_MOVED', 'DECLARATION_MOVED', 'DECLARATION_CLEARED']);
    expect(events.every((row) => row.source_no === made.declarationNo)).toBe(true);
    const { rows: trail } = await ownerPool.query(
      `select action from audit_event where object_type = 'customs_declaration' and object_id = $1 and outcome = 'success' order by occurred_at, id`,
      [made.id],
    );
    expect(trail.map((row) => row.action)).toEqual([
      'customs_declaration.created',
      'customs_declaration.submitted',
      'customs_declaration.accepted',
      'customs_declaration.assessed',
      'customs_declaration.cleared',
    ]);
  });

  it('ends with a reason — cancelled from any open step, rejected by customs once submitted', async () => {
    const first = await create();
    expect(await rejection(move(first.id, 'cancelled', {}, world.manager))).toMatch(/Say why/);
    expect(await rejection(move(first.id, 'rejected', { reason: 'x' }, world.manager))).toMatch(/goes to submitted, cancelled/);
    await move(first.id, 'cancelled', { reason: 'Raised on the wrong import' }, world.manager);
    expect(await statusOf(first.id)).toMatchObject({ status: 'cancelled', reason: 'Raised on the wrong import' });

    const second = await create();
    await move(second.id, 'submitted');
    await move(second.id, 'rejected', { reason: 'HS code disputed' }, world.manager);
    expect((await statusOf(second.id)).status).toBe('rejected');
    // An ended declaration frees its customs reference for the next one.
    const third = await create({ customsRef: 'BG-DUP' });
    await move(third.id, 'submitted');
    await move(third.id, 'rejected', { reason: 'Again' }, world.manager);
    const fourth = await create({ customsRef: 'BG-DUP' });
    expect((await statusOf(fourth.id)).customs_ref).toBe('BG-DUP');
    // A standing one keeps it unique.
    await move(fourth.id, 'submitted');
    await move(fourth.id, 'accepted');
    expect(await rejection(create({ customsRef: 'BG-DUP' }).then((d) => move(d.id, 'submitted').then(() => move(d.id, 'accepted'))))).toMatch(/duplicate|unique/i);
    // Submitting needs a value.
    const empty = await create({ declaredValue: 0n });
    expect(await rejection(move(empty.id, 'submitted'))).toMatch(/declares no value/);
  });
});

describe('words · the declared figures are the record once it leaves draft', () => {
  it('edits a draft, and refuses the service and the table after submission', async () => {
    const made = await create();
    await withScope(scope(world.clerk), (tx) =>
      declarations.update(tx, world.clerk, made.id, { declaredDuty: iqd('260000'), hsCode: '8541.43', customsRef: 'BG-9', pdId: null }),
    );
    const { rows: [edited] } = await ownerPool.query(`select declared_duty::text as duty, hs_code, customs_ref, pd_id from customs_declaration where id = $1`, [made.id]);
    expect(edited).toEqual({ duty: '260000.0000', hs_code: '8541.43', customs_ref: 'BG-9', pd_id: null });
    expect(await rejection(withScope(scope(world.clerk), (tx) => declarations.update(tx, world.clerk, made.id, { declaredDuty: -1n })))).toMatch(/cannot be negative/);
    expect(await rejection(withScope(scope(world.clerk), (tx) => declarations.update(tx, world.clerk, made.id, { currency: 'dinar' })))).toMatch(/not a currency code/);

    await move(made.id, 'submitted');
    expect(await rejection(withScope(scope(world.clerk), (tx) => declarations.update(tx, world.clerk, made.id, { declaredDuty: iqd('1') })))).toMatch(/what it declared is the record/);
    expect(await rejection(ownerPool.query(`update customs_declaration set declared_value = 1 where id = $1`, [made.id]))).toMatch(/what it declared is the record/);
    expect(await rejection(ownerPool.query(`delete from customs_declaration where id = $1`, [made.id]))).toMatch(/append-only|not allowed|immutable|reject/i);
    // The reference may still be typed on the way (customs gives it at acceptance).
    await move(made.id, 'accepted', { customsRef: 'BG-10' });
    expect((await statusOf(made.id)).customs_ref).toBe('BG-10');
    await move(made.id, 'assessed');
    await move(made.id, 'cleared');
    expect(await rejection(ownerPool.query(`update customs_declaration set status = 'draft' where id = $1`, [made.id]))).toMatch(/does not move again/);
  });

  it('shows declared beside charged, and never posts: the money is the import’s charge', async () => {
    const made = await create();
    const before = await withScope(scope(world.clerk), (tx) => declarations.viewByNo(tx, made.declarationNo));
    expect(before.charged).toMatchObject({ rows: [], totalIqd: '0.0000', lockedIqd: '0.0000', unlockedIqd: '0.0000' });
    expect(before.comparable).toBe(true);
    await charge(world, payableId, 'customs_asycuda', '310000');
    await charge(world, payableId, 'freight', '90000');
    const after = await withScope(scope(world.clerk), (tx) => declarations.viewByNo(tx, made.declarationNo));
    expect(after.charged.rows).toHaveLength(1);
    expect(after.charged.totalIqd).toBe('310000.0000');
    expect(after.declaredChargesTotal).toBe('320000.0000');
    // No journal, no ledger row, no lock from the declaration itself.
    const { rows: journals } = await ownerPool.query(`select count(*)::int as n from journal_entry where description ilike '%declaration%'`);
    expect(journals[0].n).toBe(0);
    const { rows: locks } = await ownerPool.query(`select count(*)::int as n from landed_cost_lock where payable_id = $1`, [payableId]);
    expect(locks[0].n).toBe(0);
    // A declaration in another currency is shown, not compared.
    const usd = await create({ currency: 'USD', declaredValue: iqd('3800'), declaredDuty: iqd('190') });
    expect((await withScope(scope(world.clerk), (tx) => declarations.viewByNo(tx, usd.declarationNo))).comparable).toBe(false);
  });
});

describe('who · the grants, the branch, the doors', () => {
  it('needs an open import of this branch and a PD of the same import', async () => {
    const other = await importOf(world, '10');
    const otherPd = await registerPd(world, other.payableId, '7002');
    expect(await rejection(create({ pdId: otherPd.id }))).toMatch(/belongs to another import/);
    expect(await rejection(create({ payableId: '00000000-0000-0000-0000-000000000000' }))).toMatch(/not found|No payable|outside/i);
    // A reader without the grant is refused and the refusal is written.
    const { rows: [viewer] } = await ownerPool.query(`insert into app_user (id, email, display_name) values (gen_random_uuid(), 'viewer-log01@example.com', 'Viewer') returning id`);
    await ownerPool.query(`insert into user_role (user_id, role_code) values ($1, 'logistics_officer')`, [viewer.id]);
    await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1, 'BGW')`, [viewer.id]);
    const authz = await import('@/server/services/authorization');
    const principal = await withScope({ userId: viewer.id, branchCode: 'BGW' }, (tx) => authz.loadPrincipal(tx, viewer.id));
    const officer = { principal, branchCode: 'BGW' };
    expect(await rejection(withScope(scope(officer), (tx) => declarations.create(tx, officer, { payableId, declaredValue: iqd('1') })))).toMatch(/not permitted|denied|may not/i);
    // But the officer reads the register.
    const made = await create();
    const list = await withScope(scope(officer), (tx) => declarations.listForScreen(tx, { view: 'open' }));
    expect(list.rows.map((row) => row.declarationNo)).toEqual([made.declarationNo]);
    // Only the manager cancels.
    expect(await rejection(move(made.id, 'cancelled', { reason: 'No' }, officer))).toMatch(/not permitted|denied|may not/i);
  });

  it('wears the paperclip and the notes door from the draft', async () => {
    registerAllRecords();
    const made = await create();
    await withScope(scope(world.clerk), (tx) =>
      attachments.upload(tx, world.clerk, { objectType: declarations.PERMISSION_OBJECT, objectId: made.id, fileName: 'lodgement.txt', content: Buffer.from('Customs declaration lodged 2026-08-20.') }),
    );
    const files = await withScope(scope(world.clerk), (tx) => attachments.currentFor(tx, declarations.PERMISSION_OBJECT, made.id));
    expect(files.map((file) => file.fileName)).toEqual(['lodgement.txt']);
    await withScope(scope(world.clerk), (tx) => recordNotes.addNote(tx, world.clerk, { object: declarations.PERMISSION_OBJECT, recordId: made.id, body: 'Broker promised the assessment Thursday.' }));
    const notes = await withScope(scope(world.clerk), (tx) => recordNotes.listNotes(tx, { object: declarations.PERMISSION_OBJECT, recordId: made.id }));
    expect(notes.map((note) => note.body)).toEqual(['Broker promised the assessment Thursday.']);
  });
});
