/**
 * Doing something, from chat — REQ-WA-001 WA-8.
 *
 * By direction (2026-10-02): "i waanted to also run action every action and
 * making sure first when you say do that action are you sure waanted to do
 * that action". So Noah may now change the books — and the shape of that
 * permission is the whole of this file.
 *
 * **He proposes; a person confirms; the ERP decides.** Three parties, and no
 * two of them are the same:
 *
 *   1. Noah works out what should happen and says it out loud, in figures: the
 *      document, the warehouse, the amount, and what it will do that cannot
 *      be undone. Then he asks. He cannot act on his own reading of a
 *      sentence, which matters because an inbound WhatsApp message is
 *      untrusted text (W-R2) and a forwarded screenshot is not consent.
 *   2. The person answers yes. Only a plain yes: a sentence that merely
 *      contains the word is a new question, and the proposal is dropped
 *      rather than guessed at. Ten minutes, then it has gone stale.
 *   3. The action runs through the ERP's own service as that person, so the
 *      approval engine, the maker-checker rule, the branch scope and the
 *      open period refuse exactly as they do on the screen. Nothing here
 *      grants anything: it opens a door to rights the person already has, and
 *      a refusal comes back in the service's own words.
 *
 * `whatsapp_contact.allow_actions` gates the door itself — off until an
 * administrator turns it on for one person — and the bridge simply does not
 * offer the tool to anybody else.
 *
 * The typed form (`approve PAYAPP-…` and a six-digit code, WA-6) is still
 * there and unchanged. That one is for a person who knows exactly what they
 * want; this one is for a conversation.
 *
 * ── Widened, 2026-10-04 ────────────────────────────────────────────────────
 * By direction, for the testing phase: "help them doing actions … everything
 * related in the system they can do". Three more kinds of proposal, all on the
 * same three-party rule and all through the document's own service:
 *
 *   * `document_step` — move a document one step along its own life by its
 *     number: submit, approve, reject, post, reverse or cancel, for the
 *     families in `DOCUMENT_FAMILIES`. Which steps a family has is the list of
 *     verbs its service exports; whether *this* person may take one is the
 *     service's answer when it runs.
 *   * `create_partner` — a new customer or supplier, by name.
 *   * `approve_partner` — a prospect made usable (§6).
 *
 * And, the same day ("draft maker"): `create_draft` — a journal entry, a
 * purchase invoice or a sales invoice keyed from what the person said and
 * saved as a DRAFT (`services/whatsapp-drafts.ts`). A draft posts nothing and
 * moves no stock; the steps after it — submit, approve, post — stay separate
 * proposals, each with its own yes.
 *
 * What stays on the screens: every other document with lines to type. Noah
 * says where the screen is and what each field wants (`domain/system-guide.ts`).
 *
 * ── Plans, 2026-10-05 ──────────────────────────────────────────────────────
 * By direction ("bring in the stock and post the invoice — he lays out the
 * steps in order, you approve, and he runs them one at a time"): `run_plan` is
 * two to five of the steps above put to the person as ONE numbered proposal.
 * One yes confirms the plan; each step then runs exactly as it would alone —
 * prepared again at its own moment, its own transaction, its own audit row —
 * and the plan stops at the first step the system refuses. A step that ran
 * stays done: a plan is a list of ordinary actions, not one big transaction.
 * No plan inside a plan, and no draft in one (a draft's lines are a proposal
 * of their own to read).
 */

/** What Noah may propose. Every one of these runs through its own service. */
export type ActionName =
  | 'approve_document'
  | 'reject_document'
  | 'approve_opening_stock'
  | 'document_step'
  | 'create_partner'
  | 'approve_partner'
  | 'create_draft'
  | 'run_plan';

export const ACTION_NAMES: readonly ActionName[] = [
  'approve_document',
  'reject_document',
  'approve_opening_stock',
  'document_step',
  'create_partner',
  'approve_partner',
  'create_draft',
  'run_plan',
];

/** What a plan may be made of: steps on what already exists, and a new partner. */
export const PLAN_STEP_ACTIONS = [
  'document_step',
  'approve_opening_stock',
  'approve_document',
  'reject_document',
  'approve_partner',
  'create_partner',
] as const satisfies readonly ActionName[];

/** A plan is worth the name from two steps, and still readable in one message at five. */
export const PLAN_MIN_STEPS = 2;
export const PLAN_MAX_STEPS = 5;

/**
 * One step of a plan, as it was put to the person.
 *
 * It keeps what was ASKED (`args`), not what was resolved: a step is prepared
 * again when its turn comes, because the step before it has changed the books
 * by then — an opening stock that was submitted is approved, an invoice that
 * was approved is posted.
 */
