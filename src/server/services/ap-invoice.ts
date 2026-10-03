/**
 * A/P Invoice and three-way match — Phase 05.4 and 05.5, §8.4 and §15.
 *
 * Where the two purchasing flows converge. Goods arrived on a Goods Receipt
 * (05.2), services were confirmed by the benefiting department (05.3), and this
 * is the document that says what the company owes for them.
 *
 * **The match runs on every change, not on demand.** §8.4's gate asks that
 * *"match status is visible on the invoice at all times"*, and a status computed
 * only when somebody presses a button is visible only after they press it. So
 * `rematch()` runs when lines are added and again at submission, and the stored
 * status is always the answer to "as of now".
 *
 * **Posting (Appendix C).** Inventory lines clear GRNI — the account the goods
 * receipt credited — so a fully received and fully invoiced order leaves GRNI at
 * zero, which is 05.5's gate. Service lines go straight to expense. Any variance
 * posts to its **own account**, never into inventory: stock was valued at the PO
 * price when it arrived, and letting an invoice restate that would put the FIFO
 * layers and the inventory control account out of step, which §9.9's
 * reconciliation exists to detect.
 */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  apInvoice,
  apInvoiceLine,
  appUser,
  item,
  apMatchException,
  apMatchTolerance,
  businessPartner,
  expenseCategory,
  goodsReceipt,
  goodsReceiptLine,
  goodsReturn,
  inventoryMovement,
  journalEntry,
  landedCostCharge,
  payable,
  paymentProposalItem,
  supplierCreditMemo,
  warehouse,
  purchaseOrder,
  purchaseOrderLine,
  serviceReceipt,
  serviceReceiptLine,
} from '../db/schema';
import { formatQuantity, parseQuantity } from '../domain/uom';
import { parseDecimal, say, toDecimalString } from '../domain/money';
import {
  NO_TOLERANCE,
  describeVariance,
  matchDocument,
  matchLine,
  type MatchResult,
  type MatchStatus,
  type MatchTolerance,
} from '../domain/three-way-match';
import type { PostingLineRequest } from '../domain/posting';
import type { ActorContext } from './chart-of-accounts';
import * as authz from './authorization';
import * as audit from './audit';
import { advanceOf } from '../domain/payment-applications';
import * as payableEvents from './payable-events';
import * as applications from './payment-applications';
import * as payables from './payables';
import * as posting from './posting';
import * as inventory from './inventory';
import * as journal from './journal';
import * as shipments from './supplier-shipment';
import * as statuses from './statuses';
import * as terms from './payment-terms';
import * as coa from './chart-of-accounts';
import { assertResultAccount, assertStatementAccount } from '../domain/posting-map';
import { allocateDocumentNumber } from './numbering';
import * as execution from './project-execution';
import * as advances from './supplier-advance';
import * as units from './item-units';

export const DOCUMENT_TYPE = 'ap_invoice';
export const PERMISSION_OBJECT = 'ap_invoice';
const SEQUENCE_KEY = 'AP_INVOICE';

export class ApInvoiceNotFoundError extends Error {
  readonly code = 'AP_INVOICE_NOT_FOUND';
  constructor(id: string) {
    super(`No A/P invoice '${id}'.`);
    this.name = 'ApInvoiceNotFoundError';
  }
}

/** One line of an invoice cannot do what it is being asked to do. */
export class ApInvoiceLineError extends Error {
  readonly code = 'AP_INVOICE_LINE';

  constructor(
    readonly lineNo: number,
    detail: string,
  ) {
    super(`Line ${lineNo} ${detail}`);
    this.name = 'ApInvoiceLineError';
  }
}

export class ApInvoiceStateError extends Error {
  readonly code = 'AP_INVOICE_STATE_INVALID';
  constructor(invoiceNo: string, status: string, detail: string) {
    super(`A/P invoice ${invoiceNo} is '${status}': ${detail}`);
    this.name = 'ApInvoiceStateError';
  }
}

/** §15 — one supplier invoice number per supplier, exceptions approved. */
export class DuplicateSupplierInvoiceError extends Error {
  readonly code = 'DUPLICATE_SUPPLIER_INVOICE';
  constructor(
    readonly supplierInvoiceNo: string,
    readonly existingInvoiceNo: string,
  ) {
    super(
      `Supplier invoice ${supplierInvoiceNo} has already been entered as ${existingInvoiceNo} (§15). ` +
        'Check whether this is the same charge; if it genuinely is a second invoice with the same number, ' +
        'a manager records a duplicate exception with the reason.',
    );
    this.name = 'DuplicateSupplierInvoiceError';
  }
}

/** §8.4 — nothing received, nothing to invoice. */
export class NothingReceivedError extends Error {
  readonly code = 'NOTHING_RECEIVED';
  constructor(
    readonly orderNo: string,
    readonly lineNo: number,
    isInventory: boolean,
  ) {
    super(
      `Line ${lineNo} of ${orderNo} has nothing received against it, so it cannot be invoiced (§8.4). ` +
        (isInventory
          ? 'The warehouse records a Goods Receipt first.'
          : 'The benefiting department confirms the service first (§8.6).'),
    );
    this.name = 'NothingReceivedError';
  }
}

export class VarianceNotApprovedError extends Error {
  readonly code = 'VARIANCE_NOT_APPROVED';
  constructor(
    readonly invoiceNo: string,
    readonly exceptions: number,
  ) {
    super(
      `Invoice ${invoiceNo} has ${exceptions} unresolved match exception(s) (§8.4). ` +
        'A manager accepts each variance with a reason, or the invoice is corrected — variances are allowed only after approval.',
    );
    this.name = 'VarianceNotApprovedError';
  }
}

/** §15 — an invoice with no purchase order takes the stronger route. */
export class NonPoEvidenceRequiredError extends Error {
  readonly code = 'NON_PO_EVIDENCE_REQUIRED';
  constructor() {
    super(
      'An invoice with no purchase order needs a written justification and a second approver (§15). ' +
        'Say what was bought and why it was not ordered, and have a manager approve it — ' +
        'the three-way match cannot protect a charge that no order and no receipt describe.',
    );
    this.name = 'NonPoEvidenceRequiredError';
  }
}

export interface InvoiceLineInput {
  /** Null only on the §15 non-PO route. */
  readonly purchaseOrderLineId?: string | null;
  readonly description?: string | null;
  readonly quantity: bigint;
  readonly unitPriceIqd: bigint;
  /** Required on the non-PO route, where there is no ordered line to read. */
  readonly uomCode?: string | null;
  readonly itemCode?: string | null;
  readonly isInventory?: boolean;
  readonly costCentreCode?: string | null;
  /**
   * Where this line receives stock — Operations block 4.
   *
   * Naming one makes this the direct route: the invoice brings the goods in
   * itself and debits the item's own inventory account. Leaving it null keeps
   * the route that existed before, where a Goods Receipt already did that and
   * the invoice clears GRNI.
   */
  readonly warehouseCode?: string | null;
  /** Money off this line. The total is quantity x unit price less this. */
  readonly discountIqd?: bigint;
  /**
   * §9.2 — this line's cost belongs to an import file, not to us. It posts to
   * the landed-cost clearing account and becomes a landed-cost charge of that
   * file in the same transaction (A10).
   */
  readonly chargedToPayableId?: string | null;
  /**
   * An import agreed in another currency: the line's price in that currency,
   * as the supplier's document states it. `unitPriceIqd` is the same price in
   * dinars at the invoice date — the invoice and its journal are in dinars;
   * the import (and so what is paid, FX7/FX8) keeps the agreed currency.
   */
  readonly unitPriceTxn?: bigint;
}

export interface CreateApInvoiceInput {
  readonly supplierId: string;
  readonly supplierInvoiceNo: string;
  /** Null takes the §15 non-PO route, which costs a justification. */
  readonly purchaseOrderId?: string | null;
  readonly branchCode: string;
  readonly invoiceDate: string;
  /** Left out, the supplier's payment terms decide it (§16). */
  readonly dueDate?: string | undefined;
  readonly currency?: string;
  readonly note?: string | null;
  readonly lines: readonly InvoiceLineInput[];
  /** §15 — required when there is no purchase order. */
  readonly nonPoJustification?: string | null;
  readonly nonPoApprovedBy?: string | null;
  /** §15 — a manager's decision that this repeated number is not a duplicate. */
  readonly duplicateApprovedBy?: string | null;
  readonly duplicateApprovalReason?: string | null;
  /** Chosen on the form that raises it — see `setChosenAccounts`. */
  readonly payableAccountId?: string | null;
  readonly expenseAccountId?: string | null;
  /** §5.1 — raised against a payable, the link is made at birth. */
  readonly payableId?: string | null;
  /**
   * REQ-AP-001 §8, D13 — the accountant ticked *Import*: the import
   * application is created behind this invoice in the same transaction
   * (or, with `payableId`, this invoice joins an existing one).
   */
  readonly isImport?: boolean;
  /** D13 — the supplier's terms as written on the PDF, kept verbatim on the application. */
  readonly paymentTermsText?: string | null;
  /**
   * §15.3 — what the supplier is paid in front, as a percentage of this
   * invoice, by direction 2026-10-03.
   *
   * A record of the agreement. The account it is paid from and the method are
   * a later decision (0271), and `post` raises the payment application only
   * once both are there.
   */
  readonly advancePercent?: string | null;
  /**
   * The currency the import is agreed in, when it is not the invoice's
   * dinars (a supplier's document in dollars). The lines carry their price in
   * it as `unitPriceTxn`. Left out, the import is in the invoice's currency.
   */
  readonly importCurrency?: string | null;
  /**
   * D12 — an expense is a purchase invoice. The type of fee; its default
   * expense account is used when the form names none, and it stands as the
   * §15 evidence (see the non-PO rule below).
   */
  readonly expenseCategoryCode?: string | null;
  /** §10, D12 — the contract and period this invoice was generated for. */
  readonly recurringContractId?: string | null;
  readonly periodStart?: string | null;
  readonly periodEnd?: string | null;
  /** REQ-PM-001 §8 — the project, the element and the cost code; the three together, or none. Inherited from the order when it carries one. */
  readonly projectCode?: string | null;
  readonly wbsCode?: string | null;
  readonly costCode?: string | null;
}

/**
 * The invoice and its lines.
 *
 * `lock` takes the header row `for update` for the rest of the transaction.
 * The posting path asks for it: two posts of one invoice arriving together
 * would each read `submitted`, each receive the goods, and the second's
 * journal would come back as the first's (the engine is idempotent by source)
 * — so the stock would be in the warehouse twice and the ledger once. Held
 * on the row, the second waits, reads `posted`, and is refused.
 */
async function load(tx: Tx, id: string, options: { lock?: boolean } = {}) {
  const header = tx.select().from(apInvoice).where(eq(apInvoice.id, id)).limit(1);
  const [invoice] = await (options.lock ? header.for('update') : header);
  if (!invoice) throw new ApInvoiceNotFoundError(id);

  const lines = await tx
    .select()
    .from(apInvoiceLine)
    .where(eq(apInvoiceLine.apInvoiceId, id))
    .orderBy(apInvoiceLine.lineNo);

  return { invoice, lines };
}

