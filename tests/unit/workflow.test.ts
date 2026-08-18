/**
 * Phase 01.6 and 01.7 test gates — the status machine and the approval rules.
 */
import { describe, expect, it } from "vitest";
import {
  DOCUMENT_STATUSES,
  DocumentNotDeletableError,
  DocumentNotEditableError,
  InvalidTransitionError,
  TransitionReasonRequiredError,
  allowedTargets,
  assertDeletable,
  assertEditable,
  assertTransition,
  isEditable,
  isFinal,
  type TransitionRule,
} from "@domain/statuses";
import {
  DecisionReasonRequiredError,
  NotAnApproverError,
  SelfApprovalError,
  WorkflowDefinitionError,
  WorkflowStateError,
  advance,
  assertCanApprove,
  assertCanRecall,
  assertDecisionReason,
  finalisesDirectly,
  stepAt,
  validateDefinition,
  type WorkflowDefinition,
  type WorkflowInstance,
} from "@domain/workflow";

// ---------------------------------------------------------------------------
// 01.6 — status machine
// ---------------------------------------------------------------------------
const CHART_OF_ACCOUNT_RULES: TransitionRule[] = [
  { from: "draft", to: "submitted" },
  { from: "draft", to: "cancelled" },
  { from: "submitted", to: "approved" },
  { from: "submitted", to: "rejected" },
  { from: "submitted", to: "draft" },
  { from: "rejected", to: "draft" },
];

describe("§24 · the status vocabulary", () => {
  it("is the eleven statuses the blueprint lists", () => {
    expect(DOCUMENT_STATUSES).toHaveLength(11);
    expect(DOCUMENT_STATUSES).toContain("posted");
    expect(DOCUMENT_STATUSES).toContain("reversed");
  });

  it("treats only draft as editable", () => {
    expect(isEditable("draft")).toBe(true);
    for (const status of DOCUMENT_STATUSES.filter((s) => s !== "draft")) {
      expect(isEditable(status), status).toBe(false);
    }
  });

  it("treats posted, settled, cancelled, reversed and closed as final", () => {
    expect(
      ["posted", "settled", "cancelled", "reversed", "closed"].every(
        isFinal as any,
      ),
    ).toBe(true);
    expect(isFinal("draft")).toBe(false);
    expect(isFinal("submitted")).toBe(false);
  });
});

describe("§24 · transitions are allow-listed per document type", () => {
  it("permits a configured move", () => {
    expect(() =>
      assertTransition(
        "chart_of_account",
        CHART_OF_ACCOUNT_RULES,
        "draft",
        "submitted",
      ),
    ).not.toThrow();
  });

  it("refuses a move that is not on the list", () => {
    // Straight from draft to approved would skip the Accounting Manager.
    expect(() =>
      assertTransition(
        "chart_of_account",
        CHART_OF_ACCOUNT_RULES,
        "draft",
        "approved",
      ),
    ).toThrow(InvalidTransitionError);
  });

  it("tells the user what they can do instead", () => {
    expect(() =>
      assertTransition(
        "chart_of_account",
        CHART_OF_ACCOUNT_RULES,
        "draft",
        "approved",
      ),
    ).toThrow(/it may move to: submitted, cancelled/);
  });

  it("refuses every move out of a status with no configured exit", () => {
    expect(() =>
      assertTransition(
        "chart_of_account",
        CHART_OF_ACCOUNT_RULES,
        "approved",
        "draft",
      ),
    ).toThrow(/'approved' is a final status for this document type/);
  });

  it("refuses everything when nothing is configured — fails closed", () => {
    // A document type whose configuration is incomplete must not be able to
    // wander into a state nobody designed for it.
    expect(() =>
      assertTransition("unconfigured", [], "draft", "submitted"),
    ).toThrow(InvalidTransitionError);
  });

  it("demands a reason for rejection, cancellation and reversal", () => {
    expect(() =>
      assertTransition(
        "chart_of_account",
        CHART_OF_ACCOUNT_RULES,
        "submitted",
        "rejected",
      ),
    ).toThrow(TransitionReasonRequiredError);

    expect(() =>
      assertTransition(
        "chart_of_account",
        CHART_OF_ACCOUNT_RULES,
        "submitted",
        "rejected",
        "  ",
      ),
    ).toThrow(TransitionReasonRequiredError);

    expect(() =>
      assertTransition(
        "chart_of_account",
        CHART_OF_ACCOUNT_RULES,
        "submitted",
        "rejected",
        "Duplicates A000004",
      ),
    ).not.toThrow();
  });

  it("lists the moves available from a status", () => {
    expect(allowedTargets(CHART_OF_ACCOUNT_RULES, "submitted")).toEqual([
      "approved",
      "rejected",
      "draft",
    ]);
  });
});

