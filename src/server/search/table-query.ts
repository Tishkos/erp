/**
 * One table type's query.
 *
 * Built in pieces, each an index-friendly read of the table alone:
 *
 *   number   `number = any candidate` or `number like 'PREFIX%'` — the btree the
 *            number is already unique on (the database is collated C)
 *   serial   `number in (document numbers of these series with this serial)` —
 *            "AP-12" is serial 12 of the series whose prefix begins AP, found in
 *            doc_number_allocation (0330 indexes its serial)
 *   text     `search_fold(column)` equal / beginning / containing the phrase, on
 *            the trigram index 0330 built for exactly that expression
 *   party    the table's rows whose party (supplier, customer) is named like the
 *            phrase — the party found in business_partner first, small and
 *            indexed, then the rows by their foreign key
 *
 * Each piece names the ids it finds with the tier it earns and a cap; the ids
 * are then joined back to the table once, for display and ordering. Nothing is
 * a count, a scan of the whole table, or a join in the predicate — and because
 * every piece reads `t` as the asker, the table's row policy answers for the
 * branch before anything is returned.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { allocationFilters, likeEscape, TIER, type QueryPlan } from '../domain/search';
import type { SearchRow, SearchTableType, TypeRequest, TypeResult } from './types';

/** The most ids any one piece contributes before the page is cut. */
const BRANCH_FLOOR = 50;
const PARTIES = 50;

const ESCAPE = sql.raw(`escape '\\'`);

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

function cap(request: TypeRequest): number {
  return Math.max(BRANCH_FLOOR, request.offset + request.limit + 1);
}

function branch(type: SearchTableType, request: TypeRequest, tier: SQL, predicate: SQL): SQL {
  const fixed = type.where ? sql`${type.where} and ` : sql``;
  const recent = type.recent ? sql`order by ${type.recent} desc nulls last` : sql``;
  return sql`(select ${type.id} as id, ${tier} as tier
                from ${sql.raw(type.table)} t
               where ${fixed}${predicate}
               ${recent}
               limit ${cap(request)})`;
}

export function branchesOf(type: SearchTableType, request: TypeRequest): SQL[] {
  const { plan } = request;
  const { query } = plan;
  const branches: SQL[] = [];
  const number = type.number;

  // The number or code: equal to the phrase as a number is written, or beginning with it.
  const candidates = inList(query.numberCandidates);
  const begins = query.numberCandidates.map((candidate) => sql`${number} like ${`${likeEscape(candidate)}%`} ${ESCAPE}`);
  branches.push(
    branch(
      type,
      request,
      sql`case when ${number} in (${candidates}) then ${lit(TIER.exact)} else ${lit(TIER.prefix)} end`,
      sql`(${number} in (${candidates}) or ${sql.join(begins, sql` or `)})`,
    ),
  );

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

  for (const column of type.text ?? []) {
    branches.push(branch(type, request, textTier(column, plan), textMatch(column, plan)));
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

/** Runs one table type for the asker; the row policy of the table has already narrowed to their branches. */
export async function runTableType(tx: Tx, type: SearchTableType, request: TypeRequest): Promise<TypeResult> {
  const branches = branchesOf(type, request);
  const extras = Object.entries(type.extras ?? {}).map(([name, expression]) => sql`, (${expression})::text as ${sql.raw(`x_${name}`)}`);
  const amount = type.amount && request.mayAmount
    ? sql`(${type.amount.value})::text as amount_value, (${type.amount.currency})::text as amount_currency`
    : sql`null::text as amount_value, null::text as amount_currency`;
  const ordering = type.date ?? sql`null`;
  const result = await tx.execute(sql`
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
     order by best.tier, ${ordering} desc nulls last, ${type.number}
     limit ${request.limit + 1} offset ${request.offset}`);
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
  const result = await tx.execute(sql`
    select (${type.id})::text as id, (${type.number})::text as number${sql.join(extras, sql``)}
      from ${sql.raw(type.table)} t
     where ${fixed}(${type.id})::text in (${inList(ids)})`);
  for (const raw of result.rows as unknown as Raw[]) {
    const extraValues: Record<string, string | null> = {};
    for (const name of Object.keys(type.extras ?? {})) extraValues[name] = (raw[`x_${name}`] as string | null) ?? null;
    found.set(raw.id, { number: raw.number, href: type.href({ id: raw.id, number: raw.number, extras: extraValues }) });
  }
  return found;
}
