/**
 * The available appearance presets for individual user accounts.
 *
 * The screens are drawn as the document windows of the accounting package the
 * company already reads. Each user chooses their own palette, so two people
 * can use different looks on the same system and on the same device.
 *
 * Presets rather than free colours, deliberately. Every palette here has been
 * checked as a whole — a title bar against the text on it, a grid rule against
 * the row behind it — and a person choosing at random cannot produce a
 * combination that nobody can read.
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

/** Layout presets are independent of the saved colour palette and accent. */
export const APPEARANCE_PRESETS = [
  'current',
  'standard',
  'enterprise',
  'minimal',
  'modern',
  'command',
  'studio',
] as const;
export type AppearancePreset = (typeof APPEARANCE_PRESETS)[number];

export const DENSITIES = ['comfortable', 'compact', 'spacious', 'airy'] as const;
export type Density = (typeof DENSITIES)[number];

export const CORNER_STYLES = ['soft', 'rounded', 'sharp', 'subtle', 'pill'] as const;
export type CornerStyle = (typeof CORNER_STYLES)[number];

export const CONTENT_WIDTHS = ['fluid', 'contained', 'wide', 'full_width'] as const;
export type ContentWidth = (typeof CONTENT_WIDTHS)[number];

export const BORDER_STYLES = ['none', 'subtle', 'standard', 'strong'] as const;
export type BorderStyle = (typeof BORDER_STYLES)[number];

export const SHADOW_STYLES = ['none', 'subtle', 'soft', 'elevated'] as const;
export type ShadowStyle = (typeof SHADOW_STYLES)[number];

export const COMPONENT_SIZES = ['small', 'medium', 'large'] as const;
export type ComponentSize = (typeof COMPONENT_SIZES)[number];

export interface UserAppearanceSettings {
  readonly appearance: AppearancePreset;
  readonly density: Density;
  readonly cornerStyle: CornerStyle;
  readonly contentWidth: ContentWidth;
  readonly borderStyle: BorderStyle;
  readonly shadow: ShadowStyle;
  readonly componentSize: ComponentSize;
}

export const DEFAULT_USER_APPEARANCE: UserAppearanceSettings = {
  appearance: 'current',
  density: 'comfortable',
  cornerStyle: 'soft',
  contentWidth: 'fluid',
  borderStyle: 'standard',
  shadow: 'soft',
  componentSize: 'medium',
};

/** Selecting a preset applies this starting set; each control stays editable. */
export const APPEARANCE_PRESET_SETTINGS: Readonly<
  Record<AppearancePreset, Omit<UserAppearanceSettings, 'appearance'>>
> = {
  current: {
    density: 'comfortable',
    cornerStyle: 'soft',
    contentWidth: 'fluid',
    borderStyle: 'standard',
    shadow: 'soft',
    componentSize: 'medium',
  },
  standard: {
    density: 'comfortable',
    cornerStyle: 'subtle',
    contentWidth: 'fluid',
    borderStyle: 'standard',
    shadow: 'soft',
    componentSize: 'medium',
  },
  enterprise: {
    density: 'compact',
    cornerStyle: 'sharp',
    contentWidth: 'wide',
    borderStyle: 'strong',
    shadow: 'subtle',
    componentSize: 'small',
  },
  minimal: {
    density: 'spacious',
    cornerStyle: 'sharp',
    contentWidth: 'contained',
    borderStyle: 'none',
    shadow: 'none',
    componentSize: 'medium',
  },
  modern: {
    density: 'comfortable',
    cornerStyle: 'rounded',
    contentWidth: 'wide',
    borderStyle: 'subtle',
    shadow: 'soft',
    componentSize: 'medium',
  },
  command: {
    density: 'compact',
    cornerStyle: 'sharp',
    contentWidth: 'full_width',
    borderStyle: 'strong',
    shadow: 'none',
    componentSize: 'small',
  },
  studio: {
    density: 'airy',
    cornerStyle: 'rounded',
    contentWidth: 'contained',
    borderStyle: 'subtle',
    shadow: 'elevated',
    componentSize: 'large',
  },
};

/** Accepts only complete, known settings from the browser or a server action. */
export function parseUserAppearanceSettings(input: unknown): UserAppearanceSettings {
  if (!input || typeof input !== 'object') throw new Error('Appearance settings are invalid.');
  const values = input as Record<string, unknown>;
  const choices = {
    appearance: APPEARANCE_PRESETS,
    density: DENSITIES,
    cornerStyle: CORNER_STYLES,
    contentWidth: CONTENT_WIDTHS,
    borderStyle: BORDER_STYLES,
    shadow: SHADOW_STYLES,
    componentSize: COMPONENT_SIZES,
  } as const;

  for (const [field, allowed] of Object.entries(choices)) {
    if (typeof values[field] !== 'string' || !(allowed as readonly string[]).includes(values[field] as string)) {
      throw new Error(`Unknown ${field} appearance setting.`);
    }
  }

  return {
    appearance: values.appearance as AppearancePreset,
    density: values.density as Density,
    cornerStyle: values.cornerStyle as CornerStyle,
    contentWidth: values.contentWidth as ContentWidth,
    borderStyle: values.borderStyle as BorderStyle,
    shadow: values.shadow as ShadowStyle,
    componentSize: values.componentSize as ComponentSize,
  };
}
