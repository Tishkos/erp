/**
 * QS Cloud Files — the pure rules (Platform phase, Agent 4).
 *
 * Qimah's Document Center is a window on a Nextcloud installation
 * (REQ-FIX-001 FIX-6, D-FX-3): the cloud keeps the files and decides who may
 * see them; Qimah keeps only the connection and the links to its own records.
 * Everything here is arithmetic on strings and XML — no network, no database —
 * so the rules that keep a person inside their own folder tree, and the
 * reading of what the server answers, can be held by tests that need neither.
 *
 *   paths     a path the browser sent is normalised or refused; `..` is never
 *             resolved, it is rejected, and a name that Nextcloud would treat
 *             as special is refused before it is sent
 *   urls      the integration's base URL: https, or http on this machine only
 *   WebDAV    PROPFIND answers read with a small namespace-aware XML reader
 *   OCS       the envelope Nextcloud wraps its share and user answers in
 *   Login v2  the shape of the two answers that link one person's account
 *   shares    the OCS permission bits a role's mapping stands for
 */

export class CloudPathError extends Error {
  readonly code = 'CLOUD_PATH';
  constructor(detail: string) {
    super(detail);
    this.name = 'CloudPathError';
  }
}

export class CloudConfigError extends Error {
  readonly code = 'CLOUD_CONFIG';
  constructor(detail: string) {
    super(detail);
    this.name = 'CloudConfigError';
  }
}

