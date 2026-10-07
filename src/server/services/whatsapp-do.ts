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
 *
 * Two more ways in (2026-10-05), and neither is a second way of doing
 * anything: `preview` runs the same `perform` in a transaction that is always
 * rolled back and reads what it wrote, and a plan (`run_plan`) is several
 * ordinary steps under one yes — each prepared and run exactly as it would be
 * alone.
 */
import { sql, type SQLWrapper } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { withScope, type Tx } from '../db/client';
import { businessToday } from '../domain/business-date';
import { PERMISSION_VERBS, PermissionDeniedError, ScopeDeniedError, can, type Grant, type Principal } from '../domain/permissions';
import { profileHref } from '../domain/profiles';
import { DEFAULT_SETTINGS, money, quantity } from '../domain/whatsapp';
import {
  DOCUMENT_FAMILIES,
  DOCUMENT_STEPS,
  PLAN_MAX_STEPS,
  PLAN_MIN_STEPS,
  PLAN_STEP_ACTIONS,
  STEPS_NEEDING_REASON,
  actionLabel,
  familyOf,
  numberShapes,
  stepConsequence,
  tidyNumber,
  type ActionName,
  type DocumentFamily,
  type DocumentStep,
  type PendingAction,
  type PlanStep,
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
import { principalOf, withReadOnlyScope, type ReadContext } from './whatsapp';
import { waitingFor } from './whatsapp-actions';
import { prepareDraft, runDraft } from './whatsapp-drafts';

const NL = String.fromCharCode(10);

export type Prepared = { readonly ok: true; readonly pending: PendingAction } | { readonly ok: false; readonly reason: string };
export type Ran = { readonly ok: true; readonly said: string } | { readonly ok: false; readonly reason: string };

/**
 * A refusal, in the words of whoever refused.
 *
 * A service refuses by throwing its own sentence. The database refuses too —
 * a trigger that will not let stock go below nothing, a journal that does not
 * balance, checked when the transaction commits — and that arrives wrapped in
 * the statement that carried it ("Failed query: commit"), with the sentence
 * one level down.
 */
function wordsOf(error: unknown): string {
  let at: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    const cause = (at as { cause?: unknown } | null)?.cause;
    if (!(at instanceof Error) || !at.message.startsWith('Failed query:') || !(cause instanceof Error)) break;
    at = cause;
  }
  return at instanceof Error ? at.message : String(at);
}

/** PostgreSQL's own code for a refused statement, wherever in the chain it is. */
function pgCodeOf(error: unknown): string {
  let at: unknown = error;
  for (let depth = 0; depth < 5 && at; depth += 1) {
    const code = (at as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    at = (at as { cause?: unknown }).cause;
  }
  return '';
}

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
  /*
   * An invoice's header total is written when it posts, so a draft's is read
   * from its lines — otherwise a draft of 95,000 is put to the person as "0".
   */
  const amount =
    family.key === 'ap_invoice'
      ? sql`coalesce(nullif(t.total_iqd, 0), (select sum(l.quantity * l.unit_price - l.discount_iqd) from ap_invoice_line l where l.ap_invoice_id = t.id))::numeric(19,4)::text`
      : family.key === 'ar_invoice'
        ? sql`(select sum(l.net_iqd) from ar_invoice_line l where l.ar_invoice_id = t.id)::text`
        : at.amount
          ? sql`t.${sql.identifier(at.amount)}::text`
          : sql`null::text`;
  const result = await tx.execute(sql`
    select t.id::text as id, t.status::text as status, t.branch_code as branch_code, ${amount} as amount
      from ${sql.identifier(at.table)} t
     where upper(t.${sql.identifier(at.number)}) = ${documentNo}
     limit 1`);
  const row = result.rows[0] as { id: string; status: string; branch_code: string | null; amount: string | null } | undefined;
  // A figure of nothing is not a figure worth saying.
  return row ? { id: row.id, status: row.status, branchCode: row.branch_code, amount: row.amount && /[1-9]/.test(row.amount) ? row.amount : null } : null;
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
    // As its screen approves it: the stock AND the opening journal, together (§9.7).
    approve: (tx, ctx, id) => openingStockService.approve(tx, ctx, id, { post: true }),
  },
};

/** Each family's record page, for the address beside a document. */
const PAGE: Readonly<Record<DocumentFamily['key'], Parameters<typeof profileHref>[0] | null>> = {
  ap_invoice: 'purchase_invoice',
  ar_invoice: 'sales_invoice',
  purchase_order: 'purchase_order',
  goods_receipt: 'goods_receipt',
  goods_return: 'goods_return',
  supplier_payment: 'supplier_payment',
  customer_receipt: 'customer_receipt',
  journal_entry: 'journal',
  bank_transfer: null,
  opening_stock: 'opening_stock',
};

/**
 * The `document_status` tool: any document of a known family, by its number.
 *
 * Read as the asker — a document in a branch they cannot see is not found —
 * and only for a family whose screen their role opens.
 */
export async function describeDocument(tx: Tx, principal: Principal, raw: string, baseUrl: string): Promise<string> {
  const no = tidyNumber(raw);
  if (!no) return 'Which document? Give its number.';
  const family = familyOf(no);
  if (!family) {
    return `I cannot tell what kind of document ${no} is from its number. The kinds I can look up by number: ${DOCUMENT_FAMILIES.map((one) => `${one.label} (${numberShapes(one)})`).join(', ')}. For a payable (IMP-, LOC-, SVC-…) use payable_status; for a payment application, application_status.`;
  }
  // An internal transfer has no grant of its own: it is read by whoever reads the bank and cash accounts.
  const grant = family.key === 'bank_transfer' ? 'bank_cash_account' : family.key;
  if (!can(principal, 'view', grant)) {
    return `This person's role does not include "${family.label}" (the permission view on ${grant}), so it is not theirs to see. Tell them so, and that an administrator gives it on Settings → Administration → Roles.`;
  }
  const found = await locate(tx, family, no);
  if (!found) return `There is no ${family.label} ${no} that this person can see.`;
  const kind = PAGE[family.key];
  const href = kind ? profileHref(kind, no) : family.key === 'bank_transfer' ? `/treasury/transfers/${encodeURIComponent(no)}` : null;
  return [
    `${no} · ${family.label}`,
    `status: ${found.status.replace(/_/g, ' ')}${found.branchCode ? ` · branch ${found.branchCode}` : ''}${found.amount ? ` · ${money(found.amount)}${family.key === 'bank_transfer' ? '' : ' IQD'}` : ''}`,
    href ? `its page: ${baseUrl}${href}` : '',
    `steps it has from chat: ${family.steps.join(', ')} (document_step) — whether one applies now depends on its status and on who is asking.`,
  ]
    .filter((part) => part !== '')
    .join(NL);
}

