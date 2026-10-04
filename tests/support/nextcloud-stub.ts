/**
 * A small Nextcloud, for tests (Platform phase, Agent 4).
 *
 * Not a mock of the client: a real HTTP server on a loopback port that speaks
 * the parts of Nextcloud the Document Center uses, so the real `CloudClient`,
 * the real fetch and the real XML go through it:
 *
 *   status.php · Login Flow v2 · OCS (cloud/user, apppassword, shares) ·
 *   WebDAV files (PROPFIND 0/1, MKCOL, PUT with If-None-Match, GET) ·
 *   dav/meta (the path of a file id for the asker) · core/preview
 *
 * It keeps Nextcloud's rules that matter here and nothing more: each user has
 * their own tree; a folder shared with a group appears at the top of every
 * member's tree under its own name, with the rights of the share (read 1,
 * update 2, create 4, delete 8, share 16); an app password belongs to one user
 * and Basic auth with anything else is a 401; a user cannot reach another
 * user's `files/<uid>` path.
 *
 * The first run against the real files.qs-groups.com is the live test
 * (docs/audits/DOCUMENT-CENTER-IMPLEMENTATION.md); this stub is what the
 * build could check without a route to it.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';

interface StubNode {
  readonly id: number;
  readonly owner: string;
  readonly parent: StubNode | null;
  readonly name: string;
  readonly folder: boolean;
  content: Buffer;
  mime: string;
  mtime: Date;
  etag: string;
}

export interface StubShare {
  readonly id: number;
  readonly nodeId: number;
  readonly owner: string;
  readonly path: string;
  readonly group: string;
  readonly permissions: number;
}

export interface StubRequest {
  readonly method: string;
  readonly path: string;
  readonly user: string | null;
}

interface Rights {
  readonly read: boolean;
  readonly update: boolean;
  readonly create: boolean;
  readonly delete: boolean;
  readonly share: boolean;
  readonly shared: boolean;
}

const OWNER_RIGHTS: Rights = { read: true, update: true, create: true, delete: true, share: true, shared: false };
const bitsToRights = (bits: number): Rights => ({
  read: (bits & 1) !== 0,
  update: (bits & 2) !== 0,
  create: (bits & 4) !== 0,
  delete: (bits & 8) !== 0,
  share: (bits & 16) !== 0,
  shared: true,
});

/** A 1x1 PNG, what the preview endpoint hands back. */
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const xml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const encodePath = (segments: readonly string[]) => segments.map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');

export class NextcloudStub {
  private server: Server;
  private nodes: StubNode[] = [];
  private nextId = 1000;
  private shareList: StubShare[] = [];
  private nextShareId = 1;
  private readonly users = new Map<string, { displayName: string; groups: Set<string> }>();
  private readonly groups = new Set<string>();
  private readonly passwords = new Map<string, string>();
  private readonly flows = new Map<string, { granted: { uid: string; appPassword: string } | null; collected: boolean }>();
  private failures: Array<{ method: string; contains: string; status: number }> = [];
  private shortPut: number | null = null;
  /** When true, every request is answered 503: the server is up but unwell. */
  unwell = false;
  readonly requests: StubRequest[] = [];
  url = '';