/** §8.4 — the tolerance for this supplier, or the company default. */
export async function toleranceFor(tx: Tx, supplierId: string): Promise<MatchTolerance> {
  const [specific] = await tx
    .select()
    .from(apMatchTolerance)
    .where(eq(apMatchTolerance.supplierId, supplierId))
    .limit(1);

  const row =
    specific ??
    (
      await tx
        .select()
        .from(apMatchTolerance)
        .where(isNull(apMatchTolerance.supplierId))
        .limit(1)
    )[0];

  // No configuration at all means no tolerance, not unlimited: §8.4 asks for a
  // control, and a missing row should not silently remove one.
  if (!row) return NO_TOLERANCE;

  return {
    quantityPercent: row.quantityPercent,
    pricePercent: row.pricePercent,
    valuePercent: row.valuePercent,
  };
}

/**
 * How much of an ordered line the receipt evidence supports.
 *
 * Goods: posted receipts. Services: approved confirmations. Drafts of either
 * count for nothing — evidence is what somebody stood behind.
 */
export async function receivedQuantityFor(
  tx: Tx,
  purchaseOrderLineId: string,
  isInventory: boolean,
): Promise<bigint> {
  if (isInventory) {
    const rows = await tx
      .select({ quantity: goodsReceiptLine.quantity })
      .from(goodsReceiptLine)
      .innerJoin(goodsReceipt, eq(goodsReceipt.id, goodsReceiptLine.goodsReceiptId))
      .where(
        and(
          eq(goodsReceiptLine.purchaseOrderLineId, purchaseOrderLineId),
          eq(goodsReceipt.status, 'executed'),
        ),
      );
    return rows.reduce((total, row) => total + parseQuantity(row.quantity), 0n);
  }

  const rows = await tx
    .select({ quantity: serviceReceiptLine.quantity })
    .from(serviceReceiptLine)
    .innerJoin(serviceReceipt, eq(serviceReceipt.id, serviceReceiptLine.serviceReceiptId))
    .where(
      and(
        eq(serviceReceiptLine.purchaseOrderLineId, purchaseOrderLineId),
        eq(serviceReceipt.status, 'approved'),
      ),
    );
  return rows.reduce((total, row) => total + parseQuantity(row.quantity), 0n);
}

/** D12 — the type of fee, active, with the account it posts to by default. */
async function expenseCategoryOf(tx: Tx, code: string) {
  const [row] = await tx
    .select({
      code: expenseCategory.code,
      name: expenseCategory.name,
      active: expenseCategory.active,
      defaultExpenseAccountId: expenseCategory.defaultExpenseAccountId,
    })
    .from(expenseCategory)
    .where(eq(expenseCategory.code, code))
    .limit(1);
  if (!row) throw new Error(`No type of fee '${code}'. Choose one from Payables Settings → Expense categories.`);
  if (!row.active) throw new Error(`The type of fee '${row.name}' is deactivated.`);
  return row;
}

