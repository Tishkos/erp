-- ---------------------------------------------------------------------------
-- The company chooses its accent as well as its palette.
--
-- The palette (0170) decides the chrome and paper of the window; the accent
-- is the one colour that marks what is pressed, selected or actionable — the
-- buttons, the selected row, the rule under a title bar. It was amber
-- everywhere, by construction. It is now a second company choice, for the
-- same reason the palette is one: two people describing the same screen
-- should be looking at the same screen.
--
-- Constrained like the palette, and for the same failure: an accent name with
-- no definition in the stylesheet would strip the highlight from every screen
-- at once, with nothing anywhere to say why.
-- ---------------------------------------------------------------------------
ALTER TABLE company
  ADD COLUMN IF NOT EXISTS ui_accent text NOT NULL DEFAULT 'gold';--> statement-breakpoint

ALTER TABLE company
  DROP CONSTRAINT IF EXISTS company_ui_accent_known;--> statement-breakpoint

ALTER TABLE company
  ADD CONSTRAINT company_ui_accent_known
  CHECK (ui_accent IN ('gold', 'red', 'blue', 'green', 'purple'));
