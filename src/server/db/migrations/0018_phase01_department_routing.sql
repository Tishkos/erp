CREATE TYPE "public"."approver_kind" AS ENUM('role', 'department_manager');--> statement-breakpoint
ALTER TABLE "workflow_step" ADD COLUMN "approver_kind" "approver_kind" DEFAULT 'role' NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_instance" ADD COLUMN "department_code" text;--> statement-breakpoint
ALTER TABLE "workflow_instance" ADD COLUMN "assigned_to_user_id" uuid;--> statement-breakpoint
ALTER TABLE "workflow_instance" ADD CONSTRAINT "workflow_instance_assigned_to_user_id_app_user_id_fk" FOREIGN KEY ("assigned_to_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ===========================================================================
-- HAND-AUTHORED FROM HERE — Phase 01.3.
-- ===========================================================================

ALTER TABLE workflow_instance
  ADD CONSTRAINT workflow_instance_department_fk
  FOREIGN KEY (department_code) REFERENCES department(code);--> statement-breakpoint

-- The Department Manager's inbox: what is waiting for me, in my department.
CREATE INDEX workflow_instance_assignee_idx
  ON workflow_instance (assigned_to_user_id, submitted_at)
  WHERE is_complete = false;--> statement-breakpoint

CREATE INDEX workflow_instance_department_idx
  ON workflow_instance (department_code, submitted_at)
  WHERE is_complete = false;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §5.2 — the routing target is decided at submission and does not drift.
--
-- Re-pointing a live approval at a different person mid-flight would let a
-- document be steered to a more agreeable approver after the fact, which is the
-- one thing an approval route exists to prevent.
-- ---------------------------------------------------------------------------
CREATE FUNCTION workflow_instance_routing_fixed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Only a *change* is refused. Submission writes the row and then sets the
  -- routing on it, so the first write moves both from null to a value — that is
  -- the decision being recorded, not a decision being revised.
  IF OLD.department_code IS NOT NULL
     AND NEW.department_code IS DISTINCT FROM OLD.department_code THEN
    RAISE EXCEPTION
      'The department a submitted document belongs to cannot be changed. Recall it and submit it again (§5.2).'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.assigned_to_user_id IS NOT NULL
     AND NEW.assigned_to_user_id IS DISTINCT FROM OLD.assigned_to_user_id THEN
    RAISE EXCEPTION
      'A submitted document cannot be re-pointed at a different approver. Delegation is recorded as a decision (§01.7).'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER workflow_instance_routing_fixed
  BEFORE UPDATE ON workflow_instance
  FOR EACH ROW EXECUTE FUNCTION workflow_instance_routing_fixed();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The generic §5.2 document type.
--
-- Phase 01 has no operational documents yet — every type so far (accounts,
-- journals, partner bank accounts) is Finance-owned and routed by role under
-- §14.4. This one carries the other mechanism: it goes to whoever manages the
-- department the document belongs to. Phase 05's purchase requests and
-- Phase 15's leave requests point at this shape rather than reinventing it.
--
-- allow_self_approval is true because §5.2 says so outright: a Department
-- Manager raising a document in their own department finalises it directly.
-- Types with a segregation-of-duties requirement do not use this route.
-- ---------------------------------------------------------------------------
INSERT INTO document_type (code, name, module, description) VALUES
  ('department_request', 'Departmental Request', 'platform',
   'A document approved by the manager of the department it belongs to (§5.2).');--> statement-breakpoint

INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
  ('department_request', 'draft',            'submitted'),
  ('department_request', 'draft',            'approved'),
  ('department_request', 'submitted', 'approved'),
  ('department_request', 'submitted', 'rejected'),
  ('department_request', 'submitted', 'draft'),
  ('department_request', 'rejected',         'draft'),
  ('department_request', 'approved',         'cancelled');--> statement-breakpoint

WITH d AS (
  INSERT INTO workflow_definition (document_type_code, version, is_active)
  VALUES ('department_request', 1, true)
  RETURNING id
)
INSERT INTO workflow_step
  (definition_id, sequence, approver_kind, approver_role, allow_self_approval, escalate_after_hours)
SELECT d.id, 1, 'department_manager', '', true, 48 FROM d;