  constructor() {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        res.statusCode = 500;
        res.end(String(error));
      });
    });
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  reset(): void {
    this.nodes = [];
    this.shareList = [];
    this.users.clear();
    this.groups.clear();
    this.passwords.clear();
    this.flows.clear();
    this.failures = [];
    this.shortPut = null;
    this.unwell = false;
    this.requests.length = 0;
  }

  // ---- arranging the world ------------------------------------------------

  addUser(uid: string, options: { displayName?: string; groups?: readonly string[] } = {}): void {
    const groups = new Set(options.groups ?? []);
    for (const group of groups) this.groups.add(group);
    this.users.set(uid, { displayName: options.displayName ?? uid, groups });
    this.rootOf(uid);
  }

  addGroup(name: string): void {
    this.groups.add(name);
  }

  addToGroup(uid: string, group: string): void {
    this.groups.add(group);
    this.users.get(uid)?.groups.add(group);
  }

  /** Makes the folders on the way too. Returns the file id of the last. */
  mkdir(owner: string, path: string): string {
    let node = this.rootOf(owner);
    for (const name of path.split('/').filter(Boolean)) {
      node = this.childOf(node, name) ?? this.add(owner, node, name, true, Buffer.alloc(0), 'httpd/unix-directory');
    }
    return String(node.id);
  }

  putFile(owner: string, path: string, content: Buffer | string, mime = 'application/octet-stream'): string {
    const segments = path.split('/').filter(Boolean);
    const name = segments.pop()!;
    const parent = this.nodeAt(owner, this.mkdir(owner, segments.join('/')));
    const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const existing = this.childOf(parent!, name);
    if (existing) {
      existing.content = body;
      existing.mtime = new Date();
      existing.etag = randomBytes(8).toString('hex');
      return String(existing.id);
    }
    return String(this.add(owner, parent!, name, false, body, mime).id);
  }

  readFile(owner: string, path: string): Buffer | null {
    const node = this.ownNode(owner, path);
    return node && !node.folder ? node.content : null;
  }

  exists(owner: string, path: string): boolean {
    return this.ownNode(owner, path) !== null;
  }

  idOf(owner: string, path: string): string | null {
    const node = this.ownNode(owner, path);
    return node ? String(node.id) : null;
  }

  childNames(owner: string, path: string): string[] {
    const node = this.ownNode(owner, path);
    return node ? this.nodes.filter((n) => n.parent === node).map((n) => n.name) : [];
  }

  shares(): readonly StubShare[] {
    return [...this.shareList];
  }

  appPasswordsOf(uid: string): string[] {
    return [...this.passwords].filter(([, owner]) => owner === uid).map(([token]) => token);
  }

  /** What an administrator does in Nextcloud's security page: the app password stops working. */
  revokeAll(uid: string): void {
    for (const [token, owner] of [...this.passwords]) if (owner === uid) this.passwords.delete(token);
  }

  /** The next request with this method whose URL contains `contains` is answered with this status. */
  failNext(method: string, status: number, contains = ''): void {
    this.failures.push({ method: method.toUpperCase(), contains, status });
  }

  /** The next PUT is answered 201 but only this many bytes are kept — a cloud that says yes and stores less. */
  keepOnlyOnNextPut(bytes: number): void {
    this.shortPut = bytes;
  }

  /** The person opens the login page and grants access. Returns nothing; the next poll sees it. */
  grant(loginUrl: string, uid: string): void {
    const token = loginUrl.split('/flow/')[1]?.split('?')[0];
    const flow = token ? this.flows.get(token) : undefined;
    if (!flow) throw new Error('No such login flow.');
    const appPassword = this.issue(uid);
    flow.granted = { uid, appPassword };
  }

  // ---- the tree ------------------------------------------------------------

  private add(owner: string, parent: StubNode | null, name: string, folder: boolean, content: Buffer, mime: string): StubNode {
    const node: StubNode = { id: this.nextId++, owner, parent, name, folder, content, mime, mtime: new Date(), etag: randomBytes(8).toString('hex') };
    this.nodes.push(node);
    return node;
  }

  private rootOf(owner: string): StubNode {
    return this.nodes.find((n) => n.owner === owner && n.parent === null) ?? this.add(owner, null, '', true, Buffer.alloc(0), 'httpd/unix-directory');
  }

  private childOf(parent: StubNode, name: string): StubNode | null {
    return this.nodes.find((n) => n.parent === parent && n.name === name) ?? null;
  }

  private nodeAt(owner: string, id: string): StubNode | null {
    return this.nodes.find((n) => n.owner === owner && String(n.id) === id) ?? null;
  }

  private ownNode(owner: string, path: string): StubNode | null {
    let node: StubNode | null = this.rootOf(owner);
    for (const name of path.split('/').filter(Boolean)) {
      node = this.childOf(node, name);
      if (!node) return null;
    }
    return node;
  }

  private groupsOf(uid: string): ReadonlySet<string> {
    return this.users.get(uid)?.groups ?? new Set();
  }

  /** What the cloud shows this user at a path: the node and the rights they hold on it. */
  private resolve(uid: string, segments: readonly string[]): { node: StubNode; rights: Rights } | null {
    let node: StubNode;
    let rights: Rights = OWNER_RIGHTS;
    const root = this.rootOf(uid);
    if (segments.length === 0) return { node: root, rights };
    const [first, ...rest] = segments;
    const own = this.childOf(root, first!);
    if (own) node = own;
    else {
      const mounted = this.shareList.find((share) => {
        const shared = this.nodes.find((n) => n.id === share.nodeId);
        return shared && shared.owner !== uid && shared.name === first && this.groupsOf(uid).has(share.group);
      });
      if (!mounted) return null;
      node = this.nodes.find((n) => n.id === mounted.nodeId)!;
      rights = bitsToRights(mounted.permissions);
    }
    for (const name of rest) {
      const next = this.childOf(node, name);
      if (!next) return null;
      node = next;
    }
    return { node, rights };
  }

  /** The path this user sees a node at, or null when it is not theirs to see. */
  private pathFor(uid: string, node: StubNode): string | null {
    const chain: StubNode[] = [];
    for (let walk: StubNode | null = node; walk && walk.parent; walk = walk.parent) chain.unshift(walk);
    if (node.owner === uid) return `/${chain.map((n) => n.name).join('/')}`;
    for (let i = 0; i < chain.length; i += 1) {
      const sharedNode = chain[i]!;
      if (this.shareList.some((share) => share.nodeId === sharedNode.id && this.groupsOf(uid).has(share.group))) {
        return `/${chain.slice(i).map((n) => n.name).join('/')}`;
      }
    }
    return null;
  }

  private lettersFor(node: StubNode, rights: Rights): string {
    let letters = '';
    if (rights.shared) letters += 'S';
    if (rights.share) letters += 'R';
    if (rights.delete) letters += 'D';
    if (rights.update) letters += node.folder ? 'NV' : 'NVW';
    if (node.folder && rights.create) letters += 'CK';
    return letters;
  }

  // ---- HTTP ------------------------------------------------------------------

  private authenticate(req: IncomingMessage): string | null {
    const header = req.headers.authorization;
    if (!header?.startsWith('Basic ')) return null;
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 0) return null;
    const user = decoded.slice(0, colon);
    const password = decoded.slice(colon + 1);
    return this.passwords.get(password) === user && this.users.has(user) ? user : null;
  }

  private issue(uid: string): string {
    const token = randomBytes(12).toString('base64url').replace(/[-_]/g, 'x').slice(0, 20);
    const appPassword = `${token.slice(0, 5)}-${token.slice(5, 10)}-${token.slice(10, 15)}-${token.slice(15, 20)}`;
    this.passwords.set(appPassword, uid);
    return appPassword;
  }

  private async body(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  private send(res: ServerResponse, status: number, body: string | Buffer = '', headers: Record<string, string> = {}): void {
    res.writeHead(status, { 'Content-Length': Buffer.byteLength(body), ...headers });
    res.end(body);
  }

  private json(res: ServerResponse, status: number, value: unknown): void {
    this.send(res, status, JSON.stringify(value), { 'Content-Type': 'application/json' });
  }

  private ocs(res: ServerResponse, status: number, message: string, data: unknown = []): void {
    this.json(res, status, { ocs: { meta: { status: status === 200 ? 'ok' : 'failure', statuscode: status, message }, data } });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.url);
    const method = (req.method ?? 'GET').toUpperCase();
    const user = this.authenticate(req);
    this.requests.push({ method, path: url.pathname, user });

    if (this.unwell) return this.send(res, 503, 'Service Unavailable');
    const failure = this.failures.findIndex((f) => f.method === method && (f.contains === '' || (req.url ?? '').includes(f.contains)));
    if (failure >= 0) {
      const [hit] = this.failures.splice(failure, 1);
      await this.body(req);
      return this.send(res, hit!.status, 'failure injected by the test');
    }

    const path = url.pathname;
    if (path === '/status.php') {
      return this.json(res, 200, { installed: true, maintenance: false, needsDbUpgrade: false, version: '30.0.2.2', productname: 'Nextcloud' });
    }
    if (path === '/index.php/login/v2' && method === 'POST') return this.startFlow(res);
    if (path === '/index.php/login/v2/poll' && method === 'POST') return this.poll(req, res);
    if (path.startsWith('/index.php/login/v2/flow/') && method === 'GET') return this.flowPage(url, res);

    if (!user) {
      return this.send(res, 401, 'Unauthorised', { 'WWW-Authenticate': 'Basic realm="Nextcloud"' });
    }
    if (path === '/ocs/v2.php/cloud/user') {
      return this.ocs(res, 200, 'OK', { id: user, displayname: this.users.get(user)!.displayName });
    }
    if (path === '/ocs/v2.php/core/apppassword' && method === 'DELETE') {
      const given = Buffer.from((req.headers.authorization ?? '').slice(6), 'base64').toString('utf8').split(':').slice(1).join(':');
      this.passwords.delete(given);
      return this.ocs(res, 200, 'OK');
    }
    if (path === '/ocs/v2.php/apps/files_sharing/api/v1/shares' && method === 'POST') return this.share(req, res, user);
    if (path === '/index.php/core/preview') return this.preview(url, res, user);
    if (path.startsWith('/remote.php/dav/meta/')) return this.meta(req, res, user, path);
    if (path.startsWith('/remote.php/dav/files/')) return this.files(req, res, user, method, path);
    return this.send(res, 404, 'Not found');
  }

  private startFlow(res: ServerResponse): void {
    const token = randomBytes(16).toString('hex');
    this.flows.set(token, { granted: null, collected: false });
    this.json(res, 200, {
      poll: { token, endpoint: `${this.url}/index.php/login/v2/poll` },
      login: `${this.url}/index.php/login/v2/flow/${token}`,
    });
  }

  private async poll(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const token = new URLSearchParams((await this.body(req)).toString('utf8')).get('token') ?? '';
    const flow = this.flows.get(token);
    if (!flow || flow.collected || !flow.granted) return this.send(res, 404, '');
    flow.collected = true;
    this.json(res, 200, { server: this.url, loginName: flow.granted.uid, appPassword: flow.granted.appPassword });
  }

  private flowPage(url: URL, res: ServerResponse): void {
    const token = url.pathname.split('/flow/')[1] ?? '';
    const flow = this.flows.get(token);
    if (!flow) return this.send(res, 404, 'No such sign-in');
    const as = url.searchParams.get('as');
    if (as && this.users.has(as) && !flow.granted) flow.granted = { uid: as, appPassword: this.issue(as) };
    this.send(res, 200, flow.granted ? 'Access granted' : 'Connect to your account', { 'Content-Type': 'text/plain' });
  }

  private async share(req: IncomingMessage, res: ServerResponse, user: string): Promise<void> {
    const form = new URLSearchParams((await this.body(req)).toString('utf8'));
    const path = form.get('path') ?? '';
    const type = form.get('shareType');
    const group = form.get('shareWith') ?? '';
    const bits = Number(form.get('permissions') ?? '31');
    if (type !== '1') return this.ocs(res, 400, 'Unsupported share type');
    const found = this.resolve(user, path.split('/').filter(Boolean));
    if (!found) return this.ocs(res, 404, 'Wrong path, file/folder does not exist');
    if (!found.rights.share) return this.ocs(res, 403, 'You are not allowed to share this path');
    if (!this.groups.has(group)) return this.ocs(res, 404, `Sharing ${group} failed, because this group does not exist`);
    if (this.shareList.some((share) => share.nodeId === found.node.id && share.group === group)) {
      return this.ocs(res, 403, `Sharing ${path} failed, because this item is already shared with group ${group}`);
    }
    const share: StubShare = { id: this.nextShareId++, nodeId: found.node.id, owner: found.node.owner, path, group, permissions: bits };
    this.shareList.push(share);
    this.ocs(res, 200, 'OK', { id: String(share.id), share_type: 1, permissions: bits, share_with: group, path });
  }

  private preview(url: URL, res: ServerResponse, user: string): void {
    const id = url.searchParams.get('fileId') ?? '';
    const node = this.nodes.find((n) => String(n.id) === id);
    if (!node || !this.pathFor(user, node) || node.folder || !this.hasPreview(node)) return this.send(res, 404, '');
    this.send(res, 200, PNG_1X1, { 'Content-Type': 'image/png' });
  }

  private hasPreview(node: StubNode): boolean {
    return !node.folder && (node.mime.startsWith('image/') || node.mime === 'application/pdf');
  }

  private async meta(req: IncomingMessage, res: ServerResponse, user: string, path: string): Promise<void> {
    await this.body(req);
    const id = decodeURIComponent(path.split('/remote.php/dav/meta/')[1]?.split('/')[0] ?? '');
    const node = this.nodes.find((n) => String(n.id) === id);
    const seen = node ? this.pathFor(user, node) : null;
    if (!node || !seen) return this.send(res, 404, '');
    const body = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
  <d:response><d:href>/remote.php/dav/meta/${id}/</d:href>
    <d:propstat><d:prop><nc:meta-path-for-user>${xml(seen)}</nc:meta-path-for-user><oc:fileid>${id}</oc:fileid></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>`;
    this.send(res, 207, body, { 'Content-Type': 'application/xml; charset=utf-8' });
  }

  private entryXml(uid: string, node: StubNode, rights: Rights, seenAt: string[]): string {
    const href = `/remote.php/dav/files/${encodeURIComponent(uid)}/${seenAt.length ? `${encodePath(seenAt)}${node.folder ? '/' : ''}` : ''}`;
    const size = node.folder ? this.sizeOf(node) : node.content.length;
    return `<d:response><d:href>${href}</d:href><d:propstat><d:prop>
<d:getlastmodified>${node.mtime.toUTCString()}</d:getlastmodified>
${node.folder ? '<d:resourcetype><d:collection/></d:resourcetype>' : `<d:resourcetype/><d:getcontentlength>${node.content.length}</d:getcontentlength><d:getcontenttype>${xml(node.mime)}</d:getcontenttype>`}
<d:getetag>"${node.etag}"</d:getetag>
<oc:fileid>${node.id}</oc:fileid><oc:size>${size}</oc:size><oc:permissions>${this.lettersFor(node, rights)}</oc:permissions>
<nc:has-preview>${this.hasPreview(node) ? 'true' : 'false'}</nc:has-preview>
</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  }

  private sizeOf(folder: StubNode): number {
    return this.nodes.filter((n) => n.parent === folder).reduce((sum, n) => sum + (n.folder ? this.sizeOf(n) : n.content.length), 0);
  }

  /** The children this user sees in a folder: its own, and — at the top — what has been shared with their groups. */
  private childrenFor(uid: string, node: StubNode, rights: Rights, atTop: boolean): Array<{ node: StubNode; rights: Rights }> {
    const own = this.nodes.filter((n) => n.parent === node).map((n) => ({ node: n, rights }));
    if (!atTop) return own;
    const taken = new Set(own.map((entry) => entry.node.name));
    for (const share of this.shareList) {
      const shared = this.nodes.find((n) => n.id === share.nodeId);
      if (!shared || shared.owner === uid || !this.groupsOf(uid).has(share.group) || taken.has(shared.name)) continue;
      taken.add(shared.name);
      own.push({ node: shared, rights: bitsToRights(share.permissions) });
    }
    return own;
  }

  private async files(req: IncomingMessage, res: ServerResponse, user: string, method: string, pathname: string): Promise<void> {
    const rest = pathname.slice('/remote.php/dav/files/'.length);
    const slash = rest.indexOf('/');
    const owner = decodeURIComponent(slash < 0 ? rest : rest.slice(0, slash));
    const segments = (slash < 0 ? '' : rest.slice(slash + 1)).split('/').filter(Boolean).map((s) => decodeURIComponent(s));
    if (owner !== user) {
      await this.body(req);
      return this.send(res, 403, 'Forbidden');
    }

    if (method === 'PROPFIND') {
      await this.body(req);
      const found = this.resolve(user, segments);
      if (!found) return this.send(res, 404, '');
      const depth = req.headers.depth === '0' ? 0 : 1;
      const parts = [this.entryXml(user, found.node, found.rights, segments)];
      if (depth === 1 && found.node.folder) {
        for (const child of this.childrenFor(user, found.node, found.rights, segments.length === 0)) {
          parts.push(this.entryXml(user, child.node, child.rights, [...segments, child.node.name]));
        }
      }
      const body = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
${parts.join('\n')}
</d:multistatus>`;
      return this.send(res, 207, body, { 'Content-Type': 'application/xml; charset=utf-8' });
    }

    if (method === 'GET') {
      const found = this.resolve(user, segments);
      if (!found || !found.rights.read) return this.send(res, 404, '');
      if (found.node.folder) return this.send(res, 405, '');
      return this.send(res, 200, found.node.content, { 'Content-Type': found.node.mime, ETag: `"${found.node.etag}"` });
    }

    if (method === 'MKCOL' || method === 'PUT') {
      const content = await this.body(req);
      if (segments.length === 0) return this.send(res, 405, '');
      const name = segments[segments.length - 1]!;
      const parent = this.resolve(user, segments.slice(0, -1));
      if (!parent || !parent.node.folder) return this.send(res, 409, 'Parent folder is missing');
      if (!parent.rights.create) return this.send(res, 403, 'Forbidden');
      const existing = this.childOf(parent.node, name);
      if (method === 'MKCOL') {
        if (existing) return this.send(res, 405, 'Already exists');
        this.add(parent.node.owner, parent.node, name, true, Buffer.alloc(0), 'httpd/unix-directory');
        return this.send(res, 201, '');
      }
      if (existing && req.headers['if-none-match'] === '*') return this.send(res, 412, 'Precondition failed');
      if (existing && existing.folder) return this.send(res, 409, 'Is a folder');
      const kept = this.shortPut === null ? content : content.subarray(0, this.shortPut);
      this.shortPut = null;
      const mime = (req.headers['content-type'] ?? 'application/octet-stream').split(';')[0]!;
      if (existing) {
        existing.content = kept;
        existing.mime = mime;
        existing.mtime = new Date();
        existing.etag = randomBytes(8).toString('hex');
        return this.send(res, 204, '');
      }
      this.add(parent.node.owner, parent.node, name, false, kept, mime);
      return this.send(res, 201, '');
    }

    await this.body(req);
    return this.send(res, 405, '');
  }
}

export async function startNextcloudStub(): Promise<NextcloudStub> {
  return new NextcloudStub().start();
}
