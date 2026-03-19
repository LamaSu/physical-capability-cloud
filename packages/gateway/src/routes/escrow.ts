import type { FastifyInstance } from "fastify";
import { type Address, isAddress } from "viem";
import { readEscrow, getEscrowEvents, readTokenBalance, readTokenAllowance, getActiveNetwork } from "../chain-client.js";
import { getRepos } from "../db.js";
import {
  getEscrowState,
  getDispute,
  getEvents,
  fundEscrow,
  approveToken,
  releaseMilestone,
  fileDispute,
  depositBond,
  submitEvidence,
  submitAttestation,
  isWriteEnabled,
  getSignerAddress,
} from "../contracts/escrow-client.js";

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function escrowRoutes(app: FastifyInstance) {
  // List escrows from DB (with milestones)
  app.get<{ Querystring: { status?: string } }>(
    "/api/escrow",
    async (req) => {
      try {
        const repos = getRepos();
        const escrows = req.query.status
          ? repos.escrows.findByStatus(req.query.status)
          : repos.escrows.findAll();

        // Enrich each escrow with its milestones
        const enriched = escrows.map((e) => {
          const milestones = repos.escrows.findMilestonesByEscrow(e.id);
          return {
            ...e,
            milestoneCount: milestones.length,
            milestones,
          };
        });

        return { escrows: enriched };
      } catch {
        return { escrows: [] };
      }
    },
  );

  // Get escrow by ID (DB) or by on-chain address
  app.get<{ Params: { escrowId: string } }>("/api/escrow/:escrowId", async (req, reply) => {
    const { escrowId } = req.params;

    // If it looks like an Ethereum address, read from chain
    if (isAddress(escrowId)) {
      try {
        const escrow = await readEscrow(escrowId as Address);
        return { escrow, source: "on-chain" };
      } catch (err) {
        return reply.status(502).send({
          error: "on_chain_read_failed",
          message: err instanceof Error ? err.message : "Failed to read escrow from chain",
        });
      }
    }

    // Otherwise use DB
    try {
      const repos = getRepos();
      const escrow = repos.escrows.findById(escrowId);
      if (!escrow) return reply.status(404).send({ error: "not_found" });

      const milestones = repos.escrows.findMilestonesByEscrow(escrowId);
      const disputes = repos.escrows.findDisputesByEscrow(escrowId);
      return {
        escrow: { ...escrow, milestones, disputes },
        source: "db",
      };
    } catch {
      return reply.status(404).send({ error: "not_found" });
    }
  });

  // Get on-chain events for an escrow contract
  app.get<{ Params: { address: string }; Querystring: { fromBlock?: string } }>(
    "/api/escrow/chain/:address/events",
    async (req, reply) => {
      const { address } = req.params;
      if (!isAddress(address)) {
        return reply.status(400).send({ error: "Invalid address" });
      }

      try {
        const fromBlock = req.query.fromBlock ? BigInt(req.query.fromBlock) : undefined;
        const events = await getEscrowEvents(address as Address, fromBlock);
        return { events };
      } catch (err) {
        return reply.status(502).send({
          error: "event_read_failed",
          message: err instanceof Error ? err.message : "Failed to read events",
        });
      }
    },
  );

  // Read token balance for an account
  app.get<{ Params: { tokenAddress: string; account: string } }>(
    "/api/escrow/chain/token/:tokenAddress/balance/:account",
    async (req, reply) => {
      const { tokenAddress, account } = req.params;
      if (!isAddress(tokenAddress) || !isAddress(account)) {
        return reply.status(400).send({ error: "Invalid address" });
      }

      try {
        const balance = await readTokenBalance(tokenAddress as Address, account as Address);
        return { balance, token: tokenAddress, account };
      } catch (err) {
        return reply.status(502).send({
          error: "balance_read_failed",
          message: err instanceof Error ? err.message : "Failed to read balance",
        });
      }
    },
  );

  // Read token allowance
  app.get<{ Params: { tokenAddress: string; owner: string; spender: string } }>(
    "/api/escrow/chain/token/:tokenAddress/allowance/:owner/:spender",
    async (req, reply) => {
      const { tokenAddress, owner, spender } = req.params;
      if (!isAddress(tokenAddress) || !isAddress(owner) || !isAddress(spender)) {
        return reply.status(400).send({ error: "Invalid address" });
      }

      try {
        const allowance = await readTokenAllowance(
          tokenAddress as Address,
          owner as Address,
          spender as Address,
        );
        return { allowance, token: tokenAddress, owner, spender };
      } catch (err) {
        return reply.status(502).send({
          error: "allowance_read_failed",
          message: err instanceof Error ? err.message : "Failed to read allowance",
        });
      }
    },
  );

  // ── Extended on-chain reads (escrow-client) ───────────────────────

  // Read dispute state for a specific milestone
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

      try {
        const dispute = await getDispute(idx, address as Address);
        return { dispute, milestoneIndex: idx, source: "on-chain" };
      } catch (err) {
        return reply.status(502).send({
          error: "dispute_read_failed",
          message: err instanceof Error ? err.message : "Failed to read dispute from chain",
        });
      }
    },
  );

  // Full escrow state with parallel milestone reads
  app.get<{ Params: { address: string } }>(
    "/api/escrow/chain/:address/state",
    async (req, reply) => {
      const { address } = req.params;
      if (!isAddress(address)) {
        return reply.status(400).send({ error: "Invalid address" });
      }

      try {
        const state = await getEscrowState(address as Address);
        return { escrow: state, source: "on-chain" };
      } catch (err) {
        return reply.status(502).send({
          error: "state_read_failed",
          message: err instanceof Error ? err.message : "Failed to read escrow state from chain",
        });
      }
    },
  );

  // Write capability check
  app.get("/api/escrow/chain/write-status", async () => {
    return {
      writeEnabled: isWriteEnabled(),
      signerAddress: getSignerAddress() ?? null,
      network: getActiveNetwork(),
    };
  });

  // ── Write routes ──────────────────────────────────────────────────
  //
  // Write operations call the MilestoneEscrow contract via the gateway's
  // configured wallet (PCC_GATEWAY_PRIVATE_KEY). They return the
  // transaction hash immediately — the caller can poll for confirmation
  // or watch for events via SSE.
  //
  // All write routes return 503 if PCC_GATEWAY_PRIVATE_KEY is not set.

  // Fund an escrow contract (payer must have approved token transfer)
  app.post<{ Params: { address: string } }>(
    "/api/escrow/chain/:address/fund",
    async (req, reply) => {
      const { address } = req.params;
      if (!isAddress(address)) {
        return reply.status(400).send({ error: "Invalid address" });
      }

      if (!isWriteEnabled()) {
        return reply.status(503).send({
          error: "write_disabled",
          message: "Write operations are not available — PCC_GATEWAY_PRIVATE_KEY is not configured.",
        });
      }

      try {
        const result = await fundEscrow(address as Address);
        return { ...result, action: "fund", escrow: address };
      } catch (err) {
        return reply.status(502).send({
          error: "fund_failed",
          message: err instanceof Error ? err.message : "Failed to fund escrow",
        });
      }
    },
  );

  // Approve token spending for an escrow contract
  app.post<{
    Params: { address: string };
    Body: { amount: string; tokenAddress?: string };
  }>(
    "/api/escrow/chain/:address/approve",
    async (req, reply) => {
      const { address } = req.params;
      if (!isAddress(address)) {
        return reply.status(400).send({ error: "Invalid escrow address" });
      }

      const body = req.body as { amount?: string; tokenAddress?: string } | undefined;
      if (!body?.amount) {
        return reply.status(400).send({ error: "amount is required" });
      }

      if (!isWriteEnabled()) {
        return reply.status(503).send({
          error: "write_disabled",
          message: "Write operations are not available — PCC_GATEWAY_PRIVATE_KEY is not configured.",
        });
      }

      try {
        const tokenAddr = body.tokenAddress && isAddress(body.tokenAddress)
          ? (body.tokenAddress as Address)
          : undefined;
        const result = await approveToken(address as Address, body.amount, tokenAddr);
        return { ...result, action: "approve", spender: address, amount: body.amount };
      } catch (err) {
        return reply.status(502).send({
          error: "approve_failed",
          message: err instanceof Error ? err.message : "Failed to approve token",
        });
      }
    },
  );

  // Release a milestone (challenge window must have expired)
  app.post<{ Params: { address: string; milestoneIndex: string } }>(
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

      if (!isWriteEnabled()) {
        return reply.status(503).send({
          error: "write_disabled",
          message: "Write operations are not available — PCC_GATEWAY_PRIVATE_KEY is not configured.",
        });
      }

      try {
        const result = await releaseMilestone(idx, address as Address);
        return { ...result, action: "release", escrow: address, milestoneIndex: idx };
      } catch (err) {
        return reply.status(502).send({
          error: "release_failed",
          message: err instanceof Error ? err.message : "Failed to release milestone",
        });
      }
    },
  );

  // File a dispute against a milestone
  app.post<{
    Params: { address: string; milestoneIndex: string };
    Body: { challengerBond: string; challengerEvidenceHash: string; reason: string };
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

      const body = req.body as {
        challengerBond?: string;
        challengerEvidenceHash?: string;
        reason?: string;
      } | undefined;

      if (!body?.challengerBond || !body?.challengerEvidenceHash || !body?.reason) {
        return reply.status(400).send({
          error: "Missing required fields: challengerBond, challengerEvidenceHash, reason",
        });
      }

      if (!isWriteEnabled()) {
        return reply.status(503).send({
          error: "write_disabled",
          message: "Write operations are not available — PCC_GATEWAY_PRIVATE_KEY is not configured.",
        });
      }

      try {
        const result = await fileDispute(
          idx,
          body.challengerBond,
          body.challengerEvidenceHash as `0x${string}`,
          body.reason,
          address as Address,
        );
        return { ...result, action: "dispute", escrow: address, milestoneIndex: idx };
      } catch (err) {
        return reply.status(502).send({
          error: "dispute_failed",
          message: err instanceof Error ? err.message : "Failed to file dispute",
        });
      }
    },
  );

  // Deposit operator bond for a milestone
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

      if (!isWriteEnabled()) {
        return reply.status(503).send({
          error: "write_disabled",
          message: "Write operations are not available — PCC_GATEWAY_PRIVATE_KEY is not configured.",
        });
      }

      try {
        const result = await depositBond(idx, address as Address);
        return { ...result, action: "depositBond", escrow: address, milestoneIndex: idx };
      } catch (err) {
        return reply.status(502).send({
          error: "deposit_bond_failed",
          message: err instanceof Error ? err.message : "Failed to deposit bond",
        });
      }
    },
  );

  // Submit evidence bundle hash for a milestone
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

      if (!isWriteEnabled()) {
        return reply.status(503).send({
          error: "write_disabled",
          message: "Write operations are not available — PCC_GATEWAY_PRIVATE_KEY is not configured.",
        });
      }

      try {
        const result = await submitEvidence(
          idx,
          body.evidenceBundleHash as `0x${string}`,
          address as Address,
        );
        return { ...result, action: "submitEvidence", escrow: address, milestoneIndex: idx };
      } catch (err) {
        return reply.status(502).send({
          error: "evidence_failed",
          message: err instanceof Error ? err.message : "Failed to submit evidence",
        });
      }
    },
  );

  // Submit verifier attestation for a milestone
  app.post<{
    Params: { address: string; milestoneIndex: string };
    Body: { attestationHash: string };
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

      const body = req.body as { attestationHash?: string } | undefined;
      if (!body?.attestationHash) {
        return reply.status(400).send({ error: "attestationHash is required" });
      }

      if (!isWriteEnabled()) {
        return reply.status(503).send({
          error: "write_disabled",
          message: "Write operations are not available — PCC_GATEWAY_PRIVATE_KEY is not configured.",
        });
      }

      try {
        const result = await submitAttestation(
          idx,
          body.attestationHash as `0x${string}`,
          address as Address,
        );
        return { ...result, action: "submitAttestation", escrow: address, milestoneIndex: idx };
      } catch (err) {
        return reply.status(502).send({
          error: "attestation_failed",
          message: err instanceof Error ? err.message : "Failed to submit attestation",
        });
      }
    },
  );
}
