/**
 * Phase 01.12 test gate — the record framework against a real database.
 *
 * *"Every record page shows status, owner, branch, dates, source, approvals,
 * related documents and audit timeline."*
 * *"An action invalid for the current status is disabled **and** rejected
 * server-side if invoked directly."*
 *
 * The second is the one that matters most. A disabled button is a courtesy; the
 * control is that the same refusal happens when the button is bypassed, which
 * is what these tests invoke directly.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { withScope } from '../../src/server/db/client';
import { registerAllRecords } from '../../src/server/records';
import * as record from '../../src/server/services/record';
import * as actions from '../../src/server/services/document-actions';
import * as accountsService from '../../src/server/services/chart-of-accounts';
import type { Grant, Principal } from '../../src/server/domain/permissions';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';

const principalFor = (grants: Grant[], overrides: Partial<Principal> = {}): Principal => ({
  userId: randomUUID(),
  isSuperUser: false,
  isActive: true,
  roleCodes: [],
  grants,
  branchCodes: ['HQ'],
  departments: [],
  defaultBranchCode: 'HQ',
  ...overrides,
});

/** §14.4 — the officer raises, the manager approves. */
const OFFICER: Grant[] = [
  { verb: 'view', object: 'chart_of_account' },
  { verb: 'create', object: 'chart_of_account' },
  { verb: 'edit_draft', object: 'chart_of_account' },
  { verb: 'submit', object: 'chart_of_account' },
  { verb: 'print', object: 'chart_of_account' },
];

const MANAGER: Grant[] = [
  ...OFFICER,
  { verb: 'approve', object: 'chart_of_account' },
  { verb: 'export', object: 'chart_of_account' },
];

const officer = principalFor(OFFICER, { roleCodes: ['accounting_officer'] });
const manager = principalFor(MANAGER, { roleCodes: ['accounting_manager'] });

function asPrincipal<T>(
  principal: Principal,
  fn: (tx: Parameters<Parameters<typeof withScope>[1]>[0]) => Promise<T>,
): Promise<T> {
  return withScope({ userId: principal.userId, branchCode: 'HQ' }, fn);
}

async function seedUser(principal: Principal, role: string): Promise<void> {
  await ownerPool.query(
    `insert into app_user (id, email, display_name) values ($1, $2, 'Record test user')
     on conflict (id) do nothing`,
    [principal.userId, `record-${principal.userId}@example.com`],
  );
  await ownerPool.query(
    `insert into user_role (user_id, role_code) values ($1, $2) on conflict do nothing`,
    [principal.userId, role],
  );

  // D10 — a user's permitted branches are rows, not a claim in the session.
  // Every action here records an audit event stamped with the branch it
  // happened in, and the audit trail's write policy asks the same question the
  // read policy does: is this a branch the actor holds? A fixture user with no
  // scope row holds none, so without this the first audited action fails with
  // an RLS violation rather than the assertion the test is about.
  await ownerPool.query(
    `insert into branch (code, name) values ('HQ', 'Head Office') on conflict (code) do nothing`,
  );
  await ownerPool.query(
    `insert into user_branch_scope (user_id, branch_code) values ($1, 'HQ') on conflict do nothing`,
    [principal.userId],
  );
}

/** A draft account under the Asset root, raised through the real service. */
async function raiseAccount(name: string): Promise<string> {
  const { rows } = await ownerPool.query(`select id from chart_of_account where code = 'A000001'`);

  return withScope({ userId: officer.userId, branchCode: 'HQ' }, async (tx) => {
    const created = await accountsService.createAccount(
      tx,
      { principal: officer, branchCode: 'HQ' },
      { name, parentId: rows[0].id, isGroup: false, currencyRestriction: 'IQD' },
    );
    return created.code;
  });
}

beforeAll(async () => {
  registerAllRecords();
  await resetTestData();
  await seedBranch('HQ', 'Head Office');
  await seedUser(officer, 'accounting_officer');
  await seedUser(manager, 'accounting_manager');
});

