/**
 * The shapes a searchable record type is declared in.
 *
 * One registry (`registry.ts`), many declarations (`entities/`): each says
 * which table holds the records, which grant lets a person see them, how a
 * match is displayed and where it opens. The service (`services/global-search`)
 * turns a declaration into queries run **as the asker** — the table's row
 * policy decides the branch, the grant is checked first and a type the asker
 * may not view is never queried, so it cannot be discovered by a count or by
 * another field matching.
 *
 * A module that adds a record type declares it here and registers it
 * (`registerSearchType`); nothing else in the search changes. See
 * docs/audits/GLOBAL-SEARCH-IMPLEMENTATION.md › "What the next agents need".
 */
import type { SQL } from 'drizzle-orm';
import type { Tx } from '../db/client';
import type { PermissionVerb, Principal } from '../domain/permissions';
import type { QueryPlan } from '../domain/search';

/** A permission: a verb (default `view`) on an object. */
export interface SearchGrant {
  readonly object: string;
  readonly verb?: PermissionVerb;
}

/** One match, as the declaration's query returns it (nothing here is translated). */
export interface SearchRow {
  /** The record's id as the attachment table names it (`object_id`): its uuid, or its code. */
  readonly id: string;
  /** The number or code the record is known by — what the row is headed with. */
  readonly number: string;
  /** Its name or description. */
  readonly title: string | null;
  /** …in Arabic, where the record keeps one (an employee). */
  readonly titleAlt: string | null;
  /** The status code — shown through a translation, never as it stands. */
  readonly status: string | null;
  /** A business date (`YYYY-MM-DD`). */
  readonly date: string | null;
  /** The party the record names — supplier, customer, bank. */
  readonly party: string | null;
  /** The figure and its currency; null where the asker may not see money for this type. */
  readonly amount: { readonly value: string; readonly currency: string } | null;
  /** Where it opens; null when the type has no page for it. */
  readonly href: string | null;
  /** How good the match is (`TIER`). */
  readonly tier: number;
  /** Set on a file: the type of the record it hangs on (a key of the registry). */
  readonly relatedType?: string | null;
}

/** A page of one type's matches. */
export interface TypeResult {
  readonly rows: readonly SearchRow[];
  /** More matches exist than `rows` holds. */
  readonly more: boolean;
}

/** What a type is asked: the plan, how many to return, how many to skip. */
export interface TypeRequest {
  readonly plan: QueryPlan;
  readonly limit: number;
  readonly offset: number;
  /** May the asker see money for this type (its `amount.grant`, or its own)? */
  readonly mayAmount: boolean;
  readonly principal: Principal;
}

interface SearchTypeBase {
  /** Stable key — also the translation key `search.types.<key>`. */
  readonly key: string;
  /**
   * Where the type sits among equals: smaller is earlier. Master records
   * (customers, suppliers…) are 10–29, documents 30–59, logistics 60–79, files 90.
   */
  readonly priority: number;
  /** The grant that lets the asker see these records at all. */
  readonly grant: SearchGrant;
  /**
   * The list screen of the type. The type is searched only where that screen is
   * served (`visibleRoute`) — a result must open. A type with no screen of its
   * own (files, which open the record they hang on) leaves it out.
   */
  readonly route?: string;
}

/** The common case: a table, read as the asker. */
export interface SearchTableType extends SearchTypeBase {
  readonly kind: 'table';
  /** The table, aliased `t` in every expression below. */
  readonly table: string;
  /** A fixed condition on `t` (e.g. `t.is_customer`). */
  readonly where?: SQL;
  /** The column the table is keyed on, as the attachment table names it: `t.id` (uuid) or `t.code`. */
  readonly id: SQL;
  /** `id` is a text code (a project's, a warehouse's), not a uuid — a file's parent is then looked up by the text itself. */
  readonly textId?: boolean;
  /** Where a file named `object_type = <this>` hangs: the key it carries. */
  readonly attachmentType?: string;
  /** `doc_sequence` keys of the series whose numbers `number` holds ("AP-12" finds serial 12 of these). */
  readonly series?: readonly string[];
  /** The number or code column (a plain `t.column`): matched exactly and by prefix, shown first. */
  readonly number: SQL;
  /** Text columns matched folded — equal, beginning with, containing the phrase. */
  readonly text?: readonly SQL[];
  /**
   * References people are handed with the paper (a supplier's invoice number, a
   * bank's reference) that have a **plain btree index on the column itself**.
   * On a table under row-level security the trigram index cannot be used (the
   * policy runs first and LIKE may not go ahead of it), so these are looked up
   * as stored — as typed, upper and lower case, equal or beginning with — across
   * the whole table; `text` is then matched inside the newest rows only. A
   * table with no row policy ignores this: its trigram index answers everything.
   */
  readonly refs?: readonly SQL[];
  /** The foreign key to `business_partner` whose name is also matched (documents of "Al Noor"), as `t.supplier_id`. */
  readonly partyKey?: SQL;
  /** Joins for the display columns only (they never take part in matching). */
  readonly joins?: SQL;
  readonly title?: SQL;
  readonly titleAlt?: SQL;
  readonly status?: SQL;
  readonly date?: SQL;
  /** A column of `t` alone that orders the newest first inside the matching (the date, usually); without it the cap is arbitrary. */
  readonly recent?: SQL;
  readonly party?: SQL;
  readonly amount?: {
    readonly value: SQL;
    readonly currency: SQL;
    /** The grant that shows money for this type, where it is not the record's own. */
    readonly grant?: SearchGrant;
  };
  /** Further columns the page address needs (a PD's year, a container's id). */
  readonly extras?: Readonly<Record<string, SQL>>;
  readonly href: (row: { readonly id: string; readonly number: string; readonly extras: Readonly<Record<string, string | null>> }) => string | null;
}

/** The escape hatch: a type that cannot be one table (files, whose access is the parent's). */
export interface SearchCustomType extends SearchTypeBase {
  readonly kind: 'custom';
  readonly run: (tx: Tx, request: TypeRequest) => Promise<TypeResult>;
}

export type SearchType = SearchTableType | SearchCustomType;
