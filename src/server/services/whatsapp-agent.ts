/**
 * The agent's tools — REQ-WA-001 WA-3, the ERP half.
 *
 * `domain/whatsapp-agent.ts` holds the loop and the instructions and knows
 * nothing about a database. This binds the declared tools to a read context:
 * every one of them is an answer the ERP already gives a screen, run on the
 * caller's transaction, which PostgreSQL itself holds read-only, under the
 * asker's own user and grants (W-R1).
 */
import { helpText, money, quantity } from '../domain/whatsapp';
import { runAgent, type AgentClient, type AgentResult, type PriorTurn, type ToolOutcome } from '../domain/whatsapp-agent';
import * as apInvoices from './ap-invoice';
import * as arInvoices from './ar-invoice';
import * as bankAccounts from './bank-cash-accounts';
import * as employeesService from './employees';
import * as inventoryReports from './inventory-reports';
import * as openItemsService from './open-items';
import * as partnersService from './partners';
import * as trialBalanceService from './trial-balance';
import * as waActions from './whatsapp-actions';
import { draft, warehousesFor, type Drafted, type ReadContext } from './whatsapp';

export { AGENT_TOOLS, systemPrompt, runAgent } from '../domain/whatsapp-agent';
export type { AgentClient, AgentMessage, AgentResult, PriorTurn, ToolOutcome } from '../domain/whatsapp-agent';

const fromDrafted = (drafted: Drafted): ToolOutcome => ({
  text: drafted.text,
  attachment: drafted.model
    ? {
        model: drafted.model,
        ...(drafted.format ? { format: drafted.format } : {}),
        ...(drafted.exportObject ? { exportObject: drafted.exportObject } : {}),
        ...(drafted.exportKey ? { exportKey: drafted.exportKey } : {}),
      }
    : null,
});

/** The tool runner for one asker, in one read-only transaction. */
const chr10 = () => String.fromCharCode(10);

