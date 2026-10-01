/**
 * The world the ap01 suites share — REQ-AP-001 Stage 1.
 *
 * A branch with its main warehouse (seedBranch provides both), a finance
 * department, an accounting manager scoped to them, a supplier, and a USD
 * rate so a payable's IQD figure exists. Items and accounts are deliberately
 * absent: Stage 1's payables carry free-text model lines, and the PO the PI
 * becomes holds them as service lines — the item master joins in Stage 2.
 */
import { randomUUID } from 'node:crypto';
import { ownerPool } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as rates from '@/server/services/exchange-rates';
import type { ActorContext } from '@/server/services/chart-of-accounts';

export const BRANCH = 'BGW';

export interface PayablesWorld {
  readonly manager: ActorContext;
  readonly officer: ActorContext;
  readonly supplierId: string;
  readonly supplierCode: string;
}

export const scope = (ctx: ActorContext) => ({
  userId: ctx.principal.userId,
  branchCode: BRANCH,
});

async function actor(role: 'accounting_manager' | 'accounting_officer'): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [
    id,
    `${id}@example.com`,
    role === 'accounting_manager' ? 'Payables Manager' : 'Payables Officer',
  ]);
  await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [
    id,
    BRANCH,
  ]);
  await ownerPool.query(
    `insert into user_department_scope (user_id, department_code) values ($1,'FIN')`,
    [id],
  );
  const principal = await withScope({ userId: id, branchCode: BRANCH }, (tx) =>
    authz.loadPrincipal(tx, id),
  );
  return { principal, branchCode: BRANCH };
}

export async function buildPayablesWorld(): Promise<PayablesWorld> {
  const { seedBranch } = await import('./setup');
  await seedBranch(BRANCH, 'Baghdad');
  await ownerPool.query(
    `insert into department (code, name, is_finance) values ('FIN','Finance',true)
     on conflict (code) do nothing`,
  );

  const manager = await actor('accounting_manager');
  const officer = await actor('accounting_officer');

  const supplierCode = 'SUP-CSA';
  const { rows } = await ownerPool.query(
    `insert into business_partner (code, legal_name, is_customer, is_supplier, status)
     values ($1,'CSA Solar Co','false','true','active') returning id`,
    [supplierCode],
  );

  await withScope(scope(manager), (tx) =>
    rates.publishRate(tx, manager, {
      currency: 'USD',
      iqdPerUnit: '1310.00000000',
      effectiveFrom: '2026-01-01',
    }),
  );

  return { manager, officer, supplierId: rows[0].id as string, supplierCode };
}

/** The sheet's own first import, as the A1 fixture. */
export const IMPORT_INPUT = (world: PayablesWorld) =>
  ({
    payableTypeCode: 'import',
    supplierReference: 'CSA-AL0001-1',
    supplierId: world.supplierId,
    branchCode: BRANCH,
    currency: 'USD',
    documentDate: '2026-09-01',
    description: 'panel & batteries',
    paymentTermsText: 'TT 10% deposit, 90% balance against B/L in 60 days',
    lines: [
      { description: 'AIKO 1500 panel', quantity: '5040', uomCode: 'EA', unitPrice: '100.0000' },
      { description: 'Battery 48V', quantity: '200', uomCode: 'EA', unitPrice: '350.0000' },
    ],
  }) as const;

/** A posted purchase invoice row, inserted directly — the pipeline has its own suites. */
export async function postedInvoice(
  world: PayablesWorld,
  input: { invoiceNo: string; totalIqd: string; payableId?: string | null; status?: string },
): Promise<string> {
  const { rows } = await ownerPool.query(
    `insert into ap_invoice
       (id, invoice_no, supplier_invoice_no, supplier_id, branch_code, invoice_date, due_date,
        total_iqd, settled_amount_iqd, status, created_by, payable_id,
        non_po_justification, non_po_approved_by, non_po_approved_at)
     values (gen_random_uuid(), $1, $1 || '-SUP', $2, $3, '2026-09-10'::date, '2026-11-01'::date,
             $4, 0, $5, $6, $7, 'Payables fixture', $6, now())
     returning id`,
    [
      input.invoiceNo,
      world.supplierId,
      BRANCH,
      input.totalIqd,
      input.status ?? 'posted',
      world.manager.principal.userId,
      input.payableId ?? null,
    ],
  );
  return rows[0].id as string;
}

/** Events of one payable, oldest first — what the log would print. */
export async function eventsOf(payableId: string): Promise<
  { eventCode: string; laneCode: string; summary: string }[]
> {
  const { rows } = await ownerPool.query(
    `select event_code as "eventCode", lane_code as "laneCode", summary
       from payable_event where payable_id = $1 order by recorded_at, id`,
    [payableId],
  );
  return rows;
}
