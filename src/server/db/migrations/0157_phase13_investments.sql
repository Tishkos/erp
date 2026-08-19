-- ---------------------------------------------------------------------------
-- Phase 13 — Investment Management. §13, Appendix D, Appendix E (IFRS 9).
--
-- ── The two catalogues that ship empty ──────────────────────────────────────
-- §13: "The legal and accounting treatment of investments differs by
-- instrument. The IT team must implement configurable types and posting rules
-- **only after Finance defines the required categories**." And: "Valuation
-- methods and frequency require Finance approval."
--
-- `investment_type` and `investment_valuation_method` are created here and
-- **seeded with nothing**. That is the whole safety of shipping ahead of D2:
--
--   · an investment names a type through a foreign key, so with no types there
--     is nothing to record an investment against;
--   · a valuation names a method the same way.
--
-- Emptiness refuses. A plausible-looking seed list would be worse than none: an
-- investment posted under an invented category is a misstatement, and no test in
-- this phase would catch it, because the test would be written against the same
-- invented rule.
-- ---------------------------------------------------------------------------

CREATE TABLE investment_type (
  code                            text PRIMARY KEY,
  name                            text NOT NULL,
  description                     text,
  required_fields                 text[] NOT NULL DEFAULT '{}'::text[],
  cost_account_role               text NOT NULL DEFAULT 'investment_cost',
  income_account_role             text NOT NULL DEFAULT 'investment_income',
  valuation_account_role          text NOT NULL DEFAULT 'investment_valuation',
  impairment_account_role         text NOT NULL DEFAULT 'investment_impairment',
  disposal_gain_role              text NOT NULL DEFAULT 'investment_disposal_gain',
  disposal_loss_role              text NOT NULL DEFAULT 'investment_disposal_loss',
  related_party_approval_required boolean NOT NULL DEFAULT false,
  active                          boolean NOT NULL DEFAULT true,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT investment_type_code_not_blank CHECK (btrim(code) <> '')
);--> statement-breakpoint

CREATE TABLE investment_valuation_method (
  code                    text PRIMARY KEY,
  name                    text NOT NULL,
  review_frequency_months smallint,
  note                    text,
  active                  boolean NOT NULL DEFAULT true,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT investment_valuation_method_code_not_blank CHECK (btrim(code) <> ''),
  CONSTRAINT investment_valuation_method_frequency_positive
    CHECK (review_frequency_months IS NULL OR review_frequency_months > 0)
);--> statement-breakpoint

-- 13.2 — proposal and approval -----------------------------------------------
CREATE TABLE investment_proposal (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_no                 text NOT NULL,
  status                      document_status NOT NULL DEFAULT 'draft',
  type_code                   text NOT NULL REFERENCES investment_type(code),
  branch_code                 text NOT NULL REFERENCES branch(code),
  amount_iqd                  numeric(19,4) NOT NULL,
  currency_code               text NOT NULL REFERENCES currency(code),
  expected_return             text NOT NULL,
  risk_assessment             text NOT NULL,
  counterparty_partner_id     uuid REFERENCES business_partner(id),
  is_related_party            boolean NOT NULL DEFAULT false,
  related_party_note          text,
  proposed_on                 date NOT NULL,
  management_approved_by      uuid REFERENCES app_user(id),
  management_approved_at      timestamptz,
  funding_approved_by         uuid REFERENCES app_user(id),
  funding_approved_at         timestamptz,
  related_party_approved_by   uuid REFERENCES app_user(id),
  related_party_approved_at   timestamptz,
  rejected_by                 uuid REFERENCES app_user(id),
  rejection_reason            text,
  created_by                  uuid NOT NULL REFERENCES app_user(id),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT investment_proposal_amount_positive CHECK (amount_iqd > 0),
  CONSTRAINT investment_proposal_return_stated CHECK (btrim(expected_return) <> ''),
  CONSTRAINT investment_proposal_risk_stated CHECK (btrim(risk_assessment) <> ''),
  -- An approval is a person and a time, or it is neither. Half of one cannot be
  -- audited, and §5.2 is about who made which decision.
  CONSTRAINT investment_proposal_management_approval_complete
    CHECK ((management_approved_by IS NULL) = (management_approved_at IS NULL)),
  CONSTRAINT investment_proposal_funding_approval_complete
    CHECK ((funding_approved_by IS NULL) = (funding_approved_at IS NULL)),
  CONSTRAINT investment_proposal_related_party_approval_complete
    CHECK ((related_party_approved_by IS NULL) = (related_party_approved_at IS NULL)),
  CONSTRAINT investment_proposal_rejection_has_reason
    CHECK (rejected_by IS NULL OR coalesce(btrim(rejection_reason), '') <> '')
);--> statement-breakpoint

