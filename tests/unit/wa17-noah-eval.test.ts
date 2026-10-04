/**
 * Noah's test set — the pure half.
 *
 * `scripts/ops/noah-eval.ts` asks the real model, which a unit test cannot.
 * What can be held here: that the cases are well formed and name only tools
 * and actions that exist (a renamed tool would otherwise make a case fail for
 * ever, for a reason that has nothing to do with the answer), that every
 * pattern compiles, and that the judge says pass and fail where it obviously
 * should.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AGENT_TOOLS } from '@domain/whatsapp-agent';
import { ACTION_NAMES } from '@domain/whatsapp-do';
import { CASES, DEFAULT_ASKER, amount, judge, scriptShare, selectCases, withoutStamp, type EvalCase, type Observed } from '../noah/questions';

const TOOL_NAMES = new Set<string>(AGENT_TOOLS.map((tool) => tool.name));

const seen = (over: Partial<Observed> = {}): Observed => ({
  answer: 'API-HQ-2026-000005 is still a *Draft*: submit it, then a second person posts it.\n\n— QS ERP · as of 2026-10-05 09:00 UTC · branch HQ · read as System Administrator',
  tools: ['document_story'],
  locale: 'en',
  pictures: 0,
  proposed: [],
  seconds: 12,
  ...over,
});

const one = (expect: EvalCase['expect']): EvalCase => ({ id: 'x-case', area: 'document', ask: 'why?', expect, why: 'a made-up case' });

describe('the cases', () => {
  it('are enough, each with its own id, a question, a reason and something to check', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(45);
    expect(new Set(CASES.map((item) => item.id)).size).toBe(CASES.length);
    for (const item of CASES) {
      expect(item.id, item.id).toMatch(/^[a-z][a-z0-9-]+$/);
      expect(item.ask.trim().length, item.id).toBeGreaterThan(2);
      expect(item.why.trim().length, item.id).toBeGreaterThan(10);
      const { tools, toolsAny, notTools, says, neverSays, locale, script, pictures, proposes, noProposal, maxSeconds } = item.expect;
      const checks = [tools?.length, toolsAny?.length, notTools?.length, says?.length, neverSays?.length, locale, script, pictures, proposes, noProposal, maxSeconds].filter(Boolean);
      expect(checks.length, `${item.id} checks nothing`).toBeGreaterThan(0);
      // A question is what a person types after the trigger, without it.
      expect(item.ask, item.id).not.toMatch(/^\s*!ai\b/i);
    }
  });

  it('cover every area, in both languages', () => {
    const areas = new Set(CASES.map((item) => item.area));
    for (const area of ['howto', 'where', 'document', 'books', 'system', 'action', 'language', 'honesty']) expect(areas, area).toContain(area);
    expect(CASES.filter((item) => item.expect.script === 'arabic').length).toBeGreaterThanOrEqual(8);
    expect(CASES.filter((item) => item.expect.pictures).length).toBeGreaterThanOrEqual(4);
    expect(CASES.filter((item) => item.expect.proposes).length).toBeGreaterThanOrEqual(3);
  });

  it('name only tools and actions that exist', () => {
    for (const item of CASES) {
      for (const tool of [...(item.expect.tools ?? []), ...(item.expect.toolsAny ?? []), ...(item.expect.notTools ?? [])]) {
        expect(TOOL_NAMES, `${item.id}: ${tool}`).toContain(tool);
      }
      if (item.expect.proposes) {
        expect(ACTION_NAMES, `${item.id}: ${item.expect.proposes}`).toContain(item.expect.proposes);
        // A proposal goes through the one door.
        expect(item.expect.noProposal, item.id).not.toBe(true);
      }
    }
  });

  it('are written in patterns that compile, and never in a pattern that matches anything', () => {
    for (const item of CASES) {
      for (const source of [...(item.expect.says ?? []), ...(item.expect.neverSays ?? [])]) {
        let compiled: RegExp | null = null;
        expect(() => {
          compiled = new RegExp(source, 'iu');
        }, `${item.id}: /${source}/`).not.toThrow();
        expect(compiled!.test(''), `${item.id}: /${source}/ matches the empty answer`).toBe(false);
      }
    }
  });

  it('ask as people the development seed has', () => {
    const seed = readFileSync('scripts/seed-dev.ts', 'utf8');
    for (const email of new Set([DEFAULT_ASKER, ...CASES.map((item) => item.as ?? DEFAULT_ASKER)])) {
      expect(seed, email).toContain(email);
    }
  });

  it('are chosen by id, by the start of an id, or by area', () => {
    expect(selectCases([]).length).toBe(CASES.length);
    expect(selectCases(['howto-supplier-en']).map((item) => item.id)).toEqual(['howto-supplier-en']);
    expect(selectCases(['howto']).every((item) => item.area === 'howto')).toBe(true);
    expect(selectCases(['howto']).length).toBe(CASES.filter((item) => item.area === 'howto').length);
    expect(selectCases(['doc']).every((item) => item.id.startsWith('doc-'))).toBe(true);
    expect(selectCases(['howto-supplier-en', 'system']).length).toBe(1 + CASES.filter((item) => item.area === 'system').length);
    expect(selectCases(['no-such-case'])).toEqual([]);
  });
});

describe('a figure, however he writes it', () => {
  it('matches with or without separators, in either set of digits', () => {
    const figure = new RegExp(amount(250000), 'iu');
    for (const written of ['250,000 IQD', '250000', '250.000', '250 000', '٢٥٠٬٠٠٠ دينار', '٢٥٠٠٠٠']) expect(figure.test(written), written).toBe(true);
    for (const written of ['25,000', '2,500', '205,000']) expect(figure.test(written), written).toBe(false);
    expect(new RegExp(amount(1310), 'iu').test('1 USD = 1,310 IQD')).toBe(true);
  });
});

describe('the judge', () => {
  it('passes an answer that used the tool and says what it must', () => {
    expect(judge(one({ tools: ['document_story'], says: ['draft', 'submit', 'post'], neverSays: ['database is down'], script: 'latin', locale: 'en' }), seen())).toEqual([]);
  });

  it('fails a tool that was not used, and passes when any one of several was', () => {
    expect(judge(one({ tools: ['document_story', 'activity_log'] }), seen())).toEqual(['did not use activity_log']);
    expect(judge(one({ toolsAny: ['invoice', 'document_story'] }), seen())).toEqual([]);
    expect(judge(one({ toolsAny: ['invoice', 'query'] }), seen())).toEqual(['used none of invoice / query']);
    expect(judge(one({ notTools: ['document_story'] }), seen())).toEqual(['used document_story, which it must not']);
  });

  it('fails what is missing from the words, and what must never be in them', () => {
    expect(judge(one({ says: ['draft', 'reversed'] }), seen())).toEqual(['does not say /reversed/']);
    const down = judge(one({ neverSays: ['database (is )?down'] }), seen({ answer: 'I could not read the books: my database is down.' }));
    expect(down).toHaveLength(1);
    expect(down[0]).toMatch(/says "database is down", which it must never/);
    // The stamp under every reply is not part of what he said.
    expect(judge(one({ says: ['System Administrator'] }), seen())).toEqual(['does not say /System Administrator/']);
    expect(withoutStamp(seen().answer)).not.toMatch(/QS ERP/);
  });

  it('tells an Arabic answer from an English one, whatever codes it carries', () => {
    const arabic = 'الفاتورة API-HQ-2026-000005 بعدها *مسودة* (Draft). لازم ترسلها للموافقة وبعدين تترحّل حتى تبين برصيد المورد SUP-00001.\n\n— QS ERP · كما في 2026-10-05 09:00 UTC · الفرع HQ · قُرئ باسم System Administrator';
    expect(judge(one({ script: 'arabic' }), seen({ answer: arabic, locale: 'ar' }))).toEqual([]);
    expect(judge(one({ script: 'latin' }), seen({ answer: arabic, locale: 'ar' }))[0]).toMatch(/expected an answer in Latin script/);
    expect(judge(one({ script: 'arabic' }), seen())[0]).toMatch(/expected an answer in Arabic script/);
    // An English answer that quotes the Arabic path is still an English answer.
    const quoting = 'Open *Payables* → *Supplier Balances* → *Suppliers* and press *New supplier*. In Arabic: الذمم الدائنة ← أرصدة الموردين ← الموردون. Then fill the form from top to bottom and press Create.';
    expect(judge(one({ script: 'latin' }), seen({ answer: quoting }))).toEqual([]);
    expect(scriptShare('API-HQ-2026-000005 https://erp.qs-groups.com/payables/invoices [picture: payables_invoices-menu]')).toEqual({ arabic: 0, latin: 0 });
    expect(judge(one({ locale: 'ar' }), seen())).toEqual(['read as en, expected ar']);
  });

  it('counts the pictures, and holds a proposal to having been made — or not made', () => {
    expect(judge(one({ pictures: 2 }), seen({ pictures: 3 }))).toEqual([]);
    expect(judge(one({ pictures: 2 }), seen({ pictures: 1 }))).toEqual(['1 picture(s), expected at least 2']);
    expect(judge(one({ proposes: 'document_step' }), seen({ proposed: ['document_step'] }))).toEqual([]);
    expect(judge(one({ proposes: 'document_step' }), seen())).toEqual(['did not propose document_step']);
    expect(judge(one({ proposes: 'create_draft' }), seen({ proposed: ['document_step'] }))).toEqual(['did not propose create_draft (proposed document_step)']);
    expect(judge(one({ noProposal: true }), seen({ proposed: ['create_draft'] }))).toEqual(['proposed create_draft, and should have proposed nothing']);
    expect(judge(one({ noProposal: true }), seen())).toEqual([]);
  });

  it('fails a slow answer, and a call that never came back, by its own words', () => {
    expect(judge(one({ maxSeconds: 10 }), seen({ seconds: 31 }))).toEqual(['took 31s, more than 10s']);
    expect(judge(one({ says: ['draft'] }), seen({ answer: '', tools: [], error: 'no answer within 600s' }))).toEqual(['the call failed: no answer within 600s']);
  });
});
