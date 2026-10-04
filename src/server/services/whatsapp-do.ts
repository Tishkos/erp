/**
 * Proposing and running an action from chat — REQ-WA-001 WA-8, the service.
 *
 * Two halves, deliberately far apart:
 *
 *   `prepare`  reads. It resolves what was named into a real document under
 *              the asker's own read-only scope, refuses what cannot be done
 *              before anybody is asked to confirm it, and writes the sentence
 *              of facts Noah has to put to them. Nothing changes here.
 *   `run`      writes, once, after a person has said yes. It calls the ERP's
 *              own service as that person; every rule the screen enforces is
 *              enforced here because it is the same code path.
 *
 * Adding an action is adding a case to each half and a name to
 * `ACTION_NAMES`. Resist adding one whose service does not already refuse
 * properly on its own: this file must never be the thing that decides whether
 * something is allowed.
 *
 * A document's step (2026-10-04) is one case for ten families: `WHERE` finds
 * the document by its number and `RUN` is the call its own screen makes. A new
 * family is a row in `DOCUMENT_FAMILIES` and one in each of those two.
 */
import { sql } from 'drizzle-orm';
import { withScope, type Tx } from '../db/client';
import { businessToday } from '../domain/business-date';
import { can, type Principal } from '../domain/permissions';
import { money } from '../domain/whatsapp';
import {
  DOCUMENT_FAMILIES,
  DOCUMENT_STEPS,
  STEPS_NEEDING_REASON,
  actionLabel,
  familyOf,
  stepConsequence,
  tidyNumber,
  type ActionName,
  type DocumentFamily,
  type DocumentStep,
  type PendingAction,
} from '../domain/whatsapp-do';
import { registerAllRecords } from '../records';
import * as apInvoices from './ap-invoice';
import * as approvals from './approvals';
import * as arInvoices from './ar-invoice';
import * as audit from './audit';
import type { ActorContext } from './chart-of-accounts';
import * as customerReceipts from './customer-receipt';
import * as goodsReceipts from './goods-receipt';
import * as goodsReturns from './goods-return';
import * as journals from './journal';
import * as openingStockService from './opening-stock';
import * as partnersService from './partners';
import * as purchaseOrders from './purchase-order';
import * as supplierPayments from './supplier-payment';
import * as treasury from './treasury';
import { principalOf, type ReadContext } from './whatsapp';
import { waitingFor } from './whatsapp-actions';

const NL = String.fromCharCode(10);

export type Prepared = { readonly ok: true; readonly pending: PendingAction } | { readonly ok: false; readonly reason: string };
export type Ran = { readonly ok: true; readonly said: string } | { readonly ok: false; readonly reason: string };

/**
 * What a document's number was given as, tidied.
 *
 * People type a number out of a message they are looking at, so it arrives
 * with the case and spacing of wherever it was copied from.
 */
function documentNumber(args: Record<string, unknown>): string {
  return tidyNumber(args.document ?? args.documentNo ?? args.no ?? '');
}

// ---------------------------------------------------------------------------
// The document families — 2026-10-04
// ---------------------------------------------------------------------------

/** Where a family's rows are, to find one by its number. Names only: nothing here is typed by anybody. */
const WHERE: Readonly<Record<DocumentFamily['key'], { readonly table: string; readonly number: string; readonly amount?: string }>> = {
  ap_invoice: { table: 'ap_invoice', number: 'invoice_no', amount: 'total_iqd' },
  ar_invoice: { table: 'ar_invoice', number: 'invoice_no' },
  purchase_order: { table: 'purchase_order', number: 'order_no' },
  goods_receipt: { table: 'goods_receipt', number: 'receipt_no' },
  goods_return: { table: 'goods_return', number: 'return_no' },
  supplier_payment: { table: 'supplier_payment', number: 'payment_no', amount: 'amount_iqd' },
  customer_receipt: { table: 'customer_receipt', number: 'receipt_no', amount: 'amount_iqd' },
  journal_entry: { table: 'journal_entry', number: 'entry_no' },
  bank_transfer: { table: 'bank_transfer', number: 'transfer_no', amount: 'amount' },
  opening_stock: { table: 'opening_stock', number: 'document_no' },
};