export async function create(
  tx: Tx,
  ctx: ActorContext,
  input: CreateApInvoiceInput,
): Promise<{ id: string; invoiceNo: string; matchStatus: MatchStatus; importPayableNo: string | null }> {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: input.branchCode,
  });

  if (input.lines.length === 0) {
    throw new Error('An invoice with no lines charges nothing. Add what is being charged for.');
  }

  /*
   * REQ-AP-001 §17.4 — an import's goods are at sea when its invoice posts:
   * owned, not available. Its stock lines land in the branch's In Process
   * (transit) warehouse; the warehouse the accountant chose is where the
   * containers will be received (§18), and it becomes the order's warehouse.
   */
  let destinationWarehouse: string | null = null;
  if (input.isImport) {
    const [transit] = await tx
      .select({ code: warehouse.code })
      .from(warehouse)
      .where(
        and(
          eq(warehouse.shipmentStage, 'in_process'),
          eq(warehouse.branchCode, input.branchCode),
          eq(warehouse.active, true),
        ),
      )
      .limit(1);
    // A stock line lands in transit whether or not the form named a
    // warehouse: the import raised from the supplier's document names none on
    // purpose (the containers choose it), and its goods are at sea all the same.
    const stockCodes = [...new Set(input.lines.filter((line) => line.itemCode && !line.chargedToPayableId).map((line) => line.itemCode!))];
    const stocked = new Set(
      (stockCodes.length > 0
        ? await tx.select({ code: item.code }).from(item).where(and(inArray(item.code, stockCodes), eq(item.isStock, true)))
        : []
      ).map((row) => row.code),
    );
    const isStockLine = (line: InvoiceLineInput) =>
      Boolean(line.warehouseCode) || (Boolean(line.itemCode) && stocked.has(line.itemCode!) && !line.chargedToPayableId);
    if (transit) {
      destinationWarehouse =
        input.lines.find((line) => line.warehouseCode && line.warehouseCode !== transit.code)?.warehouseCode ??
        null;
      input = {
        ...input,
        lines: input.lines.map((line) => (isStockLine(line) ? { ...line, warehouseCode: transit.code } : line)),
      };
    } else if (input.lines.some((line) => !line.warehouseCode && isStockLine(line))) {
      throw new Error(
        `${input.branchCode} has no In Process warehouse, so an import's goods have nowhere to be while at sea. ` +
          'Create the branch’s transit warehouses (Warehouses) first.',
      );
    }
  }

  /*
   * §15 — the non-PO route costs a justification and a second approver.
   *
   * Unless the invoice receives its own stock. The rule exists because "the
   * three-way match cannot protect a charge that no order and no receipt
   * describe" — and Operations block 4's invoice describes the receipt: every
   * line names the warehouse its goods arrive in, and posting puts them there.
   * The evidence §15 asks for is the document being approved.
   *
   * What is left unguarded is the charge, and block 4 holds that behind "the
   * invoice is not posted until CEO approval" — a separate verb the person who
   * raised it does not hold. So the control is not removed, it is the one the
   * sponsor specified.
   *
   * Narrow on purpose: one service line among the stock lines and the evidence
   * is owed again, because that line has no receipt of any kind behind it.
   */
  const receivesItsOwnStock = input.lines.every((line) => Boolean(line.warehouseCode));

  /*
   * D12 (2026-10-01) — an expense is a purchase invoice with no order behind
   * it: the rent, the forwarder, the broker, the utility bill. Its §15
   * evidence is what it says it is (the expense category and the attached
   * bill, stated in the justification), and its second person is the one who
   * posts it — posting needs `approve` + `post`, which the person raising it
   * does not hold. The same reasoning block 4 applied to the invoice that is
   * its own receipt (migration 0196); the CHECK in 0232 holds it.
   */
  const category = input.expenseCategoryCode
    ? await expenseCategoryOf(tx, input.expenseCategoryCode)
    : null;
  const isExpense = category !== null && !input.purchaseOrderId && !receivesItsOwnStock;
  const expenseJustification = isExpense
    ? (input.nonPoJustification?.trim() || `Expense — ${category!.name}`)
    : null;

  if (!input.purchaseOrderId && !receivesItsOwnStock && !isExpense) {
    if (
      !input.nonPoJustification ||
      input.nonPoJustification.trim().length === 0 ||
      !input.nonPoApprovedBy
    ) {
      throw new NonPoEvidenceRequiredError();
    }
    if (input.nonPoApprovedBy === ctx.principal.userId) {
      throw new NonPoEvidenceRequiredError();
    }
  }

  const supplierNumber = input.supplierInvoiceNo.trim();

  /*
   * §15 — the duplicate control.
   *
   * Two cases, and only two. Somebody claiming the exception owes the reason:
   * the CHECK refuses the row without one, and §15 asks for the words rather
   * than only the approver's name. Everybody else is checked against what the
   * supplier has already billed — here, for a message that names the earlier
   * invoice, and by the partial unique index on every other path.
   *
   * A blank number is neither. Block 4's header does not collect the
   * supplier's own number, so the invoice takes ours below: unique by
   * construction, nothing to look up, and no exception to justify. Asking one
   * of those invoices for a duplicate reason refused every invoice the screen
   * could raise.
   */
  if (input.duplicateApprovedBy) {
    if (!input.duplicateApprovalReason || input.duplicateApprovalReason.trim().length === 0) {
      throw new Error(
        'A duplicate supplier invoice number is accepted only with a reason (§15). ' +
          'Say why the same number is genuinely a second charge.',
      );
    }
  } else if (supplierNumber !== '') {
    const [existing] = await tx
      .select({ invoiceNo: apInvoice.invoiceNo })
      .from(apInvoice)
      .where(
        and(
          eq(apInvoice.supplierId, input.supplierId),
          eq(apInvoice.supplierInvoiceNo, supplierNumber),
        ),
      )
      .limit(1);

    if (existing) {
      throw new DuplicateSupplierInvoiceError(supplierNumber, existing.invoiceNo);
    }
  }

  let order: typeof purchaseOrder.$inferSelect | undefined;
  if (input.purchaseOrderId) {
    [order] = await tx
      .select()
      .from(purchaseOrder)
      .where(eq(purchaseOrder.id, input.purchaseOrderId))
      .limit(1);
    if (!order) throw new Error(`No purchase order with id '${input.purchaseOrderId}'.`);
  }
  // REQ-PM-001 §8 — the invoice stands where its order stands; typed when
  // there is no order, or none on it.
  const assignment = await execution.checkAssignment(tx, {
    projectCode: input.projectCode ?? order?.projectCode ?? null,
    wbsCode: input.wbsCode ?? order?.wbsCode ?? null,
    costCode: input.costCode ?? order?.costCode ?? null,
  });

  /*
   * §16 — the due date the supplier's terms give, when the document does not
   * carry one of its own.
   *
   * A typed date still wins: an invoice can say when it falls due, and terms
   * are the default rather than the law. What they are not is optional work
   * for the person raising it — "net 30" is a fact about the supplier, already
   * on the partner record, and asking somebody to count thirty days by hand is
   * asking them to get it wrong.
   */
  const [supplier] = await tx
    .select({ paymentTermsCode: businessPartner.paymentTermsCode })
    .from(businessPartner)
    .where(eq(businessPartner.id, input.supplierId))
    .limit(1);

  const dueDate = input.dueDate?.trim()
    ? input.dueDate.trim()
    : await terms.dueDateOn(tx, supplier?.paymentTermsCode ?? null, input.invoiceDate);

  /*
   * The accounts the form chose, checked before anything is written — the
   * same two rules `setChosenAccounts` applies to a draft.
   */
  const payableAccountId = input.payableAccountId?.trim() || null;
  const expenseAccountId =
    input.expenseAccountId?.trim() || category?.defaultExpenseAccountId || null;
  if (payableAccountId) {
    assertStatementAccount('supplier', await coa.loadAccount(tx, payableAccountId));
  }
  if (expenseAccountId) {
    assertResultAccount('expense', await coa.loadAccount(tx, expenseAccountId));
  }

  // §9.2 — a charged line must name a real, open import, and a charged line
  // is a cost: stock is never somebody else's landed cost.
  for (const line of input.lines) {
    if (!line.chargedToPayableId) continue;
    if (line.isInventory) {
      throw new Error('A stock line cannot be charged to an import — only a cost can (§9.2).');
    }
    const [target] = await tx
      .select({
        payableNo: payable.payableNo,
        typeCode: payable.payableTypeCode,
        cancelledAt: payable.cancelledAt,
        closedAt: payable.closedAt,
      })
      .from(payable)
      .where(eq(payable.id, line.chargedToPayableId))
      .limit(1);
    if (!target) throw new Error('No such import to charge this line to.');
    if (target.typeCode !== 'import') {
      throw new Error(
        `${target.payableNo} is not an import — landed cost belongs to the goods it moved (§9.2).`,
      );
    }
    if (target.cancelledAt || target.closedAt) {
      throw new Error(`${target.payableNo} is closed — its cost is locked and takes no further charges.`);
    }
  }

  const allocated = await allocateDocumentNumber(
    tx,
    SEQUENCE_KEY,
    { branchCode: input.branchCode, year: Number(input.invoiceDate.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(apInvoice)
    .values({
      invoiceNo: allocated.documentNo,
      // Ours, when the supplier's own was not asked for. The column is not
      // nullable and §15's index is on (supplier, number): a blank on every
      // invoice would collide the second time the same supplier billed us.
      supplierInvoiceNo: supplierNumber || allocated.documentNo,
      supplierId: input.supplierId,
      purchaseOrderId: input.purchaseOrderId ?? null,
      branchCode: input.branchCode,
      invoiceDate: input.invoiceDate,
      dueDate,
      currency: input.currency ?? 'IQD',
      advancePercent: input.advancePercent ?? null,
      note: input.note ?? null,
      // The route this invoice took, recorded on the header so the §15 CHECK
      // can read one field rather than trust the application to have looked at
      // the lines.
      payableAccountId,
      expenseAccountId,
      receivesOwnStock: receivesItsOwnStock,
      nonPoJustification: expenseJustification ?? input.nonPoJustification?.trim() ?? null,
      nonPoApprovedBy: input.nonPoApprovedBy ?? null,
      nonPoApprovedAt: input.nonPoApprovedBy ? new Date() : null,
      expenseCategoryCode: category?.code ?? null,
      recurringContractId: input.recurringContractId ?? null,
      periodStart: input.periodStart ?? null,
      periodEnd: input.periodEnd ?? null,
      projectCode: assignment?.projectCode ?? null,
      wbsCode: assignment?.wbsCode ?? null,
      costCode: assignment?.costCode ?? null,
      duplicateApprovedBy: input.duplicateApprovedBy ?? null,
      duplicateApprovedAt: input.duplicateApprovedBy ? new Date() : null,
      duplicateApprovalReason: input.duplicateApprovalReason?.trim() ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: apInvoice.id });

  for (const [index, line] of input.lines.entries()) {
    let ordered: typeof purchaseOrderLine.$inferSelect | undefined;

    if (line.purchaseOrderLineId) {
      [ordered] = await tx
        .select()
        .from(purchaseOrderLine)
        .where(eq(purchaseOrderLine.id, line.purchaseOrderLineId))
        .limit(1);

      if (!ordered || ordered.purchaseOrderId !== input.purchaseOrderId) {
        throw new Error(
          `That line does not belong to purchase order ${order?.orderNo ?? '(none)'}. An invoice covers one order.`,
        );
      }
    }

    const isInventory = ordered
      ? ordered.lineType === 'inventory_item'
      : (line.isInventory ?? false);

    const received = ordered
      ? await receivedQuantityFor(tx, ordered.id, isInventory)
      : 0n;

    if (ordered && received <= 0n) {
      throw new NothingReceivedError(order!.orderNo, ordered.lineNo, isInventory);
    }

    // A stock line is described by its item's name, as a draft line saved on
    // the document already is (`saveLine`). The New form sends no description,
    // and "Charge" then stood in for the Item Name on the return screen.
    const lineItemCode = line.itemCode ?? ordered?.itemCode ?? null;
    const [named] = lineItemCode
      ? await tx.select({ name: item.name }).from(item).where(eq(item.code, lineItemCode)).limit(1)
      : [];

    await tx.insert(apInvoiceLine).values({
      apInvoiceId: created!.id,
      lineNo: index + 1,
      purchaseOrderLineId: ordered?.id ?? null,
      itemCode: lineItemCode,
      description: line.description ?? ordered?.description ?? named?.name ?? 'Charge',
      quantity: formatQuantity(line.quantity),
      uomCode: await lineUnit(tx, lineItemCode, line.uomCode, ordered?.uomCode ?? null, index + 1),
      unitPrice: toDecimalString(line.unitPriceIqd, 4n),
      isInventory,
      costCentreCode: line.costCentreCode ?? ordered?.costCentreCode ?? null,
      warehouseCode: line.warehouseCode ?? null,
      discountIqd: toDecimalString(line.discountIqd ?? 0n, 4n),
      receivedQuantity: formatQuantity(received),
      chargedToPayableId: line.chargedToPayableId ?? null,
    });
  }

  const match = await rematch(tx, created!.id);

  // §5.1 — raised against a payable, linked at birth: the draft already shows
  // on the file it will pay, and the link validates there (same supplier, one
  // invoice one payable, the file still open).
  if (input.payableId) {
    await payables.linkInvoice(tx, ctx, { payableId: input.payableId, apInvoiceId: created!.id });
  }

  /*
   * D13 — the import is born here. The CEO agreed the deal, the supplier's
   * PDF reached the accountant, she entered it as this invoice and ticked
   * Import: the application is created behind it in the same transaction,
   * keyed by the supplier's number (ours when the form did not ask for it),
   * with this invoice's lines as its lines. Nobody fills a second form.
   */
  let importPayableNo: string | null = null;
  if (input.isImport) {
    let payableId = input.payableId ?? null;
    if (!payableId) {
      // Its lines read as the invoice's do: an item by its name (`saveLine`).
      const codes = [...new Set(input.lines.map((line) => line.itemCode).filter((code): code is string => Boolean(code)))];
      const names = new Map(
        (codes.length > 0
          ? await tx.select({ code: item.code, name: item.name }).from(item).where(inArray(item.code, codes))
          : []
        ).map((row) => [row.code, row.name] as const),
      );
      const opened = await payables.create(tx, ctx, {
        payableTypeCode: 'import',
        supplierReference: supplierNumber || allocated.documentNo,
        supplierId: input.supplierId,
        branchCode: input.branchCode,
        currency: input.importCurrency || input.currency || 'IQD',
        documentDate: input.invoiceDate,
        description: `Purchase invoice ${allocated.documentNo}`,
        paymentTermsText: input.paymentTermsText ?? null,
        dueDate,
        purchaseOrderId: input.purchaseOrderId ?? null,
        projectCode: assignment?.projectCode ?? null,
        wbsCode: assignment?.wbsCode ?? null,
        costCode: assignment?.costCode ?? null,
        lines: input.lines.map((line) => ({
          itemCode: line.itemCode ?? null,
          description: line.description ?? (line.itemCode ? names.get(line.itemCode) : undefined) ?? line.itemCode ?? 'Charge',
          quantity: formatQuantity(line.quantity),
          uomCode: line.uomCode ?? null,
          unitPrice: toDecimalString(line.unitPriceTxn ?? line.unitPriceIqd, 4n),
        })),
        defaultWarehouseCode:
          destinationWarehouse ?? input.lines.find((line) => line.warehouseCode)?.warehouseCode ?? null,
      });
      payableId = opened.id;
      importPayableNo = opened.payableNo;
      await payables.linkInvoice(tx, ctx, { payableId, apInvoiceId: created!.id });
    }
    await tx.update(apInvoice).set({ isImport: true }).where(eq(apInvoice.id, created!.id));
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'ap_invoice.created',
    objectType: PERMISSION_OBJECT,
    objectId: created!.id,
    branchCode: input.branchCode,
    after: {
      invoiceNo: allocated.documentNo,
      supplierInvoiceNo: input.supplierInvoiceNo,
      orderNo: order?.orderNo ?? null,
      lines: input.lines.length,
      matchStatus: match.status,
      isImport: Boolean(input.isImport),
      importApplication: importPayableNo,
      expenseCategory: category?.code ?? null,
    },
    outcome: 'success',
  });

  return {
    id: created!.id,
    invoiceNo: allocated.documentNo,
    matchStatus: match.status,
    importPayableNo,
  };
}

/**
 * The lines of a draft invoice, typed in place — by direction, 2026-09-16.
 *
 * The Journal Entry's grid, on the document that bills for the goods: a line is
 * saved the moment it is complete and left, and a new one opens under it.
 * `edit_draft` has been granted to both accounting roles since migration 0036
 * and no screen had ever used it, so a mistyped invoice had to be abandoned and
 * raised again under a new number.
 *
 * **Only an invoice raised on its own.** An invoice created from a purchase
 * order takes its lines from that order — §8.4's match compares the three
 * documents, and a line typed over an ordered one would be comparing the
 * invoice with itself. Those are corrected on the order.
 */
export interface DraftLineInput {
  readonly itemCode: string;
  readonly quantity: bigint;
  readonly unitPriceIqd: bigint;
  readonly discountIqd?: bigint;
  readonly warehouseCode: string;
  /** REQ-FIX-001 FIX-4 — one of the item's units; its purchase default when absent. */
  readonly uomCode?: string | null;
}

/** The draft, and the reasons it may be typed into. */
async function editableDraft(tx: Tx, ctx: ActorContext, id: string) {
  const { invoice, lines } = await load(tx, id);

  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, {
    branchCode: invoice.branchCode,
    objectId: id,
  });

  if (invoice.status !== 'draft') {
    throw new ApInvoiceStateError(
      invoice.invoiceNo,
      invoice.status,
      'only a draft invoice may have its lines changed. A submitted invoice is rejected back to draft first, and a posted one is reversed.',
    );
  }

  if (invoice.purchaseOrderId) {
    throw new ApInvoiceStateError(
      invoice.invoiceNo,
      invoice.status,
      "it was raised from a purchase order, so its lines are the order's (§8.4). Correct the order, or raise an invoice on its own.",
    );
  }

  return { invoice, lines };
}

/**
 * §15's evidence, kept in step with the lines.
 *
 * `receives_own_stock` is what the CHECK reads, and it is true when every line
 * names the warehouse its goods arrive in. Re-stated after each change, because
 * a column set once at creation would be a claim about lines that have since
 * been edited.
 */
async function restateOwnStock(tx: Tx, id: string, fallback: boolean): Promise<void> {
  const rows = await tx
    .select({ warehouseCode: apInvoiceLine.warehouseCode })
    .from(apInvoiceLine)
    .where(eq(apInvoiceLine.apInvoiceId, id));

  await tx
    .update(apInvoice)
    .set({
      receivesOwnStock:
        rows.length === 0 ? fallback : rows.every((row) => row.warehouseCode !== null),
      updatedAt: new Date(),
    })
    .where(eq(apInvoice.id, id));
}

