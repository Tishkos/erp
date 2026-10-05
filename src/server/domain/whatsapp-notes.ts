/**
 * What Noah writes down and reads back — by direction, 2026-10-05.
 *
 * Four things the owner asked for on one day, and they are one kind of thing:
 *
 *   requests     "we need another field in bank loans … or we are doing an
 *                import application wrongly — it should understand, ask
 *                questions, and SAVE IN A FOLDER ONE BY ONE, and we try to
 *                implement them." One file per request, with what is still
 *                unanswered as a checklist, and an index of them all.
 *   feedback     "reply 👎 to a wrong answer: it's logged, becomes a permanent
 *                test question." One file per verdict, and for a wrong answer
 *                one line in a list the developer turns into test cases.
 *   memory       "he remembers each person's language, role and what they were
 *                working on, plus company facts you teach him." A line per
 *                fact; never a password or a code.
 *   walkthrough  "he gives step 1 and waits; the person writes done" — hours
 *                later he must still know which walkthrough and which step.
 *
 * This file is the reasoning and knows nothing about disk: ids, the text of
 * each file, reading a file back, and the words that go into his
 * instructions. `services/whatsapp-notes.ts` is the paths and the writes.
 *
 * Files, not tables, for the reason the issues list is a file: all of this is
 * written from inside a question's read-only transaction, where the database
 * refuses every write, and it is read by the people improving the system
 * rather than by the system.
 */
import { BUSINESS_TIME_ZONE, businessDateOf } from './business-date';

const NL = '\n';

// ---------------------------------------------------------------------------
// Small things everything here uses
// ---------------------------------------------------------------------------

/** Text as it was said, without carriage returns or surrounding space, and no longer than `cap`. */
export function cut(text: string | null | undefined, cap = TEXT_CAP): string {
  return (text ?? '').replace(/\r/g, '').trim().slice(0, cap);
}

/** One line: every run of white space is a single space. */
export function oneLine(text: string | null | undefined, cap = 300): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, cap);
}

/** A long field is cut, never refused: somebody who pasted a page still gets their request filed. */
export const TEXT_CAP = 4_000;

/** `2026-10-05 14:02 (Baghdad)` — the day and the minute where the books are kept. */
export function stampOf(now: Date): string {
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: BUSINESS_TIME_ZONE, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  return `${businessDateOf(now)} ${time} (Baghdad)`;
}

/** A user id, and nothing that could be a path: these become file names. */
export function isUserId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** "Tishko <tishko@qs-groups.com> · branch HQ" → "Tishko": the name, for a list. */
export function shortWho(who: string): string {
  return oneLine(who.split(' <')[0]!.split(' · ')[0], 60) || 'somebody';
}

/**
 * The next id of a day — `REQ-20261005-003` — from the names already in the
 * folder. One more than the highest, not a count: a file removed by hand must
 * not hand its number to the next request.
 */
export function nextId(prefix: string, day: string, taken: readonly string[]): string {
  const start = `${prefix}-${day.replaceAll('-', '')}-`;
  let highest = 0;
  for (const name of taken) {
    if (!name.startsWith(start)) continue;
    const n = Number(/^(\d{3})/.exec(name.slice(start.length))?.[1] ?? '0');
    if (n > highest) highest = n;
  }
  if (highest >= 999) throw new Error(`There are already 999 of ${prefix} for ${day}.`);
  return `${start}${String(highest + 1).padStart(3, '0')}`;
}

