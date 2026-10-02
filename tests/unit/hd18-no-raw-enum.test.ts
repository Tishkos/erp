/**
 * REQ-HARDEN-001 HD18 (H1–H3) — no raw enum reaches the DOM, and the order
 * status labels live in one namespace.
 *
 * A status, kind, state, outcome or lane is a code (`partially_executed`,
 * `material_issue`, `suppressed`): rendered as it stands, an Arabic reader sees
 * English snake case. Every such value is drawn through a translation, with
 * the raw code only as the fallback behind a `.has(…)` check for a value a
 * later migration adds before its label does.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '../../messages/en.json';
import ar from '../../messages/ar.json';

const ROOT = join(__dirname, '..', '..');

function tsxUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...tsxUnder(path));
    else if (name.endsWith('.tsx')) out.push(path);
  }
  return out;
}

/** `{row.status}` as a child — not `key={…}`, not `${…}` inside a template, not an argument. */
const RAW = /(?<![=$\w(])\{([\w.?!]+)\.(status|statusCode|kind|state|outcome|lane|laneCode|stage|stageCode)\}/g;

/**
 * The values that are text, not codes. Each with its reason.
 */
const ALLOWED: ReadonlyArray<{ file: string; expr: string; why: string }> = [
  // The migration sheet's own status column, as the sheet wrote it — evidence, not a code of ours.
  { file: 'src/app/(app)/administration/payables-migration/page.tsx', expr: 'row.status', why: 'the sheet’s own text' },
  // A label object passed in by the caller, already translated.
  { file: 'src/components/admin/statement-line-dialog.tsx', expr: 'labels.kind', why: 'translated by the caller' },
  { file: 'src/components/admin/new-account-dialog.tsx', expr: 'labels.kind', why: 'translated by the caller' },
];

describe('HD18 · no raw enum reaches the DOM', () => {
  it('every status, kind, state, outcome and lane in a screen is drawn through a translation', () => {
    const found: string[] = [];
    for (const file of [...tsxUnder(join(ROOT, 'src', 'app')), ...tsxUnder(join(ROOT, 'src', 'components'))]) {
      const rel = relative(ROOT, file).split('\\').join('/');
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          for (const match of line.matchAll(RAW)) {
            const expr = `${match[1]}.${match[2]}`;
            if (ALLOWED.some((allowed) => allowed.file === rel && allowed.expr === expr)) continue;
            // The fallback behind a translation check: `t.has(`…${x}`) ? t(…) : x`.
            if (/\.has\(`[^`]*\$\{/.test(line)) continue;
            found.push(`${rel}:${index + 1} {${expr}}`);
          }
        });
    }
    expect(found).toEqual([]);
  });

  it('the scan sees what it is meant to see', () => {
    const hits = (text: string) => [...text.matchAll(RAW)].map((m) => `${m[1]}.${m[2]}`);
    expect(hits('<td>{event.outcome}</td>')).toEqual(['event.outcome']);
    expect(hits('· {hold.laneCode}')).toEqual(['hold.laneCode']);
    expect(hits('<bdi dir="ltr">{row.status}</bdi>')).toEqual(['row.status']);
    expect(hits('<tr key={row.status}>')).toEqual([]);
    expect(hits('data-status={row.status}')).toEqual([]);
    expect(hits('t(`status_${row.status}`)')).toEqual([]);
  });
});

const ORDER_CODES = ['draft', 'submitted', 'approved', 'partially_executed', 'executed', 'posted', 'settled', 'rejected', 'cancelled', 'reversed', 'closed'];

type Tree = { readonly [key: string]: string | Tree };

/** Every object in the catalogue that carries `status_<code>` for most of the order codes. */
function copies(tree: Tree, path: string): string[] {
  const out: string[] = [];
  const keys = Object.keys(tree);
  if (ORDER_CODES.filter((code) => keys.includes(`status_${code}`)).length >= 5) out.push(path);
  for (const [key, value] of Object.entries(tree)) if (typeof value === 'object') out.push(...copies(value, path ? `${path}.${key}` : key));
  return out;
}

describe('H3 · the order status labels are kept once', () => {
  it('no namespace re-declares them', () => {
    expect(copies(en as unknown as Tree, '')).toEqual([]);
    expect(copies(ar as unknown as Tree, '')).toEqual([]);
  });

  it('`status_order` names every code in both locales', () => {
    for (const catalogue of [en, ar] as unknown as Array<{ status_order: Record<string, string> }>) {
      for (const code of ORDER_CODES) expect(catalogue.status_order[code], code).toBeTruthy();
    }
  });
});
