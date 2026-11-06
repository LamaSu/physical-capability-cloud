/**
 * PGTR Relay routes -- Payment-Gated Transaction Relay (ERC-8194).
 *
 * POST /api/pgtr/relay   -- DISABLED: answers 501 to every request that reaches it (PGTR_RELAY_DISABLED_REFUSAL)
 * GET  /api/pgtr/status   -- enabled: false, plus the forwarder address and whether a relayer key is set
 *
 * The relay is disabled. This change removes the old signer handler; its code is in git
 * history at PR #606's head, cb741b3a. It only shape-checked an EIP-3009 payment authorization
 * bundled with target call data before calling PCCForwarder.relay() from the relayer wallet.
 * A redesign must bind the target and the calldata to the payer's signature.
 */

import type { FastifyInstance } from "fastify";

/**
 * POST /api/pgtr/relay is disabled (economics security finding, bus #7292, 2026-10-08).
 *
 * The old signer handler was removed in this change (git history: PR #606 head cb741b3a).
 * With PCC_PGTR_FORWARDER_ADDRESS and PCC_PGTR_RELAYER_KEY set, that handler sent
 * a PCCForwarder.relay transaction from the relayer key for any authenticated caller,
 * with the payer, target and callData taken from the request body. The forwarder checked
 * a signature only for the USDC transferWithAuthorization when the amount was above 0,
 * and that signature covered the payment, never the target or the calldata. relay then
 * called the target with pgtrSender() = payer, which MilestoneEscrow V1-V3 trusted as the
 * sender. So any API key or SIWE session could act as any payer against a trusted target.
 *
 * The relay stays off until a redesign binds the target and the calldata to the payer's
 * signature. Until then the route's onRequest hook answers every request with this 501,
 * and GET /api/pgtr/status reports enabled: false.
 */
export const PGTR_RELAY_DISABLED_REFUSAL = {
  error: "not_implemented",
  code: "PGTR_RELAY_DISABLED",
  message:
    "The PGTR relay is disabled. It stays off until the target contract and the calldata are bound to the payer's signature.",
} as const;

export async function pgtrRelayRoutes(app: FastifyInstance) {
  // ── Status ──────────────────────────────────────────────────────────

  app.get("/api/pgtr/status", async () => {
    const forwarderAddress = process.env.PCC_PGTR_FORWARDER_ADDRESS;
    const relayerConfigured = !!process.env.PCC_PGTR_RELAYER_KEY;

    return {
      // false whatever the env says, while POST /api/pgtr/relay is disabled
      enabled: false,
      disabledCode: PGTR_RELAY_DISABLED_REFUSAL.code,
      forwarderAddress: forwarderAddress ?? null,
      relayerConfigured,
    };
  });

  // ── Relay ───────────────────────────────────────────────────────────

  app.post("/api/pgtr/relay", {
    // Callback style gives Fastify no continuation: even a premature close cannot
    // start preParsing, body parsing or the handler. The lifecycle tests pin this.
    onRequest: (_req, reply, _done) => {
      reply.code(501).send(PGTR_RELAY_DISABLED_REFUSAL);
    },
  },
  // Defence in depth: this unconditional refusal should be unreachable.
  async (_req, reply) => reply.code(501).send(PGTR_RELAY_DISABLED_REFUSAL));
}
