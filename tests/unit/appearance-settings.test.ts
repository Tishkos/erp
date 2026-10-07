import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ACCENTS,
  APPEARANCE_CHOICES,
  APPEARANCE_PRESET_SETTINGS,
  APPEARANCE_PRESETS,
  BUILT_IN_COMPANY_DEFAULTS,
  COMPANY_DEFAULT_NAMES,
  DEFAULT_USER_APPEARANCE,
  DEFAULT_USER_NAVIGATION,
  LAYOUT_SETTING_NAMES,
  NAVIGATION_SETTING_NAMES,
  PALETTES,
  choseOwnAppearance,
  effectiveAppearance,
  effectiveColours,
  parseCompanyDefaults,
  parseUserAppearanceSettings,
  readCompanyDefaults,
} from '@/server/domain/appearance';
import { MODULE_GROUPS, MODULES } from '@/server/domain/modules';
import { LIVE_SHOT_AGENT } from '@/server/services/live-screenshot';

describe('additive appearance settings', () => {
  it('keeps Current identical to the existing defaults', () => {
    expect({ ...DEFAULT_USER_APPEARANCE, appearance: 'current', ...APPEARANCE_PRESET_SETTINGS.current }).toEqual(
      DEFAULT_USER_APPEARANCE,
    );
  });

  it('defines all seven requested presets without coupling them to color palettes', () => {
    expect(APPEARANCE_PRESETS).toEqual([
      'current', 'standard', 'enterprise', 'minimal', 'modern', 'command', 'studio',
    ]);
    expect(new Set(Object.keys(APPEARANCE_PRESET_SETTINGS))).toEqual(new Set(APPEARANCE_PRESETS));
  });

  it('accepts complete known settings and rejects unknown or partial values', () => {
    expect(parseUserAppearanceSettings(DEFAULT_USER_APPEARANCE)).toEqual(DEFAULT_USER_APPEARANCE);
    expect(() => parseUserAppearanceSettings({ ...DEFAULT_USER_APPEARANCE, density: 'ultra' })).toThrow(
      /Unknown density/,
    );
    expect(() => parseUserAppearanceSettings({ appearance: 'modern' })).toThrow(/Unknown density/);
  });
});