const families = () => DOCUMENT_FAMILIES.map((family) => `${family.label} (${numberShapes(family)}: ${family.steps.join(', ')})`).join('; ');

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

  if (action === 'create_draft') {
    const prepared = await prepareDraft(input.ctx, input.args);
    if (!prepared.ok) return { ok: false, reason: prepared.reason };
    return {
      ok: true,
      pending: {
        ...base,
        draft: prepared.draft,
        target: { kind: prepared.draft.kind, id: '', documentNo: `new ${prepared.label}`, branchCode: input.ctx.branchCode },
        sentence: prepared.sentence,
      },
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

  if (action === 'run_plan') return preparePlan(input, base);

  return { ok: false, reason: `I cannot do "${input.action}". What I can do: ${actionNames()}.` };
}

function actionNames(): string {
  return `approve or reject a document that is waiting for you; approve opening stock; move a document a step by its number — ${families()}; create a customer or a supplier; approve a prospect partner; save a draft journal entry, purchase invoice or sales invoice; or ${PLAN_MIN_STEPS} to ${PLAN_MAX_STEPS} of those steps in order as one plan (run_plan)`;
}

// ---------------------------------------------------------------------------
// Plans — 2026-10-05
// ---------------------------------------------------------------------------

type PrepareInput = Parameters<typeof prepare>[0];

/** The steps as they were asked for: a list of `{ action, …what that action takes }`. */
function stepsAsked(raw: unknown): Record<string, unknown>[] | null {
  let list: unknown = raw;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(list)) return null;
  const steps = list.filter((one): one is Record<string, unknown> => typeof one === 'object' && one !== null && !Array.isArray(one));
  return steps.length === list.length ? steps : null;
}

/**
 * A later step of a plan: only what an earlier step cannot change.
 *
 * Step 1 has to be possible now. Step 2 usually is not — the invoice is not
 * posted until the stock is in, the opening stock is not approved until it is
 * submitted — and that is the reason there is a plan. So a later step is held
 * to what will still be true when its turn comes: the action and the step
 * exist for that kind of document, the document exists and this person can see
 * it, and a reason is given where the system wants one. Its state is judged
 * when it runs, by `prepare` again and then by its own service.
 */
async function laterStep(
  input: PrepareInput,
  action: ActionName,
  args: Record<string, unknown>,
): Promise<{ readonly ok: true; readonly sentence: string } | { readonly ok: false; readonly reason: string }> {
  const now = await prepare({ ...input, action, args });
  if (now.ok) return { ok: true, sentence: now.pending.sentence };
  const no = documentNumber(args);
  const reason = String(args.reason ?? '').trim();

  if (action === 'approve_opening_stock' && no) {
    const found = await openingStockService.viewByNo(input.ctx.tx, no);
    if (!found) return now;
    const header = (found as unknown as { document?: Record<string, unknown> }).document ?? (found as unknown as Record<string, unknown>);
    return {
      ok: true,
      sentence: [
        `approve opening stock ${no}`,
        `it is ${String(header.status ?? 'in an unknown state').replace(/_/g, ' ')} now, and has to be submitted by the time this step runs`,
        'Approving posts the quantities into the inventory ledger and opens their FIFO cost layers; from then on it is only reversed, never edited.',
      ].join(NL),
    };
  }

  if ((action === 'approve_document' || action === 'reject_document') && no && (action === 'approve_document' || reason)) {
    // Whether it is waiting for this person is exactly what an earlier step may
    // change. That it exists is not — where its number says what it is.
    const family = familyOf(no);
    if (family && !(await locate(input.ctx.tx, family, no))) return now;
    const verb = action === 'approve_document' ? 'approve' : 'reject';
    return {
      ok: true,
      sentence: [
        `${verb} ${no} from this person's approval inbox`,
        'it is not waiting for their decision now, and has to be by the time this step runs',
        reason ? `reason: ${reason}` : '',
      ]
        .filter((part) => part !== '')
        .join(NL),
    };
  }

  // A document's step, a partner to approve, a partner to create: what
  // `prepare` refuses there is the number, the step or the reason — none of
  // which an earlier step puts right.
  return now;
}

