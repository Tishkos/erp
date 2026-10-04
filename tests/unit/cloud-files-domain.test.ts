/**
 * Platform · Document Center · the pure rules of QS Cloud Files.
 *
 *   paths      a path from the browser is normalised or refused — never resolved
 *   addresses  https, or plain http on this machine only
 *   PROPFIND   the listing is read by namespace, whatever prefixes the server chose
 *   shares     the role mapping's permission bits; two roles to one group make one share
 *   links      the shape of a link; the `type:id` carried in a query string
 *   Login v2   the two answers that link one person's account, and when a flow is over
 *   secrets    the app password is sealed to its owner and opens for nobody else
 */
import { describe, expect, it } from 'vitest';
import {
  CloudConfigError,
  CloudLinkError,
  CloudPathError,
  CloudProtocolError,
  assertFileName,
  assertLinkShape,
  assertWithin,
  attemptExpiry,
  attemptState,
  baseName,
  breadcrumbs,
  canPreview,
  connectionState,
  davFilesRootPath,
  davHrefToPath,
  encodeDavPath,
  folderNameForRecord,
  isWithin,
  joinPath,
  kindOf,
  normaliseBaseUrl,
  normaliseCloudPath,
  parentOf,
  parseLinkTarget,
  parseLoginFlowResult,
  parseLoginFlowStart,
  parseOcs,
  parsePropfind,
  passesFilter,
  shareBits,
  sharesFor,
  sortEntries,
} from '@domain/cloud-files';
import { SecretKeyError, openSecret, sealSecret, secretKeyProblem } from '@/server/secret-box';

