import PDFDocument from 'pdfkit';
import { directionOf, visualRuns, type Direction, type Run } from './bidi';
import { asset } from './assets';
import { display, heading, pageOf, printedAt } from './format';
import { amountInWords, spelledAmountOf } from './words';
import { isNumeric, type Column, type Fact, type Letterhead, type PrintModel, type Row, type Table } from './model';

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
 *
 * The look is the company's (2026-10-21, by direction: "never mention the
 * ERP … the design matches the logo … a better Arabic font"): the Q mark
 * without the product's name, the logo's three blues, and Vazirmatn — a
 * modern Arabic that also carries Kurdish and Persian letters (ی ە ڕ ێ ۆ) and
 * Latin, and draws every letter as one glyph, so the text reads back from the
 * PDF as printed (the Noto Arabic faces build dotted letters from a shared
 * skeleton, and a copy of their text names the wrong letters). A table's size
 * follows its columns and the page's width, so a wide report stays readable in
 * either orientation.
 */

const MM = 72 / 25.4;
const MARGIN = 13 * MM;
const FOOTER_HEIGHT = 24;

/** The logo's blues: the navy carries the page, the royal its accents. */
const NAVY = '#012579';
const BRAND = '#0147b2';
const INK = '#0f1a33';
const MUTED = '#5a6478';
const HAIR = '#d9e2f1';
const TINT = '#e8f0fe';
const ROW_TINT = '#f5f8fe';
const CARD = '#f7f9fe';
const WHITE = '#ffffff';

/** Where the baseline sits below the top of a line, and a line's height, in ems. */
const BASELINE = 1.0;
const LEADING = 1.5;

type Align = 'start' | 'end' | 'center';
type Weight = 'regular' | 'medium' | 'bold' | 'heavy';
type FontName = Weight | 'fallback' | 'fallback-bold';

interface Piece {
  readonly text: string;
  readonly font: FontName;
  readonly ltr: boolean;
}

/**
 * What the shaper is asked for. A Latin run without the "fi" ligature —
 * Vazirmatn's joins the dot of the i into the f, and "Safinah" read as
 * "Safınah" — while Arabic keeps every default (its lam-alef is required).
 */
const LATIN: Record<string, boolean> = { liga: false };
// pdfkit's types list only the array form; fontkit, which it hands this to,
// also takes { tag: on/off } — the only way to turn a default feature off.
const featuresOf = (piece: Piece) => (piece.ltr ? LATIN : []) as unknown as never[];

interface Box {
  readonly x: number;
  readonly width: number;
}

