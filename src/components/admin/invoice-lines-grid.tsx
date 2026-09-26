'use client';

import { useRouter } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react';
import styles from './admin.module.css';
import { PAIRED_CHOICE } from './paired-picker';

/**
 * The lines of an invoice, typed straight into the grid.
 *
 * The Journal Entry's grid, for a document that bills rather than posts (by
 * direction, 2026-09-16). There is no "Add line": the table always carries one
 * empty row at the foot, so filling the current line opens the next one, and a
 * person keeps going until they stop. A row is dropped with the ✕ beside it.
 *
 * It is the same grid in two places, because it is the same act:
 *
 *   raising one   the rows are form fields, and the whole document — header,
 *                 lines and all — is written when the button is pressed. There
 *                 is no invoice yet for a line to be saved against.
 *   correcting a  the invoice exists, so each row saves itself the moment it
 *   draft         is complete and left, and the server's copy comes back on
 *                 the refresh that follows.
 *
 * Passing `live` chooses the second. Everything it enforces is enforced again
 * in the service — a line the domain refuses is refused there, and the refusal
 * is shown on the row it concerns.
 */

export interface LineItem {
  readonly code: string;
  readonly name: string;
  /** The item's own unit, sent with the line rather than assumed to be each. */
  readonly uomCode?: string | null;
  /** Whose stock this line draws from; empty when the item has no links. */
  readonly suppliers?: readonly {
    readonly id: string;
    readonly label: string;
    readonly purchasePriceIqd?: string | null;
  }[];
  readonly defaultUnitPriceIqd?: string | null;
}

export interface LineWarehouse {
  readonly code: string;
  readonly name: string;
}

/** A line the invoice already carries. */
export interface SavedInvoiceLine {
  readonly id: string;
  readonly lineNo: number;
  readonly itemCode: string;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly discount: string;
  readonly supplierId: string;
  readonly warehouseCode: string;
}

interface Outcome {
  readonly ok: boolean;
  readonly error?: string;
}

/** Correcting a draft: the document exists, so the rows save themselves. */
export interface LiveLines {
  readonly documentId: string;
  readonly documentNo: string;
  readonly lines: readonly SavedInvoiceLine[];
  readonly save: (formData: FormData) => Promise<Outcome>;
  readonly remove: (formData: FormData) => Promise<Outcome>;
}

export interface InvoiceLineLabels {
  readonly itemCode: string;
  readonly itemName: string;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly discount: string;
  readonly total: string;
  readonly supplier: string;
  readonly warehouse: string;
  readonly anySupplier: string;
  readonly chooseItem: string;
  readonly remove: string;
  readonly documentTotal: string;
  readonly saving: string;
  readonly saveFailed: string;
  readonly resizeColumn: string;
  readonly checkingStock: string;
  readonly stockUnavailable: string;
  readonly availableStock: string;
  readonly availabilityHint: string;
}

interface Row {
  readonly key: string;
  /** A saved line's id, or null while the row is only on screen. */
  lineId: string | null;
  itemCode: string;
  /**
   * What is in the Item Name box.
   *
   * Its own field rather than the chosen item's name, because block 5 lets a
   * person type the name to find the code. Deriving it from the code would
   * clear the box on every keystroke that had not yet matched an item, which
   * makes the field impossible to type into.
   */
  itemName: string;
  quantity: string;
  unitPrice: string;
  discount: string;
  supplierId: string;
  warehouseCode: string;
  /** Why the server refused it, shown on the row. */
  error: string | null;
  /** Something changed since it was last saved. */
  dirty: boolean;
  /** The price was typed rather than copied from the item's defaults. */
  priceEdited: boolean;
  saving: boolean;
  availabilityKey: string;
  availability: string | null;
  availabilityPending: boolean;
  availabilityError: boolean;
  /** A new row the server has accepted; its own copy arrives on the refresh. */
  settled: boolean;
}

/** Empty rows drawn under the lines — an accountant reads them as room left. */
const FILLER_ROWS = 2;

/**
 * The columns, in the order they are drawn. The keys are the grid's own — they
 * name a boundary a person can drag and a width that is remembered, so they
 * must stay stable even if a heading is renamed or translated.
 */
