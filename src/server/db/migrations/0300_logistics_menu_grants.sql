-- REQ-LOG-001 — the Logistics navbar's objects, held by the people who do the work.
--
--   * `in_transit` was a menu object nobody held: the In-transit item showed
--     only to a Super User (audit, 2026-10-04). In-Transit Inventory reads the
--     non-import shipments (`supplier_shipment`) and the import containers'
--     goods (`shipment_container`), so whoever reads either reads it; the
--     copies go with the shipment tracker's own print and export.
--   * The registers over the import's money — Customs Duties & Taxes, Freight
--     & Shipping Costs, Landed Costs, Cost Allocation — are read-only views of
--     `landed_cost_charge` / `landed_cost_lock`. Their objects are new so a
--     Logistics heading given to a role grants no power over the landed cost
--     itself; each is held by whoever reads the landed cost, and the duties by
--     the customs lane, the freight by the shipping lane.
--   * Ports had no writer and no screen. Whoever reads the B/Ls reads the
--     ports; whoever raises a B/L may add a port and deactivate it.
--   * The container, its receipt and the PD print (four doors, 2026-10-04):
--     whoever reads them may print them; whoever exports a B/L exports them.
--
-- Copied from existing grants rather than listed by role, so the roles the
-- live database was given by `scripts/ops/set-up-people.ts` are covered too.

INSERT INTO role_grant (role_code, object, verb)
SELECT DISTINCT g.role_code, 'in_transit', 'view'::permission_verb
  FROM role_grant g
 WHERE g.verb = 'view' AND g.object IN ('supplier_shipment', 'shipment_container')
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb)
SELECT DISTINCT g.role_code, 'in_transit', g.verb
  FROM role_grant g
 WHERE g.object = 'supplier_shipment' AND g.verb IN ('print', 'export')
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb)
SELECT DISTINCT g.role_code, o.object, 'view'::permission_verb
  FROM role_grant g
 CROSS JOIN (VALUES ('customs_duty'), ('freight_cost'), ('landed_cost_register'), ('cost_allocation')) AS o(object)
 WHERE g.object = 'landed_cost' AND g.verb = 'view'
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb)
SELECT DISTINCT g.role_code, 'customs_duty', 'view'::permission_verb
  FROM role_grant g
 WHERE g.object = 'customs_pd' AND g.verb = 'create'
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb)
SELECT DISTINCT g.role_code, 'freight_cost', 'view'::permission_verb
  FROM role_grant g
 WHERE g.object = 'bill_of_lading' AND g.verb = 'create'
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb)
SELECT DISTINCT g.role_code, 'port', v.verb
  FROM role_grant g
 CROSS JOIN unnest(ARRAY['view', 'print']::permission_verb[]) AS v(verb)
 WHERE g.object = 'bill_of_lading' AND g.verb = 'view'
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb)
SELECT DISTINCT g.role_code, 'port', v.verb
  FROM role_grant g
 CROSS JOIN unnest(ARRAY['create', 'configure']::permission_verb[]) AS v(verb)
 WHERE g.object = 'bill_of_lading' AND g.verb = 'create'
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb)
SELECT DISTINCT g.role_code, 'port', 'export'::permission_verb
  FROM role_grant g
 WHERE g.object = 'bill_of_lading' AND g.verb = 'export'
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb)
SELECT DISTINCT g.role_code, 'shipment_container', 'print'::permission_verb
  FROM role_grant g
 WHERE g.object = 'shipment_container' AND g.verb = 'view'
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb)
SELECT DISTINCT g.role_code, 'shipment_container', 'export'::permission_verb
  FROM role_grant g
 WHERE g.object = 'bill_of_lading' AND g.verb = 'export'
   AND EXISTS (SELECT 1 FROM role_grant c WHERE c.role_code = g.role_code AND c.object = 'shipment_container' AND c.verb = 'view')
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb)
SELECT DISTINCT g.role_code, 'customs_pd', 'print'::permission_verb
  FROM role_grant g
 WHERE g.object = 'customs_pd' AND g.verb = 'view'
ON CONFLICT DO NOTHING;
