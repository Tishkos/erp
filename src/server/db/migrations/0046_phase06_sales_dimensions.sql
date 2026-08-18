-- ===========================================================================
-- §4.2 — the Sales Order carries the dimensions its postings will need.
--
-- Found while building 06.5. The Delivery Note posts Dr COGS / Cr Inventory
-- (Appendix C), COGS is an expense account, and 0005 makes **department** and
-- **business line** mandatory on every expense account by default:
--
--   INSERT INTO account_type_dimension_default (account_type, dimension) VALUES
--     ('expense', 'department'), ('expense', 'business_line'), ('revenue', 'business_line');
--
-- So a delivery could not post at all, and the missing values were not something
-- the delivery could invent: they are facts about the *sale*. Which business
-- line a sale belongs to — Product Sales, Contracting, Logistics — is decided
-- when the order is taken, and §4.2 exists precisely so that the company can
-- read a Profit & Loss per line afterwards. A Delivery Note that guessed would
-- be guessing at the shape of the P&L.
--
-- The same values will serve the A/R Invoice in 06.6, whose revenue account
-- requires business line by the same rule. Putting them on the order means the
-- sale is attributed once, at the point somebody knows the answer, rather than
-- three times by three documents that could disagree.
--
-- **Nullable, and validated where it matters.** Not every sale needs them: an
-- account that does not require a dimension does not want one invented for it,
-- and §4.2's requirement is a property of the *account*, not of the document.
-- The posting engine already refuses a posting whose account requires a
-- dimension it was not given (`assertDimensionsValid`, Phase 02), with a message
-- naming the account and the dimension. That is the check; these columns are
-- what let a user answer it.
-- ===========================================================================

ALTER TABLE "sales_order" ADD COLUMN "department_code" text;--> statement-breakpoint
ALTER TABLE "sales_order" ADD COLUMN "business_line_code" text;--> statement-breakpoint

ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_department_code_department_code_fk"
  FOREIGN KEY ("department_code") REFERENCES "public"."department"("code")
  ON DELETE no action ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_business_line_code_business_line_code_fk"
  FOREIGN KEY ("business_line_code") REFERENCES "public"."business_line"("code")
  ON DELETE no action ON UPDATE no action;--> statement-breakpoint

COMMENT ON COLUMN "sales_order"."business_line_code" IS
  'Blueprint 4.2 — which line of business the sale belongs to. Carried onto the Delivery Note''s COGS posting and the A/R Invoice''s revenue posting, so the two agree.';--> statement-breakpoint

COMMENT ON COLUMN "sales_order"."department_code" IS
  'Blueprint 4.2 — the department the sale is attributed to. Required by every expense account by default (migration 0005), which is what the delivery''s COGS line is.';--> statement-breakpoint

-- §14.2 and §24 — these decide where the money lands in the P&L, so they are
-- frozen at submission like the customer and the price list are.
INSERT INTO document_type_controlled_field (document_type_code, field_name, note) VALUES
  ('sales_order', 'business_line_code',
   'Decides which line of business the revenue and cost of this sale are reported under (blueprint 4.2).'),
  ('sales_order', 'department_code',
   'Decides which department the cost of this sale is attributed to (blueprint 4.2).')
ON CONFLICT DO NOTHING;
