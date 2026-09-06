/**
 * Phase 02.1 test gate — the tree rules and the posting gate.
 *
 * The database enforces the same rules with triggers; those are proved in
 * tests/integration/phase02-chart-of-accounts.test.ts. Both exist because a
 * readable error belongs in the service layer and the guarantee belongs in the
 * database.
 */
import { describe, expect, it } from 'vitest';
import {
  AccountCodeFormatError,
  AccountPlacementError,
  AccountPostingError,
  AccountStructureError,
  assertCanBecomeGroup,
  assertCanBecomePosting,
  assertCanDeactivate,
  assertCodeAgreesWithType,
  assertCurrencyAllowed,
  assertNoCycle,
  assertPostable,
  assertValidPlacement,
  buildAccountTree,
  descendantsOf,
  missingRequiredDimensions,
  normaliseAccountCode,
  type AccountNode,
} from '@domain/chart-of-accounts';

function account(overrides: Partial<AccountNode> = {}): AccountNode {
  return {
    id: 'acc-1',
    code: 'A000002',
    name: 'Cash on Hand',
    accountType: 'asset',
    parentId: 'root-a',
    isGroup: false,
    isActive: true,
    approvalStatus: 'approved',
    controlAccount: null,
    statementLine: null,
    balanceSheetLine: null,
    currencyRestriction: null,
    requiredDimensions: [],
    isSystem: false,
    level: 1,
    ...overrides,
  };
}

const assetsRoot = account({
  id: 'root-a',
  code: 'A000001',
  name: 'Assets',
  parentId: null,
  isGroup: true,
  isSystem: true,
  level: 0,
});

describe('account codes', () => {
  it('stores codes uppercase and unspaced', () => {
    expect(normaliseAccountCode(' a000002 ')).toBe('A000002');
  });

  it('refuses an empty, spaced or oddly punctuated code', () => {
    expect(() => normaliseAccountCode('')).toThrow(AccountCodeFormatError);
    expect(() => normaliseAccountCode('A000 002')).toThrow(/contains a space/);
    expect(() => normaliseAccountCode('A#0002')).toThrow(AccountCodeFormatError);
  });

  it('accepts a code that does not follow the letter-and-six-digits convention', () => {
    // §1.2 makes the chart configurable. A company that later wants 4-digit or
    // dotted codes must not need a code change to do it.
    expect(normaliseAccountCode('1100.10')).toBe('1100.10');
    expect(() => assertCodeAgreesWithType('1100.10', 'asset')).not.toThrow();
  });

  it('holds a conventional code to what the convention says it means', () => {
    expect(() => assertCodeAgreesWithType('X000200', 'asset')).toThrow(AccountPlacementError);
    expect(() => assertCodeAgreesWithType('X000200', 'expense')).not.toThrow();
  });
});

