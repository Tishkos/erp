/**
 * REQ-WA-001 WA-3 — the agent's loop and its instructions, with a fake model.
 *
 * No key, no network and no database: the loop lives in the domain precisely
 * so this can be asserted in isolation, with the tools injected. What must
 * hold however the model behaves:
 *
 *   • it may call only the declared tools, and nothing declared can write;
 *   • a tool that throws is reported to the model, not raised at the user;
 *   • the loop ends — a model that calls tools for ever is cut off with an
 *     answer rather than running until the socket times out;
 *   • the conversation so far is passed, so a follow-up has something to
 *     follow;
 *   • the instructions carry the company and forbid inventing figures, which
 *     is the only reason a number in the group can be trusted.
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_TOOLS,
  runAgent,
  systemPrompt,
  type AgentClient,
  type ToolOutcome,
} from '@/server/domain/whatsapp-agent';

const base = {
  model: 'fake',
  userName: 'Baban',
  locale: 'en' as const,
  branchCode: 'HQ',
  today: '2026-10-02',
};

/** A model that calls the named tools in order, then says the given sentence. */
function fakeClient(script: { tool: string; input?: unknown }[], answer: string): AgentClient {
  let round = 0;
  return {
    create: async () => {
      const step = script[round];
      round += 1;
      if (!step) return { content: [{ type: 'text', text: answer }] };
      return { content: [{ type: 'tool_use', id: `t${round}`, name: step.tool, input: step.input ?? {} }] };
    },
  };
}

const says = (text: string) => async (): Promise<ToolOutcome> => ({ text });

describe('WA-3 · the tool list', () => {
  it('declares nothing that could write', () => {
    // By word, not by substring: `payable_status` is a noun and a reading,
    // and a test that reads "pay" inside it would forbid the thing it wants.
    const verbs = new Set([
      'approve',
      'reject',
      'post',
      'create',
      'update',
      'delete',
      'cancel',
      'submit',
      'pay',
      'send',
      'set',
      'write',
      'confirm',
      'reverse',
    ]);
    for (const tool of AGENT_TOOLS) {
      // WA-8 — `propose_action` is the one door out, and it does not open
      // itself: it records an intention and hands back the facts to put to a
      // person. The lock is that it writes nothing, which is the next test.
      if (tool.name === 'propose_action') continue;
      for (const word of tool.name.split('_')) {
        expect(verbs.has(word), `${tool.name} contains the action verb "${word}"`).toBe(false);
      }
    }
  });

  it('lets only propose_action reach an action, and says it changes nothing', () => {
    const propose = AGENT_TOOLS.find((tool) => tool.name === 'propose_action');
    expect(propose).toBeDefined();
    // The description is the instruction the model follows at the moment it
    // matters, so these words are load-bearing: it must not believe it has
    // done anything.
    expect(propose!.description).toMatch(/nothing happens/i);
    expect(propose!.description).toMatch(/answer yes before anything runs/i);
    expect(propose!.description).toMatch(/never say you have done something/i);
  });

  it('takes nobody to act as — a question always runs as the person asking', () => {
    // WA-9 gave him SQL, so `sql` and `table` are now expected. What must
    // never appear is a way to name a different principal: the read runs as
    // the asker, under their own row-level security, or it does not run.
    for (const tool of AGENT_TOOLS) {
      expect(JSON.stringify(tool.input_schema), tool.name).not.toMatch(/user_?id|principal|as_user|scope/i);
    }
  });

  it('gives every tool a description a model can choose from', () => {
    for (const tool of AGENT_TOOLS) {
      expect(tool.description.length, tool.name).toBeGreaterThan(30);
      expect(tool.input_schema).toHaveProperty('type', 'object');
    }
  });

  it('names each tool once, and covers the books as well as the payables', () => {
    const names = AGENT_TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const needed of ['trial_balance', 'open_items', 'stock_valuation', 'approvals_waiting', 'list_warehouses']) {
      expect(names, needed).toContain(needed);
    }
  });
});

