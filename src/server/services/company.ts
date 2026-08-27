/**
 * Company Setup — Phase 0 requirement 1.
 *
 * One legal entity (§2.1 — the `company_singleton` index allows exactly one
 * row). The first save creates it; every later save updates it. The base
 * currency is chosen here and nowhere else; it is not assumed to be IQD.
 */
import { eq } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { company } from '../db/schema';
import { assertPalette, DEFAULT_PALETTE, paletteOrDefault, type Palette } from '../domain/appearance';
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
 * The palette the application wears, for everybody.
 *
 * Read on every authenticated page load, so it is one indexed row by the
 * singleton and nothing more. It falls back rather than failing: a company row
 * that does not exist yet, or a value the stylesheet does not define, gives an
 * ordinary-looking system rather than an unstyled one.
 */
export async function palette(tx: Tx): Promise<Palette> {
  const [row] = await tx.select({ value: company.uiPalette }).from(company).limit(1);
  return paletteOrDefault(row?.value);
}

/**
 * Chooses the palette.
 *
 * Gated on `configure` for the company, the same permission that edits its
 * legal name — this is a company-wide setting, and one person's taste should
 * not be able to redraw everybody's screens.
 */
export async function setPalette(
  tx: Tx,
  ctx: ActorContext,
  value: string,
): Promise<{ palette: Palette }> {
  const existing = await current(tx);
  if (!existing) {
    throw new AdminValidationError('uiPalette', 'cannot be set before the company is created');
  }
  await permit(ctx, 'configure', PERMISSION_OBJECT, existing.id);

  // Refused here by name so the reader is told what the choices are, rather
  // than being handed the database's constraint violation. The constraint
  // still stands behind this for a caller that never comes through here.
  assertPalette(value);

  const before = paletteOrDefault(existing.uiPalette);
  if (before !== value) {
    await tx.update(company).set({ uiPalette: value }).where(eq(company.id, existing.id));
    await recordChange(tx, ctx, {
      action: 'company.palette_changed',
      objectType: PERMISSION_OBJECT,
      objectId: existing.id,
      before: { uiPalette: before },
      after: { uiPalette: value },
    });
  }

  return { palette: value };
}

/** Referenced so the default is stated once and imported, never re-typed. */
export const FALLBACK_PALETTE = DEFAULT_PALETTE;