export interface ApInvoiceChosenAccounts {
  /** The account this supplier's balance is kept on. Null returns it to the mapping. */
  readonly payableAccountId?: string | null;
  /** Where a service line's cost belongs. Null returns it to the mapping. */
  readonly expenseAccountId?: string | null;
}

/**
 * The accounts this invoice posts to, chosen on the document itself.
 *
 * The purchase side of the sponsor's ask (2026-09-22). The payable is the
 * account the supplier's statement is kept on, so it must be a supplier
 * control account or the statement loses the invoice; the expense account
 * covers a service line only, because a stock line debits the item's own
 * inventory account and the warehouse and the ledger must agree.
 */
export async function setChosenAccounts(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  input: ApInvoiceChosenAccounts,
): Promise<void> {
  const { invoice } = await editableDraft(tx, ctx, id);

  const payableAccountId = input.payableAccountId?.trim() || null;
  const expenseAccountId = input.expenseAccountId?.trim() || null;

  if (payableAccountId) {
    assertStatementAccount('supplier', await coa.loadAccount(tx, payableAccountId));
  }
  if (expenseAccountId) {
    assertResultAccount('expense', await coa.loadAccount(tx, expenseAccountId));
  }

  if (
    invoice.payableAccountId === payableAccountId &&
    invoice.expenseAccountId === expenseAccountId
  ) {
    return;
  }

  await tx
    .update(apInvoice)
    .set({ payableAccountId, expenseAccountId, updatedAt: new Date() })
    .where(eq(apInvoice.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'ap_invoice.accounts_chosen',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: invoice.branchCode,
    before: {
      payableAccountId: invoice.payableAccountId,
      expenseAccountId: invoice.expenseAccountId,
    },
    after: { payableAccountId, expenseAccountId },
    outcome: 'success',
  });
}

export async function saveLine(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  lineId: string | null,
  input: DraftLineInput,
): Promise<{ lineNo: number }> {
  const { invoice, lines } = await editableDraft(tx, ctx, id);

  const existing = lineId ? lines.find((line) => line.id === lineId) : undefined;
  if (lineId && !existing) {
    throw new Error(`That line is not on invoice ${invoice.invoiceNo}.`);
  }
  const lineNo = existing?.lineNo ?? lines.reduce((max, line) => Math.max(max, line.lineNo), 0) + 1;

  const [stockItem] = await tx
    .select({
      code: item.code,
      name: item.name,
      uomCode: item.baseUomCode,
      isStock: item.isStock,
      active: item.active,
    })
    .from(item)
    .where(eq(item.code, input.itemCode))
    .limit(1);
  if (!stockItem) throw new ApInvoiceLineError(lineNo, `names no item '${input.itemCode}'.`);
  if (!stockItem.active) {
    throw new ApInvoiceLineError(lineNo, `names ${stockItem.code}, which is no longer active.`);
  }

  const [house] = await tx
    .select({ code: warehouse.code })
    .from(warehouse)
    .where(eq(warehouse.code, input.warehouseCode))
    .limit(1);
  if (!house) {
    throw new ApInvoiceLineError(lineNo, `names no warehouse '${input.warehouseCode}'.`);
  }

  if (input.quantity <= 0n) {
    throw new ApInvoiceLineError(lineNo, 'has no quantity. An invoice bills for something.');
  }
  if (input.unitPriceIqd < 0n) {
    throw new ApInvoiceLineError(lineNo, 'has a negative price. A refund is a credit note.');
  }

  // Quantity carries six decimal places and the price four, so their product
  // carries ten; the divisor brings it back to the four money is stored at.
  const gross = (input.quantity * input.unitPriceIqd) / 1_000_000n;
  const discount = input.discountIqd ?? 0n;
  if (discount < 0n || discount > gross) {
    throw new ApInvoiceLineError(
      lineNo,
      'has a discount larger than the line, which would make it a credit note.',
    );
  }

  const values = {
    itemCode: stockItem.code,
    // The name is read from the master rather than taken from the caller, so an
    // invoice cannot name an item one thing and the chart another.
    description: stockItem.name,
    quantity: formatQuantity(input.quantity),
    uomCode: await lineUnit(tx, stockItem.code, input.uomCode ?? existing?.uomCode ?? null, null, lineNo),
    unitPrice: toDecimalString(input.unitPriceIqd, 4n),
    isInventory: true,
    warehouseCode: house.code,
    discountIqd: toDecimalString(discount, 4n),
  };

  if (existing) {
    await tx.update(apInvoiceLine).set(values).where(eq(apInvoiceLine.id, existing.id));
  } else {
    await tx.insert(apInvoiceLine).values({
      apInvoiceId: id,
      lineNo,
      purchaseOrderLineId: null,
      receivedQuantity: '0',
      ...values,
    });
  }

  await restateOwnStock(tx, id, invoice.receivesOwnStock);
  // The match is recomputed on every change rather than on demand — 05.4's gate
  // asks for a status that is the answer to "as of now".
  await rematch(tx, id);

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: existing ? 'ap_invoice.line_changed' : 'ap_invoice.line_added',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: invoice.branchCode,
    ...(existing
      ? {
          before: {
            lineNo: existing.lineNo,
            itemCode: existing.itemCode,
            quantity: existing.quantity,
            unitPrice: existing.unitPrice,
            discountIqd: existing.discountIqd,
            warehouseCode: existing.warehouseCode,
          },
        }
      : {}),
    after: { lineNo, ...values },
    outcome: 'success',
  });

  return { lineNo };
}

/** Taking one line off a draft. The rest renumber, so the grid stays 1..n. */
export async function removeLine(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  lineId: string,
): Promise<void> {
  const { invoice, lines } = await editableDraft(tx, ctx, id);

  const line = lines.find((row) => row.id === lineId);
  if (!line) throw new Error(`That line is not on invoice ${invoice.invoiceNo}.`);
  if (lines.length === 1) {
    throw new Error(
      `${invoice.invoiceNo} would be left billing for nothing. Change this line, or delete the invoice.`,
    );
  }

  await tx.delete(apInvoiceLine).where(eq(apInvoiceLine.id, lineId));

  // Out of the way and back: the numbers are unique per invoice, so closing the
  // gap in place would collide with the row above it.
  await tx.execute(
    sql`update ap_invoice_line set line_no = line_no + 1000
         where ap_invoice_id = ${id} and line_no > ${line.lineNo}`,
  );
  await tx.execute(
    sql`update ap_invoice_line set line_no = line_no - 1001
         where ap_invoice_id = ${id} and line_no > 1000`,
  );

  await restateOwnStock(tx, id, invoice.receivesOwnStock);
  await rematch(tx, id);

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'ap_invoice.line_removed',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: invoice.branchCode,
    before: {
      lineNo: line.lineNo,
      itemCode: line.itemCode,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      discountIqd: line.discountIqd,
      warehouseCode: line.warehouseCode,
    },
    outcome: 'success',
  });
}

/**
 * Runs the three-way match and records what it found.
 *
 * Open exceptions are replaced rather than added to, so re-matching a corrected
 * invoice clears what it fixed. Resolved ones are kept: they are the record of
 * a decision somebody made (§5.4), and a supplier whose invoices raise the same
 * exception every month is worth being able to see.
 */
export async function rematch(
  tx: Tx,
  id: string,
): Promise<{ status: MatchStatus; varianceValueIqd: bigint; exceptions: number }> {
  const { invoice, lines } = await load(tx, id);
  const tolerance = await toleranceFor(tx, invoice.supplierId);

  // §15's non-PO invoice has nothing to match against. It is not "matched" by
  // luck — it took the stronger route instead, and that is what stands in for
  // the match.
  if (!invoice.purchaseOrderId) {
    await tx
      .update(apInvoice)
      .set({ matchStatus: 'matched', varianceValueIqd: '0', updatedAt: new Date() })
      .where(eq(apInvoice.id, id));
    return { status: 'matched', varianceValueIqd: 0n, exceptions: 0 };
  }

  await tx
    .delete(apMatchException)
    .where(and(eq(apMatchException.apInvoiceId, id), isNull(apMatchException.resolvedAt)));

  const results: MatchResult[] = [];

  for (const line of lines) {
    if (!line.purchaseOrderLineId) continue;

    const [ordered] = await tx
      .select()
      .from(purchaseOrderLine)
      .where(eq(purchaseOrderLine.id, line.purchaseOrderLineId))
      .limit(1);
    if (!ordered) continue;

    const received = await receivedQuantityFor(tx, ordered.id, line.isInventory);

    const result = matchLine({
      ordered: {
        quantity: parseQuantity(ordered.quantity),
        unitPriceIqd: parseDecimal(ordered.unitPrice, 4n),
      },
      received: { quantity: received },
      invoiced: {
        quantity: parseQuantity(line.quantity),
        unitPriceIqd: parseDecimal(line.unitPrice, 4n),
      },
      // What earlier *posted* invoices already charged for this ordered line.
      // Three invoices of 40 against a delivery of 100 each look innocent and
      // together over-bill by 20.
      alreadyInvoiced: parseQuantity(ordered.invoicedQuantity),
      tolerance,
    });

    results.push(result);

    await tx
      .update(apInvoiceLine)
      .set({
        matchStatus: result.status,
        receivedQuantity: formatQuantity(received),
        varianceValueIqd: toDecimalString(result.varianceValueIqd, 4n),
      })
      .where(eq(apInvoiceLine.id, line.id));

    for (const variance of result.variances) {
      await tx.insert(apMatchException).values({
        apInvoiceId: id,
        apInvoiceLineId: line.id,
        kind: variance.kind,
        // Quantities and money are both stored at six places here so one column
        // can carry either; the kind says how to read it.
        expected: toDecimalString(variance.expected, variance.kind === 'quantity' ? 6n : 4n),
        actual: toDecimalString(variance.actual, variance.kind === 'quantity' ? 6n : 4n),
        difference: toDecimalString(variance.difference, variance.kind === 'quantity' ? 6n : 4n),
        reason: describeVariance(variance),
      });
    }
  }

  const document = matchDocument(results);

  await tx
    .update(apInvoice)
    .set({
      matchStatus: document.status,
      varianceValueIqd: toDecimalString(document.varianceValueIqd, 4n),
      updatedAt: new Date(),
    })
    .where(eq(apInvoice.id, id));

  return {
    status: document.status,
    varianceValueIqd: document.varianceValueIqd,
    exceptions: document.exceptionCount,
  };
}

/** §8.4 — the exception queue, with the reason. */
export async function exceptionQueue(tx: Tx, options: { includeResolved?: boolean } = {}) {
  const rows = await tx
    .select({
      id: apMatchException.id,
      invoiceNo: apInvoice.invoiceNo,
      supplierInvoiceNo: apInvoice.supplierInvoiceNo,
      kind: apMatchException.kind,
      expected: apMatchException.expected,
      actual: apMatchException.actual,
      difference: apMatchException.difference,
      reason: apMatchException.reason,
      raisedAt: apMatchException.raisedAt,
      resolution: apMatchException.resolution,
      resolutionReason: apMatchException.resolutionReason,
    })
    .from(apMatchException)
    .innerJoin(apInvoice, eq(apInvoice.id, apMatchException.apInvoiceId))
    .where(options.includeResolved ? undefined : isNull(apMatchException.resolvedAt))
    .orderBy(apMatchException.raisedAt);

  return rows;
}

