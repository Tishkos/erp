/**
 * Getting the text out of a file sent to the group — REQ-WA-001 WA-7.
 *
 * Four formats, and an honest answer for everything else:
 *
 *   workbook  the house's own readers, the same two the legacy books were
 *             imported with: `xlsx-read` for the zip-and-XML kind and
 *             `xls-read` for the old compound-file kind that Iraqi offices
 *             still email around. No new dependency, and a format the company
 *             already trusts with its opening balances.
 *   pdf       `pdftotext`, which is poppler and is on the server. A PDF that
 *             is a scan has no text in it to find — that comes back empty and
 *             is said plainly rather than guessed at.
 *   text      csv and friends, as they are.
 *   image     not read. A photograph of an invoice is a photograph; inventing
 *             figures from one would be the worst thing this bot could do.
 *
 * Everything is capped (see `domain/whatsapp-files`) and every cap is
 * declared in the text, so an answer is never quietly based on page one of a
 * long file.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cap,
  kindOf,
  sheetsToText,
  type SentFile,
  type SheetShape,
} from '../domain/whatsapp-files';
import { isCompoundFile, readXlsWorkbook } from '../xls-read';
import { readWorkbook } from '../xlsx-read';

/** How long `pdftotext` is given before the file is called unreadable. */
const PDF_TIMEOUT_MS = 20_000;

/** Runs pdftotext over a buffer and returns what it found, or why it did not. */
async function pdfText(buffer: Buffer): Promise<{ readonly text: string; readonly note: string | null }> {
  const dir = mkdtempSync(join(tmpdir(), 'qs-wa-pdf-'));
  const path = join(dir, 'sent.pdf');
  try {
    writeFileSync(path, buffer);
    const found = await new Promise<{ text: string; note: string | null }>((resolve) => {
      // `-layout` keeps columns where they were, which is what makes a bank
      // statement or a customs declaration readable at all; `-` sends the
      // text to stdout rather than a file beside it.
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
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({
          text: '',
          note: /ENOENT/.test(error.message)
            ? 'this host has no pdftotext, so the PDF could not be read (install poppler-utils)'
            : `the PDF could not be read: ${error.message}`,
        });
      });
      child.on('close', () => {
        clearTimeout(timer);
        const text = out.trim();
        if (text) return resolve({ text: out, note: null });
        resolve({
          text: '',
          // The common case by far, and worth naming precisely: a scan is an
          // image wearing a PDF's clothes, and there is no text in it to find.
          note: err.trim()
            ? `nothing could be read out of this PDF (${err.trim().slice(0, 120)})`
            : 'this PDF holds no text — it is most likely a scan, so I can see that it arrived but not what it says',
        });
      });
    });
    return found;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A file, read.
 *
 * Never throws: a file that cannot be read is a `SentFile` with an empty text
 * and a note saying why, because "I could not open it" is a perfectly good
 * thing for a colleague to say and an exception in the middle of answering a
 * group is not.
 */
export async function extractSentFile(input: {
  readonly buffer: Buffer;
  readonly fileName: string;
  readonly mimetype: string;
  readonly caption?: string;
  readonly now?: Date;
}): Promise<SentFile> {
  const kind = kindOf(input.fileName, input.mimetype);
  const base = {
    fileName: input.fileName,
    kind,
    mimetype: input.mimetype,
    bytes: input.buffer.length,
    caption: input.caption ?? '',
    at: (input.now ?? new Date()).toISOString(),
  };

  if (kind === 'sheet') {
    try {
      const sheets = isCompoundFile(input.buffer) ? readXlsWorkbook(input.buffer) : readWorkbook(input.buffer);
      const { text, shapes, truncated } = sheetsToText(sheets);
      return {
        ...base,
        text,
        sheets: shapes satisfies readonly SheetShape[],
        note: truncated ? 'only part of this workbook is shown — say so if an answer depends on the rest' : null,
      };
    } catch (error) {
      return {
        ...base,
        text: '',
        sheets: [],
        note: `the workbook could not be read: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  if (kind === 'pdf') {
    const { text, note } = await pdfText(input.buffer);
    const capped = cap(text);
    return {
      ...base,
      text: capped.text,
      sheets: [],
      note: capped.truncated ? 'only the first part of this PDF is shown' : note,
    };
  }

  if (kind === 'text') {
    const capped = cap(input.buffer.toString('utf8'));
    return { ...base, text: capped.text, sheets: [], note: capped.truncated ? 'only the first part of this file is shown' : null };
  }

  if (kind === 'image') {
    return {
      ...base,
      text: '',
      sheets: [],
      note: 'this is a picture, and I cannot see inside it. If it is a document, send the file itself or tell me its number and I will read it from the system',
    };
  }

  return { ...base, text: '', sheets: [], note: `I cannot read a ${input.mimetype || 'file'} of this kind` };
}
