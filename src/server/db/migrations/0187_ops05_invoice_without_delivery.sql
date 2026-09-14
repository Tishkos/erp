-- An invoice that has no delivery is not an invoice with a broken one —
-- Operations block 5 (2026-09-12).
--
-- `ar_invoice_has_a_real_delivery` has guarded the sales cycle since 0047: an
-- invoice names a Delivery Note, that note has executed, and the order, the
-- customer, the date and the branch on the invoice all agree with it. Every
-- one of those checks is still worth having, and none of them is touched.
--
-- What changes is the case the trigger never had to consider. The sponsor's
-- Sales Invoice is the first document in the chain, not the last: it takes the
-- stock from the warehouse itself. It names no delivery, and the trigger read
-- that as a delivery that was missing — the row it looked for returned
-- nothing, `v_status` came back null, and the message said "Delivery Note
-- <NULL> is missing" to somebody who never mentioned one.
--
-- So the guard now asks first whether a delivery was named. If one was, it is
-- held to everything it was held to before. If none was, there is nothing to
-- reconcile against and the invoice stands on its own — and the stock it moved
-- is checked where that actually happens, by the warehouse refusing to go
-- negative.
CREATE OR REPLACE FUNCTION ar_invoice_has_a_real_delivery() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status    text;
  v_order     uuid;
  v_note_no   text;
  v_date      date;
  v_branch    text;
  v_customer  uuid;
BEGIN
  -- Raised on its own (Operations block 5). Nothing to reconcile against.
  IF NEW.delivery_note_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT n.status::text, n.sales_order_id, n.delivery_note_no, n.delivery_date, n.branch_code,
         o.customer_id
    INTO v_status, v_order, v_note_no, v_date, v_branch, v_customer
    FROM delivery_note n
    JOIN sales_order o ON o.id = n.sales_order_id
   WHERE n.id = NEW.delivery_note_id;

  IF v_status IS DISTINCT FROM 'executed' THEN
    RAISE EXCEPTION
      'Delivery Note % is %, and blueprint 7.4 requires every inventory A/R Invoice to come from an approved Delivery Note. A note that has not delivered has given the customer nothing to be billed for.',
      v_note_no, coalesce(v_status, 'missing')
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.sales_order_id IS DISTINCT FROM v_order THEN
    RAISE EXCEPTION
      'A/R Invoice names Sales Order % but Delivery Note % was raised against another. The invoice, the delivery and the order reconcile to each other (blueprint 7.7).',
      NEW.sales_order_id, v_note_no
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.customer_id IS DISTINCT FROM v_customer THEN
    RAISE EXCEPTION
      'A/R Invoice bills a different customer from the one Sales Order behind Delivery Note % was taken for.',
      v_note_no
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.invoice_date IS DISTINCT FROM v_date THEN
    RAISE EXCEPTION
      'A/R Invoice is dated % but Delivery Note % was delivered on %. Blueprint 7.4 requires the invoice to be issued on the delivery date, so the cost and the revenue of a sale share a period.',
      NEW.invoice_date, v_note_no, v_date
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.branch_code IS DISTINCT FROM v_branch THEN
    RAISE EXCEPTION
      'A/R Invoice is in branch % but Delivery Note % was delivered from %.',
      NEW.branch_code, v_note_no, v_branch
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
