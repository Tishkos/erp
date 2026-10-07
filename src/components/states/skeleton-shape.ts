/**
 * Which placeholder a screen gets while it loads (`route-skeleton.tsx`), read
 * from the address being opened: Home and the dashboards are figures and
 * charts; an address with a record's number in it, or a `/new` form, is a
 * document; everything else is a register.
 */
export type SkeletonShape = 'home' | 'register' | 'document';

/** The catch-all's parameter is a menu address, not a record. */
const NOT_A_RECORD = new Set(['screen']);

export function shapeOf(pathname: string, params: Readonly<Record<string, unknown>> | null): SkeletonShape {
  if (pathname === '/' || pathname === '') return 'home';
  if (/\/dashboard\/?$/.test(pathname)) return 'home';
  const named = Object.keys(params ?? {}).some((key) => !NOT_A_RECORD.has(key));
  if (named) return 'document';
  const last = pathname.split('/').filter(Boolean).at(-1);
  return last === 'new' ? 'document' : 'register';
}
