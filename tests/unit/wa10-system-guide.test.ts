/**
 * Noah for everybody — the system guide, the menu, the issues list and the
 * wider actions (2026-10-04, by direction: "make the AI agent explain
 * everything for all users … very good in the navbar, step by step where to
 * go, and explain the fields; if they have issues, save the issues in an md
 * file; help them doing actions").
 *
 * Everything here is the pure half — no database, no files.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MENU } from '@domain/menu';
import { MODULES } from '@domain/modules';
import type { Principal } from '@domain/permissions';
import {
  ISSUES_HEADER,
  chunkGuide,
  describeScreens,
  findScreens,
  fold,
  guideContents,
  issueBlock,
  nextIssueId,
  recentIssues,
  screenCatalogue,
  searchGuide,
  searchWords,
  type MenuLabels,
} from '@domain/system-guide';
import {
  ACTION_NAMES,
  DOCUMENT_FAMILIES,
  DOCUMENT_STEPS,
  STEPS_NEEDING_REASON,
  actionLabel,
  familyOf,
  stepConsequence,
  tidyNumber,
} from '@domain/whatsapp-do';
import { AGENT_TOOLS } from '@domain/whatsapp-agent';

type Catalogue = { shell: { module: Record<string, string> }; nav: Record<string, string>; page: Record<string, string> };
const read = (locale: 'en' | 'ar'): MenuLabels => {
  const catalogue = JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8')) as Catalogue;
  return { module: catalogue.shell.module, heading: catalogue.nav, screen: catalogue.page };
};
const en = read('en');
const ar = read('ar');

const principal = (over: Partial<Principal> = {}): Principal =>
  ({
    userId: '00000000-0000-0000-0000-000000000001',
    isActive: true,
    isSuperUser: true,
    roleCodes: [],
    grants: [],
    branchCodes: ['HQ'],
    defaultBranchCode: 'HQ',
    ...over,
  }) as unknown as Principal;

const all = screenCatalogue({ principal: principal(), en, ar });

describe('the menu Noah reads is the menu the top bar draws', () => {
  it('names every module and every heading in both languages', () => {
    for (const module of MODULES) {
      expect(en.module[module.key], `shell.module.${module.key} (en)`).toBeTruthy();
      expect(ar.module[module.key], `shell.module.${module.key} (ar)`).toBeTruthy();
      for (const key of module.sectionKeys) {
        expect(MENU.some((section) => section.key === key), `section ${key}`).toBe(true);
        expect(en.heading[key], `nav.${key} (en)`).toBeTruthy();
        expect(ar.heading[key], `nav.${key} (ar)`).toBeTruthy();
      }
    }
  });

  it('gives every screen a name in both languages, never its key', () => {
    for (const entry of all) {
      expect(entry.en.screen, `page.${entry.itemKey} (en)`).not.toBe(entry.itemKey);
      expect(entry.ar.screen, `page.${entry.itemKey} (ar)`).not.toBe(entry.itemKey);
    }
  });

  it('finds a screen by its English name, its Arabic name, or part of either', () => {
    const suppliers = findScreens(all, 'suppliers')[0]!;
    expect(suppliers.route).toBe('/payables/suppliers');
    // Master Data — Financial's since 2026-10-06, at the old address (D-FX-1).
    expect(suppliers.en).toEqual({ module: en.module.accounting, heading: en.heading.master_data, screen: en.screen.suppliers });

    const arabic = findScreens(all, ar.screen.ap_invoices!)[0]!;
    expect(arabic.route).toBe('/payables/invoices');

    expect(findScreens(all, 'purchase invoice').map((entry) => entry.route)).toContain('/payables/invoices');
    expect(findScreens(all, 'trial balance')[0]!.route).toBe('/finance/trial-balance');
    expect(findScreens(all, 'zzzz-no-such-screen')).toEqual([]);
  });

  it('says the path as module → heading → screen, in both languages, with the address', () => {
    const text = describeScreens(all, { baseUrl: 'https://erp.example', search: 'suppliers' });
    expect(text).toContain(`${en.module.accounting} → ${en.heading.master_data} → ${en.screen.suppliers}`);
    expect(text).toContain(`${ar.module.accounting} ← ${ar.heading.master_data} ← ${ar.screen.suppliers}`);
    expect(text).toContain('https://erp.example/payables/suppliers');
  });

  it('marks a screen that is not built, and one the person may not open', () => {
    const unbuilt = describeScreens(all, { baseUrl: '', search: 'sales orders' });
    expect(unbuilt).toMatch(/NOT BUILT YET/);

    const clerk = screenCatalogue({ principal: principal({ isSuperUser: false, grants: [{ object: 'item', verb: 'view' }] as never }), en, ar });
    expect(clerk.find((entry) => entry.itemKey === 'items')!.allowed).toBe(true);
    expect(clerk.find((entry) => entry.itemKey === 'trial_balance')!.allowed).toBe(false);
    expect(describeScreens(clerk, { baseUrl: '', search: 'trial balance' })).toMatch(/role cannot open it/);
  });

  it('with no search, lays out the whole top bar — the built screens under their headings', () => {
    const text = describeScreens(all, { baseUrl: '' });
    for (const module of ['payables', 'sales', 'inventory', 'hr', 'settings'] as const) expect(text).toContain(en.module[module]!);
    expect(text).toContain(`${en.screen.suppliers} (${ar.screen.suppliers})`);
    expect(text.length).toBeLessThan(12_000); // what the loop hands the model in one piece
  });
});

describe('matching is forgiving, in both scripts', () => {
  it('folds case, Arabic marks and the letters people type interchangeably', () => {
    expect(fold('Purchase  INVOICES')).toBe('purchase invoices');
    expect(fold('الذِّمم الدائنة')).toBe(fold('الذمم الدائنه'));
    expect(fold('إعدادات')).toBe(fold('اعدادات'));
  });

  it('drops the words that carry nothing', () => {
    expect(searchWords('how do I create a purchase invoice?')).toEqual(['create', 'purchase', 'invoice']);
    expect(searchWords('وين فاتورة الشراء')).toEqual([fold('فاتورة'), fold('الشراء')]);
  });
});

const GUIDE = `# Payables — user guide
Overview text.

## Purchase Invoices (فواتير الشراء)
Path: Payables → Purchasing & Invoices → Purchase Invoices
Address: /payables/invoices
Needs: view on ap_invoice
What it is for: recording what a supplier billed.

### How to create an invoice — Purchase Invoices
1. Open the screen.
2. Press **New invoice** (فاتورة جديدة).

### Fields — Purchase Invoices
- **Supplier** (المورد) — who billed; required.
- **Due date** (تاريخ الاستحقاق) — when it must be paid.

### Refusals — Purchase Invoices
- "is prospect, so a purchase order cannot be raised" — approve the supplier first.

## Suppliers (الموردون)
Path: Payables → Supplier Balances → Suppliers
Address: /payables/suppliers
What it is for: the supplier master.

\`\`\`
## not a heading: inside a code fence
\`\`\`
`;

describe('the written guide is read a block at a time', () => {
  const chunks = chunkGuide('guide/payables.md', GUIDE);

  it('makes every ## and ### its own block, and a sub-block remembers where its screen is', () => {
    expect(chunks.map((chunk) => chunk.title)).toEqual([
      'Purchase Invoices (فواتير الشراء)',
      'How to create an invoice — Purchase Invoices',
      'Fields — Purchase Invoices',
      'Refusals — Purchase Invoices',
      'Suppliers (الموردون)',
    ]);
    const fields = chunks.find((chunk) => chunk.title.startsWith('Fields'))!;
    expect(fields.parent).toBe('Purchase Invoices (فواتير الشراء)');
    expect(fields.context).toContain('Path: Payables → Purchasing & Invoices → Purchase Invoices');
    expect(fields.context).toContain('Address: /payables/invoices');
  });

  it('answers a how-to with the block whose heading says it, path and all', () => {
    const text = searchGuide(chunks, 'purchase invoice create');
    expect(text.indexOf('How to create an invoice')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('How to create an invoice')).toBeLessThan(text.indexOf('Suppliers (الموردون)') === -1 ? Infinity : text.indexOf('Suppliers (الموردون)'));
    expect(text).toContain('Press **New invoice**');
    expect(text).toContain('Path: Payables → Purchasing & Invoices → Purchase Invoices');
  });

  it('finds a field, a refusal, and an Arabic label', () => {
    expect(searchGuide(chunks, 'purchase invoice fields due date')).toContain('when it must be paid');
    expect(searchGuide(chunks, 'prospect refused')).toContain('approve the supplier first');
    expect(searchGuide(chunks, 'الموردون')).toContain('the supplier master');
  });

  it('lists what it covers when asked nothing, and says so when nothing matches', () => {
    expect(guideContents(chunks)).toContain('Purchase Invoices (فواتير الشراء)');
    expect(searchGuide(chunks, '')).toContain('The guide covers');
    expect(searchGuide(chunks, 'xylophone')).toMatch(/Nothing in the guide matches/);
    expect(searchGuide([], 'anything')).toMatch(/not installed/);
  });

  it('keeps an answer to a size the model reads in one piece', () => {
    const long = chunkGuide('guide/long.md', `## Big screen\n${'word '.repeat(6_000)}\n### Fields — Big screen\n${'field '.repeat(6_000)}`);
    expect(searchGuide(long, 'big screen fields').length).toBeLessThan(12_000);
  });
});

describe('an issue is written down as a block somebody can act on', () => {
  const block = issueBlock({
    id: 'ISS-20261004-001',
    when: '2026-10-04 19:42 (Baghdad)',
    who: 'Ali <ali@qs-groups.com> · branch HQ',
    chat: 'WhatsApp group',
    issue: {
      summary: 'New invoice refuses a supplier that shows as Active',
      kind: 'error_message',
      severity: 'blocks_work',
      screen: 'Payables → Purchase Invoices (/payables/invoices/new)',
      doing: 'Raising a purchase invoice for SUP-000001',
      happened: 'Save was refused',
      message: 'SUP-000001 is prospect, so a purchase order cannot be raised against them (§6).\nChoose an active supplier.',
      document: null,
      note: 'The supplier is a prospect; approving it on its profile clears this.',
    },
  });

  it('carries who, when, where, what, the message word for word, and starts open', () => {
    expect(block).toContain('## ISS-20261004-001 — New invoice refuses a supplier that shows as Active');
    expect(block).toContain('- Who: Ali <ali@qs-groups.com> · branch HQ');
    expect(block).toContain('- Kind: error message');
    expect(block).toContain('- Severity: blocks work');
    expect(block).toContain('- Status: open');
    expect(block).toContain('> SUP-000001 is prospect, so a purchase order cannot be raised against them (§6).\n> Choose an active supplier.');
    expect(block).toContain("**Noah's note**");
  });

  it('numbers the issues of a day in order, and reads the list back newest first', () => {
    const file = `${ISSUES_HEADER}\n${block}\n`;
    expect(nextIssueId('', '2026-10-04')).toBe('ISS-20261004-001');
    expect(nextIssueId(file, '2026-10-04')).toBe('ISS-20261004-002');
    expect(nextIssueId(file, '2026-10-05')).toBe('ISS-20261005-001');

    const second = issueBlock({ id: 'ISS-20261004-002', when: 'w', who: 'x', chat: 'c', issue: { summary: 'Second thing', kind: 'bug', severity: 'minor' } });
    const fixed = second.replace('- Status: open', '- Status: fixed');
    const both = `${file}\n${fixed}\n`;
    const listed = recentIssues(both);
    expect(listed.indexOf('ISS-20261004-002')).toBeLessThan(listed.indexOf('ISS-20261004-001'));
    expect(recentIssues(both, 10, true)).not.toContain('ISS-20261004-002');
    expect(recentIssues('')).toMatch(/No issue has been reported/);
  });
});

describe('what he may propose, and for which documents', () => {
  it('tells a document from its number', () => {
    expect(familyOf('api-hq-2026-000004')?.key).toBe('ap_invoice');
    expect(familyOf(' INV-HQ-2026-000001 ')?.key).toBe('ar_invoice');
    expect(familyOf('PO-HQ-2026-000002')?.key).toBe('purchase_order');
    expect(familyOf('JE-2026-000010')?.key).toBe('journal_entry');
    expect(familyOf('XYZ-1')).toBeNull();
    expect(tidyNumber(' po-hq-2026 -000002 ')).toBe('PO-HQ-2026-000002');
  });

  it('gives each family only steps that exist, and one prefix each', () => {
    const prefixes = DOCUMENT_FAMILIES.map((family) => family.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    for (const family of DOCUMENT_FAMILIES) {
      expect(family.steps.length, family.key).toBeGreaterThan(0);
      for (const step of family.steps) expect(DOCUMENT_STEPS, `${family.key}.${step}`).toContain(step);
    }
  });

  it('asks for a reason where the screens do, and says what each step does before it is taken', () => {
    expect(STEPS_NEEDING_REASON).toEqual(['reject', 'reverse', 'cancel']);
    for (const step of DOCUMENT_STEPS) expect(stepConsequence(step).length, step).toBeGreaterThan(20);
    expect(stepConsequence('post')).toMatch(/never edited afterwards, only reversed/);
    expect(stepConsequence('approve')).toMatch(/Whoever raised it cannot be the one who approves it/);
  });

  it('offers the model exactly the actions the service knows, and every family in the tool\'s own words', () => {
    const propose = AGENT_TOOLS.find((tool) => tool.name === 'propose_action')!;
    const schema = propose.input_schema as unknown as { properties: { action: { enum: string[]; description: string }; step: { enum: string[] } } };
    expect([...schema.properties.action.enum].sort()).toEqual([...ACTION_NAMES].sort());
    expect([...schema.properties.step.enum]).toEqual([...DOCUMENT_STEPS]);
    for (const family of DOCUMENT_FAMILIES) {
      expect(schema.properties.action.description, family.key).toContain(`${family.prefix}-…`);
      expect(schema.properties.action.description, family.key).toContain(`(${family.steps.join(', ')})`);
    }
    expect(actionLabel('document_step', 'post')).toBe('post the document');
  });
});
