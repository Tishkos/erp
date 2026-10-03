/**
 * IMPROVEMENT-002 — the ASYCUDA reading as a document (sponsor, 2026-10-03:
 * "a table like other pages … a new ASYCUDA document … add the attachment").
 *
 *   * Every reading is numbered ASY-{YYYY}-{SERIAL}; the export it was read
 *     from is filed on it as its attachments.
 *   * The register finds readings by number or file name, by status, with the
 *     count of files kept.
 *   * The document's lines are the list in ASYCUDA's order — read and unread
 *     lines together, each with its own fields — beside what the PD was then
 *     and is now; applying it once moves the PD, a second time is refused.
 *   * The printed copy carries the same lines.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerPool, rejection } from './setup';
import { withScope } from '@/server/db/client';
import { registerAttachmentRuntime } from '@/server/attachments-runtime';
import * as attachments from '@/server/services/attachments';
import { businessToday } from '@/server/domain/business-date';
import * as ap from '@/server/services/ap-invoice';
import * as asycuda from '@/server/services/asycuda-runs';
import * as customs from '@/server/services/customs-pd';
import { asycudaReading } from '@/server/print/customs-documents';
import { messagesFor } from '@/server/print/i18n';
import { parseDecimal } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';
import { BAGHDAD, PANEL, WAREHOUSE, buildTradingWorld, scope, type TradingWorld } from './trading-fixture';

let world: TradingWorld;
let pdId: string;
const YEAR = businessToday().slice(0, 4);

const LIST = ['PD No\tStatus\tDate', '9330\tValidated\t08/09/2026', '7777 Validated', '9330 Lost in the post'].join('\n');

beforeEach(async () => {
  world = await buildTradingWorld();
  registerAttachmentRuntime();
  const files = new Map<string, Buffer>();
  attachments.registerStorage({ put: async (key, content) => void files.set(key, content), get: async (key) => files.get(key) ?? null });
  attachments.registerScanner(() => ({ status: 'clean' }));
  const made = await withScope(scope(world.clerk), (tx) =>
    ap.create(tx, world.clerk, {
      supplierId: world.supplierId,
      supplierInvoiceNo: 'CSA-ASY-0001',
      branchCode: BAGHDAD,
      invoiceDate: '2026-09-01',
      dueDate: '2026-11-01',
      isImport: true,
      lines: [
        {
          itemCode: PANEL,
          description: 'Solar Panel 550W',
          quantity: parseQuantity('10'),
          unitPriceIqd: parseDecimal('10000', 4n),
          uomCode: 'EA',
          isInventory: true,
          warehouseCode: WAREHOUSE,
        },
      ],
    }),
  );
  const { rows } = await ownerPool.query(`select payable_id from ap_invoice where id = $1`, [made.id]);
  const pd = await withScope(scope(world.clerk), (tx) =>
    customs.register(tx, world.clerk, {
      payableId: rows[0].payable_id,
      pdNo: '9330',
      registrationDate: '2026-09-02',
      expiryDate: '2027-03-01',
      bankCode: null,
    }),
  );
  pdId = pd.id;
});

const read = (input: { text: string; fileNames?: string[]; files?: asycuda.UploadedFile[] }) =>
  withScope(scope(world.clerk), (tx) =>
    asycuda.startRun(tx, world.clerk, {
      source: input.files?.length ? 'file' : 'paste',
      fileNames: input.fileNames ?? [],
      text: input.text,
      ...(input.files ? { files: input.files } : {}),
    }),
  );

describe('IMPROVEMENT-002 · the ASYCUDA reading is a numbered document', () => {
  it('numbers each reading and files the export it was read from on it', async () => {
    const file = { fileName: 'asycuda-2026-10-03.csv', content: Buffer.from('9330,Validated,08/09/2026\n7777,Validated\n') };
    const fromFile = await read({ text: asycuda.readFiles([file]).text, fileNames: [file.fileName], files: [file] });
    const pasted = await read({ text: LIST });

    expect(fromFile.runNo).toBe(`ASY-${YEAR}-00001`);
    expect(pasted.runNo).toBe(`ASY-${YEAR}-00002`);
    expect(fromFile.changeCount).toBe(1);

    const { rows: files } = await ownerPool.query(
      `select file_name from attachment where object_type = 'asycuda_run' and object_id = $1 and superseded_by_id is null`,
      [fromFile.id],
    );
    expect(files.map((row) => row.file_name)).toEqual(['asycuda-2026-10-03.csv']);
    const { rows: audit } = await ownerPool.query(
      `select after_value->>'runNo' as run_no from audit_event where action = 'asycuda.list_read' and object_id = $1`,
      [fromFile.id],
    );
    expect(audit[0]?.run_no).toBe(fromFile.runNo);
  });

  it('lists the readings by number, by file name and by status, with the files kept', async () => {
    const file = { fileName: 'customs-export.xlsx.csv', content: Buffer.from('9330,Validated\n') };
    const first = await read({ text: asycuda.readFiles([file]).text, fileNames: [file.fileName], files: [file] });
    const second = await read({ text: LIST });
    await withScope(scope(world.clerk), (tx) => asycuda.applyRun(tx, world.clerk, second.id));

    const all = await withScope(scope(world.clerk), (tx) => asycuda.listRuns(tx, {}));
    expect(all.total).toBe(2);
    expect(all.rows.map((row) => row.runNo)).toEqual([second.runNo, first.runNo]);
    expect(all.rows.find((row) => row.runNo === first.runNo)).toMatchObject({ files: 1, source: 'file', status: 'previewed' });
    expect(all.rows.find((row) => row.runNo === second.runNo)).toMatchObject({ files: 0, source: 'paste', status: 'applied' });
    expect(all.rows[0]!.readBy).toBeTruthy();

    const byNumber = await withScope(scope(world.clerk), (tx) => asycuda.listRuns(tx, { search: second.runNo.toLowerCase() }));
    expect(byNumber.rows.map((row) => row.runNo)).toEqual([second.runNo]);
    const byFile = await withScope(scope(world.clerk), (tx) => asycuda.listRuns(tx, { search: 'customs-export' }));
    expect(byFile.rows.map((row) => row.runNo)).toEqual([first.runNo]);
    const applied = await withScope(scope(world.clerk), (tx) => asycuda.listRuns(tx, { status: 'applied' }));
    expect(applied.rows.map((row) => row.runNo)).toEqual([second.runNo]);
  });

  it('shows the list in ASYCUDA’s order, applies once, and reads the PD as it is now', async () => {
    const reading = await read({ text: LIST });
    const before = await withScope(scope(world.clerk), async (tx) => {
      const found = await asycuda.runByNo(tx, reading.runNo.toLowerCase());
      return asycuda.runLines(tx, found!.run);
    });
    expect(before.map((line) => [line.line, line.outcome])).toEqual([
      [1, 'unreadable'],
      [2, 'change'],
      [3, 'not_found'],
      [4, 'unreadable'],
    ]);
    expect(before[1]).toMatchObject({
      fields: ['9330', 'Validated', '08/09/2026'],
      pdNo: '9330',
      asycudaStatus: 'validated',
      wasStatus: 'submitted',
      effectiveDate: '2026-09-08',
      pd: { pdNo: '9330', statusCode: 'submitted' },
    });
    expect(before[3]!.why).toMatch(/not a PD status/);

    await withScope(scope(world.clerk), (tx) => asycuda.applyRun(tx, world.clerk, reading.id));
    const after = await withScope(scope(world.clerk), async (tx) => {
      const found = await asycuda.runByNo(tx, reading.runNo);
      return { found, lines: await asycuda.runLines(tx, found!.run) };
    });
    expect(after.found!.run.status).toBe('applied');
    expect(after.found!.appliedByName).toBeTruthy();
    // What it was when read stays; what it is now has moved.
    expect(after.lines[1]).toMatchObject({ wasStatus: 'submitted', pd: { statusCode: 'validated' } });
    const { rows } = await ownerPool.query(`select status_code from customs_pd where id = $1`, [pdId]);
    expect(rows[0].status_code).toBe('validated');

    expect(await rejection(withScope(scope(world.clerk), (tx) => asycuda.applyRun(tx, world.clerk, reading.id)))).toMatch(
      /already been applied/,
    );
  });

  it('prints the reading with its lines', async () => {
    const reading = await read({ text: LIST });
    const built = await withScope(scope(world.clerk), (tx) =>
      asycudaReading({ tx, principal: world.clerk.principal, branchCode: BAGHDAD, locale: 'en', m: messagesFor('en') }, reading.runNo),
    );
    expect(built?.model.number).toBe(reading.runNo);
    expect(built?.objectId).toBe(reading.id);
    const table = built!.model.kind === 'document' ? built!.model.tables[0]! : null;
    expect(table?.rows.map((row) => row.cells.line)).toEqual(['1', '2', '3', '4']);
    expect(table?.rows[1]!.cells).toMatchObject({ pd: '9330', says: 'Validated', outcome: 'Will be updated' });

    const missing = await withScope(scope(world.clerk), (tx) =>
      asycudaReading({ tx, principal: world.clerk.principal, branchCode: BAGHDAD, locale: 'en', m: messagesFor('en') }, 'ASY-1999-00001'),
    );
    expect(missing).toBeNull();
  });
});
