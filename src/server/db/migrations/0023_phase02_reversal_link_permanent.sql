-- ===========================================================================
-- The reversal link is permanent — Phase 02.8, Appendix C.
--
-- HAND-AUTHORED. Drizzle does not model triggers.
--
-- Appendix C, posting engine control checklist: *"Original and reversal linked
-- permanently."*
-- 02.8 gate: *"After reversal, both documents are read-only and each links to
-- the other."*
--
-- `journal_entry_reversal_integrity` validates a link being **set** — it
-- returns early when `reverses_id` is null, which is correct for an ordinary
-- journal that reverses nothing. The gap is that it treats *clearing* an
-- existing link as that same case, so
--
--   update journal_entry set reverses_id = null where id = <the reversal>
--
-- succeeded. The pair of documents would then look like two unrelated postings
-- that happen to cancel out, which is exactly the appearance a reversal exists
-- to prevent: an auditor holding one of them has no way back to the other.
--
-- This adds the missing half. The link may be written once, when the reversal
-- is created, and never rewritten or removed afterwards — in either direction.
-- ===========================================================================

CREATE FUNCTION journal_entry_reversal_link_permanent() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.reverses_id IS NOT NULL
     AND NEW.reverses_id IS DISTINCT FROM OLD.reverses_id THEN
    RAISE EXCEPTION
      'Journal % reverses journal %, and that link cannot be changed or removed (Appendix C). A correction is a further document, never an edited link.',
      OLD.entry_no, OLD.reverses_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.reversed_by_id IS NOT NULL
     AND NEW.reversed_by_id IS DISTINCT FROM OLD.reversed_by_id THEN
    RAISE EXCEPTION
      'Journal % has been reversed by journal %, and that link cannot be changed or removed (Appendix C).',
      OLD.entry_no, OLD.reversed_by_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER journal_entry_reversal_link_permanent
  BEFORE UPDATE ON journal_entry
  FOR EACH ROW EXECUTE FUNCTION journal_entry_reversal_link_permanent();
