/**
 * Phase 01.8 — attachments, against a real PostgreSQL instance.
 *
 * §21's acceptance criterion is the one worth building the file around: "Users
 * cannot access an attachment when they cannot access its parent record." An
 * attachment table with its own permissions would be a way around every
 * permission in the system, so it has none of its own — every read asks the
 * parent's module.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as attachments from '@/server/services/attachments';
import * as authz from '@/server/services/authorization';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { AttachmentAccessError, AttachmentRejectedError } from '@domain/attachments';

const BAGHDAD = 'BGW';
const PARENT = { objectType: 'journal_entry', objectId: 'je-1' };

const pdf = (marker = 'v1') =>
  Buffer.concat([Buffer.from([0x25, 0x50, 0x44, 0x46]), Buffer.from(`-1.7 ${marker}`)]);
const windowsExe = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.from('payload')]);

let officer: ActorContext;
let manager: ActorContext;

/** An in-memory store. Real deployments register S3 or R2 (TECHSTACK A7). */
function inMemoryStorage() {
  const objects = new Map<string, Buffer>();
  return {
    adapter: {
      put: async (key: string, content: Buffer) => {
        objects.set(key, content);
      },
      get: async (key: string) => objects.get(key) ?? null,
    },
    objects,
  };
}

let store: ReturnType<typeof inMemoryStorage>;

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

/** Who the parent record lets in. The test controls this, as a module would. */
let permittedUserIds = new Set<string>();

beforeEach(async () => {
  await resetTestData();
  attachments.clearScanner();
  attachments.clearStorage();
  attachments.clearParentAccessChecks();

  await seedBranch(BAGHDAD, 'Baghdad');
  officer = await createUser('accounting_officer');
  manager = await createUser('accounting_manager');

  store = inMemoryStorage();
  attachments.registerStorage(store.adapter);
  attachments.registerScanner(() => ({ status: 'clean' }));

  permittedUserIds = new Set([officer.principal.userId, manager.principal.userId]);
  attachments.registerParentAccessCheck('journal_entry', (_tx, principal) =>
    permittedUserIds.has(principal.userId),
  );
});

afterEach(() => {
  attachments.clearScanner();
  attachments.clearStorage();
  attachments.clearParentAccessChecks();
});

