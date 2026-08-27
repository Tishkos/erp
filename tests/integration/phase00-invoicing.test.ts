/**
 * Phase 00 — Invoicing, the document the foundation is demonstrated on.
 *
 * Phase 0 defines rules rather than modules, so on its own it is a set of
 * claims nobody can check. Invoicing is where the claims are cashed: one
 * document that is numbered by §9, moves through §7's statuses, routes by
 * §5.2 to the manager of *its* department, and leaves §10's history behind.
 * If the invoice round trip works, the foundation works.
 *
 * Nothing here posts to a ledger. That is the accounting phases' business,
 * and an invoice that quietly wrote a journal would be Phase 1 arriving
 * early.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as invoicing from '@/server/services/invoicing';
import * as routing from '@/server/services/department-routing';
import * as workflow from '@/server/services/workflow';
import * as attachments from '@/server/services/attachments';
import { registerAttachmentRuntime } from '@/server/attachments-runtime';
import type { ActorContext } from '@/server/services/administration';

const BAGHDAD = 'BGW';

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
  await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, roleCode]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [
    id,
    BAGHDAD,
  ]);
  for (const [code, isManager] of departments) {
    await ownerPool.query(
      `insert into user_department_scope (user_id, department_code, is_manager) values ($1,$2,$3)`,
      [id, code, isManager],
    );
    if (isManager) {
      await ownerPool.query(`update department set manager_user_id = $1 where code = $2`, [id, code]);
    }
  }
  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) =>
    authz.loadPrincipal(tx, id),
  );
  return { principal, branchCode: BAGHDAD };
}

const scope = (ctx: ActorContext) => ({ userId: ctx.principal.userId, branchCode: BAGHDAD });

const header = {
  customerName: 'Al Rafidain Trading',
  currency: 'IQD',
  departmentCode: 'SLS',
  documentDate: '2026-03-04',
};

/**
 * Raise an invoice the way the screens do: open it, fill in the header, put
 * something on it. Returns the row as it stands, ready to submit.
 */
async function raise(
  ctx: ActorContext,
  overrides: Partial<typeof header> & { line?: invoicing.LineInput | null } = {},
) {
  const { line, ...fields } = overrides;
  const opened = await withScope(scope(ctx), (tx) => invoicing.start(tx, ctx, fields.departmentCode));
  await withScope(scope(ctx), (tx) =>
    invoicing.update(tx, ctx, opened.id, { ...header, ...fields }),
  );
  if (line !== null) {
    await withScope(scope(ctx), (tx) =>
      invoicing.addLine(tx, ctx, opened.id, line ?? { description: 'Consultancy', quantity: '1', unitPrice: '1250.50' }),
    );
  }
  return opened;
}

/** What the audit trail recorded about one object, oldest first. */
async function auditFor(objectId: string): Promise<string[]> {
  const { rows } = await ownerPool.query<{ action: string }>(
    `select action from audit_event where object_id = $1 order by occurred_at, id`,
    [objectId],
  );
  return rows.map((r) => r.action);
}

/** The invoice as the database has it. */
async function byId(id: string) {
  const { rows } = await ownerPool.query<{ amount: string; status: string }>(
    'select amount, status from invoice where id = $1',
    [id],
  );
  return rows[0]!;
}

const statusOf = async (id: string): Promise<string> =>
  (await ownerPool.query<{ status: string }>(`select status from invoice where id = $1`, [id]))
    .rows[0]!.status;

beforeEach(async () => {
  await resetTestData();
  routing.clearExecutionEffects();
  invoicing.registerInvoiceEffect();
  // §21 needs somewhere to put files, something to scan them, and an answer
  // to "may this person see the parent?" — the same three the app registers.
  registerAttachmentRuntime();

  await seedBranch(BAGHDAD, 'Baghdad');
  await ownerPool.query(
    `insert into department (code, name, is_finance) values
       ('SLS','Sales',false), ('FIN','Finance',true)`,
  );
});

