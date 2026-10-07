'use client';

import { useLocale } from 'next-intl';
import { useEffect, useLayoutEffect, type ReactNode } from 'react';
import { ButtonContext } from 'react-aria-components/Button';
import { useSlottedContext } from 'react-aria-components/slots';

/**
 * What the Intent UI dropdown and date picker share (2026-10-06, by direction:
 * "drop down, date picker — update them using the one we downloaded,
 * everything").
 *
 * Both keep a real `<select>` / `<input type="date">` as the form's field. A
 * server action reads `FormData`, other client code listens to the form's
 * `input` events and reads `form.elements`, and the end-to-end suite drives the
 * fields by name and by label — so the field a form posts is the element it
 * always was, and the Intent control is kept in step with it both ways.
 */

export const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * React Aria's locale: the person's language, always the Gregorian calendar,
 * and the digits `formatBusinessDate` prints on the server — Latin, which is
 * what ICU 78 gives `ar` — fixed rather than left to the browser's own ICU,
 * so a picker and every printed date agree on every machine.
 */
export function useRacLocale(): string {
  return `${useLocale()}-u-ca-gregory-nu-latn`;
}

/**
 * Sets a field's value the way a person would have: through the prototype's
 * setter, so React's value tracker sees a change, then `input` and `change`
 * events that bubble to the form — the due-date field, the currency box and
 * every `form.addEventListener('input', …)` hear the Intent control exactly as
 * they heard the native one.
 */
export function setFieldValue(element: HTMLInputElement | HTMLSelectElement, apply: () => void): void {
  apply();
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

export function writeInputValue(element: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setFieldValue(element, () => (setter ? setter.call(element, value) : (element.value = value)));
}

/**
 * Where a control's list or calendar is drawn.
 *
 * Outside a dialog: `<body>`, React Aria's default (undefined here). Inside a
 * modal `<dialog>` that would not do — the dialog sits in the top layer and
 * makes the rest of the page inert, so an overlay portalled to `<body>` opens
 * behind it and refuses the mouse, and one portalled into the dialog is
 * clipped by the dialog's own scrolling. So each dialog gets one layer of its
 * own: an empty, zero-sized box fixed at the viewport's corner, a child of the
 * dialog (not inert), shown in the top layer with the Popover API (above the
 * dialog, clipped by nothing). Overlays are portalled into it and positioned
 * against the viewport, which is what React Aria's positioning reads.
 */
export function overlayLayer(from: Element | null): HTMLElement | undefined {
  const dialog = (from?.closest('dialog') as HTMLDialogElement | null) ?? null;
  if (!dialog || typeof HTMLElement.prototype.showPopover !== 'function') return undefined;
  let layer = dialog.querySelector<HTMLElement>(':scope > [data-intent-layer]');
  if (!layer) {
    layer = document.createElement('div');
    layer.setAttribute('data-intent-layer', '');
    layer.setAttribute('popover', 'manual');
    Object.assign(layer.style, {
      position: 'fixed',
      inset: '0 auto auto 0',
      width: '0',
      height: '0',
      margin: '0',
      padding: '0',
      border: '0',
      overflow: 'visible',
      background: 'transparent',
    });
    dialog.appendChild(layer);
  }
  // A dialog opened again later is above an older layer in the top layer, so
  // the first overlay of a visit brings the layer back on top.
  if (layer.childElementCount === 0) {
    try {
      if (layer.matches(':popover-open')) layer.hidePopover();
      layer.showPopover();
    } catch {
      // The browser refused: the overlay is drawn inside the dialog instead.
    }
  }
  return layer;
}

export function portalTo(layer: Element | undefined): { UNSTABLE_portalContainer?: Element } {
  return layer ? { UNSTABLE_portalContainer: layer } : {};
}

/**
 * The accessible name of a field, read from the page: its `aria-label`, the
 * elements its `aria-labelledby` names, else its `<label>` — without the
 * control's own text and without what is hidden from assistive technology
 * (the asterisk of a required field).
 */
export function accessibleNameOf(element: HTMLInputElement | HTMLSelectElement | null): string {
  if (!element) return '';
  const own = element.getAttribute('aria-label');
  if (own?.trim()) return own.trim();
  const ids = element.getAttribute('aria-labelledby');
  if (ids?.trim()) {
    return ids
      .trim()
      .split(/\s+/)
      .map((id) => textOf(document.getElementById(id)))
      .filter(Boolean)
      .join(' ');
  }
  const label = element.labels?.[0];
  return textOf(label ?? null);
}

function textOf(node: Element | null): string {
  if (!node) return '';
  const copy = node.cloneNode(true) as Element;
  for (const drop of copy.querySelectorAll('select, input, textarea, [data-intent-control], [aria-hidden="true"]')) drop.remove();
  return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * The name the Intent control is read by.
 *
 * Assistive technology reads exactly one control per field: the Intent one for
 * a date, the native `<select>` for a dropdown. The native date input is
 * hidden from it, and so the Intent picker needs the field's name — but not
 * through `aria-label` or a label's text, which are also how a test asks for
 * "the field labelled Due date": two fields answering to one label would be
 * one too many. An image's `alt`, named by `aria-labelledby`, is a name
 * assistive technology reads and a label lookup does not.
 */
export function NameSource({ id, name }: { readonly id: string; readonly name: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img alt={name} hidden id={id} />;
}

/**
 * Re-provides React Aria's button context with some of its props replaced —
 * how the vendored triggers are told to stay out of the tab order, or to be
 * named by their own words, without editing `src/components/intent/*`.
 */
export function ButtonOverride({
  override,
  children,
}: {
  readonly override: Record<string, unknown>;
  readonly children: ReactNode;
}) {
  const context = useSlottedContext(ButtonContext) ?? {};
  return <ButtonContext.Provider value={{ ...context, ...override }}>{children}</ButtonContext.Provider>;
}
