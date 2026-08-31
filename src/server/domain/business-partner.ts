/**
 * Business Partner — Phase 03.2.
 *
 * §3.1: "one authoritative record and a unique system identifier".
 * §6:   "Uses the central Business Partner master" — one record serves CRM,
 *       Sales, Finance, Projects, Logistics and Money Transfer.
 * §4.4: "Duplicate searches run before saving business partners, items and bank
 *       accounts."
 *
 * ── Why customer and supplier are roles, not records ────────────────────────
 * A company that both buys from you and sells to you is one legal person. Two
 * records would mean two credit positions, two sets of bank details and no way
 * to net them — and the first time someone notices is usually when a payment
 * goes to the wrong account.
 */

/** §6 — the five statuses. */
export const PARTNER_STATUSES = [
  'prospect',
  'active',
  'on_hold',
  'blocked',
  'inactive',
] as const;
export type PartnerStatus = (typeof PARTNER_STATUSES)[number];

export const PARTNER_ROLES = ['customer', 'supplier'] as const;
export type PartnerRole = (typeof PARTNER_ROLES)[number];

export interface PartnerIdentity {
  readonly legalName: string;
  readonly registrationNo?: string | null;
  readonly taxIdentifier?: string | null;
  readonly email?: string | null;
  readonly phone?: string | null;
}

export interface PartnerRecord extends PartnerIdentity {
  readonly id: string;
  readonly code: string;
  readonly isCustomer: boolean;
  readonly isSupplier: boolean;
  readonly status: PartnerStatus;
  readonly active: boolean;
}

export class PartnerRoleError extends Error {
  readonly code = 'PARTNER_ROLE_INVALID';
  constructor(detail: string) {
    super(detail);
    this.name = 'PartnerRoleError';
  }
}

export class PartnerFieldRequiredError extends Error {
  readonly code = 'PARTNER_FIELD_REQUIRED';
  constructor(
    readonly role: PartnerRole,
    readonly missing: readonly string[],
  ) {
    super(
      `A ${role} must carry ${missing.join(', ')}. ` +
        'These are the fields configured as mandatory for that role (Appendix B).',
    );
    this.name = 'PartnerFieldRequiredError';
  }
}

export class PartnerNotUsableError extends Error {
  readonly code = 'PARTNER_NOT_USABLE';
  constructor(
    readonly partnerCode: string,
    readonly status: PartnerStatus,
  ) {
    super(
      `Business partner ${partnerCode} is ${status.replace('_', ' ')} and cannot be used on a new ` +
        'transaction without an authorised override.',
    );
    this.name = 'PartnerNotUsableError';
  }
}

/** §6 — a partner is a customer, a supplier, or both. Never neither. */
export function assertHasRole(input: { isCustomer: boolean; isSupplier: boolean }): void {
  if (!input.isCustomer && !input.isSupplier) {
    throw new PartnerRoleError(
      'A business partner must be a customer, a supplier, or both. A record with neither role has nothing to do.',
    );
  }
}

/**
 * Appendix B — "role-specific mandatory fields".
 *
 * Which fields those are is a business decision and is held as configuration
 * (§28); this enforces whatever the Business Process Owner has configured, and
 * enforces nothing when nothing is configured.
 */
export function assertRoleFields(
  role: PartnerRole,
  requiredFields: readonly string[],
  values: Readonly<Record<string, unknown>>,
): void {
  const missing = requiredFields.filter((field) => {
    const value = values[field];
    return value === undefined || value === null || value === '';
  });

  if (missing.length > 0) {
    throw new PartnerFieldRequiredError(role, missing);
  }
}

/**
 * §6 — may this partner be used on a new transaction?
 *
 * Blocked and Inactive stop new business; On Hold is a credit position and also
 * stops it. Prospect is a CRM state — §6: "A lead can exist without an approved
 * Business Partner; a Sales Order, Project, invoice or service transaction
 * cannot."
 *
 * An override is possible because §6 says it is, and it is the caller's job to
 * have checked the authority for it. That the override happened is audited.
 */
export function assertUsableForTransaction(
  partner: Pick<PartnerRecord, 'code' | 'status' | 'active'>,
  options: { override?: boolean } = {},
): void {
  if (partner.status === 'active' && partner.active) return;
  if (options.override) return;

  throw new PartnerNotUsableError(partner.code, partner.active ? partner.status : 'inactive');
}

// ---------------------------------------------------------------------------
// §4.4 — duplicate detection
// ---------------------------------------------------------------------------

/** What matched, and on what. */
export interface DuplicateMatch {
  readonly partnerId: string;
  readonly partnerCode: string;
  readonly legalName: string;
  readonly matchedOn: readonly string[];
}

export class DuplicatePartnerError extends Error {
  readonly code = 'PARTNER_DUPLICATE';

  constructor(readonly matches: readonly DuplicateMatch[]) {
    super(
      `This looks like an existing partner: ${matches
        .map((m) => `${m.partnerCode} ${m.legalName} (matched on ${m.matchedOn.join(', ')})`)
        .join('; ')}. ` +
        'Use the existing record, or confirm this is genuinely a different party.',
    );
    this.name = 'DuplicatePartnerError';
  }
}

/**
 * Normalises a name for comparison.
 *
 * "Al-Rafidain Trading Co." and "al rafidain trading co" are the same company
 * typed by two people. Case, punctuation and spacing are noise; the words are
 * the signal. Deliberately not fuzzy beyond that: a near-match that is actually
 * a different company is worse than a miss, because the user will click through
 * a warning they have learned to distrust.
 */
export function normaliseName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Digits only, so +964 770 123 4567 and 07701234567 compare equal. */
export function normalisePhone(value: string): string {
  return value.replace(/\D+/g, '').replace(/^00/, '').replace(/^964/, '0');
}

export function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Which of the §4.4 identifiers two records share.
 *
 * §4.4 names them: "name, phone, email, registration number and bank details".
 * Bank details are compared separately by the service, because they live in
 * their own table with their own approval state.
 */
export function matchedIdentifiers(
  candidate: PartnerIdentity,
  existing: PartnerIdentity,
): string[] {
  const matched: string[] = [];

  if (normaliseName(candidate.legalName) === normaliseName(existing.legalName)) {
    matched.push('name');
  }
  if (
    candidate.registrationNo &&
    existing.registrationNo &&
    candidate.registrationNo.trim() === existing.registrationNo.trim()
  ) {
    matched.push('registration number');
  }
  if (
    candidate.taxIdentifier &&
    existing.taxIdentifier &&
    candidate.taxIdentifier.trim() === existing.taxIdentifier.trim()
  ) {
    matched.push('tax identifier');
  }
  if (
    candidate.email &&
    existing.email &&
    normaliseEmail(candidate.email) === normaliseEmail(existing.email)
  ) {
    matched.push('email');
  }
  if (
    candidate.phone &&
    existing.phone &&
    normalisePhone(candidate.phone) === normalisePhone(existing.phone)
  ) {
    matched.push('phone');
  }

  return matched;
}
