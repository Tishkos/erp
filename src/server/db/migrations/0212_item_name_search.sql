-- Searching the Warehouses Report by the item's name.
--
-- The report filtered by an exact item code chosen from a drop-down of every
-- stock item. A person holding a name had to read past the code to find it, and
-- the list grows with the catalogue. The filter is now the name, typed.
--
-- A typed name means `like '%term%'`, and a plain b-tree cannot serve a leading
-- wildcard — it would be a sequential scan of `item` on every search. Trigram
-- indexes can: `pg_trgm` breaks the text into three-character runs and a GIN
-- index over them answers a substring match without reading the table.
--
-- Indexed on `lower(...)` because the search is case-insensitive, and the
-- expression in the index has to be the expression in the query for the planner
-- to use it. The code is indexed the same way: a person who has the code should
-- still be able to type it into the same box.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS item_name_trgm_idx
  ON item USING gin (lower(name) gin_trgm_ops);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS item_code_trgm_idx
  ON item USING gin (lower(code) gin_trgm_ops);--> statement-breakpoint

-- The report groups cost layers by item and warehouse and keeps only what is
-- still on hand, so that is the shape it is read in. Partial, because a layer
-- counted down to nothing is never in the answer.
CREATE INDEX IF NOT EXISTS cost_layer_remaining_item_warehouse_idx
  ON cost_layer (item_code, warehouse_code, branch_code)
  WHERE remaining_quantity > 0;
