/**
 * The project's status profile on the existing chip tones (REQ-PM-001 §6):
 * draft and active and closed have chips of their own; on hold reads as
 * the "waiting" tone and technically complete as the "executed" one. No raw
 * enum reaches the DOM (HARDEN H3): the label is translated beside it.
 */
export const PROJECT_CHIP: Record<string, string> = { draft: 'draft', active: 'active', on_hold: 'submitted', closing: 'executed', closed: 'closed' };

export const chipOf = (status: string): string => PROJECT_CHIP[status] ?? 'draft';