CREATE UNIQUE INDEX investment_proposal_no_uniq ON investment_proposal (proposal_no);--> statement-breakpoint
CREATE INDEX investment_proposal_type_idx ON investment_proposal (type_code, status);--> statement-breakpoint
CREATE INDEX investment_proposal_branch_idx ON investment_proposal (branch_code, proposed_on);--> statement-breakpoint

-- 13.1 / 13.3 — the register entry -------------------------------------------
--
-- No carrying_value column, deliberately. §13 requires historical valuations to
-- be preserved and never overwritten, so carrying value is the latest valuation
-- less impairment — read, not stored. A column would be a second opinion about
-- the same fact and would part company with the history the first time a
-- valuation was corrected.
CREATE TABLE investment (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  investment_no           text NOT NULL,
  status                  document_status NOT NULL DEFAULT 'draft',
  type_code               text NOT NULL REFERENCES investment_type(code),
  proposal_id             uuid NOT NULL REFERENCES investment_proposal(id),
  branch_code             text NOT NULL REFERENCES branch(code),
  description             text NOT NULL,
  counterparty_partner_id uuid REFERENCES business_partner(id),
  custodian               text,
  custody_account         text,
  ownership_percent       numeric(9,4),
  units_held              numeric(24,6) NOT NULL DEFAULT 0,
  currency_code           text NOT NULL REFERENCES currency(code),
  cost_txn                numeric(19,4) NOT NULL DEFAULT 0,
  cost_iqd                numeric(19,4) NOT NULL DEFAULT 0,
  acquired_on             date,
  maturity_date           date,
  next_review_on          date,
  disposed_on             date,
  closed_by               uuid REFERENCES app_user(id),
  closed_at               timestamptz,
  created_by              uuid NOT NULL REFERENCES app_user(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT investment_units_not_negative CHECK (units_held >= 0),
  CONSTRAINT investment_cost_not_negative CHECK (cost_txn >= 0 AND cost_iqd >= 0),
  CONSTRAINT investment_ownership_percent_range
    CHECK (ownership_percent IS NULL OR (ownership_percent > 0 AND ownership_percent <= 100))
);--> statement-breakpoint

CREATE UNIQUE INDEX investment_no_uniq ON investment (investment_no);--> statement-breakpoint
-- One proposal buys one investment. §13 acceptance 1 makes the proposal the
-- control, and a proposal that could be spent twice is not a control.
CREATE UNIQUE INDEX investment_proposal_uniq ON investment (proposal_id);--> statement-breakpoint
CREATE INDEX investment_type_idx ON investment (type_code, status);--> statement-breakpoint
CREATE INDEX investment_counterparty_idx ON investment (counterparty_partner_id);--> statement-breakpoint
CREATE INDEX investment_maturity_idx ON investment (maturity_date);--> statement-breakpoint
CREATE INDEX investment_review_idx ON investment (next_review_on);--> statement-breakpoint

-- 13.3 — funding, through Treasury -------------------------------------------
CREATE TABLE investment_funding (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  investment_id        uuid NOT NULL REFERENCES investment(id),
  funding_no           text NOT NULL,
  kind                 text NOT NULL,
  funded_on            date NOT NULL,
  units_acquired       numeric(24,6) NOT NULL DEFAULT 0,
  amount_txn           numeric(19,4) NOT NULL,
  amount_iqd           numeric(19,4) NOT NULL,
  bank_cash_account_id uuid NOT NULL REFERENCES bank_cash_account(id),
  journal_entry_id     uuid REFERENCES journal_entry(id),
  posted_by            uuid NOT NULL REFERENCES app_user(id),
  created_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT investment_funding_amount_positive CHECK (amount_txn > 0 AND amount_iqd > 0),
  CONSTRAINT investment_funding_units_not_negative CHECK (units_acquired >= 0),
  CONSTRAINT investment_funding_kind CHECK (kind IN ('acquisition', 'capital_call'))
);--> statement-breakpoint

CREATE UNIQUE INDEX investment_funding_no_uniq ON investment_funding (funding_no);--> statement-breakpoint
CREATE INDEX investment_funding_investment_idx ON investment_funding (investment_id, funded_on);--> statement-breakpoint

-- 13.4 — income. Evidence and bank are NOT NULL: §13 says these records
-- "require source evidence", without qualification.
CREATE TABLE investment_income (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  investment_id          uuid NOT NULL REFERENCES investment(id),
  income_no              text NOT NULL,
  kind                   text NOT NULL,
  received_on            date NOT NULL,
  amount_txn             numeric(19,4) NOT NULL,
  amount_iqd             numeric(19,4) NOT NULL,
  bank_cash_account_id   uuid NOT NULL REFERENCES bank_cash_account(id),
  evidence_attachment_id uuid NOT NULL REFERENCES attachment(id),
  journal_entry_id       uuid REFERENCES journal_entry(id),
  posted_by              uuid NOT NULL REFERENCES app_user(id),
  created_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT investment_income_amount_positive CHECK (amount_txn > 0 AND amount_iqd > 0),
  CONSTRAINT investment_income_kind_not_blank CHECK (btrim(kind) <> '')
);--> statement-breakpoint

CREATE UNIQUE INDEX investment_income_no_uniq ON investment_income (income_no);--> statement-breakpoint
CREATE INDEX investment_income_investment_idx ON investment_income (investment_id, received_on);--> statement-breakpoint

-- 13.5 — valuation. Append only: no superseded flag, no update path, and one
-- row per holding per date so "the value on that date" has one answer.
CREATE TABLE investment_valuation (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  investment_id    uuid NOT NULL REFERENCES investment(id),
  valued_on        date NOT NULL,
  method_code      text NOT NULL REFERENCES investment_valuation_method(code),
  value_txn        numeric(19,4) NOT NULL,
  value_iqd        numeric(19,4) NOT NULL,
  approved_by      uuid NOT NULL REFERENCES app_user(id),
  approved_at      timestamptz NOT NULL DEFAULT now(),
  basis            text,
  journal_entry_id uuid REFERENCES journal_entry(id),

  CONSTRAINT investment_valuation_not_negative CHECK (value_txn >= 0 AND value_iqd >= 0)
);--> statement-breakpoint

CREATE UNIQUE INDEX investment_valuation_date_uniq
  ON investment_valuation (investment_id, valued_on);--> statement-breakpoint
CREATE INDEX investment_valuation_investment_idx
  ON investment_valuation (investment_id, valued_on);--> statement-breakpoint

CREATE TABLE investment_impairment (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  investment_id             uuid NOT NULL REFERENCES investment(id),
  impaired_on               date NOT NULL,
  amount_iqd                numeric(19,4) NOT NULL,
  basis                     text NOT NULL,
  carrying_value_before_iqd numeric(19,4) NOT NULL,
  approved_by               uuid NOT NULL REFERENCES app_user(id),
  approved_at               timestamptz NOT NULL DEFAULT now(),
  journal_entry_id          uuid REFERENCES journal_entry(id),

  CONSTRAINT investment_impairment_amount_positive CHECK (amount_iqd > 0),
  CONSTRAINT investment_impairment_basis_stated CHECK (btrim(basis) <> '')
);--> statement-breakpoint

CREATE INDEX investment_impairment_investment_idx
  ON investment_impairment (investment_id, impaired_on);--> statement-breakpoint

-- 13.6 — disposal -------------------------------------------------------------
CREATE TABLE investment_disposal (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  investment_id               uuid NOT NULL REFERENCES investment(id),
  disposal_no                 text NOT NULL,
  disposed_on                 date NOT NULL,
  units_disposed              numeric(24,6) NOT NULL,
  proceeds_txn                numeric(19,4) NOT NULL,
  proceeds_iqd                numeric(19,4) NOT NULL,
  carrying_value_disposed_iqd numeric(19,4) NOT NULL,
  realised_result_iqd         numeric(19,4) NOT NULL,
  is_full_disposal            boolean NOT NULL,
  bank_cash_account_id        uuid NOT NULL REFERENCES bank_cash_account(id),
  evidence_attachment_id      uuid NOT NULL REFERENCES attachment(id),
  journal_entry_id            uuid REFERENCES journal_entry(id),
  posted_by                   uuid NOT NULL REFERENCES app_user(id),
  created_at                  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT investment_disposal_units_positive CHECK (units_disposed > 0),
  CONSTRAINT investment_disposal_proceeds_not_negative
    CHECK (proceeds_txn >= 0 AND proceeds_iqd >= 0)
);--> statement-breakpoint

CREATE UNIQUE INDEX investment_disposal_no_uniq ON investment_disposal (disposal_no);--> statement-breakpoint
CREATE INDEX investment_disposal_investment_idx
  ON investment_disposal (investment_id, disposed_on);--> statement-breakpoint

-- 13.7 — the capital-call half of the calendar --------------------------------
CREATE TABLE investment_capital_call (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  investment_id uuid NOT NULL REFERENCES investment(id),
  due_on        date NOT NULL,
  amount_txn    numeric(19,4) NOT NULL,
  -- Both amounts, per §A4 — the same as income, funding and disposal carry.
  -- Without this the Phase 07.8 forecast reads the transaction amount and
  -- reports a foreign-currency call to the treasurer as though it were dinars.
  amount_iqd    numeric(19,4) NOT NULL,
  note          text,
  funded_by_id  uuid REFERENCES investment_funding(id),
  created_by    uuid NOT NULL REFERENCES app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT investment_capital_call_amount_positive CHECK (amount_txn > 0 AND amount_iqd > 0)
);--> statement-breakpoint

CREATE INDEX investment_capital_call_due_idx ON investment_capital_call (due_on);--> statement-breakpoint
CREATE INDEX investment_capital_call_investment_idx
  ON investment_capital_call (investment_id, due_on);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Rules the database keeps
-- ---------------------------------------------------------------------------

-- §13 — the register cannot hold more units than were acquired less disposed,
-- and a disposal cannot take more than is held. The service computes the split;
-- this refuses the state whatever computed it.
CREATE FUNCTION investment_disposal_within_holding() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_units numeric(24,6);
  v_no    text;
BEGIN
  SELECT units_held, investment_no INTO v_units, v_no
    FROM investment WHERE id = NEW.investment_id;

  IF NEW.units_disposed > v_units THEN
    RAISE EXCEPTION
      'Investment % holds % units and the disposal is for % (blueprint 13).',
      v_no, v_units, NEW.units_disposed
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER investment_disposal_within_holding
  BEFORE INSERT ON investment_disposal
  FOR EACH ROW EXECUTE FUNCTION investment_disposal_within_holding();--> statement-breakpoint

-- §13 acceptance 1 — an acquisition rests on an approved proposal. The service
-- checks the three approvals; this refuses a register entry whose proposal is
-- missing either of the two that are always required.
CREATE FUNCTION investment_needs_approved_proposal() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_management uuid;
  v_funding    uuid;
  v_no         text;
BEGIN
  SELECT management_approved_by, funding_approved_by, proposal_no
    INTO v_management, v_funding, v_no
    FROM investment_proposal WHERE id = NEW.proposal_id;

  IF v_management IS NULL OR v_funding IS NULL THEN
    RAISE EXCEPTION
      'Proposal % is not fully approved: an investment needs management approval and funding approval before it exists (blueprint 13, acceptance 1).',
      v_no USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER investment_needs_approved_proposal
  BEFORE INSERT ON investment
  FOR EACH ROW EXECUTE FUNCTION investment_needs_approved_proposal();--> statement-breakpoint

-- §13 — "the system preserves historical valuations; it does not overwrite
-- prior values." There is no service path that updates one; this makes the
-- absence a guarantee rather than a habit.
CREATE FUNCTION investment_valuation_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'A valuation is not edited (blueprint 13). Historical valuations are preserved; record a new valuation on a new date instead.'
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint

CREATE TRIGGER investment_valuation_is_append_only
  BEFORE UPDATE OR DELETE ON investment_valuation
  FOR EACH ROW EXECUTE FUNCTION investment_valuation_is_append_only();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Registration: document types, numbering, permissions
-- ---------------------------------------------------------------------------

INSERT INTO document_type (code, name, module, description) VALUES
  ('investment_proposal', 'Investment Proposal', 'investments',
   'Blueprint 13 workflow steps 1 and 2: amount, currency, type, expected return and risk, then management approval and funding-source approval. Related-party status is captured always and gates acquisition where the type requires it.'),
  ('investment', 'Investment', 'investments',
   'The register entry. Created only from a fully approved proposal, and only in the same transaction as its accounting entry - blueprint 13 acceptance 1. Carrying value is not stored: it is the latest valuation less impairment, so the register cannot disagree with the valuation history.')
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
  ('investment_proposal', 'draft',     'submitted'),
  ('investment_proposal', 'draft',     'cancelled'),
  ('investment_proposal', 'submitted', 'draft'),
  ('investment_proposal', 'submitted', 'approved'),
  ('investment_proposal', 'submitted', 'rejected'),
  ('investment_proposal', 'draft',     'rejected'),
  ('investment_proposal', 'approved',  'settled'),
  ('investment', 'draft',  'posted'),
  ('investment', 'posted', 'settled'),
  ('investment', 'posted', 'closed'),
  ('investment', 'settled','closed'),
  ('investment', 'posted', 'reversed')
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO document_type_controlled_field (document_type_code, field_name, note) VALUES
  ('investment', 'cost_iqd',
   'What the holding cost. It is what the acquisition posted, so it moves only when a funding or disposal moves it.'),
  ('investment', 'units_held',
   'Maintained from fundings and disposals, never set directly.'),
  ('investment', 'proposal_id',
   'The approval this holding rests on. Blueprint 13 acceptance 1 makes it the control, and a control that could be re-pointed is not one.'),
  ('investment_proposal', 'amount_iqd',
   'What was approved. Changing it after approval would mean spending against a decision nobody made.'),
  ('investment_proposal', 'type_code',
   'The category, which determines required fields and account mappings.')
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year) VALUES
  ('INVESTMENT_PROPOSAL', 'INP', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true),
  ('INVESTMENT',          'INV', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true),
  ('INVESTMENT_FUNDING',  'INF', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true),
  ('INVESTMENT_INCOME',   'INI', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true),
  ('INVESTMENT_DISPOSAL', 'IND', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true)
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer',  'investment_proposal', 'view'),
  ('accounting_officer',  'investment_proposal', 'create'),
  ('accounting_officer',  'investment_proposal', 'edit_draft'),
  ('accounting_manager',  'investment_proposal', 'view'),
  ('accounting_manager',  'investment_proposal', 'create'),
  ('accounting_manager',  'investment_proposal', 'edit_draft'),
  ('accounting_manager',  'investment_proposal', 'approve'),
  ('accounting_manager',  'investment_proposal', 'export'),
  ('accounting_officer',  'investment', 'view'),
  ('accounting_officer',  'investment', 'create'),
  ('accounting_manager',  'investment', 'view'),
  ('accounting_manager',  'investment', 'create'),
  ('accounting_manager',  'investment', 'approve'),
  ('accounting_manager',  'investment', 'post'),
  ('accounting_manager',  'investment', 'configure'),
  ('accounting_manager',  'investment', 'export'),
  ('accounting_manager',  'investment', 'print')
