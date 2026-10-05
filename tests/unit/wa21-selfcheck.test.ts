/**
 * Before an answer goes — is everything in it something he read?
 *
 * 2026-10-05, by direction: "Self-check on every answer: before sending, every
 * figure and document number in his answer is verified against what he
 * actually read."
 *
 * The answers below are his own, word for word, from the first full run of the
 * test set (`var/noah/eval-20261005-0052.json`); what he "read" is written out
 * in the shape the tools hand it to him. A check that cries wolf costs a whole
 * extra round of the model, so most of this file is about what must NOT be
 * flagged: his real answers, a date, a year, a telephone, a pattern, a total
 * he added up.
 */
import { describe, expect, it } from 'vitest';
import { correctionFor, isClean, unsupportedIn } from '@domain/whatsapp-selfcheck';

// ---------------------------------------------------------------------------
// What he read, and what he said
// ---------------------------------------------------------------------------

const STORY_000001 = [
  'API-HQ-2026-000001 · purchase invoice · status: POSTED · branch HQ',
  'supplier: SUP-000001 · vdfvd',
  'dated 2026-10-04 · due 2026-10-04',
  'total 250,000 IQD · settled 0 IQD · an IMPORT (its goods go through the import application and the stage warehouses)',
  'its page: http://localhost:3000/payables/invoices/API-HQ-2026-000001',
  '',
  'WHO: raised by System Administrator on 04/10/2026 13:14 · submitted by System Administrator · posted by System Administrator on 04/10/2026 13:16',
  '',
  'LINES (1):',
  '1. ITM-SEED · Seed Cable 2m — 500 EA × 500 · warehouse WH-INPROC',
  '',
  'JOURNAL JE-2026-000001 · posted · posting date 2026-10-04:',
  '1. Dr 250,000 — A100010 · Inventory · WH-INPROC',
  '2. Cr 250,000 — L100010 · Trade Payables · SUP-000001',
  '',
  'STOCK MOVEMENTS (1):',
  '2026-10-04 · purchase receipt · ITM-SEED · 500 · warehouse WH-INPROC',
  '',
  'PAYMENTS AGAINST IT: none.',
].join('\n');

const SAID_000001 = `*API-HQ-2026-000001* is *POSTED*. It is in the books.

*Supplier:* SUP-000001 · vdfvd
*Dated:* 2026-10-04 · *due:* 2026-10-04
*Total:* 250,000 IQD · *paid so far:* 0 IQD
*Type:* import purchase invoice, branch HQ

*What it bought*
1. ITM-SEED · Seed Cable 2m: 500 EA × 500 IQD = 250,000 IQD, into warehouse WH-INPROC

*What it posted* (journal JE-2026-000001, posting date 2026-10-04)
1. Dr 250,000 to A100010 · Inventory
2. Cr 250,000 to L100010 · Trade Payables (SUP-000001)

The 500 cables are in *WH-INPROC* (In Process). The company owns them, but they are counted as goods in transit and can't be sold yet.

*Who did what:* you raised it, submitted it and posted it yourself on 04/10/2026, between 13:14 and 13:16. That's allowed because you're a super user, and in this testing phase everybody is one.

*Worth a look*
1. The due date is the same as the invoice date, so it was already 1 day overdue today.
2. Nothing has been paid against it yet.

*Next steps*
3. If it was only a test entry, it can be reversed with a reason. Reply *!ai reverse* if you want me to set that up.

— QS ERP · as of 2026-10-04 22:53 UTC · branch HQ · read as System Administrator`;

