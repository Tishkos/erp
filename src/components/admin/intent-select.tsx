'use client';

import { useTranslations } from 'next-intl';
import {
  Children,
  Fragment,
  isValidElement,
  useCallback,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type FocusEvent,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
} from 'react';
import { Autocomplete, useFilter } from 'react-aria-components/Autocomplete';
import { I18nProvider } from 'react-aria-components/I18nProvider';
import { ListBox } from 'react-aria-components/ListBox';
import { cn } from '@/components/intent/cn';
import { ChevronUpDownIcon } from '@/components/intent/icons';
import { PopoverContent } from '@/components/intent/popover';
import { SearchField, SearchInput } from '@/components/intent/search-field';
import { Select, SelectItem, SelectLabel, SelectSection, SelectTrigger } from '@/components/intent/select';
import {
  ButtonOverride,
  NameSource,
  accessibleNameOf,
  overlayLayer,
  portalTo,
  setFieldValue,
  useIsomorphicLayoutEffect,
  useRacLocale,
} from './intent-control-kit';

/**
 * A dropdown in Intent UI's look (2026-10-06, by direction: "drop down, date
 * picker — update them using the one we downloaded, everything").
 *
 * It is a drop-in for `<select>`: the same props, `<option>` children or an
 * `options` list. The native `<select>` stays — it is the field the form
 * posts, the control assistive technology and the keyboard use (one control
 * per field), and what `selectOption`, `getByLabel` and
 * `getByRole('combobox')` find. It lies under the Intent trigger, invisible;
 * the trigger is a picture of its value (hidden from assistive technology),
 * and pressing either opens Intent's own list — Intent's `Select`, its
 * popover and its items, with a search box above a long list. Choosing writes
 * the native field and fires its `input` and `change`, so the form and every
 * listener hear what they always heard. A `multiple` or sized list stays
 * native.
 */

export interface SelectChoice {
  readonly value: string;
  readonly label: string;
  /** Shown, but not choosable (a chart of accounts' rows that cannot be a parent). */
  readonly disabled?: boolean | undefined;
}

export interface IntentSelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> {
  /** The choices, when they are not written as `<option>` children. */
  readonly options?: readonly SelectChoice[] | undefined;
  /** A first, blank choice (with `options`). */
  readonly emptyLabel?: string | undefined;
  readonly children?: ReactNode;
  /** A search box above the list. By default a list longer than a dozen gets one. */
  readonly searchable?: boolean | undefined;
  /** The cell of an editable grid: the smaller control. */
  readonly compact?: boolean | undefined;
  readonly ref?: Ref<HTMLSelectElement> | undefined;
}

/** Longer than this, and a list is searched rather than scrolled. */
const SEARCH_AFTER = 12;

interface Choice {
  readonly key: string;
  readonly value: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly group: string | null;
}

interface Shown {
  readonly index: number;
  readonly value: string;
  readonly label: string;
}

const LIST_POPOVER =
  // As wide as the field, and wider for a long name (an account under its parents), within the screen.
  'min-w-(--trigger-width) max-w-[min(30rem,calc(100vw-1.5rem))] overflow-hidden *:data-[slot=popover-inner]:overflow-hidden';
const LIST_BOX =
  "grid max-h-[inherit] min-h-0 w-full flex-1 grid-cols-[auto_1fr] flex-col gap-y-1 overflow-y-auto p-1 outline-hidden *:[[role='group']+[role=group]]:mt-4 *:[[role='group']+[role=separator]]:mt-1";

export function IntentSelect(props: IntentSelectProps) {
  if (props.multiple || (props.size ?? 0) > 1) return <ListSelect {...props} />;
  return <SingleSelect {...props} />;
}

/** A list that shows several rows at once, or takes several choices: native. */
function ListSelect({ options, emptyLabel, children, searchable: _searchable, compact: _compact, ref, ...native }: IntentSelectProps) {
  return (
    <select ref={ref} {...native}>
      {children ?? optionElements(options, native.multiple ? undefined : emptyLabel)}
    </select>
  );
}

