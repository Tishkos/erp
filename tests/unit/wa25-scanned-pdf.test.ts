/**
 * A scanned PDF sent to Noah (2026-10-14, ISS-20261014-001: "I couldn't read
 * 1.pdf … it's a scan"). A PDF with no text in it is shown to him as its pages,
 * pictures in order, with the question framed to say so — and a page past the
 * cap is named as not shown, never quietly left out.
 *
 * The drawing itself is poppler's (`pdfinfo`, `pdftoppm`), which the server has
 * and this machine may not: that block runs only where they are installed.
 */
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { MAX_ASKED_PAGES, MAX_ASKED_PICTURES, runAgent, type AgentMessage } from '@domain/whatsapp-agent';
import { looksScanned, scanQuestion } from '@/server/domain/whatsapp-files';
import { pdfPagePictures } from '@/server/services/whatsapp-files';

describe('what counts as a scan', () => {
  it('a PDF with no text, or only a stamp’s worth, is a scan', () => {
    expect(looksScanned('')).toBe(true);
    expect(looksScanned(' \n\f \n\f')).toBe(true);
    expect(looksScanned('PAID  14/10/2026')).toBe(true);
  });

  it('a PDF with a document’s text in it is read as text', () => {
    expect(looksScanned('COMMERCIAL INVOICE  No. SGMSC2026003714  Date 2026-04-28\nJKM650N-66QL6-BDV  30960 PCS  USD 0.095/W')).toBe(false);
  });
});

describe('the question that carries a scan’s pages', () => {
  it('names the file, the pages shown and that they are the pictures, in order', () => {
    const asked = scanQuestion({ caption: 'enter these as purchase invoices', fileName: '1.pdf', shown: 3, total: 3, replied: false });
    expect(asked.startsWith('enter these as purchase invoices\n\n[A scanned PDF, "1.pdf" is attached')).toBe(true);
    expect(asked).toContain('it has 3 pages and pages 1–3 are the pictures above, in order');
    expect(asked).toMatch(/name anything you cannot make out instead of guessing/);
    expect(asked).not.toMatch(/NOT shown/);
  });

  it('says which pages were not shown when the scan is longer than the cap', () => {
    const asked = scanQuestion({ caption: '', fileName: 'docs.pdf', shown: 10, total: 14, replied: true });
    expect(asked).toContain('Read this document');
    expect(asked).toContain(', from the message they replied to,');
    expect(asked).toContain('Pages 11–14 were NOT shown to you');
  });

  it('speaks of one page as one page', () => {
    expect(scanQuestion({ caption: 'x', fileName: 'a.pdf', shown: 1, total: 1, replied: false })).toContain('it has one page and that page is the picture above');
  });
});

describe('the model is shown the pages', () => {
  it('after the photos, in page order, at most ten — three photos stay three', async () => {
    const seen: AgentMessage[][] = [];
    const photo = (n: number) => ({ mediaType: 'image/jpeg' as const, base64: `PHOTO${n}` });
    const page = (n: number) => ({ mediaType: 'image/jpeg' as const, base64: `PAGE${n}`, page: n });
    await runAgent({
      model: 'fake',
      userName: 'Tishko',
      locale: 'en',
      branchCode: 'HQ',
      today: '2026-10-14',
      question: 'what is in this scan?',
      pictures: [photo(1), photo(2), photo(3), photo(4), ...Array.from({ length: 12 }, (_, index) => page(index + 1))],
      client: {
        create: async (input) => {
          seen.push([...input.messages]);
          return { content: [{ type: 'text', text: 'Two supplier invoices.' }] };
        },
      },
      runTool: async () => ({ text: 'unused' }),
    });
    expect(MAX_ASKED_PICTURES).toBe(3);
    expect(MAX_ASKED_PAGES).toBe(10);
    const first = seen[0]![0] as { content: { type: string; text?: string; source?: { data: string } }[] };
    const images = first.content.filter((block) => block.type === 'image').map((block) => block.source!.data);
    expect(images).toEqual(['PHOTO1', 'PHOTO2', 'PHOTO3', ...Array.from({ length: 10 }, (_, index) => `PAGE${index + 1}`)]);
    expect(first.content.at(-1)).toEqual({ type: 'text', text: 'what is in this scan?' });
  });
});

/** A PDF of `count` blank pages — no text in it, as a scan has none. */
function blankPdf(count: number): Buffer {
  const objects: string[] = [];
  const kids = Array.from({ length: count }, (_, index) => `${3 + index} 0 R`).join(' ');
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${count} >>`);
  for (let index = 0; index < count; index += 1) objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>');
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

const hasPoppler = spawnSync('pdftoppm', ['-v']).error === undefined;

describe.skipIf(!hasPoppler)('drawing a scan’s pages (poppler)', () => {
  it('draws the first pages as JPEGs in page order and counts the whole document', async () => {
    const drawn = await pdfPagePictures(blankPdf(12), 10);
    expect(drawn.total).toBe(12);
    expect(drawn.pages.map((entry) => entry.page)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(Buffer.from(drawn.pages[0]!.base64, 'base64').subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(drawn.note).toBeNull();
  });

  it('says why when there is nothing to draw', async () => {
    const drawn = await pdfPagePictures(Buffer.from('not a pdf'), 10);
    expect(drawn.pages).toEqual([]);
    expect(drawn.note).toMatch(/could not be counted/);
  });
});
