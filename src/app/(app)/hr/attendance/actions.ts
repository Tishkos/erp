'use server';

import { runAdminAndReturn, text } from '@/server/admin-action';
import * as attendance from '@/server/services/attendance';
import type { AttendanceStatus } from '@/server/domain/hr-time';

/**
 * The day sheet saved — REQ-HR-001 Stage HR-2 (§8). Each line carries its
 * person; a line left without a status is left as it was.
 */
export async function saveAttendanceSheet(form: FormData): Promise<void> {
  const branchCode = text(form, 'branch');
  const day = text(form, 'day');
  const department = text(form, 'department');
  const rows = Number(text(form, 'rows')) || 0;
  const entries: attendance.SheetEntry[] = [];
  for (let row = 0; row < rows; row += 1) {
    const employeeId = text(form, `employee_${row}`);
    if (!employeeId) continue;
    entries.push({
      employeeId,
      status: (text(form, `status_${row}`) || '') as AttendanceStatus | '',
      checkIn: text(form, `check_in_${row}`) || null,
      checkOut: text(form, `check_out_${row}`) || null,
      note: text(form, `note_${row}`) || null,
    });
  }
  const back = `/hr/attendance?${new URLSearchParams({ branch: branchCode, day, ...(department ? { department } : {}) }).toString()}`;
  await runAdminAndReturn((tx, ctx) => attendance.saveSheet(tx, ctx, { branchCode, day, entries }), back);
}
