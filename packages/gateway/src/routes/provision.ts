/**
 * API Key provisioning routes.
 *
 * POST /api/auth/provision  — create a new API key (public — this is how operators register)
 * GET  /api/auth/keys       — list your active keys (requires auth)
 * DELETE /api/auth/keys/:id — revoke a key (requires auth)
 */

import type { FastifyInstance } from "fastify";
import { createCipheriv, randomBytes } from "node:crypto";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { getRepos } from "../db.js";
import { auditService } from "../services/audit-service.js";
import { trackServerEvent } from "../services/posthog-service.js";
import { canProvision } from "../middleware/security-hardening.js";
import {
  registerAgentOnChain,
  isIdentityWriteEnabled,
  getIdentityRegistryAddress,
  generateOperatorWallet,
  setAgentWalletOnChain,
} from "../services/erc8004-identity-write.js";

// ── H-12 containment: envelope-encrypt the custodial operator EOA key ─────────
// The operator's operational wallet private key must NEVER be returned in an
// HTTP response NOR persisted in plaintext. We envelope-encrypt it at rest with
// AES-256-GCM under a Key-Encryption-Key (KEK) sourced from the environment.
// The stored value is a self-describing string
// `enc:v2:<ivHex>:<tagHex>:<ctHex>` (iv + auth tag + ciphertext). The GCM cipher
// is bound with Additional Authenticated Data (AAD) derived from the wallet
// address (review #5): a ciphertext cannot be lifted from one db row and
// replayed into another, because decrypting under a different row's AAD fails
// the GCM tag check. The existing `operator_wallet_private_key` text column
// needs no schema/type change — only a semantic one (see packages/db/src/
// schema/auth.ts).
//
// KEK STRENGTH (review #5): the KEK MUST be exactly 32 random bytes, supplied as
// base64 or hex. A short/weak passphrase like "password" is REJECTED — we do
// NOT silently SHA-256 an arbitrary passphrase into a key (that launders low
// entropy into a legitimate-looking 32-byte key and hides the weakness). "Unset"
// and "set-but-invalid" are distinct states:
//   • unset            → encryption unavailable; caller creates NO wallet (fail
//                        closed) — see the orphaned-wallet guard below.
//   • set-but-invalid  → operator misconfiguration; `resolveKeyEncryptionKey`
//                        THROWS, and the startup guard in `provisionRoutes`
//                        fails the boot LOUDLY rather than degrade silently.
//
// ORPHANED-WALLET SAFETY (review #4 — round-1 made this worse): if encryption is
// unavailable we must NOT create a custodial wallet at all. Generating an EOA,
// assigning it on-chain, then dropping its only private key (because there is no
// envelope to store) yields an UNRECOVERABLE on-chain wallet. The provision
// handler therefore checks availability BEFORE generating/assigning a wallet and
// only ever assigns on-chain when it already holds a storable envelope.
//
// VERSION / MIGRATION: new writes are `enc:v2:` (AAD-bound). Any legacy
// `enc:v1:` blob (no AAD) predates this change; a future decrypt-on-use path
// MUST branch on the version prefix — v1 decrypts WITHOUT AAD, v2 decrypts WITH
// the wallet-address AAD (see `walletKeyAad`). No decrypt path exists yet (keys
// are used only in-memory at provision time), so there is nothing to keep
// back-compatible in code today; the branch is a Wave-3 requirement.
//
// TODO(audit P0 follow-up, Wave 3): move custody to a non-exportable KMS/HSM
// (envelope key wrapping via cloud KMS); rotate/re-encrypt every previously
// written operator key (any legacy plaintext OR `enc:v1` row → `enc:v2`); and
// add the governed, version-aware decrypt-on-use path described above.
const KEK_ENV_VAR = "PCC_KEY_ENCRYPTION_KEK";
const ENC_VERSION = "v2";

/**
 * Decode + validate the raw KEK env value into exactly 32 key bytes.
 * Accepts 64 hex chars (optional `0x`) OR base64/base64url that decodes to
 * exactly 32 bytes. Throws with an actionable message on anything else —
 * notably a passphrase, which is NOT hashed into a key.
 */
