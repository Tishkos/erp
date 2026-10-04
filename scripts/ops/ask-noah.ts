/**
 * Ask Noah from a terminal — the agent the WhatsApp group talks to, as a named
 * user, without a phone.
 *
 *   npx tsx scripts/ops/ask-noah.ts <email> "<question>"
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
import { sql } from 'drizzle-orm';
import { db, withScope } from '../../src/server/db/client';
import { readerFor, readerModel } from '../../src/server/services/reader';
import * as wa from '../../src/server/services/whatsapp';
import { runAgentFor } from '../../src/server/services/whatsapp-agent';

const email = (process.argv[2] ?? '').trim().toLowerCase();
const question = process.argv.slice(3).join(' ').trim();

async function main(): Promise<void> {
  if (!email.includes('@') || !question) {
    console.error('usage: npx tsx scripts/ops/ask-noah.ts <email> "<question>"');
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
      runAgentFor({ client, model: readerModel(settings.agentModel), ctx, question: asked, userName, chat: 'terminal' }),
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
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
