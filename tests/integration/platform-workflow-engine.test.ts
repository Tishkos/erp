/**
 * Phase 01.7 test gate — the approval engine against a real database.
 *
 * The self-approval rule and the definition validation are unit-tested. What
 * needs a database is the part that is about *records surviving*: that a
 * rejection starts a new revision rather than overwriting the last one, that a
 * delegated decision keeps both people, and that editing a route does not
 * rewrite the history of the documents that went through the old one.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { withScope } from '../../src/server/db/client';
import { workflowInstance } from '../../src/server/db/schema';
import * as workflow from '../../src/server/services/workflow';
import type { WorkflowActor } from '../../src/server/domain/workflow';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';

const DOC_TYPE = 'chart_of_account';

const actor = (userId: string, roles: string[], isDepartmentManager = false): WorkflowActor => ({
  userId,
  roles,
  isDepartmentManager,
});

let officerId: string;
let managerId: string;
let deputyId: string;

async function seedUser(name: string): Promise<string> {
  const id = randomUUID();
  await ownerPool.query(
    `insert into app_user (id, email, display_name) values ($1, $2, $3)`,
    [id, `wf-${id}@example.com`, name],
  );

  // D10 — permitted branches are rows in `user_branch_scope`, and the audit
  // trail's write policy reads them. Every approval, rejection and recall below
  // records an event stamped 'HQ', so a user who does not hold HQ cannot make
  // one: the workflow assertions would never be reached.
  await ownerPool.query(
    `insert into branch (code, name) values ('HQ', 'Head Office') on conflict (code) do nothing`,
  );
  await ownerPool.query(
    `insert into user_branch_scope (user_id, branch_code) values ($1, 'HQ') on conflict do nothing`,
    [id],
  );
  return id;
}

/** A fresh document id, so each test has its own approval history. */
const newDocument = () => `WF-${randomUUID().slice(0, 8)}`;

/**
 * Puts the route back to the one the migration seeded.
 *
 * A published version is not deleted in production — history pins it — so the
 * versions this file publishes are cleared here rather than by `resetTestData`,
 * which restores migration-seeded rows and would otherwise leave a two-step
 * route in place for every test that ran afterwards.
 */
async function restoreSeededRoute(): Promise<void> {
  // Deactivated, not deleted: instances pin the definition they started under,
  // so removing a published version would remove the history's own reference
  // point — which is the very thing the 01.7 gate protects.
  await ownerPool.query(`update workflow_definition set is_active = false where version > 1`);
  await ownerPool.query(`update workflow_definition set is_active = true where version = 1`);
}

beforeAll(async () => {
  await resetTestData();
  await restoreSeededRoute();
  await seedBranch('HQ', 'Head Office');
  officerId = await seedUser('Officer');
  managerId = await seedUser('Manager');
  deputyId = await seedUser('Deputy Manager');
});

/** HD6 — submit reads the submitter from the caller's context. */
function actorOf(userId: string) {
  return {
    principal: {
      userId,
      isSuperUser: false,
      isActive: true,
      roleCodes: [],
      grants: [],
      branchCodes: ['HQ'],
      defaultBranchCode: 'HQ',
      departments: [],
    },
    branchCode: 'HQ',
  };
}

