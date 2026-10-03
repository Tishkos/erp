/**
 * Reading a supplier's document into text — REQ-AP-001, the invoice intake.
 *
 * The CEO is sent an invoice from a factory in China and wants a draft import
 * application out of it (by direction, 2026-10-02). Whatever model reads it,
 * something has to turn the file into words first, and the file arrives in
 * whatever the supplier happened to use:
 *
 *   workbook  the house's own readers, both kinds — the zip-and-XML one and
 *             the old compound file. Rows become tab-separated lines, which
 *             keeps a price in the same line as the thing it prices.
 *   pdf       `pdftotext -layout`, which keeps the columns where they were.
 *             A scan has no text in it to find; that comes back empty and is
 *             said plainly rather than guessed at.
 *   docx      a zip with the text in `word/document.xml`. Paragraphs and
 *             table cells become lines, so an invoice laid out as a Word
 *             table survives as a table.
 *   text/csv  as they are.
 *
 * Nothing here understands an invoice. It produces words and says honestly
 * what it could not read, and the understanding happens above it.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chooseSheet, extensionOf, sheetToLines, textToLines } from '../domain/asycuda-file';
import { isCompoundFile, readXlsWorkbook } from '../xls-read';
import { readWorkbook, unzip } from '../xlsx-read';

export type DocumentKind = 'workbook' | 'pdf' | 'word' | 'text' | 'unreadable';

export interface DocumentText {
  readonly fileName: string;
  readonly kind: DocumentKind;
  readonly text: string;
  /** Why the text is missing or partial, when it is. Null when it is whole. */
  readonly note: string | null;
}

/** As much of a document as is worth sending to a model in one go. */
export const TEXT_CAP = 120_000;
const PDF_TIMEOUT_MS = 30_000;

function cap(text: string): { readonly text: string; readonly truncated: boolean } {
  return text.length <= TEXT_CAP ? { text, truncated: false } : { text: text.slice(0, TEXT_CAP), truncated: true };
}

/** `pdftotext -layout`, which is poppler. Returns what it found, or why not. */
async function pdfText(buffer: Buffer): Promise<{ readonly text: string; readonly note: string | null }> {
  const dir = mkdtempSync(join(tmpdir(), 'qs-doc-'));
  const path = join(dir, 'in.pdf');
  try {
    writeFileSync(path, buffer);
    return await new Promise((resolve) => {
      const child = spawn('pdftotext', ['-layout', '-enc', 'UTF-8', path, '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ text: '', note: 'the PDF took too long to read' });
      }, PDF_TIMEOUT_MS);
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        err += chunk.toString('utf8');
      });
      child.on('error', (error) =>
        resolve({
          text: '',
          note: /ENOENT/.test(error.message)
            ? 'this host has no pdftotext, so a PDF cannot be read (install poppler-utils)'
            : `the PDF could not be read: ${error.message}`,
        }),
      );
      child.on('close', () => {
        clearTimeout(timer);
        if (out.trim()) return resolve({ text: out, note: null });
        resolve({
          text: '',
          note: err.trim()
            ? `nothing could be read out of this PDF (${err.trim().slice(0, 120)})`
            : 'this PDF holds no text — it is most likely a scan, so the figures would have to be typed in by hand',
        });
      });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A Word document's text.
 *
 * `word/document.xml` is the body. A paragraph (`w:p`) ends a line and a table
 * cell (`w:tc`) ends a field, so an invoice laid out as a table comes out as
 * tab-separated lines — the same shape a workbook gives — rather than as one
 * run-on sentence where the quantity has lost its item.
 */
export function wordText(buffer: Buffer): string {
  const files = unzip(buffer);
  const body = files.get('word/document.xml');
  if (!body) throw new Error('this .docx has no word/document.xml in it');
  const xml = body.toString('utf8');

  /** A fragment's words, with the markup and the entities resolved away. */
  const plain = (fragment: string): string =>
    fragment
      .replace(/<w:tab\b[^>]*\/>/g, ' ')
      .replace(/<w:br\b[^>]*\/>/g, ' ')
      .replace(/<[^>]+>/g, '')
      // After the markup, never before: a &lt; in the text must not become a
      // tag that the line above then strips.
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();

  /*
   * The body in order, taking a table row whole and a paragraph singly.
   *
   * A cell contains paragraphs of its own, so ending a line at every
   * paragraph — which is what this did first — breaks a row into one line per
   * cell and divorces every price from the item it prices. A row is one line,
   * its cells apart. Caught by the test that exists for exactly that.
   *
   * `\b` keeps `<w:p…>` from matching `<w:pPr>` and `<w:tr…>` from matching
   * `<w:trPr>`; and because a row is matched before the paragraphs inside it,
   * those paragraphs are consumed with the row.
   */
  const lines: string[] = [];
  for (const match of xml.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>|<w:p\b[\s\S]*?<\/w:p>/g)) {
    const fragment = match[0];
    if (fragment.startsWith('<w:tr')) {
      const cells = [...fragment.matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map((cell) => plain(cell[0]));
      while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
      if (cells.some((cell) => cell !== '')) lines.push(cells.join('\t'));
      continue;
    }
    const line = plain(fragment);
    if (line !== '') lines.push(line);
  }
  return lines.join('\n');
}

/**
 * One document, as text. Never throws: a file that cannot be read comes back
 * with an empty text and a note saying why, because "I could not open it" is
 * an answer and an exception in the middle of a draft is not.
 */
export async function extractDocumentText(input: {
  readonly fileName: string;
  readonly content: Buffer;
}): Promise<DocumentText> {
  const extension = extensionOf(input.fileName);
  const base = { fileName: input.fileName };

  try {
    if (['.xlsx', '.xlsm', '.xls'].includes(extension)) {
      const sheets = isCompoundFile(input.content) ? readXlsWorkbook(input.content) : readWorkbook(input.content);
      const chosen = chooseSheet(sheets);
      if (!chosen) return { ...base, kind: 'workbook', text: '', note: 'the workbook has no rows in it' };
      const { text, truncated } = cap(sheetToLines(chosen.rows));
      const others = [...sheets.keys()].filter((name) => name !== chosen.name);
      return {
        ...base,
        kind: 'workbook',
        text,
        note:
          truncated
            ? 'only the first part of this workbook was read'
            : others.length > 0
              ? `read from the sheet "${chosen.name}"; the workbook also has ${others.join(', ')}`
              : null,
      };
    }

    if (extension === '.pdf') {
      const { text, note } = await pdfText(input.content);
      const capped = cap(text);
      return { ...base, kind: 'pdf', text: capped.text, note: capped.truncated ? 'only the first part of this PDF was read' : note };
    }

    if (extension === '.docx') {
      const capped = cap(wordText(input.content));
      return { ...base, kind: 'word', text: capped.text, note: capped.truncated ? 'only the first part of this document was read' : null };
    }

    if (['.csv', '.txt', '.tsv'].includes(extension)) {
      const capped = cap(textToLines(input.content.toString('utf8')));
      return { ...base, kind: 'text', text: capped.text, note: capped.truncated ? 'only the first part of this file was read' : null };
    }

    if (extension === '.doc') {
      return {
        ...base,
        kind: 'unreadable',
        text: '',
        note: 'this is the old Word format (.doc). Save it as .docx or PDF and send it again.',
      };
    }

    return {
      ...base,
      kind: 'unreadable',
      text: '',
      note: `a ${extension || 'file'} of this kind cannot be read here — send a workbook, a PDF or a Word document`,
    };
  } catch (error) {
    return {
      ...base,
      kind: 'unreadable',
      text: '',
      note: `it could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
