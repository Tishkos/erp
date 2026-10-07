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

// The thirteen in three headings since 2026-10-07 (by direction: grouped by
// what they do, like Payables) — the sponsor's order kept across them.
const HR_SECTIONS = ['hr_payroll', 'hr_time_pay', 'hr_talent'] as const;
const sections = HR_SECTIONS.map((key) => MENU.find((section) => section.key === key)!);
const hr = { items: sections.flatMap((section) => section.items.map((item) => ({ ...item, sectionKey: section.key }))) };
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
    expect(sections.map((section) => en.nav[section.key])).toEqual(['People & Organisation', 'Time & Pay', 'Talent & Requests']);
  });

  it('every one of the thirteen is built, under /hr (REQ-HR-001 HR-6)', () => {
    const built = hr.items.filter((item) => isDelivered(routeFor(item, item.sectionKey))).map((item) => routeFor(item, item.sectionKey));
    expect(built).toEqual([
      '/hr/dashboard',
      '/hr/employees',
      '/hr/departments',
      '/hr/positions',
      '/hr/attendance',
      '/hr/leave',
      '/hr/payroll',
      '/hr/advances',
      '/hr/recruitment',
      '/hr/performance',
      '/hr/requests',
      '/hr/documents',
      '/hr/reports',
    ]);
  });
});
