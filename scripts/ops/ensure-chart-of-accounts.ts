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
import type { AccountMappingInput } from '../../src/server/domain/financial-statements';

type Kind = 'customer' | 'supplier' | 'inventory' | 'loan';

interface Leaf {
  readonly name: string;
  /** The posting roles this account answers for, if any. */
  readonly roles?: readonly string[];
  readonly control?: Kind;
  readonly currency?: string;
  /** Where it prints on each statement (Phase 1 §5) — the seeded line codes. */
  readonly lines?: AccountMappingInput;
}

interface Group {
  readonly name: string;
  /** The seeded type root this hangs under. */
  readonly root: string;
  readonly children: readonly Leaf[];
}

/*
 * Where each kind of account prints. The Balance Sheet would fall back on the
 * account type without these, but the Cash Flow deliberately does not — an
 * account it has not been told about lands in "Not yet classified" — so every
 * account is filed on both faces from the day it is opened.
 */
const CASH: AccountMappingInput = { balance_sheet: 'cash_and_equivalents', cash_flow: 'cash_flow_cash' };
const RECEIVABLE: AccountMappingInput = { balance_sheet: 'current_assets', cash_flow: 'cf_receivables' };
const STOCK: AccountMappingInput = { balance_sheet: 'current_assets', cash_flow: 'cf_inventory' };
const FIXED: AccountMappingInput = { balance_sheet: 'non_current_assets', cash_flow: 'cf_equipment' };
const DEPRECIATED: AccountMappingInput = { balance_sheet: 'non_current_assets', cash_flow: 'cf_depreciation' };
const PAYABLE: AccountMappingInput = { balance_sheet: 'current_liabilities', cash_flow: 'cf_payables' };
const LONG_TERM: AccountMappingInput = { balance_sheet: 'non_current_liabilities', cash_flow: 'cf_payables' };
const LOAN: AccountMappingInput = { balance_sheet: 'non_current_liabilities', cash_flow: 'cf_loan' };
const CAPITAL: AccountMappingInput = { balance_sheet: 'equity', cash_flow: 'cf_capital', changes_in_equity: 'equity_paid_in' };
const EQUITY: AccountMappingInput = { balance_sheet: 'equity' };
const REVENUE: AccountMappingInput = { income_statement: 'revenue' };
const OTHER_INCOME: AccountMappingInput = { income_statement: 'other_income' };
const COST: AccountMappingInput = { income_statement: 'cost_of_sales' };
const OPEX: AccountMappingInput = { income_statement: 'operating_expenses' };
const FINANCE: AccountMappingInput = { income_statement: 'finance_costs' };
const TAX: AccountMappingInput = { income_statement: 'tax_expense' };

/*
 * Every role in `domain/posting-map.ts` appears exactly once below, against
 * the account that should carry it. `bank` is deliberately absent: the bank
 * side of a payment is the account the money actually left, which is a
 * property of the payment and not a mapping.
 *
 * The company (2026-10-04, by direction — "the chart of accounts, fully,
 * related to our work"): Qimah Al-Safinah imports and sells solar equipment,
 * motorcycles and their spare parts, installs solar projects, borrows from
 * banks against its imports, and pays a staff through payroll. The payroll
 * roles HR-3/HR-4/HR-6 added (salary, employer cost, withholding, net pay,
 * employee advances, expense claims) are carried here too.
 */
