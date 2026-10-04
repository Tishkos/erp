/**
 * The pictures Noah sends: every built screen, in both languages, three ways.
 *
 *   npx tsx scripts/guide/make-screens.ts [--only <part of a route>] [--force]
 *
 * By direction (2026-10-04): "if he can take screenshots it would be so good —
 * send it to the group chat and point out what to do". He cannot open a
 * browser from a chat, and a picture of the live books in a group is nobody's
 * wish; so the pictures are taken here, once, from a development copy with
 * sample data, and he sends the one that answers the question:
 *
 *   menu    the module's dropdown open, the screen's entry ringed — where to click
 *   screen  the screen itself, its "New …" button ringed where it has one
 *   form    what opens when that button is pressed — the fields to fill, each
 *           with a red number beside its name, and the button that saves last
 *   record  one record of a list, opened: its status, the doors in its title
 *           bar, its actions and its tables
 *
 * The same day: "step 1 look at this screenshot where I point out, do that,
 * write that in that input" — and then "not just login: all screens,
 * everything". So what a picture shows is numbered in it — a form's fields; a
 * screen's buttons, tabs, search, filters, tables, paging and sections; a
 * record's status, doors and actions — and the numbers are written down beside
 * it (`marks` in `index.json`: the number, the thing's name as the screen
 * shows it, and what kind of thing it is). He can only say "write it in 3" if
 * he knows what 3 is.
 *
 * And four pictures that are not screens of the menu, for the questions asked
 * first: signing in (`/sign-in`, form), the top bar (`top-bar`, screen), the
 * menu behind the avatar (`user-menu`, menu) and changing the password
 * (`/password`, form). `--only sign-in`, `--only top-bar`, … take one.
 *
 * Written to `var/guide-shots/<locale>/…` with an `index.json`; `var/` is not
 * in git. Copy the folder to the server's `var/guide-shots` and Noah's
 * `show_screen` tool finds them (`services/system-guide.ts`).
 * `GUIDE_SHOTS_OUT` writes somewhere else — for a trial that must not disturb
 * a run in progress.
 *
 * Runs against the local development server (http://localhost:3000, the
 * seeded administrator). It reads screens and presses "New …" to open a form;
 * it never presses a form's own button, so it saves nothing.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { MENU } from '../../src/server/domain/menu';
import { MODULES } from '../../src/server/domain/modules';
import { isDelivered, routeFor } from '../../src/server/domain/screens';

const BASE = process.env.GUIDE_BASE_URL ?? 'http://localhost:3000';
const OUT = process.env.GUIDE_SHOTS_OUT?.trim() || join(process.cwd(), 'var', 'guide-shots');
const ONLY = process.argv.includes('--only') ? (process.argv[process.argv.indexOf('--only') + 1] ?? '') : '';
const FORCE = process.argv.includes('--force');
const WIDTH = 1366;
const HEIGHT = 768;
/** No picture carries more numbers than a person can follow. */
const MAX_MARKS = 30;
const MAX_PAGE_MARKS = 24;

