import {
  AlignmentType,
  BorderStyle,
  CharacterSet,
  Document,
  Footer,
  Header,
  HeightRule,
  HorizontalPositionAlign,
  HorizontalPositionRelativeFrom,
  ImageRun,
  Packer,
  PageNumber,
  PageOrientation,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlignTable,
  VerticalPositionAlign,
  VerticalPositionRelativeFrom,
  WidthType,
  type ParagraphChild,
} from 'docx';
import { asset } from './assets';
import { hasRightToLeft } from './bidi';
import { display, heading, printedAt } from './format';
import { columnWidths } from './pdf';
import { isNumeric, type Fact, type Letterhead, type PrintModel, type Table as PrintTable } from './model';

/**
 * The Word document — the PDF's layout as an editable document.
 *
 * Same letterhead (a header, so Word repeats it on every page), same title
 * and large number, same fields, same ruled tables; the heading row of each
 * table is marked to repeat on every page and no row may break across one,
 * which are Word's own settings for the two rules the PDF keeps by hand.
 * "Page 1 of 3" is Word's page fields, so it stays right after an edit.
 *
 * The Arabic font is embedded in the file: a machine without it still shows
 * the document in the face it was drawn in, with no substituted or boxed
 * glyphs. An unposted document carries the DRAFT / NOT POSTED mark behind
 * the text of every page, placed in the header as Word places its own
 * watermarks.
 */

const FONT = 'IBM Plex Sans Arabic';
const TWIP_PER_PT = 20;
const MARGIN = 680; // 12 mm
const BODY = 17; // half-points: 8.5 pt
const SMALL = 15;

