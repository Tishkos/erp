/**
 * One table type's query.
 *
 * Built in pieces, each an index-friendly read of the table alone:
 *
 *   number   `number` equal to a candidate, or beginning with it as the range
 *            `number >= 'X' and number < 'Y'` — the btree the number is already
 *            unique on (the database is collated C)
 *   serial   `number in (document numbers of these series with this serial)` —
 *            "AP-12" is serial 12 of the series whose prefix begins AP, found in
 *            doc_number_allocation (0330 indexes its serial)
 *   text     `search_fold(column)` equal / beginning / containing the phrase
 *   party    the table's rows whose party (supplier, customer) is named like the
 *            phrase — the party found in business_partner first, small and
 *            indexed, then the rows by their foreign key
 *
 * **Row-level security decides how text is read.** A table under a row policy
 * (almost every document) has the policy applied *before* the query's own
 * conditions, and PostgreSQL lets only leakproof operators run ahead of it:
 * `=`, `<`, `>=` are, LIKE, `lower()`, `search_fold()` and the trigram operators
 * are not — so on such a table they can never be an index condition, however
 * good the index, and become a filter over every row the person may see. Hence:
 *
 *   • numbers and references are looked up with comparisons only — equal or in
 *     a prefix range, over the spellings a person may have typed (`rawVariants`)
 *     — on plain btrees, across the whole table;
 *   • a name or description is matched folded, with LIKE, inside a window: the
 *     newest `CONTAINS_WINDOW` rows the person may see (`type.recent`), read by
 *     index, not the table;
 *   • a table with no row policy (the masters) keeps its trigram index and is
 *     matched whole.
 *
 * Each piece names the ids it finds with the tier it earns and a cap; the ids
 * are then joined back to the table once, for display and ordering. Nothing is
 * a count, a scan of the whole table, or a join in the predicate — and because
 * every piece reads `t` as the asker, the table's row policy answers for the
 * branch before anything is returned.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { allocationFilters, likeEscape, prefixUpperBound, rawVariants, TIER, type QueryPlan } from '../domain/search';
import type { SearchRow, SearchTableType, TypeRequest, TypeResult } from './types';

/** The most ids any one piece contributes before the page is cut. */
const BRANCH_FLOOR = 50;
const PARTIES = 50;
/**
 * On a table under row-level security a name is matched inside this many of the
 * newest rows the asker may see (an index scan in date order, stopped here) —
 * the cost of a keystroke is then bounded by this, not by the size of the table.
 */
export const CONTAINS_WINDOW = 10000;

const ESCAPE = sql.raw(`escape '\\'`);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fold = (value: string): SQL => sql`search_fold(${value})`;

/** A tier as a literal: an untyped parameter inside `case … end` would be read as text and refuse to union with the others. */
const lit = (tier: number): SQL => sql.raw(String(tier));

/** `col like <pattern> escape '\'`, where the pattern is built from a folded, escaped phrase. */
function likeFolded(column: SQL, escaped: string, before: string, after: string): SQL {
  const pattern = sql`${sql.raw(`'${before}'`)} || search_fold(${escaped}) || ${sql.raw(`'${after}'`)}`;
  return sql`search_fold(${column}) like ${pattern} ${ESCAPE}`;
}

/** The text predicate: every word inside the column (a phrase of three characters or more), else the phrase as its beginning. */
function textMatch(column: SQL, plan: QueryPlan): SQL {
  const { query } = plan;
  if (plan.contains) {
    const words = query.tokens.map((token) => likeFolded(column, likeEscape(token), '%', '%'));
    return sql`(${sql.join(words, sql` and `)})`;
  }
  return likeFolded(column, likeEscape(query.display), '', '%');
}

/** 0 the whole column is the phrase · 2 it begins with it · 3 it is somewhere inside. */
function textTier(column: SQL, plan: QueryPlan): SQL {
  const { query } = plan;
  return sql`case when search_fold(${column}) = ${fold(query.display)} then ${lit(TIER.exact)}
                  when ${likeFolded(column, likeEscape(query.display), '', '%')} then ${lit(TIER.prefix)}
                  else ${lit(TIER.contains)} end`;
}

function inList(values: readonly string[]): SQL {
  return sql.join(values.map((value) => sql`${value}`), sql`, `);
}

/** `column` begins with `prefix`, as the two comparisons a btree answers and a row policy lets through. */
function beginsWith(column: SQL, prefix: string): SQL {
  const upper = prefixUpperBound(prefix);
  return upper === null ? sql`${column} >= ${prefix}` : sql`(${column} >= ${prefix} and ${column} < ${upper})`;
}

function anyBeginsWith(column: SQL, prefixes: readonly string[]): SQL {
  return sql`(${sql.join(prefixes.map((prefix) => beginsWith(column, prefix)), sql` or `)})`;
}

function cap(request: TypeRequest): number {
  return Math.max(BRANCH_FLOOR, request.offset + request.limit + 1);
}

