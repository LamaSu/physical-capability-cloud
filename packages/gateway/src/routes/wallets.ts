import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import { getAddress, isAddress } from "viem";
import { isValidKernelId } from "@pcc/spec";
import { sql } from "@pcc/store";
import { getRepos, getStore } from "../db.js";
import { requireAuth } from "../auth/require-auth.js";
import { resolveSession } from "../auth/siwe-auth.js";
import { walletLinkConfig } from "../services/wallet-links/config.js";
import { CONSENT_SHA256, CONSENT_VERSION, NETWORK_NAME, renderConsent } from "../services/wallet-links/consent.js";
import { verifyProofMessage } from "../services/wallet-links/message.js";
import {
  WalletLinkError, claimLinkProof, createLinkRequest, decideLinkRequest, displayUserCode, finishLinkProof,
  getLinkRequest, listWalletLinks, lookupLinkRequestByCode, revokeWalletLink,
} from "../services/wallet-links/repository.js";
import { requesterIpClass, userCodesEqual, walletRequestLimits } from "../services/wallet-links/guards.js";

const label = z.string().regex(/^[A-Za-z0-9._@-]{1,64}$/).refine(value => value.trim() === value);
const clientName = z.string().regex(/^[A-Za-z0-9._-]{1,32}$/).refine(value => value.trim() === value);
const clientVersion = z.string().regex(/^[A-Za-z0-9._+-]{1,32}$/).refine(value => value.trim() === value);
const createSchema = z.object({
  keyType: z.enum(["secp256k1", "ed25519"]), address: z.string().optional(), publicKey: z.string().optional(),
  role: z.enum(["agent", "device", "owner"]), label, chainId: z.number().int(),
  clientInfo: z.object({ name: clientName, version: clientVersion }).strict().optional(),
  kernelId: z.string().refine(isValidKernelId).optional(),
}).strict();
const proofSchema = z.object({ signature: z.string().min(1).max(256) }).strict();
const lookupSchema = z.object({ userCode: z.string().min(1).max(64) }).strict();
const approveSchema = z.object({ userCode: z.string().min(1).max(64), decision: z.enum(["approve", "deny"]),
  consentSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).refine(value => value.trim() === value) }).strict();
const revokeSchema = z.object({ reason: z.string().regex(/^[a-z_]{1,32}$/).refine(value => value.trim() === value).optional() }).strict();

// Fastify's default AJV strips additional properties; this route-local compiler
// preserves the input and uses strict validation so unknown members are refused.
function bodyOptions(schema: z.ZodTypeAny, properties: Record<string, unknown>, required: string[] = []) {
  return {
    schema: { body: { type: "object", additionalProperties: false, properties, required } },
    validatorCompiler: () => (data: unknown) => {
      const result = schema.safeParse(data);
      return result.success ? { value: result.data } : { error: new Error("invalid_request") };
    },
  };
}

export function accountPrincipal(req: FastifyRequest): string {
  const accountId = req.operatorId ?? req.userId;
  if (!accountId) throw new WalletLinkError(401, "api_key_required");
  return accountId;
}

/** Only the SIWE login flow can mint this metadata marker; public keys claim accounts. */
export function siweProvenAddress(req: FastifyRequest): string | null {
  if (!req.apiKeyId) return resolveSession(req)?.address ?? null;
  const key = getRepos().apiKeys.findById(req.apiKeyId);
  if (!key) return null;
  let metadata;
  try { metadata = JSON.parse(key.metadata ?? "{}"); } catch { return null; }
  if (metadata?.source !== "siwe-session" || typeof metadata.sessionId !== "string") return null;
  // Session rows last at least as long as their keys and logout revokes those
  // keys. Cross-check the minting session rather than trusting a marker alone.
  const session = getStore().db.get<{ wallet_address: string; expires_at: string }>(sql`
    SELECT wallet_address, expires_at FROM sessions WHERE id = ${metadata.sessionId}`);
  return session && Date.parse(session.expires_at) > Date.now() &&
    session.wallet_address.toLowerCase() === key.operatorId.toLowerCase() ? key.operatorId : null;
}