ON CONFLICT DO NOTHING;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist - grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON investment_type, investment_valuation_method, investment_proposal,
                investment, investment_funding, investment_income,
                investment_valuation, investment_impairment, investment_disposal,
                investment_capital_call FROM erp_app;

  GRANT SELECT                 ON investment_type               TO erp_app;
  GRANT SELECT                 ON investment_valuation_method   TO erp_app;
  GRANT SELECT, INSERT, UPDATE ON investment_proposal           TO erp_app;
  GRANT SELECT, INSERT, UPDATE ON investment                    TO erp_app;
  GRANT SELECT, INSERT         ON investment_funding            TO erp_app;
  GRANT SELECT, INSERT         ON investment_income             TO erp_app;
  GRANT SELECT, INSERT         ON investment_valuation          TO erp_app;
  GRANT SELECT, INSERT         ON investment_impairment         TO erp_app;
  GRANT SELECT, INSERT         ON investment_disposal           TO erp_app;
  GRANT SELECT, INSERT, UPDATE ON investment_capital_call       TO erp_app;
END;
$$;--> statement-breakpoint

-- D10 — the branch boundary. The children reach through the holding.
ALTER TABLE investment_proposal ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE investment_proposal FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY investment_proposal_branch_scope ON investment_proposal
  USING (app_branch_allowed(branch_code))
  WITH CHECK (app_branch_allowed(branch_code));--> statement-breakpoint

