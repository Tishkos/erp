/**
 * What Noah knows about the system itself — the screens and the written guide.
 *
 * By direction (2026-10-04): "make the AI agent explain everything for all
 * users … knows the whole system … very good in the navbar, step by step where
 * to go, and explain the fields". Reading the books was already his; this is
 * the other half — telling a person which module to open, which heading, which
 * screen, which button, and what each field wants.
 *
 * Two sources, and neither is his memory:
 *
 *   * **The menu.** `MODULES` and `MENU` are what the top bar is drawn from, so
 *     a path he gives — "Payables → Supplier Balances → Supplier Statements" — is the
 *     path on the screen, in both languages, with the address, and marked when
 *     the screen is not built yet or the asker's role cannot open it.
 *   * **The guide.** `docs/guide/*.md`, written screen by screen from the code:
 *     how to do each thing, every field, what happens after saving, and what
 *     each refusal means. Searched by heading, a block at a time.
 *
 * Pure: no database, no files. `services/system-guide.ts` reads the files and
 * the message catalogues and hands them in.
 */
import { MENU } from './menu';
import { MODULES } from './modules';
import { can, type Principal } from './permissions';
import { isDelivered, routeFor } from './screens';

/** The three label groups the menu is drawn with, from one message catalogue. */
export interface MenuLabels {
  readonly module: Readonly<Record<string, string>>;
  readonly heading: Readonly<Record<string, string>>;
  readonly screen: Readonly<Record<string, string>>;
}

export interface ScreenEntry {
  readonly moduleKey: string;
  readonly sectionKey: string;
  readonly itemKey: string;
  readonly route: string;
  /** Served today; an unbuilt screen shows "Coming soon". */
  readonly built: boolean;
  /** May this person open it at all? */
  readonly allowed: boolean;
  readonly en: { readonly module: string; readonly heading: string; readonly screen: string };
  readonly ar: { readonly module: string; readonly heading: string; readonly screen: string };
}

/** Every screen of the menu, in the order the top bar and its dropdowns show them. */
export function screenCatalogue(input: { readonly principal: Principal; readonly en: MenuLabels; readonly ar: MenuLabels }): ScreenEntry[] {
  const out: ScreenEntry[] = [];
  const label = (labels: MenuLabels, moduleKey: string, sectionKey: string, itemKey: string) => ({
    module: labels.module[moduleKey] ?? moduleKey,
    heading: labels.heading[sectionKey] ?? sectionKey,
    screen: labels.screen[itemKey] ?? itemKey,
  });
  for (const module of MODULES) {
    for (const sectionKey of module.sectionKeys) {
      const section = MENU.find((candidate) => candidate.key === sectionKey);
      if (!section) continue;
      for (const item of section.items) {
        const route = routeFor(item, section.key);
        out.push({
          moduleKey: module.key,
          sectionKey,
          itemKey: item.key,
          route,
          built: isDelivered(route),
          allowed: can(input.principal, item.verb ?? 'view', item.object),
          en: label(input.en, module.key, sectionKey, item.key),
          ar: label(input.ar, module.key, sectionKey, item.key),
        });
      }
    }
  }
  return out;
}

/**
 * Text folded for matching: lower case, Arabic marks and tatweel removed, the
 * alef forms, the ta marbuta and the alef maqsura unified — so "الذمم الدائنه"
 * finds "الذمم الدائنة" and "Suppliers" finds "suppliers".
 */
export function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[^\p{L}\p{N}/]+/gu, ' ')
    .trim();
}

const STOP = new Set([
  'a', 'an', 'the', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'is', 'are', 'do', 'does', 'i', 'we', 'you', 'it', 'my', 'me',
  'how', 'what', 'where', 'which', 'why', 'can', 'could', 'should', 'please', 'want', 'need', 'with', 'from', 'by', 'at', 'as',
  'في', 'من', 'على', 'الى', 'عن', 'هل', 'كيف', 'اين', 'وين', 'شلون', 'ما', 'ماذا', 'هو', 'هي', 'او', 'و', 'اريد', 'ممكن',
]);