describe('paths: normalised or refused', () => {
  it('gives the root and the canonical form', () => {
    expect(normaliseCloudPath('')).toBe('/');
    expect(normaliseCloudPath(undefined)).toBe('/');
    expect(normaliseCloudPath('/')).toBe('/');
    expect(normaliseCloudPath('Invoices//2026/')).toBe('/Invoices/2026');
    expect(normaliseCloudPath('/a/b c/d')).toBe('/a/b c/d');
    expect(normaliseCloudPath('/فواتير/٢٠٢٦')).toBe('/فواتير/٢٠٢٦');
  });

  it('refuses a climb however it is written', () => {
    for (const hostile of ['/..', '../etc', '/a/../b', '/a/./b', '/a/%2e%2e/b', '/%2E/x', '/a/..%2f..', '..']) {
      // `..%2f..` is one literal segment (a name with a percent sign) and is fine; the rest must be refused.
      if (hostile === '/a/..%2f..') {
        expect(normaliseCloudPath(hostile)).toBe('/a/..%2f..');
        continue;
      }
      expect(() => normaliseCloudPath(hostile), hostile).toThrow(CloudPathError);
    }
  });

  it('refuses a backslash, control characters and a very long path', () => {
    expect(() => normaliseCloudPath('/a\\b')).toThrow(CloudPathError);
    expect(() => normaliseCloudPath('/a\u0000b')).toThrow(CloudPathError);
    expect(() => normaliseCloudPath('/a\nb')).toThrow(CloudPathError);
    expect(() => normaliseCloudPath(`/${'x'.repeat(2000)}`)).toThrow(CloudPathError);
    expect(() => normaliseCloudPath(`/${'y'.repeat(300)}`)).toThrow(CloudPathError);
    expect(() => normaliseCloudPath('/a/ b')).toThrow(CloudPathError);
  });

  it('checks names before they are sent', () => {
    expect(assertFileName('Invoice 12.pdf')).toBe('Invoice 12.pdf');
    for (const bad of ['', ' x', 'x ', '.', '..', 'a/b', 'a\\b', 'a:b', 'a?b', 'a*b', 'a"b', 'a|b', 'a<b', 'x.part', 'x.filepart', '.htaccess', 'x.', 'x\u0001']) {
      expect(() => assertFileName(bad), JSON.stringify(bad)).toThrow(CloudPathError);
    }
    expect(() => assertFileName('x'.repeat(256))).toThrow(CloudPathError);
  });

  it('joins, splits and contains', () => {
    expect(joinPath('/', 'a')).toBe('/a');
    expect(joinPath('/a/b', 'c.pdf')).toBe('/a/b/c.pdf');
    expect(() => joinPath('/a', '../x')).toThrow(CloudPathError);
    expect(parentOf('/a/b/c')).toBe('/a/b');
    expect(parentOf('/a')).toBe('/');
    expect(parentOf('/')).toBe('/');
    expect(baseName('/a/b/c.pdf')).toBe('c.pdf');
    expect(baseName('/')).toBe('');
    expect(isWithin('/', '/anything')).toBe(true);
    expect(isWithin('/QS', '/QS')).toBe(true);
    expect(isWithin('/QS', '/QS/Invoices')).toBe(true);
    expect(isWithin('/QS', '/QSX')).toBe(false);
    expect(isWithin('/QS', '/other')).toBe(false);
    expect(assertWithin('/QS', '/QS/a')).toBe('/QS/a');
    expect(() => assertWithin('/QS', '/Personal')).toThrow(CloudPathError);
    expect(() => assertWithin('/QS', '/QS/../Personal')).toThrow(CloudPathError);
  });

  it('draws breadcrumbs from the root down', () => {
    expect(breadcrumbs('/', '/')).toEqual([{ path: '/', name: '' }]);
    expect(breadcrumbs('/', '/a/b')).toEqual([
      { path: '/', name: '' },
      { path: '/a', name: 'a' },
      { path: '/a/b', name: 'b' },
    ]);
    expect(breadcrumbs('/QS', '/QS/Invoices/2026').map((c) => c.path)).toEqual(['/QS', '/QS/Invoices', '/QS/Invoices/2026']);
    expect(() => breadcrumbs('/QS', '/other')).toThrow(CloudPathError);
  });

  it('encodes every segment for a WebDAV address and reads an href back', () => {
    expect(encodeDavPath('/')).toBe('');
    expect(encodeDavPath('/a b/ç#?.pdf')).toBe('/a%20b/%C3%A7%23%3F.pdf');
    const root = davFilesRootPath('https://files.example.com/nextcloud', 'ali@qs');
    expect(root).toBe('/nextcloud/remote.php/dav/files/ali%40qs');
    expect(davHrefToPath('/nextcloud/remote.php/dav/files/ali@qs/Invoices/a%20b.pdf', root)).toBe('/Invoices/a b.pdf');
    expect(davHrefToPath('https://files.example.com/nextcloud/remote.php/dav/files/ali%40qs/', root)).toBe('/');
    expect(davHrefToPath('/nextcloud/remote.php/dav/files/someone-else/x', root)).toBeNull();
    expect(davHrefToPath('/nextcloud/remote.php/dav/files/ali%40qs/../x', root)).toBeNull();
  });

  it('makes a folder name from a record number', () => {
    expect(folderNameForRecord('INV-HQ-2026-000001')).toBe('INV-HQ-2026-000001');
    expect(folderNameForRecord('A/B\\C:D')).toBe('A-B-C-D');
    expect(folderNameForRecord('  ..  ')).toBe('record');
    expect(folderNameForRecord('')).toBe('record');
  });
});

describe('the integration address', () => {
  it('keeps https, a sub-path, and drops index.php and the trailing slash', () => {
    expect(normaliseBaseUrl('https://files.qs-groups.com/')).toBe('https://files.qs-groups.com');
    expect(normaliseBaseUrl(' https://files.qs-groups.com/index.php ')).toBe('https://files.qs-groups.com');
    expect(normaliseBaseUrl('https://example.com/nextcloud/')).toBe('https://example.com/nextcloud');
  });

  it('accepts plain http for this machine only', () => {
    expect(normaliseBaseUrl('http://127.0.0.1:3910')).toBe('http://127.0.0.1:3910');
    expect(normaliseBaseUrl('http://localhost:8080/')).toBe('http://localhost:8080');
    expect(() => normaliseBaseUrl('http://files.qs-groups.com')).toThrow(CloudConfigError);
  });

  it('refuses credentials, queries and things that are not addresses', () => {
    for (const bad of ['', 'files.qs-groups.com', 'ftp://x.com', 'https://u:p@x.com', 'https://x.com/?a=1', 'https://x.com/#f', 'javascript:alert(1)']) {
      expect(() => normaliseBaseUrl(bad), bad).toThrow(CloudConfigError);
    }
  });
});

