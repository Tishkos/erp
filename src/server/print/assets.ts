import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The files every printed page carries: the logo's mark, the embedded font,
 * and the DRAFT watermark a Word document shows behind an unposted document.
 *
 * The font is Vazirmatn (SIL Open Font License — see the licence beside
 * it), four static weights cut from the variable font: a clean, modern
 * Arabic with Kurdish and Persian letters and a Latin of its own. Every
 * letter is one glyph — no letter is drawn from a shared skeleton and loose
 * dots — so a copy of the PDF reads back and searches as the words printed.
 * IBM Plex Sans Arabic stays only as the fallback for the few characters
 * Vazirmatn has no glyph for (arrows), so none prints as a box.
 *
 * `logo-mark.png` is `mainLogoMark.png` — the Q alone, without the product's
 * name (by direction, 2026-10-21: "never mention the ERP") — trimmed and
 * scaled to print resolution (300 px for a 15 mm mark). `logo-backdrop.png`
 * is the same mark at 7% opacity, baked in, for the faint logo behind every
 * page — the PDF, the Word file and the browser's print draw the same file.
 *
 * Read from the project directory rather than imported, so the bundler never
 * inlines a font into a route; `next.config.ts` traces the folder into the
 * standalone build.
 */
const DIRECTORY = path.join(process.cwd(), 'src', 'server', 'print', 'assets');

export type AssetName =
  | 'IBMPlexSansArabic-Regular.ttf'
  | 'IBMPlexSansArabic-Bold.ttf'
  | 'Vazirmatn-Regular.ttf'
  | 'Vazirmatn-Medium.ttf'
  | 'Vazirmatn-Bold.ttf'
  | 'Vazirmatn-ExtraBold.ttf'
  | 'logo-mark.png'
  | 'logo-backdrop.png'
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
