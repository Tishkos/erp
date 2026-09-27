/**
 * How the application looks — the company's choice, not a personal one.
 *
 * The screens are drawn as the document windows of the accounting package the
 * company already reads. Which palette those windows wear is decided once, for
 * everybody, because two people describing the same screen to each other
 * should be looking at the same screen.
 *
 * Presets rather than free colours, deliberately. Every palette here has been
 * checked as a whole — a title bar against the text on it, a grid rule against
 * the row behind it — and a person choosing at random cannot produce a
 * combination that nobody can read. On a company-wide setting one illegible
 * choice is everybody's problem, and the person who made it is rarely the one
 * who has to work in it all day.
 *
 * No framework imports: the list is the same one the migration's check
 * constraint enforces and the stylesheet defines, so all three can be compared
 * by eye.
 */

export const PALETTES = [
  'sand', 'classic', 'slate', 'graphite', 'pearl',
  'ivory_linen', 'glacier', 'sage_white', 'porcelain_rose',
  'dune_bronze', 'harbor_mist',
  'midnight', 'carbon', 'ocean',
  'obsidian_plum', 'evergreen', 'espresso', 'lunar_slate',
] as const;
export type Palette = (typeof PALETTES)[number];

/** What the installation wears until somebody chooses otherwise. */
export const DEFAULT_PALETTE: Palette = 'sand';

export function isPalette(value: string): value is Palette {
  return (PALETTES as readonly string[]).includes(value);
}

export class UnknownPaletteError extends Error {
  readonly code = 'UNKNOWN_PALETTE';
  constructor(value: string) {
    super(
      `'${value}' is not a palette this system defines. ` +
        `Choose one of: ${PALETTES.join(', ')}.`,
    );
    this.name = 'UnknownPaletteError';
  }
}

/**
 * Reads a stored value into a palette.
 *
 * Falls back rather than throwing. A palette is decoration: if the column
 * somehow holds something unknown, the right outcome is a system that looks
 * ordinary, not a system nobody can open. The write path refuses the same
 * value loudly, which is where a bad one should be caught.
 */
export function paletteOrDefault(value: string | null | undefined): Palette {
  return value && isPalette(value) ? value : DEFAULT_PALETTE;
}

/**
 * Refuses a palette the stylesheet does not define — the write-path gate.
 *
 * The database check constraint says the same thing, and says it for a caller
 * that never comes through this service. This exists so the refusal a person
 * reads names the choices, rather than quoting a constraint.
 */
export function assertPalette(value: string): asserts value is Palette {
  if (!isPalette(value)) throw new UnknownPaletteError(value);
}

/**
 * The accents — the one colour that marks pressed, selected and actionable.
 *
 * 'gold' is the accounting package's own amber and each palette defines it
 * for itself, so gold is expressed as the absence of an override rather than
 * as a fifth definition that could drift from four others.
 */
export const ACCENTS = ['gold', 'red', 'blue', 'green', 'purple'] as const;
export type Accent = (typeof ACCENTS)[number];

export const DEFAULT_ACCENT: Accent = 'gold';

export function isAccent(value: string): value is Accent {
  return (ACCENTS as readonly string[]).includes(value);
}

export class UnknownAccentError extends Error {
  readonly code = 'UNKNOWN_ACCENT';
  constructor(value: string) {
    super(
      `'${value}' is not an accent this system defines. ` +
        `Choose one of: ${ACCENTS.join(', ')}.`,
    );
    this.name = 'UnknownAccentError';
  }
}

/** Reads a stored value into an accent — falls back, like the palette. */
export function accentOrDefault(value: string | null | undefined): Accent {
  return value && isAccent(value) ? value : DEFAULT_ACCENT;
}

export function assertAccent(value: string): asserts value is Accent {
  if (!isAccent(value)) throw new UnknownAccentError(value);
}
