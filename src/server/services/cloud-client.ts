/**
 * The HTTP client for QS Cloud Files — WebDAV, OCS and Login Flow v2 against a
 * Nextcloud installation, with `fetch` and nothing else (Platform phase,
 * Agent 4; REQ-FIX-001 FIX-6).
 *
 * Every call is made AS ONE PERSON, with that person's own app password, so
 * the cloud's own rules — their folders, the groups they are in, what has been
 * shared with them — decide what comes back. This module never decides who may
 * see a file; it only reports faithfully what the cloud says and names the
 * ways a call can fail:
 *
 *   CloudUnreachableError   no answer, a timeout, a 5xx — "Cloud Files cannot be reached"
 *   CloudAuthError          401: the app password was revoked or is wrong — link again
 *   CloudDeniedError        403: the cloud refuses this person this thing
 *   CloudNotFoundError      404: not there, or not visible to this person (the cloud
 *                           answers both the same way, and so does this client)
 *   CloudConflictError      the name is taken, the parent is missing, the file is locked
 *   CloudRequestError       any other refusal
 *
 * Redirects are never followed with credentials attached to another host; a
 * same-origin redirect is followed once for requests that carry no stream.
 */
import {
  CloudProtocolError,
  davFilesRootPath,
  davFilesRootUrl,
  davHrefToPath,
  encodeDavPath,
  normaliseBaseUrl,
  normaliseCloudPath,
  parentOf,
  baseName,
  parseLoginFlowResult,
  parseLoginFlowStart,
  parseOcs,
  parsePropfind,
  sameOrigin,
  type DavEntry,
  type LoginFlowResult,
  type LoginFlowStart,
} from '../domain/cloud-files';

export class CloudHttpError extends Error {
  constructor(
    detail: string,
    readonly status: number | null,
  ) {
    super(detail);
    this.name = new.target.name;
  }
}
export class CloudUnreachableError extends CloudHttpError {}
export class CloudAuthError extends CloudHttpError {}
export class CloudDeniedError extends CloudHttpError {}
export class CloudNotFoundError extends CloudHttpError {}
export class CloudConflictError extends CloudHttpError {}
export class CloudRequestError extends CloudHttpError {}

export interface CloudCredentials {
  readonly baseUrl: string;
  /** The cloud's id for the person (the WebDAV path segment), not necessarily the name they sign in with. */
  readonly user: string;
  readonly password: string;
}

/** A listing entry: what the cloud said, with the path worked out. */
export interface CloudEntry extends DavEntry {
  readonly path: string;
  readonly name: string;
}

const USER_AGENT = 'Qimah ERP';
const QUICK_MS = 15_000;
const TRANSFER_MS = 30 * 60_000;

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
  <d:prop>
    <d:getlastmodified/><d:getcontentlength/><d:getcontenttype/><d:resourcetype/><d:getetag/>
    <oc:fileid/><oc:size/><oc:permissions/><nc:has-preview/>
  </d:prop>
</d:propfind>`;

const META_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:nc="http://nextcloud.org/ns"><d:prop><nc:meta-path-for-user/></d:prop></d:propfind>`;

function unreachable(error: unknown): CloudUnreachableError {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return new CloudUnreachableError('Cloud Files did not answer in time.', null);
  return new CloudUnreachableError('Cloud Files cannot be reached.', null);
}

/** Turns a refusing status into the error that names it. Returns normally for a success. */
function assertOk(response: Response, accepted: readonly number[]): void {
  if (accepted.includes(response.status)) return;
  const status = response.status;
  if (status === 401) throw new CloudAuthError('Cloud Files no longer accepts this account.', status);
  if (status === 403) throw new CloudDeniedError('Cloud Files does not allow that for this account.', status);
  if (status === 404) throw new CloudNotFoundError('Not found in Cloud Files.', status);
  if (status === 405 || status === 409 || status === 412 || status === 423) {
    throw new CloudConflictError('Cloud Files could not do that: the name is taken, the folder is missing, or the file is locked.', status);
  }
  if (status === 413) throw new CloudRequestError('Cloud Files refused the file because it is too large.', status);
  if (status === 507) throw new CloudRequestError('Cloud Files has no room left for that file.', status);
  if (status >= 500) throw new CloudUnreachableError('Cloud Files answered with an error. Try again shortly.', status);
  throw new CloudRequestError(`Cloud Files refused the request (${status}).`, status);
}

export class CloudClient {
  readonly baseUrl: string;
  private readonly authorization: string;
  private readonly filesUrl: string;
  private readonly filesPath: string;

