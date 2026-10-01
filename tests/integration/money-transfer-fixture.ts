/**
 * Shared fixture for the Phase 09 integration tests — §12.
 *
 * Not a test file (vitest matches `*.test.ts`), so the four Phase 09 suites can
 * share one arrangement of the world without one of them owning it.
 *
 * ── What this configures, and why it is configuration ───────────────────────
 * The accounting mapping and the dimension policy are both *configuration* in
 * this system (§3.3, §4.2), not code. A test has to choose some, so it does —
 * and the choices are visible here rather than buried in a service, which is the
 * point the 09.8 gate makes when it asks for the mapping to be changeable
 * without a code change.
 */
import { randomUUID } from 'node:crypto';
import { ownerPool, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import type { ActorContext } from '@/server/services/chart-of-accounts';

export const BRANCH = 'BGW';

/**
 * A second branch, so tests that need a *different* branch have one.
 *
 * Two things need it: the edit lock, where setting `branch_code` to the value it
 * already holds is not a change and would pass a lock that works; and §22's data
 * scope, which cannot be shown to hide anything when there is only one branch to
 * hide.
 */
export const OTHER_BRANCH = 'BSR';

/** §12.4's line roles. Names, never account codes (§3.3). */
export const ROLES = [
  'bank',
  'client_clearing',
  'transfer_expense',
  'service_revenue',
  'client_inventory',
  'client_account',
] as const;

export type Role = (typeof ROLES)[number];

/** Every event the Money Transfer module posts. */
export const EVENTS = [
  'money_transfer.client_deposit',
  'money_transfer.initiated',
  'money_transfer.direct_expense',
  'money_transfer.returned',
  'money_transfer.client_refund',
  'money_transfer.result_recognised',
  'money_transfer.result_recognition_reversed',
  'money_transfer.client_import_payment',
  'money_transfer.client_goods_delivery',
] as const;

export interface MoneyTransferWorld {
  readonly clerk: ActorContext;
  readonly manager: ActorContext;
  /** A second manager, so maker-checker has somebody to be the checker. */
  readonly compliance: ActorContext;
  /**
   * Sees both branches. §12.5's example combines a client transfer with a
   * company import payment, and those need not share a branch — but composing a
   * batch that spans two means seeing both, which §5.1 makes a Super User
   * matter. Worth knowing: in this design a cross-branch bank debit can only be
   * assembled by someone with that reach.
   */
  readonly regional: ActorContext;
  readonly clientPartnerId: string;
  readonly clientPartnerCode: string;
  readonly vendorPartnerId: string;
  readonly bankAccountId: string;
  readonly accounts: Record<Role, string>;
  readonly rates: { officialId: string; clientId: string; marketId: string };
  readonly costCentreCode: string;
}

export async function createUser(
  role: string,
  options: { isSuperUser?: boolean; branches?: string[] } = {},
): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(
    `insert into app_user (id, email, display_name, is_super_user) values ($1,$2,$3,$4)`,
    [id, `${id}@example.com`, role, options.isSuperUser ?? false],
  );
  await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  for (const branch of options.branches ?? [BRANCH]) {
    await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [
      id,
      branch,
    ]);
  }
  const principal = await withScope({ userId: id, branchCode: BRANCH }, (tx) =>
    authz.loadPrincipal(tx, id),
  );
  return { principal, branchCode: BRANCH };
}

export const scopeOf = (ctx: ActorContext) => ({
  userId: ctx.principal.userId,
  branchCode: BRANCH,
  isSuperUser: ctx.principal.isSuperUser,
});

/**
 * Builds the world every Phase 09 suite starts from.
 *
 * Call after `resetTestData()`.
 */
