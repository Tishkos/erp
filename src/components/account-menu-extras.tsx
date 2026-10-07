'use client';

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { BellOff, BellRing, Check, CircleDot, Volume2, VolumeX } from 'lucide-react';
import { CHOSEN_STATUSES, ownPresenceOf, type ChosenStatus } from '@domain/chat';
import { cn } from '@/components/intent/cn';
import { setSoundsOn, useSoundsOn } from '@/lib/sounds';
import { PRESENCE_DOT } from './chat/chat-presence';
import { chooseStatus, useChat } from './chat/chat-store';
import { setPopupsOn, usePopupsOn } from './toasts/popup-setting';

/**
 * A place in the account (avatar) menu for what other parts of the platform
 * add to it — drawn after the Active branch and Language parts and before
 * Sign out (`erp-shell.tsx` › the user panel).
 *
 * The chat's status (2026-10-06, by direction: "in drop down there should be an
 * option please available busy away offline mode"): Available, Busy, Away or
 * Appear offline, each with the dot colleagues will see — shown to a person who
 * holds chat (whose header has heard from the chat once). And the Sounds
 * switch for the whole application, kept in this browser, with the Pop-up
 * notifications switch under it (2026-10-07).
 */
export function AccountMenuExtras(): ReactNode {
  const t = useTranslations('chat');
  const snap = useChat();
  const sounds = useSoundsOn();
  const [saving, setSaving] = useState<ChosenStatus | null>(null);
  const current = snap.me?.status ?? null;

  return (
    <>
      {snap.me && current ? (
        <div aria-labelledby="erp-user-status-title" className="erp-user-panel__part" role="radiogroup">
          <p className="erp-user-panel__caption" id="erp-user-status-title">
            <CircleDot aria-hidden="true" />
            <span>{t('chosen_title')}</span>
            <strong className="erp-user-panel__value inline-flex items-center gap-1.5">
              <span aria-hidden="true" className={cn('size-2 rounded-full', PRESENCE_DOT[ownPresenceOf(current)])} />
              {t(`chosen.${current}`)}
            </strong>
          </p>
          <div className="grid grid-cols-2 gap-1.5" data-status-choice="">
            {CHOSEN_STATUSES.map((status) => {
              const chosen = (saving ?? current) === status;
              return (
                <button
                  aria-checked={chosen}
                  className="erp-user-panel__choice justify-start"
                  data-selected={chosen ? 'true' : 'false'}
                  data-status-value={status}
                  disabled={saving !== null}
                  key={status}
                  onClick={async () => {
                    if (status === current) return;
                    setSaving(status);
                    await chooseStatus(status);
                    setSaving(null);
                  }}
                  role="radio"
                  title={t(`chosen_hint.${status}`)}
                  type="button"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'size-2.5 shrink-0 rounded-full',
                      status === 'invisible' ? 'border-2 border-muted-fg bg-transparent' : PRESENCE_DOT[ownPresenceOf(status)],
                    )}
                  />
                  <span className="truncate">{t(`chosen.${status}`)}</span>
                  {chosen ? <Check aria-hidden="true" className="ms-auto" /> : null}
                </button>
              );
            })}
          </div>
          <p className="m-0 text-xs text-muted-fg">{t(`chosen_hint.${saving ?? current}`)}</p>
        </div>
      ) : null}
      <div className="erp-user-panel__part">
        <button
          aria-checked={sounds}
          className={cn(
            'flex w-full cursor-pointer items-center gap-2.5 rounded-md bg-transparent p-0 text-start text-[0.78rem] font-medium text-muted-fg',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          )}
          data-sounds-switch=""
          onClick={() => setSoundsOn(!sounds)}
          role="switch"
          type="button"
        >
          {sounds ? <Volume2 aria-hidden="true" className="size-4 shrink-0" /> : <VolumeX aria-hidden="true" className="size-4 shrink-0" />}
          <span className="min-w-0 flex-1">
            <span className="block text-fg">{t('sounds')}</span>
            <span className="block text-xs font-normal text-muted-fg">{t('sounds_hint')}</span>
          </span>
          {/* Intent's switch: a track with the knob at the end when on. */}
          <span
            aria-hidden="true"
            className={cn(
              'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors',
              sounds ? 'bg-primary' : 'bg-secondary ring-1 ring-inset ring-border',
            )}
          >
            <span
              className={cn(
                'size-4 rounded-full bg-overlay shadow-sm transition-transform motion-reduce:transition-none',
                sounds ? 'translate-x-4 rtl:-translate-x-4' : 'translate-x-0',
              )}
            />
          </span>
        </button>
        <PopupsSwitch />
      </div>
    </>
  );
}

/**
 * Pop-up notifications: On / Off, under Sounds and kept the same way, in this
 * browser (`toasts/popup-setting.ts`, 2026-10-07). Off keeps the corner quiet
 * for saves, notifications and messages; a refusal still pops up.
 */
function PopupsSwitch(): ReactNode {
  const t = useTranslations('toasts');
  const on = usePopupsOn();
  return (
    <button
      aria-checked={on}
      className={cn(
        'mt-3 flex w-full cursor-pointer items-center gap-2.5 rounded-md bg-transparent p-0 text-start text-[0.78rem] font-medium text-muted-fg',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
      )}
      data-popups-switch=""
      onClick={() => setPopupsOn(!on)}
      role="switch"
      type="button"
    >
      {on ? <BellRing aria-hidden="true" className="size-4 shrink-0" /> : <BellOff aria-hidden="true" className="size-4 shrink-0" />}
      <span className="min-w-0 flex-1">
        <span className="block text-fg">{t('switch')}</span>
        <span className="block text-xs font-normal text-muted-fg">{t('switch_hint')}</span>
      </span>
      <span
        aria-hidden="true"
        className={cn(
          'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors',
          on ? 'bg-primary' : 'bg-secondary ring-1 ring-inset ring-border',
        )}
      >
        <span
          className={cn(
            'size-4 rounded-full bg-overlay shadow-sm transition-transform motion-reduce:transition-none',
            on ? 'translate-x-4 rtl:-translate-x-4' : 'translate-x-0',
          )}
        />
      </span>
    </button>
  );
}
