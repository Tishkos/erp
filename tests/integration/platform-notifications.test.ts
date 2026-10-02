/**
 * Phase 01.9 — notifications, against a real PostgreSQL instance.
 *
 * The gate item that matters most is the last one: "Suppressing notifications
 * entirely leaves every approval requirement intact." §21 is blunt about why —
 * "System notifications are not a substitute for workflow status. A missed
 * e-mail must never change the underlying approval requirement."
 *
 * So this file does not only test that notifications work. It turns them off
 * and proves the approvals do not notice.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as coa from '@/server/services/chart-of-accounts';
import * as jobs from '@/server/services/jobs';
import * as notifications from '@/server/services/notifications';
import * as workflow from '@/server/services/workflow';
import type { ActorContext } from '@/server/services/chart-of-accounts';

const BAGHDAD = 'BGW';
const EVENT = {
  eventType: 'journal_entry.submitted',
  objectType: 'journal_entry',
  objectId: 'je-1',
  occurrence: '1',
};

let officer: ActorContext;
let manager: ActorContext;
let secondManager: ActorContext;

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

beforeEach(async () => {
  await resetTestData();
  notifications.clearSenders();
  jobs.clearHandlers();
  await seedBranch(BAGHDAD, 'Baghdad');
  officer = await createUser('accounting_officer');
  manager = await createUser('accounting_manager');
  secondManager = await createUser('accounting_manager');
});

afterEach(() => {
  notifications.clearSenders();
  jobs.clearHandlers();
});

// ---------------------------------------------------------------------------
describe('§21 · exactly one notification per qualifying event', () => {
  it('raises one per recipient of the rule’s role', async () => {
    const result = await withScope(scope(officer), (tx) =>
      notifications.raise(tx, EVENT, { reference: 'JE-2026-000001' }),
    );

    // Two managers hold the role, so two people are told about one event.
    expect(result.created).toBe(2);
    expect(result.suppressed).toBe(0);

    const { rows } = await ownerPool.query(`select subject, recipient_user_id from notification`);
    expect(rows).toHaveLength(2);
    expect(rows[0].subject).toContain('JE-2026-000001');
  });

  it('creates nothing the second time the same event arrives', async () => {
    // At-least-once delivery makes a repeat normal, not exceptional.
    await withScope(scope(officer), (tx) => notifications.raise(tx, EVENT));
    const second = await withScope(scope(officer), (tx) => notifications.raise(tx, EVENT));

    expect(second.created).toBe(0);
    expect(second.suppressed).toBe(2);

    const { rows } = await ownerPool.query(`select count(*)::int as n from notification`);
    expect(rows[0].n).toBe(2);
  });

  it('treats a genuinely different occurrence as a new task', async () => {
    // A journal submitted, rejected and submitted again is two tasks.
    await withScope(scope(officer), (tx) => notifications.raise(tx, EVENT));
    const resubmission = await withScope(scope(officer), (tx) =>
      notifications.raise(tx, { ...EVENT, occurrence: '2' }),
    );

    expect(resubmission.created).toBe(2);
  });

  it('refuses a duplicate at the database, whatever the service does', async () => {
    await withScope(scope(officer), (tx) => notifications.raise(tx, EVENT));

    const { rows } = await ownerPool.query(`select dedupe_key from notification limit 1`);
    const message = await rejection(
      ownerPool.query(
        `insert into notification (rule_code, event_type, object_type, object_id,
                                   recipient_user_id, subject, body, dedupe_key)
         values ('journal_awaiting_approval','x','y','z',$1,'s','b',$2)`,
        [manager.principal.userId, rows[0].dedupe_key],
      ),
    );
    expect(message).toMatch(/notification_dedupe_uniq/);
  });

  it('raises nothing when no rule qualifies', async () => {
    const result = await withScope(scope(officer), (tx) =>
      notifications.raise(tx, { ...EVENT, eventType: 'nothing.happens' }),
    );
    expect(result).toEqual({ created: 0, suppressed: 0 });
  });

  it('raises nothing when the role is unstaffed, without failing', async () => {
    // An unstaffed role is an operational fact, not a failure of the event.
    await ownerPool.query(`delete from user_role where role_code = 'accounting_manager'`);

    const result = await withScope(scope(officer), (tx) => notifications.raise(tx, EVENT));
    expect(result.created).toBe(0);
  });

  it('hands delivery to the queue through the outbox (§24)', async () => {
    await withScope(scope(officer), (tx) => notifications.raise(tx, EVENT));

    const { rows } = await ownerPool.query(
      `select queue_name, status from job_outbox order by id`,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ queue_name: 'notification.deliver', status: 'pending' });
  });

  it('raises nothing when the event that caused it rolls back', async () => {
    await expect(
      withScope(scope(officer), async (tx) => {
        await notifications.raise(tx, EVENT);
        throw new Error('the submission failed');
      }),
    ).rejects.toThrow('the submission failed');

    const { rows } = await ownerPool.query(`select count(*)::int as n from notification`);
    expect(rows[0].n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('§21 · delivery status is recorded and visible', () => {
  it('delivers the in-app copy without a sender — the row is the delivery', async () => {
    await ownerPool.query(
      `update notification_rule set channels = ARRAY['in_app'] where code = 'journal_awaiting_approval'`,
    );
    await withScope(scope(officer), (tx) => notifications.raise(tx, EVENT));

    const { rows: created } = await ownerPool.query(`select id from notification order by id`);
    await withScope(scope(manager), (tx) =>
      notifications.deliver(tx, BigInt(created[0].id)),
    );

    const { rows } = await ownerPool.query(
      `select status, attempts from notification_delivery where notification_id = $1`,
      [created[0].id],
    );
    expect(rows[0]).toMatchObject({ status: 'sent', attempts: 1 });
  });

  it('records a failure with its reason, and keeps it visible', async () => {
    notifications.registerSender('email', () => {
      throw new Error('the mail relay refused the message');
    });
    await withScope(scope(officer), (tx) => notifications.raise(tx, EVENT));

    const { rows: created } = await ownerPool.query(`select id from notification order by id`);
    const result = await withScope(scope(manager), (tx) =>
      notifications.deliver(tx, BigInt(created[0].id)),
    );

    expect(result).toEqual({ sent: 1, failed: 1 }); // in-app arrived, e-mail did not

    const failures = await withScope(scope(manager), (tx) =>
      notifications.failedDeliveries(tx),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ channel: 'email', attempts: 1 });
    expect(failures[0]!.errorMessage).toMatch(/mail relay refused/);
  });

  it('does not let a delivered notification be marked undelivered', async () => {
    await ownerPool.query(
      `update notification_rule set channels = ARRAY['in_app'] where code = 'journal_awaiting_approval'`,
    );
    await withScope(scope(officer), (tx) => notifications.raise(tx, EVENT));
    const { rows: created } = await ownerPool.query(`select id from notification order by id`);
    await withScope(scope(manager), (tx) => notifications.deliver(tx, BigInt(created[0].id)));

    expect(
      await rejection(
        ownerPool.query(`update notification_delivery set status = 'pending', delivered_at = null`),
      ),
    ).toMatch(/cannot be marked undelivered/);
  });

  it('keeps a failed attempt on the record', async () => {
    notifications.registerSender('email', () => {
      throw new Error('relay down');
    });
    await withScope(scope(officer), (tx) => notifications.raise(tx, EVENT));
    const { rows: created } = await ownerPool.query(`select id from notification order by id`);
    await withScope(scope(manager), (tx) => notifications.deliver(tx, BigInt(created[0].id)));

    expect(
      await rejection(ownerPool.query(`delete from notification_delivery`)),
    ).toMatch(/append-only/i);
  });

  it('shows the recipient their inbox', async () => {
    await withScope(scope(officer), (tx) => notifications.raise(tx, EVENT));

    const inbox = await withScope(scope(manager), (tx) =>
      notifications.inboxFor(tx, manager.principal.userId, { unreadOnly: true }),
    );
    expect(inbox).toHaveLength(1);

    await withScope(scope(manager), (tx) => notifications.markRead(tx, inbox[0]!.id, manager.principal.userId));

    const afterReading = await withScope(scope(manager), (tx) =>
      notifications.inboxFor(tx, manager.principal.userId, { unreadOnly: true }),
    );
    expect(afterReading).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('§21 · escalation when a task is not acted upon', () => {
  it('escalates once the configured interval has passed', async () => {
    await withScope(scope(officer), (tx) => notifications.raise(tx, EVENT));

    // The seeded rule escalates after a day. Nothing is due yet.
    const notYet = await withScope(scope(manager), (tx) => notifications.escalateDue(tx));
    expect(notYet.escalated).toBe(0);

    const tomorrow = new Date(Date.now() + 25 * 60 * 60 * 1000);
    const due = await withScope(scope(manager), (tx) => notifications.escalateDue(tx, tomorrow));
    expect(due.escalated).toBe(2);

    const { rows } = await ownerPool.query(
      `select count(*)::int as n from notification where event_type like '%.escalated'`,
    );
    expect(rows[0].n).toBeGreaterThan(0);
  });

  it('does not escalate a task that was acted upon', async () => {
    // The clock stops when the thing is done, not when the e-mail is opened.
    await withScope(scope(officer), (tx) => notifications.raise(tx, EVENT));
    await withScope(scope(manager), (tx) =>
      notifications.markActed(tx, EVENT.objectType, EVENT.objectId),
    );

    const tomorrow = new Date(Date.now() + 25 * 60 * 60 * 1000);
    const result = await withScope(scope(manager), (tx) =>
      notifications.escalateDue(tx, tomorrow),
    );
    expect(result.escalated).toBe(0);
  });

  it('does not escalate a notification that was merely read', async () => {
    await withScope(scope(officer), (tx) => notifications.raise(tx, EVENT));
    const inbox = await withScope(scope(manager), (tx) =>
      notifications.inboxFor(tx, manager.principal.userId),
    );
    await withScope(scope(manager), (tx) => notifications.markRead(tx, inbox[0]!.id, manager.principal.userId));

    const tomorrow = new Date(Date.now() + 25 * 60 * 60 * 1000);
    const result = await withScope(scope(manager), (tx) =>
      notifications.escalateDue(tx, tomorrow),
    );
    // Reading is not acting — that is the whole point of escalation.
    expect(result.escalated).toBeGreaterThan(0);
  });

  it('escalates only once', async () => {
    await withScope(scope(officer), (tx) => notifications.raise(tx, EVENT));
    const tomorrow = new Date(Date.now() + 25 * 60 * 60 * 1000);

    const first = await withScope(scope(manager), (tx) => notifications.escalateDue(tx, tomorrow));
    const second = await withScope(scope(manager), (tx) =>
      notifications.escalateDue(tx, tomorrow),
    );

    expect(first.escalated).toBe(2);
    expect(second.escalated).toBe(0);
  });

  it('never escalates a rule with no interval', async () => {
    await withScope(scope(officer), (tx) =>
      notifications.raise(tx, {
        eventType: 'journal_entry.rejected',
        objectType: 'journal_entry',
        objectId: 'je-2',
      }),
    );

    const muchLater = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    const result = await withScope(scope(manager), (tx) =>
      notifications.escalateDue(tx, muchLater),
    );
    expect(result.escalated).toBe(0);
  });

  it('will not un-escalate afterwards', async () => {
    await withScope(scope(officer), (tx) => notifications.raise(tx, EVENT));
    const tomorrow = new Date(Date.now() + 25 * 60 * 60 * 1000);
    await withScope(scope(manager), (tx) => notifications.escalateDue(tx, tomorrow));

    expect(
      await rejection(
        ownerPool.query(`update notification set escalated_at = null where escalated_at is not null`),
      ),
    ).toMatch(/cannot be un-happened/);
  });
});

// ---------------------------------------------------------------------------
describe('§21 · a notification is not an approval', () => {
  /** Raises a Chart of Account for approval — a real workflow, not a fixture. */
  async function accountAwaitingApproval() {
    const { rows } = await ownerPool.query(
      `select id from chart_of_account where code = 'A000001'`,
    );
    const account = await withScope(scope(officer), (tx) =>
      coa.createAccount(tx, officer, { name: 'Cash on Hand', parentId: rows[0].id, currencyRestriction: 'IQD' }),
    );
    await withScope(scope(officer), (tx) => coa.submitForApproval(tx, officer, account.id));
    return account.id;
  }

  it('leaves the approval requirement intact when every rule is switched off', async () => {
    // The 01.9 gate, stated exactly. Notifications entirely suppressed.
    await ownerPool.query(`update notification_rule set active = false`);

    const accountId = await accountAwaitingApproval();

    const raised = await withScope(scope(officer), (tx) =>
      notifications.raise(tx, {
        eventType: 'chart_of_account.submitted',
        objectType: 'chart_of_account',
        objectId: accountId,
      }),
    );
    expect(raised.created).toBe(0);

    // The account is still waiting, and still cannot be self-approved.
    const account = await withScope(scope(officer), (tx) => coa.loadAccount(tx, accountId));
    expect(account.approvalStatus).toBe('submitted');
    expect(account.isActive).toBe(false);

    const pending = await withScope(scope(manager), (tx) =>
      workflow.pendingInstanceFor(tx, 'chart_of_account', accountId),
    );
    expect(pending.isComplete).toBe(false);

    // And approving it still requires the manager, exactly as before.
    await withScope(scope(secondManager), (tx) =>
      coa.approve(tx, secondManager, accountId),
    );
    const approved = await withScope(scope(officer), (tx) => coa.loadAccount(tx, accountId));
    expect(approved.approvalStatus).toBe('approved');
  });

  it('leaves the approval requirement intact when delivery fails', async () => {
    notifications.registerSender('email', () => {
      throw new Error('every mail server is down');
    });

    const accountId = await accountAwaitingApproval();
    await withScope(scope(officer), (tx) =>
      notifications.raise(tx, {
        eventType: 'chart_of_account.submitted',
        objectType: 'chart_of_account',
        objectId: accountId,
      }),
    );

    const { rows: created } = await ownerPool.query(`select id from notification order by id`);
    for (const row of created) {
      await withScope(scope(manager), (tx) => notifications.deliver(tx, BigInt(row.id)));
    }

    // Nothing about the document has moved.
    const account = await withScope(scope(officer), (tx) => coa.loadAccount(tx, accountId));
    expect(account.approvalStatus).toBe('submitted');

    // And the person who raised it still cannot approve it themselves.
    await expect(
      withScope(scope(officer), (tx) => coa.approve(tx, officer, accountId)),
    ).rejects.toThrow(/Permission denied/);
  });

  it('cannot reach the workflow tables at all', async () => {
    // §21's boundary, as a structural fact rather than a promise: there is no
    // foreign key from a notification into the approval engine.
    const { rows } = await ownerPool.query(`
      select count(*)::int as n
        from information_schema.table_constraints tc
        join information_schema.constraint_column_usage ccu
          on ccu.constraint_name = tc.constraint_name
       where tc.table_name in ('notification', 'notification_delivery', 'notification_rule')
         and tc.constraint_type = 'FOREIGN KEY'
         and ccu.table_name in ('workflow_instance', 'workflow_decision', 'journal_entry',
                                'chart_of_account', 'document_status_transition')
    `);
    expect(rows[0].n).toBe(0);
  });

  it('records that a task was acted upon without touching the document', async () => {
    const accountId = await accountAwaitingApproval();
    await withScope(scope(officer), (tx) =>
      notifications.raise(tx, {
        eventType: 'chart_of_account.submitted',
        objectType: 'chart_of_account',
        objectId: accountId,
      }),
    );

    const marked = await withScope(scope(manager), (tx) =>
      notifications.markActed(tx, 'chart_of_account', accountId),
    );
    expect(marked).toBeGreaterThan(0);

    // The notification learns from the workflow. The workflow learns nothing:
    // the document is exactly where it was, and still needs its approval.
    const account = await withScope(scope(officer), (tx) => coa.loadAccount(tx, accountId));
    expect(account.approvalStatus).toBe('submitted');
    expect(account.isActive).toBe(false);

    const pending = await withScope(scope(manager), (tx) =>
      workflow.pendingInstanceFor(tx, 'chart_of_account', accountId),
    );
    expect(pending.isComplete).toBe(false);
  });
});
