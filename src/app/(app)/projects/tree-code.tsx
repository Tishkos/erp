import { CornerDownRight } from 'lucide-react';

/** One step in per level below the root (WBS levels run 1–5). */
const INDENT = ['', 'ps-4', 'ps-8', 'ps-12', 'ps-16'] as const;

/**
 * A WBS element's code where the tree is drawn — the WBS, the project record, the cost plan, progress and the
 * forecast. The level was a run of "· " typed in front of the code; it is an indent now, with a corner mark
 * before each element below the root (the Intent UI redesign, 2026-10-06). The code itself is unchanged.
 */
export function TreeCode({ level, code }: { readonly level: number; readonly code: string }) {
  const depth = Math.min(Math.max(level, 1), 5) - 1;
  return (
    <span className={`inline-flex items-center gap-1.5 ${INDENT[depth]}`}>
      {depth > 0 ? <CornerDownRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-fg rtl:-scale-x-100" /> : null}
      <bdi className={depth === 0 ? 'font-semibold' : undefined} dir="ltr">
        {code}
      </bdi>
    </span>
  );
}
