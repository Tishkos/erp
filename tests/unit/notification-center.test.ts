/**
 * Platform phase · Agent 6 — the notification centre, the parts that need no
 * database: the dedupe key and its window, the kind registry (every kind has a
 * category and a label in both languages), the category matching the list
 * filters by, the addresses a notification may carry, the badge, the poll and
 * the relative time.
 */
import { afterEach, describe, expect, it } from 'vitest';
import en from '../../messages/en.json';
import ar from '../../messages/ar.json';
import {
  BELL_LIMIT,
  KIND_PREFIXES,
  KINDS,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_PAGE_SIZE,
  allKinds,
  badgeText,
  categoryOf,
  claimedByOthers,
  clearAddedKinds,
  dedupeKeyOf,
  isCategory,
  isLocalHref,
  isRegisteredKind,
  kindDef,
  kindKey,
  labelParams,
  matchOf,
  needsOccurrence,
  pathOf,
  pollIntervalMs,
  registerKind,
  relativeParts,
  windowToken,
} from '@domain/notification-center';
import { dedupeKeyFor, eventKeyOf } from '@domain/notifications';
import { noteText, whenText, type Words } from '../../src/components/notifications/note-text';

const today = '2026-10-04';
const userA = '11111111-1111-4111-8111-111111111111';
const userB = '22222222-2222-4222-8222-222222222222';

afterEach(() => clearAddedKinds());

describe('the dedupe key', () => {
  it('is (kind, subject, window, recipient) in one string', () => {
    expect(dedupeKeyOf({ kind: 'approval.required', objectType: 'journal_entry', objectId: 'J-1', window: '1:1', recipientUserId: userA })).toBe(
      `approval.required|journal_entry|J-1|1:1|${userA}`,
    );
  });

  it('differs by recipient, by window and by subject — and by nothing else', () => {
    const base = { kind: 'container.late', objectType: 'shipment_container', objectId: 'c1', window: '2026-09-01', recipientUserId: userA };
    const key = dedupeKeyOf(base);
    expect(dedupeKeyOf({ ...base })).toBe(key);
    expect(dedupeKeyOf({ ...base, recipientUserId: userB })).not.toBe(key);
    expect(dedupeKeyOf({ ...base, window: '2026-09-08' })).not.toBe(key);
    expect(dedupeKeyOf({ ...base, objectId: 'c2' })).not.toBe(key);
  });

  it('is the key the rule path builds, so an emit and a rule for the same event suppress each other', () => {
    const rule = dedupeKeyFor({ eventType: 'ap_invoice.overdue', objectType: 'ap_invoice', objectId: 'i1', occurrence: today }, userA);
    const emit = dedupeKeyOf({ kind: 'ap_invoice.overdue', objectType: 'ap_invoice', objectId: 'i1', window: today, recipientUserId: userA });
    expect(emit).toBe(rule);
  });

  it('keeps the recipient last so the event key is the same for everybody told', () => {
    const a = dedupeKeyOf({ kind: 'k.x', objectType: 't', objectId: 'o', window: 'w', recipientUserId: userA });
    const b = dedupeKeyOf({ kind: 'k.x', objectType: 't', objectId: 'o', window: 'w', recipientUserId: userB });
    expect(eventKeyOf(a)).toBe(eventKeyOf(b));
  });
});

