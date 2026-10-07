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
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  apInvoice,
  applicant,
  arInvoice,
  asycudaRun,
  automationRule,
  automationRun,
  bankLoan,
  bankStatement,
  bankTransfer,
  billOfLading,
  chatMessage,
  customerCreditMemo,
  customerNote,
  customerReceipt,
  customsDeclaration,
  customsPd,
  employeeAdvance,
  employeeDocument,
  employeeRequest,
  exception,
  fiscalPeriod,
  goodsReceipt,
  goodsReturn,
  journalEntry,
  otherReceipt,
  payable,
  paymentApplication,
  payrollRun,
  performanceReview,
  port,
  project,
  projectBudgetDocument,
  projectCertificate,
  projectMaterialIssue,
  projectVariation,
  purchaseOrder,
  recurringContract,
  recurringJournal,
  salesReturn,
  shipmentContainer,
  supplierAdvance,
  supplierCreditMemo,
  supplierPayment,
  task,
  taxCode,
  vacancy,
} from './db/schema';
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

/** IMPROVEMENT-002 — an ASYCUDA reading's files: whoever may see the declarations. */
const asycudaRunParentAccess = async (tx: Tx, principal: Principal, objectId: string) => {
  if (!can(principal, 'view', 'customs_pd')) return false;
  const [row] = await tx.select({ id: asycudaRun.id }).from(asycudaRun).where(eq(asycudaRun.id, objectId)).limit(1);
  return Boolean(row);
};

/** REQ-LOG-001 — a customs declaration's files (the lodgement, the assessment): whoever may see the declarations. */
const customsDeclarationParentAccess = async (tx: Tx, principal: Principal, objectId: string) => {
  if (!can(principal, 'view', 'customs_declaration')) return false;
  const [row] = await tx.select({ id: customsDeclaration.id }).from(customsDeclaration).where(eq(customsDeclaration.id, objectId)).limit(1);
  return Boolean(row);
};

/** REQ-LOG-001 — a port's papers (the tariff sheet, the agent's letter): whoever may see the ports. Addressed by code. */
const portParentAccess = async (tx: Tx, principal: Principal, objectId: string) => {
  if (!can(principal, 'view', 'port')) return false;
  const [row] = await tx.select({ code: port.code }).from(port).where(eq(port.code, objectId)).limit(1);
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

/**
 * A deposit's slip — by direction, 2026-10-04. A deposit is not its own table:
 * the cash one is a `bank_transfer` and the bank one is an `other_receipt`, so
 * the paperwork hangs on those. Both ask the grant the Manual Deposits screen
 * asks before it draws the record, which is the deposit register's own.
 */
const bankTransferParentAccess = async (tx: Tx, principal: Principal, objectId: string) => {
  // `bank_cash_account` is what `treasury.ts` and Manual Deposits authorise a
  // transfer on; no role holds a `bank_transfer` grant, so asking for one
  // refused everybody but the Super User (REQ-ACC-001, 2026-10-04).
  if (!can(principal, 'view', 'bank_cash_account')) return false;
  const [row] = await tx.select({ id: bankTransfer.id }).from(bankTransfer).where(eq(bankTransfer.id, objectId)).limit(1);
  return Boolean(row);
};

const otherReceiptParentAccess = async (tx: Tx, principal: Principal, objectId: string) => {
  if (!can(principal, 'view', 'other_receipt')) return false;
  const [row] = await tx.select({ id: otherReceipt.id }).from(otherReceipt).where(eq(otherReceipt.id, objectId)).limit(1);
  return Boolean(row);
};

/**
 * REQ-ACC-001 — the bank's statement file and the reconciliation's working
 * papers, on the statement: whoever may read reconciliations, and row
 * security answers the branch.
 */
const bankStatementParentAccess = async (tx: Tx, principal: Principal, objectId: string) => {
  if (!can(principal, 'view', 'bank_reconciliation') && !can(principal, 'view', 'bank_statement')) return false;
  const [row] = await tx.select({ id: bankStatement.id }).from(bankStatement).where(eq(bankStatement.id, objectId)).limit(1);
  return Boolean(row);
};

/** REQ-ACC-001 — a tax code's papers (the authority's letter, the rate notice): whoever reads tax codes. */
const taxCodeParentAccess = async (tx: Tx, principal: Principal, objectId: string) => {
  if (!can(principal, 'view', 'tax_code')) return false;
  const [row] = await tx.select({ code: taxCode.code }).from(taxCode).where(eq(taxCode.code, objectId)).limit(1);
  return Boolean(row);
};

/** REQ-ACC-001 — a period's closing papers (the sign-off, the reconciliations' file): whoever reads Accounting Periods. */
const fiscalPeriodParentAccess = async (tx: Tx, principal: Principal, objectId: string) => {
  if (!can(principal, 'view', 'fiscal_period')) return false;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(objectId)) return false;
  const [row] = await tx.select({ id: fiscalPeriod.id }).from(fiscalPeriod).where(eq(fiscalPeriod.id, objectId)).limit(1);
  return Boolean(row);
};

