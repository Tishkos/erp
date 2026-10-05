/**
 * What Noah writes down and reads back, bound to the files it lives in.
 *
 * `domain/whatsapp-notes.ts` is the reasoning — the text of each file, how one
 * is read back, the words that go into his instructions — and knows nothing
 * about disk. This is the folder: `var/noah/` beside the application
 * (`NOAH_NOTES_DIR` overrides it; `var/` outlives a deploy).
 *
 *   requests/REQ-YYYYMMDD-NNN.md      one file per request, and INDEX.md of them all
 *   feedback/FB-YYYYMMDD-NNN.md       one file per verdict on an answer
 *   feedback/eval-candidates.jsonl    one line per WRONG answer, for the test set
 *   memory/company.md                 the facts the company taught him
 *   memory/people/<userId>.md         what one person asked him to remember
 *   memory/last/<userId>.json         their last exchange
 *   memory/walk/<userId>.json         the walkthrough they are in
 *
 * Files on purpose, as the issues list is (`services/system-guide.ts`): every
 * one of these is written from inside a question's read-only transaction,
 * where the database refuses every write. So nothing here touches the
 * database, and nothing here can.
 *
 * How a write is kept whole: a new numbered file is created exclusively, so
 * two people filing at the same moment get two numbers and neither is lost;
 * a file that is rewritten is written beside itself and renamed into place;
 * a memory file only grows by one appended line until it is over its cap.
 * A user id becomes a file name only after it has been checked to be one.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { businessToday } from '../domain/business-date';
import {
  COMPANY_FACT_CAP,
  COMPANY_HEADER,
  PERSON_FACT_CAP,
  REQUEST_ID,
  addFact,
  candidateLine,
  checkRequest,
  factLine,
  factsFile,
  feedbackFile,
  followUp,
  isUserId,
  memoryPrompt,
  nextId,
  oneLine,
  parseExchange,
  parseFacts,
  parseRequest,
  parseWalkthrough,
  personHeader,
  removeFacts,
  requestFile,
  requestIndex,
  requestList,
  stampOf,
  tidyExchange,
  tidyWalkthrough,
  walkAlive,
  type Fact,
  type FeedbackInput,
  type RequestHead,
  type RequestInput,
  type RequestStatus,
  type Walkthrough,
} from '../domain/whatsapp-notes';

export { REQUEST_KINDS, REQUEST_STATUSES } from '../domain/whatsapp-notes';
export type { RequestInput, Walkthrough } from '../domain/whatsapp-notes';

/** The folder all of it lives in. */
export function notesDir(): string {
  return process.env.NOAH_NOTES_DIR?.trim() || join(process.cwd(), 'var', 'noah');
}

const requestsDir = () => join(notesDir(), 'requests');
const feedbackDir = () => join(notesDir(), 'feedback');
const companyFile = () => join(notesDir(), 'memory', 'company.md');
const personFile = (userId: string) => join(notesDir(), 'memory', 'people', `${userId.toLowerCase()}.md`);
const lastFile = (userId: string) => join(notesDir(), 'memory', 'last', `${userId.toLowerCase()}.json`);
const walkFile = (userId: string) => join(notesDir(), 'memory', 'walk', `${userId.toLowerCase()}.json`);

const read = (file: string): string => (existsSync(file) ? readFileSync(file, 'utf8') : '');

/** A whole file replaced at once: written beside itself, then renamed into place. */
function writeWhole(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const beside = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(beside, text, 'utf8');
  try {
    renameSync(beside, file);
  } catch {
    // A reader holding the old file open (Windows) refuses the rename: write it in place instead.
    writeFileSync(file, text, 'utf8');
    rmSync(beside, { force: true });
  }
}

/**
 * A new file under the next number of the day.
 *
 * The number is found by looking at the folder now, and the file is created
 * exclusively: if somebody else took that number in the same instant, the
 * next one is tried. Nobody's file is written over.
 */
