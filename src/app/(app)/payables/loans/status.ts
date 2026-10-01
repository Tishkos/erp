/** The chip a loan status wears — the shared status palette, nothing new drawn. */
export const LOAN_CHIP: Readonly<Record<string, string>> = {
  draft: 'draft',
  approved: 'approved',
  active: 'submitted',
  fully_repaid: 'settled',
  cancelled: 'cancelled',
};

/** …and an instalment's. */
export const INSTALMENT_CHIP: Readonly<Record<string, string>> = {
  upcoming: 'draft',
  due: 'submitted',
  paid: 'settled',
  overdue: 'rejected',
};
