-- Phase 1 — the reports exist, and nobody could open them.
--
-- The documents were granted long ago: an accounting officer may raise a
-- journal, a manager may post one. But the *reports* Phase 1 requirement 4 and
-- 5 ask for are separate permission objects — `gl_inquiry`, `trial_balance`,
-- `financial_statement`, `journal_reversal` — and no role had been granted
-- anything over them, because until this phase there were no screens behind
-- them to open.
--
-- The consequence was the worst kind of quiet: the Trial Balance and the
-- financial statements built correctly, refused correctly, and told the
-- Accounting Manager to ask an administrator for access to a screen the
-- administrator had no way to grant either.
--
-- Reading a report is `view`; taking it away as a file is `export`. An
-- officer reads; a manager reads and exports.

INSERT INTO role_grant (role_code, object, verb) VALUES
  -- Requirement 4 — the General Ledger and the Trial Balance.
  ('accounting_officer', 'gl_inquiry',          'view'),
  ('accounting_manager', 'gl_inquiry',          'view'),
  ('accounting_manager', 'gl_inquiry',          'export'),
  ('accounting_officer', 'trial_balance',       'view'),
  ('accounting_manager', 'trial_balance',       'view'),
  ('accounting_manager', 'trial_balance',       'export'),

  -- Requirement 5 — the Statement of Profit or Loss and the Statement of
  -- Financial Position.
  ('accounting_officer', 'financial_statement', 'view'),
  ('accounting_manager', 'financial_statement', 'view'),
  ('accounting_manager', 'financial_statement', 'export'),

  -- Requirement 3 — the register of corrections. Reading it is reading the
  -- journals it lists, so the same people who may see a journal may see this.
  ('accounting_officer', 'journal_reversal',    'view'),
  ('accounting_manager', 'journal_reversal',    'view')
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- A system administrator sees the reports too. They administer the system
-- rather than keep the books, so they read and never post.
INSERT INTO role_grant (role_code, object, verb) VALUES
  ('system_administrator', 'gl_inquiry',          'view'),
  ('system_administrator', 'trial_balance',       'view'),
  ('system_administrator', 'financial_statement', 'view'),
  ('system_administrator', 'journal_reversal',    'view'),
  ('system_administrator', 'chart_of_account',    'view'),
  ('system_administrator', 'journal_entry',       'view'),
  ('system_administrator', 'fiscal_period',       'view'),
  ('system_administrator', 'exchange_rate',       'view')
ON CONFLICT DO NOTHING;--> statement-breakpoint
