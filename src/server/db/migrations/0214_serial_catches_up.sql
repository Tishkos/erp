-- A document number sequence that has fallen behind the numbers already issued.
--
-- Every document type keeps a real sequence, and `next_document_serial` hands
-- out `nextval`. If that sequence is ever behind `doc_number_allocation` — a
-- database restored from a dump taken before the numbers were issued, a
-- sequence recreated at 1 while the allocations survived, a books format that
-- takes the documents but not their numbers — then the next allocation claims a
-- serial that is already recorded, and every attempt to raise that document
-- fails on `doc_number_allocation_serial_uniq`. Nothing can be created, and the
-- message names an index rather than the cause.
--
-- Seen on a development database on 2026-09-27: AR_INVOICE HQ|2026 had issued
-- 16 numbers with its sequence sitting at 3.
--
-- The allocator now catches the sequence up rather than handing out a number it
-- can see is taken. It heals once, on the first allocation after the drift, and
-- costs one indexed max() per call otherwise.
--
-- The gap this leaves is deliberate: a number already issued is never reused,
-- which is the same rule a rolled-back save follows.
CREATE OR REPLACE FUNCTION next_document_serial(p_key text, p_scope text DEFAULT '')
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_seq    text;
  v_serial bigint;
  v_issued bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM doc_sequence WHERE key = p_key AND active) THEN
    RAISE EXCEPTION 'Unknown or inactive document sequence: %', p_key
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_seq := doc_sequence_name(p_key, p_scope);

  IF to_regclass(v_seq) IS NULL THEN
    -- Serialise creation only. Taking this lock on every allocation would
    -- serialise the whole document type for the length of each transaction.
    PERFORM pg_advisory_xact_lock(hashtext(v_seq));
    EXECUTE format('CREATE SEQUENCE IF NOT EXISTS %I START 1', v_seq);
  END IF;

  EXECUTE format('SELECT nextval(%L)', v_seq) INTO v_serial;

  -- The highest number this key and scope has already issued.
  SELECT coalesce(max(serial), 0) INTO v_issued
    FROM doc_number_allocation
   WHERE sequence_key = p_key AND scope_key = p_scope;

  IF v_serial <= v_issued THEN
    -- Behind. Take the creation lock so two callers do not both catch up, then
    -- move the sequence past everything issued and take the next number from it.
    PERFORM pg_advisory_xact_lock(hashtext(v_seq));
    SELECT coalesce(max(serial), 0) INTO v_issued
      FROM doc_number_allocation
     WHERE sequence_key = p_key AND scope_key = p_scope;
    PERFORM setval(v_seq, v_issued);
    EXECUTE format('SELECT nextval(%L)', v_seq) INTO v_serial;
  END IF;

  RETURN v_serial;
END;
$function$;
