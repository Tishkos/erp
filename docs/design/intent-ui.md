# The Intent UI design (2026-10-06)

By direction (2026-10-06): *"the current system looks extremely old — I want to
update the UI completely, replace all components … the invoicing forms are good
but the UI is not … mostly only UI design … I want to see Intent UI … most
modern, friendly"*. This replaces the standing rule "screens copy existing
models — the design must not change": the **layout and fields** of every screen
stay (an invoice form keeps its fields, order and lines), the **look** is
Intent UI's (https://intentui.com — React Aria Components + Tailwind CSS v4).

## What is where

| Piece | Path |
|---|---|
| Intent UI components (vendored, adapted) | `src/components/intent/*` — import `@/components/intent/<name>` |
| Their icons | `src/components/intent/icons.tsx` — lucide-react under Heroicons names; use **lucide-react** directly everywhere else |
| Class helpers | `src/components/intent/cn.ts` (`cn`, `twJoin`), `src/components/intent/primitive.ts` (`cx`) |
| Theme | `src/app/intent-theme.css` — Tailwind colour names → `--ui-*` → the palette's `--w-*` |
| Palettes / accents | `src/components/admin/admin.module.css` (`--w-*`, `--w-primary`, `--w-primary-ink`, `--w-primary-strong`) |
| Cascade | `src/app/globals.css` header: `theme, base, legacy, components, utilities` — every hand-written stylesheet is inside `@layer legacy`, so a Tailwind utility always wins over it, and Tailwind's reset never does |

## Tokens — never a hex, never a palette name

In TSX use the Tailwind colour names; in CSS use the `--ui-*` variables. Both
follow all 18 palettes × 5 accents, light and dark, automatically.

| Use | Tailwind | CSS |
|---|---|---|
| Page canvas (behind cards) | `bg-[var(--w-canvas)]` | `var(--w-canvas)` |
| Card / window / popover surface | `bg-overlay` (cards) `bg-bg` (page) | `var(--ui-overlay)` / `var(--ui-bg)` |
| Text / secondary text | `text-fg` / `text-muted-fg` | `var(--ui-fg)` / `var(--ui-muted-fg)` |
| Hairline / control border | `border-border` / `border-input` | `var(--ui-border)` / `var(--ui-input)` |
| Subtle fill (table head, hover) | `bg-muted` / `bg-secondary` | `var(--ui-muted)` / `var(--ui-secondary)` |
| Primary action | `bg-primary text-primary-fg` | `var(--ui-primary)` / `var(--ui-primary-fg)` |
| Selected / active tint | `bg-primary-subtle text-primary-subtle-fg` | `var(--ui-primary-subtle)` / `var(--ui-primary-subtle-fg)` |
| Focus | `focus-visible:ring-4 ring-ring/20 border-ring` | `outline: 2px solid var(--ui-ring)` or `box-shadow: 0 0 0 4px color-mix(in oklab, var(--ui-ring) 20%, transparent)` |
| Status | `bg-success-subtle text-success-subtle-fg`, `warning-…`, `danger-…`, `info-subtle…` | `--ui-success-subtle(-fg)` … |
| Charts | `--color-chart-1..5` (`var(--color-chart-1)`) | `var(--ui-chart-1)` … |

Dark: the `dark:` variant means "a dark palette is on" (seven of them). Prefer
tokens to `dark:`.

## Shape and rhythm

* **Radius**: controls and buttons `rounded-lg` (`var(--radius-lg)` = 0.5rem);
  cards, windows, dialogs, popovers `rounded-xl` (0.7rem); chips `rounded-full`
  only for counts and avatars, status badges `rounded-md`.
* **Elevation**: cards `shadow-xs` + 1px `border-border`; popovers / menus
  `shadow-lg`; dialogs `shadow-xl`, overlay `bg-black/25 backdrop-blur-[1px]`
  (dark: `bg-black/50`). No gradients, no inset bevels, no coloured rules under
  titles.
