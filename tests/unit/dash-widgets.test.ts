/**
 * Home's widget registry — platform phase, Agent 2.
 *
 * The registry is data, so what a person sees can be read off it without a
 * browser: every widget declares what it needs, nothing in it knows an e-mail
 * address or a user id, a person without the grants gets none of that family's
 * widgets, and two different capability sets get visibly different pages.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DATA_FAMILIES,
  FAMILY_ANCHORS,
  QUICK_ACTIONS,
  QUICK_ACTION_LIMIT,
  WIDGETS,
  composeFor,
  holdsCapability,
  rankFamilies,
  unavailableFamilies,
  widgetByKey,
  widgetVisible,
  type CapabilityFamily,
  type WidgetDefinition,
} from '@domain/dashboard-widgets';
import type { Principal, PermissionVerb } from '@domain/permissions';

function principal(overrides: Partial<Principal> = {}): Principal {
  return { userId: 'u-1', isSuperUser: false, isActive: true, roleCodes: [], grants: [], branchCodes: ['HQ'], departments: [], ...overrides };
}

/** A person holding `view` on each object (and any extra verbs). */
function holding(objects: readonly string[], extra: readonly { verb: PermissionVerb; object: string }[] = [], roles: readonly string[] = []): Principal {
  return principal({
    roleCodes: roles,
    grants: [...objects.map((object) => ({ verb: 'view' as const, object })), ...extra],
  });
}

const keys = (list: readonly WidgetDefinition[]) => list.map((widget) => widget.key);
const everyone = [...FAMILY_ANCHORS.finance, ...FAMILY_ANCHORS.receivables, ...FAMILY_ANCHORS.payables];

describe('the registry declares what each widget needs', () => {
  it('has unique keys', () => {
    const all = WIDGETS.map((widget) => widget.key);
    expect(new Set(all).size).toBe(all.length);
  });

  it('gives every widget of a data family at least one requirement', () => {
    for (const widget of WIDGETS as readonly WidgetDefinition[]) {
      if (!(DATA_FAMILIES as readonly string[]).includes(widget.family)) continue;
      const declared = widget.requires.length + (widget.requiresAny?.length ?? 0);
      expect(declared, `${widget.key} (${widget.family}) shows to everybody`).toBeGreaterThan(0);
    }
  });

  it('lets only the slots and the person\'s own things stand without a requirement', () => {
    const open = (WIDGETS as readonly WidgetDefinition[]).filter((w) => w.requires.length === 0 && !w.requiresAny?.length && !w.capability);
    expect(keys(open).sort()).toEqual(['attention', 'list_pinned_views']);
  });

  it('names no e-mail address, user id or person anywhere in the registry', () => {
    const text = JSON.stringify([WIDGETS, QUICK_ACTIONS, FAMILY_ANCHORS]);
    expect(text).not.toMatch(/@/);
    expect(text.toLowerCase()).not.toMatch(/email|user_?id|example\.com|officer|manager@|ceo@/);
    const source = readFileSync(resolve(__dirname, '../../src/server/domain/dashboard-widgets.ts'), 'utf8');
    // Code, not commentary: no comparison against an identity.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/email|\.userId\s*===|\.userId\s*!==|'[0-9a-f]{8}-[0-9a-f]{4}/i);
  });

  it('looks widgets up by key', () => {
    expect(widgetByKey('cash_position')?.family).toBe('finance');
    expect(widgetByKey('nope')).toBeUndefined();
  });
});

