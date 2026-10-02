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
 */

/** What Noah may propose. Every one of these runs through its own service. */
export type ActionName = 'approve_document' | 'reject_document' | 'approve_opening_stock';

export const ACTION_NAMES: readonly ActionName[] = ['approve_document', 'reject_document', 'approve_opening_stock'];

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
export function actionLabel(action: ActionName): string {
  if (action === 'approve_document') return 'approve the document';
  if (action === 'reject_document') return 'reject the document';
  return 'approve the opening stock';
}
