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
