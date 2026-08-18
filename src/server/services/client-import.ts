/**
 * Client-funded import and Client Inventory — Phase 09.10, §12.4 and §11.3.
 *
 * §12.4's client-funded import model, in three stages:
 *
 * | Stage | Debit | Credit |
 * |---|---|---|
 * | Client deposit | Company Bank Account | Client Clearing | (09.2 — `money-transfer.ts`) |
 * | Payment for client goods | Client Inventory | Company Bank Account |
 * | Delivery and financial settlement | Client Account | Client Inventory |
 *
 * ── The three prohibitions, and where each is enforced ──────────────────────
 *
 *   "Client goods never enter company warehouses or company inventory
 *    quantities" (§12.4, §11.3)
 *        → no item, warehouse or quantity column exists on any table in this
 *          module, so there is nothing to write one into. This service never
 *          imports from `services/inventory`, and nothing here can reach the
 *          Phase 04 ledger.
 *
 *   "No Sales Invoice is issued for the goods" (§11.3, Appendix C)
 *        → the company never owned the goods, so there is no sale. Delivery
 *          charges the client's account directly. Phase 06 does not exist yet,
 *          so this is currently a structural argument rather than a tested one —
 *          see the note on the 09.10 gate in the phase document.
 *
 *   "Client Inventory ... until delivery to the client" (§11.3)
 *        → the file cannot settle or close while its Client Inventory balance is
 *          non-zero, refused by trigger.
 *
 * Client Inventory is also deliberately *not* mapped to an inventory control
 * account: the inventory subledger keys on warehouse, and this balance has no
 * warehouse to key on. The framework refuses to treat it as stock, which is the
 * same conclusion §11.3 reaches by a different route.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  businessPartner,
  clientGoodsDelivery,
  clientImportFile,
  clientImportPayment,
  logisticsJob,
  moneyTransfer,
  moneyTransferClientAccount,
} from '../db/schema';
import { parseDecimal, toDecimalString } from '../domain/money';
import type { ActorContext } from './chart-of-accounts';
import * as audit from './audit';
import * as authz from './authorization';
import * as posting from './posting';
import * as statuses from './statuses';
import { allocateDocumentNumber } from './numbering';

export const FILE_DOCUMENT_TYPE = 'client_import_file';
export const PAYMENT_DOCUMENT_TYPE = 'client_import_payment';
export const DELIVERY_DOCUMENT_TYPE = 'client_goods_delivery';

const FILE_SEQUENCE_KEY = 'CLIENT_IMPORT_FILE';
const PAYMENT_SEQUENCE_KEY = 'CLIENT_IMPORT_PAYMENT';
const DELIVERY_SEQUENCE_KEY = 'CLIENT_GOODS_DELIVERY';

const MODULE = 'money_transfer';

/** Roles, not accounts (§12.4 — "configured through Accounting Mapping"). */
export const LINE_ROLES = {
  bank: 'bank',
  clientInventory: 'client_inventory',
  clientAccount: 'client_account',
} as const;

async function loadFile(tx: Tx, id: string) {
  const [row] = await tx.select().from(clientImportFile).where(eq(clientImportFile.id, id)).limit(1);
  if (!row) throw new Error(`No client import file '${id}'.`);
  return row;
}

/**
 * The partner a file belongs to.
 *
 * Reads `client_id` rather than going through the Money Transfer account, which
 * is optional since D16 merged the two registers: a file opened for a logistics
 * job alone has no account, and the partner is still the answer.
 */
async function partnerFor(tx: Tx, clientId: string) {
  const [row] = await tx
    .select({ id: businessPartner.id, code: businessPartner.code })
    .from(businessPartner)
    .where(eq(businessPartner.id, clientId))
    .limit(1);
  if (!row) throw new Error(`No business partner '${clientId}'.`);
  return row;
}

