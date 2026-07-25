import type { FastifyInstance, FastifyReply } from "fastify";
import type { Result } from "@pcc/spec";
import { getAddress, isAddress, type Address } from "viem";
import type { OracleAttestation } from "@pcc/contracts";
import { getSettlementFacade } from "../facades/index.js";
import type { DisputeInput } from "../facades/index.js";
import {
  fundEscrowActivity,
  releaseMilestoneActivity,
  fileDisputeActivity,
  depositBondActivity,
  submitEvidenceActivity,
  FacadeError,
} from "../activities/escrow.js";
import {
  submitEvidenceV2,
  submitAttestationV2,
  releaseMilestoneV2,
  submitAttestationV3,
  releaseMilestoneV3,
  isWriteEnabled as escrowWriteEnabled,
  encodeApproveAndReleaseV3,
} from "../contracts/escrow-client.js";
import { getRepos } from "../db.js";

/**
 * Look up an escrow row by its on-chain contract address. The single DB query
 * shape for this module's "do we know this escrow?" question — used both as the
 * V2/V3 dispatch hint (resolveEscrowVersion) and as the /fund provenance gate.
 *
 * Address casing: rows are written with the checksummed address decoded from
 * the factory event (paid-job-flow.ts), while callers routinely send lowercase.
 * The lookup is retried against the checksummed and lowercased forms so a
 * legitimate escrow is never rejected over casing alone.
 *
 * Throws only when the escrow registry itself is unreadable. Callers decide
 * whether that degrades (version hint) or fails closed (funding gate).
 */
function findEscrowRow(contractAddress: string) {
  const escrows = getRepos().escrows;
  const candidates = new Set<string>([contractAddress]);
  if (isAddress(contractAddress)) candidates.add(getAddress(contractAddress));
  candidates.add(contractAddress.toLowerCase());
  for (const candidate of candidates) {
    const row = escrows.findByContractAddress(candidate);
    if (row) return row;
  }
  return undefined;
}

/**
 * Determine the dispatch target (V2 or V3 write helpers) for an escrow.
 * Returns "v2" by default when the row is missing (pre-migration rows had no
 * version column and default to v2).
 */
function resolveEscrowVersion(contractAddress: string): "v2" | "v3" {
  try {
    const row = findEscrowRow(contractAddress);
    return (row?.version as "v2" | "v3" | null | undefined) === "v3" ? "v3" : "v2";
  } catch {
    return "v2";
  }
}

/**
 * Whether to route the direct escrow chain routes through the EAS-gated
 * MilestoneEscrowV2 path. Mirrors paid-job-flow's flag — default OFF so the V1
 * (attestation-struct) routes are unchanged for existing callers.
 */
function useEasV2(): boolean {
  return process.env.PCC_USE_EAS_V2 === "true";
}

/**
 * Whether the Mode-A (user-attested, payer-approval) settlement HTTP surface
 * is exposed. Separate from PCC_EVIDENCE_V2_ENABLED so the schema/encoders
 * can be exercised + tested independently of the route shipping live.
 *
 * Default: OFF. Per coord task 20c68ba9 + #066 deliberation, the gateway
 * cannot SEND approveAndRelease (it does not hold the payer's key); when this
 * flag is on, the route returns the calldata + target so the payer's wallet
 * can submit it.
 */
function isModeAEnabled(): boolean {
  const v = process.env.VERIFICATION_MODE_A_ENABLED;
  return v === "true" || v === "1" || v === "yes";
}

// ── Result→HTTP helper ────────────────────────────────────────────────────────

function sendActivityError(reply: FastifyReply, error: Error): unknown {
  if (error instanceof FacadeError) {
    return reply.status(error.httpStatus).send({
      error: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    });
  }
  return reply.status(502).send({ error: error.message });
}

