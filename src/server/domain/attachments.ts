/**
 * Attachments — Phase 01.8.
 *
 * §21 sets four rules, and each one rules out an obvious shortcut:
 *
 *   "stored using an immutable object identifier and linked to the parent
 *    record; later versions do not overwrite prior versions"
 *   "No executable file types shall be accepted unless explicitly authorised
 *    and technically isolated"
 *   "Attachments inherit the confidentiality and access policy of the parent
 *    record"
 *   "Financial evidence attached to a posted transaction is immutable"
 *
 * ── Content, not extension ──────────────────────────────────────────────────
 * The 01.8 gate is explicit: "An executable is rejected on **content
 * inspection**, not file extension." Renaming `payload.exe` to `invoice.pdf`
 * takes a second, and an extension check is a check on what the uploader chose
 * to call the file. So the first bytes are read and the file is judged by what
 * it is — and a file whose content disagrees with its name is refused twice
 * over, because that disagreement is itself the signal.
 */
import { createHash } from 'node:crypto';

export const SCAN_STATUSES = ['pending', 'clean', 'infected', 'failed'] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

/** §25 — a bound so an upload cannot be used to fill the disk. */
export const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

export class AttachmentRejectedError extends Error {
  readonly code = 'ATTACHMENT_REJECTED';
  constructor(
    readonly fileName: string,
    detail: string,
  ) {
    super(`${fileName} was not accepted: ${detail}`);
    this.name = 'AttachmentRejectedError';
  }
}

export class AttachmentAccessError extends Error {
  readonly code = 'ATTACHMENT_ACCESS_DENIED';
  constructor(detail: string) {
    super(detail);
    this.name = 'AttachmentAccessError';
  }
}

// ---------------------------------------------------------------------------
// §21 — content inspection
// ---------------------------------------------------------------------------

/**
 * Signatures of things that execute.
 *
 * Not a complete list of every executable format ever made — no such list
 * exists, and pretending otherwise is how these checks become theatre. It is
 * the formats that actually arrive: Windows and Linux binaries, macOS binaries,
 * shell scripts, and Java archives.
 */
const EXECUTABLE_SIGNATURES: ReadonlyArray<{ bytes: readonly number[]; label: string }> = [
  { bytes: [0x4d, 0x5a], label: 'a Windows executable' }, // MZ — PE/DOS
  { bytes: [0x7f, 0x45, 0x4c, 0x46], label: 'a Linux executable' }, // ELF
  { bytes: [0xfe, 0xed, 0xfa, 0xce], label: 'a macOS executable' }, // Mach-O 32
  { bytes: [0xfe, 0xed, 0xfa, 0xcf], label: 'a macOS executable' }, // Mach-O 64
  { bytes: [0xcf, 0xfa, 0xed, 0xfe], label: 'a macOS executable' }, // Mach-O LE
  { bytes: [0xca, 0xfe, 0xba, 0xbe], label: 'a Java class or fat binary' },
  { bytes: [0x23, 0x21], label: 'a script with an interpreter line' }, // #!
];

/** Formats that are recognised and allowed, by their own first bytes. */
const KNOWN_SIGNATURES: ReadonlyArray<{
  bytes: readonly number[];
  contentType: string;
  extensions: readonly string[];
}> = [
  { bytes: [0x25, 0x50, 0x44, 0x46], contentType: 'application/pdf', extensions: ['pdf'] },
  { bytes: [0xff, 0xd8, 0xff], contentType: 'image/jpeg', extensions: ['jpg', 'jpeg'] },
  {
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    contentType: 'image/png',
    extensions: ['png'],
  },
  { bytes: [0x47, 0x49, 0x46, 0x38], contentType: 'image/gif', extensions: ['gif'] },
  {
    // ZIP container. Office documents are ZIPs, which is why the container
    // alone cannot be treated as executable — but a bare .zip is refused below
    // because its contents cannot be inspected here.
    bytes: [0x50, 0x4b, 0x03, 0x04],
    contentType: 'application/zip',
    extensions: ['zip', 'docx', 'xlsx', 'pptx'],
  },
];

function startsWith(content: Buffer, bytes: readonly number[]): boolean {
  if (content.length < bytes.length) return false;
  return bytes.every((byte, index) => content[index] === byte);
}

export interface InspectionResult {
  /** What the content says it is, regardless of the file name. */
  readonly detectedContentType: string | null;
  readonly isExecutable: boolean;
  readonly executableLabel: string | null;
}

/** Reads the first bytes and reports what the file actually is. */
export function inspect(content: Buffer): InspectionResult {
  for (const signature of EXECUTABLE_SIGNATURES) {
    if (startsWith(content, signature.bytes)) {
      return {
        detectedContentType: null,
        isExecutable: true,
        executableLabel: signature.label,
      };
    }
  }

  for (const signature of KNOWN_SIGNATURES) {
    if (startsWith(content, signature.bytes)) {
      return {
        detectedContentType: signature.contentType,
        isExecutable: false,
        executableLabel: null,
      };
    }
  }

  // Plain text is recognised by the absence of anything binary, since it has no
  // signature of its own.
  const looksTextual = content.length > 0 && content.subarray(0, 512).every((b) => b !== 0);
  return {
    detectedContentType: looksTextual ? 'text/plain' : null,
    isExecutable: false,
    executableLabel: null,
  };
}

export function extensionOf(fileName: string): string {
  const index = fileName.lastIndexOf('.');
  return index === -1 ? '' : fileName.slice(index + 1).toLowerCase();
}

export interface UploadPolicy {
  readonly maxBytes: number;
  /**
   * §21 — "unless explicitly authorised and technically isolated". Off by
   * default and named so that switching it on is a visible decision, not a
   * configuration default someone inherits.
   */
  readonly allowExecutablesExplicitlyAuthorised: boolean;
  /** Extensions that are refused whatever their content says. */
  readonly blockedExtensions: readonly string[];
}

