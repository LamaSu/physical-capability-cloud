import { describe, it, expect } from "vitest";

import { CsdSchema, type CSD } from "../csd/schema.js";
import { computeCsdEligibility } from "../evidence/eligibility.js";
import { EvidencePrimitiveDefSchema, getPrimitive } from "../evidence/primitives.js";
import { compileTierLadder, PRIMITIVE_ALLOWED_BIND_TYPES } from "../evidence/tier-ladder.js";
import { makeStubVerifier } from "../evidence/verifier-interface.js";
import { validatePrimitiveParams } from "../types/opportunity.js";

// An in-test non-printer contract: admission of a built-in CSD is a separate review.
function liquidHandlerCsd(): CSD {
  return {
    url: "pcc://capabilities/test-liquid-handler/v1",
    version: "1.0.0",
    status: "active",
    name: "Test liquid handler",
    description: "Dispense a funded input method on a liquid handler.",
    kind: "base",
    baseDefinition: null,
    adapter: { type: "liquid-handler" },
    parameters: [],
    constraints: [],
    pricing: { basePrice: "1.00", currency: "USD" },
    evidence: {
      tier0: {
        description: "Operator declaration",
        required: [],
        primitives: [{ id: "decl.self_attested" }],
      },
      tier1: {
        description: "Kernel receipt bound to the funded input",
        required: ["method_loaded", "execution_completed"],
        primitives: [
          { id: "receipt.kernel_signed", bind: "execution_completed" },
          { id: "input.hash_bound", bind: "method_loaded" },
        ],
      },
    },
  };
}