describe('Appendix A rule 2 · every record shows the nine facts', () => {
  let code: string;

  beforeAll(async () => {
    code = await raiseAccount('Record framework fixture');
  });

  it('returns a header with every required fact present', async () => {
    const view = await asPrincipal(officer, (tx) =>
      record.view(tx, officer, 'chart_of_account', code),
    );

    // Present, not merely truthy: a null branch on a company-wide master is a
    // stated fact, and the assertion is that the field exists to state it.
    for (const key of [
      'documentType',
      'documentId',
      'documentNumber',
      'status',
      'ownerUserId',
      'branchCode',
      'departmentCode',
      'documentDate',
      'createdAt',
      'updatedAt',
      'source',
    ] as const) {
      expect(view.header, key).toHaveProperty(key);
    }

    expect(view.header.status).toBe('draft');
    expect(view.header.ownerUserId).toBe(officer.userId);
  });

  it('shows the parent as the source document', async () => {
    const view = await asPrincipal(officer, (tx) =>
      record.view(tx, officer, 'chart_of_account', code),
    );

    expect(view.header.source?.documentId).toBe('A000001');
    expect(view.related.map((r) => r.documentId)).toContain('A000001');
  });

  it('shows the audit timeline of the record', async () => {
    const view = await asPrincipal(officer, (tx) =>
      record.view(tx, officer, 'chart_of_account', code),
    );

    expect(view.audit.length).toBeGreaterThan(0);
    expect(view.audit[0]!.action).toMatch(/chart_of_account/);
    expect(view.audit[0]!.actorUserId).toBe(officer.userId);
  });

  it('says a master record has no journal entries rather than hiding the section', async () => {
    const view = await asPrincipal(officer, (tx) =>
      record.view(tx, officer, 'chart_of_account', code),
    );

    // An empty array is the honest answer; the component renders "has not
    // posted to the General Ledger" from it.
    expect(view.journals).toEqual([]);
  });

  it('reports a record outside the reader’s reach as simply absent', async () => {
    // Not "you may not see this" — that confirms it exists.
    expect(
      await rejection(
        asPrincipal(officer, (tx) => record.view(tx, officer, 'chart_of_account', 'A999999')),
      ),
    ).toMatch(/does not exist, or is outside the data you may see/);
  });

  it('refuses the record to someone without view', async () => {
    const outsider = principalFor([{ verb: 'view', object: 'journal_entry' }]);

    expect(
      await rejection(
        asPrincipal(outsider, (tx) => record.view(tx, outsider, 'chart_of_account', code)),
      ),
    ).toMatch(/'view' on 'chart_of_account' is not granted/);
  });
});

describe('Appendix A rule 3 · actions follow status and permission', () => {
  let code: string;

  beforeEach(async () => {
    code = await raiseAccount(`Action fixture ${randomUUID().slice(0, 8)}`);
  });

  it('offers the officer submit on a draft, and not approve', async () => {
    const view = await asPrincipal(officer, (tx) =>
      record.view(tx, officer, 'chart_of_account', code),
    );

    const enabled = view.actions.filter((a) => a.enabled).map((a) => a.key);
    expect(enabled).toContain('submit');
    expect(enabled).not.toContain('approve');
  });

  it('offers the manager approve once it is submitted, and not before', async () => {
    const before = await asPrincipal(manager, (tx) =>
      record.view(tx, manager, 'chart_of_account', code),
    );
    expect(before.actions.find((a) => a.key === 'approve')?.enabled).toBe(false);

    await withScope({ userId: officer.userId, branchCode: 'HQ' }, (tx) =>
      actions.perform(tx, officer, {
        documentType: 'chart_of_account',
        documentId: code,
        action: 'submit',
      }),
    );

    const after = await asPrincipal(manager, (tx) =>
      record.view(tx, manager, 'chart_of_account', code),
    );
    expect(after.header.status).toBe('submitted');
    expect(after.actions.find((a) => a.key === 'approve')?.enabled).toBe(true);
  });

  it('says which of the two reasons an action is unavailable for', async () => {
    const view = await asPrincipal(officer, (tx) =>
      record.view(tx, officer, 'chart_of_account', code),
    );

    // The officer will never be able to approve; the manager could, but not yet.
    expect(view.actions.find((a) => a.key === 'approve')?.disabledReasonKey).toBe(
      'action.disabled.no_permission',
    );

    const managerView = await asPrincipal(manager, (tx) =>
      record.view(tx, manager, 'chart_of_account', code),
    );
    expect(managerView.actions.find((a) => a.key === 'approve')?.disabledReasonKey).toBe(
      'action.disabled.wrong_status',
    );
  });
});

