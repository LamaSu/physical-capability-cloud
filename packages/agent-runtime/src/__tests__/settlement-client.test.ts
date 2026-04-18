import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SettlementClient } from "../settlement-client.js";
import type { OracleAttestation } from "@pcc/contracts";

type Address = `0x${string}`;
type Hex = `0x${string}`;

const ESCROW = "0x1111111111111111111111111111111111111111" as Address;
const EVIDENCE_HASH = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890" as Hex;

/** Deterministic test attestation bound to an escrow. */
function mkAttestation(escrowAddress: Address = ESCROW): OracleAttestation {
  return {
    version: 1,
    escrowAddress,
    jobId: "job-test",
    evidenceHash: EVIDENCE_HASH,
    tier: 1,
    verified: true,
    timestamp: 1700000000n,
    nonce: ("0x" + "b".repeat(64)) as Hex,
    extraData: "0x" as Hex,
    signature: "0x" as Hex,
  };
}

describe("SettlementClient", () => {
  let client: SettlementClient;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    client = new SettlementClient({
      gatewayUrl: "http://localhost:3200",
      agentId: "test-agent",
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockGateway(responseBody: unknown, status = 200) {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(responseBody),
      text: () => Promise.resolve(JSON.stringify(responseBody)),
    });
  }

  // ── Batch mode tests ──────────────────────────────────────────────

  it("submits fund operation via gateway", async () => {
    mockGateway({ operationId: "op-1", intentId: "i1", queued: true, queueStatus: { pending: 1 } });

    const result = await client.fund(ESCROW);

    expect(result.mode).toBe("batched");
    expect(result.operationId).toBe("op-1");
    expect(result.queuePending).toBe(1);
    expect(result.intentId).toMatch(/^test-agent-/);

    const fetchCall = (globalThis.fetch as any).mock.calls[0];
    expect(fetchCall[0]).toBe("http://localhost:3200/api/settlement/submit");
    const body = JSON.parse(fetchCall[1].body);
    expect(body.operation.type).toBe("fund");
    expect(body.escrowAddress).toBe(ESCROW);
    expect(body.agentId).toBe("test-agent");
  });

  it("submits evidence via gateway", async () => {
    mockGateway({ operationId: "op-2", queued: true, queueStatus: { pending: 2 } });

    const result = await client.submitEvidence(ESCROW, 0, EVIDENCE_HASH, 100_000_000n);

    expect(result.mode).toBe("batched");
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.operation.type).toBe("submitEvidence");
    expect(body.operation.milestoneIndex).toBe(0);
    expect(body.operation.evidenceHash).toBe(EVIDENCE_HASH);
    expect(body.usdcValue).toBe("100000000");
  });

  it("submits attestation via gateway", async () => {
    mockGateway({ operationId: "op-3", queued: true, queueStatus: { pending: 3 } });

    const attestation = mkAttestation();
    const result = await client.submitAttestation(ESCROW, 1, attestation);

    expect(result.mode).toBe("batched");
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.operation.type).toBe("submitAttestation");
    expect(body.operation.milestoneIndex).toBe(1);
    // JSON.stringify converts bigint timestamp via an error; ensure the
    // shape is present (bigint serialization is the gateway's problem).
    expect(body.operation.attestation).toBeDefined();
    expect(body.operation.attestation.escrowAddress).toBe(ESCROW);
    expect(body.operation.attestation.evidenceHash).toBe(EVIDENCE_HASH);
  });

  it("submits depositBond via gateway", async () => {
    mockGateway({ operationId: "op-4", queued: true, queueStatus: { pending: 1 } });

    const result = await client.depositBond(ESCROW, 2);

    expect(result.mode).toBe("batched");
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.operation.type).toBe("depositBond");
    expect(body.operation.milestoneIndex).toBe(2);
  });

  it("submits release via gateway", async () => {
    mockGateway({ operationId: "op-5", queued: true, queueStatus: { pending: 1 } });

    const attestation = mkAttestation();
    const result = await client.release(ESCROW, 0, attestation, 500_000_000n);

    expect(result.mode).toBe("batched");
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.operation.type).toBe("release");
    expect(body.usdcValue).toBe("500000000");
    expect(body.operation.attestation).toBeDefined();
    expect(body.operation.attestation.escrowAddress).toBe(ESCROW);
  });

  it("submits fileDispute via gateway", async () => {
    mockGateway({ operationId: "op-6", queued: true, queueStatus: { pending: 1 } });

    const result = await client.fileDispute(
      ESCROW,
      0,
      50_000_000n,
      EVIDENCE_HASH,
      "Evidence is fraudulent",
    );

    expect(result.mode).toBe("batched");
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.operation.type).toBe("fileDispute");
    expect(body.operation.bond).toBe("50000000");
    expect(body.operation.reason).toBe("Evidence is fraudulent");
  });

  // ── Batch control tests ───────────────────────────────────────────

  it("flushes the settlement queue", async () => {
    mockGateway({ epoch: 1, totalIntents: 5, batches: 1 });

    const result = await client.flush();

    expect(result.epoch).toBe(1);
    expect(result.totalIntents).toBe(5);
    const fetchCall = (globalThis.fetch as any).mock.calls[0];
    expect(fetchCall[0]).toBe("http://localhost:3200/api/settlement/flush");
    expect(fetchCall[1].method).toBe("POST");
  });

  it("gets queue status", async () => {
    mockGateway({
      batchEnabled: true,
      pending: 3,
      totalValue: "300000000",
      smartAccountAddress: "0xabc",
    });

    const status = await client.getStatus();

    expect(status.batchEnabled).toBe(true);
    expect(status.pending).toBe(3);
  });

  it("returns disabled status on gateway error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const status = await client.getStatus();
    expect(status.batchEnabled).toBe(false);
  });

  // ── Fallback tests ────────────────────────────────────────────────

  it("falls back to direct wallet call when gateway fails", async () => {
    const mockWallet = {
      callContract: vi.fn().mockResolvedValue("0xtxhash"),
    } as any;

    const mockAbi = [{ name: "release", type: "function" }] as const;

    const clientWithFallback = new SettlementClient({
      gatewayUrl: "http://localhost:3200",
      agentId: "test-agent",
      wallet: mockWallet,
      escrowAbi: mockAbi,
    });

    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const attestation = mkAttestation();
    const result = await clientWithFallback.release(ESCROW, 0, attestation);

    expect(result.mode).toBe("direct");
    expect(result.transactionHash).toBe("0xtxhash");
    // The direct-call path must pass the 8-field tuple verbatim so viem
    // can encode the full Attestation struct for the MilestoneEscrow ABI.
    expect(mockWallet.callContract).toHaveBeenCalledWith(
      ESCROW,
      mockAbi,
      "release",
      [
        0n,
        [
          attestation.escrowAddress,
          attestation.jobId,
          attestation.evidenceHash,
          attestation.tier,
          attestation.verified,
          attestation.timestamp,
          attestation.nonce,
          attestation.signature,
        ],
      ],
    );
  });

  it("falls back to direct for submitEvidence", async () => {
    const mockWallet = {
      callContract: vi.fn().mockResolvedValue("0xtxhash2"),
    } as any;
    const mockAbi = [] as const;

    const clientWithFallback = new SettlementClient({
      gatewayUrl: "http://localhost:3200",
      agentId: "kernel-1",
      wallet: mockWallet,
      escrowAbi: mockAbi,
    });

    globalThis.fetch = vi.fn().mockRejectedValue(new Error("timeout"));

    const result = await clientWithFallback.submitEvidence(ESCROW, 2, EVIDENCE_HASH);

    expect(result.mode).toBe("direct");
    expect(mockWallet.callContract).toHaveBeenCalledWith(
      ESCROW,
      mockAbi,
      "submitEvidence",
      [2n, EVIDENCE_HASH],
    );
  });

  it("throws when gateway fails and no wallet fallback", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(client.fund(ESCROW)).rejects.toThrow("ECONNREFUSED");
  });

  it("throws on non-200 response with no fallback", async () => {
    mockGateway({ error: "batch_disabled" }, 503);

    await expect(client.fund(ESCROW)).rejects.toThrow("Settlement submit failed (503)");
  });

  // ── Intent ID generation ──────────────────────────────────────────

  it("generates unique intent IDs", async () => {
    mockGateway({ operationId: "op-1", queued: true, queueStatus: { pending: 1 } });

    const r1 = await client.fund(ESCROW);
    const r2 = await client.fund(ESCROW);

    expect(r1.intentId).not.toBe(r2.intentId);
    expect(r1.intentId).toContain("test-agent-");
  });

  // ── URL handling ──────────────────────────────────────────────────

  it("strips trailing slash from gateway URL", async () => {
    const c = new SettlementClient({
      gatewayUrl: "http://localhost:3200/",
      agentId: "test",
    });
    mockGateway({ operationId: "op-1", queued: true, queueStatus: { pending: 1 } });

    await c.fund(ESCROW);

    const fetchCall = (globalThis.fetch as any).mock.calls[0];
    expect(fetchCall[0]).toBe("http://localhost:3200/api/settlement/submit");
  });
});
