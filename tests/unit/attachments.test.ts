/**
 * Phase 01.8 test gate — content inspection, versioning and retention.
 *
 * Access inheritance and the audit trail need a database and are in
 * tests/integration/phase01-attachments.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  AttachmentRejectedError,
  DEFAULT_UPLOAD_POLICY,
  RetentionError,
  VersioningError,
  assertCanSupersede,
  assertDisposable,
  assertUploadAcceptable,
  contentHash,
  extensionOf,
  inspect,
  nextVersion,
  storageKeyFor,
} from '@domain/attachments';

/** Files, by their first bytes — which is how the system judges them. */
const files = {
  pdf: Buffer.concat([Buffer.from([0x25, 0x50, 0x44, 0x46]), Buffer.from('-1.7 body')]),
  png: Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('pixels'),
  ]),
  jpeg: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('photo')]),
  text: Buffer.from('a plain note about the invoice'),
  windowsExe: Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.from('this program cannot')]),
  linuxExe: Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from('elf')]),
  macExe: Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.from('macho')]),
  shellScript: Buffer.from('#!/bin/sh\nrm -rf /\n'),
  javaClass: Buffer.concat([Buffer.from([0xca, 0xfe, 0xba, 0xbe]), Buffer.from('class')]),
};

describe('§21 · content inspection, not extension', () => {
  it('recognises the formats it accepts', () => {
    expect(inspect(files.pdf).detectedContentType).toBe('application/pdf');
    expect(inspect(files.png).detectedContentType).toBe('image/png');
    expect(inspect(files.jpeg).detectedContentType).toBe('image/jpeg');
    expect(inspect(files.text).detectedContentType).toBe('text/plain');
  });

  it('recognises an executable whatever it is called', () => {
    for (const [name, content] of Object.entries({
      windowsExe: files.windowsExe,
      linuxExe: files.linuxExe,
      macExe: files.macExe,
      shellScript: files.shellScript,
      javaClass: files.javaClass,
    })) {
      expect(inspect(content).isExecutable, name).toBe(true);
    }
  });

  it('rejects an executable disguised as an invoice', () => {
    // The 01.8 gate, stated exactly. Renaming payload.exe takes a second; an
    // extension check is a check on what the uploader chose to call the file.
    expect(() => assertUploadAcceptable('invoice.pdf', files.windowsExe)).toThrow(
      AttachmentRejectedError,
    );
    expect(() => assertUploadAcceptable('invoice.pdf', files.windowsExe)).toThrow(
      /renaming one does not change what it is/,
    );
  });

  it('rejects a shell script named as a text file', () => {
    expect(() => assertUploadAcceptable('notes.txt', files.shellScript)).toThrow(
      /a script with an interpreter line/,
    );
  });

  it('accepts a genuine document', () => {
    const result = assertUploadAcceptable('invoice.pdf', files.pdf);
    expect(result.detectedContentType).toBe('application/pdf');
    expect(result.isExecutable).toBe(false);
  });

  it('rejects a file whose name and content disagree', () => {
    // Individually both would pass; the disagreement is what a disguise looks
    // like.
    expect(() => assertUploadAcceptable('invoice.pdf', files.png)).toThrow(
      /named .pdf but its content is image\/png/,
    );
  });

  it('rejects a blocked extension even when its content is harmless', () => {
    expect(() => assertUploadAcceptable('archive.zip', files.text)).toThrow(
      /files ending .zip are not accepted/,
    );
  });

  it('rejects an empty file and one over the size limit', () => {
    expect(() => assertUploadAcceptable('empty.pdf', Buffer.alloc(0))).toThrow(/it is empty/);

    const huge = Buffer.concat([files.pdf, Buffer.alloc(DEFAULT_UPLOAD_POLICY.maxBytes)]);
    expect(() => assertUploadAcceptable('huge.pdf', huge)).toThrow(/the limit is/);
  });

  it('accepts an executable only when it is explicitly authorised', () => {
    // §21 — "unless explicitly authorised and technically isolated". Off by
    // default and named so that switching it on is a visible decision.
    expect(DEFAULT_UPLOAD_POLICY.allowExecutablesExplicitlyAuthorised).toBe(false);

    expect(() =>
      assertUploadAcceptable('tool.bin', files.windowsExe, {
        ...DEFAULT_UPLOAD_POLICY,
        allowExecutablesExplicitlyAuthorised: true,
        blockedExtensions: [],
      }),
    ).not.toThrow();
  });

  it('reads an extension without being confused by a dotted name', () => {
    expect(extensionOf('report.2026.final.pdf')).toBe('pdf');
    expect(extensionOf('noextension')).toBe('');
  });
});

describe('§21 · immutable identity', () => {
  it('hashes the content, so a duplicate upload is recognisable', () => {
    expect(contentHash(files.pdf)).toBe(contentHash(files.pdf));
    expect(contentHash(files.pdf)).not.toBe(contentHash(files.png));
    expect(contentHash(files.pdf)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('builds a key from the attachment’s own id, never from the file name', () => {
    // A key built from the parent and the file name would be overwritten by the
    // next upload of the same name — exactly what §21 forbids.
    const key = storageKeyFor('11111111-1111-4111-8111-111111111111', contentHash(files.pdf));
    expect(key).toContain('11111111-1111-4111-8111-111111111111');
    expect(key).not.toContain('invoice');

    const second = storageKeyFor('22222222-2222-4222-8222-222222222222', contentHash(files.pdf));
    expect(second).not.toBe(key);
  });
});

describe('§21 · versions accumulate, they do not overwrite', () => {
  const version = (overrides: Partial<Parameters<typeof assertCanSupersede>[0]> = {}) => ({
    id: 'a-1',
    version: 1,
    supersededById: null,
    scanStatus: 'clean' as const,
    ...overrides,
  });

  it('numbers the next version', () => {
    expect(nextVersion(null)).toBe(1);
    expect(nextVersion(version({ version: 3 }))).toBe(4);
  });

  it('allows the current version to be superseded', () => {
    expect(() => assertCanSupersede(version())).not.toThrow();
  });

  it('refuses to supersede a version that was already replaced', () => {
    // The chain is linear; branching it would make "the current version"
    // ambiguous.
    expect(() => assertCanSupersede(version({ supersededById: 'a-2' }))).toThrow(VersioningError);
  });

  it('refuses to supersede something that never passed its scan', () => {
    expect(() => assertCanSupersede(version({ scanStatus: 'infected' }))).toThrow(
      /never attached/,
    );
  });
});

describe('§21 · retention and legal hold', () => {
  it('permits disposal after the retention date', () => {
    expect(() =>
      assertDisposable({ retentionUntil: '2026-01-01', legalHold: false }, '2026-08-17'),
    ).not.toThrow();
  });

  it('refuses disposal before it', () => {
    expect(() =>
      assertDisposable({ retentionUntil: '2030-01-01', legalHold: false }, '2026-08-17'),
    ).toThrow(RetentionError);
  });

  it('refuses disposal under legal hold, whatever the retention date says', () => {
    // A hold that a passing date could override would not be a hold.
    expect(() =>
      assertDisposable({ retentionUntil: '2000-01-01', legalHold: true }, '2026-08-17'),
    ).toThrow(/under legal hold/);
  });

  it('permits disposal when no retention was set', () => {
    expect(() => assertDisposable({ retentionUntil: null, legalHold: false }, '2026-08-17')).not.toThrow();
  });
});
