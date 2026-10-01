/**
 * Phase 01.3 — the Department Manager model, against a real PostgreSQL
 * instance.
 *
 * §5.2's rule is short and its failure mode is quiet: route by the author's
 * department instead of the document's and the wrong manager approves, which
 * nobody notices until an audit. So the tests are built around the blueprint's
 * own example — a user who manages Finance and sells in Sales.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as routing from '@/server/services/department-routing';
import * as workflow from '@/server/services/workflow';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { ExecutionEffectMissingError, NoDepartmentManagerError } from '@domain/department-routing';

const BAGHDAD = 'BGW';
/**
 * The §5.2 route: approved by whoever manages the document's department, not by
 * a named role. `chart_of_account` is the other mechanism — §14.4's route to the
 * Accounting Manager — and would test role membership instead.
 */
const DOCUMENT_TYPE = 'department_request';

/** What the execution effects did, so a test can see they ran. */
let executed: string[] = [];

async function createUser(
  departments: Array<[code: string, isManager: boolean]>,
  roleCode = 'accounting_officer',
): Promise<ActorContext> {
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
  for (const [code, isManager] of departments) {
    await ownerPool.query(
      `insert into user_department_scope (user_id, department_code, is_manager) values ($1,$2,$3)`,
      [id, code, isManager],
    );
  }
  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) =>
    authz.loadPrincipal(tx, id),
  );
  return { principal, branchCode: BAGHDAD };
}

const scope = (ctx: ActorContext) => ({ userId: ctx.principal.userId, branchCode: BAGHDAD });

beforeEach(async () => {
  await resetTestData();
  routing.clearExecutionEffects();
  executed = [];

  await seedBranch(BAGHDAD, 'Baghdad');
  await ownerPool.query(
    `insert into department (code, name, is_finance) values
       ('FIN','Finance',true), ('SLS','Sales',false), ('HR','Human Resources',false)`,
  );

  routing.registerExecutionEffect(DOCUMENT_TYPE, (_tx, _ctx, documentId) => {
    executed.push(documentId);
  });
});

afterEach(() => {
  routing.clearExecutionEffects();
});

// ---------------------------------------------------------------------------
describe('§5.2 · the same person, two departments', () => {
  it('finalises their Finance document directly and submits their Sales one', async () => {
    // The 01.3 gate, stated exactly: "User X, manager of Finance and ordinary
    // user in Sales, finalises a Finance document directly and must submit a
    // Sales document."
    const userX = await createUser([
      ['FIN', true],
      ['SLS', false],
    ]);
    await createUser([['SLS', true]]); // somebody manages Sales

    const finance = await withScope(scope(userX), (tx) =>
      routing.submitOrFinalise(tx, userX, {
        documentTypeCode: DOCUMENT_TYPE,
        documentId: 'doc-fin',
        departmentCode: 'FIN',
      }),
    );
    expect(finance.outcome).toBe('finalise_directly');

    const sales = await withScope(scope(userX), (tx) =>
      routing.submitOrFinalise(tx, userX, {
        documentTypeCode: DOCUMENT_TYPE,
        documentId: 'doc-sls',
        departmentCode: 'SLS',
      }),
    );
    expect(sales.outcome).toBe('submit_to_department_manager');
    expect(sales.assignedToUserId).not.toBeNull();
  });

  it('routes to the manager of the document’s department, not the author’s', async () => {
    // The gate's second line, and the quiet failure it guards against.
    const salesManager = await createUser([['SLS', true]]);
    await createUser([['FIN', true]]); // a Finance manager who must not get it
    const author = await createUser([['FIN', false]]);

    const result = await withScope(scope(author), (tx) =>
      routing.submitOrFinalise(tx, author, {
        documentTypeCode: DOCUMENT_TYPE,
        documentId: 'doc-1',
        departmentCode: 'SLS',
      }),
    );

    expect(result.assignedToUserId).toBe(salesManager.principal.userId);
  });

  it('does not let managing one department finalise in another', async () => {
    const userX = await createUser([['FIN', true]]);
    await createUser([['HR', true]]);

    const result = await withScope(scope(userX), (tx) =>
      routing.submitOrFinalise(tx, userX, {
        documentTypeCode: DOCUMENT_TYPE,
        documentId: 'doc-hr',
        departmentCode: 'HR',
      }),
    );
    expect(result.outcome).toBe('submit_to_department_manager');
  });

  it('prefers a manager who is not the author', async () => {
    // A manager of Finance raising an HR document, where they also happen to
    // manage HR, would finalise directly — so arriving here means they do not.
    const author = await createUser([['SLS', false]]);
    const firstManager = await createUser([['SLS', true]]);

    const result = await withScope(scope(author), (tx) =>
      routing.submitOrFinalise(tx, author, {
        documentTypeCode: DOCUMENT_TYPE,
        documentId: 'doc-2',
        departmentCode: 'SLS',
      }),
    );
    expect(result.assignedToUserId).toBe(firstManager.principal.userId);
  });

  it('refuses to route into a department with no manager', async () => {
    const author = await createUser([['SLS', false]]);

    await expect(
      withScope(scope(author), (tx) =>
        routing.submitOrFinalise(tx, author, {
          documentTypeCode: DOCUMENT_TYPE,
          documentId: 'doc-3',
          departmentCode: 'HR',
        }),
      ),
    ).rejects.toThrow(NoDepartmentManagerError);
  });

  it('sets the toggle per department, not per user', async () => {
    const userX = await createUser([
      ['FIN', true],
      ['SLS', false],
    ]);

    const { rows } = await ownerPool.query(
      `select department_code, is_manager from user_department_scope
        where user_id = $1 order by department_code`,
      [userX.principal.userId],
    );
    expect(rows).toEqual([
      { department_code: 'FIN', is_manager: true },
      { department_code: 'SLS', is_manager: false },
    ]);
  });
});