describe('navigation and reading settings (0407)', () => {
  const layoutOnly = Object.fromEntries(LAYOUT_SETTING_NAMES.map((name) => [name, DEFAULT_USER_APPEARANCE[name]]));

  it('offers the top bar, the side panel and the bottom bar, the top bar by default', () => {
    expect(APPEARANCE_CHOICES.navigation).toEqual(['top', 'side', 'bottom']);
    expect(APPEARANCE_CHOICES.sidebar).toEqual(['full', 'icons']);
    expect(APPEARANCE_CHOICES.sidebarGroups).toEqual(['grouped', 'plain']);
    expect(APPEARANCE_CHOICES.sidebarColour).toEqual(['default', 'highlight', 'accent']);
    expect(APPEARANCE_CHOICES.textSize).toEqual(['smaller', 'default', 'larger']);
    expect(DEFAULT_USER_NAVIGATION).toEqual({
      navigation: 'top',
      sidebar: 'full',
      sidebarGroups: 'grouped',
      sidebarColour: 'default',
      textSize: 'default',
      header: 'sticky',
      motion: 'full',
      tableStripes: 'on',
    });
  });

  it('is never changed by a preset', () => {
    for (const preset of APPEARANCE_PRESETS) {
      for (const name of NAVIGATION_SETTING_NAMES) {
        expect(Object.keys(APPEARANCE_PRESET_SETTINGS[preset]), `${preset} names ${name}`).not.toContain(name);
      }
    }
  });

  it('keeps the stored choice for a setting a caller leaves out, and refuses an unknown one', () => {
    const stored = { ...DEFAULT_USER_NAVIGATION, navigation: 'side', sidebar: 'icons', sidebarColour: 'accent', tableStripes: 'off' } as const;
    // A page opened before 0407 sends the seven layout settings only.
    expect(parseUserAppearanceSettings(layoutOnly, stored)).toEqual({ ...layoutOnly, ...stored });
    expect(parseUserAppearanceSettings(layoutOnly)).toEqual(DEFAULT_USER_APPEARANCE);
    expect(parseUserAppearanceSettings({ ...layoutOnly, navigation: 'bottom' }, stored).navigation).toBe('bottom');
    expect(() => parseUserAppearanceSettings({ ...layoutOnly, navigation: 'left' })).toThrow(/Unknown navigation/);
    expect(() => parseUserAppearanceSettings({ ...layoutOnly, textSize: 'huge' })).toThrow(/Unknown textSize/);
    expect(() => parseUserAppearanceSettings({ ...layoutOnly, tableStripes: true })).toThrow(/Unknown tableStripes/);
    expect(() => parseUserAppearanceSettings({ ...layoutOnly, sidebarColour: 'purple' })).toThrow(/Unknown sidebarColour/);
    expect(parseUserAppearanceSettings({ ...layoutOnly, sidebarColour: 'highlight' }, stored).sidebarColour).toBe('highlight');
  });

  it('holds the database to the same lists (migrations 0407, 0417 and 0418)', () => {
    const sql = ['0407_navigation_appearance', '0417_side_panel_groups', '0418_side_panel_colour']
      .map((file) => readFileSync(`src/server/db/migrations/${file}.sql`, 'utf8'))
      .join('\n');
    const columns = {
      navigation: 'ui_navigation',
      sidebar: 'ui_sidebar',
      sidebarGroups: 'ui_sidebar_groups',
      sidebarColour: 'ui_sidebar_colour',
      textSize: 'ui_text_size',
      header: 'ui_header',
      motion: 'ui_motion',
      tableStripes: 'ui_table_stripes',
    } as const;
    for (const name of NAVIGATION_SETTING_NAMES) {
      const column = columns[name];
      const found = new RegExp(`CHECK \\(${column} IS NULL OR ${column} IN \\(([^)]*)\\)\\)`).exec(sql);
      expect(found, column).not.toBeNull();
      const listed = found![1]!.split(',').map((value) => value.trim().replace(/^'|'$/g, ''));
      expect(listed, column).toEqual([...APPEARANCE_CHOICES[name]]);
    }
  });

  it('puts every module in one group of the side panel, the groups in the menu\'s order, each labelled in both languages', () => {
    // The Dashboard alone stands under no heading ("dashboard shouldn't have that text header overview").
    expect(MODULES.filter((module) => module.group === null).map((module) => module.key)).toEqual(['dashboard']);
    const order = MODULES.map((module) => (module.group === null ? -1 : MODULE_GROUPS.indexOf(module.group)));
    expect(order.filter((at) => at !== -1).every((at) => at >= 0)).toBe(true);
    // Contiguous: a group's modules sit together, in the menu's order.
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(MODULES.filter((module) => module.group === 'invoicing').map((module) => module.key)).toEqual(['sales', 'payables', 'transfers']);
    for (const locale of ['en', 'ar']) {
      const shell = (JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8')) as { shell: { module_group: Record<string, string> } }).shell;
      expect(Object.keys(shell.module_group).sort(), locale).toEqual([...MODULE_GROUPS].sort());
    }
  });

  it('draws the camera\'s own session with the top bar, recognised by the camera\'s own tag', () => {
    const service = readFileSync('src/server/services/user-appearance.ts', 'utf8');
    expect(/CAMERA_SESSION_AGENT = '([^']+)'/.exec(service)?.[1]).toBe(LIVE_SHOT_AGENT);
    const layout = readFileSync('src/app/(app)/layout.tsx', 'utf8');
    expect(layout).toMatch(/isCameraSession\(tx, context\.sessionId\)/);
    expect(layout).toMatch(/navigation: 'top' as const/);
  });
});