export async function renderPdf(model: PrintModel, head: Letterhead): Promise<Buffer> {
  const direction: Direction = head.locale === 'ar' ? 'rtl' : 'ltr';
  const company = head.locale === 'ar' ? head.companyAr : head.companyEn;
  const doc = new PDFDocument({
    size: 'A4',
    layout: model.orientation,
    margin: 0,
    bufferPages: true,
    autoFirstPage: false,
    // The embedded font from the first stroke: the library's own default is a
    // standard font it would read from disk and that has no Arabic at all.
    font: asset('Vazirmatn-Regular.ttf') as unknown as string,
    lang: head.locale,
    info: {
      Title: [model.title, model.number].filter(Boolean).join(' '),
      Author: company,
      Subject: model.fileName,
      Creator: company,
      Producer: company,
      CreationDate: new Date(head.printedAt),
    },
  });
  doc.registerFont('regular', asset('Vazirmatn-Regular.ttf'));
  doc.registerFont('medium', asset('Vazirmatn-Medium.ttf'));
  doc.registerFont('bold', asset('Vazirmatn-Bold.ttf'));
  doc.registerFont('heavy', asset('Vazirmatn-ExtraBold.ttf'));
  // For the few characters Vazirmatn has no glyph for (arrows, ₺): embedded only if used.
  doc.registerFont('fallback', asset('IBMPlexSansArabic-Regular.ttf'));
  doc.registerFont('fallback-bold', asset('IBMPlexSansArabic-Bold.ttf'));

  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const pen = new Pen(doc, direction);
  const landscape = model.orientation === 'landscape';
  const pageWidth = landscape ? 841.89 : 595.28;
  const pageHeight = landscape ? 595.28 : 841.89;
  const content: Box = { x: MARGIN, width: pageWidth - 2 * MARGIN };
  const bottom = pageHeight - MARGIN - FOOTER_HEIGHT;
  const rtl = direction === 'rtl';
  /** The x of a box `width` wide at the reading start (or end) of `within`. */
  const atStart = (width: number, within: Box = content) => (rtl ? within.x + within.width - width : within.x);
  const atEnd = (width: number, within: Box = content) => (rtl ? within.x : within.x + within.width - width);
  let y = 0;
  let pageNo = 0;

  // Opened once and drawn on every page: an image handed over as bytes is
  // embedded again at each use, one copy per page.
  const logo = (doc as unknown as { openImage(src: Buffer): Parameters<PDFKit.PDFDocument['image']>[0] }).openImage(
    asset('logo-mark.png'),
  );

  /** A band of the logo's navy across the page — one colour, as the table's heading (by direction). */
  const band = (top: number, height: number) => {
    doc.rect(0, top, pageWidth, height).fill(NAVY);
  };

  // The mark, faint, behind every page (by direction: "the whole page
  // background with low opacity should be the logo"). Its opacity is baked
  // into the file, so the page needs no transparency group for it.
  const backdrop = (doc as unknown as { openImage(src: Buffer): Parameters<PDFKit.PDFDocument['image']>[0] }).openImage(
    asset('logo-backdrop.png'),
  );
  const drawBackdrop = () => {
    const size = Math.min(content.width * 0.62, (pageHeight - 2 * MARGIN) * 0.55);
    doc.image(backdrop, (pageWidth - size) / 2, (pageHeight - size) / 2 + 10, { width: size });
  };

  const newPage = () => {
    doc.addPage({ size: 'A4', layout: model.orientation, margin: 0 });
    pageNo += 1;
    band(0, 5);
    y = pageNo === 1 ? letterhead() : runningHead();
  };

  const watermark = () => {
    const cx = pageWidth / 2;
    const cy = pageHeight / 2;
    doc.save();
    doc.rotate(-30, { origin: [cx, cy] });
    const size = landscape ? 62 : 52;
    pen.line(head.labels.watermark, { x: cx - pageWidth, width: pageWidth * 2 }, cy - size * 0.75, 'center', {
      size,
      weight: 'heavy',
      color: '#c62828',
      opacity: 0.1,
    });
    doc.restore();
    doc.fillOpacity(1);
  };

  /** The rule under a letterhead: a hairline with a short stroke of the brand at the reading start. */
  const headRule = (at: number) => {
    doc.moveTo(content.x, at).lineTo(content.x + content.width, at).lineWidth(0.6).strokeColor(HAIR).stroke();
    const accent = 64;
    const x = atStart(accent);
    doc.rect(x, at - 1.1, accent, 2.2).fill(BRAND);
  };

  /** Page one: the mark and the company beside it; the document's name and number over the far edge. */
  const letterhead = (): number => {
    const top = MARGIN - 4;
    const mark = 42;
    doc.image(logo, atStart(mark), top, { height: mark });

    const sideWidth = content.width * 0.46;
    const namesWidth = content.width - sideWidth - mark - 22;
    const names: Box = { x: rtl ? content.x + content.width - mark - 12 - namesWidth : content.x + mark + 12, width: namesWidth };
    const ordered = head.locale === 'ar' ? [head.companyAr, head.companyEn] : [head.companyEn, head.companyAr];
    pen.line(ordered[0]!, names, top + 3, 'start', { size: pen.fit(ordered[0]!, names.width, 15, 11, 'heavy'), weight: 'heavy', color: NAVY });
    pen.line(ordered[1]!, names, top + 25, 'start', { size: 9.6, weight: 'bold', color: BRAND });

    const side: Box = { x: atEnd(sideWidth), width: sideWidth };
    const titleSize = pen.fit(model.title, side.width, 17, 11.5, 'heavy');
    pen.line(model.title, side, top + 1, 'end', { size: titleSize, weight: 'heavy', color: NAVY });

    // The number in a pill, the status in a chip beside it.
    let chipsBottom = top + titleSize * LEADING + 2;
    const pills: { text: string; fill: string; color: string; ltr: boolean; weight: Weight; size: number }[] = [];
    if (model.number) pills.push({ text: model.number, fill: TINT, color: BRAND, ltr: true, weight: 'bold', size: 9.4 });
    if (model.status) {
      const tone =
        model.posted === false
          ? { fill: '#fff3df', color: '#8a5300' }
          : model.posted === true
            ? { fill: '#e4f5ec', color: '#17703f' }
            : { fill: '#eef1f6', color: MUTED };
      pills.push({ text: model.status, ...tone, ltr: false, weight: 'bold', size: 7.6 });
    }
    if (pills.length > 0) {
      const pillHeight = 17;
      let edge = rtl ? side.x : side.x + side.width;
      const pillTop = top + titleSize * LEADING + 1;
      for (const pill of pills) {
        const width = pen.width(pill.text, { size: pill.size, weight: pill.weight, ltr: pill.ltr }) + 16;
        const x = rtl ? edge : edge - width;
        doc.roundedRect(x, pillTop, width, pillHeight, pillHeight / 2).fill(pill.fill);
        pen.line(pill.text, { x, width }, pillTop + (pillHeight - pill.size * BASELINE) / 2 - pill.size * 0.12, 'center', {
          size: pill.size,
          weight: pill.weight,
          color: pill.color,
          ltr: pill.ltr,
        });
        edge = rtl ? edge + width + 6 : edge - width - 6;
      }
      chipsBottom = pillTop + pillHeight;
    }

    const ruleY = Math.max(top + mark + 8, chipsBottom + 9);
    headRule(ruleY);
    return ruleY + 16;
  };

  /** Every later page: a smaller mark and the company, and which document this page belongs to. */
  const runningHead = (): number => {
    const top = MARGIN - 4;
    const mark = 26;
    doc.image(logo, atStart(mark), top, { height: mark });
    const namesWidth = content.width * 0.55 - mark - 9;
    const names: Box = { x: rtl ? content.x + content.width - mark - 9 - namesWidth : content.x + mark + 9, width: namesWidth };
    const ordered = head.locale === 'ar' ? [head.companyAr, head.companyEn] : [head.companyEn, head.companyAr];
    pen.line(ordered[0]!, names, top, 'start', { size: 10, weight: 'heavy', color: NAVY });
    pen.line(ordered[1]!, names, top + 15, 'start', { size: 7, weight: 'bold', color: BRAND });
    const side: Box = { x: atEnd(content.width * 0.45), width: content.width * 0.45 };
    pen.line([model.title, model.number].filter(Boolean).join('  ·  '), side, top + 6, 'end', { size: 8.4, weight: 'bold', color: BRAND });
    const ruleY = top + mark + 7;
    headRule(ruleY);
    return ruleY + 14;
  };

  const ensure = (height: number, onBreak?: () => void) => {
    if (y + height <= bottom) return;
    newPage();
    onBreak?.();
  };

  // ---------------------------------------------------------------- page one
  newPage();

  if (model.fields.length > 0) facts(model.fields);

  if (model.filters.length > 0) {
    ensure(40);
    sectionTitle(head.labels.filters);
    facts(model.filters);
  }

  for (const table of model.tables) drawTable(table);

  if (model.summary.length > 0) summary(model.summary);

  inWords();

  if (model.signatures) signatures();

  // ---------------------------------------------------------------- the feet
  const range = doc.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    doc.switchToPage(index);
    // Over what the page holds, not under it: the cards and the table's rows
    // are filled, and would hide a mark drawn first.
    drawBackdrop();
    if (model.kind === 'document' && model.posted === false) watermark();
    const ruleY = pageHeight - MARGIN - 12;
    doc.moveTo(content.x, ruleY).lineTo(content.x + content.width, ruleY).lineWidth(0.5).strokeColor(HAIR).stroke();
    const textY = ruleY + 5;
    const pageText = pageOf(head.labels.pageOf, index + 1, range.count);
    const pageWidthUsed = pen.width(pageText, { size: 7.4, weight: 'bold' });
    const numberText = model.fileName;
    const numberWidth = pen.width(numberText, { size: 7, ltr: true });
    const endBox: Box = { x: atEnd(pageWidthUsed + numberWidth + 16), width: pageWidthUsed + numberWidth + 16 };
    pen.line(pageText, endBox, textY, 'end', { size: 7.4, weight: 'bold', color: BRAND });
    pen.line(numberText, endBox, textY + 0.4, 'start', { size: 7, color: MUTED, ltr: true });
    const provenance = [
      company,
      `${head.labels.printedBy}: ${head.printedBy}`,
      `${head.labels.printedAt}: ${printedAt(head.printedAt, head.locale)}`,
      `${head.labels.branch}: ${head.branch}`,
    ].join('   ·   ');
    const startWidth = content.width - endBox.width - 12;
    pen.line(provenance, { x: atStart(startWidth), width: startWidth }, textY + 0.4, 'start', {
      size: pen.fit(provenance, startWidth, 7, 5.6, 'regular'),
      color: MUTED,
    });
    band(pageHeight - 3, 3);
  }

  doc.end();
  return finished;

  // ------------------------------------------------------------------ helpers

  /** A section's name with a short bar of the brand before it. */
  function sectionTitle(text: string) {
    const size = 9.8;
    pen.line(text, { x: content.x + (rtl ? 0 : 9), width: content.width - 9 }, y, 'start', { size, weight: 'bold', color: NAVY });
    doc.roundedRect(atStart(3.2), y + size * 0.12, 3.2, size * 1.05, 1.6).fill(BRAND);
    y += size * LEADING + 4;
  }

  /**
   * Header fields on a soft card: the label small over its value, three to a
   * row on a portrait page (two when there are few), four on a landscape one.
   * A card that runs past the page is closed and opened again on the next.
   */
  function facts(list: readonly Fact[]) {
    const perRow = landscape ? 4 : list.length <= 4 ? 2 : 3;
    const padX = 12;
    const padY = 9;
    const gap = 16;
    const labelSize = 6.9;
    const valueSize = 8.8;
    const inner = content.width - 2 * padX;
    const cell = (inner - gap * (perRow - 1)) / perRow;

    const rows: { pair: readonly Fact[]; labels: string[][]; values: string[][]; height: number }[] = [];
    for (let i = 0; i < list.length; i += perRow) {
      const pair = list.slice(i, i + perRow);
      const labels = pair.map((fact) => pen.wrap(fact.label, cell, { size: labelSize, weight: 'medium' }));
      const values = pair.map((fact) => pen.wrap(fact.value || '—', cell, { size: valueSize, weight: 'bold', ltr: fact.ltr ?? false }));
      const height = Math.max(
        ...pair.map((_, n) => labels[n]!.length * labelSize * LEADING + 1 + values[n]!.length * valueSize * LEADING),
      );
      rows.push({ pair, labels, values, height: height + 7 });
    }

    let index = 0;
    while (index < rows.length) {
      if (y + padY * 2 + rows[index]!.height > bottom) newPage();
      // As many rows as fit on this page make one card.
      let height = padY * 2 - 7;
      let last = index;
      while (last < rows.length && y + height + rows[last]!.height <= bottom) {
        height += rows[last]!.height;
        last += 1;
      }
      if (last === index) last = index + 1;
      doc.roundedRect(content.x, y, content.width, height, 7).fill(CARD);
      doc.roundedRect(content.x, y, content.width, height, 7).lineWidth(0.6).strokeColor(HAIR).stroke();
      let at = y + padY;
      for (const row of rows.slice(index, last)) {
        row.pair.forEach((fact, n) => {
          const slot = rtl ? content.x + content.width - padX - (n + 1) * cell - n * gap : content.x + padX + n * (cell + gap);
          const box: Box = { x: slot, width: cell };
          row.labels[n]!.forEach((line, k) => pen.line(line, box, at + k * labelSize * LEADING, 'start', { size: labelSize, weight: 'medium', color: MUTED }));
          const valueTop = at + row.labels[n]!.length * labelSize * LEADING + 1;
          row.values[n]!.forEach((line, k) =>
            pen.line(line, box, valueTop + k * valueSize * LEADING, 'start', { size: valueSize, weight: 'bold', color: INK, ltr: fact.ltr ?? false }),
          );
        });
        at += row.height;
      }
      y += height + 14;
      index = last;
      if (index < rows.length) newPage();
    }
  }

  function drawTable(table: Table) {
    const columns = table.columns;
    // The type follows the table: fewer columns read larger, a wide report
    // smaller, and a landscape page gives a little back.
    const n = columns.length;
    const size = (n <= 4 ? 8.8 : n <= 6 ? 8.2 : n <= 8 ? 7.6 : n <= 10 ? 7 : 6.4) + (landscape ? 0.4 : 0);
    const padX = n > 8 ? 3.6 : 5;
    const padY = 3.6;
    const lineHeight = size * 1.42;
    const widths = columnWidths(columns, content.width, (i) => {
      const column = columns[i]!;
      const values = [
        ...table.rows.map((row) => display(column, row.cells[column.key] ?? null, model, head.locale)),
        display(column, table.totals?.cells[column.key] ?? null, model, head.locale),
      ];
      // A figure's heading ("Unit price · IQD") is kept on one line too.
      const title = isNumeric(column) ? pen.width(heading(column, model), { size: size - 0.4, weight: 'bold' }) : 0;
      return Math.max(title, ...values.map((value) => pen.width(value, { size, weight: 'bold', ltr: true }))) + 2 * padX + 2;
    });
    // Left edge of each column, in reading order.
    const lefts: number[] = [];
    let cursor = rtl ? content.x + content.width : content.x;
    widths.forEach((width) => {
      if (rtl) {
        cursor -= width;
        lefts.push(cursor);
      } else {
        lefts.push(cursor);
        cursor += width;
      }
    });
    const cellBox = (i: number, inset = 0): Box =>
      rtl ? { x: lefts[i]! + padX, width: widths[i]! - 2 * padX - inset } : { x: lefts[i]! + padX + inset, width: widths[i]! - 2 * padX - inset };

    if (table.title) {
      ensure(size * 2 + 48);
      y += 2;
      sectionTitle(table.title);
    }

    const headSize = size - 0.4;
    const headLines = columns.map((column, i) => pen.wrap(heading(column, model), widths[i]! - 2 * padX, { size: headSize, weight: 'bold' }));
    const headerHeight = Math.max(...headLines.map((lines) => lines.length)) * headSize * 1.42 + 2 * padY + 1;

    const drawHeader = () => {
      doc.roundedRect(content.x, y, content.width, headerHeight, 5).fill(NAVY);
      doc.rect(content.x, y + headerHeight / 2, content.width, headerHeight / 2).fill(NAVY);
      columns.forEach((column, i) => {
        headLines[i]!.forEach((line, k) =>
          pen.line(line, cellBox(i), y + padY + 0.5 + k * headSize * 1.42, isNumeric(column) ? 'end' : 'start', {
            size: headSize,
            weight: 'bold',
            color: WHITE,
          }),
        );
      });
      y += headerHeight;
    };

    ensure(headerHeight + lineHeight * 2 + 2 * padY);
    drawHeader();

    if (table.rows.length === 0) {
      const height = lineHeight + 2 * padY + 4;
      doc.rect(content.x, y, content.width, height).fill(ROW_TINT);
      pen.line(table.empty, { x: content.x + padX, width: content.width - 2 * padX }, y + padY + 2, 'center', { size, color: MUTED });
      y += height;
      doc.moveTo(content.x, y).lineTo(content.x + content.width, y).lineWidth(0.6).strokeColor(HAIR).stroke();
    }

    const cellText = (column: Column, row: Row) => display(column, row.cells[column.key] ?? null, model, head.locale);

    table.rows.forEach((row, index) => {
      const marked = row.tone === 'header' || row.tone === 'subtotal' || row.tone === 'opening' || row.tone === 'closing';
      const weight: Weight = marked ? 'bold' : 'regular';
      const indent = (row.depth ?? 0) * 9;
      const wrapped = columns.map((column, i) => pen.wrap(cellText(column, row), widths[i]! - 2 * padX - (i === 0 ? indent : 0), { size, weight }));
      const height = Math.max(1, ...wrapped.map((lines) => lines.length)) * lineHeight + 2 * padY;
      // A line is never cut by a page: if it does not fit, it starts the next
      // page, under the heading repeated there.
      ensure(height, drawHeader);
      if (marked) doc.rect(content.x, y, content.width, height).fill(TINT);
      else if (index % 2 === 1) doc.rect(content.x, y, content.width, height).fill(ROW_TINT);
      columns.forEach((column, i) => {
        wrapped[i]!.forEach((line, k) => {
          pen.line(line, cellBox(i, i === 0 ? indent : 0), y + padY + 0.5 + k * lineHeight, isNumeric(column) ? 'end' : 'start', {
            size,
            weight,
            color: marked ? NAVY : INK,
            ltr: column.kind !== 'text',
          });
        });
      });
      y += height;
      doc.moveTo(content.x, y).lineTo(content.x + content.width, y).lineWidth(0.5).strokeColor(HAIR).stroke();
    });

    if (table.totals) {
      const totals = table.totals;
      const first = columns.findIndex((column) => (totals.cells[column.key] ?? null) !== null);
      const span = first <= 0 ? 1 : first;
      const height = lineHeight + 2 * padY + 3;
      ensure(height, drawHeader);
      doc.rect(content.x, y, content.width, height).fill(TINT);
      doc.rect(content.x, y, content.width, 1.4).fill(BRAND);
      const spanLeft = rtl ? lefts[span - 1]! : lefts[0]!;
      const spanWidth = widths.slice(0, span).reduce((a, b) => a + b, 0);
      pen.line(totals.label, { x: spanLeft + padX, width: spanWidth - 2 * padX }, y + padY + 2, 'start', { size, weight: 'heavy', color: NAVY });
      columns.forEach((column, i) => {
        if (i < span) return;
        const text = display(column, totals.cells[column.key] ?? null, model, head.locale);
        pen.line(text, cellBox(i), y + padY + 2, isNumeric(column) ? 'end' : 'start', { size, weight: 'heavy', color: NAVY, ltr: true });
      });
      y += height;
    }
    y += 16;
  }

  /** Figures after the tables, at the reading end; the last of them — the result — on the brand. */
  function summary(list: readonly Fact[]) {
    const width = Math.min(content.width, landscape ? 340 : 290);
    const box: Box = { x: atEnd(width), width };
    const inner: Box = { x: box.x + 10, width: box.width - 20 };
    const rowHeight = 19;
    const lastHeight = 26;
    ensure((list.length - 1) * rowHeight + lastHeight + 6);
    list.forEach((fact, index) => {
      if (index === list.length - 1) {
        doc.roundedRect(box.x, y + 2, box.width, lastHeight, 6).fill(NAVY);
        pen.line(fact.label, inner, y + 2 + (lastHeight - 9 * LEADING) / 2 + 1, 'start', { size: 9, weight: 'bold', color: WHITE });
        pen.line(fact.value, inner, y + 2 + (lastHeight - 11 * LEADING) / 2 + 1.5, 'end', { size: 11, weight: 'heavy', color: WHITE, ltr: true });
        y += lastHeight + 4;
        return;
      }
      pen.line(fact.label, inner, y + 3, 'start', { size: 8.4, weight: 'medium', color: MUTED });
      pen.line(fact.value, inner, y + 3, 'end', { size: 9, weight: 'bold', color: INK, ltr: true });
      y += rowHeight;
      doc.moveTo(box.x, y).lineTo(box.x + box.width, y).lineWidth(0.5).strokeColor(HAIR).stroke();
    });
    y += 6;
  }

  /**
   * The amount in words, under the figures: a soft strip with the label small
   * and the words in navy — "Forty-seven million … Iraqi dinars only" /
   * "فقط سبعة وأربعون مليونًا … دينار عراقي لا غير".
   */
  function inWords() {
    const spelled = spelledAmountOf(model);
    const words = spelled ? amountInWords(spelled.amount, spelled.currency, head.locale) : null;
    if (!words) return;
    const text = head.labels.amountWordsOnly.replace('{amount}', words);
    const inner = content.width - 24;
    const lines = pen.wrap(text, inner, { size: 9, weight: 'bold' });
    const height = 10 + 7 * LEADING + lines.length * 9 * LEADING + 8;
    ensure(height + 8);
    y += 6;
    doc.roundedRect(content.x, y, content.width, height, 6).fill(CARD);
    doc.rect(atStart(3), y + 6, 3, height - 12).fill(BRAND);
    const box: Box = { x: content.x + 12, width: inner };
    pen.line(head.labels.amountInWords, box, y + 7, 'start', { size: 7, weight: 'medium', color: MUTED });
    lines.forEach((line, index) =>
      pen.line(line, box, y + 7 + 7 * LEADING + index * 9 * LEADING, 'start', { size: 9, weight: 'bold', color: NAVY }),
    );
    y += height + 4;
  }

  /** Prepared by / Approved by / Received by: a line to sign on, the role under it. */
  function signatures() {
    const height = 58;
    ensure(height + 26);
    y += 26;
    const labels = [head.labels.preparedBy, head.labels.approvedBy, head.labels.receivedBy];
    const gap = 26;
    const width = (content.width - gap * 2) / 3;
    labels.forEach((label, index) => {
      const slot = rtl ? 2 - index : index;
      const x = content.x + slot * (width + gap);
      const lineY = y + 34;
      doc.moveTo(x, lineY).lineTo(x + width, lineY).lineWidth(0.9).strokeColor(NAVY).stroke();
      doc.rect(rtl ? x + width - 22 : x, lineY - 0.8, 22, 1.6).fill(BRAND);
      pen.line(label, { x, width }, lineY + 6, 'start', { size: 8.2, weight: 'bold', color: NAVY });
    });
    y += height;
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

  const naturals = columns.map((_, i) => natural(i));
  const text = columns.map((c, i) => (c.kind === 'text' ? i : -1)).filter((i) => i >= 0);
  // A figure's column keeps a little air around its widest value and gives
  // the rest up, so a description reads on one line where it can.
  const SLACK = 22;
  const tight = proportional.map((w, i) =>
    columns[i]!.kind === 'text' ? 0 : Math.max(naturals[i]!, Math.min(w, naturals[i]! + SLACK)),
  );
  const fixed = tight.reduce((a, b) => a + b, 0);
  if (text.length === 0) return tight.map((w) => (w * width) / fixed);
  const FLOOR = 48;
  const room = width - fixed;
  if (room >= FLOOR * text.length) {
    // The room goes to the text columns, which wrap.
    const shares = waterFill(
      text.map((i) => ({ weight: weightOf(columns[i]!), need: naturals[i]! })),
      room,
    );
    return tight.map((w, i) => (text.includes(i) ? shares[text.indexOf(i)]! : w));
  }
  // Too many columns for the page: everything shrinks, and the codes wrap.
  const wanted = tight.map((w, i) => (text.includes(i) ? FLOOR : w));
  const sum = wanted.reduce((a, b) => a + b, 0);
  return wanted.map((w) => (w * width) / sum);
}

