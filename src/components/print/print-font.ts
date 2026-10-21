import localFont from 'next/font/local';

/**
 * The embedded face the PDF and the Word file use — Vazirmatn (SIL Open
 * Font License, beside the files) — so the browser's print shows Arabic, Kurdish and Latin in the same
 * letters on any machine: never a system substitute, never a box.
 */
export const printFont = localFont({
  src: [
    { path: '../../server/print/assets/Vazirmatn-Regular.ttf', weight: '400', style: 'normal' },
    { path: '../../server/print/assets/Vazirmatn-Medium.ttf', weight: '500', style: 'normal' },
    { path: '../../server/print/assets/Vazirmatn-Bold.ttf', weight: '700', style: 'normal' },
    { path: '../../server/print/assets/Vazirmatn-ExtraBold.ttf', weight: '800', style: 'normal' },
  ],
  display: 'block',
});