const COLUMN_KEYS = [
  'index',
  'code',
  'name',
  'qty',
  'price',
  'discount',
  'total',
  'supplier',
  'warehouse',
  'remove',
] as const;
type ColumnKey = (typeof COLUMN_KEYS)[number];

/** The line number and the ✕ are what they are; the rest are the person's. */
const FIXED_COLUMNS: readonly ColumnKey[] = ['index', 'remove'];

/** Narrow enough to tuck a column away, wide enough to still be a column. */
const MIN_COLUMN_PX = 40;

type ColumnWidths = Partial<Record<ColumnKey, number>>;

/** Only keys this grid knows, only positive numbers — a stored preference is
 *  input like any other, and an old or hand-edited one must not break a
 *  screen. */
function readWidths(raw: string | null): ColumnWidths {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: ColumnWidths = {};
    for (const key of COLUMN_KEYS) {
      const value = (parsed as Record<string, unknown>)[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= MIN_COLUMN_PX) {
        out[key] = Math.round(value);
      }
    }
    return out;
  } catch {
    return {};
  }
}

let counter = 0;
const blank = (warehouseCode: string): Row => ({
  key: `line-${(counter += 1)}`,
  lineId: null,
  itemCode: '',
  itemName: '',
  quantity: '',
  unitPrice: '',
  discount: '',
  supplierId: '',
  warehouseCode,
  error: null,
  dirty: false,
  priceEdited: false,
  saving: false,
  availabilityKey: '',
  availability: null,
  availabilityPending: false,
  availabilityError: false,
  settled: false,
});

/** "2400.0000" reads as 2400; a person did not type the zeros. */
function trimZeros(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/, '') : value;
}

const fromLine = (line: SavedInvoiceLine, nameOf: (code: string) => string): Row => ({
  key: line.id,
  lineId: line.id,
  itemCode: line.itemCode,
  itemName: nameOf(line.itemCode),
  quantity: trimZeros(line.quantity),
  unitPrice: trimZeros(line.unitPrice),
  discount: Number(line.discount) === 0 ? '' : trimZeros(line.discount),
  supplierId: line.supplierId,
  warehouseCode: line.warehouseCode,
  error: null,
  dirty: false,
  priceEdited: true,
  saving: false,
  availabilityKey: '',
  availability: null,
  availabilityPending: false,
  availabilityError: false,
  settled: false,
});

const written = (row: Row) =>
  row.itemCode !== '' ||
  row.itemName !== '' ||
  row.quantity !== '' ||
  row.unitPrice !== '' ||
  row.discount !== '';

/** A row is complete when it names an item, an amount and somewhere to put it. */
const complete = (row: Row) =>
  row.itemCode !== '' &&
  row.quantity.trim() !== '' &&
  row.unitPrice.trim() !== '' &&
  row.warehouseCode !== '';

/** Quantity × price less the discount — the sponsor's Total Price, per row. */
const totalOf = (row: Row) => {
  const quantity = Number(row.quantity);
  const price = Number(row.unitPrice);
  const discount = Number(row.discount || 0);
  if (!Number.isFinite(quantity) || !Number.isFinite(price) || !Number.isFinite(discount)) return 0;
  return quantity * price - discount;
};

