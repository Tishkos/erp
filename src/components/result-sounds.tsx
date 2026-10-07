'use client';

import { useEffect } from 'react';
import { burstGate, resultOfAddress, resultOfBanner, type SoundKind } from '@/lib/sound-rules';
import { armSounds, play, silenceForCamera } from '@/lib/sounds';
import { expectOwnChange } from './notifications/notification-store';

/**
 * The sound a form's result makes, for every screen at once (2026-10-06, by
 * direction: "when invoicing a document can you add a sound … nice sounds …
 * when an error or unfilled something missing another sound please").
 * Mounted once, in the signed-in layout; no screen is edited for it.
 *
 *   success / error   after the person sends a form, the first result that
 *                     shows: the address a server action came back to
 *                     (`?saved=1`, `?error=…`), else the banner that appeared
 *                     (`Flash`: `role="status"` saved, `role="alert"` refused).
 *                     Only within two minutes of a submit, so a page that is
 *                     merely opened with a banner on it stays quiet.
 *   missing           the browser refusing a submit for an empty required
 *                     field (`invalid`, caught on the way down): once per try,
 *                     however many fields are empty.
 *
 * A form marked `data-no-result-sound` (the chat's, which has its own sound)
 * arms nothing. Noah's camera session never sounds (`camera`).
 */
const ARMED_FOR_MS = 120_000;

export function ResultSounds({ camera = false }: { readonly camera?: boolean }) {
  useEffect(() => {
    if (camera) silenceForCamera();
    armSounds();

    let armedUntil = 0;
    let addressAtSubmit = '';
    const missing = burstGate(800);
    const settle = (result: SoundKind | null) => {
      if (!result) return;
      armedUntil = 0;
      play(result);
    };

    const onSubmit = (event: Event) => {
      const form = event.target instanceof HTMLFormElement ? event.target : null;
      if (form?.closest('[data-no-result-sound]')) return;
      armedUntil = Date.now() + ARMED_FOR_MS;
      addressAtSubmit = window.location.search;
      // A form may mark notifications read or unread: the bell's next change is the person's own.
      expectOwnChange();
    };
    const onInvalid = () => {
      if (missing()) play('missing');
    };

    const observer = new MutationObserver((records) => {
      if (Date.now() > armedUntil) return;
      // The address first: a server action that redirected says there how it went.
      const address = resultOfAddress(window.location.search);
      if (address && window.location.search !== addressAtSubmit) {
        settle(address);
        return;
      }
      let found: SoundKind | null = null;
      for (const record of records) {
        for (const node of record.addedNodes) {
          // A pop-up notification (`components/toasts`) is never a form's result, whatever its role.
          if (!(node instanceof Element) || node.closest('[data-toast-region]')) continue;
          for (const element of [node, ...node.querySelectorAll('[role="alert"], [role="status"]')]) {
            const result = resultOfBanner({
              role: element.getAttribute('role'),
              className: typeof element.className === 'string' ? element.className : '',
            });
            // Saved wins over an alert that happened to arrive on the same screen.
            if (result === 'success') found = 'success';
            else if (result === 'error' && found === null) found = 'error';
          }
        }
      }
      settle(found);
    });

    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener('submit', onSubmit, true);
    document.addEventListener('invalid', onInvalid, true);
    return () => {
      observer.disconnect();
      document.removeEventListener('submit', onSubmit, true);
      document.removeEventListener('invalid', onInvalid, true);
    };
  }, [camera]);

  return null;
}