const ASKED_000003 = 'شنو وضع الفاتورة API-HQ-2026-000003 وشنو الخطوة الجاية؟';
const STORY_000003 = [
  'API-HQ-2026-000003 · purchase invoice · status: DRAFT · branch HQ',
  'supplier: SUP-00001 · Al-Rafidain Trading Co.',
  'dated 2026-10-04 · due 2026-10-04',
  'an IMPORT',
  'its page: http://localhost:3000/payables/invoices/API-HQ-2026-000003',
  'WHO: raised by System Administrator on 04/10/2026 13:30',
  'LINES (1):',
  '1. ITM-SEED · Seed Cable 2m — 1 EA × 1,000 · warehouse WH-INPROC',
  'JOURNAL: none — this document has written NOTHING to the ledger.',
].join('\n');
const REVIEW_000003 = [
  'API-HQ-2026-000003 · purchase invoice · status: DRAFT · branch HQ',
  'VERDICT: nothing would stop it — 4 warnings.',
  'WARNINGS (4):',
  '! The same supplier, date and lines are on API-HQ-2026-000002, API-HQ-2026-000004, API-HQ-2026-000005 — entered more than once?',
  '! Line 1 buys ITM-SEED at 1,000; the last posted purchase was at 500 (API-HQ-2026-000001) — 100% more.',
  '! The due date (2026-10-04) is the invoice date.',
  '! It is an import priced in IQD.',
  'FINE — checked and in order: the period (2026-10) is open; the supplier (SUP-00001) is active.',
].join('\n');

const SAID_000003 = `الفاتورة *API-HQ-2026-000003* بعدها *مسودة (Draft)*، يعني محفوظة بس ما انرحلت (ما انسجلت بالدفاتر).

*تفاصيلها:*
المورد: SUP-00001 · Al-Rafidain Trading Co.
التاريخ: 2026-10-04، وتاريخ الاستحقاق نفس اليوم
بيها سطر واحد: ITM-SEED · Seed Cable 2m، قطعة وحدة بسعر 1,000 دينار، على المخزن WH-INPROC (مخزن البضاعة اللي بعدها بالطريق)
سوّاها System Administrator بتاريخ 04/10/2026 الساعة 13:30

ما كو شي يمنع ترحيلها، والفترة (2026-10) مفتوحة. بس قبل ما تكمل، شوف هالـ 4 ملاحظات:

1. *يبين انها مدخلة أكثر من مرة:* الفواتير API-HQ-2026-000002 و 000004 و 000005 كلها مسودات من نفس المورد وبنفس التاريخ ونفس السطور.
2. *السعر:* 1,000، وآخر شراء لنفس المادة كان بـ 500 (بالفاتورة API-HQ-2026-000001). الفرق أكثر من 30%، فتأكد منه.
3. *تاريخ الاستحقاق نفس تاريخ الفاتورة*، فراح تطلع مستحقة فوراً.

*شنو يصير لما تنرحل:* المورد يصير يطلب 1,000 دينار، والكيبل يدخل لمخزن WH-INPROC.

رابطها: http://localhost:3000/payables/invoices/API-HQ-2026-000003

إذا الملاحظات كلها تمام وتريدني أجهّز تقديمها، اكتب *!ai قدّمها*.`;

const STUCK = [
  '13 documents are waiting, in 3 groups — oldest first in each. A document in one of these statuses has changed NOTHING in the books yet.',
  '',
  'PURCHASE INVOICES — draft, never sent on (4): waiting to be submitted — nothing is owed and no stock has come in.',
  '• API-HQ-2026-000002 · SUP-00001 · Al-Rafidain Trading Co. · 1,000 IQD · dated 2026-10-04 · raised today by System Administrator',
  '• API-HQ-2026-000003 · SUP-00001 · Al-Rafidain Trading Co. · 1,000 IQD · dated 2026-10-04 · raised today by System Administrator',
  '• API-HQ-2026-000004 · SUP-00001 · Al-Rafidain Trading Co. · 1,000 IQD · dated 2026-10-04 · raised today by System Administrator',
  '• API-HQ-2026-000005 · SUP-00001 · Al-Rafidain Trading Co. · 1,000 IQD · dated 2026-10-04 · raised today by System Administrator',
  'Register: http://localhost:3000/payables/invoices',
  '',
  'PURCHASE ORDERS — submitted, waiting for a second person (5): waiting to be approved.',
  '• PO-HQ-2026-000001 · SUP-000001 · vdfvd · 250,000 IQD · raised today by System Administrator',
  '• PO-HQ-2026-000002 · SUP-00001 · Al-Rafidain Trading Co. · 1,000 IQD',
  '• PO-HQ-2026-000003 · SUP-00001 · Al-Rafidain Trading Co. · 1,000 IQD',
  '• PO-HQ-2026-000004 · SUP-00001 · Al-Rafidain Trading Co. · 1,000 IQD',
  '• PO-HQ-2026-000005 · SUP-00001 · Al-Rafidain Trading Co. · 1,000 IQD',
  '',
  'PAYMENT APPLICATIONS — draft (4): waiting to be approved and sent to the bank.',
  '• PAYAPP-HQ-2026-000001 · SUP-00001 · Al-Rafidain Trading Co. · 500 IQD',
  '• PAYAPP-HQ-2026-000002 · SUP-00001 · Al-Rafidain Trading Co. · 500 IQD',
  '• PAYAPP-HQ-2026-000003 · SUP-00001 · Al-Rafidain Trading Co. · 500 IQD',
  '• PAYAPP-HQ-2026-000004 · SUP-00001 · Al-Rafidain Trading Co. · 500 IQD',
  'Register: http://localhost:3000/payables/payment-applications',
].join('\n');

