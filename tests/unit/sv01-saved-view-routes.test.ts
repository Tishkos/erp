/**
 * Saved views — the registry of viewable screens (platform phase, Agent 8).
 *
 * The registry is the whole contract between a screen and the saved-views
 * machinery, so the things that would make a view lie are held here, with no
 * database: every registered route is a delivered menu screen, every date slot
 * names parameters the screen declares, every value a summary prints has a
 * message in both languages, and every registered screen actually asks for
 * its views (a registry entry with no `savedViewsFor` in its page would be a
 * screen that silently never offers the menu).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '../../messages/en.json';
import ar from '../../messages/ar.json';
import { VIEWABLE_ROUTES, viewableRoute } from '@domain/saved-view-routes';
import { POINT_RULES, RANGE_RULES, sanitiseParams, type LabelSource } from '@domain/saved-views';
import { screenRoutes } from '@domain/screens';
import { visibleRoute } from '@/server/delivered';
import { countedRoutes } from '@/server/services/saved-view-counts';

const ROOT = join(__dirname, '..', '..');
const CATALOGUES = { en, ar } as const;

type Tree = { [key: string]: Tree | string };

function lookup(catalogue: unknown, path: string): string | null {
  let node: unknown = catalogue;
  for (const part of path.split('.')) {
    if (typeof node !== 'object' || node === null || !(part in node)) return null;
    node = (node as Tree)[part];
  }
  return typeof node === 'string' ? node : null;
}

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

function labelKey(source: LabelSource, value: string): string {
  if ('own' in source) return `savedViews.values.${source.own}.${value}`;
  return `${source.namespace}.${source.map?.[value] ?? `${source.prefix ?? ''}${value}`}`;
}

describe('SV-1 · the registry of viewable screens', () => {
  it('has at least the screens the brief names', () => {
    const keys = VIEWABLE_ROUTES.map((route) => route.key);
    for (const wanted of [
      'payables.invoices',
      'payables.open_items',
      'sales.invoices',
      'sales.receipts',
      'sales.receivables',
      'imports.containers',
      'imports.pd',
      'inventory.availability',
      'payables.suppliers',
      'sales.customers',
    ]) {
      expect(keys).toContain(wanted);
    }
  });

  it('keys are unique and dotted; routes are unique', () => {
    const keys = VIEWABLE_ROUTES.map((route) => route.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(/^[a-z_]+\.[a-z_]+$/);
    const routes = VIEWABLE_ROUTES.map((route) => route.route);
    expect(new Set(routes).size).toBe(routes.length);
  });

  it('every route is a delivered screen of the menu, with a permission the screen is opened by', () => {
    const catalogue = screenRoutes();
    const wrong: string[] = [];
    for (const route of VIEWABLE_ROUTES) {
      const screen = catalogue.get(route.route);
      if (!screen) wrong.push(`${route.key}: ${route.route} is not a menu screen`);
      else if (!(route.object ?? screen.item.object)) wrong.push(`${route.key}: no permission object`);
      if (!visibleRoute(route.route)) wrong.push(`${route.key}: ${route.route} is not delivered`);
    }
    expect(wrong).toEqual([]);
  });

  it('a date slot names parameters the screen declares, as dates', () => {
    const wrong: string[] = [];
    for (const route of VIEWABLE_ROUTES) {
      for (const slot of route.slots ?? []) {
        const names = slot.kind === 'range' ? [slot.from, slot.to] : [slot.param];
        for (const name of names) {
          if (route.params[name]?.kind !== 'date') wrong.push(`${route.key}.${slot.id}: ${name} is not a declared date`);
        }
      }
      const ids = (route.slots ?? []).map((slot) => slot.id);
      if (new Set(ids).size !== ids.length) wrong.push(`${route.key}: duplicate slot id`);
    }
    expect(wrong).toEqual([]);
  });

  it('an enum declares values, and every one has a label in both languages', () => {
    const missing: string[] = [];
    for (const route of VIEWABLE_ROUTES) {
      for (const [name, spec] of Object.entries(route.params)) {
        if (spec.kind !== 'enum') continue;
        expect(spec.values.length).toBeGreaterThan(0);
        for (const value of spec.values) {
          if (!spec.labels) {
            missing.push(`${route.key}.${name}=${value}: no label source`);
            continue;
          }
          const key = labelKey(spec.labels, value);
          for (const [language, catalogue] of Object.entries(CATALOGUES)) {
            if (lookup(catalogue, key) === null) missing.push(`${language}: ${key}`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('every parameter, slot, rule and refusal has words in both languages', () => {
    const missing: string[] = [];
    const need = (key: string) => {
      for (const [language, catalogue] of Object.entries(CATALOGUES)) {
        if (lookup(catalogue, key) === null) missing.push(`${language}: ${key}`);
      }
    };
    for (const route of VIEWABLE_ROUTES) {
      for (const name of Object.keys(route.params)) need(`savedViews.params.${name}`);
      for (const slot of route.slots ?? []) need(`savedViews.slots.${slot.id}`);
    }
    for (const rule of RANGE_RULES) need(`savedViews.rules.range.${rule}`);
    for (const rule of POINT_RULES) need(`savedViews.rules.point.${rule}`);
    for (const code of [
      'not_found',
      'unknown_route',
      'unavailable',
      'name_taken',
      'limit_views',
      'limit_pins',
      'name_required',
      'name_too_long',
      'name_invalid',
      'unknown_rule',
      'too_many_params',
    ]) {
      need(`savedViews.errors.${code}`);
    }
    for (const reason of ['no_access', 'not_delivered', 'unknown_screen']) need(`savedViews.unavailable_${reason}`);
    expect(missing).toEqual([]);
  });

  it('every change a service audits has a label in both languages', () => {
    const source = readFileSync(join(ROOT, 'src/server/services/saved-views.ts'), 'utf8');
    const actions = new Set([...source.matchAll(/note\(tx, ctx, (?:on \? )?'([a-z_]+)'(?: : '([a-z_]+)')?/g)].flatMap((m) => [m[1]!, m[2]].filter(Boolean) as string[]));
    expect([...actions].sort()).toEqual(
      ['created', 'default_cleared', 'default_set', 'deleted', 'duplicated', 'pinned', 'renamed', 'unpinned'].sort(),
    );
    const missing: string[] = [];
    for (const action of actions) {
      for (const [language, catalogue] of Object.entries(CATALOGUES)) {
        if (lookup(catalogue, `audit_action.saved_view.${action}`) === null) missing.push(`${language}: ${action}`);
        if (lookup(catalogue, 'admin.audit.kinds.saved_view') === null) missing.push(`${language}: kind`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every registered screen asks for its views, and the menu is drawn from them', () => {
    // Screens and the components they are built from; the gate and the registry only describe the call.
    const pages = [...sources(join(ROOT, 'src/app')), ...sources(join(ROOT, 'src/components'))].map((file) => ({
      file,
      text: readFileSync(file, 'utf8'),
    }));
    const unwired: string[] = [];
    for (const route of VIEWABLE_ROUTES) {
      const asks = pages.filter(({ text }) => text.includes('savedViewsFor(') && text.includes(`'${route.key}'`));
      if (asks.length === 0) unwired.push(`${route.key}: no screen calls savedViewsFor`);
      for (const { file, text } of asks) {
        if (!text.includes('<SavedViewsMenu')) unwired.push(`${route.key}: ${file} asks but does not draw the menu`);
      }
    }
    expect(unwired).toEqual([]);
  });

  it('a screen asks for exactly the key it is registered under', () => {
    const wrong: string[] = [];
    const known = new Set(VIEWABLE_ROUTES.map((route) => route.key));
    for (const file of [...sources(join(ROOT, 'src/app')), ...sources(join(ROOT, 'src/components'))]) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/savedViewsFor\(\s*(?:[^'()]*\?\s*)?'([a-z_.]+)'/g)) {
        if (!known.has(match[1]!)) wrong.push(`${file}: '${match[1]}'`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('only registered screens have a pinned count', () => {
    for (const key of countedRoutes()) expect(viewableRoute(key)).toBeDefined();
  });

  it('a parameter the screen never declared does not survive a sanitise (every route, no exceptions)', () => {
    for (const route of VIEWABLE_ROUTES) {
      const clean = sanitiseParams(route, { __smuggled: '1', 'x.y': 'z', page: '3', sv: 'none', saved: '1' });
      expect(clean.params).toEqual({});
    }
  });
});
