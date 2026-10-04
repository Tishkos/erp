/**
 * Inventory detectors — platform phase, Agent 7.
 *
 * `inventory_movement` is the one ledger for stock. These read the questions
 * `inventory-integrity` and `inventory-valuation` already ask; the Exception
 * Center repairs nothing (the integrity handoff has its own cleanup scripts).
 */
import { EVIDENCE_ROW, type Finding } from '../../domain/exceptions';
import { parseDecimal, toDecimalString } from '../../domain/money';
import { profileHref, isProfileKind, type ProfileKind } from '../../domain/profiles';
import * as integrity from '../inventory-integrity';
import * as valuation from '../inventory-valuation';
import * as logisticsViews from '../logistics-views';
import { enc, itemNames, userNames, warehouseBranches, type DetectContext } from './shared';

const stockLedgerLink = (warehouse: string, item: string) => `/inventory/stock-ledger?item=${enc(item)}&warehouse=${enc(warehouse)}`;

async function positions(ctx: DetectContext, issue: 'negative_position' | 'ledger_layer_mismatch', detector: string): Promise<Finding[]> {
  const { tx } = ctx;
  const adrift = (await integrity.adriftPositions(tx)).filter((p) => p.issue === issue);
  if (adrift.length === 0) return [];
  const houses = await warehouseBranches(tx);
  const items = await itemNames(tx, adrift.map((p) => p.itemCode));
  const people = await userNames(tx, [...houses.values()].map((h) => h.responsibleUserId));
  return adrift.map((position) => {
    const house = houses.get(position.warehouseCode);
    const owner = house?.responsibleUserId ?? null;
    const href = stockLedgerLink(position.warehouseCode, position.itemCode);
    return {
      detector,
      subject: `${position.warehouseCode}|${position.itemCode}`,
      severity: 'high' as const,
      facts: {
        item: `${position.itemCode} ${items.get(position.itemCode) ?? ''}`.trim(),
        warehouse: `${position.warehouseCode} ${house?.name ?? ''}`.trim(),
        // negative_position: what is on hand; ledger_layer_mismatch: the ledger less the layers.
        quantityQty: position.detail,
      },
      evidence: [EVIDENCE_ROW({ ref: position.itemCode, href, quantity: position.detail, note: { code: issue === 'negative_position' ? 'stock_on_hand' : 'stock_ledger_less_layers' } })],
      record: {
        type: 'warehouse',
        id: position.warehouseCode,
        label: position.warehouseCode,
        href: profileHref('warehouse', position.warehouseCode) ?? '/master-data/warehouses',
      },
      action: href,
      branchCode: house?.branchCode ?? null,
      owner: owner ? { userId: owner, name: people.get(owner) ?? '' } : null,
    };
  });
}

/** A warehouse holding less than nothing: the ledger's sum for an item in it is below zero. */
export const negativeStock = (ctx: DetectContext) => positions(ctx, 'negative_position', 'inventory.negative_stock');

/** The FIFO layers do not hold what the movements say is there (a stranded layer, or a layer without its movement). */
export const layerMismatch = (ctx: DetectContext) => positions(ctx, 'ledger_layer_mismatch', 'inventory.layer_mismatch');

// ---------------------------------------------------------------------------
// Documents and the ledger disagree
// ---------------------------------------------------------------------------

const DOCUMENT_PROFILE: Readonly<Record<string, ProfileKind>> = {
  stock_transfer: 'stock_transfer',
  stock_adjustment: 'stock_reconciliation',
  ap_invoice: 'purchase_invoice',
  ar_invoice: 'sales_invoice',
  sales_return: 'sales_return',
  goods_return: 'goods_return',
  opening_stock: 'opening_stock',
};

function documentLink(type: string, no: string | null): string {
  const kind = DOCUMENT_PROFILE[type];
  const profile = kind && isProfileKind(kind) && no ? profileHref(kind, no) : null;
  return profile ?? '/inventory/checks';
}

/**
 * A stock document without ledger rows, ledger rows without a document, a
 * transfer that created or destroyed stock — the 2026-09-27 class of damage,
 * found by the nightly check and shown here as a record to deal with.
 */