export function InvoiceLinesGrid({
  items,
  warehouses,
  mode,
  purchaseSupplierId,
  purchaseSupplierField,
  loadAvailability,
  showSupplier = false,
  searchItems = false,
  widthsKey,
  labels,
  currency,
  locale,
  headingId,
  live,
}: {
  readonly items: readonly LineItem[];
  readonly warehouses: readonly LineWarehouse[];
  readonly mode: 'purchase' | 'sale';
  readonly purchaseSupplierId?: string | undefined;
  readonly purchaseSupplierField?: string | undefined;
  readonly loadAvailability?: ((input: {
    itemCode: string;
    warehouseCode: string;
    supplierId?: string | null;
  }) => Promise<{ ok: boolean; value?: { onHand: string; available: string }; error?: string }>) | undefined;
  /** The Sales Invoice's Supplier column: whose stock the line is sold from. */
  readonly showSupplier?: boolean;
  /**
   * Block 5 — *"Item Code (searchable); Item Name (searchable)"*. Typed into
   * over a list rather than chosen from a drop-down, and either one fills the
   * other. Block 4 asks only for the name to follow the code, so its grid
   * leaves this off and the name is shown rather than typed.
   */
  readonly searchItems?: boolean;
  /**
   * Where this grid's column widths are kept. It carries the user, so two
   * people sharing a browser do not inherit each other's layout, and the
   * document type, so a purchase invoice and a sales invoice are remembered
   * apart. Omit it and the columns are still draggable — just not remembered.
   */
  readonly widthsKey?: string;
  readonly labels: InvoiceLineLabels;
  readonly currency: string;
  readonly locale: string;
  readonly headingId: string;
  /** Present on a draft that already exists: each row saves itself. */
  readonly live?: LiveLines | undefined;
}) {
  const router = useRouter();
  const codeList = useId();
  const nameList = useId();
  const [pending, startTransition] = useTransition();
  const defaultWarehouse = warehouses[0]?.code ?? '';

  const itemsByCode = useMemo(() => new Map(items.map((item) => [item.code, item])), [items]);
  const itemsByName = useMemo(() => new Map(items.map((item) => [item.name, item])), [items]);
  const nameOf = useCallback(
    (code: string) => itemsByCode.get(code)?.name ?? '',
    [itemsByCode],
  );

  const [rows, setRows] = useState<Row[]>(() =>
    live && live.lines.length > 0
      ? [...live.lines.map((line) => fromLine(line, nameOf)), blank(defaultWarehouse)]
      : [blank(defaultWarehouse)],
  );
  // Rows in flight: a second save of the same row waits for the first.
  const saving = useRef(new Set<string>());
  const table = useRef<HTMLTableElement>(null);
  const [chosenPurchaseSupplier, setChosenPurchaseSupplier] = useState(
    purchaseSupplierId ?? '',
  );
  const availabilityRequests = useRef(new Map<string, { key: string }>());

  /* ── Column widths a person set by hand ─────────────────────────────────
     Read after mount, never during render: the server has no localStorage, so
     seeding state from it would render one width on the server and another in
     the browser. The grid draws at its stylesheet widths for the first paint
     and settles into the person's own straight after. */
  const [widths, setWidths] = useState<ColumnWidths>({});
  const liveWidths = useRef<ColumnWidths>({});
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{ key: ColumnKey; from: number; was: number; rtl: boolean } | null>(null);

  useEffect(() => {
    if (!widthsKey) return;
    const stored = readWidths(window.localStorage.getItem(widthsKey));
    liveWidths.current = stored;
    setWidths(stored);
  }, [widthsKey]);

  const keepWidths = useCallback(
    (next: ColumnWidths) => {
      liveWidths.current = next;
      setWidths(next);
      if (!widthsKey) return;
      // A refusal to store — a full or locked profile — must not cost the
      // width on screen, so it is swallowed rather than surfaced.
      try {
        window.localStorage.setItem(widthsKey, JSON.stringify(next));
      } catch {
        /* the layout still holds for this visit */
      }
    },
    [widthsKey],
  );

  const grip = (key: ColumnKey) => ({
    onPointerDown: (event: React.PointerEvent<HTMLSpanElement>) => {
      // Left button only, and never let the press reach the heading.
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const cell = event.currentTarget.closest('th');
      const was = cell ? cell.getBoundingClientRect().width : MIN_COLUMN_PX;
      drag.current = {
        key,
        from: event.clientX,
        was,
        // In Arabic the columns run the other way, so dragging right must
        // narrow the column rather than widen it.
        rtl: cell ? getComputedStyle(cell).direction === 'rtl' : false,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      setResizing(true);
    },
    onPointerMove: (event: React.PointerEvent<HTMLSpanElement>) => {
      const held = drag.current;
      if (!held) return;
      const travelled = event.clientX - held.from;
      const next = Math.max(
        MIN_COLUMN_PX,
        Math.round(held.was + (held.rtl ? -travelled : travelled)),
      );
      // The pointer moves far more often than a width needs storing, so the
      // drag paints from state and writes once, on release.
      const merged = { ...liveWidths.current, [held.key]: next };
      liveWidths.current = merged;
      setWidths(merged);
    },
    onPointerUp: (event: React.PointerEvent<HTMLSpanElement>) => {
      if (!drag.current) return;
      drag.current = null;
      setResizing(false);
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        /* the capture was already surrendered */
      }
      keepWidths(liveWidths.current);
    },
    onPointerCancel: () => {
      drag.current = null;
      setResizing(false);
      keepWidths(liveWidths.current);
    },
    /** A boundary put back: the column returns to the width the screen chose. */
    onDoubleClick: () => {
      const { [key]: _dropped, ...rest } = liveWidths.current;
      keepWidths(rest);
    },
  });

  const widthOf = (key: ColumnKey) => {
    const set = widths[key];
    return set === undefined ? undefined : { inlineSize: `${set}px` };
  };

  useEffect(() => {
    if (!purchaseSupplierField) return;
    const form = table.current?.closest('form');
    if (!form) return;
    const read = () => {
      const field = form.elements.namedItem(purchaseSupplierField);
      setChosenPurchaseSupplier(field instanceof HTMLInputElement ? field.value : '');
    };
    const chosen = (event: Event) => {
      const detail = (event as CustomEvent<{ name: string; value: string }>).detail;
      if (detail.name === purchaseSupplierField) setChosenPurchaseSupplier(detail.value);
    };
    read();
    form.addEventListener(PAIRED_CHOICE, chosen);
    return () => form.removeEventListener(PAIRED_CHOICE, chosen);
  }, [purchaseSupplierField]);

  const defaultPriceFor = useCallback(
    (item: LineItem | undefined) => {
      if (!item) return '';
      if (mode === 'sale') return item.defaultUnitPriceIqd ?? '';
      if (!chosenPurchaseSupplier) return '';
      return (
        item.suppliers?.find((supplier) => supplier.id === chosenPurchaseSupplier)
          ?.purchasePriceIqd ?? ''
      );
    },
    [chosenPurchaseSupplier, mode],
  );

  useEffect(() => {
    if (mode !== 'purchase') return;
    setRows((current) =>
      current.map((row) =>
        row.lineId === null && !row.priceEdited && row.itemCode
          ? { ...row, unitPrice: defaultPriceFor(itemsByCode.get(row.itemCode)) }
          : row,
      ),
    );
  }, [chosenPurchaseSupplier, defaultPriceFor, itemsByCode, mode]);

  const savedLines = live?.lines;

  // When the server's lines change (a save landed, a line was removed), take
  // its version of every saved row that is not mid-edit, and keep whatever is
  // still being typed. A new row the server has just accepted is dropped here:
  // its own copy is in `lines` now.
  useEffect(() => {
    if (!savedLines) return;
    setRows((current) => {
      const mine = new Map(current.filter((row) => row.lineId).map((row) => [row.lineId!, row]));
      const saved = savedLines.map((line) => {
        const local = mine.get(line.id);
        if (local && (local.dirty || local.saving)) return local;
        // The server's version of the line, with what the browser knows that
        // the server does not: how much of the item is available. Taking the
        // row wholesale would blank it on every refresh, and the request is
        // never made again — the key it was made under has not changed — so
        // the figure would disappear for good the first time a line saved.
        return {
          ...fromLine(line, nameOf),
          availabilityKey: local?.availabilityKey ?? '',
          availability: local?.availability ?? null,
          availabilityPending: local?.availabilityPending ?? false,
          availabilityError: local?.availabilityError ?? false,
        };
      });
      const unsaved = current.filter((row) => row.lineId === null && !row.settled);
      return [...saved, ...(unsaved.length > 0 ? unsaved : [blank(defaultWarehouse)])];
    });
  }, [savedLines, defaultWarehouse, nameOf]);

  useEffect(() => {
    if (!loadAvailability) return;
    for (const row of rows) {
      const supplierId = mode === 'sale' ? row.supplierId || null : null;
      const key = row.itemCode && row.warehouseCode
        ? `${row.itemCode}\u0000${row.warehouseCode}\u0000${supplierId ?? ''}`
        : '';
      if (availabilityRequests.current.get(row.key)?.key === key) continue;
      const marker = { key };
      availabilityRequests.current.set(row.key, marker);
      if (!key) {
        setRows((current) =>
          current.map((currentRow) =>
            currentRow.key === row.key
              ? {
                  ...currentRow,
                  availabilityKey: '',
                  availability: null,
                  availabilityPending: false,
                  availabilityError: false,
                }
              : currentRow,
          ),
        );
        continue;
      }
      setRows((current) =>
        current.map((currentRow) =>
          currentRow.key === row.key &&
          currentRow.itemCode === row.itemCode &&
          currentRow.warehouseCode === row.warehouseCode
            ? {
                ...currentRow,
                availabilityKey: key,
                availability: null,
                availabilityPending: true,
                availabilityError: false,
              }
            : currentRow,
        ),
      );
      void loadAvailability({
        itemCode: row.itemCode,
        warehouseCode: row.warehouseCode,
        supplierId,
      }).then((outcome) => {
        if (availabilityRequests.current.get(row.key) !== marker) return;
        setRows((current) =>
          current.map((currentRow) =>
            currentRow.key === row.key && currentRow.availabilityKey === key
              ? {
                  ...currentRow,
                  availability: outcome.ok ? (outcome.value?.available ?? null) : null,
                  availabilityPending: false,
                  availabilityError: !outcome.ok,
                }
              : currentRow,
          ),
        );
      });
    }
  }, [loadAvailability, mode, rows]);

  const money = useMemo(
    () =>
      new Intl.NumberFormat(locale, {
        style: 'currency',
        currency,
        currencyDisplay: 'code',
        // The dinar has no subunit in practice: IQD 2,000, never IQD 2,000.00.
        minimumFractionDigits: currency === 'IQD' ? 0 : 2,
        maximumFractionDigits: currency === 'IQD' ? 0 : 2,
      }),
    [locale, currency],
  );

  /** One empty row at the foot, always. Filling the last one opens the next. */
  const settle = (next: Row[]): Row[] => {
    const last = next[next.length - 1];
    if (!last) return [blank(defaultWarehouse)];
    return written(last) ? [...next, blank(defaultWarehouse)] : next;
  };

  const patch = (key: string, change: Partial<Row>) =>
    setRows((current) =>
      settle(
        current.map((row) =>
          row.key === key ? { ...row, ...change, dirty: true, error: null } : row,
        ),
      ),
    );

  /** A refusal, kept on the row it concerns. Typing into the row clears it. */
  const refuse = (key: string, error: string) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, error } : row)));

  // Changing the item changes whose stock the line may draw from, so a supplier
  // chosen for the previous item is cleared rather than left pointing at a link
  // this item does not have.
  // "Selecting the Item Code brings the Item Name, and selecting the Item Name
  // brings the Item Code" (block 5). One is typed, the other follows — and
  // until what is typed names an item, what is typed is what stands.
  const chooseItem = (key: string, itemCode: string) => {
    const match = itemsByCode.get(itemCode);
    setRows((current) =>
      settle(
        current.map((row) =>
          row.key === key
            ? {
                ...row,
                itemCode,
                itemName: match ? match.name : row.itemName,
                quantity: match && row.quantity.trim() === '' ? '1' : row.quantity,
                unitPrice: match ? defaultPriceFor(match) : row.unitPrice,
                priceEdited: false,
                supplierId: '',
                dirty: true,
                error: null,
              }
            : row,
        ),
      ),
    );
  };

  const chooseByName = (key: string, itemName: string) => {
    const match = itemsByName.get(itemName);
    setRows((current) =>
      settle(
        current.map((row) =>
          row.key === key
            ? {
                ...row,
                itemName,
                itemCode: match ? match.code : row.itemCode,
                quantity: match && row.quantity.trim() === '' ? '1' : row.quantity,
                unitPrice: match ? defaultPriceFor(match) : row.unitPrice,
                priceEdited: match ? false : row.priceEdited,
                supplierId: match ? '' : row.supplierId,
                dirty: true,
                error: null,
              }
            : row,
        ),
      ),
    );
  };

  const commit = (row: Row) => {
    if (
      !live ||
      !row.dirty ||
      !complete(row) ||
      row.saving ||
      row.settled ||
      saving.current.has(row.key)
    )
      return;
    saving.current.add(row.key);
    setRows((current) =>
      current.map((r) => (r.key === row.key ? { ...r, saving: true } : r)),
    );

    const form = new FormData();
    form.set('id', live.documentId);
    form.set('invoice_no', live.documentNo);
    if (row.lineId) form.set('lineId', row.lineId);
    form.set('itemCode', row.itemCode);
    form.set('quantity', row.quantity.trim());
    form.set('unitPrice', row.unitPrice.trim());
    form.set('discount', row.discount.trim());
    form.set('warehouseCode', row.warehouseCode);
    form.set('supplierId', row.supplierId);

    startTransition(async () => {
      try {
        const outcome = await live.save(form);
        setRows((current) =>
          current.map((r) =>
            r.key !== row.key
              ? r
              : outcome.ok
                ? { ...r, saving: false, dirty: false, error: null, settled: r.lineId === null }
                : { ...r, saving: false, error: outcome.error ?? '' },
          ),
        );
        if (outcome.ok) router.refresh();
      } catch {
        setRows((current) =>
          current.map((r) =>
            r.key === row.key ? { ...r, saving: false, error: labels.saveFailed } : r,
          ),
        );
      } finally {
        saving.current.delete(row.key);
      }
    });
  };

  const drop = (row: Row) => {
    if (row.saving || row.settled || saving.current.has(row.key)) return;
    if (!live || row.lineId === null) {
      setRows((current) => settle(current.filter((r) => r.key !== row.key)));
      return;
    }
    const form = new FormData();
    form.set('id', live.documentId);
    form.set('invoice_no', live.documentNo);
    form.set('lineId', row.lineId);
    startTransition(async () => {
      const outcome = await live.remove(form);
      if (outcome.ok) router.refresh();
      // Not `patch`: that is for something a person typed, and it clears the
      // row's error on the way through — which would swallow this one.
      else refuse(row.key, outcome.error ?? '');
    });
  };

  const filled = rows.filter(written);
  const total = filled.reduce((sum, row) => sum + totalOf(row), 0);
  const columns = showSupplier ? 10 : 9;

  /** Only a form posts its rows; a live grid has already sent them. */
  const field = (name: string, index: number) => (live ? {} : { name: `${name}_${index}` });

  return (
    <>
      <table
        aria-labelledby={headingId}
        className={`${styles.sapTable} ${styles.sapLineGrid}`}
        data-resizing={resizing ? 'true' : undefined}
        ref={table}
      >
        {/* Declared, not discovered. Every column but the item's name takes the
            width its own contents need; the name absorbs what is left, so the
            grid scales with the window rather than with the longest note in a
            cell. The widths are classes rather than inline styles because they
            change with the viewport, and a media query cannot reach past a
            style attribute. Keep in step with `columns` above. */}
        <colgroup>
          <col className={styles.colIndex} style={widthOf('index')} />
          <col className={styles.colCode} style={widthOf('code')} />
          <col className={styles.colName} style={widthOf('name')} />
          <col className={styles.colQty} style={widthOf('qty')} />
          <col className={styles.colPrice} style={widthOf('price')} />
          <col className={styles.colDiscount} style={widthOf('discount')} />
          <col className={styles.colTotal} style={widthOf('total')} />
          {showSupplier ? (
            <col className={styles.colSupplier} style={widthOf('supplier')} />
          ) : null}
          <col className={styles.colWarehouse} style={widthOf('warehouse')} />
          <col className={styles.colRemove} style={widthOf('remove')} />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">
              {labels.itemCode}
              <span
                aria-hidden="true"
                className={styles.sapColGrip}
                data-dragging={resizing ? 'true' : undefined}
                title={labels.resizeColumn}
                {...grip('code')}
              />
            </th>
            <th scope="col">
              {labels.itemName}
              <span
                aria-hidden="true"
                className={styles.sapColGrip}
                data-dragging={resizing ? 'true' : undefined}
                title={labels.resizeColumn}
                {...grip('name')}
              />
            </th>
            <th className={styles.sapNum} scope="col">
              {labels.quantity}
              <span
                aria-hidden="true"
                className={styles.sapColGrip}
                data-dragging={resizing ? 'true' : undefined}
                title={labels.resizeColumn}
                {...grip('qty')}
              />
            </th>
            <th className={styles.sapNum} scope="col">
              {labels.unitPrice}
              <span
                aria-hidden="true"
                className={styles.sapColGrip}
                data-dragging={resizing ? 'true' : undefined}
                title={labels.resizeColumn}
                {...grip('price')}
              />
            </th>
            <th className={styles.sapNum} scope="col">
              {labels.discount}
              <span
                aria-hidden="true"
                className={styles.sapColGrip}
                data-dragging={resizing ? 'true' : undefined}
                title={labels.resizeColumn}
                {...grip('discount')}
              />
            </th>
            <th className={styles.sapNum} scope="col">
              {labels.total}
              <span
                aria-hidden="true"
                className={styles.sapColGrip}
                data-dragging={resizing ? 'true' : undefined}
                title={labels.resizeColumn}
                {...grip('total')}
              />
            </th>
            {showSupplier ? (
              <th scope="col">
                {labels.supplier}
                <span
                  aria-hidden="true"
                  className={styles.sapColGrip}
                  data-dragging={resizing ? 'true' : undefined}
                  title={labels.resizeColumn}
                  {...grip('supplier')}
                />
              </th>
            ) : null}
            <th scope="col">
              {labels.warehouse}
              <span
                aria-hidden="true"
                className={styles.sapColGrip}
                data-dragging={resizing ? 'true' : undefined}
                title={labels.resizeColumn}
                {...grip('warehouse')}
              />
            </th>
            <th aria-label={labels.remove} />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const item = itemsByCode.get(row.itemCode);
            const suppliers = item?.suppliers ?? [];
            const live_ = written(row);
            const locked = row.saving || row.settled;
            const last = index === rows.length - 1;
            return (
              <tr
                aria-busy={locked}
                className={last ? styles.sapEntryRow : undefined}
                data-error={row.error ? 'true' : undefined}
                key={row.key}
                onBlur={(event) => {
                  // Only when focus leaves the row altogether, not when it
                  // moves from one cell of it to the next.
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    commit(row);
                  }
                }}
              >
                <td>
                  <bdi dir="ltr">{index + 1}</bdi>
                </td>
                <td className={styles.sapAccountCell}>
                  {searchItems ? (
                    <input
                      aria-label={labels.itemCode}
                      autoComplete="off"
                      dir="ltr"
                      disabled={locked}
                      list={codeList}
                      onChange={(event) => chooseItem(row.key, event.target.value)}
                      // An invoice bills for something: on the form that raises
                      // one, the first row names an item or there is no document.
                      required={!live && index === 0}
                      value={row.itemCode}
                      {...field('item_code', index)}
                    />
                  ) : (
                    <select
                      aria-label={labels.itemCode}
                      dir="ltr"
                      disabled={locked}
                      onChange={(event) => chooseItem(row.key, event.target.value)}
                      required={!live && index === 0}
                      value={row.itemCode}
                      {...field('item_code', index)}
                    >
                      <option value="">{labels.chooseItem}</option>
                      {items.map((option) => (
                        <option key={option.code} value={option.code}>
                          {option.code}
                        </option>
                      ))}
                    </select>
                  )}
                  {/* The item's own unit travels with the line. Without it every
                      line is billed in "each", whatever the item is measured in. */}
                  {live ? null : (
                    <input name={`uom_code_${index}`} type="hidden" value={item?.uomCode ?? ''} />
                  )}
                  {locked ? <span className={styles.sapCellNote}>{labels.saving}</span> : null}
                  {row.error ? (
                    <span className={styles.sapRowError} role="alert">
                      {row.error}
                    </span>
                  ) : null}
                </td>
                {/* Block 4: shown as soon as the code is chosen. Block 5: typed
                    into as well, and what is typed brings the code back. */}
                <td>
                  {searchItems ? (
                    <input
                      aria-label={labels.itemName}
                      autoComplete="off"
                      dir="auto"
                      disabled={locked}
                      list={nameList}
                      onChange={(event) => chooseByName(row.key, event.target.value)}
                      value={row.itemName}
                    />
                  ) : (
                    <bdi dir="auto">{item?.name ?? ''}</bdi>
                  )}
                </td>
                <td className={styles.sapNum}>
                  <input
                    aria-label={labels.quantity}
                    dir="ltr"
                    disabled={locked}
                    inputMode="decimal"
                    min={0}
                    onChange={(event) => patch(row.key, { quantity: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur();
                    }}
                    // Required the moment the row names an item: a line with an
                    // item and no quantity is somebody halfway through typing,
                    // and posting it as a zero would be worse than saying so.
                    required={!live && row.itemCode !== ''}
                    step="any"
                    type="number"
                    value={row.quantity}
                    {...field('quantity', index)}
                  />
                  {row.availabilityPending ? (
                    <span className={styles.sapCellNote}>{labels.checkingStock}</span>
                  ) : row.availabilityError ? (
                    <span className={styles.sapCellNote}>{labels.stockUnavailable}</span>
                  ) : row.availability !== null ? (
                    <span className={styles.sapCellNote} title={labels.availabilityHint}>
                      {labels.availableStock}: {row.availability} {item?.uomCode ?? ''}
                    </span>
                  ) : null}
                </td>
                <td className={styles.sapNum}>
                  <input
                    aria-label={labels.unitPrice}
                    dir="ltr"
                    disabled={locked}
                    inputMode="decimal"
                    min={0}
                    onChange={(event) =>
                      patch(row.key, { unitPrice: event.target.value, priceEdited: true })
                    }
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur();
                    }}
                    required={!live && row.itemCode !== ''}
                    step="any"
                    type="number"
                    value={row.unitPrice}
                    {...field('unit_price', index)}
                  />
                </td>
                <td className={styles.sapNum}>
                  <input
                    aria-label={labels.discount}
                    dir="ltr"
                    disabled={locked}
                    inputMode="decimal"
                    min={0}
                    onChange={(event) => patch(row.key, { discount: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur();
                    }}
                    step="any"
                    type="number"
                    value={row.discount}
                    {...field('discount', index)}
                  />
                </td>
                {/* Not a field: the line's total is its own three numbers, and a
                    fourth box holding the answer is a box that can disagree. */}
                <td className={styles.sapNum}>
                  <bdi dir="ltr">{live_ ? money.format(totalOf(row)) : ''}</bdi>
                </td>
                {showSupplier ? (
                  <td>
                    <select
                      aria-label={labels.supplier}
                      // Disabled rather than hidden when the item has no links:
                      // the column stays where the eye expects it, and the
                      // reason it is empty is the item, not a fault.
                      disabled={locked || suppliers.length === 0}
                      onChange={(event) => patch(row.key, { supplierId: event.target.value })}
                      value={row.supplierId}
                      {...field('supplier_id', index)}
                    >
                      {/* Blank is a real choice — the oldest stock of any supplier. */}
                      <option value="">{labels.anySupplier}</option>
                      {suppliers.map((supplier) => (
                        <option key={supplier.id} value={supplier.id}>
                          {supplier.label}
                        </option>
                      ))}
                    </select>
                  </td>
                ) : null}
                <td>
                  <select
                    aria-label={labels.warehouse}
                    disabled={locked}
                    onChange={(event) => patch(row.key, { warehouseCode: event.target.value })}
                    value={row.warehouseCode}
                    {...field('warehouse_code', index)}
                  >
                    {warehouses.map((house) => (
                      <option key={house.code} value={house.code}>
                        {house.code} · {house.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className={styles.sapRowRemove}>
                  {live_ ? (
                    <button
                      aria-label={labels.remove}
                      disabled={locked}
                      onClick={() => drop(row)}
                      title={labels.remove}
                      type="button"
                    >
                      ✕
                    </button>
                  ) : null}
                </td>
              </tr>
            );
          })}
          {Array.from({ length: FILLER_ROWS }, (_, i) => (
            <tr aria-hidden="true" className={styles.sapFiller} key={`filler-${i}`}>
              {Array.from({ length: columns }, (_, cell) => (
                <td key={cell} />
              ))}
            </tr>
          ))}
        </tbody>
        <tfoot>
          {/* What the document comes to, live, the way the journal sums its own
              grid as it is typed rather than after a round trip. */}
          <tr className={styles.sapTotalRow}>
            <td colSpan={6}>
              {labels.documentTotal}
              {pending ? <span className={styles.sapNote}> · {labels.saving}</span> : null}
            </td>
            <td aria-live="polite" className={styles.sapNum}>
              <bdi dir="ltr">{money.format(total)}</bdi>
            </td>
            <td colSpan={showSupplier ? 3 : 2} />
          </tr>
        </tfoot>
      </table>

      {searchItems ? (
        <>
          <datalist id={codeList}>
            {items.map((option) => (
              <option key={option.code} value={option.code} />
            ))}
          </datalist>
          <datalist id={nameList}>
            {items.map((option) => (
              <option key={option.code} value={option.name} />
            ))}
          </datalist>
        </>
      ) : null}

      {/* How many rows the action should read. The grid grows as it is typed,
          so the number cannot be a constant the two sides agree on in advance.
          A live grid has already sent each row and needs none of it. */}
      {live ? null : <input name="line_count" type="hidden" value={rows.length} />}
    </>
  );
}
