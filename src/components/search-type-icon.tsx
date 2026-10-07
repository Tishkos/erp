import type { LucideIcon } from 'lucide-react';
import {
  Anchor,
  ArrowRight,
  Banknote,
  BookOpen,
  Container,
  FileBadge,
  FileText,
  FolderKanban,
  HandCoins,
  IdCard,
  Landmark,
  ListTodo,
  NotebookPen,
  Package,
  PackageCheck,
  PanelsTopLeft,
  Paperclip,
  PiggyBank,
  Receipt,
  ReceiptText,
  RotateCcw,
  Search,
  Send,
  Ship,
  ShoppingCart,
  Stamp,
  Store,
  TriangleAlert,
  UsersRound,
  Warehouse,
} from 'lucide-react';
import { cn } from '@/components/intent/cn';

/**
 * What each kind of search result looks like: one lucide icon per record type
 * (`search.types.<key>`), shared by the palette (Ctrl/⌘ K) and the /search
 * page so the two draw a supplier, an invoice or a container the same way.
 * A type without an entry (a module that registered its own) is a document.
 */
const ICONS: Readonly<Record<string, LucideIcon>> = {
  customer: UsersRound,
  supplier: Store,
  employee: IdCard,
  item: Package,
  warehouse: Warehouse,
  bank_cash_account: Landmark,
  chart_of_account: BookOpen,
  project: FolderKanban,
  ap_invoice: ReceiptText,
  ar_invoice: Receipt,
  supplier_payment: Banknote,
  customer_receipt: HandCoins,
  payment_application: Send,
  purchase_order: ShoppingCart,
  goods_receipt: PackageCheck,
  sales_return: RotateCcw,
  journal_entry: NotebookPen,
  bank_loan: PiggyBank,
  payable: Ship,
  bill_of_lading: Anchor,
  shipment_container: Container,
  customs_pd: Stamp,
  customs_declaration: FileBadge,
  attachment: Paperclip,
  screen: PanelsTopLeft,
  task: ListTodo,
  exception: TriangleAlert,
  // The palette's own rows: "see more of this group", "see all results".
  more: ArrowRight,
  all: Search,
};

export function searchTypeIcon(key: string): LucideIcon {
  return ICONS[key] ?? FileText;
}

/** The type's icon in a small rounded tile, the way the palette and the results page lead a row. */
export function SearchTypeIcon({ type, className }: { readonly type: string; readonly className?: string }) {
  const Icon = searchTypeIcon(type);
  return (
    <span
      aria-hidden="true"
      className={cn('grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-bg text-muted-fg', className)}
      data-search-type={type}
    >
      <Icon className={cn('size-4', type === 'more' && 'rtl:-scale-x-100')} />
    </span>
  );
}
