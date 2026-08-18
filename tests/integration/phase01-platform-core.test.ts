/**
 * Phase 01 — platform core, against a real PostgreSQL instance.
 *
 * Covers the parts of the 01.2, 01.4 and 01.5 test gates that assert a database
 * guarantee. Per TECHSTACK.md B3, these cannot be unit tests: the guarantee
 * under test belongs to the database, so mocking it would prove nothing.
 *
 * The §27 Release 1 acceptance dependency is "Authentication, server-side
 * access and audit tests pass." This file is the second and third of those.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { asApp, appPool, ownerPool, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as audit from '@/server/services/audit';
import * as authz from '@/server/services/authorization';
import {
  UnknownSequenceError,
  allocateDocumentNumber,
  gapsFor,
} from '@/server/services/numbering';
import { PermissionDeniedError, ScopeDeniedError, type PermissionVerb } from '@domain/permissions';

const BAGHDAD = 'BGW';
const BASRA = 'BSR';
const FINANCE = 'FIN';
const SALES = 'SLS';

beforeEach(async () => {
  await resetTestData();

  await seedBranch(BAGHDAD, 'Baghdad');
  await seedBranch(BASRA, 'Basra');
  await ownerPool.query(`insert into department (code, name) values ($1,$2), ($3,$4)`, [
    FINANCE,
    'Finance',
    SALES,
    'Sales',
  ]);
});

interface UserSpec {
  isSuperUser?: boolean;
  isActive?: boolean;
  grants?: Array<[string, PermissionVerb]>;
  branches?: string[];
  departments?: Array<[string, boolean]>;
}

/** Arranged through the owner pool: fixtures are not the thing under test. */
async function createUser(spec: UserSpec = {}): Promise<string> {
  const id = randomUUID();
  const roleCode = `role_${id.slice(0, 8)}`;

  await ownerPool.query(
    `insert into app_user (id, email, display_name, is_super_user, is_active)
     values ($1, $2, $3, $4, $5)`,
    [id, `${id}@example.com`, 'Test User', spec.isSuperUser ?? false, spec.isActive ?? true],
  );

  if (spec.grants?.length) {
    await ownerPool.query(`insert into role (code, name) values ($1, $2)`, [roleCode, roleCode]);
    await ownerPool.query(`insert into user_role (user_id, role_code) values ($1, $2)`, [
      id,
      roleCode,
    ]);
    for (const [object, verb] of spec.grants) {
      await ownerPool.query(
        `insert into role_grant (role_code, object, verb) values ($1, $2, $3)`,
        [roleCode, object, verb],
      );
    }
  }

  for (const branchCode of spec.branches ?? []) {
    await ownerPool.query(
      `insert into user_branch_scope (user_id, branch_code) values ($1, $2)`,
      [id, branchCode],
    );
  }

  for (const [code, isManager] of spec.departments ?? []) {
    await ownerPool.query(
      `insert into user_department_scope (user_id, department_code, is_manager) values ($1,$2,$3)`,
      [id, code, isManager],
    );
  }

  return id;
}

const scopeOf = (userId: string, branchCode = BAGHDAD, isSuperUser = false) => ({
  userId,
  branchCode,
  isSuperUser,
});

