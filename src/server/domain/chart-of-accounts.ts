/**
 * Chart of Accounts — Phase 02.1.
 *
 * §1.2: "The Chart of Accounts shall remain hierarchical and configurable."
 *
 * Hierarchical means a real tree: any group may contain further groups, to any
 * depth, and a group may be added under an existing group at any time without a
 * migration. Configurable means the accounts are the Business Process Owner's
 * to choose (D7) — not that the accounting is negotiable. Which side an account
 * increases on comes from `./accounts`, and nothing here can override it.
 *
 * ── The two kinds of node ───────────────────────────────────────────────────
 *   group    a folder. Holds children. Nothing posts to it.
 *   posting  a leaf. Journals post to it. Holds no children.
 *
 * That distinction is what makes the 02.1 gate "a journal referencing a
 * non-posting (header) account is rejected" enforceable, and it is why the two
 * are one flag on one table rather than two tables — an account converts from
 * one to the other as the chart grows, and a conversion must not change its
 * identity, its code or its history.
 */
import { ACCOUNT_CODE_PATTERN, TYPE_BY_CODE_LETTER, type AccountType } from './accounts';
import type { DocumentStatus } from './statuses';

/**
 * Subledgers that reconcile to a control account (§1.2, §14.3).
 *
 * A control account holds the G/L side of a subledger. §14.3 protects it from
 * direct manual posting, because a manual journal into it breaks the
 * reconciliation the subledger exists to provide.
 */
export const CONTROL_ACCOUNT_KINDS = [
  'customer',
  'supplier',
  'inventory',
  'bank',
  'fixed_asset',
  'project',
  'service',
] as const;
export type ControlAccountKind = (typeof CONTROL_ACCOUNT_KINDS)[number];

/**
 * The seven dimensions of §4.2, re-exported so an account's settings and the
 * dimension framework cannot drift apart. The list and the three-layer
 * requirement resolution live in `./dimensions` (Phase 02.4); what an account
 * itself requires is the middle layer of that resolution.
 */
export { DIMENSION_TYPES, type DimensionType } from './dimensions';
import type { DimensionType } from './dimensions';

/** An account as the tree sees it. */
export interface AccountNode {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly accountType: AccountType;
  readonly parentId: string | null;
  /** A folder. Holds children, accepts no postings. */
  readonly isGroup: boolean;
  readonly isActive: boolean;
  /**
   * Where the account stands in the shared approval route (Phase 01.7).
   * An account posts only once the Accounting Manager has approved it.
   */
  readonly approvalStatus: DocumentStatus;
  /** Set when this account is the G/L side of a subledger (§14.3). */
  readonly controlAccount: ControlAccountKind | null;
  /** ISO code when the account may only hold one currency; null means unrestricted. */
  readonly currencyRestriction: string | null;
  /** Dimensions a posting to this account must supply (§4.2). */
  readonly requiredDimensions: readonly DimensionType[];
  /** One of the five roots. Renameable, never deletable. */
  readonly isSystem: boolean;
  /** Depth from the root: a root is 0. */
  readonly level: number;
}

export class AccountCodeFormatError extends Error {
  readonly code = 'ACCOUNT_CODE_FORMAT';
  constructor(detail: string) {
    super(`Account code is not usable: ${detail}`);
    this.name = 'AccountCodeFormatError';
  }
}

export class AccountPlacementError extends Error {
  readonly code = 'ACCOUNT_PLACEMENT_INVALID';
  constructor(detail: string) {
    super(`This account cannot sit there: ${detail}`);
    this.name = 'AccountPlacementError';
  }
}

export class AccountPostingError extends Error {
  readonly code = 'ACCOUNT_NOT_POSTABLE';
  constructor(
    readonly accountCode: string,
    detail: string,
  ) {
    super(`Cannot post to ${accountCode}: ${detail}`);
    this.name = 'AccountPostingError';
  }
}

export class AccountStructureError extends Error {
  readonly code = 'ACCOUNT_STRUCTURE_INVALID';
  constructor(detail: string) {
    super(detail);
    this.name = 'AccountStructureError';
  }
}

/** Longest chain of groups allowed. Deep enough for any real chart, shallow enough to catch a loop. */
export const MAX_ACCOUNT_DEPTH = 12;

