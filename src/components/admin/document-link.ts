/**
 * Where a stock movement's document lives, by the type the ledger recorded.
 *
 * The ledger names the document that moved the stock; this is the one place
 * that says which screen shows it, so the Stock Movement page, the Stock
 * Ledger and anything else that lists movements send a reader to the same
 * door. A type with no screen of its own — the two block-7 registers — opens
 * its list with the number in the search box.
 *
 * Returns null for a movement that named no document, or one whose document
 * has no number any more; the caller shows the text and no link.
 */
export function documentHref(
  documentType: string | null | undefined,
  documentNo: string | null | undefined,
): string | null {
  if (!documentType || !documentNo) return null;
  const no = encodeURIComponent(documentNo);
  switch (documentType) {
    case 'ap_invoice':
    case 'supplier_shipment':
      return `/purchasing/ap-invoices/${no}`;
    case 'ar_invoice':
      return `/sales/ar-invoices/${no}`;
    case 'sales_return':
      return `/sales/sales-returns/${no}`;
    case 'goods_return':
      return `/purchasing/goods-returns/${no}`;
    case 'opening_stock':
      return `/inventory/opening-stock/${no}`;
    case 'stock_transfer':
      return `/inventory/transfers?q=${no}`;
    case 'stock_adjustment':
      return `/inventory/stock-reconciliation?q=${no}`;
    default:
      return null;
  }
}