/** The words of a search worth matching on. */
export function searchWords(query: string): string[] {
  return [...new Set(fold(query).split(' ').filter((word) => word.length > 1 && !STOP.has(word)))];
}

/**
 * Is the word there? A long word may sit inside another ("invoice" in
 * "invoices"); a short one must be a word of its own, or "no" finds "notes"
 * and "po" finds "report".
 */
function has(folded: string, word: string): boolean {
  if (word.length >= 4) return folded.includes(word);
  return ` ${folded} `.includes(` ${word} `);
}

function haystack(entry: ScreenEntry): string {
  return fold(
    [entry.en.module, entry.en.heading, entry.en.screen, entry.ar.module, entry.ar.heading, entry.ar.screen, entry.route, entry.itemKey.replaceAll('_', ' ')].join(' '),
  );
}

/** The screens a search names: every word when any screen has them all, otherwise the best partial matches. */
export function findScreens(entries: readonly ScreenEntry[], query: string): ScreenEntry[] {
  const words = searchWords(query);
  if (words.length === 0) return [];
  const scored = entries
    .map((entry) => {
      const hay = haystack(entry);
      const own = fold(`${entry.en.screen} ${entry.ar.screen}`);
      const hits = words.filter((word) => has(hay, word)).length;
      const ownHits = words.filter((word) => has(own, word)).length;
      return { entry, hits, score: hits * 2 + ownHits * 3 + (entry.built ? 1 : 0) };
    })
    .filter((row) => row.hits > 0);
  const all = scored.filter((row) => row.hits === words.length);
  const pool = all.length > 0 ? all : scored;
  return pool.sort((a, b) => b.score - a.score).slice(0, 25).map((row) => row.entry);
}

function line(entry: ScreenEntry, baseUrl: string): string {
  const where = `${entry.en.module} → ${entry.en.heading} → ${entry.en.screen}`;
  const arabic = `${entry.ar.module} ← ${entry.ar.heading} ← ${entry.ar.screen}`;
  const notes = [entry.built ? '' : 'NOT BUILT YET (shows "Coming soon")', entry.allowed ? '' : "this person's role cannot open it"].filter(Boolean).join('; ');
  return `• ${where}  |  ${arabic}  |  ${baseUrl}${entry.route}${notes ? `  |  ${notes}` : ''}`;
}

/**
 * What the `screens` tool says.
 *
 * With a search: the matching screens, each with its full path in both
 * languages and its address. Without one: the whole top bar — every module,
 * its headings, and the built screens under each — which is what a person
 * means by "what is in the system".
 */
