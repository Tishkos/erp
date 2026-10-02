/**
 * The agent — REQ-WA-001 WA-3, "Brain, tier 2" — the loop and the instructions.
 *
 * WA-2's router maps a sentence onto one of eleven catalogue intents. That is
 * fast, cheap and exact, and it is also the whole of its ability: "send me the
 * inventories", "all", "why is Najaf so low?" and "what does *stopped* mean?"
 * are not in the catalogue, so the bot said it could not answer — which is
 * what the sponsor objected to on 2026-10-02: *we don't want limitation, we
 * want it to understand the whole company and explain things*.
 *
 * So this: a conversation with a model that holds the ERP's own vocabulary in
 * its instructions and reads the books through tools. Three properties are
 * kept exactly as WA-1 and WA-2 established them, because they are what make
 * a chat window safe to point at a company's books:
 *
 *   * **Read-only at the database.** Every tool runs on the caller's
 *     transaction, which PostgreSQL itself holds read-only, under the asker's
 *     own user, branch and grants (W-R1). The model cannot write a query, let
 *     alone a row: it chooses a tool and arguments, and the tool is ERP code
 *     that was already serving a screen.
 *   * **No actions.** Nothing here approves, posts or cancels anything. A
 *     decision from chat is WA-6's four locks, which this never touches.
 *   * **Grounded.** The instructions forbid inventing a figure: a number
 *     reaches the group because a tool returned it. Asked something no tool
 *     can answer, it says so — the refusal sentence is the honest answer and
 *     the audit trail records the miss, so the tools grow from real demand.
 *
 * The conversation is the last few messages of that chat, so "all" after a
 * list of warehouses means what a person means by it.
 */
import type { BotLocale } from './whatsapp';

/** The slice of the Messages API the agent uses, so a test can fake it. */
export interface AgentClient {
  create(input: {
    model: string;
    max_tokens: number;
    system: string;
    tools: ReadonlyArray<{ name: string; description: string; input_schema: Record<string, unknown> }>;
    messages: ReadonlyArray<AgentMessage>;
  }): Promise<{
    readonly stop_reason?: string | null;
    readonly content: ReadonlyArray<{
      readonly type: string;
      readonly text?: string;
      readonly id?: string;
      readonly name?: string;
      readonly input?: unknown;
    }>;
  }>;
}

/**
 * What one tool call produced: the words for the model, and — when the ERP
 * drew a printable report on the way — the thing to attach. The model is
 * opaque here on purpose: the loop does not care what a PDF is.
 */
export interface ToolOutcome {
  readonly text: string;
  readonly attachment?: {
    readonly model: unknown;
    readonly format?: 'pdf' | 'xlsx';
    readonly exportObject?: string;
    readonly exportKey?: string;
  } | null;
}

export type AgentMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: unknown }
  | { role: 'user'; content: ReadonlyArray<{ type: 'tool_result'; tool_use_id: string; content: string }> };