function decodeKek(raw: string): Buffer {
  const hex = raw.replace(/^0x/i, "");
  if (hex.length === 64 && /^[0-9a-fA-F]{64}$/.test(hex)) {
    return Buffer.from(hex, "hex");
  }
  // base64 / base64url — decode then assert exactly 32 bytes. Buffer.from is
  // lenient (it won't throw on junk), so the length assertion is the real gate.
  if (/^[A-Za-z0-9+/\-_]+={0,2}$/.test(raw)) {
    const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
    const buf = Buffer.from(normalized, "base64");
    if (buf.length === 32) return buf;
  }
  throw new Error(
    `${KEK_ENV_VAR} must be exactly 32 random bytes, encoded as base64 ` +
      "(`openssl rand -base64 32`) or hex (`openssl rand -hex 32`). The provided " +
      "value does not decode to 32 bytes; a weak passphrase is rejected — it is " +
      "NOT hashed into a key.",
  );
}

/**
 * Resolve the KEK:
 *   - unset / blank        → null   (encryption unavailable; fail closed)
 *   - set but not 32 bytes → throws (loud misconfiguration)
 *   - set + valid          → 32-byte Buffer
 */
function resolveKeyEncryptionKey(): Buffer | null {
  const raw = process.env[KEK_ENV_VAR];
  if (raw === undefined || raw.trim().length === 0) return null;
  return decodeKek(raw.trim());
}

/**
 * Non-throwing probe for the startup guard: returns an error message when the
 * KEK is SET but invalid, else null (covers both "valid" and cleanly "unset").
 */
