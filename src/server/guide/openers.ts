/**
 * What on a page opens a window without saving anything — found, keyed and
 * prepared for a picture.
 *
 * Written for the pictures made ahead of time (`scripts/guide/make-screens.ts`,
 * 2026-10-04/05) and moved here on 2026-10-05, when the owner retired those
 * ("no more training picture … always live"): the live camera
 * (`services/live-screenshot.ts`) now shows the form that opens, a window and
 * the menu itself, and it must find them by exactly the rule that was proven
 * over every screen of the menu — a button whose NEXT SIBLING is a `<dialog>`
 * opens that dialog and does nothing else; a button with no dialog after it
 * acts at once and is never pressed.
 *
 * Everything here is text handed to the page, or pure: no browser, no
 * database, nothing that names a person.
 */
/** The menu's picture: the entry to click, ringed. (Everything else is pointed at by the shared markers.) */
export const RING = `
  outline: 3px solid #e11d48 !important;
  outline-offset: 3px !important;
  box-shadow: 0 0 0 8px rgba(225, 29, 72, 0.25) !important;
  border-radius: 4px !important;
`;

/*
 * The snippets below run in the page, and are handed over as text on purpose: a
 * function given to `page.evaluate` is compiled by tsx first, which wraps every
 * inner function in a helper (`__name`) the page has never heard of.
 */

/**
 * What on this page opens a dialog without saving anything: a button whose
 * next sibling is a `<dialog>` — the doors of a record's title bar are that,
 * and so is every "New …", "Reverse", "Add …" that asks before it acts — and
 * the Print / Export menu of a list. A button with no dialog after it acts at
 * once, and is never one of these. In a table only the first row's are taken:
 * every row opens the same dialog.
 *
 * Each is tagged (`data-guide-dialog`) with its place among them, which is the
 * same in both languages — the page is the same page.
 */
export const FIND_OPENERS = String.raw`(function () {
  var main = document.querySelector('main') || document.body;
  var out = [];
  var order = 0;
  var firstRows = [];
  function classOf(el) {
    var raw = el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className;
    return String(raw || '');
  }
  function shown(el) {
    if (!el || !el.getClientRects().length) return false;
    var rect = el.getBoundingClientRect();
    if (rect.width < 3 || rect.height < 3) return false;
    var style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }
  function tidy(text) {
    return String(text || '').replace(/\(\d+\)\s*$/, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  }
  var old = document.querySelectorAll('[data-guide-dialog]');
  for (var o = 0; o < old.length; o += 1) old[o].removeAttribute('data-guide-dialog');
  var all = main.querySelectorAll('button, details[data-export-menu] > summary');
  for (var i = 0; i < all.length; i += 1) {
    var el = all[i];
    var menu = el.tagName === 'SUMMARY';
    if (!menu) {
      var next = el.nextElementSibling;
      if (!next || next.tagName !== 'DIALOG' || el.disabled) continue;
    }
    if (el.closest('dialog') || el.hasAttribute('data-guide-form-opener') || !shown(el)) continue;
    var row = el.closest('tbody tr');
    if (row) {
      var table = row.closest('table');
      var known = null;
      for (var k = 0; k < firstRows.length; k += 1) if (firstRows[k].table === table) known = firstRows[k];
      if (!known) firstRows.push({ table: table, row: row });
      else if (known.row !== row) continue;
    }
    order += 1;
    var sign = '';
    if (menu) sign = 'export-menu';
    else if (/sapIconButton/.test(classOf(el))) {
      var svg = el.querySelector('svg');
      sign = svg ? classOf(svg) : '';
    }
    el.setAttribute('data-guide-dialog', String(order));
    out.push({ order: order, name: tidy(el.getAttribute('title') || el.getAttribute('aria-label') || el.textContent), sign: sign, menu: menu });
  }
  return out;
})()`;

/** How far the open dialog's own scrolling area runs past what is shown. */
export const DIALOG_OVERFLOW = `(function () {
  var dialog = document.querySelector('dialog[open]');
  if (!dialog) return 0;
  var worst = 0;
  var all = [dialog].concat(Array.prototype.slice.call(dialog.querySelectorAll('*')));
  for (var i = 0; i < all.length; i += 1) {
    var over = all[i].scrollHeight - all[i].clientHeight;
    if (over <= worst || all[i].clientHeight < 40) continue;
    var flow = getComputedStyle(all[i]).overflowY;
    if (flow === 'auto' || flow === 'scroll') worst = over;
  }
  return worst;
})()`;

export interface Opener {
  readonly order: number;
  readonly name: string;
  readonly sign: string;
  readonly menu: boolean;
}