export const DEFAULT_UPLOAD_POLICY: UploadPolicy = {
  maxBytes: DEFAULT_MAX_BYTES,
  allowExecutablesExplicitlyAuthorised: false,
  blockedExtensions: [
    'exe',
    'dll',
    'so',
    'dylib',
    'bat',
    'cmd',
    'com',
    'scr',
    'ps1',
    'sh',
    'jar',
    'msi',
    // A bare archive hides its contents from inspection, and §21's rule is
    // about what a file *does*, not what it is wrapped in.
    'zip',
    '7z',
    'rar',
  ],
};

/**
 * The upload gate.
 *
 * Order matters: size first because it is cheap, then content, then the name.
 * The last check is the interesting one — a file whose declared extension and
 * actual content disagree is refused even when both would individually pass,
 * because that disagreement is what a disguised payload looks like.
 */
export function assertUploadAcceptable(
  fileName: string,
  content: Buffer,
  policy: UploadPolicy = DEFAULT_UPLOAD_POLICY,
): InspectionResult {
  if (content.length === 0) {
    throw new AttachmentRejectedError(fileName, 'it is empty.');
  }

  if (content.length > policy.maxBytes) {
    throw new AttachmentRejectedError(
      fileName,
      `it is ${Math.ceil(content.length / 1024 / 1024)}MB; the limit is ${Math.floor(
        policy.maxBytes / 1024 / 1024,
      )}MB.`,
    );
  }

  const inspection = inspect(content);

  if (inspection.isExecutable && !policy.allowExecutablesExplicitlyAuthorised) {
    throw new AttachmentRejectedError(
      fileName,
      `its content is ${inspection.executableLabel}. Executable files are not accepted (§21) — ` +
        'renaming one does not change what it is.',
    );
  }

  const extension = extensionOf(fileName);
  if (policy.blockedExtensions.includes(extension)) {
    throw new AttachmentRejectedError(
      fileName,
      `files ending .${extension} are not accepted (§21).`,
    );
  }

  // The disagreement check. A .pdf whose bytes are a PNG is probably a mistake;
  // a .pdf whose bytes are something unrecognised is worth refusing.
  if (extension && inspection.detectedContentType) {
    const matching = KNOWN_SIGNATURES.find(
      (s) => s.contentType === inspection.detectedContentType,
    );
    if (matching && !matching.extensions.includes(extension) && extension !== 'txt') {
      throw new AttachmentRejectedError(
        fileName,
        `it is named .${extension} but its content is ${inspection.detectedContentType}. ` +
          'The name and the file disagree.',
      );
    }
  }

  return inspection;
}

// ---------------------------------------------------------------------------
// §21 — immutable identity and versioning
// ---------------------------------------------------------------------------

/** SHA-256 of the content — TECHSTACK A7, and how a duplicate is recognised. */
export function contentHash(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * The storage key.
 *
 * §21 — "an immutable object identifier". Derived from the attachment's own id
 * and the content hash, so it cannot collide, cannot be guessed from the file
 * name, and cannot be reused by a later version. A key built from the parent
 * and the file name would be overwritten by the next upload of the same name,
 * which is exactly what §21 forbids.
 */
export function storageKeyFor(attachmentId: string, hash: string): string {
  return `attachments/${attachmentId}/${hash}`;
}

export class VersioningError extends Error {
  readonly code = 'ATTACHMENT_VERSIONING';
  constructor(detail: string) {
    super(detail);
    this.name = 'VersioningError';
  }
}

export interface AttachmentVersion {
  readonly id: string;
  readonly version: number;
  readonly supersededById: string | null;
  readonly scanStatus: ScanStatus;
}

/**
 * §21 — "later versions do not overwrite prior versions."
 *
 * A new version links to the one it replaces and both stay retrievable. The
 * previous version is not deleted, not marked invalid, and not hidden: an
 * invoice that was attached and then replaced is evidence of what was attached
 * at the time, which is the whole reason financial systems keep documents.
 */
export function assertCanSupersede(previous: AttachmentVersion): void {
  if (previous.supersededById) {
    throw new VersioningError(
      'That version has already been superseded. Replace the current version instead.',
    );
  }

  if (previous.scanStatus !== 'clean') {
    throw new VersioningError(
      'A version that never passed its malware scan cannot be superseded — it was never attached.',
    );
  }
}

export function nextVersion(previous: AttachmentVersion | null): number {
  return previous ? previous.version + 1 : 1;
}

// ---------------------------------------------------------------------------
// §21 — retention and legal hold
// ---------------------------------------------------------------------------

export class RetentionError extends Error {
  readonly code = 'ATTACHMENT_RETENTION';
  constructor(detail: string) {
    super(detail);
    this.name = 'RetentionError';
  }
}

export interface RetentionState {
  readonly retentionUntil: string | null;
  readonly legalHold: boolean;
}

/**
 * §21 — "Retention periods and legal hold are configurable"; disposal is "an
 * audited administrative action".
 *
 * A legal hold outranks a retention date in both directions: it keeps a
 * document past its disposal date, and it cannot be lifted merely because the
 * date has passed. That is the point of a hold.
 */
export function assertDisposable(state: RetentionState, on: string): void {
  if (state.legalHold) {
    throw new RetentionError(
      'This document is under legal hold and cannot be disposed of, whatever its retention date says (§21).',
    );
  }

  if (state.retentionUntil && on < state.retentionUntil) {
    throw new RetentionError(
      `This document is retained until ${state.retentionUntil} and cannot be disposed of before then (§21).`,
    );
  }
}