function SingleSelect({
  options,
  emptyLabel,
  children,
  searchable,
  compact,
  className,
  ref,
  onChange,
  onKeyDown,
  onFocus,
  onBlur,
  onInvalid,
  ...native
}: IntentSelectProps) {
  const t = useTranslations('controls');
  const tIntent = useTranslations('intent');
  const locale = useRacLocale();
  const { contains } = useFilter({ sensitivity: 'base' });
  const nameId = useId();
  const nativeRef = useRef<HTMLSelectElement | null>(null);
  const closing = useRef<number | undefined>(undefined);

  // What the trigger shows before the page can read the field: the same rule
  // the browser applies (the chosen value, else the first choice that can be
  // chosen), so the server's picture and the first client render agree.
  const [shown, setShown] = useState<Shown>(() =>
    guess(children !== undefined ? flatten(children) : listOf(options, emptyLabel), native.value ?? native.defaultValue),
  );
  const [name, setName] = useState('');
  const [list, setList] = useState<readonly Choice[] | null>(null);
  const [open, setOpen] = useState(false);
  const [seed, setSeed] = useState('');
  const [container, setContainer] = useState<Element | undefined>(undefined);
  const [ring, setRing] = useState(false);
  const [invalid, setInvalid] = useState(false);

  const setRefs = useCallback(
    (node: HTMLSelectElement | null) => {
      nativeRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as { current: HTMLSelectElement | null }).current = node;
    },
    [ref],
  );

  /** The trigger follows the field — after every render and every change. */
  const sync = useCallback(() => {
    const el = nativeRef.current;
    if (!el) return;
    const index = el.selectedIndex;
    const option = index >= 0 ? el.options[index] : undefined;
    const next: Shown = { index, value: el.value, label: option ? labelOf(option) : '' };
    setShown((was) => (was.index === next.index && was.value === next.value && was.label === next.label ? was : next));
    const accessible = accessibleNameOf(el);
    setName((was) => (was === accessible ? was : accessible));
  }, []);

  useIsomorphicLayoutEffect(sync);

  const openList = useCallback((typed = '') => {
    const el = nativeRef.current;
    if (!el || el.disabled) return;
    window.clearTimeout(closing.current);
    setList(readChoices(el));
    setSeed(typed);
    setContainer(overlayLayer(el));
    setOpen(true);
    // Focus goes back to the field when the list closes: it is the control.
    if (document.activeElement !== el) el.focus({ preventScroll: true });
  }, []);

  const closeList = useCallback(() => {
    setOpen(false);
    // The items stay for the closing animation, then go: a closed dropdown
    // keeps no second copy of its choices in the page.
    window.clearTimeout(closing.current);
    closing.current = window.setTimeout(() => setList(null), 300);
  }, []);

  const toggleList = () => (open ? closeList() : openList());

  const choose = useCallback(
    (key: string | number | null) => {
      const el = nativeRef.current;
      if (!el || key === null) return;
      const index = Number(key);
      if (!Number.isInteger(index) || index === el.selectedIndex) return;
      setFieldValue(el, () => {
        el.selectedIndex = index;
      });
      // A controlled field its owner did not change is put back by React
      // while the event is handled; read what it is now.
      sync();
    },
    [sync],
  );

  const many = list ? list.length > SEARCH_AFTER : (nativeRef.current?.options.length ?? 0) > SEARCH_AFTER;
  const withSearch = searchable ?? many;

  const onNativeKeyDown = (event: KeyboardEvent<HTMLSelectElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    const { key, altKey, ctrlKey, metaKey } = event;
    const opens =
      (altKey && (key === 'ArrowDown' || key === 'ArrowUp')) ||
      (!altKey && !ctrlKey && !metaKey && ['Enter', ' ', 'ArrowDown', 'ArrowUp', 'F4'].includes(key));
    if (opens) {
      event.preventDefault();
      openList();
      return;
    }
    const searches = searchable ?? (nativeRef.current?.options.length ?? 0) > SEARCH_AFTER;
    if (searches && key.length === 1 && !altKey && !ctrlKey && !metaKey) {
      event.preventDefault();
      openList(key);
    }
  };

  const items = list ? renderItems(list) : null;
  const isPlaceholder = shown.value === '';

  return (
    <span
      className={cn('relative block min-w-0 [--control-bg:var(--w-field,var(--ui-bg))]', className)}
      data-intent-control="select"
    >
      <select
        {...native}
        className="pointer-events-none absolute inset-0 z-0 m-0 size-full min-h-0 appearance-none opacity-0"
        onBlur={(event: FocusEvent<HTMLSelectElement>) => {
          setRing(false);
          onBlur?.(event);
        }}
        onChange={(event: ChangeEvent<HTMLSelectElement>) => {
          setInvalid(false);
          onChange?.(event);
          sync();
        }}
        onFocus={(event: FocusEvent<HTMLSelectElement>) => {
          setRing(event.currentTarget.matches(':focus-visible'));
          onFocus?.(event);
        }}
        onInvalid={(event) => {
          setInvalid(true);
          onInvalid?.(event);
        }}
        onKeyDown={onNativeKeyDown}
        ref={setRefs}
      >
        {children ?? optionElements(options, emptyLabel)}
      </select>
      <NameSource id={nameId} name={name} />
      {/* The picture takes the pointer itself, so the browser's own list
          never opens and the field keeps the focus. It opens on the click, not
          on the press: a list that appeared under a pressed button would take
          the release, and the click would land on whatever holds both — in a
          dialog, the dialog, which closes on a click of its own. */}
      <span
        aria-hidden="true"
        className="group/intent-select relative z-[1] block"
        onClick={(event) => {
          // A click in the list bubbles here through React's tree; only the picture opens it.
          if (!event.currentTarget.contains(event.target as Node)) return;
          // Not the label's click too: a label round the field would focus the
          // field again and close the list it just opened.
          event.preventDefault();
          toggleList();
        }}
        onMouseDown={(event) => event.preventDefault()}
      >
        <I18nProvider locale={locale}>
          <Select
            aria-labelledby={nameId}
            disabledKeys={list ? list.filter((choice) => choice.disabled).map((choice) => choice.key) : []}
            isDisabled={Boolean(native.disabled)}
            isInvalid={invalid}
            isOpen={open}
            onOpenChange={(next) => (next ? openList() : closeList())}
            onSelectionChange={choose}
            selectedKey={shown.index >= 0 ? String(shown.index) : null}
          >
            <ButtonOverride
              override={{ 'aria-labelledby': undefined, excludeFromTabOrder: true }}
            >
              <SelectTrigger
                className={cn(
                  // A document window's rule for its buttons must not reach the field's face.
                  'pointer-events-none justify-start font-normal shadow-xs group-hover/intent-select:border-muted-fg/30',
                  compact && 'min-h-8 py-1 ps-2 pe-1.5 sm:py-1 sm:ps-2 sm:pe-1.5',
                  ring && 'border-ring/70 ring-3 ring-ring/20',
                  invalid && 'border-danger-subtle-fg/70',
                )}
              >
                {/* The words are drawn from an attribute: they are the option's,
                    already in the page once, and a picture adds no second copy. */}
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate text-start before:content-[attr(data-text)] sm:text-sm/6',
                    isPlaceholder && 'text-muted-fg',
                  )}
                  data-slot="select-value"
                  data-text={shown.label || '\u00a0'}
                  dir={native.dir}
                />
                <ChevronUpDownIcon className="-me-1 size-5 shrink-0 text-muted-fg sm:size-4" data-slot="chevron" />
              </SelectTrigger>
            </ButtonOverride>
            {items ? (
              <PopoverContent
                {...portalTo(container)}
                className={cn(LIST_POPOVER, withSearch && 'sm:min-w-64')}
                placement="bottom start"
              >
                {withSearch ? (
                  <Autocomplete defaultInputValue={seed} filter={contains}>
                    <div className="border-b border-border p-1.5 [&_button]:min-h-0 [&_button]:border-0 [&_button]:bg-transparent [&_button]:shadow-none">
                      <SearchField aria-label={t('search')} autoFocus>
                        <SearchInput placeholder={t('search_placeholder')} />
                      </SearchField>
                    </div>
                    <ListBox
                      className={LIST_BOX}
                      layout="stack"
                      orientation="vertical"
                      renderEmptyState={() => (
                        <p className="col-span-full px-3 py-2 text-muted-fg text-sm">{tIntent('no_results')}</p>
                      )}
                    >
                      {items}
                    </ListBox>
                  </Autocomplete>
                ) : (
                  <ListBox className={LIST_BOX} layout="stack" orientation="vertical">
                    {items}
                  </ListBox>
                )}
              </PopoverContent>
            ) : null}
          </Select>
        </I18nProvider>
      </span>
    </span>
  );
}