const MULTISTATUS = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
  <d:response>
    <d:href>/remote.php/dav/files/ali/Invoices/</d:href>
    <d:propstat>
      <d:prop>
        <d:getlastmodified>Sat, 03 Oct 2026 08:00:00 GMT</d:getlastmodified>
        <d:resourcetype><d:collection/></d:resourcetype>
        <d:getetag>&quot;abc&quot;</d:getetag>
        <oc:fileid>100</oc:fileid>
        <oc:size>2048</oc:size>
        <oc:permissions>RGDNVCK</oc:permissions>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
    <d:propstat><d:prop><d:getcontentlength/><d:getcontenttype/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/files/ali/Invoices/Q3%20&amp;%20Q4.pdf</d:href>
    <d:propstat>
      <d:prop>
        <d:getlastmodified>Fri, 02 Oct 2026 10:30:00 GMT</d:getlastmodified>
        <d:getcontentlength>1500</d:getcontentlength>
        <d:resourcetype/>
        <d:getcontenttype>application/pdf</d:getcontenttype>
        <d:getetag>"def"</d:getetag>
        <oc:fileid>101</oc:fileid>
        <oc:permissions>RGDNVW</oc:permissions>
        <nc:has-preview>true</nc:has-preview>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

describe('PROPFIND answers', () => {
  it('reads a folder and a file with what the server said and nothing it did not', () => {
    const [folder, file] = parsePropfind(MULTISTATUS);
    expect(folder).toMatchObject({ isFolder: true, size: 2048, fileId: '100', etag: 'abc', permissions: 'RGDNVCK', mime: null, hasPreview: false });
    expect(folder!.modified).toBe('2026-10-03T08:00:00.000Z');
    expect(file).toMatchObject({ isFolder: false, size: 1500, fileId: '101', mime: 'application/pdf', etag: 'def', hasPreview: true });
    expect(file!.href).toBe('/remote.php/dav/files/ali/Invoices/Q3%20&%20Q4.pdf');
  });

  it('knows elements by namespace, not by the prefix the server picked', () => {
    const odd = `<A:multistatus xmlns:A="DAV:" xmlns:Z="http://owncloud.org/ns"><A:response><A:href>/x/y</A:href><A:propstat><A:prop><Z:fileid>7</Z:fileid><A:resourcetype><A:collection/></A:resourcetype></A:prop><A:status>HTTP/1.1 200 OK</A:status></A:propstat></A:response></A:multistatus>`;
    expect(parsePropfind(odd)[0]).toMatchObject({ isFolder: true, fileId: '7' });
    const defaultNs = `<multistatus xmlns="DAV:"><response><href>/x</href><propstat><prop><getcontentlength>5</getcontentlength></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`;
    expect(parsePropfind(defaultNs)[0]).toMatchObject({ size: 5, isFolder: false });
  });

  it('reads the path the file-id lookup answers with', () => {
    const meta = `<d:multistatus xmlns:d="DAV:" xmlns:nc="http://nextcloud.org/ns"><d:response><d:href>/remote.php/dav/meta/101</d:href><d:propstat><d:prop><nc:meta-path-for-user>/Shared/a b.pdf</nc:meta-path-for-user></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
    expect(parsePropfind(meta)[0]!.pathForUser).toBe('/Shared/a b.pdf');
  });

  it('refuses what is not a listing, or is hostile', () => {
    expect(() => parsePropfind('<html>login</html>')).toThrow(CloudProtocolError);
    expect(() => parsePropfind('')).toThrow(CloudProtocolError);
    expect(() => parsePropfind('<d:multistatus xmlns:d="DAV:"><d:response>')).toThrow(CloudProtocolError);
    expect(() => parsePropfind('<!DOCTYPE x [<!ENTITY a "b">]><d:multistatus xmlns:d="DAV:"/>')).toThrow(CloudProtocolError);
    expect(() => parsePropfind(`${'<a>'.repeat(100)}`)).toThrow(CloudProtocolError);
  });

  it('decodes numeric character references', () => {
    const xml = `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/x/&#x41;&#66;</d:href><d:propstat><d:prop/><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
    expect(parsePropfind(xml)[0]!.href).toBe('/x/AB');
  });
});

