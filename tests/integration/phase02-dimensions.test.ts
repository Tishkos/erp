/**
 * Phase 02.4 — the dimensions framework, against a real PostgreSQL instance.
 *
 * §4.2 makes a dimension mandatory "by account and document type". These tests
 * prove the resolution against real configuration rows, and prove the two
 * refusals the domain cannot make on its own: a value that does not exist in
 * its master, and a dimension whose master does not exist yet.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as coa from '@/server/services/chart-of-accounts';
import * as dimensions from '@/server/services/dimensions';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import {
  DimensionNotAvailableError,
  MissingDimensionsError,
} from '@domain/dimensions';
import type { AccountNode } from '@domain/chart-of-accounts';

const BAGHDAD = 'BGW';
const FINANCE = 'FIN';
const DOCUMENT_TYPE = 'chart_of_account';

let officer: ActorContext;
let manager: ActorContext;
let expenseRootId: string;
let revenueRootId: string;
let assetsRootId: string;

async function createUser(roleCode: string | null): Promise<string> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [
    id,
    `${id}@example.com`,
    'Test User',
  ]);
  if (roleCode) {
    await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [
      id,
      roleCode,
    ]);
  }
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [
    id,
    BAGHDAD,
  ]);
  return id;
}

async function contextFor(userId: string): Promise<ActorContext> {
  const principal = await withScope({ userId, branchCode: BAGHDAD }, (tx) =>
    authz.loadPrincipal(tx, userId),
  );
  return { principal, branchCode: BAGHDAD };
}

const scopeOf = (ctx: ActorContext) => ({ userId: ctx.principal.userId, branchCode: BAGHDAD });

/** Officer raises, manager approves. */
async function approvedAccount(input: coa.CreateAccountInput): Promise<AccountNode> {
  const account = await withScope(scopeOf(officer), (tx) =>
    coa.createAccount(tx, officer, {
      // D7: a posting account needs a currency. Tests that care pass their own.
      currencyRestriction: input.isGroup ? null : 'IQD',
      ...input,
    }),
  );
  await withScope(scopeOf(officer), (tx) => coa.submitForApproval(tx, officer, account.id));
  await withScope(scopeOf(manager), (tx) => coa.approve(tx, manager, account.id));
  return withScope(scopeOf(manager), (tx) => coa.loadAccount(tx, account.id));
}

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');
  await ownerPool.query(`insert into department (code, name) values ($1,$2), ($3,$4)`, [
    FINANCE,
    'Finance',
    'SLS',
    'Sales',
  ]);
  officer = await contextFor(await createUser('accounting_officer'));
  manager = await contextFor(await createUser('accounting_manager'));

  const { rows } = await ownerPool.query(
    `select id, code from chart_of_account where is_system`,
  );
  assetsRootId = rows.find((r) => r.code === 'A000001').id;
  revenueRootId = rows.find((r) => r.code === 'R000001').id;
  expenseRootId = rows.find((r) => r.code === 'X000001').id;
});

// ---------------------------------------------------------------------------
describe('the registry of the seven dimensions', () => {
  it('registers all seven, with six usable once Phase 03 masters exist', async () => {
    const registry = await withScope(scopeOf(manager), (tx) => dimensions.definitions(tx));

    expect(registry).toHaveLength(7);

    const available = registry.filter((d) => d.sourceTable !== null).map((d) => d.dimension);
    expect(available.sort()).toEqual([
      'branch',
      'business_line',
      'business_partner',
      'department',
      'project',
      'warehouse',
    ]);
  });

  it('leaves Employee without a source — its master is Phase 15', async () => {
    // The registry is where the dependency on a later phase is visible rather
    // than assumed. Six were unlocked by Phase 03; this one waits for HR.
    const registry = await withScope(scopeOf(manager), (tx) => dimensions.definitions(tx));
    const pending = registry.filter((d) => d.sourceTable === null).map((d) => d.dimension);

    expect(pending).toEqual(['employee']);
  });

  it('refuses to make an account require a dimension that has no master data', async () => {
    // Otherwise the account would demand an Employee before the HR master exists,
    // and every posting to it would fail with no way to satisfy the rule.
    const account = await approvedAccount({ name: 'Stock on Hand', parentId: assetsRootId });

    // The account has to be declaring its own rules first (D7), or the rule it
    // is refused for is the wrong one — inheritance, not availability.
    await ownerPool.query(
      `update chart_of_account set declares_dimensions = true where id = $1`,
      [account.id],
    );

    const message = await rejection(
      ownerPool.query(
        `insert into account_required_dimension (account_id, dimension) values ($1, 'employee')`,
        [account.id],
      ),
    );
    expect(message).toMatch(/has no master data yet and cannot be made mandatory/);
  });

  it('refuses it through the service too, with a message that says when it will work', async () => {
    const account = await approvedAccount({ name: 'Stock on Hand', parentId: assetsRootId });

    await expect(
      withScope(scopeOf(manager), (tx) =>
        dimensions.setAccountRequirements(tx, manager, account.id, ['employee']),
      ),
    ).rejects.toThrow(DimensionNotAvailableError);
  });
});

