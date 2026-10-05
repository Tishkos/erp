/**
 * ISS-20261004-001 — a B/L created from the Bills of Lading list saved with no
 * containers and said nothing: the list's form PASTES the numbers into one
 * box, the action read only the table the other two forms send.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blContainers, containerRows } from '../../src/app/(app)/payables/shipments/bl-form';

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
};

describe('the containers of a new B/L, in whichever way its form asked for them', () => {
  it('the list screen: the pasted box, its one size/type and the spread', () => {
    expect(
      blContainers(
        form({ bl_no: 'MEDU1', containers: 'MSCU1234566\nTGHU7654320, CAIU2345678', size_type: ' 40hc ', spread_lines: '1' }),
      ),
    ).toEqual({ containers: 'MSCU1234566\nTGHU7654320, CAIU2345678', sizeType: '40hc', spreadLines: true });
  });

  it('an unticked spread is off, an empty size/type is none — and no empty table is sent in their place', () => {
    const read = blContainers(form({ bl_no: 'MEDU1', containers: 'MSCU1234566', size_type: '' }));
    expect(read).toEqual({ containers: 'MSCU1234566', sizeType: null, spreadLines: false });
    // An empty `containerRows` is what made the service ignore the paste.
    expect('containerRows' in read).toBe(false);
  });

  it('the table: a row per container, an untyped row left out, and the paste not read', () => {
    const read = blContainers(
      form({
        row_count: '3',
        model_count: '1',
        model_0: 'line-1',
        container_no_0: 'MSCU1234566',
        size_type_0: '40HC',
        seal_no_0: 'SL-1',
        qty_0_0: '1,250.5',
        container_no_1: '',
        container_no_2: 'TGHU7654320',
      }),
    );
    expect(read).toEqual({
      containerRows: [
        { containerNo: 'MSCU1234566', sizeType: '40HC', sealNo: 'SL-1', quantities: { 'line-1': 1_250_500_000n } },
        { containerNo: 'TGHU7654320', sizeType: null, sealNo: null, quantities: { 'line-1': null } },
      ],
    });
    expect(containerRows(form({ row_count: '0' }))).toEqual([]);
  });

  it('every form that creates a B/L sends one of the two, and the action reads both', () => {
    const source = (path: string) => readFileSync(resolve(__dirname, '../../src/app/(app)/payables', path), 'utf8');
    expect(source('shipments/actions.ts')).toContain('...blContainers(formData)');
    // The list's form pastes; the import's own page sends the table.
    expect(source('shipments/page.tsx')).toMatch(/name="containers"/);
    expect(source('[payableNo]/page.tsx')).toMatch(/<Form action=\{createBlAction\}>[\s\S]*?<ContainerRowsGrid/);
  });
});
