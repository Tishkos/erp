-- Whether the side panel lists the modules under group headings (2026-10-07,
-- by direction: "for payable and receivable there should be 'Invoicing', a
-- text on top of them … make it available by appearance"). Each user's own,
-- beside 0407's navigation settings, and like them NULL until chosen: NULL
-- reads as 'grouped'. The groups themselves are domain/modules.ts › group.
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS ui_sidebar_groups text;
--> statement-breakpoint
ALTER TABLE app_user ADD CONSTRAINT app_user_ui_sidebar_groups_known
  CHECK (ui_sidebar_groups IS NULL OR ui_sidebar_groups IN ('grouped', 'plain'));
