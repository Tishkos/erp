'use client';

import { Printer } from 'lucide-react';

/**
 * The one interactive thing on a print view. The browser's print dialog is
 * the PDF pipeline — every platform's, with none maintained here.
 *
 * Its look is the print toolbar's (`print.module.css` › `.toolbar button`,
 * the paper stylesheet, outside the redesign); the printer mark says what it
 * does at a glance.
 */
export function PrintButton({ label }: { readonly label: string }) {
  return (
    <button onClick={() => window.print()} type="button">
      <Printer aria-hidden="true" className="size-4 shrink-0" />
      <span>{label}</span>
    </button>
  );
}
