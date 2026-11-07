import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvidenceBundle } from "@pcc/spec";

const boundary = vi.hoisted(() => ({
  span: vi.fn(), emit: vi.fn(), archive: vi.fn(), submit: vi.fn(), release: vi.fn(),
  persist: vi.fn(), update: vi.fn(), derivative: vi.fn(), link: vi.fn(), royalty: vi.fn(),
}));
vi.mock("../sentry.js", () => ({ Sentry: { startSpan: boundary.span } }));
vi.mock("../telemetry.js", () => ({ pipelineTelemetry: { emit: boundary.emit } }));
vi.mock("../trace-collector.js", () => ({
  traceCollector: { startSpan: vi.fn(), endSpan: vi.fn() },
  TraceCollector: { newTraceId: () => "trace-test", newSpanId: () => "span-test" },
}));
vi.mock("../services/audit-service.js", () => ({ auditService: { log: vi.fn() } }));
vi.mock("../db.js", () => ({ getRepos: () => ({
  evidence: { insert: boundary.persist, insertEvents: vi.fn() },
  jobs: { updateStatus: boundary.update, findById: () => ({ capabilityId: "password=N71-SENTINEL" }) },
  story: {
    findIpByCapabilityId: () => ({ ipId: "parent-ip" }),
    insertDerivativeLink: boundary.link,
    findDerivativeLinksByJob: () => [{ childIpId: "password=N71-SENTINEL" }],
  },
}) }));
vi.mock("@pcc/kernel/evidence-storage-factory", () => ({ createEvidenceStorage: async () => ({
  init: vi.fn(), archiveBundle: boundary.archive,
}) }));
vi.mock("../contracts/escrow-client.js", () => ({
  isWriteEnabled: () => true,
  submitEvidence: boundary.submit,
  releaseMilestone: boundary.release,
}));
vi.mock("@pcc/contracts", () => ({ getStoryIPService: () => ({
  registerJobAsDerivative: boundary.derivative,
  payJobRoyalty: boundary.royalty,
}) }));

import { SettlementService } from "../services/settlement-service.js";

const raw = "password=N71-SENTINEL";
const bundle = (): EvidenceBundle => ({
  id: raw, jobId: raw, kernelId: "kernel-test", stepId: "step-test", assuranceTier: 0,
  bundleHash: "sha256:bundle-test" as never,
  kernelSignature: { signer: "kernel-test", algorithm: "none", value: raw } as never,
  createdAt: "2026-10-16T00:00:00.000Z", events: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  boundary.span.mockImplementation((_options, callback) => callback());
  boundary.archive.mockResolvedValue({ cid: raw });
  boundary.submit.mockResolvedValue({ transactionHash: raw });
  boundary.release.mockResolvedValue({ transactionHash: raw });
  boundary.derivative.mockResolvedValue({
    childIpId: raw, parentIpId: raw, jobId: raw, evidenceBundleHash: raw,
  });
  boundary.persist.mockImplementation(() => undefined);
  boundary.link.mockImplementation(() => undefined);
  boundary.royalty.mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("N71 r9 settlement observation boundaries", () => {
  it("formats identifiers across successful settlement while execution and persistence retain their values", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const input = bundle();
    const attestation = { jobId: raw } as never;
    const result = await new SettlementService().processEvidence(input, raw, {
      contractAddress: raw, autoRelease: true, attestation,
    });
    expect(result).toMatchObject({
      jobId: raw, evidenceBundleId: raw, cid: raw,
      evidenceTxHash: raw, releaseTxHash: raw, settled: true,
    });
    expect(boundary.archive).toHaveBeenCalledWith(input);
    expect(boundary.persist).toHaveBeenCalledWith(expect.objectContaining({ id: raw, jobId: raw }));
    expect(boundary.submit).toHaveBeenCalledWith(0, expect.any(String), raw);
    expect(boundary.release).toHaveBeenCalledWith(0, attestation, raw);
    expect(boundary.span).toHaveBeenCalledTimes(5);
    expect(boundary.emit).toHaveBeenCalledWith("[invalid id]", "evidence_archive", "completed", {
      metadata: { cid: "[invalid id]", bundleId: "[invalid id]" },
    });
    expect(boundary.emit).toHaveBeenCalledWith("[invalid id]", "settlement_complete", "completed", {
      metadata: { released: true, txHash: "[invalid id]", contractAddress: "[invalid id]" },
    });
    const observations = [boundary.span.mock.calls.map(([options]) => options), boundary.emit.mock.calls, log.mock.calls];
    expect(JSON.stringify(observations)).not.toContain(raw);
  });

  it("contains dependency failures in console and telemetry without changing the returned chain error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    boundary.archive.mockRejectedValueOnce(new TypeError(raw));
    boundary.persist.mockImplementationOnce(() => { throw new RangeError(raw); });
    boundary.submit.mockRejectedValueOnce(new Error(raw));
    boundary.derivative.mockRejectedValueOnce(new SyntaxError(raw));
    boundary.royalty.mockRejectedValueOnce(new URIError(raw));
    const result = await new SettlementService().processEvidence(bundle(), raw, {
      contractAddress: raw, autoRelease: true, attestation: {} as never,
    });
    expect(result.error).toBe(raw);
    expect(warn).toHaveBeenCalledTimes(5);
    expect(warn.mock.calls.map((call) => call[1])).toEqual(["TypeError", "RangeError", "Error", "SyntaxError", "URIError"]);
    expect(boundary.emit).toHaveBeenCalledWith("[invalid id]", "evidence_archive", "failed", {
      metadata: { error: "TypeError" },
    });
    expect(boundary.emit).toHaveBeenCalledWith("[invalid id]", "settlement_claim", "failed", {
      metadata: { error: "SyntaxError" },
    });
    expect(JSON.stringify([warn.mock.calls, boundary.emit.mock.calls])).not.toContain(raw);
  });
});