describe('01.7 gate · rejection returns the document as a new revision', () => {
  it('starts revision 2 when a rejected document is submitted again', async () => {
    const documentId = newDocument();

    const first = await withScope({ userId: officerId, branchCode: 'HQ' }, (tx) =>
      workflow.submit(tx, actorOf(officerId), {
        documentTypeCode: DOC_TYPE,
        documentId,
        branchCode: 'HQ',
      }),
    );
    expect(first.revision).toBe(1);

    await withScope({ userId: managerId, branchCode: 'HQ' }, (tx) =>
      workflow.decide(tx, {
        documentTypeCode: DOC_TYPE,
        documentId,
        actor: actor(managerId, ['accounting_manager']),
        decision: 'rejected',
        reason: 'The parent group is wrong.',
      }),
    );

    const second = await withScope({ userId: officerId, branchCode: 'HQ' }, (tx) =>
      workflow.submit(tx, actorOf(officerId), {
        documentTypeCode: DOC_TYPE,
        documentId,
        branchCode: 'HQ',
      }),
    );

    expect(second.revision).toBe(2);
    expect(second.instanceId).not.toBe(first.instanceId);
  });

  it('keeps the rejected attempt rather than replacing it', async () => {
    const documentId = newDocument();

    await withScope({ userId: officerId, branchCode: 'HQ' }, (tx) =>
      workflow.submit(tx, actorOf(officerId), {
        documentTypeCode: DOC_TYPE,
        documentId,
        branchCode: 'HQ',
      }),
    );
    await withScope({ userId: managerId, branchCode: 'HQ' }, (tx) =>
      workflow.decide(tx, {
        documentTypeCode: DOC_TYPE,
        documentId,
        actor: actor(managerId, ['accounting_manager']),
        decision: 'rejected',
        reason: 'Wrong account type.',
      }),
    );
    await withScope({ userId: officerId, branchCode: 'HQ' }, (tx) =>
      workflow.submit(tx, actorOf(officerId), {
        documentTypeCode: DOC_TYPE,
        documentId,
        branchCode: 'HQ',
      }),
    );
    await withScope({ userId: managerId, branchCode: 'HQ' }, (tx) =>
      workflow.decide(tx, {
        documentTypeCode: DOC_TYPE,
        documentId,
        actor: actor(managerId, ['accounting_manager']),
        decision: 'approved',
      }),
    );

    const history = await withScope({ userId: managerId, branchCode: 'HQ' }, (tx) =>
      workflow.historyFor(tx, DOC_TYPE, documentId),
    );

    // Both decisions, in order, with the rejection's reason intact. An approval
    // history showing only the approval is a history of nothing.
    expect(history.map((h) => h.decision)).toEqual(['rejected', 'approved']);
    expect(history[0]!.reason).toBe('Wrong account type.');
    expect(history.map((h) => h.revision)).toEqual([1, 2]);
  });
});

describe('01.7 gate · delegation records both actors', () => {
  it('keeps the delegate and the person they acted for', async () => {
    const documentId = newDocument();

    await withScope({ userId: officerId, branchCode: 'HQ' }, (tx) =>
      workflow.submit(tx, actorOf(officerId), {
        documentTypeCode: DOC_TYPE,
        documentId,
        branchCode: 'HQ',
      }),
    );

    await withScope({ userId: deputyId, branchCode: 'HQ' }, (tx) =>
      workflow.decide(tx, {
        documentTypeCode: DOC_TYPE,
        documentId,
        actor: actor(deputyId, ['accounting_manager']),
        decision: 'delegated',
        reason: 'Approving while the Accounting Manager is on leave.',
        onBehalfOf: managerId,
      }),
    );

    const { rows } = await ownerPool.query(
      `select d.actor_user_id, d.on_behalf_of, d.reason
         from workflow_decision d
         join workflow_instance i on i.id = d.instance_id
        where i.document_id = $1`,
      [documentId],
    );

    expect(rows).toHaveLength(1);
    // Both, not one: "who decided" and "whose authority" are different
    // questions, and an audit needs each of them.
    expect(rows[0].actor_user_id).toBe(deputyId);
    expect(rows[0].on_behalf_of).toBe(managerId);
    expect(rows[0].reason).toMatch(/on leave/);
  });

  it('refuses a delegation with no stated reason', async () => {
    const documentId = newDocument();

    await withScope({ userId: officerId, branchCode: 'HQ' }, (tx) =>
      workflow.submit(tx, actorOf(officerId), {
        documentTypeCode: DOC_TYPE,
        documentId,
        branchCode: 'HQ',
      }),
    );

    // §5.4 — a delegation without a reason hides why authority moved.
    expect(
      await rejection(
        withScope({ userId: deputyId, branchCode: 'HQ' }, (tx) =>
          workflow.decide(tx, {
            documentTypeCode: DOC_TYPE,
            documentId,
            actor: actor(deputyId, ['accounting_manager']),
            decision: 'delegated',
            onBehalfOf: managerId,
          }),
        ),
      ),
    ).toMatch(/requires a reason/);
  });
});