/**
 * Normalises a code to its stored form.
 *
 * Codes are uppercase and unspaced because users type them into journals and
 * search boxes, and 'a000101' and 'A000101' being two accounts would be a
 * reconciliation problem, not a display one.
 *
 * The received chart uses one type letter and six digits (A000001). That shape
 * is NOT imposed here: §1.2 makes the chart configurable, and a company that
 * later wants 4-digit or dotted codes must not need a code change. What *is*
 * imposed, by `assertCodeAgreesWithType`, is that a code which follows the
 * convention has to mean what the convention says it means.
 */
export function normaliseAccountCode(raw: string): string {
  const code = raw.trim().toUpperCase();

  if (code.length === 0) throw new AccountCodeFormatError('it is empty');
  if (code.length > 20) throw new AccountCodeFormatError(`it is ${code.length} characters, maximum 20`);
  if (/\s/.test(code)) throw new AccountCodeFormatError('it contains a space');
  if (!/^[A-Z0-9][A-Z0-9._-]*$/.test(code)) {
    throw new AccountCodeFormatError(
      'it may contain only letters, digits, dot, underscore and hyphen, and must start with a letter or digit',
    );
  }
  return code;
}

/**
 * If a code follows the A/L/E/R/X convention, its letter must agree with its
 * type. X000200 cannot be an asset.
 *
 * Codes outside the convention are accepted without comment — the check exists
 * to stop a chart that uses the convention from contradicting itself, not to
 * force every chart into it.
 */
export function assertCodeAgreesWithType(code: string, accountType: AccountType): void {
  const match = ACCOUNT_CODE_PATTERN.exec(code);
  if (!match) return;

  const impliedType = TYPE_BY_CODE_LETTER[match[1]!]!;
  if (impliedType !== accountType) {
    throw new AccountPlacementError(
      `code ${code} starts with '${match[1]}', which means ${impliedType}, but the account is typed ${accountType}`,
    );
  }
}

export interface PlacementCheck {
  readonly code: string;
  readonly accountType: AccountType;
  readonly parent: AccountNode | null;
}

/**
 * The rules for where a node may sit. All four exist to keep the tree summable:
 * a group's balance is the sum of its descendants, and that is only meaningful
 * if every descendant is the same type and nothing hangs off a leaf.
 */
export function assertValidPlacement({ code, accountType, parent }: PlacementCheck): void {
  assertCodeAgreesWithType(code, accountType);

  if (parent === null) {
    // A root is one of the five types and answers to nothing above it.
    return;
  }

  if (!parent.isGroup) {
    throw new AccountPlacementError(
      `${parent.code} is a posting account, so it cannot hold children. Convert it to a group first, which is only possible while it has no transactions.`,
    );
  }

  if (parent.accountType !== accountType) {
    throw new AccountPlacementError(
      `${parent.code} is ${parent.accountType} and this account is ${accountType}. An account inherits its parent's type — Assets cannot contain an expense.`,
    );
  }

  if (!parent.isActive) {
    throw new AccountPlacementError(
      `${parent.code} is inactive. Reactivate it before adding accounts beneath it.`,
    );
  }

  if (parent.level + 1 >= MAX_ACCOUNT_DEPTH) {
    throw new AccountPlacementError(
      `it would sit at depth ${parent.level + 1}, beyond the maximum of ${MAX_ACCOUNT_DEPTH}`,
    );
  }
}

/**
 * Refuses a move that would make an account its own ancestor.
 *
 * `ancestorIds` is the chain above the proposed new parent, nearest first.
 */
export function assertNoCycle(
  accountId: string,
  newParentId: string | null,
  ancestorIds: readonly string[],
): void {
  if (newParentId === null) return;

  if (newParentId === accountId || ancestorIds.includes(accountId)) {
    throw new AccountPlacementError(
      'an account cannot be moved beneath itself or one of its own descendants',
    );
  }
}

/** Conversions between group and posting account, with the rules that make them safe. */
export function assertCanBecomePosting(account: AccountNode, childCount: number): void {
  if (childCount > 0) {
    throw new AccountStructureError(
      `${account.code} has ${childCount} child account(s). Move or remove them before making it a posting account.`,
    );
  }
}

export function assertCanBecomeGroup(account: AccountNode, transactionCount: number): void {
  if (transactionCount > 0) {
    throw new AccountStructureError(
      `${account.code} already carries ${transactionCount} transaction(s). A posted account cannot become a group — its balance would have nowhere to sit.`,
    );
  }
}

export function assertCanDeactivate(account: AccountNode, activeChildCount: number): void {
  if (activeChildCount > 0) {
    throw new AccountStructureError(
      `${account.code} still has ${activeChildCount} active child account(s). Deactivate them first.`,
    );
  }
}

