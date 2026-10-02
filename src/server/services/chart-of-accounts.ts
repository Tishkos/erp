/**
 * Chart of Accounts service — Phase 02.1.
 *
 * The whole life of an account, in the order an accountant lives it:
 *
 *   1. An Accounting Officer raises it under a group. The code is allocated
 *      automatically; nothing about it is typed by hand that can be derived.
 *   2. It is submitted to the Accounting Manager.
 *   3. The Manager approves — and only then does it accept postings — or
 *      rejects it with a reason, and it goes back for correction.
 *   4. When it is no longer used it is deactivated. It is never deleted: its
 *      code is cited by journals that must stay readable (§1.1).
 *
 * Approval runs through the shared workflow engine (01.7) and the shared status
 * machine (01.6). §24 forbids this module carrying its own.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  assertCanDeactivate,
  assertValidPlacement,
  buildAccountTree,
  type AccountNode,
  type AccountTreeNode,
  type ControlAccountKind,
  type DimensionType,
} from '../domain/chart-of-accounts';
import { AccountPlacementError } from '../domain/chart-of-accounts';
import type { AccountType } from '../domain/accounts';
import {
  STATEMENT_FACES,
  type AccountMapping,
  type AccountMappingInput,
  type LineCatalogue,
  type StatementFace,
} from '../domain/financial-statements';
import * as statementLines from './statement-lines';
import { accountRequiredDimension, chartOfAccount } from '../db/schema';
import type { Principal } from '../domain/permissions';
import type { Tx } from '../db/client';
import { allocateDocumentNumber } from './numbering';
import * as audit from './audit';
import * as authz from './authorization';
import * as dimensions_ from './dimensions';
import * as statuses from './statuses';
import * as workflow from './workflow';

/** The Appendix B document type this service manages. */
export const DOCUMENT_TYPE = 'chart_of_account';

/** The permission object the §5.3 verbs are granted against. */
export const PERMISSION_OBJECT = 'chart_of_account';

const SEQUENCE_KEY_BY_TYPE: Readonly<Record<AccountType, string>> = {
  asset: 'ACCOUNT_CODE_ASSET',
  liability: 'ACCOUNT_CODE_LIABILITY',
  equity: 'ACCOUNT_CODE_EQUITY',
  revenue: 'ACCOUNT_CODE_REVENUE',
  expense: 'ACCOUNT_CODE_EXPENSE',
};

export class AccountNotFoundError extends Error {
  readonly code = 'ACCOUNT_NOT_FOUND';
  constructor(id: string) {
    super(`No account with id '${id}'.`);
    this.name = 'AccountNotFoundError';
  }
}

/**
 * D7, 2026-08-17: *"the currency should not be assumed automatically."*
 *
 * Thrown rather than defaulted. Writing IQD because most accounts are IQD would
 * be the system choosing an accounting attribute on Accounting's behalf, and the
 * account that is wrong would be a foreign-currency one — the only kind where
 * the mistake matters and the last kind anyone re-checks.
 */
export class AccountCurrencyRequiredError extends Error {
  readonly code = 'ACCOUNT_CURRENCY_REQUIRED';
  readonly field = 'currencyRestriction';
  constructor() {
    super(
      'A posting account holds one currency, and it has to be chosen (D7). ' +
        'Set the account currency — for the same account in another currency, create a separate account.',
    );
    this.name = 'AccountCurrencyRequiredError';
  }
}

/** A group holds no balance, so it can hold no currency. */
export class GroupAccountCurrencyError extends Error {
  readonly code = 'GROUP_ACCOUNT_CURRENCY';
  readonly field = 'currencyRestriction';
  constructor() {
    super(
      'A group account summarises its children and holds no balance of its own, so it has no currency. ' +
        'Set the currency on the posting accounts beneath it.',
    );
    this.name = 'GroupAccountCurrencyError';
  }
}

/** Who is acting, and from where. */
export interface ActorContext {
  readonly principal: Principal;
  readonly branchCode: string;
  readonly requestId?: string | null;
}

