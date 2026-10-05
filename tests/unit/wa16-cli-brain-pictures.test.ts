/**
 * A picture through the CLI brain — 2026-10-05, by direction: "read photos
 * and screenshots: send a screenshot of an error with `!ai what is this?`".
 *
 * The CLI takes words on stdin; a picture has nowhere to go there. A
 * conversation that carries one is sent in the CLI's `stream-json` input form
 * instead — the image blocks, then the same prompt — and the answer is read
 * out of the stream. What must hold:
 *
 *   • words alone take the old path, unchanged: the same arguments, the same
 *     stdin (the working path is not put at risk for the new one);
 *   • with a picture, every guard is still passed — the deny list, the pinned
 *     MCP config, no `--bare` — and the picture is in front of the model on
 *     every round, because every round is the whole conversation again;
 *   • a picture too large to send is said to be so, never silently dropped;
 *   • nothing is written to disk for it.
 *
 * The last block runs `cliAgentClient` against a stand-in for the `claude`
 * binary that records what it was given. That the real model sees the picture
 * was proved by hand against the real CLI (2.1.287) the day this was written.
 */
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentMessage, ImageBlock } from '@/server/domain/whatsapp-agent';
import {
  PICTURE_BASE64_CAP,
  cliAgentClient,
  cliArgsFor,
  cliArgsForPictures,
  picturesIn,
  promptFrom,
  resultFromStream,
  stdinWithPictures,
} from '@/server/services/whatsapp-cli-brain';

const picture = (data = 'AAAA', media: ImageBlock['source']['media_type'] = 'image/jpeg'): ImageBlock => ({ type: 'image', source: { type: 'base64', media_type: media, data } });
const asked = (text: string, ...pictures: ImageBlock[]): AgentMessage => ({ role: 'user', content: [...pictures, { type: 'text', text }] });

describe('the arguments for a call with a picture', () => {
  const plain = cliArgsFor('claude-opus-5-5', '/tmp/x/mcp.json', 'high');
  const withPictures = cliArgsForPictures('claude-opus-5-5', '/tmp/x/mcp.json', 'high');

  it('leaves the arguments for words alone exactly as they were', () => {
    expect(plain).toEqual([
      '-p',
      '--output-format',
      'json',
      '--model',
      'claude-opus-5-5',
      '--effort',
      'high',
      '--disallowedTools',
      'Bash,Read,Write,Edit,NotebookEdit,Glob,Grep,WebFetch,WebSearch,Task,Agent,TodoWrite,Artifact',
      '--strict-mcp-config',
      '--mcp-config',
      '/tmp/x/mcp.json',
    ]);
  });

  it('carries the message as stream-json, which the CLI only takes with stream-json out and --verbose', () => {
    expect(withPictures.slice(0, 6)).toEqual(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']);
  });

  it('changes how the message is carried and nothing about what the CLI may do', () => {
    // Everything after the format flags is the text call's, to the letter:
    // the model, the effort, the deny list (Read among them — a picture is
    // never a reason to let the CLI open a file), the pinned-off MCP servers.
    expect(withPictures.slice(6)).toEqual(plain.slice(3));
    expect(withPictures).not.toContain('--bare');
    expect(withPictures).not.toContain('--allowedTools');
    expect((withPictures[withPictures.indexOf('--disallowedTools') + 1] ?? '').split(',')).toEqual(expect.arrayContaining(['Read', 'Bash', 'Write', 'WebFetch']));
  });
});

describe('the pictures of a conversation', () => {
  it('are the image blocks the person sent, in order, wherever they are in it', () => {
    const first = picture('ONE');
    const second = picture('TWO', 'image/png');
    const messages: AgentMessage[] = [
      asked('what is this?', first, second),
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'guide', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'the guide' }] },
    ];
    expect(picturesIn(messages)).toEqual({ pictures: [first, second], dropped: 0 });
    expect(picturesIn([{ role: 'user', content: 'no picture here' }])).toEqual({ pictures: [], dropped: 0 });
  });

  it('leaves out one that is too large, empty, or of a kind the model cannot look at — and counts it', () => {
    const fine = picture('OK');
    const huge = picture('A'.repeat(PICTURE_BASE64_CAP + 1));
    const empty = picture('');
    const odd = { type: 'image', source: { type: 'base64', media_type: 'image/tiff', data: 'AAAA' } } as unknown as ImageBlock;
    expect(picturesIn([asked('look', huge, fine, empty, odd)])).toEqual({ pictures: [fine], dropped: 3 });
    // Exactly at the cap still goes.
    expect(picturesIn([asked('look', picture('A'.repeat(PICTURE_BASE64_CAP)))]).dropped).toBe(0);
  });

  it('never takes a picture from his own side of the conversation', () => {
    expect(picturesIn([{ role: 'assistant', content: [picture('MINE')] }])).toEqual({ pictures: [], dropped: 0 });
  });
});

