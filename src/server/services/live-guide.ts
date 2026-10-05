/**
 * The `show_screen` tool — live.
 *
 * By direction (2026-10-05): "he doesn't need temporary screenshots any more —
 * always live, no more training picture … he really needs to understand
 * everything and explain with a picture if needed, real time."
 *
 * So a how-to's pictures are no longer read from a folder made ahead of time
 * (the one `scripts/guide/make-screens.ts` filled — retired): each one is
 * taken of the running system, as the person asking, at the moment they ask
 * (`howto-live.ts` → `live-screenshot.ts`). What a picture cannot be taken of
 * is said in words — never shown with a picture of something else.
 *
 * This file finds which screen was meant, asks for the pictures of it, and
 * writes for the model what each one shows: its tag, what every red number is
 * and holds, which entry is ringed, which windows the page can open.
 */
import type { Principal } from '../domain/permissions';
import type { Mark } from '../guide/markers';
import { howToLiveReady, liveExtraPicture, liveHowToPicture, type HowToLive, type HowToView } from './howto-live';
import { EXTRA_SCREENS, marksLine, resolveScreen } from './system-guide';

export interface LiveGuideImage {
  readonly file: string;
  readonly caption: string;
  readonly kind: 'live';
  /** One picture per screen and view: asked for again, it takes the earlier one's place. */
  readonly group: string;
}

const NL = String.fromCharCode(10);

const VIEW_WORDS: Readonly<Record<HowToView, { readonly en: string; readonly ar: string }>> = {
  menu: { en: 'where it is in the menu — the entry ringed in red', ar: 'مكانها في القائمة — المدخل المحاط بالأحمر' },
  screen: { en: 'the screen as it is now', ar: 'الشاشة كما هي الآن' },
  form: { en: 'the form that opens — the fields to fill', ar: 'النموذج الذي يُفتح — الحقول المطلوب تعبئتها' },
  record: { en: 'one of your records, opened', ar: 'أحد سجلاتك مفتوحاً' },
  dialog: { en: 'the window that opens', ar: 'النافذة التي تُفتح' },
};
const NUMBERED = { en: 'the red numbers are explained in the message', ar: 'الأرقام الحمراء مشروحة في الرسالة' } as const;

/** A picture's tag: its file's name without the folder or the extension. */
const tagOf = (file: string) =>
  file
    .replace(/^.*[\\/]/, '')
    .replace(/\.[a-z0-9]+$/i, '')
    .toLowerCase();

const windowsLine = (windows: ReadonlyArray<{ readonly key: string; readonly name: string }> | undefined, on: 'screen' | 'record') =>
  windows && windows.length > 0
    ? ` Windows this ${on} opens — ask for one with view "dialog" and its name${on === 'record' ? ' (it is found on the record)' : ''}: ${windows.map((one) => `"${one.key}" — ${one.name}`).join('; ')}.`
    : '';

const numbersLine = (marks: readonly Mark[]) => (marks.length > 0 ? ` The red numbers on it: ${marksLine(marks)}.` : ' Nothing is numbered on this one.');

/** What one picture shows, for the model. */
function describe(view: HowToView, shot: Extract<HowToLive, { ok: true }>): string {
  const tag = `[picture: ${tagOf(shot.file)}]`;
  switch (view) {
    case 'menu':
      return `${tag} — LIVE, where it is in the menu: the dropdown of "${shot.opened ?? 'its module'}" in the top bar is open, and the entry ringed in red is "${shot.ringed ?? ''}". Nothing is numbered on it.`;
    case 'screen':
      return `${tag} — LIVE, the screen as this person sees it now (${shot.path}).${numbersLine(shot.marks)}${windowsLine(shot.windows, 'screen')}`;
    case 'form':
      return `${tag} — LIVE, the form that opens${shot.opened ? ` when "${shot.opened}" is pressed` : ''}: every field to fill is numbered.${numbersLine(shot.marks)}`;
    case 'record':
      return `${tag} — LIVE, one of this person's own records opened (${shot.path}, "${shot.title}").${numbersLine(shot.marks)}${windowsLine(shot.windows, 'record')}`;
    default:
      return `${tag} — LIVE, the window "${shot.opened ?? ''}" open on ${shot.path}.${numbersLine(shot.marks)}`;
  }
}

const VIEW_NAMES: Readonly<Record<HowToView, string>> = { menu: 'the menu', screen: 'the screen', form: 'the form', record: 'an opened record', dialog: 'the window' };

/**
 * The pictures of one screen, taken now, as the asker.
 *
 * `view` "all" is a whole how-to: where it is, the screen, the form that
 * opens. Only a screen the asker's role may open is pictured; the way in
 * (signing in, the top bar, the account menu, the password) is everybody's.
 */