// ---------------------------------------------------------------------------
describe('§9 · the number comes from the sequence, and is never reused', () => {
  it('numbers each invoice in turn, scoped to the year', async () => {
    const author = await createUser([['SLS', false]]);
    await createUser([['SLS', true]]);

    const first = await raise(author);
    const second = await raise(author);

    expect(first.documentNo).toBe('INV-2026-00001');
    expect(second.documentNo).toBe('INV-2026-00002');
  });

  it('does not hand the same number to a cancelled invoice', async () => {
    const author = await createUser([['SLS', false]], 'accounting_manager');
    await createUser([['SLS', true]]);

    const first = await raise(author);
    await withScope(scope(author), (tx) => invoicing.cancel(tx, author, first.id, 'raised twice'));
    const next = await raise(author);

    expect(next.documentNo).not.toBe(first.documentNo);
  });
});

// ---------------------------------------------------------------------------
describe('§5.2 · an employee submits, the department’s manager approves', () => {
  it('carries a draft to approved through the two people it takes', async () => {
    // The round trip the phase is judged on: an ordinary employee raises it,
    // and it is the manager of the invoice's department who finishes it.
    const employee = await createUser([['SLS', false]]);
    const manager = await createUser([['SLS', true]], 'accounting_manager');

    const created = await raise(employee);
    expect(created.status).toBe('draft');

    const submitted = await withScope(scope(employee), (tx) =>
      invoicing.submit(tx, employee, created.id),
    );
    expect(submitted.outcome).toBe('submit_to_department_manager');
    expect(submitted.assignedToUserId).toBe(manager.principal.userId);
    expect(await statusOf(created.id)).toBe('submitted');

    await withScope(scope(manager), (tx) => invoicing.approve(tx, manager, created.id));
    expect(await statusOf(created.id)).toBe('approved');
  });

  it('routes to the manager of the invoice’s department, not the author’s', async () => {
    const salesManager = await createUser([['SLS', true]], 'accounting_manager');
    await createUser([['FIN', true]], 'accounting_manager'); // must not receive it
    const author = await createUser([
      ['FIN', false],
      ['SLS', false],
    ]);

    const created = await raise(author);
    const submitted = await withScope(scope(author), (tx) =>
      invoicing.submit(tx, author, created.id),
    );

    expect(submitted.assignedToUserId).toBe(salesManager.principal.userId);
  });

  it('lets the manager of the department finalise their own in one act', async () => {
    // §5.2's other half — no self-approval theatre when the manager is the
    // one raising it in the department they manage.
    const manager = await createUser([['SLS', true]], 'accounting_manager');

    const created = await raise(manager);
    const result = await withScope(scope(manager), (tx) =>
      invoicing.submit(tx, manager, created.id),
    );

    expect(result.outcome).toBe('finalise_directly');
    expect(await statusOf(created.id)).toBe('approved');
  });

  it('refuses approval by somebody who does not manage that department', async () => {
    const employee = await createUser([['SLS', false]]);
    await createUser([['SLS', true]], 'accounting_manager');
    const outsider = await createUser([['FIN', true]], 'accounting_manager');

    const created = await raise(employee);
    await withScope(scope(employee), (tx) => invoicing.submit(tx, employee, created.id));

    const message = await rejection(
      withScope(scope(outsider), (tx) => invoicing.approve(tx, outsider, created.id)),
    );
    expect(message).toBeTruthy();
    expect(await statusOf(created.id)).toBe('submitted');
  });

  it('will not submit into a department that has no manager', async () => {
    // Phase 0 requirement 6: the flow is defined by the department, so a
    // department without a manager has nowhere to send the document.
    const employee = await createUser([['SLS', false]]);

    const created = await raise(employee);
    const message = await rejection(
      withScope(scope(employee), (tx) => invoicing.submit(tx, employee, created.id)),
    );

    expect(message).toBeTruthy();
    expect(await statusOf(created.id)).toBe('draft');
  });
});

