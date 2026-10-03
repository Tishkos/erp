-- ===========================================================================
-- The payable status log — REQ-AP-001 §7, §22.2.
--
-- HAND-AUTHORED, and deliberately its own migration: the table is PARTITIONED
-- BY RANGE on recorded_at, which Drizzle cannot declare. The schema file
-- (schema/payables.ts) describes the parent for the query builder only, and
-- drizzle-kit is never run against it.
--
-- One row per update from every lane, written in the same transaction as the
-- change it describes. Append-only by the same trigger that protects
-- audit_event; partitioned by year from day one so it can grow without a
-- later rewrite. The daily sweep keeps next year's partition ahead of the
-- calendar through payable_event_ensure_partition().
-- ===========================================================================

CREATE TABLE "payable_event" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"payable_id" uuid NOT NULL REFERENCES "payable"("id"),
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lane_code" text NOT NULL REFERENCES "payable_lane"("code"),
	"event_code" text NOT NULL REFERENCES "payable_event_code"("code"),
	"summary" text NOT NULL,
	"source_type" text,
	"source_id" text,
	"source_no" text,
	"before" jsonb,
	"after" jsonb,
	"actor_user_id" uuid,
	"hold_id" uuid,
	"attachment_id" uuid,
	"correction_of_id" uuid,
	-- The partition column must be in the key; (id, recorded_at) keeps id
	-- unique in practice while satisfying PostgreSQL's partitioning rule.
	PRIMARY KEY ("id", "recorded_at")
) PARTITION BY RANGE ("recorded_at");
--> statement-breakpoint

CREATE INDEX "payable_event_payable_idx" ON "payable_event" ("payable_id","recorded_at" DESC);
--> statement-breakpoint
CREATE INDEX "payable_event_code_idx" ON "payable_event" ("event_code","recorded_at");
--> statement-breakpoint
CREATE INDEX "payable_event_source_idx" ON "payable_event" ("source_type","source_id");
--> statement-breakpoint

-- This year, and a runway — the sweep keeps it a year ahead from here.
CREATE TABLE "payable_event_2026" PARTITION OF "payable_event"
	FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
--> statement-breakpoint
CREATE TABLE "payable_event_2027" PARTITION OF "payable_event"
	FOR VALUES FROM ('2027-01-01') TO ('2028-01-01');
--> statement-breakpoint
CREATE TABLE "payable_event_2028" PARTITION OF "payable_event"
	FOR VALUES FROM ('2028-01-01') TO ('2029-01-01');
--> statement-breakpoint

-- On a partitioned parent a row trigger propagates to every partition,
-- including ones created later (PostgreSQL 13+).
CREATE TRIGGER payable_event_append_only
	BEFORE UPDATE OR DELETE ON payable_event
	FOR EACH ROW EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint

-- §22.2 — the sweep calls this daily; creating an existing partition is a
-- no-op, so it is idempotent. SECURITY DEFINER because the application role
-- cannot (and must not) CREATE TABLE on its own.
CREATE FUNCTION payable_event_ensure_partition(p_year integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
	v_name text := format('payable_event_%s', p_year);
BEGIN
	IF p_year < 2026 OR p_year > 2200 THEN
		RAISE EXCEPTION 'Partition year % is outside the sane range.', p_year
			USING ERRCODE = 'invalid_parameter_value';
	END IF;
	IF to_regclass(v_name) IS NULL THEN
		EXECUTE format(
			'CREATE TABLE %I PARTITION OF payable_event FOR VALUES FROM (%L) TO (%L)',
			v_name, format('%s-01-01', p_year), format('%s-01-01', p_year + 1)
		);
	END IF;
END;
$$;
--> statement-breakpoint

-- Branch scope through the parent payable, like every child table (§23).
ALTER TABLE payable_event ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE payable_event FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY payable_event_branch_scope ON payable_event
	USING (
		app_is_super_user()
		OR EXISTS (SELECT 1 FROM payable p
		            WHERE p.id = payable_event.payable_id
		              AND app_branch_allowed(p.branch_code))
	)
	WITH CHECK (
		app_is_super_user()
		OR EXISTS (SELECT 1 FROM payable p
		            WHERE p.id = payable_event.payable_id
		              AND app_branch_allowed(p.branch_code))
	);
--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		RAISE WARNING 'Role erp_app does not exist — grants skipped.';
		RETURN;
	END IF;

	REVOKE ALL ON payable_event FROM erp_app;
	-- The log only ever gains rows (R3). Written by the system, read by
	-- whoever may read the payable.
	GRANT SELECT, INSERT ON payable_event TO erp_app;
	GRANT EXECUTE ON FUNCTION payable_event_ensure_partition(integer) TO erp_app;
END;
$$;
