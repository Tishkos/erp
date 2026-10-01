/**
 * Phase 01.12 test gate — the list framework against a real database.
 *
 * *"Every list supports search, filter, sort, saved views and export, and each
 * respects permission and data scope."*
 * *"Export returns exactly the rows the on-screen list would return for that
 * user — no more."*
 *
 * The domain rules are unit-tested; what needs a database is whether the
 * compiled SQL actually filters, sorts and scopes — and whether a saved view
 * opened by a second person runs as *them*.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { withScope } from '../../src/server/db/client';
import { registerAllLists } from '../../src/server/lists';
import * as list from '../../src/server/services/list';
import * as savedViews from '../../src/server/services/saved-views';
import { toCsv } from '../../src/server/services/csv';
import type { Grant, Principal } from '../../src/server/domain/permissions';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';

const principalFor = (grants: Grant[], overrides: Partial<Principal> = {}): Principal => ({
  userId: randomUUID(),
  isSuperUser: false,
  isActive: true,
  roleCodes: [],
  grants,
  branchCodes: ['HQ'],
  departments: [],
  defaultBranchCode: 'HQ',
  ...overrides,
});

const CHART_VIEW: Grant[] = [{ verb: 'view', object: 'chart_of_account' }];
const CHART_VIEW_EXPORT: Grant[] = [...CHART_VIEW, { verb: 'export', object: 'chart_of_account' }];
const JOURNAL_VIEW: Grant[] = [{ verb: 'view', object: 'journal_entry' }];

/** Runs as the app role, in the given branch, and rolls back unless committed. */
function asPrincipal<T>(
  principal: Principal,
  fn: (tx: Parameters<Parameters<typeof withScope>[1]>[0]) => Promise<T>,
  branchCode = 'HQ',
): Promise<T> {
  return withScope({ userId: principal.userId, branchCode, isSuperUser: principal.isSuperUser }, fn);
}

beforeAll(async () => {
  registerAllLists();

  // The first block below asserts about *"the seeded account groups"* — the one
  // root per account type that the migrations create — which is only a fact from
  // a known starting point. Without this it passed or failed on which file the
  // runner happened to schedule before it: another suite's expense account is
  // indistinguishable from a seeded one to a filter on account_type.
  //
  // `resetTestData` restores migration-seeded rows, so this returns the chart to
  // exactly what the migrations left, and nothing more.
  await resetTestData();
});

/**
 * Every principal used here needs an `app_user` row: an export writes an audit
 * event, and the audit event references its actor. A principal that exists only
 * in TypeScript would fail the foreign key on the way out.
 *
 * And, since D10, it needs its `user_branch_scope` rows too. Branch security is
 * no longer a claim the session makes — `app_permitted_branches()` reads it from
 * these rows — so a principal that says `branchCodes: ['HQ']` in TypeScript and
 * holds no scope row in the database is permitted nothing. That is the right
 * behaviour (the security boundary is data, not an assertion by the caller), but
 * it means a test fixture has to seed both halves or it proves nothing: an empty
 * result would look like correct scoping and actually be an unseeded user.
 */
async function seedUser(principal: Principal): Promise<void> {
  await ownerPool.query(
    `insert into app_user (id, email, display_name) values ($1, $2, 'List test user')
     on conflict (id) do nothing`,
    [principal.userId, `list-${principal.userId}@example.com`],
  );

  for (const branchCode of principal.branchCodes) {
    // The branch may not have been seeded yet — several blocks here seed users
    // before they seed data. A scope row needs one to point at.
    await ownerPool.query(
      `insert into branch (code, name) values ($1, $1) on conflict (code) do nothing`,
      [branchCode],
    );
    await ownerPool.query(
      `insert into user_branch_scope (user_id, branch_code) values ($1, $2)
       on conflict do nothing`,
      [principal.userId, branchCode],
    );
  }
}

