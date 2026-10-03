import PDFDocument from 'pdfkit';
import { directionOf, visualRuns, type Direction } from './bidi';
import { asset } from './assets';
import { display, heading, pageOf, printedAt } from './format';
import { counts, isNumeric, type Column, type Letterhead, type PrintModel, type Row, type Table } from './model';

/**
 * The PDF — A4, drawn with an embedded font so Arabic prints shaped and joined
 * on any machine, whatever it has installed.
 *
 * Laid out by hand rather than by the library's flowing text, because the
 * rules a voucher keeps are rules about pages: the letterhead on every one,
 * the table's heading repeated at the top of each page it continues onto, no
 * line cut in half by a page break, the signatures kept together, and "Page 2
 * of 3" in the foot — which cannot be written until the last page exists, so
 * pages are buffered and footed at the end.
 *
 * Right to left is the whole layout mirrored, not only the text: the logo
 * moves to the right, the first column of a table is the rightmost, labels
 * sit right of their values. Figures and codes still read left to right
 * inside their cells (see bidi.ts).
 */

const MM = 72 / 25.4;
const MARGIN = 12 * MM;
const HEADER_HEIGHT = 58;
const FOOTER_HEIGHT = 22;
const BODY = 8.8;
const SMALL = 7.6;
const INK = '#111111';
const MUTED = '#4a4a4a';
const RULE = '#444444';
const SHADE = '#ececec';
const TOTAL_SHADE = '#f3f3f3';

type Align = 'start' | 'end' | 'center';

interface Box {
  readonly x: number;
  readonly width: number;
}

