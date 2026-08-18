-- ---------------------------------------------------------------------------
-- Phases 11 and 12 — the §24 approval shape for the project and the fixed asset.
--
-- Two status vocabularies coexist in this system, deliberately, and it is worth
-- writing down which is which because the difference is easy to lose.
--
--   §24's eleven words - draft, submitted, approved, partially_executed,
--   executed, posted, settled, rejected, cancelled, reversed, closed - are the
--   *approval shape*: where a document is in its journey through the workflow
--   engine. They live in the `document_status` enum and their legal moves are
--   configured here, per document type.
--
--   A module's own enum is its *operational lifecycle*: what the thing is doing
--   in the world. `lead_status` (new, working, qualified, converted, lost),
--   `stock_count_status` (planned, counted, recount, ...) and
--   `warehouse_transfer_status` are all of this kind, and none of their words
--   appears in the eleven.
--
-- Appendix B lists the second kind. For the Fixed Asset Document it names
-- "Draft, Approved, Available for Use, Active, Disposed, Closed, Reversed", and
-- three of those seven are outside §24's list. Forcing them into it would lose
-- exactly the distinction §18.5 turns on - an asset that is *available for use*
-- is the only one that may depreciate, and no §24 word says that.
--
-- So `fixed_asset_status` and `project_status` stay, as `lead_status` does, and
-- what is registered below is the approval shape those documents share with
-- every other document: raised, reviewed, approved or rejected, eventually
-- closed. This is what `lead`, `crm_case`, `opportunity` and `stock_count`
-- register, and for the same reason - the workflow engine reads it, and an
-- auditor reading `document_status_transition` should not find these two
-- documents simply absent.
-- ---------------------------------------------------------------------------
INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
  -- §10. A project contract is raised, reviewed, and approved by somebody other
  -- than its author (§5.2) before its baseline is frozen. Closure is the end of
  -- the approval shape as well as of the work.
  ('project', 'draft',     'submitted'),
  ('project', 'draft',     'cancelled'),
  ('project', 'submitted', 'draft'),
  ('project', 'submitted', 'approved'),
  ('project', 'submitted', 'rejected'),
  ('project', 'approved',  'closed'),

  -- §18.2. Finance creates the document from approved purchasing evidence, so
  -- the review that matters is of the document, not of the purchase. Recognition
  -- posts, which is why `posted` follows `approved` here and `available_for_use`
  -- - an operational state - does not appear.
  ('fixed_asset', 'draft',     'submitted'),
  ('fixed_asset', 'draft',     'cancelled'),
  ('fixed_asset', 'submitted', 'draft'),
  ('fixed_asset', 'submitted', 'approved'),
  ('fixed_asset', 'submitted', 'rejected'),
  ('fixed_asset', 'approved',  'posted'),
  ('fixed_asset', 'posted',    'closed')
ON CONFLICT DO NOTHING;
