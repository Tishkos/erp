-- Phase 0 — Company Setup carries the company's location; by direction the
-- registration/tax identifiers are not asked for on the screen (the columns
-- stay for later phases).
ALTER TABLE company ADD COLUMN IF NOT EXISTS address text;