export async function renderPdf(model: PrintModel, head: Letterhead): Promise<Buffer> {
  const direction: Direction = head.locale === 'ar' ? 'rtl' : 'ltr';
  const doc = new PDFDocument({
    size: 'A4',
    layout: model.orientation,
    margin: 0,
    bufferPages: true,
    autoFirstPage: false,
    // The embedded font from the first stroke: the library's own default is a
    // standard font it would read from disk and that has no Arabic at all.
    font: asset('IBMPlexSansArabic-Regular.ttf') as unknown as string,
    lang: head.locale,
    info: {
      Title: [model.title, model.number].filter(Boolean).join(' '),
      Author: head.locale === 'ar' ? head.companyAr : head.companyEn,
      Subject: model.fileName,
      Creator: 'QS ERP',
      CreationDate: new Date(head.printedAt),
    },
  });
  doc.registerFont('regular', asset('IBMPlexSansArabic-Regular.ttf'));
  doc.registerFont('bold', asset('IBMPlexSansArabic-Bold.ttf'));

  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const pen = new Pen(doc, direction);
  const pageWidth = model.orientation === 'landscape' ? 841.89 : 595.28;
  const pageHeight = model.orientation === 'landscape' ? 595.28 : 841.89;
  const content: Box = { x: MARGIN, width: pageWidth - 2 * MARGIN };
  const bottom = pageHeight - MARGIN - FOOTER_HEIGHT;
  let y = 0;
  let pageNo = 0;

  const newPage = () => {
    doc.addPage({ size: 'A4', layout: model.orientation, margin: 0 });
    pageNo += 1;
    if (model.kind === 'document' && model.posted === false) watermark();
    y = letterhead();
    if (pageNo > 1) {
      // Which document a loose second page belongs to.
      pen.line(
        [model.title, model.number].filter(Boolean).join(' · '),
        content,
        y,
        'start',
        { size: SMALL, bold: true, color: MUTED },
      );
      y += SMALL * 1.9;
    }
  };

  const watermark = () => {
    const cx = pageWidth / 2;
    const cy = pageHeight / 2;
    doc.save();
    doc.rotate(-32, { origin: [cx, cy] });
    doc.fillColor('#b00020').fillOpacity(0.14);
    const size = model.orientation === 'landscape' ? 66 : 56;
    pen.line(head.labels.watermark, { x: cx - pageWidth, width: pageWidth * 2 }, cy - size * 0.7, 'center', {
      size,
      bold: true,
      color: '#b00020',
      opacity: 0.14,
    });
    doc.restore();
    doc.fillOpacity(1);
  };

  // Opened once and drawn on every page: an image handed over as bytes is
  // embedded again at each use, one copy per page.
  const logo = (doc as unknown as { openImage(src: Buffer): Parameters<PDFKit.PDFDocument['image']>[0] }).openImage(
    asset('logo-print.png'),
  );
  const letterhead = (): number => {
    const top = MARGIN;
    const logoWidth = 46;
    const logoX = direction === 'rtl' ? content.x + content.width - logoWidth : content.x;
    doc.image(logo, logoX, top, { width: logoWidth });

    // The company beside the logo, both names whatever the language; the
    // provenance — which branch, when, by whom — over the far edge.
    const namesWidth = content.width * 0.56 - logoWidth - 10;
    const names: Box = {
      x: direction === 'rtl' ? content.x + content.width - logoWidth - 10 - namesWidth : content.x + logoWidth + 10,
      width: namesWidth,
    };
    const ordered = head.locale === 'ar' ? [head.companyAr, head.companyEn] : [head.companyEn, head.companyAr];
    pen.line(ordered[0]!, names, top + 4, 'start', { size: 13.5, bold: true });
    pen.line(ordered[1]!, names, top + 22, 'start', { size: 11, bold: true, color: MUTED });

    const sideWidth = content.width * 0.42;
    const side: Box = { x: direction === 'rtl' ? content.x : content.x + content.width - sideWidth, width: sideWidth };
    [
      `${head.labels.branch}: ${head.branch}`,
      `${head.labels.printedAt}: ${printedAt(head.printedAt, head.locale)}`,
      `${head.labels.printedBy}: ${head.printedBy}`,
    ].forEach((fact, index) => {
      pen.line(fact, side, top + 4 + index * (SMALL + 3.4), 'end', { size: SMALL, color: MUTED });
    });

    const ruleY = top + HEADER_HEIGHT - 10;
    doc.moveTo(content.x, ruleY).lineTo(content.x + content.width, ruleY).lineWidth(1.6).strokeColor(INK).stroke();
    return ruleY + 8;
  };

  const ensure = (height: number, onBreak?: () => void) => {
    if (y + height <= bottom) return;
    newPage();
    onBreak?.();
  };

  // ---------------------------------------------------------------- page one
  newPage();

  // The title in the build's words, and the number large beside it.
  pen.line(model.title, content, y, 'start', { size: 15, bold: true });
  if (model.number) pen.line(model.number, content, y - 3, 'end', { size: 19, bold: true, ltr: true });
  y += 28;

  if (model.fields.length > 0) y = facts(model.fields, y);

  if (model.filters.length > 0) {
    ensure(BODY * 3);
    pen.line(head.labels.filters, content, y, 'start', { size: BODY, bold: true });
    y += BODY * 1.6;
    y = facts(model.filters, y);
  }

  for (const table of model.tables) drawTable(table);

  if (model.summary.length > 0) {
    const width = Math.min(content.width, 300);
    const box: Box = { x: direction === 'rtl' ? content.x : content.x + content.width - width, width };
    ensure(model.summary.length * 18 + 6);
    y += 4;
    for (const fact of model.summary) {
      doc.rect(box.x, y - 2, box.width, 16).fillColor(TOTAL_SHADE).fill();
      pen.line(fact.label, { x: box.x + 5, width: box.width - 10 }, y + 1, 'start', { size: BODY, bold: true });
      pen.line(fact.value, { x: box.x + 5, width: box.width - 10 }, y + 1, 'end', { size: BODY + 0.6, bold: true, ltr: true });
      y += 18;
    }
  }

  if (model.signatures) {
    const height = 62;
    ensure(height + 24);
    y += 24;
    const labels = [head.labels.preparedBy, head.labels.approvedBy, head.labels.receivedBy];
    const gap = 14;
    const width = (content.width - gap * 2) / 3;
    labels.forEach((label, index) => {
      const slot = direction === 'rtl' ? 2 - index : index;
      const x = content.x + slot * (width + gap);
      doc.rect(x, y, width, height).lineWidth(0.7).strokeColor(RULE).stroke();
      pen.line(label, { x: x + 6, width: width - 12 }, y + 5, 'start', { size: BODY, bold: true });
      doc.moveTo(x + 8, y + height - 16).lineTo(x + width - 8, y + height - 16).lineWidth(0.5).strokeColor(MUTED).stroke();
    });
    y += height;
  }

  // ---------------------------------------------------------------- the feet
  const range = doc.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    doc.switchToPage(index);
    const footY = pageHeight - MARGIN - SMALL - 2;
    doc.moveTo(content.x, footY - 5).lineTo(content.x + content.width, footY - 5).lineWidth(0.5).strokeColor(RULE).stroke();
    pen.line(pageOf(head.labels.pageOf, index + 1, range.count), content, footY, 'center', { size: SMALL, color: MUTED });
    pen.line(model.fileName, content, footY, 'start', { size: SMALL, color: MUTED, ltr: true });
  }

  doc.end();
  return finished;

  // ------------------------------------------------------------------ helpers

  /** Header fields, two to a row: the label, then its value. */
  function facts(list: PrintModel['fields'], start: number): number {
    let at = start;
    const perRow = 2;
    const gap = 16;
    const cell = (content.width - gap * (perRow - 1)) / perRow;
    for (let i = 0; i < list.length; i += perRow) {
      const pair = list.slice(i, i + perRow);
      const labelWidth = cell * 0.42;
      const heights = pair.map((fact) => {
        const labelLines = pen.wrap(fact.label, labelWidth, { size: BODY, bold: true });
        const valueLines = pen.wrap(fact.value || '—', cell - labelWidth - 6, { size: BODY, ltr: fact.ltr ?? false });
        return Math.max(1, labelLines.length, valueLines.length) * BODY * 1.34 + 5;
      });
      const rowHeight = Math.max(...heights);
      if (at + rowHeight > bottom) {
        newPage();
        at = y;
      }
      pair.forEach((fact, index) => {
        const slot = direction === 'rtl' ? perRow - 1 - index : index;
        const x = content.x + slot * (cell + gap);
        const labelBox: Box = direction === 'rtl' ? { x: x + cell - labelWidth, width: labelWidth } : { x, width: labelWidth };
        const valueBox: Box =
          direction === 'rtl' ? { x, width: cell - labelWidth - 6 } : { x: x + labelWidth + 6, width: cell - labelWidth - 6 };
        pen.block(fact.label, labelBox, at + 2, 'start', { size: BODY, bold: true, color: MUTED });
        pen.block(fact.value || '—', valueBox, at + 2, 'start', { size: BODY, ltr: fact.ltr ?? false });
        doc
          .moveTo(x, at + rowHeight - 1)
          .lineTo(x + cell, at + rowHeight - 1)
          .lineWidth(0.4)
          .strokeColor('#9a9a9a')
          .stroke();
      });
      at += rowHeight;
    }
    return at + 8;
  }

  function drawTable(table: Table) {
    const columns = table.columns;
    const pad = 3.5;
    const size = columns.length > 7 ? 7.6 : 8.2;
    const widths = columnWidths(columns, content.width, (i) => {
      const column = columns[i]!;
      const values = [
        ...table.rows.map((row) => display(column, row.cells[column.key] ?? null, model, head.locale)),
        display(column, table.totals?.cells[column.key] ?? null, model, head.locale),
      ];
      return Math.max(0, ...values.map((value) => pen.width(value, { size, bold: true, ltr: true }))) + 2 * pad + 2;
    });
    // Left edge of each column, in reading order.
    const lefts: number[] = [];
    let cursor = direction === 'rtl' ? content.x + content.width : content.x;
    widths.forEach((width) => {
      if (direction === 'rtl') {
        cursor -= width;
        lefts.push(cursor);
      } else {
        lefts.push(cursor);
        cursor += width;
      }
    });
    const lineHeight = size * 1.34;

    if (table.title) {
      ensure(size * 2 + 40);
      y += 6;
      pen.line(table.title, content, y, 'start', { size: BODY + 0.8, bold: true });
      y += BODY * 1.9;
    }

    const headerHeight = Math.max(
      ...columns.map((column, i) => pen.wrap(heading(column, model), widths[i]! - 2 * pad, { size: size - 0.4, bold: true }).length),
    ) * lineHeight + 2 * pad;

    const drawHeader = () => {
      columns.forEach((column, i) => {
        doc.rect(lefts[i]!, y, widths[i]!, headerHeight).fillColor(SHADE).fill();
        doc.rect(lefts[i]!, y, widths[i]!, headerHeight).lineWidth(0.6).strokeColor(RULE).stroke();
        pen.block(heading(column, model), { x: lefts[i]! + pad, width: widths[i]! - 2 * pad }, y + pad, isNumeric(column) ? 'end' : 'start', {
          size: size - 0.4,
          bold: true,
        });
      });
      y += headerHeight;
    };

    ensure(headerHeight + lineHeight * 2 + 2 * pad);
    drawHeader();

    if (table.rows.length === 0) {
      const height = lineHeight + 2 * pad;
      doc.rect(content.x, y, content.width, height).lineWidth(0.6).strokeColor(RULE).stroke();
      pen.line(table.empty, { x: content.x + pad, width: content.width - 2 * pad }, y + pad, 'center', { size, color: MUTED });
      y += height;
    }

    const cellText = (column: Column, row: Row) => display(column, row.cells[column.key] ?? null, model, head.locale);

    for (const row of table.rows) {
      const bold = row.tone === 'header' || row.tone === 'subtotal' || row.tone === 'opening' || row.tone === 'closing';
      const indent = (row.depth ?? 0) * 9;
      const wrapped = columns.map((column, i) =>
        pen.wrap(cellText(column, row), widths[i]! - 2 * pad - (i === 0 ? indent : 0), { size, bold }),
      );
      const height = Math.max(1, ...wrapped.map((lines) => lines.length)) * lineHeight + 2 * pad;
      // A line is never cut by a page: if it does not fit, it starts the next
      // page, under the heading repeated there.
      ensure(height, drawHeader);
      if (row.tone === 'subtotal' || row.tone === 'closing' || row.tone === 'opening') {
        doc.rect(content.x, y, content.width, height).fillColor(TOTAL_SHADE).fill();
      }
      columns.forEach((column, i) => {
        doc.rect(lefts[i]!, y, widths[i]!, height).lineWidth(0.5).strokeColor(RULE).stroke();
        const inset = i === 0 ? indent : 0;
        const box: Box =
          direction === 'rtl'
            ? { x: lefts[i]! + pad, width: widths[i]! - 2 * pad - inset }
            : { x: lefts[i]! + pad + inset, width: widths[i]! - 2 * pad - inset };
        wrapped[i]!.forEach((line, n) => {
          pen.line(line, box, y + pad + n * lineHeight, isNumeric(column) ? 'end' : 'start', {
            size,
            bold,
            ltr: column.kind !== 'text',
          });
        });
      });
      y += height;
    }

    if (table.totals) {
      const totals = table.totals;
      const first = columns.findIndex((column) => (totals.cells[column.key] ?? null) !== null);
      const span = first <= 0 ? 1 : first;
      const height = lineHeight + 2 * pad + 2;
      ensure(height, drawHeader);
      doc.rect(content.x, y, content.width, height).fillColor(TOTAL_SHADE).fill();
      doc.moveTo(content.x, y).lineTo(content.x + content.width, y).lineWidth(1.4).strokeColor(INK).stroke();
      const spanLeft = direction === 'rtl' ? lefts[span - 1]! : lefts[0]!;
      const spanWidth = widths.slice(0, span).reduce((a, b) => a + b, 0);
      doc.rect(spanLeft, y, spanWidth, height).lineWidth(0.5).strokeColor(RULE).stroke();
      pen.line(totals.label, { x: spanLeft + pad, width: spanWidth - 2 * pad }, y + pad + 1, 'start', { size, bold: true });
      columns.forEach((column, i) => {
        if (i < span) return;
        doc.rect(lefts[i]!, y, widths[i]!, height).lineWidth(0.5).strokeColor(RULE).stroke();
        const text = display(column, totals.cells[column.key] ?? null, model, head.locale);
        pen.line(text, { x: lefts[i]! + pad, width: widths[i]! - 2 * pad }, y + pad + 1, isNumeric(column) ? 'end' : 'start', {
          size,
          bold: true,
          ltr: true,
        });
      });
      y += height;
    }
    y += 10;
  }
}