/** REQ-ACC-001 — a recurring journal's papers (the lease, the agreement): whoever reads journals; row security answers the branch. */
const recurringJournalParentAccess = async (tx: Tx, principal: Principal, objectId: string) => {
  if (!can(principal, 'view', 'journal_entry')) return false;
  const [row] = await tx.select({ id: recurringJournal.id }).from(recurringJournal).where(eq(recurringJournal.id, objectId)).limit(1);
  return Boolean(row);
};

/**
 * REQ-PAY-001 PAY3 — the purchase documents' paperwork (2026-10-04).
 *
 * The purchase invoice had an upload form and no check registered here, so
 * every file a person put on one was refused ("access … cannot be
 * determined"). Each purchase record now answers the same two questions as
 * the ones above: may this person view that kind of record, and does row
 * security let them see this one. A debit note is a purchase invoice
 * (D-PAY-2), so it is answered by `ap_invoice`.
 */
const PURCHASE_PARENTS = [
  ['ap_invoice', apInvoice],
  ['purchase_order', purchaseOrder],
  ['goods_receipt', goodsReceipt],
  ['goods_return', goodsReturn],
  ['supplier_payment', supplierPayment],
  ['supplier_advance', supplierAdvance],
  ['recurring_contract', recurringContract],
  ['supplier_credit_memo', supplierCreditMemo],
] as const;

const purchaseParentAccess =
  (object: string, table: (typeof PURCHASE_PARENTS)[number][1]) =>
  async (tx: Tx, principal: Principal, objectId: string) => {
    if (!can(principal, 'view', object)) return false;
    const [row] = await tx.select({ id: table.id }).from(table).where(eq(table.id, objectId)).limit(1);
    return Boolean(row);
  };

/**
 * REQ-PM-001 PM-5 — a progress certificate's papers (the signed measurement,
 * the client's acceptance): whoever reads the project, and row security
 * answers the branch. Kept by number, as the certificate's history is.
 */
const projectCertificateParentAccess = async (tx: Tx, principal: Principal, objectId: string) => {
  if (!can(principal, 'view', 'project')) return false;
  const [row] = await tx
    .select({ id: projectCertificate.id })
    .from(projectCertificate)
    .where(eq(projectCertificate.certificateNo, objectId))
    .limit(1);
  return Boolean(row);
};

/**
 * The Project System's other documents (shared, 2026-10-04): the budget
 * document, the change order and the material issue, each kept by its number
 * as its history is, each read by whoever reads the project (row security
 * answers the branch); and the project itself, by its code.
 */
const projectParentAccess = async (tx: Tx, principal: Principal, objectId: string) => {
  if (!can(principal, 'view', 'project')) return false;
  const [row] = await tx.select({ code: project.code }).from(project).where(eq(project.code, objectId)).limit(1);
  return Boolean(row);
};

const projectBudgetParentAccess = async (tx: Tx, principal: Principal, objectId: string) => {
  if (!can(principal, 'view', 'project')) return false;
  const [row] = await tx
    .select({ id: projectBudgetDocument.id })
    .from(projectBudgetDocument)
    .where(eq(projectBudgetDocument.documentNo, objectId))
    .limit(1);
  return Boolean(row);
};

const projectVariationParentAccess = async (tx: Tx, principal: Principal, objectId: string) => {
  if (!can(principal, 'view', 'project')) return false;
  const [row] = await tx.select({ id: projectVariation.id }).from(projectVariation).where(eq(projectVariation.variationNo, objectId)).limit(1);
  return Boolean(row);
};

const projectMaterialIssueParentAccess = async (tx: Tx, principal: Principal, objectId: string) => {
  if (!can(principal, 'view', 'project')) return false;
  const [row] = await tx
    .select({ id: projectMaterialIssue.id })
    .from(projectMaterialIssue)
    .where(eq(projectMaterialIssue.documentNo, objectId))
    .limit(1);
  return Boolean(row);
};

