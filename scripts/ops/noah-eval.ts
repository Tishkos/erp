/**
 * Noah's test set, run against the real model.
 *
 *   npx tsx scripts/ops/noah-eval.ts [--only <id | area>]… [--as <email>]
 *                                    [--concurrency 1] [--json <file>] [--list]
 *
 * By direction (2026-10-05): "50 real questions re-run after every change, so
 * he never gets worse without us noticing." The questions and what a good
 * answer must contain are `tests/noah/questions.ts`; this asks each one and
 * hands what came back to its judge.
 *
 * Each question is answered exactly as the bridge answers it — the same call
 * `scripts/ops/ask-noah.ts` makes: as the named user, in a transaction the
 * database holds read-only, with the same tools, guide, pictures and
 * instructions, by the same brain (the `claude` CLI on a subscription, or the
 * API key when there is one).
 *
 * It asks; it never acts. A proposal is recorded here and dropped — there is
 * nobody to say yes, and nothing in this file can run one. An issue he writes
 * down while being tested goes to a scratch file, never the real list.
 *
 * One line per case, a tally by area, and the whole of every answer in
 * `var/noah/eval-<yyyymmdd-hhmm>.json` so a failure can be read rather than
 * guessed at. Ends 1 when a case fails.
 *
 * Run it on the seeded development database: the facts the cases check are
 * that database's. On another database the how-to, language and system cases
 * still mean something (`--only howto --only where --only language`); the
 * ones about particular documents will not find them.
 */
import 'dotenv/config';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { sql } from 'drizzle-orm';
import { db, withScope } from '../../src/server/db/client';
import type { PendingAction } from '../../src/server/domain/whatsapp-do';
import { readerFor, readerModel } from '../../src/server/services/reader';
import * as wa from '../../src/server/services/whatsapp';
import { runAgentFor } from '../../src/server/services/whatsapp-agent';
import { CASES, DEFAULT_ASKER, judge, selectCases, type EvalArea, type EvalCase, type Observed } from '../../tests/noah/questions';

/** A question that has not come back by now is a failed case, not a hung run. */
const CASE_SECONDS = 600;

interface Options {
  readonly only: readonly string[];
  readonly asker: string;
  readonly concurrency: number;
  readonly json: string | null;
  readonly list: boolean;
}

function options(argv: readonly string[]): Options {
  const only: string[] = [];
  let asker = DEFAULT_ASKER;
  let concurrency = 1;
  let json: string | null = null;
  let list = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--only' && value) {
      only.push(value);
      index += 1;
    } else if (flag === '--as' && value) {
      asker = value.trim().toLowerCase();
      index += 1;
    } else if (flag === '--concurrency' && value) {
      concurrency = Math.min(4, Math.max(1, Number(value) || 1));
      index += 1;
    } else if (flag === '--json' && value) {
      json = value;
      index += 1;
    } else if (flag === '--list') {
      list = true;
    } else {
      throw new Error(`unknown argument ${String(flag)} — usage: npx tsx scripts/ops/noah-eval.ts [--only <id | area>]… [--as <email>] [--concurrency 1] [--json <file>] [--list]`);
    }
  }
  return { only, asker, concurrency, json, list };
}

interface Result {
  readonly id: string;
  readonly area: EvalArea;
  readonly as: string;
  readonly ask: string;
  readonly why: string;
  readonly ok: boolean;
  readonly failures: readonly string[];
  readonly seconds: number;
  readonly tools: readonly string[];
  readonly trace: unknown;
  readonly locale: string;
  readonly pictures: readonly string[];
  readonly proposed: ReadonlyArray<{ readonly action: string; readonly step: string | null; readonly on: string; readonly sentence: string }>;
  readonly answer: string;
  readonly error: string | null;
}