export interface PlanStep {
  readonly action: ActionName;
  readonly args: Readonly<Record<string, unknown>>;
  /** The step's own facts, as they stood when the plan was proposed. */
  readonly sentence: string;
}

/**
 * The documents Noah will key as a draft from what he was told ("draft
 * maker", 2026-10-04). A draft posts nothing and moves no stock: it is the
 * form filled in, waiting on its own page to be read and changed.
 */
export const DRAFT_KINDS = ['journal_entry', 'purchase_invoice', 'sales_invoice'] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];

/** One line of a draft, resolved while proposing: every code is a real record. */
export interface DraftLine {
  readonly item?: string;
  readonly itemName?: string;
  readonly quantity?: string;
  readonly unitPrice?: string;
  readonly discount?: string;
  readonly warehouse?: string;
  readonly account?: string;
  readonly accountId?: string;
  readonly accountName?: string;
  readonly debit?: string;
  readonly credit?: string;
  readonly department?: string;
  readonly description?: string;
}

/** A draft as it will be saved: what the person was shown, and nothing else. */
export interface DraftPayload {
  readonly kind: DraftKind;
  readonly date: string;
  readonly dueDate?: string | null;
  readonly currency: string;
  readonly isImport?: boolean;
  readonly description?: string | null;
  readonly party?: { readonly id: string; readonly code: string; readonly name: string } | null;
  /** A purchase invoice: the number the supplier printed on their own invoice. */
  readonly supplierInvoiceNo?: string | null;
  readonly lines: readonly DraftLine[];
}

/** One step along a document's life. */
export const DOCUMENT_STEPS = ['submit', 'approve', 'reject', 'post', 'reverse', 'cancel'] as const;
export type DocumentStep = (typeof DOCUMENT_STEPS)[number];

/** The steps that are refused without a reason, as on the screens. */
export const STEPS_NEEDING_REASON: readonly DocumentStep[] = ['reject', 'reverse', 'cancel'];

/**
 * The documents a step may be proposed for, by the prefix of their number,
 * and the steps each one's service has.
 *
 * `approve` is listed only where the service approves directly. A family
 * without it (a purchase invoice) is approved through the approval inbox —
 * `approve_document` — which is where the approval engine routed it.
 */
export const DOCUMENT_FAMILIES = [
  { prefix: 'API', key: 'ap_invoice', label: 'purchase invoice', steps: ['submit', 'post', 'reverse'] },
  { prefix: 'INV', key: 'ar_invoice', label: 'sales invoice', steps: ['approve', 'post', 'reverse'] },
  { prefix: 'PO', key: 'purchase_order', label: 'purchase order', steps: ['submit', 'approve', 'cancel'] },
  { prefix: 'GRN', key: 'goods_receipt', label: 'goods receipt', steps: ['submit', 'post'] },
  { prefix: 'GRT', key: 'goods_return', label: 'purchase return', steps: ['approve', 'post'] },
  { prefix: 'PAY', key: 'supplier_payment', label: 'supplier payment', steps: ['post', 'reverse'] },
  { prefix: 'RCT', key: 'customer_receipt', label: 'customer receipt', steps: ['approve', 'post'] },
  { prefix: 'JE', key: 'journal_entry', label: 'journal entry', steps: ['submit', 'approve', 'reject', 'reverse'] },
  { prefix: 'BTR', key: 'bank_transfer', label: 'internal transfer', steps: ['approve', 'post'] },
  { prefix: 'OPN', key: 'opening_stock', label: 'opening stock', steps: ['submit', 'approve'] },
] as const satisfies readonly { readonly prefix: string; readonly key: string; readonly label: string; readonly steps: readonly DocumentStep[] }[];

export type DocumentFamily = (typeof DOCUMENT_FAMILIES)[number];

