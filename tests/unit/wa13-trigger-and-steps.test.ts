/**
 * Noah speaks only when he is called — 2026-10-04, by direction: "the AI must
 * ONLY respond when a WhatsApp message explicitly starts with `!ai`", with two
 * ways to say "not this one" (`!ai !dontwrite`, `!ai !ignore` — "don't run it
 * internally either"), and nothing said in the group that was not asked for.
 *
 * And how an answer with pictures is laid out: "step 1, look at this
 * screenshot where I point out, do that" — each picture at its own step.
 *
 * Pure: text in, a decision out.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AI_SILENCERS, AI_TRIGGER, DEFAULT_SETTINGS, triggerOf } from '@domain/whatsapp';
import { systemPrompt } from '@domain/whatsapp-agent';
import { CAPTION_MAX, layOutAnswer, pictureId } from '@domain/whatsapp-pictures';

describe('the trigger', () => {
  it('is !ai, and two words silence it', () => {
    expect(AI_TRIGGER).toBe('!ai');
    expect([...AI_SILENCERS]).toEqual(['!dontwrite', '!ignore']);
  });

  it('hears a message that begins with it, and hands on the request without it', () => {
    expect(triggerOf('!ai What is the status of invoice 125?')).toEqual({ kind: 'ask', text: 'What is the status of invoice 125?' });
    expect(triggerOf('!ai Check invoice 125.')).toEqual({ kind: 'ask', text: 'Check invoice 125.' });
    expect(triggerOf("!ai Digest this month's sales.")).toEqual({ kind: 'ask', text: "Digest this month's sales." });
    expect(triggerOf('!AI show me all overdue customer invoices')).toEqual({ kind: 'ask', text: 'show me all overdue customer invoices' });
    expect(triggerOf('  !ai   yes  ')).toEqual({ kind: 'ask', text: 'yes' });
    expect(triggerOf('!ai\nشلون أضيف مورد؟')).toEqual({ kind: 'ask', text: 'شلون أضيف مورد؟' });
    expect(triggerOf('!ai: where is the trial balance')).toEqual({ kind: 'ask', text: 'where is the trial balance' });
    // The direction mark a phone puts before mixed Arabic and Latin text is not a word.
    expect(triggerOf('\u200f!ai وين فواتير الشراء')).toEqual({ kind: 'ask', text: 'وين فواتير الشراء' });
    // The trigger alone is still a call: the bridge answers with how it is used.
    expect(triggerOf('!ai')).toEqual({ kind: 'ask', text: '' });
  });

  it('is deaf to everything else — a question, his name, the trigger anywhere but the start', () => {
    for (const said of [
      'What is the status of invoice 125?',
      'Can someone check why this invoice is still unpaid?',
      'I think invoice 125 has an incorrect amount.',
      'Can you check this? !ai',
      'Hey, !ai what happened?',
      'I need help with this invoice !ai',
      'Noah, what is our balance?',
      'yes',
      'approve PAYAPP-HQ-2026-000001',
      'ai what is the balance',
      '! ai what is the balance',
      '!aid for the flood',
      '!airport pickup at 9',
      '!ai-team meeting',
      '',
      '   ',
    ]) {
      expect(triggerOf(said), said).toEqual({ kind: 'none' });
    }
    expect(triggerOf(null)).toEqual({ kind: 'none' });
    expect(triggerOf(undefined)).toEqual({ kind: 'none' });
  });

  it('does nothing at all for !ai with !dontwrite or !ignore — not an answer, not a run', () => {
    for (const said of [
      '!ai !dontwrite Check whether invoice 125 has an incorrect amount.',
      '!ai !ignore Check whether invoice 125 has an incorrect amount.',
      '!ai check invoice 125 !dontwrite',
      '!ai check invoice 125 !ignore.',
      '!AI !DontWrite whatever',
      '!ai !ignore',
      '!ai\n!dontwrite\nsomething',
    ]) {
      expect(triggerOf(said), said).toEqual({ kind: 'silent' });
    }
    // A silencer with no trigger in front is an ordinary message, ignored like any other.
    expect(triggerOf('!dontwrite !ai check this')).toEqual({ kind: 'none' });
    // The words inside another word are not the silencer.
    expect(triggerOf('!ai what does x!ignore mean')).toEqual({ kind: 'ask', text: 'what does x!ignore mean' });
    expect(triggerOf('!ai explain !ignored rows')).toEqual({ kind: 'ask', text: 'explain !ignored rows' });
  });

  it('says nothing in the group unasked: no copy of a notification, no morning digest', () => {
    expect(DEFAULT_SETTINGS.groupNotifications).toBe(false);
    expect(DEFAULT_SETTINGS.groupDigest).toBe(false);
    expect(DEFAULT_SETTINGS.groupOnly).toBe(true);
    expect(DEFAULT_SETTINGS.agentModel).toBe('claude-opus-5-5');
  });

  it('says nothing when the bridge connects, and reads no group message before the trigger', () => {
    // It used to post "Noah here — I'm back on" on every start. A restart is
    // not news to the people in the group, and nobody asked.
    const bridge = readFileSync('scripts/ops/whatsapp-bridge.ts', 'utf8');
    expect(bridge).not.toMatch(/greet\w*\(/);
    expect(bridge).not.toMatch(/intent: 'greeting'/);
    // The trigger is decided before the message is recorded.
    const gate = bridge.indexOf('const trigger = triggerOf(typed);');
    const recorded = bridge.indexOf('wa.recordInbound(tx');
    expect(gate).toBeGreaterThan(0);
    expect(recorded).toBeGreaterThan(gate);
    expect(bridge.slice(gate, gate + 120)).toContain("if (trigger.kind !== 'ask') return;");
  });

  it('cannot send what nobody asked for: the transport itself refuses outside a called message', () => {
    // "shouldn't send any messages until called — never ever unless !ai".
    const bridge = readFileSync('scripts/ops/whatsapp-bridge.ts', 'utf8');
    // The one place a message leaves checks that something called it…
    expect(bridge).toMatch(/if \(current\(\)\.groupOnly && !called\.getStore\(\)\) \{\s+throw new Error\('unasked:/);
    // …the only thing that sets it is the handler that returns unless the message began with the trigger…
    expect(bridge.match(/called\.run\(/g)).toHaveLength(1);
    expect(bridge).toMatch(/called\.run\(true, \(\) => handleInbound\(/);
    // …and the digest does not even try.
    expect(bridge).toMatch(/async function sendDigest[^{]+\{[\s\S]{0,260}if \(settings\.groupOnly\) return;/);
    // The notification sender says the same, whatever the switch says.
    const service = readFileSync('src/server/services/whatsapp.ts', 'utf8');
    expect(service).toMatch(/if \(groupOnly\) \{\s+throw new notifications\.DeliverySuppressed\('the bot speaks only in its group, and there only when it is called with !ai'\);/);
  });

  it('tells him how he is reached, and to ask for a yes that can reach him', () => {
    const prompt = systemPrompt({ locale: 'en', userName: 'Baban', branchCode: 'HQ', today: '2026-10-04' });
    expect(prompt).toMatch(/You are shown a message only when it begins with !ai/);
    expect(prompt).toMatch(/tell them to start their reply with !ai \(for example \*!ai yes\*\)/);
    expect(prompt).toMatch(/ask them to reply \*!ai yes\* to go ahead/);
    expect(prompt).toMatch(/!ai approve <document number>/);
  });
});

describe('an answer laid out in steps', () => {
  const pictures = [
    { file: '/shots/en/payables_suppliers-menu.jpg', caption: 'Payables → Suppliers: where it is in the menu' },
    { file: 'C:\\shots\\en\\payables_suppliers-screen.jpg', caption: 'Payables → Suppliers: the screen' },
    { file: '/shots/en/payables_suppliers-form.jpg', caption: 'Payables → Suppliers: the form' },
  ];

  it('names a picture by its file, without the folder or the extension', () => {
    expect(pictureId('/shots/en/payables_suppliers-menu.jpg')).toBe('payables_suppliers-menu');
    expect(pictureId('C:\\shots\\en\\Payables_Suppliers-Screen.JPG')).toBe('payables_suppliers-screen');
    expect(pictureId('payables_suppliers-form')).toBe('payables_suppliers-form');
  });

  it('puts each picture at its step, with the words under its tag as the caption', () => {
    const laid = layOutAnswer(
      [
        'To add a supplier:',
        '',
        '[picture: payables_suppliers-menu]',
        '*Step 1* — open *Payables* and click *Suppliers*, ringed in red.',
        '',
        '[picture: payables_suppliers-screen]',
        '*Step 2* — press *New supplier*.',
        '',
        '[picture: payables_suppliers-form]',
        '*Step 3* — fill the form:',
        '1 — *Name*: the legal name, required.',
        '',
        'It is saved as a prospect until somebody approves it.',
      ].join('\n'),
      pictures,
    );
    expect(laid.parts.map((part) => [part.picture ? pictureId(part.picture.file) : null, part.text.split('\n')[0]])).toEqual([
      [null, 'To add a supplier:'],
      ['payables_suppliers-menu', '*Step 1* — open *Payables* and click *Suppliers*, ringed in red.'],
      ['payables_suppliers-screen', '*Step 2* — press *New supplier*.'],
      ['payables_suppliers-form', '*Step 3* — fill the form:'],
    ]);
    expect(laid.parts[3]!.text).toContain('It is saved as a prospect until somebody approves it.');
    // What the log keeps is the whole answer, without the tags.
    expect(laid.text).not.toMatch(/\[picture/);
    expect(laid.text).toContain('*Step 2* — press *New supplier*.');
    expect(laid.text).not.toMatch(/\n{3,}/);
  });

  it('never loses a picture and never shows a stray tag', () => {
    // No tags at all: the words, then every picture under its own caption.
    const plain = layOutAnswer('Payables → Suppliers.', pictures);
    expect(plain.parts.map((part) => (part.picture ? part.text : 'words'))).toEqual(['words', pictures[0]!.caption, pictures[1]!.caption, pictures[2]!.caption]);

    // A tag for a picture that is not attached, and one used twice.
    const stray = layOutAnswer(
      ['[picture: no_such-thing]', 'Intro.', '[picture: payables_suppliers-menu]', 'Step 1.', '[picture: payables_suppliers-menu]', 'Still step 1.'].join('\n'),
      pictures.slice(0, 1),
    );
    expect(stray.parts).toEqual([
      { text: 'Intro.', picture: null },
      { text: 'Step 1.\nStill step 1.', picture: pictures[0] },
    ]);
    expect(stray.text).toBe('Intro.\nStep 1.\nStill step 1.');

    // A tag with nothing under it: the picture goes with what it shows.
    const bare = layOutAnswer('[picture: payables_suppliers-menu]', pictures.slice(0, 1));
    expect(bare.parts).toEqual([{ text: pictures[0]!.caption, picture: pictures[0] }]);
  });

  it('reads the tag as people and models write it', () => {
    for (const tag of ['[picture: payables_suppliers-menu]', '[Picture payables_suppliers-menu]', '  [pic: payables_suppliers-menu.jpg]  ', '*[picture: payables_suppliers-menu]*', '[صورة: payables_suppliers-menu]']) {
      const laid = layOutAnswer(`${tag}\nStep 1.`, pictures.slice(0, 1));
      expect(laid.parts, tag).toEqual([{ text: 'Step 1.', picture: pictures[0] }]);
    }
    // A tag in the middle of a sentence is a sentence.
    const inline = layOutAnswer('See [picture: payables_suppliers-menu] for the menu.', pictures.slice(0, 1));
    expect(inline.parts[0]).toEqual({ text: 'See [picture: payables_suppliers-menu] for the menu.', picture: null });
  });

  it('keeps a caption a caption: words too long to sit under a picture follow it as their own message', () => {
    const long = Array.from({ length: 40 }, (_, index) => `${index + 1} — *Field ${index + 1}*: what it is for and what to type.`).join('\n');
    expect(long.length).toBeGreaterThan(CAPTION_MAX);
    const laid = layOutAnswer(`[picture: payables_suppliers-form]\n${long}`, pictures.slice(2));
    expect(laid.parts).toEqual([
      { text: pictures[2]!.caption, picture: pictures[2] },
      { text: long, picture: null },
    ]);
  });

  it('is the answer unchanged when there are no pictures', () => {
    expect(layOutAnswer('The balance is 1,250,000 IQD.', [])).toEqual({ text: 'The balance is 1,250,000 IQD.', parts: [{ text: 'The balance is 1,250,000 IQD.', picture: null }] });
  });
});
