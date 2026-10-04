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
  findScreens,
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
// The pictures
// ---------------------------------------------------------------------------

export type ShotView = 'menu' | 'screen' | 'form' | 'record' | 'dialog';
/** One picture each per screen; a screen may have several `dialog` pictures beside them. */
export const SHOT_VIEWS: readonly Exclude<ShotView, 'dialog'>[] = ['menu', 'screen', 'form', 'record'];

/** One numbered pointer drawn on a picture, and what it points at. */
interface Mark {
  readonly n: number;
  readonly label: string;
  readonly kind: string;
  readonly required?: boolean;
  /** A dropdown's choices, as the screen lists them. */
  readonly options?: readonly string[];
  /** What the screen itself says under the field. */
  readonly hint?: string;
}

interface Shot {
  readonly route: string;
  readonly locale: 'en' | 'ar';
  readonly view: ShotView;
  readonly file: string;
  /** On a screen's picture: its "New …" button is ringed. */
  readonly ringed?: boolean;
  /** The red numbers on the picture, in order. */
  readonly marks?: readonly Mark[];
  /** A dialog's picture: where it opens from, its name in this language, and a key that is the same in both. */
  readonly on?: 'screen' | 'record';
  readonly name?: string;
  readonly key?: string;
}

/** Where `scripts/guide/make-screens.ts` put them (copied to the server's `var/`). */
function shotsDir(): string {
  return process.env.ERP_GUIDE_SHOTS_DIR?.trim() || join(process.cwd(), 'var', 'guide-shots');
}

let shotsCache: { readonly stamp: number; readonly shots: readonly Shot[] } | null = null;

function shots(): readonly Shot[] {
  const file = join(shotsDir(), 'index.json');
  if (!existsSync(file)) return [];
  const stamp = statSync(file).mtimeMs;
  if (shotsCache && shotsCache.stamp === stamp) return shotsCache.shots;
  try {
    shotsCache = { stamp, shots: JSON.parse(readFileSync(file, 'utf8')) as Shot[] };
  } catch {
    shotsCache = { stamp, shots: [] };
  }
  return shotsCache.shots;
}

const VIEW_WORDS: Readonly<Record<ShotView, { readonly en: string; readonly ar: string }>> = {
  menu: { en: 'where it is in the menu — the entry ringed in red', ar: 'مكانها في القائمة — المدخل المحاط بالأحمر' },
  screen: { en: 'the screen as it opens', ar: 'الشاشة كما تظهر عند فتحها' },
  form: { en: 'the form that opens — the fields to fill', ar: 'النموذج الذي يُفتح — الحقول المطلوب تعبئتها' },
  record: { en: 'one record opened — its status, its buttons and its doors', ar: 'سجل مفتوح — حالته وأزراره وأبوابه' },
  dialog: { en: 'the window that opens', ar: 'النافذة التي تُفتح' },
};

/** A screen whose "New …" button is ringed in its picture says so under it. */
const RINGED_WORDS = { en: 'the screen — the button ringed in red starts a new one', ar: 'الشاشة — الزر المحاط بالأحمر يبدأ سجلاً جديداً' } as const;
const NUMBERED_WORDS = { en: 'the red numbers are explained in the message', ar: 'الأرقام الحمراء مشروحة في الرسالة' } as const;

/**
 * The pictures that are not a screen of the menu — the way in, and the bar
 * every screen sits under. Everybody is shown these: there is no role that
 * may not see how to sign in.
 */
const EXTRAS: ReadonlyArray<{
  readonly route: string;
  readonly en: string;
  readonly ar: string;
  readonly words: readonly string[];
}> = [
  { route: '/sign-in', en: 'Sign in', ar: 'تسجيل الدخول', words: ['sign in', 'signin', 'sign-in', 'log in', 'login', 'log-in', 'تسجيل الدخول', 'دخول', 'تسجيل'] },
  { route: 'top-bar', en: 'The top bar', ar: 'الشريط العلوي', words: ['top bar', 'topbar', 'top-bar', 'navbar', 'nav bar', 'navigation', 'header', 'menu bar', 'الشريط العلوي', 'الشريط', 'القائمة العلوية'] },
  { route: 'user-menu', en: 'Your account menu', ar: 'قائمة الحساب', words: ['account menu', 'user menu', 'user-menu', 'profile', 'my account', 'sign out', 'log out', 'logout', 'appearance', 'قائمة الحساب', 'تسجيل الخروج', 'المظهر', 'حسابي'] },
  { route: '/password', en: 'Change password', ar: 'تغيير كلمة المرور', words: ['change password', 'password', 'كلمة المرور', 'كلمة السر', 'تغيير كلمة المرور'] },
];