/** A number as people type it, tidied: upper case, no spaces. */
export function tidyNumber(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

/** Which family a number belongs to, by its prefix — `API-HQ-2026-000004` is a purchase invoice. */
export function familyOf(documentNo: string): DocumentFamily | null {
  const prefix = tidyNumber(documentNo).split('-')[0] ?? '';
  return DOCUMENT_FAMILIES.find((family) => family.prefix === prefix) ?? null;
}

/** What a step does that the person should hear before saying yes. */
export function stepConsequence(step: DocumentStep): string {
  switch (step) {
    case 'submit':
      return 'Submitting sends it for approval; from then on it is no longer a draft to edit.';
    case 'approve':
      return 'Approving lets it take effect or go on to posting. Whoever raised it cannot be the one who approves it.';
    case 'reject':
      return 'Rejecting sends it back to whoever raised it, with the reason.';
    case 'post':
      return 'Posting writes its journal — and moves the stock, where it carries goods. A posted document is never edited afterwards, only reversed.';
    case 'reverse':
      return 'Reversing mirrors its journal and puts back any stock it moved, dated today. It cannot be undone; the document would have to be raised again.';
    case 'cancel':
      return 'Cancelling closes it for good.';
  }
}

/** What the action will be done to, resolved while proposing. */
export interface ActionTarget {
  /** The document type code for the approval engine, or `opening_stock`. */
  readonly kind: string;
  readonly id: string;
  readonly documentNo: string;
  readonly branchCode: string | null;
}

/**
 * A proposal waiting for a yes.
 *
 * Held by the bridge in memory, not in the database. It is an intention for
 * the next few minutes and nothing has happened yet; a restart losing it is
 * correct — the right behaviour for a forgotten proposal is for nothing to
 * happen. What *did* happen is audited when it happens, and the sentence and
 * the yes are both in the message log either way.
 */
export interface PendingAction {
  readonly action: ActionName;
  readonly userId: string;
  /** The group (or number) it was proposed in: a yes belongs to its own chat. */
  readonly chat: string;
  readonly target: ActionTarget;
  readonly reason: string | null;
  /** `document_step` — which step. */
  readonly step?: DocumentStep | null;
  /** `create_partner` — what to create: `role`, `name`, and the optional contact details. */
  readonly payload?: Readonly<Record<string, string>> | null;
  /** `create_draft` — the document, line by line, as it was put to the person. */
  readonly draft?: DraftPayload | null;
  /** `run_plan` — the steps, in the order they run. `target` is the first step's. */
  readonly plan?: readonly PlanStep[] | null;
  /** The facts Noah must put to them before he asks. */
  readonly sentence: string;
  readonly proposedAt: string;
}

/** How long a proposal stands. Long enough to read it, short enough to mean now. */
export const CONFIRM_MINUTES = 10;

const YES = [
  'yes',
  'yes please',
  'yep',
  'yeah',
  'ok',
  'okay',
  'okey',
  'sure',
  'confirm',
  'confirmed',
  'go ahead',
  'do it',
  'do it please',
  'please do',
  'proceed',
  'agreed',
  'correct',
  'نعم',
  'اي',
  'ايه',
  'إي',
  'أجل',
  'اوكي',
  'أوكي',
  'موافق',
  'موافقة',
  'تم',
  'اكد',
  'أكد',
  'سوي',
  'سويها',
  'سوها',
  'تفضل',
  'زين',
  'اكمل',
];

const NO = [
  'no',
  'nope',
  'cancel',
  'stop',
  'not now',
  'later',
  'forget it',
  'never mind',
  'nevermind',
  "don't",
  'dont',
  'do not',
  'لا',
  'كلا',
  'لا تسوي',
  'الغي',
  'ألغي',
  'توقف',
  'مو هسه',
  'بعدين',
  'انسى',
];

/**
 * The message, stripped to the words that decide.
 *
 * Punctuation and the emoji people answer with go; the rest is lower-cased.
 * Arabic is left in its own script — it has no case to fold — with only its
 * tatweel and marks removed, so "موافق." and "موافق" are the same answer.
 */
function bare(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[ـً-ٟ]/g, '')
    .replace(/[.!?،؟…"'`*_~()\[\]{}]/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Is this a yes?
 *
 * Only if the whole message is one. "yes" is consent; "yes but what about the
 * Najaf one" is a question, and treating the word inside a sentence as a
 * signature is how a bot ends up posting something nobody asked for. A short
 * courtesy on the end is allowed — "yes please", "موافق شكرا" — and nothing
 * longer.
 */
export function isConfirmation(text: string): boolean {
  const said = bare(text);
  if (!said) return false;
  if (YES.includes(said)) return true;
  // A yes with a thank-you after it, and nothing else.
  const trailing = /^(.*?)\s+(please|thanks|thank you|شكرا|شكراً|من فضلك|رجاء|رجاءا)$/.exec(said);
  return trailing !== null && YES.includes(trailing[1] ?? '');
}

/** Is this a plain no? Anything else is simply a new question. */
export function isRefusal(text: string): boolean {
  const said = bare(text);
  return said !== '' && NO.includes(said);
}

/** Has the proposal gone stale? */
export function expired(pending: PendingAction, now: Date = new Date()): boolean {
  return now.getTime() - Date.parse(pending.proposedAt) > CONFIRM_MINUTES * 60_000;
}

/** What a proposal is called in the log and the audit trail. */
export function actionLabel(action: ActionName, step?: DocumentStep | null): string {
  if (action === 'approve_document') return 'approve the document';
  if (action === 'reject_document') return 'reject the document';
  if (action === 'approve_opening_stock') return 'approve the opening stock';
  if (action === 'document_step') return `${step ?? 'move'} the document`;
  if (action === 'create_partner') return 'create the partner';
  if (action === 'create_draft') return 'save the draft';
  if (action === 'run_plan') return 'run the plan';
  return 'approve the partner';
}
