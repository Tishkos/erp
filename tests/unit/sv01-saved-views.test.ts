/**
 * Saved views (platform phase, Agent 8) — the pure rules, without a database.
 *
 * A view is a screen's question: a route key, the parameters that screen
 * declares, and date *rules*. These tests hold what makes that safe — a view
 * can never carry a parameter its screen did not declare, a stored parameter
 * that stops being valid is dropped and named, a relative date is evaluated
 * from the business day passed in (never stored), and a default view applies
 * only to a bare arrival.
 */
import { describe, expect, it } from 'vitest';
import {
  RANGE_RULES,
  POINT_RULES,
  SavedViewInputError,
  addDays,
  chooseDefault,
  defaultRedirect,
  evaluatePointRule,
  evaluateRangeRule,
  hasExplicitParams,
  hrefOf,
  isCalendarDate,
  monthEnd,
  monthStart,
  normaliseName,
  normaliseValue,
  queryOf,
  resolveStored,
  sameParams,
  sanitiseParams,
  storedFrom,
  uniqueName,
  type ViewableRoute,
} from '@domain/saved-views';

/** A screen shaped like the Containers register: search, a view, an ETA range, and an as-at date. */
const route: ViewableRoute = {
  key: 'imports.containers',
  route: '/payables/containers',
  params: {
    q: { kind: 'text' },
    view: { kind: 'enum', values: ['in_transit', 'late', 'all'] },
    code: { kind: 'token' },
    min_amount: { kind: 'amount' },
    in_stock: { kind: 'flag' },
    eta_from: { kind: 'date' },
    eta_to: { kind: 'date' },
    as_at: { kind: 'date' },
  },
  slots: [
    { id: 'eta', kind: 'range', from: 'eta_from', to: 'eta_to' },
    { id: 'as_at', kind: 'point', param: 'as_at' },
  ],
};