// ---------------------------------------------------------------------------
// 01.2 — authorisation
// ---------------------------------------------------------------------------
describe('01.2 · authorisation is server-side and denies by default (§25)', () => {
  it('resolves a user with no role to a principal that can do nothing', async () => {
    const userId = await createUser({ branches: [BAGHDAD] });

    const principal = await withScope(scopeOf(userId), (tx) =>
      authz.loadPrincipal(tx, userId),
    );

    expect(principal.grants).toEqual([]);
    expect(principal.isSuperUser).toBe(false);
    await expect(
      authz.authorize(principal, 'view', 'journal_entry', { branchCode: BAGHDAD }),
    ).rejects.toThrow(PermissionDeniedError);
  });

  it('resolves grants through the roles a user holds', async () => {
    const userId = await createUser({
      grants: [
        ['journal_entry', 'view'],
        ['journal_entry', 'post'],
      ],
      branches: [BAGHDAD],
    });

    const principal = await withScope(scopeOf(userId), (tx) =>
      authz.loadPrincipal(tx, userId),
    );

    expect(principal.grants).toHaveLength(2);
    await expect(
      authz.authorize(principal, 'post', 'journal_entry', { branchCode: BAGHDAD }),
    ).resolves.toBeUndefined();
  });

  it('does not confer export with view, or post with approve', async () => {
    const userId = await createUser({
      grants: [
        ['trial_balance', 'view'],
        ['journal_entry', 'approve'],
      ],
      branches: [BAGHDAD],
    });
    const principal = await withScope(scopeOf(userId), (tx) =>
      authz.loadPrincipal(tx, userId),
    );

    await expect(
      authz.authorize(principal, 'export', 'trial_balance', { branchCode: BAGHDAD }),
    ).rejects.toThrow(PermissionDeniedError);
    await expect(
      authz.authorize(principal, 'post', 'journal_entry', { branchCode: BAGHDAD }),
    ).rejects.toThrow(PermissionDeniedError);
  });

  it('refuses a branch the user is not scoped to, with a distinct error', async () => {
    const userId = await createUser({
      grants: [['journal_entry', 'view']],
      branches: [BAGHDAD],
    });
    const principal = await withScope(scopeOf(userId), (tx) =>
      authz.loadPrincipal(tx, userId),
    );

    await expect(
      authz.authorize(principal, 'view', 'journal_entry', { branchCode: BASRA }),
    ).rejects.toThrow(ScopeDeniedError);
  });

  it('denies a deactivated user even though the grant rows still exist', async () => {
    // §25 requires revocation to be immediate. The grants are still in the
    // database; the principal is simply not allowed to use them.
    const userId = await createUser({
      isActive: false,
      grants: [['journal_entry', 'post']],
      branches: [BAGHDAD],
    });
    const principal = await withScope(scopeOf(userId), (tx) =>
      authz.loadPrincipal(tx, userId),
    );

    expect(principal.grants).toHaveLength(1);
    await expect(
      authz.authorize(principal, 'post', 'journal_entry', { branchCode: BAGHDAD }),
    ).rejects.toThrow(PermissionDeniedError);
  });

  it('carries the per-department manager toggle through from the database', async () => {
    // §5.2 — manager of one department, ordinary user in another.
    const userId = await createUser({
      departments: [
        [FINANCE, true],
        [SALES, false],
      ],
      branches: [BAGHDAD],
    });

    const principal = await withScope(scopeOf(userId), (tx) =>
      authz.loadPrincipal(tx, userId),
    );

    expect(principal.departments).toEqual(
      expect.arrayContaining([
        { code: FINANCE, isManager: true },
        { code: SALES, isManager: false },
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// 01.4 — audit
// ---------------------------------------------------------------------------
describe('01.4 · the audit trail is append-only and transactional (§5.4)', () => {
  it('does not grant UPDATE or DELETE on audit_event to the application role', async () => {
    const { rows } = await ownerPool.query(
      `select privilege_type from information_schema.table_privileges
        where grantee = 'erp_app' and table_name = 'audit_event'`,
    );
    const granted = rows.map((r) => r.privilege_type);

    expect(granted).toContain('SELECT');
    expect(granted).toContain('INSERT');
    expect(granted).not.toContain('UPDATE');
    expect(granted).not.toContain('DELETE');
  });

  it('refuses UPDATE and DELETE on a recorded event, even for the owner role', async () => {
    const userId = await createUser({ branches: [BAGHDAD] });
    await withScope(scopeOf(userId), (tx) =>
      audit.record(tx, {
        actorUserId: userId,
        action: 'journal_entry.created',
        objectType: 'journal_entry',
        objectId: 'JE-000001',
        branchCode: BAGHDAD,
        outcome: 'success',
      }),
    );

    await expect(
      ownerPool.query(`update audit_event set action = 'tampered'`),
    ).rejects.toThrow(/append-only/i);
    await expect(ownerPool.query('delete from audit_event')).rejects.toThrow(/append-only/i);
  });

  it('leaves no audit event behind when the business transaction rolls back', async () => {
    // 01.4 gate: "audit and change commit together or not at all."
    const userId = await createUser({ branches: [BAGHDAD] });

    await expect(
      withScope(scopeOf(userId), async (tx) => {
        await audit.record(tx, {
          actorUserId: userId,
          action: 'journal_entry.created',
          objectType: 'journal_entry',
          objectId: 'JE-PHANTOM',
          branchCode: BAGHDAD,
          outcome: 'success',
        });
        throw new Error('posting failed after the audit write');
      }),
    ).rejects.toThrow('posting failed after the audit write');

    const { rows } = await ownerPool.query(
      `select count(*)::int as n from audit_event where object_id = 'JE-PHANTOM'`,
    );
    expect(rows[0].n).toBe(0);
  });

  it('records a refused request even though that request rolled back', async () => {
    // The two halves of the gate pull against each other, and both must hold:
    // the change is gone, the refusal is kept.
    const userId = await createUser({
      grants: [['journal_entry', 'view']],
      branches: [BAGHDAD],
    });
    const principal = await withScope(scopeOf(userId), (tx) =>
      authz.loadPrincipal(tx, userId),
    );

    await expect(
      withScope(scopeOf(userId), async (tx) => {
        await audit.record(tx, {
          actorUserId: userId,
          action: 'journal_entry.created',
          objectType: 'journal_entry',
          objectId: 'JE-ABANDONED',
          branchCode: BAGHDAD,
          outcome: 'success',
        });
        await authz.authorize(principal, 'post', 'journal_entry', {
          branchCode: BAGHDAD,
          objectId: 'JE-ABANDONED',
          requestId: 'req-42',
        });
      }),
    ).rejects.toThrow(PermissionDeniedError);

    const { rows } = await ownerPool.query(
      `select action, actor_user_id, object_type, object_id, outcome, request_id
         from audit_event order by id`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'authorisation.denied',
      actor_user_id: userId,
      object_type: 'journal_entry',
      object_id: 'JE-ABANDONED',
      outcome: 'denied',
      request_id: 'req-42',
    });
  });

  it('distinguishes a refused verb from a refused branch in the recorded action', async () => {
    const userId = await createUser({
      grants: [['journal_entry', 'view']],
      branches: [BAGHDAD],
    });
    const principal = await withScope(scopeOf(userId), (tx) =>
      authz.loadPrincipal(tx, userId),
    );

    await expect(
      authz.authorize(principal, 'view', 'journal_entry', { branchCode: BASRA }),
    ).rejects.toThrow(ScopeDeniedError);

    const { rows } = await ownerPool.query(`select action, outcome from audit_event`);
    expect(rows[0]).toMatchObject({ action: 'authorisation.scope_denied', outcome: 'denied' });
  });

  it('stores no secret, even when the caller passes one in a snapshot', async () => {
    const userId = await createUser({ branches: [BAGHDAD] });

    await withScope(scopeOf(userId), (tx) =>
      audit.record(tx, {
        actorUserId: userId,
        action: 'user.updated',
        objectType: 'user',
        objectId: userId,
        branchCode: BAGHDAD,
        before: { displayName: 'Ali', passwordHash: '$2b$12$secretvalue' },
        after: { displayName: 'Ali Hassan', apiToken: 'tok_live_do_not_store' },
        sessionId: 'sess_live_identifier',
        outcome: 'success',
      }),
    );

    const { rows } = await ownerPool.query(
      `select before_value, after_value, session_id from audit_event`,
    );
    const serialised = JSON.stringify(rows[0]);

    expect(serialised).not.toContain('secretvalue');
    expect(serialised).not.toContain('tok_live_do_not_store');
    expect(serialised).not.toContain('sess_live_identifier');
    expect(rows[0].before_value.displayName).toBe('Ali');
    expect(rows[0].session_id).toMatch(/^s_[0-9a-f]{16}$/);
  });
});

describe('01.4 · audit row scope is enforced by the database (§22, §25)', () => {
  async function seedEvents(actorId: string) {
    await ownerPool.query(
      `insert into audit_event (actor_user_id, action, object_type, object_id, branch_code, outcome)
       values ($1,'journal_entry.posted','journal_entry','JE-BGW',$2,'success'),
              ($1,'journal_entry.posted','journal_entry','JE-BSR',$3,'success'),
              ($1,'configuration.changed','system','SYS-1',null,'success')`,
      [actorId, BAGHDAD, BASRA],
    );
  }

  it('shows a branch-scoped user only their own branch', async () => {
    const userId = await createUser({ branches: [BAGHDAD] });
    await seedEvents(userId);

    await asApp(scopeOf(userId), async (query) => {
      const { rows } = await query('select object_id from audit_event order by object_id');
      expect(rows.map((r) => r.object_id)).toEqual(['JE-BGW']);
    });
  });

  it('hides another branch even when the row id is known (§25 direct access)', async () => {
    const userId = await createUser({ branches: [BAGHDAD] });
    await seedEvents(userId);

    const { rows: seeded } = await ownerPool.query(
      `select id from audit_event where object_id = 'JE-BSR'`,
    );

    await asApp(scopeOf(userId), async (query) => {
      const { rows } = await query('select object_id from audit_event where id = $1', [
        seeded[0].id,
      ]);
      expect(rows).toHaveLength(0);
    });
  });

  it('keeps administration-wide events for Super Users only', async () => {
    // A configuration change has no branch. Showing it to every branch user
    // would leak the shape of the system; hiding it from everyone would make
    // §25's "configuration changes" logging requirement unreadable.
    const userId = await createUser({ branches: [BAGHDAD] });
    await seedEvents(userId);

    await asApp(scopeOf(userId), async (query) => {
      const { rows } = await query(`select object_id from audit_event where branch_code is null`);
      expect(rows).toHaveLength(0);
    });

    await asApp(scopeOf(userId, BAGHDAD, true), async (query) => {
      const { rows } = await query('select object_id from audit_event order by object_id');
      expect(rows.map((r) => r.object_id)).toEqual(['JE-BGW', 'JE-BSR', 'SYS-1']);
    });
  });

  it('refuses to plant an event in a branch the actor cannot see', async () => {
    const userId = await createUser({ branches: [BAGHDAD] });

    await expect(
      asApp(scopeOf(userId), (query) =>
        query(
          `insert into audit_event (actor_user_id, action, object_type, branch_code, outcome)
           values ($1, 'journal_entry.posted', 'journal_entry', $2, 'success')`,
          [userId, BASRA],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('returns nothing at all on an unscoped connection — deny by default', async () => {
    const userId = await createUser({ branches: [BAGHDAD] });
    await seedEvents(userId);

    const client = await appPool.connect();
    try {
      const { rows } = await client.query('select * from audit_event');
      expect(rows).toHaveLength(0);
    } finally {
      client.release();
    }
  });

  it('has FORCE ROW LEVEL SECURITY enabled, closing the owner-bypass hole', async () => {
    const { rows } = await ownerPool.query(
      `select relrowsecurity, relforcerowsecurity from pg_class where relname = 'audit_event'`,
    );
    expect(rows[0].relrowsecurity).toBe(true);
    expect(rows[0].relforcerowsecurity).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 01.5 — document numbering
// ---------------------------------------------------------------------------
describe('01.5 · document numbering (§3.4, §14.2, §24)', () => {
  // Test-only sequence keys. The real JOURNAL_ENTRY series is seeded by
  // migration 0006 and belongs to Phase 02.5; these exercise the engine itself.
  const JOURNAL = 'TEST_SIMPLE_SERIES';
  const INVOICE = 'TEST_BRANCH_YEAR_SERIES';

  async function defineSequences() {
    await ownerPool.query(
      `insert into doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
       values ($1, 'JE', '{PREFIX}-{SERIAL}', 6, false, false),
              ($2, 'INV', '{PREFIX}-{BRANCH}-{YY}-{SERIAL}', 5, true, true)`,
      [JOURNAL, INVOICE],
    );
  }

  beforeEach(defineSequences);

  it('issues numbers in order and records each allocation', async () => {
    const userId = await createUser({ branches: [BAGHDAD] });

    const first = await withScope(scopeOf(userId), (tx) =>
      allocateDocumentNumber(tx, JOURNAL, {}, userId),
    );
    const second = await withScope(scopeOf(userId), (tx) =>
      allocateDocumentNumber(tx, JOURNAL, {}, userId),
    );

    expect(first.documentNo).toBe('JE-000001');
    expect(second.documentNo).toBe('JE-000002');

    // Scoped to this sequence: the five account-code allocations seeded by
    // migration 0003 live in the same table.
    const { rows } = await ownerPool.query(
      `select document_no, serial, allocated_by from doc_number_allocation
        where sequence_key = $1 order by serial`,
      [JOURNAL],
    );
    expect(rows.map((r) => r.document_no)).toEqual(['JE-000001', 'JE-000002']);
    expect(rows[0].allocated_by).toBe(userId);
  });

  it('issues 1,000 distinct numbers under parallel allocation', async () => {
    // 01.5 gate, at the stated scale.
    const userId = await createUser({ branches: [BAGHDAD] });

    // Warm the counter so that a thousand callers do not race to create it.
    await withScope(scopeOf(userId), (tx) => allocateDocumentNumber(tx, JOURNAL));

    const allocated = await Promise.all(
      Array.from({ length: 1000 }, () =>
        withScope(scopeOf(userId), (tx) => allocateDocumentNumber(tx, JOURNAL)),
      ),
    );

    const numbers = allocated.map((a) => a.documentNo);
    expect(new Set(numbers).size).toBe(1000);

    const { rows } = await ownerPool.query(
      `select count(*)::int as n, count(distinct document_no)::int as distinct_n
         from doc_number_allocation where sequence_key = $1`,
      [JOURNAL],
    );
    expect(rows[0].n).toBe(1001);
    expect(rows[0].distinct_n).toBe(1001);
  });

  it('leaves a reportable gap when a document is rolled back, and never reuses the number', async () => {
    // 01.5 gate: "A rolled-back document leaves a recorded, reportable gap
    // rather than silently reusing the number." §14.2 forbids the reuse; §24
    // requires the gap to be reportable.
    const userId = await createUser({ branches: [BAGHDAD] });

    const first = await withScope(scopeOf(userId), (tx) => allocateDocumentNumber(tx, JOURNAL));
    expect(first.serial).toBe(1n);

    await expect(
      withScope(scopeOf(userId), async (tx) => {
        await allocateDocumentNumber(tx, JOURNAL);
        throw new Error('document failed validation after numbering');
      }),
    ).rejects.toThrow(/failed validation/);

    const third = await withScope(scopeOf(userId), (tx) => allocateDocumentNumber(tx, JOURNAL));
    expect(third.serial).toBe(3n);
    expect(third.documentNo).toBe('JE-000003');

    const gaps = await withScope(scopeOf(userId), (tx) => gapsFor(tx, JOURNAL));
    expect(gaps).toEqual([2n]);

    const { rows } = await ownerPool.query(
      `select document_no from doc_number_allocation where sequence_key = $1 order by serial`,
      [JOURNAL],
    );
    expect(rows.map((r) => r.document_no)).toEqual(['JE-000001', 'JE-000003']);
  });

  it('reports no gap when every issued number reached a document', async () => {
    const userId = await createUser({ branches: [BAGHDAD] });
    await withScope(scopeOf(userId), (tx) => allocateDocumentNumber(tx, JOURNAL));
    await withScope(scopeOf(userId), (tx) => allocateDocumentNumber(tx, JOURNAL));

    const gaps = await withScope(scopeOf(userId), (tx) => gapsFor(tx, JOURNAL));
    expect(gaps).toEqual([]);
  });

  it('counts per branch and per year independently across a year boundary', async () => {
    const userId = await createUser({ branches: [BAGHDAD, BASRA] });

    const bgw2026 = await withScope(scopeOf(userId), (tx) =>
      allocateDocumentNumber(tx, INVOICE, { branchCode: BAGHDAD, year: 2026 }),
    );
    const bsr2026 = await withScope(scopeOf(userId, BASRA), (tx) =>
      allocateDocumentNumber(tx, INVOICE, { branchCode: BASRA, year: 2026 }),
    );
    const bgw2027 = await withScope(scopeOf(userId), (tx) =>
      allocateDocumentNumber(tx, INVOICE, { branchCode: BAGHDAD, year: 2027 }),
    );

    // Each counter starts at 1 …
    expect([bgw2026.serial, bsr2026.serial, bgw2027.serial]).toEqual([1n, 1n, 1n]);
    // … and the printed numbers are still distinct, because the pattern says so.
    expect(bgw2026.documentNo).toBe('INV-BGW-26-00001');
    expect(bsr2026.documentNo).toBe('INV-BSR-26-00001');
    expect(bgw2027.documentNo).toBe('INV-BGW-27-00001');
  });

  it('rejects an unknown or inactive sequence rather than inventing a number', async () => {
    const userId = await createUser({ branches: [BAGHDAD] });

    await expect(
      withScope(scopeOf(userId), (tx) => allocateDocumentNumber(tx, 'NOT_CONFIGURED')),
    ).rejects.toThrow(UnknownSequenceError);

    await ownerPool.query(`update doc_sequence set active = false where key = $1`, [JOURNAL]);
    await expect(
      withScope(scopeOf(userId), (tx) => allocateDocumentNumber(tx, JOURNAL)),
    ).rejects.toThrow(UnknownSequenceError);
  });

  it('cannot record the same document number twice by any path', async () => {
    const userId = await createUser({ branches: [BAGHDAD] });
    await withScope(scopeOf(userId), (tx) => allocateDocumentNumber(tx, JOURNAL));

    await expect(
      asApp(scopeOf(userId), (query) =>
        query(
          `insert into doc_number_allocation (sequence_key, scope_key, serial, document_no)
           values ($1, '', 99, 'JE-000001')`,
          [JOURNAL],
        ),
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it('holds an issued number immutable once recorded', async () => {
    const userId = await createUser({ branches: [BAGHDAD] });
    await withScope(scopeOf(userId), (tx) => allocateDocumentNumber(tx, JOURNAL));

    await expect(
      ownerPool.query(`update doc_number_allocation set document_no = 'JE-999999'`),
    ).rejects.toThrow(/append-only/i);
  });

  it('refuses a sequence definition whose reset rule the pattern cannot express', async () => {
    // The database carries the same rule the domain does, so a definition
    // inserted by an admin screen, an import or a migration is checked too.
    await expect(
      ownerPool.query(
        `insert into doc_sequence (key, prefix, pattern, scope_branch)
         values ('BAD_BRANCH', 'BAD', '{PREFIX}-{SERIAL}', true)`,
      ),
    ).rejects.toThrow(/doc_sequence_branch_pattern/);

    await expect(
      ownerPool.query(
        `insert into doc_sequence (key, prefix, pattern)
         values ('BAD_SERIAL', 'BAD', '{PREFIX}-fixed')`,
      ),
    ).rejects.toThrow(/doc_sequence_pattern_has_serial/);
  });
});