  constructor(
    private readonly credentials: CloudCredentials,
    private readonly doFetch: typeof fetch = fetch,
  ) {
    this.baseUrl = normaliseBaseUrl(credentials.baseUrl);
    this.authorization = `Basic ${Buffer.from(`${credentials.user}:${credentials.password}`, 'utf8').toString('base64')}`;
    this.filesUrl = davFilesRootUrl(this.baseUrl, credentials.user);
    this.filesPath = davFilesRootPath(this.baseUrl, credentials.user);
  }

  private urlFor(path: string): string {
    return `${this.filesUrl}${encodeDavPath(path)}`;
  }

  private async send(
    url: string,
    init: RequestInit & { duplex?: 'half' },
    timeoutMs: number,
    followRedirect: boolean,
  ): Promise<Response> {
    let target = url;
    for (let hop = 0; hop < 3; hop += 1) {
      let response: Response;
      try {
        response = await this.doFetch(target, {
          ...init,
          headers: { Authorization: this.authorization, 'User-Agent': USER_AGENT, ...(init.headers as Record<string, string> | undefined) },
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw unreachable(error);
      }
      if (response.status >= 300 && response.status < 400 && response.status !== 304) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => undefined);
        if (!followRedirect || !location) throw new CloudRequestError('Cloud Files redirected the request, which is not followed.', response.status);
        const next = new URL(location, target).toString();
        // Never hand the app password to another server.
        if (!sameOrigin(next, this.baseUrl)) throw new CloudRequestError('Cloud Files redirected the request to another server, which is refused.', response.status);
        target = next;
        continue;
      }
      return response;
    }
    throw new CloudRequestError('Cloud Files redirected the request too many times.', null);
  }

  private entryFrom(entry: DavEntry): CloudEntry | null {
    const path = davHrefToPath(entry.href, this.filesPath);
    if (path === null) return null;
    return { ...entry, path, name: baseName(path) };
  }

  // ---- reading ------------------------------------------------------------