describe('01.12 gate · an invalid action is rejected server-side, not only disabled', () => {
  let code: string;

  beforeEach(async () => {
    code = await raiseAccount(`Direct invocation ${randomUUID().slice(0, 8)}`);
  });

  it('refuses to approve a draft, invoked directly', async () => {
    // The screen would not have offered this. The refusal does not depend on
    // the screen.
    expect(
      await rejection(
        asPrincipal(manager, (tx) =>
          actions.perform(tx, manager, {
            documentType: 'chart_of_account',
            documentId: code,
            action: 'approve',
          }),
        ),
      ),
    ).toMatch(/'approve' is not available while this document is 'draft'/);
  });

  it('refuses an action the caller has no permission for, invoked directly', async () => {
    await withScope({ userId: officer.userId, branchCode: 'HQ' }, (tx) =>
      actions.perform(tx, officer, {
        documentType: 'chart_of_account',
        documentId: code,
        action: 'submit',
      }),
    );

    expect(
      await rejection(
        asPrincipal(officer, (tx) =>
          actions.perform(tx, officer, {
            documentType: 'chart_of_account',
            documentId: code,
            action: 'approve',
          }),
        ),
      ).then((message) => message),
    ).toMatch(/not available while this document is 'submitted'/);
  });

  it('tells the caller what to do next, rather than only refusing', async () => {
    // §25 — field, reason, corrective action.
    const message = await rejection(
      asPrincipal(manager, (tx) =>
        actions.perform(tx, manager, {
          documentType: 'chart_of_account',
          documentId: code,
          action: 'approve',
        }),
      ),
    );

    expect(message).toMatch(/Refresh the record/);
  });

  it('refuses an action that is not an action of this document type', async () => {
    expect(
      await rejection(
        asPrincipal(manager, (tx) =>
          actions.perform(tx, manager, {
            documentType: 'chart_of_account',
            documentId: code,
            action: 'obliterate',
          }),
        ),
      ),
    ).toMatch(/is not an action of a chart_of_account/);
  });

  it('records the action it did allow, with the status either side of it', async () => {
    await withScope({ userId: officer.userId, branchCode: 'HQ' }, (tx) =>
      actions.perform(tx, officer, {
        documentType: 'chart_of_account',
        documentId: code,
        action: 'submit',
      }),
    );

    const { rows } = await ownerPool.query(
      // Keyed by the row id, not the code — the audit trail follows the record
      // through a code correction, which is why RecordHeader carries both.
      `select before_value, after_value from audit_event
        where object_type = 'chart_of_account'
          and object_id = (select id::text from chart_of_account where code = $1)
          and action = 'chart_of_account.submit'`,
      [code],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].before_value.status).toBe('draft');
    expect(rows[0].after_value.status).toBe('submitted');
  });

  it('leaves the document untouched when the action is refused', async () => {
    await rejection(
      asPrincipal(manager, (tx) =>
        actions.perform(tx, manager, {
          documentType: 'chart_of_account',
          documentId: code,
          action: 'approve',
        }),
      ),
    );

    const { rows } = await ownerPool.query(
      `select approval_status from chart_of_account where code = $1`,
      [code],
    );
    expect(rows[0].approval_status).toBe('draft');
  });
});

describe('01.6 gate · a saved draft cannot be deleted by any path', () => {
  it('withholds DELETE on every document header from the application role', async () => {
    // §3.2: "No deletion of saved or posted records. Drafts may be cancelled
    // and retained." The domain refuses it and the service never offers it, but
    // "by any path" means the privilege itself is absent — a future module
    // cannot delete what the role cannot delete.
    const { rows } = await ownerPool.query(
      `select table_name from information_schema.role_table_grants
        where grantee = 'erp_app' and privilege_type = 'DELETE'
          and table_name in ('journal_entry','chart_of_account','business_partner','item',
                             'workflow_instance','subledger_entry','audit_event',
                             'posting_log','bank_cash_account','warehouse')`,
    );

    expect(rows.map((r) => r.table_name)).toEqual([]);
  });

  it('refuses a delete attempted through the application role', async () => {
    const code = await raiseAccount(`Undeletable ${randomUUID().slice(0, 8)}`);

    // The privilege is absent, so this is refused by the database rather than
    // by a check somebody could forget to write. The owner role can still
    // remove a never-approved row — that is a migration capability, and an
    // approved account is blocked even for the owner (see the Phase 02 tests).
    expect(
      await rejection(
        withScope({ userId: officer.userId, branchCode: 'HQ' }, (tx) =>
          tx.execute(sql`delete from chart_of_account where code = ${code}`),
        ),
      ),
    ).toMatch(/permission denied/i);

    const { rows } = await ownerPool.query(
      `select approval_status from chart_of_account where code = $1`,
      [code],
    );
    expect(rows).toHaveLength(1);
  });
});

describe('Appendix A rule 4 · a draft is marked as one', () => {
  it('marks a draft account, and stops marking it once approved', async () => {
    const code = await raiseAccount(`Marking fixture ${randomUUID().slice(0, 8)}`);

    const draft = await asPrincipal(officer, (tx) =>
      record.view(tx, officer, 'chart_of_account', code),
    );
    expect(draft.draftMarking).toMatchObject({ isDraft: true, isFinal: false });

    await withScope({ userId: officer.userId, branchCode: 'HQ' }, (tx) =>
      actions.perform(tx, officer, {
        documentType: 'chart_of_account',
        documentId: code,
        action: 'submit',
      }),
    );

    const submitted = await asPrincipal(manager, (tx) =>
      record.view(tx, manager, 'chart_of_account', code),
    );
    // Still not final — it is awaiting a decision, and printing it as final
    // would misrepresent it.
    expect(submitted.draftMarking.isDraft).toBe(true);

    await withScope({ userId: manager.userId, branchCode: 'HQ' }, (tx) =>
      actions.perform(tx, manager, {
        documentType: 'chart_of_account',
        documentId: code,
        action: 'approve',
      }),
    );

    const approved = await asPrincipal(manager, (tx) =>
      record.view(tx, manager, 'chart_of_account', code),
    );
    expect(approved.header.status).toBe('approved');
    expect(approved.draftMarking.isDraft).toBe(false);
  });
});
