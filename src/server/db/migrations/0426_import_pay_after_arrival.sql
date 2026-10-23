-- ===========================================================================
-- Imports paid after the goods arrive (2026-10-24, by direction: "import
-- application payment after import … like the whole import is done then";
-- "a button where we skip … the current import which pays later … for
-- creating new import and in existing application"; "add filter for them").
-- HAND-AUTHORED.
--
-- An import is flagged on `payable`: who set it, when and why. While it is
-- set, the import's invoices agree no advance, no goods wait in On Process
-- (Without SWIFT), and the sweep's payment clocks do not run until every
-- container is received (`services/pay-after-arrival.ts`,
-- `domain/pay-after-arrival.ts`). Setting it back keeps who cleared it in the
-- import's log and the audit trail; the columns hold the setting in force.
--
-- C-98: a flag that is on names who set it and when.
-- ===========================================================================

ALTER TABLE "payable" ADD COLUMN "pay_after_arrival" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "payable" ADD COLUMN "pay_after_arrival_set_by" uuid REFERENCES "app_user"("id");
--> statement-breakpoint
ALTER TABLE "payable" ADD COLUMN "pay_after_arrival_set_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "payable" ADD COLUMN "pay_after_arrival_reason" text;
--> statement-breakpoint
ALTER TABLE "payable" ADD CONSTRAINT "payable_pay_after_arrival_named" CHECK (
	NOT "pay_after_arrival"
	OR ("pay_after_arrival_set_by" IS NOT NULL AND "pay_after_arrival_set_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "payable" ADD CONSTRAINT "payable_pay_after_arrival_import" CHECK (
	NOT "pay_after_arrival" OR "payable_type_code" = 'import'
);
--> statement-breakpoint
CREATE INDEX "payable_pay_after_arrival_idx" ON "payable" ("pay_after_arrival") WHERE "pay_after_arrival";
--> statement-breakpoint

INSERT INTO payable_event_code (code, lane_code, name) VALUES
	('PAY_AFTER_ARRIVAL_SET',     'payment', 'To be paid after the goods arrive'),
	('PAY_AFTER_ARRIVAL_CLEARED', 'payment', 'To be paid before arrival again')
ON CONFLICT (code) DO NOTHING;