describe("input.hash_bound — the non-printer input commitment contract", () => {
  it("compiles the method_loaded binding into the tier ladder", async () => {
    const csd = CsdSchema.parse(liquidHandlerCsd());
    const ladder = await compileTierLadder(csd);

    expect(ladder.tiers[1]!.requiredEventTypes).toEqual([
      ["execution_completed"],
      ["method_loaded"],
    ]);
    expect(ladder.tiers[1]!.primitives).toContainEqual({
      id: "input.hash_bound",
      bind: "method_loaded",
      supporting: false,
      params: null,
    });
  });

  it("refuses a method_loaded binding when the tier does not require that event", async () => {
    const csd = liquidHandlerCsd();
    csd.evidence!.tier1!.required = ["execution_completed"];

    await expect(compileTierLadder(csd)).rejects.toMatchObject({
      code: "bind-not-required",
      detail: 'tier1: primitive "input.hash_bound" binds "method_loaded", which tier1 does not require',
    });
  });

  it("refuses another required event as the input.hash_bound bind", async () => {
    const csd = liquidHandlerCsd();
    csd.evidence!.tier1!.primitives![1]!.bind = "execution_completed";

    await expect(compileTierLadder(csd)).rejects.toMatchObject({
      code: "primitive-bind-not-allowed",
      detail: 'tier1: primitive "input.hash_bound" must bind "method_loaded", got "execution_completed"',
    });
  });

  it("requires the method_loaded bind, including on declarations without a bind", async () => {
    const csd = liquidHandlerCsd();
    delete csd.evidence!.tier1!.primitives![1]!.bind;

    await expect(compileTierLadder(csd)).rejects.toMatchObject({
      code: "primitive-bind-not-allowed",
      detail: 'tier1: primitive "input.hash_bound" must bind "method_loaded", got no bind',
    });
  });

  it("keeps the primitive bind admission rule immutable and outside its descriptor", () => {
    expect(PRIMITIVE_ALLOWED_BIND_TYPES["input.hash_bound"]).toEqual(["method_loaded"]);
    expect(Object.isFrozen(PRIMITIVE_ALLOWED_BIND_TYPES)).toBe(true);
    expect(Object.isFrozen(PRIMITIVE_ALLOWED_BIND_TYPES["input.hash_bound"])).toBe(true);
    expect(getPrimitive("input.hash_bound")).not.toHaveProperty("allowedBindTypes");
  });

  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])(
    "compiles prototype property id %s exactly like an unknown primitive id",
    async (id) => {
      const csd = liquidHandlerCsd();
      csd.evidence!.tier1!.primitives = [{ id: "unregistered.input", bind: "method_loaded" }];
      const unknown = await compileTierLadder(csd);

      csd.evidence!.tier1!.primitives![0]!.id = id;
      const compiled = await compileTierLadder(csd);

      // The id remains caller-supplied; every other compiled tier field has
      // the same semantics as an unknown id. Inherited table keys must never
      // become bind rules or throw a raw TypeError during compilation.
      expect(compiled.tiers).toEqual(unknown.tiers.map((tier) => ({
        ...tier,
        primitives: tier.primitives.map((primitive) => primitive.id === "unregistered.input"
          ? { ...primitive, id }
          : primitive),
      })));
    },
  );

  it("refuses non-empty input.hash_bound params under its closed-empty schema", async () => {
    const csd = liquidHandlerCsd();
    csd.evidence!.tier1!.primitives![1]!.params = { field: "otherField" };

    // CSD parsing checks the record shape; compilation enforces closed-empty
    // schemas without imposing full params validation on other primitives.
    const parsed = CsdSchema.safeParse(csd);
    expect(parsed.success).toBe(true);
    await expect(compileTierLadder(CsdSchema.parse(csd))).rejects.toMatchObject({
      code: "primitive-params-not-allowed",
      detail: 'tier1: primitive "input.hash_bound" has a closed-empty paramsSchema and refuses non-empty params',
    });
    expect(validatePrimitiveParams(getPrimitive("input.hash_bound")!.paramsSchema, { field: "otherField" })).toBe(false);
  });

  it("registers a closed, inherited, fail-closed modifier that requires a kernel receipt", async () => {
    const def = getPrimitive("input.hash_bound")!;

    expect(EvidencePrimitiveDefSchema.safeParse(def).success).toBe(true);
    expect(def).toMatchObject({
      id: "input.hash_bound",
      wire: "pcc.ev.input.hash_bound.v1",
      family: "confirm",
      status: "active",
      authRequirement: "inherited",
      objectivityBand: "B1",
      verifierStatus: "stub",
      dependsOn: ["receipt.kernel_signed"],
    });
    expect(def.paramsSchema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(def.tierSupport).toEqual([
      { tier: 1, conditions: "modifier: binds the run to the funded input; grants no tier alone" },
      { tier: 2, conditions: "modifier" },
      { tier: 3, conditions: "modifier" },
    ]);
    expect(def).not.toHaveProperty("gates");
    expect(def).not.toHaveProperty("upgrades");

    const result = await makeStubVerifier("input.hash_bound").verify({}, {}, { vocabVersion: 2 });
    expect(result.met).toBe(false);
    expect(result.detail.join(" ")).toContain('primitive "input.hash_bound" verifier not implemented');
  });

  it("reports the stub advisory and missing receipt dependency, and refuses the stub under oracle enforcement", () => {
    const csd = liquidHandlerCsd();
    const missingRegisteredKey = 'tier1: primitive "receipt.kernel_signed" depends on "ident.registered_key" absent from tier ≤ 1';
    const reportOnly = computeCsdEligibility(csd);

    // The exact two-primitive fixture lacks receipt.kernel_signed's own dependency.
    expect(reportOnly.verdict).toBe("CAPPED");
    expect(reportOnly.eligibleTier).toBe(0);
    expect(reportOnly.perTier.find((tier) => tier.tier === 1)).toEqual({
      tier: 1,
      eligible: false,
      reasons: [missingRegisteredKey],
      stubVerifierPrimitives: ["input.hash_bound"],
    });

    const enforcing = computeCsdEligibility(csd, { requireImplementedVerifier: true });
    expect(enforcing.verdict).toBe("CAPPED");
    expect(enforcing.eligibleTier).toBe(0);
    expect(enforcing.perTier.find((tier) => tier.tier === 1)).toEqual({
      tier: 1,
      eligible: false,
      reasons: [
        missingRegisteredKey,
        'tier1: primitive "input.hash_bound" verifier not implemented (stub)',
      ],
      stubVerifierPrimitives: ["input.hash_bound"],
    });
  });
});