/** The newest rows the asker may see, in date order — what a name is matched inside on a table under a row policy. */
function windowOf(type: SearchTableType): SQL {
  const fixed = type.where ? sql` where ${type.where}` : sql``;
  const recent = type.recent ? sql` order by ${type.recent} desc nulls last` : sql``;
  return sql`(select t.* from ${sql.raw(type.table)} t${fixed}${recent} limit ${sql.raw(String(CONTAINS_WINDOW))})`;
}

function branch(type: SearchTableType, request: TypeRequest, tier: SQL, predicate: SQL, source?: SQL): SQL {
  const fixed = type.where ? sql`${type.where} and ` : sql``;
  const recent = type.recent ? sql`order by ${type.recent} desc nulls last` : sql``;
  return sql`(select ${type.id} as id, ${tier} as tier
                from ${source ?? sql.raw(type.table)} t
               where ${fixed}${predicate}
               ${recent}
               limit ${cap(request)})`;
}

/**
 * @param rls  the table is under a row policy (see the header): references by
 *             comparison, names inside the window. False: the trigram index.
 */
export function branchesOf(type: SearchTableType, request: TypeRequest, rls: boolean): SQL[] {
  const { plan } = request;
  const { query } = plan;
  const branches: SQL[] = [];
  const number = type.number;

  // The number or code: equal to the phrase as a number is written, equal to its serial padded as an
  // unscoped series would pad it (SUP-1 for SUP-00001), or beginning with the phrase.
  const candidates = inList(query.numberCandidates);
  const padded = plan.padded.filter((value) => !query.numberCandidates.includes(value));
  const equal = padded.length > 0 ? sql`${candidates}, ${inList(padded)}` : candidates;
  const tier =
    padded.length > 0
      ? sql`case when ${number} in (${candidates}) then ${lit(TIER.exact)} when ${number} in (${inList(padded)}) then ${lit(TIER.serial)} else ${lit(TIER.prefix)} end`
      : sql`case when ${number} in (${candidates}) then ${lit(TIER.exact)} else ${lit(TIER.prefix)} end`;
  branches.push(branch(type, request, tier, sql`(${number} in (${equal}) or ${anyBeginsWith(number, [...query.numberCandidates])})`));

  // "AP-12": serial 12 of the series this type owns whose prefix is, or begins with, AP.
  if (plan.shape && type.series && type.series.length > 0) {
    const own = new Set(type.series);
    const filters = allocationFilters(plan.shape);
    const lookup = (keys: readonly string[]): SQL => {
      const narrowing = [
        filters.branch ? sql` and document_no like ${filters.branch} ${ESCAPE}` : sql``,
        filters.year ? sql` and document_no like ${filters.year} ${ESCAPE}` : sql``,
      ];
      return sql`${number} in (select document_no from doc_number_allocation
                                where sequence_key in (${inList(keys)}) and serial = ${plan.shape!.serial.toString()}::bigint${narrowing[0]}${narrowing[1]})`;
    };
    const exact = plan.series.exact.filter((key) => own.has(key));
    const partial = (plan.series.any ? [...own] : plan.series.partial.filter((key) => own.has(key)));
    if (exact.length > 0) branches.push(branch(type, request, lit(TIER.serial), lookup(exact)));
    if (partial.length > 0) branches.push(branch(type, request, lit(TIER.prefix), lookup(partial)));
  }

  const text = type.text ?? [];
  if (!rls) {
    for (const column of text) {
      branches.push(branch(type, request, textTier(column, plan), textMatch(column, plan)));
    }
  } else {
    // The references, as stored, across the whole table.
    const variants = rawVariants(query);
    for (const column of type.refs ?? []) {
      branches.push(branch(type, request, textTier(column, plan), anyBeginsWith(column, variants)));
    }
    // The names, folded, inside the newest rows: one pass for all the columns.
    if (text.length > 0) {
      const tiers = text.map((column) => textTier(column, plan));
      const best = tiers.length === 1 ? tiers[0]! : sql`least(${sql.join(tiers, sql`, `)})`;
      const match = sql.join(text.map((column) => textMatch(column, plan)), sql` or `);
      branches.push(branch(type, request, best, sql`(${match})`, windowOf(type)));
    }
  }

  // "Al Noor": the documents of a party so named — below any hit on the record itself.
  if (type.partyKey && plan.contains) {
    branches.push(
      branch(
        type,
        request,
        lit(TIER.party),
        sql`${type.partyKey} in (select p.id from business_partner p
                                  where ${textMatch(sql`p.legal_name`, plan)} or ${textMatch(sql`p.trade_name`, plan)}
                                  limit ${PARTIES})`,
      ),
    );
  }
  return branches;
}

interface Raw {
  id: string;
  number: string;
  title: string | null;
  title_alt: string | null;
  status: string | null;
  date: string | null;
  party: string | null;
  amount_value: string | null;
  amount_currency: string | null;
  tier: number;
  [extra: string]: unknown;
}