export async function renderDocx(model: PrintModel, head: Letterhead): Promise<Buffer> {
  const rtl = head.locale === 'ar';
  const landscape = model.orientation === 'landscape';
  const pageWidth = landscape ? 16838 : 11906;
  const pageHeight = landscape ? 11906 : 16838;
  const contentWidth = pageWidth - 2 * MARGIN;
  const align = (end: boolean) => (end ? AlignmentType.END : AlignmentType.START);

  const run = (text: string, options: { bold?: boolean; size?: number; color?: string } = {}) =>
    new TextRun({
      text,
      bold: options.bold ?? false,
      boldComplexScript: options.bold ?? false,
      size: options.size ?? BODY,
      sizeComplexScript: options.size ?? BODY,
      ...(options.color ? { color: options.color } : {}),
      font: FONT,
      // Marks the run as right-to-left script so Word shapes and orders it;
      // figures and codes are left as they are and read left to right.
      rightToLeft: hasRightToLeft(text),
    });

  const paragraph = (
    children: ParagraphChild[],
    options: { end?: boolean; center?: boolean; spacingAfter?: number; indent?: number } = {},
  ) =>
    new Paragraph({
      children,
      bidirectional: rtl,
      alignment: options.center ? AlignmentType.CENTER : align(options.end ?? false),
      spacing: { before: 0, after: options.spacingAfter ?? 0 },
      ...(options.indent ? { indent: { start: options.indent } } : {}),
    });

  const noBorders = {
    top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    insideHorizontal: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    insideVertical: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  };

  // ------------------------------------------------------------ letterhead
  const logoWidth = 60;
  const logoHeight = Math.round((logoWidth * 324) / 360);
  const companies = rtl ? [head.companyAr, head.companyEn] : [head.companyEn, head.companyAr];
  const provenance = [
    `${head.labels.branch}: ${head.branch}`,
    `${head.labels.printedAt}: ${printedAt(head.printedAt, head.locale)}`,
    `${head.labels.printedBy}: ${head.printedBy}`,
  ];
  const headerWidths = [1300, Math.round(contentWidth * 0.52) - 1300, contentWidth - Math.round(contentWidth * 0.52)];
  const letterhead = new Table({
    width: { size: contentWidth, type: WidthType.DXA },
    columnWidths: headerWidths,
    layout: TableLayoutType.FIXED,
    visuallyRightToLeft: rtl,
    borders: {
      ...noBorders,
      bottom: { style: BorderStyle.SINGLE, size: 16, color: '111111' },
    },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            width: { size: headerWidths[0]!, type: WidthType.DXA },
            verticalAlign: VerticalAlignTable.CENTER,
            children: [
              paragraph([
                new ImageRun({
                  type: 'png',
                  data: asset('logo-print.png'),
                  transformation: { width: logoWidth, height: logoHeight },
                }),
              ]),
            ],
          }),
          new TableCell({
            width: { size: headerWidths[1]!, type: WidthType.DXA },
            verticalAlign: VerticalAlignTable.CENTER,
            children: [
              paragraph([run(companies[0]!, { bold: true, size: 27 })]),
              paragraph([run(companies[1]!, { bold: true, size: 22, color: '4A4A4A' })]),
            ],
          }),
          new TableCell({
            width: { size: headerWidths[2]!, type: WidthType.DXA },
            verticalAlign: VerticalAlignTable.CENTER,
            children: provenance.map((line) => paragraph([run(line, { size: SMALL, color: '4A4A4A' })], { end: true })),
          }),
        ],
      }),
    ],
  });

  const headerChildren: (Paragraph | Table)[] = [letterhead];
  if (model.kind === 'document' && model.posted === false) {
    const mark = asset(rtl ? 'watermark-ar.png' : 'watermark-en.png');
    const [w, h] = rtl ? [1028, 680] : [1384, 877];
    const width = Math.round(((pageWidth - 2 * MARGIN) / TWIP_PER_PT) * 1.1);
    headerChildren.push(
      new Paragraph({
        children: [
          new ImageRun({
            type: 'png',
            data: mark,
            transformation: { width, height: Math.round((width * h) / w) },
            floating: {
              horizontalPosition: { relative: HorizontalPositionRelativeFrom.PAGE, align: HorizontalPositionAlign.CENTER },
              verticalPosition: { relative: VerticalPositionRelativeFrom.PAGE, align: VerticalPositionAlign.CENTER },
              behindDocument: true,
              allowOverlap: true,
            },
          }),
        ],
      }),
    );
  }

  // ------------------------------------------------------------------ foot
  const [before, middle, after] = splitPageOf(head.labels.pageOf);
  const footer = new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        bidirectional: rtl,
        border: { top: { style: BorderStyle.SINGLE, size: 4, color: '888888', space: 4 } },
        children: [
          new TextRun({
            children: [before, PageNumber.CURRENT, middle, PageNumber.TOTAL_PAGES, after],
            size: SMALL,
            font: FONT,
            color: '4A4A4A',
            rightToLeft: rtl,
          }),
          new TextRun({ text: `   ·   ${model.fileName}`, size: SMALL, font: FONT, color: '4A4A4A' }),
        ],
      }),
    ],
  });

  // ------------------------------------------------------------------ body
  const body: (Paragraph | Table)[] = [];
  body.push(
    new Table({
      width: { size: contentWidth, type: WidthType.DXA },
      columnWidths: [Math.round(contentWidth * 0.55), contentWidth - Math.round(contentWidth * 0.55)],
      layout: TableLayoutType.FIXED,
      visuallyRightToLeft: rtl,
      borders: noBorders,
      rows: [
        new TableRow({
          children: [
            new TableCell({
              children: [
                paragraph([run(model.title, { bold: true, size: 31 })], { spacingAfter: 40 }),
              ],
            }),
            new TableCell({
              verticalAlign: VerticalAlignTable.CENTER,
              children: model.number ? [paragraph([run(model.number, { bold: true, size: 38 })], { end: true })] : [paragraph([])],
            }),
          ],
        }),
      ],
    }),
  );
  body.push(paragraph([], { spacingAfter: 120 }));

  const factsTable = (list: readonly Fact[]) => {
    const perRow = 2;
    const cell = Math.floor(contentWidth / perRow);
    const labelWidth = Math.round(cell * 0.42);
    const widths = [labelWidth, cell - labelWidth, labelWidth, cell - labelWidth];
    const rows: TableRow[] = [];
    for (let i = 0; i < list.length; i += perRow) {
      const pair = list.slice(i, i + perRow);
      const cells: TableCell[] = [];
      for (let slot = 0; slot < perRow; slot += 1) {
        const fact = pair[slot];
        cells.push(
          new TableCell({
            width: { size: widths[slot * 2]!, type: WidthType.DXA },
            borders: { bottom: { style: BorderStyle.SINGLE, size: 2, color: '9A9A9A' } },
            children: [paragraph(fact ? [run(fact.label, { bold: true, color: '4A4A4A' })] : [])],
          }),
          new TableCell({
            width: { size: widths[slot * 2 + 1]!, type: WidthType.DXA },
            borders: { bottom: { style: BorderStyle.SINGLE, size: 2, color: '9A9A9A' } },
            children: [paragraph(fact ? [run(fact.value || '—')] : [])],
          }),
        );
      }
      rows.push(new TableRow({ cantSplit: true, children: cells }));
    }
    return new Table({
      width: { size: contentWidth, type: WidthType.DXA },
      columnWidths: widths,
      layout: TableLayoutType.FIXED,
      visuallyRightToLeft: rtl,
      borders: noBorders,
      rows,
    });
  };

  if (model.fields.length > 0) {
    body.push(factsTable(model.fields));
    body.push(paragraph([], { spacingAfter: 160 }));
  }
  if (model.filters.length > 0) {
    body.push(paragraph([run(head.labels.filters, { bold: true })], { spacingAfter: 60 }));
    body.push(factsTable(model.filters));
    body.push(paragraph([], { spacingAfter: 160 }));
  }

  for (const table of model.tables) body.push(...linesTable(table));

  if (model.summary.length > 0) {
    const width = Math.min(contentWidth, 6000);
    body.push(
      new Table({
        width: { size: width, type: WidthType.DXA },
        columnWidths: [Math.round(width * 0.55), width - Math.round(width * 0.55)],
        layout: TableLayoutType.FIXED,
        visuallyRightToLeft: rtl,
        alignment: AlignmentType.END,
        rows: model.summary.map(
          (fact) =>
            new TableRow({
              cantSplit: true,
              children: [
                new TableCell({
                  shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'F1F1F1' },
                  children: [paragraph([run(fact.label, { bold: true })])],
                }),
                new TableCell({
                  shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'F1F1F1' },
                  children: [paragraph([run(fact.value, { bold: true, size: BODY + 2 })], { end: true })],
                }),
              ],
            }),
        ),
      }),
    );
  }

  if (model.signatures) {
    body.push(paragraph([], { spacingAfter: 360 }));
    const labels = [head.labels.preparedBy, head.labels.approvedBy, head.labels.receivedBy];
    const gap = 280;
    const width = Math.floor((contentWidth - 2 * gap) / 3);
    const box = (label: string) =>
      new TableCell({
        width: { size: width, type: WidthType.DXA },
        borders: {
          top: { style: BorderStyle.SINGLE, size: 6, color: '444444' },
          bottom: { style: BorderStyle.SINGLE, size: 6, color: '444444' },
          left: { style: BorderStyle.SINGLE, size: 6, color: '444444' },
          right: { style: BorderStyle.SINGLE, size: 6, color: '444444' },
        },
        children: [paragraph([run(label, { bold: true })]), paragraph([]), paragraph([]), paragraph([])],
      });
    const spacer = () =>
      new TableCell({ width: { size: gap, type: WidthType.DXA }, borders: noBorders, children: [paragraph([])] });
    body.push(
      new Table({
        width: { size: contentWidth, type: WidthType.DXA },
        columnWidths: [width, gap, width, gap, width],
        layout: TableLayoutType.FIXED,
        visuallyRightToLeft: rtl,
        borders: noBorders,
        rows: [
          new TableRow({
            cantSplit: true,
            height: { value: 1250, rule: HeightRule.ATLEAST },
            children: [box(labels[0]!), spacer(), box(labels[1]!), spacer(), box(labels[2]!)],
          }),
        ],
      }),
    );
  }

  const document = new Document({
    creator: 'QS ERP',
    title: [model.title, model.number].filter(Boolean).join(' '),
    description: model.fileName,
    fonts: [
      { name: FONT, data: asset('IBMPlexSansArabic-Regular.ttf'), characterSet: CharacterSet.ARABIC },
    ],
    styles: {
      default: {
        document: {
          run: { font: FONT, size: BODY, sizeComplexScript: BODY },
          paragraph: { spacing: { before: 0, after: 0 } },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: {
              width: pageWidth,
              height: pageHeight,
              orientation: landscape ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT,
            },
            margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN, header: 400, footer: 400 },
          },
        },
        headers: { default: new Header({ children: headerChildren }) },
        footers: { default: footer },
        children: body,
      },
    ],
  });

  return Packer.toBuffer(document);

  // ---------------------------------------------------------------- tables
  function linesTable(table: PrintTable): (Paragraph | Table)[] {
    const out: (Paragraph | Table)[] = [];
    if (table.title) out.push(paragraph([run(table.title, { bold: true, size: BODY + 3 })], { spacingAfter: 80 }));
    const size = table.columns.length > 7 ? 15 : BODY;
    // Word measures for itself; this is an estimate of the widest code, date
    // or figure in each column (a character is about 0.56 of the font size),
    // so that Word, too, never breaks a number across lines.
    const widths = columnWidths(table.columns, contentWidth, (i) => {
      const column = table.columns[i]!;
      const values = [
        ...table.rows.map((row) => display(column, row.cells[column.key] ?? null, model, head.locale)),
        display(column, table.totals?.cells[column.key] ?? null, model, head.locale),
      ];
      const longest = Math.max(0, ...values.map((value) => value.length));
      return Math.ceil(longest * (size / 2) * 0.56 * TWIP_PER_PT) + 240;
    }).map((w) => Math.round(w));
    const shade = (fill: string) => ({ type: ShadingType.CLEAR, color: 'auto', fill });

    const header = new TableRow({
      tableHeader: true,
      cantSplit: true,
      children: table.columns.map(
        (column, i) =>
          new TableCell({
            width: { size: widths[i]!, type: WidthType.DXA },
            shading: shade('E6E6E6'),
            verticalAlign: VerticalAlignTable.CENTER,
            children: [paragraph([run(heading(column, model), { bold: true, size: size - 1 })], { end: isNumeric(column) })],
          }),
      ),
    });

    const rows: TableRow[] = [header];
    if (table.rows.length === 0) {
      rows.push(
        new TableRow({
          cantSplit: true,
          children: [
            new TableCell({
              columnSpan: table.columns.length,
              children: [paragraph([run(table.empty, { color: '4A4A4A', size })], { center: true })],
            }),
          ],
        }),
      );
    }
    for (const row of table.rows) {
      const bold = row.tone === 'header' || row.tone === 'subtotal' || row.tone === 'opening' || row.tone === 'closing';
      const shaded = row.tone === 'subtotal' || row.tone === 'opening' || row.tone === 'closing';
      rows.push(
        new TableRow({
          cantSplit: true,
          children: table.columns.map(
            (column, i) =>
              new TableCell({
                width: { size: widths[i]!, type: WidthType.DXA },
                ...(shaded ? { shading: shade('F1F1F1') } : {}),
                children: [
                  paragraph([run(display(column, row.cells[column.key] ?? null, model, head.locale), { bold, size })], {
                    end: isNumeric(column),
                    ...(i === 0 && row.depth ? { indent: row.depth * 200 } : {}),
                  }),
                ],
              }),
          ),
        }),
      );
    }
    if (table.totals) {
      const totals = table.totals;
      const first = table.columns.findIndex((column) => (totals.cells[column.key] ?? null) !== null);
      const span = first <= 0 ? 1 : first;
      rows.push(
        new TableRow({
          cantSplit: true,
          children: [
            new TableCell({
              columnSpan: span,
              shading: shade('F1F1F1'),
              borders: { top: { style: BorderStyle.SINGLE, size: 14, color: '111111' } },
              children: [paragraph([run(totals.label, { bold: true, size })])],
            }),
            ...table.columns.slice(span).map(
              (column, index) =>
                new TableCell({
                  width: { size: widths[span + index]!, type: WidthType.DXA },
                  shading: shade('F1F1F1'),
                  borders: { top: { style: BorderStyle.SINGLE, size: 14, color: '111111' } },
                  children: [
                    paragraph([run(display(column, totals.cells[column.key] ?? null, model, head.locale), { bold: true, size })], {
                      end: isNumeric(column),
                    }),
                  ],
                }),
            ),
          ],
        }),
      );
    }
    out.push(
      new Table({
        width: { size: contentWidth, type: WidthType.DXA },
        columnWidths: widths,
        layout: TableLayoutType.FIXED,
        visuallyRightToLeft: rtl,
        rows,
      }),
    );
    out.push(paragraph([], { spacingAfter: 200 }));
    return out;
  }
}

/** "Page {page} of {pages}" → the text around Word's two page fields. */
function splitPageOf(template: string): [string, string, string] {
  const [before, rest = ''] = template.split('{page}');
  const [middle, after = ''] = rest.split('{pages}');
  return [before ?? '', middle ?? '', after];
}
