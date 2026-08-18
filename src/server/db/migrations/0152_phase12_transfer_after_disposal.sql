-- ---------------------------------------------------------------------------
-- Phase 12.4 — a disposed asset cannot be transferred either.
--
-- `asset_no_movement_after_disposal` was attached to `asset_depreciation` and
-- `asset_impairment` in 0149 and not to `asset_transfer`. The service refuses it
-- ("a disposed asset cannot be moved"), so nothing gets through today; but every
-- other rule in this phase is enforced where the data is, and this one was left
-- one table short.
--
-- §18.5 requires transfer and disposal to retain complete approval and document
-- history. A transfer of an asset that has already left the register is the one
-- movement that cannot be true of it, and a history that records it is worse
-- than one that is missing a row.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION asset_no_movement_after_disposal() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
  v_code   text;
BEGIN
  SELECT status::text, asset_code INTO v_status, v_code
    FROM fixed_asset WHERE id = NEW.asset_id;

  IF v_status IN ('disposed', 'closed') THEN
    RAISE EXCEPTION
      '% is % and takes no further depreciation, impairment or transfer (blueprint 18.3).',
      v_code, v_status
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER asset_transfer_not_after_disposal
  BEFORE INSERT ON asset_transfer
  FOR EACH ROW EXECUTE FUNCTION asset_no_movement_after_disposal();