describe('Appendix A rule 1 · a list filters, sorts and searches', () => {
  const viewer = principalFor(CHART_VIEW);

  it('returns the seeded account groups in code order', async () => {
    const result = await asPrincipal(viewer, (tx) =>
      list.rows(tx, viewer, 'chart_of_account', {}),
    );

    const codes = result.rows.map((r) => r.code);
    expect(codes).toEqual([...codes].sort());
    expect(codes).toContain('A000001');
    expect(result.total).toBe(codes.length);
  });

  it('filters on an enum column', async () => {
    const result = await asPrincipal(viewer, (tx) =>
      list.rows(tx, viewer, 'chart_of_account', {
        filters: [{ column: 'account_type', operator: 'eq', value: 'expense' }],
      }),
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.account_type).toBe('expense');
  });

  it('filters on more than one column at once', async () => {
    const result = await asPrincipal(viewer, (tx) =>
      list.rows(tx, viewer, 'chart_of_account', {
        filters: [
          { column: 'is_group', operator: 'eq', value: true },
          { column: 'level', operator: 'eq', value: 0 },
        ],
      }),
    );

    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(row.is_group).toBe(true);
      expect(row.level).toBe(0);
    }
  });

  it('sorts the direction it is asked to', async () => {
    const descending = await asPrincipal(viewer, (tx) =>
      list.rows(tx, viewer, 'chart_of_account', {
        sort: [{ column: 'code', direction: 'desc' }],
      }),
    );

    const codes = descending.rows.map((r) => String(r.code));
    expect(codes).toEqual([...codes].sort().reverse());
  });

  it('searches the text columns, case-insensitively', async () => {
    const result = await asPrincipal(viewer, (tx) =>
      list.rows(tx, viewer, 'chart_of_account', { search: 'liabilit' }),
    );

    expect(result.rows).toHaveLength(1);
    expect(String(result.rows[0]!.name).toLowerCase()).toContain('liabilit');
  });

  it('treats a wildcard in the search box as a character, not as a wildcard', async () => {
    // A user typing '%' is searching for a percent sign. If it reached ILIKE
    // unescaped it would match every row, which looks like a broken filter.
    const result = await asPrincipal(viewer, (tx) =>
      list.rows(tx, viewer, 'chart_of_account', { search: '%' }),
    );

    expect(result.rows).toHaveLength(0);
  });

  it('pages, and reports the total beyond the page', async () => {
    const firstPage = await asPrincipal(viewer, (tx) =>
      list.rows(tx, viewer, 'chart_of_account', { pageSize: 2, page: 1 }),
    );
    const secondPage = await asPrincipal(viewer, (tx) =>
      list.rows(tx, viewer, 'chart_of_account', { pageSize: 2, page: 2 }),
    );

    expect(firstPage.rows).toHaveLength(2);
    expect(firstPage.total).toBeGreaterThan(2);
    expect(secondPage.rows[0]!.code).not.toBe(firstPage.rows[0]!.code);
  });
});

describe('01.12 gate · a list respects permission', () => {
  it('refuses the list to someone without view', async () => {
    const outsider = principalFor([{ verb: 'view', object: 'journal_entry' }]);

    expect(
      await rejection(asPrincipal(outsider, (tx) => list.rows(tx, outsider, 'chart_of_account', {}))),
    ).toMatch(/'view' on 'chart_of_account' is not granted/);
  });

  it('refuses the export to someone who may view but not export', async () => {
    // §5.3 keeps `view` and `export` apart deliberately: reading a figure on
    // screen and walking out with the file are different permissions.
    const viewer = principalFor(CHART_VIEW);

    expect(
      await rejection(
        asPrincipal(viewer, (tx) => list.exportRows(tx, viewer, 'chart_of_account', {})),
      ),
    ).toMatch(/'export' on 'chart_of_account' is not granted/);
  });
});

