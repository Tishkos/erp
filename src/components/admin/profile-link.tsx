import Link from 'next/link';
import type { ReactNode } from 'react';
import { profileBase, profileHref, type ProfileKind, type ProfileQualifier } from '@/server/domain/profiles';
import { visibleRoute } from '@/server/delivered';
import { admin as s } from './index';

/**
 * A party or account on a record, as a link to its profile (2026-10-04) —
 * the bank loan's account field, made once:
 *
 *   <Link className={s.sapLink} href={…}><bdi dir="ltr">{code} · {name}</bdi></Link>
 *
 * Where the kind has no profile page yet, or its screen is not served here,
 * the same text without the link. Use it wherever a record shows a
 * customer, supplier, bank, account, journal, item, warehouse, employee,
 * project, import, B/L, container or PD:
 *
 *   <ProfileLink code={supplier.code} kind="supplier" name={supplier.name} />
 *   <ProfileLink code={pd.pdNo} kind="pd" qualifier={{ year: pd.year }} />
 *
 * `children` replaces the `code · name` text when a field shows something
 * else (only the name, say); `dir` is the text's direction (`ltr` as the
 * loan's, `auto` for a name alone).
 */
export function ProfileLink({
  kind,
  code,
  name,
  qualifier,
  dir = 'ltr',
  children,
}: {
  readonly kind: ProfileKind;
  /** The key the profile is addressed by — see `profileHref`. */
  readonly code: string | null | undefined;
  readonly name?: string | null;
  readonly qualifier?: ProfileQualifier;
  readonly dir?: 'ltr' | 'auto';
  readonly children?: ReactNode;
}) {
  const label = children ?? (code && name ? `${code} · ${name}` : (code || name || '—'));
  const href = profileHref(kind, code, qualifier);
  const base = profileBase(kind);
  if (!href || !base || !visibleRoute(base)) return <bdi dir={dir}>{label}</bdi>;
  return (
    <Link className={s.sapLink} href={href}>
      <bdi dir={dir}>{label}</bdi>
    </Link>
  );
}
