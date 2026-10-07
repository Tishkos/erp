'use client';

import { parseDate, today, type CalendarDate, type DateValue } from '@internationalized/date';
import {
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FocusEvent,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type Ref,
} from 'react';
import {
  Calendar as CalendarPrimitive,
  CalendarCell,
  CalendarGrid,
  CalendarGridBody,
  CalendarMonthPicker,
  CalendarYearPicker,
} from 'react-aria-components/Calendar';
import { composeRenderProps } from 'react-aria-components/composeRenderProps';
import { DatePicker as DatePickerPrimitive } from 'react-aria-components/DatePicker';
import { Heading } from 'react-aria-components/Heading';
import { I18nProvider, useLocale as useAriaLocale } from 'react-aria-components/I18nProvider';
import { Button } from '@/components/intent/button';
import { CalendarGridHeader } from '@/components/intent/calendar';
import { cn } from '@/components/intent/cn';
import { DatePickerTrigger } from '@/components/intent/date-picker';
import { fieldStyles } from '@/components/intent/field';
import { ChevronLeftIcon, ChevronRightIcon } from '@/components/intent/icons';
import { ModalContent } from '@/components/intent/modal';
import { PopoverContent } from '@/components/intent/popover';
import { Select, SelectContent, SelectItem, SelectLabel, SelectTrigger } from '@/components/intent/select';
import { useIsMobile } from '@/components/intent/use-mobile';
import {
  ButtonOverride,
  NameSource,
  accessibleNameOf,
  overlayLayer,
  portalTo,
  useIsomorphicLayoutEffect,
  useRacLocale,
  writeInputValue,
} from './intent-control-kit';

/**
 * A date in Intent UI's date picker (2026-10-06, by direction: "drop down,
 * date picker — update them using the one we downloaded, everything").
 *
 * A drop-in for `<input type="date">`. Intent's DatePicker — its segments and
 * its calendar — is the control a person and assistive technology use, in the
 * person's language (Gregorian; Arabic digits in Arabic, as every printed date
 * has them). The native date input stays underneath, hidden from assistive
 * technology: it is the field the form posts (`yyyy-mm-dd`, or nothing), with
 * its `name`, `id`, `required`, `min` and `max`, and the field a label and a
 * test find. The two are kept in step both ways — a date chosen in the picker
 * is written to the field with its `input` and `change` events, and a value
 * written to the field (by a test, or by the due-date field following the
 * terms) is drawn by the picker.
 */

export interface IntentDateFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'defaultValue' | 'min' | 'max' | 'size'> {
  readonly value?: string | undefined;
  readonly defaultValue?: string | null | undefined;
  /** The earliest and latest dates allowed, `yyyy-mm-dd`. */
  readonly min?: string | undefined;
  readonly max?: string | undefined;
  /** The field's name for assistive technology, when the page knows it (else read from its label). */
  readonly label?: string | undefined;
  /** The cell of an editable grid: the smaller control. */
  readonly compact?: boolean | undefined;
  readonly ref?: Ref<HTMLInputElement> | undefined;
}

/** "Today" for the calendar's first page — the company's day (Asia/Baghdad), not the browser's. */
const BUSINESS_ZONE = 'Asia/Baghdad';