function keyEncryptionConfigError(): string | null {
  try {
    resolveKeyEncryptionKey();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** True only when a valid 32-byte KEK is configured (never throws). */
function isKeyEncryptionAvailable(): boolean {
  try {
    return resolveKeyEncryptionKey() !== null;
  } catch {
    return false;
  }
}

/**
 * AAD binding the ciphertext to the wallet it controls. MUST be reconstructed
 * identically at decrypt time from the row's `operator_wallet_address`
 * (lower-cased). Binding to the address means an envelope cannot be swapped
 * between db rows without failing the GCM tag check.
 */
function walletKeyAad(walletAddress: string): Buffer {
  return Buffer.from(`pcc:operator-wallet:${walletAddress.toLowerCase()}`, "utf8");
}

/**
 * Envelope-encrypt a secret for storage at rest, bound by AAD to `aadIdentity`
 * (the wallet address). Returns `enc:v2:<ivHex>:<tagHex>:<ciphertextHex>`, or
 * `null` when no valid KEK is set (fail closed — the caller must persist null,
 * never the plaintext, and must NOT create a custodial wallet it cannot store;
 * see the orphaned-wallet guard in the handler).
 */
function encryptSecretAtRest(plaintext: string, aadIdentity: string): string | null {
  const kek = resolveKeyEncryptionKey();
  if (!kek) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", kek, iv);
  cipher.setAAD(walletKeyAad(aadIdentity));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${ENC_VERSION}:${iv.toString("hex")}:${tag.toString("hex")}:${ciphertext.toString("hex")}`;
}

export async function provisionRoutes(app: FastifyInstance) {
  // ── Startup guard (orphaned-wallet + KEK strength, reviews #4/#5) ──────────
  // If this gateway will create custodial operator wallets (identity write is
  // enabled), the KEK must be valid, or we would generate keys we cannot store.
  // A KEK that is SET but malformed (wrong length / a passphrase) is an operator
  // misconfiguration — fail LOUDLY at boot rather than silently degrade or (the
  // round-1 bug) orphan wallets. A cleanly UNSET KEK is tolerated here: provision
  // still issues API keys, just WITHOUT a custodial wallet (request-time guard
  // below), so the public endpoint keeps working.
  if (isIdentityWriteEnabled()) {
    const kekError = keyEncryptionConfigError();
    if (kekError) {
      throw new Error(
        `[provision] Custodial operator wallets are enabled (ERC-8004 identity ` +
          `write is on) but the key-encryption key is invalid: ${kekError} ` +
          `Fix ${KEK_ENV_VAR}, or disable identity write, before starting the gateway.`,
      );
    }
  }

  // ── POST /api/auth/provision ──────────────────────────────────────
  // Public endpoint — this is how new operators get their API key.
  // They provide email + capability description, we issue a key.
  app.post("/api/auth/provision", async (req, reply) => {
    // Rate limit: max 5 provisions per IP per hour (CRIT-02 fix)
    if (!canProvision(req.ip)) {
      return reply.status(429).send({
        error: "rate_limited",
        message: "Too many API key requests. Try again in an hour.",
        retry_after_seconds: 3600,
      });
    }

    const body = (req.body ?? {}) as {
      email?: string;
      walletAddress?: string;
      name?: string;
      capability?: string;
      /**
       * Optional Ed25519 public key (BYOK). 64 hex chars, optional 0x prefix.
       * Omitted → gateway mints a fresh keypair and returns the private
       * key in this response ONCE.
       */
      publicKey?: string;
    };

    let operatorId: string;

    // Type guards — prevent object/array/number injection (red team #14, #15)
    if (body.walletAddress !== undefined && typeof body.walletAddress !== "string") {
      return reply.status(400).send({ error: "invalid_type", message: "walletAddress must be a string" });
    }
    if (body.email !== undefined && typeof body.email !== "string") {
      return reply.status(400).send({ error: "invalid_type", message: "email must be a string" });
    }
    if (body.name !== undefined && typeof body.name !== "string") {
      return reply.status(400).send({ error: "invalid_type", message: "name must be a string" });
    }
    if (body.capability !== undefined && typeof body.capability !== "string") {
      return reply.status(400).send({ error: "invalid_type", message: "capability must be a string" });
    }
    if (body.publicKey !== undefined && typeof body.publicKey !== "string") {
      return reply.status(400).send({ error: "invalid_type", message: "publicKey must be a string" });
    }

    if (body.walletAddress) {
      // Wallet address path — format check also implicitly caps length at 42
      if (!/^0x[0-9a-fA-F]{40}$/.test(body.walletAddress)) {
        return reply.status(400).send({
          error: "invalid_wallet_address",
          message: "walletAddress must be a valid EVM address (0x + 40 hex chars)",
        });
      }
      operatorId = body.walletAddress;
    } else if (body.email) {
      // Email path — RFC 5321 max total length is 254
      if (body.email.length > 254) {
        return reply.status(400).send({
          error: "invalid_email",
          message: "Email exceeds 254 character limit",
        });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
        return reply.status(400).send({
          error: "invalid_email",
          message: "Please provide a valid email address",
        });
      }
      operatorId = body.email;
    } else {
      return reply.status(400).send({
        error: "identifier_required",
        message: "Either email or walletAddress is required to provision an API key",
      });
    }

    try {
      const { rawKey, record, ed25519 } = provisionApiKey({
        operatorId,
        name: body.name,
        description: body.capability
          ? `Operator capability: ${body.capability}`
          : undefined,
        // C-01 containment: this endpoint is PUBLIC + unauthenticated, so the
        // caller is unverified. Never mint a wildcard/global key here. Issue an
        // EMPTY (least-privilege / no-scope) grant — the key authenticates the
        // caller but grants no privileged scope. scope-checker fails closed, so
        // this key is denied on every scoped/unmatched route until the operator
        // earns scopes through a verified path.
        // TODO(audit P0 follow-up, Wave 1): grant real scopes only via verified/
        // invite onboarding (identity-checked). Until then a self-provisioned
        // key is intentionally unprivileged.
        scopes: [],
        metadata: {
          capability: body.capability,
          provisionedAt: new Date().toISOString(),
          source: "landing-page",
        },
        publicKey: body.publicKey,
      });

      if (!record) return reply.status(500).send({ error: "provision_failed" });
      auditService.log({
        eventType: "auth.key_provisioned",
        actor: operatorId,
        resourceType: "api_key",
        resourceId: record.id,
        action: "create",
        metadata: {
          name: body.name,
          capability: body.capability,
          ed25519_keypair_source: ed25519 ? "server-minted" : "byok",
        },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });
      trackServerEvent("api_key_provisioned", {
        email: body.email,
        capability: body.capability,
        ed25519_keypair_source: ed25519 ? "server-minted" : "byok",
      });
      // Surface the trace_id (stamped by `middleware/trace-id.ts`) so the
      // agent can echo it on every subsequent call via `x-pcc-trace-id`.
      // The trace-id middleware also sets it on the response header — the
      // body field is here for clients that read JSON bodies more easily
      // than headers.
      // See docs/AGENT_ONBOARDING_OBSERVABILITY.md.
      const trace_id = (req as unknown as { traceId?: string }).traceId;
      // Ed25519 surfacing: ALWAYS return the public key; return the private
      // key ONLY when the gateway minted it. BYOK keys never round-trip.
      const ed25519Response = ed25519
        ? {
            public_key: ed25519.publicKeyHex,
            private_key: ed25519.privateKeyHex,
            private_key_pkcs8_base64: ed25519.privateKeyPkcs8B64,
            source: "server-minted",
            warning:
              "Store the private_key now — it will not be shown again. Anyone holding it can sign as this agent.",
          }
        : {
            public_key: record.publicKey ?? null,
            source: "byok",
          };

      // ── ERC-8004 on-chain identity write (best-effort) ────────────
      // The off-chain DB row is the source of truth at this moment; the
      // on-chain identity is eventually-consistent. If this write fails
      // (network, gas, RPC), the row stays onchain_status='pending' and
      // the retry sweeper will pick it up. Never fail the HTTP request.
      let onchainAttempted = false;
      let onchainResult:
        | { agentId: string; txHash: string; registryAddress: string; chainId: number }
        | undefined;
      // Option A operator wallet response (populated inside the mint branch).
      // H-12 containment: the private key is NEVER included here. The wallet is
      // gateway-custodied and the key is encrypted at rest; only the public
      // address is surfaced.
      let operatorWalletResponse:
        | {
            address: string;
            source: "server-minted";
            custody: "gateway";
            warning: string;
            onchain_status?: "written" | "failed" | "pending";
            onchain_tx_hash?: string;
            onchain_error?: string;
          }
        | {
            // Orphaned-wallet fix (review #4): explicit "no custodial wallet was
            // created" state. Returned when encryption at rest is unavailable, so
            // we refuse to generate/assign a key we cannot store. The API key is
            // still provisioned — it simply has no wallet.
            source: "none";
            custody: "none";
            reason: "wallet_not_created";
            message: string;
          }
        | undefined;
      if (isIdentityWriteEnabled()) {
        onchainAttempted = true;
        const gatewayUrl =
          process.env.PCC_GATEWAY_URL ?? `${req.protocol}://${req.hostname}`;
        const agentDid =
          operatorId.startsWith("0x") && /^0x[0-9a-fA-F]{40}$/.test(operatorId)
            ? `did:pcc:${operatorId.toLowerCase()}`
            : `did:pcc:${record.id}`;
        try {
          const onchain = await registerAgentOnChain({
            agentDid,
            agentUrl: gatewayUrl,
          });
          getRepos().apiKeys.recordOnchainSuccess(record.id, {
            agentId: onchain.agentId,
            txHash: onchain.txHash,
            registryAddress: onchain.registryAddress,
            chainId: onchain.chainId,
          });
          onchainResult = {
            agentId: String(onchain.agentId),
            txHash: onchain.txHash,
            registryAddress: onchain.registryAddress,
            chainId: onchain.chainId,
          };
          auditService.log({
            eventType: "auth.onchain_identity_written",
            actor: operatorId,
            resourceType: "api_key",
            resourceId: record.id,
            action: "create",
            metadata: onchainResult,
            ip: req.ip,
            userAgent: req.headers["user-agent"],
          });

          // ── Option A: per-operator operational wallet + setAgentWallet ──
          // Generate a fresh EOA for THIS operator (gateway-custodied at
          // bootstrap), then best-effort assign it as the on-chain
          // agentWallet. Entire block is defensively wrapped so any failure
          // (viem import, EIP-712 domain mismatch vs deployed Daydreams
          // contract, RPC blip) NEVER leaks into the outer catch and reverts
          // the sponsored-mint success record.
          try {
            // ── Orphaned-wallet guard (review #4) ──────────────────────────
            // NEVER create a custodial wallet we cannot encrypt at rest.
            // Generating an EOA, assigning it on-chain, then dropping its only
            // private key (no envelope to store) yields an UNRECOVERABLE
            // on-chain wallet — the exact failure round-1 introduced. So we
            // generate the key ONLY when encryption is available, and we assign
            // on-chain / persist ONLY when we already hold a real envelope.
            // Otherwise we create NO wallet and report an explicit
            // wallet_not_created / custody:"none" state (the API key was still
            // provisioned above — it simply has no wallet).
            const canEncryptAtRest = isKeyEncryptionAvailable();
            const opWallet = canEncryptAtRest
              ? await generateOperatorWallet()
              : null;
            // H-12: encrypt the key BEFORE any on-chain assignment, bound by AAD
            // to this wallet address (so a ciphertext can't be swapped between
            // db rows). The plaintext key is used in-memory ONLY to sign the
            // setAgentWallet tx below, then dropped when the request ends — it
            // is never returned or logged.
            const operatorKeyEnvelope = opWallet
              ? encryptSecretAtRest(opWallet.privateKey, opWallet.address)
              : null;

            if (!opWallet || !operatorKeyEnvelope) {
              // No storable envelope → do NOT generate/assign/persist a wallet.
              operatorWalletResponse = {
                source: "none",
                custody: "none",
                reason: "wallet_not_created",
                message: canEncryptAtRest
                  ? "Operator wallet was not created: its private key could not be " +
                    "encrypted for storage, so no key was assigned on-chain."
                  : "Operator wallet was not created: no key-encryption key " +
                    "(PCC_KEY_ENCRYPTION_KEK) is configured, so the gateway will not " +
                    "custody a wallet whose private key it cannot store encrypted. " +
                    "Configure a 32-byte KEK to enable custodial wallets.",
              };
              req.log?.warn(
                { keyId: record.id, canEncryptAtRest },
                "operator wallet skipped — refusing to create an unrecoverable custodial wallet (no storable envelope)",
              );
            } else {
              operatorWalletResponse = {
                address: opWallet.address,
                source: "server-minted",
                custody: "gateway",
                warning:
                  "This operational wallet is custodied by the gateway. Its private " +
                  "key is encrypted at rest and is never returned by the API. A future " +
                  "export flow will let you take custody (see coord bulletin 235).",
              };
              try {
                const walletResult = await setAgentWalletOnChain({
                  agentId: onchain.agentId,
                  newWallet: opWallet.address,
                  newWalletPrivateKey: opWallet.privateKey,
                });
                getRepos().apiKeys.recordOperatorWallet(record.id, {
                  address: opWallet.address,
                  privateKeyEnvelope: operatorKeyEnvelope,
                  onchainStatus: "written",
                  onchainTxHash: walletResult.txHash,
                  onchainError: null,
                });
                operatorWalletResponse.onchain_status = "written";
                operatorWalletResponse.onchain_tx_hash = walletResult.txHash;
                auditService.log({
                  eventType: "auth.agent_wallet_written",
                  actor: operatorId,
                  resourceType: "api_key",
                  resourceId: record.id,
                  action: "update",
                  metadata: {
                    agent_wallet: opWallet.address,
                    tx_hash: walletResult.txHash,
                    agent_id: String(onchain.agentId),
                  },
                  ip: req.ip,
                  userAgent: req.headers["user-agent"],
                });
              } catch (walletErr) {
                const walletErrMsg =
                  walletErr instanceof Error ? walletErr.message : String(walletErr);
                try {
                  getRepos().apiKeys.recordOperatorWallet(record.id, {
                    address: opWallet.address,
                    privateKeyEnvelope: operatorKeyEnvelope,
                    onchainStatus: "failed",
                    onchainTxHash: null,
                    onchainError: walletErrMsg.slice(0, 1024),
                  });
                } catch {
                  // Non-fatal.
                }
                operatorWalletResponse.onchain_status = "failed";
                operatorWalletResponse.onchain_error = walletErrMsg.slice(0, 256);
                req.log?.warn(
                  { keyId: record.id, error: walletErrMsg },
                  "setAgentWallet best-effort failed — off-chain wallet preserved (key encrypted at rest)",
                );
              }
            }
          } catch (opWalletErr) {
            // generateOperatorWallet failed (e.g. viem import glitch in a
            // test env). Do NOT let this leak into the outer catch and
            // revert the sponsored-mint success record. Off-chain identity
            // continues to work; operator wallet is a future retry.
            req.log?.warn(
              { keyId: record.id, err: opWalletErr instanceof Error ? opWalletErr.message : String(opWalletErr) },
              "operator wallet generation failed — sponsored mint still succeeded",
            );
          }
        } catch (onchainErr) {
          const errMsg =
            onchainErr instanceof Error ? onchainErr.message : String(onchainErr);
          try {
            getRepos().apiKeys.recordOnchainFailure(record.id, errMsg);
          } catch {
            // Non-fatal: DB write failure doesn't block HTTP response
          }
          req.log?.warn(
            { keyId: record.id, error: errMsg },
            "ERC-8004 on-chain identity write failed — will retry",
          );
          auditService.log({
            eventType: "auth.onchain_identity_failed",
            actor: operatorId,
            resourceType: "api_key",
            resourceId: record.id,
            action: "create",
            metadata: { error: errMsg.slice(0, 256) },
            ip: req.ip,
            userAgent: req.headers["user-agent"],
          });
        }
      }

      return reply.status(201).send({
        api_key: rawKey,
        key_id: record.id,
        operator_id: operatorId,
        scopes: JSON.parse(record.scopes),
        rate_limit: record.rateLimit,
        expires_at: record.expiresAt,
        created_at: record.createdAt,
        warning: "Save this API key now — it will not be shown again.",
        trace_id,
        ed25519: ed25519Response,
        // Option A ownership stopgap: operator's operational wallet address
        // (independently claimable EOA that will be set as the ERC-8004
        // `agentWallet` on-chain via best-effort setAgentWallet). If the
        // on-chain assignment fails, the off-chain wallet is still yours.
        // See coord bulletin 235 for the migration path to full smart-wallet
        // ownership (B).
        operator_wallet: operatorWalletResponse ?? { source: "none" },
        usage: {
          header: `Authorization: Bearer ${rawKey}`,
          trace_header: `x-pcc-trace-id: ${trace_id ?? "<trace_id>"}`,
          example: `curl -H "Authorization: Bearer ${rawKey}" -H "x-pcc-trace-id: ${trace_id ?? "<trace_id>"}" ${req.protocol}://${req.hostname}/api/capabilities/types`,
          trace_hint:
            "Echo `x-pcc-trace-id` on every subsequent request so PCC can correlate your onboarding journey. Quote it when filing `pcc_report` feedback.",
        },
        onchain: onchainAttempted
          ? onchainResult
            ? { status: "written", ...onchainResult }
            : { status: "pending", registryAddress: getIdentityRegistryAddress() }
          : { status: "disabled" },
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to provision key";
      if (message.includes("Maximum 5")) {
        return reply.status(429).send({ error: "too_many_keys", message });
      }
      if (
        err instanceof Error &&
        (err as Error & { code?: string }).code === "invalid_public_key"
      ) {
        return reply.status(400).send({ error: "invalid_public_key", message });
      }
      return reply.status(500).send({ error: "provision_failed", message });
    }
  });

  // ── GET /api/auth/validate ────────────────────────────────────────
  // Validate an API key — returns 200 if valid, 401 if not.
  // Used by the dashboard login screen.
  app.get("/api/auth/validate", async (req, reply) => {
    const { resolveApiKey } = await import("../auth/api-key-auth.js");
    const keyRecord = resolveApiKey(req);
    if (!keyRecord) {
      return reply.status(401).send({ error: "invalid_key" });
    }
    return { valid: true, operatorId: keyRecord.operatorId };
  });

  // ── POST /api/agents/:id/verify ────────────────────────────────────
  //
  // Verify that a signature was produced by the agent identified by `:id`.
  // The agent's public key was set at provision time (server-minted OR
  // BYOK). Body: { message: string, signature: string }. Returns
  // { valid: bool, keyId, operatorId } on success. Returns 404 when the
  // key doesn't exist or has no public_key on file (e.g. legacy rows).
  //
  // PUBLIC: signature verification by definition needs no auth — anyone
  // can verify a signed evidence bundle against the issuing agent's key.
  //
  // Wire format: the message is interpreted as UTF-8 by default. Callers
  // can opt into base64 by passing { message_base64: "..." } instead.
  app.post<{
    Params: { id: string };
    Body: {
      message?: string;
      message_base64?: string;
      signature?: string;
    };
  }>("/api/agents/:id/verify", async (req, reply) => {
    const { id } = req.params;
    const body = req.body ?? {};

    if (typeof body.signature !== "string" || body.signature.length === 0) {
      return reply.status(400).send({
        error: "invalid_body",
        message: "signature (hex string) is required",
      });
    }
    if (
      (body.message === undefined || typeof body.message !== "string") &&
      (body.message_base64 === undefined || typeof body.message_base64 !== "string")
    ) {
      return reply.status(400).send({
        error: "invalid_body",
        message: "Provide either message (utf-8) or message_base64",
      });
    }

    let messageBuffer: Buffer;
    if (typeof body.message === "string") {
      messageBuffer = Buffer.from(body.message, "utf-8");
    } else {
      try {
        messageBuffer = Buffer.from(body.message_base64 as string, "base64");
      } catch {
        return reply.status(400).send({
          error: "invalid_body",
          message: "message_base64 must be valid base64",
        });
      }
    }

    const repo = getRepos().apiKeys;
    const key = repo.findById(id);
    // Unify "not found" + "no public key" + "revoked" so the verify
    // endpoint never leaks key existence.
    if (!key || !key.publicKey || key.revokedAt) {
      return reply.status(404).send({
        error: "key_not_found",
        message:
          "No verifiable public key on file for this agent. Re-provision with publicKey or as server-minted.",
      });
    }

    const { verifyEd25519Signature } = await import("../auth/ed25519.js");
    const valid = verifyEd25519Signature(key.publicKey, messageBuffer, body.signature);

    return reply.status(200).send({
      valid,
      key_id: key.id,
      operator_id: key.operatorId,
    });
  });

  // ── GET /api/auth/keys ────────────────────────────────────────────
  // List active keys for the authenticated operator.
  // Requires existing API key or SIWE session.
  app.get("/api/auth/keys", async (req, reply) => {
    // Try resolveApiKey directly since this route is before the gate
    const { resolveApiKey } = await import("../auth/api-key-auth.js");
    const keyRecord = resolveApiKey(req);
    const operatorId = keyRecord?.operatorId ?? (req as any).operatorId ?? (req as any).userId;
    if (!operatorId) {
      return reply.status(401).send({ error: "Authentication required" });
    }

    const repo = getRepos().apiKeys;
    const keys = repo.findByOperator(operatorId);

    return reply.send({
      keys: keys.map((k) => ({
        id: k.id,
        prefix: k.keyPrefix,
        name: k.name,
        description: k.description,
        scopes: JSON.parse(k.scopes ?? "[]"),
        rate_limit: k.rateLimit,
        usage_count: parseInt(k.usageCount ?? "0", 10),
        last_used_at: k.lastUsedAt,
        created_at: k.createdAt,
        expires_at: k.expiresAt,
        revoked_at: k.revokedAt,
        active: !k.revokedAt,
      })),
    });
  });

  // ── DELETE /api/auth/keys/:keyId ──────────────────────────────────
  // Revoke an API key. Requires auth + must own the key.
  app.delete("/api/auth/keys/:keyId", async (req, reply) => {
    const operatorId = (req as any).operatorId ?? (req as any).userId;
    if (!operatorId) {
      return reply.status(401).send({ error: "Authentication required" });
    }

    const { keyId } = req.params as { keyId: string };
    const repo = getRepos().apiKeys;
    const key = repo.findById(keyId);

    // Unify 404 and 403 into a single "not found" to prevent key ID enumeration
    // (red team #11/#54: different status codes leak resource existence).
    if (!key || key.operatorId !== operatorId) {
      return reply.status(404).send({ error: "Key not found" });
    }

    if (key.revokedAt) {
      return reply.status(409).send({ error: "Key already revoked" });
    }

    repo.revoke(keyId);
    return reply.send({ ok: true, key_id: keyId, revoked_at: new Date().toISOString() });
  });
}