/** The type's whole query as one statement (exported so the plan can be read: `explain` it). */
export function tableQuery(type: SearchTableType, request: TypeRequest, rls: boolean): SQL {
  const branches = branchesOf(type, request, rls);
  const extras = Object.entries(type.extras ?? {}).map(([name, expression]) => sql`, (${expression})::text as ${sql.raw(`x_${name}`)}`);
  const amount = type.amount && request.mayAmount
    ? sql`(${type.amount.value})::text as amount_value, (${type.amount.currency})::text as amount_currency`
    : sql`null::text as amount_value, null::text as amount_currency`;
  // A type with no date has none to order by (`order by null` is refused).
  const ordering = type.date ? sql`best.tier, ${type.date} desc nulls last, ${type.number}` : sql`best.tier, ${type.number}`;
  return sql`
    with hits as (${sql.join(branches, sql` union all `)}),
         best as (select id, min(tier) as tier from hits group by id)
    select (${type.id})::text as id,
           (${type.number})::text as number,
           ${type.title ?? sql`null::text`} as title,
           ${type.titleAlt ?? sql`null::text`} as title_alt,
           (${type.status ?? sql`null`})::text as status,
           (${type.date ?? sql`null`})::text as date,
           ${type.party ?? sql`null::text`} as party,
           ${amount}${sql.join(extras, sql``)},
           best.tier as tier
      from best
      join ${sql.raw(type.table)} t on ${type.id} = best.id
      ${type.joins ?? sql``}
     order by ${ordering}
     limit ${request.limit + 1} offset ${request.offset}`;
}

let policed: Promise<ReadonlySet<string>> | null = null;

/**
 * The tables that have a row policy switched on, read once from the catalog
 * (the application role may read `pg_class`). A migration that adds or drops
 * one is followed by a restart, as every deployment is.
 */
export function rowSecurityTables(tx: Tx): Promise<ReadonlySet<string>> {
  policed ??= tx
    .execute(sql`select c.relname from pg_class c where c.relnamespace = current_schema()::regnamespace and c.relkind in ('r', 'p') and c.relrowsecurity`)
    .then((result) => new Set((result.rows as unknown as { relname: string }[]).map((row) => row.relname)))
    .catch((error) => {
      policed = null;
      throw error;
    });
  return policed;
}

/** Forgets what `rowSecurityTables` read (tests that change a table's policy). */
export function forgetRowSecurityTables(): void {
  policed = null;
}

/** Runs one table type for the asker; the row policy of the table has already narrowed to their branches. */
export async function runTableType(tx: Tx, type: SearchTableType, request: TypeRequest): Promise<TypeResult> {
  const rls = (await rowSecurityTables(tx)).has(type.table);
  const result = await tx.execute(tableQuery(type, request, rls));
  const raws = result.rows as unknown as Raw[];
  const rows: SearchRow[] = raws.slice(0, request.limit).map((raw) => {
    const extraValues: Record<string, string | null> = {};
    for (const name of Object.keys(type.extras ?? {})) extraValues[name] = (raw[`x_${name}`] as string | null) ?? null;
    return {
      id: raw.id,
      number: raw.number,
      title: raw.title,
      titleAlt: raw.title_alt,
      status: raw.status,
      date: raw.date,
      party: raw.party,
      amount: raw.amount_value !== null && raw.amount_currency !== null ? { value: raw.amount_value, currency: raw.amount_currency } : null,
      href: type.href({ id: raw.id, number: raw.number, extras: extraValues }),
      tier: Number(raw.tier),
    };
  });
  return { rows, more: raws.length > request.limit };
}

/**
 * What a handful of known records look like — the parents of the files a search
 * found, shown beside the file ("API-HQ-2026-000012 · Purchase Invoice") and
 * opened instead of it. `ids` are the keys the attachment table names them by.
 */
export async function describeByIds(
  tx: Tx,
  type: SearchTableType,
  ids: readonly string[],
): Promise<Map<string, { readonly number: string; readonly href: string | null }>> {
  const found = new Map<string, { readonly number: string; readonly href: string | null }>();
  if (ids.length === 0) return found;
  const extras = Object.entries(type.extras ?? {}).map(([name, expression]) => sql`, (${expression})::text as ${sql.raw(`x_${name}`)}`);
  const fixed = type.where ? sql`${type.where} and ` : sql``;
  // By the key itself, not `key::text`: a cast on the column cannot use the primary key's index.
  // (A uuid column reads the parameters as uuids; a value that is not one belongs to no record.)
  const keys = type.textId ? ids : ids.filter((id) => UUID.test(id));
  if (keys.length === 0) return found;
  const result = await tx.execute(sql`
    select (${type.id})::text as id, (${type.number})::text as number${sql.join(extras, sql``)}
      from ${sql.raw(type.table)} t
     where ${fixed}${type.id} in (${inList(keys)})`);
  for (const raw of result.rows as unknown as Raw[]) {
    const extraValues: Record<string, string | null> = {};
    for (const name of Object.keys(type.extras ?? {})) extraValues[name] = (raw[`x_${name}`] as string | null) ?? null;
    found.set(raw.id, { number: raw.number, href: type.href({ id: raw.id, number: raw.number, extras: extraValues }) });
  }
  return found;
}
