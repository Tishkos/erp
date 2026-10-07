/**
 * Intent UI's field frame, for a text box the page writes itself — the
 * filter rows' "type a name" boxes, whose suggestions are a `<datalist>`.
 * The same border, ground, radius, height and focus ring as the Intent
 * dropdown and date picker beside them (intent-select.tsx,
 * intent-date-field.tsx), in every palette, light and dark.
 *
 * A plain module, not a client one: server pages read the string itself.
 */
export const INTENT_INPUT =
  'block h-9 w-full min-w-0 rounded-lg border border-input bg-[var(--w-field,var(--ui-bg))] px-3 text-sm text-fg shadow-xs outline-hidden placeholder:text-muted-fg hover:border-muted-fg/30 focus:border-ring/70 focus:ring-3 focus:ring-ring/20 dark:scheme-dark';

/** A filter box that has to show its placeholder whole. */
export const INTENT_FILTER_FIELD = 'min-w-[15rem]';
