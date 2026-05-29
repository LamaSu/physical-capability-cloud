/**
 * Settlement Client — routes escrow operations through the batch settlement
 * gateway instead of direct on-chain calls.
 *
 * Agents use this instead of wallet.callContract() for escrow operations.
 * The gateway batches these into UserOperations via ERC-4337, dramatically
 * increasing throughput (50+ settlements per block vs 1 per tx).
 *
 * Usage:
 *   const client = new SettlementClient({ gatewayUrl: "http://localhost:3200" });
 *   await client.submitEvidence(escrowAddress, 0, evidenceHash, { agentId: "kernel-1" });
 *
 * Fallback: if the gateway is unreachable or batch settlement is disabled,
 * operations can fall back to direct wallet.callContract() via the optional
 * wallet parameter.
 */

import type { AgentWallet } from "./wallet.js";
import { attestationToTuple, type OracleAttestation } from "@pcc/contracts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SettlementClientConfig {
  /** Gateway base URL (e.g., "http://localhost:3200") */
  gatewayUrl: string;
  /** Agent ID for tracking which agent queued the operation */
  agentId: string;
  /** Optional wallet for direct fallback when gateway is unavailable */
  wallet?: AgentWallet;
  /** Escrow ABI for direct fallback calls (only needed if wallet is set) */
  escrowAbi?: readonly unknown[];
  /** Request timeout in ms (default: 10_000) */
  timeoutMs?: number;
}

export interface SettlementResult {
  /** How the operation was routed */
  mode: "batched" | "direct";
  /** Operation ID from the batch queue (batched mode) */
  operationId?: string;
  /** Transaction hash (direct mode) */
  transactionHash?: string;
  /** Intent ID for tracking */
  intentId: string;
  /** Current queue depth after submission */
  queuePending?: number;
}

