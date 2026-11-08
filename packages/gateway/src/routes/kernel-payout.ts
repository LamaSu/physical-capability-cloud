import type { FastifyInstance } from "fastify";
import type { PublicClient } from "viem";
import {
  AUTHENTICATION_REQUIRED, EXPLICIT_CREDENTIAL_REQUIRED, authorityOf, isAnonymous,
  provenByCookieOnly, refuseKernelAction,
} from "../auth/kernel-authority.js";
import { getPublicClient, resolveChainConfig } from "../contracts/escrow-client.js";
import { getStore } from "../db.js";
import { gateJobRead, refuseJobRead } from "../readmodels/job-read-gate.js";
import { PAYOUT_CONSENT_SHA256, PAYOUT_CONSENT_VERSION, payoutConsent } from "../services/payout/consent.js";
import { checkJobPayout } from "../services/payout/payout-check.js";
import { bindPayoutWallet, PayoutOwnerChanged, resolvePayoutBinding, revokePayoutWallet } from "../services/payout/repository.js";

const WALLET_SIGN_IN_REQUIRED = {
  error: "forbidden", reason: "wallet_sign_in_required",
  message: "Recording or revoking a payout wallet needs a wallet sign-in, carried by an API key minted from it or by its session token sent as a Bearer token.",
};
const READ_FAILED = { error: "read_failed", message: "The payout record could not be read. Try again shortly." };
const KERNEL_NOT_FOUND = { error: "kernel_not_found", message: "No kernel with this id is registered." };
const invalidChain = (chainId: number) => ({
  error: "invalid_chain", message: "chainId must be this gateway's settlement chain.", chainId,
});

export async function kernelPayoutRoutes(app: FastifyInstance, opts: { publicClient?: PublicClient } = {}) {
  app.get<{ Params: { kernelId: string } }>("/api/kernels/:kernelId/payout", async (req, reply) => {
    try {
      if (!getStore().repos.kernels.findById(req.params.kernelId)) return reply.code(404).send(KERNEL_NOT_FOUND);
      return resolvePayoutBinding(req.params.kernelId, resolveChainConfig().chain.id);
    } catch {
      return reply.code(503).send(READ_FAILED);
    }
  });

  app.put<{ Params: { kernelId: string } }>("/api/operator/payout/:kernelId", async (req, reply) => {
    const principal = authorityOf(req);
    if (isAnonymous(principal)) return reply.code(401).send(AUTHENTICATION_REQUIRED);
    if (provenByCookieOnly(principal)) return reply.code(403).send(EXPLICIT_CREDENTIAL_REQUIRED);
    if (principal.admin || principal.provenWalletVia !== "siwe-session"
      || (principal.provenWalletCarrier !== "key" && principal.provenWalletCarrier !== "bearer-session")) {
      return reply.code(403).send(WALLET_SIGN_IN_REQUIRED);
    }
    // An admin secret never supplies binding authority, including beside an owner proof.
    const authority = { ...principal, admin: false };
    const refusal = refuseKernelAction(req, authority, req.params.kernelId, "decide");
    if (refusal) return reply.code(refusal.status).send(refusal.body);
    const chainId = resolveChainConfig().chain.id;
    const body = (req.body ?? {}) as { chainId?: unknown; consentVersion?: unknown; consentSha256?: unknown };
    if (!Number.isSafeInteger(body.chainId) || body.chainId !== chainId) return reply.code(400).send(invalidChain(chainId));
    if (body.consentVersion !== PAYOUT_CONSENT_VERSION || body.consentSha256 !== PAYOUT_CONSENT_SHA256) {
      return reply.code(409).send({ error: "consent_mismatch",
        message: "These terms don't match the current payout terms. Show the current terms and send their version and sha256.", consent: payoutConsent });
    }
    try {
      return bindPayoutWallet({ kernelId: req.params.kernelId, chainId, wallet: authority.provenWallet!, carrier: principal.provenWalletCarrier });
    } catch (error) {
      if (error instanceof PayoutOwnerChanged) return reply.code(403).send({ error: "forbidden", reason: "operator_proof_required" });
      return reply.code(503).send({ error: "write_failed", message: "The payout record could not be saved. Try again shortly." });
    }
  });

  app.post<{ Params: { kernelId: string } }>("/api/operator/payout/:kernelId/revoke", async (req, reply) => {
    const authority = authorityOf(req);
    if (isAnonymous(authority)) return reply.code(401).send(AUTHENTICATION_REQUIRED);
    if (!authority.admin) {
      if (provenByCookieOnly(authority)) return reply.code(403).send(EXPLICIT_CREDENTIAL_REQUIRED);
      if (authority.provenWalletVia !== "siwe-session"
        || (authority.provenWalletCarrier !== "key" && authority.provenWalletCarrier !== "bearer-session")) {
        return reply.code(403).send(WALLET_SIGN_IN_REQUIRED);
      }
    }
    const refusal = refuseKernelAction(req, authority, req.params.kernelId, "decide");
    if (refusal) return reply.code(refusal.status).send(refusal.body);
    const chainId = resolveChainConfig().chain.id;
    const body = (req.body ?? {}) as { chainId?: unknown };
    if (!Number.isSafeInteger(body.chainId) || body.chainId !== chainId) return reply.code(400).send(invalidChain(chainId));
    try {
      const binding = revokePayoutWallet(req.params.kernelId, chainId, authority.admin ? "admin" : "owner");
      if (!binding) return reply.code(404).send({ error: "not_bound", message: "This kernel has no active payout record on this chain." });
      return { binding };
    } catch {
      return reply.code(503).send({ error: "write_failed", message: "The payout record could not be revoked. Try again shortly." });
    }
  });

  app.get<{ Params: { jobId: string } }>("/api/jobs/:jobId/payout-check", async (req, reply) => {
    const gate = gateJobRead(req, req.params.jobId);
    if (!gate.ok) return refuseJobRead(reply, gate, { error: "job_not_found" });
    try {
      return await checkJobPayout(gate.job, opts.publicClient ?? getPublicClient());
    } catch {
      return reply.code(503).send(READ_FAILED);
    }
  });
}