export function describeScreens(entries: readonly ScreenEntry[], input: { readonly baseUrl: string; readonly search?: string | null }): string {
  const search = (input.search ?? '').trim();
  if (search) {
    const found = findScreens(entries, search);
    if (found.length === 0) {
      return `No screen matches "${search}". Call screens with no search for the whole menu, or try another word (the module, the document, the report).`;
    }
    return [
      `${found.length} screen(s) for "${search}" — path as the top bar shows it (English | Arabic | address):`,
      ...found.map((entry) => line(entry, input.baseUrl)),
      'The first step is always the module in the top bar; its dropdown shows the headings; the screen is under its heading. On a narrow window the modules are icons — hovering shows the name.',
    ].join('\n');
  }
  const out: string[] = ['The top bar, left to right (right to left in Arabic) — module, then its headings, then the screens that are built:'];
  let module = '';
  let heading = '';
  for (const entry of entries) {
    if (!entry.built) continue;
    if (entry.moduleKey !== module) {
      module = entry.moduleKey;
      heading = '';
      out.push(`${entry.en.module} (${entry.ar.module})`);
    }
    if (entry.sectionKey !== heading) {
      heading = entry.sectionKey;
      out.push(`  ${entry.en.heading} (${entry.ar.heading}):`);
    }
    out.push(`    - ${entry.en.screen} (${entry.ar.screen})${entry.allowed ? '' : ' — not open to this person'}`);
  }
  const unbuilt = entries.filter((entry) => !entry.built).length;
  out.push(`${unbuilt} more screens are named in the menu plan and not built yet; search for one by name to see it.`);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// The written guide
// ---------------------------------------------------------------------------

export interface GuideChunk {
  readonly file: string;
  /** The block's own heading, without the #s. */
  readonly title: string;
  /** The `##` block it sits under, for a `###` block. */
  readonly parent: string | null;
  /** The parent's Path / Address / Needs lines, so a sub-block still says where the screen is. */
  readonly context: string;
  readonly body: string;
}

/** One guide file as blocks: every `##` and every `###` is its own block. */
export function chunkGuide(file: string, markdown: string): GuideChunk[] {
  const chunks: GuideChunk[] = [];
  let parent: string | null = null;
  let context = '';
  let title: string | null = null;
  let level = 0;
  let body: string[] = [];
  let inFence = false;

  const flush = () => {
    if (title === null) return;
    const text = body.join('\n').trim();
    if (level === 2) {
      context = body
        .filter((row) => /^(Path|Address|Needs):/i.test(row.trim()))
        .join('\n');
    }
    if (text) chunks.push({ file, title, parent: level === 3 ? parent : null, context: level === 3 ? context : '', body: text });
  };

  for (const row of markdown.split(/\r?\n/)) {
    if (row.trim().startsWith('```')) inFence = !inFence;
    const heading = inFence ? null : /^(#{2,3})\s+(.*)$/.exec(row);
    if (heading) {
      flush();
      level = heading[1]!.length;
      title = heading[2]!.trim();
      if (level === 2) parent = title;
      body = [];
      continue;
    }
    if (title !== null) body.push(row);
  }
  flush();
  return chunks;
}

function render(chunk: GuideChunk, cap: number): string {
  const head = chunk.parent ? `### ${chunk.title}\n(under: ${chunk.parent})${chunk.context ? `\n${chunk.context}` : ''}` : `## ${chunk.title}`;
  const body = chunk.body.length > cap ? `${chunk.body.slice(0, cap)}\n… (cut — ask the guide for this block's own title to read the rest)` : chunk.body;
  return `${head}\n${body}`;
}

/** Every block's title, grouped by file — what the guide covers. */
export function guideContents(chunks: readonly GuideChunk[]): string {
  if (chunks.length === 0) return 'The written guide is not installed on this server.';
  const out: string[] = ['The guide covers these screens (search by any of these words to read the steps, the fields and the refusals):'];
  let file = '';
  for (const chunk of chunks) {
    if (chunk.parent !== null) continue;
    if (chunk.file !== file) {
      file = chunk.file;
      out.push(`${file}:`);
    }
    out.push(`  - ${chunk.title}`);
  }
  return out.join('\n');
}

/**
 * The blocks that answer a question, best first, within a size the model can
 * read in one go. A heading match outweighs a mention in the text, because the
 * guide is written one screen and one task per heading.
 */
export function searchGuide(chunks: readonly GuideChunk[], query: string, budget = 10_500): string {
  if (chunks.length === 0) return 'The written guide is not installed on this server. Explain from what you know and from the screens tool.';
  const words = searchWords(query);
  if (words.length === 0) return guideContents(chunks);

  const scored = chunks
    .map((chunk) => {
      const title = fold(chunk.title);
      const parent = fold(chunk.parent ?? '');
      const body = fold(chunk.body);
      let score = 0;
      let matched = 0;
      for (const word of words) {
        const inTitle = has(title, word);
        const inParent = has(parent, word);
        const inBody = has(body, word);
        if (inTitle || inParent || inBody) matched += 1;
        if (inTitle) score += 6;
        if (inParent) score += 3;
        if (inBody) score += Math.min(3, body.split(word).length - 1);
      }
      // All the words together is the screen being asked about; one word is a mention.
      if (matched === words.length) score += 8;
      return { chunk, score, matched };
    })
    .filter((row) => row.matched > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return [`Nothing in the guide matches "${query}". Try the screen's name or the document's name in English.`, guideContents(chunks).slice(0, 4_000)].join('\n\n');
  }

  const out: string[] = [];
  let used = 0;
  for (const { chunk } of scored.slice(0, 8)) {
    const text = render(chunk, 4_500);
    if (used > 0 && used + text.length > budget) continue;
    out.push(text);
    used += text.length;
    if (used >= budget) break;
  }
  const more = scored.slice(out.length, out.length + 10).map((row) => row.chunk.title);
  if (more.length > 0) out.push(`Other blocks that may help (search their titles): ${more.join(' · ')}`);
  return out.join('\n\n---\n\n');
}

// ---------------------------------------------------------------------------
// Issues people report
// ---------------------------------------------------------------------------

export const ISSUE_KINDS = ['bug', 'error_message', 'confusing', 'missing_feature', 'wrong_data', 'slow', 'request', 'other'] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];
export const ISSUE_SEVERITIES = ['blocks_work', 'slows_work', 'minor'] as const;
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number];