describe('what an entry is', () => {
  const file = (name: string, mime: string | null = null) => ({ isFolder: false, name, mime });
  it('classifies by the cloud\'s type first and the name second', () => {
    expect(kindOf({ isFolder: true, name: 'x', mime: null })).toBe('folder');
    expect(kindOf(file('a.pdf'))).toBe('pdf');
    expect(kindOf(file('scan', 'application/pdf'))).toBe('pdf');
    expect(kindOf(file('p.JPG'))).toBe('image');
    expect(kindOf(file('s.xlsx'))).toBe('spreadsheet');
    expect(kindOf(file('d.docx'))).toBe('document');
    expect(kindOf(file('n.txt'))).toBe('text');
    expect(kindOf(file('a.bin', 'application/octet-stream'))).toBe('other');
  });

  it('filters, and previews only what the cloud says it can', () => {
    expect(passesFilter(file('a.pdf'), 'pdf', false)).toBe(true);
    expect(passesFilter(file('a.pdf'), 'images', false)).toBe(false);
    expect(passesFilter(file('a.pdf'), 'linked', false)).toBe(false);
    expect(passesFilter(file('a.pdf'), 'linked', true)).toBe(true);
    expect(passesFilter({ isFolder: true, name: 'f', mime: null }, 'folders', false)).toBe(true);
    expect(passesFilter(file('d.docx'), 'documents', false)).toBe(true);
    expect(canPreview({ isFolder: false, hasPreview: true })).toBe(true);
    expect(canPreview({ isFolder: false, hasPreview: false })).toBe(false);
    expect(canPreview({ isFolder: true, hasPreview: true })).toBe(false);
  });

  it('sorts folders first and breaks every tie by name', () => {
    const rows = [
      { isFolder: false, name: 'b.pdf', size: 10, modified: '2026-01-02T00:00:00Z' },
      { isFolder: true, name: 'Zed', size: 0, modified: '2026-01-01T00:00:00Z' },
      { isFolder: false, name: 'a.pdf', size: 10, modified: '2026-01-03T00:00:00Z' },
      { isFolder: true, name: 'Alpha', size: 0, modified: null },
    ];
    expect(sortEntries(rows, 'name', false).map((r) => r.name)).toEqual(['Alpha', 'Zed', 'a.pdf', 'b.pdf']);
    expect(sortEntries(rows, 'size', false).map((r) => r.name)).toEqual(['Alpha', 'Zed', 'a.pdf', 'b.pdf']);
    expect(sortEntries(rows, 'modified', true).map((r) => r.name)).toEqual(['Zed', 'Alpha', 'a.pdf', 'b.pdf']);
  });
});

describe('sharing through the role mapping', () => {
  it('turns write and share into Nextcloud\'s bits', () => {
    expect(shareBits({ write: false, share: false })).toBe(1);
    expect(shareBits({ write: true, share: false })).toBe(15);
    expect(shareBits({ write: false, share: true })).toBe(17);
    expect(shareBits({ write: true, share: true })).toBe(31);
  });

  const mappings = [
    { roleCode: 'accounting_manager', groupName: 'QS-Accounts', canWrite: true, canShare: false, active: true },
    { roleCode: 'accounting_officer', groupName: 'QS-Accounts', canWrite: false, canShare: true, active: true },
    { roleCode: 'ceo', groupName: 'QS-Executives', canWrite: false, canShare: false, active: true },
    { roleCode: 'hr_manager', groupName: 'QS-HR', canWrite: true, canShare: true, active: false },
  ];

  it('makes one share per group, at the wider permission, from active mappings only', () => {
    expect(sharesFor(mappings, null)).toEqual([
      { groupName: 'QS-Accounts', bits: 1 | 14 | 16, roles: ['accounting_manager', 'accounting_officer'] },
      { groupName: 'QS-Executives', bits: 1, roles: ['ceo'] },
    ]);
  });

  it('limits the shares to the roles that may open the record', () => {
    expect(sharesFor(mappings, new Set(['ceo']))).toEqual([{ groupName: 'QS-Executives', bits: 1, roles: ['ceo'] }]);
    expect(sharesFor(mappings, new Set(['hr_manager']))).toEqual([]);
    expect(sharesFor(mappings, new Set())).toEqual([]);
  });
});