/** Whichever comes first: the answer, or the limit. */
function within<T>(seconds: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${seconds}s`)), seconds * 1000);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

async function main(): Promise<number> {
  const asked = options(process.argv.slice(2));
  const cases = selectCases(asked.only);
  if (asked.list) {
    for (const one of cases) console.log(`${one.id.padEnd(34)} ${one.area.padEnd(9)} ${one.ask.replace(/\s+/g, ' ').slice(0, 90)}`);
    console.log(`${cases.length} case(s) of ${CASES.length}`);
    return 0;
  }
  if (cases.length === 0) throw new Error(`no case matches ${asked.only.join(', ')} — --list shows them`);

  // Whatever he writes down while being tested is not an issue anybody reported.
  const scratch = mkdtempSync(join(tmpdir(), 'noah-eval-'));
  process.env.ERP_ISSUES_FILE = join(scratch, 'issues.md');
  // The same for what he keeps — requests, feedback, memory, walkthroughs: a test run must not teach him anything or file anything.
  process.env.NOAH_NOTES_DIR = join(scratch, 'notes');
  // As the live bridge runs (option B, the owner's setting): a how-to shows the asker's own screen.
  process.env.NOAH_HOWTO_LIVE ??= 'on';

  const client = await readerFor();
  if (!client) throw new Error('no brain is usable here: the claude CLI is not signed in and there is no ANTHROPIC_API_KEY');

  const people = new Map<string, string>();
  const userIdOf = async (email: string): Promise<string> => {
    const known = people.get(email);
    if (known) return known;
    const found = await db.execute(sql`select id from app_user where lower(email) = ${email} and is_active limit 1`);
    const id = (found.rows[0] as { id: string } | undefined)?.id;
    if (!id) throw new Error(`no active user ${email}`);
    people.set(email, id);
    return id;
  };

  const first = await userIdOf(asked.asker);
  const settings = await withScope({ userId: first, branchCode: '', isSuperUser: true }, (tx) => wa.settings(tx));
  const model = readerModel(settings.agentModel);
  const brain = (process.env.WA_BRAIN ?? '').trim().toLowerCase() === 'api' || (process.env.ANTHROPIC_API_KEY && (process.env.WA_BRAIN ?? '').trim().toLowerCase() !== 'cli') ? 'api' : 'cli';
  let revision = 'unknown';
  try {
    revision = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    /* a tree with no git (the server) is still worth testing */
  }

  const startedAt = new Date();
  console.log(`Noah's test set — ${cases.length} case(s), model ${model} via ${brain}, revision ${revision}`);
  console.log('');

  const run = async (one: EvalCase): Promise<Result> => {
    const email = (one.as ?? asked.asker).toLowerCase();
    const started = Date.now();
    const proposals: PendingAction[] = [];
    let seen: Observed;
    let trace: unknown = [];
    let pictures: string[] = [];
    try {
      const userId = await userIdOf(email);
      const reply = await within(
        CASE_SECONDS,
        wa.answer({
          userId,
          text: one.ask,
          settings,
          agent: (ctx, question, userName) =>
            runAgentFor({
              client,
              model,
              ctx,
              question,
              userName,
              chat: 'terminal',
              ...(one.history ? { history: one.history } : {}),
              // He may propose. The proposal is kept for the judge and goes
              // no further: nothing here can say yes to it.
              actions: { chat: 'terminal', propose: (pending: PendingAction) => proposals.push(pending) },
            }),
        }),
      );
      trace = reply.detail.trace ?? [];
      pictures = reply.images.map((image) => image.fileName);
      seen = {
        answer: reply.text,
        sent: reply.parts.map((part) => part.text).join('\n\n'),
        tools: (reply.detail.tools as readonly string[] | undefined) ?? [],
        locale: reply.locale,
        pictures: reply.images.length,
        proposed: proposals.map((pending) => pending.action),
        seconds: (Date.now() - started) / 1000,
      };
    } catch (error) {
      seen = {
        answer: '',
        tools: [],
        locale: '',
        pictures: 0,
        proposed: proposals.map((pending) => pending.action),
        seconds: (Date.now() - started) / 1000,
        error: error instanceof Error ? error.message.split('\n')[0]!.slice(0, 300) : String(error),
      };
    }
    const failures = judge(one, seen);
    const line = `${failures.length === 0 ? '✓' : '✗'} ${one.id.padEnd(34)} ${String(Math.round(seen.seconds)).padStart(3)}s · ${seen.tools.length > 0 ? seen.tools.join(' → ') : 'no tool'}${seen.pictures > 0 ? ` · ${seen.pictures} picture(s)` : ''}${failures.length > 0 ? `\n    ${failures[0]}${failures.length > 1 ? ` (+${failures.length - 1} more)` : ''}` : ''}`;
    console.log(line);
    return {
      id: one.id,
      area: one.area,
      as: email,
      ask: one.ask,
      why: one.why,
      ok: failures.length === 0,
      failures,
      seconds: Math.round(seen.seconds * 10) / 10,
      tools: seen.tools,
      trace,
      locale: seen.locale,
      pictures,
      proposed: proposals.map((pending) => ({ action: pending.action, step: pending.step ?? null, on: pending.target.documentNo, sentence: pending.sentence })),
      answer: seen.answer,
      error: seen.error ?? null,
    };
  };

  // In order, a few at a time: the brain is one subscription.
  const results: Result[] = new Array<Result>(cases.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= cases.length) return;
      results[index] = await run(cases[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(asked.concurrency, cases.length) }, () => worker()));

  // ── the tally ──
  const failed = results.filter((one) => !one.ok);
  const areas = [...new Set(results.map((one) => one.area))];
  console.log('');
  for (const area of areas) {
    const mine = results.filter((one) => one.area === area);
    console.log(`${area.padEnd(9)} ${mine.filter((one) => one.ok).length}/${mine.length}`);
  }
  const seconds = results.reduce((sum, one) => sum + one.seconds, 0);
  console.log(`${'all'.padEnd(9)} ${results.length - failed.length}/${results.length} · ${Math.round(seconds / 60)} min of answers`);
  if (failed.length > 0) {
    console.log('');
    console.log('Failed:');
    for (const one of failed) {
      console.log(`  ${one.id} — ${one.why}`);
      for (const failure of one.failures) console.log(`    · ${failure}`);
    }
  }

  // ── the record ──
  const two = (value: number) => String(value).padStart(2, '0');
  const stamp = `${startedAt.getFullYear()}${two(startedAt.getMonth() + 1)}${two(startedAt.getDate())}-${two(startedAt.getHours())}${two(startedAt.getMinutes())}`;
  const file = asked.json ?? join(process.cwd(), 'var', 'noah', `eval-${stamp}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        model,
        brain,
        revision,
        asker: asked.asker,
        only: asked.only,
        passed: results.length - failed.length,
        failed: failed.length,
        cases: results,
      },
      null,
      1,
    )}\n`,
    'utf8',
  );
  console.log('');
  console.log(`Every answer in full: ${file}`);
  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  });