describe('a person with no grant gets nothing of that family', () => {
  it('shows the outsider no widget but the two that hide themselves when empty, and says every data family is unavailable', () => {
    const nobody = principal();
    const page = composeFor(nobody);
    expect([...page.kpi, ...page.chart]).toEqual([]);
    expect(keys(page.list)).toEqual(['attention', 'list_pinned_views']);
    expect(page.list.every((widget) => widget.hideWhenEmpty)).toBe(true);
    expect(page.quickActions).toEqual([]);
    expect([...page.unavailable]).toEqual([...DATA_FAMILIES]);
    expect(rankFamilies(nobody).map((f) => f.family)).toEqual(['employee']);
  });

  it('shows an inactive account nothing', () => {
    const gone = principal({ isActive: false, grants: [{ verb: 'view', object: 'ar_invoice' }] });
    const page = composeFor(gone);
    expect([...page.kpi, ...page.chart, ...page.list]).toEqual([]);
    expect(rankFamilies(gone)).toEqual([]);
  });

  it('gives none of Sales to a person who cannot view an invoice', () => {
    const page = composeFor(holding(['bank_account']));
    const all = [...page.kpi, ...page.chart, ...page.list];
    expect(all.some((widget) => widget.family === 'sales' || widget.family === 'receivables')).toBe(false);
    expect(page.unavailable).toContain('sales');
    expect(page.unavailable).toContain('receivables');
    expect(page.unavailable).not.toContain('finance');
  });

  it('refuses a widget when one of several requirements is missing', () => {
    const half = holding(['payable']); // imports need the container grant too
    expect(widgetVisible(half, widgetByKey('imports_in_progress')!)).toBe(false);
    expect(widgetVisible(holding(['payable', 'shipment_container']), widgetByKey('imports_in_progress')!)).toBe(true);
  });

  it('honours requiresAny', () => {
    const findings = widgetByKey('list_findings')!;
    expect(widgetVisible(holding(['item']), findings)).toBe(false);
    expect(widgetVisible(holding(['bank_account']), findings)).toBe(true);
    expect(widgetVisible(holding(['customer_receipt']), findings)).toBe(true);
  });
});

describe('capabilities are what a person is, not who they are', () => {
  it('management is the CEO role', () => {
    expect(holdsCapability(principal({ roleCodes: ['ceo'] }), 'management')).toBe(true);
    expect(holdsCapability(principal({ roleCodes: ['accounting_manager'] }), 'management')).toBe(false);
    expect(holdsCapability(principal({ roleCodes: ['ceo'], isActive: false }), 'management')).toBe(false);
  });

  it('an approver is anyone an approval can wait on', () => {
    expect(holdsCapability(principal(), 'approver')).toBe(false);
    // Seeing one's own submissions on My Approvals is not being someone a decision waits for.
    expect(holdsCapability(holding(['workflow_instance']), 'approver')).toBe(false);
    expect(holdsCapability(holding([], [{ verb: 'approve', object: 'purchase_order' }]), 'approver')).toBe(true);
    expect(holdsCapability(principal({ departments: [{ code: 'FIN', isManager: true }] }), 'approver')).toBe(true);
    expect(holdsCapability(principal({ departments: [{ code: 'FIN', isManager: false }] }), 'approver')).toBe(false);
    expect(holdsCapability(principal({ isSuperUser: true }), 'approver')).toBe(true);
  });

  it('an assigner may give work to someone', () => {
    expect(holdsCapability(holding(['task']), 'assigner')).toBe(false);
    expect(holdsCapability(holding([], [{ verb: 'submit', object: 'task' }]), 'assigner')).toBe(true);
  });

  it('keeps the management widgets from everybody but management', () => {
    const grants = holding(['ar_invoice', 'ap_invoice', 'payable', 'audit_event']);
    const plain = composeFor(grants);
    const ceo = composeFor({ ...grants, roleCodes: ['ceo'] });
    expect(keys(plain.kpi)).not.toContain('overdue_receivables');
    expect(keys(ceo.kpi)).toContain('overdue_receivables');
    expect(keys(plain.list)).not.toContain('list_major_imports');
    expect(keys(ceo.list)).toContain('list_major_imports');
  });
});

