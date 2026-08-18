/**
 * Phase 01.2 test gate — the parts that are decidable without a database.
 *
 * The direct-URL and direct-API assertions from the same gate need a real
 * request and a real RLS policy; they live in
 * tests/integration/phase01-platform-core.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  PERMISSION_VERBS,
  PermissionDeniedError,
  ScopeDeniedError,
  assertBranchInScope,
  assertCan,
  can,
  canAccessBranch,
  isDepartmentManager,
  isInDepartment,
  isPermissionVerb,
  type Principal,
} from '@domain/permissions';

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: 'u-1',
    isSuperUser: false,
    isActive: true,
    roleCodes: [],
    grants: [],
    branchCodes: [],
    departments: [],
    ...overrides,
  };
}

describe('§5.3 · the verb list', () => {
  it('is exactly the thirteen verbs the blueprint names', () => {
    expect(PERMISSION_VERBS).toEqual([
      'view',
      'create',
      'edit_draft',
      'submit',
      'approve',
      'execute',
      'post',
      'reverse_cancel',
      'print',
      'export',
      'import',
      'configure',
      'administer',
    ]);
    expect(PERMISSION_VERBS).toHaveLength(13);
  });

  it('rejects anything outside the list', () => {
    expect(isPermissionVerb('view')).toBe(true);
    expect(isPermissionVerb('delete')).toBe(false);
    expect(isPermissionVerb('VIEW')).toBe(false);
  });
});

describe('§25 · deny by default', () => {
  it('denies every verb on every object when no grant exists', () => {
    const user = principal();
    for (const verb of PERMISSION_VERBS) {
      expect(can(user, verb, 'journal_entry')).toBe(false);
    }
  });

  it('denies an object that has no grants defined anywhere', () => {
    // 01.2 gate: "A newly added object with no grants defined is inaccessible
    // to all non-Super-Users by default."
    const user = principal({ grants: [{ object: 'journal_entry', verb: 'view' }] });
    expect(can(user, 'view', 'money_transfer')).toBe(false);
  });

  it('denies everything once every grant is removed from the role', () => {
    const granted = principal({
      grants: [
        { object: 'journal_entry', verb: 'view' },
        { object: 'journal_entry', verb: 'post' },
      ],
    });
    expect(can(granted, 'post', 'journal_entry')).toBe(true);

    const revoked = principal({ grants: [] });
    for (const verb of PERMISSION_VERBS) {
      expect(can(revoked, verb, 'journal_entry')).toBe(false);
    }
  });

  it('throws a named error rather than returning silently', () => {
    expect(() => assertCan(principal(), 'post', 'journal_entry')).toThrow(PermissionDeniedError);
    expect(() => assertCan(principal(), 'post', 'journal_entry')).toThrow(
      /'post' on 'journal_entry'/,
    );
  });
});

describe('§5.3 · verbs do not imply one another', () => {
  const viewer = principal({ grants: [{ object: 'trial_balance', verb: 'view' }] });
  const approver = principal({ grants: [{ object: 'journal_entry', verb: 'approve' }] });

  it('granting view does not confer export', () => {
    expect(can(viewer, 'view', 'trial_balance')).toBe(true);
    expect(can(viewer, 'export', 'trial_balance')).toBe(false);
  });

  it('granting approve does not confer post', () => {
    expect(can(approver, 'approve', 'journal_entry')).toBe(true);
    expect(can(approver, 'post', 'journal_entry')).toBe(false);
  });

  it('a grant on one object says nothing about another', () => {
    expect(can(viewer, 'view', 'general_ledger')).toBe(false);
  });
});

describe('§5.1 · Super User and deactivation', () => {
  it('a Super User holds full administration access', () => {
    const su = principal({ isSuperUser: true });
    for (const verb of PERMISSION_VERBS) {
      expect(can(su, verb, 'anything_at_all')).toBe(true);
    }
    expect(canAccessBranch(su, 'ANY')).toBe(true);
  });

  it('deactivation denies everything, Super User included', () => {
    // §25 requires revocation to be immediate. A deactivated Super User who
    // keeps administration access until their session expires is not revoked.
    const su = principal({ isSuperUser: true, isActive: false });
    expect(can(su, 'administer', 'user')).toBe(false);
    expect(canAccessBranch(su, 'BGW')).toBe(false);
    expect(isDepartmentManager({ ...su, departments: [{ code: 'FIN', isManager: true }] }, 'FIN')).toBe(
      false,
    );
  });
});

describe('§5.1 · branch data scope', () => {
  const user = principal({
    grants: [{ object: 'journal_entry', verb: 'view' }],
    branchCodes: ['BGW'],
  });

  it('permits the assigned branch and refuses every other', () => {
    expect(canAccessBranch(user, 'BGW')).toBe(true);
    expect(canAccessBranch(user, 'BSR')).toBe(false);
  });

  it('treats no assigned branch as none, never as all', () => {
    expect(canAccessBranch(principal(), 'BGW')).toBe(false);
  });

  it('throws a scope error distinct from a permission error', () => {
    // The two are different failures and are audited differently: one is a
    // missing grant, the other is a record outside the user's world.
    expect(() => assertBranchInScope(user, 'BSR')).toThrow(ScopeDeniedError);
    expect(() => assertBranchInScope(user, 'BSR')).toThrow(/branch 'BSR'/);
  });
});

describe('§5.2 · the Department Manager toggle is per department', () => {
  // The blueprint's own example: manager in one department, ordinary user in
  // another. The flag lives on the assignment, not on the user.
  const user = principal({
    departments: [
      { code: 'FIN', isManager: true },
      { code: 'SLS', isManager: false },
    ],
  });

  it('reports manager only for the department they manage', () => {
    expect(isDepartmentManager(user, 'FIN')).toBe(true);
    expect(isDepartmentManager(user, 'SLS')).toBe(false);
  });

  it('reports membership separately from management', () => {
    expect(isInDepartment(user, 'SLS')).toBe(true);
    expect(isInDepartment(user, 'HR')).toBe(false);
  });

  it('does not make a Super User a Department Manager by implication', () => {
    // §5.3 keeps department access and approval authority separate. A Super
    // User has administration access (§5.1); that is not approval authority,
    // and conflating them would silently widen every approval route.
    const su = principal({ isSuperUser: true });
    expect(isDepartmentManager(su, 'FIN')).toBe(false);
  });
});