export function IntentDateField({
  value,
  defaultValue,
  min,
  max,
  label,
  compact,
  className,
  ref,
  onChange,
  onFocus,
  onBlur,
  onInvalid,
  onKeyDown,
  title,
  ...native
}: IntentDateFieldProps) {
  const locale = useRacLocale();
  const nameId = useId();
  const nativeRef = useRef<HTMLInputElement | null>(null);
  const wrapperRef = useRef<HTMLSpanElement | null>(null);
  const keepFocus = useRef(false);

  const [iso, setIso] = useState(() => isoOf(value ?? defaultValue));
  const [name, setName] = useState(label ?? native['aria-label'] ?? '');
  const [invalid, setInvalid] = useState(false);
  const [open, setOpen] = useState(false);
  const [layer, setLayer] = useState<HTMLElement | undefined>(undefined);
  const [firstPage] = useState(() => today(BUSINESS_ZONE));

  const setRefs = useCallback(
    (node: HTMLInputElement | null) => {
      nativeRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as { current: HTMLInputElement | null }).current = node;
    },
    [ref],
  );

  /** The picker follows the field after every render: a value React or a test wrote is drawn. */
  const sync = useCallback(() => {
    const el = nativeRef.current;
    if (!el) return;
    setIso((was) => (was === el.value ? was : el.value));
    if (label === undefined) {
      const accessible = accessibleNameOf(el);
      setName((was) => (was === accessible ? was : accessible));
    }
  }, [label]);

  useIsomorphicLayoutEffect(sync);

  const commit = useCallback(
    (date: DateValue | null) => {
      const el = nativeRef.current;
      if (!el) return;
      const next = date ? date.toString().slice(0, 10) : '';
      if (next === el.value) return;
      writeInputValue(el, next);
      sync();
    },
    [sync],
  );

  const firstSegment = () =>
    wrapperRef.current?.querySelector<HTMLElement>('[role="spinbutton"]:not([aria-readonly="true"])') ??
    wrapperRef.current?.querySelector<HTMLElement>('[role="spinbutton"]');

  const parsed = useMemo(() => parse(iso), [iso]);
  const minValue = useMemo(() => parse(min ?? ''), [min]);
  const maxValue = useMemo(() => parse(max ?? ''), [max]);

  return (
    <span
      className={cn('relative block min-w-0 [--control-bg:var(--w-field,var(--ui-bg))]', className)}
      data-intent-control="date"
      onClick={(event) => {
        // A label round the field must not take the click as well: it would
        // move the focus from the part pressed to the first.
        if (event.currentTarget.contains(event.target as Node) && event.target !== nativeRef.current) event.preventDefault();
      }}
      onKeyDownCapture={(event: KeyboardEvent<HTMLSpanElement>) => {
        // Enter in a date submits its form, as it does in the native field.
        if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
        if ((event.target as HTMLElement).getAttribute('role') !== 'spinbutton') return;
        const form = nativeRef.current?.form;
        const submit = form?.querySelector<HTMLButtonElement | HTMLInputElement>(
          'button[type="submit"]:not([disabled]), button:not([type]):not([disabled]), input[type="submit"]:not([disabled])',
        );
        if (submit) window.setTimeout(() => submit.click(), 0);
      }}
      ref={wrapperRef}
      {...(title ? { title } : {})}
    >
      <input
        {...native}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-0 m-0 size-full min-h-0 opacity-0"
        max={max}
        min={min}
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          setInvalid(false);
          onChange?.(event);
          sync();
        }}
        onFocus={() => {
          // The browser focuses an invalid field to say why; let it. Any other
          // focus — its label pressed, a script — belongs to the picker.
          if (keepFocus.current) {
            keepFocus.current = false;
            return;
          }
          firstSegment()?.focus();
        }}
        onInvalid={(event) => {
          setInvalid(true);
          keepFocus.current = true;
          window.setTimeout(() => {
            keepFocus.current = false;
          }, 0);
          onInvalid?.(event);
        }}
        onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
          onKeyDown?.(event);
          if (event.key === 'Tab' || event.defaultPrevented) return;
          event.preventDefault();
          firstSegment()?.focus();
        }}
        ref={setRefs}
        tabIndex={-1}
        type="date"
        {...(value !== undefined ? { value } : { defaultValue: defaultValue ?? '' })}
      />
      <NameSource id={nameId} name={name} />
      <I18nProvider locale={locale}>
        <DatePickerPrimitive
          aria-labelledby={nameId}
          {...(native['aria-describedby'] ? { 'aria-describedby': native['aria-describedby'] } : {})}
          className={fieldStyles({ className: 'group relative z-[1]' })}
          data-slot="control"
          granularity="day"
          isDisabled={Boolean(native.disabled)}
          isInvalid={invalid}
          isOpen={open}
          isReadOnly={Boolean(native.readOnly)}
          isRequired={Boolean(native.required)}
          // Focus and blur are the picker's — its segments, its button and its
          // calendar together (React Aria keeps them quiet while the calendar
          // is open) — not the hidden field's.
          {...(onBlur ? { onBlur: onBlur as unknown as (event: FocusEvent<Element>) => void } : {})}
          {...(onFocus ? { onFocus: onFocus as unknown as (event: FocusEvent<Element>) => void } : {})}
          onChange={commit}
          onOpenChange={(next) => {
            if (next) setLayer(overlayLayer(wrapperRef.current));
            setOpen(next);
          }}
          placeholderValue={firstPage}
          shouldForceLeadingZeros
          validationBehavior="aria"
          value={parsed}
          {...(minValue ? { minValue } : {})}
          {...(maxValue ? { maxValue } : {})}
        >
          <ButtonOverride override={{ 'aria-labelledby': undefined }}>
            <DatePickerTrigger
              className={cn(
                '[&_[data-slot=control]>div]:pe-10 [&_[data-slot=control]>div]:shadow-xs sm:[&_[data-slot=control]>div]:pe-9',
                // The calendar button is an icon on the field, not one of the window's buttons.
                '[&_[data-slot=date-picker-trigger]]:h-full [&_[data-slot=date-picker-trigger]]:min-h-0 [&_[data-slot=date-picker-trigger]]:rounded-e-lg [&_[data-slot=date-picker-trigger]]:border-0 [&_[data-slot=date-picker-trigger]]:bg-transparent [&_[data-slot=date-picker-trigger]]:shadow-none',
                compact && '[&_[data-slot=control]>div]:py-1 [&_[data-slot=control]>div]:ps-2 sm:[&_[data-slot=control]>div]:py-1',
              )}
            />
          </ButtonOverride>
          <DateOverlay layer={layer} />
        </DatePickerPrimitive>
      </I18nProvider>
    </span>
  );
}

