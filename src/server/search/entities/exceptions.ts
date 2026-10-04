/**
 * Exceptions — the Exception Center's record in Global Search (platform phase, Agent 7).
 *
 * Priority 52, among the documents, after the tasks. An exception is found by
 * its number (`EXC-0012`, `12`), by the English line the check stored for it
 * and by the number of the record it is about (`INV-1042`, a container, a
 * supplier). The table's row policy narrows what exists for the asker to the
 * grant on `exception`, the grant on the object it is about and the branch;
 * what SQL cannot say — whether the asker may open *that record* (a task is its
 * parties' alone) — is asked of each candidate, as a file's parent is, so a
 * search can never be the way to learn that a record the asker may not see has
 * a problem.
 */
import { sql } from 'drizzle-orm';
import { likeEscape, TIER } from '../../domain/search';
import { CONTAINS_WINDOW } from '../table-query';
import type { SearchCustomType, SearchRow } from '../types';

const CANDIDATES = 60;
const CANDIDATES_MAX = 300;
const ESCAPE = sql.raw(`escape '\\'`);
const lit = (n: number) => sql.raw(String(n));

export const exceptionType: SearchCustomType = {
  kind: 'custom',
  key: 'exception',
  priority: 52,
  grant: { object: 'exception' },
  route: '/exceptions',
  async run(tx, request) {
    const { plan } = request;
    const { query } = plan;
    const begins = sql`upper(e.exception_no) like ${likeEscape(query.upper)} || '%' ${ESCAPE}`;
    const labelBegins = sql`upper(e.record_label) like ${likeEscape(query.upper)} || '%' ${ESCAPE}`;
    const contains = plan.contains
      ? sql`or ${sql.join(
          query.tokens.map(
            (token) =>
              sql`(search_fold(e.title) like '%' || search_fold(${likeEscape(token)}) || '%' ${ESCAPE} or search_fold(e.record_label) like '%' || search_fold(${likeEscape(token)}) || '%' ${ESCAPE})`,
          ),
          sql` and `,
        )}`
      : sql``;
    const take = Math.min(CANDIDATES_MAX, Math.max(CANDIDATES, (request.offset + request.limit + 1) * 3));
    const result = await tx.execute(sql`
      select * from (
        select e.id::text as id, e.exception_no, e.title, e.status, e.record_label, e.record_type, e.record_id,
               e.permission_object, e.owner_user_id::text as owner_user_id, e.last_seen_at::date::text as date, e.last_seen_at,
               case when upper(e.exception_no) = ${query.upper} then ${lit(TIER.exact)}
                    when ${begins} then ${lit(TIER.prefix)}
                    when ${labelBegins} then ${lit(TIER.prefix)}
                    else ${lit(TIER.contains)} end as tier
          from (select * from exception order by last_seen_at desc limit ${sql.raw(String(CONTAINS_WINDOW))}) e
         where ${begins} or ${labelBegins} ${contains}
      ) found
      order by tier, last_seen_at desc
      limit ${take}`);
    const candidates = result.rows as unknown as {
      id: string;
      exception_no: string;
      title: string;
      status: string;
      record_label: string;
      record_type: string;
      record_id: string;
      permission_object: string;
      owner_user_id: string | null;
      date: string;
      tier: number;
    }[];

    // Loaded when asked: the service imports the record registry, which imports the search's callers.
    const { recordVisible } = await import('../../services/exceptions');
    const need = request.offset + request.limit + 1;
    const memo = new Map<string, boolean>();
    const allowed: typeof candidates = [];
    for (const candidate of candidates) {
      const visible = await recordVisible(
        tx,
        request.principal,
        { permissionObject: candidate.permission_object, recordType: candidate.record_type, recordId: candidate.record_id, ownerUserId: candidate.owner_user_id },
        memo,
      );
      if (visible) {
        allowed.push(candidate);
        if (allowed.length >= need) break;
      }
    }
    const page = allowed.slice(request.offset, request.offset + request.limit + 1);
    const rows: SearchRow[] = page.slice(0, request.limit).map((candidate) => ({
      id: candidate.id,
      number: candidate.exception_no,
      title: candidate.title,
      titleAlt: null,
      status: candidate.status,
      date: candidate.date,
      party: candidate.record_label,
      amount: null,
      href: `/exceptions/${encodeURIComponent(candidate.exception_no)}`,
      tier: Number(candidate.tier),
    }));
    return { rows, more: page.length > request.limit };
  },
};