describe('the window — when the same subject may be told again', () => {
  it('names the occurrence when the caller gives one', () => {
    expect(windowToken('approval.required', { occurrence: '2:1', today })).toBe('2:1');
  });

  it('a `day` kind is told once per business day', () => {
    expect(kindDef('ar_invoice.overdue').window).toBe('day');
    expect(windowToken('ar_invoice.overdue', { today })).toBe(today);
    expect(windowToken('ar_invoice.overdue', { today: '2026-10-05' })).toBe('2026-10-05');
  });

  it('a `once` kind is told once, whatever the day', () => {
    expect(kindDef('supplier_payment.made').window).toBe('once');
    expect(windowToken('supplier_payment.made', { today })).toBe('');
    expect(windowToken('supplier_payment.made', { today: '2027-01-01' })).toBe('');
  });

  it('an `occurrence` kind must say which, or the second event would be dropped as a repeat', () => {
    expect(needsOccurrence('approval.required', null)).toBe(true);
    expect(needsOccurrence('approval.required', '  ')).toBe(true);
    expect(needsOccurrence('approval.required', '1:1')).toBe(false);
    expect(needsOccurrence('ar_invoice.overdue', null)).toBe(false);
    expect(needsOccurrence('supplier_payment.made', null)).toBe(false);
  });

  it('a container is told again only for a new ETA', () => {
    expect(kindDef('container.late').window).toBe('occurrence');
    expect(needsOccurrence('container.late', null)).toBe(true);
  });
});

describe('the kind registry', () => {
  it('puts every kind in exactly one category', () => {
    const seen = new Map<string, string[]>();
    for (const category of NOTIFICATION_CATEGORIES) {
      if (category === 'system') continue;
      const m = matchOf(category);
      for (const kind of allKinds()) {
        const hit = m.exact.includes(kind) || m.prefixes.some((p) => kind.startsWith(p));
        if (hit) seen.set(kind, [...(seen.get(kind) ?? []), category]);
      }
    }
    for (const kind of allKinds()) {
      const categories = seen.get(kind) ?? [];
      // A kind no other category claims is *system*'s; anything else must be claimed by exactly its own.
      if (categoryOf(kind) === 'system') expect(categories, kind).toEqual([]);
      else expect(categories, kind).toEqual([categoryOf(kind)]);
    }
  });

  it('has a category from the list for every kind and every prefix', () => {
    for (const [kind, def] of Object.entries(KINDS)) expect(isCategory(def.category), kind).toBe(true);
    for (const [prefix, def] of Object.entries(KIND_PREFIXES)) expect(isCategory(def.category), prefix).toBe(true);
  });

  it('files an unknown kind under a family prefix, else under system', () => {
    expect(categoryOf('hr.something_new')).toBe('hr');
    expect(categoryOf('task.escalated')).toBe('tasks');
    expect(categoryOf('exception.stuck')).toBe('accounting');
    expect(categoryOf('nobody.knows')).toBe('system');
    expect(isRegisteredKind('nobody.knows')).toBe(false);
  });

  it('claims no kind twice for system: what the other categories hold is not system', () => {
    const others = claimedByOthers();
    for (const kind of allKinds()) {
      const claimed = others.exact.includes(kind) || others.prefixes.some((p) => kind.startsWith(p));
      expect(claimed, kind).toBe(categoryOf(kind) !== 'system');
    }
  });

  it('adds a kind with one registration, and the filter finds it without another edit', () => {
    expect(categoryOf('automation.rule_fired')).toBe('system');
    registerKind('automation.rule_fired', { category: 'tasks', window: 'occurrence' });
    expect(isRegisteredKind('automation.rule_fired')).toBe(true);
    expect(categoryOf('automation.rule_fired')).toBe('tasks');
    expect(matchOf('tasks').exact).toContain('automation.rule_fired');
    expect(claimedByOthers().exact).toContain('automation.rule_fired');
    clearAddedKinds();
    expect(categoryOf('automation.rule_fired')).toBe('system');
  });

  it('names the permission object a recipient needs, so a person is not told what they may not open', () => {
    expect(kindDef('ap_invoice.overdue').object).toBe('ap_invoice');
    expect(kindDef('customer_receipt.received').object).toBe('customer_receipt');
    expect(kindDef('chat.message').object).toBe('chat');
    expect(kindDef('task.assigned').object).toBe('task');
    expect(kindDef('container.late').object).toBe('shipment_container');
    // Chosen by the emitter's own rule, not by a grant: the manager of a request, the approver of a step.
    expect(kindDef('approval.required').object).toBeUndefined();
    expect(kindDef('hr.leave_lapsing').object).toBeUndefined();
  });
});