describe("§3.2 · editing and deleting", () => {
  it("refuses to edit anything that is not a draft", () => {
    expect(() => assertEditable("journal_entry", "posted")).toThrow(
      DocumentNotEditableError,
    );
    expect(() => assertEditable("journal_entry", "posted")).toThrow(
      /approved reversal or return/,
    );
    expect(() => assertEditable("journal_entry", "submitted")).toThrow(
      /Submission freezes/,
    );
    expect(() => assertEditable("journal_entry", "draft")).not.toThrow();
  });

  it("never permits deletion of a saved document", () => {
    expect(() => assertDeletable("journal_entry")).toThrow(
      DocumentNotDeletableError,
    );
    expect(() => assertDeletable("journal_entry")).toThrow(
      /edited while draft, or cancelled/,
    );
  });
});

// ---------------------------------------------------------------------------
// 01.7 — approval workflow
// ---------------------------------------------------------------------------
const oneStep: WorkflowDefinition = {
  documentType: "chart_of_account",
  version: 1,
  steps: [
    {
      sequence: 1,
      approverKind: "role" as const,
      approverRole: "accounting_manager",
      allowSelfApproval: false,
    },
  ],
};

const twoStep: WorkflowDefinition = {
  documentType: "payment",
  version: 3,
  steps: [
    {
      sequence: 1,
      approverKind: "role" as const,
      approverRole: "accounting_manager",
      allowSelfApproval: false,
    },
    {
      sequence: 2,
      approverKind: "role" as const,
      approverRole: "finance_director",
      allowSelfApproval: false,
    },
  ],
};

const instance = (
  overrides: Partial<WorkflowInstance> = {},
): WorkflowInstance => ({
  documentType: "chart_of_account",
  documentId: "acc-1",
  definitionVersion: 1,
  currentStep: 1,
  submittedBy: "officer",
  isComplete: false,
  ...overrides,
});

const actor = (
  userId: string,
  roles: string[],
  isDepartmentManager = false,
) => ({
  userId,
  roles,
  isDepartmentManager,
});

describe("workflow definitions", () => {
  it("accepts a well-formed route", () => {
    expect(() => validateDefinition(oneStep)).not.toThrow();
    expect(() => validateDefinition(twoStep)).not.toThrow();
  });

  it("refuses a route with no steps", () => {
    // Silently finalising because nobody configured an approver is the failure
    // mode this catches.
    expect(() => validateDefinition({ ...oneStep, steps: [] })).toThrow(
      WorkflowDefinitionError,
    );
  });

  it("refuses steps that are not numbered 1..n", () => {
    expect(() =>
      validateDefinition({
        ...twoStep,
        steps: [
          {
            sequence: 1,
            approverKind: "role" as const,
            approverRole: "a",
            allowSelfApproval: false,
          },
          {
            sequence: 3,
            approverKind: "role" as const,
            approverRole: "b",
            allowSelfApproval: false,
          },
        ],
      }),
    ).toThrow(/numbered 1\.\.2 with no gaps/);
  });

  it("refuses a step with no approver role", () => {
    expect(() =>
      validateDefinition({
        ...oneStep,
        steps: [
          {
            sequence: 1,
            approverKind: "role" as const,
            approverRole: "  ",
            allowSelfApproval: false,
          },
        ],
      }),
    ).toThrow(/names no approver role/);
  });

  it("raises a clear error for a step that does not exist", () => {
    expect(() => stepAt(oneStep, 2)).toThrow(WorkflowStateError);
  });
});

