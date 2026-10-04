/**
 * Platform phase, Agent 4 — the Document Center (QS Cloud Files), against a
 * real PostgreSQL instance and a local Nextcloud stub that speaks real HTTP,
 * WebDAV and OCS (tests/support/nextcloud-stub.ts).
 *
 * What is held here:
 *
 *   * Settings are configured on a screen, by whoever holds `configure`; a bad
 *     address is refused; the integration cannot be switched on without the
 *     server's key.
 *   * A person links by Login Flow v2; the app password is kept sealed, never
 *     in an audit row, and is revoked at the cloud on unlink and on
 *     deactivation.
 *   * Listing is done AS the person: a file the cloud does not show them is
 *     not shown, a folder shared with their group is.
 *   * An upload is reported only when the cloud said 201/204 AND shows the size
 *     that was sent; it never replaces a file; an executable is refused before
 *     a byte leaves.
 *   * A folder is shared with the Nextcloud groups the ERP roles are mapped to,
 *     with the mapping's permission bits.
 *   * Links work from the record and from the file, are made only for records
 *     the person may open, and a link is not a way round the cloud's own
 *     permissions.
 *   * Refusals: no grant, a record out of the person's branch, a path outside
 *     the Document Center's folder, a cloud that is down or has revoked the
 *     password.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import { registerAllRecords } from '@/server/records';
import * as authz from '@/server/services/authorization';
import * as partners from '@/server/services/business-partner';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import * as accounts from '@/server/services/cloud-accounts';
import {
  CloudAuthError,
  CloudClient,
  CloudDeniedError,
  CloudNotFoundError,
  CloudRequestError,
  CloudUnreachableError,
  serverStatus,
} from '@/server/services/cloud-client';
import * as files from '@/server/services/cloud-files';
import * as settings from '@/server/services/cloud-settings';
import * as users from '@/server/services/users';
import { CloudLinkError, CloudPathError } from '@/server/domain/cloud-files';
import { startNextcloudStub, type NextcloudStub } from '../support/nextcloud-stub';

const BAGHDAD = 'BGW';
const MOSUL = 'MSL';
const KEY = 'document-center-test-key-0123456789abcdef';

let stub: NextcloudStub;
let admin: ActorContext;
let officer: ActorContext;
let manager: ActorContext;
let projectManager: ActorContext;
let savedKey: string | undefined;

beforeAll(async () => {
  stub = await startNextcloudStub();
  savedKey = process.env.ERP_SECRET_KEY;
  process.env.ERP_SECRET_KEY = KEY;
  registerAllRecords();
});

afterAll(async () => {
  await stub.close();
  if (savedKey === undefined) delete process.env.ERP_SECRET_KEY;
  else process.env.ERP_SECRET_KEY = savedKey;
});

async function createUser(roleCode: string, branches: readonly string[] = [BAGHDAD]): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [id, `${id}@example.com`, `Test ${roleCode}`]);
  await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, roleCode]);
  for (const branch of branches) await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, branch]);
  const principal = await withScope({ userId: id, branchCode: branches[0]! }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: branches[0]! };
}

const scope = (ctx: ActorContext) => ({ userId: ctx.principal.userId, branchCode: ctx.branchCode });
const inTx = <T>(ctx: ActorContext, work: Parameters<typeof withScope<T>>[1]) => withScope(scope(ctx), work);

/** The sign-in a person does in the cloud's own page, then the ERP collecting it. */
async function linkAs(ctx: ActorContext, cloudUid: string): Promise<accounts.LinkProgress> {
  const start = await inTx(ctx, (tx) => accounts.beginLink(tx, ctx));
  stub.grant(start.loginUrl, cloudUid);
  return inTx(ctx, (tx) => accounts.completeLink(tx, ctx));
}

/** A client and the settings, the way a page gets them. */
async function session(ctx: ActorContext) {
  return inTx(ctx, (tx) => accounts.connect(tx, ctx.principal.userId));
}

async function auditActions(): Promise<string[]> {
  const { rows } = await ownerPool.query<{ action: string }>(`select action from audit_event order by occurred_at, id`);
  return rows.map((row) => row.action);
}

beforeEach(async () => {
  await resetTestData();
  stub.reset();
  await seedBranch(BAGHDAD, 'Baghdad');
  await seedBranch(MOSUL, 'Mosul');
  admin = await createUser('system_administrator');
  officer = await createUser('accounting_officer');
  manager = await createUser('accounting_manager');
  projectManager = await createUser('project_manager');

  stub.addUser('alice', { displayName: 'Alice A.', groups: ['qs-accounting'] });
  stub.addUser('bob', { displayName: 'Bob B.', groups: ['qs-finance'] });
  stub.addUser('carol', { displayName: 'Carol C.' });
  stub.addGroup('qs-hr');

  await inTx(admin, (tx) => settings.save(tx, admin, { enabled: true, baseUrl: stub.url, rootPath: '/', recordRoot: '/Qimah' }));
});

async function supplier(code = 'SUP-DOC-1'): Promise<{ id: string; code: string }> {
  const row = await inTx(officer, (tx) =>
    partners.createPartner(tx, officer, { code, legalName: `Supplier ${code}`, isSupplier: true, email: 'a@example.com', phone: '+964 700 000 0000' }),
  );
  return { id: row.id, code };
}