/**
 * §8.4 — a manager accepts a variance, in writing.
 *
 * The reason is mandatory and stored. This is the whole of what "allowed only
 * after manager approval" means in practice: not that the system asked, but
 * that a named person said yes and said why, and it can be read back a year
 * later when the supplier disputes it.
 */
export async function approveVariance(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  reason: string,
): Promise<void> {
  const { invoice } = await load(tx, id);

  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: invoice.branchCode,
  });

  if (reason.trim().length === 0) {
    throw new Error(
      'Accepting a match variance needs a reason (§8.4, §5.4). ' +
        'Say what was agreed with the supplier, or why the difference is acceptable.',
    );
  }

  // the super user approves alone, by direction 2026-10-03 — the company has one approver and a rule nobody can satisfy approves nothing.
  if (invoice.createdBy === ctx.principal.userId && !ctx.principal.isSuperUser) {
    throw new ApInvoiceStateError(
      invoice.invoiceNo,
      invoice.status,
      'the person who entered an invoice cannot approve its variance — that is the separation the control depends on (§5.2).',
    );
  }

  const open = await tx
    .select({ id: apMatchException.id })
    .from(apMatchException)
    .where(and(eq(apMatchException.apInvoiceId, id), isNull(apMatchException.resolvedAt)));

  for (const exception of open) {
    await tx
      .update(apMatchException)
      .set({
        resolvedBy: ctx.principal.userId,
        resolvedAt: new Date(),
        resolution: 'approved',
        resolutionReason: reason.trim(),
      })
      .where(eq(apMatchException.id, exception.id));
  }

  await tx
    .update(apInvoice)
    .set({
      varianceApprovedBy: ctx.principal.userId,
      varianceApprovedAt: new Date(),
      varianceApprovalReason: reason.trim(),
      updatedAt: new Date(),
    })
    .where(eq(apInvoice.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'ap_invoice.variance_approved',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: invoice.branchCode,
    after: {
      exceptions: open.length,
      varianceValueIqd: invoice.varianceValueIqd,
    },
    reason: reason.trim(),
    outcome: 'success',
  });
}

export async function submit(tx: Tx, ctx: ActorContext, id: string): Promise<void> {
  const { invoice } = await load(tx, id);

  await authz.authorize(ctx.principal, 'submit', PERMISSION_OBJECT, {
    branchCode: invoice.branchCode,
  });

  if (invoice.status !== 'draft') {
    throw new ApInvoiceStateError(
      invoice.invoiceNo,
      invoice.status,
      'only a draft invoice can be submitted.',
    );
  }

  // Re-matched at submission: the receipts may have moved since the invoice was
  // keyed, and what is submitted for approval must be judged on what is true
  // now rather than on what was true then.
  await rematch(tx, id);

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, invoice.status, 'submitted');

  await tx
    .update(apInvoice)
    .set({ status: 'submitted', submittedBy: ctx.principal.userId, updatedAt: new Date() })
    .where(eq(apInvoice.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'ap_invoice.submitted',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: invoice.branchCode,
    before: { status: 'draft' },
    after: { status: 'submitted' },
    outcome: 'success',
  });
}

/**
 * Posts the invoice — Appendix C.
 *
 * *"A/P Invoice – inventory | GRNI and approved variances | Supplier A/P."*
 * *"A/P Invoice – service/expense | Expense / Service Cost | Supplier A/P."*
 *
 * The debit side is deliberately split by line type and variance, because those
 * are three different accounts answering three different questions: GRNI is the
 * liability the receipt raised, expense is a cost, and the variance account is
 * the difference between what was agreed and what was charged. Rolling them
 * together would make the GRNI clearance approximate, and 05.5's gate asks for
 * it to be exact.
 */
/**
 * The due date, told to an invoice after the fact — by direction 2026-10-03.
 *
 * The company buys on advance, so nothing is owed on a date when the invoice is
 * entered: the balance falls due once the bank has confirmed the transfer and
 * the supplier has said when it wants the rest. The form therefore asks for no
 * due date, and this is how the real one arrives.
 *
 * Set on the invoice *and* on its import application. The payable carries its
 * own `due_date` and the payables ageing sorts by it, so setting one and not
 * the other would leave two screens disagreeing about the same debt.
 *
 * Allowed on a posted invoice, which is the whole point — and refused on a
 * reversed one, which is owed to nobody. Recorded as an event on the import and
 * as an audit row, because a due date drives the ageing and moving one quietly
 * is how an overdue invoice stops looking overdue.
 */
export async function setDueDate(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  dueDate: string,
): Promise<void> {
  const { invoice } = await load(tx, id, { lock: true });
  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, {
    branchCode: invoice.branchCode,
    objectId: id,
  });

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    throw new ApInvoiceStateError(invoice.invoiceNo, invoice.status, 'a due date is a date (YYYY-MM-DD).');
  }
  if (invoice.status === 'reversed') {
    throw new ApInvoiceStateError(invoice.invoiceNo, invoice.status, 'nothing is owed on any date.');
  }
  if (dueDate < invoice.invoiceDate) {
    throw new ApInvoiceStateError(
      invoice.invoiceNo,
      invoice.status,
      `${dueDate} is before the invoice's own date (${invoice.invoiceDate}).`,
    );
  }
  if (dueDate === invoice.dueDate) return;

  const before = invoice.dueDate;
  await tx.update(apInvoice).set({ dueDate, updatedAt: new Date() }).where(eq(apInvoice.id, id));
  if (invoice.payableId) {
    await tx.update(payable).set({ dueDate, updatedAt: new Date() }).where(eq(payable.id, invoice.payableId));
    await payableEvents.record(tx, {
      payableId: invoice.payableId,
      eventCode: 'FIELD_CHANGED',
      sourceType: PERMISSION_OBJECT,
      sourceId: id,
      sourceNo: invoice.invoiceNo,
      summary: `Due date of ${invoice.invoiceNo}: ${before} → ${dueDate}`,
      before: { dueDate: before },
      after: { dueDate },
      actorUserId: ctx.principal.userId,
    });
  }
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'ap_invoice.due_date_set',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: invoice.branchCode,
    before: { dueDate: before },
    after: { dueDate },
    outcome: 'success',
  });
}

