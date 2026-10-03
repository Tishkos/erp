/**
 * What the attachment service needs before it will accept a single file.
 *
 * `services/attachments` deliberately refuses to work unconfigured: no
 * storage, no scanner, and no answer to "may this person see the parent?"
 * means no upload. That is §21 and §25 doing their job, and it is why this
 * file exists — it is the one place where those three questions are answered
 * for this deployment.
 */
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { applicant, bankLoan, billOfLading, customsPd, employeeDocument, employeeRequest, journalEntry, payable, paymentApplication, shipmentContainer } from './db/schema';
import type { Tx } from './db/client';
import type { Principal } from './domain/permissions';
import { can } from './domain/permissions';
import * as attachments from './services/attachments';

/**
 * Where the bytes live.
 *
 * A directory outside the deployment, so a release that replaces the
 * application does not take the evidence with it. S3 or R2 is the eventual
 * answer (TECHSTACK A7) and slots in at exactly this seam — the service knows
 * nothing but `put` and `get`.
 */
const storageRoot = (): string =>
  resolve(process.env.ATTACHMENT_DIR ?? join(process.cwd(), 'var', 'attachments'));

/** Refuses a key that would climb out of the store, whatever produced it. */
function pathFor(key: string): string {
  const root = storageRoot();
  const full = resolve(root, key);
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error('That storage key points outside the attachment store.');
  }
  return full;
}

