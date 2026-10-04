import type { FastifyInstance } from "fastify";

/**
 * DePIN rewards, capability certificates and the treasury summary.
 *
 * Nothing in PCC computes reward epochs, records reward claims, mints capability certificates or
 * reads a treasury balance. These routes used to answer with hard-coded fixtures: two reward epochs
 * with kernel scores and payouts, "claimed" claims with a fake transaction hash, three certificates,
 * a `POST /api/certificates/mint` that reported `minted: true` without minting anything, and a
 * treasury holding "50000.00 USDC" and "10.5 ETH" worth "85000.00" USD. The agent package advertises
 * them (`pcc_depin_stats`), so an agent read invented money as fact.
 *
 * Certificates follow board N80: none exist, so the list is empty, one certificate is 404 and a mint
 * answers 501 without claiming anything. The reward and treasury routes answer 501 `not_available`,
 * naming the reads that ARE real, instead of inventing data
 * (the product invariant: empty, unavailable or error are valid states; fabricated plausibility is
 * not). The paths stay registered so a client gets an honest answer rather than a 404. Readmodels'
 * server-side fabrication census (2026-09-24) assigned this family to pcc-economics.
 */
function notAvailable(what: string, why: string, see: string[]) {
  return { error: "not_available", message: `${what} ${why} Nothing is returned rather than an estimate.`, see };
}

const REWARDS_UNAVAILABLE = notAvailable(
  "DePIN reward epochs, kernel reward scores and reward claims are not computed or recorded.",
  "Real payment state is per settlement unit, in the escrow.",
  ["/api/escrow", "/api/jobs/:jobId"],
);

// ── Certificates ────────────────────────────────────────────────
// None exist. Minting has no registration or job checks, no Merkle tree and no store, so
// the gateway serves no certificate and mints none (board N80; rehearsal R0 finding G4:
// a certificate "minted" for any kernelDid, with a caller-chosen tier, a placeholder tree
// and a mintedAt from when this module loaded, before the kernel existed). The three
// certificates that used to be listed here named kernels that do not exist.

const TREASURY_UNAVAILABLE = notAvailable(
  "No treasury balance is read.",
  "Protocol fees are paid per settlement unit to the fee recipient named in each funded escrow.",
  ["/api/escrow"],
);

export async function rewardRoutes(app: FastifyInstance) {
  // ── Epochs and kernel rewards ─────────────────────────────────
  app.get("/api/rewards/epochs", async (_req, reply) => reply.code(501).send(REWARDS_UNAVAILABLE));
  app.get("/api/rewards/epochs/:epochId", async (_req, reply) => reply.code(501).send(REWARDS_UNAVAILABLE));
  app.get("/api/rewards/kernels/:kernelId", async (_req, reply) => reply.code(501).send(REWARDS_UNAVAILABLE));

  // ── Claims ────────────────────────────────────────────────────
  // A claim used to be "created" (201) with a made-up id. Nothing recorded or paid it.
  app.post("/api/rewards/claims", async (_req, reply) => reply.code(501).send(REWARDS_UNAVAILABLE));
  app.get("/api/rewards/claims/:claimId", async (_req, reply) => reply.code(501).send(REWARDS_UNAVAILABLE));

  // ── Certificates (none exist; minting is not implemented, N80) ─────

  app.get<{ Querystring: { kernelDid?: string; status?: string } }>(
    "/api/certificates",
    async () => ({ certificates: [], total: 0 }),
  );

  app.get<{ Params: { certId: string } }>(
    "/api/certificates/:certId",
    async (_req, reply) => reply.code(404).send({ error: "not_found", message: "Certificate not found" }),
  );

  app.post("/api/certificates/mint", async (_req, reply) =>
    reply.code(501).send({
      minted: false,
      error: "not_implemented",
      message:
        "No certificate was minted. Minting needs checks against the kernel's registration and jobs, a real Merkle tree and a store; none exist yet.",
    }),
  );

  // ── Treasury ──────────────────────────────────────────────────
  app.get("/api/treasury/summary", async (_req, reply) => reply.code(501).send(TREASURY_UNAVAILABLE));
}