describe("everyone's default (0419)", () => {
  const company = {
    ...BUILT_IN_COMPANY_DEFAULTS,
    palette: 'pearl',
    accent: 'blue',
    appearance: 'enterprise',
    navigation: 'side',
    textSize: 'smaller',
  } as const;
  const { palette: _palette, accent: _accent, ...companySettings } = company;
  void _palette;
  void _accent;

  it('is the built-in default where the company has none, so fresh installs and tests are unchanged', () => {
    expect(effectiveAppearance({}, null)).toEqual(DEFAULT_USER_APPEARANCE);
    expect(effectiveColours({}, null)).toEqual({ palette: 'sand', accent: 'gold' });
    expect(BUILT_IN_COMPANY_DEFAULTS).toEqual({ ...DEFAULT_USER_APPEARANCE, palette: 'sand', accent: 'gold' });
  });

  it('own choice, else the company default, else the built-in', () => {
    // Nothing stored, or only the built-in values the first page used to write: the company's, whole.
    expect(effectiveAppearance({}, company)).toEqual(companySettings);
    expect(effectiveAppearance({ ...DEFAULT_USER_APPEARANCE }, company)).toEqual(companySettings);
    expect(choseOwnAppearance({ ...DEFAULT_USER_APPEARANCE })).toBe(false);
    // One setting of their own: they chose — theirs where they set it, the company's where they never did.
    const mine = { ...DEFAULT_USER_APPEARANCE, density: 'airy', navigation: null } as const;
    expect(choseOwnAppearance(mine)).toBe(true);
    expect(effectiveAppearance(mine, company)).toEqual({ ...DEFAULT_USER_APPEARANCE, density: 'airy', navigation: 'side' });
    // A company default that names only some settings: the built-in for the rest.
    expect(effectiveAppearance({}, { navigation: 'bottom' })).toEqual({ ...DEFAULT_USER_APPEARANCE, navigation: 'bottom' });
    // Colours: their own, else the company's, else Sand and Gold.
    expect(effectiveColours({ palette: 'ocean', accent: null }, company)).toEqual({ palette: 'ocean', accent: 'blue' });
    expect(effectiveColours({}, company)).toEqual({ palette: 'pearl', accent: 'blue' });
  });

  it('is written whole and known, and read leniently', () => {
    expect(parseCompanyDefaults(company)).toEqual(company);
    expect(() => parseCompanyDefaults({ ...company, navigation: 'left' })).toThrow(/Unknown navigation/);
    const { textSize: _textSize, ...partial } = company;
    void _textSize;
    expect(() => parseCompanyDefaults(partial)).toThrow(/Unknown textSize/);
    expect(readCompanyDefaults(null)).toBeNull();
    expect(readCompanyDefaults({ navigation: 'left', palette: 'pearl', retired: 'x' })).toEqual({ palette: 'pearl' });
  });

  it('holds 0419 to the same keys and values as the code', () => {
    const sql = readFileSync('src/server/db/migrations/0419_company_appearance_defaults.sql', 'utf8');
    const keys = /ui_defaults - ARRAY\[([^\]]*)\]/.exec(sql)![1]!.split(',').map((key) => key.trim().replace(/^'|'$/g, ''));
    expect(keys).toEqual([...COMPANY_DEFAULT_NAMES]);
    const choices: Record<string, readonly string[]> = { ...APPEARANCE_CHOICES, palette: PALETTES, accent: ACCENTS };
    for (const name of COMPANY_DEFAULT_NAMES) {
      const found = new RegExp(`ui_defaults->>'${name}' IN \\(([^)]*)\\)`).exec(sql);
      expect(found, name).not.toBeNull();
      expect(found![1]!.split(',').map((value) => value.trim().replace(/^'|'$/g, '')), name).toEqual([...choices[name]!]);
    }
  });

  it('the shell adopts nothing for a person who follows the company, and the drawer offers the button only to whoever configures the company', () => {
    const shell = readFileSync('src/components/erp-shell.tsx', 'utf8');
    expect(shell).toMatch(/const adopt = !appearanceSettingsSaved && !appearanceFollowsCompany;/);
    expect(shell).toMatch(/if \(adopt\) void persistAppearanceSettings\(settings\);/);
    expect(shell).toMatch(/\{mayConfigureCompanyAppearance \? \(/);
    const appShell = readFileSync('src/components/app-shell.tsx', 'utf8');
    expect(appShell).toMatch(/mayConfigureCompanyAppearance=\{!restriction && mayConfigureCompanyDefaults\(principal\)\}/);
  });
});
