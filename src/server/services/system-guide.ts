/**
 * Noah's knowledge of the system, bound to the files it lives in.
 *
 * `domain/system-guide.ts` is the reasoning — which screens match, which guide
 * blocks answer — and knows nothing about disk. This reads the two message
 * catalogues the menu is labelled from, the guide under `docs/`, and keeps the
 * list of issues people report (`var/issues/reported-issues.md`).
 *
 * The issues file is a file on purpose (by direction, 2026-10-04: "if they have
 * issues, save the issues in an md file"): it is written from inside a
 * question's read-only transaction, where the database refuses every write,
 * and it is read by the people fixing the system rather than by the system.
 * `var/` outlives a deploy, so the list does too.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import en from '../../../messages/en.json';
import ar from '../../../messages/ar.json';
import { businessToday } from '../domain/business-date';
import type { Principal } from '../domain/permissions';
import {
  ISSUES_HEADER,
  chunkGuide,
  describeScreens,
  issueBlock,
  nextIssueId,
  recentIssues,
  screenCatalogue,
  searchGuide,
  type GuideChunk,
  type IssueInput,
  type MenuLabels,
} from '../domain/system-guide';

type Catalogue = { shell?: { module?: Record<string, string> }; nav?: Record<string, string>; page?: Record<string, string> };

const labels = (catalogue: Catalogue): MenuLabels => ({
  module: catalogue.shell?.module ?? {},
  heading: catalogue.nav ?? {},
  screen: catalogue.page ?? {},
});

const EN = labels(en as unknown as Catalogue);
const AR = labels(ar as unknown as Catalogue);

/** Where the application is reached, for the address beside each screen. */
export function appUrl(): string {
  return (process.env.BETTER_AUTH_URL?.trim() || 'https://erp.qs-groups.com').replace(/\/+$/, '');
}

/** The `screens` tool: where a thing is in the top bar, for this person. */
export function screens(principal: Principal, search?: string | null): string {
  return describeScreens(screenCatalogue({ principal, en: EN, ar: AR }), { baseUrl: appUrl(), search: search ?? null });
}

// ---------------------------------------------------------------------------
// The guide
// ---------------------------------------------------------------------------

/** The folder the guide is read from: `docs/` beside the application. */
function docsDir(): string {
  return process.env.ERP_GUIDE_DIR?.trim() || join(process.cwd(), 'docs');
}

/** The guide's files, the screen-by-screen ones first. */
function guideFiles(root: string): string[] {
  const files: string[] = [];
  const guide = join(root, 'guide');
  if (existsSync(guide)) {
    for (const name of readdirSync(guide).sort()) if (name.endsWith('.md')) files.push(join(guide, name));
  }
  const training = join(root, 'training');
  if (existsSync(training)) {
    for (const name of readdirSync(training).sort()) if (name.endsWith('.md')) files.push(join(training, name));
  }
  for (const name of ['BUSINESS.md']) if (existsSync(join(root, name))) files.push(join(root, name));
  return files;
}

let cached: { readonly stamp: string; readonly chunks: readonly GuideChunk[] } | null = null;

/** The guide as blocks, re-read when a file changes (a deploy replaces them). */
export function guideChunks(): readonly GuideChunk[] {
  const root = docsDir();
  const files = guideFiles(root);
  const stamp = files.map((file) => `${file}:${statSync(file).mtimeMs}`).join('|');
  if (cached && cached.stamp === stamp) return cached.chunks;
  const chunks = files.flatMap((file) => chunkGuide(file.slice(root.length + 1).replaceAll('\\', '/'), readFileSync(file, 'utf8')));
  cached = { stamp, chunks };
  return chunks;
}

/** The `guide` tool: the written steps, fields and refusals for a topic. */
export function guide(search?: string | null): string {
  return searchGuide(guideChunks(), (search ?? '').trim());
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

export function issuesFile(): string {
  return process.env.ERP_ISSUES_FILE?.trim() || join(process.cwd(), 'var', 'issues', 'reported-issues.md');
}

function readIssues(): string {
  const file = issuesFile();
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

/**
 * Writes one issue to the list and says what it was filed as.
 *
 * Appended, never rewritten: two people reporting at once each get their own
 * block, and nothing already on the list can be lost to a write.
 */
export function reportIssue(input: {
  readonly who: string;
  readonly chat: string;
  readonly issue: IssueInput;
  readonly now?: Date;
}): { readonly id: string; readonly file: string } {
  const file = issuesFile();
  const now = input.now ?? new Date();
  mkdirSync(dirname(file), { recursive: true });
  if (!existsSync(file)) writeFileSync(file, `${ISSUES_HEADER}\n`, 'utf8');
  const day = businessToday(now);
  const id = nextIssueId(readIssues(), day);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: process.env.ERP_TIMEZONE ?? 'Asia/Baghdad',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
  appendFileSync(file, `\n${issueBlock({ id, when: `${day} ${time} (Baghdad)`, who: input.who, chat: input.chat, issue: input.issue })}\n`, 'utf8');
  return { id, file };
}

/** The latest issues, newest first. */
export function issuesReported(limit = 10, onlyOpen = false): string {
  return recentIssues(readIssues(), Math.max(1, Math.min(30, limit)), onlyOpen);
}
