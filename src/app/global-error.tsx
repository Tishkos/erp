'use client';

import { useSyncExternalStore } from 'react';
import { House, RotateCcw, TriangleAlert } from 'lucide-react';
import { GLOBAL_ERROR_WORDS, type GlobalErrorLocale } from '@/components/states/global-error-words';

/**
 * The last boundary: a failure in the root layout itself (the language, the
 * catalogue, the fonts), where nothing of the application is left to draw
 * with. Next.js renders this file *instead of* the root layout, so it brings
 * its own document, its own words (`global-error-words.ts` — the message
 * provider lived in the layout that failed) and its own styles: written into
 * the page rather than linked, because the commonest way to get here is code
 * or a stylesheet that could not be fetched.
 *
 * The colours are Intent UI's own light and dark themes (the values
 * `intent-theme.css` gives `:root`), chosen by the system's colour scheme —
 * the reader's palette lives in the database, out of reach here.
 *
 * The language is the device's choice, the `erp-locale` cookie, read once the
 * page is in the browser (the server's copy is English). The digest is the
 * one `instrumentation.ts` logged (OP-5). *Try again* is Next.js's `retry`.
 */
const STYLE = `
:root {
  color-scheme: light dark;
  --ge-canvas: oklch(0.967 0.001 286.375);
  --ge-card: oklch(1 0 0);
  --ge-fg: oklch(0.21 0.006 285.885);
  --ge-muted: oklch(0.552 0.016 285.938);
  --ge-border: oklch(0.911 0.006 286.286);
  --ge-fill: oklch(0.967 0.001 286.375);
  --ge-primary: oklch(0.546 0.245 262.881);
  --ge-primary-fg: oklch(1 0 0);
  --ge-danger: oklch(0.505 0.213 27.518);
  --ge-danger-tint: oklch(0.637 0.237 25.331 / 0.15);
}
@media (prefers-color-scheme: dark) {
  :root {
    --ge-canvas: oklch(0.141 0.005 285.823);
    --ge-card: oklch(0.21 0.006 285.885);
    --ge-fg: oklch(0.985 0 0);
    --ge-muted: oklch(0.705 0.015 286.067);
    --ge-border: oklch(0.32 0.012 285.805);
    --ge-fill: oklch(0.274 0.006 286.033);
    --ge-primary: oklch(0.623 0.214 259.815);
    --ge-danger: oklch(0.704 0.191 22.216);
    --ge-danger-tint: oklch(0.637 0.237 25.331 / 0.22);
  }
}
* { box-sizing: border-box; }
html { font-size: 90%; }
body {
  margin: 0;
  min-height: 100dvh;
  display: grid;
  place-items: center;
  padding: 2rem 1rem;
  background: var(--ge-canvas);
  color: var(--ge-fg);
  font-family: ui-sans-serif, system-ui, "Segoe UI", Tahoma, Roboto, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.ge-card {
  display: grid;
  justify-items: center;
  gap: 0.375rem;
  width: min(100%, 28rem);
  padding: 2.25rem 1.5rem 2rem;
  border: 1px solid var(--ge-border);
  border-radius: 0.7rem;
  background: var(--ge-card);
  box-shadow: 0 1px 2px 0 rgb(0 0 0 / 5%);
  text-align: center;
}
.ge-icon {
  display: grid;
  place-items: center;
  width: 3rem;
  height: 3rem;
  margin-bottom: 0.75rem;
  border-radius: 999px;
  color: var(--ge-danger);
  background: var(--ge-danger-tint);
  box-shadow: 0 0 0 0.45rem color-mix(in oklab, var(--ge-danger-tint) 50%, transparent);
}
.ge-icon svg { width: 1.25rem; height: 1.25rem; }
h1 { margin: 0; font-size: 1.125rem; line-height: 1.75rem; font-weight: 600; letter-spacing: -0.01em; text-wrap: balance; }
html[dir="rtl"] h1 { letter-spacing: 0; }
p { margin: 0; max-width: 24rem; color: var(--ge-muted); font-size: 0.875rem; line-height: 1.5rem; text-wrap: pretty; }
.ge-ref { margin-top: 1rem; display: inline-flex; gap: 0.5rem; align-items: center; padding: 0.3rem 0.75rem; border: 1px solid var(--ge-border); border-radius: 0.5rem; background: var(--ge-fill); font-size: 0.75rem; line-height: 1.25rem; }
.ge-ref code { color: var(--ge-fg); font-family: "Cascadia Code", "SFMono-Regular", Consolas, ui-monospace, monospace; user-select: all; }
.ge-hint { font-size: 0.75rem; line-height: 1.25rem; }
.ge-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 0.5rem; margin-top: 1.25rem; }
.ge-button {
  display: inline-flex;
  min-height: 2.25rem;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.875rem;
  border: 1px solid var(--ge-border);
  border-radius: 0.5rem;
  background: transparent;
  color: var(--ge-fg);
  font: inherit;
  font-size: 0.875rem;
  font-weight: 500;
  line-height: 1.5rem;
  text-decoration: none;
  cursor: pointer;
}
.ge-button svg { width: 1rem; height: 1rem; flex: 0 0 auto; opacity: 0.8; }
.ge-button:focus-visible { outline: 2px solid var(--ge-primary); outline-offset: 2px; }
.ge-primary { border-color: color-mix(in oklab, var(--ge-primary) 85%, black); background: var(--ge-primary); color: var(--ge-primary-fg); }
.ge-primary:hover { background: color-mix(in oklab, var(--ge-primary-fg) 10%, var(--ge-primary) 90%); }
.ge-button:not(.ge-primary):hover { background: var(--ge-fill); }
@media (forced-colors: active) { .ge-card, .ge-button { border-color: CanvasText; } }
`;

function deviceLocale(): GlobalErrorLocale {
  const chosen = /(?:^|;\s*)erp-locale=([^;]+)/.exec(document.cookie)?.[1];
  return chosen === 'ar' ? 'ar' : 'en';
}

const ENGLISH = (): GlobalErrorLocale => 'en';
/** The cookie does not change while this page is up. */
const subscribeNever = () => () => undefined;

export default function GlobalError({
  error,
  reset,
  retry,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
  readonly retry?: () => void;
}) {
  const locale = useSyncExternalStore(subscribeNever, deviceLocale, ENGLISH);
  const words = GLOBAL_ERROR_WORDS[locale];

  return (
    <html dir={locale === 'ar' ? 'rtl' : 'ltr'} lang={locale}>
      <head>
        <meta content="width=device-width, initial-scale=1" name="viewport" />
        <title>{words.title}</title>
        <style dangerouslySetInnerHTML={{ __html: STYLE }} />
      </head>
      <body>
        <main className="ge-card" role="alert">
          <span aria-hidden="true" className="ge-icon">
            <TriangleAlert />
          </span>
          <h1>{words.title}</h1>
          <p>{words.body}</p>
          {error.digest ? (
            <>
              <p className="ge-ref">
                <span>{words.reference}</span>
                <code dir="ltr">{error.digest}</code>
              </p>
              <p className="ge-hint">{words.hint}</p>
            </>
          ) : null}
          <div className="ge-actions">
            <button className="ge-button ge-primary" onClick={() => (retry ?? reset)()} type="button">
              <RotateCcw aria-hidden="true" />
              <span>{words.retry}</span>
            </button>
            <a className="ge-button" href="/">
              <House aria-hidden="true" />
              <span>{words.home}</span>
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