export async function openFile(
  tx: Tx,
  ctx: ActorContext,
  input: {
    /**
     * The Money Transfer client account, where the file has one. A file opened
     * for a logistics job alone has none — one register serves both (D16).
     */
    clientAccountId?: string | null;
    /** The business partner. Derived from the account when one is given. */
    clientId?: string | null;
    branchCode: string;
    openedOn: string;
    originCountry?: string | null;
    description?: string | null;
    note?: string | null;
  },
): Promise<{ id: string; fileNo: string }> {
  await authz.authorize(ctx.principal, 'create', FILE_DOCUMENT_TYPE, {
    branchCode: input.branchCode,
    requestId: ctx.requestId ?? null,
  });

  // The partner is the identity both services share. Given an account, it is
  // not a separate fact — reading it here means the caller cannot supply one
  // that disagrees, which the database would refuse anyway.
  let clientId = input.clientId ?? null;
  if (input.clientAccountId) {
    const [account] = await tx
      .select({ partnerId: moneyTransferClientAccount.partnerId })
      .from(moneyTransferClientAccount)
      .where(eq(moneyTransferClientAccount.id, input.clientAccountId))
      .limit(1);
    if (!account) throw new Error(`No money transfer client account '${input.clientAccountId}'.`);
    clientId = account.partnerId;
  }

  if (!clientId) {
    throw new Error(
      'An import file names its client (§11, §12.2). Supply a client account, or ' +
        'the business partner directly for a file that is only ever a logistics job.',
    );
  }

  const allocated = await allocateDocumentNumber(
    tx,
    FILE_SEQUENCE_KEY,
    { branchCode: input.branchCode, year: Number(input.openedOn.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(clientImportFile)
    .values({
      fileNo: allocated.documentNo,
      clientId,
      clientAccountId: input.clientAccountId ?? null,
      branchCode: input.branchCode,
      openedOn: input.openedOn,
      originCountry: input.originCountry ?? null,
      description: input.description ?? null,
      note: input.note ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: clientImportFile.id });

  return { id: created!.id, fileNo: allocated.documentNo };
}

// ---------------------------------------------------------------------------
// Payment for client goods — Dr Client Inventory / Cr Company Bank Account
// ---------------------------------------------------------------------------

export async function recordPayment(
  tx: Tx,
  ctx: ActorContext,
  input: {
    clientImportFileId: string;
    paymentDate: string;
    amountIqd: bigint;
    companyBankAccountId: string;
    supplierPartnerId?: string | null;
    supplierReference?: string | null;
  },
): Promise<{ id: string; paymentNo: string }> {
  const file = await loadFile(tx, input.clientImportFileId);

  await authz.authorize(ctx.principal, 'create', PAYMENT_DOCUMENT_TYPE, {
    branchCode: file.branchCode,
    requestId: ctx.requestId ?? null,
  });

  if (input.amountIqd <= 0n) {
    throw new Error('A payment of nothing buys nothing. State the amount paid for the client.');
  }

  const allocated = await allocateDocumentNumber(
    tx,
    PAYMENT_SEQUENCE_KEY,
    { branchCode: file.branchCode, year: Number(input.paymentDate.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(clientImportPayment)
    .values({
      paymentNo: allocated.documentNo,
      clientImportFileId: input.clientImportFileId,
      branchCode: file.branchCode,
      paymentDate: input.paymentDate,
      amountIqd: toDecimalString(input.amountIqd, 4n),
      companyBankAccountId: input.companyBankAccountId,
      supplierPartnerId: input.supplierPartnerId ?? null,
      supplierReference: input.supplierReference ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: clientImportPayment.id });

  return { id: created!.id, paymentNo: allocated.documentNo };
}

export async function postPayment(
  tx: Tx,
  ctx: ActorContext,
  id: string,
): Promise<{ journalEntryId: string }> {
  const [payment] = await tx
    .select()
    .from(clientImportPayment)
    .where(eq(clientImportPayment.id, id))
    .limit(1);

  if (!payment) throw new Error(`No client import payment '${id}'.`);

  await authz.authorize(ctx.principal, 'post', PAYMENT_DOCUMENT_TYPE, {
    branchCode: payment.branchCode,
    objectId: id,
    requestId: ctx.requestId ?? null,
  });

  if (payment.status !== 'draft') {
    throw new Error(`Payment ${payment.paymentNo} is '${payment.status}'; only a draft posts.`);
  }

  const file = await loadFile(tx, payment.clientImportFileId);
  const partner = await partnerFor(tx, file.clientId);

  const criteria = { branchCode: payment.branchCode };
  const dimensions = { branch: payment.branchCode, business_partner: partner.code };

  const result = await posting.post(tx, ctx, {
    eventType: 'money_transfer.client_import_payment',
    documentTypeCode: PAYMENT_DOCUMENT_TYPE,
    source: { module: MODULE, documentId: id, event: 'posted' },
    branchCode: payment.branchCode,
    documentDate: payment.paymentDate,
    postingDate: payment.paymentDate,
    description: `Payment for client goods ${payment.paymentNo} — file ${file.fileNo}`,
    lines: [
      { role: LINE_ROLES.clientInventory, debit: payment.amountIqd, criteria, dimensions },
      { role: LINE_ROLES.bank, credit: payment.amountIqd, criteria, dimensions },
    ],
  });

  await statuses.assertTransitionAllowed(tx, PAYMENT_DOCUMENT_TYPE, payment.status, 'posted');

  await tx
    .update(clientImportPayment)
    .set({
      status: 'posted',
      journalEntryId: result.journalEntryId,
      postedBy: ctx.principal.userId,
      postedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(clientImportPayment.id, id));

  if (file.status === 'draft') {
    await statuses.assertTransitionAllowed(tx, FILE_DOCUMENT_TYPE, file.status, 'posted');
    await tx
      .update(clientImportFile)
      .set({ status: 'posted', updatedAt: new Date() })
      .where(eq(clientImportFile.id, file.id));
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'client_import_payment.posted',
    objectType: PAYMENT_DOCUMENT_TYPE,
    objectId: id,
    branchCode: payment.branchCode,
    after: { journalEntryId: result.journalEntryId, amountIqd: payment.amountIqd },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });

  return { journalEntryId: result.journalEntryId };
}

// ---------------------------------------------------------------------------
// Delivery and financial settlement — Dr Client Account / Cr Client Inventory
// ---------------------------------------------------------------------------

export async function recordDelivery(
  tx: Tx,
  ctx: ActorContext,
  input: {
    clientImportFileId: string;
    deliveryDate: string;
    amountIqd: bigint;
    goodsDescription?: string | null;
    receivedBy?: string | null;
  },
): Promise<{ id: string; deliveryNo: string }> {
  const file = await loadFile(tx, input.clientImportFileId);

  await authz.authorize(ctx.principal, 'create', DELIVERY_DOCUMENT_TYPE, {
    branchCode: file.branchCode,
    requestId: ctx.requestId ?? null,
  });

  const allocated = await allocateDocumentNumber(
    tx,
    DELIVERY_SEQUENCE_KEY,
    { branchCode: file.branchCode, year: Number(input.deliveryDate.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(clientGoodsDelivery)
    .values({
      deliveryNo: allocated.documentNo,
      clientImportFileId: input.clientImportFileId,
      branchCode: file.branchCode,
      deliveryDate: input.deliveryDate,
      amountIqd: toDecimalString(input.amountIqd, 4n),
      goodsDescription: input.goodsDescription ?? null,
      receivedBy: input.receivedBy ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: clientGoodsDelivery.id });

  return { id: created!.id, deliveryNo: allocated.documentNo };
}

/**
 * §12.4 — *"Delivery and financial settlement: Dr Client Account / Cr Client
 * Inventory."*
 *
 * No Sales Invoice (§11.3): the company is providing a service, not selling
 * goods it owned. What the client is charged is what was paid on their behalf,
 * so this clears Client Inventory rather than recognising revenue — and the
 * logistics service earns its own revenue separately, in Phase 10.
 */
export async function postDelivery(
  tx: Tx,
  ctx: ActorContext,
  id: string,
): Promise<{ journalEntryId: string }> {
  const [delivery] = await tx
    .select()
    .from(clientGoodsDelivery)
    .where(eq(clientGoodsDelivery.id, id))
    .limit(1);

  if (!delivery) throw new Error(`No client goods delivery '${id}'.`);

  await authz.authorize(ctx.principal, 'post', DELIVERY_DOCUMENT_TYPE, {
    branchCode: delivery.branchCode,
    objectId: id,
    requestId: ctx.requestId ?? null,
  });

  if (delivery.status !== 'draft') {
    throw new Error(`Delivery ${delivery.deliveryNo} is '${delivery.status}'; only a draft posts.`);
  }

  const file = await loadFile(tx, delivery.clientImportFileId);
  const partner = await partnerFor(tx, file.clientId);

  const criteria = { branchCode: delivery.branchCode };
  const dimensions = { branch: delivery.branchCode, business_partner: partner.code };

  const result = await posting.post(tx, ctx, {
    eventType: 'money_transfer.client_goods_delivery',
    documentTypeCode: DELIVERY_DOCUMENT_TYPE,
    source: { module: MODULE, documentId: id, event: 'posted' },
    branchCode: delivery.branchCode,
    documentDate: delivery.deliveryDate,
    postingDate: delivery.deliveryDate,
    description: `Client goods delivered ${delivery.deliveryNo} — file ${file.fileNo}`,
    lines: [
      { role: LINE_ROLES.clientAccount, debit: delivery.amountIqd, criteria, dimensions },
      { role: LINE_ROLES.clientInventory, credit: delivery.amountIqd, criteria, dimensions },
    ],
  });

  await statuses.assertTransitionAllowed(tx, DELIVERY_DOCUMENT_TYPE, delivery.status, 'posted');

  await tx
    .update(clientGoodsDelivery)
    .set({
      status: 'posted',
      journalEntryId: result.journalEntryId,
      postedBy: ctx.principal.userId,
      postedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(clientGoodsDelivery.id, id));

  return { journalEntryId: result.journalEntryId };
}

/**
 * 09.10 gate — *"Client Inventory ... clears to zero on delivery settlement."*
 *
 * The balance is derived from the posted documents, never stored, so it cannot
 * disagree with them. The file refuses to settle while it is non-zero, and that
 * refusal is a trigger — a residual balance on a settled file would be company
 * money spent on goods nobody has any record of receiving.
 */
export async function clientInventoryBalance(tx: Tx, clientImportFileId: string): Promise<bigint> {
  const [paid] = await tx
    .select({ total: sql<string>`coalesce(sum(${clientImportPayment.amountIqd}), 0)` })
    .from(clientImportPayment)
    .where(
      and(
        eq(clientImportPayment.clientImportFileId, clientImportFileId),
        eq(clientImportPayment.status, 'posted'),
      ),
    );

  const [delivered] = await tx
    .select({ total: sql<string>`coalesce(sum(${clientGoodsDelivery.amountIqd}), 0)` })
    .from(clientGoodsDelivery)
    .where(
      and(
        eq(clientGoodsDelivery.clientImportFileId, clientImportFileId),
        eq(clientGoodsDelivery.status, 'posted'),
      ),
    );

  return parseDecimal(paid?.total ?? '0', 4n) - parseDecimal(delivered?.total ?? '0', 4n);
}

export async function settleFile(tx: Tx, ctx: ActorContext, id: string): Promise<void> {
  const file = await loadFile(tx, id);

  await authz.authorize(ctx.principal, 'approve', FILE_DOCUMENT_TYPE, {
    branchCode: file.branchCode,
    objectId: id,
    requestId: ctx.requestId ?? null,
  });

  const balance = await clientInventoryBalance(tx, id);
  if (balance !== 0n) {
    throw new Error(
      `Client import file ${file.fileNo} still carries a Client Inventory balance of ` +
        `${toDecimalString(balance, 4n)} (§12.4, §11.3). It clears to zero on delivery settlement.`,
    );
  }

  await statuses.assertTransitionAllowed(tx, FILE_DOCUMENT_TYPE, file.status, 'settled');

  await tx
    .update(clientImportFile)
    .set({ status: 'settled', updatedAt: new Date() })
    .where(eq(clientImportFile.id, id));
}

/**
 * §12.7 — the Client Import Cross-Reference.
 *
 * Links a client import file to the transfers that funded it and to the
 * Logistics job that moved it. The logistics reference is text until Phase 10
 * exists; the cross-reference is still the report §12.7 asks for, and Phase 10
 * turns the reference into a link without changing this query's shape.
 */
export async function crossReference(tx: Tx, options: { clientAccountId?: string } = {}) {
  const query = tx
    .select({
      fileNo: clientImportFile.fileNo,
      fileStatus: clientImportFile.status,
      openedOn: clientImportFile.openedOn,
      clientCode: businessPartner.code,
      clientName: businessPartner.legalName,
      logisticsJobNo: logisticsJob.jobNo,
      logisticsJobStatus: logisticsJob.status,
      transferNo: moneyTransfer.transferNo,
      transferStatus: moneyTransfer.status,
      transferAmountIqd: moneyTransfer.transferAmountIqd,
      // Cast to the money scale so an empty sum reads as '0.0000' like every
      // other amount on the row. A report where zero is spelled differently
      // from the figures beside it invites somebody to compare them as strings.
      paidIqd: sql<string>`(select coalesce(sum(p.amount_iqd), 0)::numeric(19,4)
                              from client_import_payment p
                             where p.client_import_file_id = ${clientImportFile.id}
                               and p.status = 'posted')`,
      deliveredIqd: sql<string>`(select coalesce(sum(d.amount_iqd), 0)::numeric(19,4)
                                   from client_goods_delivery d
                                  where d.client_import_file_id = ${clientImportFile.id}
                                    and d.status = 'posted')`,
    })
    .from(clientImportFile)
    // The partner comes from the file, not through the Money Transfer account:
    // since D16 the account is optional and a logistics-only file has none.
    .innerJoin(businessPartner, eq(businessPartner.id, clientImportFile.clientId))
    .leftJoin(moneyTransfer, eq(moneyTransfer.clientImportFileId, clientImportFile.id))
    .leftJoin(logisticsJob, eq(logisticsJob.importFileId, clientImportFile.id))
    .orderBy(clientImportFile.openedOn);

  return options.clientAccountId
    ? query.where(eq(clientImportFile.clientAccountId, options.clientAccountId))
    : query;
}