function renderItems(list: readonly Choice[]): ReactNode {
  const out: ReactNode[] = [];
  let index = 0;
  while (index < list.length) {
    const choice = list[index]!;
    if (choice.group === null) {
      out.push(item(choice));
      index += 1;
      continue;
    }
    const group = choice.group;
    const members: Choice[] = [];
    while (index < list.length && list[index]!.group === group) {
      members.push(list[index]!);
      index += 1;
    }
    out.push(
      <SelectSection id={`g${members[0]!.key}`} key={`g${members[0]!.key}`} title={group}>
        {members.map(item)}
      </SelectSection>,
    );
  }
  return out;
}

function item(choice: Choice): ReactElement {
  return (
    <SelectItem id={choice.key} key={choice.key} textValue={choice.label || '\u00a0'}>
      <SelectLabel className={cn(choice.value === '' && 'text-muted-fg')}>{choice.label || '\u00a0'}</SelectLabel>
    </SelectItem>
  );
}

function readChoices(el: HTMLSelectElement): Choice[] {
  return Array.from(el.options, (option, index) => {
    const parent = option.parentElement;
    const group = parent instanceof HTMLOptGroupElement ? parent : null;
    return {
      key: String(index),
      value: option.value,
      label: labelOf(option),
      disabled: option.disabled || Boolean(group?.disabled),
      group: group ? group.label : null,
    };
  });
}

