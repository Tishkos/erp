/**
 * The chart of accounts this company actually needs, and the mappings that
 * make it post — REQ-AP-001, REQ-APP-001 §2.
 *
 * The live books were opened with three accounts: trade receivables, trade
 * payables and opening balance equity. That was enough to carry the old
 * system's balances in and nothing else — the first stock purchase invoice
 * refused to post, because an item with no inventory account has nowhere to
 * hold its stock, and there was no inventory account in the chart to give it.
 *
 * So this builds the chart a trading company that imports needs, and maps
 * every posting the code can make. Both halves matter: a chart nobody has
 * mapped is a list of names, and a mapping to an account that does not exist
 * is a document that will not post.
 *
 * ── What decided the shape ──────────────────────────────────────────────────
 * Not a textbook. `domain/posting-map.ts` lists twenty-three events and the
 * roles each one posts, and every role here exists because some document in
 * this system needs somewhere to put a figure:
 *
 *   the goods      inventory, goods in transit, GRNI, landed cost clearing,
 *                  purchase price variance, inventory adjustments
 *   the money      bank and cash, supplier advances, customer advances,
 *                  unidentified receipts, exchange gain and loss
 *   the loans      loan liability, interest, bank commission
 *   the projects   WIP, retention, deferred revenue, revenue, material,
 *                  labour and its absorption, assets under construction
 *   the trade      sales, sales returns, cost of sales, and the operating
 *                  expenses a company has whether or not software models them
 *
 * Codes are not chosen here: each type's counter allocates them (A1000xx,
 * L1000xx and so on), which is the rule the Chart of Accounts screen follows
 * and the reason two people adding accounts cannot collide.
 *
 * ── Safe to run twice ───────────────────────────────────────────────────────
 * An account is matched by name under its parent; one that is already there
 * is left exactly as it is, including a name the accountant has since
 * corrected. A mapping already pointing somewhere is not moved — if the
 * company has decided that landed cost belongs on a different account, that
 * decision stands. Nothing is deleted, nothing is deactivated.
 *
 *   npx tsx scripts/ops/ensure-chart-of-accounts.ts [--branch HQ] [--dry-run]
 */
import 'dotenv/config';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { applyScope, db, type Tx } from '../../src/server/db/client';
import { chartOfAccount, item, postingRule } from '../../src/server/db/schema';
import * as authz from '../../src/server/services/authorization';
import * as coa from '../../src/server/services/chart-of-accounts';
import * as posting from '../../src/server/services/posting';
import type { ActorContext } from '../../src/server/services/chart-of-accounts';

type Kind = 'customer' | 'supplier' | 'inventory' | 'loan';

interface Leaf {
  readonly name: string;
  /** The posting roles this account answers for, if any. */
  readonly roles?: readonly string[];
  readonly control?: Kind;
  readonly currency?: string;
}

interface Group {
  readonly name: string;
  /** The seeded type root this hangs under. */
  readonly root: string;
  readonly children: readonly Leaf[];
}

/*
 * Every role in `domain/posting-map.ts` appears exactly once below, against
 * the account that should carry it. `bank` is deliberately absent: the bank
 * side of a payment is the account the money actually left, which is a
 * property of the payment and not a mapping.
 */
