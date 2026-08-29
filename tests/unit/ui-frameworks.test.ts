/**
 * Phase 01.12 test gate — the parts that are decidable without a browser.
 *
 * Appendix A's four global UI rules are mostly statements about behaviour, not
 * about pixels, so most of the gate lives here. The rendering itself is checked
 * by the Playwright specs in tests/e2e.
 */
import { describe, expect, it } from 'vitest';
import {
  MENU,
  allMenuItems,
  findMenuItem,
  menuObjects,
  visibleMenu,
} from '@domain/menu';
import {
  DEFAULT_PAGE_SIZE,
  ListQueryError,
  normaliseQuery,
  operatorsFor,
  searchableColumns,
  toExportQuery,
  visibleColumns,
  type ListDefinition,
} from '@domain/list-view';
import {
  STANDARD_ACTIONS,
  actionsFor,
  draftMarkingFor,
  enabledActions,
} from '@domain/record-view';
import type { Grant, Principal } from '@domain/permissions';
import type { TransitionRule } from '@domain/statuses';

const principal = (grants: Grant[], overrides: Partial<Principal> = {}): Principal => ({
  userId: 'u1',
  isSuperUser: false,
  isActive: true,
  roleCodes: [],
  grants,
  branchCodes: ['HQ'],
  departments: [],
  ...overrides,
});

const superUser = principal([], { isSuperUser: true });

// ---------------------------------------------------------------------------
// Appendix A — the menu tree
// ---------------------------------------------------------------------------