export async function documentLedgerMismatch(ctx: DetectContext): Promise<Finding[]> {
  const { tx } = ctx;
  const [withoutLedger, withoutDocument, unbalanced] = [
    await integrity.documentsWithoutLedger(tx),
    await integrity.ledgerWithoutDocument(tx),
    await integrity.unbalancedTransfers(tx),
  ];
  const findings: Finding[] = [];
  const action = '/inventory/checks';

  for (const doc of withoutLedger) {
    const href = documentLink(doc.documentType, doc.documentNo);
    findings.push({
      detector: 'inventory.document_ledger_mismatch',
      subject: `no_ledger|${doc.documentType}|${doc.documentId}`,
      severity: 'critical',
      facts: { kind: 'no_ledger', documentType: doc.documentType, document: doc.documentNo },
      evidence: [EVIDENCE_ROW({ ref: doc.documentNo, href, note: { code: 'stock_no_ledger_rows' } })],
      record: { type: doc.documentType, id: doc.documentId, label: doc.documentNo, href },
      action,
      branchCode: doc.branchCode,
    });
  }

  const orphaned = new Map<string, typeof withoutDocument>();
  for (const movement of withoutDocument) {
    const key = `${movement.sourceDocumentType}|${movement.sourceDocumentId}`;
    orphaned.set(key, [...(orphaned.get(key) ?? []), movement]);
  }
  const houses = orphaned.size > 0 ? await warehouseBranches(tx) : null;
  for (const [key, list] of orphaned) {
    const first = list[0]!;
    findings.push({
      detector: 'inventory.document_ledger_mismatch',
      subject: `no_document|${key}`,
      severity: 'critical',
      facts: { kind: 'no_document', documentType: first.sourceDocumentType, document: first.sourceDocumentId, movements: list.length },
      evidence: list.slice(0, 25).map((m) =>
        EVIDENCE_ROW({ ref: m.itemCode, href: stockLedgerLink(m.warehouseCode, m.itemCode), quantity: m.quantity, note: { code: 'stock_orphan_movement', params: { warehouse: m.warehouseCode } } }),
      ),
      record: { type: first.sourceDocumentType, id: first.sourceDocumentId, label: first.sourceDocumentId, href: action },
      action,
      branchCode: houses?.get(first.warehouseCode)?.branchCode ?? null,
    });
  }

  const transfers = new Map<string, typeof unbalanced>();
  for (const transfer of unbalanced) {
    const key = `${transfer.sourceDocumentType}|${transfer.sourceDocumentId}`;
    transfers.set(key, [...(transfers.get(key) ?? []), transfer]);
  }
  for (const [key, list] of transfers) {
    const first = list[0]!;
    const no = first.documentNo ?? first.sourceDocumentId;
    const href = documentLink(first.sourceDocumentType, first.documentNo);
    findings.push({
      detector: 'inventory.document_ledger_mismatch',
      subject: `unbalanced|${key}`,
      severity: 'critical',
      facts: { kind: 'unbalanced', documentType: first.sourceDocumentType, document: no, items: list.length },
      evidence: list.slice(0, 25).map((t) =>
        EVIDENCE_ROW({ ref: t.itemCode, href, quantity: t.issued, note: { code: 'stock_unbalanced_transfer', params: { received: t.received, documented: t.documented ?? '' } } }),
      ),
      record: { type: first.sourceDocumentType, id: first.sourceDocumentId, label: no, href },
      action,
      branchCode: null,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// The stock's value and the inventory accounts
// ---------------------------------------------------------------------------

/**
 * The layers' value against the inventory accounts, today. Stock whose
 * movement has no journal of its own yet (`provisional`) legitimately sits in
 * the layers and not in the books; only a difference that remains after it is
 * taken out is a finding.
 */
export async function glDifference(ctx: DetectContext): Promise<Finding[]> {
  const figure = await valuation.stockAgainstGl(ctx.tx, ctx.today);
  const difference = parseDecimal(figure.differenceIqd, 4n);
  const provisional = parseDecimal(figure.provisionalIqd, 4n);
  const unexplained = difference - provisional;
  if (unexplained === 0n) return [];
  return [
    {
      detector: 'inventory.gl_difference',
      subject: 'company',
      severity: 'high',
      facts: {
        layersIqd: figure.layersIqd,
        glIqd: figure.glIqd,
        provisionalIqd: figure.provisionalIqd,
        unexplainedIqd: toDecimalString(unexplained),
      },
      evidence: [
        EVIDENCE_ROW({ ref: 'FIFO', href: '/inventory/fifo-valuation', amount: figure.layersIqd, note: { code: 'value_layers' } }),
        EVIDENCE_ROW({ ref: 'GL', href: '/finance/account-reconciliation', amount: figure.glIqd, note: { code: 'value_accounts' } }),
        EVIDENCE_ROW({ ref: 'FIFO', href: '/inventory/fifo-valuation', amount: figure.provisionalIqd, note: { code: 'value_provisional' } }),
      ],
      record: { type: 'company', id: 'inventory-value', label: 'FIFO', href: '/inventory/fifo-valuation' },
      action: '/finance/account-reconciliation',
      branchCode: null,
    },
  ];
}

// ---------------------------------------------------------------------------
// Stock in transit that no import accounts for
// ---------------------------------------------------------------------------

export async function transitMismatch(ctx: DetectContext): Promise<Finding[]> {
  const rows = await logisticsViews.inTransitReconciliation(ctx.tx);
  if (rows.length === 0) return [];
  const items = await itemNames(ctx.tx, rows.map((r) => r.itemCode));
  return rows.map((row) => ({
    detector: 'inventory.transit_mismatch',
    subject: row.itemCode,
    severity: 'medium' as const,
    facts: { item: `${row.itemCode} ${items.get(row.itemCode) ?? ''}`.trim(), ledgerQty: row.ledger, importsQty: row.imports, differenceQty: row.difference },
    evidence: [
      EVIDENCE_ROW({ ref: row.itemCode, href: '/logistics/in-transit', quantity: row.ledger, note: { code: 'transit_ledger' } }),
      EVIDENCE_ROW({ ref: row.itemCode, href: '/logistics/in-transit', quantity: row.imports, note: { code: 'transit_imports' } }),
    ],
    record: { type: 'item', id: row.itemCode, label: row.itemCode, href: profileHref('item', row.itemCode) ?? '/inventory/items' },
    action: '/logistics/in-transit',
    branchCode: null,
  }));
}
