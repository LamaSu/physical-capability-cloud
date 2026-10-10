/**
 * Every machine adapter the kernel can build has a default evidence-emitter
 * manifest in @pcc/spec. Without one, auto-onboarding writes free-text tier-0
 * evidence for the device and the provenance planner sees it supply nothing,
 * which is how the liquid handlers were capped at tier 0.
 */

import { describe, it, expect } from "vitest";
import { ADAPTER_DEFAULT_MANIFESTS } from "@pcc/spec";
import { listRegisteredMachineAdapters } from "../adapter-factory.js";

describe("adapter default manifests cover the kernel's machine adapters", () => {
  it("has a default manifest for every registered machine adapter", () => {
    const registered = listRegisteredMachineAdapters();
    expect(registered.length).toBeGreaterThan(0);
    const missing = registered.filter((type) => !(type in ADAPTER_DEFAULT_MANIFESTS));
    expect(missing).toEqual([]);
  });

  it("includes the liquid handlers", () => {
    for (const type of ["opentrons", "hamilton"]) {
      expect(listRegisteredMachineAdapters()).toContain(type);
      expect(ADAPTER_DEFAULT_MANIFESTS[type]?.subject).toEqual({ kind: "adapter", ref: type });
    }
  });
});