export interface CreateAccountInput {
  readonly name: string;
  /**
   * Required. Every account hangs under a group — the five type roots are
   * seeded and are the only accounts without a parent.
   */
  readonly parentId: string;
  /** A folder that will hold further accounts, or a leaf that takes postings. */
  readonly isGroup?: boolean;
  readonly controlAccount?: ControlAccountKind | null;
  /**
   * The one currency this account holds (D7, 2026-08-17). **Required** on a
   * posting account; must be absent on a group. Not defaulted — see
   * `AccountCurrencyRequiredError`.
   */
  readonly currencyRestriction?: string | null;
  readonly requiredDimensions?: readonly DimensionType[];
  readonly description?: string | null;
  /**
   * Phase 1 §5, opened to Finance by direction (2026-09-03) — where the
   * account reports on each of the four statements, one answer per report.
   *
   * Every one is optional and stays optional: an account with nothing chosen
   * reports where its type says it does, so a statement is complete from the
   * first day and grows more precise as Finance works through the chart.
   */
  readonly mapping?: AccountMappingInput;
}

/** The four choices, read from whatever the caller passed. */
function mappingOf(input: { readonly mapping?: AccountMappingInput }): AccountMappingInput {
  return input.mapping ?? {};
}

/**
 * The four mappings, each checked against the report it claims to be on.
 *
 * A header account carries none: it prints the sum of the accounts beneath
 * it, so a mapping of its own would put the same money on the statement
 * twice. Beyond that the service does not second-guess the choice — which
 * line suits which account is Finance's judgement, and the mapping screens
 * exist so they can make it.
 */
function resolveMapping(
  catalogue: LineCatalogue,
  mapping: AccountMappingInput,
  isGroup: boolean,
): AccountMapping {
  const resolved = {} as Record<StatementFace, string | null>;
  for (const statement of STATEMENT_FACES) {
    const chosen = mapping[statement]?.trim();
    if (!chosen) {
      resolved[statement] = null;
      continue;
    }
    if (isGroup) {
      throw new AccountPlacementError(
        'a header account carries no statement mapping of its own; it prints the sum of the accounts beneath it',
      );
    }
    resolved[statement] = catalogue.assertLineAllowed(chosen, statement).code;
  }
  return resolved;
}

function toNode(
  row: typeof chartOfAccount.$inferSelect,
  requiredDimensions: readonly DimensionType[] = [],
): AccountNode {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    accountType: row.accountType,
    parentId: row.parentId,
    isGroup: row.isGroup,
    isActive: row.isActive,
    approvalStatus: row.approvalStatus,
    controlAccount: row.controlAccount,
    currencyRestriction: row.currencyRestriction,
    mapping: {
      income_statement: row.incomeStatementLine,
      balance_sheet: row.balanceSheetLine,
      cash_flow: row.cashFlowLine,
      changes_in_equity: row.changesInEquityLine,
    },
    description: row.description,
    requiredDimensions,
    isSystem: row.isSystem,
    level: row.level,
  };
}

/**
 * One account, with the dimensions it **effectively** requires.
 *
 * Effective, not declared: since D7 (2026-08-17) rules are set on the group and
 * inherited, so an account's own rows are usually empty while the rules that
 * apply to it are real. Returning the declared set here would make every caller
 * that asks "what does this account require?" get the wrong answer for the
 * majority of accounts. `effectiveDimensions()` returns the same list together
 * with where it came from.
 */
export async function loadAccount(tx: Tx, id: string): Promise<AccountNode> {
  const [row] = await tx.select().from(chartOfAccount).where(eq(chartOfAccount.id, id)).limit(1);
  if (!row) throw new AccountNotFoundError(id);

  const dimensions = await tx.execute<{ dimension: DimensionType }>(
    sql`select account_effective_dimensions(${id}::uuid) as dimension`,
  );

  return toNode(row, dimensions.rows.map((d) => d.dimension));
}

/**
 * Raises a new account as a draft.
 *
 * The type is inherited from the parent rather than asked for: an account under
 * Assets is an asset, and offering the choice would only create the opportunity
 * to get it wrong. The code is allocated from that type's counter through the
 * shared numbering service, so the next account under Assets is A000002.
 */
