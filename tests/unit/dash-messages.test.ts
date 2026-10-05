/**
 * Home and My Approvals have every word they draw, in both languages —
 * platform phase, Agent 2.
 *
 * The widgets are data and the presenters resolve their words by key at draw
 * time, so a widget without a title or a column without a heading would show up
 * only as a raw key on a screen. This reads the registry and the loaders' own
 * source for the keys they use and fails here instead.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import en from '../../messages/en.json';
import ar from '../../messages/ar.json';
import { JOURNEY_STAGES } from '@/server/domain/import-journey';
import { APPROVAL_SOURCES } from '@/server/domain/approval-center';
import { QUICK_ACTIONS, WIDGETS, DATA_FAMILIES } from '@/server/domain/dashboard-widgets';

type Tree = { readonly [key: string]: string | Tree };
const locales: readonly [string, Tree][] = [
  ['en', en as unknown as Tree],
  ['ar', ar as unknown as Tree],
];

function at(tree: Tree, path: string): string | Tree | undefined {
  let node: string | Tree | undefined = tree;
  for (const part of path.split('.')) {
    if (node === undefined || typeof node === 'string') return undefined;
    node = node[part];
  }
  return node;
}

const words = (tree: Tree, path: string): string | undefined => {
  const found = at(tree, path);
  return typeof found === 'string' ? found : undefined;
};

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const loaders = source('src/server/services/home-loaders.ts');
const center = source('src/server/services/approval-center.ts');

const unique = (values: readonly string[]) => [...new Set(values)];
const matches = (text: string, pattern: RegExp) => unique([...text.matchAll(pattern)].map((m) => m[1]!));

/** `{name}` placeholders of an ICU message, ignoring plural bodies. */
const placeholders = (message: string): string[] =>
  unique([...message.matchAll(/\{([a-zA-Z]+)(?:,|\})/g)].map((m) => m[1]!)).sort();

describe('Home speaks in both languages', () => {
  for (const [code, tree] of locales) {
    it(`${code}: every widget has a title and an empty sentence`, () => {
      for (const widget of WIDGETS) {
        expect(words(tree, `home.widget.${widget.key}.title`), `${widget.key} title`).toBeTruthy();
        expect(words(tree, `home.widget.${widget.key}.empty`), `${widget.key} empty`).toBeTruthy();
      }
    });

    it(`${code}: every quick action, journey step and unavailable family has its words`, () => {
      for (const action of QUICK_ACTIONS) expect(words(tree, `home.quick.${action.key}`), action.key).toBeTruthy();
      for (const stage of JOURNEY_STAGES) expect(words(tree, `home.journey.${stage}`), stage).toBeTruthy();
      for (const family of DATA_FAMILIES) expect(words(tree, `home.unavailable.${family}`), family).toBeTruthy();
      for (const key of ['section_charts', 'section_quiet', 'section_unavailable', 'quiet_what', 'quiet_why', 'see_all']) {
        expect(words(tree, `home.${key}`), key).toBeTruthy();
      }
    });

    it(`${code}: every column, note and sentence a loader names exists`, () => {
      // The extraction must find what it is checking, or this passes by reading nothing.
      expect(matches(loaders, /col\('([a-z_]+)'/g).length).toBeGreaterThan(40);
      expect(matches(loaders, /note: \{ key: '([a-z_]+)'/g).length).toBeGreaterThan(10);
      for (const key of matches(loaders, /col\('([a-z_]+)'/g)) expect(words(tree, `home.col.${key}`), `col ${key}`).toBeTruthy();
      for (const key of matches(loaders, /note: \{ key: '([a-z_]+)'/g)) expect(words(tree, `home.note.${key}`), `note ${key}`).toBeTruthy();
      for (const key of matches(loaders, /(?:\bsay\(|t: 'say', v: )'([a-z_]+)'/g)) expect(words(tree, `home.say.${key}`), `say ${key}`).toBeTruthy();
      // Words without a namespace are `home.value.<code>`.
      for (const key of matches(loaders, /\bword\('([a-z_]+)'\)/g)) expect(words(tree, `home.value.${key}`), `value ${key}`).toBeTruthy();
      // Series named by the chart specs.
      for (const key of matches(loaders, /(?:firstKey|secondKey): '([a-z_]+)'/g)) expect(words(tree, `home.value.${key}`), `series ${key}`).toBeTruthy();
    });

    it(`${code}: the Exception Center's severities and areas are worded`, () => {
      for (const severity of ['critical', 'high', 'medium', 'low']) expect(words(tree, `home.severity.${severity}`), severity).toBeTruthy();
      for (const area of ['accounting', 'receivables', 'payables', 'inventory', 'logistics', 'tasks', 'approvals', 'platform']) {
        expect(words(tree, `home.domain.${area}`), area).toBeTruthy();
      }
    });

    it(`${code}: every document type, action and stage My Approvals can show is worded`, () => {
      const types = unique([
        ...matches(center, /documentType: '([a-z_]+)'/g),
        ...matches(center, /^ {2}([a-z_]+): \{$/gm).filter((key) => ['chart_of_account', 'journal_entry', 'partner_bank_account'].includes(key)),
      ]);
      expect(types.length).toBeGreaterThanOrEqual(10);
      for (const type of types) expect(words(tree, `admin.approvals.type_${type}`), `type ${type}`).toBeTruthy();
      for (const action of ['approve', 'post', 'confirm', 'endorse', 'decide', 'pay', 'rate', 'sign_off', 'read', 'issue', 'hire', 'reimburse']) {
        expect(words(tree, `admin.approvals.action_${action}`), `action ${action}`).toBeTruthy();
      }
      // Every source the list reads from is accounted for by a type above.
      expect(APPROVAL_SOURCES.length).toBeGreaterThan(0);
    });
  }

  it('keeps the same placeholders in English and Arabic, message by message', () => {
    const enHome = at(en as unknown as Tree, 'home') as Tree;
    const arHome = at(ar as unknown as Tree, 'home') as Tree;
    const walk = (a: Tree, b: Tree, path: string) => {
      expect(Object.keys(b).sort(), `${path} keys`).toEqual(Object.keys(a).sort());
      for (const key of Object.keys(a)) {
        const left = a[key]!;
        const right = b[key]!;
        if (typeof left === 'string') {
          expect(typeof right, `${path}.${key}`).toBe('string');
          expect(placeholders(right as string), `${path}.${key}`).toEqual(placeholders(left));
        } else {
          walk(left, right as Tree, `${path}.${key}`);
        }
      }
    };
    walk(enHome, arHome, 'home');
  });
});
