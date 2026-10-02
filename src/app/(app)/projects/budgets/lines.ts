/**
 * The lines of a budget or change-order grid, read from the form: `wbs_<i>`
 * names the element of row i, `amount_<i>_<COST>` the cell under a cost
 * code. An empty or zero cell is no line.
 */
export function linesOf(form: FormData): { wbsCode: string; costCode: string; amountIqd: string }[] {
  const lines: { wbsCode: string; costCode: string; amountIqd: string }[] = [];
  const rows = new Map<string, string>();
  for (const [name, value] of form.entries()) {
    const m = /^wbs_(\d+)$/.exec(name);
    if (m) rows.set(m[1]!, String(value));
  }
  for (const [name, value] of form.entries()) {
    const m = /^amount_(\d+)_([A-Z0-9_-]+)$/.exec(name);
    if (!m) continue;
    const amount = String(value).trim();
    if (!amount || Number(amount) === 0) continue;
    const wbsCode = rows.get(m[1]!);
    if (!wbsCode) continue;
    lines.push({ wbsCode, costCode: m[2]!, amountIqd: amount });
  }
  return lines;
}

