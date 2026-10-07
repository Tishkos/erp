'use client';

import { useSyncExternalStore } from 'react';

/**
 * Whether the reader asked the system for less motion — the charts' entrance
 * is then left out altogether, not merely shortened.
 *
 * Before the browser has answered (the server's render, the hydration pass)
 * the answer is "yes, reduce": a chart that has not been told it may move
 * stays still, which is the safe way round.
 */
const QUERY = '(prefers-reduced-motion: reduce)';

function subscribe(notify: () => void): () => void {
  const media = window.matchMedia(QUERY);
  media.addEventListener('change', notify);
  return () => media.removeEventListener('change', notify);
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => true,
  );
}
