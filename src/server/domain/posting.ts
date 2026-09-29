/**
 * Posting engine — Phase 02.7.
 *
 * §3.3: "Posting accounts shall be selected through configurable accounting
 * mappings, not hard-coded account numbers."
 * §24: "Posting must be atomic: either all journal/subledger/inventory records
 * commit, or none do." · "Each posting batch includes a deterministic source
 * reference to prevent duplicate posting."
 *
 * This module holds the part that can be decided without a database: which
 * account a posting line resolves to, and whether the answer is unambiguous.
 * Everything else — the transaction, the idempotency index, the failure queue —
 * belongs to the service.
 *
 * ── Why account determination is the whole design ───────────────────────────
 * A module that knows an account number has hard-coded an accounting decision,
 * and §28 says the implementation team does not get to make those. So a module
 * says what *happened* — "this is the revenue line of a sales invoice for a
 * wholesale customer" — and the mapping says which account that is. Changing
 * the mapping changes the accounting with no code change, which is the 02.7
 * gate stated exactly.
 */

/**
 * What a line *is*, in accounting terms, independent of which account holds it.
 *
 * A module names a role; the mapping resolves the account. These are the roles
 * Appendix C's posting matrix uses; more arrive with the modules that need
 * them, by configuration rather than by code.
 */
export type PostingLineRole = string;

/**
 * The criteria a mapping may discriminate on — §3.3: "transaction type,
 * item/service group, partner group, warehouse, project and other approved
 * criteria."
 *
 * Every one is optional on a rule. A rule that leaves a criterion unset matches
 * any value of it, so a chart can start with one rule per role and grow
 * exceptions without rewriting what is already there.
 */
export interface PostingCriteria {
  readonly itemGroup?: string | null;
  readonly partnerGroup?: string | null;
  readonly warehouseCode?: string | null;
  readonly projectCode?: string | null;
  readonly branchCode?: string | null;
}

export interface PostingRule extends PostingCriteria {
  readonly id: string;
  /** The business event, e.g. 'sales_invoice.posted'. */
  readonly eventType: string;
  readonly lineRole: PostingLineRole;
  readonly accountId: string;
  readonly accountCode: string;
  readonly isActive: boolean;
}

export class NoPostingRuleError extends Error {
  readonly code = 'NO_POSTING_RULE';

  constructor(
    readonly eventType: string,
    readonly lineRole: PostingLineRole,
    readonly criteria: PostingCriteria,
  ) {
    super(
      `No accounting mapping is configured for the '${lineRole}' line of '${eventType}'` +
        `${describeCriteria(criteria)}. ` +
        'Configure the mapping in Accounting Mapping — the posting cannot choose an account on its own (§3.3).',
    );
    this.name = 'NoPostingRuleError';
  }
}

export class AmbiguousPostingRuleError extends Error {
  readonly code = 'AMBIGUOUS_POSTING_RULE';

  constructor(
    readonly eventType: string,
    readonly lineRole: PostingLineRole,
    readonly candidates: readonly PostingRule[],
  ) {
    super(
      `More than one accounting mapping matches the '${lineRole}' line of '${eventType}' equally well: ` +
        `${candidates.map((c) => `${c.accountCode}`).join(', ')}. ` +
        'Make one of them more specific — a posting must not pick between equals.',
    );
    this.name = 'AmbiguousPostingRuleError';
  }
}

