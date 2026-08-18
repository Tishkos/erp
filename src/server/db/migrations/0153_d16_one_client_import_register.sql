-- ---------------------------------------------------------------------------
-- D16 answered — one client import register.
--
-- Phases 09 and 10 were built on parallel branches from the same Phase 05 base.
-- Both created a table called `client_import_file`; the merge renamed Phase 10's
-- to `logistics_client_import_file` so that both phases would work. That was a
-- merge decision, and it left the real question open.
--
-- The question is now answered: **the paperwork arrives once.** §11 says so in
-- its first paragraph — *"A logistics job can be linked to the same client import
-- file as a Money Transfer transaction without combining their accounting
-- results"* — and Phase 09's own schema note says the constraint linking the two
-- *"belongs to whoever builds"* Phase 10. Phase 10 was built without seeing that
-- note. This migration is that constraint, arriving late.
--
-- Three defects close together here:
--
--   1. Two registers for one physical consignment.
--   2. Two document sequences that mint the **same number**. Both carry prefix
--      'CIF' and pattern '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', and
--      `formatDocumentNumber` never uses the sequence key — so serial 1 of each
--      is 'CIF-BGW-2026-000001'. Two different files, one number, same branch,
--      same year. §3.4 exists to make that impossible.
--   3. `client_import_file.logistics_job_ref`, a text stub standing in for the
--      link that could not be made across branches.
--
-- What is NOT merged is the accounting. §11.3 and §12.4 require Money Transfer
-- and Logistics to keep separate revenue, expense and margin on the same
-- consignment, and nothing here changes that: the file carries no amount, the
-- cross-reference table carries no amount, and each service reads its own
-- figures from its own tables.
--
-- The status vocabularies reconcile rather than collide. Phase 10 used
-- 'open'/'closed' and said so deliberately — *"this is not a document and giving
-- it a document's vocabulary would invite somebody to post it."* But 'open' is
-- simply *not closed*: it spans Phase 09's draft, posted and settled. One axis,
-- coarser. So the four-state chain survives and 'open' becomes 'draft', which is
-- what an import file with nothing posted against it actually is.
-- ---------------------------------------------------------------------------

-- 1 · The client, as both modules see them ----------------------------------
-- Every money transfer client account already belongs to a business partner
-- (`money_transfer_client_account.partner_id` is NOT NULL), so the partner is
-- the identity the two modules share.
ALTER TABLE client_import_file
  ADD COLUMN client_id      uuid REFERENCES business_partner(id),
  ADD COLUMN origin_country text,
  ADD COLUMN closed_on      date,
  ADD COLUMN note           text;--> statement-breakpoint

UPDATE client_import_file f
   SET client_id = a.partner_id
  FROM money_transfer_client_account a
 WHERE a.id = f.client_account_id
   AND f.client_id IS NULL;--> statement-breakpoint

ALTER TABLE client_import_file
  ALTER COLUMN client_id SET NOT NULL;--> statement-breakpoint

-- A logistics-only file has no Money Transfer client account, so the account
-- becomes optional. What is not optional is that it agrees with the client —
-- enforced below.
ALTER TABLE client_import_file
  ALTER COLUMN client_account_id DROP NOT NULL;--> statement-breakpoint

-- 2 · Move Phase 10's files in ----------------------------------------------
-- The `id` is carried over deliberately: `logistics_job.import_file_id` and the
-- cross-reference table already point at these values, so re-pointing the
-- foreign keys needs no remapping and no window in which a link is dangling.
--
-- On a file-number clash the moved row takes a '-L' suffix and a WARNING is
-- raised. The clash is a consequence of defect 2 above and can only exist in
-- pre-go-live data; suffixing is non-destructive and deterministic, where
-- ON CONFLICT DO NOTHING would silently drop a client's consignment.
DO $$
DECLARE
  r        record;
  v_file   text;
  v_clash  int := 0;
BEGIN
  FOR r IN SELECT * FROM logistics_client_import_file LOOP
    v_file := r.file_no;
    IF EXISTS (SELECT 1 FROM client_import_file WHERE file_no = v_file) THEN
      v_file := r.file_no || '-L';
      v_clash := v_clash + 1;
    END IF;

    INSERT INTO client_import_file
      (id, file_no, client_id, client_account_id, branch_code, status, opened_on,
       origin_country, description, closed_on, note, created_by, created_at, updated_at)
    VALUES
      (r.id, v_file, r.client_id, NULL, r.branch_code,
       CASE r.status WHEN 'closed' THEN 'closed'::document_status
                     ELSE 'draft'::document_status END,
       r.opened_on, r.origin_country, r.description, r.closed_on, r.note,
       r.created_by, r.created_at, r.updated_at);
  END LOOP;

  IF v_clash > 0 THEN
    RAISE WARNING
      '% logistics import file(s) carried a number already in use and were suffixed -L. Both registers minted CIF numbers from separate sequences; one register now mints them from one.',
      v_clash;
  END IF;
END;
$$;--> statement-breakpoint

-- 3 · Re-point the foreign keys ---------------------------------------------
ALTER TABLE logistics_job
  DROP CONSTRAINT logistics_job_import_file_id_client_import_file_id_fk;--> statement-breakpoint
