I want to expand the ERP's Appearance customization system, but there is one critical requirement:

## DO NOT CHANGE THE CURRENT DESIGN

The current ERP appearance, layout, theme, colors, spacing, components, navigation, tables, forms, dashboards, etc. are already approved.

**Do not redesign them. Do not replace them. Do not alter the default appearance.**

When a user opens the ERP after this update, it must look exactly as it does today.

The existing appearance and existing themes must remain unchanged unless the user explicitly selects a different appearance or theme.

Think of this as **adding customization options on top of the existing design**, not replacing the design.

---

# 1. EXISTING DESIGN = DEFAULT

Create an appearance preset called:

### Current / Default

This represents the ERP's existing appearance exactly.

It must preserve:

* Current spacing
* Current component sizes
* Current border radius
* Current sidebar
* Current navigation
* Current tables
* Current forms
* Current buttons
* Current cards
* Current typography
* Current shadows
* Current colors
* Current theme behavior

Do not approximate it.

Reuse the existing design tokens/styles so that the Current preset is effectively the existing system.

If a user does nothing, **nothing changes**.

---

# 2. EXISTING THEMES MUST REMAIN

Do not remove, rename, modify, or replace the existing themes.

All current themes must continue working exactly as they currently do.

The new Appearance system should be independent from the existing Theme system.

For example:

Current Theme: Dark
Appearance: Current

should look exactly like the ERP currently looks in Dark mode.

If the user selects:

Appearance: Enterprise

then Enterprise styling is applied while keeping the selected theme's colors.

If the user switches back to:

Appearance: Current

the ERP returns to the original design.

---

# 3. NEW APPEARANCE PRESETS

Add these NEW appearance options:

### Current

The existing ERP design.

### Standard

A balanced variation of the existing design.

### Enterprise

More information-dense and optimized for business users.

### Minimal

Cleaner, quieter and more whitespace-focused.

### Modern

A more contemporary SaaS-style variation.

### Command

Compact and optimized for power users who work with large amounts of information.

### Studio

More spacious and premium-looking.

These are ADDITIONAL choices.

They must not replace the Current appearance.

---

# 4. EXISTING SETTINGS + NEW SETTINGS

Keep the existing settings:

### Density

Current options:

* Comfortable
* Compact

Add:

* Spacious
* Airy

Do not remove the existing options.

---

### Corner Style

Keep:

* Soft
* Rounded

Add:

* Sharp
* Subtle
* Pill

---

### Content Width

Keep:

* Fluid
* Contained

Add:

* Wide
* Full Width

---

# 5. NEW ADVANCED SETTINGS

Add an expandable section:

## Advanced appearance

### Border style

* None
* Subtle
* Standard
* Strong

### Shadow

* None
* Subtle
* Soft
* Elevated

### Component size

* Small
* Medium
* Large

These settings should modify the existing components through design tokens.

---

# 6. DO NOT FORCE USERS INTO THE NEW SYSTEM

The user should never be forced to select a new appearance.

The initial state should be:

**Appearance: Current**

and whatever Theme the user currently has should remain selected.

Existing users should see **no visual difference after the update**.

This is extremely important.

---

# 7. APPEARANCE + THEME MUST WORK TOGETHER

Appearance controls the structure and visual behavior.

Theme controls the colors.

For example:

Current + Dark
Enterprise + Dark
Minimal + Dark
Command + Dark
Studio + Dark

should all use the same Dark theme colors while having different layout/visual characteristics.

Likewise:

Current + Light
Enterprise + Light
Minimal + Light
Command + Light
Studio + Light

should preserve the Light theme colors.

Do not duplicate themes for every appearance.

---

# 8. APPEARANCE SELECTION UI

Improve the Appearance settings page.

Do not make it look like a completely different application.

It should fit naturally into the existing ERP settings UI.

Add:

## Interface style

Show selectable cards:

**Current**
Existing ERP design

**Standard**
Balanced

**Enterprise**
Dense & efficient

**Minimal**
Clean & quiet

**Modern**
Contemporary

**Command**
Power user

**Studio**
Spacious & refined

Each card should contain a small live preview using actual ERP components.

The Current card should clearly show that it is the existing/default design.

---

# 9. LIVE CHANGES

When the user selects an appearance:

* Apply it immediately.
* Do not require a page reload.
* Do not require restarting the ERP.
* Do not require saving before previewing.

But the selected preference must be persisted so that it remains after refresh/relogin.

---

# 10. SAFE DESIGN-TOKEN ARCHITECTURE

Do not rewrite the entire frontend.

First inspect the existing styling/design system.

Create or extend a central design-token layer.

For example:

--erp-density
--erp-spacing
--erp-radius
--erp-control-height
--erp-content-width
--erp-border-style
--erp-shadow
--erp-component-size

The appearance presets should modify these values.

Avoid hardcoding appearance-specific styles throughout hundreds of components.

---

# 11. IMPORTANT: DO NOT CHANGE PRODUCTION

Work locally only.

Do NOT:

* Modify production
* Modify the production database
* Run migrations against production
* Change production configuration
* Replace existing production assets

First implement and test locally.

---

# 12. TEST THE EXISTING ERP

After implementation, verify that the Current appearance looks exactly as it did before.

Test:

* Dashboard
* Sidebar
* Header
* Tables
* Forms
* Accounting
* Inventory
* HR
* Projects
* Reports
* Modals
* Dropdowns
* Buttons
* Inputs
* Notifications
* Settings

Then test the new appearance presets.

If something breaks or looks wrong, fix the appearance layer rather than modifying business functionality.

---

# 13. MOST IMPORTANT RULE

This is an **additive customization feature**.

We are NOT redesigning the ERP.

We are adding:

Existing design
+
New optional appearance presets
+
New optional appearance controls

The current ERP design must remain the untouched default.

A user who never opens Appearance settings should experience **zero visual changes** after this implementation.

Only users who intentionally select a new Appearance or change an appearance setting should see a difference.

Build this carefully and locally first so I can visually evaluate the new styles before anything is considered production-ready.