export async function showLive(input: {
  readonly principal: Principal;
  readonly userId: string;
  readonly locale: 'en' | 'ar';
  readonly asked: string;
  readonly view: HowToView | 'all';
  readonly dialog?: string | null;
  readonly pointAt?: readonly string[];
}): Promise<{ readonly text: string; readonly images: readonly LiveGuideImage[] }> {
  const ready = howToLiveReady();
  if (!ready.ok) {
    return { text: `No picture can be taken right now: ${ready.reason ?? 'the camera is not available on this server.'} Explain it in words instead — the path (screens), the steps and the fields (guide). Do not describe a picture.`, images: [] };
  }
  const found = resolveScreen(input.principal, input.asked);
  if (!found) {
    return {
      text: `No built screen matches "${input.asked}". Search with the screens tool first, then ask for the picture by its address. Besides the menu's screens there are pictures of: ${EXTRA_SCREENS.map((one) => `"${one}"`).join(', ')}. One record or any other page is pictured with the screenshot tool, by its address.`,
      images: [],
    };
  }
  const locale = input.locale === 'ar' ? 'ar' : 'en';
  const language = locale === 'ar' ? 'Arabic' : 'English';

  // ── the four that are not screens of the menu ──────────────────────────────
  if (found.kind === 'extra') {
    const shot = await liveExtraPicture({ userId: input.userId, locale, which: found.route });
    if (!shot.ok) return { text: `No picture of ${found.en} could be taken: ${shot.reason} Explain it in words (guide).`, images: [] };
    const name = locale === 'ar' ? found.ar : found.en;
    const what =
      found.route === '/sign-in'
        ? 'the sign-in page as everybody meets it — pictured signed out, so nothing of anybody\'s is on it'
        : found.route === 'top-bar'
          ? 'the bar at the top of every screen, as this person has it'
          : found.route === 'user-menu'
            ? 'the menu behind this person\'s initials, open'
            : 'the Change password page';
    return {
      text: [
        `1 LIVE picture of ${found.en} is attached to your answer, in ${language}. Place it where you explain it: write its tag on a line of its own, and what you write under it becomes its caption.`,
        '',
        `[picture: ${tagOf(shot.file)}] — LIVE, ${what}.${numbersLine(shot.marks)}`,
        '',
        'Say what each number is by its name. It is the real system, taken now.',
      ].join(NL),
      images: [{ file: shot.file, caption: `${name}${shot.marks.length > 0 ? ` — ${NUMBERED[locale]}` : ''}`, kind: 'live', group: `how-to:${found.route}` }],
    };
  }

  // ── a screen of the menu ───────────────────────────────────────────────────
  const { entry } = found;
  if (!entry.allowed) return { text: `This person's role cannot open ${entry.en.screen}, so there is no picture of it that is theirs to be shown. Tell them which permission it needs.`, images: [] };
  const names = locale === 'ar' ? entry.ar : entry.en;
  const heading = `${names.module} → ${names.heading} → ${names.screen}`;
  const views: readonly HowToView[] = input.view === 'all' ? ['menu', 'screen', 'form'] : [input.view];

  const images: LiveGuideImage[] = [];
  const lines: string[] = [];
  const missing: string[] = [];
  for (const view of views) {
    let shot: HowToLive;
    if (view === 'dialog') {
      // A window is on the screen itself, or on a record of it: the screen is tried first.
      shot = await liveHowToPicture({ userId: input.userId, locale, route: entry.route, view, dialog: input.dialog ?? '', on: 'screen' });
      if (!shot.ok && (input.dialog ?? '').trim() !== '') {
        const onRecord = await liveHowToPicture({ userId: input.userId, locale, route: entry.route, view, dialog: input.dialog ?? '', on: 'record' });
        // Whichever has it; else what both said, so he knows every window there is.
        shot = onRecord.ok ? onRecord : { ok: false, reason: `On the screen: ${shot.reason} On its first record: ${onRecord.reason}` };
      } else if (!shot.ok) {
        const onRecord = await liveHowToPicture({ userId: input.userId, locale, route: entry.route, view, dialog: '', on: 'record' });
        shot = { ok: false, reason: `On the screen: ${shot.reason} On its first record: ${onRecord.ok ? '' : onRecord.reason}` };
      }
    } else {
      shot = await liveHowToPicture({
        userId: input.userId,
        locale,
        route: entry.route,
        view,
        ...(view === 'menu' ? { moduleTitles: [entry.en.module, entry.ar.module] } : {}),
        ...(view === 'screen' || view === 'record' ? { pointAt: input.pointAt ?? [] } : {}),
      });
    }
    if (!shot.ok) {
      missing.push(`${VIEW_NAMES[view]} — ${shot.reason}`);
      continue;
    }
    lines.push(describe(view, shot));
    images.push({
      file: shot.file,
      caption: `${heading}: ${VIEW_WORDS[view][locale]}${shot.marks.length > 0 ? ` — ${NUMBERED[locale]}` : ''}`,
      kind: 'live',
      group: `how-to:${entry.route}:${view}:${view === 'dialog' ? (input.dialog ?? '') : ''}`,
    });
  }

  if (images.length === 0) {
    return {
      text: [`No picture of ${entry.en.screen} (${entry.route}) could be taken:`, ...missing.map((one) => `• ${one}`), 'Explain it in words instead (guide, screens). Do not describe a picture.'].join(NL),
      images: [],
    };
  }
  return {
    text: [
      `${images.length} LIVE picture(s) of ${entry.en.screen} (${entry.route}) are attached to your answer — the real system as this person sees it right now, in ${language}. Place each one at its step: write its tag on a line of its own, and what you write under it becomes that picture's caption.`,
      '',
      ...lines,
      ...(missing.length > 0 ? ['', 'NOT pictured — explain these in words, and do not say a picture shows them:', ...missing.map((one) => `• ${one}`)] : []),
      '',
      'Refer to a thing by its number and its name as the picture has it; where the arrow is, say so. Every name and figure in these pictures is real and is what this person\'s own screen shows.',
    ].join(NL),
    images,
  };
}