const fileStorage: attachments.StorageAdapter = {
  async put(key, content) {
    const full = pathFor(key);
    await mkdir(dirname(full), { recursive: true });
    // 'wx' — never overwrite. §21 says a later version does not replace an
    // earlier one, and a store with no overwrite cannot be talked into it.
    await writeFile(full, content, { flag: 'wx' });
  },
  async get(key) {
    try {
      return await readFile(pathFor(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  },
};

/**
 * The malware scan §21 puts in the upload pipeline.
 *
 * This is a signature check, not an antivirus engine, and it is worth being
 * plain about the difference. By the time it runs, `domain/attachments` has
 * already inspected the content and refused the formats that execute — on
 * their bytes, not their extension — so what is left for this to catch is the
 * EICAR test file every deployment should be able to demonstrate, and files
 * whose bytes claim to be something the inspection missed.
 *
 * It is what the company can run today. ClamAV replaces it with one
 * `registerScanner` call when there is a daemon to talk to, and nothing else
 * in the system changes.
 */
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

const signatureScanner: attachments.MalwareScanner = (content, fileName) => {
  const head = content.subarray(0, 4096).toString('latin1');
  if (head.includes(EICAR)) {
    return { status: 'infected', detail: 'EICAR test signature' };
  }
  // A script that arrives claiming to be a document. The extension checks
  // catch the honest ones; this catches the shebang inside anything else.
  if (/^#!\s*\/(usr\/)?bin\//.test(head) && !fileName.toLowerCase().endsWith('.txt')) {
    return { status: 'infected', detail: 'the file begins with a script interpreter line' };
  }
  return { status: 'clean' };
};

/**
 * §21 — an attachment inherits its parent's access policy.
 *
 * For a journal entry that is two questions: may this person see journals at
 * all, and does row-level security let them see this one? The second is not a
 * judgement made here — the query runs in their scope, so a branch they
 * cannot see returns nothing and the answer is no.
 */
const journalParentAccess = async (tx: Tx, principal: Principal, objectId: string) => {
  if (!can(principal, 'view', 'journal_entry')) return false;
  const [row] = await tx
    .select({ id: journalEntry.id })
    .from(journalEntry)
    .where(eq(journalEntry.id, objectId))
    .limit(1);
  return Boolean(row);
};

/**
 * REQ-AP-001 — the payable's attachments (the supplier's PI, the contract)
 * and the payment application's (the SWIFT copy, the signed voucher). The
 * same two questions; row-level security answers the branch.
 */
const payableParentAccess = async (tx: Tx, principal: Principal, objectId: string) => {
  if (!can(principal, 'view', 'payable')) return false;
  const [row] = await tx.select({ id: payable.id }).from(payable).where(eq(payable.id, objectId)).limit(1);
  return Boolean(row);
};

const paymentApplicationParentAccess = async (tx: Tx, principal: Principal, objectId: string) => {
  if (!can(principal, 'view', 'payment_application')) return false;
  const [row] = await tx
    .select({ id: paymentApplication.id })
    .from(paymentApplication)
    .where(eq(paymentApplication.id, objectId))
    .limit(1);
  return Boolean(row);
};

const customsPdParentAccess = async (tx: Tx, principal: Principal, objectId: string) => {
  if (!can(principal, 'view', 'customs_pd')) return false;
  const [row] = await tx.select({ id: customsPd.id }).from(customsPd).where(eq(customsPd.id, objectId)).limit(1);
  return Boolean(row);
};

const containerParentAccess = async (tx: Tx, principal: Principal, objectId: string) => {
  if (!can(principal, 'view', 'shipment_container')) return false;
  const [row] = await tx
    .select({ id: shipmentContainer.id })
    .from(shipmentContainer)
    .where(eq(shipmentContainer.id, objectId))
    .limit(1);
  return Boolean(row);
};

const blParentAccess = async (tx: Tx, principal: Principal, objectId: string) => {
  if (!can(principal, 'view', 'bill_of_lading')) return false;
  const [row] = await tx.select({ id: billOfLading.id }).from(billOfLading).where(eq(billOfLading.id, objectId)).limit(1);
  return Boolean(row);
};

const loanParentAccess = async (tx: Tx, principal: Principal, objectId: string) => {
  if (!can(principal, 'view', 'bank_loan')) return false;
  const [row] = await tx.select({ id: bankLoan.id }).from(bankLoan).where(eq(bankLoan.id, objectId)).limit(1);
  return Boolean(row);
};

/**
 * REQ-HR-001 HR-5 — an applicant's CV and letters: recruitment's own grant,
 * and the applicant's row policy (which asks for it too) answers the branch.
 */
const applicantParentAccess = async (tx: Tx, principal: Principal, objectId: string) => {
  if (!can(principal, 'view', 'recruitment')) return false;
  const [row] = await tx.select({ id: applicant.id }).from(applicant).where(eq(applicant.id, objectId)).limit(1);
  return Boolean(row);
};

/**
 * REQ-HR-001 HR-6 — a request's receipts and papers: HR by its grant, or the
 * person and their manager (the link), as the request itself is read.
 */
const employeeRequestParentAccess = async (tx: Tx, principal: Principal, objectId: string) => {
  const [row] = await tx.select({ employeeId: employeeRequest.employeeId }).from(employeeRequest).where(eq(employeeRequest.id, objectId)).limit(1);
  if (!row) return false;
  if (can(principal, 'view', 'employee_request')) return true;
  const reach = await tx.execute(sql`select app_employee_reach(${row.employeeId}) as ok`);
  return Boolean((reach.rows[0] as { ok: boolean } | undefined)?.ok);
};

/** HR-6 — a person's document's scan: HR by its grant, or the person (the row policy decides which rows exist). */
const employeeDocumentParentAccess = async (tx: Tx, principal: Principal, objectId: string) => {
  const [row] = await tx.select({ employeeId: employeeDocument.employeeId }).from(employeeDocument).where(eq(employeeDocument.id, objectId)).limit(1);
  return Boolean(row);
};

let registered = false;

/** Idempotent: every entry point may call it, and the first one wins. */
export function registerAttachmentRuntime(): void {
  if (registered) return;
  registered = true;
  attachments.registerStorage(fileStorage);
  attachments.registerScanner(signatureScanner);
  attachments.registerParentAccessCheck('journal_entry', journalParentAccess);
  attachments.registerParentAccessCheck('payable', payableParentAccess);
  attachments.registerParentAccessCheck('payment_application', paymentApplicationParentAccess);
  attachments.registerParentAccessCheck('customs_pd', customsPdParentAccess);
  attachments.registerParentAccessCheck('shipment_container', containerParentAccess);
  attachments.registerParentAccessCheck('bill_of_lading', blParentAccess);
  attachments.registerParentAccessCheck('bank_loan', loanParentAccess);
  attachments.registerParentAccessCheck('applicant', applicantParentAccess);
  attachments.registerParentAccessCheck('employee_request', employeeRequestParentAccess);
  attachments.registerParentAccessCheck('employee_document', employeeDocumentParentAccess);
}

/** Streams a stored file, for a route handler that has already checked access. */
export function readStreamFor(storageKey: string): ReturnType<typeof createReadStream> {
  return createReadStream(pathFor(storageKey));
}