// ---------------------------------------------------------------------------
describe('§4.2 · resolving a requirement from account and document type', () => {
  it('applies the account-type default to an expense account', async () => {
    // Migration 0005 seeds §4.2's own rule: Cost Centre and Business Line are
    // mandatory for operating expense accounts.
    const salaries = await approvedAccount({ name: 'Salaries', parentId: expenseRootId });

    const mandatory = await withScope(scopeOf(manager), (tx) =>
      dimensions.mandatoryFor(tx, salaries, DOCUMENT_TYPE),
    );
    expect(mandatory).toEqual(['department', 'business_line']);
  });

  it('applies Business Line to a revenue account', async () => {
    const sales = await approvedAccount({ name: 'Trading Revenue', parentId: revenueRootId });

    const mandatory = await withScope(scopeOf(manager), (tx) =>
      dimensions.mandatoryFor(tx, sales, DOCUMENT_TYPE),
    );
    expect(mandatory).toEqual(['business_line']);
  });

  it('requires nothing by default on an asset account', async () => {
    const cash = await approvedAccount({ name: 'Cash on Hand', parentId: assetsRootId });

    const mandatory = await withScope(scopeOf(manager), (tx) =>
      dimensions.mandatoryFor(tx, cash, DOCUMENT_TYPE),
    );
    expect(mandatory).toEqual([]);
  });

  it('lets an account require a dimension its type does not (§14.3)', async () => {
    const cash = await approvedAccount({ name: 'Cash on Hand', parentId: assetsRootId });

    await withScope(scopeOf(manager), (tx) =>
      dimensions.setAccountRequirements(tx, manager, cash.id, ['department']),
    );

    const mandatory = await withScope(scopeOf(manager), (tx) =>
      dimensions.mandatoryFor(tx, cash, DOCUMENT_TYPE),
    );
    expect(mandatory).toEqual(['department']);
  });

  it('lets a document type relax what the account requires', async () => {
    // The 02.4 gate: "The same account can be mandatory for one document type
    // and optional for another, if so configured."
    const salaries = await approvedAccount({ name: 'Salaries', parentId: expenseRootId });

    const before = await withScope(scopeOf(manager), (tx) =>
      dimensions.mandatoryFor(tx, salaries, DOCUMENT_TYPE),
    );
    expect(before).toContain('department');

    await withScope(scopeOf(manager), (tx) =>
      dimensions.setDocumentTypeRequirement(tx, manager, DOCUMENT_TYPE, 'department', 'optional'),
    );

    const after = await withScope(scopeOf(manager), (tx) =>
      dimensions.mandatoryFor(tx, salaries, DOCUMENT_TYPE),
    );
    expect(after).not.toContain('department');
    expect(after).toContain('business_line');
  });

  it('lets a document type add a requirement the account does not have', async () => {
    // §4.2 — "Branch: mandatory for all operational transactions."
    const cash = await approvedAccount({ name: 'Cash on Hand', parentId: assetsRootId });

    await withScope(scopeOf(manager), (tx) =>
      dimensions.setDocumentTypeRequirement(tx, manager, DOCUMENT_TYPE, 'branch', 'mandatory'),
    );

    const mandatory = await withScope(scopeOf(manager), (tx) =>
      dimensions.mandatoryFor(tx, cash, DOCUMENT_TYPE),
    );
    expect(mandatory).toEqual(['branch']);
  });

  it('restores the account and type rules when the override is cleared', async () => {
    const salaries = await approvedAccount({ name: 'Salaries', parentId: expenseRootId });

    await withScope(scopeOf(manager), (tx) =>
      dimensions.setDocumentTypeRequirement(tx, manager, DOCUMENT_TYPE, 'department', 'optional'),
    );
    await withScope(scopeOf(manager), (tx) =>
      dimensions.clearDocumentTypeRequirement(tx, manager, DOCUMENT_TYPE, 'department'),
    );

    const mandatory = await withScope(scopeOf(manager), (tx) =>
      dimensions.mandatoryFor(tx, salaries, DOCUMENT_TYPE),
    );
    expect(mandatory).toContain('department');
  });

  it('refuses an Accounting Officer configuring a requirement', async () => {
    await expect(
      withScope(scopeOf(officer), (tx) =>
        dimensions.setDocumentTypeRequirement(tx, officer, DOCUMENT_TYPE, 'branch', 'mandatory'),
      ),
    ).rejects.toThrow(/Permission denied/);
  });

  it('audits a requirement change', async () => {
    await withScope(scopeOf(manager), (tx) =>
      dimensions.setDocumentTypeRequirement(tx, manager, DOCUMENT_TYPE, 'branch', 'mandatory'),
    );

    const { rows } = await ownerPool.query(
      `select action, after_value from audit_event where action = 'dimension.requirement_configured'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].after_value).toMatchObject({ dimension: 'branch', requirement: 'mandatory' });
  });
});

// ---------------------------------------------------------------------------
describe('validating the dimensions on a posting', () => {
  it('rejects an expense posting with no Cost Centre, naming what is missing', async () => {
    const salaries = await approvedAccount({ name: 'Salaries', parentId: expenseRootId });

    await expect(
      withScope(scopeOf(officer), (tx) =>
        dimensions.assertDimensionsValid(tx, salaries, DOCUMENT_TYPE, {}),
      ),
    ).rejects.toThrow(MissingDimensionsError);

    await expect(
      withScope(scopeOf(officer), (tx) =>
        dimensions.assertDimensionsValid(tx, salaries, DOCUMENT_TYPE, {}),
      ),
    ).rejects.toThrow(/Department \/ Cost Centre, Business Line/);
  });

  it('accepts one that carries everything required, with real values', async () => {
    const cash = await approvedAccount({ name: 'Cash on Hand', parentId: assetsRootId });
    await withScope(scopeOf(manager), (tx) =>
      dimensions.setAccountRequirements(tx, manager, cash.id, ['department']),
    );

    await expect(
      withScope(scopeOf(officer), (tx) =>
        dimensions.assertDimensionsValid(tx, cash, DOCUMENT_TYPE, { department: FINANCE }),
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects a value that is not in its master', async () => {
    const cash = await approvedAccount({ name: 'Cash on Hand', parentId: assetsRootId });

    await expect(
      withScope(scopeOf(officer), (tx) =>
        dimensions.assertDimensionsValid(tx, cash, DOCUMENT_TYPE, { department: 'NOPE' }),
      ),
    ).rejects.toThrow(/'NOPE' is not an active Department \/ Cost Centre/);
  });

  it('rejects a value whose master record has been deactivated', async () => {
    const cash = await approvedAccount({ name: 'Cash on Hand', parentId: assetsRootId });
    await ownerPool.query(`update department set active = false where code = $1`, ['SLS']);

    await expect(
      withScope(scopeOf(officer), (tx) =>
        dimensions.assertDimensionsValid(tx, cash, DOCUMENT_TYPE, { department: 'SLS' }),
      ),
    ).rejects.toThrow(/is not an active Department/);
  });

  it('rejects a value for a dimension whose master does not exist yet', async () => {
    // Storing an unverifiable Employee code now would hand Phase 15 a column
    // full of typos.
    const cash = await approvedAccount({ name: 'Cash on Hand', parentId: assetsRootId });

    await expect(
      withScope(scopeOf(officer), (tx) =>
        dimensions.assertDimensionsValid(tx, cash, DOCUMENT_TYPE, { employee: 'EMP-1' }),
      ),
    ).rejects.toThrow(DimensionNotAvailableError);
  });

  it('accepts a branch value against the Phase 01 branch master', async () => {
    const cash = await approvedAccount({ name: 'Cash on Hand', parentId: assetsRootId });

    await expect(
      withScope(scopeOf(officer), (tx) =>
        dimensions.assertDimensionsValid(tx, cash, DOCUMENT_TYPE, { branch: BAGHDAD }),
      ),
    ).resolves.toBeUndefined();

    await expect(
      withScope(scopeOf(officer), (tx) =>
        dimensions.assertDimensionsValid(tx, cash, DOCUMENT_TYPE, { branch: 'NOWHERE' }),
      ),
    ).rejects.toThrow(/is not an active Branch/);
  });

  it('reports what each field requires, for a screen to render', async () => {
    const salaries = await approvedAccount({ name: 'Salaries', parentId: expenseRootId });

    const requirements = await withScope(scopeOf(manager), (tx) =>
      dimensions.requirementsFor(tx, salaries, DOCUMENT_TYPE),
    );

    expect(requirements.department).toBe('mandatory');
    expect(requirements.business_line).toBe('mandatory');
    expect(requirements.project).toBe('optional');
    expect(requirements.branch).toBe('optional');
  });

  it('answers "which accounts need a cost centre?"', async () => {
    const cash = await approvedAccount({ name: 'Cash on Hand', parentId: assetsRootId });
    await withScope(scopeOf(manager), (tx) =>
      dimensions.setAccountRequirements(tx, manager, cash.id, ['department']),
    );

    const accounts = await withScope(scopeOf(manager), (tx) =>
      dimensions.accountsRequiring(tx, 'department'),
    );
    expect(accounts).toEqual([cash.id]);
  });

  it('replaces an account’s requirements rather than adding to them', async () => {
    const cash = await approvedAccount({ name: 'Cash on Hand', parentId: assetsRootId });

    await withScope(scopeOf(manager), (tx) =>
      dimensions.setAccountRequirements(tx, manager, cash.id, ['department', 'branch']),
    );
    await withScope(scopeOf(manager), (tx) =>
      dimensions.setAccountRequirements(tx, manager, cash.id, ['branch']),
    );

    const mandatory = await withScope(scopeOf(manager), (tx) =>
      dimensions.mandatoryFor(tx, cash, DOCUMENT_TYPE),
    );
    expect(mandatory).toEqual(['branch']);
  });
});