export async function post(
  tx: Tx,
  ctx: ActorContext,
  id: string,
): Promise<{ journalEntryId: string; varianceValueIqd: bigint }> {
  // Locked first, status read second: the goods are received once per invoice
  // however many times the post is asked for (§23).
  const { invoice, lines } = await load(tx, id, { lock: true });

  await authz.authorize(ctx.principal, 'post', PERMISSION_OBJECT, {
    branchCode: invoice.branchCode,
  });
  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: invoice.branchCode,
    objectId: id,
  });

  if (invoice.status !== 'submitted') {
    throw new ApInvoiceStateError(
      invoice.invoiceNo,
      invoice.status,
      'an invoice posts from submitted — it is entered, matched, then posted.',
    );
  }

  // A9 — a payable-linked invoice shows its confirmation before it posts;
  // the guard itself knows which categories are invoiced without one.
  if (invoice.payableId) {
    await payables.assertReceiptEvidence(tx, invoice.payableId);
  }

  const open = await tx
    .select({ id: apMatchException.id })
    .from(apMatchException)
    .where(and(eq(apMatchException.apInvoiceId, id), isNull(apMatchException.resolvedAt)));

  if (open.length > 0) {
    throw new VarianceNotApprovedError(invoice.invoiceNo, open.length);
  }

  const [supplier] = await tx
    .select({ code: businessPartner.code })
    .from(businessPartner)
    .where(eq(businessPartner.id, invoice.supplierId))
    .limit(1);

  const amount = (value: bigint) => toDecimalString(value < 0n ? -value : value, 4n);
  const criteria = { branchCode: invoice.branchCode };
  // REQ-PM-001 §8 — an assigned invoice's lines carry the project dimension.
  const base = { branch: invoice.branchCode, business_partner: supplier?.code ?? null, project: invoice.projectCode ?? null };

  // Posted line by line rather than rolled up.
  //
  // §4.2 makes dimensions a property of the account *and* the line: an expense
  // account may require a department, and the department of a service is the
  // one that confirmed it (§8.6). Aggregating the debits would force one
  // department onto lines belonging to several, and the choice of which would
  // be arbitrary. It also makes the ledger readable — an entry that says which
  // line each figure came from.
  const postingLines: PostingLineRequest[] = [];
  let grniIqd = 0n;
  let expenseIqd = 0n;
  const chargedLines: {
    lineId: string;
    lineNo: number;
    chargedToPayableId: string;
    valueIqd: bigint;
  }[] = [];
  let varianceIqd = 0n;
  let payableIqd = 0n;

  for (const line of lines) {
    const invoicedValue = lineValue(line);
    payableIqd += invoicedValue;

    // What the receipt supports, at the ordered price — the figure the goods
    // receipt already put into GRNI, or the cost the service confirmation
    // evidenced. Anything above or below it is variance.
    // On the direct route there is nothing to vary from — see below.
    const supported = line.warehouseCode ? invoicedValue : await supportedValue(tx, line);
    const variance = invoicedValue - supported;
    varianceIqd += variance;

    const dimensions = {
      ...base,
      // The department that confirmed the service. Null for goods, which are
      // received by a warehouse rather than confirmed by a department.
      department: line.isInventory ? null : await confirmingDepartment(tx, line),
    };

    // ── The direct route (Operations block 4) ──────────────────────────
    //
    // A line that names a warehouse brings the goods in itself: no purchase
    // order, no goods receipt, nothing in GRNI to clear. The stock arrives at
    // what the invoice says it cost, and the debit goes to the item's own
    // inventory account — named on the item because two lines of one invoice
    // can belong to different stock accounts.
    //
    // There is no variance on this route, because there is nothing to vary
    // from: the invoice *is* the evidence. Falling through to the code below
    // would post the whole line to the purchase variance account, which is
    // what happened before this branch existed.
    if (line.warehouseCode) {
      const account = await inventoryAccountFor(tx, line);
      // REQ-FIX-001 FIX-4 — the line is in the unit it was bought in; the
      // stock is counted in the item's base unit, at the base unit's cost.
      const baseQuantity = await units.toBaseQuantity(tx, line.itemCode!, line.uomCode, parseQuantity(line.quantity));
      await inventory.receive(tx, ctx, {
        itemCode: line.itemCode!,
        warehouseCode: line.warehouseCode,
        branchCode: invoice.branchCode,
        quantity: baseQuantity,
        // A *unit* cost, and the discount is part of it: stock is worth what
        // was paid for it, not what was asked. The posted debit below is the
        // same money, so the warehouse and the ledger agree by construction
        // rather than by coincidence — see the rounding note in `costPerBase`.
        unitCostIqd: costPerBase(invoicedValue, baseQuantity),
        // Whose stock this is. A sale that names this supplier will consume
        // these layers and no others — Operations block 5.
        supplierId: invoice.supplierId,
        movementDate: invoice.invoiceDate,
        kind: 'goods_receipt',
        sourceDocumentType: DOCUMENT_TYPE,
        sourceDocumentId: id,
        sourceLineId: line.id,
        ...(await batchFor(tx, line, invoice.invoiceNo)),
      });
      postingLines.push({
        role: 'inventory',
        accountId: account,
        debit: amount(invoicedValue),
        criteria: { ...criteria, warehouseCode: line.warehouseCode },
        dimensions: { ...dimensions, warehouse: line.warehouseCode },
      });
      continue;
    }

    if (supported !== 0n) {
      if (line.isInventory) {
        grniIqd += supported;
        postingLines.push({ role: 'grni', debit: amount(supported), criteria, dimensions });
      } else if (line.chargedToPayableId) {
        // §9.2 / A10 — not our cost: it parks on the clearing account and
        // becomes a landed-cost charge of the import it belongs to, below.
        chargedLines.push({
          lineId: line.id,
          lineNo: line.lineNo,
          chargedToPayableId: line.chargedToPayableId,
          valueIqd: supported,
        });
        postingLines.push({
          role: 'landed_cost_clearing',
          debit: amount(supported),
          criteria,
          dimensions,
        });
      } else {
        expenseIqd += supported;
        postingLines.push({
          role: 'expense',
          // A service line may say where its cost belongs. A stock line may
          // not: its debit is the item's own inventory account, so that the
          // warehouse and the ledger hold one figure rather than two.
          ...(invoice.expenseAccountId ? { accountId: invoice.expenseAccountId } : {}),
          debit: amount(supported),
          criteria,
          dimensions,
        });
      }
    }

    if (variance !== 0n) {
      // §8.4 — the variance posts to its own account, never into inventory. A
      // credit variance (the supplier charged less) debits nothing; it credits
      // the same account, which is why the sign is tested rather than assumed.
      postingLines.push(
        variance > 0n
          ? { role: 'purchase_variance', debit: amount(variance), criteria, dimensions }
          : { role: 'purchase_variance', credit: amount(variance), criteria, dimensions },
      );
    }
  }

  postingLines.push({
    role: 'supplier_payable',
    // The account the invoice names for itself, when it names one; the
    // supplier_payable mapping otherwise.
    ...(invoice.payableAccountId ? { accountId: invoice.payableAccountId } : {}),
    credit: amount(payableIqd),
    criteria,
    dimensions: base,
  });

  const result = await posting.post(tx, ctx, {
    eventType: 'purchasing.ap_invoice',
    documentTypeCode: DOCUMENT_TYPE,
    source: { module: 'purchasing', documentId: id, event: 'posted' },
    branchCode: invoice.branchCode,
    documentDate: invoice.invoiceDate,
    postingDate: invoice.invoiceDate,
    description: `A/P invoice ${invoice.invoiceNo} — ${supplier?.code ?? 'supplier'} ${invoice.supplierInvoiceNo}`,
    lines: postingLines,
  });

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, invoice.status, 'posted');

  // Goods that landed in the In Process warehouse are in process — Operations
  // block 8. Tracking opens by itself, because whether a shipment is tracked
  // is not a flag somebody sets and forgets: it is where the goods went. An
  // invoice whose goods went anywhere else arrived by other means and has
  // nothing to follow.
  // REQ-AP-001 §17.4 — an import is followed container by container on its
  // B/Ls, not by the four-stage shipment; only other invoices open one.
  if (!invoice.isImport) await shipments.openForInvoice(tx, ctx, id);

  await tx
    .update(apInvoice)
    .set({
      status: 'posted',
      // Fixed here, with the lines, because everything downstream measures
      // against it: the ageing, the payment run, and what an advance may settle
      // (§8.5). A total that could drift from the lines would make all three
      // disagree about the same debt.
      totalIqd: toDecimalString(payableIqd, 4n),
      journalEntryId: result.journalEntryId,
      postedBy: ctx.principal.userId,
      postedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(apInvoice.id, id));

  // The ordered lines carry what has been invoiced, so 05.7's returns and
  // credit memos have something to reduce.
  for (const line of lines) {
    if (!line.purchaseOrderLineId) continue;
    await tx
      .update(purchaseOrderLine)
      .set({
        invoicedQuantity: sql`${purchaseOrderLine.invoicedQuantity} + ${line.quantity}`,
      })
      .where(eq(purchaseOrderLine.id, line.purchaseOrderLineId));
  }

  // REQ-PM-001 §8 — the posting converts the promise to an actual: the cost
  // row names this journal and this invoice, consumes the order's (or the
  // payable's) open commitment, and only what exceeds it is checked anew.
  // Services are the project's cost here; goods are stock until a material
  // issue takes them to the element (§9), so their value only settles the
  // promise the order made.
  await execution.recordInvoiceCost(tx, ctx, {
    invoiceId: id,
    invoiceNo: invoice.invoiceNo,
    supplierCode: supplier?.code ?? null,
    journalEntryId: result.journalEntryId,
    costIqd: expenseIqd + varianceIqd,
    stockIqd: grniIqd + lines.filter((line) => line.warehouseCode).reduce((sum, line) => sum + lineValue(line), 0n),
    incurredOn: invoice.invoiceDate,
  });

  // REQ-AP-001 §7.2 — a payable-linked invoice writes the order lane's event
  // and re-derives the stage, in this same transaction.
  if (invoice.payableId) {
    await payables.onInvoiceEvent(tx, {
      payableId: invoice.payableId,
      eventCode: 'INVOICE_POSTED',
      invoiceId: id,
      invoiceNo: invoice.invoiceNo,
      summary: `Purchase invoice ${invoice.invoiceNo} posted — ${say(toDecimalString(payableIqd, 4n))}`,
      actorUserId: ctx.principal.userId,
    });
  }

  // REQ-FIX-001 FX6 — a deposit paid ahead of this invoice (on its import or
  // its purchase order) is applied to it now, so the invoice, the import and
  // the supplier's account agree on what is still owed.
  await advances.applyToPostedInvoice(tx, ctx, id);

  /*
   * §15.3 — the advance this invoice is paid in front, raised and approved
   * (2026-10-03, by direction).
   *
   * The accountant wrote a percentage on the invoice; the share of the total
   * just committed is what the bank is asked for, against this invoice's own
   * import, and the request carries the invoice's approval rather than waiting
   * for another. Send is untouched: the PD, the funds, the verified supplier
   * account and the instalment trigger are all still asked there, so this
   * moves no money.
   */
  const advanceIqd = advanceOf(payableIqd, invoice.advancePercent);
  if (advanceIqd !== null && !invoice.advanceApplicationId) {
    if (!invoice.payableId) {
      // A payment application belongs to an import application; an invoice
      // with none has nowhere to hang the request.
      await audit.record(tx, {
        actorUserId: ctx.principal.userId,
        action: 'ap_invoice.advance_not_raised',
        objectType: PERMISSION_OBJECT,
        objectId: id,
        branchCode: invoice.branchCode,
        after: { why: 'the invoice names no import application', percent: invoice.advancePercent },
        outcome: 'success',
      });
    } else {
      const owner = await payables.load(tx, invoice.payableId);
      if (owner.currency !== 'IQD') {
        /*
         * The invoice's total is held in dinars and the import is not. The
         * rate that should turn one into the other on this day is the
         * accountant's to choose — the books' own, the bank's, or the one the
         * supplier's letter implies — and converting on a default here would
         * put a figure nobody chose in front of a bank.
         */
        await payableEvents.record(tx, {
          payableId: invoice.payableId,
          eventCode: 'ADVANCE_NOT_RAISED',
          sourceType: PERMISSION_OBJECT,
          sourceId: id,
          sourceNo: invoice.invoiceNo,
          summary:
            `${invoice.invoiceNo} asks for ${invoice.advancePercent}% in front — ` +
            `${say(toDecimalString(advanceIqd, 4n))} — but ${owner.payableNo} is in ${owner.currency}. ` +
            'Raise the payment application by hand at the rate you mean to use.',
          actorUserId: ctx.principal.userId,
        });
      } else if (!invoice.advancePaidFromAccountId || !invoice.advancePaymentMethodCode) {
        /*
         * The percentage is agreed and the account is not chosen yet — which
         * 0271 allows on purpose, because the supplier's document states the
         * one and the company decides the other later. Said on the log so the
         * advance is not quietly forgotten.
         */
        await payableEvents.record(tx, {
          payableId: invoice.payableId,
          eventCode: 'ADVANCE_NOT_RAISED',
          sourceType: PERMISSION_OBJECT,
          sourceId: id,
          sourceNo: invoice.invoiceNo,
          summary:
            `${invoice.invoiceNo} agrees ${invoice.advancePercent}% in front — ` +
            `${say(toDecimalString(advanceIqd, 4n))} — and names no account to pay it from. ` +
            'Raise the payment application when the account is decided.',
          actorUserId: ctx.principal.userId,
        });
      } else {
        const made = await applications.create(tx, ctx, {
          payableId: invoice.payableId,
          paymentMethodCode: invoice.advancePaymentMethodCode!,
          bankCashAccountId: invoice.advancePaidFromAccountId!,
          amountTxn: advanceIqd,
          note:
            `${invoice.advancePercent}% advance on ${invoice.invoiceNo}, ` +
            `raised when it posted (${say(toDecimalString(payableIqd, 4n))} total).`,
        });
        // "not drafts": approved on the invoice's own approval, which a second
        // person gave when they posted it.
        await applications.approve(tx, ctx, made.id, { inheritedFrom: invoice.invoiceNo });
        await tx
          .update(apInvoice)
          .set({ advanceApplicationId: made.id, updatedAt: new Date() })
          .where(eq(apInvoice.id, id));

        // On the import's own log, where somebody watching the payment lane
        // will see it without being told to look.
        await payableEvents.record(tx, {
          payableId: invoice.payableId,
          eventCode: 'ADVANCE_RAISED',
          sourceType: PERMISSION_OBJECT,
          sourceId: id,
          sourceNo: invoice.invoiceNo,
          summary:
            `${made.applicationNo} raised for ${invoice.advancePercent}% of ${invoice.invoiceNo} — ` +
            `${say(toDecimalString(advanceIqd, 4n))}, approved on the invoice's own approval.`,
          actorUserId: ctx.principal.userId,
        });
      }
    }
  }

  // §9.2 / A10 — each charged line becomes a landed-cost charge of its
  // import, in this same transaction, typed by this invoice's own category.
  if (chargedLines.length > 0) {
    const [own] = invoice.payableId
      ? await tx
          .select({ category: payable.expenseCategoryCode })
          .from(payable)
          .where(eq(payable.id, invoice.payableId))
          .limit(1)
      : [];
    const chargeType =
      own?.category === 'freight_forwarding'
        ? 'freight'
        : own?.category === 'customs_brokerage'
          ? 'customs_asycuda'
          : 'other';
    for (const charged of chargedLines) {
      await tx.insert(landedCostCharge).values({
        payableId: charged.chargedToPayableId,
        chargeTypeCode: chargeType,
        amountTxn: toDecimalString(charged.valueIqd, 4n),
        currency: 'IQD',
        amountIqd: toDecimalString(charged.valueIqd, 4n),
        sourceType: 'ap_invoice_line',
        sourceId: charged.lineId,
        sourceNo: invoice.invoiceNo,
        createdBy: ctx.principal.userId,
      });
      await payables.onChargedToImport(tx, {
        payableId: charged.chargedToPayableId,
        invoiceId: id,
        invoiceNo: invoice.invoiceNo,
        summary: `Charged to this import: ${toDecimalString(charged.valueIqd, 4n)} IQD ${chargeType} — A/P invoice ${invoice.invoiceNo} line ${charged.lineNo}`,
        actorUserId: ctx.principal.userId,
      });
    }
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'ap_invoice.posted',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: invoice.branchCode,
    before: { status: 'submitted' },
    after: {
      status: 'posted',
      journalEntryId: result.journalEntryId,
      grniIqd: toDecimalString(grniIqd, 4n),
      expenseIqd: toDecimalString(expenseIqd, 4n),
      varianceIqd: toDecimalString(varianceIqd, 4n),
      payableIqd: toDecimalString(payableIqd, 4n),
    },
    outcome: 'success',
  });

  return { journalEntryId: result.journalEntryId, varianceValueIqd: varianceIqd };
}

