-- The stage warehouse "On Port" is called "At Port" (2026-10-06, by direction:
-- "on port change to at port - the warehouse spelling is not correct").
--
-- HAND-AUTHORED. Data, not structure: the stage code `on_port` and the
-- warehouse code stay what they are. A company that gave the warehouse a name
-- of its own keeps it.
UPDATE warehouse SET name = 'At Port' WHERE shipment_stage = 'on_port' AND name = 'On Port';
