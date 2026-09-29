import { eq } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { appUser } from '../db/schema';
import {
  DEFAULT_USER_APPEARANCE,
  parseUserAppearanceSettings,
  type UserAppearanceSettings,
} from '../domain/appearance';
import { recordChange, type ActorContext } from './administration';

const fields = {
  appearance: appUser.uiAppearance,
  density: appUser.uiDensity,
  cornerStyle: appUser.uiCornerStyle,
  contentWidth: appUser.uiContentWidth,
  borderStyle: appUser.uiBorderStyle,
  shadow: appUser.uiShadow,
  componentSize: appUser.uiComponentSize,
} as const;

export async function settingsFor(tx: Tx, userId: string): Promise<{
  readonly settings: UserAppearanceSettings;
  /** False only for users who still need their old browser choices migrated. */
  readonly saved: boolean;
}> {
  const [row] = await tx.select(fields).from(appUser).where(eq(appUser.id, userId)).limit(1);
  if (!row) return { settings: DEFAULT_USER_APPEARANCE, saved: true };

  const saved = Object.values(row).every((value) => value !== null);
  const settings = parseUserAppearanceSettings({
    appearance: row.appearance ?? DEFAULT_USER_APPEARANCE.appearance,
    density: row.density ?? DEFAULT_USER_APPEARANCE.density,
    cornerStyle: row.cornerStyle ?? DEFAULT_USER_APPEARANCE.cornerStyle,
    contentWidth: row.contentWidth ?? DEFAULT_USER_APPEARANCE.contentWidth,
    borderStyle: row.borderStyle ?? DEFAULT_USER_APPEARANCE.borderStyle,
    shadow: row.shadow ?? DEFAULT_USER_APPEARANCE.shadow,
    componentSize: row.componentSize ?? DEFAULT_USER_APPEARANCE.componentSize,
  });

  return { settings, saved };
}

export async function setMySettings(
  tx: Tx,
  ctx: ActorContext,
  input: unknown,
): Promise<UserAppearanceSettings> {
  const settings = parseUserAppearanceSettings(input);
  const [existing] = await tx
    .select(fields)
    .from(appUser)
    .where(eq(appUser.id, ctx.principal.userId))
    .limit(1);
  if (!existing) throw new Error('The signed-in user could not be found.');

  const before = {
    appearance: existing.appearance ?? DEFAULT_USER_APPEARANCE.appearance,
    density: existing.density ?? DEFAULT_USER_APPEARANCE.density,
    cornerStyle: existing.cornerStyle ?? DEFAULT_USER_APPEARANCE.cornerStyle,
    contentWidth: existing.contentWidth ?? DEFAULT_USER_APPEARANCE.contentWidth,
    borderStyle: existing.borderStyle ?? DEFAULT_USER_APPEARANCE.borderStyle,
    shadow: existing.shadow ?? DEFAULT_USER_APPEARANCE.shadow,
    componentSize: existing.componentSize ?? DEFAULT_USER_APPEARANCE.componentSize,
  };

  if (Object.keys(settings).some((key) => settings[key as keyof UserAppearanceSettings] !== before[key as keyof typeof before])) {
    await tx
      .update(appUser)
      .set({
        uiAppearance: settings.appearance,
        uiDensity: settings.density,
        uiCornerStyle: settings.cornerStyle,
        uiContentWidth: settings.contentWidth,
        uiBorderStyle: settings.borderStyle,
        uiShadow: settings.shadow,
        uiComponentSize: settings.componentSize,
        updatedAt: new Date(),
      })
      .where(eq(appUser.id, ctx.principal.userId));

    await recordChange(tx, ctx, {
      action: 'user.appearance_settings_changed',
      objectType: 'app_user',
      objectId: ctx.principal.userId,
      branchCode: ctx.branchCode,
      before,
      after: { ...settings },
    });
  } else if (!Object.values(existing).every((value) => value !== null)) {
    // First use writes the default/legacy values even if they match the base
    // design, so they follow this account to its other devices.
    await tx
      .update(appUser)
      .set({
        uiAppearance: settings.appearance,
        uiDensity: settings.density,
        uiCornerStyle: settings.cornerStyle,
        uiContentWidth: settings.contentWidth,
        uiBorderStyle: settings.borderStyle,
        uiShadow: settings.shadow,
        uiComponentSize: settings.componentSize,
        updatedAt: new Date(),
      })
      .where(eq(appUser.id, ctx.principal.userId));
  }

  return settings;
}
