/**
 * REQ-AP-001 — reading a supplier's document into text.
 *
 * The invoice from the factory arrives as whatever the supplier happened to
 * use. What matters here is that each format keeps the thing that makes an
 * invoice readable — a price on the same line as what it prices — and that a
 * file which cannot be read says so rather than producing words that look
 * like an invoice and are not.
 */
import { describe, expect, it } from 'vitest';
import { extractDocumentText, wordText } from '@/server/services/document-text';

/** A minimal .docx: a zip whose word/document.xml holds a one-row table. */
async function docx(bodyXml: string): Promise<Buffer> {
  const { deflateRawSync } = await import('node:zlib');
  const name = Buffer.from('word/document.xml', 'utf8');
  const content = Buffer.from(bodyXml, 'utf8');
  const deflated = deflateRawSync(content);
  const { crc32 } = await import('node:zlib');
  const crc = crc32(content);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(deflated.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42); // offset of the local header

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + name.length, 12);
  eocd.writeUInt32LE(local.length + name.length + deflated.length, 16);

  return Buffer.concat([local, name, deflated, central, name, eocd]);
}

const TABLE = `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>
<w:p><w:r><w:t>COMMERCIAL INVOICE</w:t></w:r></w:p>
<w:tbl><w:tr>
  <w:tc><w:p><w:r><w:t>Solar Panel 550W</w:t></w:r></w:p></w:tc>
  <w:tc><w:p><w:r><w:t>100</w:t></w:r></w:p></w:tc>
  <w:tc><w:p><w:r><w:t>88.50</w:t></w:r></w:p></w:tc>
</w:tr></w:tbl>
</w:body></w:document>`;

describe('AP-10 · a Word invoice keeps its table', () => {
  it('puts a row on one line, its cells apart', async () => {
    // The whole point: the quantity and the price must not drift away from
    // the item they belong to.
    const text = wordText(await docx(TABLE));
    const row = text.split('\n').find((line) => line.includes('Solar Panel 550W'));
    expect(row).toBeDefined();
    expect(row).toContain('100');
    expect(row).toContain('88.50');
    expect(row!.split('\t').length).toBeGreaterThanOrEqual(3);
  });

  it('keeps the heading as its own line', async () => {
    expect((await extractDocumentText({ fileName: 'inv.docx', content: await docx(TABLE) })).text).toMatch(
      /^COMMERCIAL INVOICE$/m,
    );
  });

  it('turns XML entities back into the characters they stand for', async () => {
    const body = '<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>Cable &amp; Lugs &lt;3m&gt;</w:t></w:r></w:p></w:body></w:document>';
    expect(wordText(await docx(body))).toBe('Cable & Lugs <3m>');
  });
});

describe('AP-10 · the formats it will and will not read', () => {
  it('reads a CSV as lines', async () => {
    const read = await extractDocumentText({ fileName: 'inv.csv', content: Buffer.from('item,qty\nPanel,100\n', 'utf8') });
    expect(read.kind).toBe('text');
    expect(read.text).toContain('Panel,100');
    expect(read.note).toBeNull();
  });

  it('tells the reader to re-save the old Word format', async () => {
    const read = await extractDocumentText({ fileName: 'invoice.doc', content: Buffer.from('anything') });
    expect(read.kind).toBe('unreadable');
    expect(read.note).toMatch(/Save it as \.docx or PDF/);
  });

  it('refuses a kind it does not know, by name', async () => {
    const read = await extractDocumentText({ fileName: 'invoice.jpg', content: Buffer.from('anything') });
    expect(read.kind).toBe('unreadable');
    expect(read.text).toBe('');
    expect(read.note).toMatch(/cannot be read here/);
  });

  it('does not throw when a file lies about what it is', async () => {
    // A PDF renamed .xlsx, which happens. The answer is a sentence, not a
    // crash in the middle of drafting an invoice.
    const read = await extractDocumentText({ fileName: 'invoice.xlsx', content: Buffer.from('%PDF-1.7 not a workbook') });
    expect(read.text).toBe('');
    expect(read.note).toMatch(/could not be read/);
  });
});