async function preparePlan(input: PrepareInput, base: Pick<PendingAction, 'action' | 'userId' | 'chat' | 'reason' | 'proposedAt'>): Promise<Prepared> {
  const asked = stepsAsked(input.args.steps);
  if (!asked) {
    return { ok: false, reason: `A plan is a list of steps, in the order they should run: steps: [{ action, …what that action takes }, …]. Each one of: ${PLAN_STEP_ACTIONS.join(', ')}.` };
  }
  if (asked.length < PLAN_MIN_STEPS) {
    return { ok: false, reason: `A plan is ${PLAN_MIN_STEPS} to ${PLAN_MAX_STEPS} steps, and this is ${asked.length}. For one step, propose that action itself.` };
  }
  if (asked.length > PLAN_MAX_STEPS) {
    return {
      ok: false,
      reason: `A plan is at most ${PLAN_MAX_STEPS} steps, and this is ${asked.length}. Propose the first ${PLAN_MAX_STEPS}; what is left is a second plan once those are done.`,
    };
  }

  const steps: PlanStep[] = [];
  let first: PendingAction | null = null;
  for (const [index, one] of asked.entries()) {
    const n = index + 1;
    const { action: named, ...args } = one;
    const name = String(named ?? '').trim();
    if (!(PLAN_STEP_ACTIONS as readonly string[]).includes(name)) {
      return {
        ok: false,
        reason:
          name === 'run_plan'
            ? `Step ${n}: a plan cannot hold another plan. List its steps in this one.`
            : name === 'create_draft'
              ? `Step ${n}: a draft is not part of a plan — its lines are a proposal of their own to read and say yes to. Save the draft first, then plan the steps on it by its number.`
              : `Step ${n}: "${name}" is not something a plan can hold. Each step is one of: ${PLAN_STEP_ACTIONS.join(', ')}.`,
      };
    }
    const action = name as ActionName;
    if (index === 0) {
      const prepared = await prepare({ ...input, action, args });
      if (!prepared.ok) return { ok: false, reason: `Step 1 cannot be done as things stand, so there is no plan to propose: ${prepared.reason}` };
      first = prepared.pending;
      steps.push({ action, args, sentence: prepared.pending.sentence });
      continue;
    }
    const later = await laterStep(input, action, args);
    if (!later.ok) return { ok: false, reason: `Step ${n} could not run whatever the steps before it do, so there is no plan to propose: ${later.reason}` };
    steps.push({ action, args, sentence: later.sentence });
  }
  if (!first) return { ok: false, reason: 'A plan needs a first step.' };

  const sentence = [
    `a plan of ${steps.length} steps, in this order:`,
    ...steps.map((step, index) => `${index + 1}. ${step.sentence.split(NL).join(' · ')}`),
    'They run one at a time, each in its own transaction, as this person — one yes for all of them. Each step is checked again when its turn comes. It stops at the first step the system refuses, and the steps already done by then STAY done: nothing is rolled back.',
  ].join(NL);
  return { ok: true, pending: { ...base, reason: null, target: first.target, plan: steps, sentence } };
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
  if (input.pending.action === 'run_plan') return runPlan(input);
  return runOne(input);
}

type RunInput = Parameters<typeof run>[0];

/** Where a step stands in the plan it is run from, for its audit row. */
interface PlanPart {
  readonly index: number;
  readonly of: number;
}

async function runOne(input: RunInput, part?: PlanPart): Promise<Ran> {
  const principal: Principal = await principalOf(input.userId);
  const branchCode = input.pending.target.branchCode ?? principal.defaultBranchCode ?? '';
  const scope = { userId: input.userId, branchCode, isSuperUser: principal.isSuperUser };

  try {
    return await withScope(scope, async (tx) => {
      const said = await perform(tx, principal, branchCode, input.pending);
      await auditDone(tx, input, 'success', said, part);
      return { ok: true, said } as const;
    });
  } catch (error) {
    const reason = wordsOf(error);
    // The attempt is recorded even though it failed, in its own transaction —
    // the one it was refused in has been rolled back.
    await withScope(scope, (tx) => auditDone(tx, input, 'denied', reason, part)).catch(() => {
      /* the refusal is the answer; a failed audit of it must not hide it */
    });
    return { ok: false, reason };
  }
}

/**
 * A plan, after its one yes.
 *
 * Step by step, in order, and each step is an ordinary action: read again as
 * this person in a fresh read-only transaction (the step before it has changed
 * the books), prepared again, then run by `runOne` in its own transaction with
 * its own audit row. The first step that cannot be prepared, or that its
 * service refuses, ends the plan. What ran before it is committed and stays:
 * nothing here can undo a posting, and pretending to would be worse than
 * saying plainly which steps are done.
 */
async function runPlan(input: RunInput): Promise<Ran> {
  const steps = input.pending.plan ?? [];
  if (steps.length === 0) return { ok: false, reason: 'There is no plan to run.' };
  const principal: Principal = await principalOf(input.userId);
  const branchCode = principal.defaultBranchCode ?? '';
  const scope = { userId: input.userId, branchCode, isSuperUser: principal.isSuperUser };

  const lines: string[] = [];
  let done = 0;
  let stoppedAt = 0;
  for (const [index, step] of steps.entries()) {
    const n = index + 1;
    if (stoppedAt > 0) {
      lines.push(`${n}. not run — ${step.sentence.split(NL)[0] ?? actionLabel(step.action)}`);
      continue;
    }
    let ran: Ran;
    try {
      const prepared = await withReadOnlyScope(scope, (tx) =>
        prepare({
          ctx: { tx, principal, branchCode, locale: 'en', settings: DEFAULT_SETTINGS, today: businessToday() },
          userId: input.userId,
          chat: input.pending.chat,
          action: step.action,
          args: { ...step.args },
        }),
      );
      ran = prepared.ok
        ? await runOne({ userId: input.userId, pending: prepared.pending, e164: input.e164 }, { index: n, of: steps.length })
        : { ok: false, reason: prepared.reason };
    } catch (error) {
      ran = { ok: false, reason: wordsOf(error) };
    }
    if (ran.ok) {
      done += 1;
      lines.push(`${n}. ✓ ${ran.said}`);
    } else {
      stoppedAt = n;
      lines.push(`${n}. ✗ refused — ${ran.reason}`);
    }
  }

  const report = [
    stoppedAt === 0 ? `The plan is done: all ${steps.length} steps ran.` : `The plan stopped at step ${stoppedAt} of ${steps.length}: ${done} done, ${steps.length - done} not.`,
    ...lines,
    stoppedAt === 0
      ? ''
      : done > 0
        ? 'The steps marked ✓ are done and stay done — nothing was rolled back. What is left can be proposed again once the refusal is dealt with.'
        : 'Nothing was changed.',
  ]
    .filter((part) => part !== '')
    .join(NL);

  // The plan's own line in the trail, beside the one each step wrote: one yes, this many steps.
  await withScope({ ...scope, branchCode: input.pending.target.branchCode ?? branchCode }, (tx) =>
    auditDone(tx, input, stoppedAt === 0 ? 'success' : 'denied', report),
  ).catch(() => {
    /* each step has its own row; the summary must not hide the report */
  });
  return stoppedAt === 0 ? { ok: true, said: report } : { ok: false, reason: report };
}