describe('the transcript, when the person sent a picture', () => {
  it('says the picture was sent and that the words are the person’s', () => {
    const prompt = promptFrom([asked('What is the heading on this page?', picture())]);
    expect(prompt).toContain('PERSON sent a picture with this message — attached above this text, in the order sent. Look at it before you answer.');
    expect(prompt).toContain('PERSON: What is the heading on this page?');
    // His own words are still his: only a person's text block is the person's.
    expect(prompt).not.toMatch(/^YOU: What is the heading/m);
    expect(promptFrom([{ role: 'assistant', content: [{ type: 'text', text: 'Which screen?' }] }])).toBe('YOU: Which screen?');
  });

  it('counts several, and says plainly when one was not seen', () => {
    expect(promptFrom([asked('compare these', picture('ONE'), picture('TWO'))])).toContain('PERSON sent 2 pictures with this message — attached above this text, in the order sent. Look at them before you answer.');
    const huge = picture('A'.repeat(PICTURE_BASE64_CAP + 1));
    expect(promptFrom([asked('and this?', huge)])).toContain('PERSON sent a picture with this message, too large to look at: you have NOT seen it.');
    expect(promptFrom([asked('and these?', picture('OK'), huge)])).toContain('PERSON sent 2 pictures with this message — 1 attached above this text, in the order sent; 1 too large to look at.');
  });

  it('is the old transcript, to the letter, when nobody sent a picture', () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: 'what is in Najaf?' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'warehouse_stock', input: { warehouse: 'WH-0005' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '16 items' }] },
    ];
    expect(promptFrom(messages)).toBe('PERSON: what is in Najaf?\n\nYOU ASKED FOR: warehouse_stock {"warehouse":"WH-0005"}\n\nTOOL RESULT:\n16 items');
  });
});

describe('what goes in, and what comes back', () => {
  it('puts the pictures first and the whole prompt after them, as one line', () => {
    const blocks = [picture('ONE'), picture('TWO', 'image/png')];
    const line = stdinWithPictures('THE WHOLE PROMPT\nwith its lines', blocks);
    expect(line.endsWith('\n')).toBe(true);
    expect(line.trimEnd().includes('\n')).toBe(false);
    expect(JSON.parse(line)).toEqual({
      type: 'user',
      message: { role: 'user', content: [...blocks, { type: 'text', text: 'THE WHOLE PROMPT\nwith its lines' }] },
    });
  });

  it('reads the answer out of the stream: the last result, and whether it was an error', () => {
    const stream = [
      '{"type":"system","subtype":"init"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"{\\"answer\\":\\"seen\\"}"}]}}',
      '{"type":"rate_limit_event"}',
      '{"type":"result","subtype":"success","is_error":false,"result":"{\\"answer\\":\\"seen\\"}"}',
    ].join('\n');
    expect(resultFromStream(stream)).toEqual({ text: '{"answer":"seen"}', isError: false });
    expect(resultFromStream('{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Not logged in"}')).toEqual({ text: 'Not logged in', isError: true });
    expect(resultFromStream('{"type":"system","subtype":"init"}\nnot json at all')).toBeNull();
    expect(resultFromStream('')).toBeNull();
  });
});

