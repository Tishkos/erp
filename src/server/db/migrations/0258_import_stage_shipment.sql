-- Stage 5 of an import is Shipment, not Shipped.
--
-- By direction (2026-10-03). The other seven stages name a state the file is
-- in — Order confirmed, PD registered, Payment in progress, All received —
-- and "Shipped" named an event instead, which read as though the stage were
-- the moment of departure rather than the shipping of the goods. It is the
-- lane the bills of lading and the containers belong to, and the lane is
-- called Shipment.
--
-- Only the name moves. The code (`shipped`), the rule (`import_shipped`) and
-- the sequence are what everything else keys on, and they are untouched — a
-- payable sitting at this stage stays exactly where it is.
--
-- The row is only corrected while it still carries the seeded name, so a name
-- somebody has since set on the Payables Settings screen is left as theirs.

UPDATE payable_stage
   SET name = 'Shipment'
 WHERE payable_type_code = 'import'
   AND code = 'shipped'
   AND name = 'Shipped';
