import { describe, it, expect } from "vitest";
import { ContractBuilder } from "../builder.js";
import { ContractValidator } from "../validator.js";
import { accountingReconcileWorkflowSteps } from "../templates/digital/accounting-reconcile.js";
import { getTemplate } from "../templates/index.js";
import type { DigitalWorkflowStep } from "@pcc/spec";

const builder = new ContractBuilder();
const validator = new ContractValidator();

describe("DigitalWorkflowStep types on BuilderContract", () => {
  it("accepts a BuilderContract with workflowSteps populated", () => {
    const contract = builder.buildContract(
      "accounting-reconcile",
      {
        ledgerSource: "https://erp.example.com/api/gl",
        statementSource: "https://bank.example.com/statements",
        matchingStrategy: "strict",
        periodStart: "2026-01-01",
        periodEnd: "2026-01-31",
      },
      1,
      undefined,
      {
        workflowSteps: accountingReconcileWorkflowSteps,
        digitalTaskType: "accounting-reconcile",
      },
    );

    expect(contract.workflowSteps).toBeDefined();
    expect(contract.workflowSteps!.length).toBe(5);
    expect(contract.digitalTaskType).toBe("accounting-reconcile");
  });

  it("accepts a BuilderContract without workflowSteps (backward compat)", () => {
    const contract = builder.buildContract("fdm", {
      material: "pla",
      infill: 20,
      layerHeight: "0.20",
      quantity: 1,
    });

    expect(contract.workflowSteps).toBeUndefined();
    expect(contract.digitalTaskType).toBeUndefined();
    expect(contract.challenge).toBeUndefined();
    expect(contract.isValid).toBe(true);
  });
});

describe("accounting-reconcile template", () => {
  it("is registered in the template registry", () => {
    const template = getTemplate("accounting-reconcile");
    expect(template).toBeDefined();
    expect(template!.capabilityType).toBe("accounting-reconcile");
    expect(template!.name).toBe("Accounting Reconciliation");
  });

  it("builds a valid contract with correct selections", () => {
    const contract = builder.buildContract(
      "accounting-reconcile",
      {
        ledgerSource: "https://erp.example.com/api/gl",
        statementSource: "https://bank.example.com/statements",
        matchingStrategy: "strict",
        periodStart: "2026-01-01",
        periodEnd: "2026-01-31",
      },
      1,
    );

    expect(contract.isValid).toBe(true);
    expect(contract.validationErrors.length).toBe(0);
    expect(contract.cwmStep.capability).toBe("accounting-reconcile");
    expect(contract.templateName).toBe("Accounting Reconciliation");
    expect(parseFloat(contract.totalPrice)).toBeGreaterThan(0);
  });

  it("fails validation when required selections are missing", () => {
    const contract = builder.buildContract("accounting-reconcile", {}, 1);

    expect(contract.isValid).toBe(false);
    expect(contract.validationErrors.length).toBeGreaterThan(0);
    const missingLedger = contract.validationErrors.find(
      (e) => e.paramKey === "ledgerSource",
    );
    expect(missingLedger).toBeDefined();
  });

  it("has pricing that increases with fuzzy matching strategy", () => {
    const strictPrice = builder.calculatePrice("accounting-reconcile", {
      matchingStrategy: "strict",
    });
    const fuzzyPrice = builder.calculatePrice("accounting-reconcile", {
      matchingStrategy: "fuzzy",
    });

    expect(fuzzyPrice.totalPrice).toBeGreaterThan(strictPrice.totalPrice);
  });

  it("template has correct parameter groups", () => {
    const template = getTemplate("accounting-reconcile")!;
    const groups = new Set(template.params.map((p) => p.group));
    expect(groups.has("Source")).toBe(true);
    expect(groups.has("Matching")).toBe(true);
    expect(groups.has("Period")).toBe(true);
  });
});

describe("accountingReconcileWorkflowSteps", () => {
  it("has 5 steps in the correct order", () => {
    expect(accountingReconcileWorkflowSteps.length).toBe(5);
    const stepIds = accountingReconcileWorkflowSteps.map((s) => s.stepId);
    expect(stepIds).toEqual([
      "fetch_ledger",
      "parse_entries",
      "match_invoices",
      "compute_adjustments",
      "emit_report",
    ]);
  });

  it("has correct dependency DAG structure", () => {
    const steps = accountingReconcileWorkflowSteps;

    // fetch_ledger and parse_entries have no dependencies (roots)
    expect(steps[0].dependsOn).toEqual([]);
    expect(steps[1].dependsOn).toEqual([]);

    // match_invoices depends on both root steps
    expect(steps[2].dependsOn).toEqual(["fetch_ledger", "parse_entries"]);

    // compute_adjustments depends on match_invoices
    expect(steps[3].dependsOn).toEqual(["match_invoices"]);

    // emit_report depends on compute_adjustments
    expect(steps[4].dependsOn).toEqual(["compute_adjustments"]);
  });

  it("all steps have valid stepType values", () => {
    for (const step of accountingReconcileWorkflowSteps) {
      expect(step.stepType).toBeTruthy();
      expect(typeof step.stepType).toBe("string");
    }
  });

  it("all steps have inputSchema and outputSchema", () => {
    for (const step of accountingReconcileWorkflowSteps) {
      expect(step.inputSchema).toBeDefined();
      expect(step.outputSchema).toBeDefined();
      expect(typeof step.inputSchema).toBe("object");
      expect(typeof step.outputSchema).toBe("object");
    }
  });
});