const SAID_STUCK = `13 documents are waiting. None of them has touched the books yet, and you raised all 13 yourself in the last day.

*Purchase invoices: 4 drafts, never submitted*
API-HQ-2026-000002, 000003, 000004 and 000005
All four are for Al-Rafidain Trading Co. (SUP-00001), all 1,000 IQD and all dated 2026-10-04. They look like the same test entered four times. If you submit all of them, the system will treat it as owing the supplier 4,000 IQD.

*Purchase orders: 5 submitted, waiting for approval*
PO-HQ-2026-000001 is for "vdfvd" (SUP-000001), 250,000. That name looks like keyboard test text.
PO-HQ-2026-000002 to 000005 are for Al-Rafidain Trading Co., 1,000 each.

*Payment applications: 4 drafts*
PAYAPP-HQ-2026-000001 to 000004 are for Al-Rafidain Trading Co., 500 IQD each.

Payment applications are approved on their own screen, at /payables/payment-applications.

Tell me which ones, for example *!ai approve PO-HQ-2026-000002 and submit API-HQ-2026-000002*, or *!ai cancel the duplicate POs*.`;

const BALANCE = ['SUP-000001 · vdfvd — supplier', 'balance: 250,000 IQD owed to them · 190.84 USD', '1 movement this year'].join('\n');
const SAID_BALANCE = `We owe *SUP-000001* (stored as *vdfvd*) *250,000 IQD*.

The statement also shows *190.84 USD*. This is probably the same debt, not a second one:
1. Only one movement has been posted for this supplier this year.
2. 250,000 ÷ 190.84 comes to exactly 1,310, which looks like an exchange rate. That fits a single invoice priced in USD and recorded in the books at its dinar value.`;

const ASKED_JOURNAL = 'enter a journal: debit X100020 70,000 and credit A100001 50,000';
const SAID_JOURNAL = `This journal doesn't balance, so I can't key it yet. Debits are 70,000 and credits are 50,000, which leaves a gap of 20,000 IQD.

Which of these did you mean?

1. *Both 70,000*: debit X100020 70,000, credit A100001 70,000
2. *Both 50,000*: debit X100020 50,000, credit A100001 50,000
3. *Keep both amounts and add a third line* for the 20,000 difference.

Also tell me:
• the date, if it isn't today (2026-10-05)

Start your reply with *!ai*, for example: *!ai option 1, today, office supplies*`;

/** A sale as `document_story` tells it: two lines of one item, their totals at the ends of the lines. */
const STORY_SALE = [
  'INV-HQ-2026-000001 · sales invoice · status: APPROVED · branch HQ',
  'customer: CUS-000001 · عميل تجريبي',
  'net 98,000,000 IQD · received against it 0 IQD',
  'LINES (2):',
  '1. ITM-000001 · RISEN 725W — 10 KG × 175,000 · warehouse WH-HQ → 1,750,000 IQD',
  '2. ITM-000001 · RISEN 725W — 55 KG × 1,750,000 · warehouse WH-HQ → 96,250,000 IQD',
  'JOURNAL: none — this document has written NOTHING to the ledger.',
  'opening stock OPN-HQ-2026-000001: 100 KG @ 1,750 IQD, submitted, not approved',
].join('\n');

const none = { codes: [], figures: [] };

// ---------------------------------------------------------------------------

