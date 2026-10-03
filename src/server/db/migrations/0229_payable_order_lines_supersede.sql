-- ===========================================================================
-- PI lines are superseded, never deleted — REQ-AP-001 D11, R3.
--
-- Stage 1 granted DELETE on payable_order_line, reasoning from how invoice
-- lines work. D11 overrules it: the PI is evidence of what the supplier
-- offered, and an edited line is a new fact beside the old one, not instead
-- of it. The service marks the old row superseded, inserts the new one, and
-- writes FIELD_CHANGED with both; everything that counts quantity or amount
-- reads live rows only.
-- ===========================================================================

ALTER TABLE "payable_order_line" ADD COLUMN "superseded_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "payable_order_line" ADD COLUMN "superseded_by" uuid REFERENCES "app_user"("id");
--> statement-breakpoint

-- A superseded line records who decided it no longer stands.
ALTER TABLE "payable_order_line" ADD CONSTRAINT "payable_order_line_supersede_complete" CHECK (
	("superseded_at" IS NULL AND "superseded_by" IS NULL)
	OR ("superseded_at" IS NOT NULL AND "superseded_by" IS NOT NULL)
);
--> statement-breakpoint

-- Line numbers stay unique among the lines that stand; history may repeat them.
DROP INDEX "payable_order_line_no_uniq";
--> statement-breakpoint
CREATE UNIQUE INDEX "payable_order_line_no_uniq" ON "payable_order_line" ("payable_id","line_no")
	WHERE superseded_at IS NULL;
--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		RAISE WARNING 'Role erp_app does not exist — grants skipped.';
		RETURN;
	END IF;
	REVOKE DELETE ON payable_order_line FROM erp_app;
END;
$$;