/**
 * The next code for this account type that nothing already holds.
 *
 * Bounded: if a hundred consecutive numbers are all taken, the counter is not
 * merely behind and a person should look at it rather than the loop spinning.
 */
async function allocateFreeCode(tx: Tx, accountType: AccountType, userId: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { documentNo } = await allocateDocumentNumber(
      tx,
      SEQUENCE_KEY_BY_TYPE[accountType],
      {},
      userId,
    );
    const [taken] = await tx
      .select({ code: chartOfAccount.code })
      .from(chartOfAccount)
      .where(eq(chartOfAccount.code, documentNo))
      .limit(1);
    if (!taken) return documentNo;
  }
  throw new Error(
    `The ${accountType} account counter is a hundred numbers behind the chart. ` +
      `Set it past the highest code in use before raising another account.`,
  );
}

export async function createAccount(
  tx: Tx,
  ctx: ActorContext,
  input: CreateAccountInput,
): Promise<AccountNode> {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
    requestId: ctx.requestId ?? null,
  });

  const parent = await loadAccount(tx, input.parentId);
  const accountType = parent.accountType;

  // D7 — asked for at the beginning of the setup, never assumed.
  const isGroup = input.isGroup ?? false;
  const currency = input.currencyRestriction?.trim().toUpperCase() || null;
  if (!isGroup && !currency) throw new AccountCurrencyRequiredError();
  if (isGroup && currency) throw new GroupAccountCurrencyError();

  // A code already in use is skipped rather than thrown at the person raising
  // the account.
  //
  // The five roots were seeded with the first number of their own counter, so
  // A000001 is both the Assets folder and the first number the asset counter
  // ever issued. That is fine while the counter keeps climbing. It is not fine
  // if the counter is ever restarted — a rebuilt database, a restore, a reset
  // during setup — because the next account then asks for a code the root
  // already holds and the insert dies on a unique constraint.
  //
  // That happened on 2026-09-09: the first equity account anyone tried to
  // create came back as E000001 and failed. Retrying worked, because the
  // failed attempt had moved the counter on — which is the worst shape for a
  // bug, since it looks like a glitch rather than something wrong.
  //
  // The skipped number is recorded as an allocation with no document, which is
  // exactly what §24's sequence-gap report exists to explain.
  const code = await allocateFreeCode(tx, accountType, ctx.principal.userId);

  // Checked here for a readable message, and again by the database trigger,
  // which is what actually holds the tree together.
  assertValidPlacement({ code, accountType, parent });

  const catalogue = await statementLines.catalogue(tx);
  const mapping = resolveMapping(catalogue, mappingOf(input), isGroup);

  const [created] = await tx
    .insert(chartOfAccount)
    .values({
      code,
      name: input.name.trim(),
      accountType,
      parentId: parent.id,
      isGroup,
      isActive: false,
      approvalStatus: 'draft',
      controlAccount: input.controlAccount ?? null,
      currencyRestriction: currency,
      // Phase 1 §5 — checked here rather than trusted, because the database
      // trigger would refuse it later with a message about a constraint.
      incomeStatementLine: mapping.income_statement,
      balanceSheetLine: mapping.balance_sheet,
      cashFlowLine: mapping.cash_flow,
      changesInEquityLine: mapping.changes_in_equity,
      description: input.description ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning();

  // D7 (2026-08-17) — rules are set at the group and inherited. An account
  // raised without a `requiredDimensions` argument declares nothing and takes
  // whatever the group above it requires; passing the argument, even as an
  // empty array, is how Finance overrides that.
  const dimensions = input.requiredDimensions;
  if (dimensions) {
    await tx
      .update(chartOfAccount)
      .set({ declaresDimensions: true })
      .where(eq(chartOfAccount.id, created!.id));

    if (dimensions.length > 0) {
      await tx
        .insert(accountRequiredDimension)
        .values(dimensions.map((dimension) => ({ accountId: created!.id, dimension })));
    }
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'chart_of_account.created',
    objectType: PERMISSION_OBJECT,
    objectId: created!.id,
    branchCode: ctx.branchCode,
    after: {
      code,
      name: created!.name,
      accountType,
      parent: parent.code,
      isGroup: created!.isGroup,
      controlAccount: created!.controlAccount,
      mapping,
    },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });

  return toNode(created!, dimensions ?? []);
}