interface Located {
  readonly id: string;
  readonly status: string;
  readonly branchCode: string | null;
  readonly amount: string | null;
}

/**
 * One document by its number, under whoever is asking.
 *
 * Row-level security is already applied, so a document in a branch they
 * cannot see is simply not found — the same answer its screen would give.
 */
async function locate(tx: Tx, family: DocumentFamily, documentNo: string): Promise<Located | null> {
  const at = WHERE[family.key];
  const amount = at.amount ? sql`${sql.identifier(at.amount)}::text` : sql`null::text`;
  const result = await tx.execute(sql`
    select id::text as id, status::text as status, branch_code as branch_code, ${amount} as amount
      from ${sql.identifier(at.table)}
     where upper(${sql.identifier(at.number)}) = ${documentNo}
     limit 1`);
  const row = result.rows[0] as { id: string; status: string; branch_code: string | null; amount: string | null } | undefined;
  return row ? { id: row.id, status: row.status, branchCode: row.branch_code, amount: row.amount } : null;
}

/**
 * Each family's steps, as the calls its own screen makes.
 *
 * Nothing is decided here: every function below authorises the caller, checks
 * the document's state, the maker-checker rule and the period itself, and
 * refuses in its own words. This table is only the address book.
 */
type StepRun = (tx: Tx, ctx: ActorContext, id: string, reason: string) => Promise<unknown>;

const RUN: Readonly<Record<DocumentFamily['key'], Partial<Record<DocumentStep, StepRun>>>> = {
  ap_invoice: {
    submit: (tx, ctx, id) => apInvoices.submit(tx, ctx, id),
    post: (tx, ctx, id) => apInvoices.post(tx, ctx, id),
    reverse: (tx, ctx, id, reason) => apInvoices.reverse(tx, ctx, id, { reason }),
  },
  ar_invoice: {
    approve: (tx, ctx, id) => arInvoices.approve(tx, ctx, id),
    post: (tx, ctx, id) => arInvoices.post(tx, ctx, id),
    reverse: (tx, ctx, id, reason) => arInvoices.reverse(tx, ctx, id, { reason }),
  },
  purchase_order: {
    submit: (tx, ctx, id) => purchaseOrders.submit(tx, ctx, id),
    approve: (tx, ctx, id) => purchaseOrders.approve(tx, ctx, id),
    cancel: (tx, ctx, id, reason) => purchaseOrders.cancel(tx, ctx, id, reason),
  },
  goods_receipt: {
    submit: (tx, ctx, id) => goodsReceipts.submit(tx, ctx, id),
    post: (tx, ctx, id) => goodsReceipts.post(tx, ctx, id),
  },
  goods_return: {
    approve: (tx, ctx, id) => goodsReturns.approve(tx, ctx, id),
    post: (tx, ctx, id) => goodsReturns.post(tx, ctx, id),
  },
  supplier_payment: {
    post: (tx, ctx, id) => supplierPayments.post(tx, ctx, id),
    reverse: (tx, ctx, id, reason) => supplierPayments.reverse(tx, ctx, id, { reversalDate: businessToday(), reason }),
  },
  customer_receipt: {
    approve: (tx, ctx, id) => customerReceipts.approve(tx, ctx, id),
    post: (tx, ctx, id) => customerReceipts.post(tx, ctx, id),
  },
  journal_entry: {
    submit: (tx, ctx, id) => journals.submit(tx, ctx, id),
    approve: (tx, ctx, id) => journals.approve(tx, ctx, id),
    reject: (tx, ctx, id, reason) => journals.reject(tx, ctx, id, reason),
    reverse: (tx, ctx, id, reason) => journals.reverse(tx, ctx, id, { reason }),
  },
  bank_transfer: {
    approve: (tx, ctx, id) => treasury.approveTransferAsChecker(tx, ctx, id),
    post: (tx, ctx, id) => treasury.postTransfer(tx, ctx, id),
  },
  opening_stock: {
    submit: (tx, ctx, id) => openingStockService.submit(tx, ctx, id),
    approve: (tx, ctx, id) => openingStockService.approve(tx, ctx, id),
  },
};

