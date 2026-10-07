/**
 * The words of `src/app/global-error.tsx`, in both languages.
 *
 * That page replaces the root layout — which is what owns the message
 * provider — so it cannot ask the catalogue. Importing the catalogues instead
 * would put both of them in every page's bundle: the global error boundary
 * ships with the router on every page. So its few words are kept here, and
 * `tests/unit/states-global-error.test.ts` holds them equal to
 * `states.global` in `messages/en.json` and `messages/ar.json` — the
 * catalogue stays the place a translator changes them.
 */
export const GLOBAL_ERROR_WORDS = {
  en: {
    title: 'The system could not open',
    body: 'Something failed before the page could be drawn. Nothing was saved or changed.',
    retry: 'Try again',
    home: 'Go to the dashboard',
    reference: 'Reference',
    hint: 'Quote it when you report this.',
  },
  ar: {
    title: 'تعذّر فتح النظام',
    body: 'حدث خطأ قبل أن تُعرض الصفحة. لم يتم حفظ أو تغيير أي بيانات.',
    retry: 'إعادة المحاولة',
    home: 'الذهاب إلى اللوحة الرئيسية',
    reference: 'المرجع',
    hint: 'اذكره عند الإبلاغ عن هذا الخطأ.',
  },
} as const;

export type GlobalErrorLocale = keyof typeof GLOBAL_ERROR_WORDS;
