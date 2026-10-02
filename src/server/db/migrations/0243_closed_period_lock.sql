-- ===========================================================================
-- REQ-IMPROVE-001 Stage IMPROVE-2a — closing controls (2026-10-02).
--
-- FC-3: a closed period is closed at the database. The application already
-- asks `periods.authorisePosting` before every posting and refuses a hard-
-- closed date; this holds the same rule for everyone else — a script, a
-- migration, a future module that forgets:
--
--   journal_entry        cannot enter `posted` with a posting date in a
--                        closed period, and a posted entry cannot be moved
--                        into one
--   inventory_movement   cannot be written with a movement date in a
--                        closed period
--   fiscal_period        cannot be closed while an earlier period of its
--                        year is still open or soft-closed (FC-2 sequence)
--
-- Soft close stays the application's business: it is the override that
-- `execute` on fiscal_period grants, recorded in period_override.
-- ===========================================================================

CREATE FUNCTION period_is_closed(p_date date) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM fiscal_period p
     WHERE p.starts_on <= p_date AND p.ends_on >= p_date AND p.status = 'closed'
  );
$$;--> statement-breakpoint

CREATE FUNCTION journal_entry_closed_period_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	-- Only the transition into `posted`, or a posted entry's date moving:
	-- marking an already-posted entry reversed, or touching its version, is
	-- not a posting and a closed period must not freeze its own history.
	IF NEW.status = 'posted'
	   AND (TG_OP = 'INSERT'
	        OR OLD.status IS DISTINCT FROM NEW.status
	        OR OLD.posting_date IS DISTINCT FROM NEW.posting_date)
	   AND period_is_closed(NEW.posting_date) THEN
		RAISE EXCEPTION 'Journal % cannot post into %: the period is closed (REQ-IMPROVE-001 FC-3).', NEW.entry_no, NEW.posting_date
			USING ERRCODE = 'restrict_violation';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER journal_entry_closed_period_lock
	BEFORE INSERT OR UPDATE ON journal_entry
	FOR EACH ROW EXECUTE FUNCTION journal_entry_closed_period_lock();--> statement-breakpoint

CREATE FUNCTION inventory_movement_closed_period_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF period_is_closed(NEW.movement_date) THEN
		RAISE EXCEPTION 'A stock movement dated % cannot be written: the period is closed (REQ-IMPROVE-001 FC-3).', NEW.movement_date
			USING ERRCODE = 'restrict_violation';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER inventory_movement_closed_period_lock
	BEFORE INSERT ON inventory_movement
	FOR EACH ROW EXECUTE FUNCTION inventory_movement_closed_period_lock();--> statement-breakpoint

CREATE FUNCTION fiscal_period_close_in_sequence() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	v_open text;
BEGIN
	IF NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed' THEN
		SELECT string_agg(p.name, ', ' ORDER BY p.period_no) INTO v_open
		  FROM fiscal_period p
		 WHERE p.fiscal_year_id = NEW.fiscal_year_id
		   AND p.period_no < NEW.period_no
		   AND p.status <> 'closed';
		IF v_open IS NOT NULL THEN
			RAISE EXCEPTION '% cannot be closed before %: periods close in sequence (REQ-IMPROVE-001 FC-2).', NEW.name, v_open
				USING ERRCODE = 'restrict_violation';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER fiscal_period_close_in_sequence
	BEFORE UPDATE ON fiscal_period
	FOR EACH ROW EXECUTE FUNCTION fiscal_period_close_in_sequence();--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		RAISE WARNING 'Role erp_app does not exist — grants skipped.';
		RETURN;
	END IF;
	GRANT EXECUTE ON FUNCTION period_is_closed(date) TO erp_app;
END $$;