ALTER TABLE investment ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE investment FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY investment_branch_scope ON investment
  USING (app_branch_allowed(branch_code))
  WITH CHECK (app_branch_allowed(branch_code));--> statement-breakpoint

ALTER TABLE investment_funding ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE investment_funding FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY investment_funding_branch_scope ON investment_funding
  USING (EXISTS (SELECT 1 FROM investment i
                  WHERE i.id = investment_funding.investment_id
                    AND app_branch_allowed(i.branch_code)))
  WITH CHECK (EXISTS (SELECT 1 FROM investment i
                       WHERE i.id = investment_funding.investment_id
                         AND app_branch_allowed(i.branch_code)));--> statement-breakpoint

ALTER TABLE investment_income ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE investment_income FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY investment_income_branch_scope ON investment_income
  USING (EXISTS (SELECT 1 FROM investment i
                  WHERE i.id = investment_income.investment_id
                    AND app_branch_allowed(i.branch_code)))
  WITH CHECK (EXISTS (SELECT 1 FROM investment i
                       WHERE i.id = investment_income.investment_id
                         AND app_branch_allowed(i.branch_code)));--> statement-breakpoint

ALTER TABLE investment_valuation ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE investment_valuation FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY investment_valuation_branch_scope ON investment_valuation
  USING (EXISTS (SELECT 1 FROM investment i
                  WHERE i.id = investment_valuation.investment_id
                    AND app_branch_allowed(i.branch_code)))
  WITH CHECK (EXISTS (SELECT 1 FROM investment i
                       WHERE i.id = investment_valuation.investment_id
                         AND app_branch_allowed(i.branch_code)));--> statement-breakpoint

