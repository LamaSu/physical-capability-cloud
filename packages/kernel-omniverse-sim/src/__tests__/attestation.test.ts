import { describe, it, expect } from "vitest";
import nacl from "tweetnacl";
import {
  signAttestation,
  verifyAttestation,
  hashWorkflow,
} from "../attestation.js";
import type { MadsciWorkflow } from "@pcc/adapter-madsci";
import type { SimRunResult } from "../types.js";

function newKeyHex(): string {
  const kp = nacl.sign.keyPair();
  return Array.from(kp.secretKey)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const WORKFLOW: MadsciWorkflow = {
  schema: "madsci/v1",
  name: "test-wf",
  steps: [{ name: "s1", action: { node: "n1", action: "a1" } }],
};
const RESULT: SimRunResult = {
  verdict: "pass",
  durationMs: 200,
  errors: [],
  trace: [{ stepName: "s1", startMs: 0, endMs: 200, status: "ok" }],
};

describe("hashWorkflow", () => {
  it("produces a stable hex digest", () => {
    const h1 = hashWorkflow(WORKFLOW);
    const h2 = hashWorkflow(WORKFLOW);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when steps change", () => {
    const h1 = hashWorkflow(WORKFLOW);
    const h2 = hashWorkflow({
      ...WORKFLOW,
      steps: [{ name: "s2", action: { node: "n1", action: "a1" } }],
    });
    expect(h1).not.toBe(h2);
  });
});

describe("signAttestation / verifyAttestation", () => {
  it("round-trips a valid attestation", () => {
    const att = signAttestation({
      result: RESULT,
      workflow: WORKFLOW,
      runnerVersion: "stub/0.1",
      secretKeyHex: newKeyHex(),
    });
    expect(verifyAttestation(att)).toBe(true);
    expect(att.workflowHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a tampered envelope", () => {
    const att = signAttestation({
      result: RESULT,
      workflow: WORKFLOW,
      runnerVersion: "stub/0.1",
      secretKeyHex: newKeyHex(),
    });
    const tampered = {
      ...att,
      result: { ...att.result, verdict: "fail" as const },
    };
    expect(verifyAttestation(tampered)).toBe(false);
  });

  it("rejects a bad secret-key length", () => {
    expect(() =>
      signAttestation({
        result: RESULT,
        workflow: WORKFLOW,
        runnerVersion: "stub/0.1",
        secretKeyHex: "abcd",
      }),
    ).toThrow(/secretKey must be/);
  });
});
