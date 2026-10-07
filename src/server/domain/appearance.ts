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

/*
 * Navigation and reading (2026-10-06, by direction: "in settings, make sure
 * you can move the navbar to a side panel, with icons, nicely … user side view
 * / top view, a lot of customization", then "navbar in bottom … make
 * customization so good"). Where the modules are, how large the text is, and
 * the few switches a person wants for their own eyes. A preset never changes
 * these (`APPEARANCE_PRESET_SETTINGS` does not name them): a style is how the
 * screens look, these are how this person works.
 */

/** Where the modules are: the top bar (as always), a side panel, or a dock at the bottom. */
export const NAVIGATION_LAYOUTS = ['top', 'side', 'bottom'] as const;
export type NavigationLayout = (typeof NAVIGATION_LAYOUTS)[number];

/** The side panel and the bottom bar: each module's icon with its name, or the icon alone. */
export const SIDEBAR_STYLES = ['full', 'icons'] as const;
export type SidebarStyle = (typeof SIDEBAR_STYLES)[number];

/** The side panel lists the modules under their group headings (`domain/modules.ts` › group), or as one list. 0417. */
export const SIDEBAR_GROUPINGS = ['grouped', 'plain'] as const;
export type SidebarGrouping = (typeof SIDEBAR_GROUPINGS)[number];

/**
 * The side panel's colour (2026-10-07, by direction: "left panel colour change
 * to highlight colour … I need that option"): the page's own surface, a soft
 * wash of the accent, or the accent itself. The panel and its icons-only rail;
 * the top bar is not touched. 0418.
 */
export const SIDEBAR_COLOURS = ['default', 'highlight', 'accent'] as const;
export type SidebarColour = (typeof SIDEBAR_COLOURS)[number];

/** The root's size — 85%, 90% (the system's own, by direction 2026-10-06) or 100%; everything is in rem. */
export const TEXT_SIZES = ['smaller', 'default', 'larger'] as const;
export type TextSize = (typeof TEXT_SIZES)[number];

/** The top bar stays in view while the page scrolls, or scrolls away with it. */
export const HEADER_BEHAVIOURS = ['sticky', 'static'] as const;
export type HeaderBehaviour = (typeof HEADER_BEHAVIOURS)[number];

/** Menus, sheets and highlights move, or appear at once. */
export const MOTION_STYLES = ['full', 'reduced'] as const;
export type MotionStyle = (typeof MOTION_STYLES)[number];

/** Every other row of a table tinted (the application's own), or none. */
export const TABLE_STRIPES = ['on', 'off'] as const;
export type TableStripes = (typeof TABLE_STRIPES)[number];

/** What a preset sets — the seven settings there have always been. */
export interface UserLayoutSettings {
  readonly appearance: AppearancePreset;
  readonly density: Density;
  readonly cornerStyle: CornerStyle;
  readonly contentWidth: ContentWidth;
  readonly borderStyle: BorderStyle;
  readonly shadow: ShadowStyle;
  readonly componentSize: ComponentSize;
}

/** What no preset touches. */
export interface UserNavigationSettings {
  readonly navigation: NavigationLayout;
  readonly sidebar: SidebarStyle;
  readonly sidebarGroups: SidebarGrouping;
  readonly sidebarColour: SidebarColour;
  readonly textSize: TextSize;
  readonly header: HeaderBehaviour;
  readonly motion: MotionStyle;
  readonly tableStripes: TableStripes;
}

export interface UserAppearanceSettings extends UserLayoutSettings, UserNavigationSettings {}

/** The seven layout settings, in the order the columns were added (0220). */
export const LAYOUT_SETTING_NAMES = [
  'appearance', 'density', 'cornerStyle', 'contentWidth', 'borderStyle', 'shadow', 'componentSize',
] as const satisfies readonly (keyof UserLayoutSettings)[];

/** The navigation and reading settings (0407; the side panel's grouping 0417, its colour 0418). */
export const NAVIGATION_SETTING_NAMES = [
  'navigation', 'sidebar', 'sidebarGroups', 'sidebarColour', 'textSize', 'header', 'motion', 'tableStripes',
] as const satisfies readonly (keyof UserNavigationSettings)[];

export const DEFAULT_USER_NAVIGATION: UserNavigationSettings = {
  navigation: 'top',
  sidebar: 'full',
  sidebarGroups: 'grouped',
  sidebarColour: 'default',
  textSize: 'default',
  header: 'sticky',
  motion: 'full',
  tableStripes: 'on',
};