export class CloudProtocolError extends Error {
  readonly code = 'CLOUD_PROTOCOL';
  constructor(detail: string) {
    super(detail);
    this.name = 'CloudProtocolError';
  }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const MAX_PATH_LENGTH = 1024;
export const MAX_NAME_LENGTH = 255;

/** Largest file the Document Center sends to the cloud in one upload. */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
/** A segment that is — or would decode to — a dot or a double dot. */
const DOT_SEGMENT = /^(\.|%2e){1,2}$/i;
/** Characters a cloud file name may not carry (Nextcloud's own forbidden set, plus the two separators). */
const FORBIDDEN_NAME_CHARS = /[\\/<>:"|?*]/;
/** Endings and names Nextcloud refuses to store. */
const FORBIDDEN_NAME_ENDINGS = ['.part', '.filepart'];
const FORBIDDEN_NAMES = new Set(['.htaccess', '.ds_store', 'thumbs.db']);

/**
 * Checks one file or folder name.
 *
 * Refused rather than repaired: a name that was changed on its way to the
 * cloud is a file the person cannot find again.
 */
export function assertFileName(name: string): string {
  if (typeof name !== 'string' || name.length === 0) throw new CloudPathError('A name is required.');
  if (name !== name.trim()) throw new CloudPathError('A name cannot begin or end with a space.');
  if (name.length > MAX_NAME_LENGTH) throw new CloudPathError(`A name is at most ${MAX_NAME_LENGTH} characters.`);
  if (CONTROL.test(name)) throw new CloudPathError('A name cannot contain control characters.');
  if (name === '.' || name === '..' || DOT_SEGMENT.test(name)) throw new CloudPathError('That name is not allowed.');
  if (FORBIDDEN_NAME_CHARS.test(name)) {
    throw new CloudPathError('A name cannot contain any of  \\ / < > : " | ? *');
  }
  const lower = name.toLowerCase();
  if (FORBIDDEN_NAMES.has(lower) || FORBIDDEN_NAME_ENDINGS.some((ending) => lower.endsWith(ending))) {
    throw new CloudPathError('Cloud Files does not store a file with that name.');
  }
  if (name.endsWith('.')) throw new CloudPathError('A name cannot end with a dot.');
  return name;
}

/**
 * The canonical form of a path inside one person's cloud: a leading slash, no
 * trailing slash, single separators, every segment a valid name. The root is
 * `/`.
 *
 * `..` and `.` are refused outright, not resolved: a request that tries to
 * climb is a request to be told no, and resolving it would turn an attack into
 * a successful call to somewhere else.
 */
export function normaliseCloudPath(input: string | null | undefined): string {
  const raw = (input ?? '').toString();
  if (raw.length > MAX_PATH_LENGTH) throw new CloudPathError('That path is too long.');
  if (CONTROL.test(raw)) throw new CloudPathError('A path cannot contain control characters.');
  if (raw.includes('\\')) throw new CloudPathError('A path uses / between folders.');

  const segments = raw.split('/').filter((segment) => segment !== '');
  for (const segment of segments) {
    if (DOT_SEGMENT.test(segment)) throw new CloudPathError('A path cannot contain . or .. segments.');
    if (segment !== segment.trim()) throw new CloudPathError('A folder name cannot begin or end with a space.');
    if (segment.length > MAX_NAME_LENGTH) throw new CloudPathError(`A name is at most ${MAX_NAME_LENGTH} characters.`);
  }
  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}

export const isRoot = (path: string): boolean => path === '/';

export function parentOf(path: string): string {
  const normal = normaliseCloudPath(path);
  if (isRoot(normal)) return '/';
  const index = normal.lastIndexOf('/');
  return index <= 0 ? '/' : normal.slice(0, index);
}

export function baseName(path: string): string {
  const normal = normaliseCloudPath(path);
  return isRoot(normal) ? '' : normal.slice(normal.lastIndexOf('/') + 1);
}

/** `dir` + a single valid name. */
export function joinPath(dir: string, name: string): string {
  const base = normaliseCloudPath(dir);
  assertFileName(name);
  return isRoot(base) ? `/${name}` : `${base}/${name}`;
}

/** Is `path` the `root` itself or somewhere beneath it? Both are normalised first. */
export function isWithin(root: string, path: string): boolean {
  const r = normaliseCloudPath(root);
  const p = normaliseCloudPath(path);
  if (isRoot(r)) return true;
  return p === r || p.startsWith(`${r}/`);
}

/** Refuses a path outside the Document Center's root. Returns it normalised. */
export function assertWithin(root: string, path: string): string {
  const normal = normaliseCloudPath(path);
  if (!isWithin(root, normal)) throw new CloudPathError('That folder is outside the Document Center.');
  return normal;
}

export interface Crumb {
  readonly path: string;
  readonly name: string;
}

/** The folders from the root down to `path`, the root first (its name is the caller's to supply). */
export function breadcrumbs(root: string, path: string): readonly Crumb[] {
  const r = normaliseCloudPath(root);
  const p = assertWithin(r, path);
  const crumbs: Crumb[] = [{ path: r, name: baseName(r) }];
  const below = p === r ? [] : p.slice(isRoot(r) ? 1 : r.length + 1).split('/');
  let walk = r;
  for (const segment of below) {
    walk = isRoot(walk) ? `/${segment}` : `${walk}/${segment}`;
    crumbs.push({ path: walk, name: segment });
  }
  return crumbs;
}

/** A path as it goes into a WebDAV URL: every segment percent-encoded, the separators kept. */
export function encodeDavPath(path: string): string {
  const normal = normaliseCloudPath(path);
  return isRoot(normal) ? '' : `/${normal.slice(1).split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * The path a WebDAV `href` stands for, relative to the person's file root
 * (`…/remote.php/dav/files/<uid>`). Null for an href that is not beneath it.
 */
export function davHrefToPath(href: string, filesRootPath: string): string | null {
  let pathname: string;
  try {
    pathname = /^[a-z][a-z0-9+.-]*:\/\//i.test(href) ? new URL(href).pathname : href.split('?')[0]!;
  } catch {
    return null;
  }
  const decode = (path: string): string[] | null => {
    try {
      return path.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));
    } catch {
      return null;
    }
  };
  const have = decode(pathname);
  const prefix = decode(filesRootPath);
  if (!have || !prefix || have.length < prefix.length) return null;
  // Compared decoded, segment by segment: one server writes `@` and another `%40`.
  if (!prefix.every((segment, index) => segment === have[index])) return null;
  try {
    return normaliseCloudPath(`/${have.slice(prefix.length).join('/')}`);
  } catch {
    return null;
  }
}

/** The folder name a record's files are kept under: its number, made safe for a cloud name. */
export function folderNameForRecord(label: string): string {
  const cleaned = label
    .replace(CONTROL, ' ')
    .replace(/[\\/<>:"|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/, '');
  const safe = cleaned.length === 0 ? 'record' : cleaned.slice(0, MAX_NAME_LENGTH);
  return DOT_SEGMENT.test(safe) ? 'record' : safe;
}

// ---------------------------------------------------------------------------
// The integration's address
// ---------------------------------------------------------------------------

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * The canonical base URL of the Nextcloud installation, or a refusal.
 *
 * https only — an app password travels in every request — except on this
 * machine, where a development server or a test stub speaks plain http.
 * A path is allowed (Nextcloud may live under `/nextcloud`); credentials, a
 * query and a fragment are not.
 */
export function normaliseBaseUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new CloudConfigError('The address is not a web address (for example https://files.example.com).');
  }
  if (url.username || url.password) throw new CloudConfigError('The address cannot carry a user name or password.');
  if (url.search || url.hash) throw new CloudConfigError('The address cannot carry a query or a fragment.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    throw new CloudConfigError('The address must start with https:// (plain http is only accepted for this machine).');
  }
  const path = url.pathname.replace(/\/index\.php\/?$/, '').replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** `<base>/remote.php/dav/files/<uid>` — where one person's files are served. */
export function davFilesRootUrl(baseUrl: string, uid: string): string {
  return `${normaliseBaseUrl(baseUrl)}/remote.php/dav/files/${encodeURIComponent(uid)}`;
}

/** The path part of that URL, which is what a PROPFIND `href` begins with. */
export function davFilesRootPath(baseUrl: string, uid: string): string {
  return new URL(davFilesRootUrl(baseUrl, uid)).pathname;
}

/** Where a file opens in the cloud's own web interface. Nextcloud resolves the id per signed-in person. */
export function openInCloudUrl(baseUrl: string, fileId: string): string {
  return `${normaliseBaseUrl(baseUrl)}/index.php/f/${encodeURIComponent(fileId)}`;
}

// ---------------------------------------------------------------------------
// Sharing — OCS permission bits
// ---------------------------------------------------------------------------

/** Nextcloud's share permission bits. */
export const SHARE_READ = 1;
export const SHARE_UPDATE = 2;
export const SHARE_CREATE = 4;
export const SHARE_DELETE = 8;
export const SHARE_SHARE = 16;

/**
 * What a role's mapping stands for in Nextcloud: read always; "write" is
 * update + create + delete (a person who may add to a folder may also tidy
 * it); "share" lets the group pass it on.
 */
export function shareBits(permission: { readonly write: boolean; readonly share: boolean }): number {
  return SHARE_READ | (permission.write ? SHARE_UPDATE | SHARE_CREATE | SHARE_DELETE : 0) | (permission.share ? SHARE_SHARE : 0);
}

export interface GroupMapping {
  readonly roleCode: string;
  readonly groupName: string;
  readonly canWrite: boolean;
  readonly canShare: boolean;
  readonly active: boolean;
}

export interface ShareTarget {
  readonly groupName: string;
  readonly bits: number;
  readonly roles: readonly string[];
}

/**
 * The shares a new folder gets: one per Nextcloud group, from the active
 * mappings of the given roles. Two roles mapped to one group make one share,
 * at the wider of their two permissions.
 */
export function sharesFor(mappings: readonly GroupMapping[], roles: ReadonlySet<string> | null): readonly ShareTarget[] {
  const byGroup = new Map<string, { bits: number; roles: string[] }>();
  for (const mapping of mappings) {
    if (!mapping.active) continue;
    if (roles && !roles.has(mapping.roleCode)) continue;
    const bits = shareBits({ write: mapping.canWrite, share: mapping.canShare });
    const existing = byGroup.get(mapping.groupName);
    if (existing) {
      existing.bits |= bits;
      existing.roles.push(mapping.roleCode);
    } else {
      byGroup.set(mapping.groupName, { bits, roles: [mapping.roleCode] });
    }
  }
  return [...byGroup.entries()]
    .map(([groupName, value]) => ({ groupName, bits: value.bits, roles: value.roles.sort() }))
    .sort((a, b) => a.groupName.localeCompare(b.groupName));
}

/** A Nextcloud group name as the mapping screen accepts it. */
export function assertGroupName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new CloudConfigError('A Cloud Files group is required.');
  if (trimmed.length > 64) throw new CloudConfigError('A group name is at most 64 characters.');
  if (CONTROL.test(trimmed)) throw new CloudConfigError('A group name cannot contain control characters.');
  return trimmed;
}

// ---------------------------------------------------------------------------
// Links between a cloud file and an ERP record
// ---------------------------------------------------------------------------

const OBJECT_TYPE = /^[a-z][a-z0-9_]{1,63}$/;

export class CloudLinkError extends Error {
  readonly code = 'CLOUD_LINK';
  constructor(detail: string) {
    super(detail);
    this.name = 'CloudLinkError';
  }
}

/** The pieces of a link, checked for shape. Whether the person may open the record is the registry's question. */
export function assertLinkShape(link: { fileId: string; objectType: string; objectId: string }): void {
  if (!/^[A-Za-z0-9:_.-]{1,64}$/.test(link.fileId)) throw new CloudLinkError('That file has no usable identifier in Cloud Files.');
  if (!OBJECT_TYPE.test(link.objectType)) throw new CloudLinkError('That kind of record cannot be linked.');
  if (link.objectId.length === 0 || link.objectId.length > 200 || CONTROL.test(link.objectId)) {
    throw new CloudLinkError('That record cannot be linked.');
  }
}

/** `type:id` as it travels in a query string (`?linkTo=`). */
export function parseLinkTarget(value: string | null | undefined): { objectType: string; objectId: string } | null {
  if (!value) return null;
  const index = value.indexOf(':');
  if (index <= 0) return null;
  const objectType = value.slice(0, index);
  const objectId = value.slice(index + 1);
  if (!OBJECT_TYPE.test(objectType) || objectId.length === 0 || objectId.length > 200 || CONTROL.test(objectId)) return null;
  return { objectType, objectId };
}

export const formatLinkTarget = (objectType: string, objectId: string): string => `${objectType}:${objectId}`;

// ---------------------------------------------------------------------------
// What a listing entry is
// ---------------------------------------------------------------------------

export type EntryKind = 'folder' | 'pdf' | 'image' | 'spreadsheet' | 'document' | 'presentation' | 'text' | 'other';

export const ENTRY_FILTERS = ['all', 'folders', 'pdf', 'images', 'spreadsheets', 'documents', 'linked'] as const;
export type EntryFilter = (typeof ENTRY_FILTERS)[number];

export function isEntryFilter(value: string): value is EntryFilter {
  return (ENTRY_FILTERS as readonly string[]).includes(value);
}

export function kindOf(entry: { readonly isFolder: boolean; readonly name: string; readonly mime: string | null }): EntryKind {
  if (entry.isFolder) return 'folder';
  const mime = (entry.mime ?? '').toLowerCase();
  const dot = entry.name.lastIndexOf('.');
  const extension = dot === -1 ? '' : entry.name.slice(dot + 1).toLowerCase();
  if (mime === 'application/pdf' || extension === 'pdf') return 'pdf';
  if (mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'tif', 'tiff'].includes(extension)) return 'image';
  if (mime.includes('spreadsheet') || mime === 'text/csv' || ['xls', 'xlsx', 'ods', 'csv'].includes(extension)) return 'spreadsheet';
  if (mime.includes('presentation') || ['ppt', 'pptx', 'odp'].includes(extension)) return 'presentation';
  if (mime.includes('wordprocessing') || mime === 'application/msword' || mime.includes('opendocument.text') || ['doc', 'docx', 'odt', 'rtf'].includes(extension)) return 'document';
  if (mime.startsWith('text/') || extension === 'txt') return 'text';
  return 'other';
}

export function passesFilter(
  entry: { readonly isFolder: boolean; readonly name: string; readonly mime: string | null },
  filter: EntryFilter,
  linked: boolean,
): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'linked':
      return linked;
    case 'folders':
      return entry.isFolder;
    case 'pdf':
      return kindOf(entry) === 'pdf';
    case 'images':
      return kindOf(entry) === 'image';
    case 'spreadsheets':
      return kindOf(entry) === 'spreadsheet';
    case 'documents':
      return ['document', 'presentation', 'text'].includes(kindOf(entry));
  }
}

export type SortKey = 'name' | 'modified' | 'size';
export const SORT_KEYS: readonly SortKey[] = ['name', 'modified', 'size'];
export const isSortKey = (value: string): value is SortKey => (SORT_KEYS as readonly string[]).includes(value);

/** Folders first, then by the key; the name breaks every tie, so a listing never reshuffles. */
export function sortEntries<T extends { isFolder: boolean; name: string; size: number | null; modified: string | null }>(
  entries: readonly T[],
  key: SortKey,
  descending: boolean,
): T[] {
  const sign = descending ? -1 : 1;
  const byName = (a: T, b: T) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  return [...entries].sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
    let order = 0;
    if (key === 'modified') order = (Date.parse(a.modified ?? '') || 0) - (Date.parse(b.modified ?? '') || 0);
    else if (key === 'size') order = (a.size ?? 0) - (b.size ?? 0);
    else order = byName(a, b);
    return order !== 0 ? sign * order : byName(a, b);
  });
}

/** Bytes as a person reads them; a dash for a size the cloud did not give. */
export function readableSize(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/**
 * Can the browser show the cloud's own preview of this entry? Only when the
 * cloud said it can (`nc:has-preview`) and the entry is a file — never guessed
 * from the extension.
 */
export const canPreview = (entry: { readonly isFolder: boolean; readonly hasPreview: boolean }): boolean => !entry.isFolder && entry.hasPreview;

// ---------------------------------------------------------------------------
// Reading what the server answers
// ---------------------------------------------------------------------------

interface XmlNode {
  readonly ns: string;
  readonly name: string;
  readonly children: XmlNode[];
  text: string;
}

const MAX_XML_BYTES = 16 * 1024 * 1024;
const MAX_XML_DEPTH = 64;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x')) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith('#')) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return ENTITIES[body] ?? whole;
  });
}

/**
 * A small namespace-aware XML reader for WebDAV answers: elements, attributes,
 * text, CDATA, comments and processing instructions. A DOCTYPE is refused (an
 * answer from a cloud has none, and an entity declaration is how XML turns
 * into an attack). Prefixes are whatever the server chose; elements are known
 * by their namespace URI and local name.
 */
function parseXml(source: string): XmlNode {
  if (source.length > MAX_XML_BYTES) throw new CloudProtocolError('The answer from Cloud Files is too large to read.');
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new CloudProtocolError('The answer from Cloud Files carries a document type, which is refused.');

  const root: XmlNode = { ns: '', name: '#document', children: [], text: '' };
  const stack: Array<{ node: XmlNode; scopes: Map<string, string> }> = [{ node: root, scopes: new Map([['xml', 'http://www.w3.org/XML/1998/namespace']]) }];
  const tag = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = tag.exec(source)) !== null) {
    const top = stack[stack.length - 1]!;
    if (match.index > cursor) top.node.text += decodeEntities(source.slice(cursor, match.index));
    cursor = tag.lastIndex;

    if (match[1] !== undefined) {
      top.node.text += match[1];
    } else if (match[2] !== undefined) {
      if (stack.length === 1) throw new CloudProtocolError('The answer from Cloud Files is not well-formed.');
      stack.pop();
    } else if (match[3] !== undefined) {
      const qname = match[3];
      const scopes = new Map(top.scopes);
      const attributes = match[4] ?? '';
      for (const attribute of attributes.matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        const key = attribute[1]!;
        const value = decodeEntities(attribute[2] ?? attribute[3] ?? '');
        if (key === 'xmlns') scopes.set('', value);
        else if (key.startsWith('xmlns:')) scopes.set(key.slice(6), value);
      }
      const colon = qname.indexOf(':');
      const prefix = colon === -1 ? '' : qname.slice(0, colon);
      const local = colon === -1 ? qname : qname.slice(colon + 1);
      const node: XmlNode = { ns: scopes.get(prefix) ?? '', name: local, children: [], text: '' };
      top.node.children.push(node);
      if (match[5] !== '/') {
        if (stack.length >= MAX_XML_DEPTH) throw new CloudProtocolError('The answer from Cloud Files is nested too deeply.');
        stack.push({ node, scopes });
      }
    }
  }
  if (stack.length !== 1) throw new CloudProtocolError('The answer from Cloud Files is not well-formed.');
  const element = root.children[0];
  if (!element) throw new CloudProtocolError('The answer from Cloud Files is empty.');
  return element;
}

const NS_DAV = 'DAV:';
const NS_OC = 'http://owncloud.org/ns';
const NS_NC = 'http://nextcloud.org/ns';

const child = (node: XmlNode, ns: string, name: string): XmlNode | undefined => node.children.find((c) => c.ns === ns && c.name === name);
const childrenOf = (node: XmlNode, ns: string, name: string): XmlNode[] => node.children.filter((c) => c.ns === ns && c.name === name);

/** One resource as a PROPFIND (or SEARCH) answers it. */
export interface DavEntry {
  /** The href exactly as the server wrote it. */
  readonly href: string;
  readonly isFolder: boolean;
  readonly size: number | null;
  readonly modified: string | null;
  readonly mime: string | null;
  readonly etag: string | null;
  /** Nextcloud's numeric file id — the key a link to an ERP record is kept by. */
  readonly fileId: string | null;
  /** Nextcloud's permission letters (`oc:permissions`): C may add files, K may add folders, W may change, D may delete. */
  readonly permissions: string | null;
  readonly hasPreview: boolean;
  /** `nc:meta-path-for-user` from the file-id lookup, when asked. */
  readonly pathForUser: string | null;
}

const toNumber = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && value.trim() !== '' ? parsed : null;
};

/** Reads a 207 multistatus into entries, taking only the properties the server answered with 200. */
export function parsePropfind(xml: string): readonly DavEntry[] {
  const root = parseXml(xml);
  if (root.ns !== NS_DAV || root.name !== 'multistatus') throw new CloudProtocolError('Cloud Files did not answer with a listing.');
  const entries: DavEntry[] = [];
  for (const response of childrenOf(root, NS_DAV, 'response')) {
    const href = child(response, NS_DAV, 'href')?.text.trim();
    if (!href) continue;
    const values = new Map<string, XmlNode>();
    for (const propstat of childrenOf(response, NS_DAV, 'propstat')) {
      const status = child(propstat, NS_DAV, 'status')?.text ?? 'HTTP/1.1 200 OK';
      if (!/\s200\s/.test(`${status} `)) continue;
      const prop = child(propstat, NS_DAV, 'prop');
      if (!prop) continue;
      for (const property of prop.children) values.set(`${property.ns}|${property.name}`, property);
    }
    const get = (ns: string, name: string) => values.get(`${ns}|${name}`);
    const resourcetype = get(NS_DAV, 'resourcetype');
    const isFolder = Boolean(resourcetype && child(resourcetype, NS_DAV, 'collection'));
    const sizeText = isFolder ? (get(NS_OC, 'size')?.text ?? get(NS_DAV, 'quota-used-bytes')?.text) : get(NS_DAV, 'getcontentlength')?.text;
    const hasPreview = (get(NS_NC, 'has-preview')?.text ?? '').trim().toLowerCase() === 'true';
    entries.push({
      href,
      isFolder,
      size: toNumber(sizeText),
      modified: (() => {
        const text = get(NS_DAV, 'getlastmodified')?.text.trim();
        const time = text ? Date.parse(text) : Number.NaN;
        return Number.isNaN(time) ? null : new Date(time).toISOString();
      })(),
      mime: get(NS_DAV, 'getcontenttype')?.text.trim() || null,
      etag: get(NS_DAV, 'getetag')?.text.trim().replace(/^"|"$/g, '') || null,
      fileId: get(NS_OC, 'fileid')?.text.trim() || null,
      permissions: get(NS_OC, 'permissions')?.text.trim() ?? null,
      hasPreview,
      pathForUser: get(NS_NC, 'meta-path-for-user')?.text.trim() || null,
    });
  }
  return entries;
}

// ---- OCS ------------------------------------------------------------------

export interface OcsAnswer {
  readonly ok: boolean;
  readonly status: number;
  readonly message: string;
  readonly data: unknown;
}

/** Reads Nextcloud's OCS envelope (`{ocs:{meta,data}}`). Status 100 (v1) and 200 (v2) are success. */
export function parseOcs(body: unknown): OcsAnswer {
  const ocs = (body as { ocs?: { meta?: { statuscode?: unknown; message?: unknown; status?: unknown }; data?: unknown } } | null)?.ocs;
  if (!ocs || typeof ocs !== 'object' || !ocs.meta) throw new CloudProtocolError('Cloud Files did not answer in the expected format.');
  const status = Number(ocs.meta.statuscode);
  if (!Number.isFinite(status)) throw new CloudProtocolError('Cloud Files did not answer in the expected format.');
  return {
    ok: status === 100 || status === 200,
    status,
    message: typeof ocs.meta.message === 'string' ? ocs.meta.message : '',
    data: ocs.data,
  };
}

// ---- Login Flow v2 --------------------------------------------------------

/** How long Nextcloud keeps a login flow open. */
export const LOGIN_FLOW_LIFETIME_MS = 20 * 60 * 1000;

export interface LoginFlowStart {
  readonly pollToken: string;
  readonly pollEndpoint: string;
  readonly loginUrl: string;
}

/** The answer to `POST /index.php/login/v2`. Both URLs must be the cloud's own. */
export function parseLoginFlowStart(body: unknown, baseUrl: string): LoginFlowStart {
  const value = body as { poll?: { token?: unknown; endpoint?: unknown }; login?: unknown } | null;
  const token = value?.poll?.token;
  const endpoint = value?.poll?.endpoint;
  const login = value?.login;
  if (typeof token !== 'string' || typeof endpoint !== 'string' || typeof login !== 'string' || token === '') {
    throw new CloudProtocolError('Cloud Files did not start a sign-in.');
  }
  if (!sameOrigin(endpoint, baseUrl) || !sameOrigin(login, baseUrl)) {
    throw new CloudProtocolError('Cloud Files answered with an address on another server, which is refused.');
  }
  return { pollToken: token, pollEndpoint: endpoint, loginUrl: login };
}

export interface LoginFlowResult {
  readonly server: string;
  readonly loginName: string;
  readonly appPassword: string;
}

export function parseLoginFlowResult(body: unknown): LoginFlowResult {
  const value = body as { server?: unknown; loginName?: unknown; appPassword?: unknown } | null;
  if (typeof value?.loginName !== 'string' || typeof value.appPassword !== 'string' || value.loginName === '' || value.appPassword === '') {
    throw new CloudProtocolError('Cloud Files did not return an app password.');
  }
  return { server: typeof value.server === 'string' ? value.server : '', loginName: value.loginName, appPassword: value.appPassword };
}

export type AttemptState = 'pending' | 'expired';

/** A started login flow is pending until its time is up; Nextcloud forgets it then. */
export function attemptState(attempt: { readonly expiresAt: Date }, now: Date): AttemptState {
  return now.getTime() >= attempt.expiresAt.getTime() ? 'expired' : 'pending';
}

export const attemptExpiry = (now: Date): Date => new Date(now.getTime() + LOGIN_FLOW_LIFETIME_MS);

// ---------------------------------------------------------------------------
// The state a screen is in
// ---------------------------------------------------------------------------

/**
 * Why the Document Center has nothing to list, said once and in one place so
 * the screen, the record's paperclip and the tests all agree.
 */
export type ConnectionState =
  | 'not_configured' // switched off, or no address
  | 'not_linked' // this person has not linked their Cloud Files account
  | 'relink' // the app password was revoked at the cloud, or the address changed
  | 'ready';

export function connectionState(input: {
  readonly enabled: boolean;
  readonly baseUrl: string | null;
  readonly account: { readonly serverUrl: string; readonly lastError: string | null } | null;
}): ConnectionState {
  if (!input.enabled || !input.baseUrl) return 'not_configured';
  if (!input.account) return 'not_linked';
  if (input.account.lastError === 'unauthorised' || input.account.serverUrl !== input.baseUrl) return 'relink';
  return 'ready';
}
