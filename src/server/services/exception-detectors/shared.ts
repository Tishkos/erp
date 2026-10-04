/**
 * What every detector is given and the few helpers they share — platform
 * phase, Agent 7.
 *
 * A detector is a function from "now" to the list of things that are wrong.
 * It READS, through the services that already know how to ask, in a
 * transaction PostgreSQL holds read-only (`exceptions.sweep` sets it): it
 * cannot write a business row even by mistake. It returns findings; the
 * sweep persists them in a separate transaction.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../../db/client';
import type { Principal } from '../../domain/permissions';
import type { Finding } from '../../domain/exceptions';

export interface DetectContext {
  readonly tx: Tx;
  /** The system operator: a super user, so the services' own permission checks pass and every branch is read. */
  readonly principal: Principal;
  /** The business day. */
  readonly today: string;
  readonly now: Date;
  /** A detector that could show only part of what it found says so here (detector code → how many exist, how many it returned). */
  readonly truncated: Map<string, { total: number; shown: number }>;
}

export type Runner = (ctx: DetectContext) => Promise<Finding[]>;

export const rowsOf = <T>(result: unknown): T[] => (result as { rows: T[] }).rows;

export const ZERO = /^-?0*(\.0*)?$/;
/** Is this decimal string zero? */
export const isZero = (value: string | null | undefined): boolean => ZERO.test((value ?? '0').trim());

/** `YYYY-MM-DD` from a date column that came back as text or a Date. */
export const dateText = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
};

/** A warehouse's branch, name and responsible person, by code. */
export async function warehouseBranches(tx: Tx): Promise<Map<string, { branchCode: string; name: string; responsibleUserId: string | null }>> {
  const rows = rowsOf<{ code: string; branch_code: string; name: string; responsible_user_id: string | null }>(
    await tx.execute(sql`select code, branch_code, name, responsible_user_id::text from warehouse`),
  );
  return new Map(rows.map((r) => [r.code, { branchCode: r.branch_code, name: r.name, responsibleUserId: r.responsible_user_id }]));
}

/** Item names by code, for the codes asked. */
export async function itemNames(tx: Tx, codes: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(codes)];
  if (unique.length === 0) return new Map();
  const rows = rowsOf<{ code: string; name: string }>(
    await tx.execute(sql`select code, name from item where code in (${sql.join(unique.map((c) => sql`${c}`), sql`, `)})`),
  );
  return new Map(rows.map((r) => [r.code, r.name]));
}

/** Display names of users, by id. */
export async function userNames(tx: Tx, ids: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map();
  const rows = rowsOf<{ id: string; display_name: string }>(
    await tx.execute(sql`select id, display_name from app_user where id in (${sql.join(unique.map((id) => sql`${id}::uuid`), sql`, `)})`),
  );
  return new Map(rows.map((r) => [r.id, r.display_name]));
}

export const enc = encodeURIComponent;