export async function buildWorld(): Promise<MoneyTransferWorld> {
  // §21 puts storage and a malware scan in the upload pipeline, and an
  // unconfigured deployment refuses uploads rather than accepting them
  // unscanned. KYC evidence goes through that pipeline like everything else, so
  // the fixture has to stand something up. Both are Phase 01's mechanisms; what
  // is asserted here is only that Money Transfer uses them.
  const attachments = await import('@/server/services/attachments');
  const files = new Map<string, Buffer>();
  attachments.registerStorage({
    put: async (key, content) => void files.set(key, content),
    get: async (key) => files.get(key) ?? null,
  });
  attachments.registerScanner(() => ({ status: 'clean' }));

  await seedBranch(BRANCH, 'Baghdad');
  await seedBranch(OTHER_BRANCH, 'Basra');

  const clerk = await createUser('accounting_officer');
  const manager = await createUser('accounting_manager');
  const compliance = await createUser('accounting_manager');
  const regional = await createUser('accounting_manager', {
    isSuperUser: true,
    branches: [BRANCH, OTHER_BRANCH],
  });

  // §6 — one Business Partner record serves Money Transfer like every other
  // module. The client holds the customer role because they buy a service.
  const { rows: client } = await ownerPool.query(
    `insert into business_partner (code, legal_name, is_customer, status, active)
     values ('MTC-001','Al-Rafidain Trading', true, 'active', true) returning id, code`,
  );
  const { rows: vendor } = await ownerPool.query(
    `insert into business_partner (code, legal_name, is_supplier, status, active)
     values ('SUP-900','Overseas Goods Supplier', true, 'active', true) returning id`,
  );

  await ownerPool.query(
    `insert into cost_centre (code, name, branch_code) values ('CC-MT','Money Transfer',$1)
     on conflict do nothing`,
    [BRANCH],
  );

  await ownerPool.query(
    `insert into fiscal_year (code, name, starts_on, ends_on, status)
     values ('FY2026','2026','2026-01-01','2026-12-31','open') on conflict do nothing`,
  );
  const { rows: years } = await ownerPool.query(`select id from fiscal_year where code = 'FY2026'`);
  for (const [no, name, from, to] of [
    [2, 'February 2026', '2026-02-01', '2026-02-28'],
    [3, 'March 2026', '2026-03-01', '2026-03-31'],
  ] as const) {
    await ownerPool.query(
      `insert into fiscal_period (fiscal_year_id, period_no, name, starts_on, ends_on)
       values ($1,$2,$3,$4,$5) on conflict do nothing`,
      [years[0].id, no, name, from, to],
    );
  }

  // §12.2's two rates, both published through the Phase 02 engine (§14.3). The
  // `market` rate exists only so a test can prove the transfer refuses it.
  const rateIds: Record<string, string> = {};
  for (const [type, value] of [
    ['accounting', '1450.00000000'],
    ['client', '1500.00000000'],
    ['market', '1475.00000000'],
  ] as const) {
    const { rows } = await ownerPool.query(
      `insert into exchange_rate (currency_code, rate_type, iqd_per_unit, effective_from, entered_by)
       values ('USD',$1,$2,'2026-01-01',$3) returning id`,
      [type, value, manager.principal.userId],
    );
    rateIds[type] = rows[0].id;
  }

  // The company bank account seeded with the branch, and the G/L account behind
  // it — so the bank ledger and the cash master agree by construction.
  const { rows: cash } = await ownerPool.query(
    `select id, gl_account_id from bank_cash_account where code = $1`,
    [`CASH-${BRANCH}`],
  );

  const accounts = { bank: cash[0].gl_account_id } as Record<Role, string>;

  // ── The accounting mapping (§12.4: "configured through Accounting Mapping;
  // they are not hard-coded"). Every account here is invented by the fixture;
  // no service knows any of these codes.
  for (const [role, root, name, control] of [
    ['client_clearing', 'L000001', 'Client Clearing (Client A/P-Type)', 'customer'],
    ['client_account', 'L000001', 'Client Account', 'customer'],
    ['client_inventory', 'A000001', 'Client Inventory', null],
    ['transfer_expense', 'X000001', 'Money Transfer Direct Expense', null],
    ['service_revenue', 'R000001', 'Money Transfer Service Result', null],
  ] as const) {
    const { rows: parents } = await ownerPool.query(
      `select id, account_type from chart_of_account where code = $1`,
      [root],
    );
    const { rows } = await ownerPool.query(
      `insert into chart_of_account
         (code, name, account_type, parent_id, is_group, is_active, approval_status, level,
          currency_restriction, control_account)
       values ($1,$2,$3,$4,false,true,'approved',1,'IQD',$5) returning id`,
      [`MT-${role.toUpperCase()}`, name, parents[0].account_type, parents[0].id, control],
    );
    accounts[role] = rows[0].id;
  }

  // §3.3 — one rule per event and role. The resolver reads these; nothing else
  // decides an account.
  for (const event of EVENTS) {
    for (const role of ROLES) {
      await ownerPool.query(
        `insert into posting_rule (event_type, line_role, account_id, description)
         values ($1,$2,$3,$4) on conflict do nothing`,
        [event, role, accounts[role], `Phase 09 fixture mapping for ${event}/${role}`],
      );
    }
  }

  // §4.2 — the dimension policy is configuration, and the account-type defaults
  // (expense → department + business line, revenue → business line) are a
  // company default rather than a Money Transfer one. A transfer has no
  // department; §12.5 gives its lines a cost centre instead. Set here, at the
  // document-type layer, which is exactly where §4.2 puts an override.
  for (const documentType of [
    'money_transfer',
    'money_transfer_deposit',
    'money_transfer_expense',
    'client_import_payment',
    'client_goods_delivery',
  ]) {
    for (const dimension of ['department', 'business_line']) {
      await ownerPool.query(
        `insert into document_type_dimension (document_type_code, dimension, requirement)
         values ($1,$2,'optional') on conflict (document_type_code, dimension)
         do update set requirement = 'optional'`,
        [documentType, dimension],
      );
    }
  }

  return {
    clerk,
    manager,
    compliance,
    regional,
    clientPartnerId: client[0].id,
    clientPartnerCode: client[0].code,
    vendorPartnerId: vendor[0].id,
    bankAccountId: cash[0].id,
    accounts,
    rates: {
      officialId: rateIds.accounting!,
      clientId: rateIds.client!,
      marketId: rateIds.market!,
    },
    costCentreCode: 'CC-MT',
  };
}

/**
 * Raises and approves a KYC record so a transfer can be initiated.
 *
 * Two different users, because §5.2 separates raising from approving and the
 * service refuses a self-approval — which the 09.1 suite asserts in its own
 * right rather than relying on this.
 */
export async function approveKycFor(
  world: MoneyTransferWorld,
  partnerId: string,
  options: { expiresOn?: string | null } = {},
): Promise<string> {
  const client = await import('@/server/services/money-transfer-client');

  // Two transactions under two scopes, so each act runs as the person doing it
  // rather than as whoever opened the connection.
  const raised = await withScope(scopeOf(world.clerk), async (tx) => {
    const record = await client.raiseKyc(tx, world.clerk, {
      partnerId,
      expiresOn: options.expiresOn ?? null,
    });
    await client.submitKyc(tx, world.clerk, record.id);
    return record;
  });

  await withScope(scopeOf(world.compliance), (tx) =>
    client.approveKyc(tx, world.compliance, raised.id),
  );

  return raised.id;
}