// ---------------------------------------------------------------------------
// Reverse — posted → reversed (§3.2, §14.3; decided 2026-09-27)
// ---------------------------------------------------------------------------

export class ApInvoiceNotReversibleError extends Error {
  readonly code = 'AP_INVOICE_NOT_REVERSIBLE';
  constructor(
    readonly invoiceNo: string,
    detail: string,
  ) {
    super(`${invoiceNo} cannot be reversed: ${detail}`);
    this.name = 'ApInvoiceNotReversibleError';
  }
}

/**
 * Undoes a posted Purchase Invoice, whole.
 *
 * The mirror of `ar-invoice.reverse`, and for the same reason: a Goods Return
 * is the document for goods going back to the supplier, not for an invoice
 * that should never have been posted. The journal is mirrored and linked, the
 * goods the invoice received leave the warehouse by the very layers they made
 * — at the cost they arrived at, and only if nothing has been taken from those
 * layers since — and the document is marked reversed with the reason.
 *
 * Refused when anything rests on the invoice: a payment or an advance settled
 * against it, a return or a credit memo raised from it, a payment run that
 * has picked it up, or stock from it that has been sold or moved on (the
 * inventory engine says so, layer by layer). Each of those is a document of
 * its own and is undone through its own document first.
 */
export async function reverse(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  input: { readonly reason: string },
): Promise<{ reversalEntryNo: string; movementsReversed: number }> {
  const { invoice, lines } = await load(tx, id, { lock: true });

  await authz.authorize(ctx.principal, 'reverse_cancel', PERMISSION_OBJECT, {
    branchCode: invoice.branchCode,
    objectId: id,
  });

  const reason = input.reason.trim();
  if (!reason) {
    throw new ApInvoiceNotReversibleError(
      invoice.invoiceNo,
      'a reversal records why the invoice was wrong (§14.3). Give a reason.',
    );
  }

  // The specific refusals first, the status machine last — see `ar-invoice`.
  if (parseDecimal(invoice.settledAmountIqd, 4n) !== 0n) {
    throw new ApInvoiceNotReversibleError(
      invoice.invoiceNo,
      `${invoice.settledAmountIqd} IQD has been paid or settled against it. Reverse the payment first; the invoice can then be reversed.`,
    );
  }

  const [returned] = await tx
    .select({ returnNo: goodsReturn.returnNo })
    .from(goodsReturn)
    .where(
      and(eq(goodsReturn.apInvoiceId, id), sql`${goodsReturn.status} not in ('rejected', 'cancelled')`),
    )
    .limit(1);
  if (returned) {
    throw new ApInvoiceNotReversibleError(
      invoice.invoiceNo,
      `Goods Return ${returned.returnNo} was raised against it. An invoice with a return behind it is corrected through the return, not undone.`,
    );
  }

  const [credited] = await tx
    .select({ memoNo: supplierCreditMemo.memoNo })
    .from(supplierCreditMemo)
    .where(eq(supplierCreditMemo.apInvoiceId, id))
    .limit(1);
  if (credited) {
    throw new ApInvoiceNotReversibleError(
      invoice.invoiceNo,
      `Supplier Credit Memo ${credited.memoNo} was raised against it.`,
    );
  }

  const [proposed] = await tx
    .select({ id: paymentProposalItem.id })
    .from(paymentProposalItem)
    .where(eq(paymentProposalItem.apInvoiceId, id))
    .limit(1);
  if (proposed) {
    throw new ApInvoiceNotReversibleError(
      invoice.invoiceNo,
      'a payment run has selected it. Take it out of the proposal first.',
    );
  }

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, invoice.status, 'reversed', reason);
  if (!invoice.journalEntryId) {
    throw new ApInvoiceNotReversibleError(invoice.invoiceNo, 'it has no journal to reverse.');
  }

  // The goods first. A layer that has been sold from, returned from or
  // carried to another warehouse cannot be taken back, and the inventory
  // engine refuses it with the figures — before any journal is touched.
  const receipts = await tx
    .select({ id: inventoryMovement.id })
    .from(inventoryMovement)
    .where(
      and(
        eq(inventoryMovement.sourceDocumentType, DOCUMENT_TYPE),
        eq(inventoryMovement.sourceDocumentId, id),
        eq(inventoryMovement.kind, 'goods_receipt'),
      ),
    )
    .orderBy(inventoryMovement.createdAt);

  for (const movement of receipts) {
    await inventory.reverseMovement(tx, ctx, movement.id, reason);
  }

  const reversal = await journal.reverse(tx, ctx, invoice.journalEntryId, { reason });

  // The ordered lines were credited with this invoice's quantity when it
  // posted; they give it back, so a later invoice can bill the order again.
  for (const line of lines) {
    if (!line.purchaseOrderLineId) continue;
    await tx
      .update(purchaseOrderLine)
      .set({ invoicedQuantity: sql`${purchaseOrderLine.invoicedQuantity} - ${line.quantity}` })
      .where(eq(purchaseOrderLine.id, line.purchaseOrderLineId));
  }

  const now = new Date();
  await tx
    .update(apInvoice)
    .set({
      status: 'reversed',
      reversedBy: ctx.principal.userId,
      reversedAt: now,
      reversalReason: reason,
      updatedAt: now,
    })
    .where(eq(apInvoice.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'ap_invoice.reversed',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: invoice.branchCode,
    outcome: 'success',
    before: { status: invoice.status, journalEntryId: invoice.journalEntryId },
    after: {
      status: 'reversed',
      reversalEntryNo: reversal.entryNo,
      movementsReversed: receipts.length,
    },
    reason,
    relatedObjectId: reversal.id,
  });

  // REQ-PM-001 §8 — the project's analysis follows the journal's reversal.
  await execution.reverseInvoiceCost(tx, ctx, {
    invoiceId: id,
    reason,
    journalEntryId: reversal.id,
    stockIqd: lines.filter((line) => line.isInventory || line.warehouseCode).reduce((sum, line) => sum + lineValue(line), 0n),
  });

  // A10's mirror — the reversal withdraws the charges this invoice placed.
  if (lines.length > 0) {
    await tx
      .update(landedCostCharge)
      .set({
        cancelledAt: now,
        cancelledBy: ctx.principal.userId,
        cancelReason: `A/P invoice ${invoice.invoiceNo} reversed — ${reason}`,
      })
      .where(
        and(
          eq(landedCostCharge.sourceType, 'ap_invoice_line'),
          inArray(
            landedCostCharge.sourceId,
            lines.map((line) => line.id),
          ),
          isNull(landedCostCharge.cancelledAt),
        ),
      );
  }

  // REQ-AP-001 §14 — a reversed invoice re-derives its payable's stage; the
  // event carries the reason so the log reads as the story it is.
  if (invoice.payableId) {
    await payables.onInvoiceEvent(tx, {
      payableId: invoice.payableId,
      eventCode: 'INVOICE_REVERSED',
      invoiceId: id,
      invoiceNo: invoice.invoiceNo,
      summary: `Purchase invoice ${invoice.invoiceNo} reversed — ${reason}`,
      actorUserId: ctx.principal.userId,
    });
  }

  return { reversalEntryNo: reversal.entryNo, movementsReversed: receipts.length };
}

/**
 * §8.6 — the department that confirmed this service line.
 *
 * The benefiting department is the meaningful analytical dimension for a
 * service cost: it is the department that asked for the work, said it was
 * delivered, and whose budget it belongs against. Read from the confirmation
 * rather than stated on the invoice, so Finance cannot key it differently from
 * the department that actually signed.
 */
async function confirmingDepartment(
  tx: Tx,
  line: typeof apInvoiceLine.$inferSelect,
): Promise<string | null> {
  if (!line.purchaseOrderLineId) return null;

  const [row] = await tx
    .select({ departmentCode: serviceReceipt.departmentCode })
    .from(serviceReceiptLine)
    .innerJoin(serviceReceipt, eq(serviceReceipt.id, serviceReceiptLine.serviceReceiptId))
    .where(
      and(
        eq(serviceReceiptLine.purchaseOrderLineId, line.purchaseOrderLineId),
        eq(serviceReceipt.status, 'approved'),
      ),
    )
    .limit(1);

  return row?.departmentCode ?? null;
}

/** The line's own money: invoiced quantity at the invoiced price. */
/**
 * What the line comes to: quantity x unit price, less the discount.
 *
 * Not stored. A stored total is one more thing that can disagree with its own
 * parts, and the parts are what the supplier and the company agreed.
 */
/**
 * The stock account this line's goods are held in — the item's own.
 *
 * §3.3 exists so "which account does a sale's revenue go to?" is
 * configuration; this is not that kind of question. Two lines of one invoice
 * can be different items in different stock accounts, and a posting rule
 * keyed on the warehouse would give both the same answer.
 */
async function inventoryAccountFor(
  tx: Tx,
  line: typeof apInvoiceLine.$inferSelect,
): Promise<string> {
  if (!line.itemCode) {
    throw new ApInvoiceLineError(line.lineNo, 'names a warehouse but no item, so nothing can be received into it.');
  }
  const [row] = await tx
    .select({ account: item.inventoryAccountId })
    .from(item)
    .where(eq(item.code, line.itemCode))
    .limit(1);
  if (!row?.account) {
    throw new ApInvoiceLineError(
      line.lineNo,
      `item ${line.itemCode} names no inventory account, so its stock has nowhere to be held. Set one on the item.`,
    );
  }
  return row.account;
}