/**
 * HR's remaining records (shared, 2026-10-04), each kept by its uuid as the
 * HR pages already file against. An advance's papers (the signed agreement,
 * the receipt): HR and Finance by the grant, or the person and their manager
 * through the link, as the advance itself is read. A review's: whoever the
 * review's own row policy lets read it, with the grant or as its person or
 * reviewer. A vacancy's (the approved requisition): recruitment's grant. A
 * payroll run's (the signed sheet): the run's grant.
 */
const employeeAdvanceParentAccess = async (tx: Tx, principal: Principal, objectId: string) => {
  const [row] = await tx.select({ employeeId: employeeAdvance.employeeId }).from(employeeAdvance).where(eq(employeeAdvance.id, objectId)).limit(1);
  if (!row) return false;
  if (can(principal, 'view', 'employee_advance')) return true;
  const reach = await tx.execute(sql`select app_employee_reach(${row.employeeId}) as ok`);
  return Boolean((reach.rows[0] as { ok: boolean } | undefined)?.ok);
};

const performanceReviewParentAccess = async (tx: Tx, principal: Principal, objectId: string) => {
  const [row] = await tx.select({ id: performanceReview.id }).from(performanceReview).where(eq(performanceReview.id, objectId)).limit(1);
  return Boolean(row);
};

const vacancyParentAccess = async (tx: Tx, principal: Principal, objectId: string) => {
  if (!can(principal, 'view', 'recruitment')) return false;
  const [row] = await tx.select({ id: vacancy.id }).from(vacancy).where(eq(vacancy.id, objectId)).limit(1);
  return Boolean(row);
};

const payrollRunParentAccess = async (tx: Tx, principal: Principal, objectId: string) => {
  if (!can(principal, 'view', 'payroll_run')) return false;
  const [row] = await tx.select({ id: payrollRun.id }).from(payrollRun).where(eq(payrollRun.id, objectId)).limit(1);
  return Boolean(row);
};

/*
 * Receivables (2026-10-04) — the sales invoice, the receipt, the credit or
 * debit note, the credit memo and the sales return carry their files behind
 * the paperclip, like every record. The
 * invoice and the receipt are read under their own objects; a note under the
 * credit memo's, which governs it. Row security decides the branch.
 */
const arInvoiceParentAccess = async (tx: Tx, principal: Principal, objectId: string) => {
  if (!can(principal, 'view', 'ar_invoice')) return false;
  const [row] = await tx.select({ id: arInvoice.id }).from(arInvoice).where(eq(arInvoice.id, objectId)).limit(1);
  return Boolean(row);
};

const customerReceiptParentAccess = async (tx: Tx, principal: Principal, objectId: string) => {
  if (!can(principal, 'view', 'customer_receipt')) return false;
  const [row] = await tx
    .select({ id: customerReceipt.id })
    .from(customerReceipt)
    .where(eq(customerReceipt.id, objectId))
    .limit(1);
  return Boolean(row);
};

const customerNoteParentAccess = async (tx: Tx, principal: Principal, objectId: string) => {
  if (!can(principal, 'view', 'customer_credit_memo')) return false;
  const [row] = await tx.select({ id: customerNote.id }).from(customerNote).where(eq(customerNote.id, objectId)).limit(1);
  return Boolean(row);
};

const customerCreditMemoParentAccess = async (tx: Tx, principal: Principal, objectId: string) => {
  if (!can(principal, 'view', 'customer_credit_memo')) return false;
  const [row] = await tx
    .select({ id: customerCreditMemo.id })
    .from(customerCreditMemo)
    .where(eq(customerCreditMemo.id, objectId))
    .limit(1);
  return Boolean(row);
};

const salesReturnParentAccess = async (tx: Tx, principal: Principal, objectId: string) => {
  if (!can(principal, 'view', 'sales_return')) return false;
  const [row] = await tx.select({ id: salesReturn.id }).from(salesReturn).where(eq(salesReturn.id, objectId)).limit(1);
  return Boolean(row);
};

/**
 * Inventory's records (IMPROVEMENT-002), each kept by its uuid: a count, an
 * opening stock document, a transfer (either table), an item reconciliation.
 * Whoever reads the record under its own grant and row security reads its
 * papers — the count sheet, the signed transfer note.
 */