describe('the whole call, against a stand-in for the claude binary', () => {
  /** A `claude` that writes down what it was given and answers in the form it was asked for. */
  function standIn(): { readonly dir: string; readonly command: string; readonly calls: () => { args: string[]; stdin: string }[] } {
    const dir = mkdtempSync(join(tmpdir(), 'qs-fake-claude-'));
    writeFileSync(
      join(dir, 'fake.mjs'),
      [
        "import { readFileSync, readdirSync, writeFileSync } from 'node:fs';",
        "import { dirname, join } from 'node:path';",
        "import { fileURLToPath } from 'node:url';",
        'const here = dirname(fileURLToPath(import.meta.url));',
        'const args = process.argv.slice(2);',
        "const stdin = readFileSync(0, 'utf8');",
        "const n = readdirSync(here).filter((name) => name.startsWith('call-')).length;",
        "writeFileSync(join(here, `call-${n}.json`), JSON.stringify({ args, stdin }));",
        "const answer = JSON.stringify({ answer: stdin.includes('\"type\":\"image\"') ? 'I can see the picture.' : 'Words only.' });",
        "if (args[args.indexOf('--output-format') + 1] === 'stream-json') {",
        "  console.log(JSON.stringify({ type: 'system', subtype: 'init' }));",
        "  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: answer }));",
        '} else {',
        "  console.log(JSON.stringify({ type: 'result', result: answer }));",
        '}',
      ].join('\n'),
    );
    let command: string;
    if (process.platform === 'win32') {
      command = join(dir, 'claude.cmd');
      writeFileSync(command, '@echo off\r\nnode "%~dp0fake.mjs" %*\r\n');
    } else {
      command = join(dir, 'claude');
      writeFileSync(command, '#!/bin/sh\nexec node "$(dirname "$0")/fake.mjs" "$@"\n');
      chmodSync(command, 0o755);
    }
    return {
      dir,
      command,
      calls: () =>
        readdirSync(dir)
          .filter((name) => name.startsWith('call-'))
          .sort()
          .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as { args: string[]; stdin: string }),
    };
  }

  const request = (messages: AgentMessage[]) => ({
    model: 'claude-opus-5-5',
    max_tokens: 400,
    system: 'You are Noah.',
    tools: [{ name: 'guide', description: 'The written guide of the ERP.', input_schema: { type: 'object' } }],
    messages,
  });

  it('sends words as it always has, and a picture as a picture — on every round of the loop', async () => {
    const fake = standIn();
    const cwd = mkdtempSync(join(tmpdir(), 'qs-wa-brain-test-'));
    const client = cliAgentClient({ command: fake.command, cwd, effort: 'high', timeoutSeconds: 30 });
    const mcp = join(cwd, 'mcp.json');
    const shown = picture('SCREENSHOT');

    // Words alone.
    const plain = await client.create(request([{ role: 'user', content: 'hello' }]));
    expect(plain.content).toEqual([{ type: 'text', text: 'Words only.' }]);

    // A picture, first round.
    const question = asked('what is this error?', shown);
    const first = await client.create(request([question]));
    expect(first.content).toEqual([{ type: 'text', text: 'I can see the picture.' }]);

    // The same question after a tool round: the picture is in front of him again.
    const second = await client.create(
      request([
        question,
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'guide', input: { search: 'error' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'The guide says: a closed period.' }] },
      ]),
    );
    expect(second.content).toEqual([{ type: 'text', text: 'I can see the picture.' }]);

    const [words, round1, round2] = fake.calls();

    // Words alone: the arguments and the stdin are the old ones — text, not a JSON line.
    expect(words!.args).toEqual(cliArgsFor('claude-opus-5-5', mcp, 'high'));
    expect(words!.stdin.startsWith('You are Noah.')).toBe(true);
    expect(words!.stdin).toContain('PERSON: hello');
    expect(words!.stdin.endsWith('Reply with one JSON object now.')).toBe(true);
    expect(words!.stdin).not.toContain('"type":"image"');
    expect(words!.stdin).not.toMatch(/too large to look at/);

    // With a picture: the stream-json arguments, and one line carrying the image block and the full prompt.
    for (const call of [round1!, round2!]) {
      expect(call.args).toEqual(cliArgsForPictures('claude-opus-5-5', mcp, 'high'));
      const sent = JSON.parse(call.stdin) as { type: string; message: { role: string; content: { type: string; text?: string }[] } };
      expect(sent.type).toBe('user');
      expect(sent.message.role).toBe('user');
      expect(sent.message.content[0]).toEqual(shown);
      expect(sent.message.content).toHaveLength(2);
      const prompt = sent.message.content[1]!.text ?? '';
      expect(prompt.startsWith('You are Noah.')).toBe(true);
      expect(prompt).toContain('HOW TO REPLY');
      expect(prompt).toContain('• guide — The written guide of the ERP.');
      expect(prompt).toContain('PERSON sent a picture with this message');
      expect(prompt).toContain('PERSON: what is this error?');
      expect(prompt.endsWith('Reply with one JSON object now.')).toBe(true);
    }
    expect(JSON.parse(round2!.stdin).message.content[1].text).toContain('TOOL RESULT:\nThe guide says: a closed period.');

    // Nothing was written for the picture: the CLI's directory holds its MCP config and nothing else.
    expect(readdirSync(cwd)).toEqual(['mcp.json']);
  }, 60_000);

  it('says a picture was too large rather than answer as though it had been seen', async () => {
    const fake = standIn();
    const cwd = mkdtempSync(join(tmpdir(), 'qs-wa-brain-test-'));
    const client = cliAgentClient({ command: fake.command, cwd, effort: 'low', timeoutSeconds: 30 });
    const reply = await client.create(request([asked('what is this?', picture('A'.repeat(PICTURE_BASE64_CAP + 1)))]));
    expect(reply.content).toEqual([{ type: 'text', text: 'Words only.' }]);
    const [call] = fake.calls();
    // No picture left to send: it goes as words, with the note.
    expect(call!.args).toEqual(cliArgsFor('claude-opus-5-5', join(cwd, 'mcp.json'), 'low'));
    expect(call!.stdin).toContain('PERSON sent a picture with this message, too large to look at: you have NOT seen it.');
    expect(call!.stdin).toContain('NOTE: a picture was too large to look at. Say so, and ask for a smaller picture or the file itself.');
    expect(call!.stdin).not.toContain('"type":"image"');
  }, 60_000);
});