export function toolRunnerFor(ctx: ReadContext) {
  return async function runTool(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    switch (name) {
      case 'company_summary':
        return fromDrafted(await draft(ctx, { kind: 'summary' }));
      case 'list_warehouses': {
        const { all } = await warehousesFor(ctx, '');
        if (all.length === 0) return { text: 'There are no warehouses on the system.' };
        return { text: all.map((house: { code: string; name: string }) => `${house.code} · ${house.name}`).join('\n') };
      }
      case 'warehouse_stock':
        return fromDrafted(await draft(ctx, { kind: 'stock', warehouse: String(args.warehouse ?? '') }));
      case 'payable_status':
        return fromDrafted(await draft(ctx, { kind: 'payable', no: String(args.no ?? '') }));
      case 'application_status':
        return fromDrafted(await draft(ctx, { kind: 'application', no: String(args.no ?? '') }));
      case 'swift_pending':
        return fromDrafted(await draft(ctx, { kind: 'swift', minDays: Number(args.minDays ?? 0) }));
      case 'payables_due':
        return fromDrafted(await draft(ctx, { kind: 'due' }));
      case 'payables_stopped':
        return fromDrafted(await draft(ctx, { kind: 'stopped', needsReason: Boolean(args.needsReason) }));
      case 'partner_balance':
        return fromDrafted(
          await draft(ctx, {
            kind: args.side === 'supplier' ? 'supplier' : 'customer',
            party: String(args.party ?? ''),
          } as never),
        );
      case 'trial_balance': {
        const to = typeof args.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.to) ? args.to : ctx.today;
        const currency = args.currency === 'USD' ? 'USD' : 'IQD';
        const rows = await trialBalanceService.trialBalance(ctx.tx, {
          from: `${to.slice(0, 4)}-01-01`,
          to,
          currency,
          consolidate: true,
        } as never);
        const moving = rows.filter((row) => Number(row.balance) !== 0);
        if (moving.length === 0) return { text: `Nothing has been posted to ${to}.` };
        const lines = moving.map((row) => `${row.accountCode} · ${row.accountName} (${row.accountType}): ${money(row.balance, currency)}`);
        return { text: [`Trial balance to ${to} in ${currency}:`, ...lines].join('\n') };
      }
      case 'open_items': {
        const side = args.side === 'supplier' ? 'supplier' : 'customer';
        const items = await openItemsService.openItems(ctx.tx, ctx.principal, side, ctx.today, {
          ...(typeof args.party === 'string' && args.party ? { partyCode: args.party } : {}),
        });
        if (items.length === 0) return { text: side === 'customer' ? 'No customer owes anything unpaid.' : 'Nothing is owed to a supplier.' };
        const top = items.slice(0, 40);
        const lines = top.map((item) => {
          const row = item as unknown as Record<string, unknown>;
          const who = String(row.partyName ?? row.partyCode ?? '');
          const no = String(row.documentNo ?? row.invoiceNo ?? '');
          const outstanding = String(row.outstandingIqd ?? row.outstanding ?? row.balanceIqd ?? '');
          const days = row.daysOverdue ?? row.ageDays ?? null;
          return `${no} · ${who}: ${money(outstanding)}${days === null ? '' : ` · ${String(days)} days`}`;
        });
        return { text: [`${items.length} open item(s) on the ${side} side:`, ...lines].join('\n') };
      }
      case 'stock_valuation': {
        const rows = await inventoryReports.valuation(ctx.tx, ctx.principal, {
          ...(typeof args.item === 'string' && args.item ? { itemSearch: args.item } : {}),
          ...(typeof args.warehouse === 'string' && args.warehouse ? { warehouseCode: String(args.warehouse).toUpperCase() } : {}),
        } as never);
        const list = (rows as unknown as Record<string, unknown>[]) ?? [];
        if (list.length === 0) return { text: 'No stock matches that.' };
        const lines = list.slice(0, 40).map((row) => {
          const item = String(row.itemName ?? row.itemCode ?? '');
          const house = String(row.warehouseCode ?? row.warehouseName ?? '');
          return `${item} @ ${house}: ${quantity(String(row.quantity ?? row.onHand ?? '0'))} · ${money(String(row.valueIqd ?? row.value ?? '0'))}`;
        });
        return { text: [`${list.length} stock line(s):`, ...lines].join('\n') };
      }
      case 'list_partners': {
        const side = args.side === 'supplier' ? 'supplier' : 'customer';
        const rows = await partnersService.listActiveInRole(ctx.tx, side);
        if (rows.length === 0) return { text: `There are no ${side}s on the system.` };
        return {
          text: [`${rows.length} ${side}(s):`, ...rows.slice(0, 60).map((row) => `${row.code} · ${row.name}`)].join('\n'),
        };
      }
      case 'approvals_waiting': {
        const waiting = await waActions.waitingFor(ctx.principal.userId);
        if (waiting.length === 0) return { text: 'Nothing is waiting for this person to approve.' };
        return {
          text: [
            `${waiting.length} document(s) waiting:`,
            ...waiting.map((row) => `${row.documentNumber} · ${row.documentType} · raised by ${row.submittedByName ?? '—'}`),
          ].join('\n'),
        };
      }
      case 'invoice': {
        const no = String(args.no ?? '').trim();
        if (!no) return { text: 'Which invoice number?' };
        const found =
          args.side === 'sales' ? await arInvoices.viewByNo(ctx.tx, no) : await apInvoices.viewByNo(ctx.tx, no);
        if (!found) return { text: `There is no invoice ${no} on the system.` };
        const header = (found as unknown as { invoice?: Record<string, unknown> }).invoice ?? (found as unknown as Record<string, unknown>);
        const lines = (found as unknown as { lines?: Record<string, unknown>[] }).lines ?? [];
        const field = (key: string) => (header[key] === null || header[key] === undefined ? null : String(header[key]));
        return {
          text: [
            `${field('invoiceNo') ?? no} · ${field('status') ?? ''}`,
            `date ${field('invoiceDate') ?? '—'} · due ${field('dueDate') ?? '—'}`,
            `total ${money(field('totalIqd'))} · settled ${money(field('settledAmountIqd'))}`,
            `${lines.length} line(s)`,
          ].join(chr10()),
        };
      }
      case 'bank_and_cash': {
        const code = String(args.code ?? '').trim();
        if (code) {
          const one = await bankAccounts.detail(ctx.tx, code.toUpperCase());
          const row = one as unknown as Record<string, unknown>;
          return {
            text: [
              `${String(row.code)} · ${String(row.name)} (${String(row.currency)})`,
              `bank ${String(row.bankMasterName ?? row.bankName ?? '—')} · account ${String(row.accountNumber ?? '—')}`,
              `ledger account ${String(row.glAccountCode ?? '—')} · ${String(row.glAccountName ?? '')}`,
              `custodian ${String(row.custodianName ?? '—')}`,
            ].join(chr10()),
          };
        }
        const banksList = await bankAccounts.listOfKind(ctx.tx, 'bank');
        const cashList = await bankAccounts.listOfKind(ctx.tx, 'cash');
        const all = [...banksList, ...cashList] as unknown as Record<string, unknown>[];
        if (all.length === 0) return { text: 'No bank or cash account has been set up yet.' };
        return {
          text: all
            .map((row) => `${String(row.code)} · ${String(row.name)} · ${String(row.currency)} · ${String(row.accountType)}`)
            .join(chr10()),
        };
      }
      case 'employees': {
        const rows = (await employeesService.list(ctx.tx)) as unknown as Record<string, unknown>[];
        const asked = String(args.search ?? '').trim().toLowerCase();
        const shown = asked
          ? rows.filter((row) => JSON.stringify(Object.values(row)).toLowerCase().includes(asked))
          : rows;
        if (shown.length === 0) return { text: asked ? `Nobody matches "${asked}".` : 'There are no employees on the system yet.' };
        return {
          text: [
            `${shown.length} employee(s)${asked ? ` matching "${asked}"` : ''}:`,
            ...shown
              .slice(0, 40)
              .map(
                (row) =>
                  `${String(row.employeeNo ?? '')} · ${String(row.fullName ?? row.name ?? '')} · ${String(row.departmentCode ?? '—')} · ${String(row.status ?? '')}`,
              ),
          ].join(chr10()),
        };
      }
      case 'what_the_bot_can_do':
        return { text: helpText(ctx.locale) };
      default:
        return { text: `There is no tool called ${String(name)}.` };
    }
    };
  }
  
  
/** The agent, for one asker: the loop with this context's tools bound in. */
export async function runAgentFor(input: {
  readonly client: AgentClient;
  readonly model: string;
  readonly ctx: ReadContext;
  readonly question: string;
  readonly history?: readonly PriorTurn[];
  readonly userName: string;
}): Promise<AgentResult> {
  return runAgent({
    client: input.client,
    model: input.model,
    question: input.question,
    ...(input.history ? { history: input.history } : {}),
    userName: input.userName,
    locale: input.ctx.locale,
    branchCode: input.ctx.branchCode,
    today: input.ctx.today,
    runTool: toolRunnerFor(input.ctx),
  });
}