function describeCriteria(criteria: PostingCriteria): string {
  const stated = Object.entries(criteria)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${value}`);

  return stated.length > 0 ? ` (${stated.join(', ')})` : '';
}

const CRITERIA_KEYS = [
  'itemGroup',
  'partnerGroup',
  'warehouseCode',
  'projectCode',
  'branchCode',
] as const;

/**
 * How specific a rule is: the number of criteria it pins down.
 *
 * A rule naming an item group and a warehouse beats one naming neither. This is
 * the ordering that lets a general rule sit under a set of exceptions without
 * either knowing about the other.
 */
export function specificity(rule: PostingRule): number {
  return CRITERIA_KEYS.filter((key) => rule[key] !== undefined && rule[key] !== null).length;
}

/** Does this rule apply? Every criterion it states must match. */
export function ruleMatches(rule: PostingRule, criteria: PostingCriteria): boolean {
  if (!rule.isActive) return false;

  return CRITERIA_KEYS.every((key) => {
    const required = rule[key];
    if (required === undefined || required === null) return true;
    return criteria[key] === required;
  });
}

/**
 * The account for one line.
 *
 * Most specific wins. A tie is an error, not a coin toss: two rules matching
 * equally well means the configuration is ambiguous, and a posting engine that
 * resolves ambiguity quietly will resolve it differently one day.
 */
export function resolveRule(
  rules: readonly PostingRule[],
  eventType: string,
  lineRole: PostingLineRole,
  criteria: PostingCriteria,
): PostingRule {
  const matching = rules
    .filter((rule) => rule.eventType === eventType && rule.lineRole === lineRole)
    .filter((rule) => ruleMatches(rule, criteria));

  if (matching.length === 0) {
    throw new NoPostingRuleError(eventType, lineRole, criteria);
  }

  const best = Math.max(...matching.map(specificity));
  const winners = matching.filter((rule) => specificity(rule) === best);

  if (winners.length > 1) {
    throw new AmbiguousPostingRuleError(eventType, lineRole, winners);
  }

  return winners[0]!;
}

export const POSTING_ACCOUNT_SOURCES = ['explicit', 'scoped_rule', 'item', 'default_rule'] as const;
export type PostingAccountSource = (typeof POSTING_ACCOUNT_SOURCES)[number];
export interface PostingAccountSelection {
  readonly accountId: string;
  readonly postingRuleId: string | null;
  readonly source: PostingAccountSource;
}
export function resolveLineAccount(
  rules: readonly PostingRule[],
  eventType: string,
  line: Pick<PostingLineRequest, 'role' | 'accountId' | 'itemAccountId'>,
  criteria: PostingCriteria,
): PostingAccountSelection {
  if (line.accountId) return { accountId: line.accountId, postingRuleId: null, source: 'explicit' };
  const hasScoped = rules.some((rule) =>
    rule.eventType === eventType && rule.lineRole === line.role &&
    specificity(rule) > 0 && ruleMatches(rule, criteria),
  );
  if (!hasScoped && line.itemAccountId) {
    return { accountId: line.itemAccountId, postingRuleId: null, source: 'item' };
  }
  const rule = resolveRule(rules, eventType, line.role, criteria);
  return { accountId: rule.accountId, postingRuleId: rule.id, source: specificity(rule) > 0 ? 'scoped_rule' : 'default_rule' };
}

// ---------------------------------------------------------------------------
// The request a module makes, and the plan the engine produces from it
// ---------------------------------------------------------------------------

/**
 * §24 — "Each posting batch includes a deterministic source reference to
 * prevent duplicate posting."
 *
 * Deterministic means derived from the source document, not generated: the same
 * event recomputed after a crash must produce the same reference, or the
 * duplicate check has nothing to match on.
 */
export interface SourceReference {
  readonly module: string;
  readonly documentId: string;
  readonly event: string;
}

export interface PostingLineRequest {
  readonly role: PostingLineRole;
  /**
   * The account, when it is a property of the **document** rather than a
   * mapping decision.
   *
   * §3.3 exists so that "which account does a sale's revenue go to?" is
   * configuration rather than code. But "which account does money leaving
   * BANK-USD land in?" is not that kind of question: the bank account master
   * already names its G/L account, and a mapping would be a second answer to a
   * question that has one — and a wrong one the moment a second bank account
   * exists, because every payment would resolve to the same rule.
   *
   * So a line may name its account directly, and then `postingRuleId` on the
   * planned line is null: no rule was consulted, and recording one would claim
   * a configuration decision that nobody made. Everything else still applies —
   * the account is loaded, checked postable, checked for currency, and its §4.2
   * dimensions are enforced exactly as a mapped account's are.
   */
  readonly accountId?: string;
  readonly itemAccountId?: string | null;
  /** Decimal string. Exactly one of the two. */
  readonly debit?: string | null;
  readonly credit?: string | null;
  readonly criteria?: PostingCriteria;
  readonly dimensions?: Readonly<Record<string, string | null | undefined>>;
  readonly description?: string | null;
  /** §3.3 — "source module, document and line identifiers for complete drill-down". */
  readonly sourceLineId?: string | null;
  /**
   * Which bank or cash account this line is against.
   *
   * §1.2 requires a bank subledger that reconciles to the G/L, and
   * `subledger.ts` reads the party for a `bank` control account from the
   * line's own `bank_account_code`. Without a way to supply it, any document
   * posting to a G/L account flagged as a bank control account was refused
   * outright — receipts, payments and transfers alike — while a manual journal
   * through `journal.addLine` posted fine, because only that path could carry
   * the code. Found on 2026-09-29 while building the treasury report.
   *
   * Not a §4.2 dimension: the seven are branch, department, business line,
   * project, warehouse, business partner and employee. This is the subledger's
   * party, which is a different thing and lives in its own column.
   */
  readonly bankAccountCode?: string | null;
}

export interface PostingRequest {
  readonly eventType: string;
  /**
   * The Appendix B document type this posting comes from — `ap_invoice`,
   * `goods_receipt`, and so on.
   *
   * §4.2's first layer is *"mandatory or optional by account **and document
   * type**"*, and `document_type_dimension` keys on a real document type. The
   * event type is a different namespace (`purchasing.ap_invoice`), so a posting
   * that supplied only its event could never match a layer-1 rule — the
   * configuration would exist and silently never apply. Optional, because most
   * events already name their document type in the event string; when it is
   * absent the event type is used, which is the behaviour that came before.
   */
  readonly documentTypeCode?: string;
  readonly source: SourceReference;
  readonly branchCode: string;
  readonly documentDate: string;
  readonly postingDate: string;
  readonly currency?: string;
  readonly description?: string | null;
  readonly lines: readonly PostingLineRequest[];
}

/** One resolved line of the plan — what will be written, before it is written. */
export interface PlannedLine {
  readonly lineNo: number;
  readonly role: PostingLineRole;
  readonly accountId: string;
  readonly accountCode: string;
  /** Null when the line named its own account — see . */
  readonly postingRuleId: string | null;
  readonly accountSource?: PostingAccountSource;
  readonly debit: string;
  readonly credit: string;
  readonly currency: string;
  readonly debitIqd: string;
  readonly creditIqd: string;
  readonly debitUsd: string;
  readonly creditUsd: string;
  readonly dimensions: Readonly<Record<string, string | null | undefined>>;
  readonly sourceLineId: string | null;
  readonly description: string | null;
  /** The bank subledger's party, carried from the request. */
  readonly bankAccountCode: string | null;
}

/**
 * The posting preview — 02.7: "Posting preview shows the exact journal that
 * will be produced, and the produced journal matches it."
 *
 * Produced by the same code path that posts, so the two cannot drift. A preview
 * assembled by a second implementation would be a description of what someone
 * thought would happen.
 */
export interface PostingPlan {
  readonly eventType: string;
  readonly source: SourceReference;
  readonly branchCode: string;
  readonly documentDate: string;
  readonly postingDate: string;
  readonly description: string | null;
  readonly lines: readonly PlannedLine[];
  readonly totalDebitIqd: string;
  readonly totalCreditIqd: string;
}

export class PostingRequestError extends Error {
  readonly code = 'POSTING_REQUEST_INVALID';
  constructor(detail: string) {
    super(`This posting cannot be built: ${detail}`);
    this.name = 'PostingRequestError';
  }
}

export function assertRequestWellFormed(request: PostingRequest): void {
  if (request.lines.length < 2) {
    throw new PostingRequestError(
      `event '${request.eventType}' produced ${request.lines.length} line(s); a journal needs at least two.`,
    );
  }

  if (!request.source.module || !request.source.documentId || !request.source.event) {
    throw new PostingRequestError(
      'the source reference is incomplete. Module, document and event are all required, because they are what stops the same event posting twice (§24).',
    );
  }

  for (const [index, line] of request.lines.entries()) {
    const hasDebit = Boolean(line.debit && line.debit !== '0');
    const hasCredit = Boolean(line.credit && line.credit !== '0');

    if (hasDebit === hasCredit) {
      throw new PostingRequestError(
        `line ${index + 1} of '${request.eventType}' must carry exactly one of debit or credit.`,
      );
    }
  }
}