describe("ContractValidator.validateWorkflowSteps", () => {
  it("validates well-formed workflow steps without errors", () => {
    const errors = validator.validateWorkflowSteps(accountingReconcileWorkflowSteps);
    expect(errors.length).toBe(0);
  });

  it("detects duplicate stepIds", () => {
    const steps: DigitalWorkflowStep[] = [
      {
        stepId: "step_a",
        stepType: "transform",
        description: "Step A",
        dependsOn: [],
      },
      {
        stepId: "step_a",
        stepType: "transform",
        description: "Duplicate Step A",
        dependsOn: [],
      },
    ];

    const errors = validator.validateWorkflowSteps(steps);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.message.includes("Duplicate stepId"))).toBe(true);
  });

  it("detects invalid dependsOn references", () => {
    const steps: DigitalWorkflowStep[] = [
      {
        stepId: "step_a",
        stepType: "transform",
        description: "Step A",
        dependsOn: ["nonexistent_step"],
      },
    ];

    const errors = validator.validateWorkflowSteps(steps);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.message.includes("unknown stepId"))).toBe(true);
  });

  it("detects circular dependencies", () => {
    const steps: DigitalWorkflowStep[] = [
      {
        stepId: "step_a",
        stepType: "transform",
        description: "Step A",
        dependsOn: ["step_c"],
      },
      {
        stepId: "step_b",
        stepType: "transform",
        description: "Step B",
        dependsOn: ["step_a"],
      },
      {
        stepId: "step_c",
        stepType: "transform",
        description: "Step C",
        dependsOn: ["step_b"],
      },
    ];

    const errors = validator.validateWorkflowSteps(steps);
    expect(errors.some((e) => e.message.includes("Circular dependency"))).toBe(true);
  });

  it("returns no errors for empty step array", () => {
    const errors = validator.validateWorkflowSteps([]);
    expect(errors.length).toBe(0);
  });

  it("validates workflow steps within buildContract", () => {
    const circularSteps: DigitalWorkflowStep[] = [
      {
        stepId: "alpha",
        stepType: "transform",
        description: "Alpha",
        dependsOn: ["beta"],
      },
      {
        stepId: "beta",
        stepType: "validate",
        description: "Beta",
        dependsOn: ["alpha"],
      },
    ];

    const contract = builder.buildContract(
      "accounting-reconcile",
      {
        ledgerSource: "https://erp.example.com/api/gl",
        statementSource: "https://bank.example.com/statements",
        matchingStrategy: "strict",
        periodStart: "2026-01-01",
        periodEnd: "2026-01-31",
      },
      1,
      undefined,
      { workflowSteps: circularSteps },
    );

    expect(contract.isValid).toBe(false);
    expect(
      contract.validationErrors.some((e) =>
        e.message.includes("Circular dependency"),
      ),
    ).toBe(true);
  });
});

describe("backward compatibility", () => {
  it("existing FDM contract still builds correctly", () => {
    const contract = builder.buildContract("fdm", {
      material: "pla",
      infill: 20,
      layerHeight: "0.20",
      quantity: 1,
    });

    expect(contract.isValid).toBe(true);
    expect(contract.cwmStep.capability).toBe("fdm");
    expect(contract.templateName).toBe("FDM 3D Printing");
    expect(contract.workflowSteps).toBeUndefined();
  });

  it("existing CNC contract still builds correctly", () => {
    const contract = builder.buildContract("cnc-3axis", {
      material: "aluminum-6061",
      tolerance: "standard",
      quantity: 1,
    });

    expect(contract.isValid).toBe(true);
    expect(contract.cwmStep.capability).toBe("cnc-3axis");
    expect(contract.workflowSteps).toBeUndefined();
  });

  it("existing SLA contract still builds correctly", () => {
    const contract = builder.buildContract("sla", {
      resin: "standard",
      layerHeight: "0.050",
      quantity: 1,
    });

    expect(contract.isValid).toBe(true);
    expect(contract.cwmStep.capability).toBe("sla");
  });

  it("contract with challenge field builds correctly", () => {
    const contract = builder.buildContract(
      "accounting-reconcile",
      {
        ledgerSource: "https://erp.example.com/api/gl",
        statementSource: "https://bank.example.com/statements",
        matchingStrategy: "strict",
        periodStart: "2026-01-01",
        periodEnd: "2026-01-31",
      },
      1,
      undefined,
      {
        workflowSteps: accountingReconcileWorkflowSteps,
        digitalTaskType: "accounting-reconcile",
        challenge: {
          challengeId: "challenge-001",
          blockHash: "0xabc123",
          blockNumber: BigInt(12345),
          maxAgeSeconds: 900,
        },
      },
    );

    expect(contract.isValid).toBe(true);
    expect(contract.challenge).toBeDefined();
    expect(contract.challenge!.challengeId).toBe("challenge-001");
    expect(contract.challenge!.blockNumber).toBe(BigInt(12345));
  });
});