/** Body text that cannot be mistaken for the file's own headings. */
function body(text: string | null | undefined): string {
  return cut(text)
    .split(NL)
    .map((line) => (/^#{1,6}(\s|$)/.test(line) ? `\\${line}` : line))
    .join(NL);
}

/** A status or a kind as it is typed by hand or by a model: "needs answers", "Needs_Answers", "in-progress". */
const keyOf = (text: string) => text.trim().toLowerCase().replace(/[\s-]+/g, '_');
const words = (key: string) => key.replaceAll('_', ' ');

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const REQUEST_KINDS = ['new_field', 'new_feature', 'workflow_change', 'wrong_behaviour', 'report', 'other'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];
export const REQUEST_STATUSES = ['needs_answers', 'open', 'ready', 'in_progress', 'done', 'declined'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];
export const REQUEST_ID = /^REQ-\d{8}-\d{3}$/;

export interface RequestInput {
  /** One line: what is wanted. */
  readonly title: string;
  readonly kind: RequestKind;
  /** The module or screen family: "Bank Loans", "ASYCUDA", "Import application", "HR payroll". */
  readonly area: string;
  /** The menu path or the address, when known. */
  readonly screen?: string | null;
  /** How the system does it now. */
  readonly today?: string | null;
  /** What they want instead. */
  readonly wanted: string;
  /** The reason in their own terms: the business need. */
  readonly why: string;
  /** For a workflow: the steps as the company really does them. */
  readonly rightWay?: string | null;
  /** A real case: a document number, a figure. */
  readonly example?: string | null;
  /** Who is affected, how often, what it costs today. */
  readonly impact?: string | null;
  /** What Noah still needs answered. */
  readonly openQuestions?: readonly string[];
  /** His own reading: what would have to change, what it may collide with. */
  readonly noahNote?: string | null;
}

/** No more open questions than somebody will ever answer. */
const QUESTION_CAP = 12;

/**
 * Why a request is not worth filing yet — or null when it is.
 *
 * A title, what is wanted and why: without those three a file is a complaint
 * nobody can act on, and the right thing is to ask, not to write it down.
 */
export function checkRequest(request: RequestInput): string | null {
  const missing = (
    [
      ['a title (one line: what is wanted)', request.title],
      ['what is wanted', request.wanted],
      ['why they want it', request.why],
    ] as const
  )
    .filter(([, text]) => oneLine(text).length < 3)
    .map(([name]) => name);
  if (missing.length === 0) return null;
  return `Not filed — it has no ${missing.join(', and no ')}. Ask them what they want and why first, then file it.`;
}

const questionsOf = (request: RequestInput) =>
  (request.openQuestions ?? [])
    .map((question) => oneLine(question, 300))
    .filter((question) => question.length > 0)
    .slice(0, QUESTION_CAP);

/**
 * One request as its own file: a ticket a developer can work from, and a page
 * the owner can read.
 *
 * It starts `needs answers` while Noah still has questions and `open` once it
 * has none. Sections with nothing in them are left out.
 */
export function requestFile(input: { readonly id: string; readonly when: string; readonly who: string; readonly chat: string; readonly request: RequestInput }): string {
  const { request } = input;
  const questions = questionsOf(request);
  const kind = (REQUEST_KINDS as readonly string[]).includes(keyOf(String(request.kind ?? ''))) ? keyOf(String(request.kind)) : 'other';
  const rows = [
    `# ${input.id} — ${oneLine(request.title, 160).replace(/^#+\s*/, '')}`,
    `- Status: ${words(questions.length > 0 ? 'needs_answers' : 'open')}`,
    `- Kind: ${words(kind)}`,
    `- Area: ${oneLine(request.area, 120) || '—'}`,
    `- Screen: ${oneLine(request.screen, 200) || '—'}`,
    `- Asked by: ${oneLine(input.who, 200)} · ${oneLine(input.chat, 80)} · ${input.when}`,
    '',
  ];
  const section = (title: string, text: string | null | undefined) => {
    const said = body(text);
    if (said) rows.push(`## ${title}`, said, '');
  };
  section('How it works today', request.today);
  section('What is wanted', request.wanted);
  section('Why', request.why);
  section('The right way (their words)', request.rightWay);
  section('A real example', request.example);
  section('Who it affects', request.impact);
  if (questions.length > 0) rows.push(`## ${STILL}`, ...questions.map((question) => `- [ ] ${question}`), '');
  section("Noah's reading", request.noahNote);
  return rows.join(NL);
}

const STILL = 'Still to answer';
const FOLLOW_UP = 'Follow-up';

/** What a list needs to know about one request. */
export interface RequestHead {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly kind: string;
  readonly area: string;
  readonly who: string;
  readonly date: string;
  /** How many of Noah's questions nobody has answered yet. */
  readonly open: number;
}

/** The lines of the checklist: where each is, and whether it is still open. */
function checklist(lines: readonly string[]): { readonly at: number; readonly question: string; readonly open: boolean }[] {
  const start = lines.findIndex((line) => line.trim() === `## ${STILL}`);
  if (start < 0) return [];
  const out: { at: number; question: string; open: boolean }[] = [];
  for (let at = start + 1; at < lines.length; at += 1) {
    const line = lines[at]!;
    if (/^##\s/.test(line)) break;
    const item = /^- \[( |x|X)\] (.*)$/.exec(line);
    if (item) out.push({ at, question: item[2]!.trim(), open: item[1] === ' ' });
  }
  return out;
}

/** The header of a request file read back; null for anything that is not one. */
export function parseRequest(text: string): RequestHead | null {
  const lines = text.replace(/\r/g, '').split(NL);
  const first = /^# (REQ-\d{8}-\d{3}) — (.*)$/.exec(lines[0] ?? '');
  if (!first) return null;
  // Only the header: a follow-up may speak of a status too, and that is history.
  const end = lines.findIndex((line) => /^##\s/.test(line));
  const header = end < 0 ? lines : lines.slice(0, end);
  const field = (name: string) => header.find((line) => line.startsWith(`- ${name}: `))?.slice(name.length + 4).trim() ?? '';
  const asked = field('Asked by');
  return {
    id: first[1]!,
    title: first[2]!.trim(),
    status: keyOf(field('Status')) || 'open',
    kind: keyOf(field('Kind')) || 'other',
    area: field('Area') || '—',
    who: shortWho(asked),
    date: /(\d{4}-\d{2}-\d{2}) \d{2}:\d{2} \(Baghdad\)\s*$/.exec(asked)?.[1] ?? `${first[1]!.slice(4, 8)}-${first[1]!.slice(8, 10)}-${first[1]!.slice(10, 12)}`,
    open: checklist(lines).filter((item) => item.open).length,
  };
}

const loose = (text: string) =>
  text
    .toLowerCase()
    .replace(/[?؟.!:،,;"'«»()[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export type FollowedUp =
  | { readonly ok: true; readonly text: string; readonly status: RequestStatus; readonly ticked: number }
  | { readonly ok: false; readonly reason: string };

/**
 * A request with what was learned since added to it.
 *
 * Nothing that was said before is rewritten: the new entry goes at the end,
 * under Follow-up, with its date and who said it. Two things earlier in the
 * file do move, and only these — a question that has been answered is ticked
 * on the checklist, and the Status line says where the request stands now.
 * When the last open question is answered a request that was waiting for
 * answers becomes `open`, unless the caller says otherwise.
 */
export function followUp(input: {
  readonly text: string;
  readonly when: string;
  readonly who: string;
  readonly note?: string | null;
  readonly answers?: ReadonlyArray<{ readonly question: string; readonly answer: string }>;
  readonly status?: string | null;
}): FollowedUp {
  const lines = input.text.replace(/\r/g, '').split(NL);
  const head = parseRequest(input.text);
  if (!head) return { ok: false, reason: 'That file is not a request.' };

  const note = body(input.note);
  const answers = (input.answers ?? []).map((one) => ({ question: oneLine(one.question, 300), answer: cut(one.answer) })).filter((one) => one.answer !== '');
  const asked = input.status === undefined || input.status === null || String(input.status).trim() === '' ? null : keyOf(String(input.status));
  if (asked !== null && !(REQUEST_STATUSES as readonly string[]).includes(asked)) {
    return { ok: false, reason: `"${String(input.status)}" is not a status. One of: ${REQUEST_STATUSES.map(words).join(', ')}.` };
  }
  if (!note && answers.length === 0 && asked === null) return { ok: false, reason: 'Nothing to add: give a note, an answer to one of its questions, or a new status.' };

  // Tick what was answered: by the question's own words, or by its number on the list.
  let ticked = 0;
  for (const answer of answers) {
    const items = checklist(lines).filter((item) => item.open);
    const all = checklist(lines);
    const byNumber = /^#?(\d{1,2})$/.exec(answer.question);
    const want = loose(answer.question);
    const hit =
      (byNumber ? all[Number(byNumber[1]) - 1] : undefined) ??
      items.find((item) => loose(item.question) === want) ??
      (want.length >= 6 ? items.find((item) => loose(item.question).includes(want) || want.includes(loose(item.question))) : undefined);
    if (!hit || !hit.open) continue;
    lines[hit.at] = lines[hit.at]!.replace('- [ ] ', '- [x] ');
    if (byNumber) answer.question = hit.question;
    ticked += 1;
  }

  const before = ((REQUEST_STATUSES as readonly string[]).includes(head.status) ? head.status : 'open') as RequestStatus;
  const stillOpen = checklist(lines).filter((item) => item.open).length;
  const after = (asked ?? (before === 'needs_answers' && stillOpen === 0 ? 'open' : before)) as RequestStatus;
  if (after !== before) {
    const end = lines.findIndex((line) => /^##\s/.test(line));
    const at = lines.findIndex((line, index) => (end < 0 || index < end) && line.startsWith('- Status: '));
    if (at >= 0) lines[at] = `- Status: ${words(after)}`;
  }

  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  if (!lines.some((line) => line.trim() === `## ${FOLLOW_UP}`)) lines.push('', `## ${FOLLOW_UP}`);
  lines.push('', `### ${input.when} — ${oneLine(input.who, 200)}`);
  if (note) lines.push(note);
  for (const answer of answers) lines.push('', `**Asked:** ${answer.question || '(a question of his own)'}`, `**Answered:** ${answer.answer.split(NL).join(`${NL}  `)}`);
  if (after !== before) lines.push('', `Status: ${words(before)} → ${words(after)}`);
  lines.push('');
  return { ok: true, text: lines.join(NL), status: after, ticked };
}

const newestFirst = (heads: readonly RequestHead[]) => [...heads].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

/** `INDEX.md`: every request on one line, newest first. */
export function requestIndex(heads: readonly RequestHead[]): string {
  const cell = (text: string) => text.replace(/\|/g, '\\|');
  return [
    '# Requests kept by Noah',
    '',
    'What people asked to be added or changed in the ERP — one file each, in this folder, written by the assistant after asking them what they want and why. Newest first.',
    'Change a file\'s `- Status:` line as it moves: needs answers → open → ready → in progress → done (or declined).',
    '',
    '| Request | Title | Kind | Area | Status | Asked by | Date |',
    '|---|---|---|---|---|---|---|',
    ...newestFirst(heads).map((head) => `| [${head.id}](${head.id}.md) | ${cell(head.title)} | ${words(head.kind)} | ${cell(head.area)} | ${words(head.status)} | ${cell(head.who)} | ${head.date} |`),
    '',
  ].join(NL);
}

/**
 * The requests on file, for Noah to read: how many and where they stand, then
 * a line each. `files` pairs each head with its file's text, so a search
 * looks at everything that was said and not only at the title.
 */
export function requestList(
  files: ReadonlyArray<{ readonly head: RequestHead; readonly text: string }>,
  options: { readonly limit?: number; readonly status?: string; readonly search?: string } = {},
): string {
  if (files.length === 0) return 'No request is on file yet.';
  const tally = REQUEST_STATUSES.map((status) => [status, files.filter((file) => file.head.status === status).length] as const).filter(([, n]) => n > 0);
  const headline = `${files.length} request(s) on file: ${tally.map(([status, n]) => `${n} ${words(status)}`).join(', ') || 'none with a known status'}.`;

  const status = options.status?.trim() ? keyOf(options.status) : '';
  const sought = (options.search ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const limit = Math.max(1, Math.min(50, Math.floor(Number(options.limit) || 20)));
  const matching = newestFirst(
    files
      .filter((file) => !status || file.head.status === status)
      .filter((file) => sought.every((word) => file.text.toLowerCase().includes(word)))
      .map((file) => file.head),
  );
  const asked = [status ? `status ${words(status)}` : '', sought.length > 0 ? `mentioning "${sought.join(' ')}"` : ''].filter(Boolean).join(', ');
  if (matching.length === 0) return [headline, `None ${asked}.`].join(NL);
  return [
    headline,
    asked || matching.length > limit ? `${matching.length > limit ? `The newest ${limit} of ${matching.length}` : `${matching.length}`}${asked ? ` ${asked}` : ''}:` : '',
    ...matching
      .slice(0, limit)
      .map(
        (head) =>
          `${head.id} · ${words(head.status)} · ${words(head.kind)} · ${head.area} · ${head.title} · ${head.who} · ${head.date}${head.open > 0 ? ` · ${head.open} question(s) still open` : ''}`,
      ),
    'Read one whole by its id before you speak about it. When somebody adds to a thing already on this list, add it to that request rather than filing it twice.',
  ]
    .filter((line) => line !== '')
    .join(NL);
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

export const FEEDBACK_VERDICTS = ['wrong', 'good'] as const;
export type FeedbackVerdict = (typeof FEEDBACK_VERDICTS)[number];

export interface FeedbackInput {
  readonly verdict: FeedbackVerdict;
  readonly question: string;
  readonly answer: string;
  readonly whatWasWrong?: string | null;
  readonly rightAnswer?: string | null;
  readonly tools?: readonly string[];
}

/** One verdict on one answer: what was asked, what he said, and what should have been said. */
export function feedbackFile(input: { readonly id: string; readonly when: string; readonly who: string; readonly chat: string; readonly feedback: FeedbackInput }): string {
  const { feedback } = input;
  const wrong = feedback.verdict === 'wrong';
  const tools = (feedback.tools ?? []).map((tool) => oneLine(tool, 60)).filter(Boolean);
  const rows = [
    `# ${input.id} — ${wrong ? 'a wrong answer' : 'a good answer'}`,
    `- Verdict: ${wrong ? 'wrong 👎' : 'good 👍'}`,
    `- Who: ${oneLine(input.who, 200)}`,
    `- Where: ${oneLine(input.chat, 80)}`,
    `- When: ${input.when}`,
    `- Tools he used: ${tools.length > 0 ? tools.join(' → ') : 'none'}`,
    '',
  ];
  const section = (title: string, text: string | null | undefined, quote = false) => {
    const said = body(text);
    if (!said) return;
    rows.push(`## ${title}`, quote ? said.split(NL).map((row) => `> ${row}`).join(NL) : said, '');
  };
  section('The question', feedback.question, true);
  section('The answer he gave', feedback.answer);
  section('What was wrong with it', feedback.whatWasWrong);
  section('The right answer', feedback.rightAnswer);
  return rows.join(NL);
}

/**
 * A wrong answer as one line of `eval-candidates.jsonl` — what the developer
 * turns into a case of the test set, so the same mistake fails a run for ever
 * after instead of being made again.
 */
export function candidateLine(input: { readonly id: string; readonly at: string; readonly feedback: FeedbackInput }): string {
  return JSON.stringify({
    id: input.id,
    at: input.at,
    question: cut(input.feedback.question),
    answer: cut(input.feedback.answer),
    whatWasWrong: cut(input.feedback.whatWasWrong) || null,
    rightAnswer: cut(input.feedback.rightAnswer) || null,
    tools: (input.feedback.tools ?? []).map((tool) => oneLine(tool, 60)).filter(Boolean),
  });
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/** How much he keeps: past this the oldest is let go. */
export const COMPANY_FACT_CAP = 60;
export const PERSON_FACT_CAP = 30;
export const FACT_LENGTH = 300;

export interface Fact {
  readonly fact: string;
  /** Who told him. */
  readonly who: string;
  readonly day: string;
}

/**
 * What must never be remembered: a password, a code, a card.
 *
 * By whole words, so "the container passed customs" and "her passport is
 * with the broker" are still facts worth keeping.
 */
const SECRET =
  /\bpass(word|code|phrase|wd)?s?\b|\bpwd\b|كلم[ةه]\s*(ال)?(مرور|سر)|(ال)?رمز\s*(ال)?سري|\botps?\b|\btokens?\b|\bpin\b|\bcvv\b|\bcvc\b|card\s*number|رقم\s*(ال)?بطاق[ةه]|\biban\b.*\d{10}|\bsecret\b/i;

export function looksSecret(text: string): boolean {
  return SECRET.test(text);
}

/** A fact as he keeps it: one sentence on one line. */
export function tidyFact(raw: string | null | undefined): string {
  return oneLine((raw ?? '').replace(/^\s*[-•*]\s*/, ''), FACT_LENGTH);
}

const sameFact = (a: string, b: string) => loose(a) === loose(b);

export const factLine = (fact: Fact) => `- ${fact.fact} — ${fact.who}, ${fact.day}`;

/** The facts of a memory file, oldest first. Anything that is not a fact line is the file's heading. */
export function parseFacts(text: string): Fact[] {
  const out: Fact[] = [];
  for (const line of text.replace(/\r/g, '').split(NL)) {
    if (!line.startsWith('- ')) continue;
    const dated = /^- (.*) — (.*), (\d{4}-\d{2}-\d{2})$/.exec(line);
    if (dated) out.push({ fact: dated[1]!.trim(), who: dated[2]!.trim(), day: dated[3]! });
    // A line somebody typed by hand, with no name or date on it, is still a fact.
    else if (line.slice(2).trim()) out.push({ fact: line.slice(2).trim(), who: '', day: '' });
  }
  return out;
}

export const COMPANY_HEADER = ['# What the company has taught Noah', '', 'Facts people told the assistant to keep, one per line, oldest first. Delete a line to make him forget it.', ''].join(NL);
export const personHeader = (who: string) => [`# What Noah knows about ${shortWho(who)}`, '', 'What this person asked the assistant to remember about them, one per line, oldest first.', ''].join(NL);

/** A memory file from its facts. */
export const factsFile = (header: string, facts: readonly Fact[]) => `${header}${facts.map(factLine).join(NL)}${facts.length > 0 ? NL : ''}`;

export type Remembered =
  | { readonly ok: true; readonly fact: Fact; readonly kept: readonly Fact[]; readonly dropped: readonly Fact[] }
  | { readonly ok: false; readonly reason: string };

/**
 * One more fact beside those already kept — or why not.
 *
 * Refused: nothing to keep, a secret, and what is already known word for
 * word. Past the cap the oldest go, and the caller is told which.
 */
export function addFact(existing: readonly Fact[], input: { readonly fact: string; readonly who: string; readonly day: string }, cap: number): Remembered {
  const fact = tidyFact(input.fact);
  if (fact.length < 3) return { ok: false, reason: 'There is nothing to remember: say the fact in one sentence.' };
  if (looksSecret(fact)) return { ok: false, reason: 'Not kept: I do not keep passwords or codes. Tell them so, and that it should not be written in a chat either.' };
  if (existing.some((one) => sameFact(one.fact, fact))) return { ok: false, reason: `Already known: "${fact}".` };
  const added: Fact = { fact, who: shortWho(input.who), day: input.day };
  const all = [...existing, added];
  const over = Math.max(0, all.length - cap);
  return { ok: true, fact: added, kept: all.slice(over), dropped: all.slice(0, over) };
}

/** The facts with those that mention `match` taken out. Too short a match takes out nothing: "a" is not a fact to forget. */
export function removeFacts(existing: readonly Fact[], match: string): { readonly kept: readonly Fact[]; readonly removed: number } {
  const want = oneLine(match).toLowerCase();
  if (want.length < 2) return { kept: existing, removed: 0 };
  const kept = existing.filter((one) => !one.fact.toLowerCase().includes(want));
  return { kept, removed: existing.length - kept.length };
}

// ---------------------------------------------------------------------------
// The walkthrough somebody is in
// ---------------------------------------------------------------------------

export interface Walkthrough {
  readonly title: string;
  readonly steps: readonly string[];
  /**
   * The step they are on NOW, counted from 1. Every step before it is done;
   * one more than the number of steps means all of them are.
   */
  readonly current: number;
  /** The document it is about, once there is one. */
  readonly document?: string | null;
  /** What to look for in the system before the current step is called done. */
  readonly check?: string | null;
  readonly startedAt: string;
  readonly updatedAt: string;
}

export const WALK_STEP_CAP = 20;
export const WALK_HOURS = 24;

/** A walkthrough as it will be kept — or the sentence that says why it cannot be. */
export function tidyWalkthrough(input: {
  readonly title: string;
  readonly steps: readonly string[];
  readonly current: number;
  readonly document?: string | null;
  readonly check?: string | null;
  readonly now: Date;
  /** The one already kept for this person, if any: the same title keeps its start. */
  readonly earlier?: Walkthrough | null;
}): Walkthrough {
  const title = oneLine(input.title, 160);
  const steps = (input.steps ?? []).map((step) => oneLine(String(step ?? '').replace(/^\s*(\d+[.)]|[-•*])\s*/, ''), 300)).filter(Boolean);
  if (!title) throw new Error('A walkthrough needs a title: what they are doing, in a few words.');
  if (steps.length === 0) throw new Error('A walkthrough needs its steps, in order, one action each.');
  if (steps.length > WALK_STEP_CAP) throw new Error(`That is ${steps.length} steps; a walkthrough takes up to ${WALK_STEP_CAP}. Break the task in two.`);
  const current = Math.max(1, Math.min(steps.length + 1, Math.floor(Number(input.current) || 1)));
  const at = input.now.toISOString();
  return {
    title,
    steps,
    current,
    document: oneLine(input.document, 80) || null,
    check: oneLine(input.check, 400) || null,
    startedAt: input.earlier && input.earlier.title === title ? input.earlier.startedAt : at,
    updatedAt: at,
  };
}

/** Still theirs: touched within the day. An abandoned walkthrough must not answer a "done" said next week. */
export function walkAlive(walk: Walkthrough, now: Date): boolean {
  const touched = Date.parse(walk.updatedAt);
  return Number.isFinite(touched) && now.getTime() - touched <= WALK_HOURS * 3_600_000;
}

/** A kept walkthrough read back from its file; null for anything that is not one. */
export function parseWalkthrough(raw: string): Walkthrough | null {
  try {
    const kept = JSON.parse(raw) as Partial<Walkthrough> | null;
    if (!kept || typeof kept.title !== 'string' || !Array.isArray(kept.steps) || kept.steps.length === 0) return null;
    if (typeof kept.updatedAt !== 'string' || typeof kept.current !== 'number') return null;
    return {
      title: kept.title,
      steps: kept.steps.map((step) => String(step)),
      current: Math.max(1, Math.min(kept.steps.length + 1, Math.floor(kept.current))),
      document: typeof kept.document === 'string' && kept.document ? kept.document : null,
      check: typeof kept.check === 'string' && kept.check ? kept.check : null,
      startedAt: typeof kept.startedAt === 'string' ? kept.startedAt : kept.updatedAt,
      updatedAt: kept.updatedAt,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The last thing they asked
// ---------------------------------------------------------------------------

export interface LastExchange {
  readonly at: string;
  readonly question: string;
  /** How his answer began. */
  readonly answer: string;
  readonly tools: readonly string[];
}

export const LAST_QUESTION_CAP = 400;
export const LAST_ANSWER_CAP = 600;
/** Inside the hour the conversation itself is in front of him; past a fortnight it is nobody's "continue". */
export const LAST_AFTER_MINUTES = 60;
export const LAST_FOR_DAYS = 14;

export function tidyExchange(input: { readonly question: string; readonly answer: string; readonly tools: readonly string[]; readonly now: Date }): LastExchange {
  return {
    at: input.now.toISOString(),
    question: cut(input.question, LAST_QUESTION_CAP),
    answer: cut(input.answer, LAST_ANSWER_CAP),
    tools: (input.tools ?? []).map((tool) => oneLine(String(tool), 60)).filter(Boolean).slice(0, 20),
  };
}

export function parseExchange(raw: string): LastExchange | null {
  try {
    const kept = JSON.parse(raw) as Partial<LastExchange> | null;
    if (!kept || typeof kept.at !== 'string' || typeof kept.question !== 'string') return null;
    return { at: kept.at, question: kept.question, answer: typeof kept.answer === 'string' ? kept.answer : '', tools: Array.isArray(kept.tools) ? kept.tools.map((tool) => String(tool)) : [] };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// What goes into his instructions
// ---------------------------------------------------------------------------

/** About this much, so memory never crowds out the instructions it sits in. */
export const MEMORY_PROMPT_CAP = 3_500;

function walkText(walk: Walkthrough): string {
  const total = walk.steps.length;
  const done = walk.current > total;
  const lines = [
    `THE WALKTHROUGH THEY ARE IN — "${walk.title}"${walk.document ? `, document ${walk.document}` : ''}: ${done ? `all ${total} steps are done` : `step ${walk.current} of ${total}`}. You are taking them through it one step at a time and waiting for them after each.`,
    ...walk.steps.map((step, index) => `${index + 1 < walk.current ? '✓' : index + 1 === walk.current ? '→' : ' '} ${index + 1}. ${step}`),
  ];
  if (done) {
    lines.push('Every step is done: tell them so in one line, say what the document or screen shows now, and clear the walkthrough.');
  } else {
    if (walk.check) lines.push(`Before you say ✓ for step ${walk.current}, look for this in the system: ${walk.check}`);
    lines.push(
      `• When they say done / next / ok / تم / خلصت / التالي: CHECK the system first — document_story, review_document or a live picture — that step ${walk.current} really happened. If it did, say ✓ and what you saw, then give the next step alone, with its picture, and save the walkthrough again with the next step as the current one. If it did not, say what you see instead and exactly what to do, and stay on this step.`,
      '• One step per message. Do not run ahead, and do not repeat the steps already ticked.',
      '• When they finish, give up, or ask about something else entirely, clear the walkthrough — a "done" next week must not be answered from this one.',
    );
  }
  return lines.join(NL);
}

function lastText(last: LastExchange, now: Date): string {
  const at = new Date(last.at);
  const said = oneLine(last.answer, LAST_ANSWER_CAP);
  return [
    `LAST TIME — on ${stampOf(at)} they asked: "${oneLine(last.question, LAST_QUESTION_CAP)}"`,
    said ? `Your answer began: "${said}"` : '',
    last.tools.length > 0 ? `You read: ${last.tools.join(' → ')}.` : '',
    `So "continue", "go on", "كمل" or "and then?" with nothing else means this — pick it up where it stopped (${Math.round((now.getTime() - at.getTime()) / 3_600_000)} hour(s) ago), and read the books again rather than trusting figures from then.`,
  ]
    .filter((line) => line !== '')
    .join(NL);
}

/** Whether the last exchange is one to be reminded of: not the conversation still going on, not ancient history. */
export function lastIsDue(last: LastExchange, now: Date): boolean {
  const age = now.getTime() - Date.parse(last.at);
  return Number.isFinite(age) && age > LAST_AFTER_MINUTES * 60_000 && age < LAST_FOR_DAYS * 86_400_000;
}

/**
 * What he is told about this person and this company, on top of his
 * instructions: '' when there is nothing.
 *
 * In the order it matters when space is short — the walkthrough they are in
 * and the last thing they asked are kept whole, the person's own facts next,
 * and the company's facts fill what is left, newest kept.
 */
export function memoryPrompt(input: {
  readonly company: readonly Fact[];
  readonly person: readonly Fact[];
  readonly walk: Walkthrough | null;
  readonly last: LastExchange | null;
  readonly now: Date;
  readonly cap?: number;
}): string {
  const cap = input.cap ?? MEMORY_PROMPT_CAP;
  const walk = input.walk && walkAlive(input.walk, input.now) ? walkText(input.walk) : '';
  const last = input.last && lastIsDue(input.last, input.now) ? lastText(input.last, input.now) : '';

  // Newest facts first into the space there is; shown oldest first, as they were taught.
  const fit = (facts: readonly Fact[], room: number, line: (fact: Fact) => string): { readonly lines: string[]; readonly left: number } => {
    const lines: string[] = [];
    let used = 0;
    for (let at = facts.length - 1; at >= 0; at -= 1) {
      const text = line(facts[at]!);
      if (used + text.length + 1 > room) break;
      lines.unshift(text);
      used += text.length + 1;
    }
    return { lines, left: facts.length - lines.length };
  };

  const PERSON_HEAD = 'WHAT YOU KNOW ABOUT THIS PERSON — they asked you to remember it. Act on it without being asked again (a language, a role, a branch, how they like an answer):';
  const COMPANY_HEAD = 'WHAT THE COMPANY HAS TAUGHT YOU — facts people here told you to keep. Take them as true of this company, use its own names for things, and say so plainly if a tool shows otherwise:';
  let room = cap - walk.length - last.length;
  const person = input.person.length > 0 ? fit(input.person, Math.max(0, Math.min(room - PERSON_HEAD.length, 1_200)), (fact) => `• ${fact.fact}`) : { lines: [], left: 0 };
  const personText = person.lines.length > 0 ? [PERSON_HEAD, ...person.lines].join(NL) : '';
  room -= personText.length;
  const company =
    input.company.length > 0 ? fit(input.company, Math.max(0, room - COMPANY_HEAD.length - 60), (fact) => `• ${fact.fact}${fact.who ? ` (${fact.who}${fact.day ? `, ${fact.day}` : ''})` : ''}`) : { lines: [], left: 0 };
  const companyText =
    company.lines.length > 0 ? [COMPANY_HEAD, ...company.lines, ...(company.left > 0 ? [`(${company.left} older fact(s) are kept and not shown here.)`] : [])].join(NL) : '';

  return [companyText, personText, walk, last].filter((part) => part !== '').join(`${NL}${NL}`);
}