// ---------------------------------------------------------------------------
describe('the integration is configured on a screen, by those who may', () => {
  it('refuses anyone without the grant, a bad address, and switching on without the server key', async () => {
    expect(await rejection(inTx(officer, (tx) => settings.save(tx, officer, { enabled: true, baseUrl: stub.url, rootPath: '/', recordRoot: '/Qimah' })))).toMatch(/not permitted|permission/i);

    const bad = (baseUrl: string) => inTx(admin, (tx) => settings.save(tx, admin, { enabled: true, baseUrl, rootPath: '/', recordRoot: '/Qimah' }));
    expect(await rejection(bad('http://files.example.com'))).toMatch(/https/i);
    expect(await rejection(bad('ftp://files.example.com'))).toMatch(/https/i);
    expect(await rejection(bad('https://user:pw@files.example.com'))).toMatch(/./);
    expect(await rejection(inTx(admin, (tx) => settings.save(tx, admin, { enabled: true, baseUrl: stub.url, rootPath: '/Docs', recordRoot: '/Elsewhere' })))).toMatch(/inside the Document Center folder/);

    delete process.env.ERP_SECRET_KEY;
    try {
      expect(await rejection(inTx(admin, (tx) => settings.save(tx, admin, { enabled: true, baseUrl: stub.url, rootPath: '/', recordRoot: '/Qimah' })))).toMatch(/ERP_SECRET_KEY/);
    } finally {
      process.env.ERP_SECRET_KEY = KEY;
    }
  });

  it('audits a change, and keeps a mapping with a reason when it is switched off', async () => {
    await inTx(admin, (tx) => settings.saveMapping(tx, admin, { roleCode: 'accounting_officer', groupName: 'qs-accounting', canWrite: true, canShare: false }));
    expect(await rejection(inTx(admin, (tx) => settings.deactivateMapping(tx, admin, 'accounting_officer', '  ')))).toMatch(/reason/i);
    await inTx(admin, (tx) => settings.deactivateMapping(tx, admin, 'accounting_officer', 'Group retired'));
    const rows = await inTx(admin, (tx) => settings.listMappings(tx));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ roleCode: 'accounting_officer', active: false, deactivatedReason: 'Group retired' });
    expect(await rejection(inTx(admin, (tx) => settings.saveMapping(tx, admin, { roleCode: 'no_such_role', groupName: 'g', canWrite: false, canShare: false })))).toMatch(/not a role/);
    expect(await rejection(inTx(admin, (tx) => settings.saveMapping(tx, admin, { roleCode: 'ceo', groupName: 'bad\ngroup', canWrite: false, canShare: false })))).toMatch(/./);
    const actions = await auditActions();
    expect(actions).toEqual(expect.arrayContaining(['cloud_setting.updated', 'cloud_group_mapping.saved', 'cloud_group_mapping.deactivated']));
  });

  it('says what state a person is in: not configured, not linked, linked, link again', async () => {
    await inTx(admin, (tx) => settings.save(tx, admin, { enabled: false, baseUrl: stub.url, rootPath: '/', recordRoot: '/Qimah' }));
    expect((await inTx(officer, (tx) => accounts.stateFor(tx, officer.principal.userId))).state).toBe('not_configured');
    expect(await rejection(inTx(officer, (tx) => accounts.beginLink(tx, officer)))).toMatch(/not configured/i);

    await inTx(admin, (tx) => settings.save(tx, admin, { enabled: true, baseUrl: stub.url, rootPath: '/', recordRoot: '/Qimah' }));
    expect((await inTx(officer, (tx) => accounts.stateFor(tx, officer.principal.userId))).state).toBe('not_linked');
    expect(await linkAs(officer, 'alice')).toBe('linked');
    expect((await inTx(officer, (tx) => accounts.stateFor(tx, officer.principal.userId))).state).toBe('ready');

    // Revoked at the cloud (Settings -> Security there): the next call finds out, and the screen says "link again".
    stub.revokeAll('alice');
    const { client, account } = await session(officer);
    const work = accounts.withCloud(officer, account, () => client.list('/'));
    await expect(work).rejects.toBeInstanceOf(CloudAuthError);
    expect((await inTx(officer, (tx) => accounts.stateFor(tx, officer.principal.userId))).state).toBe('relink');
  });
});

