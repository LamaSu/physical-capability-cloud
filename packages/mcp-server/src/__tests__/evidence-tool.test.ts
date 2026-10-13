/**
 * pcc_get_evidence (bus #3341): a bundle id goes to the bundle route, a job id
 * to the by-job route. Before this, a bundle id was sent to
 * /api/evidence/:jobId and every real bundle answered 404 (reproduced against
 * the gateway's settlement and compliance routes).
 */
import { describe, it, expect } from "vitest";
import { GET_EVIDENCE_DESCRIPTION, evidencePath } from "../tools/evidence.js";

describe("pcc_get_evidence routing", () => {
  it("sends a bundle id to the bundle route, never the by-job route", () => {
    expect(evidencePath({ bundleId: "ev-1234" })).toEqual({ path: "/api/compliance/evidence/ev-1234" });
  });

  it("sends a job id to the by-job route", () => {
    expect(evidencePath({ jobId: "job-42" })).toEqual({ path: "/api/evidence/job-42" });
  });

  it("keeps an id to one path segment", () => {
    expect(evidencePath({ bundleId: "../admin?x=1" })).toEqual({ path: "/api/compliance/evidence/..%2Fadmin%3Fx%3D1" });
  });

  it("asks for exactly one of them", () => {
    expect(evidencePath({})).toHaveProperty("error");
    expect(evidencePath({ bundleId: "  ", jobId: "" })).toHaveProperty("error");
    expect(evidencePath({ bundleId: "ev-1", jobId: "job-1" })).toHaveProperty("error");
  });

  it("describes only what the routes return", () => {
    for (const claim of [/zk/i, /bittensor/i, /attestation/i, /encrypted data/i]) {
      expect(GET_EVIDENCE_DESCRIPTION).not.toMatch(claim);
    }
  });
});
