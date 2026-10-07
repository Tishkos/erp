'use client';

import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';

export type InterfaceLanguage = 'en' | 'ar';

/**
 * Switches the interface language — the one mechanism, for the account menu,
 * My profile and the phone drawer: the `erp-locale` cookie for a year, the
 * document's language and direction, and a full reload (every server
 * component, the message bundle and the direction must change together).
 * The sign-in and password screens keep their own switch.
 */
export function switchLocale(next: InterfaceLanguage): void {
  document.cookie = `erp-locale=${next}; Path=/; Max-Age=31536000; SameSite=Lax`;
  document.documentElement.lang = next;
  document.documentElement.dir = next === 'ar' ? 'rtl' : 'ltr';
  window.location.reload();
}

/**
 * English and العربية side by side, the one in use ticked (by direction,
 * 2026-10-06: "the language selection should be in profile settings").
 * Each language is named in itself, so a person who cannot read the other
 * one still finds their own.
 */
export function LanguageChoice({
  current,
  className,
  onChoose,
}: {
  readonly current: InterfaceLanguage;
  readonly className?: string;
  /** Called before the switch (the shell closes its menus). */
  readonly onChoose?: (next: InterfaceLanguage) => void;
}) {
  const shell = useTranslations('shell');
  return (
    <div aria-label={shell('language')} className={className ?? 'erp-user-panel__choices'} role="group">
      {(['en', 'ar'] as const).map((code) => {
        const chosen = current === code;
        return (
          <button
            aria-pressed={chosen}
            className="erp-user-panel__choice"
            data-locale={code}
            data-selected={chosen ? 'true' : 'false'}
            key={code}
            lang={code}
            onClick={() => {
              if (chosen) return;
              onChoose?.(code);
              switchLocale(code);
            }}
            type="button"
          >
            <span>{shell(`language_${code}`)}</span>
            {chosen ? <Check aria-hidden="true" /> : null}
          </button>
        );
      })}
    </div>
  );
}
