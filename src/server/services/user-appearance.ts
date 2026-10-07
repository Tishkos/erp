import { eq } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { appUser, authSession, company } from '../db/schema';
import {
  LAYOUT_SETTING_NAMES,
  choseOwnAppearance,
  effectiveAppearance,
  effectiveColours,
  parseCompanyDefaults,
  parseUserAppearanceSettings,
  readCompanyDefaults,
  type CompanyAppearanceDefaults,
  type UserAppearanceSettings,
} from '../domain/appearance';
import { can, type Principal } from '../domain/permissions';
import { permit, recordChange, type ActorContext } from './administration';

const fields = {
  appearance: appUser.uiAppearance,
  density: appUser.uiDensity,
  cornerStyle: appUser.uiCornerStyle,
  contentWidth: appUser.uiContentWidth,
  borderStyle: appUser.uiBorderStyle,
  shadow: appUser.uiShadow,
  componentSize: appUser.uiComponentSize,
  navigation: appUser.uiNavigation,
  sidebar: appUser.uiSidebar,
  sidebarGroups: appUser.uiSidebarGroups,
  sidebarColour: appUser.uiSidebarColour,
  textSize: appUser.uiTextSize,
  header: appUser.uiHeader,
  motion: appUser.uiMotion,
  tableStripes: appUser.uiTableStripes,
} as const satisfies Record<keyof UserAppearanceSettings, unknown>;

type StoredRow = { readonly [Name in keyof UserAppearanceSettings]: string | null };

/**
 * Whether this account's old browser choices have been adopted.
 *
 * Decided by 0220's seven layout columns alone. The navigation columns (0407)
 * arrived NULL on every account, and a NULL there means "the default", not
 * "never chosen in this database": counting them would have sent every
 * existing user back through the adoption step, which re-reads the layout
 * from that browser's storage and writes it over what they had saved.
 */
function adopted(row: StoredRow): boolean {
  return LAYOUT_SETTING_NAMES.every((name) => row[name] !== null);
}

function columnsOf(settings: UserAppearanceSettings) {
  return {
    uiAppearance: settings.appearance,
    uiDensity: settings.density,
    uiCornerStyle: settings.cornerStyle,
    uiContentWidth: settings.contentWidth,
    uiBorderStyle: settings.borderStyle,
    uiShadow: settings.shadow,
    uiComponentSize: settings.componentSize,
    uiNavigation: settings.navigation,
    uiSidebar: settings.sidebar,
    uiSidebarGroups: settings.sidebarGroups,
    uiSidebarColour: settings.sidebarColour,
    uiTextSize: settings.textSize,
    uiHeader: settings.header,
    uiMotion: settings.motion,
    uiTableStripes: settings.tableStripes,
  };
}

/**
 * What a person sees: their own choice, else the company's default (0419),
 * else the built-in one (`domain/appearance.ts` › `effectiveAppearance`).
 *
 * `saved` keeps its meaning — this person's row has their layout written, so
 * there is nothing of an old browser to adopt. `followsCompany` says they have
 * not chosen their own and a company default exists: the shell then adopts
 * nothing on load, so their row stays empty and keeps following the company.
 */
export async function settingsFor(tx: Tx, userId: string): Promise<{
  readonly settings: UserAppearanceSettings;
  /** False only for users who still need their old browser choices migrated. */
  readonly saved: boolean;
  /** True when the person has no appearance of their own and the company has a default. */
  readonly followsCompany: boolean;
}> {
  const defaults = await storedCompanyDefaults(tx);
  const [row] = await tx.select(fields).from(appUser).where(eq(appUser.id, userId)).limit(1);
  if (!row) return { settings: effectiveAppearance({}, defaults), saved: true, followsCompany: defaults !== null };

  return {
    settings: effectiveAppearance(row, defaults),
    saved: adopted(row),
    followsCompany: defaults !== null && !choseOwnAppearance(row),
  };
}

// ---------------------------------------------------------------------------
// Everyone's default (0419)
// ---------------------------------------------------------------------------

/** The permission the company's look has always asked: `configure` on the company (company.ts › setAppearance). */
export const COMPANY_DEFAULT_OBJECT = 'company';

/** The company's default appearance as stored (read leniently), or null — the built-in default. */
export async function storedCompanyDefaults(tx: Tx): Promise<Partial<CompanyAppearanceDefaults> | null> {
  const [row] = await tx.select({ defaults: company.uiDefaults }).from(company).limit(1);
  return readCompanyDefaults(row?.defaults ?? null);
}

/** Whether this person may set or reset everyone's default (the Appearance drawer's two buttons). */
export function mayConfigureCompanyDefaults(principal: Principal): boolean {
  return can(principal, 'configure', COMPANY_DEFAULT_OBJECT);
}

/** Everyone's default lives on the company row; with none there is nowhere to keep it. */
export class CompanyNotSetUpError extends Error {
  readonly code = 'COMPANY_NOT_SET_UP';

  constructor() {
    super('The company has not been set up yet, so it has no default appearance.');
    this.name = 'CompanyNotSetUpError';
  }
}