/**
 * D7 — the effective dimension rules for an account, and where they came from.
 *
 * Resolved through the same SQL function the posting engine uses, so a screen
 * and a posting cannot disagree about what an account requires. The source is
 * returned with the rules because "Branch is required" is far less useful to
 * Finance than "Branch is required, inherited from Operating Expenses" — the
 * second tells them which account to change.
 */
export async function effectiveDimensions(
  tx: Tx,
  accountId: string,
): Promise<{ dimensions: DimensionType[]; inheritedFrom: string | null; ownRules: boolean }> {
  const rules = await tx.execute<{ dimension: DimensionType }>(
    sql`select account_effective_dimensions(${accountId}::uuid) as dimension`,
  );

  const source = await tx.execute<{ code: string; is_self: boolean }>(sql`
    with recursive chain as (
      select id, parent_id, declares_dimensions, code, 0 as depth
        from chart_of_account where id = ${accountId}::uuid
      union all
      select p.id, p.parent_id, p.declares_dimensions, p.code, c.depth + 1
        from chart_of_account p join chain c on c.parent_id = p.id
    )
    select code, depth = 0 as is_self
      from chain where declares_dimensions order by depth limit 1
  `);

  return {
    dimensions: rules.rows.map((r) => r.dimension),
    inheritedFrom: source.rows[0]?.code ?? null,
    ownRules: source.rows[0]?.is_self ?? false,
  };
}

/**
 * D7 — Finance sets the dimension rules for an account or, more usually, for a
 * group.
 *
 * Passing an empty array is meaningful: it declares that this account requires
 * nothing, overriding whatever the group above it asks for. That is the
 * "Finance may override a rule for a specific account" half of the decision,
 * and without an explicit declaration it could not be expressed — an account
 * with no rules would be indistinguishable from one that had never been
 * considered.
 */
export async function setRequiredDimensions(
  tx: Tx,
  ctx: ActorContext,
  accountId: string,
  dimensions: readonly DimensionType[],
): Promise<void> {
  // One implementation, in the dimensions service, because it also checks that
  // each dimension has master data yet (§4.2) — a rule that would be easy to
  // forget in a second copy and impossible to notice missing.
  await dimensions_.setAccountRequirements(tx, ctx, accountId, dimensions);
}

/**
 * D7 — hands an account back to its group's rules.
 *
 * The opposite of an override. Distinct from declaring an empty set: this says
 * "whatever the group requires", that says "nothing, regardless of the group".
 */
export async function inheritDimensions(
  tx: Tx,
  ctx: ActorContext,
  accountId: string,
): Promise<void> {
  await authz.authorize(ctx.principal, 'configure', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
    requestId: ctx.requestId ?? null,
  });

  // Rows first: the trigger refuses a rule on an account that does not declare,
  // and it is checked on the rule rather than on the account.
  await tx
    .delete(accountRequiredDimension)
    .where(eq(accountRequiredDimension.accountId, accountId));

  await tx
    .update(chartOfAccount)
    .set({ declaresDimensions: false, updatedAt: new Date() })
    .where(eq(chartOfAccount.id, accountId));

  const now = await effectiveDimensions(tx, accountId);

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'chart_of_account.dimensions_inherited',
    objectType: PERMISSION_OBJECT,
    objectId: accountId,
    branchCode: ctx.branchCode,
    after: { dimensions: now.dimensions, inheritedFrom: now.inheritedFrom },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

export class ControlAccountInUseError extends Error {
  readonly code = 'CONTROL_ACCOUNT_IN_USE';
  constructor(accountCode: string, mappings: number) {
    super(
      `${accountCode} is the account ${mappings} accounting mapping(s) post to as a control account (§14.3). ` +
        'Removing the designation would leave those mappings posting to an account no longer protected. ' +
        'Repoint the mappings first.',
    );
    this.name = 'ControlAccountInUseError';
  }
}

