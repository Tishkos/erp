/**
 * The brain on a Claude subscription, through the `claude` CLI — REQ-WA-001
 * WA-3, second transport.
 *
 * The agent loop, the nineteen tools and the instructions are unchanged: this
 * is only a different way of asking the model what to do next. By direction
 * (2026-10-02) the company would rather spend its existing Claude
 * subscription than open an API account, so:
 *
 *     Node  →  claude -p  →  Claude (the subscription)  →  Node runs the tool
 *
 * `claude -p` is Claude Code in print mode. Two things are done to it that
 * matter:
 *
 *   * **Its own tools are denied.** Claude Code can read files and run
 *     commands; a bot answering a group has no business doing either, and the
 *     ERP's tools are executed here in Node, never by the CLI. Every built-in
 *     is on the deny list and the working directory is a directory with
 *     nothing in it.
 *   * **The protocol is one JSON object.** The CLI answers with text, so the
 *     instructions ask for exactly one object — a tool to run, or the answer
 *     — and this parses it into the content blocks the loop already
 *     understands. A reply that is neither is treated as the answer, because
 *     a sentence from the model is more use to the group than a parse error.
 *
 * The trade the sponsor already knows: subscription calls count against the
 * subscription's own limits, where an API key would have been billed per
 * token. Nothing here runs while the group is quiet.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentClient, AgentMessage } from '../domain/whatsapp-agent';

const chr10 = String.fromCharCode(10);

/** Claude Code's own tools. None of them belong in a group chat. */
const DENIED = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent',
  'TodoWrite',
  'Artifact',
];

export interface CliBrainOptions {
  /** The binary, when it is not simply `claude` on the path. */
  readonly command?: string;
  /** Seconds before one call is given up on. */
  readonly timeoutSeconds?: number;
  /** Where the CLI runs. Defaults to an empty temporary directory. */
  readonly cwd?: string;
}

export class CliBrainError extends Error {
  readonly code = 'WHATSAPP_CLI_BRAIN';
}

