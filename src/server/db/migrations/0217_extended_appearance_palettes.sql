ALTER TABLE company
  DROP CONSTRAINT company_ui_palette_known;--> statement-breakpoint
ALTER TABLE company
  ADD CONSTRAINT company_ui_palette_known
  CHECK (ui_palette IN (
    'sand', 'classic', 'slate', 'graphite', 'pearl', 'midnight', 'carbon', 'ocean',
    'obsidian_plum', 'evergreen', 'espresso', 'lunar_slate',
    'ivory_linen', 'glacier', 'sage_white', 'porcelain_rose', 'dune_bronze', 'harbor_mist'
  ));--> statement-breakpoint

ALTER TABLE app_user
  DROP CONSTRAINT app_user_ui_palette_known;--> statement-breakpoint
ALTER TABLE app_user
  ADD CONSTRAINT app_user_ui_palette_known
  CHECK (ui_palette IS NULL OR ui_palette IN (
    'sand', 'classic', 'slate', 'graphite', 'pearl', 'midnight', 'carbon', 'ocean',
    'obsidian_plum', 'evergreen', 'espresso', 'lunar_slate',
    'ivory_linen', 'glacier', 'sage_white', 'porcelain_rose', 'dune_bronze', 'harbor_mist'
  ));
