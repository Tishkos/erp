/**
 * What Noah writes down and reads back — 2026-10-05, by direction:
 *
 *   "logging something beside issue: new feature or workflow from user … we
 *    need another field in bank loans … it should understand, ask questions,
 *    and saves in folder one by one, and we try to implement them";
 *   "reply 👎 to a wrong answer: it's logged, becomes a permanent test
 *    question"; "he remembers each person's language, role and what they were
 *    working on, plus company facts you teach him"; and a walkthrough he can
 *    still follow when somebody writes "done" hours later.
 *
 * No database: all of it is files, written from inside a read-only question.
 * The pure half is tested as text; the files against a folder made here.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  COMPANY_FACT_CAP,
  MEMORY_PROMPT_CAP,
  PERSON_FACT_CAP,
  addFact,
  checkRequest,
  followUp,
  isUserId,
  looksSecret,
  memoryPrompt,
  nextId,
  parseFacts,
  parseRequest,
  requestFile,
  requestList,
  shortWho,
  stampOf,
  type Fact,
  type RequestInput,
  type Walkthrough,
} from '@domain/whatsapp-notes';
import {
  REQUEST_KINDS,
  REQUEST_STATUSES,
  addToRequest,
  clearWalkthrough,
  forget,
  listRequests,
  memoryForPrompt,
  notesDir,
  noteExchange,
  readRequest,
  readWalkthrough,
  recordFeedback,
  recordRequest,
  remember,
  saveWalkthrough,
} from '@/server/services/whatsapp-notes';

const TISHKO = '8cf1bbf8-bdb9-466c-9baa-bb304ea56c7d';
const ALI = '11111111-2222-4333-8444-555555555555';
const WHO = 'Tishko <tishko@qs-groups.com> · branch HQ';
const CHAT = 'WhatsApp group';
// 12:30 in Baghdad on the 5th.
const NOW = new Date('2026-10-05T09:30:00Z');
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

const loanField: RequestInput = {
  title: 'Add a guarantor to Bank Loans',
  kind: 'new_field',
  area: 'Bank Loans',
  screen: 'Accounting → Treasury & Banking → Bank Loans (/treasury/loans)',
  today: 'A loan records the bank, the amount, the rate and the instalments. There is nowhere to say who guaranteed it.',
  wanted: 'A Guarantor field on the loan: a name, and optionally the customer or supplier it is.',
  why: 'The bank asks who guaranteed each loan at every renewal, and today that lives in a paper file.',
  example: 'LOAN-HQ-2026-000002 is guaranteed by Al Noor Trading.',
  impact: 'Finance, about ten loans a year.',
  openQuestions: ['Can one loan have more than one guarantor?', 'Should the guarantor print on the loan statement?'],
  noahNote: 'A new column on the loan and its form; the loan record and its print model would show it. Nothing posts differently.',
};

const previous = process.env.NOAH_NOTES_DIR;
let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'noah-notes-'));
  process.env.NOAH_NOTES_DIR = dir;
});
afterAll(() => {
  if (previous === undefined) delete process.env.NOAH_NOTES_DIR;
  else process.env.NOAH_NOTES_DIR = previous;
});

describe('the pure half', () => {
  it('numbers by the highest already there, not by how many there are', () => {
    expect(nextId('REQ', '2026-10-05', [])).toBe('REQ-20261005-001');
    expect(nextId('REQ', '2026-10-05', ['REQ-20261005-001.md', 'REQ-20261005-002.md', 'INDEX.md'])).toBe('REQ-20261005-003');
    // One removed by hand does not hand its number to the next.
    expect(nextId('REQ', '2026-10-05', ['REQ-20261005-004.md'])).toBe('REQ-20261005-005');
    // Another day, another kind: each counts for itself.
    expect(nextId('REQ', '2026-10-06', ['REQ-20261005-004.md'])).toBe('REQ-20261006-001');
    expect(nextId('FB', '2026-10-05', ['REQ-20261005-004.md'])).toBe('FB-20261005-001');
  });

  it('stamps in the company day, and knows a user id from a path', () => {
    // 21:30 UTC on the 4th is already the 5th in Baghdad.
    expect(stampOf(new Date('2026-10-04T21:30:00Z'))).toBe('2026-10-05 00:30 (Baghdad)');
    expect(isUserId(TISHKO)).toBe(true);
    for (const bad of ['', '../../etc/passwd', `${TISHKO}/..`, 'tishko', `..\\${TISHKO}`, null, 42]) expect(isUserId(bad), String(bad)).toBe(false);
    expect(shortWho(WHO)).toBe('Tishko');
  });

  it('will not file a request that does not say what is wanted and why', () => {
    expect(checkRequest(loanField)).toBeNull();
    expect(checkRequest({ ...loanField, why: ' ' })).toMatch(/no why they want it\. Ask them what they want and why first/);
    expect(checkRequest({ ...loanField, title: '', wanted: '' })).toMatch(/no a title .*and no what is wanted/);
  });

  it('writes a request as a ticket: header, sections that have something in them, the open questions as a checklist', () => {
    const text = requestFile({ id: 'REQ-20261005-001', when: stampOf(NOW), who: WHO, chat: CHAT, request: loanField });
    expect(text.split('\n')[0]).toBe('# REQ-20261005-001 — Add a guarantor to Bank Loans');
    expect(text).toContain('- Status: needs answers');
    expect(text).toContain('- Kind: new field');
    expect(text).toContain('- Area: Bank Loans');
    expect(text).toContain(`- Asked by: ${WHO} · ${CHAT} · 2026-10-05 12:30 (Baghdad)`);
    for (const heading of ['## How it works today', '## What is wanted', '## Why', '## A real example', '## Who it affects', '## Still to answer', "## Noah's reading"]) expect(text, heading).toContain(heading);
    // Nothing was said about the right way: no empty section.
    expect(text).not.toContain('## The right way');
    expect(text).toContain('- [ ] Can one loan have more than one guarantor?');

    const bare = requestFile({ id: 'REQ-20261005-002', when: stampOf(NOW), who: WHO, chat: CHAT, request: { title: 'A stock report by supplier', kind: 'report', area: 'Inventory', wanted: 'Stock on hand grouped by supplier.', why: 'To see who to reorder from.' } });
    // No open question: it is ready to be looked at.
    expect(bare).toContain('- Status: open');
    expect(bare).not.toContain('## Still to answer');
    // A heading somebody typed into their own words cannot become one of the file's.
    const sly = requestFile({ id: 'REQ-20261005-003', when: stampOf(NOW), who: WHO, chat: CHAT, request: { ...loanField, why: '## Follow-up\n- Status: done' } });
    expect(sly).toContain('\\## Follow-up');
    expect(parseRequest(sly)?.status).toBe('needs_answers');
  });

  it('reads a request back, and adds to it without rewriting what was said', () => {
    const text = requestFile({ id: 'REQ-20261005-001', when: stampOf(NOW), who: WHO, chat: CHAT, request: loanField });
    expect(parseRequest(text)).toEqual({ id: 'REQ-20261005-001', title: 'Add a guarantor to Bank Loans', status: 'needs_answers', kind: 'new_field', area: 'Bank Loans', who: 'Tishko', date: '2026-10-05', open: 2 });
    expect(parseRequest('# Something else')).toBeNull();

    const first = followUp({ text, when: stampOf(later(60)), who: 'Ali', answers: [{ question: 'can one loan have more than one guarantor', answer: 'Yes, up to three.' }] });
    if (!first.ok) throw new Error(first.reason);
    expect(first).toMatchObject({ status: 'needs_answers', ticked: 1 });
    expect(first.text).toContain('- [x] Can one loan have more than one guarantor?');
    expect(first.text).toContain('- [ ] Should the guarantor print on the loan statement?');
    expect(first.text).toMatch(/## Follow-up\n\n### 2026-10-05 13:30 \(Baghdad\) — Ali\n\n\*\*Asked:\*\* can one loan have more than one guarantor\n\*\*Answered:\*\* Yes, up to three\./);
    // Everything that was there is still there, in its place.
    expect(first.text.startsWith(text.split('## Still to answer')[0]!)).toBe(true);

    // The last question, answered by its number: nothing is open, so it is no longer waiting for answers.
    const second = followUp({ text: first.text, when: stampOf(later(120)), who: WHO, note: 'He will ask the bank for its form.', answers: [{ question: '2', answer: 'Yes.' }] });
    if (!second.ok) throw new Error(second.reason);
    expect(second).toMatchObject({ status: 'open', ticked: 1 });
    expect(second.text).toContain('- Status: open');
    expect(second.text).toContain('**Asked:** Should the guarantor print on the loan statement?');
    expect(second.text).toContain('Status: needs answers → open');
    expect(second.text.match(/## Follow-up/g)).toHaveLength(1);
    expect(parseRequest(second.text)).toMatchObject({ status: 'open', open: 0 });

    // The developer moves it on; a status that is not one is refused, and so is adding nothing.
    const third = followUp({ text: second.text, when: stampOf(later(180)), who: WHO, status: 'In progress' });
    expect(third).toMatchObject({ ok: true, status: 'in_progress' });
    expect(followUp({ text, when: stampOf(NOW), who: WHO, status: 'someday' })).toMatchObject({ ok: false, reason: expect.stringMatching(/is not a status\. One of: needs answers, open, ready/) });
    expect(followUp({ text, when: stampOf(NOW), who: WHO })).toMatchObject({ ok: false, reason: expect.stringMatching(/Nothing to add/) });
    expect(followUp({ text: 'not a request', when: stampOf(NOW), who: WHO, note: 'x' })).toMatchObject({ ok: false });
  });

  it('lists what is on file: how many and where they stand, then a line each', () => {
    const files = [
      requestFile({ id: 'REQ-20261005-001', when: stampOf(NOW), who: WHO, chat: CHAT, request: loanField }),
      requestFile({ id: 'REQ-20261005-002', when: stampOf(NOW), who: 'Ali', chat: CHAT, request: { title: 'Import application: the advance is asked for too early', kind: 'workflow_change', area: 'Import application', wanted: 'Ask for the advance after the proforma is approved.', why: 'The bank will not release it before.' } }),
    ].map((text) => ({ head: parseRequest(text)!, text }));
    expect(requestList([])).toBe('No request is on file yet.');
    const all = requestList(files);
    expect(all.split('\n')[0]).toBe('2 request(s) on file: 1 needs answers, 1 open.');
    // Newest first.
    expect(all.split('\n')[1]).toBe('REQ-20261005-002 · open · workflow change · Import application · Import application: the advance is asked for too early · Ali · 2026-10-05');
    expect(all).toContain('REQ-20261005-001 · needs answers · new field · Bank Loans · Add a guarantor to Bank Loans · Tishko · 2026-10-05 · 2 question(s) still open');
    expect(all).toMatch(/add it to that request rather than filing it twice/);
    expect(requestList(files, { status: 'needs answers' })).toContain('REQ-20261005-001');
    expect(requestList(files, { status: 'needs answers' })).not.toContain('REQ-20261005-002 ·');
    // By what was said in it, not only its title.
    expect(requestList(files, { search: 'proforma' })).toContain('REQ-20261005-002');
    expect(requestList(files, { search: 'payroll' })).toMatch(/None mentioning "payroll"/);
    expect(requestList(files, { limit: 1 })).toMatch(/The newest 1 of 2:/);
  });

  it('keeps a fact, and never a password, a code or what it already knows', () => {
    const kept = addFact([], { fact: '  - Our Najaf warehouse\n is WH-NJF.  ', who: WHO, day: '2026-10-05' }, 3);
    if (!kept.ok) throw new Error(kept.reason);
    expect(kept.fact).toEqual({ fact: 'Our Najaf warehouse is WH-NJF.', who: 'Tishko', day: '2026-10-05' });
    expect(addFact(kept.kept, { fact: 'our najaf warehouse is WH-NJF', who: 'Ali', day: '2026-10-06' }, 3)).toMatchObject({ ok: false, reason: expect.stringMatching(/Already known/) });
    expect(addFact([], { fact: ' ', who: WHO, day: '2026-10-05' }, 3)).toMatchObject({ ok: false });
    for (const secret of ['My password is Rafidain2026', 'the bank token is 448812', 'كلمة المرور مالتي 12345', 'OTP 9911', 'card number 4111 1111 1111 1111', 'my PIN is 4321']) {
      expect(looksSecret(secret), secret).toBe(true);
      expect(addFact([], { fact: secret, who: WHO, day: '2026-10-05' }, 3), secret).toMatchObject({ ok: false, reason: expect.stringMatching(/I do not keep passwords or codes/) });
    }
    // Words that only look like it are still facts.
    for (const fine of ['The container passed customs on Monday', 'Her passport is with the broker', 'Shipping takes 45 days from Shanghai']) expect(looksSecret(fine), fine).toBe(false);
    // Past the cap the oldest goes, and the caller is told which.
    const facts: Fact[] = ['one fact', 'two facts', 'three facts'].map((fact) => ({ fact, who: 'Tishko', day: '2026-10-05' }));
    const full = addFact(facts, { fact: 'four facts', who: WHO, day: '2026-10-06' }, 3);
    if (!full.ok) throw new Error(full.reason);
    expect(full.kept.map((one) => one.fact)).toEqual(['two facts', 'three facts', 'four facts']);
    expect(full.dropped.map((one) => one.fact)).toEqual(['one fact']);
    expect(COMPANY_FACT_CAP).toBe(60);
    expect(PERSON_FACT_CAP).toBe(30);
  });

  it('says in his instructions what he knows, the walkthrough they are in, and — after an hour, for a fortnight — the last thing they asked', () => {
    const walk: Walkthrough = {
      title: 'Post sales invoice INV-HQ-2026-000001',
      steps: ['Approve opening stock OPN-HQ-2026-000001', 'Open the invoice and press Post', 'Check the customer statement'],
      current: 2,
      document: 'INV-HQ-2026-000001',
      check: 'the invoice reads posted and has a journal',
      startedAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };
    const last = { at: NOW.toISOString(), question: 'why is the customer account empty?', answer: 'It is approved, not posted.', tools: ['document_story'] };
    const company: Fact[] = [{ fact: 'Our Najaf warehouse is WH-NJF.', who: 'Tishko', day: '2026-10-05' }];
    const person: Fact[] = [{ fact: 'Always answer me in Arabic.', who: 'Ali', day: '2026-10-05' }];

    expect(memoryPrompt({ company: [], person: [], walk: null, last: null, now: NOW })).toBe('');
    const told = memoryPrompt({ company, person, walk, last, now: later(90) });
    const order = ['WHAT THE COMPANY HAS TAUGHT YOU', 'WHAT YOU KNOW ABOUT THIS PERSON', 'THE WALKTHROUGH THEY ARE IN', 'LAST TIME'].map((part) => told.indexOf(part));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(told).toContain('• Our Najaf warehouse is WH-NJF. (Tishko, 2026-10-05)');
    expect(told).toContain('• Always answer me in Arabic.');
    expect(told).toContain('"Post sales invoice INV-HQ-2026-000001", document INV-HQ-2026-000001: step 2 of 3.');
    expect(told).toContain('✓ 1. Approve opening stock OPN-HQ-2026-000001\n→ 2. Open the invoice and press Post\n  3. Check the customer statement');
    expect(told).toContain('Before you say ✓ for step 2, look for this in the system: the invoice reads posted and has a journal');
    expect(told).toMatch(/done \/ next \/ ok \/ تم \/ خلصت \/ التالي: CHECK the system first — document_story, review_document or a live picture/);
    expect(told).toMatch(/LAST TIME — on 2026-10-05 12:30 \(Baghdad\) they asked: "why is the customer account empty\?"/);
    expect(told).toMatch(/So "continue", "go on", "كمل"/);

    // Inside the hour the conversation is still in front of him; after a fortnight it is nobody's "continue".
    expect(memoryPrompt({ company: [], person: [], walk: null, last, now: later(30) })).toBe('');
    expect(memoryPrompt({ company: [], person: [], walk: null, last, now: later(61) })).toContain('LAST TIME');
    expect(memoryPrompt({ company: [], person: [], walk: null, last, now: later(15 * 24 * 60) })).toBe('');
    // A walkthrough nobody has touched for a day is not theirs any more; one whose steps are all done says so.
    expect(memoryPrompt({ company: [], person: [], walk, last: null, now: later(25 * 60) })).toBe('');
    expect(memoryPrompt({ company: [], person: [], walk: { ...walk, current: 4 }, last: null, now: NOW })).toMatch(/all 3 steps are done[\s\S]*clear the walkthrough/);

    // It never crowds out the instructions it sits in: the newest facts are the ones kept.
    const many: Fact[] = Array.from({ length: 60 }, (_, index) => ({ fact: `Fact number ${index + 1}: ${'x'.repeat(250)}`, who: 'Tishko', day: '2026-10-05' }));
    const crowded = memoryPrompt({ company: many, person, walk, last, now: later(90) });
    expect(crowded.length).toBeLessThanOrEqual(MEMORY_PROMPT_CAP);
    expect(crowded).toContain('Fact number 60:');
    expect(crowded).not.toContain('Fact number 1:');
    expect(crowded).toMatch(/\(\d+ older fact\(s\) are kept and not shown here\.\)/);
    expect(crowded).toContain('THE WALKTHROUGH THEY ARE IN');
    expect(crowded).toContain('LAST TIME');
  });
});

describe('requests, one file each', () => {
  it('files each under the next number of the day and rewrites the index', () => {
    expect(notesDir()).toBe(dir);
    expect([...REQUEST_KINDS]).toEqual(['new_field', 'new_feature', 'workflow_change', 'wrong_behaviour', 'report', 'other']);
    expect([...REQUEST_STATUSES]).toEqual(['needs_answers', 'open', 'ready', 'in_progress', 'done', 'declined']);

    const first = recordRequest({ who: WHO, chat: CHAT, request: loanField, now: NOW });
    expect(first.id).toBe('REQ-20261005-001');
    expect(first.file).toBe(join(dir, 'requests', 'REQ-20261005-001.md'));
    const second = recordRequest({
      who: 'Ali <ali@qs-groups.com> · branch HQ',
      chat: CHAT,
      request: { title: 'ASYCUDA: keep the broker name per declaration', kind: 'new_field', area: 'ASYCUDA', wanted: 'A Broker field on each reading.', why: 'Two brokers clear for us and the fees differ.' },
      now: later(5),
    });
    expect(second.id).toBe('REQ-20261005-002');
    // The next day starts again at one.
    expect(recordRequest({ who: WHO, chat: CHAT, request: { ...loanField, title: 'Another' }, now: later(24 * 60) }).id).toBe('REQ-20261006-001');

    expect(readdirSync(join(dir, 'requests')).sort()).toEqual(['INDEX.md', 'REQ-20261005-001.md', 'REQ-20261005-002.md', 'REQ-20261006-001.md']);
    const index = readFileSync(join(dir, 'requests', 'INDEX.md'), 'utf8');
    expect(index).toContain('# Requests kept by Noah');
    const rows = index.split('\n').filter((line) => line.startsWith('| [REQ-'));
    // Newest first, one line each.
    expect(rows.map((row) => row.slice(3, 19))).toEqual(['REQ-20261006-001', 'REQ-20261005-002', 'REQ-20261005-001']);
    expect(rows[1]).toBe('| [REQ-20261005-002](REQ-20261005-002.md) | ASYCUDA: keep the broker name per declaration | new field | ASYCUDA | open | Ali | 2026-10-05 |');
    expect(rows[2]).toContain('| needs answers | Tishko | 2026-10-05 |');

    expect(readRequest('req-20261005-001')).toContain('# REQ-20261005-001 — Add a guarantor to Bank Loans');
    expect(readRequest('REQ-20261005-009')).toBeNull();
    for (const bad of ['', '../INDEX', 'REQ-1', 'REQ-20261005-001.md', 'INDEX']) expect(readRequest(bad), bad).toBeNull();
  });

  it('a number already taken by somebody else at that instant is stepped over, and nobody is written over', () => {
    recordRequest({ who: WHO, chat: CHAT, request: loanField, now: NOW });
    // Somebody else's file, appearing under the next number before this one is written.
    writeFileSync(join(dir, 'requests', 'REQ-20261005-003.md'), '# REQ-20261005-003 — theirs\n- Status: open\n', 'utf8');
    const mine = recordRequest({ who: WHO, chat: CHAT, request: { ...loanField, title: 'Mine' }, now: NOW });
    expect(mine.id).toBe('REQ-20261005-004');
    expect(readFileSync(join(dir, 'requests', 'REQ-20261005-003.md'), 'utf8')).toContain('theirs');
  });

  it('refuses, by throwing a sentence to say back, a request that says neither what nor why', () => {
    expect(() => recordRequest({ who: WHO, chat: CHAT, request: { ...loanField, wanted: '', why: '' }, now: NOW })).toThrow(/Ask them what they want and why first/);
    expect(existsSync(join(dir, 'requests'))).toBe(false);
    // A page pasted into one field is cut, not refused.
    const long = recordRequest({ who: WHO, chat: CHAT, request: { ...loanField, today: 'a'.repeat(9_000) }, now: NOW });
    expect(readFileSync(long.file, 'utf8')).toContain('a'.repeat(4_000));
    expect(readFileSync(long.file, 'utf8')).not.toContain('a'.repeat(4_001));
    // A kind he made up is filed as "other" rather than lost.
    const odd = recordRequest({ who: WHO, chat: CHAT, request: { ...loanField, kind: 'wish' as never }, now: NOW });
    expect(readFileSync(odd.file, 'utf8')).toContain('- Kind: other');
  });

  it('adds what was learned since: appended, the answered question ticked, the status moved', () => {
    const { id, file } = recordRequest({ who: WHO, chat: CHAT, request: loanField, now: NOW });
    const before = readFileSync(file, 'utf8');

    expect(addToRequest({ id, who: 'Ali', answers: [{ question: 'Can one loan have more than one guarantor?', answer: 'Yes, up to three.' }], now: later(30) })).toEqual({ ok: true, id, status: 'needs_answers' });
    expect(addToRequest({ id: id.toLowerCase(), who: 'Ali', note: 'The bank form has one line per guarantor.', answers: [{ question: 'Should the guarantor print on the loan statement?', answer: 'Yes.' }], now: later(60) })).toEqual({
      ok: true,
      id,
      status: 'open',
    });
    const after = readFileSync(file, 'utf8');
    expect(after).toContain('- Status: open');
    expect(after).not.toContain('- [ ] ');
    expect(after.match(/- \[x\] /g)).toHaveLength(2);
    expect(after).toContain('### 2026-10-05 13:00 (Baghdad) — Ali');
    expect(after).toContain('### 2026-10-05 13:30 (Baghdad) — Ali');
    expect(after).toContain('The bank form has one line per guarantor.');
    // What was asked for, and why, are word for word what they were.
    for (const section of ['## What is wanted', '## Why', "## Noah's reading"]) {
      const was = before.slice(before.indexOf(section), before.indexOf('\n## ', before.indexOf(section) + 1));
      expect(after, section).toContain(was);
    }
    // The index follows.
    expect(readFileSync(join(dir, 'requests', 'INDEX.md'), 'utf8')).toContain('| open | Tishko | 2026-10-05 |');

    expect(addToRequest({ id, who: WHO, status: 'in_progress', now: later(90) })).toEqual({ ok: true, id, status: 'in_progress' });
    expect(listRequests({ status: 'in progress' })).toContain(`${id} · in progress · new field · Bank Loans`);

    // Refusals come back as values: no such request, not a number, nothing to add.
    expect(addToRequest({ id: 'REQ-20261005-777', who: WHO, note: 'x' })).toEqual({ ok: false, reason: 'There is no request REQ-20261005-777 on file.' });
    expect(addToRequest({ id: '../../INDEX', who: WHO, note: 'x' })).toMatchObject({ ok: false, reason: expect.stringMatching(/is not a request number/) });
    expect(addToRequest({ id, who: WHO })).toMatchObject({ ok: false, reason: expect.stringMatching(/Nothing to add/) });
    expect(addToRequest({ id, who: WHO, status: 'someday' as never })).toMatchObject({ ok: false });
  });

  it('lists them for him, filtered by where they stand and by what was said', () => {
    expect(listRequests()).toBe('No request is on file yet.');
    recordRequest({ who: WHO, chat: CHAT, request: loanField, now: NOW });
    recordRequest({ who: 'Ali', chat: CHAT, request: { title: 'HR: leave is approved by the wrong person', kind: 'workflow_change', area: 'HR leave', wanted: 'The department head approves, not the direct manager.', why: 'Managers are often on site.', rightWay: '1. Employee asks. 2. Department head approves. 3. HR records.' }, now: later(10) });
    const all = listRequests();
    expect(all.split('\n')[0]).toBe('2 request(s) on file: 1 needs answers, 1 open.');
    expect(all).toContain('REQ-20261005-002 · open · workflow change · HR leave · HR: leave is approved by the wrong person · Ali · 2026-10-05');
    expect(listRequests({ status: 'open' })).not.toContain('REQ-20261005-001 ·');
    expect(listRequests({ search: 'department head' })).toContain('REQ-20261005-002');
    expect(listRequests({ search: 'guarantor' })).toContain('REQ-20261005-001');
    expect(listRequests({ search: 'nothing-like-this' })).toMatch(/None mentioning/);
    expect(readRequest('REQ-20261005-002')).toContain('## The right way (their words)\n1. Employee asks. 2. Department head approves. 3. HR records.');
  });
});

describe('feedback on an answer', () => {
  const wrong = {
    who: WHO,
    chat: CHAT,
    verdict: 'wrong' as const,
    question: 'what is the status of invoice API-HQ-2026-000999?',
    answer: 'There is no such invoice. The four drafts were probably saved with no lines.',
    whatWasWrong: 'The drafts do have lines; a draft total reads 0 until it posts.',
    rightAnswer: 'Say it does not exist, and read the lines before calling a draft empty.',
    tools: ['document_story', 'query'],
  };

  it('a wrong answer is a file, and one line for the test set', () => {
    const filed = recordFeedback({ ...wrong, now: NOW });
    expect(filed.id).toBe('FB-20261005-001');
    const text = readFileSync(filed.file, 'utf8');
    expect(text.split('\n')[0]).toBe('# FB-20261005-001 — a wrong answer');
    expect(text).toContain('- Verdict: wrong 👎');
    expect(text).toContain(`- Who: ${WHO}`);
    expect(text).toContain('- When: 2026-10-05 12:30 (Baghdad)');
    expect(text).toContain('- Tools he used: document_story → query');
    expect(text).toContain('## The question\n> what is the status of invoice API-HQ-2026-000999?');
    for (const heading of ['## The answer he gave', '## What was wrong with it', '## The right answer']) expect(text, heading).toContain(heading);

    const second = recordFeedback({ ...wrong, question: 'another one', answer: 'x'.repeat(5_000), now: later(1) });
    expect(second.id).toBe('FB-20261005-002');
    const lines = readFileSync(join(dir, 'feedback', 'eval-candidates.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({
      id: 'FB-20261005-001',
      at: NOW.toISOString(),
      question: wrong.question,
      answer: wrong.answer,
      whatWasWrong: wrong.whatWasWrong,
      rightAnswer: wrong.rightAnswer,
      tools: ['document_story', 'query'],
    });
    // The answer as it was given, cut at 4,000.
    expect((JSON.parse(lines[1]!) as { answer: string }).answer).toHaveLength(4_000);
  });

  it('a good answer is a file and no candidate; a verdict on nothing is refused', () => {
    const filed = recordFeedback({ who: WHO, chat: CHAT, verdict: 'good', question: 'how do I add a supplier?', answer: 'Step 1 …', now: NOW });
    expect(readFileSync(filed.file, 'utf8')).toContain('- Verdict: good 👍');
    expect(readFileSync(filed.file, 'utf8')).toContain('- Tools he used: none');
    expect(existsSync(join(dir, 'feedback', 'eval-candidates.jsonl'))).toBe(false);
    expect(() => recordFeedback({ who: WHO, chat: CHAT, verdict: 'wrong', question: ' ', answer: '', now: NOW })).toThrow(/no earlier answer of yours here to mark/);
    expect(() => recordFeedback({ who: WHO, chat: CHAT, verdict: 'meh' as never, question: 'q', answer: 'a', now: NOW })).toThrow(/wrong or good/);
  });
});

describe('memory', () => {
  it('what the company taught him and what a person asked him to keep come back in his instructions', () => {
    expect(memoryForPrompt({ userId: TISHKO, now: NOW })).toBe('');
    expect(remember({ userId: TISHKO, who: WHO, scope: 'company', fact: 'Our Najaf warehouse is WH-NJF.', now: NOW })).toEqual({
      ok: true,
      said: 'Kept as a fact about the company: "Our Najaf warehouse is WH-NJF." (told by Tishko).',
    });
    expect(remember({ userId: ALI, who: 'Ali <ali@qs-groups.com>', scope: 'company', fact: 'Panels are counted in pieces, never in kilograms.', now: later(1) })).toMatchObject({ ok: true });
    expect(remember({ userId: ALI, who: 'Ali <ali@qs-groups.com>', scope: 'me', fact: 'Always answer me in Arabic.', now: later(2) })).toEqual({ ok: true, said: 'Kept about this person: "Always answer me in Arabic.".' });

    const company = readFileSync(join(dir, 'memory', 'company.md'), 'utf8');
    expect(company).toContain('# What the company has taught Noah');
    expect(company).toContain('- Our Najaf warehouse is WH-NJF. — Tishko, 2026-10-05\n- Panels are counted in pieces, never in kilograms. — Ali, 2026-10-05\n');
    expect(readFileSync(join(dir, 'memory', 'people', `${ALI}.md`), 'utf8')).toContain('# What Noah knows about Ali');

    // Everybody is told the company's facts; each person only their own.
    const forAli = memoryForPrompt({ userId: ALI, now: later(3) });
    expect(forAli).toContain('• Our Najaf warehouse is WH-NJF. (Tishko, 2026-10-05)');
    expect(forAli).toContain('• Always answer me in Arabic.');
    const forTishko = memoryForPrompt({ userId: TISHKO, now: later(3) });
    expect(forTishko).toContain('• Panels are counted in pieces, never in kilograms. (Ali, 2026-10-05)');
    expect(forTishko).not.toContain('Always answer me in Arabic');
    expect(forTishko).not.toContain('WHAT YOU KNOW ABOUT THIS PERSON');
  });

  it('refuses a secret, a duplicate, and a user id that is not one — as values, and nothing is written', () => {
    expect(remember({ userId: TISHKO, who: WHO, scope: 'me', fact: 'my password is Rafidain2026', now: NOW })).toMatchObject({ ok: false, reason: expect.stringMatching(/I do not keep passwords or codes/) });
    expect(remember({ userId: TISHKO, who: WHO, scope: 'me', fact: 'I am the Erbil storekeeper', now: NOW })).toMatchObject({ ok: true });
    expect(remember({ userId: TISHKO, who: WHO, scope: 'me', fact: 'i am the erbil storekeeper.', now: NOW })).toMatchObject({ ok: false, reason: expect.stringMatching(/Already known/) });
    expect(remember({ userId: TISHKO, who: WHO, scope: 'nobody' as never, fact: 'x y z', now: NOW })).toMatchObject({ ok: false });
    for (const bad of ['../../../etc/cron.d/x', `${TISHKO}/../x`, '', 'tishko']) {
      expect(remember({ userId: bad, who: WHO, scope: 'me', fact: 'A fact about nobody', now: NOW }), bad).toMatchObject({ ok: false, reason: expect.stringMatching(/whose memory/) });
      expect(forget({ userId: bad, scope: 'me', match: 'fact' })).toEqual({ removed: 0 });
      expect(() => saveWalkthrough({ userId: bad, title: 'T', steps: ['one'], current: 1, now: NOW })).toThrow(/whose walkthrough/);
      expect(readWalkthrough(bad, NOW)).toBeNull();
      expect(() => clearWalkthrough(bad)).not.toThrow();
      expect(() => noteExchange({ userId: bad, question: 'q', answer: 'a', tools: [], now: NOW })).not.toThrow();
    }
    // Only the one real person's file exists: nothing was written under a made-up name.
    expect(readdirSync(join(dir, 'memory', 'people'))).toEqual([`${TISHKO}.md`]);
    expect(existsSync(join(dir, 'memory', 'walk'))).toBe(false);
    expect(existsSync(join(dir, 'memory', 'last'))).toBe(false);
  });

  it('keeps no more than its cap — the oldest is let go and said — and forgets what it is told to', () => {
    for (let n = 1; n <= PERSON_FACT_CAP; n += 1) expect(remember({ userId: TISHKO, who: WHO, scope: 'me', fact: `Fact about me number ${n}`, now: NOW }).ok).toBe(true);
    const over = remember({ userId: TISHKO, who: WHO, scope: 'me', fact: 'One more than fits', now: NOW });
    expect(over).toEqual({ ok: true, said: 'Kept about this person: "One more than fits". The oldest was let go to make room: "Fact about me number 1".' });
    const kept = parseFacts(readFileSync(join(dir, 'memory', 'people', `${TISHKO}.md`), 'utf8'));
    expect(kept).toHaveLength(PERSON_FACT_CAP);
    expect(kept[0]!.fact).toBe('Fact about me number 2');
    expect(kept[kept.length - 1]!.fact).toBe('One more than fits');

    expect(forget({ userId: TISHKO, scope: 'me', match: 'number 2' })).toEqual({ removed: 11 }); // 2, 20–29
    expect(forget({ userId: TISHKO, scope: 'me', match: 'ONE MORE' })).toEqual({ removed: 1 });
    expect(forget({ userId: TISHKO, scope: 'me', match: 'never said' })).toEqual({ removed: 0 });
    // Too short a word forgets nothing, rather than everything.
    expect(forget({ userId: TISHKO, scope: 'me', match: 'a' })).toEqual({ removed: 0 });
    expect(forget({ userId: TISHKO, scope: 'company', match: 'anything' })).toEqual({ removed: 0 });
    const left = readFileSync(join(dir, 'memory', 'people', `${TISHKO}.md`), 'utf8');
    expect(left).toContain('# What Noah knows about Tishko');
    expect(parseFacts(left)).toHaveLength(PERSON_FACT_CAP - 12);
    expect(memoryForPrompt({ userId: TISHKO, now: NOW })).not.toContain('One more than fits');
  });
});

describe('the walkthrough somebody is in, and the last thing they asked', () => {
  const steps = ['Approve opening stock OPN-HQ-2026-000001', '2. Open the invoice and press Post', '- Check the customer statement'];

  it('is kept with the step they are on, read back, moved on, and gone after a day or when cleared', () => {
    expect(readWalkthrough(TISHKO, NOW)).toBeNull();
    const saved = saveWalkthrough({ userId: TISHKO, title: 'Post sales invoice INV-HQ-2026-000001', steps, current: 1, document: 'INV-HQ-2026-000001', check: 'the opening stock reads approved', now: NOW });
    // A numbered or bulleted step is kept as the step itself.
    expect(saved).toEqual({
      title: 'Post sales invoice INV-HQ-2026-000001',
      steps: ['Approve opening stock OPN-HQ-2026-000001', 'Open the invoice and press Post', 'Check the customer statement'],
      current: 1,
      document: 'INV-HQ-2026-000001',
      check: 'the opening stock reads approved',
      startedAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    expect(readWalkthrough(TISHKO, later(60))).toEqual(saved);
    expect(readWalkthrough(ALI, later(60))).toBeNull();

    // They said done, he checked, and it moves on: the same walkthrough, begun when it began.
    const moved = saveWalkthrough({ userId: TISHKO, title: saved.title, steps, current: 2, document: 'INV-HQ-2026-000001', now: later(120) });
    expect(moved).toMatchObject({ current: 2, check: null, startedAt: NOW.toISOString(), updatedAt: later(120).toISOString() });
    const told = memoryForPrompt({ userId: TISHKO, now: later(121) });
    expect(told).toContain('step 2 of 3');
    expect(told).toContain('✓ 1. Approve opening stock OPN-HQ-2026-000001\n→ 2. Open the invoice and press Post\n  3. Check the customer statement');

    // The step number is held to the steps there are; past the last means all done.
    expect(saveWalkthrough({ userId: TISHKO, title: saved.title, steps, current: 99, now: later(130) }).current).toBe(4);
    expect(saveWalkthrough({ userId: TISHKO, title: saved.title, steps, current: 0, now: later(131) }).current).toBe(1);
    expect(() => saveWalkthrough({ userId: TISHKO, title: ' ', steps, current: 1, now: NOW })).toThrow(/needs a title/);
    expect(() => saveWalkthrough({ userId: TISHKO, title: 'T', steps: [' '], current: 1, now: NOW })).toThrow(/needs its steps/);
    expect(() => saveWalkthrough({ userId: TISHKO, title: 'T', steps: Array.from({ length: 21 }, (_, n) => `step ${n + 1}`), current: 1, now: NOW })).toThrow(/up to 20/);

    // Untouched for more than a day, it is not theirs any more.
    expect(readWalkthrough(TISHKO, later(131 + 24 * 60 - 1))).not.toBeNull();
    expect(readWalkthrough(TISHKO, later(131 + 24 * 60 + 1))).toBeNull();
    expect(memoryForPrompt({ userId: TISHKO, now: later(131 + 24 * 60 + 1) })).not.toContain('THE WALKTHROUGH');

    clearWalkthrough(TISHKO);
    expect(readWalkthrough(TISHKO, later(132))).toBeNull();
    expect(() => clearWalkthrough(TISHKO)).not.toThrow();
    // A file that is not a walkthrough is none.
    writeFileSync(join(dir, 'memory', 'walk', `${TISHKO}.json`), 'not json', 'utf8');
    expect(readWalkthrough(TISHKO, later(132))).toBeNull();
  });

  it('the last exchange is kept short, and is in his instructions only between the hour and the fortnight', () => {
    noteExchange({ userId: TISHKO, question: 'q'.repeat(900), answer: 'a'.repeat(900), tools: ['stuck_documents', 'review_document'], now: NOW });
    const kept = JSON.parse(readFileSync(join(dir, 'memory', 'last', `${TISHKO}.json`), 'utf8')) as { at: string; question: string; answer: string; tools: string[] };
    expect(kept.at).toBe(NOW.toISOString());
    expect(kept.question).toHaveLength(400);
    expect(kept.answer).toHaveLength(600);
    expect(kept.tools).toEqual(['stuck_documents', 'review_document']);

    noteExchange({ userId: TISHKO, question: 'what is stuck?', answer: 'Three documents are waiting.', tools: ['stuck_documents'], now: NOW });
    expect(memoryForPrompt({ userId: TISHKO, now: later(59) })).toBe('');
    const told = memoryForPrompt({ userId: TISHKO, now: later(61) });
    expect(told).toContain('LAST TIME — on 2026-10-05 12:30 (Baghdad) they asked: "what is stuck?"');
    expect(told).toContain('Your answer began: "Three documents are waiting."');
    expect(told).toContain('You read: stuck_documents.');
    expect(memoryForPrompt({ userId: TISHKO, now: later(13 * 24 * 60) })).toContain('LAST TIME');
    expect(memoryForPrompt({ userId: TISHKO, now: later(14 * 24 * 60 + 1) })).toBe('');
    // Somebody else's last question is not this person's.
    expect(memoryForPrompt({ userId: ALI, now: later(61) })).toBe('');
  });

  it('never throws: a note that cannot be kept must not lose the answer it was a note of', () => {
    // A folder that cannot be made: its parent is a file.
    const blocker = join(dir, 'a-file');
    writeFileSync(blocker, 'x', 'utf8');
    process.env.NOAH_NOTES_DIR = join(blocker, 'under-a-file');
    expect(() => noteExchange({ userId: TISHKO, question: 'q', answer: 'a', tools: [], now: NOW })).not.toThrow();
    expect(() => noteExchange({ userId: TISHKO, question: null as never, answer: undefined as never, tools: null as never })).not.toThrow();
    expect(memoryForPrompt({ userId: TISHKO, now: later(120) })).toBe('');
    expect(memoryForPrompt({ userId: 'not-a-user', now: later(120) })).toBe('');
    expect(listRequests()).toBe('No request is on file yet.');
    expect(readRequest('REQ-20261005-001')).toBeNull();
  });
});