type Address = `0x${string}`;
type Hex = `0x${string}`;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class SettlementClient {
  private config: Required<Pick<SettlementClientConfig, "gatewayUrl" | "agentId" | "timeoutMs">> &
    Pick<SettlementClientConfig, "wallet" | "escrowAbi">;
  private intentCounter = 0;

  constructor(config: SettlementClientConfig) {
    this.config = {
      gatewayUrl: config.gatewayUrl.replace(/\/$/, ""), // strip trailing slash
      agentId: config.agentId,
      wallet: config.wallet,
      escrowAbi: config.escrowAbi,
      timeoutMs: config.timeoutMs ?? 10_000,
    };
  }

  // ── Escrow operations ───────────────────────────────────────────────

  /** Fund an escrow contract */
  async fund(escrowAddress: Address): Promise<SettlementResult> {
    return this.submit(escrowAddress, { type: "fund" });
  }

  /** Submit evidence bundle hash for a milestone */
  async submitEvidence(
    escrowAddress: Address,
    milestoneIndex: number,
    evidenceHash: Hex,
    usdcValue?: bigint,
  ): Promise<SettlementResult> {
    return this.submit(
      escrowAddress,
      { type: "submitEvidence", milestoneIndex, evidenceHash },
      usdcValue,
    );
  }

  /**
   * Submit an oracle-signed attestation for a milestone.
   *
   * The attestation must come from the verifier oracle (UMA / Chainlink /
   * EigenLayer adapter) and be bound to this escrow's address. The gateway
   * (or direct fallback) passes the full struct through to
   * MilestoneEscrow.submitAttestation(uint256, Attestation), which
   * re-verifies it on-chain against the protocol oracle verifier before
   * opening the challenge window.
   */
  async submitAttestation(
    escrowAddress: Address,
    milestoneIndex: number,
    attestation: OracleAttestation,
  ): Promise<SettlementResult> {
    return this.submit(escrowAddress, {
      type: "submitAttestation",
      milestoneIndex,
      attestation,
    });
  }

  /** Deposit operator bond for a milestone */
  async depositBond(
    escrowAddress: Address,
    milestoneIndex: number,
  ): Promise<SettlementResult> {
    return this.submit(escrowAddress, { type: "depositBond", milestoneIndex });
  }

  /**
   * Release funds for a milestone (challenge window must have expired).
   *
   * Requires the SAME oracle-signed Attestation struct that was submitted
   * via submitAttestation. The escrow contract rebinds release to the
   * exact hash keccak256(abi.encode(attestation)).
   */
  async release(
    escrowAddress: Address,
    milestoneIndex: number,
    attestation: OracleAttestation,
    usdcValue?: bigint,
  ): Promise<SettlementResult> {
    return this.submit(
      escrowAddress,
      { type: "release", milestoneIndex, attestation },
      usdcValue,
    );
  }

  /** File a dispute against a milestone */
  async fileDispute(
    escrowAddress: Address,
    milestoneIndex: number,
    bond: bigint,
    evidenceHash: Hex,
    reason: string,
  ): Promise<SettlementResult> {
    return this.submit(escrowAddress, {
      type: "fileDispute",
      milestoneIndex,
      bond: bond.toString(),
      evidenceHash,
      reason,
    });
  }

  // ── Batch control ───────────────────────────────────────────────────

  /** Manually flush the settlement queue (trigger epoch settlement) */
  async flush(): Promise<{
    epoch: number;
    totalIntents: number;
    batches: number;
  }> {
    const response = await this.gatewayFetch("/api/settlement/flush", {
      method: "POST",
    });

    if (!response.ok) {
      throw new Error(`Flush failed: ${response.status} ${await response.text()}`);
    }

    return response.json();
  }

  /** Get the current queue status */
  async getStatus(): Promise<{
    batchEnabled: boolean;
    pending: number;
    totalValue: string;
    smartAccountAddress: string | null;
  }> {
    try {
      const response = await this.gatewayFetch("/api/settlement/status");

      if (!response.ok) {
        return {
          batchEnabled: false,
          pending: 0,
          totalValue: "0",
          smartAccountAddress: null,
        };
      }

      return response.json();
    } catch {
      return {
        batchEnabled: false,
        pending: 0,
        totalValue: "0",
        smartAccountAddress: null,
      };
    }
  }

  // ── Core submission logic ───────────────────────────────────────────

  private async submit(
    escrowAddress: Address,
    operation: Record<string, unknown>,
    usdcValue?: bigint,
  ): Promise<SettlementResult> {
    const intentId = `${this.config.agentId}-${++this.intentCounter}-${Date.now().toString(36)}`;

    // Try batch settlement via gateway first
    try {
      const result = await this.submitViaBatch(intentId, escrowAddress, operation, usdcValue);
      return result;
    } catch (err) {
      // If we have a wallet fallback, use direct on-chain calls
      if (this.config.wallet && this.config.escrowAbi) {
        console.warn(
          `[settlement-client] Batch submission failed, falling back to direct: ${
            err instanceof Error ? err.message : err
          }`,
        );
        return this.submitDirect(intentId, escrowAddress, operation);
      }
      throw err;
    }
  }

  private async submitViaBatch(
    intentId: string,
    escrowAddress: Address,
    operation: Record<string, unknown>,
    usdcValue?: bigint,
  ): Promise<SettlementResult> {
    const body = {
      intentId,
      agentId: this.config.agentId,
      escrowAddress,
      operation,
      usdcValue: usdcValue?.toString(),
    };

    const response = await this.gatewayFetch("/api/settlement/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // The attestation struct has a bigint timestamp — encode via a
      // replacer that emits bigints as decimal strings. The gateway is
      // expected to coerce them back to uint256 when calling viem.
      body: JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Settlement submit failed (${response.status}): ${text}`);
    }

    const result = await response.json();
    return {
      mode: "batched",
      operationId: result.operationId,
      intentId,
      queuePending: result.queueStatus?.pending,
    };
  }

  private async submitDirect(
    intentId: string,
    escrowAddress: Address,
    operation: Record<string, unknown>,
  ): Promise<SettlementResult> {
    const wallet = this.config.wallet!;
    const abi = this.config.escrowAbi!;

    const { functionName, args } = this.encodeOperation(operation);
    const txHash = await wallet.callContract(escrowAddress, abi, functionName, args);

    return {
      mode: "direct",
      transactionHash: txHash,
      intentId,
    };
  }

  private encodeOperation(op: Record<string, unknown>): {
    functionName: string;
    args: readonly unknown[];
  } {
    switch (op.type) {
      case "fund":
        return { functionName: "fund", args: [] };
      case "submitEvidence":
        return {
          functionName: "submitEvidence",
          args: [BigInt(op.milestoneIndex as number), op.evidenceHash],
        };
      case "submitAttestation":
        return {
          functionName: "submitAttestation",
          args: [
            BigInt(op.milestoneIndex as number),
            attestationToTuple(op.attestation as OracleAttestation),
          ],
        };
      case "depositBond":
        return {
          functionName: "depositBond",
          args: [BigInt(op.milestoneIndex as number)],
        };
      case "release":
        return {
          functionName: "release",
          args: [
            BigInt(op.milestoneIndex as number),
            attestationToTuple(op.attestation as OracleAttestation),
          ],
        };
      case "fileDispute":
        return {
          functionName: "fileDispute",
          args: [
            BigInt(op.milestoneIndex as number),
            BigInt(op.bond as string),
            op.evidenceHash,
            op.reason,
          ],
        };
      default:
        throw new Error(`Unknown operation type: ${op.type}`);
    }
  }

  private async gatewayFetch(
    path: string,
    init?: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      return await fetch(`${this.config.gatewayUrl}${path}`, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
