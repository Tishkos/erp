-- ---------------------------------------------------------------------------
-- A currency may carry its symbol — €, £, ₺ — beside its code.
--
-- Optional, and display-only: amounts are still formatted by code through
-- Intl, which knows more locales than a single stored glyph ever will. The
-- symbol is for the master list and for pickers, where a person recognises
-- € faster than EUR.
-- ---------------------------------------------------------------------------
ALTER TABLE currency
  ADD COLUMN IF NOT EXISTS symbol text;
