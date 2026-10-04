/**
 * ERP Control Center — the rules, the catalogue and the wording hold together, with no database
 * (platform phase, Agent 9).
 *
 * The state arithmetic (an unavailable check is never green, a check nobody could run is never counted for
 * the books), the exactness of the comparisons (a fils is a fils), the evidence shaping (the cap, the
 * hidden count), the job and transit rules, and that every check, figure, item and reason the screen can
 * show has wording in both languages with the same placeholders — so no raw code and no half-translated
 * sentence reaches a page. The checks on a real database, the permission matrix and the "no business row
 * moved" guarantee are `tests/integration/cc01-control-center.test.ts`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CC_DOMAINS,
  CHECKS,
  CHECK_STATES,
  ITEM_CAP,
  NON_MENU_OBJECTS,
  REASON_CODES,
  RESERVED_OBJECTS,
  REASON_MESSAGE_MAX,
  STATE_ORDER,
  STATE_TONE,
  capItems,
  checkKey,
  checkOf,
  checksOf,
  compareAmounts,
  cronIntervalMinutes,
  isCcDomain,
  isCheckState,
  isZeroAmount,
  jobState,
  minutesSince,
  missingRequirement,
  overdueAfterMinutes,
  readingOf,
  reasonFromError,
  resultOf,
  stateOf,
  sumAmounts,
  summarize,
  superUsersNeedAttention,
  transitIssues,
  unknownObjects,
  withheld,
  type Item,
} from '@/server/domain/control-center';
import { menuObjects } from '@/server/domain/menu';
import { screenRoutes } from '@/server/domain/screens';
import ar from '../../messages/ar.json';
import en from '../../messages/en.json';

const reading = (over: Partial<Parameters<typeof stateOf>[0]> = {}) => ({ attention: 0, unavailable: null, notConfigured: false, ...over });

describe('the four states', () => {
  it('is ok only when the check ran and found nothing', () => {
    expect(stateOf(reading())).toBe('ok');
    expect(stateOf(reading({ attention: 3 }))).toBe('attention');
  });

  it('never shows an unavailable check as green, however little it found before failing', () => {
    expect(stateOf(reading({ unavailable: { code: 'timeout', params: { seconds: 10 } } }))).toBe('unavailable');
    expect(stateOf(reading({ attention: 5, unavailable: { code: 'error', params: { message: 'x' } } }))).toBe('unavailable');
  });

  it('calls a check that is switched off here not-checked, not ok', () => {
    expect(stateOf(reading({ notConfigured: true }))).toBe('not_checked');
  });

  it('tones every state with a chip the application already has, and orders the urgent first', () => {
    for (const state of CHECK_STATES) expect(STATE_TONE[state]).toMatch(/^(approved|rejected|draft|submitted)$/);
    expect(STATE_ORDER[0]).toBe('attention');
    expect([...STATE_ORDER].sort()).toEqual([...CHECK_STATES].sort());
    expect(isCheckState('ok')).toBe(true);
    expect(isCheckState('green')).toBe(false);
    expect(isCcDomain('platform')).toBe(true);
    expect(isCcDomain('tasks')).toBe(false);
  });
});

describe('evidence', () => {
  const item = (n: number): Item => ({ code: 'x', params: { n }, ref: `R${n}`, href: null });

  it('lists the first items and counts the rest, so the number on the page is the number found', () => {
    const items = Array.from({ length: ITEM_CAP + 5 }, (_, n) => item(n));
    const shaped = readingOf({ items, figures: [{ key: 'found', count: items.length }] });
    expect(shaped.items).toHaveLength(ITEM_CAP);
    expect(shaped.attention).toBe(ITEM_CAP + 5);
    const result = resultOf(checkOf('accounting.trial_balance')!, shaped, 12);
    expect(result.state).toBe('attention');
    expect(result.hidden).toBe(5);
    expect(result.items).toHaveLength(ITEM_CAP);
    expect(capItems([1, 2, 3], 2)).toEqual({ shown: [1, 2], hidden: 1 });
  });

  it('keeps the figures of a healthy check and carries no items or attention', () => {
    const result = resultOf(
      checkOf('receivables.control_account')!,
      readingOf({ figures: [{ key: 'subledger', amountIqd: '100.0000' }, { key: 'control_account', amountIqd: '100.0000' }] }),
      3,
    );
    expect(result.state).toBe('ok');
    expect(result.figures).toHaveLength(2);
    expect(result.items).toEqual([]);
    expect(result.attention).toBe(0);
    expect(result.reason).toBeNull();
  });

  it('says why a check did not answer', () => {
    const lacking = withheld(checkOf('platform.jobs')!, 'not_checked', { code: 'no_access', params: { object: 'job' } });
    expect(lacking).toMatchObject({ state: 'not_checked', figures: [], items: [], reason: { code: 'no_access' } });
    const off = resultOf(checkOf('platform.whatsapp')!, readingOf({ notConfigured: true }), 1);
    expect(off).toMatchObject({ state: 'not_checked', reason: { code: 'not_configured' } });
    const broken = resultOf(checkOf('platform.cloud')!, readingOf({ unavailable: { code: 'error', params: { message: 'boom' } } }), 1);
    expect(broken.state).toBe('unavailable');
  });

  it('counts states and never makes a score of them', () => {
    const summary = summarize([
      { domain: 'accounting', state: 'ok' },
      { domain: 'accounting', state: 'attention' },
      { domain: 'platform', state: 'unavailable' },
      { domain: 'platform', state: 'not_checked' },
      { domain: 'platform', state: 'ok' },
    ]);
    expect(summary.total).toBe(5);
    expect(summary.byState).toEqual({ ok: 2, attention: 1, not_checked: 1, unavailable: 1 });
    expect(summary.byDomain.accounting).toEqual({ ok: 1, attention: 1, not_checked: 0, unavailable: 0 });
    expect(Object.keys(summary).sort()).toEqual(['byDomain', 'byState', 'total']);
    expect(JSON.stringify(summary)).not.toMatch(/percent|score|grade/i);
  });
});

describe('money is compared as scaled integers', () => {
  it('sees a fils, and a difference of zero only when there is none', () => {
    expect(compareAmounts('1000000.0000', '1000000.0000').equal).toBe(true);
    const off = compareAmounts('1000000.0001', '1000000.0000');
    expect(off.equal).toBe(false);
    expect(off.differenceIqd).toBe('0.0001');
    expect(compareAmounts('5', '7').differenceIqd).toBe('-2.0000');
  });

  it('keeps the exactness a Number would lose', () => {
    // 2^53 + 1 is not representable as a Number; as a scaled bigint it is.
    expect(compareAmounts('9007199254740993.0000', '9007199254740992.0000').equal).toBe(false);
    expect(sumAmounts(['0.1', '0.2', '0.3'])).toBe('0.6000');
    expect(sumAmounts([])).toBe('0.0000');
  });

  it('allows the stated tolerance and no more', () => {
    expect(compareAmounts('100', '98', '2').equal).toBe(true);
    expect(compareAmounts('100', '97.9999', '2').equal).toBe(false);
  });

  it('reads blanks as zero', () => {
    expect(isZeroAmount('')).toBe(true);
    expect(isZeroAmount(null)).toBe(true);
    expect(isZeroAmount('0.0000')).toBe(true);
    expect(isZeroAmount('0.0001')).toBe(false);
    expect(compareAmounts('', '0').equal).toBe(true);
  });
});

describe('why an error is "could not be checked"', () => {
  it('names a statement timeout as a timeout', () => {
    expect(reasonFromError({ code: '57014' }, 10)).toEqual({ code: 'timeout', params: { seconds: 10 } });
    expect(reasonFromError({ cause: { code: '57014' } }, 7)).toEqual({ code: 'timeout', params: { seconds: 7 } });
  });

  it('shows the first line of any other error, shortened, never a stack', () => {
    const reason = reasonFromError(new Error('relation "x" does not exist\n    at foo (bar.ts:1:1)'), 10);
    expect(reason).toEqual({ code: 'error', params: { message: 'relation "x" does not exist' } });
    const long = reasonFromError(new Error('a'.repeat(500)), 10);
    expect(String(long.params?.message).length).toBeLessThanOrEqual(REASON_MESSAGE_MAX);
    expect(reasonFromError(undefined, 10).params?.message).toBe('unknown');
  });
});

describe('scheduled jobs', () => {
  const now = new Date('2026-10-04T12:00:00Z');
  const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();

  it('reads the intervals the crontab uses', () => {
    expect(cronIntervalMinutes('*/5 * * * *')).toBe(5);
    expect(cronIntervalMinutes('15 2 * * *')).toBe(1440);
    expect(cronIntervalMinutes('0 3 * * 0')).toBe(10080);
    expect(cronIntervalMinutes('0 */4 * * *')).toBe(240);
    expect(cronIntervalMinutes('30 * * * *')).toBe(60);
    expect(cronIntervalMinutes('0 0 1 * *')).toBeNull();
    expect(cronIntervalMinutes('nonsense')).toBeNull();
  });

  it('calls a run overdue after one and a half intervals and ten minutes', () => {
    expect(overdueAfterMinutes(60)).toBe(100);
    expect(overdueAfterMinutes(5)).toBe(17);
  });

  it('puts a failed exit before lateness, and never calls an unrecognised schedule overdue', () => {
    const job = { name: 'j', schedule: '*/5 * * * *' };
    expect(jobState({ ...job, lastRunAt: minutesAgo(2), lastExit: 0 }, now)).toBe('ok');
    expect(jobState({ ...job, lastRunAt: minutesAgo(2), lastExit: 1 }, now)).toBe('failed');
    expect(jobState({ ...job, lastRunAt: minutesAgo(40), lastExit: 0 }, now)).toBe('overdue');
    expect(jobState({ ...job, lastRunAt: null, lastExit: null }, now)).toBe('never');
    expect(jobState({ name: 'j', schedule: '0 0 1 * *', lastRunAt: minutesAgo(99999), lastExit: 0 }, now)).toBe('ok');
    expect(jobState({ ...job, lastRunAt: 'not a date', lastExit: 0 }, now)).toBe('never');
    expect(minutesSince(minutesAgo(125), now)).toBe(125);
    expect(minutesSince(null, now)).toBeNull();
  });
});

