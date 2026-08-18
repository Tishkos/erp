/**
 * Phase 01.3 test gate — §5.2's routing rule.
 *
 * The execution effects and the inbox need a database and are in
 * tests/integration/phase01-department-routing.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  DepartmentRoutingError,
  NoDepartmentManagerError,
  assignApprover,
  isManagerOf,
  isMemberOf,
  routeFor,
  type RoutingActor,
} from '@domain/department-routing';

/** The blueprint's own example: manager of Finance, ordinary user in Sales. */
const managerOfFinance: RoutingActor = {
  userId: 'user-x',
  departments: [
    { code: 'FIN', isManager: true },
    { code: 'SLS', isManager: false },
  ],
};

const ordinaryUser: RoutingActor = {
  userId: 'user-y',
  departments: [{ code: 'FIN', isManager: false }],
};

describe('§5.2 · the toggle is per department', () => {
  it('reports manager only for the department managed', () => {
    expect(isManagerOf(managerOfFinance, 'FIN')).toBe(true);
    expect(isManagerOf(managerOfFinance, 'SLS')).toBe(false);
  });

  it('reports membership separately from management', () => {
    expect(isMemberOf(managerOfFinance, 'SLS')).toBe(true);
    expect(isManagerOf(managerOfFinance, 'SLS')).toBe(false);
  });

  it('reports nothing for a department the user is not in', () => {
    expect(isManagerOf(managerOfFinance, 'HR')).toBe(false);
    expect(isMemberOf(managerOfFinance, 'HR')).toBe(false);
  });
});

describe('§5.2 · finalise directly, or submit', () => {
  it('finalises a Finance document directly for the Finance manager', () => {
    // The 01.3 gate, first half.
    const decision = routeFor(managerOfFinance, 'FIN');
    expect(decision.outcome).toBe('finalise_directly');
    expect(decision.reason).toMatch(/You manage FIN/);
  });

  it('makes the same person submit a Sales document', () => {
    // The 01.3 gate, second half. Same user, different department.
    const decision = routeFor(managerOfFinance, 'SLS');
    expect(decision.outcome).toBe('submit_to_department_manager');
    expect(decision.departmentCode).toBe('SLS');
  });

  it('makes an ordinary user submit, in their own department', () => {
    expect(routeFor(ordinaryUser, 'FIN').outcome).toBe('submit_to_department_manager');
  });

  it('routes by the document’s department, never by the author’s', () => {
    // A manager of Finance raising a Sales document does not get to finalise it
    // because they manage something. This is the whole of the rule.
    expect(routeFor(managerOfFinance, 'FIN').outcome).toBe('finalise_directly');
    expect(routeFor(managerOfFinance, 'HR').outcome).toBe('submit_to_department_manager');
  });

  it('refuses to route a document with no department', () => {
    // There is no default to fall back on — a default is how the wrong manager
    // ends up approving.
    expect(() => routeFor(managerOfFinance, '  ')).toThrow(DepartmentRoutingError);
  });
});

describe('§5.2 · picking the approver', () => {
  it('assigns the department’s manager', () => {
    expect(assignApprover('SLS', ['manager-1'], 'user-x')).toBe('manager-1');
  });

  it('prefers a manager who is not the author', () => {
    expect(assignApprover('SLS', ['user-x', 'manager-2'], 'user-x')).toBe('manager-2');
  });

  it('refuses when the department has no manager', () => {
    // Falling back to "whoever is available" is a document approved by someone
    // with no authority over it, and the failure is silent until an audit.
    expect(() => assignApprover('SLS', [], 'user-x')).toThrow(NoDepartmentManagerError);
    expect(() => assignApprover('SLS', [], 'user-x')).toThrow(/Assign one before raising/);
  });
});