function credentialPrincipal(req: FastifyRequest): string {
  if (req.apiKeyId) return `key:${req.apiKeyId}`;
  const session = resolveSession(req);
  if (!session) throw new WalletLinkError(401, "api_key_required");
  return `session:${createHash("sha256").update(session.token).digest("hex")}`;
}

export function checkApprovalOrigin(req: FastifyRequest, origin: string) {
  if (req.apiKeyId || !req.cookies?.pcc_session) return;
  const cookieRequest = Object.create(req) as FastifyRequest;
  cookieRequest.headers = { ...req.headers, authorization: undefined };
  const session = resolveSession(cookieRequest);
  if (session && session.address === req.userId && req.headers.origin !== origin) {
    throw new WalletLinkError(403, "origin_mismatch");
  }
}

export async function walletsRoutes(app: FastifyInstance) {
  const limits = walletRequestLimits();
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof WalletLinkError) return reply.code(error.status).send({ error: error.code });
    if (error.validation || (error.statusCode && error.statusCode < 500)) return reply.code(400).send({ error: "invalid_request" });
    // No exception or request values cross the wallet ceremony's error boundary.
    return reply.code(500).send({ error: "internal_error" });
  });

  app.post("/api/wallets/link-requests", bodyOptions(createSchema, {
    keyType: { enum: ["secp256k1", "ed25519"] }, address: { type: "string" }, publicKey: { type: "string" },
    role: { enum: ["agent", "device", "owner"] }, label: { type: "string", pattern: "^[A-Za-z0-9._@-]{1,64}$" },
    chainId: { type: "integer" }, clientInfo: { type: "object", additionalProperties: false,
      properties: { name: { type: "string", pattern: "^[A-Za-z0-9._-]{1,32}$" }, version: { type: "string", pattern: "^[A-Za-z0-9._+-]{1,32}$" } }, required: ["name", "version"] },
    kernelId: { type: "string" },
  }, ["keyType", "role", "label", "chainId"]), async (req, reply) => {
    const input = createSchema.parse(req.body);
    if (input.role === "owner") throw new WalletLinkError(400, "unsupported_role");
    const config = walletLinkConfig();
    if (!config.allowedChainIds.includes(input.chainId)) throw new WalletLinkError(400, "unsupported_chain");
    if (input.role !== "device" && input.kernelId !== undefined) throw new WalletLinkError(400, "invalid_request");
    let identity: string;
    if (input.keyType === "secp256k1") {
      if (input.publicKey !== undefined || !input.address || !isAddress(input.address)) throw new WalletLinkError(400, "invalid_request");
      identity = getAddress(input.address);
    } else {
      if (input.address !== undefined || !input.publicKey || !/^[a-fA-F0-9]{64}$/.test(input.publicKey) || input.publicKey.length !== 64) throw new WalletLinkError(400, "invalid_request");
      identity = input.publicKey.toLowerCase();
    }
    const now = Date.now();
    limits.create(req.ip, now);
    const row = createLinkRequest({ ...input, identity, role: input.role }, requesterIpClass(req.ip), config, now, req.apiKeyId ?? null);
    return reply.code(201).send({ requestId: row.id, userCode: displayUserCode(row.user_code),
      verificationUri: config.uri, message: row.message, expiresAt: row.expires_at, interval: 5 });
  });

  app.post<{ Params: { id: string } }>("/api/wallets/link-requests/:id/proof", bodyOptions(proofSchema, {
    signature: { type: "string" },
  }, ["signature"]), async (req, reply) => {
    const { signature } = proofSchema.parse(req.body);
    const now = Date.now();
    const row = claimLinkProof(req.params.id, now);
    let valid = false;
    try { valid = await verifyProofMessage(row, signature, walletLinkConfig(), now); } catch { /* Burn on any verification failure. */ }
    finishLinkProof(row, signature, valid);
    if (!valid) return reply.code(401).send({ error: "invalid_proof" });
    return { status: "awaiting_approval" };
  });

  app.get<{ Params: { id: string } }>("/api/wallets/link-requests/:id", async req => {
    const row = getLinkRequest(req.params.id);
    if (!row) throw new WalletLinkError(404, "not_found");
    const now = Date.now();
    if (row.status === "approved") return { status: "approved", linkId: row.link_id };
    if (row.status === "denied" || row.status === "failed") return { status: row.status };
    if (Date.parse(row.expires_at) <= now || row.status === "expired") return { status: "expired" };
    if (limits.poll(row.id, row.expires_at, now)) return { status: "slow_down" };
    return { status: "authorization_pending" };
  });

  app.post("/api/wallets/link-requests/lookup", {
    ...bodyOptions(lookupSchema, { userCode: { type: "string" } }, ["userCode"]), onRequest: requireAuth,
  }, async req => {
    const accountId = accountPrincipal(req);
    const credential = credentialPrincipal(req);
    const now = Date.now();
    limits.checkCodes(credential, now);
    const row = lookupLinkRequestByCode(lookupSchema.parse(req.body).userCode, now);
    if (!row) { limits.wrongCode(credential, now); throw new WalletLinkError(404, "not_found"); }
    return { requestId: row.id, role: row.role, keyType: row.key_type,
      ...(row.key_type === "secp256k1" ? { address: row.address_or_pubkey } : { publicKey: row.address_or_pubkey }),
      label: row.label, clientInfo: row.client_info ? JSON.parse(row.client_info) : null, chainId: row.chain_id,
      network: NETWORK_NAME, requestedAt: row.created_at, requesterIpClass: row.requester_ip_class,
      ...(row.kernel_id ? { kernelId: row.kernel_id } : {}),
      consent: { version: CONSENT_VERSION, sha256: CONSENT_SHA256, text: renderConsent(row, accountId) },
    };
  });

  app.post<{ Params: { id: string } }>("/api/wallets/link-requests/:id/approve", {
    ...bodyOptions(approveSchema, { userCode: { type: "string" }, decision: { enum: ["approve", "deny"] }, consentSha256: { type: "string" } }, ["userCode", "decision", "consentSha256"]),
    onRequest: requireAuth,
  }, async req => {
    const accountId = accountPrincipal(req);
    const credential = credentialPrincipal(req);
    const config = walletLinkConfig();
    checkApprovalOrigin(req, config.publicOrigin);
    const input = approveSchema.parse(req.body);
    const now = Date.now();
    limits.checkCodes(credential, now);
    const row = getLinkRequest(req.params.id);
    if (!row) throw new WalletLinkError(404, "not_found");
    if (!userCodesEqual(input.userCode, row.user_code)) {
      limits.wrongCode(credential, now); throw new WalletLinkError(403, "code_mismatch");
    }
    if (input.consentSha256.toLowerCase() !== CONSENT_SHA256 || row.consent_sha256.toLowerCase() !== CONSENT_SHA256 || row.consent_version !== CONSENT_VERSION) {
      throw new WalletLinkError(409, "consent_changed");
    }
    if (Date.parse(row.expires_at) <= now) throw new WalletLinkError(410, "expired");
    if (row.status !== "awaiting_approval") throw new WalletLinkError(409, "already_decided");
    return decideLinkRequest(row.id, accountId, input.decision, now, req.apiKeyId ?? null, siweProvenAddress(req) ? "siwe" : "claimed");
  });

  app.get("/api/wallets", { onRequest: requireAuth }, async req => ({ links: listWalletLinks(accountPrincipal(req), Date.now(), req.apiKeyId ?? null, siweProvenAddress(req)) }));

  app.post<{ Params: { linkId: string } }>("/api/wallets/:linkId/revoke", {
    ...bodyOptions(revokeSchema, { reason: { type: "string", pattern: "^[a-z_]{1,32}$" } }), onRequest: requireAuth,
    preValidation: async req => {
      if (req.body == null && req.headers["transfer-encoding"] === undefined && Number(req.headers["content-length"] ?? 0) === 0) req.body = {};
    },
  }, async req => {
    checkApprovalOrigin(req, walletLinkConfig().publicOrigin);
    return revokeWalletLink(req.params.linkId, accountPrincipal(req), revokeSchema.parse(req.body).reason, Date.now(), req.apiKeyId ?? null, siweProvenAddress(req));
  });
}