/** Where a posting came from. §14.3 treats the two differently at control accounts. */
export interface PostingContext {
  /**
   * 'manual'    a Journal Entry typed by a person
   * 'system'    the posting engine acting on an approved source document
   */
  readonly source: 'manual' | 'system';
  /** §14.3 — manual posting to a control account requires Finance Manager approval. */
  readonly actorIsFinanceManager?: boolean;
}

/**
 * The gate every posting passes through — 02.1's test gate, in one function.
 *
 *   §3.3  "All accounts used by automatic or manual journals shall exist and be
 *          active in the Chart of Accounts"
 *   §14.3 "Direct manual posting to customer, supplier, inventory, bank and
 *          control accounts is allowed only through Finance Journal Entry and
 *          requires Finance Manager approval"
 *
 * The order of the checks is the order a user would want to hear them.
 */
export function assertPostable(account: AccountNode, context: PostingContext): void {
  if (account.approvalStatus !== 'approved') {
    throw new AccountPostingError(
      account.code,
      `it is still '${account.approvalStatus}'. An account accepts entries only once the Accounting Manager has approved it (§5.2).`,
    );
  }

  if (!account.isActive) {
    throw new AccountPostingError(
      account.code,
      'the account is inactive. An inactive account keeps its history but accepts no new entries (§3.3).',
    );
  }

  if (account.isGroup) {
    throw new AccountPostingError(
      account.code,
      'it is a group account. Groups summarise their children; postings go to a posting account beneath it.',
    );
  }

  if (account.controlAccount && context.source === 'manual' && !context.actorIsFinanceManager) {
    throw new AccountPostingError(
      account.code,
      `it is the ${account.controlAccount} control account. Direct manual posting requires Finance Manager approval (§14.3); ` +
        'ordinarily it is posted by the source document, not by hand.',
    );
  }
}

export function assertCurrencyAllowed(account: AccountNode, currencyCode: string): void {
  if (account.currencyRestriction && account.currencyRestriction !== currencyCode) {
    throw new AccountPostingError(
      account.code,
      `it accepts ${account.currencyRestriction} only, and this entry is in ${currencyCode}`,
    );
  }
}

/**
 * Which required dimensions a posting failed to supply (§4.2).
 *
 * Returns the list rather than throwing, so the caller can report every missing
 * dimension at once — §25: "Validation messages identify the field, reason and
 * corrective action."
 */
export function missingRequiredDimensions(
  account: AccountNode,
  supplied: Readonly<Partial<Record<DimensionType, unknown>>>,
): DimensionType[] {
  return account.requiredDimensions.filter(
    (dimension) => supplied[dimension] === undefined || supplied[dimension] === null,
  );
}

/** A node with its children attached — what a tree view renders. */
export interface AccountTreeNode extends AccountNode {
  readonly children: AccountTreeNode[];
}

/**
 * Assembles a flat list into a tree.
 *
 * Sorted by code within each level, so the chart reads the same everywhere it
 * is shown. An account whose parent is missing from the input surfaces as a
 * root rather than being dropped — a filtered subtree should still render.
 */
export function buildAccountTree(accounts: readonly AccountNode[]): AccountTreeNode[] {
  const byId = new Map<string, AccountTreeNode>();
  for (const account of accounts) {
    byId.set(account.id, { ...account, children: [] });
  }

  const roots: AccountTreeNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const sortByCode = (nodes: AccountTreeNode[]): AccountTreeNode[] => {
    nodes.sort((a, b) => a.code.localeCompare(b.code));
    for (const node of nodes) sortByCode(node.children);
    return nodes;
  };

  return sortByCode(roots);
}

/** Every descendant of `accountId`, nearest first. Used by move and deactivate. */
export function descendantsOf(
  accounts: readonly AccountNode[],
  accountId: string,
): AccountNode[] {
  const childrenByParent = new Map<string, AccountNode[]>();
  for (const account of accounts) {
    if (!account.parentId) continue;
    const siblings = childrenByParent.get(account.parentId) ?? [];
    siblings.push(account);
    childrenByParent.set(account.parentId, siblings);
  }

  const collected: AccountNode[] = [];
  const queue = [...(childrenByParent.get(accountId) ?? [])];
  while (queue.length > 0) {
    const node = queue.shift()!;
    collected.push(node);
    queue.push(...(childrenByParent.get(node.id) ?? []));
  }
  return collected;
}