const inventoryRecordParentAccess =
  (object: string, tables: readonly string[]) => async (tx: Tx, principal: Principal, objectId: string) => {
    if (!can(principal, 'view', object)) return false;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(objectId)) return false;
    for (const table of tables) {
      const result = await tx.execute(sql`select 1 from ${sql.identifier(table)} where id = ${objectId}::uuid limit 1`);
      if (result.rows.length > 0) return true;
    }
    return false;
  };

/**
 * Internal chat — a file sent in a conversation hangs on its message. Read and
 * written by the conversation's members and nobody else: the message row's own
 * policy is membership (and not before the person was let in), so the select
 * below finds it for a member and returns nothing for anyone else. A withdrawn
 * message hands out no files.
 */
const chatMessageParentAccess = async (tx: Tx, principal: Principal, objectId: string) => {
  if (!can(principal, 'view', 'chat')) return false;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(objectId)) return false;
  const [row] = await tx
    .select({ id: chatMessage.id })
    .from(chatMessage)
    .where(and(eq(chatMessage.id, objectId), isNull(chatMessage.retractedAt)))
    .limit(1);
  return Boolean(row);
};

/**
 * The Task Center (platform phase, Agent 3) — a task's files and notes are
 * for the people the task is for: the grant to view tasks, and the task's own
 * row policy (its creator, assigner, assignee and watchers; a section's
 * manager, whoever the assignee reports to, an administrator in the branch)
 * answers which tasks exist for the reader. A draft is its creator's alone.
 */
const taskParentAccess = async (tx: Tx, principal: Principal, objectId: string) => {
  if (!can(principal, 'view', 'task')) return false;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(objectId)) return false;
  const [row] = await tx.select({ id: task.id }).from(task).where(eq(task.id, objectId)).limit(1);
  return Boolean(row);
};

/**
 * The Exception Center (platform phase, Agent 7) — an exception's files and notes
 * are for whoever may open it: the grant to view exceptions, the row policy
 * (the grant on the object it is about, and the branch), and the one question
 * SQL cannot answer, whether this person may open the affected record itself
 * (a task is its parties' alone). The service is loaded when asked: it
 * imports the record registry, which imports this file.
 */
const exceptionParentAccess = async (tx: Tx, principal: Principal, objectId: string) => {
  if (!can(principal, 'view', 'exception')) return false;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(objectId)) return false;
  const [row] = await tx.select().from(exception).where(eq(exception.id, objectId)).limit(1);
  if (!row) return false;
  const { recordVisible } = await import('./services/exceptions');
  return recordVisible(tx, principal, row);
};

/**
 * Automation (platform phase, Agent 10) — a rule's files and notes are for whoever
 * may open the rule: the grant to view automation, and the rule's own row policy.
 * A run is addressed by its number (the log's id); both are administrators' reading.
 */
const automationParentAccess = async (tx: Tx, principal: Principal, objectId: string) => {
  if (!can(principal, 'view', 'automation')) return false;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(objectId)) return false;
  const [row] = await tx.select({ id: automationRule.id }).from(automationRule).where(eq(automationRule.id, objectId)).limit(1);
  return Boolean(row);
};

const automationRunParentAccess = async (tx: Tx, principal: Principal, objectId: string) => {
  if (!can(principal, 'view', 'automation')) return false;
  if (!/^\d{1,15}$/.test(objectId)) return false;
  const [row] = await tx.select({ id: automationRun.id }).from(automationRun).where(eq(automationRun.id, BigInt(objectId))).limit(1);
  return Boolean(row);
};

/** The import application's sections that file their own papers, each keyed by the import's id. */
export const PAYABLE_SECTIONS = ['payable_payments', 'payable_customs', 'payable_shipment', 'payable_landed_cost'] as const;
export type PayableSection = (typeof PAYABLE_SECTIONS)[number];

let registered = false;