/**
 * D7 — changes an account's control-account designation.
 *
 * *"Once a control account has transactions, changing or removing its
 * control-account status should require Accounting Manager approval and should
 * not be allowed if doing so would break existing accounting mappings."*
 *
 * The approval is expressed as the `approve` verb rather than `configure`:
 * configuring the chart is an Officer's work, and this is not. The database
 * refuses the change to everyone unless this function has marked the session as
 * carrying that approval, so there is no route round it — and the marker is set
 * for the length of the statement, not the transaction, so it cannot leak into
 * a later write.
 */
export async function setControlAccount(
  tx: Tx,
  ctx: ActorContext,
  accountId: string,
  controlAccount: ControlAccountKind | null,
): Promise<void> {
  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
    requestId: ctx.requestId ?? null,
  });

  const account = await loadAccount(tx, accountId);
  if (account.controlAccount === controlAccount) return;

  if (account.isGroup && controlAccount) {
    throw new Error(
      `${account.code} is a group account. A group summarises its children and has no balance of its own ` +
        'to reconcile a subledger against; the control account is the posting account beneath it.',
    );
  }

  // Transaction-local (`is_local = true`), so it dies with the transaction and
  // cannot leak into the next one. Cleared on the way out rather than in a
  // `finally`: if the update raises, the transaction is already aborted and the
  // reset would fail too — replacing the real message with a confusing one
  // about `set_config`.
  await tx.execute(sql`select set_config('app.control_account_change_approved', 'on', true)`);

  await tx
    .update(chartOfAccount)
    .set({ controlAccount, updatedAt: new Date() })
    .where(eq(chartOfAccount.id, accountId));

  await tx.execute(sql`select set_config('app.control_account_change_approved', 'off', true)`);

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'chart_of_account.control_account_changed',
    objectType: PERMISSION_OBJECT,
    objectId: accountId,
    branchCode: ctx.branchCode,
    before: { controlAccount: account.controlAccount },
    after: { code: account.code, controlAccount },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

/** Sends a draft to the Accounting Manager (§5.2, §14.4). */
export async function submitForApproval(
  tx: Tx,
  ctx: ActorContext,
  accountId: string,
): Promise<void> {
  await authz.authorize(ctx.principal, 'submit', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
    objectId: accountId,
    requestId: ctx.requestId ?? null,
  });

  const account = await loadAccount(tx, accountId);
  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, account.approvalStatus, 'submitted');

  await workflow.submit(tx, ctx, {
    documentTypeCode: DOCUMENT_TYPE,
    documentId: accountId,
    branchCode: ctx.branchCode,
  });

  await tx
    .update(chartOfAccount)
    .set({ approvalStatus: 'submitted' })
    .where(eq(chartOfAccount.id, accountId));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'chart_of_account.submitted',
    objectType: PERMISSION_OBJECT,
    objectId: accountId,
    branchCode: ctx.branchCode,
    before: { approvalStatus: account.approvalStatus },
    after: { approvalStatus: 'submitted' },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

/**
 * The principal, as the workflow engine sees it.
 *
 * `isDepartmentManager` is false here: §5.2's direct-finalisation shortcut is
 * for a manager's own *operational* document. The Chart of Accounts is
 * configuration that every posting in the system maps against, so it takes a
 * second pair of eyes even from the Accounting Manager who raised it — which is
 * why the seeded route sets `allow_self_approval` to false.
 */
function workflowActorFor(ctx: ActorContext) {
  return {
    userId: ctx.principal.userId,
    roles: ctx.principal.roleCodes,
    isDepartmentManager: false,
  };
}

/**
 * The Accounting Manager approves. Approval and activation happen in one
 * transaction — an approved-but-not-usable account is a state nobody would know
 * how to interpret, and §24 requires approval to carry its effects.
 */