describe('his real answers, against what he read', () => {
  it('a posted invoice read whole: every number, account, warehouse and figure is from the document', () => {
    expect(unsupportedIn(SAID_000001, ['what is the status of API-HQ-2026-000001?', STORY_000001])).toEqual(none);
  });

  it('an Arabic answer with a link, a period, a percentage and serials named in short', () => {
    expect(unsupportedIn(SAID_000003, [ASKED_000003, STORY_000003, REVIEW_000003])).toEqual(none);
  });

  it('thirteen stuck documents: "000002 to 000005" is not four inventions, and 4 × 1,000 is his to work out', () => {
    expect(unsupportedIn(SAID_STUCK, ["what's stuck right now?", STUCK])).toEqual(none);
  });

  it('a balance in two currencies: the rate he worked back from them is arithmetic, not invention', () => {
    expect(unsupportedIn(SAID_BALANCE, ['how much do we owe supplier SUP-000001?', BALANCE])).toEqual(none);
  });

  it('nothing read at all: the figures and accounts are the ones the person typed, and their difference', () => {
    expect(unsupportedIn(SAID_JOURNAL, [ASKED_JOURNAL])).toEqual(none);
  });
});

describe('a code that is in nothing he read', () => {
  const read = ['what is the status of API-HQ-2026-000001?', STORY_000001];

  it('an invented document number, and a real prefix with a wrong serial', () => {
    expect(unsupportedIn(SAID_000001.replace('journal JE-2026-000001', 'journal JE-2026-000007'), read)).toEqual({ codes: ['JE-2026-000007'], figures: [] });
    expect(unsupportedIn('It was paid by PAY-HQ-2026-000003 and received on GRN-HQ-2026-000002.', read).codes).toEqual(['PAY-HQ-2026-000003', 'GRN-HQ-2026-000002']);
    // Said three times, reported once — as he wrote it, without the bold.
    expect(unsupportedIn('*INV-HQ-2026-000044*, then INV-HQ-2026-000044 again: (INV-HQ-2026-000044).', read).codes).toEqual(['INV-HQ-2026-000044']);
  });

  it('a different zero padding is a different code, and so is the head or the tail of a longer one', () => {
    // The supplier is SUP-000001; SUP-00001 is somebody else.
    expect(unsupportedIn('The supplier is SUP-00001.', read).codes).toEqual(['SUP-00001']);
    expect(unsupportedIn('The supplier is SUP-000001.', read).codes).toEqual([]);
    const longer = ['API-HQ-2026-000015 · purchase invoice', 'XSUP-000009'];
    expect(unsupportedIn('See API-HQ-2026-00001 and API-HQ-2026-000015.', longer).codes).toEqual(['API-HQ-2026-00001']);
    expect(unsupportedIn('See SUP-000009.', longer).codes).toEqual(['SUP-000009']);
  });

  it('an invented account, warehouse, item, partner, container and issue number', () => {
    const said = 'Post it to A100099 from WH-BAGHDAD; item ITM-CABLE of SUP-JINKO for CUS-000777, container MSCU1234567, filed as ISS-20261005-009.';
    expect(unsupportedIn(said, read).codes).toEqual(['A100099', 'WH-BAGHDAD', 'ITM-CABLE', 'SUP-JINKO', 'CUS-000777', 'MSCU1234567', 'ISS-20261005-009']);
    // The same, read from a tool: nothing to say.
    expect(unsupportedIn('Post it to A100010 from WH-INPROC; item ITM-SEED.', read)).toEqual(none);
  });

  it('a name is words, and words are not checked — the code beside it is', () => {
    // 2026-10-05: "it won't show in a real warehouse like مخزن بغداد". No such warehouse; nothing here can know that.
    expect(unsupportedIn("it won't show in a real warehouse like مخزن بغداد", read)).toEqual(none);
    expect(unsupportedIn("it won't show in a real warehouse like مخزن بغداد (WH-BGD)", read).codes).toEqual(['WH-BGD']);
  });

  it('is read whatever the case it was typed in, and with either alphabet\'s digits', () => {
    expect(unsupportedIn('API-HQ-2026-000005 is a draft.', ['status of api-hq-2026-000005 pls']).codes).toEqual([]);
    expect(unsupportedIn('القيد JE-٢٠٢٦-٠٠٠٠٠١ مرحّل.', read).codes).toEqual([]);
    expect(unsupportedIn('القيد JE-٢٠٢٦-٠٠٠٠٠٩ مرحّل.', read).codes).toEqual(['JE-٢٠٢٦-٠٠٠٠٠٩']);
    expect(unsupportedIn('الفاتورة API-HQ-2026-000001 للمورد SUP-000001 والقيد JE-2026-000001 بالمخزن WH-INPROC', read)).toEqual(none);
  });

  it('with nothing read, every code is unsupported', () => {
    expect(unsupportedIn('INV-HQ-2026-000001 is approved; post it from WH-HQ.', []).codes).toEqual(['INV-HQ-2026-000001', 'WH-HQ']);
  });
});