const families = () => DOCUMENT_FAMILIES.map((family) => `${family.label} (${family.prefix}-…: ${family.steps.join(', ')})`).join('; ');

/**
 * Resolve and describe, without changing anything.
 *
 * The refusals here are the ones worth giving before a person is asked to
 * confirm: a document that does not exist, one that is not in a state to be
 * acted on, one that is not theirs to decide. Everything else — their
 * permissions, the maker-checker rule, the period — is the service's to
 * refuse at the moment it runs, and it says so in its own words.
 */
export async function prepare(input: {
  readonly ctx: ReadContext;
  readonly userId: string;
  readonly chat: string;
  readonly action: string;
  readonly args: Record<string, unknown>;
  readonly now?: Date;
}): Promise<Prepared> {
  const action = input.action as ActionName;
  const no = documentNumber(input.args);
  const reason = String(input.args.reason ?? '').trim() || null;
  const proposedAt = (input.now ?? new Date()).toISOString();
  const base = { action, userId: input.userId, chat: input.chat, reason, proposedAt };

  if (action === 'approve_document' || action === 'reject_document') {
    if (!no) return { ok: false, reason: 'Which document? I need its number.' };
    if (action === 'reject_document' && !reason) {
      return { ok: false, reason: 'A rejection needs a reason — ask them what it is and propose it again with the reason.' };
    }
    // Only what is already waiting for this person: there is no "approve
    // anything by number" path, exactly as in WA-6.
    const waiting = await waitingFor(input.userId);
    const found = waiting.find((item) => item.documentNumber.toUpperCase() === no);
    if (!found) {
      const list = waiting.length > 0 ? waiting.map((item) => item.documentNumber).join(', ') : 'nothing';
      return {
        ok: false,
        reason: `${no} is not waiting for their decision. What is: ${list}. Tell them that, and that a document has to be routed to them before they can decide it.`,
      };
    }
    const verb = action === 'approve_document' ? 'approve' : 'reject';
    const sentence = [
      `${verb} ${found.documentNumber} (${found.documentType.replace(/_/g, ' ')})`,
      `raised by ${found.submittedByName ?? 'somebody'} on ${found.submittedAt.toISOString().slice(0, 10)}${found.branchCode ? `, branch ${found.branchCode}` : ''}`,
      reason ? `reason: ${reason}` : '',
      verb === 'approve'
        ? 'Approving it lets it take effect, and a posted document is reversed afterwards rather than edited.'
        : 'Rejecting it sends it back to whoever raised it.',
    ]
      .filter((part) => part !== '')
      .join(NL);
    return {
      ok: true,
      pending: {
        ...base,
        target: { kind: found.documentType, id: found.documentId, documentNo: found.documentNumber, branchCode: found.branchCode },
        sentence,
      },
    };
  }

  if (action === 'approve_opening_stock') {
    if (!no) return { ok: false, reason: 'Which opening stock document? I need its number, such as OPN-HQ-2026-000008.' };
    const found = await openingStockService.viewByNo(input.ctx.tx, no);
    if (!found) return { ok: false, reason: `There is no opening stock document ${no} on the system.` };
    const header = (found as unknown as { document?: Record<string, unknown> }).document ?? (found as unknown as Record<string, unknown>);
    const lines = (found as unknown as { lines?: Record<string, unknown>[] }).lines ?? [];
    const status = String(header.status ?? '');
    if (status !== 'submitted') {
      return {
        ok: false,
        reason: `${no} is ${status || 'in an unknown state'}, and only a submitted document can be approved. Tell them what state it is in.`,
      };
    }
    // Each line already carries its own value, worked out by the service that
    // owns the arithmetic. Summing those is right; multiplying quantity by
    // cost again here would be a second opinion on the company's money.
    const total = lines.reduce((sum, line) => sum + (Number(line.totalIqd ?? 0) || 0), 0);
    const sentence = [
      `approve opening stock ${no} for ${String(header.warehouseName ?? header.warehouseCode ?? 'the warehouse')}`,
      `${lines.length} line(s), ${money(total)} IQD at cost`,
      'This posts the quantities into the inventory ledger and opens their FIFO cost layers. From then on the stock is real: it can be sold and moved, and the document cannot be edited — only reversed.',
    ].join(NL);
    return {
      ok: true,
      pending: {
        ...base,
        target: {
          kind: 'opening_stock',
          id: String(header.id ?? ''),
          documentNo: no,
          branchCode: (header.branchCode as string | null) ?? null,
        },
        sentence,
      },
    };
  }

  if (action === 'document_step') {
    const step = String(input.args.step ?? '').trim().toLowerCase() as DocumentStep;
    if (!DOCUMENT_STEPS.includes(step)) {
      return { ok: false, reason: `Which step? One of: ${DOCUMENT_STEPS.join(', ')}.` };
    }
    if (!no) return { ok: false, reason: 'Which document? I need its number, as it is written on the system.' };
    const family = familyOf(no);
    if (!family) {
      return {
        ok: false,
        reason: `I cannot tell what kind of document ${no} is from its number. The ones I can move a step: ${families()}. For anything else, tell them which screen to do it on.`,
      };
    }
    if (!(family.steps as readonly DocumentStep[]).includes(step)) {
      // Where a family has no such step by number, the person may still hold
      // it in their approval inbox — and a purchase invoice's approval is its
      // posting, by somebody who may approve and did not raise it.
      const viaInbox = step === 'approve' || step === 'reject';
      return {
        ok: false,
        reason: [
          `A ${family.label} has no "${step}" step of its own. Its steps: ${family.steps.join(', ')}.`,
          family.key === 'ap_invoice' && step === 'approve'
            ? 'For a purchase invoice, posting IS the approval: it is posted by somebody who holds the approve right and did not raise it.'
            : '',
          viaInbox
            ? `If it is waiting in this person's approval inbox (approvals_waiting shows what is), propose ${step}_document for it instead.`
            : 'Explain that, and what they should do instead.',
        ]
          .filter((part) => part !== '')
          .join(' '),
      };
    }
    if (STEPS_NEEDING_REASON.includes(step) && !reason) {
      return { ok: false, reason: `To ${step} a document the system wants a reason. Ask them for it, then propose it again with the reason.` };
    }
    const found = await locate(input.ctx.tx, family, no);
    if (!found) {
      return { ok: false, reason: `There is no ${family.label} ${no} that this person can see. Check the number with them (the list screen shows it).` };
    }
    if (family.key === 'journal_entry' && step === 'reverse') {
      // A journal a document posted is that document's to reverse: mirroring
      // the journal alone leaves the invoice, the stock and the sub-ledger
      // exactly as they were, and the books then disagree with themselves.
      // (The journal screen does offer it — a defect noted on 2026-10-04 —
      // and chat does not repeat it.)
      const origin = await input.ctx.tx.execute(sql`select source::text as source, source_module from journal_entry where id = ${found.id}`);
      const row = origin.rows[0] as { source: string; source_module: string | null } | undefined;
      if (row && row.source !== 'manual') {
        return {
          ok: false,
          reason: `${no} was posted by a document (${row.source_module ?? 'the system'}), not typed by hand. Reversing the journal alone would leave that document and its stock as they are. Find the document that posted it (the query tool: journal_entry.source_doc_id) and propose reversing the document itself — its reversal mirrors this journal for them.`,
        };
      }
    }
    const sentence = [
      `${step} ${family.label} ${no}`,
      `it is ${found.status.replace(/_/g, ' ')} now${found.branchCode ? `, branch ${found.branchCode}` : ''}${found.amount ? `, ${money(found.amount)}${family.key === 'bank_transfer' ? '' : ' IQD'}` : ''}`,
      reason ? `reason: ${reason}` : '',
      stepConsequence(step),
    ]
      .filter((part) => part !== '')
      .join(NL);
    return {
      ok: true,
      pending: { ...base, step, target: { kind: family.key, id: found.id, documentNo: no, branchCode: found.branchCode }, sentence },
    };
  }

  if (action === 'create_partner') {
    const role = String(input.args.role ?? '').trim().toLowerCase();
    if (role !== 'customer' && role !== 'supplier') return { ok: false, reason: "Is it a customer or a supplier? Ask, then propose it with role 'customer' or 'supplier'." };
    const name = String(input.args.name ?? '').trim();
    if (name.length < 2) return { ok: false, reason: `What is the ${role}'s name, as it should appear on documents?` };
    const detail = (key: string) => String(input.args[key] ?? '').trim();
    const payload: Record<string, string> = { role, name };
    for (const key of ['phone', 'email', 'address', 'tradeName'] as const) if (detail(key)) payload[key] = detail(key);
    const approves = can(input.ctx.principal, 'approve', partnersService.PERMISSION_OBJECT);
    const sentence = [
      `create the ${role} "${name}"`,
      ['phone', 'email', 'address', 'tradeName'].filter((key) => payload[key]).map((key) => `${key}: ${payload[key]}`).join(' · '),
      'The system gives it its code (CUS-… or SUP-…). A name that is already a partner is not made twice: it is given this role as well.',
      approves
        ? 'It will be approved straight away, so it can be used on documents.'
        : 'This person cannot approve partners, so it will be a prospect until somebody who can approves it on its profile.',
    ]
      .filter((part) => part !== '')
      .join(NL);
    return {
      ok: true,
      pending: { ...base, payload, target: { kind: 'business_partner', id: '', documentNo: name, branchCode: null }, sentence },
    };
  }

  if (action === 'approve_partner') {
    const code = tidyNumber(input.args.document ?? input.args.code ?? '');
    if (!code) return { ok: false, reason: 'Which partner? I need its code, such as SUP-000004 or CUS-000012 (list_partners finds it by name).' };
    let partner: Awaited<ReturnType<typeof partnersService.getByCode>>;
    try {
      partner = await partnersService.getByCode(input.ctx.tx, code);
    } catch {
      return { ok: false, reason: `There is no customer or supplier with the code ${code}.` };
    }
    if (partner.status !== 'prospect') {
      return { ok: false, reason: `${code} · ${partner.legalName} is ${partner.status.replace(/_/g, ' ')}, not a prospect — there is nothing to approve. Tell them its status.` };
    }
    const sentence = [
      `approve ${code} · ${partner.legalName} (${[partner.isCustomer ? 'customer' : '', partner.isSupplier ? 'supplier' : ''].filter(Boolean).join(' and ')})`,
      'It is a prospect now. Approved, it can be chosen on orders, invoices and payments.',
    ].join(NL);
    return {
      ok: true,
      pending: { ...base, target: { kind: 'business_partner', id: partner.id, documentNo: code, branchCode: null }, sentence },
    };
  }

  return { ok: false, reason: `I cannot do "${input.action}". What I can do: ${actionNames()}.` };
}