describe('composition per capability set', () => {
  const accounting = holding([...FAMILY_ANCHORS.finance, 'ar_invoice', 'ap_invoice', 'payable', 'payment_application', 'customer_receipt']);
  const logistics = holding(['payable', 'shipment_container', 'bill_of_lading', 'customs_pd', 'customs_declaration', 'in_transit', 'task', 'notification', 'chat']);
  const warehouse = holding(['inventory_movement', 'stock_movement', 'warehouse', 'item', 'task']);

  it('leads each page with its own family', () => {
    expect(rankFamilies(accounting)[0]!.family).toBe('finance');
    expect(rankFamilies(logistics)[0]!.family).toBe('logistics');
    expect(rankFamilies(warehouse)[0]!.family).toBe('inventory');
  });

  it('ranks a family by the share of it the person holds', () => {
    const ranked = rankFamilies(holding(['bank_account', ...FAMILY_ANCHORS.logistics]));
    expect(ranked[0]!.family).toBe('logistics');
    expect(ranked.find((f) => f.family === 'finance')).toMatchObject({ held: 1, of: FAMILY_ANCHORS.finance.length });
  });

  it('lets what waits on the person and what is wrong lead their zone', () => {
    const manager = holding([...FAMILY_ANCHORS.finance], [{ verb: 'approve', object: 'journal_entry' }]);
    const c = composeFor(manager);
    expect(keys(c.kpi)[0]).toBe('approvals_waiting');
    expect(keys(c.list).slice(0, 2)).toEqual(['attention', 'list_approvals']);
  });

  it('puts management first for the CEO', () => {
    const ranked = rankFamilies({ ...accounting, roleCodes: ['ceo'] }).map((f) => f.family);
    expect(ranked[0]).toBe('management');
    // ...and reads the rest in the declared order, money first.
    expect(ranked.slice(1, 3)).toEqual(['finance', 'receivables']);
  });

  it('draws logistics widgets for the logistics person and none for the warehouse person', () => {
    const l = composeFor(logistics);
    const w = composeFor(warehouse);
    expect(keys(l.kpi)).toContain('imports_in_progress');
    expect(keys(l.chart)).toContain('chart_import_stages');
    expect(keys(l.list)).toEqual(expect.arrayContaining(['list_delayed_containers', 'list_customs_actions']));
    expect(keys(w.kpi)).not.toContain('imports_in_progress');
    expect(keys(w.kpi)).toContain('warehouse_today');
    expect(keys(w.kpi)).toContain('inventory_value');
  });

  it('does not offer the warehouse person a finance widget, nor the accountant a stock one', () => {
    const w = composeFor(warehouse);
    const a = composeFor(accounting);
    expect([...w.kpi, ...w.chart, ...w.list].some((x) => x.family === 'finance')).toBe(false);
    expect([...a.kpi, ...a.chart, ...a.list].some((x) => x.family === 'inventory' || x.family === 'logistics')).toBe(false);
  });

  it('produces three different pages for three capability sets', () => {
    const pages = [accounting, logistics, warehouse].map((p) => {
      const c = composeFor(p);
      return [...c.kpi, ...c.chart, ...c.list].map((x) => x.key).join(',');
    });
    expect(new Set(pages).size).toBe(3);
  });

  it('orders widgets inside a zone by family rank, then weight, then key', () => {
    const c = composeFor(accounting);
    const rank = new Map<CapabilityFamily, number>(c.families.map((f, i) => [f.family, i]));
    for (const zone of [c.kpi, c.chart, c.list]) {
      for (let i = 1; i < zone.length; i += 1) {
        const a = zone[i - 1]!;
        const b = zone[i]!;
        const ra = a.lead ? -1 : (rank.get(a.family) ?? 99);
        const rb = b.lead ? -1 : (rank.get(b.family) ?? 99);
        expect(ra < rb || (ra === rb && (a.weight > b.weight || (a.weight === b.weight && a.key < b.key)))).toBe(true);
      }
    }
  });

  it('shows a super user every data family and everything but the management capability', () => {
    const root = principal({ isSuperUser: true });
    const c = composeFor(root);
    expect(c.unavailable).toEqual([]);
    expect(keys(c.kpi)).toContain('cash_position');
    expect(keys(c.kpi)).not.toContain('overdue_receivables');
  });

  it('offers at most five quick actions, only for screens the shell serves', () => {
    const root = principal({ isSuperUser: true });
    expect(composeFor(root).quickActions.length).toBeLessThanOrEqual(QUICK_ACTION_LIMIT);
    const none = composeFor(root, () => false);
    expect(none.quickActions).toEqual([]);
    const some = composeFor(root, (route) => route === '/tasks');
    expect(some.quickActions.every((a) => a.href === '/tasks')).toBe(true);
  });

  it('offers Assign Task only to someone who may give work', () => {
    const asker = holding(['task'], [{ verb: 'submit', object: 'task' }]);
    expect(composeFor(asker).quickActions.map((a) => a.key)).toContain('assign_task');
    expect(composeFor(holding(['task'])).quickActions.map((a) => a.key)).not.toContain('assign_task');
  });

  it('computes the unavailable families from the anchors held', () => {
    expect(unavailableFamilies(holding(everyone))).toContain('logistics');
    expect(unavailableFamilies(holding(everyone))).not.toContain('finance');
    expect(unavailableFamilies(holding(everyone))).not.toContain('payables');
  });
});