// ---------------------------------------------------------------------------
describe('linking an account (Login Flow v2) and unlinking it', () => {
  it('keeps the app password sealed, never shows or audits it, and revokes it on unlink', async () => {
    const start = await inTx(officer, (tx) => accounts.beginLink(tx, officer));
    expect(start.loginUrl.startsWith(stub.url)).toBe(true);
    // Not granted yet.
    expect(await inTx(officer, (tx) => accounts.completeLink(tx, officer))).toBe('pending');
    expect((await inTx(officer, (tx) => accounts.pendingLink(tx, officer.principal.userId)))?.loginUrl).toBe(start.loginUrl);

    stub.grant(start.loginUrl, 'alice');
    expect(await inTx(officer, (tx) => accounts.completeLink(tx, officer))).toBe('linked');
    expect(await inTx(officer, (tx) => accounts.pendingLink(tx, officer.principal.userId))).toBeNull();

    const [password] = stub.appPasswordsOf('alice');
    expect(password).toBeTruthy();
    const { rows } = await ownerPool.query<{ secret: string; cloud_user: string; display_name: string }>(`select secret, cloud_user, display_name from cloud_account`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cloud_user).toBe('alice');
    expect(rows[0]!.display_name).toBe('Alice A.');
    expect(rows[0]!.secret).toMatch(/^v1\./);
    expect(rows[0]!.secret).not.toContain(password!);
    // The password is in no audit row and no link-attempt row.
    const audit = JSON.stringify((await ownerPool.query(`select * from audit_event`)).rows);
    expect(audit).not.toContain(password);
    expect(audit).toContain('cloud_account.linked');
    expect((await ownerPool.query(`select count(*)::int as n from cloud_link_attempt`)).rows[0].n).toBe(0);

    // It works as Alice, and as nobody else.
    const { client } = await session(officer);
    expect((await client.whoAmI()).id).toBe('alice');

    expect(await inTx(officer, (tx) => accounts.unlink(tx, officer))).toBe('revoked');
    expect(stub.appPasswordsOf('alice')).toEqual([]);
    expect((await ownerPool.query(`select count(*)::int as n from cloud_account`)).rows[0].n).toBe(0);
    expect(await auditActions()).toContain('cloud_account.unlinked');
    expect(await inTx(officer, (tx) => accounts.unlink(tx, officer))).toBe('not_linked');
  });

  it('each person has their own account; one cannot read or use another’s', async () => {
    await linkAs(officer, 'alice');
    await linkAs(manager, 'bob');
    expect((await session(officer)).account.cloudUser).toBe('alice');
    expect((await session(manager)).account.cloudUser).toBe('bob');
    // Row-level security: the officer's scope sees only the officer's row.
    const seen = await inTx(officer, (tx) => tx.execute(sql`select user_id from cloud_account`));
    expect((seen as unknown as { rows: Array<{ user_id: string }> }).rows.map((r) => r.user_id)).toEqual([officer.principal.userId]);
  });

  it('a sign-in that is never finished expires, and a stale poll token does nothing', async () => {
    await inTx(officer, (tx) => accounts.beginLink(tx, officer));
    await ownerPool.query(`update cloud_link_attempt set expires_at = now() - interval '1 minute'`);
    expect(await inTx(officer, (tx) => accounts.completeLink(tx, officer))).toBe('expired');
    expect(await inTx(officer, (tx) => accounts.completeLink(tx, officer))).toBe('none');
  });

  it('removes the stored password even when the cloud cannot be reached, and says it is still there', async () => {
    await linkAs(officer, 'alice');
    stub.unwell = true;
    expect(await inTx(officer, (tx) => accounts.unlink(tx, officer))).toBe('failed');
    expect((await ownerPool.query(`select count(*)::int as n from cloud_account`)).rows[0].n).toBe(0);
  });

  it('an account whose password the cloud refuses to confirm is not kept, and nothing is left issued', async () => {
    const start = await inTx(officer, (tx) => accounts.beginLink(tx, officer));
    stub.grant(start.loginUrl, 'alice');
    // The cloud turns the new password away at the first use.
    stub.failNext('GET', 401, 'cloud/user');
    await expect(inTx(officer, (tx) => accounts.completeLink(tx, officer))).rejects.toBeInstanceOf(CloudAuthError);
    expect((await ownerPool.query(`select count(*)::int as n from cloud_account`)).rows[0].n).toBe(0);
  });

  it('deactivating a person revokes their app password at the cloud', async () => {
    await linkAs(officer, 'alice');
    expect(stub.appPasswordsOf('alice')).toHaveLength(1);
    // A sign-in account, as every real user has one.
    await ownerPool.query(`insert into auth_account (id, user_id, account_id, provider_id) values ($1,$2,$3,'credential')`, [randomUUID(), officer.principal.userId, officer.principal.userId]);
    await inTx(admin, (tx) => users.setActive(tx, admin, officer.principal.userId, false, 'Left the company'));
    expect(stub.appPasswordsOf('alice')).toEqual([]);
    expect((await ownerPool.query(`select count(*)::int as n from cloud_account`)).rows[0].n).toBe(0);
    expect(await auditActions()).toContain('cloud_account.revoked_on_deactivation');
  });

  it('the server answers like Nextcloud, or the address is refused', async () => {
    expect(await serverStatus(stub.url)).toMatchObject({ product: 'Nextcloud', installed: true, maintenance: false });
    stub.unwell = true;
    await expect(serverStatus(stub.url)).rejects.toBeInstanceOf(CloudUnreachableError);
    stub.unwell = false;
    await expect(serverStatus('http://127.0.0.1:9')).rejects.toBeInstanceOf(CloudUnreachableError);
  });
});