describe('imports in transit', () => {
  const base = { ordered: '100', shipped: '100', received: '40', inTransit: '60', containers: 2, containersOpen: 1 };

  it('says nothing about goods on the water', () => {
    expect(transitIssues(base)).toEqual([]);
  });

  it('finds more shipped or received than bought, exactly', () => {
    expect(transitIssues({ ...base, shipped: '100.000001' })).toEqual(['shipped_over_ordered']);
    expect(transitIssues({ ...base, received: '100.5' })).toEqual(['received_over_ordered']);
  });

  it('finds goods still in transit after every container is in', () => {
    expect(transitIssues({ ...base, containersOpen: 0 })).toEqual(['short_in_transit']);
    expect(transitIssues({ ...base, containersOpen: 0, inTransit: '0' })).toEqual([]);
    expect(transitIssues({ ...base, containers: 0, containersOpen: 0 })).toEqual([]);
  });
});

describe('permission anomalies, defined once', () => {
  it('flags only objects neither the menu nor the list of non-menu objects knows', () => {
    expect(unknownObjects(['payable', 'attachment', 'payble', 'payable', 'zz_old'], ['payable'])).toEqual(['payble', 'zz_old']);
  });

  it('keeps the list of non-menu objects free of objects the menu already has, and sorted, and each still used in src', () => {
    const menu = new Set(menuObjects());
    expect(NON_MENU_OBJECTS.filter((object) => menu.has(object))).toEqual([]);
    expect([...NON_MENU_OBJECTS]).toEqual([...NON_MENU_OBJECTS].sort());
    expect(new Set(NON_MENU_OBJECTS).size).toBe(NON_MENU_OBJECTS.length);

    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name) && !path.endsWith('domain/control-center.ts')) files.push(path);
      }
    };
    walk(join(process.cwd(), 'src'));
    const text = files.map((file) => readFileSync(file, 'utf8')).join('\n');
    const unused = NON_MENU_OBJECTS.filter((object) => !text.includes(`'${object}'`) && !text.includes(`"${object}"`) && !text.includes(`\`${object}\``));
    expect(unused).toEqual([]);
  });

  it('keeps each reserved object granted by a shipped migration and out of the menu', () => {
    const menu = new Set(menuObjects());
    const migrations = readdirSync(join(process.cwd(), 'src/server/db/migrations'))
      .filter((name) => name.endsWith('.sql'))
      .map((name) => readFileSync(join(process.cwd(), 'src/server/db/migrations', name), 'utf8'))
      .join('\n');
    for (const object of RESERVED_OBJECTS) {
      expect(menu.has(object), object).toBe(false);
      expect(migrations.includes(`'${object}'`), object).toBe(true);
      expect(NON_MENU_OBJECTS.includes(object), object).toBe(false);
    }
    expect(unknownObjects(['data_scope'], [])).toEqual([]);
  });

  it('tolerates one Super User and flags a second', () => {
    expect(superUsersNeedAttention(0)).toBe(false);
    expect(superUsersNeedAttention(1)).toBe(false);
    expect(superUsersNeedAttention(2)).toBe(true);
  });
});

