/**
 * REQ-AP-001 — the invoice intake, end to end with a fake brain.
 *
 * The model is replaced by a stub that answers exactly what a model would,
 * so what is tested is the part that must be right whatever the model does:
 * the file becomes words, the answer becomes a draft, every gap is flagged,
 * the items are matched only where that is safe, and a file nobody can read
 * comes back as a sentence rather than an exception.
 */
import { describe, expect, it } from 'vitest';
import { draftFromDocument } from '@/server/services/invoice-draft';
import type { AgentClient } from '@/server/domain/whatsapp-agent';

/** A brain that answers with whatever it was handed. */
const brain = (answer: unknown, seen?: { prompt?: string; system?: string }): AgentClient => ({
  create: async (input) => {
    if (seen) {
      seen.system = input.system;
      seen.prompt = input.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
    }
    return { content: [{ type: 'text', text: typeof answer === 'string' ? answer : JSON.stringify(answer) }] };
  },
});

/** The item master, as the matcher sees it. */
const CATALOGUE = [
  { code: 'SOL-550', name: 'Solar Panel 550W' },
  { code: 'INV-5K', name: 'Inverter 5kW' },
];

const INVOICE = Buffer.from('item,qty,price\nSolar Panel 550W,100,88.50\n', 'utf8');

describe('AP-12 · a document becomes a draft', () => {
  it('reads the goods and matches the item it plainly is', async () => {
    const outcome = await draftFromDocument({
      fileName: 'invoice.csv',
      content: INVOICE,
      model: 'claude-opus-5-5',
      catalogue: CATALOGUE,
      client: brain({
          supplierName: 'Jinko Solar',
          invoiceNo: 'JK-1',
          invoiceDate: '2026-09-18',
          currency: 'USD',
          lines: [{ description: 'Solar Panel 550W', quantity: '100', unitPrice: '88.50', confidence: 'sure' }],
        }),
    });

    expect(outcome.draft.supplierName).toBe('Jinko Solar');
    expect(outcome.draft.currency).toBe('USD');
    expect(outcome.draft.lines[0]).toMatchObject({ itemCode: 'SOL-550', quantity: '100', unitPrice: '88.50' });
    expect(outcome.flags).toHaveLength(0);
    expect(outcome.source.kind).toBe('text');
  });

  it('hands the model the rules and the document, and nothing else', async () => {
    const seen: { prompt?: string; system?: string } = {};
    await draftFromDocument({
      fileName: 'invoice.csv',
      content: INVOICE,
      model: 'claude-opus-5-5',
      catalogue: CATALOGUE,
      client: brain({ lines: [] }, seen),
    });
    expect(seen.system).toMatch(/Never invent/);
    expect(seen.prompt).toContain('Solar Panel 550W,100,88.50');
  });

  it('reads an answer the model wrapped in a code fence', async () => {
    const outcome = await draftFromDocument({
      fileName: 'invoice.csv',
      content: INVOICE,
      model: 'claude-opus-5-5',
      catalogue: CATALOGUE,
      client: brain('```json\n{"supplierName":"Jinko","currency":"USD","lines":[]}\n```'),
    });
    expect(outcome.draft.supplierName).toBe('Jinko');
  });

  it('flags what the model left out instead of filling it', async () => {
    const outcome = await draftFromDocument({
      fileName: 'invoice.csv',
      content: INVOICE,
      model: 'claude-opus-5-5',
      catalogue: CATALOGUE,
      client: brain({ supplierName: null, currency: null, lines: [{ description: 'Mystery part' }] }),
    });
    const fields = outcome.flags.map((flag) => flag.field);
    expect(fields).toContain('supplierName');
    expect(fields).toContain('currency');
    expect(fields).toContain('lines[0].quantity');
    // Nothing in the catalogue is plainly a "Mystery part", so a person picks.
    expect(outcome.draft.lines[0]!.itemCode).toBeNull();
    expect(fields).toContain('lines[0].itemCode');
  });

  it('never fills in a warehouse, because the goods are not in one', async () => {
    // By direction (2026-10-03): an import's goods are in process. The draft
    // carries the goods and their prices and leaves the destination to the
    // container receipt.
    const outcome = await draftFromDocument({
      fileName: 'invoice.csv',
      content: INVOICE,
      model: 'claude-opus-5-5',
      catalogue: CATALOGUE,
      client: brain({ lines: [{ description: 'Solar Panel 550W', quantity: '1', unitPrice: '1', confidence: 'sure' }] }),
    });
    expect(Object.keys(outcome.draft.lines[0]!)).not.toContain('warehouseCode');
  });
});

describe('AP-12 · a file it cannot read', () => {
  it('says what is wrong instead of throwing', async () => {
    const outcome = await draftFromDocument({
      fileName: 'invoice.jpg',
      content: Buffer.from([0xff, 0xd8]),
      model: 'claude-opus-5-5',
      catalogue: CATALOGUE,
      client: brain({ lines: [] }),
    });
    expect(outcome.draft.lines).toHaveLength(0);
    expect(outcome.draft.note).toMatch(/cannot be read here/);
    expect(outcome.source.kind).toBe('unreadable');
  });

  it('asks for the old Word format to be re-saved', async () => {
    const outcome = await draftFromDocument({
      fileName: 'invoice.doc',
      content: Buffer.from('anything'),
      model: 'claude-opus-5-5',
      catalogue: CATALOGUE,
      client: brain({ lines: [] }),
    });
    expect(outcome.draft.note).toMatch(/Save it as \.docx or PDF/);
  });

  it('survives a model that answers with prose', async () => {
    const outcome = await draftFromDocument({
      fileName: 'invoice.csv',
      content: INVOICE,
      model: 'claude-opus-5-5',
      catalogue: CATALOGUE,
      client: brain('I had a look and it seems to be an invoice of some kind.'),
    });
    expect(outcome.draft.lines).toHaveLength(0);
    expect(outcome.draft.note).toMatch(/did not answer with an invoice/);
  });
});
