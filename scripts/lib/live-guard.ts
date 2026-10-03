/**
 * The live marker — REQ-IMPROVE-001 OP-6 (IM4).
 *
 * `/opt/qs-erp-next/var/LIVE` (or `<cwd>/var/LIVE`) says the database this
 * tree points at is the company's books. A script that writes fixtures,
 * resets, reseeds or re-creates users refuses while it exists, whatever the
 * connection string looks like — on the server production *is*
 * 127.0.0.1:5434, so "not localhost" never protected anything there.
 *
 * `--i-know-this-is-live` is accepted only by the scripts that have a
 * legitimate live use and say so; the refusal names the marker so the
 * person knows what they are looking at.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const LIVE_MARKERS = [join(process.cwd(), 'var', 'LIVE'), '/opt/qs-erp-next/var/LIVE'];

export function liveMarker(): string | null {
  for (const marker of LIVE_MARKERS) if (existsSync(marker)) return marker;
  return null;
}

export function refuseOnLive(what: string, options: { allowFlag?: boolean } = {}): void {
  const marker = liveMarker();
  if (!marker) return;
  if (options.allowFlag && process.argv.includes('--i-know-this-is-live')) return;
  let note = '';
  try {
    note = readFileSync(marker, 'utf8').trim();
  } catch {
    note = '';
  }
  console.error(
    `Refusing to ${what}: ${marker} marks this database as the live books${note ? ` (${note})` : ''}.\n` +
      'Trials belong on a separate database. If this really is not the live system any more, remove the marker by hand.',
  );
  process.exit(1);
}