describe("Appendix B · no self-approval where prohibited", () => {
  it("refuses the raiser approving their own submission", () => {
    expect(() =>
      assertCanApprove(
        oneStep.steps[0]!,
        actor("officer", ["accounting_manager"]),
        instance(),
      ),
    ).toThrow(SelfApprovalError);
  });

  it("accepts a different holder of the approving role", () => {
    expect(() =>
      assertCanApprove(
        oneStep.steps[0]!,
        actor("manager", ["accounting_manager"]),
        instance(),
      ),
    ).not.toThrow();
  });

  it("permits self-approval only where the step allows it", () => {
    const relaxed = {
      sequence: 1,
      approverKind: "role" as const,
      approverRole: "accounting_manager",
      allowSelfApproval: true,
    };
    expect(() =>
      assertCanApprove(
        relaxed,
        actor("officer", ["accounting_manager"]),
        instance(),
      ),
    ).not.toThrow();
  });

  it("refuses someone who does not hold the approving role", () => {
    expect(() =>
      assertCanApprove(
        oneStep.steps[0]!,
        actor("someone", ["accounting_officer"]),
        instance(),
      ),
    ).toThrow(NotAnApproverError);
    expect(() =>
      assertCanApprove(
        oneStep.steps[0]!,
        actor("someone", ["accounting_officer"]),
        instance(),
      ),
    ).toThrow(/approved by 'accounting_manager'/);
  });

  it("refuses a decision on a route that already finished", () => {
    expect(() =>
      assertCanApprove(
        oneStep.steps[0]!,
        actor("manager", ["accounting_manager"]),
        instance({ isComplete: true, currentStep: null }),
      ),
    ).toThrow(/already completed its approval route/);
  });

  it("refuses a decision on a document that is not awaiting one", () => {
    expect(() =>
      assertCanApprove(
        oneStep.steps[0]!,
        actor("manager", ["accounting_manager"]),
        instance({ currentStep: null }),
      ),
    ).toThrow(/not awaiting approval/);
  });
});

describe("decisions and their reasons", () => {
  it("demands a reason for rejection and delegation", () => {
    expect(() => assertDecisionReason("rejected")).toThrow(
      DecisionReasonRequiredError,
    );
    expect(() => assertDecisionReason("delegated", "   ")).toThrow(
      DecisionReasonRequiredError,
    );
    expect(() =>
      assertDecisionReason("rejected", "Wrong parent group"),
    ).not.toThrow();
  });

  it("does not demand one for approval", () => {
    expect(() => assertDecisionReason("approved")).not.toThrow();
  });
});

describe("advancing the route", () => {
  it("completes a one-step route on the first approval", () => {
    expect(advance(oneStep, instance())).toEqual({
      nextStep: null,
      isComplete: true,
    });
  });

  it("moves a two-step route to its second approver", () => {
    expect(advance(twoStep, instance({ documentType: "payment" }))).toEqual({
      nextStep: 2,
      isComplete: false,
    });
  });

  it("completes a two-step route on the second approval", () => {
    expect(
      advance(twoStep, instance({ documentType: "payment", currentStep: 2 })),
    ).toEqual({
      nextStep: null,
      isComplete: true,
    });
  });

  it("refuses to advance a document that is not awaiting approval", () => {
    expect(() => advance(oneStep, instance({ currentStep: null }))).toThrow(
      WorkflowStateError,
    );
  });
});

describe("recall", () => {
  it("is available to the raiser while the document is still waiting", () => {
    expect(() =>
      assertCanRecall(instance(), actor("officer", [])),
    ).not.toThrow();
  });

  it("is not available to anyone else", () => {
    expect(() => assertCanRecall(instance(), actor("manager", []))).toThrow(
      /Only the person who submitted/,
    );
  });

  it("is not available once a decision has been taken", () => {
    expect(() =>
      assertCanRecall(
        instance({ isComplete: true, currentStep: null }),
        actor("officer", []),
      ),
    ).toThrow(/no longer awaiting approval/);
  });
});

describe("§5.2 · direct finalisation", () => {
  it("applies to the manager of the document’s department", () => {
    expect(finalisesDirectly(actor("manager", [], true))).toBe(true);
  });

  it("does not apply to an ordinary member of that department", () => {
    expect(finalisesDirectly(actor("officer", [], false))).toBe(false);
  });
});