/** One exchange already in the chat, oldest first. */
export interface PriorTurn {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

const string = { type: 'string' } as const;
const integer = { type: 'integer', minimum: 0, maximum: 3650 } as const;
const boolean = { type: 'boolean' } as const;
const noArgs = { type: 'object', properties: {}, additionalProperties: false } as const;

/**
 * What the agent may read. Each one is an existing answer the ERP already
 * gives a screen — nothing here is a new query, and there is no tool that
 * takes SQL, a table name, or a user to act as.
 */
export const AGENT_TOOLS = [
  {
    name: 'company_summary',
    description:
      'Today across the company: approvals waiting, stopped payables, what falls due this week, cash and bank balances, receivable and payable totals, the result so far, SWIFT pending. Start here when the question is broad ("how are we doing", "anything urgent").',
    input_schema: noArgs,
  },
  {
    name: 'list_warehouses',
    description: 'Every warehouse with its code and name. Use it before asking for stock when the asker named no warehouse, or named one loosely.',
    input_schema: noArgs,
  },
  {
    name: 'warehouse_stock',
    description:
      'What is in one warehouse: every item, the quantity, and the FIFO value in IQD. Call it once per warehouse — to answer "all warehouses" or "the inventories", call it for each warehouse from list_warehouses and add the totals up yourself.',
    input_schema: { type: 'object', properties: { warehouse: { ...string, description: 'The warehouse name or code.' } }, required: ['warehouse'], additionalProperties: false },
  },
  {
    name: 'payable_status',
    description: 'One payable — import, purchase, service, rent or advance — by its number, with its stage, amounts, invoices and any stop.',
    input_schema: { type: 'object', properties: { no: { ...string, description: 'The payable number, such as IMP-HQ-2026-000004.' } }, required: ['no'], additionalProperties: false },
  },
  {
    name: 'application_status',
    description: 'One payment application by its PAYAPP number: method, bank, amount, status, and what it is waiting for.',
    input_schema: { type: 'object', properties: { no: string }, required: ['no'], additionalProperties: false },
  },
  {
    name: 'swift_pending',
    description: 'SWIFT payments sent to the bank and still unconfirmed, pending at least N days. Use 0 for all of them.',
    input_schema: { type: 'object', properties: { minDays: integer }, required: ['minDays'], additionalProperties: false },
  },
  {
    name: 'payables_due',
    description: 'Payables falling due in the next seven days.',
    input_schema: noArgs,
  },
  {
    name: 'payables_stopped',
    description: 'Payables that are stopped (on hold). Pass needsReason true for only those whose stop has no reason recorded yet.',
    input_schema: { type: 'object', properties: { needsReason: boolean }, required: ['needsReason'], additionalProperties: false },
  },
  {
    name: 'partner_balance',
    description: "A customer's or supplier's balance and statement totals, by name or code. Side is 'customer' or 'supplier'.",
    input_schema: {
      type: 'object',
      properties: { side: { ...string, enum: ['customer', 'supplier'] }, party: { ...string, description: 'The name or code as the asker wrote it.' } },
      required: ['side', 'party'],
      additionalProperties: false,
    },
  },
  {
    name: 'trial_balance',
    description:
      'The trial balance: every account with its debit, credit and balance, to a date. This is where the real financial position lives — receivables, payables, cash, stock value, revenue, expenses. Use it for "how much do we have", "what is our position", "profit", any accounting question.',
    input_schema: {
      type: 'object',
      properties: {
        to: { ...string, description: 'As-at date, YYYY-MM-DD. Today when not stated.' },
        currency: { ...string, enum: ['IQD', 'USD'], description: 'IQD unless the asker wants USD.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'open_items',
    description:
      "Unpaid invoices with their age — side 'customer' for who owes us, 'supplier' for what we owe. The answer to \"who owes us the most\", \"what is overdue\", \"collections\".",
    input_schema: {
      type: 'object',
      properties: {
        side: { ...string, enum: ['customer', 'supplier'] },
        party: { ...string, description: 'Optional: one partner code, to see only theirs.' },
      },
      required: ['side'],
      additionalProperties: false,
    },
  },
  {
    name: 'stock_valuation',
    description:
      'Stock by item and warehouse with quantity and FIFO value, filtered by item text or warehouse. Use it for "how much of X do we have", "where is X", "total stock value", and for one item across every warehouse.',
    input_schema: {
      type: 'object',
      properties: {
        item: { ...string, description: 'Item name or code, any part of it.' },
        warehouse: { ...string, description: 'Warehouse code, when only one is wanted.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_partners',
    description: "Customers or suppliers with their codes, so a name can be matched before asking for a balance. Side is 'customer' or 'supplier'.",
    input_schema: { type: 'object', properties: { side: { ...string, enum: ['customer', 'supplier'] } }, required: ['side'], additionalProperties: false },
  },
  {
    name: 'approvals_waiting',
    description:
      'What is waiting for THIS person to approve, with each document number. Use it for "what needs me", "anything to approve", and before telling somebody how to approve something.',
    input_schema: noArgs,
  },
  {
    name: 'what_the_bot_can_do',
    description: 'The short list of set phrases the bot also understands. Use it only when asked what it can do.',
    input_schema: noArgs,
  },
] as const;

type ToolName = (typeof AGENT_TOOLS)[number]['name'];

/**
 * The instructions.
 *
 * Long on purpose: this is where the bot's understanding of the business
 * lives, and it is cheaper and far more predictable to teach it here than to
 * let it guess from table names. It carries the company, the modules, the
 * vocabulary a question will use, and the manners a group chat wants.
 */
export function systemPrompt(input: { readonly locale: BotLocale; readonly userName: string; readonly branchCode: string; readonly today: string }): string {
  return [
    'You are the assistant of the Qimah Al-Safinah ERP (QS), an Iraqi trading company that imports solar equipment and motorcycles and sells them through branches and warehouses.',
    `You are answering ${input.userName}, working in branch ${input.branchCode}. Today is ${input.today}. The books are kept in Iraqi dinars (IQD); foreign purchases are in USD and converted at the accounting rate.`,
    '',
    'WHAT THE SYSTEM HOLDS, so you can explain it as well as read it:',
    '• Payables — one record per thing the company owes, of five kinds: an import application (goods bought abroad), a service or expense, a recurring contract (rent, utilities), local goods, and an advance. Each moves along numbered stages, and each has lanes (order, bank, payment, customs/PD, shipment, warehouse, cost) that progress independently.',
    '• A payable can be STOPPED: a hold, with a reason code, an owner and a next action. A stop raised automatically by the nightly sweep starts with no reason and waits for a person to give one — that is what "needing a reason" means.',
    '• Purchase invoices, goods receipts and purchase orders sit under payables. An invoice posts a journal; stock arrives through a goods receipt or a container receipt.',
    '• Payments go out as payment applications (SWIFT, local transfer, cash, cheque). Approval reserves the money; confirmation posts it. A SWIFT sent and not yet confirmed by the bank is "pending" — chased after a number of days.',
    '• Imports also carry customs PDs (ASYCUDA declarations), bills of lading and containers, and a landed cost that is locked once the file is complete, which restates the stock value.',
    '• Inventory is one ledger: every movement is a row, stock quantity is the sum of them, and value is FIFO cost layers. Goods at sea are owned but held in a transit warehouse, so they are not available to sell.',
    '• Sales, customers and receipts mirror the purchase side. The general ledger underneath is double-entry with branches, departments and cost centres as dimensions.',
    '',
    'HOW TO ANSWER:',
    '• Be a colleague, not a form. Answer the question that was asked, in the language it was asked in (Arabic or English), briefly — this is WhatsApp, not a report.',
    '• Every figure must come from a tool call. Never estimate, never carry a number over from memory of an earlier chat, never invent a document number. If the tools cannot reach it, say plainly what you cannot see and what you would need.',
    '• A broad question deserves work, not a refusal: "send me the inventories" means list the warehouses and read each one. "All" after a list means all of them. Follow the conversation.',
    '• Explaining the system needs no tool. If asked what a stage means, how an import flows, why something is stopped, or what the company should look at — explain it from what you know above, and read the books when the answer depends on them.',
    '• You may not change anything. You cannot approve, post, pay or cancel. If asked to, say that approving is done by sending: approve <document number> — and that the person must be allowed to decide and will be sent a code to confirm.',
    '• Figures are IQD unless said otherwise. Write large numbers with thousands separators. Name the warehouse, supplier or document you are talking about.',
    input.locale === 'ar' ? '• Reply in Arabic.' : '• Reply in English unless the question was in Arabic.',
  ].join('\n');
}

export interface AgentResult {
  readonly text: string;
  /** The last printable model a tool produced, for the attachment. */
  readonly model: unknown | null;
  readonly format?: 'pdf' | 'xlsx';
  readonly exportObject?: string;
  readonly exportKey?: string;
  /** For the log: which tools it used, in order. */
  readonly used: readonly string[];
}

/** How many times round the loop before it must answer with what it has. */
const MAX_ROUNDS = 8;

export async function runAgent(input: {
  readonly client: AgentClient;
  readonly model: string;
  readonly question: string;
  readonly history?: readonly PriorTurn[];
  readonly userName: string;
  readonly locale: BotLocale;
  readonly branchCode: string;
  readonly today: string;
  /**
   * Runs one tool and returns what to tell the model. Injected, because the
   * loop is a conversation and the tools are the ERP: this file must be
   * readable — and testable — without a database behind it.
   */
  readonly runTool: (name: string, args: Record<string, unknown>) => Promise<ToolOutcome>;
}): Promise<AgentResult> {
  const system = systemPrompt({ locale: input.locale, userName: input.userName, branchCode: input.branchCode, today: input.today });

  const messages: AgentMessage[] = [];
  for (const turn of input.history ?? []) {
    // Prior turns go in as plain text on both sides: what was asked, and what
    // the bot said. Tool traffic from earlier questions is not replayed.
    messages.push(turn.role === 'user' ? { role: 'user', content: turn.text } : { role: 'assistant', content: turn.text });
  }
  messages.push({ role: 'user', content: input.question });

  const used: string[] = [];
  let lastAttachment: ToolOutcome['attachment'] = null;

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const reply = await input.client.create({
      model: input.model,
      max_tokens: 2048,
      system,
      tools: AGENT_TOOLS as unknown as ReadonlyArray<{ name: string; description: string; input_schema: Record<string, unknown> }>,
      messages,
    });

    const calls = reply.content.filter((block) => block.type === 'tool_use');
    const said = reply.content
      .filter((block) => block.type === 'text')
      .map((block) => (block.text ?? '').trim())
      .filter(Boolean)
      .join('\n');

    if (calls.length === 0) {
      return {
        text: said || input.locale === 'ar' ? said || 'لم أفهم السؤال. أعد صياغته من فضلك.' : said || 'I did not follow that — could you put it another way?',
        model: lastAttachment?.model ?? null,
        ...(lastAttachment?.format ? { format: lastAttachment.format } : {}),
        ...(lastAttachment?.exportObject ? { exportObject: lastAttachment.exportObject } : {}),
        ...(lastAttachment?.exportKey ? { exportKey: lastAttachment.exportKey } : {}),
        used,
      };
    }

    messages.push({ role: 'assistant', content: reply.content });
    const results: { type: 'tool_result'; tool_use_id: string; content: string }[] = [];
    for (const call of calls) {
      const name = call.name ?? '';
      const args = (call.input ?? {}) as Record<string, unknown>;
      used.push(name);
      try {
        const outcome = await input.runTool(name, args);
        if (outcome.attachment?.model) lastAttachment = outcome.attachment;
        results.push({ type: 'tool_result', tool_use_id: call.id ?? '', content: outcome.text.slice(0, 12_000) });
      } catch (error) {
        // A tool that refuses is information, not a crash: the model is told
        // what the ERP said and can explain it or try another way.
        results.push({
          type: 'tool_result',
          tool_use_id: call.id ?? '',
          content: `The system refused: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    messages.push({ role: 'user', content: results });
  }

  return {
    text:
      input.locale === 'ar'
        ? 'بحثت في عدة أماكن ولم أصل إلى إجابة واحدة. حدّد السؤال أكثر من فضلك.'
        : 'I looked in several places without arriving at one answer — could you narrow the question?',
    model: lastAttachment?.model ?? null,
    used,
  };
}
