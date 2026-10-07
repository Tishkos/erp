'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, useSyncExternalStore, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Copy, House, LoaderCircle, RefreshCw, RotateCcw, TriangleAlert, WifiOff } from 'lucide-react';
import { EmptyState, EmptyStatePage, emptyStateButton } from '@/components/admin/empty-state';

/**
 * The page a failed render falls into (the Intent UI redesign, 2026-10-06).
 *
 * §25 asks for a reason and a corrective action rather than a blank page or a
 * stack trace. The reason a reader most needs on an accounting screen is the
 * second line: nothing was written. A failure that leaves someone unsure
 * whether their document posted is worse than the failure itself.
 *
 * Three failures read differently, because the cure differs:
 *
 *  * **failed** — the screen threw. *Try again* is Next.js's `retry` (16.3):
 *    the segment is fetched again and re-rendered, so a passing fault (a
 *    timeout, a lock) clears without a full page load, and the reader keeps
 *    their place in the shell. `reset` is the fallback for an older router.
 *  * **offline** — the browser says it has no connection. Said plainly, and
 *    tried again by itself the moment the connection is back.
 *  * **updated** — the application was deployed while the screen was open, and
 *    the code it asked for is gone. Only a full reload helps, so that is the
 *    button.
 *
 * The reference is React's error digest, which `instrumentation.ts` wrote on
 * the server's log line for this failure (OP-5); it is what support asks for,
 * so it can be copied with one press.
 *
 * The card keeps two hooks other code reads: `stateCard` on the card (the
 * theme-readability spec) and `stateIconAlert` on the icon (Noah's camera
 * tells a failure from a missing page by it — `live-screenshot.ts`).
 */
export interface ErrorStateProps {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
  readonly retry?: (() => void) | undefined;
  /**
   * `link` — the shell is standing, so Home is a client navigation.
   * `document` — the failure was above the shell (its layout), so Home is a
   * full page load, which builds everything again.
   */
  readonly home: 'link' | 'document';
}

type Failure = 'failed' | 'offline' | 'updated';

/** The code the screen needed was replaced by a deploy (webpack's and the browsers' wordings). */
function isStaleBundle(error: Error): boolean {
  return (
    error.name === 'ChunkLoadError' ||
    /Loading (CSS )?chunk [\w-]+ failed|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(
      error.message ?? '',
    )
  );
}

function subscribeConnection(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

const browserOnline = () => navigator.onLine;
/** The server cannot know; it assumes the connection that delivered the request. */
const serverOnline = () => true;

export function ErrorState({ error, reset, retry, home }: ErrorStateProps) {
  const t = useTranslations('error');
  const s = useTranslations('states');
  const online = useSyncExternalStore(subscribeConnection, browserOnline, serverOnline);
  const [pending, startTransition] = useTransition();
  const failure: Failure = isStaleBundle(error) ? 'updated' : online ? 'failed' : 'offline';

  const again = () => {
    if (failure === 'updated') {
      window.location.reload();
      return;
    }
    startTransition(() => (retry ?? reset)());
  };

  // Back online after failing offline: try again without being asked.
  const wasOffline = useRef(false);
  useEffect(() => {
    if (!online) {
      wasOffline.current = true;
      return;
    }
    if (wasOffline.current) {
      wasOffline.current = false;
      startTransition(() => (retry ?? reset)());
    }
  }, [online, reset, retry]);

  const title =
    failure === 'updated' ? s('updated_title') : failure === 'offline' ? s('offline_title') : t('error_title');
  const description =
    failure === 'updated' ? s('updated_body') : failure === 'offline' ? s('offline_body') : t('error_body');
  const Icon = failure === 'updated' ? RefreshCw : failure === 'offline' ? WifiOff : TriangleAlert;
  const AgainIcon = pending ? LoaderCircle : failure === 'updated' ? RefreshCw : RotateCcw;
  const homeLabel = t('not_found_action');

  return (
    // Above the shell there is no page canvas: the state is the whole page.
    <EmptyStatePage className={home === 'document' ? 'min-h-dvh bg-muted' : undefined}>
      <EmptyState
        actions={
          <>
            <button
              aria-busy={pending || undefined}
              className={emptyStateButton('primary')}
              disabled={pending}
              onClick={again}
              type="button"
            >
              <AgainIcon aria-hidden="true" className={pending ? 'motion-safe:animate-spin' : undefined} />
              <span>{pending ? s('retrying') : failure === 'updated' ? s('reload') : t('error_action')}</span>
            </button>
            {home === 'link' ? (
              <Link className={emptyStateButton('outline')} href="/">
                <House aria-hidden="true" />
                <span>{homeLabel}</span>
              </Link>
            ) : (
              // Above the shell: a full load rebuilds the layout that failed.
              <a className={emptyStateButton('outline')} href="/">
                <House aria-hidden="true" />
                <span>{homeLabel}</span>
              </a>
            )}
          </>
        }
        className="stateCard"
        description={description}
        headingLevel={1}
        icon={Icon}
        iconClassName="stateIconAlert"
        role="alert"
        title={title}
        tone={failure === 'updated' ? 'primary' : failure === 'offline' ? 'warning' : 'danger'}
      >
        {error.digest ? <Reference digest={error.digest} /> : null}
      </EmptyState>
    </EmptyStatePage>
  );
}

/** The digest, in small type, copyable — OP-5's line in the server's log. */
function Reference({ digest }: { readonly digest: string }) {
  const s = useTranslations('states');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    void navigator.clipboard
      ?.writeText(digest)
      .then(() => setCopied(true))
      // No clipboard (an insecure origin, a refusal): the reference is still selectable.
      .catch(() => undefined);
  };

  return (
    <div className="mt-4 grid justify-items-center gap-1.5">
      <div className="inline-flex max-w-full items-center gap-2 rounded-lg border border-border bg-muted py-0.5 ps-3 pe-0.5">
        <span className="shrink-0 text-muted-fg text-xs">{s('reference')}</span>
        <code className="min-w-0 select-all truncate font-mono text-fg text-xs tabular-nums" dir="ltr">
          {digest}
        </code>
        <button
          aria-label={copied ? s('copied') : s('copy_reference')}
          className="grid size-7 shrink-0 place-items-center rounded-md text-muted-fg outline-offset-1 hover:bg-secondary hover:text-fg focus-visible:outline-2 focus-visible:outline-ring"
          onClick={copy}
          title={copied ? s('copied') : s('copy_reference')}
          type="button"
        >
          {copied ? <Check aria-hidden="true" className="size-3.5 text-success-subtle-fg" /> : <Copy aria-hidden="true" className="size-3.5" />}
        </button>
      </div>
      <span className="text-muted-fg text-xs">{s('reference_hint')}</span>
      <span aria-live="polite" className="sr-only">
        {copied ? s('copied') : ''}
      </span>
    </div>
  );
}
