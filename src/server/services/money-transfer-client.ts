/**
 * Money Transfer client accounts and KYC — Phase 09.1, §12.3 and §21.
 *
 * The client account is one funding cycle (§12.3): opened, paid into over days,
 * and closed when the client confirms funding is complete and names the amount
 * to transfer. It holds no client details — those are on the Business Partner,
 * because §6 gives Money Transfer the same record every other module uses.
 *
 * KYC hangs off the **partner**, not off the account: a client identified once
 * is identified for every cycle they open. §21 asks for the records to be
 * visible from both the partner and the transfer case, which is `kycFor` below —
 * a join, not a second copy.
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  businessPartner,
  clientKycDocument,
  clientKycRecord,
  kycRequiredDocument,
  moneyTransfer,
  moneyTransferClientAccount,
  moneyTransferDeposit,
} from '../db/schema';
import {
  clientClearingBalance,
  isKycComplete,
  KycIncompleteError,
  NO_KYC_RECORD,
  type KycStanding,
} from '../domain/money-transfer';
import { parseDecimal, toDecimalString } from '../domain/money';
import { can } from '../domain/permissions';
import type { ActorContext } from './chart-of-accounts';
import * as attachments from './attachments';
import * as audit from './audit';
import * as authz from './authorization';
import * as statuses from './statuses';
import { allocateDocumentNumber } from './numbering';

export const ACCOUNT_DOCUMENT_TYPE = 'money_transfer_client_account';
export const KYC_DOCUMENT_TYPE = 'client_kyc_record';
export const ACCOUNT_PERMISSION_OBJECT = 'money_transfer_client_account';
export const KYC_PERMISSION_OBJECT = 'client_kyc_record';

const ACCOUNT_SEQUENCE_KEY = 'MT_CLIENT_ACCOUNT';

/**
 * §21 — the classification a KYC file carries into the Phase 01 attachment
 * service. Uploading under this object type is what makes an attachment a KYC
 * document rather than a loose file, and it is what the parent-access check
 * below is registered against.
 */
export const KYC_ATTACHMENT_OBJECT_TYPE = 'client_kyc_record';

/**
 * §21 — *"an attachment inherits the access policy of the record it belongs
 * to."*
 *
 * The attachment service denies any object type whose owning module has not
 * said how access to it is decided, which is the right default: an unregistered
 * type would otherwise be a way to read a document with no permission at all.
 * So Money Transfer says it here, at module load, rather than leaving it to
 * whoever happens to wire the application up.
 *
 * A KYC record has no branch — §3.1's one authoritative partner record has none
 * either — so the answer is the role grant and nothing else. Someone who cannot
 * view a KYC record cannot read the passport stapled to it.
 */
attachments.registerParentAccessCheck(KYC_ATTACHMENT_OBJECT_TYPE, (_tx, principal) =>
  can(principal, 'view', KYC_PERMISSION_OBJECT),
);

export class ClientAccountNotFoundError extends Error {
  readonly code = 'MT_CLIENT_ACCOUNT_NOT_FOUND';
  constructor(id: string) {
    super(`No money transfer client account '${id}'.`);
    this.name = 'ClientAccountNotFoundError';
  }
}

export class ClientAccountStateError extends Error {
  readonly code = 'MT_CLIENT_ACCOUNT_STATE_INVALID';
  constructor(accountNo: string, status: string, detail: string) {
    super(`Client account ${accountNo} is '${status}': ${detail}`);
    this.name = 'ClientAccountStateError';
  }
}

// ---------------------------------------------------------------------------
// The client account
// ---------------------------------------------------------------------------

export interface OpenAccountInput {
  readonly partnerId: string;
  readonly branchCode: string;
  readonly openedOn: string;
  readonly note?: string | null;
}

async function load(tx: Tx, id: string) {
  const [account] = await tx
    .select()
    .from(moneyTransferClientAccount)
    .where(eq(moneyTransferClientAccount.id, id))
    .limit(1);
  if (!account) throw new ClientAccountNotFoundError(id);
  return account;
}

/**
 * Opens a funding cycle for a client.
 *
 * The partner must hold the customer role and be active; both are checked by the
 * database as well, because the 09.1 gate is about there being no module-local
 * client record at all — and a rule only the service holds is one the import
 * path does not.
 */
