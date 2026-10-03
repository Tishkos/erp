-- ---------------------------------------------------------------------------
-- Two documents that need a counter nobody has used yet can both be saved.
--
-- A counter's sequence is created the first time it is asked for — the first
-- invoice of a year in a branch, the first customer after a reset. Two saves
-- arriving together both found it missing, and the advisory lock made the
-- second wait for the first. But the second's re-check could still read the
-- catalog as it was before the first committed, so it went on to CREATE a
-- sequence that now existed and failed: "relation docseq_… already exists".
-- No number was ever duplicated; somebody's save was refused, for nothing
-- they had done.
--
-- Found by the final audit's concurrency test (Critical Rule 1, "concurrent
-- creation cannot create duplicate numbers"). IF NOT EXISTS makes the create
-- itself decide against the catalog as it is at that moment, which the lock
-- has already made the right moment. Everything else is unchanged.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.next_document_serial(p_key text, p_scope text DEFAULT ''::text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_seq    text;
  v_serial bigint;
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
  RETURN v_serial;
END;
$function$;
