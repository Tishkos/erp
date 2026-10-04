/** Which existing status chip each state of a recurring journal wears. */
export const RECURRING_CHIP: Readonly<Record<string, string>> = {
  draft: 'draft',
  active: 'posted',
  paused: 'submitted',
  ended: 'closed',
};
