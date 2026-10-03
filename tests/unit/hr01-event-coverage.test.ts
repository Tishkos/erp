/**
 * REQ-HR-001 H8 — every service writing a table that carries `employee_id`
 * writes its history or its audit in the same transaction (the A2 pattern).
 *
 * Held statically, the way hd07 holds the business date: the only module
 * allowed to write the employee tables is `services/employees.ts`, and every
 * exported function there that writes one of them also calls `history(` or
 * `recordChange(` — so a new mutation cannot be added without its row. A
 * second writer elsewhere fails this test rather than the audit.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SERVICES = join(ROOT, 'src/server/services');
// HR-3 — a person's own pay component figures are compensation too.
const EMPLOYEE_TABLES = ['employee', 'employeeHistory', 'employeeCompensation', 'employeePayComponent'] as const;

function writes(source: string): string[] {
  const found: string[] = [];
  for (const table of EMPLOYEE_TABLES) {
    const pattern = new RegExp(`\\.(insert|update|delete)\\(${table}\\)`, 'g');
    if (pattern.test(source)) found.push(table);
  }
  return found;
}

describe('H8 · employee tables are written by one module, with history', () => {
  const files = readdirSync(SERVICES).filter((f) => f.endsWith('.ts'));

  it('only services/employees.ts writes employee, employee_history, employee_compensation or employee_pay_component', () => {
    const writers = files.filter((file) => writes(readFileSync(join(SERVICES, file), 'utf8')).length > 0);
    expect(writers).toEqual(['employees.ts']);
  });

  it('every exported function in employees.ts that writes a row also writes its history or audit', () => {
    const source = readFileSync(join(SERVICES, 'employees.ts'), 'utf8');
    // Split at exported functions; each chunk is one function's body up to the next export.
    const chunks = source.split(/\nexport async function /).slice(1);
    const offenders: string[] = [];
    for (const chunk of chunks) {
      const name = chunk.slice(0, chunk.indexOf('('));
      const body = chunk;
      const mutates = /\.(insert|update)\((employee|employeeCompensation|employeePayComponent)\)/.test(body);
      if (!mutates) continue;
      const records = /\bhistory\(/.test(body) || /\brecordChange\(/.test(body);
      if (!records) offenders.push(name);
    }
    expect(offenders).toEqual([]);
    // And the writers exist: this is not a test passing on an empty set.
    expect(chunks.filter((c) => /\.(insert|update)\((employee|employeeCompensation)\)/.test(c)).length).toBeGreaterThanOrEqual(5);
  });

  it('history and compensation rows are never updated or deleted by the application', () => {
    const source = readFileSync(join(SERVICES, 'employees.ts'), 'utf8');
    expect(source).not.toMatch(/\.(update|delete)\(employeeHistory\)/);
    expect(source).not.toMatch(/\.(update|delete)\(employeeCompensation\)/);
    expect(source).not.toMatch(/\.(update|delete)\(employeePayComponent\)/);
    expect(readFileSync(join(ROOT, 'src/server/db/migrations/0262_hr_payroll.sql'), 'utf8')).toMatch(/employee_pay_component_append_only/);
    const migration = readFileSync(join(ROOT, 'src/server/db/migrations/0241_hr_people.sql'), 'utf8');
    expect(migration).toMatch(/employee_history_append_only/);
    expect(migration).toMatch(/employee_compensation_append_only/);
    expect(migration).toMatch(/GRANT SELECT, INSERT ON "employee_history", "employee_compensation" TO erp_app/);
  });
});
