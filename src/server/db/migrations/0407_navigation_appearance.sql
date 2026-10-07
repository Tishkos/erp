-- Navigation and reading settings, each user's own (2026-10-06, by direction:
-- "in settings, make sure you can move the navbar to a side panel, with icons,
-- nicely … user side view / top view, a lot of customization", then "navbar in
-- bottom … make customization so good").
--
-- Beside 0220's seven layout settings, and like them NULL until the person
-- chooses: NULL reads as the default (the top bar, names beside the icons, the
-- 90% text, a top bar that stays in view, motion, striped tables). A NULL here
-- never marks an account as one whose old browser choices still need adopting
-- — that is 0220's seven columns alone (services/user-appearance.ts).
-- The lists are the ones in domain/appearance.ts (APPEARANCE_CHOICES).
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS ui_navigation text;
--> statement-breakpoint
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS ui_sidebar text;
--> statement-breakpoint
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS ui_text_size text;
--> statement-breakpoint
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS ui_header text;
--> statement-breakpoint
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS ui_motion text;
--> statement-breakpoint
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS ui_table_stripes text;
--> statement-breakpoint
ALTER TABLE app_user ADD CONSTRAINT app_user_ui_navigation_known
  CHECK (ui_navigation IS NULL OR ui_navigation IN ('top', 'side', 'bottom'));
--> statement-breakpoint
ALTER TABLE app_user ADD CONSTRAINT app_user_ui_sidebar_known
  CHECK (ui_sidebar IS NULL OR ui_sidebar IN ('full', 'icons'));
--> statement-breakpoint
ALTER TABLE app_user ADD CONSTRAINT app_user_ui_text_size_known
  CHECK (ui_text_size IS NULL OR ui_text_size IN ('smaller', 'default', 'larger'));
--> statement-breakpoint
ALTER TABLE app_user ADD CONSTRAINT app_user_ui_header_known
  CHECK (ui_header IS NULL OR ui_header IN ('sticky', 'static'));
--> statement-breakpoint
ALTER TABLE app_user ADD CONSTRAINT app_user_ui_motion_known
  CHECK (ui_motion IS NULL OR ui_motion IN ('full', 'reduced'));
--> statement-breakpoint
ALTER TABLE app_user ADD CONSTRAINT app_user_ui_table_stripes_known
  CHECK (ui_table_stripes IS NULL OR ui_table_stripes IN ('on', 'off'));