ALTER TABLE logistics_job
  ADD CONSTRAINT logistics_job_import_file_id_client_import_file_id_fk
  FOREIGN KEY (import_file_id) REFERENCES client_import_file(id);--> statement-breakpoint

ALTER TABLE logistics_client_import_file_reference
  DROP CONSTRAINT logistics_client_import_file_reference_import_file_id_client_im;--> statement-breakpoint

-- The table linked *any* module's document to a logistics import file. There is
-- no logistics import file any more — there is one import file — so the name
-- goes with the table it was named after.
ALTER TABLE logistics_client_import_file_reference
  RENAME TO client_import_file_reference;--> statement-breakpoint

ALTER TABLE client_import_file_reference
  ADD CONSTRAINT client_import_file_reference_import_file_id_client_import_file_fk
  FOREIGN KEY (import_file_id) REFERENCES client_import_file(id);--> statement-breakpoint

ALTER INDEX logistics_client_import_file_reference_document_uniq
  RENAME TO client_import_file_reference_document_uniq;--> statement-breakpoint
ALTER INDEX logistics_client_import_file_reference_file_idx
  RENAME TO client_import_file_reference_file_idx;--> statement-breakpoint

-- 4 · Carry the rules across -------------------------------------------------
DROP TRIGGER logistics_client_import_file_client_is_customer
  ON logistics_client_import_file;--> statement-breakpoint
DROP TRIGGER client_import_file_close_needs_jobs_done
  ON logistics_client_import_file;--> statement-breakpoint

-- The reference table's branch scope reached into the old table. It reaches into
-- the merged one now, and must be rebuilt before the old table can go.
DROP POLICY logistics_client_import_file_reference_branch_scope
  ON client_import_file_reference;--> statement-breakpoint

DROP TABLE logistics_client_import_file;--> statement-breakpoint

CREATE POLICY client_import_file_reference_branch_scope
  ON client_import_file_reference
  USING (app_is_super_user() OR EXISTS (
           SELECT 1 FROM client_import_file f
            WHERE f.id = client_import_file_reference.import_file_id
              AND f.branch_code = app_current_branch()))
  WITH CHECK (app_is_super_user() OR EXISTS (
           SELECT 1 FROM client_import_file f
            WHERE f.id = client_import_file_reference.import_file_id
              AND f.branch_code = app_current_branch()));--> statement-breakpoint

CREATE TRIGGER client_import_file_client_is_customer
  BEFORE INSERT OR UPDATE OF client_id ON client_import_file
  FOR EACH ROW EXECUTE FUNCTION logistics_client_import_file_client_is_customer();--> statement-breakpoint

CREATE TRIGGER client_import_file_close_needs_jobs_done
  BEFORE UPDATE ON client_import_file
  FOR EACH ROW EXECUTE FUNCTION client_import_file_close_needs_jobs_done();--> statement-breakpoint

-- One file, one client. If the file is funded through a Money Transfer client
-- account, that account must belong to the same partner — otherwise the file
-- would name one client and its money another, and the Remaining Client Balance
-- (§12.4) would be computed against a stranger.
CREATE FUNCTION client_import_file_account_matches_client() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_partner uuid;
BEGIN
  IF NEW.client_account_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT partner_id INTO v_partner
    FROM money_transfer_client_account WHERE id = NEW.client_account_id;

  IF v_partner IS DISTINCT FROM NEW.client_id THEN
    RAISE EXCEPTION
      'Import file % names one client and its Money Transfer account another (blueprint 12.4). The account must belong to the file''s client.',
      NEW.file_no
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER client_import_file_account_matches_client
  BEFORE INSERT OR UPDATE OF client_id, client_account_id ON client_import_file
  FOR EACH ROW EXECUTE FUNCTION client_import_file_account_matches_client();--> statement-breakpoint

-- Phase 10's rule, kept: a closed file states the business date it closed on.
-- Phase 09 never closed a file at all — the columns existed and nothing set
-- them — so there is one close path and it is Logistics'.
ALTER TABLE client_import_file
  ADD CONSTRAINT client_import_file_closed_has_date
  CHECK ((status <> 'closed' AND closed_on IS NULL)
      OR (status =  'closed' AND closed_on IS NOT NULL));--> statement-breakpoint

-- 5 · The text stub goes ------------------------------------------------------
-- §12.2 wanted a related Logistics Job. It now has one, by the only route that
-- cannot drift: the job names the file.
DROP INDEX client_import_file_logistics_idx;--> statement-breakpoint
ALTER TABLE client_import_file DROP COLUMN logistics_job_ref;--> statement-breakpoint

CREATE INDEX client_import_file_client_idx ON client_import_file (client_id, status);--> statement-breakpoint

-- 6 · One register, one sequence ---------------------------------------------
-- 'LOGISTICS_CLIENT_IMPORT_FILE' minted the same numbers as
-- 'CLIENT_IMPORT_FILE'. It is deactivated rather than deleted so the allocations
-- it already handed out keep their audit trail (§3.4).
UPDATE doc_sequence SET active = false WHERE key = 'LOGISTICS_CLIENT_IMPORT_FILE';--> statement-breakpoint

-- 7 · A file that never posted can still close -------------------------------
-- A logistics-only file carries no Money Transfer payment, so it closes from
-- draft. The other three moves were registered by Phase 09.
INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
  ('client_import_file', 'draft', 'closed')
ON CONFLICT DO NOTHING;
