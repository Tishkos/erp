import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The files every printed page carries: the logo, the embedded Arabic font
 * (IBM Plex Sans Arabic, SIL Open Font License — see the licence beside it),
 * and the DRAFT watermark a Word document shows behind an unposted document.
 *
 * `logo-print.png` is `mainLogo.png` scaled to print resolution (360 px wide
 * for a 16 mm mark), so each export carries 90 KB of logo rather than 400.
 *
 * Read from the project directory rather than imported, so the bundler never
 * inlines a font into a route; `next.config.ts` traces the folder into the
 * standalone build.
 */
const DIRECTORY = path.join(process.cwd(), 'src', 'server', 'print', 'assets');

export type AssetName =
  | 'IBMPlexSansArabic-Regular.ttf'
  | 'IBMPlexSansArabic-Bold.ttf'
  | 'logo-print.png'
  | 'watermark-en.png'
  | 'watermark-ar.png';

const cache = new Map<AssetName, Buffer>();

export function asset(name: AssetName): Buffer {
  let data = cache.get(name);
  if (!data) {
    data = readFileSync(path.join(DIRECTORY, name));
    cache.set(name, data);
  }
  return data;
}