/**
 * The text columns' share of the room: by weight, but a column never takes
 * more than its longest value needs while another still wraps; what is left
 * once every column fits goes back by weight.
 */
function waterFill(columns: readonly { weight: number; need: number }[], room: number): number[] {
  const out = columns.map(() => 0);
  let open = columns.map((_, i) => i);
  let left = room;
  while (open.length > 0 && left > 0.0001) {
    const weight = open.reduce((sum, i) => sum + columns[i]!.weight, 0);
    const fits = open.filter((i) => (left * columns[i]!.weight) / weight >= columns[i]!.need);
    if (fits.length === 0) {
      for (const i of open) out[i] = (left * columns[i]!.weight) / weight;
      return out;
    }
    for (const i of fits) {
      out[i] = columns[i]!.need;
      left -= columns[i]!.need;
    }
    open = open.filter((i) => !fits.includes(i));
  }
  const weight = columns.reduce((sum, c) => sum + c.weight, 0);
  if (left > 0.0001) columns.forEach((c, i) => (out[i] = out[i]! + (left * c.weight) / weight));
  return out;
}

interface TextStyle {
  readonly size: number;
  readonly weight?: Weight;
  readonly color?: string;
  readonly opacity?: number;
  /** Always left to right: figures, codes, dates. */
  readonly ltr?: boolean;
}