async function companyRow(tx: Tx) {
  const [row] = await tx.select({ id: company.id, defaults: company.uiDefaults }).from(company).limit(1);
  if (!row) throw new CompanyNotSetUpError();
  return row;
}

/**
 * Writes everyone's default — every key, every value known. `configure` on the
 * company, audited with what it was and what it became; a person who chose
 * their own keeps it.
 */
export async function setCompanyDefaults(
  tx: Tx,
  ctx: ActorContext,
  input: unknown,
): Promise<CompanyAppearanceDefaults> {
  const row = await companyRow(tx);
  await permit(ctx, 'configure', COMPANY_DEFAULT_OBJECT, row.id);
  const defaults = parseCompanyDefaults(input);
  await tx.update(company).set({ uiDefaults: defaults }).where(eq(company.id, row.id));
  await recordChange(tx, ctx, {
    action: 'company.appearance_defaults_set',
    objectType: COMPANY_DEFAULT_OBJECT,
    objectId: row.id,
    before: { defaults: readCompanyDefaults(row.defaults) },
    after: { defaults: { ...defaults } },
  });
  return defaults;
}

/**
 * "Make my appearance everyone's default": the caller's appearance as they see
 * it now — palette, accent, every layout and navigation setting — becomes the
 * company's default.
 */
export async function makeMineCompanyDefault(tx: Tx, ctx: ActorContext): Promise<CompanyAppearanceDefaults> {
  const defaults = await storedCompanyDefaults(tx);
  const [own] = await tx
    .select({ ...fields, palette: appUser.uiPalette, accent: appUser.uiAccent })
    .from(appUser)
    .where(eq(appUser.id, ctx.principal.userId))
    .limit(1);
  if (!own) throw new Error('The signed-in user could not be found.');
  return setCompanyDefaults(tx, ctx, {
    ...effectiveAppearance(own, defaults),
    ...effectiveColours(own, defaults),
  });
}

/** "Reset everyone's default to the built-in": the company's default goes; people who chose keep theirs. */
export async function resetCompanyDefaults(tx: Tx, ctx: ActorContext): Promise<void> {
  const row = await companyRow(tx);
  await permit(ctx, 'configure', COMPANY_DEFAULT_OBJECT, row.id);
  if (row.defaults === null) return;
  await tx.update(company).set({ uiDefaults: null }).where(eq(company.id, row.id));
  await recordChange(tx, ctx, {
    action: 'company.appearance_defaults_reset',
    objectType: COMPANY_DEFAULT_OBJECT,
    objectId: row.id,
    before: { defaults: readCompanyDefaults(row.defaults) },
    after: { defaults: null },
  });
}

/**
 * The session Noah's camera opened (`services/live-screenshot.ts`, its
 * `LIVE_SHOT_AGENT` — held equal by `tests/unit/appearance-settings.test.ts`).
 *
 * The camera pictures the menus of the top bar and may press only those
 * (`MAY_PRESS`: "a menu of the top bar"), so a session of its own is drawn
 * with the top bar whatever navigation the person chose — the menu's words
 * ("Payables → Supplier Balances → Suppliers") are the same in the side panel
 * and the bottom bar. The person's saved choice is not touched.
 */
export const CAMERA_SESSION_AGENT = 'noah-live-screenshot';

export async function isCameraSession(tx: Tx, sessionId: string): Promise<boolean> {
  const [row] = await tx
    .select({ userAgent: authSession.userAgent })
    .from(authSession)
    .where(eq(authSession.id, sessionId))
    .limit(1);
  return row?.userAgent === CAMERA_SESSION_AGENT;
}

export async function setMySettings(
  tx: Tx,
  ctx: ActorContext,
  input: unknown,
): Promise<UserAppearanceSettings> {
  const [existing] = await tx
    .select(fields)
    .from(appUser)
    .where(eq(appUser.id, ctx.principal.userId))
    .limit(1);
  if (!existing) throw new Error('The signed-in user could not be found.');

  // What the person sees now — their own, else the company's default — is the "before".
  const before = effectiveAppearance(existing, await storedCompanyDefaults(tx));
  // A navigation setting the caller left out keeps what they see.
  const settings = parseUserAppearanceSettings(input, before);

  const changed = (Object.keys(settings) as (keyof UserAppearanceSettings)[]).some(
    (key) => settings[key] !== before[key],
  );
  if (changed) {
    await tx
      .update(appUser)
      .set({ ...columnsOf(settings), updatedAt: new Date() })
      .where(eq(appUser.id, ctx.principal.userId));

    await recordChange(tx, ctx, {
      action: 'user.appearance_settings_changed',
      objectType: 'app_user',
      objectId: ctx.principal.userId,
      branchCode: ctx.branchCode,
      before: { ...before },
      after: { ...settings },
    });
  } else if (!adopted(existing)) {
    // First use writes the default/legacy values even if they match the base
    // design, so they follow this account to its other devices.
    await tx
      .update(appUser)
      .set({ ...columnsOf(settings), updatedAt: new Date() })
      .where(eq(appUser.id, ctx.principal.userId));
  }

  return settings;
}