describe('01.12 gate · a list respects data scope', () => {
  const author = principalFor(JOURNAL_VIEW);

  beforeAll(async () => {
    await resetTestData();
    await seedBranch('HQ', 'Head Office');
    await seedBranch('BR2', 'Second Branch');

    const { rows: years } = await ownerPool.query(
      `insert into fiscal_year (code, name, starts_on, ends_on)
       values ('FY2026', 'Financial Year 2026', '2026-01-01', '2026-12-31')
       returning id`,
    );
    const { rows: periods } = await ownerPool.query(
      `insert into fiscal_period (fiscal_year_id, period_no, name, starts_on, ends_on)
       values ($1, 1, 'January 2026', '2026-01-01', '2026-01-31')
       returning id`,
      [years[0].id],
    );

    // One journal in each branch, written as owner: what is being tested is
    // whether the reader can see them, not how they were made.
    await seedUser(author);

    for (const [branch, entryNo] of [
      ['HQ', 'JE-HQ-1'],
      ['BR2', 'JE-BR2-1'],
    ] as const) {
      await ownerPool.query(
        `insert into journal_entry
           (entry_no, document_date, posting_date, fiscal_period_id, branch_code, description,
            total_debit_iqd, total_credit_iqd, created_by)
         values ($1, '2026-01-15', '2026-01-15', $2, $3, 'Scope fixture', 0, 0, $4)`,
        [entryNo, periods[0].id, branch, author.userId],
      );
    }
  });

  it('shows a single-branch user only their branch, whatever branch they select', async () => {
    // D10 — the security boundary is the user's *permitted* branches. Selecting
    // a branch you do not hold as your Active Branch is not a way in: it changes
    // the default filter and nothing else, so the second call below returns
    // nothing rather than BR2's row.
    const hqOnly = principalFor(JOURNAL_VIEW, { branchCodes: ['HQ'], defaultBranchCode: 'HQ' });
    await seedUser(hqOnly);

    const inHq = await asPrincipal(hqOnly, (tx) => list.rows(tx, hqOnly, 'journal_entry', {}), 'HQ');
    expect(inHq.rows.map((r) => r.branch_code)).toEqual(['HQ']);

    const inBr2 = await asPrincipal(
      hqOnly,
      (tx) => list.rows(tx, hqOnly, 'journal_entry', {}),
      'BR2',
    );
    expect(inBr2.rows).toHaveLength(0);
  });

  it('opens a two-branch user on their Active Branch, and lets them switch or see all', async () => {
    // D10 in one test — the three parts kept apart:
    //
    //   Allowed Branches (both) = what may ever be returned;
    //   Active Branch (HQ)      = what is returned *by default*, "to keep daily
    //                             work clean and focused";
    //   and neither of those is the role, which decides the verb.
    //
    // So the same user, with the same permissions, sees one branch on opening
    // the list, the other on filtering to it, and both on asking for all — and
    // never a fourth thing, because `app_branch_allowed` bounds all three.
    const both = principalFor(JOURNAL_VIEW, {
      branchCodes: ['HQ', 'BR2'],
      defaultBranchCode: 'HQ',
    });
    await seedUser(both);

    const opened = await asPrincipal(both, (tx) => list.rows(tx, both, 'journal_entry', {}), 'HQ');
    expect(opened.rows.map((r) => r.branch_code)).toEqual(['HQ']);

    // Switching the Active Branch moves the default.
    const switched = await asPrincipal(
      both,
      (tx) => list.rows(tx, both, 'journal_entry', {}),
      'BR2',
    );
    expect(switched.rows.map((r) => r.branch_code)).toEqual(['BR2']);

    // Filtering to the other branch works without switching — the Active Branch
    // was only a default, and an explicit filter replaces it.
    const filtered = await asPrincipal(
      both,
      (tx) =>
        list.rows(tx, both, 'journal_entry', {
          filters: [{ column: 'branch_code', operator: 'eq', value: 'BR2' }],
        }),
      'HQ',
    );
    expect(filtered.rows.map((r) => r.branch_code)).toEqual(['BR2']);

    // And "All Permitted Branches" returns both, from either seat.
    const all = await asPrincipal(
      both,
      (tx) =>
        list.rows(tx, both, 'journal_entry', {
          allPermittedBranches: true,
          sort: [{ column: 'branch_code', direction: 'asc' }],
        }),
      'HQ',
    );
    expect(all.rows.map((r) => r.branch_code)).toEqual(['BR2', 'HQ']);
  });

  it('means *permitted* branches by "all", not every branch', async () => {
    // The widening flag widens the default, never the permission. A user who
    // holds HQ alone and asks for all branches gets HQ alone.
    const hqOnly = principalFor(JOURNAL_VIEW, { branchCodes: ['HQ'], defaultBranchCode: 'HQ' });
    await seedUser(hqOnly);

    const all = await asPrincipal(hqOnly, (tx) =>
      list.rows(tx, hqOnly, 'journal_entry', { allPermittedBranches: true }),
    );

    expect(all.rows.map((r) => r.branch_code)).toEqual(['HQ']);
  });

  it('does not let a filter reach outside the scope', async () => {
    // Asking for a branch you do not hold returns nothing, rather than the rows
    // of that branch. Scope is a predicate, not a default.
    const hqOnly = principalFor(JOURNAL_VIEW, { branchCodes: ['HQ'], defaultBranchCode: 'HQ' });
    await seedUser(hqOnly);

    const result = await asPrincipal(hqOnly, (tx) =>
      list.rows(tx, hqOnly, 'journal_entry', {
        filters: [{ column: 'branch_code', operator: 'eq', value: 'BR2' }],
      }),
    );

    expect(result.rows).toHaveLength(0);
  });

  it('hides another branch’s record even when its id is known (01.2 gate)', async () => {
    // The list predicate is not the control — a caller who bypasses it and asks
    // for the row directly must still get nothing. That is RLS in the database,
    // which is why this reads through the app pool rather than the service.
    const { rows: target } = await ownerPool.query(
      `select id from journal_entry where entry_no = 'JE-BR2-1'`,
    );

    const targetId = (target[0] as { id: string }).id;

    const visible = await withScope({ userId: author.userId, branchCode: 'HQ' }, (tx) =>
      tx.execute(sql`select entry_no from journal_entry where id = ${targetId}`),
    );

    expect((visible as unknown as { rows: unknown[] }).rows).toHaveLength(0);
  });

  it('scopes the export exactly as it scopes the screen', async () => {
    const hqOnly = principalFor(
      [...JOURNAL_VIEW, { verb: 'export', object: 'journal_entry' }],
      { branchCodes: ['HQ'], defaultBranchCode: 'HQ' },
    );
    await seedUser(hqOnly);

    const screen = await asPrincipal(hqOnly, (tx) => list.rows(tx, hqOnly, 'journal_entry', {}));
    const exported = await asPrincipal(hqOnly, (tx) =>
      list.exportRows(tx, hqOnly, 'journal_entry', {}),
    );

    expect(exported.rows).toHaveLength(screen.rows.length);
    expect(exported.rows.map((r) => r.entry_no)).toEqual(screen.rows.map((r) => r.entry_no));
  });
});

