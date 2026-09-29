import { describe, expect, it } from 'vitest';
import {
  APPEARANCE_PRESET_SETTINGS,
  APPEARANCE_PRESETS,
  DEFAULT_USER_APPEARANCE,
  parseUserAppearanceSettings,
} from '@/server/domain/appearance';

describe('additive appearance settings', () => {
  it('keeps Current identical to the existing defaults', () => {
    expect({ appearance: 'current', ...APPEARANCE_PRESET_SETTINGS.current }).toEqual(
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