describe('the catalogue of checks', () => {
  it('has unique codes, in the six domains, each with at least one check', () => {
    expect(new Set(CHECKS.map((check) => check.code)).size).toBe(CHECKS.length);
    for (const domain of CC_DOMAINS) expect(checksOf(domain).length, domain).toBeGreaterThan(0);
    for (const check of CHECKS) expect(check.code.startsWith(`${check.domain}.`), check.code).toBe(true);
  });

  it('names permission objects someone can hold, and routes the application serves', () => {
    // The menu's own objects, and the few a migration grants and a service checks (the landed cost the detectors ask).
    const objects = new Set([...menuObjects(), ...NON_MENU_OBJECTS]);
    const routes = screenRoutes();
    for (const check of CHECKS) {
      expect(check.requires.length, check.code).toBeGreaterThan(0);
      for (const requirement of check.requires) expect(objects.has(requirement.object), `${check.code}: ${requirement.object}`).toBe(true);
      expect(routes.has(check.route), `${check.code}: ${check.route}`).toBe(true);
    }
  });

  it('lets a person lacking one grant skip the check, and names the grant', () => {
    const check = checkOf('inventory.stock_vs_gl')!;
    const holds = new Set(['inventory_movement']);
    expect(missingRequirement(check, (_verb, object) => holds.has(object))).toEqual({ object: 'trial_balance', verb: 'view' });
    expect(missingRequirement(check, () => true)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

type Tree = { [key: string]: string | Tree };
const subtree = (messages: unknown, path: string): Tree => path.split('.').reduce<unknown>((node, key) => (node as Tree)?.[key], messages) as Tree;
const leaves = (tree: Tree, prefix = ''): Record<string, string> =>
  Object.entries(tree).reduce<Record<string, string>>((all, [key, value]) => {
    if (typeof value === 'string') all[`${prefix}${key}`] = value;
    else Object.assign(all, leaves(value, `${prefix}${key}.`));
    return all;
  }, {});

/** The argument names an ICU message uses: `{name}` and `{name, plural|select …}`, nested ones included. */
const placeholders = (message: string): string[] => {
  const names = new Set<string>();
  for (const match of message.matchAll(/\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?=[,}])/g)) names.add(match[1]!);
  for (const keyword of ['one', 'two', 'few', 'many', 'other', 'plural', 'select', 'zero']) names.delete(keyword);
  return [...names].sort();
};

const source = (relative: string) => readFileSync(join(process.cwd(), relative), 'utf8');

describe('wording, in both languages', () => {
  const enCc = leaves(subtree(en, 'admin.control_center'));
  const arCc = leaves(subtree(ar, 'admin.control_center'));
  const enRel = leaves(subtree(en, 'admin.relationships'));
  const arRel = leaves(subtree(ar, 'admin.relationships'));

  it('has the same keys in English and Arabic', () => {
    expect(Object.keys(arCc).sort()).toEqual(Object.keys(enCc).sort());
    expect(Object.keys(arRel).sort()).toEqual(Object.keys(enRel).sort());
    expect((ar.page as Record<string, string>).control_center).toBeTruthy();
    expect((en.page as Record<string, string>).control_center).toBeTruthy();
  });

  it('uses the same placeholders in both, and has no empty message', () => {
    for (const [all, other] of [[enCc, arCc], [enRel, arRel]] as const) {
      for (const [key, message] of Object.entries(all)) {
        expect(message.trim(), key).not.toBe('');
        expect(other[key]?.trim(), `ar ${key}`).toBeTruthy();
        expect(placeholders(other[key]!), key).toEqual(placeholders(message));
      }
    }
  });

  it('words every check, domain, state and reason', () => {
    for (const check of CHECKS) {
      for (const leaf of ['title', 'what']) expect(enCc[`check.${checkKey(check.code)}.${leaf}`], `${check.code} ${leaf}`).toBeTruthy();
    }
    for (const domain of CC_DOMAINS) expect(enCc[`domain_${domain}`], domain).toBeTruthy();
    for (const state of CHECK_STATES) expect(enCc[`state_${state}`], state).toBeTruthy();
    for (const code of REASON_CODES) expect(enCc[`reason.${code}`], code).toBeTruthy();
  });

  it('words every object a check can be withheld for', () => {
    const objects = new Set(CHECKS.flatMap((check) => check.requires.map((requirement) => requirement.object)));
    objects.add('control_center');
    for (const object of objects) expect(enCc[`object.${object}`], object).toBeTruthy();
  });

  it('words every figure and every item the readers can produce', () => {
    const readers = source('src/server/services/control-center-readers.ts');
    const figures = new Set([...readers.matchAll(/\b(?:amount|count|text)\('([a-z_]+)'/g)].map((match) => match[1]!));
    const items = new Set([...readers.matchAll(/\bitem\(\s*'([a-z_]+)'/g)].map((match) => match[1]!));
    // Items built from a computed code.
    for (const issue of ['shipped_over_ordered', 'received_over_ordered', 'short_in_transit']) items.add(`transit_${issue}`);
    expect(figures.size).toBeGreaterThan(30);
    expect(items.size).toBeGreaterThan(25);
    for (const key of figures) expect(enCc[`figure.${key}`], `figure ${key}`).toBeTruthy();
    for (const key of items) expect(enCc[`item.${key}`], `item ${key}`).toBeTruthy();
    // Nothing else is worded that no reader produces (a stale message is a lie waiting to be shown).
    const wordedFigures = Object.keys(enCc).filter((key) => key.startsWith('figure.')).map((key) => key.slice('figure.'.length));
    const wordedItems = Object.keys(enCc).filter((key) => key.startsWith('item.')).map((key) => key.slice('item.'.length));
    expect(wordedFigures.filter((key) => !figures.has(key))).toEqual([]);
    expect(wordedItems.filter((key) => !items.has(key))).toEqual([]);
  });

  it('words every state of the external words the page puts into its own language', () => {
    for (const word of ['connected', 'connecting', 'disconnected', 'reconnecting', 'stopped', 'logged_out', 'waiting_for_qr_scan', 'not_configured', 'not_linked', 'relink', 'ready', 'in_app', 'email', 'whatsapp']) {
      expect(enCc[`word.${word}`], word).toBeTruthy();
    }
  });
});