const CHART: readonly Group[] = [
  {
    name: 'Current assets',
    root: 'A000001',
    children: [
      { name: 'Cash on hand', lines: CASH },
      { name: 'Cash on hand (USD)', currency: 'USD', lines: CASH },
      { name: 'Petty cash', lines: CASH },
      { name: 'Bank current account', lines: CASH },
      { name: 'Bank current account (USD)', currency: 'USD', lines: CASH },
      // Trade Receivables is already in the books and already mapped; it is
      // named here so a fresh database gets it too.
      { name: 'Trade Receivables', roles: ['customer_receivable'], control: 'customer', lines: RECEIVABLE },
      { name: 'Other receivables', lines: RECEIVABLE },
      // HR-4: an advance or loan to a member of staff, recovered through payroll.
      { name: 'Employee advances and loans', roles: ['employee_advance'], lines: RECEIVABLE },
      { name: 'Advances to suppliers', roles: ['supplier_advance'], lines: RECEIVABLE },
      // The bank holds a margin against every letter of credit an import is paid by.
      { name: 'Letters of credit and bank margin deposits', lines: RECEIVABLE },
      { name: 'Prepaid expenses', lines: RECEIVABLE },
      { name: 'Customs duty and deposits recoverable', lines: RECEIVABLE },
    ],
  },
  {
    name: 'Inventory',
    root: 'A000001',
    children: [
      // The account every item holds its stock in, and the one a project's
      // material issue takes it out of.
      { name: 'Inventory — goods for resale', roles: ['inventory'], control: 'inventory', lines: STOCK },
      // Goods owned and at sea. The stock itself sits in the In Process
      // warehouse; this is where its value sits until the file is closed.
      { name: 'Goods in transit', lines: STOCK },
      // §9.2 — freight, duty and the rest, parked until the landed cost is
      // locked and spread over the goods.
      { name: 'Landed cost clearing', roles: ['landed_cost_clearing'], lines: STOCK },
      // Work done on a project and not yet billed is an asset until it is.
      { name: 'Project work in progress', roles: ['project_wip'], lines: STOCK },
    ],
  },
  {
    name: 'Non-current assets',
    root: 'A000001',
    children: [
      { name: 'Property, plant and equipment', lines: FIXED },
      { name: 'Land and buildings', lines: FIXED },
      { name: 'Installation tools and equipment', lines: FIXED },
      { name: 'Vehicles', lines: FIXED },
      { name: 'Furniture and office equipment', lines: FIXED },
      { name: 'Computers and IT equipment', lines: FIXED },
      { name: 'Software and other intangible assets', lines: FIXED },
      { name: 'Accumulated depreciation', lines: DEPRECIATED },
      // Where a project's cost settles when it builds something.
      { name: 'Assets under construction', roles: ['project_auc'], lines: FIXED },
    ],
  },
  {
    name: 'Current liabilities',
    root: 'L000001',
    children: [
      { name: 'Trade Payables', roles: ['supplier_payable'], control: 'supplier', lines: PAYABLE },
      // The receipt debited it; the invoice clears it.
      { name: 'Goods received not invoiced', roles: ['grni'], lines: PAYABLE },
      { name: 'Customer advances and deposits', lines: PAYABLE },
      // Money in that no customer has been put to yet. It waits here rather
      // than being guessed at.
      { name: 'Unidentified receipts', roles: ['customer_clearing'], lines: PAYABLE },
      { name: 'Goods returned to suppliers — clearing', roles: ['return_clearing'], lines: PAYABLE },
      { name: 'Accrued expenses', lines: PAYABLE },
      // HR-3 — what a payroll run owes its people once everything is deducted
      // (a role named "payable" must be a supplier control account, hence net_pay).
      { name: 'Salaries and wages payable', roles: ['net_pay'], lines: PAYABLE },
      // HR-3 — income tax and social security held back from pay, owed to the state.
      { name: 'Payroll deductions payable — tax and social security', roles: ['payroll_withholding'], lines: PAYABLE },
      { name: 'Taxes payable', lines: PAYABLE },
      { name: 'Project deferred revenue', roles: ['project_deferred_revenue'], lines: PAYABLE },
      // What the solar warranties may yet cost.
      { name: 'Warranty provision', lines: PAYABLE },
    ],
  },
  {
    name: 'Non-current liabilities',
    root: 'L000001',
    children: [
      { name: 'Bank loans', roles: ['loan_liability'], control: 'loan', lines: LOAN },
      { name: 'Provision for end-of-service benefits', lines: LONG_TERM },
    ],
  },
  {
    name: 'Capital and reserves',
    root: 'E000001',
    children: [
      { name: 'Share capital', lines: CAPITAL },
      { name: "Partners' current accounts", lines: { balance_sheet: 'equity', cash_flow: 'cf_capital' } },
      // The Companies Law sets a share of each year's profit aside.
      { name: 'Statutory reserve', lines: EQUITY },
      { name: 'Opening Balance Equity', roles: ['opening_balance'], lines: EQUITY },
      { name: 'Retained earnings', lines: { balance_sheet: 'equity', changes_in_equity: 'equity_retained' } },
    ],
  },
  {
    name: 'Trading revenue',
    root: 'R000001',
    children: [
      // Each product line's sales are the item's own sales account; a sale of
      // an item that names none lands in "other goods", where it is seen,
      // rather than in one of the lines, where it would be believed.
      { name: 'Sales — solar equipment', lines: REVENUE },
      { name: 'Sales — motorcycles', lines: REVENUE },
      { name: 'Sales — spare parts and accessories', lines: REVENUE },
      { name: 'Sales — other goods', roles: ['sales_revenue'], lines: REVENUE },
      { name: 'Installation and service revenue', lines: REVENUE },
      { name: 'Project revenue', roles: ['project_revenue'], lines: REVENUE },
      { name: 'Other income', lines: OTHER_INCOME },
      { name: 'Foreign exchange gain', roles: ['exchange_gain'], lines: OTHER_INCOME },
      // A loan's revaluation moves no money; its gain is kept apart from a realised one.
      { name: 'Unrealised foreign exchange gain', lines: OTHER_INCOME },
    ],
  },
  {
    name: 'Cost of sales',
    root: 'X000001',
    children: [
      { name: 'Cost of goods sold', lines: COST },
      // Each item names its own cost account (ar-invoice › stockAccountsFor);
      // these give each product line its own gross margin.
      { name: 'Cost of goods sold — solar equipment', lines: COST },
      { name: 'Cost of goods sold — motorcycles', lines: COST },
      { name: 'Cost of goods sold — spare parts and accessories', lines: COST },
      { name: 'Sales returns', roles: ['sales_returns'], lines: COST },
      // A credit note gives money back without goods coming back.
      { name: 'Sales discounts and allowances', lines: COST },
      { name: 'Freight and shipping', lines: COST },
      { name: 'Customs duty and clearance', lines: COST },
      // §8.4 — ordered against billed. It never enters the value of stock.
      { name: 'Purchase price variance', roles: ['purchase_variance'], lines: COST },
      { name: 'Inventory adjustments and write-offs', roles: ['inventory_adjustment'], lines: COST },
      { name: 'Project material cost', roles: ['project_material_cost'], lines: COST },
      { name: 'Project labour cost', roles: ['project_labour'], lines: COST },
      // The credit side of a timesheet: labour charged to a project leaves
      // the expense it was paid from.
      { name: 'Labour absorption', roles: ['labour_absorption'], lines: COST },
      { name: 'Project cost settlement', roles: ['project_cost'], lines: COST },
      { name: 'Warranty and after-sales cost', lines: COST },
    ],
  },
  {
    name: 'Operating expenses',
    root: 'X000001',
    children: [
      // Where a service line goes when nothing was received into a warehouse.
      { name: 'General and administrative expenses', roles: ['expense'], lines: OPEX },
      { name: 'Salaries and wages', roles: ['salary_expense'], lines: OPEX },
      { name: 'Employer social security contributions', roles: ['payroll_employer_cost'], lines: OPEX },
      // HR-6 — what staff spent on the company's behalf and claimed back.
      { name: 'Employee expense claims', roles: ['employee_expense'], lines: OPEX },
      { name: 'Rent', lines: OPEX },
      { name: 'Utilities', lines: OPEX },
      { name: 'Communications and internet', lines: OPEX },
      { name: 'Travel and transport', lines: OPEX },
      { name: 'Vehicle fuel and maintenance', lines: OPEX },
      { name: 'Marketing and advertising', lines: OPEX },
      { name: 'Professional and legal fees', lines: OPEX },
      { name: 'Government fees and licences', lines: OPEX },
      { name: 'Insurance', lines: OPEX },
      { name: 'Repairs and maintenance', lines: OPEX },
      { name: 'Office supplies and printing', lines: OPEX },
      { name: 'Depreciation', lines: OPEX },
      { name: 'Bad and doubtful debts', lines: OPEX },
    ],
  },
  {
    name: 'Financial expenses',
    root: 'X000001',
    children: [
      { name: 'Bank charges and commission', roles: ['bank_commission'], lines: FINANCE },
      { name: 'Letter of credit charges', lines: FINANCE },
      { name: 'Loan fees and commission', lines: FINANCE },
      { name: 'Interest on loans', roles: ['loan_interest'], lines: FINANCE },
      { name: 'Foreign exchange loss', roles: ['exchange_loss'], lines: FINANCE },
      { name: 'Unrealised foreign exchange loss', lines: FINANCE },
    ],
  },
  {
    name: 'Income tax',
    root: 'X000001',
    children: [{ name: 'Income tax expense', lines: TAX }],
  },
];