export async function openAccount(
  tx: Tx,
  ctx: ActorContext,
  input: OpenAccountInput,
): Promise<{ id: string; accountNo: string }> {
  await authz.authorize(ctx.principal, 'create', ACCOUNT_PERMISSION_OBJECT, {
    branchCode: input.branchCode,
    requestId: ctx.requestId ?? null,
  });

  const allocated = await allocateDocumentNumber(
    tx,
    ACCOUNT_SEQUENCE_KEY,
    { branchCode: input.branchCode, year: Number(input.openedOn.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(moneyTransferClientAccount)
    .values({
      accountNo: allocated.documentNo,
      partnerId: input.partnerId,
      branchCode: input.branchCode,
      openedOn: input.openedOn,
      note: input.note ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: moneyTransferClientAccount.id });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'money_transfer_client_account.opened',
    objectType: ACCOUNT_PERMISSION_OBJECT,
    objectId: created!.id,
    branchCode: input.branchCode,
    after: { accountNo: allocated.documentNo, partnerId: input.partnerId },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });

  return { id: created!.id, accountNo: allocated.documentNo };
}

/**
 * §12.3 — *"The client account remains open until the client confirms that
 * funding is complete and specifies the amount to transfer."*
 *
 * One act, two parts. The amount is required here rather than later because the
 * sentence makes it the thing the client says when they confirm; recording the
 * confirmation without it would leave the account in a state §12.3 does not
 * describe. After this, the database refuses further deposits.
 */
export async function confirmFunding(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  transferAmountIqd: bigint,
): Promise<{ balanceIqd: bigint }> {
  const account = await load(tx, id);

  await authz.authorize(ctx.principal, 'approve', ACCOUNT_PERMISSION_OBJECT, {
    branchCode: account.branchCode,
    objectId: id,
    requestId: ctx.requestId ?? null,
  });

  if (account.status !== 'draft') {
    throw new ClientAccountStateError(
      account.accountNo,
      account.status,
      'funding is confirmed once, on an open account.',
    );
  }

  if (transferAmountIqd <= 0n) {
    throw new Error(
      'Confirming funding means naming the amount to transfer (§12.3). A transfer of nothing is not a transfer.',
    );
  }

  const balance = await clearingBalance(tx, id);
  if (transferAmountIqd > balance) {
    throw new Error(
      `The client account holds ${toDecimalString(balance, 4n)} but ${toDecimalString(transferAmountIqd, 4n)} ` +
        'was named as the amount to transfer (§12.3). A transfer draws only on the deposits this client made.',
    );
  }

  await statuses.assertTransitionAllowed(tx, ACCOUNT_DOCUMENT_TYPE, account.status, 'approved');

  await tx
    .update(moneyTransferClientAccount)
    .set({
      status: 'approved',
      fundingConfirmedAt: new Date(),
      fundingConfirmedBy: ctx.principal.userId,
      confirmedTransferAmountIqd: toDecimalString(transferAmountIqd, 4n),
      updatedAt: new Date(),
    })
    .where(eq(moneyTransferClientAccount.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'money_transfer_client_account.funding_confirmed',
    objectType: ACCOUNT_PERMISSION_OBJECT,
    objectId: id,
    branchCode: account.branchCode,
    before: { status: 'draft' },
    after: {
      status: 'approved',
      confirmedTransferAmountIqd: toDecimalString(transferAmountIqd, 4n),
      balanceIqd: toDecimalString(balance, 4n),
    },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });

  return { balanceIqd: balance };
}

/**
 * 09.2 gate — *"The account cannot be closed while the client has not confirmed
 * funding complete."*
 *
 * Refused here with a sentence, and by a CHECK constraint whatever the path.
 */
export async function closeAccount(tx: Tx, ctx: ActorContext, id: string): Promise<void> {
  const account = await load(tx, id);

  await authz.authorize(ctx.principal, 'approve', ACCOUNT_PERMISSION_OBJECT, {
    branchCode: account.branchCode,
    objectId: id,
    requestId: ctx.requestId ?? null,
  });

  if (account.fundingConfirmedAt === null) {
    throw new ClientAccountStateError(
      account.accountNo,
      account.status,
      'the client has not confirmed that funding is complete, so the cycle is still open (§12.3).',
    );
  }

  const balance = await clearingBalance(tx, id);
  if (balance !== 0n) {
    throw new ClientAccountStateError(
      account.accountNo,
      account.status,
      `${toDecimalString(balance, 4n)} of the client's money is still on the clearing account. ` +
        'Transfer it or refund it before closing the cycle.',
    );
  }

  await statuses.assertTransitionAllowed(tx, ACCOUNT_DOCUMENT_TYPE, account.status, 'closed');

  await tx
    .update(moneyTransferClientAccount)
    .set({
      status: 'closed',
      closedAt: new Date(),
      closedBy: ctx.principal.userId,
      updatedAt: new Date(),
    })
    .where(eq(moneyTransferClientAccount.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'money_transfer_client_account.closed',
    objectType: ACCOUNT_PERMISSION_OBJECT,
    objectId: id,
    branchCode: account.branchCode,
    before: { status: account.status },
    after: { status: 'closed' },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

/**
 * 09.2 gate — *"The client clearing balance equals the sum of deposits less
 * usage at all times."*
 *
 * Read from the deposits every time, never from a stored total. A cached balance
 * is a second answer to a question that must have one, and the one that goes
 * stale is always the one being shown to the client.
 */
export async function clearingBalance(tx: Tx, clientAccountId: string): Promise<bigint> {
  const rows = await tx
    .select({
      amountIqd: moneyTransferDeposit.amountIqd,
      usedIqd: moneyTransferDeposit.usedAmountIqd,
      refundedIqd: moneyTransferDeposit.refundedAmountIqd,
    })
    .from(moneyTransferDeposit)
    .where(
      and(
        eq(moneyTransferDeposit.clientAccountId, clientAccountId),
        // Draft, cancelled and reversed deposits are not client money: nothing
        // reached the bank, or it has been taken back out again.
        sql`${moneyTransferDeposit.status} in ('posted', 'partially_executed', 'settled')`,
      ),
    );

  return clientClearingBalance(
    rows.map((r) => ({
      amountIqd: parseDecimal(r.amountIqd, 4n),
      usedIqd: parseDecimal(r.usedIqd, 4n),
      refundedIqd: parseDecimal(r.refundedIqd, 4n),
    })),
  );
}

// ---------------------------------------------------------------------------
// 09.1 — KYC
// ---------------------------------------------------------------------------

export interface RaiseKycInput {
  readonly partnerId: string;
  readonly riskRatingCode?: string | null;
  readonly expiresOn?: string | null;
  readonly note?: string | null;
}

export async function raiseKyc(
  tx: Tx,
  ctx: ActorContext,
  input: RaiseKycInput,
): Promise<{ id: string }> {
  await authz.authorize(ctx.principal, 'create', KYC_PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
    requestId: ctx.requestId ?? null,
  });

  const [created] = await tx
    .insert(clientKycRecord)
    .values({
      partnerId: input.partnerId,
      riskRatingCode: input.riskRatingCode ?? null,
      expiresOn: input.expiresOn ?? null,
      note: input.note ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: clientKycRecord.id });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'client_kyc_record.raised',
    objectType: KYC_PERMISSION_OBJECT,
    objectId: created!.id,
    branchCode: ctx.branchCode,
    after: { partnerId: input.partnerId, riskRatingCode: input.riskRatingCode ?? null },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });

  return { id: created!.id };
}

/**
 * 09.1 gate — *"KYC documents attach through the Phase 01 attachment service
 * with correct classification."*
 *
 * The file goes through `attachments.upload`, so scanning, versioning, retention
 * and the access log all apply without a second implementation (§24). The
 * classification is two things together: the attachment's object type, which
 * says it is KYC evidence, and `required_document_code`, which says *which*
 * requirement it answers. A file that satisfies no requirement is not evidence
 * of anything, which is why that column cannot be null.
 */
export async function attachKycDocument(
  tx: Tx,
  ctx: ActorContext,
  input: {
    kycRecordId: string;
    requiredDocumentCode: string;
    fileName: string;
    content: Buffer;
    providedOn: string;
    expiresOn?: string | null;
  },
): Promise<{ id: string; attachmentId: string }> {
  const [record] = await tx
    .select()
    .from(clientKycRecord)
    .where(eq(clientKycRecord.id, input.kycRecordId))
    .limit(1);

  if (!record) throw new Error(`No KYC record '${input.kycRecordId}'.`);

  if (record.status === 'approved') {
    throw new Error(
      `KYC record ${record.id} is approved; the documents attached to it are what was inspected (§21). ` +
        'Raise a renewal record to add or change them.',
    );
  }

  const uploaded = await attachments.upload(tx, ctx, {
    objectType: KYC_ATTACHMENT_OBJECT_TYPE,
    objectId: input.kycRecordId,
    fileName: input.fileName,
    content: input.content,
  });

  const [created] = await tx
    .insert(clientKycDocument)
    .values({
      kycRecordId: input.kycRecordId,
      requiredDocumentCode: input.requiredDocumentCode,
      attachmentId: uploaded.attachmentId,
      providedOn: input.providedOn,
      expiresOn: input.expiresOn ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: clientKycDocument.id });

  return { id: created!.id, attachmentId: uploaded.attachmentId };
}

/**
 * Submits the identification for review.
 *
 * A separate act from approving it, because §3.2's machine routes every document
 * draft → submitted → approved and this one has more reason than most to keep
 * the two apart: the person assembling the evidence and the person judging it
 * are different people (§5.2).
 */
export async function submitKyc(tx: Tx, ctx: ActorContext, id: string): Promise<void> {
  const [record] = await tx
    .select()
    .from(clientKycRecord)
    .where(eq(clientKycRecord.id, id))
    .limit(1);

  if (!record) throw new Error(`No KYC record '${id}'.`);

  await authz.authorize(ctx.principal, 'submit', KYC_PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
    objectId: id,
    requestId: ctx.requestId ?? null,
  });

  await statuses.assertTransitionAllowed(tx, KYC_DOCUMENT_TYPE, record.status, 'submitted');

  await tx
    .update(clientKycRecord)
    .set({ status: 'submitted', updatedAt: new Date() })
    .where(eq(clientKycRecord.id, id));
}

