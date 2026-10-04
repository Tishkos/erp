/**
 * The pointing — what is drawn on a picture of a screen so that a step can say
 * "look at 3" and be right.
 *
 * By direction (2026-10-05): "provide points with square, arrows — much better
 * visualisation; steps; helps explanation". The numbered dots of the day
 * before told a person which thing was meant only once they had found the
 * dot. So:
 *
 *   a BOX       a thin red rectangle round each numbered control itself — the
 *               input, the dropdown, the button, the row of tabs, a table's
 *               heading, a status — with its number in a small square tag on
 *               the box's top-start corner;
 *   an ARROW    for the things the answer is about (`pointAt`, or whatever the
 *               caller tagged `data-guide-point`): a thick box, and a filled
 *               arrow from outside pointing at it, its number in a larger tag
 *               at the arrow's tail.
 *
 * One piece of code draws both kinds of picture — the ones made ahead of time
 * from the training copy (`scripts/guide/make-screens.ts`) and the ones taken
 * of the live system when somebody asks (`services/live-screenshot.ts`) — so a
 * person never has to learn two ways of being pointed at.
 *
 * It runs in the page, and is handed over as TEXT on purpose: a function given
 * to `page.evaluate` is compiled by tsx first, which wraps every inner
 * function in a helper (`__name`) the page has never heard of. So the script
 * below is plain ES5 — no arrow functions, no block-scoped declarations —
 * and `tests/unit/wa15-markers.test.ts` holds it to that, so that no build
 * step ever has a reason to rewrite it.
 *
 * Nothing is put INTO the page's own layout: every box, tag and arrow is laid
 * over it (inside the open `<dialog>` for what is in one — a dialog sits in
 * the browser's top layer, above anything laid over the page — and on the body
 * otherwise), so the layout the picture shows is the layout there is, and the
 * top bar never has one more thing to fit.
 */

/** One numbered pointer in a picture: what the number is on. */
export interface Mark {
  readonly n: number;
  /** The thing's name, as the picture shows it. */
  readonly label: string;
  /** text | choice | date | tick | file | area | button | tabs | search | filter | table | paging | section | status | door | link */
  readonly kind: string;
  readonly required?: boolean;
  /** A dropdown's choices, as the screen lists them (at most twelve, then how many more). */
  readonly options?: readonly string[];
  /** The hint the form writes under the field (or its placeholder, when that says something). */
  readonly hint?: string;
  /** Live pictures only: what the field holds now. Never a password, a code or a token. */
  readonly value?: string;
  /** Drawn with a thick box and an arrow: one of the things the answer is about. */
  readonly pointed?: boolean;
}

export interface MarkOptions {
  /**
   * What is being pictured.
   *   form        the fields of a form (the open dialog, else the page), its saving button last
   *   dialog      a dialog that is opened from a screen or a record: its fields, and every link and button in it
   *   screen      a list or settings screen: back, header buttons, tabs, search, filters, tables, paging, sections, fields
   *   record      one record opened: the same, with its status, the doors of its title bar and its actions
   *   top-bar     the parts of the bar every screen sits under
   *   user-menu   the entries of the menu behind the avatar
   */
  readonly scope: 'form' | 'dialog' | 'screen' | 'record' | 'top-bar' | 'user-menu';
  /** `form` / `dialog`: the CSS selector of what to number. The open dialog, else `main`, when left out. */
  readonly root?: string;
  /** What to point at with an arrow: labels (case-insensitive, "contains") or numbers as strings. */
  readonly pointAt?: readonly string[];
  /** Live pictures: each field's mark also carries what it holds now. */
  readonly withValues?: boolean;
  /** No picture carries more numbers than a person can follow. 30 for a form, 24 for a page. */
  readonly max?: number;
  /** `form`: a grid of lines takes one number, not one per column. On for a page, off for a dialog, when left out. */
  readonly gridAsOne?: boolean;
  /** A picture of the whole page: what is below the first screenful is numbered too. */
  readonly fullPage?: boolean;
}

export interface MarkResult {
  readonly marks: Mark[];
  /** The `pointAt` entries that matched nothing in the picture. */
  readonly notFound: string[];
}

/**
 * The script. Evaluate it once in a page; it defines
 *
 *   window.__erpMark(options)   draws, and returns { marks, notFound }
 *   window.__erpUnmark()        takes everything it drew away again
 */