/** Retention is a receivable the customer holds back; it needs their control. */
const RETENTION: Leaf = {
  name: 'Project retention receivable',
  roles: ['project_retention_receivable'],
  control: 'customer',
  lines: RECEIVABLE,
};

/*
 * Where one role means two things. A rule is per event and role, so the same
 * role can post to a different account in a different document — which is
 * the only narrowing worth having here. (Rules narrowed by warehouse were
 * considered and left out: goods valued into "Goods in transit" by the
 * warehouse they arrive in would never be moved out of it, because no
 * document posts the transfer from the transit warehouse to the store.)
 */
const EVENT_ACCOUNTS: readonly { readonly event: string; readonly role: string; readonly account: string }[] = [
  // A credit note is a price allowance; a credit memo is goods coming back.
  { event: 'sales.customer_credit_note', role: 'sales_returns', account: 'Sales discounts and allowances' },
  // Revaluing a loan moves no money: unrealised, apart from the realised kind.
  { event: 'treasury.loan_revaluation', role: 'exchange_gain', account: 'Unrealised foreign exchange gain' },
  { event: 'treasury.loan_revaluation', role: 'exchange_loss', account: 'Unrealised foreign exchange loss' },
  // What borrowing costs, apart from what banking costs day to day.
  { event: 'treasury.loan_disbursement', role: 'bank_commission', account: 'Loan fees and commission' },
  { event: 'treasury.loan_repayment', role: 'bank_commission', account: 'Loan fees and commission' },
  { event: 'treasury.loan_commission', role: 'bank_commission', account: 'Loan fees and commission' },
];

