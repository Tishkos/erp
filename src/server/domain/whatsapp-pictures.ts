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
}

export interface AnswerPart {
  readonly text: string;
  readonly picture: Picture | null;
}

/** WhatsApp cuts a caption at 1,024 characters; longer words go under the picture as their own message. */
export const CAPTION_MAX = 900;

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

  const out: AnswerPart[] = [];
  for (const part of parts) {
    const text = tidy(part.lines);
    if (!part.picture) {
      if (text) out.push({ text, picture: null });
      continue;
    }
    if (!text) {
      out.push({ text: part.picture.caption, picture: part.picture });
    } else if (text.length <= CAPTION_MAX) {
      out.push({ text, picture: part.picture });
    } else {
      // Too long to sit under a picture: the picture with what it shows, then the words.
      out.push({ text: part.picture.caption, picture: part.picture });
      out.push({ text, picture: null });
    }
  }
  for (const picture of waiting.values()) out.push({ text: picture.caption, picture });

  return { text: tidy(kept), parts: out };
}