// ---------------------------------------------------------------------------
describe('§21 · the upload pipeline', () => {
  it('accepts a genuine document and records what it actually is', async () => {
    const result = await withScope(scope(officer), (tx) =>
      attachments.upload(tx, officer, { ...PARENT, fileName: 'invoice.pdf', content: pdf() }),
    );

    expect(result.quarantined).toBe(false);
    expect(result.version).toBe(1);

    const { rows } = await ownerPool.query(
      `select file_name, content_type, size_bytes, sha256, storage_key from attachment`,
    );
    expect(rows[0]).toMatchObject({ file_name: 'invoice.pdf', content_type: 'application/pdf' });
    expect(rows[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    // The key comes from the attachment's own id, never from the file name.
    expect(rows[0].storage_key).not.toContain('invoice');
  });

  it('rejects an executable disguised as an invoice, on content', async () => {
    await expect(
      withScope(scope(officer), (tx) =>
        attachments.upload(tx, officer, {
          ...PARENT,
          fileName: 'invoice.pdf',
          content: windowsExe,
        }),
      ),
    ).rejects.toThrow(AttachmentRejectedError);

    const { rows } = await ownerPool.query(`select count(*)::int as n from attachment`);
    expect(rows[0].n).toBe(0);
  });

  it('refuses uploads entirely when no scanner is configured (§21)', async () => {
    // A default that accepted everything would satisfy the type system while
    // removing the control.
    attachments.clearScanner();

    await expect(
      withScope(scope(officer), (tx) =>
        attachments.upload(tx, officer, { ...PARENT, fileName: 'invoice.pdf', content: pdf() }),
      ),
    ).rejects.toThrow(/No malware scanner is configured/);
  });

  it('quarantines a file that fails its scan and never links it to the parent', async () => {
    attachments.registerScanner(() => ({ status: 'infected', detail: 'EICAR test signature' }));

    const result = await withScope(scope(officer), (tx) =>
      attachments.upload(tx, officer, { ...PARENT, fileName: 'invoice.pdf', content: pdf() }),
    );

    expect(result.quarantined).toBe(true);
    expect(result.scanStatus).toBe('infected');

    // The row exists so the attempt is auditable …
    const { rows } = await ownerPool.query(`select scan_status, scan_detail from attachment`);
    expect(rows[0]).toMatchObject({ scan_status: 'infected', scan_detail: 'EICAR test signature' });

    // … and the document does not show it.
    const current = await withScope(scope(officer), (tx) =>
      attachments.currentFor(tx, PARENT.objectType, PARENT.objectId),
    );
    expect(current).toHaveLength(0);

    // Nor can anyone download it.
    await expect(
      withScope(scope(officer), (tx) =>
        attachments.download(tx, officer, result.attachmentId),
      ),
    ).rejects.toThrow(/did not pass its malware scan/);
  });

  it('audits the upload and the quarantine differently', async () => {
    await withScope(scope(officer), (tx) =>
      attachments.upload(tx, officer, { ...PARENT, fileName: 'clean.pdf', content: pdf() }),
    );

    attachments.registerScanner(() => ({ status: 'infected', detail: 'signature match' }));
    await withScope(scope(officer), (tx) =>
      attachments.upload(tx, officer, { ...PARENT, fileName: 'bad.pdf', content: pdf('v2') }),
    );

    const { rows } = await ownerPool.query(
      `select action, outcome from audit_event where object_type = 'attachment' order by id`,
    );
    expect(rows.map((r) => r.action)).toEqual([
      'attachment.uploaded',
      'attachment.quarantined',
    ]);
    expect(rows[1].outcome).toBe('failure');
  });
});

// ---------------------------------------------------------------------------
describe('§21 · access is inherited from the parent record', () => {
  it('lets someone who can see the parent download it', async () => {
    const { attachmentId } = await withScope(scope(officer), (tx) =>
      attachments.upload(tx, officer, { ...PARENT, fileName: 'invoice.pdf', content: pdf() }),
    );

    const file = await withScope(scope(officer), (tx) =>
      attachments.download(tx, officer, attachmentId),
    );
    expect(file.fileName).toBe('invoice.pdf');
    expect(file.content.equals(pdf())).toBe(true);
  });

  it('refuses someone who cannot see the parent, even knowing the object id', async () => {
    // §21's acceptance criterion. Knowing the id is not access.
    const { attachmentId } = await withScope(scope(officer), (tx) =>
      attachments.upload(tx, officer, { ...PARENT, fileName: 'invoice.pdf', content: pdf() }),
    );

    const outsider = await createUser('accounting_officer');
    // The parent's module does not admit them.

    await expect(
      withScope(scope(outsider), (tx) => attachments.download(tx, outsider, attachmentId)),
    ).rejects.toThrow(AttachmentAccessError);
  });

  it('refuses a parent type nobody has registered — deny by default (§25)', async () => {
    // Otherwise attaching to an unregistered object type would be a way to read
    // a document with no permission at all.
    await expect(
      withScope(scope(officer), (tx) =>
        attachments.upload(tx, officer, {
          objectType: 'secret_thing',
          objectId: 'x',
          fileName: 'invoice.pdf',
          content: pdf(),
        }),
      ),
    ).rejects.toThrow(/cannot be determined, so it is refused/);
  });

  it('refuses to attach to a record the uploader cannot see', async () => {
    const outsider = await createUser('accounting_officer');

    await expect(
      withScope(scope(outsider), (tx) =>
        attachments.upload(tx, outsider, { ...PARENT, fileName: 'invoice.pdf', content: pdf() }),
      ),
    ).rejects.toThrow(AttachmentAccessError);
  });

  it('records the refusal, not only the success (§21)', async () => {
    const { attachmentId } = await withScope(scope(officer), (tx) =>
      attachments.upload(tx, officer, { ...PARENT, fileName: 'invoice.pdf', content: pdf() }),
    );
    const outsider = await createUser('accounting_officer');

    await expect(
      withScope(scope(outsider), (tx) => attachments.download(tx, outsider, attachmentId)),
    ).rejects.toThrow();

    const log = await withScope(scope(officer), (tx) =>
      attachments.accessLogFor(tx, attachmentId),
    );
    const denied = log.filter((entry) => entry.denied);
    expect(denied).toHaveLength(1);
    expect(denied[0]!.userId).toBe(outsider.principal.userId);
    expect(denied[0]!.reason).toMatch(/cannot access the record it belongs to/);
  });

  it('records every download', async () => {
    const { attachmentId } = await withScope(scope(officer), (tx) =>
      attachments.upload(tx, officer, { ...PARENT, fileName: 'invoice.pdf', content: pdf() }),
    );

    await withScope(scope(officer), (tx) => attachments.download(tx, officer, attachmentId));
    await withScope(scope(manager), (tx) => attachments.download(tx, manager, attachmentId));

    const log = await withScope(scope(officer), (tx) =>
      attachments.accessLogFor(tx, attachmentId),
    );
    expect(log.filter((e) => !e.denied)).toHaveLength(2);
  });

  it('holds the access log append-only', async () => {
    const { attachmentId } = await withScope(scope(officer), (tx) =>
      attachments.upload(tx, officer, { ...PARENT, fileName: 'invoice.pdf', content: pdf() }),
    );
    await withScope(scope(officer), (tx) => attachments.download(tx, officer, attachmentId));

    expect(await rejection(ownerPool.query(`delete from attachment_access`))).toMatch(
      /append-only/i,
    );
  });
});

// ---------------------------------------------------------------------------
describe('§21 · later versions do not overwrite earlier ones', () => {
  async function uploadVersionOne() {
    return withScope(scope(officer), (tx) =>
      attachments.upload(tx, officer, { ...PARENT, fileName: 'invoice.pdf', content: pdf('v1') }),
    );
  }

  it('keeps both versions, and both stay retrievable', async () => {
    // The 01.8 gate, stated exactly.
    const first = await uploadVersionOne();
    const second = await withScope(scope(officer), (tx) =>
      attachments.upload(tx, officer, {
        ...PARENT,
        fileName: 'invoice.pdf',
        content: pdf('v2'),
        supersedesId: first.attachmentId,
      }),
    );

    expect(second.version).toBe(2);

    const older = await withScope(scope(officer), (tx) =>
      attachments.download(tx, officer, first.attachmentId),
    );
    const newer = await withScope(scope(officer), (tx) =>
      attachments.download(tx, officer, second.attachmentId),
    );

    expect(older.content.toString()).toContain('v1');
    expect(newer.content.toString()).toContain('v2');
    // Two objects in the store, not one overwritten.
    expect(store.objects.size).toBe(2);
  });

  it('shows only the current version on the document', async () => {
    const first = await uploadVersionOne();
    await withScope(scope(officer), (tx) =>
      attachments.upload(tx, officer, {
        ...PARENT,
        fileName: 'invoice.pdf',
        content: pdf('v2'),
        supersedesId: first.attachmentId,
      }),
    );

    const current = await withScope(scope(officer), (tx) =>
      attachments.currentFor(tx, PARENT.objectType, PARENT.objectId),
    );
    expect(current).toHaveLength(1);
    expect(current[0]!.version).toBe(2);
  });

  it('walks the whole chain, oldest first', async () => {
    const first = await uploadVersionOne();
    const second = await withScope(scope(officer), (tx) =>
      attachments.upload(tx, officer, {
        ...PARENT,
        fileName: 'invoice.pdf',
        content: pdf('v2'),
        supersedesId: first.attachmentId,
      }),
    );
    await withScope(scope(officer), (tx) =>
      attachments.upload(tx, officer, {
        ...PARENT,
        fileName: 'invoice.pdf',
        content: pdf('v3'),
        supersedesId: second.attachmentId,
      }),
    );

    const chain = await withScope(scope(officer), (tx) =>
      attachments.versionsOf(tx, second.attachmentId),
    );
    expect(chain.map((a) => a.version)).toEqual([1, 2, 3]);
  });

  it('refuses to branch the chain', async () => {
    const first = await uploadVersionOne();
    await withScope(scope(officer), (tx) =>
      attachments.upload(tx, officer, {
        ...PARENT,
        fileName: 'invoice.pdf',
        content: pdf('v2'),
        supersedesId: first.attachmentId,
      }),
    );

    // A second replacement of version 1 would make "the current version"
    // ambiguous.
    await expect(
      withScope(scope(officer), (tx) =>
        attachments.upload(tx, officer, {
          ...PARENT,
          fileName: 'invoice.pdf',
          content: pdf('v2-alt'),
          supersedesId: first.attachmentId,
        }),
      ),
    ).rejects.toThrow(/already been superseded/);
  });

  it('refuses to alter an attachment in place, at the database', async () => {
    const first = await uploadVersionOne();

    expect(
      await rejection(
        ownerPool.query(`update attachment set file_name = 'other.pdf' where id = $1`, [
          first.attachmentId,
        ]),
      ),
    ).toMatch(/cannot be altered/);

    expect(
      await rejection(ownerPool.query(`delete from attachment where id = $1`, [first.attachmentId])),
    ).toMatch(/append-only/i);
  });
});

// ---------------------------------------------------------------------------
describe('§21 · retention and legal hold', () => {
  async function uploadWithRetention(retentionUntil: string | null) {
    return withScope(scope(officer), (tx) =>
      attachments.upload(tx, officer, {
        ...PARENT,
        fileName: 'contract.pdf',
        content: pdf(),
        retentionUntil,
      }),
    );
  }

  it('disposes of a document past its retention date, and records who did it', async () => {
    const { attachmentId } = await uploadWithRetention('2026-01-01');

    await withScope(scope(manager), (tx) =>
      attachments.dispose(tx, manager, attachmentId, 'Retention period elapsed', '2026-08-17'),
    );

    const { rows } = await ownerPool.query(
      `select disposed_at, disposed_by from attachment where id = $1`,
      [attachmentId],
    );
    expect(rows[0].disposed_at).not.toBeNull();
    expect(rows[0].disposed_by).toBe(manager.principal.userId);

    await expect(
      withScope(scope(officer), (tx) => attachments.download(tx, officer, attachmentId)),
    ).rejects.toThrow(/disposed of under retention/);
  });

  it('refuses disposal before the retention date', async () => {
    const { attachmentId } = await uploadWithRetention('2030-01-01');

    await expect(
      withScope(scope(manager), (tx) =>
        attachments.dispose(tx, manager, attachmentId, 'Tidying up', '2026-08-17'),
      ),
    ).rejects.toThrow(/retained until 2030-01-01/);
  });

  it('refuses disposal under legal hold, whatever the retention date says', async () => {
    const { attachmentId } = await uploadWithRetention('2000-01-01');
    await withScope(scope(manager), (tx) =>
      attachments.setLegalHold(tx, manager, attachmentId, true, 'Litigation ref L-2026-3'),
    );

    await expect(
      withScope(scope(manager), (tx) =>
        attachments.dispose(tx, manager, attachmentId, 'Retention elapsed', '2026-08-17'),
      ),
    ).rejects.toThrow(/under legal hold/);
  });

  it('audits placing and lifting a hold, with its reason', async () => {
    const { attachmentId } = await uploadWithRetention(null);
    await withScope(scope(manager), (tx) =>
      attachments.setLegalHold(tx, manager, attachmentId, true, 'Litigation ref L-2026-3'),
    );
    await withScope(scope(manager), (tx) =>
      attachments.setLegalHold(tx, manager, attachmentId, false, 'Matter closed'),
    );

    const { rows } = await ownerPool.query(
      `select action, reason from audit_event
        where action like 'attachment.legal_hold%' order by id`,
    );
    expect(rows.map((r) => r.action)).toEqual([
      'attachment.legal_hold_placed',
      'attachment.legal_hold_lifted',
    ]);
    expect(rows[0].reason).toBe('Litigation ref L-2026-3');
  });

  it('refuses an Officer disposing of a document — that is an administrative act', async () => {
    const { attachmentId } = await uploadWithRetention('2000-01-01');

    await expect(
      withScope(scope(officer), (tx) =>
        attachments.dispose(tx, officer, attachmentId, 'Cleaning', '2026-08-17'),
      ),
    ).rejects.toThrow(/Permission denied/);
  });

  it('will not undo a disposal', async () => {
    const { attachmentId } = await uploadWithRetention('2000-01-01');
    await withScope(scope(manager), (tx) =>
      attachments.dispose(tx, manager, attachmentId, 'Retention elapsed', '2026-08-17'),
    );

    expect(
      await rejection(
        ownerPool.query(`update attachment set disposed_at = null where id = $1`, [attachmentId]),
      ),
    ).toMatch(/disposal cannot be undone/);
  });
});
