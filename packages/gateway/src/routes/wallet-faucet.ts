import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getAddress } from "viem";
import { requireAuth } from "../auth/require-auth.js";
import { accountPrincipal } from "./wallets.js";
import { WalletLinkError } from "../services/wallet-links/repository.js";
import { createFaucetClientProvider, type FaucetClient } from "../services/wallet-faucet/client.js";
import { faucetRoutesEnabled } from "../services/wallet-faucet/config.js";
import {
  FaucetError, attemptableClaim, checkFundingLink, cliFundingLink, currentFundingLink,
  ensureFundingGrant, finishFundingClaim, fundingClaims, leaseFundingClaim, liveLease,
  ownerFundingLink, validTransactionHash,
} from "../services/wallet-faucet/repository.js";

const ERROR_TYPES = new Set(["faucet_limit_exceeded", "rate_limit_exceeded", "unauthorized", "forbidden",
  "bad_gateway", "internal_server_error", "network_timeout", "network_connection_failed"]);

function sdkErrorClass(error: unknown): string {
  try {
    if (error !== null && typeof error === "object" && "errorType" in error &&
      typeof error.errorType === "string" && ERROR_TYPES.has(error.errorType)) return error.errorType;
  } catch { /* Error objects never leave this boundary. */ }
  return "unknown";
}

/** Attach both outcomes before racing; late results cannot write claim state. */
async function requestClaim(client: FaucetClient, address: `0x${string}`, token: "eth" | "usdc", timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const request = new Promise<unknown>(resolve => resolve(client.requestFaucet(address, token))).then(result => {
      const hash = result !== null && typeof result === "object" && "transactionHash" in result ? result.transactionHash : undefined;
      return validTransactionHash(hash) ? { txHash: hash, errorClass: undefined } : { txHash: undefined, errorClass: "invalid_tx_hash" };
    }).catch(error => ({ txHash: undefined, errorClass: sdkErrorClass(error) }));
    const timeout = new Promise<{ txHash: undefined; errorClass: string }>(resolve => {
      timer = setTimeout(() => resolve({ txHash: undefined, errorClass: "timeout" }), timeoutMs);
    });
    return await Promise.race([request, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// Internal plugin settings; callers never control amounts or the funding network.
interface FaucetOptions {
  client?: FaucetClient;
  env?: NodeJS.ProcessEnv;
  callTimeoutMs?: number;
  attemptBudgetMs?: number;
}
const emptyBodyOptions = {
  schema: { body: { type: "object", additionalProperties: false, properties: {} } },
  validatorCompiler: () => (body: unknown) => {
    const valid = body !== null && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0;
    return valid ? { value: body } : { error: new Error("invalid_request") };
  },
  preValidation: async (req: FastifyRequest) => {
    if (req.body == null && req.headers["transfer-encoding"] === undefined && Number(req.headers["content-length"] ?? 0) === 0) req.body = {};
  },
};

export async function walletFaucetRoutes(app: FastifyInstance, options: FaucetOptions) {
  const env = options.env ?? process.env;
  if (!faucetRoutesEnabled(env)) return;
  const client = createFaucetClientProvider(env, options.client);
  const callTimeoutMs = options.callTimeoutMs ?? 8000;
  const attemptBudgetMs = options.attemptBudgetMs ?? 5000;
  if (!Number.isFinite(callTimeoutMs) || callTimeoutMs < 0 || !Number.isFinite(attemptBudgetMs) || attemptBudgetMs < 0) {
    throw new Error("invalid_faucet_timing");
  }
  const requestStartedAt = new WeakMap<FastifyRequest, number>();
  app.addHook("onRequest", async (req, reply) => {
    requestStartedAt.set(req, Date.now() - reply.elapsedTime);
  });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof WalletLinkError) return reply.code(error.status).send({ error: error.code,
      ...(error instanceof FaucetError && error.cap ? { cap: error.cap } : {}) });
    if (error.validation || (error.statusCode && error.statusCode < 500)) return reply.code(400).send({ error: "invalid_request" });
    return reply.code(500).send({ error: "internal_error" });
  });

  async function fund(link: ReturnType<typeof cliFundingLink>, startedAt: number, reply: FastifyReply) {
    const budgetExpired = () => Date.now() - startedAt >= attemptBudgetMs || reply.elapsedTime >= attemptBudgetMs;
    checkFundingLink(link, Date.now());
    let claims = fundingClaims(link.id);
    if (!claims.length || claims.some(claim => attemptableClaim(claim, Date.now()))) {
      if (!client()) throw new FaucetError(503, "faucet_unavailable");
    }
    if (!claims.length) claims = ensureFundingGrant(link.id, Date.now());
    for (const claim of claims) {
      if (budgetExpired()) break;
      const active = currentFundingLink(link.id, Date.now());
      const current = fundingClaims(link.id).find(row => row.token === claim.token && row.seq === claim.seq)!;
      if (liveLease(current, Date.now())) break;
      if (!attemptableClaim(current, Date.now())) continue;
      const available = client();
      if (!available) throw new FaucetError(503, "faucet_unavailable");
      const address = getAddress(active.address_or_pubkey);
      if (budgetExpired()) break;
      const leased = leaseFundingClaim(current, Date.now());
      if (!leased) break;
      const result = await requestClaim(available, address, claim.token, callTimeoutMs);
      finishFundingClaim(leased, result.txHash, result.errorClass, Date.now());
    }
    currentFundingLink(link.id, Date.now());
    claims = fundingClaims(link.id);
    const publicClaims = claims.map(claim => ({ token: claim.token, amount: claim.amount, status: claim.status,
      ...(claim.status === "succeeded" ? { txHash: claim.tx_hash! } : {}) }));
    const status = claims.every(claim => claim.status === "succeeded") ? "funded"
      : claims.some(claim => claim.status === "pending") ? "pending"
      : claims.some(claim => claim.status === "succeeded") ? "partial" : undefined;
    if (status) return reply.send({ status, claims: publicClaims });
    return reply.code(502).send({ error: "faucet_error", errorClass: claims.find(claim => claim.status === "failed")?.error_class ?? "unknown" });
  }

  app.post<{ Params: { id: string } }>("/api/wallets/link-requests/:id/fund", emptyBodyOptions, async (req, reply) => {
    const now = Date.now();
    return fund(cliFundingLink(req.params.id, now), requestStartedAt.get(req) ?? now, reply);
  });
  app.post<{ Params: { linkId: string } }>("/api/wallets/:linkId/fund", {
    ...emptyBodyOptions, onRequest: requireAuth,
  }, async (req, reply) => {
    const now = Date.now();
    return fund(ownerFundingLink(req.params.linkId, accountPrincipal(req), req.apiKeyId ?? null), requestStartedAt.get(req) ?? now, reply);
  });
}
