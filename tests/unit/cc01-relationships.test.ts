/**
 * Related records — the pure parts (platform phase, Agent 9): which steps a viewer may see, when "not yet" is
 * honest, how a step is cut, and that every step, kind and note the graph can show has wording in both
 * languages. The chains on a real database, with hidden nodes, are `tests/integration/cc01-relationships.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STAGE_SOURCES } from '@/server/domain/import-journey';
import type { Principal } from '@/server/domain/permissions';
import {
  FETCH_LIMIT,
  NODE_CAP,
  ROOT,
  ROOT_KINDS,
  ROOT_OBJECT,
  SOURCE_DOCUMENT_OBJECT,
  STEPS,
  countsOf,
  isRootKind,
  relationshipsHref,
  shape,
  stateOf,
  stepKey,
  stepOf,
  stepsOf,
  toneOf,
  visibleSteps,
} from '@/server/domain/relationships';
import { documentHref } from '@/components/admin/document-link';
import { menuObjects } from '@/server/domain/menu';
import ar from '../../messages/ar.json';
import en from '../../messages/en.json';

const principal = (objects: readonly string[], over: Partial<Principal> = {}): Principal => ({
  userId: 'u1',
  isSuperUser: false,
  isActive: true,
  roleCodes: [],
  grants: objects.map((object) => ({ object, verb: 'view' as const })),
  branchCodes: ['HQ'],
  defaultBranchCode: 'HQ',
  departments: [],
  ...over,
});

describe('the chains', () => {
  it('has the four roots, each with its chain, in the order the brief draws them', () => {
    expect([...ROOT_KINDS]).toEqual(['import', 'supplier', 'customer', 'item']);
    expect(stepsOf('import').map((step) => step.code)).toEqual([
      'import.invoice', 'import.bl', 'import.container', 'import.customs', 'import.declaration',
      'import.landed_cost', 'import.receipt', 'import.inventory', 'import.layer',
    ]);
    expect(stepsOf('supplier').map((step) => step.code)).toEqual([
      'supplier.purchase_order', 'supplier.goods_receipt', 'supplier.invoice', 'supplier.payment', 'supplier.statement', 'supplier.ageing',
    ]);
    expect(stepsOf('customer').map((step) => step.code)).toEqual([
      'customer.invoice', 'customer.receipt', 'customer.credit', 'customer.return', 'customer.statement', 'customer.ageing',
    ]);
    expect(stepsOf('item').map((step) => step.code)).toEqual(['item.warehouse', 'item.layer', 'item.movement', 'item.document']);
    expect(isRootKind('import')).toBe(true);
    expect(isRootKind('payable')).toBe(false);
  });

  it('names permission objects someone can hold, and only steps that exist as prerequisites', () => {
    const objects = new Set(menuObjects());
    const codes = new Set(STEPS.map((step) => step.code));
    for (const step of STEPS) {
      expect(step.requires.length, step.code).toBeGreaterThan(0);
      for (const object of step.requires) expect(objects.has(object), `${step.code}: ${object}`).toBe(true);
      for (const before of step.after) expect(before === ROOT || (codes.has(before) && before.split('.')[0] === step.chain), `${step.code} after ${before}`).toBe(true);
    }
    for (const kind of ROOT_KINDS) expect(objects.has(ROOT_OBJECT[kind]), kind).toBe(true);
  });

  it('reuses the Home import journey for the steps that are its stages', () => {
    expect(stepOf('import.bl')!.requires).toEqual(STAGE_SOURCES.bl);
    expect(stepOf('import.container')!.requires).toEqual(STAGE_SOURCES.container);
    expect(stepOf('import.customs')!.requires).toEqual(STAGE_SOURCES.customs);
    expect(stepOf('import.landed_cost')!.requires).toEqual(STAGE_SOURCES.landed_cost);
    expect(stepOf('import.receipt')!.requires).toEqual(STAGE_SOURCES.receipt);
    expect(stepOf('import.inventory')!.requires).toEqual(STAGE_SOURCES.inventory);
  });

  it('never has a step that depends on a step of another chain, or on itself', () => {
    for (const step of STEPS) expect(step.after).not.toContain(step.code);
  });
});

describe('who sees which step', () => {
  it('draws only the steps whose every source the viewer may open', () => {
    const none = principal([]);
    expect(visibleSteps('import', none)).toEqual([]);

    const shipping = principal(['ap_invoice', 'bill_of_lading', 'shipment_container']);
    expect(visibleSteps('import', shipping).map((step) => step.code)).toEqual(['import.invoice', 'import.bl', 'import.container', 'import.receipt']);

    // One of two grants is not enough: the step is absent, not empty.
    const half = principal(['inventory_movement']);
    expect(visibleSteps('import', half)).toEqual([]);
    expect(visibleSteps('import', principal(['inventory_movement', 'landed_cost_register'])).map((step) => step.code)).toEqual([
      'import.landed_cost', 'import.inventory', 'import.layer',
    ]);
  });

  it('shows a Super User every step and an inactive person none', () => {
    expect(visibleSteps('customer', principal([], { isSuperUser: true })).length).toBe(stepsOf('customer').length);
    expect(visibleSteps('customer', principal(['ar_invoice'], { isActive: false }))).toEqual([]);
  });

  it('keeps a stock movement document to the viewer who holds that document own grant', () => {
    expect(visibleSteps('item', principal(['stock_movement'])).map((step) => step.code)).toEqual(['item.movement', 'item.document']);
    for (const [type, object] of Object.entries(SOURCE_DOCUMENT_OBJECT)) {
      expect(object, type).toBeTruthy();
      expect(menuObjects().includes(object), `${type}: ${object}`).toBe(true);
    }
    // Every document the Stock Movement page can link to has its grant named.
    for (const type of ['ap_invoice', 'supplier_shipment', 'ar_invoice', 'sales_return', 'goods_return', 'opening_stock', 'stock_transfer', 'stock_adjustment']) {
      expect(documentHref(type, 'X-1'), type).not.toBeNull();
      expect(SOURCE_DOCUMENT_OBJECT[type], type).toBeTruthy();
    }
  });
});

describe('"not yet" is a fact about the process', () => {
  const invoice = stepOf('import.invoice')!;
  const bl = stepOf('import.bl')!;
  const container = stepOf('import.container')!;
  const landed = stepOf('import.landed_cost')!;
  const statement = stepOf('supplier.statement')!;

  it('draws a step with records as present', () => {
    expect(stateOf(bl, 2, {}, true)).toBe('present');
    expect(stateOf(bl, 1, {}, false)).toBe('present');
  });

  it('is pending only when the step before it has records and the chain can still go on', () => {
    expect(stateOf(invoice, 0, {}, true)).toBe('pending'); // the application is always there
    expect(stateOf(bl, 0, { 'import.invoice': 1 }, true)).toBe('pending');
    expect(stateOf(bl, 0, { 'import.invoice': 0 }, true)).toBeNull();
    expect(stateOf(container, 0, { 'import.invoice': 1 }, true)).toBeNull(); // no B/L yet: containers are not "not yet", they are not applicable
    expect(stateOf(container, 0, { 'import.bl': 1 }, true)).toBe('pending');
  });

  it('leaves out what a cancelled or closed import will never do', () => {
    expect(stateOf(invoice, 0, {}, false)).toBeNull();
    expect(stateOf(bl, 0, { 'import.invoice': 3 }, false)).toBeNull();
  });

  it('waits on landed cost only for receipts', () => {
    expect(stateOf(landed, 0, { 'import.container': 2 }, true)).toBeNull();
    expect(stateOf(landed, 0, { 'import.receipt': 1 }, true)).toBe('pending');
  });

  it('never draws "not yet" for a step with no predecessor (a statement exists or it does not)', () => {
    expect(stateOf(statement, 0, {}, true)).toBeNull();
    expect(stateOf(stepOf('item.layer')!, 0, {}, true)).toBeNull();
  });

  it('cannot be made to pend by a step the viewer does not see', () => {
    // A hidden step is not a key of the counts, so it neither draws nor justifies another.
    expect(stateOf(container, 0, countsOf(new Map([['import.invoice', 4]])), true)).toBeNull();
  });
});

describe('shape and presentation', () => {
  it('draws the first records and counts the rest', () => {
    const records = Array.from({ length: NODE_CAP + 4 }, (_, n) => n);
    expect(shape(records, false)).toEqual({ nodes: records.slice(0, NODE_CAP), more: 4, truncated: false });
    expect(shape([1, 2], true)).toEqual({ nodes: [1, 2], more: 0, truncated: true });
    expect(FETCH_LIMIT).toBeGreaterThan(NODE_CAP);
  });

  it('tones a status with a chip the application has', () => {
    expect(toneOf('posted')).toBe('approved');
    expect(toneOf('cleared')).toBe('approved');
    expect(toneOf('submitted')).toBe('submitted');
    expect(toneOf('reversed')).toBe('rejected');
    expect(toneOf('draft')).toBe('draft');
    expect(toneOf(null)).toBe('draft');
    expect(toneOf('something_else')).toBe('draft');
  });

  it('addresses the chain page by kind and key, encoded', () => {
    expect(relationshipsHref('supplier', 'SUP 1/2')).toBe('/control-center/relationships?type=supplier&id=SUP%201%2F2');
    expect(stepKey('import.landed_cost')).toBe('import_landed_cost');
  });
});

describe('wording, in both languages', () => {
  type Tree = { [key: string]: string | Tree };
  const sub = (messages: unknown) => (messages as { admin: { relationships: Tree } }).admin.relationships;
  const read = (path: string[], messages: unknown): unknown => path.reduce<unknown>((node, key) => (node as Tree)?.[key], sub(messages));

  it('words every step, root kind, unnamed node and status', () => {
    for (const language of [en, ar]) {
      for (const step of STEPS) expect(read(['step', stepKey(step.code)], language), step.code).toBeTruthy();
      for (const kind of ROOT_KINDS) expect(read(['kind', kind], language), kind).toBeTruthy();
      for (const node of ['statement', 'ageing', 'landed_cost_lock', 'cost_layer']) expect(read(['node', node], language), node).toBeTruthy();
      for (const status of ['accepted', 'assessed', 'cleared']) expect(read(['status', status], language), status).toBeTruthy();
    }
  });

  it('words every note the service produces', () => {
    const service = readFileSync(join(process.cwd(), 'src/server/services/relationships.ts'), 'utf8');
    const notes = new Set([...service.matchAll(/\bnote\('([a-z_]+)'/g)].map((match) => match[1]!));
    expect(notes.size).toBeGreaterThan(8);
    for (const language of [en, ar]) for (const key of notes) expect(read(['note', key], language), key).toBeTruthy();
  });

  it('words the unnamed nodes the service produces (a node without a label is named by its kind)', () => {
    const service = readFileSync(join(process.cwd(), 'src/server/services/relationships.ts'), 'utf8');
    // A node built without a `label:` line is one the page names by kind; list the kinds the service builds so.
    const kinds = new Set<string>();
    for (const block of service.split('node({').slice(1)) {
      const body = block.slice(0, block.indexOf('}),') === -1 ? 400 : block.indexOf('}),'));
      const kind = /kind:\s*'([a-z_]+)'/.exec(body)?.[1];
      if (kind && !/\blabel:/.test(body)) kinds.add(kind);
    }
    expect([...kinds].sort()).toEqual(['ageing', 'cost_layer', 'landed_cost_lock', 'statement']);
  });
});