describe('WA-3 · the instructions', () => {
  const prompt = systemPrompt({ locale: 'en', userName: 'Baban', branchCode: 'HQ', today: '2026-10-02' });

  it('carries the company and the person it is answering', () => {
    expect(prompt).toContain('Qimah Al-Safinah');
    expect(prompt).toContain('Baban');
    expect(prompt).toContain('HQ');
    expect(prompt).toContain('2026-10-02');
  });

  it('teaches the vocabulary a question will use', () => {
    for (const word of ['payable', 'STOPPED', 'SWIFT', 'FIFO', 'PD', 'container', 'landed cost']) {
      expect(prompt, word).toContain(word);
    }
  });

  it('forbids inventing a figure', () => {
    expect(prompt).toMatch(/must come from a tool call/i);
    expect(prompt).toMatch(/never estimate/i);
  });

  it('allows acting only as propose, then ask, then it runs', () => {
    // He may change things now (2026-10-02, by direction). The rule that
    // replaced "you may not" is the one that has to be in front of him every
    // time, because the failure it prevents is telling somebody a thing is
    // done when nobody agreed to it.
    expect(prompt).toMatch(/PROPOSE, THEN ASK, THEN IT RUNS/);
    expect(prompt).toMatch(/changes nothing/i);
    expect(prompt).toMatch(/never say a thing is done when you have only proposed it/i);
    // And the limits of it: their own inbox, their own permissions.
    expect(prompt).toMatch(/waiting in that person's own approval inbox/i);
    expect(prompt).toMatch(/maker-checker/i);
  });

  it('tells him to write a query rather than claim he cannot see something', () => {
    expect(prompt).toMatch(/read the whole database with the query tool/i);
    expect(prompt).toMatch(/never say "my tools cannot see that"/i);
    expect(prompt).toMatch(/Look at the schema before you write/i);
  });

  it('answers in Arabic when asked in Arabic', () => {
    expect(systemPrompt({ ...base, locale: 'ar' })).toMatch(/Reply in Arabic/);
  });
});

describe('WA-3 · the loop', () => {
  it('answers with the model’s words when it calls nothing', async () => {
    const result = await runAgent({
      ...base,
      client: fakeClient([], 'An import is a payable whose goods come from abroad.'),
      question: 'what is an import application?',
      runTool: says('unused'),
    });
    expect(result.text).toContain('goods come from abroad');
    expect(result.used).toEqual([]);
  });

  it('records which tools it used, in order', async () => {
    const asked: string[] = [];
    const result = await runAgent({
      ...base,
      client: fakeClient([{ tool: 'list_warehouses' }, { tool: 'warehouse_stock', input: { warehouse: 'WH-0005' } }], 'Najaf holds 16 items.'),
      question: 'what is in Najaf?',
      runTool: async (name) => {
        asked.push(name);
        return { text: `result of ${name}` };
      },
    });
    expect(asked).toEqual(['list_warehouses', 'warehouse_stock']);
    expect(result.used).toEqual(['list_warehouses', 'warehouse_stock']);
    expect(result.text).toBe('Najaf holds 16 items.');
  });

  it('tells the model when a tool refuses, and still answers', async () => {
    let told = '';
    const client: AgentClient = {
      create: async (input) => {
        const last = input.messages[input.messages.length - 1];
        const content = (last as { content: unknown }).content;
        if (Array.isArray(content)) {
          told = String((content[0] as { content?: string }).content ?? '');
          return { content: [{ type: 'text', text: 'The ledger would not answer just now.' }] };
        }
        return { content: [{ type: 'tool_use', id: 't1', name: 'trial_balance', input: {} }] };
      },
    };
    const result = await runAgent({
      ...base,
      client,
      question: 'what is our position?',
      runTool: async () => {
        throw new Error('Permission denied: view on journal_entry');
      },
    });
    expect(told).toMatch(/The system refused: Permission denied/);
    expect(result.text).toContain('would not answer');
  });

  it('keeps the whole answer when a tool returns a lot, but bounds what it sends', async () => {
    let sent = 0;
    const client: AgentClient = {
      create: async (input) => {
        const last = input.messages[input.messages.length - 1];
        const content = (last as { content: unknown }).content;
        if (Array.isArray(content)) {
          sent = String((content[0] as { content?: string }).content ?? '').length;
          return { content: [{ type: 'text', text: 'done' }] };
        }
        return { content: [{ type: 'tool_use', id: 't1', name: 'stock_valuation', input: {} }] };
      },
    };
    await runAgent({ ...base, client, question: 'everything', runTool: says('x'.repeat(50_000)) });
    expect(sent).toBeLessThanOrEqual(12_000);
  });

  it('stops after a bounded number of rounds rather than looping for ever', async () => {
    const forever: AgentClient = {
      create: async () => ({ content: [{ type: 'tool_use', id: 't', name: 'company_summary', input: {} }] }),
    };
    const result = await runAgent({ ...base, client: forever, question: 'go on then', runTool: says('again') });
    expect(result.used.length).toBeLessThanOrEqual(8);
    expect(result.text).toMatch(/narrow the question/i);
  });

  it('passes the conversation so far, so a follow-up has something to follow', async () => {
    const seen: unknown[] = [];
    const client: AgentClient = {
      create: async (input) => {
        seen.push(input.messages);
        return { content: [{ type: 'text', text: 'All of them: …' }] };
      },
    };
    await runAgent({
      ...base,
      client,
      question: 'all',
      history: [
        { role: 'user', text: 'stock in warehouses' },
        { role: 'assistant', text: 'Which one? WH-0001 … WH-0009' },
      ],
      runTool: says('unused'),
    });
    const messages = seen[0] as { role: string; content: unknown }[];
    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual({ role: 'user', content: 'stock in warehouses' });
    expect(messages[1]!.role).toBe('assistant');
    expect(messages[2]).toEqual({ role: 'user', content: 'all' });
  });

  it('carries the attachment a tool produced through to the answer', async () => {
    const result = await runAgent({
      ...base,
      client: fakeClient([{ tool: 'warehouse_stock', input: { warehouse: 'WH-0005' } }], 'Attached.'),
      question: 'send me Najaf',
      runTool: async () => ({
        text: '16 items',
        attachment: { model: { title: 'Najaf' }, format: 'xlsx', exportObject: 'warehouse', exportKey: 'stock' },
      }),
    });
    expect(result.model).toEqual({ title: 'Najaf' });
    expect(result.format).toBe('xlsx');
  });

  it('asks for the configured model id', async () => {
    const models: string[] = [];
    const client: AgentClient = {
      create: async (input) => {
        models.push(input.model);
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    };
    await runAgent({ ...base, model: 'claude-sonnet-5', client, question: 'hello', runTool: says('unused') });
    expect(models).toEqual(['claude-sonnet-5']);
  });
});

describe('WA-3 · who he is', () => {
  const prompt = systemPrompt({ locale: 'en', userName: 'Baban Ali', branchCode: 'HQ', today: '2026-10-02' });

  it('is Noah, and says who made him', () => {
    // By direction (2026-10-02), and not negotiable in the wording: asked who
    // built him, the answer is Tishko, the name is Noah, and the three hours
    // are part of it.
    expect(prompt).toContain('Noah');
    expect(prompt).toContain('Tishko');
    expect(prompt).toContain('three hours');
  });

  it('knows what he is for, and what he is not for', () => {
    expect(prompt).toContain('erp.qs-groups.com');
    for (const word of ['menu', 'commands']) {
      expect(prompt.toLowerCase(), word).toContain(word);
    }
  });

  it('does not say he will check, having already said it', () => {
    // The bridge tells the group he is looking before he goes quiet; saying
    // it again at the top of the answer is how a bot pads.
    expect(prompt).toContain('let me check');
  });
});