/**
 * How stock arriving on an invoice is identified.
 *
 * §9.3 tracks every stock item, by batch or by serial, and the sponsor's
 * Purchase Invoice line carries neither — quantity, price, discount and a
 * warehouse, and that is all.
 *
 * For a batch, the invoice number *is* the batch. One delivery from one
 * supplier on one document is one batch in every sense that matters, and it
 * makes the stock traceable back to the paper that brought it in, which is
 * what tracking is for.
 *
 * A serial cannot be invented the same way. Ten panels need ten serials, and
 * nothing on the invoice says what they are. Those goods come in through a
 * Goods Receipt, where each one is read off the box.
 */
async function batchFor(
  tx: Tx,
  line: typeof apInvoiceLine.$inferSelect,
  invoiceNo: string,
): Promise<{ batchNumber?: string }> {
  const [row] = await tx
    .select({ tracking: item.tracking })
    .from(item)
    .where(eq(item.code, line.itemCode!))
    .limit(1);

  if (row?.tracking === 'serial' || row?.tracking === 'serial_and_batch') {
    throw new ApInvoiceLineError(
      line.lineNo,
      `item ${line.itemCode} is tracked by serial number, which an invoice does not carry. Receive it on a Goods Receipt, where each serial is recorded.`,
    );
  }
  return row?.tracking === 'batch' ? { batchNumber: invoiceNo } : {};
}

/**
 * REQ-FIX-001 FIX-4 — the unit a line is written in. A line against an order
 * line is in the order's unit (the received and invoiced quantities are
 * compared in it); an item's line is in one of the item's active units, its
 * purchase default when none is named; a charge with no item keeps what it
 * was given.
 */
async function lineUnit(tx: Tx, itemCode: string | null, given: string | null | undefined, ordered: string | null, lineNo: number): Promise<string> {
  if (ordered) {
    if (given && given !== ordered) throw new ApInvoiceLineError(lineNo, `is in ${given}, but its order line is in ${ordered}; invoice it in ${ordered}.`);
    return ordered;
  }
  if (!itemCode) return given?.trim() || 'EA';
  if (!given?.trim()) return units.purchaseDefaultOf(tx, itemCode);
  return units.assertLineUnit(tx, itemCode, given);
}

/**
 * What one base unit of this line costs, net of its discount — from the
 * line's value and its quantity converted to the item's base (FIX-4).
 *
 * Rounding is the thing to be careful of. Three units at a line value of ten
 * is 3.3333 each, and three layers of 3.3333 are worth 9.9999 — a dinar less
 * than the ledger was told. The layer is therefore valued at the quotient and
 * the statement is what it is: for the quantities and prices this document
 * deals in, held to four decimal places, the difference is below the smallest
 * unit the ledger records. `ops04` asserts the two agree on a line that does
 * not divide evenly, which is what would catch it if that ever stopped being
 * true.
 */
function costPerBase(value: bigint, baseQuantity: bigint): bigint {
  if (baseQuantity === 0n) return 0n;
  // Quantities carry six decimal places, money four.
  return (value * 1_000_000n) / baseQuantity;
}

function lineValue(line: typeof apInvoiceLine.$inferSelect): bigint {
  const gross = (parseQuantity(line.quantity) * parseDecimal(line.unitPrice, 4n)) / 1_000_000n;
  return gross - parseDecimal(line.discountIqd ?? '0', 4n);
}

/**
 * What the receipt evidence supports for this line, at the *ordered* price.
 *
 * For an inventory line this is exactly what the goods receipt debited to
 * inventory and credited to GRNI, which is what makes the GRNI clearance exact
 * rather than approximate — 05.5's gate.
 *
 * Capped at the invoiced quantity: invoicing 40 of 100 received clears 40 units
 * of GRNI, not 100. The rest waits for the next invoice.
 */
async function supportedValue(tx: Tx, line: typeof apInvoiceLine.$inferSelect): Promise<bigint> {
  if (!line.purchaseOrderLineId) return lineValue(line);

  const [ordered] = await tx
    .select()
    .from(purchaseOrderLine)
    .where(eq(purchaseOrderLine.id, line.purchaseOrderLineId))
    .limit(1);
  if (!ordered) return lineValue(line);

  // What this invoice is entitled to clear: what it bills, capped by what is
  // still uninvoiced of what arrived. The same figure the domain calls
  // `entitled`, and it has to be the same or the ledger and the match would
  // disagree about the size of the variance.
  const received = parseQuantity(line.receivedQuantity);
  const already = parseQuantity(ordered.invoicedQuantity);
  const uninvoiced = received - already > 0n ? received - already : 0n;
  const invoiced = parseQuantity(line.quantity);
  const clearing = invoiced < uninvoiced ? invoiced : uninvoiced;

  return (clearing * parseDecimal(ordered.unitPrice, 4n)) / 1_000_000n;
}

/**
 * The register — Operations block 4's list of Purchase Invoices.
 *
 * The supplier's name is joined rather than stored on the invoice, so a
 * supplier renamed today reads correctly on an invoice raised last year. Row
 * level security decides which branches are in the list; this does not filter
 * by branch itself, because doing it in two places is how the two answers
 * start to differ.
 */
export async function list(tx: Tx) {
  return tx
    .select({
      id: apInvoice.id,
      invoiceNo: apInvoice.invoiceNo,
      supplierInvoiceNo: apInvoice.supplierInvoiceNo,
      supplierName: businessPartner.legalName,
      supplierCode: businessPartner.code,
      invoiceDate: apInvoice.invoiceDate,
      dueDate: apInvoice.dueDate,
      // What the invoice comes to. `total_iqd` is written at posting, so on a
      // draft it is zero — and a register whose Amount column reads nothing for
      // every unposted invoice is a register nobody can scan. Until it is
      // posted the figure is summed from the lines, which is the same
      // arithmetic the posting itself does.
      totalIqd: sql<string>`case
        when ${apInvoice.totalIqd} <> 0 then ${apInvoice.totalIqd}::text
        else coalesce((
          select sum(l.quantity * l.unit_price - l.discount_iqd)
          from ap_invoice_line l
          where l.ap_invoice_id = ${apInvoice.id}
        ), 0)::text
      end`,
      status: apInvoice.status,
      branchCode: apInvoice.branchCode,
      // D12 / D13 — what the register needs to say Unpaid / Paid / Overdue,
      // and which rows are imports and which are expenses.
      settledAmountIqd: apInvoice.settledAmountIqd,
      isImport: apInvoice.isImport,
      expenseCategoryCode: apInvoice.expenseCategoryCode,
      recurringContractId: apInvoice.recurringContractId,
      note: apInvoice.note,
      payableNo: payable.payableNo,
    })
    .from(apInvoice)
    .leftJoin(businessPartner, eq(businessPartner.id, apInvoice.supplierId))
    .leftJoin(payable, eq(payable.id, apInvoice.payableId))
    .orderBy(desc(apInvoice.invoiceDate), desc(apInvoice.invoiceNo));
}

/**
 * The invoice a person is looking at, found by the number on it.
 *
 * The screens address an invoice by its number rather than its id, because the
 * number is what the document says and what somebody would read out over the
 * phone.
 */
export async function viewByNo(tx: Tx, invoiceNo: string) {
  const [row] = await tx
    .select({ id: apInvoice.id })
    .from(apInvoice)
    .where(eq(apInvoice.invoiceNo, invoiceNo))
    .limit(1);
  if (!row) return null;

  const { invoice, lines } = await load(tx, row.id);

  // Everybody the document passed through, as the Journal Entry names them. A
  // document nobody is named on is a document nobody answers for, and each of
  // these is a different answer: who wrote it, who sent it up, who accepted the
  // variance, and who carried it to the ledger.
  const people = await tx
    .select({ id: appUser.id, displayName: appUser.displayName })
    .from(appUser)
    .where(
      inArray(
        appUser.id,
        [
          invoice.createdBy,
          invoice.submittedBy,
          invoice.postedBy,
          invoice.varianceApprovedBy,
          invoice.nonPoApprovedBy,
          invoice.reversedBy,
        ].filter((id): id is string => Boolean(id)),
      ),
    );
  const name = (id: string | null) =>
    id ? (people.find((person) => person.id === id)?.displayName ?? null) : null;

  // The posting, by the number a person would read out, so the invoice drills
  // to its own journal rather than to an id nobody can type.
  const [posted] = invoice.journalEntryId
    ? await tx
        .select({ entryNo: journalEntry.entryNo })
        .from(journalEntry)
        .where(eq(journalEntry.id, invoice.journalEntryId))
        .limit(1)
    : [];

  return {
    invoice,
    lines,
    raisedBy: name(invoice.createdBy),
    submittedBy: name(invoice.submittedBy),
    postedBy: name(invoice.postedBy),
    varianceApprovedBy: name(invoice.varianceApprovedBy),
    reversedBy: name(invoice.reversedBy),
    journalEntryNo: posted?.entryNo ?? null,
  };
}

export async function view(tx: Tx, id: string) {
  return load(tx, id);
}

/** §8.4 — match status, for the screen that must show it at all times. */
export async function matchStatusOf(tx: Tx, id: string) {
  const { invoice, lines } = await load(tx, id);
  return {
    status: invoice.matchStatus,
    varianceValueIqd: parseDecimal(invoice.varianceValueIqd, 4n),
    approvedBy: invoice.varianceApprovedBy,
    lines: lines.map((line) => ({
      lineNo: line.lineNo,
      status: line.matchStatus,
      receivedQuantity: parseQuantity(line.receivedQuantity),
      invoicedQuantity: parseQuantity(line.quantity),
      varianceValueIqd: parseDecimal(line.varianceValueIqd, 4n),
    })),
  };
}

/** §8.4 — configure the match tolerance. Finance's decision, not the clerk's. */
export async function setTolerance(
  tx: Tx,
  ctx: ActorContext,
  input: {
    supplierId?: string | null;
    quantityPercent?: string;
    pricePercent?: string;
    valuePercent?: string;
    note?: string | null;
  },
): Promise<void> {
  await authz.authorize(ctx.principal, 'configure', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
  });

  const supplierId = input.supplierId ?? null;
  const values = {
    quantityPercent: input.quantityPercent ?? '0',
    pricePercent: input.pricePercent ?? '0',
    valuePercent: input.valuePercent ?? '0',
    note: input.note ?? null,
    updatedBy: ctx.principal.userId,
    updatedAt: new Date(),
  };

  const existing = supplierId
    ? await tx
        .select({ id: apMatchTolerance.id })
        .from(apMatchTolerance)
        .where(eq(apMatchTolerance.supplierId, supplierId))
        .limit(1)
    : await tx
        .select({ id: apMatchTolerance.id })
        .from(apMatchTolerance)
        .where(isNull(apMatchTolerance.supplierId))
        .limit(1);

  if (existing[0]) {
    await tx.update(apMatchTolerance).set(values).where(eq(apMatchTolerance.id, existing[0].id));
  } else {
    await tx.insert(apMatchTolerance).values({ supplierId, ...values });
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'ap_invoice.tolerance_set',
    objectType: PERMISSION_OBJECT,
    objectId: existing[0]?.id ?? null,
    branchCode: ctx.branchCode,
    after: { supplierId, ...values, updatedAt: undefined },
    outcome: 'success',
  });
}