export const DEFAULT_USER_APPEARANCE: UserAppearanceSettings = {
  appearance: 'current',
  density: 'comfortable',
  cornerStyle: 'soft',
  contentWidth: 'fluid',
  borderStyle: 'standard',
  shadow: 'soft',
  componentSize: 'medium',
  ...DEFAULT_USER_NAVIGATION,
};

/** Selecting a preset applies this starting set; each control stays editable. */
export const APPEARANCE_PRESET_SETTINGS: Readonly<
  Record<AppearancePreset, Omit<UserLayoutSettings, 'appearance'>>
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

/** Every setting's choices — the same lists 0220's, 0407's, 0417's and 0418's check constraints hold. */
export const APPEARANCE_CHOICES = {
  appearance: APPEARANCE_PRESETS,
  density: DENSITIES,
  cornerStyle: CORNER_STYLES,
  contentWidth: CONTENT_WIDTHS,
  borderStyle: BORDER_STYLES,
  shadow: SHADOW_STYLES,
  componentSize: COMPONENT_SIZES,
  navigation: NAVIGATION_LAYOUTS,
  sidebar: SIDEBAR_STYLES,
  sidebarGroups: SIDEBAR_GROUPINGS,
  sidebarColour: SIDEBAR_COLOURS,
  textSize: TEXT_SIZES,
  header: HEADER_BEHAVIOURS,
  motion: MOTION_STYLES,
  tableStripes: TABLE_STRIPES,
} as const satisfies { readonly [Name in keyof UserAppearanceSettings]: readonly UserAppearanceSettings[Name][] };

function known(field: keyof UserAppearanceSettings, value: unknown): boolean {
  return typeof value === 'string' && (APPEARANCE_CHOICES[field] as readonly string[]).includes(value);
}

/**
 * Accepts only known settings from the browser or a server action.
 *
 * The seven layout settings must all be there, as they always had to be. The
 * navigation settings came later (0407): one the caller leaves out is taken
 * from `fallback` — the person's stored choice, when the service calls this —
 * so a page opened before they existed cannot put somebody's side panel back
 * in the top bar by saving its density. One that is there and unknown is
 * refused like any other.
 */
export function parseUserAppearanceSettings(
  input: unknown,
  fallback: UserNavigationSettings = DEFAULT_USER_NAVIGATION,
): UserAppearanceSettings {
  if (!input || typeof input !== 'object') throw new Error('Appearance settings are invalid.');
  const values = input as Record<string, unknown>;

  for (const field of LAYOUT_SETTING_NAMES) {
    if (!known(field, values[field])) throw new Error(`Unknown ${field} appearance setting.`);
  }
  for (const field of NAVIGATION_SETTING_NAMES) {
    if (values[field] !== undefined && !known(field, values[field])) {
      throw new Error(`Unknown ${field} appearance setting.`);
    }
  }
  const pick = <Name extends keyof UserNavigationSettings>(field: Name): UserNavigationSettings[Name] =>
    (values[field] === undefined ? fallback[field] : values[field]) as UserNavigationSettings[Name];

  return {
    appearance: values.appearance as AppearancePreset,
    density: values.density as Density,
    cornerStyle: values.cornerStyle as CornerStyle,
    contentWidth: values.contentWidth as ContentWidth,
    borderStyle: values.borderStyle as BorderStyle,
    shadow: values.shadow as ShadowStyle,
    componentSize: values.componentSize as ComponentSize,
    navigation: pick('navigation'),
    sidebar: pick('sidebar'),
    sidebarGroups: pick('sidebarGroups'),
    sidebarColour: pick('sidebarColour'),
    textSize: pick('textSize'),
    header: pick('header'),
    motion: pick('motion'),
    tableStripes: pick('tableStripes'),
  };
}

// ---------------------------------------------------------------------------
// Everyone's default (0419)
// ---------------------------------------------------------------------------

/**
 * The company's default appearance (2026-10-07, by direction: "I want my
 * current setup to be the main default setup for everyone"): what a person who
 * has not chosen their own sees. Stored whole as `company.ui_defaults`; NULL is
 * the built-in default (`DEFAULT_USER_APPEARANCE`, Sand and Gold), which fresh
 * installs and the test databases keep.
 */
export interface CompanyAppearanceDefaults extends UserAppearanceSettings {
  readonly palette: Palette;
  readonly accent: Accent;
}

