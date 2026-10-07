-- The company's default appearance (2026-10-07, by direction: "I want my
-- current setup to be the main default setup for everyone"): what a person
-- who has not chosen their own sees — the palette, the accent and every
-- layout and navigation setting. A person's own choice stays theirs; NULL
-- here is the built-in default, which fresh installs and the test databases
-- keep.
--
-- One jsonb value rather than a column per setting: the default is one
-- decision, written whole by "Make my appearance everyone's default" and
-- cleared whole by its reset, read once with the company row; a setting added
-- later is a key here, not another company column. Its keys and values are
-- held to the same lists as app_user's own columns (0220, 0407, 0417, 0418),
-- and tests/unit/appearance-settings.test.ts holds this list equal to the code.
--
-- company.ui_palette / ui_accent (0170/0171) are untouched: they never reach a
-- person's screen and keep meaning what they meant.
ALTER TABLE company ADD COLUMN IF NOT EXISTS ui_defaults jsonb;
--> statement-breakpoint
ALTER TABLE company ADD CONSTRAINT company_ui_defaults_known CHECK (
  ui_defaults IS NULL OR (
    jsonb_typeof(ui_defaults) = 'object'
    AND (ui_defaults - ARRAY['palette', 'accent', 'appearance', 'density', 'cornerStyle', 'contentWidth', 'borderStyle', 'shadow', 'componentSize', 'navigation', 'sidebar', 'sidebarGroups', 'sidebarColour', 'textSize', 'header', 'motion', 'tableStripes']) = '{}'::jsonb
    AND coalesce(ui_defaults->>'palette' IN ('sand', 'classic', 'slate', 'graphite', 'pearl', 'ivory_linen', 'glacier', 'sage_white', 'porcelain_rose', 'dune_bronze', 'harbor_mist', 'midnight', 'carbon', 'ocean', 'obsidian_plum', 'evergreen', 'espresso', 'lunar_slate'), true)
    AND coalesce(ui_defaults->>'accent' IN ('gold', 'red', 'blue', 'green', 'purple'), true)
    AND coalesce(ui_defaults->>'appearance' IN ('current', 'standard', 'enterprise', 'minimal', 'modern', 'command', 'studio'), true)
    AND coalesce(ui_defaults->>'density' IN ('comfortable', 'compact', 'spacious', 'airy'), true)
    AND coalesce(ui_defaults->>'cornerStyle' IN ('soft', 'rounded', 'sharp', 'subtle', 'pill'), true)
    AND coalesce(ui_defaults->>'contentWidth' IN ('fluid', 'contained', 'wide', 'full_width'), true)
    AND coalesce(ui_defaults->>'borderStyle' IN ('none', 'subtle', 'standard', 'strong'), true)
    AND coalesce(ui_defaults->>'shadow' IN ('none', 'subtle', 'soft', 'elevated'), true)
    AND coalesce(ui_defaults->>'componentSize' IN ('small', 'medium', 'large'), true)
    AND coalesce(ui_defaults->>'navigation' IN ('top', 'side', 'bottom'), true)
    AND coalesce(ui_defaults->>'sidebar' IN ('full', 'icons'), true)
    AND coalesce(ui_defaults->>'sidebarGroups' IN ('grouped', 'plain'), true)
    AND coalesce(ui_defaults->>'sidebarColour' IN ('default', 'highlight', 'accent'), true)
    AND coalesce(ui_defaults->>'textSize' IN ('smaller', 'default', 'larger'), true)
    AND coalesce(ui_defaults->>'header' IN ('sticky', 'static'), true)
    AND coalesce(ui_defaults->>'motion' IN ('full', 'reduced'), true)
    AND coalesce(ui_defaults->>'tableStripes' IN ('on', 'off'), true)
  )
);