type Catalogue = { shell: { module: Record<string, string> } };
const labels = (locale: string) => (JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8')) as Catalogue).shell.module;

/** A route as a file name: /payables/invoices → payables_invoices. */
export const slugOf = (route: string) => route.replace(/^\//, '').replace(/[^a-z0-9]+/gi, '_') || 'home';

/** One numbered pointer in a picture: what the number is on. */
interface Mark {
  readonly n: number;
  /** The field's (or button's) name, as that picture shows it. */
  readonly label: string;
  /** text | choice | date | tick | file | area | button | tabs | search | filter | table | paging | section | status | door | link */
  readonly kind: string;
  readonly required?: boolean;
}

interface Shot {
  readonly route: string;
  readonly locale: 'en' | 'ar';
  readonly view: 'menu' | 'screen' | 'form' | 'record';
  readonly file: string;
  /** On a screen's picture: its "New …" button is ringed. */
  readonly ringed?: boolean;
  /** The numbers drawn on the picture, in order. */
  readonly marks?: ReadonlyArray<Mark>;
}

const RING = `
  outline: 3px solid #e11d48 !important;
  outline-offset: 3px !important;
  box-shadow: 0 0 0 8px rgba(225, 29, 72, 0.25) !important;
  border-radius: 4px !important;
`;

/*
 * The code below runs in the page, and is handed over as text on purpose: a
 * function given to `page.evaluate` is compiled by tsx first, which wraps every
 * inner function in a helper (`__name`) the page has never heard of.
 */

/** What every numbered badge looks like. */
const BADGE_STYLE =
  'display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;min-width:18px;height:18px;padding:0 5px;' +
  'margin:0;margin-inline-end:6px;border-radius:9px;background:#e11d48;color:#fff;font:700 11px/1 Arial,Helvetica,sans-serif;' +
  'letter-spacing:0;text-transform:none;text-decoration:none;vertical-align:middle;flex:none;box-shadow:0 0 0 2px rgba(255,255,255,.9);';

/**
 * Number the fields of a form, and its saving button last.
 *
 * The badge goes inline, at the start of the field's own label: a dialog sits
 * in the browser's top layer, above anything laid over the page, so only what
 * is inside it can be seen on it. A grid's cells have no labels: the column's
 * heading is numbered instead, once. A field nobody named is not numbered.
 */
const MARK_FORM = String.raw`(function (rootSelector, cap, badgeStyle, gridAsOne) {
  var root = document.querySelector(rootSelector) || document.body;
  var marks = [];
  var n = 0;
  var forms = [];
  var seen = [];

  function shown(el) {
    if (!el || !el.getClientRects().length) return false;
    var rect = el.getBoundingClientRect();
    if (rect.width < 3 || rect.height < 3) return false;
    var style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }
  function badge(number) {
    var el = document.createElement('span');
    el.setAttribute('data-guide-mark', '');
    el.setAttribute('style', badgeStyle);
    el.textContent = String(number);
    return el;
  }
  function tidy(text, max) {
    return String(text || '').replace(/\*/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 80);
  }
  function captionOf(el) {
    var copy = el.cloneNode(true);
    var drop = copy.querySelectorAll('[aria-hidden="true"], [data-guide-mark], input, select, textarea, button, small, svg, [class*="hint"]');
    for (var i = 0; i < drop.length; i += 1) if (drop[i].parentNode) drop[i].parentNode.removeChild(drop[i]);
    return tidy(copy.textContent);
  }
  function headRowOf(table) {
    return table && table.tHead && table.tHead.rows.length ? table.tHead.rows[table.tHead.rows.length - 1] : null;
  }
  // A grid of lines on a page: one number for the whole grid, its columns named.
  function gridMark(table) {
    if (!table || seen.indexOf(table) >= 0) return;
    seen.push(table);
    var headRow = headRowOf(table);
    if (!headRow || !shown(headRow) || !headRow.cells.length || n >= cap - 1) return;
    var names = [];
    for (var h = 0; h < headRow.cells.length; h += 1) {
      var name = captionOf(headRow.cells[h]);
      if (name) names.push(name);
    }
    if (!names.length) return;
    n += 1;
    // On the bar that names the grid ("Lines") where there is one: the grid's
    // first column is often only a "#", and its wrapper clips anything hung
    // outside it. Failing that, in the first heading wide enough to take it.
    var bar = null;
    var at = table;
    for (var up = 0; up < 3 && at && at !== root && !bar; up += 1) {
      var before = at.previousElementSibling;
      if (before && shown(before) && (/^H[2-4]$/.test(before.tagName) || /sapGridCaption|sapTitle|panelTitle/.test(String(before.className)))) bar = before;
      at = at.parentNode;
    }
    var host = bar;
    for (var w = 0; w < headRow.cells.length && !host; w += 1) {
      if (captionOf(headRow.cells[w]) && headRow.cells[w].getBoundingClientRect().width >= 70) host = headRow.cells[w];
    }
    if (!host) host = headRow.cells[0];
    host.insertBefore(badge(n), host.firstChild);
    var title = bar ? captionOf(bar).replace(/[▾▸]/g, '').replace(/\s+\d+$/, '').trim() : '';
    marks.push({ n: n, label: tidy((title ? title + ': ' : '') + names.join(' · '), 160), kind: 'table' });
  }
  function kindOf(field) {
    var tag = field.tagName.toLowerCase();
    if (tag === 'select') return 'choice';
    if (tag === 'textarea') return 'area';
    var type = (field.getAttribute('type') || 'text').toLowerCase();
    if (type === 'checkbox' || type === 'radio') return 'tick';
    if (type === 'date' || type === 'datetime-local' || type === 'month' || type === 'time' || type === 'week') return 'date';
    if (type === 'file') return 'file';
    if (field.getAttribute('list') || field.getAttribute('role') === 'combobox') return 'choice';
    return 'text';
  }
  function note(caption, field, label) {
    var mark = { n: n, label: caption, kind: kindOf(field) };
    if (field.required || field.getAttribute('aria-required') === 'true' || (label && label.querySelector('[class*="required"]'))) mark.required = true;
    marks.push(mark);
    if (field.form && forms.indexOf(field.form) < 0) forms.push(field.form);
  }

  var fields = root.querySelectorAll(gridAsOne ? 'input, select, textarea, table' : 'input, select, textarea');
  for (var i = 0; i < fields.length && n < cap - 1; i += 1) {
    var field = fields[i];
    if (field.tagName === 'TABLE') {
      if (shown(field)) gridMark(field);
      continue;
    }
    var type = (field.getAttribute('type') || '').toLowerCase();
    if (type === 'hidden' || type === 'submit' || type === 'button' || type === 'reset' || type === 'image') continue;
    if (field.disabled || !shown(field)) continue;

    var label = (field.labels && field.labels[0]) || field.closest('label');
    if (!label) {
      // A document's own boxes: the caption is the span over the box, not a <label>.
      var holder = field.closest('[class*="sapField"], [class*="sapFilterField"]');
      var over = holder ? holder.querySelector('[class*="sapLabel"]') : null;
      if (over && !over.contains(field)) label = over;
    }
    var cell = field.closest('td');
    if (gridAsOne && cell) {
      // The grid already has its number; its form is still the form that saves.
      if (field.form && forms.indexOf(field.form) < 0) forms.push(field.form);
      continue;
    }
    if (label && shown(label)) {
      if (seen.indexOf(label) >= 0) continue;
      var caption = captionOf(label);
      if (!caption) continue;
      seen.push(label);
      n += 1;
      // A label that wraps its box (a tick): the number goes between the box and its words.
      if (label.contains(field) && field.nextSibling) label.insertBefore(badge(n), field.nextSibling);
      else label.insertBefore(badge(n), label.firstChild);
      note(caption, field, label);
      continue;
    }
    if (cell) {
      var table = cell.closest('table');
      var row = cell.parentNode;
      var at = 0;
      for (var c = 0; c < row.cells.length && row.cells[c] !== cell; c += 1) at += row.cells[c].colSpan || 1;
      var headRow = headRowOf(table);
      var head = null;
      if (headRow) {
        var span = 0;
        for (var h = 0; h < headRow.cells.length; h += 1) {
          if (span === at) { head = headRow.cells[h]; break; }
          span += headRow.cells[h].colSpan || 1;
        }
      }
      if (!head || !shown(head) || seen.indexOf(head) >= 0) continue;
      var heading = captionOf(head);
      if (!heading) continue;
      seen.push(head);
      n += 1;
      head.insertBefore(badge(n), head.firstChild);
      note(heading, field, null);
      continue;
    }
    var named = tidy(field.getAttribute('aria-label') || field.getAttribute('placeholder'));
    if (!named) continue;
    n += 1;
    // Out of the flow, at the field's own corner: nothing moves to make room for it.
    var corner = badge(n);
    corner.style.position = 'absolute';
    corner.style.marginTop = '-9px';
    corner.style.marginInlineStart = '-7px';
    corner.style.marginInlineEnd = '0';
    corner.style.zIndex = '5';
    field.parentNode.insertBefore(corner, field);
    note(named, field, null);
  }

  // The button that saves: the last of the form's own, outside any grid.
  var buttons = root.querySelectorAll('button, input[type="submit"]');
  var saving = [];
  for (var b = 0; b < buttons.length; b += 1) {
    var button = buttons[b];
    if ((button.type || '').toLowerCase() !== 'submit' || button.disabled || !shown(button)) continue;
    if (!button.form || forms.indexOf(button.form) < 0 || button.closest('table')) continue;
    saving.push(button);
  }
  saving = saving.slice(-2);
  for (var s = 0; s < saving.length && n < cap; s += 1) {
    var text = tidy(saving[s].tagName === 'INPUT' ? saving[s].value : captionOf(saving[s]));
    if (!text) continue;
    n += 1;
    if (saving[s].tagName === 'INPUT') saving[s].parentNode.insertBefore(badge(n), saving[s]);
    else saving[s].insertBefore(badge(n), saving[s].firstChild);
    marks.push({ n: n, label: text, kind: 'button' });
  }
  return marks;
})`;

/**
 * Number what a screen or a record is made of — "all screens, everything"
 * (2026-10-04): the way back, the buttons of the page's heading, the row of
 * tabs (one number), the search box, each filter, each table (one number, its
 * columns named), the paging, each headed section; on a record also its
 * status, the doors in its title bar and the buttons of its actions row; and
 * the fields of a form that is part of the page itself.
 *
 * Nothing is put into the page: each number is laid over it at the corner of
 * what it points at, so the layout the picture shows is the layout there is.
 * Only what the picture shows is numbered (what is below the fold is not), in
 * reading order — down the page, and along each line from its start.
 */
const MARK_PAGE = String.raw`(function (cap, badgeStyle) {
  var main = document.querySelector('main') || document.body;
  var rtl = getComputedStyle(document.documentElement).direction === 'rtl';
  var vh = window.innerHeight;
  var vw = window.innerWidth;
  var found = [];
  var taken = [];
  var usedHeadings = [];
  var claimed = [];

  function has(el, name) {
    var raw = el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className;
    var list = String(raw || '').split(/\s+/);
    for (var i = 0; i < list.length; i += 1) {
      if (list[i] === name || list[i].slice(-(name.length + 2)) === '__' + name) return true;
    }
    return false;
  }
  function withClass(selector, name) {
    var out = [];
    var nodes = main.querySelectorAll(selector);
    for (var i = 0; i < nodes.length; i += 1) if (has(nodes[i], name)) out.push(nodes[i]);
    return out;
  }
  function shown(el) {
    if (!el || !el.getClientRects().length || el.closest('dialog')) return false;
    var rect = el.getBoundingClientRect();
    if (rect.width < 3 || rect.height < 3) return false;
    if (rect.top > vh - 14 || rect.bottom < 2 || rect.left > vw - 4 || rect.right < 4) return false;
    var style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }
  function tidy(text, max) {
    return String(text || '').replace(/\*/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 80);
  }
  function captionOf(el, max) {
    var copy = el.cloneNode(true);
    var drop = copy.querySelectorAll('[aria-hidden="true"], [data-guide-mark], input, select, textarea, button, small, svg, [class*="hint"], [class*="sapTitleActions"], [class*="sapTitleMeta"], [class*="sapGridCount"]');
    for (var i = 0; i < drop.length; i += 1) if (drop[i].parentNode) drop[i].parentNode.removeChild(drop[i]);
    return tidy(copy.textContent, max);
  }
  function nameOf(el) {
    return tidy(captionOf(el) || el.getAttribute('title') || el.getAttribute('aria-label'));
  }
  function add(el, label, kind, place, required) {
    if (!el || !label || taken.indexOf(el) >= 0 || !shown(el)) return false;
    taken.push(el);
    var item = { rect: el.getBoundingClientRect(), label: label, kind: kind, place: place };
    if (required) item.required = true;
    found.push(item);
    return true;
  }
  function kindOf(field) {
    var tag = field.tagName.toLowerCase();
    if (tag === 'select') return 'choice';
    if (tag === 'textarea') return 'area';
    var type = (field.getAttribute('type') || 'text').toLowerCase();
    if (type === 'checkbox' || type === 'radio') return 'tick';
    if (type === 'date' || type === 'datetime-local' || type === 'month' || type === 'time' || type === 'week') return 'date';
    if (type === 'file') return 'file';
    if (field.getAttribute('list') || field.getAttribute('role') === 'combobox') return 'choice';
    return 'text';
  }
  // A field's name, and the element that carries it (where the number goes).
  function labelOf(field) {
    var label = (field.labels && field.labels[0]) || field.closest('label');
    if (!label) {
      var holder = field.closest('[class*="sapField"], [class*="sapFilterField"]');
      var over = holder ? holder.querySelector('[class*="sapLabel"]') : null;
      if (over && !over.contains(field)) label = over;
    }
    if (label && label.getClientRects().length) {
      // The whole label, not only its words: a tick box sits before its words, and the number goes before both.
      var text = captionOf(label);
      if (text) return { text: text, el: label, label: label };
    }
    var named = tidy(field.getAttribute('aria-label') || field.getAttribute('placeholder'));
    return named ? { text: named, el: field, label: null } : null;
  }
  function usable(field) {
    var type = (field.getAttribute('type') || '').toLowerCase();
    if (type === 'hidden' || type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return false;
    return !field.disabled && claimed.indexOf(field) < 0;
  }
  function isHeading(node) {
    if (node.closest('dialog') || node.closest('[class*="pageHeader"]') || !node.getClientRects().length) return false;
    var tag = node.tagName;
    return tag === 'H2' || tag === 'H3' || tag === 'H4' || tag === 'FIGCAPTION' || tag === 'LEGEND' || has(node, 'sapTitle') || has(node, 'sapGridCaption') || has(node, 'panelTitle');
  }
  // The heading a table sits under: the last one before it inside its own window.
  function headingFor(table) {
    var box = table.parentNode;
    while (box && box !== main && !(box.tagName === 'SECTION' || box.tagName === 'FIGURE' || has(box, 'sapWindow') || has(box, 'sapDoc') || has(box, 'panel'))) box = box.parentNode;
    if (!box || box === main) return null;
    var nodes = box.querySelectorAll('h2, h3, h4, figcaption, div, strong');
    var best = null;
    for (var i = 0; i < nodes.length; i += 1) {
      if (!isHeading(nodes[i])) continue;
      if (nodes[i].compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING) best = nodes[i];
    }
    return best;
  }
  // Words that start at the very edge of their box are pointed at from beside them, not from their corner.
  function placeFor(el) {
    return parseFloat(getComputedStyle(el).paddingInlineStart || '0') < 6 ? 'before' : 'corner';
  }

  // The way back, and the buttons beside the page's title.
  var back = withClass('a', 'backButton');
  if (back.length) {
    claimed.push(back[0]);
    add(back[0], nameOf(back[0]), 'link', 'corner');
  }
  var actions = main.querySelectorAll('header [class*="headerActions"] a, header [class*="headerActions"] button');
  for (var a = 0; a < actions.length; a += 1) {
    claimed.push(actions[a]);
    add(actions[a], nameOf(actions[a]), 'button', 'corner');
  }

  // The row of tabs is one thing to point at.
  var bars = withClass('nav', 'tabsBar');
  for (var t = 0; t < bars.length; t += 1) {
    var names = [];
    var tabs = bars[t].querySelectorAll('a, button, span[aria-current]');
    for (var k = 0; k < tabs.length; k += 1) {
      var tab = tidy(tabs[k].textContent);
      if (tab && names.indexOf(tab) < 0) names.push(tab);
    }
    add(bars[t], tidy(names.join(' · '), 120), 'tabs', 'corner');
  }

  // Search, then the filters.
  var searches = main.querySelectorAll('form[role="search"]');
  for (var s = 0; s < searches.length; s += 1) {
    var box = searches[s].querySelector('input');
    var inner = searches[s].querySelectorAll('input, button');
    for (var c = 0; c < inner.length; c += 1) claimed.push(inner[c]);
    add(searches[s], tidy(box ? box.getAttribute('aria-label') || box.getAttribute('placeholder') : ''), 'search', 'corner');
  }
  var filterForms = [];
  var forms = main.querySelectorAll('form');
  for (var f = 0; f < forms.length; f += 1) {
    var form = forms[f];
    if (form.getAttribute('role') === 'search') continue;
    var get = String(form.getAttribute('method') || '').toLowerCase() === 'get';
    if (get || has(form, 'sapFilterBar') || has(form, 'filterBar') || form.querySelector('[class*="filterRow"]')) filterForms.push(form);
  }
  for (var g = 0; g < filterForms.length; g += 1) {
    var controls = filterForms[g].querySelectorAll('input, select, textarea');
    for (var q = 0; q < controls.length; q += 1) {
      if (!usable(controls[q])) continue;
      var named = labelOf(controls[q]);
      claimed.push(controls[q]);
      if (named) add(named.el, named.text, 'filter', named.el === controls[q] ? 'corner' : 'before');
    }
    var go = filterForms[g].querySelectorAll('button, a');
    for (var w = 0; w < go.length; w += 1) {
      claimed.push(go[w]);
      add(go[w], nameOf(go[w]), 'button', 'corner');
    }
  }

  // Each table is one thing: its heading where it has one, and its columns.
  var tables = main.querySelectorAll('table');
  for (var x = 0; x < tables.length; x += 1) {
    var table = tables[x];
    var headRow = table.tHead && table.tHead.rows.length ? table.tHead.rows[table.tHead.rows.length - 1] : null;
    var columns = [];
    if (headRow) {
      for (var h = 0; h < headRow.cells.length; h += 1) {
        var column = captionOf(headRow.cells[h]);
        if (column) columns.push(column);
      }
    }
    var heading = headingFor(table);
    var title = heading ? captionOf(heading) : '';
    var label = tidy((title ? title + (columns.length ? ': ' : '') : '') + columns.join(' · '), 160);
    if (add(headRow && headRow.getClientRects().length ? headRow : table, label, 'table', 'corner') && heading) usedHeadings.push(heading);
  }

  var pagers = withClass('nav', 'pagination');
  for (var p = 0; p < pagers.length; p += 1) add(pagers[p], tidy(pagers[p].getAttribute('aria-label')), 'paging', 'corner');

  // A record: its status, the doors in its title bar, the buttons of its actions row.
  var statuses = main.querySelectorAll('[data-status], [class*="profileCard"] > [class*="pill"]');
  var said = 0;
  for (var u = 0; u < statuses.length && said < 3; u += 1) {
    if (statuses[u].closest('table')) continue;
    // In a document's header the box has a caption over it: "Status: Posted".
    var boxed = statuses[u].closest('[class*="sapField"]');
    var over = boxed ? boxed.querySelector('[class*="sapLabel"]') : null;
    var state = tidy((over ? captionOf(over) + ': ' : '') + tidy(statuses[u].textContent));
    // Pointed at from beside its caption: a number on the box's corner would sit on the caption above it.
    if (over ? add(over, state, 'status', 'before') : add(statuses[u], state, 'status', 'corner')) said += 1;
  }
  // The block of labelled boxes at the head of a document is one thing: what it records.
  var blocks = withClass('div', 'sapFields');
  for (var v = 0; v < blocks.length; v += 1) {
    var captions = [];
    var boxes = blocks[v].querySelectorAll('[class*="sapLabel"]');
    for (var y = 0; y < boxes.length; y += 1) {
      var word = captionOf(boxes[y]);
      if (word && captions.indexOf(word) < 0) captions.push(word);
    }
    add(blocks[v], tidy(captions.join(' · '), 160), 'section', 'corner');
  }
  // An icon in a title bar is a door (printer, paperclip, notes, clock); words there are a link.
  var doors = main.querySelectorAll('[class*="sapTitleActions"] a, [class*="sapTitleActions"] button, [class*="sapIconButton"]');
  for (var d = 0; d < doors.length; d += 1) {
    if (claimed.indexOf(doors[d]) >= 0 || doors[d].closest('table')) continue;
    claimed.push(doors[d]);
    var icon = has(doors[d], 'sapIconButton');
    var door = tidy(String(doors[d].getAttribute('title') || doors[d].getAttribute('aria-label') || doors[d].textContent).replace(/\(\d+\)\s*$/, ''));
    add(doors[d], door, icon ? 'door' : 'link', icon ? 'above' : placeFor(doors[d]));
  }
  var rows = withClass('div', 'sapFootActions');
  for (var r = 0; r < rows.length; r += 1) {
    var pressable = rows[r].querySelectorAll('a, button');
    for (var b = 0; b < pressable.length; b += 1) {
      if (claimed.indexOf(pressable[b]) >= 0) continue;
      claimed.push(pressable[b]);
      add(pressable[b], nameOf(pressable[b]), 'button', 'corner');
    }
  }

  // Headed sections that are not already a table's heading.
  var heads = main.querySelectorAll('h2, h3, h4, figcaption, legend, [class*="sapTitle"], [class*="sapGridCaption"], [class*="panelTitle"]');
  for (var e = 0; e < heads.length; e += 1) {
    var head = heads[e];
    if (!isHeading(head) || usedHeadings.indexOf(head) >= 0 || head.closest('table')) continue;
    // A heading inside a title bar that is itself a heading is the same heading.
    if (head.parentNode && head.parentNode !== main && isHeading(head.parentNode)) continue;
    add(head, captionOf(head), 'section', placeFor(head));
  }

  // A form that is part of the page itself (a settings screen): its fields.
  var fields = main.querySelectorAll('input, select, textarea');
  for (var i = 0; i < fields.length; i += 1) {
    var field = fields[i];
    if (!usable(field) || field.closest('table') || field.closest('dialog')) continue;
    var name = labelOf(field);
    if (!name) continue;
    add(name.el, name.text, kindOf(field), name.el === field ? 'corner' : 'before', field.required || (name.label && name.label.querySelector('[class*="required"]')));
  }
  // Every other button on the page that is not part of a table's rows: what
  // saves a form, what opens a dialog, what moves the record on.
  var others = main.querySelectorAll('button, a');
  for (var m = 0; m < others.length; m += 1) {
    var other = others[m];
    if (claimed.indexOf(other) >= 0 || other.closest('table') || other.closest('dialog') || other.disabled) continue;
    if (other.tagName === 'A' && !(has(other, 'action') || has(other, 'button') || has(other, 'action--primary'))) continue;
    if (other.closest('nav')) continue;
    add(other, nameOf(other), 'button', 'corner');
  }

  // Reading order: down the page, and along a line from its start.
  found.sort(function (one, two) {
    if (Math.abs(one.rect.top - two.rect.top) > 14) return one.rect.top - two.rect.top;
    return rtl ? two.rect.right - one.rect.right : one.rect.left - two.rect.left;
  });
  found = found.slice(0, cap);

  var placed = [];
  var marks = [];
  for (var z = 0; z < found.length; z += 1) {
    var item = found[z];
    var rect = item.rect;
    var left;
    var top;
    if (item.place === 'above') {
      left = rect.left + rect.width / 2 - 9;
      top = rect.top - 15;
    } else if (item.place === 'before') {
      left = rtl ? rect.right + 3 : rect.left - 21;
      top = rect.top + Math.min(rect.height, 20) / 2 - 9;
      if (left < 2 || left > vw - 20) {
        left = rtl ? rect.right - 18 : rect.left;
        top = rect.top - 17;
      }
    } else {
      left = rtl ? rect.right - 6 : rect.left - 12;
      top = rect.top - 13;
    }
    left = Math.max(2, Math.min(vw - 20, left));
    top = Math.max(2, Math.min(vh - 20, top));
    for (var tries = 0; tries < 4; tries += 1) {
      var clash = false;
      for (var o = 0; o < placed.length; o += 1) {
        if (Math.abs(placed[o].left - left) < 19 && Math.abs(placed[o].top - top) < 17) clash = true;
      }
      if (!clash) break;
      left = Math.max(2, Math.min(vw - 20, left + (rtl ? -20 : 20)));
    }
    placed.push({ left: left, top: top });
    var badge = document.createElement('span');
    badge.setAttribute('data-guide-mark', '');
    badge.setAttribute('style', badgeStyle + 'position:fixed;z-index:2147483001;margin:0;left:' + left + 'px;top:' + top + 'px;');
    badge.textContent = String(z + 1);
    document.body.appendChild(badge);
    var mark = { n: z + 1, label: item.label, kind: item.kind };
    if (item.required) mark.required = true;
    marks.push(mark);
  }
  return marks;
})`;

/**
 * Number the parts of the top bar. Nothing is inserted into the bar — it
 * measures itself, and a badge inside it would be one more thing to fit — so
 * each part gets a frame and a number laid over the page instead.
 */
const MARK_TOP_BAR = String.raw`(function (badgeStyle) {
  var marks = [];
  var n = 0;
  function tidy(text) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  }
  function point(el, label, kind) {
    if (!el || !label) return;
    var rect = el.getBoundingClientRect();
    if (rect.width < 3 || rect.height < 3) return;
    n += 1;
    var frame = document.createElement('div');
    frame.setAttribute('data-guide-mark', '');
    frame.setAttribute('style', 'position:fixed;box-sizing:border-box;pointer-events:none;z-index:2147483000;border:2px solid #e11d48;border-radius:7px;' +
      'left:' + (rect.left - 3) + 'px;top:' + (rect.top - 3) + 'px;width:' + (rect.width + 6) + 'px;height:' + (rect.height + 6) + 'px;');
    document.body.appendChild(frame);
    var badge = document.createElement('span');
    badge.setAttribute('data-guide-mark', '');
    badge.setAttribute('style', badgeStyle + 'position:fixed;z-index:2147483001;margin:0;left:' + (rect.left + rect.width / 2 - 9) + 'px;top:' + (rect.bottom - 5) + 'px;');
    badge.textContent = String(n);
    document.body.appendChild(badge);
    marks.push({ n: n, label: tidy(label), kind: kind });
  }
  function named(el) {
    return el ? el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent : '';
  }
  var nav = document.querySelector('.erp-nav');
  point(document.querySelector('.erp-nav__list'), named(nav), 'button');
  var branch = document.querySelector('.erp-header__utilities .erp-branch');
  point(branch, branch ? String(branch.getAttribute('title') || '').split(':')[0] : '', branch && branch.querySelector('select') ? 'choice' : 'text');
  var search = document.querySelector('.erp-header__utilities .erp-search-trigger');
  point(search, search ? search.getAttribute('aria-label') : '', 'button');
  var bell = document.querySelector('.erp-header__utilities [aria-controls="erp-notifications-panel"]');
  point(bell, named(bell), 'button');
  var mail = document.querySelector('.erp-header__utilities [aria-controls="erp-messages-panel"]');
  point(mail, named(mail), 'button');
  var locale = document.querySelector('.erp-header__utilities .erp-locale-toggle');
  point(locale, named(locale), 'button');
  var user = document.querySelector('.erp-header__utilities .erp-user-trigger');
  point(user, user ? user.getAttribute('aria-label') : '', 'button');
  return marks;
})`;

/** Number each entry of the menu behind the avatar. */
const MARK_USER_MENU = String.raw`(function (badgeStyle) {
  var marks = [];
  var items = document.querySelectorAll('#erp-user-panel .erp-user-panel__item');
  for (var i = 0; i < items.length; i += 1) {
    var copy = items[i].cloneNode(true);
    var drop = copy.querySelectorAll('small, svg, [data-guide-mark]');
    for (var d = 0; d < drop.length; d += 1) if (drop[d].parentNode) drop[d].parentNode.removeChild(drop[d]);
    var label = String(copy.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!label) continue;
    var badge = document.createElement('span');
    badge.setAttribute('data-guide-mark', '');
    badge.setAttribute('style', badgeStyle);
    badge.textContent = String(marks.length + 1);
    items[i].insertBefore(badge, items[i].firstChild);
    marks.push({ n: marks.length + 1, label: label, kind: 'button' });
  }
  return marks;
})`;

const UNMARK = `(function () {
  var all = document.querySelectorAll('[data-guide-mark]');
  for (var i = 0; i < all.length; i += 1) if (all[i].parentNode) all[i].parentNode.removeChild(all[i]);
})()`;

/** How far the open dialog's own scrolling area runs past what is shown. */
const DIALOG_OVERFLOW = `(function () {
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

/** `gridAsOne`: on a page (not a dialog) a grid of lines takes one number, not one per column. */
const markForm = (page: Page, root: string, gridAsOne = false) =>
  page.evaluate(`${MARK_FORM}(${JSON.stringify(root)}, ${MAX_MARKS}, ${JSON.stringify(BADGE_STYLE)}, ${gridAsOne})`) as Promise<Mark[]>;
const markPage = (page: Page) => page.evaluate(`${MARK_PAGE}(${MAX_PAGE_MARKS}, ${JSON.stringify(BADGE_STYLE)})`) as Promise<Mark[]>;
const unmark = (page: Page) => page.evaluate(UNMARK).catch(() => {});

/**
 * Wait until the page is the page a person sees.
 *
 * The server's HTML arrives with the heading already in it, and a picture
 * taken then shows the top bar before it has measured itself — the modules as
 * icons, the company's name missing. `erp-shell.tsx` › `fitNav` marks the bar
 * once it has run (`data-fit`), which is also the proof that the page is alive.
 * A page outside the shell (signing in, the password) has no bar to wait for.
 */
async function settle(page: Page, shell = true): Promise<void> {
  await page.locator('h1').first().waitFor({ timeout: 120_000 });
  if (shell) await page.locator('.erp-nav[data-fit]').first().waitFor({ state: 'attached', timeout: 60_000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  await page.evaluate(() => document.fonts?.ready.then(() => undefined)).catch(() => {});
  // The development server's own badge is not part of the ERP.
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' }).catch(() => {});
  await page.waitForTimeout(350);
}

/** Sign in as the seeded administrator; `onForm` runs on the page before anything is typed. */
async function signIn(page: Page, onForm?: () => Promise<void>): Promise<void> {
  const seed = readFileSync('scripts/seed-dev.ts', 'utf8');
  const password = /const PASSWORD = '([^']+)'/.exec(seed)?.[1] ?? '';
  await page.goto(`${BASE}/sign-in`, { timeout: 180_000 });
  // By name, not by label: the labels are in whichever language the cookie chose.
  await page.locator('input[name="email"]').waitFor({ timeout: 120_000 });
  if (onForm) await onForm();
  await page.locator('input[name="email"]').fill('admin@example.com');
  await page.locator('input[name="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'), { timeout: 180_000 });
}

async function main(): Promise<void> {
  // `--only dashboard` is the home page: its route is "/", which every route contains.
  const wants = (route: string) => !ONLY || (ONLY === 'dashboard' && route === '/') || (ONLY !== '/' && route !== '/' && route.includes(ONLY));
  const screens = MODULES.flatMap((module) =>
    module.sectionKeys.flatMap((sectionKey) => {
      const section = MENU.find((candidate) => candidate.key === sectionKey);
      return (section?.items ?? [])
        .map((item) => ({ moduleKey: module.key, route: routeFor(item, sectionKey) }))
        .filter((screen) => isDelivered(screen.route) && wants(screen.route));
    }),
  );
  console.log(`${screens.length} screen(s) to picture, in two languages`);

  mkdirSync(OUT, { recursive: true });
  const index: Shot[] = existsSync(join(OUT, 'index.json')) ? (JSON.parse(readFileSync(join(OUT, 'index.json'), 'utf8')) as Shot[]) : [];
  const have = new Set(index.map((shot) => `${shot.locale}:${shot.view}:${shot.route}`));
  const keep = (shot: Shot) => {
    const key = `${shot.locale}:${shot.view}:${shot.route}`;
    const at = index.findIndex((one) => `${one.locale}:${one.view}:${one.route}` === key);
    if (at >= 0) index[at] = shot;
    else index.push(shot);
    have.add(key);
    writeFileSync(join(OUT, 'index.json'), `${JSON.stringify(index, null, 1)}\n`);
  };
  /** A view the screen turns out not to have: out of the index, and its old picture off the disk. */
  const drop = (locale: string, view: Shot['view'], route: string) => {
    const key = `${locale}:${view}:${route}`;
    const at = index.findIndex((one) => `${one.locale}:${one.view}:${one.route}` === key);
    if (at < 0) return;
    const [gone] = index.splice(at, 1);
    have.delete(key);
    if (gone) rmSync(join(OUT, gone.file), { force: true });
    writeFileSync(join(OUT, 'index.json'), `${JSON.stringify(index, null, 1)}\n`);
  };
  const done = (locale: string, view: string, route: string) => !FORCE && have.has(`${locale}:${view}:${route}`);
  const withMarks = (marks: readonly Mark[]) => (marks.length > 0 ? { marks } : {});

  const browser = await chromium.launch();
  for (const locale of ['en', 'ar'] as const) {
    mkdirSync(join(OUT, locale), { recursive: true });
    const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
    await context.addCookies([{ name: 'erp-locale', value: locale, url: BASE }]);
    const page = await context.newPage();
    const shoot = (file: string, options: { fullPage?: boolean; clip?: { x: number; y: number; width: number; height: number } } = {}) =>
      page.screenshot({ path: join(OUT, locale, file), type: 'jpeg', quality: 62, ...options });
    /** One of the pictures that is not a screen of the menu; a failure costs that picture only. */
    const extra = async (route: string, view: Shot['view'], take: () => Promise<void>) => {
      if (!wants(route) || done(locale, view, route)) return;
      try {
        await take();
        console.log(`${locale} ${route} (${view})`);
      } catch (error) {
        console.log(`${locale} ${route}: skipped — ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
      }
    };

    // ── signing in: the page as somebody who is not signed in yet meets it ──
    await signIn(page, () =>
      extra('/sign-in', 'form', async () => {
        await settle(page, false);
        const marks = await markForm(page, 'main');
        await page.waitForTimeout(150);
        await shoot('sign_in-form.jpg');
        keep({ route: '/sign-in', locale, view: 'form', file: `${locale}/sign_in-form.jpg`, ...withMarks(marks) });
        await unmark(page);
      }),
    );
    const moduleName = labels(locale);

    // ── menu: each module's dropdown, with one entry ringed at a time ──
    await page.goto(`${BASE}/`, { timeout: 180_000 });
    await settle(page);
    for (const module of MODULES) {
      const mine = screens.filter((screen) => screen.moduleKey === module.key && !done(locale, 'menu', screen.route));
      if (mine.length === 0) continue;
      const trigger = page.locator(`button.erp-nav__trigger[title="${moduleName[module.key] ?? module.key}"]`).first();
      if ((await trigger.count()) === 0) continue;
      await trigger.click();
      const popover = page.locator('.erp-module-popover').first();
      await popover.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
      for (const screen of mine) {
        const link = popover.locator(`a[href="${screen.route}"]`).first();
        if ((await link.count()) === 0) continue;
        await link.evaluate((element, ring) => {
          (element as HTMLElement).dataset.was = (element as HTMLElement).getAttribute('style') ?? '';
          (element as HTMLElement).setAttribute('style', `${(element as HTMLElement).dataset.was};${ring}`);
          element.scrollIntoView({ block: 'nearest' });
        }, RING);
        const box = await popover.boundingBox();
        const file = `${slugOf(screen.route)}-menu.jpg`;
        await shoot(file, { clip: { x: 0, y: 0, width: WIDTH, height: Math.min(HEIGHT, Math.ceil((box ? box.y + box.height : HEIGHT) + 14)) } });
        await link.evaluate((element) => (element as HTMLElement).setAttribute('style', (element as HTMLElement).dataset.was ?? ''));
        keep({ route: screen.route, locale, view: 'menu', file: `${locale}/${file}` });
      }
      await page.keyboard.press('Escape');
      await popover.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
      console.log(`${locale} menu  ${module.key}: ${mine.length}`);
    }

    // ── the top bar: what each part of it is ──
    await extra('top-bar', 'screen', async () => {
      await page.goto(`${BASE}/`, { timeout: 180_000 });
      await settle(page);
      const marks = (await page.evaluate(`${MARK_TOP_BAR}(${JSON.stringify(BADGE_STYLE)})`)) as Mark[];
      await page.waitForTimeout(150);
      await shoot('top_bar-screen.jpg');
      keep({ route: 'top-bar', locale, view: 'screen', file: `${locale}/top_bar-screen.jpg`, ...withMarks(marks) });
      await unmark(page);
    });

    // ── the menu behind the avatar ──
    await extra('user-menu', 'menu', async () => {
      await page.goto(`${BASE}/`, { timeout: 180_000 });
      await settle(page);
      await page.locator('.erp-header__utilities .erp-user-trigger').first().click();
      const panel = page.locator('#erp-user-panel');
      await panel.waitFor({ state: 'visible', timeout: 15_000 });
      const marks = (await page.evaluate(`${MARK_USER_MENU}(${JSON.stringify(BADGE_STYLE)})`)) as Mark[];
      await page.waitForTimeout(150);
      const box = await panel.boundingBox();
      await shoot('user_menu-menu.jpg', { clip: { x: 0, y: 0, width: WIDTH, height: Math.min(HEIGHT, Math.ceil((box ? box.y + box.height : HEIGHT) + 14)) } });
      keep({ route: 'user-menu', locale, view: 'menu', file: `${locale}/user_menu-menu.jpg`, ...withMarks(marks) });
      await unmark(page);
      await page.keyboard.press('Escape');
    });

    // ── changing the password: its own page, outside the menu ──
    await extra('/password', 'form', async () => {
      await page.goto(`${BASE}/password`, { timeout: 180_000 });
      await page.locator('input[name="currentPassword"]').waitFor({ timeout: 120_000 });
      await settle(page, false);
      const marks = await markForm(page, 'main');
      await page.waitForTimeout(150);
      await shoot('password-form.jpg');
      keep({ route: '/password', locale, view: 'form', file: `${locale}/password-form.jpg`, ...withMarks(marks) });
      await unmark(page);
    });

    // ── screen and form ──
    for (const screen of screens) {
      if (done(locale, 'screen', screen.route)) continue;
      try {
        await page.goto(`${BASE}${screen.route}`, { timeout: 180_000 });
        await settle(page);

        // The way in to a new record: a link to its own page, or the button that opens its dialog.
        const link = page.locator('main a[href$="/new"]').first();
        // Not a door: the printer, paperclip, notes and clock open dialogs too, and none of them is a new record.
        const button = page.locator('main button:has(+ dialog):not([class*="sapIconButton"])').first();
        const opener = (await link.count()) > 0 ? link : (await button.count()) > 0 ? button : null;
        // A "+ New …" button that does its work at once (it raises the draft and
        // opens it) is ringed but never pressed: this script saves nothing.
        const plus = page.locator('main header [class*="headerActions"] :is(a, button)[class*="primary"]:has(svg)').first();
        const ringed = opener ?? ((await plus.count()) > 0 ? plus : null);
        if (ringed) {
          await ringed.evaluate((element, ring) => {
            (element as HTMLElement).dataset.was = (element as HTMLElement).getAttribute('style') ?? '';
            (element as HTMLElement).setAttribute('style', `${(element as HTMLElement).dataset.was};${ring}`);
          }, RING);
        }
        const file = `${slugOf(screen.route)}-screen.jpg`;
        const marks = await markPage(page);
        await page.waitForTimeout(120);
        await shoot(file);
        keep({ route: screen.route, locale, view: 'screen', file: `${locale}/${file}`, ...(ringed ? { ringed: true } : {}), ...withMarks(marks) });
        await unmark(page);
        if (ringed) await ringed.evaluate((element) => (element as HTMLElement).setAttribute('style', (element as HTMLElement).dataset.was ?? ''));
        // A row of the list that opens a record of this screen, if the sample data has one.
        const recordHref = done(locale, 'record', screen.route) || screen.route === '/' ? null : await page.evaluate(`(function (route) {
          var links = document.querySelectorAll('main table tbody tr a[href]');
          for (var i = 0; i < links.length; i += 1) {
            var href = links[i].getAttribute('href') || '';
            if (href.indexOf(route + '/') === 0 && !/\\/new(\\?|$)/.test(href)) return href;
          }
          return null;
        })(${JSON.stringify(screen.route)})`) as string | null;

        /*
         * A form is a picture of fields to fill. A page that opens with only a
         * reason it cannot start yet ("Post a sales invoice first") has none,
         * and is not kept as one: sent as "the form", it would explain nothing.
         */
        let formed = false;
        if (!opener) drop(locale, 'form', screen.route);
        if (opener && !done(locale, 'form', screen.route)) {
          const formFile = `${slugOf(screen.route)}-form.jpg`;
          if (opener === link) {
            const href = await link.getAttribute('href');
            await page.goto(`${BASE}${href}`, { timeout: 180_000 });
            await settle(page);
            const marks = await markForm(page, 'main', true);
            if (marks.length > 0) {
              await page.waitForTimeout(150);
              await shoot(formFile, { fullPage: true });
              keep({ route: screen.route, locale, view: 'form', file: `${locale}/${formFile}`, marks });
              formed = true;
            } else {
              drop(locale, 'form', screen.route);
            }
            await unmark(page);
          } else {
            await opener.click();
            const dialog = page.locator('dialog[open]').first();
            if (await dialog.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false)) {
              await page.waitForTimeout(250);
              const marks = await markForm(page, 'dialog[open]');
              if (marks.length > 0) {
                // A long form scrolls inside its dialog: the window is made taller
                // for the picture, so every numbered field is in it.
                const over = Number(await page.evaluate(DIALOG_OVERFLOW).catch(() => 0)) || 0;
                if (over > 4) await page.setViewportSize({ width: WIDTH, height: Math.min(2400, HEIGHT + Math.ceil(over) + 40) });
                await page.waitForTimeout(200);
                await shoot(formFile);
                keep({ route: screen.route, locale, view: 'form', file: `${locale}/${formFile}`, marks });
                formed = true;
                if (over > 4) await page.setViewportSize({ width: WIDTH, height: HEIGHT });
              } else {
                drop(locale, 'form', screen.route);
              }
              await unmark(page);
              await page.keyboard.press('Escape');
            } else {
              drop(locale, 'form', screen.route);
            }
          }
        }
        // ── one record of the list, opened ──
        let recorded = false;
        if (recordHref) {
          await page.goto(`${BASE}${recordHref}`, { timeout: 180_000 });
          await settle(page);
          const marks = await markPage(page);
          await page.waitForTimeout(120);
          const recordFile = `${slugOf(screen.route)}-record.jpg`;
          await shoot(recordFile);
          keep({ route: screen.route, locale, view: 'record', file: `${locale}/${recordFile}`, ...withMarks(marks) });
          await unmark(page);
          recorded = true;
        } else if (!done(locale, 'record', screen.route)) {
          drop(locale, 'record', screen.route);
        }
        console.log(`${locale} ${screen.route}${formed ? ' (+form)' : ringed ? ' (ringed)' : ''}${recorded ? ' (+record)' : ''}`);
      } catch (error) {
        await page.setViewportSize({ width: WIDTH, height: HEIGHT }).catch(() => {});
        console.log(`${locale} ${screen.route}: skipped — ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
      }
    }
    await context.close();
  }
  await browser.close();
  console.log(`${index.length} picture(s) in ${OUT}`);
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/guide/make-screens.ts')) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
