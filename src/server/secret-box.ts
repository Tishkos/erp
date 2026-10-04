/**
 * A box for the few secrets the ERP must keep in order to use them later —
 * today, one person's Cloud Files app password (REQ-FIX-001 D-FX-3: "kept
 * encrypted with the server's key, never shown again").
 *
 * AES-256-GCM, the key derived with HKDF-SHA256 from `ERP_SECRET_KEY`. The
 * purpose and the owner (`cloud-files:<user id>`) are bound in as additional
 * authenticated data, so a sealed value copied to another row, another person
 * or another purpose does not open. A value is `v1.<iv>.<tag>.<ciphertext>`,
 * base64url; the version is there for the day the key rotates.
 *
 * The key is never written to the database, a log or an audit row, and a
 * missing or short key refuses to seal — a credential kept under no key, or a
 * guessable one, is not kept encrypted.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

export class SecretKeyError extends Error {
  readonly code = 'SECRET_KEY';
  constructor(detail: string) {
    super(detail);
    this.name = 'SecretKeyError';
  }
}

export const MIN_SECRET_KEY_LENGTH = 32;
const SALT = Buffer.from('qimah-erp/secret-box/v1', 'utf8');

/** Is the server able to seal a secret? (The settings screen says so plainly when it is not.) */
export function secretKeyProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  const key = env.ERP_SECRET_KEY;
  if (!key) return 'ERP_SECRET_KEY is not set on this server.';
  if (key.length < MIN_SECRET_KEY_LENGTH) return `ERP_SECRET_KEY must be at least ${MIN_SECRET_KEY_LENGTH} characters.`;
  return null;
}

function keyFor(env: NodeJS.ProcessEnv): Buffer {
  const problem = secretKeyProblem(env);
  if (problem) throw new SecretKeyError(problem);
  return Buffer.from(hkdfSync('sha256', Buffer.from(env.ERP_SECRET_KEY!, 'utf8'), SALT, Buffer.from('cloud-files', 'utf8'), 32));
}

const b64 = (buffer: Buffer): string => buffer.toString('base64url');

/** Seals `plain`, bound to `bind` (what it belongs to). */
export function sealSecret(plain: string, bind: string, env: NodeJS.ProcessEnv = process.env): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(env), iv);
  cipher.setAAD(Buffer.from(bind, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1.${b64(iv)}.${b64(cipher.getAuthTag())}.${b64(ciphertext)}`;
}

/** Opens a sealed value, or throws — a wrong key, a wrong owner and a changed byte all fail the same way. */
export function openSecret(sealed: string, bind: string, env: NodeJS.ProcessEnv = process.env): string {
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new SecretKeyError('The stored secret is not in a known format.');
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyFor(env), Buffer.from(parts[1]!, 'base64url'));
    decipher.setAAD(Buffer.from(bind, 'utf8'));
    decipher.setAuthTag(Buffer.from(parts[2]!, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3]!, 'base64url')), decipher.final()]).toString('utf8');
  } catch (error) {
    if (error instanceof SecretKeyError) throw error;
    throw new SecretKeyError('The stored secret cannot be opened with this server key.');
  }
}