/**
 * Column widths from their weights, filling the width given.
 *
 * A code, a date or a figure is never broken across lines — "API-HQ-2026-00 /
 * 0001" is a number nobody can read back or search for — so, given a way to
 * measure, each of those columns is at least as wide as its widest value, and
 * the text columns give up the difference.
 */
export function columnWidths(
  columns: readonly Column[],
  width: number,
  natural?: (index: number) => number,
): number[] {
  const weightOf = (column: Column) =>
    column.weight ??
    (column.kind === 'text' ? 2.4 : column.kind === 'money' ? 1.35 : column.kind === 'quantity' ? 0.95 : column.kind === 'date' ? 1.15 : 1.25);
  const total = columns.reduce((sum, column) => sum + weightOf(column), 0);
  const proportional = columns.map((column) => (weightOf(column) / total) * width);
  if (!natural) return proportional;

  const widths = proportional.map((w, i) => (columns[i]!.kind === 'text' ? w : Math.max(w, natural(i))));
  const excess = widths.reduce((a, b) => a + b, 0) - width;
  if (excess <= 0) {
    // Room to spare goes to the text columns, which wrap.
    const text = columns.map((c, i) => (c.kind === 'text' ? i : -1)).filter((i) => i >= 0);
    if (text.length === 0) return widths.map((w) => (w * width) / (width + excess));
    const share = -excess / text.length;
    return widths.map((w, i) => (text.includes(i) ? w + share : w));
  }
  const FLOOR = 48;
  const text = columns.map((c, i) => (c.kind === 'text' ? i : -1)).filter((i) => i >= 0);
  const spare = text.reduce((sum, i) => sum + Math.max(0, widths[i]! - FLOOR), 0);
  if (spare >= excess) {
    return widths.map((w, i) => (text.includes(i) ? w - (excess * Math.max(0, w - FLOOR)) / spare : w));
  }
  // Too many columns for the page: everything shrinks, and the codes wrap.
  const sum = widths.reduce((a, b) => a + b, 0);
  return widths.map((w) => (w * width) / sum);
}