/** Idempotent: every entry point may call it, and the first one wins. */
export function registerAttachmentRuntime(): void {
  if (registered) return;
  registered = true;
  attachments.registerStorage(fileStorage);
  attachments.registerScanner(signatureScanner);
  attachments.registerParentAccessCheck('journal_entry', journalParentAccess);
  attachments.registerParentAccessCheck('payable', payableParentAccess);
  // The import application's sections keep their own papers (2026-10-06, by
  // direction: "for each section they should have their own attachments —
  // Payments, PD / ASYCUDA, Shipment & containers, Landed cost"). Each is the
  // import's own id under a name of its own, so the four doors list four
  // different sets; who may open them is who may open the import.
  for (const section of PAYABLE_SECTIONS) attachments.registerParentAccessCheck(section, payableParentAccess);
  attachments.registerParentAccessCheck('payment_application', paymentApplicationParentAccess);
  attachments.registerParentAccessCheck('customs_pd', customsPdParentAccess);
  attachments.registerParentAccessCheck('shipment_container', containerParentAccess);
  attachments.registerParentAccessCheck('bill_of_lading', blParentAccess);
  attachments.registerParentAccessCheck('asycuda_run', asycudaRunParentAccess);
  attachments.registerParentAccessCheck('customs_declaration', customsDeclarationParentAccess);
  attachments.registerParentAccessCheck('port', portParentAccess);
  attachments.registerParentAccessCheck('bank_loan', loanParentAccess);
  attachments.registerParentAccessCheck('bank_transfer', bankTransferParentAccess);
  attachments.registerParentAccessCheck('other_receipt', otherReceiptParentAccess);
  attachments.registerParentAccessCheck('bank_statement', bankStatementParentAccess);
  attachments.registerParentAccessCheck('tax_code', taxCodeParentAccess);
  attachments.registerParentAccessCheck('recurring_journal', recurringJournalParentAccess);
  attachments.registerParentAccessCheck('fiscal_period', fiscalPeriodParentAccess);
  attachments.registerParentAccessCheck('ar_invoice', arInvoiceParentAccess);
  attachments.registerParentAccessCheck('customer_receipt', customerReceiptParentAccess);
  attachments.registerParentAccessCheck('customer_note', customerNoteParentAccess);
  attachments.registerParentAccessCheck('customer_credit_memo', customerCreditMemoParentAccess);
  attachments.registerParentAccessCheck('sales_return', salesReturnParentAccess);
  attachments.registerParentAccessCheck('applicant', applicantParentAccess);
  attachments.registerParentAccessCheck('employee_request', employeeRequestParentAccess);
  attachments.registerParentAccessCheck('employee_document', employeeDocumentParentAccess);
  attachments.registerParentAccessCheck('project_certificate', projectCertificateParentAccess);
  attachments.registerParentAccessCheck('project', projectParentAccess);
  attachments.registerParentAccessCheck('project_budget', projectBudgetParentAccess);
  attachments.registerParentAccessCheck('project_variation', projectVariationParentAccess);
  attachments.registerParentAccessCheck('project_material_issue', projectMaterialIssueParentAccess);
  attachments.registerParentAccessCheck('employee_advance', employeeAdvanceParentAccess);
  attachments.registerParentAccessCheck('performance_review', performanceReviewParentAccess);
  attachments.registerParentAccessCheck('vacancy', vacancyParentAccess);
  attachments.registerParentAccessCheck('payroll_run', payrollRunParentAccess);
  attachments.registerParentAccessCheck('chat_message', chatMessageParentAccess);
  attachments.registerParentAccessCheck('task', taskParentAccess);
  attachments.registerParentAccessCheck('exception', exceptionParentAccess);
  attachments.registerParentAccessCheck('automation', automationParentAccess);
  attachments.registerParentAccessCheck('automation_run', automationRunParentAccess);
  for (const [object, table] of PURCHASE_PARENTS) {
    attachments.registerParentAccessCheck(object, purchaseParentAccess(object, table));
  }
  attachments.registerParentAccessCheck('stock_count', inventoryRecordParentAccess('stock_count', ['stock_count']));
  attachments.registerParentAccessCheck('opening_stock', inventoryRecordParentAccess('opening_stock', ['opening_stock']));
  attachments.registerParentAccessCheck('warehouse_transfer', inventoryRecordParentAccess('warehouse_transfer', ['stock_transfer', 'warehouse_transfer']));
  attachments.registerParentAccessCheck('stock_reconciliation', inventoryRecordParentAccess('stock_reconciliation', ['stock_adjustment']));
  // A Manual Stock Addition (0415) — its papers: the count sheet, the photo, the note that explains it.
  attachments.registerParentAccessCheck('manual_stock_addition', inventoryRecordParentAccess('manual_stock_addition', ['manual_stock_addition']));
}

/** Streams a stored file, for a route handler that has already checked access. */
export function readStreamFor(storageKey: string): ReturnType<typeof createReadStream> {
  return createReadStream(pathFor(storageKey));
}