describe('what is never a code', () => {
  it('a pattern or a placeholder somebody is being shown', () => {
    for (const said of [
      'Send me the number, for example !ai INV-…',
      'It looks like API-<number> or API-HQ-2026-<serial>.',
      'Supplier codes are SUP-xxxxx (SUP-XXXXX, SUP-CODE), customers CUS-NNNNNN, orders PO-#, warehouses WH-NAME.',
      'The numbers run INV-HQ-2026-… upward, API-HQ-2026-00000x for the drafts, JE-{YYYY}-{SERIAL} for journals.',
      'Purchase invoice API-…, sales invoice INV-…, journal entry JE-…, opening stock OPN-…',
    ]) {
      expect(unsupportedIn(said, []).codes, said).toEqual([]);
    }
  });

  it('the command he tells them to type repeats a number he read — and is caught when it does not', () => {
    const read = [STORY_SALE];
    expect(unsupportedIn('Reply *!ai post INV-HQ-2026-000001* and I will check it first.', read)).toEqual(none);
    expect(unsupportedIn('Reply *!ai post INV-HQ-2026-000002* and I will check it first.', read).codes).toEqual(['INV-HQ-2026-000002']);
  });

  it('a date, a time, a model, a version, a standard, a period, a currency, an address, plain English', () => {
    const said = [
      'On 2026-10-05 at 13:48 (2026-10-05T22:53:00Z), period 2026-10, FY-2026, OCT-2026, Q3-2026.',
      'The model is claude-opus-5-5, build v1.0.0 (2.1.288), on ISO-6346, UTF-8, SHA-256, HTTP-404, COVID-19, HS-8541, USD-1000.',
      'Write to ali@qs-groups.com or open https://erp.qs-groups.com/sales/ar-invoices and erp.qs-groups.com/profile/security; call +964 782 462 0327.',
      'It is step-by-step, read-only, maker-checker, FIFO-based, first-in-first-out, a 12-character password, the RISEN-725W panel.',
    ].join('\n');
    expect(unsupportedIn(said, [])).toEqual(none);
  });
});