interface TextStyle {
  readonly size: number;
  readonly bold?: boolean;
  readonly color?: string;
  readonly opacity?: number;
  /** Always left to right: figures, codes, dates. */
  readonly ltr?: boolean;
}

/**
 * Draws text the way a bidirectional line is drawn: cut into runs, placed in
 * visual order, each run handed to the shaper on its own.
 */
class Pen {
  constructor(
    private readonly doc: PDFKit.PDFDocument,
    private readonly direction: Direction,
  ) {}

  private use(style: TextStyle) {
    this.doc.font(style.bold ? 'bold' : 'regular').fontSize(style.size);
  }

  private paragraph(text: string, style: TextStyle): Direction {
    return style.ltr ? 'ltr' : directionOf(text, this.direction);
  }

  width(text: string, style: TextStyle): number {
    this.use(style);
    return visualRuns(text, this.paragraph(text, style)).reduce((sum, run) => sum + this.doc.widthOfString(run.text, { features: [] }), 0);
  }

  /** One line, aligned inside the box. `start` is the reading start. */
  line(text: string, box: Box, y: number, align: Align, style: TextStyle) {
    if (!text) return;
    this.use(style);
    const runs = visualRuns(text, this.paragraph(text, style));
    const widths = runs.map((run) => this.doc.widthOfString(run.text, { features: [] }));
    const total = widths.reduce((a, b) => a + b, 0);
    const left = align === 'center' ? false : (align === 'start') === (this.direction === 'ltr');
    let x = align === 'center' ? box.x + (box.width - total) / 2 : left ? box.x : box.x + box.width - total;
    this.doc.fillColor(style.color ?? INK);
    if (style.opacity !== undefined) this.doc.fillOpacity(style.opacity);
    runs.forEach((run, index) => {
      // `features` makes the library lay the run out whole; without it, it
      // splits at spaces and lays out each word alone, which scrambles the
      // order of Arabic words.
      this.doc.text(run.text, x, y, { lineBreak: false, features: [] });
      x += widths[index]!;
    });
    if (style.opacity !== undefined) this.doc.fillOpacity(1);
  }

  /** Several lines, wrapped to the box. */
  block(text: string, box: Box, y: number, align: Align, style: TextStyle): number {
    const lines = this.wrap(text, box.width, style);
    lines.forEach((line, index) => this.line(line, box, y + index * style.size * 1.34, align, style));
    return lines.length;
  }

  /** Greedy word wrap in reading order; a word wider than the box is cut by characters. */
  wrap(text: string, width: number, style: TextStyle): string[] {
    if (!text) return [''];
    const out: string[] = [];
    for (const paragraph of text.split('\n')) {
      let current = '';
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        const candidate = current ? `${current} ${word}` : word;
        if (this.width(candidate, style) <= width) {
          current = candidate;
          continue;
        }
        if (current) out.push(current);
        if (this.width(word, style) <= width) {
          current = word;
          continue;
        }
        let piece = '';
        for (const char of Array.from(word)) {
          if (piece && this.width(piece + char, style) > width) {
            out.push(piece);
            piece = char;
          } else {
            piece += char;
          }
        }
        current = piece;
      }
      out.push(current);
    }
    return out;
  }
}