export async function approve(tx: Tx, ctx: ActorContext, accountId: string): Promise<void> {
  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
    objectId: accountId,
    requestId: ctx.requestId ?? null,
  });

  const account = await loadAccount(tx, accountId);
  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, account.approvalStatus, 'approved');

  const outcome = await workflow.decide(tx, {
    documentTypeCode: DOCUMENT_TYPE,
    documentId: accountId,
    actor: workflowActorFor(ctx),
    decision: 'approved',
  });

  // Only the final step activates the account. A multi-step route leaves it
  // submitted until the last approver has acted.
  if (outcome.isComplete) {
    await tx
      .update(chartOfAccount)
      .set({
        approvalStatus: 'approved',
        isActive: true,
        approvedBy: ctx.principal.userId,
        approvedAt: new Date(),
      })
      .where(eq(chartOfAccount.id, accountId));
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'chart_of_account.approved',
    objectType: PERMISSION_OBJECT,
    objectId: accountId,
    branchCode: ctx.branchCode,
    before: { approvalStatus: account.approvalStatus, isActive: account.isActive },
    after: outcome.isComplete
      ? { approvalStatus: 'approved', isActive: true }
      : { approvalStatus: 'submitted', awaitingStep: outcome.nextStep },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

/** Rejection needs a reason, and the reason is what the officer corrects against. */
export async function reject(
  tx: Tx,
  ctx: ActorContext,
  accountId: string,
  reason: string,
): Promise<void> {
  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
    objectId: accountId,
    requestId: ctx.requestId ?? null,
  });

  const account = await loadAccount(tx, accountId);
  await statuses.assertTransitionAllowed(
    tx,
    DOCUMENT_TYPE,
    account.approvalStatus,
    'rejected',
    reason,
  );

  await workflow.decide(tx, {
    documentTypeCode: DOCUMENT_TYPE,
    documentId: accountId,
    actor: workflowActorFor(ctx),
    decision: 'rejected',
    reason,
  });

  await tx
    .update(chartOfAccount)
    .set({ approvalStatus: 'rejected' })
    .where(eq(chartOfAccount.id, accountId));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'chart_of_account.rejected',
    objectType: PERMISSION_OBJECT,
    objectId: accountId,
    branchCode: ctx.branchCode,
    before: { approvalStatus: account.approvalStatus },
    after: { approvalStatus: 'rejected' },
    reason,
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

/** A rejected account returns to draft so the officer can correct and resubmit. */
export async function returnToDraft(
  tx: Tx,
  ctx: ActorContext,
  accountId: string,
): Promise<void> {
  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
    objectId: accountId,
    requestId: ctx.requestId ?? null,
  });

  const account = await loadAccount(tx, accountId);
  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, account.approvalStatus, 'draft');

  await tx
    .update(chartOfAccount)
    .set({ approvalStatus: 'draft' })
    .where(eq(chartOfAccount.id, accountId));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'chart_of_account.returned_to_draft',
    objectType: PERMISSION_OBJECT,
    objectId: accountId,
    branchCode: ctx.branchCode,
    before: { approvalStatus: account.approvalStatus },
    after: { approvalStatus: 'draft' },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

/**
 * Retires an account. §02.1: "Active/inactive; deactivation rather than
 * deletion when referenced."
 *
 * A group cannot be deactivated while it still has active children — the chart
 * would show a live account underneath a retired heading.
 */
/**
 * Assigns the account to a financial statement line — Phase 1 §5.
 *
 * Separate from `createAccount` because it is a decision that gets revisited:
 * an account opened as an ordinary expense turns out to be cost of sales, and
 * moving it should not mean opening a second account. The move changes how
 * every statement reads from that moment, so it is written to the trail.
 */
