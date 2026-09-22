ALTER TABLE item ADD COLUMN selling_price_iqd numeric(19,4);
--> statement-breakpoint
ALTER TABLE item ADD CONSTRAINT item_selling_price_non_negative CHECK (selling_price_iqd IS NULL OR selling_price_iqd >= 0);
--> statement-breakpoint
ALTER TABLE item_supplier ADD COLUMN purchase_price_iqd numeric(19,4);
--> statement-breakpoint
ALTER TABLE item_supplier ADD CONSTRAINT item_supplier_purchase_price_non_negative CHECK (purchase_price_iqd IS NULL OR purchase_price_iqd >= 0);
