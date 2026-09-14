-- A directly-raised invoice line has no delivery to be measured against —
-- Operations block 5 (2026-09-12).
--
-- `ar_invoice_line_within_delivered` has guarded the sales chain since 0047:
-- the line bills the invoice's own delivery, against the order line that
-- delivery delivered, for the item the delivery carried, no more than it
-- delivered, at the price the order locked. Five checks, all worth keeping,
-- none of them touched.
--
-- They all read a delivery line. The sponsor's Sales Invoice has none: it is
-- the first document in the chain, so it names its own item, its own price and
-- its own warehouse. Asked about a delivery that was never mentioned, the
-- trigger reported the item "but the delivery carried <NULL>", which is a
-- complaint about a document nobody raised.
--
-- What it is measured against instead is the warehouse, which refuses to go
-- negative — the sponsor's own rule, block 11.
CREATE OR REPLACE FUNCTION ar_invoice_line_within_delivered() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_delivered numeric(24,6);
  v_invoiced  numeric(24,6);
  v_note      uuid;
  v_order_ln  uuid;
  v_item      text;
  v_price     numeric(19,4);
  v_inv_note  uuid;
BEGIN
  -- Raised on its own (Operations block 5). There is no delivery to bill
  -- within, no order to take a price from, and no chain to carry the item
  -- down: the invoice names its own item, its own price and its own
  -- warehouse, and the warehouse is what refuses to go negative.
  IF NEW.delivery_note_line_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT l.quantity, l.delivery_note_id, l.sales_order_line_id, l.item_code
    INTO v_delivered, v_note, v_order_ln, v_item
    FROM delivery_note_line l WHERE l.id = NEW.delivery_note_line_id;

  SELECT delivery_note_id INTO v_inv_note FROM ar_invoice WHERE id = NEW.ar_invoice_id;

  IF v_note IS DISTINCT FROM v_inv_note THEN
    RAISE EXCEPTION
      'An A/R Invoice line bills a delivery line from another Delivery Note. One invoice bills one delivery (blueprint 7.4).'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.sales_order_line_id IS DISTINCT FROM v_order_ln THEN
    RAISE EXCEPTION
      'An A/R Invoice line names an order line the delivery did not deliver against (blueprint 7.7).'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.item_code IS DISTINCT FROM v_item THEN
    RAISE EXCEPTION
      'A/R Invoice line names % but the delivery carried %. The item is carried down the chain, not chosen at invoicing.',
      NEW.item_code, v_item
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Cumulative across invoices: one delivery may be billed in stages, and it is
  -- the last one that is too large rather than any one on its own.
  SELECT coalesce(sum(l.quantity), 0) INTO v_invoiced
    FROM ar_invoice_line l
    JOIN ar_invoice i ON i.id = l.ar_invoice_id
   WHERE l.delivery_note_line_id = NEW.delivery_note_line_id
     AND l.id <> NEW.id
     AND i.status <> 'reversed';

  IF v_invoiced + NEW.quantity > coalesce(v_delivered, 0) THEN
    RAISE EXCEPTION
      'Invoicing % of % would bill more than was delivered. Delivered: %; already invoiced: %. A customer is billed for what they received (blueprint 7.7).',
      NEW.quantity, v_item, coalesce(v_delivered, 0), v_invoiced
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Blueprint 7.3 - the price came from the customer's price list and was locked on
  -- the Sales Order. The invoice records it; it does not get to choose it.
  SELECT unit_price INTO v_price FROM sales_order_line WHERE id = NEW.sales_order_line_id;

  IF NEW.unit_price IS DISTINCT FROM v_price THEN
    RAISE EXCEPTION
      'A/R Invoice line prices % at % but the Sales Order locked it at %. Unit prices come from the customer''s Price List and cannot be edited in the sales chain (blueprint 7.3, 7.7).',
      v_item, NEW.unit_price, v_price
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