export async function setStatementLines(
  tx: Tx,
  ctx: ActorContext,
  accountId: string,
  mapping: AccountMappingInput,
): Promise<void> {
  const account = await loadAccount(tx, accountId);

  await authz.authorize(ctx.principal, 'configure', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
    objectId: accountId,
    requestId: ctx.requestId ?? null,
  });

  const catalogue = await statementLines.catalogue(tx);
  const resolved = resolveMapping(catalogue, mapping, account.isGroup);

  await tx
    .update(chartOfAccount)
    .set({
      incomeStatementLine: resolved.income_statement,
      balanceSheetLine: resolved.balance_sheet,
      cashFlowLine: resolved.cash_flow,
      changesInEquityLine: resolved.changes_in_equity,
    })
    .where(eq(chartOfAccount.id, accountId));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'chart_of_account.statement_line_set',
    objectType: PERMISSION_OBJECT,
    objectId: accountId,
    branchCode: ctx.branchCode,
    before: account.mapping,
    after: { code: account.code, ...resolved },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

/**
 * Turns a posting account into a header, so it can hold sub-accounts.
 *
 * The placement rule already said this was the way — *"convert it to a group
 * first, which is only possible while it has no transactions"* — and there was
 * no way to do it. This is that way.
 *
 * The condition is not a formality. A header holds no balance of its own: its
 * figure is the sum of its children. An account that has been posted to *does*
 * hold a balance, and converting it would leave that balance in a place no
 * statement adds up. So an account with even one journal line against it is
 * refused, and the answer is a new sub-account beside it rather than above it.
 *
 * The currency goes with the change, for the same reason: a group summarises
 * children that may each hold a different one.
 */
/**
 * One account by its code — what a person knows, and what the record page is
 * addressed by.  takes the id, which the screen never sees.
 */
export async function loadAccountByCode(tx: Tx, code: string): Promise<AccountNode | null> {
  const [row] = await tx
    .select({ id: chartOfAccount.id })
    .from(chartOfAccount)
    .where(eq(chartOfAccount.code, code))
    .limit(1);
  return row ? loadAccount(tx, row.id) : null;
}

export async function convertToGroup(
  tx: Tx,
  ctx: ActorContext,
  accountId: string,
): Promise<void> {
  const account = await loadAccount(tx, accountId);

  await authz.authorize(ctx.principal, 'configure', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
    objectId: accountId,
    requestId: ctx.requestId ?? null,
  });

  if (account.isGroup) {
    throw new AccountPlacementError(`${account.code} already holds sub-accounts.`);
  }

  const counted = await tx.execute(
    sql`select count(*)::int as postings from journal_line where account_id = ${accountId}`,
  );
  const postings = Number((counted.rows[0] as { postings?: number } | undefined)?.postings ?? 0);

  if (postings > 0) {
    throw new AccountPlacementError(
      `${account.code} has ${postings} posting${postings === 1 ? '' : 's'} against it, so it holds a balance of its own and cannot become a header. ` +
        'Open the sub-accounts beside it instead, and stop using this one.',
    );
  }

  await tx
    .update(chartOfAccount)
    .set({
      isGroup: true,
      currencyRestriction: null,
      incomeStatementLine: null,
      balanceSheetLine: null,
      cashFlowLine: null,
      changesInEquityLine: null,
    })
    .where(eq(chartOfAccount.id, accountId));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'chart_of_account.converted_to_group',
    objectType: PERMISSION_OBJECT,
    objectId: accountId,
    branchCode: ctx.branchCode,
    before: { isGroup: false, currencyRestriction: account.currencyRestriction },
    after: { code: account.code, isGroup: true },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

/**
 * Every account, flat, in code order — for a picker that has to show where a
 * new one would sit. Groups and posting accounts alike: the screen shows both
 * so the shape of the chart is visible, and offers only the groups.
 */
export async function pickerTree(tx: Tx) {
  const rows = await tx.select().from(chartOfAccount).orderBy(asc(chartOfAccount.code));
  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    accountType: row.accountType,
    isGroup: row.isGroup,
    isActive: row.isActive,
    level: row.level,
  }));
}

