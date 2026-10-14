/**
 * Ask Noah from a terminal — the agent the WhatsApp group talks to, as a named
 * user, without a phone.
 *
 *   npx tsx scripts/ops/ask-noah.ts <email> "<question>" [--picture <file>] [--propose]
 *
 * `--picture` shows him a picture with the question, as a photo or screenshot
 * sent to the group with !ai in its caption would be. A `.pdf` is shown as the
 * bridge shows a scanned PDF: its pages as pictures (needs poppler's
 * `pdfinfo` / `pdftoppm`, which the server has).
 *
 * `--propose` lets him propose and preview as he does for a contact whose
 * Actions switch is on: the proposal is PRINTED and never run (nobody here
 * can say yes to it), and a preview undoes itself.
 *
 * For trying an answer before a phone is paired, and for seeing what a
 * particular person would be told: the question is answered exactly as the
 * bridge answers it — as that user, in a transaction the database holds
 * read-only, with the same tools, guide and instructions — and printed with
 * the tools it used.
 *
 * It reads; it changes nothing in the books. A proposal has nobody here to
 * say yes to it, so without `--propose` Noah is told he cannot act and
 * explains the screen instead. What it can write is what he writes down
 * himself: the issues list (`var/issues/reported-issues.md`) and his notes
 * (`var/noah/` — a request, a remembered fact, a walkthrough).
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { MAX_ASKED_PAGES, type AskedPicture } from '../../src/server/domain/whatsapp-agent';
import { scanQuestion } from '../../src/server/domain/whatsapp-files';
import { pdfPagePictures } from '../../src/server/services/whatsapp-files';
import type { PendingAction } from '../../src/server/domain/whatsapp-do';
import { db, withScope } from '../../src/server/db/client';
import { readerFor, readerModel } from '../../src/server/services/reader';
import * as wa from '../../src/server/services/whatsapp';
import { runAgentFor } from '../../src/server/services/whatsapp-agent';

const email = (process.argv[2] ?? '').trim().toLowerCase();
const mayPropose = process.argv.includes('--propose');
const rest = process.argv.slice(3).filter((word) => word !== '--propose');
const proposals: PendingAction[] = [];
const pictureAt = rest.indexOf('--picture');
const pictureFile = pictureAt >= 0 ? (rest[pictureAt + 1] ?? '') : '';
const question = rest
  .filter((_, index) => pictureAt < 0 || (index !== pictureAt && index !== pictureAt + 1))
  .join(' ')
  .trim();

/** A PDF's pages as the bridge hands over a scan's, with the question framed as it frames one. */
async function pdfPages(): Promise<{ readonly pictures: AskedPicture[]; readonly question: string }> {
  const drawn = await pdfPagePictures(readFileSync(pictureFile), MAX_ASKED_PAGES);
  if (drawn.pages.length === 0) throw new Error(`${pictureFile}: ${drawn.note ?? 'no pages could be drawn'}`);
  console.error(`(${pictureFile}: ${drawn.pages.length} of ${drawn.total} page(s) drawn)`);
  return {
    pictures: drawn.pages.map((page) => ({ mediaType: 'image/jpeg' as const, base64: page.base64, page: page.page })),
    question: scanQuestion({ caption: question, fileName: pictureFile.replace(/^.*[\\/]/, ''), shown: drawn.pages.length, total: drawn.total, replied: false }),
  };
}

/** The picture as the bridge would hand it over: its type from its name, its bytes as base64. */
function pictures(): AskedPicture[] {
  if (!pictureFile) return [];
  const type = /\.png$/i.test(pictureFile) ? 'image/png' : /\.webp$/i.test(pictureFile) ? 'image/webp' : /\.gif$/i.test(pictureFile) ? 'image/gif' : 'image/jpeg';
  return [{ mediaType: type, base64: readFileSync(pictureFile).toString('base64') }];
}

async function main(): Promise<void> {
  if (!email.includes('@') || !question) {
    console.error('usage: npx tsx scripts/ops/ask-noah.ts <email> "<question>" [--picture <file>] [--propose]');
    process.exit(1);
  }
  const found = await db.execute(sql`select id from app_user where lower(email) = ${email} and is_active limit 1`);
  const user = found.rows[0] as { id: string } | undefined;
  if (!user) throw new Error(`no active user ${email}`);

  const client = await readerFor();
  if (!client) throw new Error('no brain is usable here: the claude CLI is not signed in and there is no ANTHROPIC_API_KEY');

  const settings = await withScope({ userId: user.id, branchCode: '', isSuperUser: true }, (tx) => wa.settings(tx));
  const sent = /\.pdf$/i.test(pictureFile) ? await pdfPages() : { pictures: pictures(), question };
  const started = Date.now();
  const reply = await wa.answer({
    userId: user.id,
    text: sent.question,
    settings,
    agent: (ctx, asked, userName) =>
      runAgentFor({
        client,
        model: readerModel(settings.agentModel),
        ctx,
        question: asked,
        userName,
        chat: 'terminal',
        pictures: sent.pictures,
        ...(mayPropose ? { actions: { chat: 'terminal', propose: (pending: PendingAction) => proposals.push(pending) } } : {}),
      }),
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
  for (const pending of proposals) console.log(`   PROPOSED, not run (${pending.action}): ${pending.sentence.replace(/\s+/g, ' ').slice(0, 400)}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
