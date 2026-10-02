/**
 * REQ-IMPROVE-001 IM6 — an export over the cap says so, and a file is
 * rendered outside the transaction that read it.
 *
 * The registry is replaced by one report whose row count the test chooses,
 * so the cap is exercised on the cap's own terms: a model one row over it is
 * refused with the count and the cap, a model at the cap is served, and the
 * refusal is a sentence in the reader's language on the route. The
 * after-commit rule is held by the shape of `prepareExport`: what it returns
 * carries no file, only the model and the letterhead; `renderExport` makes
 * the file from those alone, with no transaction in reach. The one export
 * that used to stop quietly at its list's page size (stock movements) reads
 * one row past the cap instead, so it is refused rather than cut short.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ownerPool, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { EXPORT_ROW_CAP, rowsIn, type PrintModel } from '@/server/print/model';
import { messagesFor } from '@/server/print/i18n';

let rowsToBuild = 0;

vi.mock('@/server/print/registry', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/server/print/registry')>();
  const model = (rows: number): PrintModel => ({
    kind: 'report',
    title: 'Capped report',
    orientation: 'portrait',
    fields: [],
    filters: [],
    tables: [
      {
        title: 'Rows',
        columns: [{ key: 'n', label: 'N', kind: 'text' }],
        rows: Array.from({ length: rows }, (_, i) => ({ cells: { n: String(i + 1) } })),
        empty: 'none',
      },
    ],
    summary: [],
    signatures: false,
    currency: 'IQD',
    fileName: 'capped',
    sheetName: 'Rows',
  });
  return {
    ...original,
    exportable: (key: string) =>
      key === 'trial_balance'
        ? {
            key,
            kind: 'report',
            route: '/finance/trial-balance',
            object: 'trial_balance',
            build: async () => ({ model: model(rowsToBuild), branchCode: 'BGW', objectId: 'trial_balance' }),
          }
        : original.exportable(key as never),
  };
});

const { prepareExport, renderExport, runExport } = await import('@/server/print/export');

const BRANCH = 'BGW';
let manager: ActorContext;

async function createUser(branch: string, ...roles: string[]): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [id, `${id}@example.com`, 'Manager']);
  for (const role of roles) await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, branch]);
  await ownerPool.query(`insert into user_department_scope (user_id, department_code) values ($1,'FIN') on conflict do nothing`, [id]);
  const principal = await withScope({ userId: id, branchCode: branch }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: branch };
}

beforeAll(async () => {
  await resetTestData();
  await seedBranch(BRANCH, 'Baghdad');
  await ownerPool.query(`insert into department (code, name, is_finance) values ('FIN','Finance',true) on conflict do nothing`);
  manager = await createUser(BRANCH, 'accounting_manager');
});

const request = (format: 'pdf' | 'xlsx' | 'docx', locale: 'en' | 'ar' = 'en') => ({
  key: 'trial_balance' as const,
  format,
  locale,
  at: '2026-10-01T08:00:00.000Z',
  input: { id: null, query: new URLSearchParams({ from: '2026-01-01', to: '2026-12-31' }) },
});

const inScope = <T,>(work: (tx: Parameters<Parameters<typeof withScope>[1]>[0]) => Promise<T>) =>
  withScope({ userId: manager.principal.userId, branchCode: BRANCH }, work);

describe('IM6 · the export cap', () => {
  it('is a real number, large enough for a year of movements', () => {
    expect(EXPORT_ROW_CAP).toBeGreaterThanOrEqual(10_000);
  });

  it('serves a model at the cap, and hands back no file until the render', async () => {
    rowsToBuild = EXPORT_ROW_CAP;
    const prepared = await inScope((tx) => prepareExport(tx, manager, request('xlsx')));
    expect(prepared.status).toBe(200);
    if (prepared.status !== 200) return;
    expect(rowsIn(prepared.model)).toBe(EXPORT_ROW_CAP);
    expect('body' in prepared).toBe(false);
    const body = await renderExport(prepared);
    expect(body.subarray(0, 2).toString()).toBe('PK');
    const copies = await ownerPool.query(`select count(*)::int as n from audit_event where action = 'trial_balance.exported' and outcome = 'success'`);
    expect(copies.rows[0].n).toBe(1);
  });

  it('refuses a model one row over the cap, naming the count and the cap, and records no copy', async () => {
    rowsToBuild = EXPORT_ROW_CAP + 1;
    const result = await inScope((tx) => prepareExport(tx, manager, request('pdf')));
    expect(result.status).toBe(413);
    if (result.status !== 413) return;
    expect(result.cap).toBe(EXPORT_ROW_CAP);
    expect(result.rows).toBe(EXPORT_ROW_CAP + 1);
    const copies = await ownerPool.query(`select count(*)::int as n from audit_event where action = 'trial_balance.exported' and outcome = 'success'`);
    expect(copies.rows[0].n).toBe(1);
    // What the route answers, in both languages.
    const en = messagesFor('en').print('too_many_rows', { rows: result.rows, cap: result.cap });
    const ar = messagesFor('ar').print('too_many_rows', { rows: result.rows, cap: result.cap });
    expect(en).toContain('Narrow the filters');
    expect(ar).toContain('ضيّق');
  });

  it('counts the rows of every table in a model, not only the first', () => {
    const model = {
      tables: [{ rows: [{}, {}] }, { rows: [{}] }],
    } as unknown as PrintModel;
    expect(rowsIn(model)).toBe(3);
  });

  it('runExport still answers in one call for scripts and the older tests', async () => {
    rowsToBuild = 3;
    const result = await inScope((tx) => runExport(tx, manager, request('docx')));
    expect(result.status).toBe(200);
    if (result.status === 200) expect(result.body.length).toBeGreaterThan(1000);
  });

  it('the stock-movement export reads past the cap instead of stopping at the page size', () => {
    const source = readFileSync(join(process.cwd(), 'src/server/print/reports.ts'), 'utf8');
    expect(source).toMatch(/stock\.movements\([^;]*limit: EXPORT_ROW_CAP \+ 1/);
    const route = readFileSync(join(process.cwd(), 'src/server/print/route.ts'), 'utf8');
    // The route renders after withCurrentUser has returned — outside the transaction.
    expect(route.indexOf('await withCurrentUser')).toBeLessThan(route.indexOf('renderExport(prepared)'));
    expect(route).not.toContain('runExport(');
  });
});
