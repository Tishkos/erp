ALTER TABLE cost_layer
  ADD COLUMN original_value_iqd numeric(19,4),
  ADD COLUMN remaining_value_iqd numeric(19,4),
  ADD CONSTRAINT cost_layer_value_pair CHECK ((original_value_iqd IS NULL) = (remaining_value_iqd IS NULL)),
  ADD CONSTRAINT cost_layer_value_range CHECK (original_value_iqd IS NULL OR (original_value_iqd >= 0 AND remaining_value_iqd >= 0 AND remaining_value_iqd <= original_value_iqd)),
  ADD CONSTRAINT cost_layer_empty_value CHECK (remaining_quantity <> 0 OR remaining_value_iqd IS NULL OR remaining_value_iqd = 0);