describe('Appendix A · the approved menu tree', () => {
  it('has every top-level menu, in the approved order', () => {
    // Appendix A's twenty-one. (The Phase 0 invoicing sample was removed by
    // direction, 2026-08-29.)
    expect(MENU).toHaveLength(21);
    expect(MENU.map((s) => s.ordinal)).toEqual(Array.from({ length: 21 }, (_, i) => i + 1));
  });

  it('names every required submenu of Finance — General Ledger', () => {
    // Appendix A, menu 10 — less `exchange_rates`, removed by direction
    // (2026-08-25). The tree offered the rates screen twice under one
    // dropdown, as "Exchange Rates" here and "Currencies and Rates" under
    // Master Data, both leading to the same page. It is master data, so
    // Master Data keeps it and this menu does not repeat it.
    const gl = MENU.find((s) => s.key === 'finance_gl');
    expect(gl?.items.map((i) => i.key)).toEqual([
      'journal_entry',
      'recurring_journals',
      'reversals',
      'gl_inquiry',
      'trial_balance',
      'soft_close',
      'year_end_close',
      'posting_mappings',
      // Each statement on its own page (by direction, 2026-08-29).
      'profit_or_loss',
      'financial_position',
    ]);
  });

  it('names every required submenu of Administration', () => {
    // Menu 20 — the one that must include the §5.2 toggle screen.
    const admin = MENU.find((s) => s.key === 'administration');
    expect(admin?.items.map((i) => i.key)).toContain('department_manager_toggles');
    expect(admin?.items.map((i) => i.key)).toContain('numbering');
    expect(admin?.items.map((i) => i.key)).toContain('audit_trail');
  });

  it('gives every item a unique key', () => {
    const keys = allMenuItems().map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every item a permission object and a delivering phase', () => {
    for (const item of allMenuItems()) {
      expect(item.object, item.key).toBeTruthy();
      expect(item.phase, item.key).toMatch(/^\d\d(\.\d+)?$/);
    }
  });

  it('routes only to pages whose module has been built', () => {
    // An item with an href must be reachable; one without is honestly absent.
    for (const item of allMenuItems()) {
      if (item.href !== null) expect(item.href, item.key).toMatch(/^\//);
    }
  });
});

describe('§25 · navigation reflects permission, and is not the control', () => {
  it('shows a Super User everything', () => {
    expect(visibleMenu(superUser)).toHaveLength(21);
  });

  it('shows a user only the sections they hold a grant in', () => {
    const officer = principal([
      { verb: 'view', object: 'journal_entry' },
      { verb: 'view', object: 'chart_of_account' },
    ]);
    const sections = visibleMenu(officer).map((s) => s.key);
    expect(sections).toEqual(['finance_gl', 'master_data']);
  });

  it('drops a section with nothing visible rather than showing it empty', () => {
    const nobody = principal([]);
    expect(visibleMenu(nobody)).toHaveLength(0);
  });

  it('shows an inactive user nothing at all', () => {
    // Deactivation is immediate and total (§25) — including for a Super User.
    const suspended = principal([{ verb: 'view', object: 'journal_entry' }], { isActive: false });
    expect(visibleMenu(suspended)).toHaveLength(0);
    expect(visibleMenu({ ...superUser, isActive: false })).toHaveLength(0);
  });

  it('exposes the objects the tree references, for the permission catalogue', () => {
    expect(menuObjects()).toContain('journal_entry');
    expect(menuObjects()).toContain('chart_of_account');
    expect(findMenuItem('trial_balance')?.object).toBe('trial_balance');
  });
});

// ---------------------------------------------------------------------------
// Appendix A rule 1 — lists
// ---------------------------------------------------------------------------

const journalList: ListDefinition = {
  key: 'journal_entry',
  object: 'journal_entry',
  columns: [
    { key: 'number', kind: 'text', searchable: true, sortable: true, filterable: true },
    { key: 'memo', kind: 'text', searchable: true, sortable: false },
    { key: 'status', kind: 'enum', values: ['draft', 'submitted', 'posted'], filterable: true },
    { key: 'entry_date', kind: 'date', sortable: true, filterable: true },
    { key: 'total_iqd', kind: 'money', sortable: true, filterable: true },
    {
      key: 'created_by',
      kind: 'uuid',
      filterable: true,
      requires: { verb: 'administer', object: 'app_user' },
    },
  ],
  defaultSort: [{ column: 'entry_date', direction: 'desc' }],
};

const viewer = principal([{ verb: 'view', object: 'journal_entry' }]);

describe('Appendix A rule 1 · search, filter, sort, saved views, export', () => {
  it('accepts a well-formed query and fills in the defaults', () => {
    const query = normaliseQuery(journalList, viewer, { search: ' rent ' });
    expect(query.search).toBe('rent');
    expect(query.sort).toEqual([{ column: 'entry_date', direction: 'desc' }]);
    expect(query.page).toBe(1);
    expect(query.pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(query.unpaged).toBe(false);
  });

  it('refuses a filter on a column that does not exist, and says which do', () => {
    // §25 — field, reason, corrective action. No generic failure.
    try {
      normaliseQuery(journalList, viewer, {
        filters: [{ column: 'nonsense', operator: 'eq', value: 'x' }],
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ListQueryError);
      const e = error as ListQueryError;
      expect(e.field).toBe('nonsense');
      expect(e.reason).toMatch(/is not a column/);
      expect(e.correction).toMatch(/number, memo, status/);
    }
  });

  it('refuses an operator the column kind cannot support', () => {
    expect(() =>
      normaliseQuery(journalList, viewer, {
        filters: [{ column: 'entry_date', operator: 'contains', value: '2026' }],
      }),
    ).toThrow(/cannot be used on a date column/);
  });

  it('refuses a value outside an enum, and lists the values', () => {
    expect(() =>
      normaliseQuery(journalList, viewer, {
        filters: [{ column: 'status', operator: 'eq', value: 'approved' }],
      }),
    ).toThrow(/Choose one of: draft, submitted, posted/);
  });

  it('refuses a range filter without both ends', () => {
    expect(() =>
      normaliseQuery(journalList, viewer, {
        filters: [{ column: 'total_iqd', operator: 'between', value: 100 }],
      }),
    ).toThrow(/exactly two values/);
  });

  it('refuses a comparison with nothing to compare against', () => {
    expect(() =>
      normaliseQuery(journalList, viewer, {
        filters: [{ column: 'number', operator: 'eq', value: '' }],
      }),
    ).toThrow(/needs a value/);
  });

  it('refuses a value on an emptiness test', () => {
    expect(() =>
      normaliseQuery(journalList, viewer, {
        filters: [{ column: 'memo', operator: 'is_null', value: 'x' }],
      }),
    ).toThrow(/does not take a value/);
  });

  it('refuses sorting by a column marked unsortable', () => {
    expect(() =>
      normaliseQuery(journalList, viewer, { sort: [{ column: 'memo', direction: 'asc' }] }),
    ).toThrow(/cannot be sorted/);
  });

  it('refuses a page size beyond the ceiling, and points at export', () => {
    expect(() => normaliseQuery(journalList, viewer, { pageSize: 5000 })).toThrow(
      /export the list instead/,
    );
    expect(() => normaliseQuery(journalList, viewer, { pageSize: 0 })).toThrow(/between 1 and/);
  });

  it('offers only the operators a kind can honour', () => {
    expect(operatorsFor('boolean')).toEqual(['eq', 'is_null', 'is_not_null']);
    expect(operatorsFor('date')).not.toContain('contains');
    expect(operatorsFor('money')).toContain('between');
  });
});

describe('01.12 gate · a list respects permission and data scope', () => {
  it('hides a column the user has no permission for', () => {
    expect(visibleColumns(journalList, viewer).map((c) => c.key)).not.toContain('created_by');
    expect(visibleColumns(journalList, superUser).map((c) => c.key)).toContain('created_by');
  });

  it('refuses to filter by a hidden column as a permission matter', () => {
    // Not "no such column" — that would confirm to the user that it exists.
    expect(() =>
      normaliseQuery(journalList, viewer, {
        filters: [{ column: 'created_by', operator: 'eq', value: 'u9' }],
      }),
    ).toThrow(/do not have permission to filter by created_by/);
  });

  it('searches only the columns the user can see', () => {
     expect(searchableColumns(journalList, viewer).map((c) => c.key)).toEqual(['number', 'memo']);
  });
});

describe('01.12 gate · export returns exactly the rows the screen would', () => {
  it('keeps every predicate and only drops the page window', () => {
    const screen = normaliseQuery(journalList, viewer, {
      search: 'rent',
      filters: [{ column: 'status', operator: 'eq', value: 'posted' }],
      sort: [{ column: 'total_iqd', direction: 'asc' }],
      page: 3,
      pageSize: 25,
    });

    const exported = toExportQuery(screen);

    expect(exported.search).toBe(screen.search);
    expect(exported.filters).toEqual(screen.filters);
    expect(exported.sort).toEqual(screen.sort);
    expect(exported.columns).toEqual(screen.columns);
    expect(exported.unpaged).toBe(true);
  });

  it('cannot widen the columns beyond what the screen showed', () => {
    const screen = normaliseQuery(journalList, viewer, {});
    expect(toExportQuery(screen).columns).not.toContain('created_by');
  });
});

// ---------------------------------------------------------------------------
// Appendix A rules 2–4 — records
// ---------------------------------------------------------------------------

const transitions: TransitionRule[] = [
  { from: 'draft', to: 'submitted' },
  { from: 'submitted', to: 'approved' },
  { from: 'submitted', to: 'rejected' },
  { from: 'approved', to: 'posted' },
  { from: 'posted', to: 'reversed' },
  { from: 'draft', to: 'cancelled' },
];

const allVerbs = principal([
  { verb: 'view', object: 'journal_entry' },
  { verb: 'edit_draft', object: 'journal_entry' },
  { verb: 'submit', object: 'journal_entry' },
  { verb: 'approve', object: 'journal_entry' },
  { verb: 'post', object: 'journal_entry' },
  { verb: 'reverse_cancel', object: 'journal_entry' },
  { verb: 'print', object: 'journal_entry' },
  { verb: 'export', object: 'journal_entry' },
]);

const enabledKeys = (status: Parameters<typeof draftMarkingFor>[0], p = allVerbs) =>
  enabledActions(
    actionsFor({ documentType: 'journal_entry', status, transitions, principal: p }),
  ).map((a) => a.key);

describe('Appendix A rule 3 · only actions valid for status and permission', () => {
  it('offers edit, submit and cancel on a draft', () => {
    expect(enabledKeys('draft')).toEqual(['edit', 'submit', 'cancel', 'print', 'export']);
  });

  it('offers approve and reject once submitted, but not edit', () => {
    const keys = enabledKeys('submitted');
    expect(keys).toContain('approve');
    expect(keys).toContain('reject');
    expect(keys).not.toContain('edit');
  });

  it('offers post only from approved', () => {
    expect(enabledKeys('approved')).toContain('post');
    expect(enabledKeys('draft')).not.toContain('post');
  });

  it('offers reverse only once posted', () => {
    expect(enabledKeys('posted')).toContain('reverse');
    expect(enabledKeys('approved')).not.toContain('reverse');
  });

  it('needs both the status and the permission — status alone is not enough', () => {
    const noPost = principal([
      { verb: 'view', object: 'journal_entry' },
      { verb: 'approve', object: 'journal_entry' },
    ]);
    expect(enabledKeys('approved', noPost)).not.toContain('post');
  });

  it('needs both — permission alone is not enough', () => {
    // Holding `post` does not let anyone post a draft.
    expect(enabledKeys('draft')).not.toContain('post');
  });

  it('says why an action is disabled, distinguishing the two reasons', () => {
    const noPost = principal([{ verb: 'view', object: 'journal_entry' }]);
    const byKey = (p: Principal, status: 'draft' | 'approved') =>
      Object.fromEntries(
        actionsFor({ documentType: 'journal_entry', status, transitions, principal: p }).map(
          (a) => [a.key, a.disabledReasonKey],
        ),
      );

    expect(byKey(noPost, 'approved').post).toBe('action.disabled.no_permission');
    expect(byKey(allVerbs, 'draft').post).toBe('action.disabled.wrong_status');
    expect(byKey(allVerbs, 'approved').edit).toBe('action.disabled.not_editable');
  });

  it('lets a module veto an action with its own reason', () => {
    const actions = actionsFor({
      documentType: 'journal_entry',
      status: 'approved',
      transitions,
      principal: allVerbs,
      overrides: { post: { available: false, reasonKey: 'action.disabled.period_closed' } },
    });
    const post = actions.find((a) => a.key === 'post');
    expect(post?.enabled).toBe(false);
    expect(post?.disabledReasonKey).toBe('action.disabled.period_closed');
  });

  it('never enables an action it has no definition for', () => {
    expect(STANDARD_ACTIONS.map((a) => a.key)).toEqual([
      'edit',
      'submit',
      'approve',
      'reject',
      'execute',
      'post',
      'reverse',
      'cancel',
      'print',
      'export',
    ]);
  });
});

describe('Appendix A rule 4 · a draft cannot be mistaken for a final document', () => {
  it('marks a draft as a draft', () => {
    expect(draftMarkingFor('draft')).toMatchObject({ isDraft: true, isFinal: false });
  });

  it('still marks a submitted document as not final', () => {
    // It is awaiting a decision; printing it as final would misrepresent it.
    expect(draftMarkingFor('submitted')).toMatchObject({
      isDraft: true,
      labelKey: 'record.marking.pending_approval',
    });
  });

  it('marks posted and settled documents final', () => {
    expect(draftMarkingFor('posted').isDraft).toBe(false);
    expect(draftMarkingFor('settled').isFinal).toBe(true);
  });

  it('marks a cancelled, rejected or reversed document by name, not as final', () => {
    for (const status of ['cancelled', 'rejected', 'reversed'] as const) {
      expect(draftMarkingFor(status).labelKey).toBe(`record.marking.${status}`);
      expect(draftMarkingFor(status).isDraft).toBe(false);
    }
  });

  it('gives every status a marking — none falls through unlabelled', () => {
    for (const status of ['draft', 'submitted', 'approved', 'executed', 'posted', 'closed'] as const) {
      expect(draftMarkingFor(status).labelKey).toMatch(/^record\.marking\./);
    }
  });
});
