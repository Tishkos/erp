'use client';

import { useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';

/**
 * REQ-HARDEN-001 HD1 — keeps the persistent shell honest.
 *
 * The layout survives navigations, so the menu it drew is the menu of the
 * moment the person signed in. After each navigation this asks the server
 * for the permissions version it holds now; when it has moved — a role
 * granted, a scope withdrawn — the shell is refreshed and redrawn from the
 * current grants. One small request per click, nothing stored.
 */
export function PermissionsWatch({ version }: { readonly version: number }) {
  const pathname = usePathname();
  const router = useRouter();
  const seen = useRef(version);

  useEffect(() => {
    seen.current = version;
  }, [version]);

  useEffect(() => {
    let cancelled = false;
    fetch('/session/version', { cache: 'no-store', credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { version?: number } | null) => {
        if (cancelled || !body || typeof body.version !== 'number') return;
        if (body.version !== seen.current) {
          seen.current = body.version;
          router.refresh();
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [pathname, router]);

  return null;
}