describe('links to ERP records', () => {
  it('checks the shape of a link', () => {
    expect(() => assertLinkShape({ fileId: '101', objectType: 'ap_invoice', objectId: 'uuid-1' })).not.toThrow();
    expect(() => assertLinkShape({ fileId: '', objectType: 'ap_invoice', objectId: 'x' })).toThrow(CloudLinkError);
    expect(() => assertLinkShape({ fileId: '1 2', objectType: 'ap_invoice', objectId: 'x' })).toThrow(CloudLinkError);
    expect(() => assertLinkShape({ fileId: '1', objectType: 'Ap Invoice', objectId: 'x' })).toThrow(CloudLinkError);
    expect(() => assertLinkShape({ fileId: '1', objectType: 'ap_invoice', objectId: '' })).toThrow(CloudLinkError);
    expect(() => assertLinkShape({ fileId: '1', objectType: 'ap_invoice', objectId: 'a\u0000b' })).toThrow(CloudLinkError);
  });

  it('carries a target in a query string', () => {
    expect(parseLinkTarget('ap_invoice:0b1c')).toEqual({ objectType: 'ap_invoice', objectId: '0b1c' });
    expect(parseLinkTarget('project:PRJ-0001')).toEqual({ objectType: 'project', objectId: 'PRJ-0001' });
    expect(parseLinkTarget('nocolon')).toBeNull();
    expect(parseLinkTarget(':x')).toBeNull();
    expect(parseLinkTarget('Bad Type:1')).toBeNull();
    expect(parseLinkTarget('')).toBeNull();
    expect(parseLinkTarget(null)).toBeNull();
  });
});

describe('answers that are not files', () => {
  it('reads the OCS envelope', () => {
    expect(parseOcs({ ocs: { meta: { status: 'ok', statuscode: 200, message: 'OK' }, data: { id: 'alice' } } })).toMatchObject({ ok: true, status: 200, data: { id: 'alice' } });
    expect(parseOcs({ ocs: { meta: { statuscode: 100, message: 'OK' }, data: [] } }).ok).toBe(true);
    expect(parseOcs({ ocs: { meta: { statuscode: 403, message: 'Path is already shared with this group' }, data: [] } })).toMatchObject({ ok: false, status: 403, message: 'Path is already shared with this group' });
    expect(() => parseOcs({})).toThrow(CloudProtocolError);
    expect(() => parseOcs(null)).toThrow(CloudProtocolError);
  });

  const base = 'https://files.example.com';
  it('reads the two answers of Login Flow v2', () => {
    const start = parseLoginFlowStart({ poll: { token: 't0k', endpoint: `${base}/index.php/login/v2/poll` }, login: `${base}/index.php/login/v2/flow/t0k` }, base);
    expect(start).toEqual({ pollToken: 't0k', pollEndpoint: `${base}/index.php/login/v2/poll`, loginUrl: `${base}/index.php/login/v2/flow/t0k` });
    expect(parseLoginFlowResult({ server: base, loginName: 'ali', appPassword: 'abcd-efgh' })).toEqual({ server: base, loginName: 'ali', appPassword: 'abcd-efgh' });
  });

  it('refuses a flow that points at another server or answers with nothing usable', () => {
    expect(() => parseLoginFlowStart({ poll: { token: 't', endpoint: 'https://evil.example/poll' }, login: `${base}/x` }, base)).toThrow(CloudProtocolError);
    expect(() => parseLoginFlowStart({ poll: { token: 't', endpoint: `${base}/poll` }, login: 'https://evil.example/x' }, base)).toThrow(CloudProtocolError);
    expect(() => parseLoginFlowStart({ poll: {}, login: '' }, base)).toThrow(CloudProtocolError);
    expect(() => parseLoginFlowStart(null, base)).toThrow(CloudProtocolError);
    expect(() => parseLoginFlowResult({ loginName: 'ali' })).toThrow(CloudProtocolError);
    expect(() => parseLoginFlowResult({ loginName: '', appPassword: 'x' })).toThrow(CloudProtocolError);
  });

  it('a started flow is pending for twenty minutes, then over', () => {
    const now = new Date('2026-10-04T10:00:00Z');
    const expiresAt = attemptExpiry(now);
    expect(expiresAt.toISOString()).toBe('2026-10-04T10:20:00.000Z');
    expect(attemptState({ expiresAt }, new Date('2026-10-04T10:19:59Z'))).toBe('pending');
    expect(attemptState({ expiresAt }, new Date('2026-10-04T10:20:00Z'))).toBe('expired');
  });
});