async function perform(tx: Tx, principal: Principal, branchCode: string, pending: PendingAction): Promise<string> {
  // A plan is run step by step (`runPlan`), never as one thing. Said here
  // because what follows ends in a default, and a plan must not fall into it.
  if (pending.action === 'run_plan') throw new Error('A plan runs one step at a time; it is not a step of its own.');

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

  if (pending.action === 'create_draft') {
    if (!pending.draft) throw new Error('There is no draft to save.');
    return runDraft(tx, { principal, branchCode }, pending.draft);
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

  // `post: true` is what the screen's own Approve sends: without it the stock came in and the ledger never heard of it.
  const result = await openingStockService.approve(tx, { principal, branchCode }, pending.target.id, { post: true });
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
  part?: PlanPart,
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
      ...(input.pending.draft ? { draft: { kind: input.pending.draft.kind, date: input.pending.draft.date, party: input.pending.draft.party?.code ?? null, lines: input.pending.draft.lines.length } } : {}),
      ...(input.pending.plan ? { plan: input.pending.plan.map((step) => ({ action: step.action, ...step.args })) } : {}),
      ...(part ? { planStep: `${part.index} of ${part.of}` } : {}),
      proposedAt: input.pending.proposedAt,
      confirmed: true,
      detail: detail.slice(0, 500),
    },
  });
}

// ---------------------------------------------------------------------------
// Preview — 2026-10-05
// ---------------------------------------------------------------------------
//
// By direction: "what will posting INV-… do? He runs the posting for real and
// immediately undoes it, then shows the exact journal lines and stock
// movements it would write. No more guessing."
//
// The step is not described from a reading of the code: it is RUN — the same
// `perform` a yes would run, as the same person, under the same scope — in a
// transaction that is always rolled back, and what that transaction wrote is
// read back out of it before it goes. Four things make "nothing was changed"
// true rather than hoped for:
//
//   1. Numbers. A document number comes from a PostgreSQL sequence, and a
//      sequence does not roll back: a rehearsed posting would spend a real
//      JE-… number and leave a gap in the series (§14.2, §24). So a rehearsal
//      never reaches the sequence. `numbersWithheld` answers the one statement
//      that draws a number (`numbering.allocateDocumentNumber`'s call of
//      `next_document_serial`) with a stand-in far above anything issued, and
//      refuses outright any other statement that names a sequence. The
//      stand-in is rolled back with everything else and is never shown.
//   2. A refused right. `authz.authorize` writes its refusal on a connection
//      of its own, on purpose (§25) — which a rollback here cannot reach. So
//      the principal a rehearsal runs as stops at exactly that moment
//      (`rehearsalPrincipal`): the refusal is reported, and not written down
//      as an attempt nobody made.
//   3. What is checked at commit. The rules PostgreSQL holds until the end of
//      a transaction (stock never below nothing, a journal that balances, a
//      bank never below nothing) are called in before the rollback, so a step
//      the commit would refuse is reported as refused.
//   4. Everything else a step raises — notifications, the delivery queue's
//      outbox rows, audit rows — is rows in this transaction, delivered later
//      from what was committed. Rolled back, nothing is sent.
//
// What a rehearsal does leave: the surrogate ids it drew (audit_event.id and
// the like — counters with no meaning, which every failed transaction also
// spends), and one audit row saying that a preview was given.

/** What can be previewed: a step on a document that exists. */
const PREVIEWABLE: readonly ActionName[] = ['document_step', 'approve_opening_stock', 'approve_document', 'reject_document', 'approve_partner'];

/** No list in a preview runs longer than this. */
const PREVIEW_CAP = 40;

/** Thrown, privately, at the end of a rehearsal that ran: the only way out of its transaction is a rollback. */
class Undone extends Error {
  constructor(readonly seen: Seen) {
    super('a preview is always rolled back');
  }
}

/** Thrown where a refused right was about to be written down on a second connection. */
class RightRefused extends Error {
  constructor(readonly missing: { readonly test?: (grant: Grant) => boolean; readonly branchCode?: string }) {
    super('a right this step asks for is not held');
  }
}

/**
 * The transaction a rehearsal's step runs in: the real one, with the
 * sequences out of reach.
 *
 * Every write goes to the real transaction untouched. The one thing answered
 * here instead is the drawing of a document number, because `nextval` is the
 * one thing in a transaction a rollback does not undo. The stand-in serials
 * start far above any series (nine thousand million and a random offset), so
 * a rehearsal's row in `doc_number_allocation` can never meet a real one — no
 * real posting waits on it, and none is refused because of it. Savepoints the
 * services open are wrapped the same way.
 */