describe('SV · a parameter is only what its screen declares', () => {
  it('accepts well-formed values of every kind and trims them', () => {
    expect(normaliseValue({ kind: 'text' }, '  steel   bars ')).toBe('steel bars');
    expect(normaliseValue({ kind: 'token' }, ' SUP-000012 ')).toBe('SUP-000012');
    expect(normaliseValue({ kind: 'token' }, 'مستودع 1')).toBe('مستودع 1');
    expect(normaliseValue({ kind: 'enum', values: ['a', 'b'] }, 'b')).toBe('b');
    expect(normaliseValue({ kind: 'flag' }, '1')).toBe('1');
    expect(normaliseValue({ kind: 'date' }, '2028-02-29')).toBe('2028-02-29');
    expect(normaliseValue({ kind: 'amount' }, '10000000.5')).toBe('10000000.5');
  });

  it('refuses what the screen would not understand, or should not be handed', () => {
    expect(normaliseValue({ kind: 'text' }, '   ')).toBeNull();
    expect(normaliseValue({ kind: 'text' }, 'x'.repeat(81))).toBeNull();
    expect(normaliseValue({ kind: 'text' }, 'a\u0000b')).toBeNull();
    expect(normaliseValue({ kind: 'text' }, 'bell\u0007')).toBeNull();
    expect(normaliseValue({ kind: 'text' }, 'evil\u202Ereverse')).toBeNull();
    // A line break is whitespace: it collapses to a space rather than splitting a name over lines.
    expect(normaliseValue({ kind: 'text' }, 'line\nbreak')).toBe('line break');
    // Arabic text with a zero-width joiner is ordinary text.
    expect(normaliseValue({ kind: 'text' }, 'شركة\u200Cالنور')).toBe('شركة\u200Cالنور');
    expect(normaliseValue({ kind: 'token' }, "SUP'; drop table x;--")).toBeNull();
    expect(normaliseValue({ kind: 'token' }, '<script>')).toBeNull();
    expect(normaliseValue({ kind: 'token' }, 'a&b=c')).toBeNull();
    expect(normaliseValue({ kind: 'token' }, '-leading')).toBeNull();
    expect(normaliseValue({ kind: 'enum', values: ['a', 'b'] }, 'c')).toBeNull();
    expect(normaliseValue({ kind: 'flag' }, 'yes')).toBeNull();
    expect(normaliseValue({ kind: 'date' }, '2026-02-30')).toBeNull();
    expect(normaliseValue({ kind: 'date' }, '2026-13-01')).toBeNull();
    expect(normaliseValue({ kind: 'date' }, '26-01-01')).toBeNull();
    expect(normaliseValue({ kind: 'date' }, '1800-01-01')).toBeNull();
    expect(normaliseValue({ kind: 'amount' }, '-5')).toBeNull();
    expect(normaliseValue({ kind: 'amount' }, '1e9')).toBeNull();
    expect(normaliseValue({ kind: 'amount' }, '1.23456')).toBeNull();
  });

  it('knows leap days', () => {
    expect(isCalendarDate('2028-02-29')).toBe(true);
    expect(isCalendarDate('2026-02-29')).toBe(false);
    expect(isCalendarDate('2100-02-29')).toBe(false);
    expect(isCalendarDate('2000-02-29')).toBe(true);
  });

  it('keeps only declared parameters, in the screen’s order, and names the invalid ones', () => {
    const { params, dropped } = sanitiseParams(route, {
      view: 'late',
      q: ' bars ',
      page: '3',
      saved: '1',
      error: 'x',
      sv: 'none',
      injected: '1; drop table',
      code: '<b>',
      in_stock: '1',
      eta_from: '2026-10-01',
    });
    expect(params).toEqual({ q: 'bars', view: 'late', in_stock: '1', eta_from: '2026-10-01' });
    expect(Object.keys(params)).toEqual(['q', 'view', 'in_stock', 'eta_from']);
    expect(dropped).toEqual([{ name: 'code', reason: 'invalid_value' }]);
  });

  it('treats a blank value as not set, and takes the first of a repeated parameter', () => {
    const { params, dropped } = sanitiseParams(route, { q: '', view: ['all', 'late'], code: '   ' });
    expect(params).toEqual({ view: 'all' });
    expect(dropped).toEqual([]);
  });

  it('builds an address in the screen’s order and compares sets by what they ask', () => {
    expect(queryOf(route, { view: 'late', q: 'a b' })).toBe('q=a+b&view=late');
    expect(hrefOf(route, {})).toBe('/payables/containers');
    expect(hrefOf(route, { view: 'all' })).toBe('/payables/containers?view=all');
    expect(sameParams(route, { q: 'x', view: 'all' }, { view: 'all', q: 'x' })).toBe(true);
    expect(sameParams(route, { view: 'all' }, { view: 'late' })).toBe(false);
  });
});

describe('SV · explicit filters and the default view', () => {
  const view = { params: { view: 'late' } };

  it('a bare arrival goes to the default; an arrival with any declared parameter does not', () => {
    expect(defaultRedirect(route, {}, view)).toBe('/payables/containers?view=late');
    expect(defaultRedirect(route, { view: 'all' }, view)).toBeNull();
    // A submitted-but-blank filter form is an explicit request to see everything.
    expect(defaultRedirect(route, { q: '' }, view)).toBeNull();
    expect(hasExplicitParams(route, { q: '' })).toBe(true);
    // The picker's "no view" marker is explicit too.
    expect(defaultRedirect(route, { sv: 'none' }, view)).toBeNull();
  });

  it('paging and the outcome of an earlier action are not filters; the outcome travels on', () => {
    expect(hasExplicitParams(route, { page: '2' })).toBe(false);
    expect(defaultRedirect(route, { saved: '1' }, view)).toBe('/payables/containers?view=late&saved=1');
    expect(defaultRedirect(route, { error: 'Nope' }, view)).toBe('/payables/containers?view=late&error=Nope');
    expect(defaultRedirect(route, { page: '4' }, view)).toBe('/payables/containers?view=late');
  });

  it('stays put when there is no default, or the default asks for nothing', () => {
    expect(defaultRedirect(route, {}, null)).toBeNull();
    expect(defaultRedirect(route, {}, { params: {} })).toBeNull();
  });

  it('chooses the owner’s default only while the screen can be opened', () => {
    const views = [
      { id: 'a', isDefault: false, available: true },
      { id: 'b', isDefault: true, available: true },
    ];
    expect(chooseDefault(views)?.id).toBe('b');
    expect(chooseDefault([{ id: 'c', isDefault: true, available: false }])).toBeNull();
    expect(chooseDefault([{ id: 'd', isDefault: false, available: true }])).toBeNull();
    expect(chooseDefault([])).toBeNull();
  });
});

