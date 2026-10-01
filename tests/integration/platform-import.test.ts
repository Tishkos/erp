/**
 * Phase 01.11 and Phase 03.9 — the import framework, against a real PostgreSQL
 * instance.
 *
 * The gate that matters most is "Import respects the same permissions and
 * validations as manual entry", and it is the hardest to fake: these tests
 * import through the real Business Partner service and watch the duplicate
 * search, the permission check and the role rule fire exactly as they do for
 * one record typed by hand.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as importer from '@/server/services/import';
import * as partners from '@/server/services/business-partner';
import '@/server/services/import-definitions';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { ImportStateError } from '@domain/import';
import { PermissionDeniedError } from '@domain/permissions';

const BAGHDAD = 'BGW';

let officer: ActorContext;
let manager: ActorContext;

async function createUser(roleCode: string): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [
    id,
    `${id}@example.com`,
    'Test User',
  ]);
  await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [
    id,
    roleCode,
  ]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [
    id,
    BAGHDAD,
  ]);
  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) =>
    authz.loadPrincipal(tx, id),
  );
  return { principal, branchCode: BAGHDAD };
}

const scope = (ctx: ActorContext) => ({ userId: ctx.principal.userId, branchCode: BAGHDAD });

const GOOD_FILE = [
  'source_id,code,legal_name,is_customer,is_supplier,email,phone',
  'LEGACY-1,BP-0001,"Al-Rafidain Trading Co.",yes,no,sales@rafidain.iq,07701234567',
  'LEGACY-2,BP-0002,Baghdad Steel,yes,yes,info@bsteel.iq,07709876543',
].join('\n');

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');
  officer = await createUser('accounting_officer');
  manager = await createUser('accounting_manager');
});

// ---------------------------------------------------------------------------
describe('§5.3 · import is its own permission', () => {
  it('refuses an Officer, who may create one record but not ten thousand', async () => {
    await expect(
      withScope(scope(officer), (tx) =>
        importer.upload(tx, officer, 'business_partner', GOOD_FILE, 'partners.csv'),
      ),
    ).rejects.toThrow(PermissionDeniedError);
  });

  it('accepts the Manager, who holds the import verb', async () => {
    const result = await withScope(scope(manager), (tx) =>
      importer.upload(tx, manager, 'business_partner', GOOD_FILE, 'partners.csv'),
    );
    expect(result.preview.validRows).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe('§4.4 · validation preview and error file', () => {
  it('validates without writing anything', async () => {
    await withScope(scope(manager), (tx) =>
      importer.upload(tx, manager, 'business_partner', GOOD_FILE, 'partners.csv'),
    );

    const { rows } = await ownerPool.query(`select count(*)::int as n from business_partner`);
    expect(rows[0].n).toBe(0);
  });

  it('produces a preview and an error file for a mixed file, and commits nothing', async () => {
    // The 01.11 gate, stated exactly.
    const mixed = [
      'source_id,code,legal_name,is_customer,is_supplier',
      'L-1,BP-0001,Good Partner,yes,no',
      'L-2,BP-0002,,yes,no',
      'L-3,BP-0003,No Role At All,no,no',
    ].join('\n');

    const result = await withScope(scope(manager), (tx) =>
      importer.upload(tx, manager, 'business_partner', mixed, 'mixed.csv'),
    );

    expect(result.preview).toMatchObject({ totalRows: 3, validRows: 1, invalidRows: 2 });
    expect(result.preview.committable).toBe(false);

    expect(result.errorFile).toContain('legal_name is empty and is required');
    expect(result.errorFile).toContain('must be a customer, a supplier, or both');
    expect(result.errorFile.split('\n')).toHaveLength(3); // header + two failures

    const { rows } = await ownerPool.query(`select count(*)::int as n from business_partner`);
    expect(rows[0].n).toBe(0);
  });

  it('refuses to commit a batch with any invalid row', async () => {
    const mixed = [
      'code,legal_name,is_customer',
      'BP-0001,Good Partner,yes',
      'BP-0002,,yes',
    ].join('\n');

    const result = await withScope(scope(manager), (tx) =>
      importer.upload(tx, manager, 'business_partner', mixed, 'mixed.csv'),
    );

    await expect(
      withScope(scope(manager), (tx) => importer.commit(tx, manager, result.batchId)),
    ).rejects.toThrow(ImportStateError);

    const { rows } = await ownerPool.query(`select count(*)::int as n from business_partner`);
    expect(rows[0].n).toBe(0);
  });

  it('fails the whole file when a required column is missing', async () => {
    // Every row would fail for the same reason, and the error file would be the
    // file. Better to say what the header should have been.
    await expect(
      withScope(scope(manager), (tx) =>
        importer.upload(tx, manager, 'business_partner', 'code,name\nBP-1,Acme\n'),
      ),
    ).rejects.toThrow(/missing the column\(s\) legal_name/);
  });
});

// ---------------------------------------------------------------------------
describe('§4.4 · import uses the same validations as manual entry', () => {
  it('runs the duplicate search on import', async () => {
    // The definition calls `createPartner`, so the §4.4 duplicate search runs
    // exactly as it does for one record typed by hand.
    await withScope(scope(officer), (tx) =>
      partners.createPartner(tx, officer, {
        code: 'BP-EXISTING',
        legalName: 'Al-Rafidain Trading Co.',
        isCustomer: true,
      }),
    );

    const result = await withScope(scope(manager), (tx) =>
      importer.upload(tx, manager, 'business_partner', GOOD_FILE, 'partners.csv'),
    );

    // It passes the row-level mapping — a duplicate is not a malformed row —
    // and is caught by the service at commit, which takes the batch with it.
    expect(result.preview.committable).toBe(true);

    const message = await rejection(
      withScope(scope(manager), (tx) => importer.commit(tx, manager, result.batchId)),
    );
    expect(message).toMatch(/looks like an existing partner/i);

    const { rows } = await ownerPool.query(`select count(*)::int as n from business_partner`);
    expect(rows[0].n).toBe(1); // only the one typed by hand
  });

  it('enforces role-specific mandatory fields configured for manual entry', async () => {
    await ownerPool.query(
      `insert into partner_role_required_field (role, field_name) values ('customer','creditLimitIqd')`,
    );

    const result = await withScope(scope(manager), (tx) =>
      importer.upload(tx, manager, 'business_partner', GOOD_FILE, 'partners.csv'),
    );

    const message = await rejection(
      withScope(scope(manager), (tx) => importer.commit(tx, manager, result.batchId)),
    );
    expect(message).toMatch(/must carry creditLimitIqd/);
  });
});

// ---------------------------------------------------------------------------
describe('§4.4 · committing, and rolling back', () => {
  it('commits every row and records what each became (§26)', async () => {
    const result = await withScope(scope(manager), (tx) =>
      importer.upload(tx, manager, 'business_partner', GOOD_FILE, 'partners.csv'),
    );

    const committed = await withScope(scope(manager), (tx) =>
      importer.commit(tx, manager, result.batchId),
    );
    expect(committed.committedRows).toBe(2);

    const { rows } = await ownerPool.query(
      `select code, legal_name from business_partner order by code`,
    );
    expect(rows.map((r) => r.code)).toEqual(['BP-0001', 'BP-0002']);
    expect(rows[0].legal_name).toBe('Al-Rafidain Trading Co.');
  });

  it('keeps the batch id and source id on every row, traceable both ways', async () => {
    const result = await withScope(scope(manager), (tx) =>
      importer.upload(tx, manager, 'business_partner', GOOD_FILE, 'partners.csv'),
    );
    await withScope(scope(manager), (tx) => importer.commit(tx, manager, result.batchId));

    const { rows } = await ownerPool.query(
      `select row_no, source_id, target_id, status from import_row order by row_no`,
    );
    expect(rows.map((r) => r.source_id)).toEqual(['LEGACY-1', 'LEGACY-2']);
    expect(rows.every((r) => r.status === 'committed' && r.target_id !== null)).toBe(true);

    // And from a record back to where it came from.
    const partner = await ownerPool.query(
      `select id from business_partner where code = 'BP-0001'`,
    );
    const provenance = await withScope(scope(manager), (tx) =>
      importer.provenanceOf(tx, partner.rows[0].id),
    );
    expect(provenance).toMatchObject({
      sourceId: 'LEGACY-1',
      definitionKey: 'business_partner',
      fileName: 'partners.csv',
    });
  });

  it('commits all or nothing when a row fails at the service', async () => {
    // The 01.11 gate: a batch can be rolled back completely before final
    // posting — and the cheapest rollback is not having committed.
    const withDuplicateInside = [
      'code,legal_name,is_customer',
      'BP-0001,Good Partner,yes',
      'BP-0002,Good Partner,yes', // duplicate of the row above, by name
    ].join('\n');

    const result = await withScope(scope(manager), (tx) =>
      importer.upload(tx, manager, 'business_partner', withDuplicateInside, 'dupes.csv'),
    );

    await expect(
      withScope(scope(manager), (tx) => importer.commit(tx, manager, result.batchId)),
    ).rejects.toThrow();

    const { rows } = await ownerPool.query(`select count(*)::int as n from business_partner`);
    expect(rows[0].n).toBe(0);

    // The batch stays validated, so the file can be corrected and re-committed.
    const batch = await withScope(scope(manager), (tx) =>
      importer.loadBatch(tx, result.batchId),
    );
    expect(batch.status).toBe('validated');
  });

  it('refuses to commit the same batch twice', async () => {
    const result = await withScope(scope(manager), (tx) =>
      importer.upload(tx, manager, 'business_partner', GOOD_FILE, 'partners.csv'),
    );
    await withScope(scope(manager), (tx) => importer.commit(tx, manager, result.batchId));

    await expect(
      withScope(scope(manager), (tx) => importer.commit(tx, manager, result.batchId)),
    ).rejects.toThrow(/already been committed/);
  });

  it('records a rollback with its reason, keeping the batch as evidence', async () => {
    const result = await withScope(scope(manager), (tx) =>
      importer.upload(tx, manager, 'business_partner', GOOD_FILE, 'partners.csv'),
    );
    await withScope(scope(manager), (tx) => importer.commit(tx, manager, result.batchId));

    await withScope(scope(manager), (tx) =>
      importer.rollback(tx, manager, result.batchId, 'Wrong file — legacy extract superseded'),
    );

    const batch = await withScope(scope(manager), (tx) =>
      importer.loadBatch(tx, result.batchId),
    );
    expect(batch.status).toBe('rolled_back');
    expect(batch.rollbackReason).toBe('Wrong file — legacy extract superseded');
  });

  it('keeps a committed batch, whatever anyone tries', async () => {
    // §26 — it is the record of where those rows came from.
    const result = await withScope(scope(manager), (tx) =>
      importer.upload(tx, manager, 'business_partner', GOOD_FILE, 'partners.csv'),
    );
    await withScope(scope(manager), (tx) => importer.commit(tx, manager, result.batchId));

    expect(
      await rejection(ownerPool.query(`delete from import_batch where id = $1`, [result.batchId])),
    ).toMatch(/cannot be deleted/);

    expect(
      await rejection(
        ownerPool.query(`update import_batch set total_rows = 99 where id = $1`, [result.batchId]),
      ),
    ).toMatch(/cannot be edited/);
  });

  it('audits the upload, the commit and the rollback', async () => {
    const result = await withScope(scope(manager), (tx) =>
      importer.upload(tx, manager, 'business_partner', GOOD_FILE, 'partners.csv'),
    );
    await withScope(scope(manager), (tx) => importer.commit(tx, manager, result.batchId));
    await withScope(scope(manager), (tx) =>
      importer.rollback(tx, manager, result.batchId, 'Superseded'),
    );

    const { rows } = await ownerPool.query(
      `select action from audit_event where object_id = $1 order by id`,
      [result.batchId],
    );
    expect(rows.map((r) => r.action)).toEqual([
      'import.validated',
      'import.committed',
      'import.rolled_back',
    ]);
  });
});