function numbersWithheld(real: Tx): Tx {
  const dialect = new PgDialect();
  let next = 9_000_000_000n + BigInt(Math.floor(Math.random() * 900_000_000));
  const wrap = (tx: Tx): Tx =>
    new Proxy(tx, {
      get(target, key) {
        if (key === 'execute') {
          return (query: SQLWrapper | string) => {
            const text = typeof query === 'string' ? query : dialect.sqlToQuery(query.getSQL()).sql;
            if (/\bnext_document_serial\s*\(/i.test(text)) {
              const serial = next;
              next += 1n;
              return Promise.resolve({ rows: [{ serial: serial.toString() }], rowCount: 1 });
            }
            if (/\b(nextval|setval)\s*\(/i.test(text)) {
              return Promise.reject(new Error('This step draws from a sequence in a way a preview cannot hold back, so it is not rehearsed.'));
            }
            return target.execute(query as never);
          };
        }
        if (key === 'transaction') {
          return (fn: (inner: Tx) => Promise<unknown>, config?: unknown) =>
            (target.transaction as (run: (inner: Tx) => Promise<unknown>, config?: unknown) => Promise<unknown>)((inner) => fn(wrap(inner)), config);
        }
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
  return wrap(real);
}

/**
 * The person, as a rehearsal runs as them: every right answered truthfully,
 * and a refusal stopped before it is written down.
 *
 * `authz.authorize` records a refused right on a connection of its own and
 * then throws. In a rehearsal that record would be the one thing left behind
 * — a security event for an attempt nobody made. It cannot be told not to
 * from here, so it is caught in the act: `authorize` asks `can` (or
 * `canAccessBranch`), is told no, and the very next things it reads of the
 * principal, without a pause, are `userId`, `isSuperUser`, `userId` — the
 * scope and the actor of the row it is about to write. On the third the
 * rehearsal ends, with what was missing in hand.
 *
 * A right that is only *consulted* (may this person override a soft-closed
 * period? may they post directly?) is answered no and nothing more: the
 * pattern is `authorize`'s alone. Should `authorize` ever be rewritten so it
 * no longer fits, nothing is hidden and nothing is wrong — the refusal is
 * reported as before and its row is written; `wa19-preview-plans.test.ts`
 * holds that it is not.
 */
function rehearsalPrincipal(principal: Principal): Principal {
  let missing: RightRefused['missing'] = {};
  let step = 0; // 1: a right was just found missing · 2: then userId was read · 3: then isSuperUser
  let turn = 0;
  const missed = (what: RightRefused['missing']) => {
    missing = what;
    step = 1;
    const mine = (turn += 1);
    // The pattern is three reads in one breath. A read after any pause is somebody else's.
    queueMicrotask(() => {
      if (turn === mine) step = 0;
    });
  };
  const grants = Object.assign([...principal.grants], {
    some: (test: (grant: Grant, index: number, all: Grant[]) => unknown) => {
      const held = principal.grants.some((grant, index, all) => Boolean(test(grant, index, all as Grant[])));
      if (!held) missed({ test: (grant) => Boolean(test(grant, 0, [grant])) });
      return held;
    },
  });
  const branchCodes = Object.assign([...principal.branchCodes], {
    includes: (code: string) => {
      const held = principal.branchCodes.includes(code);
      if (!held) missed({ branchCode: code });
      return held;
    },
  });
  return new Proxy(principal, {
    get(target, key) {
      if (key === 'grants') return grants;
      if (key === 'branchCodes') return branchCodes;
      if (key === 'userId') {
        if (step === 3) throw new RightRefused(missing);
        step = step === 1 ? 2 : 0;
      } else if (key === 'isSuperUser') {
        step = step === 2 ? 3 : 0;
      } else {
        step = 0;
      }
      return Reflect.get(target, key, target);
    },
  });
}

/** The refusal `authorize` would have thrown, in its own words. */
async function refusedRight(scope: { userId: string; branchCode: string; isSuperUser: boolean }, missing: RightRefused['missing']): Promise<string> {
  if (missing.branchCode !== undefined) return new ScopeDeniedError(scope.userId, missing.branchCode).message;
  const test = missing.test;
  if (test) {
    // Which right it was is known only as a question ("is this the one?"), so
    // it is put to every object a role is granted anything on.
    const objects = await withReadOnlyScope(scope, (tx) => tx.execute(sql`select distinct object from role_grant order by object`)).catch(() => ({ rows: [] }));
    for (const row of objects.rows as { object: string }[]) {
      for (const verb of PERMISSION_VERBS) {
        if (test({ verb, object: row.object })) return new PermissionDeniedError(scope.userId, verb, row.object).message;
      }
    }
  }
  return 'Permission denied: a permission this step asks for is not granted to this user.';
}

/** Where a previewed document's own row is, to read it before and after. */
function rowOf(pending: PendingAction): { readonly table: string; readonly id: string } | null {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pending.target.id)) return null;
  if (pending.action === 'approve_partner') return { table: 'business_partner', id: pending.target.id };
  const family = DOCUMENT_FAMILIES.find((candidate) => candidate.key === pending.target.kind);
  return family ? { table: WHERE[family.key].table, id: pending.target.id } : null;
}

/** A row, every column as PostgreSQL writes it — figures stay exact, nothing becomes a floating-point number. */
async function rowAsText(tx: Tx, at: { readonly table: string; readonly id: string } | null): Promise<Record<string, string | null> | null> {
  if (!at) return null;
  const result = await tx.execute(sql`
    select (select jsonb_object_agg(e.key, e.value #>> '{}') from jsonb_each(to_jsonb(t)) e) as doc
      from ${sql.identifier(at.table)} t
     where t.id = ${at.id}::uuid`);
  return ((result.rows[0] as { doc: Record<string, string | null> } | undefined)?.doc ?? null) as Record<string, string | null> | null;
}

/** What a rehearsal saw before it was undone. */
interface Seen {
  readonly body: readonly string[];
  /** The stand-in numbers it was handed, so that none is ever shown as a real one. */
  readonly standIns: readonly string[];
  readonly journals: number;
  readonly movements: number;
}

const amountOf = (text: string | null | undefined) => money(String(text ?? '0').replace('-', ''));
const isNothing = (text: string | null | undefined) => !/[1-9]/.test(String(text ?? ''));
const isMinus = (text: string | null | undefined) => String(text ?? '').trim().startsWith('-');
const more = (shown: number, total: number, what: string) => (total > shown ? [`  … and ${total - shown} more ${what}`] : []);

/**
 * What this transaction wrote, read from inside it.
 *
 * "Written by this transaction" is PostgreSQL's own record, not a guess from
 * dates or document numbers: every row version carries the transaction that
 * made it (`xmin`), and a row this transaction can see whose maker has not
 * finished can only be its own — its own work, or a savepoint's inside it,
 * which is why the test is "still in progress" and not "equal to my id".
 * (`age(xmin) <= 0` keeps the question to rows made since this transaction
 * began, so nothing older is ever asked about.) A row it changed counts as
 * well as a row it made — that is how a journal that was waiting and is now
 * posted is found.
 */
async function whatItWrote(tx: Tx, pending: PendingAction, before: Record<string, string | null> | null, said: string): Promise<Seen> {
  const at = rowOf(pending);
  const after = await rowAsText(tx, at);

  const marked = await tx.execute(sql`select ((pg_current_xact_id()::text::bigint / 4294967296) * 4294967296)::text as epoch`);
  const epoch = (marked.rows[0] as { epoch: string }).epoch;
  const mine = (alias: string) =>
    sql`(case when age(${sql.raw(alias)}.xmin) <= 0 then txid_status(${epoch}::bigint + ${sql.raw(alias)}.xmin::text::bigint) = 'in progress' else false end)`;

  const body: string[] = [];

  // ── the document itself ────────────────────────────────────────────────
  const was = before?.status ?? null;
  const is = after?.status ?? null;
  if (is !== null) {
    body.push(was === is ? `${pending.target.documentNo}: stays ${is.replace(/_/g, ' ')}` : `${pending.target.documentNo}: ${String(was ?? '—').replace(/_/g, ' ')} → ${is.replace(/_/g, ' ')}`);
  }
  if (before && after) {
    const figures: string[] = [];
    for (const key of Object.keys(after).sort()) {
      if (key === 'status' || before[key] === after[key]) continue;
      if (key.endsWith('_status')) figures.push(`${key.replace(/_/g, ' ')}: ${String(before[key] ?? '—').replace(/_/g, ' ')} → ${String(after[key] ?? '—').replace(/_/g, ' ')}`);
      else if (/(_iqd|_usd|_txn|_amount|_total|_qty|_quantity)$|^(amount|total|quantity)/.test(key) && /^-?\d/.test(String(after[key] ?? before[key] ?? ''))) {
        figures.push(`${key.replace(/_/g, ' ')}: ${money(before[key] ?? '0')} → ${money(after[key] ?? '0')}`);
      }
    }
    if (figures.length > 0) body.push(`on the document: ${figures.slice(0, PREVIEW_CAP).join(' · ')}`);
  }

  // ── numbers handed out by the stand-in ─────────────────────────────────
  const drawn = await tx.execute(sql`select a.document_no from doc_number_allocation a where ${mine('a')}`);
  const standIns = (drawn.rows as { document_no: string }[]).map((row) => row.document_no);

  // ── journals ───────────────────────────────────────────────────────────
  const entries = (
    await tx.execute(sql`
      select e.id::text as id, e.entry_no, coalesce(e.description, '') as description, e.status::text as status,
             e.posting_date::text as posting_date, e.total_debit_iqd::text as debit, e.total_credit_iqd::text as credit
        from journal_entry e
       where ${mine('e')}
       order by e.created_at, e.entry_no
       limit ${PREVIEW_CAP + 1}`)
  ).rows as { id: string; entry_no: string; description: string; status: string; posting_date: string; debit: string; credit: string }[];
  // A journal this step would WRITE carries a number drawn in this
  // transaction. One it would only move on (a journal waiting for approval,
  // the journal a reversal mirrors) had its number already.
  const written = entries.filter((entry) => standIns.includes(entry.entry_no));
  const moved = entries.filter((entry) => !standIns.includes(entry.entry_no));
  const posted = moved.filter((entry) => entry.status === 'posted' && entry.id === pending.target.id && was !== 'posted');
  const inEffect = [...written, ...posted].slice(0, PREVIEW_CAP);

  if (inEffect.length > 0) {
    const ids = sql.join(
      inEffect.map((entry) => sql`${entry.id}::uuid`),
      sql`, `,
    );
    const lines = (
      await tx.execute(sql`
        select x.entry_id, x.side, x.amount, x.code, x.name, x.partner, x.warehouse, x.bank, x.total
          from (select l.journal_entry_id::text as entry_id, l.line_no,
                       case when l.debit_iqd > 0 then 'Dr' else 'Cr' end as side,
                       (case when l.debit_iqd > 0 then l.debit_iqd else l.credit_iqd end)::text as amount,
                       a.code, a.name, l.business_partner_code as partner, l.warehouse_code as warehouse, l.bank_account_code as bank,
                       row_number() over (partition by l.journal_entry_id order by l.line_no) as rn,
                       (count(*) over (partition by l.journal_entry_id))::int as total
                  from journal_line l
                  join chart_of_account a on a.id = l.account_id
                 where l.journal_entry_id in (${ids})) x
         where x.rn <= ${PREVIEW_CAP}
         order by x.entry_id, x.line_no`)
    ).rows as { entry_id: string; side: string; amount: string; code: string; name: string; partner: string | null; warehouse: string | null; bank: string | null; total: number }[];
    for (const entry of inEffect) {
      const own = lines.filter((line) => line.entry_id === entry.id);
      const isNew = written.includes(entry);
      body.push('');
      body.push(
        `${isNew ? 'JOURNAL it would write' : 'JOURNAL it would post'} — ${isNew ? 'a new journal entry, numbered when it really posts' : entry.entry_no}${entry.description ? ` · ${entry.description}` : ''} · dated ${entry.posting_date} · ${entry.status}`,
      );
      for (const line of own) {
        body.push(`  ${line.side} ${money(line.amount)} — ${line.code} · ${line.name}${[line.partner, line.bank, line.warehouse].filter(Boolean).map((part) => ` · ${part}`).join('')}`);
      }
      body.push(...more(own.length, own[0]?.total ?? own.length, 'line(s)'));
      body.push(`  totals: Dr ${money(entry.debit)} ${entry.debit === entry.credit ? '=' : '≠'} Cr ${money(entry.credit)} IQD`);
    }
  }
  for (const entry of moved.filter((one) => !posted.includes(one)).slice(0, PREVIEW_CAP)) {
    if (entry.id === pending.target.id) continue; // its status is the first line
    body.push(`journal ${entry.entry_no}, already on the books, would be ${entry.status.replace(/_/g, ' ')}`);
  }
  if (entries.length > PREVIEW_CAP) body.push(`  … and more journals than the ${PREVIEW_CAP} shown`);
  if (inEffect.length === 0) body.push('', 'JOURNAL: it would write none.');

  // ── stock ──────────────────────────────────────────────────────────────
  const movements = (
    await tx.execute(sql`
      select m.kind::text as kind, m.item_code, coalesce(i.name, '') as item_name, m.warehouse_code, m.quantity::text as quantity,
             (count(*) over ())::int as total
        from inventory_movement m
        left join item i on i.code = m.item_code
       where ${mine('m')}
       order by m.created_at, m.item_code, m.id
       limit ${PREVIEW_CAP}`)
  ).rows as { kind: string; item_code: string; item_name: string; warehouse_code: string; quantity: string; total: number }[];
  const positions = (
    await tx.execute(sql`
      select p.item_code, p.warehouse_code, p.delta::text as delta,
             (select coalesce(sum(s.held), 0)::text from stock_position s where s.item_code = p.item_code and s.warehouse_code = p.warehouse_code) as held
        from (select m.item_code, m.warehouse_code, sum(m.quantity) as delta
                from inventory_movement m
               where ${mine('m')}
               group by m.item_code, m.warehouse_code) p
       order by p.item_code, p.warehouse_code
       limit ${PREVIEW_CAP}`)
  ).rows as { item_code: string; warehouse_code: string; delta: string; held: string }[];
  body.push('');
  if (movements.length === 0) body.push('STOCK: it would move none.');
  else {
    body.push('STOCK it would move');
    for (const movement of movements) {
      const out = isMinus(movement.quantity);
      body.push(
        `  ${movement.kind.replace(/_/g, ' ')}: ${out ? '−' : '+'}${quantity(movement.quantity.replace('-', ''))} ${movement.item_code}${movement.item_name ? ` · ${movement.item_name}` : ''} ${out ? 'out of' : 'into'} ${movement.warehouse_code}`,
      );
    }
    body.push(...more(movements.length, movements[0]?.total ?? movements.length, 'movement(s)'));
    const layers = (
      await tx.execute(sql`
        select (count(*) filter (where z.opened))::int as opened,
               coalesce(sum(z.value) filter (where z.opened), 0)::text as opened_value
          from (select coalesce(c.original_value_iqd, c.original_quantity * c.unit_cost_iqd) as value,
                       exists (select 1 from inventory_movement m where m.id = c.created_by_movement_id and ${mine('m')}) as opened
                  from cost_layer c
                 where ${mine('c')}) z`)
    ).rows[0] as { opened: number; opened_value: string };
    const taken = (
      await tx.execute(sql`
        select count(distinct k.layer_id)::int as layers, coalesce(sum(k.quantity), 0)::text as quantity, coalesce(sum(k.cost_iqd), 0)::text as cost
          from cost_layer_consumption k
         where ${mine('k')}`)
    ).rows[0] as { layers: number; quantity: string; cost: string };
    if (layers.opened > 0) body.push(`  cost: it would open ${layers.opened} FIFO cost layer(s) worth ${money(layers.opened_value)} IQD`);
    if (taken.layers > 0) body.push(`  cost: it would take ${quantity(taken.quantity)} from ${taken.layers} FIFO cost layer(s) — ${money(taken.cost)} IQD at cost`);
  }

  // ── what would be sent ─────────────────────────────────────────────────
  const raised = (
    await tx.execute(sql`
      select (select count(*) from notification n where ${mine('n')})::int as own,
             (select count(distinct d.notification_id) from notification_delivery d where ${mine('d')})::int as queued`)
  ).rows[0] as { own: number; queued: number };
  // A notification is read by the person it is for, so its row is not this
  // person's to see; its delivery rows are counted instead.
  body.push('', `notifications it would raise: ${Math.max(raised.own, raised.queued)}`);

  // ── what it would mean ─────────────────────────────────────────────────
  const meaning: string[] = [];
  if (inEffect.length > 0) {
    const ids = sql.join(
      inEffect.map((entry) => sql`${entry.id}::uuid`),
      sql`, `,
    );
    const effects = (
      await tx.execute(sql`
        select coalesce(a.control_account::text, '') as control, coalesce(l.business_partner_code, '') as partner, coalesce(l.bank_account_code, '') as bank,
               sum(l.debit_iqd - l.credit_iqd)::text as net
          from journal_line l
          join chart_of_account a on a.id = l.account_id
         where l.journal_entry_id in (${ids})
           and (a.control_account::text in ('customer', 'supplier') or l.bank_account_code is not null)
         group by 1, 2, 3
         order by 1, 2, 3
         limit 12`)
    ).rows as { control: string; partner: string; bank: string; net: string }[];
    for (const effect of effects) {
      if (isNothing(effect.net)) continue;
      const amount = `${amountOf(effect.net)} IQD`;
      if (effect.bank) meaning.push(isMinus(effect.net) ? `${amount} would leave ${effect.bank}` : `${amount} would come into ${effect.bank}`);
      else if (effect.control === 'customer') meaning.push(`customer ${effect.partner || '(not named)'} would owe ${amount} ${isMinus(effect.net) ? 'less' : 'more'}`);
      else if (effect.control === 'supplier') meaning.push(`the company would owe supplier ${effect.partner || '(not named)'} ${amount} ${isMinus(effect.net) ? 'more' : 'less'}`);
    }
  }
  for (const position of positions) {
    if (isNothing(position.delta)) continue;
    const moved = quantity(position.delta.replace('-', ''));
    meaning.push(
      isMinus(position.delta)
        ? `${moved} of ${position.item_code} would leave ${position.warehouse_code}, leaving ${quantity(position.held)}`
        : `${moved} of ${position.item_code} would come into ${position.warehouse_code}, making ${quantity(position.held)}`,
    );
  }
  body.push(meaning.length > 0 ? `What it would mean: ${meaning.join('; ')}.` : `What it would mean: ${said}`);

  return { body, standIns, journals: inEffect.length, movements: movements.length };
}

/**
 * The `preview` tool: what a step WOULD do, found out by doing it and undoing it.
 *
 * Returns text for the model. It begins with what happened to the books —
 * nothing — and then what would: the document's status before and after, the
 * journal line by line, the stock, how many notifications, and one line on
 * what it would mean. A step the system would refuse is reported as refused,
 * in the service's own sentence.
 */
export async function preview(input: {
  readonly ctx: ReadContext;
  readonly userId: string;
  readonly chat: string;
  readonly action: string;
  readonly args: Record<string, unknown>;
}): Promise<string> {
  registerAllRecords();
  const action = input.action as ActionName;
  if (!PREVIEWABLE.includes(action)) {
    const why =
      action === 'create_draft'
        ? 'A draft posts nothing and moves no stock, so there is nothing to rehearse: propose it and its lines are read back before anything is saved.'
        : action === 'create_partner'
          ? 'Creating a customer or supplier writes no journal and moves no stock.'
          : action === 'run_plan'
            ? 'Preview the steps of a plan one at a time.'
            : `What can be previewed: ${PREVIEWABLE.join(', ')}.`;
    return `PREVIEW — not available for this, and nothing was changed: a preview is of a step on a document that exists. ${why}`;
  }

  // Exactly as a proposal would be prepared: what cannot be proposed cannot be previewed, for the same reason.
  const prepared = await prepare({ ctx: input.ctx, userId: input.userId, chat: input.chat, action, args: input.args });
  if (!prepared.ok) return `PREVIEW — not run, and nothing was changed: ${prepared.reason}`;
  const pending = prepared.pending;

  // The scope `run` builds, for the same person.
  const principal: Principal = await principalOf(input.userId);
  if (!principal.isActive) return 'PREVIEW — not run, and nothing was changed: this user is deactivated.';
  const branchCode = pending.target.branchCode ?? principal.defaultBranchCode ?? '';
  const scope = { userId: input.userId, branchCode, isSuperUser: principal.isSuperUser };

  let text: string;
  let outcome: 'would_succeed' | 'would_be_refused' | 'not_run';
  let reading = false;
  let wrote: { readonly journals: number; readonly movements: number } | null = null;
  try {
    await withScope(scope, async (real): Promise<never> => {
      // Its locks are for this call only: it does not queue behind somebody's
      // real posting for long, and it cannot sit on a document if this process stalls.
      await real.execute(sql`set local lock_timeout = '5s'`);
      await real.execute(sql`set local statement_timeout = '30s'`);
      await real.execute(sql`set local idle_in_transaction_session_timeout = '30s'`);
      const before = await rowAsText(real, rowOf(pending));
      const said = await perform(numbersWithheld(real), rehearsalPrincipal(principal), branchCode, pending);
      // What PostgreSQL would only check at commit, checked now — there will be no commit.
      await real.execute(sql`set constraints all immediate`);
      reading = true;
      throw new Undone(await whatItWrote(real, pending, before, said));
    });
    // Not reachable: the transaction above ends in a throw whatever happens.
    throw new Error('a preview transaction ended without being rolled back');
  } catch (error) {
    const code = pgCodeOf(error);
    if (error instanceof Undone) {
      outcome = 'would_succeed';
      wrote = { journals: error.seen.journals, movements: error.seen.movements };
      text = [
        `PREVIEW — nothing was changed. This is what "${actionLabel(pending.action, pending.step)}" on ${pending.target.documentNo} would do if they said yes now:`,
        ...error.seen.body,
        'None of this exists: it was run, read and undone. To do it, propose the step (propose_action) and let them say yes.',
      ].join(NL);
      // A stand-in number is nobody's number.
      for (const standIn of error.seen.standIns) text = text.split(standIn).join('(a new number)');
    } else if (error instanceof RightRefused) {
      outcome = 'would_be_refused';
      text = ['PREVIEW — it would be REFUSED, and nothing was changed:', await refusedRight(scope, error.missing)].join(NL);
    } else if (reading) {
      outcome = 'not_run';
      text = `PREVIEW — the step itself went through in rehearsal, but what it wrote could not be read back (${wordsOf(error)}). Nothing was changed.`;
    } else if (['55P03', '57014', '40P01', '40001', '25P03'].includes(code) || (code === '23505' && /doc_number_allocation/.test(wordsOf(error)))) {
      // A lock it would not wait for, a statement over its time, a deadlock it
      // lost: none of them says anything about the step.
      outcome = 'not_run';
      text =
        code === '57014' || code === '25P03'
          ? 'PREVIEW — could not be finished: the step took longer than a rehearsal is given. Nothing was changed; that says nothing about whether the step itself would go through.'
          : 'PREVIEW — could not be run just now: somebody else is working on that document, and a rehearsal does not wait behind real work. Nothing was changed; ask again in a moment.';
    } else {
      outcome = 'would_be_refused';
      text = ['PREVIEW — it would be REFUSED, and nothing was changed:', wordsOf(error)].join(NL);
    }
  }

  // The one thing a preview leaves: a row saying it was given. In its own
  // transaction, because the rehearsal's has gone.
  await withScope(scope, (tx) =>
    audit.record(tx, {
      actorUserId: input.userId,
      action: 'whatsapp.preview',
      objectType: pending.target.kind,
      objectId: pending.target.id || pending.target.documentNo,
      branchCode: pending.target.branchCode,
      outcome: 'success',
      after: {
        action: pending.action,
        step: pending.step ?? null,
        outcome,
        documentNo: pending.target.documentNo,
        chat: input.chat,
        what: actionLabel(pending.action, pending.step),
        rehearsal: true,
        ...(wrote ? { wouldWrite: wrote } : {}),
        detail: text.slice(0, 500),
      },
    }),
  ).catch(() => {
    /* the preview is the answer; a failed audit of it must not hide it */
  });
  return text;
}