/** Runs the CLI once and returns what it printed on stdout. */
function runCli(
  command: string,
  args: readonly string[],
  input: string,
  options: { readonly cwd: string; readonly timeoutSeconds: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      // The server is Linux, where `claude` is an ordinary executable and a
      // shell would only add a layer to quote through. On a developer's
      // Windows machine it is a .cmd shim, which Node refuses to spawn
      // directly (EINVAL) — hence the shell there, and only there. Safe
      // because every argument below is a short flag or a path: the
      // instructions travel in a file precisely so nothing long or
      // newline-bearing is ever quoted.
      shell: process.platform === 'win32',
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new CliBrainError(`the claude CLI did not answer within ${options.timeoutSeconds}s`));
    }, options.timeoutSeconds * 1000);

    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new CliBrainError(`the claude CLI could not be started: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new CliBrainError(`the claude CLI exited ${code ?? '?'}: ${err.trim().slice(0, 400) || out.trim().slice(0, 400)}`));
    });

    child.stdin.end(input, 'utf8');
  });
}

/** The first balanced JSON object in a piece of text, or null. */
export function firstJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(text.slice(start, i + 1));
          return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** The transcript as one prompt: the CLI takes text, not a message array. */
export function promptFrom(messages: readonly AgentMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    const content = message.content;
    if (typeof content === 'string') {
      lines.push(`${message.role === 'user' ? 'PERSON' : 'YOU'}: ${content}`);
      continue;
    }
    if (Array.isArray(content)) {
      for (const block of content as { type?: string; content?: string; name?: string; input?: unknown; text?: string }[]) {
        if (block.type === 'tool_result') lines.push(`TOOL RESULT:\n${block.content ?? ''}`);
        else if (block.type === 'tool_use') lines.push(`YOU ASKED FOR: ${block.name} ${JSON.stringify(block.input ?? {})}`);
        else if (block.type === 'text' && block.text) lines.push(`YOU: ${block.text}`);
      }
    }
  }
  return lines.join('\n\n');
}

const PROTOCOL = [
  '',
  'HOW TO REPLY — this matters, read it twice:',
  'Reply with exactly one JSON object and nothing else. No prose around it, no code fence.',
  'To read something from the ERP:  {"tool": "<tool name>", "args": { … }}',
  'To answer the person:            {"answer": "<what you want to say>"}',
  'Use only the tools listed below. Call one at a time; you will be given its result and asked again.',
  'When you have what you need, answer. Put the whole answer in the "answer" string, newlines and all.',
].join('\n');

/**
 * An `AgentClient` that thinks through the CLI instead of the API.
 *
 * Same contract as the API client, so `runAgent` cannot tell them apart and
 * the loop, the tools and their tests are untouched.
 */
export function cliAgentClient(options: CliBrainOptions = {}): AgentClient {
  // On Windows the installed `claude` is a .cmd shim, which `spawn` cannot
  // start by bare name; on the server it is an ordinary executable.
  const command = options.command ?? (process.platform === 'win32' ? 'claude.cmd' : 'claude');
  const timeoutSeconds = options.timeoutSeconds ?? 120;
  // Nothing to read, nothing to change: the CLI runs where there is nothing.
  const cwd = options.cwd ?? mkdtempSync(join(tmpdir(), 'qs-wa-brain-'));

  return {
    create: async (input) => {
      const tools = input.tools
        .map((tool) => `• ${tool.name} — ${tool.description}\n  arguments: ${JSON.stringify(tool.input_schema)}`)
        .join('\n');
      const system = [input.system, PROTOCOL, '', 'THE TOOLS:', tools].join(chr10);
      const prompt = `${promptFrom(input.messages)}${chr10}${chr10}Reply with one JSON object now.`;

      // The instructions and nineteen tool schemas are several kilobytes: a
      // file, not an argument. An argv that long is at best fragile and on
      // Windows is quoted by a shim that would mangle the newlines.
      const systemFile = join(cwd, 'system-prompt.txt');
      writeFileSync(systemFile, system, 'utf8');

      const raw = await runCli(
        command,
        [
          '-p',
          '--output-format',
          'json',
          '--model',
          input.model,
          '--system-prompt-file',
          systemFile,
          '--disallowedTools',
          DENIED.join(','),
          '--bare',
        ],
        prompt,
        { cwd, timeoutSeconds },
      );

      // `--output-format json` wraps the answer; older builds print it plain.
      let said = raw.trim();
      const envelope = firstJsonObject(raw);
      if (envelope && typeof envelope.result === 'string') said = envelope.result.trim();

      const decided = firstJsonObject(said);
      if (decided && typeof decided.tool === 'string') {
        return {
          content: [
            {
              type: 'tool_use',
              id: `cli-${Date.now()}`,
              name: decided.tool,
              input: (decided.args ?? {}) as Record<string, unknown>,
            },
          ],
        };
      }
      if (decided && typeof decided.answer === 'string') {
        return { content: [{ type: 'text', text: decided.answer }] };
      }
      // Neither shape: the model wrote prose. Say it rather than fail.
      return { content: [{ type: 'text', text: said }] };
    },
  };
}

/**
 * Is the CLI there, and is it signed in?
 *
 * Asked once when the bridge starts, because the two ways this fails are
 * both silent otherwise: the binary missing, and an account that has never
 * run `claude /login` on this machine. Either way the group would get an
 * apology per question with no hint as to why, so the bridge says it in the
 * log at startup instead.
 */
export async function cliReady(options: CliBrainOptions = {}): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  const client = cliAgentClient({ ...options, timeoutSeconds: options.timeoutSeconds ?? 60 });
  try {
    const reply = await client.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 64,
      system: 'Answer with one JSON object and nothing else.',
      tools: [],
      messages: [{ role: 'user', content: 'Reply with {"answer":"ready"} exactly.' }],
    });
    const said = reply.content.map((block) => block.text ?? '').join(' ');
    return said.toLowerCase().includes('ready') ? { ok: true } : { ok: false, reason: `unexpected reply: ${said.slice(0, 120)}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not logged in|\/login/i.test(message)) {
      return { ok: false, reason: 'the claude CLI is not signed in on this host — run `claude` once and sign in, then restart the bridge' };
    }
    if (/could not be started|ENOENT/i.test(message)) {
      return { ok: false, reason: 'the claude CLI is not installed on this host — npm install -g @anthropic-ai/claude-code' };
    }
    return { ok: false, reason: message };
  }
}
