'use client';

import { useEffect } from 'react';

/**
 * The code follows the name as it is typed.
 *
 * "Accountant Branch" becomes ACCOUNTANT_BRANCH while you type it, and stops
 * following the moment somebody edits the code by hand — the guess is a
 * convenience, never an override. The server derives the same code when the
 * field is left blank, so the rule holds with or without JavaScript.
 */
export function AutoCode({
  nameId,
  codeId,
  mode = 'upper',
}: {
  readonly nameId: string;
  readonly codeId: string;
  readonly mode?: 'upper' | 'lower';
}) {
  useEffect(() => {
    const name = document.getElementById(nameId) as HTMLInputElement | null;
    const code = document.getElementById(codeId) as HTMLInputElement | null;
    if (!name || !code) return;

    let linked = code.value.trim() === '';
    const slug = (value: string) => {
      const ascii = value
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^A-Za-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 32);
      return mode === 'lower' ? ascii.toLowerCase() : ascii.toUpperCase();
    };

    const follow = () => {
      if (linked) code.value = slug(name.value);
    };
    const unlink = () => {
      linked = code.value.trim() === '';
    };

    name.addEventListener('input', follow);
    code.addEventListener('input', unlink);
    return () => {
      name.removeEventListener('input', follow);
      code.removeEventListener('input', unlink);
    };
  }, [nameId, codeId, mode]);

  return null;
}
