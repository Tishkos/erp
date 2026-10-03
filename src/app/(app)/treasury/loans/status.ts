/** The chip a loan status wears — the shared status palette, nothing new drawn. */
export const LOAN_CHIP: Readonly<Record<string, string>> = {
  draft: 'draft',
  // Waiting for somebody else to agree the bank's offer (0273).
  submitted: 'submitted',
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