describe('SV · relative dates are rules, evaluated from the business day', () => {
  it('calendar arithmetic across month, year and leap boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(monthStart('2026-10-04')).toBe('2026-10-01');
    expect(monthEnd('2026-10-04')).toBe('2026-10-31');
    expect(monthEnd('2028-02-10')).toBe('2028-02-29');
    expect(monthStart('2026-01-15', -1)).toBe('2025-12-01');
    expect(monthEnd('2026-12-15', 1)).toBe('2027-01-31');
  });

  it('every range rule, on a day mid-month', () => {
    const t = '2026-10-04';
    const at = (rule: (typeof RANGE_RULES)[number]) => evaluateRangeRule(rule, t);
    expect(at('today')).toEqual({ from: t, to: t });
    expect(at('this_month')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(at('last_month')).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(at('next_month')).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(at('next_7_days')).toEqual({ from: t, to: '2026-10-11' });
    expect(at('next_30_days')).toEqual({ from: t, to: '2026-11-03' });
    expect(at('last_7_days')).toEqual({ from: '2026-09-27', to: t });
    expect(at('last_30_days')).toEqual({ from: '2026-09-04', to: t });
    expect(at('month_to_date')).toEqual({ from: '2026-10-01', to: t });
    expect(at('year_to_date')).toEqual({ from: '2026-01-01', to: t });
    expect(at('this_year')).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    expect(at('until_today')).toEqual({ from: null, to: t });
    expect(at('from_today')).toEqual({ from: t, to: null });
    expect(RANGE_RULES.length).toBe(13);
  });

  it('the same rule on another day gives other dates — nothing is stored', () => {
    expect(evaluateRangeRule('this_month', '2026-10-31')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(evaluateRangeRule('this_month', '2026-11-01')).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(evaluateRangeRule('last_month', '2027-01-05')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
    expect(evaluateRangeRule('next_month', '2026-12-20')).toEqual({ from: '2027-01-01', to: '2027-01-31' });
    expect(evaluateRangeRule('last_month', '2028-03-10')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
  });

  it('every point rule', () => {
    const t = '2026-10-04';
    expect(POINT_RULES.map((rule) => evaluatePointRule(rule, t))).toEqual([
      '2026-10-04',
      '2026-10-01',
      '2026-10-31',
      '2026-09-30',
      '2026-01-01',
    ]);
  });
});

describe('SV · what is stored, and what is read back', () => {
  it('stores declared parameters only, as a versioned configuration', () => {
    const { stored, dropped } = storedFrom(route, { view: 'late', code: 'SUP-1', bogus: 'x', page: '9', min_amount: 'abc' });
    expect(stored).toEqual({ v: 1, params: { view: 'late', code: 'SUP-1' } });
    expect(dropped).toEqual([{ name: 'min_amount', reason: 'invalid_value' }]);
  });

  it('a chosen rule replaces the dates in the address — two answers to "which dates" are not kept', () => {
    const { stored } = storedFrom(
      route,
      { view: 'late', eta_from: '2026-01-01', eta_to: '2026-01-31', as_at: '2026-10-04' },
      { eta: 'this_month', as_at: 'keep' },
    );
    expect(stored).toEqual({ v: 1, params: { view: 'late', as_at: '2026-10-04' }, dates: { eta: 'this_month' } });
  });

  it('refuses a rule the screen does not offer, with the reason', () => {
    expect(() => storedFrom(route, {}, { eta: 'tomorrowish' })).toThrow(SavedViewInputError);
    expect(() => storedFrom(route, {}, { nope: 'this_month' })).toThrow(/not a date rule/);
    // A point rule on a range slot, and a range rule on a point slot.
    expect(() => storedFrom(route, {}, { eta: 'month_end' })).toThrow(SavedViewInputError);
    expect(() => storedFrom(route, {}, { as_at: 'next_30_days' })).toThrow(SavedViewInputError);
  });

  it('opens with the rule evaluated today and the literals as stored', () => {
    const stored = { v: 1, params: { view: 'late', q: 'steel' }, dates: { eta: 'next_30_days' } };
    expect(resolveStored(route, stored, '2026-10-04')).toEqual({
      params: { view: 'late', q: 'steel', eta_from: '2026-10-04', eta_to: '2026-11-03' },
      rules: { eta: 'next_30_days' },
      dropped: [],
    });
    expect(resolveStored(route, stored, '2026-12-20').params).toMatchObject({
      eta_from: '2026-12-20',
      eta_to: '2027-01-19',
    });
  });

  it('an open-ended rule removes the parameter it leaves open', () => {
    const stored = { v: 1, params: { eta_to: '2026-01-01' }, dates: { eta: 'from_today' } };
    expect(resolveStored(route, stored, '2026-10-04').params).toEqual({ eta_from: '2026-10-04' });
  });

  it('drops — and names — what the screen no longer accepts', () => {
    const stored = {
      v: 1,
      params: { view: 'archived', q: 'ok', old_filter: 'x', eta_from: '2026-02-30', min_amount: 5 },
      dates: { eta: 'someday', gone: 'this_month' },
    };
    const resolved = resolveStored(route, stored, '2026-10-04');
    expect(resolved.params).toEqual({ q: 'ok' });
    expect(resolved.dropped).toEqual(
      expect.arrayContaining([
        { name: 'view', reason: 'invalid_value' },
        { name: 'old_filter', reason: 'unknown_param' },
        { name: 'eta_from', reason: 'invalid_value' },
        { name: 'min_amount', reason: 'invalid_value' },
        { name: 'eta', reason: 'unknown_rule' },
        { name: 'gone', reason: 'unknown_rule' },
      ]),
    );
    expect(resolved.dropped).toHaveLength(6);
  });

  it('a configuration that cannot be read opens as nothing, and says so', () => {
    for (const bad of [null, 'x', 7, [], { v: 1 }, { v: 1, params: [] }, { v: 1, params: {}, dates: 'x' }]) {
      expect(resolveStored(route, bad, '2026-10-04')).toEqual({
        params: {},
        rules: {},
        dropped: [{ name: '*', reason: 'unreadable' }],
      });
    }
  });

  it('refuses a request to store more filters than a screen has', () => {
    const wide: ViewableRoute = {
      key: 'x.y',
      route: '/x',
      params: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`p${i}`, { kind: 'flag' as const }])),
    };
    const raw = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`p${i}`, '1']));
    expect(() => storedFrom(wide, raw)).toThrow(/at most a handful/);
  });
});

describe('SV · names', () => {
  it('trims, collapses and bounds a name', () => {
    expect(normaliseName('  Overdue   suppliers ')).toBe('Overdue suppliers');
    expect(() => normaliseName('   ')).toThrow(SavedViewInputError);
    expect(() => normaliseName('x'.repeat(81))).toThrow(/at most 80/);
    expect(normaliseName('x'.repeat(80))).toHaveLength(80);
  });

  it('finds a free name without exceeding the limit', () => {
    expect(uniqueName(new Set(), 'Mine')).toBe('Mine');
    expect(uniqueName(new Set(['Mine']), 'Mine')).toBe('Mine (2)');
    expect(uniqueName(new Set(['Mine', 'Mine (2)']), 'Mine')).toBe('Mine (3)');
    const long = 'x'.repeat(80);
    const free = uniqueName(new Set([long]), long);
    expect(free).toHaveLength(80);
    expect(free.endsWith(' (2)')).toBe(true);
  });
});