describe('the state a screen is in', () => {
  const account = { serverUrl: 'https://files.example.com', lastError: null };
  it('says why there is nothing to list, in a fixed order', () => {
    expect(connectionState({ enabled: false, baseUrl: 'https://files.example.com', account })).toBe('not_configured');
    expect(connectionState({ enabled: true, baseUrl: null, account })).toBe('not_configured');
    expect(connectionState({ enabled: true, baseUrl: 'https://files.example.com', account: null })).toBe('not_linked');
    expect(connectionState({ enabled: true, baseUrl: 'https://files.example.com', account: { ...account, lastError: 'unauthorised' } })).toBe('relink');
    expect(connectionState({ enabled: true, baseUrl: 'https://other.example.com', account })).toBe('relink');
    expect(connectionState({ enabled: true, baseUrl: 'https://files.example.com', account })).toBe('ready');
  });
});

describe('the app password is kept sealed', () => {
  const env = { ERP_SECRET_KEY: 'k'.repeat(40) } as NodeJS.ProcessEnv;

  it('opens for its owner and for nobody else', () => {
    const sealed = sealSecret('abcde-fghij-klmno', 'cloud-files:user-1', env);
    expect(sealed).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(sealed).not.toContain('abcde');
    expect(openSecret(sealed, 'cloud-files:user-1', env)).toBe('abcde-fghij-klmno');
    expect(() => openSecret(sealed, 'cloud-files:user-2', env)).toThrow(SecretKeyError);
    expect(() => openSecret(sealed, 'cloud-files:user-1', { ERP_SECRET_KEY: 'z'.repeat(40) } as NodeJS.ProcessEnv)).toThrow(SecretKeyError);
  });

  it('seals the same text differently each time and refuses a changed byte', () => {
    const a = sealSecret('same', 'x', env);
    const b = sealSecret('same', 'x', env);
    expect(a).not.toBe(b);
    const parts = a.split('.');
    const ciphertext = Buffer.from(parts[3]!, 'base64url');
    ciphertext[0] = ciphertext[0]! ^ 1;
    expect(() => openSecret([parts[0], parts[1], parts[2], ciphertext.toString('base64url')].join('.'), 'x', env)).toThrow(SecretKeyError);
    expect(() => openSecret('garbage', 'x', env)).toThrow(SecretKeyError);
  });

  it('refuses to seal without a key of a proper length', () => {
    expect(secretKeyProblem({} as NodeJS.ProcessEnv)).toMatch(/not set/);
    expect(secretKeyProblem({ ERP_SECRET_KEY: 'short' } as NodeJS.ProcessEnv)).toMatch(/at least 32/);
    expect(secretKeyProblem(env)).toBeNull();
    expect(() => sealSecret('x', 'y', {} as NodeJS.ProcessEnv)).toThrow(SecretKeyError);
    expect(() => sealSecret('x', 'y', { ERP_SECRET_KEY: 'short' } as NodeJS.ProcessEnv)).toThrow(SecretKeyError);
  });
});
