-- ---------------------------------------------------------------------------
-- The company chooses how the system looks.
--
-- The application's look is now the accounting-package window the company
-- already reads. Which palette it wears is a company decision, not a personal
-- one: two people describing the same screen to each other should be seeing
-- the same screen, and a colour kept in one browser's storage is lost the
-- moment somebody opens the system on a different machine.
--
-- It lives on `company` because that table is already the singleton the
-- application reads for who this installation is (see `company_singleton`),
-- and a palette is one more fact about that. A separate settings table would
-- be a second place to look for the same kind of answer.
--
-- Constrained rather than free text. Every value here is a palette defined in
-- the stylesheet, so a name that has no definition would render an unstyled
-- application — and the failure would appear on every screen at once, with
-- nothing on any of them to say why.
-- ---------------------------------------------------------------------------
ALTER TABLE company
  ADD COLUMN IF NOT EXISTS ui_palette text NOT NULL DEFAULT 'sand';--> statement-breakpoint

ALTER TABLE company
  DROP CONSTRAINT IF EXISTS company_ui_palette_known;--> statement-breakpoint

ALTER TABLE company
  ADD CONSTRAINT company_ui_palette_known
  CHECK (ui_palette IN ('sand', 'classic', 'slate', 'graphite'));
