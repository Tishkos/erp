/**
 * The agent's tools — REQ-WA-001 WA-3, the ERP half.
 *
 * `domain/whatsapp-agent.ts` holds the loop and the instructions and knows
 * nothing about a database. This binds the declared tools to a read context:
 * every one of them is an answer the ERP already gives a screen, run on the
 * caller's transaction, which PostgreSQL itself holds read-only, under the
 * asker's own user and grants (W-R1).
 */
import { sql } from 'drizzle-orm';
import { can } from '../domain/permissions';
import { ISSUE_KINDS, ISSUE_SEVERITIES, type IssueKind, type IssueSeverity } from '../domain/system-guide';
import { helpText, money, quantity } from '../domain/whatsapp';
import { describeSentFile, type SentFile } from '../domain/whatsapp-files';
import type { PendingAction } from '../domain/whatsapp-do';
import { RATE_SCALE, toDecimalString } from '../domain/money';
import * as ratesService from './exchange-rates';
import * as itemsService from './items';
import * as openingStockService from './opening-stock';
import * as doService from './whatsapp-do';
import * as insight from './whatsapp-insight';
import * as notes from './whatsapp-notes';
import { correctionFor, isClean, unsupportedIn } from '../domain/whatsapp-selfcheck';
import * as liveShots from './live-screenshot';
import * as howTo from './howto-live';
import { asksForTrainingPicture, pictureLanguage } from '../domain/whatsapp-pictures';
import * as review from './whatsapp-review';
import * as sqlService from './whatsapp-sql';
import * as systemGuide from './system-guide';
import { runAgent, type AgentClient, type AgentResult, type AskedPicture, type PriorTurn, type ToolOutcome } from '../domain/whatsapp-agent';
import * as apInvoices from './ap-invoice';
import * as arInvoices from './ar-invoice';
import * as bankAccounts from './bank-cash-accounts';
import * as employeesService from './employees';
import * as inventoryReports from './inventory-reports';
import * as openItemsService from './open-items';
import * as partnersService from './partners';
import * as trialBalanceService from './trial-balance';
import * as waActions from './whatsapp-actions';
import { QUERY_ROLE, draft, warehousesFor, type Drafted, type ReadContext } from './whatsapp';

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

/**
 * The files sent to this chat lately, newest first.
 *
 * They are held by the bridge, which downloaded them, rather than by the
 * database: a workbook somebody sent to a group is their file and not the
 * company's record, and the message log keeps its name and size without
 * keeping a copy of it.
 */
export type SentFiles = readonly SentFile[];

/**
 * How an action reaches the world — WA-8.
 *
 * Present only when the contact may act, which is how the capability is
 * granted: without it `propose_action` has nowhere to put a proposal and says
 * so. `propose` hands the pending action to whoever is holding the
 * conversation (the bridge), because the tools run inside a read-only
 * transaction and a proposal is not a write to the books anyway — it is an
 * intention for the next few minutes.
 */
export interface ActionHooks {
  readonly chat: string;
  readonly propose: (pending: PendingAction) => void;
}

/** Who is asking and where, for what a tool writes down about them. */
export interface AskerMeta {
  readonly userName: string;
  /** The group or the number the question came from. */
  readonly chat?: string | null;
  /** The exchange before this one — what an "that was wrong" is about. */
  readonly lastExchange?: { readonly question: string; readonly answer: string } | null;
  /** The person's own words this time: what they asked for decides some things the model may not decide for them. */
  readonly question?: string | null;
}