// ---------------------------------------------------------------------------
describe('§7 · the statuses are the only way through', () => {
  it('sends a refused invoice back to Draft, with the reason on the record', async () => {
    // §7 has five states and Rejected is not one of them. A refusal is
    // something that happened to the invoice, not a place it sits — so it
    // goes back to the person who raised it, editable, with the reason.
    const employee = await createUser([['SLS', false]]);
    const manager = await createUser([['SLS', true]], 'accounting_manager');

    const created = await raise(employee);
    await withScope(scope(employee), (tx) => invoicing.submit(tx, employee, created.id));
    await withScope(scope(manager), (tx) =>
      invoicing.reject(tx, manager, created.id, 'the customer reference is wrong'),
    );

    expect(await statusOf(created.id)).toBe('draft');
    const { rows } = await ownerPool.query<{ returned_reason: string | null }>(
      'select returned_reason from invoice where id = $1',
      [created.id],
    );
    expect(rows[0]!.returned_reason).toBe('the customer reference is wrong');

    const decisions = await withScope(scope(manager), (tx) =>
      workflow.historyFor(tx, invoicing.DOCUMENT_TYPE, created.id),
    );
    expect(decisions.find((d) => d.decision === 'rejected')?.reason).toBe(
      'the customer reference is wrong',
    );
  });

  it('clears the returned note when it is sent up again', async () => {
    const employee = await createUser([['SLS', false]]);
    const manager = await createUser([['SLS', true]], 'accounting_manager');

    const created = await raise(employee);
    await withScope(scope(employee), (tx) => invoicing.submit(tx, employee, created.id));
    await withScope(scope(manager), (tx) => invoicing.reject(tx, manager, created.id, 'wrong total'));
    await withScope(scope(employee), (tx) => invoicing.submit(tx, employee, created.id));

    const { rows } = await ownerPool.query<{ returned_reason: string | null; status: string }>(
      'select returned_reason, status from invoice where id = $1',
      [created.id],
    );
    expect(rows[0]!.status).toBe('submitted');
    expect(rows[0]!.returned_reason).toBeNull();
  });

  it('reverses an approved invoice rather than deleting or editing it', async () => {
    const manager = await createUser([['SLS', true]], 'accounting_manager');
    const created = await raise(manager);
    await withScope(scope(manager), (tx) => invoicing.submit(tx, manager, created.id));
    expect(await statusOf(created.id)).toBe('approved');

    await withScope(scope(manager), (tx) =>
      invoicing.reverse(tx, manager, created.id, 'billed to the wrong customer'),
    );
    expect(await statusOf(created.id)).toBe('reversed');
    expect(await auditFor(created.id)).toContain('invoice.reversed');
  });

  it('refuses to cancel an invoice that was already approved', async () => {
    // Cancellation is for a document nobody has decided on. After approval
    // the only way back is a reversal, which leaves both facts standing.
    const manager = await createUser([['SLS', true]], 'accounting_manager');
    const created = await raise(manager);
    await withScope(scope(manager), (tx) => invoicing.submit(tx, manager, created.id));

    const message = await rejection(
      withScope(scope(manager), (tx) => invoicing.cancel(tx, manager, created.id, 'changed my mind')),
    );
    expect(message).toBeTruthy();
    expect(await statusOf(created.id)).toBe('approved');
  });

  it('refuses to reject without a reason', async () => {
    const employee = await createUser([['SLS', false]]);
    const manager = await createUser([['SLS', true]], 'accounting_manager');

    const created = await raise(employee);
    await withScope(scope(employee), (tx) => invoicing.submit(tx, employee, created.id));

    const message = await rejection(
      withScope(scope(manager), (tx) => invoicing.reject(tx, manager, created.id, '   ')),
    );
    expect(message).toBeTruthy();
    expect(await statusOf(created.id)).toBe('submitted');
  });

  it('will not edit an invoice once it has left draft', async () => {
    const employee = await createUser([['SLS', false]]);
    await createUser([['SLS', true]], 'accounting_manager');

    const created = await raise(employee);
    await withScope(scope(employee), (tx) => invoicing.submit(tx, employee, created.id));

    const message = await rejection(
      withScope(scope(employee), (tx) =>
        invoicing.update(tx, employee, created.id, { ...header, customerName: 'Someone else' }),
      ),
    );
    expect(message).toBeTruthy();
  });

  it('will not approve a draft that was never submitted', async () => {
    const manager = await createUser([['FIN', true]], 'accounting_manager');
    const employee = await createUser([['SLS', false]]);
    await createUser([['SLS', true]], 'accounting_manager');

    const created = await raise(employee);
    const message = await rejection(
      withScope(scope(manager), (tx) => invoicing.approve(tx, manager, created.id)),
    );
    expect(message).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
describe('§1.1 and §10 · nothing is deleted, everything is remembered', () => {
  it('refuses to delete an invoice that has been submitted', async () => {
    // Since 0169 a *draft* can be thrown away — see `discardDraft` below. Once
    // it has been submitted it is a document, and §7 keeps it: the guard
    // refuses the delete even to the owner of the database.
    const author = await createUser([['SLS', false]]);
    await createUser([['SLS', true]]);
    const created = await raise(author);
    await withScope(scope(author), (tx) => invoicing.submit(tx, author, created.id));

    await expect(
      ownerPool.query(`delete from invoice where id = $1`, [created.id]),
    ).rejects.toThrow(/not a draft/);
  });

  it('lets a draft be discarded, and remembers that it was', async () => {
    const author = await createUser([['SLS', false]]);
    const created = await raise(author);

    const { documentNo } = await withScope(scope(author), (tx) =>
      invoicing.discardDraft(tx, author, created.id),
    );
    expect(documentNo).toBe(created.documentNo);

    const { rows } = await ownerPool.query<{ n: string }>(
      `select count(*) as n from invoice where id = $1`,
      [created.id],
    );
    expect(Number(rows[0]!.n)).toBe(0);

    // The rows are gone; the fact of them is not. That is what keeps §7 true
    // — a person can still be told what happened to this number.
    expect(await auditFor(created.id)).toContain('invoice.discarded');
  });

  it('will not discard one that has left draft', async () => {
    const author = await createUser([['SLS', false]]);
    await createUser([['SLS', true]]);
    const created = await raise(author);
    await withScope(scope(author), (tx) => invoicing.submit(tx, author, created.id));

    await expect(
      withScope(scope(author), (tx) => invoicing.discardDraft(tx, author, created.id)),
    ).rejects.toThrow(/not a draft/);
  });

  it('writes every step of the round trip to the audit trail', async () => {
    const employee = await createUser([['SLS', false]]);
    const manager = await createUser([['SLS', true]], 'accounting_manager');

    const created = await raise(employee);
    await withScope(scope(employee), (tx) =>
      invoicing.update(tx, employee, created.id, { ...header, customerName: 'Al Rafidain Co.' }),
    );
    await withScope(scope(employee), (tx) => invoicing.submit(tx, employee, created.id));
    await withScope(scope(manager), (tx) => invoicing.approve(tx, manager, created.id));

    expect(await auditFor(created.id)).toEqual([
      'invoice.created',
      'invoice.updated',
      'invoice.line_added',
      'invoice.updated',
      // The routing engine records its own half of the story, so the trail
      // says both what the document did and how it was routed there.
      'workflow.submitted_to_department_manager',
      'invoice.submitted',
      'invoice.approved',
      'workflow.approved_by_department_manager',
    ]);
  });

  it('records who refused, not only who succeeded', async () => {
    // §10 — a refusal is a fact about the system, and the trail is the only
    // place it survives.
    // A system administrator may see and approve an invoice but not raise
    // one — the closest thing Phase 0 ships to somebody without the verb.
    const stranger = await createUser([['SLS', false]], 'system_administrator');
    const message = await rejection(
      withScope(scope(stranger), (tx) => invoicing.start(tx, stranger, 'SLS')),
    );
    expect(message).toBeTruthy();

    const { rows } = await ownerPool.query<{ outcome: string }>(
      `select outcome from audit_event where actor_user_id = $1 and object_type = 'invoice'`,
      [stranger.principal.userId],
    );
    expect(rows.some((r) => r.outcome === 'denied')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('what an invoice will not accept', () => {
  it('refuses a line whose quantity or price is not a number it can charge', async () => {
    const author = await createUser([['SLS', false]]);
    const opened = await raise(author, { line: null });

    for (const line of [
      { description: 'x', quantity: '0', unitPrice: '10' },
      { description: 'x', quantity: '-2', unitPrice: '10' },
      { description: 'x', quantity: 'abc', unitPrice: '10' },
      { description: 'x', quantity: '1', unitPrice: '-5' },
      { description: '   ', quantity: '1', unitPrice: '10' },
    ]) {
      const message = await rejection(
        withScope(scope(author), (tx) => invoicing.addLine(tx, author, opened.id, line)),
      );
      expect(message, JSON.stringify(line)).toBeTruthy();
    }
  });

  it('refuses a department that does not exist or is closed', async () => {
    const author = await createUser([['SLS', false]]);
    await ownerPool.query(`update department set active = false where code = 'FIN'`);
    const opened = await raise(author, { line: null });

    for (const departmentCode of ['NOPE', 'FIN']) {
      const message = await rejection(
        withScope(scope(author), (tx) =>
          invoicing.update(tx, author, opened.id, { ...header, departmentCode }),
        ),
      );
      expect(message, departmentCode).toBeTruthy();
    }
  });

  it('refuses a currency that is not a three-letter code', async () => {
    const author = await createUser([['SLS', false]]);
    const opened = await raise(author, { line: null });
    const message = await rejection(
      withScope(scope(author), (tx) =>
        invoicing.update(tx, author, opened.id, { ...header, currency: 'DINAR' }),
      ),
    );
    expect(message).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
describe('the lines are the total', () => {
  it('sums the lines into the invoice, and re-sums when one is taken off', async () => {
    const author = await createUser([['SLS', false]]);
    const opened = await raise(author, { line: { description: 'Design', quantity: '2', unitPrice: '125.50' } });
    expect((await byId(opened.id)).amount).toBe('251.0000');

    const second = await withScope(scope(author), (tx) =>
      invoicing.addLine(tx, author, opened.id, { description: 'Print', quantity: '3', unitPrice: '10' }),
    );
    expect((await byId(opened.id)).amount).toBe('281.0000');

    await withScope(scope(author), (tx) => invoicing.removeLine(tx, author, opened.id, second.id));
    expect((await byId(opened.id)).amount).toBe('251.0000');
  });

  it('numbers the lines in the order they were entered', async () => {
    const author = await createUser([['SLS', false]]);
    const opened = await raise(author, { line: { description: 'First', quantity: '1', unitPrice: '1' } });
    await withScope(scope(author), (tx) =>
      invoicing.addLine(tx, author, opened.id, { description: 'Second', quantity: '1', unitPrice: '2' }),
    );

    const lines = await withScope(scope(author), (tx) => invoicing.linesFor(tx, opened.id));
    expect(lines.map((l) => [l.lineNo, l.description])).toEqual([
      [1, 'First'],
      [2, 'Second'],
    ]);
  });

  it('will not send an invoice with nothing on it for approval', async () => {
    const employee = await createUser([['SLS', false]]);
    await createUser([['SLS', true]], 'accounting_manager');
    const opened = await raise(employee, { line: null });

    const message = await rejection(
      withScope(scope(employee), (tx) => invoicing.submit(tx, employee, opened.id)),
    );
    expect(message).toBeTruthy();
    expect(await statusOf(opened.id)).toBe('draft');
  });

  it('will not send one without a customer', async () => {
    const employee = await createUser([['SLS', false]]);
    await createUser([['SLS', true]], 'accounting_manager');
    const opened = await withScope(scope(employee), (tx) => invoicing.start(tx, employee, 'SLS'));
    await withScope(scope(employee), (tx) =>
      invoicing.addLine(tx, employee, opened.id, { description: 'Work', quantity: '1', unitPrice: '10' }),
    );

    const message = await rejection(
      withScope(scope(employee), (tx) => invoicing.submit(tx, employee, opened.id)),
    );
    expect(message).toBeTruthy();
  });

  it('refuses to touch the lines once it has left draft', async () => {
    // The database enforces this, not only the service — §7's rule about an
    // approved document holds however the row is reached.
    const employee = await createUser([['SLS', false]]);
    await createUser([['SLS', true]], 'accounting_manager');
    const opened = await raise(employee);
    await withScope(scope(employee), (tx) => invoicing.submit(tx, employee, opened.id));

    const message = await rejection(
      withScope(scope(employee), (tx) =>
        invoicing.addLine(tx, employee, opened.id, { description: 'Sneaked in', quantity: '1', unitPrice: '9999' }),
      ),
    );
    expect(message).toBeTruthy();

    await expect(
      ownerPool.query(
        `insert into invoice_line (invoice_id, line_no, description, quantity, unit_price, line_total)
         values ($1, 99, 'Straight into the table', 1, 9999, 9999)`,
        [opened.id],
      ),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
describe('§21 · documents stapled to the invoice', () => {
  it('accepts a file, lists it, and hands it back to somebody who may see it', async () => {
    const employee = await createUser([['SLS', false]]);
    const created = await raise(employee);

    const content = Buffer.from('%PDF-1.4\nthe signed order\n');
    const result = await withScope(scope(employee), (tx) =>
      attachments.upload(tx, employee, {
        objectType: invoicing.PERMISSION_OBJECT,
        objectId: created.id,
        fileName: 'purchase-order.pdf',
        content,
      }),
    );
    expect(result.scanStatus).toBe('clean');
    expect(result.quarantined).toBe(false);

    const listed = await withScope(scope(employee), (tx) =>
      attachments.currentFor(tx, invoicing.PERMISSION_OBJECT, created.id),
    );
    expect(listed.map((a) => a.fileName)).toEqual(['purchase-order.pdf']);

    const fetched = await withScope(scope(employee), (tx) =>
      attachments.download(tx, employee, result.attachmentId),
    );
    expect(fetched.content.equals(content)).toBe(true);
  });

  it('refuses a program however it is named', async () => {
    const employee = await createUser([['SLS', false]]);
    const created = await raise(employee);

    // A Windows executable calling itself a PDF — §21's content inspection.
    const message = await rejection(
      withScope(scope(employee), (tx) =>
        attachments.upload(tx, employee, {
          objectType: invoicing.PERMISSION_OBJECT,
          objectId: created.id,
          fileName: 'invoice.pdf',
          content: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64)]),
        }),
      ),
    );
    expect(message).toBeTruthy();
  });

  it('quarantines a file that fails its scan instead of attaching it', async () => {
    const employee = await createUser([['SLS', false]]);
    const created = await raise(employee);

    // The industry's harmless stand-in for a virus. The backslash is part of
    // the signature, so it is escaped here — a version without it is just a
    // text file, which is exactly the mistake this comment exists to prevent.
    const eicar = Buffer.from(
      'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
    );
    const result = await withScope(scope(employee), (tx) =>
      attachments.upload(tx, employee, {
        objectType: invoicing.PERMISSION_OBJECT,
        objectId: created.id,
        fileName: 'notes.txt',
        content: eicar,
      }),
    );
    expect(result.scanStatus).toBe('infected');

    const listed = await withScope(scope(employee), (tx) =>
      attachments.currentFor(tx, invoicing.PERMISSION_OBJECT, created.id),
    );
    expect(listed).toHaveLength(0);
  });

  it('will not hand an invoice attachment to somebody who cannot see invoices', async () => {
    // §21's acceptance criterion — the attachment inherits the parent's rules,
    // so knowing the id is not enough.
    const employee = await createUser([['SLS', false]]);
    const created = await raise(employee);
    const { attachmentId } = await withScope(scope(employee), (tx) =>
      attachments.upload(tx, employee, {
        objectType: invoicing.PERMISSION_OBJECT,
        objectId: created.id,
        fileName: 'terms.pdf',
        content: Buffer.from('%PDF-1.4 terms'),
      }),
    );

    const stranger = await createUser([['FIN', false]], 'system_administrator');
    await ownerPool.query(
      "delete from role_grant where role_code = 'system_administrator' and object = 'invoice'",
    );
    const refreshed = await withScope(scope(stranger), (tx) =>
      authz.loadPrincipal(tx, stranger.principal.userId),
    );

    const message = await rejection(
      withScope(scope(stranger), (tx) =>
        attachments.download(tx, { ...stranger, principal: refreshed }, attachmentId),
      ),
    );
    expect(message).toBeTruthy();
  });
});
