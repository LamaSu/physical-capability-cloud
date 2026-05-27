import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectCapabilities, runSim } from "../runner.js";
import type { MadsciWorkflow } from "@pcc/adapter-madsci";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.resolve(
  __dirname,
  "..",
  "..",
  "python",
  "omniverse_sim_runner.py",
);

const WORKFLOW: MadsciWorkflow = {
  schema: "madsci/v1",
  name: "stub-test",
  steps: [
    { name: "s1", action: { node: "n1", action: "a1" } },
    { name: "s2", action: { node: "n2", action: "a2" } },
  ],
};

describe("runner (stub mode)", () => {
  it("detectCapabilities returns a structured probe", async () => {
    const caps = await detectCapabilities({
      helperPath: HELPER,
      env: { OMNIVERSE_AVAILABLE: "0" },
    });
    expect(typeof caps.available).toBe("boolean");
  });

  it("runSim in stub mode returns deterministic pass with one trace per step", async () => {
    const result = await runSim(WORKFLOW, {
      helperPath: HELPER,
      env: { OMNIVERSE_AVAILABLE: "0" },
    });
    expect(result.verdict).toBe("pass");
    expect(result.trace).toHaveLength(2);
    expect(result.trace[0].stepName).toBe("s1");
    expect(result.metrics?.stepsSimulated).toBe(2);
  }, 10000);
});