export interface IssueInput {
  readonly summary: string;
  readonly kind: IssueKind;
  readonly severity: IssueSeverity;
  /** The screen, as its menu path or address. */
  readonly screen?: string | null;
  readonly doing?: string | null;
  readonly happened?: string | null;
  /** The message the system showed, word for word. */
  readonly message?: string | null;
  /** The document it concerns, if any. */
  readonly document?: string | null;
  /** What Noah worked out: the likely cause, a workaround he gave. */
  readonly note?: string | null;
}

const one = (text: string | null | undefined, cap = 2_000) => (text ?? '').replace(/\r/g, '').trim().slice(0, cap);

/** The heading of a new, empty issues file. */
export const ISSUES_HEADER = [
  '# Issues reported to Noah',
  '',
  'Problems people told the assistant about while using the ERP — written by the assistant at the moment they were reported, newest at the bottom.',
  'Change a line\'s `Status: open` to `Status: fixed` (or `Status: not a defect`) when it is dealt with.',
  '',
].join('\n');

/** One issue as a Markdown block. */
export function issueBlock(input: {
  readonly id: string;
  readonly when: string;
  readonly who: string;
  readonly chat: string;
  readonly issue: IssueInput;
}): string {
  const { issue } = input;
  const rows = [
    `## ${input.id} — ${one(issue.summary, 160).replace(/\n+/g, ' ')}`,
    `- When: ${input.when}`,
    `- Who: ${input.who}`,
    `- Where reported: ${input.chat}`,
    `- Screen: ${one(issue.screen, 200) || '—'}`,
    `- Document: ${one(issue.document, 80) || '—'}`,
    `- Kind: ${issue.kind.replaceAll('_', ' ')}`,
    `- Severity: ${issue.severity.replaceAll('_', ' ')}`,
    '- Status: open',
    '',
  ];
  const section = (title: string, text: string | null | undefined, quote = false) => {
    const said = one(text);
    if (!said) return;
    rows.push(`**${title}**`, quote ? said.split('\n').map((row) => `> ${row}`).join('\n') : said, '');
  };
  section('What they were doing', issue.doing);
  section('What happened', issue.happened);
  section('The message on the screen', issue.message, true);
  section("Noah's note", issue.note);
  return rows.join('\n');
}

/** The next id for a day: ISS-YYYYMMDD-NNN, counting the ones already in the file. */
export function nextIssueId(existing: string, day: string): string {
  const stamp = day.replaceAll('-', '');
  const taken = existing.split(`## ISS-${stamp}-`).length - 1;
  return `ISS-${stamp}-${String(taken + 1).padStart(3, '0')}`;
}

/** The last few issues of the file, newest first, for reading back. */
export function recentIssues(existing: string, limit = 10, onlyOpen = false): string {
  const blocks = existing
    .split(/\n(?=## ISS-)/)
    .filter((block) => block.startsWith('## ISS-'))
    .filter((block) => !onlyOpen || /- Status: open/.test(block));
  if (blocks.length === 0) return onlyOpen ? 'No open issue is on the list.' : 'No issue has been reported yet.';
  const shown = blocks.slice(-limit).reverse();
  return [`${blocks.length} issue(s) on the list${onlyOpen ? ' still open' : ''}; the latest ${shown.length}:`, ...shown.map((block) => block.trim().slice(0, 1_500))].join('\n\n');
}
