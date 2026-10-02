/**
 * The Project System's pure rules — REQ-PM-001 §5 (the coding mask and the
 * operative indicators), §6 (the status profile), and the roll-up every
 * report does over the WBS tree. No database: the shape of a code, which
 * transition is allowed, how a tree adds up.
 */

export class ProjectSystemError extends Error {
  readonly code = 'PROJECT_SYSTEM';
  constructor(
    readonly field: string,
    detail: string,
  ) {
    super(`${field}: ${detail}`);
    this.name = 'ProjectSystemError';
  }
}

// ---------------------------------------------------------------------------
// §5 — the coding mask: PRJ-HQ-2026-000004 → …-1 → …-1.2 → …-1.2.3
// ---------------------------------------------------------------------------

export const WBS_MAX_LEVEL = 5;

/** The code the mask gives the next child of `parent` (or the next root). */
export function nextWbsCode(projectCode: string, parentCode: string | null, siblings: readonly string[]): string {
  const prefix = parentCode ? `${parentCode}.` : `${projectCode}-`;
  const taken = siblings
    .filter((code) => code.startsWith(prefix))
    .map((code) => Number(code.slice(prefix.length)))
    .filter((n) => Number.isInteger(n) && n > 0);
  const next = taken.length === 0 ? 1 : Math.max(...taken) + 1;
  return `${prefix}${next}`;
}

/** Whether a typed code follows the mask under its parent, and its level. */
export function wbsCodeLevel(projectCode: string, parentCode: string | null, code: string): number {
  const prefix = parentCode ? `${parentCode}.` : `${projectCode}-`;
  if (!code.startsWith(prefix)) {
    throw new ProjectSystemError('code', `'${code}' must begin with '${prefix}' under ${parentCode ?? 'the project'} (the coding mask)`);
  }
  const tail = code.slice(prefix.length);
  if (!/^[1-9][0-9]{0,3}$/.test(tail)) {
    throw new ProjectSystemError('code', `'${code}' must end in a number after '${prefix}'`);
  }
  const level = code.slice(projectCode.length + 1).split('.').length;
  if (level > WBS_MAX_LEVEL) throw new ProjectSystemError('code', `the structure goes ${WBS_MAX_LEVEL} levels deep at most`);
  return level;
}

// ---------------------------------------------------------------------------
// §6 — the status profile on the existing enum
// ---------------------------------------------------------------------------

export type ProjectStatus = 'draft' | 'active' | 'on_hold' | 'closing' | 'closed';

export type ProjectKind = 'customer' | 'internal' | 'investment';

export type ProjectTransition = 'release' | 'hold' | 'resume' | 'technical_complete' | 'reopen' | 'close';

/** PS: CRTD → REL → (hold ⇄) → TECO → CLSD, and one reopen from TECO. */
export const TRANSITIONS: Readonly<Record<ProjectTransition, { readonly from: readonly ProjectStatus[]; readonly to: ProjectStatus }>> = {
  release: { from: ['draft'], to: 'active' },
  hold: { from: ['active'], to: 'on_hold' },
  resume: { from: ['on_hold'], to: 'active' },
  technical_complete: { from: ['active'], to: 'closing' },
  reopen: { from: ['closing'], to: 'active' },
  close: { from: ['closing'], to: 'closed' },
};

export function assertTransition(transition: ProjectTransition, from: ProjectStatus, projectCode: string): ProjectStatus {
  const rule = TRANSITIONS[transition];
  if (!rule.from.includes(from)) {
    throw new ProjectSystemError('status', `${projectCode} is ${from}; ${transition.replace('_', ' ')} is allowed from ${rule.from.join(' or ')} only`);
  }
  return rule.to;
}

/** What a status admits (§6): commitments, costs and issues are execution. */
export function admitsExecution(status: ProjectStatus): boolean {
  return status === 'active';
}

export function admitsStructureChange(status: ProjectStatus): boolean {
  return status === 'draft' || status === 'active' || status === 'on_hold';
}

// ---------------------------------------------------------------------------
// The roll-up over the tree
// ---------------------------------------------------------------------------

export interface WbsNode {
  readonly code: string;
  readonly parentCode: string | null;
  readonly level: number;
}

export interface WbsAmounts {
  budgetIqd: bigint;
  committedIqd: bigint;
  actualIqd: bigint;
}

/**
 * Each element's own amounts plus every descendant's. Children are summed
 * into their parents from the deepest level up, so a figure is counted once.
 */
export function rollUp(nodes: readonly WbsNode[], own: ReadonlyMap<string, WbsAmounts>): Map<string, WbsAmounts> {
  const totals = new Map<string, WbsAmounts>();
  for (const node of nodes) {
    const mine = own.get(node.code) ?? { budgetIqd: 0n, committedIqd: 0n, actualIqd: 0n };
    totals.set(node.code, { budgetIqd: mine.budgetIqd, committedIqd: mine.committedIqd, actualIqd: mine.actualIqd });
  }
  const byDepth = [...nodes].sort((a, b) => b.level - a.level);
  for (const node of byDepth) {
    if (!node.parentCode) continue;
    const parent = totals.get(node.parentCode);
    const child = totals.get(node.code);
    if (!parent || !child) continue;
    parent.budgetIqd += child.budgetIqd;
    parent.committedIqd += child.committedIqd;
    parent.actualIqd += child.actualIqd;
  }
  return totals;
}

/** The tree in display order: parents before children, siblings by code. */
export function treeOrder<T extends WbsNode>(nodes: readonly T[]): T[] {
  const children = new Map<string | null, T[]>();
  for (const node of nodes) {
    const list = children.get(node.parentCode) ?? [];
    list.push(node);
    children.set(node.parentCode, list);
  }
  const numeric = (code: string) => code.split(/[-.]/).map((part) => (Number.isInteger(Number(part)) ? Number(part) : part));
  const compare = (a: T, b: T) => {
    const x = numeric(a.code);
    const y = numeric(b.code);
    for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
      const p = x[i];
      const q = y[i];
      if (p === undefined) return -1;
      if (q === undefined) return 1;
      if (p === q) continue;
      return typeof p === 'number' && typeof q === 'number' ? p - q : String(p).localeCompare(String(q));
    }
    return 0;
  };
  const out: T[] = [];
  const walk = (parent: string | null) => {
    for (const node of (children.get(parent) ?? []).sort(compare)) {
      out.push(node);
      walk(node.code);
    }
  };
  walk(null);
  // Orphans (a parent not in the list) still appear, after the tree.
  for (const node of nodes) if (!out.includes(node)) out.push(node);
  return out;
}

/** Availability control (§7): where an assignment stands against the profile. */
export function availabilityState(
  budgetIqd: bigint,
  assignedIqd: bigint,
  profile: { readonly warnPercent: number; readonly stopPercent: number },
): 'ok' | 'warn' | 'stop' {
  if (budgetIqd <= 0n) return assignedIqd > 0n ? 'stop' : 'ok';
  // Exact: a dinar over the line is over it, whatever two decimals would say.
  const scaled = assignedIqd * 1_000_000n;
  if (scaled > budgetIqd * BigInt(Math.round(profile.stopPercent * 10000))) return 'stop';
  if (scaled >= budgetIqd * BigInt(Math.round(profile.warnPercent * 10000))) return 'warn';
  return 'ok';
}
