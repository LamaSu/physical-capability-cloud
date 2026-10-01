/**
 * Unit tests for the D4(a) readiness helpers (services/onboarding-readiness.ts).
 *
 * Signatures are real Ed25519 (tweetnacl), so "verified" means the kernel's
 * registered key actually signed the bundle hash.
 */

import { describe, it, expect, vi } from "vitest";
import nacl from "tweetnacl";
import { listRegisteredMachineAdapters } from "@pcc/kernel";
import {
  NON_EXECUTING_ADAPTERS,
  assessBundle,
  classifyStoredSignature,
  computeOnboardingReadiness,
  deviceReadiness,
  readinessGaps,
  strongestEvidence,
  type OnboardingReadiness,
  type RunObservation,
} from "../services/onboarding-readiness.js";

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const BUNDLE_HASH = `sha256:${"ab".repeat(32)}`;
const JOB_ID = "job-readiness-1";

function deviceKey() {
  const pair = nacl.sign.keyPair();
  const publicKey = `0x${hex(pair.publicKey)}`;
  return {
    publicKey,
    columns: { signingKeyAlgorithm: "ed25519", signingKeyPublicKey: publicKey, signingAddress: null },
    sign: (bundleHash: string) => ({
      signer: publicKey,
      algorithm: "ed25519",
      value: hex(nacl.sign.detached(new TextEncoder().encode(bundleHash), pair.secretKey)),
    }),
  };
}

const MACHINE_ADAPTERS = listRegisteredMachineAdapters();

describe("deviceReadiness", () => {
  it("accepts a machine whose real adapter the kernel can build", () => {
    for (const adapterType of ["octoprint", "opcua", "ipp", "opentrons", "hamilton"]) {
      expect(deviceReadiness({ type: "machine", adapterType }, MACHINE_ADAPTERS)).toEqual({ executable: true });
    }
  });

  it("never counts the simulator or the generic-http refusal, although the kernel registers both", () => {
    expect(MACHINE_ADAPTERS).toEqual(expect.arrayContaining(["mock", "generic-http"]));
    expect([...NON_EXECUTING_ADAPTERS].sort()).toEqual(["generic-http", "mock"]);
    for (const adapterType of ["mock", "generic-http"]) {
      expect(deviceReadiness({ type: "machine", adapterType }, MACHINE_ADAPTERS)).toEqual({
        executable: false,
        reason: "non_executing_adapter",
      });
    }
  });

  it("rejects an adapter the kernel cannot build as a machine (modbus and sila are sensor adapters)", () => {
    for (const adapterType of ["modbus", "sila", "made-up"]) {
      expect(deviceReadiness({ type: "machine", adapterType }, MACHINE_ADAPTERS)).toEqual({
        executable: false,
        reason: "unknown_adapter",
      });
    }
  });

  it("does not count sensors or cameras, which observe but never execute jobs", () => {
    for (const type of ["sensor", "camera", "robot", null]) {
      expect(deviceReadiness({ type, adapterType: "octoprint" }, MACHINE_ADAPTERS)).toEqual({
        executable: false,
        reason: "not_a_machine",
      });
    }
  });

  it("does not count a machine with no adapter", () => {
    expect(deviceReadiness({ type: "machine", adapterType: null }, MACHINE_ADAPTERS)).toEqual({
      executable: false,
      reason: "no_adapter",
    });
  });
});

describe("classifyStoredSignature", () => {
  it("recognises the setup route's self-attested bundle", () => {
    expect(
      classifyStoredSignature({
        signer: "self-attest",
        algorithm: "none",
        value: "self-attested by kernel k1 at 2026-09-24T00:00:00Z",
      }),
    ).toBe("self-attest");
  });

  it("recognises both gateway placeholders", () => {
    // operator-relay, when no signed bundle came with the evidence
    expect(classifyStoredSignature({ signer: "k1", algorithm: "sha256", value: "operator-relay-auto" })).toBe(
      "gateway-placeholder",
    );
    // paid-job-flow /complete, gate closed: ed25519-tagged but fabricated
    expect(
      classifyStoredSignature({
        signer: "0x0000000000000000000000000000000000000000",
        algorithm: "ed25519",
        value: "gateway-auto-sign",
      }),
    ).toBe("gateway-placeholder");
  });

  it("recognises the kernel emitter's test key", () => {
    expect(
      classifyStoredSignature({
        signer: "0x0000000000000000000000000000000000000000",
        algorithm: "secp256k1",
        value: "0xdeadbeef",
      }),
    ).toBe("test-key");
    expect(classifyStoredSignature({ signer: "0x" + "11".repeat(32), algorithm: "ed25519", value: "test_sig_1" })).toBe(
      "test-key",
    );
  });

  it("marks a real-looking device Ed25519 signature as device-signed (not yet verified)", () => {
    expect(classifyStoredSignature(deviceKey().sign(BUNDLE_HASH))).toBe("device-signed");
  });

  it("calls any other signature unverifiable", () => {
    expect(
      classifyStoredSignature({ signer: "0x" + "12".repeat(20), algorithm: "secp256k1", value: "0x" + "34".repeat(65) }),
    ).toBe("unverifiable");
    expect(classifyStoredSignature({ signer: 1, algorithm: "ed25519", value: {} })).toBe("unverifiable");
  });

  it("reports no evidence for missing or empty signatures", () => {
    for (const missing of [null, undefined, "", 42, {}, { signer: "", algorithm: "", value: "" }]) {
      expect(classifyStoredSignature(missing)).toBe("none");
    }
  });
});

