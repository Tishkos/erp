/**
 * Noah's pictures and drafts — 2026-10-04, by direction: "very good explainer
 * helper, a lot of good tools, draft maker… if he can take screenshots would
 * be so good and send it group chat and point out what to do", and then: "not
 * just login — all screens, everything": numbered pointers on every picture,
 * and each number explained.
 *
 * The pure half: the tools the model is offered, what the instructions say
 * about them, the pictures the loop collects, and which pictures a person is
 * shown with which numbers. No database: the pictures are files, read from a
 * folder made here.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@domain/permissions';
import { ACTION_NAMES, DRAFT_KINDS, actionLabel } from '@domain/whatsapp-do';
import { AGENT_TOOLS, MAX_IMAGES, runAgent, systemPrompt, type AgentClient } from '@domain/whatsapp-agent';
import { screenPictures } from '@/server/services/system-guide';

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

const tool = (name: string) => AGENT_TOOLS.find((one) => one.name === name);

describe('the tools he is offered', () => {
  it('has a picture tool with every view, a look-up by number, the chart and the rate', () => {
    const show = tool('show_screen');
    expect(show).toBeDefined();
    const schema = show!.input_schema as unknown as { properties: { screen: unknown; view: { enum: string[] } }; required?: string[] };
    expect(schema.properties.view.enum).toEqual(['menu', 'screen', 'form', 'record', 'dialog', 'all']);
    expect(schema.required).toContain('screen');
    // The description is what makes him place a picture at its step.
    expect(show!.description).toMatch(/write the tag on a line of its own/);
    expect(show!.description).toMatch(/every field NUMBERED in red/);
    expect(show!.description).toMatch(/"sign in"/);
    for (const name of ['document_status', 'document_story', 'activity_log', 'system_status', 'accounts', 'exchange_rate']) expect(tool(name), name).toBeDefined();
    // The one that reads a document whole is the first thing to reach for.
    expect(tool('document_story')!.description).toMatch(/Use it FIRST whenever a question is about a particular document/);
  });

  it('offers a draft of exactly the kinds the service keys, through propose_action and nothing else', () => {
    expect(ACTION_NAMES).toContain('create_draft');
    expect(actionLabel('create_draft')).toBe('save the draft');
    const propose = tool('propose_action')!;
    const schema = propose.input_schema as unknown as {
      properties: { kind: { enum: string[] }; lines: { type: string; items: { properties: Record<string, unknown> } } };
    };
    expect([...schema.properties.kind.enum]).toEqual([...DRAFT_KINDS]);
    expect(schema.properties.lines.type).toBe('array');
    for (const field of ['item', 'quantity', 'unitPrice', 'warehouse', 'account', 'debit', 'credit']) {
      expect(schema.properties.lines.items.properties, field).toHaveProperty(field);
    }
    // A draft is not a tool of its own: it is proposed, read back, and saved on a yes.
    expect(AGENT_TOOLS.some((one) => /draft/.test(one.name))).toBe(false);
  });
});

describe('what the instructions say about them', () => {
  const prompt = systemPrompt({ locale: 'en', userName: 'Baban', branchCode: 'HQ', today: '2026-10-04' });

  it('walks somebody through in steps, each picture at its own step', () => {
    expect(prompt).toMatch(/call show_screen for the screen you are explaining/);
    expect(prompt).toMatch(/Write your answer as STEPS, and put each picture at its step/);
    expect(prompt).toMatch(/What you write under a tag is sent as the caption of that picture/);
    expect(prompt).toMatch(/A task that crosses several screens is several pictures in order/);
    expect(prompt).toMatch(/pictures of a training copy with sample data/);
  });

  it('explains every numbered thing: what it is for, why, what to enter, whether it may be empty, what it changes', () => {
    expect(prompt).toMatch(/The pictures carry red numbers on what matters/);
    expect(prompt).toMatch(/what it is for; why the system needs it; what to put there, with an example/);
    expect(prompt).toMatch(/whether it may be left empty; and what it changes elsewhere/);
    expect(prompt).toMatch(/Explain a term the first time it appears/);
    expect(prompt).toMatch(/Never invent a number or a field the tool did not list/);
  });

  it('keys a draft only after reading it back, and never guesses what is missing', () => {
    expect(prompt).toMatch(/DRAFTS — you can key a journal entry, a purchase invoice or a sales invoice/);
    expect(prompt).toMatch(/read the whole draft back line by line with its total before they say yes/);
    expect(prompt).toMatch(/nothing posts/);
    expect(prompt).toMatch(/ask one short question rather than guessing/);
  });
});

describe('the pictures the loop collects', () => {
  const base = { model: 'fake', userName: 'Baban', locale: 'en' as const, branchCode: 'HQ', today: '2026-10-04' };

  it('hands on each picture once, in order, and no more than eight', async () => {
    let round = 0;
    const script = [{ screen: '/a' }, { screen: '/a' }, { screen: '/b' }, { screen: '/c' }, { screen: '/d' }];
    const client: AgentClient = {
      create: async () => {
        const step = script[round];
        round += 1;
        if (!step) return { content: [{ type: 'text', text: 'The ringed entry is the one to click.' }] };
        return { content: [{ type: 'tool_use', id: `t${round}`, name: 'show_screen', input: step }] };
      },
    };
    const result = await runAgent({
      ...base,
      client,
      question: 'where do I enter a purchase invoice?',
      runTool: async (_name, args) => ({
        text: 'pictures are attached',
        images: ['menu', 'screen', 'form'].map((view) => ({ file: `${String(args.screen)}-${view}.jpg`, caption: view })),
      }),
    });
    expect(MAX_IMAGES).toBe(8);
    expect(result.images?.map((image) => image.file)).toEqual(['/a-menu.jpg', '/a-screen.jpg', '/a-form.jpg', '/b-menu.jpg', '/b-screen.jpg', '/b-form.jpg', '/c-menu.jpg', '/c-screen.jpg']);
    // What he did is kept: each look-up, in order, with its time.
    expect(result.trace?.map((step) => step.tool)).toEqual(['show_screen', 'show_screen', 'show_screen', 'show_screen', 'show_screen']);
    expect(result.trace?.every((step) => step.ok && typeof step.ms === 'number')).toBe(true);
    expect(result.text).toBe('The ringed entry is the one to click.');
  });

  it('a live picture taken again is one picture: the retake takes the place of the first', async () => {
    let round = 0;
    const script = ['wrong', 'training', 'right'];
    const result = await runAgent({
      ...base,
      client: {
        create: async () => {
          const step = script[round];
          round += 1;
          if (!step) return { content: [{ type: 'text', text: 'The arrow is at Send for approval.' }] };
          return { content: [{ type: 'tool_use', id: `t${round}`, name: step === 'training' ? 'show_screen' : 'screenshot', input: {} }] };
        },
      },
      question: 'show me my invoice',
      runTool: async (name) =>
        name === 'screenshot'
          ? { text: 'a live picture', images: [{ file: `/shots/${round}.jpg`, caption: 'live', group: 'live:/payables/invoices/API-1' }] }
          : { text: 'a training picture', images: [{ file: '/guide/form.jpg', caption: 'form' }] },
    });
    // The first live picture (the arrow at nothing) is gone; the order is kept.
    expect(result.images?.map((image) => image.file)).toEqual(['/shots/3.jpg', '/guide/form.jpg']);
  });

  it('says nothing of pictures when no tool attached one', async () => {
    const result = await runAgent({
      ...base,
      client: { create: async () => ({ content: [{ type: 'text', text: 'An import is a payable whose goods come from abroad.' }] }) },
      question: 'what is an import?',
      runTool: async () => ({ text: 'unused' }),
    });
    expect(result).not.toHaveProperty('images');
  });
});

describe('which pictures a person is shown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'noah-shots-'));
  const previous = process.env.ERP_GUIDE_SHOTS_DIR;
  const tail = (file: string) => file.replaceAll('\\', '/').split('/').slice(-2).join('/');

  beforeAll(() => {
    mkdirSync(join(dir, 'en'), { recursive: true });
    mkdirSync(join(dir, 'ar'), { recursive: true });
    const index: Record<string, unknown>[] = [];
    const put = (entry: { route: string; locale: 'en' | 'ar'; view: string; file: string } & Record<string, unknown>) => {
      writeFileSync(join(dir, entry.file), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      index.push(entry);
    };
    for (const locale of ['en', 'ar'] as const) {
      put({ route: '/payables/invoices', locale, view: 'menu', file: `${locale}/payables_invoices-menu.jpg` });
      put({
        route: '/payables/invoices',
        locale,
        view: 'screen',
        file: `${locale}/payables_invoices-screen.jpg`,
        ...(locale === 'en' ? { ringed: true } : {}),
        marks: [
          { n: 1, label: locale === 'en' ? 'New invoice' : 'فاتورة جديدة', kind: 'button' },
          { n: 2, label: 'Invoice · Supplier · Date · Total · Status', kind: 'table' },
        ],
      });
      put({
        route: '/payables/invoices',
        locale,
        view: 'form',
        file: `${locale}/payables_invoices-form.jpg`,
        marks: [
          { n: 1, label: locale === 'en' ? 'Supplier' : 'المورد', kind: 'choice', required: true, options: ['SUP-00001 · Al-Rafidain', 'SUP-00002 · Basra Freight'], hint: locale === 'en' ? 'Who billed you.' : 'من أصدر الفاتورة.' },
          { n: 2, label: locale === 'en' ? 'Invoice date' : 'تاريخ الفاتورة', kind: 'date', required: true },
          { n: 3, label: locale === 'en' ? 'Note' : 'ملاحظة', kind: 'text' },
          { n: 4, label: locale === 'en' ? 'Create' : 'إنشاء', kind: 'button' },
        ],
      });
      put({ route: '/payables/invoices', locale, view: 'record', file: `${locale}/payables_invoices-record.jpg`, marks: [{ n: 1, label: 'Draft', kind: 'status' }, { n: 2, label: 'Print', kind: 'door' }] });
      put({
        route: '/sign-in',
        locale,
        view: 'form',
        file: `${locale}/sign_in-form.jpg`,
        marks: [
          { n: 1, label: locale === 'en' ? 'Email' : 'البريد الإلكتروني', kind: 'text', required: true },
          { n: 2, label: locale === 'en' ? 'Password' : 'كلمة المرور', kind: 'text', required: true },
          { n: 3, label: locale === 'en' ? 'Sign in' : 'دخول', kind: 'button' },
        ],
      });
      put({ route: 'top-bar', locale, view: 'screen', file: `${locale}/top_bar-screen.jpg`, marks: [{ n: 1, label: 'Modules', kind: 'tabs' }] });
      put({
        route: '/payables/invoices',
        locale,
        view: 'dialog',
        on: 'record',
        key: 'attachments',
        name: locale === 'en' ? 'Attachments' : 'المرفقات',
        file: `${locale}/payables_invoices-dialog-attachments.jpg`,
        marks: [
          { n: 1, label: locale === 'en' ? 'File' : 'الملف', kind: 'file', required: true },
          { n: 2, label: locale === 'en' ? 'Attach' : 'إرفاق', kind: 'button' },
        ],
      });
      put({ route: '/payables/invoices', locale, view: 'dialog', on: 'record', key: 'audit_log', name: locale === 'en' ? 'Audit log' : 'سجل التدقيق', file: `${locale}/payables_invoices-dialog-audit_log.jpg` });
    }
    // Listed, but the file never arrived: it is left out rather than promised.
    index.push({ route: '/payables/suppliers', locale: 'en', view: 'menu', file: 'en/missing.jpg' });
    writeFileSync(join(dir, 'index.json'), JSON.stringify(index));
    process.env.ERP_GUIDE_SHOTS_DIR = dir;
  });

  afterAll(() => {
    if (previous === undefined) delete process.env.ERP_GUIDE_SHOTS_DIR;
    else process.env.ERP_GUIDE_SHOTS_DIR = previous;
  });

  it('finds the screen by its address or by its name; a how-to is menu, screen and form, each with its tag', () => {
    const byAddress = screenPictures(principal(), 'en', '/payables/invoices');
    expect(byAddress.images.map((image) => tail(image.file))).toEqual(['en/payables_invoices-menu.jpg', 'en/payables_invoices-screen.jpg', 'en/payables_invoices-form.jpg']);
    expect(byAddress.text).toMatch(/3 picture\(s\) of Purchase Invoices \(\/payables\/invoices\) are attached to your answer/);
    expect(byAddress.text).toContain('[picture: payables_invoices-menu]');
    expect(byAddress.text).toContain('[picture: payables_invoices-form]');
    expect(byAddress.text).toMatch(/training copy with sample data/);
    // The record is not part of a how-to, and he is told it exists.
    expect(byAddress.text).toMatch(/This screen also has: "record"/);
    expect(byAddress.images[0]!.caption).toMatch(/^Payables → .+ → Purchase Invoices: where it is in the menu/);
    // Only a picture with a ring in it says there is one.
    expect(byAddress.images[1]!.caption).toMatch(/the button ringed in red starts a new one/);
    expect(screenPictures(principal(), 'ar', '/payables/invoices', 'screen').images[0]!.caption).not.toMatch(/الزر المحاط/);

    const byName = screenPictures(principal(), 'en', 'purchase invoices', 'menu');
    expect(byName.images).toHaveLength(1);
    expect(byName.images[0]!.file).toMatch(/payables_invoices-menu\.jpg$/);

    const record = screenPictures(principal(), 'en', '/payables/invoices', 'record');
    expect(record.images.map((image) => tail(image.file))).toEqual(['en/payables_invoices-record.jpg']);
    expect(record.text).toContain('1 = Draft (the status) · 2 = Print (an icon in the title bar)');
  });

  it('tells him which red number is which field, what kind it is, and whether it is required', () => {
    const shown = screenPictures(principal(), 'en', '/payables/invoices', 'form');
    // With what the screen itself offers and says: a dropdown's choices, a field's hint.
    expect(shown.text).toContain(
      'The red numbers on it: 1 = Supplier (a list to choose from, required; its choices: SUP-00001 · Al-Rafidain / SUP-00002 · Basra Freight; the screen says: "Who billed you.") · 2 = Invoice date (a date, required) · 3 = Note (a box to type in) · 4 = Create (a button).',
    );
    expect(shown.text).toMatch(/what it is for, why the system needs it, what to put there \(with an example\), whether it may be left empty, and what it changes elsewhere/);
    expect(shown.images[0]!.caption).toMatch(/the red numbers are explained in the message/);
    // A picture with nothing drawn on it says so, so he does not invent numbers.
    expect(screenPictures(principal(), 'en', '/payables/invoices', 'menu').text).toMatch(/Nothing is numbered on this one/);
  });

  it('shows the Arabic screen, with Arabic labels and an Arabic caption, to somebody who wrote in Arabic', () => {
    const shown = screenPictures(principal(), 'ar', '/payables/invoices', 'form');
    expect(shown.images).toHaveLength(1);
    expect(tail(shown.images[0]!.file)).toBe('ar/payables_invoices-form.jpg');
    expect(shown.images[0]!.caption).toMatch(/[؀-ۿ]/);
    expect(shown.images[0]!.caption).not.toMatch(/Purchase Invoices/);
    expect(shown.text).toContain('1 = المورد (a list to choose from, required;');
    expect(shown.text).toContain('the screen says: "من أصدر الفاتورة."');
  });

  it('has the windows that open from a screen and its record, by a name that is the same in both languages', () => {
    // A how-to says they exist…
    const howTo = screenPictures(principal(), 'en', '/payables/invoices');
    expect(howTo.text).toMatch(/pictures of the windows that open from it \(view "dialog", dialog = the name\): "attachments" — on an opened record, "audit_log" — on an opened record/);
    // …asked for without a name, he is told which there are…
    const which = screenPictures(principal(), 'en', '/payables/invoices', 'dialog');
    expect(which.images).toEqual([]);
    expect(which.text).toMatch(/has these dialogs: "attachments" — on an opened record, "audit_log"/);
    // …and by name, the one picture with its numbers, in the asker's language.
    const en = screenPictures(principal(), 'en', '/payables/invoices', 'dialog', 'Attachments');
    expect(en.images.map((image) => tail(image.file))).toEqual(['en/payables_invoices-dialog-attachments.jpg']);
    expect(en.text).toContain('[picture: payables_invoices-dialog-attachments]');
    expect(en.text).toContain('1 = File (a file to attach, required) · 2 = Attach (a button)');
    const ar = screenPictures(principal(), 'ar', '/payables/invoices', 'dialog', 'audit log');
    expect(ar.images.map((image) => tail(image.file))).toEqual(['ar/payables_invoices-dialog-audit_log.jpg']);
    expect(ar.images[0]!.caption).toMatch(/سجل التدقيق/);
    expect(screenPictures(principal(), 'en', '/payables/invoices', 'dialog', 'no such window').text).toMatch(/"no such window" is not one of them/);
    // A screen with none says so; and nobody is shown one of a screen they cannot open.
    expect(screenPictures(principal(), 'en', 'sign in', 'dialog').text).toMatch(/has no picture of a dialog/);
    expect(screenPictures(principal({ isSuperUser: false }), 'en', '/payables/invoices', 'dialog', 'attachments').images).toEqual([]);
  });

  it('has the way in for everybody: signing in and the top bar, whatever their role', () => {
    const nobody = principal({ isSuperUser: false });
    for (const asked of ['sign in', 'how to log in', 'login', 'تسجيل الدخول', '/sign-in']) {
      const shown = screenPictures(nobody, 'en', asked);
      expect(shown.images.map((image) => tail(image.file)), asked).toEqual(['en/sign_in-form.jpg']);
      expect(shown.text, asked).toContain('1 = Email (a box to type in, required) · 2 = Password (a box to type in, required) · 3 = Sign in (a button)');
    }
    expect(screenPictures(nobody, 'ar', 'sign in').images[0]!.caption).toMatch(/^تسجيل الدخول/);
    expect(screenPictures(nobody, 'en', 'the navbar').images.map((image) => tail(image.file))).toEqual(['en/top_bar-screen.jpg']);
    // One that was never made is said, not promised.
    expect(screenPictures(nobody, 'en', 'change password').text).toMatch(/There is no picture of Change password/);
  });

  it('shows nobody a screen their role cannot open, and promises no picture that is not there', () => {
    const closed = screenPictures(principal({ isSuperUser: false }), 'en', '/payables/invoices');
    expect(closed.images).toEqual([]);
    expect(closed.text).toMatch(/role cannot open Purchase Invoices/);

    const missing = screenPictures(principal(), 'en', '/payables/suppliers', 'menu');
    expect(missing.images).toEqual([]);
    expect(missing.text).toMatch(/There is no "menu" picture of Suppliers/);

    const none = screenPictures(principal(), 'en', 'zzzz-no-such-screen');
    expect(none.text).toMatch(/No built screen matches/);
    expect(none.text).toMatch(/"sign in"/);
  });

  it('says so plainly when the server has no pictures at all', () => {
    process.env.ERP_GUIDE_SHOTS_DIR = join(dir, 'nowhere');
    try {
      expect(screenPictures(principal(), 'en', '/payables/invoices')).toEqual({
        text: expect.stringMatching(/No pictures are installed on this server/),
        images: [],
      });
    } finally {
      process.env.ERP_GUIDE_SHOTS_DIR = dir;
    }
  });
});