/**
 * Defaults this file once gave a role and has since moved. A rule still naming
 * the old account was set by this file, not decided by anybody, so it follows.
 */
const MOVED: Readonly<Record<string, string>> = { sales_revenue: 'Sales — solar equipment' };

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

/** True when no statement has been told where this account prints. */
async function printsNowhere(tx: Tx, id: string): Promise<boolean> {
  const [row] = await tx
    .select({
      income: chartOfAccount.incomeStatementLine,
      balance: chartOfAccount.balanceSheetLine,
      cash: chartOfAccount.cashFlowLine,
      equity: chartOfAccount.changesInEquityLine,
    })
    .from(chartOfAccount)
    .where(eq(chartOfAccount.id, id))
    .limit(1);
  return Boolean(row && !row.income && !row.balance && !row.cash && !row.equity);
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

/**
 * Creates an account and carries it to approved, which is what makes it
 * usable: `createAccount` leaves it in draft and inactive, and an inactive
 * group cannot hold the accounts beneath it. This is the screen's own path —
 * create, submit, approve — done by one person because a setup script has
 * only the one.
 */
async function createApproved(
  tx: Tx,
  ctx: ActorContext,
  input: Parameters<typeof coa.createAccount>[2],
): Promise<{ id: string; code: string; name: string }> {
  const made = await coa.createAccount(tx, ctx, input);
  await coa.submitForApproval(tx, ctx, made.id);
  await coa.approve(tx, ctx, made.id);
  return { id: made.id, code: made.code, name: made.name };
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
    const byName = new Map<string, { id: string; code: string }>();
    let madeGroups = 0;
    let madeLeaves = 0;

    for (const group of CHART) {
      const root = await rootByCode(tx, group.root);
      let folder = await accountByName(tx, group.name, root.id);
      if (!folder && !dryRun) {
        const made = await createApproved(tx, ctx, { name: group.name, parentId: root.id, isGroup: true });
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
          const made = await createApproved(tx, ctx, {
            name: leaf.name,
            parentId: folder.id,
            isGroup: false,
            currencyRestriction: leaf.currency ?? 'IQD',
            ...(leaf.control ? { controlAccount: leaf.control } : {}),
            ...(leaf.lines ? { mapping: leaf.lines } : {}),
          });
          account = { id: made.id, code: made.code, name: made.name };
          madeLeaves += 1;
          console.log(`  created       ${made.code}  ${made.name}`);
        } else if (leaf.lines && !dryRun && (await printsNowhere(tx, account.id))) {
          // An account already in the books that no statement was told about:
          // filed where this chart files it. One somebody has filed is left alone.
          await coa.setStatementLines(tx, ctx, account.id, leaf.lines);
          console.log(`  filed         ${account.code}  ${account.name}`);
        }

        for (const role of leaf.roles ?? []) roleAccount.set(role, { id: account.id, code: account.code });
        byName.set(leaf.name, { id: account.id, code: account.code });
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
    let repointed = 0;
    const unmapped: string[] = [];
    for (const { event, role } of wanted) {
      const special = EVENT_ACCOUNTS.find((entry) => entry.event === event && entry.role === role);
      const account = special ? byName.get(special.account) : roleAccount.get(role);
      if (!account) {
        unmapped.push(`${event} / ${role}`);
        continue;
      }

      const [existing] = await tx
        .select({ id: postingRule.id, accountId: postingRule.accountId })
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

      if (existing) {
        if (existing.accountId === account.id) continue;
        // A rule pointing where this file put it is this file's, and follows
        // it; one pointing anywhere else is somebody's decision and stands.
        const moved = MOVED[role];
        const ours = [roleAccount.get(role)?.id, moved ? byName.get(moved)?.id : undefined];
        if (!ours.includes(existing.accountId)) continue;
        if (dryRun) {
          console.log(`would re-point  ${event} / ${role}  ->  ${account.code}`);
          continue;
        }
        await posting.setMapping(tx, ctx, { eventType: event, lineRole: role, accountId: account.id });
        repointed += 1;
        console.log(`re-pointed  ${event.padEnd(34)} ${role.padEnd(28)} -> ${account.code}`);
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
        description: special ? 'Set up with the chart of accounts — this document only.' : 'Set up with the chart of accounts.',
      });
      mapped += 1;
      console.log(`mapped  ${event.padEnd(38)} ${role.padEnd(28)} -> ${account.code}`);
    }

    console.log('');
    console.log(`mappings: ${mapped} added, ${repointed} re-pointed`);
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