function extraFor(asked: string) {
  const wanted = asked.trim().toLowerCase();
  if (!wanted) return null;
  return (
    EXTRAS.find((extra) => extra.route === wanted || extra.en.toLowerCase() === wanted || extra.ar === wanted) ??
    EXTRAS.find((extra) => extra.words.some((word) => wanted.includes(word))) ??
    null
  );
}

const KIND_WORDS: Readonly<Record<string, string>> = {
  text: 'a box to type in',
  area: 'a larger box to type in',
  choice: 'a list to choose from',
  date: 'a date',
  tick: 'a tick box',
  file: 'a file to attach',
  button: 'a button',
  tabs: 'the row of tabs',
  search: 'the search box',
  filter: 'a filter',
  table: 'a table, its columns',
  paging: 'the page control',
  section: 'a section',
  status: 'the status',
  door: 'an icon in the title bar',
  link: 'a link',
};

/** The numbers on one picture, written out for the model: which is which. */
function marksLine(marks: readonly Mark[] | undefined): string {
  if (!marks || marks.length === 0) return '';
  return marks
    .map((mark) => {
      const choices = mark.options && mark.options.length > 0 ? `; its choices: ${mark.options.join(' / ')}` : '';
      const hint = mark.hint ? `; the screen says: "${mark.hint}"` : '';
      return `${mark.n} = ${mark.label} (${KIND_WORDS[mark.kind] ?? mark.kind}${mark.required ? ', required' : ''}${choices}${hint})`;
    })
    .join(' · ');
}

/** A picture's tag: its file's name without the folder or the extension. */
const tagOf = (file: string) =>
  file
    .replace(/^.*[\\/]/, '')
    .replace(/\.[a-z0-9]+$/i, '')
    .toLowerCase();

/**
 * The `show_screen` tool: the pictures of one screen, in the asker's language,
 * each with its tag and the meaning of every number drawn on it.
 *
 * The screen is found the way `screens` finds it — by its address, or by words
 * of its name — and only a screen the asker's role may open is shown. The way
 * in (signing in, the top bar, the account menu, the password) is everybody's.
 */
