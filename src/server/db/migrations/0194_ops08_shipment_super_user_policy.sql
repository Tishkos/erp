-- The shipment policy asks the same question as every other one (2026-09-15).
--
-- Block 8's policy was written by hand:
--
--   current_setting('app.is_super_user', true) = 'on'
--
-- Every other policy in the schema calls `app_is_super_user()`, which casts the
-- setting to boolean instead of comparing it to a string. The difference is not
-- cosmetic. `applyScope` writes 'true', not 'on', so the hand-written form was
-- false for everybody: the super-user branch never fired.
--
-- What that looks like in use is worse than an error. A super user holds no
-- rows in `user_branch_scope` — being able to see every branch is the whole
-- point of the role — so the second half of the policy matched nothing either,
-- and the shipment list came back empty. Not "permission denied", which someone
-- would have reported. Empty, which reads as "there are no shipments".
--
-- Replacing the expression with the function everything else uses, so there is
-- one answer to "is this a super user" rather than two that can disagree.
DROP POLICY IF EXISTS "supplier_shipment_branch" ON "supplier_shipment";
--> statement-breakpoint

CREATE POLICY "supplier_shipment_branch" ON "supplier_shipment"
  USING (
    app_is_super_user()
    OR "branch_code" IN (
      SELECT branch_code FROM user_branch_scope
       WHERE user_id = current_setting('app.user_id', true)::uuid
    )
  );