function sendResult<T>(reply: FastifyReply, result: Result<T>): unknown {
  if (result.success) return result.data;
  return reply.code(result.error.httpStatus).send({
    error: result.error.code,
    message: result.error.message,
    ...(result.error.details ? { details: result.error.details } : {}),
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────

export async function escrowRoutes(app: FastifyInstance) {
  const facade = getSettlementFacade();

  // ── DB-backed escrow reads ────────────────────────────────────────────

  /**
   * List escrows from DB with milestone counts.
   * Supports optional ?status= filter.
   * Returns { escrows: EscrowSummaryDTO[] }.
   */
  app.get<{ Querystring: { status?: string } }>(
    "/api/escrow",
    async (req, reply) => {
      const result = await facade.listEscrows({ status: req.query.status });
      if (result.success) return { escrows: result.data };
      return sendResult(reply, result);
    },
  );

  /**
   * Get escrow by ID or on-chain address.
   * If escrowId looks like an Ethereum address: reads from chain.
   * Otherwise: reads from DB with milestones and disputes.
   * Returns { escrow, source: "on-chain"|"db" }.
   */
  app.get<{ Params: { escrowId: string } }>("/api/escrow/:escrowId", async (req, reply) => {
    const result = await facade.getEscrow(req.params.escrowId);
    return sendResult(reply, result);
  });

  // ── On-chain reads ────────────────────────────────────────────────────

  /**
   * Get on-chain event log for an escrow contract.
   * Returns { events }.
   */
  app.get<{ Params: { address: string }; Querystring: { fromBlock?: string } }>(
    "/api/escrow/chain/:address/events",
    async (req, reply) => {
      const { address } = req.params;
      if (!isAddress(address)) {
        return reply.status(400).send({ error: "Invalid address" });
      }
      const fromBlock = req.query.fromBlock ? BigInt(req.query.fromBlock) : undefined;
      const result = await facade.getChainEvents(address as Address, fromBlock);
      if (result.success) return { events: result.data };
      return sendResult(reply, result);
    },
  );

  /**
   * Read ERC-20 token balance for an account.
   */
  app.get<{ Params: { tokenAddress: string; account: string } }>(
    "/api/escrow/chain/token/:tokenAddress/balance/:account",
    async (req, reply) => {
      const { tokenAddress, account } = req.params;
      if (!isAddress(tokenAddress) || !isAddress(account)) {
        return reply.status(400).send({ error: "Invalid address" });
      }
      const result = await facade.getTokenBalance(
        tokenAddress as Address,
        account as Address,
      );
      return sendResult(reply, result);
    },
  );

  /**
   * Read ERC-20 token allowance.
   */
  app.get<{ Params: { tokenAddress: string; owner: string; spender: string } }>(
    "/api/escrow/chain/token/:tokenAddress/allowance/:owner/:spender",
    async (req, reply) => {
      const { tokenAddress, owner, spender } = req.params;
      if (!isAddress(tokenAddress) || !isAddress(owner) || !isAddress(spender)) {
        return reply.status(400).send({ error: "Invalid address" });
      }
      const result = await facade.getTokenAllowance(
        tokenAddress as Address,
        owner as Address,
        spender as Address,
      );
      return sendResult(reply, result);
    },
  );

  /**
   * Read dispute state for a specific milestone.
   */
  app.get<{ Params: { address: string; milestoneIndex: string } }>(
    "/api/escrow/chain/:address/dispute/:milestoneIndex",
    async (req, reply) => {
      const { address, milestoneIndex } = req.params;
      if (!isAddress(address)) {
        return reply.status(400).send({ error: "Invalid address" });
      }
      const idx = parseInt(milestoneIndex, 10);
      if (isNaN(idx) || idx < 0) {
        return reply.status(400).send({ error: "Invalid milestone index" });
      }
      const result = await facade.getDispute(address as Address, idx);
      return sendResult(reply, result);
    },
  );

  /**
   * Get full on-chain escrow state with parallel milestone reads.
   */
  app.get<{ Params: { address: string } }>(
    "/api/escrow/chain/:address/state",
    async (req, reply) => {
      const { address } = req.params;
      if (!isAddress(address)) {
        return reply.status(400).send({ error: "Invalid address" });
      }
      const result = await facade.getChainState(address as Address);
      return sendResult(reply, result);
    },
  );

  /**
   * Check whether write operations are available.
   * Returns { writeEnabled, signerAddress, network }.
   */
  app.get("/api/escrow/chain/write-status", async (req, reply) => {
    const result = await facade.getWriteStatus();
    return sendResult(reply, result);
  });

  // ── On-chain writes ───────────────────────────────────────────────────

  /**
   * Fund an escrow contract (payer must have approved token transfer).
   * Returns 503 if PCC_GATEWAY_PRIVATE_KEY is not configured.
   *
   * PROVENANCE GATE (audit C-03 containment, /fund leg).
   *
   * `isAddress()` only proves the param is well-formed hex — it says nothing
   * about WHOSE contract it is. Before this gate the route forwarded any
   * caller-supplied address straight into fundEscrowActivity, so the gateway
   * signer could be pointed at an arbitrary contract and made to execute a
   * chain write there. The address must now resolve to an escrow row this
   * gateway actually created (findEscrowRow — the same lookup the V2/V3
   * version hint uses) before any on-chain action is attempted.
   *
   * Unknown address -> 404 `escrow_not_found`: this is an existence question
   * about the `:address` path resource, and the input itself is well-formed, so
   * a 400 would mis-describe it as malformed. Registry unreadable -> 503
   * `escrow_lookup_unavailable`, failing closed: an unavailable registry must
   * not degrade into "unverified provenance is acceptable" on a money path.
   */
  app.post<{ Params: { address: string } }>(
    "/api/escrow/chain/:address/fund",
    async (req, reply) => {
      const { address } = req.params;
      if (!isAddress(address)) {
        return reply.status(400).send({ error: "Invalid address" });
      }
      let escrowRow: ReturnType<typeof findEscrowRow>;
      try {
        escrowRow = findEscrowRow(address);
      } catch {
        return reply.status(503).send({
          error: "escrow_lookup_unavailable",
          message:
            "The escrow registry is unreadable; refusing to fund an address of unverified provenance.",
        });
      }
      if (!escrowRow) {
        return reply.status(404).send({
          error: "escrow_not_found",
          message:
            "No escrow with this contract address is known to this gateway. " +
            "Funding is limited to protocol-created escrows.",
        });
      }
      const actorId = (req as any).operatorId ?? (req as any).apiKeyId ?? "system";
      const activityResult = await fundEscrowActivity.invoke({
        workflowRunId: `escrow:${address}`,
        activityId: `fund:${address}`,
        input: [address as Address, actorId, req.ip, req.headers["user-agent"]] as const,
        actorId,
        clientKey: req.headers["idempotency-key"] as string | undefined,
        httpMethod: "POST",
        httpPath: `/api/escrow/chain/${address}/fund`,
      });
      if (!activityResult.ok) {
        return sendActivityError(reply, activityResult.error);
      }
      return activityResult.value;
    },
  );

  /**
   * REMOVED from the public API (audit C-03 containment).
   *
   * This route previously made the gateway signer send ERC-20
   * `approve(spender = :address, token, amount)` with the spender, token, and
   * amount taken directly from untrusted request params — no provenance,
   * ownership, or token-allowlist check. That let any caller make the gateway
   * signer approve an arbitrary spender for an arbitrary token/amount (bounded
   * only by MAX_ESCROW_AMOUNT), i.e. drain the signer's ERC-20 balances.
   *
   * Per the P0 remediation (ChatGPT: "remove the arbitrary approval endpoint
   * from the public API"), the endpoint is removed: it now returns 410 Gone
   * unconditionally and accepts NO spender/token/amount params. The legitimate
   * funding allowance is issued internally by the escrow-create path
   * (paid-job-flow.createJobFromSession), which approves ONLY a freshly
   * factory-created escrow for the exact fund amount — never an arbitrary spender.
   *
   * BREAKING (expected + accepted per spec): clients can no longer call approve
   * directly.
   *
   * TODO(audit P0 follow-up, Wave 2): typed funding operation + treasury/relayer
   * signer separation + rotate signer.
   */
  app.post<{ Params: { address: string } }>(
    "/api/escrow/chain/:address/approve",
    async (_req, reply) => {
      return reply.status(410).send({
        error: "endpoint_removed",
        message:
          "Arbitrary token approval has been removed from the public API (audit C-03). " +
          "The gateway no longer approves caller-supplied spenders/tokens. Funding " +
          "allowances are issued internally to protocol-created escrows only.",
      });
    },
  );

  /**
   * Release a milestone (challenge window must have expired).
   * Requires the same oracle-signed attestation struct used in
   * submitAttestation. Returns 503 if write is disabled.
   */
  app.post<{
    Params: { address: string; milestoneIndex: string };
    Body: { attestation: OracleAttestation };
  }>(
    "/api/escrow/chain/:address/release/:milestoneIndex",
    async (req, reply) => {
      const { address, milestoneIndex } = req.params;
      if (!isAddress(address)) {
        return reply.status(400).send({ error: "Invalid address" });
      }
      const idx = parseInt(milestoneIndex, 10);
      if (isNaN(idx) || idx < 0) {
        return reply.status(400).send({ error: "Invalid milestone index" });
      }
      // V2 (EAS) path: release takes ONLY the milestone index — the binding
      // attestation was supplied at submitAttestation time (by UID), so no
      // attestation struct is re-passed here (unlike V1). Challenge window must
      // have expired (the contract enforces this and reverts otherwise).
      if (useEasV2()) {
        if (!escrowWriteEnabled()) {
          return reply.status(503).send({ error: "write_disabled", message: "Chain write not enabled (no gateway private key)." });
        }
        try {
          const version = resolveEscrowVersion(address);
          const result =
            version === "v3"
              ? await releaseMilestoneV3(idx, address as Address)
              : await releaseMilestoneV2(idx, address as Address);
          return {
            ...result,
            action: "release",
            escrow: address,
            milestoneIndex: idx,
            path: version === "v3" ? "eas-v3-mode-b" : "eas-v2",
          };
        } catch (err) {
          return reply.status(502).send({ error: "chain_write_failed", message: err instanceof Error ? err.message : String(err) });
        }
      }
      const body = req.body as { attestation?: OracleAttestation } | undefined;
      if (!body?.attestation || !body.attestation.escrowAddress) {
        return reply.status(400).send({
          error: "attestation_required",
          message:
            "An oracle-signed attestation struct is required in the request body.",
        });
      }
      const actorId = (req as any).operatorId ?? (req as any).apiKeyId ?? "system";
      const activityResult = await releaseMilestoneActivity.invoke({
        workflowRunId: `escrow:${address}`,
        activityId: `release:${address}:${idx}`,
        input: [
          address as Address,
          idx,
          body.attestation,
          actorId,
          req.ip,
          req.headers["user-agent"],
        ] as const,
        actorId,
        clientKey: req.headers["idempotency-key"] as string | undefined,
        httpMethod: "POST",
        httpPath: `/api/escrow/chain/${address}/release/${idx}`,
      });
      if (!activityResult.ok) {
        return sendActivityError(reply, activityResult.error);
      }
      return activityResult.value;
    },
  );

  /**
   * File a dispute against a milestone.
   * Requires: challengerBond, challengerEvidenceHash, reason.
   */
  app.post<{
    Params: { address: string; milestoneIndex: string };
    Body: DisputeInput;
  }>(
    "/api/escrow/chain/:address/dispute/:milestoneIndex",
    async (req, reply) => {
      const { address, milestoneIndex } = req.params;
      if (!isAddress(address)) {
        return reply.status(400).send({ error: "Invalid address" });
      }
      const idx = parseInt(milestoneIndex, 10);
      if (isNaN(idx) || idx < 0) {
        return reply.status(400).send({ error: "Invalid milestone index" });
      }
      const actorId = (req as any).operatorId ?? (req as any).apiKeyId ?? "system";
      const activityResult = await fileDisputeActivity.invoke({
        workflowRunId: `escrow:${address}`,
        activityId: `dispute:${address}:${idx}`,
        input: [address as Address, idx, req.body, actorId, req.ip, req.headers["user-agent"]] as const,
        actorId,
        clientKey: req.headers["idempotency-key"] as string | undefined,
        httpMethod: "POST",
        httpPath: `/api/escrow/chain/${address}/dispute/${idx}`,
      });
      if (!activityResult.ok) {
        return sendActivityError(reply, activityResult.error);
      }
      return activityResult.value;
    },
  );

  /**
   * Deposit operator bond for a milestone.
   * Returns 503 if write is disabled.
   */
  app.post<{ Params: { address: string; milestoneIndex: string } }>(
    "/api/escrow/chain/:address/deposit-bond/:milestoneIndex",
    async (req, reply) => {
      const { address, milestoneIndex } = req.params;
      if (!isAddress(address)) {
        return reply.status(400).send({ error: "Invalid address" });
      }
      const idx = parseInt(milestoneIndex, 10);
      if (isNaN(idx) || idx < 0) {
        return reply.status(400).send({ error: "Invalid milestone index" });
      }
      const actorId = (req as any).operatorId ?? (req as any).apiKeyId ?? "system";
      const activityResult = await depositBondActivity.invoke({
        workflowRunId: `escrow:${address}`,
        activityId: `depositBond:${address}:${idx}`,
        input: [address as Address, idx, actorId, req.ip, req.headers["user-agent"]] as const,
        actorId,
        clientKey: req.headers["idempotency-key"] as string | undefined,
        httpMethod: "POST",
        httpPath: `/api/escrow/chain/${address}/deposit-bond/${idx}`,
      });
      if (!activityResult.ok) {
        return sendActivityError(reply, activityResult.error);
      }
      return activityResult.value;
    },
  );

  /**
   * Submit evidence bundle hash for a milestone.
   * Returns 503 if write is disabled.
   */
  app.post<{
    Params: { address: string; milestoneIndex: string };
    Body: { evidenceBundleHash: string };
  }>(
    "/api/escrow/chain/:address/evidence/:milestoneIndex",
    async (req, reply) => {
      const { address, milestoneIndex } = req.params;
      if (!isAddress(address)) {
        return reply.status(400).send({ error: "Invalid address" });
      }
      const idx = parseInt(milestoneIndex, 10);
      if (isNaN(idx) || idx < 0) {
        return reply.status(400).send({ error: "Invalid milestone index" });
      }
      const body = req.body as { evidenceBundleHash?: string } | undefined;
      if (!body?.evidenceBundleHash) {
        return reply.status(400).send({ error: "evidenceBundleHash is required" });
      }
      // V2 (EAS) path: submitEvidence has the SAME wire signature in V2, but must
      // be sent through the V2 ABI against a MilestoneEscrowV2 address.
      if (useEasV2()) {
        if (!escrowWriteEnabled()) {
          return reply.status(503).send({ error: "write_disabled", message: "Chain write not enabled (no gateway private key)." });
        }
        try {
          const result = await submitEvidenceV2(idx, body.evidenceBundleHash as `0x${string}`, address as Address);
          return { ...result, action: "submitEvidence", escrow: address, milestoneIndex: idx, path: "eas-v2" };
        } catch (err) {
          return reply.status(502).send({ error: "chain_write_failed", message: err instanceof Error ? err.message : String(err) });
        }
      }
      const actorId = (req as any).operatorId ?? (req as any).apiKeyId ?? "system";
      const activityResult = await submitEvidenceActivity.invoke({
        workflowRunId: `escrow:${address}`,
        activityId: `submitEvidence:${address}:${idx}`,
        input: [address as Address, idx, body.evidenceBundleHash, actorId, req.ip, req.headers["user-agent"]] as const,
        actorId,
        clientKey: req.headers["idempotency-key"] as string | undefined,
        httpMethod: "POST",
        httpPath: `/api/escrow/chain/${address}/evidence/${idx}`,
      });
      if (!activityResult.ok) {
        return sendActivityError(reply, activityResult.error);
      }
      return activityResult.value;
    },
  );

  /**
   * Submit an oracle-signed attestation for a milestone.
   * Body: { attestation: IPCCOracle.Attestation } — the full struct from
   * the oracle client. The on-chain contract re-verifies the signature
   * against the protocol oracle verifier before opening the challenge window.
   */
  app.post<{
    Params: { address: string; milestoneIndex: string };
    Body: { attestation: OracleAttestation };
  }>(
    "/api/escrow/chain/:address/attestation/:milestoneIndex",
    async (req, reply) => {
      const { address, milestoneIndex } = req.params;
      if (!isAddress(address)) {
        return reply.status(400).send({ error: "Invalid address" });
      }
      const idx = parseInt(milestoneIndex, 10);
      if (isNaN(idx) || idx < 0) {
        return reply.status(400).send({ error: "Invalid milestone index" });
      }
      // V2 (EAS) path: the body carries an EAS UID (bytes32) instead of the full
      // oracle attestation struct. The contract validates the UID against EAS
      // on-chain. Accept `easUid` (preferred) or legacy `attestationHash`.
      if (useEasV2()) {
        const v2body = req.body as { easUid?: string; attestationHash?: string } | undefined;
        const easUid = v2body?.easUid ?? v2body?.attestationHash;
        if (!easUid || !easUid.startsWith("0x")) {
          return reply.status(400).send({
            error: "eas_uid_required",
            message: "V2 attestation requires an EAS UID (bytes32) in `easUid` (or `attestationHash`).",
          });
        }
        if (!escrowWriteEnabled()) {
          return reply.status(503).send({ error: "write_disabled", message: "Chain write not enabled (no gateway private key)." });
        }
        try {
          const version = resolveEscrowVersion(address);
          const result =
            version === "v3"
              ? await submitAttestationV3(idx, easUid as `0x${string}`, address as Address)
              : await submitAttestationV2(idx, easUid as `0x${string}`, address as Address);
          return {
            ...result,
            action: "submitAttestation",
            escrow: address,
            milestoneIndex: idx,
            easUid,
            path: version === "v3" ? "eas-v3-mode-b" : "eas-v2",
          };
        } catch (err) {
          return reply.status(502).send({ error: "chain_write_failed", message: err instanceof Error ? err.message : String(err) });
        }
      }
      const body = req.body as { attestation?: OracleAttestation } | undefined;
      if (!body?.attestation || !body.attestation.escrowAddress) {
        return reply.status(400).send({
          error: "attestation_required",
          message:
            "An oracle-signed attestation struct is required in the request body.",
        });
      }
      const actorId = (req as any).operatorId ?? (req as any).apiKeyId;
      const result = await facade.submitAttestation(
        address as Address,
        idx,
        body.attestation,
        actorId,
        req.ip,
        req.headers["user-agent"],
      );
      return sendResult(reply, result);
    },
  );

  // ── Mode A — payer-approval release (MilestoneEscrowV3) ────────────────
  //
  // POST /api/escrow/chain/:address/approve-release/:milestoneIndex
  //
  // Returns calldata for MilestoneEscrowV3.approveAndRelease(milestoneIndex)
  // for the PAYER's wallet to submit. The gateway DOES NOT send this
  // transaction itself — it does not hold the payer's key, and Mode A is by
  // definition a buyer-direct settlement (no oracle attestation, no challenge
  // window, no protocol fee).
  //
  // Gated by VERIFICATION_MODE_A_ENABLED. Default OFF so the route is invisible
  // until the operator opts in. When OFF, returns 503.
  //
  // Response shape (200):
  //   {
  //     action: "approveAndRelease",
  //     escrow: <address>,
  //     milestoneIndex: <number>,
  //     calldata: "0x...",
  //     target: <same as escrow>,
  //     valueWei: "0",
  //     instruction: "Submit `calldata` to `target` from the payer wallet.",
  //     path: "v3-mode-a"
  //   }
  app.post<{
    Params: { address: string; milestoneIndex: string };
  }>(
    "/api/escrow/chain/:address/approve-release/:milestoneIndex",
    async (req, reply) => {
      if (!isModeAEnabled()) {
        return reply.status(503).send({
          error: "mode_a_disabled",
          message:
            "Mode A (payer-approval release) is not enabled. Set VERIFICATION_MODE_A_ENABLED=true to expose this route.",
        });
      }

      const { address, milestoneIndex } = req.params;
      if (!isAddress(address)) {
        return reply.status(400).send({ error: "Invalid address" });
      }
      const idx = parseInt(milestoneIndex, 10);
      if (isNaN(idx) || idx < 0) {
        return reply.status(400).send({ error: "Invalid milestone index" });
      }

      // Pure encode — no network, no wallet. The PAYER submits this from
      // their own wallet (MilestoneEscrowV3 enforces onlyPayerEffective).
      const calldata = encodeApproveAndReleaseV3(idx);

      return {
        action: "approveAndRelease",
        escrow: address,
        milestoneIndex: idx,
        calldata,
        target: address,
        valueWei: "0",
        instruction:
          "Submit `calldata` to `target` from the payer wallet. MilestoneEscrowV3.approveAndRelease is restricted to the payer (onlyPayerEffective); any other sender will revert.",
        path: "v3-mode-a",
      };
    },
  );
}
