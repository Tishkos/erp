'use client';

/**
 * The one interactive thing on a print view. The browser's print dialog is
 * the PDF pipeline — every platform's, with none maintained here.
 */
export function PrintButton({ label }: { readonly label: string }) {
  return (
    <button onClick={() => window.print()} type="button">
      {label}
    </button>
  );
}
