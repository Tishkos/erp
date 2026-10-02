/**
 * REQ-FIX-001 FX15 — the HR menu in the sponsor's order (2026-10-02):
 * Dashboard, Employees, Departments, Positions, Attendance, Leave
 * Management, Payroll, Advances & Loans, Recruitment, Performance, Employee
 * Requests, Documents, Reports. Employees, Departments and Positions are
 * built; the rest arrive with REQ-HR-001's stages and keep their derived
 * addresses until then.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MENU } from '@domain/menu';
import { isDelivered, routeFor } from '@domain/screens';

const hr = MENU.find((section) => section.key === 'hr_payroll')!;
const en = JSON.parse(readFileSync(join(process.cwd(), 'messages/en.json'), 'utf8')) as { page: Record<string, string>; nav: Record<string, string> };

describe('FX15 · the HR menu', () => {
  it('is the sponsor’s thirteen, in his order', () => {
    expect(hr.items.map((item) => en.page[item.key])).toEqual([
      'Dashboard',
      'Employees',
      'Departments',
      'Positions',
      'Attendance',
      'Leave Management',
      'Payroll',
      'Advances & Loans',
      'Recruitment',
      'Performance',
      'Employee Requests',
      'Documents',
      'Reports',
    ]);
    expect(en.nav.hr_payroll).toBe('Human Resources');
  });

  it('Employees, Departments, Positions, Attendance, Leave Management and Payroll are built, under /hr', () => {
    const built = hr.items.filter((item) => isDelivered(routeFor(item, hr.key))).map((item) => routeFor(item, hr.key));
    expect(built).toEqual(['/hr/employees', '/hr/departments', '/hr/positions', '/hr/attendance', '/hr/leave', '/hr/payroll']);
  });
});