/**
 * Draws text the way a bidirectional line is drawn: cut into runs, placed in
 * visual order, each run handed to the shaper on its own.
 *
 * `y` is the top of the line; the baseline is put `BASELINE` ems below it
 * whatever the font's own ascent, so the main face and the fallback share a
 * baseline and a line sits where the layout expects it.
 */
class Pen {
  constructor(
    private readonly doc: PDFKit.PDFDocument,
    private readonly direction: Direction,
  ) {}

  private use(style: TextStyle) {
    this.doc.font(style.weight ?? 'regular').fontSize(style.size);
  }

  private ascent(): number {
    const font = (this.doc as unknown as { _font?: { ascender?: number } })._font;
    return (font?.ascender ?? 1000) / 1000;
  }

  private paragraph(text: string, style: TextStyle): Direction {
    return style.ltr ? 'ltr' : directionOf(text, this.direction);
  }

  /**
   * A run cut where the face has no glyph — an arrow, a currency sign
   * Vazirmatn does not draw — so those characters come from the fallback face instead
   * of printing as a box. Only neutral characters are ever missing, so no
   * Arabic word is split from its letters. In visual order: an Arabic run's
   * pieces are laid right to left.
   */
  private pieces(run: Run, style: TextStyle): Piece[] {
    this.use(style);
    const face = (this.doc as unknown as { _font?: { font?: { hasGlyphForCodePoint?(cp: number): boolean } } })._font?.font;
    const ltr = run.direction === 'ltr';
    if (!face?.hasGlyphForCodePoint) return [{ text: run.text, font: style.weight ?? 'regular', ltr }];
    const fallback: FontName = style.weight === 'bold' || style.weight === 'heavy' ? 'fallback-bold' : 'fallback';
    const out: { text: string; font: FontName; ltr: boolean }[] = [];
    for (const char of Array.from(run.text)) {
      const code = char.codePointAt(0)!;
      const font: FontName = code > 32 && !face.hasGlyphForCodePoint(code) ? fallback : (style.weight ?? 'regular');
      const last = out[out.length - 1];
      if (last && last.font === font) last.text += char;
      else out.push({ text: char, font, ltr });
    }
    return run.direction === 'rtl' && out.length > 1 ? out.reverse() : out;
  }