export const MARKERS_JS = String.raw`(function () {
  if (window.__erpMark) return;
  var ATTR = 'data-guide-mark';
  var RED = '#e11d48';
  var NS = 'http://www.w3.org/2000/svg';
  /* What is never read out of a field: by its type, its name, or what it is called. */
  var SECRET = /pass|secret|token|otp|code|رمز|كلمة المرور|سري/i;

  function classOf(el) {
    var raw = el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className;
    return String(raw || '');
  }
  function has(el, name) {
    var list = classOf(el).split(/\s+/);
    for (var i = 0; i < list.length; i += 1) {
      if (list[i] === name || list[i].slice(-(name.length + 2)) === '__' + name) return true;
    }
    return false;
  }
  function tidy(text, max) {
    return String(text || '').replace(/\*/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 80);
  }
  function drawn(el) {
    if (!el || !el.getClientRects().length) return false;
    var rect = el.getBoundingClientRect();
    if (rect.width < 3 || rect.height < 3) return false;
    var style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }
  function captionOf(el, max) {
    var copy = el.cloneNode(true);
    var drop = copy.querySelectorAll('[aria-hidden="true"], [' + ATTR + '], input, select, textarea, button, small, svg, [class*="hint"], [class*="sapTitleActions"], [class*="sapTitleMeta"], [class*="sapGridCount"]');
    for (var i = 0; i < drop.length; i += 1) if (drop[i].parentNode) drop[i].parentNode.removeChild(drop[i]);
    return tidy(copy.textContent, max);
  }
  function nameOf(el) {
    return tidy(captionOf(el) || el.getAttribute('title') || el.getAttribute('aria-label'));
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
  function headRowOf(table) {
    return table && table.tHead && table.tHead.rows.length ? table.tHead.rows[table.tHead.rows.length - 1] : null;
  }

  /* ---- what the screen itself says about a field: a dropdown's choices, the hint under it ---- */
  /* A first option that only says "choose one" is not a choice. */
  function onlyAsks(option, index) {
    if (index !== 0 || option.value !== '') return false;
    var text = String(option.label || option.textContent || '').replace(/\s+/g, ' ').trim();
    return !text || option.disabled || /^[-—–.…\s]*$/.test(text) || /^(select|choose|pick|please)\b/i.test(text) || /^(اختر|إختر|يرجى)/.test(text);
  }
  function optionsOf(field) {
    var list = null;
    if (field.tagName === 'SELECT') list = field.options;
    else if (field.getAttribute('list')) {
      var data = document.getElementById(field.getAttribute('list'));
      list = data ? data.options : null;
    }
    if (!list || !list.length) return null;
    var out = [];
    var total = 0;
    for (var i = 0; i < list.length; i += 1) {
      var option = list[i];
      var text = String(option.label || option.textContent || option.value || '').replace(/\s+/g, ' ').trim();
      if (onlyAsks(option, i)) continue;
      if (!text) continue;
      total += 1;
      if (out.length < 12) out.push(text.slice(0, 60));
    }
    if (!out.length) return null;
    if (total > 12) out.push('… (' + (total - 12) + ' more)');
    return out;
  }
  function hintOf(field, label, caption) {
    var text = '';
    var ids = String(field.getAttribute('aria-describedby') || '').split(/\s+/);
    for (var i = 0; i < ids.length && !text; i += 1) {
      var told = ids[i] ? document.getElementById(ids[i]) : null;
      if (told) text = told.textContent;
    }
    if (!text) {
      /* The field's own wrapper: its label, its box, and the small words under it. */
      var holder = label && !label.contains(field) ? label.parentNode : field.parentNode;
      if (holder && holder.contains(field) && holder.querySelectorAll('input:not([type="hidden"]), select, textarea').length === 1) {
        var hints = holder.querySelectorAll('[class*="hint"], small');
        for (var h = 0; h < hints.length && !text; h += 1) {
          if (hints[h].hasAttribute(ATTR)) continue;
          if (label && !label.contains(field) && label.contains(hints[h])) continue;
          text = hints[h].textContent;
        }
      }
    }
    text = String(text || '').replace(/\s+/g, ' ').trim();
    if (!text) {
      var shown = String(field.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim();
      if (shown.length > 2 && shown.toLowerCase() !== String(caption || '').toLowerCase()) text = shown;
    }
    return text ? text.slice(0, 160) : null;
  }

  /* ---- what a field holds now (live pictures) — never a secret ---- */
  function secretField(field, caption) {
    if (String(field.getAttribute('type') || '').toLowerCase() === 'password') return true;
    var said = [field.getAttribute('name'), field.id, field.getAttribute('autocomplete'), field.getAttribute('aria-label'), caption].join(' ');
    return SECRET.test(said);
  }
  function valueOf(field, caption) {
    if (secretField(field, caption)) return null;
    var type = String(field.getAttribute('type') || '').toLowerCase();
    var text = '';
    if (field.tagName === 'SELECT') {
      var chosen = field.selectedIndex >= 0 ? field.options[field.selectedIndex] : null;
      text = chosen && !onlyAsks(chosen, field.selectedIndex) ? chosen.label || chosen.textContent : '';
    } else if (type === 'checkbox' || type === 'radio') {
      text = field.checked ? 'ticked' : 'not ticked';
    } else if (type === 'file') {
      return null;
    } else {
      text = field.value;
    }
    text = tidy(text, 80);
    return text || null;
  }
  /* A document's block of labelled boxes: "Supplier Name: Al-Rafidain; Posting Date: …". */
  function blockValue(block) {
    var pairs = [];
    var boxes = block.querySelectorAll('[class*="sapField"]');
    for (var i = 0; i < boxes.length; i += 1) {
      var over = boxes[i].querySelector('[class*="sapLabel"]');
      var held = boxes[i].querySelector('[class*="sapBox"]');
      if (!over || !held) continue;
      var caption = captionOf(over);
      var text = tidy(held.textContent, 60);
      if (!caption || !text || SECRET.test(caption)) continue;
      pairs.push(caption + ': ' + text);
    }
    return pairs.length ? pairs.join('; ').slice(0, 240) : null;
  }

  /* ================================================================
   * What there is to number. Each collector hands back items:
   *   { el, label, kind, required?, field?, fieldLabel?, tagOnly?, place?, value? }
   * "el" is what the box goes round; a "tagOnly" item gets a number and no box.
   * ================================================================ */

  /* A form: its fields in the order they are met, its saving button last. */
  function collectForm(root, cap, gridAsOne, everything) {
    var items = [];
    var forms = [];
    var seen = [];
    function push(el, label, kind, field, fieldLabel, required) {
      var item = { el: el, label: label, kind: kind };
      if (required) item.required = true;
      if (field) {
        item.field = field;
        item.fieldLabel = fieldLabel || null;
      }
      items.push(item);
      return item;
    }
    /* A grid of lines on a page: one number for the whole grid, its columns named. */
    function gridItem(table) {
      if (!table || seen.indexOf(table) >= 0) return;
      seen.push(table);
      var headRow = headRowOf(table);
      if (!headRow || !drawn(headRow) || !headRow.cells.length || items.length >= cap - 1) return;
      var names = [];
      for (var h = 0; h < headRow.cells.length; h += 1) {
        var name = captionOf(headRow.cells[h]);
        if (name) names.push(name);
      }
      if (!names.length) return;
      /* The bar that names the grid ("Lines"), where there is one. */
      var bar = null;
      var at = table;
      for (var up = 0; up < 3 && at && at !== root && !bar; up += 1) {
        var before = at.previousElementSibling;
        if (before && drawn(before) && (/^H[2-4]$/.test(before.tagName) || /sapGridCaption|sapTitle|panelTitle/.test(classOf(before)))) bar = before;
        at = at.parentNode;
      }
      var title = bar ? captionOf(bar).replace(/[▾▸]/g, '').replace(/\s*\d+$/, '').trim() : '';
      var item = push(headRow, tidy((title ? title + ': ' : '') + names.join(' · '), 160), 'table');
      item.table = table;
    }
    function noteField(el, caption, field, label) {
      var required = field.required || field.getAttribute('aria-required') === 'true' || (label && label.querySelector('[class*="required"]'));
      push(el, caption, kindOf(field), field, label, !!required);
      if (field.form && forms.indexOf(field.form) < 0) forms.push(field.form);
    }

    var fields = root.querySelectorAll(gridAsOne ? 'input, select, textarea, table' : 'input, select, textarea');
    for (var i = 0; i < fields.length && items.length < cap - 1; i += 1) {
      var field = fields[i];
      if (field.tagName === 'TABLE') {
        if (drawn(field)) gridItem(field);
        continue;
      }
      var type = (field.getAttribute('type') || '').toLowerCase();
      if (type === 'hidden' || type === 'submit' || type === 'button' || type === 'reset' || type === 'image') continue;
      if (field.disabled || !drawn(field)) continue;

      var label = (field.labels && field.labels[0]) || field.closest('label');
      if (!label) {
        /* A document's own boxes: the caption is the span over the box, not a <label>. */
        var holder = field.closest('[class*="sapField"], [class*="sapFilterField"]');
        var over = holder ? holder.querySelector('[class*="sapLabel"]') : null;
        if (over && !over.contains(field)) label = over;
      }
      var cell = field.closest('td');
      if (gridAsOne && cell) {
        /* The grid already has its number; its form is still the form that saves. */
        if (field.form && forms.indexOf(field.form) < 0) forms.push(field.form);
        continue;
      }
      if (label && drawn(label)) {
        if (seen.indexOf(label) >= 0) continue;
        var caption = captionOf(label);
        if (!caption) continue;
        seen.push(label);
        /* A tick and its words are one thing; anything else is the box that is typed in. */
        noteField(kindOf(field) === 'tick' && label.contains(field) ? label : field, caption, field, label);
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
            if (span === at) {
              head = headRow.cells[h];
              break;
            }
            span += headRow.cells[h].colSpan || 1;
          }
        }
        if (!head || !drawn(head) || seen.indexOf(head) >= 0) continue;
        var heading = captionOf(head);
        if (!heading) continue;
        seen.push(head);
        noteField(head, heading, field, null);
        continue;
      }
      var named = tidy(field.getAttribute('aria-label') || field.getAttribute('placeholder'));
      if (!named) continue;
      noteField(field, named, field, null);
    }

    if (everything) {
      /* Nothing to fill and no table: a dialog that is only read. Its headed block is the thing to point at. */
      if (!items.length) {
        var blocks = root.querySelectorAll('h2, h3, h4, figcaption, [class*="sapTitle"], [class*="panelTitle"]');
        var took = [];
        for (var g = 0; g < blocks.length && items.length < 3; g += 1) {
          if (!drawn(blocks[g]) || blocks[g].closest('[class*="dialogHeader"]')) continue;
          var inside = false;
          for (var k = 0; k < took.length; k += 1) if (took[k].contains(blocks[g]) || blocks[g].contains(took[k])) inside = true;
          if (inside) continue;
          var words = captionOf(blocks[g]);
          if (!words) continue;
          took.push(blocks[g]);
          push(blocks[g], words, 'section').tagOnly = true;
        }
      }
      /* Every link and button, in the order they are read; the cross that closes it, last. */
      var close = null;
      var pressable = root.querySelectorAll('a[href], button, input[type="submit"]');
      for (var e = 0; e < pressable.length && items.length < cap - 1; e += 1) {
        var item = pressable[e];
        if (item.hasAttribute(ATTR) || item.disabled || !drawn(item) || item.closest('table')) continue;
        if (/dialogClose/.test(classOf(item))) {
          close = item;
          continue;
        }
        var said = tidy(item.tagName === 'INPUT' ? item.value : captionOf(item) || item.getAttribute('title') || item.getAttribute('aria-label'));
        if (!said) continue;
        /* A copy to print is named by its language as well as its format. */
        var spoken = item.getAttribute('data-lang') ? item.closest('[lang]') : null;
        var tongue = spoken && spoken.firstElementChild && !spoken.firstElementChild.contains(item) ? tidy(spoken.firstElementChild.textContent) : '';
        /* A copy to download is pressed like a button; only a link that goes somewhere is a link. */
        var goes = item.tagName === 'A' && !item.hasAttribute('download') && !item.getAttribute('data-format');
        push(item, tidy((tongue ? tongue + ' ' : '') + said), goes ? 'link' : 'button');
      }
      if (close && drawn(close) && items.length < cap) push(close, tidy(close.getAttribute('aria-label') || close.getAttribute('title') || 'Close'), 'button');
      return items;
    }

    /* The button that saves: the last of the form's own, outside any grid. */
    var buttons = root.querySelectorAll('button, input[type="submit"]');
    var saving = [];
    for (var b = 0; b < buttons.length; b += 1) {
      var button = buttons[b];
      if ((button.type || '').toLowerCase() !== 'submit' || button.disabled || !drawn(button)) continue;
      if (!button.form || forms.indexOf(button.form) < 0 || button.closest('table')) continue;
      saving.push(button);
    }
    saving = saving.slice(-2);
    for (var s = 0; s < saving.length && items.length < cap; s += 1) {
      var text = tidy(saving[s].tagName === 'INPUT' ? saving[s].value : captionOf(saving[s]));
      if (text) push(saving[s], text, 'button');
    }
    return items;
  }

  /* A screen or a record: everything it is made of, in reading order. */
  function collectPage(cap, fullPage) {
    var main = document.querySelector('main') || document.body;
    var rtl = getComputedStyle(document.documentElement).direction === 'rtl';
    var vh = window.innerHeight;
    var vw = window.innerWidth;
    var found = [];
    var taken = [];
    var usedHeadings = [];
    var claimed = [];

    function withClass(selector, name) {
      var out = [];
      var nodes = main.querySelectorAll(selector);
      for (var i = 0; i < nodes.length; i += 1) if (has(nodes[i], name)) out.push(nodes[i]);
      return out;
    }
    function shown(el) {
      if (!drawn(el) || el.closest('dialog')) return false;
      var rect = el.getBoundingClientRect();
      if (rect.left > vw - 4 || rect.right < 4) return false;
      /* Only what the picture shows is numbered — unless the picture is of the whole page. */
      return fullPage || !(rect.top > vh - 14 || rect.bottom < 2);
    }
    function add(el, label, kind, more) {
      if (!el || !label || taken.indexOf(el) >= 0 || !shown(el)) return null;
      taken.push(el);
      var item = { el: el, rect: el.getBoundingClientRect(), label: label, kind: kind };
      if (more) for (var key in more) if (Object.prototype.hasOwnProperty.call(more, key) && more[key]) item[key] = more[key];
      found.push(item);
      return item;
    }
    /* A field's name, and its <label> where it has one. */
    function labelOf(field) {
      var label = (field.labels && field.labels[0]) || field.closest('label');
      if (!label) {
        var holder = field.closest('[class*="sapField"], [class*="sapFilterField"]');
        var over = holder ? holder.querySelector('[class*="sapLabel"]') : null;
        if (over && !over.contains(field)) label = over;
      }
      if (label && label.getClientRects().length) {
        var text = captionOf(label);
        if (text) return { text: text, label: label };
      }
      var named = tidy(field.getAttribute('aria-label') || field.getAttribute('placeholder'));
      return named ? { text: named, label: null } : null;
    }
    /* What the box goes round: a tick with its words, else the control itself. */
    function boxOf(field, named) {
      return kindOf(field) === 'tick' && named.label && named.label.contains(field) ? named.label : field;
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
    /* The heading a table sits under: the last one before it inside its own window. */
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

    /* The way back, and the buttons beside the page's title. */
    var back = withClass('a', 'backButton');
    if (back.length) {
      claimed.push(back[0]);
      add(back[0], nameOf(back[0]), 'link');
    }
    var actions = main.querySelectorAll('header [class*="headerActions"] a, header [class*="headerActions"] button');
    for (var a = 0; a < actions.length; a += 1) {
      claimed.push(actions[a]);
      add(actions[a], nameOf(actions[a]), 'button');
    }

    /* The row of tabs is one thing to point at. */
    var bars = withClass('nav', 'tabsBar');
    for (var t = 0; t < bars.length; t += 1) {
      var names = [];
      var tabs = bars[t].querySelectorAll('a, button, span[aria-current]');
      for (var k = 0; k < tabs.length; k += 1) {
        var tab = tidy(tabs[k].textContent);
        if (tab && names.indexOf(tab) < 0) names.push(tab);
      }
      add(bars[t], tidy(names.join(' · '), 120), 'tabs');
    }

    /* Search, then the filters. */
    var searches = main.querySelectorAll('form[role="search"]');
    for (var s = 0; s < searches.length; s += 1) {
      var box = searches[s].querySelector('input');
      var inner = searches[s].querySelectorAll('input, button');
      for (var c = 0; c < inner.length; c += 1) claimed.push(inner[c]);
      add(searches[s], tidy(box ? box.getAttribute('aria-label') || box.getAttribute('placeholder') : ''), 'search', { field: box });
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
        if (named) add(boxOf(controls[q], named), named.text, 'filter', { field: controls[q], fieldLabel: named.label });
      }
      var go = filterForms[g].querySelectorAll('button, a');
      for (var w = 0; w < go.length; w += 1) {
        claimed.push(go[w]);
        add(go[w], nameOf(go[w]), 'button');
      }
    }

    /* Each table is one thing: its heading where it has one, and its columns. */
    var tables = main.querySelectorAll('table');
    for (var x = 0; x < tables.length; x += 1) {
      var table = tables[x];
      var headRow = headRowOf(table);
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
      var whole = !(headRow && headRow.getClientRects().length);
      if (add(whole ? table : headRow, label, 'table', { table: table, tagOnly: whole }) && heading) usedHeadings.push(heading);
    }

    var pagers = withClass('nav', 'pagination');
    for (var p = 0; p < pagers.length; p += 1) add(pagers[p], tidy(pagers[p].getAttribute('aria-label')), 'paging');

    /* A record: its status, the doors in its title bar, the buttons of its actions row. */
    var statuses = main.querySelectorAll('[data-status], [class*="profileCard"] > [class*="pill"]');
    var said = 0;
    for (var u = 0; u < statuses.length && said < 3; u += 1) {
      if (statuses[u].closest('table')) continue;
      /* In a document's header the box has a caption over it: "Status: Posted". */
      var boxed = statuses[u].closest('[class*="sapField"]');
      var over = boxed ? boxed.querySelector('[class*="sapLabel"]') : null;
      var state = tidy((over ? captionOf(over) + ': ' : '') + tidy(statuses[u].textContent));
      if (add(statuses[u], state, 'status', { value: tidy(statuses[u].textContent) })) said += 1;
    }
    /* The block of labelled boxes at the head of a document is one thing: what it records. */
    var blocks = withClass('div', 'sapFields');
    for (var v = 0; v < blocks.length; v += 1) {
      var captions = [];
      var boxes = blocks[v].querySelectorAll('[class*="sapLabel"]');
      for (var y = 0; y < boxes.length; y += 1) {
        var word = captionOf(boxes[y]);
        if (word && captions.indexOf(word) < 0) captions.push(word);
      }
      add(blocks[v], tidy(captions.join(' · '), 160), 'section', { tagOnly: true, block: blocks[v] });
    }
    /* An icon in a title bar is a door (printer, paperclip, notes, clock); words there are a link. */
    var doors = main.querySelectorAll('[class*="sapTitleActions"] a, [class*="sapTitleActions"] button, [class*="sapIconButton"]');
    for (var d = 0; d < doors.length; d += 1) {
      if (claimed.indexOf(doors[d]) >= 0 || doors[d].closest('table')) continue;
      claimed.push(doors[d]);
      var icon = has(doors[d], 'sapIconButton');
      var door = tidy(String(doors[d].getAttribute('title') || doors[d].getAttribute('aria-label') || doors[d].textContent).replace(/\(\d+\)\s*$/, ''));
      add(doors[d], door, icon ? 'door' : 'link', { place: icon ? 'above' : '' });
    }
    var rows = withClass('div', 'sapFootActions');
    for (var r = 0; r < rows.length; r += 1) {
      var pressable = rows[r].querySelectorAll('a, button');
      for (var b = 0; b < pressable.length; b += 1) {
        if (claimed.indexOf(pressable[b]) >= 0) continue;
        claimed.push(pressable[b]);
        add(pressable[b], nameOf(pressable[b]), 'button');
      }
    }

    /* Headed sections that are not already a table's heading. */
    var heads = main.querySelectorAll('h2, h3, h4, figcaption, legend, [class*="sapTitle"], [class*="sapGridCaption"], [class*="panelTitle"]');
    for (var e = 0; e < heads.length; e += 1) {
      var head = heads[e];
      if (!isHeading(head) || usedHeadings.indexOf(head) >= 0 || head.closest('table')) continue;
      /* A heading inside a title bar that is itself a heading is the same heading. */
      if (head.parentNode && head.parentNode !== main && isHeading(head.parentNode)) continue;
      add(head, captionOf(head), 'section', { tagOnly: true, place: 'before' });
    }

    /* A form that is part of the page itself (a settings screen): its fields. */
    var fields = main.querySelectorAll('input, select, textarea');
    for (var i = 0; i < fields.length; i += 1) {
      var field = fields[i];
      if (!usable(field) || field.closest('table') || field.closest('dialog')) continue;
      var name = labelOf(field);
      if (!name) continue;
      if (name.label) {
        for (var j = found.length - 1; j >= 0; j -= 1) if (found[j].el === name.label && found[j].kind === 'section') found.splice(j, 1);
      }
      add(boxOf(field, name), name.text, kindOf(field), {
        required: field.required || (name.label && !!name.label.querySelector('[class*="required"]')),
        field: field,
        fieldLabel: name.label,
      });
    }
    /* Every other button on the page that is not part of a table's rows. */
    var others = main.querySelectorAll('button, a');
    for (var m = 0; m < others.length; m += 1) {
      var other = others[m];
      if (claimed.indexOf(other) >= 0 || other.closest('table') || other.closest('dialog') || other.disabled) continue;
      if (other.tagName === 'A' && !(has(other, 'action') || has(other, 'button') || has(other, 'action--primary'))) continue;
      if (other.closest('nav')) continue;
      add(other, nameOf(other), 'button');
    }

    /* A caption that was taken for a heading and is also the name of the field under it is that field, once. */
    for (var sx = found.length - 1; sx >= 0; sx -= 1) {
      if (found[sx].kind !== 'section') continue;
      for (var fx = 0; fx < found.length; fx += 1) {
        if (fx === sx || !found[fx].field) continue;
        if (String(found[fx].label).toLowerCase() === String(found[sx].label).toLowerCase() && Math.abs(found[fx].rect.top - found[sx].rect.top) < 48) {
          found.splice(sx, 1);
          break;
        }
      }
    }

    /* Reading order: down the page, and along a line from its start. */
    found.sort(function (one, two) {
      if (Math.abs(one.rect.top - two.rect.top) > 14) return one.rect.top - two.rect.top;
      return rtl ? two.rect.right - one.rect.right : one.rect.left - two.rect.left;
    });
    return found.slice(0, cap);
  }

  /* The parts of the bar every screen sits under. */
  function collectTopBar() {
    var items = [];
    function point(el, label, kind) {
      if (el && label && drawn(el)) items.push({ el: el, label: tidy(label), kind: kind, place: 'below' });
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
    return items;
  }

  /* The entries of the menu behind the avatar. */
  function collectUserMenu() {
    var items = [];
    var entries = document.querySelectorAll('#erp-user-panel .erp-user-panel__item');
    for (var i = 0; i < entries.length; i += 1) {
      var copy = entries[i].cloneNode(true);
      var drop = copy.querySelectorAll('small, svg, [' + ATTR + ']');
      for (var d = 0; d < drop.length; d += 1) if (drop[d].parentNode) drop[d].parentNode.removeChild(drop[d]);
      var label = tidy(copy.textContent);
      if (label && drawn(entries[i])) items.push({ el: entries[i], label: label, kind: 'button' });
    }
    return items;
  }

  /* ================================================================
   * Drawing.
   * ================================================================ */

  /* Where an overlay must live to be seen: the open dialog for what is in one. */
  function hostFor(el) {
    var dialog = el.closest ? el.closest('dialog[open]') : null;
    return dialog || document.body;
  }
  /* Put a node at a place given in the picture's own coordinates, wherever its host measures from. */
  function put(node, host, left, top) {
    node.setAttribute(ATTR, '');
    var body = host === document.body;
    var x = body ? left + window.pageXOffset : left;
    var y = body ? top + window.pageYOffset : top;
    node.style.position = body ? 'absolute' : 'fixed';
    node.style.left = x + 'px';
    node.style.top = y + 'px';
    host.appendChild(node);
    /* A host that is itself moved or positioned measures from its own corner: put right what that got wrong. */
    var got = node.getBoundingClientRect();
    var dx = left - got.left;
    var dy = top - got.top;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
      node.style.left = x + dx + 'px';
      node.style.top = y + dy + 'px';
    }
  }
  function layer(host) {
    return host === document.body ? '2147483000' : '5';
  }
  function frame(rect, pad, strong, host) {
    var el = document.createElement('div');
    el.setAttribute(
      'style',
      'box-sizing:border-box;pointer-events:none;margin:0;padding:0;background:transparent;border-radius:6px;z-index:' + layer(host) + ';' +
        (strong ? 'border:3px solid ' + RED + ';box-shadow:0 0 0 2px rgba(225,29,72,.3);' : 'border:1.5px solid ' + RED + ';') +
        'width:' + (rect.width + pad * 2) + 'px;height:' + (rect.height + pad * 2) + 'px;'
    );
    put(el, host, rect.left - pad, rect.top - pad);
  }
  function tagWidth(n, large) {
    return (large ? 22 : 16) + (n > 9 ? (large ? 8 : 6) : 0);
  }
  function tag(n, large, host, left, top) {
    var el = document.createElement('span');
    var size = large ? 22 : 16;
    el.setAttribute(
      'style',
      'display:flex;align-items:center;justify-content:center;box-sizing:border-box;pointer-events:none;margin:0;padding:0;' +
        'width:' + tagWidth(n, large) + 'px;height:' + size + 'px;border-radius:' + (large ? 6 : 4) + 'px;background:' + RED + ';color:#fff;' +
        'font:700 ' + (large ? 13 : 11) + 'px/1 Arial,Helvetica,sans-serif;letter-spacing:0;text-transform:none;text-decoration:none;direction:ltr;' +
        'box-shadow:0 0 0 ' + (large ? 2 : 1.5) + 'px rgba(255,255,255,.95);z-index:' + (host === document.body ? '2147483002' : '7') + ';'
    );
    el.textContent = String(n);
    put(el, host, left, top);
  }
  /* A filled arrow whose tip is at (tipX, tipY), coming from the given side. */
  function arrow(side, tipX, tipY, length, host) {
    var across = 22;
    var wide = side === 'left' || side === 'right';
    var w = wide ? length : across;
    var h = wide ? across : length;
    var L = length;
    var points;
    var left;
    var top;
    if (side === 'below') {
      /* comes from below, points up */
      points = '11,0 22,15 15,15 15,' + L + ' 7,' + L + ' 7,15 0,15';
      left = tipX - 11;
      top = tipY;
    } else if (side === 'above') {
      points = '11,' + L + ' 22,' + (L - 15) + ' 15,' + (L - 15) + ' 15,0 7,0 7,' + (L - 15) + ' 0,' + (L - 15);
      left = tipX - 11;
      top = tipY - L;
    } else if (side === 'right') {
      /* comes from the right, points left */
      points = '0,11 15,0 15,7 ' + L + ',7 ' + L + ',15 15,15 15,22';
      left = tipX;
      top = tipY - 11;
    } else {
      points = L + ',11 ' + (L - 15) + ',0 ' + (L - 15) + ',7 0,7 0,15 ' + (L - 15) + ',15 ' + (L - 15) + ',22';
      left = tipX - L;
      top = tipY - 11;
    }
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', String(w));
    svg.setAttribute('height', String(h));
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    svg.setAttribute('style', 'pointer-events:none;overflow:visible;margin:0;padding:0;z-index:' + (host === document.body ? '2147483001' : '6') + ';');
    var shape = document.createElementNS(NS, 'polygon');
    shape.setAttribute('points', points);
    shape.setAttribute('fill', RED);
    shape.setAttribute('stroke', '#ffffff');
    shape.setAttribute('stroke-width', '1.6');
    shape.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(shape);
    put(svg, host, left, top);
  }
  function overlap(a, b) {
    var w = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
    var h = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
    return w > 0 && h > 0 ? w * h : 0;
  }
  /* How much of what a person reads or presses an area would lie across: the words and the controls under it. */
  function covers(area, own) {
    var hit = 0;
    var seen = [];
    var across = area.width >= area.height;
    /* A small area (a number tag) is felt at nine points; a long one (an arrow) at five along it. */
    var small = area.width <= 32 && area.height <= 32;
    for (var step = 0; step < (small ? 9 : 5); step += 1) {
      var x = small ? area.left + (area.width * ((step % 3) + 0.5)) / 3 : across ? area.left + (area.width * (step + 0.5)) / 5 : area.left + area.width / 2;
      var y = small ? area.top + (area.height * (Math.floor(step / 3) + 0.5)) / 3 : across ? area.top + area.height / 2 : area.top + (area.height * (step + 0.5)) / 5;
      var under = document.elementFromPoint(x, y);
      if (!under || seen.indexOf(under) >= 0) continue;
      seen.push(under);
      if (own && (own === under || own.contains(under))) continue;
      if (/^(INPUT|SELECT|TEXTAREA|BUTTON|IMG|SVG|PATH|A)$/i.test(under.tagName)) {
        hit += overlap(under.getBoundingClientRect(), area) || 1;
        continue;
      }
      for (var c = 0; c < under.childNodes.length; c += 1) {
        var node = under.childNodes[c];
        if (node.nodeType !== 3 || !String(node.nodeValue || '').replace(/\s+/g, '')) continue;
        var range = document.createRange();
        range.selectNodeContents(node);
        var boxes = range.getClientRects();
        for (var b = 0; b < boxes.length; b += 1) hit += overlap(boxes[b], area);
      }
    }
    return hit;
  }

  /* Which items the caller asked to have pointed at. One item per asked-for label: the best match, not every match. */
  function choosePointed(items, pointAt) {
    var notFound = [];
    for (var i = 0; i < items.length; i += 1) {
      if (items[i].el.hasAttribute && (items[i].el.hasAttribute('data-guide-point') || (items[i].el.querySelector && items[i].el.querySelector('[data-guide-point]')))) items[i].pointed = true;
    }
    for (var p = 0; p < (pointAt || []).length; p += 1) {
      var asked = String(pointAt[p] == null ? '' : pointAt[p]).replace(/\s+/g, ' ').trim();
      if (!asked) continue;
      var want = asked.toLowerCase();
      var best = null;
      var bestTier = 99;
      for (var k = 0; k < items.length; k += 1) {
        var tier = 99;
        var label = String(items[k].label || '').toLowerCase();
        var head = label.split(':')[0].trim();
        /* A table, a section and a row of tabs are named by everything in them: the control itself comes first. */
        var holds = items[k].kind === 'table' || items[k].kind === 'section' || items[k].kind === 'tabs';
        if (/^\d+$/.test(asked)) tier = Number(asked) === k + 1 ? 0 : 99;
        else if (label === want) tier = 1;
        else if (head === want) tier = 2;
        else if (label.indexOf(want) === 0) tier = holds ? 5 : 3;
        else if (label.indexOf(want) >= 0) tier = holds ? 6 : 4;
        if (tier < bestTier) {
          bestTier = tier;
          best = items[k];
        }
      }
      if (best) best.pointed = true;
      else notFound.push(asked);
    }
    return notFound;
  }

  function draw(items, opts) {
    var rtl = getComputedStyle(document.documentElement).direction === 'rtl';
    var vw = window.innerWidth;
    var vh = opts.fullPage ? Math.max(document.documentElement.scrollHeight - window.pageYOffset, window.innerHeight) : window.innerHeight;
    var notFound = choosePointed(items, opts.pointAt);
    var marks = [];
    var rects = [];
    var placed = [];
    var i;
    for (i = 0; i < items.length; i += 1) {
      var r = items[i].el.getBoundingClientRect();
      var held = hostFor(items[i].el);
      var edge = held === document.body ? { left: 0, right: vw } : held.getBoundingClientRect();
      var from = Math.max(r.left, edge.left + 6);
      var to = Math.min(r.right, edge.right - 6);
      rects.push({ left: from, top: r.top, width: Math.max(4, to - from), height: r.height });
    }
    function clampX(x, w) {
      return Math.max(2, Math.min(vw - w - 2, x));
    }
    function clampY(y, h) {
      return Math.max(2, Math.min(vh - h - 2, y));
    }
    function free(box) {
      for (var o = 0; o < placed.length; o += 1) if (overlap(placed[o], box) > 0) return false;
      return true;
    }

    for (i = 0; i < items.length; i += 1) {
      var item = items[i];
      var rect = rects[i];
      var n = i + 1;
      var host = hostFor(item.el);
      var mark = { n: n, label: item.label, kind: item.kind };
      if (item.required) mark.required = true;
      if (item.field) {
        var options = optionsOf(item.field);
        if (options) mark.options = options;
        var hint = hintOf(item.field, item.fieldLabel, item.label);
        if (hint) mark.hint = hint;
      }
      if (opts.withValues) {
        var value = null;
        if (item.value) value = item.value;
        else if (item.block) value = blockValue(item.block);
        else if (item.field && item.kind !== 'search') value = valueOf(item.field, item.label);
        else if (item.table && item.table.tBodies && item.table.tBodies.length && !item.table.querySelector('tbody input, tbody select, tbody textarea')) {
          /* Counted only where the rows are records: a grid to type lines into has blank rows waiting, which are not. */
          var body = item.table.tBodies[0].rows;
          var count = 0;
          /* One cell across the whole table is the table saying it is empty, not a row of it. */
          for (var br = 0; br < body.length; br += 1) if (body[br].cells.length > 1 || (body[br].cells[0] && (body[br].cells[0].colSpan || 1) === 1)) count += 1;
          value = count + (count === 1 ? ' row' : ' rows');
        }
        if (value) mark.value = value;
      }

      if (item.pointed) {
        mark.pointed = true;
        var pad = 4;
        var box = { left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 };
        frame(rect, pad, true, host);
        /* The arrow comes from whichever side has room: the side that covers least of everything else that is numbered. */
        var length = 40;
        var tw = tagWidth(n, true);
        var reach = length + 20;
        var near = Math.min(box.width / 2, 64);
        var cy = box.top + box.height / 2;
        var sides = [];
        /* Along the top and bottom edges: near the start, in the middle, near the end. */
        var along = [rtl ? box.left + box.width - near : box.left + near];
        if (box.width > 200) {
          along.push(box.left + box.width / 2);
          along.push(rtl ? box.left + near : box.left + box.width - near);
        }
        for (var at = 0; at < along.length; at += 1) {
          var ax = along[at];
          sides.push({ side: 'below', tipX: ax, tipY: box.top + box.height + 3, area: { left: ax - 13, top: box.top + box.height + 3, width: 26, height: reach }, tagAt: { left: ax - tw / 2, top: box.top + box.height + 3 + length - 4 }, bias: at * 15 });
          sides.push({ side: 'above', tipX: ax, tipY: box.top - 3, area: { left: ax - 13, top: box.top - 3 - reach, width: 26, height: reach }, tagAt: { left: ax - tw / 2, top: box.top - 3 - length - 18 }, bias: 80 + at * 15 });
        }
        sides.push({ side: rtl ? 'left' : 'right', tipX: rtl ? box.left - 3 : box.left + box.width + 3, tipY: cy, area: { left: rtl ? box.left - 3 - reach : box.left + box.width + 3, top: cy - 13, width: reach, height: 26 }, tagAt: { left: rtl ? box.left - 3 - length - tw + 4 : box.left + box.width + 3 + length - 4, top: cy - 11 }, bias: 40 });
        sides.push({ side: rtl ? 'right' : 'left', tipX: rtl ? box.left + box.width + 3 : box.left - 3, tipY: cy, area: { left: rtl ? box.left + box.width + 3 : box.left - 3 - reach, top: cy - 13, width: reach, height: 26 }, tagAt: { left: rtl ? box.left + box.width + 3 + length - 4 : box.left - 3 - length - tw + 4, top: cy - 11 }, bias: 120 });
        var chosen = null;
        var least = Infinity;
        for (var s = 0; s < sides.length; s += 1) {
          var area = sides[s].area;
          var cost = sides[s].bias;
          if (area.left < 2 || area.top < 2 || area.left + area.width > vw - 2 || area.top + area.height > vh - 2) cost += 1000000;
          /* Another numbered control under the arrow costs most; a section or a block is only what they sit in. */
          for (var q = 0; q < rects.length; q += 1) if (q !== i && !items[q].tagOnly) cost += overlap(rects[q], area) * 3;
          for (var z = 0; z < placed.length; z += 1) cost += overlap(placed[z], area) * 6;
          cost += covers(area, item.el) * 8;
          if (cost < least) {
            least = cost;
            chosen = sides[s];
          }
        }
        arrow(chosen.side, chosen.tipX, chosen.tipY, length, host);
        tag(n, true, host, clampX(chosen.tagAt.left, tw), clampY(chosen.tagAt.top, 22));
        placed.push(chosen.area);
      } else {
        var small = tagWidth(n, false);
        var left;
        var top;
        if (item.tagOnly) {
          if (item.place === 'before') {
            /* Words that start at the edge of their box are pointed at from beside them. */
            left = rtl ? rect.left + rect.width + 4 : rect.left - small - 4;
            top = rect.top + Math.min(rect.height, 22) / 2 - 8;
            if (left < 2 || left > vw - small - 2) {
              left = rtl ? rect.left + rect.width - small : rect.left;
              top = rect.top - 17;
            }
          } else {
            left = rtl ? rect.left + rect.width - 4 : rect.left - small + 4;
            top = rect.top - 9;
          }
        } else {
          var thin = 3;
          frame(rect, thin, false, host);
          if (item.place === 'above') {
            left = rect.left + rect.width / 2 - small / 2;
            top = rect.top - thin - 15;
          } else if (item.place === 'below') {
            left = rect.left + rect.width / 2 - small / 2;
            top = rect.top + rect.height + thin - 3;
          } else {
            /*
             * On the box's top-start corner, hung outside it: the words inside and the label above stay
             * readable. Where that corner would sit on other words, the next free place round the box.
             */
            var spots = [
              { left: rtl ? rect.left + rect.width + thin - 3 : rect.left - thin - small + 3, top: rect.top - thin - 8 },
              { left: rtl ? rect.left + rect.width + thin + 2 : rect.left - thin - small - 2, top: rect.top + rect.height / 2 - 8 },
              { left: rtl ? rect.left - thin - small + 3 : rect.left + rect.width + thin - 3, top: rect.top - thin - 8 },
              { left: rtl ? rect.left + rect.width + thin - 3 : rect.left - thin - small + 3, top: rect.top + rect.height + thin - 8 }
            ];
            left = spots[0].left;
            top = spots[0].top;
            for (var sp = 0; sp < spots.length; sp += 1) {
              var spot = { left: clampX(spots[sp].left, small), top: clampY(spots[sp].top, 16), width: small, height: 16 };
              if (free(spot) && covers(spot, item.el) < 12) {
                left = spot.left;
                top = spot.top;
                break;
              }
            }
          }
        }
        left = clampX(left, small);
        top = clampY(top, 16);
        for (var tries = 0; tries < 5; tries += 1) {
          if (free({ left: left, top: top, width: small, height: 16 })) break;
          left = clampX(left + (rtl ? small + 2 : -(small + 2)), small);
          if (tries === 2) {
            left = clampX(rtl ? rect.left + rect.width + 2 : rect.left - small - 2, small);
            top = clampY(top + 18, 16);
          }
        }
        placed.push({ left: left, top: top, width: small, height: 16 });
        tag(n, false, host, left, top);
      }
      marks.push(mark);
    }
    return { marks: marks, notFound: notFound };
  }

  window.__erpUnmark = function () {
    var all = document.querySelectorAll('[' + ATTR + ']');
    for (var i = 0; i < all.length; i += 1) if (all[i].parentNode) all[i].parentNode.removeChild(all[i]);
  };

  window.__erpMark = function (options) {
    var opts = options || {};
    window.__erpUnmark();
    var scope = opts.scope || 'screen';
    var items;
    if (scope === 'top-bar') items = collectTopBar();
    else if (scope === 'user-menu') items = collectUserMenu();
    else if (scope === 'form' || scope === 'dialog') {
      var open = document.querySelector('dialog[open]');
      var root = opts.root ? document.querySelector(opts.root) : open || document.querySelector('main') || document.body;
      if (!root) return { marks: [], notFound: (opts.pointAt || []).slice() };
      var inDialog = !!(root.closest && root.closest('dialog'));
      var gridAsOne = opts.gridAsOne === undefined || opts.gridAsOne === null ? scope === 'dialog' || !inDialog : !!opts.gridAsOne;
      items = collectForm(root, opts.max || 30, gridAsOne, scope === 'dialog');
    } else {
      items = collectPage(opts.max || 24, !!opts.fullPage);
    }
    return draw(items, opts);
  };
})();`;

/** The call that draws, as an expression to evaluate in the page. */
export const markCall = (options: MarkOptions): string => `window.__erpMark(${JSON.stringify(options)})`;

/** The call that takes the drawing away again. */
export const UNMARK_CALL = 'window.__erpUnmark && window.__erpUnmark()';

/** What `drawMarks` needs of a page: Playwright's `Page` is one, and nothing else is asked of it. */
export interface MarkablePage {
  evaluate(script: string): Promise<unknown>;
}

/**
 * Draw the pointers on a page and say what each number is on.
 *
 * The script is put in first when the page has not got it (a navigation
 * throws it away with the page it was in).
 */
export async function drawMarks(page: MarkablePage, options: MarkOptions): Promise<MarkResult> {
  await page.evaluate(MARKERS_JS);
  const result = (await page.evaluate(markCall(options))) as MarkResult | null;
  return { marks: result?.marks ?? [], notFound: result?.notFound ?? [] };
}

/** Take the pointers off again — before the page is used for another picture. */
export async function clearMarks(page: MarkablePage): Promise<void> {
  await page.evaluate(UNMARK_CALL).catch(() => {});
}
