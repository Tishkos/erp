/**
 * Just enough of the Unicode bidirectional algorithm to set a line of a
 * printed document.
 *
 * The PDF library shapes Arabic — it joins the letters and turns an Arabic run
 * into visual order — but it lays out a whole string as one run of one script.
 * Handed "المجموع 1,250,000" it reverses the figure along with the words and
 * swaps its digits for Arabic-Indic ones: a total that reads 000,052,1. So a
 * line is cut into runs first, each run is one direction, and the runs are
 * placed in visual order here; the library only ever sees a run it can lay out
 * correctly on its own.
 *
 * What this covers is what the documents contain: Arabic words, Latin words,
 * figures, codes like ITM-000001, dates, and the punctuation between them. It
 * is two levels (the paragraph's and one inside it), which is the whole of
 * what a line of a voucher needs; it is not a general UBA and does not pretend
 * to be. The direction marks Intl puts into Arabic figures (RLM, LRM) are read
 * for their direction and then dropped, because the embedded font has no glyph
 * for them and a mark drawn as a box is exactly the broken glyph a printed
 * document must not show.
 */

export type Direction = 'ltr' | 'rtl';

export interface Run {
  readonly text: string;
  readonly direction: Direction;
}

type Strength = 'R' | 'L' | 'N';

const RLM = 0x200f;
const LRM = 0x200e;
const ALM = 0x061c;

/** Formatting characters that carry direction or nothing, and have no glyph. */
const INVISIBLE = /[‎‏؜‪-‮⁦-⁩﻿]/g;

function isArabicDigit(cp: number): boolean {
  return (cp >= 0x0660 && cp <= 0x0669) || (cp >= 0x06f0 && cp <= 0x06f9);
}

function isRightToLeft(cp: number): boolean {
  if (isArabicDigit(cp)) return false;
  // The Arabic comma is a separator, not a letter.
  if (cp === 0x060c) return false;
  return (
    (cp >= 0x0590 && cp <= 0x08ff) ||
    (cp >= 0xfb1d && cp <= 0xfdff) ||
    (cp >= 0xfe70 && cp <= 0xfeff)
  );
}

function strengthOf(char: string): Strength {
  const cp = char.codePointAt(0)!;
  if (cp === RLM || cp === ALM) return 'R';
  if (cp === LRM) return 'L';
  if (isRightToLeft(cp)) return 'R';
  // Digits of either script run left to right, and so does every letter
  // that is not right-to-left.
  if (/[0-9]/.test(char) || isArabicDigit(cp) || /\p{L}/u.test(char)) return 'L';
  return 'N';
}

/** The direction of the first strong character, or the fallback. */
export function directionOf(text: string, fallback: Direction = 'ltr'): Direction {
  for (const char of text) {
    const strength = strengthOf(char);
    if (strength === 'R') return 'rtl';
    if (strength === 'L') return 'ltr';
  }
  return fallback;
}

/** Whether the text holds anything that reads right to left. */
export function hasRightToLeft(text: string): boolean {
  for (const char of text) if (strengthOf(char) === 'R') return true;
  return false;
}

const MIRROR: Readonly<Record<string, string>> = {
  '(': ')',
  ')': '(',
  '[': ']',
  ']': '[',
  '{': '}',
  '}': '{',
  '<': '>',
  '>': '<',
  '«': '»',
  '»': '«',
};

/**
 * Cut one line into directional runs, in visual (left-to-right drawing) order.
 *
 * Neutral characters — spaces, punctuation — take the direction of the strong
 * characters on both sides when those agree, and the paragraph's otherwise:
 * the space inside "Sales Invoice" is Latin, the space between an Arabic word
 * and a figure belongs to the Arabic sentence.
 *
 * A right-to-left run is returned in logical order with its brackets
 * mirrored; the shaping engine reverses it when it lays it out. The one
 * exception is a right-to-left run with no right-to-left letter in it (a lone
 * dash between two Arabic words at a line's edge): the engine would not know
 * to reverse that, so it is reversed here.
 */
export function visualRuns(line: string, paragraph: Direction): Run[] {
  const chars = Array.from(line);
  const strengths = chars.map(strengthOf);
  const base: Strength = paragraph === 'rtl' ? 'R' : 'L';

  const resolved = strengths.map((strength, index) => {
    if (strength !== 'N') return strength;
    let before: Strength = base;
    for (let i = index - 1; i >= 0; i -= 1) {
      if (strengths[i] !== 'N') {
        before = strengths[i]!;
        break;
      }
    }
    let after: Strength = base;
    for (let i = index + 1; i < strengths.length; i += 1) {
      if (strengths[i] !== 'N') {
        after = strengths[i]!;
        break;
      }
    }
    return before === after ? before : base;
  });

  const logical: { text: string; direction: Direction }[] = [];
  chars.forEach((char, index) => {
    const direction: Direction = resolved[index] === 'R' ? 'rtl' : 'ltr';
    const last = logical[logical.length - 1];
    if (last && last.direction === direction) last.text += char;
    else logical.push({ text: char, direction });
  });

  const runs = logical
    .map((run) => ({ ...run, text: run.text.replace(INVISIBLE, '').replace(/ /g, ' ') }))
    .filter((run) => run.text.length > 0)
    .map((run): Run => {
      if (run.direction === 'ltr') {
        // Arabic-Indic digits alone read as Arabic script to the shaper,
        // which would reverse them; hand them over pre-reversed.
        const arabicScript = Array.from(run.text).some((c) => isArabicDigit(c.codePointAt(0)!));
        const latinLetters = /[A-Za-z]/.test(run.text);
        return arabicScript && !latinLetters
          ? { text: Array.from(run.text).reverse().join(''), direction: 'ltr' }
          : run;
      }
      const mirrored = Array.from(run.text)
        .map((char) => MIRROR[char] ?? char)
        .join('');
      return hasRightToLeft(mirrored)
        ? { text: mirrored, direction: 'rtl' }
        : { text: Array.from(mirrored).reverse().join(''), direction: 'rtl' };
    });

  return paragraph === 'rtl' ? runs.reverse() : runs;
}

/** The text without the invisible direction marks — what is actually drawn. */
export function printable(text: string): string {
  return text.replace(INVISIBLE, '').replace(/ /g, ' ');
}
