/**
 * Company Setup — Phase 0 requirement 1.
 *
 * One legal entity (§2.1 — the `company_singleton` index allows exactly one
 * row). The first save creates it; every later save updates it. The base
 * currency is chosen here and nowhere else; it is not assumed to be IQD.
 */
import { eq } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { appUser, company } from '../db/schema';
import {
  accentOrDefault,
  assertAccent,
  assertPalette,
  paletteOrDefault,
  type Accent,
  type Palette,
} from '../domain/appearance';
import {
  AdminValidationError,
  normaliseCode,
  optionalText,
  permit,
  recordChange,
  requireText,
  type ActorContext,
} from './administration';

export const PERMISSION_OBJECT = 'company';

export interface CompanyInput {
  readonly code: string;
  readonly legalName: string;
  readonly tradeName?: string | null;
  readonly registrationNo?: string | null;
  readonly taxIdentifier?: string | null;
  readonly baseCurrency: string;
  readonly address?: string | null;
}

export async function current(tx: Tx) {
  const [row] = await tx.select().from(company).limit(1);
  return row ?? null;
}

export async function save(tx: Tx, ctx: ActorContext, input: CompanyInput) {
  const existing = await current(tx);
  await permit(ctx, existing ? 'configure' : 'create', PERMISSION_OBJECT, existing?.id ?? null);

  const currency = input.baseCurrency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new AdminValidationError('baseCurrency', 'is a three-letter ISO code, e.g. IQD or USD');
  }

  const values = {
    code: normaliseCode(input.code),
    legalName: requireText(input.legalName, 'legalName'),
    tradeName: optionalText(input.tradeName),
    registrationNo: optionalText(input.registrationNo, 100),
    taxIdentifier: optionalText(input.taxIdentifier, 100),
    baseCurrency: currency,
    address: optionalText(input.address),
  };

  if (existing) {
    const [updated] = await tx
      .update(company)
      .set(values)
      .where(eq(company.id, existing.id))
      .returning();
    await recordChange(tx, ctx, {
      action: 'company.updated',
      objectType: PERMISSION_OBJECT,
      objectId: existing.id,
      before: {
        code: existing.code,
        legalName: existing.legalName,
        tradeName: existing.tradeName,
        registrationNo: existing.registrationNo,
        taxIdentifier: existing.taxIdentifier,
        baseCurrency: existing.baseCurrency,
        address: existing.address,
      },
      after: values,
    });
    return updated!;
  }

  const [created] = await tx.insert(company).values(values).returning();
  await recordChange(tx, ctx, {
    action: 'company.created',
    objectType: PERMISSION_OBJECT,
    objectId: created!.id,
    after: values,
  });
  return created!;
}

/**
 * The look the application wears, for everybody.
 *
 * Read on every authenticated page load, so it is one indexed row by the
 * singleton and nothing more. It falls back rather than failing: a company
 * row that does not exist yet, or a value the stylesheet does not define,
 * gives an ordinary-looking system rather than an unstyled one.
 */
export async function appearance(tx: Tx): Promise<{ palette: Palette; accent: Accent }> {
  const [row] = await tx
    .select({ palette: company.uiPalette, accent: company.uiAccent })
    .from(company)
    .limit(1);
  return { palette: paletteOrDefault(row?.palette), accent: accentOrDefault(row?.accent) };
}

/**
 * Chooses the palette and the accent, together.
 *
 * Gated on `configure` for the company, the same permission that edits its
 * legal name — one person's taste should not redraw everybody's screens. One
 * audit event for the pair: the person made one decision on one form, and the
 * trail should read the way the decision was made.
 */
export async function setAppearance(
  tx: Tx,
  ctx: ActorContext,
  input: { readonly palette: string; readonly accent: string },
): Promise<{ palette: Palette; accent: Accent }> {
  const existing = await current(tx);
  if (!existing) {
    throw new AdminValidationError('uiPalette', 'cannot be set before the company is created');
  }
  await permit(ctx, 'configure', PERMISSION_OBJECT, existing.id);

  // Refused here by name so the reader is told what the choices are, rather
  // than being handed the database's constraint violation. The constraints
  // still stand behind this for a caller that never comes through here.
  assertPalette(input.palette);
  assertAccent(input.accent);

  const before = {
    palette: paletteOrDefault(existing.uiPalette),
    accent: accentOrDefault(existing.uiAccent),
  };
  if (before.palette !== input.palette || before.accent !== input.accent) {
    await tx
      .update(company)
      .set({ uiPalette: input.palette, uiAccent: input.accent })
      .where(eq(company.id, existing.id));
    await recordChange(tx, ctx, {
      action: 'company.appearance_changed',
      objectType: PERMISSION_OBJECT,
      objectId: existing.id,
      before: { uiPalette: before.palette, uiAccent: before.accent },
      after: { uiPalette: input.palette, uiAccent: input.accent },
    });
  }

  return { palette: input.palette, accent: input.accent };
}

/**
 * The look this person actually sees: their own choice where they made one,
 * the company's default where they did not. Read on every authenticated page.
 */
export async function appearanceFor(
  tx: Tx,
  userId: string,
): Promise<{ palette: Palette; accent: Accent }> {
  const [u] = await tx
    .select({ palette: appUser.uiPalette, accent: appUser.uiAccent })
    .from(appUser)
    .where(eq(appUser.id, userId))
    .limit(1);
  return {
    palette: paletteOrDefault(u?.palette),
    accent: accentOrDefault(u?.accent),
  };
}

/**
 * A person chooses their own look — or hands the choice back.
 *
 * Self-service by construction: it writes only the caller's row, so the only
 * permission needed is being signed in. 'company' is the sentinel for "follow
 * the default"; it stores null, which is what appearanceFor reads it as.
 */
export async function setMyAppearance(
  tx: Tx,
  ctx: ActorContext,
  input: { readonly palette: string; readonly accent: string },
): Promise<void> {
  const { palette, accent } = input;
  assertPalette(palette);
  assertAccent(accent);

  await tx
    .update(appUser)
    .set({ uiPalette: palette, uiAccent: accent })
    .where(eq(appUser.id, ctx.principal.userId));

  await recordChange(tx, ctx, {
    action: 'user.appearance_changed',
    objectType: 'app_user',
    objectId: ctx.principal.userId,
    after: { uiPalette: palette, uiAccent: accent },
  });
}