describe("assessBundle", () => {
  it("verifies a bundle signed by the kernel's registered key", async () => {
    const key = deviceKey();
    const bundle = { bundleHash: BUNDLE_HASH, kernelSignature: key.sign(BUNDLE_HASH) };
    expect(await assessBundle(bundle, JOB_ID, key.columns)).toBe("verified");
  });

  it("rejects a bundle signed by another key, even when it names the registered key", async () => {
    const registered = deviceKey();
    const other = deviceKey();
    const forged = { ...other.sign(BUNDLE_HASH), signer: registered.publicKey };
    expect(await assessBundle({ bundleHash: BUNDLE_HASH, kernelSignature: forged }, JOB_ID, registered.columns)).toBe(
      "invalid",
    );
  });

  it("rejects a bundle whose hash changed after signing", async () => {
    const key = deviceKey();
    const bundle = { bundleHash: `sha256:${"cd".repeat(32)}`, kernelSignature: key.sign(BUNDLE_HASH) };
    expect(await assessBundle(bundle, JOB_ID, key.columns)).toBe("invalid");
  });

  it("cannot verify without a proven signing key on the kernel", async () => {
    const key = deviceKey();
    const bundle = { bundleHash: BUNDLE_HASH, kernelSignature: key.sign(BUNDLE_HASH) };
    expect(await assessBundle(bundle, JOB_ID, null)).toBe("unregistered-signer");
    expect(
      await assessBundle(bundle, JOB_ID, { signingKeyAlgorithm: null, signingKeyPublicKey: null, signingAddress: null }),
    ).toBe("unregistered-signer");
  });

  it("calls a device signature unverifiable when the kernel's proven key is secp256k1", async () => {
    const key = deviceKey();
    const bundle = { bundleHash: BUNDLE_HASH, kernelSignature: key.sign(BUNDLE_HASH) };
    const secpKernel = { signingKeyAlgorithm: "secp256k1", signingKeyPublicKey: null, signingAddress: "0x" + "12".repeat(20) };
    expect(await assessBundle(bundle, JOB_ID, secpKernel)).toBe("unverifiable");
  });

  it("fails closed on a malformed session-key delegation", async () => {
    const key = deviceKey();
    const bundle = {
      bundleHash: BUNDLE_HASH,
      kernelSignature: key.sign(BUNDLE_HASH),
      sessionKeyAuthorization: { sessionId: "s1" },
    };
    expect(await assessBundle(bundle, JOB_ID, key.columns)).toBe("invalid");
  });

  it("never runs the verifier on placeholders, self-attested or test-key evidence", async () => {
    const key = deviceKey();
    const verify = vi.fn(() => true);
    const weak = [
      { signer: "self-attest", algorithm: "none", value: "x" },
      { signer: "k1", algorithm: "sha256", value: "operator-relay-auto" },
      { signer: "0x0000000000000000000000000000000000000000", algorithm: "ed25519", value: "gateway-auto-sign" },
      { signer: "0x0000000000000000000000000000000000000000", algorithm: "secp256k1", value: "0x1" },
    ];
    const classes = [];
    for (const kernelSignature of weak) {
      classes.push(await assessBundle({ bundleHash: BUNDLE_HASH, kernelSignature }, JOB_ID, key.columns, verify));
    }
    expect(classes).toEqual(["self-attest", "gateway-placeholder", "gateway-placeholder", "test-key"]);
    expect(verify).not.toHaveBeenCalled();
  });
});

