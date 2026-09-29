-- Layout settings belong to each user and stay separate from palette colors.
-- NULL preserves existing localStorage choices until that user signs in once.
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS ui_appearance text;
--> statement-breakpoint
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS ui_density text;
--> statement-breakpoint
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS ui_corner_style text;
--> statement-breakpoint
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS ui_content_width text;
--> statement-breakpoint
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS ui_border_style text;
--> statement-breakpoint
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS ui_shadow text;
--> statement-breakpoint
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS ui_component_size text;
--> statement-breakpoint
ALTER TABLE app_user ADD CONSTRAINT app_user_ui_appearance_known
  CHECK (ui_appearance IS NULL OR ui_appearance IN ('current', 'standard', 'enterprise', 'minimal', 'modern', 'command', 'studio'));
--> statement-breakpoint
ALTER TABLE app_user ADD CONSTRAINT app_user_ui_density_known
  CHECK (ui_density IS NULL OR ui_density IN ('comfortable', 'compact', 'spacious', 'airy'));
--> statement-breakpoint
ALTER TABLE app_user ADD CONSTRAINT app_user_ui_corner_style_known
  CHECK (ui_corner_style IS NULL OR ui_corner_style IN ('soft', 'rounded', 'sharp', 'subtle', 'pill'));
--> statement-breakpoint
ALTER TABLE app_user ADD CONSTRAINT app_user_ui_content_width_known
  CHECK (ui_content_width IS NULL OR ui_content_width IN ('fluid', 'contained', 'wide', 'full_width'));
--> statement-breakpoint
ALTER TABLE app_user ADD CONSTRAINT app_user_ui_border_style_known
  CHECK (ui_border_style IS NULL OR ui_border_style IN ('none', 'subtle', 'standard', 'strong'));
--> statement-breakpoint
ALTER TABLE app_user ADD CONSTRAINT app_user_ui_shadow_known
  CHECK (ui_shadow IS NULL OR ui_shadow IN ('none', 'subtle', 'soft', 'elevated'));
--> statement-breakpoint
ALTER TABLE app_user ADD CONSTRAINT app_user_ui_component_size_known
  CHECK (ui_component_size IS NULL OR ui_component_size IN ('small', 'medium', 'large'));
