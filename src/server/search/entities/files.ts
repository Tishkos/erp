/**
 * Files, by name.
 *
 * A file has no access of its own: it is seen by whoever could download it —
 * `view` on `attachment`, the row policy's branch, and the check its parent
 * record registered with the attachment service (`attachments-runtime.ts`), the
 * very one the download route asks. Here that check is run for each candidate
 * and a file it refuses is not returned, so a file name cannot be used to learn
 * that a record exists. The hit opens the record the file hangs on (where the
 * record is a registered type), because the file itself is behind that record's
 * paperclip; a parent the registry does not know opens the file.
 */
import { sql } from 'drizzle-orm';
import * as attachments from '../../services/attachments';
import { visibleRoute } from '../../delivered';
import { likeEscape, prefixUpperBound, rawVariants, TIER } from '../../domain/search';
import { searchTypes } from '../registry';
import { CONTAINS_WINDOW, describeByIds } from '../table-query';
import type { SearchCustomType, SearchRow, SearchTableType } from '../types';

/** Candidates read before the parents are asked; a refusal drops one, so more are read than shown. */
const CANDIDATES = 120;
const CANDIDATES_MAX = 600;

const lit = (n: number) => sql.raw(String(n));
const ESCAPE = sql.raw(`escape '\\'`);

export const attachmentFiles: SearchCustomType = {
  kind: 'custom',
  key: 'attachment',
  priority: 90,
  grant: { object: 'attachment' },
  async run(tx, request) {
    const { plan } = request;
    const { query } = plan;
    // The file table is under a row policy, which runs ahead of LIKE: so the name
    // is looked up as stored (as typed, upper and lower case, equal or beginning
    // with it — a plain btree, the whole table) and, folded, inside the newest
    // current files the asker may see (see table-query.ts).
    const begins = rawVariants(query).map((variant) => {
      const upper = prefixUpperBound(variant);
      return upper === null
        ? sql`a.file_name >= ${variant}`
        : sql`(a.file_name >= ${variant} and a.file_name < ${upper})`;
    });
    const contains = plan.contains
      ? sql.join(
          query.tokens.map(
            (token) => sql`search_fold(a.file_name) like '%' || search_fold(${likeEscape(token)}) || '%' ${ESCAPE}`,
          ),
          sql` and `,
        )
      : sql`search_fold(a.file_name) like search_fold(${likeEscape(query.display)}) || '%' ${ESCAPE}`;
    const current = sql`a.scan_status = 'clean' and a.superseded_by_id is null and a.disposed_at is null`;
    const take = Math.min(CANDIDATES_MAX, Math.max(CANDIDATES, (request.offset + request.limit + 1) * 3));
    const result = await tx.execute(sql`
      with found as (
        (select a.id, a.file_name, a.object_type, a.object_id, a.created_at
           from attachment a
          where ${current} and (${sql.join(begins, sql` or `)})
          order by a.created_at desc nulls last
          limit ${take})
        union
        (select a.id, a.file_name, a.object_type, a.object_id, a.created_at
           from (select * from attachment a where ${current} order by a.created_at desc nulls last limit ${sql.raw(String(CONTAINS_WINDOW))}) a
          where ${contains}
          limit ${take})
      )
      select f.id::text as id, f.file_name, f.object_type, f.object_id, f.created_at::date::text as date,
             case when search_fold(f.file_name) = search_fold(${query.display}) then ${lit(TIER.exact)}
                  when search_fold(f.file_name) like search_fold(${likeEscape(query.display)}) || '%' ${ESCAPE} then ${lit(TIER.prefix)}
                  else ${lit(TIER.contains)} end as tier
        from found f
       order by tier, f.created_at desc nulls last
       limit ${take}`);
    const candidates = result.rows as unknown as {
      id: string;
      file_name: string;
      object_type: string;
      object_id: string;
      date: string;
      tier: number;
    }[];

    // The same question the download asks of the record the file hangs on — asked of the
    // candidates in order, and only until the page (and one more, to know there is a next) is full.
    const need = request.offset + request.limit + 1;
    const allowed: typeof candidates = [];
    for (const candidate of candidates) {
      if (await attachments.mayAccessParent(tx, request.principal, candidate.object_type, candidate.object_id)) {
        allowed.push(candidate);
        if (allowed.length >= need) break;
      }
    }
    const page = allowed.slice(request.offset, request.offset + request.limit + 1);

    // The parents, described by the types that know them.
    const byType = new Map<string, SearchTableType>();
    for (const type of searchTypes()) {
      if (type.kind === 'table' && type.attachmentType) byType.set(type.attachmentType, type);
    }
    const parents = new Map<string, Map<string, { readonly number: string; readonly href: string | null }>>();
    for (const [objectType, type] of byType) {
      const ids = page.filter((row) => row.object_type === objectType).map((row) => row.object_id);
      if (ids.length > 0) parents.set(objectType, await describeByIds(tx, type, [...new Set(ids)]));
    }

    const rows: SearchRow[] = page.slice(0, request.limit).map((candidate) => {
      const parent = parents.get(candidate.object_type)?.get(candidate.object_id);
      const owner = byType.get(candidate.object_type);
      // The record opens only where its own screen is served; otherwise the file does.
      const opens = parent && owner && owner.route !== undefined && visibleRoute(owner.route) ? parent : undefined;
      return {
        id: candidate.id,
        number: candidate.file_name,
        title: opens?.number ?? null,
        titleAlt: null,
        status: null,
        date: candidate.date,
        party: null,
        amount: null,
        href: opens?.href ?? `/attachments/${candidate.id}`,
        tier: Number(candidate.tier),
        relatedType: opens && owner ? owner.key : null,
      };
    });
    return { rows, more: page.length > request.limit };
  },
};