export async function deactivate(
  tx: Tx,
  ctx: ActorContext,
  accountId: string,
  reason: string,
): Promise<void> {
  await authz.authorize(ctx.principal, 'configure', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
    objectId: accountId,
    requestId: ctx.requestId ?? null,
  });

  const account = await loadAccount(tx, accountId);

  const activeChildren = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(chartOfAccount)
    .where(and(eq(chartOfAccount.parentId, accountId), eq(chartOfAccount.isActive, true)));

  assertCanDeactivate(account, activeChildren[0]?.count ?? 0);

  await tx
    .update(chartOfAccount)
    .set({ isActive: false })
    .where(eq(chartOfAccount.id, accountId));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'chart_of_account.deactivated',
    objectType: PERMISSION_OBJECT,
    objectId: accountId,
    branchCode: ctx.branchCode,
    before: { isActive: true },
    after: { isActive: false },
    reason,
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

/** Every account, assembled into the tree a screen renders. */
export async function tree(tx: Tx, options: { includeInactive?: boolean } = {}): Promise<AccountTreeNode[]> {
  const rows = await tx.select().from(chartOfAccount).orderBy(asc(chartOfAccount.code));

  const dimensions = await tx.select().from(accountRequiredDimension);
  const declared = new Map<string, DimensionType[]>();
  for (const row of dimensions) {
    declared.set(row.accountId, [...(declared.get(row.accountId) ?? []), row.dimension]);
  }

  // D7 — resolved by walking down from the roots rather than by asking the
  // database once per account: a chart of a thousand accounts would otherwise
  // cost a thousand recursive queries to draw one screen. Same rule, computed
  // in the direction the tree is already being built.
  const byParent = new Map<string | null, typeof rows>();
  for (const row of rows) {
    byParent.set(row.parentId, [...(byParent.get(row.parentId) ?? []), row]);
  }

  const effective = new Map<string, DimensionType[]>();
  const walk = (parentId: string | null, inherited: DimensionType[]) => {
    for (const row of byParent.get(parentId) ?? []) {
      const own = row.declaresDimensions ? (declared.get(row.id) ?? []) : inherited;
      effective.set(row.id, own);
      walk(row.id, own);
    }
  };
  walk(null, []);

  const visible = options.includeInactive ? rows : rows.filter((r) => r.isActive || r.approvalStatus !== 'approved');

  return buildAccountTree(visible.map((row) => toNode(row, effective.get(row.id) ?? [])));
}

/** The accounts a journal may post to right now — active, approved, leaves. */
export async function postableAccounts(tx: Tx): Promise<AccountNode[]> {
  const rows = await tx
    .select()
    .from(chartOfAccount)
    .where(
      and(
        eq(chartOfAccount.isActive, true),
        eq(chartOfAccount.approvalStatus, 'approved'),
        eq(chartOfAccount.isGroup, false),
      ),
    )
    .orderBy(asc(chartOfAccount.code));

  return rows.map((row) => toNode(row));
}

/**
 * Changes what an account is called, and what it is for.
 *
 * "Edit" on an account (by direction, 2026-08-29): the name and the
 * description are the only things about an account that are typed rather
 * than derived — the code comes from the sequence, the type from the parent,
 * the currency from the ledger — so they are the only things to edit. Written
 * to the trail with before and after, because a renamed account reads
 * differently on every statement that follows.
 */
export async function updateDetails(
  tx: Tx,
  ctx: ActorContext,
  accountId: string,
  input: { readonly name: string; readonly description?: string | null },
): Promise<void> {
  await authz.authorize(ctx.principal, 'configure', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
    objectId: accountId,
    requestId: ctx.requestId ?? null,
  });

  const account = await loadAccount(tx, accountId);
  const name = input.name.trim();
  if (!name) throw new AccountPlacementError('An account needs a name.');
  const [row] = await tx
    .select({ description: chartOfAccount.description })
    .from(chartOfAccount)
    .where(eq(chartOfAccount.id, accountId))
    .limit(1);
  const description = input.description?.trim() || null;

  await tx
    .update(chartOfAccount)
    .set({ name, description, updatedAt: new Date() })
    .where(eq(chartOfAccount.id, accountId));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'chart_of_account.updated',
    objectType: PERMISSION_OBJECT,
    objectId: accountId,
    branchCode: ctx.branchCode,
    before: { name: account.name, description: row?.description ?? null },
    after: { code: account.code, name, description },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}