function actionNames(): string {
  return `approve or reject a document that is waiting for you; approve opening stock; move a document a step by its number — ${families()}; create a customer or a supplier; approve a prospect partner`;
}

/**
 * Do it.
 *
 * In its own writable transaction, as the person who said yes, through the
 * ERP's own service. A refusal from the service is returned in its own words
 * rather than thrown: it is the answer, and the audit row for the attempt has
 * to survive it.
 */
export async function run(input: {
  readonly userId: string;
  readonly pending: PendingAction;
  readonly e164: string;
}): Promise<Ran> {
  registerAllRecords();
  const principal: Principal = await principalOf(input.userId);
  const branchCode = input.pending.target.branchCode ?? principal.defaultBranchCode ?? '';
  const scope = { userId: input.userId, branchCode, isSuperUser: principal.isSuperUser };

  try {
    return await withScope(scope, async (tx) => {
      const said = await perform(tx, principal, branchCode, input.pending);
      await auditDone(tx, input, 'success', said);
      return { ok: true, said } as const;
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // The attempt is recorded even though it failed, in its own transaction —
    // the one it was refused in has been rolled back.
    await withScope(scope, (tx) => auditDone(tx, input, 'denied', reason)).catch(() => {
      /* the refusal is the answer; a failed audit of it must not hide it */
    });
    return { ok: false, reason };
  }
}

async function perform(tx: Tx, principal: Principal, branchCode: string, pending: PendingAction): Promise<string> {
  if (pending.action === 'document_step') {
    const family = DOCUMENT_FAMILIES.find((candidate) => candidate.key === pending.target.kind);
    const step = pending.step ?? null;
    const call = family && step ? RUN[family.key][step] : undefined;
    if (!family || !step || !call) throw new Error(`There is no "${String(step)}" step for ${pending.target.documentNo}.`);
    await call(tx, { principal, branchCode }, pending.target.id, pending.reason ?? '');
    const after = await locate(tx, family, pending.target.documentNo);
    const done: Readonly<Record<DocumentStep, string>> = {
      submit: 'submitted',
      approve: 'approved',
      reject: 'rejected',
      post: 'posted',
      reverse: 'reversed',
      cancel: 'cancelled',
    };
    return `${family.label} ${pending.target.documentNo} ${done[step]}.${after ? ` It is ${after.status.replace(/_/g, ' ')} now.` : ''}`;
  }

  if (pending.action === 'create_partner') {
    const payload = pending.payload ?? {};
    const role = payload.role === 'supplier' ? 'supplier' : 'customer';
    const made = await partnersService.createInRole(tx, { principal, branchCode }, role, {
      legalName: payload.name ?? pending.target.documentNo,
      tradeName: payload.tradeName ?? null,
      phone: payload.phone ?? null,
      email: payload.email ?? null,
      address: payload.address ?? null,
    });
    const now = await partnersService.getByCode(tx, made.code);
    return [
      `${role === 'supplier' ? 'Supplier' : 'Customer'} ${made.code} · ${now.legalName} is on the system.`,
      now.status === 'active'
        ? 'It is approved, so it can be used on documents now.'
        : 'It is a prospect: somebody who may approve partners has to approve it on its profile before it can be used.',
    ].join(' ');
  }

  if (pending.action === 'approve_partner') {
    await partnersService.approve(tx, { principal, branchCode }, pending.target.documentNo);
    return `${pending.target.documentNo} approved. It can be chosen on documents now.`;
  }

  if (pending.action === 'approve_document' || pending.action === 'reject_document') {
    const decision = pending.action === 'approve_document' ? 'approve' : 'reject';
    await approvals.decide(tx, principal, {
      documentTypeCode: pending.target.kind,
      documentId: pending.target.id,
      decision,
      reason: pending.reason,
      branchCode: pending.target.branchCode,
    });
    return `${pending.target.documentNo} ${decision === 'approve' ? 'approved' : 'rejected'}.`;
  }

  const result = await openingStockService.approve(tx, { principal, branchCode }, pending.target.id);
  const movements = result.movementIds.length;
  return [
    `${pending.target.documentNo} approved.`,
    `${movements} stock movement(s) posted${result.journalEntryId ? ' and the opening journal raised' : ''}.`,
    'The quantities are in the inventory ledger now, so the warehouse reports will show them.',
  ].join(' ');
}

function auditDone(
  tx: Tx,
  input: { readonly userId: string; readonly pending: PendingAction; readonly e164: string },
  outcome: 'success' | 'denied',
  detail: string,
) {
  return audit.record(tx, {
    actorUserId: input.userId,
    action: `whatsapp.action.${input.pending.action}`,
    objectType: input.pending.target.kind,
    objectId: input.pending.target.id || input.pending.target.documentNo,
    branchCode: input.pending.target.branchCode,
    outcome: outcome === 'success' ? 'success' : 'denied',
    after: {
      e164: input.e164,
      chat: input.pending.chat,
      documentNo: input.pending.target.documentNo,
      what: actionLabel(input.pending.action, input.pending.step),
      ...(input.pending.step ? { step: input.pending.step } : {}),
      ...(input.pending.payload ? { payload: input.pending.payload } : {}),
      proposedAt: input.pending.proposedAt,
      confirmed: true,
      detail: detail.slice(0, 500),
    },
  });
}