const CHART: readonly Group[] = [
  {
    name: 'Current assets',
    root: 'A000001',
    children: [
      { name: 'Cash on hand' },
      { name: 'Cash on hand (USD)', currency: 'USD' },
      { name: 'Bank current account' },
      { name: 'Bank current account (USD)', currency: 'USD' },
      // Trade Receivables is already in the books and already mapped; it is
      // named here so a fresh database gets it too.
      { name: 'Trade Receivables', roles: ['customer_receivable'], control: 'customer' },
      { name: 'Other receivables' },
      { name: 'Advances to suppliers', roles: ['supplier_advance'] },
      { name: 'Prepaid expenses' },
      { name: 'Customs duty and deposits recoverable' },
    ],
  },
  {
    name: 'Inventory',
    root: 'A000001',
    children: [
      // The account every item holds its stock in, and the one a project's
      // material issue takes it out of.
      { name: 'Inventory — goods for resale', roles: ['inventory'], control: 'inventory' },
      // Goods owned and at sea. The stock itself sits in the In Process
      // warehouse; this is where its value sits until the file is closed.
      { name: 'Goods in transit' },
      // §9.2 — freight, duty and the rest, parked until the landed cost is
      // locked and spread over the goods.
      { name: 'Landed cost clearing', roles: ['landed_cost_clearing'] },
    ],
  },
  {
    name: 'Non-current assets',
    root: 'A000001',
    children: [
      { name: 'Property, plant and equipment' },
      { name: 'Vehicles' },
      { name: 'Furniture and office equipment' },
      { name: 'Accumulated depreciation' },
      // Where a project's cost settles when it builds something.
      { name: 'Assets under construction', roles: ['project_auc'] },
    ],
  },
  {
    name: 'Current liabilities',
    root: 'L000001',
    children: [
      { name: 'Trade Payables', roles: ['supplier_payable'], control: 'supplier' },
      // The receipt debited it; the invoice clears it.
      { name: 'Goods received not invoiced', roles: ['grni'] },
      { name: 'Customer advances and deposits' },
      // Money in that no customer has been put to yet. It waits here rather
      // than being guessed at.
      { name: 'Unidentified receipts', roles: ['customer_clearing'] },
      { name: 'Goods returned to suppliers — clearing', roles: ['return_clearing'] },
      { name: 'Accrued expenses' },
      { name: 'Salaries and wages payable' },
      { name: 'Taxes payable' },
      { name: 'Project deferred revenue', roles: ['project_deferred_revenue'] },
    ],
  },
  {
    name: 'Non-current liabilities',
    root: 'L000001',
    children: [{ name: 'Bank loans', roles: ['loan_liability'], control: 'loan' }],
  },
  {
    name: 'Capital and reserves',
    root: 'E000001',
    children: [
      { name: 'Share capital' },
      { name: 'Opening Balance Equity', roles: ['opening_balance'] },
      { name: 'Retained earnings' },
    ],
  },
  {
    name: 'Trading revenue',
    root: 'R000001',
    children: [
      { name: 'Sales — solar equipment', roles: ['sales_revenue'] },
      { name: 'Sales — motorcycles' },
      { name: 'Sales — spare parts and accessories' },
      { name: 'Project revenue', roles: ['project_revenue'] },
      { name: 'Other income' },
      { name: 'Foreign exchange gain', roles: ['exchange_gain'] },
    ],
  },
  {
    name: 'Cost of sales',
    root: 'X000001',
    children: [
      { name: 'Cost of goods sold' },
      { name: 'Sales returns', roles: ['sales_returns'] },
      { name: 'Freight and shipping' },
      { name: 'Customs duty and clearance' },
      // §8.4 — ordered against billed. It never enters the value of stock.
      { name: 'Purchase price variance', roles: ['purchase_variance'] },
      { name: 'Inventory adjustments and write-offs', roles: ['inventory_adjustment'] },
      { name: 'Project material cost', roles: ['project_material_cost'] },
      { name: 'Project labour cost', roles: ['project_labour'] },
      // The credit side of a timesheet: labour charged to a project leaves
      // the expense it was paid from.
      { name: 'Labour absorption', roles: ['labour_absorption'] },
      { name: 'Project work in progress', roles: ['project_wip'] },
      { name: 'Project cost settlement', roles: ['project_cost'] },
    ],
  },
  {
    name: 'Operating expenses',
    root: 'X000001',
    children: [
      // Where a service line goes when nothing was received into a warehouse.
      { name: 'General and administrative expenses', roles: ['expense'] },
      { name: 'Salaries and wages' },
      { name: 'Rent' },
      { name: 'Utilities' },
      { name: 'Travel and transport' },
      { name: 'Marketing and advertising' },
      { name: 'Professional and legal fees' },
      { name: 'Repairs and maintenance' },
      { name: 'Depreciation' },
    ],
  },
  {
    name: 'Financial expenses',
    root: 'X000001',
    children: [
      { name: 'Bank charges and commission', roles: ['bank_commission'] },
      { name: 'Interest on loans', roles: ['loan_interest'] },
      { name: 'Foreign exchange loss', roles: ['exchange_loss'] },
    ],
  },
];

