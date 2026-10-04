/**
 * Take one live picture by hand — what Noah's `screenshot` tool takes, as a
 * named user, without a phone.
 *
 *   npx tsx scripts/ops/live-shot.ts <email> <path> [--point "Label"]… [--ar] [--full]
 *
 *   npx tsx scripts/ops/live-shot.ts tishko@qs-groups.com sales/ar-invoices/INV-HQ-2026-000001 --point "Post"
 *
 * It prints where the picture is, the page's heading, and what each number in
 * the picture is on (with what the field holds) — or the refusal, in the
 * sentence the person would be told.
 *
 * The path may be given without its leading "/": Git Bash on Windows turns an
 * argument that starts with "/" into a Windows path. `--raw` hands the path on
 * exactly as typed (to see an address refused).
 *
 * It looks; it changes nothing in the books: the browser it drives is refused
 * every request that is not a GET (`services/live-screenshot.ts`). What it
 * leaves behind is one audit row saying a picture was taken as that person,
 * and their short session, already ended. Locally, point it at the
 * development server: NOAH_APP_URL=http://localhost:3000.
 */
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { db, pool } from '../../src/server/db/client';
import { closeLiveBrowser, liveScreenshot, liveShotsReady } from '../../src/server/services/live-screenshot';

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith('--') && arg !== '--point'));
const points: string[] = [];
const plain: string[] = [];
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]!;
  if (arg === '--point') {
    const label = args[index + 1];
    if (label) points.push(label);
    index += 1;
  } else if (!arg.startsWith('--')) plain.push(arg);
}

async function main(): Promise<number> {
  const email = (plain[0] ?? '').trim().toLowerCase();
  const given = (plain[1] ?? '').trim();
  if (!email.includes('@') || !given) {
    console.error('usage: npx tsx scripts/ops/live-shot.ts <email> <path> [--point "Label"]… [--ar] [--full] [--raw]');
    return 1;
  }
  const ready = liveShotsReady();
  if (!ready.ok) {
    console.error(ready.reason);
    return 1;
  }
  const found = await db.execute(sql`select id from app_user where lower(email) = ${email} and is_active limit 1`);
  const user = found.rows[0] as { id: string } | undefined;
  if (!user) {
    console.error(`no active user ${email}`);
    return 1;
  }

  const path = flags.has('--raw') || given.startsWith('/') ? given : `/${given}`;
  const started = Date.now();
  const result = await liveScreenshot({
    userId: user.id,
    path,
    locale: flags.has('--ar') ? 'ar' : 'en',
    ...(points.length > 0 ? { pointAt: points } : {}),
    ...(flags.has('--full') ? { fullPage: true } : {}),
  });
  const seconds = Math.round((Date.now() - started) / 100) / 10;

  if (!result.ok) {
    console.log(`REFUSED after ${seconds}s: ${result.reason}`);
    return 2;
  }
  const { shot } = result;
  console.log(`picture: ${shot.file}`);
  console.log(`page:    ${shot.path} — ${shot.title} (${seconds}s)`);
  for (const mark of shot.marks) {
    const facts = [
      mark.kind,
      mark.required ? 'required' : '',
      mark.value ? `holds: ${mark.value}` : '',
      mark.options ? `choices: ${mark.options.join(' / ')}` : '',
      mark.hint ? `hint: ${mark.hint}` : '',
    ].filter(Boolean);
    console.log(`  ${mark.pointed ? '➜' : ' '} ${String(mark.n).padStart(2)} = ${mark.label} (${facts.join('; ')})`);
  }
  if (shot.notFound.length > 0) console.log(`not in the picture: ${shot.notFound.join(', ')}`);
  return 0;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  })
  .then(async (code) => {
    await closeLiveBrowser();
    await pool.end().catch(() => {});
    process.exit(code);
  });
