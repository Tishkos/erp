'use client';

// The palettes' `--w-*` tokens, which the Intent theme reads (a failed render
// may come before any screen has loaded them).
import '@/components/admin/admin.module.css';
import { ErrorState } from '@/components/states/error-state';

/**
 * The boundary for a failure above the screens — in the application's own
 * layout (the shell, the reader's appearance), so it is drawn without them,
 * in Intent UI's light theme from :root.
 *
 * Home is a full page load here: the layout that failed is built again.
 * Everything else — the reason, the digest `instrumentation.ts` logged
 * (OP-5), *Try again* through Next.js's `retry` — is `ErrorState`
 * (`src/components/states/error-state.tsx`). A failure in the root layout
 * itself is `global-error.tsx`.
 */
export default function RootError({
  error,
  reset,
  retry,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
  readonly retry?: () => void;
}) {
  return <ErrorState error={error} home="document" reset={reset} retry={retry} />;
}
