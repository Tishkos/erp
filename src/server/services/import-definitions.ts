/**
 * Import definitions — Phase 01.11, Phase 03.9.
 *
 * Each definition maps a file row to the input a screen would build, and then
 * calls **the same service function the screen calls**. That is the whole
 * point: §4.4 requires an import to respect the same permissions and
 * validations as manual entry, and the only way to be sure of that is to have
 * one implementation.
 *
 * Note what a definition cannot do. It has no access to the tables, so it
 * cannot skip the duplicate search, cannot bypass an approval route, and cannot
 * write a record a person would not have been allowed to write.
 */
import {
  booleanCell,
  optionalCell,
  requireCell,
  type RawImportRow,
} from '../domain/import';
import type { PartnerStatus } from '../domain/business-partner';
import { registerDefinition } from './import';
import * as partners from './business-partner';
import * as inventory from './inventory';
import * as statements from './bank-statement';
import { parseQuantity } from '../domain/uom';
import { parseDecimal } from '../domain/money';

/**
 * §26 — master data is imported "with source ID".
 *
 * The column is optional in the file but the framework keeps whatever is there,
 * so a migrated record can always be traced back to the system it came from.
 */
const SOURCE_ID_COLUMN = 'source_id';

registerDefinition<partners.CreatePartnerInput>({
  key: 'business_partner',
  label: 'Business Partner',
  permissionObject: partners.PERMISSION_OBJECT,
  requiredColumns: ['code', 'legal_name'],
  sourceIdColumn: SOURCE_ID_COLUMN,

  mapRow(row: RawImportRow): partners.CreatePartnerInput {
    const isCustomer = booleanCell(row, 'is_customer', false);
    const isSupplier = booleanCell(row, 'is_supplier', false);

    // The role check runs here as well as in the service, so a file with a
    // role-less row is caught in the preview rather than at commit — which is
    // the difference between an error file and a failed import.
    if (!isCustomer && !isSupplier) {
      throw new Error(
        'is_customer and is_supplier are both no. A partner must be a customer, a supplier, or both (§6).',
      );
    }

    const status = optionalCell(row, 'status');
    if (status && !isPartnerStatus(status)) {
      throw new Error(
        `status is "${status}"; it must be one of prospect, active, on_hold, blocked, inactive (§6).`,
      );
    }

    return {
      code: requireCell(row, 'code'),
      legalName: requireCell(row, 'legal_name'),
      tradeName: optionalCell(row, 'trade_name'),
      isCustomer,
      isSupplier,
      ...(status ? { status: status as PartnerStatus } : {}),
      registrationNo: optionalCell(row, 'registration_no'),
      taxIdentifier: optionalCell(row, 'tax_identifier'),
      email: optionalCell(row, 'email'),
      phone: optionalCell(row, 'phone'),
      address: optionalCell(row, 'address'),
      creditLimitIqd: optionalCell(row, 'credit_limit_iqd'),
    };
  },

  // The ordinary create, with its duplicate search and its permission check.
  // An import that wanted to skip either would have to change this line, and
  // that is exactly the change a reviewer should see.
  commitRow: (tx, ctx, input) => partners.createPartner(tx, ctx, input),
});

function isPartnerStatus(value: string): value is PartnerStatus {
  return ['prospect', 'active', 'on_hold', 'blocked', 'inactive'].includes(value);
}

/**
 * Inventory movements — Phase 04.4, §9.9.
 *
 * §9.9: *"No UI, import or API transaction can create negative stock."* The
 * import path is the one people assume is different, because a file feels like
 * data rather than a transaction. It is not different here: `commitRow` calls
 * `inventory.issue`, which checks availability and refuses, exactly as it does
 * for a screen. There is no bulk path, no "skip validation" flag and no second
 * implementation to drift.
 *
 * Opening a warehouse is `opening_stock` (§9.7), not this. This is for movements
 * a migration needs to replay — receipts and issues that already happened.
 */