// ---------------------------------------------------------------------------
describe('listing and reading, as the person', () => {
  beforeEach(async () => {
    stub.putFile('alice', '/Contracts/lease.pdf', '%PDF-1.7 lease', 'application/pdf');
    stub.putFile('alice', '/notes.txt', 'hello', 'text/plain');
    stub.putFile('bob', '/Private/salary.xlsx', 'secret');
    await linkAs(officer, 'alice');
    await linkAs(manager, 'bob');
  });

  it('shows the person’s own files and nothing of anyone else’s', async () => {
    const { client, settings: config } = await session(officer);
    const listing = await files.browse(officer, client, config, '/');
    expect(listing.entries.map((e) => e.name).sort()).toEqual(['Contracts', 'notes.txt']);
    expect(listing.rights).toEqual({ upload: true, makeFolder: true });
    const notes = listing.entries.find((e) => e.name === 'notes.txt')!;
    expect(notes).toMatchObject({ isFolder: false, size: 5, path: '/notes.txt', mime: 'text/plain' });
    expect(notes.fileId).toBeTruthy();

    // Bob's file is not found by Alice — by path or by id.
    await expect(files.entryAt(officer, client, config, '/Private/salary.xlsx')).rejects.toBeInstanceOf(CloudNotFoundError);
    expect(await client.pathOfFileId(stub.idOf('bob', '/Private/salary.xlsx')!)).toBeNull();
    // And the bytes come from the cloud.
    expect(await (await client.get('/notes.txt')).text()).toBe('hello');
  });

  it('shows a folder shared with the person’s group, with the rights of the share, and not to others', async () => {
    stub.mkdir('alice', '/Shared/Reports');
    stub.putFile('alice', '/Shared/Reports/q3.txt', 'figures', 'text/plain');
    const aliceSession = await session(officer);
    const share = await aliceSession.client.shareWithGroup('/Shared', 'qs-finance', 1);
    expect(share.outcome).toBe('shared');

    const bobSession = await session(manager);
    const top = await files.browse(manager, bobSession.client, bobSession.settings, '/');
    expect(top.entries.map((e) => e.name).sort()).toEqual(['Private', 'Shared']);
    expect(top.entries.find((e) => e.name === 'Shared')!.permissions).toMatch(/^S/);
    const inside = await files.browse(manager, bobSession.client, bobSession.settings, '/Shared/Reports');
    expect(inside.entries.map((e) => e.name)).toEqual(['q3.txt']);
    // Read-only (bit 1): the screen offers no upload.
    expect(inside.rights).toEqual({ upload: false, makeFolder: false });

    // Carol, in no group, is shown nothing of it.
    const carol = await createUser('accounting_manager');
    await linkAs(carol, 'carol');
    const carolSession = await session(carol);
    expect((await files.browse(carol, carolSession.client, carolSession.settings, '/')).entries).toEqual([]);
    await expect(files.browse(carol, carolSession.client, carolSession.settings, '/Shared')).rejects.toBeInstanceOf(CloudNotFoundError);
  });

  it('keeps the person inside the folder the Document Center starts in', async () => {
    await inTx(admin, (tx) => settings.save(tx, admin, { enabled: true, baseUrl: stub.url, rootPath: '/Contracts', recordRoot: '/Contracts/Records' }));
    const { client, settings: config } = await session(officer);
    expect((await files.browse(officer, client, config, '/Contracts')).entries.map((e) => e.name)).toEqual(['lease.pdf']);
    await expect(files.browse(officer, client, config, '/')).rejects.toBeInstanceOf(CloudPathError);
    await expect(files.browse(officer, client, config, '/Contracts/../notes.txt')).rejects.toBeInstanceOf(CloudPathError);
    await expect(files.browse(officer, client, config, '/Contracts%2F..%2Fnotes.txt')).rejects.toThrow();
    await expect(files.entryAt(officer, client, config, '/notes.txt')).rejects.toBeInstanceOf(CloudPathError);
  });

  it('is for those with the Document Center’s grant only, and says the cloud is down when it is', async () => {
    const pm = projectManager;
    stub.addUser('dave');
    // A project manager holds no cloud_files grant: the screen is not theirs.
    await expect(inTx(pm, (tx) => accounts.stateFor(tx, pm.principal.userId))).resolves.toBeTruthy();
    const { client, settings: config } = await session(officer);
    await expect(files.browse(pm, client, config, '/')).rejects.toThrow(/not permitted|permission/i);

    stub.unwell = true;
    await expect(files.browse(officer, client, config, '/')).rejects.toBeInstanceOf(CloudUnreachableError);
  });
});

