-- Finance owns the statement mapping.
--
-- 0175 built the mapping screen and 0177 gave it all four statements, but no
-- role was ever granted `configure` on `financial_statement`. Only a super
-- user could open it, which went unnoticed because every review of the screen
-- was done as one.
--
-- That is backwards for this screen in particular. The sponsor asked for it as
-- the finance expert: "let me as the finance expert to be able to create the
-- reports mapping". An accounting manager already configures the chart of
-- accounts, the posting rules and the tax codes; the statement each account
-- reports on belongs in the same hands.
--
-- View and export were already granted in 0167. This adds the missing verb.
INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_manager', 'financial_statement', 'configure')
ON CONFLICT DO NOTHING;

-- A system administrator keeps their read-only relationship with the books
-- (0167: "They administer the system rather than keep the books"), so they are
-- deliberately not added here.