function DateOverlay({ layer }: { readonly layer: HTMLElement | undefined }) {
  const isMobile = useIsMobile();
  return isMobile ? (
    <ModalContent closeButton={false} {...portalTo(layer)}>
      <div className="flex justify-center p-6">
        <IntentCalendar layer={layer} />
      </div>
    </ModalContent>
  ) : (
    <PopoverContent
      {...portalTo(layer)}
      arrow={false}
      className="flex min-w-auto max-w-none snap-x justify-center p-4 sm:min-w-[16.5rem] sm:max-w-2xs sm:p-2 sm:pt-3"
      placement="bottom start"
    >
      <IntentCalendar layer={layer} />
    </PopoverContent>
  );
}

/**
 * Intent's Calendar (`@/components/intent/calendar`), with its month and year
 * pickers told where to open: inside a dialog they open in the dialog's layer,
 * above the calendar, not behind the dialog. The grid and its cells are
 * Intent's, class for class.
 */
function IntentCalendar({ layer }: { readonly layer: HTMLElement | undefined }) {
  return (
    <CalendarPrimitive data-slot="calendar">
      <IntentCalendarHeader layer={layer} />
      <CalendarGrid>
        <CalendarGridHeader />
        <CalendarGridBody>
          {(date) => (
            <CalendarCell
              className={composeRenderProps('', (className, { isSelected, isToday, isDisabled, isOutsideMonth }) =>
                cn(
                  'relative flex size-11 cursor-default items-center justify-center rounded-lg text-fg tabular-nums outline-hidden hover:bg-secondary-fg/15 sm:size-9 sm:text-sm/6 forced-colors:text-[ButtonText] forced-colors:outline-0',
                  'focus-visible:ring-2 focus-visible:ring-ring',
                  isSelected &&
                    'bg-primary pressed:bg-primary text-primary-fg hover:bg-primary/90 data-invalid:bg-danger data-invalid:text-danger-fg forced-colors:bg-[Highlight] forced-colors:text-[Highlight] forced-colors:data-invalid:bg-[Mark]',
                  isDisabled && 'text-muted-fg forced-colors:text-[GrayText]',
                  isOutsideMonth && !isSelected && 'text-muted-fg/70',
                  isToday &&
                    'after:pointer-events-none after:absolute after:bottom-1 after:left-1/2 after:z-10 after:size-0.75 after:-translate-x-1/2 after:rounded-full after:bg-primary selected:after:bg-primary-fg focus-visible:after:bg-primary-fg',
                  className,
                ),
              )}
              date={date}
            />
          )}
        </CalendarGridBody>
      </CalendarGrid>
    </CalendarPrimitive>
  );
}

function IntentCalendarHeader({ layer }: { readonly layer: HTMLElement | undefined }) {
  const { direction } = useAriaLocale();
  const popover = portalTo(layer);
  return (
    <header className="flex w-full justify-between gap-1.5 ps-1.5 pe-1 pt-1 pb-5 sm:pb-4" data-slot="calendar-header">
      <div className="flex items-center gap-1.5">
        <CalendarMonthPicker>
          {({ items, ...props }) => (
            <Select {...props}>
              <SelectTrigger />
              <SelectContent items={items} popover={popover}>
                {(entry) => (
                  <SelectItem textValue={entry.formatted}>
                    <SelectLabel>{entry.formatted}</SelectLabel>
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
          )}
        </CalendarMonthPicker>
        <CalendarYearPicker>
          {({ items, ...props }) => (
            <Select {...props}>
              <SelectTrigger />
              <SelectContent items={items} popover={popover}>
                {(entry) => (
                  <SelectItem textValue={entry.formatted}>
                    <SelectLabel>{entry.formatted}</SelectLabel>
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
          )}
        </CalendarYearPicker>
      </div>
      <Heading className="sr-only" />
      <div className="flex items-center gap-1">
        <Button className="size-8 sm:size-7 **:[svg]:text-fg" intent="plain" isCircle size="sq-sm" slot="previous">
          {direction === 'rtl' ? <ChevronRightIcon /> : <ChevronLeftIcon />}
        </Button>
        <Button className="size-8 sm:size-7 **:[svg]:text-fg" intent="plain" isCircle size="sq-sm" slot="next">
          {direction === 'rtl' ? <ChevronLeftIcon /> : <ChevronRightIcon />}
        </Button>
      </div>
    </header>
  );
}

function isoOf(raw: string | null | undefined): string {
  const text = (raw ?? '').trim();
  // The browser keeps only a whole `yyyy-mm-dd`; so does the picker.
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && parse(text) ? text : '';
}

function parse(text: string): CalendarDate | null {
  if (!/^\d{4}-\d{2}-\d{2}/.test(text)) return null;
  try {
    return parseDate(text.slice(0, 10));
  } catch {
    return null;
  }
}