  private measured(text: string, style: TextStyle): { piece: Piece; width: number }[] {
    return visualRuns(text, this.paragraph(text, style)).flatMap((run) =>
      this.pieces(run, style).map((piece) => {
        this.doc.font(piece.font).fontSize(style.size);
        return { piece, width: this.doc.widthOfString(piece.text, { features: featuresOf(piece) }) };
      }),
    );
  }

  width(text: string, style: TextStyle): number {
    return this.measured(text, style).reduce((sum, part) => sum + part.width, 0);
  }

  /** The largest size, from `max` down to `min`, at which a line fits the width. */
  fit(text: string, width: number, max: number, min: number, weight: Weight): number {
    let size = max;
    while (size > min && this.width(text, { size, weight }) > width) size -= 0.5;
    return size;
  }

  /** One line, aligned inside the box. `start` is the reading start. */
  line(text: string, box: Box, y: number, align: Align, style: TextStyle) {
    if (!text) return;
    const parts = this.measured(text, style);
    const total = parts.reduce((sum, part) => sum + part.width, 0);
    const left = align === 'center' ? false : (align === 'start') === (this.direction === 'ltr');
    let x = align === 'center' ? box.x + (box.width - total) / 2 : left ? box.x : box.x + box.width - total;
    this.doc.fillColor(style.color ?? INK);
    if (style.opacity !== undefined) this.doc.fillOpacity(style.opacity);
    for (const { piece, width } of parts) {
      this.doc.font(piece.font).fontSize(style.size);
      // `features` makes the library lay the run out whole; without it, it
      // splits at spaces and lays out each word alone, which scrambles the
      // order of Arabic words.
      this.doc.text(piece.text, x, y + style.size * (BASELINE - this.ascent()), { lineBreak: false, features: featuresOf(piece) });
      x += width;
    }
    if (style.opacity !== undefined) this.doc.fillOpacity(1);
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