// ---------------------------------------------------------------------------
describe('§5.2 · manager approval executes the document type’s effects', () => {
  it('runs them on direct finalisation, in the same transaction', async () => {
    const manager = await createUser([['FIN', true]]);

    await withScope(scope(manager), (tx) =>
      routing.submitOrFinalise(tx, manager, {
        documentTypeCode: DOCUMENT_TYPE,
        documentId: 'doc-direct',
        departmentCode: 'FIN',
      }),
    );

    expect(executed).toEqual(['doc-direct']);
  });

  it('runs them on approval, in the approving transaction', async () => {
    // §24 requires the posting to be atomic with the approval that caused it.
    const manager = await createUser([['SLS', true]]);
    const author = await createUser([['SLS', false]]);

    await withScope(scope(author), (tx) =>
      routing.submitOrFinalise(tx, author, {
        documentTypeCode: DOCUMENT_TYPE,
        documentId: 'doc-approve',
        departmentCode: 'SLS',
      }),
    );
    expect(executed).toEqual([]); // nothing has happened yet

    await withScope(scope(manager), (tx) =>
      routing.approveAsDepartmentManager(tx, manager, {
        documentTypeCode: DOCUMENT_TYPE,
        documentId: 'doc-approve',
      }),
    );
    expect(executed).toEqual(['doc-approve']);
  });

  it('leaves nothing behind when an effect fails', async () => {
    routing.registerExecutionEffect(DOCUMENT_TYPE, () => {
      throw new Error('the posting failed');
    });

    const manager = await createUser([['FIN', true]]);

    await expect(
      withScope(scope(manager), (tx) =>
        routing.submitOrFinalise(tx, manager, {
          documentTypeCode: DOCUMENT_TYPE,
          documentId: 'doc-fail',
          departmentCode: 'FIN',
        }),
      ),
    ).rejects.toThrow('the posting failed');

    const { rows } = await ownerPool.query(
      `select count(*)::int as n from audit_event where object_id = 'doc-fail'`,
    );
    expect(rows[0].n).toBe(0);
  });

  it('refuses a document type with no registered effect', async () => {
    // Silently doing nothing would make "approval executes the effects" a claim
    // rather than a behaviour.
    routing.clearExecutionEffects();
    const manager = await createUser([['FIN', true]]);

    await expect(
      withScope(scope(manager), (tx) =>
        routing.submitOrFinalise(tx, manager, {
          documentTypeCode: DOCUMENT_TYPE,
          documentId: 'doc-none',
          departmentCode: 'FIN',
        }),
      ),
    ).rejects.toThrow(ExecutionEffectMissingError);
  });

  it('refuses an approval by someone who does not manage that department', async () => {
    const salesManager = await createUser([['SLS', true]]);
    const financeManager = await createUser([['FIN', true]]);
    const author = await createUser([['SLS', false]]);

    await withScope(scope(author), (tx) =>
      routing.submitOrFinalise(tx, author, {
        documentTypeCode: DOCUMENT_TYPE,
        documentId: 'doc-wrong-manager',
        departmentCode: 'SLS',
      }),
    );

    await expect(
      withScope(scope(financeManager), (tx) =>
        routing.approveAsDepartmentManager(tx, financeManager, {
          documentTypeCode: DOCUMENT_TYPE,
          documentId: 'doc-wrong-manager',
        }),
      ),
    ).rejects.toThrow(/You do not manage it/);

    // And the right one still can.
    await expect(
      withScope(scope(salesManager), (tx) =>
        routing.approveAsDepartmentManager(tx, salesManager, {
          documentTypeCode: DOCUMENT_TYPE,
          documentId: 'doc-wrong-manager',
        }),
      ),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe('§5.2 · the route does not drift', () => {
  it('records the department and the approver on the instance', async () => {
    const manager = await createUser([['SLS', true]]);
    const author = await createUser([['SLS', false]]);

    await withScope(scope(author), (tx) =>
      routing.submitOrFinalise(tx, author, {
        documentTypeCode: DOCUMENT_TYPE,
        documentId: 'doc-4',
        departmentCode: 'SLS',
      }),
    );

    const { rows } = await ownerPool.query(
      `select department_code, assigned_to_user_id from workflow_instance`,
    );
    expect(rows[0]).toMatchObject({
      department_code: 'SLS',
      assigned_to_user_id: manager.principal.userId,
    });
  });

  it('refuses to re-point a live approval at someone else', async () => {
    // Steering a document to a more agreeable approver after the fact is the
    // one thing an approval route exists to prevent.
    await createUser([['SLS', true]]);
    const author = await createUser([['SLS', false]]);

    await withScope(scope(author), (tx) =>
      routing.submitOrFinalise(tx, author, {
        documentTypeCode: DOCUMENT_TYPE,
        documentId: 'doc-5',
        departmentCode: 'SLS',
      }),
    );

    // Re-pointed at the author, who is not a manager of anything — the attempt
    // a control exists to stop, and a value that cannot coincidentally already
    // be the assignee (which would make the UPDATE a no-op and prove nothing).
    expect(
      await rejection(
        ownerPool.query(`update workflow_instance set assigned_to_user_id = $1`, [
          author.principal.userId,
        ]),
      ),
    ).toMatch(/cannot be re-pointed at a different approver/);

    expect(
      await rejection(ownerPool.query(`update workflow_instance set department_code = 'FIN'`)),
    ).toMatch(/department a submitted document belongs to cannot be changed/);
  });

  it('shows the manager what is waiting for them', async () => {
    const manager = await createUser([['SLS', true]]);
    const author = await createUser([['SLS', false]]);

    for (const documentId of ['doc-a', 'doc-b']) {
      await withScope(scope(author), (tx) =>
        routing.submitOrFinalise(tx, author, {
          documentTypeCode: DOCUMENT_TYPE,
          documentId,
          departmentCode: 'SLS',
        }),
      );
    }

    const inbox = await withScope(scope(manager), (tx) =>
      routing.inboxFor(tx, manager.principal.userId),
    );
    expect(inbox.map((i) => i.documentId).sort()).toEqual(['doc-a', 'doc-b']);
    expect(inbox.every((i) => i.departmentCode === 'SLS')).toBe(true);
  });

  it('clears the inbox once the approval is made', async () => {
    const manager = await createUser([['SLS', true]]);
    const author = await createUser([['SLS', false]]);

    await withScope(scope(author), (tx) =>
      routing.submitOrFinalise(tx, author, {
        documentTypeCode: DOCUMENT_TYPE,
        documentId: 'doc-c',
        departmentCode: 'SLS',
      }),
    );
    await withScope(scope(manager), (tx) =>
      routing.approveAsDepartmentManager(tx, manager, {
        documentTypeCode: DOCUMENT_TYPE,
        documentId: 'doc-c',
      }),
    );

    const inbox = await withScope(scope(manager), (tx) =>
      routing.inboxFor(tx, manager.principal.userId),
    );
    expect(inbox).toHaveLength(0);

    const history = await withScope(scope(manager), (tx) =>
      workflow.historyFor(tx, DOCUMENT_TYPE, 'doc-c'),
    );
    expect(history.map((h) => h.decision)).toEqual(['approved']);
  });
});