describe('01.7 gate · changing a route does not rewrite history', () => {
  it('keeps an in-flight instance on the version it started under', async () => {
    const documentId = newDocument();

    const submitted = await withScope({ userId: officerId, branchCode: 'HQ' }, (tx) =>
      workflow.submit(tx, actorOf(officerId), {
        documentTypeCode: DOC_TYPE,
        documentId,
        branchCode: 'HQ',
      }),
    );

    const originalDefinitionId = (
      await ownerPool.query(`select definition_id from workflow_instance where id = $1`, [
        submitted.instanceId,
      ])
    ).rows[0].definition_id;

    // Publish a second version — a two-step route replacing the one-step one.
    // Written as the owner: a route is configuration, and the application role
    // deliberately holds no INSERT on workflow_definition, so a module cannot
    // quietly give itself a different approval path.
    const client = await ownerPool.connect();
    let newDefinitionId: string;
    try {
      await client.query('begin');
      await client.query(
        `update workflow_definition set is_active = false
          where document_type_code = $1 and is_active`,
        [DOC_TYPE],
      );
      // The next version, not "version 2": a published version is never
      // removed, so a run that already published one must not collide with it.
      const { rows } = await client.query(
        `insert into workflow_definition (document_type_code, version, is_active)
         select $1, coalesce(max(version), 0) + 1, true
           from workflow_definition where document_type_code = $1
         returning id`,
        [DOC_TYPE],
      );
      newDefinitionId = rows[0].id;
      await client.query(
        `insert into workflow_step
           (definition_id, sequence, approver_kind, approver_role, allow_self_approval)
         values ($1, 1, 'role', 'accounting_manager', false),
                ($1, 2, 'role', 'finance_director', false)`,
        [newDefinitionId],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    expect(newDefinitionId).not.toBe(originalDefinitionId);

    // The in-flight document still finishes under the one-step route it was
    // submitted under. If it picked up the new route it would suddenly need a
    // Finance Director who was never part of the deal.
    const outcome = await withScope({ userId: managerId, branchCode: 'HQ' }, (tx) =>
      workflow.decide(tx, {
        documentTypeCode: DOC_TYPE,
        documentId,
        actor: actor(managerId, ['accounting_manager']),
        decision: 'approved',
      }),
    );

    expect(outcome.isComplete).toBe(true);
    expect(outcome.nextStep).toBeNull();

    const { rows } = await ownerPool.query(
      `select definition_id from workflow_instance where id = $1`,
      [submitted.instanceId],
    );
    expect(rows[0].definition_id).toBe(originalDefinitionId);
  });

  it('applies the new route to the next document, not the last one', async () => {
    const documentId = newDocument();

    await withScope({ userId: officerId, branchCode: 'HQ' }, (tx) =>
      workflow.submit(tx, actorOf(officerId), {
        documentTypeCode: DOC_TYPE,
        documentId,
        branchCode: 'HQ',
      }),
    );

    // Version 2 is a two-step route, so one approval leaves it awaiting the
    // second step rather than completing it.
    const outcome = await withScope({ userId: managerId, branchCode: 'HQ' }, (tx) =>
      workflow.decide(tx, {
        documentTypeCode: DOC_TYPE,
        documentId,
        actor: actor(managerId, ['accounting_manager']),
        decision: 'approved',
      }),
    );

    expect(outcome.isComplete).toBe(false);
    expect(outcome.nextStep).toBe(2);
  });
});

describe('01.7 gate · the controlled-field configuration is real', () => {
  it('declares the fields a journal approval rests on', async () => {
    const fields = await withScope({ userId: managerId, branchCode: 'HQ' }, (tx) =>
      workflow.controlledFieldsFor(tx, 'journal_entry'),
    );

    // §24 — the amount, the dates and the branch are what an approver signs.
    expect(fields).toContain('posting_date');
    expect(fields).toContain('total_debit_iqd');
    expect(fields).toContain('branch_code');
    // The description is not, so a typo does not require a recall.
    expect(fields).not.toContain('description');
  });

  it('refuses a change to a controlled field once submitted', async () => {
    expect(
      await rejection(
        withScope({ userId: managerId, branchCode: 'HQ' }, (tx) =>
          workflow.assertControlledFieldsEditable(
            tx,
            'journal_entry',
            'submitted',
            { posting_date: '2026-01-31' },
            { posting_date: '2026-02-01' },
          ),
        ),
      ),
    ).toMatch(/posting_date is part of what was submitted/);
  });

  it('permits a change to an uncontrolled field once submitted', async () => {
    await expect(
      withScope({ userId: managerId, branchCode: 'HQ' }, (tx) =>
        workflow.assertControlledFieldsEditable(
          tx,
          'journal_entry',
          'submitted',
          { description: 'Rnt' },
          { description: 'Rent' },
        ),
      ),
    ).resolves.toBeUndefined();
  });
});

describe('01.7 · the instance and its decisions', () => {
  beforeAll(async () => {
    // The block above leaves a two-step route published. These tests are about
    // the instance, not the route, so they run on the seeded one.
    await restoreSeededRoute();
  });

  it('refuses a second decision once the route has finished', async () => {
    const documentId = newDocument();

    await withScope({ userId: officerId, branchCode: 'HQ' }, (tx) =>
      workflow.submit(tx, actorOf(officerId), {
        documentTypeCode: DOC_TYPE,
        documentId,
        branchCode: 'HQ',
      }),
    );
    await withScope({ userId: managerId, branchCode: 'HQ' }, (tx) =>
      workflow.decide(tx, {
        documentTypeCode: DOC_TYPE,
        documentId,
        actor: actor(managerId, ['accounting_manager']),
        decision: 'approved',
      }),
    );

    expect(
      await rejection(
        withScope({ userId: managerId, branchCode: 'HQ' }, (tx) =>
          workflow.decide(tx, {
            documentTypeCode: DOC_TYPE,
            documentId,
            actor: actor(managerId, ['accounting_manager']),
            decision: 'approved',
          }),
        ),
      ),
    ).toMatch(/No approval in progress|not awaiting/);
  });

  it('records a recall as a decision, not as a deletion', async () => {
    const documentId = newDocument();

    await withScope({ userId: officerId, branchCode: 'HQ' }, (tx) =>
      workflow.submit(tx, actorOf(officerId), {
        documentTypeCode: DOC_TYPE,
        documentId,
        branchCode: 'HQ',
      }),
    );

    await withScope({ userId: officerId, branchCode: 'HQ' }, (tx) =>
      workflow.recall(tx, DOC_TYPE, documentId, actor(officerId, ['accounting_officer']), 'Wrong parent.'),
    );

    const history = await withScope({ userId: officerId, branchCode: 'HQ' }, (tx) =>
      workflow.historyFor(tx, DOC_TYPE, documentId),
    );

    expect(history.map((h) => h.decision)).toEqual(['recalled']);
    expect(history[0]!.reason).toBe('Wrong parent.');
  });

  it('leaves the instance row behind after a recall', async () => {
    const documentId = newDocument();

    await withScope({ userId: officerId, branchCode: 'HQ' }, (tx) =>
      workflow.submit(tx, actorOf(officerId), {
        documentTypeCode: DOC_TYPE,
        documentId,
        branchCode: 'HQ',
      }),
    );
    await withScope({ userId: officerId, branchCode: 'HQ' }, (tx) =>
      workflow.recall(tx, DOC_TYPE, documentId, actor(officerId, ['accounting_officer']), 'Recalled.'),
    );

    const rows = await withScope({ userId: officerId, branchCode: 'HQ' }, (tx) =>
      tx.select().from(workflowInstance).where(eq(workflowInstance.documentId, documentId)),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.currentStep).toBeNull();
  });
});
