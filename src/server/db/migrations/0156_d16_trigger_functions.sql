-- ---------------------------------------------------------------------------
-- D16 — two trigger functions still read the table 0153 dropped.
--
-- PostgreSQL does not resolve table names inside a PL/pgSQL body until the
-- function runs, so dropping `logistics_client_import_file` broke neither the
-- migration nor the schema: it broke the *next insert* into `logistics_job`,
-- with a 42P01 from inside a trigger. That is the failure mode of late binding,
-- and the reason the pg_proc bodies have to be searched by hand after a rename.
--
-- Both read `status` into a `text` variable and compare it to 'closed'. The
-- merged column is `document_status` rather than text, and 'closed' is one of
-- its eleven values, so the assignment casts and the comparison means what it
-- always meant.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION logistics_job_client_matches_file() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_file_client uuid;
  v_file_no     text;
  v_file_status text;
BEGIN
  SELECT client_id, file_no, status INTO v_file_client, v_file_no, v_file_status
    FROM client_import_file WHERE id = NEW.import_file_id;

  IF v_file_client IS DISTINCT FROM NEW.client_id THEN
    RAISE EXCEPTION
      'Job % names a different client from import file % (blueprint 11). One shipment has one client; correct the job or open the right file.',
      NEW.job_no, coalesce(v_file_no, '(unknown)')
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF TG_OP = 'INSERT' AND v_file_status = 'closed' THEN
    RAISE EXCEPTION
      'Client import file % is closed, so no new job can be raised against it (blueprint 11). Reopen the file first.',
      v_file_no USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION logistics_client_import_file_reference_file_is_open() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
  v_no     text;
BEGIN
  SELECT status, file_no INTO v_status, v_no
    FROM client_import_file WHERE id = NEW.import_file_id;

  IF v_status = 'closed' THEN
    RAISE EXCEPTION
      'Client import file % is closed; nothing further can be linked to it (blueprint 11). Reopen the file, or link the document to the file it belongs to.',
      v_no USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
