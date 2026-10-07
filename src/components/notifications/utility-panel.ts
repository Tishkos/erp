/**
 * The root of what the bell's popover and the messages drawer draw inside the
 * shell's `.erp-utility-popover` (erp-shell.tsx owns that box, its place and
 * its width).
 *
 * Each panel brings its own header — the title with the count and the action
 * beside it — its own scrolling list and its own footer, so it asks the box it
 * sits in (through `:has`, only while it is there) to let it reach the edges:
 * no padding, no scrolling of its own, the shell's plain heading not drawn.
 * Nothing else about the box changes.
 */
export const UTILITY_PANEL = [
  'flex min-h-0 flex-1 flex-col',
  '[.erp-utility-popover:has(>&)]:flex [.erp-utility-popover:has(>&)]:flex-col',
  '[.erp-utility-popover:has(>&)]:p-0 [.erp-utility-popover:has(>&)]:overflow-hidden',
  // `\_` keeps the underscores (Tailwind reads a bare one as a space); raw, so the class and the scanned text agree.
  String.raw`[.erp-utility-popover:has(>&)>.erp-utility-popover\_\_heading]:hidden`,
].join(' ');

/** A panel's header row: the title at the start, the count beside it, the action at the end. */
export const PANEL_HEADER = 'flex items-center gap-2 px-4 pt-3.5 pb-2.5';

/** The panel's footer link — "See all notifications", "Open Chat". */
export const PANEL_FOOTER_LINK = [
  'flex items-center justify-center gap-1.5 border-t border-border px-4 py-2.5',
  'text-sm font-medium text-primary-subtle-fg no-underline transition-colors hover:bg-muted hover:text-primary-subtle-fg',
  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
].join(' ');