// ---------------------------------------------------------------------------
describe('upload: said only when the cloud confirms', () => {
  const pdf = Buffer.concat([Buffer.from('%PDF-1.7 '), Buffer.alloc(5000, 'x')]);
  const streamOf = (buffer: Buffer) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(buffer)); c.close(); } });

  async function send(name: string, content: Buffer, directory = '/', ctx = officer) {
    const { client, settings: config } = await session(ctx);
    const { head, whole } = await files.peek(streamOf(content));
    return files.sendToCloud(client, config, { directory, fileName: name, length: content.length, mime: 'application/pdf', head, body: whole });
  }

  beforeEach(async () => {
    await linkAs(officer, 'alice');
  });

  it('uploads, then shows the file at the size that was sent', async () => {
    const uploaded = await send('invoice.pdf', pdf);
    expect(uploaded.entry).toMatchObject({ name: 'invoice.pdf', size: pdf.length, isFolder: false, path: '/invoice.pdf' });
    expect(stub.readFile('alice', '/invoice.pdf')?.equals(pdf)).toBe(true);

    const { client } = await session(officer);
    await inTx(officer, (tx) => files.recordUpload(tx, officer, client, uploaded, null));
    expect(await auditActions()).toContain('cloud_file.uploaded');
  });

  it('does not say "uploaded" when the cloud answers with a failure, or stores less than was sent', async () => {
    stub.failNext('PUT', 507);
    await expect(send('big.pdf', pdf)).rejects.toBeInstanceOf(CloudRequestError);
    expect(stub.exists('alice', '/big.pdf')).toBe(false);

    stub.failNext('PUT', 503);
    await expect(send('later.pdf', pdf)).rejects.toBeInstanceOf(CloudUnreachableError);

    // A cloud that says 201 and keeps half: not counted.
    stub.keepOnlyOnNextPut(100);
    await expect(send('half.pdf', pdf)).rejects.toThrow(/did not confirm/);
    expect(await auditActions()).not.toContain('cloud_file.uploaded');
  });

  it('never replaces a file, and refuses what the paperclip refuses before sending a byte', async () => {
    await send('same.pdf', pdf);
    await expect(send('same.pdf', Buffer.concat([Buffer.from('%PDF-1.7 '), Buffer.alloc(10, 'y')]))).rejects.toThrow(/already there/);
    expect(stub.readFile('alice', '/same.pdf')?.equals(pdf)).toBe(true);

    const before = stub.requests.filter((r) => r.method === 'PUT').length;
    await expect(send('setup.exe', Buffer.from('MZ....'))).rejects.toThrow(/not accepted/);
    await expect(send('invoice.pdf.txt', Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.from('payload')]))).rejects.toThrow(/Renaming it/);
    await expect(send('empty.txt', Buffer.alloc(0))).rejects.toThrow(/empty/);
    await expect(send('../escape.pdf', pdf)).rejects.toThrow();
    await expect(send('ok.pdf', pdf, '/../../etc')).rejects.toBeInstanceOf(CloudPathError);
    expect(stub.requests.filter((r) => r.method === 'PUT').length).toBe(before);
  });

  it('is refused by the cloud itself in a folder shared read-only', async () => {
    stub.mkdir('bob', '/Inbox');
    await (await session((await linkedManager()))).client.shareWithGroup('/Inbox', 'qs-accounting', 1);
    await expect(send('drop.pdf', pdf, '/Inbox')).rejects.toBeInstanceOf(CloudDeniedError);

    // With the create bit it goes through.
    stub.mkdir('bob', '/Dropbox');
    await (await session((await linkedManager()))).client.shareWithGroup('/Dropbox', 'qs-accounting', 15);
    expect((await send('drop.pdf', pdf, '/Dropbox')).entry.size).toBe(pdf.length);
    expect(stub.readFile('bob', '/Dropbox/drop.pdf')?.length).toBe(pdf.length);
  });

  async function linkedManager(): Promise<ActorContext> {
    const state = await inTx(manager, (tx) => accounts.stateFor(tx, manager.principal.userId));
    if (state.state !== 'ready') await linkAs(manager, 'bob');
    return manager;
  }
});

