'use client';

import { ErrorState } from '@/components/states/error-state';

/**
 * The boundary a failed screen falls into — inside the shell, so the header
 * and navigation stay and the reader can go on elsewhere.
 *
 * The page itself — the reason, "nothing was saved or changed", the digest
 * `instrumentation.ts` logged (OP-5), *Try again* through Next.js's `retry`,
 * the offline and the newly-deployed cases — is `ErrorState`
 * (`src/components/states/error-state.tsx`).
 */
export default function ScreenError({
  error,
  reset,
  retry,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
  readonly retry?: () => void;
}) {
  return <ErrorState error={error} home="link" reset={reset} retry={retry} />;
}