export function screenPictures(
  principal: Principal,
  locale: 'en' | 'ar',
  asked: string,
  view: ShotView | 'all' = 'all',
  dialog: string | null = null,
): { readonly text: string; readonly images: ReadonlyArray<{ readonly file: string; readonly caption: string }> } {
  const all = shots();
  if (all.length === 0) return { text: 'No pictures are installed on this server. Describe the path in words (the screens tool).', images: [] };

  const catalogue = screenCatalogue({ principal, en: EN, ar: AR });
  const wanted = asked.trim();
  const extra = extraFor(wanted);
  const entry = extra ? null : (catalogue.find((candidate) => candidate.route === wanted) ?? findScreens(catalogue, wanted).find((candidate) => candidate.built) ?? null);
  if (!extra && !entry) {
    return {
      text: `No built screen matches "${asked}". Search with the screens tool first, then ask for the picture by its address. Besides the menu's screens there are pictures of: ${EXTRAS.map((one) => `"${one.en.toLowerCase()}"`).join(', ')}.`,
      images: [],
    };
  }
  if (entry && !entry.allowed) return { text: `This person's role cannot open ${entry.en.screen}, so its picture is not theirs to be shown. Tell them which permission it needs.`, images: [] };

  const route = extra ? extra.route : entry!.route;
  const title = extra ? extra.en : entry!.en.screen;
  const names = entry ? (locale === 'ar' ? entry.ar : entry.en) : null;
  const heading = extra ? (locale === 'ar' ? extra.ar : extra.en) : `${names!.module} → ${names!.heading} → ${names!.screen}`;

  // The windows that open from this screen and from its record, in this language.
  const dialogs = all.filter((candidate) => candidate.route === route && candidate.locale === locale && candidate.view === 'dialog' && existsSync(join(shotsDir(), candidate.file)));
  const dialogList = dialogs.map((one) => `"${one.key ?? one.name ?? ''}"${one.name && one.name.toLowerCase() !== (one.key ?? '').replace(/_/g, ' ') ? ` (${one.name})` : ''}${one.on === 'record' ? ' — on an opened record' : ''}`).join(', ');

  if (view === 'dialog') {
    if (dialogs.length === 0) return { text: `${title} (${route}) has no picture of a dialog. Describe it in words.`, images: [] };
    const wantedDialog = (dialog ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    const one =
      dialogs.length === 1 && !wantedDialog
        ? dialogs[0]
        : dialogs.find((candidate) => (candidate.key ?? '').toLowerCase() === wantedDialog) ??
          dialogs.find((candidate) => wantedDialog !== '' && ((candidate.key ?? '').toLowerCase().includes(wantedDialog) || (candidate.name ?? '').toLowerCase().replace(/[\s-]+/g, '_').includes(wantedDialog)));
    if (!one) {
      return {
        text: `${title} (${route}) has these dialogs: ${dialogList}. Call show_screen again with view "dialog" and dialog set to the one you mean${wantedDialog ? ` — "${dialog}" is not one of them` : ''}.`,
        images: [],
      };
    }
    const file = join(shotsDir(), one.file);
    const numbers = marksLine(one.marks);
    const caption = `${heading}: ${one.name ?? one.key ?? ''} — ${VIEW_WORDS.dialog[locale]}${numbers ? ` — ${NUMBERED_WORDS[locale]}` : ''}`;
    return {
      text: [
        `1 picture of ${title} (${route}) is attached to your answer: the "${one.name ?? one.key}" window, which opens from ${one.on === 'record' ? 'an opened record' : 'the screen'}. Place it at its step: write its tag on a line of its own, and what you write under it is sent as its caption.`,
        `[picture: ${tagOf(file)}] — ${VIEW_WORDS.dialog.en}.${numbers ? ` The red numbers on it: ${numbers}.` : ' Nothing is numbered on this one.'}`,
        'Say its number and its name for each thing the person has to use, what it is for, what to put there, and what happens when they press the button that saves.',
        "It is a picture of a training copy with sample data: the layout is real, the names and figures in it are not the company's.",
      ].join('\n'),
      images: [{ file, caption }],
    };
  }

  // "all" is a how-to: where it is, the screen, the form. A record is asked for by name.
  const views: Exclude<ShotView, 'dialog'>[] = view === 'all' ? (extra ? [...SHOT_VIEWS] : ['menu', 'screen', 'form']) : [view];
  const found = views.flatMap((one) => {
    const shot = all.find((candidate) => candidate.route === route && candidate.locale === locale && candidate.view === one);
    if (!shot) return [];
    const file = join(shotsDir(), shot.file);
    if (!existsSync(file)) return [];
    const words = one === 'screen' && shot.ringed && !extra ? RINGED_WORDS[locale] : VIEW_WORDS[one][locale];
    const numbered = shot.marks && shot.marks.length > 0 ? ` — ${NUMBERED_WORDS[locale]}` : '';
    return [{ shot, file, caption: extra ? `${heading}${numbered}` : `${heading}: ${words}${numbered}` }];
  });
  if (found.length === 0) {
    const others = SHOT_VIEWS.filter((one) => all.some((candidate) => candidate.route === route && candidate.locale === locale && candidate.view === one));
    return {
      text: `There is no ${view === 'all' ? '' : `"${view}" `}picture of ${title} (${route})${view === 'form' ? ' — it has no New button of its own' : ''}.${others.length > 0 && view !== 'all' ? ` It has: ${others.join(', ')}.` : ''} Describe it in words.`,
      images: [],
    };
  }

  const also = extra ? [] : SHOT_VIEWS.filter((one) => !views.includes(one) && all.some((candidate) => candidate.route === route && candidate.locale === locale && candidate.view === one));
  return {
    text: [
      `${found.length} picture(s) of ${title} (${route}) are attached to your answer. Place each one at its step: write its tag on a line of its own, and what you write under the tag (up to the next tag) is sent as that picture's caption.`,
      ...found.map(({ shot, file }) => {
        const what = shot.view === 'screen' && shot.ringed && !extra ? RINGED_WORDS.en : VIEW_WORDS[shot.view].en;
        const numbers = marksLine(shot.marks);
        return `[picture: ${tagOf(file)}] — ${what}.${numbers ? ` The red numbers on it: ${numbers}.` : ' Nothing is numbered on this one.'}`;
      }),
      'For every numbered thing the person has to use, say its number and its name as the picture shows it, then: what it is for, why the system needs it, what to put there (with an example), whether it may be left empty, and what it changes elsewhere — the guide tool has this for each screen. Skip a number that does not matter to what they asked.',
      also.length > 0 ? `This screen also has: ${also.map((one) => `"${one}"`).join(', ')} — ask for it by that view when the task goes there (a "record" is one saved document opened: its status, its action buttons, and the printer / paperclip / notes / history icons).` : '',
      dialogs.length > 0 ? `It also has pictures of the windows that open from it (view "dialog", dialog = the name): ${dialogList}. Use one when the step is "attach the file", "add a note", "see its history", "print it" or an action that asks for something.` : '',
      "They are pictures of a training copy with sample data: the layout is real, the names and figures in them are not the company's.",
    ]
      .filter((line) => line !== '')
      .join('\n'),
    images: found.map(({ file, caption }) => ({ file, caption })),
  };
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
