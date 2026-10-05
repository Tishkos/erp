import { parseQuantity } from '@/server/domain/uom';
import type { ContainerRowInput } from '@/server/services/shipments';

/**
 * What a B/L form says about its containers. Two forms create a B/L and they
 * do not ask the same way: the import's own page and "Add containers" send a
 * TABLE (a row per container — `ContainerRowsGrid`), the Bills of Lading list
 * sends a PASTED box of numbers with one size/type for all of them and the
 * choice to spread the order over them. Read here, apart from the actions, so
 * that it can be tested: an action that read only the table saved a B/L from
 * the list with no containers and said nothing (ISS-20261004-001).
 */
const text = (form: FormData, name: string): string => String(form.get(name) ?? '');

export const quantity = (value: string) => {
  const cleaned = value.replace(/[,\s]/g, '');
  if (!cleaned) return 0n;
  if (!/^\d+(\.\d{1,6})?$/.test(cleaned)) throw new Error(`"${value}" is not a quantity.`);
  return parseQuantity(cleaned);
};

/**
 * IM2 — the B/L's containers table: a row per container (number, size/type,
 * seal) and per model what it carries; a cell left empty is not typed.
 */
export function containerRows(formData: FormData): ContainerRowInput[] {
  const rowCount = Number(text(formData, 'row_count')) || 0;
  const modelCount = Number(text(formData, 'model_count')) || 0;
  const models = Array.from({ length: modelCount }, (_, m) => text(formData, `model_${m}`));
  const rows: ContainerRowInput[] = [];
  for (let index = 0; index < rowCount; index += 1) {
    const containerNo = text(formData, `container_no_${index}`).trim();
    const quantities: Record<string, bigint | null> = {};
    let any = false;
    for (const [m, key] of models.entries()) {
      const raw = text(formData, `qty_${index}_${m}`).trim();
      quantities[key] = raw ? quantity(raw) : null;
      if (raw) any = true;
    }
    if (!containerNo && !any && !text(formData, `seal_no_${index}`).trim()) continue;
    rows.push({
      containerNo,
      sizeType: text(formData, `size_type_${index}`) || null,
      sealNo: text(formData, `seal_no_${index}`) || null,
      quantities,
    });
  }
  return rows;
}

export type BlContainers =
  | { readonly containerRows: ContainerRowInput[] }
  | { readonly containers: string; readonly sizeType: string | null; readonly spreadLines: boolean };

/** The containers of a new B/L, in whichever of the two ways its form asked for them. */
export function blContainers(formData: FormData): BlContainers {
  if (formData.has('row_count')) return { containerRows: containerRows(formData) };
  return {
    containers: text(formData, 'containers'),
    sizeType: text(formData, 'size_type').trim() || null,
    spreadLines: formData.get('spread_lines') !== null,
  };
}