// ---------------------------------------------------------------------------
describe('folders, and sharing them with the groups the roles are mapped to', () => {
  beforeEach(async () => {
    await linkAs(officer, 'alice');
    await inTx(admin, async (tx) => {
      await settings.saveMapping(tx, admin, { roleCode: 'accounting_officer', groupName: 'qs-accounting', canWrite: true, canShare: false });
      await settings.saveMapping(tx, admin, { roleCode: 'accounting_manager', groupName: 'qs-finance', canWrite: true, canShare: true });
      await settings.saveMapping(tx, admin, { roleCode: 'hr_manager', groupName: 'qs-hr', canWrite: false, canShare: false });
      await settings.saveMapping(tx, admin, { roleCode: 'ceo', groupName: 'qs-gone-group', canWrite: false, canShare: false });
    });
    await inTx(admin, (tx) => settings.deactivateMapping(tx, admin, 'hr_manager', 'HR has its own cloud'));
  });

  it('makes a folder and shares it with every active mapped group at that mapping’s rights', async () => {
    const { client, settings: config } = await session(officer);
    const made = await inTx(officer, (tx) => files.createFolder(tx, officer, client, config, { parent: '/', name: 'Finance', shareWithMapped: true }));
    expect(made.entry).toMatchObject({ name: 'Finance', isFolder: true });
    expect(stub.exists('alice', '/Finance')).toBe(true);

    const byGroup = Object.fromEntries(stub.shares().map((s) => [s.group, s.permissions]));
    // read 1 + update 2 + create 4 + delete 8 = 15; a sharer adds 16.
    expect(byGroup['qs-accounting']).toBe(15);
    expect(byGroup['qs-finance']).toBe(31);
    // A switched-off mapping shares nothing.
    expect(byGroup['qs-hr']).toBeUndefined();
    // A group the cloud does not have is reported, not hidden — and the folder stands.
    expect(made.shares.find((s) => s.group === 'qs-gone-group')?.outcome).toBe('unknown_group');
    expect(made.shares.find((s) => s.group === 'qs-finance')?.outcome).toBe('shared');

    // Bob (qs-finance) now sees it; Carol (no group) does not.
    await linkAs(manager, 'bob');
    const bob = await session(manager);
    expect((await files.browse(manager, bob.client, bob.settings, '/')).entries.map((e) => e.name)).toContain('Finance');
    expect(await auditActions()).toContain('cloud_file.folder_created');
  });

  it('refuses a name that is not a name, one that is taken, and a place outside the Document Center', async () => {
    const { client, settings: config } = await session(officer);
    const make = (parent: string, name: string) => inTx(officer, (tx) => files.createFolder(tx, officer, client, config, { parent, name, shareWithMapped: false }));
    await make('/', 'Once');
    expect(await rejection(make('/', 'Once'))).toMatch(/already taken/);
    expect(await rejection(make('/', '..'))).toMatch(/./);
    expect(await rejection(make('/', 'a/b'))).toMatch(/./);
    expect(await rejection(make('/', ' padded '))).toMatch(/./);
    await expect(make('/../x', 'Y')).rejects.toBeInstanceOf(CloudPathError);
    expect(stub.shares()).toEqual([]);
  });

  it('makes the folder of a record, shares it with the roles that may open that kind of record, and links it', async () => {
    const sup = await supplier();
    const record = await inTx(officer, (tx) => import('@/server/services/cloud-link-targets').then((m) => m.openRecord(tx, officer.principal, 'supplier', sup.code)));
    expect(record).toMatchObject({ label: 'SUP-DOC-1', href: '/payables/suppliers/SUP-DOC-1?role=supplier' });

    const { client, settings: config } = await session(officer);
    const made = await inTx(officer, (tx) => files.ensureRecordFolder(tx, officer, client, config, record!));
    expect(made.created).toBe(true);
    expect(made.entry.path).toBe('/Qimah/Suppliers/SUP-DOC-1');
    // business_partner is viewed by accounting managers and officers (and the CEO): their groups, not HR's.
    // The CEO's group does not exist at the cloud: said so, and nothing is shared with it.
    const groups = stub.shares().map((s) => s.group).sort();
    expect(groups).toEqual(['qs-accounting', 'qs-finance']);
    expect(made.shares.find((s) => s.group === 'qs-gone-group')?.outcome).toBe('unknown_group');
    expect(made.link).toMatchObject({ objectType: 'supplier', recordLabel: 'SUP-DOC-1', path: '/Qimah/Suppliers/SUP-DOC-1', isFolder: true });

    // Again: nothing new is made, the link is the same one, the shares are "already".
    const again = await inTx(officer, (tx) => files.ensureRecordFolder(tx, officer, client, config, record!));
    expect(again.created).toBe(false);
    expect(again.link.id).toBe(made.link.id);
    expect(again.shares.every((s) => s.outcome === 'already' || s.outcome === 'unknown_group')).toBe(true);
    expect((await ownerPool.query(`select count(*)::int as n from cloud_file_link`)).rows[0].n).toBe(1);
    expect(await auditActions()).toEqual(expect.arrayContaining(['cloud_file.record_folder_created', 'cloud_file.record_folder_shared', 'cloud_file.linked']));
  });
});