/** The doors of a record are the same four everywhere, whatever language names them. */
export const DOORS: ReadonlyArray<readonly [RegExp, string]> = [
  [/printer/, 'print_export'],
  [/paperclip/, 'attachments'],
  [/message|note/, 'notes'],
  [/history|clock/, 'audit_log'],
];

/** An opener's key from what does not change with the language, else from its English name. */
export function keyOf(opener: Opener): string {
  if (opener.menu) return 'print_export';
  for (const [icon, key] of DOORS) if (opener.sign && icon.test(opener.sign)) return key;
  const slug = opener.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return slug || `d${opener.order}`;
}


/**
 * Two things about a dialog that the shared markers do not allow for yet, put
 * right in the page for the length of one picture and put back afterwards:
 *
 *   * Two dialogs of the same form on one page ("New line" in the header, and
 *     "Edit" on every row) share their fields' ids, and a `<label for>` answers
 *     for the FIRST field with its id — so the second dialog's fields have no
 *     label of their own. Each such field and its label are given an id of
 *     their own (and the hint that is named by id with them).
 *   * A dialog opened from a table's row is itself inside that row's cell. The
 *     markers take a field inside a cell for a cell of a grid, and a button
 *     inside a table for a row's button, and number neither. The dialog is
 *     lifted out of the table — closed, moved to the page's own container (so
 *     it is styled as it was), opened again — and goes home afterwards.
 */
export const PREPARE_DIALOG = String.raw`(function () {
  var dialog = document.querySelector('dialog[open]');
  if (!dialog) return 0;
  var changed = 0;
  var serial = 0;
  var fields = dialog.querySelectorAll('input:not([type="hidden"]), select, textarea');
  for (var i = 0; i < fields.length; i += 1) {
    var field = fields[i];
    var own = field.labels && field.labels[0] && dialog.contains(field.labels[0]);
    if (own || field.closest('label') || !field.parentNode) continue;
    var wrap = field.parentNode;
    var label = wrap.querySelector(':scope > label');
    if (!label || wrap.querySelectorAll('input:not([type="hidden"]), select, textarea').length !== 1) continue;
    serial += 1;
    var id = 'guide-field-' + serial;
    field.setAttribute('data-guide-was-id', field.id || '');
    label.setAttribute('data-guide-was-for', label.getAttribute('for') || '');
    field.id = id;
    label.setAttribute('for', id);
    var hint = wrap.querySelector('[class*="hint"][id]');
    if (hint && field.getAttribute('aria-describedby')) {
      hint.setAttribute('data-guide-was-id', hint.id);
      field.setAttribute('data-guide-was-described', field.getAttribute('aria-describedby'));
      hint.id = id + '-hint';
      field.setAttribute('aria-describedby', id + '-hint');
    }
    changed += 1;
  }
  if (dialog.parentNode && dialog.parentNode.closest && dialog.parentNode.closest('table')) {
    var host = dialog.closest('[class*="sapPage"]') || document.querySelector('main') || document.body;
    var home = document.createComment('guide-dialog-home');
    dialog.parentNode.insertBefore(home, dialog);
    window.__guideDialogHome = home;
    dialog.close();
    host.appendChild(dialog);
    dialog.showModal();
    dialog.setAttribute('data-guide-lifted', '');
    changed += 1;
  }
  return changed;
})()`;

export const RESTORE_DIALOG = String.raw`(function () {
  var lifted = document.querySelector('dialog[data-guide-lifted]');
  var home = window.__guideDialogHome;
  if (lifted) {
    lifted.removeAttribute('data-guide-lifted');
    if (lifted.open) lifted.close();
    if (home && home.parentNode) {
      home.parentNode.insertBefore(lifted, home);
      home.parentNode.removeChild(home);
    }
  }
  window.__guideDialogHome = null;
  var all = document.querySelectorAll('[data-guide-was-id], [data-guide-was-for], [data-guide-was-described]');
  for (var i = 0; i < all.length; i += 1) {
    var el = all[i];
    if (el.hasAttribute('data-guide-was-id')) {
      var id = el.getAttribute('data-guide-was-id');
      if (id) el.id = id;
      else el.removeAttribute('id');
      el.removeAttribute('data-guide-was-id');
    }
    if (el.hasAttribute('data-guide-was-for')) {
      var was = el.getAttribute('data-guide-was-for');
      if (was) el.setAttribute('for', was);
      else el.removeAttribute('for');
      el.removeAttribute('data-guide-was-for');
    }
    if (el.hasAttribute('data-guide-was-described')) {
      el.setAttribute('aria-describedby', el.getAttribute('data-guide-was-described'));
      el.removeAttribute('data-guide-was-described');
    }
  }
})()`;
