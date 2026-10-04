/**
 * Ask Noah from a terminal — the agent the WhatsApp group talks to, as a named
 * user, without a phone.
 *
 *   npx tsx scripts/ops/ask-noah.ts <email> "<question>" [--picture <file>]
 *
 * `--picture` shows him a picture with the question, as a photo or screenshot
 * sent to the group with !ai in its caption would be.
 *
 * For trying an answer before a phone is paired, and for seeing what a
 * particular person would be told: the question is answered exactly as the
 * bridge answers it — as that user, in a transaction the database holds
 * read-only, with the same tools, guide and instructions — and printed with
 * the tools it used.
 *
 * It reads; it changes nothing in the books. A proposal has nobody here to
 * say yes to it, so Noah is told he cannot act and explains the screen
 * instead. The one thing it can write is the issues list
 * (`var/issues/reported-issues.md`), if the question reports a problem.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import type { AskedPicture } from '../../src/server/domain/whatsapp-agent';
import { db, withScope } from '../../src/server/db/client';
import { readerFor, readerModel } from '../../src/server/services/reader';
import * as wa from '../../src/server/services/whatsapp';
import { runAgentFor } from '../../src/server/services/whatsapp-agent';

const email = (process.argv[2] ?? '').trim().toLowerCase();
const rest = process.argv.slice(3);
const pictureAt = rest.indexOf('--picture');
const pictureFile = pictureAt >= 0 ? (rest[pictureAt + 1] ?? '') : '';
const question = rest
  .filter((_, index) => pictureAt < 0 || (index !== pictureAt && index !== pictureAt + 1))
  .join(' ')
  .trim();

/** The picture as the bridge would hand it over: its type from its name, its bytes as base64. */
function pictures(): AskedPicture[] {
  if (!pictureFile) return [];
  const type = /\.png$/i.test(pictureFile) ? 'image/png' : /\.webp$/i.test(pictureFile) ? 'image/webp' : /\.gif$/i.test(pictureFile) ? 'image/gif' : 'image/jpeg';
  return [{ mediaType: type, base64: readFileSync(pictureFile).toString('base64') }];
}

async function main(): Promise<void> {
  if (!email.includes('@') || !question) {
    console.error('usage: npx tsx scripts/ops/ask-noah.ts <email> "<question>" [--picture <file>]');
    process.exit(1);
  }
  const found = await db.execute(sql`select id from app_user where lower(email) = ${email} and is_active limit 1`);
  const user = found.rows[0] as { id: string } | undefined;
  if (!user) throw new Error(`no active user ${email}`);

  const client = await readerFor();
  if (!client) throw new Error('no brain is usable here: the claude CLI is not signed in and there is no ANTHROPIC_API_KEY');

  const settings = await withScope({ userId: user.id, branchCode: '', isSuperUser: true }, (tx) => wa.settings(tx));
  const started = Date.now();
  const reply = await wa.answer({
    userId: user.id,
    text: question,
    settings,
    agent: (ctx, asked, userName) =>
      runAgentFor({ client, model: readerModel(settings.agentModel), ctx, question: asked, userName, chat: 'terminal', pictures: pictures() }),
  });

  if (reply.images.length === 0) console.log(reply.text);
  else {
    // As the group would get it: each part a message, a picture's words under it.
    for (const [index, part] of reply.parts.entries()) {
      console.log(part.image ? `┌─ message ${index + 1}: PICTURE ${part.image.fileName} (${Math.round(part.image.body.length / 1024)} KB), with the caption:` : `┌─ message ${index + 1}:`);
      console.log(part.text);
      console.log('');
    }
  }
  console.log('');
  const tools = (reply.detail.tools as readonly string[] | undefined) ?? [];
  console.log(`— ${reply.locale}, ${Math.round((Date.now() - started) / 1000)}s, tools: ${tools.length > 0 ? tools.join(' → ') : 'none'}`);
  const trace = (reply.detail.trace as ReadonlyArray<{ tool: string; args: string; ms: number; ok: boolean; said?: string }> | undefined) ?? [];
  for (const step of trace) console.log(`   ${step.ok ? '✓' : '✗'} ${step.tool} ${step.args} · ${step.ms}ms${step.ok ? '' : ` · ${(step.said ?? '').replace(/\s+/g, ' ').slice(0, 200)}`}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
