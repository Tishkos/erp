/**
 * The filters of the registers a view can be saved on — pure, so the screen
 * and the pinned count are one rule (platform phase, Agent 8).
 *
 * A saved view only sends a person to a screen with parameters; the screen
 * filters its own rows. The Home page, though, shows a *count* for a pinned
 * view, and a count taken by different code from the screen's would drift the
 * first time either changed. So the filters that were written inline in a page
 * live here, and both the page and `services/saved-view-counts.ts` call them.
 */
import { MONEY_SCALE, parseDecimal } from './money';

/**
 * Case-insensitive match of a search phrase against every value of a row —
 * what the registers' search box has always done (`matches` in the admin
 * components is this function).
 */
export function rowMatches(row: Record<string, unknown>, q: string): boolean {
  if (!q.trim()) return true;
  const needle = q.trim().toLowerCase();
  return Object.values(row).some((value) => {
    if (value === null || value === undefined) return false;
    if (value instanceof Date) return false;
    return String(value).toLowerCase().includes(needle);
  });
}

export const INVOICE_VIEWS = ['imports', 'expenses', 'unpaid', 'overdue'] as const;
export type InvoiceView = (typeof INVOICE_VIEWS)[number];

export interface InvoiceRegisterRow {
  readonly totalIqd: string;
  readonly isImport: boolean;
  readonly expenseCategoryCode: string | null;
  /** `expenses.paymentState` of the row on the day the register is read. */
  readonly state: string;
}

export interface InvoiceRegisterFilter {
  readonly q?: string | null;
  readonly view?: string | null;
  /** Exact decimal, IQD; a row is kept when its total is at least this. */
  readonly minAmount?: string | null;
}

/**
 * Purchase Invoices: the search, the View filter and the amount floor.
 * The amount is compared as scaled integers, never as a float — a dinar under
 * the floor is under it.
 */
export function filterInvoiceRegister<T extends InvoiceRegisterRow>(
  rows: readonly T[],
  filter: InvoiceRegisterFilter,
): T[] {
  const floor = filter.minAmount ? parseDecimal(filter.minAmount, MONEY_SCALE) : null;
  return rows
    .filter((row) => rowMatches(row as unknown as Record<string, unknown>, filter.q ?? ''))
    .filter((row) =>
      filter.view === 'imports'
        ? row.isImport
        : filter.view === 'expenses'
          ? Boolean(row.expenseCategoryCode)
          : filter.view === 'overdue'
            ? row.state === 'overdue'
            : filter.view === 'unpaid'
              ? row.state === 'unpaid' || row.state === 'part_paid' || row.state === 'overdue'
              : true,
    )
    .filter((row) => floor === null || parseDecimal(row.totalIqd, MONEY_SCALE) >= floor);
}

export interface ContainerRegisterFilter {
  readonly q?: string | null;
  readonly etaFrom?: string | null;
  readonly etaTo?: string | null;
}

/**
 * Containers: the search and the ETA window (inclusive). With either end set,
 * a container with no ETA is outside the window — it is not "arriving" on any day.
 */
export function filterContainerRegister<T extends { readonly eta: string | null }>(
  rows: readonly T[],
  filter: ContainerRegisterFilter,
): T[] {
  return rows
    .filter((row) => rowMatches(row as unknown as Record<string, unknown>, filter.q ?? ''))
    .filter((row) => {
      if (!filter.etaFrom && !filter.etaTo) return true;
      if (!row.eta) return false;
      if (filter.etaFrom && row.eta < filter.etaFrom) return false;
      if (filter.etaTo && row.eta > filter.etaTo) return false;
      return true;
    });
}

export interface PartnerRegisterFilter {
  readonly q?: string | null;
  readonly status?: string | null;
}

/** Customers and Suppliers: the search and the lifecycle status. */
export function filterPartnerRegister<T extends { readonly status: string }>(
  rows: readonly T[],
  filter: PartnerRegisterFilter,
): T[] {
  return rows
    .filter((row) => rowMatches(row as unknown as Record<string, unknown>, filter.q ?? ''))
    .filter((row) => !filter.status || row.status === filter.status);
}
