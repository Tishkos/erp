-- IMPROVEMENT-002 IM2-1 — an import's shortage, claimed from the supplier.
--
-- When every container is in and some of what the invoices bought is still in
-- transit, it is claimed with a goods return against the invoice line, out of
-- the transit warehouse (services/shipments.ts › claimShortage). The import's
-- log names the claim with its own event.
INSERT INTO "payable_event_code" ("code", "lane_code", "name") VALUES
	('SHORTAGE_CLAIMED', 'warehouse', 'Shortage claimed')
ON CONFLICT ("code") DO NOTHING;
