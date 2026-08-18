/**
 * Phase 00.6 test gate — *"Requirement ID → test case linkage is demonstrated
 * for that screen."*
 *
 * A requirement document names the tests that hold up each acceptance
 * criterion. Those names rot: a test gets renamed, and the requirement quietly
 * becomes a claim nobody checks. §28.1 is explicit that *"a change is not
 * complete until documentation, automated tests, UAT evidence and training
 * material are updated"* — this is the part of that sentence a machine can
 * enforce.
 *
 * So every `→ file › test name` line in `docs/requirements/` is resolved
 * against the actual test files. A broken link fails the build, which means the
 * traceability is worth something rather than being a table somebody once
 * filled in.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REQUIREMENTS_DIR = join(process.cwd(), 'docs', 'requirements');

/** `→ tests/e2e/shell.spec.ts › *lists the chart, in code order*` */
const LINK = /→\s*`?([\w./-]+\.(?:test|spec)\.tsx?)`?\s*›\s*\*?([^*\n]+?)\*?\s*$/gm;

interface Link {
  readonly requirement: string;
  readonly file: string;
  readonly testName: string;
}

function collectLinks(): Link[] {
  if (!existsSync(REQUIREMENTS_DIR)) return [];

  return readdirSync(REQUIREMENTS_DIR)
    .filter((f) => f.endsWith('.md'))
    .flatMap((file) => {
      const source = readFileSync(join(REQUIREMENTS_DIR, file), 'utf8');
      return [...source.matchAll(LINK)].map((match) => ({
        requirement: file,
        file: match[1]!,
        testName: match[2]!.trim(),
      }));
    });
}

const links = collectLinks();

describe('00.6 gate · requirement → test linkage', () => {
  it('has at least one specified screen, as the gate requires', () => {
    // "One real screen is specified end to end using the template as proof it
    // is workable." One is the requirement; more is fine.
    expect(links.length).toBeGreaterThan(0);
  });

  it('names only test files that exist', () => {
    const missing = links
      .filter((link) => !existsSync(join(process.cwd(), link.file)))
      .map((link) => `${link.requirement} → ${link.file}`);

    expect(missing).toEqual([]);
  });

  it('names only tests that exist in those files', () => {
    // Matched against the file's text rather than by running it: a test name is
    // a string in an `it(...)` call, and reading it here keeps this check fast
    // enough to run on every build.
    const missing = links
      .filter((link) => {
        const path = join(process.cwd(), link.file);
        if (!existsSync(path)) return false; // reported by the test above
        return !readFileSync(path, 'utf8').includes(link.testName);
      })
      .map((link) => `${link.requirement} → ${link.file} › ${link.testName}`);

    expect(missing).toEqual([]);
  });

  it('gives every requirement document a stable identifier', () => {
    for (const file of readdirSync(REQUIREMENTS_DIR).filter((f) => f.endsWith('.md'))) {
      const source = readFileSync(join(REQUIREMENTS_DIR, file), 'utf8');
      // "stable, never reused" — so it is in the document, not only the name.
      expect(source, file).toMatch(/\*\*Requirement ID\*\*\s*\|\s*`REQ-[A-Z]+-\d+`/);
    }
  });

  it('leaves every requirement with an explicit approval state', () => {
    // §28.1 — approval is written. A requirement with the field silently absent
    // reads as approved to anyone skimming.
    for (const file of readdirSync(REQUIREMENTS_DIR).filter((f) => f.endsWith('.md'))) {
      const source = readFileSync(join(REQUIREMENTS_DIR, file), 'utf8');
      expect(source, file).toMatch(/\*\*Approved by\*\*/);
      expect(source, file).toMatch(/\*\*Status\*\*/);
    }
  });
});