export function toolRunnerFor(ctx: ReadContext, files: SentFiles = [], actions?: ActionHooks, meta?: AskerMeta) {
  /*
   * Everybody may ask (2026-10-04), so each tool answers for the asker's own
   * role, as the screen behind it does. Most already did — `draft` and the
   * services that take a principal check the grant themselves. These are the
   * ones that read a table directly: the grant their screen asks for is asked
   * for here, and the refusal names it so Noah can say who gives it.
   */
  const lacks = (object: string): ToolOutcome | null =>
    can(ctx.principal, 'view', object)
      ? null
      : {
          text: `This person's role does not include "${object.replaceAll('_', ' ')}" (the permission view on ${object}), so its figures are not theirs to see. Tell them that plainly, and that an administrator gives the permission on Settings → Administration → Roles. Do not look for the same figures another way.`,
        };
  /** The free query reads any table: it is for the roles that read everything. */
  const readsEverything = ctx.principal.isSuperUser || ctx.principal.roleCodes.includes(QUERY_ROLE);

  /** Who is asking, as a name a person reading a file will know — read as them, and optional: a note is written even when the database is the problem. */
  const whoIs = async (): Promise<string> => {
    const row = await sqlService
      .inSavepoint(ctx.tx, async () => {
        const me = await ctx.tx.execute(sql`select display_name, email from app_user where id = ${ctx.principal.userId}`);
        return me.rows[0] as { display_name?: string; email?: string } | undefined;
      })
      .catch(() => undefined);
    return `${row?.display_name ?? meta?.userName ?? ctx.principal.userId}${row?.email ? ` <${row.email}>` : ''} · branch ${ctx.branchCode}`;
  };
  /** Where it was said, for the files a tool writes. */
  const chatLabel = !meta?.chat ? 'WhatsApp' : meta.chat === 'terminal' ? 'terminal (ask-noah)' : `WhatsApp ${meta.chat.includes('@g.us') ? 'group' : 'chat'}`;
  const words = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

  const run = async (name: string, args: Record<string, unknown>): Promise<ToolOutcome> => {
    switch (name) {
      case 'company_summary':
        return fromDrafted(await draft(ctx, { kind: 'summary' }));
      case 'list_warehouses': {
        const no = lacks('warehouse');
        if (no && !can(ctx.principal, 'view', 'inventory_movement')) return no;
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
        const no = lacks('trial_balance');
        if (no) return no;
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
        const no = lacks('business_partner');
        if (no) return no;
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
        const refused = lacks(args.side === 'sales' ? 'ar_invoice' : 'ap_invoice');
        if (refused) return refused;
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
        const no = lacks('bank_account');
        if (no) return no;
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
        const no = lacks('employee');
        if (no) return no;
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
      case 'schema':
      case 'query': {
        if (!readsEverything) {
          return {
            text: 'The free query is for the roles that read the whole company (the CEO role, a super user). For this person use the named tools — each one shows what their own role may see — and the guide and screens for how the system works.',
          };
        }
        if (name === 'schema') {
          return { text: await sqlService.describeSchema(ctx.tx, typeof args.table === 'string' ? args.table : undefined) };
        }
        const asked = String(args.sql ?? '').trim();
        if (!asked) return { text: 'No query given.' };
        const result = await sqlService.runQuery(ctx.tx, asked, typeof args.limit === 'number' ? args.limit : undefined);
        // A refusal is the useful answer here: "that column does not exist"
        // is what makes the next query right.
        if (!result.ok) return { text: `The query did not run: ${result.reason}` };
        return { text: result.text };
      }
      case 'items': {
        const no = lacks('item');
        if (no) return no;
        const rows = (await itemsService.listAll(ctx.tx)) as unknown as Record<string, unknown>[];
        const asked = String(args.search ?? '').trim().toLowerCase();
        const shown = asked ? rows.filter((row) => JSON.stringify(Object.values(row)).toLowerCase().includes(asked)) : rows;
        if (shown.length === 0) {
          return { text: asked ? `No item matches "${asked}".` : 'There are no items on the system yet.' };
        }
        return {
          text: [
            `${shown.length} item(s)${asked ? ` matching "${asked}"` : ''}${shown.length > 60 ? ', the first 60:' : ':'}`,
            ...shown
              .slice(0, 60)
              .map(
                (row) =>
                  `${String(row.code ?? '')} · ${String(row.name ?? '')} · ${String(row.baseUomCode ?? row.uomCode ?? '—')}${row.active === false ? ' · inactive' : ''}`,
              ),
          ].join(chr10()),
        };
      }
      case 'opening_stock': {
        const refused = lacks('opening_stock');
        if (refused) return refused;
        const no = String(args.no ?? '').trim().toUpperCase();
        if (no) {
          const found = await openingStockService.viewByNo(ctx.tx, no);
          if (!found) return { text: `There is no opening stock document ${no}.` };
          const header = found.document as unknown as Record<string, unknown>;
          const lines = found.lines as unknown as Record<string, unknown>[];
          return {
            text: [
              `${no} · ${String(header.warehouseName ?? header.warehouseCode ?? '')} · ${String(header.status ?? '')}`,
              ...lines
                .slice(0, 60)
                .map(
                  (line) =>
                    `${String(line.itemCode ?? '')} · ${String(line.itemName ?? '')} · ${quantity(String(line.quantity ?? '0'))} · ${money(String(line.totalIqd ?? '0'))} IQD`,
                ),
              lines.length > 60 ? `… and ${lines.length - 60} more line(s)` : '',
            ]
              .filter((part) => part !== '')
              .join(chr10()),
          };
        }
        const rows = (await openingStockService.list(ctx.tx)) as unknown as Record<string, unknown>[];
        if (rows.length === 0) return { text: 'No opening stock has been raised.' };
        return {
          text: [
            `${rows.length} opening stock document(s):`,
            ...rows.map(
              (row) =>
                `${String(row.documentNo ?? '')} · ${String(row.warehouseName ?? '')} · ${String(row.status ?? '')} · ${String(row.lines ?? 0)} line(s) · ${money(String(row.totalIqd ?? '0'))} IQD`,
            ),
            'A document that is still "submitted" has NOT posted to the inventory ledger: its quantities read zero everywhere until it is approved.',
          ].join(chr10()),
        };
      }
      case 'preview_step': {
        if (!actions) {
          return { text: 'A preview runs the step and undoes it, so it is for people who may take steps from chat: this contact is not allowed actions. Explain what the step does in words (document_story, review_document).' };
        }
        return { text: await doService.preview({ ctx, userId: ctx.principal.userId, chat: actions.chat, action: String(args.action ?? ''), args }) };
      }
      case 'propose_action': {
        if (!actions) {
          return {
            text: 'You cannot act for this person: their contact is not allowed to take actions. An administrator turns that on per person on Settings → Administration → WhatsApp (the Actions switch on their contact). Explain that, show them how to do it on the screen themselves (guide + screens), and say that reading is unaffected.',
          };
        }
        const prepared = await doService.prepare({
          ctx,
          userId: ctx.principal.userId,
          chat: actions.chat,
          action: String(args.action ?? ''),
          args,
        });
        if (!prepared.ok) return { text: `Not proposed. ${prepared.reason}` };
        actions.propose(prepared.pending);
        return {
          text: [
            'Nothing has happened yet. Put these facts to them in your own words and ask whether they are sure:',
            '',
            prepared.pending.sentence,
            '',
            'They have ten minutes to answer. A plain yes runs it; anything else drops it.',
          ].join(chr10()),
        };
      }
      case 'sent_file': {
        if (files.length === 0) return { text: 'No file has been sent to this chat.' };
        const asked = String(args.name ?? '').trim().toLowerCase();
        const file = asked ? files.find((f) => f.fileName.toLowerCase().includes(asked)) : files[0];
        if (!file) {
          return { text: `No file matching "${asked}". What has been sent: ${files.map((f) => f.fileName).join(', ')}.` };
        }
        return {
          text: [
            describeSentFile(file),
            file.caption ? `sent with: ${file.caption}` : '',
            '',
            file.text || '(nothing could be read out of it)',
          ]
            .filter((part) => part !== '')
            .join(chr10()),
        };
      }
      case 'document_story':
        return { text: await insight.documentStory(ctx.tx, ctx.principal, String(args.no ?? ''), systemGuide.appUrl()) };
      case 'stuck_documents':
        return {
          text: await review.stuckDocuments(
            ctx.tx,
            ctx.principal,
            {
              ...(typeof args.olderThanDays === 'number' ? { olderThanDays: args.olderThanDays } : {}),
              ...(args.mine === true ? { mine: true } : {}),
              ...(typeof args.kind === 'string' && args.kind.trim() ? { kind: args.kind } : {}),
            },
            systemGuide.appUrl(),
          ),
        };
      case 'review_document':
        return { text: await review.reviewDocument(ctx.tx, ctx.principal, String(args.no ?? ''), systemGuide.appUrl()) };
      case 'activity_log':
        return {
          text: await insight.activityLog(ctx.tx, ctx.principal, {
            ...(typeof args.user === 'string' ? { user: args.user } : {}),
            ...(typeof args.document === 'string' ? { document: args.document } : {}),
            ...(typeof args.action === 'string' ? { action: args.action } : {}),
            ...(typeof args.object === 'string' ? { object: args.object } : {}),
            ...(typeof args.outcome === 'string' ? { outcome: args.outcome } : {}),
            ...(typeof args.from === 'string' ? { from: args.from } : {}),
            ...(typeof args.to === 'string' ? { to: args.to } : {}),
            ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
          }),
        };
      case 'system_status':
        return { text: await insight.systemStatus(ctx.tx, ctx.principal) };
      case 'accounts': {
        const no = lacks('chart_of_account');
        if (no) return no;
        const asked = String(args.search ?? '').trim();
        const like = `%${asked.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`;
        const result = await ctx.tx.execute(sql`
          select code, name, account_type::text as type, is_group, is_active, control_account::text as control
            from chart_of_account
           where ${asked === ''} or code ilike ${like} or name ilike ${like}
           order by code
           limit 81`);
        const rows = result.rows as { code: string; name: string; type: string; is_group: boolean; is_active: boolean; control: string | null }[];
        if (rows.length === 0) return { text: asked ? `No account matches "${asked}". Try part of the name in the other language, or leave the search out for the whole chart.` : 'The chart of accounts is empty.' };
        return {
          text: [
            `${rows.length > 80 ? 'More than 80' : rows.length} account(s)${asked ? ` matching "${asked}"` : ''}${rows.length > 80 ? ', the first 80 — narrow the search:' : ':'}`,
            ...rows
              .slice(0, 80)
              .map(
                (row) =>
                  `${row.code} · ${row.name} · ${row.type}${row.is_group ? ' · HEADING (nothing posts to it)' : ''}${row.is_active ? '' : ' · inactive'}${row.control ? ` · ${row.control} control account (posted through its own documents, not by hand)` : ''}`,
              ),
          ].join(chr10()),
        };
      }
      case 'exchange_rate': {
        const no = lacks('exchange_rate');
        if (no) return no;
        const date = /^\d{4}-\d{2}-\d{2}$/.test(String(args.date ?? '')) ? String(args.date) : ctx.today;
        const wanted = String(args.currency ?? '').trim().toUpperCase();
        const kept = (await ratesService.currencies(ctx.tx)) as unknown as { code: string; isLedger?: boolean; isActive?: boolean; active?: boolean }[];
        const codes = wanted ? [wanted] : kept.filter((row) => !row.isLedger && row.isActive !== false && row.active !== false).map((row) => row.code);
        if (codes.length === 0) return { text: 'The company keeps no foreign currency yet: everything is in IQD. A currency and its rate are added on Accounting → Master Data — Financial → Currencies and Rates.' };
        const lines: string[] = [];
        for (const code of codes) {
          if (code === 'IQD') {
            lines.push('IQD is the currency the books are kept in: 1 IQD = 1 IQD.');
            continue;
          }
          try {
            const rate = await ratesService.rateOn(ctx.tx, code, date);
            lines.push(`1 ${code} = ${money(toDecimalString(rate.iqdPerUnit, RATE_SCALE))} IQD on ${date} (the accounting rate in force since ${rate.effectiveFrom}).`);
          } catch (error) {
            lines.push(`${code}: no accounting rate — ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        return { text: [...lines, 'Rates are entered on Accounting → Master Data — Financial → Currencies and Rates; a document takes the rate of its own date.'].join(chr10()) };
      }
      case 'document_status':
        return { text: await doService.describeDocument(ctx.tx, ctx.principal, String(args.no ?? ''), systemGuide.appUrl()) };
      case 'show_screen': {
        const view = ['menu', 'screen', 'form', 'record', 'dialog', 'all'].includes(String(args.view)) ? (args.view as systemGuide.ShotView | 'all') : 'all';
        const asked = String(args.screen ?? '');
        // The language asked for, not the language the asking was written in: "show me in arabic" is an English sentence.
        const shownIn = pictureLanguage(args.language, meta?.question, ctx.locale);
        /*
         * Whose data (2026-10-05, option B): with live data on — the server's
         * default once the owner switched it on, or because the person asked
         * for it — the screen and an opened record are pictured from the real
         * system as the asker. Everything else, and whatever a live picture
         * could not be taken of, is the ready-made picture.
         */
        // "training" is the person's to ask for, not the model's to choose: with their words in hand it counts only when they said so.
        const trainingAsked = args.data === 'training' && (meta?.question == null || asksForTrainingPicture(meta.question));
        const wantsLive = args.data === 'live' ? liveShots.liveShotsReady().ok : trainingAsked ? false : howTo.howToLiveReady().ok;
        const live: Partial<Record<'screen' | 'record', systemGuide.LivePicture>> = {};
        const notTaken: string[] = [];
        if (wantsLive && (view === 'all' || view === 'screen' || view === 'record')) {
          const which = systemGuide.screenFor(ctx.principal, shownIn, asked);
          if (which && which.menuScreen && which.allowed) {
            for (const one of view === 'record' ? (['record'] as const) : (['screen'] as const)) {
              const taken = await howTo.liveHowToPicture({
                userId: ctx.principal.userId,
                locale: shownIn,
                route: which.route,
                view: one,
                ...(one === 'screen' && which.newButton ? { pointAt: [which.newButton] } : {}),
              });
              if (taken.ok) live[one] = { file: taken.file, marks: taken.marks };
              else notTaken.push(taken.reason);
            }
          }
        } else if (args.data === 'live' && !wantsLive) {
          notTaken.push(liveShots.liveShotsReady().reason ?? 'live pictures are not available on this server');
        }
        const shown = systemGuide.screenPictures(ctx.principal, shownIn, asked, view, typeof args.dialog === 'string' ? args.dialog : null, live);
        const note = notTaken.length > 0 && args.data === 'live' ? `${chr10()}A live picture could not be taken (${notTaken[0]}), so this is the training picture: say so.` : '';
        return { text: `${shown.text}${note}`, ...(shown.images.length > 0 ? { images: shown.images } : {}) };
      }
      case 'screenshot': {
        const ready = liveShots.liveShotsReady();
        if (!ready.ok) return { text: `No live picture: ${ready.reason ?? 'it is not available here.'} The training pictures (show_screen) still work.` };
        // The address as a tool gave it, or as a path: only the path is used.
        const base = systemGuide.appUrl();
        const given = String(args.address ?? '').trim();
        const path = given.toLowerCase().startsWith(base.toLowerCase()) ? given.slice(base.length) || '/' : given;
        const pointAt = Array.isArray(args.pointAt) ? args.pointAt.filter((one): one is string => typeof one === 'string' && one.trim() !== '').slice(0, 4) : [];
        const shownIn = pictureLanguage(args.language, meta?.question, ctx.locale);
        const taken = await liveShots.liveScreenshot({ userId: ctx.principal.userId, path, locale: shownIn, ...(pointAt.length > 0 ? { pointAt } : {}) });
        if (!taken.ok) return { text: `No live picture: ${taken.reason} Say in words what you would have pointed at.` };
        const { shot } = taken;
        const numbers = systemGuide.marksLine(shot.marks);
        const tag = shot.file.replace(/^.*[\\/]/, '').replace(/\.[a-z0-9]+$/i, '').toLowerCase();
        const caption =
          shownIn === 'ar' ? `${shot.title || shot.path} — الشاشة كما هي الآن${numbers ? '، والأرقام الحمراء مشروحة في الرسالة' : ''}` : `${shot.title || shot.path} — the screen as it is now${numbers ? '; the red numbers are explained in the message' : ''}`;
        return {
          text: [
            `1 LIVE picture of ${shot.title || shot.path} (${shot.path}) is attached to your answer — the real screen as this person sees it now. Place it at its step: write its tag on a line of its own, and what you write under it is sent as its caption.`,
            `[picture: ${tag}] — the live screen.${numbers ? ` The red numbers on it: ${numbers}.` : ' Nothing is numbered on this one.'}`,
            shot.notFound.length > 0
              ? `Not in the picture, so no arrow was drawn for: ${shot.notFound.join(', ')}. Do not say an arrow points at them. If the thing you meant is among the numbers above under another name, take the picture once more with pointAt set to that exact name — the new picture replaces this one.`
              : '',
            'Say where the arrow is and what to do there; refer to anything else by its number and its name. The figures in this picture are real.',
          ]
            .filter((line) => line !== '')
            .join(chr10()),
          // One live picture per page: a retake replaces the first.
          images: [{ file: shot.file, caption, group: `live:${shot.path}`, kind: 'live' }],
        };
      }
      case 'screens':
        return { text: systemGuide.screens(ctx.principal, typeof args.search === 'string' ? args.search : null) };
      case 'guide':
        return { text: systemGuide.guide(typeof args.search === 'string' ? args.search : null) };
      case 'change_request': {
        const kind = (notes.REQUEST_KINDS as readonly string[]).includes(String(args.kind)) ? (args.kind as (typeof notes.REQUEST_KINDS)[number]) : 'other';
        try {
          const filed = notes.recordRequest({
            who: await whoIs(),
            chat: chatLabel,
            request: {
              title: String(args.title ?? ''),
              kind,
              area: String(args.area ?? ''),
              screen: words(args.screen),
              today: words(args.today),
              wanted: String(args.wanted ?? ''),
              why: String(args.why ?? ''),
              rightWay: words(args.rightWay),
              example: words(args.example),
              impact: words(args.impact),
              openQuestions: Array.isArray(args.openQuestions) ? args.openQuestions.filter((one): one is string => typeof one === 'string' && one.trim() !== '') : [],
              noahNote: words(args.noahNote),
            },
          });
          return {
            text: `Filed as ${filed.id}. Tell them the number, that it is written down for the people who build the system, and that nobody has promised it will be built or when. If questions are still open, ask the next one or two now; add the answers with change_request_followup.`,
          };
        } catch (error) {
          return { text: `Not filed: ${error instanceof Error ? error.message : String(error)}` };
        }
      }
      case 'change_request_followup': {
        const status = (notes.REQUEST_STATUSES as readonly string[]).includes(String(args.status)) ? (args.status as (typeof notes.REQUEST_STATUSES)[number]) : undefined;
        const answers = Array.isArray(args.answers)
          ? (args.answers as unknown[]).flatMap((one) => {
              const pair = one as { question?: unknown; answer?: unknown };
              return typeof pair?.question === 'string' && typeof pair?.answer === 'string' ? [{ question: pair.question, answer: pair.answer }] : [];
            })
          : [];
        try {
          const added = notes.addToRequest({ id: String(args.id ?? '').trim().toUpperCase(), who: await whoIs(), note: words(args.note), answers, ...(status ? { status } : {}) });
          return { text: added.ok ? `Added to ${added.id}; its status is ${added.status}.` : `Not added: ${added.reason}` };
        } catch (error) {
          return { text: `Not added: ${error instanceof Error ? error.message : String(error)}` };
        }
      }
      case 'change_requests': {
        const id = words(args.id);
        if (id) return { text: notes.readRequest(id.toUpperCase()) ?? `There is no request ${id}. The list: ${notes.listRequests({ limit: 10 })}` };
        return {
          text: notes.listRequests({
            ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
            ...(words(args.status) ? { status: words(args.status)! } : {}),
            ...(words(args.search) ? { search: words(args.search)! } : {}),
          }),
        };
      }
      case 'answer_feedback': {
        const verdict = args.verdict === 'good' ? 'good' : 'wrong';
        const last = meta?.lastExchange ?? null;
        if (!last) return { text: 'There is no earlier answer of yours in this conversation for it to be about. Ask them which answer they mean, or what was wrong.' };
        try {
          const filed = notes.recordFeedback({
            who: await whoIs(),
            chat: chatLabel,
            verdict,
            question: last.question,
            answer: last.answer,
            whatWasWrong: words(args.whatWasWrong),
            rightAnswer: words(args.rightAnswer),
          });
          return {
            text:
              verdict === 'wrong'
                ? `Written down as ${filed.id}, and kept as a question you will be tested on. Now look again with the tools and give the corrected answer — or, if they have not said what was wrong, ask in one line.`
                : `Noted (${filed.id}).`,
          };
        } catch (error) {
          return { text: `Not written down: ${error instanceof Error ? error.message : String(error)}` };
        }
      }
      case 'remember': {
        const scope = args.about === 'company' ? 'company' : 'me';
        // A fact about the company is the company's to state: whoever administers the system, or a super user.
        if (scope === 'company' && !(ctx.principal.isSuperUser || can(ctx.principal, 'configure', 'whatsapp'))) {
          return { text: 'A fact about the company is kept when an administrator states it. Keep it as a note about this person instead (about me), or tell them an administrator can teach it to you.' };
        }
        try {
          const kept = notes.remember({ userId: ctx.principal.userId, who: await whoIs(), scope, fact: String(args.fact ?? '') });
          return { text: kept.ok ? `Kept. ${kept.said}` : `Not kept: ${kept.reason}` };
        } catch (error) {
          return { text: `Not kept: ${error instanceof Error ? error.message : String(error)}` };
        }
      }
      case 'forget': {
        const scope = args.about === 'company' ? 'company' : 'me';
        if (scope === 'company' && !(ctx.principal.isSuperUser || can(ctx.principal, 'configure', 'whatsapp'))) {
          return { text: 'What the company taught you is an administrator\'s to take back.' };
        }
        const dropped = notes.forget({ userId: ctx.principal.userId, scope, match: String(args.match ?? '') });
        return { text: dropped.removed > 0 ? `Dropped ${dropped.removed} line(s).` : 'Nothing you keep contains those words.' };
      }
      case 'walkthrough': {
        const op = String(args.op ?? '');
        if (op === 'clear') {
          notes.clearWalkthrough(ctx.principal.userId);
          return { text: 'The walkthrough is cleared.' };
        }
        const before = notes.readWalkthrough(ctx.principal.userId);
        const steps = Array.isArray(args.steps) ? args.steps.filter((one): one is string => typeof one === 'string' && one.trim() !== '') : (before?.steps ?? []);
        if (op === 'start' && steps.length < 2) return { text: 'A walkthrough needs its steps: give every step in order (at least two).' };
        if (op === 'advance' && !before) return { text: 'There is no walkthrough in progress for this person. Start one (op start) with its steps.' };
        // Counted from 1; one past the last step means every step is done.
        const current = Math.max(1, Math.min(steps.length + 1, typeof args.current === 'number' ? Math.round(args.current) : op === 'advance' ? (before?.current ?? 1) + 1 : 1));
        try {
          const saved = notes.saveWalkthrough({
            userId: ctx.principal.userId,
            title: words(args.title) ?? before?.title ?? 'A task',
            steps,
            current,
            document: words(args.document) ?? before?.document ?? null,
            check: words(args.check) ?? before?.check ?? null,
          });
          if (saved.current > saved.steps.length) {
            return { text: `Every step of "${saved.title}" is done. Say what the result is in the books (read it), then clear the walkthrough (op clear).` };
          }
          return { text: `Kept: "${saved.title}", step ${saved.current} of ${saved.steps.length} — ${saved.steps[saved.current - 1] ?? ''}. Give them this step only, with its picture, and ask them to reply !ai done when it is done.` };
        } catch (error) {
          return { text: `Not kept: ${error instanceof Error ? error.message : String(error)}` };
        }
      }
      case 'report_issue': {
        const summary = String(args.summary ?? '').trim();
        if (summary.length < 4) return { text: 'Not written down: say in one line what is wrong (summary).' };
        const kind = (ISSUE_KINDS as readonly string[]).includes(String(args.kind)) ? (args.kind as IssueKind) : 'other';
        const severity = (ISSUE_SEVERITIES as readonly string[]).includes(String(args.severity)) ? (args.severity as IssueSeverity) : 'slows_work';
        const text = (key: string) => (typeof args[key] === 'string' ? (args[key] as string) : null);
        // Who they are, read as them: the list is read by people, and "who" should be a name they know.
        // Read in a savepoint of its own, and optional: a problem is written
        // down even when the database is the problem.
        const row = await sqlService
          .inSavepoint(ctx.tx, async () => {
            const me = await ctx.tx.execute(sql`select display_name, email from app_user where id = ${ctx.principal.userId}`);
            return me.rows[0] as { display_name?: string; email?: string } | undefined;
          })
          .catch(() => undefined);
        const who = `${row?.display_name ?? meta?.userName ?? ctx.principal.userId}${row?.email ? ` <${row.email}>` : ''} · branch ${ctx.branchCode}`;
        const filed = systemGuide.reportIssue({
          who,
          chat: !meta?.chat ? 'WhatsApp' : meta.chat === 'terminal' ? 'terminal (ask-noah)' : `WhatsApp ${meta.chat.includes('@g.us') ? 'group' : 'chat'}`,
          issue: { summary, kind, severity, screen: text('screen'), doing: text('doing'), happened: text('happened'), message: text('message'), document: text('document'), note: text('note') },
        });
        return {
          text: `Written down as ${filed.id}. Tell them it is on the issues list under that number, and then help them with a way round if there is one.`,
        };
      }
      case 'reported_issues': {
        if (!(ctx.principal.isSuperUser || can(ctx.principal, 'configure', 'whatsapp') || can(ctx.principal, 'view', 'audit_event'))) {
          return { text: 'The whole list is for administrators. This person can still report a problem, and be told the number it was filed under.' };
        }
        return { text: systemGuide.issuesReported(typeof args.limit === 'number' ? args.limit : 10, Boolean(args.openOnly)) };
      }
      case 'what_the_bot_can_do':
        return { text: helpText(ctx.locale) };
      default:
        return { text: `There is no tool called ${String(name)}.` };
    }
  };

  /*
   * Each tool in its own savepoint: a statement PostgreSQL refuses inside one
   * tool must not take the rest of the question with it (see `inSavepoint`).
   */
  return function runTool(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    return sqlService.inSavepoint(ctx.tx, () => run(name, args));
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
  /** WA-7 — the files sent to this chat lately, newest first. */
  readonly files?: SentFiles;
  /** WA-8 — present only when this contact may act. */
  readonly actions?: ActionHooks;
  /** The group or number the question came from, for what a tool writes down. */
  readonly chat?: string | null;
  /** Pictures sent with the question, or with the message it replies to. */
  readonly pictures?: readonly AskedPicture[];
  /** Who is in the group, as the instructions say it (`rosterForPrompt`). */
  readonly people?: string;
}): Promise<AgentResult> {
  // What he has been told to keep about the company and this person, the walkthrough they are in, the last exchange.
  const memory = (() => {
    try {
      return notes.memoryForPrompt({ userId: input.ctx.principal.userId });
    } catch {
      return '';
    }
  })();
  // The exchange before this one, for "that was wrong": their last words and his.
  const turns = input.history ?? [];
  const answeredAt = turns.map((turn) => turn.role).lastIndexOf('assistant');
  const askedAt = answeredAt > 0 ? turns.slice(0, answeredAt).map((turn) => turn.role).lastIndexOf('user') : -1;
  const lastExchange = answeredAt >= 0 && askedAt >= 0 ? { question: turns[askedAt]!.text, answer: turns[answeredAt]!.text } : null;
  const result = await runAgent({
    client: input.client,
    model: input.model,
    question: input.question,
    ...(input.history ? { history: input.history } : {}),
    userName: input.userName,
    locale: input.ctx.locale,
    branchCode: input.ctx.branchCode,
    today: input.ctx.today,
    ...(input.pictures && input.pictures.length > 0 ? { pictures: input.pictures } : {}),
    ...(input.people ? { people: input.people } : {}),
    ...(memory ? { memory } : {}),
    // Before an answer is sent: every document number and figure in it is something he read, or he is asked once to put it right.
    check: (answer, sources) => {
      const found = unsupportedIn(answer, sources);
      return isClean(found) ? null : correctionFor(found);
    },
    runTool: toolRunnerFor(input.ctx, input.files ?? [], input.actions, { userName: input.userName, chat: input.chat ?? input.actions?.chat ?? null, lastExchange, question: input.question }),
  });
  // What they asked and how he began to answer, for "continue" another day. Never a reason to lose the answer.
  notes.noteExchange({ userId: input.ctx.principal.userId, question: input.question, answer: result.text, tools: result.used });
  return result;
}