describe('01.12 gate · export returns exactly the on-screen rows', () => {
  const exporter = principalFor(CHART_VIEW_EXPORT);

  beforeAll(async () => {
    await seedUser(exporter);
  });

  it('returns every matching row, not just the first page', async () => {
    const page = await asPrincipal(exporter, (tx) =>
      list.rows(tx, exporter, 'chart_of_account', { pageSize: 2 }),
    );
    const exported = await asPrincipal(exporter, (tx) =>
      list.exportRows(tx, exporter, 'chart_of_account', { pageSize: 2 }),
    );

    expect(page.rows).toHaveLength(2);
    expect(exported.rows.length).toBe(page.total);
  });

  it('carries every filter through to the export', async () => {
    const filters = [{ column: 'account_type' as const, operator: 'eq' as const, value: 'asset' }];

    const screen = await asPrincipal(exporter, (tx) =>
      list.rows(tx, exporter, 'chart_of_account', { filters }),
    );
    const exported = await asPrincipal(exporter, (tx) =>
      list.exportRows(tx, exporter, 'chart_of_account', { filters }),
    );

    expect(exported.rows.map((r) => r.code)).toEqual(screen.rows.map((r) => r.code));
  });

  it('records who exported what, without copying the rows into the audit trail', async () => {
    // §5.4 — who took a copy of what is an audit question. Run through the same
    // committing path the application uses, so the audit row survives.
    const committed = principalFor(CHART_VIEW_EXPORT);
    await seedUser(committed);

    await withScope({ userId: committed.userId, branchCode: 'HQ' }, (tx) =>
      list.exportRows(tx, committed, 'chart_of_account', { search: 'Asset' }),
    );

    const { rows } = await ownerPool.query(
      `select action, after_value from audit_event
        where actor_user_id = $1 and action = 'chart_of_account.exported'`,
      [committed.userId],
    );

    expect(rows).toHaveLength(1);
    const after = rows[0].after_value;
    expect(after.rowCount).toBeGreaterThan(0);
    expect(after.search).toBe('Asset');
    // What was taken, not what was in it.
    expect(JSON.stringify(after)).not.toContain('A000001');
  });

  it('renders a CSV whose header is the columns the reader could see', () => {
    const csv = toCsv(['code', 'name'], [{ code: 'A000001', name: 'Assets' }]);
    expect(csv).toBe('code,name\r\nA000001,Assets\r\n');
  });

  it('neutralises a value Excel would treat as a formula', () => {
    // An exported field beginning with '=' executes when the file is opened.
    const csv = toCsv(['name'], [{ name: '=HYPERLINK("http://x","click")' }]);
    expect(csv).toContain(`"'=HYPERLINK`);
  });
});