ALTER TABLE investment_impairment ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE investment_impairment FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY investment_impairment_branch_scope ON investment_impairment
  USING (EXISTS (SELECT 1 FROM investment i
                  WHERE i.id = investment_impairment.investment_id
                    AND app_branch_allowed(i.branch_code)))
  WITH CHECK (EXISTS (SELECT 1 FROM investment i
                       WHERE i.id = investment_impairment.investment_id
                         AND app_branch_allowed(i.branch_code)));--> statement-breakpoint

ALTER TABLE investment_disposal ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE investment_disposal FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY investment_disposal_branch_scope ON investment_disposal
  USING (EXISTS (SELECT 1 FROM investment i
                  WHERE i.id = investment_disposal.investment_id
                    AND app_branch_allowed(i.branch_code)))
  WITH CHECK (EXISTS (SELECT 1 FROM investment i
                       WHERE i.id = investment_disposal.investment_id
                         AND app_branch_allowed(i.branch_code)));--> statement-breakpoint

ALTER TABLE investment_capital_call ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE investment_capital_call FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY investment_capital_call_branch_scope ON investment_capital_call
  USING (EXISTS (SELECT 1 FROM investment i
                  WHERE i.id = investment_capital_call.investment_id
                    AND app_branch_allowed(i.branch_code)))
  WITH CHECK (EXISTS (SELECT 1 FROM investment i
                       WHERE i.id = investment_capital_call.investment_id
                         AND app_branch_allowed(i.branch_code)));
