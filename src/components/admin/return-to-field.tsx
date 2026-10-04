'use client';

import { usePathname, useSearchParams } from 'next/navigation';

/**
 * The page a form came from, as a hidden field — so a shared action (the
 * Notes door's) can go back to whichever record it was opened on, query and
 * all (`?year=` on a PD, `?id=` on a container), without each module telling
 * it the address.
 */
export function ReturnToField({ name = 'return_to' }: { readonly name?: string }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const query = search?.toString() ?? '';
  return <input name={name} type="hidden" value={query ? `${pathname}?${query}` : pathname} />;
}