describe('Appendix A rule 1 · saved views', () => {
  const author = principalFor(CHART_VIEW);
  const reader = principalFor(CHART_VIEW);

  beforeEach(async () => {
    await ownerPool.query(`delete from saved_view`);
    await Promise.all([author, reader].map(seedUser));
  });

  it('saves a query and reopens it as the same query', async () => {
    const saved = await asPrincipal(author, (tx) =>
      savedViews.save(tx, author, {
        listKey: 'chart_of_account',
        name: 'Expenses only',
        query: { filters: [{ column: 'account_type', operator: 'eq', value: 'expense' }] },
      }),
    );

    const opened = await asPrincipal(author, (tx) => savedViews.open(tx, author, saved.id));

    expect(opened.query.filters).toHaveLength(1);
    expect(opened.query.listKey).toBe('chart_of_account');
  });

  it('refuses to save a query that would not run', async () => {
    // A view that fails when opened is worse than no view: it fails for its
    // author weeks later, with no memory of what they set.
    expect(
      await rejection(
        asPrincipal(author, (tx) =>
          savedViews.save(tx, author, {
            listKey: 'chart_of_account',
            name: 'Broken',
            query: { filters: [{ column: 'nonsense', operator: 'eq', value: 'x' }] },
          }),
        ),
      ),
    ).toMatch(/is not a column/);
  });

  it('keeps a private view private', async () => {
    const saved = await asPrincipal(author, (tx) =>
      savedViews.save(tx, author, {
        listKey: 'chart_of_account',
        name: 'Mine',
        query: {},
      }),
    );

    const visible = await asPrincipal(reader, (tx) =>
      savedViews.listFor(tx, reader, 'chart_of_account'),
    );

    expect(visible.map((v) => v.id)).not.toContain(saved.id);
  });

  it('shares a view as a question, not as an answer', async () => {
    // The reader gets the query and runs it themselves — so sharing widens who
    // may ask, never what they are allowed to see.
    const saved = await asPrincipal(author, (tx) =>
      savedViews.save(tx, author, {
        listKey: 'chart_of_account',
        name: 'Shared expenses',
        isShared: true,
        query: { filters: [{ column: 'account_type', operator: 'eq', value: 'expense' }] },
      }),
    );

    const opened = await asPrincipal(reader, (tx) => savedViews.open(tx, reader, saved.id));
    expect(opened.view.ownerUserId).toBe(author.userId);

    const rows = await asPrincipal(reader, (tx) =>
      list.rows(tx, reader, 'chart_of_account', opened.view.query),
    );
    expect(rows.rows.every((r) => r.account_type === 'expense')).toBe(true);
  });

  it('re-checks the reader’s own permission when a shared view is opened', async () => {
    const saved = await asPrincipal(author, (tx) =>
      savedViews.save(tx, author, {
        listKey: 'chart_of_account',
        name: 'Shared',
        isShared: true,
        query: {},
      }),
    );

    const outsider = principalFor([{ verb: 'view', object: 'journal_entry' }]);
    expect(
      await rejection(asPrincipal(outsider, (tx) => savedViews.open(tx, outsider, saved.id))),
    ).toMatch(/'view' on 'chart_of_account' is not granted/);
  });

  it('lets only the author change their own view', async () => {
    const saved = await asPrincipal(author, (tx) =>
      savedViews.save(tx, author, {
        listKey: 'chart_of_account',
        name: 'Shared',
        isShared: true,
        query: {},
      }),
    );

    expect(
      await rejection(asPrincipal(reader, (tx) => savedViews.remove(tx, reader, saved.id))),
    ).toMatch(/Save a copy under your own name/);
  });

  it('keeps at most one default view per list', async () => {
    await asPrincipal(author, (tx) =>
      savedViews.save(tx, author, {
        listKey: 'chart_of_account',
        name: 'First default',
        isDefault: true,
        query: {},
      }),
    );
    await asPrincipal(author, (tx) =>
      savedViews.save(tx, author, {
        listKey: 'chart_of_account',
        name: 'Second default',
        isDefault: true,
        query: {},
      }),
    );

    const { rows } = await ownerPool.query(
      `select name from saved_view where owner_user_id = $1 and is_default`,
      [author.userId],
    );

    // "Which view opens?" must have exactly one answer.
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Second default');
  });
});