// ---------------------------------------------------------------------------
describe('links between cloud files and ERP records — both directions', () => {
  let sup: { id: string; code: string };

  beforeEach(async () => {
    sup = await supplier();
    stub.putFile('alice', '/Contracts/SUP-DOC-1 agreement.pdf', '%PDF-1.7 agreement', 'application/pdf');
    await linkAs(officer, 'alice');
  });

  const link = async (path: string, type = 'supplier', id = sup.code, ctx = officer) => {
    const { client, settings: config } = await session(ctx);
    return inTx(ctx, (tx) => files.linkPath(tx, ctx, client, config, { path, objectType: type, objectId: id }));
  };

  it('links a file to a record from the file, and lists it from the record and from the file', async () => {
    const made = await link('/Contracts/SUP-DOC-1 agreement.pdf');
    expect(made).toMatchObject({ name: 'SUP-DOC-1 agreement.pdf', isFolder: false, objectType: 'supplier', recordLabel: 'SUP-DOC-1' });

    const { client, account } = await session(officer);
    const serverUrl = account.serverUrl;
    // Record -> files
    const ofRecord = await inTx(officer, (tx) => files.linksOfRecord(tx, officer, serverUrl, 'supplier', sup.code));
    expect(ofRecord.map((l) => l.name)).toEqual(['SUP-DOC-1 agreement.pdf']);
    expect(await inTx(officer, (tx) => files.countLinks(tx, officer, serverUrl, 'supplier', sup.code))).toBe(1);
    // File -> records
    const fileId = stub.idOf('alice', '/Contracts/SUP-DOC-1 agreement.pdf')!;
    const ofFile = await inTx(officer, (tx) => files.recordsLinkedTo(tx, officer, serverUrl, [fileId]));
    expect(ofFile.get(fileId)).toEqual([expect.objectContaining({ objectType: 'supplier', label: 'SUP-DOC-1', href: '/payables/suppliers/SUP-DOC-1?role=supplier' })]);

    // Verified against the cloud, as Alice: available, with a way to open it there.
    const verified = await files.verifyLinks(client, serverUrl, ofRecord);
    expect(verified[0]).toMatchObject({ state: 'available', name: 'SUP-DOC-1 agreement.pdf' });
    expect(verified[0]!.openUrl).toBe(`${stub.url}/index.php/f/${fileId}`);

    // The file is linked once, however often it is asked.
    const again = await link('/Contracts/SUP-DOC-1 agreement.pdf');
    expect(again.id).toBe(made.id);
    expect((await ownerPool.query(`select count(*)::int as n from cloud_file_link`)).rows[0].n).toBe(1);
    // Nothing was copied: the ERP holds the cloud's id and the name, not the bytes.
    const columns = (await ownerPool.query(`select column_name from information_schema.columns where table_name = 'cloud_file_link'`)).rows.map((r) => r.column_name);
    expect(columns).not.toEqual(expect.arrayContaining(['content']));
    expect(await auditActions()).toContain('cloud_file.linked');
  });

  it('does not show a linked file to someone the cloud does not show it to — the link is not a way round the cloud', async () => {
    await link('/Contracts/SUP-DOC-1 agreement.pdf');
    await linkAs(manager, 'carol');
    const { client, account } = await session(manager);
    const links = await inTx(manager, (tx) => files.linksOfRecord(tx, manager, account.serverUrl, 'supplier', sup.code));
    expect(links).toHaveLength(1);
    const verified = await files.verifyLinks(client, account.serverUrl, links);
    expect(verified[0]).toMatchObject({ state: 'unavailable', name: '', entry: null, openUrl: null });
    await expect(inTx(manager, (tx) => files.entryForLink(tx, manager, client, links[0]!.id))).rejects.toBeInstanceOf(CloudNotFoundError);
  });

  it('finds the file for someone who sees it somewhere else (through a share), by its id', async () => {
    await link('/Contracts/SUP-DOC-1 agreement.pdf');
    await (await session(officer)).client.shareWithGroup('/Contracts', 'qs-finance', 1);
    await linkAs(manager, 'bob');
    const { client, account } = await session(manager);
    // Bob sees the folder at the top of his tree, not under /Contracts/... of Alice's.
    const links = await inTx(manager, (tx) => files.linksOfRecord(tx, manager, account.serverUrl, 'supplier', sup.code));
    const verified = await files.verifyLinks(client, account.serverUrl, links);
    expect(verified[0]).toMatchObject({ state: 'available' });
    expect(verified[0]!.entry?.path).toBe('/Contracts/SUP-DOC-1 agreement.pdf');
    const { entry } = await inTx(manager, (tx) => files.entryForLink(tx, manager, client, links[0]!.id));
    expect(await (await client.get(entry.path)).text()).toBe('%PDF-1.7 agreement');
  });

  it('refuses to link to a record the person may not open — one answer for missing, hidden and not theirs', async () => {
    // A project in a branch the officer is not scoped to; one in their own.
    await ownerPool.query(`insert into project (code, name, branch_code) values ('PRJ-MINE','Mine',$1), ('PRJ-THEIRS','Theirs',$2)`, [BAGHDAD, MOSUL]);
    const mine = await link('/Contracts/SUP-DOC-1 agreement.pdf', 'project', 'PRJ-MINE');
    expect(mine.recordLabel).toBe('PRJ-MINE');

    const message = /cannot link files to that record/i;
    expect(await rejection(link('/Contracts/SUP-DOC-1 agreement.pdf', 'project', 'PRJ-THEIRS'))).toMatch(message);
    expect(await rejection(link('/Contracts/SUP-DOC-1 agreement.pdf', 'project', 'PRJ-NOPE'))).toMatch(message);
    expect(await rejection(link('/Contracts/SUP-DOC-1 agreement.pdf', 'no_such_kind', 'x'))).toMatch(message);
    // A kind the person holds no grant on (HR's employee records): same answer.
    expect(await rejection(link('/Contracts/SUP-DOC-1 agreement.pdf', 'employee', randomUUID()))).toMatch(message);
    // The refusals are audited (the denial survives the rolled-back transaction).
    const denied = await ownerPool.query(`select object_id from audit_event where action = 'cloud_file.link_refused' and outcome = 'denied'`);
    expect(denied.rows.map((r) => r.object_id)).toEqual(expect.arrayContaining(['PRJ-THEIRS', 'PRJ-NOPE']));
  });

  it('shows the links of a record only to those who may open the record', async () => {
    await ownerPool.query(`insert into project (code, name, branch_code) values ('PRJ-MSL','Mosul job',$1)`, [MOSUL]);
    const mosulOfficer = await createUser('accounting_officer', [MOSUL]);
    await linkAs(mosulOfficer, 'alice');
    await link('/Contracts/SUP-DOC-1 agreement.pdf', 'project', 'PRJ-MSL', mosulOfficer);
    const { account } = await session(officer);

    // The Baghdad officer cannot see the project, so cannot see that it has files — or which.
    expect(await inTx(officer, (tx) => files.linksOfRecord(tx, officer, account.serverUrl, 'project', 'PRJ-MSL'))).toEqual([]);
    const fileId = stub.idOf('alice', '/Contracts/SUP-DOC-1 agreement.pdf')!;
    const reverse = await inTx(officer, (tx) => files.recordsLinkedTo(tx, officer, account.serverUrl, [fileId]));
    expect(reverse.get(fileId) ?? []).toEqual([]);
    // Whereas the Mosul officer sees it from both ends.
    expect(await inTx(mosulOfficer, (tx) => files.linksOfRecord(tx, mosulOfficer, account.serverUrl, 'project', 'PRJ-MSL'))).toHaveLength(1);
  });

  it('is for those holding the grant, and unlinking needs a reason and leaves the row', async () => {
    const made = await link('/Contracts/SUP-DOC-1 agreement.pdf');
    const { account, client, settings: config } = await session(officer);
    await expect(inTx(projectManager, (tx) => files.linkPath(tx, projectManager, client, config, { path: '/Contracts/SUP-DOC-1 agreement.pdf', objectType: 'project', objectId: 'x' }))).rejects.toThrow(/not permitted|permission/i);

    expect(await rejection(inTx(officer, (tx) => files.unlinkFile(tx, officer, made.id, '')))).toMatch(/reason/i);
    await inTx(officer, (tx) => files.unlinkFile(tx, officer, made.id, 'Wrong supplier'));
    expect(await inTx(officer, (tx) => files.linksOfRecord(tx, officer, account.serverUrl, 'supplier', sup.code))).toEqual([]);
    const { rows } = await ownerPool.query(`select unlinked_by, unlink_reason, unlinked_at is not null as ended from cloud_file_link`);
    expect(rows).toEqual([{ unlinked_by: officer.principal.userId, unlink_reason: 'Wrong supplier', ended: true }]);
    // The file in the cloud is untouched.
    expect(stub.exists('alice', '/Contracts/SUP-DOC-1 agreement.pdf')).toBe(true);
    // And an ended link cannot be ended again, nor can the row be deleted or re-pointed.
    await expect(inTx(officer, (tx) => files.unlinkFile(tx, officer, made.id, 'again'))).rejects.toBeInstanceOf(CloudLinkError);
    await expect(ownerPool.query(`delete from cloud_file_link`)).rejects.toThrow();
    await expect(ownerPool.query(`update cloud_file_link set object_id = 'other'`)).rejects.toThrow();
    // It can be linked again (a new row), which is how "undo" works.
    const relinked = await link('/Contracts/SUP-DOC-1 agreement.pdf');
    expect(relinked.id).not.toBe(made.id);
    expect(await auditActions()).toEqual(expect.arrayContaining(['cloud_file.unlinked']));
  });

  it('the link rows are readable only through the record’s branch', async () => {
    await ownerPool.query(`insert into project (code, name, branch_code) values ('PRJ-MSL','Mosul job',$1)`, [MOSUL]);
    const mosulOfficer = await createUser('accounting_officer', [MOSUL]);
    await linkAs(mosulOfficer, 'alice');
    await link('/Contracts/SUP-DOC-1 agreement.pdf', 'project', 'PRJ-MSL', mosulOfficer);
    const seen = await inTx(officer, (tx) => tx.execute(sql`select id from cloud_file_link`));
    expect((seen as unknown as { rows: unknown[] }).rows).toEqual([]);
    const own = await inTx(mosulOfficer, (tx) => tx.execute(sql`select id from cloud_file_link`));
    expect((own as unknown as { rows: unknown[] }).rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('the registry: a kind that has not registered cannot be linked to', () => {
  it('refuses an unregistered kind until the Task Center (or anyone) registers it, then asks its own access rule', async () => {
    const registry = await import('@/server/services/cloud-link-targets');
    await linkAs(officer, 'alice');
    stub.putFile('alice', '/a.txt', 'a', 'text/plain');
    const { client, settings: config } = await session(officer);
    const attempt = () => inTx(officer, (tx) => files.linkPath(tx, officer, client, config, { path: '/a.txt', objectType: 'project_task', objectId: 'TSK-1' }));
    expect(await rejection(attempt())).toMatch(/cannot link files/i);

    registry.registerCloudLinkTarget({
      type: 'project_task',
      object: 'project',
      folderName: 'Tasks',
      table: 'project',
      idColumn: 'code',
      idKind: 'text',
      labelColumn: 'code',
      branchColumn: 'branch_code',
      href: (label) => `/tasks/${label}`,
    });
    try {
      await ownerPool.query(`insert into project (code, name, branch_code) values ('TSK-1','Standing in for a task',$1)`, [BAGHDAD]);
      expect((await attempt()).objectType).toBe('project_task');
    } finally {
      // Leave the registry as the application builds it.
      registry.clearCloudLinkTargets();
      registerAllRecords();
    }
  });

  it('refuses an identifier that could change the query', async () => {
    const registry = await import('@/server/services/cloud-link-targets');
    expect(() =>
      registry.registerCloudLinkTarget({ type: 'x', object: 'x', folderName: 'X', table: 'project; drop table app_user', idColumn: 'id', idKind: 'uuid', labelColumn: 'id', branchColumn: null, href: () => '/' }),
    ).toThrow(/not an identifier/);
  });
});

// ---------------------------------------------------------------------------
describe('the client', () => {
  it('never hands the app password to another server when redirected', async () => {
    await linkAs(officer, 'alice');
    const { account } = await session(officer);
    const sealed = (await ownerPool.query<{ secret: string }>(`select secret from cloud_account`)).rows[0]!.secret;
    expect(sealed).toBeTruthy();
    let seenAuthorisation: string | null = null;
    const evil = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith(stub.url)) return new Response(null, { status: 302, headers: { Location: 'http://127.0.0.2:9/steal' } });
      seenAuthorisation = new Headers(init?.headers).get('authorization');
      return new Response('', { status: 200 });
    }) as typeof fetch;
    const client = new CloudClient({ baseUrl: account.serverUrl, user: 'alice', password: 'x-x-x-x' }, evil);
    await expect(client.list('/')).rejects.toBeInstanceOf(CloudRequestError);
    expect(seenAuthorisation).toBeNull();
  });
});