describe('a figure that is in nothing he read', () => {
  const read = ['why can it not be posted?', STORY_SALE];

  it('a made-up amount is flagged; the ones he read are not, however they are written', () => {
    expect(unsupportedIn('The invoice is for 98,000,000 IQD and the cost was 2,340,000 IQD.', read)).toEqual({ codes: [], figures: ['2,340,000'] });
    for (const written of ['98,000,000', '98000000', '98,000,000.00', '٩٨٬٠٠٠٬٠٠٠', '٩٨،٠٠٠،٠٠٠', '98,000,000.0000']) {
      expect(unsupportedIn(`The invoice is for ${written} IQD.`, read).figures, written).toEqual([]);
    }
    // Said twice, reported once.
    expect(unsupportedIn('2,340,000 here and 2,340,000.00 there.', read).figures).toEqual(['2,340,000']);
  });

  it('one step of arithmetic is his to do: a product, a sum, a difference, a price per unit', () => {
    // 10 × 175,000 and 55 × 1,750,000 are on the lines; their totals too.
    expect(unsupportedIn('Line 1 is 10 × 175,000 = 1,750,000 and line 2 is 55 × 1,750,000 = 96,250,000, together 98,000,000.', read)).toEqual(none);
    // 65 are sold and 100 would come in: 35 left (under a thousand, never checked) — and 100 × 1,750 = 175,000 of cost.
    expect(unsupportedIn('After the opening stock is approved 100 − 65 = 35 are left, and the stock is worth 100 × 1,750 = 175,000 IQD.', read)).toEqual(none);
    // The difference of two figures he read, and an amount back from a rate, to the places he wrote it to.
    expect(unsupportedIn('The second line is 94,500,000 more than the first.', read)).toEqual(none);
    expect(unsupportedIn('That is 190.84 USD at 1,310.', ['balance 250,000 IQD', '1 USD = 1,310 IQD on 2026-10-05'])).toEqual(none);
    expect(unsupportedIn('That is 191 USD at 1,310, or 327,500,000 IQD for 250,000 USD.', ['balance 250,000 IQD', '1 USD = 1,310 IQD on 2026-10-05'])).toEqual(none);
  });

  it('a total of several lines is the lines added up', () => {
    const lines = [
      'LINES (3):',
      '1. ITM-000001 · Panel — 10 EA × 100,000 → 1,000,000 IQD',
      '2. ITM-000002 · Inverter — 4 EA × 300,000 → 1,200,000 IQD',
      '3. ITM-000003 · Cable — 30 EA × 10,000 → 300,000 IQD',
    ].join('\n');
    expect(unsupportedIn('The three lines come to 2,500,000 IQD.', [lines])).toEqual(none);
    expect(unsupportedIn('The three lines come to 2,600,000 IQD.', [lines]).figures).toEqual(['2,600,000']);
  });

  it('the number of a line in a list is not a figure of the books: an amount "times two" does not pass on it', () => {
    const lines = ['1. Rent — 1,000,000 IQD', '2. Salaries — 750,000 IQD'].join('\n');
    expect(unsupportedIn('Rent will be 2,000,000 IQD next year.', [lines]).figures).toEqual(['2,000,000']);
    // Where the amount really stands twice, twice it is a sum.
    expect(unsupportedIn('Both together are 2,000,000 IQD.', ['debit 1,000,000', 'credit 1,000,000']).figures).toEqual([]);
  });

  it("a figure the person gave is theirs to hear back, and so is one from an earlier turn", () => {
    expect(unsupportedIn('A journal of 70,000 against 50,000 leaves 20,000.', [ASKED_JOURNAL])).toEqual(none);
    expect(unsupportedIn('As I said, the balance is 4,875,250 IQD.', ['what is the balance?', 'The balance is 4,875,250 IQD.'])).toEqual(none);
  });

  it('money with its fils is a figure however small; a plain count under a thousand is not', () => {
    expect(unsupportedIn('Each one costs 12.50 IQD.', ['250 units worth 3,125 IQD']).figures).toEqual([]);
    expect(unsupportedIn('Each one costs 17.25 IQD.', ['250 units worth 3,125 IQD']).figures).toEqual(['17.25']);
    expect(unsupportedIn('There are 221 migrations, 13 documents, 65 panels and 999 rows.', []).figures).toEqual([]);
  });
});

describe('what is never a figure', () => {
  it('a date, a time, a year, a telephone, a percentage, a step, a version, an address, a size, a serial', () => {
    const said = [
      'Dated 2026-10-04, due 04/10/2026, raised 5 Oct 2026 at 13:48:07 — in 2026, not 2025; period 2026-10; 4.10.2026.',
      'Call +964 782 462 0327 or 0770 192 9191 or 782-462-0327; tag @159386907476204.',
      'It is 30% more, 1,250% of plan, ٪٥٠ of it.',
      'Step 1 of 12, picture 3, line 24, page 2, version 1.0.0, build 2.1.288, #1024.',
      'Open http://localhost:3000/payables/invoices or 127.0.0.1:3200/healthz or erp.qs-groups.com:8443/x, file report_2026.xlsx.',
      'A RISEN 725W panel, a 5000mAh battery, 1500ms, FY2026, v2, 10kW.',
      'Drafts 000002, 000003 and -000004; reference 00012345; digest 23132353051; request 84adc66d-097d-4e67-8738-1b98336330b0.',
      'The check digit is ISO 6346, HS code 8541, port 3200, error 1024, IFRS 1500, رقم 4500.',
      '[picture: muug3u69-48a54ecdad8a]',
      '— QS ERP · as of 2026-10-04 22:53 UTC · branch HQ · read as Tishko',
    ].join('\n');
    expect(unsupportedIn(said, [])).toEqual(none);
  });

  it('but a year-sized amount with its currency is an amount', () => {
    expect(unsupportedIn('It costs 2026 IQD, or $1999.', []).figures).toEqual(['2026', '1999']);
    expect(unsupportedIn('It costs 2,026.', []).figures).toEqual(['2,026']);
  });
});

