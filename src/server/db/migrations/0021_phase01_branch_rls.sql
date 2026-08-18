-- ===========================================================================
-- Row-level security on branch-scoped documents — Phase 01.2, §22, §25.
--
-- HAND-AUTHORED. Drizzle does not model policies.
--
-- 01.2 gate: "A user scoped to Branch A cannot read a Branch B record by ID."
-- §22:       "Row-level security is enforced in the query layer, not only
--             hidden in the screen."
--
-- Phase 01 put this on audit_event and nowhere else, so every transactional
-- table since has been protected only by the predicate the service layer adds.
-- That is one forgotten WHERE clause away from a cross-branch read, and the
-- forgotten clause is never in the code being reviewed — it is in the next
-- module, written in a hurry, by someone who assumed the database was holding
-- the line. This migration makes the database hold the line.
--
-- Scope is the branch of the **session**, matching audit_event and matching
-- §4.1's model: a user works in one branch at a time and switches deliberately.
-- A user holding several branches sees the one they are in; the others become
-- visible by switching, which is an act with an audit trail rather than an
-- accident of a query.
--
-- Master and configuration data is deliberately NOT scoped here. Warehouses,
-- bank accounts, cost centres, projects and posting rules carry a branch as an
-- attribute, but a user has to be able to see the list to choose from it, and
-- §1.2 makes them analytical dimensions rather than partitions. What is scoped
-- below is the record of what happened — documents, postings, approvals — which
-- is what the gate is about.
-- ===========================================================================

-- journal_line has no branch column of its own; it inherits the entry's, so it
-- is scoped through the parent rather than by duplicating the column. A line
-- whose entry is invisible is invisible.
ALTER TABLE journal_entry     ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE journal_entry     FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE journal_line      ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE journal_line      FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE subledger_entry   ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE subledger_entry   FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE posting_log       ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE posting_log       FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE posting_failure   ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE posting_failure   FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE workflow_instance ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE workflow_instance FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The shared shape.
--
-- Read:  super user, or a row with no branch (company-wide), or your branch.
--        Unlike audit_event, a NULL branch is readable by everyone here: a
--        company-wide journal or workflow is not administration-private, and
--        hiding it would make documents disappear rather than be refused.
-- Write: never into a branch you are not in. An actor who could write into
--        another branch could plant a document they can then not see, which is
--        worse than being unable to write at all.
-- ---------------------------------------------------------------------------
CREATE POLICY journal_entry_branch_scope ON journal_entry
  USING (
    app_is_super_user()
    OR branch_code IS NULL
    OR branch_code = app_current_branch()
  )
  WITH CHECK (
    app_is_super_user()
    OR branch_code IS NULL
    OR branch_code = app_current_branch()
  );--> statement-breakpoint

CREATE POLICY journal_line_branch_scope ON journal_line
  USING (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM journal_entry e
       WHERE e.id = journal_line.journal_entry_id
         AND (e.branch_code IS NULL OR e.branch_code = app_current_branch())
    )
  )
  WITH CHECK (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM journal_entry e
       WHERE e.id = journal_line.journal_entry_id
         AND (e.branch_code IS NULL OR e.branch_code = app_current_branch())
    )
  );--> statement-breakpoint

CREATE POLICY subledger_entry_branch_scope ON subledger_entry
  USING (
    app_is_super_user()
    OR branch_code IS NULL
    OR branch_code = app_current_branch()
  )
  WITH CHECK (
    app_is_super_user()
    OR branch_code IS NULL
    OR branch_code = app_current_branch()
  );--> statement-breakpoint

CREATE POLICY posting_log_branch_scope ON posting_log
  USING (
    app_is_super_user()
    OR branch_code IS NULL
    OR branch_code = app_current_branch()
  )
  WITH CHECK (
    app_is_super_user()
    OR branch_code IS NULL
    OR branch_code = app_current_branch()
  );--> statement-breakpoint

CREATE POLICY posting_failure_branch_scope ON posting_failure
  USING (
    app_is_super_user()
    OR branch_code IS NULL
    OR branch_code = app_current_branch()
  )
  WITH CHECK (
    app_is_super_user()
    OR branch_code IS NULL
    OR branch_code = app_current_branch()
  );--> statement-breakpoint

CREATE POLICY workflow_instance_branch_scope ON workflow_instance
  USING (
    app_is_super_user()
    OR branch_code IS NULL
    OR branch_code = app_current_branch()
  )
  WITH CHECK (
    app_is_super_user()
    OR branch_code IS NULL
    OR branch_code = app_current_branch()
  );