/** Every key the company default holds — the list 0419's check constraint holds. */
export const COMPANY_DEFAULT_NAMES = [
  'palette',
  'accent',
  ...LAYOUT_SETTING_NAMES,
  ...NAVIGATION_SETTING_NAMES,
] as const satisfies readonly (keyof CompanyAppearanceDefaults)[];

const COMPANY_DEFAULT_CHOICES: { readonly [Name in keyof CompanyAppearanceDefaults]: readonly string[] } = {
  ...APPEARANCE_CHOICES,
  palette: PALETTES,
  accent: ACCENTS,
};

/** The built-in default as a company default would say it. */
export const BUILT_IN_COMPANY_DEFAULTS: CompanyAppearanceDefaults = {
  ...DEFAULT_USER_APPEARANCE,
  palette: DEFAULT_PALETTE,
  accent: DEFAULT_ACCENT,
};

/** The company default as written: every key, every value known — refused otherwise. */
export function parseCompanyDefaults(input: unknown): CompanyAppearanceDefaults {
  if (!input || typeof input !== 'object') throw new Error('The company default appearance is invalid.');
  const values = input as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const name of COMPANY_DEFAULT_NAMES) {
    const value = values[name];
    if (typeof value !== 'string' || !COMPANY_DEFAULT_CHOICES[name].includes(value)) {
      throw new Error(`Unknown ${name} appearance setting.`);
    }
    out[name] = value;
  }
  return out as unknown as CompanyAppearanceDefaults;
}

/**
 * The company default as stored, read leniently: a key the code no longer
 * knows, or a value it does not, is left out (the built-in stands in for it),
 * so an old row never breaks a page. Null when there is none.
 */
export function readCompanyDefaults(stored: unknown): Partial<CompanyAppearanceDefaults> | null {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;
  const values = stored as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const name of COMPANY_DEFAULT_NAMES) {
    const value = values[name];
    if (typeof value === 'string' && COMPANY_DEFAULT_CHOICES[name].includes(value)) out[name] = value;
  }
  return Object.keys(out).length > 0 ? (out as Partial<CompanyAppearanceDefaults>) : null;
}

type OwnRow = { readonly [Name in keyof UserAppearanceSettings]?: string | null };

/**
 * Whether a person has chosen an appearance of their own.
 *
 * Every column NULL is plainly "never chosen". But until 0419 the first page a
 * person opened wrote the built-in values into their row (adopting the
 * browser's old choices, 0220), so a row holding nothing but the built-in
 * values is read as "not chosen" too — otherwise everyone who had merely
 * signed in would be out of reach of the company's default. A person who
 * changed even one setting has chosen, and keeps all of theirs.
 */
export function choseOwnAppearance(row: OwnRow): boolean {
  return (Object.keys(DEFAULT_USER_APPEARANCE) as (keyof UserAppearanceSettings)[]).some((name) => {
    const value = row[name];
    return value !== null && value !== undefined && value !== DEFAULT_USER_APPEARANCE[name];
  });
}

/**
 * What a person sees, setting by setting: their own choice, else the
 * company's default, else the built-in one. A person who has not chosen
 * (`choseOwnAppearance`) sees the company's default whole.
 */
export function effectiveAppearance(
  row: OwnRow,
  company: Partial<CompanyAppearanceDefaults> | null,
): UserAppearanceSettings {
  const own = choseOwnAppearance(row);
  const out = {} as Record<keyof UserAppearanceSettings, string>;
  for (const name of Object.keys(DEFAULT_USER_APPEARANCE) as (keyof UserAppearanceSettings)[]) {
    const mine = own ? row[name] : null;
    const value = mine && known(name, mine) ? mine : (company?.[name] ?? DEFAULT_USER_APPEARANCE[name]);
    out[name] = value;
  }
  return out as unknown as UserAppearanceSettings;
}

/** The palette and accent a person sees: their own, else the company's default, else Sand and Gold. */
export function effectiveColours(
  own: { readonly palette?: string | null; readonly accent?: string | null },
  company: Partial<CompanyAppearanceDefaults> | null,
): { readonly palette: Palette; readonly accent: Accent } {
  return {
    palette: own.palette && isPalette(own.palette) ? own.palette : (company?.palette ?? DEFAULT_PALETTE),
    accent: own.accent && isAccent(own.accent) ? own.accent : (company?.accent ?? DEFAULT_ACCENT),
  };
}