describe('what is said back to him', () => {
  it('nothing, when there is nothing', () => {
    expect(isClean(none)).toBe(true);
    expect(correctionFor(none)).toBe('');
    expect(isClean({ codes: ['JE-2026-000007'], figures: [] })).toBe(false);
    expect(isClean({ codes: [], figures: ['2,340,000'] })).toBe(false);
  });

  it('a code is wrong until proved otherwise: look it up or take it out', () => {
    const told = correctionFor({ codes: ['JE-2026-000007', 'WH-BGD'], figures: [] });
    expect(told).toMatch(/These are in your answer and in nothing you read: JE-2026-000007, WH-BGD\./);
    expect(told).toMatch(/look each one up now with a tool and use what you find, or take it out/);
    expect(told).toMatch(/Do not keep a document number, a code or a name you did not read/);
    expect(told).toMatch(/give the whole answer again, complete, in the same language — the person sees only this version/);
    expect(told).not.toMatch(/figure/);
  });

  it('a figure alone is asked about more gently: he may have worked it out', () => {
    const one = correctionFor({ codes: [], figures: ['2,340,000'] });
    expect(one).toMatch(/Nothing in it is certainly wrong, but this figure is not in anything you read/);
    expect(one).toMatch(/2,340,000\. If you worked it out, show the working in one line; if you cannot, take it out or read it with a tool/);
    expect(one).not.toMatch(/Do not keep/);
    const two = correctionFor({ codes: [], figures: ['2,340,000', '17.25'] });
    expect(two).toMatch(/these figures are not in anything you read .*: 2,340,000, 17\.25\. If you worked one out/);
    // Beside a wrong code there is no softening.
    const both = correctionFor({ codes: ['JE-2026-000007'], figures: ['2,340,000'] });
    expect(both).toMatch(/These figures are not in anything you read and are not a simple sum, difference or product of figures that are: 2,340,000\./);
    expect(both).not.toMatch(/Nothing in it is certainly wrong/);
  });

  it('never lists more than a dozen of either', () => {
    const many = Array.from({ length: 20 }, (_, index) => `INV-HQ-2026-${String(index + 1).padStart(6, '0')}`);
    const told = correctionFor({ codes: many, figures: [] });
    expect(told).toContain('INV-HQ-2026-000012 — and 8 more.');
    expect(told).not.toContain('INV-HQ-2026-000013');
  });
});

describe('it is quick', () => {
  it('a long answer against everything a long question read, well inside fifty milliseconds', () => {
    // 60,000 characters of what the tools return — documents, journals, a stuck list — and a 6,000-character answer about them.
    const block = (n: number) =>
      [STORY_000001, STORY_SALE, STUCK, REVIEW_000003]
        .join('\n')
        .replaceAll('000001', String(100000 + n).slice(1))
        .replaceAll('250,000', `${250 + n},000`);
    const sources: string[] = [];
    for (let n = 0; sources.join('').length < 60_000; n += 1) sources.push(block(n));
    let answer = '';
    for (let n = 0; answer.length < 6_000; n += 1) answer += `${SAID_STUCK.slice(0, 700)}\nAlso API-HQ-2026-${String(900000 + n)} for ${3_417_000 + n * 13} IQD.\n`;
    expect(sources.join('').length).toBeGreaterThanOrEqual(60_000);
    expect(answer.length).toBeGreaterThanOrEqual(6_000);

    // The best of five: this machine runs other things while it runs this.
    let best = Infinity;
    let found = unsupportedIn(answer, sources);
    for (let run = 0; run < 5; run += 1) {
      const started = performance.now();
      found = unsupportedIn(answer, sources);
      best = Math.min(best, performance.now() - started);
    }
    expect(found.codes.length).toBeGreaterThan(5);
    expect(found.figures.length).toBeGreaterThan(5);
    expect(best).toBeLessThan(50);
  });
});
