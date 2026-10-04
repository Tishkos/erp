/**
 * From the service's rows to what a screen draws.
 *
 * Everything a person reads is made here, on the server, in their language: the
 * group heading (`search.types.<key>`), the status through its translation —
 * never the code — the date and the money in the locale's own formatting. The
 * palette and the /search page get the same shape, so the two cannot show a
 * record differently. A row that has nowhere to open is not shown.
 */
import { chipOf } from '../domain/search';
import type { SearchGroup, SearchOutcome } from '../services/global-search';

export interface PresentedHit {
  readonly id: string;
  /** The number or code the record is known by (a file's name, for a file). */
  readonly number: string;
  readonly title: string | null;
  readonly party: string | null;
  /** Formatted for the reader's locale. */
  readonly date: string | null;
  readonly status: { readonly chip: string; readonly code: string; readonly label: string } | null;
  /** "1,250,000 IQD" — null where the asker may not see money for the type. */
  readonly amount: string | null;
  /** On a file: what it hangs on ("Purchase Invoice"). */
  readonly related: string | null;
  readonly href: string;
  /** Matched whole (the number, code or name is the phrase) or by its serial. */
  readonly exact: boolean;
}

export interface PresentedGroup {
  readonly key: string;
  readonly label: string;
  readonly rows: readonly PresentedHit[];
  readonly more: boolean;
}

export interface PresentedOutcome {
  readonly groups: readonly PresentedGroup[];
  /** Labels of the types that could not be searched this time. */
  readonly failed: readonly string[];
}

/** How the strings are made — supplied by the route or page (next-intl and `i18n/config`). */
export interface PresentDeps {
  readonly locale: string;
  typeLabel(key: string): string;
  /** The translation of a status code, or null when there is none. */
  statusLabel(code: string): string | null;
  date(iso: string): string;
  money(value: string, currency: string): string;
}

/** `pd_registered` → "Pd registered": the last resort for a code with no translation. */
export function humanise(code: string): string {
  const words = code.replace(/[_-]+/g, ' ').trim();
  return words.length === 0 ? words : words[0]!.toUpperCase() + words.slice(1);
}

function presentGroup(group: SearchGroup, deps: PresentDeps): PresentedGroup {
  const arabic = deps.locale.startsWith('ar');
  const rows: PresentedHit[] = [];
  for (const row of group.rows) {
    if (!row.href) continue;
    rows.push({
      id: row.id,
      number: row.number,
      title: (arabic ? row.titleAlt ?? row.title : row.title) ?? null,
      party: row.party,
      date: row.date ? deps.date(row.date) : null,
      status: row.status
        ? { chip: chipOf(row.status), code: row.status, label: deps.statusLabel(row.status) ?? humanise(row.status) }
        : null,
      amount: row.amount ? deps.money(row.amount.value, row.amount.currency) : null,
      related: row.relatedType ? deps.typeLabel(row.relatedType) : null,
      href: row.href,
      exact: row.tier <= 1,
    });
  }
  return { key: group.key, label: deps.typeLabel(group.key), rows, more: group.more };
}

export function present(outcome: SearchOutcome, deps: PresentDeps): PresentedOutcome {
  return {
    groups: outcome.groups.map((group) => presentGroup(group, deps)).filter((group) => group.rows.length > 0),
    failed: outcome.failed.map((key) => deps.typeLabel(key)),
  };
}