  /** The folder's own entry and its direct children. A path that is not a folder is "not found". */
  async list(path: string): Promise<{ folder: CloudEntry; entries: readonly CloudEntry[] }> {
    const normal = normaliseCloudPath(path);
    const response = await this.send(
      `${this.urlFor(normal)}/`,
      { method: 'PROPFIND', headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' }, body: PROPFIND_BODY },
      QUICK_MS,
      true,
    );
    assertOk(response, [207]);
    const entries = parsePropfind(await response.text())
      .map((entry) => this.entryFrom(entry))
      .filter((entry): entry is CloudEntry => entry !== null);
    const folder = entries.find((entry) => entry.path === normal);
    if (!folder || !folder.isFolder) throw new CloudNotFoundError('Not found in Cloud Files.', 404);
    return { folder, entries: entries.filter((entry) => entry.path !== normal && parentOf(entry.path) === normal) };
  }

  /** One entry, or null when the cloud has no such thing for this person. */
  async stat(path: string): Promise<CloudEntry | null> {
    const normal = normaliseCloudPath(path);
    const response = await this.send(
      this.urlFor(normal) || `${this.filesUrl}/`,
      { method: 'PROPFIND', headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' }, body: PROPFIND_BODY },
      QUICK_MS,
      true,
    );
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    assertOk(response, [207]);
    const [first] = parsePropfind(await response.text());
    const entry = first ? this.entryFrom(first) : null;
    return entry && entry.path === normal ? entry : null;
  }

  /**
   * Where this person sees the file with that id — their own path to it, which
   * differs from the linker's when it arrives through a share. Null when the
   * cloud has nothing by that id for them.
   */
  async pathOfFileId(fileId: string): Promise<string | null> {
    const response = await this.send(
      `${this.baseUrl}/remote.php/dav/meta/${encodeURIComponent(fileId)}`,
      { method: 'PROPFIND', headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' }, body: META_BODY },
      QUICK_MS,
      true,
    );
    if (response.status === 404 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    assertOk(response, [207]);
    const [first] = parsePropfind(await response.text());
    if (!first?.pathForUser) return null;
    try {
      return normaliseCloudPath(first.pathForUser);
    } catch {
      return null;
    }
  }

  /** The file's bytes, as a stream the caller passes on. The caller owns the body. */
  async get(path: string): Promise<Response> {
    const response = await this.send(this.urlFor(path), { method: 'GET' }, TRANSFER_MS, true);
    assertOk(response, [200]);
    return response;
  }

  /** The cloud's own preview image of a file, by id. 404 means the cloud has none. */
  async preview(fileId: string, size = 1024): Promise<Response> {
    const query = new URLSearchParams({ fileId, x: String(size), y: String(size), a: 'true', forceIcon: '0' });
    const response = await this.send(`${this.baseUrl}/index.php/core/preview?${query.toString()}`, { method: 'GET' }, QUICK_MS * 2, true);
    assertOk(response, [200]);
    return response;
  }

  // ---- writing ------------------------------------------------------------

  /** Makes one folder. An existing one is a conflict. */
  async mkcol(path: string): Promise<void> {
    const response = await this.send(this.urlFor(path), { method: 'MKCOL' }, QUICK_MS, true);
    await response.body?.cancel().catch(() => undefined);
    assertOk(response, [201]);
  }

  /** Makes a folder and the ones above it that are missing; an existing folder is fine. Returns the ones it made. */
  async ensureFolder(path: string): Promise<readonly string[]> {
    const made: string[] = [];
    const target = normaliseCloudPath(path);
    if (target === '/') return made;
    let walk = '';
    for (const segment of target.slice(1).split('/')) {
      walk += `/${segment}`;
      const existing = await this.stat(walk);
      if (existing) {
        if (!existing.isFolder) throw new CloudConflictError(`"${walk}" is a file, not a folder.`, 409);
        continue;
      }
      try {
        await this.mkcol(walk);
        made.push(walk);
      } catch (error) {
        // Somebody else made it between the look and the make.
        if (error instanceof CloudConflictError && (await this.stat(walk))?.isFolder) continue;
        throw error;
      }
    }
    return made;
  }

  /**
   * Writes a new file and refuses to replace one (`If-None-Match: *`). Success
   * is the cloud's 201/204 — the caller then asks the cloud what it holds.
   */
  async put(path: string, body: ReadableStream<Uint8Array> | Buffer, length: number, mime: string | null): Promise<void> {
    const response = await this.send(
      this.urlFor(path),
      {
        method: 'PUT',
        headers: {
          'Content-Length': String(length),
          'Content-Type': mime && /^[\w.+-]+\/[\w.+-]+$/.test(mime) ? mime : 'application/octet-stream',
          'If-None-Match': '*',
        },
        body: body as unknown as BodyInit,
        duplex: 'half',
      },
      TRANSFER_MS,
      false,
    );
    await response.body?.cancel().catch(() => undefined);
    assertOk(response, [201, 204]);
  }

  // ---- sharing (OCS) ------------------------------------------------------

  /** Shares a path with a Nextcloud group. */
  async shareWithGroup(path: string, group: string, bits: number): Promise<{ outcome: 'shared' | 'already' | 'unknown_group' | 'refused'; message: string }> {
    const response = await this.send(
      `${this.baseUrl}/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json`,
      {
        method: 'POST',
        headers: { 'OCS-APIRequest': 'true', Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ path: normaliseCloudPath(path), shareType: '1', shareWith: group, permissions: String(bits) }).toString(),
      },
      QUICK_MS,
      false,
    );
    const answer = await readOcs(response, [200, 403, 404, 400, 500]);
    if (answer.ok) return { outcome: 'shared', message: answer.message };
    if (/already shared/i.test(answer.message)) return { outcome: 'already', message: answer.message };
    if (answer.status === 404 || /group/i.test(answer.message)) return { outcome: 'unknown_group', message: answer.message };
    return { outcome: 'refused', message: answer.message || `Cloud Files refused the share (${answer.status}).` };
  }

  // ---- the account --------------------------------------------------------

  /** Who the cloud says this account is. */
  async whoAmI(): Promise<{ id: string; displayName: string | null }> {
    const response = await this.send(
      `${this.baseUrl}/ocs/v2.php/cloud/user?format=json`,
      { method: 'GET', headers: { 'OCS-APIRequest': 'true', Accept: 'application/json' } },
      QUICK_MS,
      true,
    );
    const answer = await readOcs(response, [200]);
    const data = answer.data as { id?: unknown; displayname?: unknown } | null;
    if (!answer.ok || typeof data?.id !== 'string') throw new CloudProtocolError('Cloud Files did not say who this account is.');
    return { id: data.id, displayName: typeof data.displayname === 'string' ? data.displayname : null };
  }

  /** Deletes the app password this client is using, at the cloud. A 401 means it is already gone. */
  async revokeAppPassword(): Promise<'revoked' | 'already_gone'> {
    const response = await this.send(
      `${this.baseUrl}/ocs/v2.php/core/apppassword`,
      { method: 'DELETE', headers: { 'OCS-APIRequest': 'true', Accept: 'application/json' } },
      QUICK_MS,
      false,
    );
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401) return 'already_gone';
    assertOk(response, [200, 204]);
    return 'revoked';
  }
}

async function readOcs(response: Response, accepted: readonly number[]): Promise<ReturnType<typeof parseOcs>> {
  // 401 is an auth failure whatever the body says.
  if (response.status === 401) {
    await response.body?.cancel().catch(() => undefined);
    throw new CloudAuthError('Cloud Files no longer accepts this account.', 401);
  }
  if (response.status >= 500) {
    await response.body?.cancel().catch(() => undefined);
    throw new CloudUnreachableError('Cloud Files answered with an error. Try again shortly.', response.status);
  }
  if (!accepted.includes(response.status)) {
    await response.body?.cancel().catch(() => undefined);
    assertOk(response, accepted);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new CloudProtocolError('Cloud Files did not answer in the expected format.');
  }
  return parseOcs(body);
}

// ---------------------------------------------------------------------------
// Calls that need no account
// ---------------------------------------------------------------------------

async function plain(url: string, init: RequestInit, doFetch: typeof fetch): Promise<Response> {
  try {
    return await doFetch(url, { ...init, headers: { 'User-Agent': USER_AGENT, ...(init.headers as Record<string, string> | undefined) }, redirect: 'manual', signal: AbortSignal.timeout(QUICK_MS) });
  } catch (error) {
    throw unreachable(error);
  }
}

export interface CloudServerStatus {
  readonly product: string | null;
  readonly version: string | null;
  readonly maintenance: boolean;
  readonly installed: boolean;
}

/** `status.php` — what the installation says about itself. Proves the address is a Nextcloud and is up. */
export async function serverStatus(baseUrl: string, doFetch: typeof fetch = fetch): Promise<CloudServerStatus> {
  const base = normaliseBaseUrl(baseUrl);
  const response = await plain(`${base}/status.php`, { method: 'GET', headers: { Accept: 'application/json' } }, doFetch);
  if (response.status >= 500) throw new CloudUnreachableError('Cloud Files answered with an error.', response.status);
  if (!response.ok) throw new CloudRequestError(`That address did not answer like Cloud Files (${response.status}).`, response.status);
  let body: { installed?: unknown; maintenance?: unknown; version?: unknown; productname?: unknown } | null;
  try {
    body = (await response.json()) as typeof body;
  } catch {
    throw new CloudProtocolError('That address did not answer like Cloud Files.');
  }
  if (!body || typeof body !== 'object' || typeof body.installed !== 'boolean') throw new CloudProtocolError('That address did not answer like Cloud Files.');
  return {
    product: typeof body.productname === 'string' && body.productname ? body.productname : 'Nextcloud',
    version: typeof body.version === 'string' ? body.version : null,
    maintenance: body.maintenance === true,
    installed: body.installed,
  };
}

/** Begins Login Flow v2: the cloud hands back the page the person opens and the endpoint to poll. */
export async function startLoginFlow(baseUrl: string, doFetch: typeof fetch = fetch): Promise<LoginFlowStart> {
  const base = normaliseBaseUrl(baseUrl);
  const response = await plain(`${base}/index.php/login/v2`, { method: 'POST', headers: { Accept: 'application/json' } }, doFetch);
  if (response.status >= 500) throw new CloudUnreachableError('Cloud Files answered with an error.', response.status);
  if (!response.ok) throw new CloudRequestError(`Cloud Files would not start a sign-in (${response.status}).`, response.status);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new CloudProtocolError('Cloud Files did not start a sign-in.');
  }
  return parseLoginFlowStart(body, base);
}

/** One poll of the flow: null while the person has not yet granted access, their app password once they have. */
export async function pollLoginFlow(start: Pick<LoginFlowStart, 'pollEndpoint' | 'pollToken'>, baseUrl: string, doFetch: typeof fetch = fetch): Promise<LoginFlowResult | null> {
  const base = normaliseBaseUrl(baseUrl);
  if (!sameOrigin(start.pollEndpoint, base)) throw new CloudProtocolError('The sign-in points at another server, which is refused.');
  const response = await plain(
    start.pollEndpoint,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams({ token: start.pollToken }).toString() },
    doFetch,
  );
  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (response.status >= 500) throw new CloudUnreachableError('Cloud Files answered with an error.', response.status);
  if (!response.ok) throw new CloudRequestError(`Cloud Files refused the sign-in (${response.status}).`, response.status);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new CloudProtocolError('Cloud Files did not return an app password.');
  }
  return parseLoginFlowResult(body);
}
