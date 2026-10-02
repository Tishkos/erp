'use server';

/**
 * HR settings — REQ-HR-001 §5–§7 (R4). Nothing deletes; a row is
 * deactivated; a calendar's holiday may be removed, since a holiday nothing
 * has referenced yet is a line in a list, not history.
 */
import { flag, runAdminAndReturn, text } from '@/server/admin-action';
import * as settings from '@/server/services/hr-settings';

const BACK = '/administration/hr-settings';

export async function savePayComponent(form: FormData): Promise<void> {
  const code = text(form, 'code');
  const existing = text(form, 'existing') === '1';
  const input = {
    nameEn: text(form, 'name_en'),
    nameAr: text(form, 'name_ar') || null,
    kind: text(form, 'kind'),
    calculation: text(form, 'calculation'),
    defaultValue: text(form, 'default_value') || null,
    taxable: flag(form, 'taxable'),
    // HR-3 — where it posts; empty leaves it to the posting mapping.
    expenseAccountId: text(form, 'expense_account_id') || null,
    liabilityAccountId: text(form, 'liability_account_id') || null,
  };
  await runAdminAndReturn(
    (tx, ctx) => (existing ? settings.updatePayComponent(tx, ctx, code, input) : settings.createPayComponent(tx, ctx, { code, ...input })),
    BACK,
  );
}

export async function setPayComponentActive(form: FormData): Promise<void> {
  await runAdminAndReturn((tx, ctx) => settings.setPayComponentActive(tx, ctx, text(form, 'code'), text(form, 'active') === '1', text(form, 'reason') || null), BACK);
}

export async function saveLeaveType(form: FormData): Promise<void> {
  const code = text(form, 'code');
  const existing = text(form, 'existing') === '1';
  const input = {
    nameEn: text(form, 'name_en'),
    nameAr: text(form, 'name_ar') || null,
    daysPerYear: text(form, 'days_per_year'),
    carryOverDays: text(form, 'carry_over_days') || null,
    paid: flag(form, 'paid'),
    requiresAttachment: flag(form, 'requires_attachment'),
    allowedNegativeDays: text(form, 'allowed_negative_days') || null,
    warnBeforeLapse: flag(form, 'warn_before_lapse'),
  };
  await runAdminAndReturn(
    (tx, ctx) => (existing ? settings.updateLeaveType(tx, ctx, code, input) : settings.createLeaveType(tx, ctx, { code, ...input })),
    BACK,
  );
}

export async function setLeaveTypeActive(form: FormData): Promise<void> {
  await runAdminAndReturn((tx, ctx) => settings.setLeaveTypeActive(tx, ctx, text(form, 'code'), text(form, 'active') === '1', text(form, 'reason') || null), BACK);
}

export async function saveCalendar(form: FormData): Promise<void> {
  const code = text(form, 'code');
  const existing = text(form, 'existing') === '1';
  await runAdminAndReturn(
    (tx, ctx) =>
      existing
        ? settings.updateCalendar(tx, ctx, code, { nameEn: text(form, 'name_en'), nameAr: text(form, 'name_ar') || null, workingDays: text(form, 'working_days') })
        : settings.createCalendar(tx, ctx, { code, nameEn: text(form, 'name_en'), nameAr: text(form, 'name_ar') || null, year: text(form, 'year'), workingDays: text(form, 'working_days') }),
    BACK,
  );
}

export async function addCalendarHoliday(form: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) => settings.addHoliday(tx, ctx, text(form, 'calendar_code'), { holidayDate: text(form, 'holiday_date'), nameEn: text(form, 'name_en'), nameAr: text(form, 'name_ar') || null }),
    BACK,
  );
}

export async function removeCalendarHoliday(form: FormData): Promise<void> {
  await runAdminAndReturn((tx, ctx) => settings.removeHoliday(tx, ctx, text(form, 'calendar_code'), text(form, 'holiday_date')), BACK);
}

/** HR-2 — the sweep's limits, each a row (R4). */
export async function saveHrParameters(form: FormData): Promise<void> {
  await runAdminAndReturn(async (tx, ctx) => {
    for (const key of settings.PARAMETER_KEYS) {
      const value = text(form, key);
      if (value.trim() !== '') await settings.setParameter(tx, ctx, key, value);
    }
  }, BACK);
}
