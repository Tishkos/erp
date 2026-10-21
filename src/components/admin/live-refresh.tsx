'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Radio } from 'lucide-react';

/**
 * Keeps a page live (2026-10-21, by direction: "live updates tracking"): asks
 * `endpoint` for the version of what the page shows every `everyMs`, and
 * redraws the page — the server's own render, under the reader's own scope —
 * only when the version moved. Nothing is pushed and nothing is cached here.
 *
 * It never redraws under somebody's hands: not while a dialog is open, not
 * while a field has the focus, not in a hidden tab (it catches up when the tab
 * comes back). A failed ask waits longer before the next, up to a minute.
 */
export function LiveRefresh({
  endpoint,
  version,
  label,
  everyMs = 8000,
}: {
  readonly endpoint: string;
  /** The version the page was drawn at. */
  readonly version: string;
  /** "Live", in the reader's language. */
  readonly label: string;
  readonly everyMs?: number;
}) {
  const router = useRouter();
  const seen = useRef(version);
  const [pending, setPending] = useState(false);

  // A redraw brings the new version in; take it as seen.
  useEffect(() => {
    seen.current = version;
    setPending(false);
  }, [version]);

  useEffect(() => {
    let stopped = false;
    let wait = everyMs;
    let timer: ReturnType<typeof setTimeout>;

    const busy = () => {
      if (document.querySelector('dialog[open]')) return true;
      const focused = document.activeElement;
      return Boolean(focused && focused.closest('input, textarea, select, [contenteditable="true"]'));
    };

    const tick = async () => {
      if (stopped) return;
      if (!document.hidden) {
        try {
          const response = await fetch(endpoint, { cache: 'no-store', headers: { 'X-Requested-With': 'qimah-live' } });
          if (!response.ok) throw new Error(String(response.status));
          const answer = (await response.json()) as { version?: string };
          wait = everyMs;
          if (answer.version && answer.version !== seen.current) {
            if (busy()) {
              setPending(true);
            } else {
              seen.current = answer.version;
              router.refresh();
            }
          }
        } catch {
          wait = Math.min(wait * 2, 60_000);
        }
      }
      if (!stopped) timer = setTimeout(tick, wait);
    };

    timer = setTimeout(tick, wait);
    const onVisible = () => {
      if (!document.hidden) {
        clearTimeout(timer);
        timer = setTimeout(tick, 250);
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [endpoint, everyMs, router]);

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium ${pending ? 'bg-warning-subtle text-warning-subtle-fg' : 'bg-success-subtle text-success-subtle-fg'}`}
      data-live-refresh=""
      data-live-pending={pending ? '' : undefined}
      title={label}
    >
      <Radio aria-hidden="true" className="size-3.5" />
      {label}
    </span>
  );
}