/**
 * Compliance approves the identification.
 *
 * Maker-checker, as everywhere else that releases something: §5.2's separation
 * of duties applies with particular force here, because approving a KYC record
 * is what lets a client move money.
 */
export async function approveKyc(tx: Tx, ctx: ActorContext, id: string): Promise<void> {
  const [record] = await tx
    .select()
    .from(clientKycRecord)
    .where(eq(clientKycRecord.id, id))
    .limit(1);

  if (!record) throw new Error(`No KYC record '${id}'.`);

  await authz.authorize(ctx.principal, 'approve', KYC_PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
    objectId: id,
    requestId: ctx.requestId ?? null,
  });

  if (record.createdBy === ctx.principal.userId) {
    throw new Error(
      'The person who raised a KYC record cannot approve it — approving it is what releases a client ' +
        'to move money (§5.2).',
    );
  }

  await statuses.assertTransitionAllowed(tx, KYC_DOCUMENT_TYPE, record.status, 'approved');

  // A renewal supersedes whatever it replaces, in the same transaction, so the
  // partial unique index never sees two live approved records for one partner.
  const [previous] = await tx
    .select({ id: clientKycRecord.id })
    .from(clientKycRecord)
    .where(
      and(
        eq(clientKycRecord.partnerId, record.partnerId),
        eq(clientKycRecord.status, 'approved'),
        isNull(clientKycRecord.supersededAt),
      ),
    )
    .limit(1);

  if (previous) {
    await tx
      .update(clientKycRecord)
      .set({ supersededAt: new Date(), supersededBy: id, updatedAt: new Date() })
      .where(eq(clientKycRecord.id, previous.id));
  }

  await tx
    .update(clientKycRecord)
    .set({
      status: 'approved',
      approvedBy: ctx.principal.userId,
      approvedAt: new Date(),
      reviewedBy: ctx.principal.userId,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(clientKycRecord.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'client_kyc_record.approved',
    objectType: KYC_PERMISSION_OBJECT,
    objectId: id,
    branchCode: ctx.branchCode,
    before: { status: record.status },
    after: { status: 'approved', supersededRecordId: previous?.id ?? null },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

export async function rejectKyc(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  reason: string,
): Promise<void> {
  const [record] = await tx
    .select()
    .from(clientKycRecord)
    .where(eq(clientKycRecord.id, id))
    .limit(1);

  if (!record) throw new Error(`No KYC record '${id}'.`);

  await authz.authorize(ctx.principal, 'approve', KYC_PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
    objectId: id,
    requestId: ctx.requestId ?? null,
  });

  if (reason.trim().length === 0) {
    throw new Error('A refused KYC record needs a reason (§5.4) — the client is entitled to know why.');
  }

  await statuses.assertTransitionAllowed(tx, KYC_DOCUMENT_TYPE, record.status, 'rejected', reason);

  await tx
    .update(clientKycRecord)
    .set({
      status: 'rejected',
      rejectionReason: reason.trim(),
      reviewedBy: ctx.principal.userId,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(clientKycRecord.id, id));
}

/**
 * §21 — the KYC standing of a partner on a date, with whatever is missing.
 *
 * The required-document catalogue is Compliance's and ships empty (D9), so with
 * nothing configured this reduces to "approved and unexpired". Every requirement
 * they add narrows it, with no code change — which is what "risk-based" has to
 * mean in a system built before the risk policy exists.
 */
export async function kycStanding(
  tx: Tx,
  partnerId: string,
  onDate: string,
): Promise<KycStanding | null> {
  const [record] = await tx
    .select()
    .from(clientKycRecord)
    .where(
      and(
        eq(clientKycRecord.partnerId, partnerId),
        eq(clientKycRecord.status, 'approved'),
        isNull(clientKycRecord.supersededAt),
      ),
    )
    .limit(1);

  if (!record) return null;

  const missing = await tx
    .select({ code: kycRequiredDocument.code })
    .from(kycRequiredDocument)
    .where(
      and(
        eq(kycRequiredDocument.active, true),
        sql`(${kycRequiredDocument.riskRatingCode} is null
             or ${kycRequiredDocument.riskRatingCode} = ${record.riskRatingCode ?? null})`,
        sql`not exists (
              select 1 from client_kyc_document cd
               where cd.kyc_record_id = ${record.id}
                 and cd.required_document_code = ${kycRequiredDocument.code}
                 and (cd.expires_on is null or cd.expires_on >= ${onDate}))`,
      ),
    )
    .orderBy(kycRequiredDocument.code);

  return {
    status: record.status,
    expiresOn: record.expiresOn,
    missingDocumentCodes: missing.map((m) => m.code),
  };
}

/**
 * 09.1 gate — *"A transfer cannot be initiated for a client whose KYC is
 * incomplete."*
 *
 * Raised here so the caller gets a sentence naming what is missing; refused by
 * a trigger whatever the path, including import and API, which is what the 09.5
 * gate means by testing a lock somewhere other than the form.
 */
export async function assertKycComplete(
  tx: Tx,
  partnerId: string,
  onDate: string,
): Promise<void> {
  const [partner] = await tx
    .select({ code: businessPartner.code })
    .from(businessPartner)
    .where(eq(businessPartner.id, partnerId))
    .limit(1);

  const standing = await kycStanding(tx, partnerId, onDate);

  if (standing === null) {
    throw new KycIncompleteError(
      partner?.code ?? partnerId,
      { status: NO_KYC_RECORD, expiresOn: null, missingDocumentCodes: [] },
      onDate,
    );
  }

  if (!isKycComplete(standing, onDate)) {
    throw new KycIncompleteError(partner?.code ?? partnerId, standing, onDate);
  }
}

/**
 * §21 — *"KYC/compliance records are linked to the business partner and relevant
 * Money Transfer cases."*
 *
 * 09.1 gate: visible from both. One query answers both questions because the
 * record is on the partner and the case reaches it through the partner — there
 * is no second row to keep in step.
 */
export async function kycFor(
  tx: Tx,
  options: { partnerId?: string; clientAccountId?: string; moneyTransferId?: string },
) {
  let partnerId = options.partnerId ?? null;

  if (!partnerId && options.clientAccountId) {
    const [account] = await tx
      .select({ partnerId: moneyTransferClientAccount.partnerId })
      .from(moneyTransferClientAccount)
      .where(eq(moneyTransferClientAccount.id, options.clientAccountId))
      .limit(1);
    partnerId = account?.partnerId ?? null;
  }

  if (!partnerId && options.moneyTransferId) {
    const [row] = await tx
      .select({ partnerId: moneyTransferClientAccount.partnerId })
      .from(moneyTransfer)
      .innerJoin(
        moneyTransferClientAccount,
        eq(moneyTransferClientAccount.id, moneyTransfer.clientAccountId),
      )
      .where(eq(moneyTransfer.id, options.moneyTransferId))
      .limit(1);
    partnerId = row?.partnerId ?? null;
  }

  if (!partnerId) return [];

  return tx
    .select({
      id: clientKycRecord.id,
      partnerCode: businessPartner.code,
      partnerName: businessPartner.legalName,
      status: clientKycRecord.status,
      riskRatingCode: clientKycRecord.riskRatingCode,
      expiresOn: clientKycRecord.expiresOn,
      approvedAt: clientKycRecord.approvedAt,
      supersededAt: clientKycRecord.supersededAt,
    })
    .from(clientKycRecord)
    .innerJoin(businessPartner, eq(businessPartner.id, clientKycRecord.partnerId))
    .where(eq(clientKycRecord.partnerId, partnerId))
    .orderBy(desc(clientKycRecord.createdAt));
}

export async function view(tx: Tx, id: string) {
  const account = await load(tx, id);
  return { account, balanceIqd: await clearingBalance(tx, id) };
}
