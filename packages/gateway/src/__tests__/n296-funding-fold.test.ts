import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (relativePath: string) => readFileSync(new URL(relativePath, import.meta.url), "utf8");

describe("N296 funding fold", () => {
  it("S1: the operator listing uses the shared jobFundingOf readmodel", () => {
    const relay = source("../routes/operator-relay.ts");
    expect(relay).not.toContain("function fundingForListedJob");
    expect(relay).not.toContain("NO_RECORD_ALLOWANCE");
    expect(relay).toContain('import { jobFundingOf } from "../readmodels/job-funding.js";');
    expect(relay).toContain("listedJobs.map((job) => ({ ...job, funding: jobFundingOf(");
  });

  it("S2: a failed funding read uses the shared unavailable refusal", () => {
    const route = source("../routes/job-funding.ts");
    expect(route).not.toContain("READ_FAILED");
    expect(route).toContain('if (funding.read === "failed") return refuseJobRead(reply, { ok: false, kind: "unavailable" });');
  });
});
