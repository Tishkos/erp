'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Waits for the person to approve the sign-in in Cloud Files, then lets the
 * Document Center take over. It only asks `/documents/link/poll` (which asks
 * the cloud); it never holds the app password — that is issued to the server.
 * Stops asking when the tab is hidden, and after the sign-in's lifetime.
 */
export function CloudLinkPoller({
  endpoint,
  home,
  expiresAt,
  everyMs = 3000,
}: {
  readonly endpoint: string;
  readonly home: string;
  /** ISO time the sign-in expires. */
  readonly expiresAt: string;
  readonly everyMs?: number;
}) {
  const router = useRouter();

  useEffect(() => {
    let stopped = false;
    const until = Date.parse(expiresAt);
    const timer = setInterval(async () => {
      if (stopped || document.hidden) return;
      if (Number.isFinite(until) && Date.now() > until) {
        stopped = true;
        router.refresh();
        return;
      }
      try {
        const response = await fetch(endpoint, { method: 'POST', headers: { 'X-Requested-With': 'qimah-documents' }, cache: 'no-store' });
        const answer = (await response.json()) as { state?: string; error?: string };
        if (answer.state === 'linked') {
          stopped = true;
          router.replace(`${home}${home.includes('?') ? '&' : '?'}saved=1`);
        } else if (answer.state === 'failed') {
          stopped = true;
          router.replace(`${home}${home.includes('?') ? '&' : '?'}error=${encodeURIComponent(answer.error ?? '')}`);
        } else if (answer.state === 'expired' || answer.state === 'none') {
          stopped = true;
          router.refresh();
        }
      } catch {
        /* the next tick tries again */
      }
    }, everyMs);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [endpoint, home, expiresAt, everyMs, router]);

  return null;
}
