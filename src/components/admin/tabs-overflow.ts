/**
 * Which section tabs stay on the row, given the room there is (2026-10-06).
 *
 * Pure, so it is tested without a browser (`tests/unit/tabs-overflow.test.ts`);
 * `SectionTabsNav` measures the labels and the bar and asks this.
 *
 * Every tab fits: all of them stay. Otherwise the longest run from the start
 * that fits beside the More button — and the current tab always, in its own
 * place, so the reader never loses where they are; the run gives way to it
 * from its end. Returns the indexes that go behind More, in their order.
 */
export function overflowOf(
  widths: readonly number[],
  gap: number,
  room: number,
  moreWidth: number,
  current: number,
): number[] {
  const n = widths.length;
  const total = widths.reduce((sum, w) => sum + w, 0) + gap * Math.max(0, n - 1);
  if (total <= room + 0.5) return [];

  const budget = room - moreWidth - gap;
  const shown: number[] = [];
  let used = 0;
  for (let i = 0; i < n; i += 1) {
    const next = used + (shown.length ? gap : 0) + widths[i]!;
    if (next > budget + 0.5) break;
    shown.push(i);
    used = next;
  }
  if (current >= 0 && current < n && !shown.includes(current)) {
    const need = () => widths[current]! + (shown.length ? gap : 0);
    while (shown.length && used + need() > budget + 0.5) {
      const dropped = shown.pop()!;
      used -= widths[dropped]! + (shown.length ? gap : 0);
    }
    shown.push(current);
  }
  const kept = new Set(shown);
  const hidden: number[] = [];
  for (let i = 0; i < n; i += 1) if (!kept.has(i)) hidden.push(i);
  return hidden;
}
