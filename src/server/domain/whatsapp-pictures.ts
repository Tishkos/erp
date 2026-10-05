/**
 * Where each picture goes in an answer — 2026-10-04, by direction: "if an
 * action requires a few images let the user know: step 1, look at this
 * screenshot where I point out, do that, write that in that input".
 *
 * Noah attaches pictures of a screen (`show_screen`) and writes his answer. A
 * picture sent after a long message is a picture the reader has to match to a
 * step by guessing, so he places each one himself: a tag on a line of its own,
 *
 *     [picture: payables_suppliers-menu]
 *     *Step 1* — open Payables in the top bar and click Suppliers, ringed in red.
 *
 * and what he writes under the tag, up to the next tag, is sent as that
 * picture's caption. The chat then reads step, picture, step, picture — each
 * instruction beside the thing it points at.
 *
 * Pure: text and names in, an ordered list out. The files are read, and the
 * messages sent, elsewhere.
 */

export interface Picture {
  /** The file on this host. */
  readonly file: string;
  /** What it shows, in the asker's language — the caption when he writes none. */
  readonly caption: string;
  /**
   * Whose data it shows: `training` — made ahead of time from the training
   * copy, sample data; `live` — the real system as the asker sees it, taken
   * now. A picture that says which it is cannot be taken for the other.
   */
  readonly kind?: 'training' | 'live';
}

export interface AnswerPart {
  readonly text: string;
  readonly picture: Picture | null;
}

/** WhatsApp cuts a caption at 1,024 characters; longer words go under the picture as their own message. */
export const CAPTION_MAX = 900;

/**
 * The language a picture is shown in. A person who writes "show me in arabic"
 * has written in English, so the language of their message is not the
 * language they asked for (2026-10-05: an Arabic explanation arrived under an
 * English picture, with advice to switch the language oneself). Their own
 * words decide first, then what the model asked for — the language he is
 * answering in — then the language of the conversation.
 */
export function pictureLanguage(asked: unknown, question: string | null | undefined, fallback: 'en' | 'ar'): 'en' | 'ar' {
  const said = (question ?? '').toLowerCase();
  const wantsArabic = /\b(in|into|to)\s+arabic\b|\barabic\s+(version|picture|pictures|screen|screenshot|one|please)\b|بالعربي|باللغة العربية|عربي/.test(said);
  const wantsEnglish = /\b(in|into|to)\s+english\b|\benglish\s+(version|picture|pictures|screen|screenshot|one|please)\b|ب?ال[اإ]ن[كج]ليزي|باللغة ال[اإ]ن[كج]ليزية|[اإ]ن[كج]ليزي/.test(said);
  if (wantsArabic !== wantsEnglish) return wantsArabic ? 'ar' : 'en';
  if (asked === 'ar' || asked === 'en') return asked;
  return fallback;
}

/** Is this written mostly in the Arabic script? Field names quoted in English inside an Arabic answer do not make it English. */
function mostlyArabic(text: string): boolean {
  const arabic = (text.match(/[\u0600-\u06ff]/g) ?? []).length;
  const latin = (text.match(/[a-z]/gi) ?? []).length;
  return arabic > 0 && arabic * 2 >= latin;
}

/**
 * The small line under a picture that says whose data it shows — by
 * direction, 2026-10-05: "if the image comes from training, say that little
 * note: this image came during the training session, not real current data".
 * It is added to the caption here, not left to the model to remember.
 */
export function kindNote(kind: 'training' | 'live', arabic: boolean): string {
  if (kind === 'training') {
    return arabic
      ? 'ℹ️ _صورة تدريبية: أُخذت أثناء التدريب ببيانات نموذجية — ليست بياناتكم الحقيقية الحالية._'
      : 'ℹ️ _Training picture: taken during the training session with sample data — not your real, current data._';
  }
  return arabic ? '🟢 _صورة حيّة: شاشتكم الحقيقية كما هي الآن._' : '🟢 _Live picture: your real screen as it is right now._';
}

/** A picture's tag: its file's name without the folder or the extension. */
export function pictureId(file: string): string {
  return file
    .replace(/^.*[\\/]/, '')
    .replace(/\.[a-z0-9]+$/i, '')
    .toLowerCase();
}

/** `[picture: <id>]` alone on a line; `[pic …]` and `[صورة …]` are read too. */
const TAG = /^[ \t>*_-]*\[\s*(?:picture|pic|image|صورة|صوره)\s*[:：-]?\s*([^\]\r\n]+?)\s*\][ \t*_.:،-]*$/i;

const tidy = (lines: readonly string[]) =>
  lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/**
 * The answer as the messages it will be sent as, in order.
 *
 * A tag that names no attached picture — or one already placed — is dropped
 * without a trace, so a stray tag is never shown to the group. A picture he
 * attached and did not place is sent at the end under its own caption: an
 * attached picture is never lost. `text` is the whole answer without the
 * tags, which is what the log keeps.
 */
export function layOutAnswer(answer: string, pictures: readonly Picture[]): { readonly text: string; readonly parts: readonly AnswerPart[] } {
  const waiting = new Map(pictures.map((picture) => [pictureId(picture.file), picture] as const));
  const parts: { lines: string[]; picture: Picture | null }[] = [{ lines: [], picture: null }];
  const kept: string[] = [];

  for (const line of answer.split(/\r?\n/)) {
    const tag = TAG.exec(line);
    if (!tag) {
      parts[parts.length - 1]!.lines.push(line);
      kept.push(line);
      continue;
    }
    const id = pictureId(tag[1] ?? '');
    const picture = waiting.get(id);
    if (!picture) continue;
    waiting.delete(id);
    parts.push({ lines: [], picture });
  }

  // The note under a picture is in the language the answer is written in.
  const arabic = mostlyArabic(tidy(kept));
  const under = (words: string, picture: Picture) => (picture.kind ? `${words}\n\n${kindNote(picture.kind, words.trim() === '' ? arabic : arabic || mostlyArabic(words))}` : words);

  const out: AnswerPart[] = [];
  for (const part of parts) {
    const text = tidy(part.lines);
    if (!part.picture) {
      if (text) out.push({ text, picture: null });
      continue;
    }
    if (!text) {
      out.push({ text: under(part.picture.caption, part.picture), picture: part.picture });
    } else if (text.length <= CAPTION_MAX) {
      out.push({ text: under(text, part.picture), picture: part.picture });
    } else {
      // Too long to sit under a picture: the picture with what it shows, then the words.
      out.push({ text: under(part.picture.caption, part.picture), picture: part.picture });
      out.push({ text, picture: null });
    }
  }
  for (const picture of waiting.values()) out.push({ text: under(picture.caption, picture), picture });

  return { text: tidy(kept), parts: out };
}
