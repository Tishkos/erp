-- Saved views of screens, and pinning them to Home (platform phase, Agent 8).
--
-- `saved_view` (0019) kept a *list-framework* question: a `ListQuery` for a
-- `ListDefinition`, shareable, read by anyone it was shared with. The ERP's
-- screens do not use that framework — they are server pages that read their
-- filters from the address — so a view of a screen is a second kind of row in
-- the same table, not a second table:
--
--   kind = 'list'   the existing rows, unchanged (the payables workbench's
--                   shared seed views among them);
--   kind = 'route'  a screen's filters: `list_key` is the registry key
--                   (`payables.invoices`, always dotted), `query` is
--                   `{ "v": 1, "params": { … }, "dates": { slot: rule } }` —
--                   the screen's declared parameters and relative-date rules,
--                   never a row, an id of a record or an amount owed.
--
-- What the database holds, and why it is not left to the application:
--
--   * A screen view is its owner's alone. It cannot be shared (the check), and
--     the read policy shows other people's *list* views only: a super user
--     reads none of anyone's screen views, so a view cannot be a way of
--     learning what a colleague looks at.
--   * It is configuration: an object with a `params` object, version 1, at most
--     4 kB. The application validates every parameter against the screen's own
--     declaration when the view is saved and again each time it is opened; the
--     check only keeps a hand-made insert from storing something else.
--   * A view keeps its owner, its kind and its screen for life (trigger);
--     a person has at most 100 screen views and pins at most 12 to Home.
--   * Pinning is `pinned_at`: a timestamp, not a copy. What Home draws is the
--     view run again as the person, so a revoked grant shows the screen's own
--     refusal and never a stored answer.
--
-- Nothing else changes: `erp_app` already holds SELECT, INSERT, UPDATE and
-- DELETE on `saved_view` (a discarded filter set is the one thing the system
-- deletes outright; the audit trail keeps what it was).
ALTER TABLE saved_view
  ADD COLUMN kind text NOT NULL DEFAULT 'list',
  ADD COLUMN pinned_at timestamp with time zone;--> statement-breakpoint

ALTER TABLE saved_view ADD CONSTRAINT saved_view_kind_known
  CHECK (kind IN ('list', 'route'));--> statement-breakpoint

ALTER TABLE saved_view ADD CONSTRAINT saved_view_route_private
  CHECK (kind <> 'route' OR NOT is_shared);--> statement-breakpoint

ALTER TABLE saved_view ADD CONSTRAINT saved_view_route_keyed
  CHECK (kind <> 'route' OR position('.' IN list_key) > 1);--> statement-breakpoint

ALTER TABLE saved_view ADD CONSTRAINT saved_view_route_config
  CHECK (
    kind <> 'route'
    OR coalesce(
      jsonb_typeof(query) = 'object'
      AND jsonb_typeof(query -> 'params') = 'object'
      AND query ->> 'v' = '1'
      AND pg_column_size(query) <= 4096,
      false
    )
  );--> statement-breakpoint

ALTER TABLE saved_view ADD CONSTRAINT saved_view_route_name
  CHECK (kind <> 'route' OR char_length(btrim(name)) BETWEEN 1 AND 80);--> statement-breakpoint

ALTER TABLE saved_view ADD CONSTRAINT saved_view_pin_is_route
  CHECK (pinned_at IS NULL OR kind = 'route');--> statement-breakpoint

CREATE INDEX saved_view_pinned_idx ON saved_view (owner_user_id, pinned_at)
  WHERE pinned_at IS NOT NULL;--> statement-breakpoint

-- Identity and limits.
CREATE OR REPLACE FUNCTION saved_view_route_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  -- A list view is the framework's, as it always was. A row that is, or was, a
  -- screen view is held to the rules below.
  IF NEW.kind <> 'route' AND (TG_OP = 'INSERT' OR OLD.kind <> 'route') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.owner_user_id <> OLD.owner_user_id
       OR NEW.kind <> OLD.kind
       OR NEW.list_key <> OLD.list_key THEN
      RAISE EXCEPTION 'A saved view keeps its owner and its screen; save a new view instead.'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' AND (
       SELECT count(*) FROM saved_view
        WHERE owner_user_id = NEW.owner_user_id AND kind = 'route'
     ) >= 100 THEN
    RAISE EXCEPTION 'A person keeps at most 100 saved views; delete one first.'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.pinned_at IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.pinned_at IS NULL) AND (
       SELECT count(*) FROM saved_view
        WHERE owner_user_id = NEW.owner_user_id AND kind = 'route' AND pinned_at IS NOT NULL
     ) >= 12 THEN
    RAISE EXCEPTION 'At most 12 views can be pinned to Home; unpin one first.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$fn$;--> statement-breakpoint

CREATE TRIGGER saved_view_route_guard
  BEFORE INSERT OR UPDATE ON saved_view
  FOR EACH ROW EXECUTE FUNCTION saved_view_route_guard();--> statement-breakpoint

-- Reading: a person's own views, and the *list* views others shared. A screen
-- view is never shared, so it is never read by anyone else.
DROP POLICY saved_view_read ON saved_view;--> statement-breakpoint

CREATE POLICY saved_view_read ON saved_view
  FOR SELECT
  USING (
    owner_user_id = current_setting('app.user_id', true)::uuid
    OR (is_shared AND kind = 'list')
  );