describe('where an account may sit', () => {
  it('accepts a child of the right type under a group', () => {
    expect(() =>
      assertValidPlacement({ code: 'A000002', accountType: 'asset', parent: assetsRoot }),
    ).not.toThrow();
  });

  it('refuses a child under a posting account', () => {
    // A leaf holds a balance. Hanging children off it would make that balance
    // and the sum of its children two different numbers.
    const leaf = account({ id: 'leaf', code: 'A000002', isGroup: false });
    expect(() =>
      assertValidPlacement({ code: 'A000003', accountType: 'asset', parent: leaf }),
    ).toThrow(/posting account, so it cannot hold children/);
  });

  it('refuses an expense under Assets', () => {
    expect(() =>
      assertValidPlacement({ code: 'X000002', accountType: 'expense', parent: assetsRoot }),
    ).toThrow(/inherits its parent's type/);
  });

  it('refuses a child under an inactive group', () => {
    const retired = { ...assetsRoot, isActive: false };
    expect(() =>
      assertValidPlacement({ code: 'A000002', accountType: 'asset', parent: retired }),
    ).toThrow(/Reactivate it before adding accounts beneath it/);
  });

  it('accepts a root with no parent', () => {
    expect(() =>
      assertValidPlacement({ code: 'A000001', accountType: 'asset', parent: null }),
    ).not.toThrow();
  });

  it('refuses a tree deeper than the limit', () => {
    const deep = { ...assetsRoot, level: 11 };
    expect(() =>
      assertValidPlacement({ code: 'A000009', accountType: 'asset', parent: deep }),
    ).toThrow(/beyond the maximum/);
  });
});

describe('moving an account', () => {
  it('refuses a move beneath itself', () => {
    expect(() => assertNoCycle('a', 'a', [])).toThrow(AccountPlacementError);
  });

  it('refuses a move beneath one of its own descendants', () => {
    // Proposed parent 'c' has ancestors b → a. Moving 'a' under 'c' would
    // detach the subtree and hand it to itself.
    expect(() => assertNoCycle('a', 'c', ['b', 'a'])).toThrow(/beneath itself or one of its own/);
  });

  it('allows a move to an unrelated branch', () => {
    expect(() => assertNoCycle('a', 'z', ['y', 'x'])).not.toThrow();
  });

  it('allows detaching to a root', () => {
    expect(() => assertNoCycle('a', null, [])).not.toThrow();
  });
});

describe('converting between group and posting account', () => {
  it('refuses to turn a group with children into a posting account', () => {
    expect(() => assertCanBecomePosting(assetsRoot, 3)).toThrow(AccountStructureError);
    expect(() => assertCanBecomePosting(assetsRoot, 0)).not.toThrow();
  });

  it('refuses to turn a used posting account into a group', () => {
    // Its balance would have nowhere to sit: a group's figure is the sum of its
    // children, and this one has entries of its own.
    expect(() => assertCanBecomeGroup(account(), 12)).toThrow(/nowhere to sit/);
    expect(() => assertCanBecomeGroup(account(), 0)).not.toThrow();
  });

  it('refuses to deactivate a group that still has active children', () => {
    expect(() => assertCanDeactivate(assetsRoot, 2)).toThrow(/active child account/);
    expect(() => assertCanDeactivate(assetsRoot, 0)).not.toThrow();
  });
});

describe('the posting gate (§3.3, §14.3)', () => {
  it('accepts an approved, active posting account', () => {
    expect(() => assertPostable(account(), { source: 'manual' })).not.toThrow();
  });

  it('rejects an account that is still awaiting approval', () => {
    expect(() =>
      assertPostable(account({ approvalStatus: 'submitted', isActive: false }), {
        source: 'manual',
      }),
    ).toThrow(/only once the Accounting Manager has approved it/);
  });

  it('rejects an inactive account', () => {
    expect(() => assertPostable(account({ isActive: false }), { source: 'system' })).toThrow(
      /the account is inactive/,
    );
  });

  it('rejects a group account', () => {
    expect(() =>
      assertPostable(account({ isGroup: true, controlAccount: null }), { source: 'system' }),
    ).toThrow(/it is a group account/);
  });

  it('rejects a manual journal into a control account by an ordinary user', () => {
    // §14.3 — this is the control that keeps the subledger and the G/L equal.
    const receivables = account({ code: 'A000010', controlAccount: 'customer' });

    expect(() => assertPostable(receivables, { source: 'manual' })).toThrow(AccountPostingError);
    expect(() =>
      assertPostable(receivables, { source: 'manual', actorIsFinanceManager: false }),
    ).toThrow(/requires Finance Manager approval/);
  });

  it('allows a Finance Manager to post manually to a control account', () => {
    const receivables = account({ controlAccount: 'customer' });
    expect(() =>
      assertPostable(receivables, { source: 'manual', actorIsFinanceManager: true }),
    ).not.toThrow();
  });

  it('allows the posting engine to post to a control account', () => {
    // The normal path: a sales invoice posts to receivables automatically.
    const receivables = account({ controlAccount: 'customer' });
    expect(() => assertPostable(receivables, { source: 'system' })).not.toThrow();
  });
});

describe('currency and dimension requirements', () => {
  it('refuses an entry in a currency the account does not hold', () => {
    const usdOnly = account({ currencyRestriction: 'USD' });
    expect(() => assertCurrencyAllowed(usdOnly, 'IQD')).toThrow(/accepts USD only/);
    expect(() => assertCurrencyAllowed(usdOnly, 'USD')).not.toThrow();
  });

  it('places no restriction when none is configured', () => {
    expect(() => assertCurrencyAllowed(account(), 'IQD')).not.toThrow();
  });

  it('reports every missing dimension at once, not the first', () => {
    // §25 — the message must say what to fix, and fixing one at a time is how
    // a user comes to hate a system.
    const salaries = account({
      requiredDimensions: ['department', 'business_line', 'branch'],
    });

    expect(missingRequiredDimensions(salaries, { branch: 'BGW' })).toEqual([
      'department',
      'business_line',
    ]);
    expect(
      missingRequiredDimensions(salaries, {
        branch: 'BGW',
        department: 'FIN',
        business_line: 'TRADE',
      }),
    ).toEqual([]);
  });

  it('treats a supplied null as missing', () => {
    const salaries = account({ requiredDimensions: ['project'] });
    expect(missingRequiredDimensions(salaries, { project: null })).toEqual(['project']);
  });
});

describe('assembling the tree', () => {
  const nodes: AccountNode[] = [
    assetsRoot,
    account({ id: 'current', code: 'A000002', parentId: 'root-a', isGroup: true, level: 1 }),
    account({ id: 'cash', code: 'A000003', parentId: 'current', level: 2 }),
    account({ id: 'bank', code: 'A000004', parentId: 'current', level: 2 }),
    account({
      id: 'root-x',
      code: 'X000001',
      accountType: 'expense',
      parentId: null,
      isGroup: true,
      level: 0,
    }),
  ];

  it('nests children under their parent', () => {
    const tree = buildAccountTree(nodes);

    expect(tree.map((n) => n.code)).toEqual(['A000001', 'X000001']);
    expect(tree[0]!.children.map((n) => n.code)).toEqual(['A000002']);
    expect(tree[0]!.children[0]!.children.map((n) => n.code)).toEqual(['A000003', 'A000004']);
  });

  it('sorts by code at every level, so the chart reads the same everywhere', () => {
    const shuffled = [...nodes].reverse();
    const tree = buildAccountTree(shuffled);
    expect(tree[0]!.children[0]!.children.map((n) => n.code)).toEqual(['A000003', 'A000004']);
  });

  it('surfaces an orphan as a root rather than dropping it', () => {
    // A filtered subtree should still render — losing rows silently is worse
    // than showing them at the top level.
    const filtered = buildAccountTree([account({ id: 'cash', parentId: 'not-in-this-list' })]);
    expect(filtered).toHaveLength(1);
  });

  it('collects every descendant, not just direct children', () => {
    expect(descendantsOf(nodes, 'root-a').map((n) => n.id)).toEqual(['current', 'cash', 'bank']);
    expect(descendantsOf(nodes, 'cash')).toEqual([]);
  });
});
