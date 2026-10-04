/**
 * The world the Control Center and Related records suites share — platform phase, Agent 9.
 *
 * One import taken the whole way, then a customer and a supplier around it, all through the services (nothing
 * is written to a document table by hand):
 *
 *   Import      500 panels bought · one B/L, two containers (300 + 200) · a PD and its declaration, cleared ·
 *               customs and freight charged · both containers received · the PD written off · landed cost locked
 *   Customer    100 panels sold · part paid · 10 taken back · the credit note posted
 *   Supplier    a purchase order for 10 panels, received into stock (a goods receipt) · a payment
 *
 * Every posting role that must be mapped is mapped (`mapEveryRole`), a fiscal year covers today, the bank is
 * funded: this is the books of a business that has done its work properly, so the Control Center's checks have
 * something honest to say "ok" about.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { expect } from 'vitest';
import { ownerPool, seedBranch } from './setup';
import {
  BAGHDAD,
  PANEL,
  WAREHOUSE,
  blWith,
  buildImportWorld,
  charge,
  importOf,
  iqd,
  lock,
  pdTo,
  q,
  receive,
  registerPd,
  scope,
  type ImportWorld,
} from './logistics-fixture';
import { containerNo } from '../support/container-number';
import { withScope } from '@/server/db/client';
import { registerAttachmentRuntime } from '@/server/attachments-runtime';
import { can } from '@/server/domain/permissions';
import { POSTING_MAP, mappingAccountEligible, requiredControlAccount } from '@/server/domain/posting-map';
import { screenRoutes } from '@/server/domain/screens';
import { registerAllRecords } from '@/server/records';
import * as ar from '@/server/services/ar-invoice';
import * as authz from '@/server/services/authorization';
import * as declarations from '@/server/services/customs-declarations';
import * as gr from '@/server/services/goods-receipt';
import * as memos from '@/server/services/customer-credit-memo';
import * as po from '@/server/services/purchase-order';
import * as receipts from '@/server/services/customer-receipt';
import * as sr from '@/server/services/sales-return';
import * as pay from '@/server/services/supplier-payment';
import type { ActorContext } from '@/server/services/chart-of-accounts';

export const ERBIL = 'ERB';

export interface Person extends ActorContext {
  readonly id: string;
  readonly name: string;
}

/** A user with the roles given, in one branch (and the Finance department when it is Baghdad). */
export async function person(name: string, roles: readonly string[], branch: string = BAGHDAD): Promise<Person> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [id, `${id}@example.com`, name]);
  // A sign-in (the Users screen lists the accounts that have one).
  await ownerPool.query(`insert into auth_account (id, user_id, account_id, provider_id) values ($1,$2::uuid,$2::text,'credential')`, [randomUUID(), id]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code, is_default) values ($1,$2,true)`, [id, branch]);
  for (const role of roles) await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  if (branch === BAGHDAD) await ownerPool.query(`insert into user_department_scope (user_id, department_code) values ($1,'FIN') on conflict do nothing`, [id]);
  const principal = await withScope({ userId: id, branchCode: branch }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: branch, id, name };
}

/** Runs `fn` in the scoped transaction of `p` — the way a page does. */
export const as = <T>(p: ActorContext, fn: (tx: Parameters<Parameters<typeof withScope>[1]>[0]) => Promise<T>) =>
  withScope({ userId: p.principal.userId, branchCode: p.branchCode ?? BAGHDAD }, fn);

/**
 * Every posting role a document cannot post without (and every foreign-exchange role) gets an account the
 * Posting Mappings screen would accept for it: the fixture's own account of that name where there is one, else
 * the first account that is eligible. Roles already mapped to an eligible account are left alone. Returns how
 * many rules it made or mended.
 */
export async function mapEveryRole(world: ImportWorld): Promise<number> {
  const { rows: accounts } = await ownerPool.query(
    `select id::text, code, account_type::text as "accountType", control_account::text as "controlAccount"
       from chart_of_account where is_active and approval_status = 'approved' and not is_group order by code`,
  );
  const { rows: rules } = await ownerPool.query(
    `select id, event_type, line_role, account_id::text as "accountId" from posting_rule
      where is_active and item_group is null and partner_group is null and warehouse_code is null and project_code is null and branch_code is null`,
  );
  const mapped = new Map<string, { id: string; accountId: string }>(rules.map((r) => [`${r.event_type} ${r.line_role}`, { id: r.id as string, accountId: r.accountId as string }]));
  type Account = { id: string; code: string; accountType: string; controlAccount: string | null };
  const eligible = (event: string, role: string): Account | undefined => {
    const preferred = world.accounts[role];
    const list = accounts as Account[];
    return (
      list.find((a) => a.id === preferred && mappingAccountEligible(event, role, a as never)) ??
      list.find((a) => mappingAccountEligible(event, role, a as never))
    );
  };
  let changed = 0;
  for (const document of POSTING_MAP) {
    for (const line of document.lines) {
      const fx = /exchange|revaluation/.test(line.role);
      if (!line.always && !fx) continue;
      const rule = mapped.get(`${document.event} ${line.role}`);
      const current = rule ? (accounts as Account[]).find((a) => a.id === rule.accountId) : undefined;
      if (current && mappingAccountEligible(document.event, line.role, current as never)) continue;
      let chosen = eligible(document.event, line.role);
      if (!chosen) {
        // A role that needs a control account the chart does not have yet (the loan book's): the chart gets one.
        const kind = requiredControlAccount(document.event, line.role);
        if (!kind) throw new Error(`no account can take ${document.event} / ${line.role}`);
        const { rows: parent } = await ownerPool.query(`select id, account_type::text as t from chart_of_account where code = 'L000001'`);
        const { rows: made } = await ownerPool.query(
          `insert into chart_of_account (code, name, account_type, parent_id, is_group, is_active, approval_status, level, currency_restriction, control_account)
           values ($1,$2,$3,$4,false,true,'approved',1,'IQD',$5) returning id::text, code, account_type::text as "accountType", control_account::text as "controlAccount"`,
          [`L98${String(accounts.length + 1).padStart(4, '0')}`, `${kind} control`, parent[0].t, parent[0].id, kind],
        );
        chosen = made[0] as Account;
        (accounts as Account[]).push(chosen);
      }
      if (rule) {
        await ownerPool.query(`update posting_rule set account_id = $2 where id = $1`, [rule.id, chosen.id]);
      } else {
        await ownerPool.query(
          `insert into posting_rule (event_type, line_role, account_id, is_active, created_by) values ($1,$2,$3,true,$4)`,
          [document.event, line.role, chosen.id, world.manager.principal.userId],
        );
      }
      changed += 1;
    }
  }
  return changed;
}

export const FIRST_BOX = containerNo('MSCU', 760001);
export const SECOND_BOX = containerNo('MSCU', 760002);

export interface ChainWorld extends ImportWorld {
  readonly imp: { invoiceId: string; invoiceNo: string; payableId: string; payableNo: string };
  readonly bl: { blId: string; blNo: string; containerIds: string[] };
  readonly pd: { id: string; pdNo: string };
  readonly declarationNo: string;
  readonly lockId: string;
  readonly receiptNos: string[];
  readonly sale: { id: string; invoiceNo: string; lineId: string };
  readonly customerReceiptNo: string;
  readonly salesReturnNo: string;
  readonly creditMemoNo: string;
  readonly order: { id: string; orderNo: string };
  readonly goodsReceiptNo: string;
  readonly paymentNo: string;
}

const scalar = async (text: string, params: unknown[]): Promise<string> => (await ownerPool.query(text, params)).rows[0]?.v as string;

/** Builds the whole world (it resets the test database first). */
export async function buildChainWorld(): Promise<ChainWorld> {
  const world = await buildImportWorld();
  registerAllRecords();
  registerAttachmentRuntime();
  await seedBranch(ERBIL, 'Erbil');
  await mapEveryRole(world);
  // The goods receipt is posted by the stock engine under its own event, which the Posting Mappings screen does not list.
  for (const role of ['inventory', 'grni'] as const) {
    await ownerPool.query(
      `insert into posting_rule (event_type, line_role, account_id, is_active, created_by) values ('inventory.goods_receipt',$1,$2,true,$3)`,
      [role, world.accounts[role], world.manager.principal.userId],
    );
  }

  // -- The import, shipped, cleared, received, costed -----------------------------------------------------
  const imp = await importOf(world, '500', { reference: 'CC-CHAIN' });
  const payableNo = await scalar(`select payable_no as v from payable where id = $1`, [imp.payableId]);
  const bl = await blWith(
    world,
    imp.payableId,
    [
      { no: FIRST_BOX, qty: '300' },
      { no: SECOND_BOX, qty: '200' },
    ],
    { eta: '2026-08-25' },
  );
  const pd = await registerPd(world, imp.payableId, '9331');
  await pdTo(world, pd.id, 'validated', '2026-07-05');
  const declared = await withScope(scope(world.clerk), (tx) =>
    declarations.create(tx, world.clerk, {
      payableId: imp.payableId,
      pdId: pd.id,
      declarationDate: '2026-08-20',
      currency: 'IQD',
      declaredValue: iqd('5000000'),
      declaredDuty: iqd('250000'),
      declaredTaxes: iqd('50000'),
      declaredFees: iqd('20000'),
      hsCode: '8541.43',
    }),
  );
  const move = (to: string, extra: Partial<declarations.MoveInput> = {}) =>
    withScope(scope(world.clerk), (tx) => declarations.move(tx, world.clerk, declared.id, { to, on: '2026-08-21', ...extra }));
  await move('submitted');
  await move('accepted', { customsRef: 'BG-2026-77881' });
  await move('assessed');
  await move('cleared', { on: '2026-08-22' });
  await charge(world, imp.payableId, 'customs_asycuda', '300000');
  await charge(world, imp.payableId, 'freight', '200000');
  const first = await receive(world, bl.containerIds[0]!, { on: '2026-08-28' });
  await pdTo(world, pd.id, 'totally_written_off', '2026-08-29');
  const second = await receive(world, bl.containerIds[1]!, { on: '2026-09-10' });
  const locked = await lock(world, imp.payableId, { basisCode: 'by_quantity', lockDate: '2026-09-12' });

  // -- The customer: a sale, a part payment, a return and its credit note ---------------------------------
  const sold = await withScope(scope(world.clerk), (tx) =>
    ar.createDirect(tx, world.clerk, {
      customerId: world.customerId,
      branchCode: BAGHDAD,
      invoiceDate: '2026-09-15',
      dueDate: '2026-10-15',
      lines: [{ itemCode: PANEL, quantity: q('100'), unitPriceIqd: iqd('15000'), warehouseCode: WAREHOUSE }],
    }),
  );
  await withScope(scope(world.manager), (tx) => ar.approve(tx, world.manager, sold.id));
  await withScope(scope(world.manager), (tx) => ar.post(tx, world.manager, sold.id));
  const saleLine = await scalar(`select id::text as v from ar_invoice_line where ar_invoice_id = $1 order by line_no limit 1`, [sold.id]);
  const received = await withScope(scope(world.manager), (tx) =>
    receipts.create(tx, world.manager, {
      customerId: world.customerId,
      branchCode: BAGHDAD,
      receiptDate: '2026-09-20',
      bankCashAccountId: world.bankAccountId,
      amountIqd: iqd('500000'),
      bankReference: 'CC-TRF-1',
    }),
  );
  await withScope(scope(world.manager), (tx) => receipts.approve(tx, world.manager, received.id));
  await withScope(scope(world.manager), (tx) => receipts.post(tx, world.manager, received.id));
  // Applied to the invoice it paid part of (the receipt's money and the invoice's balance move together).
  await withScope(scope(world.manager), (tx) =>
    receipts.allocate(tx, world.manager, received.id, [{ arInvoiceId: sold.id, amountIqd: iqd('500000') }]),
  );

  const back = await withScope(scope(world.clerk), (tx) =>
    sr.request(tx, world.clerk, {
      arInvoiceId: sold.id,
      requestedOn: '2026-09-25',
      reason: 'Customer ordered the wrong panel',
      offsetKind: 'receivable',
      lines: [{ arInvoiceLineId: saleLine, quantity: q('10') }],
    }),
  );
  const view = await withScope(scope(world.manager), (tx) => sr.view(tx, back.id));
  await withScope(scope(world.manager), (tx) =>
    sr.receiveGoods(tx, world.manager, back.id, { receivedOn: '2026-09-25', lines: [{ salesReturnLineId: view.lines[0]!.id, quantity: q('10') }] }),
  );
  await withScope(scope(world.manager), (tx) =>
    sr.inspect(tx, world.manager, back.id, [{ salesReturnLineId: view.lines[0]!.id, acceptedQuantity: q('10'), disposition: 'saleable', destinationWarehouseCode: WAREHOUSE }]),
  );
  await withScope(scope(world.manager), (tx) => sr.accept(tx, world.manager, back.id));
  const memo = await withScope(scope(world.clerk), (tx) => memos.create(tx, world.clerk, { salesReturnId: back.id, memoDate: '2026-09-25' }));
  await withScope(scope(world.manager), (tx) => memos.approve(tx, world.manager, memo.id));
  await withScope(scope(world.manager), (tx) => memos.post(tx, world.manager, memo.id));

  // -- The supplier: an order received into stock, and a payment ------------------------------------------
  const order = await withScope(scope(world.clerk), (tx) =>
    po.create(tx, world.clerk, {
      supplierId: world.supplierId,
      branchCode: BAGHDAD,
      orderDate: '2026-09-01',
      lines: [
        {
          lineType: 'inventory_item',
          itemCode: PANEL,
          description: 'Solar Panel 550W',
          quantity: q('10'),
          uomCode: 'EA',
          unitPriceIqd: iqd('10000'),
          branchCode: BAGHDAD,
          warehouseCode: WAREHOUSE,
        },
      ],
    }),
  );
  await withScope(scope(world.clerk), (tx) => po.submit(tx, world.clerk, order.id));
  await withScope(scope(world.manager), (tx) => po.approve(tx, world.manager, order.id));
  const orderLine = await scalar(`select id::text as v from purchase_order_line where purchase_order_id = $1 order by line_no limit 1`, [order.id]);
  const goods = await withScope(scope(world.clerk), (tx) =>
    gr.create(tx, world.clerk, {
      purchaseOrderId: order.id,
      branchCode: BAGHDAD,
      receiptDate: '2026-09-05',
      lines: [{ purchaseOrderLineId: orderLine, quantity: q('10'), batchNumber: 'CC-B-1' }],
    }),
  );
  await withScope(scope(world.clerk), (tx) => gr.submit(tx, world.clerk, goods.id));
  await withScope(scope(world.manager), (tx) => gr.post(tx, world.manager, goods.id));
  const payment = await withScope(scope(world.clerk), (tx) =>
    pay.create(tx, world.clerk, {
      supplierId: world.supplierId,
      bankCashAccountId: world.bankAccountId,
      branchCode: BAGHDAD,
      paymentDate: '2026-09-18',
      amountIqd: iqd('1000000'),
      reference: 'CC-PAY-1',
    }),
  );
  await withScope(scope(world.manager), (tx) => pay.post(tx, world.manager, payment.id));

  return {
    ...world,
    imp: { ...imp, payableNo },
    bl: { blId: bl.blId, blNo: bl.blNo, containerIds: bl.containerIds },
    pd: { id: pd.id, pdNo: await scalar(`select pd_no as v from customs_pd where id = $1`, [pd.id]) },
    declarationNo: declared.declarationNo,
    lockId: (locked as { id?: string }).id ?? (await scalar(`select id::text as v from landed_cost_lock where payable_id = $1 limit 1`, [imp.payableId])),
    receiptNos: [first.receiptNo, second.receiptNo],
    sale: { id: sold.id, invoiceNo: await scalar(`select invoice_no as v from ar_invoice where id = $1`, [sold.id]), lineId: saleLine },
    customerReceiptNo: await scalar(`select receipt_no as v from customer_receipt where id = $1`, [received.id]),
    salesReturnNo: await scalar(`select return_no as v from sales_return where id = $1`, [back.id]),
    creditMemoNo: await scalar(`select memo_no as v from customer_credit_memo where id = $1`, [memo.id]),
    order: { id: order.id, orderNo: await scalar(`select order_no as v from purchase_order where id = $1`, [order.id]) },
    goodsReceiptNo: await scalar(`select receipt_no as v from goods_receipt where id = $1`, [goods.id]),
    paymentNo: await scalar(`select payment_no as v from supplier_payment where id = $1`, [payment.id]),
  };
}

/**
 * The damage a maintenance script can do with the triggers off — the only way a fault the application's own doors
 * refuse can get into the books. Session-level so the rows go in whole; always reset.
 */
export async function maintenance<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await ownerPool.connect();
  try {
    await client.query('set session_replication_role = replica');
    return await fn(client);
  } finally {
    await client.query('reset session_replication_role');
    client.release();
  }
}

export type Undo = () => Promise<void>;

/** The `beforeFiles` rewrites of `next.config.ts` (a route that lives under another folder): `/inventory/items/:code` is a page of `master-data/items`. */
function rewritten(path: string): string {
  const config = readFileSync(join(process.cwd(), 'next.config.ts'), 'utf8');
  const block = config.slice(config.indexOf('async rewrites()'));
  for (const match of block.matchAll(/source:\s*'([^']+)',\s*destination:\s*'([^']+)'/g)) {
    const [, source, destination] = match as unknown as [string, string, string];
    const names = [...source.matchAll(/:(\w+)/g)].map((m) => m[1]!);
    const pattern = new RegExp('^' + source.replace(/:(\w+)/g, '([^/]+)') + '$');
    const hit = pattern.exec(path);
    if (!hit) continue;
    return names.reduce((to, name, i) => to.replace(':' + name, hit[i + 1]!), destination);
  }
  return path;
}

/** Does `href` name a page of the application? Route groups are transparent; `[x]` matches any one segment. */
export function pageExists(href: string): boolean {
  const path = rewritten(href.split(/[?#]/)[0]!).replace(/^\/+|\/+$/g, '');
  const segments = path === '' ? [] : path.split('/');
  const walk = (dir: string, rest: readonly string[]): boolean => {
    const dirs = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
    if (rest.length === 0) {
      return existsSync(join(dir, 'page.tsx')) || dirs.filter((e) => /^\(.+\)$/.test(e.name)).some((e) => walk(join(dir, e.name), rest));
    }
    const [head, ...tail] = rest as [string, ...string[]];
    return dirs.some((e) => {
      if (/^\(.+\)$/.test(e.name)) return walk(join(dir, e.name), rest);
      if (e.name === head) return walk(join(dir, e.name), tail);
      return /^\[[^.\]]+\]$/.test(e.name) && walk(join(dir, e.name), tail);
    });
  };
  return walk(join(process.cwd(), 'src', 'app'), segments);
}

/** The permission object of the screen a path belongs to: the path itself, else the list it hangs from. */
export function objectOfHref(href: string): string | undefined {
  const routes = screenRoutes();
  let path = href.split(/[?#]/)[0]!.replace(/\/+$/, '');
  while (path.length > 0) {
    const found = routes.get(path);
    if (found) return found.item.object;
    path = path.replace(/\/[^/]*$/, '');
  }
  return undefined;
}

/** An item's path must open a page that exists and that the viewer may enter. */
export function expectOpenable(p: ActorContext, href: string | null) {
  expect(href, 'an item without a path').toBeTruthy();
  expect(href!.startsWith('/')).toBe(true);
  expect(pageExists(href!), `${href} is a page of the application`).toBe(true);
  const object = objectOfHref(href!);
  expect(object, `${href} belongs to a screen of the menu`).toBeDefined();
  expect(can(p.principal, 'view', object!), `the viewer may open ${href} (${object})`).toBe(true);
}