function labelOf(option: HTMLOptionElement): string {
  return (option.label || option.textContent || '').replace(/\s+/g, ' ').trim();
}

function optionElements(options: readonly SelectChoice[] | undefined, emptyLabel: string | undefined): ReactNode {
  return (
    <>
      {emptyLabel !== undefined ? <option value="">{emptyLabel}</option> : null}
      {(options ?? []).map((option, index) => (
        <option disabled={option.disabled} key={`${option.value}-${index}`} value={option.value}>
          {option.label}
        </option>
      ))}
    </>
  );
}

interface Flat {
  readonly value: string;
  readonly label: string;
  readonly disabled: boolean;
}

function listOf(options: readonly SelectChoice[] | undefined, emptyLabel: string | undefined): Flat[] {
  const out: Flat[] = [];
  if (emptyLabel !== undefined) out.push({ value: '', label: emptyLabel, disabled: false });
  for (const option of options ?? []) out.push({ value: option.value, label: option.label, disabled: Boolean(option.disabled) });
  return out;
}

/** The `<option>`s written as children, in the order the browser will hold them. */
function flatten(children: ReactNode, groupDisabled = false, out: Flat[] = []): Flat[] {
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    const element = child as ReactElement<{ value?: unknown; disabled?: boolean; children?: ReactNode; label?: string }>;
    if (element.type === 'option') {
      const text = textOfNode(element.props.children).replace(/\s+/g, ' ').trim();
      const label = element.props.label ?? text;
      out.push({
        value: element.props.value === undefined ? text : String(element.props.value),
        label,
        disabled: Boolean(element.props.disabled) || groupDisabled,
      });
    } else if (element.type === 'optgroup') {
      flatten(element.props.children, groupDisabled || Boolean(element.props.disabled), out);
    } else if (element.type === Fragment) {
      flatten(element.props.children, groupDisabled, out);
    }
  });
  return out;
}

function textOfNode(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'bigint') return String(node);
  if (Array.isArray(node)) return node.map(textOfNode).join('');
  if (isValidElement(node)) return textOfNode((node.props as { children?: ReactNode }).children);
  return '';
}

function guess(choices: readonly Flat[], value: SelectHTMLAttributes<HTMLSelectElement>['value']): Shown {
  const wanted = value === undefined || value === null ? undefined : Array.isArray(value) ? String(value[0] ?? '') : String(value);
  let index = wanted === undefined ? -1 : choices.findIndex((choice) => choice.value === wanted);
  if (index < 0) index = choices.findIndex((choice) => !choice.disabled);
  const choice = index >= 0 ? choices[index] : undefined;
  return { index, value: choice?.value ?? '', label: choice?.label ?? '' };
}