describe("strongestEvidence", () => {
  it("prefers a verified run, then the problems worth fixing, then weaker evidence", () => {
    expect(strongestEvidence(["self-attest", "verified", "invalid"])).toBe("verified");
    expect(strongestEvidence(["test-key", "invalid", "unregistered-signer"])).toBe("invalid");
    expect(strongestEvidence(["self-attest", "gateway-placeholder"])).toBe("gateway-placeholder");
    expect(strongestEvidence([])).toBe("none");
  });
});

describe("computeOnboardingReadiness", () => {
  const base = {
    devices: [{ type: "machine", adapterType: "octoprint" }],
    buildableMachineAdapters: MACHINE_ADAPTERS,
    runs: [] as RunObservation[],
    latestSetupTest: null,
    openOffers: 0,
  };

  it("needs a completed run with verified evidence", () => {
    expect(computeOnboardingReadiness(base).verifiedRun).toBe(false);
    expect(
      computeOnboardingReadiness({ ...base, runs: [{ status: "completed", evidence: "verified" }] }).verifiedRun,
    ).toBe(true);
  });

  it("does not count verified evidence on a run that did not complete", () => {
    const readiness = computeOnboardingReadiness({ ...base, runs: [{ status: "failed", evidence: "verified" }] });
    expect(readiness.verifiedRun).toBe(false);
    expect(readiness.runEvidence).toBe("none");
  });

  it("reports the strongest run evidence and the setup test's evidence separately", () => {
    const readiness = computeOnboardingReadiness({
      ...base,
      runs: [
        { status: "completed", evidence: "self-attest" },
        { status: "completed", evidence: "unregistered-signer" },
      ],
      latestSetupTest: { status: "completed", evidence: "self-attest" },
    });
    expect(readiness.verifiedRun).toBe(false);
    expect(readiness.runEvidence).toBe("unregistered-signer");
    expect(readiness.setupTestEvidence).toBe("self-attest");
  });

  it("counts registered and executable devices", () => {
    const readiness = computeOnboardingReadiness({
      ...base,
      devices: [
        { type: "machine", adapterType: "mock" },
        { type: "machine", adapterType: "generic-http" },
        { type: "sensor", adapterType: "modbus" },
      ],
    });
    expect(readiness.devices).toEqual({ registered: 3, executable: 0 });
    expect(readiness.adapterReady).toBe(false);
    expect(computeOnboardingReadiness(base).adapterReady).toBe(true);
  });

  it("never reports payouts as ready", () => {
    expect(computeOnboardingReadiness(base).payout).toBe("not_supported");
  });

  it("keeps an unknown offer count unknown and never reports a negative or fractional one", () => {
    expect(computeOnboardingReadiness({ ...base, openOffers: null }).openOffers).toBeNull();
    expect(computeOnboardingReadiness({ ...base, openOffers: Number.NaN }).openOffers).toBeNull();
    expect(computeOnboardingReadiness({ ...base, openOffers: -3 }).openOffers).toBe(0);
    expect(computeOnboardingReadiness({ ...base, openOffers: 2.7 }).openOffers).toBe(2);
  });
});

describe("readinessGaps", () => {
  const ready: OnboardingReadiness = {
    devices: { registered: 1, executable: 1 },
    adapterReady: true,
    verifiedRun: true,
    runEvidence: "verified",
    setupTestEvidence: "none",
    payout: "not_supported",
    openOffers: 0,
  };

  it("has no gaps once a device can execute and a verified run exists", () => {
    expect(readinessGaps(ready)).toEqual([]);
  });

  it("flags the device adapter only when every registered device is non-executing", () => {
    const allMock = { ...ready, devices: { registered: 2, executable: 0 }, adapterReady: false };
    expect(readinessGaps(allMock)).toEqual([expect.stringContaining("device adapter — none of the 2 registered devices")]);
    // A node that registers no device rows (pcc-node) is judged by its runs alone.
    const noRows = { ...ready, devices: { registered: 0, executable: 0 }, adapterReady: false };
    expect(readinessGaps(noRows)).toEqual([]);
  });

  it("explains a missing verified run and why a setup test does not count", () => {
    const gaps = readinessGaps({
      ...ready,
      verifiedRun: false,
      runEvidence: "unregistered-signer",
      setupTestEvidence: "self-attest",
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain("verified run —");
    expect(gaps[0]).toContain("no signing key is registered for the kernel");
    expect(gaps[0]).toContain("a setup test job does not count");
  });

  it("does not mention the setup test when none ran", () => {
    const [gap] = readinessGaps({ ...ready, verifiedRun: false, runEvidence: "none" });
    expect(gap).toContain("no completed job has evidence yet");
    expect(gap).not.toContain("setup test");
  });
});
