/**
 * REQ-WA-001 WA-3 — the CLI transport's own parts, without the CLI.
 *
 * The brain on a Claude subscription talks through text, so two pieces carry
 * the whole arrangement: turning the loop's messages into a transcript, and
 * reading one JSON object back out of whatever the model wrote around it. A
 * model that fences its JSON, prefixes it with a sentence, or writes prose
 * instead must all end somewhere sensible — the group gets an answer either
 * way, and never a parse error.
 */
import { describe, expect, it } from 'vitest';
import { cliArgsFor, firstJsonObject, promptFrom } from '@/server/services/whatsapp-cli-brain';
import type { AgentMessage } from '@/server/domain/whatsapp-agent';

describe('WA-3 CLI · reading one object out of the reply', () => {
  it('reads a bare object', () => {
    expect(firstJsonObject('{"tool":"list_warehouses","args":{}}')).toEqual({ tool: 'list_warehouses', args: {} });
  });

  it('reads it out of a code fence', () => {
    const said = '```json\n{"answer":"Najaf holds 16 items."}\n```';
    expect(firstJsonObject(said)).toEqual({ answer: 'Najaf holds 16 items.' });
  });

  it('reads it after a sentence the model could not resist', () => {
    const said = 'Sure — here you go:\n{"tool":"warehouse_stock","args":{"warehouse":"WH-0005"}}';
    expect(firstJsonObject(said)).toEqual({ tool: 'warehouse_stock', args: { warehouse: 'WH-0005' } });
  });

  it('handles braces inside strings, so an answer may talk about JSON', () => {
    const said = '{"answer":"I would send {this} as the shape"}';
    expect(firstJsonObject(said)).toEqual({ answer: 'I would send {this} as the shape' });
  });

  it('handles an escaped quote inside the answer', () => {
    const said = '{"answer":"the warehouse called \\"Najaf\\" holds 16"}';
    expect(firstJsonObject(said)?.answer).toBe('the warehouse called "Najaf" holds 16');
  });

  it('reads a nested object whole', () => {
    expect(firstJsonObject('{"tool":"open_items","args":{"side":"customer","party":"C-1"}}')).toEqual({
      tool: 'open_items',
      args: { side: 'customer', party: 'C-1' },
    });
  });

  it('gives null for prose, so the caller can say the prose instead', () => {
    expect(firstJsonObject('An import is a payable whose goods come from abroad.')).toBeNull();
    expect(firstJsonObject('')).toBeNull();
    expect(firstJsonObject('{not json at all}')).toBeNull();
  });
});

describe('WA-3 CLI · the transcript', () => {
  it('writes the conversation as the two sides of it', () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: 'stock in warehouses' },
      { role: 'assistant', content: 'Which one? WH-0001 … WH-0009' },
      { role: 'user', content: 'all' },
    ];
    const prompt = promptFrom(messages);
    expect(prompt).toContain('PERSON: stock in warehouses');
    expect(prompt).toContain('YOU: Which one?');
    expect(prompt).toContain('PERSON: all');
  });

  it('shows what it asked for and what came back', () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: 'what is in Najaf?' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'warehouse_stock', input: { warehouse: 'WH-0005' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '16 items, 36,327,500 IQD' }] },
    ];
    const prompt = promptFrom(messages);
    expect(prompt).toContain('YOU ASKED FOR: warehouse_stock {"warehouse":"WH-0005"}');
    expect(prompt).toContain('TOOL RESULT:');
    expect(prompt).toContain('36,327,500');
  });

  it('keeps Arabic as it was written', () => {
    const prompt = promptFrom([{ role: 'user', content: 'شنو موجود بمخزن النجف؟' }]);
    expect(prompt).toContain('شنو موجود بمخزن النجف؟');
  });
});

describe('WA-3 CLI · the arguments', () => {
  const args = cliArgsFor('claude-opus-5-5', '/tmp/x/mcp.json', 'high');

  it('does not pass --bare, whatever it looks like it is for', () => {
    // The flag reads as exactly what a bot wants — no hooks, no plugins, no
    // settings — and it skips the settings the subscription credentials live
    // beside. A host that `claude auth status` calls signed in then answers
    // every single call with "Not logged in". Found on the server,
    // 2026-10-02; this test is the only thing standing between the next
    // reader and the same afternoon.
    expect(args).not.toContain('--bare');
  });

  it('asks for the model and the effort it was told to use', () => {
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-5-5');
    expect(args).toContain('--effort');
    expect(args[args.indexOf('--effort') + 1]).toBe('high');
  });

  it('denies the CLI its own tools', () => {
    const denied = args[args.indexOf('--disallowedTools') + 1] ?? '';
    for (const tool of ['Bash', 'Read', 'Write', 'Edit', 'WebFetch', 'Task']) {
      expect(denied.split(','), tool).toContain(tool);
    }
  });

  it('pins the host\'s own MCP servers off', () => {
    // A personal Google Drive connector on the signed-in account announced
    // itself in the middle of a trial answer. The group's answers are the
    // ERP's, and nothing else's.
    expect(args).toContain('--strict-mcp-config');
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('/tmp/x/mcp.json');
  });

  it('asks for JSON back, in print mode', () => {
    expect(args).toContain('-p');
    expect(args[args.indexOf('--output-format') + 1]).toBe('json');
  });
});
