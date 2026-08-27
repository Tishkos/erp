-- ---------------------------------------------------------------------------
-- Each person chooses their own look; the company row becomes the default.
--
-- 0170/0171 made the palette and accent a company decision. In use it turned
-- out to be a personal one — the person staring at the screen all day wants
-- it their way, and two dark palettes join the set for exactly that reason.
-- The company columns stay and become the default a new person inherits;
-- a null on the user means "follow the company".
--
-- Same constraint discipline as before: a name with no stylesheet definition
-- would strip the styling from every screen this person opens.
-- ---------------------------------------------------------------------------
ALTER TABLE company
  DROP CONSTRAINT IF EXISTS company_ui_palette_known;--> statement-breakpoint
ALTER TABLE company
  ADD CONSTRAINT company_ui_palette_known
  CHECK (ui_palette IN ('sand', 'classic', 'slate', 'graphite', 'midnight', 'carbon'));--> statement-breakpoint

ALTER TABLE app_user
  ADD COLUMN IF NOT EXISTS ui_palette text;--> statement-breakpoint
ALTER TABLE app_user
  ADD COLUMN IF NOT EXISTS ui_accent text;--> statement-breakpoint

ALTER TABLE app_user
  DROP CONSTRAINT IF EXISTS app_user_ui_palette_known;--> statement-breakpoint
ALTER TABLE app_user
  ADD CONSTRAINT app_user_ui_palette_known
  CHECK (ui_palette IS NULL
     OR ui_palette IN ('sand', 'classic', 'slate', 'graphite', 'midnight', 'carbon'));--> statement-breakpoint

ALTER TABLE app_user
  DROP CONSTRAINT IF EXISTS app_user_ui_accent_known;--> statement-breakpoint
ALTER TABLE app_user
  ADD CONSTRAINT app_user_ui_accent_known
  CHECK (ui_accent IS NULL OR ui_accent IN ('gold', 'red', 'blue', 'green', 'purple'));