registerDefinition<InventoryImportInput>({
  key: 'inventory_movement',
  label: 'Inventory Movement',
  permissionObject: inventory.PERMISSION_OBJECT,
  requiredColumns: ['item_code', 'warehouse_code', 'branch_code', 'quantity', 'movement_date'],
  sourceIdColumn: SOURCE_ID_COLUMN,

  mapRow(row: RawImportRow): InventoryImportInput {
    const quantity = parseQuantity(requireCell(row, 'quantity'));

    if (quantity === 0n) {
      throw new Error('quantity is zero. A movement of nothing is not a movement.');
    }

    const unitCost = optionalCell(row, 'unit_cost_iqd');

    if (quantity > 0n && !unitCost) {
      throw new Error(
        'unit_cost_iqd is missing. Stock coming in needs a cost, because it becomes a FIFO layer (§9.2).',
      );
    }

    return {
      itemCode: requireCell(row, 'item_code'),
      warehouseCode: requireCell(row, 'warehouse_code'),
      branchCode: requireCell(row, 'branch_code'),
      quantity,
      unitCostIqd: unitCost ? parseDecimal(unitCost, 4n) : 0n,
      movementDate: requireCell(row, 'movement_date'),
      serialNumber: optionalCell(row, 'serial_number'),
      batchNumber: optionalCell(row, 'batch_number'),
    };
  },

  // The same two functions a screen calls. An import that wanted to write stock
  // without the availability check would have to change this line.
  commitRow: async (tx, ctx, input) => {
    const result =
      input.quantity > 0n
        ? await inventory.receive(tx, ctx, {
            itemCode: input.itemCode,
            warehouseCode: input.warehouseCode,
            branchCode: input.branchCode,
            quantity: input.quantity,
            unitCostIqd: input.unitCostIqd,
            movementDate: input.movementDate,
            kind: 'goods_receipt',
            serialNumber: input.serialNumber,
            batchNumber: input.batchNumber,
          })
        : await inventory.issue(tx, ctx, {
            itemCode: input.itemCode,
            warehouseCode: input.warehouseCode,
            branchCode: input.branchCode,
            quantity: -input.quantity,
            movementDate: input.movementDate,
            kind: 'delivery',
            serialNumber: input.serialNumber,
            batchNumber: input.batchNumber,
          });

    return { id: result.movementId };
  },
});

interface InventoryImportInput {
  readonly itemCode: string;
  readonly warehouseCode: string;
  readonly branchCode: string;
  /** Signed: positive receives, negative issues. */
  readonly quantity: bigint;
  readonly unitCostIqd: bigint;
  readonly movementDate: string;
  readonly serialNumber: string | null;
  readonly batchNumber: string | null;
}

/**
 * Bank statement lines — Phase 07.6, §17 and §23.
 *
 * > §23: a file-import centre *"for bank statements"*, with preview, error file
 * > and batch ID.
 *
 * **The header is not in the file.** Somebody opens the statement first — whose
 * account, which period, and the bank's own opening and closing balances — and
 * the file supplies the lines. That is not ceremony: the closing balance is the
 * claim the file is checked against when the statement is closed, and a closing
 * balance taken from the same file it is meant to check proves nothing.
 *
 * `commitRow` calls `appendLine`, the same function a manual entry screen calls,
 * so the unique import key, the value-date rule and the zero-amount rule apply
 * to a file exactly as they do to typing.
 */
registerDefinition<BankStatementLineImportInput>({
  key: 'bank_statement_line',
  label: 'Bank Statement Line',
  permissionObject: statements.PERMISSION_OBJECT,
  requiredColumns: ['statement_no', 'booking_date', 'amount_iqd'],
  sourceIdColumn: SOURCE_ID_COLUMN,

  mapRow(row: RawImportRow): BankStatementLineImportInput {
    const bookingDate = requireCell(row, 'booking_date');
    const amount = parseDecimal(requireCell(row, 'amount_iqd'), 4n);

    if (amount === 0n) {
      throw new Error(
        'amount_iqd is zero. A movement of nothing is not a movement — a balance marker or a ' +
          'heading is not a transaction line (§17).',
      );
    }

    return {
      statementNo: requireCell(row, 'statement_no'),
      lineNo: row.rowNo,
      bookingDate,
      // §17 — where the bank gives no value date, the money is treated as
      // available when it was booked. Assuming it cleared *earlier* would be
      // inventing a fact in the company's favour.
      valueDate: optionalCell(row, 'value_date') ?? bookingDate,
      amountIqd: amount,
      reference: optionalCell(row, 'reference'),
      counterparty: optionalCell(row, 'counterparty'),
      description: optionalCell(row, 'description'),
      bankReference: optionalCell(row, 'bank_reference'),
    };
  },

  commitRow: async (tx, ctx, input) => {
    const statement = await statements.findByNo(tx, input.statementNo);

    const result = await statements.appendLine(tx, ctx, statement.id, {
      lineNo: input.lineNo,
      bookingDate: input.bookingDate,
      valueDate: input.valueDate,
      amountIqd: input.amountIqd,
      reference: input.reference,
      counterparty: input.counterparty,
      description: input.description,
      bankReference: input.bankReference,
    });

    // A duplicate is not an error and not a new row. The batch still records
    // the line, pointing at the statement it was already part of, so the
    // preview count and the committed count do not silently disagree.
    return { id: result.id ?? statement.id };
  },
});

interface BankStatementLineImportInput {
  readonly statementNo: string;
  readonly lineNo: number;
  readonly bookingDate: string;
  readonly valueDate: string;
  readonly amountIqd: bigint;
  readonly reference: string | null;
  readonly counterparty: string | null;
  readonly description: string | null;
  readonly bankReference: string | null;
}
