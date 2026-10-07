-- The side panel's colour (2026-10-07, by direction: "left panel colour change
-- to highlight colour, please, I need that option"): the page's own surface,
-- a soft wash of the accent, or the accent itself. Each user's own, beside
-- 0407's navigation settings and 0417's grouping, and like them NULL until
-- chosen: NULL reads as 'default'.
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS ui_sidebar_colour text;
--> statement-breakpoint
ALTER TABLE app_user ADD CONSTRAINT app_user_ui_sidebar_colour_known
  CHECK (ui_sidebar_colour IS NULL OR ui_sidebar_colour IN ('default', 'highlight', 'accent'));