describe('every kind is labelled in both languages (no raw code on a screen)', () => {
  const labels = (catalogue: unknown) => (catalogue as { notifications: { kind: Record<string, { title?: string; detail?: string }>; category: Record<string, string> } }).notifications;

  for (const [name, catalogue] of [['en', en], ['ar', ar]] as const) {
    it(`${name}: a title for each registered kind, a name for each category`, () => {
      const bundle = labels(catalogue);
      for (const kind of Object.keys(KINDS)) {
        // Chat shows the sender, the group and the words as written: the stored text is the label.
        if (kindDef(kind).userText) continue;
        expect(bundle.kind[kindKey(kind)]?.title, `${name}: notifications.kind.${kindKey(kind)}.title`).toBeTruthy();
      }
      for (const category of NOTIFICATION_CATEGORIES) {
        expect(bundle.category[category], `${name}: notifications.category.${category}`).toBeTruthy();
      }
    });

    it(`${name}: no label for a kind that does not exist`, () => {
      const known = new Set(Object.keys(KINDS).map(kindKey));
      for (const key of Object.keys(labels(catalogue).kind)) expect(known.has(key), `${name}: notifications.kind.${key}`).toBe(true);
    });
  }

  it('the two languages have the same keys', () => {
    const keys = (o: unknown, prefix = ''): string[] =>
      Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => (v !== null && typeof v === 'object' ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
    expect(keys(labels(ar)).sort()).toEqual(keys(labels(en)).sort());
  });

  it('draws a labelled kind from its words, and an unlabelled one from the text it was raised with', () => {
    const table: Record<string, string> = {
      'kind.approval_required.title': 'Approval needed: {ref}',
      'kind.approval_required.detail': 'Waiting.',
    };
    const t = Object.assign((key: string, values?: Record<string, string | number>) => (table[key] ?? key).replace('{ref}', String(values?.ref ?? '')), {
      has: (key: string) => key in table,
    }) as unknown as Words;
    const params = labelParams({ objectId: 'x', context: { reference: 'JE-7' } });
    expect(noteText(t, { kind: 'approval.required', subject: 'stored', body: 'stored body', params, userText: false, reason: null })).toEqual({
      title: 'Approval needed: JE-7',
      detail: 'Waiting.',
      gone: false,
    });
    expect(noteText(t, { kind: 'hr.leave_lapsing', subject: 'stored', body: 'stored body', params, userText: false, reason: null })).toEqual({
      title: 'stored',
      detail: 'stored body',
      gone: false,
    });
  });

  it('says nothing but "no longer available" when the reader may not see the record', () => {
    const t = Object.assign((key: string) => key, { has: () => true }) as unknown as Words;
    const params = labelParams({ objectId: 'x', context: null });
    for (const reason of ['no_access', 'not_found'] as const) {
      const text = noteText(t, { kind: 'ap_invoice.overdue', subject: 'Invoice from ACME 1,200,000', body: 'secret', params, userText: false, reason });
      expect(text).toEqual({ title: 'gone', detail: 'gone_hint', gone: true });
    }
  });
});

describe('what a notification may link to', () => {
  it('accepts a path on this site', () => {
    expect(isLocalHref('/payables/invoices/PINV-1')).toBe(true);
    expect(isLocalHref('/chat?c=3f2a')).toBe(true);
  });

  it('refuses anything that leaves it', () => {
    for (const bad of ['https://evil.example/x', '//evil.example', 'javascript:alert(1)', '/\\evil', 'payables/x', '', '/a\nb', null, undefined, 42]) {
      expect(isLocalHref(bad), String(bad)).toBe(false);
    }
  });

  it('reads the path without its query or fragment', () => {
    expect(pathOf('/hr/requests/ECLM-1?tab=lines#top')).toBe('/hr/requests/ECLM-1');
    expect(pathOf('/approvals')).toBe('/approvals');
  });
});

describe('the bell', () => {
  it('shows 1–99 and then 99+', () => {
    expect(badgeText(0)).toBe('0');
    expect(badgeText(7)).toBe('7');
    expect(badgeText(99)).toBe('99');
    expect(badgeText(100)).toBe('99+');
    expect(badgeText(-3)).toBe('0');
  });

  it('polls a visible tab every 30 s, a hidden one every two minutes, and backs off on failures to five minutes', () => {
    expect(pollIntervalMs({ visible: true, failures: 0 })).toBe(30_000);
    expect(pollIntervalMs({ visible: false, failures: 0 })).toBe(120_000);
    expect(pollIntervalMs({ visible: true, failures: 1 })).toBe(60_000);
    expect(pollIntervalMs({ visible: true, failures: 2 })).toBe(120_000);
    expect(pollIntervalMs({ visible: true, failures: 9 })).toBe(300_000);
  });

  it('lists a short page in the popover and fifty on the screen', () => {
    expect(BELL_LIMIT).toBeLessThanOrEqual(20);
    expect(NOTIFICATION_PAGE_SIZE).toBe(50);
  });

  it('says how long ago in the largest whole unit, never in the future', () => {
    const now = new Date('2026-10-04T12:00:00Z');
    expect(relativeParts(new Date('2026-10-04T11:59:30Z'), now)).toEqual({ value: 30, unit: 'second' });
    expect(relativeParts(new Date('2026-10-04T11:55:00Z'), now)).toEqual({ value: 5, unit: 'minute' });
    expect(relativeParts(new Date('2026-10-04T09:00:00Z'), now)).toEqual({ value: 3, unit: 'hour' });
    expect(relativeParts(new Date('2026-10-01T12:00:00Z'), now)).toEqual({ value: 3, unit: 'day' });
    expect(relativeParts(new Date('2026-09-13T12:00:00Z'), now)).toEqual({ value: 3, unit: 'week' });
    expect(relativeParts(new Date('2026-07-04T12:00:00Z'), now)).toEqual({ value: 3, unit: 'month' });
    expect(relativeParts(new Date('2023-10-04T12:00:00Z'), now)).toEqual({ value: 3, unit: 'year' });
    expect(relativeParts(new Date('2026-10-04T12:05:00Z'), now)).toEqual({ value: 0, unit: 'second' });
  });

  it('writes the relative time and, for the hover, the exact moment in the books time zone', () => {
    const now = new Date('2026-10-04T12:00:00Z');
    const when = whenText('2026-10-04T11:55:00Z', now, 'en', 'Asia/Baghdad');
    expect(when.relative).toMatch(/5 minutes ago/);
    // 11:55 UTC is 14:55 in Baghdad (UTC+3).
    expect(when.absolute).toMatch(/2:55/);
    const arabic = whenText('2026-10-04T11:55:00Z', now, 'ar', 'Asia/Baghdad');
    expect(arabic.relative).not.toMatch(/minutes ago/);
    expect(arabic.relative.length).toBeGreaterThan(0);
  });
});

describe('the facts a label may use', () => {
  it('reads the reference, the party, the days and the amount from what the event carried', () => {
    expect(
      labelParams({
        objectId: 'row-id',
        context: { reference: 'PINV-9', party: 'ACME (S-1)', days_overdue: 12, outstanding: '1,200', due_date: '2026-09-22' },
      }),
    ).toMatchObject({ ref: 'PINV-9', party: 'ACME (S-1)', days: 12, amount: '1,200', date: '2026-09-22' });
  });

  it('falls back to the subject id for the reference, and zero for what is not a number', () => {
    const params = labelParams({ objectId: 'JE-4', context: { days: 'soon' } });
    expect(params.ref).toBe('JE-4');
    expect(params.days).toBe(0);
    expect(params.party).toBe('');
  });
});
