-- ===========================================================================
-- Inventory permissions — Phase 04, section 5.3.
--
-- HAND-AUTHORED.
--
-- The inventory tables and services arrived in migrations 0025 to 0029 without
-- anyone being granted the right to use them, which is deny-by-default working
-- as intended (section 25) — and is also why every Phase 04 test has been
-- inserting its own grants. The catalogue belongs here, once, so the tests
-- exercise the same permissions production has.
--
-- The split follows section 5.3's separation of verbs:
--
--   execute  moving stock — receipts, issues, transfers, counts
--   approve  accepting a loss — damage, write-off, a count variance, a
--            transfer that never arrived. Each of those costs money, and
--            section 9.6 and 9.8 both put the decision with a Warehouse
--            Manager rather than with whoever is holding the scanner.
--   import   ten thousand movements at once, which section 5.3 keeps separate
--            from making one.
-- ===========================================================================

INSERT INTO role_grant (role_code, object, verb) VALUES
  -- An officer moves stock and reads it.
  ('accounting_officer', 'inventory_movement', 'view'),
  ('accounting_officer', 'inventory_movement', 'execute'),
  ('accounting_officer', 'inventory_movement', 'print'),
  ('accounting_officer', 'inventory_movement', 'export'),

  -- A manager also accepts losses and imports.
  ('accounting_manager', 'inventory_movement', 'view'),
  ('accounting_manager', 'inventory_movement', 'execute'),
  ('accounting_manager', 'inventory_movement', 'approve'),
  ('accounting_manager', 'inventory_movement', 'reverse_cancel'),
  ('accounting_manager', 'inventory_movement', 'import'),
  ('accounting_manager', 'inventory_movement', 'print'),
  ('accounting_manager', 'inventory_movement', 'export'),
  ('accounting_manager', 'inventory_movement', 'configure')
ON CONFLICT DO NOTHING;
