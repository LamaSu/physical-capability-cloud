import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeStore, getRepos, initStore } from "../db.js";
import { ComplianceFacade } from "../facades/compliance.facade.js";

vi.mock("../telemetry.js", () => ({ pipelineTelemetry: { emit: vi.fn() } }));

const signer = "0x1111111111111111111111111111111111111111";
const signed = { signer, algorithm: "secp256k1", value: "sig_alcoa" };
let counter = 0;

function seedAlcoaBundle(kernelId: string, suffix: string, kernelSignature?: unknown) {
  const repos = getRepos();
  const now = new Date().toISOString();
  const bundleId = `bun-alcoa-${suffix}`;
  repos.evidence.insert({
    id: bundleId, jobId: `job-alcoa-${suffix}`, stepId: "step-1", kernelId,
    assuranceTier: 2, bundleHash: "b".repeat(64), kernelSignature, createdAt: now,
  } as never);
  const source = { deviceId: "dev-alcoa", deviceType: "controller", kernelId };
  const types = ["gcode_hash_verified", "execution_completed", "power_profile_summary", "cv_inspection_result"];
  repos.evidence.insertEvents(types.map((type, i) => ({
    id: `${bundleId}-ev-${i}`, bundleId, type, timestamp: now, source, payload: {}, hash: "c".repeat(64),
  })) as never);
}
function insertCap(id: string, kernelId: string) {
  getRepos().capabilities.insert({
    id, kernelId, type: "test_type", name: "ALCOA Cap", description: "", location: { lat: 0, lng: 0 },
    pricing: { currency: "USDC", baseCost: "0", minimum: "0" }, materials: [], assuranceTiers: [2], availability: {},
  });
}

describe("N292: a placeholder signature never counts as the original", () => {
  let facade: ComplianceFacade;
  let kernelId: string;
  let capId: string;
  beforeEach(() => {
    vi.stubEnv("PCC_DB_PATH", ":memory:");
    vi.stubEnv("DATABASE_URL", ":memory:");
    initStore({ seed: true });
    facade = new ComplianceFacade();
    kernelId = `kernel-original-${++counter}`;
    capId = `cap-original-${counter}`;
    insertCap(capId, kernelId);
  });
  afterEach(() => {
    closeStore();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });
  async function status() {
    const result = await facade.generateComplianceReport(capId);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error.message);
    return result.data.alcoaStatus;
  }
  it("P1", async () => {
    seedAlcoaBundle(kernelId, `${counter}`, { signer: kernelId, algorithm: "sha256", value: "operator-relay-auto" });
    const alcoa = await status();
    expect(alcoa.original).toBe(false);
    expect(alcoa.attributable).toBe(true);
  });
  it("P2", async () => {
    seedAlcoaBundle(kernelId, `${counter}`, { signer, algorithm: "ed25519", value: "gateway-auto-sign" });
    expect((await status()).original).toBe(false);
  });
  it("P3", async () => {
    seedAlcoaBundle(kernelId, `${counter}`, signed);
    expect((await status()).original).toBe(true);
  });
  it("P4", async () => {
    seedAlcoaBundle(kernelId, `${counter}`, { ...signed, signer: "0x0000000000000000000000000000000000000000" });
    expect((await status()).original).toBe(false);
  });
  it("P5", async () => {
    seedAlcoaBundle(kernelId, `${counter}-a`, signed);
    seedAlcoaBundle(kernelId, `${counter}-b`, { signer: kernelId, algorithm: "sha256", value: "operator-relay-auto" });
    expect((await status()).original).toBe(false);
  });
  it("P6", async () => {
    seedAlcoaBundle(kernelId, `${counter}`, signed);
    // The store requires this column; exercise an absent signature on the read.
    const evidence = getRepos().evidence;
    const bundles = evidence.findByKernel(kernelId);
    vi.spyOn(evidence, "findByKernel").mockReturnValue(bundles.map((bundle) => ({ ...bundle, kernelSignature: undefined })) as never);
    expect((await status()).original).toBe(false);
  });
  it("P7", async () => {
    seedAlcoaBundle(kernelId, `${counter}`, { signer, algorithm: "secp256k1" });
    expect((await status()).original).toBe(true);
  });
});
