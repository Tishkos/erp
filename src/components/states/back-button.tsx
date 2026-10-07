'use client';

import { ArrowLeft } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { emptyStateButton } from '@/components/admin/empty-state';

/**
 * "Go back" on the missing page: a stale link was followed from somewhere, and
 * that somewhere is the likeliest place the reader wanted. With no history (the
 * address was typed, or opened in a new tab) it goes to Home instead.
 */
export function BackButton({ label }: { readonly label: string }) {
  const router = useRouter();
  return (
    <button
      className={emptyStateButton('outline')}
      onClick={() => (window.history.length > 1 ? router.back() : router.push('/'))}
      type="button"
    >
      <ArrowLeft aria-hidden="true" className="rtl:-scale-x-100" />
      <span>{label}</span>
    </button>
  );
}