* **Type** (the root is 90%, by direction — don't change `html { font-size }`):
  body and table text `text-sm` (0.875rem); labels `text-sm font-medium`; hints
  and meta `text-xs text-muted-fg`; card / window titles `text-base
  font-semibold`; page title `text-xl font-semibold tracking-tight` (no tracking
  in Arabic). Numbers `tabular-nums`. Inter for Latin, Noto Sans Arabic for
  Arabic — inherit, never name a font.
* **Spacing**: card padding `p-4`/`p-5`, gaps `gap-4`; form grids `gap-x-4
  gap-y-3`; table cells `px-3 py-2` (registers `py-2.5`); controls `h-9`
  (`min-h-9`), small `h-8`.
* **Tables**: header row `bg-muted text-muted-fg text-xs font-medium`, rows
  divided by `border-border`, hover `bg-muted/60`, numbers right-aligned
  (`text-end tabular-nums`), the totals row `font-semibold bg-muted`. No
  vertical grid lines except in editable line grids.
* **Buttons**: Intent's `buttonStyles` (`@/components/intent/button`):
  `intent="primary"` for the one main action, `outline` for the rest, `plain`
  for icon-only, `danger` for destructive. In CSS, the same look: primary =
  `background: var(--ui-primary); color: var(--ui-primary-fg); border:
  1px solid color-mix(in oklab, var(--ui-primary) 85%, black)`; outline =
  `background: transparent; border: 1px solid var(--ui-border)`; hover =
  `color-mix(in oklab, … 90%, var(--ui-primary-fg) 10%)`.
* **Icons**: lucide, `size-4` in buttons, `strokeWidth` default.
* **Motion**: Intent's own (`entering:`/`exiting:` fade+zoom); respect
  `prefers-reduced-motion`.

## Rules that do not change

* **Right to left**: logical properties only (`ms-`, `pe-`, `start-`,
  `border-s`, `inset-inline-*`, `margin-inline`); a chevron that points
  "forward" gets `rtl:-scale-x-100`. Every screen is checked in Arabic at 390px.
* **Server first**: pages stay server components; forms post to server actions
  through native `<form action>`. Interactive Intent components are client
  components — pass them serialisable props (and server actions), never
  functions created on the server.
* **Dropdowns and dates are Intent's, over the native field the form posts**
  (2026-10-06, by direction: "drop down, date picker — use the one we
  downloaded, everything"). `IntentSelect`
  (`src/components/admin/intent-select.tsx`; searchable over 12 options) and
  `IntentDateField` (`intent-date-field.tsx`, Intent's DatePicker, Gregorian,
  in the person's language) draw the control people use; the real `<select>` /
  `<input type="date">` stays underneath with the same `name`, `id`,
  `required` and value, so server actions read what they always read and the
  e2e suite's `selectOption` / `getByLabel(...).fill('yyyy-mm-dd')` keep
  working. A date field is not a `textbox` to the tests any more — find it with
  `tests/e2e/support/controls.ts` › `dateField`. The shared `Select` and
  `Field type="date"` use them; a new dropdown or date uses them too. Inside a
  modal dialog the list opens in the dialog's own top layer
  (`intent-control-kit.tsx`). Multi-selects, sized lists and typed
  "type a name" boxes (`<input list>`) stay native.
* **Plain text fields stay native** (`<input>`, `<textarea>`), styled as
  Intent's `Input`. Their outline is `--ui-input` (about 3:1 against the field
  on every palette), and they keep it under every Border style — None and
  Subtle soften panels and tables only.
* **Test hooks**: never change a control's `name`, `id`, label text, role,
  `aria-*`, `data-*` attribute or a heading's text — the e2e suite finds things
  by them. Class names may change.
* **Words**: no new user-facing text without both `messages/en.json` and
  `messages/ar.json`.
* **Accessibility**: text contrast ≥ 4.5:1 on its surface in every palette
  (the theme-readability spec checks it); visible focus on everything
  focusable; `forced-colors` keeps native rendering.
* **Print**: `src/components/print/print.module.css` (paper) is not part of
  the redesign.

## Checking a screen

The dev server for the redesign runs from the worktree on
`http://localhost:3300` against its own seeded database `erp_ui`
(`admin@example.com` / `Ledger-Trial-Balance-7`). Screenshots:
`MSYS_NO_PATHCONV=1 SHOTS_VIEWS=en-desktop,ar-phone node <job tmp>/shots.mjs <outDir> /route …`.