/** Retention is a receivable the customer holds back; it needs their control. */
const RETENTION: Leaf = {
  name: 'Project retention receivable',
  roles: ['project_retention_receivable'],
  control: 'customer',
};

function argument(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

async function accountByName(tx: Tx, name: string, parentId: string | null) {
  const [row] = await tx
    .select({ id: chartOfAccount.id, code: chartOfAccount.code, name: chartOfAccount.name })
    .from(chartOfAccount)
    .where(
      and(
        sql`lower(btrim(${chartOfAccount.name})) = ${name.trim().toLowerCase()}`,
        parentId === null ? isNull(chartOfAccount.parentId) : eq(chartOfAccount.parentId, parentId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * The same account by name anywhere of that type, wherever it hangs.
 *
 * The live books were opened before any of these groups existed, so Trade
 * Receivables, Trade Payables and Opening Balance Equity sit straight under
 * their type roots. Looking only inside the new folder would make a second
 * Trade Receivables and leave the company with two control accounts for one
 * thing — which the dry run showed it about to do. An account that is already
 * in the books is adopted where it stands and never moved: its code is on
 * every journal line that has ever used it.
 */
type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

async function accountByNameInType(tx: Tx, name: string, accountType: AccountType) {
  const [row] = await tx
    .select({ id: chartOfAccount.id, code: chartOfAccount.code, name: chartOfAccount.name })
    .from(chartOfAccount)
    .where(
      and(
        sql`lower(btrim(${chartOfAccount.name})) = ${name.trim().toLowerCase()}`,
        eq(chartOfAccount.accountType, accountType),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function rootByCode(tx: Tx, code: string) {
  const [row] = await tx
    .select({ id: chartOfAccount.id, code: chartOfAccount.code, accountType: chartOfAccount.accountType })
    .from(chartOfAccount)
    .where(eq(chartOfAccount.code, code))
    .limit(1);
  if (!row) throw new Error(`The type root ${code} is not in the chart; the database has not been seeded.`);
  return row;
}

async function main(): Promise<void> {
  const branchCode = argument('branch') ?? 'HQ';
  const dryRun = process.argv.includes('--dry-run');
  const url = process.env.DATABASE_URL ?? '';
  console.log(`database: ${url.replace(/:[^:@]*@/, ':***@') || '(unset)'}`);
  console.log(`branch:   ${branchCode}${dryRun ? '   (dry run — nothing is written)' : ''}`);
  console.log('');

  await db.transaction(async (tx) => {
    // Row level security is on, so a script that writes says who it is. An
    // accounting manager: building the chart is their permission, and this
    // must not need a super user.
    const [who] = (
      await tx.execute(sql`
        SELECT u.id
          FROM app_user u
          JOIN user_role r ON r.user_id = u.id
         WHERE r.role_code = 'accounting_manager' AND u.is_active
         ORDER BY u.created_at
         LIMIT 1
      `)
    ).rows as { id: string }[];
    if (!who) throw new Error('No active accounting manager to build the chart as.');

    await applyScope(tx, { userId: who.id, branchCode });
    const principal = await authz.loadPrincipal(tx, who.id);
    const ctx: ActorContext = { principal, branchCode };

    const roleAccount = new Map<string, { id: string; code: string }>();
    let madeGroups = 0;
    let madeLeaves = 0;

    for (const group of CHART) {
      const root = await rootByCode(tx, group.root);
      let folder = await accountByName(tx, group.name, root.id);
      if (!folder && !dryRun) {
        const made = await coa.createAccount(tx, ctx, { name: group.name, parentId: root.id, isGroup: true });
        folder = { id: made.id, code: made.code, name: made.name };
        madeGroups += 1;
        console.log(`created group   ${made.code}  ${made.name}`);
      } else if (!folder) {
        console.log(`would create group   ${group.name}  under ${root.code}`);
      }

      const children = group.name === 'Current assets' ? [...group.children, RETENTION] : group.children;
      for (const leaf of children) {
        // Inside the folder first, then anywhere of that type. The live books
        // were opened before any of these groups existed, so Trade
        // Receivables and its two companions sit straight under their roots —
        // an account already in use is adopted where it stands, never
        // duplicated and never moved, because its code is on every journal
        // line that has ever used it.
        let account =
          (folder ? await accountByName(tx, leaf.name, folder.id) : null) ??
          (await accountByNameInType(tx, leaf.name, root.accountType));

        if (!account) {
          if (dryRun || !folder) {
            console.log(`  would create  ${leaf.name}`);
            continue;
          }
          const made = await coa.createAccount(tx, ctx, {
            name: leaf.name,
            parentId: folder.id,
            isGroup: false,
            currencyRestriction: leaf.currency ?? 'IQD',
            ...(leaf.control ? { controlAccount: leaf.control } : {}),
          });
          account = { id: made.id, code: made.code, name: made.name };
          madeLeaves += 1;
          console.log(`  created       ${made.code}  ${made.name}`);
        }

        for (const role of leaf.roles ?? []) roleAccount.set(role, { id: account.id, code: account.code });
      }
    }

    console.log('');
    console.log(`accounts: ${madeGroups} group(s) and ${madeLeaves} posting account(s) created`);

    // ── The mappings ────────────────────────────────────────────────────────
    // Every (event, role) the code can post, pointed at the account that
    // carries it. A rule that already exists is left alone: the company may
    // have decided differently, and that decision outranks this file.
    const wanted: { event: string; role: string }[] = [];
    const map = (await import('../../src/server/domain/posting-map')).POSTING_MAP;
    for (const document of map) {
      for (const entry of document.lines) {
        if (entry.role === 'bank') continue; // the account the money left, not a mapping
        wanted.push({ event: document.event, role: entry.role });
      }
    }

    let mapped = 0;
    const unmapped: string[] = [];
    for (const { event, role } of wanted) {
      const [existing] = await tx
        .select({ id: postingRule.id })
        .from(postingRule)
        .where(
          and(
            eq(postingRule.eventType, event),
            eq(postingRule.lineRole, role),
            isNull(postingRule.itemGroup),
            isNull(postingRule.partnerGroup),
            isNull(postingRule.warehouseCode),
            isNull(postingRule.projectCode),
            isNull(postingRule.branchCode),
          ),
        )
        .limit(1);
      if (existing) continue;

      const account = roleAccount.get(role);
      if (!account) {
        unmapped.push(`${event} / ${role}`);
        continue;
      }
      if (dryRun) {
        console.log(`would map  ${event} / ${role}  ->  ${account.code}`);
        continue;
      }
      await posting.defineRule(tx, ctx, {
        eventType: event,
        lineRole: role,
        accountId: account.id,
        description: 'Set up with the chart of accounts.',
      });
      mapped += 1;
      console.log(`mapped  ${event.padEnd(38)} ${role.padEnd(28)} -> ${account.code}`);
    }

    console.log('');
    console.log(`mappings: ${mapped} added`);
    if (unmapped.length > 0) {
      console.log('');
      console.log('no account for these roles — they need a decision:');
      for (const entry of [...new Set(unmapped)]) console.log(`  ${entry}`);
    }

    // ── The items ───────────────────────────────────────────────────────────
    // Every item holds its stock somewhere. An item with none cannot be
    // bought, sold or counted, which is the refusal that started this.
    const inventory = roleAccount.get('inventory');
    if (!inventory && !dryRun) {
      throw new Error('No inventory account was found or created; items cannot be pointed at one.');
    }

    const counted = (
      await tx.execute(sql`SELECT count(*)::int AS n FROM item WHERE inventory_account_id IS NULL`)
    ).rows as { n: number }[];
    const without = counted[0]?.n ?? 0;

    if (without === 0) {
      console.log('');
      console.log('items: every item already names an inventory account');
    } else if (dryRun || !inventory) {
      console.log('');
      console.log(`items: would point ${without} item(s) at the inventory account`);
    } else {
      await tx
        .update(item)
        .set({ inventoryAccountId: inventory.id, updatedAt: new Date() })
        .where(isNull(item.inventoryAccountId));
      console.log('');
      console.log(`items: ${without} item(s) now hold their stock in ${inventory.code}`);
    }

    if (dryRun) throw new Error('dry run — rolled back on purpose');
  });

  process.exit(0);
}

main().catch((error) => {
  if (error instanceof Error && error.message.startsWith('dry run')) {
    console.log('');
    console.log('dry run finished; nothing was written.');
    process.exit(0);
  }
  console.error(error);
  process.exit(1);
});