function createNumbered(dir: string, prefix: string, day: string, text: (id: string) => string): { readonly id: string; readonly file: string } {
  mkdirSync(dir, { recursive: true });
  const taken = readdirSync(dir);
  for (let tries = 0; tries < 60; tries += 1) {
    const id = nextId(prefix, day, taken);
    const file = join(dir, `${id}.md`);
    try {
      writeFileSync(file, text(id), { encoding: 'utf8', flag: 'wx' });
      return { id, file };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      taken.push(`${id}.md`);
    }
  }
  throw new Error(`Could not find a free ${prefix} number for ${day}.`);
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** Every request on file, read from the folder as it is now. */
function requestsOnFile(): { readonly head: RequestHead; readonly text: string }[] {
  const dir = requestsDir();
  if (!existsSync(dir)) return [];
  const out: { head: RequestHead; text: string }[] = [];
  for (const name of readdirSync(dir)) {
    if (!/^REQ-\d{8}-\d{3}\.md$/.test(name)) continue;
    const text = readFileSync(join(dir, name), 'utf8');
    const head = parseRequest(text);
    if (head) out.push({ head, text });
  }
  return out;
}

/** `INDEX.md`, from the folder: a rewrite that lost a race is put right by the next one. */
function rewriteIndex(): void {
  try {
    writeWhole(join(requestsDir(), 'INDEX.md'), requestIndex(requestsOnFile().map((file) => file.head)));
  } catch {
    /* the request is on file; an index that could not be rewritten now is rewritten with the next change */
  }
}

/**
 * Files one request and says what it was filed as.
 *
 * THROWS, with a sentence to say back, when the request has no title, no
 * "what is wanted" or no "why": those are asked for first, not written down
 * empty.
 */
export function recordRequest(input: { readonly who: string; readonly chat: string; readonly request: RequestInput; readonly now?: Date }): { readonly id: string; readonly file: string } {
  const refused = checkRequest(input.request);
  if (refused) throw new Error(refused);
  const now = input.now ?? new Date();
  const filed = createNumbered(requestsDir(), 'REQ', businessToday(now), (id) => requestFile({ id, when: stampOf(now), who: input.who, chat: input.chat, request: input.request }));
  rewriteIndex();
  return filed;
}

/**
 * Adds what was learned since to a request: a note, answers to its open
 * questions, a new status. Appended under Follow-up; what was said before is
 * never rewritten. A refusal is RETURNED (`ok: false`), not thrown.
 */
export function addToRequest(input: {
  readonly id: string;
  readonly who: string;
  readonly note?: string | null;
  readonly answers?: ReadonlyArray<{ readonly question: string; readonly answer: string }>;
  readonly status?: RequestStatus;
  readonly now?: Date;
}): { readonly ok: true; readonly id: string; readonly status: string } | { readonly ok: false; readonly reason: string } {
  const id = String(input.id ?? '').trim().toUpperCase();
  if (!REQUEST_ID.test(id)) return { ok: false, reason: `"${oneLine(String(input.id ?? ''), 40)}" is not a request number. They read REQ-20261005-001; the list of requests shows them.` };
  const file = join(requestsDir(), `${id}.md`);
  if (!existsSync(file)) return { ok: false, reason: `There is no request ${id} on file.` };
  const added = followUp({
    text: readFileSync(file, 'utf8'),
    when: stampOf(input.now ?? new Date()),
    who: input.who,
    ...(input.note === undefined ? {} : { note: input.note }),
    ...(input.answers === undefined ? {} : { answers: input.answers }),
    ...(input.status === undefined ? {} : { status: input.status }),
  });
  if (!added.ok) return added;
  writeWhole(file, added.text);
  rewriteIndex();
  return { ok: true, id, status: added.status };
}

/** The requests on file, as text for Noah: how many and where they stand, then a line each. */
export function listRequests(input: { readonly limit?: number; readonly status?: string; readonly search?: string } = {}): string {
  return requestList(requestsOnFile(), input);
}

/** One request's file, whole; null when the number is not one, or nothing is filed under it. */
export function readRequest(id: string): string | null {
  const wanted = String(id ?? '').trim().toUpperCase();
  if (!REQUEST_ID.test(wanted)) return null;
  const file = join(requestsDir(), `${wanted}.md`);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

/**
 * Keeps one verdict on one answer. A wrong answer is also added, as one line,
 * to `eval-candidates.jsonl` — the list the developer turns into test-set
 * cases. THROWS when there is no verdict, or neither a question nor an answer
 * to hang it on.
 */
export function recordFeedback(input: {
  readonly who: string;
  readonly chat: string;
  readonly verdict: 'wrong' | 'good';
  readonly question: string;
  readonly answer: string;
  readonly whatWasWrong?: string | null;
  readonly rightAnswer?: string | null;
  readonly tools?: readonly string[];
  readonly now?: Date;
}): { readonly id: string; readonly file: string } {
  if (input.verdict !== 'wrong' && input.verdict !== 'good') throw new Error('Not kept: say whether the answer was wrong or good.');
  if (!oneLine(input.question) && !oneLine(input.answer)) {
    throw new Error('Not kept: there is no earlier answer of yours here to mark. Ask them which answer they mean, or what was wrong.');
  }
  const now = input.now ?? new Date();
  const feedback: FeedbackInput = {
    verdict: input.verdict,
    question: input.question ?? '',
    answer: input.answer ?? '',
    ...(input.whatWasWrong === undefined ? {} : { whatWasWrong: input.whatWasWrong }),
    ...(input.rightAnswer === undefined ? {} : { rightAnswer: input.rightAnswer }),
    ...(input.tools === undefined ? {} : { tools: input.tools }),
  };
  const filed = createNumbered(feedbackDir(), 'FB', businessToday(now), (id) => feedbackFile({ id, when: stampOf(now), who: input.who, chat: input.chat, feedback }));
  if (input.verdict === 'wrong') {
    appendFileSync(join(feedbackDir(), 'eval-candidates.jsonl'), `${candidateLine({ id: filed.id, at: now.toISOString(), feedback })}\n`, 'utf8');
  }
  return filed;
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/**
 * Keeps one fact — about the person (`me`) or about the company. A refusal is
 * RETURNED: a bad user id, nothing to keep, a secret, a fact already known.
 */
export function remember(input: { readonly userId: string; readonly who: string; readonly scope: 'me' | 'company'; readonly fact: string; readonly now?: Date }):
  | { readonly ok: true; readonly said: string }
  | { readonly ok: false; readonly reason: string } {
  if (!isUserId(input.userId)) return { ok: false, reason: 'Not kept: I cannot tell whose memory this is.' };
  if (input.scope !== 'me' && input.scope !== 'company') return { ok: false, reason: 'Not kept: say whether it is about this person ("me") or about the company.' };
  const company = input.scope === 'company';
  const file = company ? companyFile() : personFile(input.userId);
  const header = company ? COMPANY_HEADER : personHeader(input.who);
  const added = addFact(parseFacts(read(file)), { fact: input.fact, who: input.who, day: businessToday(input.now ?? new Date()) }, company ? COMPANY_FACT_CAP : PERSON_FACT_CAP);
  if (!added.ok) return added;

  if (added.dropped.length > 0 || !existsSync(file)) {
    // Over the cap, or the first fact: the file is written whole, heading and all.
    writeWhole(file, factsFile(header, added.kept));
  } else {
    appendFileSync(file, `${factLine(added.fact)}\n`, 'utf8');
  }
  const letGo = added.dropped.length > 0 ? ` The oldest was let go to make room: "${added.dropped.map((fact: Fact) => fact.fact).join('"; "')}".` : '';
  return {
    ok: true,
    said: company ? `Kept as a fact about the company: "${added.fact.fact}" (told by ${added.fact.who}).${letGo}` : `Kept about this person: "${added.fact.fact}".${letGo}`,
  };
}

/** Lets go of every kept fact that mentions `match`. Says how many; a bad user id or too short a match lets go of none. */
export function forget(input: { readonly userId: string; readonly scope: 'me' | 'company'; readonly match: string }): { readonly removed: number } {
  if (!isUserId(input.userId) || (input.scope !== 'me' && input.scope !== 'company')) return { removed: 0 };
  const file = input.scope === 'company' ? companyFile() : personFile(input.userId);
  if (!existsSync(file)) return { removed: 0 };
  const text = readFileSync(file, 'utf8');
  const left = removeFacts(parseFacts(text), input.match);
  if (left.removed === 0) return { removed: 0 };
  // The heading the file already has is kept: everything above its first fact.
  const lines = text.replace(/\r/g, '').split('\n');
  const first = lines.findIndex((line) => line.startsWith('- '));
  const header = (first < 0 ? lines : lines.slice(0, first)).join('\n');
  writeWhole(file, factsFile(header.endsWith('\n') || header === '' ? header : `${header}\n`, left.kept));
  return { removed: left.removed };
}

/**
 * Keeps the last thing a person asked and how the answer began, so that
 * "continue" tomorrow means something. NEVER throws: a note that could not be
 * kept must not lose the answer it was a note of.
 */
export function noteExchange(input: { readonly userId: string; readonly question: string; readonly answer: string; readonly tools: readonly string[]; readonly now?: Date }): void {
  try {
    if (!isUserId(input.userId)) return;
    writeWhole(lastFile(input.userId), `${JSON.stringify(tidyExchange({ question: input.question, answer: input.answer, tools: input.tools, now: input.now ?? new Date() }), null, 1)}\n`);
  } catch {
    /* not kept; the answer still goes */
  }
}

/**
 * Keeps the walkthrough a person is in: its steps, and which one they are on
 * now (`current`, counted from 1). THROWS, with a sentence to say back, for a
 * bad user id, no title or no steps.
 */
export function saveWalkthrough(input: {
  readonly userId: string;
  readonly title: string;
  readonly steps: readonly string[];
  readonly current: number;
  readonly document?: string | null;
  readonly check?: string | null;
  readonly now?: Date;
}): Walkthrough {
  if (!isUserId(input.userId)) throw new Error('Not kept: I cannot tell whose walkthrough this is.');
  const now = input.now ?? new Date();
  const walk = tidyWalkthrough({
    title: input.title,
    steps: input.steps,
    current: input.current,
    ...(input.document === undefined ? {} : { document: input.document }),
    ...(input.check === undefined ? {} : { check: input.check }),
    now,
    earlier: readWalkthrough(input.userId, now),
  });
  writeWhole(walkFile(input.userId), `${JSON.stringify(walk, null, 1)}\n`);
  return walk;
}

/** The walkthrough a person is in; null when there is none, or it was last touched more than a day ago. */
export function readWalkthrough(userId: string, now: Date = new Date()): Walkthrough | null {
  if (!isUserId(userId)) return null;
  const file = walkFile(userId);
  if (!existsSync(file)) return null;
  let walk: Walkthrough | null = null;
  try {
    walk = parseWalkthrough(readFileSync(file, 'utf8'));
  } catch {
    walk = null;
  }
  return walk && walkAlive(walk, now) ? walk : null;
}

/** Forgets the walkthrough: they finished, gave up, or moved on. */
export function clearWalkthrough(userId: string): void {
  if (!isUserId(userId)) return;
  try {
    rmSync(walkFile(userId), { force: true });
  } catch {
    /* nothing to clear */
  }
}

/**
 * What goes into his instructions for this person: what the company taught
 * him, what they asked him to remember, the walkthrough they are in, and —
 * after an hour, for a fortnight — the last thing they asked. '' when there
 * is nothing. Never throws: memory that cannot be read is no memory, not no
 * answer.
 */
export function memoryForPrompt(input: { readonly userId: string; readonly now?: Date }): string {
  const now = input.now ?? new Date();
  const safe = <T>(reading: () => T, otherwise: T): T => {
    try {
      return reading();
    } catch {
      return otherwise;
    }
  };
  const known = isUserId(input.userId);
  return memoryPrompt({
    company: safe(() => parseFacts(read(companyFile())), []),
    person: known ? safe(() => parseFacts(read(personFile(input.userId))), []) : [],
    walk: known ? safe(() => readWalkthrough(input.userId, now), null) : null,
    last: known ? safe(() => parseExchange(read(lastFile(input.userId))), null) : null,
    now,
  });
}
