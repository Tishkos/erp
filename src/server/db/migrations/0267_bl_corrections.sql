-- IMPROVEMENT-002 — the B/L, written properly (sponsor, 2026-10-03).
--
--   * A mistyped B/L is cancelled with its reason, and its number may then be
--     entered again: one live B/L per number, not one for ever.
--   * A container carries its own seal number (the receipt reads "seal intact"
--     against it), and its own size/type — set per row, not copied across.
--   * The B/L prints: its print and export grants beside its view.
DROP INDEX IF EXISTS "bill_of_lading_no_uniq";--> statement-breakpoint
CREATE UNIQUE INDEX "bill_of_lading_no_live_uniq" ON "bill_of_lading" ("bl_no") WHERE "cancelled_at" IS NULL;--> statement-breakpoint

ALTER TABLE "shipment_container" ADD COLUMN IF NOT EXISTS "seal_no" text;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb)
SELECT g.role_code, 'bill_of_lading', v.verb
  FROM role_grant g
 CROSS JOIN unnest(ARRAY['print', 'export']::permission_verb[]) AS v(verb)
 WHERE g.object = 'bill_of_lading' AND g.verb = 'view'
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- Cancelling a B/L or a container is the accounting manager's (reverse_cancel)
-- and the logistics officer's own entry to correct.
INSERT INTO role_grant (role_code, object, verb) VALUES
	('logistics_officer', 'bill_of_lading',     'reverse_cancel'),
	('logistics_officer', 'shipment_container', 'reverse_cancel')
ON CONFLICT DO NOTHING;
