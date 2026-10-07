import type { Locator, Page } from '@playwright/test';

/**
 * A date field's form value, by its accessible name.
 *
 * Since the Intent UI date picker (2026-10-06) a date is Intent's DatePicker —
 * the control a person and assistive technology use — over the native
 * `<input type="date">` the form posts, which is hidden from assistive
 * technology so that there is one control per field. `getByLabel(…)` and
 * `input[name=…]` still find the native field; a role query has to say that
 * it wants the hidden one, which is all this does. `fill('2026-09-02')`,
 * `toHaveValue(…)` and `inputValue()` work on it as they always did, and the
 * picker follows. Fields of a closed dialog stay out, as they did.
 *
 * Counting hidden nodes also counts a required field's asterisk (hidden from
 * assistive technology, so not part of the name a person hears), so an exact
 * name allows one after it.
 */
export function dateField(
  scope: Page | Locator,
  name: string | RegExp,
  options: { readonly exact?: boolean } = {},
): Locator {
  const wanted =
    typeof name === 'string' && options.exact
      ? new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\*?\\s*$`)
      : name;
  return scope.getByRole('textbox', { name: wanted, includeHidden: true }).filter({ visible: true });
}
